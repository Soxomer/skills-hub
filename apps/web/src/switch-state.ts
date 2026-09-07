import type {
  CancellationReceipt,
  ApplyReceipt,
  CanonicalPlan,
  RollbackReceipt,
  RunnerJobStatusResponse,
} from '@ahm/contracts'

export function preparedPlan(status: RunnerJobStatusResponse | null): CanonicalPlan | null {
  return status?.state === 'succeeded' && status.result?.result.kind === 'planResult'
    ? status.result.result.payload.plan
    : null
}

export function applyReceipt(status: RunnerJobStatusResponse | null): ApplyReceipt['payload'] | null {
  return status?.state === 'succeeded' && status.result?.result.kind === 'applyReceipt'
    ? status.result.result.payload
    : null
}

export function rollbackReceipt(
  status: RunnerJobStatusResponse | null,
): RollbackReceipt['payload'] | null {
  return status?.state === 'succeeded' && status.result?.result.kind === 'rollbackReceipt'
    ? status.result.result.payload
    : null
}

export function cancellationReceipt(
  status: RunnerJobStatusResponse | null,
): CancellationReceipt['payload'] | null {
  return status?.state === 'cancelled' && status.result?.result.kind === 'cancellationReceipt'
    ? status.result.result.payload
    : null
}

export function cancelledWithoutMutation(status: RunnerJobStatusResponse | null): boolean {
  if (!status) return false
  if (status.state === 'cancelled' && status.result === null) return true
  return Boolean(
    status.result?.result.kind === 'error' &&
      status.result.result.payload.code === 'jobCancelled' &&
      status.result.result.payload.recoverability !== 'manualIntervention',
  )
}

export function actionablePlanCount(plan: CanonicalPlan): number {
  return plan.actions.filter(
    (action) => action.change !== 'unchanged' || action.metadataOnly === true,
  ).length
}

export function jobInFlight(status: RunnerJobStatusResponse | null): boolean {
  return Boolean(
    status &&
      (['pending', 'leased', 'acknowledged'] as RunnerJobStatusResponse['state'][]).includes(
        status.state,
      ),
  )
}
