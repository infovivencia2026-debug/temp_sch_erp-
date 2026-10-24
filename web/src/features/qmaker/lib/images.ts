import { actingInstitution, api } from '@/lib/api'

/* Pictures in papers and banked questions.

   A picture is a file like any other upload (POST /files), referenced from the
   text by its file id (<img data-id="…">). The paper keeps each picture's
   pixel size beside it, because printing and Word need the shape before the
   bytes arrive; the image store (/exams/paper-images) keeps its name, so a
   teacher can find "leaf cross section" again next term. */

export interface ImageAsset {
  /** The file id. */
  id: string
  /** Natural pixel size, for the aspect ratio. */
  w: number
  h: number
  name?: string
}

export type ImageAlign = 'inline' | 'left' | 'center' | 'right'

export const imgSrc = (a: Pick<ImageAsset, 'id'>) => `/api/v1/files/${a.id}?inline=1`

export const imgType = (bytes: Uint8Array): 'png' | 'jpg' => (bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : 'jpg')

export async function imageBytes(a: Pick<ImageAsset, 'id'>): Promise<Uint8Array> {
  const res = await fetch(imgSrc(a), { credentials: 'same-origin' })
  if (!res.ok) throw new Error('A picture in this paper could not be loaded.')
  return new Uint8Array(await res.arrayBuffer())
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That file is not a picture this browser can read.'))
    img.src = src
  })
}

const MAX_PX = 1400

/* Big photographs and screenshots are scaled down before upload so a paper
   stays quick to open and print. Line diagrams stay PNG (sharp edges); a
   large photograph becomes JPEG. Transparent areas print white. */
async function shrink(blob: Blob): Promise<{ blob: Blob; w: number; h: number; ext: 'png' | 'jpg' }> {
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const scale = Math.min(1, MAX_PX / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    const toBlob = (type: string, q?: number) => new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('The picture could not be prepared.'))), type, q))
    const png = await toBlob('image/png')
    if (png.size <= 500_000) return { blob: png, w, h, ext: 'png' }
    return { blob: await toBlob('image/jpeg', 0.88), w, h, ext: 'jpg' }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Uploads a picture and names it in the image store; returns it ready to insert. */
export async function uploadImage(blob: Blob, name: string): Promise<ImageAsset> {
  const { blob: small, w, h, ext } = await shrink(blob)
  const form = new FormData()
  const base = name.replace(/[^\w .-]+/g, ' ').trim().slice(0, 80) || 'picture'
  form.append('file', new File([small], `${base}.${ext}`, { type: ext === 'png' ? 'image/png' : 'image/jpeg' }))
  form.append('purpose', 'question_paper')
  const acting = actingInstitution()
  const res = await fetch('/api/v1/files', {
    method: 'POST', body: form, credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(acting ? { 'X-Acting-Institution': acting } : {}) },
  })
  if (res.status !== 201) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? 'The picture could not be uploaded. Check the connection and try again.')
  }
  const { file_id } = (await res.json()) as { file_id: string }
  const named = await api.post<{ file_id: string; name: string; width: number; height: number }>('/api/v1/exams/paper-images', { file_id, name, width: w, height: h })
  return { id: named.file_id, w: named.width, h: named.height, name: named.name }
}

interface StoredImage { file_id: string; name: string; width: number; height: number }
const asAsset = (v: StoredImage): ImageAsset => ({ id: v.file_id, w: v.width, h: v.height, name: v.name })

/** The image store, searched by name. */
export async function searchImages(q: string): Promise<ImageAsset[]> {
  const r = await api.get<{ items: StoredImage[] }>(`/api/v1/exams/paper-images?q=${encodeURIComponent(q)}`)
  return r.items.map(asAsset)
}

/** Sizes and names of the pictures some boxes use (a banked question carries only their ids). */
export async function lookupImages(ids: Iterable<string>): Promise<Record<string, ImageAsset>> {
  const all = [...new Set(ids)]
  const out: Record<string, ImageAsset> = {}
  for (let i = 0; i < all.length; i += 200) {
    const r = await api.get<{ items: StoredImage[] }>(`/api/v1/exams/paper-images?ids=${all.slice(i, i + 200).join(',')}`)
    for (const v of r.items) out[v.file_id] = asAsset(v)
  }
  return out
}

/** Default print width: small icons stay small, big pictures are capped. */
export function defaultWidthMm(a: Pick<ImageAsset, 'w'>) {
  const naturalMm = (a.w / 96) * 25.4
  return Math.round(Math.min(70, Math.max(20, naturalMm)))
}

/** Every picture id referenced anywhere inside a value (strings, arrays, objects). */
export function collectImageIds(value: unknown, out = new Set<string>()) {
  if (typeof value === 'string') for (const m of value.matchAll(/data-id="([A-Za-z0-9-]+)"/g)) out.add(m[1])
  else if (Array.isArray(value)) value.forEach((v) => collectImageIds(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectImageIds(v, out))
  return out
}
