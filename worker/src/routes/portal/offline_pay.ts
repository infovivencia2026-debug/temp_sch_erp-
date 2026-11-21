import type { Router, Ctx } from '../../router'
import { badRequest, isUUID, now, ok, readJSON } from '../../http'
import { whichChild } from './family'
import { ownAttachment } from '../comms/concern_shared'
import { isDate, p, paise, today } from '../fees/common'
import { school } from '../school'

/* "I HAVE PAID" (owner, 2026-11-21, 0136). A family tells the school about a
   payment made outside the counter: amount, mode, UTR, date, a screenshot and
   which fees. It waits in fee_offline_payments until the counter makes the
   receipt or rejects it with a reason; the family sees the status here.
   Nothing is sent to anyone. */

const GROUP = 'self.profile.read'
const MODES = new Set(['upi', 'neft', 'card', 'cheque', 'dd', 'cash'])

async function list(c: Ctx): Promise<Response> {
  const student = await whichChild(c, c.url.searchParams.get('student_id'))
  const [lines, mine] = await c.db.batch([
    c.db.prepare(`SELECT il.id AS line_id, COALESCE(il.description, fh.name) AS fee, i.instalment_no, i.due_on,
             max(il.amount_paise - il.discount_paise, 0) - COALESCE((SELECT sum(x.amount_paise) FROM payment_line_allocations x WHERE x.invoice_line_id = il.id), 0) AS balance_paise
        FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id JOIN fee_heads fh ON fh.id = il.fee_head_id
       WHERE i.student_id = ? AND i.status IN ('unpaid','partial','overdue') ORDER BY COALESCE(i.due_on, i.issued_on), il.rowid`).bind(student),
    c.db.prepare(`SELECT o.id, o.amount_paise, o.mode, o.reference_no, o.paid_on, o.status, o.reject_reason, o.created_at, o.lines, pm.receipt_no
        FROM fee_offline_payments o LEFT JOIN payments pm ON pm.id = o.payment_id WHERE o.student_id = ? ORDER BY o.created_at DESC`).bind(student),
  ])
  return ok({
    student_id: student,
    lines: (lines.results as Record<string, unknown>[]).filter((l) => p(l.balance_paise as number) > 0).map((l) => ({ ...l, balance_paise: p(l.balance_paise as number) })),
    items: (mine.results as Record<string, unknown>[]).map((x) => ({ ...x, amount_paise: p(x.amount_paise as number), lines: JSON.parse(String(x.lines || '[]')) })),
  })
}

async function submit(c: Ctx): Promise<Response> {
  const student = await whichChild(c, c.url.searchParams.get('student_id'))
  const req = await readJSON<{ amount_paise?: unknown; mode?: string; reference_no?: string; paid_on?: string; attachment_file_id?: string; line_ids?: unknown[]; note?: string }>(c.req)
  const amount = paise(req.amount_paise)
  if (amount <= 0) throw badRequest('enter the amount you paid')
  const mode = req.mode ?? ''
  if (!MODES.has(mode)) throw badRequest('choose how you paid')
  const ref = (req.reference_no ?? '').trim()
  if (mode === 'upi' && !/^\d{12}$/.test(ref)) throw badRequest('a UPI UTR is 12 digits')
  if (['neft', 'card', 'cheque', 'dd'].includes(mode) && !ref) throw badRequest('enter the UTR or cheque number')
  const paidOn = req.paid_on ?? ''
  if (!isDate(paidOn) || paidOn > today()) throw badRequest('enter the date you paid (not in the future)')
  const lineIds: string[] = []
  for (const l of req.line_ids ?? []) { if (!isUUID(l)) throw badRequest('line_ids must be uuids'); lineIds.push(l as string) }
  if (lineIds.length) {
    const own = await c.db.prepare(`SELECT count(*) AS n FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.id IN (SELECT value FROM json_each(?)) AND i.student_id = ?`)
      .bind(JSON.stringify(lineIds), student).first<{ n: number }>()
    if (p(own?.n) !== lineIds.length) throw badRequest("those fees are not this child's")
  }
  if (ref) {
    const dup = await c.db.prepare(`SELECT 1 FROM fee_offline_payments WHERE reference_no = ? AND status <> 'rejected' LIMIT 1`).bind(ref).first()
    if (dup) throw badRequest('this UTR has already been reported')
  }
  const file = await ownAttachment(c, req.attachment_file_id)
  const id = crypto.randomUUID()
  await c.db.prepare(`INSERT INTO fee_offline_payments (id, institution_id, student_id, amount_paise, mode, reference_no, paid_on, attachment_file_id, lines, note, submitted_by, created_at)
      VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, ?, NULLIF(?, ''), ?, ?)`)
    .bind(id, school(c).id, student, amount, mode, ref, paidOn, file, JSON.stringify(lineIds), (req.note ?? '').trim().slice(0, 300), c.id.userId, now()).run()
  return ok({ id, status: 'pending' })
}

export function registerPortalOfflinePay(r: Router): void {
  r.get('/portal/fees/offline', GROUP, list)
  r.post('/portal/fees/offline', GROUP, submit)
}
