import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* WHAT THE PRODUCT DOES WHILE IT IS WAITING.
 *
 * The owner's complaint was that most loading "just looks blank", and the
 * measurement bore it out: a screen waiting on the network showed either the
 * word "Loading…" alone in the content area, a three-triangle mark alone in
 * the content area, or -- for the first 220ms of every wait -- nothing at all.
 *
 * Two ideas run through everything below.
 *
 * SHAPE. A placeholder earns its place only by occupying the space the real
 * thing will occupy. So these are not one grey block with a row count; they
 * are a table with a header and a column rhythm, a form with labels and
 * inputs, a page with a breadcrumb line where the breadcrumb will be, a
 * dashboard board with tiles in the grid the tiles will fill.
 *
 * DELAY, but a short one. A skeleton that appears for 60ms and vanishes is a
 * flinch, so a placeholder still waits before it shows itself -- but only
 * 100ms now, not 220. With TanStack a cached answer is never `isLoading` at
 * all (the data is simply there), so the delay only ever covers the
 * uncached-but-fast case, and a fifth of a second of blank before the shape
 * appears was most of what "looks blank" meant on a 300ms request.
 */

/** True only once `active` has been true for `ms`. */
export function useDelayed(active: boolean, ms = 100): boolean {
  const [shown, setShown] = useState(ms <= 0 && active)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    if (ms <= 0) {
      setShown(true)
      return
    }
    const t = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(t)
  }, [active, ms])
  return shown
}

/* One rounded block with the calm shimmer from index.css (`.skeleton`).
   `rounded-[var(--radius-control)]` so it follows the corners preference the
   way every real control does. */
function Bone({
  className,
  style,
  round,
}: {
  className?: string
  style?: CSSProperties
  round?: 'control' | 'card' | 'full'
}) {
  const r =
    round === 'full'
      ? 'rounded-full'
      : round === 'card'
        ? 'rounded-[var(--radius-card)]'
        : 'rounded-[var(--radius-control)]'
  return <div className={cn('skeleton', r, className)} style={style} aria-hidden />
}

/* The shape is aria-hidden; the sentence is not. `role="status"` says it once
   to a screen reader, `sr-only` keeps it out of the layout. */
function Says({ label }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" aria-label="Loading" className="sr-only">
      {label ?? 'Loading…'}
    </p>
  )
}

/* Every composed shape below: waits, announces, then draws. */
function Shape({
  delay,
  label,
  className,
  children,
}: {
  delay?: number
  label?: string
  className?: string
  children: ReactNode
}) {
  const show = useDelayed(true, delay)
  if (!show) return null
  return (
    <>
      <Says label={label} />
      <div className={className} aria-hidden>
        {children}
      </div>
    </>
  )
}

/**
 * `Skeleton`: the primitive, and the legacy stack.
 *
 * With `className`, `width` or `height` it is one rounded shimmering block --
 * the thing to reach for when a screen wants a placeholder the exact size of
 * a figure, an avatar or a button. Called with nothing, or with `rows`, it
 * keeps its original behaviour (n staggered bars) because thirteen screens
 * already render it that way and a placeholder that changes height is the
 * bug this file exists to fix.
 */
export function Skeleton({
  rows,
  delay,
  label,
  className,
  width,
  height,
  round,
  style,
}: {
  rows?: number
  delay?: number
  label?: string
  className?: string
  width?: number | string
  height?: number | string
  round?: 'control' | 'card' | 'full'
  style?: CSSProperties
}) {
  if (rows === undefined && (className || width !== undefined || height !== undefined)) {
    return <Bone className={className} round={round} style={{ width, height, ...style }} />
  }
  const n = rows ?? 5
  return (
    <Shape delay={delay} label={label} className="space-y-2 p-5">
      {Array.from({ length: n }, (_, i) => (
        <Bone key={i} className="h-9" style={{ width: `${92 - (i % 3) * 9}%` }} />
      ))}
    </Shape>
  )
}

