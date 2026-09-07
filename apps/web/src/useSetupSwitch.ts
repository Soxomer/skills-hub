import type {
  CancellationReceipt,
  ApplyReceipt,
  CanonicalPlan,
  ProjectActiveOperation,
  ProjectInstanceOperationsResponse,
  ProjectSetupStateResponse,
  RollbackReceipt,
  RunnerJobStatusResponse,
} from '@ahm/contracts'
import { useCallback, useEffect, useState } from 'react'

import { ControlPlaneApiError, type ControlPlaneClient } from './api'
import {
  applyReceipt,
  cancellationReceipt,
  jobInFlight,
  preparedPlan,
  rollbackReceipt,
} from './switch-state'

const POLL_INTERVAL_MS = 750

type SwitchStage = 'revisions' | 'plan' | 'status' | 'apply' | 'rollback'

export interface SetupSwitchError {
  stage: SwitchStage
  code: string | null
}

interface ActiveJob {
  kind: 'plan' | 'apply' | 'rollback'
  jobId: string
}

function mapActiveOperation(operation: ProjectActiveOperation | null): ActiveJob | null {
  if (!operation) return null
  const map: Record<ProjectActiveOperation['kind'], ActiveJob['kind']> = {
    planSetup: 'plan',
    applyPlan: 'apply',
    rollbackOperation: 'rollback',
  }
  return {
    kind: map[operation.kind],
    jobId: operation.jobId,
  }
}

function workflowError(stage: SwitchStage, error: unknown): SetupSwitchError {
  return {
    stage,
    code: error instanceof ControlPlaneApiError ? error.code : null,
  }
}

