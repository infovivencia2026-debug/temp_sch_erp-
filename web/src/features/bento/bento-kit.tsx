import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { api } from '@/lib/api'
import { useCatalog, usable } from '@/lib/catalog'
import { cn } from '@/lib/utils'

/* THE BENTO KIT.

   Everything the Bento dashboards need that `ui.tsx` would otherwise have been
   asked for. It is a NEW file under `web/src/features/bento/`, per
   docs/BENTO_UI_CONTRACT.md: a Bento screen copies or wraps, it never edits a
   shared component, because the classic layout must keep rendering exactly as
   it does today.

   Nothing here fetches anything a dashboard did not already fetch. The one
   query it owns is the display-preference row — the same row and the same
   endpoint the theme selector and the layout switch already read — because
   `reduce_motion` is an account preference and honouring it is not optional.

   COLOUR, AND THE TRAP IN IT. `--success`, `--warning` and `--info` were each
   darkened to clear 4.5:1 *against a light card*. On the dark anchor cell,
   whose ground is `--foreground`, those same tokens are near-black on
   near-black in the light theme. So the dark cell draws entirely in
   `currentColor` — the inverted foreground, which is the theme's own maximum
   contrast pair by construction — at graded opacities, and every band it draws
   is labelled with its own figure so opacity is never the only thing carrying
   the meaning. The semantic tokens are used on light cells only, which is the
   ground they were measured on. No raw hex anywhere. */

// --- preferences --------------------------------------------------------

/** True when this account, or this device, has asked for less motion.

    Reads the account row through the same `['display-preferences']` query key
    ThemeSelection uses, so switching the preference there and coming back here
    costs no second request. The OS setting counts too: index.css already
    honours `prefers-reduced-motion`, and a Bento cell must not be the one
    thing on the page that ignores it. Until the row arrives we assume motion
    is reduced — a cell that fades in late is a smaller sin than one that
    animates for somebody who asked it not to. */
