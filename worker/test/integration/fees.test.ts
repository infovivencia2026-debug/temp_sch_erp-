/* Fee collection: a payment against an invoice, its receipt, the student's
   ledger and the finance dashboard all agree on the money. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

beforeAll(seed)

describe('fees', () => {
  let paymentId = ''

  it('starts with both invoices outstanding on the dashboard', async () => {
    const { status, body } = await api('finance', 'GET', '/finance/dashboard')
    expect(status).toBe(200)
    expect(body).toMatchObject({ outstanding_paise: 1_000_000, invoices: 2, today_paise: 0 })
  })

  it('collects a part payment and allocates it to the invoice', async () => {
    const { status, body } = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 200_000, mode: 'cash', payer_name: 'Pavan Parent' })
    expect(status).toBe(201)
    expect(body.receipt_no).toBeTruthy()
    expect(body.cleared).toBe(true)
    expect(body.unallocated_paise).toBe(0)
    expect(body.allocated).toEqual([expect.objectContaining({ invoice_id: IDS.invoice, amount_paise: 200_000 })])
    paymentId = body.payment_id
    const inv = await E.TENANT_TEST.prepare('SELECT paid_paise, status FROM invoices WHERE id = ?').bind(IDS.invoice).first()
    expect(inv).toEqual({ paid_paise: 200_000, status: 'partial' })
  })

  it('prints a receipt for exactly that amount', async () => {
    const { status, body } = await api('finance', 'GET', `/fees/receipts/${paymentId}`)
    expect(status).toBe(200)
    expect(body).toMatchObject({ amount_paise: 200_000, mode: 'cash', status: 'success', admission_no: 'A001', class_name: 'Class 5' })
    expect(body.lines).toEqual([expect.objectContaining({ invoice_no: 'INV-1', amount_paise: 200_000, particulars: 'Tuition' })])
    expect(body.amount_words).toMatch(/two thousand/i)
  })

  it('leaves the right balance on the ledger', async () => {
    const { body } = await api('finance', 'GET', `/fees/students/${IDS.child}/ledger`)
    expect(body).toMatchObject({ charged_paise: 500_000, paid_paise: 200_000, balance_paise: 300_000 })
    expect(body.dues).toEqual([expect.objectContaining({ invoice_no: 'INV-1', balance_paise: 300_000 })])
  })

  it('adds up on the dashboard', async () => {
    const { body } = await api('finance', 'GET', '/finance/dashboard')
    expect(body.today_paise).toBe(200_000)
    expect(body.outstanding_paise).toBe(800_000)
  })

  it('clears the invoice with the rest and says so everywhere', async () => {
    const { body } = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 300_000, mode: 'upi', reference_no: 'UTR123' })
    expect(body.unallocated_paise).toBe(0)
    const ledger = (await api('finance', 'GET', `/fees/students/${IDS.child}/ledger`)).body
    expect(ledger.balance_paise).toBe(0)
    expect(ledger.dues ?? []).toEqual([])
    const dash = (await api('finance', 'GET', '/finance/dashboard')).body
    expect(dash).toMatchObject({ today_paise: 500_000, outstanding_paise: 500_000 })
    const inv = await E.TENANT_TEST.prepare('SELECT status FROM invoices WHERE id = ?').bind(IDS.invoice).first<{ status: string }>()
    expect(inv?.status).toBe('paid')
  })

  it('tells the family a payment arrived', async () => {
    const n = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'fee_receipt'`).bind(IDS.parent).first<{ n: number }>()
    expect(n?.n).toBe(2)
  })

  it('refuses a zero payment', async () => {
    const { status } = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 0, mode: 'cash' })
    expect(status).toBe(400)
  })
})
