import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const productVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version

function localHelperInstaller(): Plugin {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? process.arch === 'arm64' ? 'macArm' : 'macIntel' : 'linux'
  const [folder, extension] = process.platform === 'win32' ? ['nsis', '.exe'] : process.platform === 'darwin' ? ['dmg', '.dmg'] : ['deb', '.deb']
  const directory = fileURLToPath(new URL(`../../target/debug/bundle/${folder}/`, import.meta.url))
  const installer = () => existsSync(directory) ? readdirSync(directory).find(name => name.includes(`_${productVersion}_`) && name.endsWith(extension)) : undefined
  return {
    name: 'local-helper-installer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0]
        if (pathname !== '/__ahm/helper-installers' && pathname !== `/__ahm/helper-installers/${platform}`) return next()
        response.setHeader('cache-control', 'no-store')
        if (request.method !== 'GET') { response.statusCode = 405; response.end(); return }
        const file = installer()
        if (pathname === '/__ahm/helper-installers') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(file ? { [platform]: `/__ahm/helper-installers/${platform}` } : {}))
          return
        }
        if (!file) { response.statusCode = 404; response.end('Build the desktop helper for this workspace first.'); return }
        const path = join(directory, file)
        response.setHeader('content-type', 'application/octet-stream')
        response.setHeader('content-disposition', `attachment; filename="${file}"`)
        response.setHeader('content-length', statSync(path).size)
        const stream = createReadStream(path)
        stream.on('error', () => response.destroy())
        stream.pipe(response)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const apiPort = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'AHM_').AHM_DEV_API_PORT ?? '8787'
  if (!/^\d+$/.test(apiPort) || Number(apiPort) < 1 || Number(apiPort) > 65535) throw new Error('AHM_DEV_API_PORT must be a valid local TCP port')
  return {
    plugins: [react(), tailwindcss(), localHelperInstaller(), { name: "web-version", generateBundle() { this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: productVersion, revision: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null, builtAt: new Date().toISOString() }) }) } }],
    server: {
      host: '127.0.0.1',
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
    },
  }
})
