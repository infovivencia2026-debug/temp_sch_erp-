import type { Ctx } from '../../../router'
import { can } from '../../../identity'
import { errorResponse, forbidden, HttpError, isUUID, uuid, now } from '../../../http'
import { buildRouter } from '../../index'
import type { Router } from '../../../router'
import { fullNameSQL, indiaToday, isClassTeacherOf, resolveScope, studentPredicate } from '../../students/common'
import { splitName } from '../../students/write'
import { requireOpenMonth } from '../../exams/common'

/* THE ASSISTANT CAN CHANGE DATA -- BUT ONLY BY PROPOSING, NEVER BY ITSELF.
   Port of internal/api/assistant_actions.go.

   The model emits a small fixed ACTION from the catalogue below. The server
   validates it, computes a real before/after preview under the ASKER'S OWN
   identity, and the browser draws a confirmation card. Nothing is written
   until the person presses Confirm (POST /assistant/action), which re-checks
   the permission and writes under the person's own school and scope.

   Go's execute steps called the same apply* functions the screens call
   (applyMarksEntry, upsertStudent, upsertGuardianForStudent, applyFeePayment,
   applyCreateEnquiry). Here they are reached by dispatching to the Worker's
   own route for that screen (see dispatch), with the caller's identity, so the
   validation, scope checks and side effects are exactly the screen's. */

export const ACTION_OPEN = '<<<ACTION>>>'
export const ACTION_CLOSE = '<<<END>>>'

export interface ProposedAction {
  kind: string
  title: string
  summary: string
  before?: string
  after?: string
  sensitive: boolean
  params: Record<string, unknown>
}

type Params = Record<string, unknown>
interface ActionSpec {
  perm: string
  sensitive: boolean
  preview: (c: Ctx, p: Params) => Promise<ProposedAction>
  execute: (c: Ctx, p: Params) => Promise<string>
}

/** A refusal the person reads: becomes a plain sentence (preview) or a 422 action_failed (execute). */
export class ActionRefusal extends Error {}
const refuse = (m: string) => new ActionRefusal(m)

export const ASSISTANT_ACTION_CATALOGUE = `
CHANGING DATA. You may propose a change ONLY from this exact list, and only when
the person clearly asks to make that change. You never state that a change is
done -- you PROPOSE it, and the person confirms it on a card. To propose one,
end your reply with a single line of the form:
` + ACTION_OPEN + `{"kind":"<kind>","params":{...}}` + ACTION_CLOSE + `
Put one short sentence before it saying what you are about to do. Emit the line
ONLY for a real change request, never for a "how do I" question, and never
invent a kind or a parameter that is not listed here.

Available actions:
- attendance.mark, mark one student present or absent for a day.
  params: {"student": "<name or admission number>", "date": "YYYY-MM-DD (optional, defaults to today)", "status": "present|absent|late|half_day|leave|holiday"}
- marks.enter, set or update one student's mark for a subject in an exam.
  params: {"student": "<name or admission number>", "exam": "<exam name, e.g. Term 1>", "subject": "<subject name, e.g. Maths>", "marks": <number>, "is_absent": <true if the child sat no paper, optional>}
- student.create, admit a new student and place them in a section.
  params: {"name": "<full name>", "class": "<class, e.g. 6>", "section": "<section, e.g. A>", "guardian_name": "<parent name, optional>", "guardian_phone": "<parent phone, optional>"}
- guardian.set_phone, add or correct a guardian's phone for a student.
  params: {"student": "<name or admission number>", "phone": "<new phone>", "guardian_name": "<which parent, optional, defaults to the primary guardian>", "relation": "father|mother|guardian|other (optional)"}
- fee.payment, record an ordinary counter fee payment for a student.
  params: {"student": "<name or admission number>", "amount": <rupees>, "mode": "cash|upi|card|neft|cheque|dd|netbanking (defaults to cash)", "head": "<what the payment is for, e.g. tuition, optional>", "reference_no": "<instrument/UPI reference, required for cheque or DD>"}
- enquiry.create, log an admissions enquiry for a prospective student.
  params: {"student_name": "<child name>", "class_sought": "<class, e.g. 3>", "parent_name": "<parent name, optional>", "phone": "<parent phone>", "source": "walk_in|phone|website|referral|campaign|other (optional)"}

fee.payment records an ORDINARY counter payment only. You can never touch bank
accounts, refunds, payroll, deletions, logins or passwords: if a change like
that is asked for, say you cannot make it and who can.`

