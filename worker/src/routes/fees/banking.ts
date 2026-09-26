import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, bool, clampInt, isUUID, like, notFound, now, ok, readJSON, uuid, uuidQuery } from '../../http'
import { can } from '../../identity'
import { fin, items, nowIST, p, paise, addDays, isDate, daysBetween, str, optStr, isForeignKeyViolation } from './common'
import { decodeBody, goTrimSpace, jsonChunks, parseStatement, payoutFile, sha256Hex, goQuote } from './fileformats'
import { school } from '../school'

/* Port of internal/api/banking.go: the school's bank accounts, the bank
   reconciliation statement, connected-banking payouts (maker/checker) and the
   student bank account register. Everything is integer paise; every money
   column touched here is INTEGER in tenant.sql.

   The CSV statement import and the payout bank file are ported through the
   pure parsers/writers in fileformats.ts. There is no live bank API in the Go
   code either: its one provider refuses to transmit.

   The SQLite schema carries none of the Postgres partial/expression unique
   indexes of 00046 (bank_accounts_number_once, bank_accounts_label_once,
   bank_statement_lines_one_claim_per_entry, payout_batches_no_once,
   payout_items_one_live_per_source, student_bank_accounts_one_primary,
   student_bank_accounts_no_duplicate) nor the direction generated column, so
   each rule is tested here with a SELECT before the write, and the trigger
   bank_statement_lines_respect_lock is a NOT EXISTS guard in the WHERE of
   every UPDATE that moves a line. */

const PAY_READ = 'finance.payments.read'
const PAY_WRITE = 'finance.payments.write'
const APPROVE = 'finance.refunds.write'
const EXPORT = 'finance.export'

const conflict = (code: string, msg: string) => new HttpError(409, msg, { code })
const denied = (msg: string) => new HttpError(403, msg, { code: 'forbidden' })
const inst = (c: Ctx) => school(c).id
const clientIP = (c: Ctx): string | null => c.req.headers.get('cf-connecting-ip')

/** Drops keys holding null/undefined: the Go structs' omitempty pointers. */
function omit<T extends object>(o: T): T {
  const r = o as Record<string, unknown>
  for (const k of Object.keys(r)) if (r[k] === null || r[k] === undefined) delete r[k]
  return o
}
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

// --- account numbers ---------------------------------------------------------

const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const ACCOUNT_SHAPE = /^[A-Za-z0-9]{6,20}$/
const validIFSC = (v: string) => IFSC_SHAPE.test(v.trim().toUpperCase())

/** Last four digits only; the masking lives on the server, never the screen. */
function maskAccountNumber(v: unknown): string {
  const a = str(v).trim()
  if (a === '') return ''
  if (a.length <= 4) return '•'.repeat(a.length)
  return '•'.repeat(a.length - 4) + a.slice(-4)
}
const lastFour = (a: string) => (a.length <= 4 ? a : a.slice(-4))

/** Integer paise as a plain decimal rupee string, by division and remainder. */
function rupeeString(v: number): string {
  const neg = v < 0
  if (neg) v = -v
  const out = `${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`
  return neg ? '-' + out : out
}

/** RFC3339 in India, the way nowInIndia().Format(time.RFC3339) printed it. */
const rfc3339IST = () => nowIST().toISOString().slice(0, 19) + '+05:30'

// --- the payout provider -----------------------------------------------------

const FILE_EXPORT = {
  name: 'file_export',
  label: 'Bank file (CSV upload)',
  can_transmit: false,
  why: 'This provider prepares a file for you to upload to your bank\'s own portal. ' +
    'Moving money directly from the ERP needs a corporate banking API agreement and ' +
    'credentials from your bank, which this installation does not hold.',
}
const payoutProviderKnown = (name: string) => name === '' || name === 'file_export'

// --- reconciliation: shapes and the book side --------------------------------

interface StatementLine {
  id: string; txn_date: string; narration: string; reference_no?: string | null; amount_paise: number
  direction: string; balance_paise?: number | null; raw_line: string; match_kind?: string | null
  match_id?: string | null; match_confidence?: string | null; matched_by?: string | null
  match_label?: string | null; explained_as?: string | null
}
interface BookEntry { kind: string; id: string; entry_date: string; amount_paise: number; reference?: string | null; party: string }

async function loadStatementLines(c: Ctx, recID: string): Promise<StatementLine[]> {
  const rows = await c.db.prepare(`
    SELECT l.id, l.txn_date, l.narration, l.reference_no, l.amount_paise,
           COALESCE(l.direction, CASE WHEN l.amount_paise >= 0 THEN 'credit' ELSE 'debit' END) AS direction,
           l.balance_paise, l.raw_line, l.match_kind, l.match_id, l.match_confidence, u.full_name AS matched_by, l.explained_as
      FROM bank_statement_lines l
      LEFT JOIN users u ON u.id = l.matched_by
     WHERE l.reconciliation_id = ?
     ORDER BY l.txn_date, l.line_no`).bind(recID).all<Record<string, unknown>>()
  return rows.results.map((r) => omit<StatementLine>({
    id: str(r.id), txn_date: str(r.txn_date), narration: str(r.narration), reference_no: s(r.reference_no),
    amount_paise: p(r.amount_paise), direction: str(r.direction), balance_paise: n(r.balance_paise), raw_line: str(r.raw_line),
    match_kind: s(r.match_kind), match_id: s(r.match_id), match_confidence: s(r.match_confidence),
    matched_by: s(r.matched_by), match_label: null, explained_as: s(r.explained_as),
  }))
}

/* The book side as one relation, signed the bank's way: money in positive,
   money out negative. Cash and adjustments never reach a statement. payments
   carry no bank account, so that source is over-inclusive on purpose. */
const BOOK_ENTRIES_SQL = `
  SELECT 'payment' AS kind, p.id AS id, p.paid_on AS entry_date, p.amount_paise AS amount_paise,
         NULLIF(TRIM(COALESCE(NULLIF(p.reference_no,''), NULLIF(p.gateway_txn_id,''), COALESCE(p.receipt_no,''))),'') AS reference,
         TRIM(st.first_name || COALESCE(' ' || st.last_name, '')) AS party
    FROM payments p
    JOIN students st ON st.id = p.student_id
   WHERE p.institution_id = ?1 AND p.status = 'success'
     AND p.mode NOT IN ('cash','adjustment')
     AND p.paid_on BETWEEN ?2 AND ?3
  UNION ALL
  SELECT 'vendor_payment', vp.id, vp.paid_on, -(vp.amount_paise - vp.tds_paise),
         NULLIF(TRIM(COALESCE(vp.reference_no,'')),''), v.name
    FROM vendor_payments vp
    JOIN vendor_bills vb ON vb.id = vp.bill_id
    JOIN vendors v ON v.id = vb.vendor_id
    JOIN bank_accounts ba ON ba.id = ?4
   WHERE vp.institution_id = ?1
     AND vp.mode NOT IN ('cash','adjustment')
     AND vp.paid_on BETWEEN ?2 AND ?3
     AND (ba.ledger_account_id IS NULL OR vp.paid_from_account_id = ba.ledger_account_id)
  UNION ALL
  SELECT 'payout_item', pi.id, pb.value_date, -pi.amount_paise, NULLIF(TRIM(COALESCE(pi.utr,'')),''), pi.beneficiary_name
    FROM payout_items pi
    JOIN payout_batches pb ON pb.id = pi.batch_id
   WHERE pi.institution_id = ?1 AND pb.bank_account_id = ?4
     AND pb.status = 'exported' AND pi.status IN ('exported','paid')
     AND pb.value_date BETWEEN ?2 AND ?3
  UNION ALL
  SELECT 'refund', rf.id, rf.processed_on, -rf.amount_paise, NULL,
         TRIM(st2.first_name || COALESCE(' ' || st2.last_name, ''))
    FROM refunds rf
    JOIN students st2 ON st2.id = rf.student_id
   WHERE rf.institution_id = ?1 AND rf.status = 'processed'
     AND rf.processed_on BETWEEN ?2 AND ?3`

async function loadBookEntries(c: Ctx, acct: string, start: string, end: string): Promise<BookEntry[]> {
  const rows = await c.db.prepare(BOOK_ENTRIES_SQL).bind(inst(c), start, end, acct).all<Record<string, unknown>>()
  return rows.results.map((r) => omit<BookEntry>({
    kind: str(r.kind), id: str(r.id), entry_date: str(r.entry_date), amount_paise: p(r.amount_paise),
    reference: s(r.reference), party: str(r.party),
  }))
}

const claimKey = (kind: string, id: string) => kind + ':' + id
function claimedBy(lines: StatementLine[]): Set<string> {
  const out = new Set<string>()
  for (const l of lines) if (l.match_kind && l.match_id) out.add(claimKey(l.match_kind, l.match_id))
  return out
}
const isOpen = (l: StatementLine) => !l.match_kind && !l.explained_as

// --- reconciliation: matching ------------------------------------------------

interface MatchCandidate extends BookEntry { reason: string; exact: boolean; day_gap: number }

/* Three days covers a Friday cheque clearing on Monday. */
const FUZZY_WINDOW_DAYS = 3

