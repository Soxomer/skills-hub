import type { ArtifactBundle, SetupComposerItem, SetupDetail, SetupLibrarySummary, SetupRevisionDetail } from '@ahm/contracts'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ControlPlaneApiError, type ControlPlaneClient } from '../api'

interface SetupLibraryProps { client: ControlPlaneClient; onProjects: () => void }

export function SetupLibrary({ client, onProjects }: SetupLibraryProps) {
  const { t } = useTranslation()
  const [setups, setSetups] = useState<SetupLibrarySummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let live = true
    client.setups().then((result) => { if (live) { setSetups(result.setups); setError(false) } })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [client, reload])
  function saved(setupId: string) { setCreating(false); setSelected(setupId); setReload((n) => n + 1) }
  if (creating) return <SetupEditor client={client} onCancel={() => setCreating(false)} onSaved={saved} />
  if (selected) return <SetupDetails key={selected} client={client} setupId={selected}
    onBack={() => { setSelected(null); setReload((n) => n + 1) }} onSaved={saved} />
  return <>
    <div className="page-heading">
      <div><h1>{t('library.setups')}</h1><p>{t('library.description')}</p></div>
      <button type="button" className="primary-button" onClick={() => setCreating(true)}>{t('library.create')}</button>
    </div>
    {error && <div className="notice notice--error" role="alert">{t('library.loadError')}
      <button type="button" className="secondary-button" onClick={() => setReload((n) => n + 1)}>{t('errors.retry')}</button></div>}
    {!setups && !error && <p role="status">{t('library.loading')}</p>}
    {setups?.length === 0 && <section className="library-empty"><h2>{t('library.emptyTitle')}</h2>
      <p>{t('library.emptyDescription')}</p><button type="button" className="secondary-button" onClick={onProjects}>{t('library.goProjects')}</button></section>}
    {Boolean(setups?.length) && <>
      <label className="library-field">{t('library.search')}<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <ul className="library-list">{setups!.filter((setup) => setup.name.toLowerCase().includes(query.toLowerCase())).map((setup) =>
        <li key={setup.setupId}><button type="button" className="library-row" onClick={() => setSelected(setup.setupId)}>
          <span><strong>{setup.name}</strong><small>{t(`library.kind.${setup.kind}`)}</small></span>
          <span>{t('library.version', { number: setup.latestRevision.revisionNumber })}<small>{t('library.items', { count: setup.latestRevision.itemCount })}</small></span>
          <span>{t('library.projectsCount', { count: setup.projectCount })}</span>
        </button></li>)}</ul>
      {!setups!.some((setup) => setup.name.toLowerCase().includes(query.toLowerCase())) && <p role="status">{t('library.noResults')}</p>}
    </>}
  </>
}

interface SetupDetailsProps { client: ControlPlaneClient; setupId: string; onBack: () => void; onSaved: (id: string) => void }

function SetupDetails({ client, setupId, onBack, onSaved }: SetupDetailsProps) {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<SetupDetail | null>(null)
  const [revisionId, setRevisionId] = useState<string | null>(null)
  const [mode, setMode] = useState<'edit' | 'clone' | null>(null)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    client.setup(setupId).then((value) => { if (live) { setDetail(value); setError(false) } })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [client, setupId, reload])
  const revisions = detail?.revisions.toSorted((a, b) => b.revisionNumber - a.revisionNumber) ?? []
  const revision = revisions.find((entry) => entry.setupRevisionId === revisionId) ?? revisions[0]
  if (mode && detail && revision) return <SetupEditor key={`${mode}-${revision.setupRevisionId}`} client={client}
    base={revision} detail={mode === 'edit' ? detail : undefined} onCancel={() => { setMode(null); setDetail(null); setReload((n) => n + 1) }}
    onSaved={(id) => { setMode(null); setDetail(null); setRevisionId(null); setReload((n) => n + 1); onSaved(id) }} />
  const previous = revisions.find((entry) => entry.revisionNumber === (revision?.revisionNumber ?? 0) - 1)
  const changes = revision && previous ? compareItems(previous.items, revision.items) : []
  return <>
    <button type="button" className="secondary-button library-back" onClick={onBack}>{t('library.back')}</button>
    {error && <div role="alert" className="notice notice--error">{t('library.loadError')}<button type="button" className="secondary-button" onClick={() => setReload((n) => n + 1)}>{t('errors.retry')}</button></div>}
    {!detail && !error && <p role="status">{t('library.loading')}</p>}
    {detail && revision && <>
      <div className="page-heading"><div><h1>{detail.name}</h1><p>{t('library.publishSafety')}</p></div>
        <div className="library-actions"><button type="button" className="secondary-button" onClick={() => setMode('clone')}>{t('library.clone')}</button>
          <button type="button" className="primary-button" onClick={() => setMode('edit')}>{t('library.edit')}</button></div></div>
      <label className="library-field">{t('library.history')}<select value={revision.setupRevisionId} onChange={(event) => setRevisionId(event.target.value)}>
        {revisions.map((entry) => <option key={entry.setupRevisionId} value={entry.setupRevisionId}>{t('library.version', { number: entry.revisionNumber })}{entry.setupRevisionId === detail.initialSetupRevisionId && detail.kind === 'default' ? ` — ${t('library.initialDefault')}` : ''}</option>)}
      </select></label>
      <p className="library-muted">{t('library.savedAt', { date: new Date(revision.createdAt).toLocaleString('en') })}</p>
      {previous && <section className="library-section"><h2>{t('library.comparison', { number: previous.revisionNumber })}</h2>
        <ChangeList changes={changes} /></section>}
      <section className="library-section"><h2>{t('library.contents')}</h2>
        {revision.items.length === 0 ? <p>{t('library.noItems')}</p> : <ul className="library-list">{revision.items.map((item) =>
          <li key={itemKey(item)}><ArtifactInspector key={`${revision.setupRevisionId}-${itemKey(item)}`} client={client} setupId={setupId} revisionId={revision.setupRevisionId} item={item} /></li>)}</ul>}
      </section>
      <section className="library-section"><h2>{t('library.usage')}</h2><p className="library-muted">{t('library.usageHelp')}</p>
        {detail.projects.length === 0 ? <p>{t('library.unused')}</p> : <ul className="library-list">{detail.projects.map((project) =>
          <li className="library-usage" key={project.projectId}><strong>{project.name}</strong><span>{t('library.version', { number: revisions.find((entry) => entry.setupRevisionId === project.setupRevisionId)?.revisionNumber ?? '?' })}</span></li>)}</ul>}
      </section>
    </>}
  </>
}

