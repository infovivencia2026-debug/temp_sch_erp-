import type { Router, Ctx } from '../router'
import { badRequest, forbidden, notFound, ok, readJSON, uuidParam, isUUID, now, uuid } from '../http'
import { items, coded, todayIST, dateOf } from './exams/common'
import { institutionById, tenantDb } from '../tenant'

/* Port of internal/api/statutory.go: the board List of Candidates filing, SQAA
   compliance tracking, Child Info reconciliation, the working-days return and
   the platform-tier Child Info portal connector. Mounted at /statutory on the
   top-level v1 router, exactly as mountStatutory did.

   The Go file's own words hold here too: a return is a snapshot with a name
   against it. Every "file" verb freezes rows and stamps who and when.

   What changed in the move to D1:
   - Postgres expression/partial unique indexes (lower(board), COALESCE(...),
     WHERE status = 'draft') did not survive the schema conversion, so each
     upsert that leaned on one does a SELECT first and then INSERT or UPDATE.
   - The platform tables (sqaa_frameworks, sqaa_standards,
     child_info_portal_connectors, child_info_sync_runs) live in each school's
     database here rather than in one platform schema, so the vendor routes
     read the acting school's copy. See the report.
   - generate_series, LATERAL, FILTER and interval arithmetic are done in JS. */

// ---------------------------------------------------------------- helpers

const PERM_READ = 'admin.reports.read'
const PERM_EXAM_WRITE = 'academics.exams.write'
const PERM_STUDENT_WRITE = 'students.write'
const PERM_ACADEMICS_WRITE = 'academics.write'
const PERM_FILE_RETURN = 'institution.write'
const PERM_VENDOR = 'platform.tenants.write'

const boardStages = new Set(['ssc', 'inter_first_year', 'inter_second_year'])

/** requireInstitution in setup_profile.go, and the school id every INSERT fills. */
function institutionId(c: Ctx): string {
  if (!c.id.institution) {
    throw badRequest('this screen belongs to a school. Sign in against one, or pick a school first - ' +
      "a platform operator's account is not attached to any.")
  }
  return c.id.institution.id
}

/** platformOnly in platform_config.go. */
function platformOnly(c: Ctx): void {
  if (!c.id.platformAdmin) throw forbidden('only platform staff can read across schools')
}

/** nullUUIDArg(id.UserID): a platform operator has no row in the school's users table. */
const actorId = (c: Ctx): string | null => (c.id.platformAdmin ? null : c.id.userId)

const trim = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())
const nullStr = (s: string): string | null => (s === '' ? null : s)
const deref = (p: string | null | undefined): string => p ?? ''
const blank = (p: string | null | undefined): boolean => p === null || p === undefined || p.trim() === ''
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
/** omitempty on a pointer or an int pointer: null becomes absent. */
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v)
const isUniqueViolation = (e: unknown): boolean => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)
const truncate = (s: string, n: number): string => { s = s.trim(); return s.length <= n ? s : s.slice(0, n) }
const itoa = (n: number) => String(n)

/** to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z' on an ISO text column. */
const tsOf = (col: string) => `CASE WHEN ${col} IS NULL THEN NULL ELSE SUBSTR(${col},1,19)||'Z' END`

/** foldKey: case, spacing and punctuation are not differences a portal and a register should argue about. */
function foldKey(s: string): string {
  const kept = s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '')
  return kept.split(/\s+/).filter((w) => w !== '').join(' ')
}

