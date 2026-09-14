use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};

// Schema versioning: bump when making changes and add a migration step.
const SCHEMA_VERSION: i32 = 11;

// Minimal schema for MVP: skills, skill_targets, settings, discovered_skills(optional).
const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NULL,
  source_revision TEXT NULL,
  central_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sync_at INTEGER NULL,
  last_seen_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_targets (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  project_path TEXT NULL,
  target_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT NULL,
  synced_at INTEGER NULL,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_targets_unique_scope
ON skill_targets(skill_id, tool, scope, COALESCE(project_path, ''));

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovered_skills (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  found_path TEXT NOT NULL,
  name_guess TEXT NULL,
  fingerprint TEXT NULL,
  found_at INTEGER NOT NULL,
  imported_skill_id TEXT NULL,
  FOREIGN KEY(imported_skill_id) REFERENCES skills(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills(updated_at);

CREATE TABLE IF NOT EXISTS skill_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_tag_links (
  skill_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (skill_id, tag_id),
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES skill_tags(id) ON DELETE CASCADE
);
"#;

#[derive(Clone, Debug)]
pub struct SkillStore {
    db_path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct SkillRecord {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub source_subpath: Option<String>,
    pub source_revision: Option<String>,
    pub central_path: String,
    pub content_hash: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_sync_at: Option<i64>,
    pub last_seen_at: i64,
    pub enabled: bool,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct SkillTargetRecord {
    pub id: String,
    pub skill_id: String,
    pub tool: String,
    pub scope: String,
    pub project_path: Option<String>,
    pub target_path: String,
    pub mode: String,
    pub status: String,
    pub last_error: Option<String>,
    pub synced_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagRecord {
    pub id: i64,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagWithCountRecord {
    pub id: i64,
    pub name: String,
    pub skill_count: i64,
    pub updated_at: i64,
}

impl SkillStore {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    #[allow(dead_code)]
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn ensure_schema(&self) -> Result<()> {
        self.with_conn(|conn| {
            conn.busy_timeout(Duration::from_secs(10))?;
            // Worker startup and CLI registration may initialize the same file.
            // Acquire the writer lock before reading its version, and roll back
            // all schema changes if any migration fails.
            let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
                .context("failed to lock database schema initialization")?;

            let user_version: i32 = conn.query_row("PRAGMA user_version;", [], |row| row.get(0))?;
            if user_version == 0 {
                conn.execute_batch(SCHEMA_V1)?;
                // V2: add description column
                conn.execute_batch("ALTER TABLE skills ADD COLUMN description TEXT NULL;")?;
                // V3: add source_subpath column
                conn.execute_batch("ALTER TABLE skills ADD COLUMN source_subpath TEXT NULL;")?;
                migrate_skill_targets_to_v4(conn)?;
                migrate_setups_to_v8(conn, false)?;
                migrate_default_setup_to_v9(conn)?;
                migrate_project_defaults_to_v10(conn)?;
                migrate_filesystem_recovery_to_v11(conn)?;
                conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            } else if user_version < SCHEMA_VERSION {
                // Incremental migrations
                if user_version < 2 {
                    conn.execute_batch("ALTER TABLE skills ADD COLUMN description TEXT NULL;")?;
                }
                if user_version < 3 {
                    conn.execute_batch("ALTER TABLE skills ADD COLUMN source_subpath TEXT NULL;")?;
                }
                if user_version < 4 {
                    migrate_skill_targets_to_v4(conn)?;
                }
                if user_version < 5 {
                    migrate_tags_to_v5(conn)?;
                }
                if user_version < 6 {
                    migrate_skill_enabled_to_v6(conn)?;
                }
                if user_version < 8 {
                    migrate_setups_to_v8(conn, user_version == 7)?;
                }
                if user_version < 9 {
                    migrate_default_setup_to_v9(conn)?;
                }
                if user_version < 10 {
                    migrate_project_defaults_to_v10(conn)?;
                }
                if user_version < 11 {
                    migrate_filesystem_recovery_to_v11(conn)?;
                }
                conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            } else if user_version > SCHEMA_VERSION {
                anyhow::bail!(
                    "database schema version {} is newer than app supports {}",
                    user_version,
                    SCHEMA_VERSION
                );
            }

            transaction
                .commit()
                .context("failed to commit database schema initialization")
        })
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
            let mut rows = stmt.query(params![key])?;
            Ok(rows
                .next()?
                .map(|row| row.get::<_, String>(0))
                .transpose()?)
        })
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }

    #[allow(dead_code)]
    pub fn set_onboarding_completed(&self, completed: bool) -> Result<()> {
        self.set_setting(
            "onboarding_completed",
            if completed { "true" } else { "false" },
        )
    }

    pub fn upsert_skill(&self, record: &SkillRecord) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO skills (
          id, name, description, source_type, source_ref, source_subpath, source_revision, central_path, content_hash,
          created_at, updated_at, last_sync_at, last_seen_at, enabled, status
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
          ?10, ?11, ?12, ?13, ?14, ?15
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          source_type = excluded.source_type,
          source_ref = excluded.source_ref,
          source_subpath = excluded.source_subpath,
          source_revision = excluded.source_revision,
          central_path = excluded.central_path,
          content_hash = excluded.content_hash,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_sync_at = excluded.last_sync_at,
          last_seen_at = excluded.last_seen_at,
          enabled = excluded.enabled,
          status = excluded.status",
                params![
                    record.id,
                    record.name,
                    record.description,
                    record.source_type,
                    record.source_ref,
                    record.source_subpath,
                    record.source_revision,
                    record.central_path,
                    record.content_hash,
                    record.created_at,
                    record.updated_at,
                    record.last_sync_at,
                    record.last_seen_at,
                    record.enabled as i32,
                    record.status
                ],
            )?;
            Ok(())
        })
    }

    pub fn upsert_skill_target(&self, record: &SkillTargetRecord) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO skill_targets (
          id, skill_id, tool, scope, project_path, target_path, mode, status, last_error, synced_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
        )
        ON CONFLICT DO UPDATE SET
          target_path = excluded.target_path,
          mode = excluded.mode,
          status = excluded.status,
          last_error = excluded.last_error,
          synced_at = excluded.synced_at",
                params![
                    record.id,
                    record.skill_id,
                    record.tool,
                    record.scope,
                    record.project_path,
                    record.target_path,
                    record.mode,
                    record.status,
                    record.last_error,
                    record.synced_at
                ],
            )?;
            Ok(())
        })
    }

    pub fn list_skills(&self) -> Result<Vec<SkillRecord>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
        "SELECT id, name, description, source_type, source_ref, source_subpath, source_revision, central_path, content_hash,
                created_at, updated_at, last_sync_at, last_seen_at, enabled, status
         FROM skills
         ORDER BY updated_at DESC",
      )?;
            let rows = stmt.query_map([], |row| {
                Ok(SkillRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    source_type: row.get(3)?,
                    source_ref: row.get(4)?,
                    source_subpath: row.get(5)?,
                    source_revision: row.get(6)?,
                    central_path: row.get(7)?,
                    content_hash: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    last_sync_at: row.get(11)?,
                    last_seen_at: row.get(12)?,
                    enabled: row.get::<_, i32>(13)? != 0,
                    status: row.get(14)?,
                })
            })?;

            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            Ok(items)
        })
    }

    pub fn get_skill_by_id(&self, skill_id: &str) -> Result<Option<SkillRecord>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
        "SELECT id, name, description, source_type, source_ref, source_subpath, source_revision, central_path, content_hash,
                created_at, updated_at, last_sync_at, last_seen_at, enabled, status
         FROM skills
         WHERE id = ?1
         LIMIT 1",
      )?;
            let mut rows = stmt.query(params![skill_id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(SkillRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    source_type: row.get(3)?,
                    source_ref: row.get(4)?,
                    source_subpath: row.get(5)?,
                    source_revision: row.get(6)?,
                    central_path: row.get(7)?,
                    content_hash: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    last_sync_at: row.get(11)?,
                    last_seen_at: row.get(12)?,
                    enabled: row.get::<_, i32>(13)? != 0,
                    status: row.get(14)?,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn update_skill_description(
        &self,
        skill_id: &str,
        description: Option<&str>,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE skills SET description = ?1 WHERE id = ?2",
                params![description, skill_id],
            )?;
            Ok(())
        })
    }

    pub fn set_skill_enabled(&self, skill_id: &str, enabled: bool) -> Result<()> {
        self.with_conn(|conn| {
            let changed = conn.execute(
                "UPDATE skills SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
                params![enabled as i32, now_ms(), skill_id],
            )?;
            if changed == 0 {
                anyhow::bail!("skill not found: {}", skill_id);
            }
            Ok(())
        })
    }

    pub fn delete_skill(&self, skill_id: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM skills WHERE id = ?1", params![skill_id])?;
            Ok(())
        })
    }

    pub fn create_tag(&self, name: &str) -> Result<TagRecord> {
        let normalized = normalize_tag_name(name)?;
        self.with_conn(|conn| {
            let now = now_ms();
            conn.execute(
                "INSERT INTO skill_tags (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
                params![normalized, now],
            )
            .with_context(|| format!("tag already exists: {}", normalized))?;
            let id = conn.last_insert_rowid();
            Ok(TagRecord {
                id,
                name: normalized,
            })
        })
    }

    pub fn rename_tag(&self, tag_id: i64, name: &str) -> Result<TagRecord> {
        let normalized = normalize_tag_name(name)?;
        self.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE skill_tags SET name = ?1, updated_at = ?2 WHERE id = ?3",
                    params![normalized, now_ms(), tag_id],
                )
                .with_context(|| format!("tag already exists: {}", normalized))?;
            if changed == 0 {
                anyhow::bail!("tag not found: {}", tag_id);
            }
            Ok(TagRecord {
                id: tag_id,
                name: normalized,
            })
        })
    }

    pub fn delete_tag(&self, tag_id: i64) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM skill_tags WHERE id = ?1", params![tag_id])?;
            Ok(())
        })
    }

    pub fn list_tags_with_counts(&self) -> Result<Vec<TagWithCountRecord>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT t.id, t.name, COUNT(l.skill_id) AS skill_count,
                        COALESCE(MAX(l.created_at), t.updated_at) AS last_used_at
                 FROM skill_tags t
                 LEFT JOIN skill_tag_links l ON l.tag_id = t.id
                 GROUP BY t.id, t.name, t.updated_at
                 ORDER BY LOWER(t.name) ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(TagWithCountRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    skill_count: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?;

            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            Ok(items)
        })
    }

    pub fn get_skill_tags(&self, skill_id: &str) -> Result<Vec<TagRecord>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT t.id, t.name
                 FROM skill_tags t
                 INNER JOIN skill_tag_links l ON l.tag_id = t.id
                 WHERE l.skill_id = ?1
                 ORDER BY LOWER(t.name) ASC",
            )?;
            let rows = stmt.query_map(params![skill_id], |row| {
                Ok(TagRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })?;

            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            Ok(items)
        })
    }

    pub fn set_skill_tags(&self, skill_id: &str, tag_ids: &[i64]) -> Result<()> {
        self.with_conn(|conn| {
            let now = now_ms();
            conn.execute_batch("BEGIN;")?;
            let result = (|| -> Result<()> {
                conn.execute(
                    "DELETE FROM skill_tag_links WHERE skill_id = ?1",
                    params![skill_id],
                )?;
                for tag_id in tag_ids {
                    conn.execute(
                        "INSERT OR IGNORE INTO skill_tag_links (skill_id, tag_id, created_at)
                         VALUES (?1, ?2, ?3)",
                        params![skill_id, tag_id, now],
                    )?;
                }
                Ok(())
            })();

            match result {
                Ok(()) => {
                    conn.execute_batch("COMMIT;")?;
                    Ok(())
                }
                Err(err) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    Err(err)
                }
            }
        })
    }

    pub fn list_untagged_skill_ids(&self) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT s.id
                 FROM skills s
                 WHERE NOT EXISTS (
                   SELECT 1 FROM skill_tag_links l WHERE l.skill_id = s.id
                 )
                 ORDER BY s.updated_at DESC",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            Ok(items)
        })
    }

    pub fn list_skill_targets(&self, skill_id: &str) -> Result<Vec<SkillTargetRecord>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, skill_id, tool, scope, project_path, target_path, mode, status, last_error, synced_at
         FROM skill_targets
         WHERE skill_id = ?1
         ORDER BY tool ASC, scope ASC, project_path ASC",
            )?;
            let rows = stmt.query_map(params![skill_id], |row| {
                Ok(SkillTargetRecord {
                    id: row.get(0)?,
                    skill_id: row.get(1)?,
                    tool: row.get(2)?,
                    scope: row.get(3)?,
                    project_path: row.get(4)?,
                    target_path: row.get(5)?,
                    mode: row.get(6)?,
                    status: row.get(7)?,
                    last_error: row.get(8)?,
                    synced_at: row.get(9)?,
                })
            })?;

            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            Ok(items)
        })
    }

    pub fn list_skill_targets_by_tool(&self, tool: &str) -> Result<Vec<SkillTargetRecord>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, skill_id, tool, scope, project_path, target_path, mode, status, last_error, synced_at
         FROM skill_targets
         WHERE tool = ?1
         ORDER BY skill_id ASC, scope ASC, project_path ASC",
            )?;
            let rows = stmt.query_map(params![tool], |row| {
                Ok(SkillTargetRecord {
                    id: row.get(0)?,
                    skill_id: row.get(1)?,
                    tool: row.get(2)?,
                    scope: row.get(3)?,
                    project_path: row.get(4)?,
                    target_path: row.get(5)?,
                    mode: row.get(6)?,
                    status: row.get(7)?,
                    last_error: row.get(8)?,
                    synced_at: row.get(9)?,
                })
            })?;

            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            Ok(items)
        })
    }

    pub fn is_skill_target_path_used_by_another_record(
        &self,
        target_path: &str,
        record_id: &str,
    ) -> Result<bool> {
        self.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*)
                 FROM skill_targets
                 WHERE target_path = ?1
                   AND id != ?2
                   AND status != 'disabled'",
                params![target_path, record_id],
                |row| row.get(0),
            )?;
            Ok(count > 0)
        })
    }

    pub fn list_all_skill_target_paths(&self) -> Result<Vec<(String, String)>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT tool, target_path
         FROM skill_targets",
            )?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;

            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            Ok(items)
        })
    }

    pub fn get_skill_target(
        &self,
        skill_id: &str,
        tool: &str,
        scope: &str,
        project_path: Option<&str>,
    ) -> Result<Option<SkillTargetRecord>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, skill_id, tool, scope, project_path, target_path, mode, status, last_error, synced_at
         FROM skill_targets
         WHERE skill_id = ?1
           AND tool = ?2
           AND scope = ?3
           AND ((?4 IS NULL AND project_path IS NULL) OR project_path = ?4)",
            )?;
            let mut rows = stmt.query(params![skill_id, tool, scope, project_path])?;
            if let Some(row) = rows.next()? {
                Ok(Some(SkillTargetRecord {
                    id: row.get(0)?,
                    skill_id: row.get(1)?,
                    tool: row.get(2)?,
                    scope: row.get(3)?,
                    project_path: row.get(4)?,
                    target_path: row.get(5)?,
                    mode: row.get(6)?,
                    status: row.get(7)?,
                    last_error: row.get(8)?,
                    synced_at: row.get(9)?,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn delete_skill_target(
        &self,
        skill_id: &str,
        tool: &str,
        scope: &str,
        project_path: Option<&str>,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM skill_targets
                 WHERE skill_id = ?1
                   AND tool = ?2
                   AND scope = ?3
                   AND ((?4 IS NULL AND project_path IS NULL) OR project_path = ?4)",
                params![skill_id, tool, scope, project_path],
            )?;
            Ok(())
        })
    }

    pub fn update_skill_target_status(
        &self,
        skill_id: &str,
        tool: &str,
        scope: &str,
        project_path: Option<&str>,
        status: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE skill_targets
                 SET status = ?5
                 WHERE skill_id = ?1
                   AND tool = ?2
                   AND scope = ?3
                   AND ((?4 IS NULL AND project_path IS NULL) OR project_path = ?4)",
                params![skill_id, tool, scope, project_path, status],
            )?;
            Ok(())
        })
    }

    pub(crate) fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = Connection::open(&self.db_path)
            .with_context(|| format!("failed to open db at {:?}", self.db_path))?;
        // Enforce foreign key constraints on every connection (rusqlite PRAGMA is per-connection).
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        f(&conn)
    }
}

