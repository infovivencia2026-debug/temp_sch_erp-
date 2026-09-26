import type { Ctx, Router } from '../router'
import { HttpError, badRequest, bool, clampInt, created, like, ok, readJSON, uuid, isUUID, now } from '../http'
import {
  addDays, batch, clientIP, coded, endFamilyAccess, errNoAcademicYear, forbiddenMsg, fullNameSQL, indiaToday, inst, isDate,
  isUniqueViolation, nextNumber, notifyStmt, nullStr, parseJSON, reachesStudent, resolveScope, sameName,
  shortNameSQL, str, strOrNull, studentPredicate, workingYear,
} from './students/common'
import {
  IMPORT_TEMPLATE_CSV, SectionFullError, aadhaarTail, checkVocabulary, customValues, firstNonEmpty, isTruthy, knownCategory,
  normaliseDate, normaliseGender, parseCSV, planUpsertStudent, relationIfNamed, sectionLabel, splitName, validCategories,
  validGenders, validateStudent, withUnmapped, type StudentWriteRequest,
} from './students/write'

/* Port of the /students route group (internal/api/api.go lines 223-331):
   students.go, students_write.go, student_delete.go, student_move.go,
   student_photos.go, student_guardians.go, student_exit.go,
   student_detail.go, student_documents.go, the discipline-note and
   support-plan handlers of my_classes.go, saveCoScholasticGrade and the
   activity enrolment handlers. Literal paths are registered before {id}
   paths because the router matches in order. */

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