/** writeCSV in statutory.go: BOM for Excel, RFC 4180 quoting the way encoding/csv does it. */
function csvResponse(filename: string, header: string[], rows: string[][]): Response {
  const cell = (s: string) => (s === '' ? '' : /[",\r\n]/.test(s) || s.startsWith(' ') ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [header.map(cell).join(',')]
  for (const r of rows) lines.push(r.map(cell).join(','))
  return new Response('﻿' + lines.join('\n') + '\n', {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` },
  })
}

interface YearRow { id: string; name: string; starts_on: string; ends_on: string }

/** resolveAcademicYear: the year the caller asked for, or the current one. */
async function resolveAcademicYear(db: D1Database, want: string | null | undefined): Promise<YearRow> {
  const trimmed = trim(want)
  let row: YearRow | null
  if (trimmed !== '') {
    if (!isUUID(trimmed)) throw badRequest('academic_year_id must be a uuid')
    row = await db.prepare(`SELECT id, name, starts_on, ends_on FROM academic_years WHERE id = ?`).bind(trimmed).first<YearRow>()
  } else {
    row = await db.prepare(`SELECT id, name, starts_on, ends_on FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<YearRow>()
  }
  if (!row) throw badRequest('no academic year exists yet, create one first')
  return { ...row, starts_on: row.starts_on.slice(0, 10), ends_on: row.ends_on.slice(0, 10) }
}


// ============================================================================
// 1. Board Exam LOC submission
// ============================================================================

interface LocSubmissionRow {
  id: string; academic_year_id: string; board: string; exam_name: string; stage?: string
  title: string; fee_per_candidate_paise: number; status: string; candidate_count: number
  blocker_count: number; warning_count: number; validated_at?: string; filed_at?: string
  filed_by?: string; board_ack_no?: string; notes?: string; created_at: string
}

interface LocSubmissionDb {
  id: string; academic_year_id: string; board: string; exam_name: string; stage: string | null
  title: string; fee_per_candidate_paise: number; status: string; candidate_count: number
  blocker_count: number; warning_count: number; validated_at: string | null; filed_at: string | null
  filed_by: string | null; board_ack_no: string | null; notes: string | null; created_at: string
}

const LOC_HEAD_SQL = `
  SELECT l.id, l.academic_year_id, l.board, l.exam_name, l.stage, l.title, l.fee_per_candidate_paise,
         l.status, l.candidate_count, l.blocker_count, l.warning_count,
         ${tsOf('l.validated_at')} AS validated_at, ${tsOf('l.filed_at')} AS filed_at,
         u.full_name AS filed_by, l.board_ack_no, l.notes, ${tsOf('l.created_at')} AS created_at
    FROM loc_submissions l
    LEFT JOIN users u ON u.id = l.filed_by`

function locHead(v: LocSubmissionDb): LocSubmissionRow {
  return {
    id: v.id, academic_year_id: v.academic_year_id, board: v.board, exam_name: v.exam_name, stage: opt(v.stage),
    title: v.title, fee_per_candidate_paise: Number(v.fee_per_candidate_paise), status: v.status,
    candidate_count: v.candidate_count, blocker_count: v.blocker_count, warning_count: v.warning_count,
    validated_at: opt(v.validated_at), filed_at: opt(v.filed_at), filed_by: opt(v.filed_by),
    board_ack_no: opt(v.board_ack_no), notes: opt(v.notes), created_at: v.created_at,
  }
}

/** locLoad: a submission header, or 404. */
async function locLoad(c: Ctx, subId: string): Promise<LocSubmissionRow> {
  const v = await c.db.prepare(LOC_HEAD_SQL + ` WHERE l.id = ?`).bind(subId).first<LocSubmissionDb>()
  if (!v) throw notFound()
  return locHead(v)
}

interface LocCandidateRow {
  id: string; registration_id?: string; student_id?: string; serial_no: number
  candidate_name?: string; father_name?: string; mother_name?: string; date_of_birth?: string; gender?: string
  class_label?: string; admission_no?: string; medium?: string; second_language?: string; group_code?: string
  candidate_type?: string; apaar_id?: string; registration_no?: string; hall_ticket_no?: string
  subjects: string[]; fee_paid_paise: number; has_photo: boolean; has_signature: boolean
}

interface LocIssueRow {
  registration_id?: string; student_id?: string; candidate_name?: string; admission_no?: string
  severity: string; code: string; field?: string; message: string
}

function parseSubjects(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : []
  } catch { return [] }
}

/** locBody: the candidates and issues of one submission. */
async function locBody(c: Ctx, subId: string): Promise<{ candidates: LocCandidateRow[]; issues: LocIssueRow[] }> {
  const [cands, issues] = await c.db.batch([
    c.db.prepare(`
      SELECT id, registration_id, student_id, serial_no, candidate_name, father_name, mother_name,
             ${dateOf('date_of_birth')} AS date_of_birth, gender, class_label, admission_no, medium, second_language,
             group_code, candidate_type, apaar_id, registration_no, hall_ticket_no, subjects, fee_paid_paise,
             has_photo, has_signature
        FROM loc_candidates WHERE submission_id = ? ORDER BY serial_no`).bind(subId),
    c.db.prepare(`
      SELECT registration_id, student_id, candidate_name, admission_no, severity, code, field, message
        FROM loc_validation_issues WHERE submission_id = ? ORDER BY severity, admission_no, code`).bind(subId),
  ])
  type C = { id: string; registration_id: string | null; student_id: string | null; serial_no: number; candidate_name: string | null
    father_name: string | null; mother_name: string | null; date_of_birth: string | null; gender: string | null; class_label: string | null
    admission_no: string | null; medium: string | null; second_language: string | null; group_code: string | null; candidate_type: string | null
    apaar_id: string | null; registration_no: string | null; hall_ticket_no: string | null; subjects: string; fee_paid_paise: number
    has_photo: number; has_signature: number }
  type I = { registration_id: string | null; student_id: string | null; candidate_name: string | null; admission_no: string | null
    severity: string; code: string; field: string | null; message: string }
  return {
    candidates: (cands.results as C[]).map((v) => ({
      id: v.id, registration_id: opt(v.registration_id), student_id: opt(v.student_id), serial_no: v.serial_no,
      candidate_name: opt(v.candidate_name), father_name: opt(v.father_name), mother_name: opt(v.mother_name),
      date_of_birth: opt(v.date_of_birth), gender: opt(v.gender), class_label: opt(v.class_label), admission_no: opt(v.admission_no),
      medium: opt(v.medium), second_language: opt(v.second_language), group_code: opt(v.group_code), candidate_type: opt(v.candidate_type),
      apaar_id: opt(v.apaar_id), registration_no: opt(v.registration_no), hall_ticket_no: opt(v.hall_ticket_no),
      subjects: parseSubjects(v.subjects), fee_paid_paise: Number(v.fee_paid_paise), has_photo: !!v.has_photo, has_signature: !!v.has_signature,
    })),
    issues: (issues.results as I[]).map((v) => ({
      registration_id: opt(v.registration_id), student_id: opt(v.student_id), candidate_name: opt(v.candidate_name),
      admission_no: opt(v.admission_no), severity: v.severity, code: v.code, field: opt(v.field), message: v.message,
    })),
  }
}

// locSource is one board_registrations row as the validator sees it.
interface LocSource {
  registration_id: string; student_id: string; admission_no: string; class_label: string | null; gender: string | null
  candidate_name: string | null; father_name: string | null; mother_name: string | null; date_of_birth: string | null
  medium: string | null; second_language: string | null; group_code: string | null; candidate_type: string | null
  apaar_id: string | null; registration_no: string | null; hall_ticket_no: string | null; subjects_raw: string
  fee_paid_paise: number; has_photo: number; has_signature: number; subjects: string[]
}

interface LocRule { groupCode: string; minCount: number; maxCount: number; allowed: Map<string, string>; mandatory: string[] }

/** loadLOCRules: the configured combinations for one board and stage, keyed on the folded group code. */
async function loadLOCRules(c: Ctx, board: string, stage: string | null): Promise<Map<string, LocRule>> {
  const groups = await c.db.prepare(`
    SELECT g.id, COALESCE(g.group_code,'') AS code, g.min_subjects, g.max_subjects
      FROM loc_subject_groups g
     WHERE lower(g.board) = lower(?1) AND (?2 IS NULL OR g.stage = ?2) AND g.is_active`).bind(board, stage)
    .all<{ id: string; code: string; min_subjects: number; max_subjects: number }>()
  const out = new Map<string, LocRule>()
  const byId = new Map<string, LocRule>()
  for (const g of groups.results) {
    const rule: LocRule = { groupCode: g.code === '' ? 'this stage' : g.code, minCount: g.min_subjects, maxCount: g.max_subjects, allowed: new Map(), mandatory: [] }
    out.set(foldKey(g.code), rule)
    byId.set(g.id, rule)
  }
  if (byId.size === 0) return out
  const options = await c.db.prepare(`
    SELECT o.group_id, o.subject_code, o.subject_name, o.is_mandatory
      FROM loc_subject_options o JOIN loc_subject_groups g ON g.id = o.group_id
     WHERE lower(g.board) = lower(?1) AND (?2 IS NULL OR g.stage = ?2) AND g.is_active
     ORDER BY o.sequence, o.subject_code`).bind(board, stage)
    .all<{ group_id: string; subject_code: string; subject_name: string; is_mandatory: number }>()
  for (const o of options.results) {
    const rule = byId.get(o.group_id)
    if (!rule) continue
    rule.allowed.set(foldKey(o.subject_code), o.subject_code)
    rule.allowed.set(foldKey(o.subject_name), o.subject_code)
    if (o.is_mandatory) rule.mandatory.push(o.subject_code)
  }
  return out
}

interface LocIssue { severity: string; code: string; field: string | null; message: string }
const locBlocker = (code: string, field: string, msg: string): LocIssue => ({ severity: 'blocker', code, field: nullStr(field), message: msg })
const locWarning = (code: string, field: string, msg: string): LocIssue => ({ severity: 'warning', code, field: nullStr(field), message: msg })

/** formatPaiseText: paise as rupees, integer arithmetic throughout. */
function formatPaiseText(paise: number): string {
  const neg = paise < 0
  if (neg) paise = -paise
  const whole = Math.trunc(paise / 100)
  const frac = paise % 100
  let out = 'Rs ' + whole
  if (frac !== 0) out += '.' + Math.trunc(frac / 10) + (frac % 10)
  return neg ? '-' + out : out
}

/** locCombinationProblems: the candidate's subjects against the board's combination for their group. */
function locCombinationProblems(src: LocSource, rules: Map<string, LocRule>): LocIssue[] {
  if (rules.size === 0) {
    return [locWarning('no_combination_rule', 'subjects',
      'no subject combination rule is configured for this board and stage, so the combination could not be checked')]
  }
  const group = deref(src.group_code).trim()
  const rule = rules.get(foldKey(group))
  if (!rule) {
    if (group === '') return [locBlocker('group_missing', 'group_code', "no subject group chosen, and this board's stage requires one")]
    return [locBlocker('group_unknown', 'group_code', 'subject group ' + group + ' is not one this board accepts at this stage')]
  }
  const out: LocIssue[] = []
  const seen = new Set<string>()
  for (const subj of src.subjects) {
    const key = foldKey(subj)
    if (key === '') continue
    const code = rule.allowed.get(key)
    if (code === undefined) {
      out.push(locBlocker('subject_not_in_group', 'subjects', subj + ' is not offered in ' + rule.groupCode + ' for this board'))
      continue
    }
    seen.add(code)
  }
  for (const code of rule.mandatory) {
    if (!seen.has(code)) out.push(locBlocker('subject_mandatory_missing', 'subjects', code + ' is compulsory in ' + rule.groupCode + ' and is not on this candidate'))
  }
  const n = seen.size
  if (n < rule.minCount || n > rule.maxCount) {
    out.push(locBlocker('subject_count', 'subjects',
      rule.groupCode + ' takes between ' + itoa(rule.minCount) + ' and ' + itoa(rule.maxCount) + ' subjects; this candidate has ' + itoa(n)))
  }
  return out
}

/** locProblems: every refusal reason against one candidate, in the order a clerk fixes them. */
function locProblems(src: LocSource, rules: Map<string, LocRule>, feePerCandidate: number): LocIssue[] {
  const out: LocIssue[] = []
  if (blank(src.candidate_name)) out.push(locBlocker('name_missing', 'candidate_name', 'no name recorded. The board matches on the name exactly as it is on record'))
  if (src.date_of_birth === null) out.push(locBlocker('dob_missing', 'date_of_birth', 'no date of birth. Every board rejects a candidate without one'))
  if (blank(src.father_name)) out.push(locBlocker('father_missing', 'father_name', "father's name missing. It is printed on the hall ticket and the certificate"))
  if (blank(src.mother_name)) out.push(locBlocker('mother_missing', 'mother_name', "mother's name missing. It is printed on the hall ticket and the certificate"))
  if (!src.has_photo) out.push(locBlocker('photo_missing', 'photo_file_id', 'no photograph attached, on the registration or on the student record'))
  if (!src.has_signature) out.push(locBlocker('signature_missing', 'signature_file_id', 'no signature attached. The board holds the LOC signature against the answer script'))
  if (src.subjects.length === 0) out.push(locBlocker('subjects_missing', 'subjects', 'no subjects chosen'))
  else out.push(...locCombinationProblems(src, rules))
  if (feePerCandidate > 0 && src.fee_paid_paise < feePerCandidate) {
    out.push(locBlocker('fee_unpaid', 'fee_paid_paise',
      'examination fee not paid in full: ' + formatPaiseText(src.fee_paid_paise) + ' of ' + formatPaiseText(feePerCandidate)))
  }
  if (blank(src.apaar_id)) out.push(locWarning('apaar_missing', 'apaar_id', 'no APAAR ID. Not refused today, but the boards are moving to it'))
  if (blank(src.gender)) out.push(locWarning('gender_missing', 'gender', 'gender not recorded on the student'))
  if (blank(src.medium)) out.push(locWarning('medium_missing', 'medium', 'medium of instruction not recorded'))
  return out
}

/**
 * rebuildLOC: the statements that re-read the board roll into a draft and
 * revalidate it. Destructive by design; the caller must have checked the
 * submission is still a draft. Returned as statements so the caller can put
 * them in the same batch as whatever opened the draft.
 */
async function rebuildLOCStmts(c: Ctx, subId: string, head: { board: string; exam_name: string; stage: string | null; academic_year_id: string; fee_per_candidate_paise: number }):
  Promise<{ stmts: D1PreparedStatement[]; blockers: number; warnings: number; count: number }> {
  const inst = institutionId(c)
  const rows = await c.db.prepare(`
    SELECT br.id AS registration_id, br.student_id, st.admission_no, c.name AS class_label, st.gender,
           br.candidate_name, br.father_name, br.mother_name, ${dateOf('br.date_of_birth')} AS date_of_birth,
           br.medium, br.second_language, br.group_code, br.candidate_type,
           br.apaar_id, br.registration_no, br.hall_ticket_no, br.subjects AS subjects_raw, br.fee_paid_paise,
           (COALESCE(br.photo_file_id, st.photo_file_id) IS NOT NULL) AS has_photo,
           (br.signature_file_id IS NOT NULL) AS has_signature
      FROM board_registrations br
      JOIN students st ON st.id = br.student_id
      LEFT JOIN classes c ON c.id = br.class_id
     WHERE br.academic_year_id = ?1 AND lower(br.board) = lower(?2) AND lower(br.exam_name) = lower(?3)
       AND (?4 IS NULL OR br.stage = ?4) AND br.status <> 'rejected'
     ORDER BY c.level IS NULL, c.level, st.last_name, st.first_name, st.admission_no`)
    .bind(head.academic_year_id, head.board, head.exam_name, head.stage).all<LocSource>()
  const sources = rows.results.map((v) => ({ ...v, subjects: parseSubjects(v.subjects_raw), fee_paid_paise: Number(v.fee_paid_paise) }))
  const rules = await loadLOCRules(c, head.board, head.stage)

  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`DELETE FROM loc_validation_issues WHERE submission_id = ?`).bind(subId),
    c.db.prepare(`DELETE FROM loc_candidates WHERE submission_id = ?`).bind(subId),
  ]
  let blockers = 0, warnings = 0
  const ts = now()
  sources.forEach((src, i) => {
    stmts.push(c.db.prepare(`
      INSERT INTO loc_candidates
          (id, institution_id, submission_id, registration_id, student_id, serial_no,
           candidate_name, father_name, mother_name, date_of_birth, gender,
           class_label, admission_no, medium, second_language, group_code,
           candidate_type, apaar_id, registration_no, hall_ticket_no,
           subjects, fee_paid_paise, has_photo, has_signature)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(uuid(), inst, subId, src.registration_id, src.student_id, i + 1,
        src.candidate_name, src.father_name, src.mother_name, src.date_of_birth, src.gender,
        src.class_label, src.admission_no, src.medium, src.second_language, src.group_code,
        src.candidate_type, src.apaar_id, src.registration_no, src.hall_ticket_no,
        JSON.stringify(src.subjects), src.fee_paid_paise, src.has_photo ? 1 : 0, src.has_signature ? 1 : 0))
    for (const issue of locProblems(src, rules, head.fee_per_candidate_paise)) {
      if (issue.severity === 'blocker') blockers++
      else warnings++
      stmts.push(c.db.prepare(`
        INSERT INTO loc_validation_issues
            (id, institution_id, submission_id, registration_id, student_id,
             candidate_name, admission_no, severity, code, field, message, detected_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(uuid(), inst, subId, src.registration_id, src.student_id,
          src.candidate_name, src.admission_no, issue.severity, issue.code, issue.field, issue.message, ts))
    }
  })
  stmts.push(c.db.prepare(`
    UPDATE loc_submissions SET candidate_count = ?2, blocker_count = ?3, warning_count = ?4, validated_at = ?5 WHERE id = ?1`)
    .bind(subId, sources.length, blockers, warnings, ts))
  return { stmts, blockers, warnings, count: sources.length }
}

interface LocHeadForRebuild { board: string; exam_name: string; stage: string | null; academic_year_id: string; fee_per_candidate_paise: number; status: string }

async function locHeadForRebuild(c: Ctx, subId: string): Promise<LocHeadForRebuild> {
  const head = await c.db.prepare(`SELECT board, exam_name, stage, academic_year_id, fee_per_candidate_paise, status FROM loc_submissions WHERE id = ?`)
    .bind(subId).first<LocHeadForRebuild>()
  if (!head) throw notFound()
  return { ...head, fee_per_candidate_paise: Number(head.fee_per_candidate_paise) }
}

const ERR_LOC_FROZEN = 'this List of Candidates has been filed. What was sent to the board cannot be rewritten; correct the roll and file a fresh list'
const ERR_LOC_BLOCKED = 'candidates in this list would be rejected by the board. Fix the blockers, or remove those candidates from the roll, then file'
const ERR_LOC_DRAFT_EXISTS = 'a draft List of Candidates already exists for this board, exam and stage - finish or cancel that one rather than starting a second, or half the roll gets filed twice'

const yesNo = (b: boolean) => (b ? 'Yes' : 'No')

function registerLOC(r: Router): void {
  r.get('/statutory/loc/submissions', PERM_READ, async (c) => {
    const rows = await c.db.prepare(LOC_HEAD_SQL + ` ORDER BY l.created_at DESC`).all<LocSubmissionDb>()
    return ok(items(rows.results.map(locHead)))
  })

  r.get('/statutory/loc/submissions/{id}', PERM_READ, async (c) => {
    const subId = uuidParam(c.params.id)
    const head = await locLoad(c, subId)
    const body = await locBody(c, subId)
    return ok({ submission: head, candidates: body.candidates, issues: body.issues, frozen: head.status !== 'draft' })
  })

  // exportLOCSubmission reads loc_candidates, never board_registrations: a
  // filed list must export identically in 2029 to how it did when sent.
  r.get('/statutory/loc/submissions/{id}/export', PERM_READ, async (c) => {
    const subId = uuidParam(c.params.id)
    const head = await locLoad(c, subId)
    const { candidates } = await locBody(c, subId)
    const out = candidates.map((v) => [
      itoa(v.serial_no), deref(v.admission_no), deref(v.candidate_name), deref(v.father_name), deref(v.mother_name),
      deref(v.date_of_birth), deref(v.gender), deref(v.class_label), deref(v.group_code), deref(v.medium), deref(v.second_language),
      v.subjects.join('|'), deref(v.candidate_type), deref(v.apaar_id), deref(v.registration_no), deref(v.hall_ticket_no),
      formatPaiseText(v.fee_paid_paise), yesNo(v.has_photo), yesNo(v.has_signature),
    ])
    return csvResponse('loc-' + head.board + '-' + head.exam_name + '.csv', [
      'S.No', 'Admission No', 'Candidate Name', "Father's Name", "Mother's Name", 'Date of Birth', 'Gender', 'Class', 'Group',
      'Medium', 'Second Language', 'Subjects', 'Candidate Type', 'APAAR ID', 'Registration No', 'Hall Ticket No', 'Fee Paid', 'Photo', 'Signature',
    ], out)
  })

  // createLOCSubmission opens a draft and populates it from the board roll.
  r.post('/statutory/loc/submissions', PERM_EXAM_WRITE, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ academic_year_id?: string; board?: string; exam_name?: string; stage?: string; title?: string; fee_per_candidate_paise?: number; notes?: string }>(c.req)
    const board = trim(req.board), examName = trim(req.exam_name), stage = trim(req.stage)
    let title = trim(req.title)
    const fee = Math.trunc(Number(req.fee_per_candidate_paise ?? 0) || 0)
    if (board === '' || examName === '') throw badRequest('board and exam_name are required')
    if (fee < 0) throw badRequest('fee_per_candidate_paise cannot be negative')
    if (stage !== '' && !boardStages.has(stage)) throw badRequest('stage must be ssc, inter_first_year or inter_second_year')

    const year = await resolveAcademicYear(c.db, req.academic_year_id)
    if (title === '') title = examName + ' ' + year.name
    // loc_submissions_one_draft: one draft per (year, board, exam, stage).
    const dup = await c.db.prepare(`
      SELECT 1 AS x FROM loc_submissions
       WHERE academic_year_id = ? AND lower(board) = lower(?) AND lower(exam_name) = lower(?) AND COALESCE(stage,'') = ? AND status = 'draft'`)
      .bind(year.id, board, examName, stage).first()
    if (dup) throw coded(409, 'draft_exists', ERR_LOC_DRAFT_EXISTS)

    const subId = uuid()
    const insert = c.db.prepare(`
      INSERT INTO loc_submissions (id, institution_id, academic_year_id, board, exam_name, stage, title, fee_per_candidate_paise, notes, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(subId, inst, year.id, board, examName, nullStr(stage), title, fee, nullStr(trim(req.notes)), actorId(c), now())
    const rebuilt = await rebuildLOCStmts(c, subId, { board, exam_name: examName, stage: nullStr(stage), academic_year_id: year.id, fee_per_candidate_paise: fee })
    try {
      await c.db.batch([insert, ...rebuilt.stmts])
    } catch (e) {
      if (isUniqueViolation(e)) throw coded(409, 'draft_exists', ERR_LOC_DRAFT_EXISTS)
      throw badRequest(e instanceof Error ? e.message : String(e))
    }
    return ok({ id: subId })
  })

  // validateLOCSubmission re-reads the board roll and recomputes the report. Only a draft.
  r.post('/statutory/loc/submissions/{id}/validate', PERM_EXAM_WRITE, async (c) => {
    institutionId(c)
    const subId = uuidParam(c.params.id)
    const head = await locHeadForRebuild(c, subId)
    if (head.status !== 'draft') throw coded(409, 'already_filed', ERR_LOC_FROZEN)
    const rebuilt = await rebuildLOCStmts(c, subId, head)
    await c.db.batch(rebuilt.stmts)
    const fresh = await locLoad(c, subId)
    const body = await locBody(c, subId)
    return ok({ submission: fresh, candidates: body.candidates, issues: body.issues, frozen: false })
  })

  // fileLOCSubmission freezes the snapshot. Revalidates first, deliberately.
  r.post('/statutory/loc/submissions/{id}/file', PERM_EXAM_WRITE, async (c) => {
    institutionId(c)
    const subId = uuidParam(c.params.id)
    const req = await readJSON<{ board_ack_no?: string; notes?: string; force?: boolean }>(c.req)
    const head = await locHeadForRebuild(c, subId)
    if (head.status !== 'draft') throw coded(409, 'already_filed', ERR_LOC_FROZEN)
    const rebuilt = await rebuildLOCStmts(c, subId, head)
    // The Go handler ran the rebuild inside the same transaction and rolled it
    // back on refusal; D1 cannot, so the refusals are checked before writing.
    if (rebuilt.blockers > 0 && !req.force) {
      await c.db.batch(rebuilt.stmts)
      throw coded(409, 'blockers_outstanding', ERR_LOC_BLOCKED)
    }
    if (rebuilt.count === 0) {
      await c.db.batch(rebuilt.stmts)
      throw badRequest('no candidates on this list, nothing to file')
    }
    await c.db.batch([
      ...rebuilt.stmts,
      c.db.prepare(`
        UPDATE loc_submissions
           SET status = 'filed', filed_at = ?2, filed_by = ?3,
               board_ack_no = COALESCE(NULLIF(?4,''), board_ack_no),
               notes = COALESCE(NULLIF(?5,''), notes)
         WHERE id = ?1`).bind(subId, now(), actorId(c), trim(req.board_ack_no), trim(req.notes)),
    ])
    return ok(await locLoad(c, subId))
  })

  // --- the board's accepted subject combinations ---------------------------

  r.get('/statutory/loc/subject-rules', PERM_READ, async (c) => {
    type G = { id: string; board: string; stage: string; group_code: string | null; name: string; min_subjects: number; max_subjects: number; is_active: number }
    type O = { group_id: string; subject_code: string; subject_name: string; is_mandatory: number; sequence: number }
    const [groups, options] = await c.db.batch([
      c.db.prepare(`SELECT id, board, stage, group_code, name, min_subjects, max_subjects, is_active
                      FROM loc_subject_groups ORDER BY board, stage, COALESCE(group_code,'')`),
      c.db.prepare(`SELECT group_id, subject_code, subject_name, is_mandatory, sequence FROM loc_subject_options ORDER BY sequence, subject_code`),
    ])
    const out = (groups.results as G[]).map((g) => ({
      id: g.id, board: g.board, stage: g.stage, group_code: opt(g.group_code), name: g.name,
      min_subjects: g.min_subjects, max_subjects: g.max_subjects, is_active: !!g.is_active,
      options: [] as { subject_code: string; subject_name: string; is_mandatory: boolean; sequence: number }[],
    }))
    const byId = new Map(out.map((g) => [g.id, g]))
    for (const o of options.results as O[]) {
      byId.get(o.group_id)?.options.push({ subject_code: o.subject_code, subject_name: o.subject_name, is_mandatory: !!o.is_mandatory, sequence: o.sequence })
    }
    return ok(items(out))
  })

  // saveLOCSubjectRule writes one combination and replaces its option list.
  r.post('/statutory/loc/subject-rules', PERM_EXAM_WRITE, async (c) => {
    const inst = institutionId(c)
    interface Opt { subject_code?: string; subject_name?: string; is_mandatory?: boolean; sequence?: number }
    const req = await readJSON<{ id?: string; board?: string; stage?: string; group_code?: string; name?: string; min_subjects?: number; max_subjects?: number; is_active?: boolean | null; options?: Opt[] }>(c.req)
    const board = trim(req.board), stage = trim(req.stage), groupCode = trim(req.group_code)
    let name = trim(req.name)
    if (board === '' || stage === '') throw badRequest('board and stage are required')
    if (!boardStages.has(stage)) throw badRequest('stage must be ssc, inter_first_year or inter_second_year')
    if (name === '') name = groupCode !== '' ? groupCode : stage
    let minS = Math.trunc(Number(req.min_subjects ?? 0) || 0)
    let maxS = Math.trunc(Number(req.max_subjects ?? 0) || 0)
    if (minS <= 0) minS = 1
    if (maxS < minS) maxS = minS
    const active = req.is_active === null || req.is_active === undefined ? true : !!req.is_active

    // loc_subject_groups_one_per_combination: (institution, lower(board), stage, COALESCE(group_code,'')).
    const existing = await c.db.prepare(`SELECT id FROM loc_subject_groups WHERE lower(board) = lower(?) AND stage = ? AND COALESCE(group_code,'') = ?`)
      .bind(board, stage, groupCode).first<{ id: string }>()
    const gid = existing?.id ?? uuid()
    const stmts: D1PreparedStatement[] = [
      existing
        ? c.db.prepare(`UPDATE loc_subject_groups SET name = ?, min_subjects = ?, max_subjects = ?, is_active = ? WHERE id = ?`)
          .bind(name, minS, maxS, active ? 1 : 0, gid)
        : c.db.prepare(`INSERT INTO loc_subject_groups (id, institution_id, board, stage, group_code, name, min_subjects, max_subjects, is_active, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(gid, inst, board, stage, nullStr(groupCode), name, minS, maxS, active ? 1 : 0, now()),
      c.db.prepare(`DELETE FROM loc_subject_options WHERE group_id = ?`).bind(gid),
    ]
    // loc_subject_options_one_per_code: (group_id, upper(subject_code)); the last spelling wins.
    const byCode = new Map<string, { code: string; name: string; mandatory: boolean; seq: number }>()
    ;(req.options ?? []).forEach((o, i) => {
      let code = trim(o.subject_code), oname = trim(o.subject_name)
      if (code === '' && oname === '') return
      if (code === '') code = oname
      if (oname === '') oname = code
      let seq = Math.trunc(Number(o.sequence ?? 0) || 0)
      if (seq === 0) seq = i + 1
      const key = code.toUpperCase()
      const prev = byCode.get(key)
      byCode.set(key, { code: prev?.code ?? code, name: oname, mandatory: !!o.is_mandatory, seq })
    })
    for (const o of byCode.values()) {
      stmts.push(c.db.prepare(`INSERT INTO loc_subject_options (id, institution_id, group_id, subject_code, subject_name, is_mandatory, sequence) VALUES (?,?,?,?,?,?,?)`)
        .bind(uuid(), inst, gid, o.code, o.name, o.mandatory ? 1 : 0, o.seq))
    }
    try { await c.db.batch(stmts) } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return ok({ id: gid })
  })

  r.del('/statutory/loc/subject-rules/{id}', PERM_EXAM_WRITE, async (c) => {
    const gid = uuidParam(c.params.id)
    // ON DELETE CASCADE is declared on loc_subject_options; D1 enforces it.
    const res = await c.db.prepare(`DELETE FROM loc_subject_groups WHERE id = ?`).bind(gid).run()
    if (!res.meta.changes) throw notFound()
    return ok({ deleted: true })
  })
}

