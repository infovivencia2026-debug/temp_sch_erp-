/* Staff chat, and the LiveHub Durable Object fanning the hint to the
   recipient's open Server-Sent Events stream. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, as, IDS } from './fixture'

beforeAll(seed)

/** Reads SSE frames until one with `event: <name>` arrives, or times out. */
async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>, name: string, ms = 5000): Promise<{ event: string; data: any }> {
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((res) => setTimeout(() => res(null), deadline - Date.now()))])
    if (!r || r.done) break
    buf += dec.decode(r.value, { stream: true })
    for (const frame of buf.split('\n\n')) {
      const ev = frame.match(/^event: (.+)$/m)?.[1]
      const data = frame.match(/^data: (.+)$/m)?.[1]
      if (ev === name && data) return { event: ev, data: JSON.parse(data) }
    }
  }
  throw new Error(`no "${name}" event within ${ms} ms; got: ${buf}`)
}

describe('staff chat and live updates', () => {
  it('delivers a message and pushes a live "message" event to the recipient', async () => {
    const stream = await call('/api/v1/live/stream', { cookie: await as('teacher') })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/)
    const reader = stream.body!.getReader()
    try {
      const sent = await api('admin', 'POST', '/staff-messages', { to: IDS.teacher, body: 'Staff meeting at 3' })
      expect(sent.status).toBe(201)
      const ev = await nextEvent(reader, 'message')
      expect(ev.data).toMatchObject({ type: 'message', scope: 'staff', from: IDS.admin })
      expect(ev.data.keys).toMatchObject({ peer: IDS.admin, to: IDS.teacher })
    } finally {
      await reader.cancel().catch(() => {})
    }
  })

  it('shows the thread to both colleagues', async () => {
    const mine = await api('teacher', 'GET', `/staff-messages?with=${IDS.admin}`)
    expect(mine.status).toBe(200)
    expect(mine.body.items).toEqual([expect.objectContaining({ body: 'Staff meeting at 3', mine: false, sender_name: 'Asha Admin' })])
    const threads = await api('teacher', 'GET', '/staff-messages/threads')
    expect(threads.body.items.find((t: any) => t.user_id === IDS.admin)).toMatchObject({ unread: 1 })
    const theirs = await api('admin', 'GET', `/staff-messages?with=${IDS.teacher}`)
    expect(theirs.body.items[0].mine).toBe(true)
  })

  it('will not let a parent be messaged as staff', async () => {
    const { status } = await api('admin', 'POST', '/staff-messages', { to: IDS.parent, body: 'hello' })
    expect(status).toBe(400)
  })

  it('401s the live stream without a session', async () => {
    expect((await call('/api/v1/live/stream')).status).toBe(401)
  })
})
