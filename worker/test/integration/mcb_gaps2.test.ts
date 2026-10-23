/* Second MCB group: the reports as exports (each one runs), payment
   corrections (void, move, force, end a fee) with their refusals, and
   reading bands per class. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, as, call, IDS, isoDay, E } from './fixture'
import { moreSpecs } from '../../src/routes/admin/export_more'

beforeAll(seed)
const T = () => E.TENANT_TEST
const uuid = (n: number) => `00000000-0000-4000-8000-${String(800 + n).padStart(12, '0')}`
const today = isoDay(0)

describe('reports as exports', () => {
  it('lists every added report for whoever holds its permission, and each one runs', async () => {
    const names = Object.keys(moreSpecs(today))
    expect(names.length).toBeGreaterThanOrEqual(30)
    const admin = await api('admin', 'GET', '/export')
    expect(admin.status).toBe(200)
    const listed = new Set(admin.body.items.map((x: { name: string }) => x.name))
    const missing = names.filter((n) => !listed.has(n))
    expect(missing, 'reports the principal cannot see').toEqual([])
    const cookie = await as('admin')
    for (const n of names) {
      const res = await call(`/api/v1/export/${n}`, { cookie })
      expect(res.status, n).toBe(200)
      const text = await res.text()
      expect(text, `${n} failed: ${text.slice(-200)}`).not.toContain('EXPORT FAILED')
      expect(text.split('\n')[0].length, n).toBeGreaterThan(3)
    }
    const xlsx = await call('/api/v1/export/students_segments?format=xlsx', { cookie })
    expect(xlsx.status).toBe(200)
    expect(xlsx.headers.get('content-type') ?? '').toContain('spreadsheet')
  })

  it('hides finance reports from a teacher', async () => {
    const r = await api('teacher', 'GET', '/export')
    const names = r.body.items.map((x: { name: string }) => x.name)
    expect(names).not.toContain('fee_mismatches')
    expect((await api('teacher', 'GET', '/export/fee_mismatches')).status).toBe(403)
    expect((await api('parent', 'GET', '/export/students_siblings')).status).toBe(403)
  })

  it('segments count the seeded children and siblings read the shared guardian', async () => {
    const cookie = await as('admin')
    const seg = await (await call('/api/v1/export/students_segments', { cookie })).text()
    expect(seg).toContain('Class 5,Gender,')
    const sib = await (await call('/api/v1/export/students_siblings', { cookie })).text()
    // Chirag and Diya have different guardians: no siblings in the fixture.
    expect(sib.trim().split('\n').length).toBe(1)
  })
})

describe('payment corrections', () => {
  let cash = ''
  let online = ''
  beforeAll(async () => {
    const cid = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
    cash = uuid(1); online = uuid(2)
    await T().batch([
      T().prepare(`INSERT OR IGNORE INTO payments (id, institution_id, campus_id, student_id, receipt_no, amount_paise, allocated_paise, mode, paid_on, status, created_at)
          VALUES (?, ?, ?, ?, 'R-C1', 100000, 0, 'cash', ?, 'success', ?)`).bind(cash, IDS.school, cid, IDS.child, today, new Date().toISOString()),
      T().prepare(`INSERT OR IGNORE INTO payments (id, institution_id, campus_id, student_id, receipt_no, amount_paise, allocated_paise, mode, paid_on, status, gateway, created_at)
          VALUES (?, ?, ?, ?, 'R-C2', 50000, 0, 'upi', ?, 'pending', 'test', ?)`).bind(online, IDS.school, cid, IDS.otherChild, today, new Date().toISOString()),
      T().prepare(`INSERT OR IGNORE INTO payment_allocations (id, institution_id, payment_id, invoice_id, amount_paise, created_at) VALUES (?, ?, ?, ?, 100000, ?)`)
        .bind(uuid(3), IDS.school, cash, IDS.invoice, new Date().toISOString()),
      T().prepare(`UPDATE payments SET allocated_paise = 100000 WHERE id = ?`).bind(cash),
      T().prepare(`UPDATE invoices SET paid_paise = paid_paise + 100000, status = 'partial' WHERE id = ?`).bind(IDS.invoice),
    ])
  })

  it('lists a child’s receipts and the pending online ones', async () => {
    const r = await api('finance', 'GET', `/finance/corrections/payments?student_id=${IDS.child}`)
    expect(r.status).toBe(200)
    expect(r.body.items.some((p: { id: string }) => p.id === cash)).toBe(true)
    const p = await api('finance', 'GET', '/finance/corrections/payments?pending=1')
    expect(p.body.items.some((x: { id: string }) => x.id === online)).toBe(true)
    expect((await api('finance', 'GET', '/finance/corrections/payments?student_id=nope')).status).toBe(400)
    expect((await api('teacher', 'GET', '/finance/corrections/payments')).status).toBe(403)
  })

  it('moves a receipt to another child and re-allocates it there', async () => {
    expect((await api('finance', 'POST', `/finance/corrections/payments/${cash}/move`, { to_student_id: IDS.child, reason: 'same child' })).status).toBe(400)
    expect((await api('finance', 'POST', `/finance/corrections/payments/${cash}/move`, { to_student_id: IDS.otherChild, reason: 'x' })).status).toBe(400)
    const r = await api('finance', 'POST', `/finance/corrections/payments/${cash}/move`, { to_student_id: IDS.otherChild, reason: 'Taken against the wrong sibling' })
    expect(r.status).toBe(200)
    expect(r.body.moved_to).toBe(IDS.otherChild)
    expect(r.body.allocated_paise).toBe(100000)
    const inv = await T().prepare(`SELECT paid_paise FROM invoices WHERE id = ?`).bind(IDS.invoice).first<{ paid_paise: number }>()
    expect(inv!.paid_paise).toBe(0)
    const other = await T().prepare(`SELECT paid_paise FROM invoices WHERE id = ?`).bind(IDS.otherInvoice).first<{ paid_paise: number }>()
    expect(other!.paid_paise).toBeGreaterThanOrEqual(100000)
  })

  it('voids a receipt with a reason, once', async () => {
    expect((await api('finance', 'POST', `/finance/corrections/payments/${cash}/void`, { reason: 'oops' })).status).toBe(400)
    const r = await api('finance', 'POST', `/finance/corrections/payments/${cash}/void`, { reason: 'Receipt issued twice' })
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('cancelled')
    const row = await T().prepare(`SELECT status, allocated_paise, remarks FROM payments WHERE id = ?`).bind(cash).first<{ status: string; allocated_paise: number; remarks: string }>()
    expect(row!.status).toBe('cancelled'); expect(row!.allocated_paise).toBe(0); expect(row!.remarks).toContain('Receipt issued twice')
    expect((await api('finance', 'POST', `/finance/corrections/payments/${cash}/void`, { reason: 'Receipt issued twice' })).status).toBe(409)
    expect((await api('teacher', 'POST', `/finance/corrections/payments/${cash}/void`, { reason: 'Receipt issued twice' })).status).toBe(403)
  })

  it('forces a pending online payment to received and allocates it', async () => {
    const r = await api('finance', 'POST', `/finance/corrections/payments/${online}/force-success`, { reason: 'Gateway confirmed by email', gateway_txn_id: 'TXN123' })
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('success')
    const row = await T().prepare(`SELECT status, gateway_status, gateway_txn_id, allocated_paise FROM payments WHERE id = ?`).bind(online)
      .first<{ status: string; gateway_status: string; gateway_txn_id: string; allocated_paise: number }>()
    expect(row!.gateway_status).toBe('forced'); expect(row!.gateway_txn_id).toBe('TXN123'); expect(row!.allocated_paise).toBe(50000)
    expect((await api('finance', 'POST', `/finance/corrections/payments/${online}/force-success`, { reason: 'Gateway confirmed by email' })).status).toBe(409)
  })

  it('ends a fee head for a class from a date', async () => {
    const yr = (await T().prepare(`SELECT id FROM academic_years WHERE is_current = 1`).first<{ id: string }>())!.id
    await T().prepare(`INSERT OR IGNORE INTO student_fee_components (id, institution_id, student_id, academic_year_id, fee_head_id, code, description, amount_paise, valid_from, source_kind)
        VALUES (?, ?, ?, ?, ?, 'TUI', 'Tuition', 100000, ?, 'manual')`).bind(uuid(4), IDS.school, IDS.child, yr, IDS.feeHead, isoDay(-100)).run()
    expect((await api('finance', 'POST', '/finance/corrections/end-fee', { fee_head_id: IDS.feeHead, from: isoDay(10), reason: 'Club closed' })).status).toBe(400)
    expect((await api('finance', 'POST', '/finance/corrections/end-fee', { fee_head_id: IDS.feeHead, class_id: IDS.klass, from: 'soon', reason: 'Club closed' })).status).toBe(400)
    const r = await api('finance', 'POST', '/finance/corrections/end-fee', { fee_head_id: IDS.feeHead, class_id: IDS.klass, from: isoDay(10), reason: 'Club closed' })
    expect(r.status).toBe(200)
    expect(r.body.ended).toBeGreaterThanOrEqual(1)
    const row = await T().prepare(`SELECT valid_to FROM student_fee_components WHERE id = ?`).bind(uuid(4)).first<{ valid_to: string }>()
    expect(row!.valid_to).toBe(isoDay(10))
  })
})

describe('reading bands', () => {
  it('keeps a label per class level and marks each child’s expected band', async () => {
    expect((await api('admin', 'PUT', '/ops/library/reading-bands', { items: [{ class_level: 5, label: '' }] })).status).toBe(400)
    expect((await api('admin', 'PUT', '/ops/library/reading-bands', { items: [{ class_level: 5, label: 'Blue' }, { class_level: 5, label: 'Green' }] })).status).toBe(400)
    const r = await api('admin', 'PUT', '/ops/library/reading-bands', { items: [{ class_level: 5, label: '600L' }, { class_level: 4, label: '500L' }] })
    expect(r.status).toBe(200)
    expect(r.body.items.map((b: { class_level: number }) => b.class_level)).toEqual([4, 5])
    const g = await api('admin', 'GET', '/ops/library/reading-bands')
    expect(g.body.items.length).toBe(2)
    const all = await api('admin', 'GET', '/ops/library/reading-levels')
    const child = all.body.items.find((v: { student_id: string }) => v.student_id === IDS.child)
    expect(child.expected_level).toBe('600L')
    expect(all.body.bands.length).toBe(2)
    expect((await api('teacher', 'PUT', '/ops/library/reading-bands', { items: [] })).status).toBe(403)
  })
})
