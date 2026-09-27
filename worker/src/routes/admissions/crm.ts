import type { Router } from '../../router'
import { badRequest, created, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { istDate, isYMD, nz, str } from './util'

/* The admissions CRM's lead record: one enquiry with its timeline (calls,
   WhatsApps, notes, visits, stage changes), the other enquiries that share its
   phone number, and the application it became. Plus the phone-number lookup
   the walk-in form runs before saving, so the same family is not logged twice. */

const READ = 'admissions.read', WRITE = 'admissions.write'
export const ACTIVITY_KINDS = ['call', 'whatsapp', 'note', 'visit'] as const

/** The last ten digits: "+91 98480 12345", "098480-12345" and "9848012345" are one number. */
export function phoneKey(phone: string): string {
  const d = phone.replace(/\D/g, '')
  return d.length > 10 ? d.slice(-10) : d
}
// The same normalisation in SQL, for the stored numbers (spaces, dashes, plus, brackets, dots).
const phoneKeySQL = (col: string) =>
  `substr(replace(replace(replace(replace(replace(replace(${col}, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', ''), -10)`

/** One timeline row, as a statement to run or batch. */
export function activityStmt(db: D1Database, inst: string, enquiryID: string, kind: string,
  f: { body?: string | null; from?: string | null; to?: string | null; follow?: string | null; author?: string | null; at?: string } = {}): D1PreparedStatement {
  return db.prepare(`INSERT INTO enquiry_activities (id, institution_id, enquiry_id, kind, body, from_status, to_status, next_follow_up, author_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(uuid(), inst, enquiryID, kind, f.body ?? null, f.from ?? null, f.to ?? null, f.follow ?? null, f.author ?? null, f.at ?? now())
}

export async function duplicatesOf(db: D1Database, phone: string, except: string | null) {
  const key = phoneKey(phone)
  if (key.length < 6) return []
  const rows = await db.prepare(`
    SELECT e.id, e.student_name, e.parent_name, e.phone, e.status, ${istDate('e.created_at')} AS created_at
      FROM enquiries e
     WHERE ${phoneKeySQL('e.phone')} = ? AND (? IS NULL OR e.id <> ?)
     ORDER BY e.created_at DESC LIMIT 10`).bind(key, except, except).all<Record<string, unknown>>()
  return rows.results
}

export function registerAdmissionsCRM(r: Router) {
  // Literal paths before {id}.
  r.get('/admissions/workflow/enquiries/duplicates', READ, async (c) => {
    const phone = str(c.url.searchParams.get('phone'))
    return ok({ items: await duplicatesOf(c.db, phone, nz(c.url.searchParams.get('except'))) })
  })

  r.get('/admissions/workflow/enquiries/{id}', READ, async (c) => {
    const id = uuidParam(c.params.id)
    const e = await c.db.prepare(`
      SELECT e.id, e.student_name, e.parent_name, e.phone, e.email, e.class_sought AS class_id, cl.name AS class_name,
             e.source, e.campaign, e.referred_by, e.status, e.next_follow_up, e.notes, e.lost_reason, e.lost_reason_note,
             e.assigned_to AS assigned_to_id, u.full_name AS assigned_to, e.marketing_opt_out,
             ${istDate('e.created_at')} AS created_at, e.last_contacted_at
        FROM enquiries e LEFT JOIN classes cl ON cl.id = e.class_sought LEFT JOIN users u ON u.id = e.assigned_to
       WHERE e.id = ?`).bind(id).first<Record<string, unknown>>()
    if (!e) throw notFound('no such enquiry')
    const acts = await c.db.prepare(`
      SELECT a.id, a.kind, a.body, a.from_status, a.to_status, a.next_follow_up, u.full_name AS author, a.created_at
        FROM enquiry_activities a LEFT JOIN users u ON u.id = a.author_id
       WHERE a.enquiry_id = ? ORDER BY a.created_at DESC LIMIT 200`).bind(id).all<Record<string, unknown>>()
    const app = await c.db.prepare(`SELECT id, application_no, status, student_id FROM applications WHERE enquiry_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(id).first<Record<string, unknown>>()
    return ok({
      enquiry: { ...e, marketing_opt_out: !!e.marketing_opt_out },
      activities: acts.results,
      duplicates: await duplicatesOf(c.db, String(e.phone ?? ''), id),
      application: app ?? null,
    })
  })

  /* Log a touch: a call made, a WhatsApp sent, a note, a visit. A call or a
     message on a lead still at "new" moves it to "contacted", since that is
     what the stage means; the follow-up date given here replaces the old one. */
  r.post('/admissions/workflow/enquiries/{id}/activities', WRITE, async (c) => {
    const id = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const kind = str(req.kind)
    if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) throw badRequest('kind must be one of: ' + ACTIVITY_KINDS.join(', '))
    const body = str(req.body).trim().slice(0, 2000)
    if (kind === 'note' && body === '') throw badRequest('write the note')
    const follow = nz(req.next_follow_up)
    if (follow !== null && !isYMD(follow)) throw badRequest('next_follow_up must be YYYY-MM-DD')
    const e = await c.db.prepare(`SELECT status FROM enquiries WHERE id = ?`).bind(id).first<{ status: string }>()
    if (!e) throw notFound('no such enquiry')
    const t = now()
    const touch = kind !== 'note'
    const moveTo = touch && e.status === 'new' ? 'contacted' : null
    const inst = c.id.institution!.id
    const stmts: D1PreparedStatement[] = [
      activityStmt(c.db, inst, id, kind, { body: body || null, follow, author: c.id.userId, at: t }),
      c.db.prepare(`UPDATE enquiries SET next_follow_up = COALESCE(?, next_follow_up), status = COALESCE(?, status),
          last_contacted_at = CASE WHEN ? THEN ? ELSE last_contacted_at END, updated_at = ? WHERE id = ?`)
        .bind(follow, moveTo, touch ? 1 : 0, t, t, id),
    ]
    if (moveTo) stmts.push(activityStmt(c.db, inst, id, 'stage', { from: e.status, to: moveTo, author: c.id.userId, at: t }))
    await c.db.batch(stmts)
    return created({ id, kind, status: moveTo ?? e.status, next_follow_up: follow })
  })
}
