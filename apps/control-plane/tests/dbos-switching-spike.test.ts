import { DBOS } from '@dbos-inc/dbos-sdk'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DBOS_SWITCHING_PHASE_EVENT,
  configureDbosSwitchingSpikePort,
  registerDbosSwitchingSpike,
  type DbosSwitchingPhase,
} from './support/dbos-switching-spike.js'

const databaseUrl = process.env.AHM_DBOS_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip
const planDigest = `sha256:${'d'.repeat(64)}`

interface EnqueuedJob {
  jobId: string
  kind: 'planSetup' | 'applyPlan'
  operationId: string
}

function configureRuntime(applicationVersion: string): void {
  DBOS.setConfig({
    name: 'ahm-dbos-switching-spike',
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: 'dbos_ahm_spike',
    applicationVersion,
    executorID: 'spike-executor',
    logLevel: 'error',
    runAdminServer: false,
    useListenNotify: true,
  })
}

async function waitForPhase(workflowId: string, expected: DbosSwitchingPhase): Promise<void> {
  await expect
    .poll(
      () =>
        DBOS.getEvent<DbosSwitchingPhase>(workflowId, DBOS_SWITCHING_PHASE_EVENT, {
          timeoutSeconds: 0.1,
          pollingIntervalMs: 20,
        }),
      { timeout: 5_000 },
    )
    .toBe(expected)
}