// ============================================================================
// 2. SQAA compliance tracking
// ============================================================================

interface SqaaAssessmentDb {
  id: string; academic_year_id: string | null; framework_code: string; framework_name: string | null; framework_version: string | null
  title: string; status: string; started_on: string | null; due_on: string | null; score_bp: number | null; max_score_bp: number | null
  submitted_at: string | null; submitted_by: string | null; notes: string | null; rated: number; total: number; gaps: number; open_actions: number
}

const SQAA_ASSESSMENT_SQL = `
  SELECT a.id, a.academic_year_id, a.framework_code, a.framework_name, a.framework_version, a.title, a.status,
         ${dateOf('a.started_on')} AS started_on, ${dateOf('a.due_on')} AS due_on, a.score_bp, a.max_score_bp,
         ${tsOf('a.submitted_at')} AS submitted_at, u.full_name AS submitted_by, a.notes,
         (SELECT count(*) FROM sqaa_assessment_entries e WHERE e.assessment_id = a.id AND e.rating <> 'not_assessed') AS rated,
         (SELECT count(*) FROM sqaa_assessment_entries e WHERE e.assessment_id = a.id) AS total,
         (SELECT count(*) FROM sqaa_assessment_entries e WHERE e.assessment_id = a.id AND e.rating IN ('not_met','partially_met')) AS gaps,
         (SELECT count(*) FROM sqaa_action_items i WHERE i.assessment_id = a.id AND i.status IN ('open','in_progress')) AS open_actions
    FROM sqaa_assessments a
    LEFT JOIN users u ON u.id = a.submitted_by`

function sqaaAssessmentRow(v: SqaaAssessmentDb) {
  return {
    id: v.id, academic_year_id: opt(v.academic_year_id), framework_code: v.framework_code, framework_name: opt(v.framework_name),
    framework_version: opt(v.framework_version), title: v.title, status: v.status, started_on: opt(v.started_on), due_on: opt(v.due_on),
    score_bp: opt(v.score_bp), max_score_bp: opt(v.max_score_bp), submitted_at: opt(v.submitted_at), submitted_by: opt(v.submitted_by),
    notes: opt(v.notes), rated_count: v.rated, standard_count: v.total, gap_count: v.gaps, open_action_count: v.open_actions,
  }
}

const ERR_SQAA_CLOSED = 'this assessment has been submitted. Reopening it would rewrite a record somebody signed; start a fresh cycle instead'

// sqaaRatingScore: the fraction of a standard's weight a rating earns, in bp.
const sqaaRatingScore: Record<string, number> = { not_met: 0, partially_met: 5000, met: 8000, exceeds: 10000 }

/** sqaaRescore: the weighted score, as the statement that stores it. Integer arithmetic as in Go. */
async function sqaaRescoreStmt(c: Ctx, aid: string): Promise<D1PreparedStatement> {
  const rows = await c.db.prepare(`
    SELECT COALESCE(e.domain_code, e.standard_code, '') AS key, e.weight_bp, e.score_bp, (e.domain_code IS NULL) AS is_domain
      FROM sqaa_assessment_entries e WHERE e.assessment_id = ?`).bind(aid)
    .all<{ key: string; weight_bp: number; score_bp: number | null; is_domain: number }>()
  const domains = new Map<string, { weight: number; sum: number; count: number }>()
  for (const r of rows.results) {
    let a = domains.get(r.key)
    if (!a) { a = { weight: 0, sum: 0, count: 0 }; domains.set(r.key, a) }
    if (r.is_domain && r.weight_bp > 0) a.weight = r.weight_bp
    if (r.score_bp !== null) { a.sum += r.score_bp; a.count++ }
  }
  let totalWeight = 0, weighted = 0
  for (const a of domains.values()) {
    if (a.count === 0 || a.weight === 0) continue
    totalWeight += a.weight
    weighted += Math.trunc(a.sum / a.count) * a.weight
  }
  const score = totalWeight > 0 ? Math.trunc(weighted / totalWeight) : null
  return c.db.prepare(`UPDATE sqaa_assessments SET score_bp = ?2, updated_at = ?3 WHERE id = ?1`).bind(aid, score, now())
}

interface SqaaActionDb {
  id: string; assessment_id: string; entry_id: string | null; standard_code: string | null; title: string; detail: string | null
  owner_employee_id: string | null; owner_name: string | null; due_on: string | null; priority: string; status: string
  progress_note: string | null; closed_at: string | null; overdue: number; assessment_title: string
}

async function sqaaActions(c: Ctx, aid: string | null) {
  const rows = await c.db.prepare(`
    SELECT i.id, i.assessment_id, i.entry_id, i.standard_code, i.title, i.detail, i.owner_employee_id,
           COALESCE(i.owner_name, e.first_name || ' ' || COALESCE(e.last_name,'')) AS owner_name,
           ${dateOf('i.due_on')} AS due_on, i.priority, i.status, i.progress_note, ${tsOf('i.closed_at')} AS closed_at,
           (i.due_on IS NOT NULL AND ${dateOf('i.due_on')} < ?2 AND i.status IN ('open','in_progress')) AS overdue,
           a.title AS assessment_title
      FROM sqaa_action_items i
      JOIN sqaa_assessments a ON a.id = i.assessment_id
      LEFT JOIN employees e ON e.id = i.owner_employee_id
     WHERE (?1 IS NULL OR i.assessment_id = ?1)
     ORDER BY i.status, i.due_on IS NULL, i.due_on, i.created_at DESC`).bind(aid, todayIST()).all<SqaaActionDb>()
  return rows.results.map((v) => ({
    id: v.id, assessment_id: v.assessment_id, entry_id: opt(v.entry_id), standard_code: opt(v.standard_code), title: v.title,
    detail: opt(v.detail), owner_employee_id: opt(v.owner_employee_id), owner_name: opt(v.owner_name), due_on: opt(v.due_on),
    priority: v.priority, status: v.status, progress_note: opt(v.progress_note), closed_at: opt(v.closed_at), overdue: !!v.overdue,
    assessment_title: v.assessment_title,
  }))
}

