import type { Router, Ctx } from '../../router'
import { enqueueMessageSends, longDateIST } from '../../services/messaging'
import { HttpError, badRequest, bool, created, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { familyChildren, institutionId, marks, js, notYourChild, notifyStmt, ownsStudent, portalChild, requirePerm, resolveScope, str, todayIST } from '../teaching/common'
import { SchoolPDF, schoolFacts, logoBytes, inr as docINR } from '../../services/document'
import { publish } from '../../services/live'
import { feedbackUpdateStmt } from '../comms/grievances'
import { canReopen, dueAt, notify, ownAttachment, policyFor, ticketStage } from '../comms/concern_shared'

/* Port of internal/api/portal_requests.go (mountParentPortal): what a family
   asks the school for, and what the school owes them back. Every route sits
   under /portal (self.profile.read, which every role holds), so the only lock
   is the ownership check in each handler: resolveScope, then ownsStudent on
   the id the caller sent. There is deliberately no students.read.all escape. */

const PORTAL = 'self.profile.read'
const FRONT_DESK_WRITE = 'office.front_desk.write'

// ---------------------------------------------------------------------------
// local helpers

/** httpx.Error(w, r, status, code, msg). */
const coded = (status: number, code: string, msg: string) => new HttpError(status, msg, { code })
const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** A JSON string field as Go decoded it: untrimmed, '' when absent. */
const raw = (v: unknown): string => (typeof v === 'string' ? v : '')
const nz = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

/** concat_ws(' ', a.first_name, a.last_name). */
const nameFL = (a: string) => `(${a}.first_name || COALESCE(' ' || ${a}.last_name, ''))`
/** Stored UTC timestamp rendered as the Go side's to_char(...) under Asia/Kolkata. */
const IST = `'+330 minutes'`
const istMinute = (col: string) => `strftime('%Y-%m-%dT%H:%M', ${col}, ${IST})`
const istDate = (col: string) => `date(${col}, ${IST})`

/** to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'. */
const isoZ = (t: unknown): string | null => {
  if (typeof t !== 'string' || t === '') return null
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return t
  return d.toISOString().slice(0, 19) + 'Z'
}

/** Strict YYYY-MM-DD, as time.Parse(time.DateOnly) accepts it. */
function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
function shiftDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z')
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10)
}

/** Some-or-none for a Go pointer field tagged omitempty. */
function put(o: Record<string, unknown>, key: string, v: unknown): void {
  if (v !== null && v !== undefined) o[key] = v
}

// ---------------------------------------------------------------------------
// registration

export function registerPortalRequests(r: Router): void {
  // Leave and absence. There is no POST /leave here on purpose: the workflow
  // endpoint is the one writer of student leave applications.
  r.get('/portal/leave', PORTAL, listPortalLeave)
  r.post('/portal/leave/{id}/cancel', PORTAL, cancelPortalLeave)
  r.post('/portal/absence', PORTAL, reportChildAbsence)

  // Delegated pickup. The gate's two routes are registered before the
  // family's {id} routes and carry the front desk's permission on top.
  r.get('/portal/pickup/verify', PORTAL, verifyPickup)
  r.get('/portal/pickup', PORTAL, listPickupAuthorisations)
  r.post('/portal/pickup', PORTAL, authorisePickup)
  r.post('/portal/pickup/{id}/revoke', PORTAL, revokePickup)
  r.post('/portal/pickup/{id}/release', PORTAL, releasePickup)

  // Concerns and messages.
  r.get('/portal/concerns', PORTAL, listPortalConcerns)
  r.get('/portal/concern-recipients', PORTAL, listConcernRecipients)
  r.post('/portal/concerns', PORTAL, raisePortalConcern)
  r.get('/portal/messages/teachers', PORTAL, listReachableTeachers)
  r.get('/portal/messages', PORTAL, listPortalMessages)
  r.post('/portal/messages', PORTAL, sendPortalMessage)

  // Fee receipts.
  r.get('/portal/receipts', PORTAL, listPortalReceipts)
  r.get('/portal/receipts/{id}', PORTAL, getPortalReceipt)
  r.get('/portal/receipts/{id}/pdf', PORTAL, portalReceiptPDF)

  // Certificates and documents.
  r.get('/portal/requests/types', PORTAL, listPortalRequestTypes)
  r.get('/portal/requests', PORTAL, listPortalRequests)
  r.post('/portal/requests', PORTAL, raisePortalRequest)
  r.get('/portal/documents', PORTAL, listPortalDocuments)
}

// ---------------------------------------------------------------------------
// leave and absence

async function listPortalLeave(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  if (s.studentIds.length === 0) return ok({ items: [] })
  const rows = await c.db.prepare(`
    SELECT lr.id, lr.student_id, ${nameFL('st')} AS student_name,
           lr.from_date, lr.to_date, lr.days, lr.is_half_day, lr.reason, lr.status,
           lr.decision_note, u.full_name AS decided_by,
           ${istMinute('lr.decided_at')} AS decided_at,
           ${istDate('lr.created_at')} AS applied_on,
           (lr.status = 'pending') AS cancellable
      FROM leave_requests lr
      JOIN students st ON st.id = lr.student_id
      LEFT JOIN users u ON u.id = lr.decided_by
     WHERE lr.subject_kind = 'student' AND lr.student_id IN (${marks(s.studentIds)})
     ORDER BY lr.from_date DESC, lr.created_at DESC
     LIMIT 200`).bind(js(s.studentIds)).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => {
    const o: Record<string, unknown> = {
      id: v.id, student_id: v.student_id, student_name: v.student_name ?? '',
      from_date: String(v.from_date).slice(0, 10), to_date: String(v.to_date).slice(0, 10),
      days: nz(v.days), is_half_day: bool(v.is_half_day), reason: v.reason, status: v.status,
    }
    put(o, 'decision_note', v.decision_note)
    put(o, 'decided_by', v.decided_by)
    put(o, 'decided_at', v.decided_at)
    o.applied_on = v.applied_on
    o.cancellable = bool(v.cancellable)
    return o
  }) })
}

/** Withdraws a pending application; either guardian of the child may. */
async function cancelPortalLeave(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  const leaveID = c.params.id
  if (!isUUID(leaveID)) throw badRequest('invalid leave id')
  if (s.studentIds.length === 0) throw notFound()
  const res = await c.db.prepare(`
    UPDATE leave_requests SET status = 'cancelled'
     WHERE id = ? AND subject_kind = 'student'
       AND student_id IN (${marks(s.studentIds)}) AND status = 'pending'`)
    .bind(leaveID, js(s.studentIds)).run()
  if (!res.meta.changes) throw coded(409, 'not_pending', 'that application has already been decided or withdrawn')
  return ok({ status: 'cancelled' })
}

/** One tap on the morning a child wakes up ill: today, or up to a week back. */
/* WHO IS TOLD WHEN A CHILD IS OFF.
 *
 * Nobody was, until now. Reporting an absence or applying for leave wrote a
 * pending row and stopped: if no member of staff happened to open the leave
 * list, the reason a parent had typed at seven in the morning sat in a table
 * and the child was marked absent-unexplained. From the family's side that is
 * indistinguishable from the message never having been sent.
 *
 * It goes to the people who act on it, which is not a question a parent should
 * be asked. First the class teacher -- they mark the register, and an absence
 * they do not know about becomes an unexplained one. Then whoever chases
 * absentees by telephone, because a parent who told the school at seven and is
 * rung at ten to be asked why is a school that looks careless.
 *
 * The head is deliberately not on this list. Forty of these a day is not a
 * thing anybody runs a school by reading, and the pattern is already on their
 * dashboard.
 */
async function attendanceOwners(c: Ctx, studentId: string): Promise<string[]> {
  const rows = await c.db.prepare(`
    SELECT DISTINCT u.id
      FROM users u
     WHERE u.status = 'active' AND (
       /* the class teacher of the section this child is enrolled in */
       u.id = (SELECT sec.class_teacher_id FROM enrollments e
                 JOIN sections sec ON sec.id = e.section_id
                WHERE e.student_id = ?1 AND e.status = 'active'
                ORDER BY e.enrolled_on DESC LIMIT 1)
       /* or whoever chases absentees: the permission that names the errand,
          not a role key, so a school that renamed its roles still routes. */
       /* and the institution admin and the principal (the owner's rule) */
       OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND r.key IN ('institution_admin', 'principal'))
     )`).bind(studentId).all<{ id: string }>().catch(() => null)
  return (rows?.results ?? []).map((r) => r.id).filter(Boolean)
}

