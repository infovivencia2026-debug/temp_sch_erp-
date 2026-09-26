import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, bool, created, int, isUUID, like, notFound, now, ok, readJSON, uuid } from '../../http'
import { addDays, institutionId, marks, js, nowInIndia, parseYMD, portalChild, requirePerm, resolveScope, shortName, todayIST, ymd } from '../teaching/common'

/* Port of the "Notices and calendar", "Exams and results" and "Alumni" parts
   of internal/api/student_learning.go (mountStudentLearning), all under the
   /portal group (self.profile.read). The book holds delegate, as the Go
   handlers did, to the library desk's reservation state machine
   (library_desk.go placeReservation / decideReservation / promoteNextHold),
   re-implemented here because routes/ops/library.ts does not export it.

   Postgres enforced several constraints the SQLite schema does not carry;
   they are checked in the handlers: library_reservations_one_per_reader,
   abc_credit_entries_once, alumni_job_posts_once, alumni_job_interests_one_live,
   and the CHECKs on credits, level, status, current_status, batch_year, kind.

   The Go session ran in Asia/Kolkata, so every to_char of a timestamptz and
   every CURRENT_DATE is read in Indian time here. */

const IST = `'+330 minutes'`
const conflictCode = (code: string, message: string) => new HttpError(409, message, { code })
const PERM = 'self.profile.read'

type Row = Record<string, unknown>
/** Go's nullString: '' is NULL, anything else is kept as sent. */
const ns = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
/** omitempty: drops the keys named whose value is null or undefined. */
function omit<T extends Row>(o: T, keys: (keyof T)[]): T {
  for (const k of keys) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

/** Turns a constraint failure from a D1 write into the 400 the Go handler answered with err.Error(). */
async function writeOr400<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (/constraint/i.test(m)) throw badRequest(m)
    throw e
  }
}

// ---------------------------------------------------------------------------
// the child and the classroom (portal_family.go whichChild, student_learning.go classroomOf)

/** Port of whichChild: ?student_id names one of the caller's own, else the first. 404 otherwise. */
async function whichChild(c: Ctx): Promise<string> {
  const sc = await resolveScope(c)
  if (sc.studentIds.length === 0) throw notFound()
  const q = c.url.searchParams.get('student_id') ?? ''
  if (q !== '') {
    if (sc.studentIds.includes(q)) return q
    throw notFound()
  }
  return sc.studentIds[0]
}

interface Classroom {
  studentId: string; studentName: string; campusId: string; classId: string; sectionId: string
  yearId: string; level: number; className: string; sectionName: string; admissionNo: string
}

/** Port of classroomOf: the active enrolment, else the most recent one. null when none. */
async function classroomOf(c: Ctx, student: string): Promise<Classroom | null> {
  const r = await c.db.prepare(`
      SELECT st.campus_id, e.class_id, e.section_id, e.academic_year_id,
             cl.level, cl.name AS class_name, sec.name AS section_name, st.admission_no,
             trim(st.first_name || COALESCE(' ' || st.middle_name, '') || COALESCE(' ' || st.last_name, '')) AS student_name
        FROM students st
        JOIN enrollments e  ON e.student_id = st.id
        JOIN classes     cl ON cl.id = e.class_id
        JOIN sections    sec ON sec.id = e.section_id
       WHERE st.id = ?
       ORDER BY (e.status = 'active') DESC, e.enrolled_on DESC
       LIMIT 1`).bind(student).first<Row>()
  if (!r) return null
  return {
    studentId: student, studentName: s(r.student_name), campusId: s(r.campus_id), classId: s(r.class_id),
    sectionId: s(r.section_id), yearId: s(r.academic_year_id), level: Number(r.level), className: s(r.class_name),
    sectionName: s(r.section_name), admissionNo: s(r.admission_no),
  }
}

/** Port of myClassroom: whichChild, then the class, 409 not_enrolled when there is none. */
async function myClassroom(c: Ctx): Promise<Classroom> {
  const student = await whichChild(c)
  const room = await classroomOf(c, student)
  if (!room) throw conflictCode('not_enrolled', 'this student has no enrolment on record; ask the office to complete the admission')
  return room
}

// ---------------------------------------------------------------------------
// library holds (library_desk.go)

const holdCollectBy = () => ymd(addDays(nowInIndia(), 3))

/** promoteNextHold, as statements for the caller's batch. */
function promoteNextHold(c: Ctx, copyId: string): D1PreparedStatement[] {
  return [
    c.db.prepare(`UPDATE library_reservations
        SET status = 'ready', ready_copy_id = ?, ready_at = ?, collect_by = ?
      WHERE id = (SELECT res.id FROM library_reservations res
                    JOIN library_copies cp ON cp.id = ?
                   WHERE res.title_id = cp.title_id AND res.status = 'waiting'
                   ORDER BY res.placed_at LIMIT 1)`).bind(copyId, now(), holdCollectBy(), copyId),
    c.db.prepare(`UPDATE library_copies
        SET status = CASE WHEN EXISTS (SELECT 1 FROM library_reservations r WHERE r.ready_copy_id = ? AND r.status = 'ready')
                          THEN 'reserved' ELSE 'available' END
      WHERE id = ? AND status <> 'issued'`).bind(copyId, copyId),
  ]
}