/** parseProposedAction: the action out of a model reply, tolerant of fences and whitespace. */
export function parseProposedAction(answer: string): { clean: string; kind?: string; params?: Params } {
  const i = answer.indexOf(ACTION_OPEN)
  if (i < 0) return { clean: answer }
  const j = answer.indexOf(ACTION_CLOSE, i)
  if (j < 0) return { clean: answer }
  const raw = answer.slice(i + ACTION_OPEN.length, j)
  const clean = (answer.slice(0, i) + answer.slice(j + ACTION_CLOSE.length)).trim()
  try {
    const parsed = JSON.parse(raw.trim()) as { kind?: unknown; params?: unknown }
    if (typeof parsed.kind !== 'string' || parsed.kind === '') return { clean }
    const params = parsed.params && typeof parsed.params === 'object' ? parsed.params as Params : {}
    return { clean, kind: parsed.kind, params }
  } catch {
    return { clean }
  }
}

// --- param readers -------------------------------------------------------------
const pstr = (p: Params, k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '')
function pfloat(p: Params, k: string): number | null {
  const v = p[k]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') { const f = Number(v.trim()); return Number.isFinite(f) ? f : null }
  return null
}
function pbool(p: Params, k: string): boolean {
  const v = p[k]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') { const s = v.trim().toLowerCase(); return s === 'true' || s === 'yes' || s === '1' }
  return false
}
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
const fmtNum = (n: number) => String(n)

// --- dispatch: the screen's own route, as the caller ------------------------------
let router: Router | null = null
/** Runs one of the Worker's own routes with the caller's identity; the result is its status and JSON. */
export async function dispatch(c: Ctx, method: 'POST' | 'PUT', path: string, body: BodyInit, contentType: string): Promise<{ status: number; data: Record<string, unknown> }> {
  router = router ?? buildRouter()
  const url = new URL('/api/v1' + path, c.url)
  const hit = router.match(method, url.pathname)
  if (!hit) throw new Error('assistant dispatch: no route for ' + method + ' ' + url.pathname)
  if (hit.route.perm !== 'auth' && !can(c.id, hit.route.perm)) throw forbidden('missing permission: ' + hit.route.perm)
  const headers = new Headers(c.req.headers)
  headers.delete('content-length'); headers.delete('idempotency-key'); headers.delete('x-column-map')
  headers.set('content-type', contentType)
  const req = new Request(url.toString(), { method, headers, body })
  const sub: Ctx = { req, env: c.env, url, params: hit.params, id: c.id, get db() { return c.db } }
  let res: Response
  try { res = await hit.route.handler(sub) } catch (e) { res = errorResponse(e) }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  return { status: res.status, data }
}
/** The refusal message a dispatched route answered with. */
const refusalOf = (d: Record<string, unknown>, fallback: string) =>
  typeof d.error === 'string' ? d.error : (d.error as { message?: string } | undefined)?.message ?? fallback

// --- students ----------------------------------------------------------------------
interface Found { id: string; name: string; adm: string; section: string | null }
const LATEST_SECTION = `(SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)`

/** resolveOneStudent: every word of the query, in any order, somewhere in the full name; or the admission number. */
async function resolveOneStudent(c: Ctx, q: string): Promise<Found> {
  const ql = q.trim().toLowerCase()
  if (ql === '') throw refuse('no student named')
  const name = `lower(${fullNameSQL('st')})`
  const toks = ql.split(/\s+/).filter(Boolean)
  const tokenClause = toks.length ? '(' + toks.map((_, i) => `${name} LIKE ?${i + 2}`).join(' AND ') + ')' : '0'
  const rows = await c.db.prepare(`
    SELECT st.id, ${fullNameSQL('st')} AS name, st.admission_no AS adm, ${LATEST_SECTION} AS section
      FROM students st
     WHERE st.status = 'active'
       AND ( lower(st.admission_no) = ?1 OR ${name} = ?1 OR (length(?1) >= 3 AND ${tokenClause}) )
     ORDER BY (lower(st.admission_no) = ?1) DESC, (${name} = ?1) DESC
     LIMIT 3`)
    .bind(ql, ...toks.map((t) => '%' + t + '%')).all<Found>()
  const found = rows.results
  if (found.length === 0) throw refuse(`no active student matches "${q}"`)
  if (found.length > 1 && found[0].adm.toLowerCase() !== q.toLowerCase() && found[0].name.toLowerCase() !== q.toLowerCase()) {
    throw refuse(`more than one student matches "${q}", use their admission number`)
  }
  return found[0]
}

