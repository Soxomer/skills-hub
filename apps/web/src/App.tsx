import { PROTOCOL_VERSION, type RunnerStatusResponse } from '@ahm/contracts'
import {
  AlertTriangle,
  ArrowRight,
  Clock3,
  Languages,
  Laptop,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { createBrowserClient } from './api'
import './App.css'
import { CommandBlock } from './components/CommandBlock'
import { ConnectionBadge } from './components/ConnectionBadge'
import { ProjectScanWorkspace } from './components/ProjectScanWorkspace'
import { connectionDisplayState } from './runner-status'
import { useRunnerConnection } from './useRunnerConnection'

function dateTime(value: string | null, language: string): string | null {
  if (!value) return null
  return new Intl.DateTimeFormat(language.startsWith('zh') ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export const App = memo(function App() {
  const { t, i18n } = useTranslation()
  const client = useMemo(() => createBrowserClient(), [])
  const connection = useRunnerConnection(client)
  const effectiveStatus =
    connection.status ??
    (connection.enrollment
      ? {
          enrollmentId: connection.enrollment.enrollmentId,
          state: 'waiting' as const,
          deviceId: null,
          expiresAt: connection.enrollment.expiresAt,
        }
      : null)
  const displayState = connectionDisplayState(effectiveStatus, connection.runner)
  const language = i18n.resolvedLanguage ?? 'en'

  const toggleLanguage = async () => {
    const nextLanguage = language.startsWith('zh') ? 'en' : 'zh'
    localStorage.setItem('ahm.language', nextLanguage)
    await i18n.changeLanguage(nextLanguage)
  }

  return (
    <div className="app-shell" data-protocol-version={PROTOCOL_VERSION}>
      <header className="topbar">
        <a className="brand" href="#main-content" aria-label={t('brand.name')}>
          <span className="brand-mark" aria-hidden="true">
            AH
          </span>
          <span>
            <strong>{t('brand.name')}</strong>
            <small>{t('brand.eyebrow')}</small>
          </span>
        </a>
        <button
          className="language-button"
          type="button"
          onClick={() => void toggleLanguage()}
          aria-label={t('language.aria')}
        >
          <Languages aria-hidden="true" size={17} />
          {t('language.action')}
        </button>
      </header>

      <main id="main-content" className="workspace">
        <div className="page-heading">
          <div>
            <p className="eyebrow">{t('brand.eyebrow')}</p>
            <h1>{t('page.title')}</h1>
            <p>{t('page.description')}</p>
          </div>
          <div className="heading-status" aria-label={t('status.label')}>
            <ConnectionBadge state={displayState} />
            <span>{t('page.protocol', { version: PROTOCOL_VERSION })}</span>
          </div>
        </div>

        {connection.error && (
          <div className="notice notice--error" role="alert">
            <AlertTriangle aria-hidden="true" size={19} />
            <strong>{t(`errors.${connection.error}`)}</strong>
            <button
              className="text-button"
              type="button"
              onClick={() =>
                void (connection.error === 'create'
                  ? connection.createEnrollment()
                  : connection.refresh())
              }
            >
              <RefreshCw aria-hidden="true" size={15} />
              {t('errors.retry')}
            </button>
          </div>
        )}

        {displayState === 'ready' && (
          <section className="intro-panel" aria-labelledby="intro-title">
            <div className="intro-icon" aria-hidden="true">
              <Laptop size={30} />
            </div>
            <div>
              <h2 id="intro-title">{t('intro.title')}</h2>
              <p>{t('intro.description')}</p>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={connection.creating}
              onClick={() => void connection.createEnrollment()}
            >
              {connection.creating ? (
                <LoaderCircle className="spin" aria-hidden="true" size={17} />
              ) : (
                <ArrowRight aria-hidden="true" size={17} />
              )}
              {connection.creating ? t('intro.creating') : t('intro.action')}
            </button>
          </section>
        )}

        {displayState === 'waiting' && connection.enrollment && (
          <section className="step-panel" aria-labelledby="enrollment-title">
            <div className="step-heading">
              <span className="step-number">1</span>
              <div>
                <p className="eyebrow">{t('enrollment.step')}</p>
                <h2 id="enrollment-title">{t('enrollment.title')}</h2>
                <p>{t('enrollment.description')}</p>
              </div>
            </div>
            <CommandBlock command={connection.enrollment.command} name={t('enrollment.title')} />
            <div className="waiting-row" aria-live="polite">
              <span>
                <LoaderCircle className="spin" aria-hidden="true" size={17} />
                {t('enrollment.waiting')}
              </span>
              <span>
                <Clock3 aria-hidden="true" size={15} />
                {t('enrollment.expires', {
                  time:
                    dateTime(connection.enrollment.expiresAt, language) ?? t('time.unavailable'),
                })}
              </span>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void connection.refresh()}
              >
                <RefreshCw aria-hidden="true" size={15} />
                {t('enrollment.refresh')}
              </button>
            </div>
          </section>
        )}

        {displayState === 'expired' && (
          <RecoveryPanel
            title={t('enrollment.expiredTitle')}
            description={t('enrollment.expiredDescription')}
            action={t('enrollment.replace')}
            onAction={() => {
              connection.reset()
              void connection.createEnrollment()
            }}
          />
        )}

        {displayState === 'revoked' && (
          <RecoveryPanel
            title={t('runner.revokedTitle')}
            description={t('runner.revokedDescription')}
            action={t('enrollment.replace')}
            onAction={() => {
              connection.reset()
              void connection.createEnrollment()
            }}
          />
        )}

        {effectiveStatus?.state === 'claimed' && !connection.runner && (
          <section className="loading-panel" aria-live="polite">
            <LoaderCircle className="spin" aria-hidden="true" size={22} />
            <span>{t('status.connected')}</span>
          </section>
        )}

        {(displayState === 'connected' || displayState === 'offline') && connection.runner && (
          <div className="connected-layout">
            <RunnerSummary runner={connection.runner} language={language} />

            {displayState === 'offline' && (
              <div className="notice notice--warning" role="status">
                <AlertTriangle aria-hidden="true" size={19} />
                <div>
                  <strong>{t('runner.offlineTitle')}</strong>
                  <p>{t('runner.offlineDescription')}</p>
                </div>
              </div>
            )}

            <ProjectScanWorkspace
              client={client}
              runner={connection.runner}
              runnerOnline={displayState === 'connected'}
            />
          </div>
        )}
      </main>
    </div>
  )
})

function RunnerSummary({ runner, language }: { runner: RunnerStatusResponse; language: string }) {
  const { t } = useTranslation()
  return (
    <section className="runner-summary" aria-labelledby="runner-title">
      <div className="summary-icon" aria-hidden="true">
        <ShieldCheck size={24} />
      </div>
      <div className="summary-copy">
        <p className="eyebrow">{t('runner.step')}</p>
        <h2 id="runner-title">{t('runner.title', { label: runner.label })}</h2>
        <p>{t('runner.description')}</p>
      </div>
      <dl>
        <div>
          <dt>{t('runner.device')}</dt>
          <dd>{runner.deviceId}</dd>
        </div>
        <div>
          <dt>{t('runner.lastSeen')}</dt>
          <dd>{dateTime(runner.lastSeenAt, language) ?? t('runner.neverSeen')}</dd>
        </div>
        <div>
          <dt>{t('runner.version')}</dt>
          <dd>{runner.capabilities?.runnerVersion ?? t('time.unavailable')}</dd>
        </div>
        <div>
          <dt>{t('runner.capabilities')}</dt>
          <dd>
            {t('runner.tools', {
              count: runner.capabilities?.capabilities.supportedTools.length ?? 0,
            })}
          </dd>
        </div>
      </dl>
    </section>
  )
}

interface RecoveryPanelProps {
  title: string
  description: string
  action: string
  onAction: () => void
}

function RecoveryPanel({ title, description, action, onAction }: RecoveryPanelProps) {
  return (
    <section className="recovery-panel">
      <div className="recovery-icon" aria-hidden="true">
        <RotateCcw size={24} />
      </div>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <button className="primary-button" type="button" onClick={onAction}>
        <RefreshCw aria-hidden="true" size={17} />
        {action}
      </button>
    </section>
  )
}
