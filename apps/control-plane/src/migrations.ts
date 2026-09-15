import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'

export const migrationFiles = [
  '0001_control_plane.sql',
  '0002_runner_transport.sql',
  '0003_default_capture.sql',
  '0004_runner_delivery.sql',
  '0005_project_operation_singleflight.sql',
  '0006_runner_job_setup_revision.sql',
  '0007_custom_setup_name_uniqueness.sql',
  '0008_better_auth.sql',
  '0009_runner_skill_library.sql',
] as const

export async function applyMigrations(pool: Pool): Promise<void> {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'control_plane_schema_migrations') AS exists`,
  )
  const applied = new Set<number>()
  if (exists.rows[0]?.exists) {
    const versions = await pool.query<{ version: number }>('SELECT version FROM control_plane_schema_migrations')
    for (const row of versions.rows) applied.add(row.version)
  }
  for (const name of migrationFiles) {
    const version = Number(name.slice(0, 4))
    if (applied.has(version)) continue
    await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
  }
}
