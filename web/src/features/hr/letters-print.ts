/* STAFF LETTERS, AS PRINTED (owner's designs, 2026-10-06; Inter throughout).

   One A4 page per letter: letterhead and red rule, reference and date, who it
   is to, a subject, the body, signatures, a received line and a footer. Every
   figure is from the snapshot frozen when the letter was issued (the pay lines
   in force, and for a salary revision the old and the new), so a reprint next
   year still reads as it did on the day. */

export interface PayLine { name: string; kind: string; amount_paise: number }
export interface LetterSnapshot {
  name?: string; employee_code?: string; designation?: string | null; department?: string | null
  joined_on?: string; relieved_on?: string; years_of_service?: number; qualifications?: string[]; qualification?: string | null
  employment_type?: string | null; address?: string | null; gender?: string | null; subjects?: string[]
  pay?: PayLine[]; revision?: { effective_from: string; old: PayLine[]; new: PayLine[] }
  conduct?: string; remarks?: string | null
}
export interface LetterRecord { serial_no: string; code: string; type: string; full_name: string; issued_on: string; snapshot?: LetterSnapshot }

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const longDate = (iso?: string | null) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ''); return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : '' }
const shortDate = (iso?: string | null) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ''); return m ? `${m[3]} ${MON[Number(m[2]) - 1].slice(0, 3)} ${m[1]}` : '' }
const rs = (p: number) => Math.round(p / 100).toLocaleString('en-IN')
const earnings = (l?: PayLine[]) => (l ?? []).filter((x) => x.kind !== 'deduction')
const gross = (l?: PayLine[]) => earnings(l).reduce((n, x) => n + x.amount_paise, 0)
const title = (s?: string | null) => (s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())