/** placeReservation for a student reader. */
async function placeReservation(c: Ctx, titleId: string, studentId: string): Promise<Response> {
  if (!isUUID(titleId)) throw badRequest('title_id must be a uuid')
  const title = await c.db.prepare('SELECT id FROM library_titles WHERE id = ?').bind(titleId).first()
  if (!title) throw badRequest('title_id names no library title')
  // library_reservations_one_per_reader.
  const dup = await c.db.prepare(`SELECT 1 AS x FROM library_reservations
      WHERE title_id = ? AND student_id = ? AND employee_id IS NULL AND status IN ('waiting','ready') LIMIT 1`)
    .bind(titleId, studentId).first()
  if (dup) throw conflictCode('already_queued', 'this reader is already in the queue for that title')

  const free = await c.db.prepare(`SELECT id FROM library_copies WHERE title_id = ? AND status = 'available' ORDER BY accession_no LIMIT 1`)
    .bind(titleId).first<{ id: string }>()
  const id = uuid()
  const ts = now()
  const status = free ? 'ready' : 'waiting'
  const stmts: D1PreparedStatement[] = []
  // The copy is marked reserved so the next hold looks elsewhere and the counter cannot issue it to a walk-in.
  if (free) stmts.push(c.db.prepare(`UPDATE library_copies SET status = 'reserved' WHERE id = ? AND status = 'available'`).bind(free.id))
  stmts.push(c.db.prepare(`INSERT INTO library_reservations
      (id, institution_id, title_id, student_id, employee_id, created_by, placed_at, status, ready_copy_id, ready_at, collect_by)
      VALUES (?,?,?,?,NULL,?,?,?,?,?,?)`)
    .bind(id, institutionId(c), titleId, studentId, c.id.userId, ts, status,
      free?.id ?? null, free ? ts : null, free ? holdCollectBy() : null))
  await c.db.batch(stmts)
  return created({ id, status })
}

// ---------------------------------------------------------------------------
// enumerations Postgres CHECKed

const ABC_LEVELS = ['school', 'vocational', 'skill', 'co_curricular']
const ABC_STATUSES = ['earned', 'deposited', 'redeemed', 'withdrawn']
const ALUMNI_STATUSES = ['school', 'higher_secondary', 'undergraduate', 'postgraduate', 'working', 'entrepreneur', 'other']
const JOB_KINDS = ['job', 'internship', 'apprenticeship', 'volunteering', 'work_experience']

/** optionalDate: '' is absent, anything else must be YYYY-MM-DD. */
function optionalDate(raw: unknown, msg: string): string | null {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (v === '') return null
  if (!parseYMD(v)) throw badRequest(msg)
  return v
}
/** optionalUUID: '' is absent, anything else must parse. */
function optionalUUID(raw: unknown, msg: string): string | null {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (v === '') return null
  if (!isUUID(v)) throw badRequest(msg)
  return v.toLowerCase()
}

// ---------------------------------------------------------------------------
// alumni rows

const ALUMNI_COLS = (contact: 'own' | 'consented') => `
  a.id, a.student_id, ${shortName('st')} AS name,
  a.batch_year, a.current_status, a.institution_name, a.employer,
  a.designation, a.city, a.country,
  ${contact === 'own' ? 'a.contact_email' : 'CASE WHEN a.show_contact = 1 THEN a.contact_email END'} AS contact_email,
  ${contact === 'own' ? 'a.contact_phone' : 'CASE WHEN a.show_contact = 1 THEN a.contact_phone END'} AS contact_phone,
  a.profile_url, a.willing_to_mentor, a.willing_to_post_jobs, a.is_listed, a.show_contact, a.bio,
  a.verified_at IS NOT NULL AS is_verified, date(a.created_at, ${IST}) AS registered_on`

const alumniJSON = (r: Row) => omit({
  id: s(r.id), student_id: s(r.student_id), name: s(r.name), batch_year: Number(r.batch_year),
  current_status: s(r.current_status),
  institution_name: r.institution_name as string | null, employer: r.employer as string | null,
  designation: r.designation as string | null, city: r.city as string | null, country: r.country as string | null,
  contact_email: r.contact_email as string | null, contact_phone: r.contact_phone as string | null,
  profile_url: r.profile_url as string | null,
  willing_to_mentor: bool(r.willing_to_mentor), willing_to_post_jobs: bool(r.willing_to_post_jobs),
  is_listed: bool(r.is_listed), show_contact: bool(r.show_contact), bio: r.bio as string | null,
  is_verified: bool(r.is_verified), registered_on: s(r.registered_on),
}, ['institution_name', 'employer', 'designation', 'city', 'country', 'contact_email', 'contact_phone', 'profile_url', 'bio'])

/** Reads an optional JSON body (Go decoded only when ContentLength > 0). */
async function optionalBody<T>(c: Ctx): Promise<Partial<T>> {
  const text = await c.req.text()
  if (text === '') return {}
  try { return JSON.parse(text) as Partial<T> } catch { throw badRequest('malformed JSON body') }
}

