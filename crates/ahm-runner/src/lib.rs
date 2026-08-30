use ahm_domain::{ProtocolVersion, PROTOCOL_VERSION};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunnerBoundary {
    pub protocol_version: ProtocolVersion,
    pub transport_configured: bool,
}

pub fn describe_runner_boundary() -> RunnerBoundary {
    RunnerBoundary {
        protocol_version: PROTOCOL_VERSION,
        transport_configured: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_starts_as_a_transport_free_boundary() {
        assert_eq!(
            describe_runner_boundary(),
            RunnerBoundary {
                protocol_version: ProtocolVersion::V1,
                transport_configured: false,
            }
        );
    }
}
