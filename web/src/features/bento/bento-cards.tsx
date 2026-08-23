import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* The editorial card vocabulary — see docs/BENTO_CARD_PATTERNS.md.

   Twelve drawings, one card shell, and a single colour rule: every mark is
   `currentColor`. The cell has already resolved its own ink — black on a pale
   tint, white on a dark one — so a drawing that inherits is correct on all
   twelve domain grounds, both default themes and all four shipped palettes
   without a branch anywhere in here. Nothing in this file names a colour.

   Tracks, grounds and the quiet end of a ramp are that same ink at low alpha,
   which is why they stay legible when the ink flips.

   `big` from the reference is deliberately not built: it is the figure at a
   larger size, and the figure already has a row of its own. Every drawing here
   has to add something the number does not. */

/** Ink at a given strength. The only colour expression in this file. */
const ink = (pct: number) => `color-mix(in srgb, currentColor ${pct}%, transparent)`

const MARK = ink(88)
const TRACK = ink(10)
const QUIET = ink(38)

/* ── the shell ─────────────────────────────────────────────────────────── */

/** The three-row card: header, figure, drawing.

    The drawing row is `minmax(0,1fr)` so it takes whatever is left rather than
    a fixed height — that is what stops a large cell being a small cell with
    dead space under it. `min-h-0` on the row is load-bearing: without it a
    grid child refuses to shrink below its content and the drawing pushes the
    card out of shape. */
export function CardShell({
  title, sub, glyph, value, change, children, className,
}: {
  title: string
  sub?: string
  glyph?: ReactNode
  value: ReactNode
  change?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]', className)}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-bold leading-tight">{title}</p>
          {sub && (
            <p className="mt-0.5 truncate text-[8.5px] font-medium uppercase tracking-[0.08em] opacity-60">
              {sub}
            </p>
          )}
        </div>
        {glyph && (
          <span
            className="grid size-[22px] shrink-0 place-items-center rounded-full border text-[9px]"
            style={{ borderColor: ink(35) }}
            aria-hidden="true"
          >
            {glyph}
          </span>
        )}
      </div>

      <div className="mt-1.5 min-w-0">
        <p className="truncate text-[length:var(--bento-fig,clamp(24px,3.4vh,38px))] font-semibold leading-[0.9] tracking-[-0.05em] tabular-nums">
          {value}
        </p>
        {change && <p className="mt-1 truncate text-[9.5px] leading-none opacity-65">{change}</p>}
      </div>

      <div className="mt-2 min-h-0 min-w-0 overflow-hidden">{children}</div>
    </div>
  )
}

/* ── drawings ──────────────────────────────────────────────────────────── */

