import type { SchoolFacts } from '../../services/document'

/* THE STAFF OVERVIEW, ONE PERSON (owner's design, 2026-10-05).

   Staff 360 → a person → overview report → Print. The owner's layout: the
   school and the time it was made; who the person is; eight figures; what
   they teach and what else they run; how their classes did; signatures.

   Every figure is read from the school's own records. Where the school has
   not recorded something yet (no marks published, no attendance marked) the
   card says so instead of showing a made-up number. */

export interface OverviewInput {
  facts: SchoolFacts
  printedBy: string
  person: Record<string, unknown>
  load: { subjects_count: number; sections_count: number; students_count: number; periods_per_week: number
    class_teacher_of: { class: string; section: string }[]; subjects: { class: string; section: string; subject: string; students: number }[] }
  marks: { has_marks: boolean; overall_avg_pct: number; pass_rate_pct: number; distinction_rate_pct: number
    by_subject: { subject: string; avg_pct: number }[]; trend: { exam: string; date: string; avg_pct: number }[]; by_section: { class: string; section: string; avg_pct: number }[] }
}

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;')
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const dmy = (iso: unknown) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? `${m[3]}-${MON[Number(m[2]) - 1]}-${m[1]}` : '' }
const pct = (n: number) => Math.max(0, Math.min(100, n))
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim()

