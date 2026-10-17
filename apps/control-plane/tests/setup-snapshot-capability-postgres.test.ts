import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import type { LibraryRequest, RunnerCapabilityReport } from '@ahm/contracts'
import { applyMigrations } from '../src/migrations.js'
import { PostgresRunnerTransportRepository } from '../src/runner-transport-pg.js'
import { RunnerTransportService } from '../src/runner-transport.js'

const databaseUrl = process.env.AHM_TEST_DATABASE_URL
const legacy: RunnerCapabilityReport = {
  protocolVersion: '1.0', supportedProtocolVersions: ['1.0'], runnerVersion: '0.10.0',
  capabilities: { library: true, scanProject: true, planSetup: true, applyPlan: true, rollbackOperation: true, supportedTools: ['codex'] },
}
const supported: RunnerCapabilityReport = { ...legacy, capabilities: { ...legacy.capabilities, setupSnapshots: true } }
const disabled: RunnerCapabilityReport = { ...legacy, capabilities: { ...legacy.capabilities, setupSnapshots: false } }

it.skipIf(!databaseUrl)('gates Setup snapshots and filters pending, leased and acknowledged jobs on PostgreSQL without losing durable work', async () => {
  const schema = `ahm_snapshot_capability_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  let now = new Date('2026-10-17T10:00:00Z')
  const service = new RunnerTransportService(new PostgresRunnerTransportRepository(pool), {
    serverUrl: 'http://127.0.0.1', now: () => now, leaseTtlMs: 1000,
  })
  const actor = { organizationId: 'org', userId: 'owner' }
  try {
    await applyMigrations(pool)
    await pool.query(`INSERT INTO organizations VALUES ('org','Snapshot test',NOW());
      INSERT INTO users VALUES ('owner','Owner',NOW());
      INSERT INTO organization_memberships VALUES ('org','owner','owner',NOW());`)
    for (const command of ['preview_setup_skill', 'snapshot_setup_skill'] as const) {
      for (const state of ['pending', 'leased', 'acknowledged'] as const) {
        const deviceId = `${command}_${state}`
        const credential = `disposable-${deviceId}`
        await pool.query(`INSERT INTO runner_devices (id,organization_id,label,credential_hash,status,enrolled_at,runner_version,supported_protocol_versions,capabilities)
          VALUES ($1,'org','Snapshot test',$2,'active',$3,'0.10.0','["1.0"]',$4::jsonb)`,
        [deviceId, createHash('sha256').update(credential).digest('hex'), now.toISOString(), JSON.stringify(legacy.capabilities)])
        const request: LibraryRequest = { command, args: { skillId: 'review' }, expectedDigest: command === 'snapshot_setup_skill' ? `sha256:${'a'.repeat(64)}` : null }
        for (const capabilities of [legacy, disabled]) {
          expect(await service.claimJob(credential, { capabilities })).toBeNull()
          await expect(service.enqueueLibrary(actor, deviceId, request)).rejects.toMatchObject({ statusCode: 409, code: 'setupSnapshotsUnsupported' })
          expect((await pool.query('SELECT id FROM runner_jobs WHERE device_id = $1', [deviceId])).rowCount).toBe(0)
        }
        await service.claimJob(credential, { capabilities: supported })
        const snapshot = await service.enqueueLibrary(actor, deviceId, request)
        let originalLease = null
        if (state !== 'pending') {
          originalLease = await service.claimJob(credential, { capabilities: supported })
          expect(originalLease?.job.jobId).toBe(snapshot.jobId)
          if (state === 'acknowledged') await service.acknowledgeJob(credential, snapshot.jobId, { leaseId: originalLease!.leaseId, requestDigest: `sha256:${'b'.repeat(64)}` })
        }
        const snapshotRow = async () => (await pool.query('SELECT * FROM runner_jobs WHERE id = $1', [snapshot.jobId])).rows[0]
        const before = await snapshotRow()
        expect(before.state).toBe(state)
        expect(await service.claimJob(credential, { capabilities: legacy })).toBeNull()
        expect(await snapshotRow()).toEqual(before)
        now = new Date(now.getTime() + 1)
        const ordinary = await service.enqueueLibrary(actor, deviceId, { command: 'list_directories', args: { parent: null }, expectedDigest: null })
        expect((await service.claimJob(credential, { capabilities: legacy }))?.job.jobId).toBe(ordinary.jobId)
        expect((await service.claimJob(credential, { capabilities: disabled }))?.job.jobId).toBe(ordinary.jobId)
        expect(await snapshotRow()).toEqual(before)
        if (originalLease) {
          const replay = await service.claimJob(credential, { capabilities: supported })
          expect(replay?.job.jobId).toBe(snapshot.jobId)
          expect(replay?.leaseId).toBe(originalLease.leaseId)
        }
        now = new Date(now.getTime() + 1001)
        const resumed = await service.claimJob(credential, { capabilities: supported })
        expect(resumed?.job.jobId).toBe(snapshot.jobId)
        expect((await snapshotRow()).attempt_count).toBe(state === 'pending' ? 1 : 2)
      }
    }
  } finally { await pool.end(); await admin.end() }
}, 30_000)
