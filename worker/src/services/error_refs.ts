import type { Env } from '../env'
import type { Identity } from '../identity'

/* ERROR REFERENCE CODES.

   An unexpected error used to answer {"error":"internal"} and leave a line in
   the Worker's log that nobody at a school can see and nobody at the desk can
   find. Now each one gets a six-character reference: it goes back in the JSON
   and in X-Error-Ref, the screen shows "Ref: K7Q2X9" with a copy button, and
   CONTROL.error_refs holds what happened (route, school, user, role, message)
   for 14 days. A help request carrying the code opens straight onto that row
   at the desk.

   The alphabet leaves out 0, O, 1, I and L: the code is read down a phone. */

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ERROR_REF = /^[A-HJ-NP-Z2-9]{6}$/
export const ERROR_REF_DAYS = 14

export function newErrorRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return s
}

/** Uppercased and checked; null when it is not a reference this Worker could have issued. */
export function cleanErrorRef(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return ERROR_REF.test(s) ? s : null
}

/** Ids and long numbers taken out of a path, so the same screen groups together. */
export function routeShape(pathname: string): string {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')
    .replace(/\/\d{3,}(?=\/|$)/g, '/{n}')
    .slice(0, 200)
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    return `${err.name}: ${err.message}${cause ? ` (${String(cause)})` : ''}`.slice(0, 1000)
  }
  return String(err ?? 'unknown').slice(0, 1000)
}

export interface ErrorRefRow {
  code: string; at: string; institution_id: string | null; user_id: string | null; user_name: string | null
  role: string | null; method: string; route: string; message: string; release: string | null
}

/** Writes the row; never throws (the caller is already answering a failure). */
export async function recordErrorRef(env: Env, code: string, req: Request, pathname: string, id: Identity | null | undefined, err: unknown): Promise<void> {
  try {
    await env.CONTROL.prepare(`INSERT OR IGNORE INTO error_refs (code, at, institution_id, user_id, user_name, role, method, route, message, release)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(code, new Date().toISOString(), id?.institution?.id ?? null, id?.userId ?? null, id?.fullName ?? null,
        id?.roles?.[0] ?? null, req.method, routeShape(pathname), messageOf(err),
        req.headers.get('x-app-version')?.slice(0, 40) ?? null).run()
  } catch (e) { console.error('error_refs not recorded', e) }
}

export async function errorRef(env: Env, code: string): Promise<ErrorRefRow | null> {
  return env.CONTROL.prepare(`SELECT * FROM error_refs WHERE code = ?`).bind(code).first<ErrorRefRow>().catch(() => null)
}

/** Housekeeping: references older than ERROR_REF_DAYS go. */
export async function pruneErrorRefs(env: Env): Promise<number> {
  const before = new Date(Date.now() - ERROR_REF_DAYS * 86_400_000).toISOString()
  const r = await env.CONTROL.prepare(`DELETE FROM error_refs WHERE at < ?`).bind(before).run()
  return r.meta.changes ?? 0
}
