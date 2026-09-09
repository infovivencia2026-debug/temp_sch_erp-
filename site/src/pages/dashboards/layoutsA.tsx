import { useState } from 'react'
import { ChevronRight, ChevronsLeft, ChevronsRight, CornerDownLeft, Search } from 'lucide-react'
import { AreaTrend, BarSeries, Donut } from '@/components/charts'
import {
  Bullet, DotDensity, DotPlot, Dumbbell, FlowBars, Heatmap, RadialRing, Ridgeline,
  Scatter, Sparkline, Treemap, Waterfall,
} from '@/components/viz'
import { AlertList, ApprovalList, DashActions, Delta, Eyebrow, RankBars, Region } from './parts'
import type { LayoutProps } from './types'
import { useApp } from '@/hooks/useAppState'
import { cx } from '@/lib/utils'
import { useIsPhone } from '@/hooks/useMedia'

/* ===========================================================================
   UI-01 — EDITORIAL SPLIT
   An asymmetric editorial page: one full-width headline, then three unequal
   columns (facts 20 / story 50 / risks 30), then two wide analytical bands.
   No sidebar, no card grid, no equal columns.
   =========================================================================== */
export function EditorialSplit({ cfg, d, industry }: LayoutProps) {
  const lead = cfg.kpis[0]
  return (
    <div className="px-6 pb-14 sm:px-10">
      {/* Headline — the only full-width element on the page */}
      <header className="border-b py-10">
        <Eyebrow>{industry.label} · {cfg.greeting}</Eyebrow>
        <div className="mt-5 flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <p className="text-[13px] muted">{lead.label}</p>
            <p className="text-[clamp(2.75rem,6vw,4.5rem)] font-semibold leading-none tracking-[-0.04em] tabular-nums">
              {lead.value}
            </p>
          </div>
          <div className="pb-2">
            <Delta up={lead.up}>{lead.delta} versus the prior period</Delta>
            <p className="mt-2 max-w-[46ch] text-[14px] leading-relaxed muted">
              {cfg.alerts[0].title}. {cfg.alerts[1]?.detail}.
            </p>
          </div>
          <div className="ml-auto flex flex-col items-end gap-3 pb-1">
            <DashActions cfg={cfg} />
            <Sparkline data={d.spark[lead.label]} w={190} h={54} />
          </div>
        </div>
      </header>

      {/* Three unequal columns */}
      <div className="grid gap-x-10 gap-y-10 border-b py-10 lg:grid-cols-[20fr_50fr_30fr]">
        <Region title="Quick facts">
          <dl className="space-y-4">
            {cfg.secondary.map((s) => (
              <div key={s.label} className="border-b pb-3 last:border-0">
                <dt className="text-[11px] uppercase tracking-wide muted">{s.label}</dt>
                <dd className="mt-1 text-[19px] font-semibold tabular-nums">{s.value}</dd>
              </div>
            ))}
          </dl>
        </Region>

        <Region title={cfg.trend.title} sub={cfg.trend.subtitle}>
          <p className="mb-4 max-w-[62ch] text-[14px] leading-relaxed">
            {cfg.kpis[1].label} stands at <strong className="font-semibold">{cfg.kpis[1].value}</strong>{' '}
            <Delta up={cfg.kpis[1].up}>{cfg.kpis[1].delta}</Delta>, while {cfg.kpis[3].label.toLowerCase()} reads{' '}
            <strong className="font-semibold">{cfg.kpis[3].value}</strong>. The trend below carries the story.
          </p>
          <AreaTrend data={cfg.trend.data} keys={cfg.trend.keys} height={260} />
          <div className="mt-5 grid grid-cols-1 gap-6 border-t pt-4 sm:grid-cols-3">
            {cfg.kpis.slice(1, 4).map((k) => (
              <div key={k.label}>
                <p className="truncate text-[11px] muted">{k.label}</p>
                <p className="mt-0.5 text-[17px] font-semibold tabular-nums">{k.value}</p>
                <Sparkline data={d.spark[k.label]} w={72} h={18} />
              </div>
            ))}
          </div>
        </Region>

        <Region title="Risks & decisions">
          <AlertList cfg={cfg} limit={4} />
          <h4 className="mb-3 mt-6 text-[12px] font-semibold">Awaiting a decision</h4>
          <ApprovalList cfg={cfg} limit={4} />
          <h4 className="mb-3 mt-6 text-[12px] font-semibold">Spread by unit</h4>
          <DotPlot items={d.sectors.map((s) => ({ name: s.name, value: s.value }))} max={100} />
        </Region>
      </div>

      {/* Two wide analytical bands */}
      <div className="grid gap-10 py-10 lg:grid-cols-[62fr_38fr]">
        <Region title="Financial analysis" sub="Opening to closing, by movement">
          <Waterfall steps={d.waterfall} height={230} />
        </Region>
        <Region title="Outlook" sub={cfg.ranking.subtitle}>
          <RankBars rows={cfg.ranking.rows} />
          <div className="mt-6 border-t pt-4">
            <Dumbbell items={d.dumbbell} />
          </div>
        </Region>
      </div>
    </div>
  )
}

