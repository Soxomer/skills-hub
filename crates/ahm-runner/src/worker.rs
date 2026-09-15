use ahm_domain::{
    AcknowledgeRunnerJobRequest, ClaimRunnerJobRequest, Digest, DiscoveryState, IsoTimestamp,
    ProtocolErrorCode, ResultEnvelope, RunnerCapabilityReport, RunnerJob, RunnerJobControlRequest,
    RunnerResult, SubmitRunnerResultRequest, PROTOCOL_VERSION,
};
use anyhow::{anyhow, Context, Result};
use chrono::{SecondsFormat, Utc};
use sha2::{Digest as ShaDigest, Sha256};

use crate::{
    job_dispatcher::{protocol_error, JobExecutor},
    state::{JournalStartOutcome, RunnerStateStore},
    transport::RunnerTransport,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerOutcome {
    Idle,
    Processed,
    Replayed,
}

#[derive(Debug)]
struct PermanentArtifactFailure;

impl std::fmt::Display for PermanentArtifactFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("artifact cannot be prepared or published")
    }
}

impl std::error::Error for PermanentArtifactFailure {}

fn permanent_artifact_failure(error: &anyhow::Error) -> bool {
    error.is::<PermanentArtifactFailure>()
        || error.downcast_ref::<reqwest::Error>().is_some_and(|error| {
            error.is_decode()
                || error.status().is_some_and(|status| {
                    status.is_client_error() && !matches!(status.as_u16(), 401 | 403 | 408 | 429)
                })
        })
}

fn artifact_failure_result(error: &anyhow::Error) -> RunnerResult {
    log::warn!("permanent artifact failure: {error:#}");
    protocol_error(ProtocolErrorCode::Conflict,
        "Artifact validation or size limit failed; inspect runner logs and correct the artifact before retrying", false)
}

pub struct RunnerWorker<T, E> {
    state: RunnerStateStore,
    transport: T,
    executor: E,
    claim_wait_ms: u64,
}

impl<T: RunnerTransport, E: JobExecutor> RunnerWorker<T, E> {
    pub fn new(state: RunnerStateStore, transport: T, executor: E) -> Self {
        Self {
            state,
            transport,
            executor,
            claim_wait_ms: 25_000,
        }
    }

    pub fn with_claim_wait_ms(mut self, claim_wait_ms: u64) -> Self {
        self.claim_wait_ms = claim_wait_ms.min(25_000);
        self
    }

