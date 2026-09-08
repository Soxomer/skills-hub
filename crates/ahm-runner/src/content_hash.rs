use std::path::Path;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

pub fn hash_dir(path: &Path) -> Result<String> {
    if !path.is_dir() {
        bail!("artifact root must be a directory");
    }
    let mut entries = Vec::new();

    for entry in WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git")
    {
        let entry = entry?;
        if entry.depth() == 0 {
            continue;
        }

        let relative = entry
            .path()
            .strip_prefix(path)
            .with_context(|| format!("strip prefix {:?}", entry.path()))?;
        let portable = relative
            .components()
            .map(|part| {
                part.as_os_str()
                    .to_str()
                    .context("artifact paths must be UTF-8")
            })
            .collect::<Result<Vec<_>>>()?
            .join("/");
        validate_artifact_path(&portable)?;
        if !entry.file_type().is_file() && !entry.file_type().is_dir() {
            bail!("artifact contains an unsupported link or special file");
        }
        entries.push((portable, entry));
    }
    entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    let mut hasher = Sha256::new();
    hasher.update(b"AHM-ARTIFACT-V1\0");
    for (portable, entry) in entries {
        let file = entry.file_type().is_file();
        hasher.update(if file { b"F" } else { b"D" });
        hasher.update((portable.len() as u64).to_be_bytes());
        hasher.update(portable.as_bytes());
        if file {
            let bytes = std::fs::read(entry.path())
                .with_context(|| format!("read file {:?}", entry.path()))?;
            hasher.update((bytes.len() as u64).to_be_bytes());
            hasher.update(bytes);
        }
    }

    let digest = hasher.finalize();
    Ok(hex::encode(digest))
}

pub(crate) fn validate_artifact_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.contains(['\\', ':'])
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part == ".git")
    {
        bail!("artifact path is not portable");
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests/content_hash.rs"]
mod tests;