export function registerStudents(r: Router) {
  // --- conduct notes and support plans ---------------------------------------
  r.get('/students/notes', 'students.read', listDisciplineNotes)
  r.post('/students/notes', 'welfare.discipline.write', recordDisciplineNote)
  r.get('/students/support-plans', 'students.read', listSupportPlans)
  r.put('/students/support-plans', 'students.write', saveSupportPlan)

  // --- literal paths under /students ---------------------------------------------
  r.get('/students/import/template', 'students.read', () =>
    new Response(IMPORT_TEMPLATE_CSV, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="students-template.csv"' } }))
  r.get('/students/fee-preview', 'students.read', admissionFeePreview)
  r.get('/students/counts', 'students.read', studentCounts)
  r.post('/students/import', 'students.write', importStudents)
  r.post('/students/photos/import', 'students.write', importStudentPhotos)

  // --- the roll ---------------------------------------------------------------------
  r.get('/students', 'students.read', listStudents)
  r.post('/students', 'students.write', createStudent)
  r.get('/students/{id}', 'students.read', getStudent)
  r.put('/students/{id}', 'students.write', updateStudent)
  r.del('/students/{id}', 'students.write', deleteStudent)
  r.get('/students/{id}/profile', 'students.read', getStudentProfile)
  r.get('/students/{id}/detail', 'students.read', getStudentDetail)
  r.post('/students/{id}/section', 'students.write', moveStudentSection)
  r.post('/students/{id}/section-change', 'students.write', changeStudentSection)
  r.put('/students/{id}/photo', 'students.write', setStudentPhoto)
  r.put('/students/{id}/guardians/{gid}/photo', 'students.write', setGuardianPhoto)
  r.post('/students/{id}/guardians', 'students.write', saveStudentGuardian)
  r.del('/students/{id}/guardians/{gid}', 'students.write', unlinkStudentGuardian)
  r.post('/students/{id}/exit', 'students.write', recordStudentExit)
  r.post('/students/{id}/readmit', 'students.write', readmitStudent)
  r.post('/students/{id}/suspend', 'students.write', suspendStudent)
  r.post('/students/{id}/co-scholastic', 'academics.marks.write', saveCoScholasticGrade)
  r.post('/students/{id}/activities', 'students.write', enrolInActivity)
  r.post('/students/{id}/activities/{enrolID}/leave', 'students.write', leaveActivity)
  r.post('/students/{id}/custom-fields', 'students.write', saveStudentCustomFields)
  r.patch('/students/{id}/fields', 'students.write', patchStudentFields)
  r.post('/students/{id}/documents', 'students.write', addStudentDocument)
  r.post('/students/{id}/documents/{docID}/verify', 'students.write', verifyStudentDocument)
  r.del('/students/{id}/documents/{docID}', 'students.write', deleteStudentDocument)
}

const sid = (c: Ctx) => { if (!isUUID(c.params.id)) throw badRequest('invalid student id'); return c.params.id }
const notFoundGo = () => new HttpError(404, 'resource not found', { code: 'not_found' })

// --- the list --------------------------------------------------------------------------

interface ListCursor { a: string; i: string; f: string }
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function encodeCursor(cur: ListCursor): string {
  return b64url(new TextEncoder().encode(JSON.stringify(cur)))
}
function decodeCursor(raw: string, filter: string): ListCursor | null {
  if (!raw) return null
  try {
    const pad = raw.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
    const cur = JSON.parse(json) as ListCursor
    if (!cur.i || cur.f !== filter || !isUUID(cur.i)) return null
    return cur
  } catch { return null }
}
async function filterFingerprint(...parts: string[]): Promise<string> {
  const sum = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\x1f')))
  return b64url(new Uint8Array(sum).slice(0, 9))
}

/** The latest enrolment for a student alias, optionally within one year (the LATERAL join in Go). */
const latestEnrolmentJoin = (yearFilter: boolean) => `
  LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id
                                        ${yearFilter ? 'AND (? IS NULL OR e.academic_year_id = ?)' : ''}
                                        ORDER BY e.enrolled_on DESC LIMIT 1)
  LEFT JOIN classes  c   ON c.id = en.class_id
  LEFT JOIN sections sec ON sec.id = en.section_id`

/** The first day of the current academic year, or 1 January (the COALESCE in Go). */
const YEAR_START_SQL = `COALESCE((SELECT starts_on FROM academic_years WHERE is_current = 1 LIMIT 1), ?)`

async function listStudents(c: Ctx) {
  const q = c.url.searchParams
  const limit = clampInt(q.get('limit'), 50, 1, 200)
  const offset = clampInt(q.get('offset'), 0, 0, 1_000_000)
  const search = (q.get('q') ?? '').trim()
  let status = q.get('status') ?? ''
  if (status === '') status = 'active'
  else if (status === 'all') status = ''
  const newThisYear = q.get('new_this_year') === '1'
  const sectionId = isUUID(q.get('section_id')) ? q.get('section_id') : null
  const classId = isUUID(q.get('class_id')) ? q.get('class_id') : null
  const yearId = isUUID(q.get('academic_year_id')) ? q.get('academic_year_id') : null

  const scope = await resolveScope(c)
  const pred = studentPredicate(scope, 'st')
  const fp = await filterFingerprint(status, search, sectionId ?? '', classId ?? '', yearId ?? '', String(newThisYear), pred.sql, pred.args.join(' '))
  const cur = decodeCursor(q.get('cursor') ?? '', fp)
  let withTotal = cur === null
  if (q.get('with_total') === '1') withTotal = true
  if (q.get('with_total') === '0') withTotal = false

  const jan1 = `${indiaToday().slice(0, 4)}-01-01`
  const from = `
    FROM students st ${latestEnrolmentJoin(true)}
   WHERE (? IS NULL OR st.status = ?)
     AND (NOT ? OR st.admission_date >= ${YEAR_START_SQL})
     AND (? IS NULL OR st.admission_no LIKE ? ESCAPE '\\' OR ${fullNameSQL('st')} LIKE ? ESCAPE '\\')
     AND (? IS NULL OR en.section_id = ?)
     AND (? IS NULL OR en.class_id = ?)
     AND (? IS NULL OR (st.admission_no, st.id) > (?, ?))
     AND ${pred.sql}`
  const filterArgs = (curAdm: string | null, curId: string | null) => [
    yearId, yearId,
    nullStr(status), nullStr(status),
    newThisYear ? 1 : 0, jan1,
    nullStr(search), like(search), like(search),
    sectionId, sectionId, classId, classId,
    curAdm, curAdm, curId,
    ...pred.args,
  ]

  const stmts: D1PreparedStatement[] = []
  if (withTotal) stmts.push(c.db.prepare(`SELECT count(*) AS n ${from}`).bind(...filterArgs(null, null)))
  stmts.push(c.db.prepare(`
    SELECT st.id, st.person_code, st.admission_no, ${fullNameSQL('st')} AS full_name,
           st.first_name, st.middle_name, st.last_name, st.gender, st.date_of_birth, st.status, st.admission_date,
           c.name AS class_name, sec.name AS section_name, en.roll_no,
           (SELECT g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1) AS primary_phone
    ${from} ORDER BY st.admission_no, st.id LIMIT ? OFFSET ?`)
    .bind(...filterArgs(cur?.a ?? null, cur?.i ?? null), limit + 1, cur ? 0 : offset))
  const res = await batch(c, stmts)
  const total = withTotal ? (res[0].results[0] as { n: number }).n : undefined
  const rows = res[withTotal ? 1 : 0].results as Record<string, unknown>[]

  const items = rows.map(studentRow)
  const hasMore = items.length > limit
  if (hasMore) items.length = limit
  const out: Record<string, unknown> = { items, limit, offset, has_more: hasMore }
  if (total !== undefined) out.total = total
  if (items.length > 0 && hasMore) {
    const last = items[items.length - 1]
    out.next_cursor = encodeCursor({ a: last.admission_no as string, i: last.id as string, f: fp })
  }
  return ok(out)
}

/** The `student` struct: omitempty pointers are dropped when null. */
function studentRow(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id, admission_no: r.admission_no, full_name: r.full_name, first_name: r.first_name,
    status: r.status, admission_date: r.admission_date,
  }
  for (const k of ['person_code', 'middle_name', 'last_name', 'gender', 'date_of_birth', 'class_name', 'section_name', 'roll_no', 'primary_phone']) {
    if (r[k] !== null && r[k] !== undefined) out[k] = r[k]
  }
  return out
}

async function getStudent(c: Ctx) {
  const id = sid(c)
  const pred = studentPredicate(await resolveScope(c), 'st')
  const row = await c.db.prepare(`
    SELECT st.id, st.admission_no, ${fullNameSQL('st')} AS full_name, st.first_name, st.middle_name, st.last_name, st.gender,
           st.date_of_birth, st.status, st.admission_date, c.name AS class_name, sec.name AS section_name, en.roll_no,
           st.blood_group, st.category, st.religion, st.nationality, st.address_line1, st.city, st.state, st.pincode
      FROM students st ${latestEnrolmentJoin(false)}
     WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first<Record<string, unknown>>()
  if (!row) throw notFoundGo()
  const guardians = await c.db.prepare(`
    SELECT g.id, g.full_name, g.relation, g.phone, g.email, sg.is_primary, g.photo_file_id, sg.portal_blocked, sg.access_until
      FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
     WHERE sg.student_id = ? ORDER BY sg.is_primary DESC, g.full_name`).bind(id).all<Record<string, unknown>>()
  const d = studentRow(row)
  for (const k of ['blood_group', 'category', 'religion', 'address_line1', 'city', 'state', 'pincode']) if (row[k] !== null) d[k] = row[k]
  d.nationality = row.nationality
  d.guardians = guardians.results.map((g) => {
    const o: Record<string, unknown> = { id: g.id, full_name: g.full_name, relation: g.relation, is_primary: bool(g.is_primary), portal_blocked: bool(g.portal_blocked) }
    for (const k of ['phone', 'email', 'access_until', 'photo_file_id']) if (g[k] !== null) o[k] = g[k]
    return o
  })
  return ok(d)
}

async function studentCounts(c: Ctx) {
  const pred = studentPredicate(await resolveScope(c), 'st')
  const jan1 = `${indiaToday().slice(0, 4)}-01-01`
  const row = await c.db.prepare(`
    SELECT COALESCE(SUM(st.status = 'active'), 0) AS active,
           COALESCE(SUM(st.status IN ('transferred','withdrawn','graduated','alumni','inactive')), 0) AS "left",
           COALESCE(SUM(st.status = 'suspended'), 0) AS suspended,
           COALESCE(SUM(st.status = 'active' AND st.admission_date >= ${YEAR_START_SQL}), 0) AS new_this_year
      FROM students st WHERE ${pred.sql}`).bind(jan1, ...pred.args).first<Record<string, number>>()
  return ok({ active: row?.active ?? 0, left: row?.left ?? 0, suspended: row?.suspended ?? 0, new_this_year: row?.new_this_year ?? 0 })
}

// --- create / update / delete ---------------------------------------------------------------

function runUpsertErrors(err: unknown): never {
  if (err instanceof SectionFullError) {
    throw coded(409, 'no_seats', err.message + '. Choose another section, or re-send with allow_overflow to admit anyway.')
  }
  throw err
}

async function createStudent(c: Ctx) {
  const req = await readJSON<StudentWriteRequest>(c.req)
  const bad = validateStudent(req)
  if (bad) throw badRequest(bad)
  await checkVocabulary(c, req)
  let plan
  try { plan = await planUpsertStudent(c, req) } catch (err) { runUpsertErrors(err) }
  await batch(c, plan.stmts)
  return created({ id: plan.studentId, admission_no: plan.admissionNo })
}

async function updateStudent(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<StudentWriteRequest>(c.req)
  const bad = validateStudent(req)
  if (bad) throw badRequest(bad)
  await checkVocabulary(c, req)
  const pred = studentPredicate(await resolveScope(c), 'st')
  const existing = await c.db.prepare(`SELECT st.admission_no FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first<{ admission_no: string }>()
  if (!existing) throw notFoundGo()
  req.admission_no = existing.admission_no // never renumber on edit
  let plan
  try { plan = await planUpsertStudent(c, req) } catch (err) { runUpsertErrors(err) }
  await batch(c, plan.stmts)
  return ok({ id, updated: true })
}

async function deleteStudent(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{ confirm_name?: string; reason?: string }>(c.req)
  const row = await c.db.prepare(`SELECT ${fullNameSQL('st')} AS name FROM students st WHERE st.id = ?`).bind(id).first<{ name: string }>()
  if (!row) throw notFoundGo()
  if (!sameName(str(req.confirm_name), row.name)) throw badRequest("that is not this child's name. Type it exactly as it appears on the record")
  const paid = await c.db.prepare(`SELECT count(*) AS n FROM payments WHERE student_id = ?`).bind(id).first<{ n: number }>()
  if ((paid?.n ?? 0) > 0) {
    throw coded(409, 'student_has_payments',
      'this child has money recorded against them, which is an accounting record and cannot be erased. Use "Record that they have left" instead')
  }
  const res = await c.db.prepare(`DELETE FROM students WHERE id = ?`).bind(id).run()
  if (!res.meta.changes) throw notFoundGo()
  return ok({ deleted: true, name: row.name, note: 'The record and everything attached to it is gone. This cannot be undone from the app.' })
}

// --- moving a child -------------------------------------------------------------------------

async function moveStudentSection(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{ section_id?: string; roll_no?: number; allow_overflow?: boolean }>(c.req)
  const section = str(req.section_id).trim()
  if (!isUUID(section)) throw badRequest('section_id must be a uuid')
  const pred = studentPredicate(await resolveScope(c), 'st')
  const exists = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first()
  if (!exists) throw notFoundGo()
  let yearId: string
  try { yearId = await workingYear(c) } catch { throw errNoAcademicYear() }
  const sec = await c.db.prepare(`
    SELECT c.name AS class_name, s.name AS section_name, s.class_id, s.capacity,
           (SELECT count(*) FROM enrollments e WHERE e.section_id = s.id AND e.status = 'active' AND e.student_id <> ?) AS taken
      FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).bind(id, section)
    .first<{ class_name: string; section_name: string; class_id: string; capacity: number; taken: number }>()
  if (!sec) throw badRequest('that section does not exist')
  if (!req.allow_overflow && sec.capacity > 0 && sec.taken >= sec.capacity) {
    throw coded(409, 'no_seats', `section is full: ${sec.class_name}-${sec.section_name} is full at ${sec.taken} of ${sec.capacity}. Choose another section, or move anyway.`)
  }
  const rollNo = req.roll_no && req.roll_no > 0 ? req.roll_no : null
  const active = await c.db.prepare(`SELECT id FROM enrollments WHERE student_id = ? AND academic_year_id = ? AND status = 'active'`).bind(id, yearId).first<{ id: string }>()
  if (active) {
    await c.db.prepare(`UPDATE enrollments SET section_id = ?, class_id = ?, roll_no = COALESCE(?, roll_no), status = 'active' WHERE id = ?`)
      .bind(section, sec.class_id, rollNo, active.id).run()
  } else {
    await c.db.prepare(`INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, roll_no, enrolled_on, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`).bind(uuid(), inst(c), id, yearId, sec.class_id, section, rollNo, indiaToday(), now()).run()
  }
  return ok({ student_id: id, class: sec.class_name, section: sec.section_name })
}

async function changeStudentSection(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{ section_id?: string; effective_on?: string; roll_no?: number; reason?: string; allow_overflow?: boolean }>(c.req)
  const section = str(req.section_id).trim()
  if (!isUUID(section)) throw badRequest('section_id must be a uuid')
  let effective = str(req.effective_on).trim()
  if (effective === '') effective = indiaToday()
  if (!isDate(effective)) throw badRequest('effective_on must be a date, YYYY-MM-DD')
  const pred = studentPredicate(await resolveScope(c), 'st')
  const exists = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first()
  if (!exists) throw notFoundGo()

  const cur = await c.db.prepare(`
    SELECT e.id, e.academic_year_id AS year, e.section_id, c.name || '-' || sec.name AS "where", e.roll_no, e.enrolled_on
      FROM enrollments e JOIN sections sec ON sec.id = e.section_id JOIN classes c ON c.id = sec.class_id
     WHERE e.student_id = ? AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1`).bind(id)
    .first<{ id: string; year: string; section_id: string; where: string; roll_no: number | null; enrolled_on: string }>()
  if (!cur) throw coded(409, 'no_active_enrolment', 'this child has no active enrolment to move. Enrol them in a section first.')
  if (cur.section_id === section) throw badRequest('the child is already in that section')
  if (effective < cur.enrolled_on) throw badRequest(`effective date before the enrolment: the current enrolment began on ${cur.enrolled_on}`)

  const sec = await c.db.prepare(`
    SELECT c.name AS class_name, s.name AS section_name, s.class_id, s.capacity,
           (SELECT count(*) FROM enrollments e WHERE e.section_id = s.id AND e.status = 'active') AS taken
      FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).bind(section)
    .first<{ class_name: string; section_name: string; class_id: string; capacity: number; taken: number }>()
  if (!sec) throw badRequest('that section does not exist')
  if (!req.allow_overflow && sec.capacity > 0 && sec.taken >= sec.capacity) {
    throw coded(409, 'no_seats', `section is full: ${sec.class_name}-${sec.section_name} is full at ${sec.taken} of ${sec.capacity}. Choose another section, or move anyway.`)
  }
  let rollNo: number | null = null
  if (req.roll_no && req.roll_no > 0) {
    const used = await c.db.prepare(`SELECT 1 AS ok FROM enrollments WHERE section_id = ? AND roll_no = ?`).bind(section, req.roll_no).first()
    if (used) throw coded(409, 'roll_no_taken', `roll number taken: roll number ${req.roll_no} is already used in ${sec.class_name}-${sec.section_name}`)
    rollNo = req.roll_no
  }
  const to = `${sec.class_name}-${sec.section_name}`
  const reason = str(req.reason).trim()
  const newId = uuid()
  const before = JSON.stringify({ enrollment_id: cur.id, section_id: cur.section_id, where: cur.where, roll_no: cur.roll_no })
  const after = JSON.stringify({ enrollment_id: newId, section_id: section, where: to, roll_no: rollNo, effective_on: effective, reason })
  await batch(c, [
    c.db.prepare(`UPDATE enrollments SET status = 'moved', ended_on = ?, remarks = ? WHERE id = ?`)
      .bind(effective, ['Moved to', to, 'on', effective, reason].filter((x) => x !== '').join(' '), cur.id),
    c.db.prepare(`INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, roll_no, enrolled_on, status, promoted_from_id, remarks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .bind(newId, inst(c), id, cur.year, sec.class_id, section, rollNo, effective, cur.id, `Moved from ${cur.where} on ${effective}`, now()),
    c.db.prepare(`INSERT INTO audit_log (institution_id, actor_user_id, action, entity_type, entity_id, "before", "after", ip, created_at)
      VALUES (?, ?, 'SECTION_CHANGE student', 'students', ?, ?, ?, ?, ?)`).bind(inst(c), c.id.userId, id, before, after, clientIP(c), now()),
  ])
  return ok({ student_id: id, class: sec.class_name, section: sec.section_name, effective_on: effective, from: cur.where })
}

// --- photographs -------------------------------------------------------------------------------

function fileIdFrom(req: { file_id?: string }): string | null {
  const v = str(req.file_id).trim()
  if (v === '') return null
  if (!isUUID(v)) throw badRequest('file_id must be a uuid')
  return v
}

async function setStudentPhoto(c: Ctx) {
  const id = sid(c)
  const file = fileIdFrom(await readJSON(c.req))
  const pred = studentPredicate(await resolveScope(c), 'st')
  const res = await c.db.prepare(`UPDATE students SET photo_file_id = ? WHERE id IN (SELECT st.id FROM students st WHERE st.id = ? AND ${pred.sql})`)
    .bind(file, id, ...pred.args).run()
  if (!res.meta.changes) throw forbiddenMsg('missing permission: this child is not one you can edit')
  return ok({ saved: true })
}

async function importStudentPhotos(c: Ctx) {
  const req = await readJSON<{ photos?: { admission_no?: string; file_id?: string }[] }>(c.req)
  const photos = req.photos ?? []
  if (photos.length === 0) throw badRequest('choose the photographs to import')
  if (photos.length > 2000) throw badRequest('import at most 2000 photographs at a time')
  const pred = studentPredicate(await resolveScope(c), 'st')
  let matched = 0
  const unmatched: string[] = []
  for (const ph of photos) {
    const adm = str(ph.admission_no).trim(), fid = str(ph.file_id).trim()
    if (adm === '' || !isUUID(fid)) { unmatched.push(adm); continue }
    const res = await c.db.prepare(`UPDATE students SET photo_file_id = ? WHERE id IN (SELECT st.id FROM students st WHERE lower(st.admission_no) = lower(?) AND ${pred.sql})`)
      .bind(fid, adm, ...pred.args).run()
    if (!res.meta.changes) { unmatched.push(adm); continue }
    matched++
  }
  return ok({ matched, unmatched })
}

async function setGuardianPhoto(c: Ctx) {
  const id = sid(c)
  const gid = c.params.gid
  if (!isUUID(gid)) throw badRequest('invalid guardian id')
  const file = fileIdFrom(await readJSON(c.req))
  const pred = studentPredicate(await resolveScope(c), 'st')
  const res = await c.db.prepare(`
    UPDATE guardians SET photo_file_id = ? WHERE id = ?
       AND EXISTS (SELECT 1 FROM student_guardians sg JOIN students st ON st.id = sg.student_id
                    WHERE sg.guardian_id = guardians.id AND st.id = ? AND ${pred.sql})`).bind(file, gid, id, ...pred.args).run()
  if (!res.meta.changes) throw forbiddenMsg('missing permission: this family is not one you can edit')
  return ok({ saved: true })
}

// --- guardians ---------------------------------------------------------------------------------

const guardianRelations = new Set(['father', 'mother', 'guardian', 'other'])

async function saveStudentGuardian(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{
    id?: string; full_name?: string; relation?: string; phone?: string; email?: string; occupation?: string
    annual_income?: number | null; is_primary?: boolean; portal_blocked?: boolean | null; access_until?: string | null
  }>(c.req)
  const pred = studentPredicate(await resolveScope(c), 'st')

  const name = str(req.full_name).trim()
  if (name === '') throw badRequest('a parent needs a name')
  let relation = str(req.relation).trim().toLowerCase()
  if (relation === '') relation = 'guardian'
  if (!guardianRelations.has(relation)) throw badRequest('relation must be father, mother, guardian or other')
  const phone = str(req.phone).trim(), email = str(req.email).trim()
  if (phone === '' && email === '') throw badRequest('give a phone number or an email, a parent with neither is one the school cannot contact')

  const allowed = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first()
  if (!allowed) throw forbiddenMsg('missing permission: this family is not one you can edit')

  const income = req.annual_income === undefined || req.annual_income === null ? null : Number(req.annual_income)
  let guardianId: string
  if (req.id) {
    if (!isUUID(req.id)) throw new Error('invalid guardian id')
    const prev = await c.db.prepare(`SELECT COALESCE(phone,'') AS old_phone, COALESCE(email,'') AS old_email, user_id FROM guardians g
      WHERE g.id = ? AND EXISTS (SELECT 1 FROM student_guardians sg WHERE sg.guardian_id = g.id AND sg.student_id = ?)`).bind(req.id, id)
      .first<{ old_phone: string; old_email: string; user_id: string | null }>()
    if (!prev) throw forbiddenMsg('missing permission: this family is not one you can edit')
    try {
      await c.db.prepare(`UPDATE guardians SET full_name = ?, relation = ?, phone = ?, email = ?, occupation = ?, annual_income = COALESCE(?, annual_income) WHERE id = ?`)
        .bind(name, relation, nullStr(phone), nullStr(email), nullStr(str(req.occupation)), income, req.id).run()
    } catch (err) {
      if (isUniqueViolation(err)) throw badRequest('another parent at this school already has that name and number · add the existing one to this child instead of entering them twice')
      throw err
    }
    guardianId = req.id
    if (prev.user_id) {
      // The contact is the sign-in identifier too; tried in order, narrowing to the state that cannot collide.
      const attempts: [string, string][] = [[phone, email], [phone, prev.old_email], [prev.old_phone, email], [prev.old_phone, prev.old_email]]
      let lastErr: unknown = null
      for (const [p, e] of attempts) {
        try {
          await c.db.prepare(`
            UPDATE users SET full_name = ?, phone = ?, email = ?,
                   username = CASE WHEN ? <> '' AND username = ? THEN ?
                                   WHEN ? <> '' AND ? <> '' AND username = ? THEN ?
                                   ELSE username END
             WHERE id = ?`).bind(name, nullStr(p), nullStr(e), p, prev.old_phone, p, e, prev.old_email, prev.old_email, e, prev.user_id).run()
          lastErr = null
          break
        } catch (err) {
          lastErr = err
          if (!isUniqueViolation(err)) break
        }
      }
      if (lastErr) {
        if (isUniqueViolation(lastErr)) throw badRequest('that phone number or email is already the sign-in of another account at this school, the parent it belongs to has to be corrected first')
        throw lastErr
      }
    }
  } else {
    const existing = await c.db.prepare(`
      SELECT id FROM guardians WHERE institution_id = ? AND ((? <> '' AND phone = ?) OR (? <> '' AND email = ?))
       ORDER BY (user_id IS NOT NULL) DESC, created_at LIMIT 1`).bind(inst(c), phone, phone, email, email).first<{ id: string }>()
    if (existing) {
      guardianId = existing.id
      await c.db.prepare(`UPDATE guardians SET email = COALESCE(email, ?), phone = COALESCE(phone, ?), occupation = COALESCE(occupation, ?),
        annual_income = COALESCE(annual_income, ?) WHERE id = ?`).bind(nullStr(email), nullStr(phone), nullStr(str(req.occupation)), income, existing.id).run()
    } else {
      guardianId = uuid()
      await c.db.prepare(`
        INSERT INTO guardians (id, institution_id, full_name, relation, phone, email, occupation, annual_income, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id, phone, full_name) DO UPDATE SET relation = excluded.relation,
            email = COALESCE(excluded.email, guardians.email), occupation = COALESCE(excluded.occupation, guardians.occupation),
            annual_income = COALESCE(excluded.annual_income, guardians.annual_income)`)
        .bind(guardianId, inst(c), name, relation, nullStr(phone), nullStr(email), nullStr(str(req.occupation)), income, now()).run()
      const row = await c.db.prepare(`SELECT id FROM guardians WHERE institution_id = ? AND phone IS ? AND full_name = ?`)
        .bind(inst(c), nullStr(phone), name).first<{ id: string }>()
      if (row) guardianId = row.id
    }
    await c.db.prepare(`INSERT OR IGNORE INTO student_guardians (student_id, guardian_id, institution_id, is_primary) VALUES (?, ?, ?, 0)`)
      .bind(id, guardianId, inst(c)).run()
  }

  const stmts: D1PreparedStatement[] = []
  if (req.portal_blocked !== undefined || req.access_until !== undefined) {
    const blocked = req.portal_blocked === undefined || req.portal_blocked === null ? null : req.portal_blocked ? 1 : 0
    const until = req.access_until === undefined ? null : req.access_until
    stmts.push(c.db.prepare(`UPDATE student_guardians SET portal_blocked = COALESCE(?, portal_blocked),
      access_until = CASE WHEN ? IS NULL THEN access_until WHEN ? = '' THEN NULL ELSE ? END WHERE student_id = ? AND guardian_id = ?`)
      .bind(blocked, until, until, until, id, guardianId))
  }
  if (req.is_primary) {
    stmts.push(c.db.prepare(`UPDATE student_guardians SET is_primary = 0 WHERE student_id = ?`).bind(id))
    stmts.push(c.db.prepare(`UPDATE student_guardians SET is_primary = 1 WHERE student_id = ? AND guardian_id = ?`).bind(id, guardianId))
  }
  if (stmts.length) await batch(c, stmts)
  return ok({ id: guardianId, full_name: name })
}

async function unlinkStudentGuardian(c: Ctx) {
  const id = sid(c)
  const gid = c.params.gid
  if (!isUUID(gid)) throw badRequest('invalid guardian id')
  const pred = studentPredicate(await resolveScope(c), 'st')
  const res = await c.db.prepare(`DELETE FROM student_guardians WHERE student_id = ? AND guardian_id = ?
      AND EXISTS (SELECT 1 FROM students st WHERE st.id = student_guardians.student_id AND ${pred.sql})`).bind(id, gid, ...pred.args).run()
  if (!res.meta.changes) throw forbiddenMsg('missing permission: that family is not one you can edit')
  return ok({ unlinked: true })
}

// --- leaving, suspension, readmission ------------------------------------------------------------

const exitStatuses = new Set(['graduated', 'transferred', 'withdrawn', 'alumni'])

async function recordStudentExit(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{ status?: string; exit_date?: string; reason?: string }>(c.req)
  let status = str(req.status).trim().toLowerCase()
  if (status === '') status = 'withdrawn'
  if (!exitStatuses.has(status)) throw badRequest('status must be graduated, transferred, withdrawn or alumni')
  const exitDate = str(req.exit_date).trim()
  if (exitDate !== '') {
    if (!isDate(exitDate)) throw badRequest('exit_date must be YYYY-MM-DD')
    if (exitDate > addDays(indiaToday(), 1)) throw badRequest('a leaving date cannot be in the future')
  }
  const pred = studentPredicate(await resolveScope(c), 'st')
  const res = await c.db.prepare(`UPDATE students SET status = ?, exit_date = COALESCE(?, ?), exit_reason = ?, updated_at = ?
     WHERE id IN (SELECT st.id FROM students st WHERE st.id = ? AND ${pred.sql})`)
    .bind(status, nullStr(exitDate), indiaToday(), nullStr(str(req.reason)), now(), id, ...pred.args).run()
  if (!res.meta.changes) throw forbiddenMsg('missing permission: this child is not one you can edit')
  await c.db.prepare(`UPDATE enrollments SET status = ? WHERE student_id = ? AND status = 'active'`).bind(status, id).run()
  const ended = await endFamilyAccess(c, id)
  return ok({ status, logins_ended: ended })
}

async function suspendStudent(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{ suspended?: boolean; reason?: string }>(c.req)
  const pred = studentPredicate(await resolveScope(c), 'st')
  const status = req.suspended ? 'suspended' : 'active'
  const res = await c.db.prepare(`UPDATE students SET status = ?, exit_reason = ?, updated_at = ?
     WHERE id IN (SELECT st.id FROM students st WHERE st.id = ? AND st.status IN ('active','suspended') AND ${pred.sql})`)
    .bind(status, nullStr(str(req.reason)), now(), id, ...pred.args).run()
  if (!res.meta.changes) throw coded(409, 'not_suspendable', 'this child has left the school, or is not one you can edit')
  return ok({ status })
}

async function readmitStudent(c: Ctx) {
  const id = sid(c)
  const pred = studentPredicate(await resolveScope(c), 'st')
  const res = await c.db.prepare(`UPDATE students SET status = 'active', exit_date = NULL, exit_reason = NULL, updated_at = ?
     WHERE id IN (SELECT st.id FROM students st WHERE st.id = ? AND st.status <> 'active' AND ${pred.sql})`)
    .bind(now(), id, ...pred.args).run()
  if (!res.meta.changes) throw coded(409, 'not_readmittable', 'this child is either already on the roll or not one you can edit')
  return ok({ status: 'active' })
}

// --- the fee quote at the admissions desk --------------------------------------------------------------

async function admissionFeePreview(c: Ctx) {
  const classId = c.url.searchParams.get('class_id')
  if (!isUUID(classId)) throw badRequest('choose a class to see what it costs')
  const fs = await c.db.prepare(`
    SELECT fs.id, fs.name FROM fee_structures fs
     WHERE fs.is_active = 1 AND (fs.class_id = ? OR fs.class_id IS NULL)
       AND EXISTS (SELECT 1 FROM fee_structure_items i WHERE i.fee_structure_id = fs.id)
     ORDER BY ((SELECT COALESCE(sum(i.amount_paise), 0) FROM fee_structure_items i WHERE i.fee_structure_id = fs.id) > 0) DESC,
              (fs.class_id = ?) DESC, fs.created_at DESC LIMIT 1`).bind(classId, classId).first<{ id: string; name: string }>()
  const heads: { head: string; paise: number; instalment: number }[] = []
  let total = 0, instalments = 0, structureName = '', draftName = '', structureId = NIL_UUID
  if (!fs) {
    const draft = await c.db.prepare(`SELECT fs.name FROM fee_structures fs WHERE fs.is_active = 1 AND (fs.class_id = ? OR fs.class_id IS NULL)
      ORDER BY (fs.class_id = ?) DESC, fs.created_at DESC LIMIT 1`).bind(classId, classId).first<{ name: string }>()
    draftName = draft?.name ?? ''
  } else {
    structureId = fs.id; structureName = fs.name
    const n = await c.db.prepare(`SELECT count(DISTINCT instalment_no) AS n FROM fee_structure_items WHERE fee_structure_id = ?`).bind(fs.id).first<{ n: number }>()
    instalments = n?.n ?? 0
    const rows = await c.db.prepare(`
      SELECT COALESCE(fh.name, 'Other') AS head, i.amount_paise AS paise, i.instalment_no AS instalment
        FROM fee_structure_items i LEFT JOIN fee_heads fh ON fh.id = i.fee_head_id
       WHERE i.fee_structure_id = ? ORDER BY i.instalment_no, COALESCE(fh.name, 'Other')`).bind(fs.id).all<{ head: string; paise: number; instalment: number }>()
    for (const h of rows.results) { heads.push(h); total += h.paise }
  }
  return ok({
    structure: structureName, heads, total_paise: total, instalments, structure_id: structureId, has_structure: heads.length > 0,
    draft_structure: draftName,
    note: 'A quote from the current fee structure. Nothing is charged until the demand is raised for this class.',
  })
}

// --- the 360 view ------------------------------------------------------------------------------------

async function getStudentProfile(c: Ctx) {
  const id = sid(c)
  const pred = studentPredicate(await resolveScope(c), 'st')
  const st = await c.db.prepare(`
    SELECT st.admission_no, ${fullNameSQL('st')} AS full_name, st.status, c.name AS class_name, sec.name AS section_name, en.roll_no,
           st.gender, st.date_of_birth, st.medium, st.blood_group, st.mother_tongue, st.apaar_id, st.child_info_id,
           (SELECT g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1) AS primary_phone,
           st.city, st.prior_school, st.is_rte, st.is_cwsn, st.admission_date, st.photo_file_id, st.category, st.nationality, st.aadhaar_last4,
           st.address_line1, st.address_line2, st.state, st.pincode, st.permanent_address, st.emergency_contact_name,
           st.emergency_contact_phone, st.emergency_contact_relation, st.custom_fields, st.house_id, h.name AS house_name, h.color AS house_color,
           st.exit_date, st.exit_reason,
           hc.height_cm, hc.weight_kg, hc.bmi, hc.on_date AS measured_on, sh.allergies
      FROM students st
      LEFT JOIN houses h ON h.id = st.house_id
      LEFT JOIN health_checkups hc ON hc.id = (SELECT id FROM health_checkups WHERE student_id = st.id AND height_cm IS NOT NULL ORDER BY on_date DESC LIMIT 1)
      LEFT JOIN student_health sh ON sh.student_id = st.id
      ${latestEnrolmentJoin(false)}
     WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first<Record<string, unknown>>()
  if (!st) throw notFoundGo()

  const [sums, guardians, attendance, results, ledger, enrolments, transport, documents] = await batch(c, [
    c.db.prepare(`SELECT (SELECT count(*) FROM student_attendance WHERE student_id = ? AND status IN ('present','late')) AS present,
                         (SELECT count(*) FROM student_attendance WHERE student_id = ?) AS total,
                         COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices WHERE student_id = ? AND status IN ('unpaid','partial','overdue')), 0) AS dues,
                         COALESCE((SELECT sum(amount_paise) FROM payments WHERE student_id = ? AND status = 'success'), 0) AS paid`).bind(id, id, id, id),
    c.db.prepare(`SELECT g.id, g.full_name, g.relation, COALESCE(g.phone,'') AS phone, COALESCE(g.email,'') AS email, sg.is_primary,
                         COALESCE(g.occupation,'') AS occupation, g.photo_file_id, g.annual_income,
                         CASE WHEN u.id IS NULL THEN 'none' WHEN u.status = 'active' AND u.last_login_at IS NOT NULL THEN 'active'
                              WHEN u.status = 'active' THEN 'issued' ELSE u.status END AS login, u.last_login_at
                    FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id LEFT JOIN users u ON u.id = g.user_id
                   WHERE sg.student_id = ? ORDER BY sg.is_primary DESC`).bind(id),
    c.db.prepare(`SELECT on_date AS date, status FROM student_attendance WHERE student_id = ? ORDER BY on_date DESC LIMIT 30`).bind(id),
    c.db.prepare(`SELECT e.name AS exam, COALESCE(rc.percentage,'') AS percentage, COALESCE(rc.grade,'') AS grade, COALESCE(CAST(rc.rank_in_section AS TEXT),'') AS rank
                    FROM report_cards rc LEFT JOIN exams e ON e.academic_year_id = rc.academic_year_id
                   WHERE rc.student_id = ? AND rc.is_published = 1 ORDER BY rc.created_at DESC LIMIT 10`).bind(id),
    c.db.prepare(`SELECT i.issued_on AS date, i.invoice_no, i.net_paise, i.paid_paise, i.status FROM invoices i WHERE i.student_id = ? ORDER BY i.issued_on DESC LIMIT 20`).bind(id),
    c.db.prepare(`SELECT ay.name AS year, c.name AS class, sec.name AS section, e.roll_no, e.enrolled_on AS "from", e.status
                    FROM enrollments e JOIN academic_years ay ON ay.id = e.academic_year_id JOIN classes c ON c.id = e.class_id JOIN sections sec ON sec.id = e.section_id
                   WHERE e.student_id = ? ORDER BY e.enrolled_on DESC`).bind(id),
    c.db.prepare(`SELECT rt.name AS route, COALESCE(v.registration_no,'') AS vehicle, COALESCE(pu.name,'') AS pickup_stop,
                         COALESCE(substr(pu.pickup_time,1,5),'') AS pickup_time, COALESCE(dr.name,'') AS drop_stop, COALESCE(substr(dr.drop_time,1,5),'') AS drop_time,
                         ta.valid_from AS "from", COALESCE(ta.valid_to,'') AS "to"
                    FROM transport_allocations ta JOIN routes rt ON rt.id = ta.route_id LEFT JOIN vehicles v ON v.id = rt.vehicle_id
                    LEFT JOIN route_stops pu ON pu.id = ta.pickup_stop_id LEFT JOIN route_stops dr ON dr.id = ta.drop_stop_id
                   WHERE ta.student_id = ? ORDER BY ta.valid_from DESC`).bind(id),
    c.db.prepare(`SELECT ic.serial_no, ct.name AS type, ic.issued_on FROM issued_certificates ic JOIN certificate_types ct ON ct.id = ic.certificate_type_id
                   WHERE ic.student_id = ? ORDER BY ic.issued_on DESC`).bind(id),
  ])

  const s = sums.results[0] as { present: number; total: number; dues: number; paid: number }
  const pct = s.total > 0 ? Math.floor((s.present * 100) / s.total) : 0
  const out: Record<string, unknown> = {
    id, admission_no: st.admission_no, full_name: st.full_name, status: st.status, class_name: st.class_name, section_name: st.section_name,
    roll_no: st.roll_no, gender: st.gender, date_of_birth: st.date_of_birth, medium: st.medium, blood_group: st.blood_group,
    mother_tongue: st.mother_tongue, apaar_id: st.apaar_id, child_info_id: st.child_info_id, primary_phone: st.primary_phone, city: st.city,
    prior_school: st.prior_school, is_rte: bool(st.is_rte), is_cwsn: bool(st.is_cwsn), admission_date: st.admission_date, category: st.category,
    nationality: st.nationality, aadhaar_last4: st.aadhaar_last4, address_line1: st.address_line1, address_line2: st.address_line2, state: st.state,
    pincode: st.pincode, permanent_address: st.permanent_address, emergency_contact_name: st.emergency_contact_name,
    emergency_contact_phone: st.emergency_contact_phone, emergency_contact_relation: st.emergency_contact_relation, house_id: st.house_id,
    house_name: st.house_name, house_color: st.house_color, exit_date: st.exit_date, exit_reason: st.exit_reason,
    height_cm: strOrNull(st.height_cm), weight_kg: strOrNull(st.weight_kg), bmi: strOrNull(st.bmi), measured_on: st.measured_on, allergies: st.allergies,
    photo_file_id: st.photo_file_id,
    attendance: { present: s.present, total: s.total, percent: pct, below_threshold: s.total > 0 && pct < 75 },
    fees: { outstanding_paise: s.dues, paid_paise: s.paid },
    guardians: (guardians.results as Record<string, unknown>[]).map((g) => ({ ...g, is_primary: bool(g.is_primary) })),
    recent_attendance: attendance.results,
    results: results.results,
    invoices: ledger.results,
    documents: documents.results,
    enrolments: enrolments.results,
    transport: transport.results,
  }
  const cf = parseJSON<Record<string, string>>(st.custom_fields, {})
  if (Object.keys(cf).length > 0) out.custom_fields = cf
  return ok(out)
}

async function getStudentDetail(c: Ctx) {
  const id = sid(c)
  const pred = studentPredicate(await resolveScope(c), 'st')
  const classRow = await c.db.prepare(`SELECT e.class_id FROM enrollments e WHERE e.student_id = ? ORDER BY e.enrolled_on DESC LIMIT 1`).bind(id).first<{ class_id: string }>()
  const okRow = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first()
  if (!okRow) throw forbiddenMsg('missing permission: this child is not one you can see')
  const today = indiaToday()

  const [marks, feeHeads, payments, documents, leave, history, priorYears, invoices, coScholastic, concessions, components, activities, crew] = await batch(c, [
    c.db.prepare(`SELECT e.name AS exam, sub.name AS subject, CAST(m.marks_obtained AS TEXT) AS marks, CAST(es.max_marks AS TEXT) AS max, m.grade,
                         m.is_absent AS absent, e.starts_on AS "on", (m.approved_at IS NOT NULL) AS approved
                    FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN exams e ON e.id = es.exam_id
                    JOIN class_subjects cs ON cs.id = es.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
                   WHERE m.student_id = ? ORDER BY e.starts_on DESC, sub.name`).bind(id),
    c.db.prepare(`SELECT COALESCE(fh.name, il.description, 'Other') AS head,
                         CAST(SUM(il.amount_paise - il.discount_paise) AS TEXT) AS charged_paise,
                         CAST(SUM(CAST(ROUND((il.amount_paise - il.discount_paise) * CASE WHEN inv.net_paise > 0 THEN inv.paid_paise * 1.0 / inv.net_paise ELSE 0 END) AS INTEGER)) AS TEXT) AS paid_paise
                    FROM invoice_lines il JOIN invoices inv ON inv.id = il.invoice_id LEFT JOIN fee_heads fh ON fh.id = il.fee_head_id
                   WHERE inv.student_id = ? AND inv.status <> 'cancelled' GROUP BY head ORDER BY head`).bind(id),
    c.db.prepare(`SELECT COALESCE(pm.receipt_no,'') AS receipt_no, pm.paid_on, CAST(pm.amount_paise AS TEXT) AS amount_paise, pm.mode,
                         COALESCE(pm.gateway_txn_id, pm.reference_no, '') AS reference, pm.status
                    FROM payments pm WHERE pm.student_id = ? ORDER BY pm.paid_on DESC, pm.created_at DESC LIMIT 100`).bind(id),
    c.db.prepare(`SELECT sd.id, sd.doc_type, sd.file_id, substr(sd.created_at,1,10) AS uploaded_on, (sd.verified_at IS NOT NULL) AS verified,
                         COALESCE(u.full_name,'') AS verified_by, COALESCE(sd.notes,'') AS notes, COALESCE(f.original_name,'') AS filename, COALESCE(f.content_type,'') AS content_type
                    FROM student_documents sd LEFT JOIN users u ON u.id = sd.verified_by LEFT JOIN files f ON f.id = sd.file_id
                   WHERE sd.student_id = ? ORDER BY sd.created_at DESC`).bind(id),
    c.db.prepare(`SELECT lr.from_date AS "from", lr.to_date AS "to", COALESCE(lt.name,'') AS type, COALESCE(lr.reason,'') AS reason, lr.status,
                         COALESCE(u.full_name,'') AS applied_by, COALESCE(lr.decision_note,'') AS decision_note, CAST(lr.days AS TEXT) AS days
                    FROM leave_requests lr LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id LEFT JOIN users u ON u.id = lr.applied_by
                   WHERE lr.student_id = ? ORDER BY lr.from_date DESC LIMIT 50`).bind(id),
    c.db.prepare(`SELECT COALESCE(ay.name,'') AS year, COALESCE(c.name,'') AS class, COALESCE(sec.name,'') AS section, CAST(en.roll_no AS TEXT) AS roll_no,
                         en.status, en.enrolled_on AS "from", en.ended_on AS "to", COALESCE(en.remarks,'') AS remarks, (en.promoted_from_id IS NOT NULL) AS promoted
                    FROM enrollments en LEFT JOIN academic_years ay ON ay.id = en.academic_year_id LEFT JOIN classes c ON c.id = en.class_id
                    LEFT JOIN sections sec ON sec.id = en.section_id WHERE en.student_id = ? ORDER BY en.enrolled_on DESC`).bind(id),
    c.db.prepare(`SELECT year_name AS year, COALESCE(class_name,'') AS class, days_present, days_total, fee_billed_paise, fee_paid_paise, fee_waived_paise, COALESCE(notes,'') AS notes
                    FROM student_year_history WHERE student_id = ? ORDER BY year_name DESC`).bind(id),
    c.db.prepare(`SELECT inv.invoice_no, CAST(inv.net_paise AS TEXT) AS net_paise, CAST(inv.paid_paise AS TEXT) AS paid_paise, inv.status, inv.issued_on
                    FROM invoices inv WHERE inv.student_id = ? AND inv.status <> 'cancelled' ORDER BY inv.issued_on DESC, inv.invoice_no`).bind(id),
    c.db.prepare(`SELECT a.id AS area_id, a.name AS area, COALESCE(g.grade,'') AS grade, COALESCE(g.remark,'') AS remark, COALESCE(t.name,'') AS term,
                         COALESCE(u.full_name,'') AS graded_by, COALESCE(substr(g.graded_at,1,10),'') AS graded_on
                    FROM co_scholastic_areas a LEFT JOIN co_scholastic_grades g ON g.area_id = a.id AND g.student_id = ?
                    LEFT JOIN terms t ON t.id = g.term_id LEFT JOIN users u ON u.id = g.graded_by
                   WHERE a.is_active = 1 ORDER BY a.sequence, a.name`).bind(id),
    c.db.prepare(`SELECT fc.id, fc.kind, fc.status, COALESCE(CAST(fc.percent AS TEXT),'') AS percent, COALESCE(CAST(fc.amount_paise AS TEXT),'') AS amount_paise,
                         COALESCE(fc.reason,'') AS reason, COALESCE(fc.decision_note,'') AS decision_note, COALESCE(u.full_name,'') AS decided_by,
                         COALESCE(ru.full_name,'') AS asked_by, substr(fc.created_at,1,10) AS raised_on, COALESCE(substr(fc.decided_at,1,10),'') AS decided_on,
                         COALESCE(fh.name,'') AS fee_head
                    FROM fee_concessions fc LEFT JOIN users u ON u.id = fc.approved_by LEFT JOIN users ru ON ru.id = fc.requested_by
                    LEFT JOIN fee_heads fh ON fh.id = fc.fee_head_id WHERE fc.student_id = ? ORDER BY fc.created_at DESC`).bind(id),
    c.db.prepare(`SELECT c.code, c.description, fh.name AS fee_head, CAST(c.amount_paise AS TEXT) AS amount_paise, c.valid_from, COALESCE(c.valid_to,'') AS valid_to,
                         (c.valid_to IS NULL OR c.valid_to >= ?) AS live
                    FROM student_fee_components c JOIN fee_heads fh ON fh.id = c.fee_head_id WHERE c.student_id = ?
                   ORDER BY (c.valid_to IS NULL OR c.valid_to >= ?) DESC, c.valid_from DESC LIMIT 20`).bind(today, id, today),
    c.db.prepare(`SELECT sa.id, a.name, a.category, COALESCE(a.schedule,'') AS schedule, CAST(sa.fee_paise AS TEXT) AS fee_paise, sa.status, sa.enrolled_on,
                         COALESCE(inv.status,'') AS invoice_status, COALESCE(inv.invoice_no,'') AS invoice_no, COALESCE(CAST(inv.net_paise - inv.paid_paise AS TEXT),'0') AS due_paise
                    FROM student_activities sa JOIN activities a ON a.id = sa.activity_id LEFT JOIN invoices inv ON inv.id = sa.invoice_id
                   WHERE sa.student_id = ? ORDER BY (sa.status = 'enrolled') DESC, sa.enrolled_on DESC`).bind(id),
    c.db.prepare(`SELECT COALESCE(rt.name,'') AS route, COALESCE(v.registration_no,'') AS vehicle,
                         COALESCE(trim(de.first_name || ' ' || COALESCE(de.last_name,'')),'') AS driver, COALESCE(de.phone,'') AS driver_phone,
                         COALESCE(trim(ae.first_name || ' ' || COALESCE(ae.last_name,'')),'') AS attendant, COALESCE(ae.phone,'') AS attendant_phone
                    FROM transport_allocations ta LEFT JOIN routes rt ON rt.id = ta.route_id LEFT JOIN vehicles v ON v.id = rt.vehicle_id
                    LEFT JOIN employees de ON de.id = v.driver_employee_id LEFT JOIN employees ae ON ae.id = v.attendant_employee_id
                   WHERE ta.student_id = ? AND (ta.valid_to IS NULL OR ta.valid_to >= ?)`).bind(id, today),
  ])
  const rows = (r: D1Result) => r.results as Record<string, unknown>[]
  return ok({
    subject_marks: rows(marks).map((m) => ({ ...m, absent: bool(m.absent), approved: bool(m.approved) })),
    fee_heads: feeHeads.results,
    payments: payments.results,
    documents: rows(documents).map((d) => ({ ...d, verified: bool(d.verified) })),
    leave: leave.results,
    enrolment_history: rows(history).map((h) => ({ ...h, promoted: bool(h.promoted) })),
    prior_years: priorYears.results,
    transport_crew: crew.results,
    activities: activities.results,
    concessions: concessions.results,
    fee_components: rows(components).map((x) => ({ ...x, live: bool(x.live) })),
    co_scholastic: coScholastic.results,
    invoices: invoices.results,
    class_id: classRow?.class_id ?? null,
  })
}

// --- conduct notes ---------------------------------------------------------------------------

async function listDisciplineNotes(c: Ctx) {
  const scope = await resolveScope(c)
  const pred = studentPredicate(scope, 'st')
  const visible = (c.id.platformAdmin && !c.id.restricted) || c.id.permissions.has('welfare.discipline.write') ? '1' : 'dr.visible_to_student = 1'
  const studentId = nullStr(c.url.searchParams.get('student_id'))
  const rows = await c.db.prepare(`
    SELECT dr.id, dr.student_id, ${shortNameSQL('st')} AS student_name, dr.occurred_on, dr.category, dr.is_positive, dr.description,
           dr.action_taken, dr.visible_to_student, dr.parent_notified, u.full_name AS recorded_by
      FROM discipline_records dr JOIN students st ON st.id = dr.student_id LEFT JOIN users u ON u.id = dr.recorded_by
     WHERE (? IS NULL OR dr.student_id = ?) AND ${visible} AND ${pred.sql}
     ORDER BY dr.occurred_on DESC, dr.created_at DESC LIMIT 300`).bind(studentId, studentId, ...pred.args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({
    id: v.id, student_id: v.student_id, student_name: v.student_name, occurred_on: v.occurred_on, category: v.category,
    is_positive: bool(v.is_positive), description: v.description, action_taken: v.action_taken,
    visible_to_student: bool(v.visible_to_student), parent_notified: bool(v.parent_notified), recorded_by: v.recorded_by,
  }, ['action_taken', 'recorded_by'])) })
}

function omitNull(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const k of keys) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

async function recordDisciplineNote(c: Ctx) {
  const req = await readJSON<{
    student_id?: string; occurred_on?: string; category?: string; is_positive?: boolean; description?: string
    action_taken?: string; visible_to_student?: boolean; parent_notified?: boolean
  }>(c.req)
  if (str(req.description).trim() === '') throw badRequest('say what happened. A note with a category and no words is unusable at a parent meeting')
  const student = str(req.student_id)
  if (!isUUID(student)) throw badRequest('student_id must be a uuid')
  const scope = await resolveScope(c)
  if (!(await reachesStudent(c, scope, student))) throw notFoundGo()
  const category = req.category || 'conduct'
  const newId = uuid()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO discipline_records (id, institution_id, student_id, occurred_on, category, is_positive, description, action_taken,
                     visible_to_student, parent_notified, recorded_by, created_at) VALUES (?, ?, ?, COALESCE(?, ?), ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId, inst(c), student, nullStr(str(req.occurred_on)), indiaToday(), category, req.is_positive ? 1 : 0, str(req.description),
        nullStr(str(req.action_taken)), req.visible_to_student ? 1 : 0, req.parent_notified ? 1 : 0, c.id.userId, now()),
  ]
  if (req.visible_to_student || req.parent_notified) {
    const child = await c.db.prepare(`SELECT ${shortNameSQL('s')} AS name FROM students s WHERE id = ?`).bind(student).first<{ name: string }>()
    const from = await c.db.prepare(`SELECT full_name FROM users WHERE id = ?`).bind(c.id.userId).first<{ full_name: string }>()
    const childName = child?.name ?? ''
    const title = req.is_positive ? `${childName} was commended` : `About ${childName}’s conduct`
    let summary = str(req.description).trim()
    if (summary.length > 240) summary = summary.slice(0, 237) + '…'
    summary += ' · ' + (from?.full_name ?? c.id.fullName)
    const tell: string[] = []
    if (req.visible_to_student) {
      const rows = await c.db.prepare(`SELECT user_id FROM students WHERE id = ? AND user_id IS NOT NULL`).bind(student).all<{ user_id: string }>()
      tell.push(...rows.results.map((x) => x.user_id))
    }
    if (req.parent_notified) {
      const rows = await c.db.prepare(`SELECT g.user_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND g.user_id IS NOT NULL`)
        .bind(student).all<{ user_id: string }>()
      tell.push(...rows.results.map((x) => x.user_id))
    }
    for (const u of tell) stmts.push(notifyStmt(c, u, student, 'student_conduct', title, summary, '/go/remarks', 'discipline_record', newId))
  }
  await batch(c, stmts)
  return created({ id: newId })
}

// --- support plans ----------------------------------------------------------------------------

async function listSupportPlans(c: Ctx) {
  const pred = studentPredicate(await resolveScope(c), 'st')
  const today = indiaToday()
  const rows = await c.db.prepare(`
    SELECT sp.id, sp.student_id, ${shortNameSQL('st')} AS student_name, COALESCE(cl.name, '-') AS class_name, st.cwsn_type,
           sp.concern, sp.accommodations, sp.exam_concession, sp.external_support, sp.review_on, sp.status,
           (sp.review_on IS NOT NULL AND sp.review_on < ? AND sp.status <> 'closed') AS review_due
      FROM student_support_plans sp JOIN students st ON st.id = sp.student_id
      LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
      LEFT JOIN sections sec ON sec.id = en.section_id LEFT JOIN classes cl ON cl.id = sec.class_id
     WHERE ${pred.sql} AND st.status = 'active'
     ORDER BY (sp.review_on IS NOT NULL AND sp.review_on < ?) DESC, sp.status, st.first_name LIMIT 300`)
    .bind(today, ...pred.args, today).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v, review_due: bool(v.review_due) }, ['cwsn_type', 'exam_concession', 'external_support', 'review_on'])) })
}

