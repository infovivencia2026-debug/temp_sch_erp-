import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, isUUID, notFound, now, ok, readJSON, uuidParam } from '../../http'
import { allocate } from './counter'
import { fin, notifyStmt, requireFresh, requireOpenPeriod, syncInvoice, syncPayment, isDate } from './common'
import { school } from '../school'
import { auditStmt } from '../admin/common'

/* Corrections to money already taken. Each one is rare, each one is what an
   accountant rings about, and each leaves a trail: the payment row keeps its
   receipt number and says what happened to it in remarks.

   - void: a receipt issued by mistake. Allocations come off the invoices,
     the payment is marked cancelled with the reason, the money is treated
     as never received (it was never banked, or has been handed back).
   - move: a payment taken against the wrong child. The receipt moves to the
     right child and is allocated to that child's dues.
   - force success: an online payment the gateway confirmed by phone or
     email but never called back about. The office marks it received and
     it allocates like any other payment.
   - end a fee for a class: a fee head that should stop from a date for a
     whole class or section (a club that closed, a bus route withdrawn), done
     once instead of child by child.

   Every write needs a fresh sign-in and an open period, like the counter. */

const WRITE = 'finance.payments.write'
const APPROVE = 'finance.refunds.write'
const reason = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length < 5) throw badRequest('give a reason of at least five characters; it goes on the record')
  return s
}
/* Void, move and force-success change money already on the books: they need a
   reason an auditor can act on, not a word. */
const strongReason = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length < 10) throw badRequest('give a reason of at least ten characters; it goes on the record and to the principal')
  return s
}
const CORRECTIONS_LINK = '/go/fees/fee_corrections'

/** The principal's office is told of every correction to a received payment. */
async function tellAdmins(c: Ctx, paymentId: string, studentId: string, title: string, body: string): Promise<D1PreparedStatement[]> {
  const rows = await c.db.prepare(`SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.key = 'institution_admin' AND u.status = 'active' AND u.id IS NOT ?`).bind(c.id.userId).all<{ id: string }>()
  return rows.results.map((r) => notifyStmt(c, r.id, studentId, 'payment_correction', title, body, CORRECTIONS_LINK, 'payment', paymentId))
}
const allocationsOf = async (c: Ctx, id: string) =>
  (await c.db.prepare(`SELECT * FROM payment_allocations WHERE payment_id = ?`).bind(id).all<Record<string, unknown> & { invoice_id: string }>()).results

async function payment(c: Ctx, id: string) {
  const row = await c.db.prepare(`SELECT id, student_id, receipt_no, amount_paise, mode, paid_on, status, gateway, remarks FROM payments WHERE id = ?`).bind(id)
    .first<{ id: string; student_id: string; receipt_no: string; amount_paise: number; mode: string; paid_on: string; status: string; gateway: string | null; remarks: string | null }>()
  if (!row) throw notFound('no payment with that id')
  return row
}
const note = (old: string | null, line: string) => (old && old.trim() !== '' ? old + ' | ' : '') + line

