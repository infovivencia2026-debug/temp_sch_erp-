/* THE APPLICATION, WHEN THERE IS NO NETWORK.

   The offline outbox keeps a write that could not be sent. This is the other
   half of the same problem, and the register queue named it exactly: "a
   teacher who navigates away, reloads, or opens the app cold with no
   connection gets nothing to type into". The queue survived a reload because
   it was on disk; the page that reads it did not, because the page came from
   the network.

   So the shell is kept on the device. Opening the app in a basement now paints
   the same product it always paints, with the last data it saw, and anything
   typed into it goes to the outbox.

   THREE STRATEGIES, BECAUSE THREE KINDS OF THING ARE BEING ASKED FOR.

   The build's own files are content-hashed, so a given URL's bytes can never
   change. Cache first, and never revalidate: going to the network for a file
   that is by construction identical is pure latency.

   A navigation is a request for the application, not for a document. The
   server answers every route with the same index.html, so an offline
   navigation is answered from the cached copy of it and the router takes over
   — which is what makes a cold start with no signal land on a real screen
   rather than the browser's dinosaur.

   An API read is NOT cached here any more. The saved screens live in the
   app's own encrypted store (lib/local-store.ts), which is per person, per
   school, capped and wiped on sign-out; a second plaintext copy of the same
   answers in this worker's cache would be the leak that store exists to
   prevent. Writes are never touched: they belong to the outbox.

   The shell cache is named for the build, because its contents are the
   build: a new deploy retires the old shell wholesale. The old data cache
   (erp-data-v1) from earlier builds is deleted on activate. */

const SHELL = 'erp-shell-__BUILD__'
const DATA = 'erp-data-v1' // retired; deleted on activate
const PRECACHE = __PRECACHE__

/* Shown only when a navigation fails before the app was ever saved on this
   device. Plain words, the system font, both themes; no script. */
