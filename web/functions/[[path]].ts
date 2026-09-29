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
  /** Optional Service Binding to the Worker backend (the test project's
      wrangler.toml: [[services]] binding = "API"). When present, requests go
      to the Worker inside Cloudflare, with no public hop or TLS handshake;
      API_ORIGIN is then only used to rewrite Location headers. */
  API?: { fetch: (req: Request) => Promise<Response> }
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

/* '/static/' is deliberately absent. The stylesheet and the two Inter files
   the server-rendered pages name are mirrored into web/public/static and served
   from the edge, so a cold visitor to /login no longer wakes a Cloud Run
   instance for three files that never change. See web/public/static/README.md.

   '/apps' stays: it is a rendered template, not a static page. It reads the
   published builds off disk and prints each one's version, size, build date and
   SHA-256, and with no APK_DIR it renders a different page again — the one that
   says the download is coming from a static file. Only the APKs it links are
   static, and those are already under /download/. */
const SCHOOL_COUNTRIES = ['in',  'ae',  'np',  'lk',  'bd',  'sa',  'om',  'kw',  'bh',  'sg',  'my',  'ke',  'ng',  'uk',  'us',  'au',  'ca',  'za',  'nz',  'gb']

const SERVER_PATHS = [
  '/api/', '/login', '/logout', '/healthz', '/iclock/',
  '/buy', '/signup', '/forgot', '/reset', '/apps', '/files/',
  /* Each school's own sign-in page, /<country>/<slug> (white label, set in
     the seller's Tenants → Branding). One entry per country we sell in; keep
     in step with _routes.json. 'qa' is absent: /qa/ is a static folder. */
  ...SCHOOL_COUNTRIES.map((c) => `/${c}/`),
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
  const api = context.env.API
  if (!origin && !api) {
    return new Response('API_ORIGIN is not configured for this Pages project', { status: 503 })
  }

  const upstream = new URL(url.pathname + url.search, origin || url.origin)
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

  /* The visitor, for login throttling, session activity and audit: past this
     hop CF-Connecting-IP and request.cf describe this function, not the
     person. Always set or removed here, never copied from the visitor. The
     Worker believes X-Visitor-* only on a request whose X-Origin-Secret
     checks out (worker/src/origin.ts), so the secret signs them. */
  const cf = (context.request as unknown as { cf?: Record<string, unknown> }).cf ?? {}
  const visitor: Record<string, unknown> = { 'X-Visitor-IP': client, 'X-Visitor-City': cf.city, 'X-Visitor-Region': cf.region, 'X-Visitor-Country': cf.country }
  for (const [k, v] of Object.entries(visitor)) {
    if (typeof v === 'string' && v) headers.set(k, encodeURIComponent(v).slice(0, 120))
    else headers.delete(k)
  }

  const init: RequestInit & { redirect: RequestRedirect } = {
    method: context.request.method,
    headers,
    body: context.request.body,
    // Redirects (login → /) must reach the browser on the Pages origin, not be
    // followed here against the upstream host.
    redirect: 'manual',
  }
  const response = api ? await api.fetch(new Request(upstream.toString(), init)) : await fetch(upstream.toString(), init)

  // A WebSocket upgrade (/api/v1/live/socket) must be handed back as is: rebuilding it drops the socket.
  if (response.status === 101) return response

  // A WebSocket upgrade (/api/v1/live/socket) must be handed back as is: rebuilding it drops the socket.
  if (response.status === 101) return response

  /* Rewrite a Location that names the upstream host back to this origin, so
     a server-side redirect after sign-in lands the browser where it started. */
  const out = new Headers(response.headers)
  const loc = out.get('Location')
  if (loc && origin && loc.startsWith(origin)) out.set('Location', loc.slice(origin.length) || '/')
  return new Response(response.body, { status: response.status, headers: out })
}
