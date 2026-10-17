import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LibrarySetupSnapshot, SetupDetail, SetupLibrarySummary, SetupRevisionSummary } from '@ahm/contracts'
import { ControlPlaneApiError } from '../../../api'
import { useLibrary } from '../../library-context'
import type { ManagedSkill, ToolOption } from './types'

interface AddToSetupDialogProps { skill: ManagedSkill; tools: ToolOption[]; onClose: () => void }

export function AddToSetupDialog({ skill, tools, onClose }: AddToSetupDialogProps) {
  const { t } = useTranslation('hub')
  const { client, deviceId, runnerConnected, previewSetupSkill, snapshotSetupSkill, onOpenSetup } = useLibrary()
  const dialog = useRef<HTMLDialogElement>(null)
  const originalDevice = useRef(deviceId)
  const [snapshot, setSnapshot] = useState<LibrarySetupSnapshot | null>(null)
  const [setups, setSetups] = useState<SetupLibrarySummary[]>([])
  const [destinationMode, setDestinationMode] = useState<'existing' | 'new'>('existing')
  const [destination, setDestination] = useState('')
  const [detail, setDetail] = useState<SetupDetail | null>(null)
  const [name, setName] = useState('')
  const [targetName, setTargetName] = useState(skill.name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 200))
  const [selected, setSelected] = useState<string[]>([])
  const [consent, setConsent] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [snapshotJobId, setSnapshotJobId] = useState<string | null>(null)
  const [saved, setSaved] = useState<SetupRevisionSummary | null>(null)
  useEffect(() => {
    const element = dialog.current
    const focused = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => { element?.close(); focused?.focus() }
  }, [])
  useEffect(() => {
    let active = true
    setLoading(true); setError(null); setSnapshot(null); setSnapshotJobId(null); setConsent(false)
    Promise.all([previewSetupSkill(skill.id), client.setups()]).then(([value, list]) => {
      if (active) {
        setSnapshot(value); setSetups(list.setups)
        setDestination(previous => list.setups.some(setup => setup.setupId === previous) ? previous : list.setups[0]?.setupId ?? '')
        if (list.setups.length === 0) setDestinationMode('new')
      }
    }).catch(() => { if (active) setError(t('addToSetup.previewFailed')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [client, previewSetupSkill, skill.id, attempt, t])
  useEffect(() => {
    let active = true
    setDetail(null)
    if (destinationMode === 'new' || !destination) { setLoadingDetail(false); return }
    setLoadingDetail(true)
    client.setup(destination).then(value => { if (active) setDetail(value) })
      .catch(() => { if (active) setError(t('addToSetup.destinationFailed')) })
      .finally(() => { if (active) setLoadingDetail(false) })
    return () => { active = false }
  }, [client, destination, destinationMode, attempt, t])
  const current = detail?.revisions[0]
  const conflict = destinationMode === 'existing' && current?.items.some(i => selected.includes(i.toolId) && i.targetName === targetName)
  const connected = runnerConnected && deviceId === originalDevice.current
  const valid = snapshot && selected.length > 0 && /^[a-zA-Z0-9_-]{1,200}$/.test(targetName)
    && consent && !conflict && connected && !loadingDetail && (destinationMode === 'new' ? name.trim().length > 0 && name.trim().length <= 120 : !!current && detail?.setupId === destination)
  const publish = async () => {
    if (!valid || !snapshot || busy) return
    setBusy(true); setError(null)
    try {
      const jobId = snapshotJobId ?? await snapshotSetupSkill(skill.id, snapshot.contentDigest)
      setSnapshotJobId(jobId)
      const revision = await client.addLibrarySkillToSetup({ snapshotJobId: jobId, contentDigest: snapshot.contentDigest,
        destination: destinationMode === 'new' ? { name: name.trim() } : { setupId: destination, expectedRevisionNumber: current!.revisionNumber },
        targets: selected.map(toolId => ({ toolId, targetName })) })
      setSaved(revision)
    } catch (e) {
      const key = e instanceof ControlPlaneApiError && ['setupNameTaken', 'setupRevisionConflict', 'setupTargetConflict', 'setupPublicationConflict', 'setupSnapshotUnavailable'].includes(e.code ?? '') ? e.code : 'publishFailed'
      setError(t(`addToSetup.${key}`))
    } finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="library-dialog add-to-setup-dialog" aria-labelledby="add-to-setup-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <h2 id="add-to-setup-title">{t(saved ? 'addToSetup.saved' : 'addToSetup.title', { name: skill.name })}</h2>
    {saved ? <>
      <p role="status">{t('addToSetup.savedVersion', { name: saved.name, number: saved.revisionNumber })}</p>
      <p>{t('addToSetup.savedHelp')}</p>
      <div className="library-dialog-actions">
        <button className={onOpenSetup ? 'btn btn-secondary' : 'btn btn-primary'} onClick={onClose}>{t('addToSetup.done')}</button>
        {onOpenSetup && <button className="btn btn-primary" onClick={() => { onClose(); onOpenSetup({ setupId: saved.setupId, setupRevisionId: saved.setupRevisionId }) }}>{t('addToSetup.openSaved')}</button>}
      </div>
    </> : <>
      <p>{t('addToSetup.description')}</p>
      {loading && <p role="status">{t('addToSetup.loading')}</p>}
      {error && <p role="alert" className="add-to-setup-error">{error}</p>}
      {!loading && !connected && <p role="alert">{t('addToSetup.runnerRequired')}</p>}
      {snapshot && !loading && <fieldset disabled={busy}>
        <fieldset className="add-to-setup-destination" aria-label={t('addToSetup.destination')}>
          {(['existing', 'new'] as const).map(mode => <label key={mode}>
            <input type="radio" name="setup-destination-mode" value={mode} checked={destinationMode === mode} onChange={() => { setDestinationMode(mode); setError(null); setConsent(false) }} />
            {t(`addToSetup.${mode}`)}
          </label>)}
        </fieldset>
        {destinationMode === 'new' ? <>
          <label>{t('addToSetup.name')}<input value={name} maxLength={120} onChange={e => { setName(e.target.value); setConsent(false) }} /></label>
          <p>{t('addToSetup.createHelp')}</p>
        </> : setups.length === 0 ? <p role="status">{t('addToSetup.noSetups')}</p> : <>
          <label htmlFor="setup-destination">{t('addToSetup.choose')}</label>
          <select id="setup-destination" value={destination} onChange={e => { setDestination(e.target.value); setError(null); setConsent(false) }}>
            {setups.map(s => <option value={s.setupId} key={s.setupId}>{s.name} · {t('addToSetup.version', { number: s.latestRevision.revisionNumber })}</option>)}
          </select>
          {current || loadingDetail ? <p role="status">{t(loadingDetail ? 'addToSetup.loadingDestination' : 'addToSetup.keepItems', { count: current?.itemCount ?? 0 })}</p> : null}
        </>}
        <label>{t('addToSetup.targetName')}<input value={targetName} maxLength={200} onChange={e => { setTargetName(e.target.value); setConsent(false) }} pattern="[a-zA-Z0-9_-]+" /></label>
        <p>{t('addToSetup.targetHelp')}</p>
        <fieldset className="add-to-setup-tools"><legend>{t('addToSetup.tools')}</legend>
          {snapshot.supportedTools.map(id => <label key={id}><input type="checkbox" checked={selected.includes(id)} onChange={e => { setSelected(list => e.target.checked ? [...list, id] : list.filter(v => v !== id)); setConsent(false) }} />{tools.find(tool => tool.id === id)?.label ?? id.replace(/_/g, ' ')}</label>)}
        </fieldset>
        {conflict && <p role="alert" className="add-to-setup-error">{t('addToSetup.setupTargetConflict')}</p>}
        <details open><summary>{t('addToSetup.files', { count: snapshot.files.length })}</summary>
          <ul className="add-to-setup-files">{snapshot.files.map(f => <li key={f.path}><code>{f.path}</code><span>{t('addToSetup.bytes', { count: f.size })}</span></li>)}</ul>
        </details>
        <details><summary>{t('addToSetup.digest')}</summary><p className="add-to-setup-digest"><code>{snapshot.contentDigest}</code></p></details>
        <label className="add-to-setup-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />{t('addToSetup.consent')}</label>
        <p>{t('addToSetup.immutable')}</p>
      </fieldset>}
      <div className="library-dialog-actions">
        <button className="btn btn-secondary" disabled={busy} onClick={onClose}>{t('cancel')}</button>
        {error && <button className="btn btn-secondary" disabled={busy || !connected} onClick={() => setAttempt(v => v + 1)}>{t('addToSetup.reviewAgain')}</button>}
        <button className="btn btn-primary" disabled={!valid || busy || loading} onClick={() => void publish()}>{t(busy ? 'addToSetup.publishing' : destinationMode === 'new' ? 'addToSetup.create' : 'addToSetup.action')}</button>
      </div>
    </>}
  </dialog>
}
