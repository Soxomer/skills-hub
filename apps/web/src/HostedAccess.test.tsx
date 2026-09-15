// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HostedAccess } from './HostedAccess'
import { authClient } from './auth-client'
import './i18n'
vi.mock('./App', () => ({ App: ({ onSignOut }: { onSignOut?: () => void }) => <button onClick={onSignOut}>Private workspace</button> }))
vi.mock('./auth-client', () => ({ authClient: { signIn: { email: vi.fn() }, signOut: vi.fn() } }))
let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.clearAllMocks() })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
it('keeps the workspace hidden until sign-in succeeds, then revokes the session on sign-out', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{"error":"Sign in"}', { status: 401 }))
    .mockResolvedValueOnce(new Response('{"projects":[]}', { status: 200 }))
  vi.stubGlobal('fetch', request)
  vi.mocked(authClient.signIn.email).mockResolvedValueOnce({ error: { status: 401 } } as never).mockResolvedValueOnce({ error: null } as never)
  vi.mocked(authClient.signOut).mockResolvedValue({ error: null } as never)
  await act(async () => root.render(<HostedAccess />))
  expect(container.textContent).toContain('Password')
  expect(container.textContent).not.toContain('Private workspace')
  async function fill(selector: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(selector)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  await fill('#owner-email', 'owner@example.com')
  await fill('#owner-password', 'test-only-password')
  const submit = async () => { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
  await submit()
  expect(container.textContent).toContain('not accepted')
  await submit()
  expect(authClient.signIn.email).toHaveBeenLastCalledWith({ email: 'owner@example.com', password: 'test-only-password' })
  expect(container.textContent).toContain('Private workspace')
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  await act(async () => container.querySelector('button')!.click())
  expect(authClient.signOut).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Password')
  expect(container.querySelector<HTMLInputElement>('#owner-password')!.value).toBe('')
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
})
it('reports a connection failure without revealing the workspace', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  await act(async () => root.render(<HostedAccess />))
  expect(container.textContent).toContain('could not be reached')
  expect(container.textContent).not.toContain('Private workspace')
})
