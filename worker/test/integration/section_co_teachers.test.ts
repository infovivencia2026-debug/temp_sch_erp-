/* A second class teacher for a section (owner, 2026-11-04: head of
   pre-primary with every class-teacher feature in Nursery, Jr KG and Sr KG,
   each class keeping its own class teacher). */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS } from './fixture'

beforeAll(seed)

describe('extra class teachers', () => {
  it('adds one without touching the named class teacher, and gives them the section', async () => {
    const before = await api('finance', 'GET', `/students?mine=class_teacher&section_id=${IDS.section}`)
    const had = (before.body.items ?? []).some((s: { id: string }) => s.id === IDS.child)
    expect(had).toBe(false)

    const put = await api('admin', 'PUT', `/setup/sections/${IDS.section}/co-teachers`, { user_ids: [IDS.finance] })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    const list = await api('admin', 'GET', `/setup/sections/${IDS.section}/co-teachers`)
    expect(list.body.items.map((x: { user_id: string }) => x.user_id)).toEqual([IDS.finance])

    const after = await api('finance', 'GET', `/students?mine=class_teacher&section_id=${IDS.section}`)
    expect(after.status, JSON.stringify(after.body)).toBe(200)
    expect((after.body.items ?? []).some((s: { id: string }) => s.id === IDS.child)).toBe(true)

    const teacher = await api('teacher', 'GET', `/students?mine=class_teacher&section_id=${IDS.section}`)
    expect((teacher.body.items ?? []).some((s: { id: string }) => s.id === IDS.child)).toBe(true)
  })

  it('takes them off again, and refuses a stranger or a bad id', async () => {
    expect((await api('admin', 'PUT', `/setup/sections/${IDS.section}/co-teachers`, { user_ids: [] })).status).toBe(200)
    const list = await api('admin', 'GET', `/setup/sections/${IDS.section}/co-teachers`)
    expect(list.body.items).toEqual([])
    expect((await api('admin', 'PUT', `/setup/sections/${IDS.section}/co-teachers`, { user_ids: ['nope'] })).status).toBe(400)
    expect((await api('teacher', 'PUT', `/setup/sections/${IDS.section}/co-teachers`, { user_ids: [IDS.teacher] })).status).toBe(403)
  })
})
