import { randomUUID } from 'node:crypto'

import type {
  CreateSetupRequest,
  CreatedSetupRevision,
  SetupComposerItem,
  SetupComposerResponse,
  SetupItemSelection,
} from '@ahm/contracts'

import type { RequestActor } from './runner-transport.js'

export interface CreateSetupRecord {
  organizationId: string
  createdBy: string
  createdAt: string
  setupId: string
  setupRevisionId: string
  auditEventId: string
  name: string
  items: readonly SetupItemSelection[]
}

export type CreateSetupOutcome =
  | { outcome: 'created'; revision: CreatedSetupRevision }
  | { outcome: 'nameTaken' }
  | { outcome: 'itemUnavailable' }

export interface SetupRepository {
  listComposerItems(organizationId: string): Promise<SetupComposerItem[]>
  createSetup(record: CreateSetupRecord): Promise<CreateSetupOutcome>
}

export type SetupServiceErrorCode =
  | 'invalidSetupName'
  | 'invalidSetupItems'
  | 'setupNameTaken'
  | 'setupItemUnavailable'

export class SetupServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: SetupServiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SetupServiceError'
  }
}

export interface SetupServiceOptions {
  now?: () => Date
  randomId?: () => string
}

function requiredIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}

function normalizedSelection(value: SetupItemSelection): SetupItemSelection {
  return {
    sourceSetupRevisionId: value.sourceSetupRevisionId.trim(),
    artifactId: value.artifactId.trim(),
    contentDigest: value.contentDigest.trim(),
    toolId: value.toolId.trim(),
    targetName: value.targetName.trim(),
  }
}

function selectionKey(item: SetupItemSelection): string {
  return [
    item.sourceSetupRevisionId,
    item.artifactId,
    item.toolId,
    item.targetName,
  ].join('\u0000')
}

function destinationKey(item: SetupItemSelection): string {
  return `${item.toolId}\u0000${item.targetName}`
}

function composerIdentity(item: SetupComposerItem): string {
  return [
    item.artifactKind,
    item.artifactId,
    item.contentDigest,
    item.portableSource ?? '',
    item.toolId,
    item.targetName,
  ].join('\u0000')
}

export class SetupService {
  private readonly now: () => Date
  private readonly randomId: () => string

  constructor(
    private readonly repository: SetupRepository,
    options: SetupServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
  }

  async composer(actor: RequestActor): Promise<SetupComposerResponse> {
    const available = await this.repository.listComposerItems(actor.organizationId)
    const items = new Map<string, SetupComposerItem>()
    for (const item of available) {
      const key = composerIdentity(item)
      if (!items.has(key)) items.set(key, item)
    }
    return { items: [...items.values()] }
  }

  async createSetup(
    actor: RequestActor,
    request: CreateSetupRequest,
  ): Promise<CreatedSetupRevision> {
    if (typeof request?.name !== 'string') {
      throw new SetupServiceError(400, 'invalidSetupName', 'Setup name is required')
    }
    const name = request.name.trim()
    if (name.length < 1 || name.length > 120) {
      throw new SetupServiceError(
        400,
        'invalidSetupName',
        'Setup name must contain between 1 and 120 characters',
      )
    }
    if (
      !Array.isArray(request.items) ||
      request.items.length < 1 ||
      request.items.length > 5_000 ||
      request.items.some(
        (item) =>
          !item ||
          !requiredIdentifier(item.sourceSetupRevisionId) ||
          !requiredIdentifier(item.artifactId) ||
          !requiredIdentifier(item.contentDigest) ||
          !requiredIdentifier(item.toolId) ||
          !requiredIdentifier(item.targetName),
      )
    ) {
      throw new SetupServiceError(
        400,
        'invalidSetupItems',
        'Select between 1 and 5,000 complete Setup items',
      )
    }
    const items = request.items.map(normalizedSelection)
    if (
      new Set(items.map(selectionKey)).size !== items.length ||
      new Set(items.map(destinationKey)).size !== items.length
    ) {
      throw new SetupServiceError(
        400,
        'invalidSetupItems',
        'Setup items and target destinations must be unique',
      )
    }

    const suffix = this.randomId()
    const outcome = await this.repository.createSetup({
      organizationId: actor.organizationId,
      createdBy: actor.userId,
      createdAt: this.now().toISOString(),
      setupId: `setup_${suffix}`,
      setupRevisionId: `revision_${suffix}`,
      auditEventId: `audit_${suffix}`,
      name,
      items,
    })
    if (outcome.outcome === 'nameTaken') {
      throw new SetupServiceError(409, 'setupNameTaken', 'A Setup with this name already exists')
    }
    if (outcome.outcome === 'itemUnavailable') {
      throw new SetupServiceError(
        409,
        'setupItemUnavailable',
        'A selected item is stale or no longer available; reload the composer',
      )
    }
    return outcome.revision
  }
}