/** Lines of prose that have not arrived: a paragraph's ragged right edge. */
export function SkeletonText({
  lines = 3,
  delay,
  label,
  className,
}: {
  lines?: number
  delay?: number
  label?: string
  className?: string
}) {
  const widths = ['96%', '88%', '92%', '70%', '84%']
  return (
    <Shape delay={delay} label={label} className={cn('space-y-2.5', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Bone
          key={i}
          className="h-3"
          style={{ width: i === lines - 1 && lines > 1 ? '58%' : widths[i % widths.length] }}
        />
      ))}
    </Shape>
  )
}

/* The proportions a real register runs to: a wide first column holding a
   name, then narrower ones holding a class, a date, a number. */
const COL_WIDTHS = ['34%', '20%', '18%', '14%', '16%', '12%']

/** Rows of a table that has not arrived, on the pitch the real `Td` uses.
    Bare rows, no frame: `Table` uses this inside its own tbody so the real
    header stays put while the rows fill in. */
export function SkeletonRows({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-5 py-3.5 max-[900px]:px-3">
              <Bone className="h-3" style={{ width: COL_WIDTHS[c % COL_WIDTHS.length], maxWidth: 220 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/**
 * A table that has not arrived yet, shaped like the table that will: the 41px
 * header band with its border beneath, then rows on the real pitch, framed
 * and rounded like the card it sits in. `cols` and `columns` are the same
 * prop; both spellings exist because both are natural.
 */
export function SkeletonTable({
  rows = 6,
  cols,
  columns,
  delay,
  label,
}: {
  rows?: number
  cols?: number
  columns?: number
  delay?: number
  label?: string
}) {
  const n = cols ?? columns ?? 4
  return (
    <Shape delay={delay} label={label} className="overflow-hidden rounded-[var(--radius-card)] border bg-card">
      <div className="flex h-[41px] items-center gap-4 border-b px-4">
        {Array.from({ length: n }, (_, c) => (
          <Bone key={c} className="h-2.5" style={{ width: COL_WIDTHS[c % COL_WIDTHS.length] }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-[45px] items-center gap-4 border-b px-4 last:border-b-0">
          {Array.from({ length: n }, (_, c) => (
            <Bone key={c} className="h-3" style={{ width: COL_WIDTHS[c % COL_WIDTHS.length] }} />
          ))}
        </div>
      ))}
    </Shape>
  )
}

/** One metric tile's insides: eyebrow, figure, qualifier. No frame, so it
    can sit inside whatever card the real figure will sit inside. */
export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col', className)} aria-hidden>
      <Bone className="h-2.5 w-20" />
      <Bone className="mt-3 h-6 w-24" />
      <Bone className="mt-3 h-2.5 w-28" />
    </div>
  )
}

/** A dashboard's row of numbers that has not arrived yet. The grid holds the
    same column rules the real one uses so no tile reflows sideways. */
export function SkeletonTiles({ count = 4, delay, label }: { count?: number; delay?: number; label?: string }) {
  return (
    <Shape delay={delay} label={label} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-[var(--radius-card)] border bg-card p-5">
          <SkeletonStat />
        </div>
      ))}
    </Shape>
  )
}

/** Cards in a grid: a title line, two lines of text, a footer chip. */
export function SkeletonCards({
  n = 6,
  delay,
  label,
  className,
}: {
  n?: number
  delay?: number
  label?: string
  className?: string
}) {
  return (
    <Shape delay={delay} label={label} className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="rounded-[var(--radius-card)] border bg-card p-5">
          <Bone className="h-3.5 w-2/3" />
          <Bone className="mt-4 h-2.5 w-full" />
          <Bone className="mt-2 h-2.5 w-5/6" />
          <Bone className="mt-5 h-6 w-20" round="full" />
        </div>
      ))}
    </Shape>
  )
}

