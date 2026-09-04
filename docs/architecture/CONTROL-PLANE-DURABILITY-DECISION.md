# Control-plane durability decision

- Status: accepted
- Date: 2026-09-04
- Linear: OMA-53
- Decision: keep the current PostgreSQL runner outbox; defer DBOS and Zero

## Context

Agent Harness Manager has two independent durability boundaries:

1. PostgreSQL owns shared desired state, digest-bound approvals, the runner job outbox, and portable receipts.
2. Runner-local SQLite owns the claimed-job inbox, filesystem operation journal, and result outbox.

The Rust worker claims declarative jobs over outbound HTTPS. It cannot execute a DBOS workflow or connect directly to control-plane PostgreSQL, so any candidate control-plane workflow engine must preserve `runner_jobs` as the device mailbox.

DBOS was evaluated as a possible owner for the longer interaction:

`request plan → await runner plan → await approval → request apply → await receipt`

Rocicorp Zero was considered separately as a browser synchronization layer. It is not a workflow engine or runner transport.

## Experiment

The test-only DBOS fixture implements the interaction as one durable workflow and uses an idempotent port for the existing runner mailbox. It runs only when `AHM_DBOS_TEST_DATABASE_URL` points to a real PostgreSQL database.

The fixture verifies:

- recovery after DBOS is shut down while awaiting approval;
- idempotent duplicate plan, approval, and receipt delivery;
- rejection of approval for a stale plan digest;
- durable cancellation and an inspectable step timeline;
- durable timeout when a runner result never arrives;
- behavior when a workflow started by application version 1 is waiting while only version 2 is running.

The experiment used `@dbos-inc/dbos-sdk` 4.27.6 and PostgreSQL 16. The focused test command passed 21 control-plane tests, including all five DBOS cases.

The complete repository gate also passed: workspace boundaries, lint, 92 normal TypeScript tests, every production build, Rust formatting and Clippy, and 179 Rust tests. The five PostgreSQL-backed DBOS cases are intentionally skipped by the normal test command and run explicitly with `AHM_DBOS_TEST_DATABASE_URL`, so the standard gate does not require Docker or an external database.

DBOS created 11 tables and 33 indexes in its isolated schema:

- `application_versions`
- `dbos_migrations`
- `event_dispatch_kv`
- `notifications`
- `operation_outputs`
- `queues`
- `streams`
- `workflow_events`
- `workflow_events_history`
- `workflow_schedules`
- `workflow_status`

## Findings

| Criterion | Result |
| --- | --- |
| Restart recovery | Pass. The approval wait resumed after a shutdown and relaunch against the same PostgreSQL database. |
| Duplicate delivery | Pass. DBOS idempotency keys prevented repeated external messages from advancing the workflow twice. |
| Cancellation and timeout | Pass. Both became durable, inspectable workflow outcomes. |
| Digest-bound approval | Pass in the spike, but it duplicates checks still required in the business repository and local runner. |
| Runner isolation | Pass only by retaining the existing HTTPS job mailbox and local SQLite state. |
| Single durability owner | Fail for the current product shape. DBOS workflow state would coexist with the required `runner_jobs`, approval, receipt, and assignment records without replacing a complete subsystem. |
| Code reduction | Fail. The current control plane does not contain a separate long-lived workflow engine: its API operations are short PostgreSQL transactions and job status is derived from the runner mailbox. DBOS therefore adds orchestration and result-to-workflow signaling rather than deleting existing transport code. |
| Deployment evolution | Needs additional machinery. A waiting version-1 workflow remained `PENDING` when only a version-2 executor was launched. Supporting rolling changes requires an old-version executor, an explicit migration/resume strategy, or additional DBOS operational infrastructure. |
| Operational footprint | Worse at the present scale. DBOS adds its schema, migrations, workflow retention, version operations, and another timeline that must be correlated with product jobs and local operations. |

DBOS performs its advertised durable-workflow responsibilities correctly. The rejection is about fit: Agent Harness Manager currently needs a durable device mailbox, not an additional server-side workflow authority.

## Decision

Keep the current architecture for the web-runner cutover:

`browser → TypeScript control plane/PostgreSQL → outbound HTTPS → Rust worker/SQLite → project filesystem`

DBOS remains a development-only dependency for the reproducible fixture. It is not imported by `src`, launched by the production server, or part of the deployed runtime.

Do not adopt Zero now. There is no demonstrated offline or collaborative browser-editing requirement that justifies `zero-cache`, client schema management, and PostgreSQL logical replication. Normal control-plane APIs remain authoritative.

## Revisit triggers

Re-run this decision when the control plane contains multiple genuine long-lived workflows with repeated custom implementations of durable waits, timers, cancellation, and recovery—for example plugin imports, evaluation runs, and organization approvals.

DBOS should then be adopted only if the experiment proves that it removes one complete custom workflow subsystem while:

- retaining the declarative HTTPS worker protocol;
- keeping machine paths and effects local;
- preserving one authoritative product timeline;
- supporting queued workflows across application upgrades;
- avoiding a mandatory new production service at the required scale.

Zero should be reconsidered independently when measured UX requirements include offline browser operation, collaborative concurrent editing, or enough reactive-query complexity that the existing API approach is materially harder to maintain.

## References

- [DBOS architecture](https://docs.dbos.dev/architecture)
- [DBOS workflow communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication)
- [DBOS integration requirements](https://docs.dbos.dev/typescript/integrating-dbos)
- [Zero architecture](https://zero.rocicorp.dev/)
- [Zero mutators](https://zero.rocicorp.dev/docs/mutators)
