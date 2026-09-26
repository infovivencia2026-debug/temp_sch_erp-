import type { Router } from '../../router'
import { HttpError, badRequest, bool, created, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { addDays, fullName, initcap, isUUIDish, isUniqueViolation, istMinuteT, nextNumber, nowIST, nz, parseJSON, str, todayIST } from '../admissions/util'
import { employeeFilter, grievanceFilter, growthReach, type Reach } from './reach'
import { issueStaffCertificate } from './staff'
import { lopRegister } from './lop'
import { school } from '../school'

/* Port of hr_lifecycle.go (mountHRLifecycle): joining, serving, leaving. */

const READ = 'hr.employees.read', WRITE = 'hr.employees.write'
const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}
const nullDate = (v: unknown) => nz(v)
const nullID = (v: unknown) => { const s = nz(v); if (s !== null && !isUUIDish(s.trim())) throw badRequest('ids must be uuids'); return s?.trim() ?? null }
const numOrNull = (v: unknown) => (typeof v === 'number' ? v : null)
const asNum = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const bad = (e: unknown): never => { if (e instanceof HttpError) throw e; throw badRequest(e instanceof Error ? e.message : String(e)) }

async function exitInReach(db: D1Database, re: Reach, exitID: string): Promise<boolean> {
  if (re.all) return true
  const f = employeeFilter(re, 'e')
  const row = await db.prepare(`SELECT 1 FROM staff_exits x JOIN employees e ON e.id = x.employee_id WHERE x.id = ? AND ${f.sql}`).bind(exitID, ...f.args).first()
  return !!row
}

