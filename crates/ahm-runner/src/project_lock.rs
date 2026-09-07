use std::{
    fs::{File, OpenOptions},
    path::Path,
};

use anyhow::{Context, Result};
use fs2::FileExt;
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub(crate) struct ProjectOperationLock {
    file: File,
}

impl ProjectOperationLock {
    pub(crate) fn try_acquire(project_path: &Path) -> Result<Self> {
        let lock_root = dirs::data_local_dir()
            .context("local application data directory not found")?
            .join("ahm")
            .join("project-locks");
        Self::try_acquire_in(&lock_root, project_path)
    }

    fn try_acquire_in(lock_root: &Path, project_path: &Path) -> Result<Self> {
        let canonical_path = project_path
            .canonicalize()
            .with_context(|| format!("resolve project path {}", project_path.display()))?;
        std::fs::create_dir_all(lock_root)
            .with_context(|| format!("create project lock directory {}", lock_root.display()))?;

        let digest = Sha256::digest(canonical_path.as_os_str().as_encoded_bytes());
        let lock_path = lock_root.join(format!("{}.lock", hex::encode(digest)));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .with_context(|| format!("open project lock {}", lock_path.display()))?;
        if let Err(error) = FileExt::try_lock_exclusive(&file) {
            if error.kind() == fs2::lock_contended_error().kind() {
                anyhow::bail!(
                    "PROJECT_OPERATION_IN_PROGRESS|another operation is already using project {}",
                    canonical_path.display()
                );
            }
            return Err(error)
                .with_context(|| format!("lock project {}", canonical_path.display()));
        }
        Ok(Self { file })
    }
}

impl Drop for ProjectOperationLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn one_checkout_has_one_operation_lock() {
        let root = tempdir().unwrap();
        let project = root.path().join("project");
        let other_project = root.path().join("other-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&other_project).unwrap();

        let first = ProjectOperationLock::try_acquire_in(root.path(), &project).unwrap();
        let conflict = ProjectOperationLock::try_acquire_in(root.path(), &project).unwrap_err();
        assert!(conflict
            .to_string()
            .starts_with("PROJECT_OPERATION_IN_PROGRESS|"));
        ProjectOperationLock::try_acquire_in(root.path(), &other_project).unwrap();

        drop(first);
        ProjectOperationLock::try_acquire_in(root.path(), &project).unwrap();
    }
}
