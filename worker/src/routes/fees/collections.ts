import type { Router, Ctx } from '../../router'
import { badRequest, bool, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import {
  addDays, fin, isDate, isUniqueViolation, items, nowIST, paise, syncWallet, today, ymd,
} from './common'
import { school } from '../school'

/* Port of internal/api/collections.go: the canteen and store counters, the
   till cash-up, and grant-in-aid. Every route lives under /finance, so the
   group's InvoicesRead gate is kept by fin().

   Triggers re-implemented in the same batch as the write that fired them:
     pos_sale_lines_to_stock (00094)  a store line writes an inventory_movements
                                      row and carries its id
     inventory_movements_sync (00005) on_hand = the sum of the movement ledger
     wallet_transactions_sync (00322) balance = sum(delta); the "cannot go
                                      negative" RAISE is a pre-check here
     journal_lines_postable, journal_entries_year_open, journal_must_balance
                                      (00033) checked before the voucher batch
     invoices_touch (00001)           updated_at on the invoice a return reduces
   Generated columns Postgres kept (invoices.net_paise, journal_entries
   .fy_start_year) are plain columns here and are filled by hand. */

const refuse = (m: string) => badRequest(m)
const inst = (c: Ctx) => school(c).id
const nullStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const oneOf = (v: string, ...allowed: string[]) => allowed.includes(v)

/** nullBool: ?active=true|1|yes / false|0|no, anything else means "no filter". */
function nullBool(s: string | null): number | null {
  switch ((s ?? '').trim().toLowerCase()) {
    case 'true': case '1': case 'yes': return 1
    case 'false': case '0': case 'no': return 0
    default: return null
  }
}
/** queryUUID: blank is "no filter", a malformed id is a 400. */
function queryUUID(c: Ctx, name: string): string | null {
  const raw = (c.url.searchParams.get(name) ?? '').trim()
  if (raw === '') return null
  if (!isUUID(raw)) throw badRequest(`${name} is not a valid id`)
  return raw
}
/** optionalUUID: blank is nil, malformed is an error the caller words. */
function optionalUUID(raw: unknown, msg: string): string | null {
  const s = trim(raw)
  if (s === '') return null
  if (!isUUID(s)) throw refuse(msg)
  return s
}
/** pathUUID: a malformed path id is a 400 like the Go helper. */
const pathUUID = (c: Ctx): string => { const v = c.params.id; if (!isUUID(v)) throw badRequest('malformed id'); return v }

/** colMoney: the field must be present (the pointer is the point), non-negative, and positive unless allowZero. */
function colMoney(field: string, v: unknown, allowZero: boolean): number {
  if (v === undefined || v === null) throw refuse(`${field} is blank -- type the amount`)
  const n = paise(v, field)
  if (n < 0) throw refuse(`${field} cannot be negative`)
  if (n === 0 && !allowZero) throw refuse(`${field} must be more than nothing`)
  return n
}
/** An optional integer (Go *int): absent is null, a non-integer is a 400. */
function optInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v)) throw badRequest(`${field} must be a whole number`)
  return v
}
function optBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null) return def
  return v === true || v === 1 || v === 'true'
}

/** colDate: YYYY-MM-DD, defaulting to today in India. */
function colDate(raw: unknown): string {
  const s = trim(raw)
  if (s === '') return today()
  if (!isDate(s)) throw refuse('that date is not a date -- use YYYY-MM-DD')
  return s
}
/** colFY: the Indian financial year containing d, named by its starting year. */
function colFY(d: string): number { const y = Number(d.slice(0, 4)); const m = Number(d.slice(5, 7)); return m < 4 ? y - 1 : y }
const fyLabel = (fy: number) => `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const longDate = (s: string) => `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`
const colTitle = (v: string) => (v === '' ? v : v[0].toUpperCase() + v.slice(1))

/** indianRupees groups by the Indian convention: 1,80,000 rather than 180,000. Ported as is (it formats the raw integer). */
function indianRupees(n: number): string {
  const s = String(n)
  if (s.length <= 3) return s
  let head = s.slice(0, -3); const tail = s.slice(-3)
  const parts: string[] = []
  while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2) }
  if (head !== '') parts.unshift(head)
  return parts.join(',') + ',' + tail
}

/* ------------------------------------------------------------------------- */
/* Numbering (internal/fees NextNumberOn). Reads happen before the batch and
   the counter advances inside it; the UNIQUE (institution_id, receipt_no) on
   the document table is the backstop where Postgres had the row lock. */

interface NumberOut { text: string; seq: number; fy: string; stmts: D1PreparedStatement[] }

function renderNumber(format: string, prefix: string, fy: string, seq: number, padding: number, suffix: string): string {
  if (format === '') format = '{prefix}{fy}/{seq}{suffix}'
  if (fy === '') for (const d of ['{fy}/', '{fy}-', '/{fy}', '-{fy}']) format = format.split(d).join('')
  return format.split('{prefix}').join(prefix).split('{fy}').join(fy)
    .split('{seq}').join(String(seq).padStart(padding, '0')).split('{suffix}').join(suffix)
}

/** Creates the scheme row when missing (ON CONFLICT DO NOTHING in Go); never overrides a school's own prefix. */
async function ensureSeries(c: Ctx, kind: string, prefix: string): Promise<void> {
  await c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, padding, next_value, reset_yearly, updated_at)
      SELECT ?1, ?2, ?3, ?4, 5, 1, 1, ?5
       WHERE NOT EXISTS (SELECT 1 FROM numbering_schemes WHERE institution_id = ?2 AND kind = ?3 AND campus_id IS NULL)`)
    .bind(uuid(), inst(c), kind, prefix, now()).run()
}

async function nextNumberOn(c: Ctx, kind: string, on: string): Promise<NumberOut> {
  const defaults: Record<string, string> = { receipt: 'RCPT/', invoice: 'INV/' }
  await ensureSeries(c, kind, defaults[kind] ?? '')
  const s = await c.db.prepare(`SELECT prefix, suffix, padding, next_value, reset_yearly, current_fy, format
      FROM numbering_schemes WHERE institution_id = ?1 AND kind = ?2 AND campus_id IS NULL`).bind(inst(c), kind)
    .first<{ prefix: string; suffix: string; padding: number; next_value: number; reset_yearly: number; current_fy: string | null; format: string | null }>()
  if (!s) throw new Error(`lock numbering scheme ${kind}: missing`)
  const resetYearly = bool(s.reset_yearly)
  const currentFY = s.current_fy ?? ''
  let seq = Number(s.next_value)
  let fy = ''
  const stmts: D1PreparedStatement[] = []
  if (resetYearly) {
    fy = fyLabel(colFY(on))
    let seed = 1
    if (currentFY === '' || currentFY === fy) seed = seq
    else if (kind === 'receipt') {
      const last = await c.db.prepare(`SELECT max(receipt_seq) AS n FROM payments WHERE institution_id = ?1 AND receipt_fy = ?2`)
        .bind(inst(c), fy).first<{ n: number | null }>()
      if (last?.n !== null && last?.n !== undefined) seed = Number(last.n) + 1
    }
    await c.db.prepare(`INSERT OR IGNORE INTO numbering_fy_counters (institution_id, kind, fy, next_value) VALUES (?1, ?2, ?3, ?4)`)
      .bind(inst(c), kind, fy, seed).run()
    const ctr = await c.db.prepare(`SELECT next_value FROM numbering_fy_counters WHERE institution_id = ?1 AND kind = ?2 AND fy = ?3`)
      .bind(inst(c), kind, fy).first<{ next_value: number }>()
    seq = Number(ctr?.next_value ?? seed)
    stmts.push(c.db.prepare(`UPDATE numbering_fy_counters SET next_value = ?4 + 1 WHERE institution_id = ?1 AND kind = ?2 AND fy = ?3`)
      .bind(inst(c), kind, fy, seq))
  }
  const text = renderNumber(s.format ?? '', s.prefix ?? '', fy, seq, Number(s.padding ?? 5), s.suffix ?? '')
  const ts = now()
  if (!resetYearly || currentFY === '' || currentFY <= fy) {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET next_value = ?3 + 1, current_fy = NULLIF(?4, ''), last_number = ?5,
        last_issued_at = ?6, updated_at = ?6 WHERE institution_id = ?1 AND kind = ?2 AND campus_id IS NULL`).bind(inst(c), kind, seq, fy, text, ts))
  } else {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET last_number = ?3, last_issued_at = ?4, updated_at = ?4
        WHERE institution_id = ?1 AND kind = ?2 AND campus_id IS NULL`).bind(inst(c), kind, text, ts))
  }
  return { text, seq, fy, stmts }
}

/** colEnsurePosSeries: the till's own prefix, so a receipt never prints as "/2026-27/00001". */
const ensurePosSeries = (c: Ctx) => ensureSeries(c, 'pos', 'POS/')

/* ------------------------------------------------------------------------- */
/* Vouchers (ledgers.go postVoucher). The three ledger triggers are checked
   before the batch; the balance check was always done here first. */

interface VoucherLine { accountId: string; debit?: number; credit?: number; memo: string }
interface VoucherOut { entryId: string; voucherNo: string; stmts: D1PreparedStatement[] }

