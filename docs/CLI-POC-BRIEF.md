# Skills Hub CLI and Profiles POC

Status: working design brief

This document preserves the product context from the conversation that started
this fork. It is deliberately a design checkpoint, not a final specification.

## Problem

Skills are easy to install but difficult to experiment with safely across
Codex, Claude Code, Cursor, and other agents. Once many skills are installed,
it becomes cumbersome to:

- see which skills exist across the system;
- activate or deactivate related skills together;
- assign a reusable set of skills to a project;
- try a different workflow for a week and then roll back;
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
- **Profile**: a named desired set of skills and their agent/tool targets.
- **Project**: a registered local root path.
- **Assignment**: the profile currently selected for a project.
- **Apply operation**: a previewable reconciliation from the project's current
  managed state to the selected profile.
- **Revision**: enough recorded state to explain or roll back an apply.

Profiles must not be implemented as tags. Tags classify skills; profiles encode
desired state, including membership, targets, and eventually version choices.

## Initial CLI sketch

The executable name is not decided. `skills-hub` is used below only as a
placeholder.

```text
skills-hub profile list
skills-hub profile view <name>
skills-hub profile create <name>
skills-hub profile clone <source> <name>
skills-hub profile add-skill <profile> <skill> --tool <tool>...
skills-hub profile remove-skill <profile> <skill>

skills-hub project list
skills-hub project add <path>
skills-hub project use <profile> [--project <path>]

skills-hub status [--project <path>]
skills-hub apply [<profile>] [--project <path>] [--dry-run]
skills-hub rollback [--project <path>]
```

Open design questions include naming, whether `project use` should apply
immediately, how much interactivity is appropriate, and which commands need
`--json` in the POC.

## CLI behavior principles

- Default the project path to the current working directory when unambiguous.
- Make mutations idempotent and show the intended filesystem diff before a
  destructive replacement.
- Support a non-mutating dry run for reconciliation.
- Keep human-readable output concise while reserving a path to structured JSON.
- Return stable, documented exit codes for automation.
- Never remove unmanaged skill directories or user-authored files.
- Deactivation removes only managed tool-side materializations; canonical skill
  sources remain in the central library.
- Treat copy targets differently from links: ownership and content hashes must
  make drift visible before replacement.

## POC scope

The POC should prove the backend boundary and the complete profile-switching
loop without requiring new UI.

1. List the skills already known to Skills Hub.
2. Create and inspect a named profile.
3. Add skills and tool targets to that profile.
4. Register a project and assign the profile.
5. Preview the resulting filesystem changes.
6. Apply the profile using existing synchronization behavior.
7. Switch to another profile or an empty profile.
8. Roll back the last apply.

The POC is successful when an automated test performs that loop in temporary
directories and proves that unmanaged files are never removed.

## Architecture checkpoint

Before implementation, inspect how much of the current Rust core can be exposed
without Tauri. Prefer a small, independently testable application/service layer
shared by the CLI and Tauri commands. Avoid making the CLI call Tauri IPC or
directly duplicate synchronization and database behavior.

Two implementation shapes should be compared before choosing one:

1. Add a CLI binary to the existing Rust package and expose reusable core APIs.
2. Introduce a Rust workspace with explicit core, CLI, and Tauri application
   crates.

The first may make a faster POC; the second may provide a cleaner long-term
boundary. The choice should be based on the current module dependencies rather
than decided in advance.

## Deferred work

- profile editing in the Tauri UI;
- workflow packs containing hooks, repositories, launchers, or dependencies;
- version pinning and lockfiles;
- benchmark prompts and skill-selection telemetry;
- import/export and shareable profile manifests;
- a GitHub CLI extension; and
- upstream contribution strategy after the POC is validated.

## Next design session

Start by mapping the current Rust dependency boundary and then settle the CLI
grammar with concrete example sessions. Do not begin the database migration or
feature implementation until that design is reviewed.
