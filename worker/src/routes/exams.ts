import type { Router, Ctx } from '../router'
import { can } from '../identity'
import { badRequest, bool, forbidden, isUUID, notFound, ok, created, readJSON, uuid, uuidParam, now } from '../http'
import { coded, dateOf, escapeHtml, inList, items, js, minuteOf, nameOf, nextNumber, notifyStmt, num, numOr0,
  numberInWords, requireOpenYear, resolveScope, sign, str, todayIST, trimFloat, uuidsOf } from './exams/common'
import { defaultReportCardCSS, defaultReportCardHTML } from './exams/template'
import { Messenger, scopeOf } from '../services/messaging'
import { enqueueMany } from '../services/jobs'

/* Port of the /exams, /hpc and /lifecycle route groups (internal/api/api.go
   lines 1106-1233) and the handlers they name in mod_academics.go, setup.go,
   paper_setup.go, exam_approvals.go, report_card_templates.go,
   report_card_approval.go, exam_hall.go, hpc.go, transfer_certificate.go and
   certificate_decide.go. Field names, defaults and refusals follow the Go. */

const EXAMS_READ = 'academics.exams.read'
const EXAMS_WRITE = 'academics.exams.write'
const MARKS_WRITE = 'academics.marks.write'
const EXAMS_APPROVE = 'academics.exams.approve'
const RC_GENERATE = 'academics.reportcards.generate'
const RC_PUBLISH = 'academics.reportcards.publish'
const SELF_READ = 'self.profile.read'
const STUDENTS_READ = 'students.read'
const STUDENTS_WRITE = 'students.write'

const NAME = nameOf('st')

export function registerExams(r: Router): void {
  registerExamGroup(r)
  registerHpc(r)
  registerLifecycle(r)
}

// ============================================================ /exams

function registerExamGroup(r: Router) {
  r.get('/exams/list', EXAMS_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT e.id, e.name, e.kind, ${dateOf('e.starts_on')} AS starts_on, e.is_published,
             (SELECT COUNT(*) FROM exam_subjects es WHERE es.exam_id = e.id) AS papers
        FROM exams e ORDER BY e.starts_on IS NULL, e.starts_on DESC, e.name`).all()
    return ok(items(rows.results.map((v) => ({
      id: v.id, name: v.name, kind: v.kind, starts_on: v.starts_on ?? undefined,
      is_published: bool(v.is_published), papers: numOr0(v.papers),
    }))))
  })

  r.post('/exams/{id}/papers', EXAMS_WRITE, async (c) => {
    const examId = uuidParam(c.params.id)
    const req = await readJSON<{ class_ids?: string[]; max_marks?: number }>(c.req)
    let maxMarks = Number(req.max_marks ?? 0)
    if (!(maxMarks > 0)) maxMarks = 100
    const exists = await c.db.prepare(`SELECT 1 FROM exams WHERE id = ?`).bind(examId).first()
    if (!exists) throw notFound('resource not found')
    const classIds = uuidsOf(req.class_ids)
    const all = classIds.length === 0
    const passMarks = Math.max(1, Math.round(maxMarks * 0.33))
    const cs = await c.db.prepare(`
      SELECT cs.id FROM class_subjects cs
       WHERE (? OR cs.class_id IN ${inList(classIds)})
         AND NOT EXISTS (SELECT 1 FROM exam_subjects es WHERE es.exam_id = ? AND es.class_subject_id = cs.id)`)
      .bind(all ? 1 : 0, js(classIds), examId).all<{ id: string }>()
    if (cs.results.length === 0) {
      throw badRequest('nothing to add. Either every subject already has a paper in this exam, or the classes chosen have no subjects attached yet.')
    }
    await c.db.batch(cs.results.map((row) => c.db.prepare(`
      INSERT OR IGNORE INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(uuid(), c.id.institution!.id, examId, row.id, String(maxMarks), String(passMarks))))
    return ok({ papers_added: cs.results.length })
  })

  r.get('/exams/subjects', EXAMS_READ, async (c) => {
    const res = await resolveScope(c)
    const q = c.url.searchParams
    const examId = q.get('exam_id') || null, classId = q.get('class_id') || null, kind = q.get('exam_kind') || null
    const args: unknown[] = [examId, examId, classId, classId, kind, kind]
    let mine = 'TRUE'
    if (!res.allStudents) {
      const clauses = [`EXISTS (SELECT 1 FROM section_subject_teachers t WHERE t.teacher_user_id = ? AND t.class_subject_id = cs.id)`]
      args.push(c.id.userId)
      if (res.classTeacherOf.length > 0) {
        clauses.push(`EXISTS (SELECT 1 FROM sections cts WHERE cts.id IN ${inList(res.classTeacherOf)} AND cts.class_id = cs.class_id)`)
        args.push(js(res.classTeacherOf))
      }
      mine = '(' + clauses.join(' OR ') + ')'
    }
    const rows = await c.db.prepare(`
      SELECT es.id, e.id AS exam_id, e.name AS exam_name, COALESCE(e.kind,'') AS exam_kind, sub.name AS subject,
             c.id AS class_id, c.name AS class_name,
             e.name || ' · ' || c.name || ' · ' || sub.name AS label,
             CAST(es.max_marks AS REAL) AS max_marks,
             (SELECT COUNT(*) FROM marks m WHERE m.exam_subject_id = es.id) AS marks_entered,
             (SELECT COUNT(*) FROM enrollments en WHERE en.class_id = cs.class_id AND en.status = 'active') AS students
        FROM exam_subjects es
        JOIN exams e ON e.id = es.exam_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN subjects sub ON sub.id = cs.subject_id
        JOIN classes c ON c.id = cs.class_id
       WHERE (? IS NULL OR es.exam_id = ?) AND (? IS NULL OR c.id = ?) AND (? IS NULL OR e.kind = ?)
         AND ${mine}
       ORDER BY c.level, sub.name`).bind(...args).all()
    return ok(items(rows.results))
  })

  r.put('/exams/subjects/{id}/setup', MARKS_WRITE, async (c) => {
    const esId = uuidParam(c.params.id)
    let body: { max_marks?: number | null; pass_marks?: number | null; grading_scale_id?: string | null }
    try { body = await c.req.json() } catch { throw badRequest('Send what the paper is out of.') }
    const maxMarks = body.max_marks ?? null, passMarks = body.pass_marks ?? null, scale = body.grading_scale_id ?? null
    if (maxMarks === null && passMarks === null && scale === null) throw badRequest('Nothing to change.')
    if (maxMarks !== null && (maxMarks <= 0 || maxMarks > 1000)) throw badRequest('A paper is out of somewhere between 1 and 1000.')
    if (maxMarks !== null && passMarks !== null && passMarks > maxMarks) {
      throw badRequest('The pass mark cannot be higher than what the paper is out of. Nobody could pass it.')
    }
    const row = await c.db.prepare(`SELECT exam_id, (SELECT COUNT(*) FROM marks m WHERE m.exam_subject_id = ?1) AS entered
        FROM exam_subjects WHERE id = ?1`).bind(esId).first<{ exam_id: string; entered: number }>()
    if (!row) throw notFound('resource not found')
    if (row.entered > 0 && maxMarks !== null) {
      throw coded(409, 'marks_already_entered', 'this paper already has marks entered, so what it is out of can no longer change, 45 out of 50 is a distinction and 45 out of 100 is a fail. Clear the marks first, or set the maximum on a new paper.')
    }
    const stmts: D1PreparedStatement[] = []
    if (maxMarks !== null || passMarks !== null) {
      stmts.push(c.db.prepare(`UPDATE exam_subjects
           SET max_marks = COALESCE(?2, max_marks),
               pass_marks = COALESCE(?3, MIN(CAST(pass_marks AS REAL), COALESCE(?2, CAST(max_marks AS REAL))))
         WHERE id = ?1`).bind(esId, maxMarks, passMarks))
    }
    if (scale !== null) stmts.push(c.db.prepare(`UPDATE exams SET grading_scale_id = NULLIF(?, '') WHERE id = ?`).bind(scale, row.exam_id))
    await c.db.batch(stmts)
    return ok({ updated: true, marks_entered: row.entered })
  })

  r.get('/exams/gradebook', EXAMS_READ, async (c) => {
    const esId = c.url.searchParams.get('exam_subject_id') ?? ''
    if (esId === '') throw badRequest('exam_subject_id is required')
    const sectionId = (c.url.searchParams.get('section_id') ?? '').trim()
    if (sectionId !== '' && !isUUID(sectionId)) throw badRequest('section_id must be a uuid')
    const rows = await c.db.prepare(`
      SELECT st.id AS student_id, st.admission_no, ${NAME} AS full_name,
             CAST(m.marks_obtained AS REAL) AS marks_obtained, CAST(es.max_marks AS REAL) AS max_marks,
             m.grade, COALESCE(m.is_absent, 0) AS is_absent, COALESCE(sec.name,'') AS section
        FROM exam_subjects es
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN enrollments e ON e.class_id = cs.class_id AND e.status = 'active'
        JOIN students st ON st.id = e.student_id
        LEFT JOIN sections sec ON sec.id = e.section_id
        LEFT JOIN marks m ON m.exam_subject_id = es.id AND m.student_id = st.id
       WHERE es.id = ? AND (? = '' OR e.section_id = ?)
       ORDER BY sec.name, st.admission_no`).bind(esId, sectionId, sectionId).all()
    return ok(items(rows.results.map((v) => ({
      student_id: v.student_id, admission_no: v.admission_no, full_name: v.full_name,
      marks_obtained: num(v.marks_obtained) ?? undefined, max_marks: numOr0(v.max_marks),
      grade: v.grade ?? undefined, is_absent: bool(v.is_absent), section: v.section,
    }))))
  })

  r.get('/exams/report-cards', EXAMS_READ, listReportCards)
  r.get('/exams/report-cards/readiness', EXAMS_READ, async (c) => {
    const sectionId = c.url.searchParams.get('section_id') || null
    const examId = c.url.searchParams.get('exam_id') || null
    const rows = await c.db.prepare(`
      SELECT sub.name AS subject,
             (SELECT u.full_name FROM section_subject_teachers sst JOIN users u ON u.id = sst.teacher_user_id
               WHERE sst.section_id = ?1 AND sst.class_subject_id = cs.id LIMIT 1) AS teacher,
             (SELECT COUNT(*) FROM marks m WHERE m.exam_subject_id = es.id
                 AND m.student_id IN (SELECT e.student_id FROM enrollments e WHERE e.section_id = ?1 AND e.status = 'active')) AS marks_entered,
             (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = ?1 AND e.status = 'active') AS students
        FROM exam_subjects es
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN subjects sub ON sub.id = cs.subject_id
        JOIN sections sec ON sec.id = ?1 AND sec.class_id = cs.class_id
       WHERE es.exam_id = ?2
       ORDER BY sub.name`).bind(sectionId, examId).all()
    return ok(items(rows.results.map((v) => ({
      subject: v.subject, teacher: v.teacher ?? undefined, marks_entered: numOr0(v.marks_entered), students: numOr0(v.students),
    }))))
  })

  r.post('/exams/marks', MARKS_WRITE, enterMarks)

  // --- question papers ------------------------------------------------
  r.get('/exams/question-papers', EXAMS_READ, listQuestionPapers)
  r.get('/exams/question-papers/slots', EXAMS_READ, async (c) => {
    const sc = await resolveScope(c)
    const rows = await c.db.prepare(`
      SELECT es.id AS exam_subject_id, ex.name AS exam_name, es.exam_date, c.name AS class, sub.name AS subject,
             CAST(es.max_marks AS TEXT) AS max_marks, qp.status
        FROM exam_subjects es
        JOIN exams ex ON ex.id = es.exam_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN classes c ON c.id = cs.class_id
        JOIN subjects sub ON sub.id = cs.subject_id
        LEFT JOIN question_papers qp ON qp.exam_subject_id = es.id
       WHERE cs.class_id IN (SELECT class_id FROM sections WHERE id IN ${inList(sc.sectionIds)})
       ORDER BY es.exam_date IS NULL, es.exam_date, c.name, sub.name`).bind(js(sc.sectionIds)).all()
    return ok(items(rows.results.map((v) => ({
      exam_subject_id: v.exam_subject_id, exam_name: v.exam_name, exam_date: v.exam_date ?? null, class: v.class,
      subject: v.subject, max_marks: str(v.max_marks), status: v.status ?? null,
    }))))
  })
  r.post('/exams/question-papers', EXAMS_READ, submitQuestionPaper)
  r.post('/exams/question-papers/{id}/decide', EXAMS_APPROVE, decideQuestionPaper)

  // --- moderation -----------------------------------------------------
  r.get('/exams/moderation', EXAMS_APPROVE, listMarkModeration)
  r.post('/exams/moderation', EXAMS_APPROVE, moderateMarks)
  r.post('/exams/report-cards/generate', RC_GENERATE, generateReportCards)

  // --- the design -----------------------------------------------------
  r.get('/exams/report-cards/template', EXAMS_READ, async (c) => {
    const t = await loadReportCardTemplate(c)
    return ok({
      template: t, placeholders: reportCardPlaceholders,
      fonts: [{ value: 'arial', label: 'Arial' }, { value: 'calibri', label: 'Calibri' }, { value: 'times', label: 'Times New Roman' }],
      default_html: defaultReportCardHTML,
    })
  })
  r.get('/exams/report-cards/render', EXAMS_READ, async (c) => {
    const cardId = (c.url.searchParams.get('id') ?? '').trim()
    if (!isUUID(cardId)) throw badRequest('id must be a uuid')
    const tpl = await loadReportCardTemplate(c)
    const card = await gatherReportCard(c, cardId)
    return ok({ html: fillReportCard(tpl.template_html, card), css: tpl.css ?? '', is_built_in: tpl.is_built_in })
  })
  r.post('/exams/report-cards/template', RC_GENERATE, async (c) => {
    const req = await readJSON<{ name?: string; template_html?: string }>(c.req)
    const body = (req.template_html ?? '').trim()
    if (body === '') throw badRequest('the file is empty, import the report card design itself')
    if (body.length > 400_000) {
      throw badRequest('that file is too large for a report card design · 400 KB is the limit, and a card that big is usually an image pasted into a document')
    }
    if (!body.includes('{{student_name}}') || !body.includes('{{subject_rows}}')) {
      throw badRequest('this design uses neither {{student_name}} nor {{subject_rows}}, so every child would get the same page, check the placeholder list on this screen and put them in the file')
    }
    let name = (req.name ?? '').trim()
    if (name === '') name = 'School report card'
    await c.db.prepare(`INSERT INTO report_card_templates (institution_id, name, template_html, updated_at, updated_by)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (institution_id) DO UPDATE SET name = excluded.name, template_html = excluded.template_html,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(c.id.institution!.id, name, body, now(), c.id.userId).run()
    return ok({ saved: true, name })
  })
  r.post('/exams/report-cards/template/reset', RC_GENERATE, async (c) => {
    await c.db.prepare(`DELETE FROM report_card_templates WHERE institution_id = ?`).bind(c.id.institution!.id).run()
    return ok({ reset: true })
  })
  r.post('/exams/report-cards/font', RC_GENERATE, async (c) => {
    const req = await readJSON<{ font?: string }>(c.req)
    const font = (req.font ?? '').trim().toLowerCase()
    if (!(font in reportCardFonts)) throw badRequest('choose Arial, Calibri or Times New Roman')
    await c.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config)
        VALUES (?1, 'examinations', 1, json_object('report_card_font', ?2))
        ON CONFLICT (institution_id, module) DO UPDATE SET config = json_set(module_settings.config, '$.report_card_font', ?2)`)
      .bind(c.id.institution!.id, font).run()
    return ok({ font })
  })

  // --- approval -------------------------------------------------------
  r.post('/exams/report-cards/submit', RC_GENERATE, submitReportCards)
  r.get('/exams/report-cards/pending', RC_PUBLISH, async (c) => {
    const rows = await c.db.prepare(`
      SELECT rc.status, sec.id AS section_id, sec.name AS section_name, c.name AS class_name, COUNT(*) AS cards,
             MAX(u.full_name) AS submitted_by,
             ${minuteOf('MAX(COALESCE(rc.published_at, rc.submitted_at))')} AS submitted_at
        FROM report_cards rc
        JOIN enrollments e ON e.id = rc.enrollment_id
        JOIN sections sec ON sec.id = e.section_id
        JOIN classes c ON c.id = sec.class_id
        LEFT JOIN users u ON u.id = rc.submitted_by
       WHERE rc.status IN ('submitted','published')
       GROUP BY rc.status, sec.id, sec.name, c.name, c.level
       ORDER BY rc.status, c.level, sec.name`).all()
    return ok(items(rows.results.map((v) => ({
      status: v.status, section_id: v.section_id, section_name: v.section_name, class_name: v.class_name,
      cards: numOr0(v.cards), submitted_by: v.submitted_by ?? undefined, submitted_at: v.submitted_at ?? undefined,
    }))))
  })
  r.post('/exams/report-cards/publish', RC_PUBLISH, publishReportCards)
  r.post('/exams/report-cards/return', RC_PUBLISH, returnReportCards)

  // --- signature ------------------------------------------------------
  r.get('/exams/my-signature', EXAMS_READ, async (c) => {
    const row = await c.db.prepare(`SELECT signature_file_id FROM users WHERE id = ?`).bind(c.id.userId).first<{ signature_file_id: string | null }>()
    return ok({ file_id: row?.signature_file_id ?? null })
  })
  r.put('/exams/my-signature', EXAMS_READ, async (c) => {
    const req = await readJSON<{ file_id?: string }>(c.req)
    const v = (req.file_id ?? '').trim()
    if (v !== '' && !isUUID(v)) throw badRequest('file_id must be a uuid')
    await c.db.prepare(`UPDATE users SET signature_file_id = ? WHERE id = ?`).bind(v === '' ? null : v, c.id.userId).run()
    return ok({ saved: true })
  })

  // --- exam day -------------------------------------------------------
  r.get('/exams/halls', EXAMS_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT h.id, h.name, h.rows_count AS rows, h.cols_count AS cols, h.rows_count * h.cols_count AS capacity,
             (SELECT COUNT(*) FROM exam_seats se WHERE se.hall_id = h.id) AS seats_allocated
        FROM exam_halls h WHERE h.is_active ORDER BY h.name`).all()
    return ok(items(rows.results))
  })
  r.post('/exams/halls', EXAMS_WRITE, async (c) => {
    const req = await readJSON<{ name?: string; rows?: number; cols?: number }>(c.req)
    const name = (req.name ?? '').trim()
    if (name === '') throw badRequest('the hall needs a name')
    let rowsN = Number(req.rows ?? 0), cols = Number(req.cols ?? 0)
    if (!(rowsN > 0)) rowsN = 5
    if (!(cols > 0)) cols = 6
    const campus = await ensureCampus(c)
    const dup = await c.db.prepare(`SELECT 1 FROM exam_halls WHERE institution_id = ? AND name = ?`).bind(c.id.institution!.id, name).first()
    if (dup) throw badRequest('a hall with that name already exists')
    const id = uuid()
    await c.db.prepare(`INSERT INTO exam_halls (id, institution_id, campus_id, name, rows_count, cols_count, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(id, c.id.institution!.id, campus, name, rowsN, cols, now()).run()
    return created({ id, name, capacity: rowsN * cols })
  })
  r.post('/exams/seats/allocate', EXAMS_WRITE, allocateSeats)
  r.get('/exams/hall-plan', EXAMS_READ, async (c) => {
    const examId = c.url.searchParams.get('exam_id') || null
    const hallId = c.url.searchParams.get('hall_id') || null
    const rows = await c.db.prepare(`
      SELECT se.ticket_no, ${nameOf('st', false)} AS student_name, st.admission_no,
             COALESCE(c.name,'') AS class_name, h.name AS hall, se.row_no AS row, se.col_no AS col
        FROM exam_seats se
        JOIN exam_halls h ON h.id = se.hall_id
        JOIN students st ON st.id = se.student_id
        LEFT JOIN classes c ON c.id = (SELECT e.class_id FROM enrollments e WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1)
       WHERE se.exam_id = ? AND (? IS NULL OR se.hall_id = ?)
       ORDER BY h.name, se.row_no, se.col_no`).bind(examId, hallId, hallId).all()
    return ok(items(rows.results))
  })
}