async function reportChildAbsence(c: Ctx): Promise<Response> {
  const body = await readJSON<Record<string, unknown>>(c.req)
  const { studentId: sid } = await portalChild(c, raw(body.student_id))
  const reason = str(body.reason)
  if (reason === '') throw badRequest('say why. An absence with no reason is still an unexplained absence')

  const today = todayIST()
  let on = today
  const asked = raw(body.on_date)
  if (asked.trim() !== '') {
    if (!validDate(asked)) throw badRequest('on_date must be YYYY-MM-DD')
    on = asked
  }
  if (on > today) throw badRequest('this button is for today. To book a day off ahead, apply for leave')
  if (on < shiftDays(today, -7)) throw badRequest('that is more than a week ago. The office has to amend the register by hand now')

  /* THE OFFICE MAY HAVE RECORDED IT ALREADY.

     The school rings round its absentees, and when a parent says on the
     telephone that the child is ill with a reason, the office writes that
     against the register there and then. The parent was still asked to apply,
     and the application went into the leave list as a second, pending copy of
     a fact the school had already established -- something for a teacher to
     open, read and approve, about a day that was settled at nine in the
     morning.

     So a day already marked absent WITH a reason on it is answered as done
     rather than filed again. Marked absent with no reason is not: that is
     precisely the day the school is waiting to hear about, and is the whole
     point of this button.

     Present, late or on a holiday is left alone. A parent reporting an
     absence on a day the child was marked present is telling the school
     something it does not know, and that must reach somebody. */
  const already = await c.db.prepare(`
    SELECT COALESCE(sa.remarks, '') AS remarks
      FROM student_attendance sa
     WHERE sa.student_id = ? AND sa.on_date = ? AND sa.status = 'absent'
     ORDER BY (COALESCE(sa.remarks, '') <> '') DESC LIMIT 1`)
    .bind(sid, on).first<{ remarks: string }>().catch(() => null)
  if (already && already.remarks.trim() !== '') {
    return ok({
      already_recorded: true,
      on_date: on,
      recorded_reason: already.remarks,
      note: 'The school has already recorded this absence, with the reason you gave the office. '
        + 'There is nothing more to do for this day.',
    })
  }

  // The clash check and the insert are one statement, so two taps cannot both land.
  const newID = uuid()
  let res: D1Result
  try {
    res = await c.db.prepare(`
      INSERT INTO leave_requests
          (id, institution_id, subject_kind, student_id, from_date, to_date,
           is_half_day, days, reason, status, applied_by, created_at)
      SELECT ?, ?, 'student', ?, ?, ?, 0, '1', ?, 'pending', ?, ?
       WHERE NOT EXISTS (
           SELECT 1 FROM leave_requests
            WHERE subject_kind = 'student' AND student_id = ?
              AND status IN ('pending','approved')
              AND ? BETWEEN from_date AND to_date)`)
      .bind(newID, institutionId(c), sid, on, on, reason, c.id.userId, now(), sid, on).run()
  } catch (e) {
    throw badRequest(errMsg(e))
  }
  if (!res.meta.changes) throw coded(409, 'already_reported', 'that day is already covered by an application')

  const who = await c.db.prepare(`SELECT ${nameFL('st')} AS name FROM students st WHERE st.id = ?`)
    .bind(sid).first<{ name: string }>().catch(() => null)
  const told = await attendanceOwners(c, sid)
  if (told.length) {
    await c.db.batch(told.map((uid) => notifyStmt(
      c, uid, sid, 'attendance.absence_reported',
      `${who?.name ?? 'A child'} is absent today`,
      reason.slice(0, 200),
      '/faculty/attendance/absentee_followup',
      'leave_request', newID,
    ))).catch(() => { /* the absence is recorded; a failed bell must not undo it */ })
  }
  return created({ id: newID, on_date: on, told: told.length })
}

// ---------------------------------------------------------------------------
// delegated pickup

const PICKUP_CODE_DIGITS = 6

const pickupSelect = `
  SELECT p.id, p.student_id, ${nameFL('st')} AS student_name,
         p.full_name, p.phone, p.relation, p.id_type, p.id_last4,
         p.valid_on, p.reason, p.code,
         ${istMinute('p.used_at')} AS used_at, u.full_name AS released_by,
         ${istMinute('p.revoked_at')} AS revoked_at,
         CASE WHEN p.used_at    IS NOT NULL THEN 'used'
              WHEN p.revoked_at IS NOT NULL THEN 'revoked'
              WHEN p.valid_on < ?1 THEN 'expired'
              ELSE 'live' END AS status,
         ${istDate('p.created_at')} AS created_at
    FROM emergency_pickup_authorisations p
    JOIN students st ON st.id = p.student_id
    LEFT JOIN users u ON u.id = p.released_by`

function pickupRow(v: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: v.id, student_id: v.student_id, student_name: v.student_name ?? '',
    full_name: v.full_name, phone: v.phone, relation: v.relation,
  }
  put(o, 'id_type', v.id_type)
  put(o, 'id_last4', v.id_last4)
  o.valid_on = String(v.valid_on).slice(0, 10)
  o.reason = v.reason
  o.code = v.code
  put(o, 'used_at', v.used_at)
  put(o, 'released_by', v.released_by)
  put(o, 'revoked_at', v.revoked_at)
  o.status = v.status
  o.created_at = v.created_at
  return o
}

async function listPickupAuthorisations(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  if (s.studentIds.length === 0) return ok({ items: [] })
  const ids = s.studentIds
  const rows = await c.db.prepare(pickupSelect + `
     WHERE p.student_id IN (SELECT value FROM json_each(?2))
     ORDER BY p.valid_on DESC, p.created_at DESC
     LIMIT 100`).bind(todayIST(), js(ids)).all<Record<string, unknown>>()
  return ok({ items: rows.results.map(pickupRow) })
}

/** Six digits from the cryptographic source, uniform over 000000..999999. */
function pickupCode(): string {
  const buf = new Uint32Array(1)
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(PICKUP_CODE_DIGITS, '0')
  }
}

/** A guardian names somebody else to collect their child once. */
async function authorisePickup(c: Ctx): Promise<Response> {
  const body = await readJSON<Record<string, unknown>>(c.req)
  const { studentId: sid } = await portalChild(c, raw(body.student_id))
  const name = str(body.full_name), phone = str(body.phone), relation = str(body.relation)
  if (name === '' || phone === '' || relation === '') throw badRequest('the gate needs a name, a number and who they are to the child')
  const reason = str(body.reason)
  if (reason === '') throw badRequest('say why somebody else is collecting them')

  const today = todayIST()
  let on = today
  const asked = raw(body.valid_on)
  if (asked.trim() !== '') {
    if (!validDate(asked)) throw badRequest('valid_on must be YYYY-MM-DD')
    on = asked
  }
  if (on < today) throw badRequest('a pass for a day that has passed cannot collect anybody')
  if (on > shiftDays(today, 30)) throw badRequest('a pickup pass is good for a month at most. Add them as a guardian instead')

  const idType = raw(body.id_type), idLast4 = raw(body.id_last4)
  const inst = institutionId(c)
  const newID = uuid()
  let code = ''
  // The emergency_pickup_one_live partial unique index (one live pass per
  // person, per child, per day) is not in the D1 schema, so the insert
  // carries it as a NOT EXISTS; the code's unique index is still real and a
  // collision there is retried, as the Go handler did.
  for (let attempt = 0; attempt < 5; attempt++) {
    code = pickupCode()
    let res: D1Result
    try {
      res = await c.db.prepare(`
        INSERT INTO emergency_pickup_authorisations
            (id, institution_id, student_id, authorised_by, full_name, phone,
             relation, id_type, id_last4, code, valid_on, reason, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, ?
         WHERE NOT EXISTS (
             SELECT 1 FROM emergency_pickup_authorisations
              WHERE institution_id = ? AND student_id = ? AND lower(full_name) = lower(?)
                AND valid_on = ? AND used_at IS NULL AND revoked_at IS NULL)`)
        .bind(newID, inst, sid, c.id.userId, name, phone, relation, idType, idLast4, code, on, reason, now(),
          inst, sid, name, on).run()
    } catch (e) {
      if (isUniqueViolation(e)) continue
      throw badRequest(errMsg(e))
    }
    if (!res.meta.changes) break
    return created({ id: newID, code, valid_on: on })
  }
  throw coded(409, 'already_authorised', 'that person already has a live pass for your child on that day')
}

