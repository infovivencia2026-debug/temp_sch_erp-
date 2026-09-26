import type { Router, Ctx } from '../../router'
import { json } from '../../env'
import { readJSON, ok, created, notFound, badRequest, forbidden, isUUID, now } from '../../http'
import { can } from '../../identity'
import {
  familyChildren, portalChild, resolveScope, requirePerm, institutionId, marks, js,
  nowInIndia, todayIST, ymd, addDays, parseYMD, str, fullName, shortName,
} from '../teaching/common'

/* Port of internal/api/portal_school_life.go (mountParentSchoolLife) plus
   getLiveRevision (live.go). Every route sits in the /portal group whose floor
   is self.profile.read; the three door/gate endpoints re-gate on
   office.front_desk.write. Ownership failures are 404, never 403. */

const GROUP = 'self.profile.read'
const FRONT_DESK = 'office.front_desk.write'
const LEAVE_APPROVE = 'hr.leave.approve'

// ---------------------------------------------------------------------------
// small helpers

/** Go omitempty on a pointer: null becomes an absent key. */
const o = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v)
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
/** `x IN (SELECT value FROM json_each(?))`: no bound-parameter limit for long lists. */
const inJSON = (col: string) => `${col} IN (SELECT value FROM json_each(?))`

/** SQLite's per-row v4 uuid, as used by other ported INSERT ... SELECT statements. */
const SQL_UUID = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-a' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** Postgres to_char(d, 'DD Mon') in SQL. */
const sqlDDMon = (d: string) =>
  `strftime('%d', ${d}) || ' ' || CASE strftime('%m', ${d}) ${MONTHS.map((m, i) => `WHEN '${String(i + 1).padStart(2, '0')}' THEN '${m}'`).join(' ')} END`
/** Postgres to_char(d, 'Day DD Mon'): the day name blank-padded to nine. */
const sqlDayDDMon = (d: string) =>
  `CASE strftime('%w', ${d}) ${WDAYS_LONG.map((w, i) => `WHEN '${i}' THEN '${w.padEnd(9, ' ')}'`).join(' ')} END || ' ' || ${sqlDDMon(d)}`