// ------------------------------------------------------------ marks entry

interface MarksEntry { student_id: string; marks_obtained?: number | null; is_absent?: boolean; remarks?: string }

async function enterMarks(c: Ctx) {
  const req = await readJSON<{ exam_subject_id?: string; entries?: MarksEntry[] }>(c.req)
  const esId = req.exam_subject_id ?? ''
  if (!isUUID(esId)) throw badRequest('exam_subject_id must be a uuid')
  const entries = req.entries ?? []
  if (entries.length === 0) throw badRequest('entries must not be empty')
  const studentIds = entries.map((e) => e.student_id)

  const res = await resolveScope(c)
  if (!res.anySection && !res.platformAdmin) {
    const may = await c.db.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM exam_subjects es
          JOIN section_subject_teachers t ON t.class_subject_id = es.class_subject_id AND t.teacher_user_id = ?2
          JOIN enrollments en ON en.section_id = t.section_id AND en.status = 'active' AND en.student_id IN ${inList(studentIds)}
         WHERE es.id = ?1
      ) OR EXISTS (
        SELECT 1 FROM enrollments en JOIN sections sec ON sec.id = en.section_id
         WHERE en.status = 'active' AND en.student_id IN ${inList(studentIds)} AND sec.class_teacher_id = ?2
      ) AS ok`).bind(esId, c.id.userId, js(studentIds), js(studentIds)).first<{ ok: number }>()
    if (!may?.ok) {
      throw forbidden('missing permission: academics.marks.write for this paper. You are neither its subject teacher nor the class teacher of these students')
    }
  }

  const paper = await c.db.prepare(`
    SELECT CAST(es.max_marks AS REAL) AS max_marks, COALESCE(sub.name, '') AS subject, e.grading_scale_id, e.academic_year_id
      FROM exam_subjects es JOIN exams e ON e.id = es.exam_id
      LEFT JOIN class_subjects cs ON cs.id = es.class_subject_id
      LEFT JOIN subjects sub ON sub.id = cs.subject_id
     WHERE es.id = ?`).bind(esId).first<{ max_marks: number; subject: string; grading_scale_id: string | null; academic_year_id: string }>()
  if (!paper) throw notFound('resource not found')
  await requireOpenYear(c, paper.academic_year_id)

  const bands = paper.grading_scale_id ? await gradeBands(c, paper.grading_scale_id) : []
  // Existing grace marks: the marks_ceiling trigger checked marks + grace against the paper.
  const existing = await c.db.prepare(`SELECT student_id, CAST(grace_marks AS REAL) AS grace FROM marks
      WHERE exam_subject_id = ? AND student_id IN ${inList(studentIds)}`).bind(esId, js(studentIds)).all<{ student_id: string; grace: number }>()
  const grace = new Map(existing.results.map((x) => [x.student_id, x.grace]))

  const stmts: D1PreparedStatement[] = []
  for (const e of entries) {
    const m = e.marks_obtained ?? null
    validateMark(paper.subject, paper.max_marks, m)
    if (!isUUID(e.student_id)) throw badRequest('student_id must be a uuid')
    if (m !== null) {
      const total = m + (grace.get(e.student_id) ?? 0)
      if (paper.max_marks > 0 && total > paper.max_marks) {
        throw badRequest(`${trimFloat(total)} is above the maximum for ${paper.subject || 'this paper'}: that paper is out of ${trimFloat(paper.max_marks)}`)
      }
    }
    let gradeStr: string | null = null
    if (m !== null && !e.is_absent && paper.grading_scale_id && paper.max_marks > 0) {
      gradeStr = pickGrade(bands, (m / paper.max_marks) * 100)
    }
    stmts.push(c.db.prepare(`
      INSERT INTO marks (id, institution_id, exam_subject_id, student_id, marks_obtained, grade, is_absent, remarks, entered_by, entered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (exam_subject_id, student_id) DO UPDATE SET
        marks_obtained = excluded.marks_obtained, grade = excluded.grade, is_absent = excluded.is_absent,
        remarks = excluded.remarks, entered_by = excluded.entered_by, entered_at = excluded.entered_at`)
      .bind(uuid(), c.id.institution!.id, esId, e.student_id, m === null ? null : String(m), gradeStr, e.is_absent ? 1 : 0,
        e.remarks ? e.remarks : null, c.id.userId, now()))
  }
  await c.db.batch(stmts)
  return ok({ written: stmts.length })
}

function validateMark(subject: string, maxMarks: number, marks: number | null) {
  if (marks === null) return
  const paper = subject || 'this paper'
  if (marks < 0) throw badRequest(`${trimFloat(marks)} is not a mark: ${paper} cannot be scored below zero`)
  if (maxMarks > 0 && marks > maxMarks) throw badRequest(`${trimFloat(marks)} is above the maximum for ${paper}: that paper is out of ${trimFloat(maxMarks)}`)
}

interface Band { grade: string; min: number; max: number }
async function gradeBands(c: Ctx, scaleId: string): Promise<Band[]> {
  const rows = await c.db.prepare(`SELECT grade, CAST(min_percent AS REAL) AS min, CAST(max_percent AS REAL) AS max
      FROM grade_bands WHERE grading_scale_id = ? ORDER BY min_percent`).bind(scaleId).all<Band>()
  return rows.results
}
const pickGrade = (bands: Band[], pct: number): string | null => bands.find((b) => pct >= b.min && pct <= b.max)?.grade ?? null

// ------------------------------------------------------------ report cards

async function listReportCards(c: Ctx) {
  const res = await resolveScope(c)
  const sectionId = c.url.searchParams.get('section_id') || null
  const examId = c.url.searchParams.get('exam_id') || null
  const args: unknown[] = [sectionId, sectionId, examId, examId]
  let where: string
  if (res.studentIds.length > 0) { where = `rc.student_id IN ${inList(res.studentIds)} AND rc.is_published`; args.push(js(res.studentIds)) }
  else if (res.allStudents) where = 'TRUE'
  else if (res.sectionIds.length > 0) { where = `e.section_id IN ${inList(res.sectionIds)}`; args.push(js(res.sectionIds)) }
  else where = 'FALSE'

  const rows = await c.db.prepare(`
    SELECT rc.id, st.id AS student_id, st.admission_no, e.roll_no, ${NAME} AS full_name, st.photo_file_id,
           c.name AS class_name, sec.name AS section_name,
           CAST(rc.total_marks AS REAL) AS total_marks, CAST(rc.max_marks AS REAL) AS max_marks,
           CAST(rc.percentage AS REAL) AS percentage, rc.grade, rc.rank_in_section,
           CAST(rc.attendance_percent AS REAL) AS attendance_percent, rc.is_published, rc.status, rc.return_note,
           COALESCE((
             SELECT json_group_array(json_object(
                      'subject', sub.name,
                      'marks_obtained', CAST(m.marks_obtained AS REAL),
                      'grace_marks', COALESCE(CAST(m.grace_marks AS REAL), 0),
                      'max_marks', CAST(es.max_marks AS REAL),
                      'percent', ROUND(100.0 * (CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL),0))
                                       / NULLIF(CAST(es.max_marks AS REAL),0), 2),
                      'is_absent', COALESCE(m.is_absent, 0),
                      'grade', (SELECT gb.grade FROM grade_bands gb
                                 WHERE gb.grading_scale_id = ex.grading_scale_id
                                   AND ROUND(100.0 * (CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL),0))
                                             / NULLIF(CAST(es.max_marks AS REAL),0), 2)
                                       BETWEEN CAST(gb.min_percent AS REAL) AND CAST(gb.max_percent AS REAL)
                                 LIMIT 1)))
               FROM exam_subjects es
               JOIN class_subjects cs ON cs.id = es.class_subject_id
               JOIN subjects sub ON sub.id = cs.subject_id
               JOIN exams ex ON ex.id = es.exam_id
               LEFT JOIN marks m ON m.exam_subject_id = es.id AND m.student_id = st.id
              WHERE cs.class_id = e.class_id
                AND (?3 IS NULL OR es.exam_id = ?4)
                AND ex.academic_year_id = rc.academic_year_id
                AND (rc.exam_id IS NULL OR es.exam_id = rc.exam_id)
                AND (rc.exam_id IS NOT NULL OR rc.term_id IS NULL OR ex.term_id = rc.term_id)
           ), '[]') AS subjects
      FROM report_cards rc
      JOIN students st ON st.id = rc.student_id
      JOIN enrollments e ON e.id = rc.enrollment_id
      LEFT JOIN sections sec ON sec.id = e.section_id
      LEFT JOIN classes c ON c.id = sec.class_id
     WHERE (?1 IS NULL OR e.section_id = ?2) AND ${where}
     ORDER BY e.roll_no IS NULL, e.roll_no, st.admission_no`).bind(...args).all()
  return ok(items(rows.results.map((v) => ({
    id: v.id, student_id: v.student_id, admission_no: v.admission_no, roll_no: v.roll_no ?? undefined, full_name: v.full_name,
    photo_file_id: v.photo_file_id ?? undefined, class_name: v.class_name ?? undefined, section_name: v.section_name ?? undefined,
    total_marks: num(v.total_marks) ?? undefined, max_marks: num(v.max_marks) ?? undefined,
    percentage: num(v.percentage) ?? undefined, grade: v.grade ?? undefined, rank_in_section: v.rank_in_section ?? undefined,
    attendance_percent: num(v.attendance_percent) ?? undefined, is_published: bool(v.is_published),
    status: v.status, return_note: v.return_note ?? undefined,
    subjects: (JSON.parse(String(v.subjects)) as Record<string, unknown>[]).sort((a, b) => String(a.subject).localeCompare(String(b.subject)))
      .map((s) => ({
        subject: s.subject, marks_obtained: s.marks_obtained ?? undefined, grace_marks: s.grace_marks,
        max_marks: s.max_marks, percent: s.percent ?? undefined, is_absent: bool(s.is_absent), grade: s.grade ?? undefined,
      })),
  }))))
}

async function generateReportCards(c: Ctx) {
  const req = await readJSON<{ exam_id?: string; section_id?: string; publish?: boolean }>(c.req)
  const examId = req.exam_id ?? '', sectionId = req.section_id ?? ''
  if (!isUUID(examId)) throw badRequest('exam_id must be a uuid')
  if (!isUUID(sectionId)) throw badRequest('section_id must be a uuid')
  const publish = !!req.publish
  if (publish && !can(c.id, RC_PUBLISH)) {
    throw forbidden('missing permission: you can build these cards but not release them, generate, then send them for approval')
  }
  const res = await resolveScope(c)
  if (!res.isClassTeacherOf(sectionId)) {
    throw forbidden('missing permission: academics.reportcards.generate for this section. Report cards are built by its class teacher')
  }
  const inst = c.id.institution!.id
  const exam = await c.db.prepare(`SELECT term_id, academic_year_id, grading_scale_id FROM exams WHERE id = ?`).bind(examId)
    .first<{ term_id: string | null; academic_year_id: string; grading_scale_id: string | null }>()

  // The remark-only rows drafted before the card existed become this exam's card.
  await c.db.prepare(`
    UPDATE report_cards SET exam_id = ?1
     WHERE exam_id IS NULL AND total_marks IS NULL
       AND term_id IS (SELECT term_id FROM exams WHERE id = ?1)
       AND academic_year_id = (SELECT academic_year_id FROM exams WHERE id = ?1)
       AND student_id IN (SELECT e.student_id FROM enrollments e WHERE e.section_id = ?2 AND e.status = 'active')
       AND NOT EXISTS (SELECT 1 FROM report_cards c WHERE c.student_id = report_cards.student_id AND c.exam_id = ?1)`)
    .bind(examId, sectionId).run()

  const totals = await c.db.prepare(`
    SELECT e.student_id, e.id AS enrollment_id, e.academic_year_id,
           SUM(CASE WHEN NOT COALESCE(m.is_absent,0) THEN COALESCE(CAST(m.marks_obtained AS REAL),0) + COALESCE(CAST(m.grace_marks AS REAL),0) END) AS total,
           SUM(CASE WHEN NOT COALESCE(m.is_absent,0) THEN CAST(es.max_marks AS REAL) END) AS max_total,
           COALESCE((SELECT ROUND(100.0 * SUM(CASE WHEN sa.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0))
                       FROM student_attendance sa JOIN academic_years ay ON ay.id = e.academic_year_id
                      WHERE sa.student_id = e.student_id AND sa.period_id IS NULL AND sa.status NOT IN ('holiday','leave')
                        AND sa.on_date BETWEEN ay.starts_on AND ay.ends_on), 0) AS attendance
      FROM enrollments e
      JOIN class_subjects cs ON cs.class_id = e.class_id
      JOIN exam_subjects es ON es.exam_id = ?1 AND es.class_subject_id = cs.id
      LEFT JOIN marks m ON m.exam_subject_id = es.id AND m.student_id = e.student_id
     WHERE e.section_id = ?2 AND e.status = 'active'
     GROUP BY e.student_id, e.id, e.academic_year_id
     ORDER BY total DESC`).bind(examId, sectionId)
    .all<{ student_id: string; enrollment_id: string; academic_year_id: string; total: number | null; max_total: number | null; attendance: number }>()

  if (totals.results.length === 0) {
    const d = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM exam_subjects WHERE exam_id = ?) AS papers,
        (SELECT COUNT(*) FROM enrollments WHERE section_id = ? AND status = 'active') AS students`).bind(examId, sectionId)
      .first<{ papers: number; students: number }>()
    if (!d?.papers) throw badRequest('that exam has no papers, so there is nothing to build a card from. Add its subjects on the exam, then generate.')
    if (!d.students) throw badRequest('no active students are enrolled in that section.')
    throw badRequest('no cards were written. Check that this exam covers the class this section belongs to.')
  }

  const bands = exam?.grading_scale_id ? await gradeBands(c, exam.grading_scale_id) : []
  const existing = await c.db.prepare(`SELECT id, student_id FROM report_cards WHERE exam_id = ? AND student_id IN ${inList(totals.results.map((t) => t.student_id))}`)
    .bind(examId, js(totals.results.map((t) => t.student_id))).all<{ id: string; student_id: string }>()
  const byStudent = new Map(existing.results.map((x) => [x.student_id, x.id]))

  const stmts: D1PreparedStatement[] = []
  const ts = now()
  let rank = 0, prevTotal: number | null = null, i = 0
  for (const t of totals.results) {
    i++
    const total = t.total ?? 0
    if (prevTotal === null || total !== prevTotal) { rank = i; prevTotal = total }
    const pct = t.max_total ? Number((100 * total / t.max_total).toFixed(2)) : null
    const grade = pct === null ? null : pickGrade(bands, pct)
    const totalS = t.total === null ? null : String(t.total)
    const maxS = t.max_total === null ? null : String(t.max_total)
    const pctS = pct === null ? null : String(pct)
    const cardId = byStudent.get(t.student_id)
    if (cardId) {
      stmts.push(c.db.prepare(`
        UPDATE report_cards SET term_id = ?2, total_marks = ?3, max_marks = ?4, percentage = ?5, grade = ?6,
               rank_in_section = ?7, attendance_percent = ?8,
               is_published = CASE WHEN is_published OR ?9 THEN 1 ELSE 0 END,
               status = CASE WHEN ?9 THEN 'published' ELSE status END,
               published_at = COALESCE(published_at, CASE WHEN ?9 THEN ?10 END)
         WHERE id = ?1`).bind(cardId, exam?.term_id ?? null, totalS, maxS, pctS, grade, rank, String(t.attendance), publish ? 1 : 0, ts))
    } else {
      stmts.push(c.db.prepare(`
        INSERT INTO report_cards (id, institution_id, student_id, academic_year_id, enrollment_id, exam_id, term_id,
               total_marks, max_marks, percentage, grade, rank_in_section, attendance_percent, is_published, published_at, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst, t.student_id, t.academic_year_id, t.enrollment_id, examId, exam?.term_id ?? null,
          totalS, maxS, pctS, grade, rank, String(t.attendance), publish ? 1 : 0, publish ? ts : null, publish ? 'published' : 'draft', ts))
    }
  }
  let rcTargets: { recipient: string; student_id: string; name: string }[] = []
  if (publish) {
    const targets = await c.db.prepare(`
      SELECT DISTINCT g.user_id AS recipient, st.id AS student_id, TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')) AS name
        FROM enrollments e JOIN students st ON st.id = e.student_id
        JOIN student_guardians sg ON sg.student_id = st.id JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
       WHERE e.section_id = ?1 AND e.status = 'active'
      UNION
      SELECT DISTINCT st.user_id, st.id, TRIM(st.first_name || ' ' || COALESCE(st.last_name,''))
        FROM enrollments e JOIN students st ON st.id = e.student_id
       WHERE e.section_id = ?1 AND e.status = 'active' AND st.user_id IS NOT NULL`).bind(sectionId)
      .all<{ recipient: string; student_id: string; name: string }>()
    rcTargets = targets.results
    for (const t of targets.results) {
      stmts.push(notifyStmt(c, t.recipient, t.student_id, 'report_card', t.name + '’s report card is ready',
        'The school has published it. Open it to see the marks, the grade and the attendance.', '/go/report_cards', 'report_card', t.student_id))
    }
  }
  await c.db.batch(stmts)
  if (publish && rcTargets.length) {
    // And out of the building: one reportcard.published email job per recipient (Go: queue.TypeMessageSend).
    const inst = c.id.institution!.id
    await enqueueMany(c.env, rcTargets.map((t) => ({ type: 'message:send', institution_id: inst,
      payload: { institution_id: inst, channel: 'email', template_key: 'reportcard.published', to_user_id: t.recipient, job_id: uuid(),
        vars: { student_name: t.name, exam_name: 'the latest' } } })))
  }
  return ok({ report_cards: totals.results.length, published: publish })
}

// ------------------------------------------------------------ approval

interface CardAction { ids?: string[]; section_ids?: string[]; note?: string; to?: string; channels?: string[] }

function actionIds(req: CardAction): { ids: string[]; sections: string[] } {
  const rawIds = req.ids ?? [], rawSecs = req.section_ids ?? []
  if (rawIds.length === 0 && rawSecs.length === 0) throw badRequest('choose at least one report card')
  if (rawIds.length > 2000) throw badRequest('that is more report cards than one action should carry')
  const ids = rawIds.map((s) => String(s).trim())
  if (!ids.every(isUUID)) throw badRequest('every id must be a uuid')
  const sections = rawSecs.map((s) => String(s).trim())
  if (!sections.every(isUUID)) throw badRequest('every section_id must be a uuid')
  return { ids, sections }
}

function audience(to: string | undefined): [boolean, boolean] {
  switch ((to ?? '').trim()) {
    case 'students': return [true, false]
    case 'parents': return [false, true]
    default: return [true, true]
  }
}
const audienceLabel = (s: boolean, p: boolean) => (s && p ? 'both' : s ? 'students' : p ? 'parents' : 'nobody')
function cleanChannels(list: string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of list ?? []) {
    const ch = String(raw).trim().toLowerCase()
    if ((ch === 'sms' || ch === 'whatsapp' || ch === 'email') && !out.includes(ch)) out.push(ch)
  }
  return out
}

async function submitReportCards(c: Ctx) {
  const req = await readJSON<CardAction>(c.req)
  const { ids, sections } = actionIds(req)
  const upd = await c.db.prepare(`
    UPDATE report_cards SET status = 'submitted', submitted_at = ?1, submitted_by = ?2, return_note = NULL
     WHERE status IN ('draft','returned')
       AND (id IN ${inList(ids)} OR enrollment_id IN (SELECT id FROM enrollments WHERE section_id IN ${inList(sections)}))`)
    .bind(now(), c.id.userId, js(ids), js(sections)).run()
  const moved = upd.meta.changes
  if (moved === 0) return ok({ submitted: 0 })

  const section = await c.db.prepare(`
    SELECT COALESCE(c.name || '-' || sec.name, 'a section') AS s FROM report_cards rc
      JOIN enrollments e ON e.id = rc.enrollment_id JOIN sections sec ON sec.id = e.section_id JOIN classes c ON c.id = sec.class_id
     WHERE rc.id IN ${inList(ids)} LIMIT 1`).bind(js(ids)).first<{ s: string }>()
  const heads = await c.db.prepare(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE rp.permission_key = ?`).bind(RC_PUBLISH).all<{ user_id: string }>()
  const batch = ids.length > 0 ? ids[0] : null
  const stmts = heads.results.filter((h) => h.user_id !== c.id.userId).map((h) =>
    notifyStmt(c, h.user_id, null, 'report_cards_submitted', `${section?.s ?? 'a section'} report cards are ready to sign off`,
      `${moved} cards sent up by ${c.id.fullName}`, '/go/report_cards', 'report_card_batch', batch))
  if (stmts.length) await c.db.batch(stmts)
  return ok({ submitted: moved })
}

async function publishReportCards(c: Ctx) {
  const req = await readJSON<CardAction>(c.req)
  const { ids, sections } = actionIds(req)
  const [toStudents, toParents] = audience(req.to)
  const channels = cleanChannels(req.channels)
  const cards = await c.db.prepare(`
    SELECT rc.id, rc.student_id FROM report_cards rc JOIN enrollments e ON e.id = rc.enrollment_id
     WHERE rc.status = 'submitted' AND (rc.id IN ${inList(ids)} OR e.section_id IN ${inList(sections)})`)
    .bind(js(ids), js(sections)).all<{ id: string; student_id: string }>()
  const ts = now()
  const stmts: D1PreparedStatement[] = []
  const cardIds = cards.results.map((x) => x.id)
  if (cardIds.length) {
    stmts.push(c.db.prepare(`UPDATE report_cards SET status = 'published', is_published = 1, published_at = ?1, decided_at = ?1, decided_by = ?2,
        return_note = NULL, published_to = ?3, published_channels = ?4 WHERE id IN ${inList(cardIds)} AND status = 'submitted'`)
      .bind(ts, c.id.userId, audienceLabel(toStudents, toParents), channels.join(','), js(cardIds)))
    for (const d of cards.results) {
      const people = await c.db.prepare(`
        SELECT g.user_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
         WHERE sg.student_id = ?1 AND g.user_id IS NOT NULL AND ?2
        UNION
        SELECT st.user_id FROM students st WHERE st.id = ?1 AND st.user_id IS NOT NULL AND ?3`)
        .bind(d.student_id, toParents ? 1 : 0, toStudents ? 1 : 0).all<{ user_id: string }>()
      for (const p of people.results) {
        stmts.push(notifyStmt(c, p.user_id, d.student_id, 'report_card', 'The report card is out',
          'Results have been published. Open it to see the subject breakdown.', '/go/results_report_cards', 'report_card', d.id))
      }
    }
    await c.db.batch(stmts)
  }
  // announceReportCards: marks in the message itself, one per contact per channel.
  let queued = 0
  let qErr: string | null = null
  if (channels.length > 0 && cardIds.length > 0) {
    try {
      const t0 = todayIST()
      const rows = await c.db.prepare(`
        SELECT TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')) AS name, COALESCE(cl.name,'') || '-' || COALESCE(sec.name,'') AS section,
               COALESCE(rc.percentage, 0) AS pct, COALESCE(rc.grade, '') AS grade, who.phone, who.email
          FROM report_cards rc JOIN students st ON st.id = rc.student_id JOIN enrollments e ON e.id = rc.enrollment_id
          LEFT JOIN sections sec ON sec.id = e.section_id LEFT JOIN classes cl ON cl.id = sec.class_id
          JOIN (SELECT sg.student_id AS sid, g.phone, g.email FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                 WHERE ?1 AND NOT sg.portal_blocked AND (sg.access_until IS NULL OR sg.access_until >= ?3)
                   AND (sg.is_primary OR NOT (SELECT i.alerts_primary_only FROM institutions i WHERE i.id = sg.institution_id)
                        OR NOT EXISTS (SELECT 1 FROM student_guardians p WHERE p.student_id = sg.student_id AND p.is_primary AND NOT p.portal_blocked
                                        AND (p.access_until IS NULL OR p.access_until >= ?3)))
                UNION ALL
                SELECT st2.id, u.phone, u.email FROM students st2 JOIN users u ON u.id = st2.user_id WHERE ?2) who ON who.sid = rc.student_id
         WHERE rc.id IN ${inList(cardIds)}`).bind(toParents ? 1 : 0, toStudents ? 1 : 0, t0, js(cardIds))
        .all<{ name: string; section: string; pct: number; grade: string; phone: string | null; email: string | null }>()
      const ms = new Messenger(scopeOf(c))
      for (const n of rows.results) {
        let text = `${n.name} (${n.section}): report card published · ${Number(n.pct).toFixed(1)}%`
        if (n.grade) text += ', grade ' + n.grade
        text += '. Open the app for the subject-wise marks.'
        for (const ch of channels) {
          const to = ((ch === 'email' ? n.email : n.phone) ?? '').trim()
          if (to === '') continue
          try { await ms.queue({ channel: ch, template_code: 'messaging.direct', vars: { text, subject: 'Report card published' }, recipient: to }); queued++ } catch { /* continue */ }
        }
      }
      await ms.kick()
    } catch (e) { qErr = (e as Error).message }
  }
  const out: Record<string, unknown> = {
    published: cardIds.length, messages_queued: queued, to: audienceLabel(toStudents, toParents), channels,
  }
  if (qErr) out.delivery_error = qErr
  return ok(out)
}

async function returnReportCards(c: Ctx) {
  const req = await readJSON<CardAction>(c.req)
  const note = (req.note ?? '').trim()
  if (note === '') throw badRequest('say what needs changing, a card sent back without a reason is one the class teacher has to come and ask about')
  const { ids, sections } = actionIds(req)
  const cards = await c.db.prepare(`
    SELECT rc.id, rc.submitted_by FROM report_cards rc JOIN enrollments e ON e.id = rc.enrollment_id
     WHERE rc.status = 'submitted' AND (rc.id IN ${inList(ids)} OR e.section_id IN ${inList(sections)})`)
    .bind(js(ids), js(sections)).all<{ id: string; submitted_by: string | null }>()
  if (cards.results.length === 0) return ok({ returned: 0 })
  const cardIds = cards.results.map((x) => x.id)
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`UPDATE report_cards SET status = 'returned', return_note = ?1, decided_at = ?2, decided_by = ?3
        WHERE id IN ${inList(cardIds)} AND status = 'submitted'`).bind(note, now(), c.id.userId, js(cardIds)),
  ]
  const batch = ids.length > 0 ? ids[0] : null
  const seen = new Set<string>()
  for (const d of cards.results) {
    if (!d.submitted_by || seen.has(d.submitted_by) || d.submitted_by === c.id.userId) continue
    seen.add(d.submitted_by)
    stmts.push(notifyStmt(c, d.submitted_by, null, 'report_cards_returned', 'Report cards sent back', note, '/go/report_cards', 'report_card_batch', batch))
  }
  await c.db.batch(stmts)
  return ok({ returned: cardIds.length })
}

