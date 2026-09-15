import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { applyMigrations, migrationFiles } from '../src/migrations.js'

it('registers every shipped SQL migration exactly once with a unique version', async () => {
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()
  expect([...migrationFiles]).toEqual(files)
  expect(new Set(files.map(name => Number(name.slice(0, 4)))).size).toBe(files.length)
})

const databaseUrl = process.env.AHM_TEST_DATABASE_URL
it.skipIf(!databaseUrl).each(['fresh', 'existing version 8'])('runs production startup migrations on %s and survives restart', async (initialState) => {
  const schema = `ahm_startup_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 })
  try {
    if (initialState === 'existing version 8') {
      for (const name of migrationFiles.slice(0, 8)) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
    }
    await applyMigrations(pool)
    await pool.query('SELECT skill_library FROM runner_devices LIMIT 0')
    const before = await pool.query('SELECT version, applied_at FROM control_plane_schema_migrations ORDER BY version')
    expect(before.rows.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    await applyMigrations(pool)
    expect((await pool.query('SELECT version, applied_at FROM control_plane_schema_migrations ORDER BY version')).rows).toEqual(before.rows)
  } finally { await pool.end(); await admin.end() }
})
