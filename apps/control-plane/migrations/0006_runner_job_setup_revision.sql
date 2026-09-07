BEGIN;

ALTER TABLE runner_jobs
ADD COLUMN setup_revision_id TEXT;

UPDATE runner_jobs
SET setup_revision_id = payload->'revision'->>'setupRevisionId'
WHERE job_kind IN ('planSetup', 'applyPlan')
  AND payload->'revision'->>'setupRevisionId' IS NOT NULL;

CREATE INDEX idx_runner_jobs_setup_revision_history
ON runner_jobs(organization_id, project_instance_id, setup_revision_id, issued_at DESC)
WHERE job_kind = 'planSetup';

INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (6, '2026-09-08T00:00:00Z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
