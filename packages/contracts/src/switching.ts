import type {
  CanonicalPlan,
  CancellationOutcome,
  OperationId,
  OperationOutcome,
  ProtocolErrorCode,
  Recoverability,
  SetupRevisionId,
} from './protocol.js'

export interface SetupRevisionSummary {
  setupId: string
  setupRevisionId: SetupRevisionId
  name: string
  kind: 'default' | 'custom'
  revisionNumber: number
  itemCount: number
  createdAt: string
}

export interface ProjectSetupStateResponse {
  projectId: string
  defaultSetupRevisionId: SetupRevisionId | null
  assignedSetupRevisionId: SetupRevisionId | null
  revisions: SetupRevisionSummary[]
}

export type ProjectMaterializationHealth = 'unknown' | 'current' | 'drifted' | 'attention'

export type ProjectOperationState =
  | 'pending'
  | 'leased'
  | 'acknowledged'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled'

export interface ProjectActiveOperation {
  jobId: string
  kind: 'planSetup' | 'applyPlan' | 'rollbackOperation'
  state: Extract<ProjectOperationState, 'pending' | 'leased' | 'acknowledged'>
  setupRevisionId: SetupRevisionId | null
  cancelRequested: boolean
  issuedAt: string
}

export interface ProjectOperationSummary {
  jobId: string
  kind: 'applyPlan' | 'rollbackOperation'
  state: ProjectOperationState
  setupRevisionId: SetupRevisionId | null
  operationId: OperationId | null
  outcome: OperationOutcome | CancellationOutcome | null
  recoverability: Recoverability | null
  errorCode: ProtocolErrorCode | null
  retryable: boolean | null
  issuedAt: string
  completedAt: string | null
}

export interface ProjectInstanceOperationsResponse {
  projectInstanceId: string
  assignedSetupRevisionId: SetupRevisionId | null
  materializedSetupRevisionId: SetupRevisionId | null
  health: ProjectMaterializationHealth
  activeOperation: ProjectActiveOperation | null
  reviewedPlan: ReviewedPlan | null
  operations: ProjectOperationSummary[]
}

export interface RequestSetupPlanRequest {
  setupRevisionId: SetupRevisionId
}

export interface QueuedRunnerJobResponse {
  jobId: string
}

export interface ApplyReviewedPlanRequest {
  planJobId: string
  planDigest: string
}

export interface ApplyReviewedPlanResponse extends QueuedRunnerJobResponse {
  approvalId: string
}

export interface RollbackOperationRequest {
  operationId: OperationId
}

export interface ReviewedPlan {
  jobId: string
  plan: CanonicalPlan
}
