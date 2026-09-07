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

        let request = ClaimRunnerJobRequest {
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
        let project = self
            .state
            .project_instance(&lease.job.project_instance_id)?;
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
                let result = if effective_lease.cancel_requested
                    || self.prepare_required_artifacts(&identity, &effective_lease)?
                {
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
                } else {
                    ResultEnvelope {
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
                    }
                };
                self.publish_scan_artifacts(&identity, &result)?;
                match &result.result {
                    RunnerResult::ApplyReceipt(receipt) => self
                        .state
                        .record_materialization(&lease.job.project_instance_id, receipt)?,
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
            RunnerJob::ScanProject(_) | RunnerJob::RollbackOperation(_) => None,
        };
        let Some(revision) = revision else {
            return Ok(true);
        };
        let mut seen = std::collections::HashSet::new();
        for item in &revision.items {
            if !seen.insert(item.content_digest.as_str().to_owned())
                || self.executor.has_artifact(&item.content_digest)?
            {
                continue;
            }
            let Some(bundle) = self
                .transport
                .load_artifact(identity, &item.content_digest)?
            else {
                return Ok(false);
            };
            self.executor.store_artifact(&bundle)?;
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
                .artifact_bundle(&discovery.content_digest)?
                .context("scanned artifact is missing from the local cache")?;
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
            Ok(())
        }

        fn load_artifact(
            &self,
            _identity: &RunnerIdentityRecord,
            _digest: &ahm_domain::Digest,
        ) -> Result<Option<ahm_domain::ArtifactBundle>> {
            Ok(None)
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
    }

    impl JobExecutor for FakeExecutor {
        fn capabilities(&self) -> RunnerCapabilities {
            RunnerCapabilities {
                scan_project: true,
                plan_setup: false,
                apply_plan: false,
                rollback_operation: false,
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
                    discoveries: vec![],
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
                project_instance_id: ProjectInstanceId::new("instance_01").unwrap(),
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
                cancel_requested: RefCell::new(false),
                control_checks: RefCell::new(0),
            },
            FakeExecutor {
                executions: RefCell::new(0),
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
}
