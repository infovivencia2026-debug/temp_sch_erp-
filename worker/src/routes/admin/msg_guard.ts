import type { Ctx } from '../../router'
import { parseJSON } from './common'

/* The recipient guard of internal/api/whatsapp.go: loadRecipientGuard,
   permits, normaliseRecipient and waNormalisePhone. */

export interface Guard { mode: string; allowed: Set<string>; unguarded: Set<string> }

export async function loadGuard(c: Ctx): Promise<Guard> {
  const g: Guard = { mode: 'everyone', allowed: new Set(), unguarded: new Set() }
  const row = await c.db.prepare(`SELECT mode, unguarded_channels FROM messaging_recipient_policy`).first<{ mode: string; unguarded_channels: string | null }>()
  if (row) {
    g.mode = row.mode
    const ug = parseJSON<unknown>(row.unguarded_channels, [])
    if (Array.isArray(ug)) for (const ch of ug) if (typeof ch === 'string') g.unguarded.add(ch)
  }
  if (g.mode === 'everyone') return g
  const rows = await c.db.prepare(`SELECT kind, normalised FROM messaging_allowed_recipients`).all<{ kind: string; normalised: string }>()
  for (const r of rows.results) g.allowed.add(`${r.kind}:${r.normalised}`)
  return g
}

/** waNormalisePhone: an Indian number to E.164 digits without the plus, or '' when unreadable. */
export function normalisePhone(raw: string): string {
  let s = raw.replace(/[^0-9]/g, '')
  if (s === '') return ''
  if (s.startsWith('00')) s = s.slice(2)
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1)
  if (s.length === 10) return s[0] < '6' ? '' : '91' + s
  if (s.length >= 11 && s.length <= 15) return s
  return ''
}

export function normaliseRecipient(v: string): string {
  v = v.trim()
  if (v === '') return ''
  if (v.includes('@')) return 'email:' + v.toLowerCase()
  const n = normalisePhone(v)
  return n === '' ? '' : 'phone:' + n
}

export function permits(g: Guard, channel: string, recipient: string): [boolean, string] {
  if (channel === 'in_app' || g.mode === 'everyone' || g.unguarded.has(channel)) return [true, '']
  const key = normaliseRecipient(recipient)
  if (key === '') return [false, 'not on the allowlist. The recipient could not be read as a number or an address']
  if (g.allowed.has(key)) return [true, '']
  if (g.allowed.size === 0) return [false, 'not on the allowlist. This school is in allowlist mode and the list is empty, so nothing is being sent to anybody']
  return [false, 'not on the allowlist']
}