/** resolveOneStudentByID: a pinned id, so a stale card cannot be replayed onto another child. */
async function resolveOneStudentByID(c: Ctx, idStr: string, nameFallback: string): Promise<Found> {
  if (isUUID(idStr.trim())) {
    const row = await c.db.prepare(`SELECT st.id, ${fullNameSQL('st')} AS name, st.admission_no AS adm, ${LATEST_SECTION} AS section
        FROM students st WHERE st.id = ? AND st.status = 'active'`).bind(idStr.trim()).first<Found>()
    if (!row) throw refuse('that student could not be found')
    return row
  }
  return resolveOneStudent(c, nameFallback)
}

// --- attendance.mark --------------------------------------------------------------
const ATTENDANCE = new Set(['present', 'absent', 'late', 'half_day', 'leave', 'holiday'])

async function previewAttendanceMark(c: Ctx, p: Params): Promise<ProposedAction> {
  const status = pstr(p, 'status').toLowerCase()
  const date = pstr(p, 'date') || indiaToday()
  if (!isDate(date)) throw refuse('the date must be YYYY-MM-DD')
  if (!ATTENDANCE.has(status)) throw refuse('the status must be present, absent, late, half_day, leave or holiday')
  const s = await resolveOneStudent(c, pstr(p, 'student'))
  if (!s.section) throw refuse(`${s.name} is not placed in a section yet`)
  if (!isClassTeacherOf(await resolveScope(c), s.section)) throw refuse('you can only mark attendance for your own sections')
  const cur = await c.db.prepare(`SELECT status FROM student_attendance WHERE student_id = ? AND on_date = ? AND period_id IS NULL`)
    .bind(s.id, date).first<{ status: string }>()
  return {
    kind: 'attendance.mark', title: 'Mark attendance', sensitive: false,
    summary: `Set ${s.name} (${s.adm}) to “${status}” for ${date}.`,
    before: cur?.status ?? 'not marked', after: status,
    params: { student_id: s.id, date, status, name: s.name },
  }
}

async function executeAttendanceMark(c: Ctx, p: Params): Promise<string> {
  const status = pstr(p, 'status').toLowerCase()
  const date = pstr(p, 'date') || indiaToday()
  if (!ATTENDANCE.has(status)) throw refuse('invalid status')
  if (!isDate(date)) throw refuse('invalid date')
  const s = await resolveOneStudentByID(c, pstr(p, 'student_id'), pstr(p, 'student'))
  if (!s.section) throw refuse(`${s.name} is not placed in a section`)
  if (!isClassTeacherOf(await resolveScope(c), s.section)) throw refuse('you can only mark attendance for your own sections')
  await requireOpenMonth(c, Number(date.slice(0, 4)), Number(date.slice(5, 7)))
  /* The daily partial unique index is not an upsert target on D1, so the
     upsert is read-then-write, and only a changed status is written, as Go's
     ON CONFLICT ... WHERE status IS DISTINCT FROM. */
  const cur = await c.db.prepare(`SELECT id, status FROM student_attendance WHERE student_id = ? AND on_date = ? AND period_id IS NULL`)
    .bind(s.id, date).first<{ id: string; status: string }>()
  const ts = now()
  if (cur) {
    if (cur.status !== status) {
      await c.db.prepare(`UPDATE student_attendance SET status = ?, corrected_from = ?, corrected_by = ?, corrected_at = ? WHERE id = ?`)
        .bind(status, cur.status, c.id.userId, ts, cur.id).run()
    }
  } else {
    await c.db.prepare(`INSERT INTO student_attendance (id, institution_id, student_id, section_id, on_date, period_id, status, minutes_late, remarks, marked_by, marked_at)
        VALUES (?,?,?,?,?,NULL,?,0,'',?,?)`)
      .bind(uuid(), c.id.institution!.id, s.id, s.section, date, status, c.id.userId, ts).run()
  }
  return `Marked ${s.name} (${s.adm}) “${status}” for ${date}.`
}

