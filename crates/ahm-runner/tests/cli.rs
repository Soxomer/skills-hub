use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, Output};

fn run_ahm<I, S>(database: &Path, arguments: I) -> Output
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Command::new(env!("CARGO_BIN_EXE_ahm"))
        .arg("--db")
        .arg(database)
        .arg("--json")
        .args(arguments)
        .output()
        .expect("run ahm")
}

fn assert_success(output: Output) {
    assert!(
        output.status.success(),
        "status: {:?}\nstdout: {}\nstderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn standalone_cli_scans_plans_applies_and_rolls_back_in_temporary_directories() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("ahm.db");
    let home = root.path().join("home");
    let project = root.path().join("project");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    let unmanaged = project.join("keep.txt");
    std::fs::write(&unmanaged, "keep me").unwrap();

    assert_success(run_ahm(&database, ["setup", "create", "empty"]));
    assert_success(run_ahm(
        &database,
        [
            OsStr::new("project"),
            OsStr::new("add"),
            project.as_os_str(),
        ],
    ));
    assert_success(run_ahm(
        &database,
        [
            OsStr::new("project"),
            OsStr::new("use"),
            OsStr::new("empty"),
            OsStr::new("--project"),
            project.as_os_str(),
        ],
    ));
    assert_success(run_ahm(
        &database,
        [
            OsStr::new("scan"),
            OsStr::new("--home"),
            home.as_os_str(),
            OsStr::new("--project"),
            project.as_os_str(),
        ],
    ));
    assert_success(run_ahm(
        &database,
        [
            OsStr::new("plan"),
            OsStr::new("--project"),
            project.as_os_str(),
        ],
    ));
    assert_success(run_ahm(
        &database,
        [
            OsStr::new("sync"),
            OsStr::new("--project"),
            project.as_os_str(),
        ],
    ));
    assert_success(run_ahm(
        &database,
        [
            OsStr::new("rollback"),
            OsStr::new("--project"),
            project.as_os_str(),
        ],
    ));

    assert_eq!(std::fs::read_to_string(unmanaged).unwrap(), "keep me");
}
