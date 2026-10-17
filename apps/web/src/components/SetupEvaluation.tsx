import type { EvaluationProfile, EvaluationSummary, RunnerStatusResponse, SetupRevisionDetail } from '@ahm/contracts'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ControlPlaneApiError, type ControlPlaneClient } from '../api'

interface SetupEvaluationProps {
  client: ControlPlaneClient
  candidate: SetupRevisionDetail
  runner: RunnerStatusResponse | null
  runnerOnline: boolean
  active?: boolean
  onBack: () => void
  onProjects: () => void
}

export function SetupEvaluation({ client, candidate, runner, runnerOnline, active = true, onBack, onProjects }: SetupEvaluationProps) {
  const { t } = useTranslation()
  const [ownerClient] = useState(client)
  const [revisions, setRevisions] = useState<SetupRevisionDetail[] | null>(null)
  const [baselineId, setBaselineId] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<EvaluationProfile['reasoningEffort']>('medium')
  const [consentDeviceId, setConsentDeviceId] = useState<string | null>(null)
  const [history, setHistory] = useState<EvaluationSummary[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const pendingRequest = useRef<{ signature: string; key: string } | null>(null)
  const baseline = revisions?.find((entry) => entry.setupRevisionId === baselineId)
  const supported = (revision: SetupRevisionDetail) => revision.items.length <= 50 && revision.items.every((item) => item.toolId === 'codex' && item.artifactKind === 'skill')
  const ready = ownerClient === client && runnerOnline && runner?.status === 'active' && runner.capabilities?.capabilities.evaluateSetups === true
  const consent = Boolean(runner && consentDeviceId === runner.deviceId)
  const validModel = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model.trim())
  const eligible = ready && baseline && supported(baseline) && supported(candidate) && validModel && consent
  const prerequisites = [
    !ready && (runnerOnline ? 'updateRunner' : 'connectRunner'),
    !baseline && 'prerequisiteBaseline',
    (!supported(candidate) || (baseline && !supported(baseline))) && 'unsupported',
    !validModel && 'prerequisiteModel',
    !consent && 'prerequisiteConsent',
  ].filter((key): key is string => typeof key === 'string')

  useEffect(() => {
    if (!active || ownerClient !== client) return
    let live = true
    client.setups().then(async (value) => Promise.all(value.setups.map((setup) => client.setup(setup.setupId))))
      .then((details) => { if (live) { setRevisions(details.flatMap((detail) => detail.revisions)); setLoadError(false) } })
      .catch(() => { if (live) setLoadError(true) })
    return () => { live = false }
  }, [active, client, ownerClient, reload])

  useEffect(() => {
    if (!active || ownerClient !== client) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const response = await client.evaluations(candidate.setupRevisionId)
        if (!live) return
        setHistory(response.evaluations); setHistoryError(false)
        if (response.evaluations.some((entry) => ['pending', 'leased', 'acknowledged'].includes(entry.state))) timer = setTimeout(() => void refresh(), 3000)
      } catch { if (live) setHistoryError(true) }
    }
    void refresh()
    return () => { live = false; clearTimeout(timer) }
  }, [active, client, ownerClient, candidate.setupRevisionId, reload])

  async function start(event: FormEvent) {
    event.preventDefault()
    if (!eligible || !baseline || !runner || submitting) return
    const request = { deviceId: runner.deviceId, baseline: { setupId: baseline.setupId, setupRevisionId: baseline.setupRevisionId },
      candidate: { setupId: candidate.setupId, setupRevisionId: candidate.setupRevisionId },
      profile: { harness: 'codex', profileVersion: 1, model: model.trim(), reasoningEffort: effort, sandbox: 'read-only', contextMode: 'skillInstructions', timeoutSeconds: 120 } satisfies EvaluationProfile }
    const signature = JSON.stringify(request)
    if (pendingRequest.current?.signature !== signature) pendingRequest.current = { signature, key: crypto.randomUUID() }
    setSubmitting(true); setActionError(null)
    try {
      await client.createEvaluation({ ...request, idempotencyKey: pendingRequest.current.key })
      pendingRequest.current = null
      setConsentDeviceId(null); setReload((value) => value + 1)
    } catch (error) {
      const code = error instanceof ControlPlaneApiError ? error.code : null
      setActionError(code && ['evaluationInvalidRequest', 'evaluationRunnerUnsupported', 'evaluationRevisionUnavailable', 'evaluationUnsupportedContent', 'evaluationCaptureUnavailable'].includes(code) ? code : 'actionError')
    } finally { setSubmitting(false) }
  }

  async function cancel(jobId: string) {
    if (cancelling || ownerClient !== client) return
    setCancelling(jobId); setActionError(null)
    try { await client.cancelJob(jobId); setReload((value) => value + 1) }
    catch { setActionError('actionError') } finally { setCancelling(null) }
  }

  if (ownerClient !== client) return <div role="alert" className="notice notice--warning"><p>{t('evaluation.contextChanged')}</p>
    <button type="button" className="secondary-button" onClick={onBack}>{t('evaluation.back')}</button></div>

  return <>
    <button type="button" className="secondary-button library-back" onClick={onBack}>{t('evaluation.back')}</button>
    <div className="page-heading"><div><h1>{t('evaluation.title')}</h1><p>{t('evaluation.candidate', { name: candidate.name, version: candidate.revisionNumber })}</p></div></div>
    <p className="evaluation-intro">{t('evaluation.scope')}</p>
    <details className="evaluation-disclosure"><summary>{t('evaluation.fixtureTitle')}</summary><p>{t('evaluation.fixtureHelp')}</p>
      <p>{t('evaluation.fixtureDiscount')}</p><pre className="evaluation-fixture"><code>{t('evaluation.fixtureDiscountCode')}</code></pre>
      <p>{t('evaluation.fixtureClamp')}</p><pre className="evaluation-fixture"><code>{t('evaluation.fixtureClampCode')}</code></pre>
      <p>{t('evaluation.fixtureContains')}</p><pre className="evaluation-fixture"><code>{t('evaluation.fixtureContainsCode')}</code></pre></details>
    {loadError && <div role="alert" className="notice notice--error">{t('evaluation.loadError')} <button type="button" className="secondary-button" onClick={() => setReload((value) => value + 1)}>{t('errors.retry')}</button></div>}
    <form className="evaluation-form evaluation-workspace" onSubmit={(event) => void start(event)}>
      <section className="evaluation-form-section" aria-labelledby="evaluation-versions-title">
        <h2 id="evaluation-versions-title">{t('evaluation.versionsTitle')}</h2>
        <div className="evaluation-version-pair">
          <div className="evaluation-version">
            <label className="library-field">{t('evaluation.baseline')}<select aria-describedby="evaluation-baseline-help" value={baselineId} disabled={submitting || !revisions} onChange={(event) => { setBaselineId(event.target.value); setConsentDeviceId(null) }}>
              <option value="">{t(revisions ? 'evaluation.chooseBaseline' : 'evaluation.loading')}</option>
              {revisions?.filter((revision) => revision.setupRevisionId !== candidate.setupRevisionId).map((revision) => <option key={revision.setupRevisionId} value={revision.setupRevisionId}>{t('evaluation.version', { name: revision.name, version: revision.revisionNumber })}</option>)}
            </select></label>
            <p id="evaluation-baseline-help" className="library-muted">{t('evaluation.baselineHelp')}</p>
            {baseline && <p>{t('evaluation.instructions', { count: baseline.items.length })}</p>}
            {revisions && revisions.filter((revision) => revision.setupRevisionId !== candidate.setupRevisionId).length === 0 && <p>{t('evaluation.noBaseline')}</p>}
          </div>
          <div className="evaluation-version">
            <h3>{t('evaluation.side.candidate')}</h3>
            <p className="evaluation-version-name">{t('evaluation.version', { name: candidate.name, version: candidate.revisionNumber })}</p>
            <p className="library-muted">{t('evaluation.candidateHelp')}</p>
            <p>{t('evaluation.instructions', { count: candidate.items.length })}</p>
          </div>
        </div>
      </section>
      <section className="evaluation-form-section" aria-labelledby="evaluation-settings-title">
        <h2 id="evaluation-settings-title">{t('evaluation.settingsTitle')}</h2>
        <dl className="evaluation-fixed-settings">
          <div><dt>{t('evaluation.harnessLabel')}</dt><dd>{t('evaluation.harnessValue')}</dd></div>
          <div><dt>{t('evaluation.contextLabel')}</dt><dd>{t('evaluation.contextValue')}</dd></div>
          <div><dt>{t('evaluation.sandboxLabel')}</dt><dd>{t('evaluation.sandboxValue')}</dd></div>
          <div><dt>{t('evaluation.trialLabel')}</dt><dd>{t('evaluation.trialValue')}</dd></div>
        </dl>
        <div className="evaluation-profile-fields">
          <div>
            <label className="library-field">{t('evaluation.model')}<input aria-describedby="evaluation-model-help" required maxLength={100} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" value={model} disabled={submitting} onChange={(event) => { setModel(event.target.value); setConsentDeviceId(null) }} /></label>
            <p id="evaluation-model-help" className="library-muted">{t('evaluation.modelHelp')}</p>
          </div>
          <label className="library-field">{t('evaluation.effort')}<select value={effort} disabled={submitting} onChange={(event) => { setEffort(event.target.value as EvaluationProfile['reasoningEffort']); setConsentDeviceId(null) }}>
            {(['low', 'medium', 'high'] as const).map((value) => <option key={value} value={value}>{t(`evaluation.reasoning.${value}`)}</option>)}
          </select></label>
        </div>
      </section>
      <section className="evaluation-form-section" aria-labelledby="evaluation-run-title">
        <h2 id="evaluation-run-title">{t('evaluation.runTitle')}</h2>
        <p>{t('evaluation.usage')}</p>
        <details className="evaluation-disclosure"><summary>{t('evaluation.conditionsTitle')}</summary>
          <p>{t('evaluation.platforms')}</p><p>{t('evaluation.permissions')}</p><p>{t('evaluation.ambient')}</p>
        </details>
        <label className="library-choice"><input type="checkbox" checked={consent} disabled={submitting} onChange={(event) => setConsentDeviceId(event.target.checked ? runner?.deviceId ?? null : null)} /><span>{t('evaluation.consent')}</span></label>
        <div id="evaluation-prerequisites" className="evaluation-prerequisites" aria-live="polite">
          {prerequisites.length > 0 ? <><h3>{t('evaluation.prerequisiteTitle')}</h3><ul>{prerequisites.map((key) => <li key={key}>{t(`evaluation.${key}`)}</li>)}</ul></> : <p>{t('evaluation.ready', { computer: runner?.label })}</p>}
          {!ready && <button type="button" className="secondary-button" onClick={onProjects}>{t('evaluation.connection')}</button>}
        </div>
        <button type="submit" className="primary-button" aria-describedby="evaluation-prerequisites" disabled={!eligible || submitting}>{t(submitting ? 'evaluation.starting' : 'evaluation.start')}</button>
      </section>
    </form>
    {actionError && <p role="alert" className="notice notice--error">{t(`evaluation.${actionError}`)}</p>}
    <section className="library-section"><h2>{t('evaluation.history')}</h2><p className="library-muted">{t('evaluation.limitations')}</p>
      {historyError && <div role="alert">{t('evaluation.historyError')} <button type="button" className="secondary-button" onClick={() => setReload((value) => value + 1)}>{t('errors.retry')}</button></div>}
      {!history && !historyError && <p role="status">{t('evaluation.loading')}</p>}
      {history?.length === 0 && <p>{t('evaluation.empty')}</p>}
      {history?.map((entry) => <article className="evaluation-run" key={entry.jobId}>
        <header className="evaluation-run-heading"><div>
          <h3>{t('evaluation.comparison', { baseline: entry.definition.baseline.revisionNumber, candidate: entry.definition.candidate.revisionNumber })}</h3>
          <p className="library-muted"><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('en')}</time></p>
        </div><p className="evaluation-run-status">{t(`evaluation.state.${entry.state}`)}{entry.cancelRequested ? ` · ${t('evaluation.cancelRequested')}` : ''}</p></header>
        <p>{t('evaluation.historyProfile', { model: entry.definition.profile.model, effort: t(`evaluation.reasoning.${entry.definition.profile.reasoningEffort}`) })}</p>
        {['pending', 'leased', 'acknowledged'].includes(entry.state) && <button type="button" className="secondary-button" disabled={entry.cancelRequested || cancelling === entry.jobId} onClick={() => void cancel(entry.jobId)}>{t('evaluation.cancel')}</button>}
        {entry.result?.kind === 'error' && <p role="alert">{t('evaluation.runError')} {entry.result.payload.message}</p>}
        {entry.result?.kind === 'evaluationResult' && <>
          <div className="evaluation-results">{(['baseline', 'candidate'] as const).map((side) => {
            if (entry.result?.kind !== 'evaluationResult') return null
            const result = entry.result.payload[side]
            return <section key={side} className="evaluation-result-side"><h4>{t(`evaluation.side.${side}`)}</h4>
              <p className="evaluation-version-name">{t('evaluation.version', { name: revisions?.find((revision) => revision.setupRevisionId === entry.definition[side].setupRevisionId)?.name ?? entry.definition[side].setupId, version: entry.definition[side].revisionNumber })}</p>
              <p>{t(`evaluation.outcome.${result.status}`)} · {t('evaluation.duration', { seconds: (result.durationMs / 1000).toFixed(1) })}</p>
              <p className="evaluation-check-summary">{result.checks.length > 0 ? t('evaluation.checksSummary', { passed: result.checks.filter((check) => check.passed).length, total: result.checks.length }) : t('evaluation.noChecks')}</p>
              {result.checks.length > 0 && <ul className="evaluation-checks">{result.checks.map((check) => <li key={check.id}><span>{check.label}: </span><strong>{t(check.passed ? 'evaluation.passed' : 'evaluation.failed')}</strong></li>)}</ul>}
              {result.summary && <p>{result.summary}</p>}{result.error && <p role="alert">{result.error}</p>}</section>
          })}</div>
        </>}
        <details className="evaluation-disclosure evaluation-run-details"><summary>{t('evaluation.diagnosticsTitle')}</summary>
          <p className="library-muted">{t('evaluation.identities', { baseline: entry.definition.baseline.setupRevisionId, candidate: entry.definition.candidate.setupRevisionId })}</p>
          <p>{t('evaluation.profile')}</p>
          {entry.result?.kind === 'evaluationResult' && <>
            <p>{t('evaluation.observed', { version: entry.result.payload.observed.harnessVersion, model: entry.result.payload.observed.model ?? t('evaluation.unreported') })}</p>
            <p className="library-muted">{t('evaluation.ambient')}</p>
            {entry.result.payload.observed.inheritedInstructionsDigest && <p className="library-muted">{t('evaluation.inheritedDigest', { digest: entry.result.payload.observed.inheritedInstructionsDigest })}</p>}
          </>}
        </details>
      </article>)}
    </section>
  </>
}
