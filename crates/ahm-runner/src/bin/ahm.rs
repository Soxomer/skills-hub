use std::{path::PathBuf, thread, time::Duration};

use ahm_domain::{
    EnrollRunnerRequest, ProjectId, ProjectInstanceId, RegisterProjectInstanceRequest,
    RunnerCapabilityReport, PROTOCOL_VERSION,
};
use ahm_runner::execution::RunnerExecutionService;
use ahm_runner::job_dispatcher::{runner_capabilities, LocalJobExecutor};
#[cfg(feature = "acceptance-tests")]
use ahm_runner::setup_service::TestFaultInjection;
use ahm_runner::setup_service::{
    default_cli_db_path, ApplyActionKind, ApplyPlan, DefaultSetupCandidateKind,
    DefaultSetupCaptureResult, DefaultSetupPreview, Project, ProjectStatus, SetupDetail,
    SkillSummary,
};
use ahm_runner::state::{ProjectInstanceRecord, RunnerIdentityRecord, RunnerStateStore};
use ahm_runner::transport::{HttpRunnerTransport, RunnerTransport};
use ahm_runner::worker::{utc_now, RunnerWorker, WorkerOutcome};
use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(
    name = "ahm",
    version,
    about = "Compose and synchronize AI-agent setups"
)]
struct Cli {
    /// Path to the Skills Hub SQLite database.
    #[arg(long, global = true, env = "AHM_DB")]
    db: Option<PathBuf>,

    /// Path to the local runner identity, journal, and result outbox.
    #[arg(long, global = true, env = "AHM_RUNNER_STATE")]
    runner_state: Option<PathBuf>,

    /// Emit machine-readable JSON.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Connect this machine to a Skills Hub web account.
    Connect(ConnectArgs),
    /// Poll for remote work assigned by the web app.
    Worker(WorkerArgs),
    /// Scan the current machine without changing it.
    Scan(ScanArgs),
    /// Inspect the central skill library.
    Skill(SkillArgs),
    /// Create and edit reusable skill setups.
    Setup(SetupArgs),
    /// Register projects and select their setups.
    Project(ProjectArgs),
    /// Show a project's selected, applied, and pending state.
    Status(ProjectPathArgs),
    /// Preview a setup's local filesystem reconciliation.
    Plan(SetupProjectArgs),
    /// Synchronize a setup to a project's local agent directories.
    Sync(SetupProjectArgs),
    /// Restore the state before the latest synchronization.
    Rollback(ProjectPathArgs),
}

#[derive(Debug, Args)]
struct ConnectArgs {
    /// Single-use enrollment code shown by the web app.
    code: String,
    /// Public URL of the Skills Hub control plane.
    #[arg(long, env = "AHM_SERVER")]
    server: String,
    /// Human-readable name for this machine.
    #[arg(long, default_value = "Local runner")]
    label: String,
}

#[derive(Debug, Args)]
struct WorkerArgs {
    /// Home directory used for discovery and the artifact cache.
    #[arg(long)]
    home: Option<PathBuf>,
    /// Process at most one claim cycle and exit.
    #[arg(long)]
    once: bool,
    /// Retry delay after a transport failure.
    #[arg(long, default_value_t = 2)]
    poll_seconds: u64,
    #[cfg(feature = "acceptance-tests")]
    #[arg(long, hide = true)]
    test_partial_apply_once: bool,
}

