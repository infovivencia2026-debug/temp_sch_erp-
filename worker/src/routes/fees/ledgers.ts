import type { Ctx, Router } from '../../router'
import { badRequest, bool, created, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import {
  addDays, daysBetween, fin, inList, isDate, isForeignKeyViolation, isUniqueViolation, items, p, paise, requireOpenPeriod, str, today,
} from './common'
import { school } from '../school'

/* Port of internal/api/ledgers.go and petty_cash_float.go (mountLedgers).

   The books: chart of accounts, double-entry vouchers, payables, petty cash,
   fixed assets, budgets and the auditor's reports. Money is integer paise.

   Postgres enforced the accounting rules with triggers (00033_ledgers.sql);
   SQLite on D1 has none, so every one of them is a pre-check in `Posting`
   below, followed by the write in a single c.db.batch so it stays atomic:
     journal_must_balance            -> Posting.voucher() line checks
     journal_line_account_is_postable-> Posting.voucher() account lookup
     journal_year_must_be_open       -> Posting.voucher() accounting_years check
     accounting_year_close_is_final  -> closeAccountingYear status pre-check
     vendor_payment_within_bill      -> payVendorBill pre-check
   Generated columns the schema lost (journal_entries.fy_start_year,
   ledger_accounts.normal_side, vendor_bills.total_paise,
   petty_cash_counts.variance_paise) are computed here on every insert. */

const POST = 'finance.payments.write'
const MASTERS = 'finance.fees.write'
const READ = 'finance.invoices.read'

/* ------------------------------------------------------------------------- */
/* Plumbing. */

/** The Indian financial year as dates: April the first to March the thirty-first. */
const fyRange = (fy: number) => ({ start: `${fy}-04-01`, end: `${fy + 1}-03-31` })
/** 2026 -> "2026-27". */
const fyLabel = (fy: number) => `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`
/** The financial year a date falls in. */
const fyOf = (d: string) => { const y = Number(d.slice(0, 4)); return Number(d.slice(5, 7)) < 4 ? y - 1 : y }
const currentFY = () => fyOf(today())
function fyFrom(c: Ctx): number {
  const v = Number(c.url.searchParams.get('fy'))
  return Number.isInteger(v) && v > 2000 ? v : currentFY()
}

/** parseDate: a YYYY-MM-DD, falling back when blank; malformed is a 400 with the handler's message. */
function dateOr(v: unknown, fallback: string, msg: string): string {
  const s = str(v).trim()
  if (s === '') return fallback
  if (!isDate(s)) throw badRequest(msg)
  return s
}
/** The lenient form: a malformed value keeps the fallback (the Go list handlers ignored the error). */
function dateOrIgnore(v: string | null, fallback: string): string {
  const s = (v ?? '').trim()
  return s !== '' && isDate(s) ? s : fallback
}

/** Groups by the Indian convention: 1,80,000 rather than 180,000. */
function indianRupees(n: number): string {
  const neg = n < 0
  let s = String(Math.abs(n))
  if (s.length <= 3) return (neg ? '-' : '') + s
  let head = s.slice(0, -3); const tail = s.slice(-3)
  const parts: string[] = []
  while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2) }
  if (head !== '') parts.unshift(head)
  s = parts.join(',') + ',' + tail
  return (neg ? '-' : '') + s
}

const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v)
const optInt = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v))
const nullIf = (v: unknown): string | null => { const s = str(v).trim(); return s === '' ? null : s }
const inst = (c: Ctx) => school(c).id
/** posted_by / created_by: a platform admin has no row in the school's users table. */
const actor = (c: Ctx): string | null => (c.id.platformAdmin ? null : c.id.userId)
const int64 = (v: unknown, name: string) => paise(v, name)

/** The batch, with the database's refusals turned into the sentences ledgerRefusal gave. */
async function runBatch(c: Ctx, stmts: D1PreparedStatement[]): Promise<void> {
  if (stmts.length === 0) return
  try { await c.db.batch(stmts) } catch (e) {
    if (isUniqueViolation(e)) throw badRequest('that already exists: ' + (e as Error).message.replace(/^.*UNIQUE constraint failed:\s*/i, ''))
    if (isForeignKeyViolation(e)) throw badRequest('that refers to something which does not exist')
    throw e
  }
}

/* Control accounts. Every one is required by the caller that asks for it, and
   a missing one is reported by name rather than defaulted. */
interface Controls {
  cash: string; bank: string; pettyCash: string
  feeReceivable: string; feeIncome: string; payable: string
  depreciation: string; accumulated: string; surplus: string
}
async function loadControls(c: Ctx): Promise<Controls> {
  const r = await c.db.prepare(`SELECT cash_account_id, bank_account_id, petty_cash_account_id,
      fee_receivable_account_id, fee_income_account_id, payable_account_id,
      depreciation_expense_account_id, accumulated_depreciation_account_id, surplus_account_id
    FROM ledger_settings WHERE institution_id = ?`).bind(inst(c)).first<Record<string, string | null>>()
  if (!r) throw notFound()
  const d = (k: string) => r[k] ?? ''
  return {
    cash: d('cash_account_id'), bank: d('bank_account_id'), pettyCash: d('petty_cash_account_id'),
    feeReceivable: d('fee_receivable_account_id'), feeIncome: d('fee_income_account_id'), payable: d('payable_account_id'),
    depreciation: d('depreciation_expense_account_id'), accumulated: d('accumulated_depreciation_account_id'), surplus: d('surplus_account_id'),
  }
}
/** Names the first unset control account, so the error says which one. */
function requireControls(...pairs: [string, string][]): void {
  for (const [id, name] of pairs) {
    if (!id) throw badRequest(`no ${name} account is set: choose one on the chart of accounts screen`)
  }
}

/* ------------------------------------------------------------------------- */
/* Vouchers. */

interface VLine { accountId: string; debit?: number; credit?: number; memo?: string }

/**
 * Accumulates balanced vouchers and their side statements for one batch.
 *
 * Numbering is gapless within a series: the maximum in the database is read
 * once per series and incremented in memory, so several vouchers in one
 * request (the fee sweep) number correctly. Two clerks saving in the same
 * instant collide on the UNIQUE (institution_id, voucher_no) index, which is
 * what the Postgres advisory lock prevented; the clerk sees a 400 and retries.
 */
class Posting {
  stmts: D1PreparedStatement[] = []
  private seq = new Map<string, number>()
  private years = new Set<number>()
  private sources = new Set<string>()
  private accounts = new Map<string, { code: string; name: string; is_group: unknown; is_active: unknown }>()
  constructor(private c: Ctx) {}

  private async nextNo(series: string): Promise<string> {
    let n = this.seq.get(series)
    if (n === undefined) {
      const r = await this.c.db.prepare(`SELECT COALESCE(MAX(CAST(substr(voucher_no, length(?1) + 1) AS INTEGER)), 0) AS n
          FROM journal_entries WHERE institution_id = ?2 AND voucher_no LIKE ?1 || '%'`)
        .bind(series, inst(this.c)).first<{ n: number }>()
      n = p(r?.n)
    }
    n += 1
    this.seq.set(series, n)
    return series + String(n).padStart(4, '0')
  }

  async voucher(voucherType: string, prefix: string, date: string, narration: string,
    sourceKind: string, sourceId: string | null, lines: VLine[]): Promise<{ id: string; voucherNo: string }> {
    const c = this.c
    // journal_must_balance
    if (lines.length < 2) throw badRequest(`a voucher needs at least two lines, got ${lines.length}`)
    let dr = 0; let cr = 0
    for (const l of lines) {
      const d = l.debit ?? 0; const k = l.credit ?? 0
      if (d < 0 || k < 0) throw badRequest('a voucher line cannot be negative: use the other side')
      if (d > 0 && k > 0) throw badRequest('a voucher line carries a debit or a credit, never both')
      dr += d; cr += k
    }
    if (dr !== cr) throw badRequest(`voucher does not balance: debits ${indianRupees(dr)}, credits ${indianRupees(cr)}`)

    const fy = fyOf(date)
    const series = `${prefix}/${fyLabel(fy)}/`

    // journal_year_must_be_open
    const closed = await c.db.prepare(`SELECT 1 AS x FROM accounting_years WHERE institution_id = ? AND fy_start_year = ? AND status = 'closed'`)
      .bind(inst(c), fy).first()
    if (closed) throw badRequest(`the books for ${fyLabel(fy)} are closed: post the correction in the current year`)

    // journal_line_account_is_postable
    const missing = [...new Set(lines.map((l) => l.accountId))].filter((id) => !this.accounts.has(id))
    if (missing.length) {
      const q = inList('id', missing)
      const rows = await c.db.prepare(`SELECT id, code, name, is_group, is_active FROM ledger_accounts WHERE institution_id = ? AND ${q.sql}`)
        .bind(inst(c), ...q.args).all<{ id: string; code: string; name: string; is_group: unknown; is_active: unknown }>()
      for (const a of rows.results) this.accounts.set(a.id, a)
    }
    for (const l of lines) {
      const a = this.accounts.get(l.accountId)
      if (!a) throw badRequest('that refers to something which does not exist')
      if (bool(a.is_group)) throw badRequest(`account ${a.code}  ${a.name} is a group heading: post to one of its accounts instead`)
      if (!bool(a.is_active)) throw badRequest(`account ${a.code}  ${a.name} is closed to posting`)
    }

    // journal_entries_one_per_source
    if (sourceId) {
      const key = sourceKind + ':' + sourceId
      const dup = this.sources.has(key) || !!(await c.db.prepare(`SELECT 1 AS x FROM journal_entries WHERE institution_id = ? AND source_kind = ? AND source_id = ?`)
        .bind(inst(c), sourceKind, sourceId).first())
      if (dup) throw badRequest('that already exists: journal_entries_one_per_source')
      this.sources.add(key)
    }

    const voucherNo = await this.nextNo(series)
    const id = uuid()
    const ts = now()
    // The year this entry falls in goes on record, created by the first entry
    // to land in it; one already there, open or closed, is left alone.
    if (!this.years.has(fy)) {
      this.years.add(fy)
      this.stmts.push(c.db.prepare(`INSERT OR IGNORE INTO accounting_years (id, institution_id, fy_start_year, status, created_at) VALUES (?, ?, ?, 'open', ?)`)
        .bind(uuid(), inst(c), fy, ts))
    }
    this.stmts.push(c.db.prepare(`INSERT INTO journal_entries (id, institution_id, voucher_no, voucher_type, entry_date, fy_start_year,
        narration, source_kind, source_id, posted_by, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), voucherNo, voucherType, date, fy, narration, sourceKind || null, sourceId, actor(c), ts))
    lines.forEach((l, i) => {
      this.stmts.push(c.db.prepare(`INSERT INTO journal_lines (id, institution_id, entry_id, account_id, line_no, debit_paise, credit_paise, memo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst(c), id, l.accountId, i + 1, l.debit ?? 0, l.credit ?? 0, nullIf(l.memo)))
    })
    return { id, voucherNo }
  }

  add(...s: D1PreparedStatement[]) { this.stmts.push(...s) }
  run() { return runBatch(this.c, this.stmts) }
}

/** Next number in a "PREFIX/nnnn"-style series on any table (vendors, assets, petty cash). */
async function nextInSeries(c: Ctx, table: string, col: string, prefix: string, width: number, whereAllDigits: boolean): Promise<string> {
  const guard = whereAllDigits ? `AND substr(${col}, length(?1) + 1) NOT GLOB '*[^0-9]*'` : ''
  const r = await c.db.prepare(`SELECT COALESCE(MAX(CAST(substr(${col}, length(?1) + 1) AS INTEGER)), 0) AS n
      FROM ${table} WHERE institution_id = ?2 AND ${col} LIKE ?1 || '%' ${guard}`).bind(prefix, inst(c)).first<{ n: number }>()
  return prefix + String(p(r?.n) + 1).padStart(width, '0')
}

/** Balance of one account to date: debits less credits. */
async function accountBalance(c: Ctx, accountId: string): Promise<number> {
  const r = await c.db.prepare(`SELECT COALESCE(sum(debit_paise) - sum(credit_paise), 0) AS n FROM journal_lines WHERE account_id = ?`)
    .bind(accountId).first<{ n: number }>()
  return p(r?.n)
}

/* SQL fragments reused across the reports. */
const BILL_TOTAL = 'COALESCE(b.total_paise, b.taxable_paise + b.tax_paise)'
const BILL_PAID = '(SELECT COALESCE(sum(vp.amount_paise), 0) FROM vendor_payments vp WHERE vp.bill_id = b.id)'
/** string_agg(DISTINCT a.name, ', ') over the other accounts of a voucher. */
const contraNames = (entry: string, exclude: string | null) =>
  `COALESCE((SELECT group_concat(nm, ', ') FROM (SELECT DISTINCT a2.name AS nm FROM journal_lines l2 JOIN ledger_accounts a2 ON a2.id = l2.account_id
      WHERE l2.entry_id = ${entry}${exclude ? ` AND l2.account_id <> ${exclude}` : ''} ORDER BY a2.name)), '')`

