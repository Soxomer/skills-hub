//! Versioned, instruction-only code-review smoke test. No generated code is executed.
use std::{
    ffi::OsString,
    fs::File,
    io::Read,
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

use ahm_domain::{
    EvaluateSetupsJob, EvaluationCheck, EvaluationContextMode, EvaluationObservedConfiguration,
    EvaluationProfile, EvaluationReasoningEffort, EvaluationResult, EvaluationVariantResult,
    EvaluationVariantStatus, Identifier, IsoTimestamp, PortableSetupRevision,
};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use sha2::{Digest as ShaDigest, Sha256};

use crate::artifact_cache::ArtifactCache;

const MAX_CONTEXT: usize = 64 * 1024;
const MAX_OUTPUT: u64 = 1024 * 1024;
const DISABLED_FEATURES: &[&str] = &[
    "apps",
    "plugins",
    "remote_plugin",
    "hooks",
    "shell_tool",
    "unified_exec",
    "skill_search",
    "skill_mcp_dependency_install",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "code_mode_host",
    "multi_agent",
    "multi_agent_v2",
    "image_generation",
    "memories",
    "workspace_dependencies",
    "view_image",
    "sleep_tool",
    "goals",
    "tool_suggest",
    "request_permissions_tool",
    "deferred_executor",
    "token_budget",
];

// Fixture and grader belong to code-review-v1. Changing either requires a new suite ID.
const TASK: &str = r#"Review the three independent JavaScript functions below. Report the line
containing a functional bug, or null when the implementation matches the requirement.
Do not invent stylistic findings. Return exactly one answer for each case ID.
Do not use tools. The complete source is provided here.

Case discount: Return price after a percentage discount (0 to 100).
1 function discounted(price, percent) {
2   const fraction = percent / 100;
3   return price * fraction;
4 }

Case clamp: Constrain a number to inclusive bounds, where min <= max.
1 function clamp(value, min, max) {
2   return Math.min(max, Math.max(min, value));
3 }

Case contains: Return whether the array contains the supplied value.
1 function contains(values, value) {
2   return values.indexOf(value) > 0;
3 }
"#;

fn schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object", "additionalProperties": false, "required": ["cases"],
        "properties": {"cases": {"type": "array", "minItems": 3, "maxItems": 3,
            "items": {"type": "object", "additionalProperties": false,
                "required": ["id", "bugLine"], "properties": {
                    "id": {"type": "string", "enum": ["discount", "clamp", "contains"]},
                    "bugLine": {"type": ["integer", "null"]}
                }}}}
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    cases: Vec<CaseAnswer>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaseAnswer {
    id: String,
    #[serde(deserialize_with = "required_nullable_line")]
    bug_line: Option<u32>,
}

fn required_nullable_line<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u32>, D::Error> {
    Option::<u32>::deserialize(deserializer)
}

fn grade(answer: &str) -> Result<Vec<EvaluationCheck>> {
    let answer: Answer = serde_json::from_str(answer).context("invalid structured answer")?;
    let cases = [
        ("discount", Some(3), "Discount arithmetic bug"),
        ("clamp", None, "No false positive on correct clamp"),
        ("contains", Some(2), "First-element membership bug"),
    ];
    ensure!(
        answer.cases.len() == cases.len(),
        "answer must contain all three cases"
    );
    cases
        .into_iter()
        .map(|(id, expected, label)| {
            let matching: Vec<_> = answer.cases.iter().filter(|case| case.id == id).collect();
            ensure!(
                matching.len() == 1,
                "answer must contain each case exactly once"
            );
            Ok(EvaluationCheck {
                id: Identifier::new(id)?,
                label: label.to_owned(),
                passed: matching[0].bug_line == expected,
            })
        })
        .collect()
}

fn instructions(cache: &ArtifactCache, revision: &PortableSetupRevision) -> Result<String> {
    ensure!(
        revision.items.len() <= 50,
        "the pilot supports at most 50 skill entries"
    );
    let mut context = String::new();
    for item in &revision.items {
        ensure!(
            item.tool_id.as_str() == "codex",
            "the pilot accepts Codex-targeted skills only"
        );
        ensure!(
            matches!(item.artifact_kind, ahm_domain::DiscoveryKind::Skill),
            "the pilot accepts skill instructions only"
        );
        let bundle = cache
            .bundle(&item.content_digest)?
            .context("skill artifact unavailable")?;
        let entry = bundle
            .entries
            .iter()
            .find(|entry| entry.path == "SKILL.md")
            .context("skill artifact has no root SKILL.md")?;
        let bytes = STANDARD.decode(
            entry
                .content_base64
                .as_deref()
                .context("SKILL.md must be a file")?,
        )?;
        ensure!(
            context.len() + bytes.len() <= MAX_CONTEXT,
            "skill instructions exceed 64 KiB; nothing was truncated"
        );
        let content = String::from_utf8(bytes).context("skill instructions must be UTF-8")?;
        context.push_str("\n<skill-instructions>\n");
        context.push_str(&content);
        context.push_str("\n</skill-instructions>\n");
    }
    Ok(context)
}

fn executable() -> OsString {
    if let Some(binary) = std::env::var_os("AHM_CODEX_BIN") {
        return binary;
    }
    #[cfg(windows)]
    {
        if let Some(path) = std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|root| root.join("codex.exe"))
                .find(|path| path.is_file())
        }) {
            return path.into_os_string();
        }
        if let Some(path) = dirs::data_local_dir()
            .map(|root| root.join("Programs/OpenAI/Codex/bin/codex.exe"))
            .filter(|path| path.is_file())
        {
            return path.into_os_string();
        }
    }
    OsString::from("codex")
}

