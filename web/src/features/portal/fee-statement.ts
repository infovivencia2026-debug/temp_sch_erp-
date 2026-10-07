import { printHtml } from '@/features/finance/receipt-print'
/* THE FEE STATEMENT, AS A DOCUMENT RATHER THAN A SCREENSHOT.
 *
 * Printing this page used to hand the browser the portal's own markup with the
 * furniture hidden. What came out was the school's letterhead, the words
 * "11,833.38 due", and then two sheets of nothing: the cards carrying the
 * invoices and the receipts are laid out with grid and flex, and the print
 * stylesheet flattened them into a column of empty boxes. A parent took that
 * to the office as evidence of what they owed.
 *
 * So the statement is built rather than captured. The same data the screen
 * draws is written into a plain document of its own -- one table, one total,
 * one page -- which is what the office wants stamped and filed, and which
 * cannot be broken by a later change to the portal's layout.
 *
 * WHY A NEW WINDOW AND NOT A HIDDEN DIV. A hidden div inherits the app's
 * stylesheet, which is 2,700 lines with its own opinions about what @media
 * print means -- that is precisely what produced the blank sheets. This window
 * starts empty and is given exactly the rules below, and nothing else.
 */

interface Line { head: string; amount_paise: number; is_fine?: boolean }

interface Invoice {
  invoice_no: string
  instalment_no?: number
  lines?: Line[]
  issued_on: string
  due_on?: string
  net_paise: number
  paid_paise: number
  due_paise: number
  fine_paise: number
  status: string
  days_overdue: number
}

interface Receipt {
  receipt_no: string
  paid_on: string
  amount_paise: number
  mode: string
  reference_no?: string
  status: string
}

export interface StatementInput {
  school: {
    name: string
    affiliation?: string
    address?: string
    phone?: string
    email?: string
    logoKey?: string
  }
  student: { name: string; admissionNo?: string; className?: string; guardian?: string }
  academicYear?: string
  outstandingPaise: number
  invoices: Invoice[]
  receipts: Receipt[]
  upi?: { vpa: string; note: string; qrDataUrl?: string }
  printedBy?: string
}

const ENTITY: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ENTITY[ch])

const RUPEE = '₹'
const DASH = '—'
const DOT = '·'

const money = (paise: number) =>
  RUPEE + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const day = (iso?: string) =>
  iso
    ? new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      })
    : DASH

/* AMOUNT IN WORDS, THE INDIAN WAY.
 *
 * Not lakh and crore as decoration: a cheque and a demand note are read in
 * those units here, and a figure written "eleven thousand eight hundred"
 * beside a total of 11,833.38 is the kind of mismatch that stops a payment at
 * a bank counter. The paise are spelled out too, because they are in the
 * total. */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function under100(n: number): string {
  if (n < 20) return ONES[n]
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')
}

function under1000(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  return (h ? ONES[h] + ' Hundred' + (r ? ' and ' : '') : '') + (r ? under100(r) : '')
}

export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100)
  const p = Math.abs(paise) % 100
  const parts: string[] = []
  const crore = Math.floor(rupees / 10000000)
  const lakh = Math.floor((rupees % 10000000) / 100000)
  const thousand = Math.floor((rupees % 100000) / 1000)
  const rest = rupees % 1000
  if (crore) parts.push(under1000(crore) + ' Crore')
  if (lakh) parts.push(under1000(lakh) + ' Lakh')
  if (thousand) parts.push(under1000(thousand) + ' Thousand')
  if (rest) parts.push(under1000(rest))
  let out = (parts.length ? parts.join(' ') : 'Zero') + ' Rupees'
  if (p) out += ' and ' + under100(p) + ' Paise'
  return out + ' Only'
}

/* Sized so a statement of a dozen fee heads and half a dozen receipts lands on
   one sheet. Everything that could be split across a page break is told not to
   be: a signature block orphaned onto page two is how a school ends up with an
   unsigned document in its file. */
