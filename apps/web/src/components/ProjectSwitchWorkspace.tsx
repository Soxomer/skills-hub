import type {
  CanonicalPlan,
  PlanAction,
  PlanChangeKind,
  ProjectInstanceOperationsResponse,
  ProjectOperationSummary,
  ProjectSetupStateResponse,
  SetupComposerItem,
} from '@ahm/contracts'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  Equal,
  FileCheck2,
  Link2,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  SearchCheck,
  ShieldAlert,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { memo, useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { ControlPlaneApiError, type ControlPlaneClient } from '../api'
import { actionablePlanCount } from '../switch-state'
import { useSetupSwitch } from '../useSetupSwitch'

interface ProjectSwitchWorkspaceProps {
  client: ControlPlaneClient
  projectId: string
  projectInstanceId: string
  runnerOnline: boolean
}

const inFlightJobStates = ['pending', 'leased', 'acknowledged'] as const

function activeKindFromOperation(
  kind: ProjectInstanceOperationsResponse['activeOperation'] | undefined,
): 'plan' | 'apply' | 'rollback' | null {
  if (!kind) return null
  const map = {
    planSetup: 'plan',
    applyPlan: 'apply',
    rollbackOperation: 'rollback',
  } as const
  return map[kind.kind]
}

function isInFlightJobState(state: string | null): state is (typeof inFlightJobStates)[number] {
  return state !== null && inFlightJobStates.includes(state as (typeof inFlightJobStates)[number])
}

export const ProjectSwitchWorkspace = memo(function ProjectSwitchWorkspace({
  client,
  projectId,
  projectInstanceId,
  runnerOnline,
}: ProjectSwitchWorkspaceProps) {
  const { t } = useTranslation()
  const workflow = useSetupSwitch(client, projectId, projectInstanceId)
  const trackedActiveKind =
    workflow.activeJob?.kind ?? activeKindFromOperation(workflow.operations?.activeOperation)
  const trackedState =
    workflow.jobStatus &&
    workflow.jobStatus.jobId === (workflow.activeJob?.jobId ?? workflow.operations?.activeOperation?.jobId)
      ? workflow.jobStatus.state
      : workflow.operations?.activeOperation?.state ?? null
  const operationInProgress = Boolean(
    trackedActiveKind && isInFlightJobState(trackedState),
  )
  const isWorking = workflow.submitting || operationInProgress
  const statusMatchesActive =
    workflow.jobStatus?.jobId ===
    (workflow.activeJob?.jobId ?? workflow.operations?.activeOperation?.jobId)
  const cancelRequested = Boolean(
    (statusMatchesActive ? workflow.jobStatus?.cancelRequested : false) ||
      workflow.operations?.activeOperation?.cancelRequested,
  )
  const activeRevisionId =
    workflow.activeJob?.setupRevisionId ?? workflow.operations?.activeOperation?.setupRevisionId ?? null
  const terminalFailure =
    workflow.jobStatus &&
    ['failed', 'expired', 'cancelled'].includes(workflow.jobStatus.state) &&
    !workflow.cancelledSafely &&
    !workflow.cancellation

  return (
    <section className="step-panel setup-switch" aria-labelledby="setup-switch-title">
      <div className="step-heading setup-switch-heading">
        <span className="step-number">5</span>
        <div>
          <h2 id="setup-switch-title">{t('switchFlow.title')}</h2>
          <p>{t('switchFlow.description')}</p>
        </div>
        {workflow.state?.assignedSetupRevisionId && (
          <span className="status-chip status-chip--success">
            <CheckCircle2 aria-hidden="true" size={14} />
            {t('switchFlow.assigned')}
          </span>
        )}
      </div>

      {!runnerOnline && (
        <div className="notice notice--warning switch-notice" role="status">
          <AlertTriangle aria-hidden="true" size={18} />
          <div>
            <strong>{t('switchFlow.offlineTitle')}</strong>
            <p>{t('switchFlow.offlineDescription')}</p>
          </div>
        </div>
      )}

      {workflow.error && (
        <div className="notice notice--error switch-notice" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <div>
            <strong>
              {t(`switchFlow.errors.${workflow.error.code ?? workflow.error.stage}`)}
            </strong>
            <p>{t('switchFlow.errors.recovery')}</p>
          </div>
        </div>
      )}

      {workflow.operationConflict && (
        <div className="operation-decision" role="alert" aria-live="assertive">
          <ShieldAlert aria-hidden="true" size={21} />
          <div>
            <strong>{t('switchFlow.decision.title')}</strong>
            <p>
              {t('switchFlow.decision.description', {
                setup: revisionLabel(workflow.state, activeRevisionId, t('switchFlow.health.none')),
              })}
            </p>
          </div>
          <div className="operation-decision-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={workflow.keepOperationRunning}
            >
              {t('switchFlow.decision.keep')}
            </button>
            <button
              className="secondary-button cancel-button"
              type="button"
              disabled={workflow.submitting || cancelRequested}
              onClick={() => void workflow.cancelActiveOperation()}
            >
              {t('switchFlow.decision.cancel')}
            </button>
          </div>
        </div>
      )}

      {operationInProgress && (
        <ActiveOperation
          kind={trackedActiveKind}
          state={trackedState}
          setup={revisionLabel(workflow.state, activeRevisionId, t('switchFlow.health.none'))}
          cancelRequested={cancelRequested}
          cancelling={workflow.submitting}
          onCancel={() => void workflow.cancelActiveOperation()}
        />
      )}

      {workflow.planWasStale && (
        <div className="notice notice--warning switch-notice" role="status">
          <RefreshCw aria-hidden="true" size={18} />
          <div>
            <strong>{t('switchFlow.stale.title')}</strong>
            <p>{t('switchFlow.stale.description')}</p>
          </div>
        </div>
      )}

      {workflow.operations && (
        <MaterializationStatus
          state={workflow.state}
          status={workflow.operations}
          runnerOnline={runnerOnline}
          busy={isWorking}
          onVerify={() => void workflow.retryRecovery()}
        />
      )}

      {workflow.loading ? (
        <div className="inline-loading" aria-live="polite">
          <LoaderCircle className="spin" aria-hidden="true" size={17} />
          {t('switchFlow.loading')}
        </div>
      ) : workflow.state?.revisions.length === 0 ? (
        <p className="empty-state">{t('switchFlow.empty')}</p>
      ) : workflow.restored ? (
        <div className="operation-result operation-result--success" role="status">
          <RotateCcw aria-hidden="true" size={24} />
          <div>
            <strong>{t('switchFlow.rollback.completeTitle')}</strong>
            <p>
              {workflow.restored.restoredSetupRevisionId
                ? t('switchFlow.rollback.restored', {
                    revision: workflow.restored.restoredSetupRevisionId,
                  })
                : t('switchFlow.rollback.cleared')}
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={!runnerOnline || workflow.submitting}
            onClick={() => void workflow.preparePlan()}
          >
            {t('switchFlow.prepareAgain')}
          </button>
        </div>
      ) : workflow.receipt ? (
        <>
          <div className="operation-result operation-result--success" role="status">
            <CheckCircle2 aria-hidden="true" size={24} />
            <div>
              <strong>{t(`switchFlow.receipt.${workflow.receipt.outcome}Title`)}</strong>
              <p>
                {t('switchFlow.receipt.summary', {
                  count: workflow.receipt.actionsApplied,
                })}
              </p>
              <code>{workflow.receipt.operationId}</code>
            </div>
            {workflow.receipt.recoverability === 'rollbackAvailable' && (
              <button
                className="secondary-button"
                type="button"
                disabled={!runnerOnline || workflow.submitting}
                onClick={() => void workflow.rollback()}
              >
                {isWorking && trackedActiveKind === 'rollback' ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={15} />
                ) : (
                  <RotateCcw aria-hidden="true" size={15} />
                )}
                {isWorking && trackedActiveKind === 'rollback'
                  ? t('switchFlow.rollback.starting')
                  : t('switchFlow.rollback.action')}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          {(workflow.cancellation || workflow.cancelledSafely) && (
            <div
              className={`operation-result operation-result--${
                !workflow.cancellation ||
                workflow.cancellation.outcome === 'cancelledAndRestored'
                  ? 'success'
                  : 'warning'
              }`}
              role="status"
            >
              <ShieldAlert aria-hidden="true" size={24} />
              <div>
                <strong>{t('switchFlow.cancellation.title')}</strong>
                <p>
                  {workflow.cancelledSafely
                    ? t('switchFlow.cancellation.cancelledWithoutChanges')
                    : workflow.cancellation?.outcome === 'cancelledAndRestored'
                      ? t('switchFlow.cancellation.cancelledAndRestored')
                      : t('switchFlow.cancellation.needsAttention')}
                </p>
                {workflow.cancellation?.operationId && (
                  <code>{workflow.cancellation.operationId}</code>
                )}
              </div>
            </div>
          )}

          <SetupPicker
            state={workflow.state}
            selectedRevisionId={workflow.selectedRevisionId}
            disabled={isWorking || workflow.operations?.health === 'attention'}
            onChange={workflow.selectRevision}
          />

          <SetupComposer
            client={client}
            disabled={isWorking}
            onCreated={async (setupRevisionId) => {
              await workflow.refreshState()
              workflow.selectRevision(setupRevisionId)
            }}
          />

          <div className="setup-actions">
            <div>
              <strong>{workflow.selectedRevision?.name}</strong>
              <p>
                {workflow.selectedRevision
                  ? t('switchFlow.selectionSummary', {
                      revision: workflow.selectedRevision.revisionNumber,
                      count: workflow.selectedRevision.itemCount,
                    })
                  : t('switchFlow.selectPrompt')}
              </p>
            </div>
            <div className="setup-action-buttons">
              {workflow.state?.defaultSetupRevisionId &&
                workflow.state.defaultSetupRevisionId !== workflow.selectedRevisionId && (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!runnerOnline || isWorking || workflow.operations?.health === 'attention'}
                    onClick={() =>
                      void workflow.preparePlan(workflow.state?.defaultSetupRevisionId ?? '')
                    }
                  >
                    <Sparkles aria-hidden="true" size={15} />
                    {t('switchFlow.useDefault')}
                  </button>
                )}
              <button
                className="primary-button"
                type="button"
                disabled={
                  !runnerOnline ||
                  !workflow.selectedRevisionId ||
                  isWorking ||
                  workflow.operations?.health === 'attention'
                }
                onClick={() => void workflow.preparePlan()}
              >
                {isWorking && trackedActiveKind === 'plan' ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={16} />
                ) : (
                  <Download aria-hidden="true" size={16} />
                )}
                {isWorking && trackedActiveKind === 'plan'
                  ? t('switchFlow.preparing')
                  : t('switchFlow.prepare')}
              </button>
            </div>
          </div>

          {terminalFailure && (
            <div className="switch-terminal" role="alert">
              <AlertTriangle aria-hidden="true" size={20} />
              <div>
                <strong>{t(`switchFlow.job.${workflow.jobStatus?.state ?? 'failed'}`)}</strong>
                <p>{t('switchFlow.errors.recovery')}</p>
              </div>
            </div>
          )}

          {workflow.plan && <PlanReview plan={workflow.plan} />}

          {workflow.plan &&
            workflow.plan.conflicts.length === 0 &&
            workflow.operations?.health !== 'attention' && (
            <div className="approval-bar">
              <div>
                <strong>{t('switchFlow.approval.title')}</strong>
                <p>{t('switchFlow.approval.description')}</p>
              </div>
              <button
                className="primary-button"
                type="button"
                disabled={!runnerOnline || isWorking}
                onClick={() => void workflow.applyPlan()}
              >
                {isWorking && trackedActiveKind === 'apply' ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={16} />
                ) : (
                  <FileCheck2 aria-hidden="true" size={16} />
                )}
                {isWorking && trackedActiveKind === 'apply'
                  ? t('switchFlow.approval.applying')
                  : t('switchFlow.approval.action')}
              </button>
            </div>
          )}
        </>
      )}

      {workflow.operations && <OperationHistory status={workflow.operations} />}
    </section>
  )
})

