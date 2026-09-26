import type { Router, Ctx } from '../../router'
import { badRequest, bool, forbidden, isUUID, notFound, now, ok, readJSON, uuid, HttpError } from '../../http'
import { can } from '../../identity'
import { tenantDb, type Institution } from '../../tenant'
import {
  fullName, institutionId, inList, marks, js, notifyStmt, nowInIndia, ownsStudent, requirePerm, resolveScope,
  scopeFilter, shortName, studentPredicate, todayIST, weekdayIST,
} from '../teaching/common'
import { defaultReportCardCSS, defaultReportCardHTML } from '../exams/template'

/* The family's own side of the school: the children switcher, the day's
   summary, the attendance calendar, the household record, fees and results,
   the simulated payment, conduct notes, the report card and the admission
   tracker. Ports of role_scoped.go, portal_all_children.go,
   portal_family_details.go, portal_family.go, portal_pay.go,
   my_classes.go (listDisciplineNotes), report_card_templates.go
   (renderFamilyReportCard) and portal_admission.go. All under /portal with
   the group permission self.profile.read. */

const GROUP = 'self.profile.read'

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
/** Sets key only when the value is present: Go's `omitempty` on a pointer. */
function put(o: Record<string, unknown>, k: string, v: unknown): void {
  if (v !== null && v !== undefined) o[k] = v
}
/** omitempty on a plain string. */
function putStr(o: Record<string, unknown>, k: string, v: string | null | undefined): void {
  if (v) o[k] = v
}

/** The latest enrollment of `st`, as Go's LEFT JOIN LATERAL (... ORDER BY enrolled_on DESC LIMIT 1). */
const LATEST_ENROLLMENT = `LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
  LEFT JOIN classes c ON c.id = en.class_id
  LEFT JOIN sections sec ON sec.id = en.section_id`

interface ChildRow {
  student_id: string; admission_no: string; full_name: string; class_name: string | null; section_name: string | null
  section_id: string | null; roll_no: number | null; relation: string | null
}
function childJSON(r: ChildRow): Record<string, unknown> {
  const o: Record<string, unknown> = { student_id: r.student_id, admission_no: r.admission_no, full_name: r.full_name }
  put(o, 'class_name', r.class_name); put(o, 'section_name', r.section_name); put(o, 'section_id', r.section_id)
  put(o, 'roll_no', r.roll_no === null ? null : Number(r.roll_no)); put(o, 'relation', r.relation)
  return o
}

/** Port of whichChild: the named child when it is the caller's, else the first. 404 otherwise. */
async function whichChild(c: Ctx, raw: string | null | undefined): Promise<string> {
  const scope = await resolveScope(c)
  if (scope.studentIds.length === 0) throw notFound()
  const q = raw ?? ''
  if (q !== '') {
    if (scope.studentIds.includes(q)) return q
    throw notFound()
  }
  return scope.studentIds[0]
}

// ---------------------------------------------------------------------------
// GET /portal/students (listMyStudents)

async function listMyStudents(c: Ctx): Promise<Response> {
  const scope = await resolveScope(c)
  const f = scopeFilter(scope, 'children', 'st.id')
  const rows = await c.db.prepare(`
    SELECT st.id AS student_id, st.admission_no, ${fullName('st')} AS full_name,
           c.name AS class_name, sec.name AS section_name, en.section_id, en.roll_no,
           (SELECT g.relation FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id LIMIT 1) AS relation
      FROM students st
      ${LATEST_ENROLLMENT}
     WHERE ${f.sql}
     ORDER BY st.first_name`).bind(...f.args).all<ChildRow>()
  return ok({ items: rows.results.map(childJSON) })
}

// ---------------------------------------------------------------------------
// GET /portal/students/everywhere (listMyChildrenEverywhere)

/* The Go handler found sibling accounts with one platform query over users.
   Here users live in each school's own database, so the sign-in index in
   CONTROL (login_index: email/phone -> school + user) answers "which schools
   issued an account on this contact", and each school's database then
   confirms the account is active and holds the parent role, exactly the
   three conditions the Go query applied. */
