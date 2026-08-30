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

Networking, persistence splitting, and UI migration begin only after these
contracts are reviewed.
