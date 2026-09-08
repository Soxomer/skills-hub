// @vitest-environment happy-dom
import type { CaptureDefaultRevisionResponse, ProjectInstanceOperationsResponse, RunnerJobStatusResponse } from '@ahm/contracts'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ControlPlaneClient } from './api'
import { ProjectSwitchWorkspace } from './components/ProjectSwitchWorkspace'
import './i18n'
import { useProjectScan } from './useProjectScan'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const date = '2026-09-08T10:00:00Z'
const projects = ['A', 'B'].map((projectId) => ({
  projectId, name: projectId, repositoryIdentity: null, defaultRevision: null,
  createdAt: date, updatedAt: date,
}))

function scanResult(jobId = 'scan-A'): RunnerJobStatusResponse {
  return {
    jobId, state: 'succeeded', cancelRequested: false,
    result: {
      protocolVersion: '1.0', jobId, idempotencyKey: jobId,
      organizationId: 'org', deviceId: 'device', projectInstanceId: 'instance-A',
      result: { kind: 'scanResult', payload: { projectId: 'A', discoveries: [{
        discoveryId: 'skill-A', kind: 'skill', state: 'available', name: 'Skill A',
        toolId: 'codex', portableSource: null, contentDigest: 'sha256:a',
      }] } },
    },
  }
}

function mockClient() {
  return {
    projects: vi.fn().mockResolvedValue({ projects }),
    scanProject: vi.fn().mockResolvedValue({ jobId: 'scan-A' }),
    job: vi.fn().mockResolvedValue(scanResult()),
    captureDefault: vi.fn(),
    setupRevisions: vi.fn().mockResolvedValue({
      projectId: 'A', defaultSetupRevisionId: 'default-A', assignedSetupRevisionId: 'custom',
      revisions: [{ setupId: 'setup', setupRevisionId: 'custom', name: 'Custom', kind: 'custom',
        revisionNumber: 1, itemCount: 1, createdAt: date }],
    }),
    projectOperations: vi.fn(),
    rollbackSetup: vi.fn().mockResolvedValue({ jobId: 'rollback-job' }),
  }
}

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  sessionStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mountScan(client: ReturnType<typeof mockClient>) {
  let workflow!: ReturnType<typeof useProjectScan>
  function Harness() {
    const value = useProjectScan(client as unknown as ControlPlaneClient)
    useEffect(() => { workflow = value })
    return null
  }
  await act(async () => root.render(<Harness />))
  return () => workflow
}

