BEGIN;

UPDATE setups
SET name = setups.name || ' [duplicate · ' || setups.id || ']'
FROM setups AS preferred
WHERE setups.kind = 'custom'
  AND preferred.organization_id = setups.organization_id
  AND preferred.kind = 'custom'
  AND LOWER(preferred.name) = LOWER(setups.name)
  AND (
    preferred.created_at < setups.created_at
    OR (preferred.created_at = setups.created_at AND preferred.id < setups.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_setups_custom_name_ci
ON setups (organization_id, LOWER(name))
WHERE kind = 'custom';

INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (7, '2026-09-08T00:00:00Z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
