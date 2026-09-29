import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
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
 * The SHELL cache name carries the build id, so a deploy retires the previous
 * build's shell wholesale in `activate` rather than trying to reconcile it.
 * The DATA cache deliberately does not: cached API answers outlive a deploy
 * (see sw-src.js), so updating the app no longer empties a phone's offline
 * copy of the school. */
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
      /* The shell is computed, not named: the entry chunk and everything it
       * imports statically (walked through the bundle graph), plus the
       * stylesheets and the modern polyfills. Naming chunks by pattern broke
       * the moment chunking followed the screens instead of a hand-made
       * vendor split — a shared chunk the entry needs would have been left
       * out, and a cold offline start would have failed on it. */
      const chunks = Object.values(bundle).filter((c) => c.type === 'chunk')
      const entry = chunks.find((c) => c.type === 'chunk' && c.isEntry && /^assets\/index-/.test(c.fileName))
      const seen = new Set<string>()
      const walk = (f: string) => {
        if (seen.has(f)) return
        seen.add(f)
        const c = bundle[f]
        if (c && c.type === 'chunk') c.imports.forEach(walk)
      }
      if (entry) walk(entry.fileName)
      const assets = Object.keys(bundle)
        .filter((f) => f.endsWith('.css') || seen.has(f) || /^assets\/polyfills-/.test(f))
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


/* THE POLYFILL CHUNK, LOADED ONLY WHERE IT IS MISSING.
 *
 * plugin-legacy's modern polyfills are a plain <script type=module> before the
 * entry, so every browser — including the Chrome 150 every school actually
 * runs — downloaded and parsed 134KB (50KB gzipped) to be told it already had
 * all of it. This rewrites the two tags into one tiny loader: the entry is
 * preloaded as before, a feature test runs, and only an engine that fails it
 * imports the polyfills first. The test names the newest things the chunk
 * provides (Set methods, iterator helpers, toSorted, structuredClone), so any
 * engine that passes is newer than everything the chunk would add. */
function conditionalPolyfills(): Plugin {
  return {
    name: 'erp-conditional-polyfills',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = bundle['index.html']
      if (!html || html.type !== 'asset') return
      let src = String(html.source)
      const poly = src.match(/<script type="module" crossorigin src="(\/assets\/polyfills-[^"]+\.js)"><\/script>\s*/)
      const entry = src.match(/<script type="module" crossorigin src="(\/assets\/index-[^"]+\.js)"><\/script>/)
      if (!poly || !entry) return
      const test =
        "[].at&&[].flat&&[].findLast&&[].toSorted&&Object.fromEntries&&Object.hasOwn&&''.replaceAll" +
        "&&Promise.allSettled&&self.structuredClone&&Set.prototype.union&&typeof Iterator=='function'&&Iterator.prototype.map"
      const loader =
        `<link rel="modulepreload" crossorigin href="${entry[1]}">\n` +
        `    <script type="module">(${test}?Promise.resolve():import(${JSON.stringify(poly[1])}))` +
        `.then(function(){return import(${JSON.stringify(entry[1])})})</script>`
      src = src.replace(poly[0], '').replace(entry[0], loader)
      html.source = src
    },
  }
}

