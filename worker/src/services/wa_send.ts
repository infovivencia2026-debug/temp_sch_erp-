/* Yajur Connect sending: one template to one parent, a broadcast to an
   audience (kept as a campaign snapshot), and schedules that run a broadcast
   later or on repeat (cron 'connect:schedules').

   Nothing here sends. Every message is queued with the Messenger
   (services/messaging.ts) on WhatsApp, so dispatch applies the school's
   recipient guard and opt-outs, and the queue applies quiet hours. Opt-outs
   are also left out before queueing, so the count shown is the count queued. */
import { HttpError, badRequest, isUUID } from '../http'
import { normalisePhone, normaliseRecipient } from '../routes/admin/msg_guard'
import { templatePlaceholders } from '../routes/admin/msg_templates'
import { MessagingError, Messenger, renderTemplate, type Media, type MsgScope } from './messaging'
import type {
  ConnectAudience, ConnectBroadcastBody, ConnectCampaign, ConnectPreview, ConnectRecipientStatus, ConnectRelation, ConnectRepeat, ConnectSchedule, ConnectSendTemplate,
} from '@shared/api/feature_yajur_connect'

export const CAMPAIGN_SOURCE = 'wa_campaign'
const MERGE = ['parent_name', 'student_name', 'class', 'staff_name']
const AUTO = new Set([...MERGE, 'school_name'])
const RELATIONS: ConnectRelation[] = ['father', 'mother', 'both']
const REPEATS: ConnectRepeat[] = ['once', 'daily', 'weekly', 'monthly']
const MAX_IDS = 90

// ---- templates --------------------------------------------------------------

/** Only templates made for Yajur Connect (code connect_*) are offered there; the ERP's system templates keep their own mappings. */
export const connectLabel = (code: string) => code.replace(/^connect_/, '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())

export async function sendTemplates(db: D1Database): Promise<ConnectSendTemplate[]> {
  const r = await db.prepare(`SELECT code, wa_template_name, body, coalesce(has_image_header, 0) AS has_image_header FROM message_templates WHERE channel = 'whatsapp' AND is_active = 1
      AND trim(coalesce(wa_template_name, '')) <> '' AND substr(code, 1, 8) = 'connect_' ORDER BY code`).all<{ code: string; wa_template_name: string; body: string | null; has_image_header: number }>()
  return r.results.map((t) => ({ code: t.code, name: connectLabel(t.code), body: t.body ?? '', fields: templatePlaceholders(t.body ?? '').filter((f) => f !== 'school_name'), has_image_header: t.has_image_header === 1 }))
}

export async function templateOr400(db: D1Database, code: string): Promise<ConnectSendTemplate> {
  const t = (await sendTemplates(db)).find((x) => x.code === String(code ?? '').trim())
  if (!t) throw badRequest('choose an approved WhatsApp template of this school')
  return t
}

/** The typed values, checked: every field that is not filled per recipient needs one. */
export function cleanValues(t: ConnectSendTemplate, raw: unknown): Record<string, string> {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) throw badRequest('values must be an object of field: text')
  const src = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const f of t.fields) {
    const v = String(src[f] ?? '').trim()
    if (v.length > 1000) throw badRequest(`the value for ${f} is at most 1000 characters`)
    if (AUTO.has(f)) continue // filled per recipient; a typed value is never used
    if (!v) throw badRequest(`fill the template field ${f}`)
    if (v) out[f] = v
  }
  return out
}

export function cleanImage(t: ConnectSendTemplate, raw: unknown): string | null {
  const u = String(raw ?? '').trim()
  if (!u) return null
  if (!t.has_image_header) throw badRequest('this template has no picture header, so it cannot carry a picture')
  if (u.length > 500 || !/^https:\/\/[^\s]+$/i.test(u)) throw badRequest('the header image must be an https:// link to the picture')
  return u
}

/** A parent (guardian_id set) or a staff member (employee_id set; parent_name is the staff name, so parent templates still read). */
export interface Recipient { guardian_id: string | null; employee_id?: string | null; parent_name: string; staff_name?: string; phone: string; student_id: string | null; student_name: string; class: string }