// ------------------------------------------------------------ question papers

async function listQuestionPapers(c: Ctx) {
  const sc = await resolveScope(c)
  const decides = can(c.id, EXAMS_APPROVE)
  const narrowed = decides && sc.sectionIds.length > 0
  const status = (c.url.searchParams.get('status') ?? '').trim()
  const where: string[] = []
  const args: unknown[] = [c.id.userId]
  let wholeSchool = false
  if (decides) {
    if (narrowed) {
      where.push(`(qp.submitted_by = ?1 OR cs.class_id IN (SELECT class_id FROM sections WHERE id IN ${inList(sc.sectionIds)}))`)
      args.push(js(sc.sectionIds))
    } else { wholeSchool = true; where.push('TRUE') }
  } else where.push('qp.submitted_by = ?1')
  if (status !== '') { where.push('qp.status = ?'); args.push(status) }
  const rows = await c.db.prepare(`
    SELECT qp.id, ex.name AS exam_name, es.exam_date, c.name AS class, sub.name AS subject,
           CAST(es.max_marks AS TEXT) AS max_marks, es.duration_minutes, qp.file_id, qp.notes, qp.status,
           COALESCE(u.full_name, 'a teacher') AS set_by, ${minuteOf('qp.submitted_at')} AS submitted_at,
           rv.full_name AS reviewed_by, qp.review_note, qp.submitted_by = ?1 AS mine
      FROM question_papers qp
      JOIN exam_subjects es ON es.id = qp.exam_subject_id
      JOIN exams ex ON ex.id = es.exam_id
      JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN classes c ON c.id = cs.class_id
      JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users u ON u.id = qp.submitted_by
      LEFT JOIN users rv ON rv.id = qp.reviewed_by
     WHERE ${where.join(' AND ')}
     ORDER BY (qp.status = 'submitted') DESC, es.exam_date IS NULL, es.exam_date, qp.submitted_at DESC`).bind(...args).all()
  return ok({
    items: rows.results.map((v) => ({
      id: v.id, exam_name: v.exam_name, exam_date: v.exam_date ?? null, class: v.class, subject: v.subject,
      max_marks: str(v.max_marks), duration_minutes: v.duration_minutes ?? null, file_id: v.file_id ?? null,
      notes: v.notes ?? null, status: v.status, set_by: v.set_by, submitted_at: str(v.submitted_at),
      reviewed_by: v.reviewed_by ?? null, review_note: v.review_note ?? null, mine: bool(v.mine),
    })),
    decides, whole_school: wholeSchool,
  })
}

