import { memo } from 'react'
import {
  ChevronLeft,
  Compass,
  Download,
  Layers3,
  LogOut,
  LoaderCircle,
  RefreshCw,
  Settings,
  Tag,
  Wrench,
} from 'lucide-react'
import type { TFunction } from 'i18next'

type ManagementTab = 'tags' | 'tools' | 'updates'

type HeaderProps = {
  onOpenWorkspace: () => void
  onSignOut?: () => void
  activeView: 'myskills' | 'explore' | 'detail' | 'settings' | 'manage'
  managementTab: ManagementTab
  skillCount: number
  tagCount: number
  toolCount: number
  updateCount: number
  appVersion: string
  updateAvailableVersion: string | null
  updateChecking: boolean
  updateInstalling: boolean
  updateDone: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  onOpenSettings: () => void
  onOpenUpdate: () => void
  onRestart: () => void
  onViewChange: (view: 'myskills' | 'explore' | 'manage') => void
  onManagementTabChange: (tab: ManagementTab) => void
  t: TFunction
}

const Header = ({
  onOpenWorkspace,
  onSignOut,
  activeView,
  managementTab,
  skillCount,
  tagCount,
  toolCount,
  updateCount,
  appVersion,
  updateAvailableVersion,
  updateChecking,
  updateInstalling,
  updateDone,
  collapsed,
  onToggleCollapsed,
  onOpenSettings,
  onOpenUpdate,
  onRestart,
  onViewChange,
  onManagementTabChange,
  t,
}: HeaderProps) => (
  <>
    <div
      className="window-titlebar"

    >
      <div className="traffic-lights" aria-hidden="true">
        <span className="traffic-light red" />
        <span className="traffic-light yellow" />
        <span className="traffic-light green" />
      </div>
      <strong>{t('appName')}</strong>
      {appVersion ? (
        <div className="titlebar-version-status">
          <span>v{appVersion}</span>
          {updateChecking ? (
            <LoaderCircle
              className="titlebar-update-spinner"
              size={13}
              aria-label={t('titlebarUpdate.checking')}
            />
          ) : updateAvailableVersion ? (
            <button
              className={`titlebar-update-action${updateInstalling ? ' installing' : ''}${updateDone ? ' done' : ''}`}
              type="button"
              disabled={updateInstalling}
              onClick={updateDone ? onRestart : onOpenUpdate}
              aria-label={t(
                updateDone ? 'titlebarUpdate.restart' : 'titlebarUpdate.available',
                { version: updateAvailableVersion },
              )}
              title={t(
                updateDone ? 'titlebarUpdate.restart' : 'titlebarUpdate.available',
                { version: updateAvailableVersion },
              )}
            >
              <span className="titlebar-update-icon" aria-hidden="true">
                {updateInstalling ? (
                  <LoaderCircle className="titlebar-update-spinner" size={15} />
                ) : updateDone ? (
                  <RefreshCw size={15} />
                ) : (
                  <Download size={15} />
                )}
              </span>
              <span className="titlebar-update-label">
                {t(
                  updateInstalling
                    ? 'titlebarUpdate.installing'
                    : updateDone
                      ? 'titlebarUpdate.restartAction'
                      : 'titlebarUpdate.action',
                )}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
    <aside className={`skills-sidebar${collapsed ? ' collapsed' : ''}`}>
      <div
        className="sidebar-brand"

        >
        <div className="sidebar-logo" aria-hidden="true">
          <span className="sidebar-logo-mark" />
        </div>
        <div className="sidebar-brand-copy">
          <strong>{t('appName')}</strong>
          <span>{t('workspaceSubtitle')}</span>
        </div>
        <button
          className="sidebar-collapse"
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          <ChevronLeft size={collapsed ? 13 : 16} />
        </button>
      </div>

      <div className="sidebar-section-label">{t('workspace')}</div>
      <nav className="sidebar-nav" aria-label={t('workspace')}>

        <button
          className={activeView === 'myskills' || activeView === 'detail' ? 'active' : ''}
          type="button"
          onClick={() => onViewChange('myskills')}
          title={collapsed ? t('navMySkills') : undefined}
        >
          <Layers3 size={18} />
          <span>{t('navMySkills')}</span>
          <em>{skillCount}</em>
        </button>
        <button
          className={activeView === 'explore' ? 'active' : ''}
          type="button"
          onClick={() => onViewChange('explore')}
          title={collapsed ? t('addSkills') : undefined}
        >
          <Compass size={18} />
          <span>{t('addSkills')}</span>
        </button>
        <button type="button" onClick={onOpenWorkspace} title={t('runnerWorkspace')} aria-label={t('runnerWorkspace')}><Layers3 size={18} /><span>{t('runnerWorkspace')}</span></button>
        {onSignOut && <button type="button" onClick={onSignOut} title={t('auth.signOut', { ns: 'translation' })} aria-label={t('auth.signOut', { ns: 'translation' })}><LogOut size={18} /><span>{t('auth.signOut', { ns: 'translation' })}</span></button>}
      </nav>

      <div className="sidebar-section-label">{t('navManageCenter')}</div>
      <nav className="sidebar-nav" aria-label={t('navManageCenter')}>
        <button
          className={activeView === 'manage' && managementTab === 'tags' ? 'active' : ''}
          type="button"
          onClick={() => onManagementTabChange('tags')}
          title={collapsed ? t('manageTabs.tags') : undefined}
        >
          <Tag size={18} />
          <span>{t('manageTabs.tags')}</span>
          <em>{tagCount}</em>
        </button>
        <button
          className={activeView === 'manage' && managementTab === 'tools' ? 'active' : ''}
          type="button"
          onClick={() => onManagementTabChange('tools')}
          title={collapsed ? t('manageTabs.tools') : undefined}
        >
          <Wrench size={18} />
          <span>{t('manageTabs.tools')}</span>
          <em>{toolCount}</em>
        </button>
        <button
          className={activeView === 'manage' && managementTab === 'updates' ? 'active' : ''}
          type="button"
          onClick={() => onManagementTabChange('updates')}
          title={collapsed ? t('manageTabs.updates') : undefined}
        >
          <RefreshCw size={18} />
          <span>{t('manageTabs.updates')}</span>
          <em>{updateCount}</em>
        </button>
      </nav>

      <div className="sidebar-spacer" />
      <button
        className={`sidebar-settings${activeView === 'settings' ? ' active' : ''}`}
        type="button"
        onClick={onOpenSettings}
        title={collapsed ? t('settings') : undefined}
      >
        <Settings size={18} />
        <span>{t('settings')}</span>
      </button>
    </aside>
  </>
)

export default memo(Header)
