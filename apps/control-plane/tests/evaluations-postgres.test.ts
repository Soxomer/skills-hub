import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import type { CreateEvaluationRequest } from '@ahm/contracts'
import { applyMigrations } from '../src/migrations.js'
import { EvaluationService } from '../src/evaluations.js'
import { PostgresEvaluationRepository } from '../src/evaluations-pg.js'

const databaseUrl = process.env.AHM_TEST_DATABASE_URL
it.skipIf(!databaseUrl)('persists immutable evaluation jobs with membership, revision, capability and duplicate guards', async () => {
  const schema = `ahm_evaluation_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const service = new EvaluationService(new PostgresEvaluationRepository(pool))
  const actor = { organizationId: 'org', userId: 'user' }
  const request: CreateEvaluationRequest = { idempotencyKey: 'one', deviceId: 'device', baseline: { setupId: 'setup', setupRevisionId: 'v1' }, candidate: { setupId: 'setup', setupRevisionId: 'v2' },
    profile: { harness: 'codex', profileVersion: 1, model: 'test-model', reasoningEffort: 'medium', sandbox: 'read-only', contextMode: 'skillInstructions', timeoutSeconds: 120 } }
  try {
    await applyMigrations(pool)
    await pool.query(`INSERT INTO organizations VALUES ('org','Test',NOW()), ('foreign','Foreign',NOW());
      INSERT INTO users VALUES ('user','Owner',NOW()), ('viewer','Viewer',NOW());
      INSERT INTO organization_memberships VALUES ('org','user','owner',NOW()), ('foreign','user','owner',NOW()), ('org','viewer','viewer',NOW());
      INSERT INTO runner_devices (id,organization_id,label,credential_hash,status,enrolled_at,capabilities) VALUES ('device','org','Test','test-hash','active',NOW(),'{"evaluateSetups":true}');
      INSERT INTO setups (id,organization_id,name,kind,created_by,created_at,updated_at) VALUES ('setup','org','Review','custom','user',NOW(),NOW());
      INSERT INTO setup_revisions (id,organization_id,setup_id,revision_number,created_by,created_at) VALUES ('v1','org','setup',1,'user',NOW()), ('v2','org','setup',2,'user',NOW());`)
    await expect(service.create({ ...actor, userId: 'viewer' }, request)).rejects.toMatchObject({ statusCode: 403 })
    await expect(service.create({ ...actor, organizationId: 'foreign' }, request)).rejects.toMatchObject({ statusCode: 404 })
    await expect(service.create(actor, { ...request, candidate: { setupId: 'setup', setupRevisionId: 'missing' } })).rejects.toMatchObject({ statusCode: 404 })
    const [first, second] = await Promise.all([service.create(actor, request), service.create(actor, request)])
    expect(first.jobId).toBe(second.jobId)
    expect(first.definition).toMatchObject({ baseline: { setupRevisionId: 'v1' }, candidate: { setupRevisionId: 'v2' }, suiteId: 'code-review-v1', repetitions: 1 })
    expect((await service.list(actor, 'v2')).evaluations).toHaveLength(1)
    expect((await service.list({ ...actor, organizationId: 'foreign' }, 'v2')).evaluations).toEqual([])
    await expect(service.create(actor, { ...request, profile: { ...request.profile, model: 'other' } })).rejects.toMatchObject({ statusCode: 409 })
    expect((await pool.query('SELECT COUNT(*) FROM audit_events')).rows[0].count).toBe('1')
    await pool.query(`UPDATE runner_devices SET capabilities = '{}'`)
    await expect(service.create(actor, { ...request, idempotencyKey: 'two' })).rejects.toMatchObject({ statusCode: 409 })
    expect((await service.list({ ...actor, userId: 'viewer' }, 'v2')).evaluations).toHaveLength(1)
  } finally { await pool.end(); await admin.end() }
}, 30_000)
