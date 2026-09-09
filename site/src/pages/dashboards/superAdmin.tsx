import { useMemo } from 'react'
import {
  AlertTriangle, ArrowRight, Building2, GraduationCap, IndianRupee, Plug,
  ReceiptText, TrendingDown, TrendingUp, Wallet,
} from 'lucide-react'
import { Link, useNavigate } from '@/lib/nav'
import { useApp } from '@/hooks/useAppState'
import { hashStr, inrCompact, rng } from '@/lib/utils'

/* ===========================================================================
   SUPER ADMIN — DRILL DOWN, NOT AGGREGATE

   A group administrator's first question is not "how is the group doing" but
   "which campus needs me today". The aggregate view answered the first and
   made the second impossible: one attendance figure across six campuses hides
   the campus that is failing, because the other five average it away.

   So the page is a directory rather than a summary. The strip along the top
   carries the four totals worth knowing at a glance; everything below is one
   card per campus, and each card opens that campus's own dashboard scoped to
   it. The totals are there for context, not for decisions.
   =========================================================================== */

export interface CampusFigures {
  id: string
  name: string
  students: number
  collected: number
  outstanding: number
  /** Outstanding as a share of what was billed — the number that ranks them. */
  exposure: number
  trend: number
}

/** A campus slug that survives being put in a URL. */
export const campusSlug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * Figures per campus, derived from the campus name so they are stable across
 * reloads and consistent with the rest of the prototype's data.
 */
export function useCampusFigures(campuses: string[]): CampusFigures[] {
  return useMemo(() => campuses.map((name) => {
    const r = rng(hashStr(`campus:${name}`))
    const students = 280 + Math.floor(r() * 900)
    const perStudent = 78_000 + Math.floor(r() * 46_000)
    const billed = students * perStudent
    const collected = Math.floor(billed * (0.72 + r() * 0.24))
    const outstanding = billed - collected
    return {
      id: campusSlug(name),
      name,
      students,
      collected,
      outstanding,
      exposure: Math.round((outstanding / billed) * 1000) / 10,
      trend: Math.round((r() * 9 - 3) * 10) / 10,
    }
  }), [campuses.join('|')])
}

/* ------------------------------------------------------------------ card -- */

export function CampusCard({ campus, onOpen }: { campus: CampusFigures; onOpen: (c: CampusFigures) => void }) {
  // A campus carrying more than a fifth of its fees unpaid is the one to open
  // first, so the card says so rather than leaving it to be worked out.
  const pressed = campus.exposure >= 20
  const up = campus.trend >= 0

  return (
    <article className="group flex flex-col rounded-2xl border bg-[hsl(var(--card))] p-5 transition-shadow duration-300 hover:shadow-[0_18px_40px_-28px_hsl(var(--foreground)/0.45)]">
      <header className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]">
          <Building2 className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold leading-tight">{campus.name}</h3>
          <p className="mt-0.5 text-[12px] muted">
            {campus.students.toLocaleString('en-IN')} students
          </p>
        </div>
        {pressed && (
          <span className="shrink-0 rounded-full bg-[hsl(var(--destructive)/0.12)] px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-[hsl(var(--destructive))]">
            Watch
          </span>
        )}
      </header>

      <dl className="mt-5 grid grid-cols-2 gap-4 border-t pt-4">
        <div className="min-w-0">
          <dt className="text-[10.5px] font-semibold uppercase tracking-[0.1em] muted">Fee collected</dt>
          <dd className="mt-1 truncate text-[19px] font-semibold tabular-nums">{inrCompact(campus.collected)}</dd>
          <dd className={`mt-0.5 flex items-center gap-1 text-[11.5px] ${up ? 'text-[hsl(var(--success,142_71%_38%))]' : 'text-[hsl(var(--destructive))]'}`}>
            {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {up ? '+' : ''}{campus.trend}% vs last month
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10.5px] font-semibold uppercase tracking-[0.1em] muted">Outstanding</dt>
          <dd className="mt-1 truncate text-[19px] font-semibold tabular-nums">{inrCompact(campus.outstanding)}</dd>
          <dd className="mt-0.5 text-[11.5px] muted">{campus.exposure}% of billed</dd>
        </div>
      </dl>

      <button
        onClick={() => onOpen(campus)}
        className="mt-5 flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[hsl(var(--primary))] text-[13px] font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90"
      >
        View campus
        <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
      </button>
    </article>
  )
}

/* ------------------------------------------------------------- the page --- */

