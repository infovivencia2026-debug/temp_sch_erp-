import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, forbidden, isUUID, notFound, now, ok, readJSON, uuidParam } from '../../http'
import { can } from '../../identity'
import {
  CLASS_SQL, SECTION_SQL, isDate, nameSQL, p, paise, requireFresh, requireOpenPeriod, studentPredicate, syncInvoice, syncPayment, today, recomputeNet,
} from './common'
import { auditStmt } from '../admin/common'
import { nextNumbers } from './numbering'
import { checkUTR, allocate, allocateLines, txnId } from './counter'
import { voidPayment, movePayment } from './corrections'
import { school } from '../school'

/* FEES ALL IN ONE PLACE (owner, 2026-11-21, the approved preview).

   One read for everything the counter shows about a child: each fee line
   with its instalment and what was paid on it (from payment_line_allocations,
   0136), every receipt with exactly the lines it paid, the requests waiting
   for approval and the log. And the writes the counter's side menu makes:
   assign a fee type from a plan, a one-off fee, a due date for this child,
   and requests (cancel, change, remove fee, edit amount, transfer, class
   change) that an approver decides.

   Status on screen is one of Paid / Part paid / Unpaid. No debit or credit. */

const READ = 'finance.payments.read'
const WRITE = 'finance.payments.write'
const APPROVE = 'finance.refunds.write'
const KINDS = new Set(['cancel', 'change', 'remove_fee', 'edit_amount', 'transfer', 'class_change', 'plan_change'])

const statusOf = (net: number, paid: number) => (net > 0 && paid >= net ? 'paid' : paid > 0 ? 'part_paid' : 'unpaid')
const reasonOf = (v: unknown, min = 5): string => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length < min) throw badRequest(`give a reason of at least ${min} characters; it goes on the record`)
  return s.slice(0, 500)
}
const logStmt = (c: Ctx, studentId: string, action: string, before: unknown, after: unknown) =>
  auditStmt(c, action, 'student_fees', studentId, before, after)

async function studentInScope(c: Ctx, studentId: string) {
  const scope = await studentPredicate(c, 'st')
  const row = await c.db.prepare(`SELECT st.id, st.campus_id, st.status FROM students st WHERE st.id = ? AND ${scope.sql}`).bind(studentId, ...scope.args)
    .first<{ id: string; campus_id: string; status: string }>()
  if (!row) throw notFound()
  return row
}

/** Line totals recomputed onto the invoice after a line's amount changes. */
function recomputeInvoice(c: Ctx, invoiceId: string): D1PreparedStatement[] {
  return [
    c.db.prepare(`UPDATE invoices SET gross_paise = COALESCE((SELECT sum(amount_paise) FROM invoice_lines WHERE invoice_id = ?1), 0),
                    discount_paise = COALESCE((SELECT sum(discount_paise) FROM invoice_lines WHERE invoice_id = ?1), 0) WHERE id = ?1`).bind(invoiceId),
    recomputeNet(c, invoiceId),
    ...syncInvoice(c, invoiceId),
  ]
}


/* RE-PLAN FROM A DATE (owner, 2026-11-21): a route change, or a class change
   that takes the new class's plan. Bills from the date on are cancelled and
   raised again from the new plan, one bill per instalment; money already paid
   on the cancelled bills comes off them and lands on the new ones (oldest
   first), anything left stays on the child as an advance. With a fee type,
   only bills that carry that fee alone are touched (a bill mixing it with
   other fees is refused, so nothing else is re-priced by accident). */