async function postVoucher(c: Ctx, voucherType: string, prefix: string, date: string, narration: string,
  sourceKind: string, sourceId: string | null, lines: VoucherLine[]): Promise<VoucherOut> {
  if (lines.length < 2) throw refuse(`a voucher needs at least two lines, got ${lines.length}`)
  let dr = 0; let cr = 0
  for (const l of lines) {
    const d = l.debit ?? 0; const k = l.credit ?? 0
    if (d < 0 || k < 0) throw refuse('a voucher line cannot be negative: use the other side')
    if (d > 0 && k > 0) throw refuse('a voucher line carries a debit or a credit, never both')
    dr += d; cr += k
  }
  if (dr !== cr) throw refuse(`voucher does not balance: debits ${indianRupees(dr)}, credits ${indianRupees(cr)}`)

  const fy = colFY(date)
  // journal_entries_year_open: a closed year does not move.
  const closed = await c.db.prepare(`SELECT 1 AS x FROM accounting_years WHERE institution_id = ?1 AND fy_start_year = ?2 AND status = 'closed'`)
    .bind(inst(c), fy).first()
  if (closed) throw refuse(`the books for ${fyLabel(fy)} are closed: post the correction in the current year`)
  // journal_lines_postable: groups and closed accounts take no postings.
  for (const l of lines) {
    const acc = await c.db.prepare(`SELECT code, name, is_group, is_active FROM ledger_accounts WHERE id = ?1 AND institution_id = ?2`)
      .bind(l.accountId, inst(c)).first<{ code: string; name: string; is_group: number; is_active: number }>()
    if (!acc) throw refuse('that refers to something which does not exist')
    if (bool(acc.is_group)) throw refuse(`account ${acc.code}  ${acc.name} is a group heading: post to one of its accounts instead`)
    if (!bool(acc.is_active)) throw refuse(`account ${acc.code}  ${acc.name} is closed to posting`)
  }
  // journal_entries_one_per_source.
  if (sourceKind !== '' && sourceId) {
    const dup = await c.db.prepare(`SELECT 1 AS x FROM journal_entries WHERE institution_id = ?1 AND source_kind = ?2 AND source_id = ?3`)
      .bind(inst(c), sourceKind, sourceId).first()
    if (dup) throw refuse('that already exists: journal_entries_one_per_source')
  }

  const series = `${prefix}/${fyLabel(fy)}/`
  const existing = await c.db.prepare(`SELECT voucher_no FROM journal_entries WHERE institution_id = ?1 AND voucher_no LIKE ?2`)
    .bind(inst(c), series.replace(/[%_\\]/g, (ch) => '\\' + ch) + '%').all<{ voucher_no: string }>()
  // LIKE without ESCAPE in Go; a prefix with % or _ is a school's own oddity. We escape and declare it.
  let max = 0
  for (const r of existing.results) { const m = /(\d+)$/.exec(r.voucher_no); if (m) max = Math.max(max, Number(m[1])) }
  const voucherNo = series + String(max + 1).padStart(4, '0')
  const entryId = uuid()
  const ts = now()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO accounting_years (id, institution_id, fy_start_year, created_at)
        SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM accounting_years WHERE institution_id = ?2 AND fy_start_year = ?3)`)
      .bind(uuid(), inst(c), fy, ts),
    c.db.prepare(`INSERT INTO journal_entries (id, institution_id, voucher_no, voucher_type, entry_date, fy_start_year, narration,
        source_kind, source_id, posted_by, posted_at) VALUES (?,?,?,?,?,?,?,NULLIF(?,''),?,?,?)`)
      .bind(entryId, inst(c), voucherNo, voucherType, date, fy, narration, sourceKind, sourceId, c.id.userId, ts),
  ]
  lines.forEach((l, i) => {
    stmts.push(c.db.prepare(`INSERT INTO journal_lines (id, institution_id, entry_id, account_id, line_no, debit_paise, credit_paise, memo)
        VALUES (?,?,?,?,?,?,?,NULLIF(?,''))`).bind(uuid(), inst(c), entryId, l.accountId, i + 1, l.debit ?? 0, l.credit ?? 0, l.memo))
  })
  return { entryId, voucherNo, stmts }
}

/* ------------------------------------------------------------------------- */
/* Wallet (wallet.go walletDebit / walletCredit). The account is read before
   the batch; the balance rule the trigger raised is the pre-check here. */

interface WalletOut { left: number; stmts: D1PreparedStatement[] }

async function walletDebit(c: Ctx, campus: string | null, studentId: string, amount: number, reference: string,
  note: string, posSaleId: string): Promise<WalletOut> {
  const w = await c.db.prepare(`SELECT id, status, balance_paise FROM wallet_accounts WHERE student_id = ?1`).bind(studentId)
    .first<{ id: string; status: string; balance_paise: number }>()
  if (!w) throw refuse('this child has no wallet yet -- top it up at the fee office first, or take another mode')
  if (w.status !== 'active') throw refuse(`this wallet is ${w.status} and cannot be spent from`)
  const balance = Number(w.balance_paise)
  if (balance < amount) throw refuse(`not enough in the wallet: ${indianRupees(balance)} left, ${indianRupees(amount)} needed`)
  // The trigger's own figure: the ledger sum, not the cached balance, must not go negative.
  const led = await c.db.prepare(`SELECT COALESCE(sum(delta_paise), 0) AS n FROM wallet_transactions WHERE wallet_id = ?1`).bind(w.id).first<{ n: number }>()
  if (Number(led?.n ?? 0) - amount < 0) throw refuse('not enough in the wallet')
  return {
    left: balance - amount,
    stmts: [
      c.db.prepare(`INSERT INTO wallet_transactions (id, institution_id, campus_id, wallet_id, student_id, kind, delta_paise,
          source_mode, reference_no, payment_id, pos_sale_id, note, created_by, created_at)
          VALUES (?,?,?,?,?,'spend',?,'wallet',NULLIF(?,''),NULL,?,NULLIF(?,''),?,?)`)
        .bind(uuid(), inst(c), campus, w.id, studentId, -amount, reference, posSaleId, note, c.id.userId, now()),
      syncWallet(c, w.id),
    ],
  }
}

async function walletCredit(c: Ctx, campus: string | null, studentId: string, amount: number, reference: string,
  note: string, posSaleId: string): Promise<WalletOut> {
  const w = await c.db.prepare(`SELECT id, status, balance_paise FROM wallet_accounts WHERE student_id = ?1`).bind(studentId)
    .first<{ id: string; status: string; balance_paise: number }>()
  if (!w) throw refuse("this child's wallet no longer exists -- refund in cash")
  if (w.status !== 'active') throw refuse(`this wallet is ${w.status} -- refund in cash rather than crediting it`)
  return {
    left: Number(w.balance_paise) + amount,
    stmts: [
      c.db.prepare(`INSERT INTO wallet_transactions (id, institution_id, campus_id, wallet_id, student_id, kind, delta_paise,
          source_mode, reference_no, pos_sale_id, note, created_by, created_at)
          VALUES (?,?,?,?,?,'refund',?,'wallet',NULLIF(?,''),?,NULLIF(?,''),?,?)`)
        .bind(uuid(), inst(c), campus, w.id, studentId, amount, reference, posSaleId, note, c.id.userId, now()),
      syncWallet(c, w.id),
    ],
  }
}

/* ------------------------------------------------------------------------- */
/* Settings. */

async function colTolerance(c: Ctx): Promise<number> {
  const r = await c.db.prepare(`SELECT variance_tolerance_paise FROM collections_settings WHERE institution_id = ?1`).bind(inst(c))
    .first<{ variance_tolerance_paise: number }>()
  return r ? Number(r.variance_tolerance_paise) : 5000
}

/* ------------------------------------------------------------------------- */
/* Till sessions: one query every session view is built from. */

const tillSessionSQL = `
  SELECT ts.id, ts.terminal_id, t.name AS terminal_name, t.kind AS terminal_kind,
         COALESCE(uo.full_name, '-') AS opened_by, ts.opened_at, ts.opening_float_paise, ts.status,
         uc.full_name AS closed_by, ts.closed_at, ts.counted_cash_paise, ts.expected_cash_paise,
         ts.paid_out_paise, ts.variance_paise, ts.variance_reason,
         COALESCE((SELECT sum(CASE WHEN sl.kind = 'sale' AND sl.payment_mode = 'cash' THEN sl.total_paise ELSE 0 END) FROM pos_sales sl WHERE sl.session_id = ts.id), 0) AS cash_sales,
         COALESCE((SELECT sum(CASE WHEN sl.kind = 'return' AND sl.payment_mode = 'cash' THEN sl.total_paise ELSE 0 END) FROM pos_sales sl WHERE sl.session_id = ts.id), 0) AS cash_returns,
         COALESCE((SELECT sum(CASE WHEN sl.kind = 'sale' AND sl.payment_mode = 'account' THEN sl.total_paise ELSE 0 END) FROM pos_sales sl WHERE sl.session_id = ts.id), 0) AS account_sales,
         COALESCE((SELECT sum(CASE WHEN sl.kind = 'sale' AND sl.payment_mode = 'wallet' THEN sl.total_paise ELSE 0 END) FROM pos_sales sl WHERE sl.session_id = ts.id), 0) AS wallet_sales,
         (SELECT count(*) FROM pos_sales sl WHERE sl.session_id = ts.id AND sl.kind = 'sale') AS sale_count,
         (SELECT count(*) FROM pos_sales sl WHERE sl.session_id = ts.id AND sl.kind = 'return') AS return_count
    FROM pos_till_sessions ts
    JOIN pos_terminals t ON t.id = ts.terminal_id
    LEFT JOIN users uo ON uo.id = ts.opened_by
    LEFT JOIN users uc ON uc.id = ts.closed_by`

type Row = Record<string, unknown>
const opt = <T>(v: unknown, o: Record<string, unknown>, key: string, map: (x: unknown) => T = (x) => x as T) => {
  if (v !== null && v !== undefined) o[key] = map(v)
}

function tillSessionView(r: Row, tol: number) {
  const v: Record<string, unknown> = {
    id: r.id, terminal_id: r.terminal_id, terminal_name: r.terminal_name, terminal_kind: r.terminal_kind,
    opened_by: r.opened_by, opened_at: r.opened_at, opening_float_paise: Number(r.opening_float_paise), status: r.status,
  }
  opt(r.closed_by, v, 'closed_by'); opt(r.closed_at, v, 'closed_at')
  opt(r.counted_cash_paise, v, 'counted_cash_paise', Number); opt(r.expected_cash_paise, v, 'expected_cash_paise', Number)
  v.paid_out_paise = Number(r.paid_out_paise ?? 0)
  v.variance_paise = Number(r.variance_paise ?? 0)
  opt(r.variance_reason, v, 'variance_reason')
  v.cash_sales_paise = Number(r.cash_sales); v.cash_returns_paise = Number(r.cash_returns)
  v.account_sales_paise = Number(r.account_sales); v.wallet_sales_paise = Number(r.wallet_sales)
  v.sale_count = Number(r.sale_count); v.return_count = Number(r.return_count)
  v.variance_tolerance_paise = tol
  return v
}

/* ------------------------------------------------------------------------- */
/* Sales. */

const posSaleSQL = `
  SELECT s.id, s.kind, s.channel, s.session_id, t.name AS terminal_name, s.original_sale_id, s.student_id,
         TRIM(st.first_name || ' ' || COALESCE(st.last_name, '')) AS student_name, s.buyer_name,
         s.sold_at, s.sold_on, s.payment_mode, s.subtotal_paise, s.discount_paise, s.tax_paise, s.total_paise,
         s.receipt_no, s.invoice_id, iv.invoice_no, u.full_name AS sold_by, s.remarks
    FROM pos_sales s
    JOIN pos_till_sessions ts ON ts.id = s.session_id
    JOIN pos_terminals t      ON t.id  = ts.terminal_id
    LEFT JOIN students st ON st.id = s.student_id
    LEFT JOIN invoices iv ON iv.id = s.invoice_id
    LEFT JOIN users u     ON u.id  = s.sold_by`

function posSaleView(r: Row) {
  const v: Record<string, unknown> = { id: r.id, kind: r.kind, channel: r.channel, session_id: r.session_id, terminal_name: r.terminal_name }
  opt(r.original_sale_id, v, 'original_sale_id'); opt(r.student_id, v, 'student_id'); opt(r.student_name, v, 'student_name'); opt(r.buyer_name, v, 'buyer_name')
  v.sold_at = r.sold_at; v.sold_on = r.sold_on; v.payment_mode = r.payment_mode
  v.subtotal_paise = Number(r.subtotal_paise); v.discount_paise = Number(r.discount_paise); v.tax_paise = Number(r.tax_paise); v.total_paise = Number(r.total_paise)
  v.receipt_no = r.receipt_no
  opt(r.invoice_id, v, 'invoice_id'); opt(r.invoice_no, v, 'invoice_no'); opt(r.sold_by, v, 'sold_by'); opt(r.remarks, v, 'remarks')
  return v
}

interface SaleLine {
  id: string; line_no: number; variant_id?: string; item_name: string; category: string; variant_label?: string
  quantity: number; unit_paise: number; discount_paise: number; tax_paise: number; line_paise: number; returned_quantity: number
}

/** colSaleLines: a sale's lines with how much of each has come back, summed from the return rows. */
async function colSaleLines(c: Ctx, saleId: string): Promise<SaleLine[]> {
  const rows = await c.db.prepare(`
    SELECT l.id, l.line_no, l.variant_id, l.item_name, l.category, l.variant_label, l.quantity, l.unit_paise,
           l.discount_paise, l.tax_paise, l.line_paise,
           COALESCE((SELECT sum(rl.quantity) FROM pos_sales rs JOIN pos_sale_lines rl ON rl.sale_id = rs.id
                      WHERE rs.original_sale_id = l.sale_id AND rs.kind = 'return'
                        AND COALESCE(rl.variant_id, '00000000-0000-0000-0000-000000000000') = COALESCE(l.variant_id, '00000000-0000-0000-0000-000000000000')
                        AND lower(trim(rl.item_name)) = lower(trim(l.item_name))), 0) AS returned_qty
      FROM pos_sale_lines l WHERE l.sale_id = ?1 ORDER BY l.line_no`).bind(saleId).all<Row>()
  return rows.results.map((r) => {
    const v: SaleLine = {
      id: String(r.id), line_no: Number(r.line_no), item_name: String(r.item_name), category: String(r.category),
      quantity: Number(r.quantity), unit_paise: Number(r.unit_paise), discount_paise: Number(r.discount_paise),
      tax_paise: Number(r.tax_paise), line_paise: Number(r.line_paise), returned_quantity: Number(r.returned_qty),
    }
    if (r.variant_id !== null && r.variant_id !== undefined) v.variant_id = String(r.variant_id)
    if (r.variant_label !== null && r.variant_label !== undefined) v.variant_label = String(r.variant_label)
    return v
  })
}

/** colVariantLabel: "32 / White", the parts joined, empty for a book with neither. */
function colVariantLabel(...parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ?? '').trim()).filter((p) => p !== '').join(' / ')
}

interface LineReq { variant_id?: string; item_name?: string; category?: string; quantity?: number | null; unit_paise?: unknown; discount_paise?: unknown; original_line_id?: string }
interface PricedLine { variantId: string | null; itemId: string | null; name: string; category: string; label: string | null; quantity: number; unit: number; discount: number; tax: number; total: number; onHand: number }

const LINE_CATS = ['meal', 'snack', 'beverage', 'dessert', 'fruit', 'uniform', 'book', 'stationery', 'other']

/** colResolveLines: a store line is priced from the catalogue, a canteen line free-hand. */
async function colResolveLines(c: Ctx, channel: string, input: unknown): Promise<PricedLine[]> {
  const list = Array.isArray(input) ? (input as LineReq[]) : []
  if (list.length === 0) throw refuse('a sale needs at least one line')
  if (list.length > 100) throw refuse('that is more than a hundred lines -- ring it up as two sales')
  const out: PricedLine[] = []
  for (let i = 0; i < list.length; i++) {
    const l = list[i] ?? {}
    const q = optInt(l.quantity, `line ${i + 1} quantity`)
    const qty = q === null ? 1 : q
    if (qty <= 0) throw refuse(`line ${i + 1} has no quantity`)
    const p: PricedLine = { variantId: null, itemId: null, name: '', category: trim(l.category), label: null, quantity: qty, unit: 0, discount: 0, tax: 0, total: 0, onHand: 0 }
    const raw = trim(l.variant_id)
    if (raw !== '') {
      if (channel !== 'store') throw refuse('a canteen line does not come off the stock shelf')
      if (!isUUID(raw)) throw refuse(`line ${i + 1} names a variant that is not an id`)
      const v = await c.db.prepare(`
        SELECT p.name, COALESCE(v.sale_price_paise, p.sale_price_paise) AS price, p.tax_rate_bp, p.category, i.on_hand, i.id AS item_id,
               v.size, v.colour, v.variant_note, (v.is_active AND p.is_active) AS active
          FROM store_product_variants v JOIN store_products p ON p.id = v.product_id JOIN inventory_items i ON i.id = v.item_id
         WHERE v.id = ?1`).bind(raw).first<Row>()
      if (!v) throw refuse(`line ${i + 1} names an item the store does not stock`)
      const name = String(v.name)
      if (!bool(v.active)) throw refuse(`${name} is no longer on sale`)
      const price = Number(v.price)
      p.variantId = raw; p.itemId = String(v.item_id); p.name = name; p.unit = price; p.onHand = Number(v.on_hand); p.category = String(v.category)
      const lbl = colVariantLabel(v.size as string | null, v.colour as string | null, v.variant_note as string | null)
      if (lbl !== '') p.label = lbl
      if (l.unit_paise !== undefined && l.unit_paise !== null && paise(l.unit_paise, 'unit_paise') !== price) {
        throw refuse(`${name} is priced at ${indianRupees(price)} -- record a difference as a discount, not as another price`)
      }
      const gross = price * qty
      if (l.discount_paise !== undefined && l.discount_paise !== null) p.discount = paise(l.discount_paise, 'discount_paise')
      if (p.discount < 0 || p.discount > gross) throw refuse(`the discount on ${name} is more than the line`)
      const net = gross - p.discount
      // Half up on integer paise. (net*bp + 5000) / 10000.
      p.tax = Math.floor((net * Number(v.tax_rate_bp) + 5000) / 10000)
      p.total = net + p.tax
    } else {
      if (channel === 'store') throw refuse(`line ${i + 1} has to name a stock item -- the store sells what it counts`)
      p.name = trim(l.item_name)
      if (p.name === '') throw refuse(`line ${i + 1} has no item on it`)
      p.unit = colMoney(`the price on line ${i + 1}`, l.unit_paise, true)
      const gross = p.unit * qty
      if (l.discount_paise !== undefined && l.discount_paise !== null) p.discount = paise(l.discount_paise, 'discount_paise')
      if (p.discount < 0 || p.discount > gross) throw refuse(`the discount on ${p.name} is more than the line`)
      p.total = gross - p.discount
      if (p.category === '') p.category = 'snack'
    }
    if (!LINE_CATS.includes(p.category)) p.category = 'other'
    out.push(p)
  }
  return out
}

/**
 * colWriteLines plus the pos_sale_lines_to_stock trigger (00094) and the
 * inventory_movements_sync trigger (00005): a store line writes a movement of
 * kind issue/return that the line points at, and on_hand is recomputed from
 * the ledger for every item touched.
 */
function colWriteLines(c: Ctx, saleId: string, kind: 'sale' | 'return', receipt: string, soldOn: string, lines: PricedLine[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = []
  const itemsTouched = new Set<string>()
  const ts = now()
  lines.forEach((l, i) => {
    let moveId: string | null = null
    if (l.variantId && l.itemId) {
      moveId = uuid()
      const mkind = kind === 'return' ? 'return' : 'issue'
      stmts.push(c.db.prepare(`INSERT INTO inventory_movements (id, institution_id, item_id, kind, quantity, unit_cost_paise, reference, moved_on, remarks, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(moveId, inst(c), l.itemId, mkind, l.quantity, l.unit, receipt, soldOn,
          mkind === 'return' ? 'School store return' : 'School store sale', c.id.userId, ts))
      itemsTouched.add(l.itemId)
    }
    stmts.push(c.db.prepare(`INSERT INTO pos_sale_lines (id, institution_id, sale_id, line_no, variant_id, item_name, category, variant_label,
        quantity, unit_paise, discount_paise, tax_paise, line_paise, inventory_movement_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(uuid(), inst(c), saleId, i + 1, l.variantId, l.name, l.category, l.label, l.quantity, l.unit, l.discount, l.tax, l.total, moveId))
  })
  for (const itemId of itemsTouched) {
    stmts.push(c.db.prepare(`UPDATE inventory_items SET on_hand = COALESCE((
        SELECT sum(CASE WHEN m.kind IN ('receipt','return') THEN m.quantity WHEN m.kind = 'issue' THEN -m.quantity ELSE m.quantity END)
          FROM inventory_movements m WHERE m.item_id = ?1), 0) WHERE id = ?1`).bind(itemId))
  }
  return stmts
}

/** colChargeToAccount: one invoice per sale, on the ledger the parent already reads. */
async function colChargeToAccount(c: Ctx, student: string, channel: string, on: string, total: number, narration: string):
  Promise<{ invoiceId: string; invoiceNo: string; stmts: D1PreparedStatement[] }> {
  const headCol = channel === 'canteen' ? 'canteen_fee_head_id' : 'store_fee_head_id'
  const st = await c.db.prepare(`SELECT ${headCol} AS head FROM collections_settings WHERE institution_id = ?1`).bind(inst(c)).first<{ head: string | null }>()
  const head = st?.head ?? null
  if (!head) throw refuse(`no fee head is set for ${channel} charges -- set one in collections settings before charging an account`)
  const stu = await c.db.prepare(`SELECT campus_id FROM students WHERE id = ?1`).bind(student).first<{ campus_id: string }>()
  if (!stu) throw refuse('that child is not on the roll')
  const yr = await c.db.prepare(`SELECT id FROM academic_years WHERE is_current ORDER BY starts_on DESC LIMIT 1`).first<{ id: string }>()
  if (!yr) throw refuse('no academic year is marked current -- an invoice cannot be filed against nothing')
  const number = await nextNumberOn(c, 'invoice', on)
  const invoiceId = uuid()
  const ts = now()
  return {
    invoiceId, invoiceNo: number.text,
    stmts: [
      ...number.stmts,
      // net_paise was a generated column (gross - discount + fine); filled here.
      c.db.prepare(`INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, issued_on, due_on,
          gross_paise, discount_paise, fine_paise, net_paise, paid_paise, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,0,0,?,0,'unpaid',?,?)`)
        .bind(invoiceId, inst(c), stu.campus_id, student, yr.id, number.text, on, on, total, total, ts, ts),
      c.db.prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise) VALUES (?,?,?,?,?,?)`)
        .bind(uuid(), inst(c), invoiceId, head, narration, total),
    ],
  }
}