export function SuperAdminDashboard() {
  const app = useApp()
  const nav = useNavigate()
  const campuses = useCampusFigures(app.industry.scope.sites)

  const totals = useMemo(() => campuses.reduce((a, c) => ({
    students: a.students + c.students,
    collected: a.collected + c.collected,
    outstanding: a.outstanding + c.outstanding,
  }), { students: 0, collected: 0, outstanding: 0 }), [campuses])

  /* The campus with the most unpaid fees leads the list: a directory sorted
     alphabetically makes you read all six to find the one that needs you. */
  const ordered = useMemo(() => [...campuses].sort((a, b) => b.exposure - a.exposure), [campuses])

  const openCampus = (c: CampusFigures) => {
    // The campus lives in the URL, not just in session state, so the view is
    // shareable and survives a reload — and so the back button returns to the
    // directory rather than to an identical-looking page.
    app.setCampus(c.name)
    nav(`/dashboard?campus=${c.id}`)
  }

  return (
    <div className="px-6 pb-16 pt-6 sm:px-10">
      {/* ── Row 1: the group in four numbers, kept deliberately secondary ── */}
      <section aria-label="Group summary"
        className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border bg-[hsl(var(--muted)/0.35)] px-5 py-3">
        <Total icon={Building2} label="Campuses" value={String(campuses.length)} />
        <Total icon={GraduationCap} label="Students" value={totals.students.toLocaleString('en-IN')} />
        <Total icon={Wallet} label="Fee collected" value={inrCompact(totals.collected)} />
        <Total icon={IndianRupee} label="Outstanding" value={inrCompact(totals.outstanding)} />
        <p className="ml-auto hidden text-[11.5px] muted lg:block">
          Group totals · open a campus for anything actionable
        </p>
      </section>

      {/* ── Row 0: the campuses themselves ─────────────────────────────── */}
      <div className="mt-8 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight">Campuses</h2>
          <p className="mt-1 text-[13px] muted">Ordered by outstanding fees — the campus needing attention first.</p>
        </div>
        <Link to="/multicampus" className="shrink-0 text-[13px] font-medium text-[hsl(var(--primary))] hover:underline">
          Manage campuses
        </Link>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ordered.map((c) => <CampusCard key={c.id} campus={c} onOpen={openCampus} />)}
      </div>

      {/* ── Row 2: what is broken at the system level ───────────────────── */}
      <SystemAlerts />
    </div>
  )
}

function Total({ icon: Icon, label, value }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="h-4 w-4 shrink-0 muted" />
      <div className="leading-tight">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] muted">{label}</p>
        <p className="text-[15px] font-semibold tabular-nums">{value}</p>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- alerts -- */

const SYSTEM_ALERTS = [
  {
    tone: 'red' as const,
    icon: Plug,
    title: 'Biometric sync failing at North Campus — Delhi NCR',
    detail: 'Device gateway unreachable since 06:20. Attendance for 3 blocks is not being captured.',
    to: '/integrations',
    action: 'Open integrations',
  },
  {
    tone: 'red' as const,
    icon: ReceiptText,
    title: '6 payment settlements unreconciled',
    detail: '₹42.8 L across three days of Razorpay settlements has no matching receipt.',
    to: '/finance',
    action: 'Reconcile',
  },
  {
    tone: 'amber' as const,
    icon: Plug,
    title: 'SMS gateway quota at 92%',
    detail: 'Fee reminders scheduled for tonight may not deliver on the current plan.',
    to: '/integrations',
    action: 'Review',
  },
  {
    tone: 'amber' as const,
    icon: AlertTriangle,
    title: 'Google Workspace sync skipped 34 accounts',
    detail: 'Duplicate primary email addresses. New joiners at two campuses have no login.',
    to: '/integrations',
    action: 'Open log',
  },
]

function SystemAlerts() {
  return (
    <section className="mt-10" aria-label="System alerts">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight">Needs attention</h2>
          <p className="mt-1 text-[13px] muted">Platform-level failures — these affect every campus, not one.</p>
        </div>
        <Link to="/helpdesk" className="shrink-0 text-[13px] font-medium text-[hsl(var(--primary))] hover:underline">
          All issues
        </Link>
      </div>

      <ul className="mt-4 divide-y rounded-2xl border bg-[hsl(var(--card))]">
        {SYSTEM_ALERTS.map((a) => (
          <li key={a.title} className="flex flex-wrap items-start gap-3 p-4 sm:flex-nowrap sm:items-center">
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
              a.tone === 'red'
                ? 'bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))]'
                : 'bg-[hsl(var(--warning,38_92%_50%)/0.16)] text-[hsl(var(--warning,38_92%_38%))]'}`}>
              <a.icon className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0 flex-1 basis-full sm:basis-auto">
              <p className="text-[13.5px] font-medium">{a.title}</p>
              <p className="mt-0.5 text-[12px] muted">{a.detail}</p>
            </div>
            <Link to={a.to}
              className="shrink-0 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-accent">
              {a.action}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
