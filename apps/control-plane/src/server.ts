import { Pool } from 'pg'

import { createControlPlaneApp } from './http.js'
import { PostgresRunnerTransportRepository } from './runner-transport-pg.js'
import { RunnerTransportService } from './runner-transport.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const port = Number(process.env.PORT ?? '8787')
const host = process.env.HOST ?? '127.0.0.1'
const serverUrl = process.env.PUBLIC_SERVER_URL ?? `http://${host}:${port}`
const pool = new Pool({ connectionString: databaseUrl })
const repository = new PostgresRunnerTransportRepository(pool)
const service = new RunnerTransportService(repository, { serverUrl })
const app = createControlPlaneApp(service)

const close = async () => {
  await app.close()
  await pool.end()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())

await app.listen({ host, port })