async function listMyChildrenEverywhere(c: Ctx): Promise<Response> {
  const out: Record<string, unknown>[] = []
  if (!c.id.userId || !c.id.institution) return ok({ items: out })
  const myInst = c.id.institution.id

  const me = await c.db.prepare(`SELECT email, phone FROM users WHERE id = ?`).bind(c.id.userId)
    .first<{ email: string | null; phone: string | null }>()
  const email = me?.email ?? null, phone = me?.phone ?? null

  const idx = await c.env.CONTROL.prepare(`
    SELECT DISTINCT li.user_id, li.institution_id
      FROM login_index li JOIN institutions i ON i.id = li.institution_id
     WHERE li.institution_id IS NOT NULL AND i.status = 'active'
       AND ((? IS NOT NULL AND li.kind = 'email' AND li.value = ?)
         OR (? IS NOT NULL AND li.kind = 'phone' AND li.value = ?))`)
    .bind(email, email, phone, phone).all<{ user_id: string; institution_id: string }>()

  // Candidate (school, account) pairs, the caller's own always among them.
  const pairs = new Map<string, { userId: string; inst: string }>()
  pairs.set(`${myInst}|${c.id.userId}`, { userId: c.id.userId, inst: myInst })
  for (const r of idx.results) pairs.set(`${r.institution_id}|${r.user_id}`, { userId: r.user_id, inst: r.institution_id })

  const instIds = [...new Set([...pairs.values()].map((p) => p.inst))]
  const insts = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE id IN (${marks(instIds)}) AND status = 'active'`)
    .bind(js(instIds)).all<Institution>()
  const byId = new Map(insts.results.map((i) => [i.id, i]))

  const accounts = [...pairs.values()].filter((p) => byId.has(p.inst))
    .sort((a, b) => byId.get(a.inst)!.name.localeCompare(byId.get(b.inst)!.name))

  for (const a of accounts) {
    const inst = byId.get(a.inst)!
    /* A school that errors is skipped rather than failing the whole screen. */
    try {
      const db = a.inst === myInst ? c.db : tenantDb(c.env, inst)
      const okAcct = await db.prepare(`
        SELECT 1 AS ok FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles ro ON ro.id = ur.role_id
         WHERE u.id = ? AND u.status = 'active' AND ro.key = 'parent' LIMIT 1`).bind(a.userId).first<{ ok: number }>()
      if (!okAcct) continue
      const rows = await db.prepare(`
        SELECT st.id AS student_id, st.admission_no, ${fullName('st')} AS full_name,
               c.name AS class_name, sec.name AS section_name, en.section_id, en.roll_no, g.relation
          FROM students st
          JOIN student_guardians sg ON sg.student_id = st.id
          JOIN guardians g ON g.id = sg.guardian_id
          ${LATEST_ENROLLMENT}
         WHERE g.user_id = ?
         ORDER BY st.first_name`).bind(a.userId).all<ChildRow>()
      for (const r of rows.results) {
        out.push({ ...childJSON(r), institution_id: inst.id, institution_name: inst.name, mine: inst.id === myInst })
      }
    } catch { /* skipped, as in Go */ }
  }
  return ok({ items: out })
}

// ---------------------------------------------------------------------------
// GET /portal/summary (getPortalSummary)

const isodowIST = (): number => { const w = weekdayIST(); return w === 0 ? 7 : w }

async function getPortalSummary(c: Ctx): Promise<Response> {
  const scope = await resolveScope(c)
  if (scope.studentIds.length === 0) throw notFound()
  let target = scope.studentIds[0]
  const q = c.url.searchParams.get('student_id') ?? ''
  if (q !== '') {
    if (!scope.studentIds.includes(q)) throw notFound()
    target = q
  }
  const today = todayIST()
  const owed = `FROM homework h
       JOIN enrollments e ON e.section_id = h.section_id AND e.student_id = st.id
      WHERE h.is_published = 1 AND h.due_on >= ?1
        AND NOT EXISTS (SELECT 1 FROM homework_submissions sub WHERE sub.homework_id = h.id AND sub.student_id = st.id)`
  const row = await c.db.prepare(`
    SELECT ${fullName('st')} AS full_name,
      COALESCE((SELECT CAST(round(100.0 * SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(count(*), 0)) AS INTEGER)
                  FROM student_attendance WHERE student_id = st.id), 0) AS attendance_pct,
      (SELECT count(*) FROM student_attendance WHERE student_id = st.id AND status IN ('present','late')) AS present_days,
      (SELECT count(*) FROM student_attendance WHERE student_id = st.id) AS total_days,
      (SELECT count(*) FROM student_attendance WHERE student_id = st.id AND status = 'absent') AS absent_days,
      (SELECT count(*) ${owed}) AS homework_due,
      (SELECT substr(min(h.due_on), 1, 10) ${owed}) AS next_homework_due,
      (SELECT h.title ${owed} ORDER BY h.due_on, h.title LIMIT 1) AS next_homework_title,
      COALESCE((SELECT sum(COALESCE(net_paise, 0) - paid_paise) FROM invoices
                 WHERE student_id = st.id AND status IN ('unpaid','partial','overdue')), 0) AS outstanding_paise,
      (SELECT ex.name FROM exams ex WHERE ex.starts_on >= ?1 ORDER BY ex.starts_on LIMIT 1) AS next_exam,
      (SELECT COALESCE(t.name, ay.name, 'Result') FROM report_cards rc
         LEFT JOIN terms t ON t.id = rc.term_id
         LEFT JOIN academic_years ay ON ay.id = rc.academic_year_id
        WHERE rc.student_id = st.id AND rc.is_published = 1
        ORDER BY rc.published_at DESC NULLS LAST LIMIT 1) AS latest_result_exam,
      (SELECT rc.percentage FROM report_cards rc WHERE rc.student_id = st.id AND rc.is_published = 1
        ORDER BY rc.published_at DESC NULLS LAST LIMIT 1) AS latest_result_pct,
      (SELECT rc.grade FROM report_cards rc WHERE rc.student_id = st.id AND rc.is_published = 1
        ORDER BY rc.published_at DESC NULLS LAST LIMIT 1) AS latest_result_grade
      FROM students st WHERE st.id = ?2`).bind(today, target).first<Record<string, unknown>>()
  if (!row) throw notFound()

  const periods = await c.db.prepare(`
    SELECT p.name AS period, substr(p.starts_at, 1, 5) AS starts_at, substr(p.ends_at, 1, 5) AS ends_at,
           COALESCE(sub.name, 'Free') AS subject, u.full_name AS teacher, te.room
      FROM enrollments e
      JOIN timetable_entries te ON te.section_id = e.section_id
      JOIN periods p ON p.id = te.period_id
      LEFT JOIN class_subjects cs ON cs.id = te.class_subject_id
      LEFT JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users u ON u.id = te.teacher_user_id
     WHERE e.student_id = ? AND e.status = 'active' AND te.weekday = ?
     ORDER BY p.starts_at, p.name`).bind(target, isodowIST())
    .all<{ period: string; starts_at: string | null; ends_at: string | null; subject: string; teacher: string | null; room: string | null }>()

  const out: Record<string, unknown> = {
    student_id: target, full_name: row.full_name, attendance_pct: Number(row.attendance_pct),
    present_days: Number(row.present_days), total_days: Number(row.total_days), absent_days: Number(row.absent_days),
    homework_due: Number(row.homework_due),
  }
  put(out, 'next_homework_due', row.next_homework_due)
  put(out, 'next_homework_title', row.next_homework_title)
  out.outstanding_paise = Number(row.outstanding_paise)
  put(out, 'next_exam', row.next_exam)
  put(out, 'latest_result_exam', row.latest_result_exam)
  put(out, 'latest_result_pct', numOrNull(row.latest_result_pct))
  put(out, 'latest_result_grade', row.latest_result_grade)
  out.today = periods.results.map((p) => {
    const o: Record<string, unknown> = { period: p.period }
    put(o, 'starts_at', p.starts_at); put(o, 'ends_at', p.ends_at)
    o.subject = p.subject
    put(o, 'teacher', p.teacher); put(o, 'room', p.room)
    return o
  })
  return ok(out)
}

// ---------------------------------------------------------------------------
// GET /portal/attendance (listPortalAttendance)

async function listPortalAttendance(c: Ctx): Promise<Response> {
  const scope = await resolveScope(c)
  if (scope.studentIds.length === 0) return ok({ items: [] })
  let target = scope.studentIds[0]
  const q = c.url.searchParams.get('student_id') ?? ''
  if (q !== '') {
    if (!isUUID(q) || !ownsStudent(scope, q.toLowerCase())) throw notFound()
    target = q.toLowerCase()
  }
  const today = todayIST()
  const holSel = (col: string) => `(SELECT h.${col} FROM holidays h
       WHERE h.applies_to IN ('all','students') AND h.kind <> 'working_day'
         AND days.d BETWEEN h.on_date AND COALESCE(h.to_date, h.on_date)
       ORDER BY h.on_date LIMIT 1)`
  const rows = await c.db.prepare(`
    WITH RECURSIVE days(d) AS (
      SELECT date(?1, '-366 days')
      UNION ALL SELECT date(d, '+1 day') FROM days WHERE d < ?1
    ), cal AS (
      SELECT days.d, ${holSel('name')} AS hname, ${holSel('kind')} AS hkind FROM days
    )
    SELECT cal.d AS date,
           COALESCE(sa.status, CASE WHEN cal.hname IS NOT NULL THEN 'holiday' END, '') AS status,
           COALESCE(cal.hname, '') AS label, COALESCE(cal.hkind, '') AS kind
      FROM cal
      LEFT JOIN student_attendance sa ON sa.student_id = ?2 AND sa.on_date = cal.d
     WHERE sa.status IS NOT NULL OR cal.hname IS NOT NULL
     ORDER BY cal.d DESC`).bind(today, target)
    .all<{ date: string; status: string; label: string; kind: string }>()
  return ok({
    items: rows.results.map((r) => {
      const o: Record<string, unknown> = {}
      putStr(o, 'label', r.label); putStr(o, 'kind', r.kind)
      o.on_leave = false; o.date = r.date; o.status = r.status
      return o
    }),
  })
}

// ---------------------------------------------------------------------------
// GET/PUT /portal/family-details

async function getFamilyDetails(c: Ctx): Promise<Response> {
  const sid = await whichChild(c, c.url.searchParams.get('student_id'))
  const d = await c.db.prepare(`
    SELECT st.id AS student_id, ${fullName('st')} AS full_name, st.admission_no, c.name AS class_name, sec.name AS section_name,
           substr(st.date_of_birth, 1, 10) AS date_of_birth, st.gender, st.blood_group,
           st.address_line1, st.address_line2, st.city, st.state, st.pincode
      FROM students st
      ${LATEST_ENROLLMENT}
     WHERE st.id = ?`).bind(sid).first<Record<string, unknown>>()
  if (!d) throw notFound()
  const g = await c.db.prepare(`
    SELECT g.id, g.full_name, g.relation, COALESCE(g.phone, '') AS phone, g.email, g.occupation,
           sg.is_primary, sg.is_emergency, (g.user_id IS NOT NULL AND g.user_id = ?2) AS mine
      FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
     WHERE sg.student_id = ?1
     ORDER BY sg.is_primary DESC, g.relation, g.full_name`).bind(sid, c.id.userId).all<Record<string, unknown>>()
  return ok({
    student_id: d.student_id, full_name: d.full_name, admission_no: d.admission_no,
    class_name: d.class_name ?? null, section_name: d.section_name ?? null, date_of_birth: d.date_of_birth ?? null,
    gender: d.gender ?? null, blood_group: d.blood_group ?? null, address_line1: d.address_line1 ?? null,
    address_line2: d.address_line2 ?? null, city: d.city ?? null, state: d.state ?? null, pincode: d.pincode ?? null,
    guardians: g.results.map((r) => ({
      id: r.id, full_name: r.full_name, relation: r.relation, phone: r.phone, email: r.email ?? null,
      occupation: r.occupation ?? null, is_primary: bool(r.is_primary), is_emergency: bool(r.is_emergency), mine: bool(r.mine),
    })),
  })
}

interface FamilyDetailsUpdate {
  student_id?: string; blood_group?: string; address_line1?: string; address_line2?: string; city?: string; state?: string; pincode?: string
  guardians?: { id?: string; full_name?: string; phone?: string; email?: string; occupation?: string }[]
}
const NOT_OWN_GUARDIAN = "you can change only your own details; ask the office to change another guardian's"
const s = (v: unknown): string => (typeof v === 'string' ? v : '')

async function updateFamilyDetails(c: Ctx): Promise<Response> {
  requirePerm(c, 'self.profile.write')
  const req = await readJSON<FamilyDetailsUpdate>(c.req)
  const sid = await whichChild(c, s(req.student_id))
  const guardians = (Array.isArray(req.guardians) ? req.guardians : []).map((g) => ({
    id: s(g?.id), full_name: s(g?.full_name).trim(), phone: s(g?.phone).trim(), email: s(g?.email).trim(), occupation: s(g?.occupation).trim(),
  }))
  for (const g of guardians) {
    if (!isUUID(g.id)) throw badRequest('guardian id must be a uuid')
    if (g.full_name === '') throw badRequest('a guardian needs a name')
    if (g.phone === '') throw badRequest("a guardian needs a phone number, it is where the school's alerts go")
  }
  // Only the caller's own guardian row on this child; a row that is not theirs
  // is refused before anything is written (the Go transaction rolled back).
  for (const g of guardians) {
    const own = await c.db.prepare(`SELECT 1 AS ok FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id AND sg.student_id = ?
        WHERE g.id = ? AND g.user_id = ?`).bind(sid, g.id.toLowerCase(), c.id.userId).first<{ ok: number }>()
    if (!own) throw forbidden(NOT_OWN_GUARDIAN)
  }
  const t = now()
  const stmts: D1PreparedStatement[] = [
    // students_touch folded in as updated_at.
    c.db.prepare(`UPDATE students SET blood_group = NULLIF(?, ''), address_line1 = NULLIF(?, ''), address_line2 = NULLIF(?, ''),
        city = NULLIF(?, ''), state = NULLIF(?, ''), pincode = NULLIF(?, ''), updated_at = ? WHERE id = ?`)
      .bind(s(req.blood_group).trim(), s(req.address_line1).trim(), s(req.address_line2).trim(), s(req.city).trim(),
        s(req.state).trim(), s(req.pincode).trim(), t, sid),
  ]
  for (const g of guardians) {
    stmts.push(c.db.prepare(`UPDATE guardians SET full_name = ?, phone = ?, email = NULLIF(?, ''), occupation = NULLIF(?, '')
        WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM student_guardians sg WHERE sg.guardian_id = guardians.id AND sg.student_id = ?)`)
      .bind(g.full_name, g.phone, g.email, g.occupation, g.id.toLowerCase(), c.id.userId, sid))
  }
  await c.db.batch(stmts)
  return ok({ ok: true })
}

// ---------------------------------------------------------------------------
// GET /portal/fees (getFamilyFees)

async function getFamilyFees(c: Ctx): Promise<Response> {
  const student = await whichChild(c, c.url.searchParams.get('student_id'))
  const st = await c.db.prepare(`SELECT ${fullName('students')} AS name, admission_no FROM students WHERE id = ?`)
    .bind(student).first<{ name: string; admission_no: string }>()
  if (!st) throw new HttpError(500, 'internal')
  const today = todayIST()
  const inv = await c.db.prepare(`
    SELECT id, invoice_no, instalment_no, substr(issued_on, 1, 10) AS issued_on, substr(due_on, 1, 10) AS due_on,
           COALESCE(net_paise, 0) AS net_paise, paid_paise, fine_paise, status,
           CASE WHEN due_on IS NULL THEN 0 ELSE MAX(0, CAST(julianday(?) - julianday(substr(due_on, 1, 10)) AS INTEGER)) END AS days_overdue
      FROM invoices
     WHERE student_id = ? AND status <> 'cancelled'
     ORDER BY due_on IS NULL, due_on, invoice_no`).bind(today, student).all<Record<string, unknown>>()

  let due = 0
  const ids: string[] = []
  const invoices: Record<string, unknown>[] = []
  const lines: ({ head: string; amount_paise: number; is_fine: boolean }[] | null)[] = []
  for (const r of inv.results) {
    const net = Number(r.net_paise), paid = Number(r.paid_paise)
    const o: Record<string, unknown> = { invoice_no: r.invoice_no }
    put(o, 'instalment_no', r.instalment_no === null ? null : Number(r.instalment_no))
    o.issued_on = r.issued_on
    put(o, 'due_on', r.due_on)
    Object.assign(o, { net_paise: net, paid_paise: paid, due_paise: net - paid, fine_paise: Number(r.fine_paise), status: r.status,
      days_overdue: Number(r.days_overdue) })
    if (net - paid > 0) due += net - paid
    ids.push(String(r.id)); invoices.push(o); lines.push(null)
  }
  if (ids.length > 0) {
    const at = new Map(ids.map((id, i) => [id, i]))
    const f = inList('il.invoice_id', ids)
    const lr = await c.db.prepare(`
      SELECT il.invoice_id, COALESCE(NULLIF(il.description, ''), fh.name) AS head, il.amount_paise - il.discount_paise AS paise
        FROM invoice_lines il JOIN fee_heads fh ON fh.id = il.fee_head_id
       WHERE ${f.sql} AND il.amount_paise - il.discount_paise <> 0
       ORDER BY il.amount_paise DESC`).bind(...f.args).all<{ invoice_id: string; head: string; paise: number }>()
    for (const l of lr.results) {
      const i = at.get(l.invoice_id)
      if (i === undefined) continue
      ;(lines[i] ??= []).push({ head: l.head, amount_paise: Number(l.paise), is_fine: false })
    }
    invoices.forEach((o, i) => {
      if ((o.fine_paise as number) > 0) (lines[i] ??= []).push({ head: 'Late fee / penalty', amount_paise: o.fine_paise as number, is_fine: true })
    })
  }
  invoices.forEach((o, i) => { o.lines = lines[i] })

  const pays = await c.db.prepare(`
    SELECT receipt_no, substr(paid_on, 1, 10) AS paid_on, amount_paise, mode, reference_no, status
      FROM payments WHERE student_id = ?
     ORDER BY paid_on DESC, receipt_no DESC LIMIT 50`).bind(student).all<Record<string, unknown>>()
  const receipts = pays.results.map((p) => {
    const o: Record<string, unknown> = { receipt_no: p.receipt_no ?? '', paid_on: p.paid_on, amount_paise: Number(p.amount_paise), mode: p.mode }
    put(o, 'reference_no', p.reference_no)
    o.status = p.status
    return o
  })
  return ok({ student_id: student, student_name: st.name, admission_no: st.admission_no, outstanding_paise: due, invoices, receipts })
}

// ---------------------------------------------------------------------------
// GET /portal/results (getFamilyResults)

async function getFamilyResults(c: Ctx): Promise<Response> {
  const student = await whichChild(c, c.url.searchParams.get('student_id'))
  const cr = await c.db.prepare(`
    SELECT rc.id, COALESCE(ex.name, t.name, ay.name, 'Result') AS exam, t.name AS term,
           rc.total_marks, rc.max_marks, rc.percentage, rc.grade, rc.gpa,
           rc.rank_in_section, rc.attendance_percent, rc.class_teacher_remarks, substr(rc.published_at, 1, 10) AS published_at
      FROM report_cards rc
      LEFT JOIN exams ex ON ex.id = rc.exam_id
      LEFT JOIN terms t ON t.id = rc.term_id
      LEFT JOIN academic_years ay ON ay.id = rc.academic_year_id
     WHERE rc.student_id = ? AND rc.is_published = 1
     ORDER BY rc.published_at DESC NULLS LAST`).bind(student).all<Record<string, unknown>>()
  const cards = cr.results.map((r) => {
    const o: Record<string, unknown> = { id: r.id, exam: r.exam }
    put(o, 'term', r.term)
    put(o, 'total_marks', numOrNull(r.total_marks)); put(o, 'max_marks', numOrNull(r.max_marks))
    put(o, 'percentage', numOrNull(r.percentage)); put(o, 'grade', r.grade); put(o, 'gpa', numOrNull(r.gpa))
    put(o, 'rank_in_section', numOrNull(r.rank_in_section)); put(o, 'attendance_percent', numOrNull(r.attendance_percent))
    put(o, 'class_teacher_remarks', r.class_teacher_remarks); put(o, 'published_at', r.published_at)
    return o
  })
  const mr = await c.db.prepare(`
    SELECT ex.name AS exam, sub.name AS subject,
           CASE WHEN m.marks_obtained IS NULL THEN NULL
                ELSE CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL), 0) END AS obtained,
           CAST(es.max_marks AS REAL) AS max,
           COALESCE((SELECT gb.grade FROM grade_bands gb
                      WHERE gb.grading_scale_id = ex.grading_scale_id
                        AND round(100.0 * (CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL), 0))
                                  / NULLIF(CAST(es.max_marks AS REAL), 0), 2)
                            BETWEEN CAST(gb.min_percent AS REAL) AND CAST(gb.max_percent AS REAL)
                      LIMIT 1), m.grade) AS grade,
           COALESCE(m.is_absent, 0) AS is_absent
      FROM marks m
      JOIN exam_subjects es ON es.id = m.exam_subject_id
      JOIN exams ex ON ex.id = es.exam_id
      JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN subjects sub ON sub.id = cs.subject_id
     WHERE m.student_id = ?
       AND (ex.is_published = 1
            OR EXISTS (SELECT 1 FROM report_cards rc WHERE rc.student_id = m.student_id AND rc.exam_id = ex.id AND rc.is_published = 1))
     ORDER BY ex.starts_on IS NULL, ex.starts_on, sub.name`).bind(student).all<Record<string, unknown>>()
  const subjects = mr.results.map((r) => {
    const o: Record<string, unknown> = { exam: r.exam, subject: r.subject }
    put(o, 'marks_obtained', numOrNull(r.obtained)); put(o, 'max_marks', numOrNull(r.max)); put(o, 'grade', r.grade)
    o.is_absent = bool(r.is_absent)
    return o
  })
  return ok({ student_id: student, cards, subjects, published: cards.length > 0 || subjects.length > 0 })
}

// ---------------------------------------------------------------------------
// POST /portal/fees/pay (portalSimulatedPay)

/* Go gated this on APP_ENV=production (404 there). The Worker has no such
   flag, and it would write real receipts against real invoices, so it is on
   only when the deployment says APP_ENV is something other than production. */
function simulatedPayEnabled(c: Ctx): boolean {
  const v = c.env.APP_ENV
  return typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== 'production'
}

/** Port of fees.FinancialYear: "2026-27". */
function financialYear(on: string): string {
  let y = Number(on.slice(0, 4)); if (Number(on.slice(5, 7)) < 4) y--
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}
function renderNumber(format: string, prefix: string, fy: string, seq: number, padding: number, suffix: string): string {
  if (!format) format = '{prefix}{fy}/{seq}{suffix}'
  if (!fy) for (const d of ['{fy}/', '{fy}-', '/{fy}', '-{fy}']) format = format.split(d).join('')
  return format.split('{prefix}').join(prefix).split('{fy}').join(fy)
    .split('{seq}').join(String(seq).padStart(padding, '0')).split('{suffix}').join(suffix)
}
/** A statement that fails the batch (primary-key violation) unless `cond` holds: D1's stand-in for FOR UPDATE. */
const assertInBatch = (c: Ctx, cond: string, args: (string | number | null)[]): D1PreparedStatement =>
  c.db.prepare(`INSERT INTO institutions SELECT * FROM institutions WHERE NOT (${cond}) LIMIT 1`).bind(...args)

/** Port of fees.NextNumberOn for the receipt series; returns the number and the statements that advance it. */
async function nextReceiptNumber(c: Ctx, on: string): Promise<{ text: string; seq: number; fy: string; stmts: D1PreparedStatement[] }> {
  const inst = institutionId(c), kind = 'receipt'
  await c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, padding, next_value, reset_yearly, updated_at)
      SELECT ?, ?, ?, 'RCPT/', 5, 1, 1, ? WHERE NOT EXISTS (SELECT 1 FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL)`)
    .bind(uuid(), inst, kind, now(), inst, kind).run()
  const sc = await c.db.prepare(`SELECT prefix, suffix, padding, next_value, reset_yearly, current_fy, format FROM numbering_schemes
      WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(inst, kind)
    .first<{ prefix: string; suffix: string; padding: number; next_value: number; reset_yearly: number; current_fy: string | null; format: string }>()
  if (!sc) throw new Error('numbering scheme receipt missing')
  const stmts: D1PreparedStatement[] = []
  const resetYearly = bool(sc.reset_yearly)
  const currentFY = sc.current_fy ?? ''
  let seq = Number(sc.next_value), fy = ''
  // The scheme row stands in for the lock: nobody may have advanced it since this read.
  stmts.push(assertInBatch(c, `(SELECT next_value FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL) = ?`, [inst, kind, seq]))
  if (resetYearly) {
    fy = financialYear(on)
    let seed = 1
    if (currentFY === '' || currentFY === fy) seed = Number(sc.next_value)
    else {
      const last = await c.db.prepare(`SELECT max(receipt_seq) AS n FROM payments WHERE institution_id = ? AND receipt_fy = ?`)
        .bind(inst, fy).first<{ n: number | null }>()
      if (last && last.n !== null) seed = Number(last.n) + 1
    }
    const ctr = await c.db.prepare(`SELECT next_value FROM numbering_fy_counters WHERE institution_id = ? AND kind = ? AND fy = ?`)
      .bind(inst, kind, fy).first<{ next_value: number }>()
    if (ctr) {
      seq = Number(ctr.next_value)
      stmts.push(assertInBatch(c, `(SELECT next_value FROM numbering_fy_counters WHERE institution_id = ? AND kind = ? AND fy = ?) = ?`, [inst, kind, fy, seq]))
      stmts.push(c.db.prepare(`UPDATE numbering_fy_counters SET next_value = ? WHERE institution_id = ? AND kind = ? AND fy = ?`).bind(seq + 1, inst, kind, fy))
    } else {
      seq = seed
      stmts.push(c.db.prepare(`INSERT INTO numbering_fy_counters (institution_id, kind, fy, next_value) VALUES (?, ?, ?, ?)`).bind(inst, kind, fy, seq + 1))
    }
  }
  const text = renderNumber(sc.format, sc.prefix, fy, seq, Number(sc.padding), sc.suffix)
  const t = now()
  if (!resetYearly || currentFY === '' || currentFY <= fy) {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET next_value = ?, current_fy = NULLIF(?, ''), last_number = ?, last_issued_at = ?, updated_at = ?
        WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(seq + 1, fy, text, t, t, inst, kind))
  } else {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET last_number = ?, last_issued_at = ?, updated_at = ? WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`)
      .bind(text, t, t, inst, kind))
  }
  return { text, seq, fy, stmts }
}

