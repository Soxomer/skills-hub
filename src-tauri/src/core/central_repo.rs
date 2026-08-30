use std::path::PathBuf;

use anyhow::{Context, Result};
use dirs::home_dir;
use tauri::Manager;

use super::skill_store::SkillStore;

pub use ahm_runner::central_repo::{ensure_central_repo, resolve_central_repo_path_for_home};

const CENTRAL_DIR_NAME: &str = ".skillshub";

pub fn resolve_central_repo_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    store: &SkillStore,
) -> Result<PathBuf> {
    if let Some(path) = store.get_setting("central_repo_path")? {
        return Ok(PathBuf::from(path));
    }

    if let Some(home) = home_dir() {
        return Ok(home.join(CENTRAL_DIR_NAME));
    }

    let base = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data dir")?;
    Ok(base.join(CENTRAL_DIR_NAME))
}

#[cfg(test)]
#[path = "tests/central_repo.rs"]
mod tests;