function registerSQAA(r: Router): void {
  // listSQAASchoolFrameworks: only published frameworks are offered.
  r.get('/statutory/sqaa/frameworks', PERM_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT f.code, f.name, f.authority, f.version, f.status, ${dateOf('f.effective_from')} AS effective_from,
             (SELECT count(*) FROM sqaa_standards t WHERE t.framework_code = f.code) AS standards,
             COALESCE((SELECT sum(t.weight_bp) FROM sqaa_standards t WHERE t.framework_code = f.code AND t.parent_id IS NULL), 0) AS weight_bp
        FROM sqaa_frameworks f
       WHERE f.status = 'published'
       ORDER BY f.effective_from IS NULL, f.effective_from DESC, f.code`)
      .all<{ code: string; name: string; authority: string; version: string; status: string; effective_from: string | null; standards: number; weight_bp: number }>()
    return ok(items(rows.results.map((v) => ({
      code: v.code, name: v.name, authority: v.authority, version: v.version, status: v.status,
      effective_from: opt(v.effective_from), standards: v.standards, weight_bp: Number(v.weight_bp),
    }))))
  })

  r.get('/statutory/sqaa/assessments', PERM_READ, async (c) => {
    const rows = await c.db.prepare(SQAA_ASSESSMENT_SQL + ` ORDER BY a.created_at DESC`).all<SqaaAssessmentDb>()
    return ok(items(rows.results.map(sqaaAssessmentRow)))
  })

  r.get('/statutory/sqaa/assessments/{id}', PERM_READ, async (c) => {
    const aid = uuidParam(c.params.id)
    const v = await c.db.prepare(SQAA_ASSESSMENT_SQL + ` WHERE a.id = ?`).bind(aid).first<SqaaAssessmentDb>()
    if (!v) throw notFound()
    type E = { id: string; standard_id: string; standard_code: string | null; standard_name: string | null; domain_code: string | null
      domain_name: string | null; rating: string; score_bp: number | null; weight_bp: number; evidence_required: number; remarks: string | null
      assessed_by: string | null; assessed_at: string | null }
    type Ev = { entry_id: string; id: string; file_id: string | null; file_name: string | null; external_url: string | null; caption: string
      added_by: string | null; added_at: string }
    const [entries, evidence] = await c.db.batch([
      c.db.prepare(`
        SELECT e.id, e.standard_id, e.standard_code, e.standard_name, e.domain_code, e.domain_name, e.rating, e.score_bp, e.weight_bp,
               e.evidence_required, e.remarks, u.full_name AS assessed_by, ${tsOf('e.assessed_at')} AS assessed_at
          FROM sqaa_assessment_entries e
          LEFT JOIN users u ON u.id = e.assessed_by
         WHERE e.assessment_id = ?
         ORDER BY COALESCE(e.domain_code,''), e.standard_code`).bind(aid),
      c.db.prepare(`
        SELECT ev.entry_id, ev.id, ev.file_id, f.original_name AS file_name, ev.external_url, ev.caption, u.full_name AS added_by,
               ${tsOf('ev.added_at')} AS added_at
          FROM sqaa_evidence ev
          JOIN sqaa_assessment_entries e ON e.id = ev.entry_id
          LEFT JOIN files f ON f.id = ev.file_id AND f.deleted_at IS NULL
          LEFT JOIN users u ON u.id = ev.added_by
         WHERE e.assessment_id = ?
         ORDER BY ev.added_at`).bind(aid),
    ])
    const out = (entries.results as E[]).map((e) => ({
      id: e.id, standard_id: e.standard_id, standard_code: opt(e.standard_code), standard_name: opt(e.standard_name),
      domain_code: opt(e.domain_code), domain_name: opt(e.domain_name), rating: e.rating, score_bp: opt(e.score_bp), weight_bp: e.weight_bp,
      evidence_required: !!e.evidence_required, remarks: opt(e.remarks), assessed_by: opt(e.assessed_by), assessed_at: opt(e.assessed_at),
      evidence: [] as { id: string; file_id?: string; file_name?: string; external_url?: string; caption: string; added_by?: string; added_at: string }[],
    }))
    const byId = new Map(out.map((e) => [e.id, e]))
    for (const ev of evidence.results as Ev[]) {
      byId.get(ev.entry_id)?.evidence.push({ id: ev.id, file_id: opt(ev.file_id), file_name: opt(ev.file_name), external_url: opt(ev.external_url),
        caption: ev.caption, added_by: opt(ev.added_by), added_at: ev.added_at })
    }
    return ok({ assessment: sqaaAssessmentRow(v), entries: out, actions: await sqaaActions(c, aid), frozen: v.status === 'submitted' || v.status === 'closed' })
  })

  // createSQAAAssessment opens a cycle and lays out every standard as an unrated entry.
  r.post('/statutory/sqaa/assessments', PERM_FILE_RETURN, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ framework_code?: string; academic_year_id?: string; title?: string; started_on?: string; due_on?: string; notes?: string }>(c.req)
    const code = trim(req.framework_code)
    let title = trim(req.title)
    if (code === '') throw badRequest('framework_code is required')

    const fw = await c.db.prepare(`SELECT name, version FROM sqaa_frameworks WHERE code = ? AND status = 'published'`).bind(code)
      .first<{ name: string; version: string }>()
    if (!fw) throw badRequest('no published framework with that code')
    const standards = await c.db.prepare(`
      SELECT t.id, t.code, t.name, p.code AS domain_code, p.name AS domain_name, t.weight_bp, t.evidence_required
        FROM sqaa_standards t
        LEFT JOIN sqaa_standards p ON p.id = t.parent_id
       WHERE t.framework_code = ?
       ORDER BY t.sequence, t.code`).bind(code)
      .all<{ id: string; code: string; name: string; domain_code: string | null; domain_name: string | null; weight_bp: number; evidence_required: number }>()
    if (standards.results.length === 0) throw badRequest('that framework has no standards yet, so there is nothing to assess against')

    const year = await resolveAcademicYear(c.db, req.academic_year_id)
    if (title === '') title = fw.name + ' ' + year.name
    const startedOn = trim(req.started_on), dueOn = trim(req.due_on)
    if (startedOn !== '' && !isDate(startedOn)) throw badRequest('started_on must be YYYY-MM-DD')
    if (dueOn !== '' && !isDate(dueOn)) throw badRequest('due_on must be YYYY-MM-DD')
    let maxBP = 0
    for (const st of standards.results) if (st.domain_code === null) maxBP += st.weight_bp

    // sqaa_assessments_one_per_cycle: (institution, framework, COALESCE(year,''), lower(title)).
    const dup = await c.db.prepare(`SELECT 1 AS x FROM sqaa_assessments WHERE framework_code = ? AND COALESCE(academic_year_id,'') = ? AND lower(title) = lower(?)`)
      .bind(code, year.id, title).first()
    if (dup) throw badRequest('an assessment with that title already exists for this framework and year')

    const aid = uuid()
    const ts = now()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`
        INSERT INTO sqaa_assessments (id, institution_id, academic_year_id, framework_code, framework_name, framework_version, title,
                                      started_on, due_on, max_score_bp, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(aid, inst, year.id, code, fw.name, fw.version, title, nullStr(startedOn), nullStr(dueOn), maxBP, nullStr(trim(req.notes)), actorId(c), ts, ts),
    ]
    for (const st of standards.results) {
      stmts.push(c.db.prepare(`
        INSERT OR IGNORE INTO sqaa_assessment_entries
            (id, institution_id, assessment_id, standard_id, standard_code, standard_name, domain_code, domain_name, weight_bp, evidence_required)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(uuid(), inst, aid, st.id, st.code, st.name, st.domain_code, st.domain_name, st.weight_bp, st.evidence_required ? 1 : 0))
    }
    try { await c.db.batch(stmts) } catch (e) {
      if (isUniqueViolation(e)) throw badRequest('an assessment with that title already exists for this framework and year')
      throw badRequest(e instanceof Error ? e.message : String(e))
    }
    return ok({ id: aid })
  })

  // saveSQAAEntry records one rating and re-scores the assessment.
  r.put('/statutory/sqaa/assessments/{id}/entries', PERM_FILE_RETURN, async (c) => {
    institutionId(c)
    const aid = uuidParam(c.params.id)
    const req = await readJSON<{ standard_id?: string; rating?: string; remarks?: string }>(c.req)
    const rating = trim(req.rating)
    const stdId = trim(req.standard_id)
    if (!isUUID(stdId)) throw badRequest('standard_id must be a uuid')
    if (!(rating in sqaaRatingScore) && rating !== 'not_applicable' && rating !== 'not_assessed') {
      throw badRequest('rating must be not_met, partially_met, met, exceeds, not_applicable or not_assessed')
    }
    const head = await c.db.prepare(`SELECT status FROM sqaa_assessments WHERE id = ?`).bind(aid).first<{ status: string }>()
    if (!head) throw notFound()
    if (head.status === 'submitted' || head.status === 'closed') throw coded(409, 'already_submitted', ERR_SQAA_CLOSED)
    const scoreBP = rating in sqaaRatingScore ? sqaaRatingScore[rating] : null
    const upd = await c.db.prepare(`
      UPDATE sqaa_assessment_entries SET rating = ?3, score_bp = ?4, remarks = ?5, assessed_by = ?6, assessed_at = ?7
       WHERE assessment_id = ?1 AND standard_id = ?2`)
      .bind(aid, stdId, rating, scoreBP, nullStr(trim(req.remarks)), actorId(c), now()).run()
    if (!upd.meta.changes) throw badRequest('that standard is not part of this assessment')
    await c.db.batch([
      // An assessment in progress the moment somebody rates something.
      c.db.prepare(`UPDATE sqaa_assessments SET status = 'in_progress', updated_at = ?2 WHERE id = ?1 AND status = 'draft'`).bind(aid, now()),
      await sqaaRescoreStmt(c, aid),
    ])
    return ok({ saved: true })
  })

  r.post('/statutory/sqaa/assessments/{id}/submit', PERM_FILE_RETURN, async (c) => {
    institutionId(c)
    const aid = uuidParam(c.params.id)
    const req = await readJSON<{ notes?: string; force?: boolean }>(c.req)
    const head = await c.db.prepare(`SELECT status FROM sqaa_assessments WHERE id = ?`).bind(aid).first<{ status: string }>()
    if (!head) throw notFound()
    if (head.status === 'submitted' || head.status === 'closed') throw coded(409, 'already_submitted', ERR_SQAA_CLOSED)
    const counts = await c.db.prepare(`
      SELECT SUM(CASE WHEN rating = 'not_assessed' THEN 1 ELSE 0 END) AS unrated,
             SUM(CASE WHEN evidence_required AND rating NOT IN ('not_assessed','not_applicable')
                       AND NOT EXISTS (SELECT 1 FROM sqaa_evidence v WHERE v.entry_id = e.id) THEN 1 ELSE 0 END) AS missing_evidence
        FROM sqaa_assessment_entries e WHERE e.assessment_id = ?`).bind(aid)
      .first<{ unrated: number | null; missing_evidence: number | null }>()
    const unrated = counts?.unrated ?? 0, missing = counts?.missing_evidence ?? 0
    if (!req.force && unrated > 0) throw badRequest(itoa(unrated) + ' standard(s) are still unrated. Rate them, or mark them not applicable')
    if (!req.force && missing > 0) throw badRequest(itoa(missing) + ' standard(s) require evidence and have none attached')
    await c.db.batch([
      await sqaaRescoreStmt(c, aid),
      c.db.prepare(`
        UPDATE sqaa_assessments SET status = 'submitted', submitted_at = ?4, submitted_by = ?2,
               notes = COALESCE(NULLIF(?3,''), notes), updated_at = ?4
         WHERE id = ?1`).bind(aid, actorId(c), trim(req.notes), now()),
    ])
    return ok({ submitted: true })
  })

  // addSQAAEvidence attaches a document to one rating: a file_id or an external_url.
  r.post('/statutory/sqaa/entries/{id}/evidence', PERM_FILE_RETURN, async (c) => {
    const inst = institutionId(c)
    const entryId = uuidParam(c.params.id)
    const req = await readJSON<{ file_id?: string; external_url?: string; caption?: string }>(c.req)
    const caption = trim(req.caption), externalURL = trim(req.external_url), fileRef = trim(req.file_id)
    if ((fileRef === '') === (externalURL === '')) throw badRequest('attach exactly one of file_id (upload it first) or external_url')
    if (caption === '') throw badRequest('caption is required. An unlabelled document proves nothing')
    if (fileRef !== '' && !isUUID(fileRef)) throw badRequest('file_id must be a uuid')

    const head = await c.db.prepare(`
      SELECT a.status FROM sqaa_assessments a JOIN sqaa_assessment_entries e ON e.assessment_id = a.id WHERE e.id = ?`).bind(entryId)
      .first<{ status: string }>()
    if (!head) throw notFound()
    if (head.status === 'submitted' || head.status === 'closed') throw coded(409, 'already_submitted', ERR_SQAA_CLOSED)
    // sqaa_evidence_one_per_document: (entry_id, COALESCE(file_id,''), COALESCE(lower(external_url),'')).
    const dup = await c.db.prepare(`SELECT 1 AS x FROM sqaa_evidence WHERE entry_id = ? AND COALESCE(file_id,'') = ? AND COALESCE(lower(external_url),'') = lower(?)`)
      .bind(entryId, fileRef, externalURL).first()
    if (dup) throw badRequest('that document is already attached to this standard')
    const evId = uuid()
    await c.db.prepare(`INSERT INTO sqaa_evidence (id, institution_id, entry_id, file_id, external_url, caption, added_by, added_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(evId, inst, entryId, nullStr(fileRef), nullStr(externalURL), caption, actorId(c), now()).run()
    return ok({ id: evId })
  })

  r.del('/statutory/sqaa/evidence/{id}', PERM_FILE_RETURN, async (c) => {
    const evId = uuidParam(c.params.id)
    // Evidence behind a submitted assessment is part of the record.
    const res = await c.db.prepare(`
      DELETE FROM sqaa_evidence WHERE id = ?
         AND entry_id IN (SELECT e.id FROM sqaa_assessment_entries e JOIN sqaa_assessments a ON a.id = e.assessment_id
                           WHERE a.status NOT IN ('submitted','closed'))`).bind(evId).run()
    if (!res.meta.changes) throw coded(409, 'not_removable', 'no such evidence, or the assessment it belongs to has already been submitted')
    return ok({ deleted: true })
  })

  // --- the action plan -----------------------------------------------------

  r.get('/statutory/sqaa/actions', PERM_READ, async (c) => {
    const v = trim(c.url.searchParams.get('assessment_id'))
    let filter: string | null = null
    if (v !== '') {
      if (!isUUID(v)) throw badRequest('assessment_id must be a uuid')
      filter = v
    }
    return ok(items(await sqaaActions(c, filter)))
  })

  // saveSQAAAction creates or updates one item. An item outlives its assessment's submission on purpose.
  r.post('/statutory/sqaa/actions', PERM_FILE_RETURN, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ id?: string; assessment_id?: string; entry_id?: string; title?: string; detail?: string; owner_employee_id?: string
      due_on?: string; priority?: string; status?: string; progress_note?: string }>(c.req)
    const title = trim(req.title)
    let priority = trim(req.priority), status = trim(req.status)
    if (priority === '') priority = 'normal'
    if (status === '') status = 'open'
    if (title === '') throw badRequest('title is required')
    const owner = trim(req.owner_employee_id)
    if (owner !== '' && !isUUID(owner)) throw badRequest('owner_employee_id must be a uuid')
    const entry = trim(req.entry_id)
    if (entry !== '' && !isUUID(entry)) throw badRequest('entry_id must be a uuid')
    const dueOn = trim(req.due_on)
    if (dueOn !== '' && !isDate(dueOn)) throw badRequest('due_on must be YYYY-MM-DD')
    // A done item is stamped here rather than trusted from the client.
    const closed = status === 'done' || status === 'dropped'
    const ts = now()

    const idv = trim(req.id)
    if (idv !== '') {
      if (!isUUID(idv)) throw badRequest('id must be a uuid')
      const res = await c.db.prepare(`
        UPDATE sqaa_action_items
           SET title = ?2, detail = ?3, owner_employee_id = ?4, due_on = NULLIF(?5,''), priority = ?6, status = ?7, progress_note = ?8,
               closed_at = CASE WHEN ?9 THEN COALESCE(closed_at, ?11) ELSE NULL END,
               closed_by = CASE WHEN ?9 THEN COALESCE(closed_by, ?10) ELSE NULL END
         WHERE id = ?1`)
        .bind(idv, title, nullStr(trim(req.detail)), nullStr(owner), dueOn, priority, status, nullStr(trim(req.progress_note)), closed ? 1 : 0, actorId(c), ts).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: idv })
    }
    const aid = trim(req.assessment_id)
    if (!isUUID(aid)) throw badRequest('assessment_id must be a uuid')
    const itemId = uuid()
    try {
      // The standard code is copied off the entry so the item still reads after the framework is revised.
      await c.db.prepare(`
        INSERT INTO sqaa_action_items
            (id, institution_id, assessment_id, entry_id, standard_code, title, detail, owner_employee_id, owner_name, due_on,
             priority, status, progress_note, closed_at, closed_by, created_by, created_at)
        SELECT ?1, ?2, ?3, ?4, (SELECT standard_code FROM sqaa_assessment_entries WHERE id = ?4), ?5, ?6, ?7,
               (SELECT first_name || ' ' || COALESCE(last_name,'') FROM employees WHERE id = ?7),
               NULLIF(?8,''), ?9, ?10, ?11, CASE WHEN ?12 THEN ?14 END, CASE WHEN ?12 THEN ?13 END, ?13, ?14`)
        .bind(itemId, inst, aid, nullStr(entry), title, nullStr(trim(req.detail)), nullStr(owner), dueOn, priority, status,
          nullStr(trim(req.progress_note)), closed ? 1 : 0, actorId(c), ts).run()
    } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return ok({ id: itemId })
  })
}

// ============================================================================
// 3. Child Info reconciliation
// ============================================================================

interface ChildInfoLine {
  lineNo: number; childInfoId: string; name: string; father: string; mother: string; dob: string; gender: string
  aadhaar: string; apaar: string; class: string; section: string; admissionNo: string; raw: Record<string, string>
}

/** childInfoColumn: a header cell to a field, on the folded header against known spellings. */
function childInfoColumn(header: string): string {
  switch (foldKey(header)) {
    case 'child info id': case 'childinfo id': case 'child id': case 'childinfoid': case 'student id': case 'child info number': case 'cid':
      return 'child_info_id'
    case 'student name': case 'name': case 'child name': case 'name of the student': case 'name of student':
      return 'student_name'
    case 'father name': case 'fathers name': case 'father s name': case 'name of father':
      return 'father_name'
    case 'mother name': case 'mothers name': case 'mother s name': case 'name of mother':
      return 'mother_name'
    case 'date of birth': case 'dob': case 'birth date': case 'birthdate':
      return 'date_of_birth'
    case 'gender': case 'sex':
      return 'gender'
    case 'aadhaar': case 'aadhaar no': case 'aadhar': case 'aadhaar last4': case 'aadhaar last 4':
      return 'aadhaar_last4'
    case 'apaar': case 'apaar id': case 'apaarid':
      return 'apaar_id'
    case 'class': case 'class name': case 'standard': case 'grade':
      return 'class_label'
    case 'section': case 'section name':
      return 'section_label'
    case 'admission no': case 'admission number': case 'adm no': case 'admissionno':
      return 'admission_no'
  }
  return ''
}

