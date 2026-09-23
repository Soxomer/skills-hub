//! Local lifecycle only. No control-plane authority or workstation paths leave this module.
use anyhow::{Context, Result};
use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub fn directory(state: &Path) -> PathBuf {
    state.with_extension("worker")
}

pub struct WorkerControl {
    root: PathBuf,
    _lock: File,
}

impl WorkerControl {
    pub fn acquire(state: &Path) -> Result<Self> {
        let root = directory(state);
        fs::create_dir_all(&root)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("lock"))?;
        lock.try_lock_exclusive().context(
            "A worker is already running for this runner. Stop it before starting or reconnecting.",
        )?;
        match fs::remove_file(root.join("stop")) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        let control = Self { root, _lock: lock };
        control.report("starting")?;
        Ok(control)
    }

    pub fn stop_requested(&self) -> bool {
        self.root.join("stop").exists()
    }

    pub fn report(&self, state: &str) -> Result<()> {
        // Contains no credentials, paths, job content, or raw server errors.
        fs::write(
            self.root.join("status.json"),
            serde_json::to_vec(&serde_json::json!({
                "state": state, "pid": std::process::id(), "updatedAt": crate::worker::utc_now(),
            }))?,
        )
        .context("write local worker status")
    }
}

impl Drop for WorkerControl {
    fn drop(&mut self) {
        let _ = self.report("stopped");
    }
}

pub fn is_running(state: &Path) -> Result<bool> {
    let root = directory(state);
    if !root.exists() {
        return Ok(false);
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("lock"))?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(e) if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() => Ok(true),
        Err(e) => Err(e.into()),
    }
}

pub fn request_stop(state: &Path) -> Result<()> {
    let root = directory(state);
    fs::create_dir_all(&root)?;
    fs::write(root.join("stop"), b"stop after current cycle\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exclusive_worker_stops_without_deleting_state_and_can_restart() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("runner.db");
        fs::write(&state, b"preserve identity").unwrap();
        let first = WorkerControl::acquire(&state).unwrap();
        assert!(is_running(&state).unwrap());
        assert!(WorkerControl::acquire(&state).is_err());
        request_stop(&state).unwrap();
        assert!(first.stop_requested());
        drop(first);
        assert!(!is_running(&state).unwrap());
        let second = WorkerControl::acquire(&state).unwrap();
        assert!(!second.stop_requested());
        assert_eq!(fs::read(&state).unwrap(), b"preserve identity");
    }
}
