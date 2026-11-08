/* Yajur Connect header pictures: upload refusals, the signed public link,
   and 404 for a tampered or expired one. Nothing is sent anywhere. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, as, call, E } from './fixture'
import { sign } from '../../src/routes/comms/wa_header_image'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

async function upload(who: 'admin' | 'teacher', bytes: Uint8Array, type: string, name: string) {
  const form = new FormData()
  form.append('file', new File([bytes], name, { type }))
  const res = await call('/api/v1/comms/yajur-connect/send/image', { method: 'POST', body: form, cookie: await as(who) })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body }
}

describe('communication.yajur_connect header picture', () => {
  beforeAll(async () => {
    await seed()
    ;(E as unknown as Record<string, string>).SESSION_SECRET ||= 'test-session-secret'
    for (const who of ['admin', 'teacher'] as const) await as(who)
  }, 120_000)

  it('refuses a caller without comms.connect.write (403)', async () => {
    expect((await upload('teacher', PNG, 'image/png', 'a.png')).status).toBe(403)
  })

  it('refuses a non-image and a file over 5 MB (400)', async () => {
    expect((await upload('admin', new TextEncoder().encode('%PDF-1.4 hello'), 'application/pdf', 'a.pdf')).status).toBe(400)
    expect((await upload('admin', new TextEncoder().encode('<svg></svg>'), 'image/png', 'a.png')).status).toBe(400)
    const big = new Uint8Array((5 << 20) + 1); big.set(PNG)
    expect((await upload('admin', big, 'image/png', 'big.png')).status).toBe(400)
  })

  it('serves the upload at its signed public link; a tampered or expired link is 404', async () => {
    const up = await upload('admin', PNG, 'image/png', 'notice.png')
    expect(up.status).toBe(201)
    const url = new URL(up.body.url as string)
    expect(url.protocol).toBe('https:')
    const res = await call(url.pathname)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)

    const m = url.pathname.match(/^(.*)\/(\d+)\/([0-9a-f]{40})\.png$/)!
    const flipped = m[3].slice(0, -1) + (m[3].endsWith('0') ? '1' : '0')
    expect((await call(`${m[1]}/${m[2]}/${flipped}.png`)).status).toBe(404)
    expect((await call(`${m[1]}/${Number(m[2]) + 1}/${m[3]}.png`)).status).toBe(404)
    const [inst, file] = m[1].split('/').slice(-2)
    const past = Math.floor(Date.now() / 1000) - 60
    const oldSig = await sign(String(E.SESSION_SECRET), inst, file, past)
    expect((await call(`${m[1]}/${past}/${oldSig}.png`)).status).toBe(404)
    expect((await call('/api/v1/public/wa-image/')).status).toBe(404)

    // The sent picture still passes the send screens' check.
    const { cleanImage } = await import('../../src/services/wa_send')
    expect(cleanImage(up.body.url)).toBe(up.body.url)
  })
})