export function useSetupSwitch(
  client: ControlPlaneClient,
  projectId: string,
  projectInstanceId: string,
) {
  const [state, setState] = useState<ProjectSetupStateResponse | null>(null)
  const [operations, setOperations] = useState<ProjectInstanceOperationsResponse | null>(null)
  const [selectedRevisionId, setSelectedRevisionId] = useState('')
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)
  const [jobStatus, setJobStatus] = useState<RunnerJobStatusResponse | null>(null)
  const [plan, setPlan] = useState<CanonicalPlan | null>(null)
  const [planJobId, setPlanJobId] = useState<string | null>(null)
  const [cancellation, setCancellation] = useState<CancellationReceipt['payload'] | null>(null)
  const [receipt, setReceipt] = useState<ApplyReceipt['payload'] | null>(null)
  const [restored, setRestored] = useState<RollbackReceipt['payload'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<SetupSwitchError | null>(null)

  const refreshState = useCallback(async () => {
    if (!projectId || !projectInstanceId) return
    setLoading(true)
    try {
      const [next, nextOperations] = await Promise.all([
        client.setupRevisions(projectId),
        client.projectOperations(projectInstanceId),
      ])
      setState(next)
      setOperations(nextOperations)
      setSelectedRevisionId((current) =>
        current && next.revisions.some((revision) => revision.setupRevisionId === current)
          ? current
          : (next.assignedSetupRevisionId ?? next.defaultSetupRevisionId ?? next.revisions[0]?.setupRevisionId ?? ''),
      )
      setError((current) => (current?.stage === 'revisions' ? null : current))
    } catch (nextError) {
      setError(workflowError('revisions', nextError))
    } finally {
      setLoading(false)
    }
  }, [client, projectId, projectInstanceId])

  useEffect(() => {
    setState(null)
    setOperations(null)
    setSelectedRevisionId('')
    setActiveJob(null)
    setJobStatus(null)
    setPlan(null)
    setPlanJobId(null)
    setCancellation(null)
    setReceipt(null)
    setRestored(null)
    setError(null)
    void refreshState()
  }, [projectInstanceId, refreshState])

  const refreshJob = useCallback(async () => {
    const trackedJob = activeJob ?? mapActiveOperation(operations?.activeOperation)
    if (!trackedJob) return
    try {
      const status = await client.job(trackedJob.jobId)
      setJobStatus(status)
      const nextPlan = preparedPlan(status)
      const nextCancellation = cancellationReceipt(status)
      const nextReceipt = applyReceipt(status)
      const nextRestored = rollbackReceipt(status)
      if (nextPlan) {
        setPlan(nextPlan)
        setPlanJobId(trackedJob.jobId)
      }
      if (nextReceipt) {
        setCancellation(null)
        setReceipt(nextReceipt)
        setRestored(null)
        await refreshState()
      } else if (nextRestored) {
        setCancellation(null)
        setReceipt(null)
        setRestored(nextRestored)
        await refreshState()
      } else if (nextCancellation) {
        setCancellation(nextCancellation)
        setReceipt(null)
        setRestored(null)
        await refreshState()
      }
      if (!jobInFlight(status)) {
        if (trackedJob.kind === 'apply') {
          setPlan(null)
          setPlanJobId(null)
        }
        await refreshState()
        setActiveJob((current) => (current?.jobId === trackedJob.jobId ? null : current))
      }
      if (status.state === 'failed' && status.result?.result.kind === 'error') {
        setError({ stage: trackedJob.kind, code: status.result.result.payload.code })
      } else {
        setError((current) => (current?.stage === 'status' ? null : current))
      }
    } catch (nextError) {
      setError(workflowError('status', nextError))
    }
  }, [activeJob, client, operations?.activeOperation, refreshState])

  useEffect(() => {
    if (activeJob || !operations?.activeOperation) return
    const pending = mapActiveOperation(operations.activeOperation)
    if (pending) {
      setActiveJob(pending)
    }
  }, [activeJob, operations?.activeOperation?.jobId, operations?.activeOperation?.kind])

  useEffect(() => {
    const trackedJob = activeJob ?? mapActiveOperation(operations?.activeOperation)
    if (
      !trackedJob ||
      (jobStatus && jobStatus.jobId === trackedJob.jobId && !jobInFlight(jobStatus))
    ) {
      return
    }
    const interval = window.setInterval(() => void refreshJob(), POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [activeJob, jobStatus, operations?.activeOperation, refreshJob])

  const selectRevision = useCallback((revisionId: string) => {
    setSelectedRevisionId(revisionId)
    setActiveJob(null)
    setJobStatus(null)
    setPlan(null)
    setPlanJobId(null)
    setCancellation(null)
    setReceipt(null)
    setRestored(null)
    setError(null)
  }, [])

  const preparePlan = useCallback(async (revisionId = selectedRevisionId) => {
    if (!revisionId || !projectInstanceId) return false
    setSubmitting(true)
    setError(null)
    try {
      setSelectedRevisionId(revisionId)
      const queued = await client.prepareSetupPlan(projectInstanceId, {
        setupRevisionId: revisionId,
      })
      setActiveJob({ kind: 'plan', jobId: queued.jobId })
      setJobStatus({
        jobId: queued.jobId,
        state: 'pending',
        result: null,
        cancelRequested: false,
      })
      setCancellation(null)
      setPlan(null)
      setPlanJobId(null)
      setReceipt(null)
      setRestored(null)
      return true
    } catch (nextError) {
      setError(workflowError('plan', nextError))
      return false
    } finally {
      setSubmitting(false)
    }
  }, [client, projectInstanceId, selectedRevisionId])

  const applyPlan = useCallback(async () => {
    if (!plan || !planJobId) return false
    setSubmitting(true)
    setError(null)
    try {
      const queued = await client.applySetupPlan(projectInstanceId, {
        planJobId,
        planDigest: plan.planDigest,
      })
      setActiveJob({ kind: 'apply', jobId: queued.jobId })
      setJobStatus({
        jobId: queued.jobId,
        state: 'pending',
        result: null,
        cancelRequested: false,
      })
      setCancellation(null)
      return true
    } catch (nextError) {
      setError(workflowError('apply', nextError))
      return false
    } finally {
      setSubmitting(false)
    }
  }, [client, plan, planJobId, projectInstanceId])

  const rollback = useCallback(async () => {
    if (!receipt || !projectInstanceId) return false
    setSubmitting(true)
    setError(null)
    try {
      const queued = await client.rollbackSetup(projectInstanceId, {
        operationId: receipt.operationId,
      })
      setActiveJob({ kind: 'rollback', jobId: queued.jobId })
      setJobStatus({
        jobId: queued.jobId,
        state: 'pending',
        result: null,
        cancelRequested: false,
      })
      setCancellation(null)
      return true
    } catch (nextError) {
      setError(workflowError('rollback', nextError))
      return false
    } finally {
      setSubmitting(false)
    }
  }, [client, projectInstanceId, receipt])

  const recoverFromCancellation = useCallback(() => {
    setActiveJob(null)
    setJobStatus(null)
    setPlan(null)
    setPlanJobId(null)
    setCancellation(null)
    setError(null)
  }, [])

  return {
    state,
    operations,
    selectedRevisionId,
    selectedRevision:
      state?.revisions.find((revision) => revision.setupRevisionId === selectedRevisionId) ?? null,
    activeJob,
    jobStatus,
    plan,
    cancellation,
    receipt,
    restored,
    loading,
    submitting,
    error,
    refreshState,
    refreshJob,
    selectRevision,
    preparePlan,
    applyPlan,
    rollback,
    recoverFromCancellation,
  }
}
