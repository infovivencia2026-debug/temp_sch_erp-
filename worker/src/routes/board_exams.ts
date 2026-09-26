import type { Router, Ctx, Handler } from '../router'
import { can } from '../identity'
import { badRequest, bool, forbidden, isUUID, notFound, ok, created, readJSON, uuid, uuidParam, now } from '../http'
import { coded, dateOf, inList, items, js, nameOf, str, todayIST } from './exams/common'
import {
  type CandidateKey, type ResultLine, lineJSON, matchBoardLines, parseBoardResultCSV, percentOf, round1,
} from './board_exams/results'
import { school } from './school'

/* Port of mountBoardExams in internal/api/board_exams.go (mounted at /exams,
   so every path below is /exams/board/...) and getStaffCalendar in
   internal/api/staff_calendar.go (GET /me/calendar). Field names, defaults
   and refusals follow the Go.

   The Go group carries academics.exams.read as middleware and each route adds
   a second permission. The router takes one, so the route is registered with
   the second and `inExams` checks the group's one first. */

const EXAMS_READ = 'academics.exams.read'
const EXAMS_WRITE = 'academics.exams.write'
const STUDENTS_READ_ALL = 'students.read.all'
const REPORTS_READ = 'admin.reports.read'
const SELF_READ = 'self.profile.read'

const NAME = nameOf('st')
const SHORT_NAME = nameOf('st', false)

/** The examinations this file keeps a roll for, by class level. */
const BOARD_STAGES: Record<string, number> = { ssc: 10, inter_first_year: 11, inter_second_year: 12 }
const SENT = `('submitted','accepted','hall_ticket_issued')`
const BASIS = "the school's candidates are the registrations for this year and stage that have been submitted to the board"

const inExams = (h: Handler): Handler => (c) => {
  if (!can(c.id, EXAMS_READ)) throw forbidden()
  return h(c)
}
const opt = (v: string | null | undefined): string | null => (v && v.trim() !== '' ? v : null)
const optQ = (c: Ctx, k: string) => opt(c.url.searchParams.get(k))
/** to_char(ts,'YYYY-MM-DD HH24:MI') on an ISO text column. */
const minuteText = (col: string) => `REPLACE(SUBSTR(${col},1,16),'T',' ')`
const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)
const isNoRows = (e: unknown) => e instanceof NoRows
class NoRows extends Error {}

export function registerBoardExams(r: Router): void {
  // --- the nominal roll -----------------------------------------------------
  r.get('/exams/board/registrations', STUDENTS_READ_ALL, inExams(listBoardRegistrations))
  r.get('/exams/board/eligible', STUDENTS_READ_ALL, inExams(listBoardEligible))
  r.post('/exams/board/registrations', EXAMS_WRITE, inExams(addBoardCandidates))
  r.put('/exams/board/registrations/{id}', EXAMS_WRITE, inExams(editBoardRegistration))
  r.post('/exams/board/registrations/{id}/verify', EXAMS_WRITE, inExams(verifyBoardRegistration))
  r.post('/exams/board/submit', EXAMS_WRITE, inExams(submitBoardRoll))
  r.post('/exams/board/registrations/{id}/board-response', EXAMS_WRITE, inExams(recordBoardResponse))
  // --- corrections after submission ------------------------------------------
  r.get('/exams/board/amendments', STUDENTS_READ_ALL, inExams(listBoardAmendments))
  r.post('/exams/board/registrations/{id}/amendments', EXAMS_WRITE, inExams(raiseBoardAmendment))
  r.post('/exams/board/amendments/{id}/decide', EXAMS_WRITE, inExams(decideBoardAmendment))
  // --- the result file ---------------------------------------------------------
  r.get('/exams/board/results/imports', STUDENTS_READ_ALL, inExams(listBoardResultImports))
  r.get('/exams/board/results/reconciliation', STUDENTS_READ_ALL, inExams(getBoardReconciliation))
  r.post('/exams/board/results/import', EXAMS_WRITE, inExams(importBoardResults))
  r.post('/exams/board/results/rows/{id}/match', EXAMS_WRITE, inExams(matchBoardResultRow))
  r.post('/exams/board/results/imports/{id}/publish', EXAMS_WRITE, inExams(publishBoardResults))
  // --- analysis ------------------------------------------------------------------
  r.get('/exams/board/analysis/baseline', REPORTS_READ, inExams(getBaselineAnalysis))
  r.get('/exams/board/performance', REPORTS_READ, inExams(getBoardPerformance))

  r.get('/me/calendar', SELF_READ, getStaffCalendar)
}

// ============================================================ the nominal roll

interface Candidate {
  id: string
  student_id: string
  admission_no: string
  candidate_name: string
  school_record_name: string
  class_name: string
  board: string
  exam_name: string
  stage: string
  candidate_type: string
  group_code: string | null
  medium: string | null
  second_language: string | null
  father_name: string | null
  mother_name: string | null
  date_of_birth: string | null
  apaar_id: string | null
  registration_no: string | null
  hall_ticket_no: string | null
  subjects: string
  fee_paid_paise: number
  status: string
  verified: number
  submitted_on: string | null
  board_ack_no: string | null
  remarks: string | null
  open_amendments: number
}

/** Everything from submission onwards is the board's copy too. */
const boardRollLocked = (status: string) => status !== 'draft' && status !== 'verified'

/** What the board would reject the row for. */
function candidateProblems(v: {
  candidate_name: string; father_name: string | null; date_of_birth: string | null; medium: string | null
  subjects: string | null; stage: string; group_code: string | null
}): string[] {
  const out: string[] = []
  if (v.candidate_name.trim() === '') out.push('no candidate name')
  if (!v.father_name || v.father_name.trim() === '') out.push("no father's name")
  if (!v.date_of_birth) out.push('no date of birth')
  if (!v.medium || v.medium.trim() === '') out.push('no medium of instruction')
  if (!v.subjects || v.subjects === '[]' || v.subjects === 'null') out.push('no subjects chosen')
  if (v.stage.startsWith('inter') && (!v.group_code || v.group_code.trim() === '')) out.push('no group (MPC, BiPC, CEC, MEC or HEC)')
  return out
}

/** Omit-empty for the nullable strings of the Go structs. */
function withOptional(o: Record<string, unknown>, opts: Record<string, string | null | undefined>): Record<string, unknown> {
  for (const [k, v] of Object.entries(opts)) if (v !== null && v !== undefined) o[k] = v
  return o
}

