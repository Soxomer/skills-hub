import type { EvaluationProfile, EvaluationSummary, RunnerStatusResponse, SetupRevisionDetail } from '@ahm/contracts'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ControlPlaneApiError, type ControlPlaneClient } from '../api'

interface SetupEvaluationProps {
  client: ControlPlaneClient
  candidate: SetupRevisionDetail
  runner: RunnerStatusResponse | null
  runnerOnline: boolean
  onBack: () => void
  onProjects: () => void
}

export function SetupEvaluation({ client, candidate, runner, runnerOnline, onBack, onProjects }: SetupEvaluationProps) {
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
  const eligible = ready && baseline && supported(baseline) && supported(candidate) && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model.trim()) && consent

  useEffect(() => {
    if (ownerClient !== client) return
    let live = true
    client.setups().then(async (value) => Promise.all(value.setups.map((setup) => client.setup(setup.setupId))))
      .then((details) => { if (live) { setRevisions(details.flatMap((detail) => detail.revisions)); setLoadError(false) } })
      .catch(() => { if (live) setLoadError(true) })
    return () => { live = false }
  }, [client, ownerClient, reload])

  useEffect(() => {
    if (ownerClient !== client) return
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
  }, [client, ownerClient, candidate.setupRevisionId, reload])

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
    <p>{t('evaluation.scope')}</p>
    <details className="library-section"><summary>{t('evaluation.fixtureTitle')}</summary><p>{t('evaluation.fixtureHelp')}</p>
      <p>{t('evaluation.fixtureDiscount')}</p><pre className="evaluation-fixture"><code>{t('evaluation.fixtureDiscountCode')}</code></pre>
      <p>{t('evaluation.fixtureClamp')}</p><pre className="evaluation-fixture"><code>{t('evaluation.fixtureClampCode')}</code></pre>
      <p>{t('evaluation.fixtureContains')}</p><pre className="evaluation-fixture"><code>{t('evaluation.fixtureContainsCode')}</code></pre></details>
    {!ready && <div className="notice notice--warning"><p>{t(runnerOnline ? 'evaluation.updateRunner' : 'evaluation.connectRunner')}</p><button type="button" className="secondary-button" onClick={onProjects}>{t('evaluation.connection')}</button></div>}
    {!supported(candidate) && <p role="alert" className="notice notice--warning">{t('evaluation.unsupported')}</p>}
    {loadError && <div role="alert" className="notice notice--error">{t('evaluation.loadError')} <button type="button" className="secondary-button" onClick={() => setReload((value) => value + 1)}>{t('errors.retry')}</button></div>}
    <form className="evaluation-form" onSubmit={(event) => void start(event)}>
      <label className="library-field">{t('evaluation.baseline')}<select value={baselineId} disabled={submitting || !revisions} onChange={(event) => { setBaselineId(event.target.value); setConsentDeviceId(null) }}>
        <option value="">{t(revisions ? 'evaluation.chooseBaseline' : 'evaluation.loading')}</option>
        {revisions?.filter((revision) => revision.setupRevisionId !== candidate.setupRevisionId).map((revision) => <option key={revision.setupRevisionId} value={revision.setupRevisionId}>{t('evaluation.version', { name: revision.name, version: revision.revisionNumber })}</option>)}
      </select></label>
      {revisions && revisions.filter((revision) => revision.setupRevisionId !== candidate.setupRevisionId).length === 0 && <p>{t('evaluation.noBaseline')}</p>}
      {baseline && !supported(baseline) && <p role="alert">{t('evaluation.unsupported')}</p>}
      <p className="library-muted">{t('evaluation.profile')}</p>
      <label className="library-field">{t('evaluation.model')}<input required maxLength={100} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" value={model} disabled={submitting} onChange={(event) => { setModel(event.target.value); setConsentDeviceId(null) }} /></label>
      <p className="library-muted">{t('evaluation.modelHelp')}</p>
      <label className="library-field">{t('evaluation.effort')}<select value={effort} disabled={submitting} onChange={(event) => { setEffort(event.target.value as EvaluationProfile['reasoningEffort']); setConsentDeviceId(null) }}>
        {(['low', 'medium', 'high'] as const).map((value) => <option key={value} value={value}>{t(`evaluation.reasoning.${value}`)}</option>)}
      </select></label>
      <p>{t('evaluation.platforms')}</p><p>{t('evaluation.permissions')}</p><p>{t('evaluation.ambient')}</p><p>{t('evaluation.usage')}</p>
      <label className="library-choice"><input type="checkbox" checked={consent} disabled={submitting} onChange={(event) => setConsentDeviceId(event.target.checked ? runner?.deviceId ?? null : null)} /><span>{t('evaluation.consent')}</span></label>
      <button type="submit" className="primary-button" disabled={!eligible || submitting}>{t(submitting ? 'evaluation.starting' : 'evaluation.start')}</button>
    </form>
    {actionError && <p role="alert" className="notice notice--error">{t(`evaluation.${actionError}`)}</p>}
    <section className="library-section"><h2>{t('evaluation.history')}</h2><p className="library-muted">{t('evaluation.limitations')}</p>
      {historyError && <div role="alert">{t('evaluation.historyError')} <button type="button" className="secondary-button" onClick={() => setReload((value) => value + 1)}>{t('errors.retry')}</button></div>}
      {!history && !historyError && <p role="status">{t('evaluation.loading')}</p>}
      {history?.length === 0 && <p>{t('evaluation.empty')}</p>}
      {history?.map((entry) => <article className="evaluation-run" key={entry.jobId}>
        <h3>{t('evaluation.comparison', { baseline: entry.definition.baseline.revisionNumber, candidate: entry.definition.candidate.revisionNumber })}</h3>
        <p>{new Date(entry.createdAt).toLocaleString('en')} · {entry.definition.profile.model} · {t(`evaluation.reasoning.${entry.definition.profile.reasoningEffort}`)} · {entry.definition.suiteId}</p>
        <p>{t(`evaluation.state.${entry.state}`)}{entry.cancelRequested ? ` · ${t('evaluation.cancelRequested')}` : ''}</p>
        <p className="library-muted">{t('evaluation.identities', { baseline: entry.definition.baseline.setupRevisionId, candidate: entry.definition.candidate.setupRevisionId })}</p>
        {['pending', 'leased', 'acknowledged'].includes(entry.state) && <button type="button" className="secondary-button" disabled={entry.cancelRequested || cancelling === entry.jobId} onClick={() => void cancel(entry.jobId)}>{t('evaluation.cancel')}</button>}
        {entry.result?.kind === 'error' && <p role="alert">{t('evaluation.runError')} {entry.result.payload.message}</p>}
        {entry.result?.kind === 'evaluationResult' && <>
          <p>{t('evaluation.observed', { version: entry.result.payload.observed.harnessVersion, model: entry.result.payload.observed.model ?? t('evaluation.unreported') })}</p>
          <p className="library-muted">{t('evaluation.ambient')}</p>
          {entry.result.payload.observed.inheritedInstructionsDigest && <p className="library-muted">{t('evaluation.inheritedDigest', { digest: entry.result.payload.observed.inheritedInstructionsDigest })}</p>}
          <div className="evaluation-results">{(['baseline', 'candidate'] as const).map((side) => {
            if (entry.result?.kind !== 'evaluationResult') return null
            const result = entry.result.payload[side]
            return <section key={side}><h4>{t(`evaluation.side.${side}`)}</h4><p>{t(`evaluation.outcome.${result.status}`)} · {t('evaluation.duration', { seconds: (result.durationMs / 1000).toFixed(1) })}</p>
              {result.checks.length > 0 && <ul>{result.checks.map((check) => <li key={check.id}>{check.label}: {t(check.passed ? 'evaluation.passed' : 'evaluation.failed')}</li>)}</ul>}
              {result.summary && <p>{result.summary}</p>}{result.error && <p role="alert">{result.error}</p>}</section>
          })}</div>
        </>}
      </article>)}
    </section>
  </>
}