#[derive(Debug, Args)]
struct ScanArgs {
    /// Home directory to scan. Defaults to the current user's home.
    #[arg(long)]
    home: Option<PathBuf>,
    /// Registered project whose Default Setup is being reviewed.
    #[arg(long)]
    project: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct SkillArgs {
    #[command(subcommand)]
    command: SkillCommand,
}

#[derive(Debug, Subcommand)]
enum SkillCommand {
    /// List skills already managed by Skills Hub.
    List,
}

#[derive(Debug, Args)]
struct SetupArgs {
    #[command(subcommand)]
    command: SetupCommand,
}

#[derive(Debug, Subcommand)]
enum SetupCommand {
    /// List setups.
    List,
    /// Show a setup and its skill targets.
    View { setup: String },
    /// Create an empty setup.
    Create { name: String },
    /// Copy a setup under a new name.
    Clone { source: String, name: String },
    /// Add one managed skill to one or more tools in a setup.
    AddSkill {
        setup: String,
        skill: String,
        #[arg(long = "tool", required = true, num_args = 1..)]
        tools: Vec<String>,
    },
    /// Remove a skill from a setup, optionally only for selected tools.
    RemoveSkill {
        setup: String,
        skill: String,
        #[arg(long = "tool", num_args = 1..)]
        tools: Vec<String>,
    },
    /// Preview or capture the retained Default Setup.
    Default {
        #[command(subcommand)]
        command: DefaultSetupCommand,
    },
}

#[derive(Debug, Subcommand)]
enum DefaultSetupCommand {
    /// Preview the machine state that can become Default.
    Preview(ScanArgs),
    /// Capture accepted discoveries as the immutable first Default revision.
    Capture {
        /// Home directory to scan. Defaults to the current user's home.
        #[arg(long)]
        home: Option<PathBuf>,
        /// Registered project that will own this Default Setup.
        #[arg(long)]
        project: Option<PathBuf>,
        /// Selection key to leave external. Repeat for multiple discoveries.
        #[arg(long = "exclude")]
        exclusions: Vec<String>,
    },
}

#[derive(Debug, Args)]
struct ProjectArgs {
    #[command(subcommand)]
    command: ProjectCommand,
}

#[derive(Debug, Subcommand)]
enum ProjectCommand {
    /// List registered projects.
    List,
    /// Register an existing project directory.
    Add { path: PathBuf },
    /// Connect a local checkout to an existing web project.
    Connect {
        /// Logical project ID from the web app.
        project_id: String,
        /// Checkout directory. Defaults to the current directory.
        #[arg(long)]
        project: Option<PathBuf>,
    },
    /// Select a setup for a project without applying it yet.
    Use {
        setup: String,
        #[arg(long)]
        project: Option<PathBuf>,
    },
    /// Select the current Default Setup revision without applying it yet.
    UseDefault {
        #[arg(long)]
        project: Option<PathBuf>,
    },
}

#[derive(Debug, Args)]
struct ProjectPathArgs {
    #[arg(long)]
    project: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct SetupProjectArgs {
    /// Setup to use. Defaults to the project's selected immutable revision.
    setup: Option<String>,
    #[arg(long)]
    project: Option<PathBuf>,
}

fn main() {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("error: {err:#}");
            std::process::exit(classify_error(&err));
        }
    }
}

