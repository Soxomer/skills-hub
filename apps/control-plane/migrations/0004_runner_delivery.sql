BEGIN;

ALTER TABLE runner_jobs
  DROP CONSTRAINT IF EXISTS runner_jobs_state_check;
ALTER TABLE runner_jobs
  ADD CONSTRAINT runner_jobs_state_check
  CHECK (state IN ('pending', 'leased', 'acknowledged', 'succeeded', 'failed', 'expired', 'cancelled'));
ALTER TABLE runner_jobs
  ADD COLUMN request_digest TEXT NULL;
ALTER TABLE runner_jobs
  ADD COLUMN acknowledged_at TIMESTAMPTZ NULL;

ALTER TABLE plan_approvals
  ADD COLUMN source_plan_job_id TEXT NULL;
ALTER TABLE plan_approvals
  ADD CONSTRAINT plan_approvals_source_plan_job_fk
  FOREIGN KEY (organization_id, source_plan_job_id)
  REFERENCES runner_jobs(organization_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_approvals_source_plan_job
ON plan_approvals(organization_id, source_plan_job_id)
WHERE source_plan_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS artifact_bundles (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content_digest TEXT NOT NULL,
  bundle JSONB NOT NULL,
  uploaded_by_device_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, content_digest),
  FOREIGN KEY (organization_id, uploaded_by_device_id)
    REFERENCES runner_devices(organization_id, id) ON DELETE CASCADE
);

INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (4, '2026-09-02T00:00:00Z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
