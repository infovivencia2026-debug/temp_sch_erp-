import { useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, BedDouble, CircleDot, Clock, MapPin, Truck,
} from 'lucide-react'
import { Badge, Button, Card, CardHeader, Progress, Select, useToast } from '@/components/ui'
import { BarSeries } from '@/components/charts'
import { useApp } from '@/hooks/useAppState'
import { personName } from '@/data/generator'
import { cx, dateOffset, fmtDate, hashStr, int, pick, rng } from '@/lib/utils'

/* ---------------------------------------------------------------------------
   One bespoke view per vertical — the screen that vertical is actually judged
   on, and the one a generic table cannot express: a schedule needs bars on a
   timeline, a fleet needs progress along a route, a ward needs a floor plan,
   a plant needs its losses broken out.

   All four read from the same deterministic generator as the tables, so the
   numbers agree with the records behind them. Seeds are hashed rather than
   incremented: an xorshift generator started from adjacent seeds emits
   correlated first values, which is how a bed board ends up entirely
   "Available" followed by entirely "Reserved".
   --------------------------------------------------------------------------- */

/* ======================================================= Construction Gantt */

const PHASES = ['Substructure', 'Superstructure', 'Finishes', 'MEP', 'External Works']

export function ConstructionGantt() {
  const app = useApp()
  const projects = app.industry.vocab.program
  const [project, setProject] = useState(projects[0])

  // 26 weeks across the board, so a bar's width is directly comparable.
  const WEEKS = 26
  const rows = useMemo(() => {
    const activities = app.industry.vocab.course
    const offset = hashStr(project) % activities.length
    return Array.from({ length: 14 }, (_, i) => {
      const r = rng(hashStr(`gantt:${project}:${i}`))
      const start = int(r, 0, WEEKS - 6)
      const span = int(r, 3, 9)
      const drift = pick(r, [0, 0, 0, 1, 1, 2, -1])
      const progress = Math.max(0, Math.min(100, int(r, 0, 130)))
      return {
        id: `A-${1400 + i}`,
        // Walk the activity list rather than sampling it, so no schedule shows
        // the same activity twice.
        name: activities[(offset + i) % activities.length],
        phase: PHASES[Math.floor(i / 3) % PHASES.length],
        owner: personName(r),
        start,
        span,
        actualStart: start + Math.max(0, drift),
        actualSpan: span + Math.abs(drift),
        progress,
        critical: r() > 0.7,
      }
    })
  }, [project, app.industryId])

  const today = 11 // week index of the demo "today"
  const slipping = rows.filter((r) => r.actualStart + r.actualSpan > r.start + r.span)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" options={projects} value={project} onChange={(e) => setProject(e.target.value)} />
        <Select className="w-auto" options={['All phases', ...PHASES]} />
        <div className="ml-auto flex items-center gap-4 text-[11px] muted">
          <span className="flex items-center gap-1.5"><i className="h-2 w-4 rounded-sm bg-slate-300 dark:bg-white/20" /> Baseline</span>
          <span className="flex items-center gap-1.5"><i className="h-2 w-4 rounded-sm bg-brand-500" /> Actual</span>
          <span className="flex items-center gap-1.5"><i className="h-2 w-4 rounded-sm bg-rose-500" /> Critical path</span>
        </div>
      </div>

      <Card>
        <CardHeader
          title="Schedule against baseline"
          subtitle={`${project} · 26-week window`}
          action={<Badge tone={slipping.length > 4 ? 'red' : slipping.length ? 'amber' : 'green'} dot>
            {slipping.length} activities slipping
          </Badge>}
        />
        <div className="overflow-x-auto">
          <div className="min-w-[880px] p-6">
            {/* Week ruler */}
            <div className="mb-3 flex gap-4 pl-[280px]">
              <div className="relative flex-1">
                <div className="flex justify-between text-[10px] muted">
                  {Array.from({ length: 7 }, (_, i) => <span key={i}>W{30 + i * 4}</span>)}
                </div>
              </div>
            </div>

            <div className="space-y-2.5">
              {rows.map((row) => (
                <div key={row.id} className="flex items-center gap-4">
                  <div className="w-[264px] shrink-0">
                    <p className="truncate text-[13px] font-medium">
                      {row.critical && <span className="mr-1.5 text-rose-500">▸</span>}{row.name}
                    </p>
                    <p className="truncate text-[11px] muted">{row.phase} · {row.owner}</p>
                  </div>

                  <div className="relative h-9 flex-1 rounded-md bg-accent/40">
                    {/* today marker */}
                    <span className="absolute top-0 z-10 h-full w-px bg-foreground/25"
                      style={{ left: `${(today / WEEKS) * 100}%` }} />
                    {/* baseline */}
                    <span className="absolute top-1.5 h-2 rounded-sm bg-slate-300 dark:bg-white/20"
                      style={{ left: `${(row.start / WEEKS) * 100}%`, width: `${(row.span / WEEKS) * 100}%` }} />
                    {/* actual, filled to progress */}
                    <span className={cx('absolute bottom-1.5 h-3.5 overflow-hidden rounded-sm',
                      row.critical ? 'bg-rose-500/25' : 'bg-brand-500/25')}
                      style={{ left: `${(row.actualStart / WEEKS) * 100}%`, width: `${(row.actualSpan / WEEKS) * 100}%` }}>
                      <span className={cx('block h-full', row.critical ? 'bg-rose-500' : 'bg-brand-500')}
                        style={{ width: `${row.progress}%` }} />
                    </span>
                  </div>

                  <span className="w-12 shrink-0 text-right text-[12px] tabular-nums muted">{row.progress}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}

/* ========================================================= Logistics board */

const TRIP_STATES = ['On Time', 'Delayed', 'Halted', 'Delivered'] as const

export function TripBoard() {
  const app = useApp()
  const toast = useToast()
  const [filter, setFilter] = useState<string>('All trips')

  const trips = useMemo(() => Array.from({ length: 18 }, (_, i) => {
    const r = rng(hashStr(`trip:${i}`))
    const state = pick(r, [...TRIP_STATES, 'On Time', 'On Time', 'Delayed'])
    return {
      id: `TRP-${5500 + i}`,
      vehicle: `KA-${int(r, 1, 51).toString().padStart(2, '0')}-${String.fromCharCode(65 + i % 26)}${String.fromCharCode(65 + (i * 3) % 26)}-${int(r, 1000, 9999)}`,
      driver: personName(r),
      lane: pick(r, app.industry.vocab.program),
      customer: pick(r, app.industry.vocab.company),
      progress: state === 'Delivered' ? 100 : int(r, 8, 94),
      eta: `${int(r, 1, 22)}h ${int(r, 0, 59)}m`,
      delay: state === 'Delayed' || state === 'Halted' ? int(r, 1, 9) : 0,
      last: pick(r, ['Hosur', 'Krishnagiri', 'Vellore', 'Ranipet', 'Sriperumbudur', 'Bhiwandi', 'Nashik', 'Dhule']),
      state,
    }
  }), [app.industryId])

  const shown = filter === 'All trips' ? trips : trips.filter((t) => t.state === filter)
  const counts = TRIP_STATES.map((s) => ({ s, n: trips.filter((t) => t.state === s).length }))

  return (
    <div className="space-y-6">
      {/* Status strip doubles as the filter — the count and the control are the
          same object, so there is nothing to reconcile. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border sm:grid-cols-5">
        <button onClick={() => setFilter('All trips')}
          className={cx('bg-card p-5 text-left transition-colors', filter === 'All trips' && 'bg-accent')}>
          <p className="eyebrow">All trips</p>
          <p className="mt-3 text-[26px] font-medium tabular-nums">{trips.length}</p>
        </button>
        {counts.map(({ s, n }) => (
          <button key={s} onClick={() => setFilter(s)}
            className={cx('bg-card p-5 text-left transition-colors', filter === s && 'bg-accent')}>
            <p className="eyebrow">{s}</p>
            <p className={cx('mt-3 text-[26px] font-medium tabular-nums',
              s === 'Delayed' && 'text-amber-600', s === 'Halted' && 'text-rose-600')}>{n}</p>
          </button>
        ))}
      </div>

      <div className="grid gap-px overflow-hidden rounded-lg bg-border lg:grid-cols-2">
        {shown.map((t) => (
          <div key={t.id} className="bg-card p-5">
            <div className="flex items-start gap-3">
              <div className={cx('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                t.state === 'Halted' ? 'bg-rose-500/15 text-rose-600'
                  : t.state === 'Delayed' ? 'bg-amber-500/15 text-amber-600'
                    : 'bg-primary/20 text-foreground')}>
                <Truck className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{t.lane}</p>
                <p className="truncate text-[11px] muted">{t.id} · {t.vehicle} · {t.driver}</p>
              </div>
              <Badge tone={t.state === 'Delivered' ? 'green' : t.state === 'Delayed' ? 'amber' : t.state === 'Halted' ? 'red' : 'blue'} dot>
                {t.state}
              </Badge>
            </div>

            <div className="mt-4">
              <Progress value={t.progress} tone={t.state === 'Halted' ? 'red' : t.state === 'Delayed' ? 'amber' : 'brand'} />
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] muted">
                <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{t.last}</span>
                <span className="flex items-center gap-1"><Clock className="h-3 w-3" />ETA {t.eta}</span>
                {t.delay > 0 && <span className="flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3 w-3" />{t.delay}h behind</span>}
                <span className="ml-auto tabular-nums">{t.progress}%</span>
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <Button size="sm" onClick={() => toast({ title: `Tracking ${t.id}`, desc: `${t.vehicle} near ${t.last}`, tone: 'info' })}>Track</Button>
              <Button size="sm" onClick={() => toast({ title: 'Customer notified', desc: t.customer, tone: 'success' })}>Notify {t.customer.split(' ')[0]}</Button>
            </div>
          </div>
        ))}
        {shown.length === 0 && <div className="bg-card p-10 text-center text-sm muted lg:col-span-2">No trips in this state.</div>}
      </div>
    </div>
  )
}

/* ======================================================== Healthcare wards */

const WARDS = [
  { name: 'General Ward', beds: 24, prefix: 'GW' },
  { name: 'Semi-private', beds: 16, prefix: 'SP' },
  { name: 'Private', beds: 14, prefix: 'PR' },
  { name: 'ICU', beds: 12, prefix: 'IC' },
  { name: 'Maternity', beds: 10, prefix: 'MT' },
]

const BED_STATES = ['Occupied', 'Occupied', 'Occupied', 'Available', 'Reserved', 'Cleaning'] as const

export function BedBoard() {
  const app = useApp()
  const toast = useToast()
  const [ward, setWard] = useState('All wards')

  const beds = useMemo(() => WARDS.flatMap((w) => Array.from({ length: w.beds }, (_, i) => {
    const r = rng(hashStr(`bed:${w.prefix}:${i}`))
    const state = pick(r, BED_STATES)
    return {
      id: `${w.prefix}-${String(i + 1).padStart(2, '0')}`,
      ward: w.name,
      state,
      patient: state === 'Occupied' ? personName(r) : null,
      speciality: pick(r, app.industry.vocab.program),
      since: fmtDate(dateOffset(-int(r, 0, 9))),
      los: int(r, 1, 14),
    }
  })), [app.industryId])

  const shown = ward === 'All wards' ? beds : beds.filter((b) => b.ward === ward)
  const occupied = shown.filter((b) => b.state === 'Occupied').length

  // An empty bed should look empty: the free state is the only unfilled one,
  // so a glance across the floor counts capacity rather than reading labels.
  const tone = (s: string) =>
    s === 'Occupied' ? 'border-brand-500/40 bg-brand-500/15'
      : s === 'Available' ? 'border-dashed border-border bg-transparent'
        : s === 'Reserved' ? 'border-amber-500/40 bg-amber-500/10'
          : 'border-border bg-accent/60'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" options={['All wards', ...WARDS.map((w) => w.name)]} value={ward} onChange={(e) => setWard(e.target.value)} />
        <Badge tone={occupied / shown.length > 0.85 ? 'red' : 'blue'} dot>
          {occupied}/{shown.length} occupied · {Math.round((occupied / shown.length) * 100)}%
        </Badge>
        <div className="ml-auto flex flex-wrap items-center gap-4 text-[11px] muted">
          {['Occupied', 'Available', 'Reserved', 'Cleaning'].map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <i className={cx('h-2.5 w-2.5 rounded-sm border', tone(s))} /> {s}
            </span>
          ))}
        </div>
      </div>

      {/* Occupancy by ward, then the floor itself. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border sm:grid-cols-5">
        {WARDS.map((w) => {
          const inWard = beds.filter((b) => b.ward === w.name)
          const occ = inWard.filter((b) => b.state === 'Occupied').length
          const pct = Math.round((occ / inWard.length) * 100)
          return (
            <div key={w.name} className="bg-card p-5">
              <p className="eyebrow truncate">{w.name}</p>
              <p className="mt-3 text-[22px] font-medium tabular-nums">{occ}<span className="text-[13px] muted">/{inWard.length}</span></p>
              <Progress className="mt-3" value={pct} tone={pct > 88 ? 'red' : pct > 70 ? 'amber' : 'green'} />
            </div>
          )
        })}
      </div>

      <Card>
        <CardHeader title="Bed board" subtitle={`${ward} · live occupancy`} action={<BedDouble className="h-4 w-4 muted" />} />
        <div className="grid grid-cols-2 gap-2 p-6 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {shown.map((b) => (
            <button
              key={b.id}
              onClick={() => toast({
                title: `${b.id} · ${b.state}`,
                desc: b.patient ? `${b.patient} · ${b.speciality} · day ${b.los}` : `${b.ward} — no patient assigned`,
                tone: 'info',
              })}
              className={cx('rounded-lg border p-3 text-left transition-transform duration-300 ease-premium hover:-translate-y-0.5', tone(b.state))}
            >
              <p className="text-[11px] font-semibold tabular-nums">{b.id}</p>
              <p className="mt-1 truncate text-[11px] muted">{b.patient ?? b.state}</p>
              {b.patient && <p className="mt-1 truncate text-[10px] muted">Day {b.los}</p>}
            </button>
          ))}
        </div>
      </Card>
    </div>
  )
}

/* ==================================================== Manufacturing OEE */

const LOSSES = ['Setup', 'Breakdown', 'Material wait', 'Manpower', 'Quality stop', 'Speed loss']

export function OeeBoard() {
  const app = useApp()
  const [shift, setShift] = useState(app.industry.vocab.sem[0])

  const machines = useMemo(() => Array.from({ length: 12 }, (_, i) => {
    const r = rng(hashStr(`oee:${shift}:${i}`))
    const availability = int(r, 62, 98)
    const performance = int(r, 64, 99)
    const quality = int(r, 88, 100)
    const oee = Math.round((availability * performance * quality) / 10000)
    return {
      id: `MC-${120 + i}`,
      name: pick(r, ['CNC Lathe', 'VMC', 'Press', 'Furnace', 'Injection Moulder', 'Welding Robot', 'Grinder']),
      line: pick(r, app.industry.vocab.room),
      operator: personName(r),
      availability, performance, quality, oee,
      state: oee >= 75 ? 'Running' : oee >= 60 ? 'Running' : r() > 0.5 ? 'Breakdown' : 'Setup',
      topLoss: pick(r, LOSSES),
      downtime: int(r, 0, 220),
    }
  }), [shift, app.industryId])

  const plantOee = Math.round(machines.reduce((a, m) => a + m.oee, 0) / machines.length)
  const lossPareto = LOSSES.map((l) => ({
    name: l,
    value: machines.filter((m) => m.topLoss === l).reduce((a, m) => a + m.downtime, 0),
  })).sort((a, b) => b.value - a.value)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" options={app.industry.vocab.sem} value={shift} onChange={(e) => setShift(e.target.value)} />
        <Select className="w-auto" options={['All lines', ...app.industry.vocab.room.slice(0, 6)]} />
        <Badge tone={plantOee >= 75 ? 'green' : plantOee >= 65 ? 'amber' : 'red'} dot>Plant OEE {plantOee}%</Badge>
        <span className="ml-auto text-[11px] muted">World class is 85% — anything under 65% is losing a shift a week.</span>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Machine status" subtitle={`${shift} · availability × performance × quality`} action={<Activity className="h-4 w-4 muted" />} />
          <div className="grid gap-px bg-border sm:grid-cols-2">
            {machines.map((m) => (
              <div key={m.id} className="bg-card p-5">
                <div className="flex items-center gap-2">
                  <CircleDot className={cx('h-3.5 w-3.5',
                    m.state === 'Running' ? 'text-emerald-500' : m.state === 'Setup' ? 'text-amber-500' : 'text-rose-500')} />
                  <p className="truncate text-[13px] font-medium">{m.name}</p>
                  <span className="text-[11px] muted">{m.id}</span>
                  <span className={cx('ml-auto text-[20px] font-medium tabular-nums',
                    m.oee >= 75 ? 'text-emerald-600' : m.oee >= 65 ? '' : 'text-rose-600')}>{m.oee}%</span>
                </div>
                <p className="mt-1 truncate text-[11px] muted">{m.line} · {m.operator}</p>

                <div className="mt-3 space-y-1.5">
                  {([['A', m.availability], ['P', m.performance], ['Q', m.quality]] as const).map(([k, v]) => (
                    <div key={k} className="flex items-center gap-2">
                      <span className="w-3 text-[10px] muted">{k}</span>
                      <Progress className="flex-1" value={v} tone={v >= 85 ? 'green' : v >= 70 ? 'brand' : 'amber'} />
                      <span className="w-8 text-right text-[11px] tabular-nums muted">{v}%</span>
                    </div>
                  ))}
                </div>

                <p className="mt-3 text-[11px] muted">
                  Top loss: <span className="text-foreground">{m.topLoss}</span> · {m.downtime} min
                </p>
              </div>
            ))}
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Loss pareto" subtitle="Downtime minutes this shift" />
            <div className="p-4">
              <BarSeries horizontal data={lossPareto} keys={[{ key: 'value', label: 'Minutes' }]} height={260} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Andon" subtitle="Machines needing attention" />
            <div className="divide-y">
              {machines.filter((m) => m.state !== 'Running' || m.oee < 65).slice(0, 5).map((m) => (
                <div key={m.id} className="flex items-center gap-2.5 px-6 py-4">
                  <AlertTriangle className={cx('h-4 w-4 shrink-0', m.state === 'Breakdown' ? 'text-rose-500' : 'text-amber-500')} />
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{m.name} · {m.id}</p>
                    <p className="truncate text-[11px] muted">{m.state} · {m.topLoss} · {m.downtime} min</p>
                  </div>
                  <span className="ml-auto text-[13px] font-medium tabular-nums">{m.oee}%</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
