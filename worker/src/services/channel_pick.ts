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