const listBoardRegistrations: Handler = async (c) => {
  const stage = optQ(c, 'stage'), year = optQ(c, 'academic_year_id'), status = optQ(c, 'status'), classId = optQ(c, 'class_id')
  const rows = await c.db.prepare(`
    SELECT br.id, br.student_id, st.admission_no,
           COALESCE(br.candidate_name, ${NAME}) AS candidate_name,
           ${NAME} AS school_record_name,
           COALESCE(c.name,'') AS class_name, br.board, br.exam_name, COALESCE(br.stage,'') AS stage,
           br.candidate_type, br.group_code, br.medium, br.second_language,
           br.father_name, br.mother_name, ${dateOf('br.date_of_birth')} AS date_of_birth,
           br.apaar_id, br.registration_no, br.hall_ticket_no, br.subjects,
           br.fee_paid_paise, br.status, br.verified_at IS NOT NULL AS verified,
           ${dateOf('br.submitted_on')} AS submitted_on, br.board_ack_no, br.remarks,
           (SELECT COUNT(*) FROM board_registration_amendments a
             WHERE a.registration_id = br.id AND a.status IN ('requested','sent')) AS open_amendments
      FROM board_registrations br
      JOIN students st ON st.id = br.student_id
      LEFT JOIN classes c ON c.id = br.class_id
     WHERE (?1 IS NULL OR br.stage = ?1)
       AND (?2 IS NULL OR br.academic_year_id = ?2)
       AND (?3 IS NULL OR br.status = ?3)
       AND (?4 IS NULL OR br.class_id = ?4)
     ORDER BY COALESCE(c.name,''), LOWER(COALESCE(br.candidate_name, st.first_name))`)
    .bind(stage, year, status, classId).all<Candidate>()

  const summary: Record<string, number> = {
    candidates: rows.results.length, draft: 0, verified: 0, submitted: 0, rejected: 0, incomplete: 0, open_amendments: 0,
  }
  const out = rows.results.map((v) => {
    const problems = candidateProblems(v)
    switch (v.status) {
      case 'draft': summary.draft++; break
      case 'verified': summary.verified++; break
      case 'rejected': summary.rejected++; break
      default: summary.submitted++
    }
    if (problems.length > 0) summary.incomplete++
    summary.open_amendments += Number(v.open_amendments)
    const o: Record<string, unknown> = {
      id: v.id, student_id: v.student_id, admission_no: v.admission_no, candidate_name: v.candidate_name,
      school_record_name: v.school_record_name, class_name: v.class_name, board: v.board, exam_name: v.exam_name,
      stage: v.stage, candidate_type: v.candidate_type,
    }
    withOptional(o, {
      group_code: v.group_code, medium: v.medium, second_language: v.second_language, father_name: v.father_name,
      mother_name: v.mother_name, date_of_birth: v.date_of_birth, apaar_id: v.apaar_id, registration_no: v.registration_no,
      hall_ticket_no: v.hall_ticket_no,
    })
    o.subjects = parseJSONOr(v.subjects, [])
    o.fee_paid_paise = Number(v.fee_paid_paise)
    o.status = v.status
    o.verified = bool(v.verified)
    withOptional(o, { submitted_on: v.submitted_on, board_ack_no: v.board_ack_no, remarks: v.remarks })
    o.open_amendments = Number(v.open_amendments)
    o.problems = problems
    o.locked = boardRollLocked(v.status)
    return o
  })
  return ok({ items: out, summary })
}

function parseJSONOr(text: string | null, fallback: unknown): unknown {
  if (text === null || text === undefined) return fallback
  try { return JSON.parse(text) } catch { return fallback }
}

const listBoardEligible: Handler = async (c) => {
  const stage = (c.url.searchParams.get('stage') ?? '').trim()
  const level = BOARD_STAGES[stage] ?? null
  const rows = await c.db.prepare(`
    SELECT st.id AS student_id, st.admission_no, ${NAME} AS name, c.id AS class_id, c.name AS class_name, c.level,
           ${dateOf('st.date_of_birth')} AS date_of_birth, st.medium, st.second_language, st.apaar_id,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1) AS father_name,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1) AS mother_name
      FROM enrollments e
      JOIN students st ON st.id = e.student_id AND st.status = 'active'
      JOIN classes c ON c.id = e.class_id
     WHERE e.status = 'active'
       AND (?1 IS NULL OR e.academic_year_id = ?1)
       AND (?2 IS NULL OR c.id = ?2)
       AND (?3 IS NULL OR c.level = ?3)
       AND NOT EXISTS (
           SELECT 1 FROM board_registrations br
            WHERE br.student_id = st.id AND br.academic_year_id = e.academic_year_id
              AND (?4 IS NULL OR br.stage = ?4))
     ORDER BY c.level, c.name, st.admission_no`)
    .bind(optQ(c, 'academic_year_id'), optQ(c, 'class_id'), level, opt(stage))
    .all<{ student_id: string; admission_no: string; name: string; class_id: string; class_name: string; level: number
      date_of_birth: string | null; medium: string | null; second_language: string | null; apaar_id: string | null
      father_name: string | null; mother_name: string | null }>()
  return ok(items(rows.results.map((v) => withOptional(
    { student_id: v.student_id, admission_no: v.admission_no, name: v.name, class_id: v.class_id, class_name: v.class_name, level: Number(v.level) },
    { date_of_birth: v.date_of_birth, medium: v.medium, second_language: v.second_language, apaar_id: v.apaar_id,
      father_name: v.father_name, mother_name: v.mother_name }))))
}

