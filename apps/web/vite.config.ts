import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss(), { name: "web-version", generateBundle() { this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: process.env.GITHUB_SHA ?? "0.9.1", builtAt: new Date().toISOString() }) }) } }],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
