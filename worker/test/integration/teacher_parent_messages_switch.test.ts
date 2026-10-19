/* The school switch "Teachers message parents directly" (module
   teacher_parent_messages). Off: a class teacher messages colleagues only and
   the parent's address book of teachers is empty; on (the default) it is as
   before. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, call, signIn, IDS, E, USERS } from './fixture'

async function req(cookie: string, method: string, path: string, body?: unknown) {
  const res = await call('/api/v1' + path, { method, cookie,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}

const setSwitch = (on: boolean) => E.TENANT_TEST.prepare(`INSERT INTO module_settings (institution_id, module, enabled) VALUES (?, 'teacher_parent_messages', ?)
    ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled`).bind(IDS.school, on ? 1 : 0).run()

let teacher = ''
beforeAll(async () => {
  await seed()
  teacher = (await signIn(USERS.teacher)).cookie ?? ''
  if (!teacher) throw new Error('sign-in as the class teacher failed')
})
afterAll(async () => { await setSwitch(true) })

describe('teacher to parent messages switch', () => {
  it('off: the class teacher cannot write to a parent but can write to a colleague', async () => {
    await setSwitch(false)
    const r = await req(teacher, 'POST', '/portal/messages', { student_id: IDS.child, parent_user_id: IDS.parent, body: 'Hello' })
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.body)).toContain('class notice')
    expect((await req(teacher, 'POST', '/staff-messages', { to: IDS.admin, body: 'Register is done' })).status).toBe(201)
  })

  it('on: the class teacher writes to the parent of a child in their class', async () => {
    await setSwitch(true)
    const r = await req(teacher, 'POST', '/portal/messages', { student_id: IDS.child, parent_user_id: IDS.parent, body: 'Hello' })
    expect(r.status).toBe(201)
  })
})
