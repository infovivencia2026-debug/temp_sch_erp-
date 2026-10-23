/* GET /me/sign-ins/today (routes/daily.ts): today's first sign-in (or first
   request on a session from an earlier day) and latest activity from the
   CONTROL sessions table, with the session-activity
   recording module left off; plus the staff code for the staff header. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, signIn, E, IDS, USERS } from './fixture'

beforeAll(seed)

describe('GET /me/sign-ins/today', () => {
  it('refuses a caller who is not signed in', async () => {
    expect((await api(null, 'GET', '/me/sign-ins/today')).status).toBe(401)
  })

  it('reports the earliest of today\'s sessions without session-activity recording', async () => {
    const rec = await E.TENANT_TEST.prepare(`SELECT enabled FROM module_settings WHERE module = 'session_activity'`).first<{ enabled: number }>()
    expect(rec?.enabled ?? 0).toBe(0)
    const { cookie } = await signIn(USERS.teacher)
    expect(cookie).toBeTruthy()
    const r = await api('teacher', 'GET', '/me/sign-ins/today')
    expect(r.status).toBe(200)
    expect(r.body.first_sign_in_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(r.body.last_activity_at).toMatch(/Z$/)
    expect(Date.parse(r.body.first_sign_in_at)).toBeLessThanOrEqual(Date.parse(r.body.last_activity_at))
    const earliest = await E.CONTROL.prepare(`SELECT min(created_at) AS t FROM sessions WHERE user_id = ? AND created_at >= ?`)
      .bind(IDS.teacher, new Date(Date.now() - 12 * 3600_000).toISOString()).first<{ t: string }>()
    expect(Math.abs(Date.parse(r.body.first_sign_in_at) - Date.parse(earliest!.t))).toBeLessThan(1000)
  })

  it('ignores yesterday\'s sessions', async () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString()
    await E.CONTROL.prepare(`UPDATE sessions SET created_at = ? WHERE user_id = ?`).bind(old, IDS.teacher).run()
    const r = await api('teacher', 'GET', '/me/sign-ins/today')
    expect(r.status).toBe(200)
    expect(r.body.first_sign_in_at).toBeNull()
    expect(Date.now() - Date.parse(r.body.last_activity_at)).toBeLessThan(60_000)
  })

  it('reports the first request today on a session signed in yesterday, in the school day', async () => {
    const tz = 'Asia/Kolkata'
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    // One minute before the school's midnight: yesterday locally, well inside the idle limit.
    const lateYesterday = new Date(Date.parse(`${today}T00:00:00+05:30`) - 60_000).toISOString()
    await E.CONTROL.prepare(`UPDATE sessions SET created_at = ?, last_seen_at = ?, day_first_seen_at = NULL WHERE user_id = ?`)
      .bind(new Date(Date.now() - 30 * 3600_000).toISOString(), lateYesterday, IDS.teacher).run()
    const before = Date.now()
    const r = await api('teacher', 'GET', '/me/sign-ins/today')
    expect(r.status).toBe(200)
    expect(r.body.timezone).toBe(tz)
    expect(r.body.first_sign_in_at).not.toBeNull()
    expect(Date.parse(r.body.first_sign_in_at)).toBeGreaterThanOrEqual(before - 1000)
    // Later requests keep the same first time.
    const again = await api('teacher', 'GET', '/me/sign-ins/today')
    expect(again.body.first_sign_in_at).toBe(r.body.first_sign_in_at)
  })
})
