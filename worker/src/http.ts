import { json } from './env'

/* Response helpers shared by every ported route. Status codes and error
   shapes match internal/httpx so the web client's ApiError keeps working:
   errors are {"error": "<message>"} with the HTTP status carrying the kind. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message) }
}
export const badRequest = (m: string, extra?: Record<string, unknown>) => new HttpError(400, m, extra)
export const unauthorized = (m = 'unauthorized') => new HttpError(401, m)
export const forbidden = (m = 'forbidden') => new HttpError(403, m)
export const notFound = (m = 'not found') => new HttpError(404, m)
export const conflict = (m: string) => new HttpError(409, m)
export const unprocessable = (m: string, extra?: Record<string, unknown>) => new HttpError(422, m, extra)

/* D1/SQLite constraint failures are the caller's fault, not ours: map them the
   way the Go handlers mapped pgx codes (ledgers.go ledgerRefusal, hr_growth.go):
   23503 FK -> 400, 23505 unique -> 409, 23514 check / 23502 not null -> 400. */
function constraintRefusal(err: unknown): { status: number; message: string } | null {
  const msg = err instanceof Error ? `${err.message} ${(err as { cause?: unknown }).cause ?? ''}` : String(err ?? '')
  if (msg.includes('FOREIGN KEY constraint failed')) return { status: 400, message: 'that refers to something which does not exist' }
  let m = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/.exec(msg)
  if (m || msg.includes('UNIQUE constraint failed')) return { status: 409, message: 'that already exists' + (m ? ': ' + m[1] : '') }
  m = /CHECK constraint failed: ?([\w.]*)/.exec(msg)
  if (m) return { status: 400, message: 'that entry breaks a rule' + (m[1] ? ': ' + m[1] : '') }
  m = /NOT NULL constraint failed: ([\w.]+)/.exec(msg)
  if (m) return { status: 400, message: `${m[1]} is required` }
  return null
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status)
  const refused = constraintRefusal(err)
  if (refused) return json({ error: refused.message }, refused.status)
  console.error(err)
  return json({ error: 'internal' }, 500)
}

export const ok = (body: unknown = { ok: true }) => json(body)
export const created = (body: unknown) => json(body, 201)
export const noContent = () => new Response(null, { status: 204 })

/** Parses a JSON body; a missing or malformed one is a 400. */
export async function readJSON<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return (await req.json()) as T } catch { throw badRequest('malformed JSON body') }
}

export function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = v === null || v === '' ? NaN : Number(v)
  if (!Number.isInteger(n)) return def
  return Math.min(max, Math.max(min, n))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isUUID = (s: unknown): s is string => typeof s === 'string' && UUID.test(s)
export function uuidParam(v: string | undefined, name = 'id'): string {
  if (!isUUID(v)) throw badRequest(`${name} must be a uuid`)
  return v
}
/** A uuid query parameter, or null when absent or malformed (the Go handlers ignore malformed ones). */
export const uuidQuery = (v: string | null): string | null => (isUUID(v) ? v : null)

export const now = () => new Date().toISOString()
export const uuid = () => crypto.randomUUID()

/** Postgres wrote `t`/`f` and true/false; SQLite holds 0/1. Both directions in one place. */
export const bool = (v: unknown): boolean => v === 1 || v === true || v === '1' || v === 't' || v === 'true'
export const int = (b: unknown): number => (bool(b) ? 1 : 0)

/** Page shape the client reads: {items, total, next_cursor?}. */
export interface Page<T> { items: T[]; total: number; limit: number; offset: number }
export const page = <T>(items: T[], total: number, limit: number, offset: number): Page<T> => ({ items, total, limit, offset })

/** Builds `LIKE` search text: the caller's words wrapped for a case-insensitive contains match. */
export const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`
