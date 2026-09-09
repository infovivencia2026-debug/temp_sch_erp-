import { useState } from 'react'
import { ChevronDown, ChevronRight, CornerDownLeft, Maximize2 } from 'lucide-react'
import { AreaTrend, BarSeries, Donut } from '@/components/charts'
import {
  Bullet, DotDensity, Dumbbell, FlowBars, Heatmap, MiniBars, ProgressArc, RadialRing,
  Ridgeline, Sparkline, StepLine, Treemap, VolumeBars, Waterfall,
} from '@/components/viz'
import { AlertList, ApprovalList, DashActions, Delta, Eyebrow, RankBars, Region } from './parts'
import type { LayoutProps } from './types'
import { cx } from '@/lib/utils'

/* ===========================================================================
   UI-06 — FULL-SCREEN STAGE
   One composition per viewport. Each screen behaves like a slide: a single
   number and a single graph, never a mosaic.
   =========================================================================== */
export function FullScreenStage({ cfg, d }: LayoutProps) {
  const [screen, setScreen] = useState(0)
  const k = cfg.kpis
  const SCREENS = ['Headline', 'Comparison', 'Mix', 'Risk']

  return (
    <div className="relative">
      <div className="flex min-h-[calc(100dvh-160px)] flex-col items-center justify-center px-6 py-10 text-center sm:px-10">
        {screen === 0 && (
          <>
            <p className="text-[12px] uppercase tracking-[0.22em] muted">{k[0].label}</p>
            <p className="mt-4 text-[clamp(3.5rem,11vw,8rem)] font-semibold leading-none tracking-[-0.05em] tabular-nums">
              {k[0].value}
            </p>
            <div className="mt-4"><Delta up={k[0].up}>{k[0].delta} vs plan</Delta></div>
            <div className="mt-10 w-full max-w-5xl">
              <AreaTrend data={cfg.trend.data} keys={cfg.trend.keys} height={300} />
            </div>
          </>
        )}

        {screen === 1 && (
          <div className="w-full max-w-5xl">
            <p className="text-[12px] uppercase tracking-[0.22em] muted">{cfg.progress.title}</p>
            <h2 className="mt-3 text-[clamp(1.8rem,4vw,2.8rem)] font-semibold tracking-[-0.03em]">{cfg.progress.subtitle}</h2>
            <div className="mt-10 space-y-7 text-left">
              {cfg.progress.rows.map((row) => {
                const pct = Math.round((row.done / row.total) * 100)
                return <Bullet key={row.name} value={pct} target={88} max={100} label={row.name} sub={`${pct}%`} />
              })}
            </div>
          </div>
        )}

        {screen === 2 && (
          <div className="w-full max-w-4xl">
            <p className="text-[12px] uppercase tracking-[0.22em] muted">{cfg.mix.title}</p>
            <h2 className="mt-3 text-[clamp(1.8rem,4vw,2.8rem)] font-semibold tracking-[-0.03em]">{cfg.mix.subtitle}</h2>
            <div className="mt-8"><Treemap items={d.treemap} height={340} /></div>
          </div>
        )}

        {screen === 3 && (
          <div className="w-full max-w-4xl">
            <p className="text-[12px] uppercase tracking-[0.22em] muted">Risk</p>
            <h2 className="mt-3 text-[clamp(1.8rem,4vw,2.8rem)] font-semibold tracking-[-0.03em]">
              {cfg.alerts.length} items need a decision
            </h2>
            <div className="mx-auto mt-10 flex max-w-md justify-center"><ProgressArc value={72} size={280} label="Risk cover" /></div>
            <div className="mt-8 text-left"><AlertList cfg={cfg} limit={4} /></div>
          </div>
        )}
      </div>

      {/* the only navigation on the page */}
      <div className="sticky bottom-6 mx-auto flex w-fit items-center gap-1 rounded-full border px-2 py-1.5 shadow-lg"
        style={{ background: 'hsl(var(--card))' }}>
        {SCREENS.map((s, i) => (
          <button
            key={s}
            onClick={() => setScreen(i)}
            className={cx('rounded-full px-4 py-1.5 text-[12px] transition-colors',
              i === screen ? 'bg-[hsl(var(--primary))] font-medium text-[hsl(var(--primary-foreground))]' : 'muted hover:bg-accent')}
          >
            {s}
          </button>
        ))}
        <span className="ml-1 border-l pl-2"><DashActions cfg={cfg} compact /></span>
      </div>
    </div>
  )
}

