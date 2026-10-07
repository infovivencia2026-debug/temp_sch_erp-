/* The newer assistant tools (routes/misc/assistant/tools_more.ts), with the
   scripted fake in place of Gemini: each reads through the route its screen
   uses, so the caller sees what that screen would show them and no more. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { seed, as, call, IDS, isoDay, E, type Who } from './fixture'

type Part = Record<string, unknown>
let script: Part[][] = []
const seen: Record<string, unknown>[] = []
;(globalThis as { __FAKE_GEMINI__?: unknown }).__FAKE_GEMINI__ = (payload: Record<string, unknown>) => {
  seen.push(payload)
  const parts = script.shift() ?? [{ text: 'Done.' }]
  return { candidates: [{ content: { role: 'model', parts } }] }
}
afterEach(() => { script = []; seen.length = 0 })
const fn = (name: string, args: Record<string, unknown> = {}) => ({ functionCall: { name, args } })

async function run(who: Who, name: string, args: Record<string, unknown> = {}) {
  script = [[fn(name, args)], [{ text: 'Done.' }]]
  const res = await call('/api/v1/assistant/agent', {
    method: 'POST', cookie: await as(who), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'question' }),
  })
  expect(res.status).toBe(200)
  const ev = new TextDecoder().decode(await res.arrayBuffer()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const done = ev.find((e) => e.t === 'tool_done')
  const contents = (seen[1]?.contents ?? []) as { parts: any[] }[]
  const result = contents.length ? contents[contents.length - 1].parts[0]?.functionResponse?.response?.result : undefined
  return { done, result, text: JSON.stringify(result ?? {}), start: ev.find((e) => e.t === 'tool_start' || e.t === 'tool') }
}

beforeAll(async () => {
  await seed()
  await E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO homework (id, institution_id, section_id, title, due_on, is_published) VALUES (?, ?, ?, 'Fractions worksheet', ?, 1)`)
    .bind('00000000-0000-4000-8000-0000000000e1', IDS.school, IDS.section, isoDay(2)).run()
})

describe('open_screen', () => {
  it('finds a screen the caller can open, as a /go link', async () => {
    const r = await run('admin', 'open_screen', { name: 'attendance' })
    expect(r.done.ok).toBe(true)
    expect(r.done.links?.[0]?.to).toMatch(/^\/go\//)
  })
  it('does not offer a parent a staff screen', async () => {
    const r = await run('parent', 'open_screen', { name: 'payroll salary' })
    expect(r.text).not.toMatch(/payroll/i)
  })
})

describe('homework_due', () => {
  it("gives a parent their own child's homework, named, and not another family's child", async () => {
    const r = await run('parent', 'homework_due')
    expect(r.done.ok).toBe(true)
    expect(r.text).toContain('Fractions worksheet')
    expect(r.text).not.toContain('Diya')
  })
  it("gives the other family only their own child's row", async () => {
    const r = await run('otherParent', 'homework_due')
    expect(r.text).not.toContain('Chirag')
  })
})

describe('pending_approvals', () => {
  it('is not there for a parent (the tool is not offered)', async () => {
    const r = await run('parent', 'pending_approvals')
    expect(r.done?.ok ?? false).toBe(false)
  })
  it('answers the school admin with counts', async () => {
    const r = await run('admin', 'pending_approvals')
    expect(r.done.ok).toBe(true)
    expect(r.text).toMatch(/Leave requests/)
  })
})

describe('my_help_requests, run_troubleshooter, recent_class_status', () => {
  it("reads only the caller's own help requests", async () => {
    const mine = await call('/api/v1/help/requests', { cookie: await as('teacher') }).then((x) => x.json()) as { items: unknown[] }
    const r = await run('teacher', 'my_help_requests')
    expect(r.done.ok).toBe(true)
    expect(r.result.total).toBe(mine.items.length)
  })
  it('runs a check as the caller; an unknown check is refused', async () => {
    const ok = await run('parent', 'run_troubleshooter', { key: 'attendance' })
    expect(ok.done.ok).toBe(true)
    const bad = await run('parent', 'run_troubleshooter', { key: 'drop_tables' })
    expect(bad.done.ok).toBe(false)
  })
  it('a parent cannot run the sign-in check on someone else', async () => {
    const r = await run('parent', 'run_troubleshooter', { key: 'sign_in', who: 'admin@test.school' })
    expect(r.text).not.toMatch(/locked_until|password_hash/)
  })
  it('reads Class Status as the caller', async () => {
    const r = await run('parent', 'recent_class_status')
    expect(r.done.ok).toBe(true)
  })
})
