use std::{fmt, path::PathBuf};

use ahm_domain::{
    ApplyReceipt, ArtifactBundle, CancellationOutcome, CancellationReceipt, CanonicalPlan, Digest,
    DiscoveryKind, DiscoveryState, ErrorResult, Identifier, IsoTimestamp, JobEnvelope,
    LeasedRunnerJob, OperationOutcome, PlanAction, PlanActionKind, PlanChangeKind, PlanDestination,
    PlanResult, ProjectId, ProjectRelativePath, ProtocolErrorCode, Recoverability, ResultEnvelope,
    RollbackReceipt, RunnerCapabilities, RunnerJob, RunnerResult, ScanDiscovery, ScanResult,
    SetupRevisionId, PROTOCOL_VERSION,
};
use anyhow::Context;
use sha2::{Digest as ShaDigest, Sha256};

use crate::{
    artifact_cache::ArtifactCache,
    execution::RunnerExecutionService,
    setup_service::{
        ApplyActionKind, ApplyPlan, DefaultSetupCandidate, DefaultSetupCandidateKind,
        OperationInterruption, RecoveredOperation,
    },
    state::{ProjectInstanceRecord, RunnerIdentityRecord},
    tool_adapters::default_tool_adapters,
};

pub trait JobExecutor {
    fn capabilities(&self) -> RunnerCapabilities;
    fn execute(
        &self,
        identity: &RunnerIdentityRecord,
        project: Option<&ProjectInstanceRecord>,
        lease: &LeasedRunnerJob,
        now: &IsoTimestamp,
        should_cancel: &mut dyn FnMut() -> anyhow::Result<bool>,
    ) -> ResultEnvelope;
    fn has_artifact(&self, _digest: &Digest) -> anyhow::Result<bool> {
        Ok(false)
    }
    fn store_artifact(&self, _bundle: &ArtifactBundle) -> anyhow::Result<()> {
        anyhow::bail!("artifact storage is unavailable")
    }
    fn artifact_bundle(&self, _digest: &Digest) -> anyhow::Result<Option<ArtifactBundle>> {
        Ok(None)
    }
}

pub struct LocalJobExecutor {
    runner: RunnerExecutionService,
    home: PathBuf,
    artifact_cache: ArtifactCache,
}

#[derive(Debug)]
struct ApplyValidationError {
    code: ProtocolErrorCode,
    message: String,
}