async function replan(c: Ctx, studentId: string, from: string, structureId: string, headId: string | null): Promise<{ cancelled: string[]; raised: string[]; moved_paise: number }> {
  const fs = await c.db.prepare(`SELECT id, academic_year_id, name FROM fee_structures WHERE id = ? AND is_active = 1`).bind(structureId).first<{ id: string; academic_year_id: string; name: string }>()
  if (!fs) throw badRequest('no active fee plan with that id')
  const st = await c.db.prepare(`SELECT campus_id FROM students WHERE id = ?`).bind(studentId).first<{ campus_id: string }>()
  if (!st) throw notFound()
  const bills = (await c.db.prepare(`SELECT i.id, i.invoice_no,
        (SELECT count(*) FROM invoice_lines il WHERE il.invoice_id = i.id) AS n,
        (SELECT count(*) FROM invoice_lines il WHERE il.invoice_id = i.id AND il.fee_head_id = ?3) AS mine
      FROM invoices i WHERE i.student_id = ?1 AND i.academic_year_id = ?2 AND i.status <> 'cancelled' AND i.instalment_no IS NOT NULL AND COALESCE(i.due_on, i.issued_on) >= ?4`)
    .bind(studentId, fs.academic_year_id, headId ?? '', from).all<{ id: string; invoice_no: string; n: number; mine: number }>()).results
  const touched = headId ? bills.filter((b) => b.mine > 0) : bills
  if (headId && touched.some((b) => b.mine !== b.n)) throw new HttpError(409, `bill ${touched.find((b) => b.mine !== b.n)!.invoice_no} mixes this fee with others; change it with Edit fee amount instead`, { code: 'mixed_bill' })
  const items = (await c.db.prepare(`SELECT fsi.fee_head_id, fsi.instalment_no, fsi.amount_paise, fsi.due_on, fh.name FROM fee_structure_items fsi JOIN fee_heads fh ON fh.id = fsi.fee_head_id
      WHERE fsi.fee_structure_id = ?1 AND fsi.amount_paise > 0 AND (?2 = '' OR fsi.fee_head_id = ?2) AND COALESCE(fsi.due_on, ?3) >= ?3 ORDER BY fsi.instalment_no`)
    .bind(fs.id, headId ?? '', from).all<{ fee_head_id: string; instalment_no: number; amount_paise: number; due_on: string | null; name: string }>()).results
  const ids = touched.map((b) => b.id)
  /* An instalment the child keeps a bill for (before the date, or on a bill not
     touched) is not billed again from the new plan. */
  const kept = new Set((await c.db.prepare(`SELECT DISTINCT i.instalment_no FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id
      WHERE i.student_id = ?1 AND i.academic_year_id = ?2 AND i.status <> 'cancelled' AND i.instalment_no IS NOT NULL AND (?3 = '' OR il.fee_head_id = ?3)
        AND i.id NOT IN (SELECT value FROM json_each(?4))`).bind(studentId, fs.academic_year_id, headId ?? '', JSON.stringify(ids)).all<{ instalment_no: number }>()).results.map((x) => x.instalment_no))
  for (let k = items.length - 1; k >= 0; k--) if (kept.has(items[k].instalment_no)) items.splice(k, 1)
  if (!ids.length && !items.length) throw new HttpError(409, 'nothing to change: every instalment of this fee is already billed before that date', { code: 'nothing_to_replan' })
  const allocs = ids.length ? (await c.db.prepare(`SELECT payment_id, sum(amount_paise) AS amt FROM payment_allocations WHERE invoice_id IN (SELECT value FROM json_each(?)) GROUP BY payment_id`)
    .bind(JSON.stringify(ids)).all<{ payment_id: string; amt: number }>()).results : []
  const groups = new Map<number, typeof items>()
  for (const it of items) groups.set(it.instalment_no, [...(groups.get(it.instalment_no) ?? []), it])
  const numbers = groups.size ? await nextNumbers(c, 'invoice', groups.size) : { texts: [] as string[], stmts: [] as D1PreparedStatement[] }
  const inst = school(c).id, t = today()
  const stmts: D1PreparedStatement[] = [...numbers.stmts]
  for (const id of ids) {
    stmts.push(c.db.prepare(`DELETE FROM payment_allocations WHERE invoice_id = ?`).bind(id))
    stmts.push(c.db.prepare(`UPDATE invoices SET status = 'cancelled', cancelled_reason = ?, paid_paise = 0, updated_at = ? WHERE id = ?`).bind(`Re-planned from ${from} to ${fs.name}`, now(), id))
  }
  const raised: string[] = []
  ;[...groups.entries()].forEach(([no, list], k) => {
    const iid = crypto.randomUUID(), gross = list.reduce((a, x) => a + p(x.amount_paise), 0), due = list[0].due_on ?? t
    raised.push(iid)
    stmts.push(c.db.prepare(`INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, instalment_no, issued_on, due_on,
                    gross_paise, discount_paise, fine_paise, net_paise, paid_paise, status, created_at, updated_at, note)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?)`)
      .bind(iid, inst, st.campus_id, studentId, fs.academic_year_id, numbers.texts[k], no, t, due, gross, gross, due < t ? 'overdue' : 'unpaid', now(), now(), `From ${fs.name}, ${from}`))
    for (const x of list) stmts.push(c.db.prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise, discount_paise) VALUES (?, ?, ?, ?, ?, ?, 0)`)
      .bind(crypto.randomUUID(), inst, iid, x.fee_head_id, x.name, p(x.amount_paise)))
  })
  for (const a of allocs) stmts.push(syncPayment(c, a.payment_id))
  await c.db.batch(stmts)
  let moved = 0
  for (const a of allocs) {
    const r = await allocate(c, studentId, a.payment_id, p(a.amt), raised).catch(() => allocate(c, studentId, a.payment_id, p(a.amt), []).catch(() => null))
    if (r) { await c.db.batch(r.stmts); moved += p(a.amt) - r.unallocated }
  }
  return { cancelled: touched.map((b) => b.invoice_no), raised: numbers.texts, moved_paise: moved }
}

/* PART OF A RECEIPT TO ANOTHER CHILD (owner, 2026-11-21). The receipt keeps
   its number and now shows what stayed on this child; the moved part becomes
   an adjustment on the other child (no new receipt number), put on the fee
   line asked for or on their oldest dues. Both sides are in the audit log
   with the original amount. */
async function partialTransfer(c: Ctx, paymentId: string, to: string, amount: number, toLine: string | null, why: string) {
  const pm = await c.db.prepare(`SELECT id, student_id, campus_id, receipt_no, amount_paise, status, paid_on, remarks FROM payments WHERE id = ?`).bind(paymentId)
    .first<{ id: string; student_id: string; campus_id: string; receipt_no: string | null; amount_paise: number; status: string; paid_on: string; remarks: string | null }>()
  if (!pm || pm.status !== 'success') throw new HttpError(409, 'only a received payment can be moved', { code: 'not_received' })
  if (amount <= 0 || amount >= p(pm.amount_paise)) throw badRequest('the amount to move must be more than nought and less than the receipt')
  const target = await c.db.prepare(`SELECT id, campus_id, ${nameSQL('students')} AS name FROM students WHERE id = ?`).bind(to).first<{ id: string; campus_id: string; name: string }>()
  if (!target) throw badRequest('no child with that id')
  await requireOpenPeriod(c, today())
  const prev = (await c.db.prepare(`SELECT invoice_id FROM payment_allocations WHERE payment_id = ? ORDER BY rowid`).bind(paymentId).all<{ invoice_id: string }>()).results.map((x) => x.invoice_id)
  const keep = p(pm.amount_paise) - amount
  const remarks = `${pm.remarks ? pm.remarks + ' | ' : ''}₹${amount / 100} moved to ${target.name} on ${today()}: ${why}`
  const stmts: D1PreparedStatement[] = [
    auditStmt(c, 'payment.partial_move', 'payment', paymentId, { amount_paise: p(pm.amount_paise) }, { amount_paise: keep, moved_paise: amount, to_student_id: to, reason: why }),
    c.db.prepare(`DELETE FROM payment_allocations WHERE payment_id = ?`).bind(paymentId),
    c.db.prepare(`UPDATE payments SET amount_paise = ?, remarks = ? WHERE id = ?`).bind(keep, remarks, paymentId),
  ]
  for (const iv of prev) stmts.push(...syncInvoice(c, iv))
  stmts.push(syncPayment(c, paymentId))
  await c.db.batch(stmts)
  const back = await allocate(c, pm.student_id, paymentId, keep, prev).catch(() => allocate(c, pm.student_id, paymentId, keep, []).catch(() => null))
  if (back) await c.db.batch(back.stmts)
  const qid = crypto.randomUUID()
  await c.db.batch([
    c.db.prepare(`INSERT INTO payments (id, institution_id, campus_id, student_id, amount_paise, allocated_paise, mode, paid_on, status, collected_by, remarks, txn_id, created_at)
                  VALUES (?, ?, ?, ?, ?, 0, 'adjustment', ?, 'success', ?, ?, ?, ?)`)
      .bind(qid, school(c).id, target.campus_id, to, amount, today(), c.id.userId, `Moved from receipt ${pm.receipt_no ?? '-'}: ${why}`, txnId(qid), now()),
    auditStmt(c, 'payment.partial_move_in', 'payment', qid, null, { from_payment_id: paymentId, amount_paise: amount, reason: why }),
  ])
  const into = toLine ? await allocateLines(c, to, qid, [{ invoice_line_id: toLine, amount_paise: amount }]).catch(() => null) : null
  const put = into ?? await allocate(c, to, qid, amount, []).catch(() => null)
  if (put) await c.db.batch(put.stmts)
  return { kept_paise: keep, moved_paise: amount, new_payment_id: qid }
}

export function registerFeeHub(r: Router): void {
  // ------------------------------------------------------------ one child
  r.get('/fees/hub/students/{id}', READ, async (c) => {
    const id = uuidParam(c.params.id)
    await studentInScope(c, id)
    const [head, lines, receipts, paidLines, requests, logs, concessions, refunds, years, fines, wallet, offline] = (await c.db.batch([
      c.db.prepare(`SELECT st.id, st.admission_no, ${nameSQL('st')} AS full_name, st.status, st.admission_date, st.photo_file_id,
             ${CLASS_SQL('st')} AS class_name, ${SECTION_SQL('st')} AS section_name,
             (SELECT e.roll_no FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS roll_no,
             (SELECT e.class_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS class_id,
             (SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS section_id,
             (SELECT count(*) FROM student_guardians sg JOIN student_guardians sib ON sib.guardian_id = sg.guardian_id AND sib.student_id <> st.id WHERE sg.student_id = st.id) AS siblings
        FROM students st WHERE st.id = ?`).bind(id),
      c.db.prepare(`SELECT il.id AS line_id, i.id AS invoice_id, i.invoice_no, i.instalment_no, i.due_on, i.status AS invoice_status, i.fine_paise,
             i.academic_year_id, COALESCE(ay.name, '') AS year, fh.id AS fee_head_id, fh.name AS fee_type, COALESCE(il.description, fh.name) AS description,
             fh.ledger_account, il.amount_paise, il.discount_paise,
             COALESCE((SELECT sum(x.amount_paise) FROM payment_line_allocations x WHERE x.invoice_line_id = il.id), 0) AS paid_paise,
             (SELECT min(il2.rowid) FROM invoice_lines il2 WHERE il2.invoice_id = i.id) = il.rowid AS first_line
        FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id JOIN fee_heads fh ON fh.id = il.fee_head_id
        LEFT JOIN academic_years ay ON ay.id = i.academic_year_id
       WHERE i.student_id = ? AND i.status <> 'cancelled'
       ORDER BY ay.starts_on DESC, i.instalment_no, COALESCE(i.due_on, i.issued_on), il.rowid`).bind(id),
      c.db.prepare(`SELECT pm.id, pm.txn_id, COALESCE(pm.receipt_no, '') AS receipt_no, pm.paid_on, pm.created_at, pm.amount_paise, pm.mode, pm.status,
             COALESCE(pm.gateway_txn_id, pm.reference_no, '') AS reference, pm.bank_name, pm.cheque_date, pm.receiving_account, pm.payer_name, pm.payer_relation,
             COALESCE(pm.remarks, '') AS remarks, pm.attachment_file_id, pm.gateway, COALESCE(u.full_name, '') AS collector
        FROM payments pm LEFT JOIN users u ON u.id = pm.collected_by WHERE pm.student_id = ?
       ORDER BY pm.paid_on DESC, pm.created_at DESC`).bind(id),
      c.db.prepare(`SELECT x.payment_id, x.amount_paise, i.invoice_no, i.instalment_no, COALESCE(ay.name, '') AS year,
             COALESCE(fh.name, 'Late fee / other') AS fee_type
        FROM payment_line_allocations x JOIN payments pm ON pm.id = x.payment_id JOIN invoices i ON i.id = x.invoice_id
        LEFT JOIN fee_heads fh ON fh.id = x.fee_head_id LEFT JOIN academic_years ay ON ay.id = i.academic_year_id
       WHERE pm.student_id = ? ORDER BY x.rowid`).bind(id),
      c.db.prepare(`SELECT fr.id, fr.kind, fr.payment_id, fr.invoice_id, fr.invoice_line_id, fr.payload, fr.reason, fr.status, fr.requested_at, fr.decided_at,
             fr.decision_note, COALESCE(a.full_name, '') AS requested_by, COALESCE(b.full_name, '') AS decided_by, pm.receipt_no
        FROM fee_requests fr LEFT JOIN users a ON a.id = fr.requested_by LEFT JOIN users b ON b.id = fr.decided_by
        LEFT JOIN payments pm ON pm.id = fr.payment_id
       WHERE fr.student_id = ? ORDER BY fr.requested_at DESC`).bind(id),
      c.db.prepare(`SELECT al.created_at, al.action, al.before, al.after, al.ip, COALESCE(u.full_name, '') AS who
        FROM audit_log al LEFT JOIN users u ON u.id = al.actor_user_id
       WHERE (al.entity_type = 'student_fees' AND al.entity_id = ?1)
          OR (al.entity_type = 'payment' AND al.entity_id IN (SELECT id FROM payments WHERE student_id = ?1))
       ORDER BY al.created_at DESC LIMIT 200`).bind(id),
      c.db.prepare(`SELECT fc.id, fc.kind, fc.percent, fc.amount_paise, fc.reason, fc.status, fc.created_at, fc.approved_at, COALESCE(fh.name, 'All fees') AS fee_type,
             COALESCE(a.full_name, '') AS requested_by, COALESCE(b.full_name, '') AS approved_by
        FROM fee_concessions fc LEFT JOIN fee_heads fh ON fh.id = fc.fee_head_id
        LEFT JOIN users a ON a.id = fc.requested_by LEFT JOIN users b ON b.id = fc.approved_by
       WHERE fc.student_id = ? ORDER BY fc.created_at DESC`).bind(id),
      c.db.prepare(`SELECT rf.id, rf.amount_paise, rf.reason, rf.status, rf.mode, rf.created_at FROM refunds rf WHERE rf.student_id = ? ORDER BY rf.created_at DESC`).bind(id),
      c.db.prepare(`SELECT id, name, starts_on, ends_on, is_current FROM academic_years ORDER BY starts_on`),
      c.db.prepare(`SELECT ch.id, ch.rule_name, ch.amount_paise, ch.days_overdue, ch.status, ch.as_of, i.invoice_no
        FROM fee_fine_charges ch JOIN invoices i ON i.id = ch.invoice_id WHERE i.student_id = ? ORDER BY ch.as_of DESC`).bind(id),
      c.db.prepare(`SELECT balance_paise FROM wallet_accounts WHERE student_id = ?`).bind(id),
      c.db.prepare(`SELECT o.id, o.amount_paise, o.mode, o.reference_no, o.paid_on, o.attachment_file_id, o.lines, o.note, o.status, o.reject_reason, o.created_at, pm.receipt_no
        FROM fee_offline_payments o LEFT JOIN payments pm ON pm.id = o.payment_id WHERE o.student_id = ? ORDER BY o.created_at DESC`).bind(id),
    ])).map((x) => x.results as Record<string, unknown>[])
    if (!head.length) throw notFound()

    const byPayment = new Map<string, { fee_type: string; instalment_no: number | null; invoice_no: string; year: string; amount_paise: number }[]>()
    for (const x of paidLines) {
      const list = byPayment.get(String(x.payment_id)) ?? []
      // One row per fee + instalment on a receipt.
      const k = list.find((y) => y.fee_type === x.fee_type && y.invoice_no === x.invoice_no)
      if (k) k.amount_paise += p(x.amount_paise as number)
      else list.push({ fee_type: String(x.fee_type), instalment_no: x.instalment_no === null ? null : Number(x.instalment_no), invoice_no: String(x.invoice_no), year: String(x.year), amount_paise: p(x.amount_paise as number) })
      byPayment.set(String(x.payment_id), list)
    }
    const feeLines = lines.map((l) => {
      const amount = p(l.amount_paise as number), disc = p(l.discount_paise as number)
      const net = Math.max(0, amount - disc), paid = Math.min(net, p(l.paid_paise as number))
      return {
        line_id: String(l.line_id), invoice_id: String(l.invoice_id), invoice_no: String(l.invoice_no), instalment_no: l.instalment_no === null ? null : Number(l.instalment_no),
        due_on: (l.due_on as string | null) ?? null, academic_year_id: String(l.academic_year_id), year: String(l.year), fee_head_id: String(l.fee_head_id),
        fee_type: String(l.fee_type), description: String(l.description), account: (l.ledger_account as string | null) ?? null,
        amount_paise: amount, concession_paise: disc, net_paise: net, paid_paise: paid, balance_paise: net - paid,
        fine_paise: Number(l.first_line) ? p(l.fine_paise as number) : 0, status: statusOf(net, paid), invoice_status: String(l.invoice_status),
      }
    })
    const success = receipts.filter((x) => x.status === 'success')
    const charged = feeLines.reduce((a, l) => a + l.net_paise + l.fine_paise, 0)
    const collected = success.reduce((a, x) => a + p(x.amount_paise as number), 0)
    const held = receipts.filter((x) => x.status === 'pending').reduce((a, x) => a + p(x.amount_paise as number), 0)
    const t = today()
    const current = years.find((y) => Number(y.is_current)) ?? null
    const old = feeLines.filter((l) => current && l.academic_year_id !== current.id && l.balance_paise > 0).reduce((a, l) => a + l.balance_paise, 0)
    const dueNow = feeLines.filter((l) => l.balance_paise > 0 && (!l.due_on || l.due_on <= t)).reduce((a, l) => a + l.balance_paise + l.fine_paise, 0)

    /* Fee types this child is not billed for this year, with the plans
       (fee structures) of this year that price them. */
    const yearId = String(c.url.searchParams.get('year') || current?.id || '')
    const billed = new Set(feeLines.filter((l) => l.academic_year_id === yearId).map((l) => l.fee_head_id))
    const plans = yearId ? (await c.db.prepare(`
      SELECT fh.id AS fee_head_id, fh.name AS fee_type, fh.optional, fs.id AS structure_id, fs.name AS plan, COALESCE(cl.name, 'All classes') AS class_name,
             sum(fsi.amount_paise) AS amount_paise, count(*) AS instalments
        FROM fee_structure_items fsi JOIN fee_structures fs ON fs.id = fsi.fee_structure_id AND fs.is_active = 1 AND fs.academic_year_id = ?1
        JOIN fee_heads fh ON fh.id = fsi.fee_head_id LEFT JOIN classes cl ON cl.id = fs.class_id
       GROUP BY fh.id, fs.id ORDER BY fh.name, fs.name`).bind(yearId).all<Record<string, unknown>>()).results : []
    const available = new Map<string, { fee_head_id: string; fee_type: string; optional: boolean; plans: { structure_id: string; plan: string; class_name: string; amount_paise: number; instalments: number }[] }>()
    for (const pl of plans) {
      if (billed.has(String(pl.fee_head_id))) continue
      const a = available.get(String(pl.fee_head_id)) ?? { fee_head_id: String(pl.fee_head_id), fee_type: String(pl.fee_type), optional: !!Number(pl.optional), plans: [] }
      a.plans.push({ structure_id: String(pl.structure_id), plan: String(pl.plan), class_name: String(pl.class_name), amount_paise: p(pl.amount_paise as number), instalments: Number(pl.instalments) })
      available.set(a.fee_head_id, a)
    }

    return ok({
      student: head[0],
      years: years.map((y) => ({ id: String(y.id), name: String(y.name), is_current: !!Number(y.is_current), starts_on: String(y.starts_on) })),
      totals: { charged_paise: charged, collected_paise: collected, balance_paise: charged - collected, held_paise: held, old_dues_paise: old, due_now_paise: dueNow,
        wallet_paise: p((wallet[0]?.balance_paise as number | undefined) ?? 0) },
      lines: feeLines,
      receipts: receipts.map((x) => ({ ...x, amount_paise: p(x.amount_paise as number), lines: byPayment.get(String(x.id)) ?? [] })),
      requests: requests.map((x) => ({ ...x, payload: JSON.parse(String(x.payload || '{}')) })),
      logs, concessions, refunds, fines,
      offline: offline.map((x) => ({ ...x, amount_paise: p(x.amount_paise as number), lines: JSON.parse(String(x.lines || '[]')) })),
      available: [...available.values()],
    })
  })

  // ------------------------------------------------------------ assign a fee type from a plan
  r.post('/fees/hub/assign', WRITE, async (c) => {
    const req = await readJSON<{ student_id?: string; fee_head_id?: string; fee_structure_id?: string }>(c.req)
    if (!isUUID(req.student_id) || !isUUID(req.fee_head_id) || !isUUID(req.fee_structure_id)) throw badRequest('student_id, fee_head_id and fee_structure_id are needed')
    const st = await studentInScope(c, req.student_id!)
    const fs = await c.db.prepare(`SELECT id, academic_year_id, campus_id, name FROM fee_structures WHERE id = ? AND is_active = 1`).bind(req.fee_structure_id)
      .first<{ id: string; academic_year_id: string; campus_id: string; name: string }>()
    if (!fs) throw badRequest('no active fee plan with that id')
    await requireOpenPeriod(c, today())
    const items = (await c.db.prepare(`SELECT fsi.instalment_no, fsi.amount_paise, fsi.due_on, fh.name FROM fee_structure_items fsi JOIN fee_heads fh ON fh.id = fsi.fee_head_id
        WHERE fsi.fee_structure_id = ? AND fsi.fee_head_id = ? AND fsi.amount_paise > 0 ORDER BY fsi.instalment_no`).bind(fs.id, req.fee_head_id).all<{ instalment_no: number; amount_paise: number; due_on: string | null; name: string }>()).results
    if (!items.length) throw badRequest('that plan has nothing priced for this fee type')
    const dup = await c.db.prepare(`SELECT 1 FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
        WHERE i.student_id = ? AND i.academic_year_id = ? AND il.fee_head_id = ? AND i.status <> 'cancelled' LIMIT 1`).bind(st.id, fs.academic_year_id, req.fee_head_id).first()
    if (dup) throw new HttpError(409, 'this fee type is already on the child for that year', { code: 'already_assigned' })
    /* Joining mid-year: instalments whose due date has passed are still billed,
       because the school decides that; only nought-priced ones are skipped. */
    const numbers = await nextNumbers(c, 'invoice', items.length)
    const inst = school(c).id
    const stmts: D1PreparedStatement[] = [...numbers.stmts]
    const t = today()
    items.forEach((it, n) => {
      const invoiceId = crypto.randomUUID()
      const due = it.due_on ?? t
      stmts.push(c.db.prepare(`INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, instalment_no, issued_on, due_on,
                      gross_paise, discount_paise, fine_paise, net_paise, paid_paise, status, created_at, updated_at, note)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?)`)
        .bind(invoiceId, inst, st.campus_id, st.id, fs.academic_year_id, numbers.texts[n], it.instalment_no, t, due, p(it.amount_paise), p(it.amount_paise),
          due < t ? 'overdue' : 'unpaid', now(), now(), `Assigned from ${fs.name}`))
      stmts.push(c.db.prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise, discount_paise) VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .bind(crypto.randomUUID(), inst, invoiceId, req.fee_head_id, it.name, p(it.amount_paise)))
    })
    stmts.push(c.db.prepare(`INSERT INTO student_fee_optins (id, institution_id, student_id, academic_year_id, fee_head_id, chosen_on, note, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM fee_heads WHERE id = ? AND optional = 1)
          AND NOT EXISTS (SELECT 1 FROM student_fee_optins WHERE student_id = ? AND academic_year_id = ? AND fee_head_id = ? AND ended_on IS NULL)`)
      .bind(crypto.randomUUID(), inst, st.id, fs.academic_year_id, req.fee_head_id, t, 'Assigned at the fee counter', now(), req.fee_head_id, st.id, fs.academic_year_id, req.fee_head_id))
    stmts.push(logStmt(c, st.id, 'fee.assign', null, { fee_head: items[0].name, plan: fs.name, instalments: items.length, amount_paise: items.reduce((a, x) => a + p(x.amount_paise), 0) }))
    await c.db.batch(stmts)
    return ok({ invoices: numbers.texts })
  })

  // ------------------------------------------------------------ one-off fee (lost book, uniform, ID card)
  r.post('/fees/hub/misc', WRITE, async (c) => {
    const req = await readJSON<{ student_id?: string; fee_head_id?: string; item?: string; rate_paise?: unknown; qty?: unknown; concession_paise?: unknown; due_on?: string }>(c.req)
    if (!isUUID(req.student_id) || !isUUID(req.fee_head_id)) throw badRequest('student_id and fee_head_id are needed')
    const st = await studentInScope(c, req.student_id!)
    const item = (req.item ?? '').trim().slice(0, 120)
    if (!item) throw badRequest('say what the fee is for')
    const rate = paise(req.rate_paise, 'rate_paise'), qty = Math.trunc(Number(req.qty ?? 1))
    if (rate <= 0 || !(qty >= 1 && qty <= 1000)) throw badRequest('rate must be above nought and quantity 1 to 1000')
    const gross = rate * qty, disc = paise(req.concession_paise ?? 0, 'concession_paise')
    if (disc > gross) throw badRequest('the concession is more than the fee')
    const due = req.due_on && isDate(req.due_on) ? req.due_on : today()
    await requireOpenPeriod(c, today())
    const year = await c.db.prepare(`SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1`).first<{ id: string }>()
    if (!year) throw badRequest('no current academic year is set')
    const head = await c.db.prepare(`SELECT name FROM fee_heads WHERE id = ?`).bind(req.fee_head_id).first<{ name: string }>()
    if (!head) throw badRequest('no fee type with that id')
    const numbers = await nextNumbers(c, 'invoice', 1)
    const inst = school(c).id, invoiceId = crypto.randomUUID()
    await c.db.batch([
      ...numbers.stmts,
      c.db.prepare(`INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, instalment_no, issued_on, due_on,
                      gross_paise, discount_paise, fine_paise, net_paise, paid_paise, status, created_at, updated_at, note)
                    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, 0, 'unpaid', ?, ?, ?)`)
        .bind(invoiceId, inst, st.campus_id, st.id, year.id, numbers.texts[0], today(), due, gross, disc, gross - disc, now(), now(), 'Misc. fee: ' + item),
      c.db.prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise, discount_paise) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), inst, invoiceId, req.fee_head_id, qty > 1 ? `${item} x ${qty}` : item, gross, disc),
      logStmt(c, st.id, 'fee.misc', null, { item, fee_head: head.name, qty, rate_paise: rate, concession_paise: disc, invoice_no: numbers.texts[0] }),
    ])
    return ok({ invoice_no: numbers.texts[0] })
  })

  // ------------------------------------------------------------ due date for this child
  r.post('/fees/hub/due-date', WRITE, async (c) => {
    const req = await readJSON<{ invoice_id?: string; due_on?: string; reason?: string }>(c.req)
    if (!isUUID(req.invoice_id) || !isDate(req.due_on ?? '')) throw badRequest('invoice_id and due_on (YYYY-MM-DD) are needed')
    const inv = await c.db.prepare(`SELECT id, student_id, invoice_no, due_on, status FROM invoices WHERE id = ?`).bind(req.invoice_id)
      .first<{ id: string; student_id: string; invoice_no: string; due_on: string | null; status: string }>()
    if (!inv) throw notFound()
    await studentInScope(c, inv.student_id)
    if (inv.status === 'paid' || inv.status === 'cancelled') throw badRequest('that bill is settled; its due date no longer matters')
    const why = reasonOf(req.reason)
    await c.db.batch([
      c.db.prepare(`UPDATE invoices SET due_on = ?, updated_at = ? WHERE id = ?`).bind(req.due_on, now(), inv.id),
      ...syncInvoice(c, inv.id),
      logStmt(c, inv.student_id, 'fee.due_date', { invoice_no: inv.invoice_no, due_on: inv.due_on }, { invoice_no: inv.invoice_no, due_on: req.due_on, reason: why }),
    ])
    return ok({ id: inv.id, due_on: req.due_on })
  })

  // ------------------------------------------------------------ requests that wait for approval
  r.post('/fees/hub/requests', WRITE, async (c) => {
    const req = await readJSON<{ student_id?: string; kind?: string; payment_id?: string; invoice_line_id?: string; payload?: Record<string, unknown>; reason?: string }>(c.req)
    if (!isUUID(req.student_id)) throw badRequest('student_id is needed')
    const kind = req.kind ?? ''
    if (!KINDS.has(kind)) throw badRequest('unknown request kind')
    const st = await studentInScope(c, req.student_id!)
    const why = reasonOf(req.reason, kind === 'cancel' || kind === 'transfer' ? 10 : 5)
    const payload = req.payload ?? {}
    let paymentId: string | null = null, lineId: string | null = null, invoiceId: string | null = null
    if (['cancel', 'change', 'transfer'].includes(kind)) {
      if (!isUUID(req.payment_id)) throw badRequest('choose the receipt')
      const pm = await c.db.prepare(`SELECT id, status FROM payments WHERE id = ? AND student_id = ?`).bind(req.payment_id, st.id).first<{ id: string; status: string }>()
      if (!pm) throw badRequest("that receipt is not this child's")
      if (pm.status === 'cancelled' || pm.status === 'bounced') throw badRequest('that receipt is already off the books')
      paymentId = pm.id
      if (kind === 'transfer') {
        if (!isUUID(payload.to_student_id)) throw badRequest('choose the child the money goes to')
        if (payload.to_student_id === st.id) throw badRequest('that is the same child')
      }
      if (kind === 'change') {
        const mode = String(payload.mode ?? '')
        if (mode && !['cash', 'upi', 'card', 'neft', 'netbanking', 'cheque', 'dd'].includes(mode)) throw badRequest('unsupported payment mode')
        if (payload.paid_on && !isDate(String(payload.paid_on))) throw badRequest('paid_on must be YYYY-MM-DD')
      }
    }
    if (kind === 'remove_fee' || kind === 'edit_amount') {
      if (!isUUID(req.invoice_line_id)) throw badRequest('choose the fee line')
      const ln = await c.db.prepare(`SELECT il.id, il.invoice_id FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.id = ? AND i.student_id = ?`)
        .bind(req.invoice_line_id, st.id).first<{ id: string; invoice_id: string }>()
      if (!ln) throw badRequest("that fee line is not this child's")
      lineId = ln.id; invoiceId = ln.invoice_id
      if (kind === 'edit_amount' && !(paise(payload.amount_paise, 'amount_paise') > 0)) throw badRequest('the new amount must be above nought')
    }
    if (kind === 'class_change' && !isUUID(payload.section_id)) throw badRequest('choose the new section')
    if (kind === 'class_change' && payload.use_new_plan && !isDate(String(payload.from ?? ''))) throw badRequest('give the date the new plan starts')
    if (kind === 'transfer' && payload.amount_paise !== undefined && !(paise(payload.amount_paise, 'amount_paise') > 0)) throw badRequest('the amount to move must be above nought')
    if (kind === 'plan_change') {
      if (!isUUID(payload.fee_head_id) || !isUUID(payload.structure_id)) throw badRequest('choose the fee type and the new plan')
      if (!isDate(String(payload.from ?? ''))) throw badRequest('give the date the new plan starts')
    }
    const pending = await c.db.prepare(`SELECT 1 FROM fee_requests WHERE student_id = ? AND kind = ? AND status = 'pending'
        AND COALESCE(payment_id, '') = COALESCE(?, '') AND COALESCE(invoice_line_id, '') = COALESCE(?, '')`).bind(st.id, kind, paymentId, lineId).first()
    if (pending) throw new HttpError(409, 'the same request is already waiting for approval', { code: 'already_pending' })
    const reqId = crypto.randomUUID()
    const ip = c.req.headers.get('cf-connecting-ip') ?? null
    await c.db.batch([
      c.db.prepare(`INSERT INTO fee_requests (id, institution_id, student_id, kind, payment_id, invoice_id, invoice_line_id, payload, reason, requested_by, requested_at, request_ip)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(reqId, school(c).id, st.id, kind, paymentId, invoiceId, lineId, JSON.stringify(payload), why, c.id.userId, now(), ip),
      logStmt(c, st.id, 'fee.request.' + kind, null, { request_id: reqId, payment_id: paymentId, invoice_line_id: lineId, payload, reason: why }),
    ])
    return ok({ id: reqId, status: 'pending' })
  })

  r.get('/fees/hub/requests', READ, async (c) => {
    const status = c.url.searchParams.get('status') ?? 'pending'
    const rows = await c.db.prepare(`SELECT fr.id, fr.kind, fr.student_id, fr.payload, fr.reason, fr.status, fr.requested_at, fr.decided_at, fr.decision_note,
           ${nameSQL('st')} AS student, st.admission_no, pm.receipt_no, COALESCE(a.full_name, '') AS requested_by, COALESCE(b.full_name, '') AS decided_by
        FROM fee_requests fr JOIN students st ON st.id = fr.student_id LEFT JOIN payments pm ON pm.id = fr.payment_id
        LEFT JOIN users a ON a.id = fr.requested_by LEFT JOIN users b ON b.id = fr.decided_by
       WHERE (?1 = 'all' OR fr.status = ?1) ORDER BY fr.requested_at DESC LIMIT 300`).bind(status).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((x) => ({ ...x, payload: JSON.parse(String(x.payload || '{}')) })) })
  })

  r.post('/fees/hub/requests/{id}/decide', APPROVE, async (c) => {
    const id = uuidParam(c.params.id)
    await requireFresh(c)
    const req = await readJSON<{ approve?: boolean; note?: string }>(c.req)
    const fr = await c.db.prepare(`SELECT * FROM fee_requests WHERE id = ?`).bind(id).first<{ id: string; student_id: string; kind: string; payment_id: string | null; invoice_id: string | null;
      invoice_line_id: string | null; payload: string; reason: string; status: string; requested_by: string | null }>()
    if (!fr) throw notFound()
    if (fr.status !== 'pending') throw new HttpError(409, 'this request has already been decided', { code: 'decided' })
    if (fr.requested_by && fr.requested_by === c.id.userId && !c.id.roles.includes('institution_admin')) throw forbidden('a request is approved by someone other than the person who made it')
    const note = (req.note ?? '').trim().slice(0, 500)
    const close = (status: string) => c.db.prepare(`UPDATE fee_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = NULLIF(?, '') WHERE id = ? AND status = 'pending'`)
      .bind(status, c.id.userId, now(), note, id)
    if (!req.approve) {
      await c.db.batch([close('rejected'), logStmt(c, fr.student_id, 'fee.request.rejected', { request_id: id, kind: fr.kind }, { note })])
      return ok({ id, status: 'rejected' })
    }
    const payload = JSON.parse(fr.payload || '{}') as Record<string, unknown>
    const why = `${fr.reason} (request approved${note ? ': ' + note : ''})`
    const stmts: D1PreparedStatement[] = []
    switch (fr.kind) {
      case 'cancel':
        await voidPayment(c, fr.payment_id!, why)
        break
      case 'transfer': {
        const whole = await c.db.prepare(`SELECT amount_paise FROM payments WHERE id = ?`).bind(fr.payment_id).first<{ amount_paise: number }>()
        const amt = payload.amount_paise === undefined ? p(whole?.amount_paise) : paise(payload.amount_paise, 'amount_paise')
        if (amt >= p(whole?.amount_paise)) await movePayment(c, fr.payment_id!, String(payload.to_student_id), why)
        else await partialTransfer(c, fr.payment_id!, String(payload.to_student_id), amt, isUUID(payload.to_line_id) ? String(payload.to_line_id) : null, why)
        break
      }
      case 'plan_change': {
        const r2 = await replan(c, fr.student_id, String(payload.from), String(payload.structure_id), String(payload.fee_head_id))
        stmts.push(logStmt(c, fr.student_id, 'fee.plan_change', { cancelled: r2.cancelled }, { raised: r2.raised, moved_paise: r2.moved_paise, from: payload.from, reason: why }))
        break
      }
      case 'change': {
        const pm = await c.db.prepare(`SELECT id, mode, reference_no, paid_on, remarks, bank_name, receiving_account FROM payments WHERE id = ?`).bind(fr.payment_id)
          .first<Record<string, string | null>>()
        if (!pm) throw notFound()
        const mode = String(payload.mode || pm.mode), ref = payload.reference_no === undefined ? (pm.reference_no ?? '') : String(payload.reference_no).trim()
        await checkUTR(c, mode, ref, String(pm.id))
        const paidOn = String(payload.paid_on || pm.paid_on)
        await requireOpenPeriod(c, paidOn)
        stmts.push(c.db.prepare(`UPDATE payments SET mode = ?, reference_no = NULLIF(?, ''), paid_on = ?, bank_name = COALESCE(NULLIF(?, ''), bank_name),
            receiving_account = COALESCE(NULLIF(?, ''), receiving_account), remarks = COALESCE(NULLIF(?, ''), remarks) WHERE id = ?`)
          .bind(mode, ref, paidOn, String(payload.bank_name ?? ''), String(payload.receiving_account ?? ''), String(payload.remarks ?? ''), pm.id))
        stmts.push(auditStmt(c, 'payment.change', 'payment', String(pm.id), pm, { mode, reference_no: ref, paid_on: paidOn, reason: why }))
        break
      }
      case 'remove_fee': {
        const used = await c.db.prepare(`SELECT COALESCE(sum(amount_paise), 0) AS n FROM payment_line_allocations WHERE invoice_line_id = ?`).bind(fr.invoice_line_id).first<{ n: number }>()
        if (p(used?.n) > 0) throw new HttpError(409, 'money has been paid on this fee line; cancel or transfer that receipt first', { code: 'line_paid' })
        const line = await c.db.prepare(`SELECT * FROM invoice_lines WHERE id = ?`).bind(fr.invoice_line_id).first<Record<string, unknown>>()
        if (!line) throw notFound()
        const left = await c.db.prepare(`SELECT count(*) AS n FROM invoice_lines WHERE invoice_id = ?`).bind(fr.invoice_id).first<{ n: number }>()
        const paidInv = await c.db.prepare(`SELECT paid_paise FROM invoices WHERE id = ?`).bind(fr.invoice_id).first<{ paid_paise: number }>()
        stmts.push(c.db.prepare(`DELETE FROM invoice_lines WHERE id = ?`).bind(fr.invoice_line_id))
        if (p(left?.n) <= 1 && p(paidInv?.paid_paise) === 0) {
          stmts.push(c.db.prepare(`UPDATE invoices SET status = 'cancelled', cancelled_reason = ?, gross_paise = 0, discount_paise = 0, net_paise = 0, updated_at = ? WHERE id = ?`).bind(why, now(), fr.invoice_id))
        } else stmts.push(...recomputeInvoice(c, fr.invoice_id!))
        stmts.push(logStmt(c, fr.student_id, 'fee.remove', line, { reason: why }))
        break
      }
      case 'edit_amount': {
        const amt = paise(payload.amount_paise, 'amount_paise')
        const line = await c.db.prepare(`SELECT id, amount_paise, discount_paise, description FROM invoice_lines WHERE id = ?`).bind(fr.invoice_line_id).first<{ id: string; amount_paise: number; discount_paise: number; description: string }>()
        if (!line) throw notFound()
        const used = await c.db.prepare(`SELECT COALESCE(sum(amount_paise), 0) AS n FROM payment_line_allocations WHERE invoice_line_id = ?`).bind(line.id).first<{ n: number }>()
        if (amt - p(line.discount_paise) < p(used?.n)) throw new HttpError(409, 'the new amount is less than what has already been paid on this line', { code: 'below_paid' })
        stmts.push(c.db.prepare(`UPDATE invoice_lines SET amount_paise = ? WHERE id = ?`).bind(amt, line.id))
        stmts.push(...recomputeInvoice(c, fr.invoice_id!))
        stmts.push(logStmt(c, fr.student_id, 'fee.edit_amount', { line: line.description, amount_paise: p(line.amount_paise) }, { amount_paise: amt, reason: why }))
        break
      }
      case 'class_change': {
        /* The child moves section with their bills as they are: the fees
           and the money paid on them stay on the child. */
        const sec = await c.db.prepare(`SELECT id, class_id FROM sections WHERE id = ?`).bind(String(payload.section_id)).first<{ id: string; class_id: string }>()
        if (!sec) throw badRequest('no section with that id')
        const en = await c.db.prepare(`SELECT e.id, e.class_id, e.section_id FROM enrollments e JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.is_current = 1
            WHERE e.student_id = ? AND e.status = 'active' LIMIT 1`).bind(fr.student_id).first<{ id: string; class_id: string; section_id: string }>()
        if (!en) throw badRequest('the child has no current enrolment')
        await c.db.batch([c.db.prepare(`UPDATE enrollments SET class_id = ?, section_id = ? WHERE id = ?`).bind(sec.class_id, sec.id, en.id)])
        let replanned: unknown = null
        if (payload.use_new_plan && sec.class_id !== en.class_id) {
          /* The new class's main plan: the largest active one for the year (as Raise fees picks it). */
          const plan = await c.db.prepare(`SELECT fs.id FROM fee_structures fs JOIN academic_years ay ON ay.id = fs.academic_year_id AND ay.is_current = 1
              WHERE fs.class_id = ? AND fs.is_active = 1 ORDER BY (SELECT COALESCE(sum(amount_paise), 0) FROM fee_structure_items WHERE fee_structure_id = fs.id) DESC LIMIT 1`).bind(sec.class_id).first<{ id: string }>()
          if (!plan) throw badRequest('the new class has no fee plan for this year; set one up first or keep the same fees')
          replanned = await replan(c, fr.student_id, String(payload.from), plan.id, null)
        }
        stmts.push(logStmt(c, fr.student_id, 'fee.class_change', en, { class_id: sec.class_id, section_id: sec.id, reason: why, replanned }))
        break
      }
    }
    stmts.push(close('approved'))
    await c.db.batch(stmts)
    return ok({ id, status: 'approved' })
  })

  // ------------------------------------------------------------ fee day sheet: one row per fee line paid
  r.get('/fees/hub/day-sheet', READ, async (c) => {
    if (!can(c.id, 'finance.export') && !can(c.id, 'finance.refunds.write') && !can(c.id, WRITE)) throw forbidden()
    const all = can(c.id, 'finance.export') || can(c.id, 'finance.refunds.write')
    const q = c.url.searchParams
    const from = q.get('from') ?? today(), to = q.get('to') ?? from
    if (!isDate(from) || !isDate(to)) throw badRequest('from and to must be dates (YYYY-MM-DD)')
    const by = all ? (q.get('collector') ?? '') : (c.id.userId ?? '')
    const dateCol = q.get('date_type') === 'entry' ? 'substr(pm.created_at, 1, 10)' : 'pm.paid_on'
    const rows = await c.db.prepare(`
      SELECT pm.id AS payment_id, pm.txn_id, COALESCE(pm.receipt_no, '') AS receipt_no, pm.paid_on, pm.created_at, pm.mode, pm.status,
             COALESCE(pm.gateway_txn_id, pm.reference_no, '') AS reference, COALESCE(pm.receiving_account, '') AS account, COALESCE(pm.remarks, '') AS remarks,
             pm.gateway, COALESCE(u.full_name, CASE WHEN pm.collected_by IS NULL THEN 'Imported / online' ELSE '' END) AS collector,
             st.id AS student_id, st.admission_no, ${nameSQL('st')} AS student, ${CLASS_SQL('st')} AS class_name, ${SECTION_SQL('st')} AS section_name,
             (SELECT e.class_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1) AS class_id,
             x.fee_head_id, COALESCE(fh.name, CASE WHEN x.payment_id IS NULL THEN NULL ELSE 'Late fee / other' END) AS fee_type, i.instalment_no,
             COALESCE(x.amount_paise, pm.amount_paise) AS amount_paise
        FROM payments pm JOIN students st ON st.id = pm.student_id LEFT JOIN users u ON u.id = pm.collected_by
        LEFT JOIN payment_line_allocations x ON x.payment_id = pm.id LEFT JOIN fee_heads fh ON fh.id = x.fee_head_id LEFT JOIN invoices i ON i.id = x.invoice_id
       WHERE ${dateCol} BETWEEN ?1 AND ?2 AND (?3 = '' OR pm.mode = ?3) AND (?4 = '' OR (?4 = 'none' AND pm.collected_by IS NULL) OR pm.collected_by = ?4)
       ORDER BY pm.paid_on DESC, pm.created_at DESC, x.rowid LIMIT 10000`).bind(from, to, q.get('mode') ?? '', by).all<Record<string, unknown>>()
    const collectors = all ? (await c.db.prepare(`SELECT DISTINCT pm.collected_by AS id, COALESCE(u.full_name, '') AS name FROM payments pm
        LEFT JOIN users u ON u.id = pm.collected_by WHERE pm.collected_by IS NOT NULL ORDER BY name`).all<{ id: string; name: string }>()).results : []
    return ok({ from, to, all, collectors, items: rows.results.map((x) => ({ ...x, amount_paise: p(x.amount_paise as number) })) })
  })

  // ------------------------------------------------------------ fee setup at a glance (read only; edited on the setup screens)
  r.get('/fees/hub/setup', READ, async (c) => {
    const years = (await c.db.prepare(`SELECT id, name, is_current, starts_on FROM academic_years ORDER BY starts_on`).all<Record<string, unknown>>()).results
    const cur = years.find((y) => Number(y.is_current))
    const yearId = c.url.searchParams.get('year') || String(cur?.id ?? '')
    const [plans, items] = (await c.db.batch([
      c.db.prepare(`SELECT fs.id, fs.name, COALESCE(cl.name, 'All classes') AS class_name, fs.is_active,
             (SELECT count(DISTINCT i.student_id) FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id
               WHERE i.academic_year_id = fs.academic_year_id AND i.status <> 'cancelled'
                 AND il.fee_head_id IN (SELECT fee_head_id FROM fee_structure_items WHERE fee_structure_id = fs.id)
                 AND (fs.class_id IS NULL OR i.student_id IN (SELECT student_id FROM enrollments WHERE class_id = fs.class_id AND academic_year_id = fs.academic_year_id))) AS students
        FROM fee_structures fs LEFT JOIN classes cl ON cl.id = fs.class_id WHERE fs.academic_year_id = ? ORDER BY cl.name, fs.name`).bind(yearId),
      c.db.prepare(`SELECT fsi.fee_structure_id, fh.name AS fee_type, fsi.instalment_no, fsi.amount_paise, fsi.due_on
        FROM fee_structure_items fsi JOIN fee_heads fh ON fh.id = fsi.fee_head_id JOIN fee_structures fs ON fs.id = fsi.fee_structure_id
       WHERE fs.academic_year_id = ? ORDER BY fh.name, fsi.instalment_no`).bind(yearId),
    ])).map((x) => x.results as Record<string, unknown>[])
    return ok({ year_id: yearId, years, plans: plans.map((pl) => ({ ...pl, items: items.filter((i) => i.fee_structure_id === pl.id) })) })
  })

  // ------------------------------------------------------------ offline payments the family reported (0137)
  r.get('/fees/hub/offline', READ, async (c) => {
    const q = c.url.searchParams
    const student = q.get('student_id') ?? ''
    if (student && !isUUID(student)) throw badRequest('student_id must be a uuid')
    const status = q.get('status') ?? 'pending'
    const rows = await c.db.prepare(`SELECT o.id, o.student_id, o.amount_paise, o.mode, o.reference_no, o.paid_on, o.attachment_file_id, o.lines, o.note, o.status,
           o.reject_reason, o.created_at, o.decided_at, pm.receipt_no, ${nameSQL('st')} AS student, st.admission_no, COALESCE(u.full_name, '') AS submitted_by
        FROM fee_offline_payments o JOIN students st ON st.id = o.student_id LEFT JOIN payments pm ON pm.id = o.payment_id LEFT JOIN users u ON u.id = o.submitted_by
       WHERE (?1 = '' OR o.student_id = ?1) AND (?2 = 'all' OR o.status = ?2) ORDER BY o.created_at DESC LIMIT 300`).bind(student, status).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((x) => ({ ...x, amount_paise: p(x.amount_paise as number), lines: JSON.parse(String(x.lines || '[]')) })) })
  })

  r.post('/fees/hub/offline/{id}/reject', WRITE, async (c) => {
    const id = uuidParam(c.params.id)
    const req = await readJSON<{ reason?: string }>(c.req)
    const why = reasonOf(req.reason)
    const o = await c.db.prepare(`SELECT id, student_id, status, amount_paise, reference_no FROM fee_offline_payments WHERE id = ?`).bind(id).first<{ id: string; student_id: string; status: string; amount_paise: number; reference_no: string | null }>()
    if (!o) throw notFound()
    await studentInScope(c, o.student_id)
    if (o.status !== 'pending') throw new HttpError(409, 'this report has already been dealt with', { code: 'decided' })
    await c.db.batch([
      c.db.prepare(`UPDATE fee_offline_payments SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`).bind(why, c.id.userId, now(), id),
      logStmt(c, o.student_id, 'fee.offline.rejected', null, { amount_paise: p(o.amount_paise), reference_no: o.reference_no, reason: why }),
    ])
    return ok({ id, status: 'rejected' })
  })

  // ------------------------------------------------------------ copy fee plans to another year with a % increase
  r.post('/fees/hub/copy-plans', 'finance.fees.write', async (c) => {
    const req = await readJSON<{ from_year?: string; to_year?: string; percent?: unknown; dry_run?: boolean }>(c.req)
    if (!isUUID(req.from_year) || !isUUID(req.to_year) || req.from_year === req.to_year) throw badRequest('choose two different years')
    const pct = Number(req.percent ?? 0)
    if (!Number.isFinite(pct) || pct < -50 || pct > 100) throw badRequest('the increase must be between -50% and 100%')
    const plans = (await c.db.prepare(`SELECT fs.id, fs.campus_id, fs.class_id, fs.name, fs.applies_to, COALESCE(cl.name, 'All classes') AS class_name,
          EXISTS (SELECT 1 FROM fee_structures x WHERE x.academic_year_id = ?2 AND x.name = fs.name AND COALESCE(x.class_id, '') = COALESCE(fs.class_id, '')) AS exists_already
        FROM fee_structures fs LEFT JOIN classes cl ON cl.id = fs.class_id WHERE fs.academic_year_id = ?1 AND fs.is_active = 1 ORDER BY cl.name, fs.name`)
      .bind(req.from_year, req.to_year).all<{ id: string; campus_id: string; class_id: string | null; name: string; applies_to: string | null; class_name: string; exists_already: number }>()).results
    const items = (await c.db.prepare(`SELECT fsi.fee_structure_id, fsi.fee_head_id, fsi.instalment_no, fsi.amount_paise, fsi.due_on, fh.name AS fee_type
        FROM fee_structure_items fsi JOIN fee_heads fh ON fh.id = fsi.fee_head_id JOIN fee_structures fs ON fs.id = fsi.fee_structure_id WHERE fs.academic_year_id = ?`)
      .bind(req.from_year).all<{ fee_structure_id: string; fee_head_id: string; instalment_no: number; amount_paise: number; due_on: string | null; fee_type: string }>()).results
    // Rounded to the rupee; a due date moves on by one year.
    const up = (a: number) => Math.round((p(a) * (100 + pct)) / 100 / 100) * 100
    const nextYear = (d: string | null) => (d && isDate(d) ? `${Number(d.slice(0, 4)) + 1}${d.slice(4)}` : null)
    const preview = plans.map((pl) => {
      const mine = items.filter((i) => i.fee_structure_id === pl.id)
      return { plan: pl.name, class_name: pl.class_name, skipped: !!Number(pl.exists_already), old_paise: mine.reduce((a, i) => a + p(i.amount_paise), 0), new_paise: mine.reduce((a, i) => a + up(i.amount_paise), 0), instalments: mine.length }
    })
    if (req.dry_run) return ok({ percent: pct, plans: preview })
    const inst = school(c).id
    const stmts: D1PreparedStatement[] = []
    for (const pl of plans) {
      if (Number(pl.exists_already)) continue
      const nid = crypto.randomUUID()
      stmts.push(c.db.prepare(`INSERT INTO fee_structures (id, institution_id, campus_id, academic_year_id, class_id, name, applies_to, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .bind(nid, inst, pl.campus_id, req.to_year, pl.class_id, pl.name, pl.applies_to, now()))
      for (const i of items.filter((x) => x.fee_structure_id === pl.id)) {
        stmts.push(c.db.prepare(`INSERT INTO fee_structure_items (id, institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise, due_on) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), inst, nid, i.fee_head_id, i.instalment_no, up(i.amount_paise), nextYear(i.due_on)))
      }
    }
    stmts.push(auditStmt(c, 'fee.copy_plans', 'fee_structures', null, { from_year: req.from_year }, { to_year: req.to_year, percent: pct, copied: preview.filter((x) => !x.skipped).length }))
    for (let i = 0; i < stmts.length; i += 50) await c.db.batch(stmts.slice(i, i + 50))
    return ok({ percent: pct, plans: preview, copied: preview.filter((x) => !x.skipped).length })
  })
}