/** Port of workingYearIn + boardAcademicYear: the named year, else the caller's working year, else the latest. */
async function boardAcademicYear(c: Ctx, given: string | undefined): Promise<string> {
  const explicit = (given ?? '').trim()
  if (explicit) {
    if (!isUUID(explicit)) throw badRequest('academic_year_id names no academic year of this school')
    const r = await c.db.prepare(`SELECT id FROM academic_years WHERE id = ?`).bind(explicit).first<{ id: string }>()
    if (!r) throw badRequest('academic_year_id names no academic year of this school')
    return r.id
  }
  const chosen = await c.db.prepare(`SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?`)
    .bind(c.id.userId).first<{ id: string }>()
  if (chosen) return chosen.id
  const latest = await c.db.prepare(`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<{ id: string }>()
  if (!latest) throw badRequest('no academic year exists; name one explicitly')
  return latest.id
}

interface CandidateRequest {
  student_id?: string; student_ids?: string[]; academic_year_id?: string; board?: string; exam_name?: string; stage?: string
  candidate_type?: string; group_code?: string; medium?: string; second_language?: string; subjects?: string[]
}

/* Drafts a registration for each named student, copying the particulars from
   the school's record at draft time. A student already on the roll is left as
   they are (INSERT OR IGNORE on the (student, year, exam_name) key). */
const addBoardCandidates: Handler = async (c) => {
  const req = await readJSON<CandidateRequest>(c.req)
  const ids = [...(req.student_ids ?? [])]
  if (req.student_id) ids.push(req.student_id)
  if (ids.length === 0) throw badRequest('name at least one student to add to the roll')
  const board = (req.board ?? '').trim(), examName = (req.exam_name ?? '').trim(), stage = (req.stage ?? '').trim()
  if (board === '' || examName === '') throw badRequest('the roll needs a board and an examination name')
  if (!(stage in BOARD_STAGES)) throw badRequest('stage must be ssc, inter_first_year or inter_second_year')
  const candidateType = req.candidate_type || 'regular'
  if (req.subjects !== undefined && req.subjects !== null && !Array.isArray(req.subjects)) throw badRequest('subjects must be a list of subject names')
  const subjects = JSON.stringify(req.subjects ?? null)
  const year = await boardAcademicYear(c, req.academic_year_id)
  const inst = school(c).id
  const at = now()

  const stmts = ids.map((sid) => c.db.prepare(`
    INSERT OR IGNORE INTO board_registrations (
        id, institution_id, student_id, academic_year_id, class_id, board, exam_name,
        stage, candidate_type, group_code, medium, second_language, subjects,
        candidate_name, father_name, mother_name, date_of_birth, apaar_id, status, created_at)
    SELECT ?1, ?2, st.id, ?3,
           (SELECT e.class_id FROM enrollments e WHERE e.student_id = st.id AND e.academic_year_id = ?3 AND e.status = 'active' LIMIT 1),
           ?4, ?5, ?6, ?7, NULLIF(?8,''),
           COALESCE(NULLIF(?9,''), st.medium),
           COALESCE(NULLIF(?10,''), st.second_language),
           ?11, ${NAME},
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1),
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1),
           st.date_of_birth, st.apaar_id, 'draft', ?13
      FROM students st WHERE st.id = ?12 AND st.status = 'active'`)
    .bind(uuid(), inst, year, board, examName, stage, candidateType, req.group_code ?? '', req.medium ?? '',
      req.second_language ?? '', subjects, String(sid), at))
  let added = 0
  try {
    const results = await c.db.batch(stmts)
    for (const r of results) added += r.meta.changes
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : String(e))
  }
  return created({ added, already_on_roll: ids.length - added })
}

interface EditRequest {
  candidate_name?: string; father_name?: string; mother_name?: string; date_of_birth?: string; medium?: string
  second_language?: string; group_code?: string; candidate_type?: string; apaar_id?: string; registration_no?: string
  hall_ticket_no?: string; subjects?: string[] | null; fee_paid_paise?: number; remarks?: string
}

const LOCKED_MSG = 'this candidate has already been sent to the board. Corrections after submission are amendments: ' +
  'raise one against this registration so the change carries a before, an after and a reason.'
const UNIQUE_MSG = 'another candidate already holds that registration or hall ticket number'

/* Corrects a draft; refused once the roll has gone. A corrected row loses its verification. */
const editBoardRegistration: Handler = async (c) => {
  const regID = uuidParam(c.params.id)
  const req = await readJSON<EditRequest>(c.req)
  let subjects: string | null = null
  if (req.subjects !== undefined && req.subjects !== null) {
    if (!Array.isArray(req.subjects)) throw badRequest('subjects must be a list of subject names')
    subjects = JSON.stringify(req.subjects)
  }
  const cur = await c.db.prepare(`SELECT status FROM board_registrations WHERE id = ?`).bind(regID).first<{ status: string }>()
  if (!cur) throw notFound()
  if (boardRollLocked(cur.status)) throw coded(409, 'amendment_required', LOCKED_MSG)
  const fee = Number(req.fee_paid_paise ?? 0)
  try {
    await c.db.prepare(`
      UPDATE board_registrations SET
          candidate_name  = COALESCE(NULLIF(?2,''), candidate_name),
          father_name     = COALESCE(NULLIF(?3,''), father_name),
          mother_name     = COALESCE(NULLIF(?4,''), mother_name),
          date_of_birth   = COALESCE(NULLIF(?5,''), date_of_birth),
          medium          = COALESCE(NULLIF(?6,''), medium),
          second_language = COALESCE(NULLIF(?7,''), second_language),
          group_code      = COALESCE(NULLIF(?8,''), group_code),
          candidate_type  = COALESCE(NULLIF(?9,''), candidate_type),
          apaar_id        = COALESCE(NULLIF(?10,''), apaar_id),
          registration_no = COALESCE(NULLIF(?11,''), registration_no),
          hall_ticket_no  = COALESCE(NULLIF(?12,''), hall_ticket_no),
          subjects        = COALESCE(?13, subjects),
          fee_paid_paise  = CASE WHEN ?14 > 0 THEN ?14 ELSE fee_paid_paise END,
          remarks         = COALESCE(NULLIF(?15,''), remarks),
          status          = 'draft', verified_at = NULL, verified_by = NULL
       WHERE id = ?1`)
      .bind(regID, str(req.candidate_name), str(req.father_name), str(req.mother_name), str(req.date_of_birth),
        str(req.medium), str(req.second_language), str(req.group_code), str(req.candidate_type), str(req.apaar_id),
        str(req.registration_no), str(req.hall_ticket_no), subjects, Number.isFinite(fee) ? Math.trunc(fee) : 0, str(req.remarks)).run()
  } catch (e) {
    if (isUniqueViolation(e)) throw badRequest(UNIQUE_MSG)
    throw e
  }
  return ok({ id: regID, status: 'draft' })
}

/* The checking pass: refused while anything the board asks for is missing. */
const verifyBoardRegistration: Handler = async (c) => {
  const regID = uuidParam(c.params.id)
  const v = await c.db.prepare(`
    SELECT COALESCE(candidate_name,'') AS candidate_name, father_name, medium, ${dateOf('date_of_birth')} AS date_of_birth,
           subjects, group_code, COALESCE(stage,'') AS stage, status
      FROM board_registrations WHERE id = ?`).bind(regID)
    .first<{ candidate_name: string; father_name: string | null; medium: string | null; date_of_birth: string | null
      subjects: string; group_code: string | null; stage: string; status: string }>()
  if (!v) throw notFound()
  if (boardRollLocked(v.status)) throw coded(409, 'already_submitted', 'this candidate has already been sent to the board')
  const problems = candidateProblems(v)
  if (problems.length > 0) throw coded(400, 'incomplete', 'the board would reject this candidate: ' + problems.join('; '))
  await c.db.prepare(`UPDATE board_registrations SET status = 'verified', verified_at = ?2, verified_by = ?3 WHERE id = ?1`)
    .bind(regID, now(), c.id.userId).run()
  return ok({ id: regID, status: 'verified' })
}

/* Sends a roll, once. Rows that would be rejected are held back and named;
   rows already sent are counted and left with their original date. */
const submitBoardRoll: Handler = async (c) => {
  const req = await readJSON<{ stage?: string; exam_name?: string; academic_year_id?: string; board_ack_no?: string }>(c.req)
  const year = await boardAcademicYear(c, req.academic_year_id)
  const rows = await c.db.prepare(`
    SELECT br.id, st.admission_no, COALESCE(br.candidate_name,'') AS candidate_name, br.father_name, br.medium,
           ${dateOf('br.date_of_birth')} AS date_of_birth, br.subjects, br.group_code, COALESCE(br.stage,'') AS stage, br.status
      FROM board_registrations br JOIN students st ON st.id = br.student_id
     WHERE br.academic_year_id = ?1 AND (?2 IS NULL OR br.stage = ?2) AND (?3 IS NULL OR br.exam_name = ?3)`)
    .bind(year, opt(req.stage), opt(req.exam_name))
    .all<{ id: string; admission_no: string; candidate_name: string; father_name: string | null; medium: string | null
      date_of_birth: string | null; subjects: string; group_code: string | null; stage: string; status: string }>()
  let alreadySent = 0
  const rejected: { registration_id: string; candidate_name: string; admission_no: string; problems: string[] }[] = []
  const send: string[] = []
  for (const v of rows.results) {
    if (boardRollLocked(v.status)) { alreadySent++; continue }
    const p = candidateProblems(v)
    if (p.length > 0) { rejected.push({ registration_id: v.id, candidate_name: v.candidate_name, admission_no: v.admission_no, problems: p }); continue }
    send.push(v.id)
  }
  if (send.length === 0 && alreadySent === 0 && rejected.length === 0) throw badRequest('this roll has no candidates yet')
  let submitted = 0
  const today = todayIST()
  if (send.length > 0) {
    const r = await c.db.prepare(`
      UPDATE board_registrations
         SET status = 'submitted', submitted_on = ?1, submitted_at = ?2, submitted_by = ?3,
             board_ack_no = COALESCE(NULLIF(?4,''), board_ack_no)
       WHERE id IN ${inList(send)}`)
      .bind(today, now(), c.id.userId, str(req.board_ack_no), js(send)).run()
    submitted = r.meta.changes
  }
  return ok({ submitted, already_submitted: alreadySent, held_back: rejected.length, rejected, submitted_on: today })
}

/* Writes down what the board sent back. Refused before submission. */
const recordBoardResponse: Handler = async (c) => {
  const regID = uuidParam(c.params.id)
  const req = await readJSON<{ registration_no?: string; hall_ticket_no?: string; status?: string; remarks?: string }>(c.req)
  const status = (req.status ?? '').trim()
  if (!['', 'accepted', 'hall_ticket_issued', 'rejected'].includes(status)) throw badRequest('status must be accepted, hall_ticket_issued or rejected')
  const cur = await c.db.prepare(`SELECT status FROM board_registrations WHERE id = ?`).bind(regID).first<{ status: string }>()
  if (!cur) throw notFound()
  if (!boardRollLocked(cur.status)) {
    throw coded(409, 'not_submitted', 'this candidate has not been sent to the board yet, so the board cannot have answered about them')
  }
  try {
    await c.db.prepare(`
      UPDATE board_registrations
         SET registration_no = COALESCE(NULLIF(?2,''), registration_no),
             hall_ticket_no  = COALESCE(NULLIF(?3,''), hall_ticket_no),
             status          = COALESCE(NULLIF(?4,''), status),
             remarks         = COALESCE(NULLIF(?5,''), remarks)
       WHERE id = ?1`).bind(regID, str(req.registration_no), str(req.hall_ticket_no), status, str(req.remarks)).run()
  } catch (e) {
    if (isUniqueViolation(e)) throw badRequest(UNIQUE_MSG)
    throw e
  }
  return ok({ id: regID, status })
}

// ============================================================ corrections after submission

/** An allow-list: a request body must never be able to name a column. */
const AMENDABLE: Record<string, { column: string; cast: 'text' | 'date' | 'jsonb' }> = {
  candidate_name: { column: 'candidate_name', cast: 'text' },
  father_name: { column: 'father_name', cast: 'text' },
  mother_name: { column: 'mother_name', cast: 'text' },
  date_of_birth: { column: 'date_of_birth', cast: 'date' },
  medium: { column: 'medium', cast: 'text' },
  second_language: { column: 'second_language', cast: 'text' },
  group_code: { column: 'group_code', cast: 'text' },
  candidate_type: { column: 'candidate_type', cast: 'text' },
  apaar_id: { column: 'apaar_id', cast: 'text' },
  registration_no: { column: 'registration_no', cast: 'text' },
  hall_ticket_no: { column: 'hall_ticket_no', cast: 'text' },
  subjects: { column: 'subjects', cast: 'jsonb' },
}
const amendableFieldList = () => Object.keys(AMENDABLE).sort().join(', ')

const listBoardAmendments: Handler = async (c) => {
  const rows = await c.db.prepare(`
    SELECT a.id, a.registration_id, COALESCE(br.candidate_name, ${SHORT_NAME}) AS candidate_name,
           st.admission_no, a.field, a.old_value, a.new_value, a.reason, a.status, a.board_ref, u.full_name AS requested_by,
           ${minuteText('a.requested_at')} AS requested_at, ${minuteText('a.decided_at')} AS decided_at,
           ${minuteText('a.applied_at')} AS applied_at
      FROM board_registration_amendments a
      JOIN board_registrations br ON br.id = a.registration_id
      JOIN students st ON st.id = br.student_id
      LEFT JOIN users u ON u.id = a.requested_by
     WHERE (?1 IS NULL OR a.registration_id = ?1)
       AND (?2 IS NULL OR a.status = ?2)
       AND (?3 IS NULL OR br.stage = ?3)
     ORDER BY a.requested_at DESC`)
    .bind(optQ(c, 'registration_id'), optQ(c, 'status'), optQ(c, 'stage'))
    .all<{ id: string; registration_id: string; candidate_name: string; admission_no: string; field: string; old_value: string | null
      new_value: string | null; reason: string; status: string; board_ref: string | null; requested_by: string | null
      requested_at: string; decided_at: string | null; applied_at: string | null }>()
  return ok(items(rows.results.map((v) => {
    const o: Record<string, unknown> = { id: v.id, registration_id: v.registration_id, candidate_name: v.candidate_name,
      admission_no: v.admission_no, field: v.field }
    withOptional(o, { old_value: v.old_value, new_value: v.new_value })
    o.reason = v.reason; o.status = v.status
    withOptional(o, { board_ref: v.board_ref, requested_by: v.requested_by })
    o.requested_at = v.requested_at
    withOptional(o, { decided_at: v.decided_at, applied_at: v.applied_at })
    return o
  })))
}

/* Records a correction to a submitted candidate. The old value is read from
   the row, never taken from the request. */
const raiseBoardAmendment: Handler = async (c) => {
  const regID = uuidParam(c.params.id)
  const req = await readJSON<{ field?: string; new_value?: string; reason?: string }>(c.req)
  const fieldName = (req.field ?? '').trim()
  const field = AMENDABLE[fieldName]
  if (!field) throw badRequest('that field cannot be amended: ' + amendableFieldList())
  const reason = (req.reason ?? '').trim()
  if (reason === '') throw badRequest('the board asks why the correction is needed; a blank reason cannot be answered for later')
  const cur = await c.db.prepare(`SELECT status, ${field.column} AS old_value FROM board_registrations WHERE id = ?`)
    .bind(regID).first<{ status: string; old_value: string | null }>()
  if (!cur) throw notFound()
  if (!boardRollLocked(cur.status)) throw coded(409, 'not_submitted', 'this candidate has not been sent yet. Correct the draft instead')
  const dup = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM board_registration_amendments
      WHERE registration_id = ?1 AND field = ?2 AND status IN ('requested','sent')) AS d`)
    .bind(regID, req.field).first<{ d: number }>()
  if (dup?.d) throw coded(409, 'already_open', 'a correction to that field is already with the board; settle it before raising another')
  const newID = uuid()
  const newValue = str(req.new_value)
  await c.db.prepare(`
    INSERT INTO board_registration_amendments (id, institution_id, registration_id, field, old_value, new_value, reason, requested_by, requested_at)
    VALUES (?,?,?,?,?,NULLIF(?,''),?,?,?)`)
    .bind(newID, school(c).id, regID, req.field, cur.old_value, newValue, reason, c.id.userId, now()).run()
  return created({ id: newID, field: req.field, old_value: cur.old_value ?? '', new_value: newValue, status: 'requested' })
}

