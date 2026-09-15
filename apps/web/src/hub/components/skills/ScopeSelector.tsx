import { memo, useId, useMemo, type SetStateAction } from 'react'
import { Folder, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import {
  getAvailableRecentProjects,
  normalizeProjectPaths,
  type InstallScope,
} from './installScope'

type ScopeSelectorProps = {
  scope: InstallScope
  projects: string[]
  recentProjects: string[]
  disabled?: boolean
  showRequired?: boolean
  compact?: boolean
  title?: string
  ariaLabelledBy?: string
  onScopeChange: (scope: InstallScope) => void
  onProjectsChange: (projects: SetStateAction<string[]>) => void
  onPickProject: () => Promise<string | undefined>
  t: TFunction
}

const ScopeSelector = ({
  scope,
  projects,
  recentProjects,
  disabled = false,
  showRequired = true,
  compact = false,
  title,
  ariaLabelledBy,
  onScopeChange,
  onProjectsChange,
  onPickProject,
  t,
}: ScopeSelectorProps) => {
  const scopeRadioName = useId()
  const compactTitleId = useId()
  const normalizedProjects = useMemo(
    () => normalizeProjectPaths(projects),
    [projects],
  )
  const availableRecentProjects = useMemo(
    () => getAvailableRecentProjects(recentProjects, normalizedProjects),
    [recentProjects, normalizedProjects],
  )

  const addProject = (projectPath: string) => {
    onProjectsChange((current) =>
      normalizeProjectPaths([...current, projectPath]),
    )
  }

  return (
    <div
      className={`scope-selector${compact ? ' scope-selector-compact' : ''}`}
      role={compact ? undefined : 'radiogroup'}
      aria-labelledby={compact ? undefined : ariaLabelledBy}
      aria-label={compact || ariaLabelledBy ? undefined : t('projectSync.title')}
    >
      {compact ? (
        <>
          <div className="scope-compact-header">
            {title ? (
              <div className="label" id={compactTitleId}>
                {title}
              </div>
            ) : null}
            <div
              className="scope-toggle"
              role="radiogroup"
              aria-labelledby={title ? compactTitleId : ariaLabelledBy}
            >
              <button
                type="button"
                className={`scope-toggle-item${scope === 'global' ? ' active' : ''}`}
                onClick={() => onScopeChange('global')}
                disabled={disabled}
                aria-pressed={scope === 'global'}
              >
                {t('scope.global')}
              </button>
              <button
                type="button"
                className={`scope-toggle-item${scope === 'project' ? ' active' : ''}`}
                onClick={() => onScopeChange('project')}
                disabled={disabled}
                aria-pressed={scope === 'project'}
              >
                {t('scope.project')}
              </button>
            </div>
          </div>

          {scope === 'project' ? (
            <div className="project-sync-panel">
              <div className="project-sync-heading">{t('projectSync.projectDirs')}</div>
              {normalizedProjects.length > 0 ? (
                <div className="project-path-list">
                  {normalizedProjects.map((project) => (
                    <div className="project-path-row" key={project}>
                      <Folder size={14} />
                      <span className="mono">{project}</span>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() =>
                          onProjectsChange((current) =>
                            normalizeProjectPaths(current).filter(
                              (item) => item !== project,
                            ),
                          )
                        }
                        disabled={disabled}
                        aria-label={t('remove')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="project-empty">{t('projectSync.noProjects')}</div>
              )}
              {showRequired && normalizedProjects.length === 0 ? (
                <div className="scope-inline-warning">
                  {t('projectSync.projectRequired')}
                </div>
              ) : null}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  void onPickProject().then((projectPath) => {
                    if (projectPath) addProject(projectPath)
                  })
                }}
                disabled={disabled}
              >
                {t('projectSync.addProject')}
              </button>

              {availableRecentProjects.length > 0 ? (
                <>
                  <div className="project-sync-heading">
                    {t('projectSync.recentProjects')}
                  </div>
                  <div className="recent-project-list">
                    {availableRecentProjects.map((project) => (
                      <button
                        key={project}
                        type="button"
                        className="recent-project-row"
                        onClick={() => addProject(project)}
                        disabled={disabled}
                      >
                        <span className="mono">{project}</span>
                        <span>{t('projectSync.addRecent')}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <label className={`scope-choice${scope === 'global' ? ' active' : ''}`}>
            <input
              type="radio"
              name={scopeRadioName}
              checked={scope === 'global'}
              onChange={() => onScopeChange('global')}
              disabled={disabled}
            />
            <span>
              <strong>{t('scope.global')}</strong>
              <small>{t('projectSync.globalDesc')}</small>
            </span>
          </label>
          <label className={`scope-choice${scope === 'project' ? ' active' : ''}`}>
            <input
              type="radio"
              name={scopeRadioName}
              checked={scope === 'project'}
              onChange={() => onScopeChange('project')}
              disabled={disabled}
            />
            <span>
              <strong>{t('scope.project')}</strong>
              <small>{t('projectSync.projectDesc')}</small>
            </span>
          </label>

          {scope === 'project' ? (
            <div className="project-sync-panel">
              <div className="project-sync-heading">{t('projectSync.projectDirs')}</div>
              {normalizedProjects.length > 0 ? (
                <div className="project-path-list">
                  {normalizedProjects.map((project) => (
                    <div className="project-path-row" key={project}>
                      <Folder size={14} />
                      <span className="mono">{project}</span>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() =>
                          onProjectsChange((current) =>
                            normalizeProjectPaths(current).filter(
                              (item) => item !== project,
                            ),
                          )
                        }
                        disabled={disabled}
                        aria-label={t('remove')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="project-empty">{t('projectSync.noProjects')}</div>
              )}
              {showRequired && normalizedProjects.length === 0 ? (
                <div className="scope-inline-warning">
                  {t('projectSync.projectRequired')}
                </div>
              ) : null}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  void onPickProject().then((projectPath) => {
                    if (projectPath) addProject(projectPath)
                  })
                }}
                disabled={disabled}
              >
                {t('projectSync.addProject')}
              </button>

              {availableRecentProjects.length > 0 ? (
                <>
                  <div className="project-sync-heading">
                    {t('projectSync.recentProjects')}
                  </div>
                  <div className="recent-project-list">
                    {availableRecentProjects.map((project) => (
                      <button
                        key={project}
                        type="button"
                        className="recent-project-row"
                        onClick={() => addProject(project)}
                        disabled={disabled}
                      >
                        <span className="mono">{project}</span>
                        <span>{t('projectSync.addRecent')}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

export default memo(ScopeSelector)
