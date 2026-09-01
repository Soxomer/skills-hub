import type {
  CreateRunnerEnrollmentResponse,
  RunnerEnrollmentStatus,
  RunnerStatusResponse,
} from '@ahm/contracts'
import { useCallback, useEffect, useState } from 'react'

import type { ControlPlaneClient } from './api'

const STORAGE_KEY = 'ahm.runner-enrollment'
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

export function useRunnerConnection(client: ControlPlaneClient) {
  const [enrollment, setEnrollment] = useState<CreateRunnerEnrollmentResponse | null>(
    readPersistedEnrollment,
  )
  const [status, setStatus] = useState<RunnerEnrollmentStatus | null>(null)
  const [runner, setRunner] = useState<RunnerStatusResponse | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<RunnerConnectionError | null>(null)

  const refresh = useCallback(async () => {
    if (!enrollment) return
    try {
      const nextStatus = await client.runnerEnrollment(enrollment.enrollmentId)
      setStatus(nextStatus)
      if (nextStatus.state === 'claimed' && nextStatus.deviceId) {
        setRunner(await client.runner(nextStatus.deviceId))
      }
      setError(null)
    } catch {
      setError('refresh')
    }
  }, [client, enrollment])

  useEffect(() => {
    if (!enrollment) return
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
  }, [enrollment, refresh])

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