/* Settles a correction; the school's own copy moves only when the board accepts. */
const decideBoardAmendment: Handler = async (c) => {
  const amendID = uuidParam(c.params.id)
  const req = await readJSON<{ decision?: string; board_ref?: string }>(c.req)
  const decision = (req.decision ?? '').trim().toLowerCase()
  if (!['sent', 'accepted', 'rejected'].includes(decision)) throw badRequest('decision must be sent, accepted or rejected')
  const a = await c.db.prepare(`SELECT registration_id, field, status, new_value FROM board_registration_amendments WHERE id = ?`)
    .bind(amendID).first<{ registration_id: string; field: string; status: string; new_value: string | null }>()
  if (!a) throw notFound()
  if (a.status === 'accepted' || a.status === 'rejected') throw badRequest('this correction has already been settled')
  const boardRef = str(req.board_ref)
  if (decision === 'sent') {
    await c.db.prepare(`UPDATE board_registration_amendments SET status = 'sent', board_ref = COALESCE(NULLIF(?2,''), board_ref) WHERE id = ?1`)
      .bind(amendID, boardRef).run()
    return ok({ id: amendID, status: decision, applied: false })
  }
  const stmts: D1PreparedStatement[] = []
  let applied = false
  if (decision === 'accepted') {
    const field = AMENDABLE[a.field]
    if (!field) throw badRequest('this correction names a field that can no longer be amended')
    const value = a.new_value ?? ''
    // The casts Postgres applied: a date must parse, subjects must be JSON.
    if (value !== '' && field.cast === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest(`invalid input syntax for type date: "${value}"`)
    if (value !== '' && field.cast === 'jsonb') { try { JSON.parse(value) } catch { throw badRequest(`invalid input syntax for type json`) } }
    stmts.push(c.db.prepare(`UPDATE board_registrations SET ${field.column} = NULLIF(?2,'') WHERE id = ?1`).bind(a.registration_id, value))
    applied = true
  }
  const at = now()
  stmts.push(c.db.prepare(`
    UPDATE board_registration_amendments
       SET status = ?2, decided_by = ?3, decided_at = ?4, board_ref = COALESCE(NULLIF(?5,''), board_ref),
           applied_at = CASE WHEN ?2 = 'accepted' THEN ?4 ELSE applied_at END
     WHERE id = ?1`).bind(amendID, decision, c.id.userId, at, boardRef))
  try {
    await c.db.batch(stmts)
  } catch (e) {
    if (isUniqueViolation(e)) throw badRequest(UNIQUE_MSG)
    throw badRequest(e instanceof Error ? e.message : String(e))
  }
  return ok({ id: amendID, status: decision, applied })
}

// ============================================================ the result file

interface Missing {
  registration_id: string; student_id: string; admission_no: string; candidate_name: string; class_name: string
  hall_ticket_no?: string; registration_no?: string; status: string
}

function missingJSON(m: { registration_id: string; student_id: string; admission_no: string; candidate_name: string
  class_name: string; hall_ticket_no: string | null; registration_no: string | null; status: string }): Missing {
  const o: Missing = { registration_id: m.registration_id, student_id: m.student_id, admission_no: m.admission_no,
    candidate_name: m.candidate_name, class_name: m.class_name, status: m.status }
  if (m.hall_ticket_no !== null) o.hall_ticket_no = m.hall_ticket_no
  if (m.registration_no !== null) o.registration_no = m.registration_no
  return o
}

/** The candidates a result file should account for: the ones actually sent. */
async function loadBoardCandidates(c: Ctx, year: string, stage: string | null): Promise<CandidateKey[]> {
  const rows = await c.db.prepare(`
    SELECT br.id AS registration_id, br.student_id, st.admission_no,
           COALESCE(br.candidate_name, ${NAME}) AS name, COALESCE(c.name,'') AS class_name,
           br.hall_ticket_no, br.registration_no, br.status
      FROM board_registrations br
      JOIN students st ON st.id = br.student_id
      LEFT JOIN classes c ON c.id = br.class_id
     WHERE br.academic_year_id = ?1 AND (?2 IS NULL OR br.stage = ?2) AND br.status IN ${SENT}
     ORDER BY st.admission_no`).bind(year, stage)
    .all<Omit<CandidateKey, 'used'>>()
  return rows.results.map((r) => ({ ...r, used: false }))
}

interface ImportRequest {
  board?: string; exam_name?: string; stage?: string; academic_year_id?: string; file_name?: string; note?: string
  csv?: string; commit?: boolean
}

/* Reads the board's published file and reconciles it. Nothing is discarded:
   unmatched lines are stored verbatim and reported, as are the school's own
   candidates the file omits. Without commit it writes nothing. */
const importBoardResults: Handler = async (c) => {
  const req = await readJSON<ImportRequest>(c.req)
  if ((req.csv ?? '').trim() === '') throw badRequest("paste or upload the board's result file")
  const board = (req.board ?? '').trim(), examName = (req.exam_name ?? '').trim()
  if (board === '' || examName === '') throw badRequest('name the board and the examination this file is for')
  let lines: ResultLine[]
  try { lines = parseBoardResultCSV(req.csv!) } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
  if (lines.length === 0) throw badRequest('the file has a header but no candidates')

  const commit = !!req.commit
  const year = await boardAcademicYear(c, req.academic_year_id)
  const stage = opt(req.stage)
  const candidates = await loadBoardCandidates(c, year, stage)
  matchBoardLines(lines, candidates)

  const inFile: ResultLine[] = [], matches: ResultLine[] = []
  for (const l of lines) (l.student_id ? matches : inFile).push(l)
  const inSchool = candidates.filter((k) => !k.used).map((k) => missingJSON({ ...k, candidate_name: k.name }))

  let importID: string | undefined
  if (commit) {
    importID = uuid()
    const inst = school(c).id, at = now()
    const stmts = [c.db.prepare(`
      INSERT INTO board_result_imports (id, institution_id, academic_year_id, board, exam_name, stage, file_name, note,
                                        row_count, matched_count, imported_by, imported_at)
      VALUES (?,?,?,?,?,NULLIF(?,''),NULLIF(?,''),NULLIF(?,''),?,?,?,?)`)
      .bind(importID, inst, year, board, examName, str(req.stage), str(req.file_name), str(req.note), lines.length, matches.length, c.id.userId, at)]
    for (const l of lines) {
      l.id = uuid()
      stmts.push(c.db.prepare(`
        INSERT INTO board_result_rows (id, institution_id, import_id, line_no, hall_ticket_no, registration_no, candidate_name,
                                       student_id, registration_id, match_method, result, total_marks, max_marks, subjects, raw,
                                       matched_at, matched_by)
        VALUES (?,?,?,?,NULLIF(?,''),NULLIF(?,''),NULLIF(?,''),NULLIF(?,''),?,?,NULLIF(?,''),?,?,?,?,?,?)`)
        .bind(l.id, inst, importID, l.line_no, l.hall_ticket_no, l.registration_no, l.candidate_name, l.student_id,
          l.registration_id, l.match_method, l.result, l.total_marks, l.max_marks, l.subjects, JSON.stringify(l.raw),
          l.student_id ? at : null, l.student_id ? c.id.userId : null))
    }
    try {
      await c.db.batch(stmts)
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e))
    }
  }
  const out: Record<string, unknown> = {}
  if (importID) out.import_id = importID
  Object.assign(out, {
    dry_run: !commit, rows: lines.length, matched: matches.length, basis: BASIS,
    in_file_not_in_school: inFile.map(lineJSON), in_school_not_in_file: inSchool, matches: matches.map(lineJSON),
    published: false,
  })
  return commit ? created(out) : ok(out)
}