function itemKey(item: SetupComposerItem): string {
  return JSON.stringify([item.artifactId, item.contentDigest, item.toolId, item.targetName])
}

type ItemChange = { kind: 'added' | 'removed' | 'changed'; label: string }
function compareItems(before: SetupComposerItem[], after: SetupComposerItem[]): ItemChange[] {
  const destination = (item: SetupComposerItem) => JSON.stringify([item.toolId, item.targetName])
  const old = new Map(before.map((item) => [destination(item), item]))
  const next = new Map(after.map((item) => [destination(item), item]))
  return [...after.flatMap((item): ItemChange[] => {
    const prior = old.get(destination(item))
    const label = `${item.toolId} / ${item.targetName}`
    return !prior ? [{ kind: 'added', label }] : itemKey(prior) !== itemKey(item) ? [{ kind: 'changed', label }] : []
  }), ...before.filter((item) => !next.has(destination(item))).map((item): ItemChange => ({ kind: 'removed', label: `${item.toolId} / ${item.targetName}` }))]
}

function ChangeList({ changes }: { changes: ItemChange[] }) {
  const { t } = useTranslation()
  return changes.length ? <ul className="library-change-list">{changes.map((change) => <li key={`${change.kind}-${change.label}`}><strong>{t(`library.change.${change.kind}`)}</strong> {change.label}</li>)}</ul> : <p>{t('library.unchanged')}</p>
}

interface SetupEditorProps { client: ControlPlaneClient; base?: SetupRevisionDetail; detail?: SetupDetail; onCancel: () => void; onSaved: (id: string) => void }

