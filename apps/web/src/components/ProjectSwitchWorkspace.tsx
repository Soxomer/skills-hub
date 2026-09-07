import type {
  CanonicalPlan,
  ProjectInstanceOperationsResponse,
  ProjectOperationSummary,
  ProjectSetupStateResponse,
} from '@ahm/contracts'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  FileCheck2,
  Link2,
  LoaderCircle,
  SearchCheck,
  ShieldAlert,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'

import type { ControlPlaneClient } from '../api'
import { CommandBlock } from './CommandBlock'
import { useSetupSwitch } from '../useSetupSwitch'

interface ProjectSwitchWorkspaceProps {
  client: ControlPlaneClient
  projectId: string
  projectInstanceId: string
  runnerOnline: boolean
}

const inFlightJobStates = ['pending', 'leased', 'acknowledged'] as const

function activeKindFromOperation(
  kind: ProjectInstanceOperationsResponse['activeOperation'],
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
  const terminalFailure =
    workflow.jobStatus &&
    ['failed', 'expired', 'cancelled'].includes(workflow.jobStatus.state)

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

      {workflow.operations && (
        <MaterializationStatus
          state={workflow.state}
          status={workflow.operations}
          runnerOnline={runnerOnline}
          busy={isWorking}
          onVerify={() => void workflow.preparePlan()}
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
          {trackedActiveKind === 'rollback' && isInFlightJobState(trackedState) && (
            <div className="switch-progress" aria-live="polite">
              <LoaderCircle className="spin" aria-hidden="true" size={20} />
              <div>
                <strong>{t('switchFlow.progress.rollback')}</strong>
                <p>{t(`switchFlow.job.${trackedState ?? 'pending'}`)}</p>
              </div>
            </div>
          )}
        </>
      ) : workflow.cancellation ? (
        <div className="operation-result operation-result--warning" role="status">
          <ShieldAlert aria-hidden="true" size={24} />
          <div>
            <strong>{t('switchFlow.cancellation.title')}</strong>
            <p>
              {workflow.cancellation.outcome === 'cancelledAndRestored'
                ? t('switchFlow.cancellation.cancelledAndRestored')
                : t('switchFlow.cancellation.needsAttention')}
            </p>
            <code>{workflow.cancellation.operationId ?? t('switchFlow.cancellation.pendingId')}</code>
          </div>
          <p className="operation-result-details">
            {t('switchFlow.receipt.summary', { count: workflow.cancellation.actionsApplied })}
          </p>
          <button
            className="secondary-button"
            type="button"
            onClick={workflow.recoverFromCancellation}
          >
            {t('switchFlow.cancellation.returnToSetup')}
          </button>
        </div>
      ) : (
        <>
          <SetupPicker
            state={workflow.state}
            selectedRevisionId={workflow.selectedRevisionId}
            disabled={isWorking}
            onChange={workflow.selectRevision}
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
                    disabled={!runnerOnline || isWorking}
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
                disabled={!runnerOnline || !workflow.selectedRevisionId || isWorking}
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

          {trackedActiveKind && isInFlightJobState(trackedState) && (
            <div className="switch-progress" aria-live="polite">
              <LoaderCircle className="spin" aria-hidden="true" size={20} />
              <div>
                <strong>{t(`switchFlow.progress.${trackedActiveKind}`)}</strong>
                <p>{t(`switchFlow.job.${trackedState ?? 'pending'}`)}</p>
              </div>
            </div>
          )}

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

          {workflow.plan && workflow.plan.conflicts.length === 0 && (
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
          {t('switchFlow.health.verify')}
        </button>
      )}
      {status.health === 'attention' && (
        <div className="manual-recovery">
          <p>{t('switchFlow.health.attention.command')}</p>
          <CommandBlock command="ahm rollback" name={t('switchFlow.health.attention.commandName')} />
        </div>
      )}
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

function PlanReview({ plan }: { plan: CanonicalPlan }) {
  const { t } = useTranslation()
  return (
    <div className="plan-review">
      <div className="plan-review-heading">
        <div>
          <strong>{t('switchFlow.plan.title')}</strong>
          <p>{t('switchFlow.plan.summary', { count: plan.actions.length })}</p>
        </div>
        <code title={plan.planDigest}>{plan.planDigest.slice(0, 20)}…</code>
      </div>
      {plan.actions.length === 0 ? (
        <p className="empty-state">{t('switchFlow.plan.noChanges')}</p>
      ) : (
        <ul className="plan-action-list">
          {plan.actions.map((action) => {
            const Icon = action.kind === 'removeManaged' ? Trash2 : Link2
            return (
              <li key={action.actionId}>
                <Icon aria-hidden="true" size={16} />
                <span>
                  <strong>{t(`switchFlow.action.${action.kind}`)}</strong>
                  <code>{action.destination.projectRelativePath}</code>
                </span>
                <small>{action.destination.toolId}</small>
              </li>
            )
          })}
        </ul>
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
