/* Early warnings and Import with AI through the real Worker, without a
   Gemini key: the rules and the template sentences, the scoping, and the
   smart import's preview going through the existing importer's dry run. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'

beforeAll(seed)

describe('early warnings', () => {
  it('runs for the admin, and the list and student badge answer', async () => {
    const run = await api('admin', 'POST', '/ai/warnings/run')
    expect(run.status).toBe(200)
    expect(run.body.ai).toBe(false)
    const list = await api('admin', 'GET', '/ai/warnings')
    expect(list.status).toBe(200)
    expect(Array.isArray(list.body.items)).toBe(true)
    const badge = await api('admin', 'GET', `/ai/warnings/student/${IDS.child}`)
    expect(badge.status).toBe(200)
  })

  it('a parent sees nothing and cannot run the checks', async () => {
    expect((await api('parent', 'GET', '/ai/warnings')).body.items).toEqual([])
    expect((await api('parent', 'POST', '/ai/warnings/run')).status).toBe(403)
  })

  it('resolving needs a note', async () => {
    await E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO ai_warnings (id, institution_id, rule, subject_kind, subject_id, subject_name, student_id, section_id, severity, owner_role, evidence, reason, next_step)
      VALUES ('00000000-0000-4000-8000-0000000000a1', ?, 'consecutive_absence', 'student', ?, 'Test Child', ?, ?, 'high', 'class_teacher', '{"consecutive_absent":4}', 'absent 4 days', 'call home')`)
      .bind(IDS.school, IDS.child, IDS.child, IDS.section).run()
    const id = '00000000-0000-4000-8000-0000000000a1'
    expect((await api('teacher', 'POST', `/ai/warnings/${id}/status`, { status: 'resolved' })).status).toBe(400)
    const ok = await api('teacher', 'POST', `/ai/warnings/${id}/status`, { status: 'resolved', note: 'Spoke to mother; child was ill.' })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('resolved')
  })
})

describe('import with AI (no key: header rules)', () => {
  it('previews a messy class list through the students importer, nothing saved', async () => {
    const table = { headers: ['S.No', 'Name of Student', 'Adm No', 'DOB', 'Class', 'Father Mobile'], rows: [['1', 'Ira Nair', 'AI-9001', '14/06/2015', 'V-A', '+91 98450 12345']] }
    const p = await api('admin', 'POST', '/ai/import/propose', { table })
    expect(p.status).toBe(200)
    expect(p.body.proposal.kind).toBe('students')
    const mapping = p.body.proposal.mapping.map((m: any) => ({ index: m.index, field: m.field }))
    const pv = await api('admin', 'POST', '/ai/import/preview', { kind: 'students', table, mapping, source: 'sheet', reviewed: true })
    expect(pv.status).toBe(200)
    expect(pv.body.dry_run).toBe(true)
    expect(pv.body.total).toBe(1)
    expect(pv.body.rows[0]).toMatchObject({ full_name: 'Ira Nair', date_of_birth: '2015-06-14', father_phone: '9845012345', section: 'A' })
    const n = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM students WHERE admission_no = 'AI-9001'`).first<{ n: number }>()
    expect(n?.n).toBe(0)
  })

  it('refuses an unreviewed photo table and an unconfirmed commit', async () => {
    const table = { headers: ['Adm No', 'Date', 'Status'], rows: [['A001', '01/09/2026', 'P']] }
    const mapping = [{ index: 0, field: 'admission_no' }, { index: 1, field: 'date' }, { index: 2, field: 'status' }]
    expect((await api('admin', 'POST', '/ai/import/preview', { kind: 'attendance', table, mapping, source: 'photo', reviewed: false })).status).toBe(400)
    expect((await api('admin', 'POST', '/ai/import/commit', { kind: 'attendance', table, mapping, source: 'sheet' })).status).toBe(400)
  })

  it('a parent cannot import', async () => {
    const r = await api('parent', 'POST', '/ai/import/preview', { kind: 'students', table: { headers: ['Name'], rows: [['x']] }, mapping: [{ index: 0, field: 'full_name' }], source: 'sheet' })
    expect(r.status).toBe(403)
  })
})
