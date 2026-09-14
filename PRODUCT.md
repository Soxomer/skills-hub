# Agent Harness Manager

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Port the existing Skills Hub desktop product to a PWA and add reusable, versioned agent configurations across local projects. Preserve the managed-skills library, Explore, import and management workflows. Projects and Setups are additions, not replacements. The independent Setups page browses contents, edits selections and publishes versions without automatically changing project assignments.

## Capabilities and Constraints

A Setup groups captured agent configuration. Revisions are immutable; projects remain pinned until an explicit reviewed Apply. Each project's initial Default remains available for recovery. Only the local runner changes workstation files. Browsing stored Setups must not require an online runner.

## Evidence on Hand

The restoration baseline and missing capabilities are in `docs/FEATURE-PARITY-RESTORATION.md`, alongside `docs/AGENT-HARNESS-MANAGER-ROADMAP.md`. Runtime boundaries are documented in `docs/architecture/WORKSPACE-BOUNDARIES.md`. The existing visual system is governed by `docs/UI-DESIGN-GUIDELINES.md` and browser CSS. This record summarizes the confirmed scope rather than replacing those documents.

## Product Principles

- Inspect before applying.
- Preserve immutable history and deliberate project assignments.
- Keep local filesystem authority in the runner.
- Preserve existing product capabilities when changing runtime.
- Use clear product terms: My Skills, Projects and Setups.