    pub fn run_once(&mut self) -> Result<WorkerOutcome> {
        let identity = self
            .state
            .identity()?
            .ok_or_else(|| anyhow!("runner is not connected; run `ahm connect` first"))?;
        self.flush_outbox(&identity)?;
        if let Err(error) = self.executor.maintenance() {
            log::warn!("Library maintenance: {error:#}");
        }

        let request = ClaimRunnerJobRequest {
            skill_library: match self.executor.skill_library() {
                Ok(Some(skills))
                    if skills.len() <= 5000 && serde_json::to_vec(&skills)?.len() <= 512_000 =>
                {
                    Some(skills)
                }
                Ok(None) => None,
                Ok(Some(_)) => {
                    log::warn!("skill library exceeds reporting limit");
                    None
                }
                Err(error) => {
                    log::warn!("skill library unavailable: {error:#}");
                    None
                }
            },
            capabilities: RunnerCapabilityReport {
                protocol_version: PROTOCOL_VERSION,
                supported_protocol_versions: vec![PROTOCOL_VERSION],
                runner_version: env!("CARGO_PKG_VERSION").to_owned(),
                capabilities: self.executor.capabilities(),
            },
            wait_ms: Some(self.claim_wait_ms),
        };
        let Some(lease) = self.transport.claim_job(&identity, &request)? else {
            return Ok(WorkerOutcome::Idle);
        };
        let now = utc_now();
        let project = lease
            .job
            .project_instance_id
            .as_ref()
            .map(|id| self.state.project_instance(id))
            .transpose()?
            .flatten();
        let request_json = serde_json::to_string(&lease.job)?;
        let request_digest = sha256(&request_json);
        let start = self
            .state
            .begin_job(&lease.job, &lease.lease_id, &request_digest, &now)?;
        self.transport.acknowledge_job(
            &identity,
            lease.job.job_id.as_str(),
            &AcknowledgeRunnerJobRequest {
                lease_id: lease.lease_id.clone(),
                request_digest: Digest::new(request_digest.clone())?,
            },
        )?;
        match start {
            JournalStartOutcome::Completed { .. } => {
                self.flush_outbox(&identity)?;
                Ok(WorkerOutcome::Replayed)
            }
            JournalStartOutcome::IdempotencyMismatch => {
                let result = ResultEnvelope {
                    protocol_version: PROTOCOL_VERSION,
                    job_id: lease.job.job_id.clone(),
                    idempotency_key: lease.job.idempotency_key.clone(),
                    organization_id: lease.job.organization_id.clone(),
                    device_id: lease.job.device_id.clone(),
                    project_instance_id: lease.job.project_instance_id.clone(),
                    result: protocol_error(
                        ProtocolErrorCode::IdempotencyMismatch,
                        "idempotency key was already used for different work",
                        false,
                    ),
                };
                let result_json = serde_json::to_string(&result)?;
                self.state.finish_job(
                    &lease.job,
                    &lease.lease_id,
                    &result_json,
                    &sha256(&result_json),
                    true,
                    &utc_now(),
                )?;
                self.flush_outbox(&identity)?;
                Ok(WorkerOutcome::Replayed)
            }
            JournalStartOutcome::Execute => {
                let transport = &self.transport;
                let mut effective_lease = lease.clone();
                if !effective_lease.cancel_requested {
                    effective_lease.cancel_requested = transport
                        .job_control(
                            &identity,
                            effective_lease.job.job_id.as_str(),
                            &RunnerJobControlRequest {
                                lease_id: effective_lease.lease_id.clone(),
                            },
                        )?
                        .cancel_requested;
                }
                let preparation = if effective_lease.cancel_requested {
                    Ok(true)
                } else {
                    self.prepare_required_artifacts(&identity, &effective_lease)
                };
                let mut result = match preparation {
                    Ok(true) => {
                        let mut should_cancel = || {
                            transport
                                .job_control(
                                    &identity,
                                    effective_lease.job.job_id.as_str(),
                                    &RunnerJobControlRequest {
                                        lease_id: effective_lease.lease_id.clone(),
                                    },
                                )
                                .map(|control| control.cancel_requested)
                        };
                        self.executor.execute(
                            &identity,
                            project.as_ref(),
                            &effective_lease,
                            &now,
                            &mut should_cancel,
                        )
                    }
                    Ok(false) => ResultEnvelope {
                        protocol_version: PROTOCOL_VERSION,
                        job_id: lease.job.job_id.clone(),
                        idempotency_key: lease.job.idempotency_key.clone(),
                        organization_id: lease.job.organization_id.clone(),
                        device_id: lease.job.device_id.clone(),
                        project_instance_id: lease.job.project_instance_id.clone(),
                        result: protocol_error(
                            ProtocolErrorCode::Conflict,
                            "Setup artifact is not available from the local or shared cache",
                            false,
                        ),
                    },
                    Err(error) if permanent_artifact_failure(&error) => ResultEnvelope {
                        protocol_version: PROTOCOL_VERSION,
                        job_id: lease.job.job_id.clone(),
                        idempotency_key: lease.job.idempotency_key.clone(),
                        organization_id: lease.job.organization_id.clone(),
                        device_id: lease.job.device_id.clone(),
                        project_instance_id: lease.job.project_instance_id.clone(),
                        result: artifact_failure_result(&error),
                    },
                    Err(error) => return Err(error),
                };
                if let Err(error) = self.publish_scan_artifacts(&identity, &result) {
                    if !permanent_artifact_failure(&error) {
                        return Err(error);
                    }
                    result.result = artifact_failure_result(&error);
                }
                match &result.result {
                    RunnerResult::ApplyReceipt(receipt) => self.state.record_materialization(
                        lease
                            .job
                            .project_instance_id
                            .as_ref()
                            .context("Apply requires a project")?,
                        receipt,
                    )?,
                    RunnerResult::RollbackReceipt(receipt) => self
                        .state
                        .mark_materialization_rolled_back(receipt.operation_id.as_str())?,
                    _ => {}
                }
                let failed = matches!(result.result, RunnerResult::Error(_));
                let result_json = serde_json::to_string(&result)?;
                self.state.finish_job(
                    &lease.job,
                    &lease.lease_id,
                    &result_json,
                    &sha256(&result_json),
                    failed,
                    &utc_now(),
                )?;
                self.flush_outbox(&identity)?;
                Ok(WorkerOutcome::Processed)
            }
        }
    }

