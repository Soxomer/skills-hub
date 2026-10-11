import { useCallback, useEffect, useRef, useState } from 'react'

interface SkillInstallIntent { sourceUrl: string; skillName?: string }
const KEY = 'ahm.pending-skill-install'
function read(): SkillInstallIntent | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
    if (!value || typeof value !== 'object' || !('sourceUrl' in value) || typeof value.sourceUrl !== 'string') return null
    const url = new URL(value.sourceUrl)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return { sourceUrl: value.sourceUrl, skillName: 'skillName' in value && typeof value.skillName === 'string' ? value.skillName : undefined }
  } catch { return null }
}
function save(intent: SkillInstallIntent | null) {
  try { if (intent) sessionStorage.setItem(KEY, JSON.stringify(intent)); else sessionStorage.removeItem(KEY) } catch { /* Still retained in this page when browser storage is disabled. */ }
}

export function useSkillInstallIntent(connected: boolean, requestConnection: (() => Promise<boolean>) | undefined, onInstall: (url: string, name?: string) => void, ready: boolean) {
  const [pending, setPending] = useState(read)
  const [preparing, setPreparing] = useState(false)
  const latestInstall = useRef(onInstall)
  const generation = useRef(0)
  const available = useRef(connected && ready)
  const waiting = useRef<(() => void) | null>(null)
  useEffect(() => {
    latestInstall.current = onInstall
    available.current = connected && ready
    if (available.current) waiting.current?.()
  }, [connected, onInstall, ready])
  useEffect(() => () => { generation.current += 1; waiting.current?.() }, [])
  const install = useCallback(async (sourceUrl: string, skillName?: string) => {
    const intent = { sourceUrl, skillName }
    const current = ++generation.current
    waiting.current?.(); waiting.current = null
    setPreparing(false); setPending(intent); save(intent)
    if (!connected && !await requestConnection?.()) return
    if (generation.current !== current) return
    setPreparing(true)
    if (!available.current) await new Promise<void>(resolve => { waiting.current = resolve })
    if (generation.current !== current || !available.current) return
    waiting.current = null
    setPending(null); save(null); setPreparing(false)
    // Resume only from the render containing the detected tools and their sync targets.
    latestInstall.current(sourceUrl, skillName)
  }, [connected, requestConnection])
  const dismiss = useCallback(() => { generation.current += 1; waiting.current?.(); waiting.current = null; setPreparing(false); setPending(null); save(null) }, [])
  return { pending, install, dismiss, preparing }
}
