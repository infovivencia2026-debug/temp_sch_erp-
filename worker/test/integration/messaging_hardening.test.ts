/* Messaging hardening (docs/audit-2026-09-23.md Tier 3): stable dedupe keys,
   no replay of a send whose outcome is unknown, per-contact opt-out with STOP,
   quiet hours on direct sends, AUTHENTICATION for secrets, SMS segments. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, IDS, E } from './fixture'
import { smsSegments, isStopKeyword, isStartKeyword, isMarketingSend, optOutReason, recordOptOut, survivesOptOut } from '../../src/services/delivery'
import { messageSendRequest, quietHoursApply, ambiguousSendError, settleStaleSends, dispatchMessages, PermanentSendError } from '../../src/services/messaging'
import { waCategoryOf } from '../../src/routes/admin/whatsapp'
import { applyStopReply } from '../../src/routes/comms/message_webhooks'

beforeAll(seed)
const db = () => E.TENANT_TEST

async function insertRow(id: string, over: Record<string, unknown> = {}): Promise<void> {
  const row: Record<string, unknown> = {
    id, institution_id: IDS.school, channel: 'sms', template_code: 'messaging.direct', recipient: '+91 98765 43210',
    body: 'hello', status: 'queued', queued_at: new Date().toISOString(), attempts: 0, ...over,
  }
  const cols = Object.keys(row)
  await db().prepare(`INSERT INTO message_log (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map((k) => row[k])).run()
}
const statusOf = async (id: string) => (await db().prepare(`SELECT status, error FROM message_log WHERE id = ?`).bind(id).first<{ status: string; error: string | null }>())!

describe('dedupe keys', () => {
  it('a message:send with a dedupe key has the same idempotency key whatever the job', () => {
    const p = { channel: 'sms', template_key: 'attendance.absent', to_user_id: IDS.parent, dedupe_key: 'absence:2026-09-29:' + IDS.child }
    const a = messageSendRequest(p, 'job-1'), b = messageSendRequest(p, 'job-2')
    expect(a.idempotency_key).toBe(b.idempotency_key)
    expect(a.occurrence_key).toBe(b.occurrence_key)
    expect(a.source_id).toBeNull()
    // Without one, only a retry of the same job is a duplicate (as before).
    const c = messageSendRequest({ ...p, dedupe_key: undefined }, 'job-1'), d = messageSendRequest({ ...p, dedupe_key: undefined }, 'job-2')
    expect(c.idempotency_key).not.toBe(d.idempotency_key)
  })
})

describe('no replay after an unknown outcome', () => {
  it('classifies timeouts as ambiguous and refusals as not', () => {
    const t = new Error('The operation was aborted due to timeout'); t.name = 'TimeoutError'
    expect(ambiguousSendError(t)).toBe(true)
    expect(ambiguousSendError(new PermanentSendError('bad number'))).toBe(false)
    expect(ambiguousSendError(new Error('gateway 500: busy'))).toBe(false)
  })

  it('fails a row stuck in sending past its lease instead of re-queueing it', async () => {
    const id = '00000000-0000-4000-8000-00000000a001'
    await insertRow(id, { status: 'sending', send_after: new Date(Date.now() - 10 * 60_000).toISOString() })
    expect(await settleStaleSends(db(), IDS.school)).toBeGreaterThanOrEqual(1)
    const r = await statusOf(id)
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/outcome unknown/)
  })

  it('leaves a fresh sending row alone', async () => {
    const id = '00000000-0000-4000-8000-00000000a002'
    await insertRow(id, { status: 'sending', send_after: new Date(Date.now() + 60_000).toISOString() })
    await settleStaleSends(db(), IDS.school)
    expect((await statusOf(id)).status).toBe('sending')
  })
})

describe('opt-out per contact', () => {
  it('knows STOP and START', () => {
    for (const w of ['STOP', ' stop ', 'Unsubscribe', 'opt out', 'STOP.']) expect(isStopKeyword(w)).toBe(true)
    for (const w of ['please stop the bus at gate 2', 'stopped', '']) expect(isStopKeyword(w)).toBe(false)
    expect(isStartKeyword('START')).toBe(true)
  })

  it('a marketing opt-out stops campaigns but not school business; all stops both but not codes', async () => {
    const who = 'phone:919812345678'
    await recordOptOut(db(), IDS.school, who, 'marketing', 'office')
    expect(isMarketingSend('campaign_step', 'admissions.nurture')).toBe(true)
    expect(await optOutReason(db(), who, true, false)).toMatch(/marketing/)
    expect(await optOutReason(db(), who, false, false)).toBe('')
    await recordOptOut(db(), IDS.school, who, 'all', 'stop_reply')
    expect(await optOutReason(db(), who, false, false)).toMatch(/replied STOP/)
    expect(survivesOptOut('login_code', null)).toBe(true)
    expect(await optOutReason(db(), who, false, true)).toBe('')
  })

  it('a STOP reply over SMS opts the number out and dispatch suppresses the next send', async () => {
    const school = await E.CONTROL.prepare(`SELECT * FROM institutions WHERE id = ?`).bind(IDS.school).first<any>()
    expect(await applyStopReply(E, '+91 99887 76655', 'sms', true, school)).toBe(1)
    const id = '00000000-0000-4000-8000-00000000a003'
    await insertRow(id, { recipient: '9988776655' })
    await dispatchMessages(E, db(), IDS.school, 20)
    const r = await statusOf(id)
    expect(r.status).toBe('suppressed')
    expect(r.error).toMatch(/opted out/)
    // START undoes it.
    await applyStopReply(E, '9988776655', 'sms', false, school)
    expect(await optOutReason(db(), 'phone:919988776655', false, false)).toBe('')
  })
})

describe('quiet hours on direct sends', () => {
  it('holds typed SMS and WhatsApp, not codes, urgent sources, email or a forced resend', () => {
    expect(quietHoursApply({ channel: 'sms', template_code: 'messaging.direct' })).toBe(true)
    expect(quietHoursApply({ channel: 'whatsapp', template_code: 'fees.overdue' })).toBe(true)
    expect(quietHoursApply({ channel: 'sms', template_code: 'messaging.direct', source_kind: 'absence_alert' })).toBe(false)
    expect(quietHoursApply({ channel: 'sms', template_code: 'login_code' })).toBe(false)
    expect(quietHoursApply({ channel: 'sms', template_code: 'password_reset' })).toBe(false)
    expect(quietHoursApply({ channel: 'email', template_code: 'messaging.direct' })).toBe(false)
    expect(quietHoursApply({ channel: 'sms', template_code: 'messaging.direct', force: true })).toBe(false)
  })
})

describe('WhatsApp template category', () => {
  it('submits a template that carries a password as AUTHENTICATION', () => {
    expect(waCategoryOf('admissions.portal_login', ['school_name', 'sign_in_as', 'password'])).toBe('AUTHENTICATION')
    expect(waCategoryOf('attendance.absent', ['student_name'])).toBe('UTILITY')
  })
})

describe('SMS segments', () => {
  it('counts GSM-7 and UCS-2 parts', () => {
    expect(smsSegments('a'.repeat(160))).toMatchObject({ segments: 1, encoding: 'gsm7' })
    expect(smsSegments('a'.repeat(161)).segments).toBe(2)
    expect(smsSegments('a'.repeat(306)).segments).toBe(2)
    expect(smsSegments('a'.repeat(307)).segments).toBe(3)
    expect(smsSegments('€'.repeat(80)).segments).toBe(1) // extension chars are two septets
    expect(smsSegments('€'.repeat(81)).segments).toBe(2)
    expect(smsSegments('₹ 4,500 due')).toMatchObject({ segments: 1, encoding: 'ucs2' })
    expect(smsSegments('अ'.repeat(71)).segments).toBe(2)
    expect(smsSegments('अ'.repeat(134)).segments).toBe(2)
    expect(smsSegments('अ'.repeat(135)).segments).toBe(3)
  })
})
