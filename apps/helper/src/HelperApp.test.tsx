// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { HelperApp } from './HelperApp'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const snapshot = { running: true, configured: true, connection: 'connected', pendingServer: null, pendingId: null, busy: false, startup: false, startupError: null, error: null }
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(invoke).mockReset().mockResolvedValue(snapshot)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('clears a recovered poll error without requiring a user action', async () => {
  vi.mocked(invoke).mockRejectedValueOnce('transient failure')
  await act(async () => root.render(<HelperApp />))
  expect(container.textContent).toContain('Could not reach the bundled worker')
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(container.textContent).toContain('This computer is connected')
  expect(container.querySelector('[role=alert]')).toBeNull()
})

it('keeps pairing usable when startup settings cannot be read and recovers only that setting', async () => {
  const pending = { ...snapshot, pendingServer: 'https://trusted.example', pendingId: 7 }
  vi.mocked(invoke).mockResolvedValue({ ...pending, startup: null, startupError: 'startupFailed' })
  await act(async () => root.render(<HelperApp />))
  const connect = [...container.querySelectorAll('button')].find(button => button.textContent === 'Connect')!
  expect(connect.disabled).toBe(false)
  expect(container.textContent).toContain('https://trusted.example')
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(true)
  vi.mocked(invoke).mockResolvedValue(pending)
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(false)
  expect(container.querySelector('[role=alert]')).toBeNull()
})

it('does not erase an action error when the background status poll succeeds', async () => {
  await act(async () => root.render(<HelperApp />))
  vi.mocked(invoke).mockRejectedValueOnce('browserFailed')
  const website = [...container.querySelectorAll('button')].find(button => button.textContent === 'Return to Skills Hub')!
  await act(async () => website.click())
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(container.textContent).toContain('Could not open the browser')
})
