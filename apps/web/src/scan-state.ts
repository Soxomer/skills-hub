import type { RunnerJobStatusResponse, ScanDiscovery } from '@ahm/contracts'

export interface DiscoveryGroup {
  toolId: string
  discoveries: ScanDiscovery[]
}

export function scanDiscoveries(status: RunnerJobStatusResponse | null): ScanDiscovery[] | null {
  if (
    status?.state !== 'succeeded' ||
    !status.result ||
    status.result.result.kind !== 'scanResult'
  ) {
    return null
  }
  return status.result.result.payload.discoveries
}

export function eligibleDiscoveryIds(discoveries: readonly ScanDiscovery[]): string[] {
  return discoveries
    .filter((discovery) => discovery.state === 'available')
    .map((discovery) => discovery.discoveryId)
}

export function reconcileIncludedDiscoveryIds(
  discoveries: readonly ScanDiscovery[],
  includedDiscoveryIds: readonly string[],
): string[] {
  const eligible = new Set(eligibleDiscoveryIds(discoveries))
  return includedDiscoveryIds.filter((discoveryId) => eligible.has(discoveryId))
}

export function groupDiscoveriesByTool(
  discoveries: readonly ScanDiscovery[],
): DiscoveryGroup[] {
  const groups = new Map<string, ScanDiscovery[]>()
  for (const discovery of discoveries) {
    const group = groups.get(discovery.toolId) ?? []
    group.push(discovery)
    groups.set(discovery.toolId, group)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([toolId, items]) => ({
      toolId,
      discoveries: items.sort((left, right) => left.name.localeCompare(right.name)),
    }))
}

export function isTerminalJob(status: RunnerJobStatusResponse | null): boolean {
  return Boolean(
    status &&
      !(['pending', 'leased', 'acknowledged'] as RunnerJobStatusResponse['state'][]).includes(
        status.state,
      ),
  )
}
