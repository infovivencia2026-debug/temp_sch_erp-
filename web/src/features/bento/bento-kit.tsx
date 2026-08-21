import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { api } from '@/lib/api'
import { useCatalog, usable } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { useLayout } from '@/lib/layout'

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

   COLOUR COMES FROM `bento-theme.css` AND NOWHERE ELSE. Not one hex is
   written below. The classic semantic tokens are not used either, and that is
   the point rather than an oversight: `--success`, `--warning` and `--info`
   were each darkened to clear 4.5:1 *against the classic light card*, and the
   Bento card is a different ground in both polarities. The Bento palette is
   the same measurement redone for this ground — the supplied pastels sit at
   7–12:1 on the dark card and only 1.35–2.34:1 on white, so light mode reuses
   the hues relit, never the values. Every colour below is `var(--bento-…)`,
   which is defined twice, and the mode branch is therefore CSS's job, not
   React's.

   The one exception is polarity, which React can see and CSS cannot express in
   a token: an inverted cell needs its ink and its ground swapped, so `Cell`
   takes a `tone`. `anchor` is the mint gradient with dark ink — 14.24:1, and
   the one pairing that is identical in both modes because it did not need
   relighting. `dark` is the older inverted cell, kept polarised exactly as it
   was for the four dashboards that still pass `dark`. */

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

/** The accent hues, one per meaning. Mint is money in, pink is money out,
    purple is the active state in a chart, orange is a warning. Four, and
    deliberately not more: a dashboard where every cell has its own colour has
    no colour at all. Each name resolves to two tokens — the ink and its tint —
    and both are redefined under `html.dark[data-layout='bento']`, which is why
    nothing below writes a hex. */
export type Accent = 'mint' | 'purple' | 'pink' | 'orange'

const ACCENT_INK: Record<Accent, string> = {
  mint: 'text-[var(--bento-mint)]',
  purple: 'text-[var(--bento-purple)]',
  pink: 'text-[var(--bento-pink)]',
  orange: 'text-[var(--bento-orange)]',
}
const ACCENT_TINT: Record<Accent, string> = {
  mint: 'bg-[var(--bento-mint-tint)]',
  purple: 'bg-[var(--bento-purple-tint)]',
  pink: 'bg-[var(--bento-pink-tint)]',
  orange: 'bg-[var(--bento-orange-tint)]',
}
const ACCENT_FILL: Record<Accent, string> = {
  mint: 'bg-[var(--bento-mint)]',
  purple: 'bg-[var(--bento-purple)]',
  pink: 'bg-[var(--bento-pink)]',
  orange: 'bg-[var(--bento-orange)]',
}

/** What ground a cell sits on, which is the only thing that decides what may
    be drawn inside it.

    · `plain`  — the card tone. The pastel inks were relit for exactly this
                 ground in light mode and measured against it in dark, so this
                 is the one cell where an accent may be used.
    · `anchor` — the mint gradient, with dark ink on it. That pairing measures
                 14.24:1 and, uniquely, is the same in both modes: the gradient
                 is not re-tinted for light, because it did not need to be.
    · `dark`   — the inverted cell four other dashboards still anchor on.
                 Kept exactly as polarised as it was (`--bento-ink` ground,
                 `--bento-bg` ink) so their `text-background` children keep
                 landing right side up until their own pass converts them.

    No `backdrop-filter` anywhere on these screens. The contract confines blur
    to transient floating panels; a dashboard is read, not glanced at, and blur
    is the first thing to stutter on a school's five-year-old desktop. */
export type CellTone = 'plain' | 'anchor' | 'dark'

const TONE: Record<CellTone, string> = {
  // A hairline in light, where the card and the ground are four points apart
  // and the eye wants an edge; nothing in dark, where the card is separated by
  // tone alone. That is the reference's flat card, and a border there would
  // read as a box drawn around it.
  plain: 'border-[var(--bento-line)] shadow-sm dark:border-transparent dark:shadow-none bg-[var(--bento-card)] text-[var(--bento-ink)]',
  // In dark the mint gradient stands 14.24:1 off the ground and needs no edge.
  // In light it sits at 1.23:1 against a near-white page — the card would
  // dissolve into it — so it takes the same hairline every other light cell
  // takes, in its own hue rather than the neutral line.
  anchor:
    'border-[var(--bento-mint)] dark:border-transparent bg-[linear-gradient(140deg,var(--bento-anchor-from),var(--bento-anchor-to))] text-[var(--bento-anchor-ink)]',
  dark: 'border-transparent bg-[var(--bento-ink)] text-[var(--bento-bg)]',
}

