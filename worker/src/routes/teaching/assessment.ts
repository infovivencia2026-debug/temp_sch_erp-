import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, forbidden, isUUID, like, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { institutionId, marks, js, requirePerm, resolveScope, shortName, type Scope } from './common'
import { assistantFailure, assistantRateLimit, callGeminiParts } from './gemini'

/* Port of the assessment half of internal/api/teaching.go: the question bank
   (plus paper_compose.go and question_bank_generate.go), objective online
   tests, and both halves of CCE. Mounted under /teaching, whose group gate
   (academics.timetable.read) a student also holds, so every handler narrows to
   the caller's own sections and every write names a second permission. */

const GROUP = 'academics.timetable.read'
const HOMEWORK_WRITE = 'academics.homework.write'
const MARKS_WRITE = 'academics.marks.write'

type Row = Record<string, unknown>
type Stmt = D1PreparedStatement

// ---------------------------------------------------------------------------
// shared narrowing (teaching.go / faculty_comms.go)

/** Go's httpx.Forbidden message shape. */
const forbid = (what: string) => forbidden('missing permission: ' + what)
const notFoundGo = () => notFound('resource not found')
const items = (list: unknown[]) => ok({ items: list })

/** taughtSubjectsPredicate over a class_subjects alias. */
function taughtSubjectsPredicate(s: Scope, alias: string): { sql: string; args: string[] } {
  if (s.allStudents) return { sql: '1', args: [] }
  if (s.sectionIds.length === 0) return { sql: '0', args: [] }
  return {
    sql: `EXISTS (SELECT 1 FROM sections tsec WHERE tsec.id IN (${marks(s.sectionIds)}) AND tsec.class_id = ${alias}.class_id)`,
    args: [js(s.sectionIds)],
  }
}

/** taughtStudentsPredicate: active enrolment in one of the caller's sections. */
function taughtStudentsPredicate(s: Scope, column: string): { sql: string; args: string[] } {
  if (s.allStudents) return { sql: '1', args: [] }
  if (s.sectionIds.length === 0) return { sql: '0', args: [] }
  return {
    sql: `EXISTS (SELECT 1 FROM enrollments se WHERE se.student_id = ${column} AND se.status = 'active' AND se.section_id IN (${marks(s.sectionIds)}))`,
    args: [js(s.sectionIds)],
  }
}

const reachesSection = (s: Scope, sectionId: string): boolean => s.allStudents || s.sectionIds.includes(sectionId)

async function classSubjectTaught(c: Ctx, s: Scope, csId: string): Promise<boolean> {
  if (s.allStudents) return true
  if (s.sectionIds.length === 0) return false
  const r = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM class_subjects cs JOIN sections sec ON sec.class_id = cs.class_id
      WHERE cs.id = ? AND sec.id IN (${marks(s.sectionIds)})) AS ok`).bind(csId, js(s.sectionIds)).first<{ ok: number }>()
  return !!r?.ok
}

async function reachesTaughtStudent(c: Ctx, s: Scope, studentId: string): Promise<boolean> {
  if (s.allStudents) return true
  if (s.sectionIds.length === 0) return false
  const r = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ? AND e.status = 'active'
      AND e.section_id IN (${marks(s.sectionIds)})) AS ok`).bind(studentId, js(s.sectionIds)).first<{ ok: number }>()
  return !!r?.ok
}

// ---------------------------------------------------------------------------
// small helpers

