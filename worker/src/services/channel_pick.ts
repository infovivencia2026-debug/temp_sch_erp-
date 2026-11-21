/* Channels a sender ticked: In app always goes; the paid ones go only when
   ticked and live (Yajur Connect is the school's WhatsApp; SMS waits for the
   DLT renewal; email when set up). Shared by circulars, attendance messages to
   parents and fee reminders, and by the estimate that prices them. */
import { looksEmail, phoneOf } from './delivery'

export const PAID_CHANNELS = ['whatsapp', 'sms', 'email'] as const

/** The ticked paid channels that are live, in a fixed order. */
export function pickChannels(raw: unknown, live: Record<string, boolean>): string[] {
  if (!Array.isArray(raw)) return []
  const want = new Set(raw.map((x) => String(x)))
  return PAID_CHANNELS.filter((ch) => want.has(ch) && live[ch])
}

/** In app is ticked by default and may be unticked: a list without 'in_app' leaves it out. */
export function wantsInApp(raw: unknown): boolean {
  return Array.isArray(raw) ? raw.map(String).includes('in_app') : true
}

export interface Person { uid: string | null; phone: string | null; email: string | null }

/** Who a send reaches on each ticked channel, and what it costs. One phone or address is one message. */
export function explicitCounts(people: Person[], channels: string[], prices: Record<string, number>, inApp = true) {
  const who = new Set<string>(), app = new Set<string>(), phones = new Set<string>(), mails = new Set<string>()
  for (const p of people) {
    const ph = phoneOf(p.phone), em = p.email && looksEmail(p.email) ? p.email.trim().toLowerCase() : ''
    const key = p.uid || ph || em
    if (!key) continue
    // Counted only when a ticked channel reaches them.
    const reached = (inApp && p.uid) || (ph && (channels.includes('whatsapp') || channels.includes('sms'))) || (em && channels.includes('email'))
    if (reached) who.add(key)
    if (p.uid) app.add(p.uid)
    if (ph) phones.add(ph)
    if (em) mails.add(em)
  }
  const by: Record<string, number> = {
    in_app: inApp ? app.size : 0,
    whatsapp: channels.includes('whatsapp') ? phones.size : 0,
    sms: channels.includes('sms') ? phones.size : 0,
    email: channels.includes('email') ? mails.size : 0,
  }
  const cost = by.whatsapp * (prices.whatsapp ?? 0) + by.sms * (prices.sms ?? 0) + by.email * (prices.email ?? 0)
  return { recipients: who.size, by_channel: by, estimated_cost_paise: cost }
}

/** Staff → Privacy "primary guardian only": the guardian-link filter for alerts
    (absence, fees). `sg` is student_guardians. A child with no primary on record
    still reaches every linked adult, as fee reminders always did. */
export const ALERT_GUARDIANS = `(sg.is_primary
    OR NOT (SELECT i.alerts_primary_only FROM institutions i WHERE i.id = sg.institution_id)
    OR NOT EXISTS (SELECT 1 FROM student_guardians p WHERE p.student_id = sg.student_id AND p.is_primary AND NOT p.portal_blocked))`

/** Message types that follow the Privacy rule; everything else (circulars) goes to every linked parent. */
export const ALERT_TYPES = new Set(['absence', 'fees', 'attendance'])

/* Yajur Connect sends only the school's approved templates (owner, 2026-11-20:
   a free-text message outside WhatsApp's 24-hour window is refused, 131047).
   Each screen's message has its Connect template; the blanks are filled from
   whatever the message already carries. */
export const CONNECT_FOR: Record<string, string> = {
  fees: 'connect_fee_reminder',
  absence: 'connect_attendance_absent',
  present: 'connect_general_circular',
  notice: 'connect_general_circular',
}
/** ERP template codes whose WhatsApp copy is a Connect template when they have no mapping of their own. */
export const CONNECT_ALIAS: Record<string, string> = {
  'fees.overdue': 'connect_fee_reminder',
  'announcement.published': 'connect_general_circular',
  'attendance.absent': 'connect_attendance_absent',
}

/** Is this Connect template set up (active, with an approved name)? */
export async function connectReady(db: D1Database, code: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 FROM message_templates WHERE code = ? AND channel = 'whatsapp' AND is_active = 1 AND trim(coalesce(wa_template_name,'')) <> ''`).bind(code).first())
}

/** The Connect templates' blank names, filled from the names the ERP's messages use. */
export function connectVars(vars: Record<string, unknown>): Record<string, unknown> {
  const pick = (...ks: string[]) => {
    for (const k of ks) { const v = vars[k]; if (v !== undefined && v !== null && String(v).trim() !== '') return v }
    return undefined
  }
  const out: Record<string, unknown> = { ...vars }
  const set = (k: string, v: unknown) => { if (v !== undefined) out[k] = v }
  set('parent_name', pick('parent_name', 'guardian_name') ?? 'Parent')
  set('student_name', pick('student_name', 'student', 'name'))
  set('class', pick('class', 'class_name') ?? '-')
  set('date', pick('date', 'on_date'))
  set('due_date', pick('due_date', 'due_on'))
  set('amount', pick('amount', 'amount_due'))
  set('fee_name', pick('fee_name') ?? 'School fee')
  set('message', pick('message', 'text', 'body'))
  return out
}
