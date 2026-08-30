use std::path::PathBuf;

use anyhow::Result;
use app_lib::core::setup_service::{
    default_cli_db_path, ApplyActionKind, ApplyPlan, Project, ProjectStatus, SetupDetail,
    SetupService, SkillSummary,
};
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

    /// Emit machine-readable JSON.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
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
    /// Select a setup for a project without applying it yet.
    Use {
        setup: String,
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
    let service = SetupService::open(db_path)?;

    match cli.command {
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
            ProjectCommand::Use { setup, project } => {
                let project = project_path(project)?;
                let project = service.assign_setup(&project, &setup)?;
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
            let plan = service.plan(&project, args.setup.as_deref())?;
            emit_plan(&plan, cli.json)?;
            if !plan.conflicts.is_empty() {
                return Ok(3);
            }
        }
        Command::Sync(args) => {
            let project = project_path(args.project)?;
            let result = service.sync(&project, args.setup.as_deref())?;
            if cli.json {
                print_json(&result)?;
            } else {
                print_plan(&result.plan);
                println!("Synchronized. Operation: {}", result.operation_id);
            }
        }
        Command::Rollback(args) => {
            let project = project_path(args.project)?;
            let result = service.rollback(&project)?;
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

fn project_path(path: Option<PathBuf>) -> Result<PathBuf> {
    Ok(path.map(Ok).unwrap_or_else(std::env::current_dir)?)
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

fn emit_setup(setup: &SetupDetail, json: bool) -> Result<()> {
    if json {
        return print_json(setup);
    }
    println!(
        "{}@{}\t{} targets\t{}",
        setup.setup.name,
        setup.setup.revision_number,
        setup.items.len(),
        setup.setup.id
    );
    for item in &setup.items {
        println!("  {} -> {} ({})", item.skill_name, item.tool, item.skill_id);
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
        "{}\tselected={}\tapplied={}",
        project.path, assigned, applied
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
