import type {
  ArtifactId,
  DiscoveryKind,
  IsoTimestamp,
  SetupRevisionId,
} from './protocol.js'

export interface SetupComposerItem {
  sourceSetupRevisionId: SetupRevisionId
  sourceSetupName: string
  artifactId: ArtifactId
  artifactKind: DiscoveryKind
  portableSource: string | null
  contentDigest: string
  toolId: string
  targetName: string
}

export interface SetupComposerResponse {
  items: SetupComposerItem[]
}

export interface SetupItemSelection {
  sourceSetupRevisionId: SetupRevisionId
  artifactId: ArtifactId
  contentDigest: string
  toolId: string
  targetName: string
}

export interface CreateSetupRequest {
  name: string
  items: SetupItemSelection[]
}

export interface CreatedSetupRevision {
  setupId: string
  setupRevisionId: SetupRevisionId
  name: string
  kind: 'custom'
  revisionNumber: 1
  itemCount: number
  createdAt: IsoTimestamp
}