async function saveSupportPlan(c: Ctx) {
  const req = await readJSON<{
    student_id?: string; concern?: string; accommodations?: string; exam_concession?: string; external_support?: string
    review_on?: string; status?: string; cwsn_type?: string
  }>(c.req)
  if (str(req.concern).trim() === '' || str(req.accommodations).trim() === '') throw badRequest('a plan needs both the concern and what the school will do about it')
  const student = str(req.student_id)
  if (!isUUID(student)) throw badRequest('student_id must be a uuid')
  const status = req.status || 'active'
  if (!['active', 'review_due', 'closed'].includes(status)) throw badRequest('unknown status ' + status)
  const scope = await resolveScope(c)
  if (!(await reachesStudent(c, scope, student))) throw notFoundGo()

  const open = await c.db.prepare(`SELECT id FROM student_support_plans WHERE student_id = ? AND status <> 'closed' LIMIT 1`).bind(student).first<{ id: string }>()
  const planId = open?.id ?? uuid()
  const stmt = open
    ? c.db.prepare(`UPDATE student_support_plans SET concern = ?, accommodations = ?, exam_concession = ?, external_support = ?, review_on = ?, status = ?, updated_at = ? WHERE id = ?`)
      .bind(req.concern, req.accommodations, nullStr(str(req.exam_concession)), nullStr(str(req.external_support)), nullStr(str(req.review_on)), status, now(), planId)
    : c.db.prepare(`INSERT INTO student_support_plans (id, institution_id, student_id, concern, accommodations, exam_concession, external_support, review_on, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(planId, inst(c), student, req.concern, req.accommodations, nullStr(str(req.exam_concession)), nullStr(str(req.external_support)),
        nullStr(str(req.review_on)), status, c.id.userId, now(), now())
  await batch(c, [
    stmt,
    c.db.prepare(`UPDATE students SET is_cwsn = 1, cwsn_type = COALESCE(?, cwsn_type), updated_at = ? WHERE id = ?`).bind(nullStr(str(req.cwsn_type)), now(), student),
  ])
  return ok({ id: planId, status })
}

// --- co-scholastic grades ----------------------------------------------------------------------

async function saveCoScholasticGrade(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{ area_id?: string; term_id?: string; grade?: string; remark?: string }>(c.req)
  const areaId = str(req.area_id).trim()
  if (!isUUID(areaId)) throw badRequest('choose an area')
  const grade = str(req.grade).trim()
  if (grade.length > 40 || str(req.remark).length > 500) throw badRequest('keep the grade under 40 characters and the remark under 500')
  const pred = studentPredicate(await resolveScope(c), 'st')
  const allowed = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first()
  if (!allowed) throw forbiddenMsg('missing permission: this child is not one you can grade')
  const termId = nullStr(str(req.term_id))
  const del = c.db.prepare(`DELETE FROM co_scholastic_grades WHERE student_id = ? AND area_id = ? AND COALESCE(term_id, ?) = COALESCE(?, ?)`)
    .bind(id, areaId, NIL_UUID, termId, NIL_UUID)
  if (grade === '') { await del.run(); return ok({ saved: false, removed: true }) }
  await batch(c, [
    del,
    c.db.prepare(`INSERT INTO co_scholastic_grades (id, institution_id, student_id, area_id, term_id, grade, remark, graded_by, graded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst(c), id, areaId, termId, grade, nullStr(str(req.remark)), c.id.userId, now()),
  ])
  return ok({ saved: true, removed: false })
}

