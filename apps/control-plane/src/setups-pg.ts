import type { ArtifactBundle, DiscoveryKind, SetupComposerItem, SetupDetail, SetupLibrarySummary, SetupRevisionDetail } from '@ahm/contracts'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

import type {
  CreateSetupOutcome,
  CreateSetupRecord,
  PublishSetupRevisionRecord,
  PublishSetupRevisionOutcome,
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  )
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

  async listSetups(organizationId: string): Promise<SetupLibrarySummary[]> {
    const [revisions, usage, itemCounts] = await Promise.all([
      this.pool.query<{ setup_id: string; name: string; kind: 'default' | 'custom'; default_project_id: string | null; revision_id: string; revision_number: number | string; created_at: Date | string }>(
        `SELECT sr.setup_id, s.name, s.kind, s.default_project_id, sr.id AS revision_id, sr.revision_number, sr.created_at
         FROM setups s JOIN setup_revisions sr ON sr.organization_id = s.organization_id AND sr.setup_id = s.id
         WHERE s.organization_id = $1
         ORDER BY LOWER(s.name), s.id, sr.revision_number DESC`, [organizationId],
      ),
      this.pool.query<{ setup_id: string; project_count: number | string }>(
        `SELECT sr.setup_id, COUNT(pa.project_id) AS project_count FROM project_assignments pa
         JOIN setup_revisions sr ON sr.organization_id = pa.organization_id AND sr.id = pa.setup_revision_id
         WHERE pa.organization_id = $1 GROUP BY sr.setup_id`, [organizationId],
      ),
      this.pool.query<{ setup_revision_id: string; item_count: number | string }>(
        `SELECT setup_revision_id, COUNT(artifact_id) AS item_count FROM setup_revision_items WHERE organization_id = $1 GROUP BY setup_revision_id`, [organizationId],
      ),
    ])
    const counts = new Map(usage.rows.map((row) => [row.setup_id, Number(row.project_count)]))
    const items = new Map(itemCounts.rows.map((row) => [row.setup_revision_id, Number(row.item_count)]))
    const result = new Map<string, SetupLibrarySummary>()
    for (const row of revisions.rows) {
      if (result.has(row.setup_id)) continue
      result.set(row.setup_id, { setupId: row.setup_id, name: row.name, kind: row.kind, defaultProjectId: row.default_project_id,
        projectCount: counts.get(row.setup_id) ?? 0, latestRevision: { setupId: row.setup_id, setupRevisionId: row.revision_id,
          name: row.name, kind: row.kind, revisionNumber: Number(row.revision_number), itemCount: items.get(row.revision_id) ?? 0, createdAt: new Date(row.created_at).toISOString() } })
    }
    return [...result.values()]
  }

  async setupDetail(organizationId: string, setupId: string): Promise<SetupDetail | null> {
    const setup = await this.pool.query<{ id: string; name: string; kind: 'default' | 'custom'; default_project_id: string | null }>(
      `SELECT id, name, kind, default_project_id FROM setups WHERE organization_id = $1 AND id = $2`, [organizationId, setupId],
    )
    const record = setup.rows[0]
    if (!record) return null
    const [revisions, items, projects] = await Promise.all([
      this.pool.query<{ id: string; revision_number: number | string; created_at: Date | string }>(
        `SELECT id, revision_number, created_at FROM setup_revisions WHERE organization_id = $1 AND setup_id = $2 ORDER BY revision_number DESC`, [organizationId, setupId],
      ),
      this.pool.query<ComposerItemRow>(`${COMPOSER_ITEMS} WHERE sri.organization_id = $1 AND s.id = $2 ORDER BY sri.tool_id, sri.target_name, sri.artifact_id`, [organizationId, setupId]),
      this.pool.query<{ project_id: string; name: string; setup_revision_id: string }>(
        `SELECT p.id AS project_id, p.name, pa.setup_revision_id FROM project_assignments pa
         JOIN projects p ON p.organization_id = pa.organization_id AND p.id = pa.project_id
         JOIN setup_revisions sr ON sr.organization_id = pa.organization_id AND sr.id = pa.setup_revision_id
         WHERE pa.organization_id = $1 AND sr.setup_id = $2 ORDER BY p.name, p.id`, [organizationId, setupId],
      ),
    ])
    if (!revisions.rows.length) return null
    const details = revisions.rows.map((revision): SetupRevisionDetail => {
      const selected = items.rows.filter((item) => item.source_setup_revision_id === revision.id).map(composerItem)
      return { setupId, setupRevisionId: revision.id, name: record.name, kind: record.kind,
        revisionNumber: Number(revision.revision_number), createdAt: new Date(revision.created_at).toISOString(),
        itemCount: selected.length, items: selected }
    })
    return { setupId, name: record.name, kind: record.kind, defaultProjectId: record.default_project_id,
      initialSetupRevisionId: details.at(-1)!.setupRevisionId, revisions: details,
      projects: projects.rows.map((project) => ({ projectId: project.project_id, name: project.name, setupRevisionId: project.setup_revision_id })) }
  }

  async revisionArtifact(organizationId: string, setupId: string, revisionId: string, contentDigest: string): Promise<ArtifactBundle | null> {
    const reference = await this.pool.query<ComposerItemRow>(
      `${COMPOSER_ITEMS} WHERE sri.organization_id = $1 AND s.id = $2 AND sr.id = $3`, [organizationId, setupId, revisionId],
    )
    if (!reference.rows.some((item) => composerItem(item).contentDigest === contentDigest)) return null
    const result = await this.pool.query<{ bundle: ArtifactBundle | string }>(
      `SELECT bundle FROM artifact_bundles WHERE organization_id = $1 AND content_digest = $2`, [organizationId, contentDigest],
    )
    const bundle = result.rows[0]?.bundle
    return typeof bundle === 'string' ? JSON.parse(bundle) as ArtifactBundle : bundle ?? null
  }

  async publishRevision(record: PublishSetupRevisionRecord): Promise<PublishSetupRevisionOutcome> {
    try {
      return await transaction(this.pool, async (client) => {
        // Serialize publishers on the Setup identity; assignments and old revisions never move.
        const setup = await client.query<{ name: string; kind: 'default' | 'custom' }>(
          `SELECT name, kind FROM setups WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [record.organizationId, record.setupId],
        )
        if (!setup.rows[0]) return { outcome: 'setupMissing' }
        const latest = await client.query<{ revision_number: number | string }>(
          `SELECT revision_number FROM setup_revisions WHERE organization_id = $1 AND setup_id = $2 ORDER BY revision_number DESC LIMIT 1`, [record.organizationId, record.setupId],
        )
        if (Number(latest.rows[0]?.revision_number) !== record.expectedRevisionNumber) return { outcome: 'revisionConflict' }
        const sourceRevisionIds = [...new Set(record.items.map((item) => item.sourceSetupRevisionId))]
        const available = await client.query<ComposerItemRow>(
          `${COMPOSER_ITEMS} WHERE sri.organization_id = $1 AND sr.id = ANY($2::text[])`, [record.organizationId, sourceRevisionIds],
        )
        const byKey = new Map(available.rows.map((row) => { const item = composerItem(row); return [itemKey(item), item] }))
        const selected = record.items.map((item) => byKey.get(itemKey(item)))
        if (selected.some((item, index) => !item || item.contentDigest !== record.items[index]?.contentDigest)) return { outcome: 'itemUnavailable' }
        const revisionNumber = record.expectedRevisionNumber + 1
        await client.query(
          `INSERT INTO setup_revisions (id, organization_id, setup_id, revision_number, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [record.setupRevisionId, record.organizationId, record.setupId, revisionNumber, record.createdBy, record.createdAt],
        )
        for (const item of selected) {
          await client.query(
            `INSERT INTO setup_revision_items (organization_id, setup_revision_id, artifact_id, artifact_kind, artifact_reference, tool_id, target_name)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [record.organizationId, record.setupRevisionId, item!.artifactId, item!.artifactKind,
              JSON.stringify({ portableSource: item!.portableSource, contentDigest: item!.contentDigest }), item!.toolId, item!.targetName],
          )
        }
        await client.query(`UPDATE setups SET updated_at = $3 WHERE organization_id = $1 AND id = $2`, [record.organizationId, record.setupId, record.createdAt])
        await client.query(
          `INSERT INTO audit_events (id, organization_id, actor_user_id, event_kind, subject_id, details, created_at)
           VALUES ($1, $2, $3, 'setupRevisionCreated', $4, $5::jsonb, $6)`,
          [record.auditEventId, record.organizationId, record.createdBy, record.setupRevisionId,
            JSON.stringify({ setupId: record.setupId, name: setup.rows[0].name, revisionNumber, itemCount: selected.length, sourceSetupRevisionIds: sourceRevisionIds }), record.createdAt],
        )
        return { outcome: 'created', revision: { setupId: record.setupId, setupRevisionId: record.setupRevisionId,
          name: setup.rows[0].name, kind: setup.rows[0].kind, revisionNumber, itemCount: selected.length, createdAt: record.createdAt } }
      })
    } catch (error) {
      if (isUniqueViolation(error)) return { outcome: 'revisionConflict' }
      throw error
    }
  }

  async listComposerItems(organizationId: string): Promise<SetupComposerItem[]> {
    const result = await this.pool.query<ComposerItemRow>(
      `${COMPOSER_ITEMS}
       WHERE sri.organization_id = $1
       ORDER BY CASE WHEN s.kind = 'default' THEN 0 ELSE 1 END,
                sr.created_at, LOWER(s.name), sr.revision_number DESC,
                sri.tool_id, sri.target_name, sri.artifact_id`,
      [organizationId],
    )
    return result.rows.map(composerItem)
  }

  async createSetup(record: CreateSetupRecord): Promise<CreateSetupOutcome> {
    try {
      return await transaction(this.pool, async (client) => {
        const existing = await client.query<QueryResultRow & { id: string }>(
          `SELECT id FROM setups
           WHERE organization_id = $1 AND LOWER(name) = LOWER($2)
           LIMIT 1`,
          [record.organizationId, record.name],
        )
        if (existing.rows[0]) return { outcome: 'nameTaken' }

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
    } catch (error) {
      if (isUniqueViolation(error)) return { outcome: 'nameTaken' }
      throw error
    }
  }
}