async function submitQuestionPaper(c: Ctx) {
  let body: { exam_subject_id?: string; file_id?: string | null; notes?: string; submit?: boolean }
  try { body = await c.req.json() } catch { throw badRequest('Send a paper to submit.') }
  const esId = (body.exam_subject_id ?? '').trim()
  if (!isUUID(esId)) throw badRequest('Choose which exam paper this is for.')
  let fileId: string | null = null
  if (body.file_id && body.file_id.trim() !== '') {
    const f = body.file_id.trim()
    if (!isUUID(f)) throw badRequest('That attachment could not be read. Upload it again.')
    fileId = f
  }
  if (body.submit && fileId === null) throw badRequest('Attach the paper before sending it for approval.')
  const status = body.submit ? 'submitted' : 'draft'
  const sc = await resolveScope(c)
  const okRow = await c.db.prepare(`
    SELECT EXISTS (SELECT 1 FROM exam_subjects es JOIN class_subjects cs ON cs.id = es.class_subject_id
      WHERE es.id = ? AND cs.class_id IN (SELECT class_id FROM sections WHERE id IN ${inList(sc.sectionIds)})) AS ok`)
    .bind(esId, js(sc.sectionIds)).first<{ ok: number }>()
  if (!okRow?.ok && !c.id.platformAdmin) throw forbidden('missing permission: ' + EXAMS_READ)
  const notes = (body.notes ?? '').trim()
  await c.db.prepare(`
    INSERT INTO question_papers (id, institution_id, exam_subject_id, file_id, notes, submitted_by, submitted_at, status, created_at)
    VALUES (?1, ?2, ?3, ?4, NULLIF(?5,''), ?6, ?7, ?8, ?7)
    ON CONFLICT (exam_subject_id) DO UPDATE SET file_id = excluded.file_id, notes = excluded.notes, submitted_by = excluded.submitted_by,
      submitted_at = excluded.submitted_at, status = excluded.status, reviewed_by = NULL, reviewed_at = NULL, review_note = NULL`)
    .bind(uuid(), c.id.institution!.id, esId, fileId, notes, c.id.userId, now(), status).run()
  return ok({ status })
}

