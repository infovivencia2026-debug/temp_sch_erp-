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
const ICON_SETS = 'noto,fluent-emoji-flat,twemoji,openmoji,emojione,fxemoji,noto-v1,game-icons,healthicons'
const ICON_LICENCE: Record<string, string> = { noto: 'Apache 2.0', 'noto-v1': 'Apache 2.0', 'fluent-emoji-flat': 'MIT', twemoji: 'CC BY 4.0', openmoji: 'CC BY-SA 4.0', emojione: 'CC BY 4.0', fxemoji: 'CC BY 4.0', 'game-icons': 'CC BY 3.0', healthicons: 'MIT' }
async function iconSearch(q: string, signal?: AbortSignal): Promise<PictureHit[]> {
  try {
    const res = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&prefixes=${ICON_SETS}&limit=64`, { credentials: 'omit', referrerPolicy: 'no-referrer', signal })
    if (!res.ok) return []
    const body = (await res.json()) as { icons?: string[] }
    return (body.icons ?? []).map((id) => {
      const [set, name] = id.split(':')
      const url = `https://api.iconify.design/${set}/${name}.svg`
      return { thumb: url, full: url, title: name.replace(/-/g, ' '), creator: set, licence: ICON_LICENCE[set] ?? '', source: `https://icon-sets.iconify.design/${set}/${name}/` }
    })
  } catch (e) {
    if (signal?.aborted) throw e
    return []
  }
}

export async function searchPictures(q: string, kind: PictureKind, signal?: AbortSignal): Promise<PictureResult> {
  const [icons, more] = await Promise.all([iconSearch(q, signal), searchLibrary(q, kind, signal).catch((e) => { if (signal?.aborted) throw e; return null })])
  const items = [...icons, ...(more?.items ?? [])]
  return { q, kind, items, unavailable: !items.length && !!more?.unavailable }
}

async function searchLibrary(q: string, kind: PictureKind, signal?: AbortSignal): Promise<PictureResult> {
  const direct = await browserSearch(q, kind, signal)
  if (direct) return direct
  const res = await fetch(`/api/v1/exams/picture-search?q=${encodeURIComponent(q)}&kind=${kind}`, { credentials: 'same-origin', headers: headers(), signal })
  if (!res.ok) throw new Error('Pictures could not be searched. Check the connection and try again.')
  return (await res.json()) as PictureResult
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
  const svg = await (await fetch(url, { credentials: 'omit' })).text()
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

const KEY = 'qm.pictureSuggestions'
export function suggestionsOn(): boolean {
  try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}
export function setSuggestionsOn(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* private window: only this visit */ }
}
