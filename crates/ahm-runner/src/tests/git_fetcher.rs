use std::fs;

use super::git_cmd;
use crate::git_fetcher::{clone_or_pull, clone_or_pull_sparse};

fn commit_file(repo: &git2::Repository, path: &str, content: &[u8], msg: &str) -> git2::Oid {
    let workdir = repo.workdir().expect("workdir");
    let file_path = workdir.join(path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&file_path, content).unwrap();

    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new(path)).unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();

    let sig = git2::Signature::now("t", "t@example.com").unwrap();
    let parents = match repo.head() {
        Ok(head) => vec![repo.find_commit(head.target().unwrap()).unwrap()],
        Err(_) => vec![],
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, parent_refs.as_slice())
        .unwrap()
}

#[test]
fn preview_commit_is_installed_even_when_the_branch_has_advanced() {
    let origin_dir = tempfile::tempdir().unwrap();
    let origin = git2::Repository::init(origin_dir.path()).unwrap();
    let previewed = commit_file(&origin, "SKILL.md", b"Previewed content", "preview");
    commit_file(&origin, "SKILL.md", b"New content after preview", "advance");
    let destination = tempfile::tempdir().unwrap();
    let checkout = destination
        .path()
        .join("long-runner-cache-location".repeat(7));
    let revision = clone_or_pull(
        origin_dir.path().to_str().unwrap(),
        &checkout,
        Some(&previewed.to_string()),
        None,
        None,
    )
    .unwrap();
    assert_eq!(revision, previewed.to_string());
    let sparse = destination.path().join("sparse");
    assert_eq!(
        clone_or_pull_sparse(
            origin_dir.path().to_str().unwrap(),
            &sparse,
            Some(&previewed.to_string()),
            ".",
            None,
            None
        )
        .unwrap(),
        previewed.to_string()
    );
    assert_eq!(
        fs::read_to_string(sparse.join("SKILL.md")).unwrap(),
        "Previewed content"
    );
    assert_eq!(
        fs::read_to_string(checkout.join("SKILL.md")).unwrap(),
        "Previewed content"
    );
}

#[test]
fn clone_then_pull_updates_head() {
    let origin_dir = tempfile::tempdir().unwrap();
    let origin = git2::Repository::init(origin_dir.path()).unwrap();
    let _c1 = commit_file(&origin, "a.txt", b"v1", "c1");
    let c2 = commit_file(&origin, "a.txt", b"v2", "c2");

    let dest_dir = tempfile::tempdir().unwrap();
    let dest = dest_dir.path().join("clone");

    let h1 = clone_or_pull(
        origin_dir.path().to_string_lossy().as_ref(),
        &dest,
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(h1, c2.to_string(), "首次 clone 应指向最新提交");

    let c3 = commit_file(&origin, "b.txt", b"v3", "c3");
    let h2 = clone_or_pull(
        origin_dir.path().to_string_lossy().as_ref(),
        &dest,
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(h2, c3.to_string(), "再次调用应更新到最新提交");
}

#[test]
fn sparse_clone_only_materializes_requested_subpath() {
    let origin_dir = tempfile::tempdir().unwrap();
    let origin = git2::Repository::init(origin_dir.path()).unwrap();
    let _ = commit_file(&origin, "skills/a/SKILL.md", b"---\nname: A\n---\n", "c1");
    let _ = commit_file(&origin, "skills/b/SKILL.md", b"---\nname: B\n---\n", "c2");

    let dest_dir = tempfile::tempdir().unwrap();
    let dest = dest_dir.path().join("clone");

    let head = match clone_or_pull_sparse(
        origin_dir.path().to_string_lossy().as_ref(),
        &dest,
        None,
        "skills/a",
        None,
        None,
    ) {
        Ok(head) => head,
        Err(err) if format!("{:#}", err).contains("system git is required") => return,
        Err(err) => panic!("sparse clone failed: {:#}", err),
    };

    assert!(!head.is_empty());
    assert!(dest.join("skills/a/SKILL.md").exists());
    assert!(
        !dest.join("skills/b/SKILL.md").exists(),
        "未请求的子目录不应被检出到工作区"
    );
}

#[test]
fn git_command_injects_configured_proxy() {
    let cmd = git_cmd(Some("http://127.0.0.1:7890"));
    let args = cmd
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(args.contains(&"http.proxy=http://127.0.0.1:7890".to_string()));
    assert!(args.contains(&"https.proxy=http://127.0.0.1:7890".to_string()));
    assert_eq!(
        cmd.get_envs()
            .find(|(key, _)| key.to_string_lossy() == "https_proxy")
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().to_string()),
        Some("http://127.0.0.1:7890".to_string())
    );
}
