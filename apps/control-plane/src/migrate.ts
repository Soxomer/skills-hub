import { readFile } from 'node:fs/promises'

import { Pool } from 'pg'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const pool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'control_plane_schema_migrations'
     ) AS exists`,
  )
  const applied = new Set<number>()
  if (exists.rows[0]?.exists) {
    const versions = await pool.query<{ version: number }>(
      `SELECT version FROM control_plane_schema_migrations`,
    )
    for (const row of versions.rows) applied.add(row.version)
  }

  for (const [version, name] of [
    [1, '0001_control_plane.sql'],
    [2, '0002_runner_transport.sql'],
    [3, '0003_default_capture.sql'],
    [4, '0004_runner_delivery.sql'],
  ] as const) {
    if (applied.has(version)) continue
    const url = new URL(`../migrations/${name}`, import.meta.url)
    await pool.query(await readFile(url, 'utf8'))
  }
} finally {
  await pool.end()
}
