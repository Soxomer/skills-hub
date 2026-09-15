interface WebVersion { version: string; builtAt: string }
export interface WebUpdate { version: string; body: string | null; activate: () => Promise<void> }
let initialVersion: WebVersion | null = null
async function deployedVersion(): Promise<WebVersion> {
  if (import.meta.env.DEV) return { version: '0.9.1', builtAt: 'development' }
  const response = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' })
  if (!response.ok) throw new Error('Could not check the deployed web version')
  return await response.json() as WebVersion
}
export async function getWebVersion(): Promise<string> {
  initialVersion ??= await deployedVersion()
  return initialVersion.version
}
export async function checkForWebUpdate(): Promise<WebUpdate | null> {
  await getWebVersion()
  const current = await deployedVersion()
  if (current.builtAt === initialVersion?.builtAt) return null
  return { version: current.version, body: null, activate: async () => { window.location.reload() } }
}