/** Cancels a pass the family has thought better of, while it is unused. */
async function revokePickup(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  const passID = c.params.id
  if (!isUUID(passID)) throw badRequest('invalid pass id')
  if (s.studentIds.length === 0) throw notFound()
  const res = await c.db.prepare(`
    UPDATE emergency_pickup_authorisations SET revoked_at = ?
     WHERE id = ? AND student_id IN (${marks(s.studentIds)})
       AND used_at IS NULL AND revoked_at IS NULL`)
    .bind(now(), passID, js(s.studentIds)).run()
  if (!res.meta.changes) throw coded(409, 'not_live', 'that pass has already been used or cancelled')
  return ok({ status: 'revoked' })
}

/** The gate's lookup: somebody has recited a code. Only live passes for today match. */
async function verifyPickup(c: Ctx): Promise<Response> {
  requirePerm(c, FRONT_DESK_WRITE)
  const code = (c.url.searchParams.get('code') ?? '').trim()
  if (new TextEncoder().encode(code).length !== PICKUP_CODE_DIGITS) throw badRequest('a pickup code is six digits')
  const row = await c.db.prepare(pickupSelect + `
     WHERE p.code = ?2 AND p.valid_on = ?1
       AND p.used_at IS NULL AND p.revoked_at IS NULL`).bind(todayIST(), code).first<Record<string, unknown>>()
  if (!row) throw notFound()
  return ok(pickupRow(row))
}

/** Records that the child was handed over, spending the pass. */
async function releasePickup(c: Ctx): Promise<Response> {
  requirePerm(c, FRONT_DESK_WRITE)
  const passID = c.params.id
  if (!isUUID(passID)) throw badRequest('invalid pass id')
  const [upd, who] = await c.db.batch([
    c.db.prepare(`
      UPDATE emergency_pickup_authorisations SET used_at = ?, released_by = ?
       WHERE id = ? AND valid_on = ?
         AND used_at IS NULL AND revoked_at IS NULL`)
      .bind(now(), c.id.userId, passID, todayIST()),
    c.db.prepare(`
      SELECT ${nameFL('st')} AS name FROM emergency_pickup_authorisations p
        JOIN students st ON st.id = p.student_id WHERE p.id = ?`).bind(passID),
  ])
  if (!upd.meta.changes) throw coded(409, 'not_live', 'that pass is not good today. It has been used, cancelled or is for another date')
  const student = (who.results[0] as { name: string } | undefined)?.name ?? ''
  return ok({ student_name: student, status: 'used' })
}

// ---------------------------------------------------------------------------
// concerns

/** The caller's own school-facing grievances; a concern is the complainant's, not the family's. */
async function listPortalConcerns(c: Ctx): Promise<Response> {
  const rows = await c.db.prepare(`
    SELECT t.id, NULLIF(${nameFL('st')}, '') AS student_name,
           t.category, t.subject, t.body, t.priority, t.status, ${ticketStage('t')} AS stage, t.resolution,
           u.full_name AS assigned_to, ${istDate('t.created_at')} AS created_at,
           ${istDate('t.resolved_at')} AS resolved_at, t.satisfaction, t.reopened_count,
           ${canReopen('t', "t.status IN ('resolved', 'closed')")} AS can_reopen,
           CAST(julianday('now') - julianday(t.created_at) AS INTEGER) AS open_days,
           (SELECT count(*) FROM grievance_updates g WHERE g.ticket_id = t.id AND g.visible_to_parent = 1
              AND g.author_id IS NOT NULL AND g.author_id <> t.raised_by) AS replies,
           (SELECT strftime('%Y-%m-%dT%H:%M:%SZ', max(g.created_at)) FROM grievance_updates g
             WHERE g.ticket_id = t.id AND g.visible_to_parent = 1) AS last_update_at
      FROM support_tickets t
      LEFT JOIN students st ON st.id = t.student_id
      LEFT JOIN users u ON u.id = t.assigned_to
     WHERE t.raised_by = ? AND t.audience = 'school'
     ORDER BY t.resolved_at IS NOT NULL, t.created_at DESC
     LIMIT 100`).bind(c.id.userId).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => {
    const o: Record<string, unknown> = { id: v.id }
    put(o, 'student_name', v.student_name)
    Object.assign(o, { category: v.category, subject: v.subject, body: v.body, priority: v.priority, status: v.status, stage: v.stage })
    put(o, 'resolution', v.resolution)
    put(o, 'assigned_to', v.assigned_to)
    o.created_at = v.created_at
    put(o, 'resolved_at', v.resolved_at)
    put(o, 'satisfaction', v.satisfaction)
    put(o, 'last_update_at', v.last_update_at)
    o.open_days = nz(v.open_days)
    o.replies = Number(v.replies ?? 0)
    o.reopened_count = Number(v.reopened_count ?? 0)
    o.can_reopen = bool(v.can_reopen)
    return o
  }) })
}

const CONCERN_CATEGORIES = new Set(['academic', 'fees', 'transport', 'hostel', 'discipline', 'safety', 'staff', 'facilities', 'other'])

/* WHO A CONCERN CAN BE ADDRESSED TO.
 *
 * A concern used to go wherever the category's policy pointed, and to nobody
 * at all when the school had set no policy for that category -- which is every
 * school that has not been through the grievance settings. So a parent wrote
 * out what had happened, pressed send, and it landed in a table. Nothing was
 * lost, and nobody was told, which from the family's side is the same thing.
 *
 * A parent already knows who they want: the child's own teacher for something
 * that happened in the classroom, the head for something the teacher should
 * not be judging. This lists exactly those people -- the teachers of this
 * child's section, then whoever runs the school -- and the parent picks.
 *
 * Only these. Not a directory of the staff: a family may address the people
 * who teach their child and the people who answer for the school, and that is
 * the whole list.
 */
async function listConcernRecipients(c: Ctx): Promise<Response> {
  const { studentIds: ids } = await familyChildren(c, c.url.searchParams.get('student_id') ?? '')
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const one of ids) {
    for (const t of await reachableTeachers(c, one)) {
      if (!t.user_id || seen.has(t.user_id)) continue
      seen.add(t.user_id)
      out.push({
        user_id: t.user_id,
        full_name: t.full_name,
        role: bool(t.class_teacher) ? 'Class teacher' : (t.subject ? String(t.subject) + ' teacher' : 'Teacher'),
      })
    }
  }
  /* The heads, by the permission that makes them answerable rather than by a
     role key: a school that has renamed institution_admin to "Correspondent"
     still has somebody holding it, and a family must always have somebody
     above the classroom to write to. */
  const heads = await c.db.prepare(`
    SELECT DISTINCT u.id AS user_id, u.full_name,
           (SELECT ro.name FROM user_roles ur2 JOIN roles ro ON ro.id = ur2.role_id
             WHERE ur2.user_id = u.id AND ro.key IN ('institution_admin','principal') LIMIT 1) AS role
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
     WHERE u.status = 'active' AND r.key IN ('institution_admin','principal')
     ORDER BY u.full_name`).all<{ user_id: string; full_name: string; role: string | null }>()
  for (const h of heads.results) {
    if (seen.has(h.user_id)) continue
    seen.add(h.user_id)
    out.push({ user_id: h.user_id, full_name: h.full_name, role: h.role || 'Head of school' })
  }
  return ok({ items: out })
}

