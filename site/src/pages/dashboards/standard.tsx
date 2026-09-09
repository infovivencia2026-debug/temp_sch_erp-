import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@/lib/nav'
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Download,
  LayoutGrid, Megaphone, Plus, Printer,
} from 'lucide-react'
import { Avatar, Badge, Button, Card, CardHeader, Checkbox, Modal, Progress, Skeleton, useToast } from '@/components/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { AreaTrend, BarSeries, Donut, LineSeries } from '@/components/charts'
import { useApp } from '@/hooks/useAppState'
import { activeRole } from '@/industries'
import { FIRST, LAST } from '@/data/vocab'
import { cx, int, pick, rng, TODAY } from '@/lib/utils'
import type { LayoutProps } from './types'

/**
 * The standard dashboard: KPI grid, secondary strip, chart rows, feeds.
 *
 * Interfaces UI-1 to UI-9 differ from one another in their *shell* — where
 * navigation lives, the palette, the density — and share this page, so the
 * shell is the thing being compared. UI-11 to UI-15 invert that: a quiet
 * shell, and a page skeleton that is the whole point.
 */
export function StandardDashboard({ cfg }: LayoutProps) {
  const app = useApp()
  const toast = useToast()
  const nav = useNavigate()
  const [loading, setLoading] = useState(true)
  const [customise, setCustomise] = useState(false)

  const role = activeRole(app.role)

  const [tasks, setTasks] = useState(cfg.tasks)
  useEffect(() => { setTasks(cfg.tasks) }, [app.industryId])

  // Which tiles this user keeps. Persisted per industry, so a layout tuned for
  // the plant floor does not follow you into the hospital.
  const hiddenKey = `erp.dashboard.hidden.${app.industryId}`
  const [hidden, setHidden] = useState<string[]>([])
  useEffect(() => {
    try { setHidden(JSON.parse(localStorage.getItem(hiddenKey) || '[]')) } catch { setHidden([]) }
  }, [hiddenKey])
  const toggleTile = (id: string) => {
    setHidden((h) => {
      const next = h.includes(id) ? h.filter((x) => x !== id) : [...h, id]
      localStorage.setItem(hiddenKey, JSON.stringify(next))
      return next
    })
  }
  const shows = (id: string) => !hidden.includes(id)

  // No simulated fetch: the figures are already in memory, so waiting half a
  // second to reveal them only made every visit feel slow.
  useEffect(() => { setLoading(false) }, [app.industryId])

  const activity = useMemo(() => Array.from({ length: 14 }, (_, i) => {
    const r = rng(9090 + i * 37 + app.industryId.length * 13)
    return {
      id: `act-${i}`,
      actor: `${pick(r, FIRST)} ${pick(r, LAST)}`,
      verb: pick(r, cfg.activityVerbs),
      target: pick(r, [...app.industry.vocab.program.slice(0, 10), ...app.industry.vocab.company.slice(0, 6)]),
      time: `${int(r, 2, 58)}m ago`,
    }
  }), [app.industryId])

  return (
    <div className="print-area">
      <PageHeader
        title="Good morning, Priya"
        eyebrow={app.industry.label}
        subtitle={`${role.label} · ${role.scope} · ${cfg.greeting}`}
        crumbs={[{ label: 'Dashboard' }]}
        actions={
          <>
            <Button size="sm" icon={Printer} onClick={() => window.print()}>Print</Button>
            <Button size="sm" icon={Download} onClick={() => toast({ title: 'Export started', desc: `${app.industryId}-dashboard-aug-2026.xlsx will download shortly.`, tone: 'success' })}>Export</Button>
            <Button size="sm" icon={LayoutGrid} onClick={() => setCustomise(true)}>Customise</Button>
            <Button size="sm" variant="primary" icon={Plus} onClick={() => nav(cfg.primaryAction.to)}>{cfg.primaryAction.label}</Button>
          </>
        }
      />

      <div className="space-y-10 px-6 py-10 sm:px-10">
        {/* KPI grid */}
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-border reveal sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          {cfg.kpis.map((k) => (
            <Link key={k.label} to={k.to} className="group bg-card p-6 transition-colors duration-500 ease-premium hover:bg-accent/40">
              {loading ? <><Skeleton className="h-3 w-20" /><Skeleton className="mt-3 h-7 w-24" /></> : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="eyebrow">{k.label}</p>
                    <k.icon className="h-4 w-4 muted transition-transform duration-500 ease-premium group-hover:-translate-y-0.5" />
                  </div>
                  <p className="mt-4 text-[32px] font-medium leading-none tracking-[-0.035em] tabular-nums">{k.value}</p>
                  <p className={cx('mt-3 inline-flex items-center gap-1.5 text-[12px]', k.up ? 'text-emerald-600' : 'text-rose-600')}>
                    {k.up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {k.delta} <span className="muted font-normal">vs last month</span>
                  </p>
                </>
              )}
            </Link>
          ))}
        </div>

        {shows('secondary') && (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border sm:grid-cols-3 lg:grid-cols-6">
            {cfg.secondary.map((s) => (
              <div key={s.label} className="bg-card p-5">
                <div className="flex items-center gap-2 text-[11px] muted"><s.icon className="h-3.5 w-3.5" />{s.label}</div>
                <p className="mt-3 text-[22px] font-medium tracking-[-0.03em] tabular-nums">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {shows('charts') && (
          <div className="grid gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title={cfg.trend.title} subtitle={cfg.trend.subtitle} action={<Badge tone="green" dot>Tracking</Badge>} />
              <div className="p-4">{loading ? <Skeleton className="m-2 h-[204px]" /> : <AreaTrend data={cfg.trend.data} keys={cfg.trend.keys} />}</div>
            </Card>
            <Card>
              <CardHeader title={cfg.mix.title} subtitle={cfg.mix.subtitle} />
              <div className="p-4">{loading ? <Skeleton className="m-2 h-[204px]" /> : <Donut data={cfg.mix.data} />}</div>
            </Card>
          </div>
        )}

        {shows('funnel') && (
          <div className="grid gap-6 xl:grid-cols-3">
            <Card>
              <CardHeader title={cfg.funnel.title} subtitle={cfg.funnel.subtitle} />
              <div className="p-4">{loading ? <Skeleton className="m-2 h-[204px]" /> : <BarSeries data={cfg.funnel.data} keys={cfg.funnel.keys} />}</div>
            </Card>
            <Card>
              <CardHeader title={cfg.money.title} subtitle={cfg.money.subtitle} />
              <div className="p-4">{loading ? <Skeleton className="m-2 h-[204px]" /> : <LineSeries data={cfg.money.data} keys={cfg.money.keys} />}</div>
            </Card>
            <Card>
              <CardHeader title={cfg.progress.title} subtitle={cfg.progress.subtitle} />
              <div className="space-y-5 p-6">
                {cfg.progress.rows.map((row) => {
                  const pct = Math.round((row.done / row.total) * 100)
                  return (
                    <div key={row.name}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="font-medium">{row.name}</span>
                        <span className="muted tabular-nums">
                          {cfg.progress.unit === '%' ? `${pct}%` : `${row.done}/${row.total}${cfg.progress.unit}`}
                        </span>
                      </div>
                      <Progress value={pct} tone={pct > 88 ? 'green' : pct > 72 ? 'brand' : 'amber'} />
                    </div>
                  )
                })}
              </div>
            </Card>
          </div>
        )}

        {shows('approvals') && (
          <div className="grid gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Pending approvals" subtitle="Items waiting on you" />
              <div className="divide-y">
                {cfg.approvals.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-3 px-6 py-4">
                    <div className="min-w-0 flex-1 basis-[65%]">
                      <p className="truncate text-[13px] font-medium">{p.detail}</p>
                      <p className="truncate text-[11px] muted">{p.type} · {p.id} · pending {p.age}</p>
                    </div>
                    <span className="text-[13px] font-medium tabular-nums">{p.value}</span>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => toast({ title: `${p.id} rejected`, tone: 'error' })}>Reject</Button>
                      <Button size="sm" variant="primary" onClick={() => toast({ title: `${p.id} approved`, desc: 'Workflow moved to the next level.', tone: 'success' })}>Approve</Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader title="Alerts" subtitle="Needs attention this week" />
              <div className="divide-y">
                {cfg.alerts.map((a) => (
                  <div key={a.title} className="flex gap-2.5 px-6 py-4">
                    <AlertTriangle className={cx('mt-0.5 h-4 w-4 shrink-0',
                      a.tone === 'red' ? 'text-rose-500' : a.tone === 'amber' ? 'text-amber-500' : 'text-brand-500')} />
                    <div>
                      <p className="text-[13px] font-medium">{a.title}</p>
                      <p className="text-[11px] muted">{a.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {shows('activity') && (
          <div className="grid gap-6 xl:grid-cols-3">
            <Card>
              <CardHeader title="Recent activity" />
              <div className="max-h-[320px] divide-y overflow-y-auto">
                {activity.map((a) => (
                  <div key={a.id} className="flex gap-2.5 px-6 py-4">
                    <Avatar name={a.actor} size={26} />
                    <div className="min-w-0">
                      <p className="text-[13px] leading-snug">
                        <span className="font-medium">{a.actor}</span> <span className="muted">{a.verb}</span> {a.target}
                      </p>
                      <p className="text-[11px] muted">{a.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader
                title={cfg.recent.title}
                action={<Link to={cfg.recent.to} className="text-xs text-brand-600 hover:underline">{cfg.recent.action}</Link>}
              />
              <div className="divide-y">
                {cfg.recent.rows.map((r) => (
                  <div key={r.id} className="flex items-center gap-2.5 px-6 py-4">
                    <Avatar name={r.name} size={26} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{r.name}</p>
                      <p className="truncate text-[11px] muted">{r.sub}</p>
                    </div>
                    <Badge tone={/completed|delivered|paid|settled|certified|discharged/i.test(r.stage) ? 'green'
                      : /disputed|delayed|hold|rejected/i.test(r.stage) ? 'red' : 'blue'}>{r.stage}</Badge>
                  </div>
                ))}
              </div>
            </Card>

            <div className="space-y-10">
              <Card>
                <CardHeader title="My tasks" subtitle={`${tasks.filter((t) => !t.done).length} open`} />
                <div className="divide-y">
                  {tasks.map((t, i) => (
                    <div key={t.title} className="flex items-center gap-2.5 px-6 py-4">
                      <Checkbox checked={t.done} onChange={(v) => {
                        setTasks((ts) => ts.map((x, xi) => (xi === i ? { ...x, done: v } : x)))
                        if (v) toast({ title: 'Task completed', desc: t.title, tone: 'success' })
                      }} />
                      <div className="min-w-0">
                        <p className={cx('truncate text-[13px]', t.done && 'line-through muted')}>{t.title}</p>
                        <p className="text-[11px] muted">{t.due}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <CardHeader title="Announcements" action={<Megaphone className="h-4 w-4 muted" />} />
                <div className="divide-y">
                  {cfg.announcements.map((a) => (
                    <div key={a.title} className="px-6 py-4">
                      <p className="text-[13px] font-medium leading-snug">{a.pinned && <Badge tone="violet">Pinned</Badge>} {a.title}</p>
                      <p className="mt-0.5 text-[11px] muted">{a.by} · {a.time}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        )}

        {shows('calendar') && (
          <div className="grid gap-6 lg:grid-cols-3">
            <MiniCalendar events={cfg.calendar} />
            <Card>
              <CardHeader title="Upcoming" action={<CalendarDays className="h-4 w-4 muted" />} />
              <div className="divide-y">
                {cfg.events.map((e) => (
                  <div key={e.name} className="flex items-center gap-3 px-6 py-4">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-[10px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
                      {e.date.split(' ')[0]}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">{e.name}</p>
                      <p className="truncate text-[11px] muted">{e.date} · {e.venue}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <CardHeader title={cfg.ranking.title} subtitle={cfg.ranking.subtitle} />
              <div className="space-y-5 p-6">
                {cfg.ranking.rows.map((d) => (
                  <div key={d.name}>
                    <div className="mb-1 flex justify-between text-xs"><span className="font-medium">{d.name}</span><span className="muted tabular-nums">{d.value}%</span></div>
                    <Progress value={d.value} tone={d.value > 80 ? 'green' : d.value > 68 ? 'brand' : 'amber'} />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>

      <Modal open={customise} onClose={() => setCustomise(false)} title="Customise dashboard"
        subtitle="Choose which sections appear. Saved to this browser, per industry."
        footer={<>
          <Button onClick={() => { setHidden([]); localStorage.removeItem(hiddenKey); toast({ title: 'Layout reset', tone: 'info' }) }}>Reset</Button>
          <Button variant="primary" onClick={() => { setCustomise(false); toast({ title: 'Dashboard updated', tone: 'success' }) }}>Done</Button>
        </>}>
        <div className="space-y-1">
          {TILES.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent">
              <Checkbox checked={shows(t.id)} onChange={() => toggleTile(t.id)} />
              <div>
                <p className="text-[13px] font-medium">{t.label}</p>
                <p className="text-[11px] muted">{t.hint}</p>
              </div>
            </label>
          ))}
        </div>
      </Modal>
    </div>
  )
}

const TILES = [
  { id: 'secondary', label: 'Secondary metrics strip', hint: 'Six supporting figures' },
  { id: 'charts', label: 'Trend & distribution', hint: 'Performance trend plus mix donut' },
  { id: 'funnel', label: 'Funnel, money & progress', hint: 'Three-up chart row' },
  { id: 'approvals', label: 'Pending approvals & alerts', hint: 'Items waiting on you' },
  { id: 'activity', label: 'Activity, records, tasks & announcements', hint: 'Four feed panels' },
  { id: 'calendar', label: 'Calendar, upcoming & ranking', hint: 'Bottom row' },
]

function MiniCalendar({ events }: { events: Record<number, string[]> }) {
  const [offset, setOffset] = useState(0)
  const base = new Date(TODAY.getFullYear(), TODAY.getMonth() + offset, 1)
  const monthName = base.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
  const firstDay = base.getDay()
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
  const cells = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]

  return (
    <Card>
      <CardHeader
        title={monthName}
        subtitle="Operations calendar"
        action={
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" aria-label="Previous month" title="Previous month"
              onClick={() => setOffset(offset - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" aria-label="Next month" title="Next month"
              onClick={() => setOffset(offset + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        }
      />
      <div className="p-3">
        <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium muted">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            const isToday = offset === 0 && d === TODAY.getDate()
            const hasEvent = offset === 0 && d !== null && events[d]
            return (
              <div key={i} className={cx('relative grid aspect-square place-items-center rounded-lg text-xs',
                d === null && 'opacity-0',
                isToday ? 'bg-brand-600 font-semibold text-white'
                  : hasEvent ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
                    : 'hover:bg-slate-100 dark:hover:bg-white/5')}
                title={hasEvent ? events[d as number].join(', ') : undefined}>
                {d}
                {hasEvent && !isToday && <span className="absolute bottom-1 h-1 w-1 rounded-full bg-brand-500" />}
              </div>
            )
          })}
        </div>
      </div>
    </Card>
  )
}