// --- marks.enter ---------------------------------------------------------------------
async function previewMarksEnter(c: Ctx, p: Params): Promise<ProposedAction> {
  const exam = pstr(p, 'exam'), subject = pstr(p, 'subject')
  if (exam === '' || subject === '') throw refuse('name both the exam and the subject')
  const isAbsent = pbool(p, 'is_absent')
  let marks = 0
  if (!isAbsent) {
    const m = pfloat(p, 'marks')
    if (m === null) throw refuse('the mark must be a number')
    marks = m
  }
  const res = await resolveScope(c)
  const s = await resolveOneStudent(c, pstr(p, 'student'))
  const found = await c.db.prepare(`
    SELECT es.id, CAST(es.max_marks AS REAL) AS max, COALESCE(sub.name,'') AS subject, e.name AS exam,
           (SELECT m.marks_obtained FROM marks m WHERE m.exam_subject_id = es.id AND m.student_id = ?1) AS mark,
           COALESCE((SELECT m.is_absent FROM marks m WHERE m.exam_subject_id = es.id AND m.student_id = ?1), 0) AS absent
      FROM exam_subjects es
      JOIN exams e           ON e.id = es.exam_id
      JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN subjects sub      ON sub.id = cs.subject_id
      JOIN enrollments en    ON en.class_id = cs.class_id AND en.student_id = ?1 AND en.status = 'active'
     WHERE lower(e.name) LIKE '%' || lower(?2) || '%'
       AND lower(sub.name) LIKE '%' || lower(?3) || '%'
     ORDER BY e.created_at DESC
     LIMIT 2`).bind(s.id, exam, subject).all<{ id: string; max: number; subject: string; exam: string; mark: string | number | null; absent: number }>()
  if (found.results.length === 0) throw refuse(`no "${subject}" paper for "${exam}" in this student's class`)
  if (found.results.length > 1) throw refuse(`more than one paper matches "${exam}" / "${subject}", name the exam and subject exactly`)
  const h = found.results[0]
  const max = Number(h.max)
  if (!isAbsent && (marks < 0 || marks > max)) throw refuse(`${fmtNum(marks)} is outside 0–${fmtNum(max)} for ${h.subject}`)
  // canWriteMarks: the same authorisation the marks screen enforces.
  if (!(res.anySection || res.platformAdmin)) {
    const okRow = await c.db.prepare(`
      SELECT (EXISTS (SELECT 1 FROM exam_subjects es
                JOIN section_subject_teachers t ON t.class_subject_id = es.class_subject_id AND t.teacher_user_id = ?2
                JOIN enrollments en ON en.section_id = t.section_id AND en.status = 'active' AND en.student_id = ?3
               WHERE es.id = ?1)
          OR EXISTS (SELECT 1 FROM enrollments en JOIN sections sec ON sec.id = en.section_id
               WHERE en.status = 'active' AND en.student_id = ?3 AND sec.class_teacher_id = ?2)) AS ok`)
      .bind(h.id, c.id.userId, s.id).first<{ ok: number }>()
    if (!okRow?.ok) throw refuse('you are neither the subject teacher of this paper nor the class teacher of this student')
  }
  const before = h.absent ? 'absent' : h.mark !== null && h.mark !== undefined ? fmtNum(Number(h.mark)) : 'not entered'
  const after = isAbsent ? 'absent' : `${fmtNum(marks)} / ${fmtNum(max)}`
  return {
    kind: 'marks.enter', title: 'Enter a mark', sensitive: false,
    summary: `Set ${s.name} (${s.adm}) in ${h.subject} for ${h.exam} to ${after}.`,
    before, after,
    params: { exam_subject_id: h.id, student_id: s.id, marks, is_absent: isAbsent, name: s.name },
  }
}