/** colMirrorToCafeteria: the parent-facing copy of a canteen sale. */
function colMirrorToCafeteria(c: Ctx, student: string, campus: string | null, total: number, receipt: string, mode: string, lines: PricedLine[]): D1PreparedStatement[] {
  const cafMode = mode === 'wallet' ? 'wallet' : 'cash'
  const purchase = uuid()
  const ts = now()
  const stmts = [
    c.db.prepare(`INSERT INTO cafeteria_purchases (id, institution_id, campus_id, student_id, purchased_at, counter, total_paise, mode, reference_no, recorded_by, created_at)
        VALUES (?,?,?,?,?,'Canteen counter',?,?,?,?,?)`).bind(purchase, inst(c), campus, student, ts, total, cafMode, receipt, c.id.userId, ts),
  ]
  for (const l of lines) {
    const cat = ['meal', 'snack', 'beverage', 'dessert', 'fruit', 'stationery'].includes(l.category) ? l.category : 'other'
    stmts.push(c.db.prepare(`INSERT INTO cafeteria_purchase_items (id, institution_id, purchase_id, item_name, category, quantity, unit_paise, line_paise)
        VALUES (?,?,?,?,?,?,?,?)`).bind(uuid(), inst(c), purchase, l.name, cat, l.quantity, l.unit, l.total))
  }
  return stmts
}

/* ------------------------------------------------------------------------- */
/* Store catalogue. */

const storeVariantSQL = `
  SELECT v.id, v.product_id, p.name AS product_name, v.item_id, i.code AS item_code, v.size, v.colour, v.variant_note,
         COALESCE(v.sale_price_paise, p.sale_price_paise) AS price_paise, p.tax_rate_bp, i.on_hand, v.is_active
    FROM store_product_variants v
    JOIN store_products p  ON p.id = v.product_id
    JOIN inventory_items i ON i.id = v.item_id`

function storeVariantView(r: Row) {
  const v: Record<string, unknown> = { id: r.id, product_id: r.product_id, product_name: r.product_name, item_id: r.item_id, item_code: r.item_code }
  opt(r.size, v, 'size'); opt(r.colour, v, 'colour'); opt(r.variant_note, v, 'variant_note')
  v.price_paise = Number(r.price_paise); v.tax_rate_bp = Number(r.tax_rate_bp); v.on_hand = Number(r.on_hand); v.is_active = bool(r.is_active)
  v.label = colVariantLabel(r.size as string | null, r.colour as string | null, r.variant_note as string | null)
  return v
}

/* ------------------------------------------------------------------------- */
/* Grant-in-aid. */

const grantSanctionSQL = `
  SELECT s.id, s.head_id, h.name AS head_name, h.code AS head_code, h.category, s.fy_start_year, s.sanction_no, s.sanction_date,
         s.authority, s.scheme_name, s.sanctioned_paise, s.sanctioned_posts, s.opening_unspent_paise,
         COALESCE((SELECT sum(amount_paise) FROM grant_receipts g WHERE g.sanction_id = s.id), 0) AS received,
         COALESCE((SELECT sum(amount_paise) FROM grant_expenditures g WHERE g.sanction_id = s.id), 0) AS utilised,
         s.status,
         (SELECT count(*) FROM grant_receipts g WHERE g.sanction_id = s.id) AS receipt_count,
         (SELECT count(*) FROM grant_expenditures g WHERE g.sanction_id = s.id) AS expenditure_count,
         s.notes
    FROM grant_sanctions s
    JOIN grant_in_aid_heads h ON h.id = s.head_id`

