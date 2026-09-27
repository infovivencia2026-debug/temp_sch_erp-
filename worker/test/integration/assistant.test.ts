/* The assistant's tools and actions, with a scripted fake in place of Gemini.

   The fake (globalThis.__FAKE_GEMINI__, honoured only when APP_ENV=test)
   answers each generateContent call with the next scripted reply, so a test
   can make the "model" call any tool with any arguments -- including ones a
   real model should never try -- and check what the Worker does with them.
   What is proved here: a tool reads only what the caller may see (a parent
   cannot reach another family's child by name or by id), nothing changes
   until Confirm, Confirm refuses a card whose arguments were altered or that
   was never issued, and every tool call lands in the audit log. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { seed, api, as, call, IDS, isoDay, E, type Who } from './fixture'

beforeAll(seed)

type Part = Record<string, unknown>
let script: Part[][] = []
const seen: Record<string, unknown>[] = []
;(globalThis as { __FAKE_GEMINI__?: unknown }).__FAKE_GEMINI__ = (payload: Record<string, unknown>) => {
  seen.push(payload)
  const parts = script.shift() ?? [{ text: 'Done.' }]
  return { candidates: [{ content: { role: 'model', parts } }] }
}
afterEach(() => { script = []; seen.length = 0 })

const fn = (name: string, args: Record<string, unknown>) => ({ functionCall: { name, args } })

/** Ask the agent as someone; the stream parsed into its events. */
async function ask(who: Who, message: string): Promise<Record<string, any>[]> {
  const res = await call('/api/v1/assistant/agent', {
    method: 'POST', cookie: await as(who), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }),
  })
  expect(res.status).toBe(200)
  const text = new TextDecoder().decode(await res.arrayBuffer())
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const done = (ev: Record<string, any>[]) => ev.filter((e) => e.t === 'tool_done')
/** What the fake handed back to the model as the answer to its tool call. */
const toolAnswer = (i = 1) => {
  const contents = seen[i]?.contents as { role: string; parts: Part[] }[]
  return (contents[contents.length - 1].parts[0] as any).functionResponse.response.result
}

