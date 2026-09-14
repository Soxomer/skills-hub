# Skills Hub feature-parity restoration

## Product baseline

The product is a PWA port of Skills Hub with Agent Harness Manager added alongside it, not a replacement for Skills Hub. Preserve the original managed-skills experience while keeping filesystem authority in the local runner.

Baseline: `6d65fd018cbdaac8eeeeb487ab21c20060069912`, before cutover `c7ac637`. The historical README, React screens under `src/components/skills`, and Rust modules under `src-tauri/src/core` are implementation evidence. Recover their behavior and reusable logic; do not restore the Tauri shell or bypass approval, tenant isolation, and ownership rules.

## Sequenced restoration backlog

Resumption checkpoint — 2026-09-15: the read-only My Skills slice and pending
Setup reliability work are consolidated in `main` through PR #2. Connected
acceptance and platform results are recorded in [OMA-30 acceptance](OMA-30-ACCEPTANCE.md).
The next product slice is standalone Git/local import, followed by Explore.
Neither flow is implemented by the consolidation; do not count them as shipped.

| Slice | Required outcome | Status |
| --- | --- | --- |
| Managed library visibility | My Skills lists real runner library entries, tags, enabled state, tool/scope targets; searchable and filterable; offline reports labeled | Implemented read-only; not full library parity |
| Import | Git repository and local-folder import with selection, source tracking, tags and target choices; runner performs local work | Not restored |
| Explore | Original curated catalog, search, remote preview and installation into My Skills | Not restored |
| Library management | Card/list views, sorting, detail inspection, enable/disable, deletion and bulk operations | Not restored beyond the read-only list |
| Tags and tools | Tag CRUD; built-in toggles; custom tools; independent discovery-source settings | Surviving runner primitives only |
| Scope and discovery | Global/project targeting and scan/review/import existing skills | Partial scanning only |
| Updates | Manual and scheduled source updates, result history and actionable failures | Not restored |
| Preferences | Theme, storage/cache, source authentication and proxy settings, appropriate web update behavior | Not restored |
| Rich inspection | File tree, rendered Markdown and code preview for local and remote skills | Plain Setup artifact inspection only |
| PWA delivery | Install manifest/icons, update lifecycle, explicit offline behavior; no unsafe caching of organization data | Not implemented |

## First slice boundary

The worker includes a bounded, path-free library projection in its authenticated claim poll. PostgreSQL retains the latest report per runner for browser viewing. Runner SQLite remains authoritative. An omitted report preserves the prior snapshot; an empty report means an empty library. Report timestamps describe receipt, not filesystem verification or sync health.

No source URLs, credentials, local paths, file contents or target errors are published in this projection. Source categories and recorded target scopes are metadata, not claims that a target is currently synchronized. The screen does not import, mutate, apply, or delete anything. Existing Projects and Setups remain unchanged.

## Acceptance gates

- Compare each restored flow with its pre-cutover implementation, not only this backlog.
- Verify TypeScript and Rust protocol fixtures, authorization/isolation, runner effects and browser states.
- Test on an isolated populated runner library and PostgreSQL, including empty reports and offline/revoked devices.
- Verify desktop/mobile layouts and keyboard access; run `npm run check` before handoff.
- Do not mark the port complete until original capabilities are restored or their removal is explicitly approved.

## Next implementation slice: import, then Explore

Restore the original flow: choose Git or a local folder, preview discovered
`SKILL.md` files and supporting content, select skills, set tags and intended
targets, then import into My Skills. Applying to a project uses a separate
reviewed Setup plan. Global target changes also require an explicit reviewed
mutation; importing into the library alone must not silently sync targets.

Implementation boundaries to carry into the next change:

1. Add device-scoped, declarative preview/import jobs to both protocol packages.
   A library import must work before a project is registered; do not invent a
   project instance or overload a Setup scan. Keep project Apply approvals
   required and scoped to their current exact plan.
2. Keep Git fetching, source revision resolution, staging and SQLite library
   writes in the runner. Seal the preview content so subsequent source changes
   cannot change what the user selected. Use the existing validated artifact
   cache and bounded portable file format. A browser-selected local folder
   needs explicit content-upload consent and relative paths only; workstation
   paths and credentials remain local.
3. Persist preview identity, selection, source revision, tags and an idempotent
   import receipt. Preserve existing content on conflicts and support replay
   after interruption. Publish only the resulting bounded library projection.
4. Add My Skills import controls, source preview, selection and durable status.
   Exercise browser/API/runner together with disposable Git and local fixtures,
   including multi-skill repositories, traversal/link rejection, stale previews,
   duplicate requests, cancellation, tenant isolation and offline devices.
5. Reuse that import route for Explore's original curated catalog, remote
   search, preview and installed-state indicators. Recover the original source
   logic from the baseline before adding new providers or changing behavior.

The existing work under the property/mutation-testing branch and the older
acceptance worktree is retained separately. Their patches must be compared with
current `main`; applying the old acceptance patch wholesale would duplicate or
replace fixes already consolidated.

## First-slice verification — 2026-09-09

- `npm run check` passed: 131 TypeScript tests, Rust tests, builds, lint, formatting, Clippy, version and boundary checks. One existing opt-in TypeScript integration suite remains skipped by the default gate.
- Separate live verification used an isolated PostgreSQL database and actual `ahm` worker with a synthetic populated SQLite library: source credentials and paths excluded, reports persisted, browser search/state filtering worked, offline state was labeled, and a subsequent empty report replaced the old entries.
- Browser checks passed at 1280, 390 and 320 pixels with no page errors or document overflow after the compact-navigation correction. Dense columns scroll inside the table region.
- Independent finish review: ship the read-only slice; no material blocking findings. This is not approval of full restoration or PWA completion.
