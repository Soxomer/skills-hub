import { memo, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import ScopeSelector from '../ScopeSelector'
import {
  normalizeProjectPaths,
  type InstallScope,
} from '../installScope'
import type { ManagedSkill } from '../types'

type ScopeSyncModalProps = {
  open: boolean
  loading: boolean
  skill: ManagedSkill | null
  scope: InstallScope
  projects: string[]
  recentProjects: string[]
  onRequestClose: () => void
  onScopeChange: (scope: InstallScope, projects: string[]) => void
  onPickProject: () => Promise<string | undefined>
  t: TFunction
}

const ScopeSyncModal = ({
  open,
  loading,
  skill,
  scope,
  projects,
  recentProjects,
  onRequestClose,
  onScopeChange,
  onPickProject,
  t,
}: ScopeSyncModalProps) => {
  const [draftScope, setDraftScope] = useState<InstallScope>(scope)
  const [draftProjects, setDraftProjects] = useState<string[]>(projects)

  const normalizedProjects = useMemo(
    () => normalizeProjectPaths(projects),
    [projects],
  )
  const normalizedDraftProjects = useMemo(
    () => normalizeProjectPaths(draftProjects),
    [draftProjects],
  )
  const projectListChanged =
    normalizedProjects.length !== normalizedDraftProjects.length ||
    normalizedProjects.some((item) => !normalizedDraftProjects.includes(item))
  const hasScopeChange = draftScope !== scope
  const requiresProject = draftScope === 'project' && normalizedDraftProjects.length === 0

  if (!open || !skill) return null

  return (
    <div className="modal-backdrop" onClick={loading ? undefined : onRequestClose}>
      <div
        className="modal scope-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title">
            {t('projectSync.title')} · {skill.name}
          </div>
          <button
            className="modal-close"
            type="button"
            onClick={onRequestClose}
            disabled={loading}
            aria-label={t('close')}
          >
            ✕
          </button>
        </div>
        <div className="modal-body scope-modal-body">
          <div className="scope-help">{t('projectSync.help')}</div>
          <ScopeSelector
            scope={draftScope}
            projects={normalizedDraftProjects}
            recentProjects={recentProjects}
            disabled={loading}
            showRequired={requiresProject}
            onScopeChange={setDraftScope}
            onProjectsChange={setDraftProjects}
            onPickProject={onPickProject}
            t={t}
          />
        </div>
        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={onRequestClose}
            disabled={loading}
          >
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => onScopeChange(draftScope, normalizedDraftProjects)}
            disabled={loading || (!hasScopeChange && !projectListChanged) || requiresProject}
          >
            {t('projectSync.applyScope')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default memo(ScopeSyncModal)