// --- activities ---------------------------------------------------------------------------------

async function enrolInActivity(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{ activity_id?: string; waive_fee?: boolean; notes?: string }>(c.req)
  const aid = str(req.activity_id).trim()
  if (!isUUID(aid)) throw badRequest('choose an activity')
  const pred = studentPredicate(await resolveScope(c), 'st')
  const allowed = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first()
  if (!allowed) throw forbiddenMsg('missing permission: this child is not one you can edit')
  const a = await c.db.prepare(`SELECT a.name, a.fee_paise, a.capacity, a.is_active,
      (SELECT count(*) FROM student_activities sa WHERE sa.activity_id = a.id AND sa.status = 'enrolled') AS taken FROM activities a WHERE a.id = ?`).bind(aid)
    .first<{ name: string; fee_paise: number; capacity: number; is_active: number; taken: number }>()
  if (!a) throw forbiddenMsg('missing permission: this child is not one you can edit')
  if (!a.is_active) throw new Error('that activity has been wound up')
  if (a.capacity > 0 && a.taken >= a.capacity) throw coded(409, 'activity_full', 'that activity is full, raise its capacity or put the child on the list')
  const already = await c.db.prepare(`SELECT 1 AS ok FROM student_activities WHERE student_id = ? AND activity_id = ? AND status = 'enrolled'`).bind(id, aid).first()
  if (already) throw badRequest('this child is already enrolled in that activity')

  const charged = req.waive_fee ? 0 : a.fee_paise
  const stmts: D1PreparedStatement[] = []
  let invoiceId: string | null = null, invoiceNo = ''
  const today = indiaToday()
  if (charged > 0) {
    // invoice_lines.fee_head_id is NOT NULL in the D1 schema (nullable in Postgres): the club fee is filed under the school's first head.
    const head = await c.db.prepare(`SELECT id FROM fee_heads WHERE institution_id = ? ORDER BY created_at LIMIT 1`).bind(inst(c)).first<{ id: string }>()
    if (!head) throw badRequest('set up at least one fee head before charging for an activity')
    invoiceNo = (await nextNumber(c, 'invoice')).text
    invoiceId = uuid()
    stmts.push(c.db.prepare(`
      INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, issued_on, due_on, gross_paise, discount_paise, fine_paise, net_paise, status, created_at, updated_at)
      SELECT ?, ?, st.campus_id, st.id, (SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1), ?, ?, ?, ?, 0, 0, ?, 'unpaid', ?, ?
        FROM students st WHERE st.id = ?`).bind(invoiceId, inst(c), invoiceNo, today, addDays(today, 14), charged, charged, now(), now(), id))
    stmts.push(c.db.prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise, discount_paise) VALUES (?, ?, ?, ?, ?, ?, 0)`)
      .bind(uuid(), inst(c), invoiceId, head.id, a.name, charged))
  }
  const enrolId = uuid()
  stmts.push(c.db.prepare(`INSERT INTO student_activities (id, institution_id, student_id, activity_id, academic_year_id, enrolled_on, invoice_id, fee_paise, notes, created_at)
    VALUES (?, ?, ?, ?, (SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1), ?, ?, ?, ?, ?)`)
    .bind(enrolId, inst(c), id, aid, today, invoiceId, charged, nullStr(str(req.notes)), now()))
  if (charged > 0) {
    const body = `${a.name} · ₹${(charged / 100).toFixed(2)}, due in a fortnight. It is on your fees page and can be paid there.`
    const people = await c.db.prepare(`
      SELECT g.user_id AS uid FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND g.user_id IS NOT NULL
      UNION SELECT u.id FROM students st JOIN users u ON u.id = st.user_id WHERE st.id = ?`).bind(id, id).all<{ uid: string }>()
    for (const p of people.results) stmts.push(notifyStmt(c, p.uid, id, 'fee_due', 'Enrolled in ' + a.name, body, '/portal/fees', 'invoice', invoiceId))
  }
  await batch(c, stmts)
  return created({ id: enrolId, charged_paise: charged, invoice_no: invoiceNo })
}

async function leaveActivity(c: Ctx) {
  const id = sid(c)
  const eid = c.params.enrolID
  if (!isUUID(eid)) throw badRequest('invalid enrolment id')
  const pred = studentPredicate(await resolveScope(c), 'st')
  const row = await c.db.prepare(`SELECT sa.invoice_id FROM student_activities sa WHERE sa.id = ? AND sa.student_id = ? AND sa.status = 'enrolled'
      AND EXISTS (SELECT 1 FROM students st WHERE st.id = sa.student_id AND ${pred.sql})`).bind(eid, id, ...pred.args).first<{ invoice_id: string | null }>()
  if (!row) throw coded(409, 'not_enrolled', 'that enrolment is already closed, or is not one you can edit')
  const stmts = [c.db.prepare(`UPDATE student_activities SET status = 'left', left_on = ? WHERE id = ? AND status = 'enrolled'`).bind(indiaToday(), eid)]
  let cancelled = false, paidAlready = false
  if (row.invoice_id) {
    stmts.push(c.db.prepare(`UPDATE invoices SET status = 'cancelled', cancelled_reason = 'Left the activity', updated_at = ? WHERE id = ? AND paid_paise = 0 AND status <> 'cancelled'`)
      .bind(now(), row.invoice_id))
  }
  const res = await batch(c, stmts)
  if (row.invoice_id) {
    cancelled = (res[1].meta.changes ?? 0) > 0
    if (!cancelled) {
      const inv = await c.db.prepare(`SELECT (paid_paise > 0) AS paid FROM invoices WHERE id = ?`).bind(row.invoice_id).first<{ paid: number }>()
      paidAlready = bool(inv?.paid)
    }
  }
  return ok({ left: true, invoice_cancelled: cancelled, already_paid: paidAlready })
}

// --- custom fields and partial edits ---------------------------------------------------------------

const jsonPath = (k: string) => `$."${k.replace(/"/g, '\\"')}"`

