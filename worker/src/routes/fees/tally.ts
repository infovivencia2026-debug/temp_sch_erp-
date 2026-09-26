import type { Router } from '../../router'
import type { Ctx } from '../../router'
import { badRequest, created, notFound, ok, readJSON, isUUID, bool, now, uuid } from '../../http'
import { fin, nowIST, p, str, inList, isDate, rupeesFixed, omitNulls } from './common'
import { school } from '../school'
import { renderTally, type TallyVoucher } from './fileformats'

/* Port of mountTally (internal/api/tally.go): the accountant's Tally export
   inside /finance. The connector half (mountTallyConnector, under /admin) is
   not here.

   What is ported fully: the settings read, the validation, the run list, the
   run recording (tally_export_runs + tally_export_run_vouchers in one batch),
   the confirmation, and the file GET (internal/tally.Render, in
   fileformats.ts renderTally). The export POST
   skips the pre-render step but re-applies every check Render/Validate made
   (company name, at least two lines, no unmapped ledger, no zero line, a
   balanced voucher), so the run history still never records a batch Tally
   would refuse. */

const EXPORT = 'finance.export'
const READ = 'finance.invoices.read'

// --- shapes ------------------------------------------------------------------

interface Settings {
  company_name: string
  default_fy_start_year?: number
  fy_label?: string
  delivery: string
  is_enabled: boolean
  updated_at?: string
  /** internal: default_fy_start_year as the Go *int, before omitempty. */
  fy: number | null
}

interface RunRow {
  id: string
  from_date: string
  to_date: string
  voucher_types: string[]
  company_name: string
  delivery: string
  voucher_count: number
  total_paise: number
  exported_at: string
  exported_by?: string
  confirmed_at?: string
}

interface Unmapped { account_id: string; code: string; name: string; vouchers: number }
interface UnmappedType { voucher_type: string; vouchers: number }
interface Entry { ledger_name: string; amount_paise: number }
interface Voucher { source_id: string; date: string; voucher_type: string; number: string; narration: string; entries: Entry[] }

// --- helpers -----------------------------------------------------------------

/** fyRange: 1 April fy to 31 March fy+1. */
const fyRange = (fy: number): [string, string] => [`${fy}-04-01`, `${fy + 1}-03-31`]
/** fyLabel: 2026 -> "2026-27". */
const fyLabel = (fy: number): string => `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`
/** currentFY in Asia/Kolkata. */
function currentFY(): number {
  const n = nowIST()
  return n.getUTCMonth() + 1 < 4 ? n.getUTCFullYear() - 1 : n.getUTCFullYear()
}

/** parseDate: empty -> fallback; otherwise strict YYYY-MM-DD or null (an error in Go). */
function parseDate(v: string, fallback: string): string | null {
  v = v.trim()
  if (v === '') return fallback
  return isDate(v) ? v : null
}

/** A text[] column came across as either JSON or a '{a,b}' literal. */
function arrOf(raw: unknown): string[] {
  const s = str(raw).trim()
  if (s === '' || s === '{}' || s === '[]') return []
  if (s.startsWith('[')) { try { return (JSON.parse(s) as unknown[]).map(String) } catch { return [] } }
  return s.replace(/^\{|\}$/g, '').split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)
}

/** tallyDeliveries: internal/tally.Providers(), in order. */
const deliveries = () => [
  { key: 'file', label: 'Download XML file', live_push: false },
  { key: 'gateway', label: 'Push to Tally on the LAN (not available)', live_push: false },
]

/** tallyLoadSettings: zero values when the school has not configured it yet. */
async function loadSettings(c: Ctx): Promise<Settings> {
  const row = await c.db.prepare(`SELECT company_name, default_fy_start_year, delivery, is_enabled, updated_at
      FROM tally_connector_settings WHERE institution_id = ?`).bind(school(c).id)
    .first<{ company_name: string | null; default_fy_start_year: number | null; delivery: string; is_enabled: number; updated_at: string | null }>()
  if (!row) return { company_name: '', delivery: 'file', is_enabled: false, fy: null }
  const fy = row.default_fy_start_year === null ? null : Number(row.default_fy_start_year)
  const out: Settings = { company_name: row.company_name ?? '', delivery: row.delivery, is_enabled: bool(row.is_enabled), fy }
  if (fy !== null) { out.default_fy_start_year = fy; out.fy_label = fyLabel(fy) }
  if (row.updated_at) out.updated_at = row.updated_at
  return out
}
/** The JSON the Go tallySettingsRow marshals to (the internal fy field dropped). */
function settingsJSON(s: Settings) {
  const { fy: _fy, ...rest } = s
  return rest
}
const tallyFY = (s: Settings): number => (s.fy !== null ? s.fy : currentFY())