/** Parses a stored timestamp (ISO, or Postgres text form) to a Date. */
function parseTs(s: string | null | undefined): Date | null {
  if (!s) return null
  let t = s.trim().replace(' ', 'T')
  if (/[+-]\d{2}$/.test(t)) t += ':00'
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t) && t.includes('T')) t += 'Z'
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d
}
const IST_MS = 330 * 60 * 1000
const p2 = (n: number) => String(n).padStart(2, '0')
/** A timestamp as Indian wall clock, in the pieces the Go to_char calls produced. */
function ist(s: string | null | undefined): { stamp: string; date: string; time: string; compact: string } | null {
  const d0 = parseTs(s)
  if (!d0) return null
  const d = new Date(d0.getTime() + IST_MS)
  const date = ymd(d)
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
  const compact = date.replace(/-/g, '') + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds())
  return { stamp: `${date}T${time}`, date, time, compact }
}
const istStamp = (s: string | null | undefined): string | null => ist(s)?.stamp ?? null
/** Instant of Indian midnight starting a calendar day, as ISO UTC. */
const istMidnightISO = (day: string): string => new Date(new Date(day + 'T00:00:00Z').getTime() - IST_MS).toISOString()
/** Go's time-of-day text "HH:MM" from a stored time. */
const hhmm = (t: string | null | undefined): string | null => (t ? t.slice(0, 5) : null)
/** Go's `Mon 2 Jan` for a YYYY-MM-DD. */
function monDJan(day: string): string {
  const d = new Date(day.slice(0, 10) + 'T00:00:00Z')
  return `${WDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}
/** Postgres to_char(x, 'FM99,99,999.00'): Indian digit grouping. */
function fmtIndian(amount: number): string {
  const neg = amount < 0
  const fixed = Math.abs(amount).toFixed(2)
  const [ip, fp] = fixed.split('.')
  let intPart = ip === '0' ? '' : ip
  if (intPart.length > 3) {
    const last3 = intPart.slice(-3)
    let rest = intPart.slice(0, -3)
    const groups: string[] = []
    while (rest.length > 2) { groups.unshift(rest.slice(-2)); rest = rest.slice(0, -2) }
    if (rest) groups.unshift(rest)
    intPart = groups.join(',') + ',' + last3
  }
  return (neg ? '-' : '') + intPart + '.' + fp
}

/** Port of familyDates: ?from=&to= or the default window around today (Indian time). */
function familyDates(c: Ctx, backDays: number, forwardDays: number): { from: string; to: string } {
  const n = nowInIndia()
  let from = ymd(addDays(n, -backDays))
  let to = ymd(addDays(n, forwardDays))
  const strict = (s: string | null) => {
    const d = parseYMD(s)
    return d && ymd(d) === s ? s : null
  }
  const f = strict(c.url.searchParams.get('from'))
  const t = strict(c.url.searchParams.get('to'))
  if (f) from = f
  if (t) to = t
  if (to < from) [from, to] = [to, from]
  return { from, to }
}

/** Port of whichChild (portal_family.go): a read defaults to the first child. */
async function whichChild(c: Ctx): Promise<string> {
  const res = await resolveScope(c)
  if (res.studentIds.length === 0) throw notFound()
  const q = c.url.searchParams.get('student_id') ?? ''
  if (q !== '') {
    if (res.studentIds.includes(q)) return q
    throw notFound()
  }
  return res.studentIds[0]
}

// ---------------------------------------------------------------------------
// registration

export function registerPortalSchoolLife(r: Router): void {
  r.get('/portal/school-life/calendar', GROUP, getFamilyCalendar)
  r.get('/portal/school-life/ptm/slots', GROUP, listPTMSlots)
  r.get('/portal/school-life/ptm/bookings', GROUP, listPTMBookings)
  r.post('/portal/school-life/ptm/book', GROUP, bookPTMSlot)
  r.post('/portal/school-life/ptm/{id}/cancel', GROUP, cancelPTMBooking)

  r.get('/portal/school-life/gallery', GROUP, listGalleryAlbums)
  r.get('/portal/school-life/gallery/{id}', GROUP, getGalleryAlbum)

  r.get('/portal/school-life/event-passes/verify', GROUP, verifyEventPass)
  r.get('/portal/school-life/event-passes', GROUP, listEventPasses)
  r.post('/portal/school-life/event-passes', GROUP, claimEventPass)
  r.post('/portal/school-life/event-passes/{id}/admit', GROUP, admitEventPass)

  r.get('/portal/academics/iep', GROUP, getFamilyIEP)

  r.get('/portal/profile/student-id-card', GROUP, getStudentIDCard)
  r.get('/portal/profile/parent-id-card', GROUP, getParentIDCard)
  r.get('/portal/profile/id-card/verify', GROUP, verifyCampusPass)

  r.get('/portal/live', GROUP, getLiveRevision)
  r.get('/portal/notifications', GROUP, listFamilyNotifications)
  r.post('/portal/notifications/read-all', GROUP, markAllNotificationsRead)
  r.post('/portal/notifications/clear', GROUP, clearNotifications)
  r.post('/portal/notifications/{id}/read', GROUP, markNotificationRead)

  r.get('/portal/cafeteria/purchases', GROUP, listCafeteriaPurchases)
}

// ---------------------------------------------------------------------------
// calendar

interface CalRow {
  date: string; end_date: string | null; kind: string; title: string; detail: string | null
  starts_at: string | null; venue: string | null; ref_id: string | null; student_name: string | null
}

async function getFamilyCalendar(c: Ctx): Promise<Response> {
  const { scope, studentIds: kids } = await familyChildren(c, c.url.searchParams.get('student_id'))
  const { from, to } = familyDates(c, 30, 120)
  const k = JSON.stringify(kids)
  const db = c.db
  const [hol, exams, terms, events, hw, fees, ptm] = await db.batch([
    db.prepare(`SELECT on_date AS date, to_date AS end_date, kind, name AS title, description AS detail,
                       NULL AS starts_at, NULL AS venue, id AS ref_id, NULL AS student_name
                  FROM holidays
                 WHERE on_date <= ? AND COALESCE(to_date, on_date) >= ?
                   AND applies_to IN ('all','students')
                 ORDER BY on_date`).bind(to, from),
    db.prepare(`SELECT starts_on AS date, ends_on AS end_date, 'exam' AS kind, name AS title, NULL AS detail,
                       NULL AS starts_at, NULL AS venue, id AS ref_id, NULL AS student_name
                  FROM exams
                 WHERE starts_on IS NOT NULL AND starts_on <= ? AND COALESCE(ends_on, starts_on) >= ?
                 ORDER BY starts_on`).bind(to, from),
    db.prepare(`SELECT starts_on AS date, ends_on AS end_date, 'term' AS kind, name AS title, NULL AS detail,
                       NULL AS starts_at, NULL AS venue, id AS ref_id, NULL AS student_name
                  FROM terms
                 WHERE starts_on <= ? AND ends_on >= ?
                 ORDER BY starts_on`).bind(to, from),
    db.prepare(`SELECT e.on_date AS date, e.ends_on AS end_date, e.kind, e.name AS title, e.description AS detail,
                       substr(e.starts_at, 1, 5) AS starts_at, e.venue, e.id AS ref_id, NULL AS student_name
                  FROM school_events e
                 WHERE e.is_published = 1
                   AND e.on_date <= ? AND COALESCE(e.ends_on, e.on_date) >= ?
                   AND (e.section_id IS NULL OR EXISTS (
                         SELECT 1 FROM enrollments en
                          WHERE ${inJSON('en.student_id')} AND en.section_id = e.section_id))
                 ORDER BY e.on_date`).bind(to, from, k),
    db.prepare(`SELECT h.due_on AS date, NULL AS end_date, 'homework' AS kind,
                       COALESCE(NULLIF(h.title, ''), 'Homework') AS title,
                       COALESCE(sub.name, '') AS detail, NULL AS starts_at, NULL AS venue,
                       h.id AS ref_id, ${shortName('st')} AS student_name
                  FROM homework h
                  JOIN enrollments en ON en.section_id = h.section_id
                  JOIN students st ON st.id = en.student_id
                  LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id
                  LEFT JOIN subjects sub ON sub.id = cs.subject_id
                 WHERE ${inJSON('en.student_id')}
                   AND h.due_on IS NOT NULL AND h.due_on BETWEEN ? AND ?
                   AND h.is_published = 1 AND en.status = 'active'
                 ORDER BY h.due_on`).bind(k, from, to),
    db.prepare(`SELECT i.due_on AS date, (i.net_paise - i.paid_paise) AS owed, i.invoice_no,
                       i.id AS ref_id, ${shortName('st')} AS student_name
                  FROM invoices i
                  JOIN students st ON st.id = i.student_id
                 WHERE ${inJSON('i.student_id')}
                   AND i.due_on IS NOT NULL AND i.due_on BETWEEN ? AND ?
                   AND i.status IN ('unpaid','partial','overdue')
                 ORDER BY i.due_on`).bind(k, from, to),
    db.prepare(`SELECT a.on_date AS date, NULL AS end_date, 'ptm_booking' AS kind,
                       COALESCE('Meeting: ' || NULLIF(trim(COALESCE(emp.first_name, '') || ' ' || COALESCE(emp.last_name, '')), ''),
                                'Parent-teacher meeting') AS title,
                       a.purpose AS detail, substr(a.starts_at, 1, 5) AS starts_at, NULL AS venue,
                       a.id AS ref_id, ${shortName('st')} AS student_name
                  FROM appointments a
                  JOIN students st ON st.id = a.student_id
                  LEFT JOIN employees emp ON emp.id = a.with_employee_id
                 WHERE ${inJSON('a.student_id')} AND a.status = 'booked'
                   AND a.on_date BETWEEN ? AND ?
                 ORDER BY a.on_date, a.starts_at`).bind(k, from, to),
  ])
  const entry = (v: CalRow) => ({
    date: v.date, end_date: o(v.end_date), kind: v.kind, title: v.title, detail: o(v.detail),
    starts_at: o(v.starts_at), venue: o(v.venue), ref_id: o(v.ref_id), student_name: o(v.student_name),
  })
  const items: ReturnType<typeof entry>[] = []
  for (const res of [hol, exams, terms, events, hw]) for (const v of res.results as unknown as CalRow[]) items.push(entry(v))
  for (const f of fees.results as { date: string; owed: number; invoice_no: string; ref_id: string; student_name: string }[]) {
    items.push(entry({
      date: f.date, end_date: null, kind: 'fee_due', title: 'Fees due: ' + fmtIndian(Number(f.owed) / 100),
      detail: f.invoice_no, starts_at: null, venue: null, ref_id: f.ref_id, student_name: f.student_name,
    }))
  }
  for (const v of ptm.results as unknown as CalRow[]) items.push(entry(v))
  return ok({ items, from, to, children: scope.studentIds.length })
}

// ---------------------------------------------------------------------------
// parent-teacher meetings

async function listPTMSlots(c: Ctx): Promise<Response> {
  const { studentIds: kids } = await familyChildren(c, c.url.searchParams.get('student_id'))
  const { from, to } = familyDates(c, 0, 90)
  const k = JSON.stringify(kids)
  const rows = await c.db.prepare(`
      SELECT sl.id, ${shortName('emp')} AS teacher, sec.name AS section,
             sl.on_date, substr(sl.starts_at, 1, 5) AS starts_at, sl.minutes, sl.mode, sl.location, sl.notes,
             bk.id AS bk_id, bk.student_id AS bk_student, ${shortName('bs')} AS bk_name
        FROM ptm_slots sl
        JOIN employees emp ON emp.id = sl.employee_id
        LEFT JOIN sections sec ON sec.id = sl.section_id
        LEFT JOIN appointments bk ON bk.id = (
            SELECT a.id FROM appointments a
             WHERE a.with_employee_id = sl.employee_id
               AND a.on_date = sl.on_date AND substr(a.starts_at, 1, 5) = substr(sl.starts_at, 1, 5)
               AND a.status = 'booked'
             LIMIT 1)
        LEFT JOIN students bs ON bs.id = bk.student_id
       WHERE sl.is_open = 1
         AND sl.on_date BETWEEN ? AND ?
         AND (sl.section_id IS NULL OR EXISTS (
               SELECT 1 FROM enrollments en
                WHERE ${inJSON('en.student_id')} AND en.section_id = sl.section_id))
       ORDER BY sl.on_date, sl.starts_at
       LIMIT 300`).bind(from, to, k).all<{
    id: string; teacher: string; section: string | null; on_date: string; starts_at: string; minutes: number
    mode: string; location: string | null; notes: string | null; bk_id: string | null; bk_student: string | null; bk_name: string | null
  }>()
  const items = rows.results.map((v) => ({
    id: v.id, teacher: v.teacher, section: o(v.section), on_date: v.on_date, starts_at: v.starts_at,
    minutes: v.minutes, mode: v.mode, location: o(v.location), notes: o(v.notes),
    taken: v.bk_id !== null,
    booked_for: v.bk_student !== null && kids.includes(v.bk_student) ? o(v.bk_name) : undefined,
  }))
  return ok({ items })
}

async function listPTMBookings(c: Ctx): Promise<Response> {
  const { studentIds: kids } = await familyChildren(c, c.url.searchParams.get('student_id'))
  const today = todayIST()
  const rows = await c.db.prepare(`
      SELECT a.id, a.student_id, ${shortName('st')} AS student_name,
             NULLIF(trim(COALESCE(emp.first_name, '') || ' ' || COALESCE(emp.last_name, '')), '') AS teacher,
             a.on_date, substr(a.starts_at, 1, 5) AS starts_at, a.minutes, a.purpose, a.status, a.outcome,
             (a.status = 'booked' AND a.on_date >= ?) AS cancellable,
             n.concerns, n.agreed_actions
        FROM appointments a
        JOIN students st ON st.id = a.student_id
        LEFT JOIN employees emp ON emp.id = a.with_employee_id
        LEFT JOIN ptm_notes n ON n.id = (
            SELECT p.id FROM ptm_notes p
             WHERE p.student_id = a.student_id AND p.met_on = a.on_date
               AND p.visible_to_family = 1
             LIMIT 1)
       WHERE ${inJSON('a.student_id')}
       ORDER BY a.on_date DESC, a.starts_at DESC
       LIMIT 100`).bind(today, JSON.stringify(kids)).all<{
    id: string; student_id: string; student_name: string; teacher: string | null; on_date: string; starts_at: string
    minutes: number; purpose: string; status: string; outcome: string | null; cancellable: number
    concerns: string | null; agreed_actions: string | null
  }>()
  const items = rows.results.map((v) => ({
    id: v.id, student_id: v.student_id, student_name: v.student_name, teacher: o(v.teacher),
    on_date: v.on_date, starts_at: v.starts_at, minutes: v.minutes, purpose: v.purpose, status: v.status,
    outcome: o(v.outcome), cancellable: !!v.cancellable, concerns: o(v.concerns), agreed_actions: o(v.agreed_actions),
  }))
  return ok({ items })
}

async function bookPTMSlot(c: Ctx): Promise<Response> {
  const req = await readJSON<{ slot_id?: unknown; student_id?: unknown; note?: unknown }>(c.req)
  const slotID = str(req.slot_id)
  if (!isUUID(slotID)) throw badRequest('invalid slot id')
  const { studentId } = await portalChild(c, typeof req.student_id === 'string' ? req.student_id : '')

  const slot = await c.db.prepare(`
      SELECT sl.employee_id, sl.section_id, sl.on_date, sl.starts_at, sl.minutes, sl.is_open,
             ${shortName('emp')} AS teacher
        FROM ptm_slots sl
        JOIN employees emp ON emp.id = sl.employee_id
       WHERE sl.id = ?`).bind(slotID).first<{
    employee_id: string; section_id: string | null; on_date: string; starts_at: string; minutes: number; is_open: number; teacher: string
  }>()
  if (!slot) throw notFound()
  if (!slot.is_open) throw forbidden('that slot is no longer being offered')
  const onDate = slot.on_date.slice(0, 10)
  if (onDate < todayIST()) throw forbidden('that slot is in the past')
  if (slot.section_id !== null) {
    const en = await c.db.prepare(`SELECT 1 AS x FROM enrollments WHERE student_id = ? AND section_id = ? LIMIT 1`)
      .bind(studentId, slot.section_id).first()
    if (!en) throw notFound()
  }
  const user = await c.db.prepare(`SELECT full_name, phone FROM users WHERE id = ?`).bind(c.id.userId)
    .first<{ full_name: string; phone: string | null }>()
  if (!user) throw notFound()
  const note = str(req.note)
  const purpose = note ? 'Parent-teacher meeting: ' + note : 'Parent-teacher meeting'
  const startText = slot.starts_at.length === 5 ? slot.starts_at + ':00' : slot.starts_at

  // appointments_no_double_booking (a partial unique index Postgres had) is the
  // NOT EXISTS guard; the notification only lands when the appointment did.
  const apptID = crypto.randomUUID()
  const inst = institutionId(c)
  const ts = now()
  const title = 'Parent-teacher meeting booked'
  const body = `${monDJan(onDate)} with ${slot.teacher} at ${startText.slice(0, 5)}`
  const [ins] = await c.db.batch([
    c.db.prepare(`INSERT INTO appointments (id, institution_id, with_employee_id, student_id, requested_by,
                    visitor_name, phone, on_date, starts_at, minutes, purpose, status, created_at)
                  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?
                   WHERE NOT EXISTS (SELECT 1 FROM appointments a
                                      WHERE a.with_employee_id = ? AND a.on_date = ?
                                        AND substr(a.starts_at, 1, 5) = substr(?, 1, 5) AND a.status = 'booked')`)
      .bind(apptID, inst, slot.employee_id, studentId, c.id.userId, user.full_name, user.phone, onDate, startText,
        slot.minutes, purpose, ts, slot.employee_id, onDate, startText),
    c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
                  SELECT ?, ?, ?, ?, 'ptm', ?, ?, '/portal/school-life/ptm', 'appointment', ?, ?
                   WHERE EXISTS (SELECT 1 FROM appointments WHERE id = ?)
                     AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = ? AND n.kind = 'ptm' AND n.source_kind IS NOT NULL
                                      AND COALESCE(n.source_id, '') = ? AND COALESCE(n.student_id, '') = ?)`)
      .bind(crypto.randomUUID(), inst, c.id.userId, studentId, title, body, apptID, ts, apptID, c.id.userId, apptID, studentId),
  ])
  if (!ins.meta.changes) throw forbidden('that slot has just been taken')
  // emitPTMReminder (message_trigger_rules 'ptm.upcoming' -> message_log) is not
  // ported; Go swallows its error so the booking stands either way.
  return created({ id: apptID })
}