    fn prepare_required_artifacts(
        &self,
        identity: &crate::state::RunnerIdentityRecord,
        lease: &ahm_domain::LeasedRunnerJob,
    ) -> Result<bool> {
        let revision = match &lease.job.job {
            RunnerJob::PlanSetup(job) => Some(&job.revision),
            RunnerJob::ApplyPlan(job) => Some(&job.revision),
            RunnerJob::LibraryAction(_)
            | RunnerJob::ScanProject(_)
            | RunnerJob::RollbackOperation(_) => None,
        };
        let Some(revision) = revision else {
            return Ok(true);
        };
        let mut seen = std::collections::HashSet::new();
        for item in &revision.items {
            if !seen.insert(item.content_digest.as_str().to_owned())
                || self
                    .executor
                    .has_artifact(&item.content_digest)
                    .context(PermanentArtifactFailure)?
            {
                continue;
            }
            let Some(bundle) = self
                .transport
                .load_artifact(identity, &item.content_digest)?
            else {
                return Ok(false);
            };
            self.executor
                .store_artifact(&bundle)
                .context(PermanentArtifactFailure)?;
        }
        Ok(true)
    }

    fn publish_scan_artifacts(
        &self,
        identity: &crate::state::RunnerIdentityRecord,
        result: &ResultEnvelope,
    ) -> Result<()> {
        let RunnerResult::ScanResult(scan) = &result.result else {
            return Ok(());
        };
        let mut seen = std::collections::HashSet::new();
        for discovery in &scan.discoveries {
            if discovery.state != DiscoveryState::Available
                || !seen.insert(discovery.content_digest.as_str().to_owned())
            {
                continue;
            }
            let bundle = self
                .executor
                .artifact_bundle(&discovery.content_digest)
                .context(PermanentArtifactFailure)?
                .context(PermanentArtifactFailure)?;
            self.transport.store_artifact(identity, &bundle)?;
        }
        Ok(())
    }

    fn flush_outbox(&self, identity: &crate::state::RunnerIdentityRecord) -> Result<()> {
        let now = utc_now();
        for record in self.state.pending_outbox(&now)? {
            let result: ResultEnvelope = serde_json::from_str(&record.result_json)
                .context("decode durable runner result")?;
            let request = SubmitRunnerResultRequest {
                lease_id: record.lease_id,
                result,
            };
            match self
                .transport
                .submit_result(identity, &record.job_id, &request)
            {
                Ok(acknowledgement) if acknowledgement.accepted => {
                    self.state
                        .mark_outbox_delivered(&record.job_id, &utc_now())?;
                }
                Ok(_) => {
                    self.defer_outbox(&record.job_id, record.attempt_count)?;
                }
                Err(error) => {
                    log::warn!("result delivery for {} failed: {error:#}", record.job_id);
                    self.defer_outbox(&record.job_id, record.attempt_count)?;
                }
            }
        }
        Ok(())
    }

