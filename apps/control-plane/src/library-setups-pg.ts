import { isLibrarySetupSnapshot, type LibraryRequest, type ResultEnvelope, type SetupRevisionSummary } from '@ahm/contracts'
import type { Pool } from 'pg'
import type { AddLibrarySkillOutcome, AddLibrarySkillRecord, SetupServiceErrorCode } from './setups.js'
import { membershipAllows, type MembershipRole } from './development-auth.js'

export async function addLibrarySkill(pool: Pool, record: AddLibrarySkillRecord): Promise<AddLibrarySkillOutcome> {
  const client = await pool.connect()
  const error = (code: SetupServiceErrorCode): AddLibrarySkillOutcome => ({ outcome: 'error', code })
  let committed = false
  try {
    await client.query('BEGIN')
    const membership = await client.query<{role: MembershipRole}>(`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE`, [record.organizationId, record.createdBy])
    if (!membershipAllows(membership.rows[0]?.role, 'write')) return error('setupForbidden')
    const source = await client.query<{ state: string; job_kind: string; payload: LibraryRequest; result_json: ResultEnvelope }>(
      `SELECT state, job_kind, payload, result_json FROM runner_jobs WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [record.organizationId, record.snapshotJobId])
    const job = source.rows[0]
    if (!job || job.state !== 'succeeded' || job.job_kind !== 'libraryAction' || job.payload.command !== 'snapshot_setup_skill'
      || job.payload.expectedDigest !== record.contentDigest || job.result_json?.result.kind !== 'libraryResponse') return error('setupSnapshotUnavailable')
    const snapshot = job.result_json.result.payload.value
    if (!isLibrarySetupSnapshot(snapshot) || snapshot.contentDigest !== record.contentDigest
      || record.targets.some(t => !snapshot.supportedTools.includes(t.toolId))) return error('setupSnapshotUnavailable')
    const prior = await client.query<{ request_digest: string; revision: SetupRevisionSummary }>(
      `SELECT request_digest, details AS revision FROM setup_library_publications p JOIN audit_events a
       ON a.organization_id = p.organization_id AND a.subject_id = p.setup_revision_id AND a.event_kind = 'setupLibrarySkillAdded'
       WHERE p.organization_id = $1 AND p.source_job_id = $2`, [record.organizationId, record.snapshotJobId])
    if (prior.rows[0]) return prior.rows[0].request_digest === record.requestDigest ? { outcome: 'created', revision: prior.rows[0].revision } : error('setupPublicationConflict')
    const bundle = await client.query(`SELECT 1 FROM artifact_bundles WHERE organization_id = $1 AND content_digest = $2`, [record.organizationId, snapshot.contentDigest])
    if (!bundle.rows.length) return error('setupSnapshotUnavailable')
    let revisionNumber = 1
    let name: string
    let kind: 'default' | 'custom' = 'custom'
    let baseRevisionId: string | null = null
    if ('setupId' in record.destination) {
      const setup = await client.query<{ name: string; kind: 'default' | 'custom' }>(`SELECT name, kind FROM setups WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [record.organizationId, record.setupId])
      if (!setup.rows[0]) return error('setupNotFound')
      name = setup.rows[0].name; kind = setup.rows[0].kind
      const latest = await client.query<{ id: string; revision_number: string | number }>(`SELECT id, revision_number FROM setup_revisions WHERE organization_id = $1 AND setup_id = $2 ORDER BY revision_number DESC LIMIT 1`, [record.organizationId, record.setupId])
      if (Number(latest.rows[0]?.revision_number) !== record.destination.expectedRevisionNumber) return error('setupRevisionConflict')
      baseRevisionId = latest.rows[0]!.id; revisionNumber = record.destination.expectedRevisionNumber + 1
      const existing = await client.query<{ artifact_id: string; tool_id: string; target_name: string }>(`SELECT artifact_id, tool_id, target_name FROM setup_revision_items WHERE organization_id = $1 AND setup_revision_id = $2`, [record.organizationId, baseRevisionId])
      if (existing.rows.length + record.targets.length > 5000) return error('invalidSetupItems')
      if (existing.rows.some(e => record.targets.some(t => t.toolId === e.tool_id && t.targetName === e.target_name))) return error('setupTargetConflict')
    } else {
      name = record.destination.name
      const duplicate = await client.query(`SELECT id FROM setups WHERE organization_id = $1 AND LOWER(name) = LOWER($2)`, [record.organizationId, name])
      if (duplicate.rows.length) return error('setupNameTaken')
      await client.query(`INSERT INTO setups (id, organization_id, name, kind, default_project_id, created_by, created_at, updated_at) VALUES ($1,$2,$3,'custom',NULL,$4,$5,$5)`, [record.setupId, record.organizationId, name, record.createdBy, record.createdAt])
    }
    await client.query(`INSERT INTO setup_revisions (id, organization_id, setup_id, revision_number, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [record.setupRevisionId, record.organizationId, record.setupId, revisionNumber, record.createdBy, record.createdAt])
    if (baseRevisionId) await client.query(`INSERT INTO setup_revision_items (organization_id, setup_revision_id, artifact_id, artifact_kind, artifact_reference, tool_id, target_name)
      SELECT organization_id, $3, artifact_id, artifact_kind, artifact_reference, tool_id, target_name FROM setup_revision_items WHERE organization_id = $1 AND setup_revision_id = $2`, [record.organizationId, baseRevisionId, record.setupRevisionId])
    for (const target of record.targets) await client.query(`INSERT INTO setup_revision_items (organization_id, setup_revision_id, artifact_id, artifact_kind, artifact_reference, tool_id, target_name) VALUES ($1,$2,$3,'skill',$4::jsonb,$5,$6)`,
      [record.organizationId, record.setupRevisionId, snapshot.artifactId, JSON.stringify({ portableSource: snapshot.portableSource, contentDigest: snapshot.contentDigest }), target.toolId, target.targetName])
    await client.query(`UPDATE setups SET updated_at = $3 WHERE organization_id = $1 AND id = $2`, [record.organizationId, record.setupId, record.createdAt])
    const count = await client.query<{ count: string | number }>(`SELECT COUNT(*) AS count FROM setup_revision_items WHERE organization_id = $1 AND setup_revision_id = $2`, [record.organizationId, record.setupRevisionId])
    const revision: SetupRevisionSummary = { setupId: record.setupId, setupRevisionId: record.setupRevisionId, name, kind, revisionNumber, itemCount: Number(count.rows[0]!.count), createdAt: record.createdAt }
    await client.query(`INSERT INTO audit_events (id, organization_id, actor_user_id, event_kind, subject_id, details, created_at) VALUES ($1,$2,$3,'setupLibrarySkillAdded',$4,$5::jsonb,$6)`, [record.auditEventId, record.organizationId, record.createdBy, record.setupRevisionId, JSON.stringify(revision), record.createdAt])
    await client.query(`INSERT INTO setup_library_publications (organization_id, source_job_id, request_digest, setup_revision_id) VALUES ($1,$2,$3,$4)`, [record.organizationId, record.snapshotJobId, record.requestDigest, record.setupRevisionId])
    await client.query('COMMIT')
    committed = true
    return { outcome: 'created', revision }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505') return error('setupId' in record.destination ? 'setupRevisionConflict' : 'setupNameTaken')
    throw err
  } finally {
    // Early validation outcomes must release locks without retaining a transaction.
    try { if (!committed) await client.query('ROLLBACK') } finally { client.release() }
  }
}
