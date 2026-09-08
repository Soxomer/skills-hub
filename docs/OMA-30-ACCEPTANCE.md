# OMA-30 acceptance evidence

This document records the repeatable, connected acceptance exercise for Setup switching. It is intentionally scoped to disposable local data.

## Repeatable connected flow

1. Start an isolated PostgreSQL database and run the control plane with its `DATABASE_URL` pointed at that database.
2. Start `npm run dev:web` and a local `ahm worker` with disposable runner SQLite state.
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
