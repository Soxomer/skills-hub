use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::skill_store::SkillStore;
use ahm_domain::{LibraryCommand, LibraryRequest};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};

fn location_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            let name = path
                .to_string_lossy()
                .trim_end_matches(['/', '\\'])
                .to_owned();
            if name.is_empty() {
                "Filesystem".to_owned()
            } else {
                name.trim_start_matches("\\\\?\\").to_owned()
            }
        })
}

fn handle(store: &SkillStore, path: &Path) -> Result<String> {
    let text = path.to_string_lossy();
    let key = format!(
        "library_path_{}",
        hex::encode(Sha256::digest(text.as_bytes()))
    );
    if let Some(id) = store.get_setting(&key)? {
        return Ok(id);
    }
    let name = location_name(path);
    let id = format!(
        "folder-{}/{}",
        uuid::Uuid::new_v4(),
        urlencoding::encode(&name)
    );
    store.set_setting(&format!("library_handle_{id}"), &text)?;
    store.set_setting(&key, &id)?;
    Ok(id)
}

fn resolve(store: &SkillStore, id: &str) -> Result<PathBuf> {
    anyhow::ensure!(
        id.starts_with("folder-") && id.len() <= 1024,
        "Invalid folder handle"
    );
    store
        .get_setting(&format!("library_handle_{id}"))?
        .map(PathBuf::from)
        .context("Unknown folder handle")
}