/**
 * csvRecords: encoding/csv with TrimLeadingSpace and FieldsPerRecord = -1.
 * Returns the records, or the 1-based line a record could not be read from.
 */
function csvRecords(text: string): { records: string[][]; badLine?: number; reason?: string } {
  const records: string[][] = []
  let i = 0
  const n = text.length
  let line = 1
  while (i < n) {
    const startLine = line
    const rec: string[] = []
    let field = ''
    let quoted = false
    let fieldStart = true
    let done = false
    while (i < n && !done) {
      const ch = text[i]
      if (fieldStart) {
        fieldStart = false
        if (ch === ' ' || ch === '\t') { i++; fieldStart = true; continue }
        if (ch === '"') { quoted = true; i++; continue }
      }
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue }
          quoted = false; i++
          // After the closing quote only a delimiter or a line end may follow.
          const nx = text[i]
          if (nx === undefined) { rec.push(field); done = true; break }
          if (nx === ',') { rec.push(field); field = ''; fieldStart = true; i++; continue }
          if (nx === '\n' || nx === '\r') { rec.push(field); field = ''; done = true; continue }
          return { records, badLine: line, reason: 'extraneous or missing " in quoted-field' }
        }
        if (ch === '\n') line++
        field += ch; i++; continue
      }
      if (ch === ',') { rec.push(field); field = ''; fieldStart = true; i++; continue }
      if (ch === '\r') { i++; continue }
      if (ch === '\n') { rec.push(field); field = ''; line++; done = true; i++; break }
      if (ch === '"') return { records, badLine: line, reason: 'bare " in non-quoted-field' }
      field += ch; i++
    }
    if (quoted) return { records, badLine: startLine, reason: 'extraneous or missing " in quoted-field' }
    if (!done) { rec.push(field) }
    else if (i >= n && field !== '') rec.push(field)
    // encoding/csv skips a wholly empty line.
    if (rec.length === 1 && rec[0] === '' && !done) break
    if (!(rec.length === 1 && rec[0] === '')) records.push(rec)
  }
  return { records }
}

/** childInfoDate accepts the shapes a state portal export arrives in; an unparseable value is kept as-is. */
function childInfoDate(s: string): string {
  s = s.trim()
  if (s === '') return ''
  const shapes: [RegExp, (m: RegExpMatchArray) => [string, string, string]][] = [
    [/^(\d{4})-(\d{2})-(\d{2})$/, (m) => [m[1], m[2], m[3]]],
    [/^(\d{2})\/(\d{2})\/(\d{4})$/, (m) => [m[3], m[2], m[1]]],
    [/^(\d{2})-(\d{2})-(\d{4})$/, (m) => [m[3], m[2], m[1]]],
    [/^(\d{4})\/(\d{2})\/(\d{2})$/, (m) => [m[1], m[2], m[3]]],
  ]
  for (const [re, pick] of shapes) {
    const m = s.match(re)
    if (!m) continue
    const [y, mo, d] = pick(m)
    const iso = `${y}-${mo}-${d}`
    const t = new Date(iso + 'T00:00:00Z')
    if (!Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso) return iso
  }
  return s
}

function childInfoGender(s: string): string {
  switch (foldKey(s)) {
    case 'm': case 'male': case 'boy': return 'male'
    case 'f': case 'female': case 'girl': return 'female'
    case '': return ''
  }
  return 'other'
}

/** aadhaarLastFour keeps only the trailing four digits; the schema never stores the whole number. */
function aadhaarLastFour(s: string): string {
  const digits = s.replace(/[^0-9]/g, '')
  return digits.length < 4 ? '' : digits.slice(-4)
}

/** parseChildInfoCSV reads the portal extract on the server. */
function parseChildInfoCSV(text: string): ChildInfoLine[] {
  const parsed = csvRecords(text.startsWith('﻿') ? text.slice(1) : text)
  if (parsed.records.length === 0) {
    if (parsed.badLine !== undefined) throw badRequest("could not read the file's header row")
    throw badRequest("could not read the file's header row")
  }
  const header = parsed.records[0]
  const canon = header.map(childInfoColumn)
  if (!canon.some((v) => v !== '')) {
    throw badRequest('none of the columns could be recognised. The extract needs at least a Child Info ID or an admission number, and a student name')
  }
  const out: ChildInfoLine[] = []
  let line = 1
  for (const rec of parsed.records.slice(1)) {
    line++
    const l: ChildInfoLine = { lineNo: line, childInfoId: '', name: '', father: '', mother: '', dob: '', gender: '', aadhaar: '', apaar: '', class: '', section: '', admissionNo: '', raw: {} }
    rec.forEach((cell, i) => {
      if (i >= header.length) return
      cell = cell.trim()
      l.raw[header[i].trim()] = cell
      switch (canon[i]) {
        case 'child_info_id': l.childInfoId = cell; break
        case 'student_name': l.name = cell; break
        case 'father_name': l.father = cell; break
        case 'mother_name': l.mother = cell; break
        case 'date_of_birth': l.dob = childInfoDate(cell); break
        case 'gender': l.gender = childInfoGender(cell); break
        case 'aadhaar_last4': l.aadhaar = aadhaarLastFour(cell); break
        case 'apaar_id': l.apaar = cell; break
        case 'class_label': l.class = cell; break
        case 'section_label': l.section = cell; break
        case 'admission_no': l.admissionNo = cell; break
      }
    })
    // A wholly blank line is the trailing newline every spreadsheet leaves.
    if (l.childInfoId === '' && l.name === '' && l.admissionNo === '') continue
    out.push(l)
  }
  if (parsed.badLine !== undefined) {
    throw badRequest('line ' + itoa(parsed.badLine) + ' could not be read: ' + (parsed.reason ?? 'parse error'))
  }
  if (out.length === 0) throw badRequest('the file has a header but no rows')
  return out
}

interface ChildInfoStudent {
  id: string; admission_no: string; child_info_id: string | null; name: string; father: string | null; mother: string | null
  dob: string | null; gender: string | null; aadhaar: string | null; apaar: string | null; class_label: string | null
}

/** loadChildInfoStudents reads the school's roll for the year. */
async function loadChildInfoStudents(db: D1Database, yearId: string): Promise<ChildInfoStudent[]> {
  const rows = await db.prepare(`
    SELECT st.id, st.admission_no, st.child_info_id,
           COALESCE(st.first_name,'') || ' ' || COALESCE(st.middle_name,'') || ' ' || COALESCE(st.last_name,'') AS name,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1) AS father,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1) AS mother,
           ${dateOf('st.date_of_birth')} AS dob, st.gender, st.aadhaar_last4 AS aadhaar, st.apaar_id AS apaar,
           (SELECT c.name FROM enrollments e JOIN classes c ON c.id = e.class_id
             WHERE e.student_id = st.id AND e.academic_year_id = ? AND e.status = 'active' LIMIT 1) AS class_label
      FROM students st
     WHERE st.status = 'active'`).bind(yearId).all<ChildInfoStudent>()
  // Collapsed, not just trimmed: a student with no middle name must not carry a double space into every comparison.
  return rows.results.map((v) => ({ ...v, name: v.name.trim().split(/\s+/).filter((w) => w !== '').join(' ') }))
}

interface ChildInfoDiff {
  kind: string; matchKey: string; field: string; portalValue: string; schoolValue: string
  lineNo: number | null; studentId: string | null; childInfoId: string; displayName: string; admissionNo: string
}

/** childInfoCompare: the three-way difference. Child Info id first, admission number second, name plus DOB third. */
function childInfoCompare(lines: ChildInfoLine[], students: ChildInfoStudent[]): ChildInfoDiff[] {
  const byChildId = new Map<string, number>(), byAdmission = new Map<string, number>(), byNameDOB = new Map<string, number>()
  students.forEach((st, i) => {
    if (!blank(st.child_info_id)) byChildId.set(foldKey(st.child_info_id!), i)
    byAdmission.set(foldKey(st.admission_no), i)
    byNameDOB.set(foldKey(st.name) + '|' + deref(st.dob), i)
  })
  const matched = new Array<boolean>(students.length).fill(false)
  const out: ChildInfoDiff[] = []
  for (const l of lines) {
    let idx = -1
    if (l.childInfoId !== '') idx = byChildId.get(foldKey(l.childInfoId)) ?? -1
    if (idx < 0 && l.admissionNo !== '') idx = byAdmission.get(foldKey(l.admissionNo)) ?? -1
    if (idx < 0 && l.name !== '' && l.dob !== '') idx = byNameDOB.get(foldKey(l.name) + '|' + l.dob) ?? -1
    const key = l.childInfoId !== '' ? l.childInfoId : 'line:' + itoa(l.lineNo)
    if (idx < 0) {
      out.push({ kind: 'portal_only', matchKey: key, field: '', portalValue: l.name, schoolValue: '', lineNo: l.lineNo, studentId: null,
        childInfoId: l.childInfoId, displayName: l.name, admissionNo: l.admissionNo })
      continue
    }
    matched[idx] = true
    const st = students[idx]
    // Once matched, the identity is the child's, not the line's.
    const mk = l.childInfoId !== '' ? l.childInfoId : 'student:' + st.id
    const fields: [string, string, string][] = [
      ['student_name', l.name, st.name], ['date_of_birth', l.dob, deref(st.dob)], ['gender', l.gender, deref(st.gender)],
      ['aadhaar_last4', l.aadhaar, deref(st.aadhaar)], ['apaar_id', l.apaar, deref(st.apaar)], ['class_label', l.class, deref(st.class_label)],
      ['father_name', l.father, deref(st.father)], ['mother_name', l.mother, deref(st.mother)],
    ]
    for (const [field, portal, school] of fields) {
      // A field the portal did not send is not a disagreement.
      if (portal.trim() === '' || foldKey(portal) === foldKey(school)) continue
      out.push({ kind: 'field_mismatch', matchKey: mk, field, portalValue: portal, schoolValue: school, lineNo: l.lineNo, studentId: st.id,
        childInfoId: l.childInfoId, displayName: st.name, admissionNo: st.admission_no })
    }
  }
  students.forEach((st, i) => {
    if (matched[i]) return
    out.push({ kind: 'school_only', matchKey: 'student:' + st.id, field: '', portalValue: '', schoolValue: st.name, lineNo: null, studentId: st.id,
      childInfoId: deref(st.child_info_id), displayName: st.name, admissionNo: st.admission_no })
  })
  return out
}

interface ChildInfoDiffDb {
  id: string; import_id: string; kind: string; match_key: string; field: string | null; portal_value: string | null; school_value: string | null
  student_id: string | null; child_info_id: string | null; display_name: string | null; admission_no: string | null; status: string
  action: string | null; note: string | null
}

function childInfoDiffRow(v: ChildInfoDiffDb) {
  return {
    id: v.id, import_id: v.import_id, kind: v.kind, match_key: v.match_key, field: opt(v.field), portal_value: opt(v.portal_value),
    school_value: opt(v.school_value), student_id: opt(v.student_id), child_info_id: opt(v.child_info_id), display_name: opt(v.display_name),
    admission_no: opt(v.admission_no), status: v.status, resolution_action: opt(v.action), resolution_note: opt(v.note),
  }
}

// childInfoWritable: the fields a resolution may write back onto a student. Deliberately short.
const childInfoWritable: Record<string, string> = { student_name: '', date_of_birth: 'date_of_birth', gender: 'gender', aadhaar_last4: 'aadhaar_last4', apaar_id: 'apaar_id' }

