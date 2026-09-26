import type { Router } from '../../router'
import type { Ctx } from '../../router'
import { badRequest, bool, created, forbidden, notFound, now, ok, readJSON, uuidParam, isUUID, HttpError } from '../../http'
import { can } from '../../identity'
import {
  CLASS_SQL, SECTION_SQL, assertInBatch, daysBetween, householdUserIds, indianGroup, isBatchGuardFailure, isDate, items,
  nameSQL, notifyStmt, omitNulls, p, paise, requireFresh, requireOpenPeriod, rupeesFixed, rupeesInWords, financialYear,
  studentPredicate, syncInvoice, syncPayment, syncWallet, today,
} from './common'
import { nextNumber } from './numbering'
import { school } from '../school'

/* Port of the fee counter: fees.go (ledger, collect, receipt, cheques, PDC,
   defaulters), wallet.go and upi_qr.go, with internal/fees.Collect,
   ClearCheque and BounceCheque folded in. The sync_invoice_paid,
   sync_payment_allocated and sync_wallet_balance triggers are re-implemented
   in the batches that write the rows they derived from. */

interface Due { invoice_id: string; invoice_no: string; issued_on: string; due_on: string | null; net_paise: number; paid_paise: number; balance_paise: number; fine_paise: number; status: string }

/** fees.Outstanding: a student's unsettled invoices, oldest first (allocation order). */
export async function outstanding(c: Ctx, studentId: string): Promise<Due[]> {
  const rows = await c.db.prepare(`
    SELECT id AS invoice_id, invoice_no, issued_on, due_on, net_paise, paid_paise, net_paise - paid_paise AS balance_paise, fine_paise, status
      FROM invoices WHERE student_id = ? AND status IN ('unpaid','partial','overdue') AND net_paise > paid_paise
     ORDER BY COALESCE(due_on, issued_on), invoice_no`).bind(studentId).all<Due>()
  return rows.results.map((d) => ({ ...d, net_paise: p(d.net_paise), paid_paise: p(d.paid_paise), balance_paise: p(d.balance_paise), fine_paise: p(d.fine_paise) }))
}

export interface Allocation { invoice_id: string; invoice_no: string; amount_paise: number }

/**
 * fees.allocate: spread a payment across outstanding invoices, oldest first.
 * Returns the allocation rows to insert plus the trigger statements. A
 * remainder stays unallocated (an advance against next term).
 */
