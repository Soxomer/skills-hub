import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { useRunnerConnection } from '../useRunnerConnection'
import { helperConnectionLink, installerFor, suggestedHelperPlatform, type HelperPlatform } from '../helper-connection'
import { CommandBlock } from './CommandBlock'

interface HelperOnboardingProps {
  connection: ReturnType<typeof useRunnerConnection>
  connected: boolean
  onFinish: (connected: boolean) => void
}

export function HelperOnboarding({ connection, connected, onFinish }: HelperOnboardingProps) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [installed, setInstalled] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [platform, setPlatform] = useState<HelperPlatform>(() => suggestedHelperPlatform(navigator.userAgent))
  const download = installerFor(platform)
  const expired = connection.status?.state === 'expired' || Boolean(connection.enrollment && Date.parse(connection.enrollment.expiresAt) <= now)
  const link = !expired && connection.enrollment ? helperConnectionLink(connection.enrollment.command) : null
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 2000)
    const element = dialog.current
    const focused = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => { window.clearInterval(timer); element?.close(); focused?.focus() }
  }, [])
  return <dialog ref={dialog} className="library-dialog helper-onboarding" aria-labelledby="helper-onboarding-title" onCancel={event => { event.preventDefault(); onFinish(false) }}>
    <h2 id="helper-onboarding-title">{t(connected ? 'onboarding.success' : 'onboarding.title')}</h2>
    <p>{t(connected ? 'onboarding.successHelp' : 'onboarding.description')}</p>
    {connected ? <button className="primary-button" onClick={() => onFinish(true)}>{t('onboarding.continue')}</button> : <>
      {!installed ? <section>
        <h3>{t('onboarding.install')}</h3><p>{t('onboarding.installHelp')}</p>
        <label htmlFor="helper-platform">{t('onboarding.platform')}</label>
        <select id="helper-platform" value={platform} onChange={event => setPlatform(event.target.value as HelperPlatform)}>
          {(['windows', 'macArm', 'macIntel', 'linux'] as const).map(value => <option key={value} value={value}>{t(`onboarding.${value}`)}</option>)}
        </select>
        <div className="runner-helper-actions">{download ? <a className="primary-button" href={download}>{t('onboarding.download')}</a> : <p>{t('onboarding.unavailable')}</p>}
          <button className="secondary-button" onClick={() => setInstalled(true)}>{t('onboarding.installed')}</button></div>
      </section> : <section>
        <h3>{t('onboarding.connect')}</h3><p>{t('onboarding.connectHelp')}</p>
        {connection.error && <p role="alert">{t('onboarding.error')}</p>}
        {expired && <p role="status">{t('onboarding.expired')}</p>}
        {link ? <><a className="primary-button" href={link}>{t('onboarding.open')}</a><p role="status">{t('onboarding.waiting')}</p></> : <button className="primary-button" disabled={connection.creating} onClick={() => void connection.createEnrollment()}>{t(connection.creating ? 'onboarding.preparing' : expired ? 'onboarding.retry' : 'onboarding.prepare')}</button>}
        <details><summary>{t('onboarding.troubleshooting')}</summary><p>{t('onboarding.missing')}</p>
          <a className="secondary-button" href="ahm://open">{t('helper.open')}</a>
          {link && <CommandBlock command={link} name={t('helper.manualLink')} />}
          <button className="text-button" disabled={connection.creating} onClick={() => void connection.createEnrollment()}>{t('onboarding.retry')}</button>
          <button className="text-button" onClick={() => void connection.refresh()}>{t('onboarding.refresh')}</button>
          <button className="text-button" onClick={() => setInstalled(false)}>{t('onboarding.install')}</button>
        </details>
      </section>}
      <button className="text-button" onClick={() => onFinish(false)}>{t('onboarding.cancel')}</button>
    </>}
  </dialog>
}
