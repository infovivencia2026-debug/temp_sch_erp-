import { describe, it, expect, beforeEach, vi } from 'vitest'
import { all, backoff, discard, enqueue, flush, retry, setOutboxUser, stateOf, takeOffline, wipeOutbox } from './outbox'
import { mayQueue } from './offline-policy'

function respond(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status })
}

beforeEach(() => {
  localStorage.clear()
  setOutboxUser('u1')
  vi.restoreAllMocks()
})

describe('outbox', () => {
  it('sends oldest first, one at a time, with each row\'s own key', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_p: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)['Idempotency-Key'])
      return respond(200)
    }))
    enqueue({ key: 'a', method: 'POST', path: '/api/v1/attendance', body: '{}' })
    enqueue({ key: 'b', method: 'POST', path: '/api/v1/chat/messages', body: '{}' })
    await flush({ force: true })
    expect(seen).toEqual(['a', 'b'])
    expect(all().map(stateOf)).toEqual(['sent', 'sent'])
  })

  it('queues the same press once', () => {
    enqueue({ key: 'k', method: 'POST', path: '/x' })
    enqueue({ key: 'k', method: 'POST', path: '/x' })
    expect(all()).toHaveLength(1)
  })

  it('stops the pass on no network and backs off, keeping the order', async () => {
    const f = vi.fn(async () => { throw new TypeError('offline') })
    vi.stubGlobal('fetch', f)
    enqueue({ key: 'a', method: 'POST', path: '/a' })
    enqueue({ key: 'b', method: 'POST', path: '/b' })
    await flush()
    expect(f).toHaveBeenCalledTimes(1)
    const [a] = all()
    expect(a.attempts).toBe(1)
    expect(a.next_at).toBeGreaterThan(Date.now())
    await flush() // inside the backoff: nothing goes
    expect(f).toHaveBeenCalledTimes(1)
    await flush({ force: true }) // back online: goes at once
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('backs off exponentially to a ceiling', () => {
    expect(backoff(1)).toBe(5000)
    expect(backoff(2)).toBe(10000)
    expect(backoff(30)).toBe(300000)
  })

  it('keeps a 5xx for later and marks a 409 as a conflict the server won', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(503)))
    enqueue({ key: 'a', method: 'POST', path: '/a' })
    await flush({ force: true })
    expect(stateOf(all()[0])).toBe('pending')
    vi.stubGlobal('fetch', vi.fn(async () => respond(409, { error: 'The register was changed by the office.' })))
    await flush({ force: true })
    expect(stateOf(all()[0])).toBe('conflict')
    expect(all()[0].last_error).toBe('The register was changed by the office.')
  })

  it('retries a refused row under a new key, and discards on request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(400, { error: 'bad' })))
    enqueue({ key: 'a', method: 'POST', path: '/a' })
    await flush({ force: true })
    const [r] = all()
    expect(stateOf(r)).toBe('failed')
    vi.stubGlobal('fetch', vi.fn(async () => respond(200)))
    retry(r.id)
    await flush({ force: true })
    expect(all()[0].key).not.toBe('a')
    expect(stateOf(all()[0])).toBe('sent')
    discard(all()[0].id)
    expect(all()).toHaveLength(0)
  })

  it('keeps each person\'s queue apart and wipes them all', () => {
    enqueue({ key: 'a', method: 'POST', path: '/a' })
    setOutboxUser('u2')
    expect(all()).toHaveLength(0)
    setOutboxUser('u1')
    expect(all()).toHaveLength(1)
    wipeOutbox()
    expect(all()).toHaveLength(0)
  })

  it('never queues money, logins, results or admissions', () => {
    expect(mayQueue('POST', '/api/v1/attendance')).toBe(true)
    expect(mayQueue('POST', '/api/v1/chat/messages')).toBe(true)
    expect(mayQueue('POST', '/api/v1/portal/lms/lessons/x/complete')).toBe(true)
    expect(mayQueue('POST', '/api/v1/fees/payments')).toBe(false)
    expect(mayQueue('POST', '/api/v1/admin/users/x/password')).toBe(false)
    expect(mayQueue('POST', '/api/v1/exams/x/publish')).toBe(false)
    expect(mayQueue('POST', '/api/v1/admissions/applications')).toBe(false)
    expect(mayQueue('GET', '/api/v1/attendance')).toBe(false)
    expect(takeOffline('POST', '/api/v1/fees/payments', '{}', 'k', undefined, mayQueue)).toBe(false)
    expect(takeOffline('POST', '/api/v1/attendance', new FormData(), 'k', undefined, mayQueue)).toBe(false)
  })
})