describe('project onboarding request isolation', () => {
  it('ignores a scan queued for A after switching to B, including its busy state', async () => {
    const client = mockClient()
    const pending = deferred<{ jobId: string }>()
    client.scanProject.mockReturnValueOnce(pending.promise)
    const current = await mountScan(client)
    let request!: Promise<boolean>
    await act(async () => { request = current().startScan('instance-A') })
    await act(async () => current().selectProject('B'))
    expect(current().startingScan).toBe(false)
    const pendingB = deferred<{ jobId: string }>()
    client.scanProject.mockReturnValueOnce(pendingB.promise)
    let requestB!: Promise<boolean>
    await act(async () => { requestB = current().startScan('instance-B') })
    await act(async () => { pending.resolve({ jobId: 'scan-A' }); await request })
    expect(current().selectedProjectId).toBe('B')
    expect(current().scan).toBeNull()
    expect(current().jobStatus).toBeNull()
    expect(current().startingScan).toBe(true)
    await act(async () => { pendingB.resolve({ jobId: 'scan-B' }); await requestB })
    expect(current().scan?.jobId).toBe('scan-B')
    expect(current().startingScan).toBe(false)
  })

  it('ignores A status after switching away and back, even with the same project ID', async () => {
    const client = mockClient()
    const current = await mountScan(client)
    await act(async () => { await current().startScan('instance-A') })
    const pending = deferred<RunnerJobStatusResponse>()
    client.job.mockReturnValueOnce(pending.promise)
    let request!: Promise<void>
    await act(async () => { request = current().refreshJob() })
    await act(async () => current().selectProject('B'))
    await act(async () => current().selectProject('A'))
    await act(async () => { pending.resolve(scanResult()); await request })
    expect(current().scan).toBeNull()
    expect(current().discoveries).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('ignores a late capture %s after selecting B', async (outcome) => {
    const client = mockClient()
    const current = await mountScan(client)
    await act(async () => { await current().startScan('instance-A') })
    await act(async () => { await current().refreshJob() })
    const pending = deferred<CaptureDefaultRevisionResponse>()
    client.captureDefault.mockReturnValueOnce(pending.promise)
    let request!: Promise<boolean>
    await act(async () => { request = current().captureDefault() })
    await act(async () => current().selectProject('B'))
    await act(async () => {
      if (outcome === 'resolve') pending.resolve({ projectId: 'A', created: true, defaultRevision: {
        setupId: 'default', setupRevisionId: 'revision-A', revisionNumber: 1,
        sourceScanJobId: 'scan-A', itemCount: 1, createdAt: date,
      } })
      else pending.reject(new Error('late capture failure'))
      await request
    })
    expect(current().selectedProjectId).toBe('B')
    expect(current().capture).toBeNull()
    expect(current().error).toBeNull()
    expect(current().capturing).toBe(false)
  })

  it('preserves normal successful capture for the selected project', async () => {
    const client = mockClient()
    const captured: CaptureDefaultRevisionResponse = { projectId: 'A', created: true, defaultRevision: {
      setupId: 'default', setupRevisionId: 'revision-A', revisionNumber: 1,
      sourceScanJobId: 'scan-A', itemCount: 1, createdAt: date,
    } }
    client.captureDefault.mockResolvedValue(captured)
    const current = await mountScan(client)
    await act(async () => { await current().startScan('instance-A') })
    await act(async () => { await current().refreshJob() })
    await act(async () => { await current().captureDefault() })
    expect(current().capture).toEqual(captured)
    expect(client.captureDefault).toHaveBeenCalledWith('A', {
      scanJobId: 'scan-A', includedDiscoveryIds: ['skill-A'],
    })
  })
})

function operations(): ProjectInstanceOperationsResponse {
  return {
    projectInstanceId: 'instance-A', assignedSetupRevisionId: 'custom', materializedSetupRevisionId: 'custom',
    health: 'current', activeOperation: null, reviewedPlan: null,
    operations: [{ jobId: 'apply-job', kind: 'applyPlan', state: 'succeeded', setupRevisionId: 'custom',
      operationId: 'durable-operation', outcome: 'applied', recoverability: 'rollbackAvailable',
      errorCode: null, retryable: null, issuedAt: date, completedAt: date }],
  }
}

async function mountSwitch(client: ReturnType<typeof mockClient>, online = true) {
  await act(async () => root.render(<ProjectSwitchWorkspace
    client={client as unknown as ControlPlaneClient} projectId="A" projectInstanceId="instance-A" runnerOnline={online}
  />))
}

function rollbackButton() {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Rollback')
}

describe('durable operation recovery', () => {
  it('restores the history action on a fresh mount and submits the durable operation ID', async () => {
    const client = mockClient()
    client.projectOperations.mockResolvedValue(operations())
    await mountSwitch(client)
    expect(rollbackButton()).toBeDefined()
    await act(async () => { root.unmount() })
    root = createRoot(container)
    await mountSwitch(client)
    await act(async () => rollbackButton()!.click())
    expect(client.rollbackSetup).toHaveBeenCalledWith('instance-A', { operationId: 'durable-operation' })
  })

  it('keeps durable recovery visible but disabled while offline', async () => {
    const client = mockClient()
    client.projectOperations.mockResolvedValue(operations())
    await mountSwitch(client, false)
    expect(rollbackButton()?.disabled).toBe(true)
    expect(client.rollbackSetup).not.toHaveBeenCalled()
  })

  it.each(['rolledBack', 'newerApply', 'attention', 'active', 'notRecoverable'] as const)(
    'does not offer an obsolete rollback for %s state', async (state) => {
      const client = mockClient()
      const status = operations()
      if (state === 'rolledBack') status.operations.unshift({ ...status.operations[0],
        jobId: 'rollback', kind: 'rollbackOperation', outcome: 'rolledBack' })
      if (state === 'newerApply') status.operations.unshift({ ...status.operations[0],
        jobId: 'newer', operationId: 'newer-operation', recoverability: 'notNeeded' })
      if (state === 'attention') status.health = 'attention'
      if (state === 'active') status.activeOperation = { jobId: 'active', kind: 'applyPlan', state: 'pending',
        setupRevisionId: 'custom', cancelRequested: false, issuedAt: date }
      if (state === 'notRecoverable') status.operations[0].recoverability = 'notNeeded'
      client.projectOperations.mockResolvedValue(status)
      await mountSwitch(client)
      expect(rollbackButton()).toBeUndefined()
    },
  )
})
