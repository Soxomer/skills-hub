import type { RunnerStatusResponse } from '@ahm/contracts'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface SkillLibraryProps {
  runner: RunnerStatusResponse | null
  online: boolean
  error: boolean
  onRefresh: () => Promise<void>
  onProjects: () => void
}

export function SkillLibrary({ runner, online, error, onRefresh, onProjects }: SkillLibraryProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [enabled, setEnabled] = useState('all')
  const [refreshing, setRefreshing] = useState(false)
  const library = runner?.status === 'active' ? runner.skillLibrary : null
  const tags = useMemo(() => [...new Set(library?.skills.flatMap(skill => skill.tags) ?? [])].sort(), [library])
  const skills = useMemo(() => (library?.skills ?? []).filter(skill =>
    `${skill.name} ${skill.tags.join(' ')} ${skill.targets.map(target => target.tool).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()) &&
    (!tag || skill.tags.includes(tag)) && (enabled === 'all' || skill.enabled === (enabled === 'enabled'))
  ).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), [library, search, tag, enabled])
  return <section className="skill-library" aria-labelledby="skills-title">
    <div className="page-heading">
      <div><h1 id="skills-title">{t('skills.title')}</h1><p>{t('skills.description')}</p></div>
      <button type="button" className="secondary-button" disabled={refreshing} onClick={async () => {
        setRefreshing(true)
        try { await onRefresh() } finally { setRefreshing(false) }
      }}>{t(refreshing ? 'skills.refreshing' : 'skills.refresh')}</button>
    </div>
    {error && <p className="notice notice--error" role="alert">{t('skills.error')}</p>}
    {!runner || runner.status === 'revoked' ? <div className="empty-state">
      <h2>{t('skills.connectTitle')}</h2><p>{t('skills.connectDescription')}</p>
      <button className="primary-button" type="button" onClick={onProjects}>{t('library.goProjects')}</button>
    </div> : <>
      <p className="skill-library-context">{t('skills.device', { label: runner.label })} {library && t('skills.reported', { date: new Date(library.reportedAt).toLocaleString('en') })}</p>
      {!online && <p className="notice notice--warning" role="status">{t('skills.offline')}</p>}
      {!library ? <p role="status">{t('skills.waiting')}</p> : library.skills.length === 0 ?
        <div className="empty-state"><h2>{t('skills.emptyTitle')}</h2><p>{t('skills.emptyDescription')}</p></div> : <>
          <div className="skill-library-filters">
            <label>{t('skills.search')}<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label>{t('skills.tag')}<select value={tag} onChange={event => setTag(event.target.value)}>
              <option value="">{t('skills.allTags')}</option>{tags.map(value => <option key={value}>{value}</option>)}
            </select></label>
            <label>{t('skills.state')}<select value={enabled} onChange={event => setEnabled(event.target.value)}>
              {['all', 'enabled', 'disabled'].map(value => <option key={value} value={value}>{t(`skills.${value}`)}</option>)}
            </select></label>
          </div>
          <p role="status">{t('skills.count', { count: skills.length, total: library.skills.length })}</p>
          {skills.length === 0 ? <div className="empty-state"><p>{t('skills.noResults')}</p>
            <button className="secondary-button" type="button" onClick={() => { setSearch(''); setTag(''); setEnabled('all') }}>{t('skills.clear')}</button></div> :
            <div className="skill-library-table" role="region" aria-label={t('skills.title')} tabIndex={0}><table>
              <thead><tr>{['name', 'source', 'tag', 'targets', 'state'].map(key => <th key={key} scope="col">{t(`skills.${key}`)}</th>)}</tr></thead>
              <tbody>{skills.map(skill => <tr key={skill.id}>
                <th scope="row">{skill.name}</th><td>{t(`skills.sources.${skill.sourceType}`)}</td>
                <td>{skill.tags.join(', ') || t('skills.noTags')}</td>
                <td>{skill.targets.length ? skill.targets.map(target => `${target.tool} (${t(`skills.scopes.${target.scope}`)})`).join(', ') : t('skills.noTargets')}</td>
                <td>{t(skill.enabled ? 'skills.enabled' : 'skills.disabled')}</td>
              </tr>)}</tbody>
            </table></div>}
        </>}
      <p className="skill-library-note">{t('skills.readOnly')}</p>
    </>}
  </section>
}
