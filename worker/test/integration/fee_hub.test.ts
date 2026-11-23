/* Fees all in one place (2026-11-21): money lands on the fee lines the
   counter ticked; a cancel waits for someone else's approval and, once
   approved, takes the money off those lines; a request is refused without a
   reason; receipt numbers are untouched. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

beforeAll(seed)
const T = () => E.TENANT_TEST

describe('fee hub', () => {
  let line = '', pid = '', receipt = '', req = ''

  it('takes a part payment on exactly the ticked fee line', async () => {
    line = (await T().prepare(`SELECT id FROM invoice_lines WHERE invoice_id = ? LIMIT 1`).bind(IDS.invoice).first<{ id: string }>())!.id
    const over = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, mode: 'cash', lines: [{ invoice_line_id: line, amount_paise: 99_000_000 }] })
    expect(over.status).toBe(409)
    const { status, body } = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, mode: 'cash', receiving_account: 'Cash', lines: [{ invoice_line_id: line, amount_paise: 120_000 }] })
    expect(status).toBe(201)
    pid = body.payment_id; receipt = body.receipt_no
    const rows = await T().prepare(`SELECT invoice_line_id, amount_paise, source FROM payment_line_allocations WHERE payment_id = ?`).bind(pid).all()
    expect(rows.results).toEqual([{ invoice_line_id: line, amount_paise: 120_000, source: 'explicit' }])
    const hub = (await api('finance', 'GET', `/fees/hub/students/${IDS.child}`)).body
    expect(hub.lines.find((l: { line_id: string }) => l.line_id === line)).toMatchObject({ paid_paise: 120_000, status: 'part_paid' })
    const r = hub.receipts.find((x: { id: string }) => x.id === pid)
    expect(r).toMatchObject({ receipt_no: receipt, receiving_account: 'Cash' })
    expect(r.txn_id).toMatch(/^T\d{14}[0-9A-F]{6}$/)
    expect(r.lines[0]).toMatchObject({ amount_paise: 120_000 })
  })

  it('refuses a cancel request without a real reason', async () => {
    const { status } = await api('finance', 'POST', '/fees/hub/requests', { student_id: IDS.child, kind: 'cancel', payment_id: pid, reason: 'oops' })
    expect(status).toBe(400)
  })

  it('cancels only after someone else approves, and keeps the receipt number', async () => {
    const made = await api('finance', 'POST', '/fees/hub/requests', { student_id: IDS.child, kind: 'cancel', payment_id: pid, reason: 'Keyed against the wrong fee line' })
    expect(made.status).toBe(200)
    req = made.body.id
    expect((await T().prepare(`SELECT status FROM payments WHERE id = ?`).bind(pid).first<{ status: string }>())!.status).toBe('success')
    const self = await api('finance', 'POST', `/fees/hub/requests/${req}/decide`, { approve: true })
    expect(self.status).toBe(403)
    const ok = await api('admin', 'POST', `/fees/hub/requests/${req}/decide`, { approve: true })
    expect(ok.status).toBe(200)
    const p = await T().prepare(`SELECT status, receipt_no FROM payments WHERE id = ?`).bind(pid).first<{ status: string; receipt_no: string }>()
    expect(p).toEqual({ status: 'cancelled', receipt_no: receipt })
    const left = await T().prepare(`SELECT count(*) AS n FROM payment_line_allocations WHERE payment_id = ?`).bind(pid).first<{ n: number }>()
    expect(left!.n).toBe(0)
    const again = await api('admin', 'POST', `/fees/hub/requests/${req}/decide`, { approve: true })
    expect(again.status).toBe(409)
    const log = await T().prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'fee.request.cancel' AND entity_id = ?`).bind(IDS.child).first<{ n: number }>()
    expect(log!.n).toBe(1)
  })

  it('lists the day sheet one row per fee line with who took it', async () => {
    const { status, body } = await api('finance', 'GET', `/fees/hub/day-sheet?from=2000-01-01&to=2100-01-01`)
    expect(status).toBe(200)
    expect(body.items.some((x: { payment_id: string; status: string }) => x.payment_id === pid && x.status === 'cancelled')).toBe(true)
  })
})

describe('fee hub: offline payments, partial transfer, re-plan, copy plans', () => {
  let off = '', line = ''
  it('a parent reports a payment; the counter makes the receipt from it', async () => {
    line = (await T().prepare(`SELECT id FROM invoice_lines WHERE invoice_id = ? LIMIT 1`).bind(IDS.invoice).first<{ id: string }>())!.id
    const bad = await api('parent', 'POST', `/portal/fees/offline?student_id=${IDS.child}`, { amount_paise: 5000, mode: 'upi', reference_no: '123', paid_on: '2026-01-01' })
    expect(bad.status).toBe(400)
    const r = await api('parent', 'POST', `/portal/fees/offline?student_id=${IDS.child}`, { amount_paise: 5000, mode: 'upi', reference_no: '700000000001', paid_on: new Date().toISOString().slice(0, 10), line_ids: [line] })
    expect(r.status).toBe(200); off = r.body.id
    const other = await api('otherParent', 'POST', `/portal/fees/offline?student_id=${IDS.child}`, { amount_paise: 5000, mode: 'cash', paid_on: '2026-01-01' })
    expect(other.status).toBe(404)
    const list = await api('finance', 'GET', `/fees/hub/offline?student_id=${IDS.child}`)
    expect(list.body.items[0]).toMatchObject({ id: off, status: 'pending', amount_paise: 5000 })
    const pay = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, mode: 'upi', reference_no: '700000000001', offline_id: off, lines: [{ invoice_line_id: line, amount_paise: 5000 }] })
    expect(pay.status).toBe(201)
    const again = await api('finance', 'POST', `/fees/hub/offline/${off}/reject`, { reason: 'Not in the bank statement' })
    expect(again.status).toBe(409)
    const mine = await api('parent', 'GET', `/portal/fees/offline?student_id=${IDS.child}`)
    expect(mine.body.items[0]).toMatchObject({ status: 'receipted', receipt_no: pay.body.receipt_no })
  })

  it('rejects a reported payment with a reason the parent sees', async () => {
    const r = await api('parent', 'POST', `/portal/fees/offline?student_id=${IDS.child}`, { amount_paise: 100, mode: 'cash', paid_on: '2026-01-01' })
    const rj = await api('finance', 'POST', `/fees/hub/offline/${r.body.id}/reject`, { reason: 'Not received at the office' })
    expect(rj.status).toBe(200)
    const mine = await api('parent', 'GET', `/portal/fees/offline?student_id=${IDS.child}`)
    expect(mine.body.items.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({ status: 'rejected', reject_reason: 'Not received at the office' })
  })

  it('moves part of a receipt to another child after approval; totals add up', async () => {
    const pay = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, mode: 'cash', lines: [{ invoice_line_id: line, amount_paise: 10_000 }] })
    const before = await T().prepare(`SELECT COALESCE(sum(amount_paise),0) AS s FROM payments WHERE status = 'success' AND student_id IN (?, ?)`).bind(IDS.child, IDS.otherChild).first<{ s: number }>()
    const rq = await api('finance', 'POST', '/fees/hub/requests', { student_id: IDS.child, kind: 'transfer', payment_id: pay.body.payment_id, payload: { to_student_id: IDS.otherChild, amount_paise: 4000 }, reason: 'Sibling share paid on one receipt' })
    expect(rq.status).toBe(200)
    expect((await api('admin', 'POST', `/fees/hub/requests/${rq.body.id}/decide`, { approve: true })).status).toBe(200)
    const src = await T().prepare(`SELECT amount_paise, receipt_no FROM payments WHERE id = ?`).bind(pay.body.payment_id).first<{ amount_paise: number; receipt_no: string }>()
    expect(src).toEqual({ amount_paise: 6000, receipt_no: pay.body.receipt_no })
    const after = await T().prepare(`SELECT COALESCE(sum(amount_paise),0) AS s FROM payments WHERE status = 'success' AND student_id IN (?, ?)`).bind(IDS.child, IDS.otherChild).first<{ s: number }>()
    expect(after!.s).toBe(before!.s)
    const bad = await T().prepare(`SELECT count(*) AS n FROM payment_allocations a WHERE a.amount_paise <> (SELECT COALESCE(sum(x.amount_paise),0) FROM payment_line_allocations x WHERE x.payment_allocation_id = a.id)`).first<{ n: number }>()
    expect(bad!.n).toBe(0)
  })

  it('previews then copies plans to another year with an increase', async () => {
    const y2 = crypto.randomUUID()
    await T().prepare(`INSERT INTO academic_years (id, institution_id, name, starts_on, ends_on) VALUES (?, ?, 'Next year', '2099-04-01', '2100-03-31')`).bind(y2, IDS.school).run()
    const fs = crypto.randomUUID()
    const campus = (await T().prepare(`SELECT id FROM campuses LIMIT 1`).first<{ id: string }>())!.id
    await T().batch([
      T().prepare(`INSERT INTO fee_structures (id, institution_id, campus_id, academic_year_id, class_id, name) VALUES (?, ?, ?, ?, ?, 'Plan A')`).bind(fs, IDS.school, campus, IDS.year, IDS.klass),
      T().prepare(`INSERT INTO fee_structure_items (id, institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise, due_on) VALUES (?, ?, ?, ?, 1, 100000, '2026-06-10')`).bind(crypto.randomUUID(), IDS.school, fs, IDS.feeHead),
    ])
    const pre = await api('admin', 'POST', '/fees/hub/copy-plans', { from_year: IDS.year, to_year: y2, percent: 8, dry_run: true })
    expect(pre.body.plans.find((x: { plan: string }) => x.plan === 'Plan A')).toMatchObject({ old_paise: 100000, new_paise: 108000 })
    expect((await T().prepare(`SELECT count(*) AS n FROM fee_structures WHERE academic_year_id = ?`).bind(y2).first<{ n: number }>())!.n).toBe(0)
    await api('admin', 'POST', '/fees/hub/copy-plans', { from_year: IDS.year, to_year: y2, percent: 8 })
    const it = await T().prepare(`SELECT fsi.amount_paise, fsi.due_on FROM fee_structure_items fsi JOIN fee_structures f ON f.id = fsi.fee_structure_id WHERE f.academic_year_id = ? AND f.name = 'Plan A'`).bind(y2).first()
    expect(it).toEqual({ amount_paise: 108000, due_on: '2027-06-10' })
  })
})

describe('fee hub: transport route change on a shared term bill', () => {
  const head = crypto.randomUUID(), inv = crypto.randomUUID(), tl = crypto.randomUUID(), al = crypto.randomUUID()
  const up = crypto.randomUUID(), down = crypto.randomUUID()
  const plan = async (id: string, amt: number) => {
    const campus = (await T().prepare(`SELECT id FROM campuses LIMIT 1`).first<{ id: string }>())!.id
    await T().batch([
      T().prepare(`INSERT INTO fee_structures (id, institution_id, campus_id, academic_year_id, name) VALUES (?, ?, ?, ?, ?)`).bind(id, IDS.school, campus, IDS.year, 'Route ' + amt),
      T().prepare(`INSERT INTO fee_structure_items (id, institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise) VALUES (?, ?, ?, ?, 2, ?)`).bind(crypto.randomUUID(), IDS.school, id, head, amt),
    ])
  }
  const approve = async (payload: Record<string, unknown>) => {
    const rq = await api('finance', 'POST', '/fees/hub/requests', { student_id: IDS.otherChild, kind: 'plan_change', payload: { fee_head_id: head, from: '2000-01-01', ...payload }, reason: 'Route change test' })
    expect(rq.status).toBe(200)
    return api('admin', 'POST', `/fees/hub/requests/${rq.body.id}/decide`, { approve: true })
  }
  const line = () => T().prepare(`SELECT il.amount_paise AS amt, (SELECT COALESCE(sum(x.amount_paise),0) FROM payment_line_allocations x WHERE x.invoice_line_id = il.id) AS paid FROM invoice_lines il WHERE il.id = ?`).bind(tl).first<{ amt: number; paid: number }>()
  const annual = () => T().prepare(`SELECT sum(il.amount_paise) AS a FROM invoice_lines il WHERE il.invoice_id = ? AND il.id <> ?`).bind(inv, tl).first<{ a: number }>()

  it('sets up a term bill with tuition and transport, part paid on transport', async () => {
    const campus = (await T().prepare(`SELECT id FROM campuses LIMIT 1`).first<{ id: string }>())!.id
    await T().batch([
      T().prepare(`INSERT INTO fee_heads (id, institution_id, name, code) VALUES (?, ?, 'Transport', 'TRX')`).bind(head, IDS.school),
      T().prepare(`INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, instalment_no, issued_on, due_on, gross_paise, net_paise, status)
        VALUES (?, ?, ?, ?, ?, 'INV-T2', 2, '2026-06-01', '2099-01-01', 1300000, 1300000, 'unpaid')`).bind(inv, IDS.school, campus, IDS.otherChild, IDS.year),
      T().prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise) VALUES (?, ?, ?, ?, 'Tuition', 400000)`).bind(al, IDS.school, inv, IDS.feeHead),
      T().prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise) VALUES (?, ?, ?, ?, 'Transport', 900000)`).bind(tl, IDS.school, inv, head),
    ])
    await plan(up, 1200000); await plan(down, 300000)
    const pay = await api('finance', 'POST', '/fees/payments', { student_id: IDS.otherChild, mode: 'cash', lines: [{ invoice_line_id: tl, amount_paise: 500000 }] })
    expect(pay.status).toBe(201)
  })

  it('route up: only the transport line changes, same bill and number', async () => {
    expect((await approve({ structure_id: up })).status).toBe(200)
    expect(await line()).toEqual({ amt: 1200000, paid: 500000 })
    expect((await annual())!.a).toBe(400000)
    const iv = await T().prepare(`SELECT invoice_no, net_paise, status FROM invoices WHERE id = ?`).bind(inv).first()
    expect(iv).toMatchObject({ invoice_no: 'INV-T2', net_paise: 1600000 })
  })

  it('route down below what was paid: the excess stays on the child as advance', async () => {
    const before = await T().prepare(`SELECT sum(amount_paise) AS s FROM payments WHERE student_id = ? AND status = 'success'`).bind(IDS.otherChild).first<{ s: number }>()
    expect((await approve({ structure_id: down })).status).toBe(200)
    expect(await line()).toEqual({ amt: 300000, paid: 300000 })
    const after = await T().prepare(`SELECT sum(amount_paise) AS s, sum(amount_paise - allocated_paise) AS adv FROM payments WHERE student_id = ? AND status = 'success'`).bind(IDS.otherChild).first<{ s: number; adv: number }>()
    expect(after!.s).toBe(before!.s)
    expect(after!.adv).toBeGreaterThanOrEqual(200000)
    const bad = await T().prepare(`SELECT count(*) AS n FROM payment_allocations a WHERE a.amount_paise <> (SELECT COALESCE(sum(x.amount_paise),0) FROM payment_line_allocations x WHERE x.payment_allocation_id = a.id)`).first<{ n: number }>()
    expect(bad!.n).toBe(0)
  })

  it('no transport from the date: the line goes to nought, tuition untouched', async () => {
    expect((await approve({ stop: true })).status).toBe(200)
    expect(await line()).toEqual({ amt: 0, paid: 0 })
    expect((await annual())!.a).toBe(400000)
    const log = await T().prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'fee.plan_change' AND entity_id = ?`).bind(IDS.otherChild).first<{ n: number }>()
    expect(log!.n).toBe(3)
  })
})
