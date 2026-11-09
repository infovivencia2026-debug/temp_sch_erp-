import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useShortcuts, removeFromDashboard } from '@/lib/shortcuts'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { Select } from '@/components/ui'
import { useActiveRole, useCatalog } from '@/lib/catalog'
import { useCan, useSession } from '@/lib/session'
import SetupProgress from './SetupProgress'
import './home-exact.css'

/* THE ADMINISTRATOR'S HOME, EXACTLY AS THE OWNER DREW IT (2026-11-09,
   Desktop/Yajur Dashboard Redesign.html): the banner on the cyan-blue-violet
   grain with today's four figures, the overview cards, what needs doing beside
   the figures waiting on a decision and the day's common jobs, the stats, the
   30-day attendance line and setup. Every number is the school's own. */

interface Item { key: string; severity: 'critical' | 'warning' | 'info'; headline: string; detail?: string; action: string; href?: string }
interface Summary { label: string; value: string; hint?: string }
interface Attention { greeting: string; items: Item[]; summary: Summary[] }
interface Kpis {
  students: number; sections: number; staff: number; staff_teaching: number; staff_non_teaching: number
  attendance_today_pct: number | null; attendance_range_pct: number | null; collected_paise: number; outstanding_paise: number
  pending_leave: number; defaulters: number; open_applications: number; unassigned_subjects: number
}
interface Trend { date: string; pct: number }
interface Stats { fees: { month: string; rupees: number }[]; classes: { name: string; percent: number }[]; stages: { name: string; students: number }[] }

