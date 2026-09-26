import type { Router } from '../../router'
import { HttpError, badRequest, created, forbidden, isUUID, now, ok, readJSON, uuidParam } from '../../http'
import { can } from '../../identity'
import { indianGroup, isDate, items, omitNulls, p, paise, today, workingYear } from './common'
import { school } from '../school'

/* Port of refunds.go, concessions_grant.go, and the listConcessions /
   listRefunds readers in fees.go. No triggers touch these tables. */

const CONCESSION_KINDS = ['scholarship', 'sibling', 'staff_ward', 'rte', 'merit', 'other', 'full_payment']

export function registerRefunds(r: Router): void {
  // ---------------------------------------------------------------- the discount book
  r.get('/fees/concessions', 'finance.fees.read', async (c) => {
    const only = c.url.searchParams.get('status') ?? ''
    const rows = await c.db.prepare(`
      SELECT fc.id,
             COALESCE(NULLIF(TRIM(COALESCE(st.first_name, '') || COALESCE(' ' || st.last_name, '')), ''), TRIM(COALESCE(ap.first_name, '') || COALESCE(' ' || ap.last_name, ''))) AS student_name,
             COALESCE(st.admission_no, ap.application_no, '') AS admission_no,
             fh.name AS fee_head, fc.kind, fc.percent, fc.amount_paise, fc.reason, u.full_name AS approved_by, fc.status,
             COALESCE(fc.decision_note, '') AS decision_note, COALESCE(ru.full_name, '') AS requested_by,
             COALESCE(substr(fc.decided_at, 1, 10), '') AS decided_on, substr(fc.created_at, 1, 10) AS raised_on
        FROM fee_concessions fc
        LEFT JOIN students st ON st.id = fc.student_id
        LEFT JOIN applications ap ON ap.id = fc.application_id
        LEFT JOIN fee_heads fh ON fh.id = fc.fee_head_id
        LEFT JOIN users u ON u.id = fc.approved_by
        LEFT JOIN users ru ON ru.id = fc.requested_by
       WHERE (st.id IS NOT NULL OR ap.id IS NOT NULL) AND (?1 = '' OR fc.status = ?1)
       ORDER BY fc.status <> 'pending', fc.created_at DESC LIMIT 300`).bind(only).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omitNulls({ id: v.id, student_name: v.student_name, admission_no: v.admission_no, fee_head: v.fee_head, kind: v.kind,
      percent: v.percent === null ? null : String(v.percent), amount_paise: v.amount_paise === null ? null : p(v.amount_paise), reason: v.reason, approved_by: v.approved_by,
      status: v.status, decision_note: v.decision_note, requested_by: v.requested_by, decided_on: v.decided_on, raised_on: v.raised_on }))))
  })

  // ---------------------------------------------------------------- grant (raise) a concession
  r.post('/fees/concessions', 'auth', async (c) => {
    if (!can(c.id, 'finance.fees.write') && !can(c.id, 'admissions.write')) throw forbidden()
    const req = await readJSON<{ student_id?: string; application_id?: string; academic_year_id?: string; fee_head_id?: string; kind?: string; percent?: string;
      amount_paise?: unknown; reason?: string; pay_by?: string }>(c.req)
    const studentRaw = (req.student_id ?? '').trim(); const appRaw = (req.application_id ?? '').trim()
    let student: string | null = null, application: string | null = null
    if (studentRaw) { if (!isUUID(studentRaw)) throw badRequest('student_id must be a uuid'); student = studentRaw }
    if (appRaw) { if (!isUUID(appRaw)) throw badRequest('application_id must be a uuid'); application = appRaw }
    if (!student && !application) throw badRequest('say which child or applicant this is for')
    let year: string | null = null
    const yearRaw = (req.academic_year_id ?? '').trim()
    if (yearRaw) { if (!isUUID(yearRaw)) throw badRequest('academic_year_id must be a uuid'); year = yearRaw }
    else {
      year = await workingYear(c)
      if (!year && student) throw badRequest('no academic year is marked current, set one under Academics before granting a concession')
    }
    let head: string | null = null
    const headRaw = (req.fee_head_id ?? '').trim()
    if (headRaw) { if (!isUUID(headRaw)) throw badRequest('fee_head_id must be a uuid'); head = headRaw }
    const kind = (req.kind ?? '').trim()
    let payBy = (req.pay_by ?? '').trim()
    if (kind === 'full_payment') {
      if (payBy === '') throw badRequest('a full-payment concession needs the date the whole year must be paid by â the discount is for paying early, so it has to say by when')
      if (!isDate(payBy)) throw badRequest('pay_by must be a date like 2026-04-30')
      if (payBy <= today()) throw badRequest('the pay-by date has to be in the future')
    } else payBy = ''
    if (!CONCESSION_KINDS.includes(kind)) throw badRequest('kind must be one of ' + CONCESSION_KINDS.join(', '))
    const percent = (req.percent ?? '').trim()
    const hasAmount = req.amount_paise !== undefined && req.amount_paise !== null
    if (percent === '' && !hasAmount) throw badRequest('give either a percent or an amount')
    if (percent !== '' && hasAmount) throw badRequest('give a percent or an amount, not both. Two discounts on one row cannot be applied unambiguously')
    const amount = hasAmount ? paise(req.amount_paise) : null
    if (amount !== null && amount < 0) throw badRequest('amount cannot be negative')
    if (percent !== '' && !Number.isFinite(Number(percent))) throw badRequest('percent must be a number')
    const id = crypto.randomUUID()
    await c.db.prepare(`INSERT INTO fee_concessions (id, institution_id, student_id, application_id, academic_year_id, fee_head_id, kind, percent, amount_paise, reason, requested_by, pay_by, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, NULLIF(?, ''), ?, NULLIF(?, ''), 'pending', ?)`)
      .bind(id, school(c).id, student, application, year, head, kind, percent, amount, (req.reason ?? '').trim(), c.id.userId, payBy, now()).run()
    return created({ id })
  })

  // ---------------------------------------------------------------- refunds
  r.get('/fees/refunds', 'finance.fees.read', async (c) => {
    const rows = await c.db.prepare(`
      SELECT rf.id, st.id AS student_id, TRIM(st.first_name || COALESCE(' ' || st.last_name, '')) AS student_name, st.admission_no,
             rf.amount_paise, rf.reason, rf.mode, rf.status, rf.processed_on, substr(rf.created_at, 1, 10) AS created_at,
             ru.full_name AS requested_by, du.full_name AS decided_by, substr(rf.approved_at, 1, 10) AS decided_on, rf.decision_note, rf.reference_no
        FROM refunds rf JOIN students st ON st.id = rf.student_id
        LEFT JOIN users ru ON ru.id = rf.requested_by LEFT JOIN users du ON du.id = rf.approved_by
       ORDER BY rf.status <> 'pending', rf.status <> 'approved', rf.created_at DESC LIMIT 200`).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omitNulls({ id: v.id, student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no, amount_paise: p(v.amount_paise),
      reason: v.reason, mode: v.mode, status: v.status, processed_on: v.processed_on, created_at: v.created_at, requested_by: v.requested_by, decided_by: v.decided_by,
      decided_on: v.decided_on, decision_note: v.decision_note, reference_no: v.reference_no }))))
  })

  r.post('/fees/refunds', 'finance.fees.write', async (c) => {
    const req = await readJSON<{ student_id?: string; amount_paise?: unknown; reason?: string; mode?: string; payment_id?: string }>(c.req)
    if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
    const amount = paise(req.amount_paise)
    if (amount <= 0) throw badRequest('amount_paise must be positive')
    const reason = (req.reason ?? '').trim()
    if (reason === '') throw badRequest('say why the money is going back. It is what the family is told and what an auditor reads')
    let payment: string | null = null
    if ((req.payment_id ?? '').trim()) { if (!isUUID(req.payment_id)) throw badRequest('payment_id must be a uuid'); payment = req.payment_id }
    const rr = await c.db.prepare(`
      SELECT COALESCE((SELECT sum(amount_paise) FROM payments WHERE student_id = ?1 AND status = 'success' AND mode <> 'adjustment'), 0)
           - COALESCE((SELECT sum(amount_paise) FROM refunds WHERE student_id = ?1 AND status <> 'rejected'), 0) AS refundable`).bind(req.student_id).first<{ refundable: number }>()
    const refundable = p(rr?.refundable)
    if (amount > refundable) {
      throw new HttpError(409, `that is more than this family has paid and not already been refunded. At most ₹${indianGroup(Math.trunc(refundable / 100))} can go back`, { code: 'refund_exceeds_paid' })
    }
    const id = crypto.randomUUID()
    await c.db.prepare(`INSERT INTO refunds (id, institution_id, student_id, payment_id, amount_paise, reason, mode, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), 'pending', ?, ?)`)
      .bind(id, school(c).id, req.student_id, payment, amount, reason, (req.mode ?? '').trim(), c.id.userId, now()).run()
    return created({ id, status: 'pending' })
  })

  r.post('/fees/refunds/{id}/decide', 'finance.refunds.write', async (c) => {
    const id = uuidParam(c.params.id)
    const req = await readJSON<{ decision?: string; note?: string }>(c.req)
    const note = (req.note ?? '').trim()
    if (req.decision !== 'approved' && req.decision !== 'rejected') throw badRequest('decision must be approved or rejected')
    if (req.decision === 'rejected' && note === '') throw badRequest('a refusal needs a reason the family can be given')
    const res = await c.db.prepare(`UPDATE refunds SET status = ?2, approved_by = ?3, approved_at = ?5, decision_note = NULLIF(?4, '') WHERE id = ?1 AND status = 'pending'`)
      .bind(id, req.decision, c.id.userId, note, now()).run()
    if (!res.meta.changes) throw badRequest('only a pending refund can be decided')
    return ok({ id, status: req.decision })
  })

  r.post('/fees/refunds/{id}/process', 'finance.refunds.write', async (c) => {
    const id = uuidParam(c.params.id)
    const req = await readJSON<{ mode?: string; reference_no?: string; processed_on?: string }>(c.req)
    const mode = (req.mode ?? '').trim().toLowerCase()
    if (mode === '') throw badRequest('say how it was paid, cash, cheque, neft or upi')
    let on = today()
    if (req.processed_on) { if (!isDate(req.processed_on)) throw badRequest('processed_on must be YYYY-MM-DD'); on = req.processed_on }
    const res = await c.db.prepare(`UPDATE refunds SET status = 'processed', processed_on = ?2, mode = ?3, reference_no = NULLIF(?4, ''), processed_by = ?5 WHERE id = ?1 AND status = 'approved'`)
      .bind(id, on, mode, (req.reference_no ?? '').trim(), c.id.userId).run()
    if (!res.meta.changes) throw badRequest('only an approved refund can be paid out')
    return ok({ id, status: 'processed' })
  })
}
