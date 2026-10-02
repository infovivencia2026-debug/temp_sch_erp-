import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

/* WHAT A FIGURE IS MADE OF, AND HOW IT HAS MOVED.

   A stat card said "Open 12" and stopped. Twelve of what: how many urgent,
   how many nobody has picked up, more than last week or fewer? The reader
   had to go and find out, which is the work the card exists to save.

   Two additions a Stat can carry, both drawn from numbers the screen already
   has and both something to press, not only to look at:

   - parts: the figure split into what it is made of, as one bar and a
     legend with each part's count and share. Pointing at a part dims the
     rest; pressing one (where the caller gives `onPart`) narrows the screen
     to it, and pressing it again clears that.
   - trend: the figure over time as a small line. Pointing, touching or the
     arrow keys move a marker along it and name the day and its value, so
     the line can be read exactly rather than guessed at.

   Colour is the semantic tone (danger, warning, success ...), never a colour
   picked here, so every palette and both themes draw it right. */

export type StatTone = 'neutral' | 'success' | 'danger' | 'primary' | 'warning' | 'info'
export interface StatPart {
  key: string
  label: string
  value: number
  tone?: StatTone
}

const FILL: Record<StatTone, string> = {
  neutral: 'bg-muted-foreground/60',
  success: 'bg-success',
  danger: 'bg-destructive',
  primary: 'bg-primary',
  warning: 'bg-warning',
  info: 'bg-info',
}

const pct = (n: number, total: number) => (total > 0 ? Math.round((100 * n) / total) : 0)

export function StatParts({ parts, onPart, activePart }: {
  parts: StatPart[]
  /** Pressing a part narrows the screen to it; pressing the active one clears it. */
  onPart?: (key: string | null) => void
  activePart?: string | null
}) {
  const [hover, setHover] = useState<string | null>(null)
  const shown = parts.filter((p) => p.value > 0)
  const total = shown.reduce((n, p) => n + p.value, 0)
  if (total === 0) return null
  const lit = hover ?? activePart ?? null
  return (
    <div className="mt-3">
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full" role="img"
        aria-label={shown.map((p) => `${p.label} ${p.value}, ${pct(p.value, total)} percent`).join('; ')}>
        {shown.map((p) => (
          <span
            key={p.key}
            onPointerEnter={() => setHover(p.key)}
            onPointerLeave={() => setHover(null)}
            className={cn('h-full min-w-[6px] rounded-full transition-opacity duration-150', FILL[p.tone ?? 'primary'], lit && lit !== p.key && 'opacity-30')}
            style={{ flexGrow: p.value, flexBasis: 0 }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {shown.map((p) => {
          const on = activePart === p.key
          const body = (
            <>
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', FILL[p.tone ?? 'primary'])} />
              {/* The name may shorten; the count and its share never break apart. */}
              <span className={cn('min-w-0 truncate', on ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{p.label}</span>
              <span className="shrink-0 whitespace-nowrap tabular-nums"><span className="font-semibold text-foreground">{p.value}</span> <span className="text-muted-foreground/80">{pct(p.value, total)}%</span></span>
            </>
          )
          return (
            <li key={p.key} onPointerEnter={() => setHover(p.key)} onPointerLeave={() => setHover(null)}
              className={cn('min-w-0 max-w-full transition-opacity duration-150', lit && lit !== p.key && 'opacity-50')}>
              {onPart ? (
                <button type="button" aria-pressed={on} onClick={() => onPart(on ? null : p.key)}
                  className={cn('tap-inline inline-flex max-w-full items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[12px] hover:bg-accent', on && 'bg-accent')}>
                  {body}
                </button>
              ) : (
                <span className="inline-flex max-w-full items-center gap-1.5 text-[12px]">{body}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export interface TrendPoint { label: string; value: number }

export function StatTrend({ points, unit = '' }: { points: TrendPoint[]; unit?: string }) {
  const [at, setAt] = useState<number | null>(null)
  if (points.length < 2) return null
  const max = Math.max(...points.map((p) => p.value), 1)
  const x = (i: number) => (i / (points.length - 1)) * 100
  const y = (v: number) => 30 - (v / max) * 26
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ')
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setAt(Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - r.left) / r.width) * (points.length - 1)))))
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const from = at ?? points.length - 1
    setAt(Math.max(0, Math.min(points.length - 1, from + (e.key === 'ArrowRight' ? 1 : -1))))
  }
  const shown = points[at ?? points.length - 1]
  return (
    <div className="mt-3">
      <p className="mb-1 flex items-baseline justify-between gap-2 text-[12px] text-muted-foreground" aria-live="polite">
        <span>{shown.label}</span>
        <span className="tabular-nums font-semibold text-foreground">{shown.value}{unit}</span>
      </p>
      <div
        role="slider" tabIndex={0} aria-label="Move along the trend" aria-valuemin={0} aria-valuemax={points.length - 1}
        aria-valuenow={at ?? points.length - 1} aria-valuetext={`${shown.label}: ${shown.value}${unit}`}
        className="relative h-9 w-full cursor-crosshair touch-none rounded text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerMove={move} onPointerDown={move} onPointerLeave={() => setAt(null)} onKeyDown={key} onBlur={() => setAt(null)}
      >
        <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
          <path d={`${line} L100,32 L0,32 Z`} fill="currentColor" opacity={0.12} />
          <path d={line} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {at !== null && (
          <>
            <span aria-hidden className="absolute inset-y-0 w-px bg-foreground/25" style={{ left: `${x(at)}%` }} />
            <span aria-hidden className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
              style={{ left: `${x(at)}%`, top: `${(y(points[at].value) / 32) * 100}%` }} />
          </>
        )}
      </div>
    </div>
  )
}
