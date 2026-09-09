import { useId } from 'react'
import { cx } from '@/lib/utils'

/* ---------------------------------------------------------------------------
   Visualisation primitives for the ten dashboard layouts.

   These are hand-drawn SVG rather than another charting dependency: the shapes
   the layouts need — bullets, dot plots, ridgelines, waterfalls, spines,
   packed circles — are mostly not in a chart library anyway, and at these
   sizes a library costs more than it saves.

   Every primitive draws in currentColor or in the theme's own tokens, so all
   ten interfaces get their own palette without any per-UI branching here.
   --------------------------------------------------------------------------- */

const ACCENT = 'hsl(var(--primary))'
const RULE = 'hsl(var(--border))'
const MUTE = 'hsl(var(--muted-foreground))'

const path = (pts: [number, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ')
const norm = (v: number, min: number, max: number) => (max === min ? 0.5 : (v - min) / (max - min))

/* ------------------------------------------------------------- Sparkline */
export function Sparkline({ data, w = 96, h = 26, area = true, stroke = ACCENT, className }: {
  data: number[]; w?: number; h?: number; area?: boolean; stroke?: string; className?: string
}) {
  const id = useId()
  const min = Math.min(...data), max = Math.max(...data)
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * w,
    h - 2 - norm(v, min, max) * (h - 5),
  ] as [number, number])
  const last = pts[pts.length - 1]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cx('overflow-visible', className)}
      /* The width is a ceiling, not a size: the viewBox scales, so in a column
         narrower than w the curve compresses instead of overflowing. */
      style={{ width: '100%', maxWidth: w, height: h }} aria-hidden>
      {area && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${path(pts)} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
        </>
      )}
      <path d={path(pts)} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2" fill={stroke} />
    </svg>
  )
}