fn migrate_skill_targets_to_v4(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_skill_targets_unique_scope;
         CREATE TABLE skill_targets_new (
           id TEXT PRIMARY KEY,
           skill_id TEXT NOT NULL,
           tool TEXT NOT NULL,
           scope TEXT NOT NULL DEFAULT 'global',
           project_path TEXT NULL,
           target_path TEXT NOT NULL,
           mode TEXT NOT NULL,
           status TEXT NOT NULL,
           last_error TEXT NULL,
           synced_at INTEGER NULL,
           FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
         );
         INSERT INTO skill_targets_new (
           id, skill_id, tool, scope, project_path, target_path, mode, status, last_error, synced_at
         )
         SELECT id, skill_id, tool, 'global', NULL, target_path, mode, status, last_error, synced_at
         FROM skill_targets;
         DROP TABLE skill_targets;
         ALTER TABLE skill_targets_new RENAME TO skill_targets;
         CREATE UNIQUE INDEX idx_skill_targets_unique_scope
         ON skill_targets(skill_id, tool, scope, COALESCE(project_path, ''));",
    )?;
    Ok(())
}

fn migrate_tags_to_v5(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS skill_tags (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL UNIQUE COLLATE NOCASE,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS skill_tag_links (
           skill_id TEXT NOT NULL,
           tag_id INTEGER NOT NULL,
           created_at INTEGER NOT NULL,
           PRIMARY KEY (skill_id, tag_id),
           FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE,
           FOREIGN KEY(tag_id) REFERENCES skill_tags(id) ON DELETE CASCADE
         );",
    )?;
    Ok(())
}