async function cancelPTMBooking(c: Ctx): Promise<Response> {
  const res = await resolveScope(c)
  const apptID = c.params.id
  if (!isUUID(apptID)) throw badRequest('invalid booking id')
  if (res.studentIds.length === 0) throw notFound()
  const k = JSON.stringify(res.studentIds)
  const [upd] = await c.db.batch([
    c.db.prepare(`UPDATE appointments SET status = 'cancelled'
                   WHERE id = ? AND ${inJSON('student_id')} AND status = 'booked'`).bind(apptID, k),
    // dropPTMReminder: only a queued reminder goes, and only for a meeting now off.
    c.db.prepare(`DELETE FROM message_log
                   WHERE institution_id = ? AND status = 'queued'
                     AND source_kind = 'trigger_rule' AND occurrence_key = ?
                     AND EXISTS (SELECT 1 FROM appointments WHERE id = ? AND status = 'cancelled' AND ${inJSON('student_id')})`)
      .bind(institutionId(c), apptID, apptID, k),
  ])
  if (upd.meta.changes === 1) return ok({ status: 'cancelled' })
  const found = await c.db.prepare(`SELECT 1 AS x FROM appointments WHERE id = ? AND ${inJSON('student_id')}`)
    .bind(apptID, k).first()
  if (found) throw forbidden('that meeting can no longer be cancelled')
  throw notFound()
}

