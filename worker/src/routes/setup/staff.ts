import type { Router } from '../../router'
import { Messenger, scopeOf } from '../../services/messaging'
import type { Ctx } from '../../router'
import { HttpError, badRequest, created, forbidden, notFound, ok, readJSON, uuid, uuidParam, now, bool, isUUID } from '../../http'
import { can } from '../../identity'
import { requireInstitution, instId, nullStr, ensureCampus, appointEmployee, employeeRoles, PLATFORM_ONLY_ROLES, PhoneInUse,
  plural, oneOfStr, todayIndia, monthIndia, endAccess, revokeSessions, isUniqueViolation, trim, str, batch, changes, istClock, istDate,
  clockMinutes, uniqueUsername, issuedPassword, temporaryPassword, temporaryPIN, hash, signInAs, grantRole, normalisePhone } from './common'
import { assignSectionTeacher } from './academics'

/* Port of the staff half of setup.go, employee_edit.go, work_patterns.go,
   staff_hours.go, staff_login.go, device_login.go (issueStaffPIN),
   staff_record_write.go, staff_detail.go (subjects), staff_login_import.go,
   iclock.go (device registration), family_logins.go and bulk_logins.go. */

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined
const asInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : Number.isInteger(Number(v)) ? Number(v) : 0)

interface FamilyCredential { sourceId: string; hash: string; fullName: string; phone: string; email: string; signInAs: string; password: string }

/** queueFamilyLogin (admission_welcome.go): the sign-in on WhatsApp, SMS and email; returns the channels queued. */
async function queueFamilyLogin(c: Ctx, cr: FamilyCredential, ms?: Messenger): Promise<string[]> {
  if (cr.signInAs.trim() === '') return []
  const own = !ms
  const m = ms ?? new Messenger(scopeOf(c))
  const inst = await c.db.prepare(`SELECT name, credentials_by_email_only FROM institutions WHERE id = ?`).bind(instId(c))
    .first<{ name: string; credentials_by_email_only: number | null }>().catch(() => null)
  const emailOnly = inst ? !!Number(inst.credentials_by_email_only) : true
  const code = cr.password === '' ? 'admissions.portal_existing' : 'admissions.portal_login'
  const vars = { school_name: inst?.name ?? '', parent_name: cr.fullName !== '' ? cr.fullName : 'Sir/Madam', sign_in_as: cr.signInAs,
    password: cr.password, portal_url: new URL(c.req.url).origin + '/login' }
  const tag = cr.hash.length > 12 ? cr.hash.slice(-12) : cr.hash
  const sent: string[] = []
  for (const channel of ['whatsapp', 'sms', 'email']) {
    const to = (channel === 'email' ? cr.email : cr.phone).trim()
    if (to === '') continue
    const tcode = channel !== 'email' && emailOnly && cr.password !== '' ? 'admissions.portal_ready' : code
    try {
      await m.queue({ channel, template_code: tcode, vars, recipient: to, source_kind: 'guardian_login', source_id: cr.sourceId, occurrence_key: `${tag}:${channel}` })
      sent.push(channel)
    } catch { /* a channel that cannot carry it is skipped */ }
  }
  if (own) await m.kick()
  return sent
}

const employeeStatuses = ['active', 'on_leave', 'suspended', 'resigned', 'terminated', 'retired']

/** Parses the working_days TEXT column (a JSON array of ISO weekdays). */
function workingDaysOf(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number)
  if (typeof v === 'string' && v.trim() !== '') {
    try { const a = JSON.parse(v); if (Array.isArray(a)) return a.map(Number) } catch { /* pg array text */ }
    return v.replace(/[{}\[\]\s]/g, '').split(',').filter(Boolean).map(Number)
  }
  return [1, 2, 3, 4, 5, 6]
}

interface StaffPattern {
  starts_at: string | null; ends_at: string | null; grace: number; full_min: number; half_min: number; working_days: number[]
}

/** Each person's hours, most specific first: their own, their department's, the school's default. */
const PATTERN_SQL = `
  COALESCE(p1.starts_at, p2.starts_at, p3.starts_at) AS starts_at,
  COALESCE(p1.ends_at, p2.ends_at, p3.ends_at) AS ends_at,
  COALESCE(p1.grace_minutes, p2.grace_minutes, p3.grace_minutes, 10) AS grace,
  COALESCE(p1.full_day_minutes, p2.full_day_minutes, p3.full_day_minutes, 420) AS full_min,
  COALESCE(p1.half_day_minutes, p2.half_day_minutes, p3.half_day_minutes, 210) AS half_min,
  COALESCE(p1.working_days, p2.working_days, p3.working_days) AS working_days`
const PATTERN_JOINS = `
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN work_patterns p1 ON p1.id = e.work_pattern_id
  LEFT JOIN work_patterns p2 ON p2.id = d.work_pattern_id
  LEFT JOIN work_patterns p3 ON p3.institution_id = e.institution_id AND p3.is_default = 1`

