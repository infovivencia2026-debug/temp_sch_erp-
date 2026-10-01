/* <school>.xulo.in -> that school's portal (docs/white-label.md).

   The school's address is its first label: yajur.xulo.in is /in/yajur on
   the app. The bare root sends the visitor to the branded login; every other
   path (the app, /api, assets) is fetched from the app as-is, so a session
   started here stays on this address. Reserved names are not schools and go
   to whatever serves them. Unknown slugs get the app's own not-found page. */
const RESERVED = new Set(['erp', 'api', 'app', 'cdn', 'www', 'admin', 'mail', 'parent', 'staff', 'status', 'docs'])

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const labels = url.hostname.split('.')
    const slug = labels.length === 3 ? labels[0].toLowerCase() : ''
    if (!slug || RESERVED.has(slug) || !/^[a-z0-9-]{2,40}$/.test(slug)) return fetch(req)
    if (url.pathname === '/' || url.pathname === '') {
      return Response.redirect(`${url.origin}/${env.COUNTRY}/${slug}${url.search}`, 302)
    }
    const target = new URL(url.pathname + url.search, env.APP_ORIGIN)
    const res = await fetch(new Request(target, req), { redirect: 'manual' })
    /* A redirect from the app names the app's host; keep the visitor here. */
    const loc = res.headers.get('location')
    if (loc && loc.startsWith(env.APP_ORIGIN)) {
      const h = new Headers(res.headers)
      h.set('location', url.origin + loc.slice(env.APP_ORIGIN.length))
      return new Response(res.body, { status: res.status, headers: h })
    }
    return res
  },
}