// ---------------------------------------------------------------------------

export function registerPortalRecords(r: Router): void {
  // --- Notices and calendar -------------------------------------------------

  /* getStudentCalendar: terms, holidays, the class's own exam papers and the
     club nights the year group may attend, in one dated list. Four queries
     merged here in place of the Go UNION ALL. */
  r.get('/portal/calendar', PERM, async (c) => {
    const room = await myClassroom(c)
    const q = c.url.searchParams
    const fromRaw = (q.get('from') ?? '').trim()
    const toRaw = (q.get('to') ?? '').trim()
    if (fromRaw !== '' && !parseYMD(fromRaw)) throw badRequest('from must be YYYY-MM-DD')
    if (toRaw !== '' && !parseYMD(toRaw)) throw badRequest('to must be YYYY-MM-DD')

    const ay = await c.db.prepare('SELECT starts_on, ends_on FROM academic_years WHERE id = ?')
      .bind(room.yearId).first<{ starts_on: string; ends_on: string }>()
    type Entry = { on_date: string; to_date?: string | null; kind: string; title: string; detail?: string | null; source: string; all_day: boolean; starts_at?: string | null }
    const items: Entry[] = []
    if (ay) {
      const from = fromRaw || String(ay.starts_on).slice(0, 10)
      const to = toRaw || String(ay.ends_on).slice(0, 10)
      const [terms, hols, exams, clubs] = await c.db.batch([
        c.db.prepare(`SELECT substr(t.starts_on,1,10) AS on_date, substr(t.ends_on,1,10) AS to_date, t.name AS title
            FROM terms t WHERE t.academic_year_id = ? AND t.starts_on <= ? AND t.ends_on >= ?`).bind(room.yearId, to, from),
        // applies_to 'staff' is excluded: a staff development day the children attend is not their holiday.
        c.db.prepare(`SELECT substr(h.on_date,1,10) AS on_date, substr(h.to_date,1,10) AS to_date, h.kind, h.name AS title, h.description AS detail
            FROM holidays h
           WHERE h.on_date BETWEEN ? AND ?
             AND h.applies_to IN ('all','students')
             AND (h.campus_id IS NULL OR h.campus_id = ?)
             AND (h.academic_year_id IS NULL OR h.academic_year_id = ?)`).bind(from, to, room.campusId, room.yearId),
        // The papers this child's own class sits, and only those.
        c.db.prepare(`SELECT substr(es.exam_date,1,10) AS on_date, ex.name || ' · ' || sub.name AS title,
                 substr(es.starts_at,1,5) AS starts_at, es.duration_minutes, es.max_marks
            FROM exam_subjects es
            JOIN exams          ex ON ex.id = es.exam_id
            JOIN class_subjects cs ON cs.id = es.class_subject_id
            JOIN subjects      sub ON sub.id = cs.subject_id
           WHERE cs.class_id = ? AND es.exam_date BETWEEN ? AND ?`).bind(room.classId, from, to),
        // Club nights this year group may attend.
        c.db.prepare(`SELECT date(ev.starts_at, ${IST}) AS on_date, ev.club_name || ' · ' || ev.title AS title,
                 ev.venue AS detail, strftime('%H:%M', ev.starts_at, ${IST}) AS starts_at
            FROM club_events ev
           WHERE ev.campus_id = ?
             AND ev.status IN ('open','closed','done')
             AND date(ev.starts_at, ${IST}) BETWEEN ? AND ?
             AND (ev.min_class_level IS NULL OR ev.min_class_level <= ?)
             AND (ev.max_class_level IS NULL OR ev.max_class_level >= ?)`).bind(room.campusId, from, to, room.level, room.level),
      ])
      for (const t of terms.results as Row[]) {
        items.push({ on_date: s(t.on_date), to_date: t.to_date as string | null, kind: 'term', title: s(t.title), detail: null, source: 'terms', all_day: true, starts_at: null })
      }
      for (const h of hols.results as Row[]) {
        items.push({ on_date: s(h.on_date), to_date: h.to_date as string | null, kind: s(h.kind), title: s(h.title), detail: h.detail as string | null, source: 'holidays', all_day: true, starts_at: null })
      }
      for (const e of exams.results as Row[]) {
        // concat_ws(' · ', HH:MM, 'N min', 'max M'): NULLs dropped.
        const start = (e.starts_at as string | null) || null
        const parts = [start, e.duration_minutes !== null && e.duration_minutes !== undefined ? `${e.duration_minutes} min` : null,
          e.max_marks !== null && e.max_marks !== undefined ? `max ${e.max_marks}` : null].filter((p): p is string => p !== null)
        items.push({ on_date: s(e.on_date), to_date: null, kind: 'exam', title: s(e.title), detail: parts.join(' · '), source: 'exams', all_day: true, starts_at: start })
      }
      for (const v of clubs.results as Row[]) {
        items.push({ on_date: s(v.on_date), to_date: null, kind: 'club_event', title: s(v.title), detail: v.detail as string | null, source: 'club_events', all_day: false, starts_at: v.starts_at as string | null })
      }
      // ORDER BY on_date, starts_at NULLS FIRST, title
      items.sort((a, b) => {
        if (a.on_date !== b.on_date) return a.on_date < b.on_date ? -1 : 1
        const sa = a.starts_at ?? null, sb = b.starts_at ?? null
        if (sa !== sb) { if (sa === null) return -1; if (sb === null) return 1; return sa < sb ? -1 : 1 }
        return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
      })
      for (const it of items) omit(it, ['to_date', 'detail', 'starts_at'])
    }
    return ok({ student_id: room.studentId, class_name: room.className, section_name: room.sectionName, items })
  })

  /* listLibraryCatalogue: the search behind the hold button, on the child's campus. */
  r.get('/portal/library/titles', PERM, async (c) => {
    const room = await myClassroom(c)
    const q = (c.url.searchParams.get('q') ?? '').trim()
    const pat = like(q)
    const rows = await c.db.prepare(`
        SELECT t.id, t.title, t.author, t.publisher, t.category, t.isbn,
               (SELECT COUNT(*) FROM library_copies cp WHERE cp.title_id = t.id) AS copies,
               (SELECT COUNT(*) FROM library_copies cp WHERE cp.title_id = t.id AND cp.status = 'available') AS on_shelf,
               (SELECT COUNT(*) FROM library_reservations res WHERE res.title_id = t.id AND res.status = 'waiting') AS waiting,
               (SELECT res.status FROM library_reservations res
                 WHERE res.title_id = t.id AND res.student_id = ? AND res.status IN ('waiting','ready') LIMIT 1) AS my_hold
          FROM library_titles t
         WHERE t.campus_id = ?
           AND (? = '' OR t.title LIKE ? ESCAPE '\\' OR t.author LIKE ? ESCAPE '\\' OR t.isbn = ?)
         ORDER BY t.title
         LIMIT 200`).bind(room.studentId, room.campusId, q, pat, pat, q).all<Row>()
    const items = rows.results.map((v) => omit({
      id: s(v.id), title: s(v.title), author: v.author as string | null, publisher: v.publisher as string | null,
      category: v.category as string | null, isbn: v.isbn as string | null,
      copies: Number(v.copies), copies_on_shelf: Number(v.on_shelf), holds_waiting: Number(v.waiting),
      my_hold_status: v.my_hold as string | null,
    }, ['author', 'publisher', 'category', 'isbn', 'my_hold_status']))
    return ok({ items })
  })

  /* listMyHolds: the librarian's queue from the reader's side, position counted at read time. */
  r.get('/portal/library/holds', PERM, async (c) => {
    const sc = await resolveScope(c)
    if (sc.studentIds.length === 0) return ok({ items: [] })
    const rows = await c.db.prepare(`
        SELECT res.id, res.title_id, t.title, t.author, res.status,
               strftime('%Y-%m-%dT%H:%M', res.placed_at, ${IST}) AS placed_at,
               CASE WHEN res.status = 'waiting' THEN (
                   SELECT COUNT(*) + 1 FROM library_reservations q
                    WHERE q.title_id = res.title_id AND q.status = 'waiting'
                      AND q.placed_at < res.placed_at)
                    ELSE 0 END AS position,
               cp.accession_no, substr(res.collect_by,1,10) AS collect_by,
               res.status IN ('waiting','ready') AS cancellable
          FROM library_reservations res
          JOIN library_titles t ON t.id = res.title_id
          LEFT JOIN library_copies cp ON cp.id = res.ready_copy_id
         WHERE res.student_id IN (${marks(sc.studentIds)})
         ORDER BY (res.status = 'ready') DESC, res.placed_at DESC
         LIMIT 100`).bind(js(sc.studentIds)).all<Row>()
    const items = rows.results.map((v) => omit({
      id: s(v.id), title_id: s(v.title_id), title: s(v.title), author: v.author as string | null,
      status: s(v.status), placed_at: s(v.placed_at), position: Number(v.position),
      ready_accession_no: v.accession_no as string | null, collect_by: v.collect_by as string | null,
      cancellable: bool(v.cancellable),
    }, ['author', 'ready_accession_no', 'collect_by']))
    return ok({ items })
  })

  /* requestBookHold: the student id is the caller's own resolved child, never the body's word. */
  r.post('/portal/library/holds', PERM, async (c) => {
    const req = await readJSON<{ student_id?: string; title_id?: string }>(c.req)
    const { studentId } = await portalChild(c, req.student_id)
    const titleId = s(req.title_id).trim()
    if (titleId === '') throw badRequest('title_id is required')
    return placeReservation(c, titleId, studentId)
  })

  /* cancelBookHold: ownership here, then decideReservation's cancel (frees a ready copy, promotes the next reader). */
  r.post('/portal/library/holds/{id}/cancel', PERM, async (c) => {
    const sc = await resolveScope(c)
    const holdId = c.params.id
    if (!isUUID(holdId)) throw notFound()
    if (sc.studentIds.length === 0) throw notFound()
    const cur = await c.db.prepare(`SELECT status, ready_copy_id FROM library_reservations
        WHERE id = ? AND student_id IN (${marks(sc.studentIds)})`).bind(holdId, js(sc.studentIds))
      .first<{ status: string; ready_copy_id: string | null }>()
    if (!cur) throw notFound()
    if (cur.status !== 'waiting' && cur.status !== 'ready') {
      throw conflictCode('wrong_state', 'that hold is not in a state where this action makes sense')
    }
    const stmts = [c.db.prepare(`UPDATE library_reservations
        SET status = 'cancelled', cancelled_reason = ?, ready_copy_id = NULL
      WHERE id = ? AND status IN ('waiting','ready')`).bind('withdrawn by the reader', holdId)]
    if (cur.ready_copy_id) {
      stmts.push(c.db.prepare(`UPDATE library_copies SET status = 'available' WHERE id = ? AND status = 'reserved'`).bind(cur.ready_copy_id))
      stmts.push(...promoteNextHold(c, cur.ready_copy_id))
    }
    const res = await c.db.batch(stmts)
    if ((res[0].meta.changes ?? 0) === 0) throw conflictCode('wrong_state', 'that hold is not in a state where this action makes sense')
    return ok({ id: holdId, action: 'cancel' })
  })

  // --- Exams and results ----------------------------------------------------

  /* getAcademicRecord: each year's class, promotion and the published annual card. */
  r.get('/portal/academic-record', PERM, async (c) => {
    const student = await whichChild(c)
    const [head, years] = await c.db.batch([
      c.db.prepare(`
        SELECT trim(st.first_name || COALESCE(' ' || st.middle_name, '') || COALESCE(' ' || st.last_name, '')) AS name,
               st.admission_no, st.apaar_id,
               (SELECT ROUND(100.0 * SUM(CASE WHEN sa.status IN ('present','late') THEN 1 ELSE 0 END)
                             / NULLIF(COUNT(*), 0), 1)
                  FROM student_attendance sa WHERE sa.student_id = st.id) AS pct
          FROM students st WHERE st.id = ?`).bind(student),
      c.db.prepare(`
        SELECT ay.name AS year, cl.name AS class_name, sec.name AS section_name, e.roll_no, e.status,
               substr(e.enrolled_on,1,10) AS enrolled_on,
               rc.percentage, rc.grade, rc.rank_in_section, rc.attendance_percent, rc.class_teacher_remarks,
               COALESCE(rc.is_published, 0) AS is_published
          FROM enrollments e
          JOIN academic_years ay ON ay.id = e.academic_year_id
          JOIN classes        cl ON cl.id = e.class_id
          JOIN sections      sec ON sec.id = e.section_id
          -- The annual card: term_id IS NULL is what makes it the year's summary.
          LEFT JOIN report_cards rc
                 ON rc.student_id = e.student_id
                AND rc.academic_year_id = e.academic_year_id
                AND rc.term_id IS NULL
                AND rc.is_published = 1
         WHERE e.student_id = ?
         ORDER BY ay.starts_on DESC`).bind(student),
    ])
    const h = (head.results as Row[])[0]
    if (!h) throw notFound()
    return ok({
      student_id: student, student_name: s(h.name), admission_no: s(h.admission_no),
      apaar_id: (h.apaar_id as string | null) ?? null,
      lifetime_attendance_percent: numOrNull(h.pct),
      years: (years.results as Row[]).map((v) => omit({
        academic_year: s(v.year), class_name: s(v.class_name), section_name: s(v.section_name),
        roll_no: numOrNull(v.roll_no), status: s(v.status), enrolled_on: s(v.enrolled_on),
        percentage: numOrNull(v.percentage), grade: v.grade as string | null,
        rank_in_section: numOrNull(v.rank_in_section), attendance_percent: numOrNull(v.attendance_percent),
        class_teacher_remarks: v.class_teacher_remarks as string | null, is_published: bool(v.is_published),
      }, ['roll_no', 'percentage', 'grade', 'rank_in_section', 'attendance_percent', 'class_teacher_remarks'])),
    })
  })

  /* getAcademicBankOfCredits: the APAAR from students.apaar_id and every credit entry, withdrawn ones included. */
  r.get('/portal/abc', PERM, async (c) => {
    const student = await whichChild(c)
    const [head, rows] = await c.db.batch([
      c.db.prepare(`SELECT trim(st.first_name || COALESCE(' ' || st.middle_name, '') || COALESCE(' ' || st.last_name, '')) AS name,
               st.apaar_id FROM students st WHERE st.id = ?`).bind(student),
      c.db.prepare(`
        SELECT e.id, e.course_title, sub.name AS subject, ay.name AS year, e.session_label,
               e.credits, e.level, e.grade, e.status, substr(e.deposited_on,1,10) AS deposited_on, e.apaar_id
          FROM abc_credit_entries e
          LEFT JOIN subjects       sub ON sub.id = e.subject_id
          LEFT JOIN academic_years ay  ON ay.id = e.academic_year_id
         WHERE e.student_id = ?
         ORDER BY e.deposited_on IS NULL, e.deposited_on DESC, e.course_title`).bind(student),
    ])
    const h = (head.results as Row[])[0]
    if (!h) throw notFound()
    let total = 0, banked = 0
    const entries = (rows.results as Row[]).map((v) => {
      const credits = Number(v.credits)
      const status = s(v.status)
      if (status !== 'withdrawn') total += credits
      if (status === 'deposited') banked += credits
      return omit({
        id: s(v.id), course_title: s(v.course_title), subject: v.subject as string | null,
        academic_year: v.year as string | null, session: v.session_label as string | null, credits,
        level: v.level as string | null, grade: v.grade as string | null, status,
        deposited_on: v.deposited_on as string | null, apaar_id: v.apaar_id as string | null,
      }, ['subject', 'academic_year', 'session', 'level', 'grade', 'deposited_on', 'apaar_id'])
    })
    const apaar = (h.apaar_id as string | null) ?? null
    return ok({
      student_id: student, student_name: s(h.name), apaar_id: apaar,
      has_apaar: apaar !== null && apaar !== '',
      total_credits: total, credits_banked: banked, entries,
    })
  })

  /* depositAcademicCredits: the school's act (academics.exams.write). The APAAR is copied as it reads today. */
  r.post('/portal/abc/entries', PERM, async (c) => {
    requirePerm(c, 'academics.exams.write')
    const req = await readJSON<{
      student_id?: string; course_title?: string; credits?: number; subject_id?: string; academic_year_id?: string
      session_label?: string; level?: string; grade?: string; status?: string; deposited_on?: string
    }>(c.req)
    const student = s(req.student_id).trim()
    if (!isUUID(student)) throw badRequest('student_id must be a uuid')
    const credits = typeof req.credits === 'number' && Number.isFinite(req.credits) ? req.credits : 0
    const course = s(req.course_title).trim()
    if (course === '' || credits <= 0) throw badRequest('course_title and a positive credits value are required')
    const subject = optionalUUID(req.subject_id, 'subject_id must be a uuid')
    const year = optionalUUID(req.academic_year_id, 'academic_year_id must be a uuid')
    let on = optionalDate(req.deposited_on, 'deposited_on must be YYYY-MM-DD')
    const status = s(req.status).trim() || 'earned'
    if (status === 'deposited' && on === null) on = todayIST()
    // CHECKs Postgres carried.
    if (!ABC_STATUSES.includes(status)) throw badRequest('status must be earned, deposited, redeemed or withdrawn')
    const level = ns(req.level)
    if (level !== null && !ABC_LEVELS.includes(level)) throw badRequest('level must be school, vocational, skill or co_curricular')
    const rounded = Math.round(credits * 100) / 100
    if (rounded >= 1000) throw badRequest('credits must be less than 1000')
    const session = ns(req.session_label)

    // abc_credit_entries_once: one deposit per course per session per child.
    const dup = await c.db.prepare(`SELECT 1 AS x FROM abc_credit_entries
        WHERE student_id = ? AND lower(trim(course_title)) = lower(?)
          AND COALESCE(academic_year_id, '') = COALESCE(?, '')
          AND lower(trim(COALESCE(session_label, ''))) = lower(trim(COALESCE(?, ''))) LIMIT 1`)
      .bind(student, course, year, session).first()
    if (dup) throw conflictCode('already_deposited', 'those credits are already banked for that course and session')

    const id = uuid()
    const res = await writeOr400(c.db.prepare(`
        INSERT INTO abc_credit_entries
            (id, institution_id, student_id, academic_year_id, apaar_id, course_title,
             subject_id, credits, level, session_label, grade, status, deposited_on, created_at)
        SELECT ?, ?, st.id, ?, st.apaar_id, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM students st WHERE st.id = ?`)
      .bind(id, institutionId(c), year, course, subject, String(rounded), level, session, ns(req.grade),
        status, on, now(), student).run())
    if ((res.meta.changes ?? 0) === 0) throw notFound()
    return created({ id, status })
  })

  // --- Alumni -----------------------------------------------------------------

  /* getAlumniProfile: 200 with registered=false when the child has not signed up. */
  r.get('/portal/alumni/profile', PERM, async (c) => {
    const student = await whichChild(c)
    const row = await c.db.prepare(`SELECT ${ALUMNI_COLS('own')}
        FROM alumni_profiles a JOIN students st ON st.id = a.student_id
       WHERE a.student_id = ?`).bind(student).first<Row>()
    if (!row) return ok({ student_id: student, registered: false, profile: null })
    return ok({ student_id: student, registered: true, profile: alumniJSON(row) })
  })

  /* saveAlumniRegistration: one upsert for register and edit. Verification is never settable here. */
  r.post('/portal/alumni/profile', PERM, async (c) => {
    const req = await readJSON<{
      student_id?: string; batch_year?: number; current_status?: string; institution_name?: string; employer?: string
      designation?: string; city?: string; country?: string; contact_email?: string; contact_phone?: string
      profile_url?: string; willing_to_mentor?: boolean; willing_to_post_jobs?: boolean; is_listed?: boolean
      show_contact?: boolean; bio?: string
    }>(c.req)
    const { studentId } = await portalChild(c, req.student_id)
    let batch = typeof req.batch_year === 'number' && Number.isInteger(req.batch_year) ? req.batch_year : 0
    if (batch === 0) batch = nowInIndia().getUTCFullYear()
    if (batch < 1900 || batch > 2200) throw badRequest('batch_year must be between 1900 and 2200')
    const status = s(req.current_status).trim() || 'school'
    if (!ALUMNI_STATUSES.includes(status)) throw badRequest(`current_status must be one of ${ALUMNI_STATUSES.join(', ')}`)
    const listed = typeof req.is_listed === 'boolean' ? req.is_listed : true
    const ts = now()
    // The office's country column is NOT NULL DEFAULT 'India'; Go wrote NULL there only on a fresh
    // insert that sent no country, which Postgres refused. COALESCE keeps the default instead.
    const row = await writeOr400(c.db.prepare(`
        INSERT INTO alumni_profiles
            (id, institution_id, student_id, registered_by, batch_year, current_status,
             institution_name, employer, designation, city, country,
             contact_email, contact_phone, profile_url, willing_to_mentor,
             willing_to_post_jobs, is_listed, show_contact, bio, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'India'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id, student_id) DO UPDATE SET
            batch_year        = excluded.batch_year,
            current_status    = excluded.current_status,
            institution_name  = excluded.institution_name,
            employer          = excluded.employer,
            designation       = excluded.designation,
            city              = excluded.city,
            country           = excluded.country,
            contact_email     = excluded.contact_email,
            contact_phone     = excluded.contact_phone,
            profile_url       = excluded.profile_url,
            willing_to_mentor = excluded.willing_to_mentor,
            willing_to_post_jobs = excluded.willing_to_post_jobs,
            is_listed         = excluded.is_listed,
            show_contact      = excluded.show_contact,
            bio               = excluded.bio,
            updated_at        = excluded.updated_at
        RETURNING id`)
      .bind(uuid(), institutionId(c), studentId, c.id.userId, batch, status,
        ns(req.institution_name), ns(req.employer), ns(req.designation), ns(req.city), ns(req.country),
        ns(req.contact_email), ns(req.contact_phone), ns(req.profile_url),
        int(req.willing_to_mentor === true), int(req.willing_to_post_jobs === true), int(listed),
        int(req.show_contact === true), ns(req.bio), ts, ts).first<{ id: string }>())
    return ok({ id: row!.id, registered: true })
  })

  /* listAlumniDirectory: is_listed decides who appears; show_contact decides whether contact travels, nulled in SQL. */
  r.get('/portal/alumni/directory', PERM, async (c) => {
    const q = (c.url.searchParams.get('q') ?? '').trim()
    const pat = like(q)
    const rows = await c.db.prepare(`SELECT ${ALUMNI_COLS('consented')}
        FROM alumni_profiles a JOIN students st ON st.id = a.student_id
       WHERE a.is_listed = 1
         AND (? = ''
              OR ${shortName('st')} LIKE ? ESCAPE '\\'
              OR a.employer LIKE ? ESCAPE '\\'
              OR a.institution_name LIKE ? ESCAPE '\\')
       ORDER BY a.batch_year DESC, st.first_name
       LIMIT 200`).bind(q, pat, pat, pat).all<Row>()
    return ok({ items: rows.results.map(alumniJSON) })
  })

  /* listAlumniJobs: open posts, gated by the child's class level. */
  r.get('/portal/alumni/jobs', PERM, async (c) => {
    const room = await myClassroom(c)
    const kind = (c.url.searchParams.get('kind') ?? '').trim()
    const rows = await c.db.prepare(`
        SELECT p.id, p.kind, p.title, p.organisation, p.location, p.is_remote,
               p.description, p.eligibility, p.stipend_paise, p.apply_url,
               p.apply_email, substr(p.closes_on,1,10) AS closes_on, p.status,
               CASE WHEN ast.id IS NULL THEN '' ELSE ${shortName('ast')} END AS posted_by,
               al.batch_year,
               (SELECT COUNT(*) FROM alumni_job_interests i
                 WHERE i.post_id = p.id AND i.withdrawn_at IS NULL) AS interested,
               EXISTS (SELECT 1 FROM alumni_job_interests i
                        WHERE i.post_id = p.id AND i.student_id = ?
                          AND i.withdrawn_at IS NULL) AS mine,
               date(p.created_at, ${IST}) AS posted_on
          FROM alumni_job_posts p
          JOIN users u ON u.id = p.posted_by
          LEFT JOIN alumni_profiles al  ON al.id = p.alumni_id
          LEFT JOIN students        ast ON ast.id = al.student_id
         WHERE p.status = 'open'
           AND (p.closes_on IS NULL OR p.closes_on >= ?)
           AND (p.min_class_level IS NULL OR p.min_class_level <= ?)
           AND (? = '' OR p.kind = ?)
         ORDER BY p.closes_on IS NULL, p.closes_on ASC, p.created_at DESC
         LIMIT 200`).bind(room.studentId, todayIST(), room.level, kind, kind).all<Row>()
    const items = rows.results.map((v) => omit({
      id: s(v.id), kind: s(v.kind), title: s(v.title), organisation: s(v.organisation),
      location: v.location as string | null, is_remote: bool(v.is_remote),
      description: v.description as string | null, eligibility: v.eligibility as string | null,
      stipend_paise: numOrNull(v.stipend_paise), apply_url: v.apply_url as string | null,
      apply_email: v.apply_email as string | null, closes_on: v.closes_on as string | null,
      status: s(v.status), posted_by: s(v.posted_by), poster_batch_year: numOrNull(v.batch_year),
      interested: Number(v.interested), registered_interest: bool(v.mine), posted_on: s(v.posted_on),
    }, ['location', 'description', 'eligibility', 'stipend_paise', 'apply_url', 'apply_email', 'closes_on', 'poster_batch_year']))
    return ok({ items })
  })

  /* registerJobInterest: interest, not an application. */
  r.post('/portal/alumni/jobs/{id}/interest', PERM, async (c) => {
    const req = await optionalBody<{ student_id: string; note: string }>(c)
    const { studentId } = await portalChild(c, req.student_id)
    const postId = c.params.id
    if (!isUUID(postId)) throw notFound()
    const room = await classroomOf(c, studentId)
    if (!room) throw notFound()
    const open = await c.db.prepare(`SELECT 1 AS x FROM alumni_job_posts p
        WHERE p.id = ? AND p.status = 'open'
          AND (p.closes_on IS NULL OR p.closes_on >= ?)
          AND (p.min_class_level IS NULL OR p.min_class_level <= ?)`).bind(postId, todayIST(), room.level).first()
    if (!open) throw conflictCode('unavailable', 'that post is closed or not open to your year group')
    // alumni_job_interests_one_live.
    const live = await c.db.prepare(`SELECT 1 AS x FROM alumni_job_interests
        WHERE post_id = ? AND student_id = ? AND withdrawn_at IS NULL LIMIT 1`).bind(postId, studentId).first()
    if (live) throw conflictCode('already_registered', 'you have already registered interest in that post')
    const id = uuid()
    await c.db.prepare(`INSERT INTO alumni_job_interests (id, institution_id, post_id, student_id, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(id, institutionId(c), postId, studentId, ns(req.note), now()).run()
    return created({ id })
  })

  r.post('/portal/alumni/jobs/{id}/withdraw', PERM, async (c) => {
    const req = await optionalBody<{ student_id: string; note: string }>(c)
    const { studentId } = await portalChild(c, req.student_id)
    const postId = c.params.id
    if (!isUUID(postId)) throw notFound()
    const row = await c.db.prepare(`UPDATE alumni_job_interests SET withdrawn_at = ?
        WHERE post_id = ? AND student_id = ? AND withdrawn_at IS NULL
        RETURNING id`).bind(now(), postId, studentId).first<{ id: string }>()
    if (!row) throw notFound()
    return ok({ id: row.id, withdrawn: true })
  })

  /* postAlumniJob: staff-gated (students.write); the school's name is on the board. */
  r.post('/portal/alumni/jobs', PERM, async (c) => {
    requirePerm(c, 'students.write')
    const req = await readJSON<{
      kind?: string; title?: string; organisation?: string; location?: string; is_remote?: boolean
      description?: string; eligibility?: string; stipend_paise?: number; min_class_level?: number
      apply_url?: string; apply_email?: string; closes_on?: string; alumni_id?: string
    }>(c.req)
    const title = s(req.title).trim(), org = s(req.organisation).trim()
    if (title === '' || org === '') throw badRequest('title and organisation are required')
    const kind = s(req.kind).trim() || 'internship'
    if (!JOB_KINDS.includes(kind)) throw badRequest(`kind must be one of ${JOB_KINDS.join(', ')}`)
    const closes = optionalDate(req.closes_on, 'closes_on must be YYYY-MM-DD')
    const alumni = optionalUUID(req.alumni_id, 'alumni_id must be a uuid')
    const stipend = typeof req.stipend_paise === 'number' && req.stipend_paise > 0 ? Math.trunc(req.stipend_paise) : null
    const minLevel = typeof req.min_class_level === 'number' && req.min_class_level > 0 ? Math.trunc(req.min_class_level) : null

    // alumni_job_posts_once: one live post per organisation per title.
    const dup = await c.db.prepare(`SELECT 1 AS x FROM alumni_job_posts
        WHERE status = 'open' AND lower(trim(organisation)) = lower(?) AND lower(trim(title)) = lower(?) LIMIT 1`)
      .bind(org, title).first()
    if (dup) throw conflictCode('already_posted', 'that organisation already has an open post by that title')

    const id = uuid()
    await writeOr400(c.db.prepare(`
        INSERT INTO alumni_job_posts
            (id, institution_id, posted_by, alumni_id, kind, title, organisation,
             location, is_remote, description, eligibility, stipend_paise,
             min_class_level, apply_url, apply_email, closes_on, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
      .bind(id, institutionId(c), c.id.userId, alumni, kind, title, org,
        ns(req.location), int(req.is_remote === true), ns(req.description), ns(req.eligibility),
        stipend, minLevel, ns(req.apply_url), ns(req.apply_email), closes, now()).run())
    return created({ id })
  })
}