const CSS = [
  '@page { size: A4 portrait; margin: 12mm 12mm 10mm; }',
  '* { box-sizing: border-box; }',
  'html, body { margin: 0; padding: 0; }',
  'body { font: 10pt/1.45 Inter, system-ui, -apple-system, Arial, sans-serif; color: #1a1d21;',
  '  -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
  '.sheet { width: 186mm; margin: 0 auto; }',
  'header { display: flex; align-items: flex-start; gap: 12px; border-bottom: 2.5px solid #9b1c1c; padding-bottom: 8px; }',
  'header img { width: 52px; height: 52px; object-fit: contain; flex: none; }',
  '.sch { flex: 1; min-width: 0; }',
  '.sch h1 { margin: 0; font-size: 16pt; letter-spacing: .3px; font-weight: 700; }',
  '.sch .sub { font-size: 8pt; color: #555c66; margin-top: 2px; line-height: 1.35; }',
  '.badge { flex: none; text-align: right; font-size: 8pt; font-weight: 700; letter-spacing: .6px;',
  '  text-transform: uppercase; color: #9b1c1c; border: 1.5px solid #9b1c1c; border-radius: 3px;',
  '  padding: 5px 8px; max-width: 46mm; line-height: 1.3; }',
  '.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; margin: 9px 0 10px; }',
  '.meta dl { margin: 0; display: grid; grid-template-columns: 34mm 1fr; row-gap: 2px; }',
  '.meta dt { font-size: 8pt; color: #666d78; }',
  '.meta dd { margin: 0; font-size: 9pt; font-weight: 600; }',
  'table { width: 100%; border-collapse: collapse; }',
  'thead th { background: #f1f3f5; border-top: 1px solid #c8ccd2; border-bottom: 1px solid #c8ccd2;',
  '  font-size: 8pt; text-transform: uppercase; letter-spacing: .4px; color: #444b55; padding: 5px 6px; text-align: left; }',
  'tbody td { border-bottom: 1px solid #e6e8eb; padding: 5px 6px; font-size: 9pt; vertical-align: top; }',
  '.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }',
  'tbody tr, thead, tfoot { break-inside: avoid; page-break-inside: avoid; }',
  '.grp td { background: #fafbfc; font-weight: 600; font-size: 8.5pt; }',
  '.late { color: #9b1c1c; }',
  'tfoot td { padding: 5px 6px; font-size: 9pt; }',
  'tfoot .sum td { border-top: 1px solid #c8ccd2; }',
  'tfoot .total td { border-top: 2px solid #1a1d21; border-bottom: 2px solid #1a1d21; font-size: 11pt; font-weight: 700; }',
  '.words { margin-top: 7px; border: 1px solid #e6e8eb; background: #fafbfc; padding: 6px 8px; font-size: 9pt; }',
  '.words b { text-transform: uppercase; font-size: 7.5pt; letter-spacing: .5px; color: #666d78; display: block; }',
  'h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: .5px; color: #444b55;',
  '  margin: 11px 0 4px; padding-bottom: 2px; border-bottom: 1px solid #e6e8eb; }',
  '.pay { display: flex; gap: 12px; margin-top: 11px; break-inside: avoid; page-break-inside: avoid; }',
  '.pay .qr { flex: none; width: 30mm; text-align: center; }',
  '.pay .qr img { width: 30mm; height: 30mm; border: 1px solid #e6e8eb; }',
  '.pay .qr span { display: block; font-size: 7pt; color: #666d78; margin-top: 2px; word-break: break-all; }',
  '.terms { flex: 1; font-size: 8pt; color: #444b55; }',
  '.terms p { margin: 0; }',
  '.terms ul { margin: 3px 0 0; padding-left: 14px; }',
  '.terms li { margin-bottom: 1.5px; }',
  '.sign { display: flex; justify-content: space-between; align-items: flex-end;',
  '  margin-top: 14px; break-inside: avoid; page-break-inside: avoid; }',
  '.sign .line { border-top: 1px solid #1a1d21; width: 52mm; padding-top: 3px; text-align: center;',
  '  font-size: 8pt; color: #666d78; }',
  'footer { margin-top: 10px; border-top: 1px solid #e6e8eb; padding-top: 5px; font-size: 7.5pt;',
  '  color: #767d88; display: flex; justify-content: space-between; gap: 10px; }',
  '.none { padding: 8px 6px; font-size: 9pt; color: #666d78; font-style: italic; }',
  '@media screen { body { background: #e9ecef; padding: 16px; }',
  '  .sheet { background: #fff; padding: 14mm; box-shadow: 0 2px 12px rgba(0,0,0,.18); } }',
].join('\n')

