import type { RunnerJobStatusResponse } from '@ahm/contracts'
import { describe, expect, it } from 'vitest'

import { applyReceipt, jobInFlight, preparedPlan, rollbackReceipt } from './switch-state'

const base: RunnerJobStatusResponse = {
  jobId: 'job_01',
  state: 'acknowledged',
  result: null,
  cancelRequested: false,
}

describe('Setup switch state', () => {
  it('keeps locally acknowledged jobs in progress', () => {
    expect(jobInFlight(base)).toBe(true)
    expect(jobInFlight({ ...base, state: 'succeeded' })).toBe(false)
  })

  it('extracts only matching successful result types', () => {
    const status: RunnerJobStatusResponse = {
      ...base,
      state: 'succeeded',
      result: {
        protocolVersion: '1.0',
        jobId: 'job_01',
        idempotencyKey: 'plan-job-01',
        organizationId: 'org_01',
        deviceId: 'device_01',
        projectInstanceId: 'instance_01',
        result: {
          kind: 'planResult',
          payload: {
            projectId: 'project_01',
            plan: {
              setupRevisionId: 'revision_01',
              planDigest: `sha256:${'a'.repeat(64)}`,
              actions: [],
              conflicts: [],
            },
          },
        },
      },
    }
    expect(preparedPlan(status)?.setupRevisionId).toBe('revision_01')
    expect(applyReceipt(status)).toBeNull()
    expect(rollbackReceipt(status)).toBeNull()
  })
})
