import type { Router, Ctx } from '../../router'
import { badRequest, HttpError, ok } from '../../http'
import { iconSearch, commonsThumb, namesWord, isLibraryPictureUrl, MAX_QUERY, openverseHits, openverseUrl, pictureKeywords, type OpenverseHit, type PictureHit, type PictureKind } from '../../../../shared/picture-search'

/* Picture suggestions for the Question maker: free, openly licensed pictures
   (CC0, public domain, CC BY, CC BY-SA) from Openverse, or Wikimedia Commons
   when Openverse does not answer. Clip art (drawings) first; photos only when
   asked for, or when no drawing matches.

   Only the key words are sent (shared/picture-search.ts strips them again
   here). Pictures are fetched through this Worker so the page's CSP holds and
   the library never sees the teacher; only the libraries' own hosts are
   fetched, images only, at most 5 MB. Inserting one stores it in the image
   store like any upload (lib/images.ts uploadImage), with its credit. */

const EXAMS_READ = 'academics.exams.read'
const MAX_RESULTS = 40
const MAX_BYTES = 5 * 1024 * 1024
const UA = 'SchoolERP-PictureSearch/1.0 (question paper picture suggestions)'
const TIMEOUT_MS = 8000

const timeout = () => AbortSignal.timeout(TIMEOUT_MS)

async function openverse(q: string, kind: PictureKind): Promise<PictureHit[]> {
  const res = await fetch(openverseUrl(q, kind), { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: timeout() })
  if (!res.ok) throw new Error(`openverse ${res.status}`)
  const body = (await res.json()) as { results?: OpenverseHit[] }
  return openverseHits(body.results ?? [], kind, MAX_RESULTS, q)
}

interface CommonsPage { title: string; imageinfo?: { url: string; descriptionurl: string; extmetadata?: Record<string, { value?: string }> }[] }
const plain = (s = '') => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

async function commons(q: string, kind: PictureKind): Promise<PictureHit[]> {
  const u = new URL('https://commons.wikimedia.org/w/api.php')
  const p = { action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '30',
    gsrsearch: kind === 'outline' ? `${q} line art filetype:drawing` : kind === 'clipart' ? `${q} clipart filetype:drawing` : `${q} filetype:bitmap`, prop: 'imageinfo', iiprop: 'url|extmetadata', origin: '*' }
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v)
  const res = await fetch(u.href, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: timeout() })
  if (!res.ok) throw new Error(`commons ${res.status}`)
  const body = (await res.json()) as { query?: { pages?: Record<string, CommonsPage & { index?: number }> } }
  const pages = Object.values(body.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const out: PictureHit[] = []
  for (const pg of pages) {
    const ii = pg.imageinfo?.[0]
    if (!ii || !namesWord(pg.title.replace(/^File:/, ''), q)) continue
    const meta = ii.extmetadata ?? {}
    const licence = plain(meta.LicenseShortName?.value)
    // Free to reuse and adapt: public domain, CC0, CC BY, CC BY-SA. Not NC or ND.
    if (!/^(cc0|public domain|pd|cc[ -]by(-sa)?\b)/i.test(licence) || /\b(nc|nd)\b/i.test(licence)) continue
    const thumb = commonsThumb(ii.url, 330), full = commonsThumb(ii.url, 500)
    if (!thumb || !full) continue
    out.push({ thumb, full, title: pg.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '').slice(0, 120), creator: plain(meta.Artist?.value).slice(0, 80), licence, source: ii.descriptionurl })
    if (out.length >= MAX_RESULTS) break
  }
  return out
}

/* Pixabay (owner, 2026-11-11: "only 4 5 images, not accurate"): free, keyed,
   far more and better drawings than Openverse. Used first when the key is set. */
interface PixabayHit { id: number; tags?: string; user?: string; previewURL?: string; webformatURL?: string; pageURL?: string }
/* Only pictures whose own first tags name the thing (owner, 2026-11-11: a
   trophy and a map came for "mango"). Outline asks for the same pictures;
   the browser draws them as line art, so they are as many and as accurate. */
function tagsName(tags: string, q: string): boolean {
  const first = tags.toLowerCase().split(',').map((t) => t.trim()).filter((t) => t && t !== 'ai generated').slice(0, 2).join(',')
  return namesWord(first, q)
}
async function pixabay(key: string, q: string, kind: PictureKind, page = 1): Promise<PictureHit[]> {
  const u = new URL('https://pixabay.com/api/')
  u.searchParams.set('key', key)
  u.searchParams.set('q', q)
  u.searchParams.set('image_type', kind === 'photo' ? 'photo' : 'illustration')
  u.searchParams.set('safesearch', 'true')
  u.searchParams.set('per_page', '60')
  u.searchParams.set('page', String(page))
  const res = await fetch(u.href, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: timeout() })
  if (!res.ok) throw new Error(`pixabay ${res.status}`)
  const body = (await res.json()) as { hits?: PixabayHit[] }
  const out: PictureHit[] = []
  for (const h of body.hits ?? []) {
    const thumb = h.webformatURL ?? '', full = h.webformatURL ?? ''
    if (!isLibraryPictureUrl(thumb) || !tagsName(h.tags ?? '', q)) continue
    out.push({ thumb, full, title: (h.tags ?? '').split(',')[0].trim().slice(0, 120) || q, creator: (h.user ?? '').slice(0, 80), licence: 'Pixabay licence', source: h.pageURL ?? '' })
  }
  return out
}

