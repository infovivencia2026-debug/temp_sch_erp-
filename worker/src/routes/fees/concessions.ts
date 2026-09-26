import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, bool, clampInt, created, isUUID, like, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import {
  fin, paise, isForeignKeyViolation, p, items, today, isDate, daysBetween, financialYear, str,
  syncInvoice, syncPayment, isBatchGuardFailure,
} from './common'
import { nextNumber } from './numbering'
import { claimFile, decodeBody, goQuote, goTrimSpace, jsonChunks, parseDisbursements } from './fileformats'
import { allocate } from './counter'
import { school } from '../school'

/* Port of mountConcessions (internal/api/concessions.go): the government aid
   scheme registry, reimbursement rates, government reimbursement claims, NSP
   scholarship reconciliation and the education loan tracker. grantConcession
   and listConcessions live elsewhere.

   Every route sits inside the /finance group (fin() keeps the group gate) and
   adds its own rung: read = finance.fees.read, write = finance.fees.write,
   approve = finance.refunds.write, export = finance.export.

   Triggers re-implemented in the batches that fire them:
     reimbursement_claim_lines_roll_up  (reimbursement_claim_totals)
     reimbursement_receipts_roll_up     (reimbursement_claim_received)
     sync_invoice_paid / sync_payment_allocated for the fee credit payment.

   Postgres unique indexes that were expression- or partial-based did not make
   it into the SQLite schema (scheme code, claim_no, receipt duplicate, award
   ref, lender+branch, live application, application ref, document kind); each
   is checked here before the write and answered as the Go handler did. */

const READ = 'finance.fees.read'
const WRITE = 'finance.fees.write'
const APPROVE = 'finance.refunds.write'
const EXPORT = 'finance.export'

/** Go refusal: a sentence a clerk can act on, as 400. */
const refusal = (m: string) => badRequest(m)
const conflictCode = (code: string, m: string) => new HttpError(409, m, { code })

/** concat_ws(' ', first_name, last_name) for a students alias. */
const name2 = (a = 'st') => `TRIM(${a}.first_name || COALESCE(' ' || ${a}.last_name, ''))`

/** nullBool for ?active= style query params. */
function nullBool(s: string | null): boolean | null {
  switch ((s ?? '').trim().toLowerCase()) {
    case 'true': case '1': case 'yes': return true
    case 'false': case '0': case 'no': return false
    default: return null
  }
}
const nullUUIDText = (s: unknown): string | null => (isUUID(typeof s === 'string' ? s.trim() : s) ? (s as string).trim() : null)
const nullString = (s: unknown): string | null => { const v = str(s); return v === '' ? null : v }

/** optionalISODay: absent is null, present-and-unreadable throws. */
function optionalISODay(raw: unknown, name: string): string | null {
  const s = str(raw).trim()
  if (s === '') return null
  if (!isDate(s)) throw badRequest(`${name} must be YYYY-MM-DD`)
  return s
}
function requiredISODay(raw: unknown, name: string): string {
  const s = str(raw).trim()
  if (!isDate(s)) throw badRequest(`${name} must be YYYY-MM-DD`)
  return s
}

/** to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z' for a stored ISO timestamp. */
function tsZ(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const ms = Date.parse(String(v))
  if (Number.isNaN(ms)) return String(v)
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
const day = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10))
const optInt = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

