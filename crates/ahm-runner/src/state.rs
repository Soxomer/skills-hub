use std::{fmt, fs, path::Path};

use ahm_domain::{
    ApplyReceipt, ContractValueError, DeviceId, IsoTimestamp, JobEnvelope, OrganizationId,
    ProjectId, ProjectInstanceId, Recoverability,
};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

const RUNNER_SCHEMA_VERSION: i64 = 2;
const RUNNER_SCHEMA_V2: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runner_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runner_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  server_url TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  credential_secret TEXT NOT NULL,
  enrolled_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_instances (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  local_path TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  UNIQUE (organization_id, project_id, local_path)
);

CREATE TABLE IF NOT EXISTS materializations (
  id TEXT PRIMARY KEY,
  project_instance_id TEXT NOT NULL REFERENCES project_instances(id) ON DELETE CASCADE,
  setup_revision_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'rolledBack', 'partialFailure')),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materialization_entries (
  id TEXT PRIMARY KEY,
  materialization_id TEXT NOT NULL REFERENCES materializations(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  target_path TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('symlink', 'junction', 'copy')),
  content_digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_journal (
  operation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  project_instance_id TEXT NOT NULL REFERENCES project_instances(id) ON DELETE CASCADE,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('scanProject', 'planSetup', 'applyPlan', 'rollbackOperation')),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'rolledBack')),
  plan_digest TEXT NULL,
  recoverability TEXT NOT NULL CHECK (recoverability IN ('notNeeded', 'rollbackAvailable', 'manualIntervention')),
  error_code TEXT NULL,
  result_json TEXT NULL,
  result_digest TEXT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NULL
);

