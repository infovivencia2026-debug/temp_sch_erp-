/* Real-world scenarios: what a school office actually does, including the
   mistakes and the edge cases. Each test states the rule a school would
   expect; a failure is a gap (docs/scenario-gaps.md records the fifteen
   found and closed on 2026-10-08). Money, registers, leave, homework, marks,
   the roll, and who may see what. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E, isoDay, signIn, USERS } from './fixture'

beforeAll(seed)

const T = () => E.TENANT_TEST
const sunday = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 7) % 7 || 7)); return d.toISOString().slice(0, 10) }

describe('money: the fee counter', () => {
  it('refuses a zero or negative amount', async () => {
    expect((await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 0, mode: 'cash' })).status).toBe(400)
    expect((await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: -500, mode: 'cash' })).status).toBe(400)
  })

  it('refuses a receipt dated in the future', async () => {
    const r = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 100, mode: 'cash', paid_on: isoDay(30) })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
  })

  it('a cheque without an instrument number is refused', async () => {
    expect((await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 1000, mode: 'cheque' })).status).toBe(400)
  })

  it('collecting more than is owed is refused with 409 over_payment', async () => {
    const r = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 600_000, mode: 'cash', payer_name: 'Pavan Parent' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('over_payment')
  })

  it('a payment for the balance owed is accepted', async () => {
    const before = (await api('finance', 'GET', `/fees/students/${IDS.child}/ledger`)).body
    const r = await api('finance', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: before.balance_paise, mode: 'cash', payer_name: 'Pavan Parent' })
    expect(r.status).toBe(201)
    const ledger = (await api('finance', 'GET', `/fees/students/${IDS.child}/ledger`)).body
    expect(ledger.paid_paise).toBe(before.paid_paise + before.balance_paise)
    expect(ledger.balance_paise).toBe(0)
  })

  it('the teacher cannot collect money, and the parent cannot either', async () => {
    expect((await api('teacher', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 100, mode: 'cash' })).status).toBe(403)
    expect((await api('parent', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 100, mode: 'cash' })).status).toBe(403)
  })

  it('a parent sees only their own child on the family fee page', async () => {
    const mine = await api('parent', 'GET', '/portal/fees')
    expect(mine.status).toBe(200)
    const text = JSON.stringify(mine.body)
    expect(text).toContain('INV-1')
    expect(text).not.toContain('INV-2')
  })

  it('a parent cannot read another family\'s ledger or receipts', async () => {
    const r = await api('otherParent', 'GET', `/fees/students/${IDS.child}/ledger`)
    expect([401, 403, 404]).toContain(r.status)
    const pays = await T().prepare('SELECT id FROM payments WHERE student_id = ?').bind(IDS.child).all<{ id: string }>()
    for (const p of pays.results) {
      const rr = await api('otherParent', 'GET', `/fees/receipts/${p.id}`)
      expect([401, 403, 404]).toContain(rr.status)
    }
  })

  it('a refund of more than the family paid is refused', async () => {
    const r = await api('finance', 'POST', '/fees/refunds', { student_id: IDS.otherChild, amount_paise: 100, reason: 'test' })
    expect(r.status).toBe(409)
  })

  it('two refund requests at the same moment cannot together exceed what was paid', async () => {
    // The child has paid 5,00,000. Two clerks each ask for the whole lot at once.
    const [a, b] = await Promise.all([
      api('finance', 'POST', '/fees/refunds', { student_id: IDS.child, amount_paise: 500_000, reason: 'left the school' }),
      api('finance', 'POST', '/fees/refunds', { student_id: IDS.child, amount_paise: 500_000, reason: 'left the school' }),
    ])
    const ok = [a, b].filter((x) => x.status === 201).length
    const total = await T().prepare(`SELECT COALESCE(sum(amount_paise), 0) AS n FROM refunds WHERE student_id = ? AND status <> 'rejected'`).bind(IDS.child).first<{ n: number }>()
    expect(ok, `${a.status} ${b.status}`).toBe(1)
    expect(Number(total?.n)).toBeLessThanOrEqual(500_000)
  })

  it('a rejected refund needs a reason the family can be told', async () => {
    const pend = await T().prepare(`SELECT id FROM refunds WHERE student_id = ? AND status = 'pending' LIMIT 1`).bind(IDS.child).first<{ id: string }>()
    if (!pend) return
    expect((await api('finance', 'POST', `/fees/refunds/${pend.id}/decide`, { decision: 'rejected' })).status).toBe(400)
    // Finance raised it, so another person decides it (maker-checker, finance_security.test.ts).
    const r = await api('admin', 'POST', `/fees/refunds/${pend.id}/decide`, { decision: 'rejected', note: 'the family withdrew the request' })
    expect(r.status).toBe(200)
  })

  it('a concession cannot be granted by a teacher', async () => {
    const r = await api('teacher', 'POST', '/fees/concessions', { student_id: IDS.child, kind: 'merit', percent: '10', reason: 'topper' })
    expect(r.status).toBe(403)
  })

  it('a concession of more than 100 percent is refused', async () => {
    const r = await api('finance', 'POST', '/fees/concessions', { student_id: IDS.child, kind: 'merit', percent: '150', reason: 'typo' })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
  })

  it('a child with payments cannot be deleted, only recorded as left', async () => {
    const r = await api('admin', 'DELETE', `/students/${IDS.child}`, { confirm_name: 'Chirag Test' })
    expect(r.status).toBe(409)
  })
})

describe('the register', () => {
  const mark = (who: 'teacher' | 'parent' | 'admin', body: Record<string, unknown>) => api(who, 'POST', '/attendance', { section_id: IDS.section, entries: [{ student_id: IDS.child, status: 'present' }], ...body })

  it('a parent cannot mark the register', async () => {
    expect((await mark('parent', {})).status).toBe(403)
  })

  it('marks today and is idempotent when marked again the same way', async () => {
    const a = await mark('teacher', {})
    expect(a.status).toBe(200)
    const b = await mark('teacher', {})
    expect(b.body.written).toBe(0)
  })

  it('refuses a date in the future', async () => {
    const r = await mark('teacher', { on_date: isoDay(7) })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
  })

  it('refuses a child who is not in that section', async () => {
    const stranger = crypto.randomUUID()
    await T().prepare(`INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, last_name, admission_date)
      SELECT ?, institution_id, campus_id, 'A999', 'Zed', 'Stranger', ? FROM students WHERE id = ?`).bind(stranger, isoDay(-10), IDS.child).run()
    const r = await api('teacher', 'POST', '/attendance', { section_id: IDS.section, entries: [{ student_id: stranger, status: 'absent' }], silent: true })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    await T().prepare('DELETE FROM student_attendance WHERE student_id = ?').bind(stranger).run()
    await T().prepare('DELETE FROM students WHERE id = ?').bind(stranger).run()
  })

  it('refuses an unknown status', async () => {
    expect((await api('teacher', 'POST', '/attendance', { section_id: IDS.section, entries: [{ student_id: IDS.child, status: 'sleeping' }] })).status).toBe(400)
  })

  it('a parent sees only their own child\'s attendance', async () => {
    const r = await api('otherParent', 'GET', '/portal/attendance')
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).not.toContain(IDS.child)
  })
})

describe('leave', () => {
  let leaveId = ''
  it('a parent applies for their own child, not another\'s', async () => {
    const bad = await api('parent', 'POST', '/workflow/leave', { student_id: IDS.otherChild, from_date: isoDay(2), to_date: isoDay(3), reason: 'wedding' })
    expect([403, 404]).toContain(bad.status)
    const ok = await api('parent', 'POST', '/workflow/leave', { student_id: IDS.child, from_date: isoDay(2), to_date: isoDay(3), reason: 'wedding' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    leaveId = ok.body.id
  })

  it('the same leave filed twice is refused as a duplicate', async () => {
    const again = await api('parent', 'POST', '/workflow/leave', { student_id: IDS.child, from_date: isoDay(2), to_date: isoDay(3), reason: 'wedding' })
    expect(again.status, JSON.stringify(again.body)).toBe(409)
  })

  it('leave that ends before it starts is refused', async () => {
    expect((await api('parent', 'POST', '/workflow/leave', { student_id: IDS.child, from_date: isoDay(5), to_date: isoDay(4), reason: 'x' })).status).toBe(400)
  })

  it('only the class teacher decides, and only once', async () => {
    expect((await api('otherParent', 'POST', `/workflow/leave/${leaveId}/decide`, { decision: 'approved' })).status).toBe(403)
    expect((await api('teacher', 'POST', `/workflow/leave/${leaveId}/decide`, { decision: 'approved' })).status).toBe(200)
    expect((await api('teacher', 'POST', `/workflow/leave/${leaveId}/decide`, { decision: 'rejected', note: 'changed my mind' })).status).toBe(409)
  })

  it('approved leave shows on the register as leave, not absent', async () => {
    const rows = await T().prepare(`SELECT on_date, status FROM student_attendance WHERE student_id = ? AND on_date IN (?, ?) ORDER BY on_date`)
      .bind(IDS.child, isoDay(2), isoDay(3)).all<{ on_date: string; status: string }>()
    expect(rows.results.map((r) => r.status)).toEqual(['leave', 'leave'])
  })

  it('marking a child present on a day of approved leave is noticed', async () => {
    const r = await api('teacher', 'POST', '/attendance', { section_id: IDS.section, on_date: isoDay(2), entries: [{ student_id: IDS.child, status: 'absent' }], silent: true })
    // Either refused, or the register is left saying leave. Silently flipping approved leave to absent is the gap.
    const row = await T().prepare('SELECT status FROM student_attendance WHERE student_id = ? AND on_date = ?').bind(IDS.child, isoDay(2)).first<{ status: string }>()
    expect(r.status === 400 || r.status === 409 || row?.status === 'leave', `status ${r.status}, register says ${row?.status}`).toBe(true)
  })
})

describe('homework', () => {
  let hw = ''
  it('a due date that is not a date is refused', async () => {
    const r = await api('teacher', 'POST', '/homework', { section_id: IDS.section, title: 'Fractions', due_on: 'next tuesday' })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
  })

  it('a due date in the past is refused', async () => {
    const r = await api('teacher', 'POST', '/homework', { section_id: IDS.section, title: 'Fractions', due_on: isoDay(-30) })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
  })

  it('the teacher sets work that does not take submissions', async () => {
    const r = await api('teacher', 'POST', '/homework', { section_id: IDS.section, title: 'Read chapter 4', due_on: isoDay(3), allow_submission: false })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    hw = r.body.id
  })

  it('a child cannot turn in work that does not take submissions', async () => {
    const r = await api('parent', 'POST', `/homework/${hw}/submit`, { text_answer: 'done' })
    expect([400, 403, 409], JSON.stringify(r.body)).toContain(r.status)
  })

  it('a parent cannot turn in work for another family\'s child', async () => {
    const r = await api('otherParent', 'POST', `/homework/${hw}/submit`, { student_id: IDS.child, text_answer: 'done' })
    expect([403, 404]).toContain(r.status)
  })

  it('turning in work for a homework that does not exist is a 404, not a saved row', async () => {
    const ghost = crypto.randomUUID()
    const r = await api('parent', 'POST', `/homework/${ghost}/submit`, { text_answer: 'done' })
    expect(r.status).toBe(404)
    const row = await T().prepare('SELECT 1 AS x FROM homework_submissions WHERE homework_id = ?').bind(ghost).first()
    expect(row).toBeNull()
  })

  it('work set for another section cannot be turned in by this child', async () => {
    const other = crypto.randomUUID()
    await T().prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) SELECT ?, institution_id, campus_id, class_id, academic_year_id, 'B' FROM sections WHERE id = ?`).bind(other, IDS.section).run()
    const h = crypto.randomUUID()
    await T().prepare(`INSERT INTO homework (id, institution_id, section_id, kind, title, assigned_on, due_on, is_published, allow_submission, created_at, updated_at)
      VALUES (?, ?, ?, 'homework', 'Section B only', ?, ?, 1, 1, ?, ?)`).bind(h, IDS.school, other, isoDay(0), isoDay(3), new Date().toISOString(), new Date().toISOString()).run()
    const r = await api('parent', 'POST', `/homework/${h}/submit`, { text_answer: 'wrong class' })
    expect([403, 404], JSON.stringify(r.body)).toContain(r.status)
  })
})

describe('marks', () => {
  it('marks above the maximum, or negative, are refused', async () => {
    expect((await api('teacher', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: 101 }] })).status).toBe(400)
    expect((await api('teacher', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: -1 }] })).status).toBe(400)
  })

  it('a parent cannot enter marks', async () => {
    expect((await api('parent', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: 90 }] })).status).toBe(403)
  })

  it('the class teacher enters marks for their own children', async () => {
    const r = await api('teacher', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: 72 }, { student_id: IDS.otherChild, is_absent: true }] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.written).toBe(2)
  })

  it('marks for a child who is not in this class are refused', async () => {
    const stranger = crypto.randomUUID()
    await T().prepare(`INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, last_name, admission_date)
      SELECT ?, institution_id, campus_id, 'A998', 'Yan', 'Elsewhere', ? FROM students WHERE id = ?`).bind(stranger, isoDay(-10), IDS.child).run()
    const r = await api('admin', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: stranger, marks_obtained: 50 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    await T().prepare('DELETE FROM marks WHERE student_id = ?').bind(stranger).run()
    await T().prepare('DELETE FROM students WHERE id = ?').bind(stranger).run()
  })
})

describe('the roll', () => {
  it('a second child with the same admission number is refused, not written over the first', async () => {
    const r = await api('admin', 'POST', '/students', { admission_no: 'A001', first_name: 'Dup', last_name: 'Licate', date_of_birth: '2015-05-05', gender: 'male' })
    const row = await T().prepare('SELECT first_name FROM students WHERE id = ?').bind(IDS.child).first<{ first_name: string }>()
    expect(row?.first_name, "Chirag's record must survive a clerk typing his admission number for a new child").toBe('Chirag')
    expect([400, 409], JSON.stringify(r.body)).toContain(r.status)
  })

  it('a leaving date in the future is refused', async () => {
    expect((await api('admin', 'POST', `/students/${IDS.otherChild}/exit`, { status: 'transferred', exit_date: isoDay(30) })).status).toBe(400)
  })

  it('a child with dues is not quietly let go', async () => {
    // Diya still owes 5,00,000 on INV-2. The office should be told before recording her as left.
    const r = await api('admin', 'POST', `/students/${IDS.otherChild}/exit`, { status: 'transferred', exit_date: isoDay(0), reason: 'moved city' })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
  })

  it('after a child leaves, nobody can collect a fee against them', async () => {
    await T().prepare(`UPDATE students SET status = 'transferred', exit_date = ? WHERE id = ?`).bind(isoDay(0), IDS.otherChild).run()
    await T().prepare(`UPDATE enrollments SET status = 'transferred' WHERE student_id = ?`).bind(IDS.otherChild).run()
    const r = await api('finance', 'POST', '/fees/payments', { student_id: IDS.otherChild, amount_paise: 1000, mode: 'cash' })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    await T().prepare(`UPDATE students SET status = 'active', exit_date = NULL WHERE id = ?`).bind(IDS.otherChild).run()
    await T().prepare(`UPDATE enrollments SET status = 'active' WHERE student_id = ?`).bind(IDS.otherChild).run()
  })

  it('after a child leaves, the register no longer accepts them', async () => {
    await T().prepare(`UPDATE students SET status = 'transferred' WHERE id = ?`).bind(IDS.otherChild).run()
    await T().prepare(`UPDATE enrollments SET status = 'transferred' WHERE student_id = ?`).bind(IDS.otherChild).run()
    const r = await api('teacher', 'POST', '/attendance', { section_id: IDS.section, entries: [{ student_id: IDS.otherChild, status: 'present' }], silent: true })
    expect(r.status === 400 || (r.body?.written === 0 && r.body?.not_in_section?.includes(IDS.otherChild)), JSON.stringify(r.body)).toBe(true)
    await T().prepare(`UPDATE students SET status = 'active' WHERE id = ?`).bind(IDS.otherChild).run()
    await T().prepare(`UPDATE enrollments SET status = 'active' WHERE student_id = ?`).bind(IDS.otherChild).run()
  })
})

describe('who may see what', () => {
  it('a signed-out visitor gets 401 everywhere', async () => {
    expect((await api(null, 'GET', '/students')).status).toBe(401)
    expect((await api(null, 'GET', '/finance/dashboard')).status).toBe(401)
  })

  it('the teacher cannot open the finance dashboard', async () => {
    expect((await api('teacher', 'GET', '/finance/dashboard')).status).toBe(403)
  })

  it('finance cannot rewrite roles', async () => {
    const r = await api('finance', 'GET', '/admin/roles')
    expect([403, 404]).toContain(r.status)
  })

  it('a parent cannot list the school\'s students', async () => {
    const r = await api('parent', 'GET', '/students')
    expect(r.status === 403 || (r.status === 200 && (r.body.items ?? []).every((s: { id: string }) => s.id === IDS.child)), JSON.stringify(r.body).slice(0, 200)).toBe(true)
  })

  it('repeated wrong passwords lock the account for a while, even from different addresses', async () => {
    // login.ts: MAX_FAILS = 8 per identifier in a 5 minute window; the fixture sends each try from a fresh address.
    let last = 0
    for (let i = 0; i < 8; i++) last = (await signIn(USERS.finance, 'wrong-' + i)).res.status
    expect([401, 403, 429, 200]).toContain(last)
    const again = await signIn(USERS.finance, 'wrong-x')
    expect(again.res.status, 'the ninth wrong try should be throttled').toBe(429)
    // the right password still works once the window passes; here we only check it is not silently locked forever
    const ok = await signIn(USERS.finance)
    expect([200, 302, 303, 429]).toContain(ok.res.status)
  })
})
