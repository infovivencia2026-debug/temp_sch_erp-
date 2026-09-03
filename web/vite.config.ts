import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readFileSync } from 'node:fs'

/* Emits the service worker with this build's real asset list baked in.
 *
 * Written as a plugin rather than a checked-in file with a hand-maintained
 * list because the list is hashed filenames that change every build. A
 * hand-maintained one would be wrong by the first deploy, and wrong here means
 * `addAll` rejects on a 404 and the whole install fails — so the worker would
 * silently never take control and the app would appear to have no offline
 * support at all, with nothing on fire to explain why.
 *
 * The cache names carry the build id, so a deploy retires the previous
 * build's caches wholesale in `activate` rather than trying to reconcile
 * them. */
function serviceWorker(): Plugin {
  const build = Date.now().toString(36)
  return {
    name: 'erp-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      /* THE SHELL, NOT THE WHOLE BUILD.
       *
       * `addAll` is atomic and eager: everything named here is downloaded
       * before the worker installs. The full build is 5.1MB of JavaScript,
       * most of it feature chunks a given person will never open and 1.1MB of
       * it a map engine that two screens use — so precaching all of it would
       * spend a phone's data on a school connection to make screens available
       * offline that nobody was going to visit.
       *
       * So this is the shell: the stylesheet, the entry, and the vendor
       * chunks every screen needs to boot. That is what has to be present for
       * a cold start with no signal to paint a real application. Everything
       * else is cached the first time it is actually used, by the cache-first
       * branch in the worker — a screen you have opened before is available
       * offline, a screen you never opened is not, which is the honest
       * bargain and roughly what a person would predict.
       *
       * Fonts are left out for the same reason and one more: a missing font
       * falls back to the system stack and the page still reads, so paying
       * 528KB up front to avoid that is a bad trade on a bad line. */
      const shell = /^assets\/(index|react|router|query|vendor|icons)-[^/]*\.js$/
      const assets = Object.keys(bundle)
        .filter((f) => f.endsWith('.css') || shell.test(f))
        .map((f) => '/' + f)
      const src = readFileSync(path.resolve(__dirname, 'src/sw-src.js'), 'utf8')
        .replace(/__BUILD__/g, build)
        .replace(
          '__PRECACHE__',
          JSON.stringify(['/index.html', '/app/manifest.webmanifest', ...assets]),
        )
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src })
    },
  }
}


export default defineConfig({
  plugins: [react(), serviceWorker()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    // Mirrors the nginx locations, so `npm run dev` hits the same URLs the
    // production bundle does and no code needs a base-URL switch.
    proxy: {
      '/api': { target: 'https://temperp.187-127-178-100.sslip.io', changeOrigin: true, secure: false },
      '/login': { target: 'https://temperp.187-127-178-100.sslip.io', changeOrigin: true, secure: false },
      '/logout': { target: 'https://temperp.187-127-178-100.sslip.io', changeOrigin: true, secure: false },
      '/healthz': { target: 'https://temperp.187-127-178-100.sslip.io', changeOrigin: true, secure: false },
    },
  },
  build: {
    // Chunked along the same seams as the deployed bundle: the vendor libs
    // change rarely and stay cached across deploys, while feature code does
    // not drag them back over the wire.
    rollupOptions: {
      output: {
        // Matched on resolved module path rather than the bare package name.
        // The name-keyed form emits an empty `react` chunk here, because
        // react/jsx-runtime and react-dom get pulled in transitively by
        // react-router-dom and land in that chunk instead.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (id.includes('react-router')) return 'router'
          if (id.includes('@tanstack')) return 'query'
          if (id.includes('recharts') || id.includes('d3-')) return 'charts'
          /* The map engine is ~800kB and two screens use it. In the shared
             vendor chunk every parent checking fees and every teacher marking
             attendance downloads a renderer they will never open, so it gets
             its own chunk and is imported lazily by the map component. */
          if (id.includes('maplibre-gl')) return 'maplibre'
          if (id.includes('lucide-react')) return 'icons'
          return 'vendor'
        },
      },
    },
  },
})
