import { isLibrarySetupSnapshot, type LibrarySetupSnapshot, type ArtifactBundle, type SetupComposerItem, type SetupDetail, type SetupLibrarySummary, type SetupRevisionSummary } from '@ahm/contracts'

import type {
  CreateSetupOutcome,
  CreateSetupRecord,
  PublishSetupRevisionRecord,
  PublishSetupRevisionOutcome,
  SetupRepository,
  AddLibrarySkillRecord,
  AddLibrarySkillOutcome,
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
  private readonly setups = new Map<string, SetupDetail>()
  private readonly snapshots = new Map<string, LibrarySetupSnapshot>()
  private readonly publications = new Map<string, { digest: string; revision: SetupRevisionSummary }>()

  seedLibrarySnapshot(organizationId: string, jobId: string, snapshot: LibrarySetupSnapshot): void {
    this.snapshots.set(`${organizationId}\0${jobId}`, structuredClone(snapshot))
  }

  async addLibrarySkill(record: AddLibrarySkillRecord): Promise<AddLibrarySkillOutcome> {
    const key = `${record.organizationId}\0${record.snapshotJobId}`
    const snapshot = this.snapshots.get(key)
    if (!isLibrarySetupSnapshot(snapshot) || snapshot.contentDigest !== record.contentDigest || record.targets.some(t => !snapshot.supportedTools.includes(t.toolId))) return { outcome: 'error', code: 'setupSnapshotUnavailable' }
    const prior = this.publications.get(key)
    if (prior) return prior.digest === record.requestDigest ? { outcome: 'created', revision: structuredClone(prior.revision) } : { outcome: 'error', code: 'setupPublicationConflict' }
    let detail: SetupDetail
    let number = 1
    if ('setupId' in record.destination) {
      const existing = this.setups.get(`${record.organizationId}\0${record.setupId}`)
      if (!existing) return { outcome: 'error', code: 'setupNotFound' }
      if (existing.revisions[0]!.revisionNumber !== record.destination.expectedRevisionNumber) return { outcome: 'error', code: 'setupRevisionConflict' }
      if (existing.revisions[0]!.items.some(i => record.targets.some(t => t.toolId === i.toolId && t.targetName === i.targetName))) return { outcome: 'error', code: 'setupTargetConflict' }
      if (existing.revisions[0]!.items.length + record.targets.length > 5000) return { outcome: 'error', code: 'invalidSetupItems' }
      detail = existing; number = record.destination.expectedRevisionNumber + 1
    } else {
      const name = record.destination.name
      const names = this.names.get(record.organizationId) ?? new Set<string>()
      if (names.has(name.toLowerCase())) return { outcome: 'error', code: 'setupNameTaken' }
      names.add(name.toLowerCase()); this.names.set(record.organizationId, names)
      detail = { setupId: record.setupId, name, kind: 'custom', defaultProjectId: null, initialSetupRevisionId: record.setupRevisionId, revisions: [], projects: [] }
    }
    const items = [...(detail.revisions[0]?.items ?? []), ...record.targets.map(t => ({ ...t, artifactId: snapshot.artifactId, contentDigest: snapshot.contentDigest, portableSource: snapshot.portableSource, artifactKind: 'skill' as const,
      sourceSetupRevisionId: record.setupRevisionId, sourceSetupName: detail.name, sourceRevisionNumber: number }))].map(i => ({ ...i, sourceSetupRevisionId: record.setupRevisionId, sourceSetupName: detail.name, sourceRevisionNumber: number }))
    const revision: SetupRevisionSummary = { setupId: detail.setupId, setupRevisionId: record.setupRevisionId, name: detail.name, kind: detail.kind, revisionNumber: number, itemCount: items.length, createdAt: record.createdAt }
    detail.revisions.unshift({ ...revision, items }); this.setups.set(`${record.organizationId}\0${detail.setupId}`, detail)
    this.items.set(record.organizationId, [...(this.items.get(record.organizationId) ?? []), ...items])
    this.publications.set(key, { digest: record.requestDigest, revision })
    return { outcome: 'created', revision: structuredClone(revision) }
  }

  async listSetups(organizationId: string): Promise<SetupLibrarySummary[]> {
    return [...this.setups.entries()].filter(([key]) => key.startsWith(`${organizationId}\u0000`)).map(([, detail]) => ({
      setupId: detail.setupId, name: detail.name, kind: detail.kind, defaultProjectId: detail.defaultProjectId,
      latestRevision: revisionSummary(detail.revisions[0]!), projectCount: detail.projects.length,
    }))
  }

  async setupDetail(organizationId: string, setupId: string): Promise<SetupDetail | null> {
    return structuredClone(this.setups.get(`${organizationId}\u0000${setupId}`) ?? null)
  }

  async revisionArtifact(): Promise<ArtifactBundle | null> {
    return null
  }

  async publishRevision(record: PublishSetupRevisionRecord): Promise<PublishSetupRevisionOutcome> {
    const detail = this.setups.get(`${record.organizationId}\u0000${record.setupId}`)
    if (!detail) return { outcome: 'setupMissing' }
    if (detail.revisions[0]?.revisionNumber !== record.expectedRevisionNumber) return { outcome: 'revisionConflict' }
    const available = new Map((this.items.get(record.organizationId) ?? []).map((item) => [itemKey(item), item]))
    const selected = record.items.map((item) => available.get(itemKey(item)))
    if (selected.some((item, index) => !item || item.contentDigest !== record.items[index]?.contentDigest)) return { outcome: 'itemUnavailable' }
    const revisionNumber = record.expectedRevisionNumber + 1
    const items = selected.map((item) => ({ ...item!, sourceSetupRevisionId: record.setupRevisionId, sourceSetupName: detail.name, sourceRevisionNumber: revisionNumber }))
    const revision: SetupRevisionSummary = { setupId: record.setupId, setupRevisionId: record.setupRevisionId,
      name: detail.name, kind: detail.kind, revisionNumber, itemCount: items.length, createdAt: record.createdAt }
    detail.revisions.unshift({ ...revision, items })
    this.items.set(record.organizationId, [...(this.items.get(record.organizationId) ?? []), ...items])
    return { outcome: 'created', revision }
  }

  seedComposerItems(organizationId: string, items: readonly SetupComposerItem[]): void {
    this.items.set(organizationId, structuredClone([...items]))
  }

  async listComposerItems(organizationId: string): Promise<SetupComposerItem[]> {
    return structuredClone(this.items.get(organizationId) ?? [])
  }

  async createSetup(record: CreateSetupRecord): Promise<CreateSetupOutcome> {
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
    this.setups.set(`${record.organizationId}\u0000${record.setupId}`, {
      setupId: record.setupId, name: record.name, kind: 'custom', defaultProjectId: null,
      initialSetupRevisionId: record.setupRevisionId, projects: [],
      revisions: [{ setupId: record.setupId, setupRevisionId: record.setupRevisionId, name: record.name, kind: 'custom',
        revisionNumber: 1, itemCount: createdItems.length, createdAt: record.createdAt, items: createdItems }],
    })
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

function revisionSummary(revision: SetupRevisionSummary): SetupRevisionSummary {
  return { setupId: revision.setupId, setupRevisionId: revision.setupRevisionId, name: revision.name, kind: revision.kind,
    revisionNumber: revision.revisionNumber, itemCount: revision.itemCount, createdAt: revision.createdAt }
}
