# Workspace boundaries

The product has three runtime boundaries and two portable contract packages:

| Boundary | Responsibility | May depend on |
| --- | --- | --- |
| Web application | Browser product experience | Contracts and browser libraries |
| Control plane | Shared desired state, authorization, jobs, approvals, receipts, and audit history | Contracts, PostgreSQL, hosted-service libraries |
| Local runner and CLI | Discovery, planning, application, rollback, recovery, local persistence, and adapters | Portable Rust domain and local libraries |
| TypeScript contracts | Protocol types and golden fixtures | No product runtime |
| Rust domain | Portable protocol types | Serialization only |

## Source layout

```text
apps/
  web/                 browser application
  control-plane/       hosted API and runner-job transport
packages/
  contracts/           TypeScript protocol types and fixtures
crates/
  ahm-domain/          portable Rust protocol types
  ahm-runner/          headless worker, CLI, SQLite, and filesystem adapters
```

`npm run boundary:check` rejects removed application surfaces, native-runtime packages, forbidden dependency directions, and device-local path columns in control-plane persistence.

## Protocol behavior

- Jobs contain identifiers and declarative payloads, never shell commands or server-provided absolute paths.
- The runner resolves `ProjectInstanceId` to a local path outside the protocol.
- Every mutating job carries an idempotency key.
- Planning returns a digest; Apply requires an approval bound to that digest.
- Interactive Apply and Rollback jobs must be claimed within 30 seconds. Enrollment codes have an independent ten-minute lifetime.
- JSON objects are strict and protocol `1.0` is the only supported version.
- Plan destinations are project-relative and reject drive-qualified, rooted, and parent-traversing paths.

## Persistence ownership

| Control-plane PostgreSQL | Runner SQLite |
| --- | --- |
| Organizations, users, membership | Device credential |
| Logical projects | `ProjectInstanceId` to absolute checkout path |
| Setups, immutable revisions, assignments | Scan cache and artifact cache |
| Runner jobs and digest-bound approvals | Claimed-job inbox and lease acknowledgement |
| Portable receipts and audit events | Operation/rollback journal and result outbox |

The databases are not replicated. PostgreSQL is the durable server outbox; the runner commits a claim before acknowledging it, executes locally, commits the result before delivery, and keeps retrying until PostgreSQL acknowledges the receipt.

## Recovery surface

The control plane derives browser-visible operation history and materialization health from durable jobs, receipts, assignments, and the latest plan result. The browser exposes offline/revoked states, drift/conflicts, manual-intervention failures, rollback, and fresh-plan recovery without requiring database access.
