import { useMemo, useState } from 'react'
import {
  ArrowRight, Bell, BookOpen, Bus, CalendarDays, ChevronRight, Clock, Library,
  ShieldCheck, Users, Wallet,
} from 'lucide-react'
import { Link, useNavigate } from '@/lib/nav'
import { useApp } from '@/hooks/useAppState'
import { useCountUpText } from '@/hooks/useCountUp'
import { useContextDrawer, EduChip } from '@/components/layout/eduos'
import { Sparkline, Bullet, DotPlot } from '@/components/viz'
import { cx, TODAY } from '@/lib/utils'
import type { LayoutProps } from './types'

/* ---------------------------------------------------------------------------
   UI-16 · CAMPUS INTELLIGENCE OS — the dashboard.

   An asymmetric bento rather than a row of identical KPI cards. The page tells
   the institution's operating story: how it is running right now (hero), then
   the two flows that matter hourly (academics, money), then momentum, then
   people and place, then what needs a decision.

   Every figure is a way into the module that owns it. Nothing here duplicates
   business logic — the registry still owns every feature.
   --------------------------------------------------------------------------- */

function Figure({ value, className }: { value: string; className?: string }) {
  return <span className={cx('tabular-nums', className)}>{useCountUpText(value)}</span>
}

function More({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="edu-more text-[12px] font-medium">
      {children} <ArrowRight className="h-3 w-3" />
    </Link>
  )
}

function Panel({ title, action, className, children }: {
  title: string; action?: React.ReactNode; className?: string; children: React.ReactNode
}) {
  return (
    <section className={cx('edu-panel', className)}>
      <header className="mb-4 flex items-center gap-3">
        <h2 className="edu-hero-label" style={{ color: 'hsl(var(--muted-foreground))' }}>{title}</h2>
        {action && <span className="ml-auto">{action}</span>}
      </header>
      {children}
    </section>
  )
}

/** A statistic that reveals a drill-down cue on hover, without moving. */
function Metric({ label, value, sub, to, big }: {
  label: string; value: string; sub?: string; to: string; big?: boolean
}) {
  return (
    <Link to={to} className="edu-metric block min-w-0">
      <span className="edu-metric-label block truncate text-[10.5px] font-semibold uppercase tracking-[0.1em] muted">
        {label}
      </span>
      <span className={cx('mt-1.5 block font-semibold leading-none', big ? 'text-[34px]' : 'text-[22px]')}>
        <Figure value={value} />
      </span>
      <span className="mt-1.5 flex items-baseline gap-2 text-[11.5px] muted">
        {sub}
        <span className="edu-metric-cue ml-auto whitespace-nowrap">View →</span>
      </span>
    </Link>
  )
}

/* ---------------------------------------------------------------------------
   Wording per vertical. The layout, the interactions and the hierarchy are
   identical everywhere; only the nouns change, and every figure still comes
   from that industry's own dashboard config.
   --------------------------------------------------------------------------- */
