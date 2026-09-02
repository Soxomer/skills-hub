import type { RunnerStatusResponse, ScanDiscovery } from '@ahm/contracts'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  FolderGit2,
  LoaderCircle,
  Plus,
  RefreshCw,
  ScanSearch,
  ServerCog,
} from 'lucide-react'
import { memo, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import type { ControlPlaneClient } from '../api'
import { groupDiscoveriesByTool } from '../scan-state'
import { useProjectScan } from '../useProjectScan'
import { CommandBlock } from './CommandBlock'
import { ProjectSwitchWorkspace } from './ProjectSwitchWorkspace'

interface ProjectScanWorkspaceProps {
  client: ControlPlaneClient
  runner: RunnerStatusResponse
  runnerOnline: boolean
}

export const ProjectScanWorkspace = memo(function ProjectScanWorkspace({
  client,
  runner,
  runnerOnline,
}: ProjectScanWorkspaceProps) {
  const { t } = useTranslation()
  const workflow = useProjectScan(client)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [repositoryIdentity, setRepositoryIdentity] = useState('')
  const selectedInstance = runner.projectInstances.find(
    (instance) => instance.projectId === workflow.selectedProjectId,
  )
  const completedRevision =
    workflow.capture?.defaultRevision ?? workflow.selectedProject?.defaultRevision
  const workerReady = runnerOnline && runner.lastSeenAt !== null
  const projectCommand = `ahm project connect ${workflow.selectedProjectId || '<project-id>'}`
  const showCreateForm = showCreate || (!workflow.loadingProjects && workflow.projects.length === 0)

  const submitProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!(await workflow.createProject(name, repositoryIdentity))) return
    setName('')
    setRepositoryIdentity('')
    setShowCreate(false)
  }

  return (
    <>
      {workflow.error && (
        <div className="notice notice--error" role="alert">
          <AlertTriangle aria-hidden="true" size={19} />
          <div>
            <strong>{t(`projectFlow.errors.${workflow.error.code ?? workflow.error.stage}`)}</strong>
            <p>{t('projectFlow.errors.recovery')}</p>
          </div>
          {workflow.error.stage === 'projects' && (
            <button
              className="text-button"
              type="button"
              onClick={() => void workflow.refreshProjects()}
            >
              <RefreshCw aria-hidden="true" size={15} />
              {t('errors.retry')}
            </button>
          )}
          {workflow.error.stage === 'status' && (
            <button
              className="text-button"
              type="button"
              onClick={() => void workflow.refreshJob()}
            >
              <RefreshCw aria-hidden="true" size={15} />
              {t('errors.retry')}
            </button>
          )}
        </div>
      )}

      <section className="step-panel" aria-labelledby="project-workspace-title">
        <div className="step-heading">
          <span className="step-number">2</span>
          <div>
            <h2 id="project-workspace-title">{t('projectFlow.project.title')}</h2>
            <p>{t('projectFlow.project.description')}</p>
          </div>
        </div>

        {workflow.loadingProjects ? (
          <div className="inline-loading" aria-live="polite">
            <LoaderCircle className="spin" aria-hidden="true" size={17} />
            {t('projectFlow.project.loading')}
          </div>
        ) : (
          <>
            {workflow.projects.length > 0 && (
              <div className="project-picker">
                <label className="field field--select">
                  <span>{t('projectFlow.project.selectLabel')}</span>
                  <span className="select-shell">
                    <select
                      value={workflow.selectedProjectId}
                      onChange={(event) => workflow.selectProject(event.target.value)}
                    >
                      {workflow.projects.map((project) => (
                        <option key={project.projectId} value={project.projectId}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" size={16} />
                  </span>
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setShowCreate((current) => !current)}
                >
                  <Plus aria-hidden="true" size={16} />
                  {showCreate
                    ? t('projectFlow.project.cancelCreate')
                    : t('projectFlow.project.newAction')}
                </button>
              </div>
            )}

            {showCreateForm && (
              <form className="project-create-form" onSubmit={(event) => void submitProject(event)}>
                <div className="project-form-fields">
                  <label className="field">
                    <span>{t('projectFlow.project.nameLabel')}</span>
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={t('projectFlow.project.namePlaceholder')}
                      autoComplete="off"
                      maxLength={120}
                      required
                    />
                  </label>
                  <label className="field">
                    <span>{t('projectFlow.project.repositoryLabel')}</span>
                    <input
                      value={repositoryIdentity}
                      onChange={(event) => setRepositoryIdentity(event.target.value)}
                      placeholder={t('projectFlow.project.repositoryPlaceholder')}
                      autoComplete="off"
                      spellCheck="false"
                      maxLength={500}
                    />
                  </label>
                </div>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={workflow.creatingProject || !name.trim()}
                >
                  {workflow.creatingProject ? (
                    <LoaderCircle className="spin" aria-hidden="true" size={16} />
                  ) : (
                    <Plus aria-hidden="true" size={16} />
                  )}
                  {workflow.creatingProject
                    ? t('projectFlow.project.creating')
                    : t('projectFlow.project.createAction')}
                </button>
              </form>
            )}

            {workflow.selectedProject && (
              <div className="project-identity">
                <FolderGit2 aria-hidden="true" size={20} />
                <div>
                  <strong>{workflow.selectedProject.name}</strong>
                  <code>{workflow.selectedProject.projectId}</code>
                </div>
                {workflow.selectedProject.defaultRevision && (
                  <span className="status-chip status-chip--success">
                    <Check aria-hidden="true" size={14} />
                    {t('projectFlow.project.defaultReady')}
                  </span>
                )}
              </div>
            )}

            {workflow.selectedProjectId && !selectedInstance && (
              <div className="connect-checkout">
                <h3>{t('projectFlow.checkout.title')}</h3>
                <p>{t('projectFlow.checkout.description')}</p>
                <CommandBlock
                  command={projectCommand}
                  name={t('projectFlow.checkout.commandName')}
                />
                <p className="field-help">{t('projectFlow.checkout.help')}</p>
              </div>
            )}

            {selectedInstance && (
              <div className="checkout-connected" role="status">
                <CheckCircle2 aria-hidden="true" size={18} />
                <span>
                  <strong>{t('projectFlow.checkout.connected')}</strong>
                  <small>{t('projectFlow.checkout.instance', { id: selectedInstance.projectInstanceId })}</small>
                </span>
              </div>
            )}
          </>
        )}
      </section>

      <section className="step-panel" aria-labelledby="worker-title">
        <div className="step-heading">
          <span className="step-number">3</span>
          <div>
            <h2 id="worker-title">{t('worker.title')}</h2>
            <p>{t('worker.description')}</p>
          </div>
        </div>
        <CommandBlock command="ahm worker" name={t('worker.title')} />
        <p className={`worker-state ${workerReady ? 'is-online' : ''}`}>
          <span aria-hidden="true" />
          {!runnerOnline
            ? t('worker.offline')
            : workerReady
              ? t('worker.online')
              : t('worker.awaiting')}
        </p>
      </section>

      <section className="step-panel scan-panel" aria-labelledby="scan-title">
        <div className="step-heading">
          <span className="step-number">4</span>
          <div>
            <h2 id="scan-title">{t('projectFlow.scan.title')}</h2>
            <p>{t('projectFlow.scan.description')}</p>
          </div>
        </div>

        {completedRevision ? (
          <DefaultCaptured
            itemCount={completedRevision.itemCount}
            revisionNumber={completedRevision.revisionNumber}
          />
        ) : !workflow.selectedProject ? (
          <Prerequisite icon="project" text={t('projectFlow.scan.needsProject')} />
        ) : !selectedInstance ? (
          <Prerequisite icon="project" text={t('projectFlow.scan.needsCheckout')} />
        ) : !workerReady && !workflow.scan ? (
          <Prerequisite icon="worker" text={t('projectFlow.scan.needsWorker')} />
        ) : workflow.jobStatus?.state === 'succeeded' && workflow.discoveries ? (
          <DiscoveryReview
            discoveries={workflow.discoveries}
            includedDiscoveryIds={workflow.includedDiscoveryIds}
            capturing={workflow.capturing}
            onIncludedChange={workflow.setDiscoveryIncluded}
            onSelectAll={workflow.selectAllEligible}
            onClear={workflow.clearSelection}
            onCapture={() => void workflow.captureDefault()}
          />
        ) : workflow.jobStatus && ['failed', 'expired', 'cancelled'].includes(workflow.jobStatus.state) ? (
          <div className="scan-terminal" role="alert">
            <CircleSlash2 aria-hidden="true" size={21} />
            <div>
              <strong>{t(`projectFlow.job.${workflow.jobStatus.state}`)}</strong>
              <p>{t('projectFlow.scan.failedRecovery')}</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={!workerReady || workflow.startingScan}
              onClick={() => void workflow.startScan(selectedInstance.projectInstanceId)}
            >
              <RefreshCw aria-hidden="true" size={15} />
              {t('projectFlow.scan.retry')}
            </button>
          </div>
        ) : workflow.scan ? (
          <div className="scan-progress" aria-live="polite">
            <LoaderCircle className="spin" aria-hidden="true" size={22} />
            <div>
              <strong>{t(`projectFlow.job.${workflow.jobStatus?.state ?? 'pending'}`)}</strong>
              <p>{t('projectFlow.scan.progressHelp')}</p>
            </div>
            <code>{workflow.scan.jobId}</code>
          </div>
        ) : (
          <div className="scan-ready">
            <ScanSearch aria-hidden="true" size={24} />
            <div>
              <strong>{t('projectFlow.scan.readyTitle')}</strong>
              <p>{t('projectFlow.scan.readyDescription')}</p>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={!workerReady || workflow.startingScan}
              onClick={() => void workflow.startScan(selectedInstance.projectInstanceId)}
            >
              {workflow.startingScan ? (
                <LoaderCircle className="spin" aria-hidden="true" size={16} />
              ) : (
                <ScanSearch aria-hidden="true" size={16} />
              )}
              {workflow.startingScan
                ? t('projectFlow.scan.starting')
                : t('projectFlow.scan.startAction')}
            </button>
          </div>
        )}
      </section>

      {completedRevision && workflow.selectedProject && selectedInstance && (
        <ProjectSwitchWorkspace
          client={client}
          projectId={workflow.selectedProject.projectId}
          projectInstanceId={selectedInstance.projectInstanceId}
          runnerOnline={workerReady}
        />
      )}
    </>
  )
})

function Prerequisite({ icon, text }: { icon: 'project' | 'worker'; text: string }) {
  const Icon = icon === 'project' ? FolderGit2 : ServerCog
  return (
    <div className="prerequisite-state">
      <Icon aria-hidden="true" size={21} />
      <span>{text}</span>
    </div>
  )
}

function DefaultCaptured({ itemCount, revisionNumber }: { itemCount: number; revisionNumber: number }) {
  const { t } = useTranslation()
  return (
    <div className="default-captured" role="status">
      <CheckCircle2 aria-hidden="true" size={25} />
      <div>
        <strong>{t('projectFlow.capture.completeTitle')}</strong>
        <p>{t('projectFlow.capture.completeDescription', { itemCount, revisionNumber })}</p>
      </div>
    </div>
  )
}

interface DiscoveryReviewProps {
  discoveries: ScanDiscovery[]
  includedDiscoveryIds: string[]
  capturing: boolean
  onIncludedChange: (discoveryId: string, included: boolean) => void
  onSelectAll: () => void
  onClear: () => void
  onCapture: () => void
}

function DiscoveryReview({
  discoveries,
  includedDiscoveryIds,
  capturing,
  onIncludedChange,
  onSelectAll,
  onClear,
  onCapture,
}: DiscoveryReviewProps) {
  const { t } = useTranslation()
  const groups = useMemo(() => groupDiscoveriesByTool(discoveries), [discoveries])
  const included = useMemo(() => new Set(includedDiscoveryIds), [includedDiscoveryIds])
  const eligibleCount = discoveries.filter((discovery) => discovery.state === 'available').length

  return (
    <div className="discovery-review">
      <div className="review-toolbar">
        <div>
          <strong>{t('projectFlow.review.title')}</strong>
          <p>
            {t('projectFlow.review.summary', {
              selected: included.size,
              eligible: eligibleCount,
              total: discoveries.length,
            })}
          </p>
        </div>
        <div className="review-actions">
          <button className="text-button" type="button" onClick={onSelectAll}>
            {t('projectFlow.review.selectAll')}
          </button>
          <button className="text-button" type="button" onClick={onClear}>
            {t('projectFlow.review.clear')}
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="empty-state">{t('projectFlow.review.empty')}</div>
      ) : (
        <div className="discovery-groups">
          {groups.map((group) => (
            <section key={group.toolId} className="discovery-group" aria-label={group.toolId}>
              <header>
                <strong>{group.toolId}</strong>
                <span>{t('projectFlow.review.toolCount', { count: group.discoveries.length })}</span>
              </header>
              <div className="discovery-list">
                {group.discoveries.map((discovery) => {
                  const eligible = discovery.state === 'available'
                  return (
                    <label
                      key={discovery.discoveryId}
                      className={`discovery-row discovery-row--${discovery.state}`}
                    >
                      <input
                        type="checkbox"
                        checked={eligible && included.has(discovery.discoveryId)}
                        disabled={!eligible}
                        onChange={(event) =>
                          onIncludedChange(discovery.discoveryId, event.target.checked)
                        }
                      />
                      <span className="discovery-copy">
                        <strong>{discovery.name}</strong>
                        <small>
                          {discovery.portableSource ?? t('projectFlow.review.localFingerprint')}
                        </small>
                      </span>
                      <span className={`status-chip status-chip--${discovery.state}`}>
                        {t(`projectFlow.discoveryState.${discovery.state}`)}
                      </span>
                    </label>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="capture-bar">
        <div>
          <strong>{t('projectFlow.capture.title')}</strong>
          <p>{t('projectFlow.capture.description')}</p>
        </div>
        <button className="primary-button" type="button" disabled={capturing} onClick={onCapture}>
          {capturing ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <Check aria-hidden="true" size={16} />
          )}
          {capturing
            ? t('projectFlow.capture.capturing')
            : t('projectFlow.capture.action', { count: included.size })}
        </button>
      </div>
    </div>
  )
}
