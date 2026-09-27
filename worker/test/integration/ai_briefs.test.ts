/* "Write with AI" drafting, translation and the AI briefs, on a fake Gemini
   (globalThis.__FAKE_GEMINI__, honoured by routes/teaching/gemini.ts under
   APP_ENV=test). Nothing here leaves the machine. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'
import { weeklySweep } from '../../src/services/ai/briefs'

type Payload = { system_instruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[] }
const seen: { system: string; prompt: string }[] = []
function fake(p: Payload) {
  const system = p.system_instruction.parts[0].text, prompt = p.contents[0].parts[0].text
  seen.push({ system, prompt })
  let text = 'Chirag had a steady week.'
  if (system.includes('"drafts"')) text = '```json\n{"drafts": ["Chirag works hard in Mathematics.", "Chirag is making good progress."]}\n```'
  else if (system.includes('"bullets"')) text = JSON.stringify({ bullets: [{ topic: 'fees', text: 'Fees overdue: none yet.' }, { topic: 'attendance', text: 'No attendance marked yet.' }] })
  else if (system.startsWith('Translate')) text = JSON.stringify({ title: 'సెలవు', text: 'రేపు పాఠశాలకు సెలవు.' })
  return { candidates: [{ content: { parts: [{ text }] } }] }
}
const g = globalThis as { __FAKE_GEMINI__?: unknown }

beforeAll(seed)
afterAll(() => { delete g.__FAKE_GEMINI__ })

describe('AI with no key set', () => {
  it('says so clearly instead of failing', async () => {
    delete g.__FAKE_GEMINI__
    const st = await api('teacher', 'GET', '/ai/status')
    expect(st.body.configured).toBe(false)
    const d = await api('teacher', 'POST', '/ai/draft', { kind: 'report_remark', student_id: IDS.child })
    expect(d.status).toBe(200)
    expect(d.body).toMatchObject({ configured: false, drafts: [] })
    expect(d.body.message).toMatch(/not switched on/)
  })
  it('still gives the principal a plain brief, labelled as such', async () => {
    const r = await api('admin', 'GET', '/ai/briefs/principal')
    expect(r.status).toBe(200)
    expect(r.body.brief.ai).toBe(false)
    expect(r.body.brief.facts.bullets.length).toBeGreaterThan(0)
  })
})

describe('AI on a fake Gemini', () => {
  beforeAll(() => { g.__FAKE_GEMINI__ = fake })

  it('drafts a report-card remark from the student data, as a labelled draft', async () => {
    const r = await api('teacher', 'POST', '/ai/draft', { kind: 'report_remark', student_id: IDS.child, language: 'te', tone: 'encouraging', length: 'short' })
    expect(r.status).toBe(200)
    expect(r.body.label).toBe('AI draft')
    expect(r.body.drafts).toEqual(['Chirag works hard in Mathematics.', 'Chirag is making good progress.'])
    const last = seen.at(-1)!
    expect(last.system).toContain('Telugu')
    expect(last.prompt).toContain('Chirag')
    expect(last.prompt).toContain('Class 5')
  })

  it('keeps drafting inside what the caller may see', async () => {
    expect((await api('parent', 'POST', '/ai/draft', { kind: 'report_remark', student_id: IDS.child })).status).toBe(403)
    expect((await api('parent', 'POST', '/ai/draft', { kind: 'parent_message', student_id: IDS.otherChild })).status).toBe(404)
    expect((await api('parent', 'POST', '/ai/draft', { kind: 'parent_message', student_id: IDS.child, reply_to: 'Please send the project sheet.' })).status).toBe(200)
    expect((await api('parent', 'POST', '/ai/draft', { kind: 'fee_reminder' })).status).toBe(403)
    expect((await api('teacher', 'POST', '/ai/draft', { kind: 'nonsense' })).status).toBe(400)
  })

  it('translates a notice and keeps the original', async () => {
    const r = await api('admin', 'POST', '/ai/translate', { title: 'Holiday', text: 'School is closed tomorrow.', language: 'te' })
    expect(r.status).toBe(200)
    expect(r.body.original).toEqual({ title: 'Holiday', text: 'School is closed tomorrow.' })
    expect(r.body.translated.text).toContain('సెలవు')
  })

  it('writes the principal brief once and reuses it while nothing changes', async () => {
    const a = await api('admin', 'POST', '/ai/briefs/principal')
    expect(a.status).toBe(200)
    expect(a.body.brief).toMatchObject({ ai: true, label: 'AI summary' })
    expect(a.body.brief.facts.bullets[0].link).toBe('/institution_admin/fees/fee_default')
    const b = await api('admin', 'GET', '/ai/briefs/principal')
    expect(b.body.brief.id).toBe(a.body.brief.id)
    expect((await api('teacher', 'GET', '/ai/briefs/principal')).status).toBe(403)
  })

  it('caches the Student 360 summary until the data changes', async () => {
    const a = await api('teacher', 'POST', `/ai/briefs/student/${IDS.child}`)
    expect(a.status).toBe(200)
    expect(a.body.cached).toBe(false)
    const n = seen.length
    const b = await api('teacher', 'POST', `/ai/briefs/student/${IDS.child}`)
    expect(b.body.cached).toBe(true)
    expect(seen.length).toBe(n)
    expect((await api('teacher', 'GET', `/ai/briefs/student/${IDS.child}`)).body.fresh).toBe(true)
    expect((await api('parent', 'GET', `/ai/briefs/student/${IDS.child}`)).status).toBe(403)
  })

  it('writes weekly parent notes, notifies in-app, and shows them only to the family', async () => {
    const res = await weeklySweep(E, E.TENANT_TEST, { id: IDS.school })
    expect(res.written).toBeGreaterThanOrEqual(1)
    const n = await E.TENANT_TEST.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'ai.weekly_note'`).bind(IDS.parent).first<{ n: number }>()
    expect(n!.n).toBe(1)
    const mine = await api('parent', 'GET', `/portal/ai/weekly?student_id=${IDS.child}`)
    expect(mine.status).toBe(200)
    expect(mine.body.brief.label).toBe('AI summary')
    expect((await api('otherParent', 'GET', `/portal/ai/weekly?student_id=${IDS.child}`)).status).toBe(404)
    // Unchanged week: nothing new written, nobody notified twice.
    expect((await weeklySweep(E, E.TENANT_TEST, { id: IDS.school })).written).toBe(0)
  })

  it('stops at the school daily cap', async () => {
    const s = await api('admin', 'GET', '/ai/settings')
    expect((await api('admin', 'PUT', '/ai/settings', { daily_cap: s.body.used_today })).status).toBe(200)
    const r = await api('teacher', 'POST', '/ai/draft', { kind: 'teacher_remark', student_id: IDS.child })
    expect(r.status).toBe(429)
    expect(r.body.code).toBe('ai_cap_reached')
    await api('admin', 'PUT', '/ai/settings', { daily_cap: 300 })
  })
})
