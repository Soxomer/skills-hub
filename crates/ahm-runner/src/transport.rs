use std::time::Duration;

use ahm_domain::{
    AcknowledgeRunnerJobRequest, ArtifactBundle, ClaimRunnerJobRequest, Digest,
    EnrollRunnerRequest, EnrollRunnerResponse, LeasedRunnerJob, RegisterProjectInstanceRequest,
    RunnerJobAcknowledgement, RunnerJobControlRequest, RunnerJobControlResponse,
    RunnerResultAcknowledgement, SubmitRunnerResultRequest,
};
use anyhow::{bail, Context, Result};
use reqwest::{blocking::Client, StatusCode, Url};

use crate::state::RunnerIdentityRecord;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRegistrationBody<'a> {
    project_id: &'a ahm_domain::ProjectId,
}

pub trait RunnerTransport {
    fn enroll(&self, request: &EnrollRunnerRequest) -> Result<EnrollRunnerResponse>;
    fn register_project_instance(
        &self,
        identity: &RunnerIdentityRecord,
        request: &RegisterProjectInstanceRequest,
    ) -> Result<()>;
    fn claim_job(
        &self,
        identity: &RunnerIdentityRecord,
        request: &ClaimRunnerJobRequest,
    ) -> Result<Option<LeasedRunnerJob>>;
    fn acknowledge_job(
        &self,
        identity: &RunnerIdentityRecord,
        job_id: &str,
        request: &AcknowledgeRunnerJobRequest,
    ) -> Result<RunnerJobAcknowledgement>;
    fn job_control(
        &self,
        identity: &RunnerIdentityRecord,
        job_id: &str,
        request: &RunnerJobControlRequest,
    ) -> Result<RunnerJobControlResponse>;
    fn store_artifact(
        &self,
        identity: &RunnerIdentityRecord,
        bundle: &ArtifactBundle,
    ) -> Result<()>;
    fn load_artifact(
        &self,
        identity: &RunnerIdentityRecord,
        digest: &Digest,
    ) -> Result<Option<ArtifactBundle>>;
    fn submit_result(
        &self,
        identity: &RunnerIdentityRecord,
        job_id: &str,
        request: &SubmitRunnerResultRequest,
    ) -> Result<RunnerResultAcknowledgement>;
}

pub struct HttpRunnerTransport {
    server_url: Url,
    client: Client,
}

impl HttpRunnerTransport {
    pub fn new(server_url: &str) -> Result<Self> {
        let normalized = format!("{}/", server_url.trim_end_matches('/'));
        let server_url = Url::parse(&normalized).context("invalid runner server URL")?;
        if !matches!(server_url.scheme(), "http" | "https") {
            bail!("runner server URL must use HTTP or HTTPS");
        }
        let loopback = matches!(
            server_url.host_str(),
            Some("localhost" | "127.0.0.1" | "::1")
        );
        if server_url.scheme() != "https" && !loopback {
            bail!("runner server URL must use HTTPS except on localhost");
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("ahm-runner/{}", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { server_url, client })
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.server_url
            .join(path.trim_start_matches('/'))
            .context("build runner endpoint")
    }
}

impl RunnerTransport for HttpRunnerTransport {
    fn enroll(&self, request: &EnrollRunnerRequest) -> Result<EnrollRunnerResponse> {
        let response = self
            .client
            .post(self.endpoint("runner/v1/enroll")?)
            .json(request)
            .send()
            .context("contact control plane")?;
        parse_json_response(response, "enroll runner")
    }

    fn register_project_instance(
        &self,
        identity: &RunnerIdentityRecord,
        request: &RegisterProjectInstanceRequest,
    ) -> Result<()> {
        let path = format!(
            "runner/v1/project-instances/{}",
            request.project_instance_id.as_str()
        );
        let response = self
            .client
            .put(self.endpoint(&path)?)
            .bearer_auth(&identity.credential_secret)
            .json(&ProjectRegistrationBody {
                project_id: &request.project_id,
            })
            .send()
            .context("contact control plane")?;
        ensure_success(response, "register project instance")
    }

    fn claim_job(
        &self,
        identity: &RunnerIdentityRecord,
        request: &ClaimRunnerJobRequest,
    ) -> Result<Option<LeasedRunnerJob>> {
        let response = self
            .client
            .post(self.endpoint("runner/v1/jobs/claim")?)
            .bearer_auth(&identity.credential_secret)
            .json(request)
            .send()
            .context("contact control plane")?;
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        parse_json_response(response, "claim runner job").map(Some)
    }

    fn acknowledge_job(
        &self,
        identity: &RunnerIdentityRecord,
        job_id: &str,
        request: &AcknowledgeRunnerJobRequest,
    ) -> Result<RunnerJobAcknowledgement> {
        let response = self
            .client
            .post(self.endpoint(&format!("runner/v1/jobs/{job_id}/ack"))?)
            .bearer_auth(&identity.credential_secret)
            .json(request)
            .send()
            .context("contact control plane")?;
        parse_json_response(response, "acknowledge runner job")
    }

