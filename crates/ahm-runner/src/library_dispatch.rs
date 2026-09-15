use crate::{
    cancel_token::CancelToken, library::LibraryPaths, library_commands as commands,
    skill_store::SkillStore,
};
use ahm_domain::LibraryCommand;
use serde_json::{Map, Value};
use std::sync::Arc;

pub fn execute(
    command: &LibraryCommand,
    args: &Map<String, Value>,
    paths: &LibraryPaths,
    store: &SkillStore,
    _cancel: &Arc<CancelToken>,
) -> anyhow::Result<Value> {
    let value = match command {
        LibraryCommand::ListDirectories => unreachable!("handled by library service"),
        LibraryCommand::GetToolConfig => serde_json::to_value(
            commands::get_tool_config(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetToolConfig => serde_json::to_value(
            commands::set_tool_config(
                store.clone(),
                serde_json::from_value(args.get("config").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetToolStatus => serde_json::to_value(
            commands::get_tool_status(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetOnboardingPlan => serde_json::to_value(
            commands::get_onboarding_plan(paths.clone(), store.clone())
                .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetDiscoveryScanSettings => serde_json::to_value(
            commands::get_discovery_scan_settings(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetDiscoveryScanConfig => serde_json::to_value(
            commands::set_discovery_scan_config(
                store.clone(),
                serde_json::from_value(args.get("config").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetGitCacheCleanupDays => serde_json::to_value(
            commands::get_git_cache_cleanup_days(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetGitCacheCleanupDays => serde_json::to_value(
            commands::set_git_cache_cleanup_days(
                store.clone(),
                serde_json::from_value(args.get("days").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::ClearGitCacheNow => serde_json::to_value(
            commands::clear_git_cache_now(paths.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetGitCacheTtlSecs => serde_json::to_value(
            commands::get_git_cache_ttl_secs(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetGitCacheTtlSecs => serde_json::to_value(
            commands::set_git_cache_ttl_secs(
                store.clone(),
                serde_json::from_value(args.get("secs").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetAutoUpdateConfig => serde_json::to_value(
            commands::get_auto_update_config(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetAutoUpdateConfig => serde_json::to_value(
            commands::set_auto_update_config(
                store.clone(),
                serde_json::from_value(args.get("enabled").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("intervalHours").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("scheduleType").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("intervalValue").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("intervalUnit").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("dailyTime").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::RunAutoUpdateNow => serde_json::to_value(
            commands::run_auto_update_now(paths.clone(), store.clone())
                .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::TriggerAutoUpdateTaskNowCmd => serde_json::to_value(
            commands::trigger_auto_update_task_now_cmd(store.clone())
                .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetRecentProjects => serde_json::to_value(
            commands::get_recent_projects(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SaveRecentProject => serde_json::to_value(
            commands::save_recent_project(
                store.clone(),
                serde_json::from_value(args.get("projectPath").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetCentralRepoPath => serde_json::to_value(
            commands::get_central_repo_path(paths.clone(), store.clone())
                .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetCentralRepoPath => serde_json::to_value(
            commands::set_central_repo_path(
                paths.clone(),
                store.clone(),
                serde_json::from_value(args.get("path").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::ListLocalSkillsCmd => serde_json::to_value(
            commands::list_local_skills_cmd(serde_json::from_value(
                args.get("basePath").cloned().unwrap_or(Value::Null),
            )?)
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::InstallLocalSelection => serde_json::to_value(
            commands::install_local_selection(
                paths.clone(),
                store.clone(),
                serde_json::from_value(args.get("basePath").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("subpath").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::ListGitSkillsCmd => serde_json::to_value(
            commands::list_git_skills_cmd(
                paths.clone(),
                store.clone(),
                serde_json::from_value(args.get("repoUrl").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::PreviewGitSkillCmd => serde_json::to_value(
            commands::preview_git_skill_cmd(
                store.clone(),
                serde_json::from_value(args.get("repoUrl").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("skillName").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::InstallGitSelection => serde_json::to_value(
            commands::install_git_selection(
                paths.clone(),
                store.clone(),
                serde_json::from_value(args.get("repoUrl").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("subpath").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SyncSkillToTool => serde_json::to_value(
            commands::sync_skill_to_tool(
                store.clone(),
                serde_json::from_value(args.get("sourcePath").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("tool").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("overwrite").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(
                    args.get("overwriteIfSameContent")
                        .cloned()
                        .unwrap_or(Value::Null),
                )?,
                serde_json::from_value(args.get("scope").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("projectPath").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::UnsyncSkillFromTool => serde_json::to_value(
            commands::unsync_skill_from_tool(
                store.clone(),
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("tool").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("scope").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("projectPath").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetSkillEnabled => serde_json::to_value(
            commands::set_skill_enabled(
                store.clone(),
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("enabled").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::UpdateManagedSkill => serde_json::to_value(
            commands::update_managed_skill(
                paths.clone(),
                store.clone(),
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetGithubToken => serde_json::to_value(
            commands::get_github_token(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetGithubToken => serde_json::to_value(
            commands::set_github_token(
                store.clone(),
                serde_json::from_value(args.get("token").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetGithubProxyConfig => serde_json::to_value(
            commands::get_github_proxy_config(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetGithubProxyConfig => serde_json::to_value(
            commands::set_github_proxy_config(
                store.clone(),
                serde_json::from_value(args.get("enabled").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("port").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::ImportExistingSkill => serde_json::to_value(
            commands::import_existing_skill(
                paths.clone(),
                store.clone(),
                serde_json::from_value(args.get("sourcePath").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetManagedSkills => serde_json::to_value(
            commands::get_managed_skills(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetTags => {
            serde_json::to_value(commands::get_tags(store.clone()).map_err(anyhow::Error::msg)?)?
        }
        LibraryCommand::CreateTag => serde_json::to_value(
            commands::create_tag(
                store.clone(),
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::RenameTag => serde_json::to_value(
            commands::rename_tag(
                store.clone(),
                serde_json::from_value(args.get("tagId").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::DeleteTag => serde_json::to_value(
            commands::delete_tag(
                store.clone(),
                serde_json::from_value(args.get("tagId").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetSkillTags => serde_json::to_value(
            commands::get_skill_tags(
                store.clone(),
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SetSkillTags => serde_json::to_value(
            commands::set_skill_tags(
                store.clone(),
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("tagIds").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetUntaggedSkillIds => serde_json::to_value(
            commands::get_untagged_skill_ids(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::DeleteManagedSkill => serde_json::to_value(
            commands::delete_managed_skill(
                store.clone(),
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::GetFeaturedSkills => serde_json::to_value(
            commands::get_featured_skills(store.clone()).map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::SearchSkillsOnline => serde_json::to_value(
            commands::search_skills_online(
                store.clone(),
                serde_json::from_value(args.get("query").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("limit").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::ListSkillFiles => serde_json::to_value(
            commands::list_skill_files(serde_json::from_value(
                args.get("centralPath").cloned().unwrap_or(Value::Null),
            )?)
            .map_err(anyhow::Error::msg)?,
        )?,
        LibraryCommand::ReadSkillFile => serde_json::to_value(
            commands::read_skill_file(
                serde_json::from_value(args.get("centralPath").cloned().unwrap_or(Value::Null))?,
                serde_json::from_value(args.get("filePath").cloned().unwrap_or(Value::Null))?,
            )
            .map_err(anyhow::Error::msg)?,
        )?,
    };
    Ok(value)
}

pub fn validate(command: &LibraryCommand, args: &Map<String, Value>) -> anyhow::Result<()> {
    match command {
        LibraryCommand::GetToolConfig => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SetToolConfig => {
            anyhow::ensure!(
                args.keys().all(|key| ["config"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: commands::ToolConfigDto =
                serde_json::from_value(args.get("config").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetToolStatus => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::GetOnboardingPlan => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::GetDiscoveryScanSettings => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SetDiscoveryScanConfig => {
            anyhow::ensure!(
                args.keys().all(|key| ["config"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: crate::onboarding::DiscoveryScanConfig =
                serde_json::from_value(args.get("config").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetGitCacheCleanupDays => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SetGitCacheCleanupDays => {
            anyhow::ensure!(
                args.keys().all(|key| ["days"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: i64 = serde_json::from_value(args.get("days").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::ClearGitCacheNow => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::GetGitCacheTtlSecs => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SetGitCacheTtlSecs => {
            anyhow::ensure!(
                args.keys().all(|key| ["secs"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: i64 = serde_json::from_value(args.get("secs").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetAutoUpdateConfig => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SetAutoUpdateConfig => {
            anyhow::ensure!(
                args.keys().all(|key| [
                    "enabled",
                    "intervalHours",
                    "scheduleType",
                    "intervalValue",
                    "intervalUnit",
                    "dailyTime"
                ]
                .contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: bool =
                serde_json::from_value(args.get("enabled").cloned().unwrap_or(Value::Null))?;
            let _: i64 =
                serde_json::from_value(args.get("intervalHours").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("scheduleType").cloned().unwrap_or(Value::Null))?;
            let _: Option<i64> =
                serde_json::from_value(args.get("intervalValue").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("intervalUnit").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("dailyTime").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::RunAutoUpdateNow => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::TriggerAutoUpdateTaskNowCmd => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::GetRecentProjects => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SaveRecentProject => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["projectPath"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("projectPath").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetCentralRepoPath => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SetCentralRepoPath => {
            anyhow::ensure!(
                args.keys().all(|key| ["path"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("path").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::ListLocalSkillsCmd => {
            anyhow::ensure!(
                args.keys().all(|key| ["basePath"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("basePath").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::InstallLocalSelection => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["basePath", "subpath", "name"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("basePath").cloned().unwrap_or(Value::Null))?;
            let _: String =
                serde_json::from_value(args.get("subpath").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::ListGitSkillsCmd => {
            anyhow::ensure!(
                args.keys().all(|key| ["repoUrl"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("repoUrl").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::PreviewGitSkillCmd => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["repoUrl", "skillName"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("repoUrl").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("skillName").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::InstallGitSelection => {
            anyhow::ensure!(
                args.keys().all(
                    |key| ["repoUrl", "subpath", "name", "trackingUrl"].contains(&key.as_str())
                ),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("repoUrl").cloned().unwrap_or(Value::Null))?;
            let _: String =
                serde_json::from_value(args.get("subpath").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("trackingUrl").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::SyncSkillToTool => {
            anyhow::ensure!(
                args.keys().all(|key| [
                    "sourcePath",
                    "skillId",
                    "tool",
                    "name",
                    "overwrite",
                    "overwriteIfSameContent",
                    "scope",
                    "projectPath"
                ]
                .contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("sourcePath").cloned().unwrap_or(Value::Null))?;
            let _: String =
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?;
            let _: String =
                serde_json::from_value(args.get("tool").cloned().unwrap_or(Value::Null))?;
            let _: String =
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?;
            let _: Option<bool> =
                serde_json::from_value(args.get("overwrite").cloned().unwrap_or(Value::Null))?;
            let _: Option<bool> = serde_json::from_value(
                args.get("overwriteIfSameContent")
                    .cloned()
                    .unwrap_or(Value::Null),
            )?;
            let _: Option<String> =
                serde_json::from_value(args.get("scope").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("projectPath").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::UnsyncSkillFromTool => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["skillId", "tool", "scope", "projectPath"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?;
            let _: String =
                serde_json::from_value(args.get("tool").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("scope").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("projectPath").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::SetSkillEnabled => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["skillId", "enabled"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?;
            let _: bool =
                serde_json::from_value(args.get("enabled").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::UpdateManagedSkill => {
            anyhow::ensure!(
                args.keys().all(|key| ["skillId"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetGithubToken => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SetGithubToken => {
            anyhow::ensure!(
                args.keys().all(|key| ["token"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("token").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetGithubProxyConfig => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SetGithubProxyConfig => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["enabled", "port"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: bool =
                serde_json::from_value(args.get("enabled").cloned().unwrap_or(Value::Null))?;
            let _: u16 = serde_json::from_value(args.get("port").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::ImportExistingSkill => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["sourcePath", "name"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("sourcePath").cloned().unwrap_or(Value::Null))?;
            let _: Option<String> =
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetManagedSkills => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::GetTags => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::CreateTag => {
            anyhow::ensure!(
                args.keys().all(|key| ["name"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::RenameTag => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["tagId", "name"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: i64 = serde_json::from_value(args.get("tagId").cloned().unwrap_or(Value::Null))?;
            let _: String =
                serde_json::from_value(args.get("name").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::DeleteTag => {
            anyhow::ensure!(
                args.keys().all(|key| ["tagId"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: i64 = serde_json::from_value(args.get("tagId").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetSkillTags => {
            anyhow::ensure!(
                args.keys().all(|key| ["skillId"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::SetSkillTags => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["skillId", "tagIds"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?;
            let _: Vec<i64> =
                serde_json::from_value(args.get("tagIds").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetUntaggedSkillIds => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::DeleteManagedSkill => {
            anyhow::ensure!(
                args.keys().all(|key| ["skillId"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("skillId").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::GetFeaturedSkills => {
            anyhow::ensure!(args.is_empty(), "Unexpected library arguments");
        }
        LibraryCommand::SearchSkillsOnline => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["query", "limit"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("query").cloned().unwrap_or(Value::Null))?;
            let _: Option<u32> =
                serde_json::from_value(args.get("limit").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::ListSkillFiles => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["centralPath"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("centralPath").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::ReadSkillFile => {
            anyhow::ensure!(
                args.keys()
                    .all(|key| ["centralPath", "filePath"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: String =
                serde_json::from_value(args.get("centralPath").cloned().unwrap_or(Value::Null))?;
            let _: String =
                serde_json::from_value(args.get("filePath").cloned().unwrap_or(Value::Null))?;
        }
        LibraryCommand::ListDirectories => {
            anyhow::ensure!(
                args.keys().all(|key| ["parent"].contains(&key.as_str())),
                "Unknown library argument"
            );
            let _: Option<String> =
                serde_json::from_value(args.get("parent").cloned().unwrap_or(Value::Null))?;
        }
    }
    Ok(())
}
