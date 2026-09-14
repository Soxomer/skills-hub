use serde::{Deserialize, Serialize};

use crate::{
    Digest, JobEnvelope, OrganizationId, ProjectId, ProjectInstanceId, ProtocolVersion,
    ResultEnvelope, RunnerCapabilities,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_library: Option<Vec<ManagedSkillSummary>>,
    pub capabilities: RunnerCapabilityReport,
    #[serde(default)]
    pub wait_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedSkillSummary {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub enabled: bool,
    pub tags: Vec<String>,
    pub targets: Vec<ManagedSkillTarget>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedSkillTarget {
    pub tool: String,
    pub scope: ManagedSkillScope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedSkillScope {
    Global,
    Project,
}

#[cfg(test)]
mod inventory_tests {
    use super::*;
    #[test]
    fn portable_inventory_matches_shared_fixture() {
        let raw = include_str!(
            "../../../packages/contracts/fixtures/v1/transport/managed-skill-library.json"
        );
        let skills: Vec<ManagedSkillSummary> = serde_json::from_str(raw).unwrap();
        assert_eq!(
            serde_json::to_value(skills).unwrap(),
            serde_json::from_str::<serde_json::Value>(raw).unwrap()
        );
        let invalid = raw.replacen(
            "\"name\": \"Review\"",
            "\"centralPath\": \"/private\", \"name\": \"Review\"",
            1,
        );
        assert!(serde_json::from_str::<Vec<ManagedSkillSummary>>(&invalid).is_err());
    }
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
pub struct RunnerJobControlRequest {
    pub lease_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerJobControlResponse {
    pub cancel_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcknowledgeRunnerJobRequest {
    pub lease_id: String,
    pub request_digest: Digest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerJobAcknowledgement {
    pub accepted: bool,
    pub duplicate: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerResultAcknowledgement {
    pub accepted: bool,
    pub duplicate: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactBundleEntry {
    pub path: String,
    pub kind: ArtifactBundleEntryKind,
    pub content_base64: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactBundleEntryKind {
    Directory,
    File,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactBundle {
    pub content_digest: Digest,
    pub entries: Vec<ArtifactBundleEntry>,
}
