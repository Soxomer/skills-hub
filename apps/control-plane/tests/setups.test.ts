import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

import { createControlPlaneApp } from '../src/http.js'
import { InMemoryProjectRepository } from '../src/projects-memory.js'
import { ProjectService } from '../src/projects.js'
import { InMemoryRunnerTransportRepository } from '../src/runner-transport-memory.js'
import { RunnerTransportService } from '../src/runner-transport.js'
import { InMemorySetupRepository } from '../src/setups-memory.js'
import { PostgresSetupRepository } from '../src/setups-pg.js'
import type { CreateSetupRecord } from '../src/setups.js'
import { SetupService } from '../src/setups.js'
import { PostgresSwitchingRepository } from '../src/switching-pg.js'
import { SwitchingService } from '../src/switching.js'

const actor = { organizationId: 'org_01', userId: 'user_01' }
const actorHeaders = {
  'x-ahm-organization-id': actor.organizationId,
  'x-ahm-user-id': actor.userId,
}
const migrationNames = [
  '0001_control_plane.sql',
  '0002_runner_transport.sql',
  '0003_default_capture.sql',
  '0004_runner_delivery.sql',
  '0005_project_operation_singleflight.sql',
  '0006_runner_job_setup_revision.sql',
  '0007_custom_setup_name_uniqueness.sql',
]

function baseItem() {
  return {
    sourceSetupRevisionId: 'revision_default_a',
    sourceSetupName: 'Default / Project A / project_a',
    sourceRevisionNumber: 1,
    artifactId: 'artifact_pdf',
    artifactKind: 'skill' as const,
    portableSource: 'github:openai/skills/pdf@v1',
    contentDigest: 'sha256:pdf',
    toolId: 'codex',
    targetName: 'pdf',
  }
}

function selection(overrides: Partial<ReturnType<typeof baseItem>> = {}) {
  const item = { ...baseItem(), ...overrides }
  return {
    sourceSetupRevisionId: item.sourceSetupRevisionId,
    artifactId: item.artifactId,
    contentDigest: item.contentDigest,
    toolId: item.toolId,
    targetName: item.targetName,
  }
}

function createRecord(
  createdBy: string,
  suffix: string,
): CreateSetupRecord {
  return {
    organizationId: actor.organizationId,
    createdBy,
    createdAt: '2026-09-08T12:00:00.000Z',
    setupId: `setup_${suffix}`,
    setupRevisionId: `revision_${suffix}`,
    auditEventId: `audit_${suffix}`,
    name: `${suffix} setup`,
    items: [selection()],
  }
}