async function saveStudentCustomFields(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{ custom_fields?: Record<string, string> }>(c.req)
  const cf = req.custom_fields ?? {}
  if (Object.keys(cf).length === 0) throw badRequest('nothing to save')
  if (Object.keys(cf).length > 40) throw badRequest('that is more fields than one save should carry')
  const set: Record<string, string | null> = {}
  const drop: string[] = []
  for (let [k, v] of Object.entries(cf)) {
    k = k.trim()
    if (k === '') throw badRequest('a field needs a name')
    v = str(v)
    if (k.length > 80 || v.length > 500) throw badRequest("keep a field's name under 80 characters and its value under 500")
    if (v.trim() === '') drop.push(k); else set[k] = v
  }
  const pred = studentPredicate(await resolveScope(c), 'st')
  // A merge patch removes a key whose value is null: one parameter however many fields are cleared (D1 caps binds at 100).
  for (const k of drop) set[k] = null
  const res = await c.db.prepare(`UPDATE students SET custom_fields = json_patch(custom_fields, ?), updated_at = ?
     WHERE id IN (SELECT st.id FROM students st WHERE st.id = ? AND ${pred.sql})`)
    .bind(JSON.stringify(set), now(), id, ...pred.args).run()
  if (!res.meta.changes) throw forbiddenMsg('missing permission: this child is not one you can edit')
  return ok({ saved: Object.keys(set).length, removed: drop.length })
}

