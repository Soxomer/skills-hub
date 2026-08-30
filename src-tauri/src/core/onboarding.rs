use anyhow::Result;

use super::central_repo::resolve_central_repo_path;
use super::skill_store::SkillStore;

pub use ahm_runner::onboarding::*;

pub fn build_onboarding_plan<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    store: &SkillStore,
) -> Result<OnboardingPlan> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("failed to resolve home directory"))?;
    let central = resolve_central_repo_path(app, store)?;
    build_onboarding_plan_for_home(store, &home, &central)
}
