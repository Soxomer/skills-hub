import type { RunnerJobStatusResponse } from '@ahm/contracts'
import { describe, expect, it } from 'vitest'

import {
  actionablePlanCount,
  applyReceipt,
  cancelledWithoutMutation,
  cancellationReceipt,
  jobInFlight,
  preparedPlan,
  rollbackReceipt,
} from './switch-state'

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

  it('extracts cancellation receipts only from cancelled jobs', () => {
    const status: RunnerJobStatusResponse = {
      ...base,
      state: 'cancelled',
      result: {
        protocolVersion: '1.0',
        jobId: 'job_01',
        idempotencyKey: 'apply-job-01',
        organizationId: 'org_01',
        deviceId: 'device_01',
        projectInstanceId: 'instance_01',
        result: {
          kind: 'cancellationReceipt',
          payload: {
            projectId: 'project_01',
            operationId: 'operation_01',
            outcome: 'cancelledAndRestored',
            recoverability: 'notNeeded',
            actionsApplied: 1,
            completedAt: '2026-09-07T12:00:00.000Z',
          },
        },
      },
    }

    expect(cancellationReceipt(status)?.operationId).toBe('operation_01')
    expect(cancellationReceipt({ ...status, state: 'succeeded' })).toBeNull()
  })

  it('recognizes cancellation before any local mutation as a safe outcome', () => {
    expect(cancelledWithoutMutation({ ...base, state: 'cancelled' })).toBe(true)
    expect(
      cancelledWithoutMutation({
        ...base,
        state: 'failed',
        result: {
          protocolVersion: '1.0',
          jobId: 'job_01',
          idempotencyKey: 'plan-job-01',
          organizationId: 'org_01',
          deviceId: 'device_01',
          projectInstanceId: 'instance_01',
          result: {
            kind: 'error',
            payload: {
              code: 'jobCancelled',
              message: 'cancelled before mutation',
              retryable: false,
              recoverability: 'notNeeded',
            },
          },
        },
      }),
    ).toBe(true)
  })

  it('counts ownership-only updates as actionable plan work', () => {
    expect(
      actionablePlanCount({
        setupRevisionId: 'revision_01',
        planDigest: `sha256:${'a'.repeat(64)}`,
        conflicts: [],
        actions: [
          {
            actionId: 'action_01',
            artifactId: 'artifact_01',
            destination: {
              toolId: 'codex',
              projectRelativePath: '.codex/skills/pdf',
            },
            kind: 'copy',
            change: 'unchanged',
            metadataOnly: true,
          },
          {
            actionId: 'action_02',
            artifactId: 'artifact_02',
            destination: {
              toolId: 'codex',
              projectRelativePath: '.codex/skills/docs',
            },
            kind: 'copy',
            change: 'unchanged',
          },
        ],
      }),
    ).toBe(1)
  })
})
