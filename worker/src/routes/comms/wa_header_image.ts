import type { Env } from '../../env'
import type { Router } from '../../router'
import { HttpError, badRequest, created } from '../../http'
import { institutionId } from '../admin/common'
import { deleteObject, getObject, putObject, serveObject, sha256, uploadKey } from '../../services/files'
import { institutionById, tenantDb } from '../../tenant'
import { constantTimeEqual, goNotFound } from './public_common'

/* Header pictures for Yajur Connect templates. Meta fetches the picture from a
   public https link, so an upload here gets one: /api/v1/public/wa-image/
   <school>/<file>/<expiry>/<sig>.<ext>, where sig is an HMAC under
   SESSION_SECRET of all three. Read only, one file per link, no listing; a
   wrong or expired signature is a plain 404. Only files with purpose
   wa_header are served, so no other upload can be reached this way. */

const PURPOSE = 'wa_header'
const MAX_BYTES = 5 << 20
const LIFETIME_S = 60 * 24 * 3600
const TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png' }
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PATH = new RegExp(`^/api/v1/public/wa-image/(${UUID})/(${UUID})/(\\d{1,12})/([0-9a-f]{40})\\.(jpg|png)$`)

export async function sign(secret: string, inst: string, file: string, exp: number): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`wa-image:${inst}:${file}:${exp}`)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
}

const secretOf = (env: Env) => (typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET.trim() : '')

/** JPEG (FF D8 FF) or PNG (89 50 4E 47) by its first bytes, whatever the browser claimed. */
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  return null
}

export function registerWaHeaderImage(r: Router, perm: string): void {
  r.post('/comms/yajur-connect/send/image', perm, async (c) => {
    const inst = institutionId(c)
    const secret = secretOf(c.env)
    if (!secret) throw new HttpError(409, 'SESSION_SECRET is not set on this server, so a public picture link cannot be made')
    let form: FormData
    try { form = await c.req.formData() } catch { throw badRequest('could not read the upload') }
    const part = form.get('file') as unknown as File | string | null
    if (!part || typeof part === 'string') throw badRequest("no file was attached under the field name 'file'")
    if (part.size > MAX_BYTES) throw badRequest('the picture must be 5 MB or smaller')
    const bytes = await part.arrayBuffer()
    if (bytes.byteLength === 0) throw badRequest('that file is empty')
    const type = sniff(new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength)))
    if (!type) throw badRequest('only a JPEG or PNG picture can be used')
    const ext = TYPES[type]
    const fileId = crypto.randomUUID()
    const key = uploadKey(inst, fileId, ext)
    const name = (part.name || 'picture').slice(0, 200)
    await putObject(c.env, key, bytes, type)
    try {
      await c.db.prepare(`INSERT INTO files (id, institution_id, object_key, original_name, content_type, size_bytes, checksum_sha256, purpose, uploaded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(fileId, inst, key, name, type, bytes.byteLength, await sha256(bytes), PURPOSE, c.id.userId, new Date().toISOString()).run()
    } catch (e) { await deleteObject(c.env, key).catch(() => {}); throw e }
    const exp = Math.floor(Date.now() / 1000) + LIFETIME_S
    const url = `${new URL(c.req.url).origin}/api/v1/public/wa-image/${inst}/${fileId}/${exp}/${await sign(secret, inst, fileId, exp)}${ext}`
    return created({ file_id: fileId, name, size_bytes: bytes.byteLength, content_type: type, url })
  })
}

/** GET of a signed header-picture link; null when the path is not one. */
export async function servePublicWaImage(env: Env, req: Request, p: string): Promise<Response | null> {
  if (p !== '/api/v1/public/wa-image' && !p.startsWith('/api/v1/public/wa-image/')) return null
  if (req.method !== 'GET' && req.method !== 'HEAD') return goNotFound()
  const m = PATH.exec(p)
  const secret = secretOf(env)
  if (!m || !secret) return goNotFound()
  const [, inst, file, expS, sig, ext] = m
  const exp = Number(expS)
  if (exp * 1000 < Date.now()) return goNotFound()
  if (!constantTimeEqual(await sign(secret, inst, file, exp), sig)) return goNotFound()
  const school = await institutionById(env, inst)
  if (!school) return goNotFound()
  const f = await tenantDb(env, school).prepare(`SELECT object_key, content_type FROM files WHERE id = ? AND purpose = ? AND deleted_at IS NULL`)
    .bind(file, PURPOSE).first<{ object_key: string; content_type: string }>()
  if (!f || TYPES[f.content_type] !== '.' + ext) return goNotFound()
  const obj = await getObject(env, f.object_key, req.headers.has('range') ? req.headers : undefined)
  if (!obj) return goNotFound()
  return serveObject(req, obj, {
    'content-type': f.content_type, 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=86400',
    'content-disposition': 'inline', 'content-security-policy': "default-src 'none'; sandbox",
  })
}
