use std::fs;

use crate::content_hash::hash_dir;
use base64::{engine::general_purpose::STANDARD, Engine};

#[test]
fn canonical_fixture_is_portable_and_creation_order_independent() {
    let fixture: ahm_domain::ArtifactBundle = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/artifacts/canonical-v1.json"
    ))
    .unwrap();
    for reverse in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut entries = fixture.entries.clone();
        if reverse {
            entries.reverse();
        }
        for entry in entries {
            let path = root.path().join(&entry.path);
            match entry.content_base64 {
                Some(content) => {
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(path, STANDARD.decode(content).unwrap()).unwrap();
                }
                None => fs::create_dir_all(path).unwrap(),
            }
        }
        assert_eq!(
            format!("sha256:{}", hash_dir(root.path()).unwrap()),
            fixture.content_digest.as_str()
        );
    }
}

#[test]
fn names_content_and_entry_types_cannot_alias() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    fs::write(a.path().join("a"), "bc").unwrap();
    fs::write(b.path().join("ab"), "c").unwrap();
    assert_ne!(hash_dir(a.path()).unwrap(), hash_dir(b.path()).unwrap());
    let file = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    fs::write(file.path().join("empty"), "").unwrap();
    fs::create_dir(directory.path().join("empty")).unwrap();
    assert_ne!(
        hash_dir(file.path()).unwrap(),
        hash_dir(directory.path()).unwrap()
    );
}

#[test]
fn hash_changes_with_content_and_ignores_git_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path();

    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("a.txt"), b"hello").unwrap();
    fs::write(root.join("sub/b.txt"), b"world").unwrap();

    let h1 = hash_dir(root).unwrap();

    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join(".git/ignored"), b"ignored").unwrap();
    let h2 = hash_dir(root).unwrap();
    assert_eq!(h1, h2, ".git content should be ignored");

    fs::write(root.join("a.txt"), b"hello2").unwrap();
    let h3 = hash_dir(root).unwrap();
    assert_ne!(h2, h3);
}