function composerItemKey(item: SetupComposerItem): string {
  return [
    item.sourceSetupRevisionId,
    item.artifactId,
    item.toolId,
    item.targetName,
  ].join('\u0000')
}

function SetupComposer({
  client,
  disabled,
  onCreated,
}: {
  client: ControlPlaneClient
  disabled: boolean
  onCreated: (setupRevisionId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [items, setItems] = useState<SetupComposerItem[]>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError(null)
    void client
      .setupComposer()
      .then((response) => {
        if (active) setItems(response.items)
      })
      .catch((nextError: unknown) => {
        if (active) {
          setError(
            nextError instanceof ControlPlaneApiError
              ? (nextError.code ?? 'composer')
              : 'composer',
          )
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, open])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const selectedItems = items.filter((item) => selectedKeys.has(composerItemKey(item)))
    setCreating(true)
    setError(null)
    try {
      const created = await client.createSetup({
        name,
        items: selectedItems.map((item) => ({
          sourceSetupRevisionId: item.sourceSetupRevisionId,
          artifactId: item.artifactId,
          contentDigest: item.contentDigest,
          toolId: item.toolId,
          targetName: item.targetName,
        })),
      })
      await onCreated(created.setupRevisionId)
      setName('')
      setSelectedKeys(new Set())
      setOpen(false)
    } catch (nextError) {
      setError(
        nextError instanceof ControlPlaneApiError ? (nextError.code ?? 'create') : 'create',
      )
    } finally {
      setCreating(false)
    }
  }

  if (!open) {
    return (
      <div className="setup-composer-trigger">
        <div>
          <strong>{t('switchFlow.composer.title')}</strong>
          <p>{t('switchFlow.composer.description')}</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <Plus aria-hidden="true" size={15} />
          {t('switchFlow.composer.open')}
        </button>
      </div>
    )
  }

  return (
    <form className="setup-composer" onSubmit={(event) => void submit(event)}>
      <div className="setup-composer-heading">
        <div>
          <strong>{t('switchFlow.composer.title')}</strong>
          <p>{t('switchFlow.composer.help')}</p>
        </div>
        <button
          className="text-button"
          type="button"
          disabled={creating}
          onClick={() => setOpen(false)}
        >
          {t('switchFlow.composer.close')}
        </button>
      </div>
      <label className="field">
        <span>{t('switchFlow.composer.nameLabel')}</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('switchFlow.composer.namePlaceholder')}
          autoComplete="off"
          maxLength={120}
          required
        />
      </label>
      {loading ? (
        <div className="inline-loading" aria-live="polite">
          <LoaderCircle className="spin" aria-hidden="true" size={17} />
          {t('switchFlow.composer.loading')}
        </div>
      ) : items.length === 0 ? (
        <p className="empty-state">{t('switchFlow.composer.empty')}</p>
      ) : (
        <fieldset className="setup-composer-items">
          <legend>{t('switchFlow.composer.itemsLabel')}</legend>
          {items.map((item) => {
            const key = composerItemKey(item)
            return (
              <label key={key} className="setup-composer-item">
                <input
                  type="checkbox"
                  checked={selectedKeys.has(key)}
                  disabled={creating}
                  onChange={(event) => {
                    setSelectedKeys((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(key)
                      else next.delete(key)
                      return next
                    })
                  }}
                />
                <span>
                  <strong>{item.targetName}</strong>
                  <small>
                    {t('switchFlow.composer.itemMeta', {
                      kind: t(`switchFlow.composer.artifactKind.${item.artifactKind}`),
                      tool: item.toolId,
                      source: item.sourceSetupName,
                      revision: item.sourceRevisionNumber,
                    })}
                  </small>
                  <code title={item.contentDigest}>
                    {item.contentDigest.length > 28
                      ? `${item.contentDigest.slice(0, 28)}…`
                      : item.contentDigest}
                  </code>
                </span>
              </label>
            )
          })}
        </fieldset>
      )}
      {error && (
        <div className="notice notice--error setup-composer-error" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <strong>{t(`switchFlow.composer.errors.${error}`)}</strong>
        </div>
      )}
      <div className="setup-composer-actions">
        <span>
          {t('switchFlow.composer.selected', { count: selectedKeys.size })}
        </span>
        <button
          className="primary-button"
          type="submit"
          disabled={creating || !name.trim() || selectedKeys.size === 0}
        >
          {creating ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <Plus aria-hidden="true" size={16} />
          )}
          {creating ? t('switchFlow.composer.creating') : t('switchFlow.composer.create')}
        </button>
      </div>
    </form>
  )
}

