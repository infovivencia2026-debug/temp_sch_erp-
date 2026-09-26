import type { Env } from '../env'

/* File storage on R2: the one place the Worker touches object bytes.

   Port of internal/storage and the store half of files_local.go. Two buckets
   until switchover: FILES is the live bucket the Go server wrote (read only
   from here), FILES_WRITE is where every put and delete goes. A read asks
   FILES_WRITE first, so a file uploaded through the Worker is found, then
   FILES, so every file the Go server stored is still served. Nothing in this
   file ever writes or deletes in FILES. */

/** maxLocalUploadBytes in files_local.go. */
export const MAX_UPLOAD_BYTES = 64 << 20

/** blockedUploadExtensions in files_local.go. */
export const BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.scr', '.com', '.bat', '.cmd', '.msi', '.ps1', '.vbs', '.jse',
  '.js', '.jar', '.sh', '.app', '.apk', '.hta', '.cpl', '.reg', '.lnk', '.pif',
  '.html', '.htm', '.xhtml', '.svg', '.xml', '.mht', '.mhtml', '.xsl', '.xslt', '.wasm'])

/** Go's filepath.Base on a slash path. */
export function baseName(p: string): string {
  if (p === '') return '.'
  const t = p.replace(/\/+$/, '')
  if (t === '') return '/'
  return t.slice(t.lastIndexOf('/') + 1)
}

/** Go's filepath.Ext: the suffix from the last dot of the last element. */
export function extOf(p: string): string {
  for (let i = p.length - 1; i >= 0 && p[i] !== '/'; i--) if (p[i] === '.') return p.slice(i)
  return ''
}

/** Why an upload of this name and type is refused, or null. Same messages as uploadFile. */
export function refuseUpload(ext: string, contentType: string): string | null {
  if (BLOCKED_EXTENSIONS.has(ext)) return 'files of type ' + ext + " cannot be uploaded, they are programs, and this is a school's document store"
  const ct = contentType.toLowerCase()
  if (ct.includes('html') || ct.includes('svg') || ct.includes('xml')) return 'web pages and SVG files cannot be uploaded to the document store'
  return null
}

/** Why these bytes are refused (size), or null. putUploadInStore's messages. */
export function refuseSize(n: number): string | null {
  if (n > MAX_UPLOAD_BYTES) return 'that file is larger than 64 MB'
  if (n === 0) return 'that file is empty'
  return null
}

/** Key the Go uploadFile mints: <institution>/<YYYY-MM>/<file id><ext>. */
export function uploadKey(institutionId: string, fileId: string, ext: string, at = new Date()): string {
  const ym = at.toISOString().slice(0, 7)
  return `${institutionId}/${ym}/${fileId}${ext}`
}

export async function sha256(bytes: ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/** Put into the write bucket. */
export async function putObject(env: Env, key: string, body: ArrayBuffer | ReadableStream | string, contentType: string): Promise<void> {
  await env.FILES_WRITE.put(key, body, { httpMetadata: { contentType } })
}

/** Delete from the write bucket only; the live bucket is never touched. */
export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.FILES_WRITE.delete(key)
}

/** Head: write bucket first, then the live one. */
export async function headObject(env: Env, key: string): Promise<R2Object | null> {
  return (await env.FILES_WRITE.head(key)) ?? (await env.FILES.head(key))
}

/** Get (optionally a byte range): write bucket first, then the live one. Null is a miss in both. */
export async function getObject(env: Env, key: string, range?: Headers): Promise<R2ObjectBody | null> {
  const opts: R2GetOptions = range ? { range } : {}
  for (const b of [env.FILES_WRITE, env.FILES]) {
    const obj = await b.get(key, opts)
    if (obj && 'body' in obj) return obj
    if (obj) {
      // An unsatisfiable range still proves the object is here; fetch it whole.
      const whole = await b.get(key)
      if (whole) return whole
    }
  }
  return null
}

/** viewableInline in files_local.go. */
export function viewableInline(contentType: string): boolean {
  const ct = contentType.split(';', 1)[0].trim().toLowerCase()
  return VIEWABLE.has(ct)
}
const VIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/bmp', 'image/avif', 'image/heic', 'image/heif', 'text/plain', 'text/csv', 'text/markdown', 'text/tab-separated-values',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'])

/** Content-Disposition + CSP for a download, as downloadFile sets them. */
export function dispositionHeaders(name: string, contentType: string, inline: boolean): Record<string, string> {
  const safe = name.replace(/["\r\n]/g, '')
  if (inline && viewableInline(contentType)) {
    return {
      'content-disposition': `inline; filename="${safe}"`,
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'",
    }
  }
  return { 'content-disposition': `attachment; filename="${safe}"` }
}

/**
 * storedFile.serve for a bucket object: 200 or 206 with Content-Range,
 * Accept-Ranges, Content-Length, Last-Modified; no body for HEAD.
 * `headers` carries the caller's type/disposition/cache headers.
 */
export function serveObject(req: Request, obj: R2ObjectBody, headers: Record<string, string>): Response {
  const h = new Headers(headers)
  h.set('accept-ranges', 'bytes')
  h.set('last-modified', obj.uploaded.toUTCString())
  let status = 200
  let length = obj.size
  const r = req.headers.has('range') ? obj.range : undefined
  if (r) {
    let offset: number, len: number
    if ('suffix' in r && r.suffix !== undefined) { len = Math.min(r.suffix, obj.size); offset = obj.size - len }
    else { offset = (r as { offset?: number }).offset ?? 0; len = (r as { length?: number }).length ?? obj.size - offset }
    if (offset !== 0 || len !== obj.size) {
      status = 206; length = len
      h.set('content-range', `bytes ${offset}-${offset + len - 1}/${obj.size}`)
    }
  }
  h.set('content-length', String(length))
  if (req.method === 'HEAD') { obj.body.cancel().catch(() => {}); return new Response(null, { status, headers: h }) }
  return new Response(obj.body, { status, headers: h })
}