function grantSanctionView(r: Row) {
  const sanctioned = Number(r.sanctioned_paise); const opening = Number(r.opening_unspent_paise)
  const received = Number(r.received); const utilised = Number(r.utilised)
  const fy = Number(r.fy_start_year)
  const v: Record<string, unknown> = {
    id: r.id, head_id: r.head_id, head_name: r.head_name, head_code: r.head_code, category: r.category,
    fy_start_year: fy, fy_label: fyLabel(fy), sanction_no: r.sanction_no, sanction_date: r.sanction_date,
  }
  opt(r.authority, v, 'authority'); opt(r.scheme_name, v, 'scheme_name')
  v.sanctioned_paise = sanctioned
  opt(r.sanctioned_posts, v, 'sanctioned_posts', Number)
  v.opening_unspent_paise = opening; v.received_paise = received; v.utilised_paise = utilised
  v.available_paise = sanctioned + opening - utilised
  v.unspent_paise = received + opening - utilised
  v.awaited_paise = Math.max(sanctioned - received, 0)
  const base = sanctioned + opening
  v.utilisation_pct = base > 0 ? Math.floor((utilised * 100 + Math.floor(base / 2)) / base) : 0
  v.status = r.status; v.receipt_count = Number(r.receipt_count); v.expenditure_count = Number(r.expenditure_count)
  opt(r.notes, v, 'notes')
  return v
}

interface CertLine { sanction_id: string; head_name: string; sanction_no: string; opening_unspent_paise: number; sanctioned_paise: number; received_paise: number; utilised_paise: number; unspent_paise: number }

/** colDraftCertificateLines: the live utilisation for a year, one row per sanction. */
async function colDraftCertificateLines(c: Ctx, fy: number): Promise<CertLine[]> {
  const rows = await c.db.prepare(`
    SELECT s.id, h.name, s.sanction_no, s.opening_unspent_paise, s.sanctioned_paise,
           COALESCE((SELECT sum(amount_paise) FROM grant_receipts g WHERE g.sanction_id = s.id), 0) AS received,
           COALESCE((SELECT sum(amount_paise) FROM grant_expenditures g WHERE g.sanction_id = s.id), 0) AS utilised
      FROM grant_sanctions s JOIN grant_in_aid_heads h ON h.id = s.head_id
     WHERE s.fy_start_year = ?1 AND s.status <> 'draft' ORDER BY h.category, h.name`).bind(fy).all<Row>()
  return rows.results.map((r) => {
    const opening = Number(r.opening_unspent_paise); const received = Number(r.received); const utilised = Number(r.utilised)
    return { sanction_id: String(r.id), head_name: String(r.name), sanction_no: String(r.sanction_no), opening_unspent_paise: opening,
      sanctioned_paise: Number(r.sanctioned_paise), received_paise: received, utilised_paise: utilised, unspent_paise: received + opening - utilised }
  })
}

const grantCertificateSQL = `
  SELECT c.id, c.certificate_no, c.fy_start_year, c.period_from, c.period_to, c.status, c.issued_on, c.filed_on, c.filed_reference,
         c.opening_unspent_paise, c.sanctioned_paise, c.received_paise, c.utilised_paise, c.unspent_paise, c.unspent_disposition,
         c.refunded_on, c.refund_reference, c.certified_by, c.remarks, u.full_name AS prepared_by,
         (SELECT count(*) FROM grant_utilisation_certificate_lines gl WHERE gl.certificate_id = c.id) AS line_count
    FROM grant_utilisation_certificates c
    LEFT JOIN users u ON u.id = c.prepared_by`

function grantCertificateView(r: Row) {
  const fy = Number(r.fy_start_year)
  const v: Record<string, unknown> = { id: r.id, certificate_no: r.certificate_no, fy_start_year: fy, fy_label: fyLabel(fy),
    period_from: r.period_from, period_to: r.period_to, status: r.status }
  opt(r.issued_on, v, 'issued_on'); opt(r.filed_on, v, 'filed_on'); opt(r.filed_reference, v, 'filed_reference')
  v.opening_unspent_paise = Number(r.opening_unspent_paise); v.sanctioned_paise = Number(r.sanctioned_paise)
  v.received_paise = Number(r.received_paise); v.utilised_paise = Number(r.utilised_paise); v.unspent_paise = Number(r.unspent_paise)
  v.unspent_disposition = r.unspent_disposition
  opt(r.refunded_on, v, 'refunded_on'); opt(r.refund_reference, v, 'refund_reference'); opt(r.certified_by, v, 'certified_by')
  opt(r.remarks, v, 'remarks'); opt(r.prepared_by, v, 'prepared_by')
  v.line_count = Number(r.line_count)
  return v
}

function fyParam(c: Ctx, strict: boolean): number | null {
  const raw = (c.url.searchParams.get('fy') ?? '').trim()
  if (raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || (strict && (n < 1990 || n > 2200))) throw badRequest('the financial year is its starting year, like 2026')
  return n
}

/* ========================================================================= */

