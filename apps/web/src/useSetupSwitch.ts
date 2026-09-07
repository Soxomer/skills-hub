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
import { useCallback, useEffect, useRef, useState } from 'react'

import { ControlPlaneApiError, type ControlPlaneClient } from './api'
import {
  applyReceipt,
  cancellationReceipt,
  cancelledWithoutMutation,
  jobInFlight,
  preparedPlan,
  rollbackReceipt,
} from './switch-state'

const POLL_INTERVAL_MS = 750
const OPERATIONS_POLL_INTERVAL_MS = 1_500

type SwitchStage = 'revisions' | 'plan' | 'status' | 'apply' | 'rollback' | 'cancel'

export interface SetupSwitchError {
  stage: SwitchStage
  code: string | null
}

interface ActiveJob {
  kind: 'plan' | 'apply' | 'rollback'
  jobId: string
  setupRevisionId: string | null
}

function mapActiveOperation(operation: ProjectActiveOperation | null | undefined): ActiveJob | null {
  if (!operation) return null
  const map: Record<ProjectActiveOperation['kind'], ActiveJob['kind']> = {
    planSetup: 'plan',
    applyPlan: 'apply',
    rollbackOperation: 'rollback',
  }
  return {
    kind: map[operation.kind],
    jobId: operation.jobId,
    setupRevisionId: operation.setupRevisionId,
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
  const contextKey = `${projectId}:${projectInstanceId}`
  const contextKeyRef = useRef(contextKey)
  contextKeyRef.current = contextKey
  const [loadedContextKey, setLoadedContextKey] = useState(contextKey)
  const contextReady = loadedContextKey === contextKey
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
  const [operationConflict, setOperationConflict] = useState<ProjectActiveOperation | null>(null)
  const [planWasStale, setPlanWasStale] = useState(false)
  const [cancelledSafely, setCancelledSafely] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<SetupSwitchError | null>(null)
  const refreshingJob = useRef(false)
  const jobRequestSequence = useRef(0)
  const handledTerminalJobs = useRef(new Set<string>())
  const operationsRequestSequence = useRef(0)
  const adoptedReviewedPlanJobId = useRef<string | null>(null)
  const dismissedReviewedPlanJobId = useRef<string | null>(null)
  const planJobIdRef = useRef<string | null>(null)
  planJobIdRef.current = planJobId

  const adoptOperations = useCallback((next: ProjectInstanceOperationsResponse) => {
    setOperations(next)
    const serverJob = mapActiveOperation(next.activeOperation)
    if (serverJob) {
      setActiveJob((current) => (current?.jobId === serverJob.jobId ? current : serverJob))
      if (serverJob.setupRevisionId) setSelectedRevisionId(serverJob.setupRevisionId)
      return
    }
    if (
      next.reviewedPlan &&
      next.reviewedPlan.jobId !== dismissedReviewedPlanJobId.current
    ) {
      setPlan(next.reviewedPlan.plan)
      setPlanJobId(next.reviewedPlan.jobId)
      if (adoptedReviewedPlanJobId.current !== next.reviewedPlan.jobId) {
        setSelectedRevisionId(next.reviewedPlan.plan.setupRevisionId)
        adoptedReviewedPlanJobId.current = next.reviewedPlan.jobId
      }
    } else {
      setPlan(null)
      setPlanJobId(null)
      if (!next.reviewedPlan) adoptedReviewedPlanJobId.current = null
    }
  }, [])

  const adoptOperationConflict = useCallback((nextError: unknown): boolean => {
    if (!(nextError instanceof ControlPlaneApiError) || !nextError.activeOperation) return false
    const serverJob = mapActiveOperation(nextError.activeOperation)
    setOperationConflict(nextError.activeOperation)
    setOperations((current) =>
      current ? { ...current, activeOperation: nextError.activeOperation } : current,
    )
    setActiveJob(serverJob)
    if (serverJob?.setupRevisionId) setSelectedRevisionId(serverJob.setupRevisionId)
    setError(null)
    return true
  }, [])

  const refreshState = useCallback(async () => {
    if (!projectId || !projectInstanceId) return
    const requestContext = contextKey
    const requestSequence = ++operationsRequestSequence.current
    setLoading(true)
    try {
      const [next, nextOperations] = await Promise.all([
        client.setupRevisions(projectId),
        client.projectOperations(projectInstanceId),
      ])
      if (contextKeyRef.current !== requestContext) return
      setState(next)
      if (operationsRequestSequence.current === requestSequence) adoptOperations(nextOperations)
      setSelectedRevisionId((current) =>
        current && next.revisions.some((revision) => revision.setupRevisionId === current)
          ? current
          : (next.assignedSetupRevisionId ?? next.defaultSetupRevisionId ?? next.revisions[0]?.setupRevisionId ?? ''),
      )
      setError((current) => (current?.stage === 'revisions' ? null : current))
    } catch (nextError) {
      if (contextKeyRef.current === requestContext) {
        setError(workflowError('revisions', nextError))
      }
    } finally {
      if (contextKeyRef.current === requestContext) setLoading(false)
    }
  }, [adoptOperations, client, contextKey, projectId, projectInstanceId])

  useEffect(() => {
    setLoadedContextKey(contextKey)
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
    setOperationConflict(null)
    setPlanWasStale(false)
    setCancelledSafely(false)
    setSubmitting(false)
    setError(null)
    refreshingJob.current = false
    jobRequestSequence.current += 1
    handledTerminalJobs.current.clear()
    operationsRequestSequence.current += 1
    adoptedReviewedPlanJobId.current = null
    dismissedReviewedPlanJobId.current = null
    void refreshState()
  }, [contextKey, refreshState])

  const refreshOperations = useCallback(async () => {
    if (!projectInstanceId) return
    const requestContext = contextKey
    const requestSequence = ++operationsRequestSequence.current
    try {
      const nextOperations = await client.projectOperations(projectInstanceId)
      if (
        contextKeyRef.current !== requestContext ||
        operationsRequestSequence.current !== requestSequence
      ) return
      adoptOperations(nextOperations)
    } catch (nextError) {
      if (contextKeyRef.current === requestContext) {
        setError(workflowError('status', nextError))
      }
    }
  }, [adoptOperations, client, contextKey, projectInstanceId])

  useEffect(() => {
    if (!projectInstanceId) return
    const interval = window.setInterval(() => void refreshOperations(), OPERATIONS_POLL_INTERVAL_MS)
    const onFocus = () => void refreshOperations()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectInstanceId, refreshOperations])

  const refreshJob = useCallback(async () => {
    if (!contextReady) return
    const trackedJob = activeJob ?? mapActiveOperation(operations?.activeOperation)
    if (!trackedJob || refreshingJob.current) return
    const requestContext = contextKey
    const requestSequence = ++jobRequestSequence.current
    refreshingJob.current = true
    try {
      const status = await client.job(trackedJob.jobId)
      if (contextKeyRef.current !== requestContext) return
      setJobStatus(status)
      if (!jobInFlight(status)) {
        if (handledTerminalJobs.current.has(trackedJob.jobId)) return
        handledTerminalJobs.current.add(trackedJob.jobId)
      }
      const nextPlan = preparedPlan(status)
      const nextCancellation = cancellationReceipt(status)
      const nextSafeCancellation = cancelledWithoutMutation(status)
      const nextReceipt = applyReceipt(status)
      const nextRestored = rollbackReceipt(status)
      if (nextPlan) {
        setPlan(nextPlan)
        setPlanJobId(trackedJob.jobId)
      }
      if (nextReceipt) {
        setCancelledSafely(false)
        setCancellation(null)
        setReceipt(nextReceipt)
        setRestored(null)
      } else if (nextRestored) {
        setCancelledSafely(false)
        setCancellation(null)
        setReceipt(null)
        setRestored(nextRestored)
      } else if (nextCancellation) {
        setCancelledSafely(false)
        setCancellation(nextCancellation)
        setReceipt(null)
        setRestored(null)
      } else if (nextSafeCancellation) {
        setCancellation(null)
        setCancelledSafely(true)
        setReceipt(null)
        setRestored(null)
        setError(null)
      }
      if (!jobInFlight(status)) {
        if (trackedJob.kind === 'apply') {
          setPlan(null)
          setPlanJobId(null)
        }
        await refreshState()
        if (contextKeyRef.current !== requestContext) return
        setActiveJob((current) => (current?.jobId === trackedJob.jobId ? null : current))
      }
      if (
        trackedJob.kind === 'apply' &&
        status.state === 'failed' &&
        status.result?.result.kind === 'error' &&
        status.result.result.payload.code === 'planDigestMismatch' &&
        trackedJob.setupRevisionId
      ) {
        setPlanWasStale(true)
        setError(null)
        try {
          const queued = await client.prepareSetupPlan(projectInstanceId, {
            setupRevisionId: trackedJob.setupRevisionId,
          })
          if (contextKeyRef.current !== requestContext) return
          setActiveJob({
            kind: 'plan',
            jobId: queued.jobId,
            setupRevisionId: trackedJob.setupRevisionId,
          })
          setJobStatus({
            jobId: queued.jobId,
            state: 'pending',
            result: null,
            cancelRequested: false,
          })
        } catch (nextError) {
          if (contextKeyRef.current !== requestContext) return
          if (!adoptOperationConflict(nextError)) setError(workflowError('status', nextError))
        }
      } else if (
        !nextSafeCancellation &&
        status.state === 'failed' &&
        status.result?.result.kind === 'error'
      ) {
        setError({ stage: trackedJob.kind, code: status.result.result.payload.code })
      } else {
        setError((current) => (current?.stage === 'status' ? null : current))
      }
    } catch (nextError) {
      if (contextKeyRef.current === requestContext) {
        setError(workflowError('status', nextError))
      }
    } finally {
      if (jobRequestSequence.current === requestSequence) refreshingJob.current = false
    }
  }, [
    activeJob,
    adoptOperationConflict,
    client,
    contextKey,
    contextReady,
    operations?.activeOperation,
    projectInstanceId,
    refreshState,
  ])

  useEffect(() => {
    if (!contextReady || activeJob || !operations?.activeOperation) return
    const pending = mapActiveOperation(operations.activeOperation)
    if (pending) {
      setActiveJob(pending)
    }
  }, [activeJob, contextReady, operations?.activeOperation])

  useEffect(() => {
    const trackedJob = activeJob ?? mapActiveOperation(operations?.activeOperation)
    if (
      !contextReady ||
      !trackedJob ||
      (jobStatus && jobStatus.jobId === trackedJob.jobId && !jobInFlight(jobStatus))
    ) {
      return
    }
    const timeout = window.setTimeout(() => void refreshJob(), POLL_INTERVAL_MS)
    return () => window.clearTimeout(timeout)
  }, [activeJob, contextReady, jobStatus, operations?.activeOperation, refreshJob])

  const selectRevision = useCallback((revisionId: string) => {
    if (!contextReady) return
    dismissedReviewedPlanJobId.current = planJobIdRef.current
    setSelectedRevisionId(revisionId)
    setActiveJob(null)
    setJobStatus(null)
    setPlan(null)
    setPlanJobId(null)
    setCancellation(null)
    setReceipt(null)
    setRestored(null)
    setOperationConflict(null)
    setPlanWasStale(false)
    setCancelledSafely(false)
    setError(null)
  }, [contextReady])

  const preparePlan = useCallback(async (revisionId = selectedRevisionId) => {
    if (!contextReady || !revisionId || !projectInstanceId) return false
    setSubmitting(true)
    setError(null)
    try {
      setSelectedRevisionId(revisionId)
      const queued = await client.prepareSetupPlan(projectInstanceId, {
        setupRevisionId: revisionId,
      })
      if (contextKeyRef.current !== contextKey) return false
      dismissedReviewedPlanJobId.current = null
      setActiveJob({ kind: 'plan', jobId: queued.jobId, setupRevisionId: revisionId })
      setJobStatus({
        jobId: queued.jobId,
        state: 'pending',
        result: null,
        cancelRequested: false,
      })
      setCancellation(null)
      setCancelledSafely(false)
      setPlan(null)
      setPlanJobId(null)
      setReceipt(null)
      setRestored(null)
      return true
    } catch (nextError) {
      if (contextKeyRef.current !== contextKey) return false
      if (adoptOperationConflict(nextError)) return false
      setError(workflowError('plan', nextError))
      return false
    } finally {
      if (contextKeyRef.current === contextKey) setSubmitting(false)
    }
  }, [adoptOperationConflict, client, contextKey, contextReady, projectInstanceId, selectedRevisionId])

  const applyPlan = useCallback(async () => {
    if (!contextReady || !plan || !planJobId) return false
    setSubmitting(true)
    setError(null)
    try {
      const queued = await client.applySetupPlan(projectInstanceId, {
        planJobId,
        planDigest: plan.planDigest,
      })
      if (contextKeyRef.current !== contextKey) return false
      setActiveJob({
        kind: 'apply',
        jobId: queued.jobId,
        setupRevisionId: plan.setupRevisionId,
      })
      setJobStatus({
        jobId: queued.jobId,
        state: 'pending',
        result: null,
        cancelRequested: false,
      })
      setCancellation(null)
      setCancelledSafely(false)
      return true
    } catch (nextError) {
      if (contextKeyRef.current !== contextKey) return false
      if (adoptOperationConflict(nextError)) return false
      if (nextError instanceof ControlPlaneApiError && nextError.code === 'planDigestMismatch') {
        setPlanWasStale(true)
        setPlan(null)
        setPlanJobId(null)
        setSubmitting(false)
        return preparePlan(plan.setupRevisionId)
      }
      setError(workflowError('apply', nextError))
      return false
    } finally {
      if (contextKeyRef.current === contextKey) setSubmitting(false)
    }
  }, [
    adoptOperationConflict,
    client,
    contextKey,
    contextReady,
    plan,
    planJobId,
    preparePlan,
    projectInstanceId,
  ])

  const rollback = useCallback(async () => {
    if (!contextReady || !receipt || !projectInstanceId) return false
    setSubmitting(true)
    setError(null)
    try {
      const queued = await client.rollbackSetup(projectInstanceId, {
        operationId: receipt.operationId,
      })
      if (contextKeyRef.current !== contextKey) return false
      setActiveJob({ kind: 'rollback', jobId: queued.jobId, setupRevisionId: null })
      setJobStatus({
        jobId: queued.jobId,
        state: 'pending',
        result: null,
        cancelRequested: false,
      })
      setCancellation(null)
      setCancelledSafely(false)
      return true
    } catch (nextError) {
      if (contextKeyRef.current !== contextKey) return false
      if (adoptOperationConflict(nextError)) return false
      setError(workflowError('rollback', nextError))
      return false
    } finally {
      if (contextKeyRef.current === contextKey) setSubmitting(false)
    }
  }, [adoptOperationConflict, client, contextKey, contextReady, projectInstanceId, receipt])

  const keepOperationRunning = useCallback(() => setOperationConflict(null), [])

  const cancelActiveOperation = useCallback(async () => {
    if (!contextReady) return false
    const trackedJob = activeJob ?? mapActiveOperation(operations?.activeOperation)
    if (!trackedJob) return false
    setSubmitting(true)
    setError(null)
    try {
      await client.cancelJob(trackedJob.jobId)
      if (contextKeyRef.current !== contextKey) return false
      setOperationConflict(null)
      setJobStatus((current) =>
        current?.jobId === trackedJob.jobId ? { ...current, cancelRequested: true } : current,
      )
      setOperations((current) =>
        current?.activeOperation?.jobId === trackedJob.jobId
          ? {
              ...current,
              activeOperation: { ...current.activeOperation, cancelRequested: true },
            }
          : current,
      )
      return true
    } catch (nextError) {
      if (contextKeyRef.current !== contextKey) return false
      setError(workflowError('cancel', nextError))
      return false
    } finally {
      if (contextKeyRef.current === contextKey) setSubmitting(false)
    }
  }, [activeJob, client, contextKey, contextReady, operations?.activeOperation])

  const retryRecovery = useCallback(() => {
    const revisionId = state?.assignedSetupRevisionId ?? selectedRevisionId
    return preparePlan(revisionId)
  }, [preparePlan, selectedRevisionId, state?.assignedSetupRevisionId])

  return {
    state: contextReady ? state : null,
    operations: contextReady ? operations : null,
    selectedRevisionId: contextReady ? selectedRevisionId : '',
    selectedRevision:
      contextReady
        ? (state?.revisions.find((revision) => revision.setupRevisionId === selectedRevisionId) ??
          null)
        : null,
    activeJob: contextReady ? activeJob : null,
    jobStatus: contextReady ? jobStatus : null,
    plan: contextReady ? plan : null,
    cancellation: contextReady ? cancellation : null,
    receipt: contextReady ? receipt : null,
    restored: contextReady ? restored : null,
    operationConflict: contextReady ? operationConflict : null,
    planWasStale: contextReady && planWasStale,
    cancelledSafely: contextReady && cancelledSafely,
    loading: !contextReady || loading,
    submitting: contextReady && submitting,
    error: contextReady ? error : null,
    refreshState,
    refreshJob,
    selectRevision,
    preparePlan,
    applyPlan,
    rollback,
    keepOperationRunning,
    cancelActiveOperation,
    retryRecovery,
  }
}
