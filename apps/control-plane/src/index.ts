import { PROTOCOL_VERSION } from '@ahm/contracts'

export * from './persistence.js'
export * from './http.js'
export * from './projects.js'
export * from './projects-memory.js'
export * from './projects-pg.js'
export * from './runner-transport.js'
export * from './runner-transport-memory.js'
export * from './runner-transport-pg.js'

export interface ControlPlaneBoundary {
  protocolVersion: typeof PROTOCOL_VERSION
  transport: 'https-polling'
}

export function describeControlPlaneBoundary(): ControlPlaneBoundary {
  return {
    protocolVersion: PROTOCOL_VERSION,
    transport: 'https-polling',
  }
}
