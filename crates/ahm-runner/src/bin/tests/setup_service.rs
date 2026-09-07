use std::path::Path;

use ahm_runner::setup_service::{ApplyActionKind, DefaultSetupCandidateKind, SetupService};
use ahm_runner::skill_store::{SkillRecord, SkillStore, SkillTargetRecord};
use ahm_runner::sync_engine::SyncMode;
use ahm_runner::tool_adapters::{save_tool_config, CustomToolConfig, ToolConfig};
use tempfile::TempDir;

fn managed_skill(store: &SkillStore, root: &Path, id: &str, name: &str) -> SkillRecord {
    let central_path = root.join(name);
    std::fs::create_dir_all(&central_path).unwrap();
    std::fs::write(
        central_path.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: test\n---\n"),
    )
    .unwrap();
    let record = SkillRecord {
        id: id.to_string(),
        name: name.to_string(),
        description: Some("test skill".to_string()),
        source_type: "local".to_string(),
        source_ref: None,
        source_subpath: None,
        source_revision: None,
        central_path: central_path.to_string_lossy().to_string(),
        content_hash: None,
        created_at: 1,
        updated_at: 1,
        last_sync_at: None,
        last_seen_at: 1,
        enabled: true,
        status: "ok".to_string(),
    };
    store.upsert_skill(&record).unwrap();
    record
}

fn setup() -> (TempDir, SkillStore, SetupService) {
    let temp = tempfile::tempdir().unwrap();
    let store = SkillStore::new(temp.path().join("skills_hub.db"));
    store.ensure_schema().unwrap();
    let service = SetupService::from_store(store.clone()).unwrap();
    (temp, store, service)
}

fn registered_project(temp: &TempDir, service: &SetupService, name: &str) -> std::path::PathBuf {
    let project = temp.path().join(name);
    std::fs::create_dir_all(&project).unwrap();
    service.add_project(&project).unwrap();
    project
}

#[test]
fn project_assignment_stays_pinned_to_an_immutable_setup_revision() {
    let (temp, store, service) = setup();
    managed_skill(&store, &temp.path().join("library"), "skill-alpha", "alpha");
    managed_skill(&store, &temp.path().join("library"), "skill-beta", "beta");

    let setup = service.create_setup("developer").unwrap();
    let revision_two = service
        .add_setup_skill(&setup.setup.id, "skill-alpha", &["codex".to_string()])
        .unwrap();
    let project_root = temp.path().join("project");
    std::fs::create_dir_all(&project_root).unwrap();
    service.add_project(&project_root).unwrap();
    service
        .assign_setup(&project_root, &revision_two.setup.id)
        .unwrap();

    let revision_three = service
        .add_setup_skill(&setup.setup.id, "skill-beta", &["codex".to_string()])
        .unwrap();
    assert_eq!(revision_three.setup.revision_number, 3);

    let status = service.status(&project_root).unwrap();
    let assigned = status.project.assigned_setup.unwrap();
    assert_eq!(assigned.revision_id, revision_two.setup.revision_id);
    assert_eq!(assigned.revision_number, 2);
    let plan = status.pending_plan.unwrap();
    assert!(plan
        .actions
        .iter()
        .any(|action| action.skill_name == "alpha"));
    assert!(!plan
        .actions
        .iter()
        .any(|action| action.skill_name == "beta"));
}

#[test]
fn setup_switch_and_rollback_never_remove_unmanaged_files() {
    let (temp, store, service) = setup();
    managed_skill(&store, &temp.path().join("library"), "skill-alpha", "alpha");

    let active = service.create_setup("active").unwrap();
    service
        .add_setup_skill(&active.setup.id, "skill-alpha", &["codex".to_string()])
        .unwrap();
    let empty = service.create_setup("empty").unwrap();

    let project_root = temp.path().join("project");
    let unmanaged = project_root.join(".agents/skills/unmanaged");
    std::fs::create_dir_all(&unmanaged).unwrap();
    std::fs::write(unmanaged.join("SKILL.md"), "user-owned").unwrap();

    service.add_project(&project_root).unwrap();
    service
        .assign_setup(&project_root, &active.setup.id)
        .unwrap();
    let plan = service.plan(&project_root, None).unwrap();
    assert!(plan.conflicts.is_empty());
    assert!(plan
        .actions
        .iter()
        .any(|action| action.kind == ApplyActionKind::Add));

    let managed_target = project_root.join(".agents/skills/alpha");
    assert!(!managed_target.exists(), "planning must not mutate files");
    service.sync(&project_root, None).unwrap();
    assert!(managed_target.exists());
    assert_eq!(
        std::fs::read_to_string(unmanaged.join("SKILL.md")).unwrap(),
        "user-owned"
    );

    service
        .assign_setup(&project_root, &empty.setup.id)
        .unwrap();
    let removal = service.plan(&project_root, None).unwrap();
    assert!(removal.conflicts.is_empty());
    assert!(removal
        .actions
        .iter()
        .any(|action| action.kind == ApplyActionKind::Remove));
    service.sync(&project_root, None).unwrap();
    assert!(!managed_target.exists());
    assert_eq!(
        std::fs::read_to_string(unmanaged.join("SKILL.md")).unwrap(),
        "user-owned"
    );

    service.rollback(&project_root).unwrap();
    assert!(managed_target.exists());
    assert_eq!(
        std::fs::read_to_string(unmanaged.join("SKILL.md")).unwrap(),
        "user-owned"
    );
    let status = service.status(&project_root).unwrap();
    assert_eq!(status.project.assigned_setup.unwrap().id, active.setup.id);
    assert_eq!(status.project.applied_setup.unwrap().id, active.setup.id);
}

