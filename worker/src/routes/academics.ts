import type { Ctx, Router } from '../router'
import { HttpError, badRequest, bool, created, isUUID, ok, readJSON, uuid, now } from '../http'
import {
  SECTION_SET_SQL, academicYearStart, batch, can, coded, forbiddenMsg, indiaToday, inst, isClassTeacherOf,
  isForeignKeyViolation, nullStr, parseJSON, resolveScope, str, workingYearSQL,
} from './students/common'
import { registerAdminAcademics } from './academics/admin'

/* Port of the /syllabus and /academics route groups (internal/api/api.go
   lines 332-408): syllabus.go, academics.go, co_scholastic.go, houses.go,
   activities.go (the catalogue side), school_calendar.go, simple_crud.go and
   mountAdminAcademics (routes/academics/admin.ts). */

export function registerAcademics(r: Router) {
  // --- /syllabus: reads open to any signed-in member of staff ------------------
  r.get('/syllabus/units', 'auth', listSyllabusUnits)
  r.put('/syllabus/units', 'academics.write', setSyllabusUnits)
  r.get('/syllabus/coverage', 'auth', getSyllabusCoverage)
  r.get('/syllabus/lesson-plans', 'auth', listLessonPlans)
  r.post('/syllabus/lesson-plans', 'auth', saveLessonPlan)
  r.post('/syllabus/lesson-plans/{id}/decide', 'academics.write', decideLessonPlan)

  // --- /academics ---------------------------------------------------------------
  registerAdminAcademics(r)
  r.get('/academics/years', 'academics.read', listAcademicYears)
  r.get('/academics/classes', 'academics.read', listClasses)
  r.get('/academics/sections', 'academics.read', listSections)
  r.get('/academics/subjects', 'academics.read', listSubjects)
  r.get('/academics/terms', 'academics.read', listTerms)
  r.get('/academics/calendar/terms', 'academics.read', listTermsFull)
  r.post('/academics/calendar/terms', 'academics.write', saveTerm)
  r.patch('/academics/calendar/terms/{id}', 'academics.write', saveTerm)
  r.del('/academics/calendar/terms/{id}', 'academics.write', deleteTerm)
  r.get('/academics/co-scholastic-areas', 'academics.read', listCoScholasticAreas)
  r.post('/academics/co-scholastic-areas', 'academics.write', saveCoScholasticArea)
  r.get('/academics/houses', 'academics.read', listHouses)
  r.get('/academics/activities', 'academics.read', listActivities)
  r.post('/academics/activities', 'academics.write', saveActivity)
  r.post('/academics/houses', 'academics.write', saveHouse)
  r.del('/academics/houses/{id}', 'academics.write', deleteHouse)
  // mountSimpleCRUD
  r.patch('/academics/houses/{id}', 'academics.write', patchSimple('houses', 'house', ['name', 'color']))
  r.patch('/academics/activities/{id}', 'academics.write', patchSimple('activities', 'activity', ['name', 'category', 'schedule', 'venue', 'capacity', 'is_active', 'notes']))
  r.del('/academics/activities/{id}', 'academics.write', deleteSimple('activities', 'activity', [
    { label: 'children signed up', sql: `SELECT count(*) AS n FROM student_activities WHERE activity_id = ?` },
  ]))
}

const notFoundGo = () => new HttpError(404, 'resource not found', { code: 'not_found' })
const omitNull = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (o[k] === null || o[k] === undefined) delete o[k]; return o }

// --- syllabus units --------------------------------------------------------------------

const DELIVERED_SQL = (u: string) => `EXISTS (SELECT 1 FROM lesson_plan_units lpu JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
                                          WHERE lpu.syllabus_unit_id = ${u}.id AND lp.delivered_on IS NOT NULL)`