function registerChildInfo(r: Router): void {
  r.get('/statutory/child-info/imports', PERM_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT i.id, i.source_label, i.file_name, i.row_count, i.portal_only_count, i.school_only_count, i.mismatch_count, i.suppressed_count,
             (SELECT count(*) FROM child_info_differences d WHERE d.import_id = i.id AND d.status = 'open') AS open_count,
             u.full_name AS imported_by, ${tsOf('i.imported_at')} AS imported_at, i.note
        FROM child_info_imports i
        LEFT JOIN users u ON u.id = i.imported_by
       ORDER BY i.imported_at DESC`)
      .all<{ id: string; source_label: string | null; file_name: string | null; row_count: number; portal_only_count: number; school_only_count: number
        mismatch_count: number; suppressed_count: number; open_count: number; imported_by: string | null; imported_at: string; note: string | null }>()
    return ok(items(rows.results.map((v) => ({
      id: v.id, source_label: opt(v.source_label), file_name: opt(v.file_name), row_count: v.row_count, portal_only_count: v.portal_only_count,
      school_only_count: v.school_only_count, mismatch_count: v.mismatch_count, suppressed_count: v.suppressed_count, open_count: v.open_count,
      imported_by: opt(v.imported_by), imported_at: v.imported_at, note: opt(v.note),
    }))))
  })

  r.get('/statutory/child-info/differences', PERM_READ, async (c) => {
    const q = c.url.searchParams
    const importV = trim(q.get('import_id'))
    if (importV !== '' && !isUUID(importV)) throw badRequest('import_id must be a uuid')
    const kind = trim(q.get('kind'))
    let status = trim(q.get('status'))
    if (status === '') status = 'open'
    // Defaults to the newest import, so the screen has something on first load.
    const rows = await c.db.prepare(`
      SELECT d.id, d.import_id, d.kind, d.match_key, d.field, d.portal_value, d.school_value, d.student_id, d.child_info_id,
             d.display_name, d.admission_no, d.status, res.action, res.note
        FROM child_info_differences d
        LEFT JOIN child_info_resolutions res ON res.id = d.resolution_id
       WHERE d.import_id = COALESCE(?1, (SELECT id FROM child_info_imports ORDER BY imported_at DESC LIMIT 1))
         AND (?2 = '' OR d.kind = ?2)
         AND (?3 = 'all' OR d.status = ?3)
       ORDER BY d.kind, d.display_name, d.field`).bind(nullStr(importV), kind, status).all<ChildInfoDiffDb>()
    return ok(items(rows.results.map(childInfoDiffRow)))
  })

  r.get('/statutory/child-info/resolutions', PERM_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT res.id, res.kind, res.match_key, res.field, res.portal_value, res.school_value, res.action, res.note,
             u.full_name AS resolved_by, ${tsOf('res.resolved_at')} AS resolved_at
        FROM child_info_resolutions res
        LEFT JOIN users u ON u.id = res.resolved_by
       ORDER BY res.resolved_at DESC`)
      .all<{ id: string; kind: string; match_key: string; field: string | null; portal_value: string | null; school_value: string | null
        action: string; note: string | null; resolved_by: string | null; resolved_at: string }>()
    return ok(items(rows.results.map((v) => ({
      id: v.id, kind: v.kind, match_key: v.match_key, field: opt(v.field), portal_value: opt(v.portal_value), school_value: opt(v.school_value),
      action: v.action, note: opt(v.note), resolved_by: opt(v.resolved_by), resolved_at: v.resolved_at,
    }))))
  })

  /* importChildInfoExtract loads the portal file and produces the three-way
     diff. The Go handler ran it in one transaction and rolled back on dry_run;
     here the diff is computed first and written only when it is not a dry run,
     so the preview is the same computation that would be stored. */
  r.post('/statutory/child-info/import', PERM_STUDENT_WRITE, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ academic_year_id?: string; source_label?: string; file_name?: string; note?: string; csv?: string; dry_run?: boolean }>(c.req)
    const csvText = req.csv ?? ''
    if (csvText.trim() === '') throw badRequest("paste or upload the portal's extract")
    const lines = parseChildInfoCSV(csvText)
    const dryRun = !!req.dry_run

    const year = await resolveAcademicYear(c.db, req.academic_year_id)
    const students = await loadChildInfoStudents(c.db, year.id)
    const diffs = childInfoCompare(lines, students)

    // Every settled difference, keyed on identity *and* values: "portal says
    // RAMESH, we say Ramesh" does not cover a later "portal says RAJESH".
    const settled = await c.db.prepare(`SELECT id, kind, match_key, COALESCE(field,'') AS field, COALESCE(portal_value,'') AS portal_value,
                                               COALESCE(school_value,'') AS school_value, action, note FROM child_info_resolutions`)
      .all<{ id: string; kind: string; match_key: string; field: string; portal_value: string; school_value: string; action: string; note: string | null }>()
    const resolutions = new Map<string, { id: string; action: string; note: string | null }>()
    for (const s of settled.results) resolutions.set([s.kind, s.match_key, s.field, s.portal_value, s.school_value].join('\u0000'), { id: s.id, action: s.action, note: s.note })

    const importId = uuid()
    const ts = now()
    const out = { import_id: dryRun ? undefined : importId, dry_run: dryRun, rows: lines.length, portal_only_count: 0, school_only_count: 0,
      mismatch_count: 0, suppressed_count: 0, open_count: 0, sample: [] as ReturnType<typeof childInfoDiffRow>[] }

    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO child_info_imports (id, institution_id, academic_year_id, source_label, file_name, row_count, imported_by, note, imported_at)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(importId, inst, year.id, nullStr(trim(req.source_label)), nullStr(trim(req.file_name)), lines.length, actorId(c), nullStr(trim(req.note)), ts),
    ]
    // The rows as given, so a disputed difference traces to its line.
    const lineId = new Map<number, string>()
    for (const l of lines) {
      const rowId = uuid()
      lineId.set(l.lineNo, rowId)
      stmts.push(c.db.prepare(`
        INSERT INTO child_info_rows (id, institution_id, import_id, line_no, child_info_id, student_name, father_name, mother_name, date_of_birth,
                                     gender, aadhaar_last4, apaar_id, class_label, section_label, admission_no, raw)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(rowId, inst, importId, l.lineNo, nullStr(l.childInfoId), nullStr(l.name), nullStr(l.father), nullStr(l.mother), nullStr(l.dob),
          nullStr(l.gender), nullStr(l.aadhaar), nullStr(l.apaar), nullStr(l.class), nullStr(l.section), nullStr(l.admissionNo), JSON.stringify(l.raw)))
    }

    // child_info_differences_one_per_identity: (import, kind, match_key, COALESCE(field,'')); a repeat updates the status of the first.
    const diffRows = new Map<string, { id: string; d: ChildInfoDiff; status: string; resId: string | null }>()
    for (const d of diffs) {
      const res = resolutions.get([d.kind, d.matchKey, d.field, d.portalValue, d.schoolValue].join('\u0000'))
      let status = 'open'
      if (res) { status = 'suppressed'; out.suppressed_count++ } else out.open_count++
      if (d.kind === 'portal_only') out.portal_only_count++
      else if (d.kind === 'school_only') out.school_only_count++
      else out.mismatch_count++
      const key = [d.kind, d.matchKey, d.field].join('\u0000')
      const prev = diffRows.get(key)
      let diffId: string
      if (prev) { prev.status = status; diffId = prev.id } else { diffId = uuid(); diffRows.set(key, { id: diffId, d, status, resId: res?.id ?? null }) }
      if (status === 'open' && out.sample.length < 25) {
        out.sample.push({
          id: diffId, import_id: importId, kind: d.kind, match_key: d.matchKey, field: opt(nullStr(d.field)), portal_value: opt(nullStr(d.portalValue)),
          school_value: opt(nullStr(d.schoolValue)), student_id: undefined, child_info_id: opt(nullStr(d.childInfoId)), display_name: opt(nullStr(d.displayName)),
          admission_no: opt(nullStr(d.admissionNo)), status, resolution_action: opt(res?.action ?? null), resolution_note: opt(res?.note ?? null),
        })
      }
    }
    for (const { id, d, status, resId } of diffRows.values()) {
      const rowId = d.lineNo === null ? null : lineId.get(d.lineNo) ?? null
      stmts.push(c.db.prepare(`
        INSERT INTO child_info_differences (id, institution_id, import_id, kind, match_key, field, portal_value, school_value, row_id, student_id,
                                            child_info_id, display_name, admission_no, status, resolution_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, inst, importId, d.kind, d.matchKey, nullStr(d.field), nullStr(d.portalValue), nullStr(d.schoolValue), rowId, d.studentId,
          nullStr(d.childInfoId), nullStr(d.displayName), nullStr(d.admissionNo), status, resId, ts))
    }
    stmts.push(c.db.prepare(`
      UPDATE child_info_imports SET portal_only_count = ?2, school_only_count = ?3, mismatch_count = ?4, suppressed_count = ?5 WHERE id = ?1`)
      .bind(importId, out.portal_only_count, out.school_only_count, out.mismatch_count, out.suppressed_count))

    if (!dryRun) {
      try { await c.db.batch(stmts) } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    }
    return ok(out)
  })

  // resolveChildInfoDifference records the decision, durably, as an upsert on the difference's identity.
  r.post('/statutory/child-info/differences/{id}/resolve', PERM_STUDENT_WRITE, async (c) => {
    const inst = institutionId(c)
    const diffId = uuidParam(c.params.id)
    const req = await readJSON<{ action?: string; note?: string; apply_locally?: boolean }>(c.req)
    const action = trim(req.action)
    if (action !== 'fix_local' && action !== 'mark_for_portal' && action !== 'accept') throw badRequest('action must be fix_local, mark_for_portal or accept')

    const d = await c.db.prepare(`SELECT kind, match_key, field, portal_value, school_value, student_id FROM child_info_differences WHERE id = ?`).bind(diffId)
      .first<{ kind: string; match_key: string; field: string | null; portal_value: string | null; school_value: string | null; student_id: string | null }>()
    if (!d) throw notFound()

    // child_info_resolutions_one_per_difference: (institution, kind, match_key, COALESCE(field,'')).
    const existing = await c.db.prepare(`SELECT id FROM child_info_resolutions WHERE kind = ? AND match_key = ? AND COALESCE(field,'') = ?`)
      .bind(d.kind, d.match_key, deref(d.field)).first<{ id: string }>()
    const resId = existing?.id ?? uuid()
    const ts = now()
    const stmts: D1PreparedStatement[] = [
      existing
        ? c.db.prepare(`UPDATE child_info_resolutions SET portal_value = ?, school_value = ?, action = ?, note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`)
          .bind(d.portal_value, d.school_value, action, nullStr(trim(req.note)), actorId(c), ts, resId)
        : c.db.prepare(`INSERT INTO child_info_resolutions (id, institution_id, kind, match_key, field, portal_value, school_value, action, note, resolved_by, resolved_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(resId, inst, d.kind, d.match_key, d.field, d.portal_value, d.school_value, action, nullStr(trim(req.note)), actorId(c), ts),
    ]
    let applied = false
    if (req.apply_locally && action === 'fix_local' && d.student_id !== null && d.field !== null && d.portal_value !== null) {
      const col = childInfoWritable[d.field]
      if (col === undefined || col === '') {
        throw badRequest('this field cannot be corrected from here. Change it on the student record, where the rest of what depends on it moves with it')
      }
      // The column name comes from the allow-list above, never from the request.
      // students_touch (BEFORE UPDATE) set updated_at; the Go statement set it too.
      stmts.push(c.db.prepare(`UPDATE students SET ${col} = ?2, updated_at = ?3 WHERE id = ?1`).bind(d.student_id, d.portal_value, ts))
      applied = true
    }
    stmts.push(c.db.prepare(`UPDATE child_info_differences SET status = 'resolved', resolution_id = ?2 WHERE id = ?1`).bind(diffId, resId))
    try { await c.db.batch(stmts) } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return ok({ resolved: true, applied_locally: applied })
  })

  // forgetChildInfoResolution un-settles a difference so the next run raises it.
  r.del('/statutory/child-info/resolutions/{id}', PERM_STUDENT_WRITE, async (c) => {
    const resId = uuidParam(c.params.id)
    const [, del] = await c.db.batch([
      c.db.prepare(`UPDATE child_info_differences SET status = 'open', resolution_id = NULL WHERE resolution_id = ?`).bind(resId),
      c.db.prepare(`DELETE FROM child_info_resolutions WHERE id = ?`).bind(resId),
    ])
    if (!del.meta.changes) throw notFound()
    return ok({ deleted: true })
  })
}

// ============================================================================
// 4. Working days and instructional hours
// ============================================================================

interface WorkingDaysClassRow {
  class_id?: string; class_label: string; class_level?: number; stage_code?: string; stage_label?: string
  working_days: number; instructional_minutes: number; required_days: number; required_minutes: number
  shortfall_days: number; shortfall_minutes: number; has_timetable: boolean
}

interface WorkingDaysResult {
  academic_year_id: string; academic_year: string; period_from: string; period_to: string; to_date: boolean
  calendar_days: number; working_days: number; declared_working_days?: number; required_working_days: number
  adjustment_days: number; adjustment_minutes: number; classes_short: number; classes: WorkingDaysClassRow[]; notes: string[]
}

interface WdNorm { stage_code: string; label: string; min_level: number; max_level: number; min_days: number; min_hours: number }

// rteDefaults is the RTE Act schedule, used when a school has no norms yet.
const rteDefaults: WdNorm[] = [
  { stage_code: 'primary', label: 'Primary (I-V)', min_level: 1, max_level: 5, min_days: 200, min_hours: 800 },
  { stage_code: 'upper_primary', label: 'Upper primary (VI-VIII)', min_level: 6, max_level: 8, min_days: 220, min_hours: 1000 },
  { stage_code: 'secondary', label: 'Secondary (IX-X)', min_level: 9, max_level: 10, min_days: 220, min_hours: 1100 },
  { stage_code: 'higher_secondary', label: 'Higher secondary (XI-XII)', min_level: 11, max_level: 12, min_days: 220, min_hours: 1100 },
]

/** ensureInstructionalNorms seeds the RTE defaults for a school that has none. */
async function ensureInstructionalNorms(c: Ctx): Promise<void> {
  const inst = institutionId(c)
  const n = await c.db.prepare(`SELECT count(*) AS n FROM instructional_norms`).first<{ n: number }>()
  if ((n?.n ?? 0) > 0) return
  await c.db.batch(rteDefaults.map((d) => {
    let authority = 'RTE Act 2009, Schedule', note = 'Statutory minimum.'
    if (d.min_level > 8) {
      authority = 'State norm'
      note = 'Not set by the RTE Act, which stops at class VIII. Check the figure your board inspects against.'
    }
    // instructional_norms_one_per_stage: (institution, lower(stage_code)).
    return c.db.prepare(`
      INSERT INTO instructional_norms (id, institution_id, stage_code, label, min_level, max_level, min_days, min_hours, authority, note, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM instructional_norms WHERE lower(stage_code) = lower(?))`)
      .bind(uuid(), inst, d.stage_code, d.label, d.min_level, d.max_level, d.min_days, String(d.min_hours), authority, note, now(), d.stage_code)
  }))
}

async function loadInstructionalNorms(c: Ctx): Promise<WdNorm[]> {
  const rows = await c.db.prepare(`SELECT stage_code, label, min_level, max_level, min_days, min_hours FROM instructional_norms ORDER BY min_level`)
    .all<{ stage_code: string; label: string; min_level: number; max_level: number; min_days: number; min_hours: string | number }>()
  return rows.results.map((v) => ({ ...v, min_hours: Number(v.min_hours) || 0 }))
}

function normFor(norms: WdNorm[], level: number | null): WdNorm | null {
  if (level === null) return null
  for (const n of norms) if (level >= n.min_level && level <= n.max_level) return n
  return null
}

const round2 = (f: number) => Math.trunc(f * 100 + 0.5) / 100
const dayMs = 86400 * 1000
/** extract(isodow): Monday = 1 .. Sunday = 7. */
const isodow = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1

/** computeWorkingDays is the whole calculation, in one place; generate_series is a JS loop here. */
async function computeWorkingDays(c: Ctx, yearId: string, from: string, to: string): Promise<WorkingDaysResult> {
  const out: WorkingDaysResult = {
    academic_year_id: yearId, academic_year: '', period_from: from, period_to: to, to_date: false, calendar_days: 0, working_days: 0,
    required_working_days: 0, adjustment_days: 0, adjustment_minutes: 0, classes_short: 0, classes: [], notes: [],
  }

  /* Which days the school was open, by weekday. Sunday is closed unless
     explicitly marked a working day, a holiday or vacation that applies to
     students closes the day, and kind='working_day' overrides both. */
  const holidays = await c.db.prepare(`
    SELECT kind, applies_to, ${dateOf('on_date')} AS on_date, ${dateOf('COALESCE(to_date, on_date)')} AS to_date
      FROM holidays WHERE ${dateOf('on_date')} <= ?2 AND ${dateOf('COALESCE(to_date, on_date)')} >= ?1`).bind(from, to)
    .all<{ kind: string; applies_to: string; on_date: string; to_date: string }>()
  const covers = (h: { on_date: string; to_date: string }, day: string) => day >= h.on_date && day <= h.to_date
  const openDays = new Map<number, number>()
  let baseDays = 0
  const start = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z')
  for (let t = start.getTime(); t <= end.getTime(); t += dayMs) {
    const d = new Date(t)
    const day = d.toISOString().slice(0, 10)
    const dow = isodow(d)
    const forced = holidays.results.some((h) => h.kind === 'working_day' && covers(h, day))
    const closed = holidays.results.some((h) => (h.kind === 'holiday' || h.kind === 'vacation') && (h.applies_to === 'all' || h.applies_to === 'students') && covers(h, day))
    if (forced || (dow !== 7 && !closed)) {
      openDays.set(dow, (openDays.get(dow) ?? 0) + 1)
      baseDays++
    }
  }
  out.calendar_days = Math.trunc((end.getTime() - start.getTime()) / dayMs) + 1

  /* Minutes of instruction per class per weekday, averaged across the sections of a class; breaks excluded. */
  const minRows = await c.db.prepare(`
    SELECT c.id, c.name, c.level, sm.weekday, AVG(sm.mins) AS mins
      FROM (
          SELECT sec.class_id, te.section_id, te.weekday,
                 SUM((strftime('%s', '2000-01-01 ' || p.ends_at) - strftime('%s', '2000-01-01 ' || p.starts_at)) / 60.0) AS mins
            FROM timetable_entries te
            JOIN sections sec ON sec.id = te.section_id
            JOIN periods p ON p.id = te.period_id
           WHERE te.academic_year_id = ? AND p.is_break = 0
           GROUP BY sec.class_id, te.section_id, te.weekday
      ) sm
      JOIN classes c ON c.id = sm.class_id
     GROUP BY c.id, c.name, c.level, sm.weekday`).bind(yearId)
    .all<{ id: string; name: string; level: number | null; weekday: number; mins: number | null }>()
  interface ClassAcc { name: string; level: number | null; weekday: Map<number, number>; hasTable: boolean }
  const classes = new Map<string, ClassAcc>()
  for (const r of minRows.results) {
    let acc = classes.get(r.id)
    if (!acc) { acc = { name: r.name, level: r.level, weekday: new Map(), hasTable: false }; classes.set(r.id, acc) }
    acc.weekday.set(r.weekday, Number(r.mins ?? 0))
    acc.hasTable = true
  }

  // Every class, including those with no timetable.
  const allRows = await c.db.prepare(`SELECT id, name, level FROM classes ORDER BY level, name`).all<{ id: string; name: string; level: number | null }>()
  const order: string[] = []
  for (const r of allRows.results) {
    if (!classes.has(r.id)) classes.set(r.id, { name: r.name, level: r.level, weekday: new Map(), hasTable: false })
    order.push(r.id)
  }

  // Adjustments. A NULL class_id applies to every class.
  const adjRows = await c.db.prepare(`
    SELECT class_id, SUM(CAST(days_delta AS REAL)) AS days, SUM(minutes_delta) AS mins
      FROM working_days_adjustments
     WHERE academic_year_id = ?1 AND ${dateOf('on_date')} BETWEEN ?2 AND ?3
     GROUP BY class_id`).bind(yearId, from, to).all<{ class_id: string | null; days: number | null; mins: number | null }>()
  const classAdjDays = new Map<string, number>(), classAdjMin = new Map<string, number>()
  let allDays = 0, allMin = 0
  for (const a of adjRows.results) {
    const days = Number(a.days ?? 0), mins = Math.trunc(Number(a.mins ?? 0))
    if (a.class_id === null) { allDays += days; allMin += mins; continue }
    classAdjDays.set(a.class_id, days)
    classAdjMin.set(a.class_id, mins)
  }
  out.adjustment_days = allDays
  out.adjustment_minutes = allMin
  out.working_days = baseDays + allDays

  const norms = await loadInstructionalNorms(c)

  // The whole-school minimum, as a fallback for a class whose level falls outside every band.
  let fallbackDays = 220
  const model = await c.db.prepare(`SELECT required_working_days FROM academic_calendar_models LIMIT 1`).first<{ required_working_days: number }>()
  if (model) fallbackDays = model.required_working_days
  const declared = await c.db.prepare(`SELECT working_days FROM academic_years WHERE id = ?`).bind(yearId).first<{ working_days: number | null }>()
  if (declared && declared.working_days !== null) out.declared_working_days = declared.working_days
  out.required_working_days = fallbackDays

  let noTimetable = 0
  for (const cid of order) {
    const acc = classes.get(cid)!
    const days = baseDays + allDays + (classAdjDays.get(cid) ?? 0)
    let minutes = 0
    for (const [dow, count] of openDays) minutes += (acc.weekday.get(dow) ?? 0) * count
    minutes += allMin + (classAdjMin.get(cid) ?? 0)
    if (minutes < 0) minutes = 0
    const row: WorkingDaysClassRow = {
      class_id: cid, class_label: acc.name, class_level: opt(acc.level), working_days: round2(days), instructional_minutes: Math.trunc(minutes + 0.5),
      required_days: fallbackDays, required_minutes: 0, shortfall_days: 0, shortfall_minutes: 0, has_timetable: acc.hasTable,
    }
    const n = normFor(norms, acc.level)
    if (n) {
      row.stage_code = n.stage_code
      row.stage_label = n.label
      row.required_days = n.min_days
      row.required_minutes = Math.trunc(n.min_hours * 60)
    }
    const d = row.required_days - row.working_days
    if (d > 0) row.shortfall_days = round2(d)
    if (row.has_timetable) {
      const m = row.required_minutes - row.instructional_minutes
      if (m > 0) row.shortfall_minutes = m
    } else noTimetable++
    if (row.shortfall_days > 0 || row.shortfall_minutes > 0) out.classes_short++
    out.classes.push(row)
  }

  if (noTimetable > 0) {
    out.notes.push(itoa(noTimetable) + ' class(es) have no timetable for this year, so their instructional hours could not be computed. Their day count is still correct.')
  }
  if (out.declared_working_days !== undefined && out.declared_working_days > 0) {
    const diff = out.declared_working_days - Math.trunc(out.working_days)
    if (diff > 2 || diff < -2) {
      out.notes.push('The calendar gives ' + itoa(Math.trunc(out.working_days)) + ' working days but the academic year declares ' +
        itoa(out.declared_working_days) + '. One of the two is wrong, and the return will be read against the calendar.')
    }
  }
  return out
}

function registerWorkingDays(r: Router): void {
  // getWorkingDays computes the return without filing it. ?to_date=1 cuts the window at today.
  r.get('/statutory/working-days', PERM_READ, async (c) => {
    institutionId(c)
    const toDate = c.url.searchParams.get('to_date') === '1'
    await ensureInstructionalNorms(c)
    const year = await resolveAcademicYear(c.db, c.url.searchParams.get('academic_year_id'))
    let ends = year.ends_on
    if (toDate) {
      const today = todayIST()
      if (today < ends) ends = today
    }
    const out = await computeWorkingDays(c, year.id, year.starts_on, ends)
    out.academic_year = year.name
    out.to_date = toDate
    return ok(out)
  })

  r.get('/statutory/working-days/norms', PERM_READ, async (c) => {
    institutionId(c)
    await ensureInstructionalNorms(c)
    const rows = await c.db.prepare(`SELECT id, stage_code, label, min_level, max_level, min_days, min_hours, authority, note FROM instructional_norms ORDER BY min_level`)
      .all<{ id: string; stage_code: string; label: string; min_level: number; max_level: number; min_days: number; min_hours: string | number; authority: string | null; note: string | null }>()
    return ok(items(rows.results.map((v) => ({
      id: v.id, stage_code: v.stage_code, label: v.label, min_level: v.min_level, max_level: v.max_level, min_days: v.min_days,
      min_hours: Number(v.min_hours) || 0, authority: opt(v.authority), note: opt(v.note),
    }))))
  })

  // saveInstructionalNorm edits one stage band.
  r.put('/statutory/working-days/norms', PERM_ACADEMICS_WRITE, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ stage_code?: string; label?: string; min_level?: number; max_level?: number; min_days?: number; min_hours?: number; authority?: string; note?: string }>(c.req)
    const stageCode = trim(req.stage_code)
    let label = trim(req.label)
    if (stageCode === '') throw badRequest('stage_code is required')
    if (label === '') label = stageCode
    const minLevel = Math.trunc(Number(req.min_level ?? 0) || 0), maxLevel = Math.trunc(Number(req.max_level ?? 0) || 0)
    const minDays = Math.trunc(Number(req.min_days ?? 0) || 0), minHours = Number(req.min_hours ?? 0) || 0
    if (minLevel < 1 || maxLevel < minLevel || maxLevel > 12) throw badRequest('min_level and max_level must describe a band inside 1..12')
    if (minDays < 0 || minDays > 366 || minHours < 0) throw badRequest('min_days must be 0..366 and min_hours cannot be negative')
    // instructional_norms_one_per_stage: (institution, lower(stage_code)).
    const existing = await c.db.prepare(`SELECT id FROM instructional_norms WHERE lower(stage_code) = lower(?)`).bind(stageCode).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const stmt = existing
      ? c.db.prepare(`UPDATE instructional_norms SET label = ?, min_level = ?, max_level = ?, min_days = ?, min_hours = ?, authority = ?, note = ?, updated_at = ? WHERE id = ?`)
        .bind(label, minLevel, maxLevel, minDays, String(minHours), nullStr(trim(req.authority)), nullStr(trim(req.note)), now(), id)
      : c.db.prepare(`INSERT INTO instructional_norms (id, institution_id, stage_code, label, min_level, max_level, min_days, min_hours, authority, note, updated_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, inst, stageCode, label, minLevel, maxLevel, minDays, String(minHours), nullStr(trim(req.authority)), nullStr(trim(req.note)), now())
    try { await stmt.run() } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return ok({ id })
  })

  r.get('/statutory/working-days/adjustments', PERM_READ, async (c) => {
    institutionId(c)
    const year = await resolveAcademicYear(c.db, c.url.searchParams.get('academic_year_id'))
    const rows = await c.db.prepare(`
      SELECT a.id, a.class_id, c.name AS class_label, ${dateOf('a.on_date')} AS on_date, a.days_delta, a.minutes_delta, a.reason,
             u.full_name AS created_by, ${tsOf('a.created_at')} AS created_at
        FROM working_days_adjustments a
        LEFT JOIN classes c ON c.id = a.class_id
        LEFT JOIN users u ON u.id = a.created_by
       WHERE a.academic_year_id = ?
       ORDER BY a.on_date DESC`).bind(year.id)
      .all<{ id: string; class_id: string | null; class_label: string | null; on_date: string; days_delta: string | number; minutes_delta: number; reason: string; created_by: string | null; created_at: string }>()
    return ok(items(rows.results.map((v) => ({
      id: v.id, class_id: opt(v.class_id), class_label: opt(v.class_label), on_date: v.on_date, days_delta: Number(v.days_delta) || 0,
      minutes_delta: v.minutes_delta, reason: v.reason, created_by: opt(v.created_by), created_at: v.created_at,
    }))))
  })

  r.post('/statutory/working-days/adjustments', PERM_ACADEMICS_WRITE, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ academic_year_id?: string; class_id?: string; on_date?: string; days_delta?: number; minutes_delta?: number; reason?: string }>(c.req)
    const reason = trim(req.reason), onDate = trim(req.on_date)
    if (reason === '') throw badRequest('a reason is required. An adjustment nobody can explain is one an inspection will ask about')
    if (onDate === '') throw badRequest('on_date is required')
    const daysDelta = Number(req.days_delta ?? 0) || 0, minsDelta = Math.trunc(Number(req.minutes_delta ?? 0) || 0)
    if (daysDelta === 0 && minsDelta === 0) throw badRequest('an adjustment of nothing changes nothing; give a day or a minute delta')
    const classId = trim(req.class_id)
    if (classId !== '' && !isUUID(classId)) throw badRequest('class_id must be a uuid')
    if (!isDate(onDate)) throw badRequest('on_date must be YYYY-MM-DD')
    const year = await resolveAcademicYear(c.db, req.academic_year_id)
    // working_days_adjustments_one_per_day: (institution, year, COALESCE(class_id,''), on_date, lower(reason)).
    const existing = await c.db.prepare(`
      SELECT id FROM working_days_adjustments
       WHERE academic_year_id = ? AND COALESCE(class_id,'') = ? AND ${dateOf('on_date')} = ? AND lower(reason) = lower(?)`)
      .bind(year.id, classId, onDate, reason).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const stmt = existing
      ? c.db.prepare(`UPDATE working_days_adjustments SET days_delta = ?, minutes_delta = ? WHERE id = ?`).bind(String(daysDelta), minsDelta, id)
      : c.db.prepare(`INSERT INTO working_days_adjustments (id, institution_id, academic_year_id, class_id, on_date, days_delta, minutes_delta, reason, created_by, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, inst, year.id, nullStr(classId), onDate, String(daysDelta), minsDelta, reason, actorId(c), now())
    try { await stmt.run() } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return ok({ id })
  })

  r.del('/statutory/working-days/adjustments/{id}', PERM_ACADEMICS_WRITE, async (c) => {
    const adjId = uuidParam(c.params.id)
    const res = await c.db.prepare(`DELETE FROM working_days_adjustments WHERE id = ?`).bind(adjId).run()
    if (!res.meta.changes) throw notFound()
    return ok({ deleted: true })
  })

  r.get('/statutory/working-days/returns', PERM_READ, async (c) => {
    type R = { id: string; academic_year_id: string; title: string; period_from: string; period_to: string; status: string; working_days: string | number
      classes_short: number; filed_at: string | null; filed_by: string | null; notes: string | null; created_at: string }
    type L = { return_id: string; class_id: string | null; class_label: string | null; class_level: number | null; stage_code: string | null
      working_days: string | number; instructional_minutes: number; required_days: number; required_minutes: number; shortfall_days: string | number; shortfall_minutes: number }
    const heads = await c.db.prepare(`
      SELECT t.id, t.academic_year_id, t.title, ${dateOf('t.period_from')} AS period_from, ${dateOf('t.period_to')} AS period_to, t.status, t.working_days,
             t.classes_short, ${tsOf('t.filed_at')} AS filed_at, u.full_name AS filed_by, t.notes, ${tsOf('t.created_at')} AS created_at
        FROM working_days_returns t
        LEFT JOIN users u ON u.id = t.filed_by
       ORDER BY t.created_at DESC`).all<R>()
    const out = heads.results.map((v) => ({
      id: v.id, academic_year_id: v.academic_year_id, title: v.title, period_from: v.period_from, period_to: v.period_to, status: v.status,
      working_days: Number(v.working_days) || 0, classes_short: v.classes_short, filed_at: opt(v.filed_at), filed_by: opt(v.filed_by), notes: opt(v.notes),
      created_at: v.created_at, lines: [] as WorkingDaysClassRow[],
    }))
    if (out.length > 0) {
      const byId = new Map(out.map((v) => [v.id, v]))
      const lines = await c.db.prepare(`
        SELECT return_id, class_id, class_label, class_level, stage_code, working_days, instructional_minutes, required_days, required_minutes,
               shortfall_days, shortfall_minutes
          FROM working_days_return_lines ORDER BY class_level IS NULL, class_level, class_label`).all<L>()
      for (const l of lines.results) {
        byId.get(l.return_id)?.lines.push({
          class_id: opt(l.class_id), class_label: deref(l.class_label), class_level: opt(l.class_level), stage_code: opt(l.stage_code),
          working_days: Number(l.working_days) || 0, instructional_minutes: l.instructional_minutes, required_days: l.required_days,
          required_minutes: l.required_minutes, shortfall_days: Number(l.shortfall_days) || 0, shortfall_minutes: l.shortfall_minutes,
          has_timetable: l.instructional_minutes > 0,
        })
      }
    }
    return ok(items(out))
  })

  // fileWorkingDaysReturn freezes the figures, recomputed here and stored line by line.
  r.post('/statutory/working-days/returns', PERM_FILE_RETURN, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ academic_year_id?: string; title?: string; period_from?: string; period_to?: string; notes?: string }>(c.req)
    let title = trim(req.title)
    await ensureInstructionalNorms(c)
    const year = await resolveAcademicYear(c.db, req.academic_year_id)
    let from = year.starts_on, to = year.ends_on
    const pf = trim(req.period_from), pt = trim(req.period_to)
    if (pf !== '') { if (!isDate(pf)) throw badRequest('period_from must be YYYY-MM-DD'); from = pf }
    if (pt !== '') { if (!isDate(pt)) throw badRequest('period_to must be YYYY-MM-DD'); to = pt }
    if (to < from) throw badRequest('period_to cannot be before period_from')
    if (title === '') title = 'Working days and instructional hours ' + year.name

    const computed = await computeWorkingDays(c, year.id, from, to)
    // working_days_returns_one_per_title: (institution, year, lower(title)).
    const dup = await c.db.prepare(`SELECT 1 AS x FROM working_days_returns WHERE academic_year_id = ? AND lower(title) = lower(?)`).bind(year.id, title).first()
    if (dup) throw badRequest('a return with that title already exists for this year. Give this one its own name. A filed return is never replaced')

    const retId = uuid()
    const ts = now()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`
        INSERT INTO working_days_returns (id, institution_id, academic_year_id, title, period_from, period_to, status, working_days, classes_short,
                                          filed_at, filed_by, notes, created_by, created_at)
        VALUES (?,?,?,?,?,?,'filed',?,?,?,?,?,?,?)`)
        .bind(retId, inst, year.id, title, from, to, String(computed.working_days), computed.classes_short, ts, actorId(c), nullStr(trim(req.notes)), actorId(c), ts),
    ]
    for (const line of computed.classes) {
      stmts.push(c.db.prepare(`
        INSERT INTO working_days_return_lines (id, institution_id, return_id, class_id, class_label, class_level, stage_code, working_days,
                                               instructional_minutes, required_days, required_minutes, shortfall_days, shortfall_minutes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(uuid(), inst, retId, line.class_id ?? null, line.class_label, line.class_level ?? null, line.stage_code ?? null, String(line.working_days),
          line.instructional_minutes, line.required_days, line.required_minutes, String(line.shortfall_days), line.shortfall_minutes))
    }
    try { await c.db.batch(stmts) } catch (e) {
      if (isUniqueViolation(e)) throw badRequest('a return with that title already exists for this year. Give this one its own name. A filed return is never replaced')
      throw badRequest(e instanceof Error ? e.message : String(e))
    }
    return ok({ id: retId })
  })
}