#[test]
fn unmanaged_collision_is_reported_and_preserved() {
    let (temp, store, service) = setup();
    managed_skill(&store, &temp.path().join("library"), "skill-alpha", "alpha");
    let setup = service.create_setup("collision-test").unwrap();
    service
        .add_setup_skill(&setup.setup.id, "skill-alpha", &["codex".to_string()])
        .unwrap();

    let project_root = temp.path().join("project");
    let collision = project_root.join(".agents/skills/alpha");
    std::fs::create_dir_all(&collision).unwrap();
    std::fs::write(collision.join("SKILL.md"), "unmanaged collision").unwrap();
    service.add_project(&project_root).unwrap();
    service
        .assign_setup(&project_root, &setup.setup.id)
        .unwrap();

    let plan = service.plan(&project_root, None).unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    assert!(service.sync(&project_root, None).is_err());
    assert_eq!(
        std::fs::read_to_string(collision.join("SKILL.md")).unwrap(),
        "unmanaged collision"
    );
}

#[test]
fn identical_unmanaged_target_is_adopted_without_overwriting_it() {
    let (temp, store, service) = setup();
    let skill = managed_skill(&store, &temp.path().join("library"), "skill-alpha", "alpha");
    let setup = service.create_setup("adopt-identical").unwrap();
    service
        .add_setup_skill(&setup.setup.id, &skill.id, &["codex".to_string()])
        .unwrap();

    let project_root = registered_project(&temp, &service, "project");
    let existing = project_root.join(".agents/skills/alpha");
    std::fs::create_dir_all(&existing).unwrap();
    std::fs::copy(
        Path::new(&skill.central_path).join("SKILL.md"),
        existing.join("SKILL.md"),
    )
    .unwrap();
    service
        .assign_setup(&project_root, &setup.setup.id)
        .unwrap();

    let plan = service.plan(&project_root, None).unwrap();
    assert!(plan.conflicts.is_empty());
    assert_eq!(plan.actions.len(), 1);
    assert_eq!(plan.actions[0].kind, ApplyActionKind::Keep);
    assert_eq!(plan.actions[0].detail, "adopt the identical local target");

    service.sync(&project_root, None).unwrap();
    assert_eq!(
        std::fs::read_to_string(existing.join("SKILL.md")).unwrap(),
        std::fs::read_to_string(Path::new(&skill.central_path).join("SKILL.md")).unwrap()
    );
    let status = service.status(&project_root).unwrap();
    assert_eq!(status.project.assigned_setup.unwrap().id, setup.setup.id);
    assert_eq!(status.project.applied_setup.unwrap().id, setup.setup.id);
}

