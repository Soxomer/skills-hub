import { memo } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { ToolOption } from '../types'

type BulkSyncModalProps = {
  open: boolean
  loading: boolean
  selectedCount: number
  installedTools: ToolOption[]
  selectedToolIds: string[]
  onToggleTool: (toolId: string) => void
  onRequestClose: () => void
  onConfirm: () => void
  t: TFunction
}

const BulkSyncModal = ({
  open,
  loading,
  selectedCount,
  installedTools,
  selectedToolIds,
  onToggleTool,
  onRequestClose,
  onConfirm,
  t,
}: BulkSyncModalProps) => {
  if (!open) return null

  const selectedToolSet = new Set(selectedToolIds)

  return (
    <div className="modal-backdrop" onClick={onRequestClose}>
      <div
        className="modal bulk-sync-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">{t('bulk.syncTitle')}</div>
            <div className="bulk-modal-subtitle">
              {t('bulk.syncSubtitle', { count: selectedCount })}
            </div>
          </div>
        </div>
        <div className="modal-body">
          <div className="bulk-tool-grid">
            {installedTools.length === 0 ? (
              <div className="empty">{t('bulk.noInstalledTools')}</div>
            ) : (
              installedTools.map((tool) => {
                const selected = selectedToolSet.has(tool.id)
                return (
                  <button
                    key={tool.id}
                    className={`bulk-tool-option${selected ? ' selected' : ''}`}
                    type="button"
                    onClick={() => onToggleTool(tool.id)}
                    disabled={loading}
                  >
                    <span className="bulk-tool-check">
                      {selected ? <Check size={14} /> : null}
                    </span>
                    <span>
                      <strong>{tool.label}</strong>
                      <small>
                        {selected ? t('bulk.toolSelectedHint') : t('bulk.toolUnselectedHint')}
                      </small>
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onRequestClose} disabled={loading}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={loading || installedTools.length === 0}
          >
            <RefreshCw size={14} />
            {t('bulk.syncConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default memo(BulkSyncModal)