const listBoardResultImports: Handler = async (c) => {
  const rows = await c.db.prepare(`
    SELECT i.id, i.board, i.exam_name, i.stage, i.file_name, i.row_count AS rows, i.matched_count AS matched,
           i.row_count - i.matched_count AS unmatched,
           (SELECT COUNT(*) FROM board_registrations br
             WHERE br.academic_year_id = i.academic_year_id AND (i.stage IS NULL OR br.stage = i.stage)
               AND br.status IN ${SENT}
               AND NOT EXISTS (SELECT 1 FROM board_result_rows rr WHERE rr.import_id = i.id AND rr.student_id = br.student_id)) AS missing_from_file,
           ${minuteText('i.imported_at')} AS imported_at, u.full_name AS imported_by,
           ${minuteText('i.published_at')} AS published_on, i.unmatched_acknowledged
      FROM board_result_imports i
      LEFT JOIN users u ON u.id = i.imported_by
     WHERE (?1 IS NULL OR i.academic_year_id = ?1)
     ORDER BY i.imported_at DESC`).bind(optQ(c, 'academic_year_id'))
    .all<{ id: string; board: string; exam_name: string; stage: string | null; file_name: string | null; rows: number; matched: number
      unmatched: number; missing_from_file: number; imported_at: string; imported_by: string | null; published_on: string | null
      unmatched_acknowledged: number }>()
  return ok(items(rows.results.map((v) => {
    const o: Record<string, unknown> = { id: v.id, board: v.board, exam_name: v.exam_name }
    withOptional(o, { stage: v.stage, file_name: v.file_name })
    o.rows = Number(v.rows); o.matched = Number(v.matched); o.unmatched = Number(v.unmatched)
    o.missing_from_file = Number(v.missing_from_file); o.imported_at = v.imported_at
    withOptional(o, { imported_by: v.imported_by, published_on: v.published_on })
    o.unmatched_acknowledged = bool(v.unmatched_acknowledged)
    return o
  })))
}