// Go's loop applies TrimPrefix for each prefix in turn, so more than one can be stripped.
function normaliseReference(v: string | null | undefined): string {
  let r = (v ?? '').trim().toUpperCase().replace(/[ \-/_#]/g, '')
  for (const prefix of ['UTR', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'REF', 'CHQ', 'TXN']) if (r.startsWith(prefix)) r = r.slice(prefix.length)
  return r
}

/** Amount equality always; exact when date and reference agree too. */
function candidatesFor(line: StatementLine, book: BookEntry[], claimed: Set<string>): MatchCandidate[] {
  const lineRef = normaliseReference(line.reference_no)
  const out: MatchCandidate[] = []
  for (const e of book) {
    if (claimed.has(claimKey(e.kind, e.id))) continue
    if (e.amount_paise !== line.amount_paise) continue
    if (!isDate(e.entry_date) || !isDate(line.txn_date)) continue
    const gap = Math.abs(daysBetween(e.entry_date, line.txn_date))
    if (gap > FUZZY_WINDOW_DAYS) continue
    const entryRef = normaliseReference(e.reference)
    const exact = gap === 0 && lineRef !== '' && entryRef !== '' && lineRef === entryRef
    let reason: string
    if (exact) reason = 'amount, date and reference all agree'
    else if (gap === 0 && lineRef !== '' && entryRef !== '') reason = 'amount and date agree, but the references differ'
    else if (gap === 0) reason = 'amount and date agree; no reference to compare'
    else reason = `amount agrees, ${gap} day(s) apart`
    out.push({ ...e, reason, exact, day_gap: gap })
  }
  return out
}

const widen = (start: string, end: string, days: number): [string, string] =>
  isDate(start) && isDate(end) ? [addDays(start, -days), addDays(end, days)] : [start, end]

/** The trigger bank_statement_lines_respect_lock as a WHERE guard. */
const LINE_UNLOCKED = `NOT EXISTS (SELECT 1 FROM bank_reconciliations r WHERE r.id = bank_statement_lines.reconciliation_id AND r.status = 'finalised')`

const FINALISED_MSG = 'this period is finalised. Reopen it, with a reason, before changing it.'

/** After a guarded UPDATE touched nothing: 404 when the line is absent, 409 when its period is finalised. */
async function explainLineNoop(c: Ctx, lineID: string): Promise<never> {
  const row = await c.db.prepare(`SELECT r.status FROM bank_statement_lines l LEFT JOIN bank_reconciliations r ON r.id = l.reconciliation_id
      WHERE l.id = ? AND l.institution_id = ?`).bind(lineID, inst(c)).first<{ status: string | null }>()
  if (!row) throw notFound()
  if (row.status === 'finalised') throw conflict('finalised', FINALISED_MSG)
  throw notFound()
}

// --- payouts -----------------------------------------------------------------

interface Standing { ok: boolean; code: string; why: string }
/** The maker/checker rule, in one place for the list and the write path. */
function approvalStanding(status: string, createdBy: string, caller: string, mayApprove: boolean): Standing {
  if (status !== 'submitted') return { ok: false, code: 'not_submitted', why: 'only a submitted batch can be released' }
  if (!mayApprove) return { ok: false, code: 'no_permission', why: 'releasing a payout needs the finance approve permission' }
  if (createdBy === caller) return { ok: false, code: 'assembled_by_caller', why: 'you assembled this batch, so somebody else must release it' }
  return { ok: true, code: '', why: '' }
}

/** The Indian financial year a date falls in, as 2026-27. */
function fyLabelForDate(iso: string): string {
  const d = isDate(iso) ? new Date(iso + 'T00:00:00Z') : nowIST()
  let y = d.getUTCFullYear()
  if (d.getUTCMonth() < 3) y--
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function batchView(r: Record<string, unknown>, c: Ctx, mayApprove: boolean) {
  const st = approvalStanding(str(r.status), str(r.created_by_id), c.id.userId, mayApprove)
  return omit({
    id: str(r.id), batch_no: str(r.batch_no), purpose: str(r.purpose), value_date: str(r.value_date), status: str(r.status),
    provider: str(r.provider), account_label: str(r.account_label), bank_account_id: str(r.bank_account_id),
    item_count: p(r.item_count), total_paise: p(r.total_paise), created_by: str(r.created_by), created_by_id: str(r.created_by_id),
    created_at: str(r.created_at), approved_by: s(r.approved_by), rejected_by: s(r.rejected_by), decision_reason: s(r.decision_reason),
    exported_at: s(r.exported_at), caller_may_approve: st.ok,
    approval_blocked: st.why === '' ? null : st.why, approval_blocked_code: st.code === '' ? null : st.code,
  })
}

const BATCH_SELECT = `
  SELECT pb.id, pb.batch_no, pb.purpose, pb.value_date, pb.status, pb.provider, b.label AS account_label, pb.bank_account_id,
         cu.full_name AS created_by, pb.created_by AS created_by_id, pb.created_at,
         au.full_name AS approved_by, ru.full_name AS rejected_by, pb.decision_reason, pb.exported_at,
         (SELECT count(*) FROM payout_items pi WHERE pi.batch_id = pb.id) AS item_count,
         (SELECT COALESCE(sum(pi.amount_paise),0) FROM payout_items pi WHERE pi.batch_id = pb.id) AS total_paise
    FROM payout_batches pb
    JOIN bank_accounts b ON b.id = pb.bank_account_id
    JOIN users cu ON cu.id = pb.created_by
    LEFT JOIN users au ON au.id = pb.approved_by
    LEFT JOIN users ru ON ru.id = pb.rejected_by`

interface PayoutItemReq {
  beneficiary_kind?: string; vendor_id?: string; employee_id?: string; student_id?: string; beneficiary_name?: string
  account_number?: string; ifsc?: string; amount_paise?: unknown; mode?: string; narration?: string; source_kind?: string; source_id?: string
}

/** A beneficiary's own bank details, so the number never round-trips through a browser. */
async function beneficiaryBank(c: Ctx, it: PayoutItemReq): Promise<[string, string]> {
  let q: string; let arg: string | null
  switch (it.beneficiary_kind) {
    case 'vendor': q = `SELECT COALESCE(bank_account,'') AS a, COALESCE(bank_ifsc,'') AS i FROM vendors WHERE id=? AND institution_id=?`; arg = uuidQuery(it.vendor_id ?? null); break
    case 'employee': q = `SELECT COALESCE(bank_account,'') AS a, COALESCE(bank_ifsc,'') AS i FROM employees WHERE id=? AND institution_id=?`; arg = uuidQuery(it.employee_id ?? null); break
    case 'student': q = `SELECT COALESCE(account_number,'') AS a, COALESCE(ifsc,'') AS i FROM student_bank_accounts WHERE student_id=? AND institution_id=? AND is_primary AND is_active LIMIT 1`; arg = uuidQuery(it.student_id ?? null); break
    default: return ['', '']
  }
  if (!arg) return ['', '']
  const row = await c.db.prepare(q).bind(arg, inst(c)).first<{ a: string; i: string }>()
  if (!row) return ['', '']
  return [str(row.a).trim(), str(row.i).trim().toUpperCase()]
}

// --- routes ------------------------------------------------------------------

export function registerBanking(r: Router): void {
  // --- the school's own bank accounts ------------------------------------
  r.get('/finance/banking/accounts', PAY_READ, fin(async (c) => {
    const rows = await c.db.prepare(`
      SELECT b.id, b.label, b.bank_name, b.branch, b.account_number, b.ifsc, b.account_type, b.allows_payouts, b.is_active,
             CASE WHEN la.id IS NULL THEN NULL ELSE la.code || ' ' || la.name END AS ledger_account,
             (SELECT max(i.imported_at) FROM bank_statement_imports i WHERE i.bank_account_id = b.id) AS last_import_at,
             (SELECT count(*) FROM bank_reconciliations rc WHERE rc.bank_account_id = b.id AND rc.status = 'open') AS open_periods
        FROM bank_accounts b
        LEFT JOIN ledger_accounts la ON la.id = b.ledger_account_id
       ORDER BY b.is_active DESC, b.label`).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omit({
      id: str(v.id), label: str(v.label), bank_name: str(v.bank_name), branch: s(v.branch),
      account_masked: maskAccountNumber(v.account_number), ifsc: str(v.ifsc), account_type: str(v.account_type),
      allows_payouts: bool(v.allows_payouts), is_active: bool(v.is_active), ledger_account: s(v.ledger_account),
      last_import_at: s(v.last_import_at), open_periods: p(v.open_periods),
    }))))
  }))

  r.post('/finance/banking/accounts', PAY_WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const label = str(req.label).trim()
    const bankName = str(req.bank_name).trim()
    const branch = str(req.branch)
    const accountNumber = str(req.account_number).trim()
    const ifsc = str(req.ifsc).trim().toUpperCase()
    const accountType = str(req.account_type) || 'current'
    const allowsPayouts = req.allows_payouts === true
    const active = req.is_active === null || req.is_active === undefined ? true : req.is_active === true

    if (label === '') throw badRequest('give the account a name the school will recognise, like "SBI main collection"')
    if (bankName === '') throw badRequest('which bank is this account with?')
    if (!ACCOUNT_SHAPE.test(accountNumber)) throw badRequest('an account number is 6 to 20 letters or digits, with no spaces')
    if (!validIFSC(ifsc)) throw badRequest('IFSC must be eleven characters: four letters, a zero, then six more, SBIN0001234')

    let ledger: string | null = null
    const ledgerRaw = str(req.ledger_account_id)
    if (ledgerRaw !== '') { if (!isUUID(ledgerRaw)) throw badRequest('malformed ledger account id'); ledger = ledgerRaw }
    let acctID = ''
    const idRaw = str(req.id)
    if (idRaw !== '') { if (!isUUID(idRaw)) throw badRequest('malformed account id'); acctID = idRaw }

    // bank_accounts_number_once and bank_accounts_label_once, tested here.
    const dupNo = await c.db.prepare(`SELECT id FROM bank_accounts WHERE institution_id = ? AND upper(trim(ifsc)) = ? AND upper(trim(account_number)) = ? AND id <> ?`)
      .bind(inst(c), ifsc, accountNumber.toUpperCase(), acctID).first()
    if (dupNo) throw badRequest('that account number is already registered at that IFSC')
    const dupLabel = await c.db.prepare(`SELECT id FROM bank_accounts WHERE institution_id = ? AND lower(trim(label)) = ? AND id <> ?`)
      .bind(inst(c), label.toLowerCase(), acctID).first()
    if (dupLabel) throw badRequest('another account already uses that name')

    if (acctID !== '') {
      const res = await c.db.prepare(`
        UPDATE bank_accounts
           SET label = ?3, bank_name = ?4, branch = NULLIF(?5,''), account_number = ?6, ifsc = ?7, account_type = ?8,
               allows_payouts = ?9, is_active = ?10, ledger_account_id = ?11, updated_at = ?12
         WHERE id = ?1 AND institution_id = ?2`)
        .bind(acctID, inst(c), label, bankName, branch, accountNumber, ifsc, accountType, allowsPayouts ? 1 : 0, active ? 1 : 0, ledger, now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: acctID })
    }
    acctID = uuid()
    const t = now()
    await c.db.prepare(`
      INSERT INTO bank_accounts (id, institution_id, label, bank_name, branch, account_number, ifsc, account_type,
                                 allows_payouts, is_active, ledger_account_id, created_at, updated_at)
      VALUES (?,?,?,?,NULLIF(?,''),?,?,?,?,?,?,?,?)`)
      .bind(acctID, inst(c), label, bankName, branch, accountNumber, ifsc, accountType, allowsPayouts ? 1 : 0, active ? 1 : 0, ledger, t, t).run()
    return ok({ id: acctID })
  }))

  // --- bank reconciliation statement -------------------------------------
  r.get('/finance/banking/reconciliations', PAY_READ, fin(async (c) => {
    const acct = uuidQuery(c.url.searchParams.get('bank_account_id'))
    const rows = await c.db.prepare(`
      SELECT rc.id, rc.bank_account_id, b.label AS account_label, rc.period_start, rc.period_end,
             rc.opening_balance_paise, rc.closing_balance_paise, rc.status,
             (SELECT count(*) FROM bank_statement_lines l WHERE l.reconciliation_id = rc.id) AS total,
             (SELECT count(*) FROM bank_statement_lines l WHERE l.reconciliation_id = rc.id AND l.match_kind IS NOT NULL) AS matched,
             (SELECT count(*) FROM bank_statement_lines l WHERE l.reconciliation_id = rc.id AND l.match_kind IS NULL AND l.explained_as IS NULL) AS unmatched,
             rc.finalised_at, u.full_name AS finalised_by, rc.difference_paise, rc.notes
        FROM bank_reconciliations rc
        JOIN bank_accounts b ON b.id = rc.bank_account_id
        LEFT JOIN users u ON u.id = rc.finalised_by
       WHERE (?1 IS NULL OR rc.bank_account_id = ?1)
       ORDER BY rc.period_start DESC, b.label`).bind(acct).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omit({
      id: str(v.id), bank_account_id: str(v.bank_account_id), account_label: str(v.account_label),
      period_start: str(v.period_start), period_end: str(v.period_end),
      opening_balance_paise: p(v.opening_balance_paise), closing_balance_paise: p(v.closing_balance_paise), status: str(v.status),
      line_count: p(v.total), matched_count: p(v.matched), unmatched_count: p(v.unmatched),
      finalised_at: s(v.finalised_at), finalised_by: s(v.finalised_by), difference_paise: n(v.difference_paise), notes: s(v.notes),
    }))))
  }))

  r.post('/finance/banking/reconciliations', PAY_WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const acct = str(req.bank_account_id).trim()
    if (!isUUID(acct)) throw badRequest('choose the bank account this statement belongs to')
    const start = str(req.period_start).trim()
    if (!isDate(start)) throw badRequest('period start must be a date, as YYYY-MM-DD')
    const end = str(req.period_end).trim()
    if (!isDate(end)) throw badRequest('period end must be a date, as YYYY-MM-DD')
    if (end < start) throw badRequest('the period ends before it starts')
    const opening = paise(req.opening_balance_paise, 'opening_balance_paise')
    const closing = paise(req.closing_balance_paise, 'closing_balance_paise')
    const notes = str(req.notes)
    let recID = ''
    const idRaw = str(req.id)
    if (idRaw !== '') { if (!isUUID(idRaw)) throw badRequest('malformed reconciliation id'); recID = idRaw }

    // bank_reconciliations_one_per_period exists in SQLite too; tested first for the sentence.
    const dup = await c.db.prepare(`SELECT id FROM bank_reconciliations WHERE institution_id = ? AND bank_account_id = ? AND period_start = ? AND period_end = ? AND id <> ?`)
      .bind(inst(c), acct, start, end, recID).first()
    if (dup) throw badRequest('that account already has a reconciliation for exactly this period')

    if (recID !== '') {
      const cur = await c.db.prepare(`SELECT status FROM bank_reconciliations WHERE id=? AND institution_id=?`).bind(recID, inst(c)).first<{ status: string }>()
      if (!cur) throw notFound()
      if (cur.status === 'finalised') throw conflict('finalised', FINALISED_MSG)
      await c.db.prepare(`
        UPDATE bank_reconciliations
           SET period_start = ?3, period_end = ?4, opening_balance_paise = ?5, closing_balance_paise = ?6, notes = NULLIF(?7,'')
         WHERE id = ?1 AND institution_id = ?2`).bind(recID, inst(c), start, end, opening, closing, notes).run()
      return ok({ id: recID })
    }
    recID = uuid()
    await c.db.prepare(`
      INSERT INTO bank_reconciliations (id, institution_id, bank_account_id, period_start, period_end, opening_balance_paise,
                                        closing_balance_paise, notes, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,NULLIF(?,''),?,?)`)
      .bind(recID, inst(c), acct, start, end, opening, closing, notes, c.id.userId, now()).run()
    return ok({ id: recID })
  }))

  r.get('/finance/banking/reconciliations/{id}', PAY_READ, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed reconciliation id')
    const recID = c.params.id
    const rc = await c.db.prepare(`
      SELECT rc.id, rc.bank_account_id, b.label AS account_label, rc.period_start, rc.period_end,
             rc.opening_balance_paise, rc.closing_balance_paise, rc.status, rc.finalised_at, u.full_name AS finalised_by, rc.notes
        FROM bank_reconciliations rc
        JOIN bank_accounts b ON b.id = rc.bank_account_id
        LEFT JOIN users u ON u.id = rc.finalised_by
       WHERE rc.id = ? AND rc.institution_id = ?`).bind(recID, inst(c)).first<Record<string, unknown>>()
    if (!rc) throw notFound()
    const acct = str(rc.bank_account_id)
    const periodStart = str(rc.period_start); const periodEnd = str(rc.period_end)
    const opening = p(rc.opening_balance_paise); const closing = p(rc.closing_balance_paise)

    const [lines, book, imps] = await Promise.all([
      loadStatementLines(c, recID),
      loadBookEntries(c, acct, periodStart, periodEnd),
      c.db.prepare(`
        SELECT i.id, i.filename, i.imported_at, u.full_name AS imported_by, i.rows_read, i.rows_inserted, i.rows_duplicate, i.rows_rejected, i.rejects
          FROM bank_statement_imports i
          LEFT JOIN users u ON u.id = i.imported_by
         WHERE i.bank_account_id = ? AND i.institution_id = ?
         ORDER BY i.imported_at DESC LIMIT 20`).bind(acct, inst(c)).all<Record<string, unknown>>(),
    ])

    const claimed = claimedBy(lines)
    const unmatchedBank: StatementLine[] = []
    let unmatchedBankPaise = 0
    for (const l of lines) if (isOpen(l)) { unmatchedBank.push(l); unmatchedBankPaise += l.amount_paise }
    const unmatchedBook: BookEntry[] = []
    let bookTotal = 0; let unmatchedBookPaise = 0
    for (const e of book) {
      bookTotal += e.amount_paise
      if (!claimed.has(claimKey(e.kind, e.id))) { unmatchedBook.push(e); unmatchedBookPaise += e.amount_paise }
    }
    const bookClosing = opening + bookTotal
    const difference = closing - bookClosing

    const imports = imps.results.map((v) => {
      let rejects: unknown = null
      try { rejects = v.rejects === null || v.rejects === undefined ? null : JSON.parse(str(v.rejects)) } catch { rejects = null }
      return omit({
        id: str(v.id), filename: str(v.filename), imported_at: str(v.imported_at), imported_by: s(v.imported_by),
        rows_read: p(v.rows_read), rows_inserted: p(v.rows_inserted), rows_duplicate: p(v.rows_duplicate), rows_rejected: p(v.rows_rejected),
        rejects,
      })
    })

    return ok(omit({
      id: str(rc.id), bank_account_id: acct, account_label: str(rc.account_label), period_start: periodStart, period_end: periodEnd,
      opening_balance_paise: opening, closing_balance_paise: closing, status: str(rc.status),
      line_count: lines.length, matched_count: lines.length - unmatchedBank.length, unmatched_count: unmatchedBank.length,
      finalised_at: s(rc.finalised_at), finalised_by: s(rc.finalised_by), difference_paise: difference, notes: s(rc.notes),
      bank_lines: lines, unmatched_bank: unmatchedBank, unmatched_book: unmatchedBook,
      bank_closing_paise: closing, book_closing_paise: bookClosing,
      unmatched_bank_paise: unmatchedBankPaise, unmatched_book_paise: unmatchedBookPaise,
      difference_explained: difference === unmatchedBankPaise - unmatchedBookPaise,
      imports,
    }))
  }))

  // importBankStatement: the raw CSV body (Content-Type text/csv), parsed line
  // by line (fileformats.ts), idempotent on the per-line sha256 hash.
  r.post('/finance/banking/reconciliations/{id}/import', PAY_WRITE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed reconciliation id')
    const recID = c.params.id
    const filename = (c.url.searchParams.get('filename') ?? '').trim() || 'statement.csv'
    let raw: ArrayBuffer
    try { raw = await c.req.arrayBuffer() } catch { throw badRequest('could not read the uploaded file') }
    if (raw.byteLength > 8 << 20) throw badRequest('could not read the uploaded file')
    const text = decodeBody(raw)
    if (goTrimSpace(text) === '') throw badRequest('the uploaded file is empty')
    const fileHash = await sha256Hex(raw)

    const { cols, rowsRead, parsed, rejects } = await parseStatement(text)
    if (!cols) {
      throw badRequest('no recognisable header row: the file needs a date column, a narration column, '
        + 'and either an amount column or separate debit and credit columns')
    }

    const rc = await c.db.prepare(`SELECT bank_account_id, period_start, period_end, status FROM bank_reconciliations WHERE id=? AND institution_id=?`)
      .bind(recID, inst(c)).first<{ bank_account_id: string; period_start: string; period_end: string; status: string }>()
    if (!rc) throw notFound()
    const locked = () => conflict('finalised', 'this period is finalised. Reopen it, with a reason, before importing into it.')
    if (rc.status === 'finalised') throw locked()

    const start = str(rc.period_start).slice(0, 10); const end = str(rc.period_end).slice(0, 10)
    let outside = 0
    const rows = parsed.map((pl) => {
      // A line outside the period is imported anyway, belonging to no reconciliation.
      const inPeriod = pl.txnDate >= start && pl.txnDate <= end
      if (!inPeriod) outside++
      return {
        r: inPeriod ? recID : null, d: pl.txnDate, v: pl.valueDate, n: pl.narration, f: pl.reference, a: pl.amount,
        b: pl.balance, w: pl.raw, l: pl.lineNo, h: pl.hash,
      }
    })

    const importID = uuid()
    // The import row is written only while the period is still open: when it is
    // not, every line insert below fails its import_id foreign key and the
    // batch rolls back — bank_statement_lines_respect_lock, at write time.
    const stmts: D1PreparedStatement[] = [c.db.prepare(`
      INSERT INTO bank_statement_imports (id, institution_id, bank_account_id, filename, file_hash, rows_read, rows_rejected, rejects, imported_by, imported_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE EXISTS (SELECT 1 FROM bank_reconciliations WHERE id = ?11 AND institution_id = ?2 AND status <> 'finalised')`)
      .bind(importID, inst(c), rc.bank_account_id, filename, fileHash, rowsRead, rejects.length, JSON.stringify(rejects), c.id.userId, now(), recID)]
    const chunks = jsonChunks(rows)
    for (const ch of chunks) {
      stmts.push(c.db.prepare(`
        INSERT INTO bank_statement_lines (id, institution_id, bank_account_id, import_id, reconciliation_id, txn_date, value_date, narration,
                                          reference_no, amount_paise, direction, balance_paise, raw_line, line_no, line_hash, created_at)
        SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-'
                 || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
               ?1, ?2, ?3, json_extract(value, '$.r'), json_extract(value, '$.d'), json_extract(value, '$.v'), json_extract(value, '$.n'),
               NULLIF(json_extract(value, '$.f'), ''), json_extract(value, '$.a'),
               CASE WHEN json_extract(value, '$.a') >= 0 THEN 'credit' ELSE 'debit' END,
               json_extract(value, '$.b'), json_extract(value, '$.w'), json_extract(value, '$.l'), json_extract(value, '$.h'), ?4
          FROM json_each(?5) WHERE true
        ON CONFLICT DO NOTHING`).bind(inst(c), rc.bank_account_id, importID, now(), ch))
    }
    stmts.push(c.db.prepare(`
      UPDATE bank_statement_imports
         SET rows_inserted = (SELECT COUNT(*) FROM bank_statement_lines WHERE import_id = ?1),
             rows_duplicate = ?2 - (SELECT COUNT(*) FROM bank_statement_lines WHERE import_id = ?1)
       WHERE id = ?1`).bind(importID, parsed.length))
    let res: D1Result[]
    try { res = await c.db.batch(stmts) } catch (e) {
      if (isForeignKeyViolation(e)) throw locked()
      throw e
    }
    if (!res[0].meta.changes) throw locked()
    let inserted = 0
    for (let i = 1; i <= chunks.length; i++) inserted += res[i].meta.changes ?? 0
    return ok({
      import_id: importID, rows_read: rowsRead, rows_inserted: inserted, rows_duplicate: parsed.length - inserted,
      rows_rejected: rejects.length, rows_outside_period: outside, rejects,
    })
  }))

  r.post('/finance/banking/reconciliations/{id}/auto-match', PAY_WRITE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed reconciliation id')
    const recID = c.params.id
    const rc = await c.db.prepare(`SELECT bank_account_id, period_start, period_end, status FROM bank_reconciliations WHERE id=? AND institution_id=?`)
      .bind(recID, inst(c)).first<{ bank_account_id: string; period_start: string; period_end: string; status: string }>()
    if (!rc) throw notFound()
    if (rc.status === 'finalised') throw conflict('finalised', 'this period is finalised. Reopen it, with a reason, before matching.')

    const lines = await loadStatementLines(c, recID)
    const [wideStart, wideEnd] = widen(rc.period_start, rc.period_end, FUZZY_WINDOW_DAYS)
    const book = await loadBookEntries(c, rc.bank_account_id, wideStart, wideEnd)
    const claimed = claimedBy(lines)

    let matched = 0; let ambiguous = 0
    // First pass: exact candidates for every open line, so a book entry
    // wanted by two lines is spotted and left alone.
    const proposals: { line: StatementLine; entry: BookEntry }[] = []
    const wanted = new Map<string, number>()
    for (const l of lines) {
      if (!isOpen(l)) continue
      const exacts = candidatesFor(l, book, claimed).filter((x) => x.exact)
      if (exacts.length !== 1) { if (exacts.length > 1) ambiguous++; continue }
      proposals.push({ line: l, entry: exacts[0] })
      const k = claimKey(exacts[0].kind, exacts[0].id)
      wanted.set(k, (wanted.get(k) ?? 0) + 1)
    }

    const stmts: D1PreparedStatement[] = []
    const t = now()
    for (const pr of proposals) {
      if ((wanted.get(claimKey(pr.entry.kind, pr.entry.id)) ?? 0) > 1) { ambiguous++; continue }
      if (!isUUID(pr.entry.id)) continue
      // bank_statement_lines_one_claim_per_entry and the lock trigger, both in the WHERE.
      stmts.push(c.db.prepare(`
        UPDATE bank_statement_lines
           SET match_kind = ?3, match_id = ?4, match_confidence = 'exact', matched_by = ?5, matched_at = ?6
         WHERE id = ?1 AND institution_id = ?2 AND match_kind IS NULL AND explained_as IS NULL
           AND ${LINE_UNLOCKED}
           AND NOT EXISTS (SELECT 1 FROM bank_statement_lines o WHERE o.institution_id = ?2 AND o.match_kind = ?3 AND o.match_id = ?4)`)
        .bind(pr.line.id, inst(c), pr.entry.kind, pr.entry.id, c.id.userId, t))
    }
    if (stmts.length) {
      const results = await c.db.batch(stmts)
      for (const res of results) { if (res.meta.changes === 1) matched++; else ambiguous++ }
    }
    const rem = await c.db.prepare(`SELECT count(*) AS n FROM bank_statement_lines WHERE reconciliation_id = ? AND match_kind IS NULL AND explained_as IS NULL`)
      .bind(recID).first<{ n: number }>()
    return ok({ matched, ambiguous, remaining: rem?.n ?? 0 })
  }))

  r.get('/finance/banking/reconciliations/{id}/candidates/{lineID}', PAY_READ, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed reconciliation id')
    if (!isUUID(c.params.lineID)) throw badRequest('malformed line id')
    const recID = c.params.id
    const rc = await c.db.prepare(`SELECT bank_account_id, period_start, period_end FROM bank_reconciliations WHERE id=? AND institution_id=?`)
      .bind(recID, inst(c)).first<{ bank_account_id: string; period_start: string; period_end: string }>()
    if (!rc) throw notFound()
    const lines = await loadStatementLines(c, recID)
    const target = lines.find((l) => l.id === c.params.lineID)
    if (!target) throw notFound()
    const claimed = claimedBy(lines)
    // Widened by the fuzzy tolerance, or a cheque banked on the first can never
    // match the payment recorded on the last of the previous month.
    const [wideStart, wideEnd] = widen(rc.period_start, rc.period_end, FUZZY_WINDOW_DAYS)
    const book = await loadBookEntries(c, rc.bank_account_id, wideStart, wideEnd)
    return ok(items(candidatesFor(target, book, claimed)))
  }))

  r.post('/finance/banking/lines/{id}/match', PAY_WRITE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed line id')
    const lineID = c.params.id
    const req = await readJSON<Record<string, unknown>>(c.req)
    const kind = str(req.match_kind).trim()
    const explainedAs = str(req.explained_as).trim()
    if (explainedAs === '' && !['payment', 'vendor_payment', 'payout_item', 'refund'].includes(kind)) {
      throw badRequest('say what this line is: a payment, vendor_payment, payout_item or refund. Or explain it instead')
    }
    let entryID: string | null = null
    if (explainedAs === '') {
      const raw = str(req.match_id).trim()
      if (!isUUID(raw)) throw badRequest('malformed book entry id')
      entryID = raw
    }

    let res: D1Result
    if (explainedAs !== '') {
      res = await c.db.prepare(`
        UPDATE bank_statement_lines
           SET explained_as = ?3, match_kind = NULL, match_id = NULL, match_confidence = NULL, matched_by = ?4, matched_at = ?5
         WHERE id = ?1 AND institution_id = ?2 AND ${LINE_UNLOCKED}`)
        .bind(lineID, inst(c), explainedAs, c.id.userId, now()).run()
    } else {
      // bank_statement_lines_one_claim_per_entry: another line already holds this entry.
      const clash = await c.db.prepare(`SELECT id FROM bank_statement_lines WHERE institution_id = ? AND match_kind = ? AND match_id = ? AND id <> ?`)
        .bind(inst(c), kind, entryID, lineID).first()
      if (clash) throw badRequest('another statement line is already matched to that book entry, unmatch it first')
      // The Go handler never touches payments here: the match on the line is
      // the record (payments.reconciled_at is deliberately left alone), so
      // this single UPDATE is the whole write.
      res = await c.db.prepare(`
        UPDATE bank_statement_lines
           SET match_kind = ?3, match_id = ?4, match_confidence = 'manual', explained_as = NULL, matched_by = ?5, matched_at = ?6
         WHERE id = ?1 AND institution_id = ?2 AND ${LINE_UNLOCKED}`)
        .bind(lineID, inst(c), kind, entryID, c.id.userId, now()).run()
    }
    if (!res.meta.changes) await explainLineNoop(c, lineID)
    return ok({ ok: true })
  }))

  r.post('/finance/banking/lines/{id}/unmatch', PAY_WRITE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed line id')
    const lineID = c.params.id
    const res = await c.db.prepare(`
      UPDATE bank_statement_lines
         SET match_kind = NULL, match_id = NULL, match_confidence = NULL, explained_as = NULL, matched_by = NULL, matched_at = NULL
       WHERE id = ?1 AND institution_id = ?2 AND ${LINE_UNLOCKED}`).bind(lineID, inst(c)).run()
    if (!res.meta.changes) await explainLineNoop(c, lineID)
    return ok({ ok: true })
  }))

  // Finalising and reopening are the checker's, not the clerk's.
  r.post('/finance/banking/reconciliations/{id}/finalise', APPROVE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed reconciliation id')
    const recID = c.params.id
    const req = await readJSON<Record<string, unknown>>(c.req)
    const notes = str(req.notes)
    const acknowledge = req.acknowledge_difference === true

    const rc = await c.db.prepare(`SELECT bank_account_id, period_start, period_end, status, opening_balance_paise, closing_balance_paise
        FROM bank_reconciliations WHERE id=? AND institution_id=?`).bind(recID, inst(c))
      .first<{ bank_account_id: string; period_start: string; period_end: string; status: string; opening_balance_paise: number; closing_balance_paise: number }>()
    if (!rc) throw notFound()
    if (rc.status === 'finalised') throw conflict('finalised', 'this period is already finalised')

    const lines = await loadStatementLines(c, recID)
    const book = await loadBookEntries(c, rc.bank_account_id, rc.period_start, rc.period_end)
    const claimed = claimedBy(lines)
    let unbankCount = 0; let unbankPaise = 0
    for (const l of lines) if (isOpen(l)) { unbankCount++; unbankPaise += l.amount_paise }
    let bookTotal = 0; let unbookPaise = 0; let unbookCount = 0
    const unmatchedBook: BookEntry[] = []
    for (const e of book) {
      bookTotal += e.amount_paise
      if (!claimed.has(claimKey(e.kind, e.id))) { unbookCount++; unbookPaise += e.amount_paise; unmatchedBook.push(e) }
    }
    const opening = p(rc.opening_balance_paise); const closing = p(rc.closing_balance_paise)
    const bookClosing = opening + bookTotal
    const diff = closing - bookClosing
    if (diff !== unbankPaise - unbookPaise && !acknowledge) {
      throw conflict('unexplained_difference',
        `the residue does not account for the difference of ${rupeeString(diff)}. ` +
        'Match or explain the remaining lines, or finalise again acknowledging the gap.')
    }
    // The Go snapshot stores every line under "unmatched_bank_lines"; kept as is.
    const snapshot = JSON.stringify({
      frozen_at: rfc3339IST(), bank_closing_paise: closing, book_closing_paise: bookClosing,
      line_count: lines.length, matched_count: lines.length - unbankCount,
      unmatched_bank_lines: lines, unmatched_book: unmatchedBook,
    })
    await c.db.prepare(`
      UPDATE bank_reconciliations
         SET status = 'finalised', finalised_by = ?2, finalised_at = ?11, book_closing_paise = ?3, unmatched_bank_count = ?4,
             unmatched_bank_paise = ?5, unmatched_book_count = ?6, unmatched_book_paise = ?7, difference_paise = ?8,
             snapshot = ?9, notes = COALESCE(NULLIF(?10,''), notes)
       WHERE id = ?1 AND status <> 'finalised'`)
      .bind(recID, c.id.userId, bookClosing, unbankCount, unbankPaise, unbookCount, unbookPaise, diff, snapshot, notes, now()).run()
    return ok({ ok: true, difference_paise: diff })
  }))

  r.post('/finance/banking/reconciliations/{id}/reopen', APPROVE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed reconciliation id')
    const req = await readJSON<Record<string, unknown>>(c.req)
    const reason = str(req.reason).trim()
    if (reason === '') throw badRequest('reopening a finalised period needs a reason')
    const res = await c.db.prepare(`
      UPDATE bank_reconciliations SET status = 'open', reopened_by = ?3, reopened_at = ?5, reopen_reason = ?4
       WHERE id = ?1 AND institution_id = ?2 AND status = 'finalised'`).bind(c.params.id, inst(c), c.id.userId, reason, now()).run()
    if (!res.meta.changes) throw conflict('not_finalised', 'that period is not finalised, so there is nothing to reopen')
    return ok({ ok: true })
  }))

  // --- connected banking payouts -----------------------------------------
  r.get('/finance/banking/payouts', PAY_READ, fin(async (c) => {
    const q = c.url.searchParams
    const status = optStr(q.get('status'))
    const limit = clampInt(q.get('limit'), 100, 1, 500)
    const mayApprove = can(c.id, APPROVE)
    const rows = await c.db.prepare(`${BATCH_SELECT} WHERE (?1 IS NULL OR pb.status = ?1) ORDER BY pb.created_at DESC LIMIT ?2`)
      .bind(status, limit).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => batchView(v, c, mayApprove))))
  }))

  // The honesty endpoint: this installation prepares files and does not transmit.
  r.get('/finance/banking/payouts/providers', PAY_READ, fin(async () => ok(items([omit({ ...FILE_EXPORT, why: FILE_EXPORT.why || null })]))))

  r.get('/finance/banking/payouts/candidates', PAY_READ, fin(async (c) => {
    const kind = c.url.searchParams.get('kind') || 'vendor_bill'
    let sql: string
    switch (kind) {
      case 'vendor_bill':
        sql = `
          SELECT 'vendor_bill' AS source_kind, vb.id AS source_id, 'vendor' AS kind, v.id AS beneficiary_id, v.name AS name,
                 COALESCE(v.bank_account,'') AS acct, COALESCE(v.bank_ifsc,'') AS ifsc,
                 vb.total_paise - COALESCE((SELECT sum(vp.amount_paise) FROM vendor_payments vp WHERE vp.bill_id = vb.id),0) AS amount_paise,
                 vb.bill_no AS reference, vb.due_on AS due_on, NULL AS py, NULL AS pm
            FROM vendor_bills vb
            JOIN vendors v ON v.id = vb.vendor_id
           WHERE vb.status = 'approved'
             AND vb.total_paise - COALESCE((SELECT sum(vp.amount_paise) FROM vendor_payments vp WHERE vp.bill_id = vb.id),0) > 0
             AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.source_kind = 'vendor_bill' AND pi.source_id = vb.id AND pi.status IN ('pending','exported','paid'))
           ORDER BY vb.due_on IS NULL, vb.due_on, v.name`
        break
      case 'payslip':
        sql = `
          SELECT 'payslip' AS source_kind, ps.id AS source_id, 'employee' AS kind, e.id AS beneficiary_id,
                 TRIM(e.first_name || COALESCE(' ' || e.last_name, '')) AS name,
                 COALESCE(e.bank_account,'') AS acct, COALESCE(e.bank_ifsc,'') AS ifsc,
                 ps.net_paise AS amount_paise, '' AS reference, NULL AS due_on, pr.period_year AS py, pr.period_month AS pm
            FROM payslips ps
            JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
            JOIN employees e ON e.id = ps.employee_id
           WHERE pr.status IN ('processed','locked') AND ps.net_paise > 0
             AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.source_kind = 'payslip' AND pi.source_id = ps.id AND pi.status IN ('pending','exported','paid'))
           ORDER BY pr.period_year DESC, pr.period_month DESC, e.first_name`
        break
      case 'refund':
        sql = `
          SELECT 'refund' AS source_kind, rf.id AS source_id, 'student' AS kind, st.id AS beneficiary_id,
                 TRIM(st.first_name || COALESCE(' ' || st.last_name, '')) AS name,
                 COALESCE((SELECT b.account_number FROM student_bank_accounts b WHERE b.student_id = rf.student_id AND b.is_active AND b.is_primary LIMIT 1),'') AS acct,
                 COALESCE((SELECT b.ifsc FROM student_bank_accounts b WHERE b.student_id = rf.student_id AND b.is_active AND b.is_primary LIMIT 1),'') AS ifsc,
                 rf.amount_paise AS amount_paise, COALESCE(rf.reason,'') AS reference, NULL AS due_on, NULL AS py, NULL AS pm
            FROM refunds rf
            JOIN students st ON st.id = rf.student_id
           WHERE rf.status = 'approved'
             AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.source_kind = 'refund' AND pi.source_id = rf.id AND pi.status IN ('pending','exported','paid'))
           ORDER BY rf.created_at DESC`
        break
      default:
        throw badRequest('kind must be vendor_bill, payslip or refund')
    }
    const rows = await c.db.prepare(sql).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => {
      const acct = str(v.acct); const ifsc = str(v.ifsc)
      // to_char(make_date(year, month, 1), 'Mon YYYY'), computed here.
      const reference = kind === 'payslip' ? `${MON[(p(v.pm) - 1 + 12) % 12]} ${p(v.py)}` : str(v.reference)
      return omit({
        source_kind: str(v.source_kind), source_id: str(v.source_id), beneficiary_kind: str(v.kind), beneficiary_id: str(v.beneficiary_id),
        beneficiary_name: str(v.name), account_masked: maskAccountNumber(acct), has_bank: acct !== '' && ifsc !== '',
        ifsc: ifsc !== '' ? ifsc : null, amount_paise: p(v.amount_paise), reference, due_on: s(v.due_on),
      })
    })))
  }))

  r.get('/finance/banking/payouts/{id}', PAY_READ, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed batch id')
    const batchID = c.params.id
    const row = await c.db.prepare(`${BATCH_SELECT} WHERE pb.id = ? AND pb.institution_id = ?`).bind(batchID, inst(c)).first<Record<string, unknown>>()
    if (!row) throw notFound()
    const rows = await c.db.prepare(`
      SELECT id, beneficiary_kind, beneficiary_name, account_number, ifsc, amount_paise, mode, narration, source_kind, source_id, status, utr
        FROM payout_items WHERE batch_id = ? AND institution_id = ? ORDER BY beneficiary_name`).bind(batchID, inst(c)).all<Record<string, unknown>>()
    let total = 0
    const list = rows.results.map((v) => {
      total += p(v.amount_paise)
      return omit({
        id: str(v.id), beneficiary_kind: str(v.beneficiary_kind), beneficiary_name: str(v.beneficiary_name),
        account_masked: maskAccountNumber(v.account_number), ifsc: str(v.ifsc), amount_paise: p(v.amount_paise), mode: str(v.mode),
        narration: s(v.narration), source_kind: s(v.source_kind), source_id: s(v.source_id), status: str(v.status), utr: s(v.utr),
      })
    })
    const view = batchView(row, c, can(c.id, APPROVE))
    view.item_count = list.length
    view.total_paise = total
    return ok({ ...view, items: list })
  }))

  r.post('/finance/banking/payouts', PAY_WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const acct = str(req.bank_account_id).trim()
    if (!isUUID(acct)) throw badRequest('choose the account the money leaves from')
    const purpose = str(req.purpose)
    if (!['vendor', 'salary', 'refund', 'scholarship', 'mixed'].includes(purpose)) throw badRequest('purpose must be vendor, salary, refund, scholarship or mixed')
    const providerRaw = str(req.provider)
    if (!payoutProviderKnown(providerRaw)) throw badRequest('unknown payout provider')
    const provider = providerRaw || 'file_export'
    const ist = nowIST()
    let valueDate = str(req.value_date).trim()
    if (valueDate === '') valueDate = ist.toISOString().slice(0, 10)
    if (!isDate(valueDate)) throw badRequest('value date must be a date, as YYYY-MM-DD')
    let batchNo = str(req.batch_no).trim()
    if (batchNo === '') {
      const stamp = ist.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
      batchNo = `PO/${fyLabelForDate(valueDate)}/${stamp}`
    }
    const notes = str(req.notes)

    const ba = await c.db.prepare(`SELECT allows_payouts, is_active FROM bank_accounts WHERE id=? AND institution_id=?`).bind(acct, inst(c))
      .first<{ allows_payouts: number; is_active: number }>()
    if (!ba) throw notFound()
    if (!bool(ba.allows_payouts) || !bool(ba.is_active)) {
      throw badRequest('that account is not marked for payouts. Enable payouts on it first - it stops a collection account being debited by accident.')
    }
    // payout_batches_no_once, tested here.
    const dup = await c.db.prepare(`SELECT id FROM payout_batches WHERE institution_id = ? AND lower(trim(batch_no)) = ?`).bind(inst(c), batchNo.toLowerCase()).first()
    if (dup) throw badRequest('a batch with that number already exists')
    const batchID = uuid()
    await c.db.prepare(`
      INSERT INTO payout_batches (id, institution_id, bank_account_id, batch_no, purpose, value_date, provider, notes, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,NULLIF(?,''),?,?)`).bind(batchID, inst(c), acct, batchNo, purpose, valueDate, provider, notes, c.id.userId, now()).run()
    return ok({ id: batchID, batch_no: batchNo })
  }))

  r.post('/finance/banking/payouts/{id}/items', PAY_WRITE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed batch id')
    const batchID = c.params.id
    const req = await readJSON<{ items?: PayoutItemReq[] }>(c.req)
    const list = Array.isArray(req.items) ? req.items : []
    if (list.length === 0) throw badRequest('no beneficiaries given')

    const amounts: number[] = []
    list.forEach((it, i) => {
      const name = str(it.beneficiary_name).trim()
      if (!['vendor', 'employee', 'student', 'other'].includes(str(it.beneficiary_kind))) throw badRequest(`row ${i + 1}: beneficiary kind must be vendor, employee, student or other`)
      if (name === '') throw badRequest(`row ${i + 1}: the beneficiary needs a name`)
      const amt = paise(it.amount_paise)
      if (amt <= 0) throw badRequest(`row ${i + 1} (${it.beneficiary_name}): amount must be positive`)
      amounts.push(amt)
      // Account number and IFSC are normally omitted: the register masks what
      // it shows, so the server reads them from the beneficiary's own record.
      if (str(it.account_number).trim() !== '' || str(it.ifsc).trim() !== '') {
        if (!ACCOUNT_SHAPE.test(str(it.account_number).trim())) throw badRequest(`row ${i + 1} (${it.beneficiary_name}): account number must be 6 to 20 letters or digits`)
        if (!validIFSC(str(it.ifsc))) throw badRequest(`row ${i + 1} (${it.beneficiary_name}): IFSC must look like SBIN0001234`)
        return
      }
      if (it.beneficiary_kind === 'other') {
        throw badRequest(`row ${i + 1} (${it.beneficiary_name}): an ad-hoc beneficiary is not on file, so the account number and IFSC must be given`)
      }
    })

    const batch = await c.db.prepare(`SELECT status FROM payout_batches WHERE id=? AND institution_id=?`).bind(batchID, inst(c)).first<{ status: string }>()
    if (!batch) throw notFound()
    if (batch.status !== 'draft') throw conflict('not_draft', 'this batch has already been submitted. A batch cannot change after a checker has seen it.')

    const stmts: D1PreparedStatement[] = []
    const noBank: string[] = []
    const seenSources = new Set<string>()
    for (let i = 0; i < list.length; i++) {
      const it = list[i]
      const mode = str(it.mode) || 'neft'
      let acctNo = str(it.account_number).trim()
      let ifsc = str(it.ifsc).trim().toUpperCase()
      if (acctNo === '') {
        const [ra, ri] = await beneficiaryBank(c, it)
        if (!ACCOUNT_SHAPE.test(ra) || !IFSC_SHAPE.test(ri)) { noBank.push(str(it.beneficiary_name)); continue }
        acctNo = ra; ifsc = ri
      }
      const sourceKind = optStr(it.source_kind)
      const sourceID = uuidQuery(str(it.source_id) || null)
      // payout_items_one_live_per_source, tested here (and within this request).
      if (sourceKind && sourceKind !== 'manual') {
        const key = sourceKind + ':' + (sourceID ?? '00000000-0000-0000-0000-000000000000')
        const live = seenSources.has(key) || !!(await c.db.prepare(`
          SELECT 1 FROM payout_items WHERE institution_id = ? AND source_kind = ? AND COALESCE(source_id,'00000000-0000-0000-0000-000000000000') = ?
             AND status IN ('pending','exported','paid') LIMIT 1`).bind(inst(c), sourceKind, sourceID ?? '00000000-0000-0000-0000-000000000000').first())
        if (live) {
          throw badRequest('one of those documents is already in a live payout batch. Paying it twice is the failure this refuses. Remove it, or cancel the other batch.')
        }
        seenSources.add(key)
      }
      stmts.push(c.db.prepare(`
        INSERT INTO payout_items (id, institution_id, batch_id, beneficiary_kind, vendor_id, employee_id, student_id, beneficiary_name,
                                  account_number, ifsc, amount_paise, mode, narration, source_kind, source_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULLIF(?,''),?,?,?)`)
        .bind(uuid(), inst(c), batchID, str(it.beneficiary_kind), uuidQuery(str(it.vendor_id) || null), uuidQuery(str(it.employee_id) || null),
          uuidQuery(str(it.student_id) || null), str(it.beneficiary_name).trim(), acctNo, ifsc, amounts[i], mode, str(it.narration), sourceKind, sourceID, now()))
    }
    if (stmts.length) await c.db.batch(stmts)
    return ok({ added: stmts.length, skipped_no_bank: noBank })
  }))

  r.del('/finance/banking/payouts/{id}/items/{itemID}', PAY_WRITE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed batch id')
    if (!isUUID(c.params.itemID)) throw badRequest('malformed item id')
    const batch = await c.db.prepare(`SELECT status FROM payout_batches WHERE id=? AND institution_id=?`).bind(c.params.id, inst(c)).first<{ status: string }>()
    if (!batch) throw notFound()
    if (batch.status !== 'draft') throw conflict('not_draft', 'this batch has already been submitted and cannot change')
    const res = await c.db.prepare(`DELETE FROM payout_items WHERE id=? AND batch_id=? AND institution_id=?`).bind(c.params.itemID, c.params.id, inst(c)).run()
    if (!res.meta.changes) throw notFound()
    return ok({ ok: true })
  }))

  r.post('/finance/banking/payouts/{id}/submit', PAY_WRITE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed batch id')
    const row = await c.db.prepare(`SELECT pb.status, (SELECT count(*) FROM payout_items pi WHERE pi.batch_id = pb.id) AS n
        FROM payout_batches pb WHERE pb.id=? AND pb.institution_id=?`).bind(c.params.id, inst(c)).first<{ status: string; n: number }>()
    if (!row) throw notFound()
    if (row.status !== 'draft') throw conflict('not_draft', 'only a draft batch can be submitted')
    if (p(row.n) === 0) throw badRequest('this batch has no beneficiaries in it')
    await c.db.prepare(`UPDATE payout_batches SET status='submitted', submitted_at=? WHERE id=? AND status='draft'`).bind(now(), c.params.id).run()
    return ok({ ok: true })
  }))

  // The checker's verb: re-tests maker != checker regardless of the permission.
  r.post('/finance/banking/payouts/{id}/decide', APPROVE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed batch id')
    const batchID = c.params.id
    const req = await readJSON<Record<string, unknown>>(c.req)
    const approve = req.approve === true
    const reason = str(req.reason)
    if (!approve && reason.trim() === '') throw badRequest('refusing a batch needs a reason the maker can act on')
    const row = await c.db.prepare(`SELECT status, created_by FROM payout_batches WHERE id=? AND institution_id=?`).bind(batchID, inst(c))
      .first<{ status: string; created_by: string }>()
    if (!row) throw notFound()
    const st = approvalStanding(row.status, row.created_by, c.id.userId, can(c.id, APPROVE))
    if (!st.ok) throw denied(st.why)
    // The maker/checker CHECK of 00046 is the created_by <> ?2 in the WHERE.
    const res = approve
      ? await c.db.prepare(`UPDATE payout_batches SET status='approved', approved_by=?2, approved_at=?4, decision_reason=NULLIF(?3,'')
           WHERE id=?1 AND status='submitted' AND created_by <> ?2`).bind(batchID, c.id.userId, reason, now()).run()
      : await c.db.prepare(`UPDATE payout_batches SET status='rejected', rejected_by=?2, rejected_at=?4, decision_reason=?3
           WHERE id=?1 AND status='submitted' AND created_by <> ?2`).bind(batchID, c.id.userId, reason.trim(), now()).run()
    if (!res.meta.changes) throw denied('you assembled this batch, so somebody else must release it')
    return ok({ ok: true })
  }))

  // exportPayoutFile: the CSV the bank's bulk-upload wants. Producing it is
  // what flips the batch and its pending items to 'exported'.
  r.get('/finance/banking/payouts/{id}/file', EXPORT, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed batch id')
    const batchID = c.params.id
    const h = await c.db.prepare(`
      SELECT pb.batch_no, pb.provider, pb.status
        FROM payout_batches pb JOIN bank_accounts b ON b.id = pb.bank_account_id
       WHERE pb.id=? AND pb.institution_id=?`).bind(batchID, inst(c)).first<{ batch_no: string; provider: string; status: string }>()
    if (!h) throw notFound()
    if (h.status !== 'approved' && h.status !== 'exported') {
      throw conflict('not_approved', 'this batch has not been released by a checker, so there is no file to produce')
    }
    // payoutProviderFor: '' and 'file_export' are the one provider there is.
    if (h.provider !== '' && h.provider !== 'file_export') throw new Error(`batch names an unknown provider "${h.provider}"`)
    const [lines, upd] = await c.db.batch([
      c.db.prepare(`SELECT beneficiary_name, account_number, ifsc, amount_paise, mode, COALESCE(narration,'') AS narration
                      FROM payout_items WHERE batch_id=? AND institution_id=? ORDER BY beneficiary_name`).bind(batchID, inst(c)),
      c.db.prepare(`UPDATE payout_batches SET status='exported', exported_by=?2, exported_at=COALESCE(exported_at, ?3)
                     WHERE id=?1 AND status IN ('approved','exported')`).bind(batchID, c.id.userId, now()),
      c.db.prepare(`UPDATE payout_items SET status='exported'
                     WHERE batch_id=?1 AND status='pending'
                       AND EXISTS (SELECT 1 FROM payout_batches WHERE id=?1 AND status='exported')`).bind(batchID),
    ])
    // Somebody moved the batch out of approved between the read and the batch.
    if (!upd.meta.changes) throw conflict('not_approved', 'this batch has not been released by a checker, so there is no file to produce')
    const f = payoutFile(str(h.batch_no), (lines.results as Record<string, unknown>[]).map((l) => ({
      beneficiary_name: str(l.beneficiary_name), account_number: str(l.account_number), ifsc: str(l.ifsc),
      amount_paise: p(l.amount_paise), mode: str(l.mode), narration: str(l.narration),
    })))
    return new Response(f.body, {
      status: 200,
      headers: {
        'Content-Type': f.contentType,
        'Content-Disposition': `attachment; filename=${goQuote(f.filename)}`,
        'X-Payout-Transmission': "not-attempted: upload this file to your bank's portal",
      },
    })
  }))

  // --- student bank account register --------------------------------------
  r.get('/finance/banking/student-accounts', PAY_READ, fin(async (c) => {
    const q = c.url.searchParams
    const canReveal = can(c.id, EXPORT)
    const studentID = uuidQuery(q.get('student_id'))
    const search = optStr(q.get('q'))
    const activeRaw = (q.get('active') ?? '').trim().toLowerCase()
    const active = ['true', '1', 'yes'].includes(activeRaw) ? 1 : ['false', '0', 'no'].includes(activeRaw) ? 0 : null
    const limit = clampInt(q.get('limit'), 200, 1, 1000)
    const rows = await c.db.prepare(`
      SELECT b.id, b.student_id, TRIM(st.first_name || COALESCE(' ' || st.last_name, '')) AS student_name, st.admission_no,
             NULLIF(TRIM(COALESCE(c.name,'') || CASE WHEN c.name IS NOT NULL AND sec.name IS NOT NULL THEN '-' ELSE '' END || COALESCE(sec.name,'')),'') AS class_section,
             b.account_holder_name, b.relationship, g.full_name AS guardian_name, b.bank_name, b.branch, b.account_number,
             b.ifsc, b.account_type, b.is_aadhaar_seeded, b.dbt_consent_on, b.is_primary, b.is_active,
             b.verified_at, vu.full_name AS verified_by, b.notes
        FROM student_bank_accounts b
        JOIN students st ON st.id = b.student_id
        LEFT JOIN guardians g ON g.id = b.guardian_id
        LEFT JOIN users vu ON vu.id = b.verified_by
        LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
        LEFT JOIN classes c ON c.id = en.class_id
        LEFT JOIN sections sec ON sec.id = en.section_id
       WHERE (?1 IS NULL OR b.student_id = ?1)
         AND (?2 IS NULL OR st.admission_no LIKE ?2 ESCAPE '\\'
              OR TRIM(st.first_name || COALESCE(' ' || st.last_name, '')) LIKE ?2 ESCAPE '\\')
         AND (?3 IS NULL OR b.is_active = ?3)
       ORDER BY st.first_name, b.is_primary DESC
       LIMIT ?4`).bind(studentID, search === null ? null : like(search), active, limit).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omit({
      id: str(v.id), student_id: str(v.student_id), student_name: str(v.student_name), admission_no: str(v.admission_no),
      class_section: s(v.class_section), account_holder_name: str(v.account_holder_name), relationship: str(v.relationship),
      guardian_name: s(v.guardian_name), bank_name: str(v.bank_name), branch: s(v.branch),
      account_masked: maskAccountNumber(v.account_number), ifsc: str(v.ifsc), account_type: str(v.account_type),
      is_aadhaar_seeded: bool(v.is_aadhaar_seeded), dbt_consent_on: s(v.dbt_consent_on), is_primary: bool(v.is_primary),
      is_active: bool(v.is_active), verified_at: s(v.verified_at), verified_by: s(v.verified_by), notes: s(v.notes),
      can_reveal: canReveal,
    }))))
  }))

  r.post('/finance/banking/student-accounts', PAY_WRITE, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const holder = str(req.account_holder_name).trim()
    const bankName = str(req.bank_name).trim()
    const accountNumber = str(req.account_number).trim()
    const ifsc = str(req.ifsc).trim().toUpperCase()
    const relationship = str(req.relationship) || 'self'
    const accountType = str(req.account_type) || 'savings'
    const branch = str(req.branch)
    const guardianRaw = str(req.guardian_id).trim()
    const aadhaarSeeded = req.is_aadhaar_seeded === true
    const dbtConsentOn = str(req.dbt_consent_on)
    const makePrimary = req.make_primary === true
    const active = req.is_active === null || req.is_active === undefined ? true : req.is_active === true
    const notes = str(req.notes)

    const student = str(req.student_id).trim()
    if (!isUUID(student)) throw badRequest('which student is this account for?')
    if (holder === '') throw badRequest('whose name is on the account?')
    if (bankName === '') throw badRequest('which bank is the account with?')
    if (!ACCOUNT_SHAPE.test(accountNumber)) throw badRequest('an account number is 6 to 20 letters or digits, with no spaces')
    if (!validIFSC(ifsc)) throw badRequest('IFSC must be eleven characters: four letters, a zero, then six more, SBIN0001234')
    if ((relationship === 'self') !== (guardianRaw === '')) {
      throw badRequest('an account held by the child is relationship "self" and names no guardian; any other relationship must name the guardian who holds it')
    }
    if (!active && makePrimary) throw badRequest('an inactive account cannot be the primary one')
    const guardian = uuidQuery(guardianRaw || null)
    let acctID = ''
    const idRaw = str(req.id)
    if (idRaw !== '') { if (!isUUID(idRaw)) throw badRequest('malformed account id'); acctID = idRaw }
    const zero = '00000000-0000-0000-0000-000000000000'

    // student_bank_accounts_no_duplicate, tested here.
    const dup = await c.db.prepare(`SELECT id FROM student_bank_accounts WHERE institution_id = ? AND student_id = ? AND upper(trim(account_number)) = ?
        AND upper(trim(ifsc)) = ? AND COALESCE(guardian_id, ?) = ? AND id <> ?`)
      .bind(inst(c), student, accountNumber.toUpperCase(), ifsc, zero, guardian ?? zero, acctID).first()
    if (dup) throw badRequest('that account is already on file for this student')

    const t = now()
    const stmts: D1PreparedStatement[] = []
    // Demote the incumbent before promoting the new one, in the same batch.
    if (makePrimary) {
      stmts.push(c.db.prepare(`UPDATE student_bank_accounts SET is_primary = 0, updated_at = ?3 WHERE institution_id=?1 AND student_id=?2 AND is_primary AND id <> ?4`)
        .bind(inst(c), student, t, acctID))
    }
    if (acctID !== '') {
      stmts.push(c.db.prepare(`
        UPDATE student_bank_accounts
           SET guardian_id = ?3, account_holder_name = ?4, relationship = ?5, bank_name = ?6, branch = NULLIF(?7,''), account_number = ?8,
               ifsc = ?9, account_type = ?10, is_aadhaar_seeded = ?11, dbt_consent_on = NULLIF(?12,''), is_active = ?13,
               is_primary = CASE WHEN ?14 THEN 1 ELSE is_primary END, notes = NULLIF(?15,''), updated_at = ?16
         WHERE id = ?1 AND institution_id = ?2`)
        .bind(acctID, inst(c), guardian, holder, relationship, bankName, branch, accountNumber, ifsc, accountType, aadhaarSeeded ? 1 : 0,
          dbtConsentOn, active ? 1 : 0, makePrimary ? 1 : 0, notes, t))
      const results = await c.db.batch(stmts)
      if (!results[results.length - 1].meta.changes) throw notFound()
      return ok({ id: acctID })
    }
    acctID = uuid()
    stmts.push(c.db.prepare(`
      INSERT INTO student_bank_accounts (id, institution_id, student_id, guardian_id, account_holder_name, relationship, bank_name, branch,
          account_number, ifsc, account_type, is_aadhaar_seeded, dbt_consent_on, is_primary, is_active, notes, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,NULLIF(?,''),?,?,?,?,NULLIF(?,''),?,?,NULLIF(?,''),?,?,?)`)
      .bind(acctID, inst(c), student, guardian, holder, relationship, bankName, branch, accountNumber, ifsc, accountType, aadhaarSeeded ? 1 : 0,
        dbtConsentOn, makePrimary ? 1 : 0, active ? 1 : 0, notes, c.id.userId, t, t))
    await c.db.batch(stmts)
    return ok({ id: acctID })
  }))

  r.post('/finance/banking/student-accounts/{id}/primary', PAY_WRITE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed account id')
    const acctID = c.params.id
    const row = await c.db.prepare(`SELECT student_id, is_active FROM student_bank_accounts WHERE id=? AND institution_id=?`).bind(acctID, inst(c))
      .first<{ student_id: string; is_active: number }>()
    if (!row) throw notFound()
    if (!bool(row.is_active)) throw badRequest('an inactive account cannot be the primary one')
    const t = now()
    const results = await c.db.batch([
      c.db.prepare(`UPDATE student_bank_accounts SET is_primary = 0, updated_at = ?3 WHERE institution_id=?1 AND student_id=?2 AND is_primary AND id <> ?4`)
        .bind(inst(c), row.student_id, t, acctID),
      c.db.prepare(`UPDATE student_bank_accounts SET is_primary = 1, updated_at = ?3 WHERE id=?1 AND institution_id=?2`).bind(acctID, inst(c), t),
    ])
    if (!results[1].meta.changes) throw notFound()
    return ok({ ok: true })
  }))

  // Somebody checked the details against a passbook. Not a bank verification.
  r.post('/finance/banking/student-accounts/{id}/verify', PAY_WRITE, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed account id')
    const t = now()
    const res = await c.db.prepare(`UPDATE student_bank_accounts SET verified_by = ?3, verified_at = ?4, updated_at = ?4 WHERE id = ?1 AND institution_id = ?2`)
      .bind(c.params.id, inst(c), c.id.userId, t).run()
    if (!res.meta.changes) throw notFound()
    return ok({ ok: true })
  }))

  /* A GET on purpose, audited here with the last four digits only. Fails
     closed: the audit INSERT runs before the number is returned, and a failed
     write throws instead of answering. The column is plain text in the
     worker's schema, so no decryption is involved. */
  r.get('/finance/banking/student-accounts/{id}/reveal', EXPORT, fin(async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed account id')
    const acctID = c.params.id
    const row = await c.db.prepare(`
      SELECT b.id, b.student_id, TRIM(st.first_name || COALESCE(' ' || st.last_name, '')) AS student_name,
             b.account_holder_name, b.bank_name, b.account_number, b.ifsc
        FROM student_bank_accounts b JOIN students st ON st.id = b.student_id
       WHERE b.id = ? AND b.institution_id = ?`).bind(acctID, inst(c)).first<Record<string, unknown>>()
    if (!row) throw notFound()
    const accountNumber = str(row.account_number)
    const after = JSON.stringify({
      student_id: str(row.student_id), account_id: str(row.id), account_last4: lastFour(accountNumber), ifsc: str(row.ifsc),
      revealed_to: c.id.fullName, revealed_at: rfc3339IST(),
    })
    await c.db.prepare(`INSERT INTO audit_log (institution_id, actor_user_id, action, entity_type, entity_id, after, ip, created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
      .bind(inst(c), c.id.platformAdmin ? null : c.id.userId, 'REVEAL student_bank_account', 'banking.student-accounts', acctID, after, clientIP(c), now()).run()
    return ok({
      id: str(row.id), student_id: str(row.student_id), student_name: str(row.student_name), account_holder_name: str(row.account_holder_name),
      bank_name: str(row.bank_name), account_number: accountNumber, ifsc: str(row.ifsc), audited: true,
    })
  }))
}
