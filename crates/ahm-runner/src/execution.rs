use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::setup_service::{ApplyPlan, ApplyResult, DefaultSetupPreview, SetupService};

pub struct RunnerExecutionService {
    local_admin: SetupService,
}

impl RunnerExecutionService {
    pub fn open(db_path: PathBuf) -> Result<Self> {
        Ok(Self {
            local_admin: SetupService::open(db_path)?,
        })
    }

    pub fn from_setup_service(local_admin: SetupService) -> Self {
        Self { local_admin }
    }

    pub fn local_admin(&self) -> &SetupService {
        &self.local_admin
    }

    pub fn scan(&self, home: &Path, project: &Path) -> Result<DefaultSetupPreview> {
        self.local_admin.preview_default_setup(home, project)
    }

    pub fn plan(&self, project: &Path, setup_selector: Option<&str>) -> Result<ApplyPlan> {
        self.local_admin.plan(project, setup_selector)
    }

    pub fn apply(&self, project: &Path, setup_selector: Option<&str>) -> Result<ApplyResult> {
        self.local_admin.sync(project, setup_selector)
    }

    pub fn rollback(&self, project: &Path) -> Result<ApplyResult> {
        self.local_admin.rollback(project)
    }
}