async function listSyllabusUnits(c: Ctx) {
  const q = c.url.searchParams
  const cs = nullStr(q.get('class_subject_id')), cls = nullStr(q.get('class_id'))
  const rows = await c.db.prepare(`
    SELECT u.id, u.sequence, u.title, u.description, u.outcomes, u.planned_periods, c.name AS class_name, sub.name AS subject,
           ${DELIVERED_SQL('u')} AS delivered,
           (SELECT max(lp.delivered_on) FROM lesson_plan_units lpu JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id WHERE lpu.syllabus_unit_id = u.id) AS delivered_on
      FROM syllabus_units u JOIN class_subjects cs ON cs.id = u.class_subject_id JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
     WHERE u.is_active = 1 AND (? IS NULL OR u.class_subject_id = ?) AND (? IS NULL OR cs.class_id = ?)
     ORDER BY c.level, sub.name, u.sequence`).bind(cs, cs, cls, cls).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v, delivered: bool(v.delivered) }, ['description', 'outcomes', 'delivered_on'])) })
}

export interface PlanUnit { title: string; planned_periods?: number; outcomes?: string }

/** replaceSyllabusUnits: chapters already taught are never deleted. Returns the statements and how many were kept. */
export async function planReplaceSyllabusUnits(c: Ctx, classSubjectId: string, units: PlanUnit[]): Promise<{ stmts: D1PreparedStatement[]; kept: number; written: number }> {
  const keptRow = await c.db.prepare(`SELECT count(*) AS n FROM syllabus_units u WHERE u.class_subject_id = ? AND ${DELIVERED_SQL('u')}`).bind(classSubjectId).first<{ n: number }>()
  const kept = keptRow?.n ?? 0
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`DELETE FROM syllabus_units WHERE class_subject_id = ? AND NOT ${DELIVERED_SQL('syllabus_units')}`).bind(classSubjectId),
  ]
  let written = 0
  units.forEach((u, i) => {
    const title = str(u.title).trim()
    if (title === '') return
    const periods = u.planned_periods && u.planned_periods > 0 ? u.planned_periods : 1
    stmts.push(c.db.prepare(`INSERT INTO syllabus_units (id, institution_id, class_subject_id, sequence, title, planned_periods, outcomes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst(c), classSubjectId, kept + i + 1, title, periods, nullStr(str(u.outcomes)), now()))
    written++
  })
  return { stmts, kept, written }
}

async function setSyllabusUnits(c: Ctx) {
  const req = await readJSON<{ class_subject_id?: string; units?: PlanUnit[] }>(c.req)
  if (!isUUID(req.class_subject_id)) throw badRequest('class_subject_id must be a uuid')
  if (!req.units || req.units.length === 0) throw badRequest('give at least one chapter')
  const plan = await planReplaceSyllabusUnits(c, req.class_subject_id, req.units)
  await batch(c, plan.stmts)
  return ok({ chapters: plan.written, kept_already_taught: plan.kept })
}

// --- lesson plans ------------------------------------------------------------------------

async function listLessonPlans(c: Ctx) {
  const status = nullStr(c.url.searchParams.get('status'))
  let mine = '1'
  const args: unknown[] = [status, status]
  if (!can(c, 'academics.write') && !can(c, 'hr.leave.approve')) { mine = 'lp.teacher_user_id = ?'; args.push(c.id.userId) }
  const rows = await c.db.prepare(`
    SELECT lp.id, sec.name AS section, c.name AS class_name, sub.name AS subject, u.full_name AS teacher, lp.week_of, lp.status, lp.objectives, lp.remarks,
           lp.delivered_on,
           (SELECT json_group_array(t) FROM (SELECT su.title AS t FROM lesson_plan_units lpu JOIN syllabus_units su ON su.id = lpu.syllabus_unit_id
                                              WHERE lpu.lesson_plan_id = lp.id ORDER BY su.sequence)) AS units,
           COALESCE(CAST(julianday('now') - julianday(lp.submitted_at) AS INTEGER), 0) AS waiting_days
      FROM lesson_plans lp JOIN sections sec ON sec.id = lp.section_id JOIN classes c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.id = lp.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users u ON u.id = lp.teacher_user_id
     WHERE (? IS NULL OR lp.status = ?) AND ${mine}
     ORDER BY lp.week_of DESC, c.name LIMIT 200`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v, units: parseJSON<string[]>(v.units, []) }, ['teacher', 'objectives', 'remarks', 'delivered_on'])) })
}

async function saveLessonPlan(c: Ctx) {
  const req = await readJSON<{
    section_id?: string; class_subject_id?: string; week_of?: string; objectives?: string; activities?: string; resources?: string
    homework?: string; file_id?: string; teaching_day?: number | null; unit_ids?: string[]; submit?: boolean
  }>(c.req)
  if (!isUUID(req.section_id)) throw badRequest('section_id must be a uuid')
  if (!isUUID(req.class_subject_id)) throw badRequest('class_subject_id must be a uuid')
  if (!req.week_of) throw badRequest('week_of is required')
  const scope = await resolveScope(c)
  if (!scope.allAttendance && !isClassTeacherOf(scope, req.section_id)) throw forbiddenMsg('missing permission: a lesson plan for this section')
  const status = req.submit ? 'submitted' : 'draft'
  const existing = await c.db.prepare(`SELECT id FROM lesson_plans WHERE section_id = ? AND class_subject_id = ? AND week_of = ?`)
    .bind(req.section_id, req.class_subject_id, req.week_of).first<{ id: string }>()
  const planId = existing?.id ?? uuid()
  const submittedAt = status === 'submitted' ? now() : null
  const stmts: D1PreparedStatement[] = [
    existing
      ? c.db.prepare(`UPDATE lesson_plans SET objectives = ?, activities = ?, resources = ?, homework = ?, file_id = COALESCE(?, file_id),
            teaching_day = COALESCE(?, teaching_day), status = ?, submitted_at = ?, reviewed_by = NULL, reviewed_at = NULL, remarks = NULL, updated_at = ? WHERE id = ?`)
        .bind(nullStr(str(req.objectives)), nullStr(str(req.activities)), nullStr(str(req.resources)), nullStr(str(req.homework)), nullStr(str(req.file_id)),
          req.teaching_day ?? null, status, submittedAt, now(), planId)
      : c.db.prepare(`INSERT INTO lesson_plans (id, institution_id, section_id, class_subject_id, teacher_user_id, week_of, objectives, activities, resources, homework,
            status, submitted_at, file_id, teaching_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(planId, inst(c), req.section_id, req.class_subject_id, c.id.userId, req.week_of, nullStr(str(req.objectives)), nullStr(str(req.activities)),
          nullStr(str(req.resources)), nullStr(str(req.homework)), status, submittedAt, nullStr(str(req.file_id)), req.teaching_day ?? null, now(), now()),
    c.db.prepare(`DELETE FROM lesson_plan_units WHERE lesson_plan_id = ?`).bind(planId),
  ]
  for (const u of req.unit_ids ?? []) {
    stmts.push(c.db.prepare(`INSERT OR IGNORE INTO lesson_plan_units (lesson_plan_id, syllabus_unit_id) VALUES (?, ?)`).bind(planId, u))
  }
  await batch(c, stmts)
  return ok({ id: planId, status })
}

async function decideLessonPlan(c: Ctx) {
  const planId = c.params.id
  if (!isUUID(planId)) throw badRequest('invalid lesson plan id')
  const req = await readJSON<{ decision?: string; remarks?: string; delivered_on?: string }>(c.req)
  const decision = str(req.decision)
  if (!['approved', 'returned', ''].includes(decision)) throw badRequest('decision must be approved or returned')
  if (decision === 'returned' && str(req.remarks).trim() === '') throw badRequest('say why it is being returned. A plan sent back without remarks tells the teacher nothing')
  const res = await c.db.prepare(`
    UPDATE lesson_plans SET status = COALESCE(?, status), remarks = COALESCE(?, remarks), delivered_on = COALESCE(?, delivered_on),
           reviewed_by = CASE WHEN ? <> '' THEN ? ELSE reviewed_by END, reviewed_at = CASE WHEN ? <> '' THEN ? ELSE reviewed_at END, updated_at = ?
     WHERE id = ?`).bind(nullStr(decision), nullStr(str(req.remarks)), nullStr(str(req.delivered_on)), decision, c.id.userId, decision, now(), now(), planId).run()
  if (!res.meta.changes) throw notFoundGo()
  return ok({ id: planId })
}

// --- coverage -----------------------------------------------------------------------------

/** How far through the June-to-April year today is (yearElapsedPercent). */
export function yearElapsedPercent(today: string): number {
  const start = academicYearStart(today)
  const elapsed = (Date.parse(today + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86_400_000
  if (elapsed <= 0) return 0
  if (elapsed >= 334) return 100
  return Math.floor((elapsed / 334) * 100)
}

async function getSyllabusCoverage(c: Ctx) {
  const elapsed = yearElapsedPercent(indiaToday())
  const cls = nullStr(c.url.searchParams.get('class_id'))
  const rows = await c.db.prepare(`
    SELECT cs.id AS class_subject_id, c.name AS class_name, sub.name AS subject,
           (SELECT u2.full_name FROM section_subject_teachers t JOIN users u2 ON u2.id = t.teacher_user_id WHERE t.class_subject_id = cs.id LIMIT 1) AS teacher,
           count(u.id) AS units,
           COALESCE(SUM(CASE WHEN ${DELIVERED_SQL('u')} THEN 1 ELSE 0 END), 0) AS delivered,
           (SELECT max(lp.delivered_on) FROM lesson_plans lp WHERE lp.class_subject_id = cs.id) AS last_taught,
           (SELECT count(*) FROM lesson_plans lp2 WHERE lp2.class_subject_id = cs.id AND lp2.status = 'submitted') AS plans_waiting
      FROM class_subjects cs JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN syllabus_units u ON u.class_subject_id = cs.id AND u.is_active = 1
     WHERE (? IS NULL OR cs.class_id = ?)
     GROUP BY cs.id, c.name, c.level, sub.name HAVING count(u.id) > 0
     ORDER BY c.level, sub.name`).bind(cls, cls).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => {
    const units = Number(v.units), delivered = Number(v.delivered)
    const percent = units > 0 ? Math.floor((delivered * 100) / units) : 0
    return omitNull({ ...v, units, delivered, percent, behind: percent < 75 && elapsed > 75 }, ['teacher', 'last_taught'])
  }) })
}

// --- reference lists ------------------------------------------------------------------------

async function listAcademicYears(c: Ctx) {
  const rows = await c.db.prepare(`SELECT id, name, starts_on, ends_on, is_current FROM academic_years ORDER BY starts_on DESC`).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => ({ ...v, is_current: bool(v.is_current) })) })
}

