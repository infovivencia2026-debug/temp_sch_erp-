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

   An API read is network first. Fresh beats fast for a fee balance, and a
   cached answer is only ever a fallback for a request that could not be made
   at all. Writes are never touched: they belong to the outbox, which knows how
   to make them safe to repeat, and a service worker replaying a POST would be
   the double-write this product has just spent a migration preventing. */

const SHELL = 'erp-shell-__BUILD__'
const DATA = 'erp-data-__BUILD__'
const PRECACHE = __PRECACHE__

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
      const keep = new Set([SHELL, DATA])
      for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k)
      await self.clients.claim()
    })(),
  )
})

/* Sign-out, and switching account on a shared laptop.

   Cached API answers are one person's data. The staffroom laptop signs in and
   out all day, and leaving the previous teacher's cached register available to
   the next one is a data leak that would look exactly like a feature. The app
   posts this the moment the session's user changes. */
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
})

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
     reaches the server: the caches are gone before the navigation is even
     attempted, so a sign-out on a dead line still ends the session on this
     device. */
  if (url.pathname === '/logout') {
    e.respondWith(
      (async () => {
        await Promise.all([caches.delete(SHELL), caches.delete(DATA)])
        return fetch(req)
      })(),
    )
    return
  }

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(async () => {
        const shell = await caches.match('/index.html', { cacheName: SHELL })
        return (
          shell ??
          new Response('<h1>No connection</h1>', {
            status: 503,
            headers: { 'Content-Type': 'text/html' },
          })
        )
      }),
    )
    return
  }

  if (url.pathname.startsWith('/api/')) {
    /* The session call is cached like any other read, which is what makes a
       cold start with no signal land on the product rather than on "could not
       reach the server". It is the gate every screen waits behind.

       That is only safe because signing out clears these caches above, before
       the request is even sent. Without that, this line would be the leak:
       the shell would paint the last person's workspace to whoever opened the
       laptop next. */
    e.respondWith(
      (async () => {
        try {
          const res = await fetch(req)
          if (res.ok) (await caches.open(DATA)).put(req, res.clone())
          return res
        } catch (err) {
          const hit = await caches.match(req, { cacheName: DATA })
          if (hit) {
            /* Marked, so the app can say "this is what we last saw" rather
               than presenting yesterday's balance as today's. */
            const h = new Headers(hit.headers)
            h.set('X-From-Cache', '1')
            return new Response(hit.body, { status: hit.status, headers: h })
          }
          throw err
        }
      })(),
    )
    return
  }

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