const SIM_REMARKS = 'Simulated payment made from the family portal. ' +
  'No money was taken; this exists so the fee flow can be tested ' +
  'before a payment gateway is connected.'

async function portalSimulatedPay(c: Ctx): Promise<Response> {
  if (!simulatedPayEnabled(c)) throw notFound()
  const student = await whichChild(c, c.url.searchParams.get('student_id'))
  const req = await readJSON<{ invoice_no?: string; amount?: number }>(c.req)

  for (let attempt = 0; ; attempt++) {
    const stu = await c.db.prepare(`SELECT campus_id FROM students WHERE id = ?`).bind(student).first<{ campus_id: string }>()
    if (!stu) throw notFound()

    let invoiceIds: string[] = []
    let owed = 0
    const no = s(req.invoice_no).trim()
    if (no !== '') {
      const iv = await c.db.prepare(`SELECT id, COALESCE(net_paise, 0) - paid_paise AS owed FROM invoices
          WHERE student_id = ? AND invoice_no = ? AND status <> 'cancelled'`).bind(student, no).first<{ id: string; owed: number }>()
      if (!iv) throw notFound()
      owed = Number(iv.owed); invoiceIds = [iv.id]
    } else {
      const r = await c.db.prepare(`SELECT COALESCE(sum(COALESCE(net_paise, 0) - paid_paise), 0) AS owed FROM invoices
          WHERE student_id = ? AND status NOT IN ('cancelled','paid')`).bind(student).first<{ owed: number }>()
      owed = Number(r?.owed ?? 0)
    }
    if (owed <= 0) throw badRequest('there is nothing outstanding to pay')

    let amount = owed
    const reqAmount = typeof req.amount === 'number' && Number.isFinite(req.amount) ? req.amount : 0
    if (reqAmount > 0) amount = Math.trunc(reqAmount * 100 + 0.5)
    if (amount > owed) throw badRequest('that is more than is outstanding')

    const ist = nowInIndia()
    const pad = (n: number) => String(n).padStart(2, '0')
    const paidOn = todayIST()
    const ref = `SIMULATED-${ist.getUTCFullYear()}${pad(ist.getUTCMonth() + 1)}${pad(ist.getUTCDate())}-${pad(ist.getUTCHours())}${pad(ist.getUTCMinutes())}${pad(ist.getUTCSeconds())}`

    // fees.Collect: number, payment, allocation oldest first.
    const number = await nextReceiptNumber(c, paidOn)
    const paymentId = uuid()
    const t = now(), inst = institutionId(c)
    const stmts: D1PreparedStatement[] = [...number.stmts]
    stmts.push(c.db.prepare(`INSERT INTO payments (id, institution_id, campus_id, student_id, receipt_no, receipt_seq, receipt_fy,
        amount_paise, allocated_paise, mode, paid_on, reference_no, status, collected_by, remarks, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, 0, 'online', ?, ?, 'success', ?, ?, ?)`)
      .bind(paymentId, inst, stu.campus_id, student, number.text, number.seq, number.fy, amount, paidOn, ref, c.id.userId, SIM_REMARKS, t))

    // fees.Outstanding
    const dues = await c.db.prepare(`SELECT id, invoice_no, COALESCE(net_paise, 0) - paid_paise AS balance FROM invoices
        WHERE student_id = ? AND status IN ('unpaid','partial','overdue') AND COALESCE(net_paise, 0) > paid_paise
        ORDER BY COALESCE(due_on, issued_on), invoice_no`).bind(student).all<{ id: string; invoice_no: string; balance: number }>()
    let list = dues.results
    if (invoiceIds.length > 0) {
      list = list.filter((d) => invoiceIds.includes(d.id))
      if (list.length === 0) throw notFound('invoice not found')
    }
    let remaining = amount
    const touched: string[] = []
    for (const d of list) {
      if (remaining <= 0) break
      let a = Number(d.balance)
      if (a > remaining) a = remaining
      if (a <= 0) continue
      stmts.push(c.db.prepare(`INSERT INTO payment_allocations (id, institution_id, payment_id, invoice_id, amount_paise, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst, paymentId, d.id, a, t))
      touched.push(d.id)
      remaining -= a
    }
    // Triggers: payment_allocations_sync (sync_invoice_paid, with invoices_touch)
    // and payment_allocations_sync_payment (sync_payment_allocated).
    for (const inv of touched) {
      stmts.push(c.db.prepare(`UPDATE invoices SET paid_paise = COALESCE((SELECT sum(amount_paise) FROM payment_allocations WHERE invoice_id = ?1), 0),
          updated_at = ?2 WHERE id = ?1`).bind(inv, t))
      stmts.push(c.db.prepare(`UPDATE invoices SET status = CASE
          WHEN status = 'cancelled' THEN 'cancelled'
          WHEN paid_paise >= COALESCE(net_paise, 0) AND COALESCE(net_paise, 0) > 0 THEN 'paid'
          WHEN paid_paise > 0 THEN 'partial'
          WHEN due_on IS NOT NULL AND due_on < ?2 THEN 'overdue'
          ELSE 'unpaid' END WHERE id = ?1`).bind(inv, paidOn))
    }
    if (touched.length) {
      stmts.push(c.db.prepare(`UPDATE payments SET allocated_paise = COALESCE((SELECT sum(amount_paise) FROM payment_allocations WHERE payment_id = ?1), 0) WHERE id = ?1`)
        .bind(paymentId))
    }
    const amountText = '₹' + (amount / 100).toFixed(2)
    stmts.push(notifyStmt(c, c.id.userId, student, 'fee_receipt', amountText + ' paid',
      'Receipt ' + number.text + '. This was a test payment, no money was taken.', '/go/fee_receipts', 'receipt', paymentId))

    try {
      await c.db.batch(stmts)
    } catch (e) {
      // A concurrent receipt took this number: the guard failed and nothing was written. Try again.
      if (attempt < 3 && e instanceof Error && /constraint/i.test(e.message)) continue
      throw e
    }
    return ok({ receipt_no: number.text, amount_paise: amount, simulated: true })
  }
}

// ---------------------------------------------------------------------------
// GET /portal/notes (listDisciplineNotes)

async function listDisciplineNotes(c: Ctx): Promise<Response> {
  const scope = await resolveScope(c)
  const p = studentPredicate(scope, 'st')
  const sid = c.url.searchParams.get('student_id') || null
  const visible = can(c.id, 'welfare.discipline.write') ? '1' : 'dr.visible_to_student = 1'
  const rows = await c.db.prepare(`
    SELECT dr.id, dr.student_id, ${shortName('st')} AS student_name, substr(dr.occurred_on, 1, 10) AS occurred_on,
           dr.category, dr.is_positive, dr.description, dr.action_taken, dr.visible_to_student, dr.parent_notified,
           u.full_name AS recorded_by
      FROM discipline_records dr
      JOIN students st ON st.id = dr.student_id
      LEFT JOIN users u ON u.id = dr.recorded_by
     WHERE (? IS NULL OR dr.student_id = ?)
       AND ${visible}
       AND ${p.sql}
     ORDER BY dr.occurred_on DESC, dr.created_at DESC
     LIMIT 300`).bind(sid, sid, ...p.args).all<Record<string, unknown>>()
  return ok({
    items: rows.results.map((r) => {
      const o: Record<string, unknown> = {
        id: r.id, student_id: r.student_id, student_name: r.student_name, occurred_on: r.occurred_on,
        category: r.category, is_positive: bool(r.is_positive), description: r.description,
      }
      put(o, 'action_taken', r.action_taken)
      o.visible_to_student = bool(r.visible_to_student); o.parent_notified = bool(r.parent_notified)
      put(o, 'recorded_by', r.recorded_by)
      return o
    }),
  })
}

// ---------------------------------------------------------------------------
// GET /portal/results/card (renderFamilyReportCard)
// loadReportCardTemplate / gatherReportCard / fillReportCard, as in routes/exams.ts
// (which does not export them).

const reportCardFonts: Record<string, string> = {
  arial: 'Arial, Helvetica, sans-serif',
  calibri: 'Calibri, Candara, Arial, sans-serif',
  times: "'Times New Roman', Times, serif",
}
const escapeHtml = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;')
const txt = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const trimFloat = (v: number) => String(Number(v.toFixed(10)))
const ddmmyyyy = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')

async function loadTemplate(c: Ctx): Promise<{ html: string; css: string }> {
  const fontRow = await c.db.prepare(`SELECT json_extract(config, '$.report_card_font') AS f FROM module_settings WHERE module = 'examinations'`)
    .first<{ f: string | null }>()
  let font = 'times'
  if (fontRow?.f && fontRow.f.toLowerCase() in reportCardFonts) font = fontRow.f.toLowerCase()
  const css = defaultReportCardCSS.split('__FONT__').join(reportCardFonts[font])
  const t = await c.db.prepare(`SELECT template_html FROM report_card_templates WHERE institution_id = ?`)
    .bind(institutionId(c)).first<{ template_html: string }>()
  // An imported design brings its own styling: Go returned an empty css for it.
  return t ? { html: t.template_html, css: '' } : { html: defaultReportCardHTML, css }
}

function imgTag(id: string): string {
  const v = id.trim()
  if (!isUUID(v)) return ''
  return `<img src="/api/v1/files/${escapeHtml(v)}" alt="" style="width:100%;height:100%;max-width:100%;object-fit:cover;display:block">`
}
function stripUnknownPlaceholders(v: string): string {
  for (;;) {
    const i = v.indexOf('{{'); if (i < 0) return v
    const j = v.indexOf('}}', i); if (j < 0) return v
    v = v.slice(0, i) + v.slice(j + 2)
  }
}
function fillReportCard(tpl: string, values: Record<string, string>, subjects: Record<string, string>[]): string {
  let rows = ''
  for (const sub of subjects) {
    rows += '<tr>'
    for (const k of ['subject', 'max_marks', 'marks', 'percent', 'subject_grade']) rows += '<td>' + escapeHtml(sub[k] ?? '') + '</td>'
    rows += '</tr>'
  }
  let out = tpl.split('{{subject_rows}}').join(rows)
  if (out.includes('{{performance_chart}}')) {
    let ch = ''
    const n = subjects.length
    if (n > 0) {
      const bw = 34, gap = 10, base = 132, top = 8
      const w = gap + n * (bw + gap)
      ch += `<svg viewBox="0 0 ${w} 152" width="100%" style="max-width:${w}px" font-family="sans-serif">`
      subjects.forEach((sub, i) => {
        let pct = parseFloat((sub.percent ?? '').trim()) || 0
        if (pct < 0) pct = 0
        if (pct > 100) pct = 100
        const bh = Math.trunc((pct / 100) * (base - top)) + 5
        const x = gap + i * (bw + gap), y = base - bh
        const grade = sub.subject_grade ?? ''
        let name = sub.subject ?? ''
        if (name.length > 4) name = name.slice(0, 4)
        const fill = grade.startsWith('A1') ? '#3f6bbf' : '#6b8fd4'
        ch += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${fill}"/>`
        ch += `<text x="${x + bw / 2}" y="${y - 3}" text-anchor="middle" font-size="9">${escapeHtml(grade)}</text>`
        ch += `<text x="${x + bw / 2}" y="147" text-anchor="middle" font-size="8">${escapeHtml(name)}</text>`
      })
      ch += '</svg>'
    }
    out = out.split('{{performance_chart}}').join(ch)
  }
  out = out.split('{{photo}}').join(imgTag(values.photo_file_id ?? ''))
  out = out.split('{{school_logo}}').join(imgTag(values.logo_file_id ?? ''))
  out = out.split('{{class_teacher_sign}}').join(imgTag(values.teacher_sign_file_id ?? ''))
  out = out.split('{{principal_sign}}').join(imgTag(values.principal_sign_file_id ?? ''))
  for (const [k, v] of Object.entries(values)) {
    if (['photo_file_id', 'logo_file_id', 'teacher_sign_file_id', 'principal_sign_file_id'].includes(k)) continue
    out = out.split('{{' + k + '}}').join(escapeHtml(v))
  }
  return stripUnknownPlaceholders(out)
}

