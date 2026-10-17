BEGIN;
CREATE TABLE setup_library_publications (
  organization_id TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  setup_revision_id TEXT NOT NULL,
  PRIMARY KEY (organization_id, source_job_id),
  FOREIGN KEY (organization_id, source_job_id) REFERENCES runner_jobs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, setup_revision_id) REFERENCES setup_revisions(organization_id, id) ON DELETE RESTRICT
);
INSERT INTO control_plane_schema_migrations (version, applied_at) VALUES (10, '2026-10-11T00:00:00Z');
COMMIT;