integration('DBOS switching durability spike', () => {
  const enqueued = new Map<string, EnqueuedJob>()
  let switchingWorkflow: ReturnType<typeof registerDbosSwitchingSpike>

  beforeAll(async () => {
    configureRuntime('1')
    configureDbosSwitchingSpikePort({
      enqueue: async (job) => {
        enqueued.set(job.jobId, job)
      },
    })
    switchingWorkflow = registerDbosSwitchingSpike()
    await DBOS.launch()
  }, 30_000)

  afterAll(async () => {
    if (DBOS.isInitialized()) await DBOS.shutdown({ deregister: true })
  })

  it('recovers approval waiting after restart and deduplicates external signals', async () => {
    const workflowId = 'switch-restart'
    await DBOS.startWorkflow(switchingWorkflow, { workflowID: workflowId })({
      operationId: 'operation-restart',
      planJobId: 'plan-restart',
      applyJobId: 'apply-restart',
      waitTimeoutSeconds: 20,
    })
    await waitForPhase(workflowId, 'awaitingPlan')
    expect(enqueued.get('plan-restart')).toMatchObject({ kind: 'planSetup' })

    await DBOS.send(
      workflowId,
      { planJobId: 'plan-restart', planDigest, hasConflicts: false },
      'planResult',
      'plan-result-restart',
    )
    await waitForPhase(workflowId, 'awaitingApproval')

    await DBOS.shutdown()
    expect(DBOS.isInitialized()).toBe(false)
    await DBOS.launch()

    await DBOS.send(
      workflowId,
      { approvalId: 'approval-restart', planDigest },
      'approval',
      'approval-restart',
    )
    await DBOS.send(
      workflowId,
      { approvalId: 'approval-restart', planDigest },
      'approval',
      'approval-restart',
    )
    await waitForPhase(workflowId, 'awaitingReceipt')
    expect(enqueued.get('apply-restart')).toMatchObject({ kind: 'applyPlan' })

    await DBOS.send(
      workflowId,
      { applyJobId: 'apply-restart', planDigest, outcome: 'applied' },
      'applyReceipt',
      'receipt-restart',
    )
    await DBOS.send(
      workflowId,
      { applyJobId: 'apply-restart', planDigest, outcome: 'applied' },
      'applyReceipt',
      'receipt-restart',
    )
    await expect(DBOS.retrieveWorkflow(workflowId).getResult()).resolves.toEqual({
      outcome: 'applied',
      planDigest,
      approvalId: 'approval-restart',
    })
    expect([...enqueued.keys()].filter((jobId) => jobId === 'plan-restart')).toHaveLength(1)
    expect([...enqueued.keys()].filter((jobId) => jobId === 'apply-restart')).toHaveLength(1)
  }, 30_000)

  it('rejects approval for a stale plan digest before enqueueing apply', async () => {
    const workflowId = 'switch-stale'
    const handle = await DBOS.startWorkflow(switchingWorkflow, { workflowID: workflowId })({
      operationId: 'operation-stale',
      planJobId: 'plan-stale',
      applyJobId: 'apply-stale',
      waitTimeoutSeconds: 10,
    })
    await waitForPhase(workflowId, 'awaitingPlan')
    await DBOS.send(
      workflowId,
      { planJobId: 'plan-stale', planDigest, hasConflicts: false },
      'planResult',
      'plan-result-stale',
    )
    await waitForPhase(workflowId, 'awaitingApproval')
    await DBOS.send(
      workflowId,
      { approvalId: 'approval-stale', planDigest: `sha256:${'e'.repeat(64)}` },
      'approval',
      'approval-stale',
    )
    await expect(handle.getResult()).resolves.toEqual({ outcome: 'staleApproval' })
    expect(enqueued.has('apply-stale')).toBe(false)
  })

  it('persists cancellation and exposes an inspectable workflow timeline', async () => {
    const workflowId = 'switch-cancelled'
    await DBOS.startWorkflow(switchingWorkflow, { workflowID: workflowId })({
      operationId: 'operation-cancelled',
      planJobId: 'plan-cancelled',
      applyJobId: 'apply-cancelled',
      waitTimeoutSeconds: 20,
    })
    await waitForPhase(workflowId, 'awaitingPlan')
    await DBOS.cancelWorkflow(workflowId)

    await expect.poll(async () => (await DBOS.getWorkflowStatus(workflowId))?.status).toBe('CANCELLED')
    const steps = await DBOS.listWorkflowSteps(workflowId)
    expect(steps?.map((step) => step.name)).toContain('enqueuePlanJob')
    expect(enqueued.has('apply-cancelled')).toBe(false)
  })

  it('durably times out a missing runner result', async () => {
    const workflowId = 'switch-timeout'
    const handle = await DBOS.startWorkflow(switchingWorkflow, { workflowID: workflowId })({
      operationId: 'operation-timeout',
      planJobId: 'plan-timeout',
      applyJobId: 'apply-timeout',
      waitTimeoutSeconds: 0.2,
    })
    await expect(handle.getResult()).resolves.toEqual({ outcome: 'planTimedOut' })
    await expect(DBOS.getWorkflowStatus(workflowId)).resolves.toMatchObject({ status: 'SUCCESS' })
  })

  it('requires an explicit compatibility strategy for workflows waiting on an old version', async () => {
    const workflowId = 'switch-old-version'
    await DBOS.startWorkflow(switchingWorkflow, { workflowID: workflowId })({
      operationId: 'operation-old-version',
      planJobId: 'plan-old-version',
      applyJobId: 'apply-old-version',
      waitTimeoutSeconds: 20,
    })
    await waitForPhase(workflowId, 'awaitingPlan')

    await DBOS.shutdown({ deregister: true })
    configureRuntime('2')
    switchingWorkflow = registerDbosSwitchingSpike()
    await DBOS.launch()
    await DBOS.send(
      workflowId,
      { planJobId: 'plan-old-version', planDigest, hasConflicts: false },
      'planResult',
      'plan-result-old-version',
    )
    await delay(300)

    await expect(DBOS.getWorkflowStatus(workflowId)).resolves.toMatchObject({
      status: 'PENDING',
      applicationVersion: '1',
    })
    await expect(
      DBOS.getEvent<DbosSwitchingPhase>(workflowId, DBOS_SWITCHING_PHASE_EVENT),
    ).resolves.toBe('awaitingPlan')
    await DBOS.cancelWorkflow(workflowId)
  }, 30_000)
})