    fn job_control(
        &self,
        identity: &RunnerIdentityRecord,
        job_id: &str,
        request: &RunnerJobControlRequest,
    ) -> Result<RunnerJobControlResponse> {
        let response = self
            .client
            .post(self.endpoint(&format!("runner/v1/jobs/{job_id}/control"))?)
            .bearer_auth(&identity.credential_secret)
            .json(request)
            .send()
            .context("contact control plane")?;
        parse_json_response(response, "read runner job control")
    }

    fn store_artifact(
        &self,
        identity: &RunnerIdentityRecord,
        bundle: &ArtifactBundle,
    ) -> Result<()> {
        let response = self
            .client
            .put(self.endpoint("runner/v1/artifacts")?)
            .bearer_auth(&identity.credential_secret)
            .json(bundle)
            .send()
            .context("contact control plane")?;
        ensure_success(response, "store artifact")
    }

    fn load_artifact(
        &self,
        identity: &RunnerIdentityRecord,
        digest: &Digest,
    ) -> Result<Option<ArtifactBundle>> {
        let response = self
            .client
            .get(self.endpoint(&format!("runner/v1/artifacts/{}", digest.as_str()))?)
            .bearer_auth(&identity.credential_secret)
            .send()
            .context("contact control plane")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        parse_json_response(response, "load artifact").map(Some)
    }

    fn submit_result(
        &self,
        identity: &RunnerIdentityRecord,
        job_id: &str,
        request: &SubmitRunnerResultRequest,
    ) -> Result<RunnerResultAcknowledgement> {
        let response = self
            .client
            .post(self.endpoint(&format!("runner/v1/jobs/{job_id}/result"))?)
            .bearer_auth(&identity.credential_secret)
            .json(request)
            .send()
            .context("contact control plane")?;
        parse_json_response(response, "submit runner result")
    }
}

fn ensure_success(response: reqwest::blocking::Response, operation: &str) -> Result<()> {
    response
        .error_for_status()
        .with_context(|| format!("{operation} failed"))?;
    Ok(())
}

fn parse_json_response<T: serde::de::DeserializeOwned>(
    response: reqwest::blocking::Response,
    operation: &str,
) -> Result<T> {
    response
        .error_for_status()
        .with_context(|| format!("{operation} failed"))?
        .json()
        .with_context(|| format!("decode {operation} response"))
}

#[cfg(test)]
mod tests {
    use ahm_domain::{
        EnrollRunnerRequest, Identifier, RunnerCapabilities, RunnerCapabilityReport,
        PROTOCOL_VERSION,
    };
    use mockito::Matcher;

    use super::*;

    fn capabilities() -> RunnerCapabilityReport {
        RunnerCapabilityReport {
            protocol_version: PROTOCOL_VERSION,
            supported_protocol_versions: vec![PROTOCOL_VERSION],
            runner_version: "0.1.0".to_owned(),
            capabilities: RunnerCapabilities {
                scan_project: true,
                plan_setup: false,
                apply_plan: false,
                rollback_operation: false,
                supported_tools: vec![Identifier::new("codex").unwrap()],
            },
        }
    }

    #[test]
    fn enrollment_uses_the_versioned_http_contract() {
        let mut server = mockito::Server::new();
        let request = EnrollRunnerRequest {
            code: "single-use-code".to_owned(),
            label: "Laptop".to_owned(),
            capabilities: capabilities(),
        };
        let endpoint = server
            .mock("POST", "/runner/v1/enroll")
            .match_header(
                "content-type",
                Matcher::Regex("application/json.*".to_owned()),
            )
            .match_body(Matcher::Json(serde_json::to_value(&request).unwrap()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"organizationId":"org_01","deviceId":"device_01","credential":"secret"}"#,
            )
            .create();

        let response = HttpRunnerTransport::new(&server.url())
            .unwrap()
            .enroll(&request)
            .unwrap();

        endpoint.assert();
        assert_eq!(response.organization_id.as_str(), "org_01");
        assert_eq!(response.device_id.as_str(), "device_01");
        assert_eq!(response.credential, "secret");
    }

    #[test]
    fn job_control_is_scoped_to_the_current_lease() {
        let mut server = mockito::Server::new();
        let request = RunnerJobControlRequest {
            lease_id: "lease_01".to_owned(),
        };
        let endpoint = server
            .mock("POST", "/runner/v1/jobs/job_01/control")
            .match_header("authorization", "Bearer secret")
            .match_body(Matcher::Json(serde_json::to_value(&request).unwrap()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"cancelRequested":true}"#)
            .create();
        let identity = RunnerIdentityRecord {
            server_url: server.url(),
            organization_id: Identifier::new("org_01").unwrap(),
            device_id: Identifier::new("device_01").unwrap(),
            credential_secret: "secret".to_owned(),
            enrolled_at: ahm_domain::IsoTimestamp::new("2026-09-05T10:00:00Z").unwrap(),
        };

        let response = HttpRunnerTransport::new(&server.url())
            .unwrap()
            .job_control(&identity, "job_01", &request)
            .unwrap();

        endpoint.assert();
        assert!(response.cancel_requested);
    }
}
