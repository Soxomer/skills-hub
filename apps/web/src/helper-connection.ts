// Enrollment commands come from the API. Parse their fixed vocabulary, never execute shell text.
export function helperConnectionLink(command: string): string | null {
  const match = /^ahm connect ([A-Za-z0-9_-]{16,256}) --server (\S+)$/.exec(command)
  if (!match) return null
  try {
    const server = new URL(match[2])
    if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash || server.pathname !== '/' || server.port) return null
    return `ahm://connect?${new URLSearchParams({ code: match[1], server: server.origin })}`
  } catch { return null }
}

// Set only once the installer release asset is published; never advertise a nonexistent download.
export const helperInstallerUrl: string | null = (() => {
  const value: unknown = import.meta.env.VITE_RUNNER_INSTALLER_URL
  if (typeof value !== 'string' || !value) return null
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null } catch { return null }
})()
