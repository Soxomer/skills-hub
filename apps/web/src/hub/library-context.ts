import { createContext, useContext } from 'react'
interface LibraryContextValue {
  runnerConnected: boolean
  invokeLibrary: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
  pickDirectory: (options: { title?: string; directory?: boolean; multiple?: boolean }) => Promise<string | null>
}
export const LibraryContext = createContext<LibraryContextValue | null>(null)
export function useLibrary(): LibraryContextValue {
  const context = useContext(LibraryContext)
  if (!context) throw new Error('LibraryProvider is missing')
  return context
}