// ---------------------------------------------------------------------------
// gallery

const LIVE_MEDIA = `em.event_id = e.id AND em.published_at IS NOT NULL AND f.deleted_at IS NULL`

async function listGalleryAlbums(c: Ctx): Promise<Response> {
  const { studentIds: kids } = await familyChildren(c, c.url.searchParams.get('student_id'))
  const rows = await c.db.prepare(`
      SELECT e.id, e.name, e.kind, e.on_date, e.venue, e.description,
             (SELECT count(*) FROM event_media em JOIN files f ON f.id = em.file_id
               WHERE ${LIVE_MEDIA} AND em.media_kind = 'photo') AS photos,
             (SELECT count(*) FROM event_media em JOIN files f ON f.id = em.file_id
               WHERE ${LIVE_MEDIA} AND em.media_kind = 'video') AS videos,
             (SELECT em.file_id FROM event_media em JOIN files f ON f.id = em.file_id
               WHERE ${LIVE_MEDIA} ORDER BY em.sort_order, em.created_at LIMIT 1) AS cover,
             sec.name AS section
        FROM school_events e
        LEFT JOIN sections sec ON sec.id = e.section_id
       WHERE e.is_published = 1
         AND (e.section_id IS NULL OR EXISTS (
               SELECT 1 FROM enrollments en
                WHERE ${inJSON('en.student_id')} AND en.section_id = e.section_id))
       ORDER BY e.on_date DESC
       LIMIT 100`).bind(JSON.stringify(kids)).all<{
    id: string; name: string; kind: string; on_date: string; venue: string | null; description: string | null
    photos: number; videos: number; cover: string | null; section: string | null
  }>()
  const items = rows.results.map((v) => ({
    id: v.id, name: v.name, kind: v.kind, on_date: v.on_date, venue: o(v.venue), description: o(v.description),
    photo_count: v.photos, video_count: v.videos, cover_file_id: o(v.cover), section: o(v.section),
  }))
  return ok({ items })
}

async function getGalleryAlbum(c: Ctx): Promise<Response> {
  const { studentIds: kids } = await familyChildren(c, c.url.searchParams.get('student_id'))
  const eventID = c.params.id
  if (!isUUID(eventID)) throw badRequest('invalid album id')
  const a = await c.db.prepare(`
      SELECT e.id, e.name, e.kind, e.on_date, e.venue, e.description, sec.name AS section
        FROM school_events e
        LEFT JOIN sections sec ON sec.id = e.section_id
       WHERE e.id = ? AND e.is_published = 1
         AND (e.section_id IS NULL OR EXISTS (
               SELECT 1 FROM enrollments en
                WHERE ${inJSON('en.student_id')} AND en.section_id = e.section_id))`)
    .bind(eventID, JSON.stringify(kids)).first<{
      id: string; name: string; kind: string; on_date: string; venue: string | null; description: string | null; section: string | null
    }>()
  if (!a) throw notFound()
  const rows = await c.db.prepare(`
      SELECT em.id, em.file_id, em.media_kind, em.caption, f.original_name, f.content_type, f.size_bytes, em.published_at
        FROM event_media em
        JOIN files f ON f.id = em.file_id
       WHERE em.event_id = ? AND em.published_at IS NOT NULL AND f.deleted_at IS NULL
       ORDER BY em.sort_order, em.created_at
       LIMIT 500`).bind(eventID).all<{
    id: string; file_id: string; media_kind: string; caption: string | null; original_name: string
    content_type: string; size_bytes: number; published_at: string
  }>()
  let photos = 0, videos = 0
  const items = rows.results.map((v) => {
    if (v.media_kind === 'photo') photos++; else videos++
    return {
      id: v.id, file_id: v.file_id, media_kind: v.media_kind, caption: o(v.caption), original_name: v.original_name,
      content_type: v.content_type, size_bytes: Number(v.size_bytes), published_on: ist(v.published_at)?.date ?? '',
    }
  })
  const album = {
    id: a.id, name: a.name, kind: a.kind, on_date: a.on_date, venue: o(a.venue), description: o(a.description),
    photo_count: photos, video_count: videos, section: o(a.section),
  }
  return ok({ album, items })
}

// ---------------------------------------------------------------------------
// event seating passes

const PASS_SELECT = `
  SELECT p.id, p.event_id, e.name AS event_name, e.on_date, substr(e.starts_at, 1, 5) AS starts_at, e.venue,
         p.student_id, ${shortName('st')} AS student_name,
         p.row_label, p.seat_from, p.seats, p.code, p.note, p.issued_at, p.admitted_at, p.revoked_at
    FROM event_seat_passes p
    JOIN school_events e ON e.id = p.event_id
    JOIN students st ON st.id = p.student_id`
interface PassRow {
  id: string; event_id: string; event_name: string; on_date: string; starts_at: string | null; venue: string | null
  student_id: string; student_name: string; row_label: string | null; seat_from: number | null; seats: number
  code: string; note: string | null; issued_at: string; admitted_at: string | null; revoked_at: string | null
}
const passJSON = (v: PassRow) => ({
  id: v.id, event_id: v.event_id, event_name: v.event_name, on_date: v.on_date, starts_at: o(v.starts_at),
  venue: o(v.venue), student_id: v.student_id, student_name: v.student_name, row_label: o(v.row_label),
  seat_from: o(v.seat_from), seats: v.seats, code: v.code, note: o(v.note),
  issued_at: istStamp(v.issued_at) ?? '', admitted_at: o(istStamp(v.admitted_at)), revoked_at: o(istStamp(v.revoked_at)),
})

async function listEventPasses(c: Ctx): Promise<Response> {
  const { studentIds: kids } = await familyChildren(c, c.url.searchParams.get('student_id'))
  const rows = await c.db.prepare(`${PASS_SELECT}
       WHERE ${inJSON('p.student_id')}
       ORDER BY e.on_date DESC, p.issued_at DESC
       LIMIT 100`).bind(JSON.stringify(kids)).all<PassRow>()
  return ok({ items: rows.results.map(passJSON) })
}

/** Port of eventPassCode: eight digits from the cryptographic source. */
function eventPassCode(): string {
  const b = crypto.getRandomValues(new Uint32Array(1))
  // Rejection sampling keeps the draw uniform over 0..99,999,999.
  while (b[0] >= 4200000000) crypto.getRandomValues(b)
  return String(b[0] % 100000000).padStart(8, '0')
}

