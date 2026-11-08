/* Yajur Connect Log (comms.connect.read): every WhatsApp message in
   message_log, newest first, with the parent's or staff member's name where
   the number matches one. Filters: status, a date range (queued day, UTC) and
   a search over the number, the template and the name. 50 a page. */
import type { Router } from '../../router'
import { badRequest } from '../../http'
import { normalisePhone } from '../admin/msg_guard'
import { recipientStatus } from '../../services/wa_send'
import { isoZ } from './common'
import type { ConnectLogItem, ConnectRecipientStatus } from '@shared/api/feature_yajur_connect'

const PAGE = 50
const DAY = /^\d{4}-\d{2}-\d{2}$/
const STATUS_SQL: Record<ConnectRecipientStatus, string> = {
  queued: `m.status NOT IN ('sent','delivered','read','failed','suppressed')`,
  sent: `m.status = 'sent'`, delivered: `m.status = 'delivered'`, read: `m.status = 'read'`, failed: `m.status = 'failed'`, blocked: `m.status = 'suppressed'`,
}
const last10 = (p: string) => normalisePhone(p).slice(-10)

export function registerYajurConnectLog(r: Router, perm: string): void {
  r.typed('GET /comms/yajur-connect/log', perm, async (c) => {
    const q = c.url.searchParams
    const where = [`m.channel = 'whatsapp'`], args: unknown[] = []
    const status = q.get('status') || ''
    if (status) {
      if (!(status in STATUS_SQL)) throw badRequest('unknown status')
      where.push(STATUS_SQL[status as ConnectRecipientStatus])
    }
    const from = q.get('from') || '', to = q.get('to') || ''
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) throw badRequest('dates must be YYYY-MM-DD')
    if (from) { where.push(`substr(m.queued_at, 1, 10) >= ?`); args.push(from) }
    if (to) { where.push(`substr(m.queued_at, 1, 10) <= ?`); args.push(to) }

    // Every known number with its name: guardians first, then staff.
    const people = await c.db.prepare(`SELECT full_name AS name, phone FROM guardians WHERE trim(coalesce(phone, '')) <> ''
        UNION ALL SELECT trim(first_name || ' ' || coalesce(last_name, '')), phone FROM employees WHERE trim(coalesce(phone, '')) <> ''`)
      .all<{ name: string; phone: string }>()
    const names = new Map<string, string>()
    for (const p of people.results) { const k = last10(p.phone); if (k && !names.has(k)) names.set(k, p.name) }

    const term = (q.get('q') ?? '').trim().slice(0, 60)
    if (term) {
      const lower = term.toLowerCase(), digits = term.replace(/\D/g, '')
      const hits = [...names].filter(([, n]) => n.toLowerCase().includes(lower)).map(([k]) => k).slice(0, 50)
      const ors = [`m.template_code LIKE ?`]
      args.push(`%${term.replace(/[%_]/g, '')}%`)
      if (digits.length >= 4) { ors.push(`m.recipient LIKE ?`); args.push(`%${digits}%`) }
      for (const k of hits) { ors.push(`m.recipient LIKE ?`); args.push(`%${k}`) }
      where.push(`(${ors.join(' OR ')})`)
    }
    const n = Number(q.get('page') ?? 0)
    const page = Number.isInteger(n) && n >= 0 ? n : 0
    const w = where.join(' AND ')
    const total = await c.db.prepare(`SELECT count(*) AS n FROM message_log m WHERE ${w}`).bind(...args).first<{ n: number }>()
    const rows = await c.db.prepare(`SELECT m.id, m.recipient, m.template_code, m.status, m.error, ${isoZ('m.queued_at')} AS queued_at, ${isoZ('m.sent_at')} AS sent_at
        FROM message_log m WHERE ${w} ORDER BY m.queued_at DESC, m.id LIMIT ? OFFSET ?`).bind(...args, PAGE, page * PAGE)
      .all<{ id: string; recipient: string; template_code: string | null; status: string; error: string | null; queued_at: string; sent_at: string | null }>()
    const items: ConnectLogItem[] = rows.results.map((m) => ({
      id: m.id, recipient: m.recipient, name: names.get(last10(m.recipient)) ?? null, template_code: m.template_code,
      status: recipientStatus(m.status), error: m.error, queued_at: m.queued_at, sent_at: m.sent_at,
    }))
    return { items, total: Number(total?.n ?? 0), page, page_size: PAGE }
  })
}