async function search(q: string, kind: PictureKind, key?: string): Promise<PictureHit[]> {
  if (key) { try { const p = await pixabay(key, q, kind); if (p.length) return p } catch { /* the open libraries next */ } }
  try {
    return await openverse(q, kind)
  } catch {
    return commons(q, kind)
  }
}

/** Cached answers for a while (same words, same pictures), shared by every school. */
async function cached<T>(key: string, maxAge: number, make: () => Promise<{ body: T; keep: boolean }>): Promise<T> {
  const cache = typeof caches !== 'undefined' ? (caches as unknown as { default?: Cache }).default : undefined
  const req = new Request(`https://picture-search.cache/${key}`)
  const hit = await cache?.match(req).catch(() => undefined)
  if (hit) return (await hit.json()) as T
  const { body, keep } = await make()
  if (cache && keep) await cache.put(req, new Response(JSON.stringify(body), { headers: { 'Cache-Control': `max-age=${maxAge}`, 'Content-Type': 'application/json' } })).catch(() => undefined)
  return body
}

async function pictureSearch(c: Ctx) {
  const q = pictureKeywords(String(c.url.searchParams.get('q') ?? '').slice(0, 400)).slice(0, MAX_QUERY)
  const k = c.url.searchParams.get('kind')
  const kind: PictureKind = k === 'photo' ? 'photo' : k === 'outline' ? 'outline' : 'clipart'
  const key = c.env.PIXABAY_KEY
  if (q.length < 3) throw badRequest('Type a word to find pictures for.')
  const page = Math.min(8, Math.max(1, Number(c.url.searchParams.get('page')) || 1))
  // Later pages, while scrolling: Pixabay only (owner, 2026-11-11: "lazy loading").
  if (page > 1) {
    if (!key) return ok({ q, kind, items: [] })
    const items = await cached<PictureHit[]>(`px1/${kind}/${page}/${encodeURIComponent(q)}`, 3600, async () => {
      try { const body = await pixabay(key, q, kind, page); return { body, keep: true } } catch { return { body: [], keep: false } }
    })
    return ok({ q, kind, items })
  }
  if (c.url.searchParams.get('src') === 'icons') {
    const items = await cached<PictureHit[]>(`i1/${kind}/${encodeURIComponent(q)}`, 86400, async () => { const body = await iconSearch(q, kind, timeout()); return { body, keep: body.length > 0 } })
    return ok({ q, kind, items })
  }
  const out = await cached<{ q: string; kind: PictureKind; items: PictureHit[]; unavailable?: boolean }>(`v4${key ? 'p' : ''}/${kind}/${encodeURIComponent(q)}`, 3600, async () => {
    try {
      let items = await search(q, kind, key)
      let shown = kind
      // No drawing of it: offer photographs rather than nothing.
      if (!items.length && kind === 'clipart') { items = await search(q, 'photo', key); shown = 'photo' }
      return { body: { q, kind: shown, items }, keep: true }
    } catch {
      return { body: { q, kind, items: [] as PictureHit[], unavailable: true }, keep: false }
    }
  })
  return ok(out)
}

/* One picture from a library, by its URL as search returned it. No redirects
   are followed (a redirect could leave the allowed hosts). */
async function picture(c: Ctx) {
  const u = String(c.url.searchParams.get('u') ?? '')
  if (!isLibraryPictureUrl(u)) throw badRequest('That picture is not from the picture library.')
  let res: Response
  try {
    res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'image/*' }, redirect: 'manual', signal: timeout() })
  } catch {
    throw new HttpError(502, 'The picture library did not answer. Try again in a moment.')
  }
  const type = (res.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
  if (!res.ok || !/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(type)) throw new HttpError(502, 'That picture could not be loaded. Choose another.')
  if (Number(res.headers.get('Content-Length') ?? 0) > MAX_BYTES) throw badRequest('That picture is too large. Choose another.')
  const bytes = await readCapped(res, MAX_BYTES)
  if (!bytes) throw badRequest('That picture is too large. Choose another.')
  return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } })
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > cap) { await reader.cancel(); return null }
    parts.push(value)
  }
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

export function registerPictureSearch(r: Router): void {
  r.get('/exams/picture-search', EXAMS_READ, pictureSearch)
  r.get('/exams/picture-search/image', EXAMS_READ, picture)
}