async function decideQuestionPaper(c: Ctx) {
  const paperId = c.params.id
  if (!isUUID(paperId)) throw badRequest('Unknown paper.')
  let body: { decision?: string; note?: string }
  try { body = await c.req.json() } catch { throw badRequest('Send a decision.') }
  const note = (body.note ?? '').trim()
  const decision = body.decision ?? ''
  if (decision === 'changes_needed') {
    if (note === '') throw badRequest('Say what needs changing, so the teacher knows what to fix.')
  } else if (decision !== 'approved') throw badRequest('A paper is either approved or sent back for changes.')
  const row = await c.db.prepare(`
    SELECT qp.submitted_by, sub.name AS subject, c.name AS class FROM question_papers qp
      JOIN exam_subjects es ON es.id = qp.exam_subject_id JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
     WHERE qp.id = ? AND qp.status = 'submitted'`).bind(paperId).first<{ submitted_by: string; subject: string; class: string }>()
  if (!row) throw badRequest('That paper is not waiting for a decision. Someone may have decided it already.')
  const text = decision === 'changes_needed'
    ? `Your ${row.subject} paper for ${row.class} needs changes: ${note}`
    : `Your ${row.subject} paper for ${row.class} was approved.`
  await c.db.batch([
    c.db.prepare(`UPDATE question_papers SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = NULLIF(?, '') WHERE id = ? AND status = 'submitted'`)
      .bind(decision, c.id.userId, now(), note, paperId),
    c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, created_at)
        VALUES (?, ?, ?, 'question_paper', 'Question paper', ?, '/go/exams/question_papers', ?)`)
      .bind(uuid(), c.id.institution!.id, row.submitted_by, text, now()),
  ])
  return ok({ status: decision })
}

// ------------------------------------------------------------ moderation

async function listMarkModeration(c: Ctx) {
  const sc = await resolveScope(c)
  const narrowed = sc.sectionIds.length > 0
  const where = narrowed ? `cs.class_id IN (SELECT class_id FROM sections WHERE id IN ${inList(sc.sectionIds)})` : 'TRUE'
  const rows = await c.db.prepare(`
    SELECT es.id AS exam_subject_id, ex.name AS exam_name, c.name AS class, sub.name AS subject,
           CAST(es.max_marks AS TEXT) AS max_marks, CAST(es.pass_marks AS TEXT) AS pass_marks,
           SUM(CASE WHEN NOT m.is_absent THEN 1 ELSE 0 END) AS entered,
           SUM(CASE WHEN m.is_absent THEN 1 ELSE 0 END) AS absent,
           SUM(CASE WHEN NOT m.is_absent AND CAST(m.marks_obtained AS REAL) < CAST(es.pass_marks AS REAL) THEN 1 ELSE 0 END) AS failing,
           ROUND(AVG(CASE WHEN NOT m.is_absent THEN CAST(m.marks_obtained AS REAL) END) / NULLIF(CAST(es.max_marks AS REAL),0) * 100, 1) AS average_pct,
           ROUND(MAX(CASE WHEN NOT m.is_absent THEN CAST(m.marks_obtained AS REAL) END) / NULLIF(CAST(es.max_marks AS REAL),0) * 100, 1) AS highest_pct,
           ROUND(MIN(CASE WHEN NOT m.is_absent THEN CAST(m.marks_obtained AS REAL) END) / NULLIF(CAST(es.max_marks AS REAL),0) * 100, 1) AS lowest_pct,
           SUM(CASE WHEN NOT m.is_absent AND CAST(es.max_marks AS REAL) > 0 AND CAST(m.marks_obtained AS REAL) > CAST(es.max_marks AS REAL) THEN 1 ELSE 0 END) AS over_max,
           CAST(mm.adjustment AS TEXT) AS adjustment, mm.reason, mu.full_name AS moderated_by, mm.moderated_at
      FROM exam_subjects es
      JOIN exams ex ON ex.id = es.exam_id
      JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN classes c ON c.id = cs.class_id
      JOIN subjects sub ON sub.id = cs.subject_id
      JOIN marks m ON m.exam_subject_id = es.id
      LEFT JOIN mark_moderations mm ON mm.exam_subject_id = es.id
      LEFT JOIN users mu ON mu.id = mm.moderated_by
     WHERE ${where}
     GROUP BY es.id, ex.name, c.name, sub.name, es.max_marks, es.pass_marks, mm.adjustment, mm.reason, mu.full_name, mm.moderated_at
     ORDER BY (mm.moderated_at IS NULL) DESC, ex.name, c.name, sub.name`).bind(...(narrowed ? [js(sc.sectionIds)] : [])).all()
  const pctStr = (v: unknown) => (v === null || v === undefined ? null : String(v))
  return ok({
    items: rows.results.map((v) => ({
      exam_subject_id: v.exam_subject_id, exam_name: v.exam_name, class: v.class, subject: v.subject,
      max_marks: str(v.max_marks), pass_marks: str(v.pass_marks), entered: numOr0(v.entered), absent: numOr0(v.absent),
      failing: numOr0(v.failing), average_pct: pctStr(v.average_pct), highest_pct: pctStr(v.highest_pct), lowest_pct: pctStr(v.lowest_pct),
      ...(numOr0(v.over_max) ? { marks_above_max: numOr0(v.over_max) } : {}),
      adjustment: v.adjustment ?? null, reason: v.reason ?? null, moderated_by: v.moderated_by ?? null, moderated_at: v.moderated_at ?? null,
    })),
    whole_school: !narrowed,
  })
}

async function moderateMarks(c: Ctx) {
  let body: { exam_subject_id?: string; adjustment?: number; reason?: string }
  try { body = await c.req.json() } catch { throw badRequest('Send a moderation.') }
  const esId = (body.exam_subject_id ?? '').trim()
  if (!isUUID(esId)) throw badRequest('Choose which paper this is about.')
  const reason = (body.reason ?? '').trim()
  if (reason === '') throw badRequest('Say why. A change to a child\'s marks has to be explainable to their parent.')
  const adj = Number(body.adjustment ?? 0)
  if (adj < -20 || adj > 20) throw badRequest('Moderation is limited to 20 marks either way. A larger change means the paper should be re-marked.')
  const y = await c.db.prepare(`SELECT e.academic_year_id AS y FROM exam_subjects es JOIN exams e ON e.id = es.exam_id WHERE es.id = ?`)
    .bind(esId).first<{ y: string }>()
  if (!y) throw new Error('exam subject not found')
  await requireOpenYear(c, y.y)
  const [, upd] = await c.db.batch([
    c.db.prepare(`INSERT INTO mark_moderations (id, institution_id, exam_subject_id, adjustment, reason, moderated_by, moderated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (exam_subject_id) DO UPDATE SET adjustment = excluded.adjustment, reason = excluded.reason,
          moderated_by = excluded.moderated_by, moderated_at = excluded.moderated_at`)
      .bind(uuid(), c.id.institution!.id, esId, String(adj), reason, c.id.userId, now()),
    c.db.prepare(`UPDATE marks SET
          grace_marks = MIN((SELECT CAST(es.max_marks AS REAL) FROM exam_subjects es WHERE es.id = marks.exam_subject_id) - COALESCE(CAST(marks_obtained AS REAL), 0),
                            MAX(-COALESCE(CAST(marks_obtained AS REAL), 0), ?2)),
          approved_by = ?3, approved_at = ?4
        WHERE exam_subject_id = ?1 AND NOT is_absent`).bind(esId, adj, c.id.userId, now()),
  ])
  return ok({ students: upd.meta.changes })
}

// ------------------------------------------------------------ the design

const reportCardPlaceholders = [
  { token: '{{school_name}}', means: "the school's name" },
  { token: '{{school_logo}}', means: "the school's crest, where one is configured" },
  { token: '{{school_motto}}', means: "the school's tagline, where one is configured" },
  { token: '{{academic_year}}', means: 'the academic year, e.g. 2024 - 2025' },
  { token: '{{exam_name}}', means: 'which examination this card is for' },
  { token: '{{photo}}', means: "the child's photograph, where one is on file" },
  { token: '{{student_name}}', means: "the child's full name" },
  { token: '{{father_name}}', means: "father's name, where recorded" },
  { token: '{{mother_name}}', means: "mother's name, where recorded" },
  { token: '{{guardian_name}}', means: 'the guardian on record' },
  { token: '{{class}}', means: 'class' },
  { token: '{{section}}', means: 'section' },
  { token: '{{admission_no}}', means: 'admission number' },
  { token: '{{roll_no}}', means: 'roll number' },
  { token: '{{date_of_birth}}', means: 'date of birth' },
  { token: '{{admission_date}}', means: 'date of admission' },
  { token: '{{subject_rows}}', means: 'one table row per subject, marks, percentage and grade' },
  { token: '{{performance_chart}}', means: 'a bar chart of the marks, one bar per subject' },
  { token: '{{total_marks}}', means: 'marks the exam was out of' },
  { token: '{{marks_obtained}}', means: 'marks the child scored' },
  { token: '{{percentage}}', means: 'overall percentage' },
  { token: '{{grade}}', means: 'overall grade' },
  { token: '{{result}}', means: "PASS or FAIL, on the school's own pass mark" },
  { token: '{{rank}}', means: 'rank in the section' },
  { token: '{{attendance}}', means: 'attendance percentage' },
  { token: '{{class_teacher}}', means: 'the class teacher who sent it for approval' },
  { token: '{{class_teacher_sign}}', means: 'their signature, once they have sent it up' },
  { token: '{{principal}}', means: 'the head who approved it' },
  { token: '{{principal_sign}}', means: 'their signature, once they have approved it' },
  { token: '{{issued_on}}', means: "today's date" },
]

const reportCardFonts: Record<string, string> = {
  arial: 'Arial, Helvetica, sans-serif',
  calibri: 'Calibri, Candara, Arial, sans-serif',
  times: "'Times New Roman', Times, serif",
}
const defaultReportCardFont = 'times'

interface ReportCardTemplate {
  name: string; template_html: string; is_built_in: boolean; css?: string; font: string; updated_at?: string; updated_by?: string
}

async function loadReportCardTemplate(c: Ctx): Promise<ReportCardTemplate> {
  const fontRow = await c.db.prepare(`SELECT json_extract(config, '$.report_card_font') AS f FROM module_settings WHERE module = 'examinations'`)
    .first<{ f: string | null }>()
  let font = defaultReportCardFont
  if (fontRow?.f && (fontRow.f.toLowerCase() in reportCardFonts)) font = fontRow.f.toLowerCase()
  const css = defaultReportCardCSS.split('__FONT__').join(reportCardFonts[font])
  const t = await c.db.prepare(`SELECT t.name, t.template_html, ${minuteOf('t.updated_at')} AS at, u.full_name AS by
      FROM report_card_templates t LEFT JOIN users u ON u.id = t.updated_by WHERE t.institution_id = ?`)
    .bind(c.id.institution!.id).first<{ name: string; template_html: string; at: string; by: string | null }>()
  if (!t) return { name: 'Standard report card', template_html: defaultReportCardHTML, is_built_in: true, css, font }
  return { name: t.name, template_html: t.template_html, is_built_in: false, font, updated_at: t.at, updated_by: t.by ?? undefined }
}

interface RenderedCard { values: Record<string, string>; subjects: Record<string, string>[] }

function imgTag(id: string): string {
  const v = id.trim()
  if (!isUUID(v)) return ''
  return `<img src="/api/v1/files/${escapeHtml(v)}" alt="" style="width:100%;height:100%;max-width:100%;object-fit:cover;display:block">`
}

function stripUnknownPlaceholders(s: string): string {
  for (;;) {
    const i = s.indexOf('{{')
    if (i < 0) return s
    const j = s.indexOf('}}', i)
    if (j < 0) return s
    s = s.slice(0, i) + s.slice(j + 2)
  }
}

function fillReportCard(tpl: string, card: RenderedCard): string {
  let rows = ''
  for (const sub of card.subjects) {
    rows += '<tr>'
    for (const k of ['subject', 'max_marks', 'marks', 'percent', 'subject_grade']) rows += '<td>' + escapeHtml(sub[k] ?? '') + '</td>'
    rows += '</tr>'
  }
  let out = tpl.split('{{subject_rows}}').join(rows)
  if (out.includes('{{performance_chart}}')) {
    let ch = ''
    const n = card.subjects.length
    if (n > 0) {
      const bw = 34, gap = 10, base = 132, top = 8
      const w = gap + n * (bw + gap)
      ch += `<svg viewBox="0 0 ${w} 152" width="100%" style="max-width:${w}px" font-family="sans-serif">`
      card.subjects.forEach((sub, i) => {
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
  out = out.split('{{photo}}').join(imgTag(card.values.photo_file_id ?? ''))
  out = out.split('{{school_logo}}').join(imgTag(card.values.logo_file_id ?? ''))
  out = out.split('{{class_teacher_sign}}').join(imgTag(card.values.teacher_sign_file_id ?? ''))
  out = out.split('{{principal_sign}}').join(imgTag(card.values.principal_sign_file_id ?? ''))
  for (const [k, v] of Object.entries(card.values)) {
    if (['photo_file_id', 'logo_file_id', 'teacher_sign_file_id', 'principal_sign_file_id'].includes(k)) continue
    out = out.split('{{' + k + '}}').join(escapeHtml(v))
  }
  return stripUnknownPlaceholders(out)
}

const ddmmyyyy = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')

async function gatherReportCard(c: Ctx, cardId: string): Promise<RenderedCard> {
  const row = await c.db.prepare(`
    SELECT i.name AS school, i.logo_key, (SELECT b.tagline FROM branding_profiles b WHERE b.campus_id IS NULL LIMIT 1) AS motto,
           ${NAME} AS student, COALESCE(c.name,'') AS class, COALESCE(sec.name,'') AS section, st.admission_no,
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
  const s = (k: string) => str(row[k])
  const n = (k: string) => { const v = num(row[k]); return v === null ? '' : trimFloat(v) }
  const values: Record<string, string> = {
    school_name: s('school'), student_name: s('student'), logo_file_id: s('logo_key'), school_motto: s('motto'),
    teacher_sign_file_id: s('teacher_sign'), principal_sign_file_id: s('principal_sign'),
    class: s('class'), section: s('section'), admission_no: s('admission_no'), roll_no: s('roll_no'),
    date_of_birth: ddmmyyyy(row.date_of_birth as string | null), admission_date: ddmmyyyy(row.admission_date as string | null),
    photo_file_id: s('photo_file_id'), father_name: s('father'), mother_name: s('mother'), guardian_name: s('guardian'),
    total_marks: n('total'), marks_obtained: n('obtained'), grade: s('grade'), remarks: '',
    exam_name: s('exam_name'), academic_year: s('year'), class_teacher: s('class_teacher'), principal: s('principal'),
    rank: s('rank'), issued_on: ddmmyyyy(todayIST()), percentage: '', attendance: '', result: '',
  }
  const pct = num(row.pct)
  if (pct !== null) { values.percentage = pct.toFixed(2) + '%'; values.result = pct >= 33 ? 'PASS' : 'FAIL' }
  const att = num(row.attendance)
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
    const r: Record<string, string> = { subject: x.name, max_marks: trimFloat(x.max), marks: '-', percent: '-', subject_grade: x.g ?? '' }
    if (x.got !== null) {
      r.marks = trimFloat(x.got)
      if (x.max > 0) r.percent = `${Math.round((100 * x.got) / x.max)}%`
    }
    return r
  })
  return { values, subjects }
}

// ------------------------------------------------------------ exam day

async function ensureCampus(c: Ctx): Promise<string> {
  const row = await c.db.prepare(`SELECT id FROM campuses ORDER BY created_at LIMIT 1`).first<{ id: string }>()
  if (row) return row.id
  const id = uuid()
  await c.db.prepare(`INSERT INTO campuses (id, institution_id, name, code, created_at, updated_at) VALUES (?, ?, 'Main Campus', 'MAIN', ?, ?)`)
    .bind(id, c.id.institution!.id, now(), now()).run()
  return id
}

function initials(name: string): string {
  let b = ''
  for (const word of name.split(/\s+/).filter(Boolean)) {
    const ch = word[0]
    if (/[0-9A-Za-z]/.test(ch)) b += word.toUpperCase()[0]
  }
  return b || 'EX'
}