const patchableStudentFields = new Set([
  'address_line1', 'address_line2', 'city', 'state', 'pincode', 'permanent_address', 'emergency_contact_name', 'emergency_contact_phone',
  'emergency_contact_relation', 'blood_group', 'mother_tongue', 'religion', 'nationality', 'category', 'aadhaar_last4', 'prior_school',
  'apaar_id', 'child_info_id', 'house_id', 'first_name', 'middle_name', 'last_name', 'date_of_birth', 'gender', 'medium', 'admission_no',
])

async function patchStudentFields(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<Record<string, string>>(c.req)
  const rollGiven = Object.prototype.hasOwnProperty.call(req, 'roll_no')
  let rollNo: number | null = null
  if (rollGiven) {
    const raw = str(req.roll_no).trim()
    delete req.roll_no
    if (raw !== '') {
      const n = Number(raw)
      if (!Number.isInteger(n) || n <= 0) throw badRequest('a roll number is a whole number above zero')
      if (n > 9999) throw badRequest('that is too large to be a roll number')
      rollNo = n
    }
  }
  if (Object.keys(req).length === 0 && !rollGiven) throw badRequest('nothing to change')

  const sets: string[] = []
  const args: unknown[] = []
  for (const [k, raw] of Object.entries(req)) {
    if (!patchableStudentFields.has(k)) throw badRequest(k + ' is not a field this endpoint can change')
    const v = str(raw).trim()
    switch (k) {
      case 'first_name': if (v === '') throw badRequest('a child needs a first name'); break
      case 'admission_no': if (v === '') throw badRequest('a child needs an admission number'); break
      case 'gender': if (v !== '' && !validGenders.has(v)) throw badRequest('gender must be male, female or other'); break
      case 'date_of_birth': if (v !== '' && !isDate(v)) throw badRequest('date of birth must be YYYY-MM-DD'); break
      case 'category': if (v !== '' && !validCategories.has(v)) throw badRequest('category must be general, obc, sc, st, ews or other'); break
      case 'aadhaar_last4': if (v !== '' && v.length !== 4) throw badRequest('record only the LAST FOUR digits of the Aadhaar number'); break
      case 'pincode': if (v !== '' && v.length !== 6) throw badRequest('a pincode is six digits'); break
      case 'house_id': if (v !== '' && !isUUID(v)) throw badRequest('that is not a house'); break
    }
    if (v.length > 500) throw badRequest('keep ' + k + ' under 500 characters')
    sets.push(`${k} = ?`)
    args.push(nullStr(v))
  }
  const pred = studentPredicate(await resolveScope(c), 'st')
  let touched = 0
  if (sets.length > 0) {
    const res = await c.db.prepare(`UPDATE students SET ${sets.join(', ')}, updated_at = ? WHERE id IN (SELECT st.id FROM students st WHERE st.id = ? AND ${pred.sql})`)
      .bind(...args, now(), id, ...pred.args).run()
    touched = res.meta.changes ?? 0
  } else {
    const one = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(id, ...pred.args).first()
    touched = one ? 1 : 0
  }
  if (!touched) throw forbiddenMsg('missing permission: this child is not one you can edit')
  let rollTouched = 0
  if (rollGiven) {
    if (rollNo !== null) {
      const clash = await c.db.prepare(`SELECT 1 AS ok FROM enrollments e WHERE e.roll_no = ? AND e.student_id <> ?
        AND e.section_id IN (SELECT section_id FROM enrollments WHERE student_id = ? AND status = 'active')`).bind(rollNo, id, id).first()
      if (clash) throw coded(409, 'roll_no_taken', 'another child in this section already has that roll number')
    }
    const res = await c.db.prepare(`UPDATE enrollments SET roll_no = ? WHERE student_id = ? AND status = 'active'`).bind(rollNo, id).run()
    rollTouched = res.meta.changes ?? 0
    if (!rollTouched) throw badRequest('this child has no current enrolment, so there is no register to give them a roll number in')
  }
  return ok({ changed: sets.length + (rollGiven ? 1 : 0) })
}