async function gatherReportCard(c: Ctx, cardId: string): Promise<{ values: Record<string, string>; subjects: Record<string, string>[] }> {
  const row = await c.db.prepare(`
    SELECT i.name AS school, i.logo_key, (SELECT b.tagline FROM branding_profiles b WHERE b.campus_id IS NULL LIMIT 1) AS motto,
           ${fullName('st')} AS student, COALESCE(c.name,'') AS class, COALESCE(sec.name,'') AS section, st.admission_no,
           e.roll_no, st.date_of_birth, st.admission_date, st.photo_file_id,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1) AS father,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1) AS mother,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1) AS guardian,
           CAST(rc.max_marks AS REAL) AS total, CAST(rc.total_marks AS REAL) AS obtained, CAST(rc.percentage AS REAL) AS pct,
           CAST(rc.attendance_percent AS REAL) AS attendance, rc.grade,
           COALESCE((SELECT ex.name FROM exams ex WHERE ex.id = rc.exam_id), (SELECT t.name FROM terms t WHERE t.id = rc.term_id), '') AS exam_name,
           ay.name AS year,
           COALESCE((SELECT u.full_name FROM users u WHERE u.id = rc.submitted_by), (SELECT u.full_name FROM users u WHERE u.id = sec.class_teacher_id)) AS class_teacher,
           (SELECT u2.full_name FROM users u2 WHERE u2.id = rc.decided_by) AS principal,
           (SELECT u.signature_file_id FROM users u WHERE u.id = rc.submitted_by) AS teacher_sign,
           (SELECT u2.signature_file_id FROM users u2 WHERE u2.id = rc.decided_by) AS principal_sign,
           rc.rank_in_section AS rank
      FROM report_cards rc
      JOIN students st ON st.id = rc.student_id
      JOIN institutions i ON i.id = rc.institution_id
      JOIN enrollments e ON e.id = rc.enrollment_id
      LEFT JOIN sections sec ON sec.id = e.section_id
      LEFT JOIN classes c ON c.id = sec.class_id
      LEFT JOIN academic_years ay ON ay.id = rc.academic_year_id
     WHERE rc.id = ?`).bind(cardId).first<Record<string, unknown>>()
  if (!row) throw new Error('report card not found')
  const g = (k: string) => txt(row[k])
  const n = (k: string) => { const v = numOrNull(row[k]); return v === null ? '' : trimFloat(v) }
  const values: Record<string, string> = {
    school_name: g('school'), student_name: g('student'), logo_file_id: g('logo_key'), school_motto: g('motto'),
    teacher_sign_file_id: g('teacher_sign'), principal_sign_file_id: g('principal_sign'),
    class: g('class'), section: g('section'), admission_no: g('admission_no'), roll_no: g('roll_no'),
    date_of_birth: ddmmyyyy(row.date_of_birth as string | null), admission_date: ddmmyyyy(row.admission_date as string | null),
    photo_file_id: g('photo_file_id'), father_name: g('father'), mother_name: g('mother'), guardian_name: g('guardian'),
    total_marks: n('total'), marks_obtained: n('obtained'), grade: g('grade'), remarks: '',
    exam_name: g('exam_name'), academic_year: g('year'), class_teacher: g('class_teacher'), principal: g('principal'),
    rank: g('rank'), issued_on: ddmmyyyy(todayIST()), percentage: '', attendance: '', result: '',
  }
  const pct = numOrNull(row.pct)
  if (pct !== null) { values.percentage = pct.toFixed(2) + '%'; values.result = pct >= 33 ? 'PASS' : 'FAIL' }
  const att = numOrNull(row.attendance)
  if (att !== null) values.attendance = att.toFixed(1) + '%'

  const subs = await c.db.prepare(`
    SELECT sub.name, CAST(es.max_marks AS REAL) AS max,
           CASE WHEN m.marks_obtained IS NULL THEN NULL ELSE CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL), 0) END AS got,
           COALESCE((SELECT gb.grade FROM grade_bands gb WHERE gb.grading_scale_id = ex.grading_scale_id
                       AND ROUND(100.0 * (CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL),0)) / NULLIF(CAST(es.max_marks AS REAL),0), 2)
                           BETWEEN CAST(gb.min_percent AS REAL) AND CAST(gb.max_percent AS REAL) LIMIT 1), m.grade) AS g
      FROM report_cards rc
      JOIN enrollments e ON e.id = rc.enrollment_id
      JOIN class_subjects cs ON cs.class_id = e.class_id
      JOIN subjects sub ON sub.id = cs.subject_id
      JOIN exam_subjects es ON es.class_subject_id = cs.id
      JOIN exams ex ON ex.id = es.exam_id AND ex.academic_year_id = rc.academic_year_id
                   AND (rc.exam_id IS NULL OR es.exam_id = rc.exam_id)
                   AND (rc.exam_id IS NOT NULL OR rc.term_id IS NULL OR ex.term_id = rc.term_id)
      LEFT JOIN marks m ON m.exam_subject_id = es.id AND m.student_id = rc.student_id
     WHERE rc.id = ?
     ORDER BY sub.name`).bind(cardId).all<{ name: string; max: number; got: number | null; g: string | null }>()
  const subjects = subs.results.map((x) => {
    const r: Record<string, string> = { subject: x.name, max_marks: trimFloat(Number(x.max)), marks: '-', percent: '-', subject_grade: x.g ?? '' }
    if (x.got !== null) {
      r.marks = trimFloat(Number(x.got))
      if (Number(x.max) > 0) r.percent = `${Math.round((100 * Number(x.got)) / Number(x.max))}%`
    }
    return r
  })
  return { values, subjects }
}

