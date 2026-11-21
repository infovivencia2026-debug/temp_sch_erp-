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
