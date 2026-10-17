import type { ProjectSummary, RunnerStatusResponse, SetupRevisionSummary } from '@ahm/contracts'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ControlPlaneClient } from '../api'
import { ProjectSwitchWorkspace } from './ProjectSwitchWorkspace'

interface UseSetupOnProjectProps {
  client: ControlPlaneClient
  revision: SetupRevisionSummary
  defaultProjectId: string | null
  runner: RunnerStatusResponse | null
  runnerOnline: boolean
  onBack: () => void
  onProjects: () => void
  active?: boolean
}

// Extend the incumbent utility UI: exact saved version, explicit destination,
// then the existing reviewed workflow. Navigation never queues local work.
export function UseSetupOnProject({ client, revision, defaultProjectId, runner, runnerOnline, onBack, onProjects, active = true }: UseSetupOnProjectProps) {
  const { t } = useTranslation()
  const [projectList, setProjectList] = useState<{ client: ControlPlaneClient; values: ProjectSummary[] } | null>(null)
  const projects = projectList?.client === client ? projectList.values : null
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)
  const [projectId, setProjectId] = useState('')
  const [checkout, setCheckout] = useState<{ deviceId: string; id: string } | null>(null)
  const instanceId = checkout?.deviceId === runner?.deviceId ? checkout?.id ?? '' : ''
  const [destination, setDestination] = useState<{ deviceId: string; projectId: string; instanceId: string } | null>(null)
  useEffect(() => {
    if (!active) return
    let live = true
    client.projects().then(value => { if (live) { setProjectList({ client, values: value.projects }); setError(false) } })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [client, reload, active])
  const allowedProjects = projects?.filter(project => revision.kind !== 'default' || project.projectId === defaultProjectId) ?? []
  const project = allowedProjects.find(value => value.projectId === projectId)
  const instances = runner?.projectInstances.filter(instance => instance.projectId === projectId) ?? []
  const instance = instances.find(value => value.projectInstanceId === instanceId)
  const online = runnerOnline && runner?.status === 'active'
  const ready = online && project?.defaultRevision && instance
  const bound = destination && destination.deviceId === runner?.deviceId && destination.projectId === projectId
    && destination.instanceId === instance?.projectInstanceId && project?.defaultRevision && runner?.status === 'active'
  return <>
    <button type="button" className="secondary-button library-back" onClick={onBack}>{t('useSetup.back')}</button>
    <div className="page-heading"><div><h1>{t('useSetup.title')}</h1><p>{t('useSetup.version', { name: revision.name, number: revision.revisionNumber })}</p></div></div>
    <p className="library-muted">{t('useSetup.safety')}</p>
    {revision.kind === 'default' && <p>{t('useSetup.defaultOnly')}</p>}
    {!runner ? <div className="notice notice--warning" role="status">{t('useSetup.connect')}</div>
      : !online && <div className="notice notice--warning" role="status">{t(runner.status === 'revoked' ? 'useSetup.revoked' : 'useSetup.offline', { name: runner.label })}</div>}
    {error && <div className="notice notice--error" role="alert"><span>{t('useSetup.loadError')}</span><button type="button" className="secondary-button" onClick={() => { setProjectList(null); setError(false); setReload(value => value + 1) }}>{t('errors.retry')}</button></div>}
    {!projects && !error && <p role="status">{t('useSetup.loading')}</p>}
    {projects && allowedProjects.length === 0 && <p role="status">{t('useSetup.empty')}</p>}
    {destination ? <>
      {!bound ? <div className="notice notice--warning" role="alert">{t('useSetup.destinationChanged')}</div> : <>
        <p className="use-setup-destination">{t('useSetup.destination', { project: project!.name, runner: runner!.label, checkout: instance!.projectInstanceId })}</p>
        <ProjectSwitchWorkspace key={`${destination.deviceId}:${destination.instanceId}:${revision.setupRevisionId}`} client={client}
          projectId={projectId} projectInstanceId={instanceId} runnerOnline={Boolean(online)} requestedRevisionId={revision.setupRevisionId} />
      </>}
      <button type="button" className="secondary-button" onClick={() => setDestination(null)}>{t('useSetup.changeDestination')}</button>
    </> : projects && allowedProjects.length > 0 && <form className="use-setup-form" onSubmit={event => {
      event.preventDefault()
      if (ready && runner) setDestination({ deviceId: runner.deviceId, projectId, instanceId })
    }}>
      <label className="library-field">{t('useSetup.project')}<select value={projectId} onChange={event => { setProjectId(event.target.value); setCheckout(null) }}>
        <option value="">{t('useSetup.chooseProject')}</option>
        {allowedProjects.map(value => <option key={value.projectId} value={value.projectId}>{value.name}</option>)}
      </select></label>
      {project && !project.defaultRevision && <p role="status">{t('useSetup.noDefault')}</p>}
      {project && instances.length === 0 && <p role="status">{t('useSetup.noCheckout')}</p>}
      {project && instances.length > 0 && <label className="library-field">{t('useSetup.checkout')}<select value={instanceId} onChange={event => setCheckout({ deviceId: runner!.deviceId, id: event.target.value })}>
        <option value="">{t('useSetup.chooseCheckout')}</option>
        {instances.map(value => <option key={value.projectInstanceId} value={value.projectInstanceId}>{runner!.label} · {value.projectInstanceId}</option>)}
      </select></label>}
      <div className="library-actions"><button type="submit" className="primary-button" disabled={!ready}>{t('useSetup.continue')}</button></div>
    </form>}
    {(!runner || !online || (projects && allowedProjects.length === 0) || (project && (!project.defaultRevision || instances.length === 0))) &&
      <button type="button" className="secondary-button" onClick={onProjects}>{t('useSetup.goProjects')}</button>}
  </>
}
