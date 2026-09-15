BEGIN;
-- Read-only projection of the runner's library, not a second management authority.
ALTER TABLE runner_devices ADD COLUMN skill_library JSONB NULL;
INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (9, NOW());
COMMIT;