async function postgresHarness() {
  const database = newDb({ autoCreateForeignKeyIndices: true })
  for (const migrationName of migrationNames) {
    const path = fileURLToPath(new URL(`../migrations/${migrationName}`, import.meta.url))
    database.public.none(readFileSync(path, 'utf8'))
  }
  const adapter = database.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool
  await pool.query(`
    INSERT INTO organizations (id, name, created_at)
    VALUES ('org_01', 'Example', '2026-09-08T10:00:00Z');
    INSERT INTO users (id, display_name, created_at)
    VALUES ('user_01', 'Owner', '2026-09-08T10:00:00Z');
    INSERT INTO organization_memberships (organization_id, user_id, role, created_at)
    VALUES ('org_01', 'user_01', 'owner', '2026-09-08T10:00:00Z');
    INSERT INTO projects (id, organization_id, name, created_at, updated_at)
    VALUES
      ('project_a', 'org_01', 'Project A', '2026-09-08T10:00:00Z', '2026-09-08T10:00:00Z'),
      ('project_b', 'org_01', 'Project B', '2026-09-08T10:00:00Z', '2026-09-08T10:00:00Z');
    INSERT INTO setups
      (id, organization_id, name, kind, default_project_id, created_by, created_at, updated_at)
    VALUES
      ('setup_default_a', 'org_01', 'Default / Project A / project_a', 'default',
       'project_a', 'user_01', '2026-09-08T10:00:00Z', '2026-09-08T10:00:00Z');
    INSERT INTO setup_revisions
      (id, organization_id, setup_id, revision_number, created_by, created_at)
    VALUES
      ('revision_default_a', 'org_01', 'setup_default_a', 1, 'user_01',
       '2026-09-08T10:00:00Z');
    INSERT INTO setup_revision_items
      (organization_id, setup_revision_id, artifact_id, artifact_kind,
       artifact_reference, tool_id, target_name)
    VALUES
      ('org_01', 'revision_default_a', 'artifact_pdf', 'skill',
       '{"portableSource":"github:openai/skills/pdf@v1","contentDigest":"sha256:pdf"}',
       'codex', 'pdf');
    INSERT INTO project_assignments
      (organization_id, project_id, setup_revision_id, assigned_by, assigned_at)
    VALUES
      ('org_01', 'project_a', 'revision_default_a', 'user_01', '2026-09-08T10:00:00Z');
  `)
  let sequence = 0
  const transport = new RunnerTransportService(new InMemoryRunnerTransportRepository(), {
    serverUrl: 'https://hub.example.test',
  })
  const setups = new SetupService(new PostgresSetupRepository(pool), {
    now: () => new Date('2026-09-08T12:00:00.000Z'),
    randomId: () => `created_${++sequence}`,
  })
  const app = createControlPlaneApp(
    transport,
    new ProjectService(new InMemoryProjectRepository()),
    new SwitchingService(new PostgresSwitchingRepository(pool), transport),
    setups,
  )
  return { app, pool }
}

