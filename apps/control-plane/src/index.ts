import { PROTOCOL_VERSION } from '@ahm/contracts'

export interface ControlPlaneBoundary {
  protocolVersion: typeof PROTOCOL_VERSION
  transport: 'not-configured'
}

export function describeControlPlaneBoundary(): ControlPlaneBoundary {
  return {
    protocolVersion: PROTOCOL_VERSION,
    transport: 'not-configured',
  }
}