export function letterHtml(c: LetterRecord, o: { school: string; logoUrl?: string; issuedBy?: string }): string {
  const s = c.snapshot ?? {}
  const name = s.name || c.full_name
  const first = name.split(' ')[0]
  const honor = s.gender === 'female' ? 'Ms. ' : s.gender === 'male' ? 'Mr. ' : ''
  const she = s.gender === 'female' ? 'She' : s.gender === 'male' ? 'He' : 'They'
  const her = s.gender === 'female' ? 'her' : s.gender === 'male' ? 'his' : 'their'
  const role = [s.designation, s.department].filter(Boolean).join(', ')
  const code = c.code.toUpperCase()
  const ref = esc(c.serial_no)
  const head = `<div class="lh"><div class="logo">${o.logoUrl ? `<img src="${esc(o.logoUrl)}" alt="">` : 'LOGO'}</div><div><h1>${esc(o.school)}</h1></div></div>
  <div class="rule"></div>
  <div class="meta"><div>Ref: <b>${ref}</b></div><div>Date: <b>${shortDate(c.issued_on)}</b></div></div>`
  const to = `<div class="to">To,<br><b>${esc(honor + name)}</b>${role || s.employee_code ? `<br>${esc([role, s.employee_code].filter(Boolean).join(' · '))}` : ''}${code === 'APPOINTMENT' && s.address ? `<br>${esc(s.address)}` : ''}</div>`
  const sign2 = `<div class="sign"><div class="sig"><div class="line"></div><b>Principal</b><span>${esc(o.school)}</span></div><div class="sig"><div class="line"></div><b>Correspondent</b><span>For the Management</span></div></div>`
  const ack = (t: string) => `<div class="ack"><span>${t}</span><span>Signature: ____________________ &nbsp; Date: __________</span></div>`
  const foot = (conf = false) => `<div class="foot"><span>${esc(o.school)}${conf ? ' · Confidential' : ''}</span><span>Issued${o.issuedBy ? ` by ${esc(o.issuedBy)}` : ''} · ${shortDate(c.issued_on)}</span><span>${ref}</span></div>`
  const remarks = s.remarks ? `<p>${esc(s.remarks).replace(/\n/g, '<br>')}</p>` : ''
  const payTable = (lines: PayLine[]) => earnings(lines).length
    ? `<table><thead><tr><th>Pay component</th><th class="r">Per month (₹)</th></tr></thead><tbody>${earnings(lines).map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${rs(l.amount_paise)}</td></tr>`).join('')}<tr class="total"><td>Monthly gross</td><td class="r">${rs(gross(lines))}</td></tr></tbody></table>
      <p class="note">Deductions (PF, ESI, professional tax, TDS) are made as the law requires each month.</p>`
    : ''

  let body = ''
  if (code === 'APPOINTMENT') {
    body = `${to}<div class="subject">Subject: Letter of appointment</div>
    <div class="body"><p>Dear ${esc(first)},</p><p>We are pleased to appoint you as <b>${esc(s.designation || 'a member of staff')}</b>${s.department ? ` in the <b>${esc(s.department)}</b> department` : ''} of ${esc(o.school)}${s.joined_on ? `, with effect from <b>${longDate(s.joined_on)}</b>` : ''}, on the terms below.</p></div>
    <div class="facts">
      <div><span>Employee code</span><b>${esc(s.employee_code || '—')}</b></div>
      <div><span>Employment</span><b>${esc(title(s.employment_type) || '—')}</b></div>
      <div><span>Joining date</span><b>${longDate(s.joined_on) || '—'}</b></div>
      <div><span>Monthly gross</span><b>${gross(s.pay) ? '₹' + rs(gross(s.pay)) : 'As per payroll'}</b></div>
    </div>
    ${payTable(s.pay ?? [])}
    <div class="body">${remarks}<p>Please sign the copy of this letter and return it to the office as your acceptance. We welcome you to ${esc(o.school)}.</p></div>
    <div class="spacer"></div>${sign2}${ack('I accept the appointment on the terms above.')}${foot()}`
  } else if (code === 'SALARY_REVISION') {
    const rv = s.revision
    const oldG = gross(rv?.old), newG = gross(rv?.new)
    const pct = oldG ? ((newG - oldG) / oldG) * 100 : 0
    const rows = rv ? earnings(rv.new).map((n) => {
      const o2 = earnings(rv.old).find((x) => x.name === n.name)?.amount_paise ?? 0
      const d = n.amount_paise - o2
      return `<tr><td>${esc(n.name)}</td><td class="r">${rs(o2)}</td><td class="r">${rs(n.amount_paise)}</td><td class="r ${d > 0 ? 'up' : ''}">${d ? (d > 0 ? '+' : '−') + rs(Math.abs(d)) : '–'}</td></tr>`
    }).join('') : ''
    body = `${to}<div class="subject">Subject: Revision of salary</div>
    <div class="body"><p>Dear ${esc(first)},</p>${rv
      ? `<p>The management is pleased to revise your salary with effect from <b>${longDate(rv.effective_from)}</b>. Your monthly gross ${newG >= oldG ? 'rises' : 'changes'} by <b class="up">₹${rs(Math.abs(newG - oldG))} (${pct.toFixed(1)}%)</b>.</p>`
      : `<p>This is to inform you that your salary has been revised${role ? ` in your post of ${esc(role)}` : ''}.</p>`}</div>
    ${rv ? `<table><thead><tr><th>Pay component</th><th class="r">Current (₹)</th><th class="r">Revised (₹)</th><th class="r">Change</th></tr></thead><tbody>${rows}
      <tr class="total"><td>Monthly gross</td><td class="r">${rs(oldG)}</td><td class="r">${rs(newG)}</td><td class="r up">${newG >= oldG ? '+' : '−'}${rs(Math.abs(newG - oldG))}</td></tr></tbody></table>
      <p class="note">Deductions (PF, ESI, professional tax, TDS) are made as the law requires each month.</p>` : ''}
    <div class="body">${rv ? `<p>Annual gross is now <b>₹${rs(newG * 12)}</b>. The revised amount will be paid from your ${MON[Number(rv.effective_from.slice(5, 7)) - 1]} ${rv.effective_from.slice(0, 4)} salary. All other terms of your appointment remain unchanged.</p>` : ''}${remarks}<p>We look forward to your continued contribution.</p></div>
    <div class="spacer"></div>${sign2}${ack('Received the original.')}${foot(true)}`
  } else if (code === 'WARNING') {
    body = `${to}<div class="subject">Subject: Warning${s.remarks ? ` — ${esc(String(s.remarks).split(/[.\n]/)[0].slice(0, 60))}` : ''}</div>
    <div class="body"><p>Dear ${esc(first)},</p><p>This letter is a formal warning${role ? `, issued to you in your capacity as ${esc(role)},` : ''} about the matter below.</p></div>
    <div class="callout"><b>Reason:</b> ${esc(s.remarks || '')}</div>
    <div class="body"><p>A repeat may lead to further action under the school's service rules.</p><p>You may submit a written explanation to the Principal within <b>7 days</b> of this letter.</p></div>
    <div class="spacer"></div><div class="sign"><div class="sig"><div class="line"></div><b>Principal</b><span>${esc(o.school)}</span></div><div></div></div>${ack('Received a copy of this letter.')}${foot(true)}`
  } else {
    const relieving = code === 'RELIEVING' || !!s.relieved_on && s.relieved_on !== c.issued_on
    const months = (() => { const a = Date.parse(s.joined_on ?? ''), b = Date.parse(s.relieved_on ?? c.issued_on); if (isNaN(a) || isNaN(b)) return ''; const m = Math.max(0, Math.round((b - a) / (30.44 * 864e5))); return m >= 12 ? `${Math.floor(m / 12)} year${m >= 24 ? 's' : ''}${m % 12 ? ` ${m % 12} month${m % 12 === 1 ? '' : 's'}` : ''}` : `${m} month${m === 1 ? '' : 's'}` })()
    const qual = s.qualification || (s.qualifications ?? []).join(', ')
    body = `<div class="cert"><div class="cert-title">${code === 'RELIEVING' ? 'RELIEVING CERTIFICATE' : 'SERVICE CERTIFICATE'}</div><div class="cert-sub">To whom it may concern</div></div>
    <div class="body"><p>This is to certify that <b>${esc(honor + name)}</b>${s.employee_code ? ` (employee code <b>${esc(s.employee_code)}</b>)` : ''} served ${esc(o.school)}${s.designation ? ` as <b>${esc(s.designation)}</b>` : ''}${s.department ? `, ${esc(s.department)}` : ''}${s.joined_on ? `, from <b>${longDate(s.joined_on)}</b>` : ''}${s.relieved_on ? ` to <b>${longDate(s.relieved_on)}</b>` : ''}.</p></div>
    <div class="facts">
      <div><span>Period of service</span><b>${months || '—'}</b></div>
      <div><span>Last designation</span><b>${esc(s.designation || '—')}</b></div>
      <div><span>Qualification on record</span><b>${esc(qual || '—')}</b></div>
      <div><span>Subjects taught</span><b>${esc((s.subjects ?? []).join(', ') || '—')}</b></div>
    </div>
    <div class="body">${relieving ? `<p>${she} has been relieved of all duties${s.relieved_on ? ` with effect from <b>${longDate(s.relieved_on)}</b>` : ''} and has <b>no dues outstanding</b> to the institution.</p>` : ''}
      <p>${her[0].toUpperCase() + her.slice(1)} conduct during the period of service was <b>${esc(s.conduct || 'good')}</b>. We wish ${esc(first)} every success.</p>${remarks}</div>
    <div class="spacer"></div><div class="sign"><div></div><div class="sig"><div class="line"></div><b>Principal</b><span>${esc(o.school)} · Seal</span></div></div>${foot()}`
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(c.type)} · ${esc(name)} · ${ref}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap"><style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; background: #fff; color: #0f172a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 210mm; min-height: 297mm; margin: 0 auto; background: #fff; padding: 18mm 20mm 16mm; display: flex; flex-direction: column; }
.lh { display: flex; align-items: center; gap: 16px; padding-bottom: 14px; }
.logo { width: 58px; height: 58px; border-radius: 50%; border: 1px solid #cbd5e1; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #94a3b8; overflow: hidden; }
.logo img { width: 100%; height: 100%; object-fit: contain; }
.lh h1 { font-size: 22px; font-weight: 700; letter-spacing: -.4px; }
.rule { height: 3px; background: #c22525; margin-bottom: 18px; }
.meta { display: flex; justify-content: space-between; font-size: 12px; color: #475569; margin-bottom: 22px; } .meta b { color: #0f172a; font-weight: 600; }
.to { font-size: 13px; line-height: 1.55; margin-bottom: 18px; } .to b { font-weight: 600; }
.subject { display: inline-block; align-self: flex-start; font-size: 13.5px; font-weight: 700; border-left: 4px solid #c22525; padding: 2px 0 2px 10px; margin-bottom: 18px; }
.body p { font-size: 13px; line-height: 1.7; margin-bottom: 12px; color: #1e293b; } .body b { font-weight: 600; }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 18px; margin: 6px 0 18px; font-size: 12.5px; }
.facts span { color: #64748b; display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; margin-bottom: 2px; } .facts b { font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 4px 0 8px; }
th { background: #f1f5f9; color: #475569; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; padding: 9px 12px; text-align: left; border-bottom: 2px solid #cbd5e1; }
td { padding: 9px 12px; border-bottom: 1px solid #e2e8f0; } .r { text-align: right; } .up { color: #15803d; font-weight: 600; }
tr.total td { font-weight: 700; border-top: 2px solid #94a3b8; background: #f8fafc; }
.note { font-size: 11px; color: #64748b; margin-bottom: 16px; }
.callout { border: 1px solid #fecaca; background: #fef2f2; border-radius: 8px; padding: 12px 16px; font-size: 12.5px; line-height: 1.6; margin: 4px 0 16px; } .callout b { color: #b91c1c; }
.cert { text-align: center; margin: 10px 0 22px; } .cert-title { font-size: 17px; font-weight: 700; letter-spacing: .06em; } .cert-sub { font-size: 12px; color: #64748b; margin-top: 2px; }
.spacer { flex: 1; }
.sign { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 40px; }
.sig { width: 62mm; text-align: center; font-size: 12px; } .sig .line { border-top: 1px solid #334155; margin-bottom: 6px; }
.sig b { display: block; font-weight: 600; } .sig span { color: #64748b; font-size: 11px; }
.ack { margin-top: 26px; border-top: 1px dashed #cbd5e1; padding-top: 12px; font-size: 11.5px; color: #475569; display: flex; justify-content: space-between; gap: 16px; }
.foot { margin-top: 18px; padding-top: 10px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 10.5px; color: #94a3b8; }
</style></head><body><div class="page">${head}${body}</div></body></html>`
}