async function claimEventPass(c: Ctx): Promise<Response> {
  const req = await readJSON<{ event_id?: unknown; student_id?: unknown; seats?: unknown }>(c.req)
  const eventID = str(req.event_id)
  if (!isUUID(eventID)) throw badRequest('invalid event id')
  const { studentId } = await portalChild(c, typeof req.student_id === 'string' ? req.student_id : '')
  let seats = typeof req.seats === 'number' ? Math.trunc(req.seats) : 0
  if (seats <= 0) seats = 2
  if (seats > 20) throw badRequest('at most 20 seats')

  const ev = await c.db.prepare(`SELECT name, on_date, section_id FROM school_events WHERE id = ? AND is_published = 1`)
    .bind(eventID).first<{ name: string; on_date: string; section_id: string | null }>()
  if (!ev) throw notFound()
  const onDate = ev.on_date.slice(0, 10)
  if (onDate < todayIST()) throw forbidden('that event has already happened')
  if (ev.section_id !== null) {
    const en = await c.db.prepare(`SELECT 1 AS x FROM enrollments WHERE student_id = ? AND section_id = ? LIMIT 1`)
      .bind(studentId, ev.section_id).first()
    if (!en) throw notFound()
  }

  /* The next free seat is computed inside the INSERT, so the allocation and
     the write are one statement (Go locked the event row FOR UPDATE).
     event_seat_passes_one_live (partial unique index) is the NOT EXISTS. */
  const passID = crypto.randomUUID()
  const code = eventPassCode()
  const inst = institutionId(c)
  const ts = now()
  const [ins] = await c.db.batch([
    c.db.prepare(`INSERT INTO event_seat_passes (id, institution_id, event_id, student_id, row_label, seat_from, seats, code, issued_by, issued_at)
                  SELECT ?, ?, ?, ?, char(65 + (s.n - 1) / 20), s.n, ?, ?, ?, ?
                    FROM (SELECT COALESCE(MAX(seat_from + seats), 1) AS n FROM event_seat_passes
                           WHERE event_id = ? AND revoked_at IS NULL AND seat_from IS NOT NULL) s
                   WHERE NOT EXISTS (SELECT 1 FROM event_seat_passes
                                      WHERE event_id = ? AND student_id = ? AND revoked_at IS NULL)`)
      .bind(passID, inst, eventID, studentId, seats, code, c.id.userId, ts, eventID, eventID, studentId),
    c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
                  SELECT ?, ?, ?, ?, 'event', ?,
                         'Row ' || p.row_label || ', seats ' || p.seat_from || '–' || (p.seat_from + p.seats - 1) || ' on ' || ?,
                         '/portal/school-life/events', 'event_pass', p.id, ?
                    FROM event_seat_passes p
                   WHERE p.id = ?
                     AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = ? AND n.kind = 'event' AND n.source_kind IS NOT NULL
                                      AND COALESCE(n.source_id, '') = ? AND COALESCE(n.student_id, '') = ?)`)
      .bind(crypto.randomUUID(), inst, c.id.userId, studentId, 'Seats confirmed for ' + ev.name, monDJan(onDate), ts,
        passID, c.id.userId, passID, studentId),
  ])
  if (!ins.meta.changes) throw forbidden('this child already has a pass for that event')
  const p = await c.db.prepare(`SELECT row_label, seat_from FROM event_seat_passes WHERE id = ?`).bind(passID)
    .first<{ row_label: string; seat_from: number }>()
  return created({ id: passID, code, row_label: p?.row_label ?? '', seat_from: p?.seat_from ?? 0, seats })
}

async function verifyEventPass(c: Ctx): Promise<Response> {
  requirePerm(c, FRONT_DESK)
  const code = (c.url.searchParams.get('code') ?? '').trim()
  if (code === '') return ok({ valid: false, reason: 'no code presented' })
  const row = await c.db.prepare(`${PASS_SELECT} WHERE p.code = ?`).bind(code).first<PassRow>()
  if (!row) return ok({ valid: false, reason: 'no such pass' })
  const pass = passJSON(row)
  if (pass.revoked_at !== undefined) return ok({ valid: false, reason: 'pass withdrawn', pass })
  if (pass.admitted_at !== undefined) return ok({ valid: false, reason: 'already admitted at ' + pass.admitted_at, pass })
  if (pass.on_date !== todayIST()) return ok({ valid: false, reason: 'pass is for ' + pass.on_date, pass })
  return ok({ valid: true, pass })
}

async function admitEventPass(c: Ctx): Promise<Response> {
  requirePerm(c, FRONT_DESK)
  const passID = c.params.id
  if (!isUUID(passID)) throw badRequest('invalid pass id')
  const res = await c.db.prepare(`UPDATE event_seat_passes SET admitted_at = ?, admitted_by = ?
                                   WHERE id = ? AND admitted_at IS NULL AND revoked_at IS NULL`)
    .bind(now(), c.id.userId, passID).run()
  if (res.meta.changes === 1) return ok({ status: 'admitted' })
  throw forbidden('that pass has already been used or withdrawn')
}

// ---------------------------------------------------------------------------
// support plan and goals

/** Port of goalPercent: newest observation between baseline and target, or nil. */
function goalPercent(baseline: number | null, target: number | null, latest: number | null): number | null {
  if (baseline === null || target === null || latest === null || target === baseline) return null
  const pct = Math.trunc(((latest - baseline) / (target - baseline)) * 100)
  return Math.min(100, Math.max(0, pct))
}

async function getFamilyIEP(c: Ctx): Promise<Response> {
  const studentID = await whichChild(c)
  const [stu, planRes] = await c.db.batch([
    c.db.prepare(`SELECT ${fullName('st')} AS name FROM students st WHERE st.id = ?`).bind(studentID),
    c.db.prepare(`SELECT id, concern, accommodations, exam_concession, external_support, review_on, status
                    FROM student_support_plans
                   WHERE student_id = ? AND status <> 'closed'
                   ORDER BY created_at DESC LIMIT 1`).bind(studentID),
  ])
  const s = stu.results[0] as { name: string } | undefined
  if (!s) throw notFound()
  const pr = planRes.results[0] as {
    id: string; concern: string | null; accommodations: string | null; exam_concession: string | null
    external_support: string | null; review_on: string | null; status: string | null
  } | undefined
  const plan = pr ? {
    id: pr.id, concern: o(pr.concern), accommodations: o(pr.accommodations), exam_concession: o(pr.exam_concession),
    external_support: o(pr.external_support), review_on: o(pr.review_on), status: o(pr.status),
  } : {}
  const goals: Record<string, unknown>[] = []
  if (pr) {
    const g = await c.db.prepare(`
        SELECT g.id, g.title, g.domain, g.baseline_value, g.target_value, g.unit, g.higher_is_better,
               g.starts_on, g.target_on, g.status, u.value AS latest, u.on_date AS latest_on
          FROM student_support_goals g
          LEFT JOIN student_support_goal_updates u ON u.id = (
              SELECT gu.id FROM student_support_goal_updates gu
               WHERE gu.goal_id = g.id AND gu.value IS NOT NULL
               ORDER BY gu.on_date DESC LIMIT 1)
         WHERE g.plan_id = ? AND g.visible_to_family = 1
         ORDER BY g.status, g.target_on NULLS LAST, g.created_at`).bind(pr.id).all<{
      id: string; title: string; domain: string; baseline_value: string | null; target_value: string | null
      unit: string | null; higher_is_better: number; starts_on: string; target_on: string | null; status: string
      latest: string | null; latest_on: string | null
    }>()
    const hist = g.results.length
      ? await c.db.batch(g.results.map((row) => c.db.prepare(`
          SELECT on_date, value, note FROM student_support_goal_updates
           WHERE goal_id = ? ORDER BY on_date DESC LIMIT 24`).bind(row.id)))
      : []
    g.results.forEach((row, i) => {
      const baseline = numOrNull(row.baseline_value), target = numOrNull(row.target_value), latest = numOrNull(row.latest)
      const updates = (hist[i].results as { on_date: string; value: string | null; note: string | null }[]).map((u) => ({
        on_date: u.on_date, value: o(numOrNull(u.value)), note: o(u.note),
      }))
      goals.push({
        id: row.id, title: row.title, domain: row.domain, baseline_value: o(baseline), target_value: o(target),
        latest_value: o(latest), latest_on: o(row.latest_on), unit: o(row.unit), higher_is_better: !!row.higher_is_better,
        starts_on: row.starts_on, target_on: o(row.target_on), status: row.status,
        progress_percent: o(goalPercent(baseline, target, latest)), updates,
      })
    })
  }
  return ok({ student_id: studentID, student_name: s.name, plan, goals, has_plan: !!pr })
}

// ---------------------------------------------------------------------------
// identity at the gate

const PASS_WINDOW = 150 // seconds
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** base32.StdEncoding without padding. */
function base32(bytes: Uint8Array): string {
  let out = '', bits = 0, value = 0
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
/** D1 hands a BLOB back as an array of numbers or an ArrayBuffer. */
function toBytes(v: unknown): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (Array.isArray(v)) return Uint8Array.from(v as number[])
  if (typeof v === 'string') {
    const m = /^\\x([0-9a-f]*)$/i.exec(v)
    if (m) return Uint8Array.from(m[1].match(/../g) ?? [], (h) => parseInt(h, 16))
    return new TextEncoder().encode(v)
  }
  return new Uint8Array(0)
}
/** Port of passCodeAt: HMAC-SHA256(secret, "serial|window"), base32, first eight. */
async function passCodeAt(secret: Uint8Array, serial: string, win: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${serial}|${win}`)))
  return base32(mac).slice(0, 8)
}
const passWindowNow = () => Math.floor(Date.now() / 1000 / PASS_WINDOW)

