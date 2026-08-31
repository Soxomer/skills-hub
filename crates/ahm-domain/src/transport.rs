use serde::{Deserialize, Serialize};

use crate::{
    JobEnvelope, OrganizationId, ProjectId, ProjectInstanceId, ProtocolVersion, ResultEnvelope,
    RunnerCapabilities,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerCapabilityReport {
    pub protocol_version: ProtocolVersion,
    pub supported_protocol_versions: Vec<ProtocolVersion>,
    pub runner_version: String,
    pub capabilities: RunnerCapabilities,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollRunnerRequest {
    pub code: String,
    pub label: String,
    pub capabilities: RunnerCapabilityReport,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollRunnerResponse {
    pub organization_id: OrganizationId,
    pub device_id: crate::DeviceId,
    pub credential: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterProjectInstanceRequest {
    pub project_instance_id: ProjectInstanceId,
    pub project_id: ProjectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimRunnerJobRequest {
    pub capabilities: RunnerCapabilityReport,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeasedRunnerJob {
    pub lease_id: String,
    pub lease_expires_at: crate::IsoTimestamp,
    pub cancel_requested: bool,
    pub job: JobEnvelope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitRunnerResultRequest {
    pub lease_id: String,
    pub result: ResultEnvelope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerResultAcknowledgement {
    pub accepted: bool,
    pub duplicate: bool,
}
