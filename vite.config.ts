import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig, type Plugin } from 'vite'
import ssrPlugin from 'vite-ssr-components/plugin'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const rootDir = import.meta.dirname ?? process.cwd()

/**
 * Generates the service worker's precache list so it is always correct for the
 * current mode:
 *   - dev  : precaches the vite dev URLs (`/`, `/src/style.css`, `/src/client/canvas.ts`),
 *            which ARE the real URLs served by the dev server.
 *   - build: precaches the REAL hashed bundle files (e.g. assets/canvas-C9aAP8h2.js)
 *            read from dist/client/.vite/manifest.json.
 * Produces the SW at public/sw.js (dev) or dist/client/sw.js (build); neither is
 * committed — both are generated so the service worker can never drift from the
 * assets the renderer actually ships.
 */
function serviceWorkerPlugin(): Plugin {
  function renderTemplate(assets: Set<string>): string {
    const cacheName = `excalidraw-cf-${Date.now()}`
    const precacheList = JSON.stringify(Array.from(assets))
    const template = readFileSync(resolve(rootDir, 'service-worker.template.js'), 'utf-8')
    return template.replaceAll('__CACHE_NAME__', cacheName).replaceAll('__PRECACHE__', precacheList)
  }

  return {
    name: 'excalidraw-cf-service-worker',
    configureServer(server) {
      // Dev: write a generated sw.js into public/ so /sw.js is served while
      // developing. The dev asset paths are the real ones Vite serves.
      // '/shell' is the offline canvas document (server route in
      // routes/drawing.tsx) — kept in lockstep with the build list below.
      const devAssets = new Set<string>(['/', '/shell', '/src/style.css', '/src/client/canvas.ts'])
      writeFileSync(resolve(rootDir, 'public/sw.js'), renderTemplate(devAssets))
      server.watcher.on('change', (file) => {
        if (String(file).endsWith('service-worker.template.js')) {
          writeFileSync(resolve(rootDir, 'public/sw.js'), renderTemplate(devAssets))
        }
      })
    },
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
      // offline precache documents: the landing shell '/' and the canvas
      // shell '/shell' (served by the SW's route-aware navigation fallback
      // for /d/:roomId, /new and /join when offline). MUST stay in lockstep
      // with the dev list above.
      const assets = new Set<string>(['/', '/shell'])
      for (const entry of Object.values(manifest)) {
        if (entry?.file && /\.(js|css)$/.test(entry.file)) {
          assets.add('/' + entry.file)
        }
      }

      mkdirSync(clientDir, { recursive: true })
      writeFileSync(resolve(clientDir, 'sw.js'), renderTemplate(assets))
    },
  }
}

export default defineConfig({
  plugins: [serviceWorkerPlugin(), cloudflare(), ssrPlugin()],
})
