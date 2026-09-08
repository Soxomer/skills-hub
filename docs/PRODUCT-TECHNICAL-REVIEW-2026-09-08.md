# Product and technical review — 2026-09-08

Recommendation: finish the reliability of the existing switching flow, then make Setups independently manageable. Preserve the web / PostgreSQL control plane / local runner split. Plugin provenance and evaluations remain valuable, but depend on trustworthy artifact identity and a usable revision lifecycle.

## Follow-up cards and implementation

The schema simplification was subsequently completed in `2796c04`. The failing test result below is historical evidence from the review snapshot, not the final implementation status.

| Linear card | Follow-up |
| --- | --- |
| [OMA-115](https://linear.app/omar-os/issue/OMA-115) | Canonical Rust/TypeScript artifact identity and server-side verification; implemented with shared golden data and rejection tests. |
| [OMA-116](https://linear.app/omar-os/issue/OMA-116) | Permanent artifact failures become durable terminal errors; transient transport errors remain retryable. |
| [OMA-117](https://linear.app/omar-os/issue/OMA-117) | Transaction-bound runner-management authorization and loopback-only development startup. Full browser sessions remain OMA-114. |
| [OMA-118](https://linear.app/omar-os/issue/OMA-118) | Stale onboarding responses ignored after context changes, covered by interaction tests. |
| [OMA-119](https://linear.app/omar-os/issue/OMA-119) | Eligible rollback recovered from durable operation history after reload. |
| [OMA-120](https://linear.app/omar-os/issue/OMA-120) | Backlog: assignment ordering across multiple checkouts. |
| [OMA-121](https://linear.app/omar-os/issue/OMA-121) | Backlog: explicit, selection-aware artifact publication. |
| [OMA-122](https://linear.app/omar-os/issue/OMA-122) | Backlog: real PostgreSQL and cross-platform connected recovery verification. |
| [OMA-123](https://linear.app/omar-os/issue/OMA-123) | Backlog under OMA-35: independent Setups browsing and immutable revision editing. |

Existing OMA-31, OMA-33, and OMA-34 retain catalog provenance, static preflight, and evaluation work. No duplicate cards were created for those areas or hosted authentication (OMA-114).

Digest identity changed deliberately: recreate disposable POC snapshots/plans with fresh state; see `docs/architecture/ARTIFACT-IDENTITY.md`. No user data is automatically removed. Authorization added here covers runner management; the POC still uses development identity headers and is not ready for shared hosting.

Final implementation verification: `npm run check` passed on Windows, including 111 TypeScript tests, 89 Rust tests, all production builds, lint, boundary/version checks, rustfmt, and Clippy. This includes shared digest fixtures, permanent/transient artifact failure tests, authorization tests, and 12 browser interaction tests. Real PostgreSQL concurrency, connected browser/runner acceptance, and macOS/Linux execution remain explicit OMA-122/OMA-30 follow-ups.

## Scope and evidence

Reviewed the repository's product roadmap, runtime boundaries, durability decision, acceptance record, and implementation paths through browser onboarding, composition, API authorization, job delivery, artifact storage, assignment, and runner execution/recovery. A second agent independently reviewed product and UX. The documentation supplied sufficient product intent; older conversations were unnecessary.

This is a targeted static review across the codebase, not a claim that every line or runtime scenario was exhaustively verified. No product code was changed. References below are repository-relative paths with one-based lines as reviewed.

Baseline HEAD: `f32d312759fbe541a040648f3684c94d81d4be56`, plus existing uncommitted changes. The current `npm run test` result was **64 passed, 7 failed**. Migration 0007 now creates a unique index instead of `setup_name_claims`, while the PostgreSQL Setup repository and tests still reference that table. This is an incomplete working-tree change, not a newly discovered defect in the committed baseline. Finish it before using this checkout for acceptance. The earlier green check applies to the earlier tree.

Small isolated service probes confirmed that an arbitrary claimed artifact digest reaches storage, and cancellation/revocation perform no membership lookup. These probes used the existing compiled transport service with a stub repository; they were not live-server penetration tests. No connected browser/runner acceptance run was performed.

## Concrete findings

### 1. P1: artifact identity is neither portable nor unambiguous

`crates/ahm-runner/src/content_hash.rs:14` hashes an unsorted directory traversal, uses OS-native path text, and concatenates path and file content without lengths or type boundaries. Identical nested trees therefore hash differently across Windows and Unix; traversal order can also change identity. More fundamentally, a file named `a` containing `bc` and one named `ab` containing `c` both contribute the same bytes, `abc`. This is an encoding collision, not a SHA-256 weakness.

The digest controls cache identity and verification (`artifact_cache.rs:40`), so this affects reproducible Setup content. Define one sorted, portable manifest encoding with entry types, framed paths/content, and an explicit metadata policy. Test reordered creation, nested cross-platform paths, and ambiguous path/content pairs. The POC policy permits a clean cache/database reset rather than compatibility machinery.

### 2. P1: permanent artifact failures can trap a runner on one job

`crates/ahm-runner/src/worker.rs:162` publishes scan artifacts before `finish_job`. Upload/bundle errors propagate out without a terminal result. For example, a scanned directory can snapshot successfully but later fail the 10 MiB bundle limit (`artifact_cache.rs:101`). The server returns the acknowledged job again (`apps/control-plane/src/runner-transport-pg.ts:584`), so subsequent cycles repeat it and later jobs can be starved until cancellation or intervention.

Persist a terminal, actionable result for permanent validation/size failures; retain bounded retry semantics for transient transport failures. Acceptance: scan an oversized artifact, observe a useful failure, then successfully process the next queued job without restarting the runner.

### 3. P1 before shared hosting: actor identity and transport authorization are incomplete

`apps/control-plane/src/http.ts:30` accepts user and organization identity directly from request headers. Separately, transport actions including scan, cancellation, and revocation use organization IDs without membership/role checks (`runner-transport.ts:399`, `565`, `577`). Setup and project services have membership checks, so permissions are inconsistent even after a real identity layer is introduced.

Keep this explicit as a prototype limitation. Before exposing the service to other users, derive the actor from authenticated identity and enforce one action-specific authorization policy across all browser endpoints. Test viewers, removed members, cross-organization requests, and forged headers. A trusted proxy is only sufficient if it authenticates and replaces client-supplied identity headers.

### 4. P1: the shared cache accepts an unverified digest claim

`apps/control-plane/src/runner-transport.ts:173` validates bundle shape and size, but never computes the claimed content digest. `runner-transport-pg.ts:524` stores the first upload for that digest and silently ignores later uploads. A buggy or compromised enrolled runner can occupy a valid digest with invalid bytes; recipients reject those bytes locally, but a correct re-upload does not repair the shared entry.

Use the canonical identity definition from finding 1 to verify before publication, and reject conflicting content explicitly. Local verification prevents silent installation of mismatching bytes; it does not prevent this availability failure. Acceptance: a bundle with the wrong digest is rejected before persistence, and a subsequent correct upload succeeds.

### 5. P2: delayed onboarding responses can update another project's screen

`apps/web/src/useProjectScan.ts:134`, `202`, and `259` apply asynchronous results without checking the active project context. The project selector remains available (`components/ProjectScanWorkspace.tsx:110`). Starting capture for A and selecting B before completion lets A's response populate `capture`; the screen prefers it when determining whether B has a Default (`:43`).

Use context and request-generation guards, as the switching hook already does. Test delayed scan and capture responses while switching A → B. No response for A should mark B captured or replace B's discoveries.

### 6. P2: refreshing removes the browser's rollback action

Rollback is offered only from transient `workflow.receipt` (`components/ProjectSwitchWorkspace.tsx:224`). `useSetupSwitch.ts:466` also requires that receipt. Reloading or opening another tab loads operation summaries but does not restore the actionable receipt; history at `ProjectSwitchWorkspace.tsx:751` has no recovery action.

Expose server-authoritative operation detail and available recovery actions. Acceptance: apply, refresh, open the durable operation, and roll back when still permitted. Do not merely enable rollback for every old receipt: eligibility must reflect later operations and current ownership.

## Architectural decisions needed soon

- **One desired assignment, multiple checkouts:** operation serialization is per project instance (`migrations/0005_project_operation_singleflight.sql:3`), but successful receipts overwrite a logical project's assignment (`runner-transport-pg.ts:198`, `250`). Different machines can apply different revisions and whichever receipt arrives last sets desired state for all instances. Before advertising multi-machine project support, define project-level assignment ordering or compare-and-set semantics, while retaining per-instance observed materialization. Test concurrent and delayed receipts, including rollback on another instance.
- **Content-sharing boundary:** scans upload all available discovered artifact contents before the user selects the Default composition (`worker.rs:219`). This can include unselected local content. Make the upload behavior explicit and decide whether shared publication should follow selection. This is a real current behavior requiring a product/privacy decision, not a claim that a secret was observed.
- **Test the actual durability substrate:** control-plane repository tests use `pg-mem`, and runner CI runs only Ubuntu (`.github/workflows/ci.yml`). Retain fast tests, but add real PostgreSQL transaction/locking tests and Windows/macOS runner coverage. The current mocks cannot establish concurrent name claims, transaction rollback, and platform portability by themselves.

## Recommended delivery roadmap

| Order | Slice | Observable completion |
| --- | --- | --- |
| 0 | Finish current schema simplification | Repository, schema, and tests agree; full check green on one recorded commit. |
| 1 | Trustworthy artifacts and job completion | Canonical portable hashing, verified shared publication, permanent failure receipts, and a failing job cannot starve later work. |
| 2 | Reliable browser recovery | Project-context guards; durable rollback/detail actions; browser-created Setup applied to two projects and returned to Default; reload, cancellation, stale-plan, and platform cases verified. |
| 3 | First-class Setups workspace | Independent Projects/Setups navigation; browse without an online runner; inspect captured contents and project usage; clone/edit publishes v2 while existing assignments stay pinned to v1; initial Default retained. |
| 4 | First catalog import and useful preflight | One selected plugin ecosystem plus standalone skills; exact source/ref/digest, readable capabilities/license/privileges, collision and adapter-support findings; import → compose → preview → apply. |
| 5 | Narrow evaluation pilot | One supported agent, one versioned fixture/suite, isolated baseline/candidate runs, exact revisions, and inspectable outcomes. Use the official Codex runtime/subscription route when Codex is the selected harness. |

**Before any shared/hosted pilot:** complete identity and authorization, clarify content publication, and validate assignment ordering if multiple devices can operate on the same logical project. These are release prerequisites, not reasons to stop local POC iteration.

Pull minimal Setup navigation and revision management forward from the roadmap's later productization phase. The present composer only assembles already-captured items and publishes revision 1; independent browsing, readable content, comparison, and revision editing are missing product slices, not regressions in OMA-113.

Defer broad variants/rebase UX, company governance, interaction graphs, and expanded evaluation orchestration until the first catalog and evaluation slices demonstrate value. Keep the existing decision against adding DBOS/Zero without a concrete subsystem they would replace. A broad rewrite is not warranted by this review.

## Source documents

- `docs/AGENT-HARNESS-MANAGER-ROADMAP.md` — accepted product model and phases.
- `docs/WEB-CONTROL-PLANE-RUNNER-PLAN.md` — runtime split and delivery plan.
- `docs/architecture/WORKSPACE-BOUNDARIES.md` — ownership and protocol rules.
- `docs/architecture/CONTROL-PLANE-DURABILITY-DECISION.md` — current durability rationale.
- `docs/UI-DESIGN-GUIDELINES.md` — interaction and visual principles.
- `docs/OMA-30-ACCEPTANCE.md` — connected evidence and explicitly outstanding verification.
- `docs/research/agent-capability-landscape.md` — capability landscape.
