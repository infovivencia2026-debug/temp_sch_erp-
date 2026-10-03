/* The apps' outbox replays a write that may already have reached the server.
   An Idempotency-Key makes the replay answer with the first result instead of
   doing the work twice; a session ended from elsewhere tells the device to
   delete what it saved for offline use. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, call, as, signIn, USERS, IDS, isoDay, E } from './fixture'

beforeAll(seed)

async function post(who: 'teacher' | 'admin', path: string, body: unknown, key?: string) {
  const res = await call('/api/v1' + path, {
    method: 'POST', cookie: await as(who),
    headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed, replay: res.headers.get('Idempotent-Replay') }
}

const day = isoDay(-1)
const register = (status: string) => ({
  section_id: IDS.section, on_date: day, silent: true,
  entries: [{ student_id: IDS.child, status }],
})

describe('idempotent replay of queued writes', () => {
  it('runs a keyed write once and answers the repeat from the stored result', async () => {
    const key = crypto.randomUUID()
    const first = await post('teacher', '/attendance', register('absent'), key)
    expect(first.status).toBe(200)
    expect(first.body.written).toBe(1)
    expect(first.replay).toBeNull()

    const again = await post('teacher', '/attendance', register('absent'), key)
    expect(again.status).toBe(200)
    expect(again.replay).toBe('true')
    expect(again.body).toEqual(first.body)

    const n = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM idempotency_keys WHERE key = ?`).bind(key).first<{ n: number }>()
    expect(n?.n).toBe(1)
  })

  it('refuses the same key with a different body, so a changed write is not mistaken for the old one', async () => {
    const key = crypto.randomUUID()
    expect((await post('teacher', '/attendance', register('present'), key)).status).toBe(200)
    const changed = await post('teacher', '/attendance', register('late'), key)
    expect(changed.status).toBe(409)
    expect(changed.body.code).toBe('idempotency_key_conflict')
    const row = await E.TENANT_TEST.prepare(`SELECT status FROM student_attendance WHERE student_id = ? AND on_date = ?`)
      .bind(IDS.child, day).first<{ status: string }>()
    expect(row?.status).toBe('present')
  })

  it('does not let another person replay somebody else\'s key', async () => {
    const key = crypto.randomUUID()
    expect((await post('teacher', '/attendance', register('present'), key)).status).toBe(200)
    const other = await post('admin', '/attendance', register('present'), key)
    expect(other.status).toBe(409)
    expect(other.body.code).toBe('idempotency_key_reused')
  })

  it('stores the refusal too: a replayed 4xx is the same 4xx, not a second attempt', async () => {
    const key = crypto.randomUUID()
    const bad = { section_id: IDS.section, entries: [{ student_id: IDS.child, status: 'asleep' }] }
    const first = await post('teacher', '/attendance', bad, key)
    expect(first.status).toBe(400)
    const again = await post('teacher', '/attendance', bad, key)
    expect(again.status).toBe(400)
    expect(again.replay).toBe('true')
  })

  it('leaves keyless writes alone', async () => {
    const before = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM idempotency_keys`).first<{ n: number }>()
    expect((await post('teacher', '/attendance', register('present'))).status).toBe(200)
    const after = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM idempotency_keys`).first<{ n: number }>()
    expect(after?.n).toBe(before?.n)
  })
})

describe('remote wipe', () => {
  it('tells a device whose session was ended elsewhere to delete its saved data', async () => {
    const { cookie } = await signIn(USERS.otherParent)
    expect(cookie).toBeTruthy()
    await E.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'all_signed_out' WHERE user_id = ? AND revoked_at IS NULL`)
      .bind(new Date().toISOString(), IDS.otherParent).run()
    const res = await call('/api/v1/session', { cookie: cookie! })
    const body = await res.json() as { authenticated: boolean; wipe?: boolean }
    expect(body).toMatchObject({ authenticated: false, wipe: true })
  })

  it('keeps the offline copy after an idle expiry', async () => {
    const { cookie } = await signIn(USERS.otherParent)
    await E.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'idle' WHERE user_id = ? AND revoked_at IS NULL`)
      .bind(new Date().toISOString(), IDS.otherParent).run()
    const body = await (await call('/api/v1/session', { cookie: cookie! })).json() as { wipe?: boolean }
    expect(body.wipe).toBeUndefined()
  })

  it('says nothing to a visitor with no cookie', async () => {
    const body = await (await call('/api/v1/session')).json() as { authenticated: boolean; wipe?: boolean }
    expect(body).toEqual({ authenticated: false, permissions: [] })
  })
})