function revisionLabel(
  state: ProjectSetupStateResponse | null,
  revisionId: string | null,
  fallback: string,
): string {
  if (!revisionId) return fallback
  const revision = state?.revisions.find((candidate) => candidate.setupRevisionId === revisionId)
  return revision ? `${revision.name} · v${revision.revisionNumber}` : revisionId
}

function MaterializationStatus({
  state,
  status,
  runnerOnline,
  busy,
  onVerify,
}: {
  state: ProjectSetupStateResponse | null
  status: ProjectInstanceOperationsResponse
  runnerOnline: boolean
  busy: boolean
  onVerify: () => void
}) {
  const { t } = useTranslation()
  const needsAction = status.health === 'drifted' || status.health === 'attention'
  const Icon =
    status.health === 'current'
      ? CheckCircle2
      : status.health === 'attention'
        ? ShieldAlert
        : SearchCheck
  return (
    <div className={`materialization-status materialization-status--${status.health}`}>
      <Icon aria-hidden="true" size={21} />
      <div className="materialization-copy">
        <strong>{t(`switchFlow.health.${status.health}.title`)}</strong>
        <p>{t(`switchFlow.health.${status.health}.description`)}</p>
        <dl>
          <div>
            <dt>{t('switchFlow.health.assigned')}</dt>
            <dd>
              {revisionLabel(state, status.assignedSetupRevisionId, t('switchFlow.health.none'))}
            </dd>
          </div>
          <div>
            <dt>{t('switchFlow.health.materialized')}</dt>
            <dd>
              {revisionLabel(
                state,
                status.materializedSetupRevisionId,
                t('switchFlow.health.unverified'),
              )}
            </dd>
          </div>
        </dl>
      </div>
      {needsAction && (
        <button
          className="secondary-button"
          type="button"
          disabled={!runnerOnline || busy}
          onClick={onVerify}
        >
          <SearchCheck aria-hidden="true" size={15} />
          {status.health === 'attention'
            ? t('switchFlow.health.attention.retry')
            : t('switchFlow.health.verify')}
        </button>
      )}
    </div>
  )
}

