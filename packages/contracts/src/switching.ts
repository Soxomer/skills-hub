import type {
  CanonicalPlan,
  OperationId,
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