/** Adds k: v only when v is not null/undefined (Go omitempty on a pointer). */
function opt(o: Row, k: string, v: unknown): void { if (v !== null && v !== undefined) o[k] = v }
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const numStr = (n: number | null | undefined): string | null => (n === null || n === undefined ? null : String(n))
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const nullUUID = (v: string): string | null => (v.trim() === '' ? null : v)
const nullPositiveInt = (n: number): number | null => (n > 0 ? n : null)
/** A JSON number field as Go would decode it into float64 (absent -> 0). */
function f64(v: unknown): number {
  if (v === undefined || v === null) return 0
  if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest('malformed JSON body')
  return v
}
function i64(v: unknown): number {
  const n = f64(v)
  if (!Number.isInteger(n)) throw badRequest('malformed JSON body')
  return n
}
function optF64(v: unknown): number | null { return v === undefined || v === null ? null : f64(v) }
function optBool(v: unknown): boolean | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'boolean') throw badRequest('malformed JSON body')
  return v
}
function b(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw badRequest('malformed JSON body')
  return v
}
function arr<T = unknown>(v: unknown): T[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw badRequest('malformed JSON body')
  return v as T[]
}
async function body(c: Ctx): Promise<Row> {
  const v = await readJSON<unknown>(c.req)
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw badRequest('malformed JSON body')
  return v as Row
}
/** NULLIF($n,'')::timestamptz: '' is null, anything else must parse. Stored as ISO UTC. */
function ts(v: string, field: string): string | null {
  if (v === '') return null
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw badRequest(`${field} must be a timestamp`)
  return new Date(t).toISOString()
}
/** Go's to_char(... AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'. */
const isoSQL = (col: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`
/** Go's trimFloat. */
const trimFloat = (v: number) => String(v)

// ---------------------------------------------------------------------------
// question bank vocabulary

const objectiveKinds = new Set(['mcq', 'true_false', 'fill_blank'])
const questionKinds = new Set(['mcq', 'true_false', 'fill_blank', 'short', 'long'])
const difficulties = new Set(['easy', 'medium', 'hard'])
const bloomLevels = new Set(['remember', 'understand', 'apply', 'analyse', 'evaluate', 'create'])

interface BankOptionInput { body: string; is_correct: boolean }
interface BankQuestionRequest {
  class_subject_id: string
  syllabus_unit_id: string
  kind: string
  difficulty: string
  bloom_level: string
  stem: string
  default_marks: number
  explanation: string
  is_active: boolean | null
  options: BankOptionInput[]
}

function decodeBankRequest(raw: Row): BankQuestionRequest {
  return {
    class_subject_id: s(raw.class_subject_id),
    syllabus_unit_id: s(raw.syllabus_unit_id),
    kind: s(raw.kind),
    difficulty: s(raw.difficulty),
    bloom_level: s(raw.bloom_level),
    stem: s(raw.stem),
    default_marks: f64(raw.default_marks),
    explanation: s(raw.explanation),
    is_active: optBool(raw.is_active),
    options: arr<Row>(raw.options).map((o) => ({ body: s(o?.body), is_correct: b(o?.is_correct) })),
  }
}

const NO_CORRECT_OPTION = 'an objective question with no correct answer'

/** validateBankQuestion: fills defaults in place; returns an error message or null. */
function validateBankQuestion(req: BankQuestionRequest, requireOptions: boolean): string | null {
  if (req.kind === '') req.kind = 'mcq'
  if (!questionKinds.has(req.kind)) return 'kind must be mcq, true_false, fill_blank, short or long'
  if (req.difficulty === '') req.difficulty = 'medium'
  if (!difficulties.has(req.difficulty)) return 'difficulty must be easy, medium or hard'
  if (req.bloom_level === '') req.bloom_level = 'understand'
  if (!bloomLevels.has(req.bloom_level)) return 'bloom_level must be remember, understand, apply, analyse, evaluate or create'
  if (req.default_marks <= 0) req.default_marks = 1
  if (objectiveKinds.has(req.kind) && (requireOptions || req.options.length > 0)) {
    if (req.options.length < 2 && req.kind !== 'fill_blank') return 'an objective question needs at least two options'
    let correct = 0
    for (const o of req.options) {
      if (o.body.trim() === '') return 'an option may not be blank'
      if (o.is_correct) correct++
    }
    if (correct === 0) return NO_CORRECT_OPTION
  }
  return null
}

function insertQuestionStmts(c: Ctx, qId: string, csId: string, req: BankQuestionRequest, active: boolean): Stmt[] {
  const t = now()
  const out: Stmt[] = [c.db.prepare(`INSERT INTO question_bank_questions (id, institution_id, class_subject_id, syllabus_unit_id,
      kind, difficulty, bloom_level, stem, default_marks, explanation, is_active, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,NULLIF(?,''),?,?,?,?)`)
    .bind(qId, institutionId(c), csId, nullUUID(req.syllabus_unit_id), req.kind, req.difficulty, req.bloom_level,
      req.stem, String(req.default_marks), req.explanation, active ? 1 : 0, c.id.userId, t, t)]
  return out.concat(insertOptionStmts(c, qId, req))
}

function insertOptionStmts(c: Ctx, qId: string, req: BankQuestionRequest): Stmt[] {
  return req.options.map((o, i) => c.db.prepare(`INSERT INTO question_bank_options (id, institution_id, question_id, sequence, body, is_correct)
      VALUES (?,?,?,?,?,?)`).bind(uuid(), institutionId(c), qId, i + 1, o.body.trim(), o.is_correct ? 1 : 0))
}

const optionsSQL = (qAlias: string) => `COALESCE((SELECT json_group_array(ob.body) FROM
    (SELECT o.body FROM question_bank_options o WHERE o.question_id = ${qAlias}.id ORDER BY o.sequence) ob), '[]')`

// ---------------------------------------------------------------------------
// question bank handlers

async function listBankQuestions(c: Ctx): Promise<Response> {
  const res = await resolveScope(c)
  const p = taughtSubjectsPredicate(res, 'cs')
  let where = p.sql
  const args: (string | number)[] = [...p.args]
  const q = c.url.searchParams
  for (const f of [
    { param: 'kind', column: 'q.kind', valid: questionKinds },
    { param: 'difficulty', column: 'q.difficulty', valid: difficulties },
    { param: 'bloom_level', column: 'q.bloom_level', valid: bloomLevels },
  ]) {
    const v = q.get(f.param) ?? ''
    if (v !== '') {
      if (!f.valid.has(v)) throw badRequest(f.param + ' is not a recognised value')
      args.push(v)
      where += ` AND ${f.column} = ?`
    }
  }
  const cs = q.get('class_subject_id') ?? ''
  if (cs !== '') {
    if (!isUUID(cs)) throw badRequest('class_subject_id must be a uuid')
    args.push(cs)
    where += ' AND q.class_subject_id = ?'
  }
  const search = (q.get('search') ?? '').trim()
  if (search !== '') {
    args.push(like(search))
    where += ` AND q.stem LIKE ? ESCAPE '\\'`
  }
  if (q.get('include_retired') !== '1') where += ' AND q.is_active = 1'

  const rs = await c.db.prepare(`
    SELECT q.id, q.class_subject_id, c.name AS class_name, sub.name AS subject,
           q.syllabus_unit_id, su.title AS chapter, q.kind, q.difficulty, q.bloom_level, q.stem,
           q.default_marks, q.explanation, q.is_active, ${optionsSQL('q')} AS options,
           (SELECT count(*) FROM online_test_questions tq WHERE tq.question_id = q.id) AS used_on,
           u.full_name AS created_by
      FROM question_bank_questions q
      JOIN class_subjects cs ON cs.id = q.class_subject_id
      JOIN classes         c ON c.id = cs.class_id
      JOIN subjects      sub ON sub.id = cs.subject_id
      LEFT JOIN syllabus_units su ON su.id = q.syllabus_unit_id
      LEFT JOIN users u ON u.id = q.created_by
     WHERE ${where}
     ORDER BY c.level, sub.name, q.created_at DESC
     LIMIT 300`).bind(...args).all<Row>()
  return items(rs.results.map((r) => bankQuestionJSON(r, JSON.parse(String(r.options ?? '[]')) as string[], Number(r.used_on ?? 0))))
}

function bankQuestionJSON(r: Row, options: string[], usedOn: number): Row {
  const o: Row = {
    id: r.id, class_subject_id: r.class_subject_id, class_name: r.class_name, subject: r.subject,
  }
  opt(o, 'syllabus_unit_id', r.syllabus_unit_id)
  opt(o, 'chapter', r.chapter)
  o.kind = r.kind
  o.difficulty = r.difficulty
  o.bloom_level = r.bloom_level
  o.stem = r.stem
  o.default_marks = Number(r.default_marks)
  opt(o, 'explanation', r.explanation)
  o.is_active = bool(r.is_active)
  o.options = options
  o.objective = objectiveKinds.has(String(r.kind))
  o.used_on_tests = usedOn
  opt(o, 'created_by', r.created_by)
  return o
}

async function getBankSummary(c: Ctx): Promise<Response> {
  const res = await resolveScope(c)
  const p = taughtSubjectsPredicate(res, 'cs')
  const rs = await c.db.prepare(`
    SELECT cs.id AS class_subject_id, c.name AS class_name, sub.name AS subject,
           count(q.id) AS total,
           SUM(CASE WHEN q.kind IN ('mcq','true_false','fill_blank') THEN 1 ELSE 0 END) AS objective,
           SUM(CASE WHEN q.difficulty = 'easy' THEN 1 ELSE 0 END) AS easy,
           SUM(CASE WHEN q.difficulty = 'medium' THEN 1 ELSE 0 END) AS medium,
           SUM(CASE WHEN q.difficulty = 'hard' THEN 1 ELSE 0 END) AS hard,
           SUM(CASE WHEN q.bloom_level IN ('apply','analyse','evaluate','create') THEN 1 ELSE 0 END) AS higher_order,
           count(DISTINCT q.syllabus_unit_id) AS chapters_covered
      FROM class_subjects cs
      JOIN classes  c   ON c.id = cs.class_id
      JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN question_bank_questions q ON q.class_subject_id = cs.id AND q.is_active = 1
     WHERE ${p.sql}
     GROUP BY cs.id, c.name, c.level, sub.name
     ORDER BY c.level, sub.name`).bind(...p.args).all<Row>()
  return items(rs.results.map((r) => ({
    class_subject_id: r.class_subject_id, class_name: r.class_name, subject: r.subject,
    total: Number(r.total ?? 0), objective: Number(r.objective ?? 0), easy: Number(r.easy ?? 0),
    medium: Number(r.medium ?? 0), hard: Number(r.hard ?? 0), higher_order: Number(r.higher_order ?? 0),
    chapters_covered: Number(r.chapters_covered ?? 0),
  })))
}

async function getBankQuestion(c: Ctx): Promise<Response> {
  const qId = c.params.id
  if (!isUUID(qId)) throw badRequest('invalid question id')
  const res = await resolveScope(c)
  const r = await c.db.prepare(`
    SELECT q.id, q.class_subject_id, c.name AS class_name, sub.name AS subject,
           q.syllabus_unit_id, su.title AS chapter, q.kind, q.difficulty,
           q.bloom_level, q.stem, q.default_marks, q.explanation, q.is_active
      FROM question_bank_questions q
      JOIN class_subjects cs ON cs.id = q.class_subject_id
      JOIN classes         c ON c.id = cs.class_id
      JOIN subjects      sub ON sub.id = cs.subject_id
      LEFT JOIN syllabus_units su ON su.id = q.syllabus_unit_id
     WHERE q.id = ?`).bind(qId).first<Row>()
  if (!r) throw notFoundGo()
  if (!(await classSubjectTaught(c, res, String(r.class_subject_id)))) throw notFoundGo()
  const opts = await c.db.prepare(`SELECT sequence, body, is_correct FROM question_bank_options
      WHERE question_id = ? ORDER BY sequence`).bind(qId).all<Row>()
  const answerKey = opts.results.map((o) => ({ sequence: Number(o.sequence), body: o.body, is_correct: bool(o.is_correct) }))
  const out = bankQuestionJSON(r, answerKey.map((o) => String(o.body)), 0)
  out.answer_key = answerKey
  return ok(out)
}

async function createBankQuestion(c: Ctx): Promise<Response> {
  requirePerm(c, HOMEWORK_WRITE)
  const req = decodeBankRequest(await body(c))
  const csId = req.class_subject_id
  if (!isUUID(csId)) throw badRequest('class_subject_id must be a uuid')
  req.stem = req.stem.trim()
  if (req.stem === '') throw badRequest('stem is required. A question needs asking')
  const verr = validateBankQuestion(req, true)
  if (verr) throw badRequest(verr)
  const res = await resolveScope(c)
  if (!(await classSubjectTaught(c, res, csId))) throw forbid('banking a question for this subject')
  const newId = uuid()
  await c.db.batch(insertQuestionStmts(c, newId, csId, req, req.is_active ?? true))
  return ok({ id: newId })
}

async function updateBankQuestion(c: Ctx): Promise<Response> {
  requirePerm(c, HOMEWORK_WRITE)
  const qId = c.params.id
  if (!isUUID(qId)) throw badRequest('invalid question id')
  const req = decodeBankRequest(await body(c))
  const res = await resolveScope(c)
  const cur = await c.db.prepare(`SELECT class_subject_id, kind FROM question_bank_questions WHERE id = ?`)
    .bind(qId).first<{ class_subject_id: string; kind: string }>()
  if (!cur) throw notFoundGo()
  if (!(await classSubjectTaught(c, res, cur.class_subject_id))) throw notFoundGo()
  if (req.kind === '') req.kind = cur.kind
  const verr = validateBankQuestion(req, false)
  if (verr === NO_CORRECT_OPTION) throw badRequest('an objective question needs at least one correct option')
  if (verr) throw badRequest(verr)

  const stmts: Stmt[] = [c.db.prepare(`
    UPDATE question_bank_questions
       SET syllabus_unit_id = COALESCE(?, syllabus_unit_id),
           kind          = ?,
           difficulty    = ?,
           bloom_level   = ?,
           stem          = COALESCE(NULLIF(?,''), stem),
           default_marks = ?,
           explanation   = COALESCE(NULLIF(?,''), explanation),
           is_active     = COALESCE(?, is_active),
           updated_at    = ?
     WHERE id = ?`).bind(nullUUID(req.syllabus_unit_id), req.kind, req.difficulty, req.bloom_level, req.stem.trim(),
      String(req.default_marks), req.explanation, req.is_active === null ? null : req.is_active ? 1 : 0, now(), qId)]
  if (req.options.length > 0) {
    stmts.push(c.db.prepare(`DELETE FROM question_bank_options WHERE question_id = ?`).bind(qId))
    stmts.push(...insertOptionStmts(c, qId, req))
  }
  await c.db.batch(stmts)
  return ok({ id: qId })
}

async function retireBankQuestion(c: Ctx): Promise<Response> {
  requirePerm(c, HOMEWORK_WRITE)
  const qId = c.params.id
  if (!isUUID(qId)) throw badRequest('invalid question id')
  const res = await resolveScope(c)
  const cur = await c.db.prepare(`SELECT class_subject_id FROM question_bank_questions WHERE id = ?`)
    .bind(qId).first<{ class_subject_id: string }>()
  if (!cur) throw notFoundGo()
  if (!(await classSubjectTaught(c, res, cur.class_subject_id))) throw notFoundGo()
  await c.db.prepare(`UPDATE question_bank_questions SET is_active = 0, updated_at = ? WHERE id = ?`).bind(now(), qId).run()
  return ok({ id: qId, is_active: false })
}

// --- paper_compose.go ------------------------------------------------------

const BLUEPRINT_MAX_ROWS = 20
const BLUEPRINT_MAX_PER_ROW = 50

interface BlueprintRow { difficulty: string; kind: string; syllabus_unit_id: string; marks: number; count: number }

async function composePaper(c: Ctx): Promise<Response> {
  const raw = await body(c)
  const csId = s(raw.class_subject_id)
  const rows: BlueprintRow[] = arr<Row>(raw.rows).map((r) => {
    if (r === null || typeof r !== 'object') throw badRequest('malformed JSON body')
    return { difficulty: s(r.difficulty), kind: s(r.kind), syllabus_unit_id: s(r.syllabus_unit_id), marks: f64(r.marks), count: i64(r.count) }
  })
  if (!isUUID(csId)) throw badRequest('choose a subject first')
  if (rows.length === 0) throw badRequest('the blueprint needs at least one row')
  if (rows.length > BLUEPRINT_MAX_ROWS) throw badRequest('a blueprint has at most 20 rows')
  for (const row of rows) {
    row.difficulty = row.difficulty.trim()
    row.kind = row.kind.trim()
    row.syllabus_unit_id = row.syllabus_unit_id.trim()
    if (row.difficulty !== '' && !difficulties.has(row.difficulty)) throw badRequest('difficulty is easy, medium or hard')
    if (row.kind !== '' && !questionKinds.has(row.kind)) throw badRequest('kind is not a recognised value')
    if (row.syllabus_unit_id !== '' && !isUUID(row.syllabus_unit_id)) throw badRequest('syllabus_unit_id must be a uuid')
    if (row.count < 1 || row.count > BLUEPRINT_MAX_PER_ROW) throw badRequest('each row asks for between 1 and 50 questions')
    if (row.marks < 0) throw badRequest('marks cannot be negative')
  }

  const res = await resolveScope(c)
  if (!(await classSubjectTaught(c, res, csId))) throw notFoundGo()

  const out = { sections: [] as Row[], total_marks: 0, questions: 0, short: 0 }
  // Drawn once per row, excluding what earlier rows took.
  const taken: string[] = []
  for (const row of rows) {
    const args: (string | number)[] = [csId]
    let where = 'q.class_subject_id = ? AND q.is_active = 1'
    if (taken.length) { where += ` AND q.id NOT IN (${marks(taken)})`; args.push(js(taken)) }
    if (row.difficulty !== '') { where += ' AND q.difficulty = ?'; args.push(row.difficulty) }
    if (row.kind !== '') { where += ' AND q.kind = ?'; args.push(row.kind) }
    if (row.syllabus_unit_id !== '') { where += ' AND q.syllabus_unit_id = ?'; args.push(row.syllabus_unit_id) }
    if (row.marks > 0) { where += ' AND CAST(q.default_marks AS REAL) = ?'; args.push(row.marks) }
    args.push(row.count)
    const rs = await c.db.prepare(`
      SELECT q.id, q.stem, q.kind, q.difficulty, q.bloom_level, su.title AS chapter,
             q.default_marks, ${optionsSQL('q')} AS options
        FROM question_bank_questions q
        LEFT JOIN syllabus_units su ON su.id = q.syllabus_unit_id
       WHERE ${where}
       ORDER BY random()
       LIMIT ?`).bind(...args).all<Row>()
    const questions = rs.results.map((q) => {
      const m = Number(q.default_marks)
      taken.push(String(q.id))
      out.total_marks += m
      return {
        id: q.id, stem: q.stem, kind: q.kind, difficulty: q.difficulty, bloom_level: q.bloom_level,
        chapter: q.chapter ?? null, marks: m, options: JSON.parse(String(q.options ?? '[]')) as string[],
      }
    })
    const found = questions.length
    out.questions += found
    out.short += row.count - found
    out.sections.push({ row, wanted: row.count, found, questions })
  }
  return ok(out)
}

// --- question_bank_generate.go ---------------------------------------------

const BANK_GEN_MAX_PDF = 10 << 20
const BANK_GEN_MAX_COUNT = 50

function normalizeGenKind(k: string): string {
  switch (k.trim().toLowerCase()) {
    case 'mcq': case 'multiple_choice': case 'multiple choice': return 'mcq'
    case 'true_false': case 'true/false': case 'truefalse': case 'true or false': return 'true_false'
    case 'fill_blank': case 'fill_in_the_blank': case 'fill in the blank': case 'fill-blank': case 'fill_in_blank': return 'fill_blank'
    case 'short': case 'short_answer': case 'short answer': return 'short'
    case 'long': case 'long_answer': case 'long answer': case 'essay': return 'long'
  }
  return ''
}

async function generateBankQuestions(c: Ctx): Promise<Response> {
  await assistantRateLimit(c)
  requirePerm(c, HOMEWORK_WRITE)
  let form: FormData
  try { form = await c.req.formData() } catch {
    throw badRequest('expected a multipart upload carrying a PDF in the `file` field')
  }
  const field = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v.trim() : '' }
  const csId = field('class_subject_id')
  if (!isUUID(csId)) throw badRequest('class_subject_id must be a uuid')
  let count = BANK_GEN_DEFAULT_COUNT
  const countRaw = field('count')
  if (countRaw !== '') {
    const n = /^[+-]?\d+$/.test(countRaw) ? Number(countRaw) : NaN
    if (!Number.isInteger(n) || n < 1 || n > BANK_GEN_MAX_COUNT) throw badRequest('count must be a whole number between 1 and 50')
    count = n
  }
  const difficulty = field('difficulty')
  if (difficulty !== '' && !difficulties.has(difficulty)) throw badRequest('difficulty must be easy, medium or hard')
  const got = form.get('file') as unknown
  if (got === null || typeof got === 'string' || typeof (got as Blob).arrayBuffer !== 'function') throw badRequest('attach a lesson PDF in the `file` field')
  const file = got as Blob
  if (file.size > BANK_GEN_MAX_PDF) throw badRequest('the PDF must be 10MB or smaller')
  if (file.size === 0) throw badRequest('the PDF is empty')
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (String.fromCharCode(...head) !== '%PDF') throw badRequest('that file does not look like a PDF')

  const res = await resolveScope(c)
  if (!(await classSubjectTaught(c, res, csId))) throw notFoundGo()

  const kinds: string[] = []
  for (const part of field('kinds').split(',')) {
    const k = normalizeGenKind(part)
    if (k !== '' && !kinds.includes(k)) kinds.push(k)
  }
  const data = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  let raw: string
  try {
    raw = await callGeminiParts(c, BANK_GEN_SYSTEM, [
      { inlineData: { mimeType: 'application/pdf', data: btoa(bin) } },
      { text: buildBankGenInstruction(count, difficulty, kinds) },
    ], BANK_GEN_MAX_TOKENS, 90_000)
  } catch (e) { throw assistantFailure(e) }
  return ok({ questions: parseGeneratedQuestions(raw), class_subject_id: csId.toLowerCase() })
}

const BANK_GEN_DEFAULT_COUNT = 10
const BANK_GEN_MAX_TOKENS = 8192
const BANK_GEN_SYSTEM = `You are a schoolteacher's assistant that writes exam questions from a lesson.

You are given a lesson or exercise PDF and must propose questions a teacher could
put on a test. The questions must be answerable from the content of the document
and must be at the level the document is pitched at. Do not invent facts that are
not supported by the document.

Return ONLY a JSON array, with no prose, no explanation and no code fences. Each
element is an object of exactly this shape:

  {"text":"", "kind":"mcq|short_answer|long_answer|true_false|fill_blank",
   "difficulty":"easy|medium|hard", "marks":N, "options":["",""], "answer":""}

Rules:
- "text" is the question stem.
- "kind" is one of the five values above, nothing else.
- For "mcq" give at least three plausible "options" and set "answer" to the exact
  text of the correct option.
- For "true_false" give options ["True","False"] and set "answer" to the correct one.
- For "fill_blank" put the missing word or phrase in "answer" and leave "options" empty.
- For "short_answer" and "long_answer" leave "options" empty and put a model answer in "answer".
- "marks" is a small whole number appropriate to the kind (1 for objective, 2-3 for
  short answer, 5 for long answer).
- Output the JSON array and nothing else.`

function buildBankGenInstruction(count: number, difficulty: string, kinds: string[]): string {
  let b = `Read the attached lesson PDF and write ${count} exam questions from it.`
  if (difficulty !== '') b += ` Make them all ${difficulty} difficulty.`
  if (kinds.length > 0) b += ` Use only these kinds: ${kinds.join(', ')}.`
  return b + ' Return ONLY the JSON array described in your instructions.'
}

const defaultMarksForKind = (k: string) => (k === 'short' ? 2 : k === 'long' ? 5 : 1)

/** parseGeneratedQuestions: slice the array out defensively, drop malformed items. */
function parseGeneratedQuestions(rawText: string): GenQuestion[] {
  let t = rawText.trim()
  if (t.startsWith('```')) {
    t = t.slice(3)
    const i = t.indexOf('\n')
    if (i >= 0) t = t.slice(i + 1)
    t = t.trim()
    if (t.endsWith('```')) t = t.slice(0, -3)
    t = t.trim()
  }
  const start = t.indexOf('['), end = t.lastIndexOf(']')
  if (start < 0 || end < 0 || end < start) return []
  let parsed: unknown
  try { parsed = JSON.parse(t.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: GenQuestion[] = []
  for (const it of parsed) {
    // Go's json.Unmarshal into []genQuestion fails the whole array on a wrong-typed field; here such a field reads as empty.
    const q = (it && typeof it === 'object' ? it : {}) as Row
    const text = s(q.text).trim()
    if (text === '') continue
    const kind = normalizeGenKind(s(q.kind))
    if (kind === '') continue
    const diff = difficulties.has(s(q.difficulty)) ? s(q.difficulty) : 'medium'
    let m = typeof q.marks === 'number' ? q.marks : 0
    if (m <= 0 || m > 100) m = defaultMarksForKind(kind)
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => s(o).trim()).filter((o) => o !== '')
    out.push({ text, kind, difficulty: diff, marks: m, options, answer: s(q.answer).trim() })
  }
  return out
}