fn run(cli: Cli) -> Result<i32> {
    let db_path = cli.db.map(Ok).unwrap_or_else(default_cli_db_path)?;
    let runner_state_path = cli
        .runner_state
        .map(Ok)
        .unwrap_or_else(default_runner_state_path)?;
    let command = match cli.command {
        Command::Connect(args) => {
            connect_runner(args, &runner_state_path, cli.json)?;
            return Ok(0);
        }
        Command::Worker(args) => {
            run_worker(args, &runner_state_path, db_path, cli.json)?;
            return Ok(0);
        }
        command => command,
    };
    let runner = RunnerExecutionService::open(db_path.clone())?;
    let service = runner.local_admin();

    match command {
        Command::Connect(_) | Command::Worker(_) => unreachable!("handled before local admin"),
        Command::Scan(args) => {
            let preview = runner.scan(&scan_home(args.home)?, &project_path(args.project)?)?;
            emit_default_preview(&preview, cli.json)?;
        }
        Command::Skill(args) => match args.command {
            SkillCommand::List => {
                let skills = service.list_skills()?;
                if cli.json {
                    print_json(&skills)?;
                } else {
                    print_skills(&skills);
                }
            }
        },
        Command::Setup(args) => match args.command {
            SetupCommand::List => {
                let setups = service.list_setups()?;
                if cli.json {
                    print_json(&setups)?;
                } else if setups.is_empty() {
                    println!("No setups.");
                } else {
                    for setup in setups {
                        println!(
                            "{}@{}\t{} targets\t{}",
                            setup.name, setup.revision_number, setup.skill_target_count, setup.id
                        );
                    }
                }
            }
            SetupCommand::View { setup } => {
                emit_setup(&service.get_setup(&setup)?, cli.json)?;
            }
            SetupCommand::Create { name } => {
                emit_setup(&service.create_setup(&name)?, cli.json)?;
            }
            SetupCommand::Clone { source, name } => {
                emit_setup(&service.clone_setup(&source, &name)?, cli.json)?;
            }
            SetupCommand::AddSkill {
                setup,
                skill,
                tools,
            } => {
                emit_setup(&service.add_setup_skill(&setup, &skill, &tools)?, cli.json)?;
            }
            SetupCommand::RemoveSkill {
                setup,
                skill,
                tools,
            } => {
                emit_setup(
                    &service.remove_setup_skill(&setup, &skill, &tools)?,
                    cli.json,
                )?;
            }
            SetupCommand::Default { command } => match command {
                DefaultSetupCommand::Preview(args) => {
                    let preview = service.preview_default_setup(
                        &scan_home(args.home)?,
                        &project_path(args.project)?,
                    )?;
                    emit_default_preview(&preview, cli.json)?;
                }
                DefaultSetupCommand::Capture {
                    home,
                    project,
                    exclusions,
                } => {
                    let result = service.capture_default_setup(
                        &scan_home(home)?,
                        &project_path(project)?,
                        &exclusions,
                    )?;
                    emit_default_capture(&result, cli.json)?;
                }
            },
        },
        Command::Project(args) => match args.command {
            ProjectCommand::List => {
                let projects = service.list_projects()?;
                if cli.json {
                    print_json(&projects)?;
                } else if projects.is_empty() {
                    println!("No registered projects.");
                } else {
                    for project in projects {
                        print_project(&project);
                    }
                }
            }
            ProjectCommand::Add { path } => {
                let project = service.add_project(&path)?;
                emit_project(&project, cli.json)?;
            }
            ProjectCommand::Connect {
                project_id,
                project,
            } => {
                let local_path = std::fs::canonicalize(project_path(project)?)
                    .context("resolve project checkout")?;
                service.add_project(&local_path)?;
                let state = RunnerStateStore::open(&runner_state_path)?;
                let identity = state
                    .identity()?
                    .context("runner is not connected; run `ahm connect` first")?;
                let project_id = ProjectId::new(project_id)?;
                let record = state
                    .project_instance_for_checkout(
                        &identity.organization_id,
                        &project_id,
                        &local_path,
                    )?
                    .unwrap_or(ProjectInstanceRecord {
                        id: ProjectInstanceId::new(format!(
                            "project_instance_{}",
                            uuid::Uuid::new_v4().simple()
                        ))?,
                        organization_id: identity.organization_id.clone(),
                        project_id: project_id.clone(),
                        local_path,
                        registered_at: utc_now(),
                    });
                state.register_project_instance(&record)?;
                HttpRunnerTransport::new(&identity.server_url)?.register_project_instance(
                    &identity,
                    &RegisterProjectInstanceRequest {
                        project_instance_id: record.id.clone(),
                        project_id,
                    },
                )?;
                if cli.json {
                    print_json(&serde_json::json!({
                        "projectInstanceId": record.id.as_str(),
                        "projectId": record.project_id.as_str(),
                        "localPath": record.local_path,
                    }))?;
                } else {
                    println!(
                        "Connected {} as project instance {}.",
                        record.local_path.display(),
                        record.id.as_str()
                    );
                }
            }
            ProjectCommand::Use { setup, project } => {
                let project = project_path(project)?;
                let project = service.assign_setup(&project, &setup)?;
                emit_project(&project, cli.json)?;
            }
            ProjectCommand::UseDefault { project } => {
                let project = project_path(project)?;
                let project = service.assign_default_setup(&project)?;
                emit_project(&project, cli.json)?;
            }
        },
        Command::Status(args) => {
            let project = project_path(args.project)?;
            let status = service.status(&project)?;
            emit_status(&status, cli.json)?;
            if status
                .pending_plan
                .as_ref()
                .is_some_and(|plan| !plan.conflicts.is_empty())
            {
                return Ok(3);
            }
        }
        Command::Plan(args) => {
            let project = project_path(args.project)?;
            let plan = runner.plan(&project, args.setup.as_deref())?;
            emit_plan(&plan, cli.json)?;
            if !plan.conflicts.is_empty() {
                return Ok(3);
            }
        }
        Command::Sync(args) => {
            let project = project_path(args.project)?;
            let result = runner.apply(&project, args.setup.as_deref())?;
            if cli.json {
                print_json(&result)?;
            } else {
                print_plan(&result.plan);
                println!("Synchronized. Operation: {}", result.operation_id);
            }
        }
        Command::Rollback(args) => {
            let project = project_path(args.project)?;
            let result = runner.rollback(&project)?;
            if cli.json {
                print_json(&result)?;
            } else {
                print_plan(&result.plan);
                println!("Rolled back operation: {}", result.operation_id);
            }
        }
    }

    Ok(0)
}

