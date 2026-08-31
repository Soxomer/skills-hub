BEGIN;

CREATE TABLE IF NOT EXISTS runner_enrollments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  code_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'claimed', 'expired')),
  claimed_device_id TEXT NULL REFERENCES runner_devices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ NULL
);

ALTER TABLE runner_devices
  ADD COLUMN runner_version TEXT NULL;
ALTER TABLE runner_devices
  ADD COLUMN supported_protocol_versions JSONB NULL;
ALTER TABLE runner_devices
  ADD COLUMN capabilities JSONB NULL;

ALTER TABLE runner_jobs
  ADD COLUMN lease_id TEXT NULL;
ALTER TABLE runner_jobs
  ADD COLUMN lease_expires_at TIMESTAMPTZ NULL;
ALTER TABLE runner_jobs
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE runner_jobs
  ADD COLUMN cancel_requested_at TIMESTAMPTZ NULL;
ALTER TABLE runner_jobs
  ADD COLUMN result_json JSONB NULL;
ALTER TABLE runner_jobs
  ADD COLUMN result_digest TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_jobs_lease
ON runner_jobs(lease_id) WHERE lease_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_devices_credential_hash
ON runner_devices(credential_hash);

CREATE INDEX IF NOT EXISTS idx_runner_enrollments_expiry
ON runner_enrollments(state, expires_at);

INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (2, '2026-09-01T00:00:00Z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
