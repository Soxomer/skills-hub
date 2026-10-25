import type {
  CreateRunnerEnrollmentResponse,
  RunnerEnrollmentStatus,
  RunnerStatusResponse,
} from '@ahm/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ControlPlaneApiError, type ControlPlaneClient } from './api'
import { RUNNER_OFFLINE_AFTER_MS } from './runner-status'

const STORAGE_KEY = 'ahm.runner-enrollment'
const RUNNER_KEY = 'ahm.runner-device'
const POLL_INTERVAL_MS = 2_000

interface PersistedEnrollment {
  enrollmentId: string
  command: string
  expiresAt: string
}

export type RunnerConnectionError = 'create' | 'refresh' | 'select'

function readPersistedEnrollment(): CreateRunnerEnrollmentResponse | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedEnrollment>
    if (
      typeof value.enrollmentId !== 'string' ||
      typeof value.command !== 'string' ||
      typeof value.expiresAt !== 'string'
    ) {
      sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    return { ...value, code: '' } as CreateRunnerEnrollmentResponse
  } catch {
    sessionStorage.removeItem(STORAGE_KEY)
    return null
  }
}

function persistEnrollment(enrollment: CreateRunnerEnrollmentResponse): void {
  const value: PersistedEnrollment = {
    enrollmentId: enrollment.enrollmentId,
    command: enrollment.command,
    expiresAt: enrollment.expiresAt,
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
}

function readPersistedRunner(): RunnerEnrollmentStatus | null {
  try {
    const deviceId = localStorage.getItem(RUNNER_KEY)
    if (!deviceId) return null
    return {
      enrollmentId: `restored-${deviceId}`,
      state: 'claimed',
      deviceId,
      expiresAt: '',
    }
  } catch {
    return null
  }
}

function persistRunner(deviceId: string): void {
  try {
    localStorage.setItem(RUNNER_KEY, deviceId)
  } catch {
    // Runner selection persistence is a convenience; the connection remains usable in this tab.
  }
}

export function useRunnerConnection(client: ControlPlaneClient) {
  const [enrollment, setEnrollment] = useState<CreateRunnerEnrollmentResponse | null>(
    readPersistedEnrollment,
  )
  const [status, setStatus] = useState<RunnerEnrollmentStatus | null>(readPersistedRunner)
  const [runner, setRunner] = useState<RunnerStatusResponse | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<RunnerConnectionError | null>(null)
  const [availableRunners, setAvailableRunners] = useState<RunnerStatusResponse[]>([])
  const [loadingRunners, setLoadingRunners] = useState(true)
  const [runnersError, setRunnersError] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const generation = useRef(0)
  const restoredDeviceId = status?.state === 'claimed' ? status.deviceId : null

  const refresh = useCallback(async () => {
    if (!enrollment && !restoredDeviceId) return
    const current = generation.current
    try {
      const nextStatus = enrollment
        ? await client.runnerEnrollment(enrollment.enrollmentId)
        : {
            enrollmentId: `restored-${restoredDeviceId}`,
            state: 'claimed' as const,
            deviceId: restoredDeviceId,
            expiresAt: '',
          }
      const nextRunner = nextStatus?.state === 'claimed' && nextStatus.deviceId
        ? await client.runner(nextStatus.deviceId) : null
      if (current !== generation.current) return
      setStatus(nextStatus)
      if (nextStatus?.state === 'claimed' && nextStatus.deviceId) {
        persistRunner(nextStatus.deviceId)
        setRunner(nextRunner)
      }
      setError(previous => previous === 'select' ? previous : null)
    } catch (error) {
      if (current !== generation.current) return
      if (error instanceof ControlPlaneApiError && error.status === 404) {
        sessionStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(RUNNER_KEY)
        setEnrollment(null)
        setStatus(null)
        setRunner(null)
        setError(previous => previous === 'select' ? previous : null)
      } else setError('refresh')
    }
  }, [client, enrollment, restoredDeviceId])

  const refreshRunners = useCallback(async () => {
    setLoadingRunners(true)
    setRunnersError(false)
    try {
      setAvailableRunners(await client.runners())
    } catch {
      setRunnersError(true)
    } finally {
      setLoadingRunners(false)
    }
  }, [client])

  const selectRunner = useCallback(async (deviceId: string) => {
    const current = ++generation.current
    setSelecting(true)
    setCreating(false)
    setError(null)
    try {
      const selected = await client.runner(deviceId)
      if (current !== generation.current) return
      if (selected.status !== 'active' || !selected.capabilities?.capabilities.library ||
          !selected.lastSeenAt || Date.now() - Date.parse(selected.lastSeenAt) > RUNNER_OFFLINE_AFTER_MS) {
        throw new Error('Computer unavailable')
      }
      sessionStorage.removeItem(STORAGE_KEY)
      persistRunner(selected.deviceId)
      setEnrollment(null)
      setStatus({ enrollmentId: `restored-${selected.deviceId}`, state: 'claimed', deviceId: selected.deviceId, expiresAt: '' })
      setRunner(selected)
    } catch {
      if (current === generation.current) setError('select')
    } finally {
      if (current === generation.current) setSelecting(false)
    }
  }, [client])

  useEffect(() => {
    if (!enrollment && !restoredDeviceId) return
    let disposed = false
    const poll = async () => {
      if (disposed) return
      await refresh()
    }
    void poll()
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [enrollment, refresh, restoredDeviceId])

  const createEnrollment = useCallback(async () => {
    const current = ++generation.current
    setSelecting(false)
    setCreating(true)
    setError(null)
    try {
      const nextEnrollment = await client.createRunnerEnrollment()
      if (current !== generation.current) return
      persistEnrollment(nextEnrollment)
      setEnrollment(nextEnrollment)
      setStatus({
        enrollmentId: nextEnrollment.enrollmentId,
        state: 'waiting',
        deviceId: null,
        expiresAt: nextEnrollment.expiresAt,
      })
      setRunner(null)
    } catch {
      if (current === generation.current) setError('create')
    } finally {
      if (current === generation.current) setCreating(false)
    }
  }, [client])

  const reset = useCallback(() => {
    generation.current++
    sessionStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(RUNNER_KEY)
    setEnrollment(null)
    setStatus(null)
    setRunner(null)
    setError(null)
    setCreating(false)
    setSelecting(false)
  }, [])

  return {
    enrollment,
    status,
    runner,
    creating,
    error,
    createEnrollment,
    refresh,
    reset,
    availableRunners,
    loadingRunners,
    runnersError,
    selecting,
    refreshRunners,
    selectRunner,
  }
}
