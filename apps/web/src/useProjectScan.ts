import type {
  CaptureDefaultRevisionResponse,
  ProjectSummary,
  RunnerJobStatusResponse,
} from '@ahm/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  const contextVersion = useRef(0)
  const selectedProjectRef = useRef(selectedProjectId)
  const jobRequestVersion = useRef(0)

  // Invalidate outstanding requests synchronously, including A -> B -> A switches.
  const selectProject = useCallback((projectId: string) => {
    if (selectedProjectRef.current === projectId) return
    contextVersion.current += 1
    selectedProjectRef.current = projectId
    setSelectedProjectId(projectId)
    setScan(null)
    setJobStatus(null)
    setCapture(null)
    setStartingScan(false)
    setCapturing(false)
    setError(null)
  }, [])

  useEffect(() => () => {
    contextVersion.current += 1
  }, [])

  const refreshProjects = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoadingProjects(true)
      try {
        const response = await client.projects()
        setProjects(response.projects)
        if (!response.projects.some((project) => project.projectId === selectedProjectRef.current)) {
          selectProject(response.projects[0]?.projectId ?? '')
        }
        setError((current) => (current?.stage === 'projects' ? null : current))
      } catch (nextError) {
        setError(workflowError('projects', nextError))
      } finally {
        if (showLoading) setLoadingProjects(false)
      }
    },
    [client, selectProject],
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
    const context = contextVersion.current
    const request = ++jobRequestVersion.current
    const isCurrent = () => context === contextVersion.current && request === jobRequestVersion.current
    try {
      const status = await client.job(activeJobId)
      if (!isCurrent()) return
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
      if (isCurrent()) setError(workflowError('status', nextError))
    }
  }, [activeJobId, client])

  useEffect(() => {
    if (!activeJobId || isTerminalJob(jobStatus)) return
    const interval = window.setInterval(() => void refreshJob(), POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [activeJobId, jobStatus, refreshJob])

  const createProject = useCallback(
    async (name: string, repositoryIdentity: string) => {
      const context = contextVersion.current
      setCreatingProject(true)
      setError(null)
      try {
        const project = await client.createProject({
          name,
          repositoryIdentity: repositoryIdentity.trim() || null,
        })
        setProjects((current) => [...current, project])
        if (context === contextVersion.current) selectProject(project.projectId)
        return true
      } catch (nextError) {
        if (context === contextVersion.current) setError(workflowError('create', nextError))
        return false
      } finally {
        setCreatingProject(false)
      }
    },
    [client, selectProject],
  )

  const startScan = useCallback(
    async (projectInstanceId: string) => {
      if (!selectedProjectId) return false
      const context = ++contextVersion.current
      setStartingScan(true)
      setError(null)
      try {
        const queued = await client.scanProject(projectInstanceId)
        if (context !== contextVersion.current) return false
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
        if (context === contextVersion.current) setError(workflowError('scan', nextError))
        return false
      } finally {
        if (context === contextVersion.current) setStartingScan(false)
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
    const context = contextVersion.current
    setCapturing(true)
    setError(null)
    try {
      const result = await client.captureDefault(scan.projectId, {
        scanJobId: scan.jobId,
        includedDiscoveryIds: scan.includedDiscoveryIds,
      })
      if (context !== contextVersion.current) return false
      setCapture(result)
      await refreshProjects(false)
      return true
    } catch (nextError) {
      if (context === contextVersion.current) setError(workflowError('capture', nextError))
      return false
    } finally {
      if (context === contextVersion.current) setCapturing(false)
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
