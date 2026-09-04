import { DBOS } from '@dbos-inc/dbos-sdk'

export const DBOS_SWITCHING_WORKFLOW_NAME = 'ahmSetupSwitchingSpike'
export const DBOS_SWITCHING_PHASE_EVENT = 'phase'

export type DbosSwitchingPhase =
  | 'planQueued'
  | 'awaitingPlan'
  | 'awaitingApproval'
  | 'applyQueued'
  | 'awaitingReceipt'
  | 'complete'

export interface DbosSwitchingSpikeInput {
  operationId: string
  planJobId: string
  applyJobId: string
  waitTimeoutSeconds: number
}

export interface DbosPlanSignal {
  planJobId: string
  planDigest: string
  hasConflicts: boolean
}

export interface DbosApprovalSignal {
  approvalId: string
  planDigest: string
}

export interface DbosReceiptSignal {
  applyJobId: string
  planDigest: string
  outcome: 'applied' | 'failed' | 'needsAttention'
}

export type DbosSwitchingSpikeResult =
  | { outcome: 'applied'; planDigest: string; approvalId: string }
  | { outcome: 'planTimedOut' }
  | { outcome: 'approvalTimedOut' }
  | { outcome: 'receiptTimedOut' }
  | { outcome: 'planHasConflicts' }
  | { outcome: 'staleApproval' }
  | { outcome: 'receiptMismatch' }
  | { outcome: 'failed' | 'needsAttention'; planDigest: string; approvalId: string }

export interface DbosSwitchingSpikePort {
  enqueue(job: { jobId: string; kind: 'planSetup' | 'applyPlan'; operationId: string }): Promise<void>
}

let activePort: DbosSwitchingSpikePort | undefined

export function configureDbosSwitchingSpikePort(port: DbosSwitchingSpikePort): void {
  activePort = port
}

async function enqueueJob(
  jobId: string,
  kind: 'planSetup' | 'applyPlan',
  operationId: string,
): Promise<void> {
  if (!activePort) throw new Error('DBOS switching spike port is not configured')
  await activePort.enqueue({ jobId, kind, operationId })
}

async function phase(value: DbosSwitchingPhase): Promise<void> {
  await DBOS.setEvent(DBOS_SWITCHING_PHASE_EVENT, value)
}

export function registerDbosSwitchingSpike(): (
  input: DbosSwitchingSpikeInput,
) => Promise<DbosSwitchingSpikeResult> {
  return DBOS.registerWorkflow(
    async (input: DbosSwitchingSpikeInput): Promise<DbosSwitchingSpikeResult> => {
      await DBOS.runStep(
        () => enqueueJob(input.planJobId, 'planSetup', input.operationId),
        { name: 'enqueuePlanJob' },
      )
      await phase('planQueued')
      await phase('awaitingPlan')

      const plan = await DBOS.recv<DbosPlanSignal>('planResult', {
        timeoutSeconds: input.waitTimeoutSeconds,
      })
      if (!plan) return { outcome: 'planTimedOut' }
      if (plan.hasConflicts) return { outcome: 'planHasConflicts' }

      await phase('awaitingApproval')
      const approval = await DBOS.recv<DbosApprovalSignal>('approval', {
        timeoutSeconds: input.waitTimeoutSeconds,
      })
      if (!approval) return { outcome: 'approvalTimedOut' }
      if (approval.planDigest !== plan.planDigest) return { outcome: 'staleApproval' }

      await DBOS.runStep(
        () => enqueueJob(input.applyJobId, 'applyPlan', input.operationId),
        { name: 'enqueueApplyJob' },
      )
      await phase('applyQueued')
      await phase('awaitingReceipt')

      const receipt = await DBOS.recv<DbosReceiptSignal>('applyReceipt', {
        timeoutSeconds: input.waitTimeoutSeconds,
      })
      if (!receipt) return { outcome: 'receiptTimedOut' }
      if (receipt.applyJobId !== input.applyJobId || receipt.planDigest !== plan.planDigest) {
        return { outcome: 'receiptMismatch' }
      }

      await phase('complete')
      return {
        outcome: receipt.outcome,
        planDigest: plan.planDigest,
        approvalId: approval.approvalId,
      }
    },
    { name: DBOS_SWITCHING_WORKFLOW_NAME },
  )
}
