import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig, type Plugin } from 'vite'
import ssrPlugin from 'vite-ssr-components/plugin'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const rootDir = import.meta.dirname ?? process.cwd()

/**
 * Generates the service worker's precache list from vite's manifest at build
 * time. The service worker must cache the REAL hashed bundle files (e.g.
 * assets/canvas-C9aAP8h2.js), NOT dev-only /src/... source paths. This plugin
 * renders service-worker.template.js with the correct cache name + asset list
 * and writes dist/client/sw.js, so the build keeps the precache correct.
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'excalidraw-cf-service-worker',
    apply: 'build',
    closeBundle() {
      const clientDir = resolve(rootDir, 'dist/client')
      const manifestPath = resolve(clientDir, '.vite/manifest.json')
      if (!existsSync(manifestPath)) {
        // The SSR build runs after the client build and shares this hook; only
        // generate once the client manifest exists.
        return
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<
        string,
        { file?: string; src?: string }
      >

      // Collect the real built assets Vite emitted (JS/CSS entries), plus the
      // offline precache shell. Always include the document '/'.
      const assets = new Set<string>(['/'])
      for (const entry of Object.values(manifest)) {
        if (entry?.file && /\.(js|css)$/.test(entry.file)) {
          assets.add('/' + entry.file)
        }
      }

      const template = readFileSync(resolve(rootDir, 'service-worker.template.js'), 'utf-8')
      const cacheName = `excalidraw-cf-${Date.now()}`
      const precacheList = JSON.stringify(Array.from(assets))
      const source = template
        .replaceAll('__CACHE_NAME__', cacheName)
        .replaceAll('__PRECACHE__', precacheList)

      mkdirSync(clientDir, { recursive: true })
      writeFileSync(resolve(clientDir, 'sw.js'), source)
    },
  }
}

export default defineConfig({
  plugins: [serviceWorkerPlugin(), cloudflare(), ssrPlugin()],
})
