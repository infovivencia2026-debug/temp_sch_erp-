import type { Router } from '../../router'
import type { Ctx } from '../../router'
import { badRequest, created, notFound, ok, readJSON, uuid, uuidParam, now, bool, isUUID } from '../../http'
import { requireInstitution, instId, nullStr, ensureCampus, workingYearId, classLevelFromName, uniqueSubjectCode,
  uniqueUsername, plural, str, todayIndia, isUniqueViolation, batch, changes } from './common'

/* Port of the academic and fee halves of setup.go, academics_crud.go,
   sections_edit.go, exam_edit.go, fee_structure_edit.go, fee_optins.go and
   the class-subject / class-teacher handlers of setup_profile.go. */

const asInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : Number.isInteger(Number(v)) ? Number(v) : 0)
const asNum = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined

/** writeRefResult (academics_crud.go): the shared answer for the reference-table edits. */
const refGone = (noun: string) => badRequest(`no such ${noun} in this school`)
const refTaken = (noun: string) => badRequest(`this school already has a ${noun} with that name`)

export function registerAcademics(r: Router): void {
  /* --- academic years --- */

  r.post('/setup/academic-years', 'academics.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name), startsOn = str(req.starts_on), endsOn = str(req.ends_on)
    if (name === '' || startsOn === '' || endsOn === '') throw badRequest('name, starts_on and ends_on are required')
    const campus = await ensureCampus(c)
    const id = uuid()
    const isCurrent = req.is_current === true
    const stmts: D1PreparedStatement[] = []
    // academic_years_one_current: the previous current year stands down first.
    if (isCurrent) stmts.push(c.db.prepare(`UPDATE academic_years SET is_current = 0 WHERE is_current = 1`))
    stmts.push(c.db.prepare(`INSERT INTO academic_years (id, institution_id, campus_id, name, starts_on, ends_on, is_current, board, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, instId(c), campus, name, startsOn, endsOn, isCurrent ? 1 : 0, nullStr(str(req.board)), now()))
    await batch(c, stmts)
    return created({ id, name })
  })

  r.patch('/setup/academic-years/{id}', 'academics.write', async (c) => {
    const yearId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    let name: string | null = null
    if (has(req, 'name')) { name = str(req.name).trim(); if (name === '') throw badRequest('an academic year needs a name') }
    const workingDays = has(req, 'working_days') ? asInt(req.working_days) : null
    if (workingDays !== null && (workingDays < 0 || workingDays > 366)) throw badRequest('working days must be between 0 and 366')
    const isCurrent = has(req, 'is_current') ? (req.is_current === true ? 1 : 0) : null
    const board = has(req, 'board') ? str(req.board) : null
    const stmts: D1PreparedStatement[] = []
    if (isCurrent === 1) stmts.push(c.db.prepare(`UPDATE academic_years SET is_current = 0 WHERE id <> ?`).bind(yearId))
    stmts.push(c.db.prepare(`UPDATE academic_years SET name = COALESCE(?, name), starts_on = COALESCE(?, starts_on), ends_on = COALESCE(?, ends_on),
        is_current = COALESCE(?, is_current), board = CASE WHEN ? IS NULL THEN board ELSE NULLIF(?, '') END,
        working_days = COALESCE(?, working_days) WHERE id = ?`)
      .bind(name, has(req, 'starts_on') ? str(req.starts_on) : null, has(req, 'ends_on') ? str(req.ends_on) : null,
        isCurrent, board, board, workingDays, yearId))
    const res = await batch(c, stmts)
    if (!changes(res[res.length - 1])) throw refGone('academic year')
    const okRow = await c.db.prepare(`SELECT ends_on > starts_on AS ok FROM academic_years WHERE id = ?`).bind(yearId).first<{ ok: number }>()
    if (!bool(okRow?.ok)) throw badRequest('the year has to end after it starts')
    return ok({ id: yearId })
  })

  /* --- classes --- */

  r.post('/setup/classes', 'academics.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name)
    if (name.trim() === '') throw badRequest('name is required')
    let level = asInt(req.level)
    if (level === 0) level = classLevelFromName(name)
    if (level === 0) throw badRequest('no year could be read from that name. Add the number, as in Grade 6')
    let capacity = asInt(req.capacity)
    if (capacity <= 0) capacity = 40
    const campus = await ensureCampus(c)
    const inst = instId(c)
    const stream = nullStr(str(req.stream))
    const existing = await c.db.prepare(`SELECT id FROM classes WHERE institution_id = ? AND campus_id = ? AND name = ?`).bind(inst, campus, name).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const stmts: D1PreparedStatement[] = [existing
      ? c.db.prepare(`UPDATE classes SET level = ?, stream = ? WHERE id = ?`).bind(level, stream, id)
      : c.db.prepare(`INSERT INTO classes (id, institution_id, campus_id, name, level, stream, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, inst, campus, name, level, stream, now())]
    const sections = Array.isArray(req.sections) ? (req.sections as unknown[]).map(str).map((s) => s.trim()).filter((s) => s !== '') : []
    if (sections.length > 0) {
      const yearId = await workingYearId(c)
      if (!yearId) throw badRequest('open the academic year before adding sections to a class')
      for (const sec of sections) {
        stmts.push(c.db.prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name, capacity, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (class_id, academic_year_id, name) DO UPDATE SET capacity = excluded.capacity`)
          .bind(uuid(), inst, campus, id, yearId, sec, capacity, now()))
      }
    }
    await batch(c, stmts)
    return created({ id, name })
  })

  r.patch('/setup/classes/{id}', 'academics.write', async (c) => {
    const classId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    let name: string | null = null
    if (has(req, 'name')) { name = str(req.name).trim(); if (name === '') throw badRequest('a class needs a name') }
    const level = has(req, 'level') ? asInt(req.level) : null
    if (level !== null && level < 0) throw badRequest('level cannot be negative')
    const stream = has(req, 'stream') ? str(req.stream) : null
    let res: D1Result
    try {
      res = await c.db.prepare(`UPDATE classes SET name = COALESCE(?, name), level = COALESCE(?, level),
          stream = CASE WHEN ? IS NULL THEN stream ELSE NULLIF(?, '') END WHERE id = ?`).bind(name, level, stream, stream, classId).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw refTaken('class')
      throw e
    }
    if (!res.meta.changes) throw refGone('class')
    return ok({ id: classId })
  })

  r.del('/setup/classes/{id}', 'academics.write', async (c) => {
    const classId = uuidParam(c.params.id)
    const row = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM sections WHERE class_id = c.id) AS sections,
        (SELECT COUNT(*) FROM class_subjects WHERE class_id = c.id) AS subjects FROM classes c WHERE c.id = ?`).bind(classId)
      .first<{ sections: number; subjects: number }>()
    if (!row) throw refGone('class')
    if (row.sections > 0 || row.subjects > 0) {
      throw badRequest(plural(row.sections, 'section', 'sections') + ' and ' + plural(row.subjects, 'mapped subject', 'mapped subjects') +
        ' hang off this class. Remove them first, deleting the class would take their registers and marks with it')
    }
    await c.db.prepare(`DELETE FROM classes WHERE id = ?`).bind(classId).run()
    return ok({ id: classId })
  })

  /* --- sections --- */

  r.post('/setup/sections', 'academics.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const classId = str(req.class_id)
    if (!isUUID(classId)) throw badRequest('class_id must be a uuid')
    const name = str(req.name).trim()
    if (name === '') throw badRequest('name is required, a letter, or whatever this school calls it: Rose, Newton, Blue')
    let capacity = asInt(req.capacity)
    if (capacity <= 0) capacity = 40
    const campus = await ensureCampus(c)
    const yearId = await workingYearId(c, str(req.academic_year_id))
    if (!yearId) throw badRequest('create an academic year before adding sections')
    const teacher = nullStr(str(req.class_teacher_id))
    const existing = await c.db.prepare(`SELECT id FROM sections WHERE class_id = ? AND academic_year_id = ? AND name = ?`).bind(classId, yearId, name).first<{ id: string }>()
    if (existing) {
      await c.db.prepare(`UPDATE sections SET capacity = ?, room = ?, class_teacher_id = COALESCE(?, class_teacher_id) WHERE id = ?`)
        .bind(capacity, nullStr(str(req.room)), teacher, existing.id).run()
      return created({ id: existing.id, name })
    }
    const id = uuid()
    await c.db.prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name, capacity, room, class_teacher_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, instId(c), campus, classId, yearId, name, capacity, nullStr(str(req.room)), teacher, now()).run()
    return created({ id, name })
  })

  r.patch('/setup/sections/{id}', 'academics.write', async (c) => {
    const sectionId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    let name: string | null = null
    if (has(req, 'name')) { name = str(req.name).trim(); if (name === '') throw badRequest('a section needs a name, a letter, or whatever this school calls it') }
    const capacity = has(req, 'capacity') ? asInt(req.capacity) : null
    if (capacity !== null && capacity <= 0) throw badRequest('capacity must be at least one')
    const row = await c.db.prepare(`SELECT s.name, (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id AND e.status = 'active') AS enrolled
        FROM sections s WHERE s.id = ?`).bind(sectionId).first<{ name: string; enrolled: number }>()
    if (!row) throw badRequest('no such section in this school')
    if (capacity !== null && capacity < row.enrolled) throw badRequest('that capacity is below the number of children already in the section')
    const room = has(req, 'room') ? str(req.room) : null
    const teacher = has(req, 'class_teacher_id') ? str(req.class_teacher_id) : null
    try {
      await c.db.prepare(`UPDATE sections SET name = COALESCE(?, name), capacity = COALESCE(?, capacity),
          room = CASE WHEN ? IS NULL THEN room ELSE NULLIF(?, '') END,
          class_teacher_id = CASE WHEN ? IS NULL THEN class_teacher_id ELSE NULLIF(?, '') END WHERE id = ?`)
        .bind(name, capacity, room, room, teacher, teacher, sectionId).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw badRequest('this class already has a section with that name')
      throw e
    }
    return ok({ id: sectionId, name: name ?? row.name, enrolled: row.enrolled })
  })

  r.del('/setup/sections/{id}', 'academics.write', async (c) => {
    const sectionId = uuidParam(c.params.id)
    const row = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) AS enrolled FROM sections s WHERE s.id = ?`)
      .bind(sectionId).first<{ enrolled: number }>()
    if (!row) throw badRequest('no such section in this school')
    if (row.enrolled > 0) {
      throw badRequest('this section has enrolments against it, including past years, rename it instead, ' +
        'or move the children out first. Deleting it would take their register with it')
    }
    await c.db.prepare(`DELETE FROM sections WHERE id = ?`).bind(sectionId).run()
    return ok({ deleted: sectionId })
  })

  /* --- subjects --- */

  r.post('/setup/subjects', 'academics.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name)
    if (name.trim() === '') throw badRequest('a subject needs a name')
    const scholastic = has(req, 'is_scholastic') && req.is_scholastic !== null ? (req.is_scholastic === true ? 1 : 0) : 1
    let code = str(req.code).trim().toUpperCase()
    const campus = await ensureCampus(c)
    const inst = instId(c)
    if (code === '') code = await uniqueSubjectCode(c, campus, name)
    const existing = await c.db.prepare(`SELECT id FROM subjects WHERE institution_id = ? AND campus_id = ? AND code = ?`).bind(inst, campus, code).first<{ id: string }>()
    if (existing) {
      await c.db.prepare(`UPDATE subjects SET name = ?, is_scholastic = ? WHERE id = ?`).bind(name, scholastic, existing.id).run()
      return created({ id: existing.id, code })
    }
    const id = uuid()
    await c.db.prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code, is_scholastic, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst, campus, name, code, scholastic, now()).run()
    return created({ id, code })
  })

  r.patch('/setup/subjects/{id}', 'academics.write', async (c) => {
    const subjectId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    let name: string | null = null, code: string | null = null
    if (has(req, 'name')) { name = str(req.name).trim(); if (name === '') throw badRequest('a subject needs both a name and a code') }
    if (has(req, 'code')) { code = str(req.code).trim(); if (code === '') throw badRequest('a subject needs both a name and a code') }
    const scholastic = has(req, 'is_scholastic') && req.is_scholastic !== null ? (req.is_scholastic === true ? 1 : 0) : null
    let res: D1Result
    try {
      res = await c.db.prepare(`UPDATE subjects SET name = COALESCE(?, name), code = COALESCE(?, code), is_scholastic = COALESCE(?, is_scholastic) WHERE id = ?`)
        .bind(name, code, scholastic, subjectId).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw refTaken('subject')
      throw e
    }
    if (!res.meta.changes) throw refGone('subject')
    return ok({ id: subjectId })
  })

  r.del('/setup/subjects/{id}', 'academics.write', async (c) => {
    const subjectId = uuidParam(c.params.id)
    const row = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM class_subjects WHERE subject_id = s.id) AS taught FROM subjects s WHERE s.id = ?`)
      .bind(subjectId).first<{ taught: number }>()
    if (!row) throw refGone('subject')
    if (row.taught > 0) {
      throw badRequest('this subject is taught in ' + plural(row.taught, 'class', 'classes') + '. Unmap it there first, deleting it would take the marks with it')
    }
    await c.db.prepare(`DELETE FROM subjects WHERE id = ?`).bind(subjectId).run()
    return ok({ id: subjectId })
  })

  /* --- periods --- */

  r.put('/setup/periods', 'academics.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const periods = Array.isArray(req.periods) ? (req.periods as Record<string, unknown>[]) : []
    if (periods.length === 0) throw badRequest('at least one period is required')
    const seen = new Set<number>()
    for (const p of periods) {
      const name = str(p.name), startsAt = str(p.starts_at), endsAt = str(p.ends_at)
      if (name === '' || startsAt === '' || endsAt === '') throw badRequest('every period needs a name, a start time and an end time')
      if (startsAt >= endsAt) throw badRequest(name + ' ends before it starts')
      const seq = asInt(p.sequence)
      if (seen.has(seq)) throw badRequest('two periods share the same sequence number')
      seen.add(seq)
    }
    const campus = await ensureCampus(c)
    const inst = instId(c)
    const scheduleName = str(req.schedule_name).trim()
    let schedule: string
    if (scheduleName === '') {
      const row = await c.db.prepare(`SELECT id FROM bell_schedules WHERE institution_id = ? ORDER BY is_default DESC, created_at LIMIT 1`).bind(inst).first<{ id: string }>()
      if (row) schedule = row.id
      else {
        schedule = uuid()
        await c.db.prepare(`INSERT INTO bell_schedules (id, institution_id, campus_id, name, is_default, created_at) VALUES (?, ?, ?, 'Standard day', 1, ?)`).bind(schedule, inst, campus, now()).run()
      }
    } else {
      const row = await c.db.prepare(`SELECT id FROM bell_schedules WHERE institution_id = ? AND lower(name) = lower(?)`).bind(inst, scheduleName).first<{ id: string }>()
      if (row) schedule = row.id
      else {
        schedule = uuid()
        await c.db.prepare(`INSERT INTO bell_schedules (id, institution_id, campus_id, name, is_default, created_at) VALUES (?, ?, ?, ?, 0, ?)`).bind(schedule, inst, campus, scheduleName, now()).run()
      }
    }
    const stmts: D1PreparedStatement[] = []
    for (const p of periods) {
      stmts.push(c.db.prepare(`INSERT INTO periods (id, institution_id, campus_id, bell_schedule_id, name, sequence, starts_at, ends_at, is_break)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (bell_schedule_id, sequence) DO UPDATE SET name = excluded.name,
          starts_at = excluded.starts_at, ends_at = excluded.ends_at, is_break = excluded.is_break`)
        .bind(uuid(), inst, campus, schedule, str(p.name), asInt(p.sequence), str(p.starts_at), str(p.ends_at), p.is_break === true ? 1 : 0))
    }
    const classIds = Array.isArray(req.class_ids) ? (req.class_ids as unknown[]).map(str).filter(isUUID) : []
    for (const cid of classIds) stmts.push(c.db.prepare(`UPDATE classes SET bell_schedule_id = ? WHERE institution_id = ? AND id = ?`).bind(schedule, inst, cid))
    await batch(c, stmts)
    return ok({ periods: periods.length })
  })

  /* --- class subjects --- */

  r.get('/setup/class-subjects', 'academics.read', async (c) => {
    requireInstitution(c)
    const classId = nullStr(c.url.searchParams.get('class_id'))
    const rows = await c.db.prepare(`SELECT cs.id, c.id AS class_id, c.name AS class_name, sub.id AS subject_id, sub.name AS subject_name, cs.max_marks,
        (SELECT COUNT(*) FROM section_subject_teachers t WHERE t.class_subject_id = cs.id) AS sections_taught,
        (SELECT COUNT(*) FROM sections sec WHERE sec.class_id = c.id AND NOT EXISTS (SELECT 1 FROM section_subject_teachers t WHERE t.class_subject_id = cs.id AND t.section_id = sec.id)) AS sections_unassigned,
        (SELECT u.full_name FROM section_subject_teachers t JOIN users u ON u.id = t.teacher_user_id WHERE t.class_subject_id = cs.id LIMIT 1) AS a_teacher
        FROM class_subjects cs JOIN classes c ON c.id = cs.class_id JOIN subjects sub ON sub.id = cs.subject_id
        WHERE (? IS NULL OR cs.class_id = ?) ORDER BY c.level, sub.name`).bind(classId, classId).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const o: Record<string, unknown> = { id: v.id, class_id: v.class_id, class_name: v.class_name, subject_id: v.subject_id, subject_name: v.subject_name }
      if (v.max_marks !== null) o.max_marks = v.max_marks
      o.sections_taught = Number(v.sections_taught)
      o.sections_unassigned = Number(v.sections_unassigned)
      if (v.a_teacher !== null) o.a_teacher = v.a_teacher
      return o
    })
    return ok({ items })
  })

  r.put('/setup/class-subjects', 'academics.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const classId = str(req.class_id)
    if (!isUUID(classId)) throw badRequest('class_id must be a uuid')
    let maxMarks = asInt(req.max_marks)
    if (maxMarks <= 0) maxMarks = 100
    const raw = Array.isArray(req.subject_ids) ? (req.subject_ids as unknown[]).map(str) : []
    const wanted = raw.filter(isUUID)
    const stmts: D1PreparedStatement[] = []
    // Only drop offerings nobody has been timetabled or examined against.
    const keep = `AND cs.subject_id NOT IN (SELECT value FROM json_each(?))`
    stmts.push(c.db.prepare(`DELETE FROM class_subjects WHERE id IN (SELECT cs.id FROM class_subjects cs WHERE cs.class_id = ? ${keep}
        AND NOT EXISTS (SELECT 1 FROM exam_subjects es WHERE es.class_subject_id = cs.id)
        AND NOT EXISTS (SELECT 1 FROM timetable_entries te WHERE te.class_subject_id = cs.id))`).bind(classId, JSON.stringify(wanted)))
    let linked = 0
    for (const sid of raw) {
      if (!isUUID(sid)) continue
      stmts.push(c.db.prepare(`INSERT OR IGNORE INTO class_subjects (id, institution_id, class_id, subject_id, max_marks) VALUES (?, ?, ?, ?, ?)`)
        .bind(uuid(), instId(c), classId, sid, maxMarks))
      linked++
    }
    await batch(c, stmts)
    return ok({ subjects: linked })
  })

  r.post('/setup/class-teacher', 'academics.write', async (c) => {
    requireInstitution(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const sec = str(req.section_id)
    if (!isUUID(sec)) throw badRequest('section_id must be a uuid')
    let teacher: string | null = null
    if (str(req.teacher_user_id).trim() !== '') {
      if (!isUUID(str(req.teacher_user_id))) throw badRequest('teacher_user_id must be a uuid')
      teacher = str(req.teacher_user_id)
    }
    let empId: string | null = null
    if (teacher === null && str(req.employee_id).trim() !== '') {
      if (!isUUID(str(req.employee_id))) throw badRequest('employee_id must be a uuid')
      empId = str(req.employee_id)
    }
    let provisioned = false
    const stmts: D1PreparedStatement[] = []
    if (empId) {
      const e = await c.db.prepare(`SELECT user_id, TRIM(first_name || ' ' || COALESCE(last_name, '')) AS name, COALESCE(employee_code, '') AS code FROM employees WHERE id = ?`)
        .bind(empId).first<{ user_id: string | null; name: string; code: string }>()
      if (!e) throw new Error('no rows in result set')
      if (e.user_id) teacher = e.user_id
      else {
        const username = await uniqueUsername(c, e.code.trim() === '' ? e.name : e.code)
        const newId = uuid()
        const t = now()
        stmts.push(c.db.prepare(`INSERT INTO users (id, institution_id, username, full_name, status, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 'invited', 1, ?, ?)`)
          .bind(newId, instId(c), username, e.name, t, t))
        stmts.push(c.db.prepare(`UPDATE employees SET user_id = ?, updated_at = ? WHERE id = ?`).bind(newId, t, empId))
        teacher = newId
        provisioned = true
      }
    }
    // One teacher, one section: choosing somebody moves them off the section they held.
    if (teacher) stmts.push(c.db.prepare(`UPDATE sections SET class_teacher_id = NULL WHERE class_teacher_id = ? AND id <> ?`).bind(teacher, sec))
    stmts.push(c.db.prepare(`UPDATE sections SET class_teacher_id = ? WHERE id = ?`).bind(teacher, sec))
    const res = await batch(c, stmts)
    if (!changes(res[res.length - 1])) throw notFound('resource not found')
    const out: Record<string, unknown> = { section_id: sec }
    if (provisioned) out.login_created = true
    return ok(out)
  })

  r.post('/setup/assign-teacher', 'academics.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const sec = str(req.section_id), cs = str(req.class_subject_id), teacher = str(req.teacher_user_id)
    if (!isUUID(sec)) throw badRequest('section_id must be a uuid')
    if (!isUUID(cs)) throw badRequest('class_subject_id must be a uuid')
    if (!isUUID(teacher)) throw badRequest('teacher_user_id must be a uuid')
    await assignSectionTeacher(c, sec, cs, teacher)
    return ok({ assigned: true })
  })

  /* --- grading scales --- */

  r.get('/setup/grading-scales', 'academics.exams.read', async (c) => {
    const rows = await c.db.prepare(`SELECT g.id, g.name, g.is_default, EXISTS (SELECT 1 FROM exams e WHERE e.grading_scale_id = g.id) AS in_use
        FROM grading_scales g ORDER BY g.is_default DESC, g.name`).all<{ id: string; name: string; is_default: number; in_use: number }>()
    const bands = await c.db.prepare(`SELECT grading_scale_id, grade, min_percent, max_percent, grade_point FROM grade_bands ORDER BY CAST(min_percent AS REAL) DESC`)
      .all<{ grading_scale_id: string; grade: string; min_percent: string; max_percent: string; grade_point: string | null }>()
    const items = rows.results.map((g) => ({
      id: g.id, name: g.name, is_default: bool(g.is_default), in_use: bool(g.in_use),
      bands: bands.results.filter((b) => b.grading_scale_id === g.id).map((b) => {
        const o: Record<string, unknown> = { grade: b.grade, min_percent: Number(b.min_percent), max_percent: Number(b.max_percent) }
        if (b.grade_point !== null) o.grade_point = Number(b.grade_point)
        return o
      }),
    }))
    return ok({ items })
  })

  r.post('/setup/grading-scales', 'academics.exams.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name)
    const bands = Array.isArray(req.bands) ? (req.bands as Record<string, unknown>[]) : []
    if (name.trim() === '' || bands.length === 0) throw badRequest('name and at least one band are required')
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i]
      if (asNum(b.min_percent) > asNum(b.max_percent)) throw badRequest('band ' + str(b.grade) + ' has its minimum above its maximum')
      for (let j = 0; j < bands.length; j++) {
        const o = bands[j]
        if (i !== j && asNum(b.min_percent) <= asNum(o.max_percent) && asNum(o.min_percent) <= asNum(b.max_percent)) {
          throw badRequest('bands ' + str(b.grade) + ' and ' + str(o.grade) + ' overlap')
        }
      }
    }
    const isDefault = req.is_default === true
    const scaleId = uuid()
    const stmts: D1PreparedStatement[] = []
    if (isDefault) stmts.push(c.db.prepare(`UPDATE grading_scales SET is_default = 0 WHERE is_default = 1`))
    stmts.push(c.db.prepare(`INSERT INTO grading_scales (id, institution_id, name, is_default) VALUES (?, ?, ?, ?)`).bind(scaleId, instId(c), name, isDefault ? 1 : 0))
    for (const b of bands) {
      stmts.push(c.db.prepare(`INSERT INTO grade_bands (id, institution_id, grading_scale_id, grade, min_percent, max_percent, grade_point) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), instId(c), scaleId, str(b.grade), String(asNum(b.min_percent)), String(asNum(b.max_percent)), String(asNum(b.grade_point))))
    }
    await batch(c, stmts)
    return created({ id: scaleId, name, bands: bands.length })
  })

  r.del('/setup/grading-scales/{id}', 'academics.exams.write', async (c) => {
    requireInstitution(c)
    const scaleId = uuidParam(c.params.id)
    const used = await c.db.prepare(`SELECT 1 AS x FROM exams WHERE grading_scale_id = ?`).bind(scaleId).first()
    if (used) {
      throw badRequest('an exam has been graded against this scale. Removing it would leave marked papers whose grades cannot be explained. Edit the bands instead.')
    }
    const res = await c.db.batch([
      c.db.prepare(`DELETE FROM grade_bands WHERE grading_scale_id = ?`).bind(scaleId),
      c.db.prepare(`DELETE FROM grading_scales WHERE id = ?`).bind(scaleId),
    ])
    if (!changes(res[1])) throw notFound('resource not found')
    return ok({ deleted: true })
  })

  r.patch('/setup/grading-scales/{id}', 'academics.exams.write', async (c) => {
    const scaleId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (has(req, 'name') && str(req.name).trim() === '') throw badRequest('a grading scale needs a name')
    const isDefault = has(req, 'is_default') ? (req.is_default === true ? 1 : 0) : null
    const stmts = [c.db.prepare(`UPDATE grading_scales SET name = COALESCE(NULLIF(TRIM(?), ''), name), is_default = COALESCE(?, is_default) WHERE id = ?`)
      .bind(has(req, 'name') ? str(req.name) : null, isDefault, scaleId)]
    if (isDefault === 1) stmts.push(c.db.prepare(`UPDATE grading_scales SET is_default = 0 WHERE institution_id = ? AND id <> ?`).bind(instId(c), scaleId))
    const res = await batch(c, stmts)
    if (!changes(res[0])) throw refGone('grading scale')
    return ok({ id: scaleId })
  })

  /* --- exams --- */

  r.post('/setup/exams', 'academics.exams.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name)
    if (name.trim() === '') throw badRequest('name is required')
    let kind = str(req.kind)
    if (kind === '') kind = 'term'
    const cce = str(req.cce_component)
    let maxMarks = asInt(req.max_marks)
    if (maxMarks <= 0) maxMarks = cce.startsWith('FA') ? 20 : cce.startsWith('SA') ? 80 : 100
    const campus = await ensureCampus(c)
    const yearId = await workingYearId(c, str(req.academic_year_id))
    if (!yearId) throw badRequest('create an academic year before adding exams')
    let scale = str(req.grading_scale_id)
    if (scale === '') {
      const d = await c.db.prepare(`SELECT id FROM grading_scales ORDER BY is_default DESC LIMIT 1`).first<{ id: string }>()
      scale = d?.id ?? ''
    }
    const classIds = Array.isArray(req.class_ids) ? (req.class_ids as unknown[]).map(str).filter(isUUID) : []
    const allClasses = classIds.length === 0
    const where = allClasses ? '' : `WHERE cs.class_id IN (SELECT value FROM json_each(?))`
    const count = await c.db.prepare(`SELECT COUNT(*) AS n FROM class_subjects cs ${where}`).bind(...(allClasses ? [] : [JSON.stringify(classIds)])).first<{ n: number }>()
    const papers = count?.n ?? 0
    if (papers === 0) {
      throw badRequest('no papers could be created, because none of the classes chosen have subjects attached yet. Set up class subjects first, then schedule the exam.')
    }
    const examId = uuid()
    const passMarks = Math.max(1, Math.round(maxMarks * 0.33))
    await c.db.batch([
      c.db.prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on, grading_scale_id, cce_component, board, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(examId, instId(c), campus, yearId, name, kind, nullStr(str(req.starts_on)), nullStr(str(req.ends_on)), nullStr(scale), nullStr(cce), nullStr(str(req.board)), now()),
      // Rows need a uuid each; hex(randomblob) is SQLite's way to mint one per row.
      c.db.prepare(`INSERT OR IGNORE INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks)
          SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-a' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
                 ?, ?, cs.id, ?, ? FROM class_subjects cs ${where}`).bind(instId(c), examId, String(maxMarks), String(passMarks), ...(allClasses ? [] : [JSON.stringify(classIds)])),
    ])
    return created({ id: examId, name, papers, max_marks: maxMarks })
  })

  r.patch('/setup/exams/{id}', 'academics.exams.write', async (c) => {
    const examId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (has(req, 'name') && str(req.name).trim() === '') throw badRequest('an exam needs a name')
    if (has(req, 'kind') && !['unit_test', 'periodic', 'term', 'practical', 'internal', 'formative', 'summative', 'board'].includes(str(req.kind).trim())) {
      throw badRequest('kind must be one of unit_test, periodic, term, practical, internal, formative, summative, board')
    }
    const startsOn = has(req, 'starts_on') ? str(req.starts_on) : null
    const endsOn = has(req, 'ends_on') ? str(req.ends_on) : null
    const scale = has(req, 'grading_scale_id') ? str(req.grading_scale_id) : null
    const res = await c.db.prepare(`UPDATE exams SET name = COALESCE(NULLIF(TRIM(?), ''), name), kind = COALESCE(NULLIF(?, ''), kind),
        starts_on = CASE WHEN ? IS NULL THEN starts_on ELSE NULLIF(?, '') END,
        ends_on = CASE WHEN ? IS NULL THEN ends_on ELSE NULLIF(?, '') END,
        grading_scale_id = CASE WHEN ? IS NULL THEN grading_scale_id ELSE NULLIF(?, '') END WHERE id = ?`)
      .bind(has(req, 'name') ? str(req.name) : null, has(req, 'kind') ? str(req.kind) : null, startsOn, startsOn, endsOn, endsOn, scale, scale, examId).run()
    if (!res.meta.changes) throw refGone('exam')
    return ok({ id: examId })
  })

  r.del('/setup/exams/{id}', 'academics.exams.write', async (c) => {
    const examId = uuidParam(c.params.id)
    const row = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id WHERE es.exam_id = e.id) AS marks,
        (SELECT COUNT(*) FROM report_cards rc WHERE rc.exam_id = e.id) AS cards FROM exams e WHERE e.id = ?`).bind(examId).first<{ marks: number; cards: number }>()
    if (!row) throw refGone('exam')
    if (row.marks > 0 || row.cards > 0) {
      throw badRequest(plural(row.marks, 'mark', 'marks') + ' and ' + plural(row.cards, 'report card', 'report cards') +
        ' belong to this exam. Deleting it would take them with it · if this is the wrong exam, check which one your teachers have been entering into')
    }
    await c.db.batch([c.db.prepare(`DELETE FROM exam_subjects WHERE exam_id = ?`).bind(examId), c.db.prepare(`DELETE FROM exams WHERE id = ?`).bind(examId)])
    return ok({ id: examId })
  })

  /* --- fee heads --- */

  r.get('/setup/fee-heads', 'finance.fees.read', async (c) => {
    requireInstitution(c)
    const rows = await c.db.prepare(`SELECT h.id, h.name, h.code, h.is_recurring, h.hsn_sac,
        (SELECT COUNT(*) FROM fee_structure_items i WHERE i.fee_head_id = h.id) AS used_in, h.optional,
        (SELECT COUNT(*) FROM student_fee_optins o WHERE o.fee_head_id = h.id AND o.ended_on IS NULL) AS chosen_by
        FROM fee_heads h ORDER BY h.name`).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const o: Record<string, unknown> = { id: v.id, name: v.name, code: v.code, is_recurring: bool(v.is_recurring) }
      if (v.hsn_sac !== null) o.hsn_sac = v.hsn_sac
      o.used_in = Number(v.used_in)
      o.optional = bool(v.optional)
      o.chosen_by = Number(v.chosen_by)
      return o
    })
    return ok({ items })
  })

  r.post('/setup/fee-heads', 'finance.fees.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name), rawCode = str(req.code)
    if (name === '' || rawCode === '') throw badRequest('name and code are required')
    const gst = asInt(req.gst_rate_bp)
    if (gst < 0 || gst > 10000) throw badRequest('gst_rate_bp must be between 0 and 10000 (basis points)')
    const recurring = has(req, 'is_recurring') && req.is_recurring !== null ? (req.is_recurring === true ? 1 : 0) : 1
    const code = rawCode.toUpperCase()
    const inst = instId(c)
    const existing = await c.db.prepare(`SELECT id FROM fee_heads WHERE institution_id = ? AND code = ?`).bind(inst, code).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    if (existing) {
      await c.db.prepare(`UPDATE fee_heads SET name = ?, is_recurring = ?, is_taxable = ?, gst_rate_bp = ?, hsn_sac = ?, optional = ? WHERE id = ?`)
        .bind(name, recurring, req.is_taxable === true ? 1 : 0, gst, nullStr(str(req.hsn_sac)), req.optional === true ? 1 : 0, id).run()
    } else {
      await c.db.prepare(`INSERT INTO fee_heads (id, institution_id, name, code, is_recurring, is_taxable, gst_rate_bp, hsn_sac, optional, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst, name, code, recurring, req.is_taxable === true ? 1 : 0, gst, nullStr(str(req.hsn_sac)), req.optional === true ? 1 : 0, now()).run()
    }
    return created({ id, code })
  })

  r.patch('/setup/fee-heads/{id}', 'finance.fees.write', async (c) => {
    const headId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    let name: string | null = null, code: string | null = null
    if (has(req, 'name')) { name = str(req.name).trim(); if (name === '') throw badRequest('a fee head needs both a name and a code') }
    if (has(req, 'code')) { code = str(req.code).trim(); if (code === '') throw badRequest('a fee head needs both a name and a code') }
    const flag = (k: string) => (has(req, k) && req[k] !== null ? (req[k] === true ? 1 : 0) : null)
    let res: D1Result
    try {
      res = await c.db.prepare(`UPDATE fee_heads SET name = COALESCE(?, name), code = COALESCE(?, code), is_refundable = COALESCE(?, is_refundable),
          is_recurring = COALESCE(?, is_recurring), optional = COALESCE(?, optional) WHERE id = ?`)
        .bind(name, code, flag('is_refundable'), flag('is_recurring'), flag('optional'), headId).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw refTaken('fee head')
      throw e
    }
    if (!res.meta.changes) throw refGone('fee head')
    return ok({ id: headId })
  })

  r.del('/setup/fee-heads/{id}', 'finance.fees.write', async (c) => {
    const headId = uuidParam(c.params.id)
    const row = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM fee_structure_items WHERE fee_head_id = h.id) AS used FROM fee_heads h WHERE h.id = ?`)
      .bind(headId).first<{ used: number }>()
    if (!row) throw refGone('fee head')
    if (row.used > 0) {
      throw badRequest('this head is in ' + plural(row.used, 'fee structure', 'fee structures') +
        ' and has been billed against. Rename it instead, deleting it would orphan money already collected')
    }
    await c.db.prepare(`DELETE FROM fee_heads WHERE id = ?`).bind(headId).run()
    return ok({ id: headId })
  })

  /* --- fee opt-ins --- */

  r.get('/setup/fee-heads/{id}/optins', 'finance.fees.read', async (c) => {
    requireInstitution(c)
    const headId = uuidParam(c.params.id)
    const yearId = nullStr(c.url.searchParams.get('academic_year_id'))
    const rows = await c.db.prepare(`SELECT s.id AS student_id, TRIM(s.first_name || ' ' || COALESCE(s.middle_name || ' ', '') || COALESCE(s.last_name, '')) AS name,
        COALESCE(s.admission_no, '') AS admission_no, COALESCE(c.name, '') AS class_name, (o.id IS NOT NULL) AS chosen, COALESCE(o.chosen_on, '') AS chosen_on
        FROM enrollments e JOIN students s ON s.id = e.student_id LEFT JOIN classes c ON c.id = e.class_id
        LEFT JOIN student_fee_optins o ON o.student_id = s.id AND o.fee_head_id = ? AND o.academic_year_id = e.academic_year_id AND o.ended_on IS NULL
        WHERE e.academic_year_id = COALESCE(?, (SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1)) AND e.status = 'active'
        ORDER BY c.name IS NULL, c.name, name`).bind(headId, yearId).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const o: Record<string, unknown> = { student_id: v.student_id, name: v.name, admission_no: v.admission_no, class_name: v.class_name, chosen: bool(v.chosen) }
      if (v.chosen_on) o.chosen_on = String(v.chosen_on).slice(0, 10)
      return o
    })
    return ok({ items })
  })

  r.put('/setup/fee-heads/{id}/optins', 'finance.fees.write', async (c) => {
    requireInstitution(c)
    const headId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const students: string[] = []
    for (const raw of Array.isArray(req.student_ids) ? (req.student_ids as unknown[]) : []) {
      if (!isUUID(str(raw))) throw badRequest('one of the students is not a valid id')
      students.push(str(raw))
    }
    const yr = await c.db.prepare(`SELECT COALESCE(?, (SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1)) AS id`).bind(nullStr(str(req.academic_year_id))).first<{ id: string | null }>()
    const yearId = yr?.id
    if (!yearId) throw new Error('no academic year')
    const today = todayIndia()
    const notIn = `AND student_id NOT IN (SELECT value FROM json_each(?))`
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`UPDATE student_fee_optins SET ended_on = ? WHERE fee_head_id = ? AND academic_year_id = ? AND ended_on IS NULL ${notIn}`).bind(today, headId, yearId, JSON.stringify(students)),
    ]
    for (const sid of students) {
      // student_fee_optins_one_live: inserted unless already live.
      stmts.push(c.db.prepare(`INSERT INTO student_fee_optins (id, institution_id, student_id, academic_year_id, fee_head_id, chosen_on, note, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM student_fee_optins WHERE student_id = ? AND fee_head_id = ? AND academic_year_id = ? AND ended_on IS NULL)`)
        .bind(uuid(), instId(c), sid, yearId, headId, today, nullStr(str(req.note)), now(), sid, headId, yearId))
    }
    const res = await batch(c, stmts)
    const ended = changes(res[0])
    let added = 0
    for (let i = 1; i < res.length; i++) added += changes(res[i])
    return ok({ taking: students.length, added, ended, as_of: today })
  })

  r.get('/setup/fee-classes', 'finance.fees.read', async (c) => {
    const rows = await c.db.prepare(`SELECT id, name, level, stream FROM classes ORDER BY level, name`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => { const o: Record<string, unknown> = { id: v.id, name: v.name, level: v.level }; if (v.stream !== null) o.stream = v.stream; return o }) })
  })

  /* --- fee structures --- */

  r.post('/setup/fee-structures', 'finance.fees.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name)
    if (name.trim() === '') throw badRequest('name is required')
    const items = Array.isArray(req.items) ? (req.items as Record<string, unknown>[]) : []
    if (items.length === 0) throw badRequest('a fee structure needs at least one line')
    for (const it of items) if (asNum(it.amount_paise) < 0) throw badRequest('amounts cannot be negative')
    let appliesTo = str(req.applies_to)
    if (appliesTo === '') appliesTo = 'all'
    const campus = await ensureCampus(c)
    const yearId = await workingYearId(c, str(req.academic_year_id))
    if (!yearId) throw badRequest('create an academic year before adding fee structures')
    const id = uuid()
    const stmts = [c.db.prepare(`INSERT INTO fee_structures (id, institution_id, campus_id, academic_year_id, class_id, name, applies_to, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind(id, instId(c), campus, yearId, nullStr(str(req.class_id)), name, appliesTo, now())]
    let total = 0
    for (const it of items) {
      const head = str(it.fee_head_id)
      if (!isUUID(head)) throw new Error('invalid UUID for fee_head_id')
      let inst = asInt(it.instalment_no)
      if (inst <= 0) inst = 1
      const amount = Math.trunc(asNum(it.amount_paise))
      stmts.push(c.db.prepare(`INSERT INTO fee_structure_items (id, institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise, due_on) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (fee_structure_id, fee_head_id, instalment_no) DO UPDATE SET amount_paise = excluded.amount_paise, due_on = excluded.due_on`)
        .bind(uuid(), instId(c), id, head, inst, amount, nullStr(str(it.due_on))))
      total += amount
    }
    await c.db.batch(stmts)
    return created({ id, name, lines: items.length, total_paise: total })
  })

  r.get('/setup/fee-structures', 'finance.fees.read', async (c) => {
    const rows = await c.db.prepare(`SELECT fs.id, fs.name, c.name AS class_name, fs.applies_to,
        (SELECT COUNT(*) FROM fee_structure_items i WHERE i.fee_structure_id = fs.id) AS lines,
        COALESCE((SELECT SUM(amount_paise) FROM fee_structure_items i WHERE i.fee_structure_id = fs.id), 0) AS total_paise, fs.is_active
        FROM fee_structures fs LEFT JOIN classes c ON c.id = fs.class_id ORDER BY c.level IS NOT NULL, c.level, fs.name`).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const o: Record<string, unknown> = { id: v.id, name: v.name }
      if (v.class_name !== null) o.class_name = v.class_name
      if (v.applies_to !== null) o.applies_to = v.applies_to
      o.lines = Number(v.lines)
      o.total_paise = Number(v.total_paise)
      o.is_active = bool(v.is_active)
      return o
    })
    return ok({ items })
  })

  r.del('/setup/fee-structures/{id}', 'finance.fees.write', async (c) => {
    const target = uuidParam(c.params.id)
    const row = await c.db.prepare(`SELECT name FROM fee_structures WHERE id = ?`).bind(target).first<{ name: string }>()
    if (!row) throw notFound('resource not found')
    // fee_structure_items, fee_fine_rules and fee_structure_versions cascade with it.
    await c.db.prepare(`DELETE FROM fee_structures WHERE id = ?`).bind(target).run()
    return ok({ deleted: row.name, note: 'Invoices already raised are unaffected. This was the price list, not the bills.' })
  })

  r.patch('/setup/fee-structures/{id}', 'finance.fees.write', async (c) => {
    const structureId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (has(req, 'name') && str(req.name).trim() === '') throw badRequest('a fee structure needs a name')
    const isActive = has(req, 'is_active') && req.is_active !== null ? (req.is_active === true ? 1 : 0) : null
    const res = await c.db.prepare(`UPDATE fee_structures SET name = COALESCE(NULLIF(TRIM(?), ''), name), applies_to = COALESCE(NULLIF(?, ''), applies_to),
        is_active = COALESCE(?, is_active) WHERE id = ?`).bind(has(req, 'name') ? str(req.name) : null, has(req, 'applies_to') ? str(req.applies_to) : null, isActive, structureId).run()
    if (!res.meta.changes) throw refGone('fee structure')
    if (!has(req, 'items') || !Array.isArray(req.items)) return ok({ id: structureId })
    // Changing the price after billing is a different act.
    let billed = -1
    try {
      const b = await c.db.prepare(`SELECT COUNT(*) AS n FROM invoices i WHERE i.fee_structure_version_id IN (SELECT v.id FROM fee_structure_versions v WHERE v.fee_structure_id = ?)
          OR EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.fee_head_id IN (SELECT fee_head_id FROM fee_structure_items WHERE fee_structure_id = ?))`)
        .bind(structureId, structureId).first<{ n: number }>()
      billed = b?.n ?? -1
    } catch { billed = -1 }
    if (billed !== 0) {
      throw badRequest('bills have already been raised from this structure, so its amounts cannot be rewritten, the demands already with families would ' +
        'stop matching it. Rename it and build the corrected one beside it')
    }
    const stmts = [c.db.prepare(`DELETE FROM fee_structure_items WHERE fee_structure_id = ?`).bind(structureId)]
    for (const it of req.items as Record<string, unknown>[]) {
      if (str(it.fee_head_id).trim() === '' || asNum(it.amount_paise) < 0) continue
      let inst = asInt(it.instalment_no)
      if (inst <= 0) inst = 1
      stmts.push(c.db.prepare(`INSERT INTO fee_structure_items (id, institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise, due_on) VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''))`)
        .bind(uuid(), instId(c), structureId, str(it.fee_head_id), inst, Math.trunc(asNum(it.amount_paise)), str(it.due_on)))
    }
    await c.db.batch(stmts)
    return ok({ id: structureId })
  })

  /* --- readiness --- */

  r.get('/setup/status', 'institution.read', async (c) => {
    requireInstitution(c)
    const inst = instId(c)
    const v = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM campuses) AS campuses, (SELECT COUNT(*) FROM academic_years) AS years,
        (SELECT COUNT(*) FROM classes) AS classes, (SELECT COUNT(*) FROM sections) AS sections, (SELECT COUNT(*) FROM subjects) AS subjects,
        (SELECT COUNT(*) FROM periods) AS periods, (SELECT COUNT(*) FROM class_subjects) AS class_subjects,
        (SELECT COUNT(*) FROM (SELECT teacher_user_id FROM section_subject_teachers UNION SELECT class_teacher_id FROM sections WHERE class_teacher_id IS NOT NULL) x) AS teachers,
        (SELECT COUNT(*) FROM students WHERE status = 'active') AS students, (SELECT COUNT(*) FROM fee_heads) AS fee_heads,
        (SELECT COUNT(*) FROM fee_structures) AS fee_structures, (SELECT COUNT(*) FROM grading_scales) AS grading_scales, (SELECT COUNT(*) FROM exams) AS exams,
        ((SELECT COUNT(*) FROM student_year_history) + (SELECT COUNT(*) FROM employee_year_history)) AS history,
        COALESCE((SELECT district IS NOT NULL AND state IS NOT NULL AND affiliation_board IS NOT NULL FROM institutions WHERE id = ?), 0) AS profile_done,
        COALESCE((SELECT udise_code IS NOT NULL FROM institutions WHERE id = ?), 0) AS has_udise,
        COALESCE((SELECT upi_vpa IS NOT NULL FROM institutions WHERE id = ?), 0) AS has_upi`).bind(inst, inst, inst).first<Record<string, number>>()
    if (!v) throw new Error('status query returned nothing')
    const n = (k: string) => Number(v[k] ?? 0)
    const step = (key: string, label: string, done: boolean, count: number, detail: string, blocking: boolean) => ({ key, label, done, count, detail, blocking })
    const steps = [
      step('profile', "Confirm the school's details", bool(v.profile_done), 0, 'Name, board, district and mandal. The header on every document.', true),
      step('campus', 'Add your campus', n('campuses') > 0, n('campuses'), 'Address, and the campus every class belongs to.', true),
      step('academic_year', 'Open the academic year', n('years') > 0, n('years'), 'June to April for most Telangana schools.', true),
      step('classes', 'Create classes and their sections', n('classes') > 0 && n('sections') > 0, n('classes'), 'Class 1 to 10, each with its sections and how many seats they hold.', true),
      step('subjects', 'Add subjects and who studies them', n('subjects') > 0 && n('class_subjects') > 0, n('subjects'), 'Which class studies what, and the teacher who takes it.', true),
      step('periods', 'Define the school day', n('periods') > 0, n('periods'), 'Periods and breaks, in order.', false),
      step('staff', 'Add staff', n('teachers') > 0, n('teachers'), 'Teachers, the office, accounts and HR. Each with the role that matches the job.', true),
      step('students', 'Enrol students', n('students') > 0, n('students'), 'Admit individually or import from a spreadsheet.', true),
      step('grading', 'Set up a grading scale', n('grading_scales') > 0, n('grading_scales'), 'Marks cannot become grades without it.', false),
      step('fee_heads', 'Define fee heads', n('fee_heads') > 0, n('fee_heads'), 'Tuition, transport, lab.', false),
      step('fee_structures', 'Build fee structures', n('fee_structures') > 0, n('fee_structures'), 'What each class pays, and when.', false),
      step('payments', 'Set up payment collection', bool(v.has_upi), 0, "The school's UPI ID, so families get a scannable code on their fee screen and the counter shows one. Optional; the office can always record a payment by hand.", false),
      step('exams', 'Schedule an exam', n('exams') > 0, n('exams'), 'Papers can be generated for every class at once.', false),
      step('history', 'Carry your past years across', n('history') > 0, n('history'), 'Optional, and only for a school that was running before this. Past results, attendance and fees for children and staff, uploaded once per file however many years it covers.', false),
      step('udise', 'Record the UDISE+ code', bool(v.has_udise), 0, 'Eleven digits. Required before the annual return can be filed.', false),
      step('reset', 'Clear everything and start again', true, 0, "For a school that has finished trying this out and wants to put its real records in. Deletes what the school has recorded and keeps the logins, the school's details and the academic year.", false),
    ]
    let done = 0, blocking = 0
    for (const s of steps) { if (s.done) done++; else if (s.blocking) blocking++ }
    return ok({ steps, completed: done, total: steps.length, blocking_remaining: blocking, ready: blocking === 0 })
  })
}

/**
 * The one row the allocation grid and the staff record both write. Also
 * does what the section_subject_teachers_one_tenant trigger did: refuses a
 * section or class subject of another school (moot on a per-school
 * database, kept for parity).
 */
export async function assignSectionTeacher(c: Ctx, sectionId: string, classSubjectId: string, teacherUserId: string): Promise<void> {
  const inst = instId(c)
  const sec = await c.db.prepare(`SELECT institution_id FROM sections WHERE id = ?`).bind(sectionId).first<{ institution_id: string }>()
  if (sec && sec.institution_id !== inst) throw new Error(`section ${sectionId} belongs to a different institution than this assignment`)
  const cs = await c.db.prepare(`SELECT institution_id FROM class_subjects WHERE id = ?`).bind(classSubjectId).first<{ institution_id: string }>()
  if (cs && cs.institution_id !== inst) throw new Error(`class subject ${classSubjectId} belongs to a different institution than this assignment`)
  await c.db.prepare(`INSERT INTO section_subject_teachers (id, institution_id, section_id, class_subject_id, teacher_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (section_id, class_subject_id) DO UPDATE SET teacher_user_id = excluded.teacher_user_id`)
    .bind(uuid(), inst, sectionId, classSubjectId, teacherUserId, now()).run()
}