async function raisePortalConcern(c: Ctx): Promise<Response> {
  const body = await readJSON<Record<string, unknown>>(c.req)
  const subject = str(body.subject), text = str(body.body)
  if (subject === '' || text === '') throw badRequest('a concern needs a heading and what happened')
  let category = raw(body.category)
  if (category === '') category = 'other'
  if (!CONCERN_CATEGORIES.has(category)) throw badRequest('choose one of the listed categories')
  // urgent is the office's to assign.
  let priority = raw(body.priority)
  if (priority === '' || priority === 'urgent') priority = 'normal'
  if (priority !== 'low' && priority !== 'normal' && priority !== 'high') throw badRequest('priority must be low, normal or high')

  let child: string | null = null
  const rawChild = raw(body.student_id)
  if (rawChild.trim() !== '') child = (await portalChild(c, rawChild)).studentId
  else {
    // A student raising their own concern: it is about them.
    const self = await c.db.prepare(`SELECT id FROM students WHERE user_id = ? LIMIT 1`).bind(c.id.userId).first<{ id: string }>()
    child = self?.id ?? null
  }
  const attachment = await ownAttachment(c, body.attachment_file_id)

  /* WHO THE PARENT ADDRESSED IT TO.

     Checked against the same list the picker was filled from rather than
     trusted: a user id in a request body is somebody's guess otherwise, and
     "raise a concern" must not become a way to put a row in front of any
     member of staff whose id can be found. An id that is not on the list is
     refused rather than quietly dropped -- a parent who chose the class
     teacher and was silently reassigned to nobody has been told a lie. */
  let addressedTo: string | null = null
  const wanted = raw(body.assigned_to)
  if (wanted.trim() !== '') {
    if (!isUUID(wanted)) throw badRequest('assigned_to must be a uuid')
    const allowed = await (await listConcernRecipients(c)).clone().json<{ items: { user_id: string }[] }>()
    if (!allowed.items.some((x) => x.user_id === wanted)) {
      throw badRequest("you can address this to one of your child's teachers or to the head of the school")
    }
    addressedTo = wanted
  }

  // The promise is made the moment the concern arrives, from the category's
  // policy, not when somebody gets round to triaging it.
  const policy = await policyFor(c, category)
  const newID = uuid()
  const t = now()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`
      INSERT INTO support_tickets
          (id, institution_id, raised_by, student_id, category, subject, body, priority, attachment_file_id,
           owner_department, assigned_to, respond_due_at, resolve_due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newID, institutionId(c), c.id.userId, child, category, subject, text, priority, attachment,
        policy?.owner_department ?? null, addressedTo ?? policy?.default_owner_id ?? null,
        policy ? dueAt(t, policy.respond_hours) : null, policy ? dueAt(t, policy.resolve_hours) : null, t, t),
    feedbackUpdateStmt(c, newID, 'created', 'Concern raised.', 'open', true, c.id.userId),
  ]
  const owner = addressedTo ?? policy?.default_owner_id ?? null
  if (owner && owner !== c.id.userId) {
    stmts.push(notify(c, owner, 'A new concern has been raised', subject,
      `/institution_admin/communication/grievances?id=${newID}`, 'support_ticket', newID))
  }
  try {
    await c.db.batch(stmts)
  } catch (e) {
    throw badRequest(errMsg(e))
  }
  return created({ id: newID, respond_due_at: policy ? dueAt(t, policy.respond_hours) : undefined })
}

// ---------------------------------------------------------------------------
// direct teacher messaging

interface TeacherRow { user_id: string; full_name: string; subject: string | null; class_teacher: number; photo: string | null; unread: number }

/** The address book, and the allow list for sending: who teaches this child. */
async function reachableTeachers(c: Ctx, sid: string): Promise<TeacherRow[]> {
  const rows = await c.db.prepare(`
    WITH child_section AS (
        SELECT e.section_id
          FROM enrollments e
         WHERE e.student_id = ?1 AND e.status = 'active'
         ORDER BY e.enrolled_on DESC LIMIT 1
    )
    SELECT t.user_id, u.full_name, t.subject, MAX(t.class_teacher) AS class_teacher,
           (SELECT e2.photo_file_id FROM employees e2
             WHERE e2.user_id = t.user_id AND e2.photo_file_id IS NOT NULL
             LIMIT 1) AS photo,
           (SELECT count(*) FROM parent_teacher_messages m
             WHERE m.student_id = ?1 AND m.parent_user_id = ?2
               AND m.teacher_user_id = t.user_id
               AND m.sender_user_id <> ?2 AND m.read_at IS NULL) AS unread
      FROM (
          SELECT sec.class_teacher_id AS user_id, NULL AS subject, 1 AS class_teacher
            FROM sections sec
           WHERE sec.id = (SELECT section_id FROM child_section)
             AND sec.class_teacher_id IS NOT NULL
          UNION ALL
          SELECT sst.teacher_user_id, sub.name, 0
            FROM section_subject_teachers sst
            JOIN class_subjects cs ON cs.id = sst.class_subject_id
            LEFT JOIN subjects sub ON sub.id = cs.subject_id
           WHERE sst.section_id = (SELECT section_id FROM child_section)
          UNION ALL
          SELECT te.teacher_user_id, sub.name, 0
            FROM timetable_entries te
            JOIN class_subjects cs ON cs.id = te.class_subject_id
            LEFT JOIN subjects sub ON sub.id = cs.subject_id
           WHERE te.section_id = (SELECT section_id FROM child_section)
             AND te.teacher_user_id IS NOT NULL
             /* The subject teacher the school ASSIGNED for this section wins
                (the same assignment the staff record shows). The timetable
                only fills a subject nobody is assigned to; an older timetable
                entry named a teacher who no longer takes the class. */
             AND NOT EXISTS (SELECT 1 FROM section_subject_teachers s2
                              WHERE s2.section_id = te.section_id AND s2.class_subject_id = te.class_subject_id)
      ) t
      JOIN users u ON u.id = t.user_id
     /* A teacher whose login is still being set up (invited) is still the
        child's teacher; leaving them off showed the wrong person instead. */
     WHERE u.status IN ('active', 'invited')
     GROUP BY t.user_id, u.full_name, t.subject
     ORDER BY MAX(t.class_teacher) DESC, u.full_name`).bind(sid, c.id.userId).all<TeacherRow>()
  return rows.results
}

function teacherJSON(t: TeacherRow): Record<string, unknown> {
  const o: Record<string, unknown> = { user_id: t.user_id, full_name: t.full_name }
  put(o, 'subject', t.subject)
  o.class_teacher = bool(t.class_teacher)
  o.unread = nz(t.unread)
  put(o, 'photo', t.photo)
  return o
}

/** Who may I write to, for one child or (none named) every child. */
async function listReachableTeachers(c: Ctx): Promise<Response> {
  const rawID = c.url.searchParams.get('student_id') ?? ''
  const s = await resolveScope(c)
  // portalChild's refusal, except that an unnamed child with several siblings spans them all.
  if (rawID !== '' && rawID.trim() === '' && s.studentIds.length !== 1) throw notYourChild()
  const { studentIds: ids } = await familyChildren(c, rawID)
  if (ids.length === 0) throw notYourChild()
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const one of ids) {
    for (const t of await reachableTeachers(c, one)) {
      const key = t.user_id + '|' + one
      if (seen.has(key)) continue
      seen.add(key)
      out.push(teacherJSON(t))
    }
  }
  return ok({ items: out })
}

interface Attachment { file_id: string; name: string; size_bytes: number; content_type: string; url: string }
function scanAttachments(v: unknown): Attachment[] {
  if (typeof v !== 'string' || v === '') return []
  try { const a = JSON.parse(v); return Array.isArray(a) ? (a as Attachment[]) : [] } catch { return [] }
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** One thread (marking the other end's messages read), or the inbox when no teacher is named. */
async function listPortalMessages(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  const me = c.id.userId
  const rawID = (q.get('student_id') ?? '').trim()
  const { studentIds: mine } = await familyChildren(c, rawID)
  if (mine.length === 0) throw notYourChild()
  // The child portalChild would have resolved: the named one, or the only one.
  const sid = rawID !== '' || mine.length === 1 ? mine[0] : NIL_UUID

  if ((q.get('teacher_user_id') ?? '').trim() === '') {
    const rows = await c.db.prepare(`
      SELECT student_id, student_name, teacher_user_id, teacher_name, last_message, sent_at, unread FROM (
        SELECT m.student_id, ${nameFL('st')} AS student_name,
               m.teacher_user_id, u.full_name AS teacher_name,
               CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS last_message,
               m.sent_at,
               (SELECT count(*) FROM parent_teacher_messages un
                 WHERE un.student_id = m.student_id
                   AND un.teacher_user_id = m.teacher_user_id
                   AND un.parent_user_id = m.parent_user_id
                   AND un.sender_user_id <> ? AND un.read_at IS NULL) AS unread,
               ROW_NUMBER() OVER (PARTITION BY m.student_id, m.teacher_user_id ORDER BY m.sent_at DESC) AS rn
          FROM parent_teacher_messages m
          JOIN users u ON u.id = m.teacher_user_id
          JOIN students st ON st.id = m.student_id
         WHERE m.student_id IN (${marks(mine)}) AND m.parent_user_id = ?
      ) WHERE rn = 1
      ORDER BY student_id, teacher_user_id
      LIMIT 200`).bind(me, js(mine), me).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({
      student_id: v.student_id, student_name: v.student_name ?? '', teacher_user_id: v.teacher_user_id,
      teacher_name: v.teacher_name, last_message: v.last_message ?? '', last_at: isoZ(v.sent_at) ?? '', unread: nz(v.unread),
    })) })
  }

  let parentID = (q.get('parent_user_id') ?? '').trim()
  if (!isUUID(parentID)) parentID = me // the parent reading their own thread need not name themselves
  const teacherID = (q.get('teacher_user_id') ?? '').trim()
  if (!isUUID(teacherID)) throw badRequest('teacher_user_id must be a uuid')
  if (parentID === me) {
    const s = await resolveScope(c)
    if (!ownsStudent(s, sid)) throw notFound()
  } else if (teacherID !== me) {
    throw notFound()
  }

  const rows = await c.db.prepare(`
    SELECT m.id,
           CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,
           m.sent_at, u.full_name AS sender,
           (m.sender_user_id = ?4) AS mine,
           CASE WHEN m.sender_user_id = m.parent_user_id THEN 'parent'
                WHEN m.sender_user_id = m.teacher_user_id THEN 'teacher'
                ELSE COALESCE((SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                                WHERE ur.user_id = m.sender_user_id AND r.key <> 'parent'
                                ORDER BY r.name LIMIT 1), 'school') END AS sender_side,
           m.read_at,
           CASE WHEN m.deleted_at IS NULL THEN m.attachments ELSE NULL END AS attachments,
           m.reply_to_id,
           (SELECT substr(q.body, 1, 120) FROM parent_teacher_messages q WHERE q.id = m.reply_to_id) AS reply_body,
           (SELECT qu.full_name FROM parent_teacher_messages q JOIN users qu ON qu.id = q.sender_user_id
             WHERE q.id = m.reply_to_id) AS reply_sender,
           (m.edited_at IS NOT NULL) AS edited, (m.deleted_at IS NOT NULL) AS deleted
      FROM parent_teacher_messages m
      JOIN users u ON u.id = m.sender_user_id
     WHERE m.student_id = ?1 AND m.parent_user_id = ?2 AND m.teacher_user_id = ?3
     ORDER BY m.sent_at
     LIMIT 500`).bind(sid, parentID, teacherID, me).all<Record<string, unknown>>()
  const items = rows.results.map((v) => {
    const o: Record<string, unknown> = {
      id: v.id, body: v.body, sent_at: isoZ(v.sent_at) ?? '', sender_name: v.sender,
      attachments: scanAttachments(v.attachments), mine: bool(v.mine),
    }
    if (v.sender_side !== null && v.sender_side !== '') o.sender_side = v.sender_side
    put(o, 'read_at', isoZ(v.read_at))
    put(o, 'reply_to_id', v.reply_to_id)
    put(o, 'reply_body', v.reply_body)
    put(o, 'reply_sender', v.reply_sender)
    o.edited = bool(v.edited)
    o.deleted = bool(v.deleted)
    return o
  })

  // Marked read on the read; the other end's tick turns blue through the live hub.
  const marked = await c.db.prepare(`
    UPDATE parent_teacher_messages SET read_at = ?
     WHERE student_id = ? AND parent_user_id = ? AND teacher_user_id = ?
       AND sender_user_id <> ? AND read_at IS NULL`).bind(now(), sid, parentID, teacherID, me).run()
  if (marked.meta.changes) await publish(c.env, c.id.institution?.id, { users: [me === parentID ? teacherID : parentID], type: 'read',
    scope: 'parent', from: me, keys: { student: sid, parent: parentID, teacher: teacherID } })
  return ok({ items })
}

const MAX_ATTACHMENTS = 10

/** resolveAttachments: the ids must be live files of this school; names and sizes come from files. */
async function attachmentsFor(c: Ctx, input: unknown): Promise<Attachment[]> {
  const bad = () => badRequest('one of the attached files is missing or is not this school\'s; upload it again')
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw badRequest('malformed JSON body')
  if (input.length === 0) return []
  if (input.length > MAX_ATTACHMENTS) throw bad()
  const ids: string[] = []
  for (const a of input) {
    const id = typeof a === 'object' && a !== null ? str((a as Record<string, unknown>).file_id) : ''
    if (!isUUID(id)) throw bad()
    ids.push(id.toLowerCase())
  }
  const rows = await c.db.prepare(`
    SELECT id, original_name, size_bytes, content_type FROM files
     WHERE id IN (${marks(ids)}) AND institution_id = ? AND deleted_at IS NULL`)
    .bind(js(ids), institutionId(c)).all<{ id: string; original_name: string; size_bytes: number; content_type: string }>()
  const byID = new Map(rows.results.map((f) => [f.id.toLowerCase(), f]))
  return ids.map((id) => {
    const f = byID.get(id)
    if (!f) throw bad()
    return { file_id: f.id, name: f.original_name, size_bytes: Number(f.size_bytes), content_type: f.content_type, url: '/api/v1/files/' + f.id }
  })
}

/** Go's summary[:237] + "…", a byte cut, without leaving half a character behind. */
function summarise(body: string): string {
  const bytes = new TextEncoder().encode(body)
  if (bytes.length <= 240) return body
  return new TextDecoder().decode(bytes.slice(0, 237)).replace(/�+$/, '') + '…'
}

/** Posts into a thread, from either end. */
async function sendPortalMessage(c: Ctx): Promise<Response> {
  const body = await readJSON<Record<string, unknown>>(c.req)
  const me = c.id.userId
  const files = await attachmentsFor(c, body.attachments)
  const text = str(body.body)
  if (text === '' && files.length === 0) throw badRequest('there is nothing to send')
  const sid = str(body.student_id)
  if (!isUUID(sid)) throw badRequest('student_id must be a uuid')

  const s = await resolveScope(c)
  let parentID: string, teacherID: string
  if (ownsStudent(s, sid)) {
    // The family writing to a teacher, who has to be one of the child's.
    parentID = me
    teacherID = str(body.teacher_user_id)
    if (!isUUID(teacherID)) throw badRequest('teacher_user_id must be a uuid')
    const reachable = await reachableTeachers(c, sid)
    if (!reachable.some((t) => t.user_id === teacherID)) {
      throw new HttpError(403, 'you can only write to the staff who teach your child', { code: 'forbidden' })
    }
  } else {
    // The teacher replying: they must teach the child and the parent must be its guardian,
    // or the thread must already exist between exactly these three.
    teacherID = me
    parentID = str(body.parent_user_id)
    if (!isUUID(parentID)) throw badRequest('parent_user_id must be a uuid')
    if (!(await teacherMayWrite(c, sid, teacherID, parentID)) && !(await teacherIsThreadParty(c, sid, teacherID, parentID))) {
      throw notFound()
    }
  }

  const replyTo = str(body.reply_to_id)
  if (replyTo !== '' && !isUUID(replyTo)) throw badRequest(`invalid input syntax for type uuid: "${replyTo}"`)

  const [from, child] = await Promise.all([
    c.db.prepare(`SELECT full_name FROM users WHERE id = ?`).bind(me).first<{ full_name: string }>(),
    c.db.prepare(`SELECT trim(first_name || ' ' || COALESCE(last_name,'')) AS name FROM students WHERE id = ?`).bind(sid).first<{ name: string }>(),
  ])
  if (!from || !child) throw badRequest('no rows in result set')

  const to = me === parentID ? teacherID : parentID
  const link = to === teacherID
    ? `/go/messages?box=parents&child=${sid}&with=${parentID}`
    : `/go/messages/communication?tab=teacher&student_id=${sid}&teacher_user_id=${teacherID}`
  const newID = uuid()
  try {
    await c.db.batch([
      c.db.prepare(`
        INSERT INTO parent_teacher_messages
            (id, institution_id, student_id, parent_user_id, teacher_user_id,
             sender_user_id, body, attachments, reply_to_id, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?)`)
        .bind(newID, institutionId(c), sid, parentID, teacherID, me, text, JSON.stringify(files), replyTo, now()),
      notifyStmt(c, to, sid, 'parent_message', `Message from ${from.full_name} about ${child.name}`,
        summarise(text), link, 'parent_teacher_message', newID),
    ])
  } catch (e) {
    throw badRequest(errMsg(e))
  }
  await publish(c.env, institutionId(c), { users: [to, me], type: 'message', scope: 'parent', from: me,
    keys: { student: sid, parent: parentID, teacher: teacherID, from_name: from.full_name, child: child.name } })
  // Out of the building as well (Go: TypeMessageSend student.remark to the other party); a failed enqueue is logged only.
  try {
    await enqueueMessageSends(c.env, institutionId(c), [{ channel: 'email', template_key: 'student.remark', to_user_id: to,
      vars: { title: 'About ' + child.name, summary: text, teacher: from.full_name, on_date: longDateIST() } }])
  } catch (e) { console.warn('message email not queued', e) }
  return created({ id: newID })
}

/** A thread already exists between exactly these three: the reply gate for a teacher moved off the class. */
async function teacherIsThreadParty(c: Ctx, sid: string, teacherID: string, parentID: string): Promise<boolean> {
  const row = await c.db.prepare(`
    SELECT EXISTS (SELECT 1 FROM parent_teacher_messages
                    WHERE student_id = ? AND teacher_user_id = ? AND parent_user_id = ?) AS ok`)
    .bind(sid, teacherID, parentID).first<{ ok: number }>()
  return bool(row?.ok)
}

/** The caller teaches the child (or reads every student), and the parent is the child's guardian. */
/* WHO MAY OPEN A THREAD WITH A FAMILY.

   Teaching the child, or seeing every child -- and now running the bus the
   child is on. The transport office has the one piece of news a family needs
   within the minute (the bus has broken down, it is forty minutes late) and
   had no way to send it: they rang down a paper list instead.

   Narrow on purpose. Not "the transport office may write to parents", which
   would hand it the whole school: only the families whose child has a live
   allocation, which is the same row that puts the child on the register and
   the fee on the demand. A child taken off the bus in December stops being
   reachable this way the same day. */
async function transportMayWrite(c: Ctx, sid: string): Promise<boolean> {
  if (!can(c.id, 'operations.transport.read')) return false
  const row = await c.db.prepare(`
    SELECT 1 AS ok FROM transport_allocations ta
     WHERE ta.student_id = ?1
       AND ta.valid_from <= date('now', '+5 hours', '+30 minutes')
       AND (ta.valid_to IS NULL OR ta.valid_to >= date('now', '+5 hours', '+30 minutes'))
     LIMIT 1`).bind(sid).first<{ ok: number }>()
  return bool(row?.ok)
}

async function teacherMayWrite(c: Ctx, sid: string, teacherID: string, parentID: string): Promise<boolean> {
  const schoolWide = can(c.id, 'students.read.all') || (await transportMayWrite(c, sid)) ? 1 : 0
  const row = await c.db.prepare(`
    SELECT ((?4 = 1) OR EXISTS (
        SELECT 1 FROM enrollments e
         WHERE e.student_id = ?1 AND e.status = 'active'
           AND (
             EXISTS (SELECT 1 FROM sections sec
                      WHERE sec.id = e.section_id AND sec.class_teacher_id = ?2)
          OR EXISTS (SELECT 1 FROM section_subject_teachers sst
                      WHERE sst.section_id = e.section_id AND sst.teacher_user_id = ?2)
          OR EXISTS (SELECT 1 FROM timetable_entries te
                      WHERE te.section_id = e.section_id AND te.teacher_user_id = ?2))))
    AND EXISTS (
        SELECT 1 FROM student_guardians sg
          JOIN guardians g ON g.id = sg.guardian_id
         WHERE sg.student_id = ?1 AND g.user_id = ?3) AS ok`)
    .bind(sid, teacherID, parentID, schoolWide).first<{ ok: number }>()
  return bool(row?.ok)
}

// ---------------------------------------------------------------------------
// fee receipts

/** Only settled money: a bounced or uncleared cheque is not a receipt. */
async function listPortalReceipts(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  if (s.studentIds.length === 0) return ok({ items: [] })
  const rows = await c.db.prepare(`
    SELECT p.id, COALESCE(p.receipt_no, '-') AS receipt_no, p.student_id,
           ${nameFL('st')} AS student_name,
           p.amount_paise, p.mode, p.status, p.paid_on, p.reference_no
      FROM payments p
      JOIN students st ON st.id = p.student_id
     WHERE p.student_id IN (${marks(s.studentIds)}) AND p.status = 'success'
     ORDER BY p.paid_on DESC, p.created_at DESC
     LIMIT 200`).bind(js(s.studentIds)).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => {
    const o: Record<string, unknown> = {
      payment_id: v.id, receipt_no: v.receipt_no, student_id: v.student_id, student_name: v.student_name ?? '',
      amount_paise: nz(v.amount_paise), mode: v.mode, status: v.status, paid_on: String(v.paid_on).slice(0, 10),
    }
    put(o, 'reference_no', v.reference_no)
    return o
  }) })
}

/** One receipt for the family that paid it; another family's is a 404. */
/* THE RECEIPT AS A FILE, NOT AS A PRINT DIALOGUE.

   The family's receipt has always been a print sheet with "choose Save as PDF
   to keep a copy" written under it. That works at a desk and barely works on a
   phone -- iOS Safari's share sheet hides it, and a parent asked to produce a
   receipt for a scholarship form does not want a screenshot. The Worker
   already draws real PDFs with pdf-lib for the seller's tax invoices and the
   report digests (services/document.ts), on the school's own letterhead, so
   there is nothing to invent: the same builder, the same data this screen
   already reads, and a Content-Disposition that makes the browser save it.

   Scoped exactly as the screen is -- resolveScope and the student_ids it
   returns -- so a family downloads its own receipts and nobody else's, and
   only cleared money: a bounced cheque must never leave the building as a
   receipt. */
async function portalReceiptPDF(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  const paymentID = c.params.id
  if (!isUUID(paymentID)) throw badRequest('invalid payment id')
  if (s.studentIds.length === 0) throw notFound()

  const p = await c.db.prepare(`
    SELECT COALESCE(p.receipt_no, '-') AS receipt_no, p.amount_paise, p.mode, p.paid_on, p.reference_no,
           trim(st.first_name || COALESCE(' ' || st.middle_name, '') || COALESCE(' ' || st.last_name, '')) AS student_name,
           st.admission_no,
           (SELECT c2.name FROM enrollments e JOIN classes c2 ON c2.id = e.class_id
             WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS class_name,
           (SELECT sec.name FROM enrollments e JOIN sections sec ON sec.id = e.section_id
             WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS section_name
      FROM payments p
      JOIN students st ON st.id = p.student_id
     WHERE p.id = ? AND p.student_id IN (${marks(s.studentIds)}) AND p.status = 'success'`)
    .bind(paymentID, js(s.studentIds)).first<Record<string, unknown>>()
  if (!p) throw notFound()

  const lines = (await c.db.prepare(`
    SELECT i.invoice_no, pa.amount_paise,
           COALESCE((SELECT group_concat(n, ', ') FROM (
               SELECT DISTINCT fh.name AS n FROM invoice_lines il
                 JOIN fee_heads fh ON fh.id = il.fee_head_id
                WHERE il.invoice_id = i.id)), 'Fee') AS particulars
      FROM payment_allocations pa
      JOIN invoices i ON i.id = pa.invoice_id
     WHERE pa.payment_id = ?`).bind(paymentID).all<{ invoice_no: string; amount_paise: number; particulars: string }>()).results

  const amount = Number(p.amount_paise ?? 0)
  const paidOn = String(p.paid_on).slice(0, 10)
  const facts = await schoolFacts(c.db, c.id.institution!)
  const logo = await logoBytes(c.env, c.db, facts.logoKey)
  const pdf = await SchoolPDF.create(facts, {
    title: 'Fee receipt',
    subtitle: `${str(p.student_name)} · ${financialYear(paidOn)}`,
    docNo: str(p.receipt_no),
    date: paidOn,
    logo: logo ?? undefined,
  })

  const where = [p.class_name, p.section_name].filter(Boolean).join(' ')
  const about: [string, string][] = [
    ['Received from', str(p.student_name)],
    ['Admission no', str(p.admission_no)],
  ]
  if (where) about.push(['Class', where])
  about.push(['Paid on', paidOn], ['Mode', str(p.mode) || '-'])
  if (p.reference_no) about.push(['Reference', str(p.reference_no)])
  pdf.facts(about)

  pdf.table(
    [{ label: 'Particulars', width: 4 }, { label: 'Invoice', width: 2 }, { label: 'Amount', width: 2, align: 'right' }],
    lines.length
      ? lines.map((l) => [l.particulars, l.invoice_no, docINR(Number(l.amount_paise ?? 0), true)])
      : [['Fee', '-', docINR(amount, true)]],
  )
  pdf.total('Total received', docINR(amount, true), true)
  /* rupeesInWords already ends in "Rupees Only"; prefixing it printed
     "Rupees One Hundred Eighty Eight Rupees Only". */
  pdf.paragraph(`${rupeesInWords(amount)}.`)
  /* A receipt that does not say it needs no signature invites somebody to ask
     for one that this document will never carry. */
  pdf.paragraph('This is a computer-generated receipt and needs no signature.')

  const bytes = await pdf.save()
  const name = `receipt-${str(p.receipt_no).replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      /* attachment, so the phone saves it rather than opening a viewer the
         parent then has to work out how to save from. */
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'private, no-store',
    },
  })
}