/* ===========================================================================
   UI-07 — COMMAND DRAWER
   Almost empty by default: a command line and a written briefing. Running a
   command expands a full-width analytical drawer beneath it.
   =========================================================================== */
export function CommandDrawer({ cfg, d, industry }: LayoutProps) {
  const [open, setOpen] = useState<string | null>(null)
  const [value, setValue] = useState('')

  const COMMANDS = [
    { cmd: 'show revenue', label: cfg.money.title },
    { cmd: 'show mix', label: cfg.mix.title },
    { cmd: 'show ranking', label: cfg.ranking.title },
    { cmd: 'show risk', label: 'Open risks' },
  ]

  return (
    <div className="px-6 pb-16 sm:px-10">
      <div className="mx-auto max-w-3xl pt-10">
        {/* command line */}
        <div className="flex flex-wrap items-center gap-3 border-b pb-3">
          <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold tracking-widest">{industry.product.split(' ')[1]?.toUpperCase() ?? 'COMMAND'}</span>
          <span className="shrink-0 muted">/</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setOpen(value || 'show revenue') }}
            placeholder="ask for a number, a comparison or a risk…"
            className="h-9 min-w-0 flex-1 bg-transparent text-[16px] outline-none sm:text-[14px] placeholder:opacity-50"
          />
          <button onClick={() => setOpen(value || 'show revenue')} className="flex items-center gap-1.5 text-[11px] muted">
            <CornerDownLeft className="h-3.5 w-3.5" /> run
          </button>
          <DashActions cfg={cfg} compact />
        </div>

        {/* briefing */}
        <div className="py-10">
          <p className="text-[13px] muted">Good morning.</p>
          <p className="mt-4 max-w-[58ch] text-[19px] leading-relaxed tracking-[-0.01em]">
            {cfg.kpis[0].label} is <strong className="font-semibold">{cfg.kpis[0].value}</strong>{' '}
            <span className="inline-flex align-middle"><Sparkline data={d.spark[cfg.kpis[0].label]} w={54} h={16} /></span>{' '}
            {cfg.kpis[0].up ? 'ahead of' : 'behind'} plan. {cfg.alerts[0].title}, and{' '}
            {cfg.alerts[1]?.title.toLowerCase()}.
          </p>
          <p className="mt-4 max-w-[58ch] text-[14px] leading-relaxed muted">
            {cfg.kpis[3].label} reads {cfg.kpis[3].value}{' '}
            <span className="inline-flex align-middle"><Sparkline data={d.spark[cfg.kpis[3].label]} w={44} h={14} /></span>
            . {cfg.approvals.length} items are waiting on a decision.
          </p>

          <p className="mt-10 text-[11px] uppercase tracking-wider muted">Recent commands</p>
          <ul className="mt-3 space-y-1">
            {COMMANDS.map((c) => (
              <li key={c.cmd}>
                <button onClick={() => setOpen(c.cmd)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] muted hover:bg-accent hover:text-foreground">
                  <span className="opacity-50">/</span>{c.cmd}
                  <ChevronRight className="ml-auto h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* the drawer */}
      {open && (
        <div className="fixed inset-x-0 bottom-0 z-30 max-h-[76vh] overflow-y-auto border-t shadow-2xl"
          style={{ background: 'hsl(var(--card))' }}>
          <div className="mx-auto max-w-[1400px] px-6 py-6 sm:px-10">
            <div className="flex items-center gap-3 pb-4">
              <span className="text-[12px] muted">/</span>
              <p className="text-[14px] font-semibold">{open}</p>
              <button onClick={() => setOpen(null)} className="ml-auto text-[12px] muted hover:text-foreground">Close</button>
            </div>
            <div className="w-full">
              {open.includes('mix') ? <Treemap items={d.treemap} height={260} />
                : open.includes('ranking') ? <RankBars rows={cfg.ranking.rows} />
                  : open.includes('risk') ? <Heatmap rows={d.heat.rows} cols={d.heat.cols} values={d.heat.values} height={200} />
                    : <Waterfall steps={d.waterfall} height={260} />}
            </div>
            <div className="mt-6 grid gap-6 border-t pt-5 md:grid-cols-3">
              <Region title="Details"><ApprovalList cfg={cfg} limit={3} /></Region>
              <Region title="Events">
                <ul className="space-y-2">
                  {d.events.slice(0, 4).map((e) => (
                    <li key={e.time} className="flex gap-2.5 text-[12px]">
                      <span className="shrink-0 tabular-nums muted">{e.time}</span>
                      <span className="truncate">{e.title}</span>
                    </li>
                  ))}
                </ul>
              </Region>
              <Region title="Evidence"><AlertList cfg={cfg} limit={3} compact /></Region>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ===========================================================================
   UI-08 — HORIZONTAL TERRACE STACK
   The whole page is stacked bands, one per level of the business. Clicking a
   band expands it and compresses the others.
   =========================================================================== */
export function TerraceStack({ cfg, d, industry }: LayoutProps) {
  const [open, setOpen] = useState(0)

  const bands = [
    {
      name: 'Enterprise',
      sub: cfg.greeting,
      body: (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            {cfg.kpis.slice(0, 4).map((k) => (
              <Bullet key={k.label} value={parseFloat(String(k.value).replace(/[^\d.]/g, '')) || 60}
                target={80} max={100} label={k.label} sub={String(k.value)} />
            ))}
          </div>
          <AreaTrend data={cfg.trend.data} keys={cfg.trend.keys} height={200} />
        </div>
      ),
    },
    {
      name: 'Business unit',
      sub: cfg.mix.subtitle,
      body: <BarSeries data={cfg.funnel.data} keys={cfg.funnel.keys} height={220} />,
    },
    {
      name: 'Region',
      sub: `${industry.scope.sites.length} ${industry.scope.siteLabel.toLowerCase()}s`,
      body: <Heatmap rows={industry.scope.sites.map((s) => s.split('—')[0].trim())} cols={d.heat.cols} values={d.heat.values.slice(0, industry.scope.sites.length)} height={180} />,
    },
    {
      name: 'Initiatives',
      sub: `${cfg.events.length} milestones ahead`,
      body: (
        <div className="relative pl-3">
          <span className="absolute bottom-2 left-0 top-2 w-px" style={{ background: 'hsl(var(--border))' }} />
          <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {cfg.events.map((e) => (
              <div key={e.name} className="relative pl-4">
                <span className="absolute left-[-2px] top-2 h-1.5 w-1.5 rounded-full" style={{ background: 'hsl(var(--primary))' }} />
                <p className="text-[12.5px] font-medium">{e.name}</p>
                <p className="text-[11px] muted">{e.date} · {e.venue}</p>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      name: 'Execution',
      sub: `${cfg.approvals.length} decisions pending`,
      body: (
        <div className="grid gap-6 lg:grid-cols-2">
          <ApprovalList cfg={cfg} limit={5} />
          <Dumbbell items={d.dumbbell} />
        </div>
      ),
    },
  ]

  return (
    <div className="flex min-h-[calc(100dvh-150px)] flex-col gap-1 px-4 py-4 sm:px-6">
      {bands.map((b, i) => {
        const isOpen = i === open
        return (
          <section
            key={b.name}
            onClick={() => setOpen(i)}
            className={cx('min-h-0 cursor-pointer overflow-hidden rounded-xl border transition-all duration-500 ease-premium',
              isOpen ? 'flex-[6]' : 'flex-[1] hover:bg-accent/40')}
            style={{ background: isOpen ? 'hsl(var(--card))' : undefined }}
          >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
              <span className="shrink-0 text-[10px] tabular-nums muted">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="shrink-0 whitespace-nowrap text-[14px] font-semibold tracking-tight">{b.name}</h3>
              <span className="truncate text-[11.5px] muted">{b.sub}</span>
              {isOpen && i === 0 && <span className="ml-auto" onClick={(e) => e.stopPropagation()}><DashActions cfg={cfg} compact /></span>}
              {!isOpen && (
                <span className="ml-auto flex items-center gap-3">
                  <MiniBars data={d.volume.slice(i * 4, i * 4 + 10)} height={18} />
                  <ChevronDown className="h-3.5 w-3.5 muted" />
                </span>
              )}
            </header>
            {isOpen && <div className="min-h-0 overflow-y-auto px-5 pb-5">{b.body}</div>}
          </section>
        )
      })}
    </div>
  )
}

/* ===========================================================================
   UI-09 — VERTICAL EVENT SPINE
   A timeline runs down the middle of the page. Performance signals sit to its
   left, events and decisions to its right. Vertically continuous, no rows.
   =========================================================================== */
export function EventSpine({ cfg, d }: LayoutProps) {
  const signals = cfg.kpis.slice(0, 6)
  return (
    <div className="mx-auto max-w-[1180px] px-6 pb-16 pt-6 sm:px-10">
      <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-[1fr_auto_1fr]">
        <p className="hidden pb-4 text-right text-[11px] uppercase tracking-wider muted sm:block">Performance</p>
        <p className="hidden pb-4 text-center text-[11px] uppercase tracking-wider muted sm:block">Time</p>
        <div className="col-span-3 flex items-start gap-3 pb-4 sm:col-span-1">
          <p className="hidden text-[11px] uppercase tracking-wider muted sm:block">Events &amp; decisions</p>
          <span className="ml-auto"><DashActions cfg={cfg} compact /></span>
        </div>

        {d.events.map((e, i) => {
          const sig = signals[i % signals.length]
          return (
            <div key={e.time} className="contents">
              {/* left: a performance signal */}
              <div className="pb-10 text-right">
                {i % 2 === 0 ? (
                  <>
                    <p className="text-[12px] muted">{sig.label}</p>
                    <p className="text-[20px] font-semibold leading-tight tabular-nums">{sig.value}</p>
                    <div className="mt-1 flex justify-end"><Delta up={sig.up}>{sig.delta}</Delta></div>
                    <div className="mt-2 flex justify-end"><Sparkline data={d.spark[sig.label]} w={140} h={28} /></div>
                  </>
                ) : (
                  <div className="ml-auto max-w-[280px]">
                    <Ridgeline series={[d.ridges[i % d.ridges.length]]} height={26} />
                  </div>
                )}
              </div>

              {/* centre: the spine */}
              <div className="relative flex w-10 shrink-0 justify-center pb-10 sm:w-[120px]">
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2" style={{ background: 'hsl(var(--border))' }} />
                <div className="relative z-10 flex flex-col items-center">
                  <span className={cx('h-2.5 w-2.5 rounded-full ring-4',
                    e.tone === 'bad' ? 'bg-rose-500 ring-rose-500/15'
                      : e.tone === 'warn' ? 'bg-amber-500 ring-amber-500/15'
                        : e.tone === 'good' ? 'bg-emerald-500 ring-emerald-500/15'
                          : 'bg-sky-500 ring-sky-500/15')} />
                  <span className="mt-1.5 text-[11px] tabular-nums muted">{e.time}</span>
                </div>
              </div>

              {/* right: the event */}
              <div className="pb-10">
                <p className="text-[13px] font-medium leading-snug">{e.title}</p>
                <p className="mt-0.5 text-[11.5px] muted">{e.detail}</p>
                {i === 2 && (
                  <div className="mt-3 rounded-lg border p-3">
                    <Eyebrow>Impact</Eyebrow>
                    <div className="mt-2"><Dumbbell items={d.dumbbell.slice(0, 3)} /></div>
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {/* the forecast cone continues past "now" */}
        <div className="text-right">
          <p className="text-[12px] muted">Forecast</p>
          <p className="text-[11px] muted">carried at current run rate</p>
        </div>
        <div className="relative flex w-10 shrink-0 justify-center sm:w-[120px]">
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 border-l border-dashed" style={{ borderColor: 'hsl(var(--border))' }} />
          <span className="mt-0 self-start whitespace-nowrap bg-[hsl(var(--background))] px-1 text-[11px] muted">now</span>
        </div>
        <div className="pr-2">
          <div className="rounded-lg border p-3" style={{ background: 'hsl(var(--primary) / 0.05)' }}>
            <Eyebrow>Projected</Eyebrow>
            <AreaTrend data={cfg.money.data.slice(-6)} keys={cfg.money.keys} height={110} />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ===========================================================================
   UI-9 — ADAPTIVE MOSAIC
   Irregular tiles: some square, some tall, some ultra-wide. Selecting a tile
   expands it and pushes the others aside — there is no separate detail page.
   =========================================================================== */
export function AdaptiveMosaic({ cfg, d, industry }: LayoutProps) {
  const [open, setOpen] = useState<string | null>(null)

  const tiles = [
    { key: 'revenue', title: cfg.kpis[1]?.label ?? 'Revenue', span: 'col-span-12 lg:col-span-8 row-span-2', kpi: cfg.kpis[1],
      body: <Treemap items={d.treemap} height={190} />, big: <Treemap items={d.treemap} height={380} /> },
    { key: 'risk', title: 'Risk', span: 'col-span-12 sm:col-span-6 lg:col-span-4 row-span-2', kpi: cfg.kpis[6],
      body: <Heatmap rows={d.heat.rows.slice(0, 4)} cols={d.heat.cols.slice(0, 5)} values={d.heat.values.slice(0, 4).map((r) => r.slice(0, 5))} height={140} />,
      big: <Heatmap rows={d.heat.rows} cols={d.heat.cols} values={d.heat.values} height={330} /> },
    { key: 'customer', title: 'Customers', span: 'col-span-12 sm:col-span-6 lg:col-span-4', kpi: cfg.kpis[2],
      body: <DotDensity total={60} filled={41} cols={15} />, big: <DotDensity total={200} filled={138} cols={25} label="Accounts active this period" /> },
    { key: 'operations', title: 'Operations', span: 'col-span-12 lg:col-span-8', kpi: cfg.kpis[3],
      body: <FlowBars left={d.flow.left} right={d.flow.right} height={150} />, big: <FlowBars left={d.flow.left} right={d.flow.right} height={340} /> },
    { key: 'market', title: 'Market', span: 'col-span-12 lg:col-span-7', kpi: cfg.kpis[4],
      body: <Waterfall steps={d.waterfall} height={150} />, big: <Waterfall steps={d.waterfall} height={330} /> },
    { key: 'people', title: 'People', span: 'col-span-12 sm:col-span-6 lg:col-span-5', kpi: cfg.kpis[5],
      body: <RankBars rows={cfg.ranking.rows.slice(0, 4)} />, big: <RankBars rows={cfg.ranking.rows} /> },
    { key: 'cash', title: 'Cash', span: 'col-span-12', kpi: cfg.kpis[7] ?? cfg.kpis[0],
      body: <StepLine data={d.volume} height={110} />, big: <StepLine data={d.volume} height={300} /> },
  ]

  return (
    <div className="px-4 pb-10 pt-4 sm:px-6">
      <div className="mb-3 flex justify-end"><DashActions cfg={cfg} compact /></div>
      <div className="grid auto-rows-[minmax(150px,auto)] grid-cols-12 gap-3">
        {tiles.map((t) => {
          const isOpen = open === t.key
          const hidden = open && !isOpen
          return (
            <button
              key={t.key}
              onClick={() => setOpen(isOpen ? null : t.key)}
              className={cx('overflow-hidden rounded-2xl border p-4 text-left transition-all duration-500 ease-premium',
                isOpen ? 'col-span-12 row-span-3' : hidden ? 'col-span-6 row-span-1 sm:col-span-4 lg:col-span-3 opacity-70' : t.span,
                'hover:border-[hsl(var(--primary))]')}
              style={{ background: 'hsl(var(--card))' }}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[11px] uppercase tracking-wider muted">{t.title}</p>
                  {t.kpi && (
                    <p className={cx('mt-1 font-semibold leading-none tabular-nums', isOpen ? 'text-[34px]' : 'text-[22px]')}>
                      {t.kpi.value}
                    </p>
                  )}
                </div>
                {t.kpi && <span className="ml-auto shrink-0"><Delta up={t.kpi.up}>{t.kpi.delta}</Delta></span>}
                <Maximize2 className="h-3.5 w-3.5 shrink-0 muted" />
              </div>
              {!hidden && <div className="mt-4">{isOpen ? t.big : t.body}</div>}
              {isOpen && (
                <div className="mt-6 grid gap-6 border-t pt-5 md:grid-cols-3">
                  <Region title="Signals"><AlertList cfg={cfg} limit={3} compact /></Region>
                  <Region title="Pending"><ApprovalList cfg={cfg} limit={3} /></Region>
                  <Region title="Scope">
                    <ul className="space-y-1.5 text-[12px] muted">
                      {industry.scope.sites.slice(0, 4).map((s) => <li key={s} className="truncate">{s}</li>)}
                    </ul>
                  </Region>
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