/** A form that has not arrived: two columns collapsing to one, like FormGrid,
    a short label above each field. */
export function SkeletonForm({ fields = 6, delay, label }: { fields?: number; delay?: number; label?: string }) {
  return (
    <Shape delay={delay} label={label} className="grid gap-5 p-5 sm:grid-cols-2">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i}>
          <Bone className="mb-1.5 h-2.5 w-24" />
          <Bone className="h-9 w-full" />
        </div>
      ))}
    </Shape>
  )
}

/**
 * A screen whose code is still on the wire: what App.tsx shows for every
 * lazily loaded feature. The header block is the geometry of `PageHead` --
 * one 23px line holding breadcrumb and title, in the same px-5 pt-5 pb-6 and
 * width cap -- so when the real header arrives it arrives where its stand-in
 * already was. Then three lines of text and a table.
 */
export function SkeletonPage({ delay = 0, label }: { delay?: number; label?: string }) {
  return (
    <Shape delay={delay} label={label}>
      <div className="mx-auto w-full max-w-[1360px] px-5 pb-6 pt-5 sm:px-7">
        <div className="flex h-[23px] items-center gap-2">
          <Bone className="h-2.5 w-16" />
          <Bone className="h-2.5 w-28" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[1360px] space-y-7 px-5 pb-10 sm:px-7">
        <SkeletonText lines={3} delay={0} className="max-w-xl" />
        <SkeletonTable rows={5} cols={4} delay={0} />
      </div>
    </Shape>
  )
}

/**
 * The dashboard boards' stand-in: an eyebrow, a title, and tiles in the same
 * five-column grid every bento home draws. `spans` says how wide each tile
 * is, so the principal's 2x2 and the parent's fee card hold their room.
 */
export function SkeletonBoard({
  tiles = 8,
  delay,
  label,
  className,
}: {
  tiles?: number
  delay?: number
  label?: string
  className?: string
}) {
  const spans = ['lg:col-span-2 lg:row-span-2', '', '', 'lg:col-span-2', '', '', '', 'lg:col-span-2', '', '']
  return (
    <Shape delay={delay} label={label} className={cn('p-4 sm:p-6', className)}>
      <Bone className="h-2.5 w-20" />
      <Bone className="mt-2.5 h-5 w-48" />
      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: tiles }, (_, i) => (
          <div
            key={i}
            className={cn(
              'min-h-[120px] rounded-[var(--radius-card)] border bg-card p-4',
              spans[i % spans.length],
            )}
          >
            <SkeletonStat />
          </div>
        ))}
      </div>
    </Shape>
  )
}

/**
 * The first paint: the shape of the app before the session has answered.
 *
 * A faint rail down the left on a desktop, a faint dock along the bottom on a
 * phone, and a page block in between, so the browser tab goes from white to
 * "the app is here" rather than from white to the word "Loading…" to the app.
 * Shown immediately (no delay): the session request is always a real wait.
 */
export function SkeletonShell({ label = 'Opening…' }: { label?: string }) {
  return (
    <Shape delay={0} label={label} className="flex h-full min-h-screen w-full bg-background">
      <div className="hidden w-[58px] shrink-0 flex-col items-center gap-3 border-r py-4 md:flex">
        <Bone className="h-8 w-8" round="card" />
        {Array.from({ length: 6 }, (_, i) => (
          <Bone key={i} className="h-7 w-7 opacity-70" round="card" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center gap-3 border-b px-4">
          <Bone className="h-3 w-24" />
          <div className="flex-1" />
          <Bone className="h-7 w-7" round="full" />
        </div>
        <div className="flex-1">
          <SkeletonPage delay={0} />
        </div>
        <div className="flex h-16 items-center justify-around border-t px-6 md:hidden">
          {Array.from({ length: 4 }, (_, i) => (
            <Bone key={i} className="h-7 w-7" round="card" />
          ))}
        </div>
      </div>
    </Shape>
  )
}
