import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { App } from './App'
import { ControlPlaneApiError, createBrowserClient, type ControlPlaneClient } from './api'
import { authClient } from './auth-client'

export function HostedAccess() {
  const { t } = useTranslation()
  const [client, setClient] = useState<ControlPlaneClient | null>(null)
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(true)
  const [needsPassword, setNeedsPassword] = useState(false)
  const [error, setError] = useState<'unavailable' | 'invalid' | 'rateLimited' | null>(null)
  useEffect(() => {
    let cancelled = false
    const candidate = createBrowserClient()
    void candidate.projects().then(() => {
      if (!cancelled) setClient(candidate)
    }).catch((reason: unknown) => {
      if (cancelled) return
      if (reason instanceof ControlPlaneApiError && reason.status === 401) setNeedsPassword(true)
      else setError('unavailable')
    }).finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [])

  async function signIn(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const candidate = createBrowserClient()
    try {
      const result = await authClient.signIn.email({ email, password })
      if (result.error) {
        setError(result.error.status === 429 ? 'rateLimited' : 'invalid')
        return
      }
      await candidate.projects()
      setPassword('')
      setClient(candidate)
    } catch (reason) {
      setError(reason instanceof ControlPlaneApiError && reason.status === 401 ? 'invalid' : 'unavailable')
    } finally { setBusy(false) }
  }

  async function signOut() {
    const result = await authClient.signOut()
    if (result.error) { setError('unavailable'); return }
    setClient(null)
    setPassword('')
    setNeedsPassword(true)
    setError(null)
  }
  if (client) return <>
    {error && <p className="notice notice--error" role="alert">{t(`auth.${error}`)}</p>}
    <App client={client} onSignOut={needsPassword || import.meta.env.PROD
      ? () => { void signOut().catch(() => setError('unavailable')) } : undefined} />
  </>

  return <main className="auth-page">
    <section className="auth-panel" aria-labelledby="auth-title">
      <h1 id="auth-title">{t('brand.name')}</h1>
      {needsPassword ? <form onSubmit={(event) => void signIn(event)}>
        <p>{t('auth.description')}</p>
        <label htmlFor="owner-email">{t('auth.email')}</label>
        <input id="owner-email" type="email" autoComplete="username" required
          value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} />
        <label htmlFor="owner-password">{t('auth.password')}</label>
        <input id="owner-password" type="password" autoComplete="current-password" required
          value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
        {error && <p className="notice notice--error" role="alert">{t(`auth.${error}`)}</p>}
        <button className="primary-button" type="submit" disabled={busy || !password}>
          {t(busy ? 'auth.signingIn' : 'auth.signIn')}
        </button>
      </form> : <>
        <p role={error ? 'alert' : 'status'}>{t(error ? 'auth.unavailable' : 'auth.connecting')}</p>
        {error && <button className="primary-button" type="button" onClick={() => location.reload()}>{t('errors.retry')}</button>}
      </>}
    </section>
  </main>
}