function ActiveOperation({
  kind,
  state,
  setup,
  cancelRequested,
  cancelling,
  onCancel,
}: {
  kind: 'plan' | 'apply' | 'rollback' | null
  state: string | null
  setup: string
  cancelRequested: boolean
  cancelling: boolean
  onCancel: () => void
}) {
  const { t } = useTranslation()
  if (!kind) return null
  const phase = cancelRequested
    ? kind === 'plan'
      ? 'cancelling'
      : 'restoring'
    : kind
  return (
    <div className="switch-progress" aria-live="polite">
      <LoaderCircle className="spin" aria-hidden="true" size={20} />
      <div>
        <strong>{t(`switchFlow.progress.${phase}`)}</strong>
        <p>{t('switchFlow.progress.detail', { setup, state: t(`switchFlow.job.${state ?? 'pending'}`) })}</p>
      </div>
      <button
        className="secondary-button cancel-button"
        type="button"
        disabled={cancelRequested || cancelling}
        onClick={onCancel}
      >
        {cancelRequested ? t('switchFlow.progress.cancelRequested') : t('switchFlow.decision.cancel')}
      </button>
    </div>
  )
}

function operationTime(value: string): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function OperationHistory({ status }: { status: ProjectInstanceOperationsResponse }) {
  const { t } = useTranslation()
  return (
    <section className="operation-history" aria-labelledby="operation-history-title">
      <div className="operation-history-heading">
        <Activity aria-hidden="true" size={18} />
        <div>
          <h3 id="operation-history-title">{t('switchFlow.history.title')}</h3>
          <p>{t('switchFlow.history.description')}</p>
        </div>
      </div>
      {status.operations.length === 0 ? (
        <p className="empty-state">{t('switchFlow.history.empty')}</p>
      ) : (
        <ol>
          {status.operations.map((operation) => (
            <OperationHistoryItem key={operation.jobId} operation={operation} />
          ))}
        </ol>
      )}
    </section>
  )
}

