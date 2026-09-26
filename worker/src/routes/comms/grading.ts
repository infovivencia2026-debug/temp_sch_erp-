import type { Router, Ctx } from '../../router'
import { badRequest, isUUID, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { institutionId, requirePerm, resolveScope } from '../teaching/common'
import { bodyUUID, firstLast, omitNull, optInt, optStr, round2, uuidArray } from './common'
import { denied, inJSON, pathUUID, reachesSection } from './classroom_common'

/* Port of classroom.go part 5: no-OMR grading. A teacher keys a paper script
   in, gradeAttempt marks it the same way a portal attempt is marked, and the
   item analysis reads the graded responses back. uuid[] columns
   (selected_option_ids) are JSON text. */

const OPEN = 'academics.timetable.read'
const HOMEWORK = 'academics.homework.write'

interface Option { id: string; sequence: number; body: string; is_correct: boolean }
interface Question { tq: string; qid: string; sequence: number; kind: string; stem: string; marks: number; negative: number; options: Option[] }
interface Given { selected: string[]; text: string | null }

const correctIDs = (q: Question) => new Set(q.options.filter((o) => o.is_correct).map((o) => o.id))

/** gradingTestSection: the test's section, refused when outside the caller's reach. */
async function testSection(c: Ctx, testId: string): Promise<string> {
  const r = await c.db.prepare(`SELECT section_id FROM online_tests WHERE id = ?`).bind(testId).first<{ section_id: string }>()
  if (!r) throw notFound()
  const s = await resolveScope(c)
  if (!reachesSection(s, r.section_id)) throw denied()
  return r.section_id
}

async function loadQuestions(c: Ctx, testId: string): Promise<Question[]> {
  const [qs, opts] = await c.db.batch([
    c.db.prepare(`SELECT tq.id AS tq, q.id AS qid, tq.sequence, q.kind, q.stem, CAST(tq.marks AS REAL) AS marks,
          CAST(tq.negative_marks AS REAL) AS negative
        FROM online_test_questions tq JOIN question_bank_questions q ON q.id = tq.question_id
        WHERE tq.test_id = ? ORDER BY tq.sequence`).bind(testId),
    c.db.prepare(`SELECT o.question_id, o.id, o.sequence, o.body, o.is_correct
        FROM question_bank_options o JOIN online_test_questions tq ON tq.question_id = o.question_id
        WHERE tq.test_id = ? ORDER BY o.sequence`).bind(testId),
  ])
  const out: Question[] = (qs.results as Record<string, unknown>[]).map((v) => ({ tq: String(v.tq), qid: String(v.qid),
    sequence: Number(v.sequence), kind: String(v.kind), stem: String(v.stem), marks: Number(v.marks ?? 0), negative: Number(v.negative ?? 0), options: [] }))
  const byQ = new Map<string, Question[]>()
  for (const q of out) byQ.set(q.qid, [...(byQ.get(q.qid) ?? []), q])
  for (const o of opts.results as Record<string, unknown>[]) {
    for (const q of byQ.get(String(o.question_id)) ?? []) {
      q.options.push({ id: String(o.id), sequence: Number(o.sequence), body: String(o.body), is_correct: bool(o.is_correct) })
    }
  }
  return out
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).join(' ').toLowerCase()

/** gradeAttempt: marks one sitting from its answers; returns the sheet and the statements that write it back. */
function gradeAttempt(c: Ctx, attemptId: string, questions: Question[], partial: boolean, answers: Map<string, Given>, grader: string) {
  const sheet = { attempt_id: attemptId, score: 0, max_score: 0, correct: 0, wrong: 0, unattempted: 0 }
  const stmts: D1PreparedStatement[] = []
  let score = 0, max = 0
  for (const q of questions) {
    if (q.kind === 'long') continue
    max += q.marks
    const g = answers.get(q.tq)
    const attempted = !!g && (g.selected.length > 0 || (g.text !== null && g.text.trim() !== ''))
    if (!attempted) {
      sheet.unattempted++
      if (g) {
        stmts.push(c.db.prepare(`UPDATE online_test_responses SET is_correct = NULL, marks_awarded = 0 WHERE attempt_id = ? AND test_question_id = ?`)
          .bind(attemptId, q.tq))
      }
      continue
    }
    const correct = correctIDs(q)
    let awarded = 0, right = false
    if (g!.selected.length > 0) {
      let hits = 0, misses = 0
      const seen = new Set<string>()
      for (const sel of g!.selected) {
        if (seen.has(sel)) continue
        seen.add(sel)
        if (correct.has(sel)) hits++; else misses++
      }
      right = misses === 0 && hits === correct.size && hits > 0
      if (right) awarded = q.marks
      else if (partial && correct.size > 0) {
        const net = Math.max(0, (hits - misses) / correct.size)
        awarded = q.marks * net
        if (awarded === 0) awarded = -q.negative
      } else awarded = -q.negative
    } else {
      const typed = words(g!.text!)
      right = q.options.some((o) => o.is_correct && words(o.body) === typed)
      awarded = right ? q.marks : -q.negative
    }
    if (right) sheet.correct++; else sheet.wrong++
    score += awarded
    stmts.push(c.db.prepare(`UPDATE online_test_responses SET is_correct = ?, marks_awarded = ? WHERE attempt_id = ? AND test_question_id = ?`)
      .bind(right ? 1 : 0, awarded, attemptId, q.tq))
  }
  if (score < 0) score = 0
  sheet.score = round2(score); sheet.max_score = round2(max)
  const t = now()
  stmts.push(c.db.prepare(`UPDATE online_test_attempts SET score = ?, max_score = ?, status = 'graded', graded_at = ?, graded_by = ?, updated_at = ?
      WHERE id = ?`).bind(sheet.score, sheet.max_score, t, grader, t, attemptId))
  return { sheet, stmts }
}

async function partialCreditOf(c: Ctx, testId: string): Promise<boolean> {
  const r = await c.db.prepare(`SELECT allow_partial_credit FROM online_tests WHERE id = ?`).bind(testId).first<{ allow_partial_credit: number }>()
  return bool(r?.allow_partial_credit)
}

async function listGradableTests(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  let where = '1'
  const args: unknown[] = []
  if (!s.allStudents) {
    if (!s.sectionIds.length) return ok({ items: [] })
    const q = inJSON('t.section_id', s.sectionIds)
    where = q.sql; args.push(q.arg)
  }
  const rows = await c.db.prepare(`SELECT t.id, t.title, t.section_id, COALESCE(sec.name, '-') AS section_name, sub.name AS subject_name, t.status,
        (SELECT count(*) FROM online_test_questions tq WHERE tq.test_id = t.id) AS question_count,
        (SELECT COALESCE(sum(CAST(tq.marks AS REAL)), 0) FROM online_test_questions tq WHERE tq.test_id = t.id) AS max_score,
        (SELECT count(*) FROM enrollments e WHERE e.section_id = t.section_id AND e.status = 'active') AS roll_strength,
        (SELECT count(*) FROM online_test_attempts a WHERE a.test_id = t.id AND a.status = 'graded') AS graded_attempts,
        t.allow_partial_credit
      FROM online_tests t
      LEFT JOIN sections sec ON sec.id = t.section_id
      JOIN class_subjects cs ON cs.id = t.class_subject_id
      JOIN subjects sub ON sub.id = cs.subject_id
      WHERE ${where}
      ORDER BY t.created_at DESC LIMIT 200`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => ({ id: v.id, title: v.title, section_id: v.section_id, section_name: v.section_name,
    subject_name: v.subject_name, status: v.status, question_count: Number(v.question_count ?? 0), max_score: Number(v.max_score ?? 0),
    roll_strength: Number(v.roll_strength ?? 0), graded_attempts: Number(v.graded_attempts ?? 0), allow_partial_credit: bool(v.allow_partial_credit) })) })
}

