# Web Control Plane and Local Runner — Implementation Plan

Status: tickets 1–7 complete; remote scan and Default review are next

Last updated: 2026-09-01

## 1. Outcome

Move Agent Harness Manager from a Tauri-centered application to a hosted web
control plane connected to a constrained local `ahm` runner.

The milestone is complete when a user can open the web application, connect a
runner, select a registered project, request a scan, review the project's
Default Setup, preview a Setup change, approve it, and receive a verified apply
receipt from the runner.

The browser never writes directly to the workstation. The control plane never
sends arbitrary shell commands or absolute filesystem paths.

## 2. Product boundary

| Component | Source of truth for |
| --- | --- |
| Web application | Catalog, Setup, Project, runner, plan-review, and operation-result experiences |
| Control-plane API | Organizations, users, projects, Setup revisions, project assignments, policies, jobs, approvals, and audit history |
| PostgreSQL | Shared relational control-plane state |
| Content store | Immutable plugin and skill snapshots, variant content, patches, and large evaluation artifacts |
| `ahm` runner | Device enrollment, project-path resolution, scan, local planning, apply, rollback, and reporting |
| Runner SQLite | Device-local project mappings, materialization ownership, operation journal, scan cache, and pending result delivery |
| Versioned protocol | Commands, events, plans, receipts, errors, compatibility rules, and idempotency semantics shared by server and runner |

The current SQLite database must be divided by ownership. Organization-visible
Setup and assignment records move to the control plane. Machine paths,
materializations, and recovery state remain local. The two databases are not
replicated; they communicate through the protocol.

## 3. Repository target

```text
apps/
  web/                    React and Vite web application
  control-plane/          TypeScript HTTP API

packages/
  contracts/              OpenAPI or JSON Schema contracts and fixtures

crates/
  ahm-domain/             Portable identifiers, desired-state and protocol types
  ahm-runner/             CLI, local SQLite and filesystem execution

legacy/
  desktop/                Temporary migration input; deleted after web cutover
```

The physical move should be incremental. Code is extracted behind stable
boundaries and kept passing before the old location is removed. Tauri receives
no new product behavior, no new package may depend on it, and the native shell
is deleted after browser parity is reached.

## 4. Identity model

A logical `Project` is shared by the company. A `ProjectInstance` identifies
that project on one enrolled runner and owns the absolute local path mapping.

```text
Organization
  -> Project
       -> project Default Setup
       -> assigned Setup Revision
       -> ProjectInstance on runner A -> local path A
       -> ProjectInstance on runner B -> local path B
```

The server may assign a Setup Revision to a Project or ProjectInstance, but only
the runner resolves a ProjectInstance to an absolute path. Materialization and
operation receipts always identify the device, ProjectInstance, Setup Revision,
and plan digest that produced them.

## 5. Runner protocol constraints

- The runner enrolls with a one-time code and stores a rotatable device credential.
- All runtime communication is outbound over authenticated HTTPS. Polling is sufficient for the first slice; streaming can be added later.
- Jobs are declarative and use versioned types such as `ScanProject`, `PlanSetup`, `ApplyPlan`, and `RollbackOperation`.
- A remote job may reference only server identifiers and approved configuration. It cannot contain a shell command or an absolute target path.
- The runner validates organization, device, ProjectInstance, protocol version, expected Setup Revision, and job expiry before execution.
- Mutating jobs are idempotent and retain a local operation journal.
- `PlanSetup` returns a canonical plan and digest. `ApplyPlan` must reference that digest so approval cannot be reused for a different plan.
- Results are safe to retry and include structured failures and recoverability status.

## 6. Delivery increments

Each increment ends in something demonstrable and keeps the next increment
optional until its boundary is proven.

### Increment A — Extract the boundary

Create the workspace, split portable contracts from local execution, and keep
the existing CLI behavior passing. No networking is required yet.

Demo: the standalone runner executes the existing per-project Default scan and
tests without linking to Tauri.

### Increment B — Read-only web-to-runner slice

Add the control-plane API, runner enrollment, ProjectInstance registration, job
claiming, and scan-result reporting.

Demo: the browser requests a scan and displays discoveries returned by an
enrolled runner.

### Increment C — Controlled Setup switching

Move shared Setup revisions and assignments to the control plane. Add remote
plan, explicit approval, apply-by-plan-digest, receipt reporting, and manual
Use Default Setup.

Demo: the browser switches a disposable project to another Setup and back to
its project Default without losing unmanaged content.

### Increment D — Web cutover

Move the remaining useful React screens behind the web API, add drift and
offline states, and delete the Tauri/native application and packaging.

Demo: all milestone flows work in a normal browser with the runner installed.

## 7. Build tickets

- [x] **1. Checkpoint the current local vertical slice**
  Roadmap ref: Phase 1 — Default Setup and reliable manual switching.
  What to build: Preserve the currently passing per-project Default scan, capture, plan, sync, and rollback behavior as the baseline for extraction.
  Acceptance: Two temporary projects retain independent Default Setups and the complete current check suite passes.
  Verify: `npm run check`.

- [x] **2. Create web, control-plane, contracts, and Rust workspace boundaries**
  Roadmap ref: Architecture boundaries.
  What to build: Introduce the target directories and build orchestration without changing behavior. Quarantine the Tauri shell as disposable migration input with no imports from new packages.
  Acceptance: Web, API, contracts, runner, and legacy desktop targets build independently from the repository root.
  Verify: Root build commands plus a clean dependency-boundary check.

