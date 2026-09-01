BEGIN;

ALTER TABLE setup_revisions
  ADD COLUMN source_scan_job_id TEXT NULL;

ALTER TABLE setup_revisions
  ADD CONSTRAINT setup_revisions_source_scan_job_fk
  FOREIGN KEY (organization_id, source_scan_job_id)
  REFERENCES runner_jobs(organization_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_setup_revisions_source_scan_job
ON setup_revisions(organization_id, source_scan_job_id)
WHERE source_scan_job_id IS NOT NULL;

INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (3, '2026-09-01T00:00:00Z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
