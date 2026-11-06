/* Yajur Connect sending (communication.yajur_connect), all under
   comms.connect.write: a template to one parent (linked to their chat), a
   broadcast kept as a campaign, and schedules. Everything is queued through
   the Messenger (services/wa_send.ts); dispatch applies the recipient guard. */
import type { Ctx, Router } from '../../router'
import { reply } from '../../router'
import { HttpError, badRequest, isUUID, like, now, readJSON, uuid } from '../../http'
import { normalisePhone, normaliseRecipient } from '../admin/msg_guard'
import { MessagingError, queueMessage, scopeOf } from '../../services/messaging'
import { conversationFor, recordOutbound } from '../../services/wa_connect'
import {
  CAMPAIGN_SELECT, CAMPAIGN_SOURCE, audienceLabel, campaignCounts, cleanBroadcast, cleanImage, cleanRepeat, cleanValues, fillValues, previewBroadcast,
  recipientStatus, runBroadcast, sendTemplates, templateOr400, viewCampaign, viewSchedule, type CampaignRow, type ScheduleRow,
} from '../../services/wa_send'
import type { ConnectBroadcastBody, ConnectNewBody, ConnectPerson, ConnectScheduleBody } from '@shared/api/feature_yajur_connect'

const WRITE = 'comms.connect.write'
export const NEW_SOURCE = 'wa_connect_new'

const notQueued = (e: unknown): never => {
  if (e instanceof MessagingError) throw new HttpError(409, e.message, { code: e.code })
  throw e
}

async function scheduleOr404(c: Ctx): Promise<ScheduleRow> {
  if (!isUUID(c.params.id)) throw badRequest('invalid schedule id')
  const r = await c.db.prepare(`SELECT * FROM wa_schedules WHERE id = ?`).bind(c.params.id).first<ScheduleRow>()
  if (!r) throw new HttpError(404, 'that schedule does not exist')
  return r
}
async function scheduleView(c: Ctx, r: ScheduleRow) {
  const p = JSON.parse(r.payload) as ConnectBroadcastBody
  return viewSchedule(r, await audienceLabel(c.db, p.audience).catch(() => ''))
}

