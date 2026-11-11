import type { Router, Ctx } from '../../router'
import { badRequest, HttpError, ok } from '../../http'
import { isLibraryPictureUrl, MAX_QUERY, pictureKeywords, type PictureHit, type PictureKind } from '../../../../shared/picture-search'

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
const MAX_RESULTS = 12
const MAX_BYTES = 5 * 1024 * 1024
const UA = 'SchoolERP-PictureSearch/1.0 (question paper picture suggestions)'
const TIMEOUT_MS = 8000

const timeout = () => AbortSignal.timeout(TIMEOUT_MS)

interface OpenverseHit {
  id: string; title?: string; creator?: string; license?: string; license_version?: string
  foreign_landing_url?: string; url?: string; filetype?: string | null; mature?: boolean; unstable__sensitivity?: unknown[]
}

const licenceName = (l = '', v = '') => {
  const k = l.toLowerCase()
  if (k === 'cc0') return 'CC0'
  if (k === 'pdm') return 'Public domain'
  return `CC ${k.toUpperCase()}${v ? ' ' + v : ''}`
}

/** A Commons file's PNG/JPEG rendering at one of the widths Commons serves. */
function commonsThumb(fileUrl: string, width: 330 | 500): string | null {
  const m = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+)$/.exec(fileUrl)
  if (!m) return null
  const [, a, ab, name] = m
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (!['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return null
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${a}/${ab}/${name}/${width}px-${name}${ext === 'svg' ? '.png' : ''}`
}

/** Titles that are signs, logos and maps, not pictures a child would recognise. */
const NOT_CLIPART = /\b(logo|bsicon|pictogram|symbol|sign|signage|emblem|coat of arms|flag|map|route|line \d|station|icon set)\b/i

async function openverse(q: string, kind: PictureKind): Promise<PictureHit[]> {
  const u = new URL('https://api.openverse.org/v1/images/')
  // "bus" alone brought logos and route signs; "bus clipart" brings drawings (owner, 2026-11-11).
  u.searchParams.set('q', kind === 'clipart' ? `${q} clipart` : q)
  u.searchParams.set('license_type', 'commercial,modification')
  u.searchParams.set('category', kind === 'clipart' ? 'illustration' : 'photograph')
  u.searchParams.set('mature', 'false')
  u.searchParams.set('page_size', '20')
  const res = await fetch(u.href, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: timeout() })
  if (!res.ok) throw new Error(`openverse ${res.status}`)
  const body = (await res.json()) as { results?: OpenverseHit[] }
  const out: PictureHit[] = []
  for (const r of body.results ?? []) {
    if (r.mature || (r.unstable__sensitivity?.length ?? 0) > 0) continue
    if (kind === 'clipart' && NOT_CLIPART.test(r.title ?? '')) continue
    // Openverse cannot shrink an SVG; Commons renders its own as PNG.
    const fromCommons = r.url ? commonsThumb(r.url, 330) : null
    const thumb = fromCommons ?? `https://api.openverse.org/v1/images/${r.id}/thumb/`
    const full = r.url ? commonsThumb(r.url, 500) ?? thumb : thumb
    if (r.filetype === 'svg' && !fromCommons) continue
    if (!isLibraryPictureUrl(thumb) || !isLibraryPictureUrl(full)) continue
    out.push({ thumb, full, title: (r.title ?? '').slice(0, 120), creator: (r.creator ?? '').slice(0, 80), licence: licenceName(r.license, r.license_version), source: r.foreign_landing_url ?? '' })
    if (out.length >= MAX_RESULTS) break
  }
  return out
}

interface CommonsPage { title: string; imageinfo?: { url: string; descriptionurl: string; extmetadata?: Record<string, { value?: string }> }[] }
const plain = (s = '') => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

async function commons(q: string, kind: PictureKind): Promise<PictureHit[]> {
  const u = new URL('https://commons.wikimedia.org/w/api.php')
  const p = { action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '30',
    gsrsearch: kind === 'clipart' ? `${q} clipart filetype:drawing` : `${q} filetype:bitmap`, prop: 'imageinfo', iiprop: 'url|extmetadata', origin: '*' }
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v)
  const res = await fetch(u.href, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: timeout() })
  if (!res.ok) throw new Error(`commons ${res.status}`)
  const body = (await res.json()) as { query?: { pages?: Record<string, CommonsPage & { index?: number }> } }
  const pages = Object.values(body.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const out: PictureHit[] = []
  for (const pg of pages) {
    const ii = pg.imageinfo?.[0]
    if (!ii) continue
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

async function search(q: string, kind: PictureKind): Promise<PictureHit[]> {
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
  const kind: PictureKind = c.url.searchParams.get('kind') === 'photo' ? 'photo' : 'clipart'
  if (q.length < 3) throw badRequest('Type a word to find pictures for.')
  const out = await cached<{ q: string; kind: PictureKind; items: PictureHit[]; unavailable?: boolean }>(`${kind}/${encodeURIComponent(q)}`, 3600, async () => {
    try {
      let items = await search(q, kind)
      let shown = kind
      // No drawing of it: offer photographs rather than nothing.
      if (!items.length && kind === 'clipart') { items = await search(q, 'photo'); shown = 'photo' }
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
  if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new HttpError(502, 'That picture could not be loaded. Choose another.')
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