/* ===========================================================================
   UI-02 — RADIAL COMMAND CENTER
   A circular composition: enterprise health at the centre, five wedge sectors
   around it, thresholds and alerts on the outer perimeter. No rows, no grid.
   =========================================================================== */
export function RadialCommand({ cfg, d }: LayoutProps) {
  const [sel, setSel] = useState<string | null>(null)
  const health = Math.round(d.sectors.reduce((a, s) => a + s.value, 0) / d.sectors.length)
  const selected = d.sectors.find((s) => s.name === sel)

  return (
    <div className="flex min-h-[calc(100dvh-140px)] gap-6 px-6 py-6 sm:px-10">
      <div className="relative min-w-0 flex-1">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <Eyebrow>Enterprise health</Eyebrow>
            <p className="mt-1 text-[13px] muted">{cfg.greeting}</p>
          </div>
          <DashActions cfg={cfg} compact />
        </div>

        {/* The ring stays the centrepiece, but the sectors sit in real columns
            either side of it. Placing them by angle put 188px cards on a circle
            that shrank with the viewport, so below a wide desktop they climbed
            over each other and over the caption. Flanking columns keep the
            radial reading at every width. */}
        <div className="grid items-center gap-4 lg:grid-cols-[1fr_auto_1fr]">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            {d.sectors.slice(0, 2).map((s, i) => <Sector key={s.name} s={s} i={i} d={d} sel={sel} setSel={setSel} />)}
          </div>

          <div className="relative mx-auto grid place-items-center py-2">
            <div className="pointer-events-none absolute h-[min(290px,72vw)] w-[min(290px,72vw)] rounded-full border opacity-40" />
            <div className="pointer-events-none absolute h-[min(228px,58vw)] w-[min(228px,58vw)] rounded-full border opacity-60" />
            <RadialRing value={health} size={172} thickness={13} label="Enterprise health" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            {d.sectors.slice(2, 4).map((s, i) => <Sector key={s.name} s={s} i={i + 2} d={d} sel={sel} setSel={setSel} />)}
          </div>

          {d.sectors[4] && (
            <div className="lg:col-span-3 lg:mx-auto lg:w-[260px]">
              <Sector s={d.sectors[4]} i={4} d={d} sel={sel} setSel={setSel} />
            </div>
          )}
        </div>

        {/* lower perimeter: alert waveform */}
        <div className="mt-2 rounded-xl border p-4">
          <Eyebrow>Alert intensity · last 26 intervals</Eyebrow>
          <div className="mt-3 flex items-end gap-[3px]">
            {d.volume.map((v, i) => (
              <span key={i} className="flex-1 rounded-[1px]"
                style={{ height: 6 + (v / 100) * 34, background: v > 78 ? 'hsl(var(--destructive))' : v > 55 ? 'hsl(var(--warning, 40 90% 50%))' : 'hsl(var(--primary))', opacity: 0.85 }} />
            ))}
          </div>
        </div>
      </div>

      {/* context drawer — appears only after a selection */}
      {selected && (
        <aside className="hidden w-[300px] shrink-0 rounded-2xl border p-5 xl:block">
          <Eyebrow>{selected.name}</Eyebrow>
          <p className="mt-2 text-[32px] font-semibold leading-none tabular-nums">{selected.value}</p>
          <Delta up={selected.up}>{selected.delta}</Delta>
          <div className="mt-5 border-t pt-4">
            <p className="mb-2 text-[12px] font-semibold">Contributing</p>
            <RankBars rows={cfg.ranking.rows.slice(0, 4)} />
          </div>
          <div className="mt-5 border-t pt-4">
            <p className="mb-2 text-[12px] font-semibold">Thresholds</p>
            <AlertList cfg={cfg} limit={3} compact />
          </div>
        </aside>
      )}
    </div>
  )
}

