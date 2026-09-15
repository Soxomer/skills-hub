use std::{fs, path::PathBuf};

use ahm_domain::{
    negotiate_protocol_version, ProjectRelativePath, ProtocolEnvelope, ProtocolVersion,
    PROTOCOL_VERSION,
};
use serde_json::Value;

fn fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts/fixtures/v1")
}

fn fixture(name: &str) -> Value {
    let path = fixture_directory().join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn golden_fixtures_parse_and_round_trip_without_drift() {
    let mut paths = fs::read_dir(fixture_directory())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();

    assert_eq!(paths.len(), 13);
    for path in paths {
        let source: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let envelope: ProtocolEnvelope = serde_json::from_value(source.clone())
            .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()));
        assert_eq!(serde_json::to_value(envelope).unwrap(), source);
    }
}

#[test]
fn unknown_fields_are_rejected() {
    let mut value = fixture("job-scan.json");
    value["command"] = Value::String("rm -rf project".to_owned());

    assert!(serde_json::from_value::<ProtocolEnvelope>(value).is_err());
}

#[test]
fn unsupported_versions_are_rejected_and_not_negotiated() {
    let mut value = fixture("capabilities.json");
    value["protocolVersion"] = Value::String("2.0".to_owned());

    assert!(serde_json::from_value::<ProtocolEnvelope>(value).is_err());
    assert_eq!(
        negotiate_protocol_version(&[ProtocolVersion::V1]),
        Some(PROTOCOL_VERSION)
    );
    assert_eq!(negotiate_protocol_version(&[]), None);
}

#[test]
fn plan_destinations_cannot_escape_the_registered_project() {
    assert!(ProjectRelativePath::new(".agents/skills/pdf").is_ok());
    assert!(ProjectRelativePath::new("C:\\project\\.agents\\skills\\pdf").is_err());
    assert!(ProjectRelativePath::new("/project/.agents/skills/pdf").is_err());
    assert!(ProjectRelativePath::new("../outside").is_err());
}
