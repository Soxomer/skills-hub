import { Pool } from 'pg'
import { applyMigrations } from './migrations.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try { await applyMigrations(pool) }
finally { await pool.end() }
