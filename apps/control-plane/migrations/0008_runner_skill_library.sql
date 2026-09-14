BEGIN;
-- Read-only projection of the runner's library, not a second management authority.
ALTER TABLE runner_devices ADD COLUMN skill_library JSONB NULL;
COMMIT;
