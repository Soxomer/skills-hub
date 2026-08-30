# Agent Harness Manager CLI and Setups POC

Status: implemented POC

This document preserves the product context from the conversation that started
this fork. It is deliberately a design checkpoint, not a final specification.

## Problem

Skills are easy to install but difficult to experiment with safely across
Codex, Claude Code, Cursor, and other agents. Once many skills are installed,
it becomes cumbersome to:

- see which skills exist across the system;
- activate or deactivate related skills together;
- assign a reusable set of skills to a project;
- switch between exact configurations without polluting every project;
- compare collections such as Firstmate without polluting every project; and
- understand which files are owned by the manager versus the user.

Skills Hub already provides the important lower-level capabilities: a central
skill library, discovery and installation, global and project targets, tool
adapters, and link/junction/copy synchronization. The missing layer is a
reusable, project-assignable configuration.

## Product direction

Build on Skills Hub instead of creating a competing installer. Evolve the
system toward one backend with two first-class consumers:

```text
                 skills backend / core
                    /             \
          standalone CLI       Tauri UI
             (first)             (later)
```

The standalone CLI is the first POC surface. Its command structure should feel
familiar to users of GitHub CLI: noun-oriented subcommands, helpful interactive
defaults, predictable non-interactive flags, and useful structured output.

A GitHub CLI extension could be explored later, but it is explicitly outside
the first POC.

## Core concepts

- **Skill library**: canonical skill sources managed once by Skills Hub.
- **Setup**: a named configuration whose edits create immutable revisions.
- **Setup Revision**: an exact, immutable set of skills and agent/tool targets.
- **Project**: a registered local root path.
- **Assignment**: the exact Setup Revision currently selected for a project.
- **Sync operation**: a previewable reconciliation from the project's current
  managed state to its selected revision.
- **Operation journal**: enough recorded state to recover from or roll back a sync.

Setups must not be implemented as tags. Tags classify skills; setups encode
desired state, including membership, targets, and eventually version choices.

## Initial CLI sketch

The executable is named `ahm`.

```text
ahm setup list
ahm setup view <name>
ahm setup create <name>
ahm setup clone <source> <name>
ahm setup add-skill <setup> <skill> --tool <tool>...
ahm setup remove-skill <setup> <skill>

ahm project list
ahm project add <path>
ahm project use <setup> [--project <path>]

ahm status [--project <path>]
ahm plan [<setup>] [--project <path>]
ahm sync [<setup>] [--project <path>]
ahm rollback [--project <path>]
```

`project use` pins the Setup's current immutable revision without writing to the
filesystem. `sync` performs the materialization as a separate explicit action.

## CLI behavior principles

- Default the project path to the current working directory when unambiguous.
- Make mutations idempotent and show the intended filesystem diff before a
  destructive replacement.
- Keep planning non-mutating and separate from synchronization.
- Keep human-readable output concise while reserving a path to structured JSON.
- Return stable, documented exit codes for automation.
- Never remove unmanaged skill directories or user-authored files.
- Deactivation removes only managed tool-side materializations; canonical skill
  sources remain in the central library.
- Treat copy targets differently from links: ownership and content hashes must
  make drift visible before replacement.

## POC scope

The POC should prove the backend boundary and the complete setup-switching
loop without requiring new UI.

1. List the skills already known to Skills Hub.
2. Register a project.
3. Preview its current machine state without modifying it.
4. Capture accepted discoveries as that project's retained first Default Setup revision.
5. Create and inspect another named setup.
6. Add skills and tool targets to that setup.
7. Preview the resulting filesystem changes.
8. Synchronize the setup using existing materialization behavior.
9. Switch to another setup or Default.
10. Roll back the last synchronization operation.

The POC is successful when an automated test performs that loop in temporary
directories and proves that unmanaged files are never removed.

## Architecture decision

Before implementation, inspect how much of the current Rust core can be exposed
without Tauri. Prefer a small, independently testable application/service layer
shared by the CLI and Tauri commands. Avoid making the CLI call Tauri IPC or
directly duplicate synchronization and database behavior.

Two implementation shapes were compared:

1. Add a CLI binary to the existing Rust package and expose reusable core APIs.
2. Introduce a Rust workspace with explicit core, CLI, and Tauri application
   crates.

The POC uses the first shape. Most of the existing Rust core, including the
tool adapters and synchronization engine, was already independent of Tauri.
The new `setup_service` module is an application boundary shared through the
library, while `src/bin/ahm.rs` is a standalone consumer. A workspace
split remains possible later without changing the command model or database.

## Running the POC

From the repository root:

```text
npm run cli -- --help
npm run cli -- project add .
npm run cli -- scan
npm run cli -- setup default preview
npm run cli -- setup default capture
npm run cli -- skill list
npm run cli -- setup create weekly-test
npm run cli -- setup add-skill weekly-test <skill-id-or-name> --tool codex cursor
npm run cli -- project use weekly-test
npm run cli -- plan
npm run cli -- sync
npm run cli -- project use-default
npm run cli -- status
npm run cli -- rollback
```

The CLI uses the desktop app's SQLite database by default. Pass `--db <path>`
or set `AHM_DB` to use a disposable database. Every command also accepts
`--json` for structured output.

`project use` selects an exact immutable revision but deliberately does not
touch the filesystem. `plan` previews reconciliation. `sync` records an
operation and materializes the selected revision. `rollback` restores the
managed target snapshot from immediately before the latest sync.

`scan` and `setup default preview` are read-only and operate on the registered
project selected by `--project` or the current directory. `setup default capture`
copies accepted content into immutable central snapshots, preserves conflicting
same-name content as distinct snapshots, records the original target name, and
retains that project's first Default revision even when later revisions are
created. Every project owns an independent Default Setup. Use
the repeatable `--exclude <selection-key>` option to leave discoveries external.

Exit codes are `0` for success, `1` for an internal/runtime failure, `2` for
invalid input or a missing resource, and `3` for a safety conflict.

## Implemented safety boundary

- Only project-scoped paths recorded in `skill_targets` are candidates for
  removal.
- An existing path with no matching ownership record is an unmanaged conflict;
  it is never overwritten.
- Links and junctions must still point at the canonical managed source.
- Copy targets must still hash to the managed source; local drift blocks the
  operation.
- The complete plan is validated before filesystem mutation begins.
- A failed filesystem or database operation attempts to restore the previous
  materializations.
- Automated temporary-directory tests cover immutable revision assignment,
  read-only scanning, Default capture, managed and unresolved discoveries,
  conflicting content, explicit exclusions, sync, empty-setup switching,
  rollback, unmanaged collisions, schema migration, and drifted Cursor copies.

## Deferred work

- setup editing in the Tauri UI;
- workflow packs containing hooks, repositories, launchers, or dependencies;
- version pinning and lockfiles;
- benchmark prompts and skill-selection telemetry;
- import/export and shareable setup manifests;
- a GitHub CLI extension; and
- upstream contribution strategy after the POC is validated.

## Next design session

Exercise the POC against real disposable projects and decide which parts of the
setup model should become visible in the Tauri UI. Import/export, setup
manifests, and benchmark workflows remain intentionally deferred.
