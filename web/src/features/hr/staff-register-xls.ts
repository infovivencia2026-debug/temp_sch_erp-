/* STAFF ATTENDANCE REGISTER AS EXCEL (owner, 2026-11-28: "date and only in
   line A or P; leave shows L; late coming highlighted with time; show in time
   for all and also out time"). Under each date three narrow columns:
   Status | In | Out. Status is P or A (L for leave; HD/Pr/Hol/W/OD/H only when
   marked). A punch with no mark counts as P. A late in-time is amber and bold
   (marked Late, or punched after 8:45). One day: no totals. A range: P, A, L,
   Late totals at the end. Saved as an HTML table, which Excel opens with colours. */

export interface RegStaff { employee_code: string; biometric_id?: string; full_name: string; department?: string }
export interface RegInput {
  school: string; groupLabel: string; from: string; to: string; days: string[]; staff: RegStaff[]
  marks: Record<string, Record<string, string>>
  ins: Record<string, Record<string, string>>
  outs: Record<string, Record<string, string>>
}

const LATE_AFTER = '08:45'
const SHORT: Record<string, string> = { present: 'P', late: 'P', wfh: 'P', on_duty: 'P', absent: 'A', leave: 'L', half_day: 'HD', permission: 'Pr', holiday: 'Hol', week_off: 'W' }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const esc = (v: string) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
const hm = (t?: string) => (t ?? '').slice(0, 5)

export function staffRegisterXls(p: RegInput): string {
  const one = p.days.length === 1
  const head = (d: string) => { const t = new Date(d + 'T00:00:00Z'); return `${d.slice(8)}-${MON[t.getUTCMonth()]} ${WD[t.getUTCDay()]}` }
  const fmt = (d: string) => `${d.slice(8)} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
  const th = (v: string, st = '', attrs = '') => `<th ${attrs} style="background:#1e3a8a;color:#fff;border:1px solid #94a3b8;padding:3px 5px;text-align:center;${st}">${v}</th>`
  const td = (v: string, st = '') => `<td style="border:1px solid #cbd5e1;padding:2px 5px;mso-number-format:'\\@';${st}">${esc(v)}</td>`
  const body = p.staff.map((s) => {
    let P = 0, A = 0, L = 0, late = 0
    const cells = p.days.map((d) => {
      const m = p.marks[d]?.[s.employee_code] ?? ''
      const tin = hm(p.ins[d]?.[s.employee_code]); const tout = hm(p.outs[d]?.[s.employee_code])
      const code = m ? (SHORT[m] ?? m) : (tin || tout ? 'P' : 'A')
      if (code === 'P') P++; else if (code === 'A') A++; else if (code === 'L') L++
      const isLate = !!tin && (m === 'late' || (code === 'P' && tin > LATE_AFTER))
      if (isLate) late++
      const sc = code === 'A' ? 'background:#fecaca;color:#991b1b;font-weight:bold;' : code === 'L' ? 'background:#e2e8f0;font-weight:bold;' : ''
      return td(code, `text-align:center;${sc}`)
        + td(tin, `text-align:center;white-space:nowrap;${isLate ? 'background:#fde68a;color:#92400e;font-weight:bold;' : ''}`)
        + td(tout, 'text-align:center;white-space:nowrap')
    }).join('')
    const tot = one ? '' : td(String(P), 'text-align:center') + td(String(A), 'text-align:center;background:#fecaca;color:#991b1b;font-weight:bold') + td(String(L), 'text-align:center') + td(String(late), 'text-align:center;background:#fde68a;color:#92400e;font-weight:bold')
    return `<tr>${td(s.employee_code)}${td(s.biometric_id ?? '')}${td(s.full_name, 'white-space:nowrap')}${td(s.department ?? '')}${cells}${tot}</tr>`
  }).join('\n')
  const span = 4 + p.days.length * 3 + (one ? 0 : 4)
  const range = one ? fmt(p.from) : `${fmt(p.from)} to ${fmt(p.to)}`
  const totHead = one ? '' : ['P', 'A', 'L', 'Late'].map((t) => th(t, '', 'rowspan="2"')).join('')
  return `<html><head><meta charset="utf-8"></head><body style="font-family:Calibri,Arial,sans-serif">
<table><tr><td colspan="${span}" style="font-size:16pt;font-weight:bold">${esc(p.school)}: Staff attendance register</td></tr>
<tr><td colspan="${span}">${esc(p.groupLabel)} &middot; ${range} &middot; ${p.staff.length} staff</td></tr>
<tr><td colspan="${span}">P = Present, <span style="background:#fecaca;color:#991b1b;font-weight:bold">&nbsp;A = Absent&nbsp;</span>, L = Leave; <span style="background:#fde68a;color:#92400e;font-weight:bold">&nbsp;amber time = came late&nbsp;</span></td></tr><tr></tr>
<tr>${['Code', 'Biometric ID', 'Name', 'Group'].map((t) => th(t, '', 'rowspan="2"')).join('')}${p.days.map((d) => th(head(d), '', 'colspan="3"')).join('')}${totHead}</tr>
<tr>${p.days.map(() => th('Status', 'width:64px;white-space:nowrap', 'width="64"') + th('In', 'width:64px;white-space:nowrap', 'width="64"') + th('Out', 'width:64px;white-space:nowrap', 'width="64"')).join('')}</tr>
${body}</table></body></html>`
}
