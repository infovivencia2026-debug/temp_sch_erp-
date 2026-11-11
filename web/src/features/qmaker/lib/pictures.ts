import { actingInstitution } from '@/lib/api'
import { openverseHits, openverseUrl, type OpenverseHit, type PictureHit, type PictureKind } from '@shared/picture-search'
import { uploadImage, type ImageAsset } from './images'

/* Free pictures from an open library (Openverse, Wikimedia Commons), found by
   the key words of what the teacher types. The Worker does the asking and the
   fetching (routes/exams/pictures.ts); a picture chosen is stored in the
   image store like an upload, named with its credit. */

export type { PictureHit, PictureKind }
export { pictureKeywords } from '@shared/picture-search'

export interface PictureResult { q: string; kind: PictureKind; items: PictureHit[]; unavailable?: boolean }

const headers = (): Record<string, string> => {
  const acting = actingInstitution()
  return { Accept: 'application/json', ...(acting ? { 'X-Acting-Institution': acting } : {}) }
}

/* The browser asks Openverse itself first (owner, 2026-11-11: wrong pictures,
   slow): from the Worker every school shares one anonymous allowance of 200 a
   day, and once it ran out each search waited 8 s and fell back to Commons
   logos. Only the key words go; no cookie, no school. The Worker stays the
   fallback. */
async function browserSearch(q: string, kind: PictureKind, signal?: AbortSignal): Promise<PictureResult | null> {
  // Two pages at once: up to 40 clip art choices (owner, 2026-11-11: "as many options").
  const page = async (n: number) => {
    const res = await fetch(openverseUrl(q, kind, n), { credentials: 'omit', referrerPolicy: 'no-referrer', signal })
    return res.ok ? ((await res.json()) as { results?: OpenverseHit[] }).results ?? [] : null
  }
  try {
    const [a, b] = await Promise.all([page(1), page(2).catch(() => [])])
    if (a === null) return null
    // Closest names first: "Chocolate bar clipart" before "Chocolate cupcake".
    const items = openverseHits([...a, ...(b ?? [])], kind, 60, q)
    const words = q.toLowerCase().split(/\s+/)
    const score = (t: string) => { const x = t.toLowerCase(); const w = words.find((k) => x.includes(k)) ?? ''; return (x.startsWith(w) ? 0 : 2) + (x.split(/[ ,]+/).length > 4 ? 1 : 0) }
    const seen = new Set<string>()
    return { q, kind, items: items.filter((h) => !seen.has(h.title) && seen.add(h.title)).sort((x, y) => score(x.title) - score(y.title)).slice(0, 40) }
  } catch (e) {
    if (signal?.aborted) throw e
    return null
  }
}

/* Iconify (owner, 2026-11-11: "use a better free one"): free, keyless, open
   licences (Noto, Twemoji, OpenMoji, Fluent, Game Icons...). Its pictures are
   named for exactly what they show, so "chocolate" is a chocolate bar, not a
   chocolate cupcake. Shown first; Openverse clip art follows as more choices. */
/* Many more sets (owner, 2026-11-11: "only 4 5 images, not accurate"), and
   an outline kind: black line drawings for colouring and labelling. A name
   must hold the word itself ("apple", not "pineapple" or "grapple"). */
const COLOUR_SETS: Record<string, string> = {
  noto: 'Apache 2.0', 'noto-v1': 'Apache 2.0', 'fluent-emoji-flat': 'MIT', 'fluent-emoji': 'MIT', twemoji: 'CC BY 4.0', openmoji: 'CC BY-SA 4.0',
  emojione: 'CC BY 4.0', 'emojione-v1': 'CC BY-SA 4.0', fxemoji: 'Apache 2.0', 'streamline-emojis': 'CC BY 4.0', 'streamline-color': 'CC BY 4.0',
  'streamline-flex-color': 'CC BY 4.0', 'flat-color-icons': 'MIT', 'icon-park-twotone': 'Apache 2.0', healthicons: 'MIT', 'game-icons': 'CC BY 3.0',
}
const OUTLINE_SETS: Record<string, string> = {
  'fluent-emoji-high-contrast': 'MIT', 'emojione-monotone': 'CC BY 4.0', 'icon-park-outline': 'Apache 2.0', tabler: 'MIT', ph: 'MIT', lucide: 'ISC',
  iconoir: 'MIT', streamline: 'CC BY 4.0', hugeicons: 'MIT', mdi: 'Apache 2.0', healthicons: 'MIT', 'game-icons': 'CC BY 3.0',
}
// Filled, bold and brand variants of an outline icon, and "no-x" signs.
const NOT_OUTLINE = /-(fill|filled|solid|bold|duotone|off|slash|ios|logo|remix|sharp|light|thin)(-|$)/
async function iconSearch(q: string, kind: PictureKind, signal?: AbortSignal): Promise<PictureHit[]> {
  const sets = kind === 'outline' ? OUTLINE_SETS : COLOUR_SETS
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const stems = words.map((w) => w.replace(/(ies|es|s)$/, ''))
  try {
    const res = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&prefixes=${Object.keys(sets).join(',')}&limit=999`, { credentials: 'omit', referrerPolicy: 'no-referrer', signal })
    if (!res.ok) return []
    const body = (await res.json()) as { icons?: string[] }
    const hits = (body.icons ?? []).map((id) => {
      const [set, name] = id.split(':')
      const parts = name.split('-')
      const exact = parts.some((p) => words.includes(p))
      const ok = exact || parts.some((p) => stems.some((st) => p === st || p === st + 's' || p === st + 'es'))
      return { set, name, parts, ok, exact }
    }).filter((h) => h.ok && !(kind === 'outline' && NOT_OUTLINE.test(h.name)))
    // Closest first: the name is the word itself, then short names.
    const whole = words.join('-')
    hits.sort((x, y) => Number(y.name === whole) - Number(x.name === whole) || Number(y.exact) - Number(x.exact) || x.parts.length - y.parts.length)
    return hits.slice(0, 120).map(({ set, name }) => {
      const url = `https://api.iconify.design/${set}/${name}.svg`
      return { thumb: url, full: url, title: name.replace(/-/g, ' '), creator: set, licence: sets[set] ?? '', source: `https://icon-sets.iconify.design/${set}/${name}/` }
    })
  } catch (e) {
    if (signal?.aborted) throw e
    return []
  }
}

