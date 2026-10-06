import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { shrinkImage } from '@/lib/shrink-image'

/* Class Status on the web side: the feed, the upload, the shapes the other
   /status routes answer with (worker/src/routes/comms/class_status.ts).

   The feed is keyed under 'notifications' on purpose. A new status writes a
   bell entry, and both the live socket (lib/live-stream.ts) and the 30s
   revision poll (lib/live.ts) already invalidate ['notifications'] when one
   arrives; sharing the prefix brings the rings along for free. */

export const FEED_KEY = ['notifications', 'class-status-feed'] as const

export function useStatusFeed(enabled = true) {
  return useQuery({
    queryKey: FEED_KEY,
    queryFn: () => api.call('GET /status/feed'),
    enabled,
    staleTime: 30_000,
  })
}

export interface Audiences {
  sections: { id: string; name: string; class_id: string }[]
  classes: { id: string; name: string }[]
  can_post_school: boolean
  wide: boolean
  allow_video: boolean
  max_video_seconds: number
  needs_approval: boolean
  max_bytes: number
  storage_warning?: string
}

export interface MyPost {
  id: string; as_school: boolean; media_kind: 'photo' | 'video' | 'text'; content_type: string; caption?: string | null; thumb?: string
  status: 'live' | 'pending' | 'rejected'; pinned: boolean; created_at: string; published_at?: string | null
  expires_at?: string | null; views: number; audience: string; url: string
}

export interface AdminPost extends MyPost {
  posted_by: string; poster_name: string; audience_size: number; seen_pct: number
}

export interface StatusSettings {
  enabled: boolean; needs_approval: boolean; who: 'teachers' | 'class_teachers' | 'admins'
  allow_video: boolean; max_video_seconds: number; chosen?: boolean
}

export interface Viewed {
  user_id: string; full_name: string; viewed_at: string; student_name?: string | null; kind: 'parent' | 'student' | 'staff'
}

export type TargetPick = { kind: 'school' | 'staff' | 'class' | 'section'; id?: string }

export const MAX_BYTES = 25 << 20

/** How long a picked video runs, read from its metadata; 0 when the browser cannot tell. */
export function videoSeconds(f: File): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    const url = URL.createObjectURL(f)
    const done = (n: number) => { URL.revokeObjectURL(url); resolve(n) }
    v.preload = 'metadata'
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : 0)
    v.onerror = () => done(0)
    v.src = url
  })
}

/** A photo is redrawn at 1600px, JPEG 0.82, before it leaves the phone. */
export async function preparePhoto(f: File): Promise<File> {
  return shrinkImage(f, 1600, 0.82)
}

/* THE THUMBNAIL the bell and the strip show, drawn here so the server never
   decodes media: a photo scaled to ~320px, a video's frame at 0.1s. JPEG
   0.7, a few KB. Null when the browser cannot draw it (an unplayable codec,
   a tainted canvas); the bell then shows the type icon. */
const THUMB_PX = 320

function canvasJpeg(src: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  if (!w || !h) return Promise.resolve(null)
  const k = Math.min(1, THUMB_PX / Math.max(w, h))
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(w * k))
  cv.height = Math.max(1, Math.round(h * k))
  const g = cv.getContext('2d')
  if (!g) return Promise.resolve(null)
  g.drawImage(src, 0, 0, cv.width, cv.height)
  return new Promise((resolve) => {
    try { cv.toBlob((b) => resolve(b), 'image/jpeg', 0.7) } catch { resolve(null) }
  })
}

export function makeThumb(f: File): Promise<Blob | null> {
  const url = URL.createObjectURL(f)
  const done = <T,>(v: T) => { URL.revokeObjectURL(url); return v }
  if (f.type.startsWith('image/')) {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => void canvasJpeg(img, img.naturalWidth, img.naturalHeight).then((b) => resolve(done(b)), () => resolve(done(null)))
      img.onerror = () => resolve(done(null))
      img.src = url
    })
  }
  if (!f.type.startsWith('video/')) return Promise.resolve(done(null))
  return new Promise((resolve) => {
    const v = document.createElement('video')
    let settled = false
    const finish = (b: Blob | null) => { if (!settled) { settled = true; resolve(done(b)) } }
    const timer = setTimeout(() => finish(null), 5000)
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.onloadeddata = () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2) } catch { finish(null) } }
    v.onseeked = () => { clearTimeout(timer); void canvasJpeg(v, v.videoWidth, v.videoHeight).then(finish, () => finish(null)) }
    v.onerror = () => { clearTimeout(timer); finish(null) }
    v.src = url
  })
}

export async function postStatus(p: { file?: File | null; text?: boolean; thumb?: Blob | null; caption: string; targets: TargetPick[]; asSchool: boolean; duration?: number }): Promise<{ id: string; status: string }> {
  const fd = new FormData()
  if (p.text) fd.append('kind', 'text')
  else if (p.file) fd.append('file', p.file)
  if (p.thumb) fd.append('thumb', p.thumb, 'thumb.jpg')
  fd.append('caption', p.caption)
  fd.append('targets', JSON.stringify(p.targets))
  if (p.asSchool) fd.append('as_school', '1')
  if (p.duration) fd.append('duration_seconds', String(p.duration))
  const res = await fetch('/api/v1/status/posts', { method: 'POST', body: fd, credentials: 'same-origin' })
  if (!res.ok) {
    let msg = 'Could not post that status.'
    try { msg = (await res.json()).error ?? msg } catch { /* not JSON */ }
    throw new Error(msg)
  }
  return res.json()
}

/** How a status was started from the Add chooser. */
export type AddMode = 'photo' | 'video' | 'camera' | 'text'

export const fileUrl = (key?: string | null) => (key ? `/api/v1/files/${key}?inline=1` : undefined)

export function hoursLeft(iso?: string | null): string {
  if (!iso) return ''
  const h = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000)
  return h <= 0 ? 'ending' : `${h} h left`
}
