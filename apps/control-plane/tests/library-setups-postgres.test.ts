import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import type { AddLibrarySkillRequest, ArtifactBundle, LibrarySetupSnapshot, ResultEnvelope } from '@ahm/contracts'
import { artifactDigest } from '../src/artifact-digest.js'
import { applyMigrations } from '../src/migrations.js'
import { PostgresSetupRepository } from '../src/setups-pg.js'
import { SetupService } from '../src/setups.js'

const databaseUrl = process.env.AHM_TEST_DATABASE_URL
it.skipIf(!databaseUrl)('publishes exact library snapshots atomically on PostgreSQL with isolation, replay and concurrency guards', async () => {
  const schema = `ahm_library_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 })
  const service = new SetupService(new PostgresSetupRepository(pool))
  const actor = { organizationId: 'org', userId: 'user' }
  try {
    await applyMigrations(pool)
    await pool.query(`INSERT INTO organizations VALUES ('org','Test',NOW()), ('foreign','Foreign',NOW());
      INSERT INTO users VALUES ('user','Owner',NOW()), ('viewer','Viewer',NOW());
      INSERT INTO organization_memberships VALUES ('org','user','owner',NOW()), ('foreign','user','owner',NOW()), ('org','viewer','viewer',NOW());
      INSERT INTO runner_devices (id,organization_id,label,credential_hash,status,enrolled_at) VALUES ('device','org','Test','test-hash','active',NOW());`)
    const entries: ArtifactBundle['entries'] = [{ path: 'SKILL.md', kind: 'file', contentBase64: Buffer.from('# Review\n').toString('base64') }]
    const contentDigest = artifactDigest(entries)
    const bundle: ArtifactBundle = { contentDigest, entries }
    const snapshot: LibrarySetupSnapshot = { artifactId: 'library-review', name: 'review', contentDigest, portableSource: null, supportedTools: ['codex', 'claude_code'], files: [{ path: 'SKILL.md', size: 9 }] }
    await pool.query(`INSERT INTO artifact_bundles VALUES ('org',$1,$2::jsonb,'device',NOW())`, [contentDigest, JSON.stringify(bundle)])
    async function seedJob(id: string, command = 'snapshot_setup_skill', state = 'succeeded') {
      const result: ResultEnvelope = { protocolVersion: '1.0', jobId: id, idempotencyKey: id, organizationId: 'org', deviceId: 'device', projectInstanceId: null, result: { kind: 'libraryResponse', payload: { value: snapshot } } }
      await pool.query(`INSERT INTO runner_jobs (id,organization_id,device_id,project_instance_id,protocol_version,idempotency_key,job_kind,payload,state,issued_at,expires_at,result_json)
        VALUES ($1,'org','device',NULL,'1.0',$1,'libraryAction',$2::jsonb,$3,NOW(),NOW()+INTERVAL '1 hour',$4::jsonb)`, [id, JSON.stringify({ command, args: { skillId: 'review' }, expectedDigest: contentDigest }), state, JSON.stringify(result)])
    }
    await seedJob('job_one')
    const request: AddLibrarySkillRequest = { snapshotJobId: 'job_one', contentDigest, destination: { name: 'Review' }, targets: [{ toolId: 'codex', targetName: 'review' }] }
    await expect(service.addLibrarySkill({ ...actor, userId: 'viewer' }, request)).rejects.toMatchObject({ code: 'setupForbidden', statusCode: 403 })
    await expect(service.addLibrarySkill({ ...actor, organizationId: 'foreign' }, request)).rejects.toMatchObject({ code: 'setupSnapshotUnavailable' })
    const created = await service.addLibrarySkill(actor, request)
    expect(await service.addLibrarySkill(actor, request)).toEqual(created)
    expect(await service.revisionArtifact(actor, created.setupId, created.setupRevisionId, contentDigest)).toEqual(bundle)
    await expect(service.addLibrarySkill(actor, { ...request, targets: [{toolId:'claude_code',targetName:'review'}] })).rejects.toMatchObject({ code: 'setupPublicationConflict' })
    await seedJob('preview', 'preview_setup_skill')
    await seedJob('pending', 'snapshot_setup_skill', 'pending')
    for (const snapshotJobId of ['preview','pending']) await expect(service.addLibrarySkill(actor, { ...request, snapshotJobId })).rejects.toMatchObject({ code: 'setupSnapshotUnavailable' })
    await pool.query(`INSERT INTO projects (id,organization_id,name,created_at,updated_at) VALUES ('project','org','Pinned',NOW(),NOW())`)
    await pool.query(`INSERT INTO project_assignments (organization_id,project_id,setup_revision_id,assigned_by,assigned_at) VALUES ('org','project',$1,'user',NOW())`, [created.setupRevisionId])
    await seedJob('job_two'); await seedJob('job_three')
    const destination = { setupId: created.setupId, expectedRevisionNumber: 1 }
    const results = await Promise.allSettled(['job_two','job_three'].map((snapshotJobId, index) => service.addLibrarySkill(actor, { ...request, snapshotJobId, destination, targets: [{toolId:'claude_code',targetName:`review-${index}`}]})))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'setupRevisionConflict' } })
    const detail = await service.setupDetail(actor, created.setupId)
    expect(detail.revisions.map(r => r.itemCount)).toEqual([2,1])
    expect(detail.projects[0]!.setupRevisionId).toBe(created.setupRevisionId)
    expect((await pool.query(`SELECT COUNT(*) FROM setup_library_publications`)).rows[0].count).toBe('2')
    await seedJob('conflict')
    await expect(service.addLibrarySkill(actor, { ...request, snapshotJobId: 'conflict', destination: { setupId: created.setupId, expectedRevisionNumber: 2 } })).rejects.toMatchObject({ code: 'setupTargetConflict' })
    await pool.query(`CREATE FUNCTION fail_library_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deliberate failure'; END; $$;
      CREATE TRIGGER reject_library_publication BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.event_kind = 'setupLibrarySkillAdded') EXECUTE FUNCTION fail_library_audit();`)
    await seedJob('fail')
    await expect(service.addLibrarySkill(actor, { ...request, snapshotJobId: 'fail', destination: { setupId: created.setupId, expectedRevisionNumber: 2 }, targets: [{ toolId:'codex',targetName:'extra' }] })).rejects.toThrow('deliberate failure')
    expect((await service.setupDetail(actor, created.setupId)).revisions).toHaveLength(2)
    expect((await pool.query(`SELECT COUNT(*) FROM setup_library_publications`)).rows[0].count).toBe('2')
  } finally { await pool.end(); await admin.end() }
}, 30_000)
