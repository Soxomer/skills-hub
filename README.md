# Agent Harness Manager

Agent Harness Manager brings the Skills Hub library to the browser and applies reusable AI-agent Setups to project checkouts through a local `ahm` runner.

The default page restores My Skills, the online catalogue and search, **SKILL.md preview before installation**, Git/local imports, tags, tool synchronization, updates, and settings. **Projects & runner** opens the project and Setup workflows. No Tauri application is required.

The browser owns the product experience and shared desired state. The runner owns machine paths, local caches, filesystem planning, linking/copying, rollback, and durable delivery. All runtime traffic is initiated by the runner over HTTP; the control plane sends versioned declarative jobs, never shell commands or absolute paths.

## Repository

```text
apps/web/                 React browser application
apps/control-plane/       Fastify API and PostgreSQL persistence
packages/contracts/       Shared TypeScript protocol contracts
crates/ahm-domain/        Portable Rust protocol types
crates/ahm-runner/        Local worker, CLI, SQLite, and filesystem adapters
```

## Prerequisites

- Node.js 20 or newer
- Rust stable
- PostgreSQL 16 or newer for the control plane

## Development

Install dependencies and build every supported runtime:

```bash
npm install
npm run build
```

Configure the environment from `.env.example`, then start the control plane and web application in separate terminals:

```bash
npm run dev:control-plane
npm run dev
```

The web application runs on `http://localhost:5173` and proxies `/api` to the control plane at `http://127.0.0.1:8787` by default.

## Install and connect the runner

For a local source installation:

```bash
cargo install --path crates/ahm-runner --locked
```

In **Projects & runner**, generate a single-use connection command and run it on your computer. Keep the worker running to manage the library:

```bash
ahm connect <single-use-code> --server https://hub.example.com
ahm worker
```

Browsing the public catalogue and previewing a skill do not require a connected runner. Importing, reading installed files, synchronizing, and updating skills use the runner; they do not require a registered project. The folder picker browses runner locations using opaque references, so machine paths stay on that computer.

For project Setups, also register the checkout with `ahm project connect <logical-project-id> --project /path/to/checkout`.

The connection code expires after ten minutes and is used only for enrollment. An approved Setup filesystem change must be claimed by an online worker within 30 seconds, so interactive Apply and Rollback either start immediately or ask for a fresh plan.

Optional GitHub credentials stay on the runner: use `ahm skill github-token` and enter the token locally. Scheduled skill updates run while `ahm worker` is running. Web application updates reload the deployed web build.

See [the restoration and verification record](docs/SKILLS-HUB-WEB-RESTORATION.md) for the restored baseline and runtime boundaries.

For an unattended workstation, run `ahm worker` with the operating system's normal user-service manager. Restart it on failure and after login; do not run it as an elevated or system-wide service unless the managed projects require that ownership.

For isolated acceptance testing, use explicit `--db` and `--runner-state` paths and `ahm worker --home <fixture-home>`. The home override controls discovery and the artifact cache; it does not change the process home or relocate registered project paths. Omit it for normal use.

## Recovery model

- PostgreSQL durably stores desired Setup revisions, approvals, runner jobs, and portable receipts.
- Runner SQLite durably stores the claimed-job inbox, local operation journal, and pending result outbox.
- The browser shows runner offline/revoked states, desired versus last materialized Setup, drift/conflicts, partial failures, and recent apply/rollback activity.
- A normal failure is retried or replanned in the browser. A partial filesystem failure shows the local `ahm rollback` recovery command; database editing is never required.

## CLI

Run `ahm --help` for the complete command list. Useful local administration commands include:

```bash
ahm scan
ahm status
ahm plan
ahm sync
ahm rollback
```

The CLI and remote worker use the same execution service and adapter registry. Supported agent tools are defined in `crates/ahm-runner/src/tool_adapters/mod.rs`.

## Quality gate

Hosting configuration and verification: [Deployment guide](docs/DEPLOYMENT.md).

```bash
npm run check
```

This validates dependency boundaries, lint, TypeScript tests and builds, Rust formatting, Clippy, and the complete Rust test suite.

## Architecture decisions

- [Workspace boundaries](docs/architecture/WORKSPACE-BOUNDARIES.md)
- [Web/control-plane/runner cutover](docs/WEB-CONTROL-PLANE-RUNNER-PLAN.md)
- [Control-plane durability decision](docs/architecture/CONTROL-PLANE-DURABILITY-DECISION.md)

## License

MIT License — see `LICENSE`.