async function buildPassPayload(serial: string, secret: Uint8Array) {
  const win = passWindowNow()
  const code = await passCodeAt(secret, serial, win)
  const elapsed = Math.floor(Date.now() / 1000) - win * PASS_WINDOW
  return { serial, code, scan: serial + '.' + code, expires_in_seconds: PASS_WINDOW - elapsed }
}

/** Port of ensurePass: the caller's live card, issued on first view. */
async function ensurePass(c: Ctx, user: string | null, student: string | null, prefix: string): Promise<{ serial: string; secret: Uint8Array }> {
  const inst = institutionId(c)
  const find = () => c.db.prepare(`
      SELECT serial, secret FROM campus_entry_passes
       WHERE institution_id = ? AND revoked_at IS NULL
         AND COALESCE(user_id, '') = COALESCE(?, '') AND COALESCE(student_id, '') = COALESCE(?, '')
       LIMIT 1`).bind(inst, user, student).first<{ serial: string; secret: unknown }>()
  let row = await find()
  if (!row) {
    const serial = prefix + '-' + base32(crypto.getRandomValues(new Uint8Array(5))).slice(0, 8)
    const secret = crypto.getRandomValues(new Uint8Array(32))
    // The Postgres unique index on the holder becomes this NOT EXISTS guard.
    await c.db.prepare(`
        INSERT INTO campus_entry_passes (id, institution_id, user_id, student_id, serial, secret, issued_at)
        SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM campus_entry_passes
                            WHERE institution_id = ? AND revoked_at IS NULL
                              AND COALESCE(user_id, '') = COALESCE(?, '') AND COALESCE(student_id, '') = COALESCE(?, ''))`)
      .bind(crypto.randomUUID(), inst, user, student, serial, secret.buffer, now(), inst, user, student).run()
    row = await find()
    if (!row) throw new Error('campus pass not issued')
  }
  return { serial: row.serial, secret: toBytes(row.secret) }
}

async function getStudentIDCard(c: Ctx): Promise<Response> {
  const studentID = await whichChild(c)
  const v = await c.db.prepare(`
      SELECT st.id AS student_id, ${fullName('st')} AS full_name, st.admission_no, cl.name AS class_name,
             sec.name AS section_name, en.roll_no, st.date_of_birth, st.blood_group, sh.allergies, h.name AS house,
             st.photo_file_id, gd.full_name AS guardian_name, gd.phone AS guardian_phone, i.name AS school_name,
             cam.name AS campus_name, st.status
        FROM students st
        JOIN institutions i ON i.id = st.institution_id
        LEFT JOIN campuses cam ON cam.id = st.campus_id
        LEFT JOIN houses h ON h.id = st.house_id
        LEFT JOIN student_health sh ON sh.student_id = st.id
        LEFT JOIN enrollments en ON en.id = (
            SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
        LEFT JOIN classes cl ON cl.id = en.class_id
        LEFT JOIN sections sec ON sec.id = en.section_id
        LEFT JOIN guardians gd ON gd.id = (
            SELECT sg.guardian_id FROM student_guardians sg
             WHERE sg.student_id = st.id
             ORDER BY sg.is_primary DESC, sg.is_emergency DESC LIMIT 1)
       WHERE st.id = ?`).bind(studentID).first<{
    student_id: string; full_name: string; admission_no: string; class_name: string | null; section_name: string | null
    roll_no: number | null; date_of_birth: string | null; blood_group: string | null; allergies: string | null
    house: string | null; photo_file_id: string | null; guardian_name: string | null; guardian_phone: string | null
    school_name: string; campus_name: string | null; status: string
  }>()
  if (!v) throw notFound()
  const { serial, secret } = await ensurePass(c, null, studentID, 'ST')
  const card = {
    student_id: v.student_id, full_name: v.full_name, admission_no: v.admission_no, class_name: o(v.class_name),
    section_name: o(v.section_name), roll_no: o(v.roll_no), date_of_birth: o(v.date_of_birth?.slice(0, 10)),
    blood_group: o(v.blood_group), allergies: o(v.allergies), house: o(v.house), photo_file_id: o(v.photo_file_id),
    guardian_name: o(v.guardian_name), guardian_phone: o(v.guardian_phone), school_name: v.school_name,
    campus_name: o(v.campus_name), status: v.status,
  }
  return ok({ card, pass: await buildPassPayload(serial, secret) })
}

async function getParentIDCard(c: Ctx): Promise<Response> {
  const res = await resolveScope(c)
  const u = await c.db.prepare(`
      SELECT u.id AS user_id, u.full_name, u.phone, u.email,
             (SELECT g.relation FROM guardians g WHERE g.user_id = u.id LIMIT 1) AS relation,
             i.name AS school_name
        FROM users u
        JOIN institutions i ON i.id = u.institution_id
       WHERE u.id = ?`).bind(c.id.userId).first<{
    user_id: string; full_name: string; phone: string | null; email: string | null; relation: string | null; school_name: string
  }>()
  if (!u) throw notFound()
  let children: Record<string, unknown>[] = []
  if (res.studentIds.length > 0) {
    const kids = await c.db.prepare(`
        SELECT st.id AS student_id, ${shortName('st')} AS full_name, cl.name AS class_name, sec.name AS section_name
          FROM students st
          LEFT JOIN enrollments en ON en.id = (
              SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
          LEFT JOIN classes cl ON cl.id = en.class_id
          LEFT JOIN sections sec ON sec.id = en.section_id
         WHERE ${inJSON('st.id')}
         ORDER BY st.first_name`).bind(JSON.stringify(res.studentIds)).all<{
      student_id: string; full_name: string; class_name: string | null; section_name: string | null
    }>()
    children = kids.results.map((k) => ({
      student_id: k.student_id, full_name: k.full_name, class_name: o(k.class_name), section_name: o(k.section_name),
    }))
  }
  const { serial, secret } = await ensurePass(c, c.id.userId, null, 'PG')
  const card = {
    user_id: u.user_id, full_name: u.full_name, phone: o(u.phone), email: o(u.email), relation: o(u.relation),
    school_name: u.school_name,
  }
  return ok({ card, children, pass: await buildPassPayload(serial, secret) })
}

