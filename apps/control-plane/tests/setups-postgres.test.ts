import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { expect, it } from 'vitest'

import { createControlPlaneApp } from '../src/http.js'
import { PostgresProjectRepository } from '../src/projects-pg.js'
import { ProjectService } from '../src/projects.js'
import { PostgresRunnerTransportRepository } from '../src/runner-transport-pg.js'
import { RunnerTransportService } from '../src/runner-transport.js'
import { PostgresSetupRepository } from '../src/setups-pg.js'
import { SetupService } from '../src/setups.js'

// Opt in only against a disposable database. Each run gets a fresh, retained
// schema; it never drops or rewrites any existing database/schema.
const databaseUrl = process.env.AHM_TEST_DATABASE_URL

it.skipIf(!databaseUrl)('serializes concurrent publishers on real PostgreSQL without moving revision pins', async () => {
  const schema = `ahm_setup_publication_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  try { await admin.query(`CREATE SCHEMA "${schema}"`) }
  finally { await admin.end() }
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, application_name: schema, max: 5 })
  const transport = new RunnerTransportService(new PostgresRunnerTransportRepository(pool), { serverUrl: 'http://127.0.0.1:8787' })
  const app = createControlPlaneApp(transport, new ProjectService(new PostgresProjectRepository(pool)), undefined,
    new SetupService(new PostgresSetupRepository(pool)))
  try {
    const directory = new URL('../migrations/', import.meta.url)
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, directory), 'utf8'))
    }
    await pool.query(`
      INSERT INTO organizations (id, name, created_at) VALUES ('org', 'Publication test', NOW());
      INSERT INTO users (id, display_name, created_at) VALUES ('user', 'Publication test', NOW());
      INSERT INTO projects (id, organization_id, name, created_at, updated_at) VALUES ('project', 'org', 'Project', NOW(), NOW());
      INSERT INTO setups (id, organization_id, name, kind, default_project_id, created_by, created_at, updated_at)
        VALUES ('default', 'org', 'Default / Project', 'default', 'project', 'user', NOW(), NOW());
      INSERT INTO setup_revisions (id, organization_id, setup_id, revision_number, created_by, created_at)
        VALUES ('initial-default', 'org', 'default', 1, 'user', NOW());
      INSERT INTO setup_revision_items (organization_id, setup_revision_id, artifact_id, artifact_kind, artifact_reference, tool_id, target_name)
        VALUES ('org', 'initial-default', 'skill', 'skill', '{"contentDigest":"sha256:test","portableSource":null}', 'codex', 'skill');
      INSERT INTO project_assignments (organization_id, project_id, setup_revision_id, assigned_by, assigned_at)
        VALUES ('org', 'project', 'initial-default', 'user', NOW());
    `)
    const headers = { 'x-ahm-organization-id': 'org', 'x-ahm-user-id': 'user' }
    const items = [{ sourceSetupRevisionId: 'initial-default', artifactId: 'skill', contentDigest: 'sha256:test', toolId: 'codex', targetName: 'skill' }]
    const created = await app.inject({ method: 'POST', url: '/api/v1/setups', headers, payload: { name: 'Shared', items } })
    expect(created.statusCode).toBe(201)
    const initial = created.json<{ setupId: string; setupRevisionId: string }>()
    await pool.query(`UPDATE project_assignments SET setup_revision_id = $1 WHERE organization_id = 'org' AND project_id = 'project'`, [initial.setupRevisionId])

    // Hold the Setup row first so both HTTP publishers overlap at its lock.
    const blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query(`SELECT id FROM setups WHERE id = $1 FOR UPDATE`, [initial.setupId])
    const requests = [1, 2].map(() => app.inject({ method: 'POST', url: `/api/v1/setups/${initial.setupId}/revisions`,
      headers, payload: { expectedRevisionNumber: 1, items } }))
    // Force injection to start before releasing the lock (inject() is thenable).
    const pending = Promise.all(requests)
    let waiting = 0
    try {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const blocked = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [schema],
        )
        waiting = Number(blocked.rows[0]?.count)
        if (waiting === 2) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } finally {
      await blocker.query('COMMIT')
      blocker.release()
    }
    const responses = await pending
    expect(waiting, 'both publishers reached the same PostgreSQL row lock').toBe(2)
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409])
    expect(responses.find((response) => response.statusCode === 409)?.json()).toMatchObject({ code: 'setupRevisionConflict' })
    expect((await pool.query(`SELECT revision_number FROM setup_revisions WHERE setup_id = $1 ORDER BY revision_number`, [initial.setupId])).rows)
      .toEqual([{ revision_number: '1' }, { revision_number: '2' }])
    expect((await pool.query(`SELECT setup_revision_id FROM project_assignments WHERE project_id = 'project'`)).rows[0])
      .toEqual({ setup_revision_id: initial.setupRevisionId })
    expect((await pool.query(`SELECT id, revision_number FROM setup_revisions WHERE setup_id = 'default'`)).rows)
      .toEqual([{ id: 'initial-default', revision_number: '1' }])
    expect((await pool.query(`SELECT id FROM audit_events WHERE event_kind = 'setupRevisionCreated'`)).rowCount).toBe(2)
    const detail = await app.inject({ method: 'GET', url: '/api/v1/setups/default', headers })
    expect(detail.json()).toMatchObject({ initialSetupRevisionId: 'initial-default' })
    console.info(`Real PostgreSQL publication evidence retained in schema ${schema}`)
  } finally {
    await app.close()
    await pool.end()
  }
}, 30_000)
