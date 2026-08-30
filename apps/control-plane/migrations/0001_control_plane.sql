BEGIN;

CREATE TABLE IF NOT EXISTS control_plane_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  repository_identity TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS setups (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('default', 'custom')),
  default_project_id TEXT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, name),
  UNIQUE (default_project_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, default_project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS setup_revisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  setup_id TEXT NOT NULL,
  revision_number BIGINT NOT NULL CHECK (revision_number > 0),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (setup_id, revision_number),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, setup_id)
    REFERENCES setups(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS setup_revision_items (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  setup_revision_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('skill', 'pluginSkill', 'localContent')),
  artifact_reference JSONB NOT NULL,
  tool_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  PRIMARY KEY (organization_id, setup_revision_id, artifact_id, tool_id, target_name),
  FOREIGN KEY (organization_id, setup_revision_id)
    REFERENCES setup_revisions(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_assignments (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  setup_revision_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, setup_revision_id)
    REFERENCES setup_revisions(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS runner_devices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  enrolled_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NULL,
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS project_instances (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NULL,
  UNIQUE (project_id, device_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id)
    REFERENCES runner_devices(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runner_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  project_instance_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL CHECK (protocol_version = '1.0'),
  idempotency_key TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('scanProject', 'planSetup', 'applyPlan', 'rollbackOperation')),
  payload JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'succeeded', 'failed', 'expired', 'cancelled')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NULL,
  UNIQUE (device_id, idempotency_key),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, device_id)
    REFERENCES runner_devices(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_instance_id)
    REFERENCES project_instances(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plan_approvals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_instance_id TEXT NOT NULL,
  setup_revision_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_by_job_id TEXT NULL,
  FOREIGN KEY (organization_id, project_instance_id)
    REFERENCES project_instances(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, setup_revision_id)
    REFERENCES setup_revisions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, consumed_by_job_id)
    REFERENCES runner_jobs(organization_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS operation_receipts (
  operation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  project_instance_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  setup_revision_id TEXT NULL,
  plan_digest TEXT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'rolledBack', 'noChange')),
  recoverability TEXT NOT NULL CHECK (recoverability IN ('notNeeded', 'rollbackAvailable', 'manualIntervention')),
  receipt JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (organization_id, device_id)
    REFERENCES runner_devices(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_instance_id)
    REFERENCES project_instances(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, job_id)
    REFERENCES runner_jobs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, setup_revision_id)
    REFERENCES setup_revisions(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  event_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_organization ON projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_setup_revisions_setup ON setup_revisions(setup_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_claim ON runner_jobs(device_id, state, issued_at);
CREATE INDEX IF NOT EXISTS idx_operation_receipts_instance ON operation_receipts(project_instance_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_organization ON audit_events(organization_id, created_at DESC);

INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (1, '2026-08-31T00:00:00Z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