interface GenQuestion { text: string; kind: string; difficulty: string; marks: number; options: string[]; answer: string }

function matchAnswerIndex(opts: string[], answer: string): number {
  const a = answer.trim()
  if (a === '' || opts.length === 0) return 0
  for (let i = 0; i < opts.length; i++) if (opts[i].trim().toLowerCase() === a.toLowerCase()) return i
  if (a.length === 1) {
    const ch = a.charCodeAt(0)
    if (ch >= 97 && ch <= 122 && ch - 97 < opts.length) return ch - 97
    if (ch >= 65 && ch <= 90 && ch - 65 < opts.length) return ch - 65
    if (ch >= 49 && ch <= 57 && ch - 49 < opts.length) return ch - 49
  }
  return 0
}

function genToBankRequest(csId: string, q: GenQuestion): BankQuestionRequest {
  const req: BankQuestionRequest = {
    class_subject_id: csId, syllabus_unit_id: '', kind: normalizeGenKind(q.kind), difficulty: q.difficulty,
    bloom_level: '', stem: q.text.trim(), default_marks: q.marks, explanation: '', is_active: null, options: [],
  }
  if (req.kind === '') req.kind = q.kind
  const ans = q.answer.trim()
  if (ans !== '') req.explanation = 'Answer: ' + ans
  if (!objectiveKinds.has(req.kind)) return req
  let opts = q.options
  if (req.kind === 'true_false') {
    if (opts.length === 0) opts = ['True', 'False']
  } else if (req.kind === 'fill_blank') {
    if (opts.length === 0) {
      if (ans !== '') req.options = [{ body: ans, is_correct: true }]
      return req
    }
  }
  const correct = matchAnswerIndex(opts, q.answer)
  req.options = opts.map((o, i) => ({ body: o, is_correct: i === correct }))
  return req
}