/* The two-way report for a stored import; the most recent one when none is named. */
const getBoardReconciliation: Handler = async (c) => {
  const out: Record<string, unknown> = {
    dry_run: false, rows: 0, matched: 0, basis: BASIS, in_file_not_in_school: [] as unknown[], in_school_not_in_file: [] as unknown[],
    matches: [] as unknown[], published: false,
  }
  const imp = await c.db.prepare(`
    SELECT i.id, i.academic_year_id, i.stage, i.row_count, i.matched_count, ${minuteText('i.published_at')} AS published_on
      FROM board_result_imports i WHERE (?1 IS NULL OR i.id = ?1) ORDER BY i.imported_at DESC LIMIT 1`)
    .bind(optQ(c, 'import_id'))
    .first<{ id: string; academic_year_id: string; stage: string | null; row_count: number; matched_count: number; published_on: string | null }>()
  if (!imp) return ok(out) // No file imported yet: the empty report lets the screen open its upload panel.
  out.import_id = imp.id
  out.rows = Number(imp.row_count); out.matched = Number(imp.matched_count)
  out.published = imp.published_on !== null
  if (imp.published_on !== null) out.published_on = imp.published_on

  const [rows, missing] = await c.db.batch([
    c.db.prepare(`
      SELECT rr.id, rr.line_no, COALESCE(rr.hall_ticket_no,'') AS hall_ticket_no, COALESCE(rr.registration_no,'') AS registration_no,
             COALESCE(rr.candidate_name,'') AS candidate_name, COALESCE(rr.student_id,'') AS student_id,
             COALESCE(${NAME},'') AS school_record_name, COALESCE(st.admission_no,'') AS admission_no,
             rr.match_method, COALESCE(rr.result,'') AS result, rr.total_marks, rr.max_marks, rr.subjects
        FROM board_result_rows rr LEFT JOIN students st ON st.id = rr.student_id
       WHERE rr.import_id = ? ORDER BY rr.line_no`).bind(imp.id),
    c.db.prepare(`
      SELECT br.id AS registration_id, br.student_id, st.admission_no, COALESCE(br.candidate_name, ${SHORT_NAME}) AS candidate_name,
             COALESCE(c.name,'') AS class_name, br.hall_ticket_no, br.registration_no, br.status
        FROM board_registrations br JOIN students st ON st.id = br.student_id LEFT JOIN classes c ON c.id = br.class_id
       WHERE br.academic_year_id = ?1 AND (?2 IS NULL OR br.stage = ?2) AND br.status IN ${SENT}
         AND NOT EXISTS (SELECT 1 FROM board_result_rows rr WHERE rr.import_id = ?3 AND rr.student_id = br.student_id)
       ORDER BY st.admission_no`).bind(imp.academic_year_id, imp.stage, imp.id),
  ])
  const inFile: unknown[] = [], matches: unknown[] = []
  for (const r of rows.results as { id: string; line_no: number; hall_ticket_no: string; registration_no: string; candidate_name: string
      student_id: string; school_record_name: string; admission_no: string; match_method: string; result: string
      total_marks: string | number | null; max_marks: string | number | null; subjects: string }[]) {
    const total = r.total_marks === null ? null : Number(r.total_marks)
    const max = r.max_marks === null ? null : Number(r.max_marks)
    const l: ResultLine = {
      id: r.id, line_no: Number(r.line_no), hall_ticket_no: r.hall_ticket_no, registration_no: r.registration_no,
      candidate_name: r.candidate_name, student_id: r.student_id, school_record_name: r.school_record_name,
      admission_no: r.admission_no, match_method: r.match_method, result: r.result, total_marks: total, max_marks: max,
      percent: percentOf(total, max), subjects: r.subjects, registration_id: null, raw: {},
    }
    ;(l.student_id ? matches : inFile).push(lineJSON(l))
  }
  out.in_file_not_in_school = inFile
  out.matches = matches
  out.in_school_not_in_file = (missing.results as Parameters<typeof missingJSON>[0][]).map(missingJSON)
  return ok(out)
}

/* Attaches a line the import could not place to a child, by hand. */
const matchBoardResultRow: Handler = async (c) => {
  const rowID = uuidParam(c.params.id)
  const req = await readJSON<{ student_id?: string }>(c.req)
  if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
  const studentID = req.student_id
  try {
    const [upd] = await c.db.batch([
      c.db.prepare(`
        UPDATE board_result_rows
           SET student_id = ?2, match_method = 'manual', matched_at = ?3, matched_by = ?4,
               registration_id = (
                   SELECT br.id FROM board_registrations br
                     JOIN board_result_imports i ON i.id = board_result_rows.import_id
                    WHERE br.student_id = ?2 AND br.academic_year_id = i.academic_year_id
                    ORDER BY br.created_at DESC LIMIT 1)
         WHERE id = ?1`).bind(rowID, studentID, now(), c.id.userId),
      // The counts on the header are what the list screen reads, so they are recomputed here.
      c.db.prepare(`
        UPDATE board_result_imports
           SET matched_count = (SELECT COUNT(*) FROM board_result_rows rr WHERE rr.import_id = board_result_imports.id AND rr.student_id IS NOT NULL)
         WHERE id = (SELECT import_id FROM board_result_rows WHERE id = ?)`).bind(rowID),
    ])
    if (upd.meta.changes === 0) throw new NoRows()
  } catch (e) {
    if (isNoRows(e)) throw notFound()
    if (isUniqueViolation(e)) throw coded(409, 'already_matched', 'another line of this file is already matched to that child')
    throw e
  }
  return ok({ id: rowID, match_method: 'manual' })
}

/* Releases a result to families; refused while anything is unreconciled unless acknowledged. */
const publishBoardResults: Handler = async (c) => {
  const importID = uuidParam(c.params.id)
  const req = await readJSON<{ acknowledge_unmatched?: boolean }>(c.req)
  const ack = !!req.acknowledge_unmatched
  const imp = await c.db.prepare(`SELECT academic_year_id, stage FROM board_result_imports WHERE id = ?`).bind(importID)
    .first<{ academic_year_id: string; stage: string | null }>()
  if (!imp) throw notFound()
  const counts = await c.db.prepare(`
    SELECT (SELECT COUNT(*) FROM board_result_rows WHERE import_id = ?1 AND student_id IS NULL) AS unmatched,
           (SELECT COUNT(*) FROM board_registrations br
             WHERE br.academic_year_id = ?2 AND (?3 IS NULL OR br.stage = ?3) AND br.status IN ${SENT}
               AND NOT EXISTS (SELECT 1 FROM board_result_rows rr WHERE rr.import_id = ?1 AND rr.student_id = br.student_id)) AS missing`)
    .bind(importID, imp.academic_year_id, imp.stage).first<{ unmatched: number; missing: number }>()
  const unmatched = Number(counts?.unmatched ?? 0), missing = Number(counts?.missing ?? 0)
  if ((unmatched > 0 || missing > 0) && !ack) {
    throw coded(409, 'unreconciled', `this file has ${unmatched} line(s) that match no candidate here and omits ${missing} candidate(s) ` +
      'the school entered. Match or explain each one, or publish again acknowledging them. A child missing from the file hears ' +
      'nothing on the day everybody else does.')
  }
  await c.db.prepare(`UPDATE board_result_imports SET published_at = ?2, published_by = ?3, unmatched_acknowledged = ?4 WHERE id = ?1`)
    .bind(importID, now(), c.id.userId, ack ? 1 : 0).run()
  return ok({ id: importID, published_on: todayIST(), unmatched, missing_from_file: missing, acknowledged: ack })
}

// ============================================================ analysis

/** marks_obtained + grace_marks, as numbers (the columns are numeric TEXT). */
const MARK = `(CAST(m.marks_obtained AS REAL) + CAST(m.grace_marks AS REAL))`
const MAXM = `CAST(es.max_marks AS REAL)`
const PASSM = `CAST(es.pass_marks AS REAL)`

/** round(100 * sum(marks) / NULLIF(sum(max),0), 1), or null. */
function pct(sum: unknown, max: unknown): number | null {
  const s = Number(sum), m = Number(max)
  if (sum === null || max === null || !m) return null
  return round1((100 * s) / m)
}
const deltaPoints = (from: number | null, to: number | null): number | null => (from === null || to === null ? null : round1(to - from))

interface CohortPoint { exam_id: string; exam_name: string; on?: string; students: number; average_percent?: number }
const pointJSON = (p: { exam_id: string; exam_name: string; on: string | null; students: number; pct: number | null }): CohortPoint => {
  const o: CohortPoint = { exam_id: p.exam_id, exam_name: p.exam_name, students: p.students }
  if (p.on !== null) o.on = p.on
  if (p.pct !== null) o.average_percent = p.pct
  return o
}
interface Movement { name: string; baseline_percent?: number; latest_percent?: number; delta_points?: number; admission_no?: string; student_id?: string }
function movementJSON(name: string, base: number | null, latest: number | null, extra?: { admission_no: string; student_id: string }): Movement {
  const o: Movement = { name }
  if (base !== null) o.baseline_percent = base
  if (latest !== null) o.latest_percent = latest
  const d = deltaPoints(base, latest)
  if (d !== null) o.delta_points = d
  if (extra) { o.admission_no = extra.admission_no; o.student_id = extra.student_id }
  return o
}

