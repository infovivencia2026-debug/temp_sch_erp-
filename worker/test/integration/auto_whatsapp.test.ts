/* The school's one switch for automatic WhatsApp (owner, 2026-10-22): on by
   default, turned off and on from Delivery rules, and only by staff who may
   change the school's settings. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api } from './fixture'

beforeAll(seed)

describe('automatic WhatsApp switch', () => {
  it('is on until somebody turns it off', async () => {
    expect((await api('admin', 'GET', '/admin/messaging/delivery-rules')).body.settings.auto_whatsapp).toBe(true)
  })

  it('turns off and on, and leaves the other settings as they were', async () => {
    const before = (await api('admin', 'GET', '/admin/messaging/delivery-rules')).body.settings
    const off = await api('admin', 'PUT', '/admin/messaging/delivery-rules', { settings: { auto_whatsapp: false } })
    expect(off.status).toBe(200)
    expect(off.body.settings).toEqual({ ...before, auto_whatsapp: false })
    expect((await api('admin', 'GET', '/admin/messaging/delivery-rules')).body.settings.auto_whatsapp).toBe(false)
    const on = await api('admin', 'PUT', '/admin/messaging/delivery-rules', { settings: { auto_whatsapp: true } })
    expect(on.body.settings.auto_whatsapp).toBe(true)
  })

  it('refuses anything but on or off, and a login that may not change settings', async () => {
    expect((await api('admin', 'PUT', '/admin/messaging/delivery-rules', { settings: { auto_whatsapp: 'no' } })).status).toBe(400)
    expect((await api('teacher', 'PUT', '/admin/messaging/delivery-rules', { settings: { auto_whatsapp: false } })).status).toBe(403)
    expect((await api('parent', 'PUT', '/admin/messaging/delivery-rules', { settings: { auto_whatsapp: false } })).status).toBe(403)
    expect((await api('admin', 'GET', '/admin/messaging/delivery-rules')).body.settings.auto_whatsapp).toBe(true)
  })
})
