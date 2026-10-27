/* Owner, 2026-10-27: "It should never repeat again in anything like this."
   Any write by one user reaches every other user's next /portal/live answer
   as the tables it touched, with no route announcing itself (live_changes.ts,
   recorded from index.ts). User A writes; user B's poll names the change. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api } from './fixture'
import { wordsFor } from '../../../shared/live-areas'

beforeAll(async () => { await seed() })

type Live = { rev: string; tables: string[] | null }
const seqOf = (rev: string) => rev.split('|')[9]

async function changedBy(write: () => Promise<{ status: number }>): Promise<string[]> {
  const before = await api<Live>('teacher', 'GET', '/portal/live')
  expect(before.status).toBe(200)
  const res = await write()
  expect(res.status).toBeLessThan(300)
  const after = await api<Live>('teacher', 'GET', `/portal/live?since=${seqOf(before.body.rev)}`)
  expect(seqOf(after.body.rev)).not.toBe(seqOf(before.body.rev))
  return after.body.tables ?? []
}

describe('a write by one user shows in every other user\'s live poll', () => {
  it('a class added by the admin', async () => {
    const t = await changedBy(() => api('admin', 'POST', '/setup/classes', { name: 'Class 9 live', level: 9 }))
    expect(t).toContain('classes')
    expect([...(wordsFor(t) ?? [])]).toContain('class')
  })

  it('an admissions enquiry and the salary components', async () => {
    const e = await changedBy(() => api('admin', 'POST', '/admissions/workflow/enquiries', { student_name: 'Live Kid', phone: '9000000099' }))
    expect(e.some((x) => x.startsWith('enquir'))).toBe(true)
    const p = await changedBy(() => api('admin', 'POST', '/payroll/components', { starters: true }))
    expect(p).toContain('salary_components')
  })

  it('a phone the teacher saves on their own profile', async () => {
    const before = await api<Live>('admin', 'GET', '/portal/live')
    const put = await api('teacher', 'PUT', '/profile', { full_name: 'Tara Teacher', phone: '9444444444' })
    expect(put.status).toBe(200)
    const after = await api<Live>('admin', 'GET', `/portal/live?since=${seqOf(before.body.rev)}`)
    expect(after.body.tables).toContain('users')
    const words = [...(wordsFor(after.body.tables ?? []) ?? [])]
    for (const k of ['admin-users', 'school-logins', 'people-search', 'profile'])
      expect(words.some((w) => k.includes(w)), k).toBe(true)
  })

  it('a read moves nothing', async () => {
    const a = await api<Live>('teacher', 'GET', '/portal/live')
    await api('admin', 'GET', '/hr/employees?limit=5')
    const b = await api<Live>('teacher', 'GET', `/portal/live?since=${seqOf(a.body.rev)}`)
    expect(seqOf(b.body.rev)).toBe(seqOf(a.body.rev))
    expect(b.body.tables).toEqual([])
  })
})

describe('the tables a statement writes', () => {
  it('reads INSERT, UPDATE, DELETE and upserts, not the SET of an upsert', async () => {
    const { writtenTables } = await import('../../src/idcache')
    expect(writtenTables(`INSERT INTO sections (id) VALUES (?) ON CONFLICT (id) DO UPDATE SET name = excluded.name`)).toEqual(['sections'])
    expect(writtenTables(`UPDATE employees SET phone = ?`)).toEqual(['employees'])
    expect(writtenTables(`DELETE FROM holidays WHERE id = ?`)).toEqual(['holidays'])
    expect(writtenTables(`SELECT * FROM users`)).toEqual([])
  })
})
