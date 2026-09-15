use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::skill_store::SkillStore;

const CENTRAL_DIR_NAME: &str = ".skillshub";

pub fn resolve_central_repo_path(
    paths: &crate::library::LibraryPaths,
    store: &SkillStore,
) -> Result<PathBuf> {
    resolve_central_repo_path_for_home(store, &paths.home)
}

pub fn resolve_central_repo_path_for_home(store: &SkillStore, home: &Path) -> Result<PathBuf> {
    if let Some(path) = store.get_setting("central_repo_path")? {
        return Ok(PathBuf::from(path));
    }
    Ok(home.join(CENTRAL_DIR_NAME))
}

pub fn ensure_central_repo(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("create {:?}", path))?;
    Ok(())
}

#[cfg(test)]
#[path = "tests/central_repo.rs"]
mod tests;
