import { actingInstitution } from '@/lib/api'
import type { PictureHit, PictureKind } from '@shared/picture-search'
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

export async function searchPictures(q: string, kind: PictureKind, signal?: AbortSignal): Promise<PictureResult> {
  const res = await fetch(`/api/v1/exams/picture-search?q=${encodeURIComponent(q)}&kind=${kind}`, { credentials: 'same-origin', headers: headers(), signal })
  if (!res.ok) throw new Error('Pictures could not be searched. Check the connection and try again.')
  return (await res.json()) as PictureResult
}

/** The Worker's copy of a library picture, for an <img src>. */
export const pictureSrc = (u: string) => `/api/v1/exams/picture-search/image?u=${encodeURIComponent(u)}`

/** The name it is kept under in the image store: what it is, and whose. */
export function creditName(p: PictureHit): string {
  const by = [p.creator && `by ${p.creator}`, p.licence].filter(Boolean).join(', ')
  return `${p.title || 'Picture'}${by ? ` (${by})` : ''}`.slice(0, 120)
}

/** Fetches the picture through the Worker and stores it like an upload. */
export async function storePicture(p: PictureHit): Promise<ImageAsset> {
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
