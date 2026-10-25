import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { useRunnerConnection } from '../useRunnerConnection'
import { helperConnectionLink, installerFor, suggestedHelperPlatform, type HelperPlatform } from '../helper-connection'
import { CommandBlock } from './CommandBlock'
import { RUNNER_OFFLINE_AFTER_MS } from '../runner-status'

interface HelperOnboardingProps {
  connection: ReturnType<typeof useRunnerConnection>
  connected: boolean
  initialInstalled?: boolean
  onFinish: (connected: boolean) => void
}

export function HelperOnboarding({ connection, connected, initialInstalled = false, onFinish }: HelperOnboardingProps) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [installed, setInstalled] = useState(() => initialInstalled || Boolean(connection.enrollment) || connected)
  const [connectAnother, setConnectAnother] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [platform, setPlatform] = useState<HelperPlatform>(() => suggestedHelperPlatform(navigator.userAgent))
  const localWorkspace = import.meta.env.DEV && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  const [localInstallers, setLocalInstallers] = useState<Partial<Record<HelperPlatform, string>> | null>(null)
  const [downloadAttempt, setDownloadAttempt] = useState(0)
  const download = localWorkspace ? localInstallers?.[platform] ?? null : installerFor(platform)
  const expired = connection.status?.state === 'expired' || Boolean(connection.enrollment && Date.parse(connection.enrollment.expiresAt) <= now)
  const link = !expired && connection.enrollment ? helperConnectionLink(connection.enrollment.command) : null
  const invalid = Boolean(connection.enrollment && !expired && !link)
  const local = Boolean(link && new URL(link).searchParams.get('server')?.startsWith('http:'))
  const requested = useRef(false)
  const computers = connection.availableRunners.filter(runner => runner.status === 'active' && runner.capabilities?.capabilities.library)
  const choosingComputer = !connectAnother && (connection.loadingRunners || connection.runnersError || computers.length > 0)
  const refreshRunners = connection.refreshRunners
  useEffect(() => { void refreshRunners() }, [refreshRunners])
  useEffect(() => {
    if (!localWorkspace) return
    const abort = new AbortController()
    void fetch('/__ahm/helper-installers', { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('unavailable')
      const manifest: unknown = await response.json()
      const available: Partial<Record<HelperPlatform, string>> = {}
      for (const key of ['windows', 'macArm', 'macIntel', 'linux'] as const) {
        if (manifest && typeof manifest === 'object' && key in manifest && (manifest as Record<string, unknown>)[key] === `/__ahm/helper-installers/${key}`) available[key] = `/__ahm/helper-installers/${key}`
      }
      if (!abort.signal.aborted) setLocalInstallers(available)
    }).catch(() => { if (!abort.signal.aborted) setLocalInstallers({}) })
    return () => abort.abort()
  }, [localWorkspace, downloadAttempt])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 2000)
    const element = dialog.current
    const focused = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => { window.clearInterval(timer); element?.close(); focused?.focus() }
  }, [])
  useEffect(() => {
    if (!installed || connected || choosingComputer || connection.enrollment || connection.creating || requested.current) return
    requested.current = true
    void connection.createEnrollment()
  }, [installed, connected, choosingComputer, connection])
  return <dialog ref={dialog} className="library-dialog helper-onboarding" aria-labelledby="helper-onboarding-title" aria-describedby="helper-onboarding-description" onCancel={event => { event.preventDefault(); onFinish(false) }}>
    <div className="onboarding-heading"><h2 id="helper-onboarding-title">{t(connected ? 'onboarding.success' : 'onboarding.title')}</h2>
      <button className="onboarding-close" type="button" aria-label={t('onboarding.close')} onClick={() => onFinish(false)}><X size={18} aria-hidden="true" /></button></div>
    <p id="helper-onboarding-description">{t(connected ? 'onboarding.successHelp' : 'onboarding.description')}</p>
    <ol className="onboarding-progress" aria-label={t('onboarding.progress')}>
      {(['installStep', 'connectStep', 'manageStep'] as const).map((step, index) => <li key={step} aria-current={index === (connected ? 2 : installed ? 1 : 0) ? 'step' : undefined} className={index < (connected ? 2 : installed ? 1 : 0) ? 'is-complete' : undefined}>{t(`onboarding.${step}`)}</li>)}
    </ol>
    {connected ? <><p>{t('onboarding.nextHelp')}</p><button className="primary-button" onClick={() => onFinish(true)}>{t('onboarding.continue')}</button></> : <>
      {choosingComputer ? <section aria-labelledby="helper-computers-title" aria-busy={connection.loadingRunners || connection.selecting}>
        <h3 id="helper-computers-title">{t('onboarding.computers')}</h3>
        <p>{t('onboarding.computersHelp')}</p>
        {connection.loadingRunners && <p role="status">{t('onboarding.checkingComputers')}</p>}
        {connection.runnersError && <p className="notice notice--error" role="alert">{t('onboarding.computersError')}</p>}
        {connection.error === 'select' && <p className="notice notice--error" role="alert">{t('onboarding.selectError')}</p>}
        <ul className="onboarding-computers">{computers.map(computer => {
          const online = Boolean(computer.lastSeenAt && now - Date.parse(computer.lastSeenAt) <= RUNNER_OFFLINE_AFTER_MS)
          return <li key={computer.deviceId}><button className="primary-button" disabled={!online || connection.selecting || connection.loadingRunners} onClick={() => void connection.selectRunner(computer.deviceId)}>{t('onboarding.useComputer', { name: computer.label })}</button>
            {!online && <p>{t('onboarding.computerOffline')}</p>}</li>
        })}</ul>
        <div className="runner-helper-actions"><button className="secondary-button" disabled={connection.loadingRunners || connection.selecting} onClick={() => void connection.refreshRunners()}>{t('onboarding.checkComputers')}</button>
          <button className="text-button" disabled={connection.selecting} onClick={() => setConnectAnother(true)}>{t('onboarding.connectAnother')}</button></div>
      </section> : !installed ? <section aria-labelledby="helper-install-title">
        <h3 id="helper-install-title">{t('onboarding.install')}</h3><p>{t('onboarding.installHelp')}</p>
        <label htmlFor="helper-platform">{t('onboarding.platform')}</label>
        <select id="helper-platform" value={platform} onChange={event => setPlatform(event.target.value as HelperPlatform)}>
          {(['windows', 'macArm', 'macIntel', 'linux'] as const).map(value => <option key={value} value={value}>{t(`onboarding.${value}`)}</option>)}
        </select>
        <div className="runner-helper-actions">{download ? <a className="primary-button" href={download}>{t('onboarding.download')}</a> : <p role="status">{t(localWorkspace ? localInstallers === null ? 'onboarding.checkingDownload' : 'onboarding.localInstallerUnavailable' : 'onboarding.unavailable')}</p>}</div>
        {localWorkspace && !download && localInstallers !== null && <button className="secondary-button" onClick={() => setDownloadAttempt(attempt => attempt + 1)}>{t('onboarding.checkDownloads')}</button>}
        <p className="onboarding-next-action">{t('onboarding.afterInstall')}</p>
        <button className="secondary-button" onClick={() => setInstalled(true)}>{t('onboarding.installed')}</button>
      </section> : <section aria-labelledby="helper-connect-title" aria-busy={connection.creating}>
        <h3 id="helper-connect-title">{t('onboarding.connect')}</h3><p>{t('onboarding.connectHelp')}</p>
        {connection.error && <p className="notice notice--error" role="alert">{t('onboarding.error')}</p>}
        {expired && <p className="notice" role="status">{t('onboarding.expired')}</p>}
        {invalid && <p className="notice notice--error" role="alert">{t('onboarding.invalidAddress')}</p>}
        {link ? <><a className="primary-button" href={link}>{t('onboarding.open')}</a><p className="onboarding-waiting" role="status">{t('onboarding.waiting')}</p>
          {local && <p className="onboarding-local-help">{t('onboarding.localHelp')}</p>}
        </> : <button className="primary-button" disabled={connection.creating} onClick={() => void connection.createEnrollment()}>{t(connection.creating ? 'onboarding.preparing' : invalid ? 'onboarding.recheckAddress' : expired || connection.error ? 'onboarding.retry' : 'onboarding.prepare')}</button>}
        <details><summary>{t('onboarding.troubleshooting')}</summary><p>{t('onboarding.missing')}</p>
          {link && <CommandBlock command={link} name={t('helper.manualLink')} />}
          <div className="runner-helper-actions"><a className="secondary-button" href="ahm://open">{t('helper.open')}</a>
            <button className="secondary-button" disabled={connection.creating} onClick={() => void connection.createEnrollment()}>{t('onboarding.retry')}</button>
            <button className="secondary-button" disabled={connection.creating} onClick={() => void connection.refresh()}>{t('onboarding.refresh')}</button></div>
          <button className="text-button" onClick={() => setInstalled(false)}>{t('onboarding.reinstall')}</button>
        </details>
      </section>}
      <button className="text-button" onClick={() => onFinish(false)}>{t('onboarding.cancel')}</button>
    </>}
  </dialog>
}
