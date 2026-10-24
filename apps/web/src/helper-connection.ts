// Enrollment commands come from the API. Parse their fixed vocabulary, never execute shell text.
export function helperConnectionLink(command: string): string | null {
  const match = /^ahm connect ([A-Za-z0-9_-]{16,256}) --server (\S+)$/.exec(command)
  if (!match) return null
  try {
    const server = new URL(match[2])
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)
    if ((server.protocol !== 'https:' && !(server.protocol === 'http:' && local)) || server.username || server.password || server.search || server.hash || server.pathname !== '/' || (server.port && !local)) return null
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
  // These fallback assets are published. Override them when releasing a new helper.
  const release = 'https://github.com/Soxomer/skills-hub/releases/download/v0.10.0/'
  const published: Record<HelperPlatform, string> = {
    windows: `${release}ahm-windows-x64-setup.exe`,
    macArm: `${release}ahm-macos-arm64.dmg`,
    macIntel: `${release}ahm-macos-x64.dmg`,
    linux: `${release}ahm-linux-x64.deb`,
  }
  const values: Record<HelperPlatform, unknown> = {
    windows: import.meta.env.VITE_HELPER_WINDOWS_URL ?? import.meta.env.VITE_RUNNER_INSTALLER_URL,
    macArm: import.meta.env.VITE_HELPER_MAC_ARM_URL,
    macIntel: import.meta.env.VITE_HELPER_MAC_INTEL_URL,
    linux: import.meta.env.VITE_HELPER_LINUX_URL,
  }
  const value = values[platform] ?? published[platform]
  if (typeof value !== 'string') return null
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
