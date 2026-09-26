/* Pure file formats shared by the finance routes: what Go's encoding/csv,
   encoding/xml, strconv.Quote and time.Parse did for banking.go,
   concessions.go and internal/tally, reproduced byte for byte where the bytes
   leave the building. No database, no clock, no request in here. */

// ---------------------------------------------------------------- strings

/** unicode.IsSpace, which is not JS's \s (Go does not count U+FEFF, JS does). */
const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const reTrim = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, 'g')
const reSpaces = new RegExp(`[${GO_SPACE}]+`)
const reOneSpace = new RegExp(`^[${GO_SPACE}]`)
/** strings.TrimSpace */
export const goTrimSpace = (s: string): string => s.replace(reTrim, '')
/** strings.Fields */
export const goFields = (s: string): string[] => goTrimSpace(s).split(reSpaces).filter((x) => x !== '')
/** strings.Trim(s, cutset) for an ASCII cutset. */
export function goTrim(s: string, cutset: string): string {
  let a = 0; let b = s.length
  while (a < b && cutset.includes(s[a])) a++
  while (b > a && cutset.includes(s[b - 1])) b--
  return s.slice(a, b)
}

const enc = new TextEncoder()
/** len(s) in Go: UTF-8 bytes. */
export const byteLen = (s: string): number => enc.encode(s).length
/**
 * clipRaw: s[:n] on the UTF-8 bytes. Go could cut inside a character, which
 * Postgres then refused as invalid UTF-8; here a split character is dropped.
 */
export function clipRaw(s: string, n: number): string {
  const b = enc.encode(s)
  if (b.length <= n) return s
  let end = n
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--
  return new TextDecoder().decode(b.subarray(0, end))
}

/** The request body as Go's io.ReadAll + string(raw) saw it: a BOM is kept, not eaten. */
export const decodeBody = (buf: ArrayBuffer): string => new TextDecoder('utf-8', { ignoreBOM: true, fatal: false }).decode(buf)

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** strconv.Quote, as fmt's %q wrote filenames into Content-Disposition. */
export function goQuote(s: string): string {
  let out = '"'
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    switch (ch) {
      case '"': out += '\\"'; continue
      case '\\': out += '\\\\'; continue
      case '\x07': out += '\\a'; continue
      case '\b': out += '\\b'; continue
      case '\f': out += '\\f'; continue
      case '\n': out += '\\n'; continue
      case '\r': out += '\\r'; continue
      case '\t': out += '\\t'; continue
      case '\v': out += '\\v'; continue
    }
    if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).padStart(2, '0')
    else if (cp < 0x80 || !/[\p{C}\p{Z}]/u.test(ch) ) out += ch
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '\\ufffd'
    else if (cp < 0x10000) out += '\\u' + cp.toString(16).padStart(4, '0')
    else out += '\\U' + cp.toString(16).padStart(8, '0')
  }
  return out + '"'
}

// ---------------------------------------------------------------- money

/** rupeeString (banking.go) / tally.Amount: integer paise as 1234.05, no grouping. */
export const rupeeString = (paise: number): string =>
  (paise < 0 ? '-' : '') + Math.floor(Math.abs(paise) / 100) + '.' + String(Math.abs(paise) % 100).padStart(2, '0')

export const errAmountUnparseable = 'amount is not a decimal number'
export const errAmountTooPrecise = 'amount has more than two decimal places'
const allDigits = (s: string) => /^[0-9]+$/.test(s)

