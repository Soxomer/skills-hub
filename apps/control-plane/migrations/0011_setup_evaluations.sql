BEGIN;
ALTER TABLE runner_jobs DROP CONSTRAINT runner_jobs_job_kind_check;
ALTER TABLE runner_jobs ADD CONSTRAINT runner_jobs_job_kind_check
  CHECK (job_kind IN ('scanProject', 'planSetup', 'applyPlan', 'rollbackOperation', 'libraryAction', 'evaluateSetups'));
ALTER TABLE runner_jobs DROP CONSTRAINT runner_jobs_check;
ALTER TABLE runner_jobs ADD CONSTRAINT runner_jobs_check
  CHECK ((job_kind IN ('libraryAction', 'evaluateSetups')) = (project_instance_id IS NULL));
CREATE INDEX idx_runner_jobs_evaluation_candidate ON runner_jobs
  (organization_id, (payload->'candidate'->>'setupRevisionId'), issued_at DESC)
  WHERE job_kind = 'evaluateSetups';
INSERT INTO control_plane_schema_migrations (version, applied_at) VALUES (11, '2026-10-15T00:00:00Z');
COMMIT;
