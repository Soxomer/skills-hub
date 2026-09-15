import { LIBRARY_COMMANDS, type LibraryCommand } from '@ahm/contracts'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ControlPlaneClient } from '../api'
import { LibraryContext } from './library-context'

interface Directory { name: string; handle: string }
interface DirectoryListing extends Directory { parent: string | null; children: Directory[]; roots: Directory[] }
export function LibraryProvider({ client, deviceId, connected, children }: {
  client: ControlPlaneClient; deviceId: string | null; connected: boolean; children: ReactNode
}) {
  const { t } = useTranslation('hub')
  const jobs = useRef(new Set<string>())
  const cancellation = useRef(0)
  const trackingSources = useRef(new Map<string, string>())
  const [picker, setPicker] = useState<{ title: string; finish: (path: string | null) => void } | null>(null)
  const [directory, setDirectory] = useState<DirectoryListing | null>(null)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const request = useCallback(async (command: LibraryCommand, args: Record<string, unknown>, expectedDigest: string | null): Promise<unknown> => {
    if (['get_featured_skills','search_skills_online','preview_git_skill_cmd'].includes(command)) {
      const value = await client.catalogue({ command, args, expectedDigest: null })
      if (command === 'preview_git_skill_cmd' && value && typeof value === 'object' && 'source_url' in value && typeof value.source_url === 'string' && typeof args.repoUrl === 'string') trackingSources.current.set(value.source_url, args.repoUrl)
      return value
    }
    if (!deviceId || !connected) throw new Error(t('errors.runnerRequired'))
    const { jobId } = await client.library(deviceId, { command, args, expectedDigest })
    jobs.current.add(jobId)
    try {
      const deadline = Date.now() + 10 * 60_000
      while (mounted.current && Date.now() < deadline) {
        const job = await client.job(jobId)
        if (job.result) {
          if (job.result.result.kind === 'error') throw new Error(job.result.result.payload.message)
          if (job.result.result.kind === 'libraryResponse') return job.result.result.payload.value
          throw new Error(t('libraryTransport.invalidResult'))
        }
        if (['cancelled','expired','failed'].includes(job.state)) throw new Error(t('libraryTransport.incomplete'))
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      throw new Error(t('libraryTransport.timeout'))
    } finally { jobs.current.delete(jobId) }
  }, [client, connected, deviceId, t])

  const invokeLibrary = useCallback(async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (command === 'cancel_current_operation') {
      cancellation.current += 1
      await Promise.all([...jobs.current].map(id => client.cancelJob(id)))
      return undefined as T
    }
    if (!LIBRARY_COMMANDS.includes(command as LibraryCommand)) throw new Error(t('libraryTransport.invalidCommand'))
    if (command === 'install_git_selection' && typeof args.repoUrl === 'string') {
      const trackingUrl = trackingSources.current.get(args.repoUrl)
      if (trackingUrl) args = { ...args, trackingUrl }
    }
    const generation = cancellation.current
    const result = await request(command as LibraryCommand, args, null)
    if (generation !== cancellation.current) throw new Error('CANCELLED|')
    if (result && typeof result === 'object' && 'requiresCommit' in result && 'digest' in result && typeof result.digest === 'string') {
      return await request(command as LibraryCommand, args, result.digest) as T
    }
    return result as T
  }, [client, request, t])

  const browse = useCallback(async (parent: string | null) => {
    setDirectoryLoading(true); setDirectoryError(null)
    try { setDirectory(await request('list_directories', { parent }, null) as DirectoryListing) }
    catch (error) { setDirectoryError(error instanceof Error ? error.message : String(error)) }
    finally { setDirectoryLoading(false) }
  }, [request])
  const pickDirectory = useCallback(async (options: { title?: string }): Promise<string | null> => {
    setDirectory(null); void browse(null)
    return new Promise(finish => setPicker({ title: options.title ?? t('libraryTransport.chooseFolder'), finish }))
  }, [browse, t])
  const close = useCallback(() => {
    picker?.finish(null); setPicker(null)
  }, [picker])
  useEffect(() => {
    if (picker) dialog.current?.showModal()
    else dialog.current?.close()
  }, [picker])
  const context = useMemo(() => ({ runnerConnected: connected, invokeLibrary, pickDirectory }), [connected, invokeLibrary, pickDirectory])
  return <LibraryContext.Provider value={context}>
    {children}
    <dialog ref={dialog} className="library-dialog" aria-labelledby="library-dialog-title" onCancel={event => { event.preventDefault(); close() }}>
      <h2 id="library-dialog-title">{picker?.title}</h2>
      <>
        <p>{t('libraryTransport.onRunner')}</p>
        {directoryError && <p role="alert">{directoryError}</p>}
        {directory && <nav className="library-dialog-actions" aria-label={t('libraryTransport.locations')}>
          {directory.roots.map(root => <button type="button" key={root.handle} onClick={() => void browse(root.handle)}>{root.name}</button>)}
        </nav>}
        <div className="library-directory-list" aria-busy={directoryLoading}>
          {directoryLoading ? <p>{t('loading')}</p> : directory && <>
            <strong>{directory.name}</strong>
            {directory.parent && <button type="button" onClick={() => void browse(directory.parent)}>{t('libraryTransport.parentFolder')}</button>}
            {directory.children.map(child => <button key={child.handle} type="button" onClick={() => void browse(child.handle)}>{child.name}</button>)}
          </>}
        </div>
        <div className="library-dialog-actions">
          <button type="button" onClick={close}>{t('cancel')}</button>
          <button type="button" className="primary" disabled={!directory || directoryLoading} onClick={() => { picker?.finish(directory?.handle ?? null); setPicker(null) }}>{t('libraryTransport.useFolder')}</button>
        </div>
      </>
    </dialog>
  </LibraryContext.Provider>
}