async function saveGeneratedBankQuestions(c: Ctx): Promise<Response> {
  await assistantRateLimit(c)
  requirePerm(c, HOMEWORK_WRITE)
  const raw = await body(c)
  const csId = s(raw.class_subject_id).trim()
  const questions: GenQuestion[] = arr<Row>(raw.questions).map((q) => {
    if (q === null || typeof q !== 'object') throw badRequest('malformed JSON body')
    return {
      text: s(q.text), kind: s(q.kind), difficulty: s(q.difficulty), marks: f64(q.marks),
      options: arr(q.options).map((o) => { if (typeof o !== 'string') throw badRequest('malformed JSON body'); return o }),
      answer: s(q.answer),
    }
  })
  if (!isUUID(csId)) throw badRequest('class_subject_id must be a uuid')
  if (questions.length === 0) throw badRequest('no questions to save')
  const res = await resolveScope(c)
  if (!(await classSubjectTaught(c, res, csId))) throw notFoundGo()

  const stmts: Stmt[] = []
  let saved = 0
  for (const gq of questions) {
    const bq = genToBankRequest(csId, gq)
    bq.stem = bq.stem.trim()
    if (bq.stem === '') continue
    if (validateBankQuestion(bq, false) !== null) continue
    stmts.push(...insertQuestionStmts(c, uuid(), csId, bq, true))
    saved++
  }
  if (stmts.length) await c.db.batch(stmts)
  return ok({ saved })
}

