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

export type HelperPlatform = 'windows' | 'macArm' | 'macIntel' | 'linux'
export function suggestedHelperPlatform(agent: string): HelperPlatform {
  if (/Mac/i.test(agent)) return 'macArm'
  if (/Linux/i.test(agent) && !/Android/i.test(agent)) return 'linux'
  return 'windows'
}
export function installerFor(platform: HelperPlatform): string | null {
  // Configure only after the corresponding release asset is published.
  const values: Record<HelperPlatform, unknown> = {
    windows: import.meta.env.VITE_HELPER_WINDOWS_URL ?? import.meta.env.VITE_RUNNER_INSTALLER_URL,
    macArm: import.meta.env.VITE_HELPER_MAC_ARM_URL,
    macIntel: import.meta.env.VITE_HELPER_MAC_INTEL_URL,
    linux: import.meta.env.VITE_HELPER_LINUX_URL,
  }
  const value = values[platform]
  if (typeof value !== 'string') return null
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
