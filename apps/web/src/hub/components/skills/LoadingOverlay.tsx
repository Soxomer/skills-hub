import { memo } from 'react'
import type { TFunction } from 'i18next'

type LoadingOverlayProps = {
  loading: boolean
  scanning?: boolean
  actionMessage: string | null
  loadingStartAt: number | null
  onCancel?: () => void
  t: TFunction
}

const LoadingOverlay = ({
  loading,
  scanning = false,
  actionMessage,
  loadingStartAt,
  onCancel,
  t,
}: LoadingOverlayProps) => {
  if (!loading) return null

  return (
    <div className="modal-backdrop loading-backdrop">
      <div className="modal loading-modal" role="dialog" aria-modal="true">
        <div className="loading-content">
          <div className="loader-spinner" />
          <div className="loading-text">{t(scanning ? 'discoveryScan.scanning' : 'processingTitle')}</div>
          <div className="loading-stage">
            {scanning ? t('discoveryScan.scanningHelp') : actionMessage ?? t('processingTipShort')}
          </div>
          {loadingStartAt && !scanning ? (
            <div className="loading-subtext loading-subtext-delayed">
              {t('processingTipLong')}
            </div>
          ) : null}
          <div className="progress-bar">
            <div className="progress-fill" />
          </div>
          {onCancel ? (
            <button
              className="btn btn-secondary loading-cancel-btn"
              type="button"
              onClick={onCancel}
            >
              {t('cancel')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default memo(LoadingOverlay)