/** The template's variables for one recipient: merge tokens filled inside every value, empty token fields filled outright. */
export function fillValues(values: Record<string, string>, fields: string[], r: Pick<Recipient, 'parent_name' | 'student_name' | 'class' | 'staff_name'>): Record<string, string> {
  const tokens: Record<string, string> = { parent_name: r.parent_name || 'Parent', student_name: r.student_name, class: r.class, staff_name: r.staff_name || r.parent_name || 'Staff' }
  const vars: Record<string, string> = { ...tokens }
  for (const f of fields) {
    if (values[f] !== undefined) vars[f] = values[f].replace(/\{\{\s*(parent_name|student_name|class|staff_name)\s*\}\}/gi, (_, k: string) => tokens[k.toLowerCase()])
  }
  return vars
}

/** The wording with the typed values in and the merge tokens left as tokens: what the campaign snapshot keeps. */
export function renderGeneric(t: ConnectSendTemplate, values: Record<string, string>): string {
  const vars: Record<string, string> = {}
  for (const f of t.fields) vars[f] = values[f] ?? `{{${f}}}`
  return renderTemplate(t.body, vars)
}

// ---- audience -----------------------------------------------------------------

export function cleanAudience(raw: unknown): ConnectAudience {
  const a = (raw ?? {}) as Partial<ConnectAudience>
  if (!['school', 'classes', 'sections', 'staff', 'departments'].includes(String(a.scope))) throw badRequest('audience must be the whole school, classes, sections, all staff or departments')
  const staff = a.scope === 'staff' || a.scope === 'departments'
  if (!staff && !RELATIONS.includes(a.relation as ConnectRelation)) throw badRequest('send to the father, the mother or both')
  const all = a.scope === 'school' || a.scope === 'staff'
  const ids = all ? [] : Array.isArray(a.ids) ? [...new Set(a.ids.map(String))] : []
  if (!all && ids.length === 0) throw badRequest(`choose at least one ${a.scope === 'classes' ? 'class' : a.scope === 'sections' ? 'section' : 'department'}`)
  if (ids.length > MAX_IDS) throw badRequest(`choose at most ${MAX_IDS}`)
  if (ids.some((x) => !isUUID(x))) throw badRequest('invalid class, section or department id')
  return { scope: a.scope as ConnectAudience['scope'], ids, relation: staff ? 'both' : a.relation as ConnectRelation }
}

export async function audienceLabel(db: D1Database, a: ConnectAudience): Promise<string> {
  if (a.scope === 'staff') return 'All staff'
  const ph = a.ids.map(() => '?').join(',')
  if (a.scope === 'departments') {
    const d = (await db.prepare(`SELECT name AS n FROM departments WHERE id IN (${ph}) ORDER BY name`).bind(...a.ids).all<{ n: string }>()).results.map((r) => r.n)
    return `Staff: ${d.join(', ') || 'No department'}`
  }
  const who = a.relation === 'both' ? 'parents' : a.relation === 'father' ? 'fathers' : 'mothers'
  if (a.scope === 'school') return `Whole school, ${who}`
  const sql = a.scope === 'classes' ? `SELECT name AS n FROM classes WHERE id IN (${ph}) ORDER BY level, name`
    : `SELECT cl.name || ' ' || se.name AS n FROM sections se JOIN classes cl ON cl.id = se.class_id WHERE se.id IN (${ph}) ORDER BY cl.level, cl.name, se.name`
  const names = (await db.prepare(sql).bind(...a.ids).all<{ n: string }>()).results.map((r) => r.n)
  return `${names.join(', ') || 'No class'}, ${who}`
}

async function optOutSet(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare(`SELECT contact FROM message_opt_outs WHERE scope = 'all'`).all<{ contact: string }>().catch(() => ({ results: [] as { contact: string }[] }))
  return new Set(r.results.map((x) => x.contact))
}

