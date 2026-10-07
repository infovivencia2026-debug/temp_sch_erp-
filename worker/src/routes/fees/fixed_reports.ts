import type { Router, Ctx } from '../../router'
import { badRequest, ok, readJSON } from '../../http'
import { fin, items, isDate, p, today } from './common'
import { school } from '../school'

/* The fixed finance reports an accountant asks for by name.

   Every figure here could be reached through the Custom Report Builder, and
   nobody at an audit wants to build it: they want the cheque deposit sheet,
   the bank pay-in slip, outstanding as at the month end. Seven reports, each
   one query, each read-only. Money is integer paise throughout. */

const READ = 'finance.fees.read'
const fullName = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`

/** The child's class and section this year, as one label. */
const CLASS_SQL = `
  (SELECT c.name || CASE WHEN sec.name IS NULL THEN '' ELSE ' ' || sec.name END
     FROM enrollments en
     JOIN academic_years ay ON ay.id = en.academic_year_id
     JOIN classes c ON c.id = en.class_id
     LEFT JOIN sections sec ON sec.id = en.section_id
    WHERE en.student_id = st.id AND en.status = 'active'
    ORDER BY ay.is_current DESC, ay.starts_on DESC LIMIT 1)`

const monthParam = (c: Ctx): string => {
  const m = (c.url.searchParams.get('month') ?? '').trim()
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw badRequest('month must be YYYY-MM')
  return m
}
/** The last day of YYYY-MM. */
const monthEnd = (m: string): string => {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7))
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)
}
const range = (c: Ctx): { from: string; to: string } => {
  const q = c.url.searchParams
  const from = q.get('from') ?? '', to = q.get('to') ?? ''
  if (!isDate(from) || !isDate(to)) throw badRequest('from and to must be YYYY-MM-DD')
  return to < from ? { from: to, to: from } : { from, to }
}

type Row = Record<string, unknown>
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const lastFour = (v: unknown) => { const a = s(v); return a.length <= 4 ? a : '•'.repeat(a.length - 4) + a.slice(-4) }

async function cardRateBp(c: Ctx): Promise<number> {
  const row = await c.db.prepare(`SELECT json_extract(config, '$.rate_bp') AS v FROM module_settings WHERE institution_id = ? AND module = 'card_charges'`)
    .bind(school(c).id).first<{ v: unknown }>()
  const v = Number(row?.v)
  return row && row.v !== null && Number.isInteger(v) && v >= 0 ? v : 0
}

export function registerFixedReports(r: Router): void {
  /* Cheque deposit dashboard: every cheque and DD the counter has taken,
     where each one stands. Held = post-dated and not yet due; due = its date
     has come and it is still in the drawer; banked = received, not yet seen
     on a statement; cleared = matched to the bank; bounced. */
  r.get('/finance/reports/cheque-deposits', READ, fin(async (c) => {
    const t = today()
    const rows = await c.db.prepare(`
      SELECT pay.id, pay.receipt_no, pay.mode, pay.reference_no, pay.bank_name, pay.cheque_date, pay.paid_on, pay.amount_paise,
             pay.status, pay.reconciled_at, ${fullName('st')} AS student_name, st.admission_no, ${CLASS_SQL} AS class_name
        FROM payments pay JOIN students st ON st.id = pay.student_id
       WHERE pay.mode IN ('cheque', 'dd')
       ORDER BY pay.cheque_date IS NULL, pay.cheque_date DESC, pay.paid_on DESC LIMIT 1000`).all<Row>()
    const stage = (v: Row): string => {
      if (v.status === 'bounced') return 'bounced'
      if (v.status === 'pending') return s(v.cheque_date) > t ? 'held' : 'due'
      return v.reconciled_at ? 'cleared' : 'banked'
    }
    const list = rows.results.map((v) => ({
      id: v.id, receipt_no: s(v.receipt_no), mode: s(v.mode), cheque_no: s(v.reference_no), bank_name: s(v.bank_name),
      cheque_date: s(v.cheque_date) || s(v.paid_on), paid_on: s(v.paid_on), amount_paise: p(v.amount_paise),
      student_name: s(v.student_name), admission_no: s(v.admission_no), class_name: s(v.class_name), stage: stage(v),
    }))
    const totals: Record<string, { count: number; amount_paise: number }> = {}
    for (const k of ['held', 'due', 'banked', 'cleared', 'bounced']) totals[k] = { count: 0, amount_paise: 0 }
    for (const v of list) { totals[v.stage].count++; totals[v.stage].amount_paise += v.amount_paise }
    return ok({ items: list, totals })
  }))

  /* Bank submission form: the pay-in slip for one day. Cash as one line,
     then every cheque and DD taken that day, grouped by the drawee bank. */
  r.get('/finance/reports/bank-submission', READ, fin(async (c) => {
    const on = c.url.searchParams.get('on') ?? today()
    if (!isDate(on)) throw badRequest('on must be YYYY-MM-DD')
    const rows = await c.db.prepare(`
      SELECT pay.receipt_no, pay.mode, pay.reference_no, pay.bank_name, pay.cheque_date, pay.amount_paise,
             ${fullName('st')} AS student_name, st.admission_no
        FROM payments pay JOIN students st ON st.id = pay.student_id
       WHERE pay.paid_on = ? AND pay.status <> 'bounced' AND pay.mode IN ('cash', 'cheque', 'dd')
       ORDER BY pay.mode <> 'cash', pay.bank_name, pay.receipt_no`).bind(on).all<Row>()
    let cash = 0
    const banks = new Map<string, { bank_name: string; count: number; amount_paise: number; lines: Row[] }>()
    for (const v of rows.results) {
      if (v.mode === 'cash') { cash += p(v.amount_paise); continue }
      const name = s(v.bank_name) || 'Bank not recorded'
      const g = banks.get(name) ?? { bank_name: name, count: 0, amount_paise: 0, lines: [] }
      g.count++; g.amount_paise += p(v.amount_paise)
      g.lines.push({ receipt_no: s(v.receipt_no), mode: s(v.mode), cheque_no: s(v.reference_no), cheque_date: s(v.cheque_date),
        amount_paise: p(v.amount_paise), student_name: s(v.student_name), admission_no: s(v.admission_no) })
      banks.set(name, g)
    }
    const instruments = [...banks.values()]
    const instrumentTotal = instruments.reduce((a, b) => a + b.amount_paise, 0)
    return ok({ on, cash_paise: cash, instruments, instrument_count: instruments.reduce((a, b) => a + b.count, 0),
      instrument_paise: instrumentTotal, total_paise: cash + instrumentTotal })
  }))

  /* Outstanding as at a month end, class by class: what had been billed by
     then, what had been paid by then, and the difference. Today's payments
     do not change last March's figure. */
  r.get('/finance/reports/outstanding-as-at', READ, fin(async (c) => {
    const m = monthParam(c)
    const end = monthEnd(m)
    const rows = await c.db.prepare(`
      SELECT st.id AS student_id, ${fullName('st')} AS student_name, st.admission_no, ${CLASS_SQL} AS class_name,
             (SELECT COALESCE(SUM(i.net_paise), 0) FROM invoices i WHERE i.student_id = st.id AND i.issued_on <= ?1 AND i.status <> 'cancelled') AS billed_paise,
             (SELECT COALESCE(SUM(pay.amount_paise), 0) FROM payments pay WHERE pay.student_id = st.id AND pay.paid_on <= ?1 AND pay.status NOT IN ('bounced', 'cancelled')) AS paid_paise
        FROM students st
       WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.student_id = st.id AND i.issued_on <= ?1 AND i.status <> 'cancelled')
       ORDER BY class_name, st.admission_no`).bind(end).all<Row>()
    const byClass = new Map<string, { class_name: string; students: number; billed_paise: number; paid_paise: number; outstanding_paise: number }>()
    const list = rows.results.map((v) => {
      const billed = p(v.billed_paise), paid = p(v.paid_paise)
      const out = Math.max(0, billed - paid)
      const cls = s(v.class_name) || 'No class'
      const g = byClass.get(cls) ?? { class_name: cls, students: 0, billed_paise: 0, paid_paise: 0, outstanding_paise: 0 }
      g.students++; g.billed_paise += billed; g.paid_paise += paid; g.outstanding_paise += out
      byClass.set(cls, g)
      return { student_id: v.student_id, student_name: s(v.student_name), admission_no: s(v.admission_no), class_name: cls,
        billed_paise: billed, paid_paise: paid, outstanding_paise: out }
    })
    const classes = [...byClass.values()]
    return ok({ month: m, as_at: end, classes, items: list.filter((v) => v.outstanding_paise > 0),
      total_outstanding_paise: classes.reduce((a, b) => a + b.outstanding_paise, 0) })
  }))

  /* Fee plan details: what each child was billed this year, head by head,
     with the concession taken off. One row per child and fee head. */
  r.get('/finance/reports/fee-plan-details', READ, fin(async (c) => {
    const yearId = (c.url.searchParams.get('academic_year_id') ?? '').trim()
    const year = yearId
      ? await c.db.prepare(`SELECT id, name FROM academic_years WHERE id = ?`).bind(yearId).first<{ id: string; name: string }>()
      : await c.db.prepare(`SELECT id, name FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<{ id: string; name: string }>()
    if (!year) return ok({ year: null, items: [] })
    const rows = await c.db.prepare(`
      SELECT st.id AS student_id, ${fullName('st')} AS student_name, st.admission_no, ${CLASS_SQL} AS class_name,
             fh.name AS fee_head, SUM(il.amount_paise) AS amount_paise, SUM(il.discount_paise) AS discount_paise,
             COUNT(DISTINCT i.id) AS instalments
        FROM invoices i
        JOIN invoice_lines il ON il.invoice_id = i.id
        JOIN students st ON st.id = i.student_id
        LEFT JOIN fee_heads fh ON fh.id = il.fee_head_id
       WHERE i.academic_year_id = ? AND i.status <> 'cancelled'
       GROUP BY st.id, fh.id
       ORDER BY class_name, st.admission_no, fh.name`).bind(year.id).all<Row>()
    return ok({ year, items: rows.results.map((v) => ({
      student_id: v.student_id, student_name: s(v.student_name), admission_no: s(v.admission_no), class_name: s(v.class_name),
      fee_head: s(v.fee_head) || 'Other', amount_paise: p(v.amount_paise), discount_paise: p(v.discount_paise),
      net_paise: p(v.amount_paise) - p(v.discount_paise), instalments: Number(v.instalments ?? 0) })) })
  }))

  /* Consolidated month-wise: billed, concession, collected and the running
     outstanding, one line per month across the range. */
  r.get('/finance/reports/monthwise', READ, fin(async (c) => {
    const { from, to } = range(c)
    const billed = await c.db.prepare(`
      SELECT substr(issued_on, 1, 7) AS m, SUM(gross_paise) AS gross_paise, SUM(discount_paise) AS discount_paise, SUM(net_paise) AS net_paise, COUNT(*) AS invoices
        FROM invoices WHERE issued_on BETWEEN ?1 AND ?2 AND status <> 'cancelled' GROUP BY m`).bind(from, to).all<Row>()
    const paid = await c.db.prepare(`
      SELECT substr(paid_on, 1, 7) AS m, SUM(amount_paise) AS paid_paise, COUNT(*) AS receipts
        FROM payments WHERE paid_on BETWEEN ?1 AND ?2 AND status NOT IN ('bounced', 'cancelled') GROUP BY m`).bind(from, to).all<Row>()
    const opening = await c.db.prepare(`
      SELECT (SELECT COALESCE(SUM(net_paise), 0) FROM invoices WHERE issued_on < ?1 AND status <> 'cancelled')
           - (SELECT COALESCE(SUM(amount_paise), 0) FROM payments WHERE paid_on < ?1 AND status NOT IN ('bounced', 'cancelled')) AS v`).bind(from).first<{ v: number }>()
    const months: string[] = []
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
      months.push(m)
      const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7))
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
    }
    const b = new Map(billed.results.map((v) => [s(v.m), v])), pd = new Map(paid.results.map((v) => [s(v.m), v]))
    let running = Math.max(0, p(opening?.v))
    const list = months.map((m) => {
      const bi = b.get(m), pa = pd.get(m)
      const net = p(bi?.net_paise), collected = p(pa?.paid_paise)
      running = Math.max(0, running + net - collected)
      return { month: m, invoices: Number(bi?.invoices ?? 0), gross_paise: p(bi?.gross_paise), concession_paise: p(bi?.discount_paise),
        billed_paise: net, receipts: Number(pa?.receipts ?? 0), collected_paise: collected, outstanding_paise: running }
    })
    return ok({ from, to, opening_outstanding_paise: Math.max(0, p(opening?.v)), items: list })
  }))

  /* ECS and parent bank details: the account a refund or scholarship goes
     to, for every child who has one on file. Account numbers are masked
     here; the full number is only ever on the payout file. */
  r.get('/finance/reports/parent-bank-details', READ, fin(async (c) => {
    const rows = await c.db.prepare(`
      SELECT sb.id, ${fullName('st')} AS student_name, st.admission_no, ${CLASS_SQL} AS class_name,
             sb.account_holder_name, sb.relationship, sb.bank_name, sb.branch, sb.account_number, sb.ifsc, sb.account_type,
             sb.is_primary, sb.is_aadhaar_seeded, sb.dbt_consent_on, sb.verified_at
        FROM student_bank_accounts sb JOIN students st ON st.id = sb.student_id
       WHERE sb.is_active = 1
       ORDER BY class_name, st.admission_no, sb.is_primary DESC`).all<Row>()
    return ok(items(rows.results.map((v) => ({
      id: v.id, student_name: s(v.student_name), admission_no: s(v.admission_no), class_name: s(v.class_name),
      account_holder_name: s(v.account_holder_name), relationship: s(v.relationship), bank_name: s(v.bank_name), branch: s(v.branch),
      account_number: lastFour(v.account_number), ifsc: s(v.ifsc), account_type: s(v.account_type),
      is_primary: Number(v.is_primary) === 1, is_aadhaar_seeded: Number(v.is_aadhaar_seeded) === 1,
      dbt_consent_on: s(v.dbt_consent_on) || null, verified: !!v.verified_at }))))
  }))

  /* Card swipe charges: what the card machine and the gateway cost the
     school over a period, at the rate the school pays its bank. */
  r.get('/finance/reports/card-charges', READ, fin(async (c) => {
    const { from, to } = range(c)
    const rateBp = await cardRateBp(c)
    const rows = await c.db.prepare(`
      SELECT mode, COUNT(*) AS receipts, SUM(amount_paise) AS amount_paise
        FROM payments WHERE paid_on BETWEEN ?1 AND ?2 AND status NOT IN ('bounced', 'cancelled') AND mode IN ('card', 'netbanking', 'upi')
       GROUP BY mode ORDER BY mode`).bind(from, to).all<Row>()
    const list = rows.results.map((v) => {
      const amount = p(v.amount_paise)
      const charged = s(v.mode) === 'card'
      return { mode: s(v.mode), receipts: Number(v.receipts ?? 0), amount_paise: amount,
        rate_bp: charged ? rateBp : 0, charge_paise: charged ? Math.round(amount * rateBp / 10000) : 0 }
    })
    return ok({ from, to, rate_bp: rateBp, items: list, charge_paise: list.reduce((a, b) => a + b.charge_paise, 0) })
  }))

  r.put('/finance/reports/card-charges/settings', 'finance.fees.write', fin(async (c) => {
    const req = await readJSON<{ rate_bp?: unknown }>(c.req)
    const v = Number(req.rate_bp)
    if (!Number.isInteger(v) || v < 0 || v > 1000) throw badRequest('rate_bp must be a whole number of basis points between 0 and 1000 (10 percent)')
    await c.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?1, 'card_charges', 1, json_object('rate_bp', ?2))
        ON CONFLICT (institution_id, module) DO UPDATE SET config = json_set(config, '$.rate_bp', ?2)`).bind(school(c).id, v).run()
    return ok({ rate_bp: v })
  }))
}
