import type { DefaultRevisionSummary, DiscoveryKind, ResultEnvelope } from '@ahm/contracts'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

import type {
  CaptureDefaultOutcome,
  CaptureDefaultRecord,
  DefaultCaptureItem,
  ProjectRepository,
  ScanJobRecord,
  StoredDefaultCapture,
  StoredProject,
} from './projects.js'

interface ProjectRow extends QueryResultRow {
  id: string
  organization_id: string
  name: string
  repository_identity: string | null
  created_at: Date | string
  updated_at: Date | string
  setup_id: string | null
  setup_revision_id: string | null
  revision_number: number | string | null
  source_scan_job_id: string | null
  revision_created_at: Date | string | null
  item_count: number | string | null
}

interface ScanJobRow extends QueryResultRow {
  id: string
  state: ScanJobRecord['state']
  result_json: ResultEnvelope | null
}

interface CaptureRow extends QueryResultRow {
  setup_id: string
  setup_revision_id: string
  revision_number: number | string
  source_scan_job_id: string | null
  created_at: Date | string
}

interface CaptureItemRow extends QueryResultRow {
  artifact_id: string
  artifact_kind: DiscoveryKind
  artifact_reference: { portableSource?: unknown; contentDigest?: unknown } | string
  tool_id: string
  target_name: string
}

function iso(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString()
}

function defaultRevision(row: ProjectRow): DefaultRevisionSummary | null {
  if (
    !row.setup_id ||
    !row.setup_revision_id ||
    row.revision_number === null ||
    row.revision_created_at === null
  ) {
    return null
  }
  return {
    setupId: row.setup_id,
    setupRevisionId: row.setup_revision_id,
    revisionNumber: Number(row.revision_number),
    sourceScanJobId: row.source_scan_job_id,
    itemCount: Number(row.item_count ?? 0),
    createdAt: iso(row.revision_created_at),
  }
}

function projectFromRow(row: ProjectRow): StoredProject {
  return {
    organizationId: row.organization_id,
    projectId: row.id,
    name: row.name,
    repositoryIdentity: row.repository_identity,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    defaultRevision: defaultRevision(row),
  }
}

function referenceFromRow(row: CaptureItemRow): Record<string, unknown> {
  if (typeof row.artifact_reference === 'string') {
    return JSON.parse(row.artifact_reference) as Record<string, unknown>
  }
  return row.artifact_reference
}