/** The extra figures, from attendance, leave, homework, lesson plans, activities and duties. */
export async function overviewExtras(db: D1Database, employeeId: string, userId: string | null) {
  const year = await db.prepare(`SELECT name, starts_on, ends_on FROM academic_years WHERE is_current = 1 ORDER BY starts_on DESC LIMIT 1`).first<{ name: string; starts_on: string; ends_on: string }>()
  const today = new Date().toISOString().slice(0, 10)
  const from = year?.starts_on ?? `${new Date().getUTCMonth() < 3 ? new Date().getUTCFullYear() - 1 : new Date().getUTCFullYear()}-04-01`
  const yearName = year?.name ?? ''
  const att = userId ? await db.prepare(`SELECT COUNT(*) AS marked, SUM(CASE WHEN status IN ('present','late','half_day','on_duty') THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late FROM staff_attendance WHERE user_id = ? AND on_date BETWEEN ? AND ?`).bind(userId, from, today)
    .first<{ marked: number; present: number | null; late: number | null }>() : null
  const leave = await db.prepare(`SELECT COALESCE(SUM(CAST(days AS REAL)), 0) AS days, COUNT(*) AS n FROM leave_requests
      WHERE employee_id = ? AND status = 'approved' AND from_date >= ?`).bind(employeeId, from).first<{ days: number; n: number }>()
  const bal = await db.prepare(`SELECT COALESCE(SUM(CAST(lb.entitled AS REAL) - CAST(lb.taken AS REAL)), 0) AS left_days, COUNT(*) AS n FROM leave_balances lb
      JOIN academic_years ay ON ay.id = lb.academic_year_id AND ay.is_current = 1 WHERE lb.employee_id = ?`).bind(employeeId).first<{ left_days: number; n: number }>()
  const hw = userId ? await db.prepare(`SELECT COUNT(*) AS n FROM homework WHERE created_by = ? AND assigned_on >= ?`).bind(userId, from).first<{ n: number }>() : null
  const lp = userId ? await db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('approved','reviewed') THEN 1 ELSE 0 END) AS ok FROM lesson_plans WHERE teacher_user_id = ? AND week_of >= ?`).bind(userId, from)
    .first<{ n: number; ok: number | null }>() : null
  const acts = userId ? ((await db.prepare(`SELECT name, category, COALESCE(schedule, '') AS schedule FROM activities WHERE coordinator_id = ? AND is_active = 1 ORDER BY name`).bind(userId)
    .all<{ name: string; category: string; schedule: string }>()).results ?? []) : []
  const duties = userId ? await db.prepare(`SELECT COUNT(*) AS n FROM duty_assignments WHERE user_id = ? AND on_date BETWEEN ? AND ?`).bind(userId, from, today).first<{ n: number }>() : null
  return {
    yearName,
    attendance: { marked: att?.marked ?? 0, present: att?.present ?? 0, late: att?.late ?? 0 },
    leave: { days: leave?.days ?? 0, requests: leave?.n ?? 0, balance: bal?.n ? bal.left_days : null },
    homework: hw?.n ?? 0,
    lessonPlans: { n: lp?.n ?? 0, ok: lp?.ok ?? 0 },
    activities: acts,
    duties: duties?.n ?? 0,
  }
}

export function staffOverviewDoc(o: OverviewInput, x: Awaited<ReturnType<typeof overviewExtras>>): { html: string; css: string } {
  const p = o.person
  const name = `${s(p.first_name)} ${s(p.last_name)}`.trim()
  const now = new Date(Date.now() + 5.5 * 3600e3) // IST, as the school reads it
  const stamp = `${String(now.getUTCDate()).padStart(2, '0')}-${MON[now.getUTCMonth()]}-${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} IST`
  const logo = o.facts.logoKey && /^[0-9a-f-]{36}$/i.test(o.facts.logoKey) ? `<img src="/api/v1/files/${esc(o.facts.logoKey)}?inline=1" alt="">` : 'LOGO'
  const photo = s(p.photo_file_id) ? `<img src="/api/v1/files/${esc(p.photo_file_id)}?inline=1" alt="">` : 'PHOTO'
  const active = s(p.status) === 'active' || !s(p.status)
  const item = (label: string, value: unknown, mono = false) => {
    const v = s(value)
    return `<div class="data-item"><span class="data-label">${label}</span><span class="data-value${mono ? ' mono' : ''}${v ? '' : ' empty'}">${v ? esc(v) : 'Not recorded'}</span></div>`
  }
  const employment = s(p.employment_type).replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
  const exp = p.experience_years === null || p.experience_years === undefined || p.experience_years === '' ? '' : `${Math.trunc(Number(p.experience_years))} years`
  const gender = s(p.gender) ? s(p.gender)[0].toUpperCase() + s(p.gender).slice(1) : ''

  const stat = (label: string, num: string, unit: string, note: string, tone: 'up' | 'down' | 'neutral' = 'neutral') =>
    `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-number">${num}<span class="stat-unit">${unit}</span></div><div class="stat-trend"><span class="trend-${tone}">${note}</span></div></div>`
  const L = o.load, M = o.marks
  const attPct = x.attendance.marked ? (x.attendance.present / x.attendance.marked) * 100 : null
  const cards = [
    stat('Teaching Load', String(L.periods_per_week), '/wk', `${L.subjects_count} subject${L.subjects_count === 1 ? '' : 's'}`),
    stat('Student Reach', String(L.students_count), 'students', `Across ${L.sections_count} section${L.sections_count === 1 ? '' : 's'}`),
    M.has_marks ? stat('Results (Avg)', M.overall_avg_pct.toFixed(1), '%', 'Published exams only', M.overall_avg_pct >= 60 ? 'up' : 'down') : stat('Results (Avg)', '—', '', 'No published marks yet'),
    M.has_marks ? stat('Pass Rate', M.pass_rate_pct.toFixed(1), '%', `${M.distinction_rate_pct.toFixed(1)}% distinction`, M.pass_rate_pct >= 80 ? 'up' : 'down') : stat('Pass Rate', '—', '', 'No published marks yet'),
    attPct === null ? stat('Staff Attendance', '—', '', 'Not marked this year') : stat('Staff Attendance', attPct.toFixed(1), '%', `${x.attendance.marked} days marked · ${x.attendance.late} late`, attPct >= 90 ? 'up' : 'down'),
    stat('Leave Taken', String(+x.leave.days.toFixed(1)), 'days', x.leave.balance === null ? `${x.leave.requests} approved request${x.leave.requests === 1 ? '' : 's'}` : `${+x.leave.balance.toFixed(1)} days left`),
    stat('Homework Set', String(x.homework), 'tasks', x.yearName ? `This year (${esc(x.yearName)})` : 'This year'),
    stat('Lesson Plans', String(x.lessonPlans.n), 'weeks', `${x.lessonPlans.ok} approved`, x.lessonPlans.n && x.lessonPlans.ok === x.lessonPlans.n ? 'up' : 'neutral'),
  ].join('')

  const classes = L.subjects.length
    ? `<table><thead><tr><th>Class</th><th>Subject</th><th class="text-center">Students</th><th>Class average</th></tr></thead><tbody>${L.subjects.map((r) => {
        const sec = M.by_section.find((b) => b.class === r.class && b.section === r.section)
        const avg = sec ? `<div class="progress-cell"><div class="progress-track-mini"><div class="progress-fill-mini" style="width:${pct(sec.avg_pct)}%"></div></div><span class="td-mono" style="font-size:11px">${sec.avg_pct.toFixed(0)}%</span></div>` : '<span class="muted">No marks yet</span>'
        return `<tr><td>${esc(r.class)} ${esc(r.section)}</td><td>${esc(r.subject)}</td><td class="td-mono text-center">${r.students}</td><td>${avg}</td></tr>`
      }).join('')}</tbody></table>`
    : `<p class="muted">No classes are assigned to ${esc(name)} in the timetable.</p>`

  const duties = x.activities.length || x.duties
    ? `<table><thead><tr><th>Role / Duty</th><th>Type</th><th class="text-right">When</th></tr></thead><tbody>${x.activities.map((a) => `<tr><td>${esc(a.name)} coordinator</td><td>${esc(a.category)}</td><td class="td-mono text-right">${esc(a.schedule) || '—'}</td></tr>`).join('')}${x.duties ? `<tr><td>Duty shifts</td><td>Rota</td><td class="td-mono text-right">${x.duties} this year</td></tr>` : ''}</tbody></table>`
    : `<p class="muted">No clubs or duty shifts recorded.</p>`

  const bars = M.by_subject.length
    ? `<div class="bar-chart">${M.by_subject.map((b, i) => `<div class="bar-col"><div class="bar" style="height:${pct(b.avg_pct)}%;${i % 2 ? 'background:var(--text-tertiary);' : ''}"><div class="bar-val">${b.avg_pct.toFixed(0)}%</div><div class="bar-label">${esc(b.subject.slice(0, 10))}</div></div></div>`).join('')}</div>`
    : '<p class="muted">Shown once marks are published.</p>'
  const tr = M.trend
  const trend = tr.length
    ? (() => {
        const w = 300, h = 70, step = tr.length > 1 ? (w - 40) / (tr.length - 1) : 0
        const pts = tr.map((t, i) => ({ x: 20 + i * step, y: h - 8 - (pct(t.avg_pct) / 100) * (h - 20), t }))
        return `<svg viewBox="0 0 ${w} ${h + 22}" width="100%" font-family="JetBrains Mono, monospace">
          <line x1="0" y1="${h}" x2="${w}" y2="${h}" stroke="#eaeaea"/>
          ${pts.length > 1 ? `<polyline points="${pts.map((q) => `${q.x},${q.y}`).join(' ')}" fill="none" stroke="#0070f3" stroke-width="2"/>` : ''}
          ${pts.map((q) => `<circle cx="${q.x}" cy="${q.y}" r="4" fill="#fff" stroke="#0070f3" stroke-width="2"/><text x="${q.x}" y="${q.y - 8}" text-anchor="middle" font-size="10">${q.t.avg_pct.toFixed(0)}</text><text x="${q.x}" y="${h + 16}" text-anchor="middle" font-size="9" fill="#666" font-family="Inter, sans-serif">${esc(q.t.exam.slice(0, 12))}</text>`).join('')}
        </svg>`
      })()
    : '<p class="muted">Shown once marks are published.</p>'
  const sections = M.by_section.length
    ? M.by_section.map((b, i) => `<div class="hbar-row"><div class="hbar-label"><span>${esc(b.class)} ${esc(b.section)}</span><span class="val">${b.avg_pct.toFixed(0)}%</span></div><div class="hbar-track"><div class="hbar-fill" style="width:${pct(b.avg_pct)}%;${i % 3 === 1 ? 'background:var(--text-primary);' : i % 3 === 2 ? 'background:var(--accent-blue);' : ''}"></div></div></div>`).join('')
    : '<p class="muted">Shown once marks are published.</p>'

  const html = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@400;500;700&amp;display=swap"><div class="so-doc"><div class="dashboard-container">
  <div class="dash-header">
    <div class="school-brand"><div class="logo-box">${logo}</div><div><h1>${esc(o.facts.name)}</h1><p>Faculty Performance &amp; Load${x.yearName ? ` · ${esc(x.yearName)}` : ''}</p></div></div>
    <div class="meta-info"><div class="title">Staff Overview</div><div class="timestamp">Generated: ${stamp}${o.printedBy ? ` by ${esc(o.printedBy)}` : ''}</div></div>
  </div>
  <div class="profile-section">
    <div class="avatar-container">${photo}<div class="status-dot${active ? '' : ' off'}"></div></div>
    <div class="profile-details">
      <div class="profile-header"><h2>${esc(name)}</h2><span class="badge-mono">ID: ${esc(p.employee_code)}</span><span class="badge-mono ${active ? 'ok' : ''}">${esc((s(p.status) || 'active').toUpperCase())}</span></div>
      <div class="data-grid">
        ${item('Designation', p.designation)}${item('Department', p.department)}${item('Employment', employment)}${item('Qualification', p.qualification)}
        ${item('Joined Date', dmy(p.joined_on), true)}${item('Experience', exp)}${item('Date of Birth', dmy(p.date_of_birth), true)}${item('Gender', gender)}
        ${item('Contact (Primary)', p.phone, true)}${item('Email Address', p.email, true)}${item('Emergency Contact', p.emergency_contact_name)}${item('Emergency Phone', p.emergency_contact_phone, true)}
      </div>
      ${s(p.address) ? `<div class="address"><span class="data-label">Address</span> ${esc(p.address)}</div>` : ''}
    </div>
  </div>
  <div class="stats-bar">${cards}</div>
  <div class="content-split">
    <div class="section">
      <h3 class="section-title">Academic Responsibilities</h3>
      <p class="lead">Primary role: <strong>${L.class_teacher_of.length ? 'Class Teacher for ' + L.class_teacher_of.map((c) => esc(c.class + ' ' + c.section)).join(', ') : 'Subject teacher'}</strong></p>
      ${classes}
      <h3 class="section-title" style="margin-top:32px">Duties &amp; Co-Curricular</h3>
      ${duties}
    </div>
    <div class="section">
      <h3 class="section-title">Performance Analytics</h3>
      <div class="chart-container"><div class="chart-header"><span>Avg % by subject</span><span>Published exams</span></div>${bars}</div>
      <div class="chart-container"><div class="chart-header"><span>Trend across exams</span></div>${trend}</div>
      <div class="chart-container" style="margin-bottom:0"><div class="chart-header"><span>Average by class</span></div>${sections}</div>
    </div>
  </div>
  <div class="signature-row">
    <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Head of Department</div></div>
    <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Principal</div></div>
    <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Staff Signature</div></div>
  </div>
