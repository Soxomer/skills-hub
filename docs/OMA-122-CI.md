# OMA-122 CI coverage

The pull-request, main-branch, and `codex/**` branch CI workflow now provisions PostgreSQL 16 for
the web/control-plane job. Its database and password are disposable CI data.
`AHM_TEST_DATABASE_URL` enables the real PostgreSQL test in
`apps/control-plane/tests/setups-postgres.test.ts` during the existing
`npm run test` gate. No external database credentials are required.

That test creates an isolated schema and verifies two concurrent publishers
reach the same PostgreSQL row lock, then produce one successful revision and
one stale-revision conflict. It also checks retained project assignments,
the initial Default revision, and audit records. Without the environment
variable, ordinary local test runs skip this integration test.

The runner job runs formatting, Clippy, and the complete Rust test suite on
Ubuntu, Windows Server 2022, and macOS 14. Each platform completes independently
because matrix fail-fast is disabled. This executes the existing Unix symlink
and Windows junction/copy tests on their applicable hosts.

Node 22 satisfies the installed Vite/plugin requirement of Node 22.12 or later
and happy-dom's Node 20 minimum. The workflow retains version, boundary,
contracts, lint, TypeScript tests, and browser/control-plane build gates.

The configuration itself is not evidence of a successful hosted run. Record
the resulting workflow run before declaring the platform matrix verified.
These jobs also do not replace the connected browser-to-runner acceptance
walkthrough in `docs/OMA-30-ACCEPTANCE.md`.

Local acceptance startup exposed concurrent worker/CLI SQLite initialization.
Schema migration now locks before inspecting the version, commits atomically,
and rolls back on failure. Concurrent-initializer and failed-migration tests
cover this regression. `ahm worker --home <fixture-home>` allows isolated
discovery/cache acceptance without changing the process home or scanning real
user configuration; the default remains the actual user home.
