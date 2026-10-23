/* Moving a child to another section is the office's (owner, 2026-10-22): a
   class teacher holds students.write but is refused both move routes. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS } from './fixture'

beforeAll(seed)

describe('section move', () => {
  it('refuses a class teacher on both move routes', async () => {
    for (const path of [`/students/${IDS.child}/section-change`, `/students/${IDS.child}/section`]) {
      expect((await api('teacher', 'POST', path, { section_id: IDS.section })).status).toBe(403)
    }
  })

  it('lets the admin through the permission check', async () => {
    // Same section, so the handler refuses on its own rule: the gate let it in.
    const r = await api('admin', 'POST', `/students/${IDS.child}/section-change`, { section_id: IDS.section })
    expect(r.status).toBe(400)
  })
})
