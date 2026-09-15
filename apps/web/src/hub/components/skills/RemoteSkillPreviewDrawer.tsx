import { lazy, Suspense, memo, useEffect, useRef, type MouseEvent } from 'react'
import { Download, ExternalLink, Eye, RefreshCw, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
const FileContentRenderer = lazy(() => import('./SkillDetailView').then(module => ({ default: module.FileContentRenderer })))
import type {
  ExploreSkillPreviewTarget,
  GitSkillPreviewDto,
} from './types'

type RemoteSkillPreviewDrawerProps = {
  open: boolean
  target: ExploreSkillPreviewTarget | null
  preview: GitSkillPreviewDto | null
  loading: boolean
  error: string | null
  onClose: () => void
  onRetry: () => void
  onInstall: () => void
  t: TFunction
}

const RemoteSkillPreviewDrawer = ({
  open,
  target,
  preview,
  loading,
  error,
  onClose,
  onRetry,
  onInstall,
  t,
}: RemoteSkillPreviewDrawerProps) => {
  const drawerRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [onClose, open])

  if (!open || !target) return null

  const sourceLabel = target.source_url
    .replace('https://github.com/', '')
    .replace(/\.git$/, '')
  const description = preview?.description?.trim() || target.summary.trim()
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  const handleOpenSource = async () => {
    try {
      window.open(target.source_url, '_blank', 'noopener,noreferrer')
    } catch {
      toast.error(t('skillPreview.sourceOpenFailed'))
    }
  }
  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose()
  }

  return (
    <div className="skill-preview-backdrop" onMouseDown={handleBackdropMouseDown}>
      <aside
        ref={drawerRef}
        className="skill-preview-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-preview-title"
        aria-busy={loading}
      >
        <header className="skill-preview-header">
          <div className="skill-preview-heading">
            <span className="skill-preview-eyebrow">
              <Eye size={14} />
              {t('skillPreview.title')}
            </span>
            <h2 id="skill-preview-title">{preview?.name ?? target.name}</h2>
            <button
              className="skill-preview-source"
              type="button"
              onClick={() => void handleOpenSource()}
              aria-label={t('skillPreview.sourceOpenAria', { source: sourceLabel })}
              title={t('skillPreview.sourceOpenAria', { source: sourceLabel })}
            >
              <span>{sourceLabel}</span>
              <ExternalLink size={12} aria-hidden="true" />
            </button>
          </div>
          <button
            ref={closeButtonRef}
            className="skill-preview-close"
            type="button"
            onClick={onClose}
            aria-label={t('skillPreview.close')}
            title={t('skillPreview.close')}
          >
            <X size={18} />
          </button>
        </header>

        {description ? <p className="skill-preview-description">{description}</p> : null}

        <div className="skill-preview-content">
          {loading ? (
            <div className="skill-preview-state">
              <div className="detail-spinner" />
              <strong>{t('skillPreview.loading')}</strong>
              <span>{t('skillPreview.loadingHelp')}</span>
            </div>
          ) : error ? (
            <div className="skill-preview-state error" role="alert">
              <strong>{t('skillPreview.errorTitle')}</strong>
              <span>{error}</span>
              <button className="btn btn-secondary" type="button" onClick={onRetry}>
                <RefreshCw size={14} />
                {t('skillPreview.retry')}
              </button>
            </div>
          ) : preview ? (
            <div className="skill-preview-markdown">
              <div className="skill-preview-file-label">SKILL.md</div>
              <Suspense fallback={<p role="status">{t('loading')}</p>}><FileContentRenderer
                filename="SKILL.md"
                content={preview.content}
                isDark={isDark}
              /></Suspense>
            </div>
          ) : null}
        </div>

        <footer className="skill-preview-footer">
          <span>{t('skillPreview.readOnly')}</span>
          {target.installed ? (
            <span className="explore-btn-installed">{t('status.installed')}</span>
          ) : (
            <button className="btn btn-primary" type="button" onClick={onInstall}>
              <Download size={15} />
              {t('install')}
            </button>
          )}
        </footer>
      </aside>
    </div>
  )
}

export default memo(RemoteSkillPreviewDrawer)