export function printFeeStatement(v: StatementInput) {

  const paidTotal = v.receipts
    .filter((r) => r.status !== 'bounced')
    .reduce((n, r) => n + r.amount_paise, 0)
  const billed = v.invoices.reduce((n, i) => n + i.net_paise, 0)
  const fines = v.invoices.reduce((n, i) => n + i.fine_paise, 0)
  const settled = v.invoices.reduce((n, i) => n + i.paid_paise, 0)

  /* One row per fee head, grouped under the instalment it belongs to, because
     that is how a school quotes it back over the counter -- "the second
     instalment is unpaid", never "line fourteen". An invoice whose lines the
     server did not send still gets a row of its own: the total is the part
     that must never go missing. */
  let n = 0
  const rows = v.invoices
    .map((inv) => {
      const name = inv.instalment_no ? 'Instalment ' + inv.instalment_no : inv.invoice_no
      const late = inv.days_overdue > 0 && inv.due_paise > 0
        ? ' ' + DOT + ' <span class="late">' + inv.days_overdue + ' days overdue</span>'
        : ''
      const head = '<tr class="grp"><td colspan="5">' + esc(name)
        + ' ' + DOT + ' issued ' + day(inv.issued_on)
        + (inv.due_on ? ' ' + DOT + ' due ' + day(inv.due_on) : '')
        + late + '</td></tr>'

      const lines = inv.lines ?? []
      if (!lines.length) {
        n++
        return head + '<tr><td class="num">' + n + '</td><td>' + esc(name) + '</td>'
          + '<td class="num">' + money(inv.net_paise) + '</td>'
          + '<td class="num">' + money(inv.paid_paise) + '</td>'
          + '<td class="num">' + money(inv.due_paise) + '</td></tr>'
      }
      const body = lines.map((l) => {
        n++
        return '<tr><td class="num">' + n + '</td><td>' + esc(l.head)
          + (l.is_fine ? ' <span class="late">(late fee)</span>' : '') + '</td>'
          + '<td class="num">' + money(l.amount_paise) + '</td>'
          + '<td class="num">' + DASH + '</td><td class="num">' + DASH + '</td></tr>'
      }).join('')
      const sub = '<tr><td></td><td style="font-weight:600">Instalment total</td>'
        + '<td class="num" style="font-weight:600">' + money(inv.net_paise) + '</td>'
        + '<td class="num">' + money(inv.paid_paise) + '</td>'
        + '<td class="num" style="font-weight:600">' + money(inv.due_paise) + '</td></tr>'
      return head + body + sub
    })
    .join('')

  const receipts = v.receipts.length
    ? v.receipts.map((r) =>
        '<tr><td>' + esc(r.receipt_no) + '</td><td>' + day(r.paid_on) + '</td>'
        + '<td>' + esc(r.mode) + '</td><td>' + esc(r.reference_no ?? DASH) + '</td>'
        + '<td class="num">' + money(r.amount_paise)
        + (r.status === 'bounced' ? ' <span class="late">(bounced)</span>' : '')
        + '</td></tr>').join('')
    : '<tr><td colspan="5" class="none">No payments recorded against this account yet.</td></tr>'

  const logo = v.school.logoKey
    ? '<img src="' + esc(location.origin) + '/api/v1/files/' + esc(v.school.logoKey) + '?inline=1" alt="">'
    : ''

  const contact = [v.school.phone, v.school.email].filter(Boolean).map(esc).join(' ' + DOT + ' ')

  const howToPay = v.upi && v.upi.vpa
    ? '<p>Scan the code with any UPI app, or pay to <b>' + esc(v.upi.vpa) + '</b>. Quote <b>'
      + esc(v.upi.note) + '</b> in the note so the office can match the transfer to this account.</p>'
    : '<p>Cash, cheque, demand draft or bank transfer at the school office during working hours.</p>'

  const qr = v.upi && v.upi.qrDataUrl
    ? '<div class="qr"><img src="' + esc(v.upi.qrDataUrl) + '" alt="UPI QR code">'
      + '<span>' + esc(v.upi.vpa) + '</span></div>'
    : ''

  const doc = '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>Fee statement ' + DASH + ' ' + esc(v.student.name) + '</title>'
    /* The statement opens in its own tab; the tab had no way back to the app. */
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap">'
    + '<style>' + CSS + '.erp-back{display:none}.x{position:fixed;top:12px;left:12px;z-index:9;padding:8px 14px;border:1px solid #ccc;border-radius:999px;background:#fff;font:600 14px system-ui;cursor:pointer}@media print{.erp-back{display:none}}</style></head><body><button class="erp-back" onclick="window.close();setTimeout(function(){history.length>1?history.back():location.href=\x27/\x27},200)">← Back</button><div class="sheet">'
    + '<header>' + logo + '<div class="sch"><h1>' + esc(v.school.name) + '</h1><div class="sub">'
    + (v.school.affiliation ? esc(v.school.affiliation) + '<br>' : '')
    + (v.school.address ? esc(v.school.address) + '<br>' : '')
    + contact
    + '</div></div><div class="badge">Fee statement<br>&amp; demand note</div></header>'

    + '<div class="meta"><dl>'
    + '<dt>Student</dt><dd>' + esc(v.student.name) + '</dd>'
    + '<dt>Admission no</dt><dd>' + esc(v.student.admissionNo || DASH) + '</dd>'
    + '<dt>Class &amp; section</dt><dd>' + esc(v.student.className || DASH) + '</dd>'
    + '<dt>Parent / guardian</dt><dd>' + esc(v.student.guardian || DASH) + '</dd>'
    + '</dl><dl>'
    + '<dt>Statement no</dt><dd>' + esc(v.invoices[0]?.invoice_no || DASH) + '</dd>'
    + '<dt>Academic year</dt><dd>' + esc(v.academicYear || DASH) + '</dd>'
    + '<dt>Issued on</dt><dd>' + day(new Date().toISOString().slice(0, 10)) + '</dd>'
    + '<dt>Payable by</dt><dd>' + day(v.invoices.find((i) => i.due_paise > 0)?.due_on) + '</dd>'
    + '</dl></div>'

    + '<table><thead><tr>'
    + '<th class="num" style="width:9mm">S.No</th><th>Particulars</th>'
    + '<th class="num" style="width:26mm">Amount due</th>'
    + '<th class="num" style="width:26mm">Paid</th>'
    + '<th class="num" style="width:26mm">Balance</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="5" class="none">Nothing has been billed to this account yet.</td></tr>')
    + '</tbody><tfoot>'
    + '<tr class="sum"><td></td><td>Subtotal billed</td><td class="num">' + money(billed - fines)
    + '</td><td class="num">' + money(settled) + '</td><td class="num"></td></tr>'
    + (fines
        ? '<tr><td></td><td>Fine / late fee</td><td class="num">' + money(fines)
          + '</td><td class="num"></td><td class="num"></td></tr>'
        : '')
    + '<tr class="total"><td></td><td>Total amount payable</td><td class="num"></td>'
    + '<td class="num"></td><td class="num">' + money(v.outstandingPaise) + '</td></tr>'
    + '</tfoot></table>'

    + '<div class="words"><b>Amount in words</b>' + esc(rupeesInWords(v.outstandingPaise)) + '</div>'

    + '<h2>Payments received</h2><table><thead><tr>'
    + '<th style="width:32mm">Receipt no</th><th style="width:26mm">Date</th>'
    + '<th style="width:26mm">Mode</th><th>Reference</th>'
    + '<th class="num" style="width:26mm">Amount</th></tr></thead><tbody>'
    + receipts + '</tbody><tfoot><tr class="sum">'
    + '<td colspan="4" style="font-weight:600">Total received</td>'
    + '<td class="num" style="font-weight:600">' + money(paidTotal) + '</td></tr></tfoot></table>'

    + '<div class="pay">' + qr + '<div class="terms">'
    + '<h2 style="margin-top:0">How to pay</h2>' + howToPay
    + '<ul>'
    + '<li>Cheques and drafts are credited only once cleared; a bounced instrument is reversed and may attract a bank charge.</li>'
    + '<li>A late fee applies to any instalment unpaid after its due date, at the rate published in the fee circular.</li>'
    + '<li>Keep the receipt. A payment made online is recorded against this account by the office, usually the same day.</li>'
    + '</ul></div></div>'

    + '<div class="sign"><div class="line">Parent / guardian</div>'
    + '<div class="line">Authorised signatory</div></div>'

    + '<footer><span>System generated document ' + DASH + ' valid without signature.</span>'
    + '<span>Generated ' + esc(new Date().toLocaleString('en-IN'))
    + (v.printedBy ? ' by ' + esc(v.printedBy) : '') + '</span></footer>'

    + '</div></body></html>'

  /* Printed in a hidden frame: a new tab was blocked on phones and in the app. */
  printHtml(doc)
}