export function useReduceMotion(): boolean {
  const [os, setOs] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setOs(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const prefs = useQuery({
    queryKey: ['display-preferences'],
    queryFn: () =>
      api.get<{ preference?: { reduce_motion?: boolean } }>('/api/v1/portal/preferences/display'),
    staleTime: 5 * 60_000,
  })
  if (os) return true
  if (!prefs.data) return true
  return prefs.data.preference?.reduce_motion === true
}

// --- progressive disclosure --------------------------------------------

/** The route for a catalogue feature this account may actually open, or
    undefined.

    The cue on a cell must lead to the screen that already exists — never to a
    second implementation of it — and must not appear at all when the account
    cannot open that screen. `useCatalog()` is the server's own answer to what
    this user may see, which is why the check is made against it rather than
    against a hard-coded list of paths. */
export function useFeatureHref(key: string): string | undefined {
  const catalog = useCatalog()
  for (const role of catalog.roles) {
    for (const section of role.sections) {
      const feature = section.features.find((f) => f.key === key)
      if (feature && usable(feature)) return `/${role.key}/${section.slug}/${feature.slug}`
    }
  }
  return undefined
}

// --- cells --------------------------------------------------------------

export type CellSpan = 'anchor' | 'wide' | 'one'

const SPAN: Record<CellSpan, string> = {
  anchor: 'sm:col-span-2 sm:row-span-2',
  wide: 'sm:col-span-2',
  one: '',
}

/** The frame every cell shares: the grid span, the ground, the padding.

    No `backdrop-filter` anywhere on these screens. The contract confines blur
    to transient floating panels; a dashboard is read, not glanced at, and blur
    is the first thing to stutter on a school's five-year-old desktop. */
export function Cell({
  span = 'one',
  dark = false,
  className,
  children,
}: {
  span?: CellSpan
  dark?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-[14px] border p-5',
        SPAN[span],
        dark
          ? 'border-transparent bg-foreground text-background'
          : 'bg-card text-card-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A supporting cell: one figure, one shape, one cue. Never a table, never a
    scrollbar — if it needed either it would be the wrong cell. */
export function StatCell({
  label,
  value,
  note,
  shape,
  to,
  cue,
}: {
  label: string
  value: string | number
  note?: string
  shape?: ReactNode
  /** Where the detail already lives. Omitted — or refused by the catalogue —
      and the cell simply carries no cue. */
  to?: string
  cue?: string
}) {
  return (
    <Cell>
      <p className="text-[12.5px] text-muted-foreground">{label}</p>
      <p className="mt-3 text-[28px] font-semibold leading-none tabular-nums">{value}</p>
      {shape && <div className="mt-3">{shape}</div>}
      {note && <p className="mt-2 text-[12px] text-muted-foreground">{note}</p>}
      {to && cue && <Cue to={to} label={cue} />}
    </Cell>
  )
}

/** The explicit cue. Always a real route to a screen that already exists. */
export function Cue({ to, label, dark = false }: { to: string; label: string; dark?: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        'mt-auto inline-flex items-center gap-1 pt-3 text-[12.5px] font-medium',
        dark ? 'text-background/85 hover:text-background' : 'text-primary hover:underline',
      )}
    >
      {label}
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  )
}

/** A proportion, drawn. Only ever called with a real denominator — a bar whose
    total was invented to make a cell look finished is a lie with a shape. */
export function Meter({
  value,
  total,
  tone = 'primary',
  srLabel,
}: {
  value: number
  total: number
  tone?: 'primary' | 'success' | 'warning' | 'destructive'
  srLabel: string
}) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0
  const fill = {
    primary: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    destructive: 'bg-destructive',
  }[tone]
  return (
    <div
      role="progressbar"
      aria-label={srLabel}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className={cn('h-full rounded-full', fill)} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** A trend, drawn small. Hand-rolled SVG rather than a chart library: a
    sparkline has no axes, no tooltip and no legend, and pulling a charting
    runtime in to draw thirty points is weight a dashboard pays for on every
    load. Inherits `currentColor`, which is what lets it sit on the dark
    anchor without reaching for a token measured against a light card. */
export function Sparkline({
  points,
  srLabel,
  className,
}: {
  points: number[]
  srLabel: string
  className?: string
}) {
  if (points.length < 2) return null
  const w = 100
  const h = 28
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w
      const y = h - ((p - min) / range) * (h - 4) - 2
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={srLabel}
      className={cn('h-8 w-full', className)}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// --- states -------------------------------------------------------------

/** A failed query is an error, never an empty state. A zero on a finance
    dashboard that is really a failed fetch is worse than a blank one, because
    somebody will act on it. */
export function BentoError({ message }: { message: string }) {
  return (
    <div className="p-6">
      <p
        role="alert"
        className="rounded-[14px] border border-destructive/40 bg-card p-5 text-[13.5px] text-destructive"
      >
        {message}
      </p>
    </div>
  )
}

/** The same sentence, inside a cell, when one query of several failed and the
    rest of the dashboard is still true. */
export function CellError({ message, dark = false }: { message: string; dark?: boolean }) {
  return (
    <p
      role="alert"
      className={cn('text-[12.5px]', dark ? 'text-background/85' : 'text-destructive')}
    >
      {message}
    </p>
  )
}

export function BentoLoading({ message }: { message: string }) {
  return (
    <div className="p-6 text-[13.5px] text-muted-foreground" aria-busy="true">
      {message}
    </div>
  )
}

/** The page frame: eyebrow, title, and the 4-column grid.

    20px gaps, generous padding, four columns above `lg` and a graceful
    collapse below. The entrance fade is the only motion on the page and it is
    skipped outright when `reduce_motion` is set. */
export function BentoPage({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string
  title: string
  children: ReactNode
}) {
  const still = useReduceMotion()
  // A one-shot opacity transition rather than a keyframe class: `.reveal` in
  // index.css was deliberately made a no-op, and adding a keyframe would mean
  // editing index.css, which this experiment may not do. When motion is
  // reduced the cells are simply already there — no transition is armed at
  // all, so there is nothing for a preference to have to cancel.
  const [shown, setShown] = useState(still)
  useEffect(() => {
    if (still) {
      setShown(true)
      return
    }
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [still])

  return (
    <div
      className={cn(
        'p-6 sm:p-7',
        still ? '' : 'transition-opacity duration-300',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {eyebrow}
      </p>
      <h1 className="mt-1 text-[22px] font-semibold">{title}</h1>
      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </div>
  )
}
