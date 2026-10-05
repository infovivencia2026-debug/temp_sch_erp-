import type { FeeReceipt } from '@shared/api/fees'

/* THE FEE RECEIPT, AS PRINTED (owner's design, 2026-10-05).

   An A4 page of its own: school and logo on the left, "Fee Receipt" and the
   year on the right under a red rule; receipt number and date; the student
   in a grey grid; the particulars table; total and amount in words; the
   disclaimer and a signature line for whoever collected it. Printed from a
   hidden frame so the app's own letterhead and styles never mix in. */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso: string) => { const m = /^(d{4})-(d{2})-(d{2})/.exec(iso); return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : esc(iso) }

export function receiptHtml(r: FeeReceipt, school: { name: string; sub?: string; logoUrl?: string }): string {
  const klass = [r.class_name, r.section_name].filter(Boolean).join('-')
  const lines = r.lines.length ? r.lines : [{ particulars: 'Fee Payment', invoice_no: '', amount_paise: r.amount_paise }]
  const rows = lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.particulars || 'Fee Payment')}${l.invoice_no ? `<div class="inv">${esc(l.invoice_no)}</div>` : ''}</td><td class="amount-col">${rupees(l.amount_paise)}</td></tr>`).join('')
  const mode = (r.mode || '').toUpperCase() + (r.reference_no ? ` · ${esc(r.reference_no)}` : '')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Fee Receipt ${esc(r.receipt_no)}</title><style>
@page { size: A4; margin: 0; }
body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background: #fff; color: #333; }
.receipt-container { max-width: 800px; margin: 0 auto; background: #fff; padding: 50px; box-sizing: border-box; }
.header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #b31b18; padding-bottom: 20px; margin-bottom: 30px; }
.school-info { display: flex; align-items: center; gap: 20px; }
.logo { width: 70px; height: 70px; object-fit: contain; }
.school-text h1 { margin: 0 0 5px 0; font-size: 24px; color: #0f3057; }
.school-text p { margin: 0; font-size: 14px; color: #666; font-style: italic; }
.receipt-title { text-align: right; }
.receipt-title h2 { margin: 0; font-size: 22px; color: #333; }
.receipt-title p { margin: 5px 0 0; font-size: 14px; color: #666; }
.meta-info { display: flex; justify-content: space-between; margin-bottom: 30px; font-size: 14px; }
.meta-info strong { color: #333; }
.details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 30px; font-size: 14px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.detail-item { display: flex; }
.detail-label { width: 120px; flex-shrink: 0; color: #666; font-weight: 500; }
.detail-value { color: #111; font-weight: 600; }
table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #eee; vertical-align: top; }
th { background: #f0f0f0; font-weight: 600; color: #333; font-size: 14px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
td { font-size: 15px; }
td .inv { font-size: 12px; color: #888; margin-top: 2px; }
.amount-col { text-align: right; width: 150px; }
.total-section { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding-top: 15px; border-top: 2px solid #333; margin-bottom: 50px; }
.amount-words { font-size: 14px; color: #555; font-style: italic; }
.total-amount { font-size: 20px; font-weight: 700; color: #111; white-space: nowrap; }
.footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 50px; }
.disclaimer { font-size: 12px; color: #888; max-width: 400px; }
.signature { text-align: center; font-size: 14px; color: #333; }
.sig-line { width: 150px; border-top: 1px solid #333; margin-bottom: 5px; }
</style></head><body><div class="receipt-container">
<div class="header"><div class="school-info">${school.logoUrl ? `<img class="logo" src="${esc(school.logoUrl)}" alt="">` : ''}<div class="school-text"><h1>${esc(school.name)}</h1>${school.sub ? `<p>${esc(school.sub)}</p>` : ''}</div></div>
<div class="receipt-title"><h2>Fee Receipt</h2><p>Academic Year ${esc(r.financial_year)}</p></div></div>
<div class="meta-info"><div>Receipt No: <strong>${esc(r.receipt_no)}</strong></div><div>Date: <strong>${day(r.paid_on)}</strong></div></div>
<div class="details-grid">
<div class="detail-item"><div class="detail-label">Student Name:</div><div class="detail-value">${esc(r.student_name)}</div></div>
<div class="detail-item"><div class="detail-label">Admission No:</div><div class="detail-value">${esc(r.admission_no)}</div></div>
<div class="detail-item"><div class="detail-label">Class:</div><div class="detail-value">${esc(klass || '—')}</div></div>
<div class="detail-item"><div class="detail-label">Payment Mode:</div><div class="detail-value">${mode}</div></div>
</div>
<table><thead><tr><th>S.No.</th><th>Particulars</th><th class="amount-col">Amount (₹)</th></tr></thead><tbody>${rows}</tbody></table>
<div class="total-section"><div class="amount-words"><strong>Amount in words:</strong> ${esc(r.amount_words)}</div><div class="total-amount">Total Received: ₹${rupees(r.amount_paise)}</div></div>
<div class="footer"><div class="disclaimer">This is a computer-generated receipt. Cheques and drafts are subject to realisation.</div>
<div class="signature"><div class="sig-line"></div>Received by: ${esc(r.collected_by || '')}</div></div>
</div></body></html>`
}

/** Prints the receipt from a hidden frame; waits for the logo before opening the dialog. */
export function printReceipt(r: FeeReceipt, school: { name: string; sub?: string; logoUrl?: string }): void {
  printHtml(receiptHtml(r, school))
}

/** Prints a whole HTML document from a hidden frame; waits for its images first. */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open(); doc.write(html); doc.close()
  let done = false
  const go = () => {
    if (done) return
    done = true
    const w = frame.contentWindow!
    w.focus(); w.print()
    // The dialog blocks until closed in most browsers; remove the frame after.
    window.setTimeout(() => frame.remove(), 1000)
  }
  const img = doc.querySelector('img')
  // Web fonts too, so the first print is not in the fallback face.
  void doc.fonts?.ready
  if (img && !img.complete) { img.onload = go; img.onerror = go; window.setTimeout(() => { if (frame.isConnected && !img.complete) go() }, 3000) }
  else window.setTimeout(go, 50)
}
