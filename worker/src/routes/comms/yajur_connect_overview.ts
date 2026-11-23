/* Yajur Connect Overview: the counts and recent items for the Connect home
   screen, plus the read-only facts the Settings screen shows (connection,
   test-list limit, auto-reply count). Never returns a token, id or secret. */
import type { Router } from '../../router'
import { ok } from '../../http'
import { loadGuard } from '../admin/msg_guard'
import { CAMPAIGN_SELECT, campaignCounts, recipientStatus } from '../../services/wa_send'
import type { CampaignRow } from '../../services/wa_send'
import { isoZ } from './common'

type Delivery = { sent: number; delivered: number; read: number; failed: number; pending: number }

export function registerYajurConnectOverview(r: Router, perm: string): void {
  r.get('/comms/yajur-connect/overview', perm, async (c) => {
    const [parents, students, notices, rules, statuses, replies, campaigns, wa] = await Promise.all([
      c.db.prepare(`SELECT count(DISTINCT g.id) AS n FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id
          JOIN students s ON s.id = sg.student_id WHERE s.status = 'active' AND trim(coalesce(g.phone, '')) <> ''`).first<{ n: number }>(),
      c.db.prepare(`SELECT count(*) AS n FROM students WHERE status = 'active'`).first<{ n: number }>(),
      c.db.prepare(`SELECT count(*) AS n FROM wa_campaigns`).first<{ n: number }>(),
      c.db.prepare(`SELECT count(*) AS n, coalesce(sum(enabled), 0) AS on_n FROM wa_autoreplies`).first<{ n: number; on_n: number }>(),
      c.db.prepare(`SELECT status, count(*) AS n FROM message_log WHERE channel = 'whatsapp' GROUP BY status`).all<{ status: string; n: number }>(),
      c.db.prepare(`SELECT c.id, c.phone, c.profile_name, c.unread,
          coalesce((SELECT CASE WHEN m.kind = 'text' THEN m.text WHEN m.kind = 'image' THEN '[image]' ELSE coalesce(m.text, '[' || m.kind || ']') END
            FROM wa_messages m WHERE m.conversation_id = c.id AND m.direction = 'in' AND m.kind <> 'reaction' ORDER BY m.at DESC LIMIT 1), c.last_preview) AS last_preview,
          ${isoZ('c.last_inbound_at')} AS at,
          g.full_name AS guardian_name, trim(s.first_name || ' ' || coalesce(s.last_name, '')) AS student_name
          FROM wa_conversations c LEFT JOIN guardians g ON g.id = c.guardian_id LEFT JOIN students s ON s.id = c.student_id
          WHERE c.last_inbound_at IS NOT NULL ORDER BY c.last_inbound_at DESC LIMIT 5`)
        .all<{ id: string; phone: string; profile_name: string | null; unread: number; last_preview: string | null; at: string; guardian_name: string | null; student_name: string | null }>(),
      c.db.prepare(`${CAMPAIGN_SELECT} ORDER BY w.created_at DESC LIMIT 5`).all<CampaignRow>(),
      c.db.prepare(`SELECT config, enabled, length(credentials) AS cred_len FROM integrations
          WHERE kind = 'messaging' AND provider = 'whatsapp' AND institution_id IS NOT NULL LIMIT 1`)
        .first<{ config: string | null; enabled: number; cred_len: number | null }>(),
    ])

    const delivery: Delivery = { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0 }
    for (const x of statuses.results) {
      const k = recipientStatus(x.status)
      if (k === 'queued') delivery.pending += x.n
      else if (k !== 'blocked') delivery[k] += x.n
    }

    const counts = await campaignCounts(c.db, campaigns.results.map((w) => w.id))

    // Set up = a numeric phone number id and a stored token; neither is returned.
    let pnid = ''
    try { pnid = String((JSON.parse(wa?.config ?? '{}') as Record<string, unknown>).phone_number_id ?? '').trim() } catch { pnid = '' }
    const connection = !wa ? 'not_set_up' as const
      : !Number(wa.enabled) ? 'off' as const
      : /^[0-9]+$/.test(pnid) && Number(wa.cred_len ?? 0) > 0 ? 'ready' as const : 'incomplete' as const

    const g = await loadGuard(c)
    return ok({
      parents: Number(parents?.n ?? 0),
      students: Number(students?.n ?? 0),
      notices: Number(notices?.n ?? 0),
      delivery,
      replies: replies.results.map((x) => ({
        id: x.id, name: x.guardian_name || x.student_name || x.profile_name || '+' + x.phone, student_name: x.student_name || null,
        preview: x.last_preview ?? '', at: x.at, unread: Number(x.unread) || 0,
      })),
      campaigns: campaigns.results.map((w) => ({
        id: w.id, name: w.name, audience_label: w.audience_label, recipient_count: w.recipient_count, created_at: w.created_at, counts: counts.get(w.id) ?? {},
      })),
      connection,
      guard_on: g.mode !== 'everyone' && !g.unguarded.has('whatsapp'),
      test_numbers: [...g.allowed].filter((k) => k.startsWith('phone:')).length,
      autoreplies: { total: Number(rules?.n ?? 0), enabled: Number(rules?.on_n ?? 0) },
    })
  })
}