/** Drops the keys the Go struct tagged omitempty when they are null. */
function omit<T extends Record<string, unknown>>(o: T, keys: readonly string[]): T {
  for (const k of keys) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

/* ------------------------------------------------------------------------- */
/* money and dates */

/** prorataPaise: annual rate apportioned across months, rounded half up. */
function prorataPaise(annualPaise: number, months: number): number {
  if (months >= 12) return annualPaise
  if (months <= 0) return 0
  return Math.floor((annualPaise * months + 6) / 12)
}

/** claimAgeDays: days since submitted_on, counted in India; a draft has no age. */
function claimAgeDays(submitted: string | null): number {
  if (!submitted) return 0
  const d = daysBetween(submitted.slice(0, 10), today())
  return d < 0 ? 0 : d
}
function ageBucket(days: number): string {
  if (days <= 90) return '0-90'
  if (days <= 180) return '91-180'
  if (days <= 365) return '181-365'
  return '365+'
}

/**
 * Postgres age(later, earlier): whole years and months between two dates,
 * as the claim builder counted them: year*12 + month + 1, at least 1.
 */
function monthsOnRoll(earlier: string, later: string): number {
  if (later < earlier) return 1
  const a = new Date(earlier + 'T00:00:00Z'); const b = new Date(later + 'T00:00:00Z')
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
  if (b.getUTCDate() < a.getUTCDate()) months--
  return Math.max(1, months + 1)
}

/* ------------------------------------------------------------------------- */
/* claims */

const CLAIM_SELECT = `
  SELECT c.id, c.scheme_id, sc.name AS scheme_name, sc.code AS scheme_code,
         c.academic_year_id, ay.name AS academic_year,
         c.claim_no, c.period_start, c.period_end,
         c.status, c.child_count, c.claimed_paise, c.sanctioned_paise, c.received_paise,
         c.submitted_on, c.submitted_ref, c.sanction_order_no,
         c.sanction_on, c.rejected_reason, c.notes, u.full_name AS prepared_by
    FROM reimbursement_claims c
    JOIN government_aid_schemes sc ON sc.id = c.scheme_id
    JOIN academic_years ay ON ay.id = c.academic_year_id
    LEFT JOIN users u ON u.id = c.prepared_by`

interface ClaimRow {
  id: string; scheme_id: string; scheme_name: string; scheme_code: string; academic_year_id: string; academic_year: string
  claim_no: string; period_start: string; period_end: string; status: string; child_count: number
  claimed_paise: number; sanctioned_paise: number; received_paise: number
  submitted_on: string | null; submitted_ref: string | null; sanction_order_no: string | null; sanction_on: string | null
  rejected_reason: string | null; notes: string | null; prepared_by: string | null
}
interface ClaimView {
  id: string; scheme_id: string; scheme_name: string; scheme_code: string; academic_year_id: string; academic_year: string
  claim_no: string; period_start: string; period_end: string; status: string; child_count: number
  claimed_paise: number; sanctioned_paise: number; received_paise: number; outstanding_paise: number
  age_days: number; age_bucket: string
  submitted_on?: string; submitted_ref?: string; sanction_order_no?: string; sanction_on?: string
  rejected_reason?: string; notes?: string; prepared_by?: string
}

function claimView(r: ClaimRow): ClaimView {
  const claimed = p(r.claimed_paise); const received = p(r.received_paise)
  const v: Record<string, unknown> = {
    id: r.id, scheme_id: r.scheme_id, scheme_name: r.scheme_name, scheme_code: r.scheme_code,
    academic_year_id: r.academic_year_id, academic_year: r.academic_year, claim_no: r.claim_no,
    period_start: day(r.period_start), period_end: day(r.period_end), status: r.status, child_count: Number(r.child_count),
    claimed_paise: claimed, sanctioned_paise: p(r.sanctioned_paise), received_paise: received,
    outstanding_paise: Math.max(0, claimed - received), age_days: 0, age_bucket: '',
    submitted_on: day(r.submitted_on), submitted_ref: r.submitted_ref, sanction_order_no: r.sanction_order_no,
    sanction_on: day(r.sanction_on), rejected_reason: r.rejected_reason, notes: r.notes, prepared_by: r.prepared_by,
  }
  if (r.submitted_on) { v.age_days = claimAgeDays(r.submitted_on); v.age_bucket = ageBucket(v.age_days as number) }
  return omit(v, ['submitted_on', 'submitted_ref', 'sanction_order_no', 'sanction_on', 'rejected_reason', 'notes', 'prepared_by']) as unknown as ClaimView
}

/** reimbursement_claim_lines_roll_up: the claim header follows its lines. */
function claimTotalsStmt(c: Ctx, claimId: string): D1PreparedStatement {
  return c.db.prepare(`
    UPDATE reimbursement_claims
       SET child_count = (SELECT count(*) FROM reimbursement_claim_lines l WHERE l.claim_id = ?1),
           claimed_paise = COALESCE((SELECT sum(l.claimed_paise) FROM reimbursement_claim_lines l WHERE l.claim_id = ?1), 0),
           sanctioned_paise = COALESCE((SELECT sum(COALESCE(l.sanctioned_paise, 0)) FROM reimbursement_claim_lines l WHERE l.claim_id = ?1), 0),
           updated_at = ?2
     WHERE id = ?1`).bind(claimId, now())
}
/** reimbursement_receipts_roll_up: received_paise follows the receipts. */
function claimReceivedStmt(c: Ctx, claimId: string): D1PreparedStatement {
  return c.db.prepare(`
    UPDATE reimbursement_claims
       SET received_paise = COALESCE((SELECT sum(rr.amount_paise) FROM reimbursement_receipts rr WHERE rr.claim_id = ?1), 0),
           updated_at = ?2
     WHERE id = ?1`).bind(claimId, now())
}

async function claimStatus(c: Ctx, claimId: string): Promise<string> {
  const row = await c.db.prepare(`SELECT status FROM reimbursement_claims WHERE id = ? AND institution_id = ?`)
    .bind(claimId, school(c).id).first<{ status: string }>()
  if (!row) throw notFound()
  return row.status
}

function paidToForKind(kind: string): string | null {
  switch (kind) {
    case 'rte_reimbursement': case 'fee_reimbursement': return 'school'
    case 'nsp_scholarship': case 'state_scholarship': return 'student'
  }
  return null
}

/* ------------------------------------------------------------------------- */

const LOAN_CHECKLIST = ['fee_structure', 'bonafide_certificate', 'admission_letter', 'fee_receipts', 'marksheet', 'id_proof', 'address_proof', 'income_proof']
const LOAN_TRANSITIONS: Record<string, string[]> = {
  enquiry: ['documents_pending', 'withdrawn'],
  documents_pending: ['submitted_to_lender', 'withdrawn'],
  submitted_to_lender: ['under_review', 'sanctioned', 'declined', 'withdrawn'],
  under_review: ['sanctioned', 'declined', 'withdrawn'],
  sanctioned: ['disbursed', 'withdrawn'],
  declined: ['documents_pending'],
  withdrawn: ['documents_pending'],
  disbursed: [],
}
const LOAN_LIVE = ['enquiry', 'documents_pending', 'submitted_to_lender', 'under_review']

const LOAN_SELECT = (todayStr: string) => `
  SELECT ap.id, ap.student_id, ${name2('st')} AS student_name, st.admission_no,
         (SELECT cl.name FROM enrollments e JOIN classes cl ON cl.id = e.class_id WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS class_name,
         ap.lender_id,
         CASE WHEN le.id IS NULL THEN NULL ELSE le.name || COALESCE(' · ' || le.branch, '') END AS lender_name,
         ay.name AS academic_year, ap.reference_no, ap.opened_on,
         ap.amount_sought_paise, ap.status, ap.status_changed_on,
         ap.sanctioned_amount_paise, ap.disbursed_amount_paise,
         ap.outcome_reported_on, ap.declined_reason,
         u.full_name AS assisted_by, ap.notes,
         (SELECT count(*) FROM education_loan_documents dd WHERE dd.application_id = ap.id) AS docs_total,
         (SELECT count(*) FROM education_loan_documents dd WHERE dd.application_id = ap.id AND dd.status = 'required') AS docs_outstanding,
         MAX(0, CAST(julianday('${todayStr}') - julianday(ap.status_changed_on) AS INTEGER)) AS days_in_status
    FROM education_loan_applications ap
    JOIN students st ON st.id = ap.student_id
    LEFT JOIN education_loan_lenders le ON le.id = ap.lender_id
    LEFT JOIN academic_years ay ON ay.id = ap.academic_year_id
    LEFT JOIN users u ON u.id = ap.assisted_by`

function loanView(r: Record<string, unknown>) {
  return omit({
    id: r.id, student_id: r.student_id, student_name: r.student_name, admission_no: r.admission_no,
    class_name: r.class_name ?? null, lender_id: r.lender_id ?? null, lender_name: r.lender_name ?? null,
    academic_year: r.academic_year ?? null, reference_no: r.reference_no ?? null, opened_on: day(r.opened_on),
    amount_sought_paise: optInt(r.amount_sought_paise), status: r.status, status_changed_on: day(r.status_changed_on),
    sanctioned_amount_paise: optInt(r.sanctioned_amount_paise), disbursed_amount_paise: optInt(r.disbursed_amount_paise),
    outcome_reported_on: day(r.outcome_reported_on), declined_reason: r.declined_reason ?? null,
    assisted_by: r.assisted_by ?? null, notes: r.notes ?? null,
    docs_total: Number(r.docs_total ?? 0), docs_outstanding: Number(r.docs_outstanding ?? 0), days_in_status: Number(r.days_in_status ?? 0),
  }, ['class_name', 'lender_id', 'lender_name', 'academic_year', 'reference_no', 'amount_sought_paise', 'sanctioned_amount_paise',
    'disbursed_amount_paise', 'outcome_reported_on', 'declined_reason', 'assisted_by', 'notes'])
}

/* ------------------------------------------------------------------------- */

export function registerConcessions(r: Router): void {
  const inst = (c: Ctx) => school(c).id

  // ===================================================== scheme registry
  r.get('/finance/concessions/schemes', READ, fin(async (c) => {
    const q = c.url.searchParams
    const paidTo = nullString(q.get('paid_to'))
    const active = nullBool(q.get('active'))
    const rows = await c.db.prepare(`
      SELECT sc.id, sc.code, sc.name, sc.kind, sc.paid_to, sc.authority, sc.portal_url, sc.claim_frequency, sc.is_active, sc.notes,
             (SELECT count(*) FROM reimbursement_claims c WHERE c.scheme_id = sc.id) AS claim_count,
             (SELECT count(*) FROM scholarship_awards a WHERE a.scheme_id = sc.id) AS award_count
        FROM government_aid_schemes sc
       WHERE (?1 IS NULL OR sc.paid_to = ?1)
         AND (?2 IS NULL OR sc.is_active = ?2)
       ORDER BY sc.is_active DESC, sc.name`).bind(paidTo, active === null ? null : active ? 1 : 0).all<Record<string, unknown>>()
    return ok(items(rows.results.map((x) => omit({
      id: x.id, code: x.code, name: x.name, kind: x.kind, paid_to: x.paid_to, authority: x.authority ?? null, portal_url: x.portal_url ?? null,
      claim_frequency: x.claim_frequency ?? null, is_active: bool(x.is_active), notes: x.notes ?? null,
      claim_count: Number(x.claim_count), award_count: Number(x.award_count),
    }, ['authority', 'portal_url', 'claim_frequency', 'notes']))))
  }))

  r.post('/finance/concessions/schemes', WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const code = str(req.code).trim(); const name = str(req.name).trim(); const kind = str(req.kind).trim()
    let freq = str(req.claim_frequency).trim()
    const paidTo = paidToForKind(kind)
    if (code === '') throw badRequest('give the scheme a short code, so a claim can name it')
    if (name === '') throw badRequest('what is the scheme called?')
    if (!paidTo) throw badRequest('kind must be rte_reimbursement, fee_reimbursement, nsp_scholarship or state_scholarship')
    if (paidTo === 'school' && freq === '') freq = 'quarterly'
    if (paidTo === 'student') freq = ''
    if (freq !== '' && !['monthly', 'quarterly', 'half_yearly', 'annual'].includes(freq)) {
      throw badRequest('claim frequency must be monthly, quarterly, half_yearly or annual')
    }
    const active = typeof req.is_active === 'boolean' ? req.is_active : true
    const rid = str(req.id).trim()
    let id: string
    if (rid !== '') {
      if (!isUUID(rid)) throw refusal('malformed scheme id')
      id = rid
    } else id = uuid()
    // government_aid_schemes_one_per_code (institution_id, lower(btrim(code)))
    const clash = await c.db.prepare(`SELECT id FROM government_aid_schemes WHERE institution_id = ? AND lower(trim(code)) = lower(?) AND id <> ?`)
      .bind(inst(c), code, id).first()
    if (clash) throw conflictCode('duplicate_scheme', 'a scheme with that code already exists')
    if (rid !== '') {
      const res = await c.db.prepare(`
        UPDATE government_aid_schemes
           SET code = ?3, name = ?4, kind = ?5, paid_to = ?6, authority = ?7, portal_url = ?8, claim_frequency = ?9, is_active = ?10, notes = ?11, updated_at = ?12
         WHERE id = ?1 AND institution_id = ?2`)
        .bind(id, inst(c), code, name, kind, paidTo, nullString(req.authority), nullString(req.portal_url), nullString(freq), active ? 1 : 0, nullString(req.notes), now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id })
    }
    await c.db.prepare(`
      INSERT INTO government_aid_schemes (id, institution_id, code, name, kind, paid_to, authority, portal_url, claim_frequency, is_active, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), code, name, kind, paidTo, nullString(req.authority), nullString(req.portal_url), nullString(freq), active ? 1 : 0, nullString(req.notes), c.id.userId, now(), now()).run()
    return ok({ id })
  }))

  r.get('/finance/concessions/rates', READ, fin(async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(`
      SELECT rr.id, rr.scheme_id, sc.name AS scheme_name, rr.academic_year_id, ay.name AS academic_year,
             rr.from_level, rr.to_level, rr.annual_rate_paise, rr.notification_ref, rr.notified_on, rr.notes
        FROM reimbursement_rates rr
        JOIN government_aid_schemes sc ON sc.id = rr.scheme_id
        JOIN academic_years ay ON ay.id = rr.academic_year_id
       WHERE (?1 IS NULL OR rr.scheme_id = ?1)
         AND (?2 IS NULL OR rr.academic_year_id = ?2)
       ORDER BY ay.starts_on DESC, sc.name, rr.from_level`)
      .bind(nullUUIDText(q.get('scheme_id')), nullUUIDText(q.get('academic_year_id'))).all<Record<string, unknown>>()
    return ok(items(rows.results.map((x) => omit({
      id: x.id, scheme_id: x.scheme_id, scheme_name: x.scheme_name, academic_year_id: x.academic_year_id, academic_year: x.academic_year,
      from_level: Number(x.from_level), to_level: Number(x.to_level), annual_rate_paise: p(x.annual_rate_paise),
      notification_ref: x.notification_ref ?? null, notified_on: day(x.notified_on), notes: x.notes ?? null,
    }, ['notification_ref', 'notified_on', 'notes']))))
  }))

  r.post('/finance/concessions/rates', WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const scheme = nullUUIDText(req.scheme_id); if (!scheme) throw badRequest('which scheme is this rate for?')
    const year = nullUUIDText(req.academic_year_id); if (!year) throw badRequest('which academic year does this rate apply to?')
    const fromLevel = Math.trunc(Number(req.from_level ?? 0)); const toLevel = Math.trunc(Number(req.to_level ?? 0))
    if (!Number.isFinite(fromLevel) || !Number.isFinite(toLevel)) throw badRequest('from_level and to_level must be whole numbers')
    const rate = paise(req.annual_rate_paise, 'annual_rate_paise')
    if (toLevel < fromLevel) throw badRequest('the band ends before it starts')
    if (rate < 0) throw badRequest('a notified rate cannot be negative')
    const notified = optionalISODay(req.notified_on, 'notified_on')
    const rid = str(req.id).trim()
    if (rid !== '' && !isUUID(rid)) throw refusal('malformed rate id')

    // Overlapping bands: int4range(from,to,'[]') && int4range($5,$6,'[]').
    const clash = await c.db.prepare(`
      SELECT count(*) AS n FROM reimbursement_rates
       WHERE institution_id = ?1 AND scheme_id = ?2 AND academic_year_id = ?3
         AND (?4 IS NULL OR id <> ?4)
         AND from_level <= ?6 AND to_level >= ?5`).bind(inst(c), scheme, year, rid || null, fromLevel, toLevel).first<{ n: number }>()
    if (Number(clash?.n ?? 0) > 0) {
      throw refusal(`classes ${fromLevel} to ${toLevel} overlap a rate already notified for this scheme and year; correct that band instead of adding a second one`)
    }
    if (rid !== '') {
      const res = await c.db.prepare(`
        UPDATE reimbursement_rates
           SET scheme_id = ?3, academic_year_id = ?4, from_level = ?5, to_level = ?6, annual_rate_paise = ?7, notification_ref = ?8, notified_on = ?9, notes = ?10, updated_at = ?11
         WHERE id = ?1 AND institution_id = ?2`)
        .bind(rid, inst(c), scheme, year, fromLevel, toLevel, rate, nullString(req.notification_ref), notified, nullString(req.notes), now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: rid })
    }
    const id = uuid()
    await c.db.prepare(`
      INSERT INTO reimbursement_rates (id, institution_id, scheme_id, academic_year_id, from_level, to_level, annual_rate_paise, notification_ref, notified_on, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), scheme, year, fromLevel, toLevel, rate, nullString(req.notification_ref), notified, nullString(req.notes), now(), now()).run()
    return ok({ id })
  }))

  // ================================================= reimbursement claims
  r.get('/finance/concessions/claims', READ, fin(async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(CLAIM_SELECT + `
       WHERE (?1 IS NULL OR c.scheme_id = ?1)
         AND (?2 IS NULL OR c.academic_year_id = ?2)
         AND (?3 IS NULL OR c.status = ?3)
       ORDER BY c.period_start DESC, sc.name
       LIMIT ?4`)
      .bind(nullUUIDText(q.get('scheme_id')), nullUUIDText(q.get('academic_year_id')), nullString(q.get('status')), clampInt(q.get('limit'), 200, 1, 1000))
      .all<ClaimRow>()
    return ok(items(rows.results.map(claimView)))
  }))

  // The ageing report. Registered before /{id} so "ageing" is not parsed as a claim id.
  r.get('/finance/concessions/claims/ageing', READ, fin(async (c) => {
    const rows = await c.db.prepare(CLAIM_SELECT + `
       WHERE c.status IN ('submitted','part_sanctioned','sanctioned')
         AND c.claimed_paise > c.received_paise
         AND (?1 IS NULL OR c.scheme_id = ?1)
       ORDER BY c.submitted_on`).bind(nullUUIDText(c.url.searchParams.get('scheme_id'))).all<ClaimRow>()
    let claims = rows.results.map(claimView)
    const order = ['365+', '181-365', '91-180', '0-90']
    const by: Record<string, { bucket: string; claim_count: number; child_count: number; claimed_paise: number; sanctioned_paise: number; received_paise: number; outstanding_paise: number }> = {}
    for (const b of order) by[b] = { bucket: b, claim_count: 0, child_count: 0, claimed_paise: 0, sanctioned_paise: 0, received_paise: 0, outstanding_paise: 0 }
    let totalOutstanding = 0
    for (const cl of claims) {
      const b = by[cl.age_bucket]; if (!b) continue
      b.claim_count++; b.child_count += cl.child_count; b.claimed_paise += cl.claimed_paise; b.sanctioned_paise += cl.sanctioned_paise
      b.received_paise += cl.received_paise; b.outstanding_paise += cl.outstanding_paise
      totalOutstanding += cl.outstanding_paise
    }
    claims = [...claims].sort((a, b) => b.age_days - a.age_days).slice(0, 25)
    return ok({ buckets: order.map((b) => by[b]), oldest: claims, total_outstanding_paise: totalOutstanding })
  }))

  r.post('/finance/concessions/claims', WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const scheme = nullUUIDText(req.scheme_id); if (!scheme) throw badRequest('which scheme is this claim under?')
    const year = nullUUIDText(req.academic_year_id); if (!year) throw badRequest('which academic year does this claim cover?')
    const start = requiredISODay(req.period_start, 'period_start')
    const end = requiredISODay(req.period_end, 'period_end')
    if (end < start) throw badRequest('the period ends before it starts')

    const sc = await c.db.prepare(`SELECT paid_to, code FROM government_aid_schemes WHERE id = ? AND institution_id = ?`).bind(scheme, inst(c))
      .first<{ paid_to: string; code: string }>()
    if (!sc) throw notFound()
    if (sc.paid_to !== 'school') throw refusal('this scheme pays the student directly; it is reconciled on the scholarship screen, not claimed for here')

    let claimNo = str(req.claim_no).trim()
    if (claimNo === '') {
      const d = new Date(start + 'T00:00:00Z')
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
      claimNo = `${sc.code.toUpperCase()}/${financialYear(start)}/${mon}${d.getUTCFullYear()}`
    }
    const rid = str(req.id).trim()
    if (rid !== '' && !isUUID(rid)) throw refusal('malformed claim id')
    const id = rid || uuid()
    // reimbursement_claims_one_per_no (institution_id, scheme_id, lower(btrim(claim_no))); one_per_period is a real index.
    const dupNo = await c.db.prepare(`SELECT id FROM reimbursement_claims WHERE institution_id = ? AND scheme_id = ? AND lower(trim(claim_no)) = lower(?) AND id <> ?`)
      .bind(inst(c), scheme, claimNo, id).first()
    if (dupNo) throw conflictCode('duplicate_claim', 'a claim with that number already exists under this scheme')
    const dupPeriod = await c.db.prepare(`SELECT id FROM reimbursement_claims WHERE institution_id = ? AND scheme_id = ? AND academic_year_id = ? AND period_start = ? AND period_end = ? AND id <> ?`)
      .bind(inst(c), scheme, year, start, end, id).first()
    if (dupPeriod) throw conflictCode('duplicate_claim', 'a claim for this scheme and period already exists')

    if (rid !== '') {
      const status = await claimStatus(c, rid)
      if (status !== 'draft') throw refusal(`this claim has already been ${status}; only its notes can change now`)
      await c.db.prepare(`
        UPDATE reimbursement_claims
           SET scheme_id = ?3, academic_year_id = ?4, claim_no = ?5, period_start = ?6, period_end = ?7, notes = ?8, updated_at = ?9
         WHERE id = ?1 AND institution_id = ?2`).bind(rid, inst(c), scheme, year, claimNo, start, end, nullString(req.notes), now()).run()
      return ok({ id: rid })
    }
    await c.db.prepare(`
      INSERT INTO reimbursement_claims (id, institution_id, scheme_id, academic_year_id, claim_no, period_start, period_end, status, notes, prepared_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
      .bind(id, inst(c), scheme, year, claimNo, start, end, nullString(req.notes), c.id.userId, now(), now()).run()
    return ok({ id })
  }))

  r.get('/finance/concessions/claims/{id}', READ, fin(async (c) => {
    const claimId = uuidParam(c.params.id)
    const head = await c.db.prepare(CLAIM_SELECT + ` WHERE c.id = ? AND c.institution_id = ?`).bind(claimId, inst(c)).first<ClaimRow>()
    if (!head) throw notFound()
    const [lines, receipts] = await Promise.all([
      c.db.prepare(`
        SELECT l.id, l.student_id, ${name2('st')} AS student_name, st.admission_no,
               cl.name AS class_name, l.class_level, l.rate_paise, l.months, l.claimed_paise,
               l.sanctioned_paise, l.disallowed_reason, (l.concession_id IS NOT NULL) AS has_concession, l.notes
          FROM reimbursement_claim_lines l
          JOIN students st ON st.id = l.student_id
          LEFT JOIN classes cl ON cl.id = l.class_id
         WHERE l.claim_id = ? AND l.institution_id = ?
         ORDER BY cl.name NULLS LAST, st.first_name, st.admission_no`).bind(claimId, inst(c)).all<Record<string, unknown>>(),
      c.db.prepare(`
        SELECT rr.id, rr.received_on, rr.amount_paise, rr.mode, rr.reference_no, rr.treasury_voucher, ba.label AS bank_account, rr.notes, u.full_name AS recorded_by
          FROM reimbursement_receipts rr
          LEFT JOIN bank_accounts ba ON ba.id = rr.bank_account_id
          LEFT JOIN users u ON u.id = rr.recorded_by
         WHERE rr.claim_id = ? AND rr.institution_id = ?
         ORDER BY rr.received_on DESC`).bind(claimId, inst(c)).all<Record<string, unknown>>(),
    ])
    return ok({
      claim: claimView(head),
      lines: lines.results.map((x) => {
        const sanctioned = optInt(x.sanctioned_paise)
        return omit({
          id: x.id, student_id: x.student_id, student_name: x.student_name, admission_no: x.admission_no,
          class_name: x.class_name ?? null, class_level: optInt(x.class_level), rate_paise: p(x.rate_paise), months: Number(x.months),
          claimed_paise: p(x.claimed_paise), sanctioned_paise: sanctioned,
          shortfall_paise: sanctioned === null ? 0 : p(x.claimed_paise) - sanctioned,
          disallowed_reason: x.disallowed_reason ?? null, has_concession: bool(x.has_concession), notes: x.notes ?? null,
        }, ['class_name', 'class_level', 'sanctioned_paise', 'disallowed_reason', 'notes'])
      }),
      receipts: receipts.results.map((x) => omit({
        id: x.id, received_on: day(x.received_on), amount_paise: p(x.amount_paise), mode: x.mode, reference_no: x.reference_no ?? null,
        treasury_voucher: x.treasury_voucher ?? null, bank_account: x.bank_account ?? null, notes: x.notes ?? null, recorded_by: x.recorded_by ?? null,
      }, ['reference_no', 'treasury_voucher', 'bank_account', 'notes', 'recorded_by'])),
    })
  }))

  r.post('/finance/concessions/claims/{id}/build', WRITE, fin(async (c) => {
    const claimId = uuidParam(c.params.id)
    const head = await c.db.prepare(`SELECT status, scheme_id, academic_year_id, period_start, period_end FROM reimbursement_claims WHERE id = ? AND institution_id = ?`)
      .bind(claimId, inst(c)).first<{ status: string; scheme_id: string; academic_year_id: string; period_start: string; period_end: string }>()
    if (!head) throw notFound()
    if (head.status !== 'draft') throw refusal(`this claim was ${head.status}; assembling it again would change what the department was told`)
    const start = head.period_start.slice(0, 10); const end = head.period_end.slice(0, 10)

    const rows = await c.db.prepare(`
      SELECT st.id AS student_id, ${name2('st')} AS name, st.admission_no, st.admission_date, st.exit_date,
             e.class_id, cl.name AS class_name, cl.level,
             rr.annual_rate_paise AS rate,
             (SELECT fc.id FROM fee_concessions fc WHERE fc.student_id = st.id AND fc.academic_year_id = ?2 AND fc.kind = 'rte' ORDER BY fc.created_at DESC LIMIT 1) AS concession_id
        FROM students st
        JOIN enrollments e ON e.student_id = st.id AND e.academic_year_id = ?2 AND e.status <> 'moved'
        JOIN classes cl ON cl.id = e.class_id
        LEFT JOIN reimbursement_rates rr ON rr.scheme_id = ?5 AND rr.academic_year_id = ?2 AND cl.level BETWEEN rr.from_level AND rr.to_level
       WHERE st.institution_id = ?1
         AND st.is_rte
         AND st.admission_date <= ?4
         AND (st.exit_date IS NULL OR st.exit_date >= ?3)
       ORDER BY cl.level, st.first_name`).bind(inst(c), head.academic_year_id, start, end, head.scheme_id).all<Record<string, unknown>>()
    const existing = await c.db.prepare(`SELECT student_id FROM reimbursement_claim_lines WHERE claim_id = ?`).bind(claimId).all<{ student_id: string }>()
    const onClaim = new Set(existing.results.map((x) => x.student_id))

    let added = 0; let already = 0
    const skipped: { student_name: string; admission_no: string; class_name: string; why: string }[] = []
    const stmts: D1PreparedStatement[] = []
    const seen = new Set<string>()
    for (const x of rows.results) {
      const sid = String(x.student_id)
      if (x.rate === null || x.rate === undefined) {
        skipped.push({ student_name: str(x.name), admission_no: str(x.admission_no), class_name: str(x.class_name), why: `no rate notified for class level ${Number(x.level)} in this year` })
        continue
      }
      if (onClaim.has(sid) || seen.has(sid)) { already++; continue }
      seen.add(sid)
      const from = str(x.admission_date).slice(0, 10) > start ? str(x.admission_date).slice(0, 10) : start
      const exit = x.exit_date ? str(x.exit_date).slice(0, 10) : end
      const to = exit < end ? exit : end
      const months = Math.min(12, monthsOnRoll(from, to))
      const rate = p(x.rate)
      stmts.push(c.db.prepare(`
        INSERT OR IGNORE INTO reimbursement_claim_lines (id, institution_id, claim_id, student_id, class_id, class_level, rate_paise, months, claimed_paise, concession_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst(c), claimId, sid, x.class_id ?? null, Number(x.level), rate, months, prorataPaise(rate, months), x.concession_id ?? null, now()))
      added++
    }
    if (stmts.length) { stmts.push(claimTotalsStmt(c, claimId)); await c.db.batch(stmts) }
    return ok({ added, already_on_claim: already, skipped })
  }))

  r.del('/finance/concessions/claims/{id}/lines/{lineID}', WRITE, fin(async (c) => {
    const claimId = uuidParam(c.params.id)
    const lineId = uuidParam(c.params.lineID, 'lineID')
    const status = await claimStatus(c, claimId)
    if (status !== 'draft') throw refusal(`this claim was ${status}; a child cannot be removed from what the department has already been sent`)
    const line = await c.db.prepare(`SELECT id FROM reimbursement_claim_lines WHERE id = ? AND claim_id = ? AND institution_id = ?`).bind(lineId, claimId, inst(c)).first()
    if (!line) throw notFound()
    await c.db.batch([
      c.db.prepare(`DELETE FROM reimbursement_claim_lines WHERE id = ? AND claim_id = ? AND institution_id = ?`).bind(lineId, claimId, inst(c)),
      claimTotalsStmt(c, claimId),
    ])
    return ok({ removed: true })
  }))

  r.post('/finance/concessions/claims/{id}/receipts', WRITE, fin(async (c) => {
    const claimId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const amount = paise(req.amount_paise)
    if (amount <= 0) throw badRequest('how much was released?')
    const on = requiredISODay(req.received_on, 'received_on')
    let mode = str(req.mode).trim(); if (mode === '') mode = 'neft'
    if (!['neft', 'rtgs', 'cheque', 'dd', 'adjustment'].includes(mode)) throw badRequest('mode must be neft, rtgs, cheque, dd or adjustment')
    const status = await claimStatus(c, claimId)
    if (status === 'draft') throw refusal('this claim has not been submitted; money against it would be money for something nobody has asked for')
    const reference = nullString(req.reference_no)
    // reimbursement_receipts_no_duplicate (institution_id, claim_id, received_on, amount_paise, lower(btrim(COALESCE(reference_no,''))))
    const dup = await c.db.prepare(`
      SELECT id FROM reimbursement_receipts WHERE institution_id = ? AND claim_id = ? AND received_on = ? AND amount_paise = ? AND lower(trim(COALESCE(reference_no, ''))) = lower(trim(?))`)
      .bind(inst(c), claimId, on, amount, reference ?? '').first()
    if (dup) throw conflictCode('duplicate_receipt', 'a release of that amount, on that date, with that reference is already recorded against this claim')
    const id = uuid()
    await c.db.batch([
      c.db.prepare(`
        INSERT INTO reimbursement_receipts (id, institution_id, claim_id, received_on, amount_paise, mode, reference_no, treasury_voucher, bank_account_id, notes, recorded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst(c), claimId, on, amount, mode, reference, nullString(req.treasury_voucher), nullUUIDText(req.bank_account_id), nullString(req.notes), c.id.userId, now()),
      claimReceivedStmt(c, claimId),
    ])
    return ok({ id })
  }))

  r.post('/finance/concessions/claims/{id}/submit', APPROVE, fin(async (c) => {
    const claimId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    let on = today()
    if (str(req.submitted_on).trim() !== '') on = requiredISODay(req.submitted_on, 'submitted_on')
    const head = await c.db.prepare(`SELECT status, child_count, claimed_paise FROM reimbursement_claims WHERE id = ? AND institution_id = ?`)
      .bind(claimId, inst(c)).first<{ status: string; child_count: number; claimed_paise: number }>()
    if (!head) throw notFound()
    if (head.status !== 'draft') throw refusal(`this claim has already been ${head.status}`)
    if (Number(head.child_count) === 0 || p(head.claimed_paise) === 0) {
      throw refusal('there are no children on this claim; assemble it before submitting, or it will age as a debt nobody is owed')
    }
    await c.db.prepare(`UPDATE reimbursement_claims SET status = 'submitted', submitted_on = ?3, submitted_ref = ?4, updated_at = ?5 WHERE id = ?1 AND institution_id = ?2`)
      .bind(claimId, inst(c), on, nullString(req.submitted_ref), now()).run()
    return ok({ status: 'submitted' })
  }))

  r.post('/finance/concessions/claims/{id}/sanction', APPROVE, fin(async (c) => {
    const claimId = uuidParam(c.params.id)
    const req = await readJSON<{ sanction_order_no?: unknown; sanction_on?: unknown; rejected_reason?: unknown; lines?: unknown; notes?: unknown }>(c.req)
    const orderNo = str(req.sanction_order_no).trim()
    if (orderNo === '') throw badRequest('what is the sanction order number?')
    let on = today()
    if (str(req.sanction_on).trim() !== '') on = requiredISODay(req.sanction_on, 'sanction_on')

    const status = await claimStatus(c, claimId)
    if (status === 'draft') throw refusal('this claim has not been submitted yet')
    if (status === 'closed') throw refusal('this claim is closed; reopen it before recording another order')

    const all = await c.db.prepare(`SELECT id, claimed_paise FROM reimbursement_claim_lines WHERE claim_id = ? AND institution_id = ?`).bind(claimId, inst(c)).all<{ id: string; claimed_paise: number }>()
    const claimedBy = new Map(all.results.map((l) => [l.id, p(l.claimed_paise)]))

    // Silence on the order means allowed in full.
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`UPDATE reimbursement_claim_lines SET sanctioned_paise = claimed_paise, disallowed_reason = NULL WHERE claim_id = ? AND institution_id = ?`).bind(claimId, inst(c)),
    ]
    const sanctionedBy = new Map(claimedBy)
    const lines = Array.isArray(req.lines) ? (req.lines as Record<string, unknown>[]) : []
    for (const ln of lines) {
      const lid = str(ln.line_id).trim()
      if (!isUUID(lid)) throw refusal('malformed line id in the sanction')
      const sanctioned = paise(ln.sanctioned_paise, 'sanctioned_paise')
      if (sanctioned < 0) throw refusal('a sanctioned amount cannot be negative')
      const claimed = claimedBy.get(lid)
      if (claimed === undefined) throw notFound()
      if (sanctioned > claimed) throw refusal('a department cannot sanction more for a child than was claimed; if the claim was understated, revise the claim')
      const reason = str(ln.disallowed_reason).trim()
      if (sanctioned < claimed && reason === '') throw refusal('the order gave this child less than was claimed, record the reason it names, or there is nothing to appeal with')
      sanctionedBy.set(lid, sanctioned)
      stmts.push(c.db.prepare(`UPDATE reimbursement_claim_lines SET sanctioned_paise = ?4, disallowed_reason = ?5 WHERE id = ?1 AND claim_id = ?2 AND institution_id = ?3`)
        .bind(lid, claimId, inst(c), sanctioned, nullString(reason)))
    }
    stmts.push(claimTotalsStmt(c, claimId))

    // The roll-up's arithmetic, computed here from the same lines so the status is one answer.
    let claimed = 0; let sanctioned = 0
    for (const [id, cl] of claimedBy) { claimed += cl; sanctioned += sanctionedBy.get(id) ?? 0 }
    const outStatus = sanctioned === 0 ? 'rejected' : sanctioned < claimed ? 'part_sanctioned' : 'sanctioned'
    let rejected = str(req.rejected_reason).trim()
    if (outStatus === 'rejected' && rejected === '') rejected = 'the sanction order allowed nothing against this claim'
    if (outStatus !== 'rejected') rejected = ''
    stmts.push(c.db.prepare(`
      UPDATE reimbursement_claims
         SET status = ?3, sanction_order_no = ?4, sanction_on = ?5, rejected_reason = ?6, notes = COALESCE(?7, notes), updated_at = ?8
       WHERE id = ?1 AND institution_id = ?2`).bind(claimId, inst(c), outStatus, orderNo, on, nullString(rejected), nullString(req.notes), now()))
    await c.db.batch(stmts)
    return ok({ status: outStatus })
  }))

  // exportClaimFile: every child's name, class and social category in one CSV.
  r.get('/finance/concessions/claims/{id}/file', EXPORT, fin(async (c) => {
    const claimId = c.params.id
    if (!isUUID(claimId)) throw badRequest('malformed claim id')
    const head = await c.db.prepare(`
      SELECT c.claim_no, substr(c.period_start, 1, 10) AS period_start
        FROM reimbursement_claims c JOIN government_aid_schemes sc ON sc.id = c.scheme_id
       WHERE c.id = ? AND c.institution_id = ?`).bind(claimId, inst(c)).first<{ claim_no: string; period_start: string }>()
    if (!head) throw notFound()
    const rows = await c.db.prepare(`
      SELECT st.admission_no, ${name2('st')} AS name, COALESCE(cl.name,'') AS class, COALESCE(st.category,'') AS category,
             COALESCE(substr(st.date_of_birth, 1, 10),'') AS dob, l.months, l.rate_paise, l.claimed_paise
        FROM reimbursement_claim_lines l
        JOIN students st ON st.id = l.student_id
        LEFT JOIN classes cl ON cl.id = l.class_id
       WHERE l.claim_id = ? AND l.institution_id = ?
       ORDER BY cl.level NULLS LAST, st.first_name`).bind(claimId, inst(c)).all<Record<string, unknown>>()
    const f = claimFile(str(head.claim_no), str(head.period_start), rows.results.map((v) => ({
      admission: str(v.admission_no), name: str(v.name), class: str(v.class), category: str(v.category), dob: str(v.dob),
      months: Number(v.months ?? 0), rate: p(v.rate_paise), claimed: p(v.claimed_paise),
    })))
    return new Response(f.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename=${goQuote(f.filename)}`,
        'X-Claim-Submission': 'not-attempted: no state submission API is configured; upload or print this file',
      },
    })
  }))

  // ============================================ NSP scholarship reconciliation
  r.get('/finance/concessions/scholarships', READ, fin(async (c) => {
    const q = c.url.searchParams
    const search = nullString(q.get('q'))
    const rows = await c.db.prepare(`
      SELECT a.id, a.scheme_id, sc.name AS scheme_name, a.student_id, ${name2('st')} AS student_name, st.admission_no,
             (SELECT cl.name FROM enrollments e JOIN classes cl ON cl.id = e.class_id WHERE e.student_id = st.id AND e.academic_year_id = a.academic_year_id LIMIT 1) AS class_name,
             st.status AS student_status, a.academic_year_id, ay.name AS academic_year,
             a.application_ref, a.stage, a.verified_at, vu.full_name AS verified_by,
             a.rejected_reason, a.expected_paise, a.sanctioned_paise, a.credited_paise, a.credited_on,
             sba.id AS sba_id, length(sba.account_number) AS acct_len, substr(sba.account_number, -4) AS acct_last4,
             COALESCE(sba.is_aadhaar_seeded, 0) AS is_aadhaar_seeded,
             a.offsets_fees, (a.fee_credit_payment_id IS NOT NULL) AS fee_credited, a.notes, st.category
        FROM scholarship_awards a
        JOIN government_aid_schemes sc ON sc.id = a.scheme_id
        JOIN students st ON st.id = a.student_id
        JOIN academic_years ay ON ay.id = a.academic_year_id
        LEFT JOIN users vu ON vu.id = a.verified_by
        LEFT JOIN student_bank_accounts sba ON sba.id = COALESCE(a.bank_account_id, (SELECT pb.id FROM student_bank_accounts pb WHERE pb.student_id = a.student_id AND pb.is_primary LIMIT 1))
       WHERE (?1 IS NULL OR a.scheme_id = ?1)
         AND (?2 IS NULL OR a.academic_year_id = ?2)
         AND (?3 IS NULL OR a.stage = ?3)
         AND (?4 IS NULL OR st.admission_no LIKE ?5 ESCAPE '\\' OR ${name2('st')} LIKE ?5 ESCAPE '\\' OR a.application_ref LIKE ?5 ESCAPE '\\')
       ORDER BY st.first_name
       LIMIT ?6`)
      .bind(nullUUIDText(q.get('scheme_id')), nullUUIDText(q.get('academic_year_id')), nullString(q.get('stage')), search, search === null ? null : like(search),
        clampInt(q.get('limit'), 300, 1, 1000)).all<Record<string, unknown>>()
    return ok(items(rows.results.map((x) => {
      const hasAccount = x.sba_id !== null && x.sba_id !== undefined
      const masked = hasAccount ? '•'.repeat(Math.max(Number(x.acct_len ?? 0) - 4, 0)) + str(x.acct_last4) : null
      const v = {
        id: x.id, scheme_id: x.scheme_id, scheme_name: x.scheme_name, student_id: x.student_id, student_name: x.student_name, admission_no: x.admission_no,
        class_name: x.class_name ?? null, student_status: str(x.student_status), academic_year_id: x.academic_year_id, academic_year: x.academic_year,
        application_ref: x.application_ref ?? null, stage: str(x.stage), verified_at: tsZ(x.verified_at), verified_by: x.verified_by ?? null,
        rejected_reason: x.rejected_reason ?? null, expected_paise: optInt(x.expected_paise), sanctioned_paise: optInt(x.sanctioned_paise),
        credited_paise: p(x.credited_paise), credited_on: day(x.credited_on),
        account_masked: masked, has_account: hasAccount, is_aadhaar_seeded: bool(x.is_aadhaar_seeded),
        offsets_fees: bool(x.offsets_fees), fee_credited: bool(x.fee_credited), notes: x.notes ?? null, category: x.category ?? null,
        exception: '',
      }
      v.exception = awardException(v)
      const out = omit(v as unknown as Record<string, unknown>, ['class_name', 'application_ref', 'verified_at', 'verified_by', 'rejected_reason', 'expected_paise',
        'sanctioned_paise', 'credited_on', 'account_masked', 'notes', 'category'])
      if (out.exception === '') delete out.exception
      return out
    })))
  }))

  r.post('/finance/concessions/scholarships', WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const scheme = nullUUIDText(req.scheme_id); if (!scheme) throw badRequest('which scheme is this application under?')
    const student = nullUUIDText(req.student_id); if (!student) throw badRequest('which child is this for?')
    const year = nullUUIDText(req.academic_year_id); if (!year) throw badRequest('which academic year?')
    let stage = str(req.stage).trim(); if (stage === '') stage = 'applied'
    switch (stage) {
      case 'applied': case 'school_rejected': case 'sanctioned': case 'withdrawn': case 'not_credited': break
      case 'school_verified': throw badRequest('verify the application from the verify action, so who verified it is recorded')
      case 'credited': throw badRequest("a credit is recorded by importing the portal's disbursement list, not by hand")
      default: throw badRequest('unknown stage: ' + stage)
    }
    if (stage === 'school_rejected' && str(req.rejected_reason).trim() === '') throw badRequest('why is the school refusing to verify this application?')
    const expected = req.expected_paise === null || req.expected_paise === undefined ? null : paise(req.expected_paise, 'expected_paise')
    const sanctioned = req.sanctioned_paise === null || req.sanctioned_paise === undefined ? null : paise(req.sanctioned_paise, 'sanctioned_paise')
    if (stage === 'sanctioned' && sanctioned === null) throw badRequest('how much did the portal sanction?')

    const sc = await c.db.prepare(`SELECT paid_to FROM government_aid_schemes WHERE id = ? AND institution_id = ?`).bind(scheme, inst(c)).first<{ paid_to: string }>()
    if (!sc) throw notFound()
    if (sc.paid_to !== 'student') throw refusal('this scheme reimburses the school, not the child; it belongs on the reimbursement claims screen')

    const rid = str(req.id).trim()
    if (rid !== '' && !isUUID(rid)) throw refusal('malformed award id')
    const id = rid || uuid()
    const appRef = nullString(req.application_ref)
    const dupMsg = 'this child already has an application recorded under that scheme for that year, or that application reference is already in use'
    // scholarship_awards_one_per_child is a real index; one_per_ref (partial, lower(btrim)) is not.
    const dupChild = await c.db.prepare(`SELECT id FROM scholarship_awards WHERE institution_id = ? AND scheme_id = ? AND student_id = ? AND academic_year_id = ? AND id <> ?`)
      .bind(inst(c), scheme, student, year, id).first()
    if (dupChild) throw conflictCode('duplicate_award', dupMsg)
    if (appRef && appRef.trim() !== '') {
      const dupRef = await c.db.prepare(`SELECT id FROM scholarship_awards WHERE institution_id = ? AND scheme_id = ? AND application_ref IS NOT NULL AND lower(trim(application_ref)) = lower(trim(?)) AND id <> ?`)
        .bind(inst(c), scheme, appRef, id).first()
      if (dupRef) throw conflictCode('duplicate_award', dupMsg)
    }
    if (rid !== '') {
      const res = await c.db.prepare(`
        UPDATE scholarship_awards
           SET scheme_id = ?3, student_id = ?4, academic_year_id = ?5, application_ref = ?6, stage = ?7, expected_paise = ?8, sanctioned_paise = ?9,
               bank_account_id = ?10, offsets_fees = ?11, rejected_reason = ?12, notes = ?13, updated_at = ?14
         WHERE id = ?1 AND institution_id = ?2 AND stage <> 'credited'`)
        .bind(rid, inst(c), scheme, student, year, appRef, stage, expected, sanctioned, nullUUIDText(req.bank_account_id), req.offsets_fees === true ? 1 : 0,
          nullString(req.rejected_reason), nullString(req.notes), now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: rid })
    }
    await c.db.prepare(`
      INSERT INTO scholarship_awards (id, institution_id, scheme_id, student_id, academic_year_id, application_ref, stage, expected_paise, sanctioned_paise,
                                      bank_account_id, offsets_fees, rejected_reason, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), scheme, student, year, appRef, stage, expected, sanctioned, nullUUIDText(req.bank_account_id), req.offsets_fees === true ? 1 : 0,
        nullString(req.rejected_reason), nullString(req.notes), c.id.userId, now(), now()).run()
    return ok({ id })
  }))

  r.post('/finance/concessions/scholarships/{id}/verify', WRITE, fin(async (c) => {
    const awardId = uuidParam(c.params.id)
    const res = await c.db.prepare(`
      UPDATE scholarship_awards SET stage = 'school_verified', verified_by = ?3, verified_at = ?4, rejected_reason = NULL, updated_at = ?4
       WHERE id = ?1 AND institution_id = ?2 AND stage IN ('applied','school_rejected')`).bind(awardId, inst(c), c.id.userId, now()).run()
    if (!res.meta.changes) throw refusal('only an application still waiting on the school can be verified')
    return ok({ stage: 'school_verified' })
  }))

  /* creditScholarshipToFees: the credit goes onto the fee ledger through the
     same path as the counter (receipt series, oldest-first allocation, the
     invoice and payment sync triggers), as an adjustment payment. */
  r.post('/finance/concessions/scholarships/{id}/fee-credit', WRITE, fin(async (c) => {
    const awardId = uuidParam(c.params.id)
    const a = await c.db.prepare(`
      SELECT a.student_id, a.stage, a.credited_paise, a.offsets_fees, a.fee_credit_payment_id, a.application_ref, sc.name AS scheme_name
        FROM scholarship_awards a JOIN government_aid_schemes sc ON sc.id = a.scheme_id
       WHERE a.id = ? AND a.institution_id = ?`).bind(awardId, inst(c))
      .first<{ student_id: string; stage: string; credited_paise: number; offsets_fees: number; fee_credit_payment_id: string | null; application_ref: string | null; scheme_name: string }>()
    if (!a) throw notFound()
    const credited = p(a.credited_paise)
    if (!bool(a.offsets_fees)) throw refusal("this scholarship reaches the parent as cash; posting it against the school's fees would credit the child for money the school never received")
    if (a.stage !== 'credited' || credited <= 0) throw refusal("nothing has been credited under this award yet; import the portal's disbursement list first")
    if (a.fee_credit_payment_id) throw refusal('this credit has already been posted to the fee ledger')

    const st = await c.db.prepare(`SELECT institution_id, campus_id FROM students WHERE id = ?`).bind(a.student_id).first<{ institution_id: string; campus_id: string }>()
    if (!st) throw notFound()
    let remark = 'Scholarship credit: ' + a.scheme_name
    if (a.application_ref && a.application_ref.trim() !== '') remark += ' (' + a.application_ref.trim() + ')'

    const paidOn = today()
    const number = await nextNumber(c, 'receipt', paidOn)
    const paymentId = uuid()
    const stmts: D1PreparedStatement[] = [
      ...number.stmts,
      c.db.prepare(`INSERT INTO payments (id, institution_id, campus_id, student_id, receipt_no, receipt_seq, receipt_fy, amount_paise, allocated_paise, mode, paid_on,
                      reference_no, bank_name, cheque_date, status, collected_by, remarks, payer_name, payer_relation, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, 0, 'adjustment', ?, NULL, NULL, NULL, 'success', ?, ?, NULL, NULL, ?)`)
        .bind(paymentId, st.institution_id, st.campus_id, a.student_id, number.text, number.seq, number.fy, credited, paidOn, c.id.userId, remark, now()),
    ]
    // fees.allocate + sync_invoice_paid + sync_payment_allocated.
    const alloc = await allocate(c, a.student_id, paymentId, credited, [])
    stmts.push(...alloc.stmts)
    stmts.push(c.db.prepare(`UPDATE scholarship_awards SET fee_credit_payment_id = ?3, updated_at = ?4 WHERE id = ?1 AND institution_id = ?2`).bind(awardId, inst(c), paymentId, now()))
    try { await c.db.batch(stmts) } catch (e) {
      if (isBatchGuardFailure(e)) throw new HttpError(409, 'another receipt was issued at the same moment; try again')
      throw e
    }
    return created({
      payment_id: paymentId, receipt_no: number.text, amount_paise: credited, unallocated: alloc.unallocated,
      allocated_count: alloc.allocated.length, cleared_all_dues: true,
    })
  }))

  r.get('/finance/concessions/scholarships/imports', READ, fin(async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(`
      SELECT i.id, i.scheme_id, sc.name AS scheme_name, ay.name AS academic_year, i.filename, i.source,
             i.row_count, i.matched_count, i.unmatched_count, i.rejected_count, i.credited_paise, i.imported_at, u.full_name AS imported_by
        FROM scholarship_disbursement_imports i
        JOIN government_aid_schemes sc ON sc.id = i.scheme_id
        JOIN academic_years ay ON ay.id = i.academic_year_id
        LEFT JOIN users u ON u.id = i.imported_by
       WHERE (?1 IS NULL OR i.scheme_id = ?1)
       ORDER BY i.imported_at DESC LIMIT ?2`).bind(nullUUIDText(q.get('scheme_id')), clampInt(q.get('limit'), 50, 1, 200)).all<Record<string, unknown>>()
    return ok(items(rows.results.map(importView)))
  }))

  // importScholarshipDisbursements: the portal's disbursement list, the raw
  // CSV as the body (text/csv). Two exact matching passes, no fuzzy one.
  r.post('/finance/concessions/scholarships/imports', WRITE, fin(async (c) => {
    const q = c.url.searchParams
    const scheme = (q.get('scheme_id') ?? '').trim()
    if (!isUUID(scheme)) throw badRequest('which scheme is this disbursement list for?')
    const year = (q.get('academic_year_id') ?? '').trim()
    if (!isUUID(year)) throw badRequest('which academic year does this list cover?')
    const filename = (q.get('filename') ?? '').trim() || 'disbursements.csv'
    let source = (q.get('source') ?? '').trim()
    if (source === '') source = 'nsp_portal_csv'
    else if (!['nsp_portal_csv', 'state_portal_csv', 'manual'].includes(source)) throw badRequest('source must be nsp_portal_csv, state_portal_csv or manual')
    let raw: ArrayBuffer
    try { raw = await c.req.arrayBuffer() } catch { throw badRequest('could not read the uploaded file') }
    if (raw.byteLength > 8 << 20) throw badRequest('could not read the uploaded file')
    const text = decodeBody(raw)
    if (goTrimSpace(text) === '') throw badRequest('the uploaded file is empty')

    const { cols, parsed, rejects } = parseDisbursements(text)
    if (!cols) {
      throw badRequest('no header row was recognised. The file needs a row naming an amount '
        + 'column and either an application id or an admission number')
    }

    // Every award of the scheme, read once; the passes below are the two
    // QueryRow lookups the Go loop made per line, applied to this snapshot and
    // to the writes the loop itself made (sanctioned_paise fills in as it goes).
    const awards = (await c.db.prepare(`
      SELECT a.id, a.application_ref, a.academic_year_id, a.sanctioned_paise, st.admission_no, st.status
        FROM scholarship_awards a JOIN students st ON st.id = a.student_id
       WHERE a.institution_id = ? AND a.scheme_id = ? ORDER BY a.rowid`).bind(inst(c), scheme).all<{
        id: string; application_ref: string | null; academic_year_id: string; sanctioned_paise: number | null; admission_no: string | null; status: string
      }>()).results
    const btrimLower = (v: string | null) => (v ?? '').replace(/^ +| +$/g, '').toLowerCase()
    const byRef = new Map<string, typeof awards[number]>(); const byAdm = new Map<string, typeof awards[number]>()
    for (const a of awards) {
      if (a.application_ref !== null) { const k = btrimLower(a.application_ref); if (!byRef.has(k)) byRef.set(k, a) }
      if (a.academic_year_id === year && a.admission_no !== null) { const k = btrimLower(a.admission_no); if (!byAdm.has(k)) byAdm.set(k, a) }
    }
    const sanctioned = new Map<string, number | null>(awards.map((a) => [a.id, a.sanctioned_paise === null ? null : Number(a.sanctioned_paise)]))

    const importID = uuid()
    const out = {
      import_id: importID, row_count: 0, matched_count: 0, unmatched_count: 0, rejected_count: rejects.length,
      credited_paise: 0, exceptions: {} as Record<string, number>, rejects: rejects.length ? rejects : null,
    }
    const awardUpdates: D1PreparedStatement[] = []
    const lineRows: Record<string, unknown>[] = []
    const seenRef = new Set<string>()
    const stamp = now()
    for (const pl of parsed) {
      out.row_count++
      out.credited_paise += pl.amount
      let award: typeof awards[number] | undefined
      let matchKind = 'unmatched'
      let exception: string | null = null
      const refKey = goTrimSpace(pl.appRef).toLowerCase()
      if (refKey !== '' && seenRef.has(refKey)) exception = 'duplicate'
      if (refKey !== '') seenRef.add(refKey)
      // Pass one: the portal's own reference, any year of this scheme.
      if (pl.appRef !== '') { award = byRef.get(btrimLower(pl.appRef)); if (award) matchKind = 'application_ref' }
      // Pass two: the admission number, within this scheme and year.
      if (!award && pl.admission !== '') { award = byAdm.get(btrimLower(pl.admission)); if (award) matchKind = 'admission_no' }
      if (!award) {
        out.unmatched_count++
        if (exception === null) exception = 'no_award'
      } else {
        out.matched_count++
        const sanc = sanctioned.get(award.id) ?? null
        if (exception === null) {
          if (award.status !== 'active') exception = 'student_left'
          else if (sanc !== null && sanc !== pl.amount) exception = 'amount_differs'
        }
        if (sanc === null) sanctioned.set(award.id, pl.amount)
        awardUpdates.push(c.db.prepare(`
          UPDATE scholarship_awards
             SET credited_paise = ?3, credited_on = ?4,
                 stage = CASE WHEN ?3 > 0 THEN 'credited' ELSE stage END,
                 sanctioned_paise = COALESCE(sanctioned_paise, ?3),
                 updated_at = ?5
           WHERE id = ?1 AND institution_id = ?2`).bind(award.id, inst(c), pl.amount, pl.credited ?? today(), stamp))
      }
      if (exception !== null) out.exceptions[exception] = (out.exceptions[exception] ?? 0) + 1
      lineRows.push({
        n: pl.lineNo, r: nullString(pl.appRef), s: nullString(pl.name), m: nullString(pl.admission), a: pl.amount, d: pl.credited,
        b: nullString(pl.bankRef), l: nullString(pl.last4), p: nullString(pl.stat), w: award?.id ?? null, k: matchKind, e: exception,
        x: nullString(pl.rawLine),
      })
    }
    // encoding/json writes map keys sorted.
    out.exceptions = Object.fromEntries(Object.keys(out.exceptions).sort().map((k) => [k, out.exceptions[k]]))

    const stmts: D1PreparedStatement[] = [c.db.prepare(`
      INSERT INTO scholarship_disbursement_imports
        (id, institution_id, scheme_id, academic_year_id, filename, source, imported_by, imported_at,
         row_count, matched_count, unmatched_count, rejected_count, credited_paise, rejects)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`)
      .bind(importID, inst(c), scheme, year, filename, source, c.id.userId, stamp, out.row_count, out.matched_count,
        out.unmatched_count, out.rejected_count, out.credited_paise, JSON.stringify(out.rejects)), ...awardUpdates]
    for (const ch of jsonChunks(lineRows)) {
      stmts.push(c.db.prepare(`
        INSERT INTO scholarship_disbursement_lines
          (id, institution_id, import_id, line_no, application_ref, student_name_given, admission_no_given, amount_paise, credited_on,
           bank_reference, account_last4, portal_status, award_id, match_kind, exception, raw_line, created_at)
        SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-'
                 || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
               ?1, ?2, json_extract(value, '$.n'), json_extract(value, '$.r'), json_extract(value, '$.s'), json_extract(value, '$.m'),
               json_extract(value, '$.a'), json_extract(value, '$.d'), json_extract(value, '$.b'), json_extract(value, '$.l'),
               json_extract(value, '$.p'), json_extract(value, '$.w'), json_extract(value, '$.k'), json_extract(value, '$.e'),
               json_extract(value, '$.x'), ?3
          FROM json_each(?4)`).bind(inst(c), importID, stamp, ch))
    }
    try { await c.db.batch(stmts) } catch (e) {
      // concessionWriteResult -> ledgerRefusal for a foreign key (unknown scheme or year).
      if (isForeignKeyViolation(e)) throw badRequest('that refers to something which does not exist')
      throw e
    }
    return created(out)
  }))

  r.get('/finance/concessions/scholarships/imports/{id}', READ, fin(async (c) => {
    const importId = uuidParam(c.params.id)
    const head = await c.db.prepare(`
      SELECT i.id, i.scheme_id, sc.name AS scheme_name, ay.name AS academic_year, i.filename, i.source,
             i.row_count, i.matched_count, i.unmatched_count, i.rejected_count, i.credited_paise, i.imported_at, u.full_name AS imported_by, i.rejects
        FROM scholarship_disbursement_imports i
        JOIN government_aid_schemes sc ON sc.id = i.scheme_id
        JOIN academic_years ay ON ay.id = i.academic_year_id
        LEFT JOIN users u ON u.id = i.imported_by
       WHERE i.id = ? AND i.institution_id = ?`).bind(importId, inst(c)).first<Record<string, unknown>>()
    if (!head) throw notFound()
    let rejects: unknown[] = []
    try { const parsed = JSON.parse(str(head.rejects) || '[]'); if (Array.isArray(parsed)) rejects = parsed } catch { rejects = [] }
    const rows = await c.db.prepare(`
      SELECT dl.id, dl.line_no, dl.application_ref, dl.student_name_given, dl.admission_no_given, dl.amount_paise, dl.credited_on, dl.bank_reference,
             dl.account_last4, dl.portal_status, dl.match_kind, dl.exception, dl.award_id,
             CASE WHEN st.id IS NULL THEN NULL ELSE ${name2('st')} END AS student_name, st.admission_no
        FROM scholarship_disbursement_lines dl
        LEFT JOIN scholarship_awards a ON a.id = dl.award_id
        LEFT JOIN students st ON st.id = a.student_id
       WHERE dl.import_id = ? AND dl.institution_id = ?
       ORDER BY (dl.exception IS NULL), dl.line_no`).bind(importId, inst(c)).all<Record<string, unknown>>()
    return ok({
      import: importView(head),
      lines: rows.results.map((x) => omit({
        id: x.id, line_no: Number(x.line_no), application_ref: x.application_ref ?? null, student_name_given: x.student_name_given ?? null,
        admission_no_given: x.admission_no_given ?? null, amount_paise: p(x.amount_paise), credited_on: day(x.credited_on), bank_reference: x.bank_reference ?? null,
        account_last4: x.account_last4 ?? null, portal_status: x.portal_status ?? null, match_kind: str(x.match_kind), exception: x.exception ?? null,
        award_id: x.award_id ?? null, student_name: x.student_name ?? null, admission_no: x.admission_no ?? null,
      }, ['application_ref', 'student_name_given', 'admission_no_given', 'credited_on', 'bank_reference', 'account_last4', 'portal_status', 'exception', 'award_id', 'student_name', 'admission_no'])),
      rejects,
    })
  }))

  r.post('/finance/concessions/scholarships/lines/{id}/match', WRITE, fin(async (c) => {
    const lineId = uuidParam(c.params.id)
    const req = await readJSON<{ award_id?: unknown }>(c.req)
    const award = nullUUIDText(req.award_id)
    if (!award) throw badRequest('which application does this row belong to?')
    const line = await c.db.prepare(`SELECT amount_paise, credited_on, award_id FROM scholarship_disbursement_lines WHERE id = ? AND institution_id = ?`)
      .bind(lineId, inst(c)).first<{ amount_paise: number; credited_on: string | null; award_id: string | null }>()
    if (!line) throw notFound()
    if (line.award_id) throw refusal('this row is already matched')
    const a = await c.db.prepare(`SELECT st.status, a.sanctioned_paise FROM scholarship_awards a JOIN students st ON st.id = a.student_id WHERE a.id = ? AND a.institution_id = ?`)
      .bind(award, inst(c)).first<{ status: string; sanctioned_paise: number | null }>()
    if (!a) throw notFound()
    const amount = p(line.amount_paise)
    let exception: string | null = null
    if (a.status !== 'active') exception = 'student_left'
    else if (a.sanctioned_paise !== null && a.sanctioned_paise !== undefined && p(a.sanctioned_paise) !== amount) exception = 'amount_differs'
    const creditedOn = line.credited_on ? line.credited_on.slice(0, 10) : today()
    await c.db.batch([
      c.db.prepare(`UPDATE scholarship_disbursement_lines SET award_id = ?3, match_kind = 'manual', exception = ?4 WHERE id = ?1 AND institution_id = ?2`).bind(lineId, inst(c), award, exception),
      c.db.prepare(`
        UPDATE scholarship_awards
           SET credited_paise = ?3, credited_on = ?4,
               stage = CASE WHEN ?3 > 0 THEN 'credited' ELSE stage END,
               sanctioned_paise = COALESCE(sanctioned_paise, ?3), updated_at = ?5
         WHERE id = ?1 AND institution_id = ?2`).bind(award, inst(c), amount, creditedOn, now()),
    ])
    return ok({ matched: true })
  }))

  // ============================================= education loan assistance
  r.get('/finance/concessions/loans/lenders', READ, fin(async (c) => {
    const active = nullBool(c.url.searchParams.get('active'))
    const rows = await c.db.prepare(`
      SELECT l.id, l.name, l.lender_kind, l.branch, l.contact_name, l.contact_phone, l.contact_email, l.is_active, l.notes,
             (SELECT count(*) FROM education_loan_applications ap WHERE ap.lender_id = l.id AND ap.status IN ('documents_pending','submitted_to_lender','under_review')) AS open_count
        FROM education_loan_lenders l
       WHERE (?1 IS NULL OR l.is_active = ?1)
       ORDER BY l.is_active DESC, l.name, l.branch`).bind(active === null ? null : active ? 1 : 0).all<Record<string, unknown>>()
    return ok(items(rows.results.map((x) => omit({
      id: x.id, name: x.name, lender_kind: x.lender_kind, branch: x.branch ?? null, contact_name: x.contact_name ?? null, contact_phone: x.contact_phone ?? null,
      contact_email: x.contact_email ?? null, is_active: bool(x.is_active), notes: x.notes ?? null, open_count: Number(x.open_count),
    }, ['branch', 'contact_name', 'contact_phone', 'contact_email', 'notes']))))
  }))

  r.post('/finance/concessions/loans/lenders', WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name).trim()
    if (name === '') throw badRequest('what is the lender called?')
    let kind = str(req.lender_kind).trim(); if (kind === '') kind = 'public_sector_bank'
    if (!['public_sector_bank', 'private_bank', 'nbfc', 'cooperative', 'other'].includes(kind)) {
      throw badRequest('lender kind must be public_sector_bank, private_bank, nbfc, cooperative or other')
    }
    const active = typeof req.is_active === 'boolean' ? req.is_active : true
    const rid = str(req.id).trim()
    if (rid !== '' && !isUUID(rid)) throw refusal('malformed lender id')
    const id = rid || uuid()
    const branch = nullString(req.branch)
    // education_loan_lenders_one_per_branch (institution_id, lower(btrim(name)), lower(btrim(COALESCE(branch,''))))
    const dup = await c.db.prepare(`SELECT id FROM education_loan_lenders WHERE institution_id = ? AND lower(trim(name)) = lower(trim(?)) AND lower(trim(COALESCE(branch, ''))) = lower(trim(?)) AND id <> ?`)
      .bind(inst(c), name, branch ?? '', id).first()
    if (dup) throw conflictCode('duplicate_lender', 'that lender and branch is already on the list')
    if (rid !== '') {
      const res = await c.db.prepare(`
        UPDATE education_loan_lenders
           SET name = ?3, lender_kind = ?4, branch = ?5, contact_name = ?6, contact_phone = ?7, contact_email = ?8, is_active = ?9, notes = ?10, updated_at = ?11
         WHERE id = ?1 AND institution_id = ?2`)
        .bind(rid, inst(c), name, kind, branch, nullString(req.contact_name), nullString(req.contact_phone), nullString(req.contact_email), active ? 1 : 0, nullString(req.notes), now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: rid })
    }
    await c.db.prepare(`
      INSERT INTO education_loan_lenders (id, institution_id, name, lender_kind, branch, contact_name, contact_phone, contact_email, is_active, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), name, kind, branch, nullString(req.contact_name), nullString(req.contact_phone), nullString(req.contact_email), active ? 1 : 0, nullString(req.notes), c.id.userId, now(), now()).run()
    return ok({ id })
  }))

  r.get('/finance/concessions/loans/applications', READ, fin(async (c) => {
    const q = c.url.searchParams
    const search = nullString(q.get('q'))
    const rows = await c.db.prepare(LOAN_SELECT(today()) + `
       WHERE (?1 IS NULL OR ap.status = ?1)
         AND (?2 IS NULL OR ap.lender_id = ?2)
         AND (?3 IS NULL OR st.admission_no LIKE ?4 ESCAPE '\\' OR ${name2('st')} LIKE ?4 ESCAPE '\\')
       ORDER BY ap.status_changed_on, st.first_name
       LIMIT ?5`)
      .bind(nullString(q.get('status')), nullUUIDText(q.get('lender_id')), search, search === null ? null : like(search), clampInt(q.get('limit'), 200, 1, 1000))
      .all<Record<string, unknown>>()
    return ok(items(rows.results.map(loanView)))
  }))

  r.post('/finance/concessions/loans/applications', WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const student = nullUUIDText(req.student_id); if (!student) throw badRequest('which child is this application for?')
    const sought = req.amount_sought_paise === null || req.amount_sought_paise === undefined ? null : paise(req.amount_sought_paise, 'amount_sought_paise')
    if (sought !== null && sought <= 0) throw badRequest('an amount sought has to be more than nothing')
    let opened = today()
    if (str(req.opened_on).trim() !== '') opened = requiredISODay(req.opened_on, 'opened_on')
    const lender = nullUUIDText(req.lender_id)
    const yearId = nullUUIDText(req.academic_year_id)
    const reference = nullString(req.reference_no)
    const rid = str(req.id).trim()
    if (rid !== '' && !isUUID(rid)) throw refusal('malformed application id')
    const id = rid || uuid()

    const dupMsg = 'this child already has a live application with that lender; continue that one rather than opening a second'
    // education_loan_applications_one_per_ref (partial): same lender (or none) and reference.
    if (reference && reference.trim() !== '') {
      const dupRef = await c.db.prepare(`SELECT id FROM education_loan_applications WHERE institution_id = ? AND COALESCE(lender_id, '') = COALESCE(?, '') AND reference_no IS NOT NULL AND lower(trim(reference_no)) = lower(trim(?)) AND id <> ?`)
        .bind(inst(c), lender, reference, id).first()
      if (dupRef) throw conflictCode('duplicate_application', dupMsg)
    }
    if (rid !== '') {
      // The live-application index also guards an edit that moves a live row onto another live one's lender.
      const cur = await c.db.prepare(`SELECT status FROM education_loan_applications WHERE id = ? AND institution_id = ?`).bind(rid, inst(c)).first<{ status: string }>()
      if (!cur) throw notFound()
      if (LOAN_LIVE.includes(cur.status)) {
        const dupLive = await c.db.prepare(`SELECT id FROM education_loan_applications WHERE institution_id = ? AND student_id = ? AND COALESCE(lender_id, '') = COALESCE(?, '') AND status IN ('enquiry','documents_pending','submitted_to_lender','under_review') AND id <> ?`)
          .bind(inst(c), student, lender, rid).first()
        if (dupLive) throw conflictCode('duplicate_application', dupMsg)
      }
      await c.db.prepare(`
        UPDATE education_loan_applications
           SET student_id = ?3, lender_id = ?4, academic_year_id = ?5, reference_no = ?6, opened_on = ?7, amount_sought_paise = ?8, notes = ?9, updated_at = ?10
         WHERE id = ?1 AND institution_id = ?2`).bind(rid, inst(c), student, lender, yearId, reference, opened, sought, nullString(req.notes), now()).run()
      return ok({ id: rid })
    }
    const dupLive = await c.db.prepare(`SELECT id FROM education_loan_applications WHERE institution_id = ? AND student_id = ? AND COALESCE(lender_id, '') = COALESCE(?, '') AND status IN ('enquiry','documents_pending','submitted_to_lender','under_review')`)
      .bind(inst(c), student, lender).first()
    if (dupLive) throw conflictCode('duplicate_application', dupMsg)

    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`
        INSERT INTO education_loan_applications (id, institution_id, student_id, lender_id, academic_year_id, reference_no, opened_on, amount_sought_paise, status, status_changed_on, assisted_by, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'documents_pending', ?, ?, ?, ?, ?)`)
        .bind(id, inst(c), student, lender, yearId, reference, opened, sought, opened, c.id.userId, nullString(req.notes), now(), now()),
    ]
    for (const kind of LOAN_CHECKLIST) {
      stmts.push(c.db.prepare(`
        INSERT OR IGNORE INTO education_loan_documents (id, institution_id, application_id, doc_kind, status, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'required', ?, ?, ?)`).bind(uuid(), inst(c), id, kind, c.id.userId, now(), now()))
    }
    stmts.push(c.db.prepare(`
      INSERT INTO education_loan_events (id, institution_id, application_id, happened_at, from_status, to_status, note, actor_user_id)
      VALUES (?, ?, ?, ?, NULL, 'documents_pending', ?, ?)`).bind(uuid(), inst(c), id, now(), 'Application opened; document checklist issued.', c.id.userId))
    await c.db.batch(stmts)
    return ok({ id })
  }))

  r.get('/finance/concessions/loans/applications/{id}', READ, fin(async (c) => {
    const appId = uuidParam(c.params.id)
    const head = await c.db.prepare(LOAN_SELECT(today()) + ` WHERE ap.id = ? AND ap.institution_id = ?`).bind(appId, inst(c)).first<Record<string, unknown>>()
    if (!head) throw notFound()
    const [docs, events] = await Promise.all([
      c.db.prepare(`
        SELECT d.id, d.doc_kind, d.label, d.status, d.provided_on, d.waived_reason, d.notes, d.student_document_id, d.issued_certificate_id,
               ic.serial_no AS certificate_serial, u.full_name AS updated_by
          FROM education_loan_documents d
          LEFT JOIN issued_certificates ic ON ic.id = d.issued_certificate_id
          LEFT JOIN users u ON u.id = d.updated_by
         WHERE d.application_id = ? AND d.institution_id = ?
         ORDER BY (d.status <> 'required'), d.doc_kind`).bind(appId, inst(c)).all<Record<string, unknown>>(),
      c.db.prepare(`
        SELECT ev.happened_at, ev.from_status, ev.to_status, ev.note, u.full_name AS actor
          FROM education_loan_events ev LEFT JOIN users u ON u.id = ev.actor_user_id
         WHERE ev.application_id = ? AND ev.institution_id = ?
         ORDER BY ev.happened_at DESC`).bind(appId, inst(c)).all<Record<string, unknown>>(),
    ])
    return ok({
      application: loanView(head),
      documents: docs.results.map((x) => omit({
        id: x.id, doc_kind: x.doc_kind, label: x.label ?? null, status: x.status, provided_on: day(x.provided_on), waived_reason: x.waived_reason ?? null,
        notes: x.notes ?? null, student_document_id: x.student_document_id ?? null, issued_certificate_id: x.issued_certificate_id ?? null,
        certificate_serial: x.certificate_serial ?? null, updated_by: x.updated_by ?? null,
      }, ['label', 'provided_on', 'waived_reason', 'notes', 'student_document_id', 'issued_certificate_id', 'certificate_serial', 'updated_by'])),
      events: events.results.map((x) => omit({
        happened_at: tsZ(x.happened_at), from_status: x.from_status ?? null, to_status: x.to_status, note: x.note ?? null, actor: x.actor ?? null,
      }, ['from_status', 'note', 'actor'])),
      disclosure: 'The school records the status of this application as reported to it. It is not the lender, does not assess or approve the loan, and holds no interest rate or repayment schedule.',
    })
  }))

  r.post('/finance/concessions/loans/applications/{id}/status', WRITE, fin(async (c) => {
    const appId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const next = str(req.status).trim()
    if (!(next in LOAN_TRANSITIONS)) throw badRequest('unknown status: ' + next)
    const reportedOn = optionalISODay(req.outcome_reported_on, 'outcome_reported_on')
    const sanctioned = req.sanctioned_amount_paise === null || req.sanctioned_amount_paise === undefined ? null : paise(req.sanctioned_amount_paise, 'sanctioned_amount_paise')
    const disbursed = req.disbursed_amount_paise === null || req.disbursed_amount_paise === undefined ? null : paise(req.disbursed_amount_paise, 'disbursed_amount_paise')

    const cur = await c.db.prepare(`SELECT status, lender_id FROM education_loan_applications WHERE id = ? AND institution_id = ?`).bind(appId, inst(c))
      .first<{ status: string; lender_id: string | null }>()
    if (!cur) throw notFound()
    if (!LOAN_TRANSITIONS[cur.status]?.includes(next)) throw refusal(`an application that is "${cur.status}" cannot become "${next}"`)
    let newLender = nullUUIDText(req.lender_id)
    if (newLender === null && cur.lender_id) newLender = cur.lender_id
    if (newLender === null && ['submitted_to_lender', 'under_review', 'sanctioned', 'declined', 'disbursed'].includes(next)) throw refusal('which lender is this with?')
    if (next === 'sanctioned' && (sanctioned === null || sanctioned <= 0)) throw refusal('how much did the parent say was sanctioned?')
    if (next === 'disbursed' && (disbursed === null || disbursed <= 0)) throw refusal('how much did the parent say was disbursed?')
    if (next === 'declined' && str(req.declined_reason).trim() === '') throw refusal('what reason was the parent given?')
    const clearOutcome = next === 'documents_pending'
    // Reopening makes the row live again: education_loan_applications_one_live.
    if (LOAN_LIVE.includes(next) && !LOAN_LIVE.includes(cur.status)) {
      const dupLive = await c.db.prepare(`SELECT id FROM education_loan_applications WHERE institution_id = ? AND student_id = (SELECT student_id FROM education_loan_applications WHERE id = ?) AND COALESCE(lender_id, '') = COALESCE(?, '') AND status IN ('enquiry','documents_pending','submitted_to_lender','under_review') AND id <> ?`)
        .bind(inst(c), appId, newLender, appId).first()
      if (dupLive) throw conflictCode('duplicate_application', 'this child already has a live application with that lender; continue that one rather than opening a second')
    }
    const t = today()
    await c.db.batch([
      c.db.prepare(`
        UPDATE education_loan_applications
           SET status = ?3, status_changed_on = ?11, lender_id = ?4,
               reference_no = COALESCE(?5, reference_no),
               sanctioned_amount_paise = CASE WHEN ?9 THEN NULL ELSE COALESCE(?6, sanctioned_amount_paise) END,
               disbursed_amount_paise = CASE WHEN ?9 THEN NULL ELSE COALESCE(?7, disbursed_amount_paise) END,
               declined_reason = CASE WHEN ?3 = 'declined' THEN ?8 ELSE NULL END,
               outcome_reported_on = CASE WHEN ?9 THEN NULL ELSE COALESCE(?10, outcome_reported_on) END,
               closed_on = CASE WHEN ?3 IN ('disbursed','withdrawn') THEN ?11 ELSE NULL END,
               updated_at = ?12
         WHERE id = ?1 AND institution_id = ?2`)
        .bind(appId, inst(c), next, newLender, nullString(req.reference_no), sanctioned, disbursed, nullString(str(req.declined_reason).trim()), clearOutcome ? 1 : 0, reportedOn, t, now()),
      c.db.prepare(`
        INSERT INTO education_loan_events (id, institution_id, application_id, happened_at, from_status, to_status, note, actor_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst(c), appId, now(), cur.status, next, nullString(req.note), c.id.userId),
    ])
    return ok({ status: next })
  }))

  r.post('/finance/concessions/loans/applications/{id}/documents', WRITE, fin(async (c) => {
    const appId = uuidParam(c.params.id)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const kind = str(req.doc_kind).trim()
    if (!['fee_structure', 'bonafide_certificate', 'admission_letter', 'fee_receipts', 'marksheet', 'id_proof', 'address_proof', 'income_proof', 'photograph', 'other'].includes(kind)) {
      throw badRequest('unknown document kind: ' + kind)
    }
    const label = nullString(req.label)
    if (kind === 'other' && str(req.label).trim() === '') throw badRequest('what is this document called?')
    let status = str(req.status).trim(); if (status === '') status = 'required'
    if (!['required', 'provided', 'submitted', 'verified', 'waived'].includes(status)) throw badRequest('unknown document status: ' + status)
    if (status === 'waived' && str(req.waived_reason).trim() === '') throw badRequest('why is this document not needed?')
    let provided = optionalISODay(req.provided_on, 'provided_on')
    if (provided === null && status !== 'required' && status !== 'waived') provided = today()
    const rid = str(req.id).trim()
    if (rid !== '' && !isUUID(rid)) throw refusal('malformed document id')
    const id = rid || uuid()
    const app = await c.db.prepare(`SELECT id FROM education_loan_applications WHERE id = ? AND institution_id = ?`).bind(appId, inst(c)).first()
    if (!app) throw notFound()
    // education_loan_documents_one_per_kind (application_id, doc_kind, lower(btrim(COALESCE(label,''))))
    const dup = await c.db.prepare(`SELECT id FROM education_loan_documents WHERE application_id = ? AND doc_kind = ? AND lower(trim(COALESCE(label, ''))) = lower(trim(?)) AND id <> ?`)
      .bind(appId, kind, label ?? '', id).first()
    if (dup) throw conflictCode('duplicate_document', "that document is already on this application's checklist")
    if (rid !== '') {
      const res = await c.db.prepare(`
        UPDATE education_loan_documents
           SET doc_kind = ?4, label = ?5, status = ?6, student_document_id = ?7, issued_certificate_id = ?8, provided_on = ?9, waived_reason = ?10, notes = ?11, updated_by = ?12, updated_at = ?13
         WHERE id = ?1 AND application_id = ?2 AND institution_id = ?3`)
        .bind(rid, appId, inst(c), kind, label, status, nullUUIDText(req.student_document_id), nullUUIDText(req.issued_certificate_id), provided,
          nullString(req.waived_reason), nullString(req.notes), c.id.userId, now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: rid })
    }
    await c.db.prepare(`
      INSERT INTO education_loan_documents (id, institution_id, application_id, doc_kind, label, status, student_document_id, issued_certificate_id, provided_on, waived_reason, notes, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), appId, kind, label, status, nullUUIDText(req.student_document_id), nullUUIDText(req.issued_certificate_id), provided,
        nullString(req.waived_reason), nullString(req.notes), c.id.userId, now(), now()).run()
    return ok({ id })
  }))
}

/* ------------------------------------------------------------------------- */

function importView(x: Record<string, unknown>) {
  return omit({
    id: x.id, scheme_id: x.scheme_id, scheme_name: x.scheme_name, academic_year: x.academic_year, filename: x.filename ?? null, source: x.source,
    row_count: Number(x.row_count), matched_count: Number(x.matched_count), unmatched_count: Number(x.unmatched_count), rejected_count: Number(x.rejected_count),
    credited_paise: p(x.credited_paise), imported_at: tsZ(x.imported_at), imported_by: x.imported_by ?? null,
  }, ['filename', 'imported_by'])
}

/** awardException: why a row needs a person, in the order a school would act. Empty means reconciled. */
function awardException(v: { stage: string; credited_paise: number; student_status: string; sanctioned_paise: number | null; has_account: boolean; is_aadhaar_seeded: boolean }): string {
  if (v.stage === 'sanctioned' && v.credited_paise === 0) return 'sanctioned_not_credited'
  if (v.stage === 'not_credited') return 'sanctioned_not_credited'
  if (v.credited_paise > 0 && v.student_status !== 'active') return 'student_left'
  if (v.sanctioned_paise !== null && v.credited_paise > 0 && v.sanctioned_paise !== v.credited_paise) return 'amount_differs'
  if (v.stage === 'school_verified' && !v.has_account) return 'no_bank_account'
  if (v.stage === 'school_verified' && !v.is_aadhaar_seeded) return 'not_aadhaar_seeded'
  return ''
}
