import { PROTOCOL_VERSION, type CreateEvaluationRequest, type EvaluateSetupsPayload, type EvaluationSummary, type PortableSetupRevision, type ResultEnvelope, type RunnerCapabilities } from '@ahm/contracts'
import type { Pool, PoolClient } from 'pg'
import { membershipAllows, type BrowserAccess, type MembershipRole } from './development-auth.js'
import type { EvaluationRepository } from './evaluations.js'
import { RunnerTransportError, type RequestActor } from './runner-transport.js'
import { sameEvaluationProfile } from './evaluation-results.js'

interface EvaluationRow {
  id: string; device_id: string; issued_at: Date | string; expires_at: Date | string
  payload: EvaluateSetupsPayload; state: EvaluationSummary['state']; cancel_requested_at: Date | null
  result_json: ResultEnvelope | null
}

function summary(row: EvaluationRow): EvaluationSummary {
  return { jobId: row.id, deviceId: row.device_id, createdAt: new Date(row.issued_at).toISOString(), definition: row.payload,
    state: row.state === 'pending' && new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : row.state,
    cancelRequested: row.cancel_requested_at !== null, result: row.result_json?.result ?? null }
}

export class PostgresEvaluationRepository implements EvaluationRepository {
  constructor(private readonly pool: Pool) {}

  private async withActor<T>(actor: RequestActor, access: BrowserAccess, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const membership = await client.query<{ role: MembershipRole }>(
        'SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE', [actor.organizationId, actor.userId])
      if (!membershipAllows(membership.rows[0]?.role, access)) throw new RunnerTransportError(403, 'Organization membership does not permit this operation')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async create(actor: RequestActor, request: CreateEvaluationRequest, jobId: string, now: string): Promise<EvaluationSummary> {
    return this.withActor(actor, 'write', async (client) => {
      // Serializes duplicate browser retries and runner revocation on the same device.
      const device = await client.query<{ status: string; capabilities: RunnerCapabilities | null }>(
        'SELECT status, capabilities FROM runner_devices WHERE organization_id = $1 AND id = $2 FOR UPDATE', [actor.organizationId, request.deviceId])
      if (device.rows[0]?.status !== 'active') throw new RunnerTransportError(404, 'Connected runner not found')
      const key = `evaluation-${request.idempotencyKey}`
      const existing = await client.query<EvaluationRow>(
        'SELECT * FROM runner_jobs WHERE organization_id = $1 AND device_id = $2 AND idempotency_key = $3', [actor.organizationId, request.deviceId, key])
      const prior = existing.rows[0]
      if (prior) {
        const definition = prior.payload
        if (definition.baseline?.setupId !== request.baseline.setupId || definition.baseline?.setupRevisionId !== request.baseline.setupRevisionId ||
          definition.candidate?.setupId !== request.candidate.setupId || definition.candidate?.setupRevisionId !== request.candidate.setupRevisionId ||
          !sameEvaluationProfile(definition.profile, request.profile)) throw new RunnerTransportError(409, 'This evaluation request key was already used with different conditions')
        return summary(prior)
      }
      if (!device.rows[0]?.capabilities?.evaluateSetups) throw new RunnerTransportError(409, 'Update the connected runner to support evaluations', 'evaluationRunnerUnsupported')
      const resolve = async (reference: CreateEvaluationRequest['candidate']): Promise<PortableSetupRevision> => {
        const revisions = await client.query<{ revision_number: number }>(
          'SELECT revision_number FROM setup_revisions WHERE organization_id = $1 AND setup_id = $2 AND id = $3',
          [actor.organizationId, reference.setupId, reference.setupRevisionId])
        const revision = revisions.rows[0]
        if (!revision) throw new RunnerTransportError(404, 'The exact Setup revision is unavailable', 'evaluationRevisionUnavailable')
        const items = await client.query<PortableSetupRevision['items'][number]>(
          `SELECT artifact_id AS "artifactId", artifact_kind AS "artifactKind", artifact_reference->>'portableSource' AS "portableSource",
           artifact_reference->>'contentDigest' AS "contentDigest", tool_id AS "toolId", target_name AS "targetName"
           FROM setup_revision_items WHERE organization_id = $1 AND setup_revision_id = $2 ORDER BY tool_id, target_name, artifact_id`,
          [actor.organizationId, reference.setupRevisionId])
        if (items.rows.length > 50 || items.rows.some((item) => item.toolId !== 'codex' || item.artifactKind !== 'skill')) {
          throw new RunnerTransportError(400, 'This pilot supports up to 50 Codex skill instructions only. Other tools and plugin content cannot be silently omitted.', 'evaluationUnsupportedContent')
        }
        for (const item of items.rows) {
          const bundles = await client.query<{ present: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM artifact_bundles, jsonb_array_elements(bundle->'entries') entry
             WHERE organization_id = $1 AND content_digest = $2 AND entry->>'path' = 'SKILL.md' AND entry->>'kind' = 'file') AS present`,
            [actor.organizationId, item.contentDigest])
          if (!bundles.rows[0]?.present) {
            throw new RunnerTransportError(409, 'A captured SKILL.md is unavailable. Capture the skill again before evaluating.', 'evaluationCaptureUnavailable')
          }
        }
        return { setupId: reference.setupId, setupRevisionId: reference.setupRevisionId, revisionNumber: Number(revision.revision_number), items: items.rows }
      }
      const definition: EvaluateSetupsPayload = { baseline: await resolve(request.baseline), candidate: await resolve(request.candidate),
        suiteId: 'code-review-v1', profile: request.profile, repetitions: 1 }
      const expiresAt = new Date(new Date(now).getTime() + 30 * 60_000).toISOString()
      await client.query(
        `INSERT INTO runner_jobs (id, organization_id, device_id, project_instance_id, protocol_version, idempotency_key, job_kind, payload, state, issued_at, expires_at)
         VALUES ($1, $2, $3, NULL, $4, $5, 'evaluateSetups', $6::jsonb, 'pending', $7, $8)`,
        [jobId, actor.organizationId, request.deviceId, PROTOCOL_VERSION, key, JSON.stringify(definition), now, expiresAt])
      await client.query(
        `INSERT INTO audit_events (id, organization_id, actor_user_id, event_kind, subject_id, details, created_at)
         VALUES ($1, $2, $3, 'evaluationRequested', $4, $5::jsonb, $6)`,
        [`audit_${jobId}`, actor.organizationId, actor.userId, jobId, JSON.stringify({ baselineRevisionId: definition.baseline.setupRevisionId, candidateRevisionId: definition.candidate.setupRevisionId, profile: definition.profile, suiteId: definition.suiteId }), now])
      return { jobId, deviceId: request.deviceId, createdAt: now, definition, state: 'pending', cancelRequested: false, result: null }
    })
  }

  async list(actor: RequestActor, candidateRevisionId: string): Promise<EvaluationSummary[]> {
    return this.withActor(actor, 'read', async (client) => {
      const result = await client.query<EvaluationRow>(
        `SELECT * FROM runner_jobs WHERE organization_id = $1 AND job_kind = 'evaluateSetups'
         AND payload->'candidate'->>'setupRevisionId' = $2 ORDER BY issued_at DESC, id DESC LIMIT 50`, [actor.organizationId, candidateRevisionId])
      return result.rows.map(summary)
    })
  }
}
