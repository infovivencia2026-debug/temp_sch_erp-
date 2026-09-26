import { HttpError, bool, now, uuid } from '../../http'

/* Helpers shared by the admissions and HR ports. Everything here mirrors a
   small Go helper (daterange.go, fees.NextNumber, working_year.go,
   custom_options.go) so the handlers can stay close to their originals. */

/** Rule 7 stub: a side effect that leaves the database is not implemented. */
export const notImplemented = (what: string) => new HttpError(501, `not implemented in the worker: ${what}`)

// --- India time ---------------------------------------------------------------

const IST_MIN = 330
/** A Date whose UTC fields read as the Indian wall clock. Use ymd()/hm() on it, never toISOString() for storage. */
export function nowIST(): Date { return new Date(Date.now() + IST_MIN * 60_000) }
export const ymd = (d: Date) => d.toISOString().slice(0, 10)
export const todayIST = () => ymd(nowIST())
/** SQLite modifier that turns a stored UTC timestamp into Indian wall-clock time. */
export const IST = `'+330 minutes'`
/** date(col) in India, for a stored UTC timestamp. */
export const istDate = (col: string) => `date(${col}, ${IST})`
export const istMinute = (col: string) => `strftime('%Y-%m-%d %H:%M', ${col}, ${IST})`
export const istMinuteT = (col: string) => `strftime('%Y-%m-%dT%H:%M', ${col}, ${IST})`
export const istClock = (col: string) => `strftime('%H:%M', ${col}, ${IST})`

export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return ymd(d)
}
export function addMonths(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() + n)
  return ymd(d)
}
export const isYMD = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
export const isHHMM = (s: string) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function longDate(day: string): string {
  const d = new Date(day + 'T00:00:00Z')
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`
}

export interface DateRange { from: string; to: string; label: string; period: string }

/** Port of resolveRange (daterange.go): ?period= or ?from=&to=, resolved in India. */
export function resolveRange(q: URLSearchParams): DateRange {
  const today = todayIST()
  const f = q.get('from') ?? '', t = q.get('to') ?? ''
  if (f && t && isYMD(f) && isYMD(t)) {
    const [from, to] = t < f ? [t, f] : [f, t]
    return { from, to, period: 'custom', label: `${longDate(from)} to ${longDate(to)}` }
  }
  let period = q.get('period') ?? ''
  if (period === '') period = 'this_month'
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7))
  const monthStart = today.slice(0, 8) + '01'
  const junStart = (yr: number) => `${yr}-06-01`
  const ayStart = m < 6 ? junStart(y - 1) : junStart(y)
  const mk = (from: string, to: string, label: string) => ({ from, to, label, period })
  switch (period) {
    case 'today': return mk(today, today, 'Today')
    case 'yesterday': { const d = addDays(today, -1); return mk(d, d, 'Yesterday') }
    case 'last_7': return mk(addDays(today, -6), today, 'Last 7 days')
    case 'last_30': return mk(addDays(today, -29), today, 'Last 30 days')
    case 'this_week': {
      const dow = new Date(today + 'T00:00:00Z').getUTCDay()
      const off = (dow + 6) % 7
      return mk(addDays(today, -off), today, 'This week')
    }
    case 'last_month': {
      const first = addMonths(monthStart, -1)
      const d = new Date(first + 'T00:00:00Z')
      return mk(first, addDays(monthStart, -1), `Last month - ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`)
    }
    case 'this_quarter': {
      const qm = Math.floor((m - 1) / 3) * 3 + 1
      return mk(`${y}-${String(qm).padStart(2, '0')}-01`, today, 'This quarter')
    }
    case 'this_term': return mk(ayStart, today, 'This term')
    case 'this_year': return mk(ayStart, today, `This academic year - ${ayStart.slice(0, 4)}-${String(Number(ayStart.slice(0, 4)) + 1).slice(2)}`)
    case 'last_year': {
      const s = addMonths(ayStart, -12)
      return mk(s, addDays(ayStart, -1), `Last academic year - ${s.slice(0, 4)}-${String(Number(s.slice(0, 4)) + 1).slice(2)}`)
    }
    case 'fin_year': { const s = m < 4 ? `${y - 1}-04-01` : `${y}-04-01`; return mk(s, today, 'This financial year') }
    default: {
      const d = new Date(today + 'T00:00:00Z')
      return { from: monthStart, to: today, period: 'this_month', label: `This month - ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
    }
  }
}

// --- small value helpers --------------------------------------------------------

