## ChatGPT subscription access

For local Codex-based projects, Omar prefers to use his existing ChatGPT subscription through the official Codex runtime. Use `@openai/codex-sdk` (or the Codex CLI/app-server interface when appropriate), which reuses the authentication created by `codex login` with ChatGPT.

Do not assume that an OpenAI API key, Vercel AI Gateway, OpenRouter, a custom OAuth implementation, or a custom model/provider adapter is required for this route. OpenAI API usage is a separate metered billing path and should be introduced only when the project explicitly requires or chooses it. An application-owned executor interface may still be used for replaceability, but it is not an authentication or model adapter for the ChatGPT-subscription route.

--- project-doc ---

# Agent Harness Manager — Project Rules

## Product boundary

Agent Harness Manager has three supported runtime boundaries:

- `apps/web`: React browser product experience.
- `apps/control-plane`: Fastify API and shared PostgreSQL state.
- `crates/ahm-runner`: local `ahm` worker/CLI, SQLite state, adapters, and filesystem effects.

`packages/contracts` and `crates/ahm-domain` define the versioned portable protocol. The browser never writes to a workstation directly. The control plane never sends shell commands or absolute paths. The runner initiates transport and is the only component allowed to mutate project files.

## Commands

```bash
npm run dev                 # Browser development server
npm run dev:control-plane   # Build and start the API/migrations
npm run build               # Build every supported runtime
npm run check               # Complete repository gate
npm run lint
npm run test
npm run rust:test
npm run rust:clippy
npm run rust:fmt
npm run version:check
```

Always run `npm run check` before committing.

## Architecture rules

- Web code may depend on `@ahm/contracts`, browser libraries, and typed API clients only.
- The control plane owns organizations, projects, Setup revisions, assignments, approvals, jobs, audit events, and portable receipts in PostgreSQL.
- The runner owns device credentials, local project paths, caches, the claimed-job inbox, operation journal, materializations, and result outbox in SQLite.
- Jobs are declarative and versioned. Mutating jobs require idempotency keys; Apply requires approval bound to the exact plan digest.
- PostgreSQL and runner SQLite are separate authorities. Do not replicate machine paths to the control plane or organization policy into runner SQLite.
- Keep filesystem planning and mutation in the runner execution service so remote work and CLI commands behave equivalently.
- New protocol fields must be reflected in TypeScript contracts, Rust domain types, validation fixtures, and tests.

## TypeScript conventions

- TypeScript is strict; unused locals and parameters fail builds.
- Components use PascalCase and typed `ComponentNameProps` props.
- Keep control-plane route handlers thin; business decisions belong in services/repositories.
- User-visible browser copy is English-only and remains in `apps/web/src/i18n/resources.ts`.
- Use semantic CSS classes in `apps/web/src/App.css`; do not add a second styling system.
- Before changing product layout, shared components, responsive behavior, overlays, or interaction feedback, read only `docs/UI-DESIGN-GUIDELINES.md`.

## Rust conventions

- Follow `rustfmt`; treat Clippy warnings as errors.
- Use `anyhow::Context` for useful error boundaries.
- Paths must support `~` expansion where accepted by the CLI.
- Preserve the symlink → junction (Windows) → copy fallback and ownership-aware conflict behavior.
- Tests that touch files use `tempfile`; HTTP tests use `mockito`.

## Workflow

1. Before implementing, briefly state the approach and files likely to change, then wait for confirmation.
2. Implement all affected boundaries in one pass: contract, API, persistence, runner, browser, and tests as applicable.
3. Keep changes minimal and avoid unrelated refactors.
4. Run focused tests while iterating, then `npm run check` before handoff.

Version numbers in the root package, workspaces, and Rust crates must stay synchronized through `npm run version:sync` and `npm run version:check`.