// ---------------------------------------------------------------------------
// objective online tests

const testStatuses = new Set(['draft', 'published', 'closed'])

function onlineTestJSON(r: Row): Row {
  const o: Row = {
    id: r.id, section_id: r.section_id, section: r.section, class_name: r.class_name,
    class_subject_id: r.class_subject_id, subject: r.subject, title: r.title,
  }
  opt(o, 'instructions', r.instructions)
  opt(o, 'opens_at', r.opens_at)
  opt(o, 'closes_at', r.closes_at)
  opt(o, 'duration_minutes', numOrNull(r.duration_minutes))
  o.max_attempts = Number(r.max_attempts)
  o.shuffle_questions = bool(r.shuffle_questions)
  o.status = r.status
  o.questions = Number(r.questions ?? 0)
  opt(o, 'total_marks', numOrNull(r.total_marks))
  opt(o, 'created_by', r.created_by)
  return o
}

async function listOnlineTests(c: Ctx): Promise<Response> {
  const res = await resolveScope(c)
  let where = '0'
  const args: string[] = []
  if (res.allStudents) where = '1'
  else if (res.sectionIds.length > 0) { where = `t.section_id IN (${marks(res.sectionIds)})`; args.push(js(res.sectionIds)) }
  const status = c.url.searchParams.get('status') ?? ''
  if (status !== '') { args.push(status); where += ' AND t.status = ?' }
  const rs = await c.db.prepare(`
    SELECT t.id, t.section_id, sec.name AS section, c.name AS class_name,
           t.class_subject_id, sub.name AS subject, t.title, t.instructions,
           ${isoSQL('t.opens_at')} AS opens_at, ${isoSQL('t.closes_at')} AS closes_at,
           t.duration_minutes, t.max_attempts, t.shuffle_questions, t.status,
           (SELECT count(*) FROM online_test_questions tq WHERE tq.test_id = t.id) AS questions,
           (SELECT sum(CAST(tq.marks AS REAL)) FROM online_test_questions tq WHERE tq.test_id = t.id) AS total_marks,
           u.full_name AS created_by
      FROM online_tests t
      JOIN sections sec ON sec.id = t.section_id
      JOIN classes    c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.id = t.class_subject_id
      JOIN subjects      sub ON sub.id = cs.subject_id
      LEFT JOIN users u ON u.id = t.created_by
     WHERE ${where}
     ORDER BY COALESCE(t.opens_at, t.created_at) DESC
     LIMIT 200`).bind(...args).all<Row>()
  return items(rs.results.map(onlineTestJSON))
}

async function getOnlineTest(c: Ctx): Promise<Response> {
  const tId = c.params.id
  if (!isUUID(tId)) throw badRequest('invalid test id')
  const res = await resolveScope(c)
  const r = await c.db.prepare(`
    SELECT t.id, t.section_id, sec.name AS section, c.name AS class_name, t.class_subject_id,
           sub.name AS subject, t.title, t.instructions,
           ${isoSQL('t.opens_at')} AS opens_at, ${isoSQL('t.closes_at')} AS closes_at,
           t.duration_minutes, t.max_attempts, t.shuffle_questions, t.status
      FROM online_tests t
      JOIN sections sec ON sec.id = t.section_id
      JOIN classes    c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.id = t.class_subject_id
      JOIN subjects      sub ON sub.id = cs.subject_id
     WHERE t.id = ?`).bind(tId).first<Row>()
  if (!r) throw notFoundGo()
  if (!reachesSection(res, String(r.section_id))) throw notFoundGo()

  const [qs, os] = await c.db.batch([
    c.db.prepare(`
      SELECT tq.question_id, tq.sequence, tq.marks, q.kind, q.difficulty, q.bloom_level, q.stem, su.title AS chapter
        FROM online_test_questions tq
        JOIN question_bank_questions q ON q.id = tq.question_id
        LEFT JOIN syllabus_units su ON su.id = q.syllabus_unit_id
       WHERE tq.test_id = ?
       ORDER BY tq.sequence`).bind(tId),
    c.db.prepare(`
      SELECT o.question_id, o.sequence, o.body, o.is_correct
        FROM question_bank_options o
       WHERE o.question_id IN (SELECT question_id FROM online_test_questions WHERE test_id = ?)
       ORDER BY o.question_id, o.sequence`).bind(tId),
  ])
  const keys = new Map<string, Row[]>()
  for (const o of os.results as Row[]) {
    const k = String(o.question_id)
    if (!keys.has(k)) keys.set(k, [])
    keys.get(k)!.push({ sequence: Number(o.sequence), body: o.body, is_correct: bool(o.is_correct) })
  }
  let total = 0
  const paper = (qs.results as Row[]).map((q) => {
    const m = Number(q.marks)
    total += m
    const o: Row = {
      question_id: q.question_id, sequence: Number(q.sequence), marks: m, kind: q.kind,
      difficulty: q.difficulty, bloom_level: q.bloom_level, stem: q.stem,
    }
    opt(o, 'chapter', q.chapter)
    o.answer_key = keys.get(String(q.question_id)) ?? []
    return o
  })
  const out = onlineTestJSON({ ...r, questions: paper.length, total_marks: total, created_by: null })
  out.paper = paper
  return ok(out)
}

interface OnlineTestRequest {
  section_id: string; class_subject_id: string; title: string; instructions: string
  opens_at: string; closes_at: string; duration_minutes: number; max_attempts: number
  shuffle_questions: boolean | null; status: string
}
function decodeTestRequest(raw: Row): OnlineTestRequest {
  return {
    section_id: s(raw.section_id), class_subject_id: s(raw.class_subject_id), title: s(raw.title),
    instructions: s(raw.instructions), opens_at: s(raw.opens_at), closes_at: s(raw.closes_at),
    duration_minutes: i64(raw.duration_minutes), max_attempts: i64(raw.max_attempts),
    shuffle_questions: optBool(raw.shuffle_questions), status: s(raw.status),
  }
}

/** The online_tests_window CHECK constraint (not carried into the SQLite schema). */
function checkWindow(opens: string | null, closes: string | null): void {
  if (opens && closes && !(Date.parse(closes) > Date.parse(opens))) throw badRequest('closes_at must be after opens_at')
}

async function createOnlineTest(c: Ctx): Promise<Response> {
  requirePerm(c, HOMEWORK_WRITE)
  const req = decodeTestRequest(await body(c))
  if (!isUUID(req.section_id)) throw badRequest('section_id must be a uuid')
  if (!isUUID(req.class_subject_id)) throw badRequest('class_subject_id must be a uuid')
  req.title = req.title.trim()
  if (req.title === '') throw badRequest('title is required')
  if (req.max_attempts <= 0) req.max_attempts = 1
  const res = await resolveScope(c)
  if (!reachesSection(res, req.section_id)) throw forbid('setting a test for this section')
  if (!(await classSubjectTaught(c, res, req.class_subject_id))) throw forbid('setting a test for this subject')
  const opens = ts(req.opens_at, 'opens_at')
  const closes = ts(req.closes_at, 'closes_at')
  checkWindow(opens, closes)
  const newId = uuid()
  const t = now()
  await c.db.prepare(`INSERT INTO online_tests (id, institution_id, section_id, class_subject_id, title, instructions,
      opens_at, closes_at, duration_minutes, max_attempts, shuffle_questions, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,NULLIF(?,''),?,?,?,?,?,'draft',?,?,?)`)
    .bind(newId, institutionId(c), req.section_id, req.class_subject_id, req.title, req.instructions, opens, closes,
      nullPositiveInt(req.duration_minutes), req.max_attempts, req.shuffle_questions ? 1 : 0, c.id.userId, t, t).run()
  return ok({ id: newId, status: 'draft' })
}

