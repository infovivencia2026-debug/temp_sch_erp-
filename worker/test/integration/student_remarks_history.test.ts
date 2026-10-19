/* A teacher's remark lands in the child's history (GET /students/{id}/detail):
   staff see every remark; a family reads only the shared ones, from the portal. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS } from './fixture'

beforeAll(seed)

describe('remarks in the student history', () => {
  it('shows shared and private remarks to staff, only shared ones to the parent (in the portal)', async () => {
    const shared = await api('teacher', 'POST', '/teaching/remarks', { student_id: IDS.child, kind: 'academic', body: 'Reads aloud well' })
    expect(shared.status).toBe(201)
    const hidden = await api('teacher', 'POST', '/teaching/remarks', { student_id: IDS.child, kind: 'academic', body: 'Needs a seat near the front', private: true })
    expect(hidden.status).toBe(201)

    const staff = await api('admin', 'GET', `/students/${IDS.child}/detail`)
    expect(staff.status).toBe(200)
    const staffBodies = staff.body.remarks.map((r: { body: string }) => r.body)
    expect(staffBodies).toEqual(expect.arrayContaining(['Reads aloud well', 'Needs a seat near the front']))

    /* The student detail is a staff screen (students.read); a family reads
       its child's remarks from the portal, and only the shared ones. */
    const blocked = await api('parent', 'GET', `/students/${IDS.child}/detail`)
    expect(blocked.status).toBe(403)
    const family = await api('parent', 'GET', `/portal/remarks?student_id=${IDS.child}`)
    expect(family.status).toBe(200)
    const familyBodies = family.body.items.map((r: { body: string }) => r.body)
    expect(familyBodies).toContain('Reads aloud well')
    expect(familyBodies).not.toContain('Needs a seat near the front')

  })
})
