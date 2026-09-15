import { Pool } from 'pg'
import { requireDevelopmentLoopback } from './development-auth.js'
import { hostedAuthConfig, createHostedAuth, createHostedAuthenticator, ensurePrivateWorkspace, registerHostedAuth } from './hosted-auth.js'

import { createControlPlaneApp } from './http.js'
import { PostgresProjectRepository } from './projects-pg.js'
import { ProjectService } from './projects.js'
import { PostgresRunnerTransportRepository } from './runner-transport-pg.js'
import { RunnerTransportService } from './runner-transport.js'
import { PostgresSwitchingRepository } from './switching-pg.js'
import { SwitchingService } from './switching.js'
import { PostgresSetupRepository } from './setups-pg.js'
import { SetupService } from './setups.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const port = Number(process.env.PORT ?? '8787')
const host = process.env.HOST ?? '127.0.0.1'
const auth = hostedAuthConfig(process.env)
if (!auth) requireDevelopmentLoopback(host)
const serverUrl = process.env.PUBLIC_SERVER_URL ?? `http://${host}:${port}`
const pool = new Pool({ connectionString: databaseUrl })
if (auth) await ensurePrivateWorkspace(pool, auth)
const sessions = auth ? createHostedAuth(pool, auth) : undefined
const transportRepository = new PostgresRunnerTransportRepository(pool)
const transport = new RunnerTransportService(transportRepository, { serverUrl })
const projectRepository = new PostgresProjectRepository(pool)
const projects = new ProjectService(projectRepository)
const switching = new SwitchingService(new PostgresSwitchingRepository(pool), transport)
const setups = new SetupService(new PostgresSetupRepository(pool))
const app = createControlPlaneApp(transport, projects, switching, setups,
  auth && sessions ? createHostedAuthenticator(auth, sessions) : undefined)
if (auth && sessions) registerHostedAuth(app, sessions, auth)

const close = async () => {
  await app.close()
  await pool.end()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())

await app.listen({ host, port })