function monthDays(month: string): string[] {
  const [y, m] = month.split('-').map(Number)
  const out: string[] = []
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  for (let d = 1; d <= last; d++) out.push(`${month}-${String(d).padStart(2, '0')}`)
  return out
}
/** ISO weekday, 1 Monday to 7 Sunday. */
const isoDow = (date: string): number => ((new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1

async function staffHolidays(c: Ctx, from: string, to: string): Promise<Set<string>> {
  const rows = await c.db.prepare(`SELECT on_date, to_date FROM holidays WHERE kind IN ('holiday','vacation') AND applies_to IN ('all','staff')
      AND on_date <= ? AND COALESCE(to_date, on_date) >= ?`).bind(to, from).all<{ on_date: string; to_date: string | null }>()
  const days = new Set<string>()
  for (const h of rows.results) {
    const end = h.to_date ?? h.on_date
    for (let d = new Date(h.on_date + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      days.add(d.toISOString().slice(0, 10))
    }
  }
  return days
}

function statusInWords(status: string): string {
  return ({ present: 'Present', absent: 'Absent', late: 'Late', half_day: 'Half day', leave: 'On leave', holiday: 'Holiday', week_off: 'Week off' } as Record<string, string>)[status] ?? status
}

export function registerStaff(r: Router): void {
  /* --- employees --- */

  r.post('/setup/employees', 'hr.employees.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const body = {
      employee_code: str(req.employee_code), first_name: str(req.first_name), last_name: str(req.last_name), email: str(req.email),
      phone: str(req.phone), department_id: str(req.department_id), designation_id: str(req.designation_id), joined_on: str(req.joined_on),
      employment_type: str(req.employment_type), create_login: req.create_login === true, role_key: str(req.role_key),
      role_keys: Array.isArray(req.role_keys) ? (req.role_keys as unknown[]).map(str) : [],
    }
    if (body.first_name === '') throw badRequest('first_name is required')
    if (body.create_login && body.email === '' && body.phone === '') throw badRequest('an email or a phone number is required to create a login')
    for (const k of employeeRoles(body)) {
      if (PLATFORM_ONLY_ROLES.has(k) && !c.id.platformAdmin) {
        throw new HttpError(403, "that role belongs to the people who operate this installation, not to a school. Pick one of your own school's roles.", { code: 'platform_role' })
      }
    }
    const campus = await ensureCampus(c)
    let out: { empId: string; userId: string; created: boolean }
    try {
      out = await appointEmployee(c, campus, body)
    } catch (e) {
      if (e instanceof PhoneInUse) {
        throw new HttpError(409, 'that phone number already belongs to somebody at this school. Check the number, or leave it blank if this person does not need one', { code: 'phone_in_use' })
      }
      throw e
    }
    return created({ id: out.empId, user_id: out.userId === '' ? null : out.userId, employee_code: body.employee_code, created: out.created })
  })

  r.patch('/setup/employees/{id}', 'hr.employees.write', async (c) => {
    const empId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    let firstName: string | null = null
    if (has(req, 'first_name')) { firstName = str(req.first_name).trim(); if (firstName === '') throw badRequest('a staff record needs a first name') }
    const status = has(req, 'status') ? str(req.status) : null
    if (status !== null && !oneOfStr(status, ...employeeStatuses)) throw badRequest('status must be one of ' + employeeStatuses.join(', '))
    const exp = has(req, 'experience_years') ? asInt(req.experience_years) : null
    if (exp !== null && (exp < 0 || exp > 70)) throw badRequest('experience must be between 0 and 70 years')
    const s = (k: string): string | null => (has(req, k) ? str(req[k]) : null)
    let relieved = s('relieved_on')
    const leaving = status !== null && oneOfStr(status, 'resigned', 'terminated', 'retired')
    if (relieved === null && leaving) relieved = todayIndia()
    const t = now()
    let res: D1Result
    try {
      // employees_touch trigger: updated_at is stamped here.
      res = await c.db.prepare(`UPDATE employees SET
          first_name = COALESCE(?24, first_name),
          last_name = CASE WHEN ?1 IS NULL THEN last_name ELSE NULLIF(?1, '') END,
          phone = CASE WHEN ?2 IS NULL THEN phone ELSE NULLIF(?2, '') END,
          email = CASE WHEN ?3 IS NULL THEN email ELSE NULLIF(?3, '') END,
          department_id = CASE WHEN ?4 IS NULL THEN department_id ELSE NULLIF(?4, '') END,
          designation_id = CASE WHEN ?5 IS NULL THEN designation_id ELSE NULLIF(?5, '') END,
          employment_type = COALESCE(NULLIF(?6, ''), employment_type),
          status = COALESCE(NULLIF(?7, ''), status),
          joined_on = COALESCE(?8, joined_on),
          confirmed_on = CASE WHEN ?9 IS NULL THEN confirmed_on ELSE NULLIF(?9, '') END,
          relieved_on = CASE WHEN ?10 IS NULL THEN relieved_on ELSE COALESCE(relieved_on, NULLIF(?10, '')) END,
          device_user_id = COALESCE(?11, device_user_id),
          qualification = CASE WHEN ?12 IS NULL THEN qualification ELSE NULLIF(?12, '') END,
          experience_years = COALESCE(?13, experience_years),
          address = CASE WHEN ?14 IS NULL THEN address ELSE NULLIF(?14, '') END,
          bank_account = CASE WHEN ?15 IS NULL THEN bank_account ELSE NULLIF(?15, '') END,
          bank_ifsc = CASE WHEN ?16 IS NULL THEN bank_ifsc ELSE upper(NULLIF(?16, '')) END,
          pan = CASE WHEN ?17 IS NULL THEN pan ELSE upper(NULLIF(?17, '')) END,
          uan = CASE WHEN ?18 IS NULL THEN uan ELSE NULLIF(?18, '') END,
          esi_number = CASE WHEN ?19 IS NULL THEN esi_number ELSE NULLIF(?19, '') END,
          emergency_contact_name = CASE WHEN ?20 IS NULL THEN emergency_contact_name ELSE NULLIF(?20, '') END,
          emergency_contact_phone = CASE WHEN ?21 IS NULL THEN emergency_contact_phone ELSE NULLIF(?21, '') END,
          updated_at = ?22
        WHERE id = ?23`)
        .bind(s('last_name'), s('phone'), s('email'), s('department_id'), s('designation_id'), s('employment_type'), status, s('joined_on'),
          s('confirmed_on'), relieved, has(req, 'device_user_id') ? asInt(req.device_user_id) : null, s('qualification'), exp, s('address'),
          s('bank_account'), s('bank_ifsc'), s('pan'), s('uan'), s('esi_number'), s('emergency_contact_name'), s('emergency_contact_phone'), t, empId, firstName)
        .run()
    } catch (e) {
      if (e instanceof Error && e.message.includes('employees.institution_id, employees.employee_code')) throw badRequest('another staff record already uses that employee code')
      if (e instanceof Error && e.message.includes('device_user_id')) throw badRequest('another member of staff is already enrolled on the reader under that id · two people cannot be the same finger')
      throw e
    }
    if (!res.meta.changes) throw badRequest('no such staff record in this school')
    const row = await c.db.prepare(`SELECT TRIM(first_name || ' ' || COALESCE(last_name, '')) AS name, status, user_id FROM employees WHERE id = ?`).bind(empId)
      .first<{ name: string; status: string; user_id: string | null }>()
    let accessEnded = false
    if (leaving && row?.user_id) { await endAccess(c, row.user_id); accessEnded = true }
    // Carry a new contact detail through to the login; a clash leaves the account alone.
    if ((has(req, 'phone') || has(req, 'email')) && row?.user_id) {
      const email = s('email'), phone = s('phone')
      try {
        await c.db.prepare(`UPDATE users SET
            email = CASE WHEN ?1 IS NULL THEN email ELSE NULLIF(?1, '') END,
            phone = CASE WHEN ?2 IS NULL THEN phone ELSE NULLIF(?2, '') END,
            username = CASE WHEN NULLIF(?2, '') IS NOT NULL AND username = (SELECT phone FROM employees WHERE id = ?3) THEN NULLIF(?2, '')
                            WHEN NULLIF(?1, '') IS NOT NULL AND username = (SELECT email FROM employees WHERE id = ?3) THEN NULLIF(?1, '')
                            ELSE username END,
            updated_at = ?4 WHERE id = (SELECT user_id FROM employees WHERE id = ?3)`).bind(email, phone, empId, t).run()
      } catch (e) {
        if (!isUniqueViolation(e)) throw e
      }
    }
    return ok({ id: empId, name: row?.name ?? '', status: row?.status ?? '', login_ended: accessEnded })
  })

  /* --- work patterns --- */

  r.get('/setup/work-patterns', 'hr.employees.read', async (c) => {
    const rows = await c.db.prepare(`SELECT p.id, p.name, p.starts_at, p.ends_at, p.grace_minutes, p.full_day_minutes, p.half_day_minutes, p.working_days,
        p.lop_basis, p.lop_per_day_paise, p.salary_divisor, p.lates_for_half_day, p.is_default,
        COALESCE((SELECT GROUP_CONCAT(name, ', ') FROM (SELECT d.name FROM departments d WHERE d.work_pattern_id = p.id ORDER BY d.name)), '') AS departments,
        (SELECT COUNT(*) FROM employees e WHERE e.work_pattern_id = p.id) AS people
        FROM work_patterns p ORDER BY p.is_default DESC, p.name`).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const o: Record<string, unknown> = {
        id: v.id, name: v.name, starts_at: String(v.starts_at).slice(0, 5), ends_at: String(v.ends_at).slice(0, 5),
        grace_minutes: Number(v.grace_minutes), full_day_minutes: Number(v.full_day_minutes), half_day_minutes: Number(v.half_day_minutes),
        working_days: workingDaysOf(v.working_days), lop_basis: v.lop_basis,
      }
      if (v.lop_per_day_paise !== null) o.lop_per_day_paise = Number(v.lop_per_day_paise)
      o.salary_divisor = Number(v.salary_divisor)
      o.lates_for_half_day = Number(v.lates_for_half_day)
      o.is_default = bool(v.is_default)
      o.departments = v.departments
      o.people = Number(v.people)
      return o
    })
    return ok({ items })
  })

  r.get('/setup/work-patterns/staff', 'hr.employees.read', async (c) => {
    const rows = await c.db.prepare(`SELECT e.id, e.employee_code, TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS name, COALESCE(d.name, '') AS department,
        COALESCE((SELECT GROUP_CONCAT(name, ', ') FROM (SELECT DISTINCT c.name FROM section_subject_teachers sst JOIN class_subjects cs ON cs.id = sst.class_subject_id
                  JOIN classes c ON c.id = cs.class_id WHERE sst.teacher_user_id = e.user_id ORDER BY c.name)), '') AS teaches,
        COALESCE(p1.name, p2.name, p3.name, '') AS pattern, (e.work_pattern_id IS NOT NULL) AS own_pattern
        FROM employees e ${PATTERN_JOINS} WHERE e.status = 'active' ORDER BY name, e.employee_code`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, employee_code: v.employee_code, full_name: v.name, department: v.department,
      teaches: v.teaches, pattern: v.pattern, own_pattern: bool(v.own_pattern) })) })
  })

  r.get('/setup/departments', 'hr.employees.read', async (c) => {
    const rows = await c.db.prepare(`SELECT d.id, d.name, (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.status = 'active') AS people,
        COALESCE(p.name, '') AS pattern FROM departments d LEFT JOIN work_patterns p ON p.id = d.work_pattern_id ORDER BY d.name`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, name: v.name, people: Number(v.people), pattern: v.pattern })) })
  })

  r.post('/setup/work-patterns', 'hr.employees.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name).trim()
    if (name === '') throw badRequest('give these hours a name · Teaching, Office, Transport')
    const startsAt = str(req.starts_at), endsAt = str(req.ends_at)
    if (startsAt === '' || endsAt === '' || startsAt >= endsAt) throw badRequest('the day has to end after it starts')
    const grace = has(req, 'grace_minutes') ? asInt(req.grace_minutes) : 10
    const full = has(req, 'full_day_minutes') ? asInt(req.full_day_minutes) : 420
    const half = has(req, 'half_day_minutes') ? asInt(req.half_day_minutes) : 210
    if (grace < 0 || full <= 0 || half <= 0 || half > full) throw badRequest('a half day cannot be longer than a full one, and none of these can be negative')
    let days = Array.isArray(req.working_days) ? (req.working_days as unknown[]).map(Number) : []
    if (days.length === 0) days = [1, 2, 3, 4, 5, 6]
    let basis = str(req.lop_basis).trim()
    if (basis === '') basis = 'none'
    if (!['none', 'fixed', 'salary'].includes(basis)) throw badRequest('how pay is cut must be none, fixed or salary')
    const perDay = has(req, 'lop_per_day_paise') && req.lop_per_day_paise !== null ? Math.trunc(Number(req.lop_per_day_paise)) : null
    if (basis === 'fixed' && (perDay === null || perDay <= 0)) throw badRequest("say how much a day's absence costs")
    const divisor = has(req, 'salary_divisor') ? asInt(req.salary_divisor) : 30
    if (divisor < 0) throw badRequest('divide the month by a positive number of days, or by 0 to use the days actually expected')
    const lates = has(req, 'lates_for_half_day') ? asInt(req.lates_for_half_day) : 0
    if (lates < 0) throw badRequest('lates before a half day cannot be negative')
    const isDefault = req.is_default === true
    const inst = instId(c)
    const t = now()
    const existing = await c.db.prepare(`SELECT id FROM work_patterns WHERE institution_id = ? AND name = ?`).bind(inst, name).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const stmts: D1PreparedStatement[] = [existing
      ? c.db.prepare(`UPDATE work_patterns SET starts_at = ?, ends_at = ?, grace_minutes = ?, full_day_minutes = ?, half_day_minutes = ?, working_days = ?, lop_basis = ?,
          lop_per_day_paise = ?, salary_divisor = ?, lates_for_half_day = ?, updated_at = ? WHERE id = ?`)
        .bind(startsAt, endsAt, grace, full, half, JSON.stringify(days), basis, perDay, divisor, lates, t, id)
      : c.db.prepare(`INSERT INTO work_patterns (id, institution_id, name, starts_at, ends_at, grace_minutes, full_day_minutes, half_day_minutes, working_days, lop_basis,
          lop_per_day_paise, salary_divisor, lates_for_half_day, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst, name, startsAt, endsAt, grace, full, half, JSON.stringify(days), basis, perDay, divisor, lates, isDefault ? 1 : 0, t, t)]
    if (isDefault) stmts.push(c.db.prepare(`UPDATE work_patterns SET is_default = (id = ?) WHERE institution_id = ?`).bind(id, inst))
    const deptIds = Array.isArray(req.department_ids) ? (req.department_ids as unknown[]).map(str).filter(isUUID) : []
    if (deptIds.length > 0) {
      stmts.push(c.db.prepare(`UPDATE departments SET work_pattern_id = ? WHERE institution_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(id, inst, JSON.stringify(deptIds)))
    }
    await batch(c, stmts)
    return created({ id })
  })

  r.del('/setup/work-patterns/{id}', 'hr.employees.write', async (c) => {
    const patternId = uuidParam(c.params.id)
    const row = await c.db.prepare(`SELECT (SELECT COUNT(*) FROM employees e WHERE e.work_pattern_id = p.id) AS people,
        (SELECT COUNT(*) FROM departments d WHERE d.work_pattern_id = p.id) AS depts FROM work_patterns p WHERE p.id = ?`).bind(patternId).first<{ people: number; depts: number }>()
    if (!row) throw badRequest('no such work pattern in this school')
    if (row.people > 0 || row.depts > 0) {
      throw badRequest(plural(row.people, 'member of staff', 'members of staff') + ' and ' + plural(row.depts, 'department', 'departments') +
        " keep these hours. Move them to another set first, without one they fall back to the school's default and are judged by a rule nobody chose for them")
    }
    await c.db.prepare(`DELETE FROM work_patterns WHERE id = ?`).bind(patternId).run()
    return ok({ id: patternId })
  })

  r.post('/setup/work-patterns/assign', 'hr.employees.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const ids = Array.isArray(req.employee_ids) ? (req.employee_ids as unknown[]).map(str) : []
    if (ids.length === 0) throw badRequest('choose at least one member of staff')
    let pattern: string | null = null
    if (req.pattern_id !== null && req.pattern_id !== undefined && str(req.pattern_id).trim() !== '') {
      if (!isUUID(str(req.pattern_id).trim())) throw badRequest('invalid work pattern id')
      pattern = str(req.pattern_id).trim()
      const okRow = await c.db.prepare(`SELECT 1 AS x FROM work_patterns WHERE id = ?`).bind(pattern).first()
      if (!okRow) throw badRequest('those hours no longer exist')
    }
    const res = await c.db.prepare(`UPDATE employees SET work_pattern_id = ? WHERE institution_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(pattern, instId(c), JSON.stringify(ids)).run()
    return ok({ changed: res.meta.changes })
  })

  /* --- staff hours --- */

  r.get('/setup/staff-hours', 'hr.employees.read', async (c) => {
    let month = c.url.searchParams.get('month') ?? ''
    if (month === '') month = monthIndia()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('month must be written as 2026-09')
    const days = monthDays(month)
    const from = days[0], to = days[days.length - 1]
    const staff = await c.db.prepare(`SELECT e.id, e.user_id, e.employee_code, TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS name,
        COALESCE(d.name, '') AS department, COALESCE(p1.name, p2.name, p3.name, 'None') AS pattern, ${PATTERN_SQL},
        COALESCE(p1.lop_basis, p2.lop_basis, p3.lop_basis, 'none') AS lop_basis,
        COALESCE(p1.lop_per_day_paise, p2.lop_per_day_paise, p3.lop_per_day_paise) AS lop_paise,
        COALESCE(p1.salary_divisor, p2.salary_divisor, p3.salary_divisor, 30) AS divisor,
        (SELECT ss.ctc_paise FROM salary_structures ss WHERE ss.employee_id = e.id AND ss.effective_from <= ? AND (ss.effective_to IS NULL OR ss.effective_to >= ?)
          ORDER BY ss.effective_from DESC LIMIT 1) AS monthly_paise
        FROM employees e ${PATTERN_JOINS} WHERE e.status = 'active' ORDER BY department, name`).bind(from, from).all<Record<string, unknown>>()
    const holidays = await staffHolidays(c, from, to)
    const att = await c.db.prepare(`SELECT user_id, on_date, status, check_in, check_out FROM staff_attendance WHERE on_date BETWEEN ? AND ?`).bind(from, to)
      .all<{ user_id: string; on_date: string; status: string; check_in: string | null; check_out: string | null }>()
    const byUser = new Map<string, typeof att.results>()
    for (const a of att.results) { const l = byUser.get(a.user_id) ?? []; l.push(a); byUser.set(a.user_id, l) }

    const items = staff.results.map((s) => {
      const p: StaffPattern = { starts_at: s.starts_at as string | null, ends_at: s.ends_at as string | null, grace: Number(s.grace),
        full_min: Number(s.full_min), half_min: Number(s.half_min), working_days: workingDaysOf(s.working_days) }
      const expected = days.filter((d) => p.working_days.includes(isoDow(d)) && !holidays.has(d)).length
      let present = 0, halves = 0, excused = 0, marked = 0, late = 0, early = 0
      for (const a of byUser.get(String(s.user_id ?? '')) ?? []) {
        marked++
        const inClock = istClock(a.check_in), outClock = istClock(a.check_out)
        if (inClock) {
          const outMin = outClock ? clockMinutes(outClock) : p.ends_at ? clockMinutes(p.ends_at) : clockMinutes(inClock)
          const mins = outMin - clockMinutes(inClock)
          if (mins >= p.full_min) present++
          else if (mins >= p.half_min && mins <= p.full_min - 1) halves++
          if (p.starts_at && clockMinutes(inClock) > clockMinutes(p.starts_at) + p.grace) late++
        } else if (a.status === 'present' || a.status === 'late') present++
        else if (a.status === 'half_day') halves++
        if (['leave', 'holiday', 'week_off'].includes(a.status)) excused++
        if (outClock && p.ends_at && clockMinutes(outClock) < clockMinutes(p.ends_at)) early++
      }
      const unmarked = Math.max(0, expected - Math.min(marked, expected))
      const absent = Math.max(0, Math.min(marked, expected) - present - halves - excused)
      /* staff_lop_register (migration 00244) is payroll's rule and is not
         ported here: days lost are absences plus half of each half day. */
      const lopDays = absent + halves * 0.5
      const basis = String(s.lop_basis), perDay = s.lop_paise === null ? null : Number(s.lop_paise)
      const divisor = Number(s.divisor), monthly = s.monthly_paise === null ? null : Number(s.monthly_paise)
      const out: Record<string, unknown> = {
        employee_id: s.id, employee_code: s.employee_code, name: s.name, department: s.department, pattern: s.pattern,
        starts_at: p.starts_at ? p.starts_at.slice(0, 5) : '', ends_at: p.ends_at ? p.ends_at.slice(0, 5) : '', grace_minutes: p.grace,
        expected_days: expected, present_days: present, half_days: halves, unmarked_days: unmarked, absent_days: absent, late_days: late,
        early_leaves: early, lop_days: lopDays,
      }
      if (lopDays <= 0) out.lop_rule = 'Nothing lost'
      else if (basis === 'fixed' && perDay !== null) { out.lop_paise = Math.trunc(perDay * lopDays); out.lop_rule = 'A fixed amount for each day lost' }
      else if (basis === 'salary' && monthly !== null) {
        const per = divisor === 0 ? expected : divisor
        if (per > 0) { out.lop_paise = Math.trunc(monthly / per * lopDays); out.lop_rule = `Monthly pay divided by ${per} days` }
        else out.lop_rule = 'No days were expected this month'
      } else if (basis === 'salary') out.lop_rule = 'No salary on record, so days only'
      else out.lop_rule = 'This school does not deduct'
      return out
    })
    return ok({ items })
  })

  r.get('/setup/staff-hours/{id}', 'hr.employees.read', async (c) => {
    let month = c.url.searchParams.get('month') ?? ''
    if (month === '') month = monthIndia()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('month must be written as 2026-09')
    const employee = uuidParam(c.params.id)
    const me = await c.db.prepare(`SELECT e.id, e.user_id, ${PATTERN_SQL} FROM employees e ${PATTERN_JOINS} WHERE e.id = ?`).bind(employee).first<Record<string, unknown>>()
    if (!me) return ok({ items: [] })
    const p: StaffPattern = { starts_at: (me.starts_at as string | null) ?? '09:00', ends_at: (me.ends_at as string | null) ?? '16:00', grace: Number(me.grace),
      full_min: Number(me.full_min), half_min: Number(me.half_min), working_days: workingDaysOf(me.working_days) }
    const days = monthDays(month)
    const holidays = await staffHolidays(c, days[0], days[days.length - 1])
    const att = await c.db.prepare(`SELECT on_date, status, check_in, check_out FROM staff_attendance WHERE user_id = ? AND on_date BETWEEN ? AND ?`)
      .bind(String(me.user_id ?? ''), days[0], days[days.length - 1]).all<{ on_date: string; status: string; check_in: string | null; check_out: string | null }>()
    const byDay = new Map(att.results.map((a) => [a.on_date, a]))
    const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    const items = days.map((d) => {
      const a = byDay.get(d)
      const expected = p.working_days.includes(isoDow(d)) && !holidays.has(d)
      const o: Record<string, unknown> = { on_date: d, weekday: dow[isoDow(d) - 1], expected, due_in: p.starts_at!.slice(0, 5), due_out: p.ends_at!.slice(0, 5), status: a?.status ?? '' }
      const inClock = istClock(a?.check_in), outClock = istClock(a?.check_out)
      if (inClock) o.check_in = inClock
      if (outClock) o.check_out = outClock
      if (inClock) {
        const outMin = outClock ? clockMinutes(outClock) : clockMinutes(p.ends_at!)
        o.minutes = Math.trunc(outMin - clockMinutes(inClock))
        o.late_by_minutes = Math.max(0, Math.trunc(clockMinutes(inClock) - clockMinutes(p.starts_at!)))
      }
      const status = a?.status ?? ''
      o.verdict = !expected && status === '' ? 'Not a working day' : status === '' ? 'Nobody marked this day' : statusInWords(status)
      return o
    })
    return ok({ items })
  })

  /* --- staff logins --- */

  r.post('/setup/employees/{id}/login', 'hr.employees.write', async (c) => {
    requireInstitution(c)
    const empId = uuidParam(c.params.id)
    const reset = c.url.searchParams.get('reset') === 'true'
    const e = await c.db.prepare(`SELECT user_id, TRIM(first_name || ' ' || COALESCE(last_name, '')) AS full_name, employee_code, email, phone, staff_number, status FROM employees WHERE id = ?`)
      .bind(empId).first<{ user_id: string | null; full_name: string; employee_code: string; email: string | null; phone: string | null; staff_number: number | null; status: string }>()
    if (!e) throw new HttpError(404, 'no such employee', { code: 'not_found' })
    if (e.status !== 'active') {
      throw badRequest('this member of staff is not on the roll, so there is nobody to give a login to. Put them back on the roll first, their record, their ' +
        'service and their old attendance are all still here, and then a login can be issued.')
    }
    const errNoContact = 'this person has no staff number, email or phone on their record, add one first, or they will have nothing to sign in with'
    const staffNoText = e.staff_number === null ? null : String(e.staff_number)
    const { password, known } = issuedPassword(e.phone ?? '', e.email ?? '')
    const pwHash = await hash(c, password)
    let userId = e.user_id
    let existing = false
    const t = now()
    if (!userId) {
      if (!e.email && !e.phone && e.staff_number === null) throw badRequest(errNoContact)
      // The two unique indexes of users, checked here so the holder is named.
      const holder = await c.db.prepare(`SELECT full_name, CASE WHEN email = ? THEN 'email address' ELSE 'phone number' END AS which FROM users
          WHERE institution_id = ? AND ((? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND phone = ?)) LIMIT 1`)
        .bind(e.email, instId(c), e.email, e.email, e.phone, e.phone).first<{ full_name: string; which: string }>()
      if (holder) throw badRequest(`that ${holder.which} already belongs to ${holder.full_name}. Give this person their own, or clear it on their staff record and try again`)
      userId = uuid()
      await c.db.batch([
        c.db.prepare(`INSERT INTO users (id, institution_id, email, phone, username, full_name, password_hash, status, must_change_password, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).bind(userId, instId(c), e.email, e.phone, staffNoText, e.full_name, pwHash, known ? 1 : 0, t, t),
        c.db.prepare(`UPDATE employees SET user_id = ?, updated_at = ? WHERE id = ?`).bind(userId, t, empId),
      ])
    } else {
      // Top up the identifiers the account is missing; a clash keeps what it has.
      try {
        await c.db.prepare(`UPDATE users SET email = COALESCE(email, NULLIF(?, '')), phone = COALESCE(phone, NULLIF(?, '')), username = COALESCE(username, ?), updated_at = ? WHERE id = ?`)
          .bind(e.email ?? '', e.phone ?? '', staffNoText, t, userId).run()
      } catch (err) { if (!isUniqueViolation(err)) throw err }
      const u = await c.db.prepare(`SELECT (password_hash IS NULL OR status = 'invited') AS invited FROM users WHERE id = ?`).bind(userId).first<{ invited: number }>()
      const invited = bool(u?.invited)
      existing = !invited
      if (invited || reset) {
        await c.db.prepare(`UPDATE users SET password_hash = ?, status = 'active', must_change_password = ?, updated_at = ? WHERE id = ?`).bind(pwHash, known ? 1 : 0, t, userId).run()
        existing = false
      }
    }
    const signIn = await signInAs(c, userId, 'email')
    if (signIn.trim() === '') throw badRequest(errNoContact)
    const out: Record<string, unknown> = { employee_code: e.employee_code, full_name: e.full_name, sign_in_as: signIn, password: '', existing }
    if (existing) {
      out.note = 'This person already has a working login, the one whoever created it handed over. The password cannot be read back; reset it only if it has been lost, because that stops the one they are using.'
      return ok(out)
    }
    out.password = password
    out.note = 'Shown once and not stored. Hand it over in person or send it to them, and they are asked to change it when they first sign in. If it is lost, reset it rather than looking this one up.'
    return ok(out)
  })

  r.post('/setup/employees/{id}/pin', 'hr.employees.write', async (c) => {
    const empId = uuidParam(c.params.id)
    const pin = temporaryPIN()
    const pinHash = await hash(c, pin)
    const e = await c.db.prepare(`SELECT e.user_id, TRIM(e.first_name || ' ' || COALESCE(e.last_name, '')) AS full_name, COALESCE(u.phone, e.phone) AS phone
        FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`).bind(empId).first<{ user_id: string | null; full_name: string; phone: string | null }>()
    if (!e) throw notFound('resource not found')
    if (!e.user_id) throw badRequest('this person has no account yet. Issue their login first, then a PIN')
    const digits = e.phone ? normalisePhone(e.phone) : ''
    if (digits.length !== 10) throw badRequest('this person has no ten-digit mobile number on their record, add one first, because the number is what they sign in with')
    const t = now()
    // users_pin_phone_unique: two members of staff on one number cannot both hold a PIN.
    const clash = await c.db.prepare(`SELECT 1 AS x FROM users WHERE institution_id = ? AND phone = ? AND pin_hash IS NOT NULL AND id <> ?`).bind(instId(c), digits, e.user_id).first()
    if (clash) throw badRequest('another member of staff already has a PIN on this phone number - give this person their own number first')
    await c.db.batch([
      c.db.prepare(`UPDATE users SET phone = COALESCE(phone, ?), updated_at = ? WHERE id = ?`).bind(digits, t, e.user_id),
      c.db.prepare(`UPDATE users SET pin_hash = ?, pin_set_at = ?, pin_set_by = ?, pin_failed = 0, pin_locked_until = NULL, updated_at = ?,
          status = CASE WHEN status = 'invited' THEN 'active' ELSE status END WHERE id = ?`).bind(pinHash, t, c.id.userId, t, e.user_id),
    ])
    return ok({ full_name: e.full_name, phone: digits, pin })
  })

  /* --- the staff record --- */

  r.put('/setup/employees/{id}/photo', 'hr.employees.write', async (c) => {
    const eid = uuidParam(c.params.id)
    const req = await readJSON<{ file_id?: string }>(c.req)
    const v = trim(req.file_id)
    if (v !== '' && !isUUID(v)) throw badRequest('file_id must be a uuid')
    const res = await c.db.prepare(`UPDATE employees SET photo_file_id = ?, updated_at = ? WHERE id = ?`).bind(nullStr(v), now(), eid).run()
    if (!res.meta.changes) throw notFound('resource not found')
    return ok({ saved: true })
  })

  r.post('/setup/employees/{id}/documents', 'hr.employees.write', async (c) => {
    const eid = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const kind = str(req.doc_type).trim()
    if (kind === '') throw badRequest('say what the document is')
    if (kind.length > 80) throw badRequest('keep the document name under 80 characters')
    const fileId = str(req.file_id).trim()
    if (!isUUID(fileId)) throw badRequest('choose a file first')
    const id = uuid()
    const res = await c.db.prepare(`INSERT INTO employee_documents (id, institution_id, employee_id, file_id, doc_type, expires_on, created_at)
        SELECT ?, ?, e.id, ?, ?, NULLIF(?, ''), ? FROM employees e WHERE e.id = ?`).bind(id, instId(c), fileId, kind, str(req.expires_on), now(), eid).run()
    if (!res.meta.changes) throw notFound('resource not found')
    return created({ id })
  })

  r.del('/setup/employees/{id}/documents/{docID}', 'hr.employees.write', async (c) => {
    const eid = uuidParam(c.params.id)
    const did = uuidParam(c.params.docID, 'docID')
    const res = await c.db.prepare(`DELETE FROM employee_documents WHERE id = ? AND employee_id = ?`).bind(did, eid).run()
    if (!res.meta.changes) throw new HttpError(409, 'that document is not on this member of staff', { code: 'not_theirs' })
    return ok({ deleted: true })
  })

  r.post('/setup/employees/{id}/custom-fields', 'hr.employees.write', async (c) => {
    const eid = uuidParam(c.params.id)
    const req = await readJSON<{ custom_fields?: Record<string, string> }>(c.req)
    const fields = req.custom_fields && typeof req.custom_fields === 'object' ? req.custom_fields : {}
    const entries = Object.entries(fields)
    if (entries.length === 0) throw badRequest('nothing to save')
    if (entries.length > 40) throw badRequest('that is more fields than one save should carry')
    const set: Record<string, string> = {}
    const drop: string[] = []
    for (const [rawK, rawV] of entries) {
      const k = rawK.trim(), v = String(rawV ?? '')
      if (k === '') throw badRequest('a field needs a name')
      if (k.length > 80 || v.length > 500) throw badRequest("keep a field's name under 80 characters and its value under 500")
      if (v.trim() === '') drop.push(k)
      else set[k] = v
    }
    const row = await c.db.prepare(`SELECT custom_fields FROM employees WHERE id = ?`).bind(eid).first<{ custom_fields: string }>()
    if (!row) throw notFound('resource not found')
    let current: Record<string, unknown> = {}
    try { current = JSON.parse(row.custom_fields || '{}') } catch { current = {} }
    const merged = { ...current, ...set }
    for (const k of drop) delete merged[k]
    await c.db.prepare(`UPDATE employees SET custom_fields = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(merged), now(), eid).run()
    return ok({ saved: Object.keys(set).length, removed: drop.length })
  })

  r.post('/setup/employees/{id}/subjects', 'hr.employees.write', async (c) => {
    const eid = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const sec = str(req.section_id).trim(), cs = str(req.class_subject_id).trim()
    if (!isUUID(sec)) throw badRequest('choose a section')
    if (!isUUID(cs)) throw badRequest('choose a subject')
    const e = await c.db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(eid).first<{ user_id: string | null }>()
    if (!e) throw notFound('resource not found')
    if (!e.user_id) {
      throw badRequest('give this member of staff a login first, the timetable and the register identify a teacher by their account, not by their employee record')
    }
    const prev = await c.db.prepare(`SELECT u.full_name FROM section_subject_teachers sst JOIN users u ON u.id = sst.teacher_user_id
        WHERE sst.section_id = ? AND sst.class_subject_id = ? AND sst.teacher_user_id <> ?`).bind(sec, cs, e.user_id).first<{ full_name: string }>()
    await assignSectionTeacher(c, sec, cs, e.user_id)
    return ok({ assigned: true, taken_from: prev?.full_name ?? '' })
  })

  r.del('/setup/employees/{id}/subjects/{allocID}', 'hr.employees.write', async (c) => {
    const eid = uuidParam(c.params.id)
    const aid = uuidParam(c.params.allocID, 'allocID')
    const res = await c.db.prepare(`DELETE FROM section_subject_teachers WHERE id = ? AND teacher_user_id = (SELECT user_id FROM employees WHERE id = ?)`).bind(aid, eid).run()
    if (!res.meta.changes) throw new HttpError(409, 'that class is not allocated to this member of staff', { code: 'not_theirs' })
    return ok({ removed: true })
  })

  r.post('/setup/logins/import', 'hr.employees.write', async (c) => {
    const req = await readJSON<{ rows?: Array<{ sign_in_as?: string; password?: string }> }>(c.req)
    const rows = Array.isArray(req.rows) ? req.rows : []
    if (rows.length === 0) throw badRequest('the file had no rows in it')
    if (rows.length > 2000) throw badRequest('that is more rows than a school has staff, check the file')
    let set = 0
    const skipped: Array<{ sign_in_as: string; why: string }> = []
    for (const row of rows) {
      const who = trim(row.sign_in_as), pw = trim(row.password)
      if (who === '') continue
      if (pw.length < 10) { skipped.push({ sign_in_as: who, why: 'the password in the file is shorter than ten characters' }); continue }
      const matches = await c.db.prepare(`SELECT u.id FROM users u JOIN employees e ON e.user_id = u.id AND e.status = 'active'
          WHERE u.institution_id = ? AND (u.username = ? OR u.email = ?) LIMIT 2`).bind(instId(c), who, who).all<{ id: string }>()
      if (matches.results.length === 0) { skipped.push({ sign_in_as: who, why: 'nobody on the staff signs in with that' }); continue }
      if (matches.results.length > 1) { skipped.push({ sign_in_as: who, why: 'more than one member of staff matches that' }); continue }
      const target = matches.results[0].id
      await c.db.prepare(`UPDATE users SET password_hash = ?, status = 'active', updated_at = ? WHERE id = ?`).bind(await hash(c, pw), now(), target).run()
      await revokeSessions(c, target)
      set++
    }
    return ok({ set, skipped, note: 'Those passwords are now the ones that work. Anybody whose password changed has been signed out of their other devices.' })
  })

  /* --- biometric devices --- */

  r.get('/setup/biometric-devices', 'hr.employees.read', async (c) => {
    const today = todayIndia()
    const rows = await c.db.prepare(`SELECT d.id, d.serial, d.name, d.is_active, d.last_seen_at, d.last_push_at, d.note,
        (SELECT COUNT(*) FROM biometric_punches p WHERE p.device_id = d.id AND p.punched_at >= ? AND p.punched_at < ?) AS punches_today,
        (SELECT COUNT(DISTINCT p.device_user_id) FROM biometric_punches p WHERE p.device_id = d.id AND p.employee_id IS NULL) AS unresolved
        FROM biometric_devices d ORDER BY d.name`)
      .bind(new Date(Date.parse(today + 'T00:00:00Z') - 330 * 60_000).toISOString(), new Date(Date.parse(today + 'T00:00:00Z') + (24 * 60 - 330) * 60_000).toISOString())
      .all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const o: Record<string, unknown> = { id: v.id, serial: v.serial, name: v.name, is_active: bool(v.is_active) }
      if (v.last_seen_at !== null) o.last_seen_at = v.last_seen_at
      if (v.last_push_at !== null) o.last_push_at = v.last_push_at
      if (v.note !== null) o.note = v.note
      o.punches_today = Number(v.punches_today)
      o.unresolved = Number(v.unresolved)
      return o
    })
    return ok({ items })
  })

  r.post('/setup/biometric-devices', 'hr.employees.write', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const serial = str(req.serial).trim(), name = str(req.name).trim()
    if (serial === '' || name === '') throw badRequest('a serial and a name, the serial is printed on the back of the reader and is what identifies it to us')
    const isActive = has(req, 'is_active') && req.is_active !== null ? (req.is_active === true ? 1 : 0) : null
    const existing = await c.db.prepare(`SELECT id, institution_id FROM biometric_devices WHERE serial = ?`).bind(serial).first<{ id: string; institution_id: string }>()
    let id: string
    if (existing) {
      if (existing.institution_id !== instId(c)) throw badRequest('that serial is already registered to another school. Check it against the label on the reader')
      id = existing.id
      await c.db.prepare(`UPDATE biometric_devices SET name = ?, is_active = COALESCE(?, is_active), note = COALESCE(NULLIF(?, ''), note) WHERE id = ?`).bind(name, isActive, str(req.note), id).run()
    } else {
      id = uuid()
      await c.db.prepare(`INSERT INTO biometric_devices (id, institution_id, serial, name, is_active, note, created_at) VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), ?)`)
        .bind(id, instId(c), serial, name, isActive ?? 0, str(req.note), now()).run()
    }
    return ok({ id, note: "Set the reader's server address to this host, port 80 or 443, and leave the path blank, it appends /iclock itself. Activate the device here once it appears as seen." })
  })

  r.get('/setup/biometric-devices/unclaimed', 'hr.employees.read', async (c) => {
    const rows = await c.db.prepare(`SELECT p.device_user_id, COUNT(*) AS punches, MIN(p.punched_at) AS first_seen, MAX(p.punched_at) AS last_seen
        FROM biometric_punches p WHERE p.employee_id IS NULL GROUP BY 1 ORDER BY 2 DESC, 1`).all<{ device_user_id: string; punches: number; first_seen: string; last_seen: string }>()
    const stamp = (iso: string) => `${istDate(iso)} ${istClock(iso)}`
    const items = rows.results.map((v) => ({
      device_user_id: /^\d+$/.test(v.device_user_id) ? Number(v.device_user_id) : v.device_user_id,
      punches: Number(v.punches), first_seen: stamp(v.first_seen), last_seen: stamp(v.last_seen),
    }))
    return ok({ items })
  })

  /* --- the family's way in --- */

  r.post('/setup/students/{id}/login', 'students.write', async (c) => {
    requireInstitution(c)
    const studentId = uuidParam(c.params.id)
    const reset = c.url.searchParams.get('reset') === 'true'
    const password = temporaryPassword()
    const pwHash = await hash(c, password)
    const s = await c.db.prepare(`SELECT user_id, admission_no, TRIM(first_name || ' ' || COALESCE(last_name, '')) AS full_name FROM students WHERE id = ?`).bind(studentId)
      .first<{ user_id: string | null; admission_no: string; full_name: string }>()
    if (!s) throw new HttpError(404, 'no such student', { code: 'not_found' })
    const out: Record<string, unknown> = { sign_in_as: '', full_name: s.full_name, password: '', existing: false, note: '' }
    if (s.user_id) {
      out.existing = true
      if (reset) {
        await c.db.prepare(`UPDATE users SET password_hash = ?, status = 'active', updated_at = ? WHERE id = ?`).bind(pwHash, now(), s.user_id).run()
      }
      out.sign_in_as = await signInAs(c, s.user_id, 'username')
    } else {
      const username = await uniqueUsername(c, s.admission_no)
      const newId = uuid()
      const t = now()
      const taken = await c.db.prepare(`SELECT 1 AS x FROM users WHERE institution_id = ? AND username = ?`).bind(instId(c), username).first()
      if (taken) throw badRequest('that username already belongs to another account')
      await c.db.batch([
        c.db.prepare(`INSERT INTO users (id, institution_id, username, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
          .bind(newId, instId(c), username, s.full_name, pwHash, t, t),
        c.db.prepare(`UPDATE students SET user_id = ?, updated_at = ? WHERE id = ?`).bind(newId, t, studentId),
      ])
      try { await grantRole(c, newId, 'student') } catch (e) { throw badRequest((e as Error).message) }
      out.sign_in_as = username
    }
    if (out.existing && !reset) {
      out.note = 'This child already has a login. The one whoever created it handed over. The password cannot be read back; if it has been lost, reset it, which replaces the old one.'
      return ok(out)
    }
    out.password = password
    out.note = 'Shown once and not stored. Hand it to the child or their parent; if it is lost, reset it rather than looking this one up.'
    return ok(out)
  })

  r.post('/setup/guardians/{id}/login', 'students.write', async (c) => {
    requireInstitution(c)
    const guardianId = uuidParam(c.params.id)
    const reset = c.url.searchParams.get('reset') === 'true'
    const g = await c.db.prepare(`SELECT user_id, full_name, relation, email, phone FROM guardians WHERE id = ?`).bind(guardianId)
      .first<{ user_id: string | null; full_name: string; relation: string; email: string | null; phone: string | null }>()
    if (!g) throw new HttpError(404, 'no such guardian', { code: 'not_found' })
    const out: Record<string, unknown> = { sign_in_as: '', full_name: g.full_name, password: '', existing: false, note: '' }
    if (g.relation) out.relation = g.relation
    const { password, known } = issuedPassword(g.phone ?? '', g.email ?? '')
    const pwHash = await hash(c, password)
    const t = now()
    let issued = false
    const email = nullStr(g.email), phone = nullStr(g.phone)
    if (g.user_id) {
      out.existing = true
      if (reset) {
        await c.db.prepare(`UPDATE users SET password_hash = ?, status = 'active', must_change_password = ?, updated_at = ? WHERE id = ?`).bind(pwHash, known ? 1 : 0, t, g.user_id).run()
        issued = true
      }
      out.sign_in_as = await signInAs(c, g.user_id, 'username')
    } else {
      if (!email && !phone) {
        throw badRequest('this person has no email or phone on their record. Add one first, or they will have nothing to sign in with and nowhere to receive a reset')
      }
      // The number already signs a parent in: attach this guardian to that account.
      const attach = await c.db.prepare(`SELECT u.id FROM users u WHERE u.institution_id = ? AND ((? IS NOT NULL AND u.email = ?) OR (? IS NOT NULL AND u.phone = ?))
          AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key = 'parent') ORDER BY u.created_at LIMIT 1`)
        .bind(instId(c), email, email, phone, phone).first<{ id: string }>()
      if (attach) {
        await c.db.prepare(`UPDATE guardians SET user_id = ? WHERE id = ?`).bind(attach.id, guardianId).run()
        out.existing = true
        if (reset) {
          await c.db.prepare(`UPDATE users SET password_hash = ?, status = 'active', must_change_password = ?, updated_at = ? WHERE id = ?`).bind(pwHash, known ? 1 : 0, t, attach.id).run()
          issued = true
        }
        out.sign_in_as = await signInAs(c, attach.id, 'username')
      } else {
        const clash = await c.db.prepare(`SELECT 1 AS x FROM users WHERE institution_id = ? AND ((? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND phone = ?))`)
          .bind(instId(c), email, email, phone, phone).first()
        if (clash) throw badRequest('that email or phone is already the sign-in of a staff account here; give this parent a different number or address')
        const username = await uniqueUsername(c, phone ?? g.full_name)
        const newId = uuid()
        await c.db.batch([
          c.db.prepare(`INSERT INTO users (id, institution_id, username, email, phone, full_name, password_hash, status, must_change_password, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).bind(newId, instId(c), username, email, phone, g.full_name, pwHash, known ? 1 : 0, t, t),
          c.db.prepare(`UPDATE guardians SET user_id = ? WHERE id = ?`).bind(newId, guardianId),
        ])
        try { await grantRole(c, newId, 'parent') } catch (e) { throw badRequest((e as Error).message) }
        out.sign_in_as = username
        issued = true
      }
    }
    if (issued) {
      const sent = await queueFamilyLogin(c, { sourceId: guardianId, hash: pwHash, fullName: g.full_name, phone: g.phone ?? '', email: g.email ?? '',
        signInAs: String(out.sign_in_as ?? ''), password })
      if (sent.length) out.sent_to = sent
    }
    if (out.existing && !reset) {
      out.note = 'This guardian already has a login. It reaches every child they are guardian of. The password cannot be read back; reset it only if it has been lost, because that stops the one they are holding.'
      return ok(out)
    }
    out.password = password
    out.note = 'Shown once and not stored. One login reaches every child this person is a guardian of, so a parent with three children needs one, not three.'
    return ok(out)
  })

  r.post('/setup/logins/bulk', 'auth', async (c) => {
    requireInstitution(c)
    const req = await readJSON<{ kind?: string; section_id?: string; reset?: boolean }>(c.req)
    const kind = str(req.kind)
    const need = kind === 'staff' ? 'hr.employees.write' : 'students.write'
    if (!can(c.id, need)) throw forbidden('missing permission: issuing logins for ' + kind)
    let section: string | null = null
    if (trim(req.section_id) !== '') {
      if (!isUUID(trim(req.section_id))) throw badRequest('section_id must be a uuid')
      section = trim(req.section_id)
    }
    const inst = instId(c)
    const usable = `COALESCE((SELECT u.password_hash IS NOT NULL AND u.status <> 'invited' FROM users u WHERE u.id = %COL%), 0) AS usable`
    let sql: string
    switch (kind) {
      case 'students':
        sql = `SELECT st.id, TRIM(st.first_name || ' ' || COALESCE(st.last_name, '')) AS name, st.user_id, st.admission_no AS username, '' AS email, '' AS phone,
            ${usable.replace('%COL%', 'st.user_id')} FROM students st LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
            WHERE st.status = 'active' AND (? IS NULL OR e.section_id = ?) ORDER BY e.roll_no IS NULL, e.roll_no, st.admission_no`
        break
      case 'guardians':
        sql = `SELECT g.id, g.full_name AS name, g.user_id, COALESCE(g.phone, '') AS username, COALESCE(g.email, '') AS email, COALESCE(g.phone, '') AS phone,
            ${usable.replace('%COL%', 'g.user_id')} FROM guardians g WHERE EXISTS (SELECT 1 FROM student_guardians sg JOIN students st ON st.id = sg.student_id AND st.status = 'active'
            LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active' WHERE sg.guardian_id = g.id AND (? IS NULL OR e.section_id = ?)) ORDER BY g.id`
        break
      case 'staff':
        sql = `SELECT emp.id, TRIM(emp.first_name || ' ' || COALESCE(emp.last_name, '')) AS name, emp.user_id, COALESCE(emp.email, '') AS username, COALESCE(emp.email, '') AS email,
            COALESCE(emp.phone, '') AS phone, ${usable.replace('%COL%', 'emp.user_id')} FROM employees emp WHERE emp.status = 'active' AND ? IS NULL AND ? IS NULL ORDER BY emp.employee_code`
        break
      default:
        throw badRequest('kind must be students, guardians or staff')
    }
    const people = await c.db.prepare(sql).bind(section, section).all<{ id: string; name: string; user_id: string | null; username: string; email: string; phone: string; usable: number }>()
    const out = { created: 0, existing: 0, skipped: 0, rows: [] as Record<string, unknown>[], note: '', sent: 0 }
    const t = now()
    const ms = new Messenger(scopeOf(c))
    const tell = async (guardian: boolean, p: { id: string; name: string; phone: string; email: string }, signIn: string, password: string, h: string) => {
      if (guardian && (await queueFamilyLogin(c, { sourceId: p.id, hash: h, fullName: p.name, phone: p.phone, email: p.email, signInAs: signIn, password }, ms)).length > 0) out.sent++
    }
    for (const p of people.results) {
      if (p.user_id && (!bool(p.usable) || req.reset === true)) {
        const { password, known } = issuedPassword(p.phone, p.email)
        const h = await hash(c, password)
        await c.db.prepare(`UPDATE users SET password_hash = ?, status = 'active', must_change_password = ?, updated_at = ? WHERE id = ?`).bind(h, known ? 1 : 0, t, p.user_id).run()
        out.created++
        const signIn = await signInAs(c, p.user_id, 'username')
        out.rows.push({ name: p.name, sign_in_as: signIn, password, existing: false })
        await tell(kind === 'guardians', p, signIn, password, h)
        continue
      }
      if (p.user_id) {
        out.existing++
        out.rows.push({ name: p.name, sign_in_as: await signInAs(c, p.user_id, 'username'), existing: true })
        continue
      }
      if (kind !== 'students' && p.email === '' && p.phone === '') {
        out.skipped++
        out.rows.push({ name: p.name, existing: false, detail: 'no email or phone on the record' })
        continue
      }
      const username = await uniqueUsername(c, p.username === '' ? p.name : p.username)
      const { password, known } = issuedPassword(p.phone, p.email)
      const pwHash = await hash(c, password)
      /* users has no unique index on email or phone in the D1 schema, so the
         collisions Go caught as 23505 are found by asking first, and the
         same fallbacks apply: a shared email is dropped, a shared staff
         phone is dropped, a shared parent phone attaches the household. */
      const holder = async (col: 'email' | 'phone', v: string) => v === '' ? null
        : c.db.prepare(`SELECT id FROM users WHERE institution_id = ? AND ${col} = ?`).bind(inst, v).first<{ id: string }>()
      let email = p.email, phone = p.phone
      if (await holder('email', email)) email = ''
      if (await holder('phone', phone)) {
        if (kind === 'staff') phone = ''
        else if (kind === 'guardians') {
          const attach = await c.db.prepare(`SELECT u.id, u.full_name FROM users u WHERE u.institution_id = ? AND u.phone = ?
              AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key = 'parent') ORDER BY u.created_at LIMIT 1`)
            .bind(inst, phone).first<{ id: string; full_name: string }>()
          if (attach) {
            await c.db.prepare(`UPDATE guardians SET user_id = ? WHERE id = ?`).bind(attach.id, p.id).run()
            out.existing++
            out.rows.push({ name: p.name, sign_in_as: await signInAs(c, attach.id, 'username'), existing: true, detail: 'shares the login of ' + attach.full_name + ', who has the same number' })
            continue
          }
          phone = ''
        } else phone = ''
      }
      const newId = uuid()
      try {
        await c.db.prepare(`INSERT INTO users (id, institution_id, username, email, phone, full_name, password_hash, status, must_change_password, created_at, updated_at)
            VALUES (?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, 'active', ?, ?, ?)`).bind(newId, inst, username, email, phone, p.name, pwHash, known ? 1 : 0, t, t).run()
      } catch (e) {
        if (!isUniqueViolation(e)) throw e
        out.skipped++
        let detail = 'that phone number already belongs to another account'
        if (p.phone === '') detail = 'no phone number on record, and the email is already in use'
        if (kind === 'staff') detail = 'another account already signs in with that username; give this person a different staff code'
        out.rows.push({ name: p.name, existing: false, detail })
        continue
      }
      const table = kind === 'students' ? 'students' : kind === 'guardians' ? 'guardians' : 'employees'
      await c.db.prepare(`UPDATE ${table} SET user_id = ? WHERE id = ?`).bind(newId, p.id).run()
      const roleKey = kind === 'students' ? 'student' : kind === 'guardians' ? 'parent' : ''
      if (roleKey) await grantRole(c, newId, roleKey)
      out.created++
      out.rows.push({ name: p.name, sign_in_as: username, password, existing: false })
      await tell(kind === 'guardians', p, username, password, pwHash)
    }
    await ms.kick()
    out.note = 'Passwords are shown once and are not stored. Download this list before leaving the page.'
    if (out.sent > 0) out.note = `${out.sent} of these were also sent to the family by message. ` + out.note
    out.note += req.reset === true
      ? ' Every password here is new: the ones handed out before this have stopped working.'
      : ' Anybody who already had a login kept it, their password is not shown and has not been changed.'
    return ok(out)
  })
}
