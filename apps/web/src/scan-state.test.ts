import type { RunnerJobStatusResponse, ScanDiscovery } from '@ahm/contracts'
import { describe, expect, it } from 'vitest'

import {
  eligibleDiscoveryIds,
  groupDiscoveriesByTool,
  reconcileIncludedDiscoveryIds,
  scanDiscoveries,
} from './scan-state'

const discoveries: ScanDiscovery[] = [
  {
    discoveryId: 'available-zed',
    kind: 'skill',
    state: 'available',
    name: 'Zed',
    toolId: 'codex',
    portableSource: 'github:example/zed@v1',
    contentDigest: 'sha256:zed',
  },
  {
    discoveryId: 'conflict-alpha',
    kind: 'skill',
    state: 'conflict',
    name: 'Alpha',
    toolId: 'codex',
    portableSource: null,
    contentDigest: 'sha256:alpha',
  },
  {
    discoveryId: 'available-beta',
    kind: 'localContent',
    state: 'available',
    name: 'Beta',
    toolId: 'claude-code',
    portableSource: null,
    contentDigest: 'sha256:beta',
  },
]

describe('scan review state', () => {
  it('groups discoveries by tool and sorts groups and names', () => {
    expect(groupDiscoveriesByTool(discoveries)).toEqual([
      { toolId: 'claude-code', discoveries: [discoveries[2]] },
      { toolId: 'codex', discoveries: [discoveries[1], discoveries[0]] },
    ])
  })

  it('keeps only explicitly eligible discovery selections', () => {
    expect(eligibleDiscoveryIds(discoveries)).toEqual(['available-zed', 'available-beta'])
    expect(
      reconcileIncludedDiscoveryIds(discoveries, [
        'conflict-alpha',
        'missing',
        'available-beta',
      ]),
    ).toEqual(['available-beta'])
  })

  it('exposes discoveries only from a successful scan result', () => {
    const status: RunnerJobStatusResponse = {
      jobId: 'scan_01',
      state: 'succeeded',
      cancelRequested: false,
      result: {
        protocolVersion: '1.0',
        jobId: 'scan_01',
        idempotencyKey: 'scan-scan_01',
        organizationId: 'org_01',
        deviceId: 'device_01',
        projectInstanceId: 'instance_01',
        result: { kind: 'scanResult', payload: { projectId: 'project_01', discoveries } },
      },
    }
    expect(scanDiscoveries(status)).toEqual(discoveries)
    expect(scanDiscoveries({ ...status, state: 'failed' })).toBeNull()
  })
})