// ============================================================================
// 5. Child Info portal sync (platform tier)
// ============================================================================

/* No state Child Info portal exposes an API to this installation. The
   file_exchange provider is the only working one; 'api' is recorded so a
   connector exists the day credentials arrive, and until then the screen
   says plainly that it cannot run. Nothing here reports a sync it did not
   perform, and nothing here reaches the network. */

interface ConnectorRow {
  id: string; state_code: string; name: string; provider: string; endpoint_url?: string; username?: string; has_secret: boolean
  schedule?: string; is_enabled: boolean; last_sync_at?: string; last_status?: string; last_error?: string; run_count: number
  ready: boolean; blocker?: string; updated_at: string
}

/** childInfoProviderFor(kind).Ready(c): whether the connector could do anything today, and why not. */
function connectorReady(v: ConnectorRow): [boolean, string] {
  if (v.provider === 'api') {
    if (!v.has_secret) return [false, 'no portal credentials have been entered']
    if (v.endpoint_url === undefined || v.endpoint_url.trim() === '') return [false, 'no portal endpoint has been recorded']
    return [false, 'live portal sync needs state portal API credentials and an endpoint the state publishes; neither exists for this installation today. ' +
      "Use the file exchange: export the roster, upload it on the portal, and import the portal's extract into Child Info Reconciliation."]
  }
  if (!v.is_enabled) return [false, 'the connector is switched off']
  return [true, '']
}

