# Agent Harness Manager

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Manage reusable, versioned agent configurations across local projects. The user confirmed an independent Setups page for browsing contents, editing selections, and publishing new versions without automatically changing project assignments.

## Capabilities and Constraints

A Setup groups captured agent configuration. Revisions are immutable; projects remain pinned until an explicit reviewed Apply. Each project's initial Default remains available for recovery. Only the local runner changes workstation files. Browsing stored Setups must not require an online runner.

## Evidence on Hand

The authoritative roadmap is `docs/AGENT-HARNESS-MANAGER-ROADMAP.md`; runtime boundaries are documented in `docs/architecture/WORKSPACE-BOUNDARIES.md`. The existing visual system is governed by `docs/UI-DESIGN-GUIDELINES.md` and browser CSS. This record summarizes the confirmed scope rather than replacing those documents.

## Product Principles

- Inspect before applying.
- Preserve immutable history and deliberate project assignments.
- Keep local filesystem authority in the runner.
- Use clear product terms: Projects and Setups.