export function registerCollections(r: Router): void {
  const READ = 'finance.fees.read', WRITE = 'finance.fees.write', TILL = 'finance.payments.write', REFUND = 'finance.refunds.write'

  // --- settings ----------------------------------------------------------
  r.get('/finance/collections/settings', READ, fin(async (c) => {
    const row = await c.db.prepare(`
      SELECT c.canteen_fee_head_id, ch.name AS canteen_name, c.store_fee_head_id, sh.name AS store_name, c.variance_tolerance_paise,
             c.grant_liability_account_id, gl.name AS liab_name, c.grant_bank_account_id, gb.name AS bank_name
        FROM collections_settings c
        LEFT JOIN fee_heads       ch ON ch.id = c.canteen_fee_head_id
        LEFT JOIN fee_heads       sh ON sh.id = c.store_fee_head_id
        LEFT JOIN ledger_accounts gl ON gl.id = c.grant_liability_account_id
        LEFT JOIN ledger_accounts gb ON gb.id = c.grant_bank_account_id
       WHERE c.institution_id = ?1`).bind(inst(c)).first<Row>()
    const out: Record<string, unknown> = { variance_tolerance_paise: 5000 }
    if (row) {
      opt(row.canteen_fee_head_id, out, 'canteen_fee_head_id'); opt(row.canteen_name, out, 'canteen_fee_head_name')
      opt(row.store_fee_head_id, out, 'store_fee_head_id'); opt(row.store_name, out, 'store_fee_head_name')
      out.variance_tolerance_paise = Number(row.variance_tolerance_paise)
      opt(row.grant_liability_account_id, out, 'grant_liability_account_id'); opt(row.liab_name, out, 'grant_liability_account_name')
      opt(row.grant_bank_account_id, out, 'grant_bank_account_id'); opt(row.bank_name, out, 'grant_bank_account_name')
    }
    return ok(out)
  }))

  r.post('/finance/collections/settings', WRITE, fin(async (c) => {
    const req = await readJSON<Row>(c.req)
    const tol = colMoney('the variance tolerance', req.variance_tolerance_paise, true)
    const canteen = optionalUUID(req.canteen_fee_head_id, 'that canteen fee head is not a valid id')
    const store = optionalUUID(req.store_fee_head_id, 'that store fee head is not a valid id')
    const liab = optionalUUID(req.grant_liability_account_id, 'that grant account is not a valid id')
    const bank = optionalUUID(req.grant_bank_account_id, 'that bank account is not a valid id')
    await c.db.prepare(`INSERT INTO collections_settings (institution_id, canteen_fee_head_id, store_fee_head_id, variance_tolerance_paise,
        grant_liability_account_id, grant_bank_account_id, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT (institution_id) DO UPDATE SET canteen_fee_head_id = excluded.canteen_fee_head_id, store_fee_head_id = excluded.store_fee_head_id,
        variance_tolerance_paise = excluded.variance_tolerance_paise, grant_liability_account_id = excluded.grant_liability_account_id,
        grant_bank_account_id = excluded.grant_bank_account_id, updated_at = ?7`)
      .bind(inst(c), canteen, store, tol, liab, bank, now()).run()
    return ok({ status: 'saved' })
  }))

  // --- counters and tills ------------------------------------------------
  r.get('/finance/collections/terminals', READ, fin(async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(`
      SELECT t.id, t.code, t.name, t.kind, t.location, t.is_active,
             (SELECT ts.opened_at FROM pos_till_sessions ts WHERE ts.terminal_id = t.id AND ts.status = 'open' LIMIT 1) AS open_since,
             (SELECT u.full_name FROM pos_till_sessions ts LEFT JOIN users u ON u.id = ts.opened_by
               WHERE ts.terminal_id = t.id AND ts.status = 'open' LIMIT 1) AS open_by
        FROM pos_terminals t
       WHERE (?1 IS NULL OR t.kind = ?1) AND (?2 IS NULL OR t.is_active = ?2)
       ORDER BY t.is_active DESC, t.name`).bind(nullStr(q.get('kind')), nullBool(q.get('active'))).all<Row>()
    return ok(items(rows.results.map((t) => {
      const v: Record<string, unknown> = { id: t.id, code: t.code, name: t.name, kind: t.kind }
      opt(t.location, v, 'location'); v.is_active = bool(t.is_active)
      opt(t.open_since, v, 'open_since'); opt(t.open_by, v, 'open_by')
      return v
    })))
  }))

  r.post('/finance/collections/terminals', WRITE, fin(async (c) => {
    const req = await readJSON<Row>(c.req)
    const code = trim(req.code); const name = trim(req.name); let kind = trim(req.kind)
    if (kind === '') kind = 'canteen'
    if (code === '') throw refuse('give the counter a short code, so a receipt can name it')
    if (name === '') throw refuse('what is this counter called?')
    if (kind !== 'canteen' && kind !== 'store') throw refuse('a counter is either a canteen or a store')
    const active = optBool(req.is_active, true)
    const location = nullStr(req.location)
    const tid = trim(req.id)
    if (tid !== '') {
      if (!isUUID(tid)) throw refuse('malformed counter id')
      const res = await c.db.prepare(`UPDATE pos_terminals SET code = ?3, name = ?4, kind = ?5, location = ?6, is_active = ?7, updated_at = ?8
          WHERE id = ?1 AND institution_id = ?2`).bind(tid, inst(c), code, name, kind, location, active ? 1 : 0, now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: tid })
    }
    const id = uuid(); const ts = now()
    await c.db.prepare(`INSERT INTO pos_terminals (id, institution_id, code, name, kind, location, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(id, inst(c), code, name, kind, location, active ? 1 : 0, ts, ts).run()
    return ok({ id })
  }))

  r.get('/finance/collections/sessions', READ, fin(async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(tillSessionSQL + `
       WHERE (?1 IS NULL OR ts.status = ?1) AND (?2 IS NULL OR ts.terminal_id = ?2) AND (?3 IS NULL OR t.kind = ?3)
       ORDER BY ts.opened_at DESC LIMIT 200`).bind(nullStr(q.get('status')), nullStr(q.get('terminal_id')), nullStr(q.get('kind'))).all<Row>()
    const tol = await colTolerance(c)
    return ok(items(rows.results.map((r) => tillSessionView(r, tol))))
  }))

  // The variance report. Registered before /{id} so "variance" is not parsed as a session id.
  r.get('/finance/collections/sessions/variance', READ, fin(async (c) => {
    const q = c.url.searchParams
    let from = colDate(q.get('from'))
    if (trim(q.get('from')) === '') from = addDays(from, -30)
    const to = colDate(q.get('to'))
    const tol = await colTolerance(c)
    const rows = await c.db.prepare(`
      SELECT ts.id, t.name, t.kind, COALESCE(u.full_name, '-') AS opened_by, ts.closed_at, ts.expected_cash_paise, ts.counted_cash_paise,
             ts.variance_paise, ts.variance_reason
        FROM pos_till_sessions ts JOIN pos_terminals t ON t.id = ts.terminal_id LEFT JOIN users u ON u.id = ts.opened_by
       WHERE ts.status = 'closed' AND ts.closed_at >= ?1 AND ts.closed_at < ?2 AND (?3 IS NULL OR t.kind = ?3) AND abs(ts.variance_paise) > ?4
       ORDER BY abs(ts.variance_paise) DESC, ts.closed_at DESC LIMIT 200`).bind(from, addDays(to, 1), nullStr(q.get('kind')), tol).all<Row>()
    let short = 0; let over = 0
    const list = rows.results.map((r) => {
      const variance = Number(r.variance_paise)
      if (variance < 0) short -= variance; else over += variance
      const v: Record<string, unknown> = { session_id: r.id, terminal_name: r.name, terminal_kind: r.kind, opened_by: r.opened_by, closed_at: r.closed_at,
        expected_cash_paise: Number(r.expected_cash_paise), counted_cash_paise: Number(r.counted_cash_paise), variance_paise: variance }
      opt(r.variance_reason, v, 'variance_reason')
      v.over_tolerance = true
      return v
    })
    return ok({ items: list, variance_tolerance_paise: tol, total_short_paise: short, total_over_paise: over, from, to })
  }))

  r.post('/finance/collections/sessions', TILL, fin(async (c) => {
    const req = await readJSON<Row>(c.req)
    const term = trim(req.terminal_id)
    if (!isUUID(term)) throw refuse('which counter is being opened?')
    const float = colMoney('the opening float', req.opening_float_paise, true)
    const t = await c.db.prepare(`SELECT is_active, campus_id FROM pos_terminals WHERE id = ?1`).bind(term).first<{ is_active: number; campus_id: string | null }>()
    if (!t) throw notFound()
    if (!bool(t.is_active)) throw refuse('that counter is retired -- reactivate it before opening a till')
    const holder = await c.db.prepare(`SELECT COALESCE(u.full_name, 'somebody') AS name FROM pos_till_sessions ts LEFT JOIN users u ON u.id = ts.opened_by
        WHERE ts.terminal_id = ?1 AND ts.status = 'open'`).bind(term).first<{ name: string }>()
    if (holder) throw refuse(`${holder.name} already has that till open -- cash it up first`)
    const id = uuid(); const ts = now()
    await c.db.prepare(`INSERT INTO pos_till_sessions (id, institution_id, campus_id, terminal_id, opened_by, opened_at, opening_float_paise, notes, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, inst(c), t.campus_id, term, c.id.userId, ts, float, nullStr(req.notes), ts).run()
    return ok({ id })
  }))

  r.get('/finance/collections/sessions/{id}', READ, fin(async (c) => {
    const sid = pathUUID(c)
    const row = await c.db.prepare(tillSessionSQL + ` WHERE ts.id = ?1`).bind(sid).first<Row>()
    if (!row) throw notFound()
    const tol = await colTolerance(c)
    const sales = await c.db.prepare(posSaleSQL + ` WHERE s.session_id = ?1 ORDER BY s.sold_at DESC`).bind(sid).all<Row>()
    return ok({ session: tillSessionView(row, tol), sales: sales.results.map(posSaleView) })
  }))

  r.post('/finance/collections/sessions/{id}/close', TILL, fin(async (c) => {
    const sid = pathUUID(c)
    const req = await readJSON<Row>(c.req)
    const counted = colMoney('the counted cash', req.counted_cash_paise, true)
    let paidOut = 0
    if (req.paid_out_paise !== undefined && req.paid_out_paise !== null) paidOut = colMoney('the paid-out total', req.paid_out_paise, true)
    const s = await c.db.prepare(`SELECT status, opening_float_paise FROM pos_till_sessions WHERE id = ?1`).bind(sid).first<{ status: string; opening_float_paise: number }>()
    if (!s) throw notFound()
    if (s.status !== 'open') throw refuse('that till has already been cashed up')
    const float = Number(s.opening_float_paise)
    const sums = await c.db.prepare(`SELECT COALESCE(sum(CASE WHEN kind = 'sale' THEN total_paise ELSE 0 END), 0) AS cash_in,
        COALESCE(sum(CASE WHEN kind = 'return' THEN total_paise ELSE 0 END), 0) AS cash_out FROM pos_sales WHERE session_id = ?1 AND payment_mode = 'cash'`)
      .bind(sid).first<{ cash_in: number; cash_out: number }>()
    const cashIn = Number(sums?.cash_in ?? 0); const cashOut = Number(sums?.cash_out ?? 0)
    const expected = float + cashIn - cashOut - paidOut
    if (expected < 0) throw refuse(`that paid-out figure is more than the drawer ever held: float ${indianRupees(float)} plus takings ${indianRupees(cashIn)}`)
    const variance = counted - expected
    const tol = await colTolerance(c)
    let reason = trim(req.variance_reason)
    const abs = Math.abs(variance)
    if (variance !== 0 && reason === '') {
      if (abs > tol) throw refuse(`the drawer is ${variance > 0 ? 'over by' : 'short by'} ${indianRupees(abs)} -- say what happened before closing`)
      reason = 'Within tolerance; not investigated.'
    }
    // variance_paise was a generated column (counted - expected) in Postgres; written here.
    await c.db.prepare(`UPDATE pos_till_sessions SET status = 'closed', closed_by = ?2, closed_at = ?7, counted_cash_paise = ?3, expected_cash_paise = ?4,
        paid_out_paise = ?5, variance_paise = ?3 - ?4, variance_reason = NULLIF(?6, '') WHERE id = ?1`)
      .bind(sid, c.id.userId, counted, expected, paidOut, reason, now()).run()
    return ok({ expected_cash_paise: expected, counted_cash_paise: counted, variance_paise: variance, over_tolerance: abs > tol })
  }))

  // --- sales -------------------------------------------------------------
  r.get('/finance/collections/sales', READ, fin(async (c) => {
    const q = c.url.searchParams
    let from = colDate(q.get('from'))
    if (trim(q.get('from')) === '') from = addDays(from, -7)
    const to = colDate(q.get('to'))
    const student = queryUUID(c, 'student_id')
    const rows = await c.db.prepare(posSaleSQL + `
       WHERE s.sold_on BETWEEN ?1 AND ?2 AND (?3 IS NULL OR s.channel = ?3) AND (?4 IS NULL OR s.student_id = ?4) AND (?5 IS NULL OR s.session_id = ?5)
       ORDER BY s.sold_at DESC LIMIT 300`).bind(from, to, nullStr(q.get('channel')), student, nullStr(q.get('session_id'))).all<Row>()
    return ok(items(rows.results.map(posSaleView)))
  }))

  r.post('/finance/collections/sales', TILL, fin(async (c) => {
    const req = await readJSON<Row>(c.req)
    const session = trim(req.session_id)
    if (!isUUID(session)) throw refuse('which till is this sale on? open one first')
    const soldOn = colDate(req.sold_on)
    let mode = trim(req.payment_mode)
    if (mode === '') mode = 'cash'
    if (mode !== 'cash' && mode !== 'account' && mode !== 'wallet') {
      throw refuse("this counter takes cash, charges the child's fee account, or draws from the child's wallet. There is no card: no payment gateway is wired to this counter")
    }
    const ts = await c.db.prepare(`SELECT ts.status, t.kind, ts.campus_id FROM pos_till_sessions ts JOIN pos_terminals t ON t.id = ts.terminal_id WHERE ts.id = ?1`)
      .bind(session).first<{ status: string; kind: string; campus_id: string | null }>()
    if (!ts) throw notFound()
    if (ts.status !== 'open') throw refuse('that till is cashed up -- open a new session before selling')
    const channel = ts.kind; const campus = ts.campus_id
    const student = optionalUUID(req.student_id, 'that is not a valid student')
    const buyer = trim(req.buyer_name)
    if (student === null && buyer === '') throw refuse("who is buying? name the child, or type the buyer's name")
    if (mode === 'account' && student === null) throw refuse('a charge needs an account to charge -- pick the child')
    if (mode === 'wallet' && student === null) throw refuse('a wallet sale needs a wallet to draw from -- pick the child')

    const lines = await colResolveLines(c, channel, req.lines)
    let subtotal = 0, discount = 0, tax = 0, total = 0
    for (const l of lines) {
      subtotal += l.unit * l.quantity; discount += l.discount; tax += l.tax; total += l.total
      if (l.variantId && l.quantity > l.onHand) throw refuse(`only ${l.onHand} of ${l.name} left on the shelf`)
    }
    if (total <= 0) throw refuse('a sale of nothing is not a sale')

    await ensurePosSeries(c)
    const number = await nextNumberOn(c, 'pos', soldOn)
    const narration = `${colTitle(channel)} counter, receipt ${number.text}`
    const stmts: D1PreparedStatement[] = [...number.stmts]
    let invoiceId: string | null = null; let invoiceNo = ''
    if (mode === 'account') {
      const iv = await colChargeToAccount(c, student!, channel, soldOn, total, narration)
      invoiceId = iv.invoiceId; invoiceNo = iv.invoiceNo
      stmts.push(...iv.stmts)
    }
    const saleId = uuid(); const at = now()
    stmts.push(c.db.prepare(`INSERT INTO pos_sales (id, institution_id, campus_id, session_id, kind, channel, student_id, buyer_name, sold_at, sold_on,
        payment_mode, subtotal_paise, discount_paise, tax_paise, total_paise, receipt_no, receipt_seq, receipt_fy, invoice_id, remarks, sold_by, created_at)
        VALUES (?,?,?,?,'sale',?,?,NULLIF(?,''),?,?,?,?,?,?,?,?,?,NULLIF(?,''),?,?,?,?)`)
      .bind(saleId, inst(c), campus, session, channel, student, buyer, at, soldOn, mode, subtotal, discount, tax, total,
        number.text, number.seq, number.fy, invoiceId, nullStr(req.remarks), c.id.userId, at))
    stmts.push(...colWriteLines(c, saleId, 'sale', number.text, soldOn, lines))
    let walletLeft = 0
    if (mode === 'wallet') {
      const w = await walletDebit(c, campus, student!, total, number.text, narration, saleId)
      walletLeft = w.left
      stmts.push(...w.stmts)
    }
    if (channel === 'canteen' && student !== null) stmts.push(...colMirrorToCafeteria(c, student, campus, total, number.text, mode, lines))
    try { await c.db.batch(stmts) } catch (e) {
      if (isUniqueViolation(e)) throw refuse('that already exists: ' + (e as Error).message)
      throw e
    }
    const out: Record<string, unknown> = { id: saleId, receipt_no: number.text, total_paise: total, payment_mode: mode }
    if (invoiceNo !== '') out.invoice_no = invoiceNo
    if (mode === 'wallet') out.wallet_balance_paise = walletLeft
    return ok(out)
  }))

  r.get('/finance/collections/sales/{id}', READ, fin(async (c) => {
    const sid = pathUUID(c)
    const row = await c.db.prepare(posSaleSQL + ` WHERE s.id = ?1`).bind(sid).first<Row>()
    if (!row) throw notFound()
    const v = posSaleView(row)
    const lines = await colSaleLines(c, sid)
    if (lines.length) v.lines = lines
    return ok(v)
  }))

  r.post('/finance/collections/sales/{id}/return', REFUND, fin(async (c) => {
    const orig = pathUUID(c)
    const req = await readJSON<Row>(c.req)
    const session = trim(req.session_id)
    if (!isUUID(session)) throw refuse('a refund comes out of an open till -- which one?')
    const sess = await c.db.prepare(`SELECT status, campus_id FROM pos_till_sessions WHERE id = ?1`).bind(session).first<{ status: string; campus_id: string | null }>()
    if (!sess) throw notFound()
    if (sess.status !== 'open') throw refuse('that till is cashed up -- open a session before refunding')
    const campus = sess.campus_id
    const o = await c.db.prepare(`SELECT s.kind, s.channel, s.payment_mode, s.student_id, s.buyer_name, s.invoice_id, s.sold_on FROM pos_sales s WHERE s.id = ?1`)
      .bind(orig).first<{ kind: string; channel: string; payment_mode: string; student_id: string | null; buyer_name: string | null; invoice_id: string | null; sold_on: string }>()
    if (!o) throw notFound()
    if (o.kind !== 'sale') throw refuse('that is already a refund -- it cannot be refunded again')
    const mode = o.payment_mode; const student = o.student_id; const invoice = o.invoice_id

    const originals = await colSaleLines(c, orig)
    const byID = new Map(originals.map((l) => [l.id, l]))
    const reqLines = Array.isArray(req.lines) ? (req.lines as LineReq[]) : []
    if (reqLines.length === 0) throw refuse('what is coming back?')
    const lines: PricedLine[] = []
    let subtotal = 0, tax = 0, total = 0
    // The variant's shelf, for the stock movement the trigger wrote.
    const itemOf = new Map<string, string>()
    for (let i = 0; i < reqLines.length; i++) {
      const l = reqLines[i] ?? {}
      const ol = byID.get(trim(l.original_line_id))
      if (!ol) throw refuse(`line ${i + 1} is not on that receipt`)
      const left = ol.quantity - ol.returned_quantity
      const q = optInt(l.quantity, `line ${i + 1} quantity`)
      const qty = q === null ? left : q
      if (qty <= 0) throw refuse(`${ol.item_name} has nothing left to return`)
      if (qty > left) throw refuse(`only ${left} of ${ol.item_name} can still come back -- ${ol.quantity} were sold and ${ol.returned_quantity} already returned`)
      // Refunded at the price it went out at, apportioned by quantity (integer division as Go did).
      const share = Math.floor((ol.line_paise * qty + Math.floor(ol.quantity / 2)) / ol.quantity)
      const taxShare = Math.floor((ol.tax_paise * qty + Math.floor(ol.quantity / 2)) / ol.quantity)
      let itemId: string | null = null
      if (ol.variant_id) {
        if (!itemOf.has(ol.variant_id)) {
          const v = await c.db.prepare(`SELECT item_id FROM store_product_variants WHERE id = ?1`).bind(ol.variant_id).first<{ item_id: string }>()
          if (v) itemOf.set(ol.variant_id, v.item_id)
        }
        itemId = itemOf.get(ol.variant_id) ?? null
      }
      lines.push({ variantId: ol.variant_id ?? null, itemId, name: ol.item_name, category: ol.category, label: ol.variant_label ?? null,
        quantity: qty, unit: ol.unit_paise, discount: 0, tax: taxShare, total: share, onHand: 0 })
      subtotal += ol.unit_paise * qty; tax += taxShare; total += share
    }
    const discount = subtotal + tax - total
    if (discount < 0) throw refuse("that receipt's lines do not add up -- it cannot be reversed automatically")
    if (total <= 0) throw refuse('a refund of nothing is not a refund')

    const stmts: D1PreparedStatement[] = []
    if (mode === 'account' && invoice) {
      const iv = await c.db.prepare(`SELECT gross_paise, discount_paise, fine_paise, paid_paise, status FROM invoices WHERE id = ?1`).bind(invoice)
        .first<{ gross_paise: number; discount_paise: number; fine_paise: number; paid_paise: number; status: string }>()
      if (!iv) throw notFound()
      const gross = Number(iv.gross_paise), disc = Number(iv.discount_paise), fine = Number(iv.fine_paise), paid = Number(iv.paid_paise)
      if (gross - total - disc + fine < paid) throw refuse(`that charge has already been paid -- refund the ${indianRupees(total)} in cash rather than reversing the invoice`)
      // net_paise was generated from gross; invoices_touch set updated_at.
      stmts.push(c.db.prepare(`UPDATE invoices SET gross_paise = gross_paise - ?2, net_paise = (gross_paise - ?2) - discount_paise + fine_paise, updated_at = ?3 WHERE id = ?1`)
        .bind(invoice, total, now()))
      stmts.push(c.db.prepare(`UPDATE invoice_lines SET amount_paise = amount_paise - ?2 WHERE invoice_id = ?1`).bind(invoice, total))
    }

    await ensurePosSeries(c)
    const on = ymd(nowIST())
    const number = await nextNumberOn(c, 'pos', on)
    stmts.push(...number.stmts)
    const reason = trim(req.reason)
    if (reason === '') throw refuse('why is it coming back? a refund without a reason is one nobody can defend')

    const retId = uuid(); const at = now()
    stmts.push(c.db.prepare(`INSERT INTO pos_sales (id, institution_id, campus_id, session_id, kind, channel, original_sale_id, student_id, buyer_name, sold_at, sold_on,
        payment_mode, subtotal_paise, discount_paise, tax_paise, total_paise, receipt_no, receipt_seq, receipt_fy, invoice_id, remarks, sold_by, created_at)
        VALUES (?,?,?,?,'return',?,?,?,?,?,?,?,?,?,?,?,?,?,NULLIF(?,''),?,?,?,?)`)
      .bind(retId, inst(c), campus, session, o.channel, orig, student, o.buyer_name, at, on, mode, subtotal, discount, tax, total,
        number.text, number.seq, number.fy, invoice, reason, c.id.userId, at))
    stmts.push(...colWriteLines(c, retId, 'return', number.text, on, lines))
    const out: Record<string, unknown> = {}
    if (mode === 'wallet' && student) {
      const w = await walletCredit(c, campus, student, total, number.text, 'Refund: ' + reason, retId)
      stmts.push(...w.stmts)
      out.wallet_balance_paise = w.left
    }
    try { await c.db.batch(stmts) } catch (e) {
      if (isUniqueViolation(e)) throw refuse('that already exists: ' + (e as Error).message)
      throw e
    }
    out.id = retId; out.receipt_no = number.text; out.refund_paise = total; out.refund_mode = mode
    return ok(out)
  }))

  // --- the store catalogue -----------------------------------------------
  r.get('/finance/collections/products', READ, fin(async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(`
      SELECT p.id, p.code, p.name, p.category, p.hsn_code, p.tax_rate_bp, p.sale_price_paise, p.return_window_days, p.is_active, p.image_key,
             (SELECT count(*) FROM store_product_variants sv WHERE sv.product_id = p.id AND sv.is_active) AS n,
             COALESCE((SELECT sum(i.on_hand) FROM store_product_variants sv JOIN inventory_items i ON i.id = sv.item_id WHERE sv.product_id = p.id AND sv.is_active), 0) AS stock
        FROM store_products p
       WHERE (?1 IS NULL OR p.category = ?1) AND (?2 IS NULL OR p.is_active = ?2)
       ORDER BY p.is_active DESC, p.name`).bind(nullStr(q.get('category')), nullBool(q.get('active'))).all<Row>()
    return ok(items(rows.results.map((p) => {
      const v: Record<string, unknown> = { id: p.id, code: p.code, name: p.name, category: p.category }
      opt(p.hsn_code, v, 'hsn_code')
      v.tax_rate_bp = Number(p.tax_rate_bp); v.sale_price_paise = Number(p.sale_price_paise)
      opt(p.return_window_days, v, 'return_window_days', Number)
      v.is_active = bool(p.is_active)
      opt(p.image_key, v, 'image_key')
      v.variant_count = Number(p.n); v.on_hand = Number(p.stock)
      return v
    })))
  }))

  r.post('/finance/collections/products', WRITE, fin(async (c) => {
    const req = await readJSON<Row>(c.req)
    const code = trim(req.code); const name = trim(req.name); let category = trim(req.category)
    if (category === '') category = 'other'
    if (code === '') throw refuse('give the item a short code')
    if (name === '') throw refuse('what is the item called?')
    if (!oneOf(category, 'uniform', 'book', 'stationery', 'sports', 'other')) throw refuse('category must be uniform, book, stationery, sports or other')
    const price = colMoney('the price', req.sale_price_paise, true)
    const tax = optInt(req.tax_rate_bp, 'tax_rate_bp') ?? 0
    if (tax < 0 || tax > 10000) throw refuse('the GST rate is basis points: 500 is 5%, and it cannot exceed 10000')
    const window = optInt(req.return_window_days, 'return_window_days')
    if (window !== null && (window < 0 || window > 365)) throw refuse('a return window is between 0 and 365 days')
    const active = optBool(req.is_active, true)
    const hsn = nullStr(req.hsn_code); const image = nullStr(req.image_key)
    const pid = trim(req.id)
    if (pid !== '') {
      if (!isUUID(pid)) throw refuse('malformed item id')
      const res = await c.db.prepare(`UPDATE store_products SET code = ?3, name = ?4, category = ?5, hsn_code = ?6, tax_rate_bp = ?7, sale_price_paise = ?8,
          return_window_days = ?9, is_active = ?10, image_key = ?11, updated_at = ?12 WHERE id = ?1 AND institution_id = ?2`)
        .bind(pid, inst(c), code, name, category, hsn, tax, price, window, active ? 1 : 0, image, now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: pid })
    }
    const id = uuid(); const ts = now()
    await c.db.prepare(`INSERT INTO store_products (id, institution_id, code, name, category, hsn_code, tax_rate_bp, sale_price_paise, return_window_days,
        is_active, image_key, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, inst(c), code, name, category, hsn, tax, price, window, active ? 1 : 0, image, c.id.userId, ts, ts).run()
    return ok({ id })
  }))

  r.get('/finance/collections/variants', READ, fin(async (c) => {
    const product = queryUUID(c, 'product_id')
    const rows = await c.db.prepare(storeVariantSQL + `
       WHERE (?1 IS NULL OR v.product_id = ?1) AND (?2 IS NULL OR v.is_active = ?2)
       ORDER BY p.name, v.size IS NOT NULL, v.size, v.colour IS NOT NULL, v.colour`).bind(product, nullBool(c.url.searchParams.get('active'))).all<Row>()
    return ok(items(rows.results.map(storeVariantView)))
  }))

  r.get('/finance/collections/stock-items', READ, fin(async (c) => {
    const rows = await c.db.prepare(`SELECT i.id, i.code, i.name, i.on_hand, (v.id IS NOT NULL) AS taken
        FROM inventory_items i LEFT JOIN store_product_variants v ON v.item_id = i.id ORDER BY i.name`).all<Row>()
    return ok(items(rows.results.map((i) => ({ id: i.id, code: i.code, name: i.name, on_hand: Number(i.on_hand), taken: bool(i.taken) }))))
  }))

  r.post('/finance/collections/variants', WRITE, fin(async (c) => {
    const req = await readJSON<Row>(c.req)
    const product = trim(req.product_id)
    if (!isUUID(product)) throw refuse('which item is this a variant of?')
    const item = trim(req.item_id)
    if (!isUUID(item)) throw refuse('pick the stores item that holds this size -- it is what the sale will draw down')
    let price: number | null = null
    if (req.sale_price_paise !== undefined && req.sale_price_paise !== null) {
      price = paise(req.sale_price_paise, 'sale_price_paise')
      if (price < 0) throw refuse('a price cannot be negative')
    }
    const active = optBool(req.is_active, true)
    const taken = await c.db.prepare(`SELECT p.name FROM store_product_variants v JOIN store_products p ON p.id = v.product_id WHERE v.item_id = ?1`).bind(item).first<{ name: string }>()
    if (taken) throw refuse(`that stores item is already the shelf for ${taken.name} -- one item, one variant, or the stock count has two answers`)
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO store_product_variants (id, institution_id, product_id, item_id, size, colour, variant_note, sale_price_paise, is_active, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, inst(c), product, item, nullStr(req.size), nullStr(req.colour), nullStr(req.variant_note), price, active ? 1 : 0, now()).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw refuse('that already exists: store_product_variants_one_per_item')
      throw e
    }
    return ok({ id })
  }))

  // --- grant-in-aid ------------------------------------------------------
  r.get('/finance/collections/grants/heads', READ, fin(async (c) => {
    const rows = await c.db.prepare(`SELECT h.id, h.code, h.name, h.category, h.expense_account_id, a.name AS account_name, h.is_post_based, h.is_active, h.notes
        FROM grant_in_aid_heads h LEFT JOIN ledger_accounts a ON a.id = h.expense_account_id
       WHERE (?1 IS NULL OR h.is_active = ?1) ORDER BY h.is_active DESC, h.category, h.name`).bind(nullBool(c.url.searchParams.get('active'))).all<Row>()
    return ok(items(rows.results.map((h) => {
      const v: Record<string, unknown> = { id: h.id, code: h.code, name: h.name, category: h.category }
      opt(h.expense_account_id, v, 'expense_account_id'); opt(h.account_name, v, 'expense_account_name')
      v.is_post_based = bool(h.is_post_based); v.is_active = bool(h.is_active)
      opt(h.notes, v, 'notes')
      return v
    })))
  }))

  r.post('/finance/collections/grants/heads', WRITE, fin(async (c) => {
    const req = await readJSON<Row>(c.req)
    const code = trim(req.code); const name = trim(req.name); let category = trim(req.category)
    if (category === '') category = 'non_salary'
    if (code === '') throw refuse('give the head the code the sanction order uses')
    if (name === '') throw refuse('what is the head called?')
    if (!oneOf(category, 'salary', 'non_salary', 'maintenance', 'contingency', 'infrastructure', 'other')) {
      throw refuse('category must be salary, non_salary, maintenance, contingency, infrastructure or other')
    }
    const account = optionalUUID(req.expense_account_id, 'that expenditure account is not a valid id')
    const postBased = optBool(req.is_post_based, category === 'salary')
    const active = optBool(req.is_active, true)
    const notes = nullStr(req.notes)
    const hid = trim(req.id)
    if (hid !== '') {
      if (!isUUID(hid)) throw refuse('malformed head id')
      const res = await c.db.prepare(`UPDATE grant_in_aid_heads SET code = ?3, name = ?4, category = ?5, expense_account_id = ?6, is_post_based = ?7, is_active = ?8,
          notes = ?9, updated_at = ?10 WHERE id = ?1 AND institution_id = ?2`)
        .bind(hid, inst(c), code, name, category, account, postBased ? 1 : 0, active ? 1 : 0, notes, now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: hid })
    }
    const id = uuid(); const ts = now()
    await c.db.prepare(`INSERT INTO grant_in_aid_heads (id, institution_id, code, name, category, expense_account_id, is_post_based, is_active, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(id, inst(c), code, name, category, account, postBased ? 1 : 0, active ? 1 : 0, notes, ts, ts).run()
    return ok({ id })
  }))

  r.get('/finance/collections/grants/utilisation', READ, fin(async (c) => {
    const fy = fyParam(c, true) ?? colFY(today())
    const lines = await colDraftCertificateLines(c, fy)
    let opening = 0, sanctioned = 0, received = 0, utilised = 0
    for (const l of lines) { opening += l.opening_unspent_paise; sanctioned += l.sanctioned_paise; received += l.received_paise; utilised += l.utilised_paise }
    return ok({ items: lines, fy_start_year: fy, fy_label: fyLabel(fy), opening_unspent_paise: opening, sanctioned_paise: sanctioned,
      received_paise: received, utilised_paise: utilised, unspent_paise: received + opening - utilised, awaited_paise: Math.max(sanctioned - received, 0) })
  }))

  r.get('/finance/collections/grants/sanctions', READ, fin(async (c) => {
    const year = fyParam(c, true)
    const head = queryUUID(c, 'head_id')
    const rows = await c.db.prepare(grantSanctionSQL + ` WHERE (?1 IS NULL OR s.fy_start_year = ?1) AND (?2 IS NULL OR s.head_id = ?2)
       ORDER BY s.fy_start_year DESC, h.category, h.name`).bind(year, head).all<Row>()
    return ok(items(rows.results.map(grantSanctionView)))
  }))

  r.post('/finance/collections/grants/sanctions', WRITE, fin(async (c) => {
    const req = await readJSON<Row>(c.req)
    const head = trim(req.head_id)
    if (!isUUID(head)) throw refuse('which head was this sanctioned against?')
    const sanctionNo = trim(req.sanction_no)
    if (sanctionNo === '') throw refuse("the sanction order's number is what an inspecting officer asks for -- type it")
    const on = colDate(req.sanction_date)
    const fy = optInt(req.fy_start_year, 'fy_start_year') ?? colFY(on)
    if (fy < 1990 || fy > 2200) throw refuse('the financial year is its starting year, like 2026')
    const amount = colMoney('the sanctioned amount', req.sanctioned_paise, true)
    let opening = 0
    if (req.opening_unspent_paise !== undefined && req.opening_unspent_paise !== null) opening = colMoney('the opening unspent balance', req.opening_unspent_paise, true)
    let status = trim(req.status)
    if (status === '') status = 'sanctioned'
    if (!oneOf(status, 'draft', 'sanctioned', 'closed')) throw refuse('a sanction is draft, sanctioned or closed')
    const posts = optInt(req.sanctioned_posts, 'sanctioned_posts')
    if (posts !== null && posts < 0) throw refuse('a sanction cannot be for a negative number of posts')
    const authority = nullStr(req.authority); const scheme = nullStr(req.scheme_name); const notes = nullStr(req.notes)
    const sid = trim(req.id)
    if (sid !== '') {
      if (!isUUID(sid)) throw refuse('malformed sanction id')
      const u = await c.db.prepare(`SELECT COALESCE(sum(amount_paise), 0) AS n FROM grant_expenditures WHERE sanction_id = ?1`).bind(sid).first<{ n: number }>()
      const utilised = Number(u?.n ?? 0)
      if (amount + opening < utilised) throw refuse(`${indianRupees(utilised)} is already booked against this sanction -- it cannot be reduced to ${indianRupees(amount + opening)}`)
      const res = await c.db.prepare(`UPDATE grant_sanctions SET head_id = ?3, fy_start_year = ?4, sanction_no = ?5, sanction_date = ?6, authority = ?7, scheme_name = ?8,
          sanctioned_paise = ?9, sanctioned_posts = ?10, opening_unspent_paise = ?11, status = ?12, notes = ?13, updated_at = ?14 WHERE id = ?1 AND institution_id = ?2`)
        .bind(sid, inst(c), head, fy, sanctionNo, on, authority, scheme, amount, posts, opening, status, notes, now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: sid })
    }
    const id = uuid(); const ts = now()
    await c.db.prepare(`INSERT INTO grant_sanctions (id, institution_id, head_id, fy_start_year, sanction_no, sanction_date, authority, scheme_name, sanctioned_paise,
        sanctioned_posts, opening_unspent_paise, status, notes, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, inst(c), head, fy, sanctionNo, on, authority, scheme, amount, posts, opening, status, notes, c.id.userId, ts, ts).run()
    return ok({ id })
  }))

  r.get('/finance/collections/grants/sanctions/{id}', READ, fin(async (c) => {
    const sid = pathUUID(c)
    const row = await c.db.prepare(grantSanctionSQL + ` WHERE s.id = ?1`).bind(sid).first<Row>()
    if (!row) throw notFound()
    const rr = await c.db.prepare(`SELECT g.id, g.received_on, g.amount_paise, g.mode, g.reference_no, b.label, e.voucher_no, g.remarks
        FROM grant_receipts g LEFT JOIN bank_accounts b ON b.id = g.bank_account_id LEFT JOIN journal_entries e ON e.id = g.journal_entry_id
       WHERE g.sanction_id = ?1 ORDER BY g.received_on, g.created_at`).bind(sid).all<Row>()
    const receipts = rr.results.map((g) => {
      const v: Record<string, unknown> = { id: g.id, received_on: g.received_on, amount_paise: Number(g.amount_paise), mode: g.mode }
      opt(g.reference_no, v, 'reference_no'); opt(g.label, v, 'bank_label'); opt(g.voucher_no, v, 'voucher_no'); opt(g.remarks, v, 'remarks')
      return v
    })
    const er = await c.db.prepare(`SELECT g.id, g.spent_on, g.amount_paise, g.particulars, g.voucher_ref, g.source_kind, e.voucher_no
        FROM grant_expenditures g LEFT JOIN journal_entries e ON e.id = g.journal_entry_id WHERE g.sanction_id = ?1 ORDER BY g.spent_on, g.created_at`).bind(sid).all<Row>()
    const expenditures = er.results.map((g) => {
      const v: Record<string, unknown> = { id: g.id, spent_on: g.spent_on, amount_paise: Number(g.amount_paise), particulars: g.particulars }
      opt(g.voucher_ref, v, 'voucher_ref'); opt(g.source_kind, v, 'source_kind'); opt(g.voucher_no, v, 'voucher_no')
      return v
    })
    return ok({ sanction: grantSanctionView(row), receipts, expenditures })
  }))

  r.post('/finance/collections/grants/sanctions/{id}/receipts', WRITE, fin(async (c) => {
    const sid = pathUUID(c)
    const req = await readJSON<Row>(c.req)
    const amount = colMoney('the amount received', req.amount_paise, false)
    const on = colDate(req.received_on)
    let mode = trim(req.mode)
    if (mode === '') mode = 'bank_transfer'
    if (!oneOf(mode, 'bank_transfer', 'cheque', 'dd', 'adjustment')) throw refuse('mode must be bank_transfer, cheque, dd or adjustment')
    const bank = optionalUUID(req.bank_account_id, 'that bank account is not a valid id')
    const s = await c.db.prepare(`SELECT h.name, s.sanction_no FROM grant_sanctions s JOIN grant_in_aid_heads h ON h.id = s.head_id WHERE s.id = ?1`).bind(sid)
      .first<{ name: string; sanction_no: string }>()
    if (!s) throw notFound()
    const receiptId = uuid()
    let journalId: string | null = null
    const stmts: D1PreparedStatement[] = []
    const out: Record<string, unknown> = {}
    if (req.post_to_ledger === true) {
      const st = await c.db.prepare(`SELECT grant_bank_account_id, grant_liability_account_id FROM collections_settings WHERE institution_id = ?1`).bind(inst(c))
        .first<{ grant_bank_account_id: string | null; grant_liability_account_id: string | null }>()
      const bankAcc = st?.grant_bank_account_id ?? null; const grantAcc = st?.grant_liability_account_id ?? null
      if (!bankAcc) throw refuse('no bank account is set for grant receipts -- set one in collections settings, or record the receipt without posting')
      if (!grantAcc) throw refuse('no grant account is set -- set one in collections settings, or record the receipt without posting')
      const v = await postVoucher(c, 'receipt', 'GNT', on, `Grant-in-aid received: ${s.name}, sanction ${s.sanction_no}`, 'grant_receipt', receiptId, [
        { accountId: bankAcc, debit: amount, memo: s.sanction_no },
        { accountId: grantAcc, credit: amount, memo: s.name },
      ])
      journalId = v.entryId
      stmts.push(...v.stmts)
      out.voucher_no = v.voucherNo
    }
    // After the voucher, because the receipt names it and FKs are checked per statement.
    stmts.push(c.db.prepare(`INSERT INTO grant_receipts (id, institution_id, sanction_id, received_on, amount_paise, mode, reference_no, bank_account_id, journal_entry_id, remarks, recorded_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(receiptId, inst(c), sid, on, amount, mode, nullStr(req.reference_no), bank, journalId, nullStr(req.remarks), c.id.userId, now()))
    try { await c.db.batch(stmts) } catch (e) {
      if (isUniqueViolation(e)) throw refuse('that already exists: ' + (e as Error).message)
      throw e
    }
    out.id = receiptId; out.amount_paise = amount
    return ok(out)
  }))

  r.post('/finance/collections/grants/sanctions/{id}/expenditures', WRITE, fin(async (c) => {
    const sid = pathUUID(c)
    const req = await readJSON<Row>(c.req)
    const amount = colMoney('the amount spent', req.amount_paise, false)
    const on = colDate(req.spent_on)
    const particulars = trim(req.particulars)
    if (particulars === '') throw refuse('what was the money spent on? a blank entry is one nobody can certify')
    const sourceKind = trim(req.source_kind)
    const sourceId = optionalUUID(req.source_id, 'that source reference is not a valid id')
    if ((sourceKind === '') !== (sourceId === null)) throw refuse('a source reference needs both what it is and which one -- half of it looks like a link')
    if (sourceKind !== '' && !oneOf(sourceKind, 'vendor_bill', 'payroll_run', 'petty_cash_voucher', 'manual')) {
      throw refuse('a source is a vendor_bill, payroll_run, petty_cash_voucher or manual')
    }
    const s = await c.db.prepare(`SELECT s.sanctioned_paise, s.opening_unspent_paise, s.status, h.name, s.sanction_no, h.expense_account_id, s.fy_start_year
        FROM grant_sanctions s JOIN grant_in_aid_heads h ON h.id = s.head_id WHERE s.id = ?1`).bind(sid)
      .first<{ sanctioned_paise: number; opening_unspent_paise: number; status: string; name: string; sanction_no: string; expense_account_id: string | null; fy_start_year: number }>()
    if (!s) throw notFound()
    if (s.status === 'draft') throw refuse('that sanction is still a draft -- nothing can be spent against it yet')
    if (s.status === 'closed') throw refuse(`the ${s.sanction_no} sanction for ${s.name} is closed`)
    const fy = Number(s.fy_start_year)
    if (colFY(on) !== fy) throw refuse(`that sanction is for ${fyLabel(fy)} and the expenditure is dated ${longDate(on)} -- book it against the right year's sanction`)
    const b = await c.db.prepare(`SELECT COALESCE(sum(amount_paise), 0) AS n FROM grant_expenditures WHERE sanction_id = ?1`).bind(sid).first<{ n: number }>()
    const booked = Number(b?.n ?? 0)
    const available = Number(s.sanctioned_paise) + Number(s.opening_unspent_paise) - booked
    if (amount > available) throw refuse(`${s.name} has ${indianRupees(available)} left under it -- spending outside the sanctioned head is what an audit disallows`)

    const spendId = uuid()
    let journalId: string | null = null
    const stmts: D1PreparedStatement[] = []
    const out: Record<string, unknown> = {}
    if (req.post_to_ledger === true) {
      if (!s.expense_account_id) throw refuse(`no expenditure account is set on ${s.name} -- set one on the head, or record the spend without posting`)
      const st = await c.db.prepare(`SELECT grant_liability_account_id FROM collections_settings WHERE institution_id = ?1`).bind(inst(c)).first<{ grant_liability_account_id: string | null }>()
      const grantAcc = st?.grant_liability_account_id ?? null
      if (!grantAcc) throw refuse('no grant account is set -- set one in collections settings, or record the spend without posting')
      const v = await postVoucher(c, 'journal', 'GNU', on, `Grant utilisation: ${s.name}, ${particulars}`, 'grant_expenditure', spendId, [
        { accountId: s.expense_account_id, debit: amount, memo: s.sanction_no },
        { accountId: grantAcc, credit: amount, memo: s.name },
      ])
      journalId = v.entryId
      stmts.push(...v.stmts)
      out.voucher_no = v.voucherNo
    }
    stmts.push(c.db.prepare(`INSERT INTO grant_expenditures (id, institution_id, sanction_id, spent_on, amount_paise, particulars, voucher_ref, source_kind, source_id, journal_entry_id, recorded_by, created_at)
        VALUES (?,?,?,?,?,?,?,NULLIF(?,''),?,?,?,?)`)
      .bind(spendId, inst(c), sid, on, amount, particulars, nullStr(req.voucher_ref), sourceKind, sourceId, journalId, c.id.userId, now()))
    try { await c.db.batch(stmts) } catch (e) {
      if (isUniqueViolation(e)) throw refuse('that already exists: ' + (e as Error).message)
      throw e
    }
    out.id = spendId; out.remaining_paise = available - amount
    return ok(out)
  }))

  r.get('/finance/collections/grants/certificates', READ, fin(async (c) => {
    const year = fyParam(c, false)
    const rows = await c.db.prepare(grantCertificateSQL + ` WHERE (?1 IS NULL OR c.fy_start_year = ?1) ORDER BY c.fy_start_year DESC, c.created_at DESC`).bind(year).all<Row>()
    return ok(items(rows.results.map(grantCertificateView)))
  }))

  r.post('/finance/collections/grants/certificates', WRITE, fin(async (c) => {
    const req = await readJSON<Row>(c.req)
    const no = trim(req.certificate_no)
    if (no === '') throw refuse('give the certificate the number it will be filed under')
    const fy = optInt(req.fy_start_year, 'fy_start_year')
    if (fy === null) throw refuse('which financial year does this certify?')
    if (fy < 1990 || fy > 2200) throw refuse('the financial year is its starting year, like 2026')
    let from = `${fy}-04-01`; let to = `${fy + 1}-03-31`
    if (trim(req.period_from) !== '') from = colDate(req.period_from)
    if (trim(req.period_to) !== '') to = colDate(req.period_to)
    if (to < from) throw refuse("the certificate's period ends before it begins")
    const id = uuid(); const ts = now()
    await c.db.prepare(`INSERT INTO grant_utilisation_certificates (id, institution_id, certificate_no, fy_start_year, period_from, period_to, remarks, prepared_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, inst(c), no, fy, from, to, nullStr(req.remarks), c.id.userId, ts, ts).run()
    return ok({ id })
  }))

  r.get('/finance/collections/grants/certificates/{id}', READ, fin(async (c) => {
    const cid = pathUUID(c)
    const row = await c.db.prepare(grantCertificateSQL + ` WHERE c.id = ?1`).bind(cid).first<Row>()
    if (!row) throw notFound()
    const view = grantCertificateView(row)
    let lines: CertLine[]
    if (view.status === 'draft') {
      // Live for a draft: the accountant is watching the figures settle.
      lines = await colDraftCertificateLines(c, Number(row.fy_start_year))
      let opening = 0, sanctioned = 0, received = 0, utilised = 0
      for (const l of lines) { opening += l.opening_unspent_paise; sanctioned += l.sanctioned_paise; received += l.received_paise; utilised += l.utilised_paise }
      view.opening_unspent_paise = opening; view.sanctioned_paise = sanctioned; view.received_paise = received; view.utilised_paise = utilised
      view.unspent_paise = received + opening - utilised
    } else {
      const lr = await c.db.prepare(`SELECT sanction_id, head_name, sanction_no, opening_unspent_paise, sanctioned_paise, received_paise, utilised_paise, unspent_paise
          FROM grant_utilisation_certificate_lines WHERE certificate_id = ?1 ORDER BY head_name`).bind(cid).all<Row>()
      lines = lr.results.map((l) => ({ sanction_id: String(l.sanction_id), head_name: String(l.head_name), sanction_no: String(l.sanction_no),
        opening_unspent_paise: Number(l.opening_unspent_paise), sanctioned_paise: Number(l.sanctioned_paise), received_paise: Number(l.received_paise),
        utilised_paise: Number(l.utilised_paise), unspent_paise: Number(l.unspent_paise) }))
    }
    return ok({ certificate: view, lines })
  }))

  r.post('/finance/collections/grants/certificates/{id}/issue', REFUND, fin(async (c) => {
    const cid = pathUUID(c)
    const req = await readJSON<Row>(c.req)
    const by = trim(req.certified_by)
    if (by === '') throw refuse('who is certifying this? the department will not accept an unsigned certificate')
    const on = colDate(req.issued_on)
    const cert = await c.db.prepare(`SELECT status, fy_start_year FROM grant_utilisation_certificates WHERE id = ?1`).bind(cid).first<{ status: string; fy_start_year: number }>()
    if (!cert) throw notFound()
    if (cert.status !== 'draft') throw refuse('that certificate has already been issued -- raise a revised one rather than editing a signed document')
    const fy = Number(cert.fy_start_year)
    const lines = await colDraftCertificateLines(c, fy)
    if (lines.length === 0) throw refuse(`no sanctions are recorded for ${fyLabel(fy)} -- there is nothing to certify`)
    let opening = 0, sanctioned = 0, received = 0, utilised = 0
    const stmts: D1PreparedStatement[] = []
    for (const l of lines) {
      stmts.push(c.db.prepare(`INSERT INTO grant_utilisation_certificate_lines (id, institution_id, certificate_id, sanction_id, head_name, sanction_no,
          opening_unspent_paise, sanctioned_paise, received_paise, utilised_paise, unspent_paise) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(uuid(), inst(c), cid, l.sanction_id, l.head_name, l.sanction_no, l.opening_unspent_paise, l.sanctioned_paise, l.received_paise, l.utilised_paise, l.unspent_paise))
      opening += l.opening_unspent_paise; sanctioned += l.sanctioned_paise; received += l.received_paise; utilised += l.utilised_paise
    }
    let unspent = received + opening - utilised
    const disposition = unspent <= 0 ? 'none' : 'pending'
    if (unspent < 0) unspent = 0
    stmts.push(c.db.prepare(`UPDATE grant_utilisation_certificates SET status = 'issued', issued_on = ?2, certified_by = ?3, opening_unspent_paise = ?4, sanctioned_paise = ?5,
        received_paise = ?6, utilised_paise = ?7, unspent_paise = ?8, unspent_disposition = ?9, updated_at = ?10 WHERE id = ?1`)
      .bind(cid, on, by, opening, sanctioned, received, utilised, unspent, disposition, now()))
    try { await c.db.batch(stmts) } catch (e) {
      if (isUniqueViolation(e)) throw refuse('that already exists: ' + (e as Error).message)
      throw e
    }
    return ok({ status: 'issued', unspent_paise: unspent, utilised_paise: utilised, line_count: lines.length })
  }))

  r.post('/finance/collections/grants/certificates/{id}/dispose', REFUND, fin(async (c) => {
    const cid = pathUUID(c)
    const req = await readJSON<Row>(c.req)
    const disposition = trim(req.disposition)
    if (!oneOf(disposition, 'carried_forward', 'refunded', 'none')) throw refuse('the balance is carried_forward, refunded, or none')
    const cert = await c.db.prepare(`SELECT status, unspent_paise FROM grant_utilisation_certificates WHERE id = ?1`).bind(cid).first<{ status: string; unspent_paise: number }>()
    if (!cert) throw notFound()
    const status = cert.status; const unspent = Number(cert.unspent_paise)
    if (status === 'draft') throw refuse('issue the certificate before disposing of its balance -- the figure is not final until it is signed')
    if (unspent <= 0 && disposition !== 'none') throw refuse('there is no unspent balance to dispose of')
    const out: Record<string, unknown> = {}
    const stmts: D1PreparedStatement[] = []
    let refundedOn: string | null = null
    let filedOn: string | null = null
    if (disposition === 'refunded') {
      refundedOn = colDate(req.refunded_on)
      if (trim(req.refund_reference) === '') throw refuse('a refund needs its challan or transaction reference')
    } else if (disposition === 'carried_forward') {
      const target = trim(req.carry_to_sanction_id)
      if (!isUUID(target)) throw refuse("which sanction is the balance carried into? it has to land somewhere or next year's head is understated")
      const t = await c.db.prepare(`SELECT opening_unspent_paise FROM grant_sanctions WHERE id = ?1`).bind(target).first<{ opening_unspent_paise: number }>()
      if (!t) throw notFound()
      const already = Number(t.opening_unspent_paise)
      stmts.push(c.db.prepare(`UPDATE grant_sanctions SET opening_unspent_paise = ?2, updated_at = ?3 WHERE id = ?1`).bind(target, already + unspent, now()))
      out.carried_to_opening_paise = already + unspent
    }
    let newStatus = status
    if (trim(req.filed_on) !== '' || trim(req.filed_reference) !== '') {
      filedOn = colDate(req.filed_on)
      newStatus = 'filed'
    }
    stmts.push(c.db.prepare(`UPDATE grant_utilisation_certificates SET unspent_disposition = ?2, refunded_on = ?3, refund_reference = NULLIF(?4, ''), status = ?5,
        filed_on = COALESCE(?6, filed_on), filed_reference = COALESCE(NULLIF(?7, ''), filed_reference), updated_at = ?8 WHERE id = ?1`)
      .bind(cid, disposition, refundedOn, trim(req.refund_reference), newStatus, filedOn, trim(req.filed_reference), now()))
    await c.db.batch(stmts)
    out.unspent_disposition = disposition; out.status = newStatus
    return ok(out)
  }))
}