async function executeMarksEnter(c: Ctx, p: Params): Promise<string> {
  const esId = pstr(p, 'exam_subject_id'), sid = pstr(p, 'student_id')
  if (!isUUID(esId)) throw refuse('the exam paper could not be identified')
  if (!isUUID(sid)) throw refuse('the student could not be identified')
  const isAbsent = pbool(p, 'is_absent')
  const entry = { student_id: sid, marks_obtained: isAbsent ? null : (pfloat(p, 'marks') ?? 0), is_absent: isAbsent }
  // POST /exams/marks re-runs the full scope check on exactly the pinned paper and child.
  const r = await dispatch(c, 'POST', '/exams/marks', JSON.stringify({ exam_subject_id: esId, entries: [entry] }), 'application/json')
  if (r.status === 403) throw refuse('you may not write marks on this paper')
  if (r.status !== 200) throw refuse(refusalOf(r.data, 'the mark could not be saved'))
  if (Number(r.data.written ?? 0) === 0) throw refuse('nothing was written')
  return `Recorded the mark for ${pstr(p, 'name')}.`
}

// --- student.create --------------------------------------------------------------------
async function resolveSectionLabel(c: Ctx, label: string): Promise<{ id: string; display: string }> {
  const row = await c.db.prepare(`
    SELECT s.id, c.name || '-' || s.name AS display
      FROM sections s JOIN classes c ON c.id = s.class_id
     WHERE lower(c.name || '-' || s.name) = lower(?1) OR lower(c.name || s.name) = lower(?1)
     ORDER BY c.name, s.name LIMIT 1`).bind(label).first<{ id: string; display: string }>()
  if (!row) throw refuse(`no class and section called "${label}", create it first, and write it as the school does (e.g. 6 and A)`)
  return row
}

async function previewStudentCreate(c: Ctx, p: Params): Promise<ProposedAction> {
  let name = pstr(p, 'name')
  if (name === '') name = (pstr(p, 'first_name') + ' ' + pstr(p, 'last_name')).trim()
  if (name === '') throw refuse('the child needs a name')
  const [first, middle, last] = splitName(name)
  const cls = pstr(p, 'class'), sec = pstr(p, 'section')
  const label = cls && sec ? cls + '-' + sec : cls || sec
  const guardianName = pstr(p, 'guardian_name'), guardianPhone = pstr(p, 'guardian_phone')
  let sectionId = '', display = ''
  if (label !== '') ({ id: sectionId, display } = await resolveSectionLabel(c, label))
  let after = name + (display ? ' · ' + display : '')
  if (guardianName) after += ' · guardian ' + guardianName + (guardianPhone ? ` (${guardianPhone})` : '')
  return {
    kind: 'student.create', title: 'Admit a new student', sensitive: true,
    summary: `Admit ${name}${display ? ' into ' + display : ''}.`,
    before: 'no such student yet', after,
    params: { first_name: first, middle_name: middle, last_name: last, section_id: sectionId, guardian_name: guardianName,
      guardian_phone: guardianPhone, name, section_label: display },
  }
}

async function executeStudentCreate(c: Ctx, p: Params): Promise<string> {
  const body: Record<string, string> = {
    first_name: pstr(p, 'first_name'), middle_name: pstr(p, 'middle_name'), last_name: pstr(p, 'last_name'),
    section_id: pstr(p, 'section_id'), guardian_name: pstr(p, 'guardian_name'), guardian_phone: pstr(p, 'guardian_phone'),
  }
  for (const k of Object.keys(body)) if (body[k] === '') delete body[k]
  const r = await dispatch(c, 'POST', '/students', JSON.stringify(body), 'application/json')
  if (r.status !== 200 && r.status !== 201) throw refuse(refusalOf(r.data, 'the student could not be admitted'))
  const lbl = pstr(p, 'section_label')
  return `Admitted ${pstr(p, 'name')}${lbl ? ' into ' + lbl : ''} (admission no ${String(r.data.admission_no ?? '')}).`
}