/** Go nullString: "" -> NULL. */
export const nz = (s: unknown): string | null => (typeof s === 'string' && s.trim() !== '' ? s : null)
export const trimNz = (s: unknown): string | null => (typeof s === 'string' && s.trim() !== '' ? s.trim() : null)
export const str = (s: unknown): string => (typeof s === 'string' ? s : '')
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const intOr = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : def)
export const isUUIDish = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
export const b = bool
export const oneOfStr = (v: string, ...allowed: string[]) => allowed.includes(v)
export const round2 = (f: number) => Math.round(f * 100) / 100
export const round1 = (f: number) => Math.round(f * 10) / 10
export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)
/** `IN (${placeholders(n)})` binds ONE parameter: js(ids). D1 caps a statement at 100 parameters. */
export const placeholders = (_n?: number) => 'SELECT value FROM json_each(?)'
export const js = (ids: readonly unknown[]): string => JSON.stringify(ids)
export function parseJSON<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}
/** `concat_ws(' ', a, b)`: names joined, blanks dropped. */
export const fullName = (...cols: string[]) =>
  `TRIM(${cols.map((c, i) => (i === 0 ? `COALESCE(${c},'')` : `COALESCE(' ' || NULLIF(${c},''), '')`)).join(' || ')})`
export const nullIfBlank = (expr: string) => `NULLIF(${expr},'')`
export const initcap = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase())

/** SQLite has no unique-violation class the way pgx exposes it; D1 surfaces the message. */
export const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed|constraint failed: UNIQUE/i.test(e.message)

export interface Option { value: string; label: string }

// --- the customisable vocabularies (custom_options.go) ---------------------------

/** Every kind a school may extend. Built-in lists are only carried where a handler here needs them. */
export const customisableKinds: Record<string, Option[]> = {
  affiliation_board: [], school_category: [], management_type: [], medium: [], religion: [], mother_tongue: [],
  caste_category: [], blood_group: [], document_type: [], subject_type: [], fee_head_type: [], staff_designation: [],
  leaving_reason: [], concession_reason: [], state: [], district: [], employee_type: [], qualification: [],
  department_type: [], room_type: [], vehicle_type: [], stop_landmark: [], item_category: [], book_category: [],
  hostel_block_type: [], visitor_purpose: [], complaint_type: [], activity_type: [], exam_type: [], lead_source: [],
  relation: [], nationality: [], payment_mode: [], expense_head: [], health_condition: [], achievement_type: [],
  absence_reason: [],
  lost_reason: [
    { value: 'fees', label: 'Fees too high' },
    { value: 'distance', label: 'Distance from home' },
    { value: 'seat_unavailable', label: 'No seat available' },
    { value: 'chose_another_school', label: 'Chose another school' },
    { value: 'no_response', label: 'No response from parent' },
  ],
}

export async function optionsForKind(db: D1Database, kind: string): Promise<Option[]> {
  const out: Option[] = [...(customisableKinds[kind] ?? [])]
  const rows = await db.prepare(`SELECT value, label FROM custom_options WHERE kind = ? AND active = 1 ORDER BY sequence, label`).bind(kind).all<Option>()
  return out.concat(rows.results)
}

export async function allowsValue(db: D1Database, kind: string, value: string): Promise<boolean> {
  if (value === '') return true
  return (await optionsForKind(db, kind)).some((o) => o.value === value)
}

/** optionValue (custom_options.go): a stored value derived from a label. */
export function optionValue(label: string): string {
  let out = ''
  let prevDash = false
  for (const ch of label.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) { out += ch; prevDash = false }
    else if (!prevDash && out.length > 0) { out += '_'; prevDash = true }
  }
  return out.replace(/_+$/, '')
}

// --- numbering (internal/fees NextNumber) ---------------------------------------

