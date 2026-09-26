import type { Ctx } from '../../router'
import { now as nowISO, uuid } from '../../http'

/* The pieces of bus_tracker.go that the office screens and the handset
   routes both read: the tracking policy, the trip-timeout clamp, the
   great-circle distance and the bus-code normaliser. The office's policy
   screen itself is ops/transport.ts's handler, reached through a private
   router (see transport_office.ts); this reader exists because the handset
   path has no Ctx of its own and ops/transport.ts does not export one. */

export interface TrackingPolicy {
  defaultGeofenceM: number; speedLimitKmph: number; speedingHoldSecs: number; tripTimeoutMins: number; pingSeconds: number
  parentsMayWatch: boolean; watchWindowMins: number; retainDays: number
  schoolLat: number | null; schoolLon: number | null; schoolGeofenceM: number | null
}

/** trackingPolicyFor: the school's settings, created with the schema defaults on first read. */
export async function trackingPolicyIn(db: D1Database, inst: string): Promise<TrackingPolicy> {
  const q = db.prepare(`SELECT default_geofence_m, speed_limit_kmph, speeding_hold_secs, trip_timeout_mins, ping_seconds, parents_may_watch,
      watch_window_mins, retain_days, school_latitude, school_longitude, school_geofence_m FROM transport_tracking_policy WHERE institution_id = ?`).bind(inst)
  type Row = { default_geofence_m: number; speed_limit_kmph: number; speeding_hold_secs: number; trip_timeout_mins: number; ping_seconds: number
    parents_may_watch: number; watch_window_mins: number; retain_days: number; school_latitude: string | null; school_longitude: string | null; school_geofence_m: number | null }
  let row = await q.first<Row>()
  if (!row) {
    await db.prepare(`INSERT OR IGNORE INTO transport_tracking_policy (institution_id, updated_at) VALUES (?, ?)`).bind(inst, nowISO()).run()
    row = await q.first<Row>()
    if (!row) throw new Error('tracking policy could not be created')
  }
  return {
    defaultGeofenceM: row.default_geofence_m, speedLimitKmph: row.speed_limit_kmph, speedingHoldSecs: row.speeding_hold_secs,
    tripTimeoutMins: row.trip_timeout_mins, pingSeconds: row.ping_seconds, parentsMayWatch: !!row.parents_may_watch,
    watchWindowMins: row.watch_window_mins, retainDays: row.retain_days,
    schoolLat: row.school_latitude === null ? null : Number(row.school_latitude),
    schoolLon: row.school_longitude === null ? null : Number(row.school_longitude), schoolGeofenceM: row.school_geofence_m,
  }
}
export const trackingPolicy = (c: Ctx, inst: string) => trackingPolicyIn(c.db, inst)

/** clampTripTimeoutMins (bus_tracker_jobs.go). */
export function clampTripTimeoutMins(mins: number | null | undefined): number {
  if (!mins || mins <= 0) return 20
  if (mins < 5) return 5
  if (mins > 240) return 240
  return mins
}

/** metresBetween: haversine. */
export function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8, rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)))
}

/** normaliseBusCode: upper case, punctuation and spaces dropped. */
export const normaliseBusCode = (code: unknown): string => (typeof code === 'string' ? code.trim().toUpperCase().replace(/[^A-Za-z0-9]/g, '') : '')

/** legForDirection: the attendance table's half of the day. */
export const legFor = (direction: string) => (direction === 'drop' ? 'afternoon' : 'morning')

/** SHA-256 of the upper-cased, trimmed code, as the pair-code hash column holds it. */
export async function hashPairCode(code: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.trim().toUpperCase()))
}

/** AES-256-GCM under SHA-256(CREDENTIAL_KEY), nonce || ciphertext || tag: sealSecret / openSecret in messaging.go. */
async function credentialKey(key: unknown, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (typeof key !== 'string' || key.trim() === '') throw new Error('CREDENTIAL_KEY is not set')
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage])
}
export async function sealSecret(key: unknown, plain: string): Promise<ArrayBuffer> {
  const k = await credentialKey(key, 'encrypt')
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, new TextEncoder().encode(plain)))
  const out = new Uint8Array(12 + sealed.length)
  out.set(nonce, 0)
  out.set(sealed, 12)
  return out.buffer
}
export async function openSecret(key: unknown, sealed: ArrayBuffer | Uint8Array | number[] | null): Promise<string> {
  if (!sealed) return ''
  const bytes = sealed instanceof Uint8Array ? sealed : Array.isArray(sealed) ? new Uint8Array(sealed) : new Uint8Array(sealed)
  if (bytes.length === 0) return ''
  if (bytes.length < 12) throw new Error('stored credential is truncated')
  const k = await credentialKey(key, 'decrypt')
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, k, bytes.slice(12))
  return new TextDecoder().decode(plain)
}

/** base64.RawURLEncoding of 32 random bytes. */
export function randomSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** subtle.ConstantTimeCompare over two strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export const newId = uuid