</div></div>`
  return { html, css: SCOPED }
}

const CSS = `
:root { --bg-page: #f6f8fa; --bg-card: #ffffff; --text-primary: #000000; --text-secondary: #666666; --text-tertiary: #888888; --border-subtle: #eaeaea; --accent-neon: #00e599; --accent-blue: #0070f3; --accent-red: #e00; --font-sans: 'Inter', -apple-system, sans-serif; --font-mono: 'JetBrains Mono', monospace; }
@page { size: A4; margin: 10mm; }
* { box-sizing: border-box; }
body { font-family: var(--font-sans); background: #fff; color: var(--text-primary); margin: 0; padding: 0; line-height: 1.5; -webkit-font-smoothing: antialiased; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.dashboard-container { max-width: 1100px; margin: 0 auto; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; overflow: hidden; }
.dash-header { display: flex; justify-content: space-between; align-items: flex-end; padding: 24px 32px; border-bottom: 1px solid var(--border-subtle); background: #fafafa; }
.school-brand { display: flex; align-items: center; gap: 16px; }
.logo-box { width: 48px; height: 48px; border-radius: 50%; border: 1px solid var(--border-subtle); background: #fff; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: var(--text-tertiary); overflow: hidden; }
.logo-box img { width: 100%; height: 100%; object-fit: contain; }
.school-brand h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
.school-brand p { margin: 0; font-size: 13px; color: var(--text-secondary); }
.meta-info { text-align: right; } .meta-info .title { font-size: 18px; font-weight: 600; margin: 0 0 4px; } .meta-info .timestamp { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
.profile-section { padding: 32px; border-bottom: 1px solid var(--border-subtle); display: flex; gap: 32px; }
.avatar-container { width: 120px; height: 120px; background: var(--bg-page); border: 1px solid var(--border-subtle); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--text-tertiary); font-size: 12px; position: relative; flex-shrink: 0; }
.avatar-container img { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; }
.status-dot { position: absolute; bottom: -4px; right: -4px; width: 14px; height: 14px; background: var(--accent-neon); border: 2px solid #fff; border-radius: 50%; } .status-dot.off { background: var(--text-tertiary); }
.profile-details { flex: 1; } .profile-header { margin-bottom: 16px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.profile-header h2 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
.badge-mono { font-family: var(--font-mono); font-size: 11px; background: var(--bg-page); border: 1px solid var(--border-subtle); padding: 2px 8px; border-radius: 4px; color: var(--text-secondary); }
.badge-mono.ok { color: #00a86b; border-color: var(--accent-neon); }
.data-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px 24px; }
.data-item { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.data-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); font-weight: 600; }
.data-value { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; } .data-value.mono { font-family: var(--font-mono); } .data-value.empty { color: #b0b0b0; font-weight: 400; font-style: italic; }
.address { margin-top: 14px; font-size: 13px; }
.stats-bar { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--border-subtle); background: #fafafa; }
.stat-card { padding: 20px 24px; border-right: 1px solid var(--border-subtle); border-bottom: 1px solid var(--border-subtle); }
.stat-card:nth-child(4n) { border-right: none; } .stat-card:nth-last-child(-n+4) { border-bottom: none; }
.stat-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; margin-bottom: 8px; }
.stat-number { font-family: var(--font-mono); font-size: 28px; font-weight: 700; line-height: 1; display: flex; align-items: baseline; gap: 4px; }
.stat-unit { font-size: 14px; color: var(--text-secondary); font-weight: 400; }
.stat-trend { margin-top: 8px; font-size: 12px; } .trend-up { color: #00a86b; font-weight: 600; } .trend-down { color: var(--accent-red); font-weight: 600; } .trend-neutral { color: var(--text-secondary); }
.content-split { display: grid; grid-template-columns: 3fr 2fr; }
.section { padding: 32px; border-right: 1px solid var(--border-subtle); } .section:last-child { border-right: none; }
.section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 20px; display: flex; align-items: center; gap: 8px; }
.section-title::before { content: ''; display: inline-block; width: 8px; height: 8px; background: var(--text-primary); border-radius: 50%; }
.lead { font-size: 13px; color: var(--text-secondary); margin: 0 0 16px; } .muted { font-size: 12.5px; color: var(--text-tertiary); font-style: italic; margin: 0 0 16px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
th, td { padding: 12px 8px; border-bottom: 1px solid var(--border-subtle); text-align: left; } td:first-child, th:first-child { padding-left: 0; } td:last-child, th:last-child { padding-right: 0; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); font-weight: 600; }
.td-mono { font-family: var(--font-mono); } .text-right { text-align: right; } .text-center { text-align: center; }
.progress-cell { display: flex; align-items: center; gap: 8px; } .progress-track-mini { flex: 1; height: 4px; background: var(--border-subtle); border-radius: 2px; overflow: hidden; } .progress-fill-mini { height: 100%; background: var(--text-primary); }
.chart-container { margin-bottom: 32px; } .chart-header { font-size: 11px; color: var(--text-secondary); margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; display: flex; justify-content: space-between; }
.bar-chart { display: flex; align-items: flex-end; gap: 16px; height: 120px; padding-bottom: 24px; border-bottom: 1px solid var(--border-subtle); position: relative; margin-top: 20px; }
.bar-col { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
.bar { width: 100%; background: var(--text-primary); border-radius: 2px 2px 0 0; position: relative; }
.bar-val { position: absolute; top: -20px; width: 100%; text-align: center; font-family: var(--font-mono); font-size: 11px; font-weight: 600; }
.bar-label { position: absolute; bottom: -24px; font-size: 11px; color: var(--text-secondary); text-align: center; width: 100%; white-space: nowrap; }
.hbar-row { margin-bottom: 12px; } .hbar-label { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; } .hbar-label .val { font-family: var(--font-mono); font-weight: 600; }
.hbar-track { width: 100%; height: 6px; background: var(--border-subtle); border-radius: 3px; overflow: hidden; } .hbar-fill { height: 100%; background: var(--accent-neon); }
.signature-row { display: flex; justify-content: space-between; padding: 32px; background: #fafafa; border-top: 1px solid var(--border-subtle); page-break-inside: avoid; }
.sig-block { width: 220px; } .sig-line { border-top: 1px dashed var(--text-tertiary); margin: 28px 0 8px; } .sig-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); font-weight: 600; text-align: center; }
@media print { .dashboard-container { border: none; border-radius: 0; } tr { page-break-inside: avoid; } }
`

/* The viewer puts this CSS in the app's own page, not a frame, so every
   rule is scoped to .so-doc: an unscoped "table" or "body" here restyled the
   whole app while the report was open. */
function scope(css: string): string {
  const imports = css.match(/@import[^;]+;/g)?.join('\n') ?? ''
  const body = css.replace(/@import[^;]+;/g, '')
    .replace(/:root\s*\{/g, '.so-doc {')
    .replace(/(^|[{}])\s*([^{}@]+?)\s*\{/g, (_m, pre: string, sel: string) => {
      const scoped = sel.split(',').map((x) => x.trim())
        .map((x) => (x === '.so-doc' ? x : x === 'body' ? '.so-doc' : x === '*' ? '.so-doc *' : '.so-doc ' + x)).join(', ')
      return `${pre} ${scoped} {`
    })
  return imports + '\n' + body
}
const SCOPED = scope(CSS) + '\n.so-doc { width: 1000px; }\n@media print { .so-doc { width: auto; } }\n'
