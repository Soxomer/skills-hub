# OMA-123 — independent Setups page

## Delivered scope

Projects and Setups have independent navigation. Stored Setups can be browsed without an online runner. Detail exposes immutable history, initial Default identification, item-level comparison, captured UTF-8 file inspection, and projects with their pinned version numbers.

Create and Clone publish a separately named Setup. Edit selection appends a version to the same Setup, including project Defaults. Editing an older version compares the proposed selection against the latest version and can republish that older selection. Publishing never assigns or applies to a project. The original Default remains available even after a custom Setup is assigned.

Editing means composing captured items, not editing their file contents. Text preview is limited to 256 KiB per UTF-8 file; unsupported binary or larger files show an explicit limitation. Content renders as plain text, never executable markup.

## Verification

- `npm run check` passed on Windows: 125 TypeScript tests, 89 Rust tests, production builds, lint, runtime boundaries, version checks, rustfmt, and Clippy. The opt-in PostgreSQL test skips when its connection variable is absent.
- Nine browser interaction tests cover inspection, safe text rendering, publication, stale conflict recovery, historical selection publication, initial Default visibility, clone, late response isolation, and retry.
- Real PostgreSQL 16 publication test passed separately: both publishers were observed waiting on the same row lock; after release exactly one returned 201 and one 409. Only versions 1 and 2 existed, the project stayed pinned to version 1, the original Default remained intact, and no duplicate publication audit event appeared.
- Browser automation at desktop 1280px and mobile 390px exercised browse → inspect → edit → publish. A 120-character unbroken name was verified at 1280px and 320px. No document overflow or page errors were observed. Browser captures used explicitly synthetic data; they are not evidence of a connected runner execution.
- Impeccable's independent finish-review role was run through its fallback instructions because this harness has no named reviewer agent type. Its one material finding (long-name wrapping) was fixed and scored resolved. Existing visual guidelines and tokens were preserved; no design-system replacement was introduced.

Local screenshot evidence lives in ignored `.impeccable/review/`. The disposable PostgreSQL database `ahm_oma123_publication_20260908` and test schemas were retained for inspection. No existing project data or old acceptance directories were changed.

## Repeating the real database test

Set `AHM_TEST_DATABASE_URL` in the process environment to a **disposable** PostgreSQL database, then run:

```sh
npx vitest run apps/control-plane/tests/setups-postgres.test.ts
```

Each run creates a uniquely named retained schema. It does not drop or rewrite existing schemas. This test exercises real SQL transactions through injected HTTP requests, not a live network/browser/runner chain.

## Remaining release boundaries

This finishes OMA-123, not the whole product roadmap. OMA-30/122 retain connected end-to-end acceptance and broader cross-platform/recovery verification. Catalog import, preflight, and evaluation remain OMA-31/33/34. Shared hosting still requires OMA-114 identity work; development identity headers remain local-POC only. Multi-checkout assignment ordering and publication consent remain OMA-120/121.
