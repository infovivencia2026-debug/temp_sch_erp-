/* GET /portal/live: the 30s "has anything you can see changed?" revision.
   It is answered from indexes now (institution_id for staff, student_id for a
   family); a family must still see only its own children move. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E, isoDay } from './fixture'

beforeAll(seed)

const mark = (student: string, at: string) => E.TENANT_TEST.prepare(
  `INSERT INTO student_attendance (institution_id, student_id, section_id, on_date, status, marked_at) VALUES (?, ?, ?, ?, 'present', ?)`)
  .bind(IDS.school, student, IDS.section, isoDay(0), at).run()

describe('portal live revision', () => {
  it("moves for a parent only when their own child's register moves; always for staff", async () => {
    const rev = async (who: 'parent' | 'admin') => {
      const r = await api<{ rev: string }>(who, 'GET', '/portal/live')
      expect(r.status).toBe(200)
      return r.body.rev
    }
    const p0 = await rev('parent'), s0 = await rev('admin')
    await mark(IDS.otherChild, '2030-01-01T10:00:00Z')
    expect(await rev('parent')).toBe(p0)
    const s1 = await rev('admin')
    expect(s1).not.toBe(s0)
    await mark(IDS.child, '2030-01-02T10:00:00Z')
    expect(await rev('parent')).not.toBe(p0)
    expect(await rev('admin')).not.toBe(s1)
  })

  it('uses an index for every part of the staff query', async () => {
    const plan = (await E.TENANT_TEST.prepare(`EXPLAIN QUERY PLAN SELECT
        (SELECT max(a.marked_at) FROM student_attendance a WHERE a.institution_id = ?1),
        (SELECT max(m.entered_at) FROM marks m WHERE m.institution_id = ?1),
        (SELECT max(i.updated_at) FROM invoices i WHERE i.institution_id = ?1),
        (SELECT max(h.updated_at) FROM homework h WHERE h.institution_id = ?1)`).bind(IDS.school).all<{ detail: string }>()).results
    expect(plan.filter((r) => /^SCAN (a|m|i|h)\b/.test(r.detail))).toEqual([])
  })
})

describe('portal live revision shape', () => {
  it('always has seven positions, so the client can tell which part moved', async () => {
    const r = await api<{ rev: string }>('otherParent', 'GET', '/portal/live')
    expect(r.body.rev.split('|')).toHaveLength(7)
  })
})