async function getGradingKey(c: Ctx): Promise<Response> {
  const testId = pathUUID(c, 'id')
  const sectionId = await testSection(c, testId)
  const t = await c.db.prepare(`SELECT title, allow_partial_credit FROM online_tests WHERE id = ?`).bind(testId)
    .first<{ title: string; allow_partial_credit: number }>()
  if (!t) throw notFound()
  const qs = await loadQuestions(c, testId)
  const roster = await c.db.prepare(`SELECT st.id AS student_id, st.admission_no, ${firstLast('st')} AS student_name,
        a.id AS attempt_id, a.status AS attempt_status, CAST(a.score AS REAL) AS score
      FROM students st
      JOIN enrollments e ON e.student_id = st.id AND e.status = 'active' AND e.section_id = ?
      LEFT JOIN (SELECT id, student_id, status, score,
                        ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY attempt_no DESC) AS rn
                   FROM online_test_attempts WHERE test_id = ? AND status <> 'void') a
             ON a.student_id = st.id AND a.rn = 1
      ORDER BY st.admission_no`).bind(sectionId, testId).all<Record<string, unknown>>()
  return ok({
    test_id: testId, title: t.title, max_score: qs.reduce((p, q) => p + q.marks, 0), allow_partial_credit: bool(t.allow_partial_credit),
    questions: qs.map((q) => ({ test_question_id: q.tq, sequence: q.sequence, kind: q.kind, stem: q.stem, marks: q.marks,
      negative_marks: q.negative, multi_answer: correctIDs(q).size > 1,
      options: q.options.map((o) => ({ id: o.id, sequence: o.sequence, body: o.body, is_correct: o.is_correct })) })),
    roster: roster.results.map((v) => omitNull({ ...v })),
  })
}

