import type {
  ApplyReceipt,
  CanonicalPlan,
  ProjectSetupStateResponse,
  RollbackReceipt,
  RunnerJobStatusResponse,
} from '@ahm/contracts'
import { useCallback, useEffect, useState } from 'react'

import { ControlPlaneApiError, type ControlPlaneClient } from './api'
import {
  applyReceipt,
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
  const [selectedRevisionId, setSelectedRevisionId] = useState('')
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)
  const [jobStatus, setJobStatus] = useState<RunnerJobStatusResponse | null>(null)
  const [plan, setPlan] = useState<CanonicalPlan | null>(null)
  const [receipt, setReceipt] = useState<ApplyReceipt['payload'] | null>(null)
  const [restored, setRestored] = useState<RollbackReceipt['payload'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<SetupSwitchError | null>(null)

  const refreshState = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const next = await client.setupRevisions(projectId)
      setState(next)
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
  }, [client, projectId])

  useEffect(() => {
    setState(null)
    setSelectedRevisionId('')
    setActiveJob(null)
    setJobStatus(null)
    setPlan(null)
    setReceipt(null)
    setRestored(null)
    setError(null)
    void refreshState()
  }, [projectInstanceId, refreshState])

  const refreshJob = useCallback(async () => {
    if (!activeJob) return
    try {
      const status = await client.job(activeJob.jobId)
      setJobStatus(status)
      const nextPlan = preparedPlan(status)
      const nextReceipt = applyReceipt(status)
      const nextRestored = rollbackReceipt(status)
      if (nextPlan) setPlan(nextPlan)
      if (nextReceipt) {
        setReceipt(nextReceipt)
        await refreshState()
      }
      if (nextRestored) {
        setRestored(nextRestored)
        await refreshState()
      }
      if (status.state === 'failed' && status.result?.result.kind === 'error') {
        setError({ stage: activeJob.kind, code: status.result.result.payload.code })
      } else {
        setError((current) => (current?.stage === 'status' ? null : current))
      }
    } catch (nextError) {
      setError(workflowError('status', nextError))
    }
  }, [activeJob, client, refreshState])

  useEffect(() => {
    if (!activeJob || (jobStatus?.jobId === activeJob.jobId && !jobInFlight(jobStatus))) return
    const interval = window.setInterval(() => void refreshJob(), POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [activeJob, jobStatus, refreshJob])

  const selectRevision = useCallback((revisionId: string) => {
    setSelectedRevisionId(revisionId)
    setActiveJob(null)
    setJobStatus(null)
    setPlan(null)
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
      setPlan(null)
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
    if (!plan || !activeJob || activeJob.kind !== 'plan') return false
    setSubmitting(true)
    setError(null)
    try {
      const queued = await client.applySetupPlan(projectInstanceId, {
        planJobId: activeJob.jobId,
        planDigest: plan.planDigest,
      })
      setActiveJob({ kind: 'apply', jobId: queued.jobId })
      setJobStatus({
        jobId: queued.jobId,
        state: 'pending',
        result: null,
        cancelRequested: false,
      })
      return true
    } catch (nextError) {
      setError(workflowError('apply', nextError))
      return false
    } finally {
      setSubmitting(false)
    }
  }, [activeJob, client, plan, projectInstanceId])

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
      return true
    } catch (nextError) {
      setError(workflowError('rollback', nextError))
      return false
    } finally {
      setSubmitting(false)
    }
  }, [client, projectInstanceId, receipt])

  return {
    state,
    selectedRevisionId,
    selectedRevision:
      state?.revisions.find((revision) => revision.setupRevisionId === selectedRevisionId) ?? null,
    activeJob,
    jobStatus,
    plan,
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
  }
}
