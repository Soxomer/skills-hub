import type { DiscoveryKind, SetupComposerItem } from '@ahm/contracts'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

import type {
  CreateSetupOutcome,
  CreateSetupRecord,
  ReadSetupComposerOutcome,
  SetupRepository,
} from './setups.js'

interface ComposerItemRow extends QueryResultRow {
  source_setup_revision_id: string
  source_setup_name: string
  source_revision_number: number | string
  artifact_id: string
  artifact_kind: DiscoveryKind
  artifact_reference: { portableSource?: unknown; contentDigest?: unknown } | string
  tool_id: string
  target_name: string
}

function objectValue(
  value: ComposerItemRow['artifact_reference'],
): Record<string, unknown> {
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value
}

function composerItem(row: ComposerItemRow): SetupComposerItem {
  const reference = objectValue(row.artifact_reference)
  return {
    sourceSetupRevisionId: row.source_setup_revision_id,
    sourceSetupName: row.source_setup_name,
    sourceRevisionNumber: Number(row.source_revision_number),
    artifactId: row.artifact_id,
    artifactKind: row.artifact_kind,
    portableSource:
      typeof reference.portableSource === 'string' ? reference.portableSource : null,
    contentDigest:
      typeof reference.contentDigest === 'string' ? reference.contentDigest : '',
    toolId: row.tool_id,
    targetName: row.target_name,
  }
}

function itemKey(item: {
  sourceSetupRevisionId: string
  artifactId: string
  toolId: string
  targetName: string
}): string {
  return [item.sourceSetupRevisionId, item.artifactId, item.toolId, item.targetName].join('\u0000')
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const COMPOSER_ITEMS = `
  SELECT sr.id AS source_setup_revision_id, s.name AS source_setup_name,
         sr.revision_number AS source_revision_number,
         sri.artifact_id, sri.artifact_kind, sri.artifact_reference,
         sri.tool_id, sri.target_name
  FROM setup_revision_items sri
  JOIN setup_revisions sr
    ON sr.organization_id = sri.organization_id AND sr.id = sri.setup_revision_id
  JOIN setups s
    ON s.organization_id = sr.organization_id AND s.id = sr.setup_id`

export class PostgresSetupRepository implements SetupRepository {
  constructor(private readonly pool: Pool) {}

  async membershipRole(
    organizationId: string,
    userId: string,
  ): Promise<'owner' | 'admin' | 'member' | 'viewer' | null> {
    const result = await this.pool.query<
      QueryResultRow & { role: 'owner' | 'admin' | 'member' | 'viewer' }
    >(
      `SELECT role FROM organization_memberships
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    )
    return result.rows[0]?.role ?? null
  }

  async readComposer(
    organizationId: string,
    userId: string,
  ): Promise<ReadSetupComposerOutcome> {
    return transaction(this.pool, async (client) => {
      const membership = await client.query<QueryResultRow & { role: string }>(
        `SELECT role FROM organization_memberships
         WHERE organization_id = $1 AND user_id = $2
         FOR UPDATE`,
        [organizationId, userId],
      )
      if (!membership.rows[0]) return { outcome: 'accessDenied' }
      const result = await client.query<ComposerItemRow>(
        `${COMPOSER_ITEMS}
         WHERE sri.organization_id = $1
         ORDER BY CASE WHEN s.kind = 'default' THEN 0 ELSE 1 END,
                  sr.created_at, LOWER(s.name), sr.revision_number DESC,
                  sri.tool_id, sri.target_name, sri.artifact_id`,
        [organizationId],
      )
      return { outcome: 'available', items: result.rows.map(composerItem) }
    })
  }

  async createSetup(record: CreateSetupRecord): Promise<CreateSetupOutcome> {
    return transaction(this.pool, async (client) => {
      const membership = await client.query<QueryResultRow & { role: string }>(
        `SELECT role FROM organization_memberships
         WHERE organization_id = $1 AND user_id = $2
         FOR UPDATE`,
        [record.organizationId, record.createdBy],
      )
      const role = membership.rows[0]?.role
      if (!role) return { outcome: 'accessDenied' }
      if (role === 'viewer') return { outcome: 'mutationForbidden' }

      const sourceRevisionIds = [
        ...new Set(record.items.map((item) => item.sourceSetupRevisionId)),
      ]
      const availableResult = await client.query<ComposerItemRow>(
        `${COMPOSER_ITEMS}
         WHERE sri.organization_id = $1
           AND sr.id = ANY($2::text[])`,
        [record.organizationId, sourceRevisionIds],
      )
      const available = new Map(
        availableResult.rows.map((row) => {
          const item = composerItem(row)
          return [itemKey(item), item]
        }),
      )
      const selected = record.items.map((item) => available.get(itemKey(item)))
      if (
        selected.some(
          (item, index) => !item || item.contentDigest !== record.items[index]?.contentDigest,
        )
      ) {
        return { outcome: 'itemUnavailable' }
      }

      const existing = await client.query(
        `SELECT id FROM setups
         WHERE organization_id = $1 AND LOWER(name) = LOWER($2)
         LIMIT 1`,
        [record.organizationId, record.name],
      )
      if (existing.rowCount !== 0) return { outcome: 'nameTaken' }

      const claim = await client.query(
        `INSERT INTO setup_name_claims (organization_id, normalized_name, claimed_at)
         VALUES ($1, LOWER($2), $3)
         ON CONFLICT (organization_id, normalized_name) DO NOTHING
         RETURNING normalized_name`,
        [record.organizationId, record.name, record.createdAt],
      )
      if (claim.rowCount === 0) return { outcome: 'nameTaken' }

      await client.query(
        `INSERT INTO setups
         (id, organization_id, name, kind, default_project_id,
          created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'custom', NULL, $4, $5, $5)`,
        [
          record.setupId,
          record.organizationId,
          record.name,
          record.createdBy,
          record.createdAt,
        ],
      )
      await client.query(
        `INSERT INTO setup_revisions
         (id, organization_id, setup_id, revision_number, created_by, created_at)
         VALUES ($1, $2, $3, 1, $4, $5)`,
        [
          record.setupRevisionId,
          record.organizationId,
          record.setupId,
          record.createdBy,
          record.createdAt,
        ],
      )
      for (const item of selected) {
        await client.query(
          `INSERT INTO setup_revision_items
           (organization_id, setup_revision_id, artifact_id, artifact_kind,
            artifact_reference, tool_id, target_name)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
          [
            record.organizationId,
            record.setupRevisionId,
            item!.artifactId,
            item!.artifactKind,
            JSON.stringify({
              portableSource: item!.portableSource,
              contentDigest: item!.contentDigest,
            }),
            item!.toolId,
            item!.targetName,
          ],
        )
      }
      await client.query(
        `INSERT INTO audit_events
         (id, organization_id, actor_user_id, event_kind, subject_id, details, created_at)
         VALUES ($1, $2, $3, 'setupRevisionCreated', $4, $5::jsonb, $6)`,
        [
          record.auditEventId,
          record.organizationId,
          record.createdBy,
          record.setupRevisionId,
          JSON.stringify({
            setupId: record.setupId,
            name: record.name,
            revisionNumber: 1,
            itemCount: selected.length,
            sourceSetupRevisionIds: sourceRevisionIds,
          }),
          record.createdAt,
        ],
      )
      return {
        outcome: 'created',
        revision: {
          setupId: record.setupId,
          setupRevisionId: record.setupRevisionId,
          name: record.name,
          kind: 'custom',
          revisionNumber: 1,
          itemCount: selected.length,
          createdAt: record.createdAt,
        },
      }
    })
  }
}