const WORDS: Record<string, {
  org: string; pulse: string; flow: string; pipeline: string; people: string;
  place: string; supply: string; unit: string; unitPlural: string
  chips: string[]; now: [string, string]
}> = {
  education: { org: 'Institution', pulse: 'Institution Pulse', flow: 'Academic flow', pipeline: 'Admissions momentum', people: 'People', place: 'Campus operations', supply: 'Procurement flow', unit: 'class', unitPlural: 'Classes', chips: ['Academic day 42 / 196', 'Semester week 7', '3 events today', 'Next holiday · 15 Aug'], now: ['10:30 Period 3', '11:15 Period 4'] },
  construction: { org: 'Programme', pulse: 'Programme Pulse', flow: 'Site flow', pipeline: 'Tender momentum', people: 'Workforce', place: 'Site operations', supply: 'Procurement flow', unit: 'activity', unitPlural: 'Activities', chips: ['Programme week 32', '6 sites live', '2 pours today', 'Monsoon protocol active'], now: ['10:30 Shift 1', '14:00 Shift 2'] },
  logistics: { org: 'Network', pulse: 'Network Pulse', flow: 'Movement flow', pipeline: 'Booking momentum', people: 'Workforce', place: 'Hub operations', supply: 'Procurement flow', unit: 'trip', unitPlural: 'Trips', chips: ['Week 32', '6 hubs live', '1,284 in transit', 'Peak season'], now: ['10:30 Morning wave', '16:00 Evening wave'] },
  healthcare: { org: 'Hospital', pulse: 'Clinical Pulse', flow: 'Clinical flow', pipeline: 'Claims momentum', people: 'People', place: 'Facility operations', supply: 'Supply flow', unit: 'clinic', unitPlural: 'Clinics', chips: ['6 facilities', '842 beds', '4 theatres running', 'NABH audit · 12 Aug'], now: ['10:30 Morning OPD', '16:00 Evening OPD'] },
  manufacturing: { org: 'Plant', pulse: 'Plant Pulse', flow: 'Production flow', pipeline: 'Order momentum', people: 'Workforce', place: 'Plant operations', supply: 'Procurement flow', unit: 'line', unitPlural: 'Lines', chips: ['Week 32', '6 plants', '42 lines running', 'IATF audit · 26 Aug'], now: ['10:30 Shift A', '14:30 Shift B'] },
}
const wordsFor = (id: string) => WORDS[id] ?? WORDS.education

/* ------------------------------------------ AREA 2 · Institution Pulse --- */

function ActivityCurve() {
  // One normalised institutional activity curve — attendance, classes,
  // collections and admissions folded into a single operating signal.
  const pts = useMemo(() => {
    const vals = [38, 44, 41, 52, 61, 58, 69, 74, 71, 80, 86, 83, 90, 94]
    return vals.map((v, i) => [(i / (vals.length - 1)) * 100, 34 - (v / 100) * 28] as const)
  }, [])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')
  return (
    <svg viewBox="0 0 100 36" preserveAspectRatio="none" className="edu-curve h-16 w-full" aria-hidden>
      <defs>
        <linearGradient id="eduCurveFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.28" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="eduCurveLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--edu-cyan))" />
        </linearGradient>
      </defs>
      <path d={`${d} L100,36 L0,36 Z`} fill="url(#eduCurveFill)" />
      <path className="line" d={d} fill="none" stroke="url(#eduCurveLine)" strokeWidth="1.1"
        strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {pts.filter((_, i) => i % 4 === 0 || i === pts.length - 1).map((p, i) => (
        <circle key={i} className="node" cx={p[0]} cy={p[1]} r="0.9"
          fill="hsl(var(--edu-cyan))" style={{ animationDelay: `${1400 + i * 120}ms` }} />
      ))}
    </svg>
  )
}

