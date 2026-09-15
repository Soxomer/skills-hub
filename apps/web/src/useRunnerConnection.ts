import type {
  CreateRunnerEnrollmentResponse,
  RunnerEnrollmentStatus,
  RunnerStatusResponse,
} from '@ahm/contracts'
import { useCallback, useEffect, useState } from 'react'

import { ControlPlaneApiError, type ControlPlaneClient } from './api'

const STORAGE_KEY = 'ahm.runner-enrollment'
const RUNNER_KEY = 'ahm.runner-device'
const POLL_INTERVAL_MS = 2_000

interface PersistedEnrollment {
  enrollmentId: string
  command: string
  expiresAt: string
}

export type RunnerConnectionError = 'create' | 'refresh'

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
  const restoredDeviceId = status?.state === 'claimed' ? status.deviceId : null

  const refresh = useCallback(async () => {
    if (!enrollment && !restoredDeviceId) return
    try {
      const nextStatus = enrollment
        ? await client.runnerEnrollment(enrollment.enrollmentId)
        : {
            enrollmentId: `restored-${restoredDeviceId}`,
            state: 'claimed' as const,
            deviceId: restoredDeviceId,
            expiresAt: '',
          }
      setStatus(nextStatus)
      if (nextStatus?.state === 'claimed' && nextStatus.deviceId) {
        persistRunner(nextStatus.deviceId)
        setRunner(await client.runner(nextStatus.deviceId))
      }
      setError(null)
    } catch (error) {
      if (error instanceof ControlPlaneApiError && error.status === 404) {
        sessionStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(RUNNER_KEY)
        setEnrollment(null)
        setStatus(null)
        setRunner(null)
        setError(null)
      } else setError('refresh')
    }
  }, [client, enrollment, restoredDeviceId])

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
    setCreating(true)
    setError(null)
    try {
      const nextEnrollment = await client.createRunnerEnrollment()
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
      setError('create')
    } finally {
      setCreating(false)
    }
  }, [client])

  const reset = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(RUNNER_KEY)
    setEnrollment(null)
    setStatus(null)
    setRunner(null)
    setError(null)
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
  }
}