export default defineConfig({
  /* THE OLD BROWSER THAT COULD NOT SAVE.
   *
   * A user on an outdated engine hit an error pressing Save, which is the
   * signature of modern JavaScript the engine cannot parse (a class field, an
   * optional chain, top-level await in a chunk) rather than of any one handler.
   * The fix is to stop shipping that syntax to engines that predate it, in two
   * layers:
   *
   *   build.target sets the floor for the MODERN bundle, so the transpiler
   *   lowers anything newer than these engines even for browsers that get the
   *   module build. es2019 is the meaningful baseline; the named browser
   *   versions pin it to concrete engines.
   *
   *   plugin-legacy emits a SECOND, nomodule bundle for engines with no ES
   *   module support at all, transpiled to ES5-ish and shipped with the
   *   core-js polyfills its code needs. An old browser ignores the module
   *   build (it does not understand `type=module`) and runs this one, so the
   *   features degrade instead of throwing. */
  plugins: [
    react(),
    /* THE MIDDLE BAND, WHICH IS WHERE THE CHEAP TABLETS LIVE.
     *
     * plugin-legacy's second bundle is a `nomodule` fallback: a browser gets it
     * ONLY if it does not understand `<script type=module>` at all. That misses
     * exactly the engines these schools run — a Senses or Caltech Android tablet
     * on WebView 65-84, or Samsung Internet — which DO support modules, so they
     * load the modern bundle, and then choke on a method that bundle assumes:
     * Object.fromEntries, Array.flat/flatMap, String.replaceAll, Array.at,
     * Promise.allSettled. That is the "error when I press Save" on the old
     * tablet: not a bad handler, a missing built-in the module build never
     * polyfilled.
     *
     *   modernPolyfills injects the core-js shims those methods need INTO the
     *   modern bundle, so a module-capable-but-old engine has them too.
     *
     *   targets is widened down to old Android/iOS/Samsung so the nomodule
     *   bundle (for the truly ancient, module-less engines — old Windows, an
     *   Android 4 WebView) is transpiled and polyfilled far enough to run there.
     *
     * build.target below drops the syntax floor to match, so neither bundle
     * ships syntax one of these engines cannot parse. */
    /* NO SECOND BUNDLE ANY MORE — ONLY THE POLYFILLS, AND ONLY FOR THOSE WHO NEED THEM.
     *
     * The nomodule bundle served browsers without ES modules. The login
     * records of every school on the Worker (login_events.user_agent, read
     * 2026-09-29) hold none: the oldest engine is Chrome 124, then iOS 18
     * Safari, Android 10 Chrome 152+. The apps are WebView shells on Android
     * minSdk 24 (WebView updates through Play) and iOS 16. So the legacy
     * bundle was half the build and never downloaded; it is gone
     * (renderLegacyChunks: false).
     *
     * The middle band above is still real — a module-capable but old WebView
     * that lacks Object.fromEntries or Array.at — so modernPolyfills stays.
     * What changes is who pays for it: see conditionalPolyfills() below, which
     * loads the 50KB chunk only on an engine that fails a feature test. */
    legacy({
      targets: [
        'chrome >= 61', 'firefox >= 60', 'safari >= 11', 'edge >= 18',
        'android >= 5', 'ios >= 11', 'samsung >= 8',
      ],
      modernPolyfills: true,
      renderLegacyChunks: false,
    }),
    conditionalPolyfills(),
    serviceWorker(),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, 'src'), '@shared': path.resolve(__dirname, '../shared') } },
  server: {
    port: 5173,
    // shared/api (the API contract) lives beside web/, outside Vite's root.
    fs: { allow: [path.resolve(__dirname), path.resolve(__dirname, '../shared')] },
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
    // A broad baseline for the MODERN bundle: the transpiler lowers anything
    // newer than these engines, so a module-capable engine — including the
    // WebView 61+ on a low-end Android tablet — still never meets syntax it
    // cannot parse (optional chaining, nullish, class fields all get lowered).
    // es2017 is the floor because that is what a WebView in the low 60s can
    // parse; modernPolyfills (above) covers the METHODS that floor still leaves
    // missing, and plugin-legacy covers the module-less engines below even this.
    target: ['es2017', 'chrome61', 'edge18', 'firefox60', 'safari11'],
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
          if (id.includes('react-router') || id.includes('@remix-run')) return 'router'
          if (id.includes('@tanstack')) return 'query'
          /* The map engine is ~800kB and two screens use it. */
          if (id.includes('maplibre-gl')) return 'maplibre'
          /* EVERYTHING ELSE GOES WHERE IT IS USED.
           *
           * There used to be a catch-all `vendor` chunk here, and an `icons`
           * and a `charts` one. The entry imported all three, so every
           * student opening the timetable downloaded DOMPurify (the card
           * viewer), qrcode (bus stickers), pmtiles and the protomaps styles
           * (the bus map), and recharts' helpers (two finance dashboards):
           * 110KB gzipped of other people's screens. Returning nothing lets
           * Rollup put a library beside the screens that import it, and a
           * library two lazy screens share into a chunk both of them load. */
          return undefined
        },
      },
    },
  },
})
