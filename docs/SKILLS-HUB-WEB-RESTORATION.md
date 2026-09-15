# Skills Hub web restoration

The baseline is `6d65fd018cbdaac8eeeeb487ab21c20060069912`, including the preview feature introduced in `c23ad9e`. The restoration retains the original product screens and interactions in `apps/web/src/hub`, and ports their local operations to `crates/ahm-runner`. The later Projects, Setups, approval and recovery workflows remain accessible from **Projects & runner**.

| Original capability | Web implementation |
| --- | --- |
| My Skills, search, filters, list/cards, scope and bulk actions | Original React components, backed by the connected runner library |
| Featured catalogue and online search | Bundled original catalogue and public skills.sh search through the API |
| Preview before download | SKILL.md drawer; GitHub commit resolved before reading; installation uses that revision |
| Local folder / Git repository import and skill selection | Runner folder picker, candidate discovery, selected imports and tool synchronization |
| Read installed skill and its files | Managed-folder handles; bounded UTF-8 file reads and relative file tree |
| Tags | Create, rename, assign, filter and remove using runner SQLite |
| Built-in and custom tools | Original configuration, global/project scope, symlink → junction → copy behavior |
| Enable, disable, update and delete | Runner execution, target ownership checks and local-change preservation |
| Update scheduling, cache and proxy settings | Runner-owned configuration and maintenance while the worker runs |
| Storage location | Runner picker and relocation preserving synchronized links |
| Theme and application updates | Browser theme; deployed web version check and reload |

## Runtime contract

- Device-scoped `libraryAction` jobs can run before any project is registered. Their `projectInstanceId` is null; project Setup jobs keep their project scope.
- The API validates a fixed command and argument vocabulary. Machine paths and GitHub credentials remain runner-owned. Public catalogue requests cannot execute local work.
- Every delivery has an idempotency key and uses the existing durable inbox/outbox. Filesystem actions preflight a fingerprint and recheck it before execution; a changed source or target requires retrying the action. This does not replace Setup Apply's explicit plan approval.
- Preview resolves immutable Git content, while the installed skill retains its original tracking source for later updates.
- Cancellation prevents a prepared action from starting. A filesystem action already committing finishes before its result is reported; it is not presented as an instantaneous rollback.
- This POC changes the control-plane initialization schema and runner journal schema (version 3). Use a fresh control-plane database and runner state when moving from the earlier POC. Preserve the separate local Skills Hub database and skill directories; no automatic deletion or compatibility migration is performed.

## Verification

`npm run check` covers TypeScript tests with PostgreSQL enabled, all runtime builds, protocol golden fixtures, Rust tests, formatting, Clippy, versions and runtime boundaries.

Added cases cover preview revision pinning, ambiguous/oversized previews, rejected local or credential-bearing preview URLs, portable file/configuration validation, device jobs without a project, tenant isolation and duplicate delivery. Runner cases exercise import → tags → file reading → sync → storage relocation → deletion, preserving the source, modified-target protection, stale preflight rejection, and pinned Git checkout after a branch advances.

Browser acceptance uses disposable PostgreSQL and runner directories. It checks the real catalogue preview, local import/sync/file reading, preview → Git installation → Codex synchronization, tag assignment and Git update against real files. Installed and synchronized SKILL.md bytes are compared. The pinned checkout test also covers long Windows cache paths. Projects and Setups remain accessible from the restored page. Desktop and mobile library/preview captures are stored in the local `.impeccable/review/` acceptance directory.