const NOT_YOUR_CARD = 'this is not a report card you can open'

async function renderFamilyReportCard(c: Ctx): Promise<Response> {
  const cardId = (c.url.searchParams.get('id') ?? '').trim()
  if (!isUUID(cardId)) throw badRequest('id must be a uuid')
  const scope = await resolveScope(c)
  if (scope.studentIds.length === 0) throw forbidden(NOT_YOUR_CARD)
  const tpl = await loadTemplate(c)
  const own = inList('rc.student_id', scope.studentIds)
  const allowed = await c.db.prepare(`SELECT 1 AS ok FROM report_cards rc WHERE rc.id = ? AND rc.is_published = 1 AND ${own.sql}`)
    .bind(cardId.toLowerCase(), ...own.args).first<{ ok: number }>()
  if (!allowed) throw forbidden(NOT_YOUR_CARD)
  const card = await gatherReportCard(c, cardId.toLowerCase())
  return ok({ html: fillReportCard(tpl.html, card.values, card.subjects), css: tpl.css })
}

// ---------------------------------------------------------------------------
// GET /portal/admission (getPortalAdmission)

interface AdmissionDoc { doc_type: string; required: boolean; uploaded: boolean; verified: boolean }

function admissionSteps(enquiredOn: string, appliedOn: string | null, decidedOn: string | null, status: string, admitted: boolean,
  docs: AdmissionDoc[]): { steps: Record<string, unknown>[]; next: string } {
  const rank: Record<string, number> = {
    draft: 0, submitted: 1, under_review: 1, documents_pending: 1, test_scheduled: 2, interviewed: 2,
    offered: 3, waitlisted: 3, rejected: 3, withdrawn: 3, accepted: 4,
  }
  let reached = status !== '' ? (rank[status] ?? 0) : 0
  if (admitted) reached = 4
  const missing = docs.filter((d) => d.required && !d.uploaded).length
  const steps: { key: string; label: string; status: string; on: string; note: string }[] = [
    { key: 'enquiry', label: 'Enquiry received', status: '', on: enquiredOn, note: '' },
    { key: 'application', label: 'Application submitted', status: '', on: appliedOn ?? '', note: '' },
    { key: 'documents', label: 'Documents checked', status: '', on: '', note: '' },
    { key: 'decision', label: 'Decision', status: '', on: decidedOn ?? '', note: '' },
    { key: 'admitted', label: 'Admitted', status: '', on: '', note: '' },
  ]
  steps.forEach((st, i) => { st.status = i <= reached - 1 ? 'done' : i === reached ? 'current' : 'pending' })
  steps[0].status = 'done'
  let next = ''
  if (status === '' || status === 'draft') {
    steps[1].status = 'current'; next = 'Fill in the application form to continue.'
  } else if (status === 'rejected') {
    steps[3].status = 'done'; steps[3].note = 'A seat could not be offered this year.'; steps[4].status = 'pending'
  } else if (status === 'withdrawn') {
    steps[3].status = 'done'; steps[3].note = 'This application was withdrawn.'; steps[4].status = 'pending'
  } else if (status === 'waitlisted') {
    steps[3].status = 'current'; steps[3].note = 'On the waiting list. The school will be in touch if a seat opens.'
  } else if (status === 'offered') {
    steps[3].status = 'done'; steps[3].note = 'A seat has been offered.'; steps[4].status = 'current'
    next = 'A seat has been offered. Please contact the office to confirm admission.'
  } else if (missing > 0) {
    steps[2].status = 'current'; next = 'Some required documents are still to be submitted.'
  }
  if (admitted) next = ''
  return {
    steps: steps.map((st) => {
      const o: Record<string, unknown> = { key: st.key, label: st.label, status: st.status }
      putStr(o, 'on', st.on); putStr(o, 'note', st.note)
      return o
    }),
    next,
  }
}

