import type { Ctx } from '../../router'
import { badRequest, isUUID } from '../../http'

/* SQL and JSON helpers shared by the comms, classroom, messaging and SMS
   gateway ports (comms.go, classroom.go, messaging_direct.go, sms_gateway.go).
   Scope, permission checks, notifyStmt and notImplemented come from
   teaching/common.ts and are not repeated here. */

/** to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z' on an ISO text column; NULL stays NULL. */
export const isoZ = (col: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`

/** to_char(date,'YYYY-MM-DD'). */
export const ymdOf = (col: string) => `substr(${col}, 1, 10)`

/** concat_ws(' ', a.first_name, a.last_name): NULLs skipped, never NULL itself. */
export const firstLast = (a: string) =>
  `(COALESCE(${a}.first_name, '') || CASE WHEN ${a}.first_name IS NOT NULL AND ${a}.last_name IS NOT NULL THEN ' ' ELSE '' END || COALESCE(${a}.last_name, ''))`

/** NULLIF(concat_ws('-', c.name, sec.name), ''). */
export const classDash = (c: string, sec: string) =>
  `NULLIF(COALESCE(${c}.name, '') || CASE WHEN ${c}.name IS NOT NULL AND ${sec}.name IS NOT NULL THEN '-' ELSE '' END || COALESCE(${sec}.name, ''), '')`

/** Hours from b to a, rounded like Postgres (x)::int. */
export const hoursBetween = (a: string, b: string) => `CAST(ROUND((julianday(${a}) - julianday(${b})) * 24) AS INTEGER)`

/** Drops the keys whose value is null or undefined: Go's `omitempty` on a nil pointer. */
export function omitNull<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

/** strings.TrimSpace on an optional JSON string. */
export const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** NULLIF(trim(x), '') for a bind. */
export const nz = (v: unknown): string | null => { const t = trim(v); return t === '' ? null : t }

/** A *string field: null when absent, the value (untrimmed) otherwise. */
export const optStr = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** An optional number field as an integer, or null. */
export const optInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null

/** An optional bool field, or null. */
export const optBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

/** A uuid.UUID body field: absent is uuid.Nil (''), anything unparsable fails decoding as Go's would. */
export function bodyUUID(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string' || !isUUID(v)) throw badRequest('malformed JSON body')
  return v.toLowerCase() === '00000000-0000-0000-0000-000000000000' ? '' : v
}

/** A *uuid.UUID body field: null when absent, 400 when malformed. */
export function bodyUUIDPtr(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || !isUUID(v)) throw badRequest('malformed JSON body')
  return v
}

/** queryUUID in classroom.go: absent is null, malformed is a 400 naming the parameter. */
export function queryUUID(c: Ctx, name: string): string | null {
  const raw = (c.url.searchParams.get(name) ?? '').trim()
  if (raw === '') return null
  if (!isUUID(raw)) throw badRequest(`${name} is not a valid id`)
  return raw
}

/** Go's time.Parse("2006-01-02", s): a real calendar date. */
export function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Go's truncate in messaging.go: trim, then cut to n bytes. */
export function truncate(s: string, n: number): string {
  s = s.trim()
  const b = new TextEncoder().encode(s)
  if (b.length <= n) return s
  return new TextDecoder().decode(b.slice(0, n))
}

/** `IN (${qs(ids)})` binds ONE parameter: js(ids). */
export const qs = (_ids?: readonly unknown[]) => 'SELECT value FROM json_each(?)'
/** The single parameter a qs() list binds (D1 caps a statement at 100 parameters). */
export const js = (ids: readonly unknown[]): string => JSON.stringify(ids)

/** D1 hands a BLOB back as an array of numbers, a view or an ArrayBuffer. */
export function toBytes(v: unknown): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (Array.isArray(v)) return Uint8Array.from(v as number[])
  if (typeof v === 'string') {
    const m = /^\\x([0-9a-f]*)$/i.exec(v)
    if (m) return Uint8Array.from(m[1].match(/../g) ?? [], (h) => parseInt(h, 16))
    return new TextEncoder().encode(v)
  }
  return new Uint8Array(0)
}

/** A uuid[] column held as JSON text (or a leftover Postgres '{a,b}' literal). */
export function uuidArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const t = raw.trim()
  if (t.startsWith('[')) {
    try { const v = JSON.parse(t); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
  }
  return []
}

/** math.Round(v*100)/100. */
export const round2 = (v: number) => (Math.sign(v) * Math.round(Math.abs(v) * 100)) / 100 || 0
