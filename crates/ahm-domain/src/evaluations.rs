use serde::{Deserialize, Serialize};

use crate::{Digest, Identifier, IsoTimestamp, PortableSetupRevision, SetupRevisionId};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum EvaluationSuite {
    #[serde(rename = "code-review-v1")]
    CodeReviewV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EvaluationHarness {
    Codex,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EvaluationContextMode {
    SkillInstructions,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum EvaluationSandbox {
    #[serde(rename = "read-only")]
    ReadOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EvaluationReasoningEffort {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationProfile {
    pub harness: EvaluationHarness,
    pub profile_version: u8,
    pub model: Identifier,
    pub reasoning_effort: EvaluationReasoningEffort,
    pub sandbox: EvaluationSandbox,
    pub timeout_seconds: u16,
    pub context_mode: EvaluationContextMode,
}

impl EvaluationProfile {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.profile_version != 1 || self.timeout_seconds != 120 {
            return Err("unsupported evaluation profile version or execution limit");
        }
        if self.model.as_str().len() > 100
            || !self.model.as_str().as_bytes()[0].is_ascii_alphanumeric()
            || !self
                .model
                .as_str()
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err("invalid evaluation model identifier");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateSetupsJob {
    pub baseline: PortableSetupRevision,
    pub candidate: PortableSetupRevision,
    pub suite_id: EvaluationSuite,
    pub profile: EvaluationProfile,
    pub repetitions: u8,
}

impl EvaluateSetupsJob {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.profile.validate()?;
        if self.repetitions != 1 {
            return Err("this evaluation suite supports exactly one repetition");
        }
        if self.baseline.setup_revision_id == self.candidate.setup_revision_id {
            return Err("choose different baseline and candidate revisions");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationObservedConfiguration {
    pub harness_version: String,
    pub model: Option<String>,
    pub context_mode: EvaluationContextMode,
    pub native_skill_activation: bool,
    pub inherited_instructions_digest: Option<Digest>,
    pub ambient_context_verified: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EvaluationVariantStatus {
    Completed,
    Failed,
    TimedOut,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationCheck {
    pub id: Identifier,
    pub label: String,
    pub passed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationVariantResult {
    pub setup_revision_id: SetupRevisionId,
    pub status: EvaluationVariantStatus,
    pub duration_ms: u64,
    pub checks: Vec<EvaluationCheck>,
    pub summary: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationResult {
    pub suite_id: EvaluationSuite,
    pub profile: EvaluationProfile,
    pub observed: EvaluationObservedConfiguration,
    pub baseline: EvaluationVariantResult,
    pub candidate: EvaluationVariantResult,
    pub completed_at: IsoTimestamp,
}