    fn defer_outbox(&self, job_id: &str, attempt_count: u32) -> Result<()> {
        let exponent = attempt_count.min(5);
        let delay = 2_i64.pow(exponent);
        let retry = Utc::now() + chrono::Duration::seconds(delay);
        self.state.mark_outbox_attempt(
            job_id,
            &IsoTimestamp::new(retry.to_rfc3339_opts(SecondsFormat::Millis, true))?,
        )?;
        Ok(())
    }
}

pub fn utc_now() -> IsoTimestamp {
    IsoTimestamp::new(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
        .expect("UTC timestamps satisfy the protocol")
}

fn sha256(value: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value.as_bytes())))
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::VecDeque, path::PathBuf};

    use ahm_domain::{
        DeviceId, Identifier, JobEnvelope, LeasedRunnerJob, OrganizationId, ProjectId,
        ProjectInstanceId, RunnerCapabilities, RunnerJob, RunnerResultAcknowledgement,
        ScanProjectJob,
    };

    use super::*;
    use crate::{
        state::{ProjectInstanceRecord, RunnerIdentityRecord},
        transport::RunnerTransport,
    };

    struct FakeTransport {
        jobs: RefCell<VecDeque<LeasedRunnerJob>>,
        submissions: RefCell<Vec<SubmitRunnerResultRequest>>,
        fail_submissions: RefCell<bool>,
        fail_uploads: RefCell<bool>,
        downloaded_artifact: RefCell<Option<ahm_domain::ArtifactBundle>>,
        cancel_requested: RefCell<bool>,
        control_checks: RefCell<u32>,
    }

    impl RunnerTransport for FakeTransport {
        fn enroll(
            &self,
            _request: &ahm_domain::EnrollRunnerRequest,
        ) -> Result<ahm_domain::EnrollRunnerResponse> {
            unreachable!()
        }

        fn register_project_instance(
            &self,
            _identity: &RunnerIdentityRecord,
            _request: &ahm_domain::RegisterProjectInstanceRequest,
        ) -> Result<()> {
            unreachable!()
        }

        fn claim_job(
            &self,
            _identity: &RunnerIdentityRecord,
            _request: &ClaimRunnerJobRequest,
        ) -> Result<Option<LeasedRunnerJob>> {
            Ok(self.jobs.borrow_mut().pop_front())
        }

        fn acknowledge_job(
            &self,
            _identity: &RunnerIdentityRecord,
            _job_id: &str,
            _request: &ahm_domain::AcknowledgeRunnerJobRequest,
        ) -> Result<ahm_domain::RunnerJobAcknowledgement> {
            Ok(ahm_domain::RunnerJobAcknowledgement {
                accepted: true,
                duplicate: false,
            })
        }

        fn job_control(
            &self,
            _identity: &RunnerIdentityRecord,
            _job_id: &str,
            _request: &ahm_domain::RunnerJobControlRequest,
        ) -> Result<ahm_domain::RunnerJobControlResponse> {
            *self.control_checks.borrow_mut() += 1;
            Ok(ahm_domain::RunnerJobControlResponse {
                cancel_requested: *self.cancel_requested.borrow(),
            })
        }

        fn store_artifact(
            &self,
            _identity: &RunnerIdentityRecord,
            _bundle: &ahm_domain::ArtifactBundle,
        ) -> Result<()> {
            if *self.fail_uploads.borrow() {
                anyhow::bail!("temporarily offline");
            }
            Ok(())
        }

        fn load_artifact(
            &self,
            _identity: &RunnerIdentityRecord,
            _digest: &ahm_domain::Digest,
        ) -> Result<Option<ahm_domain::ArtifactBundle>> {
            Ok(self.downloaded_artifact.borrow().clone())
        }

        fn submit_result(
            &self,
            _identity: &RunnerIdentityRecord,
            _job_id: &str,
            request: &SubmitRunnerResultRequest,
        ) -> Result<RunnerResultAcknowledgement> {
            if *self.fail_submissions.borrow() {
                anyhow::bail!("offline");
            }
            self.submissions.borrow_mut().push(request.clone());
            Ok(RunnerResultAcknowledgement {
                accepted: true,
                duplicate: false,
            })
        }
    }

    struct FakeExecutor {
        executions: RefCell<u32>,
        cache: Option<crate::artifact_cache::ArtifactCache>,
        discovery: Option<ahm_domain::ScanDiscovery>,
    }

    impl JobExecutor for FakeExecutor {
        fn capabilities(&self) -> RunnerCapabilities {
            RunnerCapabilities {
                scan_project: true,
                plan_setup: false,
                apply_plan: false,
                rollback_operation: false,
                library: true,
                supported_tools: vec![Identifier::new("codex").unwrap()],
            }
        }

        fn execute(
            &self,
            _identity: &RunnerIdentityRecord,
            _project: Option<&ProjectInstanceRecord>,
            lease: &LeasedRunnerJob,
            _now: &IsoTimestamp,
            should_cancel: &mut dyn FnMut() -> Result<bool>,
        ) -> ResultEnvelope {
            *self.executions.borrow_mut() += 1;
            let result = if lease.cancel_requested || should_cancel().unwrap() {
                protocol_error(ProtocolErrorCode::JobCancelled, "job was cancelled", false)
            } else {
                RunnerResult::ScanResult(ahm_domain::ScanResult {
                    project_id: Identifier::new("project_01").unwrap(),
                    discoveries: self.discovery.clone().into_iter().collect(),
                })
            };
            ResultEnvelope {
                protocol_version: PROTOCOL_VERSION,
                job_id: lease.job.job_id.clone(),
                idempotency_key: lease.job.idempotency_key.clone(),
                organization_id: lease.job.organization_id.clone(),
                device_id: lease.job.device_id.clone(),
                project_instance_id: lease.job.project_instance_id.clone(),
                result,
            }
        }

        fn store_artifact(&self, bundle: &ahm_domain::ArtifactBundle) -> Result<()> {
            self.cache.as_ref().unwrap().store(bundle)?;
            Ok(())
        }

        fn artifact_bundle(&self, digest: &Digest) -> Result<Option<ahm_domain::ArtifactBundle>> {
            self.cache.as_ref().unwrap().bundle(digest)
        }
    }

    fn identifier(value: &str) -> Identifier {
        Identifier::new(value).unwrap()
    }

    fn lease(lease_id: &str) -> LeasedRunnerJob {
        LeasedRunnerJob {
            lease_id: lease_id.to_owned(),
            lease_expires_at: IsoTimestamp::new("2099-09-01T10:01:00Z").unwrap(),
            cancel_requested: false,
            job: JobEnvelope {
                protocol_version: PROTOCOL_VERSION,
                job_id: identifier("job_01"),
                idempotency_key: identifier("scan_job_01"),
                organization_id: OrganizationId::new("org_01").unwrap(),
                device_id: DeviceId::new("device_01").unwrap(),
                project_instance_id: Some(ProjectInstanceId::new("instance_01").unwrap()),
                issued_at: IsoTimestamp::new("2026-09-01T10:00:00Z").unwrap(),
                expires_at: IsoTimestamp::new("2099-09-01T10:05:00Z").unwrap(),
                job: RunnerJob::ScanProject(ScanProjectJob {
                    project_id: ProjectId::new("project_01").unwrap(),
                    include_unmanaged: true,
                }),
            },
        }
    }

    fn worker(
        jobs: VecDeque<LeasedRunnerJob>,
        offline: bool,
    ) -> RunnerWorker<FakeTransport, FakeExecutor> {
        let state = RunnerStateStore::open_in_memory().unwrap();
        state
            .save_identity(&RunnerIdentityRecord {
                server_url: "https://hub.example.test".to_owned(),
                organization_id: identifier("org_01"),
                device_id: identifier("device_01"),
                credential_secret: "secret".to_owned(),
                enrolled_at: utc_now(),
            })
            .unwrap();
        state
            .register_project_instance(&ProjectInstanceRecord {
                id: identifier("instance_01"),
                organization_id: identifier("org_01"),
                project_id: identifier("project_01"),
                local_path: PathBuf::from("project"),
                registered_at: utc_now(),
            })
            .unwrap();
        RunnerWorker::new(
            state,
            FakeTransport {
                jobs: RefCell::new(jobs),
                submissions: RefCell::new(Vec::new()),
                fail_submissions: RefCell::new(offline),
                fail_uploads: RefCell::new(false),
                downloaded_artifact: RefCell::new(None),
                cancel_requested: RefCell::new(false),
                control_checks: RefCell::new(0),
            },
            FakeExecutor {
                executions: RefCell::new(0),
                cache: None,
                discovery: None,
            },
        )
    }

    #[test]
    fn completed_jobs_are_replayed_without_execution() {
        let first_lease = lease("lease_01");
        let second_lease = lease("lease_02");
        let mut worker = worker(VecDeque::from([first_lease, second_lease]), false);

        assert_eq!(worker.run_once().unwrap(), WorkerOutcome::Processed);
        assert_eq!(worker.run_once().unwrap(), WorkerOutcome::Replayed);
        assert_eq!(*worker.executor.executions.borrow(), 1);
        assert_eq!(worker.transport.submissions.borrow().len(), 2);
    }

    #[test]
    fn result_remains_durable_while_transport_is_offline() {
        let mut worker = worker(VecDeque::from([lease("lease_01")]), true);
        assert_eq!(worker.run_once().unwrap(), WorkerOutcome::Processed);
        assert_eq!(*worker.executor.executions.borrow(), 1);
        assert_eq!(worker.state.undelivered_outbox_count().unwrap(), 1);

        *worker.transport.fail_submissions.borrow_mut() = false;
        worker
            .state
            .mark_outbox_attempt("job_01", &utc_now())
            .unwrap();
        assert_eq!(worker.run_once().unwrap(), WorkerOutcome::Idle);
        assert_eq!(*worker.executor.executions.borrow(), 1);
        assert_eq!(worker.state.undelivered_outbox_count().unwrap(), 0);
        assert_eq!(worker.transport.submissions.borrow().len(), 1);
    }

    #[test]
    fn execution_reads_cancellation_after_acknowledgement() {
        let mut worker = worker(VecDeque::from([lease("lease_01")]), false);
        *worker.transport.cancel_requested.borrow_mut() = true;

        assert_eq!(worker.run_once().unwrap(), WorkerOutcome::Processed);
        assert_eq!(*worker.transport.control_checks.borrow(), 1);
        let submissions = worker.transport.submissions.borrow();
        assert!(matches!(
            submissions[0].result.result,
            RunnerResult::Error(ref error) if error.code == ProtocolErrorCode::JobCancelled
        ));
    }

    fn scanned_artifact(
        worker: &mut RunnerWorker<FakeTransport, FakeExecutor>,
        root: &std::path::Path,
        size: usize,
    ) {
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), vec![b'a'; size]).unwrap();
        let digest = Digest::new(format!(
            "sha256:{}",
            crate::content_hash::hash_dir(&source).unwrap()
        ))
        .unwrap();
        let cache = crate::artifact_cache::ArtifactCache::new(root.join("cache"));
        cache.snapshot(&source, &digest).unwrap();
        worker.executor.cache = Some(cache);
        worker.executor.discovery = Some(ahm_domain::ScanDiscovery {
            discovery_id: identifier("discovery_01"),
            kind: ahm_domain::DiscoveryKind::Skill,
            state: DiscoveryState::Available,
            name: identifier("skill"),
            tool_id: identifier("codex"),
            portable_source: None,
            content_digest: digest,
        });
    }

    #[test]
    fn oversized_artifact_finishes_failed_and_next_job_runs() {
        let root = tempfile::tempdir().unwrap();
        let mut next = lease("lease_next");
        next.job.job_id = identifier("job_next");
        next.job.idempotency_key = identifier("scan_next");
        let mut worker = worker(VecDeque::from([lease("lease_01"), next]), false);
        scanned_artifact(&mut worker, root.path(), 10 * 1024 * 1024 + 1);
        assert_eq!(worker.run_once().unwrap(), WorkerOutcome::Processed);
        assert!(
            matches!(worker.transport.submissions.borrow()[0].result.result,
            RunnerResult::Error(ref error) if error.code == ProtocolErrorCode::Conflict && !error.retryable)
        );
        worker.executor.discovery = None;
        assert_eq!(worker.run_once().unwrap(), WorkerOutcome::Processed);
        assert!(matches!(
            worker.transport.submissions.borrow()[1].result.result,
            RunnerResult::ScanResult(_)
        ));
        assert_eq!(worker.state.undelivered_outbox_count().unwrap(), 0);
    }

    #[test]
    fn transient_upload_failure_retries_without_false_terminal_result() {
        let root = tempfile::tempdir().unwrap();
        let mut worker = worker(
            VecDeque::from([lease("lease_01"), lease("lease_01")]),
            false,
        );
        scanned_artifact(&mut worker, root.path(), 20);
        *worker.transport.fail_uploads.borrow_mut() = true;
        assert!(worker.run_once().is_err());
        assert!(worker.transport.submissions.borrow().is_empty());
        *worker.transport.fail_uploads.borrow_mut() = false;
        assert_eq!(worker.run_once().unwrap(), WorkerOutcome::Processed);
        assert!(matches!(
            worker.transport.submissions.borrow()[0].result.result,
            RunnerResult::ScanResult(_)
        ));
    }

    #[test]
    fn rejected_upload_is_permanent_but_throttling_and_server_errors_retry() {
        let mut server = mockito::Server::new();
        for (status, permanent) in [(413, true), (400, true), (429, false), (503, false)] {
            let endpoint = server.mock("PUT", "/artifact").with_status(status).create();
            let error = reqwest::blocking::Client::new()
                .put(format!("{}/artifact", server.url()))
                .send()
                .unwrap()
                .error_for_status()
                .unwrap_err();
            assert_eq!(permanent_artifact_failure(&error.into()), permanent);
            endpoint.assert();
            endpoint.remove();
        }
    }

    #[test]
    fn invalid_download_is_a_durable_error_before_execution() {
        let root = tempfile::tempdir().unwrap();
        let mut plan = lease("lease_01");
        let fixture: ahm_domain::JobEnvelope = serde_json::from_str(include_str!(
            "../../../packages/contracts/fixtures/v1/job-plan.json"
        ))
        .unwrap();
        plan.job.job = fixture.job;
        let digest = match &plan.job.job {
            RunnerJob::PlanSetup(job) => job.revision.items[0].content_digest.clone(),
            _ => unreachable!(),
        };
        let mut worker = worker(VecDeque::from([plan]), false);
        worker.executor.cache = Some(crate::artifact_cache::ArtifactCache::new(
            root.path().join("cache"),
        ));
        *worker.transport.downloaded_artifact.borrow_mut() = Some(ahm_domain::ArtifactBundle {
            content_digest: digest,
            entries: vec![],
        });
        assert_eq!(worker.run_once().unwrap(), WorkerOutcome::Processed);
        assert_eq!(*worker.executor.executions.borrow(), 0);
        assert!(
            matches!(worker.transport.submissions.borrow()[0].result.result,
            RunnerResult::Error(ref error) if !error.retryable)
        );
    }
}