// --- guardian.set_phone ------------------------------------------------------------------
async function previewGuardianSetPhone(c: Ctx, p: Params): Promise<ProposedAction> {
  const phone = pstr(p, 'phone'), who = pstr(p, 'guardian_name')
  let relation = pstr(p, 'relation').toLowerCase()
  if (phone === '') throw refuse('give the new phone number')
  const pred = studentPredicate(await resolveScope(c), 'st')
  const s = await resolveOneStudent(c, pstr(p, 'student'))
  const allowed = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(s.id, ...pred.args).first()
  if (!allowed) throw refuse(`${s.name} is not a child you can edit`)
  const g = await c.db.prepare(`
    SELECT g.id, g.full_name, g.relation, COALESCE(g.email,'') AS email, COALESCE(g.phone,'') AS phone
      FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
     WHERE sg.student_id = ?1 ${who ? `AND lower(g.full_name) LIKE '%' || lower(?2) || '%' ORDER BY sg.is_primary DESC` : 'ORDER BY sg.is_primary DESC, g.created_at'}
     LIMIT 1`).bind(...(who ? [s.id, who] : [s.id])).first<{ id: string; full_name: string; relation: string; email: string; phone: string }>()
  const params: Params = { student_id: s.id, phone, name: s.name }
  if (!g) {
    if (who === '') throw refuse(`${s.name} has no guardian on record, give the guardian's name to add one`)
    if (relation === '') relation = 'guardian'
    params.full_name = who; params.relation = relation
    return { kind: 'guardian.set_phone', title: 'Add a guardian phone', sensitive: false,
      summary: `Add ${who} (${phone}) as a guardian of ${s.name} (${s.adm}).`, before: 'no guardian named ' + who, after: phone, params }
  }
  params.guardian_id = g.id; params.full_name = g.full_name; params.relation = g.relation; params.email = g.email
  return { kind: 'guardian.set_phone', title: 'Correct a guardian phone', sensitive: false,
    summary: `Change ${g.full_name}'s phone (guardian of ${s.name}, ${s.adm}).`, before: g.phone || 'no phone', after: phone, params }
}

async function executeGuardianSetPhone(c: Ctx, p: Params): Promise<string> {
  const phone = pstr(p, 'phone')
  if (phone === '') throw refuse('give the new phone number')
  const s = await resolveOneStudentByID(c, pstr(p, 'student_id'), pstr(p, 'student'))
  const body: Record<string, string> = { id: pstr(p, 'guardian_id'), full_name: pstr(p, 'full_name'), relation: pstr(p, 'relation'), phone, email: pstr(p, 'email') }
  for (const k of Object.keys(body)) if (body[k] === '') delete body[k]
  // POST /students/{id}/guardians applies the student predicate and the phone-taken rule.
  const r = await dispatch(c, 'POST', `/students/${s.id}/guardians`, JSON.stringify(body), 'application/json')
  if (r.status === 409) throw refuse('that number is already the sign-in of another account here')
  if (r.status !== 200 && r.status !== 201) throw refuse(refusalOf(r.data, 'the phone could not be saved'))
  return `Saved the guardian phone for ${s.name}.`
}

// --- fee.payment ------------------------------------------------------------------------------
const MODES = new Set(['cash', 'cheque', 'dd', 'neft', 'upi', 'card', 'netbanking', 'adjustment', 'wallet'])
function amountToPaise(p: Params): number | null {
  const ap = pfloat(p, 'amount_paise')
  if (ap !== null) return Math.trunc(ap)
  const a = pfloat(p, 'amount')
  return a === null ? null : Math.round(a * 100)
}
const rupeesFixed = (paise: number) => '₹' + (paise / 100).toFixed(2)

async function previewFeePayment(c: Ctx, p: Params): Promise<ProposedAction> {
  const paise = amountToPaise(p)
  if (paise === null || paise <= 0) throw refuse('give the amount as a positive number of rupees')
  const mode = pstr(p, 'mode').toLowerCase() || 'cash'
  if (!MODES.has(mode)) throw refuse('the mode must be one of cash, upi, card, neft, cheque, dd or netbanking')
  const head = pstr(p, 'head') || pstr(p, 'purpose')
  const s = await resolveOneStudent(c, pstr(p, 'student'))
  const r = rupeesFixed(paise)
  return {
    kind: 'fee.payment', title: 'Record a fee payment', sensitive: true,
    summary: `Record ${r} from ${s.name} (${s.adm}) by ${mode}.`,
    before: 'no payment yet', after: r + ' · ' + mode + (head ? ' · ' + head : ''),
    params: { student_id: s.id, amount_paise: paise, mode, head, reference_no: pstr(p, 'reference_no'), name: s.name },
  }
}

