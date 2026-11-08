/* WA_FORWARD_URL: every WhatsApp webhook POST is passed on to Yajur Connect
   unchanged (same bytes, same signature), in the background, and Meta still
   gets its answer when the forward fails. No request leaves the test. */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { seed, E } from './fixture'
import { whatsappWebhook } from '../../src/routes/comms/message_webhooks'

const SECRET = 'fwd-test-secret'
const FWD = 'https://connect.test/webhooks/whatsapp'
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

async function post(env: Record<string, unknown>, sigOverride?: string) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.none', status: 'read', timestamp: '1700000000' }] } }] }] })
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = sigOverride ?? 'sha256=' + [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const url = new URL('https://erp.test/api/v1/public/webhooks/whatsapp')
  const waits: Promise<unknown>[] = []
  const res = await whatsappWebhook({ ...E, WHATSAPP_APP_SECRET: SECRET, ...env } as typeof E, new Request(url, {
    method: 'POST', body, headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' },
  }), url, { waitUntil: (p) => { waits.push(p) } })
  await Promise.all(waits)
  return { res, body, sig }
}

function stub(impl: (u: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('graph.facebook.com')) throw new Error('test must not reach WhatsApp')
    if (u !== FWD) return realFetch(input, init)
    calls.push({ url: u, init })
    return impl(u, init)
  }) as typeof fetch
  return calls
}

describe('WhatsApp webhook forward', () => {
  beforeAll(seed)

  it('forwards the identical body and signature', async () => {
    const calls = stub(async () => new Response('ok'))
    const { res, body, sig } = await post({ WA_FORWARD_URL: FWD })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    const h = new Headers(calls[0].init?.headers)
    expect(h.get('x-hub-signature-256')).toBe(sig)
    expect(h.get('content-type')).toBe('application/json')
    expect(new TextDecoder().decode(calls[0].init?.body as ArrayBuffer)).toBe(body)
  })

  it('forwards even when the ERP refuses the signature', async () => {
    const calls = stub(async () => new Response('ok'))
    const { res } = await post({ WA_FORWARD_URL: FWD }, 'sha256=deadbeef')
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(1)
  })

  it('does not forward when WA_FORWARD_URL is empty', async () => {
    const calls = stub(async () => new Response('ok'))
    expect((await post({ WA_FORWARD_URL: '' })).res.status).toBe(200)
    expect(calls).toHaveLength(0)
  })

  it('still answers Meta 200 when the forward fails, after one retry', async () => {
    const calls = stub(async () => { throw new Error('down') })
    expect((await post({ WA_FORWARD_URL: FWD })).res.status).toBe(200)
    expect(calls).toHaveLength(2)
  })
})