/** paiseFromDecimal (banking.go). Returns paise or throws an Error carrying Go's message. */
export function paiseFromDecimal(raw: string): number {
  let s = goTrimSpace(raw)
  if (s === '') throw new Error(errAmountUnparseable)
  let neg = false
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = goTrimSpace(s.slice(1, -1)) }
  const up = s.toUpperCase()
  if (up.endsWith('DR')) { neg = true; s = goTrimSpace(s.slice(0, -2)) }
  else if (up.endsWith('CR')) s = goTrimSpace(s.slice(0, -2))
  s = s.split(',').join('').split(' ').join('').split('\u00a0').join('').split('\u20b9').join('')
  for (const prefix of ['INR', 'inr', 'Rs.', 'RS.', 'rs.', 'Rs', 'RS', 'rs']) if (s.startsWith(prefix)) s = s.slice(prefix.length)
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1) } else if (s.startsWith('+')) s = s.slice(1)
  if (s === '') throw new Error(errAmountUnparseable)
  let whole = s; let frac = ''
  const i = s.indexOf('.')
  if (i >= 0) { whole = s.slice(0, i); frac = s.slice(i + 1) }
  if (whole === '' && frac === '') throw new Error(errAmountUnparseable)
  if (whole === '') whole = '0'
  if (!allDigits(whole) || (frac !== '' && !allDigits(frac))) throw new Error(errAmountUnparseable)
  if (frac.length === 0) frac = '00'
  else if (frac.length === 1) frac += '0'
  else if (frac.length > 2) {
    if (goTrim(frac.slice(2), '0') !== '') throw new Error(errAmountTooPrecise)
    frac = frac.slice(0, 2)
  }
  // Go's int64 guard is (1<<62)/100 rupees; JS integers are exact only to
  // 2^53, so the bound here is the one where paise stay exact.
  const rupees = Number(whole.replace(/^0+(?=\d)/, ''))
  if (whole.length > 19 || rupees > Math.floor(Number.MAX_SAFE_INTEGER / 100) - 1) throw new Error(errAmountUnparseable)
  let v = rupees * 100 + Number(frac)
  if (neg) v = -v
  return v === 0 ? 0 : v
}

// ---------------------------------------------------------------- dates

const SHORT_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const STATEMENT_DATE_LAYOUTS = [
  '2006-01-02', '02/01/2006', '02-01-2006', '02.01.2006',
  '02/01/06', '02-01-06', '02-Jan-2006', '02 Jan 2006', '02-Jan-06',
  '2006/01/02', '20060102',
]
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const isD = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'

