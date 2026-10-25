import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { createControlPlaneApp } from '../src/http.js'
import { applyMigrations } from '../src/migrations.js'
import { InMemoryProjectRepository } from '../src/projects-memory.js'
import { ProjectService } from '../src/projects.js'
import { PostgresRunnerTransportRepository } from '../src/runner-transport-pg.js'
import { RunnerTransportService } from '../src/runner-transport.js'

const databaseUrl = process.env.AHM_TEST_DATABASE_URL
it.skipIf(!databaseUrl)('discovers PostgreSQL computers with workspace isolation and the same status as individual reads', async () => {
  const schema = `ahm_discovery_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const app = createControlPlaneApp(new RunnerTransportService(new PostgresRunnerTransportRepository(pool), { serverUrl: 'https://example.com' }), new ProjectService(new InMemoryProjectRepository()))
  const headers = { 'x-ahm-organization-id': 'org', 'x-ahm-user-id': 'viewer' }
  try {
    await applyMigrations(pool)
    await pool.query(`INSERT INTO organizations VALUES ('org','Test',NOW()), ('foreign','Foreign',NOW());
      INSERT INTO users VALUES ('viewer','Viewer',NOW());
      INSERT INTO organization_memberships VALUES ('org','viewer','viewer',NOW()), ('foreign','viewer','viewer',NOW());
      INSERT INTO runner_devices (id,organization_id,label,credential_hash,status,enrolled_at) VALUES
        ('laptop','org','Laptop','private-laptop','active',NOW()), ('desktop','org','Desktop','private-desktop','active',NOW()), ('other','foreign','Other','private-other','active',NOW());
      INSERT INTO projects (id,organization_id,name,created_at,updated_at) VALUES ('project','org','Test',NOW(),NOW());
      INSERT INTO project_instances (id,organization_id,project_id,device_id,registered_at) VALUES ('instance','org','project','laptop',NOW());`)
    const response = await app.inject({ method: 'GET', url: '/api/v1/runners', headers })
    expect(response.statusCode).toBe(200)
    const runners = response.json<{ deviceId: string; projectInstances: unknown[] }[]>()
    expect(runners.map(runner => runner.deviceId)).toEqual(['desktop', 'laptop'])
    expect(runners.map(runner => runner.projectInstances.length)).toEqual([0, 1])
    for (const runner of runners) expect((await app.inject({ method: 'GET', url: `/api/v1/runners/${runner.deviceId}`, headers })).json()).toEqual(runner)
    expect(response.body).not.toContain('private-')
    expect((await app.inject({ method: 'GET', url: '/api/v1/runners', headers: { ...headers, 'x-ahm-organization-id': 'foreign' } })).json().map((runner: { deviceId: string }) => runner.deviceId)).toEqual(['other'])
    expect((await app.inject({ method: 'GET', url: '/api/v1/runners', headers: { ...headers, 'x-ahm-user-id': 'stranger' } })).statusCode).toBe(403)
  } finally { await app.close(); await pool.end(); await admin.end() }
}, 30_000)
