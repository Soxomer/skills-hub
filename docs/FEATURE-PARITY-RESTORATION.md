# Skills Hub feature-parity restoration

## Product baseline

The product is a PWA port of Skills Hub with Agent Harness Manager added alongside it, not a replacement for Skills Hub. Preserve the original managed-skills experience while keeping filesystem authority in the local runner.

Baseline: `6d65fd018cbdaac8eeeeb487ab21c20060069912`, before cutover `c7ac637`. The historical README, React screens under `src/components/skills`, and Rust modules under `src-tauri/src/core` are implementation evidence. Recover their behavior and reusable logic; do not restore the Tauri shell or bypass approval, tenant isolation, and ownership rules.

## Sequenced restoration backlog

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

## First-slice verification — 2026-09-09

- `npm run check` passed: 131 TypeScript tests, Rust tests, builds, lint, formatting, Clippy, version and boundary checks. One existing opt-in TypeScript integration suite remains skipped by the default gate.
- Separate live verification used an isolated PostgreSQL database and actual `ahm` worker with a synthetic populated SQLite library: source credentials and paths excluded, reports persisted, browser search/state filtering worked, offline state was labeled, and a subsequent empty report replaced the old entries.
- Browser checks passed at 1280, 390 and 320 pixels with no page errors or document overflow after the compact-navigation correction. Dense columns scroll inside the table region.
- Independent finish review: ship the read-only slice; no material blocking findings. This is not approval of full restoration or PWA completion.
