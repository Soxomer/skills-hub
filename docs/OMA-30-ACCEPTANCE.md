# OMA-30 acceptance evidence

This document records the repeatable, connected acceptance exercise for Setup switching. It is intentionally scoped to disposable local data.

## Repeatable connected flow

1. Start a clean, isolated PostgreSQL database, seed the local development actor's organization and user, and run the control plane with its `DATABASE_URL` pointed at that database. Reset incompatible POC data instead of carrying it through compatibility migrations.
2. Start `npm run dev:web` and a local `ahm worker` with disposable runner SQLite state.
   Supply `--home <fixture-home>` to the worker and create the fixture tool's detection directory (for Codex, `<fixture-home>/.codex`). Use fresh project trees for every run, not only fresh databases.
3. Enroll one runner, then open a second browser tab. Confirm both tabs show the same device and the same active operation.
4. Create two projects with distinct initial skills and capture one Default revision for each. Confirm a project's revision picker includes only its own Default plus organization custom Setups.
5. In the browser, open `New Setup`, name it, select capabilities from the captured revisions, and create revision 1. Do not seed Setup rows directly. Confirm the new custom revision appears in both projects' normal Setup picker.
6. For each project, select the new Setup, prepare and approve the exact plan, then use `Rollback` and `Use Default`. Confirm the final desired and last-verified revisions are that project's Default.
7. Stop the worker after queuing a plan and cancel it in the second tab. Confirm the cancellation receipt says no local changes were made.
8. After reviewing a plan, create an unmanaged target at one planned destination before approval. Applying the old digest must return `planDigestMismatch`; the fresh plan must report the unmanaged conflict and require a new approval after it is resolved.
9. Check PostgreSQL `operation_receipts` and `project_assignments`, runner SQLite `materializations` and `operation_journal`, and the project trees. Receipts, assignments, materializations, and retained unrelated files must agree.

## 2026-09-08 evidence

- Project A and Project B each completed `Default -> OMA-30 Alternate -> Default` against the same enrolled runner. The final receipt IDs were `b876039d-1c0a-4e8d-a155-55afb2df335f` and `c01fdcd5-94c3-4190-8593-080544219c38`; both were `noChange` because their original Default content was already present and safely adopted.
- The browser proved one server-authoritative operation: the second tab observed the first tab's queued operation, and cancellation produced a `jobCancelled` result before any filesystem write.
- A reviewed plan was deliberately made stale by adding an unmanaged destination. The runner rejected the old digest with `planDigestMismatch`; the fresh plan reported the conflict, and a separately reviewed plan was then applied and rolled back.
- `UNMANAGED-A.txt` and `UNMANAGED-B.txt` remained after switching. PostgreSQL assignments matched the two defaults; runner SQLite materializations were `applied` for the same defaults. The apply/rollback history is recorded in the durable receipts and operation journal.
- On Windows, `cargo test -p ahm-runner sync_engine::tests:: -- --nocapture` passed the junction-preservation and hybrid link/copy tests. `cargo test -p ahm-runner recovery_tests:: -- --nocapture` passed both injected post-mutation cancellation restoration and restart recovery tests.
- This Windows workspace has no Linux or macOS runner/target installed (`rustup target list --installed` contains only `x86_64-pc-windows-msvc`). The Unix symlink test remains platform-gated and must be executed on Linux and macOS before OMA-30 can be marked Done.
- The original connected run used a pre-seeded alternate Setup. OMA-113 replaces that setup-only shortcut; repeat the flow above through `New Setup` before treating the browser creation step as connected acceptance evidence.
- OMA-113 assumes a clean POC database. Migration 0007 establishes case-insensitive Setup-name uniqueness directly and intentionally fails when old data violates that invariant; no legacy reconciliation path is part of the acceptance surface.

## Follow-up connected run: discoveries

The independent Setups page was exercised against a live local API, PostgreSQL 16,
and an enrolled Windows worker. Both Defaults and a reusable Setup were created
through browser controls, without seeding Setup rows. Apply and rollback were
observed in durable runner job state. The initial attempts are **not** a completed
acceptance pass: they exposed the following issues and test-harness corrections.

- Concurrent worker/CLI startup against a new SQLite database could attempt the
  same column migration twice. Commit `211cf05` serializes schema initialization
  and tests both concurrency and rollback on migration failure.
- OMA-124: rollback removed pre-existing identical skill content after Apply
  adopted it. The apply snapshot only recorded previously managed targets.
  This was reproduced solely in disposable fixtures; do not count a successful
  rollback receipt alone as proof that the original tree survived.
- Browser automation must wait for the app's post-operation transition and use
  `Prepare another plan` before starting the next operation. A no-change receipt
  does not necessarily offer Rollback. Earlier locator timeouts were harness
  errors, not failed runner jobs.

Acceptance now checks original skill bytes immediately after Rollback, in
addition to unrelated files and the final Default assignment. Disposable run
databases and local evidence remain under the task's isolated acceptance scope.

## Post-fix connected evidence

After the OMA-124 fix, the complete two-project browser creation/apply/reload/
rollback/Default sequence passed with fresh fixture trees on Windows. The live
database is `ahm_connected_1788904599944`; local evidence is retained in ignored
`.oma30-acceptance/connected/run-1788904599753/`.

- Browser-created `Connected combined Setup` has two items and revision
  `revision_26375b04-2437-4261-bfa9-92f3c1c09c59`.
- Both projects completed Apply, browser reload, durable Rollback, and explicit
  Use Default with separately approved plans. Original skill bytes were checked
  immediately after rollback; both unrelated files survived.
- PostgreSQL confirms four successful apply jobs, two successful rollback jobs,
  six successful plan jobs, and two successful scans. Both final assignments
  point to their own project's Default revision 1.
- Runner SQLite agrees: both custom materializations are `rolledBack`, both
  Default materializations are `applied`, and all journal jobs succeeded.
- Browser page-error collection was empty. No real user projects or home skill
  content were used. Test servers and workers were stopped after the run.
- Four regression tests additionally cover original-directory preservation,
  readoption, modified-content conflicts, cancellation, and interrupted-rollback
  restart recovery. The new required snapshot ownership field deliberately
  changes local POC operation JSON: use fresh disposable state rather than
  attempting to roll back operations recorded by an older build.

This closes the previously missing **browser-created Setup** acceptance slice.
It does not rerun the older multi-tab cancellation and stale-plan scenarios, or
prove hosted macOS/Linux execution. OMA-30/122 remain open for those outstanding
verification boundaries; the CI matrix is configured but no hosted run was
returned by the GitHub Actions query at handoff.

Final local gate: `npm run check` passed with 125 TypeScript tests and 96 Rust
tests, plus all builds, lint, version/boundary checks, rustfmt, and Clippy.