/* Compares a cohort against its own earliest assessment of the year, in percentage points. */
const getBaselineAnalysis: Handler = async (c) => {
  const classID = (c.url.searchParams.get('class_id') ?? '').trim()
  const rows = await c.db.prepare(`
    SELECT c.id AS class_id, c.name AS class_name, c.level, ex.id AS exam_id, ex.name AS exam_name,
           COALESCE(ex.starts_on, SUBSTR(ex.created_at,1,10)) AS on_date,
           COUNT(DISTINCT m.student_id) AS students, SUM(${MARK}) AS got, SUM(${MAXM}) AS max
      FROM marks m
      JOIN exam_subjects es ON es.id = m.exam_subject_id
      JOIN exams ex ON ex.id = es.exam_id
      JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN classes c ON c.id = cs.class_id
     WHERE m.is_absent = 0 AND m.marks_obtained IS NOT NULL
       AND (?1 IS NULL OR ex.academic_year_id = ?1)
       AND (?2 IS NULL OR c.id = ?2)
     GROUP BY c.id, c.name, c.level, ex.id, ex.name, ex.starts_on, ex.created_at
     ORDER BY c.level, c.name, COALESCE(ex.starts_on, SUBSTR(ex.created_at,1,10)), ex.name`)
    .bind(optQ(c, 'academic_year_id'), opt(classID))
    .all<{ class_id: string; class_name: string; level: number; exam_id: string; exam_name: string; on_date: string | null
      students: number; got: number | null; max: number | null }>()

  type Cohort = { class_id: string; class_name: string; level: number; baseline?: CohortPoint; latest?: CohortPoint
    delta_points?: number; trend: CohortPoint[]; note?: string; _pcts: (number | null)[] }
  const cohorts: Cohort[] = []
  const byClass = new Map<string, Cohort>()
  for (const r of rows.results) {
    let co = byClass.get(r.class_id)
    if (!co) {
      co = { class_id: r.class_id, class_name: r.class_name, level: Number(r.level), trend: [], _pcts: [] }
      cohorts.push(co); byClass.set(r.class_id, co)
    }
    const p = pct(r.got, r.max)
    co.trend.push(pointJSON({ exam_id: r.exam_id, exam_name: r.exam_name, on: r.on_date, students: Number(r.students), pct: p }))
    co._pcts.push(p)
  }
  for (const co of cohorts) {
    const t = co.trend
    if (t.length === 1) {
      co.baseline = t[0]
      co.note = 'only one assessment so far this year - growth needs a second to measure against'
    } else if (t.length > 1) {
      co.baseline = t[0]; co.latest = t[t.length - 1]
      const first = co._pcts[0], last = co._pcts[co._pcts.length - 1]
      if (first !== null && last !== null) co.delta_points = round1(last - first)
    }
  }
  const cohortsOut = cohorts.map(({ _pcts, ...rest }) => rest)
  const basis = 'Baseline is the earliest exam this cohort has marks for in the year; the comparison is its most recent. Movement is in percentage points.'

  // Per-subject and per-child movement only for one cohort at a time.
  if (classID === '' || cohorts.length !== 1 || !cohorts[0].latest) {
    return ok({ basis, cohorts: cohortsOut, subjects: [], students: [] })
  }
  const base = cohorts[0].baseline!.exam_id, latest = cohorts[0].latest.exam_id
  const split = `SUM(CASE WHEN es.exam_id = ?1 THEN ${MARK} END) AS b_got, SUM(CASE WHEN es.exam_id = ?1 THEN ${MAXM} END) AS b_max,
                 SUM(CASE WHEN es.exam_id = ?2 THEN ${MARK} END) AS l_got, SUM(CASE WHEN es.exam_id = ?2 THEN ${MAXM} END) AS l_max`
  const [srows, prows] = await c.db.batch([
    c.db.prepare(`
      SELECT sub.name, ${split}
        FROM marks m
        JOIN exam_subjects es ON es.id = m.exam_subject_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN subjects sub ON sub.id = cs.subject_id
       WHERE m.is_absent = 0 AND m.marks_obtained IS NOT NULL AND es.exam_id IN (?1, ?2) AND cs.class_id = ?3
       GROUP BY sub.name ORDER BY sub.name`).bind(base, latest, classID),
    c.db.prepare(`
      SELECT st.id AS student_id, st.admission_no, ${NAME} AS name, ${split}
        FROM marks m
        JOIN exam_subjects es ON es.id = m.exam_subject_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN students st ON st.id = m.student_id
       WHERE m.is_absent = 0 AND m.marks_obtained IS NOT NULL AND es.exam_id IN (?1, ?2) AND cs.class_id = ?3
       GROUP BY st.id, st.admission_no, st.first_name, st.middle_name, st.last_name
       ORDER BY 3`).bind(base, latest, classID),
  ])
  type Split = { b_got: number | null; b_max: number | null; l_got: number | null; l_max: number | null }
  const subjects = (srows.results as (Split & { name: string })[]).map((r) => movementJSON(r.name, pct(r.b_got, r.b_max), pct(r.l_got, r.l_max)))
  const students = (prows.results as (Split & { student_id: string; admission_no: string; name: string })[]).map((r) =>
    movementJSON(r.name, pct(r.b_got, r.b_max), pct(r.l_got, r.l_max), { admission_no: r.admission_no, student_id: r.student_id }))
  return ok({ basis, cohorts: cohortsOut, subjects, students })
}

/* The examination controller's one page: pass is at or above the pass mark in
   every paper sat; a backlog is one subject below it. */
