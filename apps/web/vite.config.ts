import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

const productVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version

export default defineConfig({
  plugins: [react(), tailwindcss(), { name: "web-version", generateBundle() { this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: productVersion, revision: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null, builtAt: new Date().toISOString() }) }) } }],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