fn connect_runner(
    args: ConnectArgs,
    runner_state_path: &std::path::Path,
    json: bool,
) -> Result<()> {
    let transport = HttpRunnerTransport::new(&args.server)?;
    let enrolled = transport.enroll(&EnrollRunnerRequest {
        code: args.code,
        label: args.label,
        capabilities: RunnerCapabilityReport {
            protocol_version: PROTOCOL_VERSION,
            supported_protocol_versions: vec![PROTOCOL_VERSION],
            runner_version: env!("CARGO_PKG_VERSION").to_owned(),
            capabilities: runner_capabilities(),
        },
    })?;
    let identity = RunnerIdentityRecord {
        server_url: args.server.trim_end_matches('/').to_owned(),
        organization_id: enrolled.organization_id,
        device_id: enrolled.device_id,
        credential_secret: enrolled.credential,
        enrolled_at: utc_now(),
    };
    RunnerStateStore::open(runner_state_path)?.save_identity(&identity)?;
    if json {
        print_json(&serde_json::json!({
            "organizationId": identity.organization_id.as_str(),
            "deviceId": identity.device_id.as_str(),
            "serverUrl": identity.server_url,
        }))?;
    } else {
        println!(
            "Connected {} to {}.",
            identity.device_id.as_str(),
            identity.server_url
        );
        println!("Next: ahm project connect <project-id>");
    }
    Ok(())
}

fn run_worker(
    args: WorkerArgs,
    runner_state_path: &std::path::Path,
    db_path: PathBuf,
    json: bool,
) -> Result<()> {
    let state = RunnerStateStore::open(runner_state_path)?;
    let identity = state
        .identity()?
        .context("runner is not connected; run `ahm connect` first")?;
    let transport = HttpRunnerTransport::new(&identity.server_url)?;
    #[cfg(feature = "acceptance-tests")]
    let runner = if args.test_partial_apply_once {
        RunnerExecutionService::open_with_test_fault(
            db_path,
            TestFaultInjection::partial_apply_once(),
        )?
    } else {
        RunnerExecutionService::open(db_path)?
    };
    #[cfg(not(feature = "acceptance-tests"))]
    let runner = RunnerExecutionService::open(db_path)?;
    let executor = LocalJobExecutor::new(runner, scan_home(args.home)?);
    let mut worker = RunnerWorker::new(state, transport, executor)
        .with_claim_wait_ms(if args.once { 0 } else { 25_000 });
    if !json {
        println!(
            "Runner {} is connected and polling {}.",
            identity.device_id.as_str(),
            identity.server_url
        );
    }
    loop {
        let mut retry_after_error = false;
        match worker.run_once() {
            Ok(outcome) => {
                if json && outcome != WorkerOutcome::Idle {
                    print_json(&serde_json::json!({ "outcome": format!("{outcome:?}") }))?;
                } else if !json && outcome == WorkerOutcome::Processed {
                    println!("Completed and delivered one remote job.");
                } else if !json && outcome == WorkerOutcome::Replayed {
                    println!("Delivered a previously completed remote job.");
                }
            }
            Err(error) if !args.once => {
                eprintln!("worker cycle failed: {error:#}");
                retry_after_error = true;
            }
            Err(error) => return Err(error),
        }
        if args.once {
            return Ok(());
        }
        if retry_after_error {
            thread::sleep(Duration::from_secs(args.poll_seconds));
        }
    }
}

fn project_path(path: Option<PathBuf>) -> Result<PathBuf> {
    Ok(path.map(Ok).unwrap_or_else(std::env::current_dir)?)
}

fn default_runner_state_path() -> Result<PathBuf> {
    dirs::data_local_dir()
        .map(|path| path.join("ahm").join("runner.db"))
        .context("local application data directory not found")
}

fn scan_home(path: Option<PathBuf>) -> Result<PathBuf> {
    path.map(Ok)
        .unwrap_or_else(|| dirs::home_dir().ok_or_else(|| anyhow::anyhow!("home not found")))
}

