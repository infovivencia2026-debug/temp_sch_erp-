import type { Router, Ctx } from '../../router'
import { can } from '../../identity'
import { badRequest, conflict, forbidden, isUUID, notFound, now, ok, created, readJSON, uuid } from '../../http'
import { inList, items, js, resolveScope, str } from './common'

/* Question maker: papers written on an A4 page in the browser.

   A paper is a JSON document (a tree of boxes, see web/src/features/qmaker).
   The server keeps it and checks who may see it; it does not read inside it
   beyond making sure it is one, is small enough to keep, and carries no
   pictures inline (pictures are files, uploaded first and named here).

   Drafts belong to the teacher writing them and nobody else sees one. Sending
   a draft for approval copies it onto the exam paper's question_papers row,
   so what the head of department reads and approves is frozen at that moment:
   the teacher can keep editing the draft without changing the approved paper. */

const EXAMS_READ = 'academics.exams.read'
const EXAMS_APPROVE = 'academics.exams.approve'

/** A D1 row tops out near 2 MB; a long paper with no inline pictures is well under this. */
const MAX_DOC_BYTES = 1_500_000
const MAX_TITLE = 200
const MAX_IMAGE_NAME = 120

interface DocShape { body?: { id?: unknown; children?: unknown } }

/** The document as stored: parsed once to prove it is a paper, kept as the text sent. */
function readDoc(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('The paper could not be read. Reload the page and try again.')
  const body = (raw as DocShape).body
  if (!body || typeof body !== 'object' || !Array.isArray(body.children)) throw badRequest('The paper could not be read. Reload the page and try again.')
  const text = JSON.stringify(raw)
  if (text.length > MAX_DOC_BYTES) throw badRequest('This paper is too large to save. Make the pictures in it smaller or split it into two papers.')
  if (text.includes('data:image/')) throw badRequest('A picture in this paper was not uploaded. Remove it and add it again.')
  return text
}

const title = (v: unknown) => String(v ?? '').trim().slice(0, MAX_TITLE)

/** The exam papers (exam_subjects) of the classes the caller teaches, as one inList predicate on cs.class_id. */
async function examSubjectInScope(c: Ctx, esId: string): Promise<boolean> {
  if (c.id.platformAdmin) return true
  const sc = await resolveScope(c)
  const row = await c.db.prepare(`
    SELECT EXISTS (SELECT 1 FROM exam_subjects es JOIN class_subjects cs ON cs.id = es.class_subject_id
      WHERE es.id = ? AND cs.class_id IN (SELECT class_id FROM sections WHERE id IN ${inList(sc.sectionIds)})) AS ok`)
    .bind(esId, js(sc.sectionIds)).first<{ ok: number }>()
  return !!row?.ok
}

function optionalSlot(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (s === '') return null
  if (!isUUID(s)) throw badRequest('Choose which exam paper this is for.')
  return s
}

const DRAFT_COLUMNS = `d.id, d.title, d.exam_subject_id, es.class_subject_id, d.updated_at,
  ex.name AS exam_name, c.name AS class, sub.name AS subject, CAST(es.max_marks AS TEXT) AS max_marks,
  qp.status AS sent_status, qp.review_note`
const DRAFT_JOINS = `
  LEFT JOIN exam_subjects es ON es.id = d.exam_subject_id
  LEFT JOIN exams ex ON ex.id = es.exam_id
  LEFT JOIN class_subjects cs ON cs.id = es.class_subject_id
  LEFT JOIN classes c ON c.id = cs.class_id
  LEFT JOIN subjects sub ON sub.id = cs.subject_id
  LEFT JOIN question_papers qp ON qp.draft_id = d.id`

const draftJSON = (v: Record<string, unknown>) => ({
  id: v.id, title: str(v.title), exam_subject_id: v.exam_subject_id ?? null, class_subject_id: v.class_subject_id ?? null,
  exam_name: v.exam_name ?? null, class: v.class ?? null, subject: v.subject ?? null, max_marks: v.max_marks ?? null,
  updated_at: str(v.updated_at), sent_status: v.sent_status ?? null, review_note: v.review_note ?? null,
})

async function ownDraft(c: Ctx): Promise<Record<string, unknown>> {
  const id = c.params.id
  if (!isUUID(id)) throw notFound('That paper does not exist.')
  const row = await c.db.prepare(`SELECT ${DRAFT_COLUMNS}, d.doc FROM question_paper_drafts d ${DRAFT_JOINS}
     WHERE d.id = ? AND d.created_by = ?`).bind(id, c.id.userId).first<Record<string, unknown>>()
  if (!row) throw notFound('That paper does not exist.')
  return row
}