async function getPortalReceipt(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  const paymentID = c.params.id
  if (!isUUID(paymentID)) throw badRequest('invalid payment id')
  if (s.studentIds.length === 0) throw notFound()

  const p = await c.db.prepare(`
    SELECT COALESCE(p.receipt_no, '-') AS receipt_no, p.amount_paise, p.mode, p.status, p.paid_on,
           p.reference_no,
           trim(st.first_name || COALESCE(' ' || st.middle_name, '') || COALESCE(' ' || st.last_name, '')) AS student_name,
           st.admission_no, i.name AS institution,
           (SELECT c2.name FROM enrollments e JOIN classes c2 ON c2.id = e.class_id
             WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS class_name,
           (SELECT sec.name FROM enrollments e JOIN sections sec ON sec.id = e.section_id
             WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS section_name
      FROM payments p
      JOIN students st    ON st.id = p.student_id
      JOIN institutions i ON i.id = p.institution_id
     WHERE p.id = ? AND p.student_id IN (${marks(s.studentIds)}) AND p.status = 'success'`)
    .bind(paymentID, js(s.studentIds)).first<Record<string, unknown>>()
  if (!p) throw notFound()

  // Who took the money is on the counter's copy and not on the family's.
  const lines = await c.db.prepare(`
    SELECT i.invoice_no, pa.amount_paise,
           COALESCE((SELECT group_concat(n, ', ') FROM (
               SELECT DISTINCT fh.name AS n FROM invoice_lines il
                 JOIN fee_heads fh ON fh.id = il.fee_head_id
                WHERE il.invoice_id = i.id)), 'Fee') AS particulars
      FROM payment_allocations pa
      JOIN invoices i ON i.id = pa.invoice_id
     WHERE pa.payment_id = ?`).bind(paymentID).all<{ invoice_no: string; amount_paise: number; particulars: string }>()

  const amount = nz(p.amount_paise)
  const paidOn = String(p.paid_on).slice(0, 10)
  return ok({
    receipt_no: p.receipt_no,
    amount_paise: amount,
    amount_words: rupeesInWords(amount),
    mode: p.mode,
    status: p.status,
    paid_on: paidOn,
    reference_no: p.reference_no ?? null,
    student_name: p.student_name,
    admission_no: p.admission_no,
    institution: p.institution,
    class_name: p.class_name ?? null,
    section_name: p.section_name ?? null,
    financial_year: financialYear(paidOn),
    lines: lines.results.map((l) => ({ invoice_no: l.invoice_no, amount_paise: nz(l.amount_paise), particulars: l.particulars })),
  })
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const twoDigits = (n: number): string => (n === 0 ? '' : n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''))
function threeDigits(n: number): string {
  const parts: string[] = []
  const h = Math.floor(n / 100); if (h) parts.push(ONES[h] + ' Hundred')
  const t = twoDigits(n % 100); if (t) parts.push(t)
  return parts.join(' ')
}
/** fees.indianWords: crore / lakh / thousand / hundred grouping. */
function indianWords(n: number): string {
  if (n >= 1_00_00_000 * 100) return String(n)
  const parts: string[] = []
  const crore = Math.floor(n / 1_00_00_000); if (crore) { parts.push(threeDigits(crore) + ' Crore'); n %= 1_00_00_000 }
  const lakh = Math.floor(n / 1_00_000); if (lakh) { parts.push(twoDigits(lakh) + ' Lakh'); n %= 1_00_000 }
  const th = Math.floor(n / 1000); if (th) { parts.push(twoDigits(th) + ' Thousand'); n %= 1000 }
  const rest = threeDigits(n); if (rest) parts.push(rest)
  return parts.join(' ')
}
/** fees.RupeesInWords. */
function rupeesInWords(paise: number): string {
  if (paise < 0) return 'Minus ' + rupeesInWords(-paise)
  const rupees = Math.floor(paise / 100), rem = paise % 100
  let s = (rupees === 0 ? 'Zero' : indianWords(rupees)) + ' Rupees'
  if (rem > 0) s += ' and ' + indianWords(rem) + ' Paise'
  return s + ' Only'
}
/** fees.FinancialYear: "2026-27" for a YYYY-MM-DD date. */
function financialYear(on: string): string {
  let y = Number(on.slice(0, 4))
  if (Number(on.slice(5, 7)) < 4) y--
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// certificate requests and documents

/** What the school is willing to issue. Never creates a type. */
async function listPortalRequestTypes(c: Ctx): Promise<Response> {
  /* THE PARENT'S LIST, NOT THE WHOLE CABINET.

     This read every row of certificate_types, and that table holds the staff
     letters too -- so a parent asking the office for a bonafide certificate
     was offered "Appointment Letter" and "Warning Letter" beside it. At JSM
     those were two of the three choices on the menu. Both columns that would
     have prevented it were already on the table and simply not consulted:
     subject_kind says whose document it is, is_active says whether the school
     still issues it. */
  const rows = await c.db.prepare(`
    SELECT id, code, name, description, requires_approval FROM certificate_types
     WHERE subject_kind = 'student' AND is_active ORDER BY name`)
    .all<{ id: string; code: string; name: string; description: string | null; requires_approval: number }>()
  return ok({ items: rows.results.map((v) => ({
    id: v.id, code: v.code, name: v.name,
    description: v.description ?? '',
    requires_approval: bool(v.requires_approval),
  })) })
}

async function listPortalRequests(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  if (s.studentIds.length === 0) return ok({ items: [] })
  const rows = await c.db.prepare(`
    SELECT ic.id, ic.student_id, ${nameFL('st')} AS student_name,
           ic.serial_no, ct.name AS type, ct.code, ic.status, ic.issued_on,
           json_extract(ic.snapshot, '$.reason') AS reason, (ic.pdf_file_id IS NOT NULL) AS has_file
      FROM issued_certificates ic
      JOIN certificate_types ct ON ct.id = ic.certificate_type_id
      JOIN students st ON st.id = ic.student_id
     WHERE ic.student_id IN (${marks(s.studentIds)})
     ORDER BY ic.created_at DESC
     LIMIT 100`).bind(js(s.studentIds)).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => {
    const o: Record<string, unknown> = {
      id: v.id, student_id: v.student_id, student_name: v.student_name ?? '', serial_no: v.serial_no,
      type: v.type, code: v.code, status: v.status, issued_on: String(v.issued_on).slice(0, 10),
    }
    put(o, 'reason', v.reason === null || v.reason === undefined ? null : String(v.reason))
    o.has_file = bool(v.has_file)
    return o
  }) })
}