export function registerCorrections(r: Router): void {
  /* Payments a correction can act on: recent receipts for one child, or the
     online payments still pending at the gateway. */
  r.get('/finance/corrections/payments', 'finance.payments.read', fin(async (c) => {
    const q = c.url.searchParams
    const student = (q.get('student_id') ?? '').trim()
    const pending = q.get('pending') === '1'
    if (student && !isUUID(student)) throw badRequest('student_id must be a uuid')
    const rows = await c.db.prepare(`
      SELECT p.id, p.receipt_no, p.amount_paise, p.allocated_paise, p.mode, p.paid_on, p.status, p.gateway, p.gateway_txn_id, p.reference_no, p.remarks,
             TRIM(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')) AS student_name, st.admission_no, p.student_id
        FROM payments p JOIN students st ON st.id = p.student_id
       WHERE (?1 = '' OR p.student_id = ?1)
         AND (?2 = 0 OR (p.status = 'pending' AND p.mode NOT IN ('cheque','dd')))
       ORDER BY p.paid_on DESC, p.created_at DESC LIMIT 200`).bind(student, pending ? 1 : 0).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({ ...v, amount_paise: Number(v.amount_paise), allocated_paise: Number(v.allocated_paise ?? 0) })) })
  }))

  r.post('/finance/corrections/payments/{id}/void', APPROVE, fin(async (c) => {
    const id = uuidParam(c.params.id)
    await requireFresh(c)
    const req = await readJSON<{ reason?: unknown }>(c.req)
    const why = strongReason(req.reason)
    const p = await payment(c, id)
    if (p.status === 'cancelled') throw new HttpError(409, 'this receipt is already void', { code: 'already_void' })
    if (p.status === 'bounced') throw new HttpError(409, 'a bounced cheque is already off the books', { code: 'bounced' })
    await requireOpenPeriod(c, p.paid_on)
    /* The allocations come off the invoices, but every one removed is copied
       whole into the audit row, so what the receipt had paid stays on record. */
    const allocs = await allocationsOf(c, id)
    const remarks = note(p.remarks, `Void on ${now().slice(0, 10)}: ${why}`)
    const stmts = [
      auditStmt(c, 'payment.void', 'payment', id, { ...p, allocations: allocs }, { status: 'cancelled', remarks, reason: why, removed_allocations: allocs }),
      c.db.prepare(`DELETE FROM payment_allocations WHERE payment_id = ?`).bind(id),
      c.db.prepare(`UPDATE payments SET status = 'cancelled', remarks = ? WHERE id = ?`).bind(remarks, id),
    ]
    for (const a of allocs) stmts.push(...syncInvoice(c, a.invoice_id))
    stmts.push(syncPayment(c, id))
    stmts.push(...await tellAdmins(c, id, p.student_id, `Receipt ${p.receipt_no} voided`, `₹${Math.trunc(p.amount_paise / 100)} taken off the books. Reason: ${why}`))
    await c.db.batch(stmts)
    return ok({ id, status: 'cancelled', receipt_no: p.receipt_no })
  }))

  r.post('/finance/corrections/payments/{id}/move', APPROVE, fin(async (c) => {
    const id = uuidParam(c.params.id)
    await requireFresh(c)
    const req = await readJSON<{ to_student_id?: unknown; reason?: unknown }>(c.req)
    const why = strongReason(req.reason)
    const to = typeof req.to_student_id === 'string' ? req.to_student_id : ''
    if (!isUUID(to)) throw badRequest('to_student_id must name a child')
    const p = await payment(c, id)
    if (p.student_id === to) throw badRequest('that receipt is already against this child')
    if (p.status !== 'success') throw new HttpError(409, 'only a received payment can be moved', { code: 'not_received' })
    await requireOpenPeriod(c, p.paid_on)
    const target = await c.db.prepare(`SELECT id, campus_id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM students WHERE id = ?`).bind(to)
      .first<{ id: string; campus_id: string; name: string }>()
    if (!target) throw badRequest('no child with that id')
    const allocs = await allocationsOf(c, id)
    const remarks = note(p.remarks, `Moved to ${target.name} on ${now().slice(0, 10)}: ${why}`)
    const stmts = [
      auditStmt(c, 'payment.move', 'payment', id, { ...p, allocations: allocs }, { student_id: target.id, campus_id: target.campus_id, remarks, reason: why, removed_allocations: allocs }),
      c.db.prepare(`DELETE FROM payment_allocations WHERE payment_id = ?`).bind(id),
    ]
    for (const a of allocs) stmts.push(...syncInvoice(c, a.invoice_id))
    stmts.push(c.db.prepare(`UPDATE payments SET student_id = ?, campus_id = ?, remarks = ? WHERE id = ?`)
      .bind(target.id, target.campus_id, remarks, id))
    stmts.push(...await tellAdmins(c, id, target.id, `Receipt ${p.receipt_no} moved to ${target.name}`, `₹${Math.trunc(p.amount_paise / 100)}. Reason: ${why}`))
    await c.db.batch(stmts)
    /* Allocate against the new child's dues after the move is on disk: the
       allocator reads outstanding invoices for the student the payment now
       belongs to. */
    const a = await allocate(c, target.id, id, p.amount_paise, []).catch(() => null)
    if (a) await c.db.batch(a.stmts)
    else await c.db.batch([syncPayment(c, id)])
    return ok({ id, moved_to: target.id, allocated_paise: a ? p.amount_paise - a.unallocated : 0, unallocated_paise: a ? a.unallocated : p.amount_paise })
  }))

  r.post('/finance/corrections/payments/{id}/force-success', APPROVE, fin(async (c) => {
    const id = uuidParam(c.params.id)
    await requireFresh(c)
    const req = await readJSON<{ reason?: unknown; gateway_txn_id?: unknown }>(c.req)
    const why = strongReason(req.reason)
    const p = await payment(c, id)
    if (p.status !== 'pending') throw new HttpError(409, 'only a pending payment can be forced', { code: 'not_pending' })
    if (p.mode === 'cheque' || p.mode === 'dd') throw badRequest('a cheque clears through the bank, not here; use Cheques')
    await requireOpenPeriod(c, p.paid_on)
    const txn = typeof req.gateway_txn_id === 'string' && req.gateway_txn_id.trim() !== '' ? req.gateway_txn_id.trim() : null
    const remarks = note(p.remarks, `Marked received by hand on ${now().slice(0, 10)}: ${why}`)
    await c.db.batch([
      c.db.prepare(`UPDATE payments SET status = 'success', gateway_status = 'forced', gateway_txn_id = COALESCE(?, gateway_txn_id), remarks = ? WHERE id = ?`)
        .bind(txn, remarks, id),
      auditStmt(c, 'payment.force_success', 'payment', id, p, { status: 'success', gateway_status: 'forced', gateway_txn_id: txn, remarks, reason: why }),
      ...await tellAdmins(c, id, p.student_id, `Receipt ${p.receipt_no} marked received by hand`, `₹${Math.trunc(p.amount_paise / 100)}. Reason: ${why}`),
    ])
    const a = await allocate(c, p.student_id, id, p.amount_paise, []).catch(() => null)
    if (a) await c.db.batch(a.stmts)
    else await c.db.batch([syncPayment(c, id)])
    return ok({ id, status: 'success', unallocated_paise: a ? a.unallocated : p.amount_paise })
  }))

  /* End a fee head for a class or section from a date: every child's
     component for that head gets valid_to set, so the next billing run
     leaves it out. Nothing already invoiced changes. */
  r.post('/finance/corrections/end-fee', WRITE, fin(async (c) => {
    const req = await readJSON<{ fee_head_id?: unknown; class_id?: unknown; section_id?: unknown; from?: unknown; reason?: unknown }>(c.req)
    const head = typeof req.fee_head_id === 'string' ? req.fee_head_id : ''
    if (!isUUID(head)) throw badRequest('fee_head_id must name a fee head')
    const from = typeof req.from === 'string' ? req.from : ''
    if (!isDate(from)) throw badRequest('from must be YYYY-MM-DD')
    reason(req.reason)
    const klass = typeof req.class_id === 'string' && req.class_id !== '' ? req.class_id : null
    const section = typeof req.section_id === 'string' && req.section_id !== '' ? req.section_id : null
    if (!klass && !section) throw badRequest('choose a class or a section')
    if ((klass && !isUUID(klass)) || (section && !isUUID(section))) throw badRequest('class_id and section_id must be uuids')
    const r1 = await c.db.prepare(`
      UPDATE student_fee_components SET valid_to = ?1
       WHERE institution_id = ?2 AND fee_head_id = ?3 AND (valid_to IS NULL OR valid_to > ?1)
         AND student_id IN (SELECT e.student_id FROM enrollments e JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.is_current = 1
                             WHERE e.status = 'active' AND (?4 IS NULL OR e.class_id = ?4) AND (?5 IS NULL OR e.section_id = ?5))`)
      .bind(from, school(c).id, head, klass, section).run()
    return ok({ ended: r1.meta.changes ?? 0, from })
  }))
}