async function listDrafts(c: Ctx) {
  const rows = await c.db.prepare(`SELECT ${DRAFT_COLUMNS} FROM question_paper_drafts d ${DRAFT_JOINS}
     WHERE d.created_by = ? ORDER BY d.updated_at DESC LIMIT 200`).bind(c.id.userId).all<Record<string, unknown>>()
  return ok(items(rows.results.map(draftJSON)))
}

async function getDraft(c: Ctx) {
  const row = await ownDraft(c)
  return ok({ ...draftJSON(row), doc: JSON.parse(String(row.doc)) })
}

async function createDraft(c: Ctx) {
  const req = await readJSON<{ title?: string; exam_subject_id?: string; doc?: unknown }>(c.req)
  const doc = readDoc(req.doc)
  const slot = optionalSlot(req.exam_subject_id)
  if (slot && !(await examSubjectInScope(c, slot))) throw forbidden('That exam paper is not one of your classes.')
  const id = uuid(), t = now()
  await c.db.prepare(`INSERT INTO question_paper_drafts (id, institution_id, exam_subject_id, title, doc, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, c.id.institution!.id, slot, title(req.title), doc, c.id.userId, t, t).run()
  return created({ id, updated_at: t })
}

/* Saving is last-writer-wins only within one tab. The client sends the
   updated_at it last saw; a different one means another tab or device saved
   in between, and overwriting it would silently lose that work. */
async function saveDraft(c: Ctx) {
  const cur = await ownDraft(c)
  const req = await readJSON<{ title?: string; exam_subject_id?: string | null; doc?: unknown; base_updated_at?: string }>(c.req)
  if (req.base_updated_at && req.base_updated_at !== str(cur.updated_at)) {
    throw conflict('This paper was changed in another window. Reload it to see those changes; what you typed here since has not been saved.')
  }
  const doc = req.doc === undefined ? String(cur.doc) : readDoc(req.doc)
  const slot = req.exam_subject_id === undefined ? (cur.exam_subject_id as string | null) : optionalSlot(req.exam_subject_id)
  if (slot && slot !== cur.exam_subject_id && !(await examSubjectInScope(c, slot))) throw forbidden('That exam paper is not one of your classes.')
  const t = now()
  await c.db.prepare(`UPDATE question_paper_drafts SET title = ?, exam_subject_id = ?, doc = ?, updated_at = ? WHERE id = ? AND created_by = ?`)
    .bind(req.title === undefined ? str(cur.title) : title(req.title), slot, doc, t, cur.id, c.id.userId).run()
  return ok({ id: cur.id, updated_at: t })
}

async function deleteDraft(c: Ctx) {
  const cur = await ownDraft(c)
  await c.db.prepare(`DELETE FROM question_paper_drafts WHERE id = ? AND created_by = ?`).bind(cur.id, c.id.userId).run()
  return ok({ id: cur.id, deleted: true })
}

/* Send for approval: the exam paper's question_papers row takes a frozen copy.
   An approved paper is not replaced from here; the head of department has
   already signed it off, and a new version needs them to send it back first. */
async function sendDraft(c: Ctx) {
  const cur = await ownDraft(c)
  const req = await readJSON<{ exam_subject_id?: string; notes?: string }>(c.req)
  const slot = optionalSlot(req.exam_subject_id ?? cur.exam_subject_id)
  if (!slot) throw badRequest('Choose which exam paper this is for.')
  if (!(await examSubjectInScope(c, slot))) throw forbidden('That exam paper is not one of your classes.')
  const existing = await c.db.prepare(`SELECT status FROM question_papers WHERE exam_subject_id = ?`).bind(slot).first<{ status: string }>()
  if (existing?.status === 'approved') throw conflict('The paper for this exam is already approved. Ask your head of department to send it back before sending a new one.')
  const notes = String(req.notes ?? '').trim().slice(0, 1000)
  const t = now()
  await c.db.batch([
    c.db.prepare(`
      INSERT INTO question_papers (id, institution_id, exam_subject_id, file_id, doc, draft_id, notes, submitted_by, submitted_at, status, created_at)
      VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULLIF(?6, ''), ?7, ?8, 'submitted', ?8)
      ON CONFLICT (exam_subject_id) DO UPDATE SET file_id = NULL, doc = excluded.doc, draft_id = excluded.draft_id, notes = excluded.notes,
        submitted_by = excluded.submitted_by, submitted_at = excluded.submitted_at, status = 'submitted',
        reviewed_by = NULL, reviewed_at = NULL, review_note = NULL`)
      .bind(uuid(), c.id.institution!.id, slot, String(cur.doc), cur.id, notes, c.id.userId, t),
    c.db.prepare(`UPDATE question_paper_drafts SET exam_subject_id = ? WHERE id = ?`).bind(slot, cur.id),
  ])
  return ok({ status: 'submitted' })
}

/* The sent copy, for reading: its teacher, or whoever decides papers for that
   class (the same reach as the Papers list). */
async function sentDoc(c: Ctx) {
  const id = c.params.id
  if (!isUUID(id)) throw notFound('That paper does not exist.')
  const row = await c.db.prepare(`SELECT qp.doc, qp.submitted_by, cs.class_id FROM question_papers qp
      JOIN exam_subjects es ON es.id = qp.exam_subject_id JOIN class_subjects cs ON cs.id = es.class_subject_id
     WHERE qp.id = ?`).bind(id).first<{ doc: string | null; submitted_by: string; class_id: string }>()
  if (!row || !row.doc) throw notFound('That paper does not exist.')
  if (row.submitted_by !== c.id.userId && !c.id.platformAdmin) {
    if (!can(c.id, EXAMS_APPROVE)) throw notFound('That paper does not exist.')
    const sc = await resolveScope(c)
    if (sc.sectionIds.length > 0) {
      const reach = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM sections WHERE class_id = ? AND id IN ${inList(sc.sectionIds)}) AS ok`)
        .bind(row.class_id, js(sc.sectionIds)).first<{ ok: number }>()
      if (!reach?.ok) throw notFound('That paper does not exist.')
    }
  }
  return ok({ doc: JSON.parse(row.doc) })
}