/** subtle.ConstantTimeCompare: 0 for unequal lengths, otherwise a full-length scan. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

async function verifyCampusPass(c: Ctx): Promise<Response> {
  requirePerm(c, FRONT_DESK)
  const raw = (c.url.searchParams.get('code') ?? '').trim()
  if (raw === '') return ok({ valid: false, reason: 'no code presented' })
  const dot = raw.indexOf('.')
  if (dot < 0) return ok({ valid: false, reason: 'unreadable pass' })
  const serial = raw.slice(0, dot), code = raw.slice(dot + 1)
  const row = await c.db.prepare(`
      SELECT p.secret,
             COALESCE(u.full_name, ${shortName('st')}) AS holder,
             CASE WHEN p.user_id IS NOT NULL THEN 'guardian' ELSE 'student' END AS kind,
             COALESCE(u.phone, st.admission_no) AS detail
        FROM campus_entry_passes p
        LEFT JOIN users u ON u.id = p.user_id
        LEFT JOIN students st ON st.id = p.student_id
       WHERE p.serial = ? AND p.revoked_at IS NULL`).bind(serial)
    .first<{ secret: unknown; holder: string | null; kind: string; detail: string | null }>()
  if (!row) return ok({ valid: false, reason: 'no such pass' })
  const secret = toBytes(row.secret)
  const w = passWindowNow()
  for (const win of [w, w - 1, w + 1]) {
    if (constantTimeEqual(await passCodeAt(secret, serial, win), code)) {
      return ok({ valid: true, holder: row.holder ?? '', holder_kind: row.kind, detail: row.detail, serial })
    }
  }
  return ok({ valid: false, reason: 'code has expired. Ask for a refreshed screen', serial })
}

// ---------------------------------------------------------------------------
// live revision (live.go)

async function getLiveRevision(c: Ctx): Promise<Response> {
  const res = await resolveScope(c)
  const mine = res.studentIds.length > 0 ? 1 : 0
  const k = JSON.stringify(res.studentIds)
  const scoped = (col: string) => `(? = 0 OR ${inJSON(col)})`
  const r = await c.db.prepare(`
      SELECT
        (SELECT max(a.marked_at) FROM student_attendance a WHERE ${scoped('a.student_id')}) AS att_marked,
        (SELECT max(a.corrected_at) FROM student_attendance a WHERE ${scoped('a.student_id')}) AS att_corrected,
        (SELECT max(m.entered_at) FROM marks m WHERE ${scoped('m.student_id')}) AS marks,
        (SELECT max(i.updated_at) FROM invoices i WHERE ${scoped('i.student_id')}) AS invoices,
        (SELECT max(n.created_at) FROM notifications n WHERE n.user_id = ?) AS notes,
        (SELECT max(h.updated_at) FROM homework h) AS homework,
        (SELECT max(rc.published_at) FROM report_cards rc WHERE rc.is_published = 1 AND ${scoped('rc.student_id')}) AS results,
        (SELECT max(fc.decided_at) FROM fee_concessions fc WHERE ${scoped('fc.student_id')}) AS concessions`)
    .bind(mine, k, mine, k, mine, k, mine, k, c.id.userId, mine, k, mine, k)
    .first<Record<string, string | null>>()
  const v = r ?? {}
  // Postgres greatest() ignores nulls; concat_ws skips them.
  const a1 = parseTs(v.att_marked), a2 = parseTs(v.att_corrected)
  const att = a1 && a2 ? (a1 >= a2 ? v.att_marked : v.att_corrected) : (a1 ? v.att_marked : a2 ? v.att_corrected : null)
  const parts = [att, v.marks, v.invoices, v.notes, v.homework, v.results, v.concessions]
    .map((s) => ist(s)?.compact ?? null).filter((s): s is string => s !== null)
  const n = nowInIndia()
  return json({ rev: parts.join('|'), at: `${p2(n.getUTCHours())}:${p2(n.getUTCMinutes())}:${p2(n.getUTCSeconds())}` },
    200, { 'Cache-Control': 'no-store, max-age=0' })
}

// ---------------------------------------------------------------------------
// alerts

/** Dedup guard of the Postgres partial unique index on notifications. */
const notDelivered = (kind: string, sourceCol: string, studentCol: string) =>
  `NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = ? AND n.kind = '${kind}' AND n.source_kind IS NOT NULL
                  AND COALESCE(n.source_id, '') = COALESCE(${sourceCol}, '') AND COALESCE(n.student_id, '') = COALESCE(${studentCol}, ''))`

/** Port of deliverFamilyAlerts: materialise circulars, absences, overdue fees and homework into the feed. */
export function deliverFamilyAlerts(c: Ctx, user: string, kids: string[]): D1PreparedStatement[] {
  const inst = institutionId(c)
  const k = JSON.stringify(kids)
  const nowISO = now()
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const today = todayIST()
  const n = nowInIndia()
  const fortnightAgo = ymd(addDays(n, -14))
  const weekOn = ymd(addDays(n, 7))
  return [
    c.db.prepare(`
      INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, source_kind, source_id, created_at)
      SELECT ${SQL_UUID}, ?, ?, 'circular', a.title, substr(a.body, 1, 240),
             '/portal/circulars', 'announcement', a.id, a.publish_at
        FROM announcements a
       WHERE a.audience_role IN ('all','parents')
         AND a.publish_at <= ? AND a.publish_at > ?
         AND (a.expires_at IS NULL OR a.expires_at > ?)
         AND (NOT EXISTS (SELECT 1 FROM announcement_sections s WHERE s.announcement_id = a.id)
              OR EXISTS (SELECT 1 FROM announcement_sections s
                           JOIN enrollments en ON en.section_id = s.section_id
                          WHERE s.announcement_id = a.id AND ${inJSON('en.student_id')}))
         AND ${notDelivered('circular', 'a.id', 'NULL')}`)
      .bind(inst, user, nowISO, monthAgo, nowISO, k, user),
    c.db.prepare(`
      INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
      SELECT ${SQL_UUID}, ?, ?, sa.student_id, 'attendance',
             ${shortName('st')} || ' was marked absent',
             ${sqlDayDDMon('sa.on_date')}, '/portal/attendance', 'attendance', sa.id,
             COALESCE(sa.marked_at, ?)
        FROM student_attendance sa
        JOIN students st ON st.id = sa.student_id
       WHERE ${inJSON('sa.student_id')} AND sa.status = 'absent' AND sa.on_date > ?
         AND ${notDelivered('attendance', 'sa.id', 'sa.student_id')}`)
      .bind(inst, user, nowISO, k, fortnightAgo, user),
    c.db.prepare(`
      INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
      SELECT ${SQL_UUID}, ?, ?, inv.student_id, 'fee_due',
             'Fees overdue: ' || inv.invoice_no,
             printf('%.2f', (inv.net_paise - inv.paid_paise) / 100.0) || ' due since ' || ${sqlDDMon('inv.due_on')},
             '/portal/fees', 'invoice', inv.id,
             strftime('%Y-%m-%dT%H:%M:%fZ', date(inv.due_on, '+1 day'), '-330 minutes')
        FROM invoices inv
       WHERE ${inJSON('inv.student_id')}
         AND inv.status <> 'cancelled'
         AND inv.due_on IS NOT NULL AND inv.due_on < ?
         AND inv.net_paise > inv.paid_paise
         AND ${notDelivered('fee_due', 'inv.id', 'inv.student_id')}`)
      .bind(inst, user, k, today, user),
    c.db.prepare(`
      INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
      SELECT ${SQL_UUID}, ?, ?, x.student_id, 'homework', x.title, x.body, '/portal/homework', 'homework', x.hw_id, x.created_at
        FROM (SELECT DISTINCT en.student_id, hw.id AS hw_id, hw.title, 'Due ' || ${sqlDDMon('hw.due_on')} AS body, hw.created_at
                FROM homework hw
                JOIN enrollments en ON en.section_id = hw.section_id
               WHERE ${inJSON('en.student_id')} AND hw.is_published = 1
                 AND hw.due_on IS NOT NULL AND hw.due_on BETWEEN ? AND ?) x
       WHERE ${notDelivered('homework', 'x.hw_id', 'x.student_id')}`)
      .bind(inst, user, k, today, weekOn, user),
  ]
}

