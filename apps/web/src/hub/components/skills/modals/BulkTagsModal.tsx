import { memo, useMemo, useState } from 'react'
import { Check, Search, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { ManagedSkill, TagWithCountDto } from '../types'

type BulkTagsModalProps = {
  open: boolean
  loading: boolean
  selectedSkills: ManagedSkill[]
  tags: TagWithCountDto[]
  onRequestClose: () => void
  onConfirm: (addTagIds: number[], removeTagIds: number[]) => void
  t: TFunction
}

const BulkTagsModal = ({
  open,
  ...props
}: BulkTagsModalProps) => {
  if (!open) return null
  return <BulkTagsModalContent {...props} />
}

const BulkTagsModalContent = ({
  loading,
  selectedSkills,
  tags,
  onRequestClose,
  onConfirm,
  t,
}: Omit<BulkTagsModalProps, 'open'>) => {
  const [query, setQuery] = useState('')
  const [addTagIds, setAddTagIds] = useState<number[]>([])
  const [removeTagIds, setRemoveTagIds] = useState<number[]>([])

  const usedTagIds = useMemo(() => {
    const out = new Set<number>()
    for (const skill of selectedSkills) {
      for (const tag of skill.tags) out.add(tag.id)
    }
    return out
  }, [selectedSkills])

  const addSet = useMemo(() => new Set(addTagIds), [addTagIds])
  const removeSet = useMemo(() => new Set(removeTagIds), [removeTagIds])
  const normalizedQuery = query.trim().toLowerCase()
  const addTags = useMemo(() => {
    if (!normalizedQuery) return tags
    return tags.filter((tag) => tag.name.toLowerCase().includes(normalizedQuery))
  }, [normalizedQuery, tags])
  const removeTags = useMemo(
    () => tags.filter((tag) => usedTagIds.has(tag.id)),
    [tags, usedTagIds],
  )

  const toggleAdd = (tagId: number) => {
    setAddTagIds((current) =>
      current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId],
    )
    setRemoveTagIds((current) => current.filter((id) => id !== tagId))
  }

  const toggleRemove = (tagId: number) => {
    setRemoveTagIds((current) =>
      current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId],
    )
    setAddTagIds((current) => current.filter((id) => id !== tagId))
  }

  return (
    <div className="modal-backdrop" onClick={loading ? undefined : onRequestClose}>
      <div
        className="modal bulk-tags-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">{t('bulk.tagsTitle')}</div>
            <div className="bulk-modal-subtitle">
              {t('bulk.tagsSubtitle', { count: selectedSkills.length })}
            </div>
          </div>
          <button className="modal-close" type="button" onClick={onRequestClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body bulk-tags-body">
          <div className="tag-filter-search bulk-tags-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchTags')}
            />
          </div>

          <div className="bulk-tags-panels">
            <section>
              <div className="bulk-tags-section-title">{t('bulk.addTags')}</div>
              <div className="bulk-tags-list">
                {addTags.length === 0 ? (
                  <div className="empty">{t('tagsEmpty')}</div>
                ) : (
                  addTags.map((tag) => {
                    const selected = addSet.has(tag.id)
                    return (
                      <button
                        key={tag.id}
                        className={`tag-filter-option${selected ? ' selected' : ''}`}
                        type="button"
                        onClick={() => toggleAdd(tag.id)}
                        disabled={loading}
                      >
                        <span className="tag-check">
                          {selected ? <Check size={14} /> : null}
                        </span>
                        <span>{tag.name}</span>
                        <span className="tag-count">{tag.skill_count}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </section>

            <section>
              <div className="bulk-tags-section-title">{t('bulk.removeTags')}</div>
              <div className="bulk-tags-list">
                {removeTags.length === 0 ? (
                  <div className="empty">{t('bulk.noRemovableTags')}</div>
                ) : (
                  removeTags.map((tag) => {
                    const selected = removeSet.has(tag.id)
                    return (
                      <button
                        key={tag.id}
                        className={`tag-filter-option danger${selected ? ' selected' : ''}`}
                        type="button"
                        onClick={() => toggleRemove(tag.id)}
                        disabled={loading}
                      >
                        <span className="tag-check">
                          {selected ? <Check size={14} /> : null}
                        </span>
                        <span>{tag.name}</span>
                        <span className="tag-count">{tag.skill_count}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </section>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" type="button" onClick={onRequestClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={loading || (addTagIds.length === 0 && removeTagIds.length === 0)}
            onClick={() => onConfirm(addTagIds, removeTagIds)}
          >
            {t('bulk.tagsConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default memo(BulkTagsModal)
