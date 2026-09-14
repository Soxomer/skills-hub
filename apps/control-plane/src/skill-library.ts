import type { ManagedSkillSummary } from '@ahm/contracts'

/** Closed shape prevents accidental publication of local paths and source secrets. */
export function isSkillLibrary(value: unknown): value is ManagedSkillSummary[] {
  const text = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 512
  const shape = (item: unknown, keys: string[]): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).length === keys.length && Object.keys(item).every(key => keys.includes(key))
  const ids = new Set<string>()
  return !(!Array.isArray(value) || value.length > 5000 || Buffer.byteLength(JSON.stringify(value)) > 512_000 ||
    !value.every(item => {
      if (!shape(item, ['id', 'name', 'sourceType', 'enabled', 'tags', 'targets']) ||
        !text(item.id) || !text(item.name) || !['git', 'local', 'other'].includes(String(item.sourceType)) ||
        typeof item.enabled !== 'boolean' || !Array.isArray(item.tags) || !item.tags.every(text) ||
        !Array.isArray(item.targets) || !item.targets.every(target =>
          shape(target, ['tool', 'scope']) && text(target.tool) && ['global', 'project'].includes(String(target.scope)))) return false
      if (ids.has(item.id as string)) return false
      ids.add(item.id as string)
      return true
    }))
}