export async function allocate(c: Ctx, studentId: string, paymentId: string, amount: number, invoiceIds: string[]):
  Promise<{ allocated: Allocation[]; unallocated: number; stmts: D1PreparedStatement[] }> {
  let dues = await outstanding(c, studentId)
  if (invoiceIds.length) {
    const wanted = new Set(invoiceIds)
    dues = dues.filter((d) => wanted.has(d.invoice_id))
    if (!dues.length) throw badRequest('none of the selected invoices are outstanding for this student')
  }
  let remaining = amount
  const allocated: Allocation[] = []
  const stmts: D1PreparedStatement[] = []
  for (const d of dues) {
    if (remaining <= 0) break
    const amt = Math.min(d.balance_paise, remaining)
    if (amt <= 0) continue
    stmts.push(c.db.prepare(`INSERT INTO payment_allocations (id, institution_id, payment_id, invoice_id, amount_paise, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), school(c).id, paymentId, d.invoice_id, amt, now()))
    stmts.push(...syncInvoice(c, d.invoice_id))
    allocated.push({ invoice_id: d.invoice_id, invoice_no: d.invoice_no, amount_paise: amt })
    remaining -= amt
  }
  stmts.push(syncPayment(c, paymentId))
  return { allocated, unallocated: remaining, stmts }
}

/**
 * fees.Collect: record a payment under the school's receipt series and
 * allocate it (unless post-dated). Returns the statements for the caller's
 * batch; no notifications, wallet or period checks, which are the counter
 * handler's own. Used by the fee-payment importer.
 */
export async function collect(c: Ctx, req: { studentId: string; amount: number; mode: string; paidOn: string; referenceNo?: string; bankName?: string;
  chequeDate?: string | null; remarks?: string; payerName?: string; payerRelation?: string; invoiceIds?: string[] }):
  Promise<{ paymentId: string; receiptNo: string; allocated: Allocation[]; unallocated: number; cleared: boolean; stmts: D1PreparedStatement[] }> {
  if (req.amount <= 0) throw badRequest('amount must be positive')
  const st = await c.db.prepare(`SELECT institution_id, campus_id FROM students WHERE id = ?`).bind(req.studentId).first<{ institution_id: string; campus_id: string }>()
  if (!st) throw notFound()
  const chequeDate = req.chequeDate ?? null
  const pdc = (req.mode === 'cheque' || req.mode === 'dd') && chequeDate !== null && chequeDate > req.paidOn
  const number = await nextNumber(c, 'receipt', req.paidOn)
  const paymentId = crypto.randomUUID()
  const stmts: D1PreparedStatement[] = [
    ...number.stmts,
    c.db.prepare(`INSERT INTO payments (id, institution_id, campus_id, student_id, receipt_no, receipt_seq, receipt_fy, amount_paise, allocated_paise, mode, paid_on,
                    reference_no, bank_name, cheque_date, status, collected_by, remarks, payer_name, payer_relation, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, 0, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?)`)
      .bind(paymentId, st.institution_id, st.campus_id, req.studentId, number.text, number.seq, number.fy, req.amount, req.mode, req.paidOn,
        req.referenceNo ?? '', req.bankName ?? '', chequeDate, pdc ? 'pending' : 'success', c.id.userId ?? null, req.remarks ?? '',
        (req.payerName ?? '').trim(), (req.payerRelation ?? '').trim(), now()),
  ]
  if (pdc) return { paymentId, receiptNo: number.text, allocated: [], unallocated: req.amount, cleared: false, stmts }
  const a = await allocate(c, req.studentId, paymentId, req.amount, req.invoiceIds ?? [])
  stmts.push(...a.stmts)
  return { paymentId, receiptNo: number.text, allocated: a.allocated, unallocated: a.unallocated, cleared: true, stmts }
}

const VALID_MODES = new Set(['cash', 'cheque', 'dd', 'neft', 'upi', 'card', 'netbanking', 'adjustment', 'wallet'])
const WALLET_SOURCE_MODES = new Set(['cash', 'upi', 'neft', 'card', 'gateway', 'cheque', 'dd'])

interface WalletRow { id: string; status: string; balance_paise: number }

/**
 * walletDebit: the spend statements for a wallet-paid fee, after the checks
 * the Go code made under the row lock. The batch guard is the trigger's
 * "cannot go negative" backstop.
 */
export async function walletDebitStmts(c: Ctx, campusId: string | null, studentId: string, amount: number, reference: string,
  note: string, paymentId: string | null, posSaleId: string | null): Promise<D1PreparedStatement[]> {
  const w = await c.db.prepare(`SELECT id, status, balance_paise FROM wallet_accounts WHERE student_id = ?`).bind(studentId).first<WalletRow>()
  if (!w) throw badRequest('this child has no wallet yet -- top it up at the fee office first, or take another mode')
  if (w.status !== 'active') throw badRequest(`this wallet is ${w.status} and cannot be spent from`)
  if (p(w.balance_paise) < amount) throw badRequest(`not enough in the wallet: ${indianGroup(p(w.balance_paise))} left, ${indianGroup(amount)} needed`)
  return [
    c.db.prepare(`INSERT INTO wallet_transactions (id, institution_id, campus_id, wallet_id, student_id, kind, delta_paise, source_mode, reference_no, payment_id, pos_sale_id, note, created_by, created_at)
                  VALUES (?, ?, ?, ?, ?, 'spend', ?, 'wallet', NULLIF(?, ''), ?, ?, NULLIF(?, ''), ?, ?)`)
      .bind(crypto.randomUUID(), school(c).id, campusId, w.id, studentId, -amount, reference, paymentId, posSaleId, note, c.id.userId, now()),
    syncWallet(c, w.id),
    assertInBatch(c, `(SELECT balance_paise FROM wallet_accounts WHERE id = ?) >= 0`, [w.id]),
  ]
}

export function registerCounter(r: Router): void {
  // ---------------------------------------------------------------- ledger
  r.get('/fees/students/{id}/ledger', 'auth', async (c) => {
    const studentId = uuidParam(c.params.id)
    const scope = await studentPredicate(c, 'st')
    const head = await c.db.prepare(`SELECT st.admission_no, ${nameSQL('st')} AS full_name, ${CLASS_SQL('st')} AS class_name, ${SECTION_SQL('st')} AS section_name
        FROM students st WHERE st.id = ? AND ${scope.sql}`).bind(studentId, ...scope.args)
      .first<{ admission_no: string; full_name: string; class_name: string | null; section_name: string | null }>()
    if (!head) throw notFound()

    const totals = await c.db.prepare(`
      SELECT COALESCE((SELECT sum(net_paise) FROM invoices WHERE student_id = ?1 AND status <> 'cancelled'), 0) AS charged,
             COALESCE((SELECT sum(amount_paise) FROM payments WHERE student_id = ?1 AND status = 'success'), 0) AS paid,
             COALESCE((SELECT sum(amount_paise) FROM payments WHERE student_id = ?1 AND status = 'pending'), 0) AS pending`)
      .bind(studentId).first<{ charged: number; paid: number; pending: number }>()
    const charged = p(totals?.charged), paid = p(totals?.paid), pending = p(totals?.pending)

    const t = today()
    const dues = (await outstanding(c, studentId)).map((d) => omitNulls({
      invoice_id: d.invoice_id, invoice_no: d.invoice_no, issued_on: d.issued_on, due_on: d.due_on,
      net_paise: d.net_paise, paid_paise: d.paid_paise, balance_paise: d.balance_paise, fine_paise: d.fine_paise, status: d.status,
      days_overdue: d.due_on && t > d.due_on ? daysBetween(d.due_on, t) : 0,
    }))

    const concessions = await c.db.prepare(`SELECT fc.kind, fc.percent, fc.amount_paise, fc.reason, fh.name AS fee_head
        FROM fee_concessions fc LEFT JOIN fee_heads fh ON fh.id = fc.fee_head_id WHERE fc.student_id = ? ORDER BY fc.created_at DESC`)
      .bind(studentId).all<{ kind: string; percent: string | null; amount_paise: number | null; reason: string | null; fee_head: string | null }>()

    const entries = await c.db.prepare(`
      SELECT * FROM (
        SELECT i.issued_on AS date, 'invoice' AS kind, i.invoice_no AS reference,
               COALESCE((SELECT REPLACE(group_concat(DISTINCT fh.name), ',', ', ') FROM invoice_lines il JOIN fee_heads fh ON fh.id = il.fee_head_id WHERE il.invoice_id = i.id), 'Fee invoice') AS description,
               i.net_paise AS debit_paise, 0 AS credit_paise, i.status, NULL AS mode
          FROM invoices i WHERE i.student_id = ?1
        UNION ALL
        SELECT p.paid_on, 'payment', COALESCE(p.receipt_no, '-'),
               CASE WHEN p.status = 'pending' THEN 'Cheque held (post-dated)'
                    WHEN p.status = 'bounced' THEN 'Cheque dishonoured'
                    WHEN p.mode = 'adjustment' THEN COALESCE(p.remarks, 'Adjustment')
                    ELSE 'Payment received' END,
               0, p.amount_paise, p.status, p.mode
          FROM payments p WHERE p.student_id = ?1
        UNION ALL
        SELECT substr(rf.created_at, 1, 10), 'refund', 'REF', rf.reason, rf.amount_paise, 0, rf.status, rf.mode
          FROM refunds rf WHERE rf.student_id = ?1 AND rf.status IN ('approved', 'processed')
      ) x ORDER BY date DESC, kind`).bind(studentId).all<Record<string, unknown>>()

    return ok(omitNulls({
      student_id: studentId, admission_no: head.admission_no, full_name: head.full_name,
      class_name: head.class_name, section_name: head.section_name,
      charged_paise: charged, paid_paise: paid, balance_paise: charged - paid, pending_paise: pending,
      concessions: concessions.results.map((x) => omitNulls({ kind: x.kind, percent: x.percent, amount_paise: x.amount_paise === null ? null : p(x.amount_paise), reason: x.reason, fee_head: x.fee_head })),
      dues,
      entries: entries.results.map((e) => omitNulls({
        date: e.date, kind: e.kind, reference: e.reference, description: e.description ?? '',
        debit_paise: p(e.debit_paise), credit_paise: p(e.credit_paise), status: e.status, mode: e.mode,
      })),
    }))
  })

  // ---------------------------------------------------------------- UPI code
  r.get('/fees/upi-code', 'auth', async (c) => {
    if (!c.id.institution) throw badRequest("this screen belongs to a school. Sign in against one, or pick a school first - a platform operator's account is not attached to any.")
    const q = c.url.searchParams
    const amountRaw = (q.get('amount_paise') ?? '').trim()
    const amount = /^-?\d+$/.test(amountRaw) ? Number(amountRaw) : NaN
    if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest('amount_paise must be a whole number of paise greater than zero')
    const row = await c.db.prepare(`SELECT COALESCE(upi_vpa, '') AS vpa, COALESCE(NULLIF(upi_payee_name, ''), name) AS payee, COALESCE(upi_merchant_code, '') AS mc FROM institutions WHERE id = ?`)
      .bind(c.id.institution.id).first<{ vpa: string; payee: string; mc: string }>()
    if (!row || row.vpa === '') throw notFound()
    const note = upiNote(q.get('note') ?? '')
    const ref = (q.get('ref') ?? '').trim() || note
    const pay = { vpa: row.vpa, payee: row.payee, amount, note, mc: row.mc, ref }
    const intent = upiIntent(pay)
    // The PNG the Go server drew (fees.UPIQRPNG) needs a QR encoder the
    // worker does not carry; the intent and per-app links are complete.
    const body = { vpa: row.vpa, payee_name: row.payee, amount_paise: amount, ...(note ? { note } : {}), intent, apps: upiAppLinks(intent), image: '' }
    const res = ok(body)
    res.headers.set('cache-control', 'private, max-age=86400')
    return res
  })

  // ---------------------------------------------------------------- wallet
  r.get('/fees/students/{id}/wallet', 'auth', async (c) => {
    if (!can(c.id, 'finance.wallet.read') && !can(c.id, 'self.wallet.read')) throw forbidden('finance.wallet.read')
    const studentId = uuidParam(c.params.id)
    const scope = await studentPredicate(c, 'st')
    const st = await c.db.prepare(`SELECT st.admission_no, ${nameSQL('st')} AS full_name FROM students st WHERE st.id = ? AND ${scope.sql}`)
      .bind(studentId, ...scope.args).first<{ admission_no: string; full_name: string }>()
    if (!st) throw notFound()
    const out: Record<string, unknown> = { student_id: studentId, admission_no: st.admission_no, full_name: st.full_name, wallet_id: null, status: 'none', balance_paise: 0, transactions: [] as unknown[] }
    const w = await c.db.prepare(`SELECT id, status, balance_paise FROM wallet_accounts WHERE student_id = ?`).bind(studentId).first<WalletRow>()
    if (!w) return ok(out)
    out.wallet_id = w.id; out.status = w.status; out.balance_paise = p(w.balance_paise)
    const tx = await c.db.prepare(`SELECT t.id, t.kind, t.delta_paise, t.source_mode, t.reference_no, t.payment_id, t.note, u.full_name AS recorded_by, t.created_at
        FROM wallet_transactions t LEFT JOIN users u ON u.id = t.created_by WHERE t.wallet_id = ? ORDER BY t.created_at DESC LIMIT 200`).bind(w.id).all<Record<string, unknown>>()
    out.transactions = tx.results.map((t) => ({ id: t.id, kind: t.kind, delta_paise: p(t.delta_paise), source_mode: t.source_mode ?? null, reference_no: t.reference_no ?? null,
      payment_id: t.payment_id ?? null, note: t.note ?? null, recorded_by: t.recorded_by ?? null, created_at: t.created_at }))
    return ok(out)
  })

  /** openWallet: the student's wallet, created on first use inside the caller's batch. */
  async function openWallet(c: Ctx, campusId: string | null, studentId: string): Promise<{ id: string; status: string; create: D1PreparedStatement[] }> {
    const w = await c.db.prepare(`SELECT id, status, balance_paise FROM wallet_accounts WHERE student_id = ?`).bind(studentId).first<WalletRow>()
    if (w) return { id: w.id, status: w.status, create: [c.db.prepare(`UPDATE wallet_accounts SET updated_at = ? WHERE id = ?`).bind(now(), w.id)] }
    const id = crypto.randomUUID()
    return { id, status: 'active', create: [c.db.prepare(`INSERT INTO wallet_accounts (id, institution_id, campus_id, student_id, balance_paise, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`)
      .bind(id, school(c).id, campusId, studentId, now(), now())] }
  }

  r.post('/fees/wallet/topups', 'finance.wallet.manage', async (c) => {
    await requireFresh(c)
    const req = await readJSON<{ student_id?: string; amount_paise?: unknown; source_mode?: string; reference_no?: string; note?: string }>(c.req)
    if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
    const amount = paise(req.amount_paise)
    if (amount <= 0) throw badRequest('amount_paise must be greater than zero')
    const mode = (req.source_mode ?? '').trim().toLowerCase()
    if (!WALLET_SOURCE_MODES.has(mode)) throw badRequest('unsupported source_mode: ' + (req.source_mode ?? ''))
    const reference = (req.reference_no ?? '').trim()
    if ((mode === 'upi' || mode === 'neft' || mode === 'cheque' || mode === 'dd') && reference === '') throw badRequest(`reference_no (UTR or instrument number) is required for ${mode}`)
    const st = await c.db.prepare(`SELECT institution_id, campus_id FROM students WHERE id = ?`).bind(req.student_id).first<{ institution_id: string; campus_id: string | null }>()
    if (!st) throw notFound()
    await requireOpenPeriod(c, today())
    const w = await openWallet(c, st.campus_id, req.student_id)
    if (w.status !== 'active') throw badRequest(`this wallet is ${w.status} and cannot be topped up`)
    const txnId = crypto.randomUUID()
    await c.db.batch([
      ...w.create,
      c.db.prepare(`INSERT INTO wallet_transactions (id, institution_id, campus_id, wallet_id, student_id, kind, delta_paise, source_mode, reference_no, note, created_by, created_at)
                    VALUES (?, ?, ?, ?, ?, 'top_up', ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?)`)
        .bind(txnId, school(c).id, st.campus_id, w.id, req.student_id, amount, mode, reference, (req.note ?? '').trim(), c.id.userId, now()),
      syncWallet(c, w.id),
    ])
    const bal = await c.db.prepare(`SELECT balance_paise FROM wallet_accounts WHERE id = ?`).bind(w.id).first<{ balance_paise: number }>()
    return created({ transaction_id: txnId, wallet_id: w.id, balance_paise: p(bal?.balance_paise) })
  })

  r.post('/fees/wallet/adjustments', 'finance.wallet.manage', async (c) => {
    await requireFresh(c)
    const req = await readJSON<{ student_id?: string; delta_paise?: unknown; note?: string }>(c.req)
    if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
    const delta = paise(req.delta_paise, 'delta_paise')
    if (delta === 0) throw badRequest('delta_paise must not be zero')
    const note = (req.note ?? '').trim()
    if (note === '') throw badRequest('note is required: say why the balance is being adjusted')
    const st = await c.db.prepare(`SELECT institution_id, campus_id FROM students WHERE id = ?`).bind(req.student_id).first<{ institution_id: string; campus_id: string | null }>()
    if (!st) throw notFound()
    await requireOpenPeriod(c, today())
    const w = await openWallet(c, st.campus_id, req.student_id)
    const txnId = crypto.randomUUID()
    try {
      await c.db.batch([
        ...w.create,
        c.db.prepare(`INSERT INTO wallet_transactions (id, institution_id, campus_id, wallet_id, student_id, kind, delta_paise, source_mode, note, created_by, created_at)
                      VALUES (?, ?, ?, ?, ?, 'adjustment', ?, 'adjustment', ?, ?, ?)`)
          .bind(txnId, school(c).id, st.campus_id, w.id, req.student_id, delta, note, c.id.userId, now()),
        syncWallet(c, w.id),
        assertInBatch(c, `(SELECT balance_paise FROM wallet_accounts WHERE id = ?) >= 0`, [w.id]),
      ])
    } catch (e) {
      if (isBatchGuardFailure(e)) throw badRequest('insufficient wallet balance for this adjustment')
      throw e
    }
    const bal = await c.db.prepare(`SELECT balance_paise FROM wallet_accounts WHERE id = ?`).bind(w.id).first<{ balance_paise: number }>()
    return created({ transaction_id: txnId, wallet_id: w.id, balance_paise: p(bal?.balance_paise) })
  })

  // ---------------------------------------------------------------- collect
  r.post('/fees/payments', 'finance.payments.write', async (c) => {
    await requireFresh(c)
    const req = await readJSON<{ student_id?: string; amount_paise?: unknown; mode?: string; paid_on?: string; reference_no?: string; bank_name?: string;
      cheque_date?: string; remarks?: string; payer_name?: string; payer_relation?: string; invoice_ids?: string[] }>(c.req)
    if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
    const amount = paise(req.amount_paise)
    if (amount <= 0) throw badRequest('amount_paise must be greater than zero')
    const mode = req.mode ?? ''
    if (!VALID_MODES.has(mode)) throw badRequest('unsupported payment mode: ' + mode)
    let paidOn = today()
    if (req.paid_on) { if (!isDate(req.paid_on)) throw badRequest('paid_on must be YYYY-MM-DD'); paidOn = req.paid_on }
    let chequeDate: string | null = null
    if (req.cheque_date) { if (!isDate(req.cheque_date)) throw badRequest('cheque_date must be YYYY-MM-DD'); chequeDate = req.cheque_date }
    const reference = req.reference_no ?? ''
    if ((mode === 'cheque' || mode === 'dd') && reference === '') throw badRequest('reference_no (instrument number) is required for cheque or DD')
    const invoiceIds: string[] = []
    for (const raw of req.invoice_ids ?? []) { if (!isUUID(raw)) throw badRequest('invoice_ids must be uuids'); invoiceIds.push(raw) }

    const st = await c.db.prepare(`SELECT institution_id, campus_id FROM students WHERE id = ?`).bind(req.student_id).first<{ institution_id: string; campus_id: string }>()
    if (!st) throw notFound()
    await requireOpenPeriod(c, paidOn)

    const pdc = (mode === 'cheque' || mode === 'dd') && chequeDate !== null && chequeDate > paidOn
    const status = pdc ? 'pending' : 'success'
    const number = await nextNumber(c, 'receipt', paidOn)
    const paymentId = crypto.randomUUID()
    const stmts: D1PreparedStatement[] = [
      ...number.stmts,
      c.db.prepare(`INSERT INTO payments (id, institution_id, campus_id, student_id, receipt_no, receipt_seq, receipt_fy, amount_paise, allocated_paise, mode, paid_on,
                      reference_no, bank_name, cheque_date, status, collected_by, remarks, payer_name, payer_relation, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, 0, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?)`)
        .bind(paymentId, st.institution_id, st.campus_id, req.student_id, number.text, number.seq, number.fy, amount, mode, paidOn,
          reference, req.bank_name ?? '', chequeDate, status, c.id.userId, req.remarks ?? '', (req.payer_name ?? '').trim(), (req.payer_relation ?? '').trim(), now()),
    ]
    let allocated: Allocation[] = []
    let unallocated = amount
    if (!pdc) {
      const a = await allocate(c, req.student_id, paymentId, amount, invoiceIds)
      allocated = a.allocated; unallocated = a.unallocated; stmts.push(...a.stmts)
    }
    if (mode === 'wallet') {
      stmts.push(...await walletDebitStmts(c, st.campus_id, req.student_id, amount, number.text, 'Fee receipt ' + number.text, paymentId, null))
    }
    const amountText = '₹' + rupeesFixed(amount)
    const body = pdc ? `${amountText} taken by ${mode}, receipt ${number.text}. It counts once it clears.` : `${amountText} received, receipt ${number.text}.`
    for (const u of await householdUserIds(c, req.student_id)) {
      stmts.push(notifyStmt(c, u, req.student_id, 'fee_receipt', 'Fee received', body, '/go/fee_receipts', 'payment', paymentId))
    }
    try { await c.db.batch(stmts) } catch (e) {
      if (isBatchGuardFailure(e)) throw new HttpError(409, 'another receipt was issued at the same moment; try again')
      throw e
    }
    return created({
      payment_id: paymentId, receipt_no: number.text, amount_paise: amount, allocated, unallocated_paise: unallocated, cleared: !pdc,
      receipt_url: '/api/v1/fees/receipts/' + paymentId,
    })
  })

  // ---------------------------------------------------------------- receipt
  r.get('/fees/receipts/{id}', 'finance.payments.read', async (c) => {
    const paymentId = uuidParam(c.params.id)
    const row = await c.db.prepare(`
      SELECT COALESCE(p.receipt_no, '-') AS receipt_no, p.amount_paise, p.mode, p.status, p.paid_on, p.reference_no,
             ${nameSQL('st')} AS student_name, st.admission_no, i.name AS institution, ${CLASS_SQL('st')} AS class_name, ${SECTION_SQL('st')} AS section_name,
             u.full_name AS collected_by
        FROM payments p JOIN students st ON st.id = p.student_id JOIN institutions i ON i.id = p.institution_id
        LEFT JOIN users u ON u.id = p.collected_by WHERE p.id = ?`).bind(paymentId).first<Record<string, unknown>>()
    if (!row) throw notFound()
    const lines = await c.db.prepare(`
      SELECT i.invoice_no, pa.amount_paise,
             COALESCE((SELECT REPLACE(group_concat(DISTINCT fh.name), ',', ', ') FROM invoice_lines il JOIN fee_heads fh ON fh.id = il.fee_head_id WHERE il.invoice_id = i.id), 'Fee') AS particulars
        FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id WHERE pa.payment_id = ?`).bind(paymentId).all<Record<string, unknown>>()
    const amount = p(row.amount_paise)
    return ok({
      receipt_no: row.receipt_no, amount_paise: amount, amount_words: rupeesInWords(amount), mode: row.mode, status: row.status, paid_on: row.paid_on,
      reference_no: row.reference_no ?? null, student_name: row.student_name, admission_no: row.admission_no, institution: row.institution,
      class_name: row.class_name ?? null, section_name: row.section_name ?? null, collected_by: row.collected_by ?? null,
      financial_year: financialYear(String(row.paid_on)),
      lines: lines.results.map((l) => ({ invoice_no: l.invoice_no, amount_paise: p(l.amount_paise), particulars: l.particulars })),
    })
  })

  // ---------------------------------------------------------------- cheques
  r.post('/fees/payments/{id}/clear', 'finance.payments.write', async (c) => {
    const paymentId = uuidParam(c.params.id)
    const pay = await c.db.prepare(`SELECT student_id, amount_paise FROM payments WHERE id = ? AND status = 'pending'`).bind(paymentId).first<{ student_id: string; amount_paise: number }>()
    if (!pay) throw badRequest('no pending payment with that id')
    const a = await allocate(c, pay.student_id, paymentId, p(pay.amount_paise), [])
    await c.db.batch([c.db.prepare(`UPDATE payments SET status = 'success' WHERE id = ?`).bind(paymentId), ...a.stmts])
    return ok({ id: paymentId, status: 'success' })
  })

  r.post('/fees/payments/{id}/bounce', 'finance.payments.write', async (c) => {
    const paymentId = uuidParam(c.params.id)
    let reqFine = 0
    // The body is optional (Go: r.ContentLength > 0), so an empty one is not a 400.
    const raw = (await c.req.text()).trim()
    if (raw !== '') {
      let body: { fine_paise?: unknown }
      try { body = JSON.parse(raw) } catch { throw badRequest('malformed JSON body') }
      reqFine = paise(body.fine_paise, 'fine_paise')
    }
    const pay = await c.db.prepare(`SELECT student_id, paid_on FROM payments WHERE id = ?`).bind(paymentId).first<{ student_id: string; paid_on: string }>()
    if (!pay) throw notFound()
    await requireOpenPeriod(c, pay.paid_on)
    let fine = reqFine
    if (fine <= 0) {
      const v = await c.db.prepare(`SELECT json_extract(config, '$.cheque_bounce_fine_paise') AS v FROM module_settings WHERE module = 'finance'`).first<{ v: unknown }>()
      const n = v?.v === null || v?.v === undefined ? NaN : Number(v.v)
      if (Number.isSafeInteger(n)) fine = n
    }
    const allocs = await c.db.prepare(`SELECT invoice_id FROM payment_allocations WHERE payment_id = ?`).bind(paymentId).all<{ invoice_id: string }>()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`DELETE FROM payment_allocations WHERE payment_id = ?`).bind(paymentId),
      c.db.prepare(`UPDATE payments SET status = 'bounced' WHERE id = ?`).bind(paymentId),
    ]
    for (const a of allocs.results) stmts.push(...syncInvoice(c, a.invoice_id))
    stmts.push(syncPayment(c, paymentId))
    if (fine > 0) {
      stmts.push(c.db.prepare(`UPDATE invoices SET fine_paise = fine_paise + ?2, net_paise = gross_paise - discount_paise + fine_paise + ?2, updated_at = ?3
         WHERE id = (SELECT id FROM invoices WHERE student_id = ?1 AND status IN ('unpaid','partial','overdue') ORDER BY COALESCE(due_on, issued_on) LIMIT 1)`)
        .bind(pay.student_id, fine, now()))
    }
    await c.db.batch(stmts)
    return ok({ id: paymentId, status: 'bounced', fine_paise: reqFine })
  })

  r.get('/fees/pdc', 'finance.payments.read', async (c) => {
    const rows = await c.db.prepare(`
      SELECT p.id AS payment_id, p.receipt_no, ${nameSQL('st')} AS student_name, st.admission_no, p.amount_paise, p.bank_name, p.reference_no AS instrument_no,
             p.cheque_date, (p.cheque_date IS NOT NULL AND p.cheque_date <= ?) AS due_today
        FROM payments p JOIN students st ON st.id = p.student_id
       WHERE p.status = 'pending' AND p.mode IN ('cheque','dd') ORDER BY p.cheque_date IS NULL, p.cheque_date`).bind(today()).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omitNulls({ payment_id: v.payment_id, receipt_no: v.receipt_no, student_name: v.student_name, admission_no: v.admission_no,
      amount_paise: p(v.amount_paise), bank_name: v.bank_name, instrument_no: v.instrument_no, cheque_date: v.cheque_date, due_today: bool(v.due_today) }))))
  })

  // ---------------------------------------------------------------- defaulters
  r.get('/fees/defaulters', 'finance.invoices.read', async (c) => {
    const all = c.url.searchParams.get('all') === '1'
    const t = today()
    const rows = await c.db.prepare(`
      SELECT st.id AS student_id, st.admission_no, ${nameSQL('st')} AS full_name, ${CLASS_SQL('st')} AS class_name, ${SECTION_SQL('st')} AS section_name,
             (SELECT gg.full_name FROM student_guardians sg JOIN guardians gg ON gg.id = sg.guardian_id WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1) AS guardian_name,
             (SELECT gg.phone FROM student_guardians sg JOIN guardians gg ON gg.id = sg.guardian_id WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1) AS phone,
             sum(i.net_paise - i.paid_paise) AS balance_paise, min(i.due_on) AS oldest_due, substr(st.last_fee_reminder_at, 1, 16) AS last_reminded,
             COALESCE(MAX(0, CAST(julianday(?1) - julianday(min(i.due_on)) AS INTEGER)), 0) AS days_overdue
        FROM invoices i JOIN students st ON st.id = i.student_id
       WHERE i.status IN ('unpaid','partial','overdue') AND (?2 OR (i.due_on IS NOT NULL AND i.due_on < ?1))
       GROUP BY st.id HAVING sum(i.net_paise - i.paid_paise) > 0
       ORDER BY sum(i.net_paise - i.paid_paise) DESC LIMIT 500`).bind(t, all ? 1 : 0).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => {
      const d = p(v.days_overdue)
      const bucket = d > 90 ? '90+' : d > 60 ? '61-90' : d > 30 ? '31-60' : '0-30'
      return omitNulls({ student_id: v.student_id, admission_no: v.admission_no, full_name: v.full_name, class_name: v.class_name, section_name: v.section_name,
        guardian_name: v.guardian_name, phone: v.phone, balance_paise: p(v.balance_paise), oldest_due: v.oldest_due, last_reminded: v.last_reminded, days_overdue: d, bucket })
    })))
  })
}

/* ---------------------------------------------------------------------- UPI (internal/fees/upi.go) */

const clipRunes = (s: string, n: number): string => { const r = [...s]; return r.length <= n ? s : r.slice(0, n).join('').trim() }
function percentEncode(s: string): string {
  const bytes = new TextEncoder().encode(s); let out = ''
  for (const b of bytes) {
    const ch = String.fromCharCode(b)
    if (/[A-Za-z0-9\-._~]/.test(ch) && b < 128) out += ch
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}
const upiRupees = (paiseAmt: number): string => rupeesFixed(paiseAmt)
function upiRef(s: string): string {
  let out = ''
  for (const ch of s.trim()) { if (/[A-Za-z0-9-]/.test(ch)) out += ch; else if (ch === ' ' || ch === '/' || ch === '_') out += '-' }
  return clipRunes(out, 35)
}
export function upiNote(s: string): string {
  s = s.replace(/[!"#$%&'()*+,:;<=>?@[\\\]^_`{|}~]/g, '')
  s = s.split(/\s+/).filter(Boolean).join(' ')
  return clipRunes(s, 50)
}
interface UpiPayment { vpa: string; payee: string; amount: number; note: string; mc: string; ref: string }
export function upiIntent(pm: UpiPayment): string {
  let s = 'upi://pay?pa=' + pm.vpa + '&pn=' + percentEncode(clipRunes(pm.payee.trim(), 99))
  const mc = pm.mc.trim()
  if (mc) { s += '&mc=' + percentEncode(mc); const ref = upiRef(pm.ref); if (ref) s += '&tr=' + ref }
  s += '&am=' + upiRupees(pm.amount) + '&cu=INR'
  const n = clipRunes(pm.note.trim(), 50)
  if (n) s += '&tn=' + percentEncode(n)
  return s
}
const UPI_APPS = [
  ['gpay', 'Google Pay', 'com.google.android.apps.nbu.paisa.user', 'tez://upi/pay'],
  ['phonepe', 'PhonePe', 'com.phonepe.app', 'phonepe://pay'],
  ['paytm', 'Paytm', 'net.one97.paytm', 'paytmmp://pay'],
  ['bhim', 'BHIM', 'in.org.npci.upiapp', 'bhim://pay'],
]
export function upiAppLinks(intent: string): Record<string, string>[] {
  const query = intent.replace(/^upi:\/\/pay\?/, '')
  const out = UPI_APPS.map(([key, label, pkg, scheme]) => ({ key, label,
    android: `intent://pay?${query}#Intent;scheme=upi;action=android.intent.action.VIEW;package=${pkg};end`, ios: `${scheme}?${query}` }))
  out.push({ key: 'other', label: 'Another UPI app' } as { key: string; label: string; android: string; ios: string })
  return out
}
