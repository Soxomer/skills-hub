import type { RunnerEnrollmentStatus, RunnerStatusResponse } from '@ahm/contracts'

export const RUNNER_OFFLINE_AFTER_MS = 15_000

export type ConnectionDisplayState =
  | 'ready'
  | 'waiting'
  | 'connected'
  | 'offline'
  | 'expired'
  | 'revoked'

export function connectionDisplayState(
  enrollment: RunnerEnrollmentStatus | null,
  runner: RunnerStatusResponse | null,
  now = Date.now(),
): ConnectionDisplayState {
  if (!enrollment) return 'ready'
  if (enrollment.state === 'waiting') return 'waiting'
  if (enrollment.state === 'expired') return 'expired'
  if (runner?.status === 'revoked') return 'revoked'
  if (!runner?.lastSeenAt) return 'connected'
  return now - Date.parse(runner.lastSeenAt) > RUNNER_OFFLINE_AFTER_MS
    ? 'offline'
    : 'connected'
}

export function workerHasReported(runner: RunnerStatusResponse | null): boolean {
  return runner?.lastSeenAt !== null && runner?.lastSeenAt !== undefined
}
