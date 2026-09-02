import type {
  CaptureDefaultRevisionResponse,
  ProjectSummary,
  RunnerJobStatusResponse,
} from '@ahm/contracts'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { ControlPlaneApiError, type ControlPlaneClient } from './api'
import {
  eligibleDiscoveryIds,
  isTerminalJob,
  reconcileIncludedDiscoveryIds,
  scanDiscoveries,
} from './scan-state'

const PROJECT_KEY = 'ahm.selected-project'
const SCAN_KEY = 'ahm.project-scan'
const POLL_INTERVAL_MS = 1_500

interface PersistedScan {
  projectId: string
  projectInstanceId: string
  jobId: string
  includedDiscoveryIds: string[] | null
}

export type ProjectWorkflowStage = 'projects' | 'create' | 'scan' | 'status' | 'capture'

export interface ProjectWorkflowError {
  stage: ProjectWorkflowStage
  code: string | null
}

function readSelectedProject(): string {
  try {
    return sessionStorage.getItem(PROJECT_KEY) ?? ''
  } catch {
    return ''
  }
}

function readScan(): PersistedScan | null {
  try {
    const raw = sessionStorage.getItem(SCAN_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedScan>
    if (
      typeof value.projectId !== 'string' ||
      typeof value.projectInstanceId !== 'string' ||
      typeof value.jobId !== 'string' ||
      !(
        value.includedDiscoveryIds === null ||
        (Array.isArray(value.includedDiscoveryIds) &&
          value.includedDiscoveryIds.every((id) => typeof id === 'string'))
      )
    ) {
      sessionStorage.removeItem(SCAN_KEY)
      return null
    }
    return value as PersistedScan
  } catch {
    sessionStorage.removeItem(SCAN_KEY)
    return null
  }
}

function workflowError(stage: ProjectWorkflowStage, error: unknown): ProjectWorkflowError {
  return {
    stage,
    code: error instanceof ControlPlaneApiError ? error.code : null,
  }
}

export function useProjectScan(client: ControlPlaneClient) {
  const initialScan = useMemo(readScan, [])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => initialScan?.projectId ?? readSelectedProject(),
  )
  const [scan, setScan] = useState<PersistedScan | null>(initialScan)
  const [jobStatus, setJobStatus] = useState<RunnerJobStatusResponse | null>(null)
  const [capture, setCapture] = useState<CaptureDefaultRevisionResponse | null>(null)
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [creatingProject, setCreatingProject] = useState(false)
  const [startingScan, setStartingScan] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<ProjectWorkflowError | null>(null)

  const refreshProjects = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoadingProjects(true)
      try {
        const response = await client.projects()
        setProjects(response.projects)
        setSelectedProjectId((current) => {
          if (current && response.projects.some((project) => project.projectId === current)) {
            return current
          }
          return response.projects[0]?.projectId ?? ''
        })
        setError((current) => (current?.stage === 'projects' ? null : current))
      } catch (nextError) {
        setError(workflowError('projects', nextError))
      } finally {
        if (showLoading) setLoadingProjects(false)
      }
    },
    [client],
  )

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    try {
      if (selectedProjectId) sessionStorage.setItem(PROJECT_KEY, selectedProjectId)
      else sessionStorage.removeItem(PROJECT_KEY)
    } catch {
      // Session persistence is a convenience; the workflow still works without it.
    }
  }, [selectedProjectId])

  useEffect(() => {
    try {
      if (scan) sessionStorage.setItem(SCAN_KEY, JSON.stringify(scan))
      else sessionStorage.removeItem(SCAN_KEY)
    } catch {
      // Session persistence is a convenience; the workflow still works without it.
    }
  }, [scan])

  const activeJobId = scan?.jobId ?? null
  const refreshJob = useCallback(async () => {
    if (!activeJobId) return
    try {
      const status = await client.job(activeJobId)
      setJobStatus(status)
      const discoveries = scanDiscoveries(status)
      if (discoveries) {
        setScan((current) => {
          if (!current || current.jobId !== activeJobId) return current
          const includedDiscoveryIds =
            current.includedDiscoveryIds === null
              ? eligibleDiscoveryIds(discoveries)
              : reconcileIncludedDiscoveryIds(discoveries, current.includedDiscoveryIds)
          return { ...current, includedDiscoveryIds }
        })
      }
      setError((current) => (current?.stage === 'status' ? null : current))
    } catch (nextError) {
      setError(workflowError('status', nextError))
    }
  }, [activeJobId, client])

  useEffect(() => {
    if (!activeJobId || isTerminalJob(jobStatus)) return
    const interval = window.setInterval(() => void refreshJob(), POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [activeJobId, jobStatus, refreshJob])

  const createProject = useCallback(
    async (name: string, repositoryIdentity: string) => {
      setCreatingProject(true)
      setError(null)
      try {
        const project = await client.createProject({
          name,
          repositoryIdentity: repositoryIdentity.trim() || null,
        })
        setProjects((current) => [...current, project])
        setSelectedProjectId(project.projectId)
        setScan(null)
        setJobStatus(null)
        setCapture(null)
        return true
      } catch (nextError) {
        setError(workflowError('create', nextError))
        return false
      } finally {
        setCreatingProject(false)
      }
    },
    [client],
  )

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId)
    setScan((current) => (current?.projectId === projectId ? current : null))
    setJobStatus((current) => (scan?.projectId === projectId ? current : null))
    setCapture(null)
    setError(null)
  }, [scan?.projectId])

  const startScan = useCallback(
    async (projectInstanceId: string) => {
      if (!selectedProjectId) return false
      setStartingScan(true)
      setError(null)
      try {
        const queued = await client.scanProject(projectInstanceId)
        setScan({
          projectId: selectedProjectId,
          projectInstanceId,
          jobId: queued.jobId,
          includedDiscoveryIds: null,
        })
        setJobStatus({
          jobId: queued.jobId,
          state: 'pending',
          result: null,
          cancelRequested: false,
        })
        setCapture(null)
        return true
      } catch (nextError) {
        setError(workflowError('scan', nextError))
        return false
      } finally {
        setStartingScan(false)
      }
    },
    [client, selectedProjectId],
  )

  const discoveries = scanDiscoveries(jobStatus)
  const includedDiscoveryIds = scan?.includedDiscoveryIds ?? []

  const setDiscoveryIncluded = useCallback((discoveryId: string, included: boolean) => {
    setScan((current) => {
      if (!current?.includedDiscoveryIds) return current
      const selection = new Set(current.includedDiscoveryIds)
      if (included) selection.add(discoveryId)
      else selection.delete(discoveryId)
      return { ...current, includedDiscoveryIds: [...selection] }
    })
  }, [])

  const selectAllEligible = useCallback(() => {
    if (!discoveries) return
    setScan((current) =>
      current ? { ...current, includedDiscoveryIds: eligibleDiscoveryIds(discoveries) } : current,
    )
  }, [discoveries])

  const clearSelection = useCallback(() => {
    setScan((current) => (current ? { ...current, includedDiscoveryIds: [] } : current))
  }, [])

  const captureDefault = useCallback(async () => {
    if (!scan || !discoveries || scan.includedDiscoveryIds === null) return false
    setCapturing(true)
    setError(null)
    try {
      const result = await client.captureDefault(scan.projectId, {
        scanJobId: scan.jobId,
        includedDiscoveryIds: scan.includedDiscoveryIds,
      })
      setCapture(result)
      await refreshProjects(false)
      return true
    } catch (nextError) {
      setError(workflowError('capture', nextError))
      return false
    } finally {
      setCapturing(false)
    }
  }, [client, discoveries, refreshProjects, scan])

  return {
    projects,
    selectedProjectId,
    selectedProject: projects.find((project) => project.projectId === selectedProjectId) ?? null,
    scan,
    jobStatus,
    discoveries,
    includedDiscoveryIds,
    capture,
    loadingProjects,
    creatingProject,
    startingScan,
    capturing,
    error,
    refreshProjects,
    createProject,
    selectProject,
    startScan,
    refreshJob,
    setDiscoveryIncluded,
    selectAllEligible,
    clearSelection,
    captureDefault,
  }
}