/** tallyPeriod: ?from/?to over the connector's year; a malformed value keeps the default. */
function tallyPeriod(c: Ctx, fy: number): [string, string] {
  let [from, to] = fyRange(fy)
  const f = parseDate(c.url.searchParams.get('from') ?? '', from); if (f !== null) from = f
  const t = parseDate(c.url.searchParams.get('to') ?? '', to); if (t !== null) to = t
  return [from, to]
}

/** tallyTypes: ?types=receipt,payment; empty means every type. */
function tallyTypes(c: Ctx): string[] {
  const raw = (c.url.searchParams.get('types') ?? '').trim()
  if (raw === '') return []
  return raw.split(',').map((x) => x.trim()).filter(Boolean)
}

/** `(cardinality($n) = 0 OR voucher_type = ANY($n))` as SQLite. */
function typesPredicate(types: string[]): { sql: string; args: string[] } {
  if (types.length === 0) return { sql: 'TRUE', args: [] }
  return inList('e.voucher_type', types)
}

interface Gathered {
  vouchers: Voucher[]
  unmapped: Unmapped[]
  unmappedTypes: UnmappedType[]
  total: number
  alreadyExported: Set<string>
}

/** tallyGather: the period's vouchers with the mapping attached, plus what has gone out before. */
async function gather(c: Ctx, from: string, to: string, types: string[], onlyNew: boolean): Promise<Gathered> {
  const inst = school(c).id
  const tp = typesPredicate(types)
  const g: Gathered = { vouchers: [], unmapped: [], unmappedTypes: [], total: 0, alreadyExported: new Set() }

  const prior = await c.db.prepare(`
    SELECT DISTINCT rv.journal_entry_id AS id
      FROM tally_export_run_vouchers rv
      JOIN journal_entries e ON e.id = rv.journal_entry_id
     WHERE rv.institution_id = ? AND e.entry_date BETWEEN ? AND ? AND (${tp.sql})`)
    .bind(inst, from, to, ...tp.args).all<{ id: string }>()
  for (const r of prior.results) g.alreadyExported.add(r.id)

  const rows = await c.db.prepare(`
    SELECT e.id AS entry_id, e.voucher_no, e.voucher_type, e.entry_date, e.narration,
           vt.tally_voucher_type,
           a.id AS acc_id, a.code AS acc_code, a.name AS acc_name, m.tally_ledger_name,
           l.debit_paise, l.credit_paise
      FROM journal_entries e
      JOIN journal_lines  l ON l.entry_id  = e.id AND l.institution_id = e.institution_id
      JOIN ledger_accounts a ON a.id       = l.account_id AND a.institution_id = e.institution_id
      LEFT JOIN tally_ledger_mappings m
             ON m.ledger_account_id = a.id AND m.institution_id = e.institution_id
      LEFT JOIN tally_voucher_type_mappings vt
             ON vt.voucher_type = e.voucher_type AND vt.institution_id = e.institution_id
     WHERE e.institution_id = ? AND e.entry_date BETWEEN ? AND ? AND (${tp.sql})
     ORDER BY e.entry_date, e.voucher_no, l.line_no`)
    .bind(inst, from, to, ...tp.args)
    .all<{ entry_id: string; voucher_no: string; voucher_type: string; entry_date: string; narration: string
      tally_voucher_type: string | null; acc_id: string; acc_code: string; acc_name: string; tally_ledger_name: string | null
      debit_paise: number; credit_paise: number }>()

  const unmappedAcc = new Map<string, Unmapped>()
  const unmappedAccSeen = new Map<string, Set<string>>()
  const unmappedTypes = new Map<string, number>()
  const seenType = new Map<string, Set<string>>()
  let cur: Voucher | null = null

  for (const r of rows.results) {
    if (onlyNew && g.alreadyExported.has(r.entry_id)) continue

    if (r.tally_voucher_type === null) {
      let s = seenType.get(r.voucher_type); if (!s) { s = new Set(); seenType.set(r.voucher_type, s) }
      if (!s.has(r.entry_id)) { s.add(r.entry_id); unmappedTypes.set(r.voucher_type, (unmappedTypes.get(r.voucher_type) ?? 0) + 1) }
    }
    if (r.tally_ledger_name === null) {
      let u = unmappedAcc.get(r.acc_id)
      if (!u) { u = { account_id: r.acc_id, code: r.acc_code, name: r.acc_name, vouchers: 0 }; unmappedAcc.set(r.acc_id, u); unmappedAccSeen.set(r.acc_id, new Set()) }
      const seen = unmappedAccSeen.get(r.acc_id)!
      if (!seen.has(r.entry_id)) { seen.add(r.entry_id); u.vouchers++ }
    }

    if (cur === null || cur.source_id !== r.entry_id) {
      if (cur !== null) g.vouchers.push(cur)
      cur = { source_id: r.entry_id, date: r.entry_date, voucher_type: r.tally_voucher_type ?? '', number: r.voucher_no, narration: r.narration, entries: [] }
    }
    // Tally's sign: negative debit, positive credit.
    cur.entries.push({ ledger_name: r.tally_ledger_name ?? '', amount_paise: p(r.credit_paise) - p(r.debit_paise) })
    g.total += p(r.debit_paise)
  }
  if (cur !== null) g.vouchers.push(cur)

  g.unmapped = [...unmappedAcc.values()]
  // tally.SortUnmapped: most-used first, then by code.
  g.unmapped.sort((a, b) => (a.vouchers !== b.vouchers ? b.vouchers - a.vouchers : a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  for (const [t, n] of unmappedTypes) g.unmappedTypes.push({ voucher_type: t, vouchers: n })
  return g
}

/** tally.Voucher.Validate: the message Render would have refused with, or null. */
function validateVoucher(v: Voucher): string | null {
  if (v.voucher_type.trim() === '') return `voucher ${v.number} has no Tally voucher type: map it on the connector`
  if (v.entries.length < 2) return `voucher ${v.number} has ${v.entries.length} entry/entries: double entry needs at least two`
  for (const e of v.entries) {
    if (e.ledger_name.trim() === '') return `voucher ${v.number} has a line with no Tally ledger name`
    if (e.amount_paise === 0) return `voucher ${v.number} has a zero line against ${e.ledger_name}`
  }
  const b = v.entries.reduce((s, e) => s + e.amount_paise, 0)
  if (b !== 0) return `voucher does not balance: ${v.number} is out by ${rupeesFixed(b)} rupees`
  return null
}

const runRow = (r: Record<string, unknown>): RunRow => omitNulls({
  id: str(r.id),
  from_date: str(r.from_date),
  to_date: str(r.to_date),
  voucher_types: arrOf(r.voucher_types),
  company_name: str(r.company_name),
  delivery: str(r.delivery),
  voucher_count: p(r.voucher_count),
  total_paise: p(r.total_paise),
  exported_at: str(r.exported_at),
  exported_by: (r.full_name as string | null | undefined) ?? null,
  confirmed_at: (r.confirmed_at as string | null) ?? null,
}) as unknown as RunRow

/** tallyRunsOverlapping: prior runs whose period touches this one. */
async function runsOverlapping(c: Ctx, from: string, to: string): Promise<RunRow[]> {
  const rows = await c.db.prepare(`
    SELECT id, from_date, to_date, voucher_types, company_name, delivery, voucher_count, total_paise, exported_at, confirmed_at
      FROM tally_export_runs
     WHERE institution_id = ? AND from_date <= ? AND to_date >= ?
     ORDER BY exported_at DESC LIMIT 10`).bind(school(c).id, to, from).all<Record<string, unknown>>()
  return rows.results.map(runRow)
}

// --- routes ------------------------------------------------------------------

export function registerTally(r: Router): void {
  // getTallyExportSettings: what the screen needs to draw itself.
  r.get('/finance/tally/settings', READ, fin(async (c) => {
    const set = await loadSettings(c)
    const unm = await c.db.prepare(`
      SELECT count(*) AS n FROM ledger_accounts a
        LEFT JOIN tally_ledger_mappings m ON m.ledger_account_id = a.id AND m.institution_id = a.institution_id
       WHERE a.institution_id = ? AND NOT a.is_group AND a.is_active AND m.id IS NULL`)
      .bind(school(c).id).first<{ n: number }>()
    const fy = tallyFY(set)
    const [from, to] = fyRange(fy)
    return ok({
      settings: settingsJSON(set),
      fy,
      fy_label: fyLabel(fy),
      suggested_from: from,
      suggested_to: to,
      unmapped_accounts: unm?.n ?? 0,
      configured: set.company_name !== '',
      deliveries: deliveries(),
      live_push_available: false,
      live_push_note: 'This produces a file you import in Tally Prime, Gateway of ' +
        'Tally, then Import, then Vouchers. There is no direct push: Tally\'s ' +
        'gateway runs on the accountant\'s own machine on the school network, ' +
        'only while Tally is open, and a hosted server cannot reach it.',
    })
  }))

  // validateTallyExport: "may I export this range", recording nothing.
  r.get('/finance/tally/validate', EXPORT, fin(async (c) => {
    const onlyNew = c.url.searchParams.get('include_exported') !== 'true'
    const types = tallyTypes(c)
    const set = await loadSettings(c)
    const [from, to] = tallyPeriod(c, tallyFY(set))
    if (to < from) throw badRequest('the end of the period is before its start')

    const g = await gather(c, from, to, types, onlyNew)
    const blocking: string[] = []
    const warnings: string[] = []
    if (set.company_name.trim() === '') blocking.push('No Tally company is configured. Set it on the Tally connector before exporting.')
    if (g.unmapped.length > 0) blocking.push(`${g.unmapped.length} account(s) in this period have no Tally ledger name. Tally rejects the whole file, not the voucher, so all of them must be mapped first.`)
    if (g.unmappedTypes.length > 0) blocking.push(`${g.unmappedTypes.length} voucher type(s) in this period have no Tally equivalent mapped.`)
    if (g.vouchers.length === 0) blocking.push('There is nothing to export in this period.')
    if (g.alreadyExported.size > 0) warnings.push(`${g.alreadyExported.size} voucher(s) in this range have been exported before. A duplicate import into Tally has to be undone voucher by voucher.`)

    return ok({
      ok: blocking.length === 0,
      blocking,
      warnings,
      company_name: set.company_name,
      from_date: from,
      to_date: to,
      voucher_count: g.vouchers.length,
      total_paise: g.total,
      unmapped_accounts: g.unmapped,
      unmapped_voucher_types: g.unmappedTypes,
      already_exported: g.alreadyExported.size,
      new_vouchers: g.vouchers.length,
      overlapping_runs: await runsOverlapping(c, from, to),
    })
  }))

  // createTallyExport: validates and records what went out. The file comes from the GET below.
  r.post('/finance/tally/export', EXPORT, fin(async (c) => {
    const body = await readJSON<{ from?: string; to?: string; voucher_types?: string[] | null; include_exported?: boolean }>(c.req)
    const set = await loadSettings(c)
    const company = set.company_name.trim()
    if (company === '') throw badRequest('no Tally company is configured; set it on the Tally connector before exporting')

    const [defFrom, defTo] = fyRange(tallyFY(set))
    const from = parseDate(str(body.from), defFrom)
    if (from === null) throw badRequest('from must be a date as YYYY-MM-DD')
    const to = parseDate(str(body.to), defTo)
    if (to === null) throw badRequest('to must be a date as YYYY-MM-DD')
    if (to < from) throw badRequest('the end of the period is before its start')

    const types = Array.isArray(body.voucher_types) ? body.voucher_types.map(String) : []
    const g = await gather(c, from, to, types, !body.include_exported)

    // The blocking check, restated rather than trusted from the validate call.
    if (g.unmapped.length > 0) {
      const names = g.unmapped.slice(0, 3).map((u) => `${u.code} ${u.name}`)
      throw badRequest(`${g.unmapped.length} account(s) have no Tally ledger name (${names.join(', ')}). Tally rejects the whole file, so map them on the connector first`)
    }
    if (g.unmappedTypes.length > 0) throw badRequest(`${g.unmappedTypes.length} voucher type(s) have no Tally equivalent mapped on the connector`)
    if (g.vouchers.length === 0) throw badRequest('there is nothing to export in this period')

    /* tally.Render ran here in Go, before the run was recorded, so a batch it
       refuses never leaves a run behind. The XML itself is not rendered in the
       worker; the checks Render made are. */
    for (const v of g.vouchers) { const msg = validateVoucher(v); if (msg) throw badRequest(msg) }

    const inst = school(c).id
    const runId = uuid()
    const count = g.vouchers.length
    const total = g.total
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO tally_export_runs
          (id, institution_id, from_date, to_date, voucher_types, company_name, delivery, voucher_count, total_paise, exported_by, exported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(runId, inst, from, to, JSON.stringify(types), company, set.delivery, count, total, c.id.userId, now()),
    ]
    // The mark: a row per voucher, so "which run was this in" stays answerable.
    for (const v of g.vouchers) {
      stmts.push(c.db.prepare(`INSERT INTO tally_export_run_vouchers (institution_id, run_id, journal_entry_id) VALUES (?, ?, ?)`).bind(inst, runId, v.source_id))
    }
    await c.db.batch(stmts)

    return created({
      run_id: runId,
      voucher_count: count,
      total_paise: total,
      company_name: company,
      download_url: '/api/v1/finance/tally/runs/' + runId + '/file',
      note: 'Import in Tally Prime: Gateway of Tally, then Import, then Vouchers.',
    })
  }))

  r.get('/finance/tally/runs', READ, fin(async (c) => {
    const rows = await c.db.prepare(`
      SELECT r.id, r.from_date, r.to_date, r.voucher_types, r.company_name, r.delivery, r.voucher_count, r.total_paise,
             r.exported_at, r.confirmed_at, u.full_name
        FROM tally_export_runs r LEFT JOIN users u ON u.id = r.exported_by
       WHERE r.institution_id = ? ORDER BY r.exported_at DESC LIMIT 100`).bind(school(c).id).all<Record<string, unknown>>()
    return ok(rows.results.map(runRow))
  }))

  // downloadTallyExport: re-renders the XML from the vouchers the run pinned,
  // so the bytes are the same every time and nothing is recorded twice.
  r.get('/finance/tally/runs/{id}/file', EXPORT, fin(async (c) => {
    const runId = c.params.id; if (!isUUID(runId)) throw badRequest('invalid run id')
    const inst = school(c).id
    const run = await c.db.prepare(`SELECT company_name, substr(from_date, 1, 10) AS from_date, substr(to_date, 1, 10) AS to_date
        FROM tally_export_runs WHERE id = ? AND institution_id = ?`)
      .bind(runId, inst).first<{ company_name: string; from_date: string; to_date: string }>()
    if (!run) throw notFound()
    const rows = await c.db.prepare(`
      SELECT e.id, e.voucher_no, substr(e.entry_date, 1, 10) AS entry_date, e.narration,
             vt.tally_voucher_type, m.tally_ledger_name, l.debit_paise, l.credit_paise
        FROM tally_export_run_vouchers rv
        JOIN journal_entries  e ON e.id = rv.journal_entry_id
        JOIN journal_lines    l ON l.entry_id = e.id AND l.institution_id = e.institution_id
        JOIN ledger_accounts  a ON a.id = l.account_id AND a.institution_id = e.institution_id
        LEFT JOIN tally_ledger_mappings m ON m.ledger_account_id = a.id AND m.institution_id = e.institution_id
        LEFT JOIN tally_voucher_type_mappings vt ON vt.voucher_type = e.voucher_type AND vt.institution_id = e.institution_id
       WHERE rv.run_id = ? AND rv.institution_id = ?
       ORDER BY e.entry_date, e.voucher_no, l.line_no`).bind(runId, inst).all<Record<string, unknown>>()
    const vouchers: (TallyVoucher & { id: string })[] = []
    let cur: (TallyVoucher & { id: string }) | null = null
    for (const r of rows.results) {
      if (!cur || cur.id !== str(r.id)) {
        cur = { id: str(r.id), date: str(r.entry_date), voucher_type: str(r.tally_voucher_type), number: str(r.voucher_no), narration: str(r.narration), entries: [] }
        vouchers.push(cur)
      }
      cur.entries.push({ ledger_name: str(r.tally_ledger_name), amount_paise: p(r.credit_paise) - p(r.debit_paise) })
    }
    let body: string
    try { body = renderTally(str(run.company_name), vouchers) } catch (e) { throw badRequest((e as Error).message) }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="tally-${run.from_date}-to-${run.to_date}.xml"`,
      },
    })
  }))

  // confirmTallyExport: the accountant saying the file reached Tally.
  r.post('/finance/tally/runs/{id}/confirm', EXPORT, fin(async (c) => {
    const runId = c.params.id; if (!isUUID(runId)) throw badRequest('invalid run id')
    const res = await c.db.prepare(`UPDATE tally_export_runs SET confirmed_at = ?, confirmed_by = ?
       WHERE id = ? AND institution_id = ? AND confirmed_at IS NULL`)
      .bind(now(), c.id.userId, runId, school(c).id).run()
    if ((res.meta?.changes ?? 0) === 0) throw notFound()
    return ok({ ok: true })
  }))
}
