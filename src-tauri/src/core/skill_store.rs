use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::Manager;

pub use ahm_runner::skill_store::*;

const DB_FILE_NAME: &str = "skills_hub.db";

pub fn default_db_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf> {
    let app_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data dir")?;
    std::fs::create_dir_all(&app_dir)
        .with_context(|| format!("failed to create app data dir {:?}", app_dir))?;
    Ok(app_dir.join(DB_FILE_NAME))
}
