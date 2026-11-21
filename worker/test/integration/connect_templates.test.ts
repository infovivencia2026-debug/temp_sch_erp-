/* A Yajur Connect tick sends the school's approved template, never free text
   (owner, 2026-11-20: a free-text fee reminder was refused by WhatsApp, 131047). */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'
import { whatsappSendFor } from '../../src/services/messaging'

beforeAll(seed)

describe('Yajur Connect templates', { timeout: 120_000 }, () => {
  it('refuses a Connect-only fee reminder when the school has no fee reminder template', async () => {
    await E.TENANT_TEST.prepare(`DELETE FROM message_templates WHERE code LIKE 'connect_%'`).run()
    const r = await api('finance', 'POST', '/fees/reminders/send', { student_ids: [IDS.child], channels: ['whatsapp'] })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toMatch(/Yajur Connect template/)
  })

  it('sends the plan’s fees.overdue as connect_fee_reminder with every blank filled', async () => {
    await E.TENANT_TEST.prepare(`INSERT INTO message_templates (id, institution_id, code, channel, body, wa_template_name, wa_language, wa_params, is_active)
        VALUES (?, ?, 'connect_fee_reminder', 'whatsapp', 'Dear {{parent_name}}', 'fee_reminder', 'en', ?, 1)`)
      .bind(crypto.randomUUID(), IDS.school, JSON.stringify(['parent_name', 'fee_name', 'amount', 'student_name', 'class', 'due_date'])).run()
    const wa = await whatsappSendFor(E.TENANT_TEST, 'fees.overdue', { student_name: 'Asha', due_on: '05 Nov 2026', amount_due: '₹1200.00', fee_name: 'school' })
    expect(wa?.name).toBe('fee_reminder')
    expect(wa?.params).toEqual(['Parent', 'school', '₹1200.00', 'Asha', '-', '05 Nov 2026'])
  })

  it('queues a ticked fee reminder on the Connect template, not messaging.direct', async () => {
    await E.TENANT_TEST.prepare(`DELETE FROM message_log WHERE source_kind = 'fee_reminder'`).run()
    const r = await api('finance', 'POST', '/fees/reminders/send', { student_ids: [IDS.child], channels: ['whatsapp'] })
    expect(r.status).toBe(200)
    const rows = (await E.TENANT_TEST.prepare(`SELECT template_code FROM message_log WHERE source_kind = 'fee_reminder' AND channel = 'whatsapp'`).all<{ template_code: string }>()).results
    for (const row of rows) expect(row.template_code).toBe('connect_fee_reminder')
  })
})