async function listClasses(c: Ctx) {
  const rows = await c.db.prepare(`SELECT id, name, level, stream FROM classes ORDER BY level, name`).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v }, ['stream'])) })
}

async function listSections(c: Ctx) {
  const q = c.url.searchParams
  const yearId = nullStr(q.get('academic_year_id'))
  let mine = '1'
  const args: unknown[] = [yearId, yearId]
  const m = q.get('mine')
  if (m === 'true' || m === 'class_teacher') {
    const scope = await resolveScope(c)
    const ids = m === 'class_teacher' ? scope.classTeacherOf : scope.sectionIds
    if (!scope.anySection) {
      if (ids.length === 0) mine = '0'
      else if (m === 'class_teacher') { mine = 'sec.class_teacher_id = ?'; args.push(c.id.userId) }
      else { mine = `sec.id IN (${SECTION_SET_SQL})`; args.push(c.id.userId, c.id.userId, c.id.userId, c.id.userId) }
    }
  }
  const rows = await c.db.prepare(`
    SELECT sec.id, sec.class_id, c.name AS class_name, sec.academic_year_id, sec.name, sec.capacity, sec.room, u.full_name AS class_teacher, sec.stated_strength,
           (SELECT count(*) FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS enrolled
      FROM sections sec JOIN classes c ON c.id = sec.class_id LEFT JOIN users u ON u.id = sec.class_teacher_id
     WHERE (? IS NULL OR sec.academic_year_id = ?) AND ${mine}
     ORDER BY c.level, sec.name`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v }, ['room', 'class_teacher', 'stated_strength'])) })
}

