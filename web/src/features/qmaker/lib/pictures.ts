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
/* Two separate searches so the quick one shows at once (owner, 2026-11-11:
   "taking too long to load"): Iconify answers in a moment; the open library
   (two pages, Worker fallback) adds its pictures when it is ready. */
export async function searchPictures(q: string, kind: PictureKind, signal?: AbortSignal): Promise<PictureResult> {
  const res = await fetch(`/api/v1/exams/picture-search?q=${encodeURIComponent(q)}&kind=${kind}&src=icons`, { credentials: 'same-origin', headers: headers(), signal })
  if (!res.ok) throw new Error('Pictures could not be searched. Check the connection and try again.')
  return (await res.json()) as PictureResult
}
export async function searchMorePictures(q: string, kind: PictureKind, signal?: AbortSignal, page = 1): Promise<PictureResult> {
  if (page > 1) {
    const res = await fetch(`/api/v1/exams/picture-search?q=${encodeURIComponent(q)}&kind=${kind}&page=${page}`, { credentials: 'same-origin', headers: headers(), signal })
    return res.ok ? ((await res.json()) as PictureResult) : { q, kind, items: [] }
  }
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
export const tileSrc = (u: string) => (/^https:\/\/(images\.rawpixel\.com|live\.staticflickr\.com|upload\.wikimedia\.org)\//.test(u) ? u : pictureSrc(u))

/** The name it is kept under in the image store: what it is, and whose. */
export function creditName(p: PictureHit): string {
  const by = [p.creator && `by ${p.creator}`, p.licence].filter(Boolean).join(', ')
  return `${p.title || 'Picture'}${by ? ` (${by})` : ''}`.slice(0, 120)
}

/** Fetches the picture through the Worker and stores it like an upload. */
/** An Iconify SVG drawn to a 512px PNG in the browser, so it prints and goes into Word like any picture. */
async function svgToPng(url: string): Promise<Blob> {
  // Outline icons draw in currentColor: black on paper.
  const svg = (await (await fetch(pictureSrc(url), { credentials: 'same-origin', headers: headers() })).text()).replace(/currentColor/g, '#000')
  const img = new Image()
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  await img.decode()
  const c = document.createElement('canvas')
  c.width = 512; c.height = 512
  c.getContext('2d')!.drawImage(img, 0, 0, 512, 512)
  URL.revokeObjectURL(img.src)
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('That picture could not be drawn. Choose another.'))), 'image/png'))
}

/** Line art of a library picture (Iconify outline icons are line art already). */
export const isLineIcon = (p: PictureHit) => p.full.startsWith('https://api.iconify.design/')
export async function storePicture(p: PictureHit, outline = false): Promise<ImageAsset> {
  if (outline && !isLineIcon(p)) return uploadImage(await outlineOf(pictureSrc(p.full)), `${creditName(p)} (outline)`.slice(0, 120))
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