/* ===========================================================================
   UI-03 — DENSE MATRIX WALL
   A uniform 12-column analytical matrix. No hero, no centrepiece, no floating
   cards — everything packed to the same rhythm.
   =========================================================================== */
export function MatrixWall({ cfg, d }: LayoutProps) {
  return (
    <div className="px-4 pb-8">
      {/* two narrow utility bars */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b py-2 text-[11px]">
        <span className="font-semibold uppercase tracking-wider">{cfg.greeting}</span>
        {cfg.secondary.map((s) => (
          <span key={s.label} className="muted">{s.label} <b className="text-foreground tabular-nums">{s.value}</b></span>
        ))}
        <span className="ml-auto"><DashActions cfg={cfg} compact /></span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b py-1.5 text-[11px] muted">
        {cfg.alerts.map((a) => (
          <span key={a.title} className="flex items-center gap-1.5">
            <span className={cx('h-1.5 w-1.5 rounded-full',
              a.tone === 'red' ? 'bg-rose-500' : a.tone === 'amber' ? 'bg-amber-500' : 'bg-sky-500')} />
            {a.title}
          </span>
        ))}
      </div>

      {/* 12-column matrix */}
      <div className="mt-3 grid grid-cols-12 gap-2">
        {cfg.kpis.slice(0, 6).map((k) => (
          <div key={k.label} className="col-span-6 border p-2.5 sm:col-span-4 lg:col-span-2">
            <p className="truncate text-[10px] uppercase tracking-wide muted">{k.label}</p>
            <p className="mt-1 text-[20px] font-semibold leading-none tabular-nums">{k.value}</p>
            <div className="mt-1.5 flex items-center justify-between gap-1">
              <Delta up={k.up}>{k.delta}</Delta>
              <Sparkline data={d.spark[k.label]} w={44} h={14} />
            </div>
          </div>
        ))}

        <div className="col-span-12 border p-3 lg:col-span-6">
          <Eyebrow>Density by department and week</Eyebrow>
          <div className="mt-2"><Heatmap rows={d.heat.rows} cols={d.heat.cols} values={d.heat.values} height={166} /></div>
        </div>
        <div className="col-span-12 border p-3 sm:col-span-6 lg:col-span-3">
          <Eyebrow>Performance vs cost</Eyebrow>
          <Scatter points={d.scatter} xLabel="Cost index" yLabel="Performance" height={182} />
        </div>
        <div className="col-span-12 border p-3 sm:col-span-6 lg:col-span-3">
          <Eyebrow>Distribution</Eyebrow>
          <div className="mt-2"><Ridgeline series={d.ridges.slice(0, 4)} height={20} /></div>
        </div>

        {cfg.ranking.rows.slice(0, 6).map((r) => (
          <div key={r.name} className="col-span-6 border p-2.5 sm:col-span-4 lg:col-span-2">
            <p className="truncate text-[10.5px] muted">{r.name}</p>
            <p className="mt-0.5 text-[15px] font-semibold tabular-nums">{r.value}%</p>
            <span className="mt-1.5 block h-1 rounded-[1px]" style={{ background: 'hsl(var(--muted))' }}>
              <span className="block h-full rounded-[1px]" style={{ width: `${r.value}%`, background: 'hsl(var(--primary))' }} />
            </span>
          </div>
        ))}

        <div className="col-span-12 border p-3 lg:col-span-7">
          <Eyebrow>Correlation matrix</Eyebrow>
          <div className="mt-2">
            <Heatmap rows={d.heat.rows.slice(0, 5)} cols={d.heat.rows.slice(0, 5).map((r) => r.slice(0, 4))}
              values={d.heat.values.slice(0, 5).map((row) => row.slice(0, 5))} height={132} />
          </div>
        </div>
        <div className="col-span-12 border p-3 lg:col-span-5">
          <Eyebrow>Ranking</Eyebrow>
          <div className="mt-2"><RankBars rows={cfg.ranking.rows} /></div>
        </div>
      </div>
    </div>
  )
}

/* ===========================================================================
   UI-04 — FREEFORM SPATIAL CANVAS
   No grid. Clusters placed on a canvas that extends past the viewport, with
   connections crossing it and an inspector that opens beside a selected node.
   =========================================================================== */
export function SpatialCanvas({ cfg, d, industry }: LayoutProps) {
  const [sel, setSel] = useState<string | null>(null)
  const isPhone = useIsPhone()

  const clusters = [
    { key: 'markets', label: 'Markets', x: 16, y: 16, items: industry.vocab.campus.slice(0, 4) },
    { key: 'customers', label: 'Customers', x: 74, y: 14, items: industry.vocab.company.slice(0, 4) },
    { key: 'products', label: cfg.mix.title.replace(/^.*by /i, '') || 'Products', x: 14, y: 68, items: cfg.mix.data.slice(0, 4).map((m) => m.name) },
    { key: 'initiatives', label: 'Initiatives', x: 76, y: 70, items: cfg.tasks.slice(0, 4).map((t) => t.title) },
  ]

  /* A 1680x1080 canvas on a 390px screen puts three quarters of the content
     behind two-axis panning, and the inspector overlay covers 83% of the
     width. The phone gets the same clusters as a list; the desktop branch
     below is untouched, because the canvas is what UI-14 is. */
  if (isPhone) {
    return (
      <div className="space-y-5 px-4 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Eyebrow>{industry.label}</Eyebrow>
            <p className="mt-1 text-[30px] font-semibold leading-none tabular-nums">{cfg.kpis[0].value}</p>
            <p className="mt-1 text-[12px] muted">{cfg.kpis[0].label}</p>
          </div>
          <DashActions cfg={cfg} compact />
        </div>

        {clusters.map((c) => (
          <section key={c.key} className="rounded-xl border">
            <header className="border-b px-4 py-2.5">
              <Eyebrow>{c.label}</Eyebrow>
            </header>
            <ul className="divide-y">
              {c.items.map((it, i) => (
                <li key={String(it)}>
                  <button
                    onClick={() => setSel(`point:${String(it)}`)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted/60"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px]">{String(it)}</span>
                    <span className="shrink-0 text-[13px] font-medium tabular-nums">
                      {cfg.mix.data[i % cfg.mix.data.length]?.value ?? '—'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="rounded-xl border p-4">
          <Eyebrow>{cfg.trend.title}</Eyebrow>
          <div className="mt-3">
            <Scatter points={d.scatter} xLabel={cfg.trend.subtitle} height={220}
              onSelect={(n) => setSel(`point:${n}`)} selected={sel?.split(':')[1]} />
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="relative min-h-[calc(100dvh-150px)] overflow-hidden">
      {/* the canvas itself, larger than the viewport */}
      <div className="relative h-[calc(100dvh-150px)] w-full overflow-auto">
        <div className="relative h-[1080px] w-[1680px] pb-24"
          style={{ backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>

          {/* connections drawn behind the nodes */}
          <svg className="absolute inset-0 h-full w-full" aria-hidden>
            {clusters.map((c) => (
              <line key={c.key}
                x1="50%" y1="50%" x2={`${c.x + 7}%`} y2={`${c.y + 6}%`}
                stroke="hsl(var(--border))" strokeWidth="1.5" strokeDasharray="4 4" />
            ))}
          </svg>

          {/* company node */}
          <button
            onClick={() => setSel('company')}
            className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 px-8 py-7 text-center transition-transform hover:scale-[1.03]"
            style={{ background: 'hsl(var(--card))', borderColor: 'hsl(var(--primary))' }}
          >
            <p className="text-[11px] uppercase tracking-widest muted">{industry.label}</p>
            <p className="mt-1 text-[30px] font-semibold leading-none tabular-nums">{cfg.kpis[0].value}</p>
            <p className="mt-1 text-[11px] muted">{cfg.kpis[0].label}</p>
          </button>

          {/* clusters of bubbles */}
          {clusters.map((c) => (
            <div key={c.key} className="absolute" style={{ left: `${c.x}%`, top: `${c.y}%` }}>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider muted">{c.label}</p>
              <div className="flex flex-wrap gap-2" style={{ maxWidth: 260 }}>
                {c.items.map((it, i) => {
                  const size = 96 - i * 12
                  const on = sel === `${c.key}:${it}`
                  return (
                    <button
                      key={it}
                      onClick={() => setSel(`${c.key}:${it}`)}
                      className={cx('grid place-items-center rounded-full border p-2 text-center transition-all duration-300',
                        on ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.12)]' : 'hover:bg-accent/60')}
                      style={{ width: size, height: size, background: on ? undefined : 'hsl(var(--card))' }}
                    >
                      <span className="line-clamp-3 text-[10px] leading-tight">{it}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}

          {/* an opportunity quadrant, floating as an object on the canvas */}
          {/* 70%, not 76%: at 76% this panel landed under the floating dock
              once the canvas was scrolled to its end. */}
          <div className="absolute rounded-2xl border p-4" style={{ left: '40%', top: '70%', width: 340, background: 'hsl(var(--card))' }}>
            <Eyebrow>Opportunity quadrant</Eyebrow>
            <Scatter points={d.scatter.slice(0, 9)} xLabel="Effort" yLabel="Return" height={150}
              onSelect={(n) => setSel(`point:${n}`)} selected={sel?.split(':')[1]} />
          </div>
        </div>
      </div>

      {/* floating navigation pill, detached from the edge */}
      <div className="absolute bottom-6 left-1/2 z-20 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full border px-2 py-1.5 shadow-lg scroll-x"
        style={{ background: 'hsl(var(--card))' }}>
        {clusters.map((c) => (
          <span key={c.key} className="shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[12px] muted">{c.label}</span>
        ))}
        <span className="ml-1 border-l pl-2"><DashActions cfg={cfg} compact /></span>
      </div>

      {/* inspector overlay beside the selection */}
      {sel && (
        <aside className="absolute right-6 top-6 z-20 w-[300px] rounded-2xl border p-5 shadow-xl" style={{ background: 'hsl(var(--card))' }}>
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <Eyebrow>{sel.split(':')[0]}</Eyebrow>
              <p className="mt-1 truncate text-[15px] font-semibold">{sel.split(':')[1] ?? industry.label}</p>
            </div>
            <button onClick={() => setSel(null)} className="ml-auto text-[11px] muted hover:text-foreground">Close</button>
          </div>
          <div className="mt-4 space-y-3 border-t pt-4">
            {cfg.kpis.slice(0, 3).map((k) => (
              <div key={k.label} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[12px] muted">{k.label}</span>
                <span className="shrink-0 text-[14px] font-semibold tabular-nums">{k.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t pt-4"><DotDensity total={60} filled={42} cols={12} label="Share of total activity" /></div>
        </aside>
      )}
    </div>
  )
}

/* ===========================================================================
   UI-05 — INTELLIGENCE TRIPTYCH
   Three fixed panes: saved queries 18%, analysis 57%, evidence 25%. The right
   pane never disappears — that is the point of the layout.
   =========================================================================== */
export function IntelligenceTriptych({ cfg, d, industry }: LayoutProps) {
  const { subPanelCollapsed: shut, setSubPanelCollapsed } = useApp()
  const [query, setQuery] = useState('Why did the trend move?')
  const [driver, setDriver] = useState(d.drivers[0]?.name ?? '')
  const active = d.drivers.find((x) => x.name === driver) ?? d.drivers[0]

  const QUERIES = [
    'Why did the trend move?',
    'Which units are behind plan?',
    'Where is cost concentrated?',
    'What changed this week?',
    'Which risks are rising?',
  ]

  return (
    <div className={cx('grid min-h-[calc(100dvh-150px)] grid-cols-1',
      shut ? 'lg:grid-cols-[56px_1fr]' : 'lg:grid-cols-[22fr_78fr]')}>
      {/* saved queries */}
      <aside className={cx('flex flex-col border-r', shut ? 'p-2' : 'p-5')}>
        {!shut && <Eyebrow>Saved queries</Eyebrow>}
        <ul className={cx('space-y-1', shut ? 'mt-0' : 'mt-3')}>
          {QUERIES.map((q) => (
            <li key={q}>
              <button
                onClick={() => setQuery(q)}
                aria-label={q}
                data-tip={shut ? q : undefined}
                className={cx('rail-tip flex w-full items-center gap-2 rounded-md py-2 text-left text-[12.5px] transition-colors',
                  shut ? 'justify-center px-0' : 'px-2.5',
                  q === query ? 'bg-accent font-medium' : 'muted hover:bg-accent/60')}
              >
                <Search className="h-3.5 w-3.5 shrink-0" />
                {!shut && <span className="truncate">{q}</span>}
              </button>
            </li>
          ))}
        </ul>
        {!shut && (
          <div className="mt-6 border-t pt-4">
            <Eyebrow>Segments</Eyebrow>
            <ul className="mt-2 space-y-1.5">
              {industry.vocab.dept.slice(0, 6).map((s) => (
                <li key={s} className="truncate text-[12px] muted">{s}</li>
              ))}
            </ul>
          </div>
        )}
        {/* The same control the shells' panels carry, on the same flag, so a
            wide left column behaves the same whether it belongs to the shell
            or to the dashboard. */}
        <button
          onClick={() => setSubPanelCollapsed(!shut)}
          aria-label={shut ? 'Expand saved queries' : 'Collapse saved queries'}
          aria-expanded={!shut}
          data-tip={shut ? 'Expand' : undefined}
          className={cx('rail-tip mt-auto flex h-9 items-center gap-2 rounded-lg text-[12px] muted transition-colors hover:bg-accent/60 hover:text-foreground',
            shut ? 'justify-center px-0' : 'px-2.5')}
        >
          {shut ? <ChevronsRight className="h-4 w-4 shrink-0" /> : <><ChevronsLeft className="h-4 w-4 shrink-0" /> Collapse</>}
        </button>
      </aside>

      {/* centre pane — a section, not a second <main>: the shell owns that */}
      <section className="min-w-0 p-6">
        {/* The question and the actions shared one line, so on a phone the
            heading was left about 50px and read one word per line. */}
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <p className="text-[11px] uppercase tracking-wider muted">Analysis</p>
            <h2 className="mt-1 text-[22px] font-semibold tracking-tight">{query}</h2>
          </div>
          <span className="shrink-0 sm:ml-auto"><DashActions cfg={cfg} compact /></span>
        </div>
        <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed muted">
          {cfg.kpis[0].label} is {cfg.kpis[0].value} ({cfg.kpis[0].delta}). The largest single contribution comes from{' '}
          <strong className="text-foreground">{active?.name}</strong>, and the forecast below assumes the current run rate holds.
        </p>

        {/* anomaly timeline under the summary */}
        <div className="mt-5 flex items-end gap-[3px] border-b pb-4">
          {d.volume.map((v, i) => (
            <span key={i} className="flex-1 rounded-[1px]"
              style={{ height: 4 + (v / 100) * 30, background: v > 84 ? 'hsl(var(--destructive))' : 'hsl(var(--primary))', opacity: v > 84 ? 1 : 0.4 }} />
          ))}
        </div>

        {/* driver tree dominates */}
        <Region className="mt-6" title="Driver tree" sub="Contribution to the change, by area">
          <div className="space-y-2">
            {d.drivers.map((dr) => (
              <button
                key={dr.name}
                onClick={() => setDriver(dr.name)}
                className={cx('w-full rounded-lg border p-3 text-left transition-colors',
                  dr.name === driver ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.06)]' : 'hover:bg-accent/50')}
              >
                <div className="flex items-center gap-3">
                  <span className="w-[30%] truncate text-[12.5px] font-medium">{dr.name}</span>
                  <span className="relative h-2.5 flex-1 rounded-[2px]" style={{ background: 'hsl(var(--muted))' }}>
                    <span className="absolute inset-y-0 left-1/2 w-px" style={{ background: 'hsl(var(--foreground)/0.3)' }} />
                    <span className="absolute inset-y-0 rounded-[2px]"
                      style={{
                        left: dr.contribution >= 0 ? '50%' : `${50 - Math.abs(dr.contribution)}%`,
                        width: `${Math.abs(dr.contribution)}%`,
                        background: dr.contribution >= 0 ? 'hsl(var(--primary))' : 'hsl(var(--destructive))',
                      }} />
                  </span>
                  <span className="w-12 text-right text-[12px] tabular-nums">{dr.contribution > 0 ? '+' : ''}{dr.contribution}</span>
                  <ChevronRight className={cx('h-3.5 w-3.5 muted transition-transform', dr.name === driver && 'rotate-90')} />
                </div>
                {dr.name === driver && (
                  <div className="mt-3 space-y-1.5 border-t pt-3 pl-2">
                    {dr.sub.map((s) => (
                      <div key={s.name} className="flex items-center justify-between gap-3 text-[11.5px]">
                        <span className="truncate muted">{s.name}</span>
                        <span className="tabular-nums">{s.value > 0 ? '+' : ''}{s.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        </Region>

        <Region className="mt-6" title="Forecast" sub="Run rate carried forward">
          <AreaTrend data={cfg.money.data} keys={cfg.money.keys} height={190} />
        </Region>
      </section>

    </div>
  )
}

/** One sector of the radial dashboard. */
function Sector({ s, i, d, sel, setSel }: {
  s: { name: string; value: number; delta: string; up: boolean }
  i: number; d: any; sel: string | null; setSel: (v: string | null) => void
}) {
  return (
    <button
      onClick={() => setSel(s.name === sel ? null : s.name)}
      className={cx('w-full rounded-2xl border p-4 text-left transition-all duration-300',
        sel === s.name ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]' : 'hover:bg-accent/50')}
    >
      <p className="text-[11px] uppercase tracking-wider muted">{s.name}</p>
      <p className="mt-1.5 text-[26px] font-semibold leading-none tabular-nums">{s.value}</p>
      <div className="mt-2 flex items-center justify-between">
        <Delta up={s.up}>{s.delta}</Delta>
        <Sparkline data={d.ridges[i % d.ridges.length].data.slice(0, 10)} w={48} h={16} />
      </div>
    </button>
  )
}
