use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Identifier(String);

impl Identifier {
    pub fn new(value: impl Into<String>) -> Result<Self, ContractValueError> {
        let value = value.into();
        if value.is_empty() || value.len() > 200 {
            return Err(ContractValueError("identifier must contain 1 to 200 bytes"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Identifier {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Digest(String);

impl Digest {
    pub fn new(value: impl Into<String>) -> Result<Self, ContractValueError> {
        let value = value.into();
        let digest = value.strip_prefix("sha256:").unwrap_or_default();
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ContractValueError(
                "digest must be a lowercase sha256 value",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct IsoTimestamp(String);

impl IsoTimestamp {
    pub fn new(value: impl Into<String>) -> Result<Self, ContractValueError> {
        let value = value.into();
        let is_timestamp = value.len() >= 20
            && value.ends_with('Z')
            && value.as_bytes().get(4) == Some(&b'-')
            && value.as_bytes().get(7) == Some(&b'-')
            && value.as_bytes().get(10) == Some(&b'T')
            && value.as_bytes().get(13) == Some(&b':')
            && value.as_bytes().get(16) == Some(&b':');
        if !is_timestamp {
            return Err(ContractValueError("timestamp must be UTC ISO-8601"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for IsoTimestamp {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ProjectRelativePath(String);

impl ProjectRelativePath {
    pub fn new(value: impl Into<String>) -> Result<Self, ContractValueError> {
        let value = value.into();
        let has_drive_prefix = value.as_bytes().get(1) == Some(&b':');
        let is_rooted = value.starts_with('/') || value.starts_with('\\');
        let traverses_parent = value.split(['/', '\\']).any(|component| component == "..");
        if value.is_empty() || has_drive_prefix || is_rooted || traverses_parent {
            return Err(ContractValueError(
                "project destination must be a non-traversing relative path",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ProjectRelativePath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContractValueError(&'static str);

impl fmt::Display for ContractValueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for ContractValueError {}

pub type OrganizationId = Identifier;
pub type UserId = Identifier;
pub type DeviceId = Identifier;
pub type ProjectId = Identifier;
pub type ProjectInstanceId = Identifier;
pub type SetupRevisionId = Identifier;
pub type JobId = Identifier;
pub type OperationId = Identifier;
pub type ApprovalId = Identifier;
pub type ArtifactId = Identifier;
pub type DiscoveryId = Identifier;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ProtocolVersion {
    #[serde(rename = "1.0")]
    V1,
}

pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V1;

pub fn negotiate_protocol_version(remote_versions: &[ProtocolVersion]) -> Option<ProtocolVersion> {
    remote_versions
        .contains(&PROTOCOL_VERSION)
        .then_some(PROTOCOL_VERSION)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerCapabilities {
    pub scan_project: bool,
    pub plan_setup: bool,
    pub apply_plan: bool,
    pub rollback_operation: bool,
    pub supported_tools: Vec<Identifier>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityEnvelope {
    pub protocol_version: ProtocolVersion,
    pub supported_protocol_versions: Vec<ProtocolVersion>,
    pub runner_version: Identifier,
    pub device_id: DeviceId,
    pub capabilities: RunnerCapabilities,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase")]
pub enum RunnerJob {
    ScanProject(ScanProjectJob),
    PlanSetup(PlanSetupJob),
    ApplyPlan(ApplyPlanJob),
    RollbackOperation(RollbackOperationJob),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableSetupRevisionItem {
    pub artifact_id: ArtifactId,
    pub artifact_kind: DiscoveryKind,
    pub portable_source: Option<String>,
    pub content_digest: Digest,
    pub tool_id: Identifier,
    pub target_name: Identifier,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableSetupRevision {
    pub setup_id: Identifier,
    pub setup_revision_id: SetupRevisionId,
    pub revision_number: u64,
    pub items: Vec<PortableSetupRevisionItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanProjectJob {
    pub project_id: ProjectId,
    pub include_unmanaged: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanSetupJob {
    pub project_id: ProjectId,
    pub revision: PortableSetupRevision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanApproval {
    pub approval_id: ApprovalId,
    pub organization_id: OrganizationId,
    pub project_instance_id: ProjectInstanceId,
    pub setup_revision_id: SetupRevisionId,
    pub plan_digest: Digest,
    pub approved_by: UserId,
    pub approved_at: IsoTimestamp,
    pub expires_at: IsoTimestamp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyPlanJob {
    pub project_id: ProjectId,
    pub revision: PortableSetupRevision,
    pub approval: PlanApproval,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackOperationJob {
    pub project_id: ProjectId,
    pub operation_id: OperationId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobEnvelope {
    pub protocol_version: ProtocolVersion,
    pub job_id: JobId,
    pub idempotency_key: Identifier,
    pub organization_id: OrganizationId,
    pub device_id: DeviceId,
    pub project_instance_id: ProjectInstanceId,
    pub issued_at: IsoTimestamp,
    pub expires_at: IsoTimestamp,
    pub job: RunnerJob,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryKind {
    Skill,
    PluginSkill,
    LocalContent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryState {
    Available,
    Conflict,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanDiscovery {
    pub discovery_id: DiscoveryId,
    pub kind: DiscoveryKind,
    pub state: DiscoveryState,
    pub name: Identifier,
    pub tool_id: Identifier,
    pub portable_source: Option<String>,
    pub content_digest: Digest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanResult {
    pub project_id: ProjectId,
    pub discoveries: Vec<ScanDiscovery>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanActionKind {
    Link,
    Copy,
    RemoveManaged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanDestination {
    pub tool_id: Identifier,
    pub project_relative_path: ProjectRelativePath,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanAction {
    pub action_id: Identifier,
    pub kind: PlanActionKind,
    pub artifact_id: ArtifactId,
    pub destination: PlanDestination,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalPlan {
    pub setup_revision_id: SetupRevisionId,
    pub plan_digest: Digest,
    pub actions: Vec<PlanAction>,
    pub conflicts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanResult {
    pub project_id: ProjectId,
    pub plan: CanonicalPlan,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationOutcome {
    Applied,
    RolledBack,
    NoChange,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CancellationOutcome {
    CancelledAndRestored,
    NeedsAttention,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Recoverability {
    NotNeeded,
    RollbackAvailable,
    ManualIntervention,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyReceipt {
    pub project_id: ProjectId,
    pub operation_id: OperationId,
    pub setup_revision_id: SetupRevisionId,
    pub plan_digest: Digest,
    pub outcome: OperationOutcome,
    pub recoverability: Recoverability,
    pub actions_applied: u64,
    pub completed_at: IsoTimestamp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackReceipt {
    pub project_id: ProjectId,
    pub operation_id: OperationId,
    pub restored_setup_revision_id: Option<SetupRevisionId>,
    pub outcome: OperationOutcome,
    pub recoverability: Recoverability,
    pub completed_at: IsoTimestamp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancellationReceipt {
    pub project_id: ProjectId,
    pub operation_id: Option<OperationId>,
    pub outcome: CancellationOutcome,
    pub recoverability: Recoverability,
    pub actions_applied: u64,
    pub completed_at: IsoTimestamp,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProtocolErrorCode {
    UnsupportedProtocolVersion,
    ExpiredJob,
    InvalidOrganization,
    InvalidDevice,
    UnknownProjectInstance,
    CapabilityUnavailable,
    PlanDigestMismatch,
    ApprovalExpired,
    Conflict,
    OperationFailed,
    JobCancelled,
    IdempotencyMismatch,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorResult {
    pub code: ProtocolErrorCode,
    pub message: String,
    pub retryable: bool,
    pub recoverability: Recoverability,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase")]
pub enum RunnerResult {
    ScanResult(ScanResult),
    PlanResult(PlanResult),
    ApplyReceipt(ApplyReceipt),
    RollbackReceipt(RollbackReceipt),
    CancellationReceipt(CancellationReceipt),
    Error(ErrorResult),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultEnvelope {
    pub protocol_version: ProtocolVersion,
    pub job_id: JobId,
    pub idempotency_key: Identifier,
    pub organization_id: OrganizationId,
    pub device_id: DeviceId,
    pub project_instance_id: ProjectInstanceId,
    pub result: RunnerResult,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ProtocolEnvelope {
    Capabilities(CapabilityEnvelope),
    Job(Box<JobEnvelope>),
    Result(ResultEnvelope),
}