CREATE TABLE IF NOT EXISTS scan_cache (
  project_instance_id TEXT PRIMARY KEY REFERENCES project_instances(id) ON DELETE CASCADE,
  scan_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  scanned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS result_outbox (
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  lease_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  delivered_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_materializations_instance
ON materializations(project_instance_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_operation_journal_instance
ON operation_journal(project_instance_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_result_outbox_delivery
ON result_outbox(delivered_at, next_attempt_at);

INSERT OR IGNORE INTO runner_schema_migrations (version, applied_at)
VALUES (1, '2026-08-31T00:00:00Z');
INSERT OR IGNORE INTO runner_schema_migrations (version, applied_at)
VALUES (2, '2026-09-01T00:00:00Z');

PRAGMA user_version = 2;
"#;

const RUNNER_SCHEMA_V1_TO_V2: &str = r#"
ALTER TABLE runner_identity RENAME COLUMN credential_ciphertext TO credential_secret;
ALTER TABLE runner_identity ADD COLUMN server_url TEXT NOT NULL DEFAULT '';
ALTER TABLE operation_journal ADD COLUMN request_digest TEXT NULL;
UPDATE operation_journal SET request_digest = '' WHERE request_digest IS NULL;
ALTER TABLE operation_journal ADD COLUMN result_json TEXT NULL;
ALTER TABLE operation_journal ADD COLUMN result_digest TEXT NULL;
ALTER TABLE result_outbox ADD COLUMN lease_id TEXT NOT NULL DEFAULT '';
INSERT OR IGNORE INTO runner_schema_migrations (version, applied_at)
VALUES (2, '2026-09-01T00:00:00Z');
PRAGMA user_version = 2;
"#;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunnerIdentityRecord {
    pub server_url: String,
    pub organization_id: OrganizationId,
    pub device_id: DeviceId,
    pub credential_secret: String,
    pub enrolled_at: IsoTimestamp,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectInstanceRecord {
    pub id: ProjectInstanceId,
    pub organization_id: OrganizationId,
    pub project_id: ProjectId,
    pub local_path: std::path::PathBuf,
    pub registered_at: IsoTimestamp,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JournalStartOutcome {
    Execute,
    Completed { result_json: String },
    IdempotencyMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboxRecord {
    pub job_id: String,
    pub idempotency_key: String,
    pub lease_id: String,
    pub result_json: String,
    pub attempt_count: u32,
}

#[derive(Debug)]
pub enum RunnerStateError {
    Database(rusqlite::Error),
    Contract(ContractValueError),
    Io(std::io::Error),
    UnsupportedSchema(i64),
}

impl fmt::Display for RunnerStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => write!(formatter, "runner state database error: {error}"),
            Self::Contract(error) => write!(formatter, "invalid runner state value: {error}"),
            Self::Io(error) => write!(formatter, "runner state filesystem error: {error}"),
            Self::UnsupportedSchema(version) => {
                write!(
                    formatter,
                    "runner state schema version {version} is unsupported"
                )
            }
        }
    }
}

impl std::error::Error for RunnerStateError {}

impl From<rusqlite::Error> for RunnerStateError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ContractValueError> for RunnerStateError {
    fn from(error: ContractValueError) -> Self {
        Self::Contract(error)
    }
}

impl From<std::io::Error> for RunnerStateError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub struct RunnerStateStore {
    connection: Connection,
}

impl RunnerStateStore {
    pub fn open(path: &Path) -> Result<Self, RunnerStateError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, RunnerStateError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    pub fn from_connection(connection: Connection) -> Result<Self, RunnerStateError> {
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    pub fn save_identity(&self, record: &RunnerIdentityRecord) -> Result<(), RunnerStateError> {
        self.connection.execute(
            "INSERT INTO runner_identity
               (singleton, server_url, organization_id, device_id, credential_secret, enrolled_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(singleton) DO UPDATE SET
               server_url = excluded.server_url,
               organization_id = excluded.organization_id,
               device_id = excluded.device_id,
               credential_secret = excluded.credential_secret,
               enrolled_at = excluded.enrolled_at",
            params![
                record.server_url,
                record.organization_id.as_str(),
                record.device_id.as_str(),
                record.credential_secret,
                record.enrolled_at.as_str(),
            ],
        )?;
        Ok(())
    }

    pub fn identity(&self) -> Result<Option<RunnerIdentityRecord>, RunnerStateError> {
        let row = self
            .connection
            .query_row(
                "SELECT server_url, organization_id, device_id, credential_secret, enrolled_at
                 FROM runner_identity WHERE singleton = 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(server_url, organization_id, device_id, credential_secret, enrolled_at)| {
                Ok(RunnerIdentityRecord {
                    server_url,
                    organization_id: OrganizationId::new(organization_id)?,
                    device_id: DeviceId::new(device_id)?,
                    credential_secret,
                    enrolled_at: IsoTimestamp::new(enrolled_at)?,
                })
            },
        )
        .transpose()
    }

    pub fn register_project_instance(
        &self,
        record: &ProjectInstanceRecord,
    ) -> Result<(), RunnerStateError> {
        self.connection.execute(
            "INSERT INTO project_instances
               (id, organization_id, project_id, local_path, registered_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               organization_id = excluded.organization_id,
               project_id = excluded.project_id,
               local_path = excluded.local_path",
            params![
                record.id.as_str(),
                record.organization_id.as_str(),
                record.project_id.as_str(),
                record.local_path.to_string_lossy(),
                record.registered_at.as_str(),
            ],
        )?;
        Ok(())
    }

    pub fn project_instance(
        &self,
        id: &ProjectInstanceId,
    ) -> Result<Option<ProjectInstanceRecord>, RunnerStateError> {
        let row = self
            .connection
            .query_row(
                "SELECT id, organization_id, project_id, local_path, registered_at
                 FROM project_instances WHERE id = ?1",
                [id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;

        row.map(
            |(id, organization_id, project_id, local_path, registered_at)| {
                Ok(ProjectInstanceRecord {
                    id: ProjectInstanceId::new(id)?,
                    organization_id: OrganizationId::new(organization_id)?,
                    project_id: ProjectId::new(project_id)?,
                    local_path: local_path.into(),
                    registered_at: IsoTimestamp::new(registered_at)?,
                })
            },
        )
        .transpose()
    }

    pub fn project_instance_for_checkout(
        &self,
        organization_id: &OrganizationId,
        project_id: &ProjectId,
        local_path: &Path,
    ) -> Result<Option<ProjectInstanceRecord>, RunnerStateError> {
        let row = self
            .connection
            .query_row(
                "SELECT id, organization_id, project_id, local_path, registered_at
                 FROM project_instances
                 WHERE organization_id = ?1 AND project_id = ?2 AND local_path = ?3",
                params![
                    organization_id.as_str(),
                    project_id.as_str(),
                    local_path.to_string_lossy(),
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(id, organization_id, project_id, local_path, registered_at)| {
                Ok(ProjectInstanceRecord {
                    id: ProjectInstanceId::new(id)?,
                    organization_id: OrganizationId::new(organization_id)?,
                    project_id: ProjectId::new(project_id)?,
                    local_path: local_path.into(),
                    registered_at: IsoTimestamp::new(registered_at)?,
                })
            },
        )
        .transpose()
    }

    pub fn begin_job(
        &mut self,
        job: &JobEnvelope,
        lease_id: &str,
        request_digest: &str,
        started_at: &IsoTimestamp,
    ) -> Result<JournalStartOutcome, RunnerStateError> {
        let transaction = self.connection.transaction()?;
        let existing = transaction
            .query_row(
                "SELECT job_id, idempotency_key, request_digest, result_json
                 FROM operation_journal
                 WHERE job_id = ?1 OR idempotency_key = ?2",
                params![job.job_id.as_str(), job.idempotency_key.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((job_id, idempotency_key, stored_digest, result_json)) = existing {
            if job_id != job.job_id.as_str()
                || idempotency_key != job.idempotency_key.as_str()
                || stored_digest != request_digest
            {
                return Ok(JournalStartOutcome::IdempotencyMismatch);
            }
            if let Some(result_json) = result_json {
                transaction.execute(
                    "INSERT INTO result_outbox
                       (job_id, idempotency_key, lease_id, result_json, next_attempt_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(job_id) DO UPDATE SET lease_id = excluded.lease_id,
                       result_json = excluded.result_json, delivered_at = NULL,
                       next_attempt_at = CASE
                         WHEN result_outbox.lease_id != excluded.lease_id
                         THEN excluded.next_attempt_at
                         ELSE result_outbox.next_attempt_at
                       END",
                    params![
                        job.job_id.as_str(),
                        job.idempotency_key.as_str(),
                        lease_id,
                        result_json,
                        started_at.as_str(),
                    ],
                )?;
                transaction.commit()?;
                return Ok(JournalStartOutcome::Completed { result_json });
            }
            transaction.commit()?;
            return Ok(JournalStartOutcome::Execute);
        }

        transaction.execute(
            "INSERT INTO operation_journal
               (operation_id, job_id, idempotency_key, request_digest, project_instance_id,
                operation_kind, status, recoverability, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'started', 'notNeeded', ?7)",
            params![
                Uuid::new_v4().to_string(),
                job.job_id.as_str(),
                job.idempotency_key.as_str(),
                request_digest,
                job.project_instance_id.as_str(),
                job_kind(job),
                started_at.as_str(),
            ],
        )?;
        transaction.commit()?;
        Ok(JournalStartOutcome::Execute)
    }

    pub fn finish_job(
        &mut self,
        job: &JobEnvelope,
        lease_id: &str,
        result_json: &str,
        result_digest: &str,
        failed: bool,
        completed_at: &IsoTimestamp,
    ) -> Result<(), RunnerStateError> {
        let result = serde_json::from_str::<ahm_domain::ResultEnvelope>(result_json).ok();
        let plan_digest = result.as_ref().and_then(|result| match &result.result {
            ahm_domain::RunnerResult::PlanResult(result) => Some(result.plan.plan_digest.as_str()),
            ahm_domain::RunnerResult::ApplyReceipt(receipt) => Some(receipt.plan_digest.as_str()),
            _ => None,
        });
        let recoverability = result
            .as_ref()
            .map(|result| match &result.result {
                ahm_domain::RunnerResult::ApplyReceipt(receipt) => receipt.recoverability,
                ahm_domain::RunnerResult::RollbackReceipt(receipt) => receipt.recoverability,
                ahm_domain::RunnerResult::CancellationReceipt(receipt) => receipt.recoverability,
                ahm_domain::RunnerResult::Error(error) => error.recoverability,
                _ => Recoverability::NotNeeded,
            })
            .unwrap_or(Recoverability::NotNeeded);
        let journal_status =
            result
                .as_ref()
                .map_or(
                    if failed { "failed" } else { "succeeded" },
                    |result| match &result.result {
                        ahm_domain::RunnerResult::CancellationReceipt(receipt)
                            if receipt.outcome
                                == ahm_domain::CancellationOutcome::CancelledAndRestored =>
                        {
                            "rolledBack"
                        }
                        ahm_domain::RunnerResult::CancellationReceipt(_) => "failed",
                        _ if failed => "failed",
                        _ => "succeeded",
                    },
                );
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "UPDATE operation_journal
             SET status = ?1, result_json = ?2, result_digest = ?3, completed_at = ?4,
                 plan_digest = ?5, recoverability = ?6
             WHERE job_id = ?7",
            params![
                journal_status,
                result_json,
                result_digest,
                completed_at.as_str(),
                plan_digest,
                recoverability_key(recoverability),
                job.job_id.as_str(),
            ],
        )?;
        transaction.execute(
            "INSERT INTO result_outbox
               (job_id, idempotency_key, lease_id, result_json, next_attempt_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(job_id) DO UPDATE SET lease_id = excluded.lease_id,
               result_json = excluded.result_json, delivered_at = NULL,
               next_attempt_at = excluded.next_attempt_at",
            params![
                job.job_id.as_str(),
                job.idempotency_key.as_str(),
                lease_id,
                result_json,
                completed_at.as_str(),
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn record_materialization(
        &self,
        project_instance_id: &ProjectInstanceId,
        receipt: &ApplyReceipt,
    ) -> Result<(), RunnerStateError> {
        self.connection.execute(
            "INSERT INTO materializations
             (id, project_instance_id, setup_revision_id, plan_digest, status, applied_at)
             VALUES (?1, ?2, ?3, ?4, 'applied', ?5)
             ON CONFLICT(id) DO UPDATE SET
               setup_revision_id = excluded.setup_revision_id,
               plan_digest = excluded.plan_digest,
               status = 'applied', applied_at = excluded.applied_at",
            params![
                receipt.operation_id.as_str(),
                project_instance_id.as_str(),
                receipt.setup_revision_id.as_str(),
                receipt.plan_digest.as_str(),
                receipt.completed_at.as_str(),
            ],
        )?;
        Ok(())
    }

    pub fn mark_materialization_rolled_back(
        &self,
        operation_id: &str,
    ) -> Result<(), RunnerStateError> {
        self.connection.execute(
            "UPDATE materializations SET status = 'rolledBack' WHERE id = ?1",
            params![operation_id],
        )?;
        Ok(())
    }

    pub fn pending_outbox(
        &self,
        now: &IsoTimestamp,
    ) -> Result<Vec<OutboxRecord>, RunnerStateError> {
        let mut statement = self.connection.prepare(
            "SELECT job_id, idempotency_key, lease_id, result_json, attempt_count
             FROM result_outbox
             WHERE delivered_at IS NULL AND next_attempt_at <= ?1
             ORDER BY next_attempt_at, job_id",
        )?;
        let rows = statement
            .query_map([now.as_str()], |row| {
                Ok(OutboxRecord {
                    job_id: row.get(0)?,
                    idempotency_key: row.get(1)?,
                    lease_id: row.get(2)?,
                    result_json: row.get(3)?,
                    attempt_count: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn mark_outbox_attempt(
        &self,
        job_id: &str,
        next_attempt_at: &IsoTimestamp,
    ) -> Result<(), RunnerStateError> {
        self.connection.execute(
            "UPDATE result_outbox SET attempt_count = attempt_count + 1, next_attempt_at = ?1
             WHERE job_id = ?2 AND delivered_at IS NULL",
            params![next_attempt_at.as_str(), job_id],
        )?;
        Ok(())
    }

    pub fn undelivered_outbox_count(&self) -> Result<u64, RunnerStateError> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM result_outbox WHERE delivered_at IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn mark_outbox_delivered(
        &self,
        job_id: &str,
        delivered_at: &IsoTimestamp,
    ) -> Result<(), RunnerStateError> {
        self.connection.execute(
            "UPDATE result_outbox SET delivered_at = ?1 WHERE job_id = ?2",
            params![delivered_at.as_str(), job_id],
        )?;
        Ok(())
    }

    fn migrate(&self) -> Result<(), RunnerStateError> {
        self.connection.pragma_update(None, "foreign_keys", true)?;
        let version = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
        match version {
            0 => self.connection.execute_batch(RUNNER_SCHEMA_V2)?,
            1 => self.connection.execute_batch(RUNNER_SCHEMA_V1_TO_V2)?,
            RUNNER_SCHEMA_VERSION => {}
            other => return Err(RunnerStateError::UnsupportedSchema(other)),
        }
        Ok(())
    }
}

fn job_kind(job: &JobEnvelope) -> &'static str {
    match job.job {
        ahm_domain::RunnerJob::ScanProject(_) => "scanProject",
        ahm_domain::RunnerJob::PlanSetup(_) => "planSetup",
        ahm_domain::RunnerJob::ApplyPlan(_) => "applyPlan",
        ahm_domain::RunnerJob::RollbackOperation(_) => "rollbackOperation",
    }
}

fn recoverability_key(value: Recoverability) -> &'static str {
    match value {
        Recoverability::NotNeeded => "notNeeded",
        Recoverability::RollbackAvailable => "rollbackAvailable",
        Recoverability::ManualIntervention => "manualIntervention",
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use tempfile::tempdir;

    use super::*;

    fn identifier(value: &str) -> ahm_domain::Identifier {
        ahm_domain::Identifier::new(value).unwrap()
    }

    fn timestamp() -> IsoTimestamp {
        IsoTimestamp::new("2026-08-31T00:00:00Z").unwrap()
    }

    fn table_names(store: &RunnerStateStore) -> Vec<String> {
        let mut statement = store
            .connection
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn open_file(path: &Path) -> RunnerStateStore {
        RunnerStateStore::open(path).unwrap()
    }

    #[test]
    fn migration_creates_only_device_local_tables() {
        let store = RunnerStateStore::open_in_memory().unwrap();

        assert_eq!(
            table_names(&store),
            vec![
                "materialization_entries",
                "materializations",
                "operation_journal",
                "project_instances",
                "result_outbox",
                "runner_identity",
                "runner_schema_migrations",
                "scan_cache",
            ]
        );
        for shared_table in [
            "organizations",
            "projects",
            "setups",
            "setup_revisions",
            "setup_revision_items",
            "project_assignments",
            "plan_approvals",
        ] {
            assert!(!table_names(&store).contains(&shared_table.to_owned()));
        }
    }

    #[test]
    fn only_runner_owned_records_contain_machine_paths() {
        let store = RunnerStateStore::open_in_memory().unwrap();
        let mut path_columns = Vec::new();
        for table in table_names(&store) {
            let mut statement = store
                .connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap();
            for column in statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
            {
                let column = column.unwrap();
                if column.contains("path") {
                    path_columns.push((table.clone(), column));
                }
            }
        }

        assert_eq!(
            path_columns,
            vec![
                (
                    "materialization_entries".to_owned(),
                    "target_path".to_owned()
                ),
                ("project_instances".to_owned(), "local_path".to_owned()),
            ]
        );
    }

    #[test]
    fn identity_and_project_paths_remain_local() {
        let store = RunnerStateStore::open_in_memory().unwrap();
        let identity = RunnerIdentityRecord {
            server_url: "https://hub.example.test".to_owned(),
            organization_id: identifier("org_01"),
            device_id: identifier("device_01"),
            credential_secret: "secret".to_owned(),
            enrolled_at: timestamp(),
        };
        store.save_identity(&identity).unwrap();
        assert_eq!(store.identity().unwrap(), Some(identity));

        let record = ProjectInstanceRecord {
            id: identifier("project_instance_01"),
            organization_id: identifier("org_01"),
            project_id: identifier("project_01"),
            local_path: PathBuf::from("C:\\workspaces\\project"),
            registered_at: timestamp(),
        };
        store.register_project_instance(&record).unwrap();
        assert_eq!(store.project_instance(&record.id).unwrap(), Some(record));
    }

    #[test]
    fn independent_runner_databases_migrate_without_shared_state() {
        let directory = tempdir().unwrap();
        let first = open_file(&directory.path().join("runner-a.db"));
        let second = open_file(&directory.path().join("runner-b.db"));

        first
            .register_project_instance(&ProjectInstanceRecord {
                id: identifier("instance_a"),
                organization_id: identifier("org_01"),
                project_id: identifier("project_01"),
                local_path: directory.path().join("checkout-a"),
                registered_at: timestamp(),
            })
            .unwrap();

        assert!(second
            .project_instance(&identifier("instance_a"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn newer_runner_schema_is_rejected() {
        let connection = Connection::open_in_memory().unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();

        assert!(matches!(
            RunnerStateStore::from_connection(connection),
            Err(RunnerStateError::UnsupportedSchema(99))
        ));
    }

    #[test]
    fn current_runner_schema_can_be_reopened() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("runner.db");
        drop(open_file(&path));

        assert_eq!(
            table_names(&open_file(&path)),
            table_names(&RunnerStateStore::open_in_memory().unwrap())
        );
    }

    #[test]
    fn version_one_runner_state_is_upgraded_in_place() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE runner_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                CREATE TABLE runner_identity (
                  singleton INTEGER PRIMARY KEY,
                  organization_id TEXT NOT NULL,
                  device_id TEXT NOT NULL,
                  credential_ciphertext BLOB NOT NULL,
                  credential_expires_at TEXT NULL,
                  enrolled_at TEXT NOT NULL
                );
                CREATE TABLE operation_journal (
                  operation_id TEXT PRIMARY KEY,
                  job_id TEXT NOT NULL,
                  idempotency_key TEXT NOT NULL
                );
                CREATE TABLE result_outbox (
                  job_id TEXT PRIMARY KEY,
                  idempotency_key TEXT NOT NULL,
                  result_json TEXT NOT NULL,
                  attempt_count INTEGER NOT NULL,
                  next_attempt_at TEXT NOT NULL,
                  delivered_at TEXT NULL
                );
                PRAGMA user_version = 1;
                "#,
            )
            .unwrap();

        let store = RunnerStateStore::from_connection(connection).unwrap();
        let columns = store
            .connection
            .prepare("PRAGMA table_info(runner_identity)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.contains(&"credential_secret".to_owned()));
        assert!(columns.contains(&"server_url".to_owned()));
        assert_eq!(
            store
                .connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            RUNNER_SCHEMA_VERSION
        );
    }
}