/** Asks the office for a certificate: 'requested', never 'issued'. The serial is allocated now. */
async function raisePortalRequest(c: Ctx): Promise<Response> {
  const body = await readJSON<Record<string, unknown>>(c.req)
  const { studentId: sid } = await portalChild(c, raw(body.student_id))
  const typeCode = str(body.type_code)
  if (typeCode === '') throw badRequest('say which certificate you need')
  const reason = str(body.reason)
  if (reason === '') throw badRequest('say what it is for. The office writes the purpose on it')

  const type = await c.db.prepare(`SELECT id, name FROM certificate_types WHERE code = ?`).bind(typeCode).first<{ id: string; name: string }>()
  if (!type) throw badRequest('the school does not issue that certificate')

  // One open request per child per type.
  const pending = await c.db.prepare(`
    SELECT 1 AS x FROM issued_certificates
     WHERE student_id = ? AND certificate_type_id = ? AND status IN ('requested','approved') LIMIT 1`)
    .bind(sid, type.id).first()
  if (pending) throw coded(409, 'already_requested', 'you have already asked for that one and the office has not finished with it')

  const inst = institutionId(c)
  const [numbered, childRow, office] = await Promise.all([
    nextNumber(c, 'certificate'),
    c.db.prepare(`SELECT ${nameFL('s')} AS name FROM students s WHERE s.id = ?`).bind(sid).first<{ name: string }>(),
    c.db.prepare(`
      SELECT DISTINCT ur.user_id FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE rp.permission_key = ?`).bind('students.write').all<{ user_id: string }>(),
  ])
  const child = childRow?.name ?? ''
  const serial = numbered.text
  const t = now()

  const stmts: D1PreparedStatement[] = [
    ...numbered.stmts,
    // The same guard as the read above, inside the batch, so a double tap cannot slip two in.
    assertInBatch(c, `NOT EXISTS (SELECT 1 FROM issued_certificates WHERE student_id = ? AND certificate_type_id = ? AND status IN ('requested','approved'))`, [sid, type.id]),
    c.db.prepare(`
      INSERT INTO issued_certificates
          (id, institution_id, certificate_type_id, student_id, serial_no,
           issued_on, snapshot, status, requested_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, json_object('reason', ?, 'requested_at', ?), 'requested', ?, ?)`)
      .bind(uuid(), inst, type.id, sid, serial, todayIST(), reason, t, c.id.userId, t),
  ]
  // Everyone who can issue one is told, once, with the child's name on it.
  for (const { user_id: u } of office.results) {
    if (u === c.id.userId) continue
    stmts.push(notifyStmt(c, u, sid, 'certificate_requested', type.name + ' asked for',
      `${child}, serial ${serial}. Issue it from Certificates.`, '/go/certificates_transfers', 'certificate', null))
  }
  try {
    await c.db.batch(stmts)
  } catch (e) {
    throw badRequest(errMsg(e))
  }
  return created({ serial_no: serial, status: 'requested' })
}

