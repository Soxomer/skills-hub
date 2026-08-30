use crate::central_repo::{ensure_central_repo, resolve_central_repo_path_for_home};
use crate::skill_store::SkillStore;

#[test]
fn central_repository_defaults_to_the_supplied_home() {
    let root = tempfile::tempdir().unwrap();
    let store = SkillStore::new(root.path().join("runner.db"));
    store.ensure_schema().unwrap();

    assert_eq!(
        resolve_central_repo_path_for_home(&store, root.path()).unwrap(),
        root.path().join(".skillshub")
    );
}

#[test]
fn central_repository_creation_is_runner_owned() {
    let root = tempfile::tempdir().unwrap();
    let repository = root.path().join("nested/central");

    ensure_central_repo(&repository).unwrap();

    assert!(repository.is_dir());
}