describe('assistant tools: scope is the route\'s', () => {
  it('lets a parent read their own child', async () => {
    script = [[fn('student_profile', { student: 'Chirag' })], [{ text: 'Chirag is in Class 5 A.' }]]
    const ev = await ask('parent', 'How is Chirag doing?')
    expect(done(ev)[0].ok).toBe(true)
    expect(JSON.stringify(toolAnswer())).toContain('Chirag')
    expect(ev.at(-1)).toMatchObject({ t: 'answer', text: 'Chirag is in Class 5 A.' })
  })

  it("does not give a parent another family's child by name", async () => {
    script = [[fn('student_profile', { student: 'Diya' })], [{ text: 'I cannot see that.' }]]
    const ev = await ask('parent', 'Show me Diya')
    expect(done(ev)[0].ok).toBe(false)
    expect(JSON.stringify(toolAnswer())).not.toContain('A002')
  })

  it("does not give a parent another family's child by id either", async () => {
    script = [[fn('student_fee_ledger', { student: IDS.otherChild }), fn('student_attendance', { student: IDS.otherChild })], [{ text: 'No.' }]]
    const ev = await ask('parent', 'fees of that other child')
    expect(done(ev).map((d) => d.ok)).toEqual([false, false])
    const answers = JSON.stringify((seen[1].contents as any[]).at(-1))
    expect(answers).not.toContain('INV-2')
    expect(answers).not.toContain('Diya')
  })

  it('offers a parent no staff tools, and refuses one the model makes up', async () => {
    script = [[fn('fee_defaulters', {})], [{ text: 'No.' }]]
    const ev = await ask('parent', 'who owes fees?')
    const names = ((seen[0].tools as any[])[0].functionDeclarations as { name: string }[]).map((d) => d.name)
    expect(names).not.toContain('fee_defaulters')
    expect(names).not.toContain('propose_notice_send')
    expect(ev.find((e) => e.t === 'tool')).toBeUndefined()
    expect(toolAnswer()).toMatchObject({ error: expect.stringContaining('no such tool') })
  })

  it('lets the finance office list defaulters, capped and linked', async () => {
    script = [[fn('fee_defaulters', { include_not_yet_due: true })], [{ text: 'Two families owe.' }]]
    const ev = await ask('finance', 'who owes fees?')
    const d = done(ev)[0]
    expect(d.ok).toBe(true)
    expect(d.view.rows.length).toBe(2)
    expect(d.view.row_links[0]).toMatch(/^\/go\//)
  })

  it('writes every tool call to the audit log', async () => {
    script = [[fn('search_students', { query: 'Chirag' })], [{ text: 'ok' }]]
    await ask('teacher', 'find Chirag')
    const row = await E.TENANT_TEST.prepare(`SELECT actor_user_id, after FROM audit_log WHERE action = 'assistant.tool' ORDER BY created_at DESC LIMIT 1`).first<{ actor_user_id: string; after: string }>()
    expect(row?.actor_user_id).toBe(IDS.teacher)
    expect(JSON.parse(row!.after)).toEqual({ tool: 'search_students', params: { query: 'Chirag' } })
  })
})

describe('assistant actions: nothing happens until Confirm', () => {
  const day = isoDay(-1)
  const marks = () => E.TENANT_TEST.prepare(`SELECT student_id, status FROM student_attendance WHERE section_id = ? AND on_date = ?`).bind(IDS.section, day).all()

  it('proposes "all present except Diya", writes nothing, then Confirm writes it', async () => {
    script = [[fn('propose_attendance_bulk', { class: '5', section: 'A', date: day, absent: ['Diya'] })], [{ text: 'Ready to confirm.' }]]
    const ev = await ask('teacher', 'mark 5A all present except Diya for yesterday')
    const card = ev.find((e) => e.t === 'action')!.action
    expect(card.kind).toBe('attendance.bulk')
    expect(card.counts).toEqual(expect.arrayContaining([{ label: 'present', value: 1 }, { label: 'absent', value: 1 }]))
    expect(card.token).toBeTruthy()
    expect((await marks()).results).toHaveLength(0)

    // Altered arguments: Diya marked present instead. Refused, nothing written.
    const tampered = { ...card.params, entries: card.params.entries.map((e: any) => ({ ...e, status: 'present' })) }
    const bad = await api('teacher', 'POST', '/assistant/confirm', { kind: card.kind, params: tampered, token: card.token })
    expect(bad.status).toBe(400)
    // No token at all: never proposed.
    expect((await api('teacher', 'POST', '/assistant/confirm', { kind: card.kind, params: card.params })).status).toBe(400)
    expect((await marks()).results).toHaveLength(0)

    const good = await api('teacher', 'POST', '/assistant/confirm', { kind: card.kind, params: card.params, token: card.token })
    expect(good.status).toBe(200)
    const byStudent = Object.fromEntries((await marks()).results.map((r: any) => [r.student_id, r.status]))
    expect(byStudent).toEqual({ [IDS.child]: 'present', [IDS.otherChild]: 'absent' })
    const audit = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'assistant.confirm' AND actor_user_id = ?`).bind(IDS.teacher).first<{ n: number }>()
    expect(audit?.n).toBeGreaterThanOrEqual(1)
  })

  it("refuses another person's card, and a person without the permission", async () => {
    script = [[fn('propose_homework_create', { class: '5', section: 'A', title: 'Fractions worksheet' })], [{ text: 'Ready.' }]]
    const ev = await ask('teacher', 'set homework')
    const card = ev.find((e) => e.t === 'action')!.action
    const count = async () => (await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM homework WHERE title = 'Fractions worksheet'`).first<{ n: number }>())?.n
    expect(await count()).toBe(0)
    // The admin may set homework, but this card was signed for the teacher.
    expect((await api('admin', 'POST', '/assistant/confirm', { kind: card.kind, params: card.params, token: card.token })).status).toBe(400)
    // The parent lacks the permission outright.
    expect((await api('parent', 'POST', '/assistant/confirm', { kind: card.kind, params: card.params, token: card.token })).status).toBe(403)
    const ok = await api('teacher', 'POST', '/assistant/confirm', { kind: card.kind, params: card.params, token: card.token })
    expect(ok.status).toBe(200)
    expect(await count()).toBe(1)
  })

  it('does not offer a parent any action, and refuses a proposal the model makes up', async () => {
    script = [[fn('propose_notice_send', { title: 'Holiday', body: 'Tomorrow is a holiday', audience: 'everyone' })], [{ text: 'No.' }]]
    const ev = await ask('parent', 'tell everyone tomorrow is a holiday')
    expect(ev.find((e) => e.t === 'action')).toBeUndefined()
    const n = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM announcements WHERE title = 'Holiday'`).first<{ n: number }>()
    expect(n?.n).toBe(0)
  })

  it('refuses a teacher marking a section that is not theirs, at preview', async () => {
    await E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) SELECT ?, institution_id, campus_id, class_id, academic_year_id, 'B' FROM sections WHERE id = ?`)
      .bind('00000000-0000-4000-8000-000000000014', IDS.section).run()
    script = [[fn('propose_attendance_bulk', { class: '5', section: 'B' })], [{ text: 'No.' }]]
    const ev = await ask('teacher', 'mark 5B present')
    expect(ev.find((e) => e.t === 'action')).toBeUndefined()
    expect(done(ev)[0]).toMatchObject({ ok: false, error: expect.stringContaining('own sections') })
  })
})
