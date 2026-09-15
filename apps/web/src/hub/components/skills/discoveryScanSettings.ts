import type { DiscoveryScanSettingsDto } from './types'

export const buildDiscoverySourceEnabledMap = (
  settings: DiscoveryScanSettingsDto | null,
): Record<string, boolean> =>
  Object.fromEntries(settings?.sources.map((source) => [source.key, source.enabled]) ?? [])

export const collectDisabledDiscoverySourceKeys = (
  settings: DiscoveryScanSettingsDto,
  enabledByKey: Record<string, boolean>,
): string[] => {
  const visibleKeys = new Set(settings.sources.map((source) => source.key))
  const hiddenDisabledKeys = settings.disabled_source_keys.filter(
    (key) => !visibleKeys.has(key),
  )
  return hiddenDisabledKeys.concat(
    settings.sources
      .filter((source) => !enabledByKey[source.key])
      .map((source) => source.key),
  )
}
