use std::path::{Component, Path, PathBuf};

use ahm_domain::{ArtifactBundle, ArtifactBundleEntry, ArtifactBundleEntryKind, Digest};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    content_hash::{hash_dir, validate_artifact_path},
    sync_engine::{copy_dir_recursive, remove_path_any},
};

const MAX_ARTIFACT_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ArtifactCache {
    root: PathBuf,
}

impl ArtifactCache {
    pub fn for_home(home: &Path) -> Self {
        Self {
            root: home.join(".skillshub").join("artifacts"),
        }
    }

    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path(&self, digest: &Digest) -> Result<PathBuf> {
        Ok(self.root.join(digest_hex(digest)?))
    }

    pub fn contains(&self, digest: &Digest) -> Result<bool> {
        let path = self.path(digest)?;
        if !path.is_dir() {
            return Ok(false);
        }
        Ok(hash_dir(&path)? == digest_hex(digest)?)
    }

    pub fn snapshot(&self, source: &Path, digest: &Digest) -> Result<PathBuf> {
        if self.contains(digest)? {
            return self.path(digest);
        }
        if !source.is_dir() {
            bail!("artifact source is not a directory: {}", source.display());
        }
        std::fs::create_dir_all(&self.root)
            .with_context(|| format!("create artifact cache {}", self.root.display()))?;
        let destination = self.path(digest)?;
        let temporary = self.root.join(format!(".incoming-{}", Uuid::new_v4()));
        let result = (|| {
            copy_dir_recursive(source, &temporary)?;
            verify_digest(&temporary, digest)?;
            match std::fs::rename(&temporary, &destination) {
                Ok(()) => Ok(()),
                Err(_) if self.contains(digest)? => Ok(()),
                Err(error) => Err(error).with_context(|| {
                    format!(
                        "publish cached artifact {} -> {}",
                        temporary.display(),
                        destination.display()
                    )
                }),
            }
        })();
        if result.is_err() || temporary.exists() {
            let _ = remove_path_any(&temporary);
        }
        result?;
        Ok(destination)
    }

    pub fn bundle(&self, digest: &Digest) -> Result<Option<ArtifactBundle>> {
        if !self.contains(digest)? {
            return Ok(None);
        }
        let root = self.path(digest)?;
        let mut entries = Vec::new();
        let mut total_bytes = 0_u64;
        for entry in WalkDir::new(&root).follow_links(false).into_iter().skip(1) {
            let entry = entry?;
            let relative = entry.path().strip_prefix(&root)?;
            let path = portable_relative_path(relative)?;
            if entry.file_type().is_dir() {
                entries.push(ArtifactBundleEntry {
                    path,
                    kind: ArtifactBundleEntryKind::Directory,
                    content_base64: None,
                });
            } else if entry.file_type().is_file() {
                let bytes = std::fs::read(entry.path())?;
                total_bytes = total_bytes.saturating_add(bytes.len() as u64);
                if total_bytes > MAX_ARTIFACT_BYTES {
                    bail!("artifact exceeds 10 MiB");
                }
                entries.push(ArtifactBundleEntry {
                    path,
                    kind: ArtifactBundleEntryKind::File,
                    content_base64: Some(STANDARD.encode(bytes)),
                });
            } else {
                bail!("artifact contains an unsupported link or special file");
            }
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(Some(ArtifactBundle {
            content_digest: digest.clone(),
            entries,
        }))
    }

    pub fn store(&self, bundle: &ArtifactBundle) -> Result<PathBuf> {
        if self.contains(&bundle.content_digest)? {
            return self.path(&bundle.content_digest);
        }
        if bundle.entries.len() > 5_000 {
            bail!("artifact bundle has too many entries");
        }
        std::fs::create_dir_all(&self.root)?;
        let temporary = self.root.join(format!(".incoming-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temporary)?;
        let mut total_bytes = 0_u64;
        let result = (|| {
            for entry in &bundle.entries {
                let relative = validate_relative_path(&entry.path)?;
                let destination = temporary.join(relative);
                match entry.kind {
                    ArtifactBundleEntryKind::Directory => {
                        if entry.content_base64.is_some() {
                            bail!("artifact directory contains file bytes");
                        }
                        std::fs::create_dir_all(&destination)?;
                    }
                    ArtifactBundleEntryKind::File => {
                        let encoded = entry
                            .content_base64
                            .as_deref()
                            .context("artifact file is missing content")?;
                        let bytes = STANDARD
                            .decode(encoded)
                            .context("artifact file is not valid base64")?;
                        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
                        if total_bytes > MAX_ARTIFACT_BYTES {
                            bail!("artifact exceeds 10 MiB");
                        }
                        if let Some(parent) = destination.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        std::fs::write(&destination, bytes)?;
                    }
                }
            }
            verify_digest(&temporary, &bundle.content_digest)?;
            let destination = self.path(&bundle.content_digest)?;
            match std::fs::rename(&temporary, &destination) {
                Ok(()) => Ok(destination),
                Err(_) if self.contains(&bundle.content_digest)? => Ok(destination),
                Err(error) => Err(error).context("publish downloaded artifact"),
            }
        })();
        if result.is_err() || temporary.exists() {
            let _ = remove_path_any(&temporary);
        }
        result
    }
}

fn digest_hex(digest: &Digest) -> Result<&str> {
    digest
        .as_str()
        .strip_prefix("sha256:")
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .context("artifact digest must be lowercase sha256")
}

fn verify_digest(path: &Path, digest: &Digest) -> Result<()> {
    let actual = hash_dir(path)?;
    let expected = digest_hex(digest)?;
    if actual != expected {
        bail!("artifact digest mismatch: expected {expected}, received {actual}");
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<PathBuf> {
    validate_artifact_path(value)?;
    if value.is_empty() || value.contains('\\') {
        bail!("artifact path is invalid");
    }
    let path = PathBuf::from(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        bail!("artifact path escapes its bundle: {value}");
    }
    Ok(path)
}

fn portable_relative_path(path: &Path) -> Result<String> {
    let parts = path
        .components()
        .map(|part| match part {
            Component::Normal(value) => Ok(value.to_string_lossy().into_owned()),
            _ => bail!("artifact path is not relative"),
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use ahm_domain::Digest;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn bundle_round_trip_verifies_content_and_paths() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("SKILL.md"), "# Cached").unwrap();
        std::fs::write(source.join("nested").join("note.txt"), "hello").unwrap();
        let digest = Digest::new(format!("sha256:{}", hash_dir(&source).unwrap())).unwrap();
        let first = ArtifactCache::new(root.path().join("first"));
        first.snapshot(&source, &digest).unwrap();
        let bundle = first.bundle(&digest).unwrap().unwrap();
        let second = ArtifactCache::new(root.path().join("second"));
        second.store(&bundle).unwrap();
        assert!(second.contains(&digest).unwrap());
    }

    #[test]
    fn downloaded_bundle_cannot_escape_the_cache() {
        let root = tempdir().unwrap();
        let cache = ArtifactCache::new(root.path().join("cache"));
        let bundle = ArtifactBundle {
            content_digest: Digest::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
            entries: vec![ArtifactBundleEntry {
                path: "../outside".to_owned(),
                kind: ArtifactBundleEntryKind::File,
                content_base64: Some(STANDARD.encode("bad")),
            }],
        };
        assert!(cache.store(&bundle).is_err());
        assert!(!root.path().join("outside").exists());
    }
}