#[test]
fn identical_unmanaged_copy_is_not_adopted_when_a_symlink_is_required() {
    let (temp, store, service) = setup();
    let skill = managed_skill(&store, &temp.path().join("library"), "skill-alpha", "alpha");
    save_tool_config(
        &store,
        ToolConfig {
            disabled_builtin_tools: Vec::new(),
            custom_tools: vec![CustomToolConfig {
                key: "link_tool".to_string(),
                label: "Link tool".to_string(),
                avatar: None,
                skills_dir: temp
                    .path()
                    .join("global-link-tool")
                    .to_string_lossy()
                    .to_string(),
                project_skills_dir: Some(".link-tool/skills".to_string()),
                sync_mode: SyncMode::Symlink,
                enabled: true,
            }],
        },
    )
    .unwrap();
    let setup = service.create_setup("require-symlink").unwrap();
    service
        .add_setup_skill(&setup.setup.id, &skill.id, &["link_tool".to_string()])
        .unwrap();

    let project_root = registered_project(&temp, &service, "project");
    let existing = project_root.join(".link-tool/skills/alpha");
    std::fs::create_dir_all(&existing).unwrap();
    std::fs::copy(
        Path::new(&skill.central_path).join("SKILL.md"),
        existing.join("SKILL.md"),
    )
    .unwrap();
    service
        .assign_setup(&project_root, &setup.setup.id)
        .unwrap();

    let plan = service.plan(&project_root, None).unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    assert!(plan.actions.is_empty());
    assert!(service.sync(&project_root, None).is_err());
    assert!(!std::fs::symlink_metadata(&existing)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn drifted_copy_target_blocks_setup_switch() {
    let (temp, store, service) = setup();
    managed_skill(&store, &temp.path().join("library"), "skill-alpha", "alpha");
    let active = service.create_setup("cursor-active").unwrap();
    service
        .add_setup_skill(&active.setup.id, "skill-alpha", &["cursor".to_string()])
        .unwrap();
    let empty = service.create_setup("empty").unwrap();

    let project_root = temp.path().join("project");
    std::fs::create_dir_all(&project_root).unwrap();
    service.add_project(&project_root).unwrap();
    service
        .assign_setup(&project_root, &active.setup.id)
        .unwrap();
    service.sync(&project_root, None).unwrap();

    let target_file = project_root.join(".agents/skills/alpha/SKILL.md");
    std::fs::write(&target_file, "locally edited").unwrap();
    service
        .assign_setup(&project_root, &empty.setup.id)
        .unwrap();
    let plan = service.plan(&project_root, None).unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    assert!(service.sync(&project_root, None).is_err());
    assert_eq!(
        std::fs::read_to_string(target_file).unwrap(),
        "locally edited"
    );
}

#[test]
fn default_preview_is_read_only_and_capture_retains_the_initial_revision() {
    let (temp, _store, service) = setup();
    let project = registered_project(&temp, &service, "project");
    let home = temp.path().join("home");
    let cursor = home.join(".cursor/skills/shared");
    let codex = home.join(".codex/skills/shared");
    std::fs::create_dir_all(&cursor).unwrap();
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::write(cursor.join("SKILL.md"), "same content").unwrap();
    std::fs::write(codex.join("SKILL.md"), "same content").unwrap();

    let preview = service.preview_default_setup(&home, &project).unwrap();
    assert_eq!(preview.total_tools_scanned, 2);
    assert_eq!(preview.candidates.len(), 2);
    assert!(preview.candidates.iter().all(|item| item.capturable));
    assert!(!home.join(".skillshub").exists(), "preview must not write");

    let captured = service.capture_default_setup(&home, &project, &[]).unwrap();
    assert_eq!(captured.captured_candidates, 2);
    assert_eq!(captured.snapshot_count, 1);
    assert!(captured.setup.setup.is_default);
    assert_eq!(captured.setup.setup.revision_number, 1);
    assert_eq!(
        captured.setup.setup.initial_revision_id.as_deref(),
        Some(captured.setup.setup.revision_id.as_str())
    );
    assert_eq!(captured.setup.items.len(), 2);
    assert!(captured
        .setup
        .items
        .iter()
        .all(|item| item.target_name == "shared"));
    let snapshots = std::fs::read_dir(home.join(".skillshub"))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(
        std::fs::read_to_string(snapshots[0].path().join("SKILL.md")).unwrap(),
        "same content"
    );
    assert_eq!(
        std::fs::read_to_string(cursor.join("SKILL.md")).unwrap(),
        "same content"
    );
    let first_item = captured.setup.items.first().unwrap();
    let edited = service
        .remove_setup_skill(
            &captured.setup.setup.id,
            &first_item.skill_id,
            std::slice::from_ref(&first_item.tool),
        )
        .unwrap();
    assert_eq!(edited.setup.revision_number, 2);
    assert_eq!(
        edited.setup.initial_revision_id,
        captured.setup.setup.initial_revision_id
    );
    assert!(service.capture_default_setup(&home, &project, &[]).is_err());
}

#[test]
fn default_capture_preserves_conflicting_agent_content_as_distinct_snapshots() {
    let (temp, _store, service) = setup();
    let project = registered_project(&temp, &service, "project");
    let home = temp.path().join("home");
    let cursor = home.join(".cursor/skills/same-name");
    let codex = home.join(".codex/skills/same-name");
    std::fs::create_dir_all(&cursor).unwrap();
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::write(cursor.join("SKILL.md"), "cursor version").unwrap();
    std::fs::write(codex.join("SKILL.md"), "codex version").unwrap();

    let preview = service.preview_default_setup(&home, &project).unwrap();
    assert_eq!(preview.candidates.len(), 2);
    assert!(preview.candidates.iter().all(|item| item.has_conflict));

    let captured = service.capture_default_setup(&home, &project, &[]).unwrap();
    assert_eq!(captured.snapshot_count, 2);
    assert_eq!(captured.setup.items.len(), 2);
    assert!(captured
        .setup
        .items
        .iter()
        .all(|item| item.target_name == "same-name"));
    assert_ne!(
        captured.setup.items[0].skill_id,
        captured.setup.items[1].skill_id
    );
}

#[test]
fn default_capture_excludes_only_explicit_selection_keys() {
    let (temp, _store, service) = setup();
    let project = registered_project(&temp, &service, "project");
    let home = temp.path().join("home");
    for name in ["keep", "leave-external"] {
        let skill = home.join(".codex/skills").join(name);
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), name).unwrap();
    }

    let preview = service.preview_default_setup(&home, &project).unwrap();
    let excluded = preview
        .candidates
        .iter()
        .find(|item| item.name == "leave-external")
        .unwrap()
        .selection_key
        .clone();
    assert!(service
        .capture_default_setup(&home, &project, &["missing|selection".to_string()])
        .is_err());
    let captured = service
        .capture_default_setup(&home, &project, std::slice::from_ref(&excluded))
        .unwrap();
    assert_eq!(captured.excluded_candidates, 1);
    assert_eq!(captured.captured_candidates, 1);
    assert_eq!(captured.setup.items[0].target_name, "keep");
}