async function listSubjects(c: Ctx) {
  let where = '1'
  const args: unknown[] = []
  if (c.url.searchParams.get('mine') === 'true') {
    const scope = await resolveScope(c)
    if (!scope.anySection && !scope.platformAdmin) {
      args.push(c.id.userId, c.id.userId)
      where = `(EXISTS (SELECT 1 FROM class_subjects cs JOIN section_subject_teachers sst ON sst.class_subject_id = cs.id WHERE cs.subject_id = subjects.id AND sst.teacher_user_id = ?)
             OR EXISTS (SELECT 1 FROM class_subjects cs JOIN sections sec ON sec.class_id = cs.class_id WHERE cs.subject_id = subjects.id AND sec.class_teacher_id = ?))`
    }
  }
  const rows = await c.db.prepare(`SELECT id, name, code, is_scholastic FROM subjects WHERE ${where} ORDER BY name`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => ({ ...v, is_scholastic: bool(v.is_scholastic) })) })
}

async function listTerms(c: Ctx) {
  const yearId = nullStr((c.url.searchParams.get('academic_year_id') ?? '').trim())
  const rows = await c.db.prepare(`SELECT t.id, t.name, t.starts_on, t.ends_on FROM terms t WHERE t.academic_year_id = COALESCE(?, ${workingYearSQL()}) ORDER BY t.sequence, t.starts_on`)
    .bind(yearId, c.id.userId).all()
  return ok({ items: rows.results })
}