function svgPath(points: number[], h = 150, w = 400) {
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const range = hi - lo || 1
  return points
    .map((v, i) => {
      const x = (i * w) / (points.length - 1 || 1)
      const y = h - 5 - ((v - lo) / range) * (h - 20)
      return `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

/** Trend. An open path, nothing under it. */
export function Line({ points, srLabel }: { points: number[]; srLabel: string }) {
  if (points.length < 2) return null
  return (
    <svg viewBox="0 0 400 150" preserveAspectRatio="none" className="h-full w-full"
         role="img" aria-label={srLabel}>
      <path d={svgPath(points)} fill="none" stroke={MARK} strokeWidth={2.5}
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Magnitude and trend: the same line with the ground filled beneath it. */
export function Area({ points, srLabel }: { points: number[]; srLabel: string }) {
  if (points.length < 2) return null
  const d = svgPath(points)
  return (
    <svg viewBox="0 0 400 150" preserveAspectRatio="none" className="h-full w-full"
         role="img" aria-label={srLabel}>
      <path d={`${d} L 400 150 L 0 150 Z`} fill={ink(14)} stroke="none" />
      <path d={d} fill="none" stroke={MARK} strokeWidth={2.5}
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Period comparison. Bottom-aligned, rounded tops. */
export function Bars({ values, activeIndex, srLabel }: {
  values: number[]; activeIndex?: number; srLabel: string
}) {
  if (!values.length) return null
  const hi = Math.max(...values) || 1
  return (
    <div className="flex h-full items-end gap-1" role="img" aria-label={srLabel}>
      {values.map((v, i) => (
        <span key={i} className="min-w-0 flex-1 rounded-t-[3px]"
              style={{
                height: `${Math.max(3, (v / hi) * 100)}%`,
                background: activeIndex === undefined || i === activeIndex ? MARK : QUIET,
              }} />
      ))}
    </div>
  )
}

/** Ranked composition: label, track, figure. The bars share one scale. */
export function Rows({ items, srLabel, formatValue }: {
  items: { label: string; value: number }[]
  srLabel: string
  formatValue?: (n: number) => string
}) {
  if (!items.length) return null
  const hi = Math.max(...items.map((i) => i.value)) || 1
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    <div className="flex h-full flex-col justify-end gap-1.5" role="img" aria-label={srLabel}>
      {items.map((it) => (
        <div key={it.label} className="grid grid-cols-[minmax(38px,auto)_minmax(0,1fr)_auto] items-center gap-1.5">
          <span className="truncate text-[8px] font-medium uppercase tracking-[0.06em] opacity-70">
            {it.label}
          </span>
          <span className="h-3 overflow-hidden rounded-[3px]" style={{ background: TRACK }}>
            <span className="block h-full rounded-[3px]"
                  style={{ width: `${Math.min(100, (it.value / hi) * 100)}%`, background: MARK }} />
          </span>
          <b className="text-[9px] font-bold tabular-nums">{fmt(it.value)}</b>
        </div>
      ))}
    </div>
  )
}

/** One proportion, as a stroked arc. Needs a real total.

    Drawn as an SVG stroke rather than a conic-gradient with a disc punched out
    of the middle. The punched version had to paint that disc SOME colour, and
    it painted `--bento-card` — correct on a paper cell and wrong on every
    other one. On a domain-tinted card it showed a paper-coloured hole; on an
    inverted cell a pale disc on a dark ground. A stroke has no hole to fill,
    so the ground shows through whatever the ground happens to be.

    The arc opens at twelve o'clock and runs clockwise. `pathLength` is set to
    100 so the dash array is literally the percentage — no circumference
    arithmetic to get wrong when the radius changes. */
export function Gauge({ value, total, srLabel }: { value: number; total: number; srLabel: string }) {
  if (total <= 0) return null
  const pct = Math.max(0, Math.min(100, Math.round((value / total) * 100)))
  return (
    <div className="grid h-full place-items-center" role="img" aria-label={srLabel}>
      <div className="relative grid aspect-square w-[78%] max-w-[104px] place-items-center">
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90">
          <circle cx="50" cy="50" r="42" fill="none" stroke={TRACK} strokeWidth={11} />
          {pct > 0 && (
            <circle
              cx="50" cy="50" r="42" fill="none"
              stroke={MARK} strokeWidth={11} strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${pct} ${100 - pct}`}
            />
          )}
        </svg>
        <span className="relative text-[13px] font-semibold tabular-nums">{pct}%</span>
      </div>
    </div>
  )
}

/** Composition over periods: columns split into segments. */
export function Stack({ columns, srLabel }: {
  columns: { total: number; parts: number[] }[]; srLabel: string
}) {
  if (!columns.length) return null
  const hi = Math.max(...columns.map((c) => c.total)) || 1
  return (
    <div className="flex h-full items-end gap-1.5" role="img" aria-label={srLabel}>
      {columns.map((c, i) => (
        <span key={i} className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-t-[3px]"
              style={{ height: `${Math.max(4, (c.total / hi) * 100)}%` }}>
          {c.parts.map((p, j) => (
            <span key={j} style={{
              height: `${(p / (c.total || 1)) * 100}%`,
              background: ink(88 - j * 26),
            }} />
          ))}
        </span>
      ))}
    </div>
  )
}

/** Spread. Bars whose heights describe a curve rather than a ranking. */
export function Distribution({ values, srLabel }: { values: number[]; srLabel: string }) {
  if (!values.length) return null
  const hi = Math.max(...values) || 1
  return (
    <div className="flex h-full items-end gap-1" role="img" aria-label={srLabel}>
      {values.map((v, i) => (
        <span key={i} className="min-w-0 flex-1 rounded-t-[3px]"
              style={{ height: `${Math.max(3, (v / hi) * 100)}%`, background: MARK }} />
      ))}
    </div>
  )
}