function SetupEditor({ client, base, detail, onCancel, onSaved }: SetupEditorProps) {
  const { t } = useTranslation()
  const [items, setItems] = useState<SetupComposerItem[] | null>(null)
  const [selected, setSelected] = useState(new Set(base?.items.map(itemKey) ?? []))
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    client.setupComposer().then((value) => {
      if (live) { setItems([...new Map([...(base?.items ?? []), ...value.items].map((item) => [itemKey(item), item])).values()]); setError(null) }
    }).catch(() => { if (live) setError('loadError') })
    return () => { live = false }
  }, [client, base, reload])
  const chosen = items?.filter((item) => selected.has(itemKey(item))) ?? []
  const latest = detail ? Math.max(...detail.revisions.map((revision) => revision.revisionNumber)) : null
  const comparisonBase = detail?.revisions.find((revision) => revision.revisionNumber === latest) ?? base
  const changes = compareItems(comparisonBase?.items ?? [], chosen)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true); setError(null)
    const selections = chosen.map(({ sourceSetupRevisionId, artifactId, contentDigest, toolId, targetName }) => ({ sourceSetupRevisionId, artifactId, contentDigest, toolId, targetName }))
    try {
      const result = detail ? await client.publishSetupRevision(detail.setupId, { expectedRevisionNumber: latest!, items: selections }) : await client.createSetup({ name: name.trim(), items: selections })
      onSaved(result.setupId)
    } catch (failure) {
      setError(failure instanceof ControlPlaneApiError && failure.code === 'setupRevisionConflict' ? 'conflict' : failure instanceof ControlPlaneApiError && failure.status === 409 ? 'nameConflict' : 'saveError')
    } finally { setSaving(false) }
  }
  return <form onSubmit={(event) => void submit(event)} className="library-editor">
    <div className="page-heading"><div><h1>{detail ? t('library.editTitle', { name: detail.name }) : t('library.create')}</h1><p>{t('library.editorHelp')}</p></div></div>
    {!detail && <label className="library-field">{t('library.name')}<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>}
    {base && <p>{t('library.basedOn', { name: base.name, number: base.revisionNumber })}</p>}
    <p className="library-muted">{t('library.publishSafety')}</p>
    {error && <div role="alert" className="notice notice--error">{t(`library.${error}`)}{error === 'loadError' && <button type="button" className="secondary-button" onClick={() => setReload((n) => n + 1)}>{t('errors.retry')}</button>}</div>}
    {!items && !error && <p role="status">{t('library.loading')}</p>}
    {items && <>
      <label className="library-field">{t('library.filterItems')}<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {items.length === 0 && <p>{t('library.emptyDescription')}</p>}
      <ul className="library-list">{items.filter((item) => `${item.targetName} ${item.toolId} ${item.sourceSetupName}`.toLowerCase().includes(query.toLowerCase())).map((item) =>
        <li key={itemKey(item)}><label className="library-choice"><input type="checkbox" checked={selected.has(itemKey(item))} disabled={saving} onChange={(event) => {
          const next = new Set(selected)
          if (event.target.checked) {
            for (const candidate of items) if (candidate.toolId === item.toolId && candidate.targetName === item.targetName) next.delete(itemKey(candidate))
            next.add(itemKey(item))
          } else next.delete(itemKey(item))
          setSelected(next)
        }} /><span><strong>{item.targetName}</strong><small>{item.toolId} · {item.sourceSetupName} · {t('library.version', { number: item.sourceRevisionNumber })}</small></span></label></li>)}</ul>
      <section className="library-section"><h2>{detail ? t('library.comparison', { number: latest }) : t('library.reviewChanges')}</h2><ChangeList changes={changes} /></section>
    </>}
    <div className="library-editor-footer"><span>{t('library.selected', { count: chosen.length })}</span><div className="library-actions">
      <button type="button" className="secondary-button" disabled={saving} onClick={onCancel}>{t('library.cancel')}</button>
      <button type="submit" className="primary-button" disabled={saving || !items || chosen.length === 0 || (!detail && !name.trim()) || Boolean(detail && changes.length === 0)}>{saving ? t('library.saving') : detail ? t('library.publishVersion', { number: latest! + 1 }) : t('library.create')}</button>
    </div></div>
  </form>
}

interface ArtifactInspectorProps { client: ControlPlaneClient; setupId: string; revisionId: string; item: SetupComposerItem }
function ArtifactInspector({ client, setupId, revisionId, item }: ArtifactInspectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [bundle, setBundle] = useState<ArtifactBundle | null>(null)
  const [error, setError] = useState(false)
  const [path, setPath] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!open) return
    let live = true
    client.setupArtifact(setupId, revisionId, item.contentDigest).then((value) => { if (live) { setBundle(value); setError(false) } })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [client, setupId, revisionId, item.contentDigest, open, reload])
  const files = bundle?.entries.filter((entry) => entry.kind === 'file') ?? []
  const file = files.find((entry) => entry.path === path) ?? files.find((entry) => entry.path.endsWith('SKILL.md')) ?? files[0]
  let content: string | null = null
  if (file?.contentBase64 && file.contentBase64.length <= 349528) {
    try {
      const bytes = Uint8Array.from(atob(file.contentBase64), (character) => character.charCodeAt(0))
      if (bytes.length <= 256 * 1024 && !bytes.includes(0)) content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch { /* Binary or invalid UTF-8: show the explicit preview limitation. */ }
  } else if (file?.contentBase64 === '') content = ''
  return <div className="library-artifact">
    <button type="button" className="library-row" aria-expanded={open} onClick={() => setOpen(!open)}><span><strong>{item.targetName}</strong><small>{item.toolId} · {item.artifactKind}</small></span><span>{t(open ? 'library.hideContent' : 'library.inspect')}</span></button>
    {open && <div className="library-preview">
      <p className="library-digest">{item.contentDigest}</p>
      {error ? <div role="alert"><p>{t('library.contentError')}</p><button type="button" className="secondary-button" onClick={() => setReload((n) => n + 1)}>{t('errors.retry')}</button></div> : !bundle ? <p role="status">{t('library.loading')}</p> : <>
        {files.length ? <><label className="library-field">{t('library.file')}<select value={file?.path} onChange={(event) => setPath(event.target.value)}>{files.map((entry) => <option key={entry.path}>{entry.path}</option>)}</select></label>
          {content !== null ? <pre className="library-source" tabIndex={0}>{content}</pre> : <p>{t('library.previewUnavailable')}</p>}</> : <p>{t('library.noFiles')}</p>}
      </>}
    </div>}
  </div>
}
