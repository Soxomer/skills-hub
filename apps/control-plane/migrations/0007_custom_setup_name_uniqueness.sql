BEGIN;

CREATE TABLE IF NOT EXISTS setup_name_claims (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, normalized_name)
);

INSERT INTO setup_name_claims (organization_id, normalized_name, claimed_at)
SELECT organization_id, LOWER(name), MIN(created_at)
FROM setups
GROUP BY organization_id, LOWER(name)
ON CONFLICT (organization_id, normalized_name) DO NOTHING;

INSERT INTO control_plane_schema_migrations (version, applied_at)
VALUES (7, '2026-09-08T00:00:00Z')
ON CONFLICT (version) DO NOTHING;

COMMIT;