/* ---------------------------------------------------------------- Bullet */
/** Actual against target on a banded scale — the honest KPI shape. */
export function Bullet({ value, target, max, label, sub, tone = ACCENT }: {
  value: number; target: number; max: number; label?: string; sub?: string; tone?: string
}) {
  const pv = Math.min(100, (value / max) * 100)
  const pt = Math.min(100, (target / max) * 100)
  return (
    <div>
      {label && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="truncate text-[12px] font-medium">{label}</span>
          <span className="shrink-0 text-[11px] tabular-nums muted">{sub}</span>
        </div>
      )}
      <div className="relative h-[18px] overflow-hidden rounded-[3px]" style={{ background: 'hsl(var(--muted))' }}>
        <span className="absolute inset-y-0 left-0" style={{ width: `${pt * 0.66}%`, background: 'hsl(var(--foreground) / 0.06)' }} />
        <span className="absolute inset-y-0 left-0" style={{ width: `${pt}%`, background: 'hsl(var(--foreground) / 0.04)' }} />
        <span className="absolute inset-y-[5px] left-0 rounded-[2px]" style={{ width: `${pv}%`, background: tone }} />
        <span className="absolute inset-y-0 w-[2px]" style={{ left: `${pt}%`, background: 'hsl(var(--foreground) / 0.75)' }} />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- Dot plot */
export function DotPlot({ items, max }: { items: { name: string; value: number; tone?: string }[]; max?: number }) {
  const top = max ?? Math.max(...items.map((i) => i.value)) * 1.1
  return (
    <div className="space-y-2.5">
      {items.map((i) => (
        <div key={i.name} className="flex items-center gap-3">
          <span className="w-[38%] shrink-0 truncate text-[12px]">{i.name}</span>
          <span className="relative h-[10px] flex-1">
            <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2" style={{ background: RULE }} />
            <span
              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: `${(i.value / top) * 100}%`, background: i.tone ?? ACCENT }}
            />
          </span>
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums muted">{i.value}</span>
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------- Dumbbell */
/** Two states of the same row — plan against actual, before against after. */
export function Dumbbell({ items }: { items: { name: string; a: number; b: number }[] }) {
  const max = Math.max(...items.flatMap((i) => [i.a, i.b])) * 1.1
  return (
    <div className="space-y-3">
      {items.map((i) => {
        const x1 = (Math.min(i.a, i.b) / max) * 100
        const x2 = (Math.max(i.a, i.b) / max) * 100
        return (
          <div key={i.name} className="flex items-center gap-3">
            <span className="w-[34%] shrink-0 truncate text-[12px]">{i.name}</span>
            <span className="relative h-3 flex-1">
              <span className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded" style={{ left: `${x1}%`, width: `${x2 - x1}%`, background: RULE }} />
              <span className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${(i.a / max) * 100}%`, background: MUTE }} />
              <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${(i.b / max) * 100}%`, background: ACCENT }} />
            </span>
            <span className="w-12 shrink-0 text-right text-[11px] tabular-nums muted">{i.b - i.a > 0 ? '+' : ''}{i.b - i.a}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------- Waterfall */
/** How a number got from its opening to its closing balance. */
export function Waterfall({ steps, height = 200 }: {
  steps: { name: string; value: number; kind?: 'start' | 'end' }[]; height?: number
}) {
  let run = 0
  const bars = steps.map((s) => {
    const isTotal = s.kind === 'start' || s.kind === 'end'
    const base = isTotal ? 0 : run
    if (!isTotal) run += s.value
    else run = s.value
    return { ...s, base, top: isTotal ? s.value : base + s.value, isTotal }
  })
  const max = Math.max(...bars.map((b) => Math.max(b.base, b.top))) * 1.08
  const w = 100 / bars.length

  return (
    <div className="w-full" style={{ height }}>
      <div className="relative h-[calc(100%-22px)]">
        {bars.map((b, i) => {
          const lo = Math.min(b.base, b.top), hi = Math.max(b.base, b.top)
          const bottom = (lo / max) * 100
          const h = Math.max(1.5, ((hi - lo) / max) * 100)
          const up = b.value >= 0
          return (
            <span
              key={b.name + i}
              className="absolute rounded-[2px]"
              style={{
                left: `${i * w + w * 0.18}%`, width: `${w * 0.64}%`,
                bottom: `${bottom}%`, height: `${h}%`,
                background: b.isTotal ? 'hsl(var(--foreground) / 0.55)' : up ? ACCENT : 'hsl(var(--destructive))',
              }}
              title={`${b.name}: ${b.value}`}
            />
          )
        })}
      </div>
      <div className="flex h-[22px] items-center">
        {bars.map((b, i) => (
          <span key={b.name + i} className="truncate px-0.5 text-center text-[9.5px] muted" style={{ width: `${w}%` }}>
            {b.name}
          </span>
        ))}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- Treemap */
/** Slice-and-dice rather than squarified: predictable, and legible at this size. */
export function Treemap({ items, height = 220 }: { items: { name: string; value: number }[]; height?: number }) {
  const total = items.reduce((a, i) => a + i.value, 0)
  const rows: { name: string; value: number }[][] = [[], [], []]
  items.forEach((it, i) => rows[i < 2 ? 0 : i < 5 ? 1 : 2].push(it))
  const rowShare = rows.map((r) => r.reduce((a, i) => a + i.value, 0) / total)

  return (
    <div className="flex w-full flex-col gap-1" style={{ height }}>
      {rows.map((row, ri) => {
        const rowTotal = row.reduce((a, i) => a + i.value, 0) || 1
        return (
          <div key={ri} className="flex min-h-0 gap-1" style={{ height: `${Math.max(12, rowShare[ri] * 100)}%` }}>
            {row.map((it, i) => (
              <div
                key={it.name}
                className="min-w-0 overflow-hidden rounded-[4px] p-2"
                style={{
                  width: `${(it.value / rowTotal) * 100}%`,
                  background: `hsl(var(--primary) / ${0.34 - (ri * 0.07) - i * 0.03})`,
                }}
                title={`${it.name}: ${it.value}`}
              >
                <p className="truncate text-[11px] font-medium leading-tight">{it.name}</p>
                <p className="truncate text-[10px] tabular-nums muted">{it.value}</p>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/* --------------------------------------------------------------- Heatmap */
export function Heatmap({ rows, cols, values, height = 180 }: {
  rows: string[]; cols: string[]; values: number[][]; height?: number
}) {
  const flat = values.flat()
  const min = Math.min(...flat), max = Math.max(...flat)
  return (
    <div className="w-full overflow-x-auto">
      <div style={{ minWidth: cols.length * 26 + 76 }}>
        <div className="flex" style={{ height }}>
          <div className="flex w-[52px] sm:w-[76px] shrink-0 flex-col justify-around pr-2 text-right">
            {rows.map((r) => <span key={r} className="truncate text-[10px] muted">{r}</span>)}
          </div>
          <div className="grid flex-1 gap-[2px]" style={{ gridTemplateRows: `repeat(${rows.length}, 1fr)` }}>
            {values.map((row, ri) => (
              <div key={ri} className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${cols.length}, 1fr)` }}>
                {row.map((v, ci) => (
                  <span
                    key={ci}
                    className="rounded-[2px]"
                    style={{ background: `hsl(var(--primary) / ${0.08 + norm(v, min, max) * 0.72})` }}
                    title={`${rows[ri]} · ${cols[ci]}: ${v}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="ml-[76px] mt-1 grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${cols.length}, 1fr)` }}>
          {cols.map((c) => <span key={c} className="truncate text-center text-[9px] muted">{c}</span>)}
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- Scatter */
export function Scatter({ points, xLabel, yLabel, height = 240, onSelect, selected }: {
  points: { name: string; x: number; y: number; r?: number; tone?: string }[]
  xLabel?: string; yLabel?: string; height?: number
  onSelect?: (name: string) => void; selected?: string
}) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y)
  const xMin = Math.min(...xs) * 0.92, xMax = Math.max(...xs) * 1.06
  const yMin = Math.min(...ys) * 0.92, yMax = Math.max(...ys) * 1.06
  return (
    <div className="w-full" style={{ height }}>
      <div className="relative h-[calc(100%-16px)] w-full">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {[25, 50, 75].map((g) => (
            <g key={g}>
              <line x1="0" y1={g} x2="100" y2={g} stroke={RULE} strokeWidth="0.25" />
              <line x1={g} y1="0" x2={g} y2="100" stroke={RULE} strokeWidth="0.25" />
            </g>
          ))}
        </svg>
        {points.map((p) => {
          const on = selected === p.name
          const size = on ? 13 : Math.round((p.r ?? 1.7) * 5)
          return (
            <button
              key={p.name}
              type="button"
              onClick={() => onSelect?.(p.name)}
              title={`${p.name} — ${xLabel ?? 'x'} ${p.x}, ${yLabel ?? 'y'} ${p.y}`}
              aria-label={p.name}
              data-tap-exempt
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full p-0"
              style={{
                left: `${norm(p.x, xMin, xMax) * 100}%`,
                top: `${100 - norm(p.y, yMin, yMax) * 100}%`,
                width: size, height: size, minHeight: size,
                background: p.tone ?? ACCENT,
                opacity: on ? 1 : 0.62,
                boxShadow: on ? '0 0 0 1.5px hsl(var(--foreground))' : undefined,
                cursor: onSelect ? 'pointer' : 'default',
              }}
            />
          )
        })}
      </div>
      <div className="flex justify-between text-[10px] muted">
        <span>{xLabel}</span><span>{yLabel}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ Radial ring */
export function RadialRing({ value, size = 132, thickness = 10, label, sub, tone = ACCENT }: {
  value: number; size?: number; thickness?: number; label?: string; sub?: string; tone?: string
}) {
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={thickness} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={thickness}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (value / 100) * c}
        />
      </svg>
      <div className="absolute text-center">
        <p className="text-[24px] font-semibold leading-none tabular-nums">{value}%</p>
        {label && <p className="mt-1 text-[10px] uppercase tracking-wider muted">{label}</p>}
        {sub && <p className="text-[10px] muted">{sub}</p>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- Ridgeline */
/** Stacked density curves — a lot of distributions in very little height. */
export function Ridgeline({ series, height = 24, gap = 10 }: {
  series: { name: string; data: number[] }[]; height?: number; gap?: number
}) {
  return (
    <div className="space-y-0" style={{ marginTop: 4 }}>
      {series.map((s, si) => {
        const min = Math.min(...s.data), max = Math.max(...s.data)
        const pts = s.data.map((v, i) => [
          (i / (s.data.length - 1)) * 100,
          height - norm(v, min, max) * (height - 3),
        ] as [number, number])
        return (
          <div key={s.name} className="flex items-center gap-3" style={{ marginTop: si ? -gap * 0.25 : 0 }}>
            <span className="w-[56px] sm:w-[74px] shrink-0 truncate text-right text-[10px] muted">{s.name}</span>
            <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="h-6 flex-1">
              <path d={`${path(pts)} L100,${height} L0,${height} Z`} fill={ACCENT} fillOpacity={0.16} />
              <path d={path(pts)} fill="none" stroke={ACCENT} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------ Packed dots */
/** Dot density — one mark per unit, so quantity is countable, not just tall. */
export function DotDensity({ total, filled, cols = 20, label }: {
  total: number; filled: number; cols?: number; label?: string
}) {
  return (
    <div>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="aspect-square rounded-full"
            style={{ background: i < filled ? ACCENT : 'hsl(var(--foreground) / 0.09)' }}
          />
        ))}
      </div>
      {label && <p className="mt-2 text-[11px] muted">{label}</p>}
    </div>
  )
}

/* ---------------------------------------------------------------- Sankey */
/** Two-stage flow. Enough to show where volume goes without a graph engine. */
export function FlowBars({ left, right, height = 190 }: {
  left: { name: string; value: number }[]; right: { name: string; value: number }[]; height?: number
}) {
  const lt = left.reduce((a, i) => a + i.value, 0)
  const rt = right.reduce((a, i) => a + i.value, 0)
  const col = (items: { name: string; value: number }[], total: number, align: 'left' | 'right') => (
    <div className="flex h-full flex-1 flex-col gap-1">
      {items.map((i, k) => (
        <div
          key={i.name}
          className={cx('flex min-h-0 items-center overflow-hidden rounded-[3px] px-2',
            align === 'right' && 'justify-end text-right')}
          style={{ height: `${(i.value / total) * 100}%`, background: `hsl(var(--primary) / ${0.3 - k * 0.04})` }}
        >
          <span className="truncate text-[10.5px] leading-tight">{i.name}</span>
        </div>
      ))}
    </div>
  )
  return (
    <div className="flex w-full items-stretch gap-2" style={{ height }}>
      {col(left, lt, 'left')}
      <svg viewBox="0 0 40 100" preserveAspectRatio="none" className="h-full w-10 shrink-0">
        {left.map((_, i) => (
          <path
            key={i}
            d={`M0,${(i / left.length) * 100 + 6} C20,${(i / left.length) * 100 + 6} 20,${(i / right.length) * 100 + 10} 40,${(i / right.length) * 100 + 10}`}
            fill="none" stroke={ACCENT} strokeOpacity="0.22" strokeWidth={4}
          />
        ))}
      </svg>
      {col(right, rt, 'right')}
    </div>
  )
}

/* ------------------------------------------------------------- Step line */
export function StepLine({ data, height = 150, tone = ACCENT }: { data: number[]; height?: number; tone?: string }) {
  const min = Math.min(...data), max = Math.max(...data)
  const step = 100 / (data.length - 1)
  let d = ''
  data.forEach((v, i) => {
    const y = 100 - norm(v, min, max) * 92 - 4
    const x = i * step
    d += i === 0 ? `M${x},${y}` : ` H${x} V${y}`
  })
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} className="w-full">
      <path d={`${d} V100 H0 Z`} fill={tone} fillOpacity="0.12" />
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/* ------------------------------------------------------------ Volume bars */
/** The candlestick-adjacent shape: volume with an up/down cast. */
export function VolumeBars({ data, height = 120, tone = ACCENT }: { data: number[]; height?: number; tone?: string }) {
  const max = Math.max(...data)
  return (
    <div className="flex w-full items-end gap-[2px]" style={{ height }}>
      {data.map((v, i) => (
        <span
          key={i}
          className="flex-1 rounded-[1px]"
          style={{
            height: `${(v / max) * 100}%`,
            background: i > 0 && v < data[i - 1] ? 'hsl(var(--foreground) / 0.22)' : tone,
            opacity: i > 0 && v < data[i - 1] ? 1 : 0.9,
          }}
        />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ Gauge arc */
export function ProgressArc({ value, size = 180, label }: { value: number; size?: number; label?: string }) {
  const r = size / 2 - 14
  const circ = Math.PI * r
  return (
    <div className="relative" style={{ width: size, height: size / 2 + 18 }}>
      <svg width={size} height={size / 2 + 18} viewBox={`0 0 ${size} ${size / 2 + 18}`}>
        <path d={`M14,${size / 2} A${r},${r} 0 0 1 ${size - 14},${size / 2}`} fill="none" stroke="hsl(var(--muted))" strokeWidth="12" strokeLinecap="round" />
        <path
          d={`M14,${size / 2} A${r},${r} 0 0 1 ${size - 14},${size / 2}`}
          fill="none" stroke={ACCENT} strokeWidth="12" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ - (value / 100) * circ}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <p className="text-[26px] font-semibold leading-none tabular-nums">{value}%</p>
        {label && <p className="mt-1 text-[10px] uppercase tracking-wider muted">{label}</p>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ Mini bars */
export function MiniBars({ data, height = 30, tone = ACCENT }: { data: number[]; height?: number; tone?: string }) {
  const max = Math.max(...data)
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {data.map((v, i) => (
        <span key={i} className="w-1.5 rounded-[1px]" style={{ height: `${(v / max) * 100}%`, background: tone, opacity: 0.35 + (i / data.length) * 0.65 }} />
      ))}
    </div>
  )
}