interface DocRow { id: string; student_id: string; student_name: string | null; doc_type: string; file_name: string; size_bytes: number;
  uploaded_on: string; verified: number; verified_by: string | null; notes: string | null }

/** What the school holds on file for the child, and whether the office has checked it. No bytes. */
async function listPortalDocuments(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  if (s.studentIds.length === 0) return ok({ items: [] })
  const rows = await c.db.prepare(`
    SELECT d.id, d.student_id, ${nameFL('st')} AS student_name,
           d.doc_type, f.original_name AS file_name, f.size_bytes,
           ${istDate('d.created_at')} AS uploaded_on,
           (d.verified_at IS NOT NULL) AS verified, u.full_name AS verified_by, d.notes
      FROM student_documents d
      JOIN students st ON st.id = d.student_id
      JOIN files f ON f.id = d.file_id
      LEFT JOIN users u ON u.id = d.verified_by
     WHERE d.student_id IN (${marks(s.studentIds)}) AND f.deleted_at IS NULL
     ORDER BY d.created_at DESC
     LIMIT 200`).bind(js(s.studentIds)).all<DocRow>()
  return ok({ items: rows.results.map((v) => {
    const o: Record<string, unknown> = {
      id: v.id, student_id: v.student_id, student_name: v.student_name ?? '', doc_type: v.doc_type,
      file_name: v.file_name, size_bytes: nz(v.size_bytes), uploaded_on: v.uploaded_on, verified: bool(v.verified),
    }
    put(o, 'verified_by', v.verified_by)
    put(o, 'notes', v.notes)
    return o
  }) })
}