const RANGES: [string, string][] = [['today', 'Today'], ['this_week', 'This week'], ['this_month', 'This month'], ['this_year', 'Year']]
const rupees = (paise: number) => {
  const r = (paise || 0) / 100
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`
  return '₹' + Math.round(r).toLocaleString('en-IN')
}
const lakh = (r: number) => (r >= 1e5 ? `${(r / 1e5).toFixed(1)}` : r >= 1e3 ? `${(r / 1e5).toFixed(2)}` : '0')
const mon = (m: string) => new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short' })

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />
}
const I = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  staff: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M14 9h4M14 13h4M6 17h7"/>',
  check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  rupee: '<path d="M6 3h12M6 8h12M14 21L6 13h3a5 5 0 0 0 0-10"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 7v5l3 3"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15h6"/>',
  pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
}
const itemIcon = (key: string) => (/fee|due|dues/.test(key) ? I.clock : /attendance/.test(key) ? I.check : /report/.test(key) ? I.doc : /mark|exam/.test(key) ? I.pen : I.doc)

export default function HomeExact() {
  const navigate = useNavigate()
  const role = useActiveRole()
  const catalog = useCatalog()
  const canMoney = useCan()('finance.fees.read')
  const school = (useSession().institution?.name ?? '').replace(/\s+(public\s+)?school$/i, '') || 'school'
  const [range, setRange] = useState('this_month')
  const [filter, setFilter] = useState<'all' | 'high' | 'mid'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; t: string } | null>(null)
  const [grown, setGrown] = useState(false)
  useEffect(() => { const t = setTimeout(() => setGrown(true), 150); return () => clearTimeout(t) }, [])

  const att = useQuery({ queryKey: ['attention'], queryFn: () => api.get<Attention>('/api/v1/attention'), staleTime: 120_000, refetchOnWindowFocus: true })
  /* Kept from the old home: remind the class teachers about unmarked registers. */
  const canChase = useCan()('academics.attendance.read.all')
  const [nudged, setNudged] = useState('')
  const nudge = useMutation({
    mutationFn: () => api.post<{ sections: number; notified: number; sections_without_a_class_teacher: string[] }>('/api/v1/attendance/nudge', {}),
    onSuccess: (r) => {
      const un = r.sections_without_a_class_teacher
      setNudged(`${r.notified} ${r.notified === 1 ? 'teacher' : 'teachers'} reminded about ${r.sections} unmarked ${r.sections === 1 ? 'register' : 'registers'}.` +
        (un.length ? ` ${un.join(', ')} ${un.length === 1 ? 'has' : 'have'} no class teacher, so nobody could be told.` : ''))
    },
  })
  /* Kept from the old home: the screens somebody pinned to the dashboard. */
  const dashKeys = useShortcuts()
  const shortcuts = useMemo(() => {
    const byKey = new Map<string, { key: string; name: string; href: string }>()
    for (const r of catalog.roles) for (const sec of r.sections) for (const f of sec.features) {
      if (f.in_scope && f.live) byKey.set(f.key, { key: f.key, name: f.name, href: `/${r.key}/${sec.slug}/${f.slug}` })
    }
    return dashKeys.map((k) => byKey.get(k)).filter((x): x is NonNullable<typeof x> => !!x)
  }, [dashKeys, catalog])
  const kq = useQuery({ queryKey: ['principal-dashboard', 'period=' + range], queryFn: () => api.get<Kpis>('/api/v1/principal/dashboard?period=' + range) })
  const tq = useQuery({ queryKey: ['attendance-trend'], queryFn: () => api.get<{ items: Trend[] }>('/api/v1/principal/attendance-trend') })
  const [statMonth, setStatMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const monthChoices = Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); return d.toISOString().slice(0, 7) })
  const sq = useQuery({ queryKey: ['home-stats', statMonth], queryFn: () => api.get<Stats>('/api/v1/home/stats?month=' + statMonth), staleTime: 5 * 60_000 })

  function hrefFor(target?: string) {
    if (!target) return null
    const search = (r: typeof role) => {
      if (!r) return null
      for (const want of target.split(/\s+/).filter(Boolean)) for (const s of r.sections) for (const f of s.features) {
        if (f.live && f.in_scope && `${s.slug} ${f.slug}`.includes(want)) return `/${r.key}/${s.slug}/${f.slug}`
      }
      return null
    }
    const here = search(role); if (here) return here
    for (const o of catalog.roles) { if (o.key !== role?.key) { const t = search(o); if (t) return t } }
    return null
  }
  const go = (t?: string) => { const h = t?.startsWith('/') ? t : hrefFor(t); if (h) navigate(h) }

  const items = att.data?.items ?? []
  const sev = (i: Item) => (i.severity === 'critical' ? 'high' : i.severity === 'warning' ? 'mid' : 'low')
  const shown = items.filter((i) => filter === 'all' || sev(i) === filter)
  const summary = att.data?.summary ?? []
  const k = kq.data
  const trend = tq.data?.items ?? []
  const stats = sq.data

  const quick = [['Add student', 'student_admission admissions students', '＋'], ['Collect fee', 'fee_collection collect', '₹'], ['Send notice', 'circulars notices', '✉'], ['Mark attendance', 'student_absentees attendance', '✓']]
    .map(([label, t, ic]) => ({ label, href: hrefFor(t), ic })).filter((q) => q.href)

  // the 30-day line
  const W = 800, H = 240, P = 24
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, trend.length - 1)
  const y = (n: number) => H - P - (n / 100) * (H - 2 * P)
  const pts = trend.map((t, i) => [x(i), y(t.pct)] as const)
  let line = pts.length ? `M${pts[0][0]},${pts[0][1]}` : ''
  for (let i = 1; i < pts.length; i++) { const [a, b] = pts[i - 1], [c, e] = pts[i], m = (a + c) / 2; line += ` C${m},${b} ${m},${e} ${c},${e}` }

  const fmax = Math.max(1, ...(stats?.fees ?? []).map((f) => f.rupees))
  const total = (stats?.stages ?? []).reduce((a, s) => a + s.students, 0)

  return (
    <div className="hx">
      {/* HERO */}
      <section className="hx-hero">
        <div className="hx-blob b1" /><div className="hx-blob b2" /><div className="hx-blob b3" />
        <div className="hx-grain" />
        <div className="hx-hero-top">
          <div>
            <h1>Today at {school}</h1>
            <p className="lead">
              {items.length ? `${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} you today.` : 'Nothing needs you right now.'}
              {k?.attendance_range_pct != null && <> Attendance is <b>{Math.round(k.attendance_range_pct)}%</b> this month</>}
              {canMoney && k && <> and <b>{rupees(k.collected_paise)}</b> has been banked.</>}
            </p>
          </div>
          {k && <span className="hx-pill">School running · {k.students} students</span>}
        </div>
        <div className="hx-today">
          {summary.slice(0, 4).map((s) => (
            <div className="hx-chip" key={s.label}><div className="k">{s.label}</div><div className="v">{s.value}</div><div className="s">{s.hint || 'today'}</div></div>
          ))}
        </div>
      </section>

      {/* OVERVIEW */}
      <div className="hx-head">
        <h2>Overview</h2>
        <div className="hx-seg">{RANGES.map(([v, l]) => <button key={v} type="button" className={range === v ? 'on' : ''} onClick={() => setRange(v)}>{l}</button>)}</div>
      </div>
      <section className="hx-kpis">
        <div className="hx-kpi" onClick={() => go('student_360 students')}>
          <div className="top"><span className="lbl">Students</span><span className="ic" style={{ background: '#eef0ff', color: '#4f46e5' }}><Icon d={I.users} /></span></div>
          <div className="num">{k?.students ?? '–'}</div>
          <div className="meta">{k?.sections ?? 0} sections</div>
          <div className="bar"><span style={{ width: grown ? '81%' : 0 }} /></div>
        </div>
        <div className="hx-kpi" onClick={() => go('staff_360 staff')}>
          <div className="top"><span className="lbl">Staff</span><span className="ic" style={{ background: '#e9f8fd', color: '#0891b2' }}><Icon d={I.staff} /></span></div>
          <div className="num">{k?.staff ?? '–'}</div>
          <div className="meta">{k?.staff_teaching ?? 0} teaching · {k?.staff_non_teaching ?? 0} non-teaching</div>
          <div className="bar"><span style={{ width: grown && k?.staff ? `${Math.round((k.staff_teaching / k.staff) * 100)}%` : 0 }} /></div>
        </div>
        <div className="hx-kpi" onClick={() => go('student_absentees attendance')}>
          <div className="top"><span className="lbl">Attendance</span><span className="ic" style={{ background: '#ecfdf3', color: '#16a34a' }}><Icon d={I.check} /></span></div>
          <div className="num">{k?.attendance_range_pct != null ? `${Math.round(k.attendance_range_pct)}%` : '–'}</div>
          <div className="meta">{k?.attendance_today_pct != null ? `Today ${Math.round(k.attendance_today_pct)}%` : 'Today not marked yet'}</div>
          <svg className="spark" viewBox="0 0 120 34" preserveAspectRatio="none"><path d={trend.slice(-9).map((t, i, a) => `${i ? 'L' : 'M'}${(i * 120) / Math.max(1, a.length - 1)} ${32 - (t.pct / 100) * 30}`).join(' ')} fill="none" stroke="#16a34a" strokeWidth="2.2" strokeLinecap="round" /></svg>
        </div>
        {canMoney && (
          <div className="hx-kpi" onClick={() => go('fee_collection collect')}>
            <div className="top"><span className="lbl">Fees banked</span><span className="ic" style={{ background: '#fff7e6', color: '#d97706' }}><Icon d={I.rupee} /></span></div>
            <div className="num">{k ? rupees(k.collected_paise) : '–'}</div>
            <div className="meta">{k && <><span style={{ color: 'var(--hx-red)', fontWeight: 700 }}>{rupees(k.outstanding_paise)}</span> still unpaid</>}</div>
            <div className="bar"><span style={{ width: grown && k ? `${Math.min(100, Math.round((k.collected_paise / Math.max(1, k.collected_paise + k.outstanding_paise)) * 100))}%` : 0 }} /></div>
          </div>
        )}
      </section>

      {/* NEEDS ATTENTION + side */}
      <section className="hx-grid2">
        <div className="hx-panel">
          <div className="hx-head">
            <h2>Needs your attention {shown.length > 0 && <span className="hx-count">{shown.length}</span>}</h2>
            <div className="hx-seg">{([['all', 'All'], ['high', 'Urgent'], ['mid', 'Soon']] as const).map(([v, l]) => <button key={v} type="button" className={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>{l}</button>)}</div>
          </div>
          {nudged && <p className="hx-done">{nudged}</p>}
          <div className="hx-list">
            {shown.map((i) => (
              <div key={i.key} className={`hx-item sev-${sev(i)} ${open === i.key ? 'open' : ''}`} onClick={() => setOpen(open === i.key ? null : i.key)}>
                <span className="ic"><Icon d={itemIcon(i.key)} /></span>
                <div className="min"><h3>{i.headline}{sev(i) === 'high' && <span className="pill">Urgent</span>}</h3>{i.detail && <p>{i.detail}</p>}</div>
                {i.key === 'attendance.unmarked' && canChase
                  ? <button type="button" className="go" disabled={nudge.isPending || nudge.isSuccess} onClick={(e) => { e.stopPropagation(); nudge.mutate() }}>
                      {nudge.isPending ? 'Reminding…' : nudge.isSuccess ? 'Reminded ✓' : 'Remind the class teachers →'}</button>
                  : i.href && <button type="button" className="go" onClick={(e) => { e.stopPropagation(); go(i.href) }}>{i.action} →</button>}
                {i.detail && <div className="more">{i.detail}</div>}
              </div>
            ))}
            {shown.length === 0 && <div className="hx-empty">Nothing here. You're all caught up.</div>}
          </div>
          {shown.length > 0 && <p className="hx-note">Tip: click a card to see the details · hover to act</p>}
        </div>
        <div className="hx-side">
          <div className="hx-panel">
            <h2 className="h">At a glance</h2>
            <div className="hx-mini">
              <div className="m" onClick={() => go('leave')}><div className="k">Leave requests</div><div className="v">{k?.pending_leave ?? 0}</div><div className="s">waiting approval</div></div>
              <div className="m" onClick={() => go('applications')}><div className="k">Applications</div><div className="v">{k?.open_applications ?? 0}</div><div className="s">open</div></div>
              <div className="m" onClick={() => go('timetable')}><div className="k">Unassigned subjects</div><div className="v" style={{ color: 'var(--hx-amber)' }}>{k?.unassigned_subjects ?? 0}</div><div className="s">no teacher</div></div>
              {canMoney && <div className="m" onClick={() => go('defaulters dues')}><div className="k">Fee defaulters</div><div className="v" style={{ color: 'var(--hx-red)' }}>{k?.defaulters ?? 0}</div><div className="s">past due</div></div>}
            </div>
          </div>
          {quick.length > 0 && (
            <div className="hx-panel">
              <h2 className="h">Quick actions</h2>
              <div className="hx-actions">{quick.map((q) => <button key={q.label} type="button" className="qa" onClick={() => navigate(q.href!)}><span className="ic">{q.ic}</span>{q.label}</button>)}</div>
            </div>
          )}
        </div>
      </section>

      {shortcuts.length > 0 && (
        <section>
          <div className="hx-head"><h2>Your shortcuts</h2></div>
          <div className="hx-shortcuts">
            {shortcuts.map((sc) => (
              <span key={sc.key} className="sc">
                <button type="button" onClick={() => navigate(sc.href)}>{sc.name}</button>
                <button type="button" className="x" aria-label={`Take ${sc.name} off the dashboard`} title="Take off the dashboard" onClick={() => removeFromDashboard(sc.key)}>×</button>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* STATS */}
      {stats && (<>
        <div className="hx-head"><h2>Stats</h2>
          <div style={{ minWidth: 180 }}><Select value={statMonth} onChange={setStatMonth} options={monthChoices.map((m) => ({ value: m, label: new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) }))} /></div>
        </div>
        <section className="hx-stats">
          {canMoney && (
            <div className="hx-panel">
              <div className="hx-head"><h2 className="h">Fees collected by month</h2><span className="unit">₹ lakh</span></div>
              <div className="hx-bars">{stats.fees.map((f) => (
                <div className="c" key={f.month} title={`${mon(f.month)}: ${rupees(f.rupees * 100)}`}><b>{lakh(f.rupees)}</b><i style={{ height: grown ? `${Math.max(2, (f.rupees / fmax) * 100)}%` : 0 }} /><span>{mon(f.month)}</span></div>
              ))}</div>
            </div>
          )}
          <div className="hx-panel">
            <h2 className="h">Attendance by class, {mon(statMonth)}</h2>
            <div className="hx-hb">
              {stats.classes.length === 0 && <p className="hx-note" style={{ textAlign: 'left' }}>No attendance marked in {mon(statMonth)}.</p>}
              {stats.classes.map((c) => <div className="r" key={c.name}><span>{c.name}</span><div className="t"><i style={{ width: grown ? `${c.percent}%` : 0 }} /></div><b>{c.percent}%</b></div>)}
            </div>
          </div>
          <div className="hx-panel">
            <h2 className="h">Students by stage</h2>
            <table className="hx-tbl"><tbody>
              {stats.stages.map((s) => <tr key={s.name}><td>{s.name}</td><td className="sh">{total ? Math.round((s.students / total) * 100) : 0}%</td><td>{s.students}</td></tr>)}
              <tr><td>Total</td><td className="sh" /><td>{total}</td></tr>
            </tbody></table>
          </div>
        </section>
      </>)}

      {/* 30 DAYS */}
      <section className="hx-panel">
        <div className="hx-head"><h2>Attendance, last 30 days</h2></div>
        <div className="hx-chart">
          {trend.length === 0 ? <p className="hx-note">No attendance recorded in the last 30 days.</p> : (
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseLeave={() => setTip(null)}>
              <defs>
                <linearGradient id="hxg" x1="0" x2="1"><stop offset="0" stopColor="#5fd3f3" /><stop offset=".5" stopColor="#4f7cf7" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient>
                <linearGradient id="hxf" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#4f7cf7" stopOpacity=".22" /><stop offset="1" stopColor="#8b5cf6" stopOpacity="0" /></linearGradient>
              </defs>
              {[25, 50, 75, 100].map((n) => <g key={n}><line x1={P} x2={W - P} y1={y(n)} y2={y(n)} stroke="#eef1f7" /><text x="2" y={y(n) + 4} fontSize="10" fill="#94a3b8">{n}</text></g>)}
              <line x1={P} x2={W - P} y1={y(90)} y2={y(90)} stroke="#cbd2e1" strokeDasharray="5 5" />
              <path d={`${line} L${x(trend.length - 1)},${H - P} L${P},${H - P}Z`} fill="url(#hxf)" />
              <path d={line} fill="none" stroke="url(#hxg)" strokeWidth="3.5" strokeLinecap="round" />
              {pts.map(([a, b], i) => (
                <circle key={i} cx={a} cy={b} r={5} fill="#fff" stroke="#4f7cf7" strokeWidth="2.5" style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setTip({ x: a / W, y: b / H, t: `${new Date(trend[i].date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · ${Math.round(trend[i].pct)}% present` })} />
              ))}
            </svg>
          )}
          {tip && <div className="hx-tip" style={{ left: `${tip.x * 100}%`, top: `${tip.y * 100}%` }}>{tip.t}</div>}
        </div>
        <div className="hx-legend"><span><i style={{ background: 'linear-gradient(90deg,#5fd3f3,#8b5cf6)' }} />Present %</span><span><i style={{ background: '#e8ecf4' }} />Target 90%</span></div>
      </section>

      <SetupProgress />
    </div>
  )
}