fn migrate_skill_enabled_to_v6(conn: &Connection) -> Result<()> {
    conn.execute_batch("ALTER TABLE skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;")?;
    Ok(())
}

fn migrate_setups_to_v8(conn: &Connection, discard_profile_poc: bool) -> Result<()> {
    if discard_profile_poc {
        conn.execute_batch(
            "DROP TABLE IF EXISTS profile_revisions;
             DROP TABLE IF EXISTS projects;
             DROP TABLE IF EXISTS profile_skills;
             DROP TABLE IF EXISTS profiles;",
        )?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS setups (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL UNIQUE COLLATE NOCASE,
           current_revision_id TEXT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           FOREIGN KEY(current_revision_id) REFERENCES setup_revisions(id) ON DELETE RESTRICT
         );

         CREATE TABLE IF NOT EXISTS setup_revisions (
           id TEXT PRIMARY KEY,
           setup_id TEXT NOT NULL,
           revision_number INTEGER NOT NULL,
           created_at INTEGER NOT NULL,
           UNIQUE(setup_id, revision_number),
           FOREIGN KEY(setup_id) REFERENCES setups(id) ON DELETE CASCADE
         );

         CREATE TABLE IF NOT EXISTS setup_revision_skills (
           revision_id TEXT NOT NULL,
           skill_id TEXT NOT NULL,
           tool TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           PRIMARY KEY (revision_id, skill_id, tool),
           FOREIGN KEY(revision_id) REFERENCES setup_revisions(id) ON DELETE CASCADE,
           FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE RESTRICT
         );

         CREATE TABLE IF NOT EXISTS projects (
           id TEXT PRIMARY KEY,
           path TEXT NOT NULL UNIQUE,
           assigned_setup_revision_id TEXT NULL,
           applied_setup_revision_id TEXT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           FOREIGN KEY(assigned_setup_revision_id) REFERENCES setup_revisions(id) ON DELETE SET NULL,
           FOREIGN KEY(applied_setup_revision_id) REFERENCES setup_revisions(id) ON DELETE SET NULL
         );

         CREATE TABLE IF NOT EXISTS apply_operations (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           previous_assigned_revision_id TEXT NULL,
           previous_applied_revision_id TEXT NULL,
           applied_revision_id TEXT NULL,
           previous_targets_json TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           rolled_back_at INTEGER NULL,
           FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
           FOREIGN KEY(previous_assigned_revision_id) REFERENCES setup_revisions(id) ON DELETE SET NULL,
           FOREIGN KEY(previous_applied_revision_id) REFERENCES setup_revisions(id) ON DELETE SET NULL,
           FOREIGN KEY(applied_revision_id) REFERENCES setup_revisions(id) ON DELETE SET NULL
         );

         CREATE INDEX IF NOT EXISTS idx_setup_revisions_setup
         ON setup_revisions(setup_id, revision_number DESC);

         CREATE INDEX IF NOT EXISTS idx_setup_revision_skills_revision
         ON setup_revision_skills(revision_id);

         CREATE INDEX IF NOT EXISTS idx_apply_operations_project
         ON apply_operations(project_id, created_at DESC);",
    )?;
    Ok(())
}

