use crate::Digest;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LibraryCommand {
    ListDirectories,
    GetToolConfig,
    SetToolConfig,
    GetToolStatus,
    GetOnboardingPlan,
    GetDiscoveryScanSettings,
    SetDiscoveryScanConfig,
    GetGitCacheCleanupDays,
    SetGitCacheCleanupDays,
    ClearGitCacheNow,
    GetGitCacheTtlSecs,
    SetGitCacheTtlSecs,
    GetAutoUpdateConfig,
    SetAutoUpdateConfig,
    RunAutoUpdateNow,
    TriggerAutoUpdateTaskNowCmd,
    GetRecentProjects,
    SaveRecentProject,
    GetCentralRepoPath,
    SetCentralRepoPath,
    ListLocalSkillsCmd,
    InstallLocalSelection,
    ListGitSkillsCmd,
    PreviewGitSkillCmd,
    InstallGitSelection,
    SyncSkillToTool,
    UnsyncSkillFromTool,
    SetSkillEnabled,
    UpdateManagedSkill,
    GetGithubToken,
    SetGithubToken,
    GetGithubProxyConfig,
    SetGithubProxyConfig,
    ImportExistingSkill,
    GetManagedSkills,
    GetTags,
    CreateTag,
    RenameTag,
    DeleteTag,
    GetSkillTags,
    SetSkillTags,
    GetUntaggedSkillIds,
    DeleteManagedSkill,
    GetFeaturedSkills,
    SearchSkillsOnline,
    ListSkillFiles,
    ReadSkillFile,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryRequest {
    pub command: LibraryCommand,
    pub args: Map<String, Value>,
    pub expected_digest: Option<Digest>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryResponse {
    pub value: Value,
}