export function registerLifecycle(r: Router) {
  // --- onboarding -------------------------------------------------------------------
  r.get('/hr/onboarding', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const rows = await c.db.prepare(`
      SELECT o.id, e.id AS employee_id, e.employee_code, ${fullName('e.first_name', 'e.last_name')} AS full_name, d.name AS designation, e.joined_on,
             COALESCE(o.status, 'invited') AS status, o.offer_on, o.expected_on, o.form_submitted_on, o.aadhaar_verified_on, o.aadhaar_ref, o.pan_verified_on, o.pan_ref,
             o.bank_verified_on, o.originals_seen_on, o.contract_signed_on, o.joining_report_on, o.notes
        FROM employees e LEFT JOIN staff_onboarding o ON o.employee_id = e.id LEFT JOIN designations d ON d.id = e.designation_id
       WHERE (? IS NOT 1 OR o.id IS NULL OR o.status <> 'completed') AND ${mine.sql}
       ORDER BY e.joined_on DESC, e.employee_code LIMIT 500`).bind(c.url.searchParams.get('pending') === 'true' ? 1 : 0, ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => {
      const pending: string[] = []
      if (v.aadhaar_verified_on === null) pending.push('Aadhaar')
      if (v.pan_verified_on === null) pending.push('PAN')
      if (v.bank_verified_on === null) pending.push('bank')
      if (v.originals_seen_on === null) pending.push('originals')
      if (v.contract_signed_on === null) pending.push('contract')
      return omitNull({ ...v, pending })
    }) })
  })

  r.post('/hr/onboarding', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const emp = str(req.employee_id)
    if (!isUUIDish(emp)) throw badRequest('employee_id must be a uuid')
    let status = str(req.status)
    if (status === '') status = 'submitted'
    if (status === 'verified' || status === 'completed') {
      if (str(req.aadhaar_verified_on) === '' || str(req.pan_verified_on) === '') throw badRequest('Aadhaar and PAN have to be verified, with the date each was checked, before onboarding is marked verified')
      if (status === 'completed' && str(req.contract_signed_on) === '') throw badRequest('onboarding is not complete until the contract is signed; record the date')
    }
    const inst = school(c).id, t = now()
    const existing = await c.db.prepare(`SELECT id FROM staff_onboarding WHERE employee_id = ?`).bind(emp).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const vals = [status, nullDate(req.offer_on), nullDate(req.expected_on), nullDate(req.form_submitted_on), nullDate(req.aadhaar_verified_on), nz(req.aadhaar_ref),
      nullDate(req.pan_verified_on), nz(req.pan_ref), nullDate(req.bank_verified_on), nullDate(req.originals_seen_on), nullDate(req.contract_signed_on), nullDate(req.joining_report_on), nz(req.notes), c.id.userId]
    const stmts = [existing
      ? c.db.prepare(`UPDATE staff_onboarding SET status = ?, offer_on = ?, expected_on = ?, form_submitted_on = ?, aadhaar_verified_on = ?, aadhaar_ref = ?, pan_verified_on = ?, pan_ref = ?,
          bank_verified_on = ?, originals_seen_on = ?, contract_signed_on = ?, joining_report_on = ?, notes = ?, verified_by = ?, updated_at = ? WHERE id = ?`).bind(...vals, t, id)
      : c.db.prepare(`INSERT INTO staff_onboarding (id, institution_id, employee_id, status, offer_on, expected_on, form_submitted_on, aadhaar_verified_on, aadhaar_ref, pan_verified_on, pan_ref,
          bank_verified_on, originals_seen_on, contract_signed_on, joining_report_on, notes, verified_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, inst, emp, ...vals, t, t)]
    if (status === 'completed') {
      // The appointment page of the service book, written once.
      const e = await c.db.prepare(`SELECT e.joined_on, d.name AS designation, e.designation_id, e.department_id FROM employees e LEFT JOIN designations d ON d.id = e.designation_id WHERE e.id = ?
          AND NOT EXISTS (SELECT 1 FROM service_book_entries sb WHERE sb.employee_id = e.id AND sb.entry_kind = 'appointment')`).bind(emp)
        .first<{ joined_on: string; designation: string | null; designation_id: string | null; department_id: string | null }>()
      if (e) {
        stmts.push(c.db.prepare(`INSERT INTO service_book_entries (id, institution_id, employee_id, entry_kind, event_date, title, particulars, designation_id, department_id, attested_by, attested_on, source, created_by, created_at)
          VALUES (?,?,?,'appointment',?,?,'Onboarding completed and KYC verified',?,?,?,?,'onboarding',?,?)`)
          .bind(uuid(), inst, emp, e.joined_on, 'Appointed as ' + (e.designation ?? 'staff'), e.designation_id, e.department_id, c.id.userId, todayIST(), c.id.userId, t))
      }
    }
    try { await c.db.batch(stmts) } catch (e) { bad(e) }
    return ok({ id, status })
  })

  // --- exit, clearance and the letters that follow --------------------------------
  const exitProgress = `(SELECT count(*) FROM exit_clearances cl WHERE cl.exit_id = x.id) AS departments,
       (SELECT count(*) FROM exit_clearances cl WHERE cl.exit_id = x.id AND cl.status <> 'cleared') AS outstanding,
       COALESCE((SELECT sum(cl.dues_paise) FROM exit_clearances cl WHERE cl.exit_id = x.id), 0) AS dues_paise`

  r.get('/hr/exits', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const rows = await c.db.prepare(`
      SELECT x.id, e.id AS employee_id, e.employee_code, ${fullName('e.first_name', 'e.last_name')} AS full_name, d.name AS designation, e.joined_on,
             x.kind, x.notice_on, x.requested_last_day, x.last_working_day, x.reason, x.status, x.interview_on, x.primary_reason, x.would_rejoin, x.feedback,
             x.settlement_status, x.settlement_paise, x.relieved_on, x.settled_on, ${exitProgress}
        FROM staff_exits x JOIN employees e ON e.id = x.employee_id LEFT JOIN designations d ON d.id = e.designation_id
       WHERE (? IS NOT 1 OR x.status NOT IN ('settled','withdrawn')) AND ${mine.sql}
       ORDER BY x.notice_on DESC LIMIT 300`).bind(c.url.searchParams.get('open') === 'true' ? 1 : 0, ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, would_rejoin: v.would_rejoin === null ? null : bool(v.would_rejoin),
      can_be_settled: Number(v.departments) > 0 && Number(v.outstanding) === 0 })) })
  })

  r.post('/hr/exits', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const emp = str(req.employee_id)
    if (!isUUIDish(emp)) throw badRequest('employee_id must be a uuid')
    let kind = str(req.kind)
    if (kind === '') kind = 'resignation'
    const inst = school(c).id
    const open = await c.db.prepare(`SELECT 1 FROM staff_exits WHERE employee_id = ? AND status NOT IN ('settled','withdrawn')`).bind(emp).first()
    if (open) throw new HttpError(409, 'this employee already has an exit in progress; withdraw it before opening another', { code: 'exit_already_open' })
    const id = uuid(), t = now()
    const depts = await c.db.prepare(`SELECT id FROM clearance_departments WHERE institution_id = ? AND is_active = 1`).bind(inst).all<{ id: string }>()
    const stmts = [c.db.prepare(`INSERT INTO staff_exits (id, institution_id, employee_id, kind, notice_on, requested_last_day, last_working_day, reason, created_by, created_at, updated_at) VALUES (?,?,?,?,COALESCE(?, ?),?,?,?,?,?,?)`)
      .bind(id, inst, emp, kind, nullDate(req.notice_on), todayIST(), nullDate(req.requested_last_day), nullDate(req.last_working_day), nz(req.reason), c.id.userId, t, t)]
    for (const d of depts.results) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO exit_clearances (id, institution_id, exit_id, department_id, updated_at) VALUES (?,?,?,?,?)`).bind(uuid(), inst, id, d.id, t))
    try { await c.db.batch(stmts) } catch (e) { bad(e) }
    return created({ id })
  })

  r.post('/hr/exits/{id}/interview', WRITE, async (c) => {
    const exitID = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const primary = str(req.primary_reason)
    if (primary.trim() === '') throw badRequest('an exit interview needs the main reason for leaving')
    const rejoin = typeof req.would_rejoin === 'boolean' ? (req.would_rejoin ? 1 : 0) : null
    const res = await c.db.prepare(`UPDATE staff_exits SET interview_on = COALESCE(?, ?), interviewed_by = ?, primary_reason = ?, would_rejoin = ?, rating_management = ?, rating_workload = ?, rating_facilities = ?,
        feedback = ?, last_working_day = COALESCE(?, last_working_day), status = CASE WHEN status = 'notice' THEN 'interviewed' ELSE status END, updated_at = ? WHERE id = ?`)
      .bind(nullDate(req.interview_on), todayIST(), c.id.userId, primary, rejoin, numOrNull(req.rating_management), numOrNull(req.rating_workload), numOrNull(req.rating_facilities),
        nz(req.feedback), nullDate(req.last_working_day), now(), exitID).run()
    if (res.meta.changes === 0) throw notFound()
    return ok({ saved: true })
  })

  r.get('/hr/exits/{id}/clearances', READ, async (c) => {
    const exitID = uuidParam(c.params.id)
    const re = await growthReach(c.db, c.id)
    if (!(await exitInReach(c.db, re, exitID))) throw notFound()
    const rows = await c.db.prepare(`SELECT c.id, cd.name AS department, cd.code, c.status, c.dues_paise, c.remarks, u.full_name AS cleared_by, c.cleared_on
        FROM exit_clearances c JOIN clearance_departments cd ON cd.id = c.department_id LEFT JOIN users u ON u.id = c.cleared_by WHERE c.exit_id = ? ORDER BY cd.sequence, cd.name`)
      .bind(exitID).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.post('/hr/exits/{id}/clearances', WRITE, async (c) => {
    const exitID = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const status = str(req.status)
    if (!['pending', 'dues', 'cleared'].includes(status)) throw badRequest('status must be pending, dues or cleared')
    const dues = typeof req.dues_paise === 'number' ? req.dues_paise : 0
    const res = await c.db.prepare(`UPDATE exit_clearances SET status = ?, dues_paise = ?, remarks = ?, cleared_by = CASE WHEN ? = 'cleared' THEN ? ELSE NULL END,
        cleared_on = CASE WHEN ? = 'cleared' THEN ? ELSE NULL END, updated_at = ?
      WHERE exit_id = ? AND department_id = (SELECT cd.id FROM clearance_departments cd WHERE cd.code = ? AND cd.institution_id = ?)`)
      .bind(status, dues, nz(req.remarks), status, c.id.userId, status, todayIST(), now(), exitID, str(req.department_code), school(c).id).run()
    if (res.meta.changes === 0) throw notFound()
    const outstanding = (await c.db.prepare(`SELECT count(*) AS n FROM exit_clearances WHERE exit_id = ? AND status <> 'cleared'`).bind(exitID).first<{ n: number }>())?.n ?? 0
    await c.db.prepare(`UPDATE staff_exits SET status = CASE WHEN ? = 0 AND status IN ('notice','interviewed') THEN 'cleared' WHEN ? > 0 AND status = 'cleared' THEN 'interviewed' ELSE status END, updated_at = ? WHERE id = ?`)
      .bind(outstanding, outstanding, now(), exitID).run()
    return ok({ outstanding })
  })

  r.get('/hr/clearance-departments', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT id, code, name, is_active FROM clearance_departments ORDER BY sequence, name`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({ ...v, is_active: bool(v.is_active) })) })
  })

  r.post('/hr/exits/{id}/relieve', WRITE, async (c) => {
    const exitID = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const x = await c.db.prepare(`SELECT x.employee_id, x.kind, (SELECT count(*) FROM exit_clearances cl WHERE cl.exit_id = x.id) AS raised,
        (SELECT count(*) FROM exit_clearances cl WHERE cl.exit_id = x.id AND cl.status <> 'cleared') AS outstanding FROM staff_exits x WHERE x.id = ?`).bind(exitID)
      .first<{ employee_id: string; kind: string; raised: number; outstanding: number }>()
    if (!x) throw notFound()
    if (x.raised === 0 || x.outstanding > 0) throw new HttpError(409, 'a department has not signed yet; the relieving letter cannot be issued until every one has', { code: 'clearance_outstanding' })
    const inst = school(c).id, t = now(), relievedOn = nullDate(req.relieved_on) ?? todayIST()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`UPDATE staff_exits SET relieved_on = ?, status = 'relieved', last_working_day = COALESCE(last_working_day, ?), updated_at = ? WHERE id = ?`).bind(relievedOn, relievedOn, t, exitID),
      c.db.prepare(`UPDATE employees SET status = CASE ? WHEN 'retirement' THEN 'retired' WHEN 'termination' THEN 'terminated' ELSE 'resigned' END, relieved_on = ?, updated_at = ? WHERE id = ?`)
        .bind(x.kind, relievedOn, t, x.employee_id),
    ]
    const issued: Record<string, string> = {}
    for (const code of ['RELIEVING', 'EXPERIENCE']) {
      const cert = await issueStaffCertificate(c.db, inst, c.id.userId, x.employee_id, code, nz(req.remarks))
      issued[code.toLowerCase()] = cert.serial
      stmts.push(...cert.stmts)
    }
    stmts.push(c.db.prepare(`INSERT INTO service_book_entries (id, institution_id, employee_id, entry_kind, event_date, title, particulars, attested_by, attested_on, source, created_by, created_at)
      VALUES (?,?,?,'relieving',?,'Relieved on completion of clearance',?,?,?,'exit',?,?)`)
      .bind(uuid(), inst, x.employee_id, relievedOn, 'All departmental clearances signed. ' + str(req.remarks), c.id.userId, todayIST(), c.id.userId, t))
    try { await c.db.batch(stmts) } catch (e) { bad(e) }
    return ok({ relieved: true, certificates: issued })
  })

  r.post('/hr/exits/{id}/settle', WRITE, async (c) => {
    const exitID = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const settlement = typeof req.settlement_paise === 'number' ? req.settlement_paise : 0
    if (settlement < 0) throw badRequest('a settlement cannot be negative')
    // staff_exits_clearance_gate (00031): a settlement is refused while a department is still owed.
    const x = await c.db.prepare(`SELECT settlement_status, (SELECT count(*) FROM exit_clearances cl WHERE cl.exit_id = x.id) AS raised,
        (SELECT count(*) FROM exit_clearances cl WHERE cl.exit_id = x.id AND cl.status <> 'cleared') AS outstanding,
        COALESCE((SELECT sum(dues_paise) FROM exit_clearances cl WHERE cl.exit_id = x.id), 0) AS recovery FROM staff_exits x WHERE x.id = ?`).bind(exitID)
      .first<{ settlement_status: string; raised: number; outstanding: number; recovery: number }>()
    if (!x) throw notFound()
    if (x.settlement_status !== 'paid') {
      if (x.raised === 0) throw new HttpError(409, 'settlement blocked: no departmental clearance was raised for this exit', { code: 'clearance_outstanding' })
      if (x.outstanding > 0) throw new HttpError(409, `settlement blocked: ${x.outstanding} departmental clearance(s) still outstanding`, { code: 'clearance_outstanding' })
    }
    const net = Math.max(0, settlement - x.recovery)
    const today = todayIST()
    await c.db.prepare(`UPDATE staff_exits SET settlement_paise = ?, recovery_paise = ?, settlement_status = 'paid', settled_on = ?, relieved_on = COALESCE(relieved_on, ?), status = 'settled', updated_at = ? WHERE id = ?`)
      .bind(settlement, x.recovery, today, today, now(), exitID).run()
    return ok({ settlement_paise: settlement, recovery_paise: x.recovery, net_paise: net })
  })

  r.get('/hr/service-certificates', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const emp = nullID(c.url.searchParams.get('employee_id'))
    const rows = await c.db.prepare(`
      SELECT ic.serial_no, ct.name AS type, ct.code, ${fullName('e.first_name', 'e.last_name')} AS full_name, ic.issued_on, ic.status, ic.snapshot, json_extract(ic.snapshot, '$.remarks') AS remarks
        FROM issued_certificates ic JOIN certificate_types ct ON ct.id = ic.certificate_type_id JOIN employees e ON e.id = ic.employee_id
       WHERE (? IS NULL OR ic.employee_id = ?) AND ${mine.sql} ORDER BY ic.issued_on DESC, ic.serial_no DESC LIMIT 300`).bind(emp, emp, ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, snapshot: parseJSON<unknown>(v.snapshot, {}) })) })
  })

  // --- transfer, deputation and seniority --------------------------------------------
  r.get('/hr/transfers', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const emp = nullID(c.url.searchParams.get('employee_id'))
    const rows = await c.db.prepare(`
      SELECT t.id, e.id AS employee_id, e.employee_code, ${fullName('e.first_name', 'e.last_name')} AS full_name, t.kind, fc.name AS from_campus, tc.name AS to_campus, t.to_institution,
             t.order_no, t.order_date, t.effective_from, t.effective_to, t.relieved_on, t.reported_on, t.reason, t.status,
             (t.kind = 'deputation' AND t.effective_to < ? AND t.status NOT IN ('returned','cancelled')) AS overdue
        FROM staff_transfers t JOIN employees e ON e.id = t.employee_id LEFT JOIN campuses fc ON fc.id = t.from_campus_id LEFT JOIN campuses tc ON tc.id = t.to_campus_id
       WHERE (? IS NULL OR t.employee_id = ?) AND ${mine.sql} ORDER BY t.effective_from DESC LIMIT 300`).bind(todayIST(), emp, emp, ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, overdue: bool(v.overdue) })) })
  })

  r.post('/hr/transfers', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const emp = str(req.employee_id)
    if (!isUUIDish(emp)) throw badRequest('employee_id must be a uuid')
    const from = str(req.effective_from)
    if (from === '') throw badRequest('a posting order needs the date it takes effect')
    let kind = str(req.kind)
    if (kind === '') kind = 'transfer'
    if (kind === 'deputation' && str(req.effective_to) === '') throw badRequest('a deputation needs an end date; without one it is a transfer')
    let status = str(req.status)
    if (status === '') status = 'ordered'
    const e = await c.db.prepare(`SELECT campus_id FROM employees WHERE id = ?`).bind(emp).first<{ campus_id: string }>()
    if (!e) throw notFound()
    const toCampus = nullID(req.to_campus_id)
    const campusName = toCampus ? (await c.db.prepare(`SELECT name FROM campuses WHERE id = ?`).bind(toCampus).first<{ name: string }>())?.name ?? null : null
    const inst = school(c).id, id = uuid(), t = now()
    const entryKind = kind === 'deputation' || kind === 'promotion' ? kind : 'transfer'
    const to = nz(req.to_institution) ?? campusName ?? 'unspecified'
    const particulars = 'To ' + to + (nz(req.effective_to) ? ' until ' + str(req.effective_to) : '')
    try {
      await c.db.batch([
        c.db.prepare(`INSERT INTO staff_transfers (id, institution_id, employee_id, kind, from_campus_id, to_campus_id, to_institution, order_no, order_date, effective_from, effective_to, relieved_on, reported_on, reason, status, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(id, inst, emp, kind, e.campus_id, toCampus, nz(req.to_institution), nz(req.order_no), nullDate(req.order_date), from, nullDate(req.effective_to), nullDate(req.relieved_on), nullDate(req.reported_on), nz(req.reason), status, c.id.userId, t),
        c.db.prepare(`INSERT INTO service_book_entries (id, institution_id, employee_id, entry_kind, event_date, title, particulars, order_no, order_date, source, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,'transfer',?,?)`)
          .bind(uuid(), inst, emp, entryKind, from, initcap(entryKind) + ' order', particulars, nz(req.order_no), nullDate(req.order_date), c.id.userId, t),
      ])
    } catch (err) { bad(err) }
    return created({ id })
  })

  r.get('/hr/seniority', READ, async (c) => {
    const today = todayIST()
    const dept = nullID(c.url.searchParams.get('department_id'))
    const rows = await c.db.prepare(`
      SELECT row_number() OVER (ORDER BY COALESCE(e.confirmed_on, e.joined_on), e.joined_on, e.employee_code) AS rank,
             e.id AS employee_id, e.employee_code, ${fullName('e.first_name', 'e.last_name')} AS full_name, d.name AS designation, dep.name AS department, e.joined_on, e.confirmed_on,
             round((julianday(?) - julianday(e.joined_on)) / 365.25, 1) AS years_of_service,
             COALESCE((SELECT sum(CAST(julianday(MIN(COALESCE(t.effective_to, ?), ?)) - julianday(t.effective_from) AS INTEGER)) FROM staff_transfers t
                        WHERE t.employee_id = e.id AND t.kind = 'deputation' AND t.status <> 'cancelled'), 0) AS deputed_days
        FROM employees e LEFT JOIN designations d ON d.id = e.designation_id LEFT JOIN departments dep ON dep.id = e.department_id
       WHERE e.status IN ('active','on_leave') AND (? IS NULL OR e.department_id = ?)
       ORDER BY COALESCE(e.confirmed_on, e.joined_on), e.joined_on, e.employee_code LIMIT 500`).bind(today, today, today, dept, dept).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  // --- the service book ----------------------------------------------------------------
  r.get('/hr/service-book', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const emp = nullID(c.url.searchParams.get('employee_id'))
    const rows = await c.db.prepare(`
      SELECT sb.id, e.id AS employee_id, ${fullName('e.first_name', 'e.last_name')} AS full_name, sb.entry_kind, sb.event_date, sb.title, sb.particulars, sb.order_no, sb.order_date,
             d.name AS designation, sb.pay_paise, u.full_name AS attested_by, sb.attested_on, sb.source
        FROM service_book_entries sb JOIN employees e ON e.id = sb.employee_id LEFT JOIN designations d ON d.id = sb.designation_id LEFT JOIN users u ON u.id = sb.attested_by
       WHERE (? IS NULL OR sb.employee_id = ?) AND ${mine.sql} ORDER BY sb.event_date, sb.created_at LIMIT 500`).bind(emp, emp, ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.post('/hr/service-book', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const emp = str(req.employee_id)
    if (!isUUIDish(emp)) throw badRequest('employee_id must be a uuid')
    if (str(req.title).trim() === '' || str(req.event_date) === '') throw badRequest('a service book entry needs a date and a title')
    let kind = str(req.entry_kind)
    if (kind === '') kind = 'other'
    const id = uuid(), attest = req.attest === true
    try {
      await c.db.prepare(`INSERT INTO service_book_entries (id, institution_id, employee_id, entry_kind, event_date, title, particulars, order_no, order_date, designation_id, department_id, pay_paise, attested_by, attested_on, source, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'manual',?,?)`)
        .bind(id, school(c).id, emp, kind, str(req.event_date), str(req.title), nz(req.particulars), nz(req.order_no), nullDate(req.order_date), nullID(req.designation_id), nullID(req.department_id),
          numOrNull(req.pay_paise), attest ? c.id.userId : null, attest ? todayIST() : null, c.id.userId, now()).run()
    } catch (e) { bad(e) }
    return created({ id })
  })

  r.post('/hr/service-book/{id}/attest', WRITE, async (c) => {
    const entry = uuidParam(c.params.id)
    // service_book_entries_immutable: an attested page cannot change, so only an unattested one is signed.
    const res = await c.db.prepare(`UPDATE service_book_entries SET attested_by = ?, attested_on = ? WHERE id = ? AND attested_on IS NULL`).bind(c.id.userId, todayIST(), entry).run()
    if (res.meta.changes === 0) throw new HttpError(409, 'that entry is either missing or already attested; an attested page cannot be signed twice', { code: 'already_attested' })
    return ok({ attested: true })
  })

  // --- qualifications, fitness and background checks -------------------------------
  r.get('/hr/qualifications', READ, async (c) => {
    const q = c.url.searchParams
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const emp = nullID(q.get('employee_id'))
    const rows = await c.db.prepare(`
      SELECT q.id, e.id AS employee_id, e.employee_code, ${fullName('e.first_name', 'e.last_name')} AS full_name, q.qualification, q.level, q.discipline, q.board_university,
             q.year_of_passing, q.percentage, q.registration_no, q.is_teaching_qualification, q.valid_until, q.verified_on, u.full_name AS verified_by,
             (q.valid_until IS NOT NULL AND q.valid_until < ?) AS lapsed
        FROM staff_qualifications q JOIN employees e ON e.id = q.employee_id LEFT JOIN users u ON u.id = q.verified_by
       WHERE (? IS NULL OR q.employee_id = ?) AND (? IS NOT 1 OR q.is_teaching_qualification = 1) AND ${mine.sql}
       ORDER BY e.employee_code, q.year_of_passing IS NULL, q.year_of_passing DESC LIMIT 500`)
      .bind(todayIST(), emp, emp, q.get('teaching') === 'true' ? 1 : 0, ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, percentage: asNum(v.percentage), is_teaching_qualification: bool(v.is_teaching_qualification), lapsed: bool(v.lapsed) })) })
  })

  r.post('/hr/qualifications', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const emp = str(req.employee_id)
    if (!isUUIDish(emp)) throw badRequest('employee_id must be a uuid')
    const qual = str(req.qualification)
    if (qual.trim() === '') throw badRequest('name the qualification')
    let level = str(req.level)
    if (level === '') level = 'graduate'
    const verified = req.verified === true
    const year = numOrNull(req.year_of_passing)
    const pct = typeof req.percentage === 'number' ? String(req.percentage) : null
    // ON CONFLICT (employee_id, lower(qualification), lower(discipline), year) DO UPDATE, by hand.
    const existing = await c.db.prepare(`SELECT id FROM staff_qualifications WHERE employee_id = ? AND lower(qualification) = lower(?) AND lower(COALESCE(discipline,'')) = lower(?) AND COALESCE(year_of_passing, 0) = ?`)
      .bind(emp, qual, str(req.discipline), year ?? 0).first<{ id: string }>()
    const t = now()
    try {
      if (existing) {
        await c.db.prepare(`UPDATE staff_qualifications SET level = ?, board_university = ?, percentage = ?, registration_no = ?, is_teaching_qualification = ?, valid_until = ?,
            verified_on = COALESCE(?, verified_on), verified_by = COALESCE(?, verified_by), verification_ref = COALESCE(?, verification_ref), updated_at = ? WHERE id = ?`)
          .bind(level, nz(req.board_university), pct, nz(req.registration_no), req.is_teaching_qualification ? 1 : 0, nullDate(req.valid_until),
            verified ? todayIST() : null, verified ? c.id.userId : null, nz(req.verification_ref), t, existing.id).run()
        return ok({ id: existing.id })
      }
      const id = uuid()
      await c.db.prepare(`INSERT INTO staff_qualifications (id, institution_id, employee_id, qualification, level, discipline, board_university, year_of_passing, percentage, registration_no,
          is_teaching_qualification, valid_until, verified_on, verified_by, verification_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, school(c).id, emp, qual, level, nz(req.discipline), nz(req.board_university), year, pct, nz(req.registration_no), req.is_teaching_qualification ? 1 : 0,
          nullDate(req.valid_until), verified ? todayIST() : null, verified ? c.id.userId : null, nz(req.verification_ref), t, t).run()
      return ok({ id })
    } catch (e) { return bad(e) }
  })

  r.get('/hr/medical-fitness', READ, async (c) => {
    const q = c.url.searchParams
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const emp = nullID(q.get('employee_id'))
    const within = q.get('within_days') !== null && /^-?\d+$/.test(q.get('within_days')!) ? Number(q.get('within_days')) : null
    const today = todayIST()
    const rows = await c.db.prepare(`
      SELECT m.id, e.id AS employee_id, e.employee_code, ${fullName('e.first_name', 'e.last_name')} AS full_name, m.purpose, m.issued_on, m.valid_until, m.fit, m.examined_by, m.clinic, m.restrictions,
             CAST(julianday(m.valid_until) - julianday(?) AS INTEGER) AS days_left, (m.valid_until < ?) AS expired
        FROM medical_fitness_certificates m JOIN employees e ON e.id = m.employee_id
       WHERE (? IS NULL OR m.employee_id = ?) AND (? IS NULL OR m.valid_until <= ?) AND ${mine.sql}
       ORDER BY m.valid_until, e.employee_code LIMIT 500`).bind(today, today, emp, emp, within, within === null ? null : addDays(today, within), ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, fit: bool(v.fit), expired: bool(v.expired) })) })
  })

  r.post('/hr/medical-fitness', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const emp = str(req.employee_id)
    if (!isUUIDish(emp)) throw badRequest('employee_id must be a uuid')
    const issued = str(req.issued_on), valid = str(req.valid_until)
    if (issued === '' || valid === '') throw badRequest('a fitness certificate needs the date it was issued and the date it runs out')
    let purpose = str(req.purpose)
    if (purpose === '') purpose = 'general'
    const fit = typeof req.fit === 'boolean' ? req.fit : true
    if (!fit && str(req.restrictions).trim() === '') throw badRequest('say what the person is not fit for; an unfit certificate with nothing written on it cannot be acted on')
    const existing = await c.db.prepare(`SELECT id FROM medical_fitness_certificates WHERE employee_id = ? AND purpose = ? AND issued_on = ?`).bind(emp, purpose, issued).first<{ id: string }>()
    try {
      if (existing) {
        await c.db.prepare(`UPDATE medical_fitness_certificates SET valid_until = ?, fit = ?, examined_by = ?, clinic = ?, restrictions = ? WHERE id = ?`)
          .bind(valid, fit ? 1 : 0, nz(req.examined_by), nz(req.clinic), nz(req.restrictions), existing.id).run()
        return created({ id: existing.id })
      }
      const id = uuid()
      await c.db.prepare(`INSERT INTO medical_fitness_certificates (id, institution_id, employee_id, purpose, issued_on, valid_until, fit, examined_by, clinic, restrictions, recorded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, school(c).id, emp, purpose, issued, valid, fit ? 1 : 0, nz(req.examined_by), nz(req.clinic), nz(req.restrictions), c.id.userId, now()).run()
      return created({ id })
    } catch (e) { return bad(e) }
  })

  r.get('/hr/background-checks', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const emp = nullID(c.url.searchParams.get('employee_id'))
    const today = todayIST()
    const rows = await c.db.prepare(`
      SELECT b.id, e.id AS employee_id, e.employee_code, ${fullName('e.first_name', 'e.last_name')} AS full_name, b.kind, b.agency, b.requested_on, b.reference_no, b.status, b.completed_on, b.valid_until, b.findings,
             CASE WHEN b.valid_until IS NULL THEN NULL ELSE CAST(julianday(b.valid_until) - julianday(?) AS INTEGER) END AS days_left,
             (b.status = 'clear' AND b.valid_until < ?) AS expired
        FROM background_verifications b JOIN employees e ON e.id = b.employee_id
       WHERE (? IS NULL OR b.employee_id = ?) AND ${mine.sql} ORDER BY b.valid_until IS NOT NULL, b.valid_until, b.requested_on DESC LIMIT 500`)
      .bind(today, today, emp, emp, ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, expired: bool(v.expired) })) })
  })

  r.post('/hr/background-checks', WRITE, async (c) => {
    const req = await readJSON(c.req)
    let status = str(req.status)
    if (status === 'clear' && str(req.valid_until) === '') throw badRequest('a clear verification needs the date it must be repeated by; without one nobody is ever told to renew it')
    try {
      if (str(req.id) !== '') {
        if (!isUUIDish(str(req.id))) throw badRequest('id must be a uuid')
        const res = await c.db.prepare(`UPDATE background_verifications SET agency = COALESCE(?, agency), reference_no = COALESCE(?, reference_no), status = COALESCE(?, status),
            completed_on = COALESCE(?, completed_on), valid_until = COALESCE(?, valid_until), findings = COALESCE(?, findings), updated_at = ? WHERE id = ?`)
          .bind(nz(req.agency), nz(req.reference_no), nz(status), nullDate(req.completed_on), nullDate(req.valid_until), nz(req.findings), now(), str(req.id)).run()
        if (res.meta.changes === 0) throw notFound()
        return ok({ id: str(req.id) })
      }
      const emp = str(req.employee_id)
      if (!isUUIDish(emp)) throw badRequest('employee_id must be a uuid')
      let kind = str(req.kind)
      if (kind === '') kind = 'police'
      if (status === '') status = 'requested'
      // One verification of a kind in flight per employee (the partial unique index).
      const inFlight = await c.db.prepare(`SELECT 1 FROM background_verifications WHERE employee_id = ? AND kind = ? AND status IN ('requested','in_progress')`).bind(emp, kind).first()
      if (inFlight && (status === 'requested' || status === 'in_progress')) throw new HttpError(409, 'a verification of that kind is already in flight for this employee', { code: 'already_requested' })
      const id = uuid(), t = now()
      await c.db.prepare(`INSERT INTO background_verifications (id, institution_id, employee_id, kind, agency, requested_on, reference_no, status, completed_on, valid_until, findings, recorded_by, created_at, updated_at)
        VALUES (?,?,?,?,?,COALESCE(?, ?),?,?,?,?,?,?,?,?)`)
        .bind(id, school(c).id, emp, kind, nz(req.agency), nullDate(req.requested_on), todayIST(), nz(req.reference_no), status, nullDate(req.completed_on), nullDate(req.valid_until), nz(req.findings), c.id.userId, t, t).run()
      return ok({ id })
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'a verification of that kind is already in flight for this employee', { code: 'already_requested' })
      return bad(e)
    }
  })

  // --- welfare -------------------------------------------------------------------------
  r.get('/hr/celebrations', READ, async (c) => {
    let days = 30
    const dv = Number(c.url.searchParams.get('days'))
    if (Number.isInteger(dv) && dv > 0 && dv <= 365) days = dv
    const today = todayIST()
    const rows = await c.db.prepare(`SELECT e.id, ${fullName('e.first_name', 'e.last_name')} AS full_name, d.name AS designation, e.date_of_birth, e.joined_on
        FROM employees e LEFT JOIN designations d ON d.id = e.designation_id WHERE e.status IN ('active','on_leave')`)
      .all<{ id: string; full_name: string; designation: string | null; date_of_birth: string | null; joined_on: string | null }>()
    const greetings = await c.db.prepare(`SELECT employee_id, kind, on_date FROM staff_celebration_greetings WHERE on_date BETWEEN ? AND ?`).bind(today, addDays(today, days))
      .all<{ employee_id: string; kind: string; on_date: string }>()
    const greeted = new Set(greetings.results.map((g) => `${g.employee_id}|${g.kind}|${g.on_date}`))
    const limit = addDays(today, days)
    const yearNow = Number(today.slice(0, 4))
    const anniversary = (base: string, years: number) => {
      // Adding whole years, clamping 29 February to the 28th in a common year.
      const y = Number(base.slice(0, 4)) + years, m = base.slice(5, 7)
      let d = Number(base.slice(8, 10))
      const dim = new Date(Date.UTC(y, Number(m), 0)).getUTCDate()
      if (d > dim) d = dim
      return `${y}-${m}-${String(d).padStart(2, '0')}`
    }
    const items: Record<string, unknown>[] = []
    for (const e of rows.results) {
      for (const [kind, base] of [['birthday', e.date_of_birth], ['work_anniversary', e.joined_on]] as const) {
        if (!base) continue
        const yearsNow = yearNow - Number(base.slice(0, 4))
        let onDate = anniversary(base, yearsNow), years = yearsNow
        if (onDate < today) { onDate = anniversary(base, yearsNow + 1); years = yearsNow + 1 }
        if (onDate > limit) continue
        if (kind === 'work_anniversary' && years <= 0) continue
        const daysAway = Math.round((Date.parse(onDate) - Date.parse(today)) / 86_400_000)
        items.push(omitNull({ employee_id: e.id, full_name: e.full_name, designation: e.designation, kind, on_date: onDate, years, days_away: daysAway, greeted: greeted.has(`${e.id}|${kind}|${onDate}`) }))
      }
    }
    items.sort((a, b) => (a.on_date as string).localeCompare(b.on_date as string) || (a.full_name as string).localeCompare(b.full_name as string))
    return ok({ items })
  })

  r.post('/hr/celebrations/greet', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const emp = str(req.employee_id)
    if (!isUUIDish(emp)) throw badRequest('employee_id must be a uuid')
    const kind = str(req.kind)
    if (kind !== 'birthday' && kind !== 'work_anniversary') throw badRequest('kind must be birthday or work_anniversary')
    let onDate = str(req.on_date)
    if (onDate === '') onDate = todayIST()
    const res = await c.db.prepare(`INSERT OR IGNORE INTO staff_celebration_greetings (id, institution_id, employee_id, kind, on_date, years, greeted_by, greeted_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(uuid(), school(c).id, emp, kind, onDate, numOrNull(req.years), c.id.userId, now()).run()
    return ok({ greeted: true, already_sent: res.meta.changes === 0 })
  })

  r.get('/hr/grievances', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const mine = grievanceFilter(re, 'g')
    const rows = await c.db.prepare(`
      SELECT g.id, g.reference_no, g.is_anonymous, CASE WHEN g.is_anonymous THEN NULL ELSE ${fullName('e.first_name', 'e.last_name')} END AS full_name,
             g.category, g.severity, g.subject, g.description, g.status, u.full_name AS assigned_to, g.resolution,
             ${istMinuteT('g.created_at')} AS raised_at, ${istMinuteT('g.resolved_at')} AS resolved_at,
             CAST(julianday(COALESCE(g.resolved_at, ?)) - julianday(g.created_at) AS INTEGER) AS open_days
        FROM staff_grievances g LEFT JOIN employees e ON e.id = g.employee_id LEFT JOIN users u ON u.id = g.assigned_to
       WHERE (? IS NOT 1 OR g.status NOT IN ('resolved','closed','withdrawn')) AND ${mine.sql}
       ORDER BY g.status IN ('resolved','closed','withdrawn'), CASE g.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, g.created_at LIMIT 300`)
      .bind(now(), c.url.searchParams.get('open') === 'true' ? 1 : 0, ...mine.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, is_anonymous: bool(v.is_anonymous) })) })
  })

  r.post('/hr/grievances', WRITE, async (c) => {
    const req = await readJSON(c.req)
    if (str(req.subject).trim() === '' || str(req.description).trim() === '') throw badRequest('a grievance needs a subject and what happened')
    let category = str(req.category), severity = str(req.severity)
    if (category === '') category = 'other'
    if (severity === '') severity = 'medium'
    const anonymous = req.is_anonymous === true
    if (!anonymous && str(req.employee_id) === '') throw badRequest('name the employee, or raise it anonymously')
    const inst = school(c).id
    // Seed the series before asking for a number, so the reference reads GRV/2026-27/0001.
    const scheme = await c.db.prepare(`SELECT 1 FROM numbering_schemes WHERE institution_id = ? AND kind = 'grievance' AND campus_id IS NULL`).bind(inst).first()
    if (!scheme) await c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, padding, next_value, reset_yearly, updated_at) VALUES (?,?,'grievance','GRV/',4,1,1,?)`).bind(uuid(), inst, now()).run()
    const ref = await nextNumber(c.db, inst, 'grievance')
    const id = uuid(), t = now()
    try {
      await c.db.prepare(`INSERT INTO staff_grievances (id, institution_id, reference_no, employee_id, raised_by, is_anonymous, category, severity, subject, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, inst, ref, anonymous ? null : nullID(req.employee_id), anonymous ? null : c.id.userId, anonymous ? 1 : 0, category, severity, str(req.subject), str(req.description), t, t).run()
    } catch (e) { bad(e) }
    return created({ id, reference_no: ref })
  })

  r.post('/hr/grievances/{id}/decide', WRITE, async (c) => {
    const gid = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const status = str(req.status)
    if (status === '') throw badRequest('say what the grievance has moved to')
    if ((status === 'resolved' || status === 'closed') && str(req.resolution).trim() === '') throw badRequest('closing a grievance needs a note saying what was done')
    const t = now()
    const res = await c.db.prepare(`UPDATE staff_grievances SET status = ?, assigned_to = COALESCE(?, assigned_to), resolution = COALESCE(?, resolution),
        acknowledged_at = COALESCE(acknowledged_at, CASE WHEN ? <> 'open' THEN ? END),
        resolved_at = CASE WHEN ? IN ('resolved','closed') THEN COALESCE(resolved_at, ?) END, updated_at = ? WHERE id = ?`)
      .bind(status, nullID(req.assigned_to), nz(req.resolution), status, t, status, t, t, gid).run()
    if (res.meta.changes === 0) throw notFound()
    return ok({ status })
  })

  r.get('/hr/recognitions', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT rc.id, e.id AS employee_id, ${fullName('e.first_name', 'e.last_name')} AS full_name, d.name AS designation, c.name AS campus, rc.award_code, rc.title, rc.citation,
             rc.period_year, rc.period_month, rc.awarded_on, u.full_name AS nominated_by, rc.published
        FROM staff_recognitions rc JOIN employees e ON e.id = rc.employee_id LEFT JOIN designations d ON d.id = e.designation_id LEFT JOIN campuses c ON c.id = rc.campus_id LEFT JOIN users u ON u.id = rc.nominated_by
       WHERE (? IS NOT 1 OR rc.published = 1) ORDER BY rc.awarded_on DESC, rc.created_at DESC LIMIT 200`).bind(c.url.searchParams.get('published') === 'true' ? 1 : 0).all<Record<string, unknown>>()
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return ok({ items: rows.results.map((v) => {
      const { period_year, period_month, ...rest } = v
      const period = period_year === null ? null : `${MON[(Number(period_month ?? 1) - 1) % 12]} ${period_year}`
      return omitNull({ ...rest, period, published: bool(v.published) })
    }) })
  })

  r.post('/hr/recognitions', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const emp = str(req.employee_id)
    if (!isUUIDish(emp)) throw badRequest('employee_id must be a uuid')
    if (str(req.title).trim() === '') throw badRequest('the award needs a title')
    let code = str(req.award_code)
    if (code === '') code = 'peer_praise'
    let year = numOrNull(req.period_year), month = numOrNull(req.period_month)
    if (code === 'teacher_of_the_month' && (year === null || month === null)) {
      const n = nowIST()
      year = n.getUTCFullYear(); month = n.getUTCMonth() + 1
    }
    const published = typeof req.published === 'boolean' ? req.published : true
    if (code === 'teacher_of_the_month' && year !== null && month !== null) {
      const dup = await c.db.prepare(`SELECT 1 FROM staff_recognitions WHERE award_code = ? AND period_year = ? AND period_month = ?`).bind(code, year, month).first()
      if (dup) throw new HttpError(409, 'that award has already been made for this month; withdraw it before naming somebody else', { code: 'award_already_made' })
    }
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO staff_recognitions (id, institution_id, employee_id, campus_id, award_code, title, citation, period_year, period_month, awarded_on, nominated_by, published, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, school(c).id, emp, nullID(req.campus_id), code, str(req.title), nz(req.citation), year, month, todayIST(), c.id.userId, published ? 1 : 0, now()).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'that award has already been made for this month; withdraw it before naming somebody else', { code: 'award_already_made' })
      bad(e)
    }
    return created({ id })
  })

  // --- leave policy and loss of pay ------------------------------------------------
  r.get('/hr/leave-policy', READ, async (c) => {
    const inst = school(c).id
    const scan = () => c.db.prepare(`SELECT half_day_fraction, substr(shift_starts_at,1,5) AS shift_starts_at, grace_minutes, late_marks_per_lop_day, late_half_day_after_minutes,
        lop_on_absent, lop_on_unpaid_leave, lop_on_exhausted_quota, lop_rounding, max_lop_days_per_month FROM leave_policy WHERE institution_id = ?`).bind(inst).first<Record<string, unknown>>()
    let p = await scan()
    if (!p) {
      await c.db.prepare(`INSERT OR IGNORE INTO leave_policy (institution_id, updated_at) VALUES (?, ?)`).bind(inst, now()).run()
      p = (await scan())!
    }
    const types = await c.db.prepare(`
      SELECT lt.id AS leave_type_id, lt.code, lt.name, lt.annual_quota, lt.is_paid, lt.carry_forward, COALESCE(pr.accrual, 'annual') AS accrual, pr.carry_forward_max,
             COALESCE(pr.encashable, 0) AS encashable, COALESCE(pr.allow_half_day, 1) AS allow_half_day, pr.max_consecutive_days, pr.max_per_month, COALESCE(pr.notice_days, 0) AS notice_days,
             pr.document_required_after_days, COALESCE(pr.available_during_probation, 0) AS available_during_probation, pr.applies_to_gender
        FROM leave_types lt LEFT JOIN leave_policy_rules pr ON pr.leave_type_id = lt.id WHERE lt.applies_to = 'staff' ORDER BY lt.name`).all<Record<string, unknown>>()
    return ok(omitNull({
      half_day_fraction: Number(p.half_day_fraction), shift_starts_at: p.shift_starts_at, grace_minutes: p.grace_minutes, late_marks_per_lop_day: p.late_marks_per_lop_day,
      late_half_day_after_minutes: p.late_half_day_after_minutes, lop_on_absent: bool(p.lop_on_absent), lop_on_unpaid_leave: bool(p.lop_on_unpaid_leave),
      lop_on_exhausted_quota: bool(p.lop_on_exhausted_quota), lop_rounding: p.lop_rounding, max_lop_days_per_month: asNum(p.max_lop_days_per_month),
      types: types.results.map((t) => omitNull({ leave_type_id: t.leave_type_id, code: t.code, name: t.name, annual_quota: asNum(t.annual_quota), is_paid: bool(t.is_paid), carry_forward: bool(t.carry_forward),
        accrual: t.accrual, carry_forward_max: asNum(t.carry_forward_max), encashable: bool(t.encashable), allow_half_day: bool(t.allow_half_day), max_consecutive_days: asNum(t.max_consecutive_days),
        max_per_month: asNum(t.max_per_month), notice_days: t.notice_days, document_required_after_days: asNum(t.document_required_after_days), available_during_probation: bool(t.available_during_probation),
        applies_to_gender: t.applies_to_gender })),
    }))
  })

  r.post('/hr/leave-policy', WRITE, async (c) => {
    const req = await readJSON(c.req)
    let shift = str(req.shift_starts_at), rounding = str(req.lop_rounding)
    if (shift === '') shift = '09:00'
    if (rounding === '') rounding = 'half'
    const marks = typeof req.late_marks_per_lop_day === 'number' ? req.late_marks_per_lop_day : 0
    if (marks <= 0) throw badRequest('say how many late marks make a day; zero would charge a day for every one')
    const inst = school(c).id, t = now()
    const half = typeof req.half_day_fraction === 'number' ? String(req.half_day_fraction) : '0'
    const maxLop = typeof req.max_lop_days_per_month === 'number' ? String(req.max_lop_days_per_month) : null
    const stmts = [c.db.prepare(`INSERT INTO leave_policy (institution_id, half_day_fraction, shift_starts_at, grace_minutes, late_marks_per_lop_day, late_half_day_after_minutes, lop_on_absent, lop_on_unpaid_leave, lop_on_exhausted_quota, lop_rounding, max_lop_days_per_month, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (institution_id) DO UPDATE SET half_day_fraction = excluded.half_day_fraction, shift_starts_at = excluded.shift_starts_at, grace_minutes = excluded.grace_minutes,
        late_marks_per_lop_day = excluded.late_marks_per_lop_day, late_half_day_after_minutes = excluded.late_half_day_after_minutes, lop_on_absent = excluded.lop_on_absent, lop_on_unpaid_leave = excluded.lop_on_unpaid_leave,
        lop_on_exhausted_quota = excluded.lop_on_exhausted_quota, lop_rounding = excluded.lop_rounding, max_lop_days_per_month = excluded.max_lop_days_per_month, updated_at = excluded.updated_at`)
      .bind(inst, half, shift.length === 5 ? shift + ':00' : shift, typeof req.grace_minutes === 'number' ? req.grace_minutes : 0, marks, numOrNull(req.late_half_day_after_minutes),
        req.lop_on_absent ? 1 : 0, req.lop_on_unpaid_leave ? 1 : 0, req.lop_on_exhausted_quota ? 1 : 0, rounding, maxLop, t)]
    for (const raw of (Array.isArray(req.types) ? (req.types as Record<string, unknown>[]) : [])) {
      const ltid = str(raw.leave_type_id)
      if (!isUUIDish(ltid)) throw badRequest('leave_type_id must be a uuid')
      const numS = (v: unknown) => (typeof v === 'number' ? String(v) : null)
      stmts.push(c.db.prepare(`INSERT INTO leave_policy_rules (leave_type_id, institution_id, accrual, carry_forward_max, encashable, allow_half_day, max_consecutive_days, max_per_month, notice_days, document_required_after_days, available_during_probation, applies_to_gender, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (leave_type_id) DO UPDATE SET accrual = excluded.accrual, carry_forward_max = excluded.carry_forward_max, encashable = excluded.encashable,
          allow_half_day = excluded.allow_half_day, max_consecutive_days = excluded.max_consecutive_days, max_per_month = excluded.max_per_month, notice_days = excluded.notice_days,
          document_required_after_days = excluded.document_required_after_days, available_during_probation = excluded.available_during_probation, applies_to_gender = excluded.applies_to_gender, updated_at = excluded.updated_at`)
        .bind(ltid, inst, str(raw.accrual) || 'annual', numS(raw.carry_forward_max), raw.encashable ? 1 : 0, raw.allow_half_day ? 1 : 0, numS(raw.max_consecutive_days), numS(raw.max_per_month),
          typeof raw.notice_days === 'number' ? raw.notice_days : 0, numS(raw.document_required_after_days), raw.available_during_probation ? 1 : 0, nz(raw.applies_to_gender), t))
      stmts.push(c.db.prepare(`UPDATE leave_types SET annual_quota = ? WHERE id = ? AND institution_id = ?`).bind(numS(raw.annual_quota), ltid, inst))
    }
    try { await c.db.batch(stmts) } catch (e) { bad(e) }
    return ok({ saved: true })
  })

  r.get('/hr/lop', READ, async (c) => {
    const q = c.url.searchParams
    let year = Number(q.get('year')), month = Number(q.get('month'))
    if (!year || month < 1 || month > 12 || !Number.isInteger(month)) {
      const n = nowIST()
      year = n.getUTCFullYear(); month = n.getUTCMonth()
      if (month === 0) { year--; month = 12 }
    }
    const re = await growthReach(c.db, c.id)
    const mine = employeeFilter(re, 'e')
    const reg = await lopRegister(c.db, school(c).id, year, month)
    const emps = await c.db.prepare(`SELECT e.id, e.employee_code, ${fullName('e.first_name', 'e.last_name')} AS full_name FROM employees e WHERE ${mine.sql}`).bind(...mine.args)
      .all<{ id: string; employee_code: string; full_name: string }>()
    const items: Record<string, unknown>[] = []
    for (const e of emps.results) {
      const l = reg.get(e.id)
      if (!l) continue
      items.push({ employee_id: e.id, employee_code: e.employee_code, full_name: e.full_name, absent_days: l.absent, half_days: l.halves, unpaid_leave_days: l.unpaid,
        late_marks: l.marks, lop_days: l.lop, quota_lop_days: l.quotaLop })
    }
    items.sort((a, b) => (b.lop_days as number) - (a.lop_days as number) || str(a.employee_code).localeCompare(str(b.employee_code)))
    const total = items.reduce((s, it) => s + (it.lop_days as number), 0)
    return ok({ items, year, month, total_lop_days: total })
  })
}