fn command(binary: &std::ffi::OsStr) -> Command {
    let mut command = Command::new(binary);
    // Authentication remains owned by the official CLI. Do not inherit API-billing overrides.
    command
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = unsafe { libc::getpid() };
        // Linux kills the CLI if the worker disappears, including an ungraceful crash.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::other("evaluation parent exited"));
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

#[cfg(windows)]
struct ProcessGuard(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(windows)]
fn guard(child: &mut Child) -> Result<ProcessGuard> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            stop(child);
            bail!("cannot create evaluation lifetime guard");
        }
        let guard = ProcessGuard(job);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of_val(&info) as u32,
        ) == 0
            || AssignProcessToJobObject(job, child.as_raw_handle()) == 0
        {
            stop(child);
            bail!("cannot attach evaluation lifetime guard");
        }
        Ok(guard)
    }
}
#[cfg(not(windows))]
struct ProcessGuard;
#[cfg(not(windows))]
fn guard(child: &mut Child) -> Result<ProcessGuard> {
    if !cfg!(target_os = "linux") {
        stop(child);
        bail!("this pilot requires Windows or Linux process lifetime protection");
    }
    Ok(ProcessGuard)
}

enum ProcessOutcome {
    Exited(ExitStatus),
    Stopped(EvaluationVariantStatus, &'static str),
}

fn tool_activity(events: &str) -> bool {
    events
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .any(|event| {
            event
                .get("item")
                .and_then(|item| item.get("type"))
                .and_then(|kind| kind.as_str())
                .is_some_and(|kind| !matches!(kind, "agent_message" | "reasoning" | "error"))
        })
}

fn final_evidence(workspace: &Path) -> Result<Vec<EvaluationCheck>> {
    let events = read_bounded(&workspace.join("events.jsonl"), MAX_OUTPUT)?;
    // The CLI can write its final event between the last supervisor poll and process exit.
    ensure!(
        !tool_activity(&events),
        "tool use invalidates this instruction-only trial"
    );
    let _ = read_bounded(&workspace.join("stderr.log"), MAX_OUTPUT)?;
    grade(&read_bounded(&workspace.join("answer.json"), MAX_OUTPUT)?)
}

fn supervise(
    child: &mut Child,
    workspace: &Path,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> ProcessOutcome {
    loop {
        if cancelled.load(Ordering::SeqCst) {
            stop(child);
            return ProcessOutcome::Stopped(
                EvaluationVariantStatus::Cancelled,
                "Evaluation cancelled.",
            );
        }
        if Instant::now() >= deadline {
            stop(child);
            return ProcessOutcome::Stopped(
                EvaluationVariantStatus::TimedOut,
                "Codex exceeded the 120-second limit for this side.",
            );
        }
        if ["events.jsonl", "stderr.log", "answer.json"]
            .iter()
            .any(|name| {
                std::fs::metadata(workspace.join(name))
                    .is_ok_and(|metadata| metadata.len() > MAX_OUTPUT)
            })
        {
            stop(child);
            return ProcessOutcome::Stopped(
                EvaluationVariantStatus::Failed,
                "Codex output exceeded the bounded evidence limit.",
            );
        }
        if read_bounded(&workspace.join("events.jsonl"), MAX_OUTPUT)
            .is_ok_and(|events| tool_activity(&events))
        {
            stop(child);
            return ProcessOutcome::Stopped(
                EvaluationVariantStatus::Failed,
                "Codex attempted tool use; this instruction-only comparison is invalid.",
            );
        }
        match child.try_wait() {
            Ok(Some(status)) => return ProcessOutcome::Exited(status),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                stop(child);
                return ProcessOutcome::Stopped(
                    EvaluationVariantStatus::Interrupted,
                    "Could not observe Codex completion.",
                );
            }
        }
    }
}

fn stop(child: &mut Child) {
    // The profile disables subprocess tools. Stop the CLI before deleting its private workspace.
    let _ = child.kill();
    let _ = child.wait();
}

fn read_bounded(path: &Path, limit: u64) -> Result<String> {
    ensure!(
        std::fs::metadata(path)?.len() <= limit,
        "runtime output exceeded its limit"
    );
    let mut text = String::new();
    File::open(path)?
        .take(limit + 1)
        .read_to_string(&mut text)?;
    ensure!(
        text.len() as u64 <= limit,
        "runtime output exceeded its limit"
    );
    Ok(text)
}

fn probe(binary: &std::ffi::OsStr, args: &[&str]) -> Result<String> {
    let output = tempfile::NamedTempFile::new()?;
    let mut child = command(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(output.reopen()?)
        .stderr(Stdio::null())
        .spawn()?;
    let _guard = guard(&mut child)?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            ensure!(status.success(), "Codex capability check failed");
            return read_bounded(output.path(), MAX_OUTPUT);
        }
        if started.elapsed() > Duration::from_secs(10) {
            stop(&mut child);
            bail!("Codex capability check timed out");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn preflight(binary: &std::ffi::OsStr) -> Result<String> {
    ensure!(
        cfg!(any(windows, target_os = "linux")),
        "process lifetime protection is unavailable on this platform"
    );
    let version = probe(binary, &["--version"])?;
    ensure!(
        version.starts_with("codex-cli ") && version.trim().len() < 100,
        "unrecognized Codex runtime"
    );
    let help = probe(binary, &["exec", "--help"])?;
    for flag in [
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--output-schema",
    ] {
        ensure!(
            help.contains(flag),
            "Codex runtime does not support the isolated evaluation profile"
        );
    }
    let features = probe(binary, &["features", "list"])?;
    for feature in DISABLED_FEATURES
        .iter()
        .copied()
        .chain(["skip_host_skill_discovery"])
    {
        ensure!(
            features
                .lines()
                .any(|line| line.split_whitespace().next() == Some(feature)),
            "Codex runtime does not support the evaluation feature controls"
        );
    }
    Ok(version.trim().to_owned())
}

fn configure(command: &mut Command, profile: &EvaluationProfile, workspace: &Path) {
    command
        .args([
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "--skip-git-repo-check",
            "--json",
            "--color",
            "never",
            "--sandbox",
            "read-only",
            "--model",
            profile.model.as_str(),
            "--enable",
            "skip_host_skill_discovery",
        ])
        .arg("--cd")
        .arg(workspace)
        .arg("--output-schema")
        .arg(workspace.join("answer-schema.json"))
        .arg("--output-last-message")
        .arg(workspace.join("answer.json"));
    for feature in DISABLED_FEATURES {
        command.args(["--disable", feature]);
    }
    for setting in [
        "approval_policy=\"never\"",
        "web_search=\"disabled\"",
        "project_doc_max_bytes=0",
        "skills.include_instructions=false",
        "tools.update_plan.enabled=false",
        "mcp_servers={}",
        "forced_login_method=\"chatgpt\"",
        "shell_environment_policy.inherit=\"none\"",
    ] {
        command.args(["-c", setting]);
    }
    let effort = match profile.reasoning_effort {
        EvaluationReasoningEffort::Low => "low",
        EvaluationReasoningEffort::Medium => "medium",
        EvaluationReasoningEffort::High => "high",
    };
    command
        .arg("-c")
        .arg(format!("model_reasoning_effort=\"{effort}\""));
    command.arg("-");
}

fn variant_error(
    revision: &PortableSetupRevision,
    status: EvaluationVariantStatus,
    duration: Duration,
    error: &str,
) -> EvaluationVariantResult {
    EvaluationVariantResult {
        setup_revision_id: revision.setup_revision_id.clone(),
        status,
        duration_ms: duration.as_millis().min(u64::MAX as u128) as u64,
        checks: vec![],
        summary: "No task score: execution did not complete under the requested conditions.".into(),
        error: Some(error.into()),
    }
}

fn run_variant(
    binary: &std::ffi::OsStr,
    profile: &EvaluationProfile,
    revision: &PortableSetupRevision,
    context: &str,
    should_cancel: &mut dyn FnMut() -> Result<bool>,
) -> EvaluationVariantResult {
    let started = Instant::now();
    let failure = |status, message| variant_error(revision, status, started.elapsed(), message);
    let run = || -> Result<(tempfile::TempDir, Child)> {
        let workspace = tempfile::Builder::new()
            .prefix("ahm-evaluation-")
            .tempdir()?;
        std::fs::write(
            workspace.path().join("answer-schema.json"),
            serde_json::to_vec(&schema())?,
        )?;
        let mut process = command(binary);
        configure(&mut process, profile, workspace.path());
        let prompt = format!("Apply these supplied skill instructions to the code-review task. This is an instruction-only smoke test; do not use tools.\n{context}\n{TASK}");
        let prompt_path = workspace.path().join("prompt.txt");
        std::fs::write(&prompt_path, prompt)?;
        let child = process
            .current_dir(workspace.path())
            .stdin(File::open(prompt_path)?)
            .stdout(File::create(workspace.path().join("events.jsonl"))?)
            .stderr(File::create(workspace.path().join("stderr.log"))?)
            .spawn()?;
        Ok((workspace, child))
    };
    let (workspace, mut child) = match run() {
        Ok(value) => value,
        Err(_) => return failure(EvaluationVariantStatus::Failed, "Could not start Codex. Install a supported Codex CLI and sign in with ChatGPT on this device."),
    };
    let _guard = match guard(&mut child) {
        Ok(guard) => guard,
        Err(_) => return failure(EvaluationVariantStatus::Failed, "Process lifetime protection is unavailable. This pilot requires a supported Windows or Linux runner."),
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let outcome = thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel();
        let cancel_flag = Arc::clone(&cancelled);
        let path = workspace.path();
        scope.spawn(move || {
            let outcome = supervise(
                &mut child,
                path,
                started + Duration::from_secs(profile.timeout_seconds.into()),
                &cancel_flag,
            );
            let _ = sender.send(outcome);
        });
        let mut last_control = None;
        let mut control_failed = false;
        loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(outcome) => {
                    return if control_failed {
                        ProcessOutcome::Stopped(EvaluationVariantStatus::Interrupted,
                        "Runner connection lost; execution stopped. Start a new comparison explicitly.")
                    } else {
                        outcome
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return ProcessOutcome::Stopped(
                        EvaluationVariantStatus::Interrupted,
                        "Process supervision stopped unexpectedly.",
                    )
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if !cancelled.load(Ordering::SeqCst)
                && last_control.map_or(true, |last: Instant| {
                    last.elapsed() >= Duration::from_secs(1)
                })
            {
                match should_cancel() {
                    Ok(true) => cancelled.store(true, Ordering::SeqCst),
                    Err(_) => {
                        control_failed = true;
                        cancelled.store(true, Ordering::SeqCst);
                    }
                    Ok(false) => {}
                }
                last_control = Some(Instant::now());
            }
        }
    });
    match outcome {
        ProcessOutcome::Stopped(status, error) => failure(status, error),
        ProcessOutcome::Exited(status) if !status.success() => {
            failure(EvaluationVariantStatus::Failed, "Codex failed. Check your ChatGPT login, model access, usage allowance and support for the evaluation profile.")
        },
        ProcessOutcome::Exited(_) => match final_evidence(workspace.path()) {
            Ok(checks) => {
                let passed = checks.iter().filter(|check| check.passed).count();
                EvaluationVariantResult { setup_revision_id: revision.setup_revision_id.clone(),
                    status: EvaluationVariantStatus::Completed,
                    duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    summary: format!("{passed}/3 fixture checks passed. One instruction-only trial; this is not a project quality benchmark."),
                    checks, error: None }
            }
            Err(_) => failure(EvaluationVariantStatus::Failed, "Codex did not return the required structured evidence; no task score was recorded."),
        }
    }
}

pub fn incomplete(
    request: &EvaluateSetupsJob,
    status: EvaluationVariantStatus,
    error: &str,
) -> EvaluationResult {
    EvaluationResult {
        suite_id: request.suite_id,
        profile: request.profile.clone(),
        observed: EvaluationObservedConfiguration {
            harness_version: "unavailable".into(),
            model: None,
            context_mode: EvaluationContextMode::SkillInstructions,
            native_skill_activation: false,
            inherited_instructions_digest: None,
            ambient_context_verified: false,
        },
        baseline: variant_error(&request.baseline, status, Duration::ZERO, error),
        candidate: variant_error(&request.candidate, status, Duration::ZERO, error),
        completed_at: timestamp(),
    }
}

fn timestamp() -> IsoTimestamp {
    IsoTimestamp::new(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
        .expect("UTC timestamp")
}

fn inherited_instructions_digest(codex_home: &Path) -> Result<Option<ahm_domain::Digest>> {
    let mut hash = Sha256::new();
    let mut found = false;
    for name in ["AGENTS.override.md", "AGENTS.md"] {
        let path = codex_home.join(name);
        match std::fs::metadata(&path) {
            Ok(metadata) => {
                ensure!(
                    metadata.is_file() && metadata.len() <= 1024 * 1024,
                    "global instructions are not bounded regular files"
                );
                let bytes = std::fs::read(path)?;
                ensure!(
                    bytes.len() <= 1024 * 1024,
                    "global instructions changed beyond their limit"
                );
                hash.update(name.as_bytes());
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
                found = true;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    if found {
        Ok(Some(ahm_domain::Digest::new(format!(
            "sha256:{:x}",
            hash.finalize()
        ))?))
    } else {
        Ok(None)
    }
}

pub fn execute(
    home: &Path,
    request: &EvaluateSetupsJob,
    should_cancel: &mut dyn FnMut() -> Result<bool>,
) -> EvaluationResult {
    let fail = |message: &str| incomplete(request, EvaluationVariantStatus::Failed, message);
    if let Err(error) = request.validate() {
        return fail(error);
    }
    let cache = ArtifactCache::for_home(home);
    // Validate both sides before spending subscription usage on either.
    let (baseline_context, candidate_context) = match (instructions(&cache, &request.baseline), instructions(&cache, &request.candidate)) {
        (Ok(baseline), Ok(candidate)) => (baseline, candidate),
        _ => return fail("Both revisions must contain only available Codex-targeted skill artifacts with a root UTF-8 SKILL.md (up to 50 skills and 64 KiB per side). Scripts, supporting files and native activation are not evaluated."),
    };
    let binary = executable();
    let codex_home = match std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
    {
        Some(home) => home,
        None => return fail("The local Codex home could not be resolved."),
    };
    let inherited_digest =
        match inherited_instructions_digest(&codex_home) {
            Ok(digest) => digest,
            Err(_) => return fail(
                "Global Codex instructions could not be fingerprinted; no comparison was started.",
            ),
        };
    let version = match preflight(&binary) {
        Ok(version) => version,
        Err(_) => return fail("Install a Codex CLI supporting the isolated evaluation profile, then sign in with ChatGPT. This runner could not verify the required runtime controls."),
    };
    let baseline = run_variant(
        &binary,
        &request.profile,
        &request.baseline,
        &baseline_context,
        should_cancel,
    );
    if inherited_instructions_digest(&codex_home).ok().as_ref() != Some(&inherited_digest) {
        return incomplete(
            request,
            EvaluationVariantStatus::Interrupted,
            "Global Codex instructions changed during the comparison; results are inconclusive.",
        );
    }
    let candidate = if matches!(
        baseline.status,
        EvaluationVariantStatus::Cancelled | EvaluationVariantStatus::Interrupted
    ) {
        variant_error(
            &request.candidate,
            baseline.status,
            Duration::ZERO,
            "Comparison stopped before this side started.",
        )
    } else {
        run_variant(
            &binary,
            &request.profile,
            &request.candidate,
            &candidate_context,
            should_cancel,
        )
    };
    if inherited_instructions_digest(&codex_home).ok().as_ref() != Some(&inherited_digest) {
        return incomplete(
            request,
            EvaluationVariantStatus::Interrupted,
            "Global Codex instructions changed during the comparison; results are inconclusive.",
        );
    }
    EvaluationResult {
        suite_id: request.suite_id,
        profile: request.profile.clone(),
        observed: EvaluationObservedConfiguration {
            harness_version: version,
            model: None,
            context_mode: EvaluationContextMode::SkillInstructions,
            native_skill_activation: false,
            inherited_instructions_digest: inherited_digest,
            ambient_context_verified: false,
        },
        baseline,
        candidate,
        completed_at: timestamp(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> EvaluateSetupsJob {
        let envelope: ahm_domain::JobEnvelope = serde_json::from_str(include_str!(
            "../../../packages/contracts/fixtures/v1/job-evaluation.json"
        ))
        .unwrap();
        let ahm_domain::RunnerJob::EvaluateSetups(mut request) = envelope.job else {
            panic!("evaluation fixture")
        };
        request.baseline.items.clear();
        request.candidate.items.clear();
        request
    }

    #[test]
    fn requested_profile_keeps_auth_with_official_runtime_and_disables_ambient_tools() {
        let request = request();
        let mut command = command(std::ffi::OsStr::new("codex"));
        configure(&mut command, &request.profile, Path::new("fixture"));
        let args = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect::<Vec<_>>();
        for flag in [
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "skip_host_skill_discovery",
            "read-only",
        ] {
            assert!(args.contains(&flag));
        }
        assert!(!args.iter().any(|arg| arg.contains("bypass")));
        for feature in DISABLED_FEATURES {
            assert!(args.windows(2).any(|pair| pair == ["--disable", *feature]));
        }
    }

    #[test]
    fn interrupted_result_has_no_fabricated_scores_or_observed_model() {
        let result = incomplete(
            &request(),
            EvaluationVariantStatus::Interrupted,
            "interrupted",
        );
        assert!(result.baseline.checks.is_empty());
        assert!(result.candidate.checks.is_empty());
        assert_eq!(result.observed.model, None);
        assert!(!result.observed.native_skill_activation);
    }

    #[test]
    #[ignore = "requires installed Codex, ChatGPT login, and explicitly selected AHM_EVAL_SMOKE_MODEL; consumes subscription usage"]
    fn real_codex_pair_smoke() {
        preflight(&executable()).expect("installed Codex profile preflight");
        let mut request = request();
        request.profile.model =
            Identifier::new(std::env::var("AHM_EVAL_SMOKE_MODEL").expect("explicit smoke model"))
                .unwrap();
        let home = tempfile::tempdir().unwrap();
        let source = home.path().join("review-skill");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "---\nname: code-review\ndescription: Review code for functional bugs\n---\nCheck arithmetic and boundary cases. Do not report stylistic issues as bugs.").unwrap();
        let digest = ahm_domain::Digest::new(format!(
            "sha256:{}",
            crate::content_hash::hash_dir(&source).unwrap()
        ))
        .unwrap();
        ArtifactCache::for_home(home.path())
            .snapshot(&source, &digest)
            .unwrap();
        request
            .candidate
            .items
            .push(ahm_domain::PortableSetupRevisionItem {
                artifact_id: Identifier::new("review-skill").unwrap(),
                artifact_kind: ahm_domain::DiscoveryKind::Skill,
                portable_source: None,
                content_digest: digest,
                tool_id: Identifier::new("codex").unwrap(),
                target_name: Identifier::new("review").unwrap(),
            });
        let result = execute(home.path(), &request, &mut || Ok(false));
        eprintln!(
            "Runtime: {}; baseline: {:?} ({:?}); candidate: {:?} ({:?})",
            result.observed.harness_version,
            result.baseline.status,
            result.baseline.error,
            result.candidate.status,
            result.candidate.error
        );
        assert_eq!(result.baseline.status, EvaluationVariantStatus::Completed);
        assert_eq!(result.candidate.status, EvaluationVariantStatus::Completed);
        assert_eq!(result.baseline.checks.len(), 3);
        assert_eq!(result.candidate.checks.len(), 3);
    }

    #[test]
    fn grader_detects_bugs_and_false_positives_independently() {
        let checks = grade(r#"{"cases":[{"id":"discount","bugLine":3},{"id":"clamp","bugLine":2},{"id":"contains","bugLine":null}]}"#).unwrap();
        assert_eq!(
            checks.iter().map(|check| check.passed).collect::<Vec<_>>(),
            [true, false, false]
        );
    }

    #[test]
    fn duplicate_missing_and_extraneous_evidence_cannot_pass() {
        assert!(grade(r#"{"cases":[{"id":"discount","bugLine":3},{"id":"clamp"},{"id":"contains","bugLine":2}]}"#).is_err());
        assert!(grade(r#"{"cases":[{"id":"discount","bugLine":3},{"id":"discount","bugLine":3},{"id":"contains","bugLine":2}]}"#).is_err());
        assert!(grade(r#"{"cases":[],"score":100}"#).is_err());
    }

    #[test]
    fn runtime_errors_are_not_tools_but_any_tool_evidence_invalidates_trial() {
        assert!(!tool_activity(
            "{\"item\":{\"type\":\"error\"}}\n{\"item\":{\"type\":\"agent_message\"}}\n"
        ));
        assert!(tool_activity("{\"item\":{\"type\":\"file_change\"}}\n"));
        assert!(tool_activity("{\"item\":{\"type\":\"mcp_tool_call\"}}\n"));
    }

    #[test]
    fn final_transcript_is_rechecked_after_exit_before_grading() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("events.jsonl"),
            "{\"item\":{\"type\":\"file_change\"}}\n",
        )
        .unwrap();
        std::fs::write(workspace.path().join("stderr.log"), "").unwrap();
        std::fs::write(workspace.path().join("answer.json"), r#"{"cases":[{"id":"discount","bugLine":3},{"id":"clamp","bugLine":null},{"id":"contains","bugLine":2}]}"#).unwrap();
        assert!(final_evidence(workspace.path()).is_err());
        std::fs::write(workspace.path().join("events.jsonl"), "").unwrap();
        assert!(final_evidence(workspace.path())
            .unwrap()
            .iter()
            .all(|check| check.passed));
        std::fs::write(
            workspace.path().join("stderr.log"),
            vec![b'x'; MAX_OUTPUT as usize + 1],
        )
        .unwrap();
        assert!(final_evidence(workspace.path()).is_err());
    }

    #[test]
    fn global_context_fingerprint_detects_changes_without_retaining_content() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(inherited_instructions_digest(root.path()).unwrap(), None);
        std::fs::write(root.path().join("AGENTS.md"), "first context").unwrap();
        let first = inherited_instructions_digest(root.path()).unwrap();
        std::fs::write(root.path().join("AGENTS.md"), "second context").unwrap();
        assert_ne!(first, inherited_instructions_digest(root.path()).unwrap());
    }

    #[test]
    #[cfg(any(windows, target_os = "linux"))]
    fn supervisor_stops_process_while_control_thread_is_blocked() {
        #[cfg(windows)]
        let mut process = {
            let mut value = command(std::ffi::OsStr::new("powershell.exe"));
            value.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 10",
            ]);
            value
        };
        #[cfg(target_os = "linux")]
        let mut process = {
            let mut value = command(std::ffi::OsStr::new("sleep"));
            value.arg("10");
            value
        };
        let mut child = process
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let _guard = guard(&mut child).unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let cancelled = AtomicBool::new(false);
        let started = Instant::now();
        thread::scope(|scope| {
            let handle = scope.spawn(|| {
                let outcome = supervise(
                    &mut child,
                    workspace.path(),
                    started + Duration::from_millis(150),
                    &cancelled,
                );
                (outcome, started.elapsed())
            });
            // Represents synchronous control-plane I/O on the caller. The supervisor must not wait.
            thread::sleep(Duration::from_millis(1000));
            let (outcome, elapsed) = handle.join().unwrap();
            assert!(matches!(
                outcome,
                ProcessOutcome::Stopped(EvaluationVariantStatus::TimedOut, _)
            ));
            assert!(elapsed < Duration::from_millis(800));
        });
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn skill_context_is_exact_bounded_and_never_silently_omits_other_targets() {
        let temp = tempfile::tempdir().unwrap();
        let cache = ArtifactCache::new(temp.path().join("cache"));
        let source = temp.path().join("skill");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "Check arithmetic carefully").unwrap();
        let digest = ahm_domain::Digest::new(format!(
            "sha256:{}",
            crate::content_hash::hash_dir(&source).unwrap()
        ))
        .unwrap();
        cache.snapshot(&source, &digest).unwrap();
        let mut revision = PortableSetupRevision {
            setup_id: Identifier::new("setup").unwrap(),
            setup_revision_id: Identifier::new("revision").unwrap(),
            revision_number: 1,
            items: vec![ahm_domain::PortableSetupRevisionItem {
                artifact_id: Identifier::new("skill").unwrap(),
                artifact_kind: ahm_domain::DiscoveryKind::Skill,
                portable_source: None,
                content_digest: digest,
                tool_id: Identifier::new("codex").unwrap(),
                target_name: Identifier::new("review").unwrap(),
            }],
        };
        assert!(instructions(&cache, &revision)
            .unwrap()
            .contains("Check arithmetic carefully"));
        revision.items[0].tool_id = Identifier::new("another-agent").unwrap();
        assert!(instructions(&cache, &revision).is_err());
    }
}
