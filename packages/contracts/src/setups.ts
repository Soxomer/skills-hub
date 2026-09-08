import type {
  ArtifactId,
  DiscoveryKind,
  IsoTimestamp,
  SetupRevisionId,
} from './protocol.js'
import type { SetupRevisionSummary } from './switching.js'

export interface SetupLibrarySummary {
  setupId: string
  name: string
  kind: 'default' | 'custom'
  defaultProjectId: string | null
  latestRevision: SetupRevisionSummary
  projectCount: number
}

export interface SetupLibraryResponse {
  setups: SetupLibrarySummary[]
}

export interface SetupRevisionDetail extends SetupRevisionSummary {
  items: SetupComposerItem[]
}

export interface SetupProjectUsage {
  projectId: string
  name: string
  setupRevisionId: SetupRevisionId
}

export interface SetupDetail {
  setupId: string
  name: string
  kind: 'default' | 'custom'
  defaultProjectId: string | null
  initialSetupRevisionId: SetupRevisionId
  revisions: SetupRevisionDetail[]
  projects: SetupProjectUsage[]
}

export interface PublishSetupRevisionRequest {
  expectedRevisionNumber: number
  items: SetupItemSelection[]
}

export interface SetupComposerItem {
  sourceSetupRevisionId: SetupRevisionId
  sourceSetupName: string
  sourceRevisionNumber: number
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
