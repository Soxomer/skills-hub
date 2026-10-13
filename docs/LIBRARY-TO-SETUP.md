# Add a managed skill to a Setup

`My Skills → Add to Setup` saves an exact, immutable snapshot of a managed skill in the hosted workspace. Available in version 0.10.0, it publishes a Setup version without assigning it to a project, applying files, or synchronizing local tool targets.

## Use the feature

1. Connect the computer that owns the managed library and open a skill's detail view in **My Skills**.
2. Choose **Add to Setup**. The runner reviews the skill and returns a file manifest, byte sizes, digest, and supported project-scoped tools. Preview shares metadata, not file contents.
3. Choose **Existing Setup** or **New Setup**. Existing Setup is selected when saved Setups are available; its dropdown lists saved Setups, and their existing items are retained in the new version. New Setup exposes a name field and is selected when no Setups exist. Choosing Existing Setup in an empty library explains how to create one. Changing the mode alone does not create or publish a Setup.
4. Select tool targets explicitly and choose a skill folder name using letters, numbers, hyphens, or underscores. An existing item with the same tool and folder name blocks publication; it is never overwritten.
5. Review the files and digest, then check **Share these files with my hosted workspace and save them in this Setup**.
6. Choose **Add to Setup** for an existing destination or **Create Setup** for a new one. The runner captures and uploads the reviewed snapshot; the control plane publishes the immutable version.
7. Find the saved version under **Projects & runner → Setups**. Project selection, a reviewed plan, approval, and Apply remain separate actions.

Future library changes do not change the saved snapshot. Changing the destination mode, new Setup name, selected Setup, folder name, or tool selection clears sharing consent. Publication errors retain the draft; a failed publication response can be retried with the completed snapshot job. **Review again** refreshes the source review and destination's latest revision, retains the destination mode and selected Setup while it remains available, and requires consent again. The name, folder name, and tool selections remain in the draft. A changed skill, newer destination revision, or unavailable snapshot requires a fresh review.

## Implementation boundaries

- `preview_setup_skill` returns portable metadata only. `snapshot_setup_skill` requires the reviewed `expectedDigest`; the runner reads bounded bytes once per capture and hashes those same bytes for the artifact. A source digest that changed after preview is rejected before upload.
- Snapshots require `SKILL.md`, are limited to 10 MiB of file content and 5,000 filesystem entries, skip `.git`, reject symlinks and special files, and validate portable relative paths of at most 500 UTF-16 code units, matching artifact uploads. Machine paths remain on the runner.
- The worker checkpoints captured snapshot metadata in its local operation journal and uploads the content-addressed artifact before reporting success. After an interrupted upload, a reclaimed job resumes the original cached snapshot without rereading changed or deleted source files. Saved artifact bytes are immutable.
- `POST /api/v1/setups/library-skill` requires organization write access, a successful `snapshot_setup_skill` job in that organization, its matching digest, and an uploaded artifact. It validates the selected tools against the snapshot's supported tools.
- An existing destination supplies `expectedRevisionNumber`. The transaction rejects stale revisions and target collisions, copies all previous items, and appends the selected targets. Revision creation, the audit event, and the snapshot-publication record commit atomically.
- Retrying the same publication for the same snapshot job returns the saved revision. Reusing that job with a different publication selection is rejected.
- The browser handles review and publication; the runner reads and captures local files. Publication does not invoke assignment, Apply, or library sync.

## Interface and runtime requirements

The feature extends the incumbent compact utility interface. A compact **Add to Setup** action sits at the right of the skill-title row below Back. The centered native modal uses semantic theme colors, visible keyboard focus, a bounded scrollable manifest, and a wrapping digest inside a collapsed **Snapshot digest** disclosure. Tool choices wrap on desktop and become one column on narrow screens. Saving and Apply remain separate in both the action labels and success state. No durable design-system change is required.

Use helper/CLI version 0.10.0 or later, which includes `preview_setup_skill` and `snapshot_setup_skill`. The older `helper-test-2026-10-11` installer does not include these commands. The original computer must remain connected while reviewing and capturing the skill; browsing a saved Setup uses hosted state.

The current entry point covers managed skills only. It does not provide direct catalogue import, full-plugin handoff, skill-content editing, or update propagation into saved versions.

## Verification

Coverage includes dialog behavior and retries, protocol validation and fixtures, Rust snapshot immutability and stale-source rejection, PostgreSQL publication concurrency and rollback, and a real Rust worker → HTTP → PostgreSQL integration test.

PostgreSQL integration tests require `AHM_TEST_DATABASE_URL`. The real worker test additionally requires `AHM_TEST_RUNNER_BIN` pointing to the branch-built `ahm` executable. CI builds that executable and supplies both variables. Without these variables locally, the corresponding optional integration tests are skipped.

Run `npm run check` before handoff or committing.
