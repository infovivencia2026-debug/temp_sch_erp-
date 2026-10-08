/* Found by crawling every screen of every login on 2026-10-08. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api } from './fixture'

beforeAll(seed)

describe('what the crawl found', () => {
  it('the day code is simply off for somebody who is not a teacher', async () => {
    const r = await api('finance', 'GET', '/me/day-code')
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(false)
    expect((await api('parent', 'GET', '/me/day-code')).status).toBe(200)
  })

  it('the fee office reads the reminder plans; a parent does not', async () => {
    expect((await api('finance', 'GET', '/admin/messaging/plans')).status).toBe(200)
    expect((await api('parent', 'GET', '/admin/messaging/plans')).status).toBe(403)
    expect((await api('finance', 'POST', '/admin/messaging/plans', { name: 'x' })).status).toBe(403)
  })
})
