# Harness-aware evaluations: first delivery

## Product scope

This branch adds a deliberately narrow evaluation pilot: compare the root `SKILL.md`
instructions from two exact Setup revisions using one explicitly configured local
Codex profile and a bundled code-review fixture. It is an instruction comparison,
not a benchmark of native skill activation, a user's project, scripts, supporting
files, MCP integrations, or other harnesses.

The question this pilot answers is: **did these two sets of instructions produce
different answers to this small, fixed code-review task under the same requested
Codex configuration?** One trial cannot establish statistical significance or
predict general coding performance. A tie is a useful and valid outcome.

## Journey

1. Open a saved Setup revision and choose evaluation.
2. Choose a different exact baseline revision, a connected evaluation-capable
   runner, a model available to the local Codex login, and a reasoning setting.
3. Review the limited scope and start explicitly. This consumes the user's Codex
   allowance. Each side has a 120-second execution limit.
4. Compare each side's independent fixture checks, duration, and execution status.
5. Applying a Setup remains a separate reviewed action. Evaluation never Applies.

The first fixture contains two faulty JavaScript functions and one correct one.
The runner grades structured line-number answers against fixed expectations;
the model does not grade itself. Invalid or incomplete structured evidence is an
execution failure with no score. The correct function checks for false positives.
The task and grader are versioned together as `code-review-v1`.

## Runtime boundaries

| Boundary | Responsibility |
| --- | --- |
| Browser | Select exact revisions/profile, show scope and prerequisites, start/cancel, inspect history/results. |
| Control plane | Authorize organization membership and device access, resolve immutable revisions and artifact references, persist the declarative job and result, expose scoped history. |
| Runner | Obtain artifacts, validate both sides, prepare private temporary workspaces, invoke the official Codex CLI, enforce local limits, grade evidence, submit portable summaries. |
| Helper | Continue providing pairing and background runner lifecycle. It does not execute evaluations itself. |

The control plane sends no executable paths, shell commands, arbitrary prompts,
grader commands, or workstation paths. The runner owns the fixed fixture and
invocation. It does not read or modify a registered project for this pilot, so
evaluation jobs have `projectInstanceId: null`.

## Protocol and persistence

`evaluateSetups` carries two `PortableSetupRevision` values, a fixed suite ID,
one repetition, and a versioned execution profile. The profile records the harness,
model requested by the user, reasoning setting, sandbox, time limit, and
`contextMode: skillInstructions`.

`evaluationResult` records the requested profile separately from observed runtime
metadata and the two variant results. The observed model remains unknown when the
runtime does not provide trustworthy evidence; requested values are not presented
as observed facts. `nativeSkillActivation: false` makes the scope machine-readable.

The existing PostgreSQL job envelope/result persistence is sufficient for this
bounded feature. No second queue or scheduler is introduced. New runs get new job
IDs; retrying the same request uses its idempotency key. The stored job is the
immutable experiment definition. A richer suite catalog or repeated experiment
aggregation should be introduced only when supported by a concrete next workflow.

Runner SQLite remains a separate local authority. A completed job replays its
durable result through the existing outbox. A previously started evaluation with
no durable result becomes interrupted rather than silently spending allowance on
another run. Users explicitly start a new comparison to retry.

## Authentication, execution, and limitations

Authentication stays with the official Codex CLI and its existing ChatGPT login.
The product does not read, copy, upload, or implement credentials. It does not
require an API key or a provider adapter. `AHM_CODEX_BIN`, when set locally, selects
the installed executable; it is never supplied by a remote job.

Each side receives fresh local scratch storage and supplied skill instructions.
The profile requests read-only execution, disables user configuration and exec
rules, and explicitly disables relevant tool/plugin/hook features. These are
runtime controls; a temporary directory alone is not a security sandbox. Supported
CLI controls are checked before running. Runtime errors must not trigger a fallback
to unrestricted execution.

The pilot currently supports Windows and Linux runners. Windows uses a kill-on-close
job object; Linux uses a parent-death signal so a worker crash cannot leave the CLI
running indefinitely. An independent supervisor enforces deadlines and output limits
even while cancellation checks wait on the network. macOS does not advertise evaluation
support until equivalent process lifetime protection is implemented. Optional tools
are disabled; residual tools such as patching remain subject to read-only permissions.
Observed tool activity invalidates the trial, including events written just before exit.

The installed CLI's global instruction handling is separate from project document
loading. In Codex `rust-v0.155.1`, `project_doc_max_bytes=0` disables project document
reads, but global instructions are loaded by a separate provider. Accordingly,
the pilot must not claim hermetic global-context isolation based on that setting.
The runner records a digest of inherited Codex global instruction files and checks
that it stays unchanged across both sides. It does not upload those files. Global
or administrator instructions may still apply, so `ambientContextVerified: false`
is explicit in every result. The digest supports provenance; it is not proof of
complete runtime isolation or a complete configuration fingerprint.

Raw output may contain instruction content or local diagnostic details. Portable
results contain bounded check summaries and safe errors, not raw traces or local
paths. Full trace retention, export, and configurable retention policies are not
part of this first delivery.

## Test environment prerequisite

The local SQLite operation-kind invariant changes from schema version 3 to 4.
Following the repository's POC policy, older runner databases are rejected rather
than migrated or automatically reset. Test this branch with a separate fresh
runner state and enrollment. Do not point a branch-built runner at the user's
existing installed helper database, and do not delete that database.

No hosted test deployment was configured for this branch: the existing Vercel rewrites
point at the production Railway API. A real preview requires a separate API/database
and fresh enrolled runner. A browser-only preview would not exercise this feature.

For a deliberate real-runtime smoke check, set `AHM_EVAL_SMOKE_MODEL` to a model available
through your ChatGPT login and run `cargo test -p ahm-runner real_codex_pair_smoke -- --ignored --nocapture`.
This explicitly consumes subscription usage, compares an empty baseline with a captured
review skill, and cleans up its scratch workspaces. It is excluded from the unattended gate.
Set `AHM_CODEX_BIN` locally if Codex is not on PATH; Windows also detects the standard
Codex desktop installation. This check does not enroll a device or touch production.

The browser/API and runner must support the same feature. Updating only a hosted
browser does not add evaluation support to an older installed helper.

## Following increments

- Validate this pilot with actual users and representative skill instructions.
- Add repeated, paired runs before making reliability or improvement claims.
- Add executable project fixtures with enforceable process/filesystem/network
  isolation and trustworthy graders before evaluating code changes.
- Add native skill activation with observable configuration, then a second harness
  to test the execution-profile abstraction.
- Add model/harness comparison matrices with explicit confounders rather than
  combining unlike environments into one quality score.

Relevant upstream implementation references:

- [Codex global instruction provider](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/codex-home/src/instructions/mod.rs)
- [Codex project instruction assembly](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/agents_md.rs)
- [Codex configuration schema](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/config.schema.json)
