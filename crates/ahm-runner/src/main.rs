fn main() {
    let boundary = ahm_runner::describe_runner_boundary();
    println!(
        "ahm-runner protocol {:?}; transport configured: {}",
        boundary.protocol_version, boundary.transport_configured
    );
}
