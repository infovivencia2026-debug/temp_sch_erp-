/* Picture suggestions in the Question maker: the parts both sides share.

   The browser takes the key words of the paragraph being typed and asks the
   Worker; the Worker asks a free, openly licensed picture library. Only these
   few words ever leave the school, never the rest of the paper. The Worker
   fetches pictures only from the libraries' own hosts (no open proxy). */

const STOP = new Set(`a an the and or but if then than so of to in on at by for from with without into onto over under up down out off
is am are was were be been being do does did done have has had having can could will would shall should may might must
i me my we our you your he him his she her it its they them their this that these those there here who whom whose which what
when where why how not no yes very too also just only all any both each few more most other some such own same
write name choose select pick tick mark find fill blank blanks correct answer answers question questions following given below above
draw picture pictures identify colour color circle match one two three four five six seven eight nine ten
give explain describe define state list example examples see look read say tell use using used like
q ans marks mark eg ie etc`.split(/\s+/))

const MAX_WORDS = 3
export const MAX_QUERY = 60

/** The key words of a sentence, for a picture search: no stop words, no numbers, at most 3 words and 60 characters. */
export function pictureKeywords(text: string): string {
  const words = (text.toLowerCase().normalize('NFC').match(/[\p{L}\p{M}]+/gu) ?? [])
    .filter((w) => !STOP.has(w) && (w.length >= 3 || /[^\x00-\x7f]/.test(w)))
  const seen: string[] = []
  // The last words of a question are usually the thing to picture ("... apple").
  for (let i = words.length - 1; i >= 0 && seen.length < MAX_WORDS; i--) if (!seen.includes(words[i])) seen.unshift(words[i])
  let q = seen.join(' ')
  while (q.length > MAX_QUERY) q = q.split(' ').slice(1).join(' ')
  return q
}

/** The picture kinds a teacher can ask for. */
export type PictureKind = 'clipart' | 'photo'

/** One suggestion, as the Worker returns it. `thumb` and `full` are library URLs, fetched through the Worker. */
export interface PictureHit {
  thumb: string
  full: string
  title: string
  creator: string
  licence: string
  source: string
}

const OPENVERSE_THUMB = /^\/v1\/images\/[0-9a-f-]{36}\/thumb\/$/
const FLICKR = /^\/\d+\/\d+_[0-9a-f]+(_[a-z])?\.jpg$/
const RAWPIXEL = /^\/editor_\d+\/[A-Za-z0-9_-]+\.(jpg|png)$/
const COMMONS = /^\/wikipedia\/commons\/[\w%().,~!'*+-]+(\/[\w%().,~!'*+-]+)*$/

/** True only for a picture on a library's own host, over https, with nothing unexpected in it. */
export function isLibraryPictureUrl(u: string): boolean {
  let url: URL
  try { url = new URL(u) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false
  if (url.hostname === 'api.openverse.org') return OPENVERSE_THUMB.test(url.pathname)
  if (url.hostname === 'live.staticflickr.com') return FLICKR.test(url.pathname)
  if (url.hostname === 'images.rawpixel.com') return RAWPIXEL.test(url.pathname)
  if (url.hostname === 'upload.wikimedia.org') return COMMONS.test(url.pathname) && !url.pathname.includes('..')
  return false
}

/* Openverse search, used by the browser first (each teacher's own allowance)
   and by the Worker as a fallback. */
export interface OpenverseHit {
  id: string; title?: string; creator?: string; license?: string; license_version?: string
  foreign_landing_url?: string; url?: string; filetype?: string | null; mature?: boolean; unstable__sensitivity?: unknown[]
}

export const licenceName = (l = '', v = '') => {
  const k = l.toLowerCase()
  if (k === 'cc0') return 'CC0'
  if (k === 'pdm') return 'Public domain'
  return `CC ${k.toUpperCase()}${v ? ' ' + v : ''}`
}

/** A Commons file's PNG/JPEG rendering at one of the widths Commons serves. */
export function commonsThumb(fileUrl: string, width: 330 | 500): string | null {
  const m = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+)$/.exec(fileUrl)
  if (!m) return null
  const [, a, ab, name] = m
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (!['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return null
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${a}/${ab}/${name}/${width}px-${name}${ext === 'svg' ? '.png' : ''}`
}

/** Titles that are signs, logos and maps, not pictures a child would recognise. */
export const NOT_CLIPART = /\b(logo|bsicon|pictogram|symbol|sign|signage|emblem|coat of arms|flag|map|route|line \d|station|icon set)\b/i

export function directPicture(u: string): { thumb: string; full: string } | null {
  if (/^https:\/\/live\.staticflickr\.com\/\d+\/\d+_[0-9a-f]+(_[a-z])?\.jpg$/.test(u)) {
    const base = u.replace(/(_[a-z])?\.jpg$/, '')
    return { thumb: `${base}_n.jpg`, full: `${base}_b.jpg` }
  }
  if (/^https:\/\/images\.rawpixel\.com\/editor_\d+\/[A-Za-z0-9_-]+\.(jpg|png)$/.test(u)) return { thumb: u, full: u }
  return null
}


export function openverseUrl(q: string, kind: PictureKind, page = 1): string {
  const u = new URL('https://api.openverse.org/v1/images/')
  // "bus" alone brought logos and route signs; "bus clipart" brings drawings (owner, 2026-11-11).
  u.searchParams.set('q', kind === 'clipart' ? `${q} clipart` : q)
  u.searchParams.set('license_type', 'commercial,modification')
  u.searchParams.set('category', kind === 'clipart' ? 'illustration' : 'photograph')
  u.searchParams.set('mature', 'false')
  u.searchParams.set('page_size', '20')
  if (page > 1) u.searchParams.set('page', String(page))
  return u.href
}

/* A picture whose name does not contain a searched word is not shown: "candy"
   brought "candy apple red" cars (owner, 2026-11-11). Plural/singular count. */
export function namesWord(title: string, q: string): boolean {
  const t = title.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && w !== 'clipart').some((w) => {
    const stem = w.replace(/(ies|es|s)$/, '')
    const clean = stem.replace(/[^\p{L}\p{N}]/gu, '')
    return clean.length > 0 && t.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(clean))
  })
}

export function openverseHits(results: OpenverseHit[], kind: PictureKind, max = 12, q = ''): PictureHit[] {
  const out: PictureHit[] = []
  for (const r of results) {
    if (q && !namesWord(r.title ?? '', q)) continue
    if (r.mature || (r.unstable__sensitivity?.length ?? 0) > 0) continue
    if (kind === 'clipart' && NOT_CLIPART.test(r.title ?? '')) continue
    const fromCommons = r.url ? commonsThumb(r.url, 330) : null
    const direct = r.url ? directPicture(r.url) : null
    const thumb = fromCommons ?? direct?.thumb ?? `https://api.openverse.org/v1/images/${r.id}/thumb/`
    const full = r.url ? commonsThumb(r.url, 500) ?? direct?.full ?? thumb : thumb
    if (r.filetype === 'svg' && !fromCommons) continue
    if (!isLibraryPictureUrl(thumb) || !isLibraryPictureUrl(full)) continue
    out.push({ thumb, full, title: (r.title ?? '').slice(0, 120), creator: (r.creator ?? '').slice(0, 80), licence: licenceName(r.license, r.license_version), source: r.foreign_landing_url ?? '' })
    if (out.length >= max) break
  }
  return out
}