function InstitutionPulse({ cfg, industryId }: { cfg: LayoutProps['cfg']; industryId: string }) {
  const nav = useNavigate()
  const [view, setView] = useState<'pulse' | 'attendance'>('pulse')
  const w = wordsFor(industryId)

  // The headline is the first percentage the industry reports — attendance in
  // a school, schedule adherence on a site, OEE in a plant.
  const lead = cfg.kpis.find((k) => k.value.includes('%')) ?? cfg.kpis[0]
  const cells = cfg.kpis.filter((k) => k !== lead).slice(0, 4).map((k) => ({
    label: k.label, value: k.value, sub: `${k.delta} vs last month`, to: k.to,
  }))
  const rings = cfg.ranking.rows.slice(0, 3)

  return (
    <section className="edu-hero p-6">
      <header className="relative flex flex-wrap items-center gap-3">
        <h2 className="edu-hero-label">{w.pulse}</h2>
        <span className="ml-auto flex items-center gap-2 text-[11px] edu-hero-muted">
          <span className="edu-live" aria-hidden /> Live ·{' '}
          {TODAY.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </header>

      {view === 'pulse' ? (
        <>
          <div className="relative mt-5 flex flex-wrap items-end gap-x-8 gap-y-3">
            <button onClick={() => setView('attendance')} className="text-left">
              <p className="edu-hero-value text-[clamp(2.75rem,5vw,3.75rem)] font-semibold leading-none">
                <Figure value={lead.value} />
              </p>
              <p className="mt-2 text-[13px] edu-hero-muted">
                Operating normally · {lead.label.toLowerCase()}
                <span className="ml-2 text-[hsl(var(--edu-teal))]">{lead.delta} from last period</span>
              </p>
            </button>
            <button onClick={() => setView('attendance')} className="edu-more ml-auto text-[12px]"
              style={{ color: 'rgb(255 255 255 / 0.6)' }}>
              Breakdown <ArrowRight className="h-3 w-3" />
            </button>
          </div>

          <div className="relative mt-6 grid gap-px border-t pt-5 edu-hero-rule sm:grid-cols-2 xl:grid-cols-4">
            {cells.map((c) => (
              <Link key={c.label} to={c.to} className="edu-hero-cell edu-metric px-3 py-2">
                <span className="edu-metric-label edu-hero-label block">{c.label}</span>
                <span className="edu-hero-value mt-1.5 block text-[26px] font-semibold leading-none">
                  <Figure value={c.value} />
                </span>
                <span className="mt-1 flex items-baseline gap-2 text-[11.5px] edu-hero-muted">
                  {c.sub}
                  <span className="edu-metric-cue ml-auto" style={{ color: 'hsl(var(--edu-cyan))' }}>Open →</span>
                </span>
              </Link>
            ))}
          </div>

          <div className="relative mt-5"><ActivityCurve /></div>

          <footer className="relative mt-4 flex items-center gap-3 border-t pt-4 edu-hero-rule">
            <span className="text-[12px] edu-hero-muted">
              <span className="font-semibold text-white">3 priority issues</span> need a decision today
            </span>
            <button onClick={() => nav('/workflows')} className="edu-more ml-auto text-[12px]"
              style={{ color: 'rgb(255 255 255 / 0.6)' }}>
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </footer>
        </>
      ) : (
        /* the hero morphs in place rather than navigating away */
        <div className="relative mt-5">
          <button onClick={() => setView('pulse')} className="edu-more mb-4 text-[12px]"
            style={{ color: 'rgb(255 255 255 / 0.6)' }}>
            <ChevronRight className="h-3 w-3 rotate-180" /> Back to pulse
          </button>
          <div className="grid gap-5 sm:grid-cols-3">
            {rings.map(({ name: k, value: v }) => [k, v] as const).map(([k, v]) => (
              <div key={k as string}>
                <p className="edu-hero-label">{k}</p>
                <p className="edu-hero-value mt-1.5 text-[32px] font-semibold leading-none">
                  <Figure value={`${v}%`} />
                </p>
                <span className="mt-3 block h-1.5 rounded-full" style={{ background: 'rgb(255 255 255 / 0.12)' }}>
                  <span className="block h-full rounded-full"
                    style={{ width: `${v}%`, background: 'hsl(var(--edu-teal))' }} />
                </span>
              </div>
            ))}
          </div>
          <div className="mt-6 border-t pt-4 edu-hero-rule">
            <button onClick={() => nav(cfg.primaryAction.to)} className="edu-btn-primary">
              {cfg.primaryAction.label}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------- AREA 4 · Admissions --- */

function AdmissionsMomentum({ cfg, industryId }: { cfg: LayoutProps['cfg']; industryId: string }) {
  const nav = useNavigate()
  const [hover, setHover] = useState<number | null>(null)
  const w = wordsFor(industryId)

  // The industry's own funnel, summed across the window it publishes.
  const FUNNEL = cfg.funnel.keys.map((k) => ({
    stage: k.label,
    value: cfg.funnel.data.reduce((a: number, row: any) => a + (row[k.key] ?? 0), 0),
  }))
  const to = cfg.recent.to

  return (
    <Panel title={w.pipeline} action={<More to={to}>{cfg.recent.action}</More>}>
      <div className="flex flex-col items-stretch gap-0 sm:flex-row">
        {FUNNEL.map((f, i) => {
          const conv = i === 0 ? null : (f.value / FUNNEL[i - 1].value) * 100
          return (
            <div key={f.stage} className="flex min-w-0 flex-1 items-center">
              <button
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onClick={() => nav(to)}
                className="edu-flow-node edu-metric min-w-0 flex-1 px-3 py-3 text-left"
              >
                <span className="edu-metric-label block truncate text-[10px] font-semibold uppercase tracking-[0.1em] muted">
                  {f.stage}
                </span>
                <span className="mt-1.5 block text-[24px] font-semibold leading-none">
                  <Figure value={f.value.toLocaleString('en-IN')} />
                </span>
                <span className="mt-1 block h-[13px] text-[11px] muted">
                  {hover === i && conv !== null ? `${conv.toFixed(1)}% of previous` : i === 0 ? 'this cycle' : `+8.2% YoY`}
                </span>
              </button>
              {i < FUNNEL.length - 1 && <span className="edu-flow-link h-px w-3 shrink-0 sm:w-5" />}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

/* ---------------------------------------------- AREA 6 · Procurement ---- */

const PROC = [
  ['Request', '42', '/purchasing'], ['RFQ', '12', '/sourcing'], ['PO', '28', '/purchasing'],
  ['GRN', '18', '/purchasing'], ['Invoice', '24', '/payables'], ['Payment', '9', '/payables'],
] as const

/* ------------------------------------------------------------- page ----- */

export function EducationOS({ cfg, d }: LayoutProps) {
  const app = useApp()
  const nav = useNavigate()
  const drawer = useContextDrawer()
  const [moneyRange, setMoneyRange] = useState('Today')
  const w = wordsFor(app.industryId)
  const money = cfg.kpis.find((k) => /collect|revenue|billed|cash/i.test(k.label)) ?? cfg.kpis[1]
  const rest = cfg.secondary

  // Four things happening right now, in this vertical's own words.
  const live: [string, string, string, string][] = useMemo(() => {
    const v = app.industry.vocab
    const people = ['Mr. Ravi', 'Dr. Kavitha', 'Mrs. Menon', 'Dr. Nair']
    return [0, 1, 2, 3].map((i) => [
      v.program[i % v.program.length],
      v.course[i % v.course.length],
      people[i],
      v.room[i % v.room.length],
    ])
  }, [app.industryId])

  const ICONS = [BookOpen, Bus, Library, Bell]
  const campus = rest.slice(-4).map((r, i) => ({
    label: r.label, value: r.value, to: cfg.recent.to, icon: ICONS[i],
  }))

  /* Today / Month / Term / Year read the same figure off different KPI slots,
   * and outside education those slots hold the same number — so the four
   * choices all showed ₹39.84 Cr and the control did nothing. The headline
   * figure is the year to date, and each shorter range is a proportion of it,
   * re-expressed in whatever unit suits the result. */
  const MONEY: Record<string, string> = useMemo(() => {
    const m = money.value.match(/^([^\d.]*)([\d.,]+)\s*(Cr|L|K)?$/i)
    if (!m) return { Today: money.value, Month: money.value, Term: money.value, Year: money.value }
    const [, symbol, digits, unit] = m
    const UNIT: Record<string, number> = { cr: 1e7, l: 1e5, k: 1e3 }
    const base = parseFloat(digits.replace(/,/g, '')) * (UNIT[(unit ?? '').toLowerCase()] ?? 1)
    const fmt = (n: number) => {
      if (n >= 1e7) return `${symbol}${(n / 1e7).toFixed(2)} Cr`
      if (n >= 1e5) return `${symbol}${(n / 1e5).toFixed(2)} L`
      if (n >= 1e3) return `${symbol}${(n / 1e3).toFixed(1)}K`
      return `${symbol}${Math.round(n)}`
    }
    // 220 working days, 11 collecting months, two terms in the year.
    return { Today: fmt(base / 220), Month: fmt(base / 11), Term: fmt(base / 2), Year: fmt(base) }
  }, [money.value])

  const openClass = (name: string, subject: string, teacher: string, room: string) => drawer.open({
    title: name,
    subtitle: `${subject} · ${teacher} · ${room}`,
    body: (
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[['Strength', '38'], ['Present', '36'], ['Attendance', '94.7%']].map(([k, v]) => (
            <div key={k} className="edu-sub p-3">
              <p className="text-[10.5px] uppercase tracking-wide muted">{k}</p>
              <p className="mt-1 text-[18px] font-semibold tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        <div>
          <p className="mb-2 text-[12px] font-semibold">Syllabus coverage</p>
          <Bullet value={72} target={80} max={100} label="Units completed" sub="72 / 80" />
        </div>
        <div>
          <p className="mb-2 text-[12px] font-semibold">Recent assessments</p>
          <DotPlot items={[{ name: 'Unit test 1', value: 78 }, { name: 'Unit test 2', value: 84 }, { name: 'Mid-term', value: 71 }]} max={100} />
        </div>
      </div>
    ),
    footer: (
      <div className="flex gap-2">
        <button onClick={() => { drawer.close(); nav('/attendance') }} className="edu-btn flex-1">Attendance</button>
        <button onClick={() => { drawer.close(); nav('/students') }} className="edu-btn-primary flex-1">Students</button>
      </div>
    ),
  })

  return (
    <div className="edu-workspace space-y-4 px-4 pb-8 pt-4 sm:px-5">
      {/* AREA 1 — greeting, deliberately small */}
      <header className="flex flex-wrap items-end gap-x-6 gap-y-2 px-1">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Good morning, Dr. Reddy.</h1>
          <p className="mt-0.5 text-[13px] muted">
            {app.institution} is operating normally today ·{' '}
            {TODAY.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {w.chips.map((c, i) => (
            <EduChip key={c} tone={i === 0 ? 'indigo' : i === w.chips.length - 1 ? 'amber' : 'slate'}>{c}</EduChip>
          ))}
        </div>
      </header>

      {/* AREA 2 — the hero */}
      <InstitutionPulse cfg={cfg} industryId={app.industryId} />

      {/* AREA 3 — academic flow + money flow */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
        <Panel title={w.flow} action={<More to={cfg.kpis[0].to}>{cfg.kpis[0].label}</More>}>
          {/* Stacked on a phone: side by side, the lead figure was pinned to the
              bottom-left with the three beside it and a dead corner above. */}
          <div className="flex flex-col items-start gap-x-8 gap-y-4 sm:flex-row sm:flex-wrap sm:items-end">
            <Metric label={cfg.kpis[0].label} value={cfg.kpis[0].value}
              sub={`${cfg.kpis[0].delta} vs last month`} to={cfg.kpis[0].to} big />
            <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-3">
              {cfg.kpis.slice(2, 5).map((k) => (
                <Metric key={k.label} label={k.label} value={k.value} to={k.to} />
              ))}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2 border-t pt-4 text-[11.5px] muted">
            <span className="font-semibold text-[hsl(var(--primary))]">NOW</span> {w.now[0]}
            <ChevronRight className="h-3 w-3 opacity-50" /> {w.now[1]}
          </div>
          <div className="mt-3 flex gap-2 scroll-x pb-2" role="group" aria-label="Classes running now">
            {live.map(([c, s, t, r]) => (
              <button key={c} onClick={() => openClass(c, s, t, r)}
                className="edu-flow-node edu-hover w-[190px] shrink-0 p-3 text-left">
                <span className="flex items-center gap-1.5">
                  <span className="edu-live" aria-hidden style={{ height: 5, width: 5 }} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider muted">Live</span>
                </span>
                <p className="mt-1.5 truncate text-[13px] font-medium">{c}</p>
                <p className="truncate text-[11.5px] muted">{s}</p>
                <p className="truncate text-[11px] muted">{t} · {r}</p>
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title="Money flow"
          action={
            <span className="flex gap-1">
              {['Today', 'Month', 'Term', 'Year'].map((r) => (
                <button key={r} onClick={() => setMoneyRange(r)}
                  className={cx('edu-tab rounded-md px-2 py-1 text-[11px]', moneyRange === r && 'is-active')}>
                  {r}
                </button>
              ))}
            </span>
          }
        >
          <Metric label={`${money.label} · ${moneyRange.toLowerCase()}`} value={MONEY[moneyRange]}
            sub={`${money.delta} vs last month`} to={money.to} big />
          <div className="mt-3"><Sparkline data={[22, 31, 28, 44, 52, 49, 63, 71, 68, 79, 86, 92]} w={420} h={54} /></div>
          <div className="mt-4 grid grid-cols-1 gap-4 border-t pt-4 sm:grid-cols-3">
            {rest.slice(1, 4).map((r) => (
              <Metric key={r.label} label={r.label} value={r.value} to={money.to} />
            ))}
          </div>
          <span className="edu-bar mt-3 block h-1.5"><span style={{ width: '68%' }} /></span>
        </Panel>
      </div>

      {/* AREA 4 — admissions momentum, full width */}
      <AdmissionsMomentum cfg={cfg} industryId={app.industryId} />

      {/* AREA 5 — people + campus + compliance */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={w.people} action={<More to="/hr">Workforce</More>}>
          <Metric label={rest[0].label} value={rest[0].value} sub={cfg.greeting} to="/hr" big />
          <div className="mt-4 grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2">
            {rest.slice(1, 5).map((r) => (
              <Metric key={r.label} label={r.label} value={r.value} to="/hr" />
            ))}
          </div>
        </Panel>

        <Panel title={w.place} action={<More to={cfg.recent.to}>{cfg.recent.action}</More>}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {campus.map((c) => (
              <Link key={c.label} to={c.to} className="edu-sub edu-metric edu-hover p-3">
                <span className="flex items-center gap-1.5">
                  <c.icon className="h-3.5 w-3.5 muted" />
                  <span className="edu-metric-label text-[10px] font-semibold uppercase tracking-wider muted">{c.label}</span>
                </span>
                <span className="mt-1.5 block text-[19px] font-semibold leading-none"><Figure value={c.value} /></span>
              </Link>
            ))}
          </div>
        </Panel>

        <Panel title="Compliance readiness" action={<More to="/accreditation">Accreditation</More>}>
          <div className="flex items-center gap-5">
            <ArcGauge value={86} />
            <div className="min-w-0 flex-1 space-y-2.5">
              {[['AISHE / UDISE', 82], ['NAAC / NBA', 74], ['Faculty records', 96]].map(([l, v]) => (
                <div key={l as string}>
                  <div className="flex items-baseline justify-between text-[11.5px]">
                    <span className="truncate muted">{l}</span>
                    <span className="tabular-nums">{v}%</span>
                  </div>
                  <span className="edu-bar mt-1 block h-1.5"><span style={{ width: `${v}%` }} /></span>
                </div>
              ))}
            </div>
          </div>
          <Link to="/accreditation" className="edu-attn sev-finance mt-4 flex items-center gap-2 p-2.5 text-[12px]">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" /> 3 statutory filings due · next 18 Aug
          </Link>
        </Panel>
      </div>

      {/* AREA 6 — procurement flow + needs attention */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,46fr)_minmax(0,54fr)]">
        <Panel title={w.supply} action={<More to={PROC[0][2]}>Purchasing</More>}>
          {/* Six stages across 342px is ~50px each. On a phone the chain reads
              as a two-column grid rather than a squeezed row. */}
          <div className="grid grid-cols-3 gap-y-3 sm:flex sm:items-stretch">
            {PROC.map(([label, value, to], i) => (
              <div key={label} className="flex min-w-0 flex-1 items-center">
                <Link to={to} className="edu-flow-node edu-metric min-w-0 flex-1 px-2 py-2.5 text-center">
                  <span className="edu-metric-label block truncate text-[9.5px] font-semibold uppercase tracking-wider muted">{label}</span>
                  <span className="mt-1 block text-[19px] font-semibold leading-none"><Figure value={value} /></span>
                </Link>
                {i < PROC.length - 1 && <span className="edu-flow-link hidden h-px w-2 shrink-0 sm:block" />}
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] muted">Committed ₹72L against a ₹1.05Cr budget this quarter.</p>
          <span className="edu-bar teal mt-2 block h-1.5"><span style={{ width: '69%' }} /></span>
        </Panel>

        <Panel title="Needs attention" action={<More to={cfg.recent.to}>Review all</More>}>
          <ul className="space-y-2">
            {cfg.alerts.slice(0, 4).map((a, i) => ([
              (['high', 'finance', 'academic', 'hr'] as const)[i],
              a.tone === 'red' ? 'HIGH' : a.tone === 'amber' ? 'WATCH' : 'INFO',
              a.title, cfg.recent.to, 'Review',
            ] as const)).map(([sev, tag, text, to, action]) => (
              <li key={text} className={cx('edu-attn flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 pr-3 sm:flex-nowrap', `sev-${sev}`)}>
                <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-wider muted sm:w-[62px]">{tag}</span>
                <span className="min-w-0 flex-1 basis-full truncate text-[12.5px] sm:basis-auto">{text}</span>
                <span className="edu-attn-actions ml-auto flex shrink-0 gap-1.5 sm:ml-0">
                  <Link to={to} className="edu-btn px-2.5 text-[11.5px]">{action}</Link>
                  <button className="edu-btn px-2.5 text-[11.5px]">Dismiss</button>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* AREA 7 — institutional activity */}
      <Panel title="Recent institutional activity" action={<More to="/security">Audit trail</More>}>
        <ol className="edu-tl space-y-0">
          {cfg.recent.rows.slice(0, 5).map((r, i) => ([
            ['10:42', '10:38', '10:31', '10:22', '10:14'][i], r.name, `${r.sub} · ${r.stage.toLowerCase()}`, cfg.recent.to,
          ] as const)).map(([t, subject, rest, to]) => (
            <li key={t} className="edu-tl-row relative flex items-center gap-3 py-2.5">
              <span className="w-11 shrink-0 text-[11.5px] tabular-nums muted">{t}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                <span className="edu-tl-subject font-medium transition-colors">{subject}</span>{' '}
                <span className="muted">{rest}</span>
              </span>
              <span className="edu-tl-actions flex shrink-0 gap-1.5">
                <Link to={to} className="edu-btn px-2.5 text-[11.5px]">Open</Link>
              </span>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  )
}

/** One primary arc — the spec is explicit that donuts should not be piled up. */
function ArcGauge({ value }: { value: number }) {
  const r = 46
  const circ = Math.PI * r
  return (
    <div className="relative shrink-0" style={{ width: 120, height: 78 }}>
      <svg width="120" height="78" viewBox="0 0 120 78">
        <path d="M12,62 A46,46 0 0 1 108,62" fill="none" stroke="hsl(var(--edu-track))" strokeWidth="10" strokeLinecap="round" />
        <path d="M12,62 A46,46 0 0 1 108,62" fill="none" stroke="hsl(var(--primary))" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ - (value / 100) * circ} />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <p className="text-[24px] font-semibold leading-none tabular-nums">{value}%</p>
        <p className="text-[9.5px] uppercase tracking-wider muted">Readiness</p>
      </div>
    </div>
  )
}