async function updateOnlineTest(c: Ctx): Promise<Response> {
  requirePerm(c, HOMEWORK_WRITE)
  const tId = c.params.id
  if (!isUUID(tId)) throw badRequest('invalid test id')
  const req = decodeTestRequest(await body(c))
  if (req.status !== '' && !testStatuses.has(req.status)) throw badRequest('status must be draft, published or closed')
  const res = await resolveScope(c)
  const cur = await c.db.prepare(`SELECT section_id, opens_at, closes_at FROM online_tests WHERE id = ?`)
    .bind(tId).first<{ section_id: string; opens_at: string | null; closes_at: string | null }>()
  if (!cur) throw notFoundGo()
  if (!reachesSection(res, cur.section_id)) throw notFoundGo()
  if (req.status === 'published') {
    const n = await c.db.prepare(`SELECT count(*) AS n FROM online_test_questions WHERE test_id = ?`).bind(tId).first<{ n: number }>()
    if (!n || Number(n.n) === 0) throw badRequest('add at least one question before publishing this test')
  }
  const opens = ts(req.opens_at, 'opens_at')
  const closes = ts(req.closes_at, 'closes_at')
  checkWindow(opens ?? cur.opens_at, closes ?? cur.closes_at)
  const t = now()
  await c.db.prepare(`
    UPDATE online_tests
       SET title             = COALESCE(NULLIF(?,''), title),
           instructions      = COALESCE(NULLIF(?,''), instructions),
           opens_at          = COALESCE(?, opens_at),
           closes_at         = COALESCE(?, closes_at),
           duration_minutes  = COALESCE(?, duration_minutes),
           max_attempts      = COALESCE(?, max_attempts),
           shuffle_questions = COALESCE(?, shuffle_questions),
           status            = COALESCE(NULLIF(?,''), status),
           published_at      = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
           updated_at        = ?
     WHERE id = ?`).bind(req.title.trim(), req.instructions, opens, closes, nullPositiveInt(req.duration_minutes),
      nullPositiveInt(req.max_attempts), req.shuffle_questions === null ? null : req.shuffle_questions ? 1 : 0,
      req.status, req.status, t, t, tId).run()
  return ok({ id: tId })
}

async function setOnlineTestQuestions(c: Ctx): Promise<Response> {
  requirePerm(c, HOMEWORK_WRITE)
  const tId = c.params.id
  if (!isUUID(tId)) throw badRequest('invalid test id')
  const raw = await body(c)
  const wanted = arr<Row>(raw.questions).map((q) => {
    if (q === null || typeof q !== 'object') throw badRequest('malformed JSON body')
    return { question_id: s(q.question_id), marks: optF64(q.marks) }
  })
  const res = await resolveScope(c)
  const cur = await c.db.prepare(`SELECT section_id FROM online_tests WHERE id = ?`).bind(tId).first<{ section_id: string }>()
  if (!cur) throw notFoundGo()
  if (!reachesSection(res, cur.section_id)) throw notFoundGo()

  // Every check runs before the first write, so a refusal leaves the old paper
  // in place exactly as the Go transaction's rollback did.
  const stmts: Stmt[] = [c.db.prepare(`DELETE FROM online_test_questions WHERE test_id = ?`).bind(tId)]
  let placed = 0
  let total = 0
  for (let i = 0; i < wanted.length; i++) {
    const q = wanted[i]
    if (!isUUID(q.question_id)) throw badRequest('question_id must be a uuid')
    const bq = await c.db.prepare(`SELECT class_subject_id, kind, default_marks FROM question_bank_questions
        WHERE id = ? AND is_active = 1`).bind(q.question_id).first<{ class_subject_id: string; kind: string; default_marks: unknown }>()
    if (!bq) throw notFoundGo()
    if (!(await classSubjectTaught(c, res, bq.class_subject_id))) throw notFoundGo()
    if (!objectiveKinds.has(bq.kind)) {
      throw badRequest('only mcq, true_false and fill_blank questions can be auto-graded - a short or long answer cannot go on an objective test')
    }
    const m = q.marks !== null && q.marks > 0 ? q.marks : Number(bq.default_marks)
    stmts.push(c.db.prepare(`INSERT INTO online_test_questions (id, institution_id, test_id, question_id, sequence, marks)
        VALUES (?,?,?,?,?,?)`).bind(uuid(), institutionId(c), tId, q.question_id, i + 1, String(m)))
    placed++
    total += m
  }
  stmts.push(c.db.prepare(`UPDATE online_tests SET updated_at = ? WHERE id = ?`).bind(now(), tId))
  await c.db.batch(stmts)
  return ok({ questions: placed, total_marks: total })
}

// ---------------------------------------------------------------------------
// CCE: the formative half

const formativeCycles = new Set(['FA1', 'FA2', 'FA3', 'FA4'])
const formativeIndicators = new Set(['excellent', 'good', 'satisfactory', 'needs_support'])

/** resolveCCETarget: null when the caller teaches nothing (errNoTeaching). */
async function resolveCCETarget(c: Ctx, res: Scope, csParam: string, secParam: string): Promise<{ csId: string; secId: string } | null> {
  let csId = ''
  let secId = ''
  if (csParam !== '') {
    if (!isUUID(csParam)) throw badRequest('class_subject_id must be a uuid')
    csId = csParam
  }
  if (secParam !== '') {
    if (!isUUID(secParam)) throw badRequest('section_id must be a uuid')
    if (!reachesSection(res, secParam)) throw forbid('assessment for this class')
    secId = secParam
  }
  if (csId !== '' && !(await classSubjectTaught(c, res, csId))) throw forbid('assessment for this class')
  if (csId !== '' && secId !== '') return { csId, secId }

  const p = taughtSubjectsPredicate(res, 'cs')
  const args: string[] = [...p.args]
  let sql = `SELECT cs.id AS cs_id, sec.id AS sec_id
      FROM class_subjects cs
      JOIN classes  c   ON c.id = cs.class_id
      JOIN subjects sub ON sub.id = cs.subject_id
      JOIN sections sec ON sec.class_id = cs.class_id
     WHERE ${p.sql}`
  if (csId !== '') { args.push(csId); sql += ' AND cs.id = ?' }
  if (secId !== '') { args.push(secId); sql += ' AND sec.id = ?' }
  else if (!res.allStudents && res.sectionIds.length > 0) { args.push(js(res.sectionIds)); sql += ` AND sec.id IN (${marks(res.sectionIds)})` }
  sql += ' ORDER BY c.level, sub.name, sec.name LIMIT 1'
  const r = await c.db.prepare(sql).bind(...args).first<{ cs_id: string; sec_id: string }>()
  if (!r) return null
  return { csId: r.cs_id, secId: r.sec_id }
}

async function listFormativeEntries(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  const cycle = q.get('cycle') || 'FA1'
  if (!formativeCycles.has(cycle)) throw badRequest('cycle must be FA1, FA2, FA3 or FA4')
  const res = await resolveScope(c)
  const target = await resolveCCETarget(c, res, q.get('class_subject_id') ?? '', q.get('section_id') ?? '')
  if (!target) return items([])
  let termId: string | null = null
  const tv = q.get('term_id') ?? ''
  if (tv !== '') {
    if (!isUUID(tv)) throw badRequest('term_id must be a uuid')
    termId = tv
  }
  const rs = await c.db.prepare(`
    SELECT st.id AS student_id, st.admission_no, ${shortName('st')} AS full_name, e.roll_no,
           f.id AS entry_id, f.written_work, f.project_work, f.slip_test, f.participation,
           COALESCE(f.component_max, 5) AS component_max, f.observation, f.indicator,
           u.full_name AS recorded_by, ${isoSQL('f.recorded_at')} AS recorded_at
      FROM enrollments e
      JOIN students st ON st.id = e.student_id
      LEFT JOIN cce_formative_entries f
             ON f.student_id = st.id AND f.class_subject_id = ? AND f.cycle = ?
            AND COALESCE(f.term_id, '') = COALESCE(?, '')
      LEFT JOIN users u ON u.id = f.recorded_by
     WHERE e.section_id = ? AND e.status = 'active'
     ORDER BY e.roll_no IS NULL, e.roll_no, st.first_name`).bind(target.csId, cycle, termId, target.secId).all<Row>()
  return items(rs.results.map((r) => {
    const o: Row = { student_id: r.student_id, admission_no: r.admission_no, full_name: r.full_name }
    opt(o, 'roll_no', numOrNull(r.roll_no))
    opt(o, 'entry_id', r.entry_id)
    const comps = [numOrNull(r.written_work), numOrNull(r.project_work), numOrNull(r.slip_test), numOrNull(r.participation)]
    opt(o, 'written_work', comps[0])
    opt(o, 'project_work', comps[1])
    opt(o, 'slip_test', comps[2])
    opt(o, 'participation', comps[3])
    const cm = Number(r.component_max)
    o.component_max = cm
    const entered = comps.filter((x): x is number => x !== null)
    if (entered.length) o.total = entered.reduce((a, x) => a + x, 0)
    o.max_total = cm * 4
    opt(o, 'observation', r.observation)
    opt(o, 'indicator', r.indicator)
    opt(o, 'recorded_by', r.recorded_by)
    opt(o, 'recorded_at', r.recorded_at)
    return o
  }))
}