function itemFromRow(row: CaptureItemRow): DefaultCaptureItem {
  const reference = referenceFromRow(row)
  return {
    discoveryId: row.artifact_id,
    kind: row.artifact_kind,
    name: row.target_name,
    toolId: row.tool_id,
    portableSource:
      typeof reference.portableSource === 'string' ? reference.portableSource : null,
    contentDigest:
      typeof reference.contentDigest === 'string' ? reference.contentDigest : '',
  }
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
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

const PROJECT_SELECT = `
  SELECT p.id, p.organization_id, p.name, p.repository_identity,
         p.created_at, p.updated_at,
         s.id AS setup_id, sr.id AS setup_revision_id,
         sr.revision_number, sr.source_scan_job_id,
         sr.created_at AS revision_created_at,
         COUNT(sri.artifact_id) AS item_count
  FROM projects p
  LEFT JOIN project_assignments pa
    ON pa.organization_id = p.organization_id AND pa.project_id = p.id
  LEFT JOIN setup_revisions sr
    ON sr.organization_id = pa.organization_id AND sr.id = pa.setup_revision_id
  LEFT JOIN setups s
    ON s.organization_id = sr.organization_id AND s.id = sr.setup_id
      AND s.kind = 'default' AND s.default_project_id = p.id
  LEFT JOIN setup_revision_items sri
    ON sri.organization_id = sr.organization_id AND sri.setup_revision_id = sr.id`

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly pool: Pool) {}

  async createProject(project: StoredProject): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO projects
         (id, organization_id, name, repository_identity, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          project.projectId,
          project.organizationId,
          project.name,
          project.repositoryIdentity,
          project.createdAt,
          project.updatedAt,
        ],
      )
      return true
    } catch (error) {
      if (isUniqueViolation(error)) return false
      throw error
    }
  }

  async listProjects(organizationId: string): Promise<StoredProject[]> {
    const result = await this.pool.query<ProjectRow>(
      `${PROJECT_SELECT}
       WHERE p.organization_id = $1
       GROUP BY p.id, p.organization_id, p.name, p.repository_identity,
                p.created_at, p.updated_at, s.id, sr.id, sr.revision_number,
                sr.source_scan_job_id, sr.created_at
       ORDER BY p.created_at, p.id`,
      [organizationId],
    )
    return result.rows.map(projectFromRow)
  }

  async scanJob(
    organizationId: string,
    projectId: string,
    jobId: string,
  ): Promise<ScanJobRecord | null> {
    const result = await this.pool.query<ScanJobRow>(
      `SELECT j.id, j.state, j.result_json
       FROM runner_jobs j
       JOIN project_instances pi
         ON pi.organization_id = j.organization_id AND pi.id = j.project_instance_id
       WHERE j.organization_id = $1 AND pi.project_id = $2
         AND j.id = $3 AND j.job_kind = 'scanProject'`,
      [organizationId, projectId, jobId],
    )
    const row = result.rows[0]
    return row ? { jobId: row.id, state: row.state, result: row.result_json } : null
  }

  async captureDefault(record: CaptureDefaultRecord): Promise<CaptureDefaultOutcome> {
    return transaction(this.pool, async (client) => {
      const project = await client.query<QueryResultRow & { name: string }>(
        `SELECT name FROM projects
         WHERE organization_id = $1 AND id = $2
         FOR UPDATE`,
        [record.organizationId, record.projectId],
      )
      const projectRow = project.rows[0]
      if (!projectRow) return { outcome: 'projectMissing' }

      const existing = await this.readCapture(client, record.organizationId, record.projectId)
      if (existing) return { outcome: 'existing', capture: existing }

      await client.query(
        `INSERT INTO setups
         (id, organization_id, name, kind, default_project_id, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'default', $4, $5, $6, $6)`,
        [
          record.setupId,
          record.organizationId,
          `Default / ${projectRow.name} / ${record.projectId}`,
          record.projectId,
          record.createdBy,
          record.createdAt,
        ],
      )
      await client.query(
        `INSERT INTO setup_revisions
         (id, organization_id, setup_id, revision_number, created_by, created_at,
          source_scan_job_id)
         VALUES ($1, $2, $3, 1, $4, $5, $6)`,
        [
          record.setupRevisionId,
          record.organizationId,
          record.setupId,
          record.createdBy,
          record.createdAt,
          record.scanJobId,
        ],
      )
      for (const item of record.items) {
        await client.query(
          `INSERT INTO setup_revision_items
           (organization_id, setup_revision_id, artifact_id, artifact_kind,
            artifact_reference, tool_id, target_name)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
          [
            record.organizationId,
            record.setupRevisionId,
            item.discoveryId,
            item.kind,
            JSON.stringify({
              portableSource: item.portableSource,
              contentDigest: item.contentDigest,
            }),
            item.toolId,
            item.name,
          ],
        )
      }
      await client.query(
        `INSERT INTO project_assignments
         (organization_id, project_id, setup_revision_id, assigned_by, assigned_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, project_id) DO UPDATE
         SET setup_revision_id = EXCLUDED.setup_revision_id,
             assigned_by = EXCLUDED.assigned_by,
             assigned_at = EXCLUDED.assigned_at`,
        [
          record.organizationId,
          record.projectId,
          record.setupRevisionId,
          record.createdBy,
          record.createdAt,
        ],
      )
      await client.query(
        `UPDATE projects SET updated_at = $1
         WHERE organization_id = $2 AND id = $3`,
        [record.createdAt, record.organizationId, record.projectId],
      )
      await client.query(
        `INSERT INTO audit_events
         (id, organization_id, actor_user_id, event_kind, subject_id, details, created_at)
         VALUES ($1, $2, $3, 'defaultRevisionCaptured', $4, $5::jsonb, $6)`,
        [
          record.auditEventId,
          record.organizationId,
          record.createdBy,
          record.setupRevisionId,
          JSON.stringify({
            projectId: record.projectId,
            sourceScanJobId: record.scanJobId,
            includedDiscoveryIds: record.items.map((item) => item.discoveryId),
          }),
          record.createdAt,
        ],
      )
      return {
        outcome: 'created',
        capture: {
          revision: {
            setupId: record.setupId,
            setupRevisionId: record.setupRevisionId,
            revisionNumber: 1,
            sourceScanJobId: record.scanJobId,
            itemCount: record.items.length,
            createdAt: record.createdAt,
          },
          items: [...record.items],
        },
      }
    })
  }

  private async readCapture(
    client: PoolClient,
    organizationId: string,
    projectId: string,
  ): Promise<StoredDefaultCapture | null> {
    const result = await client.query<CaptureRow>(
      `SELECT s.id AS setup_id, sr.id AS setup_revision_id, sr.revision_number,
              sr.source_scan_job_id, sr.created_at
       FROM setups s
       JOIN setup_revisions sr
         ON sr.organization_id = s.organization_id AND sr.setup_id = s.id
       WHERE s.organization_id = $1 AND s.default_project_id = $2
         AND s.kind = 'default'
       ORDER BY sr.revision_number DESC
       LIMIT 1`,
      [organizationId, projectId],
    )
    const row = result.rows[0]
    if (!row) return null
    const itemResult = await client.query<CaptureItemRow>(
      `SELECT artifact_id, artifact_kind, artifact_reference, tool_id, target_name
       FROM setup_revision_items
       WHERE organization_id = $1 AND setup_revision_id = $2
       ORDER BY tool_id, target_name, artifact_id`,
      [organizationId, row.setup_revision_id],
    )
    return {
      revision: {
        setupId: row.setup_id,
        setupRevisionId: row.setup_revision_id,
        revisionNumber: Number(row.revision_number),
        sourceScanJobId: row.source_scan_job_id,
        itemCount: itemResult.rows.length,
        createdAt: iso(row.created_at),
      },
      items: itemResult.rows.map(itemFromRow),
    }
  }
}
