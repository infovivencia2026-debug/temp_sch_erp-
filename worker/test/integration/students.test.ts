/* The student roll and a student's profile, and who may see them. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS } from './fixture'

beforeAll(seed)

describe('students', () => {
  it('lists the roll for the admin', async () => {
    const { status, body } = await api('admin', 'GET', '/students')
    expect(status).toBe(200)
    expect(body.total).toBe(2)
    expect(body.items.map((s: any) => s.admission_no).sort()).toEqual(['A001', 'A002'])
  })

  it('finds a student by search', async () => {
    const { body } = await api('admin', 'GET', '/students?q=Chirag')
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe(IDS.child)
  })

  it("shows a student's profile with class and section", async () => {
    const { status, body } = await api('admin', 'GET', `/students/${IDS.child}/profile`)
    expect(status).toBe(200)
    expect(body).toMatchObject({ admission_no: 'A001', class_name: 'Class 5', section_name: 'A' })
  })

  it('lets the class teacher see the students of her section', async () => {
    const { status, body } = await api('teacher', 'GET', '/students')
    expect(status).toBe(200)
    expect(body.items.length).toBe(2)
  })

  it('404s a student that does not exist', async () => {
    const { status } = await api('admin', 'GET', '/students/00000000-0000-4000-8000-0000000000ff/profile')
    expect(status).toBe(404)
  })

  it('403s the roll for a parent (no students.read)', async () => {
    const { status } = await api('parent', 'GET', '/students')
    expect(status).toBe(403)
  })
})