fn migrate_default_setup_to_v9(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "ALTER TABLE setups ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom';
         ALTER TABLE setups ADD COLUMN initial_revision_id TEXT NULL;

         ALTER TABLE setup_revision_skills RENAME TO setup_revision_skills_v8;

         CREATE TABLE setup_revision_skills (
           revision_id TEXT NOT NULL,
           skill_id TEXT NOT NULL,
           tool TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           target_name TEXT NOT NULL,
           PRIMARY KEY (revision_id, skill_id, tool, target_name),
           FOREIGN KEY(revision_id) REFERENCES setup_revisions(id) ON DELETE CASCADE,
           FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE RESTRICT
         );

         INSERT INTO setup_revision_skills
           (revision_id, skill_id, tool, created_at, target_name)
         SELECT rs.revision_id, rs.skill_id, rs.tool, rs.created_at, s.name
         FROM setup_revision_skills_v8 rs
         INNER JOIN skills s ON s.id = rs.skill_id;

         DROP TABLE setup_revision_skills_v8;

         CREATE INDEX idx_setup_revision_skills_revision
         ON setup_revision_skills(revision_id);

         CREATE UNIQUE INDEX IF NOT EXISTS idx_setups_single_default
         ON setups(kind) WHERE kind = 'default';",
    )?;
    Ok(())
}

fn migrate_project_defaults_to_v10(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_setups_single_default;
         ALTER TABLE setups ADD COLUMN default_project_id TEXT NULL;

         CREATE UNIQUE INDEX idx_setups_default_project
         ON setups(default_project_id)
         WHERE kind = 'default' AND default_project_id IS NOT NULL;",
    )?;
    Ok(())
}

fn migrate_filesystem_recovery_to_v11(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS filesystem_recovery_journal (
           operation_id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL UNIQUE,
           operation_kind TEXT NOT NULL CHECK (operation_kind IN ('apply', 'rollback')),
           recovery_plan_json TEXT NOT NULL,
           actions_completed INTEGER NOT NULL DEFAULT 0 CHECK (actions_completed >= 0),
           status TEXT NOT NULL CHECK (status IN ('prepared', 'mutating', 'restoring', 'needsAttention')),
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
         );",
    )?;
    Ok(())
}

fn normalize_tag_name(name: &str) -> Result<String> {
    let normalized = name.trim().to_string();
    if normalized.is_empty() {
        anyhow::bail!("tag name cannot be empty");
    }
    Ok(normalized)
}

fn now_ms() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    now.as_millis() as i64
}

#[cfg(test)]
#[path = "tests/skill_store.rs"]
mod tests;