// ---------------------------------------------------------------- pictures

/* By name for the image store, or by id for the pictures a banked question
   uses (its size is needed to print it). */
async function listImages(c: Ctx) {
  const ids = (c.url.searchParams.get('ids') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  if (ids.length > 200 || ids.some((x) => !isUUID(x))) throw badRequest('Ask for at most 200 pictures by id.')
  if (ids.length) {
    const rows = await c.db.prepare(`SELECT file_id, name, width, height FROM question_maker_images WHERE file_id IN ${inList(ids)}`).bind(js(ids)).all()
    return ok(items(rows.results.map((v) => ({ file_id: v.file_id, name: v.name, width: v.width, height: v.height }))))
  }
  const q = (c.url.searchParams.get('q') ?? '').trim()
  const rows = await c.db.prepare(`SELECT file_id, name, width, height FROM question_maker_images
     WHERE ?1 = '' OR name LIKE '%' || ?1 || '%' ORDER BY created_at DESC LIMIT 200`).bind(q.replace(/[%_]/g, '')).all()
  return ok(items(rows.results.map((v) => ({ file_id: v.file_id, name: v.name, width: v.width, height: v.height }))))
}

/* A picture is uploaded through POST /files like any other; this names it and
   records its size, which printing needs to keep its shape. Only the person
   who uploaded it can name it, and only an image. */
async function addImage(c: Ctx) {
  const req = await readJSON<{ file_id?: string; name?: string; width?: number; height?: number }>(c.req)
  const fileId = String(req.file_id ?? '')
  if (!isUUID(fileId)) throw badRequest('Upload the picture first.')
  const w = Math.round(Number(req.width)), h = Math.round(Number(req.height))
  if (!(w > 0 && h > 0 && w <= 20000 && h <= 20000)) throw badRequest('That picture has no size. Upload it again.')
  const name = String(req.name ?? '').trim().slice(0, MAX_IMAGE_NAME) || 'Picture'
  const f = await c.db.prepare(`SELECT content_type, uploaded_by FROM files WHERE id = ? AND deleted_at IS NULL`).bind(fileId).first<{ content_type: string; uploaded_by: string | null }>()
  if (!f || f.uploaded_by !== c.id.userId) throw notFound('Upload the picture first.')
  if (!f.content_type.startsWith('image/')) throw badRequest('Only a picture can go into a paper.')
  await c.db.prepare(`INSERT INTO question_maker_images (file_id, institution_id, name, width, height, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (file_id) DO UPDATE SET name = excluded.name`)
    .bind(fileId, c.id.institution!.id, name, w, h, c.id.userId, now()).run()
  return created({ file_id: fileId, name, width: w, height: h })
}

export function registerQuestionMaker(r: Router): void {
  r.get('/exams/paper-drafts', EXAMS_READ, listDrafts)
  r.post('/exams/paper-drafts', EXAMS_READ, createDraft)
  r.get('/exams/paper-drafts/{id}', EXAMS_READ, getDraft)
  r.put('/exams/paper-drafts/{id}', EXAMS_READ, saveDraft)
  r.del('/exams/paper-drafts/{id}', EXAMS_READ, deleteDraft)
  r.post('/exams/paper-drafts/{id}/send', EXAMS_READ, sendDraft)
  r.get('/exams/question-papers/{id}/doc', EXAMS_READ, sentDoc)
  r.get('/exams/paper-images', EXAMS_READ, listImages)
  r.post('/exams/paper-images', EXAMS_READ, addImage)
}