async function saveFormativeEntries(c: Ctx): Promise<Response> {
  requirePerm(c, MARKS_WRITE)
  const raw = await body(c)
  const cycle = s(raw.cycle)
  const csId = s(raw.class_subject_id)
  const termId = nullUUID(s(raw.term_id))
  let componentMax = f64(raw.component_max)
  const entries = arr<Row>(raw.entries).map((e) => {
    if (e === null || typeof e !== 'object') throw badRequest('malformed JSON body')
    return {
      student_id: s(e.student_id), written: optF64(e.written_work), project: optF64(e.project_work),
      slip: optF64(e.slip_test), participation: optF64(e.participation),
      observation: s(e.observation), indicator: s(e.indicator),
    }
  })
  if (!formativeCycles.has(cycle)) throw badRequest('cycle must be FA1, FA2, FA3 or FA4')
  if (!isUUID(csId)) throw badRequest('class_subject_id must be a uuid')
  if (entries.length === 0) throw badRequest('entries must not be empty')
  if (componentMax <= 0) componentMax = 5
  const res = await resolveScope(c)
  if (!(await classSubjectTaught(c, res, csId))) throw forbid('recording assessment for this child')

  const inst = institutionId(c)
  const stmts: Stmt[] = []
  for (const e of entries) {
    if (!isUUID(e.student_id)) throw badRequest('student_id must be a uuid')
    if (!(await reachesTaughtStudent(c, res, e.student_id))) throw forbid('recording assessment for this child')
    for (const v of [e.written, e.project, e.slip, e.participation]) {
      if (v !== null && (v < 0 || v > componentMax)) throw badRequest('each component must be between zero and component_max')
    }
    if (e.indicator !== '' && !formativeIndicators.has(e.indicator)) {
      throw badRequest('indicator must be excellent, good, satisfactory or needs_support')
    }
    // ON CONFLICT (student, class_subject, cycle, COALESCE(term_id, nil)) as an
    // update-then-insert-if-absent pair: the expression index is not in SQLite.
    const t = now()
    const vals = [numStr(e.written), numStr(e.project), numStr(e.slip), numStr(e.participation), String(componentMax)]
    const obs = e.observation === '' ? null : e.observation
    const ind = e.indicator === '' ? null : e.indicator
    stmts.push(c.db.prepare(`UPDATE cce_formative_entries
        SET written_work = ?, project_work = ?, slip_test = ?, participation = ?, component_max = ?,
            observation = ?, indicator = ?, recorded_by = ?, updated_at = ?
      WHERE student_id = ? AND class_subject_id = ? AND cycle = ? AND COALESCE(term_id, '') = COALESCE(?, '')`)
      .bind(...vals, obs, ind, c.id.userId, t, e.student_id, csId, cycle, termId))
    stmts.push(c.db.prepare(`INSERT INTO cce_formative_entries (id, institution_id, student_id, class_subject_id, term_id, cycle,
        written_work, project_work, slip_test, participation, component_max, observation, indicator, recorded_by, recorded_at, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
       WHERE NOT EXISTS (SELECT 1 FROM cce_formative_entries WHERE student_id = ? AND class_subject_id = ? AND cycle = ?
                           AND COALESCE(term_id, '') = COALESCE(?, ''))`)
      .bind(uuid(), inst, e.student_id, csId, termId, cycle, ...vals, obs, ind, c.id.userId, t, t,
        e.student_id, csId, cycle, termId))
  }
  await c.db.batch(stmts)
  return ok({ saved: entries.length, cycle })
}

// ---------------------------------------------------------------------------
// CCE: the summative half

const SUMMATIVE_KINDS = `('summative','term','unit_test','periodic')`

async function listSummativePapers(c: Ctx): Promise<Response> {
  const res = await resolveScope(c)
  const p = taughtSubjectsPredicate(res, 'cs')
  let where = p.sql
  const args: string[] = [...p.args]
  const kind = c.url.searchParams.get('kind') ?? ''
  if (kind !== '') { args.push(kind); where += ' AND e.kind = ?' }
  else where += ` AND e.kind IN ${SUMMATIVE_KINDS}`
  const rs = await c.db.prepare(`
    SELECT es.id AS exam_subject_id, e.id AS exam_id, e.name AS exam_name, e.kind, c.name AS class_name, sub.name AS subject,
           substr(es.exam_date, 1, 10) AS exam_date, es.max_marks, es.pass_marks,
           (SELECT count(*) FROM marks m WHERE m.exam_subject_id = es.id) AS entered,
           (SELECT count(*) FROM enrollments en JOIN sections s2 ON s2.id = en.section_id
             WHERE s2.class_id = cs.class_id AND en.status = 'active') AS roll,
           e.is_published,
           (SELECT avg(CAST(m.marks_obtained AS REAL)) FROM marks m WHERE m.exam_subject_id = es.id AND m.is_absent = 0) AS average
      FROM exam_subjects es
      JOIN exams          e ON e.id = es.exam_id
      JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN classes         c ON c.id = cs.class_id
      JOIN subjects      sub ON sub.id = cs.subject_id
     WHERE ${where}
     ORDER BY es.exam_date IS NULL, es.exam_date DESC, c.level, sub.name
     LIMIT 200`).bind(...args).all<Row>()
  return items(rs.results.map((r) => {
    const o: Row = {
      exam_subject_id: r.exam_subject_id, exam_id: r.exam_id, exam_name: r.exam_name, kind: r.kind,
      class_name: r.class_name, subject: r.subject,
    }
    opt(o, 'exam_date', r.exam_date)
    o.max_marks = Number(r.max_marks)
    o.pass_marks = Number(r.pass_marks)
    o.entered = Number(r.entered ?? 0)
    o.roll = Number(r.roll ?? 0)
    o.is_published = bool(r.is_published)
    opt(o, 'average', numOrNull(r.average))
    return o
  }))
}

