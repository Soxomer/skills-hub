import type {
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

export function jobInFlight(status: RunnerJobStatusResponse | null): boolean {
  return Boolean(
    status &&
      (['pending', 'leased', 'acknowledged'] as RunnerJobStatusResponse['state'][]).includes(
        status.state,
      ),
  )
}
