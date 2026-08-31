use std::path::PathBuf;

use ahm_domain::{
    Digest, DiscoveryKind, DiscoveryState, ErrorResult, Identifier, IsoTimestamp, JobEnvelope,
    LeasedRunnerJob, ProjectId, ProtocolErrorCode, Recoverability, ResultEnvelope,
    RunnerCapabilities, RunnerJob, RunnerResult, ScanDiscovery, ScanResult, PROTOCOL_VERSION,
};
use sha2::{Digest as ShaDigest, Sha256};

use crate::{
    execution::RunnerExecutionService,
    setup_service::{DefaultSetupCandidate, DefaultSetupCandidateKind},
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
    ) -> ResultEnvelope;
}

pub struct LocalJobExecutor {
    runner: RunnerExecutionService,
    home: PathBuf,
}

impl LocalJobExecutor {
    pub fn new(runner: RunnerExecutionService, home: PathBuf) -> Self {
        Self { runner, home }
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
                    .filter_map(candidate_to_discovery)
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
}

impl JobExecutor for LocalJobExecutor {
    fn capabilities(&self) -> RunnerCapabilities {
        scan_capabilities()
    }

    fn execute(
        &self,
        identity: &RunnerIdentityRecord,
        project: Option<&ProjectInstanceRecord>,
        lease: &LeasedRunnerJob,
        now: &IsoTimestamp,
    ) -> ResultEnvelope {
        let job = &lease.job;
        let result = if lease.cancel_requested {
            protocol_error(ProtocolErrorCode::JobCancelled, "job was cancelled", false)
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
                    RunnerJob::PlanSetup(_)
                    | RunnerJob::ApplyPlan(_)
                    | RunnerJob::RollbackOperation(_) => protocol_error(
                        ProtocolErrorCode::CapabilityUnavailable,
                        "remote mutation is not available in this runner version",
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
}

fn is_expired(expires_at: &IsoTimestamp, now: &IsoTimestamp) -> bool {
    let expires_at = chrono::DateTime::parse_from_rfc3339(expires_at.as_str());
    let now = chrono::DateTime::parse_from_rfc3339(now.as_str());
    matches!((expires_at, now), (Ok(expires_at), Ok(now)) if expires_at <= now)
}

pub fn scan_capabilities() -> RunnerCapabilities {
    RunnerCapabilities {
        scan_project: true,
        plan_setup: false,
        apply_plan: false,
        rollback_operation: false,
        supported_tools: default_tool_adapters()
            .into_iter()
            .filter_map(|adapter| Identifier::new(adapter.id.as_key()).ok())
            .collect(),
    }
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
    use ahm_domain::{
        Identifier, JobEnvelope, LeasedRunnerJob, RunnerJob, RunnerResult, ScanProjectJob,
    };
    use tempfile::tempdir;

    use super::*;

    fn identifier(value: &str) -> Identifier {
        Identifier::new(value).unwrap()
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
}