/** time.Parse for the handful of layout elements these layouts use. YYYY-MM-DD or null. */
function goTimeParse(layout: string, value: string): string | null {
  let y = -1; let m = -1; let d = -1
  let l = 0; let v = 0
  while (l < layout.length) {
    if (layout.startsWith('2006', l)) {
      const p = value.slice(v, v + 4)
      if (p.length < 4 || !/^\d{4}$/.test(p)) return null
      y = Number(p); v += 4; l += 4
    } else if (layout.startsWith('Jan', l)) {
      const p = value.slice(v, v + 3).toLowerCase()
      const i = SHORT_MONTHS.indexOf(p); if (i < 0) return null
      m = i + 1; v += 3; l += 3
    } else if (layout.startsWith('01', l) || layout.startsWith('02', l)) {
      if (!isD(value[v]) || !isD(value[v + 1])) return null
      const n = Number(value.slice(v, v + 2))
      if (layout[l + 1] === '1') { if (n < 1 || n > 12) return null; m = n } else { if (n < 1 || n > 31) return null; d = n }
      v += 2; l += 2
    } else if (layout.startsWith('06', l)) {
      if (!isD(value[v]) || !isD(value[v + 1])) return null
      const n = Number(value.slice(v, v + 2))
      y = n >= 69 ? n + 1900 : n + 2000; v += 2; l += 2
    } else {
      if (value[v] !== layout[l]) return null
      v++; l++
    }
  }
  if (v !== value.length) return null
  if (d > daysIn(y, m)) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** parseStatementDate (banking.go): YYYY-MM-DD or null. */
export function parseStatementDate(raw: string): string | null {
  const s = goTrimSpace(raw)
  if (s === '') return null
  const i = s.search(/[ T]/)
  if (i > 0 && byteLen(s) > 10) {
    const t = parseStatementDate(s.slice(0, i))
    if (t) return t
  }
  for (const layout of STATEMENT_DATE_LAYOUTS) { const t = goTimeParse(layout, s); if (t) return t }
  return null
}

// ---------------------------------------------------------------- CSV

/**
 * csv.NewReader(strings.NewReader(line)).Read() with the defaults (comma,
 * no lazy quotes, no leading-space trim) on one physical line without its
 * newline. Returns the record or null where Go returned an error.
 */
export function goCsvReadLine(line: string): string[] | null {
  // Go's readLine drops a lone trailing \r before EOF.
  if (line.endsWith('\r')) line = line.slice(0, -1)
  if (line === '') return null // io.EOF
  const rec: string[] = []
  let pos = 0
  for (;;) {
    if (pos >= line.length || line[pos] !== '"') {
      const i = line.indexOf(',', pos)
      const field = i >= 0 ? line.slice(pos, i) : line.slice(pos)
      if (field.includes('"')) return null // ErrBareQuote
      rec.push(field)
      if (i >= 0) { pos = i + 1; continue }
      return rec
    }
    // Quoted field.
    pos++
    let field = ''
    for (;;) {
      const i = line.indexOf('"', pos)
      if (i < 0) return null // no closing quote before the end: ErrQuote
      field += line.slice(pos, i)
      pos = i + 1
      if (line[pos] === '"') { field += '"'; pos++; continue }
      if (line[pos] === ',') { pos++; rec.push(field); break }
      if (pos >= line.length) { rec.push(field); return rec }
      return null // extraneous character after a closing quote: ErrQuote
    }
  }
}

/** csv.Writer.Write + Flush with the defaults: comma, "\n", Go's quoting rule. */
export function goCsvWrite(rows: string[][]): string {
  const needs = (f: string) => {
    if (f === '') return false
    if (f === '\\.') return true
    if (/[\n\r",]/.test(f)) return true
    return reOneSpace.test(f)
  }
  return rows.map((r) => r.map((f) => (needs(f) ? '"' + f.replace(/"/g, '""') + '"' : f)).join(',') + '\n').join('')
}

// ---------------------------------------------------------------- bank statement

const HEADER_ALIASES: [string, string[]][] = [
  ['date', ['date', 'txn date', 'transaction date', 'tran date', 'txndate', 'posting date', 'date of transaction']],
  ['valuedate', ['value date', 'value dt', 'valuedate']],
  ['narration', ['narration', 'description', 'particulars', 'details', 'remarks', 'transaction remarks']],
  ['reference', ['ref', 'reference', 'reference no', 'ref no', 'chq no', 'cheque no', 'chq/ref no', 'cheque/reference no', 'utr', 'transaction id', 'txn id']],
  ['debit', ['debit', 'withdrawal', 'withdrawal amt', 'withdrawal amount', 'withdrawal amt.', 'dr', 'debit amount', 'paid out']],
  ['credit', ['credit', 'deposit', 'deposit amt', 'deposit amount', 'deposit amt.', 'cr', 'credit amount', 'paid in']],
  ['amount', ['amount', 'txn amount', 'transaction amount']],
  ['balance', ['balance', 'closing balance', 'running balance', 'balance amt']],
]

export type Cols = Map<string, number>

/** mapStatementHeader: the column map, or null when this row is not the header. */
export function mapStatementHeader(rec: string[]): Cols | null {
  const cols: Cols = new Map()
  rec.forEach((cell, i) => {
    let norm = goTrimSpace(cell).toLowerCase()
    norm = goTrim(norm, '.:')
    norm = goFields(norm).join(' ')
    if (norm === '') return
    for (const [field, aliases] of HEADER_ALIASES) if (aliases.includes(norm) && !cols.has(field)) cols.set(field, i)
  })
  return cols.has('date') && (cols.has('amount') || cols.has('debit') || cols.has('credit')) ? cols : null
}

const cellAt = (rec: string[], cols: Cols, field: string): string => {
  const i = cols.get(field)
  return i === undefined || i >= rec.length ? '' : goTrimSpace(rec[i])
}

export interface ImportedLine {
  txnDate: string; valueDate: string | null; narration: string; reference: string
  amount: number; balance: number | null; raw: string; lineNo: number; hash: string
}

/** parseStatementRow. Throws Error(reason) where Go returned an error. */
export function parseStatementRow(rec: string[], cols: Cols, lineNo: number, raw: string): ImportedLine {
  const at = (f: string) => cellAt(rec, cols, f)
  const txn = parseStatementDate(at('date'))
  if (!txn) throw new Error(`date ${goQuote(at('date'))} is not a date this reader recognises`)
  const pl: ImportedLine = {
    txnDate: txn, valueDate: parseStatementDate(at('valuedate')), narration: at('narration'), reference: at('reference'),
    amount: 0, balance: null, raw: clipRaw(raw, 4000), lineNo, hash: '',
  }
  const wrap = (label: string, cell: string) => (fn: () => number) => {
    try { return fn() } catch (e) { throw new Error(`${label} ${goQuote(cell)}: ${(e as Error).message}`) }
  }
  const debitRaw = at('debit'); const creditRaw = at('credit')
  if (debitRaw !== '' && creditRaw !== '') throw new Error('row has both a debit and a credit amount')
  else if (debitRaw !== '') pl.amount = -Math.abs(wrap('debit', debitRaw)(() => paiseFromDecimal(debitRaw)))
  else if (creditRaw !== '') pl.amount = Math.abs(wrap('credit', creditRaw)(() => paiseFromDecimal(creditRaw)))
  else {
    const amountRaw = at('amount')
    if (amountRaw === '') throw new Error('row has no amount')
    pl.amount = wrap('amount', amountRaw)(() => paiseFromDecimal(amountRaw))
  }
  if (pl.amount === 0) throw new Error('amount parsed as zero')
  const b = at('balance')
  if (b !== '') { try { pl.balance = paiseFromDecimal(b) } catch { /* ignored, as Go did */ } }
  return pl
}

/** statementLineHash */
export const statementLineHash = (txnDate: string, amount: number, narration: string, reference: string, ordinal: number): Promise<string> =>
  sha256Hex(`${txnDate}|${amount}|${goFields(narration).join(' ').toLowerCase()}|${goTrimSpace(reference).toUpperCase()}|${ordinal}`)

export interface Reject { line: number; reason: string; raw: string }

/** The line loop of importBankStatement: header, rows read, parsed lines with hashes, rejects. */
export async function parseStatement(text: string): Promise<{ cols: Cols | null; rowsRead: number; parsed: ImportedLine[]; rejects: Reject[] }> {
  const physical = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let cols: Cols | null = null
  const rejects: Reject[] = []; const parsed: ImportedLine[] = []
  const seen = new Map<string, number>()
  let rowsRead = 0
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i]
    if (goTrimSpace(line) === '') continue
    const rec = goCsvReadLine(line)
    if (!rec) { rejects.push({ line: i + 1, reason: 'could not be read as a CSV row', raw: clipRaw(line, 500) }); continue }
    if (!cols) { cols = mapStatementHeader(rec); continue }
    rowsRead++
    let pl: ImportedLine
    try { pl = parseStatementRow(rec, cols, i + 1, line) } catch (e) {
      rejects.push({ line: i + 1, reason: (e as Error).message, raw: clipRaw(line, 500) }); continue
    }
    const key = await statementLineHash(pl.txnDate, pl.amount, pl.narration, pl.reference, 0)
    const ordinal = seen.get(key) ?? 0
    seen.set(key, ordinal + 1)
    pl.hash = await statementLineHash(pl.txnDate, pl.amount, pl.narration, pl.reference, ordinal)
    parsed.push(pl)
  }
  return { cols, rowsRead, parsed, rejects }
}

// ---------------------------------------------------------------- payout file

export interface PayoutLine { beneficiary_name: string; account_number: string; ifsc: string; amount_paise: number; mode: string; narration: string }

/** csvSafe (payroll_statutory.go) */
export const csvSafe = (s: string): string => s.replace(/[,\n\r]/g, ' ')

/** fileExportProvider.Prepare */
export function payoutFile(batchNo: string, lines: PayoutLine[]): { filename: string; contentType: string; body: string } {
  let b = 'Beneficiary Name,Account Number,IFSC,Amount,Mode,Narration\n'
  for (const l of lines) {
    b += `${csvSafe(l.beneficiary_name)},${csvSafe(l.account_number)},${csvSafe(l.ifsc.toUpperCase())},${rupeeString(l.amount_paise)},${csvSafe(l.mode.toUpperCase())},${csvSafe(l.narration)}\n`
  }
  return { filename: `payout-${batchNo.replace(/[/ ]/g, '-')}.csv`, contentType: 'text/csv; charset=utf-8', body: b }
}

// ---------------------------------------------------------------- claim file

export interface ClaimFileRow { admission: string; name: string; class: string; category: string; dob: string; months: number; rate: number; claimed: number }

/** The body and filename exportClaimFile wrote. */
export function claimFile(claimNo: string, periodStart: string, rows: ClaimFileRow[]): { filename: string; body: string } {
  const out: string[][] = [['S.No', 'Admission No', 'Student Name', 'Class', 'Category', 'Date of Birth', 'Months Claimed', 'Annual Rate (INR)', 'Amount Claimed (INR)']]
  let total = 0
  rows.forEach((v, i) => {
    total += v.claimed
    out.push([String(i + 1), v.admission, v.name, v.class, v.category.toUpperCase(), v.dob, String(v.months), rupeeString(v.rate), rupeeString(v.claimed)])
  })
  out.push(['', '', '', '', '', '', '', 'Total', rupeeString(total)])
  return { filename: `claim-${claimNo.replace(/[/ \\"]/g, '-')}-${periodStart}.csv`, body: goCsvWrite(out) }
}

// ---------------------------------------------------------------- NSP disbursements

const DISBURSEMENT_ALIASES: [string, string[]][] = [
  ['application_ref', ['application id', 'application no', 'application number', 'applicationid', 'app id', 'nsp application id', 'reference id', 'application ref']],
  ['student_name', ['student name', 'name of student', 'beneficiary name', 'name', 'applicant name', 'student']],
  ['admission_no', ['admission no', 'admission number', 'adm no', 'enrolment no', 'enrollment no', 'roll no', 'student id']],
  ['amount', ['amount', 'amount disbursed', 'disbursed amount', 'scholarship amount', 'credit amount', 'amount (inr)', 'amount in rs', 'sanctioned amount']],
  ['credited_on', ['disbursement date', 'credit date', 'date of credit', 'transaction date', 'payment date', 'date']],
  ['bank_reference', ['utr', 'utr no', 'utr number', 'bank reference', 'reference no', 'transaction id', 'txn id', 'drt no']],
  ['account_no', ['account no', 'account number', 'bank account', 'beneficiary account', 'a/c no', 'account']],
  ['portal_status', ['status', 'payment status', 'disbursement status', 'remarks']],
]

/** mapDisbursementHeader */
export function mapDisbursementHeader(rec: string[]): Cols | null {
  const cols: Cols = new Map()
  rec.forEach((cell, i) => {
    const key = goTrim(goTrimSpace(cell).toLowerCase(), '*:# ')
    for (const [field, aliases] of DISBURSEMENT_ALIASES) if (!cols.has(field) && aliases.includes(key)) cols.set(field, i)
  })
  return cols.has('amount') && (cols.has('application_ref') || cols.has('admission_no')) ? cols : null
}

export interface DisbursementLine {
  lineNo: number; appRef: string; name: string; admission: string; bankRef: string; last4: string; stat: string
  amount: number; credited: string | null; rawLine: string
}

/** The line loop of importScholarshipDisbursements. */
export function parseDisbursements(text: string): { cols: Cols | null; parsed: DisbursementLine[]; rejects: Reject[] } {
  const physical = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let cols: Cols | null = null
  const rejects: Reject[] = []; const parsed: DisbursementLine[] = []
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i]
    if (goTrimSpace(line) === '') continue
    const rec = goCsvReadLine(line)
    if (!rec) { rejects.push({ line: i + 1, reason: 'could not be read as a CSV row', raw: clipRaw(line, 300) }); continue }
    if (!cols) { cols = mapDisbursementHeader(rec); continue }
    const at = (f: string) => cellAt(rec, cols!, f)
    const p: DisbursementLine = {
      lineNo: i + 1, rawLine: clipRaw(line, 800), appRef: at('application_ref'), name: at('student_name'),
      admission: at('admission_no'), bankRef: at('bank_reference'), stat: at('portal_status'), last4: '', amount: 0, credited: null,
    }
    const amountRaw = at('amount')
    if (amountRaw === '') continue
    let amt: number
    try { amt = paiseFromDecimal(amountRaw) } catch {
      rejects.push({ line: i + 1, reason: 'amount could not be read: ' + amountRaw, raw: p.rawLine }); continue
    }
    if (amt < 0) { rejects.push({ line: i + 1, reason: 'a disbursement cannot be negative', raw: p.rawLine }); continue }
    p.amount = amt
    const d = at('credited_on')
    if (d !== '') p.credited = parseStatementDate(d)
    const acct = at('account_no')
    if (acct !== '') {
      const trimmed = acct.replace(/^[^0-9a-zA-Z]+|[^0-9a-zA-Z]+$/gu, '')
      if (byteLen(trimmed) >= 4) p.last4 = trimmed.length <= 4 ? trimmed : trimmed.slice(-4)
    }
    if (p.appRef === '' && p.admission === '') {
      rejects.push({ line: i + 1, reason: 'the row names neither an application reference nor an admission number', raw: p.rawLine }); continue
    }
    parsed.push(p)
  }
  return { cols, parsed, rejects }
}

// ---------------------------------------------------------------- Tally XML

export interface TallyEntry { ledger_name: string; amount_paise: number }
export interface TallyVoucher { date: string; voucher_type: string; number: string; narration: string; entries: TallyEntry[] }

/** tally.Voucher.Validate: Render's refusal, or null. */
export function validateTallyVoucher(v: TallyVoucher): string | null {
  if (goTrimSpace(v.voucher_type) === '') return `voucher ${v.number} has no Tally voucher type: map it on the connector`
  if (v.entries.length < 2) return `voucher ${v.number} has ${v.entries.length} entry/entries: double entry needs at least two`
  for (const e of v.entries) {
    if (goTrimSpace(e.ledger_name) === '') return `voucher ${v.number} has a line with no Tally ledger name`
    if (e.amount_paise === 0) return `voucher ${v.number} has a zero line against ${e.ledger_name}`
  }
  const b = v.entries.reduce((s, e) => s + e.amount_paise, 0)
  if (b !== 0) return `voucher does not balance: ${v.number} is out by ${rupeeString(b)} rupees`
  return null
}

/** encoding/xml's escaping of text and attribute values. */
export function xmlEscape(s: string): string {
  let out = ''
  for (const ch of s) {
    const r = ch.codePointAt(0)!
    switch (ch) {
      case '"': out += '&#34;'; continue
      case "'": out += '&#39;'; continue
      case '&': out += '&amp;'; continue
      case '<': out += '&lt;'; continue
      case '>': out += '&gt;'; continue
      case '\t': out += '&#x9;'; continue
      case '\n': out += '&#xA;'; continue
      case '\r': out += '&#xD;'; continue
    }
    const ok = (r >= 0x20 && r <= 0xd7ff) || (r >= 0xe000 && r <= 0xfffd) || (r >= 0x10000 && r <= 0x10ffff)
    out += ok ? ch : '\ufffd'
  }
  return out
}

/** tally.Render: the file, or throws Error(refusal). */
export function renderTally(company: string, vouchers: TallyVoucher[]): string {
  if (goTrimSpace(company) === '') throw new Error('no Tally company name configured: set it on the connector before exporting')
  if (vouchers.length === 0) throw new Error('nothing to export in this period')
  const x = xmlEscape
  const el = (ind: number, tag: string, text: string) => `\n${' '.repeat(ind)}<${tag}>${x(text)}</${tag}>`
  let msgs = ''
  for (const v of vouchers) {
    const err = validateTallyVoucher(v)
    if (err) throw new Error(err)
    const td = v.date.slice(0, 10).replace(/-/g, '')
    let s = `\n    <TALLYMESSAGE xmlns:UDF="TallyUDF">`
    s += `\n     <VOUCHER VCHTYPE="${x(v.voucher_type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`
    s += el(6, 'DATE', td) + el(6, 'EFFECTIVEDATE', td) + el(6, 'VOUCHERTYPENAME', v.voucher_type) + el(6, 'VOUCHERNUMBER', v.number)
    if (v.narration !== '') s += el(6, 'NARRATION', v.narration)
    for (const e of v.entries) {
      s += `\n      <ALLLEDGERENTRIES.LIST>`
      s += el(7, 'LEDGERNAME', e.ledger_name) + el(7, 'ISDEEMEDPOSITIVE', e.amount_paise < 0 ? 'Yes' : 'No') + el(7, 'LEDGERFROMITEM', 'No')
        + el(7, 'REMOVEZEROENTRIES', 'No') + el(7, 'ISPARTYLEDGER', 'No') + el(7, 'AMOUNT', rupeeString(e.amount_paise))
      s += `\n      </ALLLEDGERENTRIES.LIST>`
    }
    s += `\n     </VOUCHER>\n    </TALLYMESSAGE>`
    msgs += s
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>\n <HEADER>' + el(2, 'TALLYREQUEST', 'Import Data') + '\n </HEADER>\n <BODY>\n  <IMPORTDATA>\n   <REQUESTDESC>'
    + el(4, 'REPORTNAME', 'Vouchers') + '\n    <STATICVARIABLES>' + el(5, 'SVCURRENTCOMPANY', company) + '\n    </STATICVARIABLES>\n   </REQUESTDESC>\n   <REQUESTDATA>'
    + msgs + '\n   </REQUESTDATA>\n  </IMPORTDATA>\n </BODY>\n</ENVELOPE>'
}

/**
 * Splits rows into JSON arrays that each stay well under D1's 100 KB
 * statement limit, for `INSERT ... SELECT ... FROM json_each(?)`.
 */
export function jsonChunks<T>(rows: T[], maxBytes = 80_000): string[] {
  const out: string[] = []
  let cur: string[] = []; let size = 2
  for (const r of rows) {
    const s = JSON.stringify(r); const n = byteLen(s) + 1
    if (cur.length > 0 && size + n > maxBytes) { out.push('[' + cur.join(',') + ']'); cur = []; size = 2 }
    cur.push(s); size += n
  }
  if (cur.length > 0) out.push('[' + cur.join(',') + ']')
  return out
}