export function registerYajurConnectSend(r: Router): void {
  r.typed('GET /comms/yajur-connect/send/templates', WRITE, async (c) => ({ items: await sendTemplates(c.db) }))

  r.typed('GET /comms/yajur-connect/send/audiences', WRITE, async (c) => {
    const cls = await c.db.prepare(`SELECT id, name FROM classes ORDER BY level, name`).all<{ id: string; name: string }>()
    const secs = await c.db.prepare(`SELECT se.id, se.name, se.class_id FROM sections se JOIN academic_years ay ON ay.id = se.academic_year_id
        WHERE ay.is_current = 1 ORDER BY se.name`).all<{ id: string; name: string; class_id: string }>()
    return { classes: cls.results.map((k) => ({ id: k.id, name: k.name, sections: secs.results.filter((s) => s.class_id === k.id).map((s) => ({ id: s.id, name: s.name })) })) }
  })

  r.typed('GET /comms/yajur-connect/send/people', WRITE, async (c) => {
    const q = (c.url.searchParams.get('q') ?? '').trim().slice(0, 60)
    if (q.length < 2) return { items: [] }
    const digits = q.replace(/[^0-9]/g, ''), l = like(q)
    const rows = await c.db.prepare(`SELECT g.id AS guardian_id, g.full_name AS guardian_name, g.relation, g.phone, s.id AS student_id,
          trim(s.first_name || ' ' || coalesce(s.last_name, '')) AS student_name,
          (SELECT cl.name || ' ' || se.name FROM enrollments en JOIN classes cl ON cl.id = en.class_id JOIN sections se ON se.id = en.section_id
            WHERE en.student_id = s.id AND en.status = 'active' ORDER BY en.enrolled_on DESC LIMIT 1) AS class_section
        FROM guardians g LEFT JOIN student_guardians sg ON sg.guardian_id = g.id LEFT JOIN students s ON s.id = sg.student_id
        WHERE trim(coalesce(g.phone, '')) <> '' AND (g.full_name LIKE ?1 ESCAPE '\\' OR s.first_name || ' ' || coalesce(s.last_name, '') LIKE ?1 ESCAPE '\\'
          OR s.admission_no LIKE ?1 ESCAPE '\\'${digits.length >= 4 ? ` OR replace(replace(g.phone, ' ', ''), '-', '') LIKE ?2` : ''})
        ORDER BY g.full_name, s.first_name LIMIT 30`).bind(l, `%${digits}%`)
      .all<Omit<ConnectPerson, 'opted_out'>>()
    const opts = new Set((await c.db.prepare(`SELECT contact FROM message_opt_outs WHERE scope = 'all'`).all<{ contact: string }>()).results.map((x) => x.contact))
    return { items: rows.results.map((p) => ({ ...p, opted_out: opts.has(normaliseRecipient(p.phone)) })) }
  })

  r.typed('POST /comms/yajur-connect/send', WRITE, async (c) => {
    const b = await readJSON<Partial<ConnectNewBody>>(c.req)
    if (!isUUID(b.guardian_id)) throw badRequest('choose a parent')
    if (b.student_id != null && !isUUID(b.student_id)) throw badRequest('invalid student id')
    const t = await templateOr400(c.db, String(b.template_code ?? ''))
    const values = cleanValues(t, b.values)
    const image = cleanImage(b.header_image_url)
    const g = await c.db.prepare(`SELECT g.id, g.full_name, g.phone, s.id AS student_id, trim(s.first_name || ' ' || coalesce(s.last_name, '')) AS student_name,
          (SELECT cl.name || ' ' || se.name FROM enrollments en JOIN classes cl ON cl.id = en.class_id JOIN sections se ON se.id = en.section_id
            WHERE en.student_id = s.id AND en.status = 'active' ORDER BY en.enrolled_on DESC LIMIT 1) AS class
        FROM guardians g LEFT JOIN student_guardians sg ON sg.guardian_id = g.id AND (?2 IS NULL OR sg.student_id = ?2) LEFT JOIN students s ON s.id = sg.student_id
        WHERE g.id = ?1 ORDER BY sg.is_primary DESC LIMIT 1`).bind(b.guardian_id, b.student_id ?? null)
      .first<{ id: string; full_name: string; phone: string | null; student_id: string | null; student_name: string | null; class: string | null }>()
    if (!g) throw new HttpError(404, 'that parent does not exist')
    if (b.student_id && g.student_id !== b.student_id) throw badRequest('that student is not this parent\'s child')
    const phone = normalisePhone(g.phone ?? '')
    if (!phone) throw badRequest('this parent has no WhatsApp number that can be read')
    const vars = fillValues(values, t.fields, { parent_name: g.full_name, student_name: g.student_name ?? '', class: g.class ?? '' })
    const at = now()
    const conv = await conversationFor(c.db, c.id.institution!.id, phone, null, at)
    const res = await queueMessage(scopeOf(c), {
      channel: 'whatsapp', template_code: t.code, vars, recipient: '+' + phone, student_id: g.student_id, exact_channel: true,
      source_kind: NEW_SOURCE, source_id: conv, occurrence_key: uuid(), media: image ? { kind: 'image', url: image } : null,
    }).catch(notQueued)
    const body = res.id ? (await c.db.prepare(`SELECT body FROM message_log WHERE id = ?`).bind(res.id).first<{ body: string | null }>())?.body : null
    const out = await recordOutbound(c.db, c.id.institution!.id, conv, 'template', body || t.code, res.id, { user: c.id.userId })
    const m = await c.db.prepare(`SELECT m.*, ml.status AS log_status, ml.error AS log_error, u.full_name AS sent_by_name
        FROM wa_messages m LEFT JOIN message_log ml ON ml.id = m.message_log_id LEFT JOIN users u ON u.id = m.sent_by WHERE m.id = ?`).bind(out.id)
      .first<{ id: string; direction: 'in' | 'out'; kind: string; text: string | null; status: string | null; log_status: string | null; log_error: string | null; sent_by_name: string | null; at: string }>()
    return reply({
      conversation_id: conv,
      message: {
        id: m!.id, direction: m!.direction, kind: m!.kind, text: m!.text, media_id: null, media_mime: null, media_name: null, reply_to_wa_id: null, wa_id: null,
        status: m!.log_status ?? m!.status ?? '', error: m!.log_error, sent_by_name: m!.sent_by_name, auto_reply: false, at: m!.at,
      },
    }, 201)
  })

  r.typed('POST /comms/yajur-connect/send/preview', WRITE, async (c) => {
    const b = await cleanBroadcast(c.db, await readJSON<Partial<ConnectBroadcastBody>>(c.req))
    return previewBroadcast(c.db, b)
  })

  r.typed('GET /comms/yajur-connect/campaigns', WRITE, async (c) => {
    const rows = (await c.db.prepare(`${CAMPAIGN_SELECT} ORDER BY w.created_at DESC LIMIT 200`).all<CampaignRow>()).results
    const counts = await campaignCounts(c.db, rows.map((x) => x.id))
    return { items: rows.map((x) => viewCampaign(x, counts.get(x.id) ?? {})) }
  })

  r.typed('POST /comms/yajur-connect/campaigns', WRITE, async (c) => {
    const b = await cleanBroadcast(c.db, await readJSON<Partial<ConnectBroadcastBody>>(c.req))
    const id = await runBroadcast(scopeOf(c), b, c.id.userId)
    const row = (await c.db.prepare(`${CAMPAIGN_SELECT} WHERE w.id = ?`).bind(id).first<CampaignRow>())!
    return reply(viewCampaign(row, (await campaignCounts(c.db, [id])).get(id) ?? {}), 201)
  })

  r.typed('GET /comms/yajur-connect/campaigns/{id}', WRITE, async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid campaign id')
    const row = await c.db.prepare(`${CAMPAIGN_SELECT} WHERE w.id = ?`).bind(c.params.id).first<CampaignRow>()
    if (!row) throw new HttpError(404, 'that campaign does not exist')
    const logs = await c.db.prepare(`SELECT ml.id, ml.recipient, ml.status, ml.error, ml.queued_at, ml.template_vars
        FROM message_log ml WHERE ml.source_kind = ? AND ml.source_id = ? ORDER BY ml.queued_at LIMIT 5000`).bind(CAMPAIGN_SOURCE, row.id)
      .all<{ id: string; recipient: string; status: string; error: string | null; queued_at: string; template_vars: string | null }>()
    const counts = (await campaignCounts(c.db, [row.id])).get(row.id) ?? {}
    return {
      campaign: viewCampaign(row, counts),
      recipients: logs.results.map((l) => {
        let v: Record<string, unknown> = {}
        try { v = JSON.parse(l.template_vars ?? '{}') ?? {} } catch { /* kept empty */ }
        const s = (k: string) => (typeof v[k] === 'string' && v[k] ? String(v[k]) : null)
        return { id: l.id, recipient: l.recipient, parent_name: s('parent_name'), student_name: s('student_name'), class: s('class'),
          status: recipientStatus(l.status), error: l.error, at: l.queued_at }
      }),
    }
  })

  r.typed('GET /comms/yajur-connect/schedules', WRITE, async (c) => {
    const rows = (await c.db.prepare(`SELECT * FROM wa_schedules ORDER BY active DESC, coalesce(next_run_at, last_run_at) DESC LIMIT 200`).all<ScheduleRow>()).results
    return { items: await Promise.all(rows.map((x) => scheduleView(c, x))) }
  })

  r.typed('POST /comms/yajur-connect/schedules', WRITE, async (c) => {
    const raw = await readJSON<Partial<ConnectScheduleBody>>(c.req)
    const b = await cleanBroadcast(c.db, raw)
    const repeat = cleanRepeat(raw.repeat)
    const when = Date.parse(String(raw.run_at ?? ''))
    if (!Number.isFinite(when)) throw badRequest('choose the date and time to send')
    if (when < Date.now() - 60_000) throw badRequest('that time has passed: choose a later one')
    const runAt = new Date(when).toISOString(), t = now(), id = uuid()
    const payload: ConnectBroadcastBody = { name: b.name, template_code: b.template.code, values: b.values, header_image_url: b.image, audience: b.audience }
    await c.db.prepare(`INSERT INTO wa_schedules (id, institution_id, name, repeat, first_run_at, next_run_at, payload, active, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,1,?,?,?)`).bind(id, c.id.institution!.id, b.name, repeat, runAt, runAt, JSON.stringify(payload), c.id.userId, t, t).run()
    return reply(await scheduleView(c, (await c.db.prepare(`SELECT * FROM wa_schedules WHERE id = ?`).bind(id).first<ScheduleRow>())!), 201)
  })

  r.typed('PUT /comms/yajur-connect/schedules/{id}', WRITE, async (c) => {
    const cur = await scheduleOr404(c)
    const b = await readJSON<{ active?: unknown }>(c.req)
    if (typeof b.active !== 'boolean') throw badRequest('active is true or false')
    if (b.active && !cur.next_run_at) throw badRequest('this schedule has already run; make a new one')
    await c.db.prepare(`UPDATE wa_schedules SET active = ?, updated_at = ? WHERE id = ?`).bind(b.active ? 1 : 0, now(), cur.id).run()
    return scheduleView(c, (await c.db.prepare(`SELECT * FROM wa_schedules WHERE id = ?`).bind(cur.id).first<ScheduleRow>())!)
  })

  r.typed('DELETE /comms/yajur-connect/schedules/{id}', WRITE, async (c) => {
    const cur = await scheduleOr404(c)
    await c.db.prepare(`DELETE FROM wa_schedules WHERE id = ?`).bind(cur.id).run()
    return { ok: true as const }
  })
}