// --- term dates ---------------------------------------------------------------------------------

function requireInstitution(c: Ctx) {
  if (!c.id.institution) throw badRequest("this screen belongs to a school. Sign in against one, or pick a school first - a platform operator's account is not attached to any.")
}

async function listTermsFull(c: Ctx) {
  requireInstitution(c)
  const rows = await c.db.prepare(`
    SELECT t.id, t.name, t.starts_on, t.ends_on, t.sequence, ay.name AS academic_year, (? BETWEEN t.starts_on AND t.ends_on) AS is_current
      FROM terms t JOIN academic_years ay ON ay.id = t.academic_year_id ORDER BY ay.starts_on DESC, t.sequence`).bind(indiaToday()).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => ({ ...v, is_current: bool(v.is_current) })) })
}

async function saveTerm(c: Ctx) {
  requireInstitution(c)
  const req = await readJSON<{ name?: string; starts_on?: string; ends_on?: string; sequence?: number }>(c.req)
  const name = str(req.name).trim()
  if (name === '' || !req.starts_on || !req.ends_on) throw badRequest('a name, a start date and an end date are required')
  const sequence = req.sequence && req.sequence > 0 ? req.sequence : 1
  // terms_check in Postgres: ends_on > starts_on.
  if (!(req.ends_on > req.starts_on)) throw badRequest('a term has to end after it starts')
  const editing = c.params.id ?? ''
  if (editing !== '') {
    const res = await c.db.prepare(`UPDATE terms SET name = ?, starts_on = ?, ends_on = ?, sequence = ? WHERE id = ?`).bind(name, req.starts_on, req.ends_on, sequence, editing).run()
    if (!res.meta.changes) throw notFoundGo()
    return ok({ id: editing })
  }
  const id = uuid()
  const year = await c.db.prepare(`SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1`).first<{ id: string }>()
  if (!year) throw badRequest('no current academic year: set one before adding term dates')
  await c.db.prepare(`INSERT INTO terms (id, institution_id, academic_year_id, name, starts_on, ends_on, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, inst(c), year.id, name, req.starts_on, req.ends_on, sequence).run()
  return created({ id })
}

async function deleteTerm(c: Ctx) {
  const id = c.params.id
  if (!isUUID(id)) throw badRequest('invalid term id')
  try {
    const res = await c.db.prepare(`DELETE FROM terms WHERE id = ?`).bind(id).run()
    if (!res.meta.changes) throw notFoundGo()
  } catch (err) {
    if (isForeignKeyViolation(err)) throw coded(409, 'term_in_use', 'marks or grades are filed under this term, so it cannot be removed. Change its dates instead.')
    throw err
  }
  return ok({ ok: true })
}

// --- co-scholastic areas -------------------------------------------------------------------------

async function listCoScholasticAreas(c: Ctx) {
  const rows = await c.db.prepare(`SELECT id, name, sequence, is_active FROM co_scholastic_areas ORDER BY is_active DESC, sequence, name`).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => ({ ...v, is_active: bool(v.is_active) })) })
}

async function saveCoScholasticArea(c: Ctx) {
  const req = await readJSON<{ id?: string; name?: string; sequence?: number; is_active?: boolean | null }>(c.req)
  const name = str(req.name).trim()
  if (name === '') throw badRequest('an area needs a name')
  if (name.length > 80) throw badRequest('keep the name under 80 characters')
  const active = req.is_active === undefined || req.is_active === null ? 1 : req.is_active ? 1 : 0
  const seq = req.sequence ?? 0
  // The unique index on the name lived in Postgres; the refusal is made here instead.
  const dup = await c.db.prepare(`SELECT id FROM co_scholastic_areas WHERE lower(name) = lower(?) AND id <> ?`).bind(name, req.id ?? '').first()
  if (dup) throw badRequest('there is already an area called that')
  if (req.id) {
    if (!isUUID(req.id)) throw new Error('invalid area id')
    const res = await c.db.prepare(`UPDATE co_scholastic_areas SET name = ?, sequence = ?, is_active = ? WHERE id = ?`).bind(name, seq, active, req.id).run()
    if (!res.meta.changes) throw new Error('no such area')
    return ok({ id: req.id, name })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO co_scholastic_areas (id, institution_id, name, sequence, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, inst(c), name, seq, active, now()).run()
  return ok({ id, name })
}

// --- houses ----------------------------------------------------------------------------------------

async function listHouses(c: Ctx) {
  const rows = await c.db.prepare(`SELECT h.id, h.name, h.color, (SELECT count(*) FROM students st WHERE st.house_id = h.id AND st.status = 'active') AS students
    FROM houses h ORDER BY h.name`).all()
  return ok({ items: rows.results })
}

async function saveHouse(c: Ctx) {
  const req = await readJSON<{ id?: string; name?: string; color?: string }>(c.req)
  const name = str(req.name).trim()
  if (name === '') throw badRequest('a house needs a name')
  if (name.length > 60) throw badRequest('keep a house name under 60 characters')
  const color = str(req.color).trim()
  if (req.id) {
    if (!isUUID(req.id)) throw new Error('invalid house id')
    const res = await c.db.prepare(`UPDATE houses SET name = ?, color = COALESCE(?, color) WHERE id = ?`).bind(name, nullStr(color), req.id).run()
    if (!res.meta.changes) throw new Error('no such house')
    return ok({ id: req.id, name })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO houses (id, institution_id, name, color, created_at) VALUES (?, ?, ?, COALESCE(?, '#64748b'), ?)`).bind(id, inst(c), name, nullStr(color), now()).run()
  return ok({ id, name })
}

