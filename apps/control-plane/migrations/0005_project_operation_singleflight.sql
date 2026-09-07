BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_jobs_active_setup_operation
ON runner_jobs(organization_id, project_instance_id)
WHERE job_kind IN ('planSetup', 'applyPlan', 'rollbackOperation')
  AND state IN ('pending', 'leased', 'acknowledged');

INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (5, '2026-09-05T00:00:00Z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
