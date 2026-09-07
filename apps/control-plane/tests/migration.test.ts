import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { newDb } from 'pg-mem'
import { describe, expect, it } from 'vitest'

const firstMigrationPath = fileURLToPath(
  new URL('../migrations/0001_control_plane.sql', import.meta.url),
)
const secondMigrationPath = fileURLToPath(
  new URL('../migrations/0002_runner_transport.sql', import.meta.url),
)
const thirdMigrationPath = fileURLToPath(
  new URL('../migrations/0003_default_capture.sql', import.meta.url),
)
const fourthMigrationPath = fileURLToPath(
  new URL('../migrations/0004_runner_delivery.sql', import.meta.url),
)
const fifthMigrationPath = fileURLToPath(
  new URL('../migrations/0005_project_operation_singleflight.sql', import.meta.url),
)
const migrations = [
  firstMigrationPath,
  secondMigrationPath,
  thirdMigrationPath,
  fourthMigrationPath,
  fifthMigrationPath,
].map((path) => readFileSync(path, 'utf8'))

function createMigratedDatabase() {
  const database = newDb({ autoCreateForeignKeyIndices: true })
  for (const migration of migrations) database.public.none(migration)
  return database
}

describe('control-plane migration', () => {
  it('creates only organization-visible control-plane tables', () => {
    const database = createMigratedDatabase()
    const tables = database.public
      .many<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      )
      .map((row) => row.table_name)

    expect(tables).toEqual([
      'artifact_bundles',
      'audit_events',
      'control_plane_schema_migrations',
      'operation_receipts',
      'organization_memberships',
      'organizations',
      'plan_approvals',
      'project_assignments',
      'project_instances',
      'projects',
      'runner_devices',
      'runner_enrollments',
      'runner_jobs',
      'setup_revision_items',
      'setup_revisions',
      'setups',
      'users',
    ])
  })

  it('stores no machine-local path column', () => {
    const database = createMigratedDatabase()
    const pathColumns = database.public.many<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name LIKE '%path%'",
    )

    expect(pathColumns).toEqual([])
  })

  it('migrates independent databases to the same version', () => {
    for (const database of [createMigratedDatabase(), createMigratedDatabase()]) {
      expect(
        database.public.one<{ version: number }>(
          'SELECT MAX(version) AS version FROM control_plane_schema_migrations',
        ).version,
      ).toBe(5)
    }
  })

  it('enforces one active Setup operation per project instance', () => {
    const database = createMigratedDatabase()
    database.public.none(`
      INSERT INTO organizations (id, name, created_at)
      VALUES ('org_01', 'Example', '2026-09-05T00:00:00Z');
      INSERT INTO projects (id, organization_id, name, created_at, updated_at)
      VALUES ('project_01', 'org_01', 'Project', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z');
      INSERT INTO runner_devices
        (id, organization_id, label, credential_hash, status, enrolled_at)
      VALUES ('device_01', 'org_01', 'Runner', 'secret', 'active', '2026-09-05T00:00:00Z');
      INSERT INTO project_instances
        (id, organization_id, project_id, device_id, registered_at)
      VALUES ('instance_01', 'org_01', 'project_01', 'device_01', '2026-09-05T00:00:00Z');
      INSERT INTO runner_jobs
        (id, organization_id, device_id, project_instance_id, protocol_version,
         idempotency_key, job_kind, payload, state, issued_at, expires_at)
      VALUES
        ('plan_01', 'org_01', 'device_01', 'instance_01', '1.0', 'plan-01',
         'planSetup', '{}', 'pending', '2026-09-05T00:00:00Z', '2026-09-05T00:05:00Z');
      INSERT INTO runner_jobs
        (id, organization_id, device_id, project_instance_id, protocol_version,
         idempotency_key, job_kind, payload, state, issued_at, expires_at)
      VALUES
        ('scan_01', 'org_01', 'device_01', 'instance_01', '1.0', 'scan-01',
         'scanProject', '{}', 'pending', '2026-09-05T00:00:00Z', '2026-09-05T00:05:00Z');
    `)

    expect(() =>
      database.public.none(`
        INSERT INTO runner_jobs
          (id, organization_id, device_id, project_instance_id, protocol_version,
           idempotency_key, job_kind, payload, state, issued_at, expires_at)
        VALUES
          ('apply_01', 'org_01', 'device_01', 'instance_01', '1.0', 'apply-01',
           'applyPlan', '{}', 'pending', '2026-09-05T00:00:01Z', '2026-09-05T00:00:31Z');
      `),
    ).toThrow()
  })

  it('persists a portable Setup assignment without a checkout location', () => {
    const database = createMigratedDatabase()
    database.public.none(`
      INSERT INTO organizations (id, name, created_at)
      VALUES ('org_01', 'Example', '2026-08-31T00:00:00Z');
      INSERT INTO users (id, display_name, created_at)
      VALUES ('user_01', 'Owner', '2026-08-31T00:00:00Z');
      INSERT INTO organization_memberships (organization_id, user_id, role, created_at)
      VALUES ('org_01', 'user_01', 'owner', '2026-08-31T00:00:00Z');
      INSERT INTO projects (id, organization_id, name, repository_identity, created_at, updated_at)
      VALUES ('project_01', 'org_01', 'Project', 'github:example/project', '2026-08-31T00:00:00Z', '2026-08-31T00:00:00Z');
      INSERT INTO setups (id, organization_id, name, kind, default_project_id, created_by, created_at, updated_at)
      VALUES ('setup_01', 'org_01', 'Default', 'default', 'project_01', 'user_01', '2026-08-31T00:00:00Z', '2026-08-31T00:00:00Z');
      INSERT INTO setup_revisions (id, organization_id, setup_id, revision_number, created_by, created_at)
      VALUES ('setup_revision_01', 'org_01', 'setup_01', 1, 'user_01', '2026-08-31T00:00:00Z');
      INSERT INTO setup_revision_items (organization_id, setup_revision_id, artifact_id, artifact_kind, artifact_reference, tool_id, target_name)
      VALUES ('org_01', 'setup_revision_01', 'artifact_01', 'skill', '{"source":"github:openai/skills/pdf@v1"}', 'codex', 'pdf');
      INSERT INTO project_assignments (organization_id, project_id, setup_revision_id, assigned_by, assigned_at)
      VALUES ('org_01', 'project_01', 'setup_revision_01', 'user_01', '2026-08-31T00:00:00Z');
    `)

    expect(
      database.public.one<{ setup_revision_id: string }>(
        "SELECT setup_revision_id FROM project_assignments WHERE project_id = 'project_01'",
      ).setup_revision_id,
    ).toBe('setup_revision_01')
  })

  it('rejects assigning a Setup revision across organization boundaries', () => {
    const database = createMigratedDatabase()
    database.public.none(`
      INSERT INTO organizations (id, name, created_at)
      VALUES
        ('org_01', 'First', '2026-08-31T00:00:00Z'),
        ('org_02', 'Second', '2026-08-31T00:00:00Z');
      INSERT INTO users (id, display_name, created_at)
      VALUES ('user_01', 'Owner', '2026-08-31T00:00:00Z');
      INSERT INTO projects (id, organization_id, name, created_at, updated_at)
      VALUES ('project_01', 'org_01', 'Project', '2026-08-31T00:00:00Z', '2026-08-31T00:00:00Z');
      INSERT INTO setups (id, organization_id, name, kind, created_by, created_at, updated_at)
      VALUES ('setup_02', 'org_02', 'Other Setup', 'custom', 'user_01', '2026-08-31T00:00:00Z', '2026-08-31T00:00:00Z');
      INSERT INTO setup_revisions (id, organization_id, setup_id, revision_number, created_by, created_at)
      VALUES ('setup_revision_02', 'org_02', 'setup_02', 1, 'user_01', '2026-08-31T00:00:00Z');
    `)

    expect(() =>
      database.public.none(`
        INSERT INTO project_assignments (organization_id, project_id, setup_revision_id, assigned_by, assigned_at)
        VALUES ('org_01', 'project_01', 'setup_revision_02', 'user_01', '2026-08-31T00:00:00Z');
      `),
    ).toThrow()
  })
})
