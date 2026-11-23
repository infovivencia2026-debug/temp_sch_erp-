/* Yajur Connect Insights: how WhatsApp messages did over the last 7, 30 or
   90 days. Delivery counts from message_log, replies and reply time from
   wa_messages, read rate by class, and when parents write in. Read only. */
import type { Router } from '../../router'
import { ok, badRequest } from '../../http'
import { recipientStatus } from '../../services/wa_send'

/* The original app's periods (owner, 2026-11-23, "insights like Connect"):
   last 7 or 30 days, 90 days, this year (since 1 January), and everything kept. */
const DAYS = [7, 30, 90] as const
type Period = 7 | 30 | 90 | 'year' | 'all'
/* Meta bills per 24-hour conversation; a school's utility message is about this much (₹, paise). */
const UTILITY_PAISE_PER_CONVERSATION = 35

export function registerYajurConnectInsights(r: Router, perm: string): void {
  r.get('/comms/yajur-connect/insights', perm, async (c) => {
    const raw = c.url.searchParams.get('days') || '30'
    const days: Period | undefined = raw === 'year' || raw === 'all' ? raw : DAYS.find((d) => String(d) === raw)
    if (!days) throw badRequest('days must be 7, 30, 90, year or all')
    // An offset from now that SQLite's datetime() takes: the year runs from 1 January, all goes back as far as it can.
    const since = days === 'all' ? '-100 years' : days === 'year' ? `-${Math.max(1, Math.ceil((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 86400000))} days` : `-${days} days`

    const [statuses, replies, replyTime, byClass, slots, topTemplates, failures, conversations] = await Promise.all([
      c.db.prepare(`SELECT status, count(*) AS n FROM message_log
          WHERE channel = 'whatsapp' AND queued_at >= datetime('now', ?) GROUP BY status`).bind(since)
        .all<{ status: string; n: number }>(),
      c.db.prepare(`SELECT count(*) AS n FROM wa_messages WHERE direction = 'in' AND at >= datetime('now', ?)`).bind(since)
        .first<{ n: number }>(),
      // Minutes from each inbound message to the next outbound in the same chat, capped at a day.
      c.db.prepare(`SELECT avg(d) AS m FROM (
            SELECT (julianday((SELECT min(o.at) FROM wa_messages o
                WHERE o.conversation_id = i.conversation_id AND o.direction = 'out' AND o.at > i.at)) - julianday(i.at)) * 1440 AS d
            FROM wa_messages i WHERE i.direction = 'in' AND i.at >= datetime('now', ?))
          WHERE d IS NOT NULL AND d <= 1440`).bind(since).first<{ m: number | null }>(),
      c.db.prepare(`SELECT coalesce(cl.name, 'No class') AS name, count(*) AS sent, coalesce(sum(m.status = 'read'), 0) AS read
          FROM message_log m
          LEFT JOIN enrollments en ON en.id = (SELECT e2.id FROM enrollments e2 WHERE e2.student_id = m.student_id AND e2.status = 'active' ORDER BY e2.enrolled_on DESC LIMIT 1)
          LEFT JOIN classes cl ON cl.id = en.class_id
          WHERE m.channel = 'whatsapp' AND m.queued_at >= datetime('now', ?) AND m.status IN ('sent', 'delivered', 'read')
          GROUP BY cl.id ORDER BY cl.level IS NULL, cl.level, cl.name`).bind(since)
        .all<{ name: string; sent: number; read: number }>(),
      // Inbound messages by half hour of the day (UTC); the screen re-buckets to the viewer's clock.
      c.db.prepare(`SELECT cast(strftime('%H', at) AS integer) * 2 + (cast(strftime('%M', at) AS integer) >= 30) AS slot, count(*) AS n
          FROM wa_messages WHERE direction = 'in' AND at >= datetime('now', ?) GROUP BY slot`).bind(since)
        .all<{ slot: number; n: number }>(),
      // Which templates the school used most, and how many of each were read.
      c.db.prepare(`SELECT coalesce(nullif(m.template_code, ''), 'Other') AS code, count(*) AS sent, coalesce(sum(m.status = 'read'), 0) AS read
          FROM message_log m WHERE m.channel = 'whatsapp' AND m.queued_at >= datetime('now', ?) AND m.status IN ('sent', 'delivered', 'read')
          GROUP BY code ORDER BY sent DESC LIMIT 6`).bind(since)
        .all<{ code: string; sent: number; read: number }>(),
      // Why messages failed, by the reason WhatsApp or the queue gave.
      c.db.prepare(`SELECT coalesce(nullif(substr(m.error, 1, 140), ''), 'No reason recorded') AS reason, count(*) AS n
          FROM message_log m WHERE m.channel = 'whatsapp' AND m.queued_at >= datetime('now', ?) AND m.status IN ('failed', 'suppressed', 'blocked')
          GROUP BY reason ORDER BY n DESC LIMIT 6`).bind(since)
        .all<{ reason: string; n: number }>(),
      // Conversations Meta bills for: one per number per 24 hours with something sent.
      c.db.prepare(`SELECT count(*) AS n FROM (SELECT m.recipient, date(m.queued_at) AS d FROM message_log m
          WHERE m.channel = 'whatsapp' AND m.queued_at >= datetime('now', ?) AND m.status IN ('sent', 'delivered', 'read') GROUP BY m.recipient, d)`).bind(since)
        .first<{ n: number }>(),
    ])

    const by = { sent: 0, delivered: 0, read: 0, failed: 0, blocked: 0, queued: 0 }
    for (const x of statuses.results) by[recipientStatus(x.status)] += Number(x.n)
    // One status per message: a read message was also sent and delivered.
    const sent = by.sent + by.delivered + by.read, delivered = by.delivered + by.read, read = by.read
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

    const inbound_slots = new Array<number>(48).fill(0)
    for (const s of slots.results) { const i = Number(s.slot); if (i >= 0 && i < 48) inbound_slots[i] = Number(s.n) }

    return ok({
      days,
      sent, delivered, read, failed: by.failed, blocked: by.blocked, pending: by.queued,
      delivered_pct: pct(delivered, sent), read_pct: pct(read, sent),
      replies: Number(replies?.n ?? 0),
      reply_minutes: replyTime?.m == null ? null : Math.round(Number(replyTime.m)),
      by_class: byClass.results.map((x) => ({ name: x.name, sent: Number(x.sent), read: Number(x.read), read_pct: pct(Number(x.read), Number(x.sent)) })),
      inbound_slots,
      top_templates: topTemplates.results.map((x) => ({ code: x.code, name: x.code.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase()), sent: Number(x.sent), read: Number(x.read), read_pct: pct(Number(x.read), Number(x.sent)) })),
      failures: failures.results.map((x) => ({ reason: x.reason, n: Number(x.n) })),
      conversations: Number(conversations?.n ?? 0),
      estimated_cost_paise: Number(conversations?.n ?? 0) * UTILITY_PAISE_PER_CONVERSATION,
    })
  })
}
