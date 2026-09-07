use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::path::{Component, Path, PathBuf};

use ahm_domain::PortableSetupRevision;
use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::central_repo::{ensure_central_repo, resolve_central_repo_path_for_home};
use super::content_hash::hash_dir;
use super::onboarding::{build_onboarding_plan_for_home, OnboardingVariant};
use super::project_lock::ProjectOperationLock;
use super::skill_store::{SkillRecord, SkillStore, SkillTargetRecord};
use super::sync_engine::{
    copy_dir_recursive, remove_path_any, sync_dir_with_mode_with_overwrite, SyncMode, SyncOutcome,
};
use super::tool_adapters::{
    adapter_by_key, default_tool_adapters, is_builtin_tool_enabled, load_tool_config,
    project_relative_skills_dir, scan_tool_dir, supports_project_scope,
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
    pub is_default: bool,
    pub initial_revision_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SetupItem {
    pub skill_id: String,
    pub skill_name: String,
    pub tool: String,
    pub target_name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SetupDetail {
    #[serde(flatten)]
    pub setup: SetupSummary,
    pub items: Vec<SetupItem>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DefaultSetupCandidateKind {
    KnownSkill,
    PluginSkill,
    LocalContent,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DefaultSetupCandidate {
    pub selection_key: String,
    pub name: String,
    pub tool: String,
    pub source_tool: String,
    pub source_path: String,
    pub fingerprint: Option<String>,
    pub classification: DefaultSetupCandidateKind,
    pub has_conflict: bool,
    pub is_link: bool,
    pub plugin_name: Option<String>,
    pub plugin_version: Option<String>,
    pub capturable: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DefaultSetupPreview {
    pub project_path: String,
    pub total_tools_scanned: usize,
    pub total_skills_found: usize,
    pub candidates: Vec<DefaultSetupCandidate>,
    pub existing_default: Option<SetupSummary>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DefaultSetupCaptureResult {
    pub setup: SetupDetail,
    pub captured_candidates: usize,
    pub snapshot_count: usize,
    pub excluded_candidates: usize,
    pub external_candidates: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub default_setup: Option<SetupSummary>,
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
    actions_completed: u64,
}

#[derive(Debug)]
struct FileExecutionFailure {
    error: anyhow::Error,
    cancelled: bool,
    actions_completed: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct FilesystemRecoveryPlan {
    steps: Vec<FilesystemRecoveryStep>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct FilesystemRecoveryStep {
    target_path: String,
    previous: Option<FilesystemRecoverySource>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct FilesystemRecoverySource {
    central_path: String,
    mode: SyncMode,
}

#[derive(Clone, Debug)]
struct FilesystemRecoveryJournal {
    operation_id: String,
    recovery_plan: FilesystemRecoveryPlan,
    actions_completed: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RecoveredOperation {
    pub operation_id: String,
    pub actions_completed: u64,
}

#[derive(Debug)]
pub(crate) enum OperationInterruption {
    CancelledAndRestored(RecoveredOperation),
    FailedAndRestored {
        operation: RecoveredOperation,
        message: String,
    },
    NeedsAttention {
        operation: RecoveredOperation,
        message: String,
        cancelled: bool,
    },
}

impl fmt::Display for OperationInterruption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CancelledAndRestored(_) => formatter
                .write_str("operation was cancelled and its filesystem changes were restored"),
            Self::FailedAndRestored { message, .. } => {
                write!(
                    formatter,
                    "operation failed and its filesystem changes were restored: {message}"
                )
            }
            Self::NeedsAttention { message, .. } => {
                write!(formatter, "filesystem recovery needs attention: {message}")
            }
        }
    }
}

impl std::error::Error for OperationInterruption {}

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

    pub fn stage_portable_revision(
        &self,
        revision: &PortableSetupRevision,
        artifact_cache_root: &Path,
    ) -> Result<String> {
        let setup_id = format!("remote:{}", revision.setup_id.as_str());
        let revision_id = format!("remote:{}", revision.setup_revision_id.as_str());
        let now = now_ms();
        let mut staged_items = Vec::with_capacity(revision.items.len());
        for item in &revision.items {
            validate_skill_name(item.target_name.as_str())?;
            self.resolve_project_tool(item.tool_id.as_str())?;
            let digest = item
                .content_digest
                .as_str()
                .strip_prefix("sha256:")
                .context("portable artifact digest must use sha256")?;
            if digest.len() != 64
                || !digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                anyhow::bail!("portable artifact digest is invalid");
            }
            let central_path = artifact_cache_root.join(digest);
            if !central_path.is_dir() || hash_dir(&central_path)? != digest {
                anyhow::bail!("artifact is missing from the verified local cache: {digest}");
            }
            staged_items.push((
                format!("remote-artifact-{digest}"),
                item.target_name.as_str().to_owned(),
                item.portable_source.clone(),
                central_path.to_string_lossy().into_owned(),
                digest.to_owned(),
                item.tool_id.as_str().to_owned(),
                item.target_name.as_str().to_owned(),
            ));
        }
        self.store.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT OR IGNORE INTO setups
                 (id, name, current_revision_id, created_at, updated_at, kind, initial_revision_id)
                 VALUES (?1, ?2, NULL, ?3, ?3, 'custom', NULL)",
                params![
                    setup_id,
                    format!("Remote / {}", revision.setup_id.as_str()),
                    now
                ],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO setup_revisions
                 (id, setup_id, revision_number, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![revision_id, setup_id, revision.revision_number, now],
            )?;
            for (skill_id, name, source_ref, central_path, digest, tool, target_name) in
                &staged_items
            {
                tx.execute(
                    "INSERT INTO skills
                     (id, name, description, source_type, source_ref, source_subpath,
                      source_revision, central_path, content_hash, created_at, updated_at,
                      last_sync_at, last_seen_at, enabled, status)
                     VALUES (?1, ?2, NULL, 'remote_cache', ?3, NULL, ?4, ?5, ?6,
                             ?7, ?7, NULL, ?7, 1, 'ok')
                     ON CONFLICT(id) DO UPDATE SET
                       name = excluded.name, source_ref = excluded.source_ref,
                       source_revision = excluded.source_revision,
                       central_path = excluded.central_path, content_hash = excluded.content_hash,
                       updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at,
                       enabled = 1, status = 'ok'",
                    params![
                        skill_id,
                        name,
                        source_ref,
                        revision.setup_revision_id.as_str(),
                        central_path,
                        digest,
                        now
                    ],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO setup_revision_skills
                     (revision_id, skill_id, tool, created_at, target_name)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![revision_id, skill_id, tool, now, target_name],
                )?;
            }
            let stored_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM setup_revision_skills WHERE revision_id = ?1",
                params![revision_id],
                |row| row.get(0),
            )?;
            if stored_count != staged_items.len() as i64 {
                anyhow::bail!("portable Setup revision changed after it was staged");
            }
            tx.execute(
                "UPDATE setups SET current_revision_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![revision_id, now, setup_id],
            )?;
            tx.commit()?;
            Ok(())
        })?;
        Ok(setup_id)
    }

    pub fn preview_default_setup(
        &self,
        home: &Path,
        project_path: &Path,
    ) -> Result<DefaultSetupPreview> {
        let project = self.resolve_project(project_path)?;
        let home = normalize_existing_directory(home, "home directory")?;
        let central_repo = resolve_central_repo_path_for_home(&self.store, &home)?;
        let plan = build_onboarding_plan_for_home(&self.store, &home, &central_repo)?;
        let known_hashes = self
            .store
            .list_skills()?
            .into_iter()
            .filter_map(|skill| skill.content_hash)
            .collect::<HashSet<_>>();
        let mut candidates = self.managed_default_candidates(&project.path)?;
        for group in plan.groups {
            for variant in group.variants {
                candidates.push(self.default_candidate(variant, group.has_conflict, &known_hashes));
            }
        }
        let project_variants = self.project_onboarding_variants(&home, Path::new(&project.path))?;
        let project_tool_count = project_variants
            .iter()
            .map(|variant| variant.tool.as_str())
            .collect::<HashSet<_>>()
            .len();
        for variant in project_variants {
            candidates.push(self.default_candidate(variant, false, &known_hashes));
        }
        let mut fingerprints_by_name = HashMap::<String, HashSet<String>>::new();
        for candidate in &candidates {
            if let Some(fingerprint) = &candidate.fingerprint {
                fingerprints_by_name
                    .entry(candidate.name.to_ascii_lowercase())
                    .or_default()
                    .insert(fingerprint.clone());
            }
        }
        for candidate in &mut candidates {
            candidate.has_conflict = fingerprints_by_name
                .get(&candidate.name.to_ascii_lowercase())
                .is_some_and(|fingerprints| fingerprints.len() > 1);
        }
        let mut unique_candidates = BTreeMap::new();
        for candidate in candidates {
            unique_candidates
                .entry(candidate.selection_key.clone())
                .or_insert(candidate);
        }
        let mut candidates = unique_candidates.into_values().collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.tool.cmp(&right.tool))
                .then_with(|| left.source_path.cmp(&right.source_path))
        });
        Ok(DefaultSetupPreview {
            project_path: project.path,
            total_tools_scanned: plan.total_tools_scanned + project_tool_count,
            total_skills_found: candidates.len(),
            candidates,
            existing_default: project.default_setup,
        })
    }

    pub fn capture_default_setup(
        &self,
        home: &Path,
        project_path: &Path,
        excluded_selection_keys: &[String],
    ) -> Result<DefaultSetupCaptureResult> {
        let project = self.resolve_project(project_path)?;
        let _operation_lock = ProjectOperationLock::try_acquire(Path::new(&project.path))?;
        let preview = self.preview_default_setup(home, project_path)?;
        if let Some(existing) = preview.existing_default {
            anyhow::bail!(
                "Default Setup already exists at revision {}; edit it by creating a new revision",
                existing.revision_number
            );
        }

        let known_keys = preview
            .candidates
            .iter()
            .map(|candidate| candidate.selection_key.as_str())
            .collect::<HashSet<_>>();
        let exclusions = excluded_selection_keys
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let unknown = exclusions
            .difference(&known_keys)
            .copied()
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            anyhow::bail!("unknown scan selection key(s): {}", unknown.join(", "));
        }

        let selected = preview
            .candidates
            .iter()
            .filter(|candidate| {
                candidate.capturable && !exclusions.contains(candidate.selection_key.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        let excluded_candidates = preview
            .candidates
            .iter()
            .filter(|candidate| exclusions.contains(candidate.selection_key.as_str()))
            .count();
        let external_candidates = preview
            .candidates
            .iter()
            .filter(|candidate| {
                !candidate.capturable && !exclusions.contains(candidate.selection_key.as_str())
            })
            .count();

        let home = normalize_existing_directory(home, "home directory")?;
        let central_repo = resolve_central_repo_path_for_home(&self.store, &home)?;
        ensure_central_repo(&central_repo)?;
        let mut snapshots = HashMap::<String, SkillRecord>::new();
        let mut created_paths = Vec::<PathBuf>::new();
        for candidate in &selected {
            let fingerprint = candidate
                .fingerprint
                .as_ref()
                .context("capturable scan candidate is missing a fingerprint")?;
            if snapshots.contains_key(fingerprint) {
                continue;
            }
            let source = Path::new(&candidate.source_path);
            let snapshot_path = unique_snapshot_path(&central_repo, fingerprint);
            if let Err(error) = copy_dir_recursive(source, &snapshot_path).with_context(|| {
                format!(
                    "capture onboarding snapshot {} -> {}",
                    source.display(),
                    snapshot_path.display()
                )
            }) {
                let _ = remove_path_any(&snapshot_path);
                for path in created_paths.iter().rev() {
                    let _ = remove_path_any(path);
                }
                return Err(error);
            }
            created_paths.push(snapshot_path.clone());
            let now = now_ms();
            snapshots.insert(
                fingerprint.clone(),
                SkillRecord {
                    id: Uuid::new_v4().to_string(),
                    name: candidate.name.clone(),
                    description: None,
                    source_type: "onboarding_snapshot".to_string(),
                    source_ref: Some(candidate.source_path.clone()),
                    source_subpath: None,
                    source_revision: candidate.plugin_version.clone(),
                    central_path: snapshot_path.to_string_lossy().to_string(),
                    content_hash: Some(fingerprint.clone()),
                    created_at: now,
                    updated_at: now,
                    last_sync_at: None,
                    last_seen_at: now,
                    enabled: true,
                    status: "ok".to_string(),
                },
            );
        }

        let setup_id = Uuid::new_v4().to_string();
        let revision_id = Uuid::new_v4().to_string();
        let setup_name = default_setup_name(&project);
        let now = now_ms();
        let db_result = self.store.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for record in snapshots.values() {
                insert_skill_record(&tx, record)?;
            }
            tx.execute(
                "INSERT INTO setups
                 (id, name, current_revision_id, created_at, updated_at, kind,
                  initial_revision_id, default_project_id)
                 VALUES (?1, ?2, NULL, ?3, ?3, 'default', NULL, ?4)",
                params![setup_id, setup_name, now, project.id],
            )
            .context("create the project's Default Setup")?;
            tx.execute(
                "INSERT INTO setup_revisions (id, setup_id, revision_number, created_at)
                 VALUES (?1, ?2, 1, ?3)",
                params![revision_id, setup_id, now],
            )?;
            for candidate in &selected {
                let fingerprint = candidate
                    .fingerprint
                    .as_ref()
                    .context("capturable scan candidate is missing a fingerprint")?;
                let skill = snapshots
                    .get(fingerprint)
                    .context("onboarding snapshot record is missing")?;
                tx.execute(
                    "INSERT OR IGNORE INTO setup_revision_skills
                     (revision_id, skill_id, tool, created_at, target_name)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![revision_id, skill.id, candidate.tool, now, candidate.name],
                )?;
            }
            tx.execute(
                "UPDATE setups
                 SET current_revision_id = ?1, initial_revision_id = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![revision_id, now, setup_id],
            )?;
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('onboarding_completed', 'true')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )?;
            tx.commit()?;
            Ok(())
        });
        if let Err(error) = db_result {
            for path in created_paths.iter().rev() {
                let _ = remove_path_any(path);
            }
            return Err(error.context("save Default Setup snapshot"));
        }

        Ok(DefaultSetupCaptureResult {
            setup: self.get_setup(&setup_id)?,
            captured_candidates: selected.len(),
            snapshot_count: snapshots.len(),
            excluded_candidates,
            external_candidates,
        })
    }

    fn default_candidate(
        &self,
        variant: OnboardingVariant,
        has_conflict: bool,
        known_hashes: &HashSet<String>,
    ) -> DefaultSetupCandidate {
        let source_tool = variant.tool;
        let tool = if source_tool == "claude_code_plugin" {
            "claude_code".to_string()
        } else {
            source_tool.clone()
        };
        let mut reason = variant
            .fingerprint
            .is_none()
            .then(|| "content fingerprint could not be computed".to_string());
        if reason.is_none() {
            reason = self
                .resolve_project_tool(&tool)
                .err()
                .map(|error| error.to_string());
        }
        let source_path = variant.path.to_string_lossy().to_string();
        let classification = if variant.plugin_name.is_some() {
            DefaultSetupCandidateKind::PluginSkill
        } else if variant
            .fingerprint
            .as_ref()
            .is_some_and(|fingerprint| known_hashes.contains(fingerprint))
        {
            DefaultSetupCandidateKind::KnownSkill
        } else {
            DefaultSetupCandidateKind::LocalContent
        };
        DefaultSetupCandidate {
            selection_key: scan_selection_key(&source_tool, &variant.path),
            name: variant.name,
            tool,
            source_tool,
            source_path,
            fingerprint: variant.fingerprint,
            classification,
            has_conflict,
            is_link: variant.is_link,
            plugin_name: variant.plugin_name,
            plugin_version: variant.plugin_version,
            capturable: reason.is_none(),
            reason,
        }
    }

    fn managed_default_candidates(&self, project_path: &str) -> Result<Vec<DefaultSetupCandidate>> {
        let mut candidates = Vec::new();
        for skill in self.store.list_skills()? {
            for target in self.store.list_skill_targets(&skill.id)? {
                let belongs_to_project = target.scope == "project"
                    && target.project_path.as_deref() == Some(project_path);
                if target.scope != "global" && !belongs_to_project {
                    continue;
                }
                let source_path = PathBuf::from(&target.target_path);
                let fingerprint = hash_dir(&source_path).ok();
                let mut reason = if source_path.is_dir() {
                    fingerprint
                        .is_none()
                        .then(|| "content fingerprint could not be computed".to_string())
                } else {
                    Some("managed target is missing from disk".to_string())
                };
                if reason.is_none() {
                    reason = self
                        .resolve_project_tool(&target.tool)
                        .err()
                        .map(|error| error.to_string());
                }
                let target_name = source_path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| skill.name.clone());
                candidates.push(DefaultSetupCandidate {
                    selection_key: scan_selection_key(&target.tool, &source_path),
                    name: target_name,
                    tool: target.tool.clone(),
                    source_tool: target.tool,
                    source_path: source_path.to_string_lossy().to_string(),
                    fingerprint,
                    classification: DefaultSetupCandidateKind::KnownSkill,
                    has_conflict: false,
                    is_link: std::fs::symlink_metadata(&source_path)
                        .is_ok_and(|metadata| metadata.file_type().is_symlink()),
                    plugin_name: None,
                    plugin_version: skill.source_revision.clone(),
                    capturable: reason.is_none(),
                    reason,
                });
            }
        }
        Ok(candidates)
    }

    fn project_onboarding_variants(
        &self,
        home: &Path,
        project_path: &Path,
    ) -> Result<Vec<OnboardingVariant>> {
        let mut variants = Vec::new();
        for adapter in default_tool_adapters() {
            if !supports_project_scope(&adapter) || !home.join(adapter.relative_detect_dir).exists()
            {
                continue;
            }
            let skills_dir = project_path.join(project_relative_skills_dir(&adapter));
            if !skills_dir.is_dir() {
                continue;
            }
            for detected in scan_tool_dir(&adapter, &skills_dir)? {
                variants.push(OnboardingVariant {
                    tool: detected.tool.as_key().to_string(),
                    name: detected.name,
                    fingerprint: hash_dir(&detected.path).ok(),
                    path: detected.path,
                    is_link: detected.is_link,
                    link_target: detected.link_target,
                    plugin_name: None,
                    plugin_version: None,
                    plugin_scope: Some("project".to_string()),
                });
            }
        }
        Ok(variants)
    }

    pub fn list_setups(&self) -> Result<Vec<SetupSummary>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT s.id, s.name, r.id, r.revision_number, COUNT(rs.skill_id),
                        s.created_at, s.updated_at, s.kind, s.initial_revision_id
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
                "INSERT INTO setup_revision_skills
                 (revision_id, skill_id, tool, created_at, target_name)
                 SELECT ?1, skill_id, tool, ?2, target_name
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
                "SELECT rs.skill_id, s.name, rs.tool, COALESCE(rs.target_name, s.name)
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
                    target_name: row.get(3)?,
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
                     (revision_id, skill_id, tool, created_at, target_name)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![revision_id, skill.id, tool, now, skill.name],
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
                "INSERT INTO setup_revision_skills
                 (revision_id, skill_id, tool, created_at, target_name)
                 SELECT ?1, skill_id, tool, ?2, target_name
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
        let mut project = self.resolve_project(project_path)?;
        let _operation_lock = ProjectOperationLock::try_acquire(Path::new(&project.path))?;
        self.recover_incomplete_operation_locked(&project)?;
        project = self.project_by_id(&project.id)?;
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

    pub fn assign_default_setup(&self, project_path: &Path) -> Result<Project> {
        let mut project = self.resolve_project(project_path)?;
        let _operation_lock = ProjectOperationLock::try_acquire(Path::new(&project.path))?;
        self.recover_incomplete_operation_locked(&project)?;
        project = self.project_by_id(&project.id)?;
        let setup = project
            .default_setup
            .context("project has no captured Default Setup")?;
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
        let mut project = self.resolve_project(project_path)?;
        let _operation_lock = ProjectOperationLock::try_acquire(Path::new(&project.path))?;
        self.recover_incomplete_operation_locked(&project)?;
        project = self.project_by_id(&project.id)?;
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
        let mut project = self.resolve_project(project_path)?;
        let _operation_lock = ProjectOperationLock::try_acquire(Path::new(&project.path))?;
        self.recover_incomplete_operation_locked(&project)?;
        project = self.project_by_id(&project.id)?;
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
        self.sync_checked(project_path, setup_selector, |_| Ok(()))
            .map(|(result, ())| result)
    }

    pub(crate) fn sync_checked<T>(
        &self,
        project_path: &Path,
        setup_selector: Option<&str>,
        validate: impl FnOnce(&ApplyPlan) -> Result<T>,
    ) -> Result<(ApplyResult, T)> {
        let mut never_cancel = || Ok(false);
        self.sync_checked_cancellable(project_path, setup_selector, validate, &mut never_cancel)
    }

    pub(crate) fn sync_checked_cancellable<T>(
        &self,
        project_path: &Path,
        setup_selector: Option<&str>,
        validate: impl FnOnce(&ApplyPlan) -> Result<T>,
        should_cancel: &mut dyn FnMut() -> Result<bool>,
    ) -> Result<(ApplyResult, T)> {
        let mut project = self.resolve_project(project_path)?;
        let _operation_lock = ProjectOperationLock::try_acquire(Path::new(&project.path))?;
        self.recover_incomplete_operation_locked(&project)?;
        project = self.project_by_id(&project.id)?;
        let setup = match setup_selector {
            Some(selector) => self.resolve_setup(selector)?,
            None => project
                .assigned_setup
                .clone()
                .context("project has no assigned setup")?,
        };
        let reconciliation = self.reconciliation_for_setup(project.clone(), setup.clone())?;
        let validated = validate(&reconciliation.plan)?;
        ensure_no_conflicts(&reconciliation.plan)?;

        let operation_id = Uuid::new_v4().to_string();
        let snapshots = reconciliation
            .current_records
            .iter()
            .map(TargetSnapshot::from)
            .collect::<Vec<_>>();
        let snapshots_json = serde_json::to_string(&snapshots)?;
        self.begin_filesystem_operation(
            &operation_id,
            &project.id,
            "apply",
            &recovery_plan(&reconciliation),
        )?;
        let execution = match self.execute_files(&reconciliation, &operation_id, should_cancel) {
            Ok(execution) => execution,
            Err(failure) => {
                return Err(anyhow::Error::new(
                    self.resolve_operation_failure(&operation_id, failure),
                ));
            }
        };
        match should_cancel() {
            Ok(false) => {}
            Ok(true) => {
                return Err(anyhow::Error::new(self.resolve_operation_failure(
                    &operation_id,
                    FileExecutionFailure {
                        error: anyhow::anyhow!("cancellation requested before commit"),
                        cancelled: true,
                        actions_completed: execution.actions_completed,
                    },
                )));
            }
            Err(error) => {
                return Err(anyhow::Error::new(self.resolve_operation_failure(
                    &operation_id,
                    FileExecutionFailure {
                        error,
                        cancelled: false,
                        actions_completed: execution.actions_completed,
                    },
                )));
            }
        }
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
            tx.execute(
                "DELETE FROM filesystem_recovery_journal WHERE operation_id = ?1",
                params![operation_id],
            )?;
            tx.commit()?;
            Ok(())
        });
        if let Err(err) = db_result {
            return Err(anyhow::Error::new(self.resolve_operation_failure(
                &operation_id,
                FileExecutionFailure {
                    error: err.context("save applied setup state"),
                    cancelled: false,
                    actions_completed: execution.actions_completed,
                },
            )));
        }

        Ok((
            ApplyResult {
                plan: reconciliation.plan,
                operation_id,
            },
            validated,
        ))
    }

    pub fn rollback(&self, project_path: &Path) -> Result<ApplyResult> {
        let mut never_cancel = || Ok(false);
        self.rollback_checked(project_path, None, &mut never_cancel)
    }

    pub(crate) fn rollback_checked(
        &self,
        project_path: &Path,
        expected_operation_id: Option<&str>,
        should_cancel: &mut dyn FnMut() -> Result<bool>,
    ) -> Result<ApplyResult> {
        let mut project = self.resolve_project(project_path)?;
        let _operation_lock = ProjectOperationLock::try_acquire(Path::new(&project.path))?;
        self.recover_incomplete_operation_locked(&project)?;
        project = self.project_by_id(&project.id)?;
        let operation = self.latest_operation(&project.id)?;
        if expected_operation_id.is_some_and(|expected| operation.id != expected) {
            anyhow::bail!("requested operation is not the latest recoverable operation");
        }
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
        let recovery_operation_id = Uuid::new_v4().to_string();
        self.begin_filesystem_operation(
            &recovery_operation_id,
            &project.id,
            "rollback",
            &recovery_plan(&reconciliation),
        )?;
        let execution =
            match self.execute_files(&reconciliation, &recovery_operation_id, should_cancel) {
                Ok(execution) => execution,
                Err(failure) => {
                    return Err(anyhow::Error::new(
                        self.resolve_operation_failure(&recovery_operation_id, failure),
                    ));
                }
            };
        match should_cancel() {
            Ok(false) => {}
            Ok(true) => {
                return Err(anyhow::Error::new(self.resolve_operation_failure(
                    &recovery_operation_id,
                    FileExecutionFailure {
                        error: anyhow::anyhow!("cancellation requested before commit"),
                        cancelled: true,
                        actions_completed: execution.actions_completed,
                    },
                )));
            }
            Err(error) => {
                return Err(anyhow::Error::new(self.resolve_operation_failure(
                    &recovery_operation_id,
                    FileExecutionFailure {
                        error,
                        cancelled: false,
                        actions_completed: execution.actions_completed,
                    },
                )));
            }
        }
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
            tx.execute(
                "DELETE FROM filesystem_recovery_journal WHERE operation_id = ?1",
                params![recovery_operation_id],
            )?;
            tx.commit()?;
            Ok(())
        });
        if let Err(err) = db_result {
            return Err(anyhow::Error::new(self.resolve_operation_failure(
                &recovery_operation_id,
                FileExecutionFailure {
                    error: err.context("save rollback state"),
                    cancelled: false,
                    actions_completed: execution.actions_completed,
                },
            )));
        }

        Ok(ApplyResult {
            plan: reconciliation.plan,
            operation_id: operation.id,
        })
    }

    pub fn rollback_operation(
        &self,
        project_path: &Path,
        expected_operation_id: &str,
    ) -> Result<ApplyResult> {
        let mut never_cancel = || Ok(false);
        self.rollback_checked(project_path, Some(expected_operation_id), &mut never_cancel)
    }

    fn resolve_setup(&self, selector: &str) -> Result<SetupSummary> {
        self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT s.id, s.name, r.id, r.revision_number, COUNT(rs.skill_id),
                        s.created_at, s.updated_at, s.kind, s.initial_revision_id
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
            let default_setup = default_setup_by_project_id(conn, &row.0)?;
            Ok(Project {
                id: row.0,
                path: row.1,
                default_setup,
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
            validate_skill_name(&item.target_name)?;
            let tool = self.resolve_project_tool(&item.tool)?;
            let relative = validate_relative_path(&tool.relative_skills_dir.to_string_lossy())?;
            let target = PathBuf::from(&project.path)
                .join(relative)
                .join(&item.target_name);
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
                match detect_owned_mode(
                    Path::new(&desired.skill.central_path),
                    &desired.target_path,
                    desired.sync_mode,
                ) {
                    Ok(actual_mode) if sync_mode_satisfies(actual_mode, desired.sync_mode) => {
                        actions.push(action_for_desired(
                            ApplyActionKind::Keep,
                            desired,
                            "adopt the identical local target",
                        ));
                        operations.push(PhysicalOperation::Keep(
                            CurrentGroup {
                                records: Vec::new(),
                                skill: Some(desired.skill.clone()),
                                target_path: desired.target_path.clone(),
                                exists: true,
                                actual_mode,
                            },
                            desired.clone(),
                        ));
                    }
                    Ok(_) | Err(_) => conflicts.push(format!(
                        "unmanaged target already exists and will not be replaced: {}",
                        desired.target_path.display()
                    )),
                }
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

    pub(crate) fn recover_incomplete_operation(
        &self,
        project_path: &Path,
    ) -> Result<Option<RecoveredOperation>> {
        let project = self.resolve_project(project_path)?;
        let _operation_lock = ProjectOperationLock::try_acquire(Path::new(&project.path))?;
        self.recover_incomplete_operation_locked(&project)
    }

    fn recover_incomplete_operation_locked(
        &self,
        project: &Project,
    ) -> Result<Option<RecoveredOperation>> {
        let Some(journal) = self.filesystem_journal_for_project(&project.id)? else {
            return Ok(None);
        };
        self.restore_filesystem_journal(&journal)
            .map(Some)
            .map_err(|error| {
                anyhow::Error::new(OperationInterruption::NeedsAttention {
                    operation: RecoveredOperation {
                        operation_id: journal.operation_id,
                        actions_completed: journal.actions_completed,
                    },
                    message: format!("{error:#}"),
                    cancelled: false,
                })
            })
    }

    fn begin_filesystem_operation(
        &self,
        operation_id: &str,
        project_id: &str,
        operation_kind: &str,
        recovery_plan: &FilesystemRecoveryPlan,
    ) -> Result<()> {
        let now = now_ms();
        let recovery_plan_json =
            serde_json::to_string(recovery_plan).context("encode filesystem recovery plan")?;
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO filesystem_recovery_journal
                   (operation_id, project_id, operation_kind, recovery_plan_json,
                    actions_completed, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, 'prepared', ?5, ?5)",
                params![
                    operation_id,
                    project_id,
                    operation_kind,
                    recovery_plan_json,
                    now
                ],
            )?;
            Ok(())
        })
    }

    fn mark_filesystem_mutating(&self, operation_id: &str) -> Result<()> {
        self.store.with_conn(|conn| {
            conn.execute(
                "UPDATE filesystem_recovery_journal
                 SET status = 'mutating', updated_at = ?1 WHERE operation_id = ?2",
                params![now_ms(), operation_id],
            )?;
            Ok(())
        })
    }

    fn checkpoint_filesystem_action(
        &self,
        operation_id: &str,
        actions_completed: u64,
    ) -> Result<()> {
        self.store.with_conn(|conn| {
            conn.execute(
                "UPDATE filesystem_recovery_journal
                 SET actions_completed = ?1, updated_at = ?2 WHERE operation_id = ?3",
                params![actions_completed, now_ms(), operation_id],
            )?;
            Ok(())
        })
    }

    fn filesystem_journal_for_project(
        &self,
        project_id: &str,
    ) -> Result<Option<FilesystemRecoveryJournal>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT operation_id, recovery_plan_json, actions_completed
                 FROM filesystem_recovery_journal WHERE project_id = ?1",
                params![project_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u64>(2)?,
                    ))
                },
            )
            .optional()?
            .map(|(operation_id, recovery_plan_json, actions_completed)| {
                Ok(FilesystemRecoveryJournal {
                    operation_id,
                    recovery_plan: serde_json::from_str(&recovery_plan_json)
                        .context("decode filesystem recovery plan")?,
                    actions_completed,
                })
            })
            .transpose()
        })
    }

    fn filesystem_journal_by_operation(
        &self,
        operation_id: &str,
    ) -> Result<Option<FilesystemRecoveryJournal>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT operation_id, recovery_plan_json, actions_completed
                 FROM filesystem_recovery_journal WHERE operation_id = ?1",
                params![operation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u64>(2)?,
                    ))
                },
            )
            .optional()?
            .map(|(operation_id, recovery_plan_json, actions_completed)| {
                Ok(FilesystemRecoveryJournal {
                    operation_id,
                    recovery_plan: serde_json::from_str(&recovery_plan_json)
                        .context("decode filesystem recovery plan")?,
                    actions_completed,
                })
            })
            .transpose()
        })
    }

    fn restore_filesystem_journal(
        &self,
        journal: &FilesystemRecoveryJournal,
    ) -> Result<RecoveredOperation> {
        self.store.with_conn(|conn| {
            conn.execute(
                "UPDATE filesystem_recovery_journal
                 SET status = 'restoring', updated_at = ?1 WHERE operation_id = ?2",
                params![now_ms(), journal.operation_id],
            )?;
            Ok(())
        })?;
        let mut failures = Vec::new();
        for step in journal.recovery_plan.steps.iter().rev() {
            let target = Path::new(&step.target_path);
            if let Err(error) = remove_path_any(target) {
                failures.push(format!("remove {}: {error:#}", target.display()));
                continue;
            }
            if let Some(previous) = &step.previous {
                if let Err(error) = sync_dir_with_mode_with_overwrite(
                    previous.mode,
                    Path::new(&previous.central_path),
                    target,
                    false,
                ) {
                    failures.push(format!("restore {}: {error:#}", target.display()));
                }
            }
        }
        if !failures.is_empty() {
            let message = failures.join("; ");
            self.store.with_conn(|conn| {
                conn.execute(
                    "UPDATE filesystem_recovery_journal
                     SET status = 'needsAttention', updated_at = ?1 WHERE operation_id = ?2",
                    params![now_ms(), journal.operation_id],
                )?;
                Ok(())
            })?;
            anyhow::bail!(message);
        }
        self.store.with_conn(|conn| {
            conn.execute(
                "DELETE FROM filesystem_recovery_journal WHERE operation_id = ?1",
                params![journal.operation_id],
            )?;
            Ok(())
        })?;
        Ok(RecoveredOperation {
            operation_id: journal.operation_id.clone(),
            actions_completed: journal.actions_completed,
        })
    }

    fn resolve_operation_failure(
        &self,
        operation_id: &str,
        failure: FileExecutionFailure,
    ) -> OperationInterruption {
        let message = format!("{:#}", failure.error);
        let fallback = RecoveredOperation {
            operation_id: operation_id.to_owned(),
            actions_completed: failure.actions_completed,
        };
        let journal = match self.filesystem_journal_by_operation(operation_id) {
            Ok(Some(journal)) => journal,
            Ok(None) => {
                return OperationInterruption::NeedsAttention {
                    operation: fallback,
                    message: format!("{message}; recovery journal is missing"),
                    cancelled: failure.cancelled,
                };
            }
            Err(error) => {
                return OperationInterruption::NeedsAttention {
                    operation: fallback,
                    message: format!("{message}; could not read recovery journal: {error:#}"),
                    cancelled: failure.cancelled,
                };
            }
        };
        match self.restore_filesystem_journal(&journal) {
            Ok(operation) if failure.cancelled => {
                OperationInterruption::CancelledAndRestored(operation)
            }
            Ok(operation) => OperationInterruption::FailedAndRestored { operation, message },
            Err(error) => OperationInterruption::NeedsAttention {
                operation: fallback,
                message: format!("{message}; restore failed: {error:#}"),
                cancelled: failure.cancelled,
            },
        }
    }

    fn execute_files(
        &self,
        reconciliation: &Reconciliation,
        operation_id: &str,
        should_cancel: &mut dyn FnMut() -> Result<bool>,
    ) -> std::result::Result<Execution, FileExecutionFailure> {
        let mut execution = Execution {
            modes: HashMap::new(),
            actions_completed: 0,
        };
        if let Err(error) = self.mark_filesystem_mutating(operation_id) {
            return Err(FileExecutionFailure {
                error,
                cancelled: false,
                actions_completed: 0,
            });
        }
        let result = (|| -> std::result::Result<(), (anyhow::Error, bool)> {
            for operation in &reconciliation.operations {
                cancellation_checkpoint(should_cancel)?;
                match operation {
                    PhysicalOperation::Remove(current) | PhysicalOperation::Replace(current, _) => {
                        if current.exists {
                            remove_path_any(&current.target_path)
                                .map_err(|error| (error, false))?;
                            if matches!(operation, PhysicalOperation::Remove(_)) {
                                execution.actions_completed += 1;
                                self.checkpoint_filesystem_action(
                                    operation_id,
                                    execution.actions_completed,
                                )
                                .map_err(|error| (error, false))?;
                            }
                        }
                    }
                    PhysicalOperation::Add(_) | PhysicalOperation::Keep(_, _) => {}
                }
            }
            for operation in &reconciliation.operations {
                cancellation_checkpoint(should_cancel)?;
                match operation {
                    PhysicalOperation::Add(desired) | PhysicalOperation::Replace(_, desired) => {
                        let outcome = sync_desired(desired).map_err(|error| (error, false))?;
                        execution
                            .modes
                            .insert(path_key(&desired.target_path), outcome.mode_used);
                        execution.actions_completed += 1;
                        self.checkpoint_filesystem_action(
                            operation_id,
                            execution.actions_completed,
                        )
                        .map_err(|error| (error, false))?;
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
        if let Err((error, cancelled)) = result {
            return Err(FileExecutionFailure {
                error,
                cancelled,
                actions_completed: execution.actions_completed,
            });
        }
        Ok(execution)
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

fn recovery_plan(reconciliation: &Reconciliation) -> FilesystemRecoveryPlan {
    let steps = reconciliation
        .operations
        .iter()
        .filter_map(|operation| match operation {
            PhysicalOperation::Add(desired) => Some(FilesystemRecoveryStep {
                target_path: desired.target_path.to_string_lossy().to_string(),
                previous: None,
            }),
            PhysicalOperation::Remove(current) if current.exists => Some(FilesystemRecoveryStep {
                target_path: current.target_path.to_string_lossy().to_string(),
                previous: recovery_source(current),
            }),
            PhysicalOperation::Replace(current, desired) => Some(FilesystemRecoveryStep {
                target_path: desired.target_path.to_string_lossy().to_string(),
                previous: current.exists.then(|| recovery_source(current)).flatten(),
            }),
            PhysicalOperation::Remove(_) | PhysicalOperation::Keep(_, _) => None,
        })
        .collect();
    FilesystemRecoveryPlan { steps }
}

fn recovery_source(current: &CurrentGroup) -> Option<FilesystemRecoverySource> {
    current
        .skill
        .as_ref()
        .map(|skill| FilesystemRecoverySource {
            central_path: skill.central_path.clone(),
            mode: current.actual_mode,
        })
}

fn cancellation_checkpoint(
    should_cancel: &mut dyn FnMut() -> Result<bool>,
) -> std::result::Result<(), (anyhow::Error, bool)> {
    match should_cancel() {
        Ok(false) => Ok(()),
        Ok(true) => Err((anyhow::anyhow!("cancellation requested"), true)),
        Err(error) => Err((error.context("read operation cancellation state"), false)),
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
        is_default: row.get::<_, String>(7)? == "default",
        initial_revision_id: row.get(8)?,
    })
}

fn setup_by_revision_id(conn: &rusqlite::Connection, revision_id: &str) -> Result<SetupSummary> {
    conn.query_row(
        "SELECT s.id, s.name, r.id, r.revision_number, COUNT(rs.skill_id),
                s.created_at, s.updated_at, s.kind, s.initial_revision_id
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

fn default_setup_by_project_id(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<Option<SetupSummary>> {
    conn.query_row(
        "SELECT s.id, s.name, r.id, r.revision_number, COUNT(rs.skill_id),
                s.created_at, s.updated_at, s.kind, s.initial_revision_id
         FROM setups s
         INNER JOIN setup_revisions r ON r.id = s.current_revision_id
         LEFT JOIN setup_revision_skills rs ON rs.revision_id = r.id
         WHERE s.kind = 'default' AND s.default_project_id = ?1
         GROUP BY s.id, s.name, r.id, r.revision_number, s.created_at, s.updated_at,
                  s.kind, s.initial_revision_id",
        params![project_id],
        setup_from_row,
    )
    .optional()
    .map_err(Into::into)
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

fn insert_skill_record(conn: &rusqlite::Connection, record: &SkillRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO skills (
           id, name, description, source_type, source_ref, source_subpath, source_revision,
           central_path, content_hash, created_at, updated_at, last_sync_at, last_seen_at,
           enabled, status
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
            record.enabled,
            record.status
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

fn default_setup_name(project: &Project) -> String {
    let project_name = Path::new(&project.path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "project".to_string());
    let short_id = project.id.get(..8).unwrap_or(&project.id);
    format!("Default — {project_name} [{short_id}]")
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

fn normalize_existing_directory(path: &Path, label: &str) -> Result<PathBuf> {
    if !path.is_dir() {
        anyhow::bail!("{label} does not exist: {}", path.display());
    }
    Ok(clean_canonical_path(path.canonicalize().with_context(
        || format!("resolve {label} {}", path.display()),
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

fn scan_selection_key(tool: &str, path: &Path) -> String {
    format!("{tool}|{}", path_key(path))
}

fn unique_snapshot_path(central_repo: &Path, fingerprint: &str) -> PathBuf {
    let digest = fingerprint.get(..12).unwrap_or(fingerprint);
    loop {
        let suffix = Uuid::new_v4().simple().to_string();
        let path = central_repo.join(format!("snapshot-{digest}-{}", &suffix[..8]));
        if !path.exists() {
            return path;
        }
    }
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

#[cfg(test)]
mod recovery_tests {
    use std::cell::Cell;

    use tempfile::TempDir;

    use super::*;

    fn fixture() -> (TempDir, SkillStore, SetupService, PathBuf, SetupSummary) {
        let temp = tempfile::tempdir().unwrap();
        let store = SkillStore::new(temp.path().join("skills_hub.db"));
        store.ensure_schema().unwrap();
        let service = SetupService::from_store(store.clone()).unwrap();
        let central_path = temp.path().join("library").join("alpha");
        std::fs::create_dir_all(&central_path).unwrap();
        std::fs::write(central_path.join("SKILL.md"), "# Alpha").unwrap();
        store
            .upsert_skill(&SkillRecord {
                id: "skill-alpha".to_owned(),
                name: "alpha".to_owned(),
                description: None,
                source_type: "local".to_owned(),
                source_ref: None,
                source_subpath: None,
                source_revision: None,
                central_path: central_path.to_string_lossy().to_string(),
                content_hash: None,
                created_at: 1,
                updated_at: 1,
                last_sync_at: None,
                last_seen_at: 1,
                enabled: true,
                status: "ok".to_owned(),
            })
            .unwrap();
        let setup = service.create_setup("alpha setup").unwrap();
        let setup = service
            .add_setup_skill(&setup.setup.id, "skill-alpha", &["codex".to_owned()])
            .unwrap()
            .setup;
        let project_path = temp.path().join("project");
        std::fs::create_dir_all(&project_path).unwrap();
        service.add_project(&project_path).unwrap();
        service.assign_setup(&project_path, &setup.id).unwrap();
        (temp, store, service, project_path, setup)
    }

    fn journal_count(store: &SkillStore) -> u64 {
        store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM filesystem_recovery_journal",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap()
    }

    #[test]
    fn cancellation_after_mutation_restores_the_previous_filesystem() {
        let (_temp, store, service, project_path, _setup) = fixture();
        let checks = Cell::new(0_u32);
        let mut should_cancel = || {
            let next = checks.get() + 1;
            checks.set(next);
            Ok(next >= 3)
        };

        let error = service
            .sync_checked_cancellable(&project_path, None, |_| Ok(()), &mut should_cancel)
            .unwrap_err();
        let interruption = error.downcast_ref::<OperationInterruption>().unwrap();
        assert!(matches!(
            interruption,
            OperationInterruption::CancelledAndRestored(RecoveredOperation {
                actions_completed: 1,
                ..
            })
        ));
        assert!(!project_path.join(".agents/skills/alpha").exists());
        assert_eq!(journal_count(&store), 0);
        assert!(service
            .status(&project_path)
            .unwrap()
            .project
            .applied_setup
            .is_none());
    }

    #[test]
    fn a_restart_recovers_files_changed_before_the_database_commit() {
        let (_temp, store, service, project_path, setup) = fixture();
        let project = service.resolve_project(&project_path).unwrap();
        let reconciliation = service
            .reconciliation_for_setup(project.clone(), setup)
            .unwrap();
        let operation_id = Uuid::new_v4().to_string();
        service
            .begin_filesystem_operation(
                &operation_id,
                &project.id,
                "apply",
                &recovery_plan(&reconciliation),
            )
            .unwrap();
        service
            .execute_files(&reconciliation, &operation_id, &mut || Ok(false))
            .unwrap();
        assert!(project_path.join(".agents/skills/alpha").exists());
        assert_eq!(journal_count(&store), 1);

        let reopened = SetupService::from_store(store.clone()).unwrap();
        let plan = reopened.plan(&project_path, None).unwrap();

        assert!(!project_path.join(".agents/skills/alpha").exists());
        assert!(plan
            .actions
            .iter()
            .any(|action| action.kind == ApplyActionKind::Add));
        assert_eq!(journal_count(&store), 0);
    }
}
