BEGIN;

CREATE UNIQUE INDEX idx_setups_name_ci
ON setups (organization_id, LOWER(name));

INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (7, '2026-09-08T00:00:00Z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
