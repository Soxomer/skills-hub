import type { RunnerEnrollmentStatus, RunnerStatusResponse } from '@ahm/contracts'
import { describe, expect, it } from 'vitest'

import { connectionDisplayState, RUNNER_OFFLINE_AFTER_MS, workerHasReported } from './runner-status'

const claimed: RunnerEnrollmentStatus = {
  enrollmentId: 'enrollment_01',
  state: 'claimed',
  deviceId: 'runner_01',
  expiresAt: '2026-09-01T10:10:00.000Z',
}

function runner(overrides: Partial<RunnerStatusResponse> = {}): RunnerStatusResponse {
  return {
    deviceId: 'runner_01',
    label: 'Laptop',
    status: 'active',
    enrolledAt: '2026-09-01T10:00:00.000Z',
    lastSeenAt: null,
    capabilities: null,
    projectInstances: [],
    ...overrides,
  }
}

describe('runner connection display state', () => {
  it('covers ready, waiting, and expired enrollment states', () => {
    expect(connectionDisplayState(null, null)).toBe('ready')
    expect(connectionDisplayState({ ...claimed, state: 'waiting' }, null)).toBe('waiting')
    expect(connectionDisplayState({ ...claimed, state: 'expired' }, null)).toBe('expired')
  })

  it('shows a claimed runner as connected before its worker first reports', () => {
    expect(connectionDisplayState(claimed, runner())).toBe('connected')
    expect(workerHasReported(runner())).toBe(false)
  })

  it('derives online and offline health from the worker heartbeat', () => {
    const now = Date.parse('2026-09-01T10:00:30.000Z')
    const recent = runner({ lastSeenAt: new Date(now - RUNNER_OFFLINE_AFTER_MS).toISOString() })
    const stale = runner({ lastSeenAt: new Date(now - RUNNER_OFFLINE_AFTER_MS - 1).toISOString() })

    expect(connectionDisplayState(claimed, recent, now)).toBe('connected')
    expect(connectionDisplayState(claimed, stale, now)).toBe('offline')
    expect(workerHasReported(recent)).toBe(true)
  })

  it('keeps revocation distinct from an offline worker', () => {
    expect(connectionDisplayState(claimed, runner({ status: 'revoked' }))).toBe('revoked')
  })
})
