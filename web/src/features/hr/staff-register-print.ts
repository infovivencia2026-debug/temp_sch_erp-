/* THE STAFF ATTENDANCE REGISTER, AS PRINTED (owner's design, 2026-10-05).

   Every employee on one register, not the ten rows the screen happened to
   show (the old print copied the page, so it printed "1–10 of 20"). School and
   red rule; title and date; four totals; one row per person with the code,
   check-in and the mark; who printed it and when. */

export interface RegisterRow { employee_code: string; full_name: string; check_in?: string; mark: string }

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : esc(iso) }
const LABEL: Record<string, string> = { present: 'Present', absent: 'Absent', late: 'Late', half_day: 'Half day', leave: 'On leave', week_off: 'Week off', on_duty: 'On duty' }
const TONE: Record<string, string> = { present: '#15803d', late: '#b45309', half_day: '#b45309', absent: '#c22525', leave: '#475569' }
const time = (t?: string) => { if (!t) return ''; const m = /(\d{2}):(\d{2})/.exec(t); if (!m) return esc(t); const h = Number(m[1]); return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'am' : 'pm'}` }

export function staffRegisterHtml(o: { school: { name: string; sub?: string; logoUrl?: string }; onDate: string; rows: RegisterRow[]; printedBy: string }): string {
  const marked = o.rows.filter((r) => r.mark).length
  const present = o.rows.filter((r) => ['present', 'late', 'half_day', 'on_duty'].includes(r.mark)).length
  const away = o.rows.filter((r) => ['absent', 'leave'].includes(r.mark)).length
  const now = new Date()
  const printedAt = `${String(now.getDate()).padStart(2, '0')} ${MON[now.getMonth()]} ${now.getFullYear()}, ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
  const body = o.rows.map((r) => `<tr><td class="code-col">${esc(r.employee_code)}</td><td>${esc(r.full_name)}</td><td style="color: var(--text-muted);">${time(r.check_in) || '-'}</td><td style="font-weight:600;color:${TONE[r.mark] ?? 'var(--text-muted)'}">${r.mark ? esc(LABEL[r.mark] ?? r.mark) : 'Not marked'}</td></tr>`).join('')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Staff Attendance Register · ${day(o.onDate)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap"><style>
:root { --bg-body: #f8fafc; --bg-card: #ffffff; --text-main: #0f172a; --text-muted: #64748b; --border-color: #cbd5e1; --accent-red: #c22525; }
@page { size: A4; margin: 15mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; background: #fff; color: var(--text-main); -webkit-font-smoothing: antialiased; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.document-container { max-width: 100%; margin: 0 auto; background: var(--bg-card); }
.header-brand { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.logo-circle { width: 56px; height: 56px; border-radius: 50%; border: 1px solid var(--border-color); background: #f8fafc; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: var(--text-muted); overflow: hidden; }
.logo-circle img { width: 100%; height: 100%; object-fit: contain; }
.school-titles h1 { margin: 0 0 2px 0; font-size: 22px; font-weight: 700; color: var(--text-main); letter-spacing: -0.5px; }
.school-titles p { margin: 0; font-size: 13px; color: var(--text-muted); font-style: italic; }
.header-divider { height: 3px; background-color: var(--accent-red); margin-bottom: 32px; }
.title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 24px; }
.title-row h2 { font-size: 20px; font-weight: 700; color: var(--text-main); border-left: 4px solid var(--accent-red); padding-left: 12px; margin: 0; }
.date-badge { font-size: 13px; font-weight: 600; } .date-badge span { color: var(--text-muted); font-weight: 400; margin-right: 6px; }
.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
.stat-card { background: #f8fafc; border: 1px solid var(--border-color); border-radius: 6px; padding: 16px; }
.stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; margin-bottom: 6px; }
.stat-value { font-size: 22px; font-weight: 700; color: var(--text-main); }
.table-card { border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; margin-bottom: 40px; }
.table-header-bar { background: #f8fafc; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); font-weight: 600; font-size: 13px; }
.table-header-bar span { color: var(--text-muted); font-size: 12px; font-weight: 500; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead { display: table-header-group; } tr { page-break-inside: avoid; }
th { background-color: #ffffff; color: var(--text-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; padding: 12px 20px; text-align: left; border-bottom: 1px solid var(--border-color); }
td { padding: 12px 20px; border-bottom: 1px solid var(--border-color); color: var(--text-main); }
tr:last-child td { border-bottom: none; }
.code-col { color: var(--text-muted); font-weight: 500; }
.footer { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border-color); padding-top: 16px; font-weight: 500; }
</style></head><body><div class="document-container">
  <div class="header-brand"><div class="logo-circle">${o.school.logoUrl ? `<img src="${esc(o.school.logoUrl)}" alt="">` : 'LOGO'}</div><div class="school-titles"><h1>${esc(o.school.name)}</h1>${o.school.sub ? `<p>${esc(o.school.sub)}</p>` : ''}</div></div>
  <div class="header-divider"></div>
  <div class="title-row"><h2>Staff Attendance Register</h2><div class="date-badge"><span>Date</span> ${day(o.onDate)}</div></div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Total Staff</div><div class="stat-value">${o.rows.length}</div></div>
    <div class="stat-card"><div class="stat-label">Marked</div><div class="stat-value">${marked} / ${o.rows.length}</div></div>
    <div class="stat-card"><div class="stat-label">Present</div><div class="stat-value">${present}</div></div>
    <div class="stat-card"><div class="stat-label">Absent / Leave</div><div class="stat-value">${away}</div></div>
  </div>
  <div class="table-card">
    <div class="table-header-bar">Daily Attendance Log<span>${day(o.onDate)}</span></div>
    <table><thead><tr><th>Code</th><th>Employee</th><th>Checked In</th><th>Status / Mark</th></tr></thead><tbody>${body}</tbody></table>
  </div>
  <div class="footer"><div>${esc(o.school.name)}</div><div>Generated ${esc(printedAt)}${o.printedBy ? ` by ${esc(o.printedBy)}` : ''}</div><div>${o.rows.length} staff</div></div>
</div></body></html>`
}

/* THE REGISTER OVER A RANGE OF DATES (owner: "let them choose date from to").
   A4 landscape: staff down the side, one column per day with the mark's
   letter, then each person's totals. Same header and rule as the day sheet. */
const SHORT: Record<string, string> = { present: 'P', absent: 'A', late: 'L', half_day: '½', leave: 'Lv', week_off: 'W', on_duty: 'OD' }

export function staffRangeHtml(o: {
  school: { name: string; sub?: string; logoUrl?: string }
  from: string; to: string; days: string[]
  staff: { user_id: string; employee_code: string; full_name: string }[]
  marks: Record<string, Record<string, string>> // day -> user_id -> status
  printedBy: string
}): string {
  const now = new Date()
  const printedAt = `${String(now.getDate()).padStart(2, '0')} ${MON[now.getMonth()]} ${now.getFullYear()}, ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
  const dow = (iso: string) => ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][new Date(iso + 'T00:00:00').getDay()]
  let allP = 0, allA = 0, allL = 0, allMarked = 0
  const rows = o.staff.map((s) => {
    let p = 0, a = 0, lv = 0, half = 0, wo = 0
    const cells = o.days.map((d) => {
      const m = o.marks[d]?.[s.user_id] ?? ''
      if (m === 'present' || m === 'late' || m === 'on_duty') p++
      else if (m === 'half_day') { half++; p += 0.5 }
      else if (m === 'absent') a++
      else if (m === 'leave') lv++
      else if (m === 'week_off') wo++
      const color = TONE[m] ?? '#94a3b8'
      return `<td class="d" style="color:${color}">${m ? SHORT[m] ?? '?' : '·'}</td>`
    }).join('')
    const marked = o.days.filter((d) => o.marks[d]?.[s.user_id]).length
    allP += p; allA += a; allL += lv; allMarked += marked
    // Working days: what was marked, less leave and week offs.
    const working = marked - lv - wo
    const pct = working > 0 ? Math.round((p / working) * 100) + '%' : '—'
    return `<tr><td class="code-col">${esc(s.employee_code)}</td><td class="nm">${esc(s.full_name)}</td>${cells}<td class="t">${p}</td><td class="t">${a}</td><td class="t">${lv}</td><td class="t b">${pct}</td></tr>`
  }).join('')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Staff Attendance Register · ${day(o.from)} – ${day(o.to)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap"><style>
:root { --text-main: #0f172a; --text-muted: #64748b; --border-color: #cbd5e1; --accent-red: #c22525; }
@page { size: A4 landscape; margin: 10mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; background: #fff; color: var(--text-main); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.header-brand { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.logo-circle { width: 48px; height: 48px; border-radius: 50%; border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: var(--text-muted); overflow: hidden; }
.logo-circle img { width: 100%; height: 100%; object-fit: contain; }
.school-titles h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; } .school-titles p { font-size: 12px; color: var(--text-muted); font-style: italic; }
.header-divider { height: 3px; background: var(--accent-red); margin-bottom: 18px; }
.title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
.title-row h2 { font-size: 18px; font-weight: 700; border-left: 4px solid var(--accent-red); padding-left: 10px; }
.date-badge { font-size: 12px; font-weight: 600; } .date-badge span { color: var(--text-muted); font-weight: 400; margin-right: 6px; }
.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.stat-card { background: #f8fafc; border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px; }
.stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; margin-bottom: 2px; }
.stat-value { font-size: 18px; font-weight: 700; }
table { width: 100%; border-collapse: collapse; font-size: 10px; border: 1px solid var(--border-color); }
thead { display: table-header-group; } tr { page-break-inside: avoid; }
th { background: #f8fafc; color: var(--text-muted); font-weight: 600; padding: 5px 3px; border-bottom: 1px solid var(--border-color); text-align: center; font-size: 9px; }
th.l, td.code-col, td.nm { text-align: left; padding-left: 8px; }
td { padding: 5px 3px; border-bottom: 1px solid #e2e8f0; text-align: center; }
td.d { font-weight: 700; border-left: 1px solid #f1f5f9; }
td.nm { white-space: nowrap; font-weight: 500; } td.code-col { color: var(--text-muted); white-space: nowrap; }
td.t { background: #f8fafc; font-weight: 600; border-left: 1px solid var(--border-color); } td.b { font-weight: 700; }
.legend { font-size: 10px; color: var(--text-muted); margin: 10px 0 18px; }
.footer { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); border-top: 1px solid var(--border-color); padding-top: 10px; }
</style></head><body>
  <div class="header-brand"><div class="logo-circle">${o.school.logoUrl ? `<img src="${esc(o.school.logoUrl)}" alt="">` : 'LOGO'}</div><div class="school-titles"><h1>${esc(o.school.name)}</h1>${o.school.sub ? `<p>${esc(o.school.sub)}</p>` : ''}</div></div>
  <div class="header-divider"></div>
  <div class="title-row"><h2>Staff Attendance Register</h2><div class="date-badge"><span>From</span> ${day(o.from)} <span style="margin-left:10px">To</span> ${day(o.to)}</div></div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Staff · Days</div><div class="stat-value">${o.staff.length} · ${o.days.length}</div></div>
    <div class="stat-card"><div class="stat-label">Marks recorded</div><div class="stat-value">${allMarked}</div></div>
    <div class="stat-card"><div class="stat-label">Present (staff-days)</div><div class="stat-value">${allP}</div></div>
    <div class="stat-card"><div class="stat-label">Absent / Leave</div><div class="stat-value">${allA} / ${allL}</div></div>
  </div>
  <table><thead><tr><th class="l">Code</th><th class="l">Employee</th>${o.days.map((d) => `<th>${Number(d.slice(8))}<br>${dow(d)}</th>`).join('')}<th>P</th><th>A</th><th>Lv</th><th>%</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="legend">P present · A absent · L late · ½ half day · Lv on leave · W week off · · not marked. % = present days over working days (leave and week offs left out).</div>
  <div class="footer"><div>${esc(o.school.name)}</div><div>Generated ${esc(printedAt)}${o.printedBy ? ` by ${esc(o.printedBy)}` : ''}</div><div>${o.staff.length} staff · ${o.days.length} days</div></div>
</body></html>`
}
