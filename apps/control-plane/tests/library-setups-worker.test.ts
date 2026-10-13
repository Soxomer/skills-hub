import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import type { LibrarySetupSnapshot } from '@ahm/contracts'
import { applyMigrations } from '../src/migrations.js'
import { createControlPlaneApp } from '../src/http.js'
import { PostgresProjectRepository } from '../src/projects-pg.js'
import { ProjectService } from '../src/projects.js'
import { PostgresRunnerTransportRepository } from '../src/runner-transport-pg.js'
import { RunnerTransportService } from '../src/runner-transport.js'
import { PostgresSetupRepository } from '../src/setups-pg.js'
import { SetupService } from '../src/setups.js'

const databaseUrl = process.env.AHM_TEST_DATABASE_URL
const binary = process.env.AHM_TEST_RUNNER_BIN
it.skipIf(!databaseUrl || !binary)('runs preview → consented snapshot → hosted Setup through the real Rust worker without a project', async () => {
  const schema = `ahm_worker_library_${randomUUID().replaceAll('-','')}`
  const admin = new Pool({ connectionString:databaseUrl, max:1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString:databaseUrl, options:`-c search_path=${schema}`, max:5 })
  const transport = new RunnerTransportService(new PostgresRunnerTransportRepository(pool), { serverUrl:'http://127.0.0.1' })
  const app = createControlPlaneApp(transport, new ProjectService(new PostgresProjectRepository(pool)), undefined, new SetupService(new PostgresSetupRepository(pool)))
  const root = await mkdtemp(join(tmpdir(),'ahm-library-setup-worker-'))
  const home = join(root,'home'); await mkdir(home)
  const managed = join(home,'managed'); await mkdir(managed)
  await writeFile(join(managed,'SKILL.md'),'# Review\nReview changes carefully.\n')
  await writeFile(join(managed,'support.txt'),'Exact supporting content')
  const db = join(root,'library.db')
  const prefix = ['--db',db,'--runner-state',join(root,'runner.db')]
  const run = (args:string[]) => promisify(execFile)(binary!,[...prefix,...args],{windowsHide:true,timeout:20_000})
  const headers = {'x-ahm-organization-id':'org','x-ahm-user-id':'user'}
  try {
    await applyMigrations(pool)
    await pool.query(`INSERT INTO organizations VALUES ('org','Worker test',NOW()); INSERT INTO users VALUES ('user','Owner',NOW()); INSERT INTO organization_memberships VALUES ('org','user','owner',NOW())`)
    await app.listen({host:'127.0.0.1',port:0})
    const address = app.server.address() as {port:number}
    const origin = `http://127.0.0.1:${address.port}`
    const enrollment = await transport.createEnrollment({organizationId:'org',userId:'user'})
    await run(['connect',enrollment.code,'--server',origin])
    await run(['worker','--home',home,'--once'])
    const sqlite = new DatabaseSync(db)
    sqlite.prepare(`INSERT INTO skills (id,name,source_type,central_path,created_at,updated_at,last_seen_at,enabled,status) VALUES ('review','review','local',?,1,1,1,1,'ok')`).run(managed)
    sqlite.close()
    const identity = (await pool.query<{id:string}>('SELECT id FROM runner_devices')).rows[0]!
    async function job(command:'preview_setup_skill'|'snapshot_setup_skill',expectedDigest:string|null) {
      const queued = await app.inject({method:'POST',url:`/api/v1/runners/${identity.id}/library`,headers,payload:{command,args:{skillId:'review'},expectedDigest}})
      expect(queued.statusCode).toBe(200)
      const {jobId} = queued.json<{jobId:string}>()
      await run(['worker','--home',home,'--once'])
      const status = await app.inject({method:'GET',url:`/api/v1/jobs/${jobId}`,headers})
      expect(status.statusCode).toBe(200)
      return {jobId,status:status.json()}
    }
    const preview = await job('preview_setup_skill',null)
    const snapshot = preview.status.result.result.payload.value as LibrarySetupSnapshot
    expect(snapshot.files.map(f=>f.path)).toEqual(['SKILL.md','support.txt'])
    expect((await pool.query('SELECT COUNT(*) FROM artifact_bundles')).rows[0].count).toBe('0')
    expect((await pool.query('SELECT COUNT(*) FROM projects')).rows[0].count).toBe('0')
    await writeFile(join(managed,'support.txt'),'Changed before consent')
    const stale = await job('snapshot_setup_skill',snapshot.contentDigest)
    expect(stale.status.result.result.kind).toBe('error')
    expect((await pool.query('SELECT COUNT(*) FROM artifact_bundles')).rows[0].count).toBe('0')
    await writeFile(join(managed,'support.txt'),'Exact supporting content')
    const captured = await job('snapshot_setup_skill',snapshot.contentDigest)
    expect(captured.status.result.result.kind).toBe('libraryResponse')
    expect((await pool.query('SELECT COUNT(*) FROM artifact_bundles')).rows[0].count).toBe('1')
    const payload = {snapshotJobId:captured.jobId,contentDigest:snapshot.contentDigest,destination:{name:'Focused'},targets:[{toolId:'codex',targetName:'review'}]}
    const published = await app.inject({method:'POST',url:'/api/v1/setups/library-skill',headers,payload})
    expect(published.statusCode).toBe(201)
    const revision = published.json()
    expect((await app.inject({method:'POST',url:'/api/v1/setups/library-skill',headers,payload})).json()).toEqual(revision)
    await writeFile(join(managed,'SKILL.md'),'Updated after saving')
    const artifact = await app.inject({method:'GET',url:`/api/v1/setups/${revision.setupId}/revisions/${revision.setupRevisionId}/artifacts/${snapshot.contentDigest}`,headers})
    expect(Buffer.from(artifact.json().entries.find((e:{path:string})=>e.path==='SKILL.md').contentBase64,'base64').toString()).toContain('Review changes carefully')
    expect(await readFile(join(managed,'support.txt'),'utf8')).toBe('Exact supporting content')
    expect((await pool.query('SELECT COUNT(*) FROM project_assignments')).rows[0].count).toBe('0')
    const local = new DatabaseSync(db)
    expect(local.prepare('SELECT COUNT(*) AS count FROM skill_targets').get()!.count).toBe(0)
    local.close()
  } finally { await app.close(); await pool.end(); await admin.end() }
}, 60_000)