export function financialYear(day: string): string {
  let y = Number(day.slice(0, 4))
  if (Number(day.slice(5, 7)) < 4) y--
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

function renderNumber(format: string, prefix: string, fy: string, seq: number, padding: number, suffix: string): string {
  if (format === '') format = '{prefix}{fy}/{seq}{suffix}'
  if (fy === '') for (const d of ['{fy}/', '{fy}-', '/{fy}', '-{fy}']) format = format.split(d).join('')
  return format.split('{prefix}').join(prefix).split('{fy}').join(fy)
    .split('{seq}').join(String(seq).padStart(padding, '0')).split('{suffix}').join(suffix)
}

interface Scheme { prefix: string; suffix: string; padding: number; next_value: number; reset_yearly: number; current_fy: string | null; format: string }

/**
 * Port of fees.NextNumber. The per-year counter is advanced with one atomic
 * UPDATE ... RETURNING, so two callers cannot draw the same serial; unlike the
 * Postgres version the draw is not rolled back if the caller's later write fails.
 */
export async function nextNumber(db: D1Database, inst: string, kind: string, on = todayIST()): Promise<string> {
  const defaults: Record<string, string> = { receipt: 'RCPT/', invoice: 'INV/' }
  let s = await db.prepare(`SELECT prefix, suffix, padding, next_value, reset_yearly, current_fy, format FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(inst, kind).first<Scheme>()
  if (!s) {
    await db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, padding, next_value, reset_yearly, updated_at) VALUES (?,?,?,?,5,1,1,?)`)
      .bind(uuid(), inst, kind, defaults[kind] ?? '', now()).run()
    s = (await db.prepare(`SELECT prefix, suffix, padding, next_value, reset_yearly, current_fy, format FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(inst, kind).first<Scheme>())!
  }
  let seq = s.next_value
  let fy = ''
  if (s.reset_yearly) {
    fy = financialYear(on)
    let seed = 1
    if (!s.current_fy || s.current_fy === fy) seed = s.next_value
    else if (kind === 'receipt') {
      const last = await db.prepare(`SELECT max(receipt_seq) AS n FROM payments WHERE institution_id = ? AND receipt_fy = ?`).bind(inst, fy).first<{ n: number | null }>()
      if (last?.n != null) seed = last.n + 1
    }
    await db.prepare(`INSERT OR IGNORE INTO numbering_fy_counters (institution_id, kind, fy, next_value) VALUES (?,?,?,?)`).bind(inst, kind, fy, seed).run()
    const drawn = await db.prepare(`UPDATE numbering_fy_counters SET next_value = next_value + 1 WHERE institution_id = ? AND kind = ? AND fy = ? RETURNING next_value`)
      .bind(inst, kind, fy).first<{ next_value: number }>()
    seq = (drawn?.next_value ?? seed + 1) - 1
  }
  const text = renderNumber(s.format, s.prefix, fy, seq, s.padding, s.suffix)
  if (!s.reset_yearly || !s.current_fy || s.current_fy <= fy) {
    await db.prepare(`UPDATE numbering_schemes SET next_value = ?, current_fy = NULLIF(?,''), last_number = ?, last_issued_at = ?, updated_at = ? WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`)
      .bind(seq + 1, fy, text, now(), now(), inst, kind).run()
  } else {
    await db.prepare(`UPDATE numbering_schemes SET last_number = ?, last_issued_at = ?, updated_at = ? WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`)
      .bind(text, now(), now(), inst, kind).run()
  }
  return text
}

// --- the working year (working_year.go) -------------------------------------------

export const errUnknownYear = () => new HttpError(400, 'academic_year_id names no year of this school')

/** The year the caller works in: named explicitly, else their chosen working year, else the current/latest one. */
export async function workingYear(db: D1Database, userId: string, explicit = ''): Promise<string> {
  explicit = explicit.trim()
  if (explicit !== '') {
    if (!isUUIDish(explicit)) throw errUnknownYear()
    const row = await db.prepare(`SELECT id FROM academic_years WHERE id = ?`).bind(explicit).first<{ id: string }>()
    if (!row) throw errUnknownYear()
    return row.id
  }
  const mine = await db.prepare(`SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?`).bind(userId).first<{ id: string }>()
  if (mine) return mine.id
  const latest = await db.prepare(`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<{ id: string }>()
  if (!latest) throw new HttpError(400, 'this school has no academic year yet')
  return latest.id
}

/** workingYearSQL: the same fallback chain as an expression; binds the caller's user id once. */
export const workingYearSQL = `COALESCE(
  (SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?),
  (SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1))`

// --- module settings ----------------------------------------------------------------

export async function moduleConfig(db: D1Database, module: string): Promise<Record<string, unknown>> {
  const row = await db.prepare(`SELECT config FROM module_settings WHERE module = ?`).bind(module).first<{ config: string }>()
  return parseJSON<Record<string, unknown>>(row?.config, {})
}

/** `config = config || EXCLUDED.config` on (institution_id, module). */
export function mergeModuleConfig(db: D1Database, inst: string, module: string, patch: Record<string, unknown>): D1PreparedStatement {
  return db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, ?, 1, json(?))
    ON CONFLICT (institution_id, module) DO UPDATE SET config = json_patch(module_settings.config, excluded.config)`)
    .bind(inst, module, JSON.stringify(patch))
}