const getBoardPerformance: Handler = async (c) => {
  const args = [optQ(c, 'exam_id'), optQ(c, 'class_id'), optQ(c, 'academic_year_id')]
  const filter = `m.is_absent = 0 AND m.marks_obtained IS NOT NULL
       AND (?1 IS NULL OR ex.id = ?1) AND (?2 IS NULL OR c.id = ?2) AND (?3 IS NULL OR ex.academic_year_id = ?3)`
  const [srows, prows, brows] = await c.db.batch([
    c.db.prepare(`
      SELECT sub.name AS subject, c.name AS class_name, ex.name AS exam_name, COUNT(*) AS entered,
             SUM(${MARK}) AS got, SUM(${MAXM}) AS max,
             SUM(CASE WHEN ${MARK} < ${PASSM} THEN 1 ELSE 0 END) AS below_pass,
             SUM(CASE WHEN ${MAXM} > 0 AND ${MARK} > ${MAXM} THEN 1 ELSE 0 END) AS over_max
        FROM marks m
        JOIN exam_subjects es ON es.id = m.exam_subject_id
        JOIN exams ex ON ex.id = es.exam_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN subjects sub ON sub.id = cs.subject_id
        JOIN classes c ON c.id = cs.class_id
       WHERE ${filter}
       GROUP BY sub.name, c.name, ex.name
       ORDER BY c.name, sub.name`).bind(...args),
    c.db.prepare(`
      SELECT st.id AS student_id, ${NAME} AS name, st.admission_no, COALESCE(c.name,'') AS class_name, COUNT(*) AS papers,
             SUM(CASE WHEN ${MARK} < ${PASSM} THEN 1 ELSE 0 END) AS backlogs,
             SUM(${MARK}) AS got, SUM(${MAXM}) AS max
        FROM marks m
        JOIN exam_subjects es ON es.id = m.exam_subject_id
        JOIN exams ex ON ex.id = es.exam_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN classes c ON c.id = cs.class_id
        JOIN students st ON st.id = m.student_id
       WHERE ${filter}
       GROUP BY st.id, st.admission_no, st.first_name, st.middle_name, st.last_name, c.name
       ORDER BY 6 DESC, (SUM(${MAXM}) IS NULL OR SUM(${MAXM}) = 0), SUM(${MARK}) / NULLIF(SUM(${MAXM}),0)`).bind(...args),
    c.db.prepare(`
      SELECT i.exam_name,
             (SELECT COUNT(*) FROM board_result_rows rr WHERE rr.import_id = i.id) AS total,
             (SELECT COUNT(*) FROM board_result_rows rr WHERE rr.import_id = i.id AND rr.result = 'pass') AS passed,
             ${dateOf('i.published_at')} AS published_on
        FROM board_result_imports i
       WHERE (?1 IS NULL OR i.academic_year_id = ?1)
       ORDER BY i.imported_at DESC LIMIT 1`).bind(args[2]),
  ])

  type SubjectRow = { subject: string; class_name: string; exam_name: string; entered: number; got: number | null; max: number | null; below_pass: number; over_max: number }
  const bySubject = (srows.results as SubjectRow[]).map((v) => {
    const entered = Number(v.entered), belowPass = Number(v.below_pass), overMax = Number(v.over_max)
    const o: Record<string, unknown> = { subject: v.subject, class_name: v.class_name, exam_name: v.exam_name, entered }
    const avg = pct(v.got, v.max)
    if (avg !== null) o.average_percent = avg
    o.below_pass = belowPass
    if (entered > 0) o.pass_rate = round1((100 * (entered - belowPass)) / entered)
    if (overMax > 0) o.marks_above_max = overMax
    return o
  })

  type StudentRow = { student_id: string; name: string; admission_no: string; class_name: string; papers: number; backlogs: number; got: number | null; max: number | null }
  type AtRisk = { student_id: string; name: string; admission_no: string; class_name: string; percent?: number; backlogs: number; papers: number }
  let candidates = 0, passed = 0, distinctions = 0, backlogs = 0, sum = 0, counted = 0
  const atRisk: AtRisk[] = []
  for (const v of prows.results as StudentRow[]) {
    const b = Number(v.backlogs), p = pct(v.got, v.max)
    candidates++
    backlogs += b
    if (b === 0) passed++
    if (p !== null) { sum += p; counted++; if (p >= 75) distinctions++ }
    // Fifty is what fits a remedial list; the counts above are over every child.
    if (b > 0 && atRisk.length < 50) {
      const o: AtRisk = { student_id: v.student_id, name: v.name, admission_no: v.admission_no, class_name: v.class_name, backlogs: b, papers: Number(v.papers) }
      if (p !== null) o.percent = p
      atRisk.push(o)
    }
  }
  const summary: Record<string, unknown> = {}
  const overMax = bySubject.reduce((n, v) => n + Number(v.marks_above_max ?? 0), 0)
  if (overMax > 0) summary.marks_above_max = overMax
  summary.candidates = candidates
  summary.passed = passed
  summary.backlogs = backlogs
  summary.distinctions = distinctions
  summary.at_risk = candidates - passed
  summary.papers = bySubject.length
  summary.pass_rate = candidates > 0 ? round1((100 * passed) / candidates) : null
  summary.average_percent = counted > 0 ? round1(sum / counted) : null

  // The board's own verdict, kept beside the internal figures rather than merged into them.
  const board: Record<string, unknown> = {}
  const b = brows.results[0] as { exam_name: string; total: number; passed: number; published_on: string | null } | undefined
  if (b) {
    const total = Number(b.total), boardPassed = Number(b.passed)
    board.exam_name = b.exam_name
    board.candidates = total
    board.passed = boardPassed
    board.published_on = b.published_on
    if (total > 0) board.pass_rate = round1((100 * boardPassed) / total)
  }

  // Worst first: most backlogs, then lowest mark.
  atRisk.sort((x, y) => (x.backlogs !== y.backlogs ? y.backlogs - x.backlogs : (x.percent ?? 101) - (y.percent ?? 101)))

  return ok({
    summary, by_subject: bySubject, at_risk: atRisk, board,
    definitions: { pass: 'at or above the pass mark in every paper sat', backlog: 'one subject below the pass mark' },
  })
}

// ============================================================ /me/calendar

interface CalendarRow {
  date: string; end_date: string | null; kind: string; title: string; detail: string | null; starts_at: string | null
  venue: string | null; ref_id: string | null
}

/* The month a member of staff is actually in: holidays for staff, exams, their
   duties, the homework they set (on its due date) and their own leave. */
const getStaffCalendar: Handler = async (c) => {
  const from = (c.url.searchParams.get('from') ?? '').trim(), to = (c.url.searchParams.get('to') ?? '').trim()
  if (from === '' || to === '') throw badRequest('from and to are required, as YYYY-MM-DD')
  if (to < from) throw badRequest('to is before from')
  const u = c.id.userId
  const results = await c.db.batch([
    // applies_to 'students' is excluded: a day the children are off but staff are in is not a day off.
    c.db.prepare(`
      SELECT ${dateOf('on_date')} AS date, ${dateOf('to_date')} AS end_date, kind, name AS title, description AS detail,
             NULL AS starts_at, NULL AS venue, id AS ref_id
        FROM holidays
       WHERE on_date <= ?2 AND COALESCE(to_date, on_date) >= ?1 AND applies_to IN ('all','staff')
       ORDER BY on_date`).bind(from, to),
    c.db.prepare(`
      SELECT ${dateOf('starts_on')} AS date, ${dateOf('ends_on')} AS end_date, 'exam' AS kind, name AS title, NULL AS detail,
             NULL AS starts_at, NULL AS venue, id AS ref_id
        FROM exams
       WHERE starts_on <= ?2 AND COALESCE(ends_on, starts_on) >= ?1
       ORDER BY starts_on`).bind(from, to),
    c.db.prepare(`
      SELECT ${dateOf('da.on_date')} AS date, NULL AS end_date, 'duty' AS kind, COALESCE(NULLIF(ds.name,''), ds.duty_kind) AS title,
             ds.duty_kind AS detail, SUBSTR(ds.starts_at,1,5) AS starts_at, ds.location AS venue, da.id AS ref_id
        FROM duty_assignments da JOIN duty_shifts ds ON ds.id = da.shift_id
       WHERE da.user_id = ?3 AND da.on_date BETWEEN ?1 AND ?2 AND da.status <> 'cancelled'
       ORDER BY da.on_date`).bind(from, to, u),
    c.db.prepare(`
      SELECT ${dateOf('h.due_on')} AS date, NULL AS end_date, 'homework' AS kind, COALESCE(NULLIF(h.title,''), 'Homework') AS title,
             c.name || ' · ' || sec.name AS detail, NULL AS starts_at, NULL AS venue, h.id AS ref_id
        FROM homework h JOIN sections sec ON sec.id = h.section_id JOIN classes c ON c.id = sec.class_id
       WHERE h.created_by = ?3 AND h.due_on IS NOT NULL AND h.due_on BETWEEN ?1 AND ?2
       ORDER BY h.due_on`).bind(from, to, u),
    // Pending leave is shown too, and labelled, so nobody plans around a day not yet granted.
    c.db.prepare(`
      SELECT ${dateOf('lr.from_date')} AS date, ${dateOf('lr.to_date')} AS end_date, 'leave' AS kind,
             CASE WHEN lr.status = 'approved' THEN 'Leave' ELSE 'Leave (' || lr.status || ')' END AS title,
             lt.name AS detail, NULL AS starts_at, NULL AS venue, lr.id AS ref_id
        FROM leave_requests lr LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id JOIN employees e ON e.id = lr.employee_id
       WHERE e.user_id = ?3 AND lr.status IN ('approved','pending') AND lr.from_date <= ?2 AND lr.to_date >= ?1
       ORDER BY lr.from_date`).bind(from, to, u),
  ])
  const entries: Record<string, unknown>[] = []
  for (const r of results) {
    for (const e of r.results as CalendarRow[]) {
      const o: Record<string, unknown> = { date: e.date }
      withOptional(o, { end_date: e.end_date })
      o.kind = e.kind; o.title = e.title
      withOptional(o, { detail: e.detail, starts_at: e.starts_at, venue: e.venue, ref_id: e.ref_id })
      entries.push(o)
    }
  }
  return ok({ items: entries })
}
