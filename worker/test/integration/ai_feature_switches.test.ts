/* Per-school AI feature switches (settings group 'ai', services/ai/llm.ts
   AI_FEATURES): with a switch off the route refuses with ai_feature_off and
   the weekly parent-note sweep skips the school. Default is on. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'
import { weeklySweep } from '../../src/services/ai/briefs'

const g = globalThis as { __FAKE_GEMINI__?: unknown }
const ALL = ['smart_import', 'write_messages', 'notice_draft', 'notice_translate', 'student_summary', 'parent_weekly',
  'lms_quiz_draft', 'admissions_draft', 'remarks_draft', 'leave_reply_draft', 'fee_reminder_draft', 'principal_brief', 'early_warnings']
const setAll = (on: boolean) => api('admin', 'PUT', '/ai/settings', { features: Object.fromEntries(ALL.map((f) => [f, on])) })

beforeAll(async () => {
  await seed()
  g.__FAKE_GEMINI__ = () => ({ candidates: [{ content: { parts: [{ text: '{"drafts":["x"]}' }] } }] })
})
afterAll(async () => { await setAll(true); delete g.__FAKE_GEMINI__ })

describe('AI feature switches', () => {
  it('are on by default and listed in /ai/status', async () => {
    const st = await api('teacher', 'GET', '/ai/status')
    for (const f of ALL) expect(st.body.features[f]).toBe(true)
  })

  it('refuse every switched-off AI route', async () => {
    const before = await api('admin', 'GET', '/ai/settings')
    expect((await setAll(false)).status).toBe(200)
    const after = await api('admin', 'GET', '/ai/settings')
    expect(after.body.daily_cap).toBe(before.body.daily_cap) // other AI settings kept
    expect((await api('teacher', 'GET', '/ai/status')).body.features.notice_draft).toBe(false)
    const calls: [string, 'GET' | 'POST', string, unknown?][] = [
      ['teacher', 'POST', '/ai/draft', { kind: 'parent_message', student_id: IDS.child }],
      ['admin', 'POST', '/ai/draft', { kind: 'circular', topic: 'Holiday' }],
      ['teacher', 'POST', '/ai/draft', { kind: 'report_remark', student_id: IDS.child }],
      ['teacher', 'POST', '/ai/draft', { kind: 'teacher_remark', student_id: IDS.child }],
      ['admin', 'POST', '/ai/draft', { kind: 'enquiry_follow_up' }],
      ['admin', 'POST', '/ai/draft', { kind: 'admission_decision' }],
      ['admin', 'POST', '/ai/draft', { kind: 'leave_reply' }],
      ['admin', 'POST', '/ai/draft', { kind: 'fee_reminder' }],
      ['admin', 'POST', '/ai/translate', { text: 'School closes at noon', language: 'te' }],
      ['admin', 'GET', `/ai/briefs/student/${IDS.child}`],
      ['admin', 'POST', `/ai/briefs/student/${IDS.child}`],
      ['admin', 'GET', '/ai/briefs/principal'],
      ['admin', 'POST', '/ai/briefs/principal'],
      ['parent', 'GET', `/portal/ai/weekly?student_id=${IDS.child}`],
      ['admin', 'POST', '/ai/import/propose', { table: { headers: ['Name'], rows: [['A']] } }],
      ['admin', 'POST', '/ai/import/preview', { kind: 'students', table: { headers: ['Name'], rows: [['A']] } }],
      ['admin', 'POST', '/ai/import/commit', { kind: 'students', table: { headers: ['Name'], rows: [['A']] } }],
    ]
    for (const [who, m, path, body] of calls) {
      const r = await api(who as 'admin', m, path, body)
      expect([path, r.status, r.body.code]).toEqual([path, 403, 'ai_feature_off'])
    }
  })

  it('the weekly parent-note sweep skips the school', async () => {
    await setAll(false)
    const res = await weeklySweep(E, E.TENANT_TEST, { id: IDS.school })
    expect(res).toMatchObject({ written: 0, stopped: 'ai_feature_off' })
  })

  it('come back on', async () => {
    await setAll(true)
    const r = await api('teacher', 'POST', '/ai/draft', { kind: 'report_remark', student_id: IDS.child })
    expect(r.status).toBe(200)
  })
})