/* Two separate searches so the quick one shows at once (owner, 2026-11-11:
   "taking too long to load"): Iconify answers in a moment; the open library
   (two pages, Worker fallback) adds its pictures when it is ready. */
export async function searchPictures(q: string, kind: PictureKind, signal?: AbortSignal): Promise<PictureResult> {
  return { q, kind, items: await iconSearch(q, kind, signal) }
}
export async function searchMorePictures(q: string, kind: PictureKind, signal?: AbortSignal): Promise<PictureResult> {
  return searchLibrary(q, kind, signal)
}

async function searchLibrary(q: string, kind: PictureKind, signal?: AbortSignal): Promise<PictureResult> {
  // The Worker first: it asks Pixabay when the school set a key (owner, 2026-11-11).
  const res = await fetch(`/api/v1/exams/picture-search?q=${encodeURIComponent(q)}&kind=${kind}`, { credentials: 'same-origin', headers: headers(), signal }).catch((e) => { if (signal?.aborted) throw e; return null })
  const viaWorker = res?.ok ? ((await res.json()) as PictureResult) : null
  if (viaWorker?.items.length) return viaWorker
  return (await browserSearch(q, kind, signal)) ?? viaWorker ?? { q, kind, items: [] }
}

/** The Worker's copy of a library picture, for an <img src>. */
export const pictureSrc = (u: string) => `/api/v1/exams/picture-search/image?u=${encodeURIComponent(u)}`
/** A tile's picture straight from the library's host: quicker than through the Worker. */
export const tileSrc = (u: string) => (/^https:\/\/(api\.iconify\.design|images\.rawpixel\.com|live\.staticflickr\.com|upload\.wikimedia\.org)\//.test(u) ? u : pictureSrc(u))

/** The name it is kept under in the image store: what it is, and whose. */
export function creditName(p: PictureHit): string {
  const by = [p.creator && `by ${p.creator}`, p.licence].filter(Boolean).join(', ')
  return `${p.title || 'Picture'}${by ? ` (${by})` : ''}`.slice(0, 120)
}

/** Fetches the picture through the Worker and stores it like an upload. */
/** An Iconify SVG drawn to a 512px PNG in the browser, so it prints and goes into Word like any picture. */
async function svgToPng(url: string): Promise<Blob> {
  // Outline icons draw in currentColor: black on paper.
  const svg = (await (await fetch(url, { credentials: 'omit' })).text()).replace(/currentColor/g, '#000')
  const img = new Image()
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  await img.decode()
  const c = document.createElement('canvas')
  c.width = 512; c.height = 512
  c.getContext('2d')!.drawImage(img, 0, 0, 512, 512)
  URL.revokeObjectURL(img.src)
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('That picture could not be drawn. Choose another.'))), 'image/png'))
}

export async function storePicture(p: PictureHit): Promise<ImageAsset> {
  if (p.full.startsWith('https://api.iconify.design/')) return uploadImage(await svgToPng(p.full), creditName(p))
  const res = await fetch(pictureSrc(p.full), { credentials: 'same-origin', headers: headers() })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? 'That picture could not be loaded. Choose another.')
  }
  return uploadImage(await res.blob(), creditName(p))
}

/* Any picture as a black outline on white (owner, 2026-11-11: "image store
   add outline"): edges found by a Sobel filter, for colouring and labelling. */
export async function outlineOf(src: string): Promise<Blob> {
  const img = new Image()
  img.src = src
  await img.decode()
  const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale))
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const x = c.getContext('2d', { willReadFrequently: true })!
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h)
  x.drawImage(img, 0, 0, w, h)
  const d = x.getImageData(0, 0, w, h)
  const g = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d.data[i * 4] + 0.587 * d.data[i * 4 + 1] + 0.114 * d.data[i * 4 + 2]
  const at = (a: number, b: number) => g[Math.min(h - 1, Math.max(0, b)) * w + Math.min(w - 1, Math.max(0, a))]
  const out = x.createImageData(w, h)
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const gx = at(xx + 1, yy - 1) + 2 * at(xx + 1, yy) + at(xx + 1, yy + 1) - at(xx - 1, yy - 1) - 2 * at(xx - 1, yy) - at(xx - 1, yy + 1)
    const gy = at(xx - 1, yy + 1) + 2 * at(xx, yy + 1) + at(xx + 1, yy + 1) - at(xx - 1, yy - 1) - 2 * at(xx, yy - 1) - at(xx + 1, yy - 1)
    const v = Math.hypot(gx, gy) > 90 ? 0 : 255
    const o = (yy * w + xx) * 4
    out.data[o] = out.data[o + 1] = out.data[o + 2] = v
    out.data[o + 3] = 255
  }
  x.putImageData(out, 0, 0)
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('That outline could not be made.'))), 'image/png'))
}

const KEY = 'qm.pictureSuggestions'
export function suggestionsOn(): boolean {
  try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}
export function setSuggestionsOn(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* private window: only this visit */ }
}