fn portable(store: &SkillStore, value: &mut Value, key: &str) -> Result<()> {
    match value {
        Value::String(text) if matches!(key, "last_error" | "error") && !text.is_empty() => {
            *text = public_error(&anyhow::anyhow!(text.clone()));
        }
        Value::String(text)
            if !matches!(key, "content" | "description" | "markdown" | "readme")
                && Path::new(text).is_absolute() =>
        {
            // Custom tool configuration remains editable using a home-relative directory.
            let home = store.get_setting("runner_library_home")?.map(PathBuf::from);
            *text = if key == "skills_dir" {
                home.as_ref()
                    .and_then(|home| Path::new(text).strip_prefix(home).ok())
                    .map(|path| format!("~/{}", path.to_string_lossy().replace('\\', "/")))
                    .unwrap_or(handle(store, Path::new(text))?)
            } else {
                handle(store, Path::new(text))?
            };
        }
        Value::Array(values) => {
            for value in values {
                portable(store, value, key)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                portable(store, value, key)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn directories(home: &Path, store: &SkillStore, parent: Option<&str>) -> Result<Value> {
    let root = home.canonicalize()?;
    let directory = parent
        .map(|id| resolve(store, id))
        .transpose()?
        .unwrap_or(root.clone())
        .canonicalize()?;
    #[cfg(windows)]
    let volumes: Vec<PathBuf> = ('A'..='Z')
        .map(|letter| PathBuf::from(format!("{letter}:\\")))
        .filter(|path| path.is_dir())
        .collect();
    #[cfg(not(windows))]
    let volumes = vec![PathBuf::from("/")];
    let mut roots = vec![json!({"name":location_name(&root),"handle":handle(store,&root)?})];
    for volume in volumes {
        roots.push(json!({"name":location_name(&volume),"handle":handle(store,&volume)?}));
    }
    let mut children = Vec::new();
    for entry in std::fs::read_dir(&directory)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            children.push(json!({"name":entry.file_name().to_string_lossy(), "handle":handle(store,&entry.path())?}));
        }
    }
    children.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(
        json!({"handle":handle(store,&directory)?,"name":location_name(&directory),"parent":directory.parent().map(|p| handle(store,p)).transpose()?,"children":children,"roots":roots}),
    )
}

fn is_mutation(command: &LibraryCommand) -> bool {
    matches!(
        command,
        LibraryCommand::SetToolConfig
            | LibraryCommand::InstallLocalSelection
            | LibraryCommand::InstallGitSelection
            | LibraryCommand::ImportExistingSkill
            | LibraryCommand::SyncSkillToTool
            | LibraryCommand::UnsyncSkillFromTool
            | LibraryCommand::SetSkillEnabled
            | LibraryCommand::UpdateManagedSkill
            | LibraryCommand::DeleteManagedSkill
            | LibraryCommand::SetCentralRepoPath
            | LibraryCommand::RunAutoUpdateNow
            | LibraryCommand::TriggerAutoUpdateTaskNowCmd
    )
}

pub(crate) fn public_error(error: &anyhow::Error) -> String {
    let message = error.to_string();
    for prefix in [
        "TARGET_EXISTS|",
        "TOOL_NOT_INSTALLED|",
        "TOOL_NOT_WRITABLE|",
        "PROJECT_SCOPE_UNSUPPORTED|",
        "SKILL_INVALID|",
        "CANCELLED|",
    ] {
        if message.starts_with(prefix) {
            return prefix.to_owned();
        }
    }
    if message.contains("skill already exists in central repo") {
        return "skill already exists in central repo".to_owned();
    }
    if message.contains("Library changed") {
        return "The library changed while preparing this action. Please retry.".to_owned();
    }
    if message.contains("local changes") || message.contains("no longer owned") {
        return "A managed target has local changes. Preserve them before continuing.".to_owned();
    }
    "The library action could not finish. Check the runner log for details.".to_owned()
}

pub(crate) fn check_owned_targets(store: &SkillStore, skill_id: &str) -> Result<()> {
    let skill = store
        .get_skill_by_id(skill_id)?
        .context("Skill not found")?;
    for target in store.list_skill_targets(skill_id)? {
        if target.status == "disabled" {
            continue;
        }
        let path = Path::new(&target.target_path);
        if !path.exists() {
            continue;
        }
        if target.mode == "copy" {
            anyhow::ensure!(
                skill.content_hash.as_deref()
                    == Some(crate::content_hash::hash_dir(path)?.as_str()),
                "Managed target has local changes; preserve them before continuing"
            );
        } else {
            anyhow::ensure!(
                path.canonicalize()? == Path::new(&skill.central_path).canonicalize()?,
                "Target is no longer owned by this skill"
            );
        }
    }
    Ok(())
}

pub fn maintenance(home: &Path, store: &SkillStore) -> Result<()> {
    store.set_setting("runner_library_home", &home.to_string_lossy())?;
    let _lock = crate::project_lock::ProjectOperationLock::try_acquire(home)?;
    let config = crate::auto_update::get_auto_update_config(store)?;
    if !crate::auto_update::is_auto_update_due(&config, chrono::Utc::now().timestamp_millis()) {
        return Ok(());
    }
    let mut projects = std::collections::BTreeSet::new();
    for skill in store.list_skills()? {
        for target in store.list_skill_targets(&skill.id)? {
            if let Some(project) = target.project_path {
                projects.insert(project);
            }
        }
    }
    let _locks = projects
        .iter()
        .map(|p| crate::project_lock::ProjectOperationLock::try_acquire(Path::new(p)))
        .collect::<Result<Vec<_>>>()?;
    crate::auto_update::run_due_auto_update(&LibraryPaths::new(home.to_path_buf()), store)?;
    Ok(())
}

/// Device-scoped library work. Handles and filesystem fingerprints never leave this authority.
pub fn execute(home: &Path, store: &SkillStore, request: &LibraryRequest) -> Result<Value> {
    execute_checked(home, store, request, &mut || Ok(false))
}

pub fn execute_checked(
    home: &Path,
    store: &SkillStore,
    request: &LibraryRequest,
    should_cancel: &mut dyn FnMut() -> Result<bool>,
) -> Result<Value> {
    crate::library_dispatch::validate(&request.command, &request.args)?;
    anyhow::ensure!(
        serde_json::to_vec(request)?.len() <= 700_000,
        "Library request is too large"
    );
    store.set_setting("runner_library_home", &home.to_string_lossy())?;
    let _lock = crate::project_lock::ProjectOperationLock::try_acquire(home)?;
    if request.command == LibraryCommand::ListDirectories {
        return directories(
            home,
            store,
            request.args.get("parent").and_then(Value::as_str),
        );
    }
    anyhow::ensure!(
        request.command != LibraryCommand::SetGithubToken,
        "Configure GitHub authentication on the runner"
    );
    if request.command == LibraryCommand::GetGithubToken {
        return Ok(json!(""));
    }
    let mut args = request.args.clone();
    if let Some(Value::String(tracking)) = args.get("trackingUrl") {
        let source = reqwest::Url::parse(
            args.get("repoUrl")
                .and_then(Value::as_str)
                .context("Missing repository")?,
        )?;
        let tracking = reqwest::Url::parse(tracking)?;
        anyhow::ensure!(
            tracking.scheme() == "https"
                && tracking.host_str() == Some("github.com")
                && tracking.username().is_empty()
                && tracking.password().is_none()
                && source
                    .path()
                    .split('/')
                    .take(3)
                    .eq(tracking.path().split('/').take(3)),
            "Tracking source must be the same repository"
        );
    }
    for key in [
        "basePath",
        "sourcePath",
        "projectPath",
        "path",
        "centralPath",
    ] {
        if let Some(Value::String(id)) = args.get_mut(key) {
            *id = resolve(store, id)?.to_string_lossy().into_owned();
        }
    }
    for key in ["subpath", "filePath"] {
        if let Some(Value::String(value)) = args.get(key) {
            anyhow::ensure!(
                !Path::new(value).is_absolute()
                    && !value.replace('\\', "/").split('/').any(|p| p == ".."),
                "Invalid relative path"
            );
        }
    }
    if let Some(Value::String(value)) = args.get("repoUrl") {
        let url = reqwest::Url::parse(value)?;
        anyhow::ensure!(
            url.scheme() == "https"
                && url.host_str() == Some("github.com")
                && url.username().is_empty()
                && url.password().is_none(),
            "Use a GitHub HTTPS repository URL"
        );
    }
    if let Some(Value::String(name)) = args.get("name") {
        anyhow::ensure!(
            !name.contains(['/', '\\']) && name != "." && name != "..",
            "Invalid skill name"
        );
    }
    if let Some(Value::Object(config)) = args.get_mut("config") {
        if let Some(Value::Array(custom)) = config.get_mut("custom_tools") {
            for tool in custom {
                if let Some(Value::String(path)) = tool.get_mut("skills_dir") {
                    *path = if path.starts_with("folder-") {
                        resolve(store, path)?
                    } else {
                        let relative = path.trim_start_matches("~/");
                        anyhow::ensure!(
                            !Path::new(relative).is_absolute()
                                && !relative.replace('\\', "/").split('/').any(|p| p == ".."),
                            "Use a home-relative tool directory"
                        );
                        home.join(relative)
                    }
                    .to_string_lossy()
                    .into_owned();
                }
            }
        }
    }
    if matches!(
        request.command,
        LibraryCommand::ListSkillFiles
            | LibraryCommand::ReadSkillFile
            | LibraryCommand::SyncSkillToTool
    ) {
        let source = args
            .get("centralPath")
            .or_else(|| args.get("sourcePath"))
            .and_then(Value::as_str)
            .context("Missing skill folder")?;
        anyhow::ensure!(
            store.list_skills()?.iter().any(|s| s.central_path == source
                && args
                    .get("skillId")
                    .and_then(Value::as_str)
                    .map_or(true, |id| id == s.id)),
            "Folder is not a managed skill"
        );
    }
    let mut projects = std::collections::BTreeSet::new();
    if let Some(path) = args.get("projectPath").and_then(Value::as_str) {
        projects.insert(path.to_owned());
    }
    if is_mutation(&request.command) {
        let selected = args.get("skillId").and_then(Value::as_str);
        for skill in store
            .list_skills()?
            .iter()
            .filter(|s| selected.map_or(true, |id| id == s.id))
        {
            check_owned_targets(store, &skill.id)?;
            for target in store.list_skill_targets(&skill.id)? {
                if let Some(project) = target.project_path {
                    projects.insert(project);
                }
            }
        }
    }
    let _project_locks = projects
        .iter()
        .map(|path| crate::project_lock::ProjectOperationLock::try_acquire(Path::new(path)))
        .collect::<Result<Vec<_>>>()?;
    let paths = LibraryPaths::new(home.to_path_buf());
    let prepared_git = if request.command == LibraryCommand::InstallGitSelection {
        Some(crate::installer::prepare_git_selection(
            &paths,
            store,
            args["repoUrl"].as_str().context("Missing repository")?,
        )?)
    } else {
        None
    };
    if is_mutation(&request.command) {
        let skills = crate::library_commands::get_managed_skills(store.clone())
            .map_err(anyhow::Error::msg)?;
        let mut fingerprint = Sha256::new();
        fingerprint.update(serde_json::to_vec(
            &json!({"command":request.command,"args":args,"skills":skills}),
        )?);
        for skill in store.list_skills()? {
            let path = Path::new(&skill.central_path);
            if path.exists() {
                fingerprint.update(crate::content_hash::hash_dir(path)?);
            }
            for target in store.list_skill_targets(&skill.id)? {
                let path = Path::new(&target.target_path);
                if path.is_dir() {
                    fingerprint.update(crate::content_hash::hash_dir(path)?);
                }
            }
        }
        if let Some(source) = args
            .get("basePath")
            .or_else(|| args.get("sourcePath"))
            .and_then(Value::as_str)
        {
            fingerprint.update(crate::content_hash::hash_dir(Path::new(source))?);
        }
        if let Some((directory, revision)) = &prepared_git {
            let subpath = args["subpath"].as_str().context("Missing selected skill")?;
            fingerprint.update(revision);
            fingerprint.update(crate::content_hash::hash_dir(&directory.join(subpath))?);
        }
        let digest = format!("sha256:{}", hex::encode(fingerprint.finalize()));
        match &request.expected_digest {
            None => {
                return Ok(json!({"requiresCommit":true,"digest":digest,"command":request.command}))
            }
            Some(approved) => anyhow::ensure!(
                approved.as_str() == digest,
                "Library changed; review the action again"
            ),
        }
    }
    anyhow::ensure!(!should_cancel()?, "CANCELLED|");
    let mut value = if let Some(prepared) = prepared_git {
        let result = crate::installer::install_prepared_git_selection(
            &paths,
            store,
            args["repoUrl"].as_str().context("Missing repository")?,
            args["subpath"].as_str().context("Missing selected skill")?,
            args.get("name").and_then(Value::as_str).map(str::to_owned),
            prepared,
        )?;
        if let Some(tracking) = args.get("trackingUrl").and_then(Value::as_str) {
            let mut skill = store
                .get_skill_by_id(&result.skill_id)?
                .context("Installed skill missing")?;
            skill.source_ref = Some(tracking.to_owned());
            store.upsert_skill(&skill)?;
        }
        serde_json::to_value(crate::library_commands::to_install_dto(result))?
    } else {
        crate::library_dispatch::execute(
            &request.command,
            &args,
            &paths,
            store,
            &Arc::new(crate::cancel_token::CancelToken::default()),
        )?
    };
    portable(store, &mut value, "")?;
    Ok(value)
}

#[derive(Clone, Debug)]
pub struct LibraryPaths {
    pub home: PathBuf,
    pub cache: PathBuf,
}

impl LibraryPaths {
    pub fn new(home: PathBuf) -> Self {
        Self {
            cache: home.join(".skillshub/cache"),
            home,
        }
    }

    pub fn from_store(store: &SkillStore) -> Result<Self> {
        let home = store
            .get_setting("runner_library_home")?
            .map(PathBuf::from)
            .or_else(dirs::home_dir)
            .context("runner home is not configured")?;
        Ok(Self::new(home))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ahm_domain::Digest as ProtocolDigest;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, SkillStore) {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".codex")).unwrap();
        std::fs::create_dir_all(temp.path().join("source")).unwrap();
        std::fs::write(
            temp.path().join("source/SKILL.md"),
            "---\nname: example\ndescription: A test skill\n---\n# Example\n",
        )
        .unwrap();
        let store = SkillStore::new(temp.path().join("skills.db"));
        store.ensure_schema().unwrap();
        (temp, store)
    }

    fn request(command: LibraryCommand, args: Value) -> LibraryRequest {
        LibraryRequest {
            command,
            args: args.as_object().unwrap().clone(),
            expected_digest: None,
        }
    }

    fn apply(home: &Path, store: &SkillStore, mut request: LibraryRequest) -> Value {
        let plan = execute(home, store, &request).unwrap();
        assert_eq!(plan["requiresCommit"], true);
        request.expected_digest =
            Some(ProtocolDigest::new(plan["digest"].as_str().unwrap()).unwrap());
        execute(home, store, &request).unwrap()
    }

    #[test]
    fn device_library_import_tags_files_sync_and_delete_need_no_registered_project() {
        let (temp, store) = fixture();
        let home = temp.path();
        let listing = execute(
            home,
            &store,
            &request(LibraryCommand::ListDirectories, json!({"parent":null})),
        )
        .unwrap();
        assert!(!listing
            .to_string()
            .contains(&home.to_string_lossy().to_string()));
        let source = listing["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["name"] == "source")
            .unwrap()["handle"]
            .clone();
        let candidates = execute(
            home,
            &store,
            &request(
                LibraryCommand::ListLocalSkillsCmd,
                json!({"basePath":source}),
            ),
        )
        .unwrap();
        assert_eq!(candidates[0]["name"], "example");
        let installed = apply(
            home,
            &store,
            request(
                LibraryCommand::InstallLocalSelection,
                json!({"basePath":source,"subpath":"."}),
            ),
        );
        let skill_id = installed["skill_id"].clone();
        let central = installed["central_path"].clone();
        assert!(central.as_str().unwrap().starts_with("folder-"));
        let content = execute(
            home,
            &store,
            &request(
                LibraryCommand::ReadSkillFile,
                json!({"centralPath":central,"filePath":"SKILL.md"}),
            ),
        )
        .unwrap();
        assert!(content.as_str().unwrap().contains("# Example"));
        let tag = execute(
            home,
            &store,
            &request(LibraryCommand::CreateTag, json!({"name":"Reviewed"})),
        )
        .unwrap();
        execute(
            home,
            &store,
            &request(
                LibraryCommand::SetSkillTags,
                json!({"skillId":skill_id,"tagIds":[tag["id"]]}),
            ),
        )
        .unwrap();
        let managed = execute(
            home,
            &store,
            &request(LibraryCommand::GetManagedSkills, json!({})),
        )
        .unwrap();
        assert_eq!(managed[0]["tags"][0]["name"], "Reviewed");
        assert!(!managed
            .to_string()
            .contains(&home.to_string_lossy().to_string()));
        apply(
            home,
            &store,
            request(
                LibraryCommand::SyncSkillToTool,
                json!({"sourcePath":central,"skillId":skill_id,"tool":"codex","name":"example"}),
            ),
        );
        assert!(home.join(".codex/skills/example/SKILL.md").exists());
        std::fs::create_dir(home.join("relocated")).unwrap();
        let destination = handle(&store, &home.join("relocated")).unwrap();
        apply(
            home,
            &store,
            request(
                LibraryCommand::SetCentralRepoPath,
                json!({"path":destination}),
            ),
        );
        assert!(
            home.join(".codex/skills/example/SKILL.md").exists(),
            "Storage relocation preserves tool access"
        );
        assert!(store.list_skills().unwrap()[0]
            .central_path
            .contains("relocated"));
        apply(
            home,
            &store,
            request(
                LibraryCommand::DeleteManagedSkill,
                json!({"skillId":skill_id}),
            ),
        );
        assert!(!home.join(".codex/skills/example").exists());
        assert!(home.join("source/SKILL.md").exists());
        assert!(store.list_skills().unwrap().is_empty());
    }

    #[test]
    fn changed_source_invalidates_review_and_foreign_handles_are_rejected() {
        let (temp, store) = fixture();
        let home = temp.path();
        let source = handle(&store, &home.join("source")).unwrap();
        let mut install = request(
            LibraryCommand::InstallLocalSelection,
            json!({"basePath":source,"subpath":"."}),
        );
        let plan = execute(home, &store, &install).unwrap();
        install.expected_digest =
            Some(ProtocolDigest::new(plan["digest"].as_str().unwrap()).unwrap());
        std::fs::write(
            home.join("source/SKILL.md"),
            "---\nname: changed\n---\nChanged",
        )
        .unwrap();
        assert!(execute(home, &store, &install)
            .unwrap_err()
            .to_string()
            .contains("Library changed"));
        assert!(store.list_skills().unwrap().is_empty());
        let (_, other) = fixture();
        assert!(execute(
            home,
            &other,
            &request(
                LibraryCommand::ListLocalSkillsCmd,
                json!({"basePath":source})
            )
        )
        .is_err());
        assert!(execute(
            home,
            &store,
            &request(
                LibraryCommand::ListLocalSkillsCmd,
                json!({"basePath":home.to_string_lossy()})
            )
        )
        .is_err());
        assert!(execute(
            home,
            &store,
            &request(LibraryCommand::GetTags, json!({"shell":"anything"}))
        )
        .is_err());
    }

    #[test]
    fn copied_target_drift_and_file_traversal_preserve_user_files() {
        let (temp, store) = fixture();
        let home = temp.path();
        std::fs::create_dir_all(home.join("custom")).unwrap();
        apply(
            home,
            &store,
            request(
                LibraryCommand::SetToolConfig,
                json!({"config":{"disabled_builtin_tools":[],"custom_tools":[{"key":"custom-test","label":"Test","avatar":null,"skills_dir":"custom","project_skills_dir":".test/skills","sync_mode":"copy","enabled":true}]}}),
            ),
        );
        let source = handle(&store, &home.join("source")).unwrap();
        let installed = apply(
            home,
            &store,
            request(
                LibraryCommand::InstallLocalSelection,
                json!({"basePath":source,"subpath":"."}),
            ),
        );
        let id = installed["skill_id"].clone();
        let central = installed["central_path"].clone();
        apply(
            home,
            &store,
            request(
                LibraryCommand::SyncSkillToTool,
                json!({"sourcePath":central,"skillId":id,"tool":"custom-test","name":"example"}),
            ),
        );
        std::fs::write(home.join("custom/example/SKILL.md"), "User edits").unwrap();
        assert!(execute(
            home,
            &store,
            &request(LibraryCommand::DeleteManagedSkill, json!({"skillId":id}))
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(home.join("custom/example/SKILL.md")).unwrap(),
            "User edits"
        );
        assert!(execute(
            home,
            &store,
            &request(
                LibraryCommand::ReadSkillFile,
                json!({"centralPath":central,"filePath":"../../skills.db"})
            )
        )
        .is_err());
    }
}