#[test]
fn default_preview_includes_existing_managed_global_targets_once() {
    let (temp, store, service) = setup();
    let project = registered_project(&temp, &service, "project");
    let home = temp.path().join("home");
    let skill = managed_skill(
        &store,
        &temp.path().join("library"),
        "managed-skill",
        "managed",
    );
    let target = home.join(".codex/skills/managed");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("SKILL.md"), "managed target state").unwrap();
    store
        .upsert_skill_target(&SkillTargetRecord {
            id: "managed-target".to_string(),
            skill_id: skill.id,
            tool: "codex".to_string(),
            scope: "global".to_string(),
            project_path: None,
            target_path: target.to_string_lossy().to_string(),
            mode: "copy".to_string(),
            status: "ok".to_string(),
            last_error: None,
            synced_at: Some(1),
        })
        .unwrap();

    let preview = service.preview_default_setup(&home, &project).unwrap();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(
        preview.candidates[0].classification,
        DefaultSetupCandidateKind::KnownSkill
    );
    assert_eq!(preview.candidates[0].source_path, target.to_string_lossy());
}

#[test]
fn each_project_owns_and_selects_its_own_default_setup() {
    let (temp, _store, service) = setup();
    let home = temp.path().join("home");
    let source = home.join(".codex/skills/baseline");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("SKILL.md"), "baseline").unwrap();
    let project_a = registered_project(&temp, &service, "project-a");
    let project_b = registered_project(&temp, &service, "project-b");
    let local_a = project_a.join(".agents/skills/only-a");
    let local_b = project_b.join(".agents/skills/only-b");
    std::fs::create_dir_all(&local_a).unwrap();
    std::fs::create_dir_all(&local_b).unwrap();
    std::fs::write(local_a.join("SKILL.md"), "project a").unwrap();
    std::fs::write(local_b.join("SKILL.md"), "project b").unwrap();

    let default_a = service
        .capture_default_setup(&home, &project_a, &[])
        .unwrap();
    let default_b = service
        .capture_default_setup(&home, &project_b, &[])
        .unwrap();
    assert_ne!(default_a.setup.setup.id, default_b.setup.setup.id);
    assert_ne!(
        default_a.setup.setup.initial_revision_id,
        default_b.setup.setup.initial_revision_id
    );
    assert!(default_a
        .setup
        .items
        .iter()
        .any(|item| item.target_name == "only-a"));
    assert!(!default_a
        .setup
        .items
        .iter()
        .any(|item| item.target_name == "only-b"));
    assert!(default_b
        .setup
        .items
        .iter()
        .any(|item| item.target_name == "only-b"));
    assert!(!default_b
        .setup
        .items
        .iter()
        .any(|item| item.target_name == "only-a"));

    let selected_a = service.assign_default_setup(&project_a).unwrap();
    let selected_b = service.assign_default_setup(&project_b).unwrap();
    assert_eq!(
        selected_a.assigned_setup.unwrap().id,
        default_a.setup.setup.id
    );
    assert_eq!(
        selected_b.assigned_setup.unwrap().id,
        default_b.setup.setup.id
    );
    assert_eq!(
        selected_a.default_setup.unwrap().id,
        default_a.setup.setup.id
    );
    assert_eq!(
        selected_b.default_setup.unwrap().id,
        default_b.setup.setup.id
    );
}
