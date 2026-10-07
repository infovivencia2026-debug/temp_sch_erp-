import { PRINT_KIT_CSS } from '@/lib/print-kit'
/* STAFF LEAVE APPROVALS, AS PRINTED (owner, 2026-10-06): the school's header,
   the four count boxes as one ruled strip (Total requests, Pending approval,
   Approved, Rejected; each a label row, a big number and a caption), then the
   requests as listed on screen. Inter throughout. */

export interface LeavePrintRow { who: string; subject_kind: string; leave_type?: string; from_date: string; to_date: string; days: string; reason: string; status: string }

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ''); return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : esc(iso) }
const TONE: Record<string, string> = { approved: '#15803d', rejected: '#c22525', pending: '#b45309', cancelled: '#64748b' }

export function leaveHtml(o: { school: string; logoUrl?: string; title: string; all: LeavePrintRow[]; rows: LeavePrintRow[]; printedBy: string }): string {
  const n = (st?: string) => (st ? o.all.filter((r) => r.status === st).length : o.all.length)
  const box = (label: string, value: number, caption: string) => `<td><div class="bl">${label}</div><div class="bv">${value}</div><div class="bc">${caption}</div></td>`
  const now = new Date()
  const printedAt = `${String(now.getDate()).padStart(2, '0')} ${MON[now.getMonth()]} ${now.getFullYear()}, ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
  const body = o.rows.map((r) => `<tr><td><b>${esc(r.who)}</b><div class="sub">${esc(r.subject_kind === 'student' ? 'Student' : 'Staff')}</div></td><td>${esc(r.leave_type || '—')}</td><td>${day(r.from_date)}</td><td>${day(r.to_date)}</td><td class="c">${esc(r.days)}</td><td class="reason">${esc(r.reason)}</td><td style="color:${TONE[r.status] ?? '#334155'};font-weight:600;text-transform:capitalize">${esc(r.status)}</td></tr>`).join('')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(o.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap"><style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; color: #0f172a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.lh { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.logo { width: 52px; height: 52px; border-radius: 50%; border: 1px solid #cbd5e1; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #94a3b8; overflow: hidden; }
.logo img { width: 100%; height: 100%; object-fit: contain; }
.lh h1 { font-size: 21px; font-weight: 700; letter-spacing: -.4px; }
.rule { height: 3px; background: #c22525; margin-bottom: 20px; }
.title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
.title-row h2 { font-size: 18px; font-weight: 700; border-left: 4px solid #c22525; padding-left: 10px; }
.title-row span { font-size: 12px; color: #64748b; }
table.counts { width: 100%; border-collapse: collapse; border: 1.5px solid #0f172a; margin-bottom: 22px; table-layout: fixed; }
table.counts td { border-left: 1.5px solid #0f172a; text-align: center; padding: 0; }
table.counts td:first-child { border-left: 0; }
.bl { background: #f1f5f9; border-bottom: 1.5px solid #0f172a; padding: 8px 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #1e293b; }
.bv { font-size: 24px; font-weight: 700; padding-top: 10px; line-height: 1.1; }
.bc { font-size: 11px; color: #475569; padding: 4px 6px 10px; }
table.list { width: 100%; border-collapse: collapse; font-size: 11.5px; }
table.list thead { display: table-header-group; } table.list tr { page-break-inside: avoid; }
table.list th { background: #f8fafc; color: #64748b; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; text-align: left; padding: 9px 8px; border-bottom: 1.5px solid #cbd5e1; }
table.list td { padding: 9px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
.sub { font-size: 10px; color: #64748b; } .c { text-align: center; } .reason { color: #334155; max-width: 60mm; }
.none { font-size: 12px; color: #64748b; font-style: italic; padding: 14px 0; }
.foot { display: flex; justify-content: space-between; margin-top: 22px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 10.5px; color: #94a3b8; }
${PRINT_KIT_CSS}</style></head><body>
<div class="lh"><div class="logo">${o.logoUrl ? `<img src="${esc(o.logoUrl)}" alt="">` : 'LOGO'}</div><h1>${esc(o.school)}</h1></div>
<div class="rule"></div>
<div class="title-row"><h2>${esc(o.title)}</h2><span>${o.rows.length} request${o.rows.length === 1 ? '' : 's'} listed</span></div>
<table class="counts"><tr>${box('Total requests', n(), 'Every request')}${box('Pending approval', n('pending'), 'Awaiting decision')}${box('Approved', n('approved'), 'Decided in favour')}${box('Rejected', n('rejected'), 'Turned down')}</tr></table>
${o.rows.length ? `<table class="list"><thead><tr><th>Who</th><th>Type</th><th>From</th><th>To</th><th class="c">Days</th><th>Reason</th><th>Status</th></tr></thead><tbody>${body}</tbody></table>` : '<p class="none">No requests in this list.</p>'}
<div class="foot"><span>${esc(o.school)}</span><span>Printed ${esc(printedAt)}${o.printedBy ? ` by ${esc(o.printedBy)}` : ''}</span></div>
</body></html>`
}