async function listFamilyNotifications(c: Ctx): Promise<Response> {
  const { scope, studentIds: kids } = await familyChildren(c, c.url.searchParams.get('student_id'))
  const user = c.id.userId
  const hidden = can(c.id, LEAVE_APPROVE) ? [] : ['leave_request']
  const hiddenSql = `AND n.kind NOT IN (${marks(hidden)})`
  const list = c.db.prepare(`
      SELECT n.id, n.kind, n.title, n.body, n.link, n.student_id, ${shortName('st')} AS student_name,
             n.created_at, n.read_at
        FROM notifications n
        LEFT JOIN students st ON st.id = n.student_id
       WHERE n.user_id = ?
         AND n.dismissed_at IS NULL
         AND (? = 0 OR n.student_id IS NULL OR ${inJSON('n.student_id')})
         ${hiddenSql}
       ORDER BY n.created_at DESC
       LIMIT 200`).bind(user, kids.length, JSON.stringify(kids), js(hidden))
  // Only a caller with children gets alerts manufactured, and for all of them.
  const stmts = scope.studentIds.length > 0 ? [...deliverFamilyAlerts(c, user, scope.studentIds), list] : [list]
  const results = await c.db.batch(stmts)
  const rows = results[results.length - 1].results as {
    id: string; kind: string; title: string; body: string | null; link: string | null; student_id: string | null
    student_name: string | null; created_at: string; read_at: string | null
  }[]
  let unread = 0
  const items = rows.map((v) => {
    const readAt = istStamp(v.read_at)
    if (v.read_at === null) unread++
    return {
      id: v.id, kind: v.kind, title: v.title, body: o(v.body), link: o(v.link), student_id: o(v.student_id),
      student_name: v.student_id !== null ? o(v.student_name) : undefined,
      created_at: istStamp(v.created_at) ?? '', read_at: o(readAt),
    }
  })
  return ok({ items, unread })
}

async function markNotificationRead(c: Ctx): Promise<Response> {
  const noteID = c.params.id
  if (!isUUID(noteID)) throw badRequest('invalid notification id')
  const res = await c.db.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`)
    .bind(now(), noteID, c.id.userId).run()
  if (res.meta.changes === 1) return ok({ status: 'read' })
  throw notFound()
}

async function clearNotifications(c: Ctx): Promise<Response> {
  const ts = now()
  const res = await c.db.prepare(`UPDATE notifications SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
                                   WHERE user_id = ? AND dismissed_at IS NULL`).bind(ts, ts, c.id.userId).run()
  return ok({ cleared: res.meta.changes })
}

async function markAllNotificationsRead(c: Ctx): Promise<Response> {
  const res = await c.db.prepare(`UPDATE notifications SET read_at = ?
                                   WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL`).bind(now(), c.id.userId).run()
  return ok({ cleared: res.meta.changes })
}

// ---------------------------------------------------------------------------
// canteen

async function listCafeteriaPurchases(c: Ctx): Promise<Response> {
  const { studentIds: kids } = await familyChildren(c, c.url.searchParams.get('student_id'))
  const { from, to } = familyDates(c, 30, 1)
  const fromISO = istMidnightISO(from)
  const toISO = istMidnightISO(ymd(addDays(new Date(to + 'T00:00:00Z'), 1)))
  const rows = await c.db.prepare(`
      SELECT p.id, p.student_id, ${shortName('st')} AS student_name, p.purchased_at, p.counter, p.total_paise, p.mode
        FROM cafeteria_purchases p
        JOIN students st ON st.id = p.student_id
       WHERE ${inJSON('p.student_id')}
         AND p.purchased_at >= ? AND p.purchased_at < ?
       ORDER BY p.purchased_at DESC
       LIMIT 400`).bind(JSON.stringify(kids), fromISO, toISO).all<{
    id: string; student_id: string; student_name: string; purchased_at: string; counter: string | null
    total_paise: number; mode: string
  }>()
  interface Item { item_name: string; category: string; quantity: number; unit_paise: number; line_paise: number; kcal?: number; is_vegetarian?: boolean; allergens?: string }
  const purchases = rows.results.map((v) => {
    const t = ist(v.purchased_at)
    return {
      id: v.id, student_id: v.student_id, student_name: v.student_name, purchased_at: t?.stamp ?? '',
      on_date: t?.date ?? '', at_time: t?.time ?? '', counter: o(v.counter), total_paise: Number(v.total_paise),
      mode: v.mode, kcal: 0, items: [] as Item[],
    }
  })
  if (purchases.length) {
    const index = new Map(purchases.map((p, i) => [p.id, i]))
    const lines = await c.db.prepare(`
        SELECT purchase_id, item_name, category, quantity, unit_paise, line_paise, kcal, is_vegetarian, allergens
          FROM cafeteria_purchase_items
         WHERE ${inJSON('purchase_id')}
         ORDER BY item_name`).bind(JSON.stringify(purchases.map((p) => p.id))).all<{
      purchase_id: string; item_name: string; category: string; quantity: number; unit_paise: number; line_paise: number
      kcal: number | null; is_vegetarian: number | null; allergens: string | null
    }>()
    for (const it of lines.results) {
      const at = index.get(it.purchase_id)
      if (at === undefined) continue
      if (it.kcal !== null) purchases[at].kcal += it.kcal * it.quantity
      purchases[at].items.push({
        item_name: it.item_name, category: it.category, quantity: it.quantity, unit_paise: Number(it.unit_paise),
        line_paise: Number(it.line_paise), kcal: o(it.kcal),
        is_vegetarian: it.is_vegetarian === null ? undefined : !!it.is_vegetarian, allergens: o(it.allergens),
      })
    }
  }
  const days: { on_date: string; total_paise: number; kcal: number; purchases: number }[] = []
  const byDay = new Map<string, number>()
  let total = 0, kcal = 0
  for (const p of purchases) {
    total += p.total_paise; kcal += p.kcal
    let at = byDay.get(p.on_date)
    if (at === undefined) { at = days.length; byDay.set(p.on_date, at); days.push({ on_date: p.on_date, total_paise: 0, kcal: 0, purchases: 0 }) }
    days[at].total_paise += p.total_paise; days[at].kcal += p.kcal; days[at].purchases++
  }
  return ok({ items: purchases, days, total_paise: total, total_kcal: kcal, from, to })
}