async function deleteHouse(c: Ctx) {
  const id = c.params.id
  if (!isUUID(id)) throw badRequest('invalid house id')
  await c.db.prepare(`DELETE FROM houses WHERE id = ?`).bind(id).run()
  return ok({ deleted: true })
}

// --- activities (the catalogue) ------------------------------------------------------------------------

async function listActivities(c: Ctx) {
  const rows = await c.db.prepare(`
    SELECT a.id, a.name, a.category, a.schedule, a.venue, trim(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS coordinator,
           a.fee_paise, a.capacity, (SELECT count(*) FROM student_activities sa WHERE sa.activity_id = a.id AND sa.status = 'enrolled') AS enrolled,
           a.is_active, a.notes
      FROM activities a LEFT JOIN employees e ON e.id = a.coordinator_id ORDER BY a.is_active DESC, a.category, a.name`).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => {
    const o: Record<string, unknown> = { ...v, is_active: bool(v.is_active) }
    if (str(v.coordinator).trim() === '') delete o.coordinator
    return omitNull(o, ['schedule', 'venue', 'notes'])
  }) })
}

async function saveActivity(c: Ctx) {
  const req = await readJSON<{
    id?: string; name?: string; category?: string; schedule?: string; venue?: string; coordinator_id?: string; fee?: number
    capacity?: number; is_active?: boolean | null; notes?: string
  }>(c.req)
  const name = str(req.name).trim()
  if (name === '') throw badRequest('an activity needs a name')
  const fee = Number(req.fee ?? 0)
  if (fee < 0) throw badRequest('a fee cannot be less than nothing')
  if (fee > 100000) throw badRequest('that is over ₹1,00,000 for one activity, if it is right, raise it as a fee head so it appears on the bill in its own right')
  const capacity = req.capacity ?? 0
  if (capacity < 0) throw badRequest('a capacity cannot be less than nothing')
  const category = str(req.category).trim() || 'Club'
  const paise = Math.floor(fee * 100 + 0.5)
  const active = req.is_active === undefined || req.is_active === null ? 1 : req.is_active ? 1 : 0
  const dup = await c.db.prepare(`SELECT id FROM activities WHERE lower(name) = lower(?) AND id <> ?`).bind(name, req.id ?? '').first()
  if (dup) throw badRequest('there is already an activity called that')
  const coord = nullStr(str(req.coordinator_id))
  if (req.id) {
    if (!isUUID(req.id)) throw new Error('invalid activity id')
    const res = await c.db.prepare(`UPDATE activities SET name = ?, category = ?, schedule = ?, venue = ?, coordinator_id = ?, fee_paise = ?, capacity = ?, is_active = ?, notes = ? WHERE id = ?`)
      .bind(name, category, nullStr(str(req.schedule)), nullStr(str(req.venue)), coord, paise, capacity, active, nullStr(str(req.notes)), req.id).run()
    if (!res.meta.changes) throw new Error('no such activity')
    return ok({ id: req.id, name })
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO activities (id, institution_id, name, category, schedule, venue, coordinator_id, fee_paise, capacity, is_active, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, inst(c), name, category, nullStr(str(req.schedule)), nullStr(str(req.venue)), coord, paise, capacity, active, nullStr(str(req.notes)), now()).run()
  return ok({ id, name })
}

// --- simple CRUD (simple_crud.go) ----------------------------------------------------------------------

function patchSimple(table: string, noun: string, columns: string[]) {
  return async (c: Ctx) => {
    const rowId = c.params.id
    if (!isUUID(rowId)) throw badRequest('invalid ' + noun + ' id')
    const req = await readJSON<Record<string, unknown>>(c.req)
    const sets: string[] = []
    const args: unknown[] = []
    for (const col of columns) {
      if (!(col in req)) continue
      let v = req[col]
      if (col === 'name' && str(v).trim() === '') throw badRequest('a ' + noun + ' needs a name')
      if (typeof v === 'boolean') v = v ? 1 : 0
      args.push(v)
      sets.push(`"${col}" = ?`)
    }
    if (sets.length === 0) throw badRequest('nothing to change')
    const res = await c.db.prepare(`UPDATE "${table}" SET ${sets.join(', ')} WHERE id = ?`).bind(...args, rowId).run()
    if (!res.meta.changes) throw badRequest('no such ' + noun + ' in this school')
    return ok({ id: rowId })
  }
}

function deleteSimple(table: string, noun: string, guards: { label: string; sql: string }[]) {
  return async (c: Ctx) => {
    const rowId = c.params.id
    if (!isUUID(rowId)) throw badRequest('invalid ' + noun + ' id')
    const exists = await c.db.prepare(`SELECT 1 AS ok FROM "${table}" WHERE id = ?`).bind(rowId).first()
    if (!exists) throw badRequest('no such ' + noun + ' in this school')
    const blocking: string[] = []
    for (const g of guards) {
      try {
        const n = await c.db.prepare(g.sql).bind(rowId).first<{ n: number }>()
        if ((n?.n ?? 0) > 0) blocking.push(`${n!.n} ${g.label}`)
      } catch { blocking.push(g.label) }
    }
    if (blocking.length > 0) throw badRequest(blocking.join(' and ') + ' still belong to this ' + noun + '. Move them first, deleting it would take them with it')
    await c.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).bind(rowId).run()
    return ok({ id: rowId })
  }
}

