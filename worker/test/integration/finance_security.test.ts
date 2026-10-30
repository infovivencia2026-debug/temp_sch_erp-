/* Finance maker-checker and correction controls (audit, 2026-10-27): nobody
   approves their own refund or bill or pays out a refund they approved; a
   void, move or force-success needs a fresh sign-in, a real reason and an
   audit row that keeps what was removed; a decided bill or fee filing cannot
   be decided again. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, USERS, isoDay } from './fixture'

const T = () => E.TENANT_TEST
const REFUNDS_LINK = '/go/fees/class_transport_fee_setup?view=concessions'
const notes = async (user: string, source: string) =>
  (await T().prepare(`SELECT kind, title, body, link FROM notifications WHERE user_id = ? AND source_id = ? ORDER BY created_at`)
    .bind(user, source).all<{ kind: string; title: string; body: string; link: string }>()).results
const campus = async () => (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id

async function payment(student: string, receipt: string, amount: number, status = 'success', mode = 'cash'): Promise<string> {
  const id = crypto.randomUUID()
  await T().prepare(`INSERT INTO payments (id, institution_id, campus_id, student_id, receipt_no, amount_paise, mode, status, paid_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, IDS.school, await campus(), student, receipt, amount, mode, status, isoDay(0), new Date().toISOString()).run()
  return id
}

beforeAll(seed)

describe('refund maker-checker', () => {
  it('refuses self-approval and approver payout, and notifies with the refunds link', async () => {
    await payment(IDS.otherChild, 'SEC-R1', 100000)
    const made = await api<{ id: string }>('finance', 'POST', '/fees/refunds',
      { student_id: IDS.otherChild, amount_paise: 20000, reason: 'Leaving school mid term' })
    expect(made.status).toBe(201)
    const id = made.body.id

    const asked = await notes(IDS.admin, id)
    expect(asked).toHaveLength(1)
    expect(asked[0].kind).toBe('refund_request')
    expect(asked[0].link).toBe(REFUNDS_LINK)
    expect(await notes(IDS.finance, id)).toHaveLength(0)

    const self = await api<{ error?: string }>('finance', 'POST', `/fees/refunds/${id}/decide`, { decision: 'approved' })
    expect(self.status).toBe(403)
    expect(JSON.stringify(self.body)).toContain('someone else')

    const ok = await api('admin', 'POST', `/fees/refunds/${id}/decide`, { decision: 'approved', note: 'TC issued' })
    expect(ok.status).toBe(200)
    const told = await notes(IDS.finance, id)
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe('Refund approved')
    expect(told[0].link).toBe(REFUNDS_LINK)

    const payout = await api('admin', 'POST', `/fees/refunds/${id}/process`, { mode: 'neft' })
    expect(payout.status).toBe(403)
    const paid = await api('finance', 'POST', `/fees/refunds/${id}/process`, { mode: 'neft' })
    expect(paid.status).toBe(200)
  })
})

describe('payment corrections', () => {
  it('void needs a ten-character reason and a fresh sign-in, and writes an audit row with the removed allocations', async () => {
    const pid = await payment(IDS.child, 'SEC-V1', 50000)
    await T().prepare(`INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise) VALUES (?, ?, ?, 50000)`)
      .bind(IDS.school, pid, IDS.invoice).run()

    const short = await api('finance', 'POST', `/finance/corrections/payments/${pid}/void`, { reason: 'mistake' })
    expect(short.status).toBe(400)

    // A sign-in older than fifteen minutes is refused until the password is confirmed.
    const { cookie } = await signIn(USERS.finance)
    const s = await E.CONTROL.prepare(`SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).bind(IDS.finance).first<{ id: string }>()
    await E.CONTROL.prepare(`UPDATE sessions SET created_at = ? WHERE id = ?`).bind(new Date(Date.now() - 3600_000).toISOString(), s!.id).run()
    const stale = await call(`/api/v1/finance/corrections/payments/${pid}/void`, {
      method: 'POST', cookie: cookie!, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Receipt keyed twice by the counter' }),
    })
    expect(stale.status).toBe(403)
    expect(await stale.text()).toContain('reauth_required')
    expect((await T().prepare(`SELECT status FROM payments WHERE id = ?`).bind(pid).first<{ status: string }>())!.status).toBe('success')

    const v = await api('finance', 'POST', `/finance/corrections/payments/${pid}/void`, { reason: 'Receipt keyed twice by the counter' })
    expect(v.status).toBe(200)
    const audit = await T().prepare(`SELECT actor_user_id, before, after FROM audit_log WHERE action = 'payment.void' AND entity_id = ?`).bind(pid)
      .first<{ actor_user_id: string; before: string; after: string }>()
    expect(audit).not.toBeNull()
    expect(audit!.actor_user_id).toBe(IDS.finance)
    expect(JSON.parse(audit!.before).status).toBe('success')
    const after = JSON.parse(audit!.after)
    expect(after.status).toBe('cancelled')
    expect(after.removed_allocations).toHaveLength(1)
    expect(after.removed_allocations[0].invoice_id).toBe(IDS.invoice)
    expect(after.removed_allocations[0].amount_paise).toBe(50000)

    const told = await notes(IDS.admin, pid)
    expect(told).toHaveLength(1)
    expect(told[0].link).toBe('/go/fees/fee_corrections')
  })

  it('force-success writes its audit row in the same step', async () => {
    const pid = await payment(IDS.child, 'SEC-F1', 30000, 'pending', 'upi')
    const f = await api('finance', 'POST', `/finance/corrections/payments/${pid}/force-success`, { reason: 'Bank confirmed by email today' })
    expect(f.status).toBe(200)
    const audit = await T().prepare(`SELECT before, after FROM audit_log WHERE action = 'payment.force_success' AND entity_id = ?`).bind(pid)
      .first<{ before: string; after: string }>()
    expect(JSON.parse(audit!.before).status).toBe('pending')
    expect(JSON.parse(audit!.after).status).toBe('success')
  })
})

describe('vendor bills', () => {
  it('refuses approval by the maker, rejects a draft, and refuses deciding it again', async () => {
    await api('admin', 'GET', '/finance/ledgers/accounts')
    const acct = (await T().prepare(`SELECT id FROM ledger_accounts WHERE is_group = 0 LIMIT 1`).first<{ id: string }>())!.id
    const vendor = crypto.randomUUID()
    await T().prepare(`INSERT INTO vendors (id, institution_id, code, name) VALUES (?, ?, 'VSEC', 'Sec Stationers')`).bind(vendor, IDS.school).run()
    const bill = crypto.randomUUID()
    await T().prepare(`INSERT INTO vendor_bills (id, institution_id, vendor_id, bill_no, expense_account_id, taxable_paise, total_paise, status, created_by)
        VALUES (?, ?, ?, 'SB-1', ?, 10000, 10000, 'draft', ?)`).bind(bill, IDS.school, vendor, acct, IDS.finance).run()

    const own = await api('finance', 'POST', `/finance/ledgers/bills/${bill}/approve`)
    expect(own.status).toBe(403)
    const noWhy = await api('admin', 'POST', `/finance/ledgers/bills/${bill}/reject`, {})
    expect(noWhy.status).toBe(400)
    const rej = await api('admin', 'POST', `/finance/ledgers/bills/${bill}/reject`, { reason: 'Duplicate of SB-0' })
    expect(rej.status).toBe(200)
    expect((await T().prepare(`SELECT status FROM vendor_bills WHERE id = ?`).bind(bill).first<{ status: string }>())!.status).toBe('rejected')
    expect(await T().prepare(`SELECT 1 FROM audit_log WHERE action = 'vendor_bill.reject' AND entity_id = ?`).bind(bill).first()).not.toBeNull()

    const again = await api('admin', 'POST', `/finance/ledgers/bills/${bill}/approve`)
    expect(again.status).toBe(409)
    const rejAgain = await api('admin', 'POST', `/finance/ledgers/bills/${bill}/reject`, { reason: 'Duplicate of SB-0' })
    expect(rejAgain.status).toBe(409)
  })
})

describe('fee filings', () => {
  it('refuses to decide a filing twice', async () => {
    const id = crypto.randomUUID()
    await T().prepare(`INSERT INTO fee_regulatory_filings (id, institution_id, filing_no, committee_name, status) VALUES (?, ?, 'FRC-SEC-1', 'District FRC', 'submitted')`)
      .bind(id, IDS.school).run()
    const first = await api('admin', 'POST', `/admin-ops/fee-filings/${id}/decide`, { decision: 'approved' })
    expect(first.status).toBe(200)
    const second = await api('admin', 'POST', `/admin-ops/fee-filings/${id}/decide`, { decision: 'rejected', note: 'Changed our mind' })
    expect(second.status).toBe(409)
    expect((await T().prepare(`SELECT status FROM fee_regulatory_filings WHERE id = ?`).bind(id).first<{ status: string }>())!.status).toBe('approved')
  })
})