const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>No connection</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText;padding:16px;box-sizing:border-box}
p{max-width:28em;text-align:center}a{color:inherit}</style></head><body><p>
No connection. Open the app once while connected and it will work offline after that.
<br><a href="">Try again</a></p></body></html>`

/* How long the wire gets before the cached copy is shown instead. Long
   enough for a slow-but-working connection to answer a real read; short
   enough that a dead one does not hold a fee balance hostage. */
const NAV_TIMEOUT_MS = 8000 // was 4000: a slow link fell back to the cached shell, an old build, on every load

self.addEventListener('install', (e) => {
  /* Not skipWaiting. A tab that is open and mid-task is running the previous
     build's JavaScript, and swapping the worker under it means the next chunk
     it lazily imports is fetched under a controller that has already dropped
     that build's assets from the cache. The new worker takes over when every
     tab of the old one has gone. */
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // Old shells go, and the retired API cache with them.
      const keep = new Set([SHELL])
      for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k)
      /* Navigation preload: the browser starts the navigation request the
         moment the tab asks, in parallel with waking this worker, rather than
         after. Worth ~100-300ms on every cold open. */
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable() } catch { /* not supported */ }
      }
      await self.clients.claim()
    })(),
  )
})

/* Sign-out, and switching account on a shared laptop.

   Cached API answers are one person's data. The staffroom laptop signs in and
   out all day, and leaving the previous teacher's cached register available to
   the next one is a data leak that would look exactly like a feature. The app
   posts this the moment the session's user changes to a different person. */
self.addEventListener('message', (e) => {
  if (e.data?.type === 'erp-forget-data') e.waitUntil(caches.delete(DATA))
  /* Take over now, because the page asked.
   *
   * `install` deliberately does not call this: a tab mid-task is running the
   * previous build's JavaScript, and swapping under it means the next chunk it
   * lazily imports is fetched under a controller that has already dropped that
   * build's assets. The page is the only thing that knows when there is
   * nothing to lose, and it asks at that moment — see main.tsx. */
  if (e.data?.type === 'erp-take-over') self.skipWaiting()
  /* The page names the screens this person's menu can open, and the worker
     fetches their chunks into the shell cache while the phone is idle and
     online — so the first offline tap on "Fees" is not a white screen.
     Bounded to what the menu offers, not the whole build. */
  if (e.data?.type === 'erp-warm-shell' && Array.isArray(e.data.urls)) {
    e.waitUntil(warmShell(e.data.urls))
  }
})

/* THE NETWORK CAME BACK WHILE THE APP WAS IN THE BACKGROUND.

   lib/outbox.ts asks for a Background Sync when it queues a write. The
   browser wakes this worker when there is a connection; the queue itself is
   the page's (it is per person and in the page's storage), so the worker
   tells every open page to send it. */
self.addEventListener('sync', (e) => {
  if (e.tag !== 'erp-outbox') return
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) c.postMessage({ type: 'erp-outbox-flush' })
    }),
  )
})

/* A TAP ON THE BANNER OPENS THE CONVERSATION.

   The page shows a message's notification through this worker, because on a
   phone that is the only way one is shown (lib/live-stream.ts). The link is
   in `data.href`. If a tab of the app is open it is focused and told to
   navigate — the same in-page navigation the in-app card does, no reload; if
   none is, one is opened on the link. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const href = typeof e.notification.data?.href === 'string' ? e.notification.data.href : '/'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      const tab = list.find((c) => 'focus' in c) ?? null
      if (tab) {
        try { await tab.focus() } catch { /* the OS may refuse; the message still goes */ }
        tab.postMessage({ type: 'erp-open', href })
        return
      }
      if (self.clients.openWindow) await self.clients.openWindow(href)
    }),
  )
})

async function warmShell(urls) {
  const c = await caches.open(SHELL)
  for (const u of urls.slice(0, 120)) {
    try {
      if (await c.match(u)) continue
      const res = await fetch(u, { cache: 'no-cache' })
      if (res.ok) await c.put(u, res)
    } catch { /* offline mid-warm: stop quietly, the next idle warm continues */ return }
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then((v) => { clearTimeout(t); resolve(v) }, (err) => { clearTimeout(t); reject(err) })
  })
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  /* SIGNING OUT IS A NAVIGATION, AND IT IS THE ONLY CLEANUP MOMENT THERE IS.

     The SPA never gets one: /logout is a full navigation to the Go binary, so
     no React code runs on the way out. That is why the session cache would
     otherwise be a leak on a shared front-desk machine — sign out, lose the
     network, reopen, and the cached session paints the previous person's app
     around their cached data.

     Catching it here closes that, and closes it whether or not the request
     reaches the server. Only the DATA cache goes: the shell is the product,
     not a person, and throwing it away made the next sign-in re-download the
     whole application for nothing. */
  if (url.pathname === '/logout') {
    e.respondWith(
      (async () => {
        await caches.delete(DATA)
        return fetch(req)
      })(),
    )
    return
  }

  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          // The preloaded response if the browser started one, else the wire.
          const preloaded = await e.preloadResponse
          if (preloaded) return preloaded
          return await withTimeout(fetch(req), NAV_TIMEOUT_MS)
        } catch {
          const shell = await caches.match('/index.html', { cacheName: SHELL })
          return (
            shell ??
            new Response(OFFLINE_PAGE, {
              status: 503,
              headers: { 'Content-Type': 'text/html' },
            })
          )
        }
      })(),
    )
    return
  }

  /* A DOWNLOAD IS NOT A READ TO BE CACHED AND REPLAYED.

     Template and export endpoints answer with a file, and this worker stored
     every /api/ GET it saw -- so a template could be served from a copy taken
     before the importer changed, and a click could be satisfied without a
     single request leaving the machine. Left alone, they go to the network
     like any ordinary download. The family's own fee receipts are not in
     that set: a receipt is exactly the paper wanted in a dead spot, and it is
     an ordinary /api read, so it is cached like one. */
  if (url.pathname.includes('/template') || url.pathname.includes('/export')) return

  /* THE LIVE STREAM IS NOT A READ. /api/v1/live/stream is a Server-Sent Events
     response that never ends; racing it against a timeout, cloning it into
     the cache and reading the clone to the end would hold it forever and
     never let an event through. Straight to the network, untouched. */
  if (url.pathname.startsWith('/api/v1/live/')) return

  // Every API read goes to the network; the app's local store owns data.
  if (url.pathname.startsWith('/api/')) return

  // Everything else is a build artefact: hashed, immutable, cache first.
  e.respondWith(
    caches.match(req, { cacheName: SHELL }).then(
      (hit) =>
        hit ??
        fetch(req).then(async (res) => {
          if (res.ok) (await caches.open(SHELL)).put(req, res.clone())
          return res
        }),
    ),
  )
})
