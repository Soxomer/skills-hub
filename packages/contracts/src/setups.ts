import type {
  ArtifactId,
  DiscoveryKind,
  IsoTimestamp,
  SetupRevisionId,
} from './protocol.js'
import type { SetupRevisionSummary } from './switching.js'

/** Metadata only during preview. File bytes leave the runner only after publication consent. */
export interface LibrarySetupSnapshot {
  artifactId: string
  name: string
  contentDigest: string
  portableSource: string | null
  supportedTools: string[]
  files: { path: string; size: number }[]
}

export interface AddLibrarySkillRequest {
  snapshotJobId: string
  contentDigest: string
  destination: { name: string } | { setupId: string; expectedRevisionNumber: number }
  targets: { toolId: string; targetName: string }[]
}

export function isLibrarySetupSnapshot(value: unknown): value is LibrarySetupSnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as LibrarySetupSnapshot
  const key = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(s)
  return key(v.artifactId) && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 200
    && typeof v.contentDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(v.contentDigest)
    && (v.portableSource === null || (typeof v.portableSource === 'string' && /^https:\/\/github\.com\/[a-zA-Z0-9_./-]+$/.test(v.portableSource)))
    && Array.isArray(v.supportedTools) && v.supportedTools.length <= 100 && v.supportedTools.every(key)
    && Array.isArray(v.files) && v.files.length > 0 && v.files.length <= 5000 && v.files.every(f =>
      f && typeof f.path === 'string' && f.path.length <= 500 && f.path.length > 0
      && !/[\\:]/.test(f.path) && ![...f.path].some(c => c.charCodeAt(0) < 32) && !f.path.split('/').some(p => !p || ['.', '..', '.git'].includes(p))
      && Number.isSafeInteger(f.size) && f.size >= 0)
    && v.files.some(f => f.path === 'SKILL.md') && v.files.reduce((sum, f) => sum + f.size, 0) <= 10 * 1024 * 1024
}

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
