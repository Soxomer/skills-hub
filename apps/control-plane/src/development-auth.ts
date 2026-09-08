import { isIP } from 'node:net'

export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer'
export type BrowserAccess = 'read' | 'write'

export function membershipAllows(role: MembershipRole | undefined, access: BrowserAccess): boolean {
  return role !== undefined && (access === 'read' || role !== 'viewer')
}

export function requireDevelopmentLoopback(host: string): void {
  if (host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))) return
  throw new Error('Development actor headers require a loopback bind (127.0.0.1 or ::1). Authenticated sessions are required before exposing the control plane.')
}