interface VoucherRow {
  id: string; voucher_no: string; voucher_type: string; entry_date: string; fy_start_year: number; narration: string
  source_kind?: string; amount_paise: number; lines: number; posted_by?: string; accounts: string; year_closed: boolean
}
const voucherRow = (r: Record<string, unknown>): VoucherRow => ({
  id: str(r.id), voucher_no: str(r.voucher_no), voucher_type: str(r.voucher_type), entry_date: str(r.entry_date),
  fy_start_year: p(r.fy_start_year), narration: str(r.narration), source_kind: opt(r.source_kind as string | null),
  amount_paise: p(r.amount_paise), lines: p(r.lines), posted_by: opt(r.posted_by as string | null),
  accounts: str(r.accounts), year_closed: bool(r.year_closed),
})

interface YearRow {
  id: string; fy_start_year: number; fy_label: string; status: string; closed_on?: string; closed_by?: string
  closing_voucher_no?: string; surplus_paise?: number; vouchers: number; live_income_paise: number
  live_expense_paise: number; live_surplus_paise: number; can_close: boolean; blocker?: string
}

/* ------------------------------------------------------------------------- */

export function registerLedgers(r: Router): void {
  const F = '/finance'

  // --- chart of accounts -------------------------------------------------

  r.get(`${F}/ledgers/accounts`, READ, fin(async (c) => {
    const rows = await c.db.prepare(`
      WITH RECURSIVE tree AS (
          SELECT a.id, 0 AS depth, a.code AS path FROM ledger_accounts a WHERE a.parent_id IS NULL
          UNION ALL
          SELECT c.id, t.depth + 1, t.path || '/' || c.code FROM ledger_accounts c JOIN tree t ON c.parent_id = t.id
      ),
      bal AS (SELECT l.account_id, sum(l.debit_paise) - sum(l.credit_paise) AS net, count(*) AS n FROM journal_lines l GROUP BY l.account_id)
      SELECT a.id, a.code, a.name, a.type, a.normal_side, a.parent_id, p.code AS parent_code, a.is_group, a.is_cash, a.is_contra,
             a.is_active, a.is_system, t.depth, COALESCE(bal.net, 0) AS balance_paise, COALESCE(bal.n, 0) AS postings
        FROM ledger_accounts a
        JOIN tree t ON t.id = a.id
        LEFT JOIN ledger_accounts p ON p.id = a.parent_id
        LEFT JOIN bal ON bal.account_id = a.id
       ORDER BY t.path`).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => ({
      id: str(v.id), code: str(v.code), name: str(v.name), type: str(v.type),
      normal_side: str(v.normal_side) || (v.type === 'asset' || v.type === 'expense' ? 'debit' : 'credit'),
      parent_id: opt(v.parent_id as string | null), parent_code: opt(v.parent_code as string | null),
      is_group: bool(v.is_group), is_cash: bool(v.is_cash), is_contra: bool(v.is_contra), is_active: bool(v.is_active),
      is_system: bool(v.is_system), depth: p(v.depth), balance_paise: p(v.balance_paise), postings: p(v.postings),
    }))))
  }))

  r.post(`${F}/ledgers/accounts`, MASTERS, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const code = str(req.code).trim(); const name = str(req.name).trim(); const type = str(req.type)
    if (code === '' || name === '') throw badRequest('an account needs a code and a name')
    if (!['asset', 'liability', 'income', 'expense', 'equity'].includes(type)) throw badRequest('type must be asset, liability, income, expense or equity')
    const reqId = str(req.id)
    if (reqId !== '') {
      if (!isUUID(reqId)) throw badRequest('id must be a uuid')
      /* A code or a type change on an account that already carries postings
         would silently restate history; the name and the active flag stay editable. */
      const exists = await c.db.prepare(`SELECT id FROM ledger_accounts WHERE id = ?`).bind(reqId).first()
      if (!exists) throw notFound()
      const isActive = req.is_active === undefined || req.is_active === null ? null : (req.is_active ? 1 : 0)
      await runBatch(c, [c.db.prepare(`UPDATE ledger_accounts SET name = ?2, is_active = COALESCE(?3, is_active) WHERE id = ?1`).bind(reqId, name, isActive)])
      return created({ id: reqId, code })
    }
    const parentId = str(req.parent_id)
    if (parentId !== '' && !isUUID(parentId)) throw badRequest('parent_id must be a uuid')
    const id = uuid()
    await runBatch(c, [c.db.prepare(`INSERT INTO ledger_accounts (id, institution_id, code, name, type, parent_id, is_group, is_cash, normal_side, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), code, name, type, parentId || null, req.is_group ? 1 : 0, req.is_cash ? 1 : 0,
        type === 'asset' || type === 'expense' ? 'debit' : 'credit', now())])
    return created({ id, code })
  }))

  r.get(`${F}/ledgers/settings`, READ, fin(async (c) => {
    const s = await c.db.prepare(`SELECT cash_account_id, bank_account_id, petty_cash_account_id, fee_receivable_account_id, fee_income_account_id,
        payable_account_id, depreciation_expense_account_id, accumulated_depreciation_account_id, surplus_account_id,
        petty_cash_limit_paise, default_depreciation_method FROM ledger_settings WHERE institution_id = ?`).bind(inst(c)).first<Record<string, unknown>>()
    // A school provisioned before the migration has no row: an empty shape, not a 404.
    if (!s) return ok({ petty_cash_limit_paise: 0, default_depreciation_method: 'straight_line' })
    return ok({
      cash_account_id: opt(s.cash_account_id), bank_account_id: opt(s.bank_account_id), petty_cash_account_id: opt(s.petty_cash_account_id),
      fee_receivable_account_id: opt(s.fee_receivable_account_id), fee_income_account_id: opt(s.fee_income_account_id),
      payable_account_id: opt(s.payable_account_id), depreciation_expense_account_id: opt(s.depreciation_expense_account_id),
      accumulated_depreciation_account_id: opt(s.accumulated_depreciation_account_id), surplus_account_id: opt(s.surplus_account_id),
      petty_cash_limit_paise: p(s.petty_cash_limit_paise), default_depreciation_method: str(s.default_depreciation_method),
    })
  }))

  r.post(`${F}/ledgers/settings`, MASTERS, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    let method = str(req.default_depreciation_method)
    if (method === '') method = 'straight_line'
    if (method !== 'straight_line' && method !== 'wdv') throw badRequest('depreciation method must be straight_line or wdv')
    const acc = (v: unknown) => (isUUID(v) ? v : null)
    const limit = int64(req.petty_cash_limit_paise, 'petty_cash_limit_paise')
    await runBatch(c, [c.db.prepare(`INSERT INTO ledger_settings (institution_id, cash_account_id, bank_account_id, petty_cash_account_id,
        fee_receivable_account_id, fee_income_account_id, payable_account_id, depreciation_expense_account_id,
        accumulated_depreciation_account_id, surplus_account_id, petty_cash_limit_paise, default_depreciation_method, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT (institution_id) DO UPDATE SET
        cash_account_id = excluded.cash_account_id, bank_account_id = excluded.bank_account_id,
        petty_cash_account_id = excluded.petty_cash_account_id, fee_receivable_account_id = excluded.fee_receivable_account_id,
        fee_income_account_id = excluded.fee_income_account_id, payable_account_id = excluded.payable_account_id,
        depreciation_expense_account_id = excluded.depreciation_expense_account_id,
        accumulated_depreciation_account_id = excluded.accumulated_depreciation_account_id,
        surplus_account_id = excluded.surplus_account_id, petty_cash_limit_paise = excluded.petty_cash_limit_paise,
        default_depreciation_method = excluded.default_depreciation_method, updated_at = excluded.updated_at`)
      .bind(inst(c), acc(req.cash_account_id), acc(req.bank_account_id), acc(req.petty_cash_account_id), acc(req.fee_receivable_account_id),
        acc(req.fee_income_account_id), acc(req.payable_account_id), acc(req.depreciation_expense_account_id),
        acc(req.accumulated_depreciation_account_id), acc(req.surplus_account_id), limit, method, now())])
    return ok({ saved: true })
  }))

  // --- general ledger ----------------------------------------------------

  const VOUCHER_SELECT = `
      SELECT e.id, e.voucher_no, e.voucher_type, e.entry_date, e.fy_start_year, e.narration, e.source_kind,
             COALESCE((SELECT sum(l.debit_paise) FROM journal_lines l WHERE l.entry_id = e.id), 0) AS amount_paise,
             COALESCE((SELECT count(*) FROM journal_lines l WHERE l.entry_id = e.id), 0) AS lines,
             u.full_name AS posted_by`

  r.get(`${F}/ledgers/vouchers`, READ, fin(async (c) => {
    const q = c.url.searchParams
    const fy = fyRange(fyFrom(c))
    const from = dateOrIgnore(q.get('from'), fy.start)
    const to = dateOrIgnore(q.get('to'), fy.end)
    const rows = await c.db.prepare(`${VOUCHER_SELECT},
             ${contraNames('e.id', null)} AS accounts,
             EXISTS (SELECT 1 FROM accounting_years y WHERE y.institution_id = e.institution_id AND y.fy_start_year = e.fy_start_year AND y.status = 'closed') AS year_closed
        FROM journal_entries e LEFT JOIN users u ON u.id = e.posted_by
       WHERE e.entry_date BETWEEN ?1 AND ?2 AND (?3 = '' OR e.voucher_type = ?3)
       ORDER BY e.entry_date DESC, e.voucher_no DESC LIMIT 500`).bind(from, to, q.get('type') ?? '').all<Record<string, unknown>>()
    return ok(items(rows.results.map(voucherRow)))
  }))

  r.get(`${F}/ledgers/trial-balance`, READ, fin(async (c) => {
    const fy = fyFrom(c)
    const { start, end: fyEnd } = fyRange(fy)
    let end = fyEnd
    const asOn = c.url.searchParams.get('as_on')
    if (asOn && isDate(asOn) && asOn >= start) end = asOn
    const rows = await c.db.prepare(`
      SELECT a.id, a.code, a.name, a.type,
             COALESCE(sum(CASE WHEN e.entry_date < ?1 THEN l.debit_paise END), 0) - COALESCE(sum(CASE WHEN e.entry_date < ?1 THEN l.credit_paise END), 0) AS opening,
             COALESCE(sum(CASE WHEN e.entry_date BETWEEN ?1 AND ?2 THEN l.debit_paise END), 0) AS dr,
             COALESCE(sum(CASE WHEN e.entry_date BETWEEN ?1 AND ?2 THEN l.credit_paise END), 0) AS cr
        FROM ledger_accounts a
        LEFT JOIN journal_lines l ON l.account_id = a.id
        LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.entry_date <= ?2
       WHERE NOT a.is_group
       GROUP BY a.id, a.code, a.name, a.type
       ORDER BY a.code`).bind(start, end).all<Record<string, unknown>>()
    const out: Record<string, unknown>[] = []
    let openDr = 0, openCr = 0, perDr = 0, perCr = 0, closeDr = 0, closeCr = 0
    for (const r of rows.results) {
      const opening = p(r.opening), dr = p(r.dr), cr = p(r.cr)
      if (opening === 0 && dr === 0 && cr === 0) continue
      const closing = opening + dr - cr
      const v = {
        account_id: str(r.id), code: str(r.code), name: str(r.name), type: str(r.type),
        opening_debit_paise: opening >= 0 ? opening : 0, opening_credit_paise: opening >= 0 ? 0 : -opening,
        period_debit_paise: dr, period_credit_paise: cr,
        closing_debit_paise: closing >= 0 ? closing : 0, closing_credit_paise: closing >= 0 ? 0 : -closing,
      }
      openDr += v.opening_debit_paise; openCr += v.opening_credit_paise
      perDr += dr; perCr += cr
      closeDr += v.closing_debit_paise; closeCr += v.closing_credit_paise
      out.push(v)
    }
    return ok({
      fy_start_year: fy, fy_label: fyLabel(fy), from: start, to: end, rows: out,
      totals: {
        opening_debit_paise: openDr, opening_credit_paise: openCr, period_debit_paise: perDr,
        period_credit_paise: perCr, closing_debit_paise: closeDr, closing_credit_paise: closeCr,
      },
      balanced: openDr === openCr && perDr === perCr && closeDr === closeCr,
      difference_paise: closeDr - closeCr,
    })
  }))

  r.get(`${F}/ledgers/account-ledger`, READ, fin(async (c) => {
    const accID = c.url.searchParams.get('account_id')
    if (!isUUID(accID)) throw badRequest('account_id must be a uuid')
    const fy = fyFrom(c)
    const { start, end } = fyRange(fy)
    const head = await c.db.prepare(`
      SELECT a.code, a.name, a.type,
             COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                        WHERE l.account_id = a.id AND e.entry_date < ?2), 0) AS opening
        FROM ledger_accounts a WHERE a.id = ?1`).bind(accID, start).first<Record<string, unknown>>()
    if (!head) throw notFound()
    const rows = await c.db.prepare(`
      SELECT e.entry_date AS date, e.voucher_no, e.voucher_type, e.narration, ${contraNames('e.id', '?1')} AS contra,
             l.debit_paise, l.credit_paise, l.memo
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ?1 AND e.entry_date BETWEEN ?2 AND ?3
       ORDER BY e.entry_date, e.voucher_no, l.line_no`).bind(accID, start, end).all<Record<string, unknown>>()
    const opening = p(head.opening)
    let running = opening, dr = 0, cr = 0
    const entries = rows.results.map((r) => {
      const d = p(r.debit_paise), k = p(r.credit_paise)
      running += d - k; dr += d; cr += k
      return {
        date: str(r.date), voucher_no: str(r.voucher_no), voucher_type: str(r.voucher_type), narration: str(r.narration),
        contra: str(r.contra), debit_paise: d, credit_paise: k, running_paise: running, memo: opt(r.memo as string | null),
      }
    })
    return ok({
      account_id: accID, code: str(head.code), name: str(head.name), type: str(head.type),
      fy_start_year: fy, fy_label: fyLabel(fy),
      opening_paise: opening, debit_paise: dr, credit_paise: cr, closing_paise: opening + dr - cr, entries,
    })
  }))

  r.get(`${F}/ledgers/statements`, READ, fin(async (c) => {
    const fy = fyFrom(c)
    const { start, end } = fyRange(fy)
    type SRow = { code: string; name: string; group: string; paise: number; is_group: boolean }
    const income: SRow[] = [], expense: SRow[] = [], assets: SRow[] = [], liabilities: SRow[] = []
    let incomeTotal = 0, expenseTotal = 0, assetTotal = 0, liabilityTotal = 0
    // Income and expenditure: this year's movement, closing vouchers left out.
    const ie = await c.db.prepare(`
      SELECT a.code, a.name, a.type, COALESCE(p.name, '-') AS grp, sum(l.credit_paise) - sum(l.debit_paise) AS net
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
        LEFT JOIN ledger_accounts p ON p.id = a.parent_id
       WHERE a.type IN ('income','expense') AND e.entry_date BETWEEN ?1 AND ?2 AND e.voucher_type <> 'closing'
       GROUP BY a.id, a.code, a.name, a.type, p.name
      HAVING sum(l.credit_paise) - sum(l.debit_paise) <> 0
       ORDER BY a.code`).bind(start, end).all<Record<string, unknown>>()
    for (const r of ie.results) {
      const net = p(r.net)
      if (r.type === 'income') { income.push({ code: str(r.code), name: str(r.name), group: str(r.grp), paise: net, is_group: false }); incomeTotal += net }
      else { expense.push({ code: str(r.code), name: str(r.name), group: str(r.grp), paise: -net, is_group: false }); expenseTotal += -net }
    }
    // Balance sheet: everything ever posted, up to the year end.
    const bs = await c.db.prepare(`
      SELECT a.code, a.name, a.type, COALESCE(p.name, '-') AS grp, sum(l.debit_paise) - sum(l.credit_paise) AS net
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
        LEFT JOIN ledger_accounts p ON p.id = a.parent_id
       WHERE a.type IN ('asset','liability','equity') AND e.entry_date <= ?1
       GROUP BY a.id, a.code, a.name, a.type, p.name
      HAVING sum(l.debit_paise) - sum(l.credit_paise) <> 0
       ORDER BY a.code`).bind(end).all<Record<string, unknown>>()
    for (const r of bs.results) {
      const net = p(r.net)
      if (r.type === 'asset') { assets.push({ code: str(r.code), name: str(r.name), group: str(r.grp), paise: net, is_group: false }); assetTotal += net }
      else { liabilities.push({ code: str(r.code), name: str(r.name), group: str(r.grp), paise: -net, is_group: false }); liabilityTotal += -net }
    }
    // The result not yet swept into the corpus: credits less debits across income and expenditure.
    const un = await c.db.prepare(`
      SELECT COALESCE(sum(l.credit_paise - l.debit_paise), 0) AS n
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
       WHERE a.type IN ('income','expense') AND e.entry_date <= ?1`).bind(end).first<{ n: number }>()
    const unclosed = p(un?.n)
    const liabilitySide = liabilityTotal + unclosed
    return ok({
      fy_start_year: fy, fy_label: fyLabel(fy), from: start, to: end,
      income_expenditure: { income, expenditure: expense, income_paise: incomeTotal, expenditure_paise: expenseTotal, surplus_paise: incomeTotal - expenseTotal },
      balance_sheet: {
        assets, liabilities, assets_paise: assetTotal, liabilities_paise: liabilityTotal, surplus_not_yet_closed: unclosed,
        liabilities_total_paise: liabilitySide, balanced: assetTotal === liabilitySide, difference_paise: assetTotal - liabilitySide,
      },
    })
  }))

  r.get(`${F}/ledgers/vouchers/{id}`, READ, fin(async (c) => {
    const entryID = c.params.id
    if (!isUUID(entryID)) throw badRequest('invalid voucher id')
    const head = await c.db.prepare(`
      SELECT e.id, e.voucher_no, e.voucher_type, e.entry_date, e.fy_start_year, e.narration, e.source_kind, u.full_name AS posted_by,
             EXISTS (SELECT 1 FROM accounting_years y WHERE y.institution_id = e.institution_id AND y.fy_start_year = e.fy_start_year AND y.status = 'closed') AS year_closed
        FROM journal_entries e LEFT JOIN users u ON u.id = e.posted_by WHERE e.id = ?`).bind(entryID).first<Record<string, unknown>>()
    if (!head) throw notFound()
    const rows = await c.db.prepare(`SELECT a.id AS account_id, a.code, a.name, l.debit_paise, l.credit_paise, l.memo
        FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no`).bind(entryID).all<Record<string, unknown>>()
    let amount = 0
    const lines = rows.results.map((l) => {
      amount += p(l.debit_paise)
      return { account_id: str(l.account_id), code: str(l.code), name: str(l.name), debit_paise: p(l.debit_paise), credit_paise: p(l.credit_paise), memo: opt(l.memo as string | null) }
    })
    return ok({ voucher: voucherRow({ ...head, amount_paise: amount, lines: lines.length, accounts: '' }), lines })
  }))

  r.post(`${F}/ledgers/vouchers`, POST, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const narration = str(req.narration).trim()
    if (narration === '') throw badRequest('say what this voucher is for')
    const voucherType = str(req.voucher_type) || 'journal'
    const date = dateOr(req.entry_date, today(), 'entry_date must be YYYY-MM-DD')
    const raw = Array.isArray(req.lines) ? (req.lines as Record<string, unknown>[]) : []
    const lines: VLine[] = raw.map((l) => {
      if (!isUUID(l.account_id)) throw badRequest('every line needs an account_id')
      return { accountId: l.account_id, debit: int64(l.debit_paise, 'debit_paise'), credit: int64(l.credit_paise, 'credit_paise'), memo: str(l.memo) }
    })
    const prefix = ({ receipt: 'RV', payment: 'PV', contra: 'CV', purchase: 'PJ', sales: 'SV', journal: 'JV' } as Record<string, string>)[voucherType]
    if (!prefix) throw badRequest('voucher_type must be journal, receipt, payment, contra, purchase or sales')
    const post = new Posting(c)
    const v = await post.voucher(voucherType, prefix, date, narration, '', null, lines)
    await post.run()
    return created({ id: v.id, voucher_no: v.voucherNo })
  }))

  // --- expenses ----------------------------------------------------------

  r.get(`${F}/ledgers/expenses`, READ, fin(async (c) => {
    const { start, end } = fyRange(fyFrom(c))
    const rows = await c.db.prepare(`
      SELECT a.id, a.code, a.name, COALESCE(p.name, '-') AS grp, sum(l.debit_paise) - sum(l.credit_paise) AS net,
             count(DISTINCT e.id) AS vouchers,
             COALESCE(sum(CASE WHEN e.voucher_type = 'purchase' THEN l.debit_paise END), 0) AS from_bills,
             COALESCE(sum(CASE WHEN e.source_kind = 'petty_cash' THEN l.debit_paise END), 0) AS from_petty,
             COALESCE(sum(CASE WHEN e.voucher_type <> 'purchase' AND (e.source_kind IS NULL OR e.source_kind <> 'petty_cash') THEN l.debit_paise END), 0) AS from_other
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
        LEFT JOIN ledger_accounts p ON p.id = a.parent_id
       WHERE a.type = 'expense' AND e.entry_date BETWEEN ?1 AND ?2 AND e.voucher_type <> 'closing'
       GROUP BY a.id, a.code, a.name, p.name
      HAVING sum(l.debit_paise) - sum(l.credit_paise) <> 0
       ORDER BY net DESC`).bind(start, end).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => ({
      account_id: str(v.id), code: str(v.code), name: str(v.name), group: str(v.grp), paise: p(v.net), vouchers: p(v.vouchers),
      from_bills_paise: p(v.from_bills), from_petty_cash_paise: p(v.from_petty), from_other_paise: p(v.from_other),
    }))))
  }))

  r.post(`${F}/ledgers/expenses`, POST, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (!isUUID(req.expense_account_id)) throw badRequest('expense_account_id must be a uuid')
    const amount = int64(req.amount_paise, 'amount_paise')
    if (amount <= 0) throw badRequest('amount_paise must be greater than zero')
    const narration = str(req.narration).trim()
    if (narration === '') throw badRequest('say what the money was spent on')
    const date = dateOr(req.spent_on, today(), 'spent_on must be YYYY-MM-DD')
    let paidFrom = str(req.paid_from_account_id)
    if (paidFrom !== '') {
      if (!isUUID(paidFrom)) throw badRequest('paid_from_account_id must be a uuid')
    } else {
      const ctl = await loadControls(c)
      requireControls([ctl.cash, 'cash'])
      paidFrom = ctl.cash
    }
    const post = new Posting(c)
    const v = await post.voucher('payment', 'PV', date, narration, '', null, [
      { accountId: req.expense_account_id as string, debit: amount },
      { accountId: paidFrom, credit: amount },
    ])
    await post.run()
    return created({ voucher_no: v.voucherNo, amount_paise: amount })
  }))

  // --- the year ----------------------------------------------------------

  r.get(`${F}/ledgers/years`, READ, fin(async (c) => {
    const rows = await c.db.prepare(`
      SELECT y.id, y.fy_start_year, y.status, y.closed_on, u.full_name AS closed_by, ce.voucher_no AS closing_vno, y.surplus_paise,
             COALESCE((SELECT count(*) FROM journal_entries e WHERE e.institution_id = y.institution_id AND e.fy_start_year = y.fy_start_year), 0) AS vouchers,
             COALESCE((SELECT sum(l.credit_paise) - sum(l.debit_paise) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                        JOIN ledger_accounts a ON a.id = l.account_id
                       WHERE e.institution_id = y.institution_id AND e.fy_start_year = y.fy_start_year AND e.voucher_type <> 'closing' AND a.type = 'income'), 0) AS live_income,
             COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                        JOIN ledger_accounts a ON a.id = l.account_id
                       WHERE e.institution_id = y.institution_id AND e.fy_start_year = y.fy_start_year AND e.voucher_type <> 'closing' AND a.type = 'expense'), 0) AS live_expense,
             COALESCE((SELECT min(y2.fy_start_year) FROM accounting_years y2
                       WHERE y2.institution_id = y.institution_id AND y2.status = 'open' AND y2.fy_start_year < y.fy_start_year), 0) AS earlier_open
        FROM accounting_years y
        LEFT JOIN users u ON u.id = y.closed_by
        LEFT JOIN journal_entries ce ON ce.id = y.closing_entry_id
       ORDER BY y.fy_start_year DESC`).all<Record<string, unknown>>()
    const out: YearRow[] = rows.results.map((r) => {
      const fy = p(r.fy_start_year); const vouchers = p(r.vouchers); const earlier = p(r.earlier_open)
      const li = p(r.live_income), le = p(r.live_expense)
      const v: YearRow = {
        id: str(r.id), fy_start_year: fy, fy_label: fyLabel(fy), status: str(r.status), closed_on: opt(r.closed_on as string | null),
        closed_by: opt(r.closed_by as string | null), closing_voucher_no: opt(r.closing_vno as string | null),
        surplus_paise: optInt(r.surplus_paise), vouchers, live_income_paise: li, live_expense_paise: le, live_surplus_paise: li - le, can_close: false,
      }
      if (v.status === 'closed') v.blocker = 'already closed'
      else if (earlier > 0) v.blocker = 'close ' + fyLabel(earlier) + ' first'
      else if (vouchers === 0) v.blocker = 'no entries to close'
      else v.can_close = true
      return v
    })
    return ok(items(out))
  }))

  r.post(`${F}/ledgers/years/close`, POST, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const fy = Number(req.fy_start_year)
    if (!Number.isInteger(fy) || fy < 2000) throw badRequest('fy_start_year is required, as the April year: 2026 means 2026-27')
    if (!req.confirm) throw badRequest('closing a year cannot be undone: send confirm=true')
    const { end } = fyRange(fy)
    const year = await c.db.prepare(`SELECT status FROM accounting_years WHERE institution_id = ? AND fy_start_year = ?`).bind(inst(c), fy).first<{ status: string }>()
    // Years are created by the first entry that falls in them, so no row means no entries.
    if (!year) throw badRequest(`${fyLabel(fy)} has nothing in it to close`)
    // accounting_year_close_is_final: open -> closed is the only transition.
    if (year.status === 'closed') throw badRequest(`the books for ${fyLabel(fy)} are already closed`)
    const earlier = await c.db.prepare(`SELECT min(fy_start_year) AS n FROM accounting_years y
        WHERE institution_id = ?1 AND status = 'open' AND fy_start_year < ?2
          AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.institution_id = ?1 AND e.fy_start_year = y.fy_start_year)`)
      .bind(inst(c), fy).first<{ n: number | null }>()
    if (earlier?.n !== null && earlier?.n !== undefined) {
      throw badRequest(`close ${fyLabel(earlier.n)} first: closing out of order strands its result outside the corpus`)
    }
    const ctl = await loadControls(c)
    requireControls([ctl.surplus, 'surplus carried forward'])
    const bals = await c.db.prepare(`
      SELECT a.id, a.type, sum(l.debit_paise) - sum(l.credit_paise) AS bal
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
       WHERE e.institution_id = ?1 AND e.fy_start_year = ?2 AND a.type IN ('income','expense')
       GROUP BY a.id, a.type HAVING sum(l.debit_paise) - sum(l.credit_paise) <> 0`).bind(inst(c), fy).all<{ id: string; type: string; bal: number }>()
    const lines: VLine[] = []
    let net = 0
    for (const b of bals.results) {
      const bal = p(b.bal)
      // Reverse whatever the account holds, so it ends the year at nil.
      if (bal < 0) lines.push({ accountId: b.id, debit: -bal, memo: 'year end close' })
      else lines.push({ accountId: b.id, credit: bal, memo: 'year end close' })
      net += bal
    }
    if (lines.length === 0) throw badRequest(`${fyLabel(fy)} has no income or expenditure to close`)
    const swept = lines.length
    const surplus = -net
    if (surplus >= 0) lines.push({ accountId: ctl.surplus, credit: surplus, memo: 'surplus for ' + fyLabel(fy) })
    else lines.push({ accountId: ctl.surplus, debit: -surplus, memo: 'deficit for ' + fyLabel(fy) })
    const post = new Posting(c)
    const v = await post.voucher('closing', 'CL', end, `Closing the books for ${fyLabel(fy)}`, '', null, lines)
    post.add(c.db.prepare(`UPDATE accounting_years SET status = 'closed', closed_on = ?3, closed_by = ?4, closing_entry_id = ?5, surplus_paise = ?6
        WHERE institution_id = ?1 AND fy_start_year = ?2 AND status = 'open'`).bind(inst(c), fy, today(), actor(c), v.id, surplus))
    await post.run()
    return ok({ fy_start_year: fy, fy_label: fyLabel(fy), status: 'closed', closing_voucher_no: v.voucherNo, surplus_paise: surplus, accounts_closed: swept })
  }))

  // --- payables ----------------------------------------------------------

  r.get(`${F}/ledgers/vendors`, READ, fin(async (c) => {
    const rows = await c.db.prepare(`
      SELECT v.id, v.code, v.name, v.contact_person, v.phone, v.email, v.gstin, v.pan, v.category, v.payment_terms_days, v.is_active,
             (SELECT count(*) FROM vendor_bills b WHERE b.vendor_id = v.id AND b.status = 'approved') AS n,
             (SELECT COALESCE(sum(${BILL_TOTAL}), 0) FROM vendor_bills b WHERE b.vendor_id = v.id AND b.status = 'approved') AS billed,
             (SELECT COALESCE(sum(${BILL_PAID}), 0) FROM vendor_bills b WHERE b.vendor_id = v.id AND b.status = 'approved') AS paid,
             (SELECT COALESCE(sum(CASE WHEN COALESCE(b.due_on, date(b.bill_date, '+' || v.payment_terms_days || ' days')) < ?1
                                       THEN ${BILL_TOTAL} - ${BILL_PAID} ELSE 0 END), 0)
                FROM vendor_bills b WHERE b.vendor_id = v.id AND b.status = 'approved') AS overdue
        FROM vendors v
       ORDER BY v.is_active DESC, v.name`).bind(today()).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => ({
      id: str(v.id), code: str(v.code), name: str(v.name), contact_person: opt(v.contact_person as string | null), phone: opt(v.phone as string | null),
      email: opt(v.email as string | null), gstin: opt(v.gstin as string | null), pan: opt(v.pan as string | null), category: opt(v.category as string | null),
      payment_terms_days: p(v.payment_terms_days), is_active: bool(v.is_active), bills: p(v.n), billed_paise: p(v.billed), paid_paise: p(v.paid),
      outstanding_paise: p(v.billed) - p(v.paid), overdue_paise: p(v.overdue),
    }))))
  }))

  r.post(`${F}/ledgers/vendors`, MASTERS, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name).trim()
    if (name === '') throw badRequest('a vendor needs a name')
    let terms = Number(req.payment_terms_days)
    if (!Number.isInteger(terms) || terms <= 0) terms = 30
    // A GSTIN or PAN in lower case fails the filing it was collected for.
    const gstin = str(req.gstin).trim().toUpperCase()
    const pan = str(req.pan).trim().toUpperCase()
    const isActive = req.is_active === undefined || req.is_active === null ? null : (req.is_active ? 1 : 0)
    const args = [name, nullIf(req.contact_person), nullIf(req.phone), nullIf(req.email), nullIf(req.address), nullIf(gstin), nullIf(pan),
      nullIf(req.bank_account), nullIf(req.bank_ifsc), nullIf(req.category), terms]
    const reqId = str(req.id)
    if (reqId !== '') {
      if (!isUUID(reqId)) throw badRequest('id must be a uuid')
      const cur = await c.db.prepare(`SELECT code FROM vendors WHERE id = ?`).bind(reqId).first<{ code: string }>()
      if (!cur) throw notFound()
      await runBatch(c, [c.db.prepare(`UPDATE vendors SET name = ?2, contact_person = ?3, phone = ?4, email = ?5, address = ?6, gstin = ?7, pan = ?8,
          bank_account = ?9, bank_ifsc = ?10, category = ?11, payment_terms_days = ?12, is_active = COALESCE(?13, is_active) WHERE id = ?1`)
        .bind(reqId, ...args, isActive)])
      return created({ id: reqId, code: cur.code })
    }
    // A code nobody supplied is allocated in sequence.
    const code = str(req.code).trim() || await nextInSeries(c, 'vendors', 'code', 'V', 4, true)
    const id = uuid()
    await runBatch(c, [c.db.prepare(`INSERT INTO vendors (id, institution_id, code, name, contact_person, phone, email, address, gstin, pan,
        bank_account, bank_ifsc, category, payment_terms_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst(c), code, ...args, now())])
    return created({ id, code })
  }))

  r.get(`${F}/ledgers/bills`, READ, fin(async (c) => {
    const t = today()
    const rows = await c.db.prepare(`
      SELECT b.id, v.id AS vendor_id, v.name AS vendor_name, b.bill_no, b.bill_date, b.due_on, a.code AS expense_code, a.name AS expense_name,
             b.taxable_paise, b.tax_paise, ${BILL_TOTAL} AS total, ${BILL_PAID} AS paid, b.status,
             CAST(julianday(?1) - julianday(COALESCE(b.due_on, b.bill_date)) AS INTEGER) AS age,
             e.voucher_no, b.narration
        FROM vendor_bills b
        JOIN vendors v ON v.id = b.vendor_id
        JOIN ledger_accounts a ON a.id = b.expense_account_id
        LEFT JOIN journal_entries e ON e.id = b.journal_entry_id
       ORDER BY (b.status = 'approved') DESC, (${BILL_TOTAL} - ${BILL_PAID} > 0) DESC, COALESCE(b.due_on, b.bill_date)
       LIMIT 400`).bind(t).all<Record<string, unknown>>()
    return ok(items(rows.results.map((b) => {
      const total = p(b.total), paid = p(b.paid), age = p(b.age), approved = b.status === 'approved'
      const paymentState = !approved ? str(b.status) : paid === 0 ? 'unpaid' : paid >= total ? 'paid' : 'part paid'
      const daysOverdue = approved && paid < total && age > 0 ? age : 0
      const bucket = !approved || paid >= total ? '-' : age > 90 ? '90+' : age > 60 ? '61-90' : age > 30 ? '31-60' : age > 0 ? '0-30' : 'not due'
      return {
        id: str(b.id), vendor_id: str(b.vendor_id), vendor_name: str(b.vendor_name), bill_no: str(b.bill_no), bill_date: str(b.bill_date),
        due_on: opt(b.due_on as string | null), expense_code: str(b.expense_code), expense_name: str(b.expense_name),
        taxable_paise: p(b.taxable_paise), tax_paise: p(b.tax_paise), total_paise: total, paid_paise: paid, outstanding_paise: total - paid,
        status: str(b.status), payment_state: paymentState, days_overdue: daysOverdue, bucket,
        voucher_no: opt(b.voucher_no as string | null), narration: opt(b.narration as string | null),
      }
    })))
  }))

  r.post(`${F}/ledgers/bills`, POST, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (!isUUID(req.vendor_id)) throw badRequest('vendor_id must be a uuid')
    if (!isUUID(req.expense_account_id)) throw badRequest('expense_account_id must be a uuid')
    const billNo = str(req.bill_no).trim()
    if (billNo === '') throw badRequest('a bill needs its number: it is the duplicate-payment control')
    const taxable = int64(req.taxable_paise, 'taxable_paise'); const tax = int64(req.tax_paise, 'tax_paise')
    if (taxable + tax <= 0) throw badRequest('a bill must be for more than nothing')
    const billDate = dateOr(req.bill_date, today(), 'bill_date must be YYYY-MM-DD')
    let dueOn: string | null = null
    if (str(req.due_on) !== '') {
      if (!isDate(req.due_on)) throw badRequest('due_on must be YYYY-MM-DD')
      dueOn = req.due_on
    }
    const vendor = await c.db.prepare(`SELECT payment_terms_days FROM vendors WHERE id = ?`).bind(req.vendor_id).first<{ payment_terms_days: number }>()
    if (!vendor) throw notFound()
    // A missing due date falls back to the vendor's terms, so the ageing report has something honest to age against.
    if (!dueOn) dueOn = addDays(billDate, p(vendor.payment_terms_days))
    const id = uuid()
    await runBatch(c, [c.db.prepare(`INSERT INTO vendor_bills (id, institution_id, vendor_id, bill_no, bill_date, due_on, expense_account_id,
        taxable_paise, tax_paise, total_paise, narration, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .bind(id, inst(c), req.vendor_id, billNo, billDate, dueOn, req.expense_account_id, taxable, tax, taxable + tax, nullIf(req.narration), actor(c), now())])
    return created({ id, status: 'draft' })
  }))

  r.post(`${F}/ledgers/bills/{id}/approve`, POST, fin(async (c) => {
    const billID = c.params.id
    if (!isUUID(billID)) throw badRequest('invalid bill id')
    const b = await c.db.prepare(`SELECT b.status, b.expense_account_id, b.taxable_paise, b.tax_paise, b.bill_date, v.name, b.bill_no
        FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = ?`).bind(billID).first<Record<string, unknown>>()
    if (!b) throw notFound()
    if (b.status !== 'draft') throw badRequest(`the bill is already ${str(b.status)}`)
    const ctl = await loadControls(c)
    requireControls([ctl.payable, 'sundry creditors'])
    const taxable = p(b.taxable_paise), tax = p(b.tax_paise)
    const lines: VLine[] = [{ accountId: str(b.expense_account_id), debit: taxable }]
    if (tax > 0) {
      // Input GST a school cannot claim is charged to the same head; the tax column survives for the return.
      lines[0].debit = taxable + tax
      lines[0].memo = `includes ${indianRupees(tax)} tax`
    }
    lines.push({ accountId: ctl.payable, credit: taxable + tax })
    const post = new Posting(c)
    const v = await post.voucher('purchase', 'PJ', str(b.bill_date), `${str(b.name)}, bill ${str(b.bill_no)}`, 'vendor_bill', billID, lines)
    post.add(c.db.prepare(`UPDATE vendor_bills SET status = 'approved', approved_by = ?2, approved_at = ?3, journal_entry_id = ?4 WHERE id = ?1 AND status = 'draft'`)
      .bind(billID, actor(c), now(), v.id))
    await post.run()
    return ok({ id: billID, status: 'approved', voucher_no: v.voucherNo })
  }))

  r.post(`${F}/ledgers/bills/{id}/pay`, POST, fin(async (c) => {
    const billID = c.params.id
    if (!isUUID(billID)) throw badRequest('invalid bill id')
    const req = await readJSON<Record<string, unknown>>(c.req)
    const amount = int64(req.amount_paise, 'amount_paise')
    if (amount <= 0) throw badRequest('amount_paise must be greater than zero')
    const tds = int64(req.tds_paise, 'tds_paise')
    if (tds < 0 || tds >= amount) throw badRequest('tds_paise must be less than the amount')
    const mode = str(req.mode) || 'neft'
    const paidOn = dateOr(req.paid_on, today(), 'paid_on must be YYYY-MM-DD')
    const ctl = await loadControls(c)
    requireControls([ctl.payable, 'sundry creditors'])
    let from = ctl.bank
    const fromReq = str(req.paid_from_account_id)
    if (fromReq !== '') {
      if (!isUUID(fromReq)) throw badRequest('paid_from_account_id must be a uuid')
      from = fromReq
    } else if (mode === 'cash') from = ctl.cash
    if (!from) throw badRequest('no bank account is set: choose one on the chart of accounts screen')
    const b = await c.db.prepare(`SELECT v.name, b.bill_no, ${BILL_TOTAL} AS total, b.status, ${BILL_PAID} AS paid
        FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = ?`).bind(billID).first<Record<string, unknown>>()
    if (!b) throw notFound()
    // vendor_payment_within_bill: approved only, and never past the total.
    const total = p(b.total), paid = p(b.paid)
    if (b.status !== 'approved') throw badRequest(`bill is ${str(b.status)} — approve it before paying`)
    if (paid + amount > total) throw badRequest(`paying ${amount} paise would overpay the bill: total ${total}, already paid ${paid}`)
    const vendorName = str(b.name)
    const lines: VLine[] = [
      { accountId: ctl.payable, debit: amount, memo: vendorName },
      { accountId: from, credit: amount - tds },
    ]
    if (tds > 0) {
      const t = await c.db.prepare(`SELECT id FROM ledger_accounts WHERE institution_id = ? AND code = '2160' AND NOT is_group`).bind(inst(c)).first<{ id: string }>()
      if (!t) throw badRequest('no TDS payable account (2160) in the chart of accounts')
      lines.push({ accountId: t.id, credit: tds, memo: 'TDS on ' + vendorName })
    }
    const post = new Posting(c)
    const v = await post.voucher('payment', 'PV', paidOn, `Paid ${vendorName} against bill ${str(b.bill_no)}`, '', null, lines)
    post.add(c.db.prepare(`INSERT INTO vendor_payments (id, institution_id, bill_id, voucher_no, paid_on, amount_paise, mode, reference_no,
        paid_from_account_id, tds_paise, journal_entry_id, remarks, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst(c), billID, v.voucherNo, paidOn, amount, mode, nullIf(req.reference_no), from, tds, v.id, nullIf(req.remarks), actor(c), now()))
    await post.run()
    const after = await c.db.prepare(`SELECT ${BILL_TOTAL} - ${BILL_PAID} AS n FROM vendor_bills b WHERE b.id = ?`).bind(billID).first<{ n: number }>()
    return created({ voucher_no: v.voucherNo, amount_paise: amount, tds_paise: tds, outstanding_paise: p(after?.n) })
  }))

  // --- petty cash --------------------------------------------------------

  r.get(`${F}/ledgers/petty-cash`, READ, fin(async (c) => {
    const s = await c.db.prepare(`
      SELECT s.petty_cash_limit_paise, s.petty_cash_float_paise, u.full_name AS custodian,
             COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise) FROM journal_lines l WHERE l.account_id = s.petty_cash_account_id), 0) AS balance
        FROM ledger_settings s LEFT JOIN users u ON u.id = s.petty_cash_custodian_id WHERE s.institution_id = ?`).bind(inst(c)).first<Record<string, unknown>>()
    const limit = p(s?.petty_cash_limit_paise), float = p(s?.petty_cash_float_paise), balance = p(s?.balance)
    const custodian = (s?.custodian as string | null | undefined) ?? null
    const [topups, counts, vouchers] = await Promise.all([
      c.db.prepare(`SELECT t.id, t.topup_date, t.amount_paise, a.code || ' ' || a.name AS frm, t.reference_no, t.note, u.full_name AS by, e.voucher_no
          FROM petty_cash_topups t JOIN ledger_accounts a ON a.id = t.from_account_id
          LEFT JOIN users u ON u.id = t.created_by LEFT JOIN journal_entries e ON e.id = t.journal_entry_id
         ORDER BY t.topup_date DESC, t.created_at DESC LIMIT 20`).all<Record<string, unknown>>(),
      c.db.prepare(`SELECT c.id, c.counted_on, c.book_paise, c.counted_paise, COALESCE(c.variance_paise, c.counted_paise - c.book_paise) AS variance_paise,
            c.variance_reason, u.full_name AS by
          FROM petty_cash_counts c LEFT JOIN users u ON u.id = c.counted_by
         ORDER BY c.counted_on DESC, c.created_at DESC LIMIT 20`).all<Record<string, unknown>>(),
      c.db.prepare(`SELECT p.id, p.voucher_no, p.voucher_date, p.payee, p.particulars, p.amount_paise, a.code, a.name, p.status,
            (p.amount_paise > COALESCE(s.petty_cash_limit_paise, 0)) AS needs_approval,
            ap.full_name AS approved_by, cr.full_name AS raised_by, p.rejected_reason, e.voucher_no AS journal_vno, (p.file_id IS NOT NULL) AS has_receipt
          FROM petty_cash_vouchers p
          JOIN ledger_accounts a ON a.id = p.expense_account_id
          LEFT JOIN ledger_settings s ON s.institution_id = p.institution_id
          LEFT JOIN users ap ON ap.id = p.approved_by
          LEFT JOIN users cr ON cr.id = p.created_by
          LEFT JOIN journal_entries e ON e.id = p.journal_entry_id
         ORDER BY (p.status = 'pending') DESC, p.voucher_date DESC, p.voucher_no DESC LIMIT 300`).all<Record<string, unknown>>(),
    ])
    // Replenish-to-float: zero when no float is set, or the tin already holds at least the float.
    let replenish = float - balance
    if (float === 0 || replenish < 0) replenish = 0
    return ok({
      items: vouchers.results.map((v) => ({
        id: str(v.id), voucher_no: str(v.voucher_no), voucher_date: str(v.voucher_date), payee: str(v.payee), particulars: str(v.particulars),
        amount_paise: p(v.amount_paise), expense_code: str(v.code), expense_name: str(v.name), status: str(v.status), needs_approval: bool(v.needs_approval),
        approved_by: opt(v.approved_by as string | null), raised_by: opt(v.raised_by as string | null), rejected_reason: opt(v.rejected_reason as string | null),
        journal_voucher_no: opt(v.journal_vno as string | null), has_receipt: bool(v.has_receipt),
      })),
      limit_paise: limit, balance_paise: balance, float_paise: float, custodian, replenish_paise: replenish,
      topups: topups.results.map((t) => ({
        id: str(t.id), topup_date: str(t.topup_date), amount_paise: p(t.amount_paise), from: str(t.frm), reference_no: t.reference_no ?? null,
        note: t.note ?? null, by: t.by ?? null, journal_voucher_no: t.voucher_no ?? null,
      })),
      counts: counts.results.map((k) => ({
        id: str(k.id), counted_on: str(k.counted_on), book_paise: p(k.book_paise), counted_paise: p(k.counted_paise),
        variance_paise: p(k.variance_paise), variance_reason: k.variance_reason ?? null, by: k.by ?? null,
      })),
    })
  }))

  r.post(`${F}/ledgers/petty-cash`, POST, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (!isUUID(req.expense_account_id)) throw badRequest('expense_account_id must be a uuid')
    const payee = str(req.payee).trim(), particulars = str(req.particulars).trim()
    if (payee === '' || particulars === '') throw badRequest('a voucher needs a payee and what it was for')
    const amount = int64(req.amount_paise, 'amount_paise')
    if (amount <= 0) throw badRequest('amount_paise must be greater than zero')
    const date = dateOr(req.voucher_date, today(), 'voucher_date must be YYYY-MM-DD')
    const ctl = await loadControls(c)
    requireControls([ctl.pettyCash, 'petty cash'])
    const s = await c.db.prepare(`SELECT petty_cash_limit_paise FROM ledger_settings WHERE institution_id = ?`).bind(inst(c)).first<{ petty_cash_limit_paise: number }>()
    if (!s) throw notFound()
    const needsApproval = amount > p(s.petty_cash_limit_paise)
    const fileId = str(req.file_id)
    if (fileId !== '' && !isUUID(fileId)) throw badRequest('file_id must be a uuid')
    const series = 'PC/' + fyLabel(fyOf(date)) + '/'
    const voucherNo = await nextInSeries(c, 'petty_cash_vouchers', 'voucher_no', series, 4, false)
    const id = uuid()
    await runBatch(c, [c.db.prepare(`INSERT INTO petty_cash_vouchers (id, institution_id, voucher_no, voucher_date, payee, particulars, amount_paise,
        expense_account_id, paid_from_account_id, file_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(id, inst(c), voucherNo, date, payee, particulars, amount, req.expense_account_id, ctl.pettyCash, fileId || null, actor(c), now())])
    return created({ id, voucher_no: voucherNo, status: 'pending', needs_approval: needsApproval })
  }))

  // The float (petty_cash_float.go). Literal paths before {id}.
  r.post(`${F}/ledgers/petty-cash/topup`, POST, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const amount = int64(req.amount_paise, 'amount_paise')
    if (amount <= 0) throw badRequest('amount_paise must be greater than zero')
    const from = str(req.from).trim().toLowerCase()
    if (from !== 'bank' && from !== 'cash') throw badRequest("from must be 'bank' or 'cash'")
    const ref = str(req.reference_no).trim()
    // A bank withdrawal with no reference cannot be matched to the statement.
    if (from === 'bank' && ref === '') throw badRequest('reference_no (cheque or withdrawal reference) is required for a bank top-up')
    const date = dateOr(req.topup_date, today(), 'topup_date must be YYYY-MM-DD')
    const ctl = await loadControls(c)
    const source = from === 'cash' ? ctl.cash : ctl.bank
    requireControls([ctl.pettyCash, 'petty cash'], [source, from])
    await requireOpenPeriod(c, date)
    const topupID = uuid()
    let narration = `Petty cash top-up from ${from}`
    if (ref !== '') narration += ' (' + ref + ')'
    const post = new Posting(c)
    const v = await post.voucher('payment', 'PV', date, narration, 'petty_cash_topup', topupID, [
      { accountId: ctl.pettyCash, debit: amount, memo: 'Float replenished' },
      { accountId: source, credit: amount },
    ])
    post.add(c.db.prepare(`INSERT INTO petty_cash_topups (id, institution_id, topup_date, amount_paise, from_account_id, reference_no, note, journal_entry_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(topupID, inst(c), date, amount, source, nullIf(ref), nullIf(req.note), v.id, actor(c), now()))
    await post.run()
    return created({ id: topupID, journal_voucher_no: v.voucherNo, balance_paise: await accountBalance(c, ctl.pettyCash) })
  }))

  r.post(`${F}/ledgers/petty-cash/count`, POST, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const counted = int64(req.counted_paise, 'counted_paise')
    if (counted < 0) throw badRequest('counted_paise cannot be negative')
    const on = dateOr(req.counted_on, today(), 'counted_on must be YYYY-MM-DD')
    const ctl = await loadControls(c)
    requireControls([ctl.pettyCash, 'petty cash'])
    const book = await accountBalance(c, ctl.pettyCash)
    const reason = str(req.variance_reason).trim()
    if (counted !== book && reason === '') throw badRequest(`the drawer holds ${indianRupees(counted)} and the book says ${indianRupees(book)} -- say why they differ`)
    const id = uuid()
    const variance = counted - book
    await runBatch(c, [c.db.prepare(`INSERT INTO petty_cash_counts (id, institution_id, counted_on, book_paise, counted_paise, variance_paise, variance_reason, counted_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, inst(c), on, book, counted, variance, nullIf(reason), actor(c), now())])
    return created({ id, book_paise: book, counted_paise: counted, variance_paise: variance })
  }))

  r.put(`${F}/ledgers/petty-cash/float`, POST, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const float = int64(req.float_paise, 'float_paise')
    if (float < 0) throw badRequest('float_paise cannot be negative')
    const cust = str(req.custodian_id).trim()
    if (cust !== '' && !isUUID(cust)) throw badRequest('custodian_id must be a uuid')
    const res = await c.db.prepare(`UPDATE ledger_settings SET petty_cash_float_paise = ?2, petty_cash_custodian_id = ?3 WHERE institution_id = ?1`)
      .bind(inst(c), float, cust || null).run()
    if ((res.meta.changes ?? 0) === 0) throw badRequest('the ledger is not set up yet: open the chart of accounts screen first')
    return ok({ float_paise: float })
  }))

  r.post(`${F}/ledgers/petty-cash/{id}/decide`, POST, fin(async (c) => {
    const voucherID = c.params.id
    if (!isUUID(voucherID)) throw badRequest('invalid voucher id')
    const req = await readJSON<Record<string, unknown>>(c.req)
    const approve = !!req.approve
    const reason = str(req.reason).trim()
    if (!approve && reason === '') throw badRequest('say why the claim is refused')
    const v = await c.db.prepare(`SELECT status, payee, particulars, amount_paise, expense_account_id, paid_from_account_id, voucher_date, created_by
        FROM petty_cash_vouchers WHERE id = ?`).bind(voucherID).first<Record<string, unknown>>()
    if (!v) throw notFound()
    if (v.status !== 'pending') throw badRequest(`the voucher is already ${str(v.status)}`)
    const amount = p(v.amount_paise); const pettyID = str(v.paid_from_account_id)
    if (!approve) {
      await runBatch(c, [c.db.prepare(`UPDATE petty_cash_vouchers SET status = 'rejected', rejected_reason = ?2, approved_by = ?3, approved_at = ?4 WHERE id = ?1 AND status = 'pending'`)
        .bind(voucherID, reason, actor(c), now())])
      return ok({ id: voucherID, status: 'rejected' })
    }
    /* Above the limit the approver must be somebody else, and the tin cannot pay out what it does not hold. */
    const s = await c.db.prepare(`SELECT petty_cash_limit_paise FROM ledger_settings WHERE institution_id = ?`).bind(inst(c)).first<{ petty_cash_limit_paise: number }>()
    if (!s) throw notFound()
    const limit = p(s.petty_cash_limit_paise)
    const balance = await accountBalance(c, pettyID)
    if (amount > limit && v.created_by && v.created_by === c.id.userId) {
      throw badRequest(`above the ${indianRupees(limit)} limit a slip needs a second signature -- somebody other than the person who raised it must approve it`)
    }
    if (balance < amount) throw badRequest(`the tin holds ${indianRupees(balance)} and this slip is ${indianRupees(amount)} -- top up the float first`)
    const post = new Posting(c)
    const jv = await post.voucher('payment', 'PV', str(v.voucher_date), `Petty cash, ${str(v.particulars)} (${str(v.payee)})`, 'petty_cash', voucherID, [
      { accountId: str(v.expense_account_id), debit: amount, memo: str(v.payee) },
      { accountId: pettyID, credit: amount },
    ])
    post.add(c.db.prepare(`UPDATE petty_cash_vouchers SET status = 'approved', approved_by = ?2, approved_at = ?3, journal_entry_id = ?4 WHERE id = ?1 AND status = 'pending'`)
      .bind(voucherID, actor(c), now(), jv.id))
    await post.run()
    return ok({ id: voucherID, status: 'approved', journal_voucher_no: jv.voucherNo })
  }))

  // --- assets ------------------------------------------------------------

  r.get(`${F}/ledgers/assets`, READ, fin(async (c) => {
    const rows = await c.db.prepare(`
      SELECT f.id, f.tag_no, f.name, f.category, a.code AS account_code, a.name AS account_name, f.purchased_on, f.cost_paise, f.salvage_paise,
             f.method, f.useful_life_years, f.wdv_rate_percent, f.location, v.name AS vendor_name, f.status, f.disposed_on,
             COALESCE((SELECT sum(dc.charge_paise) FROM depreciation_charges dc WHERE dc.asset_id = f.id), 0) AS charged,
             (SELECT count(*) FROM depreciation_charges dc WHERE dc.asset_id = f.id) AS years
        FROM fixed_assets f
        JOIN ledger_accounts a ON a.id = f.asset_account_id
        LEFT JOIN vendors v ON v.id = f.vendor_id
       ORDER BY f.status, f.purchased_on DESC LIMIT 500`).all<Record<string, unknown>>()
    const t = today()
    const ageYears = (purchased: string): number => {
      // extract(year FROM age(CURRENT_DATE, purchased_on)): whole years elapsed.
      const py = Number(purchased.slice(0, 4)); const ty = Number(t.slice(0, 4))
      let y = ty - py
      if (t.slice(5) < purchased.slice(5)) y -= 1
      return Math.max(0, y)
    }
    return ok(items(rows.results.map((f) => ({
      id: str(f.id), tag_no: str(f.tag_no), name: str(f.name), category: str(f.category), account_code: str(f.account_code), account_name: str(f.account_name),
      purchased_on: str(f.purchased_on), cost_paise: p(f.cost_paise), salvage_paise: p(f.salvage_paise), method: str(f.method),
      useful_life_years: optInt(f.useful_life_years), wdv_rate_percent: f.wdv_rate_percent === null || f.wdv_rate_percent === undefined ? undefined : String(f.wdv_rate_percent),
      location: opt(f.location as string | null), vendor_name: opt(f.vendor_name as string | null), status: str(f.status), disposed_on: opt(f.disposed_on as string | null),
      accumulated_depreciation_paise: p(f.charged), written_down_value_paise: p(f.cost_paise) - p(f.charged), years_charged: p(f.years),
      age_years: ageYears(str(f.purchased_on)),
    }))))
  }))

  r.post(`${F}/ledgers/assets`, POST, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (!isUUID(req.asset_account_id)) throw badRequest('asset_account_id must be a uuid')
    const name = str(req.name).trim()
    if (name === '') throw badRequest('an asset needs a name')
    const cost = int64(req.cost_paise, 'cost_paise')
    if (cost <= 0) throw badRequest('cost_paise must be greater than zero')
    if (!isDate(req.purchased_on)) throw badRequest('purchased_on must be YYYY-MM-DD')
    const purchased = req.purchased_on
    const category = str(req.category) || 'equipment'
    let quantity = Number(req.quantity); if (!Number.isInteger(quantity) || quantity <= 0) quantity = 1
    const salvage = int64(req.salvage_paise, 'salvage_paise')
    let method = str(req.method)
    if (method === '') {
      const s = await c.db.prepare(`SELECT default_depreciation_method FROM ledger_settings WHERE institution_id = ?`).bind(inst(c)).first<{ default_depreciation_method: string }>()
      method = s?.default_depreciation_method || 'straight_line'
    }
    // Each method needs its own input; supply the conventional default rather than failing.
    let life: number | null = null; let rate: string | null = null
    if (method === 'wdv') {
      rate = str(req.wdv_rate_percent) || '15.00'
    } else {
      method = 'straight_line'
      let l = Number(req.useful_life_years); if (!Number.isInteger(l) || l <= 0) l = 10
      life = l
    }
    const vendorId = str(req.vendor_id)
    if (vendorId !== '' && !isUUID(vendorId)) throw badRequest('vendor_id must be a uuid')
    const tag = str(req.tag_no).trim() || await nextInSeries(c, 'fixed_assets', 'tag_no', 'FA/', 5, true)
    const id = uuid()
    const post = new Posting(c)
    post.add(c.db.prepare(`INSERT INTO fixed_assets (id, institution_id, tag_no, name, category, asset_account_id, purchased_on, cost_paise, salvage_paise, method,
        useful_life_years, wdv_rate_percent, location, vendor_id, invoice_ref, quantity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_use', ?)`)
      .bind(id, inst(c), tag, name, category, req.asset_account_id, purchased, cost, salvage, method, life, rate, nullIf(req.location), vendorId || null, nullIf(req.invoice_ref), quantity, now()))
    const capitalise = !!req.capitalise
    let voucherNo = ''
    if (capitalise) {
      const ctl = await loadControls(c)
      let funded = ctl.bank
      const f = str(req.funded_from_account_id)
      if (f !== '') { if (!isUUID(f)) throw badRequest('funded_from_account_id must be a uuid'); funded = f }
      if (!funded) throw badRequest('no bank account is set: choose one, or name funded_from_account_id')
      const v = await post.voucher('purchase', 'PJ', purchased, `Capitalised ${name} (${tag})`, 'fixed_asset', id, [
        { accountId: req.asset_account_id as string, debit: cost, memo: tag },
        { accountId: funded, credit: cost },
      ])
      voucherNo = v.voucherNo
    }
    await post.run()
    const out: Record<string, unknown> = { id, tag_no: tag, capitalised: capitalise }
    if (voucherNo !== '') out.voucher_no = voucherNo
    return created(out)
  }))

  r.post(`${F}/ledgers/assets/depreciate`, POST, fin(async (c) => {
    const text = await c.req.text()
    let req: Record<string, unknown> = {}
    if (text.trim() !== '') { try { req = JSON.parse(text) } catch { throw badRequest('malformed JSON body') } }
    let fy = Number(req.fy_start_year); if (!Number.isInteger(fy) || fy === 0) fy = currentFY()
    const dryRun = !!req.dry_run
    const { start, end } = fyRange(fy)
    const ctl = await loadControls(c)
    requireControls([ctl.depreciation, 'depreciation'], [ctl.accumulated, 'accumulated depreciation'])
    const rows = await c.db.prepare(`
      SELECT f.id, f.tag_no, f.name, f.method, f.cost_paise, f.salvage_paise, f.useful_life_years, COALESCE(f.wdv_rate_percent, 0) AS rate, f.purchased_on,
             COALESCE((SELECT sum(dc.charge_paise) FROM depreciation_charges dc WHERE dc.asset_id = f.id AND dc.fy_start_year < ?2), 0) AS prior,
             EXISTS (SELECT 1 FROM depreciation_charges dc WHERE dc.asset_id = f.id AND dc.fy_start_year = ?2) AS already
        FROM fixed_assets f
       WHERE f.purchased_on <= ?3 AND (f.status = 'in_use' OR f.disposed_on > ?1)
       ORDER BY f.tag_no`).bind(start, fy, end).all<Record<string, unknown>>()
    type DLine = { asset_id: string; tag_no: string; name: string; method: string; opening_wdv_paise: number; charge_paise: number; closing_wdv_paise: number; note?: string }
    const lines: DLine[] = []
    const queue: { id: string; line: DLine; opening: number; charge: number; closing: number }[] = []
    let total = 0
    for (const f of rows.results) {
      const cost = p(f.cost_paise), salvage = p(f.salvage_paise), prior = p(f.prior)
      const life = f.useful_life_years === null || f.useful_life_years === undefined ? null : p(f.useful_life_years)
      const rate = Number(f.rate) || 0
      const purchased = str(f.purchased_on)
      const l: DLine = { asset_id: str(f.id), tag_no: str(f.tag_no), name: str(f.name), method: str(f.method), opening_wdv_paise: 0, charge_paise: 0, closing_wdv_paise: 0 }
      const opening = cost - prior
      l.opening_wdv_paise = opening
      if (bool(f.already)) l.note = 'already charged for ' + fyLabel(fy)
      else if (opening <= salvage) l.note = 'fully depreciated'
      else {
        let charge = 0
        const firstYear = purchased >= start && purchased <= end
        if (l.method === 'wdv') {
          charge = Math.trunc(opening * Math.trunc(rate * 100) / 10000)
          if (firstYear && daysBetween(purchased, end) < 180) {
            // The Income Tax half-rate rule: fewer than 180 days in use in the year of acquisition.
            charge = Math.trunc(charge / 2)
            l.note = 'half rate: in use under 180 days'
          }
        } else {
          let annual = cost - salvage
          annual = life !== null && life > 0 ? Math.trunc(annual / life) : 0
          charge = annual
          if (firstYear) {
            // Pro-rata by days held, as the Companies Act schedule requires.
            const days = daysBetween(purchased, end) + 1
            if (days < 365) { charge = Math.trunc(annual * days / 365); l.note = `pro-rated for ${days} days` }
          }
        }
        // Never below salvage, never below nil.
        if (charge > opening - salvage) charge = opening - salvage
        if (charge < 0) charge = 0
        l.charge_paise = charge
        l.closing_wdv_paise = opening - charge
        if (charge > 0) { queue.push({ id: l.asset_id, line: l, opening, charge, closing: opening - charge }); total += charge }
        else if (!l.note) l.note = 'nothing to charge'
      }
      if (l.closing_wdv_paise === 0 && l.charge_paise === 0) l.closing_wdv_paise = opening
      lines.push(l)
    }
    let voucherNo = ''
    if (!dryRun && total !== 0) {
      const post = new Posting(c)
      const v = await post.voucher('depreciation', 'DV', end, `Depreciation for ${fyLabel(fy)} on ${queue.length} asset(s)`, '', null, [
        { accountId: ctl.depreciation, debit: total },
        { accountId: ctl.accumulated, credit: total, memo: 'accumulated' },
      ])
      voucherNo = v.voucherNo
      for (const q of queue) {
        post.add(c.db.prepare(`INSERT INTO depreciation_charges (id, institution_id, asset_id, fy_start_year, method, opening_wdv_paise, charge_paise, closing_wdv_paise, journal_entry_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst(c), q.id, fy, q.line.method, q.opening, q.charge, q.closing, v.id, now()))
      }
      await post.run()
    }
    return ok({ fy_start_year: fy, fy_label: fyLabel(fy), dry_run: dryRun, charge_paise: total, voucher_no: voucherNo, assets: lines })
  }))

  // --- budgets -----------------------------------------------------------

  r.get(`${F}/ledgers/budgets`, READ, fin(async (c) => {
    const fy = fyFrom(c)
    const { start, end } = fyRange(fy)
    const b = await c.db.prepare(`SELECT id, name, status FROM budgets WHERE institution_id = ? AND fy_start_year = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(inst(c), fy).first<{ id: string; name: string; status: string }>()
    const lines: Record<string, unknown>[] = []
    let allocated = 0, actual = 0
    if (b) {
      const rows = await c.db.prepare(`
        SELECT bl.id, a.id AS account_id, a.code, a.name, a.type, d.name AS department, d.id AS department_id, bl.allocated_paise, bl.revised_paise, bl.notes,
               COALESCE((SELECT sum(CASE WHEN a.type = 'income' THEN l.credit_paise - l.debit_paise ELSE l.debit_paise - l.credit_paise END)
                           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                          WHERE l.account_id = bl.account_id AND e.entry_date BETWEEN ?2 AND ?3 AND e.voucher_type <> 'closing'), 0) AS spent
          FROM budget_lines bl
          JOIN ledger_accounts a ON a.id = bl.account_id
          LEFT JOIN departments d ON d.id = bl.department_id
         WHERE bl.budget_id = ?1
         ORDER BY a.code`).bind(b.id, start, end).all<Record<string, unknown>>()
      for (const r of rows.results) {
        const alloc = p(r.allocated_paise); const revised = optInt(r.revised_paise); const act = p(r.spent)
        const inForce = revised ?? alloc
        const usedPercent = inForce > 0 ? Math.trunc(act * 100 / inForce) : 0
        const state = inForce === 0 ? 'unbudgeted' : act > inForce ? 'overspent' : usedPercent >= 90 ? 'at the limit' : 'within budget'
        allocated += inForce; actual += act
        lines.push({
          id: str(r.id), account_id: str(r.account_id), code: str(r.code), name: str(r.name), type: str(r.type),
          department: opt(r.department as string | null), department_id: opt(r.department_id as string | null),
          allocated_paise: alloc, revised_paise: revised, actual_paise: act, variance_paise: inForce - act, used_percent: usedPercent,
          state, notes: opt(r.notes as string | null),
        })
      }
    }
    return ok({
      fy_start_year: fy, fy_label: fyLabel(fy), budget_id: b?.id ?? '', name: b?.name ?? '', status: b?.status ?? '',
      items: lines, allocated_paise: allocated, actual_paise: actual, variance_paise: allocated - actual,
    })
  }))

  r.post(`${F}/ledgers/budgets`, MASTERS, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    let fy = Number(req.fy_start_year); if (!Number.isInteger(fy) || fy === 0) fy = currentFY()
    const name = str(req.name) || 'Annual budget'
    const status = str(req.status) || 'draft'
    const approvedBy = status !== 'draft' ? actor(c) : null
    const approvedAt = status !== 'draft' ? now() : null
    await runBatch(c, [c.db.prepare(`INSERT INTO budgets (id, institution_id, fy_start_year, name, status, notes, approved_by, approved_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id, fy_start_year, name) DO UPDATE SET status = excluded.status, notes = excluded.notes,
          approved_by = COALESCE(excluded.approved_by, budgets.approved_by), approved_at = COALESCE(excluded.approved_at, budgets.approved_at)`)
      .bind(uuid(), inst(c), fy, name, status, nullIf(req.notes), approvedBy, approvedAt, now())])
    const b = await c.db.prepare(`SELECT id FROM budgets WHERE institution_id = ? AND fy_start_year = ? AND name = ?`).bind(inst(c), fy, name).first<{ id: string }>()
    return created({ id: b?.id ?? '', fy_start_year: fy })
  }))

  r.post(`${F}/ledgers/budgets/lines`, MASTERS, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (!isUUID(req.account_id)) throw badRequest('account_id must be a uuid')
    const allocated = int64(req.allocated_paise, 'allocated_paise')
    if (allocated < 0) throw badRequest('an allocation cannot be negative')
    const revised = req.revised_paise === null || req.revised_paise === undefined ? null : int64(req.revised_paise, 'revised_paise')
    let budgetID = str(req.budget_id)
    const stmts: D1PreparedStatement[] = []
    if (budgetID !== '') {
      if (!isUUID(budgetID)) throw badRequest('budget_id must be a uuid')
    } else {
      let fy = Number(req.fy_start_year); if (!Number.isInteger(fy) || fy === 0) fy = currentFY()
      // The budget for the year, created on first use.
      const b = await c.db.prepare(`SELECT id FROM budgets WHERE institution_id = ? AND fy_start_year = ? AND name = 'Annual budget'`).bind(inst(c), fy).first<{ id: string }>()
      if (b) budgetID = b.id
      else {
        budgetID = uuid()
        stmts.push(c.db.prepare(`INSERT INTO budgets (id, institution_id, fy_start_year, created_at) VALUES (?, ?, ?, ?)`).bind(budgetID, inst(c), fy, now()))
      }
    }
    const dept = str(req.department_id)
    if (dept !== '' && !isUUID(dept)) throw badRequest('department_id must be a uuid')
    // budget_lines_one_per_account: one line per (budget, account, department).
    const cur = await c.db.prepare(`SELECT id FROM budget_lines WHERE budget_id = ? AND account_id = ? AND COALESCE(department_id, '') = ?`)
      .bind(budgetID, req.account_id, dept).first<{ id: string }>()
    let id: string
    if (cur) {
      id = cur.id
      stmts.push(c.db.prepare(`UPDATE budget_lines SET allocated_paise = ?2, revised_paise = ?3, notes = ?4 WHERE id = ?1`).bind(id, allocated, revised, nullIf(req.notes)))
    } else {
      id = uuid()
      stmts.push(c.db.prepare(`INSERT INTO budget_lines (id, institution_id, budget_id, account_id, department_id, allocated_paise, revised_paise, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst(c), budgetID, req.account_id, dept || null, allocated, revised, nullIf(req.notes)))
    }
    await runBatch(c, stmts)
    return created({ id })
  }))

  // --- reports -----------------------------------------------------------

  r.get(`${F}/ledgers/daybook`, READ, fin(async (c) => {
    const on = dateOr(c.url.searchParams.get('on'), today(), 'on must be YYYY-MM-DD')
    const rows = await c.db.prepare(`${VOUCHER_SELECT},
             COALESCE((SELECT group_concat(x, ' / ') FROM (SELECT a.code || ' ' || a.name AS x FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
                        WHERE l.entry_id = e.id ORDER BY l.line_no)), '') AS accounts,
             0 AS year_closed
        FROM journal_entries e LEFT JOIN users u ON u.id = e.posted_by
       WHERE e.entry_date = ?1
       ORDER BY e.voucher_type, e.voucher_no`).bind(on).all<Record<string, unknown>>()
    const list = rows.results.map(voucherRow)
    let total = 0
    for (const v of list) total += v.amount_paise
    return ok({ on, items: list, vouchers: list.length, total_paise: total })
  }))

  r.get(`${F}/ledgers/cashbook`, READ, fin(async (c) => {
    const q = c.url.searchParams
    const t = today()
    const from = dateOr(q.get('from'), t.slice(0, 8) + '01', 'from must be YYYY-MM-DD')
    const to = dateOr(q.get('to'), t, 'to must be YYYY-MM-DD')
    type CRow = { date: string; voucher_no: string; narration: string; contra: string; in_paise: number; out_paise: number; balance_paise: number }
    type CAcc = { account_id: string; code: string; name: string; opening_paise: number; in_paise: number; out_paise: number; closing_paise: number; entries: CRow[] }
    const accs = await c.db.prepare(`
      SELECT a.id, a.code, a.name,
             COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                        WHERE l.account_id = a.id AND e.entry_date < ?1), 0) AS opening
        FROM ledger_accounts a WHERE a.is_cash AND NOT a.is_group ORDER BY a.code`).bind(from).all<Record<string, unknown>>()
    const accounts: CAcc[] = []
    const byID = new Map<string, number>()
    for (const a of accs.results) {
      byID.set(str(a.id), accounts.length)
      accounts.push({ account_id: str(a.id), code: str(a.code), name: str(a.name), opening_paise: p(a.opening), in_paise: 0, out_paise: 0, closing_paise: 0, entries: [] })
    }
    const rows = await c.db.prepare(`
      SELECT l.account_id, e.entry_date AS date, e.voucher_no, e.narration, ${contraNames('e.id', 'l.account_id')} AS contra, l.debit_paise, l.credit_paise
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
       WHERE a.is_cash AND NOT a.is_group AND e.entry_date BETWEEN ?1 AND ?2
       ORDER BY e.entry_date, e.voucher_no, l.line_no`).bind(from, to).all<Record<string, unknown>>()
    for (const r of rows.results) {
      const i = byID.get(str(r.account_id))
      if (i === undefined) continue
      const a = accounts[i]
      const v: CRow = { date: str(r.date), voucher_no: str(r.voucher_no), narration: str(r.narration), contra: str(r.contra), in_paise: p(r.debit_paise), out_paise: p(r.credit_paise), balance_paise: 0 }
      a.in_paise += v.in_paise; a.out_paise += v.out_paise
      v.balance_paise = a.opening_paise + a.in_paise - a.out_paise
      a.entries.push(v)
    }
    let openTotal = 0, inTotal = 0, outTotal = 0, closeTotal = 0
    for (const a of accounts) {
      a.closing_paise = a.opening_paise + a.in_paise - a.out_paise
      openTotal += a.opening_paise; inTotal += a.in_paise; outTotal += a.out_paise; closeTotal += a.closing_paise
    }
    return ok({ from, to, accounts, totals: { opening_paise: openTotal, in_paise: inTotal, out_paise: outTotal, closing_paise: closeTotal } })
  }))

  r.get(`${F}/ledgers/tax-report`, READ, fin(async (c) => {
    const fy = fyFrom(c)
    const { start, end } = fyRange(fy)
    const vrows = await c.db.prepare(`
      SELECT v.name, v.gstin, v.pan, count(b.id) AS bills, COALESCE(sum(b.taxable_paise), 0) AS taxable, COALESCE(sum(b.tax_paise), 0) AS tax,
             COALESCE(sum((SELECT COALESCE(sum(vp.tds_paise), 0) FROM vendor_payments vp WHERE vp.bill_id = b.id)), 0) AS tds
        FROM vendors v
        JOIN vendor_bills b ON b.vendor_id = v.id AND b.status = 'approved' AND b.bill_date BETWEEN ?1 AND ?2
       GROUP BY v.id, v.name, v.gstin, v.pan
       ORDER BY sum(b.taxable_paise) DESC`).bind(start, end).all<Record<string, unknown>>()
    let taxable = 0, tax = 0, tds = 0
    const vendors = vrows.results.map((v) => {
      taxable += p(v.taxable); tax += p(v.tax); tds += p(v.tds)
      return { vendor_name: str(v.name), gstin: opt(v.gstin as string | null), pan: opt(v.pan as string | null), bills: p(v.bills), taxable_paise: p(v.taxable), tax_paise: p(v.tax), tds_paise: p(v.tds) }
    })
    // The statutory liability accounts: what is owed to the government and still sitting in the school's bank.
    const drows = await c.db.prepare(`
      SELECT a.code, a.name, COALESCE(p.name, '-') AS grp, COALESCE(sum(l.credit_paise) - sum(l.debit_paise), 0) AS paise
        FROM ledger_accounts a
        LEFT JOIN ledger_accounts p ON p.id = a.parent_id
        LEFT JOIN journal_lines l ON l.account_id = a.id
        LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.entry_date <= ?1
       WHERE a.code IN ('2130','2140','2150','2160','2170')
       GROUP BY a.id, a.code, a.name, p.name
       ORDER BY a.code`).bind(end).all<Record<string, unknown>>()
    const dues = drows.results.map((d) => ({ code: str(d.code), name: str(d.name), group: str(d.grp), paise: p(d.paise), is_group: false }))
    return ok({ fy_start_year: fy, fy_label: fyLabel(fy), from: start, to: end, vendors, statutory_dues: dues, taxable_paise: taxable, tax_paise: tax, tds_withheld_paise: tds })
  }))

  r.get(`${F}/ledgers/audit-report`, READ, fin(async (c) => {
    const fy = fyFrom(c)
    const { start, end } = fyRange(fy)
    type Check = { check: string; detail: string; count: number; paise?: number; passing: boolean }
    const checks: Check[] = []
    const add = (check: string, detail: string, n: number, paise: number, passing: boolean) =>
      checks.push({ check, detail, count: n, paise: paise === 0 ? undefined : paise, passing })
    const one = async (sql: string, ...args: unknown[]) => {
      const r = await c.db.prepare(sql).bind(...args).first<{ n: number; amt?: number }>()
      return { n: p(r?.n), amt: p(r?.amt) }
    }
    let r = await one(`SELECT count(*) AS n FROM (SELECT l.entry_id FROM journal_lines l GROUP BY l.entry_id HAVING sum(l.debit_paise) <> sum(l.credit_paise)) x`)
    add('Every voucher balances', 'Debits equal credits on every entry in the books. Enforced by the database at commit; a failure here means a write went round the schema.', r.n, 0, r.n === 0)
    r = await one(`SELECT count(*) AS n FROM journal_entries e WHERE NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id)`)
    add('No empty vouchers', 'A voucher with no lines records nothing and hides a failed save.', r.n, 0, r.n === 0)
    r = await one(`SELECT count(*) AS n, COALESCE(sum(${BILL_TOTAL}), 0) AS amt FROM vendor_bills b WHERE b.status = 'approved' AND b.journal_entry_id IS NULL`)
    add('Approved bills are posted', 'An approved bill that never reached the ledger is a liability the balance sheet does not show.', r.n, r.amt, r.n === 0)
    r = await one(`SELECT count(*) AS n, COALESCE(sum(p.amount_paise), 0) AS amt FROM petty_cash_vouchers p WHERE p.status = 'approved' AND p.journal_entry_id IS NULL`)
    add('Approved petty cash is posted', 'Cash out of the tin with nothing in the ledger against it.', r.n, r.amt, r.n === 0)
    r = await one(`SELECT count(*) AS n, COALESCE(sum(x.excess), 0) AS amt FROM (
        SELECT b.id, COALESCE(sum(vp.amount_paise), 0) - ${BILL_TOTAL} AS excess FROM vendor_bills b LEFT JOIN vendor_payments vp ON vp.bill_id = b.id
         GROUP BY b.id, b.total_paise, b.taxable_paise, b.tax_paise HAVING COALESCE(sum(vp.amount_paise), 0) > ${BILL_TOTAL}) x`)
    add('No bill is overpaid', 'Paying more than a bill was for. Refused by the database on every payment.', r.n, r.amt, r.n === 0)
    r = await one(`SELECT count(*) AS n FROM (SELECT asset_id, fy_start_year FROM depreciation_charges GROUP BY asset_id, fy_start_year HAVING count(*) > 1) x`)
    add('Depreciation charged once a year', 'Running the annual sweep twice would halve the book value of the whole register.', r.n, 0, r.n === 0)
    r = await one(`SELECT count(*) AS n FROM fixed_assets f WHERE f.status = 'in_use'
        AND NOT EXISTS (SELECT 1 FROM depreciation_charges dc WHERE dc.asset_id = f.id AND dc.fy_start_year = ?1) AND f.purchased_on <= ?2`, fy, end)
    add('Depreciation is up to date', 'Assets in use that carry no charge for ' + fyLabel(fy) + '. Run the annual depreciation.', r.n, 0, r.n === 0)
    r = await one(`SELECT count(*) AS n, COALESCE(sum(l.debit_paise), 0) AS amt FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        JOIN ledger_accounts a ON a.id = l.account_id WHERE a.is_group AND e.entry_date BETWEEN ?1 AND ?2`, start, end)
    add('Nothing posted to a group heading', 'A posting against a heading rather than an account balances perfectly and reports nowhere useful.', r.n, r.amt, r.n === 0)
    r = await one(`SELECT count(*) AS n, COALESCE(sum(abs(x.gap)), 0) AS amt FROM (
        SELECT a.id, COALESCE((SELECT sum(f.cost_paise) FROM fixed_assets f WHERE f.asset_account_id = a.id AND f.status <> 'disposed'), 0)
                   - COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise) FROM journal_lines l WHERE l.account_id = a.id), 0) AS gap
          FROM ledger_accounts a
         WHERE a.institution_id = ?1 AND NOT a.is_group AND NOT a.is_contra AND EXISTS (SELECT 1 FROM fixed_assets f WHERE f.asset_account_id = a.id)) x
       WHERE x.gap <> 0`, inst(c))
    add('Asset register ties to the ledger', 'Cost in the register against the balance on the asset account. A gap means a purchase was never capitalised, or was booked to another head.', r.n, r.amt, r.n === 0)
    r = await one(`SELECT count(*) AS n FROM ledger_settings WHERE institution_id = ?1
        AND (cash_account_id IS NULL OR bank_account_id IS NULL OR payable_account_id IS NULL OR surplus_account_id IS NULL)`, inst(c))
    add('Control accounts are set', 'Cash, bank, creditors and the surplus account. The automatic postings refuse to guess.', r.n, 0, r.n === 0)
    const yrows = await c.db.prepare(`
      SELECT y.fy_start_year, y.status, y.closed_on, u.full_name AS closed_by, ce.voucher_no AS closing_vno, y.surplus_paise,
             COALESCE((SELECT count(*) FROM journal_entries e WHERE e.institution_id = y.institution_id AND e.fy_start_year = y.fy_start_year), 0) AS vouchers
        FROM accounting_years y LEFT JOIN users u ON u.id = y.closed_by LEFT JOIN journal_entries ce ON ce.id = y.closing_entry_id
       ORDER BY y.fy_start_year DESC`).all<Record<string, unknown>>()
    const years: YearRow[] = yrows.results.map((y) => ({
      id: '', fy_start_year: p(y.fy_start_year), fy_label: fyLabel(p(y.fy_start_year)), status: str(y.status), closed_on: opt(y.closed_on as string | null),
      closed_by: opt(y.closed_by as string | null), closing_voucher_no: opt(y.closing_vno as string | null), surplus_paise: optInt(y.surplus_paise),
      vouchers: p(y.vouchers), live_income_paise: 0, live_expense_paise: 0, live_surplus_paise: 0, can_close: false,
    }))
    const failing = checks.filter((k) => !k.passing).length
    return ok({ fy_start_year: fy, fy_label: fyLabel(fy), checks, years, failing, clean: failing === 0 })
  }))

  // --- the fee posting contract -------------------------------------------

  const feePosting = async (c: Ctx, preview: boolean) => {
    const fy = fyFrom(c)
    const range = fyRange(fy)
    const start = dateOrIgnore(c.url.searchParams.get('from'), range.start)
    const end = dateOrIgnore(c.url.searchParams.get('to'), range.end)
    type Item = { kind: string; source_id: string; reference: string; date: string; amount_paise: number; debit: string; credit: string; posted: boolean }
    const list: Item[] = []
    let posted = 0, skipped = 0, postedPaise = 0
    const ctl = await loadControls(c)
    requireControls([ctl.feeReceivable, 'fee receivable'], [ctl.feeIncome, 'fee income'], [ctl.cash, 'cash'], [ctl.bank, 'bank'])
    const byCode = async (code: string) => (await c.db.prepare(`SELECT id FROM ledger_accounts WHERE institution_id = ? AND code = ? AND NOT is_group`).bind(inst(c), code).first<{ id: string }>())?.id
    const fineAcc = (await byCode('4180')) ?? ctl.feeIncome
    const post = new Posting(c)

    // --- invoices: Dr receivable net, Cr income (gross less discount), Cr fines.
    const invs = await c.db.prepare(`
      SELECT i.id, i.invoice_no, i.issued_on, COALESCE(i.net_paise, i.gross_paise - i.discount_paise + i.fine_paise) AS net, i.gross_paise, i.discount_paise, i.fine_paise,
             EXISTS (SELECT 1 FROM journal_entries e WHERE e.institution_id = i.institution_id AND e.source_kind = 'fee_invoice' AND e.source_id = i.id) AS already
        FROM invoices i WHERE i.status NOT IN ('cancelled','draft') AND i.issued_on BETWEEN ?1 AND ?2
       ORDER BY i.issued_on, i.invoice_no`).bind(start, end).all<Record<string, unknown>>()
    for (const v of invs.results) {
      const net = p(v.net), already = bool(v.already), no = str(v.invoice_no), issued = str(v.issued_on)
      list.push({ kind: 'fee_invoice', source_id: str(v.id), reference: no, date: issued, amount_paise: net, debit: 'Fee Receivable', credit: 'Fee Income', posted: already })
      if (already || net <= 0) { skipped++; continue }
      if (preview) continue
      const lines: VLine[] = [{ accountId: ctl.feeReceivable, debit: net, memo: no }]
      const charged = p(v.gross_paise) - p(v.discount_paise)
      if (charged > 0) lines.push({ accountId: ctl.feeIncome, credit: charged })
      if (p(v.fine_paise) > 0) lines.push({ accountId: fineAcc, credit: p(v.fine_paise), memo: 'late fee' })
      await post.voucher('sales', 'SV', issued, 'Fee invoice ' + no, 'fee_invoice', str(v.id), lines)
      posted++; postedPaise += net
    }

    // --- payments: Dr cash/bank, Cr receivable. Revenue was recognised on the invoice.
    const pays = await c.db.prepare(`
      SELECT p.id, p.receipt_no, p.paid_on, p.amount_paise, p.mode,
             EXISTS (SELECT 1 FROM journal_entries e WHERE e.institution_id = p.institution_id AND e.source_kind = 'fee_payment' AND e.source_id = p.id) AS already
        FROM payments p WHERE p.status = 'success' AND p.paid_on BETWEEN ?1 AND ?2
       ORDER BY p.paid_on, p.receipt_no`).bind(start, end).all<Record<string, unknown>>()
    let writeOff: string | undefined | null = null
    for (const v of pays.results) {
      const ref = (v.receipt_no as string | null) ?? '-'
      const amount = p(v.amount_paise), already = bool(v.already)
      let into = ctl.bank, debitName = 'Bank'
      if (v.mode === 'cash') { into = ctl.cash; debitName = 'Cash in Hand' }
      else if (v.mode === 'adjustment') {
        if (writeOff === null) writeOff = await byCode('5920')
        if (writeOff) { into = writeOff; debitName = 'Fee Concessions and Write-offs' }
      }
      list.push({ kind: 'fee_payment', source_id: str(v.id), reference: ref, date: str(v.paid_on), amount_paise: amount, debit: debitName, credit: 'Fee Receivable', posted: already })
      if (already) { skipped++; continue }
      if (preview) continue
      await post.voucher('receipt', 'RV', str(v.paid_on), 'Fee receipt ' + ref, 'fee_payment', str(v.id), [
        { accountId: into, debit: amount, memo: ref },
        { accountId: ctl.feeReceivable, credit: amount },
      ])
      posted++; postedPaise += amount
    }

    // --- a cheque posted while it was good and dishonoured since: its own voucher, its own source key.
    const bounces = await c.db.prepare(`
      SELECT p.id, p.receipt_no, p.amount_paise, p.mode FROM payments p
       WHERE p.status = 'bounced'
         AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.institution_id = p.institution_id AND e.source_kind = 'fee_payment' AND e.source_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.institution_id = p.institution_id AND e.source_kind = 'fee_payment_reversal' AND e.source_id = p.id)`)
      .all<Record<string, unknown>>()
    const t = today()
    for (const v of bounces.results) {
      const ref = (v.receipt_no as string | null) ?? '-'
      const amount = p(v.amount_paise)
      list.push({ kind: 'fee_payment_reversal', source_id: str(v.id), reference: ref, date: t, amount_paise: amount, debit: 'Fee Receivable', credit: 'Bank', posted: false })
      if (preview) continue
      const from = v.mode === 'cash' ? ctl.cash : ctl.bank
      await post.voucher('journal', 'JV', t, 'Cheque dishonoured, receipt ' + ref, 'fee_payment_reversal', str(v.id), [
        { accountId: ctl.feeReceivable, debit: amount, memo: ref },
        { accountId: from, credit: amount },
      ])
      posted++
    }
    if (!preview) await post.run()

    // Newest first for the reviewer; the sweep itself ran oldest first.
    list.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0))
    const candidates = list.length
    const pending = list.filter((it) => !it.posted).length
    const shown = list.length > 300 ? list.slice(0, 300) : list
    return ok({
      fy_start_year: fy, fy_label: fyLabel(fy), from: start, to: end,
      preview, posted, already_posted: skipped, candidates, outstanding: pending, shown: shown.length,
      posted_paise: postedPaise, items: shown,
      contract: [
        { event: 'Invoice issued', debit: '1210 Fee Receivable', credit: '4110 Fee Income + 4180 Late Fee', amount: 'net of concession' },
        { event: 'Payment cleared', debit: '1310 Cash / 1330 Bank', credit: '1210 Fee Receivable', amount: 'amount received' },
        { event: 'Cheque dishonoured', debit: '1210 Fee Receivable', credit: '1310 Cash / 1330 Bank', amount: 'the reversed receipt' },
        { event: 'Fee adjustment', debit: '5920 Fee Concessions and Write-offs', credit: '1210 Fee Receivable', amount: 'amount adjusted' },
      ],
    })
  }
  r.get(`${F}/ledgers/fee-posting`, READ, fin((c) => feePosting(c, true)))
  r.post(`${F}/ledgers/fee-posting`, POST, fin((c) => feePosting(c, false)))
}