async function getPortalAdmission(c: Ctx): Promise<Response> {
  const u = c.id.userId
  const rows = await c.db.prepare(`
    WITH me AS (SELECT id FROM guardians WHERE user_id = ?1),
    mine AS (
      SELECT e.id AS enquiry_id, e.created_at AS started_at, e.student_name, e.class_sought
        FROM enquiries e
       WHERE e.user_id = ?1 OR e.guardian_id IN (SELECT id FROM me)
    ),
    q AS (
      SELECT m.enquiry_id AS enquiry_id, m.student_name AS student_name, COALESCE(c.name, '') AS class_sought,
             substr(m.started_at, 1, 10) AS enquired_on, COALESCE(a.id, '') AS app_id, COALESCE(a.application_no, '') AS application_no,
             COALESCE(a.status, '') AS status, substr(a.created_at, 1, 10) AS applied_on, substr(a.decided_at, 1, 10) AS decided_on,
             (a.student_id IS NOT NULL) AS admitted, m.started_at AS started_at
        FROM mine m
        LEFT JOIN classes c ON c.id = m.class_sought
        LEFT JOIN applications a ON a.id = (SELECT ap.id FROM applications ap WHERE ap.enquiry_id = m.enquiry_id ORDER BY ap.created_at DESC LIMIT 1)
      UNION ALL
      SELECT '', trim(a.first_name || COALESCE(' ' || a.last_name, '')), COALESCE(c.name, ''),
             substr(a.created_at, 1, 10), a.id, COALESCE(a.application_no, ''), a.status,
             substr(a.created_at, 1, 10), substr(a.decided_at, 1, 10), (a.student_id IS NOT NULL), a.created_at
        FROM applications a
        LEFT JOIN classes c ON c.id = a.class_sought
       WHERE a.guardian_id IN (SELECT id FROM me)
         AND (a.enquiry_id IS NULL OR a.enquiry_id NOT IN (SELECT enquiry_id FROM mine))
    )
    SELECT * FROM q ORDER BY started_at DESC`).bind(u).all<{
      enquiry_id: string; student_name: string; class_sought: string; enquired_on: string; app_id: string; application_no: string
      status: string; applied_on: string | null; decided_on: string | null; admitted: number
    }>()

  const today = todayIST()
  const form = await c.db.prepare(`
    SELECT f.slug FROM admission_forms f
     WHERE f.is_open = 1
       AND (f.opens_on IS NULL OR f.opens_on <= ?1)
       AND (f.closes_on IS NULL OR f.closes_on >= ?1)
       AND EXISTS (SELECT 1 FROM admission_form_versions v WHERE v.form_id = f.id AND v.status = 'published')
     ORDER BY f.updated_at DESC LIMIT 1`).bind(today).first<{ slug: string }>()
  const base = typeof c.env.BASE_URL === 'string' && c.env.BASE_URL ? c.env.BASE_URL : c.url.origin
  const applyURL = form ? base.replace(/\/$/, '') + '/admissions/apply/' + form.slug : ''

  const out: Record<string, unknown>[] = []
  for (const r of rows.results) {
    let docs: AdmissionDoc[] = []
    if (r.app_id !== '') {
      const d = await c.db.prepare(`
        SELECT doc_type, is_required, file_id IS NOT NULL AS uploaded, verified_at IS NOT NULL AS verified
          FROM application_documents WHERE application_id = ?
         ORDER BY is_required DESC, doc_type`).bind(r.app_id)
        .all<{ doc_type: string; is_required: number; uploaded: number; verified: number }>()
      docs = d.results.map((x) => ({ doc_type: x.doc_type, required: bool(x.is_required), uploaded: bool(x.uploaded), verified: bool(x.verified) }))
    }
    const status = r.status ?? ''
    const { steps, next } = admissionSteps(r.enquired_on ?? '', r.applied_on, r.decided_on, status, bool(r.admitted), docs)
    const o: Record<string, unknown> = { enquiry_id: r.enquiry_id ?? '' }
    putStr(o, 'application_id', r.app_id)
    o.student_name = r.student_name
    putStr(o, 'class_sought', r.class_sought)
    o.enquired_on = r.enquired_on ?? ''
    putStr(o, 'application_no', r.application_no)
    o.status = status
    putStr(o, 'next_action', next)
    putStr(o, 'apply_url', status === '' || status === 'draft' ? applyURL : '')
    o.steps = steps
    o.documents = docs
    out.push(o)
  }
  return ok({ items: out })
}

// ---------------------------------------------------------------------------

export function registerPortalFamily(r: Router): void {
  r.get('/portal/students', GROUP, listMyStudents)
  r.get('/portal/students/everywhere', GROUP, listMyChildrenEverywhere)
  r.get('/portal/family-details', GROUP, getFamilyDetails)
  r.put('/portal/family-details', GROUP, updateFamilyDetails)
  r.get('/portal/summary', GROUP, getPortalSummary)
  r.get('/portal/attendance', GROUP, listPortalAttendance)
  r.get('/portal/fees', GROUP, getFamilyFees)
  r.get('/portal/notes', GROUP, listDisciplineNotes)
  r.get('/portal/results', GROUP, getFamilyResults)
  r.get('/portal/results/card', GROUP, renderFamilyReportCard)
  r.post('/portal/fees/pay', GROUP, portalSimulatedPay)
  r.get('/portal/admission', GROUP, getPortalAdmission)
}
