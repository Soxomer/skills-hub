import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { resources } from '../../web/src/i18n/resources'

const copy = resources.en.translation.helperDesktop
interface Snapshot {
  running: boolean; configured: boolean; connection: string; pendingServer: string | null
  pendingId: number | null; busy: boolean; startup: boolean | null; startupError: string | null; error: string | null
}

export function HelperApp() {
  const [status, setStatus] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState('')
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await invoke<Snapshot>('snapshot')
        if (!disposed) { setStatus(result); setPollError(null) }
      } catch { if (!disposed) setPollError('unavailable') }
      if (!disposed) timer = setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [])
  async function run(command: string, args?: Record<string, unknown>) {
    setBusy(true); setError(null)
    try { await invoke(command, args); setStatus(await invoke<Snapshot>('snapshot')); setPollError(null) }
    catch (cause) { setError(typeof cause === 'string' ? cause : 'unavailable') }
    finally { setBusy(false) }
  }
  const disabled = busy || status?.busy
  const failure = error ?? pollError ?? status?.error
  const message = failure && copy.errors[failure as keyof typeof copy.errors] || (failure ? copy.errors.unavailable : null)
  const state = !status ? 'loading' : !status.configured ? 'welcome' : !status.running ? 'stopped' : status.connection === 'connected' ? 'connected' : status.connection === 'offline' ? 'offline' : 'starting'
  return <main className="helper-desktop">
    <header><span className="brand-mark" aria-hidden="true">SH</span><strong>{copy.name}</strong></header>
    <section aria-live="polite">
      <h1>{copy.states[state]}</h1>
      <p>{!status?.configured ? copy.intro : copy.background}</p>
      {message && <p className="notice notice--error" role="alert">{message}</p>}
      {disabled && <p role="status">{copy.working}</p>}
    </section>
    {status?.pendingServer ? <section className="helper-pairing" aria-labelledby="pair-title">
      <h2 id="pair-title">{copy.confirm}</h2>
      <p className="helper-origin">{status.pendingServer}</p>
      <p>{status.configured ? copy.replace : copy.permission}</p>
      <div className="runner-helper-actions">
        <button className="primary-button" disabled={disabled} onClick={() => void run('control', { action: 'connect', pendingId: status.pendingId })}>{copy.connect}</button>
        <button className="secondary-button" disabled={disabled} onClick={() => void run('dismiss_pairing')}>{copy.cancel}</button>
      </div>
    </section> : <div className="runner-helper-actions">
      <button className="primary-button" disabled={disabled} onClick={() => void run('open_website', { connect: !status?.configured })}>{status?.configured ? copy.website : copy.connectWebsite}</button>
      {status?.configured && <button className="secondary-button" disabled={disabled} onClick={() => void run('control', { action: status.running ? 'stop' : 'start' })}>{status.running ? copy.stop : copy.start}</button>}
    </div>}
    <label className="helper-startup"><input type="checkbox" checked={status?.startup ?? false} disabled={disabled || !status || status.startup === null} onChange={event => void run('set_startup', { enabled: event.target.checked })} />{copy.startup}</label>
    {status?.startupError && <p className="notice notice--error" role="alert">{copy.errors.startupFailed}</p>}
    <details><summary>{copy.troubleshooting}</summary>
      <p>{copy.manualHelp}</p>
      <form onSubmit={event => { event.preventDefault(); void run('accept_link', { link }); setLink('') }}>
        <label htmlFor="pair-link">{copy.link}</label>
        <input id="pair-link" type="password" autoComplete="off" value={link} onChange={event => setLink(event.target.value)} />
        <button className="secondary-button" disabled={disabled || !link}>{copy.review}</button>
      </form>
      {status?.configured && <button className="text-button" disabled={disabled} onClick={() => void run('open_website', { connect: true })}>{copy.reconnect}</button>}
    </details>
    <footer><p>{copy.closeHelp}</p><button className="text-button" disabled={disabled} onClick={() => void run('control', { action: 'quit' })}>{copy.quit}</button></footer>
  </main>
}