// --- documents ----------------------------------------------------------------------------------------

const docId = (c: Ctx) => { if (!isUUID(c.params.docID)) throw badRequest('invalid document id'); return c.params.docID }

async function addStudentDocument(c: Ctx) {
  const id = sid(c)
  const req = await readJSON<{ doc_type?: string; file_id?: string; notes?: string }>(c.req)
  const kind = str(req.doc_type).trim()
  if (kind === '') throw badRequest('say what the document is')
  if (kind.length > 80) throw badRequest('keep the document name under 80 characters')
  const fileId = str(req.file_id).trim()
  if (!isUUID(fileId)) throw badRequest('choose a file first')
  if (str(req.notes).length > 500) throw badRequest('keep the note under 500 characters')
  const pred = studentPredicate(await resolveScope(c), 'st')
  const newId = uuid()
  const res = await c.db.prepare(`INSERT INTO student_documents (id, institution_id, student_id, file_id, doc_type, notes, created_at)
    SELECT ?, ?, st.id, ?, ?, ?, ? FROM students st WHERE st.id = ? AND ${pred.sql}`)
    .bind(newId, inst(c), fileId, kind, nullStr(str(req.notes)), now(), id, ...pred.args).run()
  if (!res.meta.changes) throw forbiddenMsg('missing permission: this child is not one you can edit')
  return created({ id: newId })
}

async function verifyStudentDocument(c: Ctx) {
  const id = sid(c), did = docId(c)
  const req = await readJSON<{ verified?: boolean }>(c.req)
  const pred = studentPredicate(await resolveScope(c), 'st')
  const res = await c.db.prepare(`UPDATE student_documents SET verified_by = ?, verified_at = ? WHERE id = ? AND student_id = ?
      AND EXISTS (SELECT 1 FROM students st WHERE st.id = student_documents.student_id AND ${pred.sql})`)
    .bind(req.verified ? c.id.userId : null, req.verified ? now() : null, did, id, ...pred.args).run()
  if (!res.meta.changes) throw forbiddenMsg('missing permission: that document is not one you can edit')
  return ok({ verified: !!req.verified })
}

async function deleteStudentDocument(c: Ctx) {
  const id = sid(c), did = docId(c)
  const pred = studentPredicate(await resolveScope(c), 'st')
  const res = await c.db.prepare(`DELETE FROM student_documents WHERE id = ? AND student_id = ?
      AND EXISTS (SELECT 1 FROM students st WHERE st.id = student_documents.student_id AND ${pred.sql})`).bind(did, id, ...pred.args).run()
  if (!res.meta.changes) throw forbiddenMsg('missing permission: that document is not one you can edit')
  return ok({ deleted: true })
}

// --- bulk import ------------------------------------------------------------------------------------------

interface ImportRow { row: number; data?: Record<string, string>; problem?: string }
interface Parsed { req: StudentWriteRequest; row: number; key: string }