/** sealSecret in messaging.go: AES-256-GCM under SHA-256(CREDENTIAL_KEY), nonce || ciphertext || tag. */
async function sealSecret(c: Ctx, plain: string): Promise<ArrayBuffer> {
  const key = c.env.CREDENTIAL_KEY
  if (typeof key !== 'string' || key.trim() === '') {
    // A refusal, not a 500: storing a state portal password in clear would be the worse way to fail.
    throw forbidden('CREDENTIAL_KEY is not set. Refusing to store a password in clear')
  }
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, new TextEncoder().encode(plain)))
  const out = new Uint8Array(nonce.length + sealed.length)
  out.set(nonce, 0)
  out.set(sealed, nonce.length)
  return out.buffer
}

function registerPortal(r: Router): void {
  r.get('/statutory/portal/connectors', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const rows = await c.db.prepare(`
      SELECT c.id, c.state_code, c.name, c.provider, c.endpoint_url, c.username,
             (c.credentials IS NOT NULL AND length(c.credentials) > 0) AS has_secret,
             c.schedule, c.is_enabled, ${tsOf('c.last_sync_at')} AS last_sync_at, c.last_status, c.last_error,
             (SELECT count(*) FROM child_info_sync_runs g WHERE g.connector_id = c.id) AS run_count,
             ${tsOf('c.updated_at')} AS updated_at
        FROM child_info_portal_connectors c
       ORDER BY c.state_code, c.name`)
      .all<{ id: string; state_code: string; name: string; provider: string; endpoint_url: string | null; username: string | null; has_secret: number
        schedule: string | null; is_enabled: number; last_sync_at: string | null; last_status: string | null; last_error: string | null; run_count: number; updated_at: string }>()
    return ok(items(rows.results.map((v) => {
      const row: ConnectorRow = {
        id: v.id, state_code: v.state_code, name: v.name, provider: v.provider, endpoint_url: opt(v.endpoint_url), username: opt(v.username),
        has_secret: !!v.has_secret, schedule: opt(v.schedule), is_enabled: !!v.is_enabled, last_sync_at: opt(v.last_sync_at),
        last_status: opt(v.last_status), last_error: opt(v.last_error), run_count: v.run_count, ready: false, updated_at: v.updated_at,
      }
      const [ready, blocker] = connectorReady(row)
      row.ready = ready
      row.blocker = blocker === '' ? undefined : blocker
      return row
    })))
  })

  r.post('/statutory/portal/connectors', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const req = await readJSON<{ id?: string; state_code?: string; name?: string; provider?: string; endpoint_url?: string; username?: string
      secret?: string | null; schedule?: string; is_enabled?: boolean }>(c.req)
    const stateCode = trim(req.state_code), name = trim(req.name)
    let provider = trim(req.provider)
    if (provider === '') provider = 'file_exchange'
    if (stateCode === '' || name === '') throw badRequest('state_code and name are required')
    if (provider !== 'file_exchange' && provider !== 'api') throw badRequest('provider must be file_exchange or api')
    // An absent (or empty) secret leaves what is stored alone.
    const sealed = typeof req.secret === 'string' && req.secret !== '' ? await sealSecret(c, req.secret) : null
    const endpoint = trim(req.endpoint_url), username = trim(req.username), schedule = trim(req.schedule)
    const enabled = req.is_enabled ? 1 : 0
    const ts = now()

    const idv = trim(req.id)
    if (idv !== '') {
      if (!isUUID(idv)) throw badRequest('id must be a uuid')
      const res = await c.db.prepare(`
        UPDATE child_info_portal_connectors
           SET state_code = ?2, name = ?3, provider = ?4, endpoint_url = NULLIF(?5,''), username = NULLIF(?6,''),
               credentials = COALESCE(?7, credentials), schedule = NULLIF(?8,''), is_enabled = ?9, updated_at = ?10, updated_by = ?11
         WHERE id = ?1`).bind(idv, stateCode, name, provider, endpoint, username, sealed, schedule, enabled, ts, actorId(c)).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: idv })
    }
    // child_info_portal_connectors_one_per_state: (lower(state_code), lower(name)).
    const existing = await c.db.prepare(`SELECT id FROM child_info_portal_connectors WHERE lower(state_code) = lower(?) AND lower(name) = lower(?)`)
      .bind(stateCode, name).first<{ id: string }>()
    if (existing) {
      await c.db.prepare(`
        UPDATE child_info_portal_connectors
           SET provider = ?2, endpoint_url = NULLIF(?3,''), username = NULLIF(?4,''), credentials = COALESCE(?5, credentials),
               schedule = NULLIF(?6,''), is_enabled = ?7, updated_at = ?8, updated_by = ?9
         WHERE id = ?1`).bind(existing.id, provider, endpoint, username, sealed, schedule, enabled, ts, actorId(c)).run()
      return ok({ id: existing.id })
    }
    const id = uuid()
    await c.db.prepare(`
      INSERT INTO child_info_portal_connectors (id, state_code, name, provider, endpoint_url, username, credentials, schedule, is_enabled, created_at, updated_at, updated_by)
      VALUES (?,?,?,?,NULLIF(?,''),NULLIF(?,''),?,NULLIF(?,''),?,?,?,?)`)
      .bind(id, stateCode, name, provider, endpoint, username, sealed, schedule, enabled, ts, ts, actorId(c)).run()
    return ok({ id })
  })

  r.del('/statutory/portal/connectors/{id}', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const connId = uuidParam(c.params.id)
    const res = await c.db.prepare(`DELETE FROM child_info_portal_connectors WHERE id = ?`).bind(connId).run()
    if (!res.meta.changes) throw notFound()
    return ok({ deleted: true })
  })

  r.get('/statutory/portal/runs', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const connV = trim(c.url.searchParams.get('connector_id'))
    if (connV !== '' && !isUUID(connV)) throw badRequest('connector_id must be a uuid')
    const rows = await c.db.prepare(`
      SELECT g.id, g.connector_id, c.name AS connector_name, c.state_code, COALESCE(g.institution_name, i.name) AS institution_name,
             g.direction, g.status, ${tsOf('g.started_at')} AS started_at, ${tsOf('g.finished_at')} AS finished_at, g.row_count, g.message,
             u.full_name AS started_by
        FROM child_info_sync_runs g
        JOIN child_info_portal_connectors c ON c.id = g.connector_id
        LEFT JOIN institutions i ON i.id = g.institution_id
        LEFT JOIN users u ON u.id = g.started_by
       WHERE (?1 IS NULL OR g.connector_id = ?1)
       ORDER BY g.started_at DESC
       LIMIT 200`).bind(nullStr(connV))
      .all<{ id: string; connector_id: string; connector_name: string; state_code: string; institution_name: string | null; direction: string; status: string
        started_at: string; finished_at: string | null; row_count: number; message: string | null; started_by: string | null }>()
    return ok(items(rows.results.map((v) => ({
      id: v.id, connector_id: v.connector_id, connector_name: v.connector_name, state_code: v.state_code, institution_name: opt(v.institution_name),
      direction: v.direction, status: v.status, started_at: v.started_at, finished_at: opt(v.finished_at), row_count: v.row_count,
      message: opt(v.message), started_by: opt(v.started_by),
    }))))
  })

  // recordChildInfoRun writes what an operator actually did. A logbook, not a scheduler.
  r.post('/statutory/portal/connectors/{id}/runs', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const connId = uuidParam(c.params.id)
    const req = await readJSON<{ institution_id?: string; direction?: string; status?: string; row_count?: number; message?: string }>(c.req)
    const direction = trim(req.direction)
    let status = trim(req.status)
    if (direction !== 'export' && direction !== 'import') throw badRequest('direction must be export or import')
    if (status === '') status = 'ok'
    if (status !== 'ok' && status !== 'failed') throw badRequest('status must be ok or failed')
    const instV = trim(req.institution_id)
    if (instV !== '' && !isUUID(instV)) throw badRequest('institution_id must be a uuid')
    const message = truncate(req.message ?? '', 500)
    const rowCount = Math.trunc(Number(req.row_count ?? 0) || 0)
    const runId = uuid()
    const ts = now()
    try {
      await c.db.batch([
        // institution_name is copied rather than joined, so the log still reads after a tenant is removed.
        c.db.prepare(`
          INSERT INTO child_info_sync_runs (id, connector_id, institution_id, institution_name, direction, status, started_at, finished_at, row_count, message, started_by)
          SELECT ?1, ?2, ?3, (SELECT name FROM institutions WHERE id = ?3), ?4, ?5, ?8, ?8, ?6, NULLIF(?7,''), ?9`)
          .bind(runId, connId, nullStr(instV), direction, status, rowCount, message, ts, actorId(c)),
        // The connector's own health, written back to the same row.
        c.db.prepare(`
          UPDATE child_info_portal_connectors
             SET last_sync_at = ?4, last_status = ?2, last_error = CASE WHEN ?2 = 'failed' THEN NULLIF(?3,'') END, updated_at = ?4
           WHERE id = ?1`).bind(connId, status, message, ts),
      ])
    } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)) }
    return ok({ id: runId })
  })

  // exportChildInfoRoster writes the file an operator uploads to the portal. Scoped to one named school.
  r.get('/statutory/portal/export', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const instV = trim(c.url.searchParams.get('institution_id'))
    if (!isUUID(instV)) throw badRequest('institution_id is required and must be a uuid')
    const inst = await institutionById(c.env, instV)
    if (!inst) throw notFound()
    const db = tenantDb(c.env, inst)
    const year = await resolveAcademicYear(db, c.url.searchParams.get('academic_year_id'))
    const students = await loadChildInfoStudents(db, year.id)
    const rows = students.map((st) => [
      deref(st.child_info_id), st.admission_no, st.name, deref(st.father), deref(st.mother), deref(st.dob), deref(st.gender),
      deref(st.aadhaar), deref(st.apaar), deref(st.class_label),
    ])
    return csvResponse('child-info-roster.csv', [
      'Child Info ID', 'Admission No', 'Student Name', 'Father Name', 'Mother Name', 'Date of Birth', 'Gender', 'Aadhaar Last4', 'APAAR ID', 'Class',
    ], rows)
  })
}

// ---------------------------------------------------------------- register

/** Every route of mountStatutory, under /statutory on the v1 router. */
export function registerStatutory(r: Router): void {
  registerLOC(r)
  registerSQAA(r)
  registerChildInfo(r)
  registerWorkingDays(r)
  registerPortal(r)
}

