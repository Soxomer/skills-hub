use std::path::Path;

use ahm_domain::{
    ArtifactBundle, ArtifactBundleEntry, ArtifactBundleEntryKind, Digest, LibraryCommand,
    LibraryRequest, LibrarySetupSnapshot, SnapshotFile,
};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest as ShaDigest, Sha256};
use std::io::Read;
use walkdir::WalkDir;

use crate::{
    artifact_cache::ArtifactCache,
    content_hash::validate_artifact_path,
    skill_store::SkillStore,
    tool_adapters::{default_tool_adapters, supports_project_scope},
};

pub(crate) fn snapshot(home: &Path, store: &SkillStore, request: &LibraryRequest) -> Result<Value> {
    let skill = store
        .get_skill_by_id(
            request.args["skillId"]
                .as_str()
                .context("Missing skill ID")?,
        )?
        .context("Skill not found")?;
    let source = Path::new(&skill.central_path);
    ensure!(
        !std::fs::symlink_metadata(source)?.file_type().is_symlink(),
        "Skill snapshot root cannot be a link"
    );
    ensure!(
        source.join("SKILL.md").is_file(),
        "SKILL_INVALID|Missing SKILL.md"
    );
    let mut files = Vec::new();
    let mut entries = Vec::new();
    let mut bytes = 0_u64;
    let mut count = 0_usize;
    for entry in WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || e.file_name() != ".git")
    {
        let entry = entry?;
        if entry.depth() == 0 {
            continue;
        }
        count += 1;
        ensure!(count <= 5000, "Skill snapshot has too many entries");
        ensure!(
            entry.file_type().is_dir() || entry.file_type().is_file(),
            "Skill snapshot cannot contain links or special files"
        );
        let relative = entry.path().strip_prefix(source)?;
        let path = relative
            .to_str()
            .context("Skill paths must be UTF-8")?
            .replace('\\', "/");
        validate_artifact_path(&path)?;
        // Match the hosted artifact path bound (JavaScript UTF-16 string length).
        ensure!(path.encode_utf16().count() <= 500, "Skill path is too long");
        if entry.file_type().is_file() {
            let mut content = Vec::new();
            std::fs::File::open(entry.path())?
                .take(10 * 1024 * 1024 - bytes + 1)
                .read_to_end(&mut content)?;
            let size = content.len() as u64;
            bytes = bytes.saturating_add(size);
            ensure!(bytes <= 10 * 1024 * 1024, "Skill snapshot exceeds 10 MiB");
            entries.push(ArtifactBundleEntry {
                path: path.clone(),
                kind: ArtifactBundleEntryKind::File,
                content_base64: Some(STANDARD.encode(&content)),
            });
            files.push(SnapshotFile { path, size });
        } else {
            entries.push(ArtifactBundleEntry {
                path,
                kind: ArtifactBundleEntryKind::Directory,
                content_base64: None,
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    entries.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    let mut hash = Sha256::new();
    hash.update(b"AHM-ARTIFACT-V1\0");
    for entry in &entries {
        hash.update(if entry.kind == ArtifactBundleEntryKind::File {
            b"F"
        } else {
            b"D"
        });
        hash.update((entry.path.len() as u64).to_be_bytes());
        hash.update(entry.path.as_bytes());
        if let Some(content) = &entry.content_base64 {
            let content = STANDARD.decode(content)?;
            hash.update((content.len() as u64).to_be_bytes());
            hash.update(content);
        }
    }
    let hex = hex::encode(hash.finalize());
    let digest = Digest::new(format!("sha256:{hex}"))?;
    if request.command == LibraryCommand::SnapshotSetupSkill {
        ensure!(
            request.expected_digest.as_ref() == Some(&digest),
            "Library changed; review the action again"
        );
        let cache = ArtifactCache::for_home(home);
        cache.store(&ArtifactBundle {
            content_digest: digest.clone(),
            entries,
        })?;
        // Validate bounded portable bytes before reporting a publishable snapshot.
        cache
            .bundle(&digest)?
            .context("Cached skill snapshot missing")?;
    }
    let portable_source = skill.source_ref.as_deref().and_then(|value| {
        let url = reqwest::Url::parse(value).ok()?;
        (url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.port().is_none()
            && url
                .path()
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_./-".contains(c)))
        .then(|| url.to_string())
    });
    serde_json::to_value(LibrarySetupSnapshot {
        artifact_id: format!("library-{hex}"),
        name: skill.name,
        content_digest: digest,
        portable_source,
        supported_tools: default_tool_adapters()
            .into_iter()
            .filter(supports_project_scope)
            .map(|t| t.id.as_key().to_owned())
            .collect(),
        files,
    })
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_store::SkillRecord;
    use serde_json::json;
    fn fixture() -> (tempfile::TempDir, SkillStore) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("managed");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("SKILL.md"), "# Review\nReview changes.").unwrap();
        std::fs::write(path.join("helper.txt"), "supporting file").unwrap();
        let store = SkillStore::new(root.path().join("library.db"));
        store.ensure_schema().unwrap();
        store
            .upsert_skill(&SkillRecord {
                id: "review".into(),
                name: "review".into(),
                description: None,
                source_type: "local".into(),
                source_ref: Some("C:/private/source".into()),
                source_subpath: None,
                source_revision: None,
                central_path: path.to_str().unwrap().into(),
                content_hash: None,
                created_at: 1,
                updated_at: 1,
                last_sync_at: None,
                last_seen_at: 1,
                enabled: true,
                status: "ok".into(),
            })
            .unwrap();
        (root, store)
    }
    fn request(command: LibraryCommand, expected_digest: Option<Digest>) -> LibraryRequest {
        LibraryRequest {
            command,
            args: json!({"skillId":"review"}).as_object().unwrap().clone(),
            expected_digest,
        }
    }
    #[test]
    fn preview_is_metadata_only_and_snapshot_is_immutable_without_sync() {
        let (root, store) = fixture();
        let preview = crate::library::execute(
            root.path(),
            &store,
            &request(LibraryCommand::PreviewSetupSkill, None),
        )
        .unwrap();
        let snapshot: LibrarySetupSnapshot = serde_json::from_value(preview.clone()).unwrap();
        assert_eq!(snapshot.portable_source, None);
        assert_eq!(snapshot.files.len(), 2);
        assert!(!preview.to_string().contains(root.path().to_str().unwrap()));
        let cache = ArtifactCache::for_home(root.path());
        assert!(!cache.root().exists());
        let result = crate::library::execute(
            root.path(),
            &store,
            &request(
                LibraryCommand::SnapshotSetupSkill,
                Some(snapshot.content_digest.clone()),
            ),
        )
        .unwrap();
        assert_eq!(result, preview);
        let bundle = cache.bundle(&snapshot.content_digest).unwrap().unwrap();
        std::fs::write(root.path().join("managed/SKILL.md"), "Changed upstream").unwrap();
        assert_eq!(
            cache.bundle(&snapshot.content_digest).unwrap().unwrap(),
            bundle
        );
        assert!(store.list_skill_targets("review").unwrap().is_empty());
        assert!(crate::library::execute(
            root.path(),
            &store,
            &request(
                LibraryCommand::SnapshotSetupSkill,
                Some(snapshot.content_digest)
            )
        )
        .unwrap_err()
        .to_string()
        .contains("Library changed"));
    }
    #[test]
    fn rejects_unapproved_unknown_and_oversized_snapshots() {
        let (root, store) = fixture();
        assert!(snapshot(
            root.path(),
            &store,
            &request(LibraryCommand::SnapshotSetupSkill, None)
        )
        .is_err());
        let mut missing = request(LibraryCommand::PreviewSetupSkill, None);
        missing.args.insert("skillId".into(), json!("unknown"));
        assert!(snapshot(root.path(), &store, &missing).is_err());
        std::fs::write(
            root.path().join("managed/huge.bin"),
            vec![0_u8; 10 * 1024 * 1024],
        )
        .unwrap();
        assert!(snapshot(
            root.path(),
            &store,
            &request(LibraryCommand::PreviewSetupSkill, None)
        )
        .unwrap_err()
        .to_string()
        .contains("10 MiB"));
        assert!(!ArtifactCache::for_home(root.path()).root().exists());
    }
    #[test]
    fn only_exports_sources_accepted_by_the_portable_contract() {
        let (root, store) = fixture();
        for (source, expected) in [
            (
                "https://github.com/org/repo",
                Some("https://github.com/org/repo"),
            ),
            ("https://github.com/org/a%20b", None),
            ("https://user:secret@github.com/org/repo", None),
            ("https://github.com/org/repo?token=secret", None),
        ] {
            let mut skill = store.get_skill_by_id("review").unwrap().unwrap();
            skill.source_ref = Some(source.into());
            store.upsert_skill(&skill).unwrap();
            let value = snapshot(
                root.path(),
                &store,
                &request(LibraryCommand::PreviewSetupSkill, None),
            )
            .unwrap();
            assert_eq!(value["portableSource"].as_str(), expected);
        }
    }
    #[test]
    fn rejects_paths_that_cannot_be_uploaded_before_preview_or_cache() {
        let (root, store) = fixture();
        let directory = root
            .path()
            .join("managed")
            .join("a".repeat(180))
            .join("b".repeat(180));
        std::fs::create_dir_all(&directory).unwrap();
        // 180 + separator + 180 + separator + 138 = 500 UTF-16 code units.
        let path = directory.join("c".repeat(138));
        std::fs::write(&path, "").unwrap();
        let value = snapshot(
            root.path(),
            &store,
            &request(LibraryCommand::PreviewSetupSkill, None),
        )
        .unwrap();
        assert!(value["files"].as_array().unwrap().iter().any(|f| f["path"]
            .as_str()
            .unwrap()
            .len()
            == 500));
        std::fs::write(directory.join("d".repeat(139)), "").unwrap();
        assert!(snapshot(
            root.path(),
            &store,
            &request(LibraryCommand::PreviewSetupSkill, None)
        )
        .unwrap_err()
        .to_string()
        .contains("Skill path is too long"));
        assert!(!ArtifactCache::for_home(root.path()).root().exists());
    }
    #[test]
    fn entry_limit_accepts_5000_and_rejects_5001_without_caching() {
        let (root, store) = fixture();
        for index in 0..4998 {
            std::fs::write(
                root.path().join("managed").join(format!("file-{index}")),
                "",
            )
            .unwrap();
        }
        let value = snapshot(
            root.path(),
            &store,
            &request(LibraryCommand::PreviewSetupSkill, None),
        )
        .unwrap();
        assert_eq!(value["files"].as_array().unwrap().len(), 5000);
        std::fs::write(root.path().join("managed/overflow.txt"), "").unwrap();
        assert!(snapshot(
            root.path(),
            &store,
            &request(LibraryCommand::PreviewSetupSkill, None)
        )
        .unwrap_err()
        .to_string()
        .contains("too many entries"));
        assert!(!ArtifactCache::for_home(root.path()).root().exists());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_links_in_the_selected_skill() {
        let (root, store) = fixture();
        std::os::unix::fs::symlink("/etc/passwd", root.path().join("managed/link")).unwrap();
        assert!(snapshot(
            root.path(),
            &store,
            &request(LibraryCommand::PreviewSetupSkill, None)
        )
        .is_err());
    }
}