- [x] **3. Publish protocol version 1 and golden fixtures**
  Roadmap ref: Runner protocol constraints.
  What to build: Define identifiers, job envelopes, scan results, plans, approvals, receipts, errors, capability negotiation, idempotency keys, and protocol versions.
  Acceptance: TypeScript and Rust parse and serialize the same golden fixtures; unknown fields and unsupported versions have defined behavior.
  Verify: Contract tests in both runtimes.

- [x] **4. Split shared and device-local persistence**
  Roadmap ref: Product boundary.
  What to build: Add PostgreSQL control-plane migrations for organization-visible records and narrow runner SQLite to local mappings, ownership, journal, and delivery state.
  Acceptance: No absolute project or agent path is stored in PostgreSQL; no organization authorization decision depends on runner SQLite.
  Verify: Migration tests, schema inspection, and persistence boundary tests.

- [x] **5. Extract the standalone runner**
  Roadmap ref: Increment A.
  What to build: Move scanning, planning, application, rollback, adapters, and local journal behind the runner interface. Preserve CLI commands for local administration.
  Acceptance: The runner has no Tauri dependency and all filesystem mutations pass through the same execution service.
  Verify: Rust tests plus CLI integration tests in temporary directories.

- [x] **6. Add enrollment and outbound job transport**
  Roadmap ref: Increment B.
  What to build: Implement one-time enrollment, device credentials, capability reporting, job claim, lease, result retry, expiry, and cancellation behavior.
  Acceptance: A runner can reconnect without duplicating an operation; the server cannot request an arbitrary command or path.
  Verify: API/runner integration tests covering disconnect, retry, duplicate delivery, expiry, and revoked credentials.

- [x] **7. Add browser runner connection and status UX**
  Roadmap ref: Increment B and web cutover.
  What to build: Add a typed control-plane client, single-use connection command, runner health and recovery states, ProjectInstance registration guidance, and English/Chinese browser UI.
  Acceptance: The web application loads in a normal browser, reflects waiting, connected, offline, expired, and revoked states, and contains no Tauri runtime dependency.
  Verify: Frontend unit tests, production build, and a browser smoke test.

- [x] **8. Deliver the remote scan and Default review slice**
  Roadmap ref: Increment B.
  What to build: Let the web UI register a ProjectInstance, request a scan, display discoveries and conflicts, and capture the accepted project Default revision through the control plane.
  Acceptance: The server stores portable Default content and provenance while local absolute paths remain runner-only.
  Verify: End-to-end test using a temporary project and runner database.

- [x] **9. Deliver plan, approval, apply, and Use Default**
  Roadmap ref: Increment C.
  What to build: Assign an exact Setup Revision, request a local plan, approve its digest, apply it, report ownership and receipt data, and manually select the project's Default.
  Acceptance: Changed or expired plans cannot be applied; unmanaged content is preserved; repeated delivery is idempotent.
  Verify: Browser-to-runner end-to-end test across two independent projects.

- [ ] **10. Complete cutover, delete the native app, and finish recovery UX**
  Roadmap ref: Increment D.
  What to build: Add runner offline, drift, partial failure, recovery, credential revocation, and operation-history experiences; remove Tauri, the native shell, and its packaging.
  Acceptance: Users can understand whether desired and materialized state match and can recover without direct database manipulation.
  Verify: Failure-injection tests and manual browser walkthrough.

## 8. Explicit deferrals

The split does not require company SSO, billing, dynamic evaluations, plugin
variants, AI remediation, real-time WebSockets, Kubernetes deployment, or a
general remote-command framework. Their schemas may be anticipated, but they
must not expand this milestone.

## 9. First handoff

Tickets 1–7 preserve the passing baseline, establish the workspace boundaries,
share protocol fixtures between TypeScript and Rust, separate shared PostgreSQL
state from runner-local SQLite state, and move scan, plan, apply, rollback,
adapters, recovery primitives, and the `ahm` CLI into `ahm-runner`. The legacy
desktop now consumes runner-owned modules through thin path-resolution wrappers.
Runner enrollment and outbound job transport now use protocol-v1 held HTTPS claims.
The runner stores its device credential, project paths, operation journal, and
pending result outbox locally; PostgreSQL stores enrollment, capability, lease,
cancellation, and portable result state. The browser now provides typed runner
enrollment, health, recovery, and ProjectInstance guidance. Remote execution
carries portable immutable Setup snapshots, content-addressed artifact bundles,
digest-bound approval, apply receipts, and rollback through the same declarative
protocol. PostgreSQL is the durable job outbox; the runner persists a leased job
before acknowledging it and persists every result before delivery.

## 10. Runner transport operations

The control plane starts from `apps/control-plane` with `DATABASE_URL` and an
optional `PUBLIC_SERVER_URL`; startup applies pending PostgreSQL migrations.
The intended runner journey is:

```text
ahm connect <single-use-code> --server https://hub.example.com
ahm project connect <logical-project-id> --project /path/to/checkout
ahm worker
```

`AHM_RUNNER_STATE` can override the device-local SQLite location. Credentials
are never printed after enrollment, the server stores only their SHA-256 hash,
and revocation immediately rejects subsequent claims and result delivery.
Loopback HTTP is supported for development; other runner endpoints require
HTTPS. The worker holds one outbound claim at a time for immediate dispatch and
retries its durable result outbox after a disconnect without re-executing a
completed job.
