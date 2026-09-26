import type { Router } from '../../router'
import { HttpError, badRequest, created, isUUID, notFound, readJSON } from '../../http'
import { can } from '../../identity'
import { inList, institutionId, resolveScope } from '../admin/common'
import { baseName, deleteObject, dispositionHeaders, extOf, getObject, putObject, refuseSize, serveObject, refuseUpload, sha256, uploadKey } from '../../services/files'

/* Port of files.go and files_local.go. The bytes live in R2 (services/files.ts):
   uploads go to FILES_WRITE, downloads read FILES_WRITE then FILES. */

const MAX_UPLOAD = 16 << 20
const ALLOWED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
const BROADCAST_PURPOSE = new Set(['branding_logo', 'branding_wordmark', 'favicon', 'attachment', 'general', 'study_material',
  'question_paper', 'lesson_plan', 'id_card_front', 'id_card_back', 'signature'])

export function registerFiles(r: Router): void {
  r.post('/files/presign', 'auth', async (c) => {
    institutionId(c)
    const req = await readJSON<{ filename?: string; content_type?: string; size_bytes?: number; purpose?: string }>(c.req)
    const filename = (req.filename ?? '').trim()
    if (filename === '') throw badRequest('filename is required')
    const size = Number(req.size_bytes ?? 0)
    if (!(size > 0) || size > MAX_UPLOAD) throw badRequest('size_bytes must be between 1 and 16777216')
    if (!ALLOWED_TYPES.has(req.content_type ?? '')) throw badRequest('unsupported content_type: ' + (req.content_type ?? ''))
    // A presigned S3 PUT needs R2 API credentials, which the Worker does not hold (it has a
    // binding). Go answers this when it has no store; the web client uploads through POST /files.
    throw new HttpError(503, 'file storage is not configured on this deployment', { code: 'storage_unconfigured' })
  })

  r.post('/files', 'auth', async (c) => {
    const inst = institutionId(c)
    let form: FormData
    try { form = await c.req.formData() } catch { throw badRequest('could not read the upload. Is it larger than 64 MB?') }
    const part = form.get('file') as unknown as File | string | null
    if (!part || typeof part === 'string') throw badRequest("no file was attached under the field name 'file'")
    let original = baseName(part.name.trim())
    if (original === '' || original === '.' || original === '/') original = 'upload'
    const ext = extOf(original).toLowerCase()
    let purpose = String(form.get('purpose') ?? '').trim()
    if (purpose === '') purpose = 'attachment'
    const contentType = part.type.trim() || 'application/octet-stream'
    const refused = refuseUpload(ext, contentType)
    if (refused) throw badRequest(refused)
    const bytes = await part.arrayBuffer()
    const tooBig = refuseSize(bytes.byteLength)
    if (tooBig) throw badRequest(tooBig)
    const fileId = crypto.randomUUID()
    const key = uploadKey(inst, fileId, ext)
    const sum = await sha256(bytes)
    await putObject(c.env, key, bytes, contentType)
    try {
      await c.db.prepare(`INSERT INTO files (id, institution_id, object_key, original_name, content_type, size_bytes, checksum_sha256, purpose, uploaded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(fileId, inst, key, original, contentType, bytes.byteLength, sum, purpose, c.id.userId, new Date().toISOString()).run()
    } catch (e) {
      // A row with no bytes is a broken link; bytes with no row are only waste. Undo the put.
      await deleteObject(c.env, key).catch(() => {})
      throw e
    }
    return created({ file_id: fileId, name: original, size_bytes: bytes.byteLength, content_type: contentType, url: '/api/v1/files/' + fileId })
  })

  r.get('/files/{id}', 'auth', async (c) => {
    institutionId(c)
    if (!isUUID(c.params.id)) throw badRequest('invalid file id')
    const f = await c.db.prepare(`SELECT f.object_key, f.original_name, f.content_type, f.purpose, f.uploaded_by,
        (SELECT student_id FROM student_documents WHERE file_id = f.id LIMIT 1) AS student_owner,
        (SELECT application_id FROM application_documents WHERE file_id = f.id LIMIT 1) AS app_owner,
        (SELECT employee_id FROM employee_documents WHERE file_id = f.id LIMIT 1) AS emp_owner,
        (SELECT homework_id FROM homework_attachments WHERE file_id = f.id LIMIT 1) AS hw_owner
       FROM files f WHERE f.id = ? AND f.deleted_at IS NULL`).bind(c.params.id)
      .first<{ object_key: string; original_name: string; content_type: string; purpose: string; uploaded_by: string | null;
        student_owner: string | null; app_owner: string | null; emp_owner: string | null; hw_owner: string | null }>()
    if (!f) throw notFound('resource not found')
    const gone = notFound('resource not found')
    if (f.student_owner) {
      const sc = await resolveScope(c)
      if (!sc.allStudents) {
        const clauses: string[] = []
        const args: string[] = []
        if (sc.sectionIds.length) { const q = inList(sc.sectionIds); clauses.push(`EXISTS (SELECT 1 FROM enrollments se WHERE se.student_id = st.id AND se.section_id IN ${q.sql})`); args.push(...q.args) }
        if (sc.studentIds.length) { const q = inList(sc.studentIds); clauses.push(`st.id IN ${q.sql}`); args.push(...q.args) }
        if (clauses.length === 0) throw gone
        const okRow = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM students st WHERE st.id = ? AND (${clauses.join(' OR ')})) AS ok`)
          .bind(f.student_owner, ...args).first<{ ok: number }>()
        if (!okRow?.ok) throw gone
      }
    } else if (f.app_owner) {
      if (!can(c.id, 'admissions.read')) throw gone
    } else if (f.emp_owner) {
      if (!can(c.id, 'hr.employees.read')) {
        const self = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM employees WHERE id = ? AND user_id = ?) AS ok`).bind(f.emp_owner, c.id.userId).first<{ ok: number }>()
        if (!self?.ok) throw gone
      }
    } else if (f.hw_owner) {
      const sc = await resolveScope(c)
      if (!(sc.allAttendance || sc.anySection)) {
        let pred: string, args: string[]
        if (sc.sectionIds.length === 0 && sc.studentIds.length > 0) {
          const q = inList(sc.studentIds)
          pred = `hw.section_id IN (SELECT e.section_id FROM enrollments e WHERE e.student_id IN ${q.sql} AND e.status = 'active')`; args = q.args
        } else if (sc.sectionIds.length === 0) throw gone
        else { const q = inList(sc.sectionIds); pred = `hw.section_id IN ${q.sql}`; args = q.args }
        const okRow = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM homework hw WHERE hw.id = ? AND ${pred}) AS ok`).bind(f.hw_owner, ...args).first<{ ok: number }>()
        if (!okRow?.ok) throw gone
      }
    } else if (!BROADCAST_PURPOSE.has(f.purpose)) {
      const self = f.uploaded_by !== null && f.uploaded_by === c.id.userId
      const staff = can(c.id, 'students.read.all') || can(c.id, 'hr.employees.read') || can(c.id, 'finance.fees.read') || can(c.id, 'admissions.read')
      if (!self && !staff) throw gone
    }
    const obj = await getObject(c.env, f.object_key, c.req.headers.has('range') ? c.req.headers : undefined)
    if (!obj) throw notFound('resource not found')
    return serveObject(c.req, obj, {
      'content-type': f.content_type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=300',
      ...dispositionHeaders(f.original_name, f.content_type, c.url.searchParams.get('inline') === '1'),
    })
  })
}