function OperationHistoryItem({ operation }: { operation: ProjectOperationSummary }) {
  const { t } = useTranslation()
  const failed = ['failed', 'expired', 'cancelled'].includes(operation.state)
  return (
    <li>
      <span
        className={`history-state history-state--${failed ? 'error' : operation.state}`}
        aria-hidden="true"
      />
      <div>
        <strong>{t(`switchFlow.history.kind.${operation.kind}`)}</strong>
        <p>
          {operation.errorCode
            ? t(`switchFlow.errors.${operation.errorCode}`)
            : t(`switchFlow.job.${operation.state}`)}
        </p>
      </div>
      <div className="history-meta">
        <time dateTime={operation.completedAt ?? operation.issuedAt}>
          {operationTime(operation.completedAt ?? operation.issuedAt)}
        </time>
        <code>{operation.operationId ?? operation.jobId}</code>
      </div>
    </li>
  )
}

function SetupPicker({
  state,
  selectedRevisionId,
  disabled,
  onChange,
}: {
  state: ProjectSetupStateResponse | null
  selectedRevisionId: string
  disabled: boolean
  onChange: (revisionId: string) => void
}) {
  const { t } = useTranslation()
  return (
    <label className="field setup-picker">
      <span>{t('switchFlow.selectLabel')}</span>
      <span className="select-shell">
        <select
          value={selectedRevisionId}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {state?.revisions.map((revision) => (
            <option key={revision.setupRevisionId} value={revision.setupRevisionId}>
              {revision.name} · v{revision.revisionNumber}
              {revision.setupRevisionId === state.defaultSetupRevisionId
                ? ` · ${t('switchFlow.defaultLabel')}`
                : ''}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" size={16} />
      </span>
    </label>
  )
}

const planGroups: PlanChangeKind[] = ['add', 'replace', 'remove', 'unchanged']

function planChange(action: PlanAction): PlanChangeKind {
  return action.change ?? (action.kind === 'removeManaged' ? 'remove' : 'add')
}

function PlanReview({ plan }: { plan: CanonicalPlan }) {
  const { t } = useTranslation()
  const actionableCount = actionablePlanCount(plan)
  return (
    <div className="plan-review">
      <div className="plan-review-heading">
        <div>
          <strong>{t('switchFlow.plan.title')}</strong>
          <p>{t('switchFlow.plan.summary', { count: actionableCount })}</p>
        </div>
        <code title={plan.planDigest}>{plan.planDigest.slice(0, 20)}…</code>
      </div>
      {plan.actions.length === 0 ? (
        <p className="empty-state">{t('switchFlow.plan.noChanges')}</p>
      ) : (
        <div className="plan-groups">
          {planGroups.map((group) => {
            const actions = plan.actions.filter((action) => planChange(action) === group)
            if (actions.length === 0) return null
            const Icon = group === 'add' ? Plus : group === 'replace' ? RefreshCw : group === 'remove' ? Minus : Equal
            return (
              <section className="plan-group" key={group} aria-labelledby={`plan-group-${group}`}>
                <h4 id={`plan-group-${group}`}>
                  <Icon aria-hidden="true" size={15} />
                  {t(`switchFlow.plan.group.${group}`, { count: actions.length })}
                </h4>
                <ul className="plan-action-list">
                  {actions.map((action) => {
                    const ActionIcon = action.kind === 'removeManaged' ? Trash2 : Link2
                    return (
                      <li key={action.actionId}>
                        <ActionIcon aria-hidden="true" size={16} />
                        <span>
                          <strong>
                            {action.metadataOnly
                              ? t('switchFlow.action.metadataOnly')
                              : planChange(action) === 'unchanged'
                                ? t('switchFlow.action.unchanged')
                                : t(`switchFlow.action.${action.kind}`)}
                          </strong>
                          <code>{action.destination.projectRelativePath}</code>
                        </span>
                        <small>{action.destination.toolId}</small>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
      {plan.conflicts.length > 0 && (
        <div className="plan-conflicts" role="alert">
          <strong>{t('switchFlow.plan.conflicts', { count: plan.conflicts.length })}</strong>
          <ul>
            {plan.conflicts.map((conflict) => (
              <li key={conflict}>{conflict}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