/** Everyone the audience reaches: one row per number and child, opted-out and unreadable numbers counted apart. */
export async function resolveAudience(db: D1Database, a: ConnectAudience): Promise<{ list: Recipient[]; opted_out: number; no_phone: number }> {
  if (a.scope === 'staff' || a.scope === 'departments') return resolveStaff(db, a)
  const where = [`s.status = 'active'`, `en.status = 'active'`], args: unknown[] = []
  if (a.scope === 'classes') { where.push(`en.class_id IN (${a.ids.map(() => '?').join(',')})`); args.push(...a.ids) }
  if (a.scope === 'sections') { where.push(`en.section_id IN (${a.ids.map(() => '?').join(',')})`); args.push(...a.ids) }
  if (a.relation !== 'both') { where.push(`lower(g.relation) = ?`); args.push(a.relation) }
  const rows = await db.prepare(`SELECT g.id AS guardian_id, g.full_name AS parent_name, g.phone, s.id AS student_id,
        trim(s.first_name || ' ' || coalesce(s.last_name, '')) AS student_name, cl.name || ' ' || se.name AS class
      FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id JOIN students s ON s.id = sg.student_id
      JOIN enrollments en ON en.student_id = s.id JOIN classes cl ON cl.id = en.class_id JOIN sections se ON se.id = en.section_id
      WHERE ${where.join(' AND ')} ORDER BY cl.level, cl.name, se.name, s.first_name, g.full_name`).bind(...args)
    .all<{ guardian_id: string; parent_name: string; phone: string | null; student_id: string; student_name: string; class: string }>()
  const opts = await optOutSet(db)
  const seen = new Set<string>()
  const list: Recipient[] = []
  let opted = 0, noPhone = 0
  for (const r of rows.results) {
    const phone = normalisePhone(r.phone ?? '')
    if (!phone) { noPhone++; continue }
    const key = phone + '|' + r.student_id
    if (seen.has(key)) continue
    seen.add(key)
    if (opts.has(normaliseRecipient('+' + phone))) { opted++; continue }
    list.push({ ...r, phone })
  }
  return { list, opted_out: opted, no_phone: noPhone }
}

/** Active staff with their own phone from the staff records; one message per number. */
async function resolveStaff(db: D1Database, a: ConnectAudience): Promise<{ list: Recipient[]; opted_out: number; no_phone: number }> {
  const dept = a.scope === 'departments' ? `AND e.department_id IN (${a.ids.map(() => '?').join(',')})` : ''
  const rows = await db.prepare(`SELECT e.id AS employee_id, trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS name, e.phone, coalesce(d.name, '') AS dept
      FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' ${dept} ORDER BY e.first_name, e.last_name`)
    .bind(...(dept ? a.ids : [])).all<{ employee_id: string; name: string; phone: string | null; dept: string }>()
  const opts = await optOutSet(db)
  const seen = new Set<string>()
  const list: Recipient[] = []
  let opted = 0, noPhone = 0
  for (const r of rows.results) {
    const phone = normalisePhone(r.phone ?? '')
    if (!phone) { noPhone++; continue }
    if (seen.has(phone)) continue
    seen.add(phone)
    if (opts.has(normaliseRecipient('+' + phone))) { opted++; continue }
    list.push({ guardian_id: null, employee_id: r.employee_id, parent_name: r.name, staff_name: r.name, phone, student_id: null, student_name: '', class: r.dept })
  }
  return { list, opted_out: opted, no_phone: noPhone }
}

// ---- broadcast ----------------------------------------------------------------

export interface CleanBroadcast { name: string; template: ConnectSendTemplate; values: Record<string, string>; image: string | null; audience: ConnectAudience }

export async function cleanBroadcast(db: D1Database, b: Partial<ConnectBroadcastBody>): Promise<CleanBroadcast> {
  const name = String(b.name ?? '').trim()
  if (!name) throw badRequest('give the campaign a name')
  if (name.length > 100) throw badRequest('a campaign name is at most 100 characters')
  const template = await templateOr400(db, String(b.template_code ?? ''))
  return { name, template, values: cleanValues(template, b.values), image: cleanImage(template, b.header_image_url), audience: cleanAudience(b.audience) }
}

