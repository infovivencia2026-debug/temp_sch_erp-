/* The class teacher marks the register; the parent sees it. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, isoDay, E } from './fixture'

beforeAll(seed)
const today = isoDay()

describe('attendance', () => {
  it('lets the class teacher mark her section', async () => {
    const { status, body } = await api('teacher', 'POST', '/attendance', {
      section_id: IDS.section, on_date: today,
      entries: [{ student_id: IDS.child, status: 'present' }, { student_id: IDS.otherChild, status: 'absent' }],
    })
    expect(status).toBe(200)
    expect(body).toMatchObject({ submitted: 2, written: 2, newly_absent: 1 })
    expect(body.parents_told).toBeGreaterThanOrEqual(1)
  })

  it('reads the register back', async () => {
    const { body } = await api('teacher', 'GET', `/attendance?on_date=${today}&section_id=${IDS.section}`)
    const byStudent = Object.fromEntries(body.items.map((r: any) => [r.student_id, r.status]))
    expect(byStudent).toEqual({ [IDS.child]: 'present', [IDS.otherChild]: 'absent' })
  })

  it('writes only what changed on a second submission, and records the correction', async () => {
    const { body } = await api('teacher', 'POST', '/attendance', {
      section_id: IDS.section, on_date: today, silent: true,
      entries: [{ student_id: IDS.child, status: 'present' }, { student_id: IDS.otherChild, status: 'late', minutes_late: 10 }],
    })
    expect(body.written).toBe(1)
    const row = await E.TENANT_TEST.prepare(`SELECT status, corrected_from FROM student_attendance WHERE student_id = ? AND on_date = ?`)
      .bind(IDS.otherChild, today).first()
    expect(row).toEqual({ status: 'late', corrected_from: 'absent' })
  })

  it('tells the absent child\'s parent', async () => {
    const n = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM notifications WHERE user_id = ?`).bind(IDS.otherParent).first<{ n: number }>()
    expect(n?.n).toBeGreaterThanOrEqual(1)
  })

  it('rejects an unknown status', async () => {
    const { status } = await api('teacher', 'POST', '/attendance', { section_id: IDS.section, entries: [{ student_id: IDS.child, status: 'asleep' }] })
    expect(status).toBe(400)
  })

  it('shows the parent their own child\'s day', async () => {
    const { status, body } = await api('parent', 'GET', `/portal/attendance?student_id=${IDS.child}`)
    expect(status).toBe(200)
    const day = (body.items ?? body.days ?? []).find((d: any) => d.date === today)
    expect(day?.status).toBe('present')
  })
})
