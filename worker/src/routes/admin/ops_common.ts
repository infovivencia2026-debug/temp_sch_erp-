import type { Ctx } from '../../router'
import { HttpError, badRequest, forbidden, isUUID, notFound } from '../../http'

/* Helpers for the /admin-ops, /admin messaging and connector ports. Nothing
   here is a route. */

/** refusal in the Go code: a 400 whose message is a sentence for the person. */
export const refuse = (m: string) => badRequest(m)
export const denied = (m: string) => forbidden(m)

/** strings.TrimSpace on a body field that may be absent or not a string. */
export const tr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
/** NULLIF(btrim($x), ''). */
export const nz = (v: unknown): string | null => { const s = tr(v); return s === '' ? null : s }
/** A pointer column: omitted from the JSON when NULL (Go `omitempty` on a *T). */
export const om = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v)
export const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v))
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** time.Parse(time.DateOnly, v): a real calendar date. */
export function isDate(v: string): boolean {
  if (!DATE.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
/** An optional YYYY-MM-DD body field: null when blank, 400 with `msg` when malformed. */
export function optDate(v: unknown, msg: string): string | null {
  const s = tr(v)
  if (s === '') return null
  if (!isDate(s)) throw refuse(msg)
  return s
}
/** aoUUID: a required uuid URL segment. */
export function pathUUID(c: Ctx, key = 'id'): string {
  const v = (c.params[key] ?? '').trim()
  if (!isUUID(v)) throw refuse(`${key} must be a uuid`)
  return v
}
/** aoOptUUID: an optional uuid body field; a malformed one is refused, not dropped. */
export function optUUID(v: unknown): string | null {
  const s = tr(v)
  if (s === '') return null
  if (!isUUID(s)) throw refuse('malformed id: ' + s)
  return s.toLowerCase()
}
/** nullUUIDText on a query parameter: malformed is ignored. */
export const qUUID = (v: string | null): string | null => (v && isUUID(v.trim()) ? v.trim().toLowerCase() : null)
/** nullString on a query parameter. */
export const qStr = (v: string | null): string | null => (v === null || v.trim() === '' ? null : v)

/** Today in India as YYYY-MM-DD (CURRENT_DATE on the Go server, which ran in IST). */
export function todayIST(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)
}

/** formatPaise: ₹123.45 for an error sentence. */
export function fmtPaise(p: number): string {
  let neg = ''
  if (p < 0) { neg = '-'; p = -p }
  return `${neg}₹${Math.trunc(p / 100)}.${String(p % 100).padStart(2, '0')}`
}

/**
 * The next "PR00007"-style number: max trailing digits + 1, padded to five.
 * Postgres took an advisory lock around this; D1 has none, and the unique
 * index on the number column is what stops two clerks landing on the same one.
 */
export async function nextNumber(c: Ctx, table: string, col: string, prefix: string, pad = 5): Promise<string> {
  const rows = await c.db.prepare(`SELECT ${col} AS n FROM ${table}`).all<{ n: string }>()
  let max = 0
  for (const r of rows.results) {
    const m = /([0-9]+)$/.exec(r.n ?? '')
    if (m) { const v = parseInt(m[1], 10); if (v > max) max = v }
  }
  return prefix + String(max + 1).padStart(pad, '0')
}

/** Constraint names the Go handlers turned into sentences, and how SQLite names the same violation. */
const CONSTRAINTS: [RegExp, string][] = [
  [/purchase_orders_no_unique/, 'that purchase order number is already in use'],
  [/purchase_requisitions_no_unique/, 'that requisition number is already in use'],
  [/goods_receipts_no_unique/, 'that GRN number is already in use'],
  [/goods_receipt_lines\.goods_receipt_id/, 'that order line is already on this delivery note'],
  [/purchase_invoice_matches\.(institution_id|vendor_bill_id)/, 'that vendor bill is already matched to an order'],
  [/mdm_monthly_returns_one_per_month/, 'a return already exists for that month'],
  [/mdm_norms\.(institution_id|stage)/, 'a norm is already recorded for that stage from that date'],
  [/mdm_foodgrain_receipts_challan/, 'that challan number has already been recorded'],
  [/evaluation_cycles_one_per_name/, 'a cycle of that name already exists for this year'],
  [/evaluation_invitations_one_per_respondent/, 'that person has already been asked about this member of staff'],
  [/evaluation_reviewees\.(cycle_id|employee_id)/, 'that member of staff is already in this cycle'],
  [/fee_regulatory_filings_one_live/, 'a live filing already exists for that year. Withdraw it before opening another'],
  [/fee_regulatory_filing_lines_one_per_head/, 'that fee head appears twice for the same class and instalment'],
  [/fee_regulatory_filings_no_unique/, 'that filing number is already in use'],
]

/** adminOpsFail: a D1 error that names a known constraint becomes the Go handler's sentence. */
export function opsFail(e: unknown): never {
  if (e instanceof HttpError) throw e
  const msg = e instanceof Error ? e.message : String(e)
  for (const [re, sentence] of CONSTRAINTS) if (re.test(msg)) throw refuse(sentence)
  if (/FOREIGN KEY constraint failed/i.test(msg)) throw refuse('that refers to something which does not exist')
  throw e
}

/** c.db.batch with opsFail on the way out. */
export async function runOps(c: Ctx, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  if (stmts.length === 0) return []
  try { return await c.db.batch(stmts) } catch (e) { opsFail(e) }
}

/** QueryRow(...).Scan on a row that must exist: pgx.ErrNoRows became a 404. */
export async function mustFirst<T>(stmt: D1PreparedStatement): Promise<T> {
  const row = await stmt.first<T>()
  if (!row) throw notFound()
  return row
}

/** A JSON array body field, or []. */
export const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