export async function previewBroadcast(db: D1Database, b: CleanBroadcast): Promise<ConnectPreview> {
  const aud = await resolveAudience(db, b.audience)
  const first = aud.list[0]
  return {
    count: aud.list.length, opted_out: aud.opted_out, no_phone: aud.no_phone, audience_label: await audienceLabel(db, b.audience),
    sample: first ? renderTemplate(b.template.body, fillValues(b.values, b.template.fields, first)) : null,
    sample_to: first ? `${first.parent_name}, +${first.phone}` : null,
  }
}

const media = (url: string | null): Media | null => (url ? { kind: 'image', url } : null)

/** Queue a broadcast and keep its snapshot. Throws 409 when the first message cannot be queued (WhatsApp not set up, no wording). */
export async function runBroadcast(m: MsgScope, b: CleanBroadcast, by: string | null, scheduleId: string | null = null): Promise<string> {
  const { db, inst } = m
  const aud = await resolveAudience(db, b.audience)
  if (aud.list.length === 0) throw new HttpError(400, 'nobody in this audience can be reached: no WhatsApp number on file, or all opted out')
  const id = crypto.randomUUID()
  await db.prepare(`INSERT INTO wa_campaigns (id, institution_id, name, template_code, template_name, template_values, rendered, header_image_url,
      audience, audience_label, recipient_count, opted_out, schedule_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, inst, b.name, b.template.code, b.template.name, JSON.stringify(b.values), renderGeneric(b.template, b.values), b.image,
      JSON.stringify(b.audience), await audienceLabel(db, b.audience), 0, aud.opted_out, scheduleId, by, new Date().toISOString()).run()
  const ms = new Messenger(m)
  let queued = 0
  for (const r of aud.list) {
    try {
      const res = await ms.queue({
        channel: 'whatsapp', template_code: b.template.code, vars: fillValues(b.values, b.template.fields, r), recipient: '+' + r.phone,
        student_id: r.student_id, exact_channel: true, source_kind: CAMPAIGN_SOURCE, source_id: id, occurrence_key: r.phone, media: media(b.image),
      })
      if (res.id) queued++
    } catch (e) {
      if (!(e instanceof MessagingError)) throw e
      if (queued === 0) {
        await db.prepare(`DELETE FROM wa_campaigns WHERE id = ?`).bind(id).run()
        throw new HttpError(409, e.message, { code: e.code })
      }
    }
  }
  await db.prepare(`UPDATE wa_campaigns SET recipient_count = ? WHERE id = ?`).bind(queued, id).run()
  await ms.kick()
  return id
}

interface CampaignRow {
  id: string; name: string; template_code: string; template_name: string | null; template_values: string; rendered: string; header_image_url: string | null
  audience: string; audience_label: string; recipient_count: number; opted_out: number; schedule_id: string | null; created_by_name: string | null; created_at: string
}
export const CAMPAIGN_SELECT = `SELECT w.*, u.full_name AS created_by_name FROM wa_campaigns w LEFT JOIN users u ON u.id = w.created_by`

const json = <T>(raw: string, fallback: T): T => { try { return JSON.parse(raw) as T } catch { return fallback } }
export const recipientStatus = (s: string): ConnectRecipientStatus =>
  s === 'suppressed' ? 'blocked' : s === 'sent' || s === 'delivered' || s === 'read' || s === 'failed' ? s : 'queued'

export function viewCampaign(r: CampaignRow, counts: ConnectCampaign['counts']): ConnectCampaign {
  return {
    id: r.id, name: r.name, template_code: r.template_code, template_name: r.template_name, values: json(r.template_values, {}), rendered: r.rendered,
    header_image_url: r.header_image_url, audience: json(r.audience, { scope: 'school', ids: [], relation: 'both' }), audience_label: r.audience_label,
    recipient_count: r.recipient_count, opted_out: r.opted_out, schedule_id: r.schedule_id, created_by_name: r.created_by_name, created_at: r.created_at, counts,
  }
}

export async function campaignCounts(db: D1Database, ids: string[]): Promise<Map<string, ConnectCampaign['counts']>> {
  const out = new Map<string, ConnectCampaign['counts']>()
  if (!ids.length) return out
  const r = await db.prepare(`SELECT source_id, status, count(*) AS n FROM message_log WHERE source_kind = ? AND source_id IN (${ids.map(() => '?').join(',')})
      GROUP BY source_id, status`).bind(CAMPAIGN_SOURCE, ...ids).all<{ source_id: string; status: string; n: number }>()
  for (const x of r.results) {
    const c = out.get(x.source_id) ?? {}
    const k = recipientStatus(x.status)
    c[k] = (c[k] ?? 0) + x.n
    out.set(x.source_id, c)
  }
  return out
}

export type { CampaignRow }

// ---- schedules ----------------------------------------------------------------

export function cleanRepeat(v: unknown): ConnectRepeat {
  if (!REPEATS.includes(v as ConnectRepeat)) throw badRequest('repeat must be once, daily, weekly or monthly')
  return v as ConnectRepeat
}

/** The run after `from` for a repeat, moved past now so missed runs are skipped, not sent in a burst. */
export function nextRun(repeat: ConnectRepeat, from: string, now = Date.now()): string | null {
  if (repeat === 'once') return null
  const d = new Date(from)
  const day = d.getUTCDate()
  do {
    if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1)
    else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7)
    else {
      d.setUTCDate(1)
      d.setUTCMonth(d.getUTCMonth() + 1)
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
      d.setUTCDate(Math.min(day, last))
    }
  } while (d.getTime() <= now)
  return d.toISOString()
}

export interface ScheduleRow {
  id: string; name: string; repeat: ConnectRepeat; first_run_at: string; next_run_at: string | null; last_run_at: string | null; last_campaign_id: string | null
  last_error: string | null; payload: string; active: number; created_by: string | null
}
export function viewSchedule(r: ScheduleRow, label: string): ConnectSchedule {
  const p = json<Partial<ConnectBroadcastBody>>(r.payload, {})
  return {
    id: r.id, name: r.name, repeat: r.repeat, first_run_at: r.first_run_at, next_run_at: r.next_run_at, last_run_at: r.last_run_at,
    last_campaign_id: r.last_campaign_id, last_error: r.last_error, active: r.active === 1, template_code: String(p.template_code ?? ''), audience_label: label,
  }
}

/** Run every schedule that has come due. A run is claimed by moving next_run_at with a compare-and-set first, so two ticks never queue it twice. */
export async function runDueSchedules(m: MsgScope, now = new Date()): Promise<number> {
  const { db } = m
  const at = now.toISOString()
  const due = await db.prepare(`SELECT * FROM wa_schedules WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 20`)
    .bind(at).all<ScheduleRow>()
  let ran = 0
  for (const s of due.results) {
    const next = nextRun(s.repeat, s.next_run_at!, now.getTime())
    const claim = await db.prepare(`UPDATE wa_schedules SET next_run_at = ?, last_run_at = ?, active = ?, updated_at = ? WHERE id = ? AND active = 1 AND next_run_at = ?`)
      .bind(next, at, next ? 1 : 0, at, s.id, s.next_run_at).run()
    if (!claim.meta.changes) continue
    let campaign: string | null = null, error: string | null = null
    try {
      const b = await cleanBroadcast(db, json<Partial<ConnectBroadcastBody>>(s.payload, {}))
      campaign = await runBroadcast(m, b, s.created_by, s.id)
      ran++
    } catch (e) {
      if (!(e instanceof HttpError) && !(e instanceof MessagingError)) throw e
      error = e.message
    }
    await db.prepare(`UPDATE wa_schedules SET last_campaign_id = coalesce(?, last_campaign_id), last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(campaign, error, at, s.id).run()
  }
  return ran
}
