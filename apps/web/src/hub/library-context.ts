import { createContext, useContext } from 'react'
import type { LibrarySetupSnapshot } from '@ahm/contracts'
import type { ControlPlaneClient } from '../api'
interface LibraryContextValue {
  client: ControlPlaneClient
  deviceId: string | null
  previewSetupSkill: (skillId: string) => Promise<LibrarySetupSnapshot>
  snapshotSetupSkill: (skillId: string, contentDigest: string) => Promise<string>
  runnerConnected: boolean
  requestConnection?: () => Promise<boolean>
  invokeLibrary: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
  pickDirectory: (options: { title?: string; directory?: boolean; multiple?: boolean }) => Promise<string | null>
}
export const LibraryContext = createContext<LibraryContextValue | null>(null)
export function useLibrary(): LibraryContextValue {
  const context = useContext(LibraryContext)
  if (!context) throw new Error('LibraryProvider is missing')
  return context
}
