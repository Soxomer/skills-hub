# Workspace boundaries

The product is moving to three durable runtime boundaries:

| Boundary | Responsibility | May depend on |
| --- | --- | --- |
| Web application | Browser product experience | Contracts and web-only libraries |
| Control plane | Shared desired state, authorization, jobs, approvals, and audit history | Contracts and hosted-service libraries |
| Local runner and CLI | Device-local discovery, planning, application, rollback, and recovery | Portable domain contracts and local adapters |

The existing root React application and `src-tauri` package are migration input,
not a fourth permanent runtime. They remain buildable while behavior moves to the
web application and runner, then they are deleted. New packages must never import
Tauri or legacy application modules.

## Source layout

```text
apps/
  web/                 browser application boundary
  control-plane/       hosted API boundary; transport is intentionally deferred
packages/
  contracts/           protocol schemas, TypeScript types, and golden fixtures
crates/
  ahm-domain/          portable Rust protocol types
  ahm-runner/          headless worker and CLI boundary
src/ + src-tauri/      temporary legacy desktop implementation
```

`npm run boundary:check` enforces dependency direction. The web, control-plane,
contracts, domain, and runner targets build independently from root commands.

## Protocol v1 behavior

- Jobs contain identifiers and declarative payloads, never shell commands or server-provided absolute paths.
- The runner resolves `ProjectInstanceId` to a local path outside the protocol.
- Every mutating job carries an idempotency key.
- Planning returns a digest; applying requires an approval bound to that digest and an expiry.
- JSON objects are strict. Unknown fields are rejected in TypeScript schema validation and Rust deserialization.
- Version `1.0` is the only supported version. Unsupported versions fail validation; capability negotiation returns no compatible version.
- Plan destinations are project-relative and reject drive-qualified, rooted, and parent-traversing paths.

Persistence ownership is defined below. Networking and UI migration remain
deferred while enrollment and outbound job transport are built.

## Standalone execution ownership

`crates/ahm-runner` owns the `ahm` CLI, discovery scanner, Setup execution
service, filesystem reconciliation planner, apply and rollback behavior, tool
adapters, content hashing, local persistence, and recovery primitives. CLI
scan, plan, sync, and rollback commands enter through `RunnerExecutionService`.

The legacy desktop depends on the runner crate and retains only native app-data
path resolution wrappers for the modules that still serve old screens. The
boundary check rejects native-runtime imports and legacy application imports in
the runner. A real-process CLI integration test exercises scan, plan, apply, and
rollback in temporary home and project directories while preserving unmanaged
content.

## Persistence ownership

| Control-plane PostgreSQL | Runner SQLite |
| --- | --- |
| Organizations, users, and membership | Local device credential |
| Logical projects | `ProjectInstanceId` to absolute checkout path |
| Setups, immutable revisions, and assignments | Scan cache |
| Portable artifact references | Materializations and physical target paths |
| Runner jobs and plan approvals | Operation and rollback journal |
| Portable receipts and audit events | Pending result-delivery outbox |

The control-plane migration is
`apps/control-plane/migrations/0001_control_plane.sql`. Its schema tests execute
the migration and reject every machine-local path column. The runner migration
lives in `crates/ahm-runner/src/state.rs`; its schema tests reject shared Setup,
assignment, approval, and organization tables.

The combined legacy SQLite schema remains local migration input for existing CLI
users. It is not the storage model for the browser product; organization-visible
records use control-plane PostgreSQL, while new worker state uses runner SQLite.