// ---------------------------------------------------------------------------
// numbering (port of fees.NextNumberOn), local because the fees files are not shared

/* Postgres serialised allocators with SELECT ... FOR UPDATE. D1 has no row
   locks: the number is computed from a read and the batch that writes the
   document carries a guard asserting the counter has not moved since, so a
   concurrent allocator fails the whole batch rather than forking the series. */

/** A statement that fails the batch (primary-key violation) when cond is false. */
function assertInBatch(c: Ctx, cond: string, args: unknown[] = []): D1PreparedStatement {
  return c.db.prepare(`INSERT INTO institutions SELECT * FROM institutions WHERE NOT (${cond}) LIMIT 1`).bind(...args)
}

function renderNumber(format: string, prefix: string, fy: string, seq: number, padding: number, suffix: string): string {
  if (!format) format = '{prefix}{fy}/{seq}{suffix}'
  if (!fy) for (const d of ['{fy}/', '{fy}-', '/{fy}', '-{fy}']) format = format.split(d).join('')
  return format.split('{prefix}').join(prefix).split('{fy}').join(fy)
    .split('{seq}').join(String(seq).padStart(padding, '0')).split('{suffix}').join(suffix)
}

interface Scheme { prefix: string; suffix: string; padding: number; next_value: number; reset_yearly: number; current_fy: string | null; format: string }

async function nextNumber(c: Ctx, kind: string, on: string = todayIST()): Promise<{ text: string; stmts: D1PreparedStatement[] }> {
  const inst = institutionId(c)
  const sel = `SELECT prefix, suffix, padding, next_value, reset_yearly, current_fy, format FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`
  let scheme = await c.db.prepare(sel).bind(inst, kind).first<Scheme>()
  if (!scheme) {
    await c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, padding, next_value, reset_yearly, updated_at)
        SELECT ?, ?, ?, '', 5, 1, 1, ? WHERE NOT EXISTS (SELECT 1 FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL)`)
      .bind(uuid(), inst, kind, now(), inst, kind).run()
    scheme = await c.db.prepare(sel).bind(inst, kind).first<Scheme>()
    if (!scheme) throw new Error(`numbering scheme ${kind} missing`)
  }
  const stmts: D1PreparedStatement[] = []
  let seq = Number(scheme.next_value)
  let fy = ''
  const currentFY = scheme.current_fy ?? ''
  const resetYearly = bool(scheme.reset_yearly)
  if (resetYearly) {
    fy = financialYear(on)
    const seed = currentFY === '' || currentFY === fy ? Number(scheme.next_value) : 1
    const counter = await c.db.prepare(`SELECT next_value FROM numbering_fy_counters WHERE institution_id = ? AND kind = ? AND fy = ?`)
      .bind(inst, kind, fy).first<{ next_value: number }>()
    if (counter) {
      seq = Number(counter.next_value)
      stmts.push(assertInBatch(c, `(SELECT next_value FROM numbering_fy_counters WHERE institution_id = ? AND kind = ? AND fy = ?) = ?`, [inst, kind, fy, seq]))
      stmts.push(c.db.prepare(`UPDATE numbering_fy_counters SET next_value = ? WHERE institution_id = ? AND kind = ? AND fy = ?`).bind(seq + 1, inst, kind, fy))
    } else {
      seq = seed
      stmts.push(c.db.prepare(`INSERT INTO numbering_fy_counters (institution_id, kind, fy, next_value) VALUES (?, ?, ?, ?)`).bind(inst, kind, fy, seq + 1))
    }
  } else {
    stmts.push(assertInBatch(c, `(SELECT next_value FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL) = ?`, [inst, kind, seq]))
  }
  const text = renderNumber(scheme.format, scheme.prefix, fy, seq, Number(scheme.padding), scheme.suffix)
  const t = now()
  if (!resetYearly || currentFY === '' || currentFY <= fy) {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET next_value = ?, current_fy = NULLIF(?, ''), last_number = ?, last_issued_at = ?, updated_at = ?
                              WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(seq + 1, fy, text, t, t, inst, kind))
  } else {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET last_number = ?, last_issued_at = ?, updated_at = ? WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`)
      .bind(text, t, t, inst, kind))
  }
  return { text, stmts }
}