async function executeFeePayment(c: Ctx, p: Params): Promise<string> {
  const paise = amountToPaise(p)
  if (paise === null || paise <= 0) throw refuse('invalid amount')
  const mode = pstr(p, 'mode').toLowerCase() || 'cash'
  const s = await resolveOneStudentByID(c, pstr(p, 'student_id'), pstr(p, 'student'))
  const body: Record<string, unknown> = { student_id: s.id, amount_paise: paise, mode }
  if (pstr(p, 'head')) body.remarks = pstr(p, 'head')
  if (pstr(p, 'reference_no')) body.reference_no = pstr(p, 'reference_no')
  // The ordinary counter path (POST /fees/payments): no bank account, refund or payroll is reachable.
  const r = await dispatch(c, 'POST', '/fees/payments', JSON.stringify(body), 'application/json')
  if (r.status !== 200 && r.status !== 201) throw refuse(refusalOf(r.data, 'the payment could not be recorded'))
  const amt = rupeesFixed(Number(r.data.amount_paise ?? paise))
  const receipt = String(r.data.receipt_no ?? '')
  if (r.data.cleared === false) return `Recorded ${amt} from ${pstr(p, 'name')} by ${mode}, receipt ${receipt}, counts once it clears.`
  return `Recorded ${amt} from ${pstr(p, 'name')}, receipt ${receipt}.`
}

// --- enquiry.create -------------------------------------------------------------------------
const SOURCES = new Set(['walk_in', 'phone', 'website', 'referral', 'campaign', 'other'])

async function previewEnquiryCreate(_c: Ctx, p: Params): Promise<ProposedAction> {
  const child = pstr(p, 'student_name') || pstr(p, 'child_name')
  const phone = pstr(p, 'phone')
  if (child === '' || phone === '') throw refuse("give the child's name and a phone number")
  const source = pstr(p, 'source').toLowerCase() || 'walk_in'
  if (!SOURCES.has(source)) throw refuse('source must be one of: walk_in, phone, website, referral, campaign, other')
  const cls = pstr(p, 'class_sought') || pstr(p, 'class')
  const parent = pstr(p, 'parent_name')
  const after = child + (cls ? ' · class ' + cls : '') + (parent ? ' · ' + parent : '') + ' · ' + phone
  return {
    kind: 'enquiry.create', title: 'Log an admissions enquiry', sensitive: false,
    summary: `Log an enquiry for ${child}${cls ? ' (class ' + cls + ')' : ''}.`,
    before: 'no enquiry yet', after,
    params: { student_name: child, parent_name: parent, phone, class_sought: cls, source, email: pstr(p, 'email') },
  }
}

async function executeEnquiryCreate(c: Ctx, p: Params): Promise<string> {
  const body: Record<string, string> = {
    student_name: pstr(p, 'student_name'), parent_name: pstr(p, 'parent_name'), phone: pstr(p, 'phone'),
    email: pstr(p, 'email'), class_sought: pstr(p, 'class_sought'), source: pstr(p, 'source').toLowerCase(),
  }
  for (const k of Object.keys(body)) if (body[k] === '') delete body[k]
  const r = await dispatch(c, 'POST', '/admissions/workflow/enquiries', JSON.stringify(body), 'application/json')
  if (r.status !== 200 && r.status !== 201) throw refuse(refusalOf(r.data, 'the enquiry could not be logged'))
  return `Logged an enquiry for ${body.student_name}.`
}

/** The whole catalogue of what the assistant may change; nothing else can be proposed or executed. */
export const ASSISTANT_ACTIONS: Record<string, ActionSpec> = {
  'attendance.mark': { perm: 'academics.attendance.write', sensitive: false, preview: previewAttendanceMark, execute: executeAttendanceMark },
  'marks.enter': { perm: 'academics.marks.write', sensitive: false, preview: previewMarksEnter, execute: executeMarksEnter },
  'student.create': { perm: 'students.write', sensitive: true, preview: previewStudentCreate, execute: executeStudentCreate },
  'guardian.set_phone': { perm: 'students.write', sensitive: false, preview: previewGuardianSetPhone, execute: executeGuardianSetPhone },
  'fee.payment': { perm: 'finance.payments.write', sensitive: true, preview: previewFeePayment, execute: executeFeePayment },
  'enquiry.create': { perm: 'admissions.write', sensitive: false, preview: previewEnquiryCreate, execute: executeEnquiryCreate },
}

/** A refusal or a data error, as the sentence Go's fmt.Errorf carried. */
export function refusalText(e: unknown): string {
  if (e instanceof ActionRefusal || e instanceof HttpError) return e.message
  return 'that change could not be prepared'
}
