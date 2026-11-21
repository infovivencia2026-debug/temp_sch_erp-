/* Ticked channels (owner, 2026-11-20): In app by default and untickable,
   Yajur Connect and SMS only when ticked and set up. Counts follow the ticks;
   with nothing ticked nothing goes. Present & absent tells a family once a day. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, isoDay, E } from './fixture'
import { explicitCounts, pickChannels, wantsInApp } from '../../src/services/channel_pick'

beforeAll(seed)
const today = isoDay()

describe('channel ticks', { timeout: 120_000 }, () => {
  it('keeps only ticked channels that are live, and In app unless unticked', () => {
    expect(pickChannels(['in_app', 'whatsapp', 'sms'], { whatsapp: true, sms: false })).toEqual(['whatsapp'])
    expect(pickChannels(undefined, { whatsapp: true })).toEqual([])
    expect(wantsInApp(['whatsapp'])).toBe(false)
    expect(wantsInApp(['in_app'])).toBe(true)
    expect(wantsInApp(undefined)).toBe(true)
  })

  it('counts each person once per ticked channel and prices only the paid ones', () => {
    const people = [
      { uid: 'u1', phone: '9876543210', email: null },
      { uid: null, phone: '9876543211', email: null },
      { uid: null, phone: '9876543211', email: null },
    ]
    const app = explicitCounts(people, [], { whatsapp: 13, sms: 25 }, true)
    expect(app).toMatchObject({ recipients: 1, by_channel: { in_app: 1, whatsapp: 0, sms: 0 }, estimated_cost_paise: 0 })
    const wa = explicitCounts(people, ['whatsapp'], { whatsapp: 13, sms: 25 }, true)
    expect(wa).toMatchObject({ recipients: 2, by_channel: { in_app: 1, whatsapp: 2 }, estimated_cost_paise: 26 })
    expect(explicitCounts(people, [], { whatsapp: 13 }, false).recipients).toBe(0)
  })

  it('estimates by ticks for a circular', async () => {
    const r = await api('admin', 'POST', '/admin/messaging/estimate', { message_type: 'notice', audience_role: 'parents', channels: ['in_app'] })
    expect(r.status).toBe(200)
    expect(r.body.explicit).toBe(true)
    expect(r.body.by_channel.sms).toBe(0)
    const none = await api('admin', 'POST', '/admin/messaging/estimate', { message_type: 'notice', audience_role: 'parents', channels: [] })
    expect(none.body.by_channel.in_app).toBe(0)
  })

  it('publishes a circular with In app ticked only', async () => {
    const r = await api('admin', 'POST', '/communication/circulars', { title: 'Ticks test', body: 'In app only', audience_role: 'parents', channels: ['in_app'] })
    expect(r.status).toBe(201)
    expect(r.body.sms_queued).toBe(0)
    expect(r.body.whatsapp_queued).toBe(0)
  })

  it('refuses a fee reminder with every box unticked', async () => {
    const r = await api('finance', 'POST', '/fees/reminders/send', { student_ids: [IDS.child], channels: [] })
    expect(r.status).toBe(400)
  })
})

describe('present & absent: tell the parents', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await api('teacher', 'POST', '/attendance', {
      section_id: IDS.section, on_date: today, silent: true,
      entries: [{ student_id: IDS.child, status: 'present' }, { student_id: IDS.otherChild, status: 'absent' }],
    })
  })

  it('refuses nothing ticked, and a parent', async () => {
    expect((await api('admin', 'POST', '/attendance-workflow/parent-messages', { on_date: today, kind: 'absent', student_ids: [], channels: ['in_app'] })).status).toBe(400)
    expect((await api('admin', 'POST', '/attendance-workflow/parent-messages', { on_date: today, kind: 'absent', student_ids: [IDS.otherChild], channels: [] })).status).toBe(400)
    expect((await api('parent', 'POST', '/attendance-workflow/parent-messages', { on_date: today, kind: 'absent', student_ids: [IDS.otherChild], channels: ['in_app'] })).status).toBe(403)
  })

  it('tells an absent child\'s family once, and only for a child really absent', async () => {
    // A present child sent as "absent" is skipped.
    const wrong = await api('admin', 'POST', '/attendance-workflow/parent-messages', { on_date: today, kind: 'absent', student_ids: [IDS.child], channels: ['in_app'] })
    expect(wrong.status).toBe(202)
    expect(wrong.body.skipped).toBe(1)
    // Clear anything the register itself already sent, so this send is the first.
    await E.TENANT_TEST.prepare(`DELETE FROM message_log WHERE source_kind = 'absence_alert' OR idempotency_key LIKE 'dk:absence:%'`).run()
    const first = await api('admin', 'POST', '/attendance-workflow/parent-messages', { on_date: today, kind: 'absent', student_ids: [IDS.otherChild], channels: ['in_app'] })
    expect(first.status).toBe(202)
    expect(first.body.children).toBe(1)
    expect(first.body.channels).toEqual(['in_app'])
  })
})

describe('who hears: Privacy primary-only', { timeout: 120_000 }, () => {
  it('an absence estimate says which rule applies; a circular goes to every linked parent', async () => {
    for (const on of [1, 0]) {
      await E.TENANT_TEST.prepare(`UPDATE institutions SET alerts_primary_only = ?`).bind(on).run()
      const r = await api('admin', 'POST', '/admin/messaging/estimate', { message_type: 'absence', student_ids: [IDS.child], channels: ['in_app'] })
      expect(r.status).toBe(200)
      expect(r.body.goes_to).toBe(on ? 'primary' : 'all')
    }
    const c = await api('admin', 'POST', '/admin/messaging/estimate', { message_type: 'notice', audience_role: 'parents', channels: ['in_app'] })
    expect(c.body.goes_to).toBe('all')
  })
})
