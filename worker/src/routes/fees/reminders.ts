import type { Router } from '../../router'
import { badRequest, bool, isUUID, now, ok, readJSON } from '../../http'
import { notifyStmt, rupeesFixed, today } from './common'
import { Messenger, scopeOf, type SendRequest } from '../../services/messaging'

/* Port of fee_reminders.go (chase now), fee_reminder_schedule.go (the
   standing plan, one message_trigger_rules row per channel) and
   cheque_bounce_fine.go (one number in module_settings.config). */

const cleanChannels = (list: unknown): string[] => {
  const out: string[] = []
  for (const raw of Array.isArray(list) ? list : []) {
    const ch = String(raw).trim().toLowerCase()
    if ((ch === 'sms' || ch === 'whatsapp' || ch === 'email') && !out.includes(ch)) out.push(ch)
  }
  return out
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** to_char(date, 'DD Mon') */
const ddMon = (d: string): string => `${d.slice(8, 10)} ${MON[Number(d.slice(5, 7)) - 1]}`

const BOUNCE_KEY = 'cheque_bounce_fine_paise'

export function registerReminders(r: Router): void {
  // ---------------------------------------------------------------- chase today
  r.post('/fees/reminders/send', 'finance.fees.write', async (c) => {
    const req = await readJSON<{ student_ids?: string[]; channels?: string[] }>(c.req)
    const ids = req.student_ids ?? []
    if (ids.length === 0) throw badRequest('choose at least one family to remind')
    if (ids.length > 2000) throw badRequest('that is more families than one send should carry')
    const students: string[] = []
    for (const raw of ids) { const s = String(raw).trim(); if (!isUUID(s)) throw badRequest('every student_id must be a uuid'); students.push(s) }
    const channels = cleanChannels(req.channels)

    const owing = await c.db.prepare(`
      SELECT st.id, TRIM(st.first_name || COALESCE(' ' || st.last_name, '')) AS name, SUM(inv.net_paise - inv.paid_paise) AS due, MIN(inv.due_on) AS due_on
        FROM invoices inv JOIN students st ON st.id = inv.student_id
       WHERE inv.student_id IN (SELECT value FROM json_each(?)) AND inv.status NOT IN ('cancelled','draft','paid') AND inv.net_paise > inv.paid_paise
       GROUP BY st.id HAVING SUM(inv.net_paise - inv.paid_paise) > 0`).bind(JSON.stringify(students)).all<{ id: string; name: string; due: number; due_on: string | null }>()

    let told = 0, queued = 0, noAccount = 0
    const t = today()
    const stmts: D1PreparedStatement[] = []
    const sends: SendRequest[] = []
    for (const o of owing.results) {
      const amount = '₹' + rupeesFixed(Number(o.due))
      let body = `${o.name}: ${amount} is outstanding`
      if (o.due_on) body += ', due ' + ddMon(o.due_on)
      body += '. Please pay at the school office or through the app.'
      const people = await c.db.prepare(`
        SELECT g.user_id AS uid, g.phone, g.email FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
         WHERE sg.student_id = ?1
           AND NOT sg.portal_blocked AND (sg.access_until IS NULL OR sg.access_until >= ?2)
           AND (sg.is_primary
                OR NOT (SELECT i.alerts_primary_only FROM institutions i WHERE i.id = sg.institution_id)
                OR NOT EXISTS (SELECT 1 FROM student_guardians p WHERE p.student_id = sg.student_id AND p.is_primary AND NOT p.portal_blocked
                                  AND (p.access_until IS NULL OR p.access_until >= ?2)))
        UNION ALL
        SELECT u.id, u.phone, u.email FROM students st JOIN users u ON u.id = st.user_id WHERE st.id = ?1`).bind(o.id, t)
        .all<{ uid: string | null; phone: string | null; email: string | null }>()
      stmts.push(c.db.prepare(`UPDATE students SET last_fee_reminder_at = ? WHERE id = ?`).bind(now(), o.id))
      for (const pn of people.results) {
        if (!pn.uid) noAccount++
        else { stmts.push(notifyStmt(c, pn.uid, o.id, 'fee_due', amount + ' outstanding', body, '/go/fees_payments', 'student', o.id)); told++ }
        for (const ch of channels) {
          const to = ch === 'email' ? (pn.email ?? '').trim() : (pn.phone ?? '').trim()
          if (to === '') continue
          sends.push({ channel: ch, template_code: 'messaging.direct', vars: { text: body, subject: 'School fees outstanding' }, recipient: to })
        }
      }
    }
    if (stmts.length) await c.db.batch(stmts)
    // QueueMessage per contact; a gateway the school has not configured is skipped, as Go.
    if (sends.length) {
      const ms = new Messenger(scopeOf(c))
      for (const s of sends) { try { await ms.queue(s); queued++ } catch { /* continue */ } }
      await ms.kick()
    }
    return ok({ told, messages_queued: queued, channels, no_account: noAccount })
  })

  // ---------------------------------------------------------------- the standing plan
  r.get('/fees/reminders/schedule', 'auth', async (c) => {
    const out = { days_before: 7, channels: [] as string[], active: false, repeat_days: 7, max_attempts: 3 }
    const rows = await c.db.prepare(`SELECT condition, channel, repeat_days, max_attempts, is_active FROM message_trigger_rules WHERE institution_id = ? AND plan_kind = 'fee_reminder' ORDER BY created_at`)
      .bind(c.id.institution!.id).all<{ condition: string; channel: string; repeat_days: number; max_attempts: number; is_active: number }>()
    let first = true
    for (const row of rows.results) {
      if (first) {
        try { const v = JSON.parse(row.condition ?? '{}')?.min_days_overdue; if (typeof v === 'number') out.days_before = -Math.trunc(v) } catch { /* unreadable condition */ }
        out.repeat_days = Number(row.repeat_days); out.max_attempts = Number(row.max_attempts); out.active = bool(row.is_active)
        first = false
      }
      if (bool(row.is_active)) out.channels.push(row.channel)
    }
    return ok(out)
  })

  r.put('/fees/reminders/schedule', 'finance.fees.write', async (c) => {
    const req = await readJSON<{ days_before?: number; channels?: string[]; active?: boolean; repeat_days?: number; max_attempts?: number }>(c.req)
    const channels = cleanChannels(req.channels)
    const active = !!req.active
    if (active && channels.length === 0) throw badRequest('choose at least one of SMS, WhatsApp or email, or switch the automatic reminder off')
    const daysBefore = Math.trunc(Number(req.days_before ?? 0)) || 0
    if (daysBefore < -60 || daysBefore > 60) throw badRequest('keep it within 60 days either side of the due date')
    let maxAttempts = Math.trunc(Number(req.max_attempts ?? 0)) || 0; if (maxAttempts < 1) maxAttempts = 1
    let repeatDays = Math.trunc(Number(req.repeat_days ?? 0)) || 0; if (repeatDays < 0) repeatDays = 0
    const cond = JSON.stringify({ min_days_overdue: -daysBefore })
    const inst = c.id.institution!.id
    const stmts: D1PreparedStatement[] = [c.db.prepare(`UPDATE message_trigger_rules SET is_active = 0 WHERE institution_id = ? AND plan_kind = 'fee_reminder'`).bind(inst)]
    for (const ch of channels) {
      const existing = await c.db.prepare(`SELECT id FROM message_trigger_rules WHERE institution_id = ? AND plan_kind = 'fee_reminder' AND channel = ? ORDER BY created_at LIMIT 1`)
        .bind(inst, ch).first<{ id: string }>()
      if (!existing) {
        stmts.push(c.db.prepare(`INSERT INTO message_trigger_rules (id, institution_id, name, event, condition, audience, channel, template_code, plan_kind, repeat_days, max_attempts, is_active, created_at, updated_at)
                                 VALUES (?, ?, ?, 'invoice.overdue', ?, 'family', ?, 'fees.overdue', 'fee_reminder', ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), inst, 'Fee reminder · ' + ch, cond, ch, repeatDays, maxAttempts, active ? 1 : 0, now(), now()))
      } else {
        stmts.push(c.db.prepare(`UPDATE message_trigger_rules SET condition = ?2, repeat_days = ?3, max_attempts = ?4, is_active = ?5, audience = 'family', updated_at = ?6 WHERE id = ?1`)
          .bind(existing.id, cond, repeatDays, maxAttempts, active ? 1 : 0, now()))
      }
    }
    await c.db.batch(stmts)
    return ok({ saved: true })
  })

  // ---------------------------------------------------------------- cheque bounce fine
  r.get('/fees/cheque-bounce-fine', 'auth', async (c) => {
    const row = await c.db.prepare(`SELECT json_extract(config, '$.${BOUNCE_KEY}') AS v FROM module_settings WHERE module = 'finance'`).first<{ v: unknown }>()
    const n = row?.v === null || row?.v === undefined ? 0 : Math.trunc(Number(row.v)) || 0
    return ok({ amount: n / 100, set: n > 0 })
  })

  r.put('/fees/cheque-bounce-fine', 'finance.fees.write', async (c) => {
    const req = await readJSON<{ amount?: number }>(c.req)
    const amount = Number(req.amount ?? 0)
    if (!(amount >= 0)) throw badRequest('a fine cannot be less than nothing')
    if (amount > 100000) throw badRequest('that is over ₹1,00,000 for one bounced cheque, if it is right, charge it as a penalty on the bill so the reason is on the record')
    const paiseAmt = Math.trunc(amount * 100 + 0.5)
    // Merged, not replaced: finance's settings are not only ours.
    await c.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?1, 'finance', 1, json_object('${BOUNCE_KEY}', ?2))
                        ON CONFLICT (institution_id, module) DO UPDATE SET config = json_set(module_settings.config, '$.${BOUNCE_KEY}', ?2)`)
      .bind(c.id.institution!.id, String(paiseAmt)).run()
    return ok({ amount, set: paiseAmt > 0 })
  })
}