fn print_json(value: &impl Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_skills(skills: &[SkillSummary]) {
    if skills.is_empty() {
        println!("No managed skills.");
        return;
    }
    for skill in skills {
        let state = if skill.enabled { "enabled" } else { "disabled" };
        println!(
            "{}\t{}\t{}\t{}",
            skill.name, state, skill.id, skill.central_path
        );
    }
}

fn emit_default_preview(preview: &DefaultSetupPreview, json: bool) -> Result<()> {
    if json {
        return print_json(preview);
    }
    println!(
        "Scanned {} tool contexts for {} and found {} skill placements.",
        preview.total_tools_scanned, preview.project_path, preview.total_skills_found
    );
    if let Some(default) = &preview.existing_default {
        println!(
            "Default already exists at revision {} (initial revision {}).",
            default.revision_number,
            default.initial_revision_id.as_deref().unwrap_or("unknown")
        );
    }
    for candidate in &preview.candidates {
        let classification = match candidate.classification {
            DefaultSetupCandidateKind::KnownSkill => "known skill",
            DefaultSetupCandidateKind::PluginSkill => "plugin skill",
            DefaultSetupCandidateKind::LocalContent => "local content",
        };
        let state = if candidate.capturable {
            if candidate.has_conflict {
                "capturable, conflicting content"
            } else {
                "capturable"
            }
        } else {
            candidate.reason.as_deref().unwrap_or("external")
        };
        println!(
            "{} -> {}\t{}\t{}\t{}",
            candidate.name, candidate.tool, classification, state, candidate.source_path
        );
        println!("  selection: {}", candidate.selection_key);
    }
    if preview.candidates.is_empty() {
        println!("No unmanaged skills were discovered.");
    }
    Ok(())
}

fn emit_default_capture(result: &DefaultSetupCaptureResult, json: bool) -> Result<()> {
    if json {
        return print_json(result);
    }
    emit_setup(&result.setup, false)?;
    println!(
        "Captured {} placements into {} immutable snapshots; {} excluded, {} left external.",
        result.captured_candidates,
        result.snapshot_count,
        result.excluded_candidates,
        result.external_candidates
    );
    Ok(())
}

fn emit_setup(setup: &SetupDetail, json: bool) -> Result<()> {
    if json {
        return print_json(setup);
    }
    println!(
        "{}@{}{}\t{} targets\t{}",
        setup.setup.name,
        setup.setup.revision_number,
        if setup.setup.is_default {
            " [default]"
        } else {
            ""
        },
        setup.items.len(),
        setup.setup.id
    );
    for item in &setup.items {
        println!(
            "  {} -> {}/{} ({})",
            item.skill_name, item.tool, item.target_name, item.skill_id
        );
    }
    Ok(())
}

fn emit_project(project: &Project, json: bool) -> Result<()> {
    if json {
        print_json(project)
    } else {
        print_project(project);
        Ok(())
    }
}

fn print_project(project: &Project) {
    let default = project
        .default_setup
        .as_ref()
        .map(|setup| format!("{}@{}", setup.name, setup.revision_number))
        .unwrap_or_else(|| "none".to_string());
    let assigned = project
        .assigned_setup
        .as_ref()
        .map(|setup| format!("{}@{}", setup.name, setup.revision_number))
        .unwrap_or_else(|| "none".to_string());
    let applied = project
        .applied_setup
        .as_ref()
        .map(|setup| format!("{}@{}", setup.name, setup.revision_number))
        .unwrap_or_else(|| "none".to_string());
    println!(
        "{}\tdefault={}\tselected={}\tapplied={}",
        project.path, default, assigned, applied
    );
}

fn emit_status(status: &ProjectStatus, json: bool) -> Result<()> {
    if json {
        return print_json(status);
    }
    print_project(&status.project);
    if let Some(plan) = &status.pending_plan {
        print_plan(plan);
    } else {
        println!("No setup selected.");
    }
    Ok(())
}

fn emit_plan(plan: &ApplyPlan, json: bool) -> Result<()> {
    if json {
        print_json(plan)
    } else {
        print_plan(plan);
        Ok(())
    }
}

fn print_plan(plan: &ApplyPlan) {
    let setup = plan
        .setup
        .as_ref()
        .map(|setup| format!("{}@{}", setup.name, setup.revision_number))
        .unwrap_or_else(|| "unassigned".to_string());
    println!("Plan for {} using setup {}:", plan.project.path, setup);
    for action in &plan.actions {
        let marker = match action.kind {
            ApplyActionKind::Add => "+",
            ApplyActionKind::Remove => "-",
            ApplyActionKind::Replace => "~",
            ApplyActionKind::UpdateRecords => "=",
            ApplyActionKind::Keep => " ",
        };
        println!(
            "{} {} -> {} [{}]",
            marker,
            action.skill_name,
            action.target_path,
            action.tools.join(", ")
        );
    }
    if plan.actions.is_empty() {
        println!("  No managed targets.");
    }
    for conflict in &plan.conflicts {
        println!("! {conflict}");
    }
    if !plan.has_changes && plan.conflicts.is_empty() {
        println!("Already in the desired state.");
    }
}

fn classify_error(error: &anyhow::Error) -> i32 {
    let message = format!("{error:#}");
    if message.contains("sync conflicts")
        || message.contains("will not be touched")
        || message.contains("unmanaged target")
    {
        3
    } else if message.contains("not found")
        || message.contains("not registered")
        || message.contains("required")
        || message.contains("unknown")
        || message.contains("disabled")
        || message.contains("does not support")
        || message.contains("cannot be empty")
    {
        2
    } else {
        1
    }
}

#[cfg(test)]
#[path = "tests/setup_service.rs"]
mod tests;