async function enterAnswerSheet(c: Ctx): Promise<Response> {
  requirePerm(c, HOMEWORK)
  const testId = pathUUID(c, 'id')
  const req = await readJSON<Record<string, unknown>>(c.req)
  const studentId = bodyUUID(req.student_id)
  const responses = (Array.isArray(req.responses) ? (req.responses as Record<string, unknown>[]) : []).map((r) => {
    const sel = r?.selected_option_ids
    if (sel !== undefined && sel !== null && (!Array.isArray(sel) || sel.some((x) => typeof x !== 'string' || !isUUID(x)))) throw badRequest('malformed JSON body')
    return { tq: bodyUUID(r?.test_question_id), selected: (Array.isArray(sel) ? sel : []) as string[], text: optStr(r?.text_response) }
  })
  if (studentId === '') throw badRequest('an answer sheet needs a student')
  const sectionId = await testSection(c, testId)
  const enrolled = await c.db.prepare(`SELECT 1 AS x FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' AND e.section_id = ? LIMIT 1`)
    .bind(studentId, sectionId).first()
  if (!enrolled) throw badRequest('that child does not sit in the section this test was set for')
  const questions = await loadQuestions(c, testId)
  if (!questions.length) throw badRequest('that paper has no questions on it yet')
  const onPaper = new Set(questions.map((q) => q.tq))
  for (const r of responses) if (!onPaper.has(r.tq)) throw badRequest('a response names a question that is not on this paper')
  let attemptNo = optInt(req.attempt_no) ?? 1
  if (attemptNo <= 0) attemptNo = 1
  const inst = institutionId(c), t = now()
  const existing = await c.db.prepare(`SELECT id FROM online_test_attempts WHERE test_id = ? AND student_id = ? AND attempt_no = ?`)
    .bind(testId, studentId, attemptNo).first<{ id: string }>()
  const attemptId = existing?.id ?? uuid()
  const stmts: D1PreparedStatement[] = [
    existing
      ? c.db.prepare(`UPDATE online_test_attempts SET status = 'submitted', submitted_at = ?, entered_by = ?, updated_at = ? WHERE id = ?`)
        .bind(t, c.id.userId, t, attemptId)
      : c.db.prepare(`INSERT INTO online_test_attempts (id, institution_id, test_id, student_id, attempt_no, source, status, started_at,
            submitted_at, entered_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'key_entry', 'submitted', ?, ?, ?, ?, ?)`)
        .bind(attemptId, inst, testId, studentId, attemptNo, t, t, c.id.userId, t, t),
    c.db.prepare(`DELETE FROM online_test_responses WHERE attempt_id = ?`).bind(attemptId),
  ]
  const answers = new Map<string, Given>()
  for (const r of responses) {
    stmts.push(c.db.prepare(`INSERT INTO online_test_responses (id, institution_id, attempt_id, test_question_id, selected_option_ids,
          text_response, marks_awarded, answered_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
      .bind(uuid(), inst, attemptId, r.tq, JSON.stringify(r.selected), r.text, t))
    answers.set(r.tq, { selected: r.selected, text: r.text })
  }
  const graded = gradeAttempt(c, attemptId, questions, await partialCreditOf(c, testId), answers, c.id.userId)
  await c.db.batch([...stmts, ...graded.stmts])
  return ok(graded.sheet)
}

async function readAnswers(c: Ctx, attemptId: string): Promise<Map<string, Given>> {
  const rows = await c.db.prepare(`SELECT test_question_id, selected_option_ids, text_response FROM online_test_responses WHERE attempt_id = ?`)
    .bind(attemptId).all<{ test_question_id: string; selected_option_ids: unknown; text_response: string | null }>()
  return new Map(rows.results.map((r) => [r.test_question_id, { selected: uuidArray(r.selected_option_ids), text: r.text_response }]))
}

async function regradeTest(c: Ctx): Promise<Response> {
  requirePerm(c, HOMEWORK)
  const testId = pathUUID(c, 'id')
  await testSection(c, testId)
  const questions = await loadQuestions(c, testId)
  const attempts = await c.db.prepare(`SELECT id FROM online_test_attempts WHERE test_id = ? AND status IN ('submitted', 'graded') ORDER BY created_at`)
    .bind(testId).all<{ id: string }>()
  const partial = await partialCreditOf(c, testId)
  let regraded = 0
  // One batch per attempt: each sheet is re-marked atomically.
  for (const a of attempts.results) {
    const g = gradeAttempt(c, a.id, questions, partial, await readAnswers(c, a.id), c.id.userId)
    await c.db.batch(g.stmts)
    regraded++
  }
  return ok({ regraded })
}

async function listGradingResults(c: Ctx): Promise<Response> {
  const testId = pathUUID(c, 'id')
  await testSection(c, testId)
  const rows = await c.db.prepare(`SELECT a.id AS attempt_id, st.id AS student_id, st.admission_no, ${firstLast('st')} AS student_name,
        a.source, a.status, CAST(a.score AS REAL) AS score, CAST(a.max_score AS REAL) AS max_score
      FROM online_test_attempts a JOIN students st ON st.id = a.student_id
      WHERE a.test_id = ?
      ORDER BY CAST(a.score AS REAL) DESC NULLS LAST, st.admission_no`).bind(testId).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => {
    const score = v.score === null ? null : Number(v.score), max = v.max_score === null ? null : Number(v.max_score)
    return omitNull({ ...v, score, max_score: max, percent: score !== null && max !== null && max > 0 ? round2(score / max * 100) : null })
  }) })
}

function truncateStem(s: string): string {
  s = s.split(/\s+/).filter(Boolean).join(' ')
  const b = new TextEncoder().encode(s)
  if (b.length <= 140) return s
  return new TextDecoder().decode(b.slice(0, 139)) + '…'
}

async function getItemAnalysis(c: Ctx): Promise<Response> {
  const testId = pathUUID(c, 'id')
  await testSection(c, testId)
  const questions = await loadQuestions(c, testId)
  if (!questions.length) return ok({ items: [] })
  const [att, resp] = await c.db.batch([
    c.db.prepare(`SELECT id FROM online_test_attempts WHERE test_id = ? AND status = 'graded'
        ORDER BY CAST(score AS REAL) DESC NULLS LAST, created_at`).bind(testId),
    c.db.prepare(`SELECT rp.attempt_id, rp.test_question_id, rp.is_correct, rp.selected_option_ids
        FROM online_test_responses rp JOIN online_test_attempts a ON a.id = rp.attempt_id
        WHERE a.test_id = ? AND a.status = 'graded'`).bind(testId),
  ])
  const attempts = (att.results as { id: string }[]).map((a) => a.id)
  const rank = new Map(attempts.map((a, i) => [a, i]))
  const group = Math.max(1, Math.floor(attempts.length * 27 / 100))
  interface Stat { attempted: number; correct: number; upper: number; lower: number; distractors: Map<string, number> }
  const stats = new Map<string, Stat>(questions.map((q) => [q.tq, { attempted: 0, correct: 0, upper: 0, lower: 0, distractors: new Map() }]))
  const correctSets = new Map(questions.map((q) => [q.tq, correctIDs(q)]))
  for (const r of resp.results as Record<string, unknown>[]) {
    const st = stats.get(String(r.test_question_id))
    if (!st || r.is_correct === null || r.is_correct === undefined) continue
    st.attempted++
    if (bool(r.is_correct)) {
      st.correct++
      const i = rank.get(String(r.attempt_id)) ?? 0
      if (i < group) st.upper++
      if (i >= attempts.length - group) st.lower++
      continue
    }
    for (const sel of uuidArray(r.selected_option_ids)) {
      if (!correctSets.get(String(r.test_question_id))!.has(sel)) st.distractors.set(sel, (st.distractors.get(sel) ?? 0) + 1)
    }
  }
  const out = questions.map((q) => {
    const st = stats.get(q.tq)!
    const facility = st.attempted > 0 ? round2(st.correct / st.attempted) : null
    const discrimination = attempts.length >= 6 ? round2((st.upper - st.lower) / group) : null
    let best = '', bestN = 0
    for (const [id, n] of st.distractors) if (n > bestN) { best = id; bestN = n }
    let top: string | null = null, topN = 0
    if (bestN > 0) for (const o of q.options) if (o.id === best) { top = o.body; topN = bestN }
    let flag = 'ok'
    if (facility !== null && facility <= 0.2 && bestN > st.correct) flag = 'check_key'
    else if (facility !== null && facility >= 0.95) flag = 'too_easy'
    else if (facility !== null && facility <= 0.2) flag = 'too_hard'
    else if (discrimination !== null && discrimination <= 0 && st.attempted > 0) flag = 'poor_discrimination'
    return omitNull({ test_question_id: q.tq, sequence: q.sequence, stem: truncateStem(q.stem), marks: q.marks, sat: attempts.length,
      attempted: st.attempted, correct: st.correct, facility, discrimination, top_distractor: top, top_distractor_count: topN, flag })
  }).sort((a, b) => (a.sequence as number) - (b.sequence as number))
  return ok({ items: out })
}

export function registerClassroomGrading(r: Router): void {
  r.get('/classroom/grading/tests', OPEN, listGradableTests)
  r.get('/classroom/grading/tests/{id}/key', OPEN, getGradingKey)
  r.get('/classroom/grading/tests/{id}/results', OPEN, listGradingResults)
  r.get('/classroom/grading/tests/{id}/item-analysis', OPEN, getItemAnalysis)
  r.post('/classroom/grading/tests/{id}/attempts', OPEN, enterAnswerSheet)
  r.post('/classroom/grading/tests/{id}/regrade', OPEN, regradeTest)
}
