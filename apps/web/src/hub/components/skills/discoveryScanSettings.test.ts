import { describe, expect, it } from 'vitest'
import {
  buildDiscoverySourceEnabledMap,
  collectDisabledDiscoverySourceKeys,
} from './discoveryScanSettings'
import type { DiscoveryScanSettingsDto } from './types'

const settings: DiscoveryScanSettingsDto = {
  sources: [
    { key: 'cursor', label: 'Cursor', path: '/home/me/.cursor/skills', enabled: true },
    { key: 'codex', label: 'Codex', path: '/home/me/.codex/skills', enabled: false },
  ],
  disabled_source_keys: ['codex', 'hidden-source'],
}

describe('discovery scan settings', () => {
  it('builds the editable enabled state from backend sources', () => {
    expect(buildDiscoverySourceEnabledMap(settings)).toEqual({
      cursor: true,
      codex: false,
    })
  })

  it('preserves disabled sources that are not currently visible', () => {
    expect(
      collectDisabledDiscoverySourceKeys(settings, {
        cursor: false,
        codex: true,
      }),
    ).toEqual(['hidden-source', 'cursor'])
  })
})