describe('Setup creation API', () => {
  it('publishes one exact immutable revision to every project picker', async () => {
    const { app, pool } = await postgresHarness()
    const composer = await app.inject({
      method: 'GET',
      url: '/api/v1/setups/composer',
      headers: actorHeaders,
    })
    expect(composer.statusCode).toBe(200)
    expect(composer.json()).toEqual({ items: [baseItem()] })

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/setups',
      headers: actorHeaders,
      payload: { name: 'Team essentials', items: [selection()] },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      setupId: 'setup_created_1',
      setupRevisionId: 'revision_created_1',
      name: 'Team essentials',
      kind: 'custom',
      revisionNumber: 1,
      itemCount: 1,
    })

    for (const projectId of ['project_a', 'project_b']) {
      const picker = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/setup-revisions`,
        headers: actorHeaders,
      })
      expect(picker.statusCode).toBe(200)
      expect(picker.json().revisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            setupRevisionId: 'revision_created_1',
            name: 'Team essentials',
            kind: 'custom',
            itemCount: 1,
          }),
        ]),
      )
    }
    const stored = await pool.query<{
      artifact_kind: string
      artifact_reference: Record<string, unknown>
      tool_id: string
      target_name: string
    }>(
      `SELECT artifact_kind, artifact_reference, tool_id, target_name
       FROM setup_revision_items
       WHERE setup_revision_id = 'revision_created_1'`,
    )
    expect(stored.rows[0]).toEqual({
      artifact_kind: 'skill',
      artifact_reference: {
        portableSource: 'github:openai/skills/pdf@v1',
        contentDigest: 'sha256:pdf',
      },
      tool_id: 'codex',
      target_name: 'pdf',
    })
    const refreshedComposer = await app.inject({
      method: 'GET',
      url: '/api/v1/setups/composer',
      headers: actorHeaders,
    })
    expect(refreshedComposer.json()).toEqual({ items: [baseItem()] })
    await app.close()
    await pool.end()
  })

  it('rejects stale item references without creating partial state', async () => {
    const { app, pool } = await postgresHarness()
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/setups',
      headers: actorHeaders,
      payload: {
        name: 'Stale setup',
        items: [
          selection(),
          selection({
            artifactId: 'artifact_missing',
            contentDigest: 'sha256:outdated',
            toolId: 'claude-code',
            targetName: 'missing',
          }),
        ],
      },
    })
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({ code: 'setupItemUnavailable' })
    expect(
      (await pool.query(`SELECT id FROM setups WHERE kind = 'custom'`)).rowCount,
    ).toBe(0)
    expect(
      (
        await pool.query(
          `SELECT sr.id FROM setup_revisions sr
           JOIN setups s ON s.id = sr.setup_id
           WHERE s.kind = 'custom'`,
        )
      ).rowCount,
    ).toBe(0)
    expect(
      (await pool.query(`SELECT id FROM audit_events WHERE event_kind = 'setupRevisionCreated'`))
        .rowCount,
    ).toBe(0)
    expect(
      (
        await pool.query(
          `SELECT normalized_name FROM setup_name_claims
           WHERE organization_id = 'org_01' AND normalized_name = 'stale setup'`,
        )
      ).rowCount,
    ).toBe(0)
    await app.close()
    await pool.end()
  })

  it('enforces case-insensitive name uniqueness without orphan revisions', async () => {
    const { app, pool } = await postgresHarness()
    const results = []
    for (const name of ['Shared tools', 'shared TOOLS']) {
      results.push(
        await app.inject({
          method: 'POST',
          url: '/api/v1/setups',
          headers: actorHeaders,
          payload: { name, items: [selection()] },
        }),
      )
    }
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409])
    expect(results.find((result) => result.statusCode === 409)?.json()).toMatchObject({
      code: 'setupNameTaken',
    })
    expect(
      (await pool.query(`SELECT id FROM setups WHERE kind = 'custom'`)).rowCount,
    ).toBe(1)
    expect(
      (await pool.query(`SELECT sr.id FROM setup_revisions sr JOIN setups s ON s.id = sr.setup_id WHERE s.kind = 'custom'`))
        .rowCount,
    ).toBe(1)
    await app.close()
    await pool.end()
  })

  it('requires membership for reads and rejects viewer mutations', async () => {
    const { app, pool } = await postgresHarness()
    const nonmember = await app.inject({
      method: 'GET',
      url: '/api/v1/setups/composer',
      headers: {
        'x-ahm-organization-id': 'org_01',
        'x-ahm-user-id': 'user_outsider',
      },
    })
    expect(nonmember.statusCode).toBe(403)
    expect(nonmember.json()).toMatchObject({ code: 'setupAccessDenied' })

    await pool.query(`
      INSERT INTO users (id, display_name, created_at)
      VALUES ('user_viewer', 'Viewer', '2026-09-08T10:00:00Z');
      INSERT INTO organization_memberships (organization_id, user_id, role, created_at)
      VALUES ('org_01', 'user_viewer', 'viewer', '2026-09-08T10:00:00Z');
    `)
    const viewerRead = await app.inject({
      method: 'GET',
      url: '/api/v1/setups/composer',
      headers: {
        'x-ahm-organization-id': 'org_01',
        'x-ahm-user-id': 'user_viewer',
      },
    })
    expect(viewerRead.statusCode).toBe(200)
    const viewerCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/setups',
      headers: {
        'x-ahm-organization-id': 'org_01',
        'x-ahm-user-id': 'user_viewer',
      },
      payload: { name: 'Viewer setup', items: [selection()] },
    })
    expect(viewerCreate.statusCode).toBe(403)
    expect(viewerCreate.json()).toMatchObject({ code: 'setupMutationForbidden' })
    expect(
      (await pool.query(`SELECT id FROM setups WHERE kind = 'custom'`)).rowCount,
    ).toBe(0)
    await app.close()
    await pool.end()
  })

  it('enforces authorization inside repository transactions', async () => {
    const { app, pool } = await postgresHarness()
    await pool.query(`
      INSERT INTO users (id, display_name, created_at)
      VALUES ('user_viewer', 'Viewer', '2026-09-08T10:00:00Z');
      INSERT INTO organization_memberships (organization_id, user_id, role, created_at)
      VALUES ('org_01', 'user_viewer', 'viewer', '2026-09-08T10:00:00Z');
    `)
    const repository = new PostgresSetupRepository(pool)
    await expect(repository.readComposer('org_01', 'user_outsider')).resolves.toEqual({
      outcome: 'accessDenied',
    })
    await expect(repository.createSetup(createRecord('user_outsider', 'outsider'))).resolves.toEqual(
      { outcome: 'accessDenied' },
    )
    await expect(repository.createSetup(createRecord('user_viewer', 'viewer'))).resolves.toEqual({
      outcome: 'mutationForbidden',
    })
    expect((await pool.query(`SELECT id FROM setups WHERE kind = 'custom'`)).rowCount).toBe(0)
    await app.close()
    await pool.end()
  })

  it('rejects a custom name that collides with an existing Default Setup', async () => {
    const { app, pool } = await postgresHarness()
    for (const name of [
      'Default / Project A / project_a',
      'DEFAULT / PROJECT A / PROJECT_A',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/setups',
        headers: actorHeaders,
        payload: { name, items: [selection()] },
      })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ code: 'setupNameTaken' })
    }
    expect((await pool.query(`SELECT id FROM setups WHERE kind = 'custom'`)).rowCount).toBe(0)
    await app.close()
    await pool.end()
  })
})

describe('Setup service validation and memory persistence', () => {
  it('rejects duplicate destinations and deduplicates copied capabilities', async () => {
    const repository = new InMemorySetupRepository()
    repository.seedMembership(actor.organizationId, actor.userId, 'owner')
    repository.seedComposerItems(actor.organizationId, [baseItem()])
    const service = new SetupService(repository, {
      now: () => new Date('2026-09-08T12:00:00.000Z'),
      randomId: () => 'memory_01',
    })
    await expect(
      service.createSetup(actor, {
        name: 'Invalid',
        items: [
          selection(),
          selection({ artifactId: 'artifact_other', contentDigest: 'sha256:other' }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalidSetupItems' })

    await service.createSetup(actor, { name: 'Reusable', items: [selection()] })
    expect((await service.composer(actor)).items).toEqual([baseItem()])
    await expect(
      service.createSetup(actor, { name: 'reUSABLE', items: [selection()] }),
    ).rejects.toMatchObject({ code: 'setupNameTaken' })
  })

  it('allows writers and keeps viewers and outsiders read-only', async () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const repository = new InMemorySetupRepository()
      const userId = `user_${role}`
      repository.seedMembership(actor.organizationId, userId, role)
      repository.seedComposerItems(actor.organizationId, [baseItem()])
      const service = new SetupService(repository, { randomId: () => role })
      await expect(
        service.createSetup(
          { organizationId: actor.organizationId, userId },
          { name: `${role} setup`, items: [selection()] },
        ),
      ).resolves.toMatchObject({ kind: 'custom', revisionNumber: 1 })
    }

    const repository = new InMemorySetupRepository()
    repository.seedMembership(actor.organizationId, 'user_viewer', 'viewer')
    repository.seedComposerItems(actor.organizationId, [baseItem()])
    const service = new SetupService(repository)
    await expect(
      service.composer({ organizationId: actor.organizationId, userId: 'user_viewer' }),
    ).resolves.toEqual({ items: [baseItem()] })
    await expect(
      service.createSetup(
        { organizationId: actor.organizationId, userId: 'user_viewer' },
        { name: 'Blocked', items: [selection()] },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'setupMutationForbidden' })
    await expect(
      service.composer({ organizationId: actor.organizationId, userId: 'user_outsider' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'setupAccessDenied' })
  })

  it('allows only one concurrent case-insensitive name claim', async () => {
    const repository = new InMemorySetupRepository()
    repository.seedMembership(actor.organizationId, actor.userId, 'owner')
    repository.seedComposerItems(actor.organizationId, [baseItem()])
    let sequence = 0
    const service = new SetupService(repository, { randomId: () => `concurrent_${++sequence}` })
    const results = await Promise.allSettled(
      ['Shared tools', 'shared TOOLS'].map((name) =>
        service.createSetup(actor, { name, items: [selection()] }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { statusCode: 409, code: 'setupNameTaken' },
    })
  })
})
