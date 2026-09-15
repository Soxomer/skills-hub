use ahm_domain::{ProtocolVersion, PROTOCOL_VERSION};

pub mod artifact_cache;
pub mod auto_update;
pub mod cache_cleanup;
pub mod cancel_token;
pub mod central_repo;
pub mod content_hash;
pub mod execution;
pub mod featured_skills;
pub mod git_fetcher;
pub mod github_download;
pub mod github_search;
pub mod installer;
pub mod job_dispatcher;
pub mod library;
pub mod library_commands;
mod library_dispatch;
pub mod network_proxy;
pub mod onboarding;
mod project_lock;
pub mod setup_service;
pub mod skill_files;
pub mod skill_store;
pub mod skills_search;
pub mod state;
pub mod sync_engine;
pub mod tool_adapters;
pub mod transport;
pub mod worker;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunnerBoundary {
    pub protocol_version: ProtocolVersion,
    pub transport_configured: bool,
}

pub fn describe_runner_boundary() -> RunnerBoundary {
    RunnerBoundary {
        protocol_version: PROTOCOL_VERSION,
        transport_configured: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_exposes_the_polling_transport_boundary() {
        assert_eq!(
            describe_runner_boundary(),
            RunnerBoundary {
                protocol_version: ProtocolVersion::V1,
                transport_configured: true,
            }
        );
    }
}