export function Cell({
  span = 'one',
  tone,
  dark = false,
  className,
  children,
}: {
  span?: CellSpan
  tone?: CellTone
  /** The older boolean, still honoured because four dashboards pass it. */
  dark?: boolean
  className?: string
  children: ReactNode
}) {
  const t = tone ?? (dark ? 'dark' : 'plain')
  return (
    <div
      className={cn(
        /* min-h-0 for the same reason as the track: a flex/grid child will not
           shrink past its content without it.

           No scrollbar, and nothing cut off: the contents are sized to the
           row instead. A scrollbar inside a dashboard card is an admission
           that the card does not fit, and eight of them is a worse answer
           than one page scroll would have been. So the figures scale with the
           viewport (see StatCell) and the padding tightens where the fit rule
           rations height — 16px of vertical padding back is most of a line of
           text, in exactly the place it was being taken from. */
        `flex min-h-0 min-w-0 flex-col overflow-hidden
         rounded-[var(--bento-radius)] border p-6 lg:p-4`,
        SPAN[span],
        TONE[t],
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A tinted badge: accent ink on its own tint, small, rounded, sitting beside
    the figure it qualifies.

    The tint is the harder of the two contrast measurements — a badge sits on
    it, not on the card — and each light ink in bento-theme.css was darkened
    until it cleared 4.5:1 against both. Which is the whole reason this takes
    an `Accent` name and not a colour. */
export function Badge({
  accent,
  children,
  className,
}: {
  accent: Accent
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-[11.5px] font-semibold leading-none tabular-nums',
        ACCENT_TINT[accent],
        ACCENT_INK[accent],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** A bar chart as plain divs. No chart library, and none is wanted: this has
    no axis, no tooltip and no legend, and a charting runtime to draw ten
    rectangles is weight every load pays for.

    The active bar is purple — the one hue reserved for "this is the one you
    are looking at" — and every other bar is the muted card tone, so the chart
    carries one piece of meaning rather than ten. The figures are not left to
    colour alone: the whole series is described in `srLabel`, and each bar
    carries its own value as a title. */
export function Bars({
  items,
  activeIndex,
  srLabel,
  accent = 'purple',
}: {
  items: { label: string; value: number; title: string }[]
  activeIndex?: number
  srLabel: string
  accent?: Accent
}) {
  const still = useReduceMotion()
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div role="img" aria-label={srLabel} className="flex h-full items-end gap-1.5">
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`} className="flex min-w-0 flex-1 flex-col items-center gap-2">
          <div className="flex h-16 w-full items-end" title={item.title}>
            <div
              className={cn(
                'w-full rounded-[6px]',
                i === activeIndex ? ACCENT_FILL[accent] : '',
                still ? '' : 'transition-[height] duration-300',
              )}
              style={{
                height: `${Math.max(6, (item.value / max) * 100)}%`,
                // The inactive bars are the muted tone, mixed down onto
                // whatever card they sit on. `--bento-card-2` alone — the
                // literal muted card tone — measures 1.13:1 against the light
                // card, which is a bar nobody can see, and the height of these
                // bars is information. `--bento-muted` at 70% clears 3:1 in
                // both modes while staying obviously secondary to the purple.
                ...(i === activeIndex
                  ? null
                  : { backgroundColor: 'color-mix(in srgb, var(--bento-muted) 70%, transparent)' }),
              }}
            />
          </div>
          <span className="truncate text-[10.5px] text-[var(--bento-muted)]">{item.label}</span>
        </div>
      ))}
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
  badge,
  accent,
  span,
  to,
  cue,
}: {
  label: string
  value: string | number
  note?: string
  shape?: ReactNode
  /** The tinted qualifier that sits beside the figure. One hue, chosen for
      what the figure means — not for variety. */
  badge?: string
  accent?: Accent
  span?: CellSpan
  /** Where the detail already lives. Omitted — or refused by the catalogue —
      and the cell simply carries no cue. */
  to?: string
  cue?: string
}) {
  return (
    <Cell span={span}>
      <p className="text-[12.5px] leading-tight text-[var(--bento-muted)]">{label}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        {/* Sized against the viewport, not fixed.

            32px is right on a desktop monitor and two pixels too many on a
            13-inch laptop, where four rows of cards are dividing 690px between
            them and the figure is the tallest thing in each. clamp lets the
            number be as large as the glass can afford: it settles at 32 on
            anything tall, shrinks toward 24 on a short window, and never
            reaches the point where the card has to choose between clipping and
            a scrollbar. */}
        <p
          className="font-semibold leading-none tracking-[-0.02em] tabular-nums
                     text-[clamp(24px,3.1vh,32px)]"
        >
          {value}
        </p>
        {badge && accent && <Badge accent={accent}>{badge}</Badge>}
      </div>
      {shape && <div className="mt-3">{shape}</div>}
      {note && (
        <p className="mt-2 text-[11.5px] leading-tight text-[var(--bento-muted)]">{note}</p>
      )}
      {to && cue && <Cue to={to} label={cue} />}
    </Cell>
  )
}

/** The explicit cue. Always a real route to a screen that already exists.

    The hover is the reference's one flourish, and it is a colour change, not a
    movement — but the transition that smooths it is still armed only when
    motion has not been asked away. With `reduce_motion` set the colour simply
    changes on the frame the pointer arrives, which is what that preference
    means: no animation, not no feedback. */
export function Cue({
  to,
  label,
  tone,
  dark = false,
}: {
  to: string
  label: string
  tone?: CellTone
  /** The older boolean, still honoured because four dashboards pass it. */
  dark?: boolean
}) {
  const still = useReduceMotion()
  const t = tone ?? (dark ? 'dark' : 'plain')
  return (
    <Link
      to={to}
      className={cn(
        /* mt-auto keeps it on the bottom edge; the padding that used to sit
           above it is now the button's own, so the control has a body instead
           of being text with space over it. */
        'bento-cue mt-auto inline-flex w-fit items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold',
        still ? '' : 'transition-opacity duration-150',
        t === 'plain'
          ? 'text-[var(--bento-ink)] opacity-80 hover:opacity-100'
          : t === 'anchor'
            ? 'text-[var(--bento-anchor-ink)] opacity-85 hover:opacity-100'
            : 'text-[var(--bento-bg)] opacity-85 hover:opacity-100',
      )}
    >
      {label}
      <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.75} aria-hidden="true" />
    </Link>
  )
}

/** An action along the bottom edge of the anchor: a pill in the anchor's own
    ink, which is the reference's shape for "the two things you do from here".
    Only ever drawn on the gradient, so the ink pair is fixed and needs no
    per-mode branch. */
export function AnchorAction({ to, label }: { to: string; label: string }) {
  const still = useReduceMotion()
  return (
    <Link
      to={to}
      className={cn(
        /* 10px. A filled CTA is the one place a capsule is tempting and the
           one place it costs most: it is the largest control on the page, so
           it sets the reader's expectation for what a button looks like. */
        'inline-flex items-center gap-1.5 rounded-[10px] bg-[var(--bento-anchor-ink)] px-4 py-2.5 text-[12.5px] font-semibold text-[var(--bento-anchor-from)]',
        still ? '' : 'transition-opacity duration-150',
        'opacity-95 hover:opacity-100',
      )}
    >
      {label}
      <ArrowUpRight className="h-4 w-4" strokeWidth={2.75} aria-hidden="true" />
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
  // The semantic names four dashboards already pass, mapped onto the one hue
  // that carries each meaning here. `--success`/`--warning`/`--destructive`
  // are not used: they were each measured against the classic card, and the
  // Bento card is a different ground in both modes.
  const fill = ACCENT_FILL[
    ({ primary: 'purple', success: 'mint', warning: 'orange', destructive: 'pink' } as const)[tone]
  ]
  return (
    <div
      role="progressbar"
      aria-label={srLabel}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 w-full overflow-hidden rounded-full bg-[var(--bento-card-2)]"
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
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// --- states -------------------------------------------------------------

/** A failed query is an error, never an empty state. A zero on a finance
    dashboard that is really a failed fetch is worse than a blank one, because
    somebody will act on it. */
export function BentoError({ message }: { message: string }) {
  return (
    <div className="min-h-full bg-[var(--bento-bg)] p-6 sm:p-7">
      <p
        role="alert"
        className="rounded-[var(--bento-radius)] bg-[var(--bento-pink-tint)] p-6 text-[13.5px] font-medium text-[var(--bento-pink)]"
      >
        {message}
      </p>
    </div>
  )
}

/** The same sentence, inside a cell, when one query of several failed and the
    rest of the dashboard is still true. */
export function CellError({
  message,
  tone,
  dark = false,
}: {
  message: string
  tone?: CellTone
  dark?: boolean
}) {
  const t = tone ?? (dark ? 'dark' : 'plain')
  // Pink is money out on a plain card and reads as the failure hue there. On
  // the mint gradient it does not clear 4.5:1, so the anchor's own ink says it
  // instead — in medium weight, because on the anchor the sentence is the only
  // thing marking it as a failure.
  return (
    <p
      role="alert"
      className={cn(
        'text-[12.5px] font-medium',
        t === 'plain'
          ? 'text-[var(--bento-pink)]'
          : t === 'anchor'
            ? 'text-[var(--bento-anchor-ink)]'
            : 'text-[var(--bento-bg)]',
      )}
    >
      {message}
    </p>
  )
}

export function BentoLoading({ message }: { message: string }) {
  return (
    <div
      className="min-h-full bg-[var(--bento-bg)] p-6 text-[13.5px] text-[var(--bento-muted)] sm:p-7"
      aria-busy="true"
    >
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
  const bentoLayout = useLayout().layout === 'bento'
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
        'min-h-full bg-[var(--bento-bg)] p-6 text-[var(--bento-ink)] sm:p-7 lg:p-5',
        // The clearance itself is made once, by BentoOutlet, for every screen
        // rather than only the converted ones. What is left here is the
        // consequence: the viewport this page may fill is shorter by it.

        /* One screen, no page scroll — but only where that is honest.

           A dashboard you have to scroll is not a dashboard; the whole claim
           of the form is that the state of the school is visible at a glance,
           and a figure below the fold is a figure nobody glanced at. So on a
           wide screen the page is exactly the viewport and the grid divides
           what is left after the dock.

           Not below lg. Squeezing three rows of cards into a phone would not
           produce a dashboard, it would produce four unreadable boxes, and
           there the honest answer is that the page scrolls. */
        bentoLayout
          ? 'lg:flex lg:h-[calc(100dvh-var(--bento-dock))] lg:flex-col lg:overflow-auto'
          : 'lg:flex lg:h-[100dvh] lg:flex-col lg:overflow-auto',
        still ? '' : 'transition-opacity duration-300',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      {/* The heading is read, not seen.

          "Bento / Executive overview" told a principal two things they already
          knew: the layout's internal codename, which is our word and not
          theirs, and that a screen of school figures is an overview. The dock
          says where you are and the cards say what they are, so the block was
          a label for something self-evident, sitting in the most valuable
          space on the page.

          Kept for assistive technology, because a document with no h1 is a
          document a screen reader cannot outline. */}
      <h1 className="sr-only">{`${eyebrow} — ${title}`}</h1>
      {/* auto-rows-fr divides the remaining height evenly, so the row count
          decides the row height rather than the tallest card deciding it and
          pushing the rest off the bottom. min-h-0 is what lets a grid child
          shrink below its content at all — without it the track floors at the
          content height and the overflow-hidden above simply clips. */}
      {/* Bounded on both sides, because both failures are real.

          The principal's grid is nine cards filling sixteen slots — four rows
          of four, packed exactly. Divide the viewport by four and a 1080p
          laptop gives rows of about 200px, which is a comfortable stat card.

          The floor stops the other direction: on a short window four rows of
          fr would each become 130px and the figures would collide with their
          own labels. Below the floor the page scrolls, which is worse than
          fitting and much better than clipping a number off the bottom of a
          card nobody can then scroll inside.

          The ceiling is the one people forget. On a 1440p or 4K panel four
          rows of fr are 300–500px each, and a card holding one number and a
          meter stretched to half a metre of glass does not read as generous,
          it reads as broken. Past the ceiling the whitespace goes below the
          grid, where whitespace belongs. */}
      <div
        className="grid grid-cols-1 gap-[var(--bento-gap)] sm:grid-cols-2
                   lg:min-h-[600px] lg:max-h-[1000px] lg:flex-1 lg:auto-rows-fr
                   lg:grid-cols-4"
      >
        {children}
      </div>
    </div>
  )
}