impl ApplyValidationError {
    fn new(code: ProtocolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ApplyValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ApplyValidationError {}

impl LocalJobExecutor {
    pub fn new(runner: RunnerExecutionService, home: PathBuf) -> Self {
        let artifact_cache = ArtifactCache::for_home(&home);
        Self {
            runner,
            home,
            artifact_cache,
        }
    }

    fn execute_scan(
        &self,
        job: &JobEnvelope,
        project: &ProjectInstanceRecord,
        project_id: &ProjectId,
        include_unmanaged: bool,
    ) -> RunnerResult {
        match self.runner.scan(&self.home, &project.local_path) {
            Ok(preview) => {
                let discoveries = preview
                    .candidates
                    .iter()
                    .filter(|candidate| {
                        include_unmanaged
                            || candidate.classification == DefaultSetupCandidateKind::KnownSkill
                    })
                    .filter_map(|candidate| {
                        let mut discovery = candidate_to_discovery(candidate)?;
                        if discovery.state == DiscoveryState::Available {
                            if let Err(error) = self.artifact_cache.snapshot(
                                std::path::Path::new(&candidate.source_path),
                                &discovery.content_digest,
                            ) {
                                log::warn!(
                                    "cache scanned artifact {} failed: {error:#}",
                                    candidate.source_path
                                );
                                discovery.state = DiscoveryState::Unsupported;
                            }
                        }
                        Some(discovery)
                    })
                    .collect();
                RunnerResult::ScanResult(ScanResult {
                    project_id: project_id.clone(),
                    discoveries,
                })
            }
            Err(error) => {
                log::error!("remote scan {} failed: {error:#}", job.job_id.as_str());
                protocol_error(
                    ProtocolErrorCode::OperationFailed,
                    "scan failed; inspect runner logs",
                    true,
                )
            }
        }
    }

    fn stage_and_plan(
        &self,
        project: &ProjectInstanceRecord,
        revision: &ahm_domain::PortableSetupRevision,
    ) -> anyhow::Result<CanonicalPlan> {
        let selector = self
            .runner
            .local_admin()
            .stage_portable_revision(revision, self.artifact_cache.root())?;
        let plan = self.runner.plan(&project.local_path, Some(&selector))?;
        canonical_plan(&plan, revision, self.artifact_cache.root())
    }

    fn cancellation_before_execution(
        &self,
        project: Option<&ProjectInstanceRecord>,
        job: &JobEnvelope,
        now: &IsoTimestamp,
    ) -> RunnerResult {
        let Some(project) = project else {
            return protocol_error(ProtocolErrorCode::JobCancelled, "job was cancelled", false);
        };
        if !matches!(
            &job.job,
            RunnerJob::ApplyPlan(_) | RunnerJob::RollbackOperation(_)
        ) {
            return protocol_error(ProtocolErrorCode::JobCancelled, "job was cancelled", false);
        }
        match self
            .runner
            .recover_incomplete_operation(&project.local_path)
        {
            Ok(recovered) => cancellation_receipt(
                &project.project_id,
                recovered.as_ref(),
                fallback_cancelled_operation_id(job),
                CancellationOutcome::CancelledAndRestored,
                Recoverability::NotNeeded,
                now,
            ),
            Err(error) => {
                log::error!(
                    "cancelled operation recovery {} failed: {error:#}",
                    job.job_id.as_str()
                );
                let operation = error
                    .downcast_ref::<OperationInterruption>()
                    .map(interrupted_operation);
                cancellation_receipt(
                    &project.project_id,
                    operation.as_ref(),
                    fallback_cancelled_operation_id(job),
                    CancellationOutcome::NeedsAttention,
                    Recoverability::ManualIntervention,
                    now,
                )
            }
        }
    }

    fn recovery_before_mutation(
        &self,
        project: Option<&ProjectInstanceRecord>,
        job: &JobEnvelope,
    ) -> Option<RunnerResult> {
        let project = project?;
        if !matches!(
            &job.job,
            RunnerJob::ApplyPlan(_) | RunnerJob::RollbackOperation(_)
        ) {
            return None;
        }
        match self
            .runner
            .recover_incomplete_operation(&project.local_path)
        {
            Ok(_) => None,
            Err(error) => {
                log::error!(
                    "unfinished operation recovery {} failed: {error:#}",
                    job.job_id.as_str()
                );
                Some(operation_error(
                    "unfinished local operation could not be restored; manual recovery is required",
                ))
            }
        }
    }
}

impl JobExecutor for LocalJobExecutor {
    fn capabilities(&self) -> RunnerCapabilities {
        runner_capabilities()
    }

    fn execute(
        &self,
        identity: &RunnerIdentityRecord,
        project: Option<&ProjectInstanceRecord>,
        lease: &LeasedRunnerJob,
        now: &IsoTimestamp,
        should_cancel: &mut dyn FnMut() -> anyhow::Result<bool>,
    ) -> ResultEnvelope {
        let job = &lease.job;
        let initial_control = if lease.cancel_requested {
            Ok(true)
        } else {
            should_cancel()
        };
        let result = if let Err(error) = &initial_control {
            log::warn!(
                "could not read cancellation state for {}: {error:#}",
                job.job_id.as_str()
            );
            protocol_error(
                ProtocolErrorCode::OperationFailed,
                "could not confirm operation control state",
                true,
            )
        } else if matches!(initial_control, Ok(true)) {
            self.cancellation_before_execution(project, job, now)
        } else if job.organization_id != identity.organization_id {
            protocol_error(
                ProtocolErrorCode::InvalidOrganization,
                "job organization does not match this runner",
                false,
            )
        } else if job.device_id != identity.device_id {
            protocol_error(
                ProtocolErrorCode::InvalidDevice,
                "job device does not match this runner",
                false,
            )
        } else if let Some(recovery_error) = self.recovery_before_mutation(project, job) {
            recovery_error
        } else if is_expired(&job.expires_at, now) {
            protocol_error(ProtocolErrorCode::ExpiredJob, "job has expired", false)
        } else if let Some(project) = project {
            if project.organization_id != identity.organization_id {
                protocol_error(
                    ProtocolErrorCode::InvalidOrganization,
                    "project organization does not match this runner",
                    false,
                )
            } else {
                match &job.job {
                    RunnerJob::ScanProject(scan) if scan.project_id == project.project_id => {
                        self.execute_scan(job, project, &scan.project_id, scan.include_unmanaged)
                    }
                    RunnerJob::ScanProject(_) => protocol_error(
                        ProtocolErrorCode::UnknownProjectInstance,
                        "job project does not match its registered instance",
                        false,
                    ),
                    RunnerJob::PlanSetup(plan) if plan.project_id == project.project_id => {
                        match self.stage_and_plan(project, &plan.revision) {
                            Ok(plan) => RunnerResult::PlanResult(PlanResult {
                                project_id: project.project_id.clone(),
                                plan,
                            }),
                            Err(error) => {
                                log::error!(
                                    "remote plan {} failed: {error:#}",
                                    job.job_id.as_str()
                                );
                                protocol_error(
                                    ProtocolErrorCode::Conflict,
                                    format!("could not prepare Setup plan: {error:#}"),
                                    false,
                                )
                            }
                        }
                    }
                    RunnerJob::ApplyPlan(apply) if apply.project_id == project.project_id => {
                        let staged = self
                            .runner
                            .local_admin()
                            .stage_portable_revision(&apply.revision, self.artifact_cache.root());
                        match staged {
                            Err(error) => protocol_error(
                                ProtocolErrorCode::OperationFailed,
                                format!("could not prepare approved Setup: {error:#}"),
                                false,
                            ),
                            Ok(selector) => {
                                let approval = &apply.approval;
                                match self.runner.apply_checked_cancellable(
                                    &project.local_path,
                                    Some(&selector),
                                    |local_plan| {
                                        let plan = canonical_plan(
                                            local_plan,
                                            &apply.revision,
                                            self.artifact_cache.root(),
                                        )?;
                                        if approval.organization_id != job.organization_id
                                            || approval.project_instance_id
                                                != job.project_instance_id
                                            || approval.setup_revision_id
                                                != apply.revision.setup_revision_id
                                            || approval.plan_digest != plan.plan_digest
                                        {
                                            return Err(anyhow::Error::new(
                                                ApplyValidationError::new(
                                                    ProtocolErrorCode::PlanDigestMismatch,
                                                    "approved plan no longer matches the local filesystem",
                                                ),
                                            ));
                                        }
                                        if is_expired(&approval.expires_at, now) {
                                            return Err(anyhow::Error::new(
                                                ApplyValidationError::new(
                                                    ProtocolErrorCode::ApprovalExpired,
                                                    "plan approval expired with its apply job",
                                                ),
                                            ));
                                        }
                                        if !plan.conflicts.is_empty() {
                                            return Err(anyhow::Error::new(
                                                ApplyValidationError::new(
                                                    ProtocolErrorCode::Conflict,
                                                    "approved plan contains conflicts",
                                                ),
                                            ));
                                        }
                                        Ok(plan)
                                    },
                                    should_cancel,
                                ) {
                                    Ok((applied, plan)) => {
                                        let actions_applied = actionable_plan_count(&plan);
                                        RunnerResult::ApplyReceipt(ApplyReceipt {
                                            project_id: project.project_id.clone(),
                                            operation_id: Identifier::new(applied.operation_id)
                                                .expect("UUID operation identifier is valid"),
                                            setup_revision_id: apply
                                                .revision
                                                .setup_revision_id
                                                .clone(),
                                            plan_digest: plan.plan_digest,
                                            outcome: if actions_applied == 0 {
                                                OperationOutcome::NoChange
                                            } else {
                                                OperationOutcome::Applied
                                            },
                                            recoverability: if actions_applied == 0 {
                                                Recoverability::NotNeeded
                                            } else {
                                                Recoverability::RollbackAvailable
                                            },
                                            actions_applied,
                                            completed_at: now.clone(),
                                        })
                                    }
                                    Err(error) => {
                                        if let Some(validation) =
                                            error.downcast_ref::<ApplyValidationError>()
                                        {
                                            protocol_error(
                                                validation.code,
                                                validation.message.clone(),
                                                false,
                                            )
                                        } else if let Some(interruption) =
                                            error.downcast_ref::<OperationInterruption>()
                                        {
                                            operation_interruption_result(
                                                &project.project_id,
                                                interruption,
                                                now,
                                            )
                                        } else {
                                            log::error!(
                                                "remote apply {} failed: {error:#}",
                                                job.job_id.as_str()
                                            );
                                            operation_error(
                                                "apply failed; local recovery may be required",
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                    RunnerJob::RollbackOperation(rollback)
                        if rollback.project_id == project.project_id =>
                    {
                        match self.runner.rollback_checked(
                            &project.local_path,
                            rollback.operation_id.as_str(),
                            should_cancel,
                        ) {
                            Ok(rolled_back) => {
                                let restored_setup_revision_id = rolled_back
                                    .plan
                                    .setup
                                    .as_ref()
                                    .and_then(|setup| setup.revision_id.strip_prefix("remote:"))
                                    .and_then(|id| SetupRevisionId::new(id).ok());
                                RunnerResult::RollbackReceipt(RollbackReceipt {
                                    project_id: project.project_id.clone(),
                                    operation_id: rollback.operation_id.clone(),
                                    restored_setup_revision_id,
                                    outcome: OperationOutcome::RolledBack,
                                    recoverability: Recoverability::NotNeeded,
                                    completed_at: now.clone(),
                                })
                            }
                            Err(error) => {
                                if let Some(interruption) =
                                    error.downcast_ref::<OperationInterruption>()
                                {
                                    operation_interruption_result(
                                        &project.project_id,
                                        interruption,
                                        now,
                                    )
                                } else {
                                    log::error!(
                                        "remote rollback {} failed: {error:#}",
                                        job.job_id.as_str()
                                    );
                                    operation_error("rollback failed; local recovery is required")
                                }
                            }
                        }
                    }
                    RunnerJob::PlanSetup(_)
                    | RunnerJob::ApplyPlan(_)
                    | RunnerJob::RollbackOperation(_) => protocol_error(
                        ProtocolErrorCode::UnknownProjectInstance,
                        "job project does not match its registered instance",
                        false,
                    ),
                }
            }
        } else {
            protocol_error(
                ProtocolErrorCode::UnknownProjectInstance,
                "project instance is not registered on this runner",
                false,
            )
        };
        ResultEnvelope {
            protocol_version: PROTOCOL_VERSION,
            job_id: job.job_id.clone(),
            idempotency_key: job.idempotency_key.clone(),
            organization_id: job.organization_id.clone(),
            device_id: identity.device_id.clone(),
            project_instance_id: job.project_instance_id.clone(),
            result,
        }
    }

    fn has_artifact(&self, digest: &Digest) -> anyhow::Result<bool> {
        self.artifact_cache.contains(digest)
    }

    fn store_artifact(&self, bundle: &ArtifactBundle) -> anyhow::Result<()> {
        self.artifact_cache.store(bundle).map(|_| ())
    }

    fn artifact_bundle(&self, digest: &Digest) -> anyhow::Result<Option<ArtifactBundle>> {
        self.artifact_cache.bundle(digest)
    }
}

fn is_expired(expires_at: &IsoTimestamp, now: &IsoTimestamp) -> bool {
    let expires_at = chrono::DateTime::parse_from_rfc3339(expires_at.as_str());
    let now = chrono::DateTime::parse_from_rfc3339(now.as_str());
    matches!((expires_at, now), (Ok(expires_at), Ok(now)) if expires_at <= now)
}

pub fn runner_capabilities() -> RunnerCapabilities {
    RunnerCapabilities {
        scan_project: true,
        plan_setup: true,
        apply_plan: true,
        rollback_operation: true,
        supported_tools: default_tool_adapters()
            .into_iter()
            .filter_map(|adapter| Identifier::new(adapter.id.as_key()).ok())
            .collect(),
    }
}

fn canonical_plan(
    local: &ApplyPlan,
    revision: &ahm_domain::PortableSetupRevision,
    artifact_cache_root: &std::path::Path,
) -> anyhow::Result<CanonicalPlan> {
    let project_root = std::path::Path::new(&local.project.path);
    let artifact_by_skill = revision
        .items
        .iter()
        .map(|item| {
            (
                format!(
                    "remote-artifact-{}",
                    item.content_digest
                        .as_str()
                        .strip_prefix("sha256:")
                        .unwrap_or_default()
                ),
                item.artifact_id.clone(),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut actions = Vec::new();
    for action in &local.actions {
        let relative = std::path::Path::new(&action.target_path)
            .strip_prefix(project_root)
            .with_context(|| "plan destination is outside its registered project")?;
        let project_relative_path = relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let kind = if action.kind == ApplyActionKind::Remove {
            PlanActionKind::RemoveManaged
        } else if action.tools.iter().any(|tool| tool == "cursor") {
            PlanActionKind::Copy
        } else {
            PlanActionKind::Link
        };
        let change = match action.kind {
            ApplyActionKind::Add => PlanChangeKind::Add,
            ApplyActionKind::Replace => PlanChangeKind::Replace,
            ApplyActionKind::Remove => PlanChangeKind::Remove,
            ApplyActionKind::Keep | ApplyActionKind::UpdateRecords => PlanChangeKind::Unchanged,
        };
        let metadata_only = action.kind == ApplyActionKind::UpdateRecords;
        let artifact_id = artifact_by_skill
            .get(&action.skill_id)
            .cloned()
            .unwrap_or_else(|| {
                Identifier::new(action.skill_id.clone())
                    .expect("local skill identifiers are valid protocol identifiers")
            });
        let tool_id = Identifier::new(
            action
                .tools
                .first()
                .cloned()
                .unwrap_or_else(|| "managed".to_owned()),
        )?;
        let action_key = format!(
            "{:?}:{}:{:?}:{}:{}",
            change,
            metadata_only,
            kind,
            artifact_id.as_str(),
            project_relative_path
        );
        actions.push(PlanAction {
            action_id: Identifier::new(format!("action_{}", &sha256_hex(&action_key)[..24]))?,
            kind,
            change: Some(change),
            metadata_only: metadata_only.then_some(true),
            artifact_id,
            destination: PlanDestination {
                tool_id,
                project_relative_path: ProjectRelativePath::new(project_relative_path)?,
            },
        });
    }
    actions.sort_by(|left, right| {
        left.destination
            .project_relative_path
            .as_str()
            .cmp(right.destination.project_relative_path.as_str())
            .then_with(|| left.action_id.as_str().cmp(right.action_id.as_str()))
    });
    let project_path = project_root.to_string_lossy();
    let cache_path = artifact_cache_root.to_string_lossy();
    let conflicts = local
        .conflicts
        .iter()
        .map(|conflict| {
            if conflict.contains("tracked target source is missing") {
                return "a previously managed artifact is missing from the local cache".to_owned();
            }
            conflict
                .replace(project_path.as_ref(), ".")
                .replace(cache_path.as_ref(), "[local cache]")
        })
        .collect::<Vec<_>>();
    let digest_input = serde_json::json!({
        "setupRevisionId": revision.setup_revision_id,
        "actions": actions,
        "conflicts": conflicts,
    });
    let plan_digest = Digest::new(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&digest_input)?))
    ))?;
    Ok(CanonicalPlan {
        setup_revision_id: revision.setup_revision_id.clone(),
        plan_digest,
        actions,
        conflicts,
    })
}

fn actionable_plan_count(plan: &CanonicalPlan) -> u64 {
    plan.actions
        .iter()
        .filter(|action| {
            action.change != Some(PlanChangeKind::Unchanged) || action.metadata_only == Some(true)
        })
        .count() as u64
}

fn operation_error(message: &str) -> RunnerResult {
    RunnerResult::Error(ErrorResult {
        code: ProtocolErrorCode::OperationFailed,
        message: message.to_owned(),
        retryable: false,
        recoverability: Recoverability::ManualIntervention,
    })
}

fn operation_interruption_result(
    project_id: &ProjectId,
    interruption: &OperationInterruption,
    now: &IsoTimestamp,
) -> RunnerResult {
    match interruption {
        OperationInterruption::CancelledAndRestored(operation) => cancellation_receipt(
            project_id,
            Some(operation),
            None,
            CancellationOutcome::CancelledAndRestored,
            Recoverability::NotNeeded,
            now,
        ),
        OperationInterruption::NeedsAttention {
            operation,
            cancelled: true,
            ..
        } => cancellation_receipt(
            project_id,
            Some(operation),
            None,
            CancellationOutcome::NeedsAttention,
            Recoverability::ManualIntervention,
            now,
        ),
        OperationInterruption::FailedAndRestored { .. } => RunnerResult::Error(ErrorResult {
            code: ProtocolErrorCode::OperationFailed,
            message: "operation failed; local filesystem state was restored".to_owned(),
            retryable: true,
            recoverability: Recoverability::NotNeeded,
        }),
        OperationInterruption::NeedsAttention { .. } => {
            operation_error("operation failed; local filesystem recovery needs attention")
        }
    }
}

fn interrupted_operation(interruption: &OperationInterruption) -> RecoveredOperation {
    match interruption {
        OperationInterruption::CancelledAndRestored(operation)
        | OperationInterruption::FailedAndRestored { operation, .. }
        | OperationInterruption::NeedsAttention { operation, .. } => operation.clone(),
    }
}

fn fallback_cancelled_operation_id(job: &JobEnvelope) -> Option<&ahm_domain::OperationId> {
    match &job.job {
        RunnerJob::RollbackOperation(rollback) => Some(&rollback.operation_id),
        _ => None,
    }
}

fn cancellation_receipt(
    project_id: &ProjectId,
    operation: Option<&RecoveredOperation>,
    fallback_operation_id: Option<&ahm_domain::OperationId>,
    outcome: CancellationOutcome,
    recoverability: Recoverability,
    now: &IsoTimestamp,
) -> RunnerResult {
    RunnerResult::CancellationReceipt(CancellationReceipt {
        project_id: project_id.clone(),
        operation_id: operation
            .and_then(|operation| Identifier::new(operation.operation_id.clone()).ok())
            .or_else(|| fallback_operation_id.cloned()),
        outcome,
        recoverability,
        actions_applied: operation.map_or(0, |operation| operation.actions_completed),
        completed_at: now.clone(),
    })
}

fn candidate_to_discovery(candidate: &DefaultSetupCandidate) -> Option<ScanDiscovery> {
    let content_digest = candidate
        .fingerprint
        .as_deref()
        .filter(|fingerprint| {
            fingerprint.len() == 64
                && fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .map(|fingerprint| format!("sha256:{fingerprint}"))
        .unwrap_or_else(|| sha256(&candidate.selection_key));
    let discovery_key = format!("{}:{}:{}", candidate.tool, candidate.name, content_digest);
    let portable_source = candidate.plugin_name.as_ref().map(|name| {
        candidate
            .plugin_version
            .as_ref()
            .map(|version| format!("claude-plugin:{name}@{version}"))
            .unwrap_or_else(|| format!("claude-plugin:{name}"))
    });
    Some(ScanDiscovery {
        discovery_id: Identifier::new(format!("discovery_{}", &sha256_hex(&discovery_key)[..24]))
            .ok()?,
        kind: match candidate.classification {
            DefaultSetupCandidateKind::KnownSkill => DiscoveryKind::Skill,
            DefaultSetupCandidateKind::PluginSkill => DiscoveryKind::PluginSkill,
            DefaultSetupCandidateKind::LocalContent => DiscoveryKind::LocalContent,
        },
        state: if candidate.has_conflict {
            DiscoveryState::Conflict
        } else if !candidate.capturable {
            DiscoveryState::Unsupported
        } else {
            DiscoveryState::Available
        },
        name: safe_identifier(&candidate.name)?,
        tool_id: safe_identifier(&candidate.tool)?,
        portable_source,
        content_digest: Digest::new(content_digest).ok()?,
    })
}

fn safe_identifier(value: &str) -> Option<Identifier> {
    if value.is_empty() {
        return None;
    }
    let truncated = value.chars().take(100).collect::<String>();
    Identifier::new(truncated).ok()
}

fn sha256(value: &str) -> String {
    format!("sha256:{}", sha256_hex(value))
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn protocol_error(
    code: ProtocolErrorCode,
    message: impl Into<String>,
    retryable: bool,
) -> RunnerResult {
    RunnerResult::Error(ErrorResult {
        code,
        message: message.into(),
        retryable,
        recoverability: Recoverability::NotNeeded,
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use ahm_domain::{
        ApplyPlanJob, ArtifactId, Identifier, JobEnvelope, LeasedRunnerJob, PlanApproval,
        PlanSetupJob, PortableSetupRevision, PortableSetupRevisionItem, RollbackOperationJob,
        RunnerJob, RunnerResult, ScanProjectJob,
    };
    use tempfile::tempdir;

    use super::*;
    use crate::setup_service::{ApplyAction, Project};

    fn identifier(value: &str) -> Identifier {
        Identifier::new(value).unwrap()
    }

    #[test]
    fn ownership_only_actions_round_trip_and_count_as_applied() {
        let root = tempdir().unwrap();
        let project_path = root.path().join("project");
        let digest = Digest::new(format!("sha256:{}", "a".repeat(64))).unwrap();
        let revision = PortableSetupRevision {
            setup_id: identifier("setup_01"),
            setup_revision_id: identifier("revision_01"),
            revision_number: 1,
            items: vec![PortableSetupRevisionItem {
                artifact_id: ArtifactId::new("artifact_01").unwrap(),
                artifact_kind: DiscoveryKind::Skill,
                portable_source: None,
                content_digest: digest.clone(),
                tool_id: identifier("codex"),
                target_name: identifier("shared-skill"),
            }],
        };
        let local = ApplyPlan {
            project: Project {
                id: "project_01".to_owned(),
                path: project_path.to_string_lossy().into_owned(),
                default_setup: None,
                assigned_setup: None,
                applied_setup: None,
                created_at: 0,
                updated_at: 0,
            },
            setup: None,
            actions: vec![ApplyAction {
                kind: ApplyActionKind::UpdateRecords,
                skill_id: format!(
                    "remote-artifact-{}",
                    digest.as_str().strip_prefix("sha256:").unwrap()
                ),
                skill_name: "shared-skill".to_owned(),
                tools: vec!["codex".to_owned()],
                target_path: project_path
                    .join(".agents")
                    .join("skills")
                    .join("shared-skill")
                    .to_string_lossy()
                    .into_owned(),
                detail: "update tool ownership records".to_owned(),
            }],
            conflicts: vec![],
            has_changes: true,
        };

        let plan = canonical_plan(&local, &revision, root.path()).unwrap();

        assert_eq!(plan.actions[0].change, Some(PlanChangeKind::Unchanged));
        assert_eq!(plan.actions[0].metadata_only, Some(true));
        assert_eq!(actionable_plan_count(&plan), 1);
        assert_eq!(
            serde_json::to_value(&plan).unwrap()["actions"][0]["metadataOnly"],
            true
        );
    }

    #[test]
    fn remote_scan_returns_portable_discoveries_without_local_paths() {
        let root = tempdir().unwrap();
        let home = root.path().join("home");
        let project = root.path().join("project");
        let skill = home.join(".codex").join("skills").join("portable-skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(skill.join("SKILL.md"), "# Portable skill").unwrap();

        let runner = RunnerExecutionService::open(root.path().join("local-admin.db")).unwrap();
        runner.local_admin().add_project(&project).unwrap();
        let executor = LocalJobExecutor::new(runner, home.clone());
        let identity = RunnerIdentityRecord {
            server_url: "https://hub.example.test".to_owned(),
            organization_id: identifier("org_01"),
            device_id: identifier("device_01"),
            credential_secret: "secret".to_owned(),
            enrolled_at: IsoTimestamp::new("2026-09-01T10:00:00Z").unwrap(),
        };
        let instance = ProjectInstanceRecord {
            id: identifier("instance_01"),
            organization_id: identifier("org_01"),
            project_id: identifier("project_01"),
            local_path: project,
            registered_at: IsoTimestamp::new("2026-09-01T10:00:00Z").unwrap(),
        };
        let lease = LeasedRunnerJob {
            lease_id: "lease_01".to_owned(),
            lease_expires_at: IsoTimestamp::new("2026-09-01T10:02:00Z").unwrap(),
            cancel_requested: false,
            job: JobEnvelope {
                protocol_version: PROTOCOL_VERSION,
                job_id: identifier("job_01"),
                idempotency_key: identifier("scan_job_01"),
                organization_id: identifier("org_01"),
                device_id: identifier("device_01"),
                project_instance_id: identifier("instance_01"),
                issued_at: IsoTimestamp::new("2026-09-01T10:00:00Z").unwrap(),
                expires_at: IsoTimestamp::new("2026-09-01T10:05:00Z").unwrap(),
                job: RunnerJob::ScanProject(ScanProjectJob {
                    project_id: identifier("project_01"),
                    include_unmanaged: true,
                }),
            },
        };

        let result = executor.execute(
            &identity,
            Some(&instance),
            &lease,
            &IsoTimestamp::new("2026-09-01T10:01:00Z").unwrap(),
            &mut || Ok(false),
        );
        let RunnerResult::ScanResult(scan) = result.result else {
            panic!("expected scan result")
        };
        assert_eq!(scan.discoveries.len(), 1);
        assert_eq!(scan.discoveries[0].name.as_str(), "portable-skill");
        assert_eq!(scan.discoveries[0].tool_id.as_str(), "codex");
        let json = serde_json::to_string(&scan).unwrap();
        assert!(!json.contains(home.to_string_lossy().as_ref()));
    }

    #[test]
    fn remote_plan_apply_and_rollback_use_the_approved_digest() {
        let root = tempdir().unwrap();
        let home = root.path().join("home");
        let project_path = root.path().join("project");
        let source = root.path().join("source");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&project_path).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "# Remote").unwrap();
        let content_digest = Digest::new(format!(
            "sha256:{}",
            crate::content_hash::hash_dir(&source).unwrap()
        ))
        .unwrap();
        ArtifactCache::for_home(&home)
            .snapshot(&source, &content_digest)
            .unwrap();
        let runner = RunnerExecutionService::open(root.path().join("local-admin.db")).unwrap();
        runner.local_admin().add_project(&project_path).unwrap();
        let executor = LocalJobExecutor::new(runner, home);
        let identity = RunnerIdentityRecord {
            server_url: "https://hub.example.test".to_owned(),
            organization_id: identifier("org_01"),
            device_id: identifier("device_01"),
            credential_secret: "secret".to_owned(),
            enrolled_at: IsoTimestamp::new("2026-09-02T10:00:00Z").unwrap(),
        };
        let project = ProjectInstanceRecord {
            id: identifier("instance_01"),
            organization_id: identifier("org_01"),
            project_id: identifier("project_01"),
            local_path: project_path.clone(),
            registered_at: IsoTimestamp::new("2026-09-02T10:00:00Z").unwrap(),
        };
        let revision = PortableSetupRevision {
            setup_id: identifier("setup_01"),
            setup_revision_id: identifier("revision_01"),
            revision_number: 1,
            items: vec![PortableSetupRevisionItem {
                artifact_id: ArtifactId::new("artifact_01").unwrap(),
                artifact_kind: DiscoveryKind::Skill,
                portable_source: None,
                content_digest,
                tool_id: identifier("codex"),
                target_name: identifier("remote-skill"),
            }],
        };
        let envelope = |job_id: &str, runner_job: RunnerJob| LeasedRunnerJob {
            lease_id: format!("lease_{job_id}"),
            lease_expires_at: IsoTimestamp::new("2026-09-02T10:02:00Z").unwrap(),
            cancel_requested: false,
            job: JobEnvelope {
                protocol_version: PROTOCOL_VERSION,
                job_id: identifier(job_id),
                idempotency_key: Identifier::new(format!("idem_{job_id}")).unwrap(),
                organization_id: identifier("org_01"),
                device_id: identifier("device_01"),
                project_instance_id: identifier("instance_01"),
                issued_at: IsoTimestamp::new("2026-09-02T10:00:00Z").unwrap(),
                expires_at: IsoTimestamp::new("2026-09-02T10:05:00Z").unwrap(),
                job: runner_job,
            },
        };
        let now = IsoTimestamp::new("2026-09-02T10:01:00Z").unwrap();
        let plan_result = executor.execute(
            &identity,
            Some(&project),
            &envelope(
                "job_plan",
                RunnerJob::PlanSetup(PlanSetupJob {
                    project_id: identifier("project_01"),
                    revision: revision.clone(),
                }),
            ),
            &now,
            &mut || Ok(false),
        );
        let RunnerResult::PlanResult(plan_result) = plan_result.result else {
            panic!("expected plan result")
        };
        assert_eq!(plan_result.plan.actions.len(), 1);
        assert_eq!(
            plan_result.plan.actions[0].change,
            Some(PlanChangeKind::Add)
        );
        let plan_digest = plan_result.plan.plan_digest;
        let apply_result = executor.execute(
            &identity,
            Some(&project),
            &envelope(
                "job_apply",
                RunnerJob::ApplyPlan(ApplyPlanJob {
                    project_id: identifier("project_01"),
                    revision: revision.clone(),
                    approval: PlanApproval {
                        approval_id: identifier("approval_01"),
                        organization_id: identifier("org_01"),
                        project_instance_id: identifier("instance_01"),
                        setup_revision_id: identifier("revision_01"),
                        plan_digest: plan_digest.clone(),
                        approved_by: identifier("user_01"),
                        approved_at: IsoTimestamp::new("2026-09-02T10:00:30Z").unwrap(),
                        expires_at: IsoTimestamp::new("2026-09-02T10:05:00Z").unwrap(),
                    },
                }),
            ),
            &now,
            &mut || Ok(false),
        );
        let RunnerResult::ApplyReceipt(receipt) = apply_result.result else {
            panic!("expected apply receipt")
        };
        assert_eq!(receipt.plan_digest, plan_digest);
        assert!(project_path
            .join(".agents")
            .join("skills")
            .join("remote-skill")
            .exists());
        let verification_result = executor.execute(
            &identity,
            Some(&project),
            &envelope(
                "job_verify",
                RunnerJob::PlanSetup(PlanSetupJob {
                    project_id: identifier("project_01"),
                    revision: revision.clone(),
                }),
            ),
            &now,
            &mut || Ok(false),
        );
        let RunnerResult::PlanResult(verification) = verification_result.result else {
            panic!("expected verification plan")
        };
        assert_eq!(verification.plan.actions.len(), 1);
        assert_eq!(
            verification.plan.actions[0].change,
            Some(PlanChangeKind::Unchanged)
        );
        let rollback_result = executor.execute(
            &identity,
            Some(&project),
            &envelope(
                "job_rollback",
                RunnerJob::RollbackOperation(RollbackOperationJob {
                    project_id: identifier("project_01"),
                    operation_id: receipt.operation_id,
                }),
            ),
            &now,
            &mut || Ok(false),
        );
        assert!(matches!(
            rollback_result.result,
            RunnerResult::RollbackReceipt(_)
        ));
        assert!(!project_path
            .join(".agents")
            .join("skills")
            .join("remote-skill")
            .exists());

        let checks = Cell::new(0_u32);
        let mut cancel_after_apply = || {
            let next = checks.get() + 1;
            checks.set(next);
            Ok(next >= 4)
        };
        let cancelled = executor.execute(
            &identity,
            Some(&project),
            &envelope(
                "job_cancelled_apply",
                RunnerJob::ApplyPlan(ApplyPlanJob {
                    project_id: identifier("project_01"),
                    revision: revision.clone(),
                    approval: PlanApproval {
                        approval_id: identifier("approval_02"),
                        organization_id: identifier("org_01"),
                        project_instance_id: identifier("instance_01"),
                        setup_revision_id: identifier("revision_01"),
                        plan_digest,
                        approved_by: identifier("user_01"),
                        approved_at: IsoTimestamp::new("2026-09-02T10:00:30Z").unwrap(),
                        expires_at: IsoTimestamp::new("2026-09-02T10:05:00Z").unwrap(),
                    },
                }),
            ),
            &now,
            &mut cancel_after_apply,
        );
        let RunnerResult::CancellationReceipt(receipt) = cancelled.result else {
            panic!("expected cancellation receipt")
        };
        assert_eq!(
            receipt.outcome,
            ahm_domain::CancellationOutcome::CancelledAndRestored
        );
        assert_eq!(receipt.actions_applied, 1);
        assert!(!project_path
            .join(".agents")
            .join("skills")
            .join("remote-skill")
            .exists());
    }
}
