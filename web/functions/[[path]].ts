/* THE FRONT END ON CLOUDFLARE PAGES, THE API SOMEWHERE ELSE, ONE ORIGIN.

   Pages serves web/dist from its edge for nothing. The Go server lives on
   Cloud Run or Fly under another hostname. The app was written for one
   origin: it calls `/api/...` relatively, the server sets its session cookie
   on the host it answered from, and the sign-in pages are rendered by the
   server at /login. Split across two hosts, every one of those breaks — the
   cookie is third-party, the fetches need CORS, the login page is on the
   wrong site.

   So the edge proxies. Every path the server owns is forwarded, unchanged,
   to API_ORIGIN, and the response streams back on the Pages origin. The
   browser sees one host; the cookie is first-party; nothing in the app or
   the Go code changes. `_routes.json` beside this file restricts Functions
   to exactly these paths, so a request for a static asset never invokes
   this and never counts against the Functions quota.

   The list below is the nginx server block's location list, which is the
   authority on what the server owns (scripts/deploy.sh). Keep them in step. */

interface Env {
  /** e.g. https://temperp-web-xyz-el.a.run.app — no trailing slash. */
  API_ORIGIN: string
  /** Optional. When set, every proxied request carries it as X-Origin-Secret,
      and the Go side (ORIGIN_SHARED_SECRET, httpx.RealIP) believes
      CF-Connecting-IP only on requests that carry it. Without it a caller
      who finds the run.app URL can name any visitor address it likes. Set
      the same value on both sides; an empty string on either side means
      "not in use", never "wrong". */
  ORIGIN_SHARED_SECRET?: string
}

/* Paths the server owns but the public must not reach through this origin.

   /api/v1/cron is the scheduler's clock: Cloud Scheduler calls it on the
   run.app URL directly, with X-Cron-Key, and nothing a browser does ever
   needs it. The key alone already makes it safe to expose (the Go handler
   answers 401 without it, in constant time); refusing it here is not the
   lock, it is one fewer public door to the lock, and it keeps a stray
   crawler's or a tester's requests to it from spending Functions quota and
   Cloud Run requests on 401s. 404 rather than 403 so the edge does not
   announce that the path exists. */
const NOT_PROXIED = ['/api/v1/cron']

const SERVER_PATHS = [
  '/api/', '/login', '/logout', '/healthz', '/static/', '/iclock/',
  '/buy', '/signup', '/forgot', '/reset', '/apps', '/files/',
]

function serverOwns(pathname: string): boolean {
  return SERVER_PATHS.some((p) =>
    p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(p + '/'),
  )
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  if (!serverOwns(url.pathname)) return context.next()
  if (NOT_PROXIED.includes(url.pathname)) return new Response('Not Found', { status: 404 })

  const origin = context.env.API_ORIGIN
  if (!origin) {
    return new Response('API_ORIGIN is not configured for this Pages project', { status: 503 })
  }

  const upstream = new URL(url.pathname + url.search, origin)
  const headers = new Headers(context.request.headers)
  /* The server decides redirects and cookie scope from the host it was asked
     for, and behind this proxy that must be the Pages host, not the run.app
     one. Host itself is set by fetch from the upstream URL, so the original
     travels in the forwarded headers, which is where the Go side reads it. */
  headers.set('X-Forwarded-Host', url.host)
  headers.set('X-Forwarded-Proto', 'https')
  /* Prove to the origin that this hop is ours. Set unconditionally (never
     copied from the incoming request) so a visitor cannot supply it, and
     deleted when unconfigured so a visitor cannot smuggle one through. */
  if (context.env.ORIGIN_SHARED_SECRET) {
    headers.set('X-Origin-Secret', context.env.ORIGIN_SHARED_SECRET)
  } else {
    headers.delete('X-Origin-Secret')
  }
  /* RealIP takes the LAST hop; Cloudflare puts the visitor in CF-Connecting-IP
     and appends to X-Forwarded-For, so appending here keeps the same contract. */
  const client = context.request.headers.get('CF-Connecting-IP')
  if (client) {
    const prior = headers.get('X-Forwarded-For')
    headers.set('X-Forwarded-For', prior ? `${prior}, ${client}` : client)
  }

  const init: RequestInit & { redirect: RequestRedirect } = {
    method: context.request.method,
    headers,
    body: context.request.body,
    // Redirects (login → /) must reach the browser on the Pages origin, not be
    // followed here against the upstream host.
    redirect: 'manual',
  }
  const response = await fetch(upstream.toString(), init)

  /* Rewrite a Location that names the upstream host back to this origin, so
     a server-side redirect after sign-in lands the browser where it started. */
  const out = new Headers(response.headers)
  const loc = out.get('Location')
  if (loc && loc.startsWith(origin)) out.set('Location', loc.slice(origin.length) || '/')
  return new Response(response.body, { status: response.status, headers: out })
}