async function allocateSeats(c: Ctx) {
  const req = await readJSON<{ exam_id?: string; hall_ids?: string[]; ticket_prefix?: string }>(c.req)
  const examId = req.exam_id ?? ''
  if (!isUUID(examId)) throw badRequest('exam_id must be a uuid')
  const exam = await c.db.prepare(`SELECT name FROM exams WHERE id = ?`).bind(examId).first<{ name: string }>()
  if (!exam) throw badRequest('no rows in result set')
  let prefix = (req.ticket_prefix ?? '').trim()
  if (prefix === '') prefix = initials(exam.name)
  const wanted = (req.hall_ids ?? []).map(String)
  const hallRows = await c.db.prepare(`SELECT id, rows_count AS rows, cols_count AS cols, name FROM exam_halls
      WHERE is_active AND (? OR id IN ${inList(wanted)}) ORDER BY name`).bind(wanted.length ? 0 : 1, js(wanted))
    .all<{ id: string; rows: number; cols: number; name: string }>()
  let halls = hallRows.results
  if (wanted.length) halls = [...halls].sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id))
  if (halls.length === 0) throw badRequest('no exam halls have been set up')
  const capacity = halls.reduce((s, h) => s + h.rows * h.cols, 0)

  // Candidates interleaved by section: position within the section first, then the section.
  const cand = await c.db.prepare(`
    SELECT st.id, sec.id AS sec, st.admission_no FROM exam_subjects es
      JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN sections sec ON sec.class_id = cs.class_id
      JOIN enrollments e ON e.section_id = sec.id AND e.status = 'active'
      JOIN students st ON st.id = e.student_id
     WHERE es.exam_id = ? AND st.status = 'active'
     GROUP BY st.id, sec.id, st.admission_no ORDER BY sec.id, st.admission_no`).bind(examId)
    .all<{ id: string; sec: string; admission_no: string }>()
  const pos = new Map<string, number>()
  const ordered = cand.results.map((x) => { const p = (pos.get(x.sec) ?? 0) + 1; pos.set(x.sec, p); return { ...x, p } })
    .sort((a, b) => a.p - b.p || (a.sec < b.sec ? -1 : a.sec > b.sec ? 1 : 0))
  const ids = ordered.map((x) => x.id)
  const candidates = ids.length
  if (candidates === 0) throw badRequest('this exam has no candidates. Check its classes and papers')
  if (candidates > capacity) {
    throw coded(409, 'no_room', `there are ${candidates} candidates and only ${capacity} seats. Add a hall, or allocate across more of them.`)
  }
  const stmts: D1PreparedStatement[] = [c.db.prepare(`DELETE FROM exam_seats WHERE exam_id = ?`).bind(examId)]
  let i = 0
  for (const h of halls) {
    for (let row = 1; row <= h.rows && i < ids.length; row++) {
      for (let col = 1; col <= h.cols && i < ids.length; col++) {
        const ticket = prefix + '-' + String(i + 1).padStart(4, '0')
        stmts.push(c.db.prepare(`INSERT INTO exam_seats (id, institution_id, exam_id, student_id, hall_id, row_no, col_no, ticket_no, allocated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), c.id.institution!.id, examId, ids[i], h.id, row, col, ticket, now()))
        i++
      }
    }
  }
  await c.db.batch(stmts)
  return ok({ seated: i, capacity, candidates })
}

async function getHallTicket(c: Ctx) {
  const studentId = await hpcStudent(c)
  const examId = c.url.searchParams.get('exam_id') ?? ''
  if (!isUUID(examId)) throw badRequest('exam_id must be a uuid')
  const t = await c.db.prepare(`
    SELECT se.ticket_no, h.name AS hall, se.row_no, se.col_no, ${NAME} AS student_name, st.admission_no,
           COALESCE(c.name,'') AS class_name, COALESCE(sec.name,'') AS section_name, ex.name AS exam_name, ex.board, i.name AS school
      FROM exam_seats se
      JOIN exam_halls h ON h.id = se.hall_id
      JOIN students st ON st.id = se.student_id
      JOIN exams ex ON ex.id = se.exam_id
      JOIN institutions i ON i.id = se.institution_id
      LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1)
      LEFT JOIN classes c ON c.id = en.class_id
      LEFT JOIN sections sec ON sec.id = en.section_id
     WHERE se.exam_id = ? AND se.student_id = ?`).bind(examId, studentId).first<Record<string, unknown>>()
  if (!t) throw coded(404, 'not_seated', 'no seat has been allocated for this exam yet. The school issues tickets once seating is done.')
  const papers = await c.db.prepare(`
    SELECT sub.name AS subject, ${dateOf('es.exam_date')} AS date, SUBSTR(es.starts_at, 12, 5) AS starts_at, es.duration_minutes,
           CAST(es.max_marks AS INTEGER) AS max_marks
      FROM exam_subjects es
      JOIN class_subjects cs ON cs.id = es.class_subject_id
      JOIN subjects sub ON sub.id = cs.subject_id
      JOIN enrollments e ON e.class_id = cs.class_id AND e.student_id = ?2 AND e.status = 'active'
     WHERE es.exam_id = ?1
     ORDER BY es.exam_date IS NULL, es.exam_date, es.starts_at IS NULL, es.starts_at, sub.name`).bind(examId, studentId).all()
  return ok({
    ticket_no: t.ticket_no, student_name: t.student_name, admission_no: t.admission_no, class_name: t.class_name,
    section_name: t.section_name, exam_name: t.exam_name, board: t.board ?? undefined, hall: t.hall,
    seat: `Row ${t.row_no}, Seat ${t.col_no}`, school: t.school,
    papers: papers.results.map((p) => ({
      subject: p.subject, date: p.date ?? undefined, starts_at: p.starts_at ?? undefined,
      duration_minutes: p.duration_minutes ?? undefined, max_marks: p.max_marks ?? undefined,
    })),
    verification_code: await sign(c.env.PASSWORD_PEPPER, 'exam-hall-ticket', `${examId}|${studentId}|${t.ticket_no}`),
    instructions: [
      'Bring this ticket to every paper. You will not be admitted without it.',
      'Be seated fifteen minutes before the paper starts.',
      'No mobile phone, smart watch or written material in the hall.',
      'Carry your own pens, pencils and instruments; nothing may be shared.',
    ],
  })
}

// ============================================================ /hpc

function stageFor(level: number): string {
  if (level <= 2) return 'foundational'
  if (level <= 5) return 'preparatory'
  if (level <= 8) return 'middle'
  if (level <= 10) return 'secondary'
  return 'senior_secondary'
}
function reportingFor(stage: string) {
  switch (stage) {
    case 'foundational': return { stage, stage_label: 'Foundational (Classes 1–2)', numeric_grades: false, scale: 'descriptors', note: 'Descriptive only. No marks, percentage or rank at this stage.' }
    case 'preparatory': return { stage, stage_label: 'Preparatory (Classes 3–5)', numeric_grades: false, scale: 'descriptors', note: 'Descriptive only. No marks, percentage or rank at this stage.' }
    case 'middle': return { stage, stage_label: 'Middle (Classes 6–8)', numeric_grades: true, scale: '5-point A–E', note: 'Marks alongside a five-point grade, with co-scholastic domains.' }
    case 'secondary': return { stage, stage_label: 'Secondary (Classes 9–10)', numeric_grades: true, scale: '9-point A1–E + CGPA', note: 'Marks, a nine-point grade and a cumulative grade point average.' }
    default: return { stage, stage_label: 'Senior Secondary (Classes 11–12)', numeric_grades: true, scale: 'percentage, best of five', note: 'Subject marks and a best-of-five percentage.' }
  }
}
function descriptor(level: number): string {
  if (level === 0) return 'Not yet observed'
  if (level < 1.75) return 'Beginner'
  if (level < 2.75) return 'Progressing'
  if (level < 3.5) return 'Proficient'
  return 'Advanced'
}
function ninePoint(pct: number): [string, number] {
  if (pct >= 91) return ['A1', 10]
  if (pct >= 81) return ['A2', 9]
  if (pct >= 71) return ['B1', 8]
  if (pct >= 61) return ['B2', 7]
  if (pct >= 51) return ['C1', 6]
  if (pct >= 41) return ['C2', 5]
  if (pct >= 33) return ['D', 4]
  return ['E', 0]
}
function fivePoint(pct: number): string {
  if (pct >= 81) return 'A'
  if (pct >= 61) return 'B'
  if (pct >= 41) return 'C'
  if (pct >= 33) return 'D'
  return 'E'
}
const domainLabels: Record<string, string> = {
  cognitive: 'Cognitive development', affective: 'Socio-emotional development', psychomotor: 'Physical development and the arts',
}
/** hpc_competencies.stages came from a text[]; it is stored either as JSON or as a '{a,b}' literal. */
function stagesOf(raw: unknown): string[] {
  const s = str(raw).trim()
  if (s === '' || s === '{}' || s === '[]') return []
  if (s.startsWith('[')) { try { return (JSON.parse(s) as unknown[]).map(String) } catch { return [] } }
  return s.replace(/^\{|\}$/g, '').split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)
}

/** Which child is being asked about, refusing anyone outside the caller's scope. */
async function hpcStudent(c: Ctx): Promise<string> {
  const res = await resolveScope(c)
  const q = c.url.searchParams.get('student_id') ?? ''
  if (q === '') {
    if (res.studentIds.length > 0) return res.studentIds[0]
    throw badRequest('student_id is required')
  }
  if (!isUUID(q)) throw badRequest('student_id must be a uuid')
  if (res.allStudents || res.ownsStudent(q)) return q
  const reach = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ? AND e.status = 'active'
      AND e.section_id IN ${inList(res.sectionIds)}) AS r`).bind(q, js(res.sectionIds)).first<{ r: number }>()
  if (reach?.r) return q
  throw notFound('resource not found')
}

function registerHpc(r: Router) {
  r.get('/hpc/card', SELF_READ, async (c) => {
    const studentId = await hpcStudent(c)
    const termId = c.url.searchParams.get('term_id') || null
    const head = await c.db.prepare(`
      SELECT ${NAME} AS name, COALESCE(c.name,'') AS class_name, COALESCE(sec.name,'') AS section_name, COALESCE(c.level, 1) AS level
        FROM students st
        LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1)
        LEFT JOIN classes c ON c.id = en.class_id
        LEFT JOIN sections sec ON sec.id = en.section_id
       WHERE st.id = ?`).bind(studentId).first<{ name: string; class_name: string; section_name: string; level: number }>()
    if (!head) throw new Error('student not found')
    const reporting = reportingFor(stageFor(head.level))
    const incomplete: string[] = []

    const rows = await c.db.prepare(`
      SELECT co.id, co.domain, co.code, co.name, COALESCE(co.description,'') AS description, co.stages,
             ob.observer_role, u.full_name AS by, ob.level, ob.note
        FROM hpc_competencies co
        LEFT JOIN hpc_observations ob ON ob.competency_id = co.id AND ob.student_id = ?1 AND (?2 IS NULL OR ob.term_id = ?2)
        LEFT JOIN users u ON u.id = ob.observed_by
       WHERE co.is_active
       ORDER BY co.domain, co.sequence, co.code, ob.observer_role`).bind(studentId, termId).all<Record<string, unknown>>()
    interface View { role: string; by?: string; level?: number; descriptor?: string; note?: string }
    interface Comp { id: string; code: string; name: string; description: string; views: View[]; descriptor: string; self_teacher_gap: boolean }
    const byDomain = new Map<string, Comp[]>()
    let cur: Comp | null = null, curId = ''
    for (const v of rows.results) {
      const st = stagesOf(v.stages)
      if (st.length > 0 && !st.includes(reporting.stage)) continue
      const domain = String(v.domain)
      if (!byDomain.has(domain)) byDomain.set(domain, [])
      const list = byDomain.get(domain)!
      if (String(v.id) !== curId) {
        cur = { id: String(v.id), code: String(v.code), name: String(v.name), description: String(v.description), views: [], descriptor: '', self_teacher_gap: false }
        list.push(cur); curId = String(v.id)
      }
      if (v.observer_role != null && cur) {
        const lvl = v.level == null ? undefined : Number(v.level)
        const view: View = { role: String(v.observer_role), by: v.by == null ? undefined : String(v.by), level: lvl, note: v.note == null ? undefined : String(v.note) }
        if (lvl !== undefined) view.descriptor = descriptor(lvl)
        cur.views.push(view)
      }
    }
    const domains: { domain: string; label: string; competencies: Comp[] }[] = []
    for (const name of ['cognitive', 'affective', 'psychomotor']) {
      const comps = byDomain.get(name)
      if (!comps) continue
      let rated = 0
      for (const comp of comps) {
        let teacher = 0, self = 0
        for (const v of comp.views) {
          if (v.level === undefined) continue
          if (v.role === 'teacher') teacher = v.level
          else if (v.role === 'self') self = v.level
        }
        comp.descriptor = descriptor(teacher)
        comp.self_teacher_gap = teacher > 0 && self > 0 && Math.abs(teacher - self) > 1
        if (teacher > 0) rated++
      }
      if (rated === 0) incomplete.push(domainLabels[name] + ' has no teacher observations yet')
      else if (rated < comps.length) incomplete.push(`${comps.length - rated} competencies in ${domainLabels[name].toLowerCase()} are still unrated`)
      domains.push({ domain: name, label: domainLabels[name], competencies: comps })
    }

    const scholastic: { subject: string; obtained: number; max: number; percentage: number; grade: string; grade_point?: number }[] = []
    let percentage: number | undefined, grade: string | undefined, cgpa: number | undefined
    if (reporting.numeric_grades) {
      const m = await c.db.prepare(`
        SELECT sub.name, SUM(COALESCE(CAST(m.marks_obtained AS REAL),0)) AS obtained, SUM(COALESCE(CAST(es.max_marks AS REAL),0)) AS max
          FROM marks m
          JOIN exam_subjects es ON es.id = m.exam_subject_id
          JOIN class_subjects cs ON cs.id = es.class_subject_id
          JOIN subjects sub ON sub.id = cs.subject_id
          JOIN exams ex ON ex.id = es.exam_id
         WHERE m.student_id = ?1 AND (?2 IS NULL OR ex.term_id = ?2)
         GROUP BY sub.name ORDER BY sub.name`).bind(studentId, termId).all<{ name: string; obtained: number; max: number }>()
      let totalObt = 0, totalMax = 0, points = 0
      for (const sj of m.results) {
        const pct = sj.max > 0 ? (sj.obtained / sj.max) * 100 : 0
        const row: (typeof scholastic)[number] = { subject: sj.name, obtained: sj.obtained, max: sj.max, percentage: pct, grade: '' }
        if (reporting.stage === 'middle') row.grade = fivePoint(pct)
        else { const [g, gp] = ninePoint(pct); row.grade = g; row.grade_point = gp; points += gp }
        totalObt += sj.obtained; totalMax += sj.max
        scholastic.push(row)
      }
      if (scholastic.length === 0) incomplete.push('no marks entered for this term')
      else if (totalMax > 0) {
        percentage = (totalObt / totalMax) * 100
        if (reporting.stage === 'middle') grade = fivePoint(percentage)
        else { grade = ninePoint(percentage)[0]; cgpa = points / scholastic.length }
      }
    }
    const att = await c.db.prepare(`SELECT ROUND(100.0 * SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS a
        FROM student_attendance WHERE student_id = ?`).bind(studentId).first<{ a: number | null }>()
    return ok({
      student_id: studentId, student_name: head.name, class_name: head.class_name, section_name: head.section_name,
      reporting, domains, scholastic, percentage, grade, cgpa, attendance_percent: att?.a ?? undefined,
      incomplete, ready: incomplete.length === 0,
    })
  })

  r.get('/hpc/hall-ticket', SELF_READ, getHallTicket)

  r.get('/hpc/competencies', SELF_READ, async (c) => {
    const domain = c.url.searchParams.get('domain') || null
    const rows = await c.db.prepare(`SELECT id, domain, code, name, COALESCE(description,'') AS description, stages
        FROM hpc_competencies WHERE is_active AND (? IS NULL OR domain = ?) ORDER BY domain, sequence, code`).bind(domain, domain).all()
    return ok(items(rows.results.map((v) => ({
      id: v.id, domain: v.domain, domain_label: domainLabels[String(v.domain)] ?? '', code: v.code, name: v.name,
      description: v.description, stages: stagesOf(v.stages),
    }))))
  })

  r.post('/hpc/observations', SELF_READ, async (c) => {
    const req = await readJSON<{ student_id?: string; competency_id?: string; term_id?: string; observer_role?: string; level?: number | null; note?: string }>(c.req)
    const competency = req.competency_id ?? ''
    if (!isUUID(competency)) throw badRequest('competency_id must be a uuid')
    const level = req.level ?? null
    if (level !== null && (level < 1 || level > 4)) throw badRequest('level must be 1 (beginner), 2 (progressing), 3 (proficient) or 4 (advanced)')
    const note = (req.note ?? '').trim()
    if (level === null && note === '') throw badRequest('give a level, a note, or both')
    const res = await resolveScope(c)
    let role = (req.observer_role ?? '').trim()
    const staff = can(c.id, MARKS_WRITE)
    if (role === '') role = staff ? 'teacher' : 'self'
    if ((role === 'teacher' && !staff) || (role === 'peer' && staff)) throw forbidden('that is not a view you may record')
    let student: string
    if (req.student_id) {
      if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
      student = req.student_id
    } else if (res.studentIds.length > 0) student = res.studentIds[0]
    else throw badRequest('student_id is required')
    if (!res.allStudents && !res.ownsStudent(student)) {
      const reach = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ? AND e.status = 'active'
          AND e.section_id IN ${inList(res.sectionIds)}) AS r`).bind(student, js(res.sectionIds)).first<{ r: number }>()
      if (!reach?.r) throw notFound('resource not found')
    }
    const termId = req.term_id || null
    // ON CONFLICT (student, competency, role, COALESCE(term), COALESCE(observed_by)) DO UPDATE, without the partial index.
    const existing = await c.db.prepare(`SELECT id FROM hpc_observations WHERE student_id = ? AND competency_id = ? AND observer_role = ?
        AND COALESCE(term_id,'') = COALESCE(?,'') AND COALESCE(observed_by,'') = ?`).bind(student, competency, role, termId, c.id.userId).first<{ id: string }>()
    if (existing) {
      await c.db.prepare(`UPDATE hpc_observations SET level = ?, note = NULLIF(?,''), updated_at = ? WHERE id = ?`).bind(level, req.note ?? '', now(), existing.id).run()
    } else {
      await c.db.prepare(`
        INSERT INTO hpc_observations (id, institution_id, student_id, competency_id, term_id, academic_year_id, observer_role, observed_by, level, note, observed_on, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, (SELECT id FROM academic_years WHERE is_current LIMIT 1), ?, ?, ?, NULLIF(?,''), ?, ?, ?)`)
        .bind(uuid(), c.id.institution!.id, student, competency, termId, role, c.id.userId, level, req.note ?? '', todayIST(), now(), now()).run()
    }
    return ok({ recorded: role })
  })
}

// ============================================================ /lifecycle

function registerLifecycle(r: Router) {
  r.get('/lifecycle/certificates', STUDENTS_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT ic.serial_no, ct.name AS type, ${nameOf('st', false)} AS student_name, ${dateOf('ic.issued_on')} AS issued_on, ic.status, ic.snapshot,
             ic.id, COALESCE(c.name,'') AS class_name, COALESCE(sec.name,'') AS section_name, COALESCE(st.admission_no,'') AS admission_no,
             COALESCE(u.full_name,'') AS asked_by, COALESCE(g.phone, u.phone, '') AS asked_phone
        FROM issued_certificates ic
        JOIN certificate_types ct ON ct.id = ic.certificate_type_id
        LEFT JOIN students st ON st.id = ic.student_id
        LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
        LEFT JOIN classes c ON c.id = en.class_id
        LEFT JOIN sections sec ON sec.id = en.section_id
        LEFT JOIN users u ON u.id = ic.requested_by
        LEFT JOIN guardians g ON g.id = (SELECT id FROM guardians WHERE user_id = ic.requested_by LIMIT 1)
       ORDER BY ic.created_at DESC LIMIT 200`).all()
    return ok(items(rows.results.map((v) => ({
      serial_no: v.serial_no, type: v.type, student_name: v.student_name ?? '', issued_on: v.issued_on, status: v.status,
      snapshot: parseJSON(v.snapshot), id: v.id, class_name: v.class_name, section_name: v.section_name,
      admission_no: v.admission_no, asked_by: v.asked_by, asked_phone: v.asked_phone,
    }))))
  })

  r.post('/lifecycle/promote', STUDENTS_WRITE, async (c) => {
    const req = await readJSON<{ from_section_id?: string; to_section_id?: string; academic_year_id?: string; student_ids?: string[] }>(c.req)
    const from = req.from_section_id ?? '', to = req.to_section_id ?? '', year = req.academic_year_id ?? ''
    if (!isUUID(from)) throw badRequest('from_section_id must be a uuid')
    if (!isUUID(to)) throw badRequest('to_section_id must be a uuid')
    if (!isUUID(year)) throw badRequest('academic_year_id must be a uuid')
    const toClass = await c.db.prepare(`SELECT class_id FROM sections WHERE id = ?`).bind(to).first<{ class_id: string }>()
    if (!toClass) throw new Error('no rows in result set')
    const only = uuidsOf(req.student_ids)
    const moving = await c.db.prepare(`SELECT e.id, e.student_id FROM enrollments e WHERE e.section_id = ? AND e.status = 'active'
        AND (? OR e.student_id IN ${inList(only)})`).bind(from, only.length ? 0 : 1, js(only)).all<{ id: string; student_id: string }>()
    if (moving.results.length === 0) return ok({ promoted: 0 })
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`UPDATE enrollments SET status = 'promoted' WHERE id IN ${inList(moving.results.map((m) => m.id))}`).bind(js(moving.results.map((m) => m.id))),
    ]
    for (const m of moving.results) {
      stmts.push(c.db.prepare(`INSERT OR IGNORE INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, status, promoted_from_id, enrolled_on, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
        .bind(uuid(), c.id.institution!.id, m.student_id, year, toClass.class_id, to, m.id, todayIST(), now()))
    }
    const results = await c.db.batch(stmts)
    const promoted = results.slice(1).reduce((s, r) => s + r.meta.changes, 0)
    return ok({ promoted })
  })

  r.post('/lifecycle/certificates', STUDENTS_WRITE, issueCertificate)

  r.get('/lifecycle/certificates/{id}/render', STUDENTS_READ, async (c) => {
    const certId = c.params.id
    if (!isUUID(certId)) throw badRequest('invalid certificate id')
    const row = await c.db.prepare(`
      SELECT ct.name AS type_name, ct.code, COALESCE(ct.template_html,'') AS body, ic.serial_no, ic.issued_on,
             COALESCE(ct.signatory,'') AS signatory, COALESCE(ct.signatory_role,'') AS signatory_role, ic.snapshot,
             (SELECT i.name FROM institutions i WHERE i.id = ic.institution_id) AS school,
             (SELECT u.full_name FROM users u WHERE u.id = ic.dues_override_by) AS override_by
        FROM issued_certificates ic JOIN certificate_types ct ON ct.id = ic.certificate_type_id WHERE ic.id = ?`)
      .bind(certId).first<Record<string, unknown>>()
    if (!row) throw notFound('resource not found')
    const issuedOn = ddmmyyyy(String(row.issued_on).slice(0, 10)).replace(/\//g, '-')
    const snapshot = parseJSON(row.snapshot) as Record<string, unknown>
    const fields: Record<string, string> = {
      serial_no: str(row.serial_no), issued_on: issuedOn, signatory: str(row.signatory), signatory_role: str(row.signatory_role),
      school_name: str(row.school), student_name: snapshotString(snapshot.name),
    }
    for (const [k, v] of Object.entries(snapshot)) fields[k] = snapshotString(v)
    if (!fields.date_of_issue) fields.date_of_issue = issuedOn
    if (row.override_by != null) fields.dues_override_by = String(row.override_by)
    const body = str(row.body)
    let rendered: string
    if (body.trim() !== '') {
      rendered = body
      for (const [k, v] of Object.entries(fields)) rendered = rendered.split('{{' + k + '}}').join(escapeHtml(v))
    } else rendered = plainCertificate(str(row.type_name), str(row.code), fields)
    return ok({ html: rendered, name: `${row.type_name} ${row.serial_no}`, template: body.trim() !== '' })
  })

  r.post('/lifecycle/certificates/{id}/decide', STUDENTS_WRITE, async (c) => {
    const cid = c.params.id
    if (!isUUID(cid)) throw badRequest('invalid certificate id')
    const req = await readJSON<{ status?: string; note?: string }>(c.req)
    const status = (req.status ?? '').trim().toLowerCase()
    const decisions: Record<string, string> = { approved: 'approved', issued: 'ready', cancelled: 'declined' }
    if (!(status in decisions)) throw badRequest('status must be approved, issued or cancelled')
    const note = (req.note ?? '').trim()
    if (note.length > 1000) throw badRequest('keep the note under 1000 characters')
    if (status === 'cancelled' && note === '') throw badRequest('say why it was declined, the family will be told')
    const upd = await c.db.prepare(`UPDATE issued_certificates SET status = ?2, approved_by = ?3,
          snapshot = json_set(snapshot, '$.office_note', ?4, '$.decided_at', ?5)
        WHERE id = ?1 AND status IN ('requested','approved')`).bind(cid, status, c.id.userId, note === '' ? null : note, now()).run()
    if (upd.meta.changes === 0) throw coded(409, 'already_decided', 'somebody has already answered this request')
    const row = await c.db.prepare(`SELECT ic.serial_no, ic.student_id, ct.name AS type_name, ${nameOf('st', false)} AS child
        FROM issued_certificates ic JOIN certificate_types ct ON ct.id = ic.certificate_type_id JOIN students st ON st.id = ic.student_id
       WHERE ic.id = ?`).bind(cid).first<{ serial_no: string; student_id: string; type_name: string; child: string }>()
    if (!row) throw new Error('certificate not found')
    let body = `${row.type_name} for ${row.child} · ${decisions[status]}. Serial ${row.serial_no}.`
    if (note !== '') body += ' ' + note
    const people = await c.db.prepare(`
      SELECT g.user_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ?1 AND g.user_id IS NOT NULL
      UNION SELECT u.id FROM students st JOIN users u ON u.id = st.user_id WHERE st.id = ?1`).bind(row.student_id).all<{ user_id: string }>()
    const stmts = people.results.map((p) => notifyStmt(c, p.user_id, row.student_id, 'certificate', `${row.type_name} ${decisions[status]}`, body,
      '/portal/requests', 'certificate', cid))
    if (stmts.length) await c.db.batch(stmts)
    return ok({ status, serial_no: row.serial_no })
  })
}

function parseJSON(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? {}
  try { return JSON.parse(v) } catch { return {} }
}

function snapshotString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  if (Array.isArray(v)) return v.map(snapshotString).join(', ')
  return String(v)
}

const tcLines: [string, string][] = [
  ['serial_no', 'TC No.'], ['admission_no', 'Admission No.'], ['name', 'Name of the pupil'],
  ['guardian_name', "Father's / Guardian's name"], ['nationality', 'Nationality'], ['category', 'Category'],
  ['date_of_birth', 'Date of birth (in figures)'], ['date_of_birth_in_words', 'Date of birth (in words)'],
  ['admission_date', 'Date of admission'], ['class_in_words', 'Class in which the pupil last studied (in words)'],
  ['subjects_studied', 'Subjects studied'], ['last_exam_passed', 'School / Board examination last taken'],
  ['qualified_for_promotion', 'Whether qualified for promotion to the higher class'], ['dues_paid_up_to', 'School dues paid up to'],
  ['fee_concession', 'Any fee concession availed'], ['working_days', 'Total number of working days'],
  ['days_present', 'Total number of working days present'], ['ncc_scout', 'Whether NCC cadet / Scout / Guide'],
  ['games', 'Games played / extra-curricular activities'], ['conduct', 'General conduct'],
  ['date_of_application', 'Date of application for certificate'], ['date_of_leaving', 'Date on which the pupil left the school'],
  ['reason_for_leaving', 'Reason for leaving'], ['apaar_id', 'APAAR ID'], ['date_of_issue', 'Date of issue'],
  ['dues_override_by', 'Dues outstanding at issue, allowed by'],
]

function plainCertificate(typeName: string, code: string, f: Record<string, string>): string {
  let b = '<div style="font-family:Georgia,serif;max-width:190mm;margin:0 auto;padding:16mm;line-height:1.5">'
  b += `<h2 style="text-align:center;margin:0">${escapeHtml(f.school_name ?? '')}</h2>`
  b += `<h3 style="text-align:center;margin:4px 0 16px;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(typeName)}</h3>`
  b += '<table style="width:100%;border-collapse:collapse;font-size:14px">'
  const lines: [string, string][] = code === 'TC' ? tcLines : Object.keys(f).sort().map((k) => [k, k.split('_').join(' ')])
  let n = 0
  for (const [key, label] of lines) {
    if (!(key in f)) continue
    let v = f[key]
    if (v === '' && key === 'dues_override_by') continue
    n++
    if (v === '') v = '-'
    b += `<tr><td style="padding:4px 8px 4px 0;width:2em;vertical-align:top">${n}.</td>` +
      `<td style="padding:4px 8px;vertical-align:top">${escapeHtml(label)}</td>` +
      `<td style="padding:4px 0;font-weight:600;vertical-align:top">${escapeHtml(v)}</td></tr>`
  }
  b += '</table>'
  b += `<p style="margin-top:32px;font-size:13px">Date: ${escapeHtml(f.date_of_issue ?? '')}</p>`
  b += `<p style="text-align:right;margin-top:40px">${escapeHtml(f.signatory || 'Principal')}<br><span style="font-size:12px">${escapeHtml(f.signatory_role || 'Signature with seal')}</span></p>`
  b += '</div>'
  return b
}

const ordinalSmall: Record<number, string> = {
  1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', 5: 'Fifth', 6: 'Sixth', 7: 'Seventh', 8: 'Eighth', 9: 'Ninth', 10: 'Tenth',
  11: 'Eleventh', 12: 'Twelfth', 13: 'Thirteenth', 14: 'Fourteenth', 15: 'Fifteenth', 16: 'Sixteenth', 17: 'Seventeenth',
  18: 'Eighteenth', 19: 'Nineteenth', 20: 'Twentieth', 30: 'Thirtieth',
}
function ordinalWords(n: number): string {
  if (ordinalSmall[n]) return ordinalSmall[n]
  if (n > 20 && n < 40) return (n >= 30 ? 'Thirty' : 'Twenty') + '-' + (ordinalSmall[n % 10] ?? '')
  return `${n}th`
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function dateInWords(iso: string): string {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10))
  return `${ordinalWords(d)} ${MONTH_NAMES[m - 1]} ${numberInWords(y)}`
}
const certificateName = (code: string) =>
  code === 'TC' ? 'Transfer Certificate' : code === 'BONAFIDE' ? 'Bonafide Certificate' : code === 'CONDUCT' ? 'Character Certificate' : code
const formatPaise = (p: number) => `${p < 0 ? '-' : ''}₹${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, '0')}`

interface TcDetails {
  nationality?: string; category?: string; ncc_scout?: string; games?: string; conduct?: string; date_of_application?: string
  date_of_issue?: string; qualified_for_promotion?: boolean | null; dues_paid_up_to?: string; fee_concession?: string
  last_exam_passed?: string; override_dues?: boolean; override_dues_reason?: string
}

async function tcExtras(c: Ctx, sid: string, d: TcDetails, reason: string): Promise<Record<string, unknown>> {
  const row = await c.db.prepare(`
    SELECT st.date_of_birth AS dob, COALESCE(st.nationality,'') AS nationality, COALESCE(st.category,'') AS category,
           COALESCE(c.name,'') AS class_name, c.level,
           (SELECT MAX(i.due_on) FROM invoices i WHERE i.student_id = st.id AND i.status = 'paid') AS dues_paid_up_to,
           (SELECT GROUP_CONCAT(TRIM(UPPER(SUBSTR(fc.kind,1,1)) || SUBSTR(fc.kind,2) || ' ' ||
                     CASE WHEN fc.percent IS NOT NULL THEN CAST(fc.percent AS TEXT) || '%'
                          WHEN fc.amount_paise IS NOT NULL THEN '₹' || CAST(fc.amount_paise/100 AS TEXT) ELSE '' END), '; ')
              FROM fee_concessions fc WHERE fc.student_id = st.id AND fc.academic_year_id = en.academic_year_id) AS concession,
           (SELECT COUNT(DISTINCT sa.on_date) FROM student_attendance sa WHERE sa.student_id = st.id AND sa.on_date >= ay.starts_on AND sa.on_date <= ay.ends_on) AS days_total,
           (SELECT COUNT(DISTINCT sa.on_date) FROM student_attendance sa WHERE sa.student_id = st.id AND sa.on_date >= ay.starts_on AND sa.on_date <= ay.ends_on
              AND sa.status IN ('present','late')) AS days_present,
           (SELECT json_group_array(sub.name) FROM (SELECT sub.name FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id
              WHERE cs.class_id = en.class_id ORDER BY sub.name) sub) AS subjects,
           (SELECT COALESCE(ex.name, t.name, ay2.name) FROM report_cards rc
              LEFT JOIN exams ex ON ex.id = rc.exam_id LEFT JOIN terms t ON t.id = rc.term_id LEFT JOIN academic_years ay2 ON ay2.id = rc.academic_year_id
             WHERE rc.student_id = st.id AND rc.is_published ORDER BY rc.published_at IS NULL, rc.published_at DESC LIMIT 1) AS last_exam,
           (SELECT CAST(rc.percentage AS REAL) >= COALESCE((SELECT MIN(100.0 * CAST(es.pass_marks AS REAL) / NULLIF(CAST(es.max_marks AS REAL),0))
                                                                FROM exam_subjects es WHERE es.exam_id = rc.exam_id), 33)
              FROM report_cards rc WHERE rc.student_id = st.id AND rc.is_published AND rc.percentage IS NOT NULL
             ORDER BY rc.published_at IS NULL, rc.published_at DESC LIMIT 1) AS last_exam_passed
      FROM students st
      LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY (e.status = 'active') DESC, e.enrolled_on DESC LIMIT 1)
      LEFT JOIN classes c ON c.id = en.class_id
      LEFT JOIN academic_years ay ON ay.id = en.academic_year_id
     WHERE st.id = ?`).bind(sid).first<Record<string, unknown>>()
  if (!row) throw new Error('student not found')
  const pick = (given: string | undefined, onRecord: string) => (given ?? '').trim() || onRecord
  const out: Record<string, unknown> = {
    nationality: pick(d.nationality, str(row.nationality) || 'Indian'),
    category: pick(d.category, str(row.category)),
    ncc_scout: (d.ncc_scout ?? '').trim(), games: (d.games ?? '').trim(), conduct: pick(d.conduct, 'Good'),
    reason_for_leaving: reason.trim(), date_of_application: (d.date_of_application ?? '').trim(),
    date_of_leaving: todayIST(), working_days: numOr0(row.days_total), days_present: numOr0(row.days_present),
    subjects_studied: parseJSON(row.subjects) ?? [], last_exam_passed: pick(d.last_exam_passed, str(row.last_exam)),
  }
  if (row.dob) out.date_of_birth_in_words = dateInWords(String(row.dob).slice(0, 10))
  out.class_in_words = row.level != null ? `${ordinalWords(Number(row.level))} (${row.class_name})` : str(row.class_name)
  if (d.qualified_for_promotion != null) out.qualified_for_promotion = d.qualified_for_promotion
  else if (row.last_exam_passed != null) out.qualified_for_promotion = bool(row.last_exam_passed)
  const dpu = (d.dues_paid_up_to ?? '').trim()
  if (dpu !== '') out.dues_paid_up_to = dpu
  else if (row.dues_paid_up_to) out.dues_paid_up_to = String(row.dues_paid_up_to).slice(0, 10)
  const fc = (d.fee_concession ?? '').trim()
  if (fc !== '') out.fee_concession = fc
  else if (row.concession) out.fee_concession = String(row.concession)
  else out.fee_concession = 'Nil'
  if (d.date_of_issue) out.date_of_issue = d.date_of_issue.trim()
  return out
}

async function issueCertificate(c: Ctx) {
  const req = await readJSON<{ student_id?: string; type_code?: string; reason?: string } & TcDetails>(c.req)
  const sid = req.student_id ?? ''
  if (!isUUID(sid)) throw badRequest('student_id must be a uuid')
  const typeCode = req.type_code || 'TC'
  const reason = req.reason ?? ''
  if (req.override_dues && (req.override_dues_reason ?? '').trim() === '') {
    throw badRequest('issuing over unpaid dues needs a reason, which goes on the record')
  }
  const inst = c.id.institution!.id
  let duesPaise = 0, duesInvoices = 0, overridden = false
  let extras: Record<string, unknown> = {}
  if (typeCode === 'TC') {
    const d = await c.db.prepare(`SELECT COALESCE(SUM(i.net_paise - i.paid_paise), 0) AS paise, COUNT(*) AS n FROM invoices i
        WHERE i.student_id = ? AND i.status IN ('unpaid','partial','overdue') AND i.net_paise > i.paid_paise`).bind(sid)
      .first<{ paise: number; n: number }>()
    duesPaise = d?.paise ?? 0; duesInvoices = d?.n ?? 0
    if (duesPaise > 0) {
      if (!req.override_dues) {
        throw coded(409, 'dues_unpaid', `${formatPaise(duesPaise)} is still owed on ${duesInvoices} ${duesInvoices === 1 ? 'invoice' : 'invoices'}; collect it, or issue with an override and a reason.`)
      }
      overridden = true
    }
    extras = await tcExtras(c, sid, req, reason)
  }
  let type = await c.db.prepare(`SELECT id FROM certificate_types WHERE code = ?`).bind(typeCode).first<{ id: string }>()
  if (!type) {
    const id = uuid()
    await c.db.prepare(`INSERT INTO certificate_types (id, institution_id, code, name, requires_approval, updated_at) VALUES (?, ?, ?, ?, 0, ?)`)
      .bind(id, inst, typeCode, certificateName(typeCode), now()).run()
    type = { id }
  }
  const serial = await nextNumber(c, 'certificate')
  const snap = await c.db.prepare(`
    SELECT ${NAME} AS name, st.admission_no, st.date_of_birth,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1) AS guardian_name,
           c.name AS class, sec.name AS section, st.admission_date, st.apaar_id,
           COALESCE((SELECT ROUND(100.0 * SUM(CASE WHEN sa.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0))
                       FROM student_attendance sa JOIN academic_years ay ON ay.is_current
                      WHERE sa.student_id = st.id AND sa.period_id IS NULL AND sa.status NOT IN ('holiday','leave')
                        AND sa.on_date BETWEEN ay.starts_on AND ay.ends_on), 0) AS attendance_percent,
           COALESCE((SELECT SUM(i.net_paise - i.paid_paise) FROM invoices i WHERE i.student_id = st.id AND i.status IN ('unpaid','partial','overdue')), 0) AS dues_paise
      FROM students st
      LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
      LEFT JOIN classes c ON c.id = en.class_id
      LEFT JOIN sections sec ON sec.id = en.section_id
     WHERE st.id = ?`).bind(sid).first<Record<string, unknown>>()
  if (!snap) throw new Error('student not found')
  const snapshot = { ...snap, reason: reason === '' ? null : reason, issued_at: now(), ...extras }
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO issued_certificates (id, institution_id, certificate_type_id, student_id, serial_no, issued_on, snapshot, status, requested_by,
          dues_override_by, dues_override_at, dues_override_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst, type.id, sid, serial, todayIST(), JSON.stringify(snapshot), c.id.userId,
        overridden ? c.id.userId : null, overridden ? now() : null, overridden ? (req.override_dues_reason ?? '').trim() : null, now()),
  ]
  if (typeCode === 'TC') {
    stmts.push(c.db.prepare(`UPDATE students SET status = 'transferred', exit_date = ?, exit_reason = COALESCE(?, 'Transfer certificate issued'), updated_at = ? WHERE id = ?`)
      .bind(todayIST(), reason === '' ? null : reason, now(), sid))
    stmts.push(c.db.prepare(`UPDATE enrollments SET status = 'transferred' WHERE student_id = ? AND status = 'active'`).bind(sid))
  }
  await c.db.batch(stmts)
  return created({ serial_no: serial, type: typeCode, student_id: sid, dues_paise: duesPaise, dues_overridden: duesPaise > 0 && !!req.override_dues })
}