async function listSummativeRoster(c: Ctx): Promise<Response> {
  let esId = (c.url.searchParams.get('exam_subject_id') ?? '').trim()
  if (esId !== '' && !isUUID(esId)) throw badRequest('exam_subject_id must be a uuid')
  const res = await resolveScope(c)
  if (esId === '') {
    const p = taughtSubjectsPredicate(res, 'cs')
    const first = await c.db.prepare(`
      SELECT es.id FROM exam_subjects es
        JOIN exams          e ON e.id = es.exam_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
       WHERE ${p.sql} AND e.kind IN ${SUMMATIVE_KINDS}
       ORDER BY es.exam_date IS NULL, es.exam_date DESC
       LIMIT 1`).bind(...p.args).first<{ id: string }>()
    if (!first) return items([])
    esId = first.id
  }
  const es = await c.db.prepare(`SELECT class_subject_id FROM exam_subjects WHERE id = ?`).bind(esId).first<{ class_subject_id: string }>()
  if (!es) throw notFoundGo()
  const csId = es.class_subject_id
  if (!(await classSubjectTaught(c, res, csId))) throw notFoundGo()

  const w = taughtStudentsPredicate(res, 'st.id')
  const rs = await c.db.prepare(`
    SELECT st.id AS student_id, st.admission_no, ${shortName('st')} AS full_name, e.roll_no,
           m.marks_obtained, m.grade, COALESCE(m.is_absent, 0) AS is_absent, m.remarks, u.full_name AS entered_by
      FROM enrollments e
      JOIN students st ON st.id = e.student_id
      JOIN sections sec ON sec.id = e.section_id
      JOIN class_subjects cs ON cs.id = ?
      LEFT JOIN marks m ON m.exam_subject_id = ? AND m.student_id = st.id
      LEFT JOIN users u ON u.id = m.entered_by
     WHERE e.status = 'active' AND sec.class_id = cs.class_id AND ${w.sql}
     ORDER BY e.roll_no IS NULL, e.roll_no, st.first_name`).bind(csId, esId, ...w.args).all<Row>()
  return items(rs.results.map((r) => {
    const o: Row = { student_id: r.student_id, admission_no: r.admission_no, full_name: r.full_name }
    opt(o, 'roll_no', numOrNull(r.roll_no))
    opt(o, 'marks_obtained', numOrNull(r.marks_obtained))
    opt(o, 'grade', r.grade)
    o.is_absent = bool(r.is_absent)
    opt(o, 'remarks', r.remarks)
    opt(o, 'entered_by', r.entered_by)
    return o
  }))
}

async function saveSummativeMarks(c: Ctx): Promise<Response> {
  requirePerm(c, MARKS_WRITE)
  const raw = await body(c)
  const esId = s(raw.exam_subject_id)
  const entries = arr<Row>(raw.entries).map((e) => {
    if (e === null || typeof e !== 'object') throw badRequest('malformed JSON body')
    return { student_id: s(e.student_id), marks: optF64(e.marks_obtained), is_absent: b(e.is_absent), remarks: s(e.remarks) }
  })
  if (!isUUID(esId)) throw badRequest('exam_subject_id must be a uuid')
  if (entries.length === 0) throw badRequest('entries must not be empty')
  const res = await resolveScope(c)

  const paper = await c.db.prepare(`
    SELECT es.class_subject_id, es.max_marks, COALESCE(sub.name, '') AS subject,
           e.grading_scale_id, e.academic_year_id
      FROM exam_subjects es
      JOIN exams e ON e.id = es.exam_id
      LEFT JOIN class_subjects cs ON cs.id = es.class_subject_id
      LEFT JOIN subjects sub ON sub.id = cs.subject_id
     WHERE es.id = ?`).bind(esId).first<{ class_subject_id: string; max_marks: unknown; subject: string; grading_scale_id: string | null; academic_year_id: string }>()
  if (!paper) throw notFoundGo()
  const maxMarks = Number(paper.max_marks)
  // requireOpenYear
  const year = await c.db.prepare(`SELECT name, closed_at IS NOT NULL AS closed FROM academic_years WHERE id = ?`)
    .bind(paper.academic_year_id).first<{ name: string; closed: number }>()
  if (year && year.closed) throw new HttpError(409, 'The year ' + year.name + ' is closed; ask the principal to reopen it')
  if (!(await classSubjectTaught(c, res, paper.class_subject_id))) throw forbid('entering marks for this class')

  const [bandsRs, graceRs] = await c.db.batch([
    c.db.prepare(`SELECT grade, min_percent, max_percent FROM grade_bands WHERE grading_scale_id = ?`).bind(paper.grading_scale_id),
    c.db.prepare(`SELECT student_id, grace_marks FROM marks WHERE exam_subject_id = ?`).bind(esId),
  ])
  const bands = bandsRs.results as { grade: string; min_percent: unknown; max_percent: unknown }[]
  const grace = new Map((graceRs.results as { student_id: string; grace_marks: unknown }[]).map((g) => [g.student_id, Number(g.grace_marks ?? 0)]))

  const inst = institutionId(c)
  const stmts: Stmt[] = []
  for (const e of entries) {
    if (!isUUID(e.student_id)) throw badRequest('student_id must be a uuid')
    if (!(await reachesTaughtStudent(c, res, e.student_id))) throw forbid('entering marks for this class')
    // validateMark
    if (e.marks !== null) {
      const paperName = paper.subject !== '' ? paper.subject : 'this paper'
      if (e.marks < 0) throw badRequest(`${trimFloat(e.marks)} is not a mark: ${paperName} cannot be scored below zero`)
      if (maxMarks > 0 && e.marks > maxMarks) {
        throw badRequest(`${trimFloat(e.marks)} is above the maximum for ${paperName}: that paper is out of ${trimFloat(maxMarks)}`)
      }
      // marks_ceiling trigger: the existing grace marks count toward the ceiling.
      const total = e.marks + (grace.get(e.student_id) ?? 0)
      if (maxMarks > 0 && total > maxMarks) {
        throw badRequest(`${trimFloat(total)} is above the maximum for ${paper.subject || 'this paper'}: that paper is out of ${trimFloat(maxMarks)}`)
      }
    }
    let grade: string | null = null
    if (e.marks !== null && !e.is_absent && paper.grading_scale_id && maxMarks > 0) {
      const pct = (e.marks / maxMarks) * 100
      const band = bands.find((bd) => pct >= Number(bd.min_percent) && pct <= Number(bd.max_percent))
      if (band) grade = band.grade
    }
    const t = now()
    stmts.push(c.db.prepare(`INSERT INTO marks (id, institution_id, exam_subject_id, student_id, marks_obtained, grade,
        is_absent, remarks, entered_by, entered_at)
      VALUES (?,?,?,?,?,?,?,NULLIF(?,''),?,?)
      ON CONFLICT (exam_subject_id, student_id) DO UPDATE
         SET marks_obtained = excluded.marks_obtained,
             grade          = excluded.grade,
             is_absent      = excluded.is_absent,
             remarks        = excluded.remarks,
             entered_by     = excluded.entered_by,
             entered_at     = excluded.entered_at`)
      .bind(uuid(), inst, esId, e.student_id, numStr(e.marks), grade, e.is_absent ? 1 : 0, e.remarks, c.id.userId, t))
  }
  await c.db.batch(stmts)
  return ok({ saved: entries.length })
}

// ---------------------------------------------------------------------------

export function registerAssessment(r: Router): void {
  // question bank: literal paths before {id}
  r.get('/teaching/question-bank', GROUP, listBankQuestions)
  r.get('/teaching/question-bank/summary', GROUP, getBankSummary)
  r.post('/teaching/question-bank/compose', GROUP, composePaper)
  r.post('/teaching/question-bank/generate', GROUP, generateBankQuestions)
  r.post('/teaching/question-bank/generate/save', GROUP, saveGeneratedBankQuestions)
  r.get('/teaching/question-bank/{id}', GROUP, getBankQuestion)
  r.post('/teaching/question-bank', GROUP, createBankQuestion)
  r.put('/teaching/question-bank/{id}', GROUP, updateBankQuestion)
  r.del('/teaching/question-bank/{id}', GROUP, retireBankQuestion)

  // online tests
  r.get('/teaching/online-tests', GROUP, listOnlineTests)
  r.post('/teaching/online-tests', GROUP, createOnlineTest)
  r.put('/teaching/online-tests/{id}/questions', GROUP, setOnlineTestQuestions)
  r.get('/teaching/online-tests/{id}', GROUP, getOnlineTest)
  r.put('/teaching/online-tests/{id}', GROUP, updateOnlineTest)

  // CCE
  r.get('/teaching/cce/formative', GROUP, listFormativeEntries)
  r.put('/teaching/cce/formative', GROUP, saveFormativeEntries)
  r.get('/teaching/cce/summative/roster', GROUP, listSummativeRoster)
  r.get('/teaching/cce/summative', GROUP, listSummativePapers)
  r.put('/teaching/cce/summative', GROUP, saveSummativeMarks)
}