/** Two labelled tracks against one scale — plan over actual. */
export function Compare({ rows, srLabel, formatValue }: {
  rows: { label: string; value: number }[]
  srLabel: string
  formatValue?: (n: number) => string
}) {
  if (rows.length < 2) return null
  const hi = Math.max(...rows.map((r) => r.value)) || 1
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    <div className="flex h-full flex-col justify-center gap-2" role="img" aria-label={srLabel}>
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[minmax(34px,auto)_minmax(0,1fr)_auto] items-center gap-1.5">
          <span className="truncate text-[8px] font-medium uppercase tracking-[0.06em] opacity-70">
            {r.label}
          </span>
          <span className="h-3.5 overflow-hidden rounded-[3px]" style={{ background: TRACK }}>
            <span className="block h-full rounded-[3px]"
                  style={{ width: `${(r.value / hi) * 100}%`, background: MARK }} />
          </span>
          <b className="text-[9px] font-bold tabular-nums">{fmt(r.value)}</b>
        </div>
      ))}
    </div>
  )
}

/** Facts: the numbers around the headline figure, set as a list.

    This replaces the dot field, and replacing it with another PICTURE was the
    wrong instinct. Nearly every cell that used it passed
    `Array.from({length: n}, () => 1)` — every mark identical — so the drawing
    had no variation in it and could only restate the count already printed
    above. Dots, blocks and a segmented rail were all faithful renderings of
    nothing, which is why each one in turn read as uninformative.

    A cell whose data is one number does not have a chart in it. What it has is
    context: the figures beside the headline that say what the number is made
    of, or what it is a part of. Those are real, they are already fetched, and
    set as a list they fill the row with something worth reading.

    Right-aligned values on a tabular figure so a column of them lines up. */
export function Facts({ items, srLabel }: {
  items: { label: string; value: string }[]
  srLabel?: string
}) {
  if (!items.length) return null
  return (
    <dl className="flex h-full flex-col justify-end gap-1" aria-label={srLabel}>
      {items.map((f) => (
        <div key={f.label} className="flex items-baseline justify-between gap-2 border-t pt-1"
             style={{ borderColor: TRACK }}>
          <dt className="truncate text-[8.5px] font-medium uppercase tracking-[0.07em] opacity-65">
            {f.label}
          </dt>
          <dd className="shrink-0 text-[11px] font-bold tabular-nums">{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Pipeline. Bars narrowing downward, each labelled beside its own bar.

    The label sits OUTSIDE the bar. Inside, it had to be drawn in the cell's
    background colour to read against the fill, and the only token available
    for that was `--bento-card` — paper. Correct on a paper cell, wrong on a
    domain-tinted one and wrong on an inverted one, which is the same mistake
    the punched gauge made. Outside the bar the label is ordinary ink and needs
    to know nothing about the ground. */
export function Funnel({ stages, srLabel, formatValue }: {
  stages: { label: string; value: number }[]
  srLabel: string
  formatValue?: (n: number) => string
}) {
  if (!stages.length) return null
  const hi = Math.max(...stages.map((s) => s.value)) || 1
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    <div className="flex h-full flex-col justify-end gap-1" role="img" aria-label={srLabel}>
      {stages.map((s) => (
        <div key={s.label} className="flex items-center gap-1.5">
          <span className="h-3 min-w-0 flex-1">
            <span className="block h-full rounded-[3px]"
                  style={{ width: `${Math.max(6, (s.value / hi) * 100)}%`, background: MARK }} />
          </span>
          <b className="shrink-0 text-[9px] font-bold tabular-nums">{fmt(s.value)}</b>
        </div>
      ))}
    </div>
  )
}

/** One value placed in its range: a hairline with a single dot on it. */
export function Scale({ value, min, max, srLabel }: {
  value: number; min: number; max: number; srLabel: string
}) {
  if (max <= min) return null
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))
  return (
    <div className="flex h-full items-center" role="img" aria-label={srLabel}>
      <span className="relative block h-px w-full" style={{ background: ink(45) }}>
        <span className="absolute top-1/2 size-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: `${pct}%`, background: MARK }} />
      </span>
    </div>
  )
}

/** Movement between states: short dashes, each row indented from the last. */
export function Flow({ rows, srLabel }: { rows: number[]; srLabel: string }) {
  if (!rows.length) return null
  return (
    <div className="flex h-full flex-col justify-center gap-2" role="img" aria-label={srLabel}>
      {rows.map((n, i) => (
        <div key={i} className="flex gap-1" style={{ paddingLeft: `${i * 16}px` }}>
          {Array.from({ length: Math.max(0, n) }, (_, j) => (
            <span key={j} className="h-1.5 w-3 rounded-full" style={{ background: MARK }} />
          ))}
        </div>
      ))}
    </div>
  )
}
