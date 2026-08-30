use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::content_hash::hash_dir;
use super::skill_store::{SkillRecord, SkillStore, SkillTargetRecord};
use super::sync_engine::{
    remove_path_any, sync_dir_with_mode_with_overwrite, SyncMode, SyncOutcome,
};
use super::tool_adapters::{
    adapter_by_key, is_builtin_tool_enabled, load_tool_config, project_relative_skills_dir,
    supports_project_scope,
};

const APP_IDENTIFIER: &str = "com.qufei1993.skillshub";
const DB_FILE_NAME: &str = "skills_hub.db";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub central_path: String,
    pub enabled: bool,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SetupSummary {
    pub id: String,
    pub name: String,
    pub revision_id: String,
    pub revision_number: i64,
    pub skill_target_count: usize,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SetupItem {
    pub skill_id: String,
    pub skill_name: String,
    pub tool: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SetupDetail {
    #[serde(flatten)]
    pub setup: SetupSummary,
    pub items: Vec<SetupItem>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub assigned_setup: Option<SetupSummary>,
    pub applied_setup: Option<SetupSummary>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApplyActionKind {
    Add,
    Remove,
    Replace,
    UpdateRecords,
    Keep,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ApplyAction {
    pub kind: ApplyActionKind,
    pub skill_id: String,
    pub skill_name: String,
    pub tools: Vec<String>,
    pub target_path: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ApplyPlan {
    pub project: Project,
    pub setup: Option<SetupSummary>,
    pub actions: Vec<ApplyAction>,
    pub conflicts: Vec<String>,
    pub has_changes: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ApplyResult {
    pub plan: ApplyPlan,
    pub operation_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ProjectStatus {
    pub project: Project,
    pub pending_plan: Option<ApplyPlan>,
}

#[derive(Clone, Debug)]
pub struct SetupService {
    store: SkillStore,
}

#[derive(Clone, Debug)]
struct ResolvedTool {
    key: String,
    relative_skills_dir: PathBuf,
    sync_mode: SyncMode,
}

#[derive(Clone, Debug)]
struct DesiredGroup {
    skill: SkillRecord,
    tools: Vec<String>,
    target_path: PathBuf,
    sync_mode: SyncMode,
}

#[derive(Clone, Debug)]
struct CurrentGroup {
    records: Vec<SkillTargetRecord>,
    skill: Option<SkillRecord>,
    target_path: PathBuf,
    exists: bool,
    actual_mode: SyncMode,
}

#[derive(Clone, Debug)]
enum PhysicalOperation {
    Add(DesiredGroup),
    Remove(CurrentGroup),
    Replace(CurrentGroup, DesiredGroup),
    Keep(CurrentGroup, DesiredGroup),
}

#[derive(Clone, Debug)]
struct Reconciliation {
    plan: ApplyPlan,
    desired: Vec<DesiredGroup>,
    current_records: Vec<SkillTargetRecord>,
    operations: Vec<PhysicalOperation>,
}

#[derive(Clone, Debug)]
struct Execution {
    modes: HashMap<String, SyncMode>,
    added_paths: Vec<PathBuf>,
    removed_groups: Vec<CurrentGroup>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct TargetSnapshot {
    id: String,
    skill_id: String,
    tool: String,
    scope: String,
    project_path: Option<String>,
    target_path: String,
    mode: String,
    status: String,
    last_error: Option<String>,
    synced_at: Option<i64>,
}

#[derive(Clone, Debug)]
struct ApplyOperation {
    id: String,
    previous_assigned_revision_id: Option<String>,
    previous_applied_revision_id: Option<String>,
    previous_targets: Vec<TargetSnapshot>,
}

impl From<&SkillTargetRecord> for TargetSnapshot {
    fn from(value: &SkillTargetRecord) -> Self {
        Self {
            id: value.id.clone(),
            skill_id: value.skill_id.clone(),
            tool: value.tool.clone(),
            scope: value.scope.clone(),
            project_path: value.project_path.clone(),
            target_path: value.target_path.clone(),
            mode: value.mode.clone(),
            status: value.status.clone(),
            last_error: value.last_error.clone(),
            synced_at: value.synced_at,
        }
    }
}

impl From<&TargetSnapshot> for SkillTargetRecord {
    fn from(value: &TargetSnapshot) -> Self {
        Self {
            id: value.id.clone(),
            skill_id: value.skill_id.clone(),
            tool: value.tool.clone(),
            scope: value.scope.clone(),
            project_path: value.project_path.clone(),
            target_path: value.target_path.clone(),
            mode: value.mode.clone(),
            status: value.status.clone(),
            last_error: value.last_error.clone(),
            synced_at: value.synced_at,
        }
    }
}

impl SetupService {
    pub fn open(db_path: PathBuf) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create database directory {:?}", parent))?;
        }
        let store = SkillStore::new(db_path);
        store.ensure_schema()?;
        Ok(Self { store })
    }

    pub fn from_store(store: SkillStore) -> Result<Self> {
        store.ensure_schema()?;
        Ok(Self { store })
    }

    pub fn list_skills(&self) -> Result<Vec<SkillSummary>> {
        Ok(self
            .store
            .list_skills()?
            .into_iter()
            .map(|skill| SkillSummary {
                id: skill.id,
                name: skill.name,
                description: skill.description,
                central_path: skill.central_path,
                enabled: skill.enabled,
                status: skill.status,
            })
            .collect())
    }

    pub fn list_setups(&self) -> Result<Vec<SetupSummary>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT s.id, s.name, r.id, r.revision_number, COUNT(rs.skill_id),
                        s.created_at, s.updated_at
                 FROM setups s
                 INNER JOIN setup_revisions r ON r.id = s.current_revision_id
                 LEFT JOIN setup_revision_skills rs ON rs.revision_id = r.id
                 GROUP BY s.id, s.name, r.id, r.revision_number, s.created_at, s.updated_at
                 ORDER BY LOWER(s.name)",
            )?;
            let rows = stmt.query_map([], setup_from_row)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into)
        })
    }

    pub fn create_setup(&self, name: &str) -> Result<SetupDetail> {
        let name = normalize_name(name, "setup")?;
        let setup_id = Uuid::new_v4().to_string();
        let revision_id = Uuid::new_v4().to_string();
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO setups (id, name, current_revision_id, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, ?3)",
                params![setup_id, name, now],
            )
            .with_context(|| format!("setup already exists: {name}"))?;
            tx.execute(
                "INSERT INTO setup_revisions (id, setup_id, revision_number, created_at)
                 VALUES (?1, ?2, 1, ?3)",
                params![revision_id, setup_id, now],
            )?;
            tx.execute(
                "UPDATE setups SET current_revision_id = ?1 WHERE id = ?2",
                params![revision_id, setup_id],
            )?;
            tx.commit()?;
            Ok(())
        })?;
        self.get_setup(&setup_id)
    }

    pub fn clone_setup(&self, source: &str, name: &str) -> Result<SetupDetail> {
        let source = self.resolve_setup(source)?;
        let name = normalize_name(name, "setup")?;
        let setup_id = Uuid::new_v4().to_string();
        let revision_id = Uuid::new_v4().to_string();
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO setups (id, name, current_revision_id, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, ?3)",
                params![setup_id, name, now],
            )
            .with_context(|| format!("setup already exists: {name}"))?;
            tx.execute(
                "INSERT INTO setup_revisions (id, setup_id, revision_number, created_at)
                 VALUES (?1, ?2, 1, ?3)",
                params![revision_id, setup_id, now],
            )?;
            tx.execute(
                "INSERT INTO setup_revision_skills (revision_id, skill_id, tool, created_at)
                 SELECT ?1, skill_id, tool, ?2
                 FROM setup_revision_skills WHERE revision_id = ?3",
                params![revision_id, now, source.revision_id],
            )?;
            tx.execute(
                "UPDATE setups SET current_revision_id = ?1 WHERE id = ?2",
                params![revision_id, setup_id],
            )?;
            tx.commit()?;
            Ok(())
        })?;
        self.get_setup(&setup_id)
    }

    pub fn get_setup(&self, selector: &str) -> Result<SetupDetail> {
        let setup = self.resolve_setup(selector)?;
        self.setup_detail(&setup)
    }

    fn setup_detail(&self, setup: &SetupSummary) -> Result<SetupDetail> {
        let items = self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT rs.skill_id, s.name, rs.tool
                 FROM setup_revision_skills rs
                 INNER JOIN skills s ON s.id = rs.skill_id
                 WHERE rs.revision_id = ?1
                 ORDER BY LOWER(s.name), rs.tool",
            )?;
            let rows = stmt.query_map(params![setup.revision_id], |row| {
                Ok(SetupItem {
                    skill_id: row.get(0)?,
                    skill_name: row.get(1)?,
                    tool: row.get(2)?,
                })
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into)
        })?;
        Ok(SetupDetail {
            setup: setup.clone(),
            items,
        })
    }

    pub fn add_setup_skill(
        &self,
        setup_selector: &str,
        skill_selector: &str,
        tools: &[String],
    ) -> Result<SetupDetail> {
        if tools.is_empty() {
            anyhow::bail!("at least one --tool is required");
        }
        let setup = self.resolve_setup(setup_selector)?;
        let skill = self.resolve_skill(skill_selector)?;
        for tool in tools {
            self.resolve_project_tool(tool)?;
        }
        self.create_setup_revision(&setup, |tx, revision_id, now| {
            for tool in tools {
                tx.execute(
                    "INSERT OR IGNORE INTO setup_revision_skills
                     (revision_id, skill_id, tool, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![revision_id, skill.id, tool, now],
                )?;
            }
            Ok(())
        })?;
        self.get_setup(&setup.id)
    }

    pub fn remove_setup_skill(
        &self,
        setup_selector: &str,
        skill_selector: &str,
        tools: &[String],
    ) -> Result<SetupDetail> {
        let setup = self.resolve_setup(setup_selector)?;
        let skill = self.resolve_skill(skill_selector)?;
        self.create_setup_revision(&setup, |tx, revision_id, _now| {
            if tools.is_empty() {
                tx.execute(
                    "DELETE FROM setup_revision_skills
                     WHERE revision_id = ?1 AND skill_id = ?2",
                    params![revision_id, skill.id],
                )?;
            } else {
                for tool in tools {
                    tx.execute(
                        "DELETE FROM setup_revision_skills
                         WHERE revision_id = ?1 AND skill_id = ?2 AND tool = ?3",
                        params![revision_id, skill.id, tool],
                    )?;
                }
            }
            Ok(())
        })?;
        self.get_setup(&setup.id)
    }

    fn create_setup_revision(
        &self,
        setup: &SetupSummary,
        mutate: impl FnOnce(&rusqlite::Transaction<'_>, &str, i64) -> Result<()>,
    ) -> Result<String> {
        let revision_id = Uuid::new_v4().to_string();
        let revision_number = setup.revision_number + 1;
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO setup_revisions (id, setup_id, revision_number, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![revision_id, setup.id, revision_number, now],
            )?;
            tx.execute(
                "INSERT INTO setup_revision_skills (revision_id, skill_id, tool, created_at)
                 SELECT ?1, skill_id, tool, ?2
                 FROM setup_revision_skills WHERE revision_id = ?3",
                params![revision_id, now, setup.revision_id],
            )?;
            mutate(&tx, &revision_id, now)?;
            tx.execute(
                "UPDATE setups SET current_revision_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![revision_id, now, setup.id],
            )?;
            tx.commit()?;
            Ok(())
        })?;
        Ok(revision_id)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let ids = self.store.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT id FROM projects ORDER BY LOWER(path)")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(anyhow::Error::from)
        })?;
        ids.iter().map(|id| self.project_by_id(id)).collect()
    }

    pub fn add_project(&self, path: &Path) -> Result<Project> {
        let path = normalize_project_path(path)?;
        let path_string = path.to_string_lossy().to_string();
        let existing = self.find_project_by_path(&path_string)?;
        if let Some(existing) = existing {
            return self.project_by_id(&existing);
        }
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects
                 (id, path, assigned_setup_revision_id, applied_setup_revision_id,
                  created_at, updated_at)
                 VALUES (?1, ?2, NULL, NULL, ?3, ?3)",
                params![id, path_string, now],
            )?;
            Ok(())
        })?;
        self.project_by_id(&id)
    }

    pub fn assign_setup(&self, project_path: &Path, setup_selector: &str) -> Result<Project> {
        let project = self.resolve_project(project_path)?;
        let setup = self.resolve_setup(setup_selector)?;
        self.store.with_conn(|conn| {
            conn.execute(
                "UPDATE projects
                 SET assigned_setup_revision_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![setup.revision_id, now_ms(), project.id],
            )?;
            Ok(())
        })?;
        self.project_by_id(&project.id)
    }

    pub fn status(&self, project_path: &Path) -> Result<ProjectStatus> {
        let project = self.resolve_project(project_path)?;
        let pending_plan = project
            .assigned_setup
            .clone()
            .map(|setup| {
                self.reconciliation_for_setup(project.clone(), setup)
                    .map(|item| item.plan)
            })
            .transpose()?;
        Ok(ProjectStatus {
            project,
            pending_plan,
        })
    }

    pub fn plan(&self, project_path: &Path, setup_selector: Option<&str>) -> Result<ApplyPlan> {
        let project = self.resolve_project(project_path)?;
        let setup = match setup_selector {
            Some(selector) => self.resolve_setup(selector)?,
            None => project
                .assigned_setup
                .clone()
                .context("project has no assigned setup")?,
        };
        Ok(self.reconciliation_for_setup(project, setup)?.plan)
    }

    pub fn sync(&self, project_path: &Path, setup_selector: Option<&str>) -> Result<ApplyResult> {
        let project = self.resolve_project(project_path)?;
        let setup = match setup_selector {
            Some(selector) => self.resolve_setup(selector)?,
            None => project
                .assigned_setup
                .clone()
                .context("project has no assigned setup")?,
        };
        let reconciliation = self.reconciliation_for_setup(project.clone(), setup.clone())?;
        ensure_no_conflicts(&reconciliation.plan)?;

        let operation_id = Uuid::new_v4().to_string();
        let snapshots = reconciliation
            .current_records
            .iter()
            .map(TargetSnapshot::from)
            .collect::<Vec<_>>();
        let snapshots_json = serde_json::to_string(&snapshots)?;
        let execution = self.execute_files(&reconciliation)?;
        let db_result = self.store.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            replace_project_targets(
                &tx,
                &project.path,
                &reconciliation.desired,
                &execution.modes,
            )?;
            tx.execute(
                "INSERT INTO apply_operations (
                   id, project_id, previous_assigned_revision_id, previous_applied_revision_id,
                   applied_revision_id, previous_targets_json, created_at, rolled_back_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
                params![
                    operation_id,
                    project.id,
                    project
                        .applied_setup
                        .as_ref()
                        .map(|item| item.revision_id.as_str()),
                    project
                        .applied_setup
                        .as_ref()
                        .map(|item| item.revision_id.as_str()),
                    setup.revision_id,
                    snapshots_json,
                    now_ms()
                ],
            )?;
            tx.execute(
                "UPDATE projects
                 SET assigned_setup_revision_id = ?1, applied_setup_revision_id = ?1,
                     updated_at = ?2
                 WHERE id = ?3",
                params![setup.revision_id, now_ms(), project.id],
            )?;
            tx.commit()?;
            Ok(())
        });
        if let Err(err) = db_result {
            let restore = self.undo_files(&execution);
            return match restore {
                Ok(()) => Err(err.context("save applied setup state")),
                Err(restore_err) => Err(err.context(format!(
                    "save applied setup state; filesystem restore also failed: {restore_err:#}"
                ))),
            };
        }

        Ok(ApplyResult {
            plan: reconciliation.plan,
            operation_id,
        })
    }

    pub fn rollback(&self, project_path: &Path) -> Result<ApplyResult> {
        let project = self.resolve_project(project_path)?;
        let operation = self.latest_operation(&project.id)?;
        let desired_records = operation
            .previous_targets
            .iter()
            .map(SkillTargetRecord::from)
            .collect::<Vec<_>>();
        let setup = operation
            .previous_applied_revision_id
            .as_deref()
            .map(|id| self.setup_by_revision_id(id))
            .transpose()?;
        let reconciliation = self.reconciliation_from_records(
            project.clone(),
            setup.clone(),
            desired_records.clone(),
        )?;
        ensure_no_conflicts(&reconciliation.plan)?;
        let execution = self.execute_files(&reconciliation)?;
        let db_result = self.store.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "DELETE FROM skill_targets WHERE scope = 'project' AND project_path = ?1",
                params![project.path],
            )?;
            for record in &operation.previous_targets {
                let record = SkillTargetRecord::from(record);
                insert_target(&tx, &record)?;
            }
            tx.execute(
                "UPDATE projects
                 SET assigned_setup_revision_id = ?1, applied_setup_revision_id = ?2,
                     updated_at = ?3
                 WHERE id = ?4",
                params![
                    operation.previous_assigned_revision_id,
                    operation.previous_applied_revision_id,
                    now_ms(),
                    project.id
                ],
            )?;
            tx.execute(
                "UPDATE apply_operations SET rolled_back_at = ?1 WHERE id = ?2",
                params![now_ms(), operation.id],
            )?;
            tx.commit()?;
            Ok(())
        });
        if let Err(err) = db_result {
            let restore = self.undo_files(&execution);
            return match restore {
                Ok(()) => Err(err.context("save rollback state")),
                Err(restore_err) => Err(err.context(format!(
                    "save rollback state; filesystem restore also failed: {restore_err:#}"
                ))),
            };
        }

        Ok(ApplyResult {
            plan: reconciliation.plan,
            operation_id: operation.id,
        })
    }

    fn resolve_setup(&self, selector: &str) -> Result<SetupSummary> {
        self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT s.id, s.name, r.id, r.revision_number, COUNT(rs.skill_id),
                        s.created_at, s.updated_at
                 FROM setups s
                 INNER JOIN setup_revisions r ON r.id = s.current_revision_id
                 LEFT JOIN setup_revision_skills rs ON rs.revision_id = r.id
                 WHERE s.id = ?1 OR s.name = ?1 COLLATE NOCASE
                 GROUP BY s.id, s.name, r.id, r.revision_number, s.created_at, s.updated_at
                 LIMIT 1",
                params![selector],
                setup_from_row,
            )
            .optional()?
            .with_context(|| format!("setup not found: {selector}"))
        })
    }

    fn setup_by_revision_id(&self, revision_id: &str) -> Result<SetupSummary> {
        self.store
            .with_conn(|conn| setup_by_revision_id(conn, revision_id))
    }

    fn resolve_skill(&self, selector: &str) -> Result<SkillRecord> {
        if let Some(skill) = self.store.get_skill_by_id(selector)? {
            return Ok(skill);
        }
        let matches = self
            .store
            .list_skills()?
            .into_iter()
            .filter(|skill| skill.name.eq_ignore_ascii_case(selector))
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => anyhow::bail!("skill not found: {selector}"),
            [skill] => Ok(skill.clone()),
            _ => anyhow::bail!("skill name is ambiguous; use its id: {selector}"),
        }
    }

    fn resolve_project_tool(&self, key: &str) -> Result<ResolvedTool> {
        let config = load_tool_config(&self.store)?;
        if let Some(adapter) = adapter_by_key(key) {
            if !is_builtin_tool_enabled(&config, key) {
                anyhow::bail!("tool is disabled in Skills Hub: {key}");
            }
            if !supports_project_scope(&adapter) {
                anyhow::bail!("tool does not support project-scoped skills: {key}");
            }
            return Ok(ResolvedTool {
                key: key.to_string(),
                relative_skills_dir: PathBuf::from(project_relative_skills_dir(&adapter)),
                sync_mode: if key == "cursor" {
                    SyncMode::Copy
                } else {
                    SyncMode::Auto
                },
            });
        }

        let custom = config
            .custom_tools
            .into_iter()
            .find(|tool| tool.key == key && tool.enabled)
            .with_context(|| format!("unknown or disabled tool: {key}"))?;
        let relative = custom
            .project_skills_dir
            .with_context(|| format!("tool does not support project-scoped skills: {key}"))?;
        Ok(ResolvedTool {
            key: key.to_string(),
            relative_skills_dir: validate_relative_path(&relative)?,
            sync_mode: custom.sync_mode,
        })
    }

    fn resolve_project(&self, path: &Path) -> Result<Project> {
        let path = normalize_project_path(path)?;
        let path_string = path.to_string_lossy().to_string();
        let id = self
            .find_project_by_path(&path_string)?
            .with_context(|| format!("project is not registered: {path_string}"))?;
        self.project_by_id(&id)
    }

    fn find_project_by_path(&self, path: &str) -> Result<Option<String>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT id FROM projects WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
        })
    }

    fn project_by_id(&self, id: &str) -> Result<Project> {
        self.store.with_conn(|conn| {
            let row = conn
                .query_row(
                    "SELECT id, path, assigned_setup_revision_id, applied_setup_revision_id,
                            created_at, updated_at
                     FROM projects WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    },
                )
                .optional()?
                .with_context(|| format!("project not found: {id}"))?;
            let assigned_setup = row
                .2
                .as_deref()
                .map(|revision_id| setup_by_revision_id(conn, revision_id))
                .transpose()?;
            let applied_setup = row
                .3
                .as_deref()
                .map(|revision_id| setup_by_revision_id(conn, revision_id))
                .transpose()?;
            Ok(Project {
                id: row.0,
                path: row.1,
                assigned_setup,
                applied_setup,
                created_at: row.4,
                updated_at: row.5,
            })
        })
    }

    fn reconciliation_for_setup(
        &self,
        project: Project,
        setup: SetupSummary,
    ) -> Result<Reconciliation> {
        let detail = self.setup_detail(&setup)?;
        let mut desired_by_path = BTreeMap::<String, DesiredGroup>::new();
        for item in detail.items {
            let skill = self.resolve_skill(&item.skill_id)?;
            if !skill.enabled {
                anyhow::bail!("setup contains a disabled skill: {}", skill.name);
            }
            let source = PathBuf::from(&skill.central_path);
            if !source.is_dir() {
                anyhow::bail!("managed skill directory not found: {:?}", source);
            }
            validate_skill_name(&skill.name)?;
            let tool = self.resolve_project_tool(&item.tool)?;
            let relative = validate_relative_path(&tool.relative_skills_dir.to_string_lossy())?;
            let target = PathBuf::from(&project.path)
                .join(relative)
                .join(&skill.name);
            let key = path_key(&target);
            if let Some(existing) = desired_by_path.get_mut(&key) {
                if existing.skill.id != skill.id {
                    anyhow::bail!(
                        "setup maps different skills to the same target: {:?}",
                        target
                    );
                }
                existing.sync_mode = merge_sync_modes(existing.sync_mode, tool.sync_mode)?;
                if !existing.tools.contains(&tool.key) {
                    existing.tools.push(tool.key);
                    existing.tools.sort();
                }
            } else {
                desired_by_path.insert(
                    key,
                    DesiredGroup {
                        skill,
                        tools: vec![tool.key],
                        target_path: target,
                        sync_mode: tool.sync_mode,
                    },
                );
            }
        }
        self.build_reconciliation(project, Some(setup), desired_by_path)
    }

    fn reconciliation_from_records(
        &self,
        project: Project,
        setup: Option<SetupSummary>,
        records: Vec<SkillTargetRecord>,
    ) -> Result<Reconciliation> {
        let mut desired_by_path = BTreeMap::<String, DesiredGroup>::new();
        for record in records {
            let skill = self.resolve_skill(&record.skill_id)?;
            let target = PathBuf::from(&record.target_path);
            let project_root = Path::new(&project.path);
            if record.scope != "project"
                || record.project_path.as_deref() != Some(project.path.as_str())
                || !target.starts_with(project_root)
                || target == project_root
            {
                anyhow::bail!(
                    "revision contains a target outside its project: {}",
                    target.display()
                );
            }
            if !Path::new(&skill.central_path).is_dir() {
                anyhow::bail!("revision skill source is missing: {}", skill.central_path);
            }
            let mode = parse_sync_mode(&record.mode)?;
            let key = path_key(&target);
            if let Some(existing) = desired_by_path.get_mut(&key) {
                if existing.skill.id != skill.id {
                    anyhow::bail!(
                        "revision maps different skills to the same target: {:?}",
                        target
                    );
                }
                existing.sync_mode = merge_sync_modes(existing.sync_mode, mode)?;
                if !existing.tools.contains(&record.tool) {
                    existing.tools.push(record.tool);
                    existing.tools.sort();
                }
            } else {
                desired_by_path.insert(
                    key,
                    DesiredGroup {
                        skill,
                        tools: vec![record.tool],
                        target_path: target,
                        sync_mode: mode,
                    },
                );
            }
        }
        self.build_reconciliation(project, setup, desired_by_path)
    }

    fn build_reconciliation(
        &self,
        project: Project,
        setup: Option<SetupSummary>,
        desired_by_path: BTreeMap<String, DesiredGroup>,
    ) -> Result<Reconciliation> {
        let current_records = self.project_targets(&project.path)?;
        let mut grouped_records = BTreeMap::<String, Vec<SkillTargetRecord>>::new();
        for record in &current_records {
            grouped_records
                .entry(path_key(Path::new(&record.target_path)))
                .or_default()
                .push(record.clone());
        }

        let mut current_by_path = BTreeMap::<String, CurrentGroup>::new();
        let mut conflicts = Vec::new();
        for (key, records) in grouped_records {
            match self.validate_current_group(&project, records) {
                Ok(group) => {
                    current_by_path.insert(key, group);
                }
                Err(err) => conflicts.push(err.to_string()),
            }
        }

        let mut operations = Vec::new();
        let mut actions = Vec::new();
        for (key, desired) in &desired_by_path {
            if let Some(current) = current_by_path.remove(key) {
                let current_skill_id = current
                    .skill
                    .as_ref()
                    .map(|skill| skill.id.as_str())
                    .unwrap_or_default();
                if current_skill_id != desired.skill.id
                    || (current.exists
                        && !sync_mode_satisfies(current.actual_mode, desired.sync_mode))
                {
                    actions.push(action_for_desired(
                        ApplyActionKind::Replace,
                        desired,
                        "replace the tracked target",
                    ));
                    operations.push(PhysicalOperation::Replace(current, desired.clone()));
                } else if !current.exists {
                    actions.push(action_for_desired(
                        ApplyActionKind::Add,
                        desired,
                        "restore the missing tracked target",
                    ));
                    operations.push(PhysicalOperation::Add(desired.clone()));
                } else {
                    let mut current_tools = current
                        .records
                        .iter()
                        .map(|record| record.tool.clone())
                        .collect::<Vec<_>>();
                    current_tools.sort();
                    current_tools.dedup();
                    let kind = if current_tools == desired.tools {
                        ApplyActionKind::Keep
                    } else {
                        ApplyActionKind::UpdateRecords
                    };
                    actions.push(action_for_desired(
                        kind,
                        desired,
                        if kind == ApplyActionKind::Keep {
                            "already in the desired state"
                        } else {
                            "update tool ownership records for the shared target"
                        },
                    ));
                    operations.push(PhysicalOperation::Keep(current, desired.clone()));
                }
            } else if std::fs::symlink_metadata(&desired.target_path).is_ok() {
                conflicts.push(format!(
                    "unmanaged target already exists and will not be replaced: {}",
                    desired.target_path.display()
                ));
            } else {
                actions.push(action_for_desired(
                    ApplyActionKind::Add,
                    desired,
                    "create the managed target",
                ));
                operations.push(PhysicalOperation::Add(desired.clone()));
            }
        }

        for current in current_by_path.into_values() {
            let skill = current
                .skill
                .as_ref()
                .context("validated target is missing its skill")?;
            let mut tools = current
                .records
                .iter()
                .map(|record| record.tool.clone())
                .collect::<Vec<_>>();
            tools.sort();
            tools.dedup();
            actions.push(ApplyAction {
                kind: ApplyActionKind::Remove,
                skill_id: skill.id.clone(),
                skill_name: skill.name.clone(),
                tools,
                target_path: current.target_path.to_string_lossy().to_string(),
                detail: "remove the tracked target".to_string(),
            });
            operations.push(PhysicalOperation::Remove(current));
        }

        actions.sort_by(|left, right| left.target_path.cmp(&right.target_path));
        let has_changes = actions
            .iter()
            .any(|action| action.kind != ApplyActionKind::Keep);
        Ok(Reconciliation {
            plan: ApplyPlan {
                project,
                setup,
                actions,
                conflicts,
                has_changes,
            },
            desired: desired_by_path.into_values().collect(),
            current_records,
            operations,
        })
    }

    fn validate_current_group(
        &self,
        project: &Project,
        records: Vec<SkillTargetRecord>,
    ) -> Result<CurrentGroup> {
        let first = records.first().context("empty target record group")?;
        if records
            .iter()
            .any(|record| record.skill_id != first.skill_id)
        {
            anyhow::bail!(
                "multiple tracked skills claim the same target: {}",
                first.target_path
            );
        }
        let target = PathBuf::from(&first.target_path);
        let project_root = PathBuf::from(&project.path);
        if !target.starts_with(&project_root) || target == project_root {
            anyhow::bail!(
                "tracked target is outside its project and will not be touched: {}",
                target.display()
            );
        }
        let external_count = self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM skill_targets
                 WHERE target_path = ?1
                   AND NOT (scope = 'project' AND project_path = ?2)",
                params![first.target_path, project.path],
                |row| row.get::<_, i64>(0),
            )
            .map_err(Into::into)
        })?;
        if external_count > 0 {
            anyhow::bail!(
                "tracked target is shared with records outside this project: {}",
                target.display()
            );
        }

        let exists = std::fs::symlink_metadata(&target).is_ok();
        let skill = self.store.get_skill_by_id(&first.skill_id)?;
        let fallback_mode = parse_sync_mode(&first.mode).unwrap_or(SyncMode::Auto);
        if !exists {
            return Ok(CurrentGroup {
                records,
                skill,
                target_path: target,
                exists: false,
                actual_mode: fallback_mode,
            });
        }
        let skill = skill.with_context(|| {
            format!(
                "tracked target references a missing skill and will not be touched: {}",
                target.display()
            )
        })?;
        let source = PathBuf::from(&skill.central_path);
        if !source.is_dir() {
            anyhow::bail!(
                "tracked target source is missing and will not be touched: {}",
                source.display()
            );
        }
        let actual_mode =
            detect_owned_mode(&source, &target, fallback_mode).with_context(|| {
                format!(
                    "tracked target has drifted and will not be replaced or removed: {}",
                    target.display()
                )
            })?;
        Ok(CurrentGroup {
            records,
            skill: Some(skill),
            target_path: target,
            exists: true,
            actual_mode,
        })
    }

    fn project_targets(&self, project_path: &str) -> Result<Vec<SkillTargetRecord>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, skill_id, tool, scope, project_path, target_path, mode,
                        status, last_error, synced_at
                 FROM skill_targets
                 WHERE scope = 'project' AND project_path = ?1
                 ORDER BY target_path, tool",
            )?;
            let rows = stmt.query_map(params![project_path], target_from_row)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into)
        })
    }

    fn execute_files(&self, reconciliation: &Reconciliation) -> Result<Execution> {
        let mut execution = Execution {
            modes: HashMap::new(),
            added_paths: Vec::new(),
            removed_groups: Vec::new(),
        };
        let result = (|| -> Result<()> {
            for operation in &reconciliation.operations {
                match operation {
                    PhysicalOperation::Remove(current) | PhysicalOperation::Replace(current, _) => {
                        if current.exists {
                            remove_path_any(&current.target_path)?;
                            execution.removed_groups.push(current.clone());
                        }
                    }
                    PhysicalOperation::Add(_) | PhysicalOperation::Keep(_, _) => {}
                }
            }
            for operation in &reconciliation.operations {
                match operation {
                    PhysicalOperation::Add(desired) | PhysicalOperation::Replace(_, desired) => {
                        let outcome = sync_desired(desired)?;
                        execution
                            .modes
                            .insert(path_key(&desired.target_path), outcome.mode_used);
                        execution.added_paths.push(desired.target_path.clone());
                    }
                    PhysicalOperation::Keep(current, desired) => {
                        execution
                            .modes
                            .insert(path_key(&desired.target_path), current.actual_mode);
                    }
                    PhysicalOperation::Remove(_) => {}
                }
            }
            Ok(())
        })();
        if let Err(err) = result {
            let restore = self.undo_files(&execution);
            return match restore {
                Ok(()) => Err(err),
                Err(restore_err) => {
                    Err(err.context(format!("filesystem restore also failed: {restore_err:#}")))
                }
            };
        }
        Ok(execution)
    }

    fn undo_files(&self, execution: &Execution) -> Result<()> {
        let mut failures = Vec::new();
        for path in execution.added_paths.iter().rev() {
            if let Err(err) = remove_path_any(path) {
                failures.push(format!("remove {}: {err:#}", path.display()));
            }
        }
        for group in execution.removed_groups.iter().rev() {
            let Some(skill) = &group.skill else {
                continue;
            };
            if let Err(err) = sync_dir_with_mode_with_overwrite(
                group.actual_mode,
                Path::new(&skill.central_path),
                &group.target_path,
                false,
            ) {
                failures.push(format!("restore {}: {err:#}", group.target_path.display()));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            anyhow::bail!(failures.join("; "))
        }
    }

    fn latest_operation(&self, project_id: &str) -> Result<ApplyOperation> {
        self.store.with_conn(|conn| {
            let raw = conn
                .query_row(
                    "SELECT id, previous_assigned_revision_id, previous_applied_revision_id,
                            previous_targets_json
                     FROM apply_operations
                     WHERE project_id = ?1 AND rolled_back_at IS NULL
                     ORDER BY created_at DESC, rowid DESC
                     LIMIT 1",
                    params![project_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()?
                .context("no applied revision is available to roll back")?;
            Ok(ApplyOperation {
                id: raw.0,
                previous_assigned_revision_id: raw.1,
                previous_applied_revision_id: raw.2,
                previous_targets: serde_json::from_str(&raw.3)
                    .context("read previous target snapshot")?,
            })
        })
    }
}

pub fn default_cli_db_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("AHM_DB") {
        return Ok(PathBuf::from(path));
    }
    let data_dir = dirs::data_dir().context("failed to resolve application data directory")?;
    Ok(data_dir.join(APP_IDENTIFIER).join(DB_FILE_NAME))
}

fn setup_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SetupSummary> {
    Ok(SetupSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        revision_id: row.get(2)?,
        revision_number: row.get(3)?,
        skill_target_count: row.get::<_, i64>(4)? as usize,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn setup_by_revision_id(conn: &rusqlite::Connection, revision_id: &str) -> Result<SetupSummary> {
    conn.query_row(
        "SELECT s.id, s.name, r.id, r.revision_number, COUNT(rs.skill_id),
                s.created_at, s.updated_at
         FROM setup_revisions r
         INNER JOIN setups s ON s.id = r.setup_id
         LEFT JOIN setup_revision_skills rs ON rs.revision_id = r.id
         WHERE r.id = ?1
         GROUP BY s.id, s.name, r.id, r.revision_number, s.created_at, s.updated_at",
        params![revision_id],
        setup_from_row,
    )
    .optional()?
    .with_context(|| format!("setup revision not found: {revision_id}"))
}

fn target_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkillTargetRecord> {
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
}

fn replace_project_targets(
    conn: &rusqlite::Connection,
    project_path: &str,
    desired: &[DesiredGroup],
    modes: &HashMap<String, SyncMode>,
) -> Result<()> {
    conn.execute(
        "DELETE FROM skill_targets WHERE scope = 'project' AND project_path = ?1",
        params![project_path],
    )?;
    for group in desired {
        let mode = modes
            .get(&path_key(&group.target_path))
            .copied()
            .unwrap_or(group.sync_mode);
        for tool in &group.tools {
            insert_target(
                conn,
                &SkillTargetRecord {
                    id: Uuid::new_v4().to_string(),
                    skill_id: group.skill.id.clone(),
                    tool: tool.clone(),
                    scope: "project".to_string(),
                    project_path: Some(project_path.to_string()),
                    target_path: group.target_path.to_string_lossy().to_string(),
                    mode: sync_mode_name(mode).to_string(),
                    status: "ok".to_string(),
                    last_error: None,
                    synced_at: Some(now_ms()),
                },
            )?;
        }
    }
    Ok(())
}

fn insert_target(conn: &rusqlite::Connection, record: &SkillTargetRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO skill_targets (
           id, skill_id, tool, scope, project_path, target_path, mode, status, last_error, synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
}

fn sync_desired(desired: &DesiredGroup) -> Result<SyncOutcome> {
    sync_dir_with_mode_with_overwrite(
        desired.sync_mode,
        Path::new(&desired.skill.central_path),
        &desired.target_path,
        false,
    )
    .with_context(|| {
        format!(
            "sync skill {} to {}",
            desired.skill.name,
            desired.target_path.display()
        )
    })
}

fn detect_owned_mode(source: &Path, target: &Path, recorded: SyncMode) -> Result<SyncMode> {
    if let Ok(link_target) = std::fs::read_link(target) {
        let resolved = if link_target.is_absolute() {
            link_target
        } else {
            target
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(link_target)
        };
        if paths_equivalent(&resolved, source) {
            return Ok(match recorded {
                SyncMode::Junction => SyncMode::Junction,
                _ => SyncMode::Symlink,
            });
        }
        anyhow::bail!("link points to a different source");
    }
    if matches!(recorded, SyncMode::Symlink | SyncMode::Junction)
        && paths_equivalent(target, source)
    {
        return Ok(recorded);
    }
    if target.is_dir() && hash_dir(source)? == hash_dir(target)? {
        return Ok(SyncMode::Copy);
    }
    anyhow::bail!("target content differs from its managed source")
}

fn paths_equivalent(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => {
            path_key(&clean_canonical_path(left)) == path_key(&clean_canonical_path(right))
        }
        _ => path_key(left) == path_key(right),
    }
}

fn action_for_desired(kind: ApplyActionKind, desired: &DesiredGroup, detail: &str) -> ApplyAction {
    ApplyAction {
        kind,
        skill_id: desired.skill.id.clone(),
        skill_name: desired.skill.name.clone(),
        tools: desired.tools.clone(),
        target_path: desired.target_path.to_string_lossy().to_string(),
        detail: detail.to_string(),
    }
}

fn ensure_no_conflicts(plan: &ApplyPlan) -> Result<()> {
    if plan.conflicts.is_empty() {
        Ok(())
    } else {
        anyhow::bail!("sync conflicts:\n- {}", plan.conflicts.join("\n- "))
    }
}

fn normalize_name(value: &str, kind: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        anyhow::bail!("{kind} name cannot be empty");
    }
    Ok(value.to_string())
}

fn validate_skill_name(name: &str) -> Result<()> {
    let path = Path::new(name);
    if name.trim().is_empty() || path.components().count() != 1 || matches!(name, "." | "..") {
        anyhow::bail!("skill name is not a safe path component: {name}");
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        anyhow::bail!("project skills directory must be a safe relative path: {value}");
    }
    Ok(path)
}

fn normalize_project_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    if !absolute.is_dir() {
        anyhow::bail!("project directory does not exist: {}", absolute.display());
    }
    Ok(clean_canonical_path(absolute.canonicalize().with_context(
        || format!("resolve project path {}", absolute.display()),
    )?))
}

#[cfg(windows)]
fn clean_canonical_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(not(windows))]
fn clean_canonical_path(path: PathBuf) -> PathBuf {
    path
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    value
}

fn merge_sync_modes(left: SyncMode, right: SyncMode) -> Result<SyncMode> {
    match (left, right) {
        (SyncMode::Auto, mode) | (mode, SyncMode::Auto) => Ok(mode),
        (SyncMode::Copy, _) | (_, SyncMode::Copy) => Ok(SyncMode::Copy),
        (left, right) if left == right => Ok(left),
        _ => anyhow::bail!("tools sharing a target request incompatible sync modes"),
    }
}

fn sync_mode_satisfies(actual: SyncMode, requested: SyncMode) -> bool {
    requested == SyncMode::Auto || actual == requested
}

fn parse_sync_mode(value: &str) -> Result<SyncMode> {
    match value {
        "auto" => Ok(SyncMode::Auto),
        "symlink" => Ok(SyncMode::Symlink),
        "junction" => Ok(SyncMode::Junction),
        "copy" => Ok(SyncMode::Copy),
        _ => anyhow::bail!("unknown sync mode: {value}"),
    }
}

fn sync_mode_name(mode: SyncMode) -> &'static str {
    match mode {
        SyncMode::Auto => "auto",
        SyncMode::Symlink => "symlink",
        SyncMode::Junction => "junction",
        SyncMode::Copy => "copy",
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
