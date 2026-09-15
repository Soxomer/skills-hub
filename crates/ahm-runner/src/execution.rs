use std::path::{Path, PathBuf};

use anyhow::Result;

#[cfg(feature = "acceptance-tests")]
use crate::setup_service::TestFaultInjection;
use crate::setup_service::{
    ApplyPlan, ApplyResult, DefaultSetupPreview, RecoveredOperation, SetupService,
};

pub struct RunnerExecutionService {
    local_admin: SetupService,
}

impl RunnerExecutionService {
    pub fn open(db_path: PathBuf) -> Result<Self> {
        Ok(Self {
            local_admin: SetupService::open(db_path)?,
        })
    }

    #[cfg(feature = "acceptance-tests")]
    pub fn open_with_test_fault(db_path: PathBuf, test_fault: TestFaultInjection) -> Result<Self> {
        Ok(Self {
            local_admin: SetupService::open(db_path)?.with_test_fault(test_fault),
        })
    }

    pub fn from_setup_service(local_admin: SetupService) -> Self {
        Self { local_admin }
    }

    pub fn local_admin(&self) -> &SetupService {
        &self.local_admin
    }

    pub fn library(
        &self,
        home: &Path,
        request: &ahm_domain::LibraryRequest,
        should_cancel: &mut dyn FnMut() -> Result<bool>,
    ) -> Result<serde_json::Value> {
        crate::library::execute_checked(
            home,
            &self.local_admin.library_store(),
            request,
            should_cancel,
        )
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

    pub(crate) fn apply_checked_cancellable<T>(
        &self,
        project: &Path,
        setup_selector: Option<&str>,
        validate: impl FnOnce(&ApplyPlan) -> Result<T>,
        should_cancel: &mut dyn FnMut() -> Result<bool>,
    ) -> Result<(ApplyResult, T)> {
        self.local_admin
            .sync_checked_cancellable(project, setup_selector, validate, should_cancel)
    }

    pub fn rollback(&self, project: &Path) -> Result<ApplyResult> {
        self.local_admin.rollback(project)
    }

    pub(crate) fn rollback_checked(
        &self,
        project: &Path,
        operation_id: &str,
        should_cancel: &mut dyn FnMut() -> Result<bool>,
    ) -> Result<ApplyResult> {
        self.local_admin
            .rollback_checked(project, Some(operation_id), should_cancel)
    }

    pub(crate) fn recover_incomplete_operation(
        &self,
        project: &Path,
    ) -> Result<Option<RecoveredOperation>> {
        self.local_admin.recover_incomplete_operation(project)
    }
}
