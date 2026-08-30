use std::path::Path;

use app_lib::core::setup_service::{ApplyActionKind, SetupService};
use app_lib::core::skill_store::{SkillRecord, SkillStore};
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
