/* Session activity recording (services/session_activity.ts,
   routes/admin/session_activity.ts): off by default and silent while off,
   recording sign-in, screens, time and sign-out when on, behind the right
   permissions, blockable by the seller, and purged past retention. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, call, signIn, E, IDS, USERS } from './fixture'
import { parseAgent, purgeSessionActivity } from '../../src/services/session_activity'

const T = () => E.TENANT_TEST
const count = async (table: string) => (await T().prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

async function beacon(cookie: string, views: unknown[]) {
  return call('/api/v1/session/activity/batch', {
    method: 'POST', cookie, headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ views }),
  })
}

beforeAll(seed)
afterAll(async () => {
  await T().prepare(`DELETE FROM module_settings WHERE module = 'session_activity'`).run()
  await E.CONTROL.prepare(`DELETE FROM school_feature_overrides WHERE feature_id = 'staff.session_activity'`).run()
})

describe('off by default', () => {
  it('reports off and records nothing for a sign-in, screens or a sign-out', async () => {
    const st = await api('admin', 'GET', '/admin/session-activity/settings')
    expect(st.status).toBe(200)
    expect(st.body).toMatchObject({ enabled: false, recording: false, retention_days: 90, seller_blocked: false })
    const before = [await count('session_activity'), await count('session_activity_views')]
    const { cookie } = await signIn(USERS.teacher)
    expect(cookie).toBeTruthy()
    const b = await beacon(cookie!, [{ screen: 'teaching.homework', path: '/class_teacher/teaching/homework', at: new Date().toISOString(), seconds: 30 }])
    expect(b.status).toBe(204)
    await call('/logout', { cookie: cookie! })
    expect([await count('session_activity'), await count('session_activity_views')]).toEqual(before)
    const mine = await api('teacher', 'GET', '/profile/session-activity')
    expect(mine.body).toMatchObject({ recording: false, items: [] })
  })
})

describe('permissions', () => {
  it('keeps the list, the export and the switch to administrators', async () => {
    expect((await api('teacher', 'GET', '/admin/session-activity')).status).toBe(403)
    expect((await api('teacher', 'GET', '/admin/session-activity/settings')).status).toBe(403)
    expect((await api('teacher', 'GET', '/admin/session-activity/export')).status).toBe(403)
    expect((await api('finance', 'PUT', '/admin/session-activity/settings', { enabled: true })).status).toBe(403)
    expect((await api('parent', 'PUT', '/admin/session-activity/settings', { enabled: true })).status).toBe(403)
    expect((await api(null, 'POST', '/session/activity/batch', { views: [] })).status).toBe(401)
    expect((await api('admin', 'GET', '/admin/session-activity/settings')).body.enabled).toBe(false)
  })
  it('refuses a silly retention period', async () => {
    expect((await api('admin', 'PUT', '/admin/session-activity/settings', { enabled: false, retention_days: 2 })).status).toBe(400)
  })
})

describe('when the school turns it on', () => {
  let cookie = ''
  let sid = ''
  beforeAll(async () => {
    const r = await api('admin', 'PUT', '/admin/session-activity/settings', { enabled: true, retention_days: 60 })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ enabled: true, recording: true, retention_days: 60 })
    cookie = (await signIn(USERS.teacher)).cookie!
  })

  it('records the sign-in with device and address', async () => {
    const row = await T().prepare(`SELECT * FROM session_activity WHERE user_id = ? ORDER BY signed_in_at DESC LIMIT 1`).bind(IDS.teacher)
      .first<Record<string, unknown>>()
    expect(row).toBeTruthy()
    sid = row!.session_id as string
    expect(row!.signed_out_at).toBeNull()
    expect(String(row!.ip)).toMatch(/^203\.0\.113\./)
    expect(row!.via).toBe('password')
  })

  it('records screens with time spent, and adds to active time', async () => {
    const at = new Date(Date.now() - 120_000).toISOString()
    const b = await beacon(cookie, [
      { screen: 'teaching.homework', path: '/class_teacher/teaching/homework?x=1', at, seconds: 45 },
      { screen: 'attendance.mark', path: '/class_teacher/attendance/mark', at: new Date(Date.now() - 60_000).toISOString(), seconds: 30 },
      { screen: '', seconds: 5 },
    ])
    expect(b.status).toBe(204)
    const views = await T().prepare(`SELECT screen, path, seconds FROM session_activity_views WHERE session_id = ? ORDER BY started_at`).bind(sid).all()
    expect(views.results).toEqual([
      { screen: 'teaching.homework', path: '/class_teacher/teaching/homework', seconds: 45 },
      { screen: 'attendance.mark', path: '/class_teacher/attendance/mark', seconds: 30 },
    ])
    const a = await T().prepare(`SELECT active_seconds, last_active_at, browser, os, device FROM session_activity WHERE session_id = ?`).bind(sid).first<Record<string, unknown>>()
    // The fixture signs in without a user agent.
    expect(a).toMatchObject({ active_seconds: 75, browser: 'Unknown', os: 'Unknown' })
    expect(parseAgent(UA)).toEqual({ device: 'Phone', browser: 'Safari', os: 'iOS' })
    expect(a!.last_active_at).toBeTruthy()
  })

  it('shows it to the administrator: list, filters, timeline and CSV', async () => {
    const list = await api('admin', 'GET', `/admin/session-activity?user=${IDS.teacher}`)
    expect(list.status).toBe(200)
    const it0 = list.body.items.find((x: { session_id: string }) => x.session_id === sid)
    expect(it0).toMatchObject({ full_name: 'Tara Teacher', live: true, screens: 2, active_seconds: 75 })
    expect((await api('admin', 'GET', `/admin/session-activity?q=Tara&status=ended`)).body.items.some((x: { session_id: string }) => x.session_id === sid)).toBe(false)
    expect((await api('admin', 'GET', `/admin/session-activity?from=2001-01-01&to=2001-01-02`)).body.items).toEqual([])
    expect((await api('admin', 'GET', `/admin/session-activity?from=yesterday`)).status).toBe(400)
    const d = await api('admin', 'GET', `/admin/session-activity/${sid}`)
    expect(d.status).toBe(200)
    expect(d.body.views.map((v: { screen: string }) => v.screen)).toEqual(['teaching.homework', 'attendance.mark'])
    expect(Array.isArray(d.body.changes)).toBe(true)
    const csv = await call(`/api/v1/admin/session-activity/export?user=${IDS.teacher}`, { cookie: (await signIn(USERS.admin)).cookie! })
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/)
    const text = await csv.text()
    expect(text.split('\r\n')[0]).toContain('"Signed in"')
    expect(text).toContain(sid)
    expect(text).toContain('Tara Teacher')
  })

  it("lets the person see their own sessions and that recording is on", async () => {
    const r = await call('/api/v1/profile/session-activity', { cookie })
    const body = await r.json() as { recording: boolean; items: { session_id: string; current: boolean }[] }
    expect(body.recording).toBe(true)
    expect(body.items.find((x) => x.session_id === sid)?.current).toBe(true)
  })

  it('records the end when the office signs the session out', async () => {
    expect((await api('teacher', 'DELETE', `/admin/sessions/${sid}`)).status).toBe(403)
    expect((await api('admin', 'DELETE', `/admin/sessions/${sid}`)).status).toBe(200)
    const a = await T().prepare(`SELECT signed_out_at, ended_reason FROM session_activity WHERE session_id = ?`).bind(sid).first<Record<string, unknown>>()
    expect(a!.signed_out_at).toBeTruthy()
    expect(a!.ended_reason).toBe('revoked')
    expect((await beacon(cookie, [{ screen: 'x.y', seconds: 1 }])).status).toBe(401)
  })

  it('records a sign-out by the person', async () => {
    const { cookie: c2 } = await signIn(USERS.finance)
    const row = await T().prepare(`SELECT session_id FROM session_activity WHERE user_id = ? AND signed_out_at IS NULL`).bind(IDS.finance).first<{ session_id: string }>()
    expect(row).toBeTruthy()
    await call('/logout', { cookie: c2! })
    const a = await T().prepare(`SELECT ended_reason FROM session_activity WHERE session_id = ?`).bind(row!.session_id).first<{ ended_reason: string }>()
    expect(a!.ended_reason).toBe('signed_out')
  })

  it('records nothing once the seller forbids it, and will not let the school turn it back on', async () => {
    await E.CONTROL.prepare(`INSERT INTO school_feature_overrides (institution_id, feature_id, enabled, note, updated_at) VALUES (?, 'staff.session_activity', 0, 'test', ?)`)
      .bind(IDS.school, new Date().toISOString()).run()
    const st = await api('admin', 'GET', '/admin/session-activity/settings')
    expect(st.body).toMatchObject({ enabled: true, seller_blocked: true, recording: false })
    const n = await count('session_activity')
    const { cookie: c3 } = await signIn(USERS.teacher)
    await beacon(c3!, [{ screen: 'teaching.homework', seconds: 10 }])
    expect(await count('session_activity')).toBe(n)
    expect((await api('admin', 'PUT', '/admin/session-activity/settings', { enabled: true })).status).toBe(403)
    expect((await api('admin', 'PUT', '/admin/session-activity/settings', { enabled: false })).status).toBe(200)
    await E.CONTROL.prepare(`DELETE FROM school_feature_overrides WHERE feature_id = 'staff.session_activity'`).run()
  })
})

describe('retention', () => {
  it('purges what is older than the retention period and keeps the rest', async () => {
    await api('admin', 'PUT', '/admin/session-activity/settings', { enabled: false, retention_days: 30 })
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString(), recent = new Date(Date.now() - 5 * 86_400_000).toISOString()
    const oldId = crypto.randomUUID(), newId = crypto.randomUUID()
    await T().batch([oldId, newId].flatMap((id, i) => [
      T().prepare(`INSERT INTO session_activity (session_id, institution_id, user_id, signed_in_at, last_active_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(id, IDS.school, IDS.teacher, i ? recent : old, i ? recent : old),
      T().prepare(`INSERT INTO session_activity_views (session_id, institution_id, user_id, screen, started_at, seconds) VALUES (?, ?, ?, 'a.b', ?, 5)`)
        .bind(id, IDS.school, IDS.teacher, i ? recent : old),
    ]))
    const r = await purgeSessionActivity(T())
    expect(r.sessions).toBeGreaterThanOrEqual(1)
    expect(r.views).toBeGreaterThanOrEqual(1)
    expect(await T().prepare(`SELECT 1 FROM session_activity WHERE session_id = ?`).bind(oldId).first()).toBeNull()
    expect(await T().prepare(`SELECT 1 FROM session_activity_views WHERE session_id = ?`).bind(oldId).first()).toBeNull()
    expect(await T().prepare(`SELECT 1 FROM session_activity WHERE session_id = ?`).bind(newId).first()).toBeTruthy()
    expect(await T().prepare(`SELECT 1 FROM session_activity_views WHERE session_id = ?`).bind(newId).first()).toBeTruthy()
  })
})