async function importStudents(c: Ctx) {
  const q = c.url.searchParams
  const commit = q.get('commit') === 'true'
  const raw = await c.req.text()
  if (raw.length > 8 << 20) throw badRequest('could not read the file. Is it larger than 8 MB?')
  const records = parseCSV(raw)
  if (records.length === 0) throw badRequest('could not read the CSV header')
  const header = records[0]
  const strip = (h: string) => h.replace(/^﻿/, '').trim()
  let col: Record<string, number> = {}
  header.forEach((h, i) => { col[strip(h).toLowerCase()] = i })

  const customCols: Record<string, number> = {}
  const mapHeader = (c.req.headers.get('x-column-map') ?? '').trim()
  let colMap: Record<string, string> | null = null
  if (mapHeader) { try { colMap = JSON.parse(mapHeader) } catch { colMap = null } }
  if (colMap && Object.keys(colMap).length > 0) {
    const remapped: Record<string, number> = {}
    for (const [ours, theirs] of Object.entries(colMap)) {
      if (str(theirs).trim() === '') continue
      const key = strip(str(theirs)).toLowerCase()
      let i = col[key]
      if (i === undefined) {
        const t = str(theirs).trim()
        if (!t.startsWith('#')) continue
        const n = Number(t.slice(1))
        if (!Number.isInteger(n) || n < 0 || n >= header.length) continue
        i = n
      }
      if (ours.startsWith('custom:')) {
        const label = ours.slice('custom:'.length).trim()
        if (label !== '') customCols[label] = i
        continue
      }
      remapped[ours.trim().toLowerCase()] = i
    }
    col = remapped
  }
  const used = new Set<number>([...Object.values(col), ...Object.values(customCols)])
  header.forEach((h, i) => {
    if (used.has(i)) return
    const label = strip(h)
    if (label !== '') customCols[label] = i
  })
  if (!('full_name' in col) && !('first_name' in col)) {
    throw badRequest("nothing is pointed at the child's name, and a row cannot be built without it. Choose which of your columns holds it. Everything else is optional.")
  }
  const get = (rec: string[], name: string) => { const i = col[name]; return i === undefined || i >= rec.length ? '' : rec[i].trim() }

  let matchOn = (q.get('match_on') ?? '').trim() || 'admission_no'
  let matchLabel = matchOn
  let keyOf: (rec: string[]) => string = () => ''
  if (matchOn === 'none') matchLabel = 'nothing'
  else if (matchOn === 'admission_no') keyOf = (rec) => get(rec, 'admission_no')
  else if (matchOn === 'person_code') keyOf = (rec) => get(rec, 'person_code')
  else if (matchOn.startsWith('custom:')) {
    const label = matchOn.slice('custom:'.length).trim()
    const i = customCols[label]
    if (i === undefined) throw badRequest(`no column is being kept as "${label}", so it cannot identify a person`)
    matchLabel = label
    keyOf = (rec) => (i < rec.length ? rec[i].trim() : '')
  } else throw badRequest('identify people by admission_no, person_code, one of your own columns, or none')

  const seenKeys = new Map<string, number>()
  let good: Parsed[] = []
  const out: { total: number; valid: number; rejected: number; imported: number; dry_run: boolean; problems: ImportRow[]; run_id?: string } =
    { total: 0, valid: 0, rejected: 0, imported: 0, dry_run: !commit, problems: [] }

  for (let rowNum = 2; rowNum <= records.length; rowNum++) {
    const rec = records[rowNum - 1]
    out.total++
    let [first, middle, last] = splitName(get(rec, 'full_name'))
    if (first === '') { first = get(rec, 'first_name'); middle = get(rec, 'middle_name'); last = get(rec, 'last_name') }
    const category = get(rec, 'category')
    const req: StudentWriteRequest = {
      admission_no: get(rec, 'admission_no'), first_name: first, middle_name: middle, last_name: last,
      date_of_birth: normaliseDate(get(rec, 'date_of_birth')), gender: normaliseGender(get(rec, 'gender')),
      blood_group: get(rec, 'blood_group'), medium: get(rec, 'medium').toLowerCase(), mother_tongue: get(rec, 'mother_tongue'),
      address_line1: get(rec, 'address'), city: get(rec, 'city'), state: get(rec, 'state'), pincode: get(rec, 'pincode'),
      apaar_id: get(rec, 'apaar_id'), child_info_id: get(rec, 'child_info_id'), prior_school: get(rec, 'prior_school'),
      category: knownCategory(category),
      section_id: sectionLabel(get(rec, 'section'), get(rec, 'class')),
      custom_fields: withUnmapped(customValues(rec, customCols), 'Category', category, knownCategory(category) === ''),
      admission_date: normaliseDate(get(rec, 'admission_date')), previous_class: get(rec, 'previous_class'), previous_year: get(rec, 'previous_year'),
      is_rte: isTruthy(get(rec, 'is_rte')), is_cwsn: isTruthy(get(rec, 'is_cwsn')),
      guardian_name: firstNonEmpty(get(rec, 'guardian_name'), get(rec, 'father_name')),
      guardian_phone: firstNonEmpty(get(rec, 'guardian_phone'), get(rec, 'father_phone')),
      guardian_email: firstNonEmpty(get(rec, 'guardian_email'), get(rec, 'father_email')),
      guardian_relation: firstNonEmpty(get(rec, 'guardian_relation'), relationIfNamed(get(rec, 'father_name'), 'father')).toLowerCase(),
      guardian2_name: firstNonEmpty(get(rec, 'guardian2_name'), get(rec, 'mother_name')),
      guardian2_phone: firstNonEmpty(get(rec, 'guardian2_phone'), get(rec, 'mother_phone')),
      guardian2_email: firstNonEmpty(get(rec, 'guardian2_email'), get(rec, 'mother_email')),
      guardian2_relation: firstNonEmpty(get(rec, 'guardian2_relation'), relationIfNamed(get(rec, 'mother_name'), 'mother')).toLowerCase(),
      guardian3_name: firstNonEmpty(get(rec, 'guardian3_name'), get(rec, 'guardian_name_3')),
      guardian3_phone: firstNonEmpty(get(rec, 'guardian3_phone'), get(rec, 'guardian_phone_3')),
      guardian3_email: firstNonEmpty(get(rec, 'guardian3_email'), get(rec, 'guardian_email_3')),
      guardian3_relation: get(rec, 'guardian3_relation').toLowerCase(),
      concession_kind: get(rec, 'concession'), concession_percent: get(rec, 'concession_percent'),
      concession_amount: get(rec, 'concession_amount'), concession_reason: get(rec, 'concession_reason'),
      aadhaar_last4: aadhaarTail(get(rec, 'aadhaar'), get(rec, 'aadhaar_last4'), get(rec, 'student_aadhaar_number')),
    }
    const roll = get(rec, 'roll_no')
    if (roll !== '') req.roll_no = parseInt(roll, 10) || 0

    if (matchOn !== 'none') {
      const key = keyOf(rec).toLowerCase()
      if (key === '') {
        out.rejected++
        out.problems.push({ row: rowNum, problem: `this row has no ${matchLabel}, which is the column chosen to identify people. Fill it in, or choose a different column`, data: { first_name: req.first_name } })
        continue
      }
      const firstRow = seenKeys.get(key)
      if (firstRow !== undefined) {
        out.rejected++
        out.problems.push({ row: rowNum, problem: `${matchLabel} "${keyOf(rec)}" is already on row ${firstRow} of this file. Two rows cannot be the same person`, data: { first_name: req.first_name } })
        continue
      }
      seenKeys.set(key, rowNum)
    }
    const bad = validateStudent(req)
    if (bad) {
      out.rejected++
      out.problems.push({ row: rowNum, problem: bad, data: { first_name: req.first_name, admission_no: str(req.admission_no) } })
      continue
    }
    out.valid++
    good.push({ req, row: rowNum, key: keyOf(rec) })
  }

  const sectionByLabel: Record<string, string> = {}
  if (good.length > 0) {
    const rows = await c.db.prepare(`SELECT lower(c.name || '-' || s.name) AS label, s.id FROM sections s JOIN classes c ON c.id = s.class_id`).all<{ label: string; id: string }>()
    for (const r of rows.results) sectionByLabel[r.label] = r.id
  }
  good = good.filter((g) => {
    const label = str(g.req.section_id).trim()
    if (label === '' || sectionByLabel[label.toLowerCase()]) return true
    out.valid--; out.rejected++
    out.problems.push({ row: g.row, problem: `no class and section called "${label}". Create the classes and sections first, and write them as the school does — Class 6 and A` })
    return false
  })

  const seenRoll = new Map<string, number>()
  good = good.filter((g) => {
    if (!g.req.roll_no) return true
    const k = `${str(g.req.section_id).toLowerCase()}\x00${g.req.roll_no}`
    const first = seenRoll.get(k)
    if (first !== undefined) {
      out.valid--; out.rejected++
      out.problems.push({ row: g.row, problem: `roll number ${g.req.roll_no} is already used by row ${first} in ${g.req.section_id}. Two children in one section cannot share a roll number, change one of them, or leave the column blank and none will be set.` })
      return false
    }
    seenRoll.set(k, g.row)
    return true
  })
  if (seenRoll.size > 0) {
    const taken = new Map<string, string>()
    const rows = await c.db.prepare(`SELECT lower(c.name || '-' || sec.name) AS label, e.roll_no AS roll, ${shortNameSQL('st')} AS who
      FROM enrollments e JOIN sections sec ON sec.id = e.section_id JOIN classes c ON c.id = sec.class_id JOIN students st ON st.id = e.student_id
     WHERE e.roll_no IS NOT NULL AND e.status = 'active'`).all<{ label: string; roll: number; who: string }>()
    for (const r of rows.results) taken.set(`${r.label}\x00${r.roll}`, r.who)
    good = good.filter((g) => {
      if (!g.req.roll_no) return true
      const who = taken.get(`${str(g.req.section_id).toLowerCase()}\x00${g.req.roll_no}`)
      const mine = `${g.req.first_name} ${g.req.last_name ?? ''}`.trim().split(/\s+/).join(' ')
      if (who !== undefined && who.trim().toLowerCase() !== mine.toLowerCase()) {
        out.valid--; out.rejected++
        out.problems.push({ row: g.row, problem: `roll number ${g.req.roll_no} in ${g.req.section_id} already belongs to ${who}. Change it, or leave the column blank.` })
        return false
      }
      return true
    })
  }

  if (!commit) return ok(out)
  if (out.rejected > 0) throw coded(400, 'import_has_errors', `${out.rejected} of ${out.total} rows are invalid; fix them and upload again`)

  if (matchOn === 'person_code' || matchOn.startsWith('custom:')) {
    const byKey = new Map<string, string>()
    const label = matchOn.startsWith('custom:') ? matchOn.slice('custom:'.length).trim() : null
    // One query per key set would be ideal; D1 binds at most ~100 values, so the roll is scanned once and matched here.
    const rows = label === null
      ? await c.db.prepare(`SELECT lower(person_code) AS k, admission_no FROM students WHERE person_code IS NOT NULL`).all<{ k: string; admission_no: string }>()
      : await c.db.prepare(`SELECT lower(json_extract(custom_fields, ?)) AS k, admission_no FROM students WHERE json_extract(custom_fields, ?) IS NOT NULL`)
        .bind(jsonPath(label), jsonPath(label)).all<{ k: string; admission_no: string }>()
    for (const r of rows.results) byKey.set(r.k, r.admission_no)
    for (const g of good) { const adm = byKey.get(g.key.toLowerCase()); if (adm !== undefined) g.req.admission_no = adm }
  }

  const stmts: D1PreparedStatement[] = []
  const createdIds: string[] = []
  try {
    for (const g of good) {
      const sec = sectionByLabel[str(g.req.section_id).toLowerCase()]
      if (sec) g.req.section_id = sec
      const plan = await planUpsertStudent(c, g.req)
      stmts.push(...plan.stmts)
      if (plan.created) createdIds.push(plan.studentId)
      out.imported++
    }
  } catch (err) {
    out.imported = 0
    const msg = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err)
    throw coded(400, 'import_failed', msg)
  }
  const runId = uuid()
  const kept = raw.length > 1 << 20 ? '' : raw
  stmts.push(c.db.prepare(`INSERT INTO import_runs (id, institution_id, entity, filename, rows_read, rows_imported, rows_rejected, imported_by, content, content_omitted, created_at)
    VALUES (?, ?, 'students', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(runId, inst(c), nullStr((q.get('filename') ?? '').trim()), out.total, out.imported, out.rejected, c.id.userId, nullStr(kept), kept === '' && raw.length > 0 ? 1 : 0, now()))
  for (const id of createdIds) {
    stmts.push(c.db.prepare(`INSERT OR IGNORE INTO import_run_rows (run_id, institution_id, entity, record_id) VALUES (?, ?, 'students', ?)`).bind(runId, inst(c), id))
  }
  try { await batch(c, stmts) } catch (err) {
    out.imported = 0
    throw coded(400, 'import_failed', err instanceof Error ? err.message : String(err))
  }
  out.run_id = runId
  return ok(out)
}

