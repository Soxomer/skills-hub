import type { SetupComposerItem } from '@ahm/contracts'

import type {
  CreateSetupOutcome,
  CreateSetupRecord,
  ReadSetupComposerOutcome,
  SetupRepository,
} from './setups.js'

function itemKey(item: {
  sourceSetupRevisionId: string
  artifactId: string
  toolId: string
  targetName: string
}): string {
  return [item.sourceSetupRevisionId, item.artifactId, item.toolId, item.targetName].join('\u0000')
}

export class InMemorySetupRepository implements SetupRepository {
  private readonly items = new Map<string, SetupComposerItem[]>()
  private readonly names = new Map<string, Set<string>>()
  private readonly memberships = new Map<
    string,
    'owner' | 'admin' | 'member' | 'viewer'
  >()

  seedMembership(
    organizationId: string,
    userId: string,
    role: 'owner' | 'admin' | 'member' | 'viewer',
  ): void {
    this.memberships.set(`${organizationId}:${userId}`, role)
  }

  seedComposerItems(organizationId: string, items: readonly SetupComposerItem[]): void {
    this.items.set(organizationId, structuredClone([...items]))
  }

  async membershipRole(
    organizationId: string,
    userId: string,
  ): Promise<'owner' | 'admin' | 'member' | 'viewer' | null> {
    return this.memberships.get(`${organizationId}:${userId}`) ?? null
  }

  async readComposer(
    organizationId: string,
    userId: string,
  ): Promise<ReadSetupComposerOutcome> {
    if (!this.memberships.has(`${organizationId}:${userId}`)) {
      return { outcome: 'accessDenied' }
    }
    return {
      outcome: 'available',
      items: structuredClone(this.items.get(organizationId) ?? []),
    }
  }

  async createSetup(record: CreateSetupRecord): Promise<CreateSetupOutcome> {
    const role = this.memberships.get(`${record.organizationId}:${record.createdBy}`)
    if (!role) return { outcome: 'accessDenied' }
    if (role === 'viewer') return { outcome: 'mutationForbidden' }
    const names = this.names.get(record.organizationId) ?? new Set<string>()
    const normalizedName = record.name.toLocaleLowerCase('en')
    if (names.has(normalizedName)) return { outcome: 'nameTaken' }

    const available = new Map(
      (this.items.get(record.organizationId) ?? []).map((item) => [itemKey(item), item]),
    )
    const selected = record.items.map((item) => available.get(itemKey(item)))
    if (
      selected.some(
        (item, index) => !item || item.contentDigest !== record.items[index]?.contentDigest,
      )
    ) {
      return { outcome: 'itemUnavailable' }
    }

    names.add(normalizedName)
    this.names.set(record.organizationId, names)
    const createdItems = selected.map((item) => ({
      ...item!,
      sourceSetupRevisionId: record.setupRevisionId,
      sourceSetupName: record.name,
      sourceRevisionNumber: 1,
    }))
    this.items.set(record.organizationId, [
      ...(this.items.get(record.organizationId) ?? []),
      ...createdItems,
    ])
    return {
      outcome: 'created',
      revision: {
        setupId: record.setupId,
        setupRevisionId: record.setupRevisionId,
        name: record.name,
        kind: 'custom',
        revisionNumber: 1,
        itemCount: selected.length,
        createdAt: record.createdAt,
      },
    }
  }
}
