import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { api } from '@/lib/api'
import { useCatalog, usable } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { useDetail, useWidgetSize } from '@/lib/widget-size'

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

export type CellSpan = 'anchor' | 'wide' | 'one' | 'tall' | 'full'

/* Four widths, and only four, because the board is four columns.

   1, 2 and 4 are the widths that tile without stranding a column; a 3-wide
   cell leaves a hole on every row it appears in. Height is 1 or 2 for the same
   reason — taller than two and a card can never share a row, which is a layout
   decision wearing a size's clothes. */
/* Width and height as classes.

   Spelled out rather than built with `lg:col-span-${w}`, because Tailwind
   discovers classes by scanning this file as text: an interpolated name is
   never generated, so an interpolated grid silently collapses to one column.

   Widths are capped at two on `sm`, where the board is only two columns wide —
   a five-wide card on a two-column grid overflows the page rather than filling
   it. */
/* Two is the ceiling in both directions. A cell may be 1x1, 2x1, 1x2 or 2x2
   and nothing else.

   The cap is the point rather than a limitation: on a four-column board a
   three- or four-wide card stops being a cell and becomes a band across the
   page, and the grid it was supposed to belong to has one member. Anything
   asking for more is clamped rather than refused, so a wrong number is a
   slightly small card instead of a broken layout. */
export const MAX_SPAN = 2

export const COL: Record<number, string> = {
  1: '',
  2: 'sm:col-span-2',
}

export const ROW: Record<number, string> = {
  1: '',
  2: 'sm:row-span-2',
}

/** Clamp to the 2x2 ceiling. */
export const clampSpan = (n: number) => Math.min(Math.max(1, Math.round(n || 1)), MAX_SPAN)

/** The span name a cell should style itself as, given its dimensions. Cells use
    this for typography — the anchor draws a bigger figure — not for geometry,
    which the wrapper owns. */
export function spanFor(w: number, h: number): CellSpan {
  const cw = clampSpan(w)
  const ch = clampSpan(h)
  if (cw === 2 && ch === 2) return 'anchor'
  if (cw === 2) return 'wide'
  if (ch === 2) return 'tall'
  return 'one'
}

export const SPAN: Record<CellSpan, string> = {
  /* Four shapes, which is all a 2x2 ceiling allows on a four-column board.
     'full' is kept as an alias of the 2-wide card so that any caller still
     asking for it gets a legal cell rather than a compile error. */
  anchor: 'sm:col-span-2 sm:row-span-2',
  wide: 'sm:col-span-2',
  tall: 'sm:row-span-2',
  one: '',
  full: 'sm:col-span-2',
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
  accent,
  domain,
  art,
  className,
  children,
}: {
  span?: CellSpan
  tone?: CellTone
  /** The older boolean, still honoured because four dashboards pass it. */
  dark?: boolean
  accent?: Accent
  domain?: string
  /** The process behind the figure, drawn faintly behind it.

      A BACKGROUND LAYER, NOT CONTENT. The figure, the label and the cue are
      the card; this sits underneath them at a fraction of their contrast and
      never competes. It is `aria-hidden` and `pointer-events-none` because it
      carries nothing a screen reader or a pointer needs — everything it says
      is already said by the number printed on top of it.

      Optional, and a cell that passes nothing renders byte-identically to how
      it rendered before this prop existed. */
  art?: ReactNode
  className?: string
  children: ReactNode
}) {
  const t = tone ?? (dark ? 'dark' : 'plain')
  const baseStyle = accent && t === 'plain' ? { '--bento-card': `var(--bento-${accent}-tint)` } as React.CSSProperties : {}
  /* A coloured card carries its own ink, and its quiet text is that same ink —
     not a grey.

     --bento-muted is #667085, chosen against a white card. Dropped onto a
     saturated gold or a deep green it is neither the ink nor the ground: it
     reads as washed-out and slightly dirty, which is what a label on these
     cards looked like. Grey only works as "quieter" when the thing it is
     quieter THAN is black on white.

     So inside a domain card the muted tone becomes the card's own ink. The
     hierarchy is already carried by size and weight — a 10px caps label
     against a 40px figure is not at risk of competing — so the label can be
     the same white the figure is, and simply be small. */
  /* An inverted cell's art draws in that cell's own ink.

     Same reasoning as the domain branch below, and the same trap: --bento-muted
     is a grey chosen against a light card, and the `dark` tone's ground is the
     opposite of one in light mode and the anchor's gradient is not a card tone
     at all. Dropped onto either, the art is a smear rather than a quieter
     version of the text.

     Only applied when there IS art, because nothing else inside an inverted
     cell reads --bento-muted today — those cells carry their contrast with
     opacity — and repointing a token nobody reads is a change waiting to
     surprise somebody. */
  const artStyle =
    art && t === 'dark'
      ? { ['--bento-muted' as string]: 'var(--bento-bg)' }
      : art && t === 'anchor'
        ? { ['--bento-muted' as string]: 'var(--bento-anchor-ink)' }
        : {}
  const style = domain
    ? {
        ...baseStyle,
        backgroundColor: `var(--dom-${domain})`,
        color: `var(--dom-${domain}-text, var(--bento-ink))`,
        ['--bento-muted' as string]: `var(--dom-${domain}-text, var(--bento-ink))`,
        borderColor: 'transparent',
      }
    : { ...baseStyle, ...artStyle }
  
  return (
    <div
      className={cn(
        /* `relative isolate` is what makes the art layer possible without
           touching anything else: the cell becomes its own stacking context,
           so a child at a negative z-index paints above the cell's own
           background and border but below every in-flow child. The contents
           therefore keep their exact markup — no wrapper around `children`,
           which would break the `mt-auto` the cue uses to reach the bottom
           edge — and simply sit on top. */
        `bento-cell relative isolate flex min-h-0 min-w-0 flex-col overflow-hidden
         rounded-[var(--bento-radius)] border p-6 lg:p-4`,
        SPAN[span],
        TONE[t],
        className,
      )}
      style={Object.keys(style).length > 0 ? style : undefined}
    >
      {art && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
          {art}
        </div>
      )}
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

  /* The chart changes SHAPE with the room, it does not just get smaller.

     Ten labelled bars in a 1x1 is not a small chart, it is an unreadable one:
     the labels collide, each bar is three pixels wide, and the result reads as
     a rendering fault. The honest small version is a different drawing — the
     last few days only, no labels, the shape of the week rather than its
     values. Somebody who wants the values makes the card bigger, which is now
     a thing they can do.

     Given real room it goes the other way and draws taller, because a trend
     line in a 5x2 that keeps a 64px bar area is mostly empty card. */
  const detail = useDetail()
  const shown = detail === 'abstract' ? items.slice(-5) : items
  const barArea = detail === 'abstract' ? 'h-10' : detail === 'rich' ? 'h-full min-h-[96px]' : 'h-16'
  /* activeIndex points into the FULL list, so dropping the leading days shifts
     it. Without this the highlight lands past the end of what is drawn and the
     abstract chart loses the one bar that marks today. */
  const dropped = items.length - shown.length
  const activeAt = activeIndex === undefined ? undefined : activeIndex - dropped
  /* Scaled to the range, not to zero.

     Attendance sits between 91 and 99 for ten days running. Measured from
     zero those bars are 92% and 100% of the box — ten identical grey blocks,
     which is what a school actually saw here, and worse than no chart because
     it looks like a rendering fault rather than a flat week.

     So the floor drops below the lowest value instead of to zero, but only
     when the values are genuinely clustered high. A series that does start
     near zero — money collected, say — still gets a zero baseline, because
     there the distance from nothing is the information.

     The floor keeps a margin under the minimum rather than sitting on it, so
     the worst day is a short bar and not an absent one. */
  const values = items.map((i) => i.value)
  const max = Math.max(...values, 1)
  const min = Math.min(...values)
  const clustered = min > 0 && min / max > 0.6
  const floor = clustered ? min - (max - min || max * 0.05) * 0.8 : 0
  return (
    <div role="img" aria-label={srLabel} className="flex h-full items-end gap-1.5">
      {shown.map((item, i) => (
        <div key={`${item.label}-${i}`} className="flex min-w-0 flex-1 flex-col items-center gap-2">
          <div className={cn('flex w-full items-end', barArea)} title={item.title}>
            <div
              className={cn(
                'w-full rounded-[var(--bento-radius-sm)]',
                i === activeAt ? ACCENT_FILL[accent] : '',
                still ? '' : 'transition-[height] duration-300',
              )}
              style={{
                height: `${Math.max(6, ((item.value - floor) / (max - floor)) * 100)}%`,
                // The inactive bars are the muted tone, mixed down onto
                // whatever card they sit on. `--bento-card-2` alone — the
                // literal muted card tone — measures 1.13:1 against the light
                // card, which is a bar nobody can see, and the height of these
                // bars is information. `--bento-muted` at 70% clears 3:1 in
                // both modes while staying obviously secondary to the purple.
                ...(i === activeAt
                  ? null
                  : { backgroundColor: 'color-mix(in srgb, var(--bento-muted) 70%, transparent)' }),
              }}
            />
          </div>
          {detail !== 'abstract' && (
            <span className="truncate text-[10.5px] text-[var(--bento-muted)]">{item.label}</span>
          )}
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
  badge: _badge,
  accent,
  domain,
  art,
  span,
  to,
  cue,
}: {
  label: string
  value: string | number
  note?: string
  shape?: ReactNode
  /** The process behind the figure, drawn faintly behind the whole cell.
      Passed straight through to `Cell`; a stat cell that omits it renders
      exactly as it did before the slot existed. */
  art?: ReactNode
  /** The tinted qualifier that sits beside the figure. One hue, chosen for
      what the figure means — not for variety. */
  badge?: string
  accent?: Accent
  domain?: string
  span?: CellSpan
  /** Where the detail already lives. Omitted — or refused by the catalogue —
      and the cell simply carries no cue. */
  to?: string
  cue?: string
}) {
  return (
    <Cell span={span} accent={accent} domain={domain} art={art}>
      {/* The whisper. Small, wide-tracked, all caps — it gives the figure its
          subject and then gets out of the way.

          Semibold rather than bold: at 10px with 0.14em of tracking, extra
          weight stops reading as emphasis and starts reading as noise, and the
          label is not what the eye is meant to land on. */}
      <p
        className="bento-label text-[10px] font-semibold uppercase leading-tight tracking-[0.14em]
                   text-[var(--bento-muted)]"
      >
        {label}
      </p>
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
          /* The shout. Bigger, tighter and the first thing the eye finds.

             The ceiling goes from 32 to 40 because at 32 the figure was
             competing with the card's own title rather than dominating it; the
             floor stays at 26 so a short window still fits four rows. Tracking
             is negative because large figures set at their default spacing
             read as loose — the counters are already wide at this size.

             tabular-nums so a column of them lines up on the decimal, which is
             the whole reason a dashboard of money is readable at a glance. */
          className="font-extrabold leading-[0.95] tracking-[-0.035em] tabular-nums
                     text-[length:var(--bento-fig,clamp(26px,3.6vh,40px))]"
        >
          {value}
        </p>
        {/* The badge is no longer drawn.

            It was a tinted pill beside the figure — "62% of billed", "needs
            attention" — competing with the number it was meant to annotate:
            two things at the top of the card, both asking to be read first.
            The same fact is already in the note beneath, as a sentence, where
            it reads as support rather than as a rival.

            The prop stays in the signature so no dashboard breaks. */}
      </div>
      {shape && <div className="bento-shape mt-3">{shape}</div>}
      {note && (
        /* The subtext, and deliberately quiet: small, muted, and never
           competing with the figure it qualifies. */
        <p className="bento-note mt-1.5 text-[11px] leading-snug text-[var(--bento-muted)]">{note}</p>
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
  void tone; void dark
  return (
    <Link
      to={to}
      className={cn(
        /* A white pill with black text, on every card, in every theme.

           It used to take its colour from the card's tone — ink on a plain
           card, anchor-ink on the anchor. That worked while a card's ground
           came from a palette somebody had measured contrast against. Cards
           can now be tinted from an open colour wheel, so there is no colour
           the cue can inherit and still be guaranteed readable: the rule that
           gives dark text on mint gives dark text on navy too.

           So it stops inheriting. White ground, near-black text, its own
           contrast — the one control on the card that is legible whatever is
           behind it, which is what an action ought to be.

           mt-auto keeps it on the bottom edge; the padding is the button's
           own, so the control has a body rather than being text with space
           above it. */
        /* The pill inverts against whatever card it sits on: dark on a light
           card, white on a dark one. Fixed white was invisible in light mode —
           1.00:1 on the white card and 1.35:1 on the mint anchor — and only
           worked in dark, which is where it was designed. Inverted it measures
           17.7:1 and 16.6:1, and in dark mode it is still the white pill with
           near-black text it was meant to be. */
        `bento-cue mt-auto inline-flex w-fit items-center gap-1.5 rounded-full
         bg-[var(--bento-ink)] px-3 py-1.5 text-[12px] font-semibold
         text-[var(--bento-card)] shadow-sm`,
        still ? '' : 'transition-transform duration-150 hover:scale-[1.03]',
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
        /* White pill, near-black text — the same rule the cue follows, and for
           the same reason. This drew itself in the anchor's own ink on the
           anchor's own gradient, which worked while the anchor was the one
           card whose colours were fixed. Any card can now be tinted from an
           open wheel, so an action that inherits its colours is an action that
           can be given a pair with no contrast between them.

           An action carries its own contrast. It is the one thing on a card
           that must stay legible whatever ends up behind it. */
        `inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2.5
         text-[12.5px] font-semibold text-[#101114] shadow-sm ring-1 ring-black/5`,
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
  /* Before the early return: a hook cannot be called conditionally, and this
     component returns null for a series too short to draw. */
  const detail = useDetail()

  /* Thirty days of attendance in a 1x1 is a scribble — the line crosses itself
     several times in 60 pixels and says nothing. The small version is the last
     ten days, which still shows the trend and has room to show it.

     The tall version is not just a bigger box: a 28-unit viewBox stretched to
     56px flattens every movement, so the drawing gets more vertical range as
     well as more height. */
  const series = detail === 'abstract' ? points.slice(-10) : points
  const box = detail === 'abstract' ? 'h-6' : detail === 'rich' ? 'h-14' : 'h-8'

  if (series.length < 2) return null
  const w = 100
  const h = detail === 'rich' ? 44 : 28
  const min = Math.min(...series)
  const max = Math.max(...series)
  const range = max - min || 1
  const d = series
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
      className={cn(box, 'w-full', className)}
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

// --- art ----------------------------------------------------------------

/* THE PROCESS BEHIND THE FIGURE.

   Each drawing below is the shape of the thing the number came from, not an
   ornament chosen for variety. A reservoir, because collection genuinely fills
   toward a total. A blocked flow, because outstanding money genuinely did not
   move. A funnel, because admissions genuinely narrows. Where the data does
   not support a metaphor, there is no component here — a picture that teaches
   the reader something false about how the school works is worse than a plain
   number, because they will believe it.

   THREE RULES THEY ALL KEEP.

   1. Drawn from the real figure. The reservoir's waterline is
      collected/billed. The risk grid flags defaulters out of students, cell
      for cell. Nothing below invents a denominator to make a shape look
      finished — that is the same lie `Meter` already refuses to tell.

   2. Quieter than the text, in both modes. Every stroke is `--bento-muted`
      mixed down with `color-mix`, so there is not one hex here and the mode
      branch stays CSS's job. On a domain-tinted card `Cell` has already
      repointed `--bento-muted` at that card's own ink, so the art follows the
      tint instead of dropping a grey onto a saturated ground.

   3. They hide rather than shrink. A funnel at 1x1 — about 264x172 with
      padding — is four grey smudges, and a card that renders noise is worse
      than a card that renders nothing. `useWidgetSize` is read directly rather
      than `useDetail`, because the question here is "is there room for this
      particular drawing", which differs per drawing, and `detailFor` collapses
      2x1 and 1x2 into one answer when their difference is the whole point:
      almost all of these need WIDTH.

   No animation anywhere, at any preference. There is nothing to reduce. */

/** The three weights. Faint enough that the figure on top always wins the eye,
    and distinct enough from each other that the drawing still reads. */
const ART_LINE = 'color-mix(in srgb, var(--bento-muted) 22%, transparent)'
const ART_FILL = 'color-mix(in srgb, var(--bento-muted) 9%, transparent)'
const ART_MARK = 'color-mix(in srgb, var(--bento-muted) 32%, transparent)'
/* The network's own weight. Ninety-six edges at the ordinary line weight stop
   being a fan and become a solid grey wedge — the count is what makes it dense,
   so the count is what has to make each stroke fainter. */
const ART_WEB = 'color-mix(in srgb, var(--bento-muted) 13%, transparent)'

/** The frame every art shares: stretched to the cell, non-scaling strokes so
    `preserveAspectRatio="none"` cannot turn a hairline into a slab. */
function ArtSvg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 100 60"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className="h-full w-full"
    >
      {children}
    </svg>
  )
}

/** Does this cell have room for a drawing that needs `minW` columns and
    `minH` rows? Below it the caller returns null and the cell is simply a
    cell, which is what every widget looks like today. */
function useArtRoom(minW: number, minH = 1): boolean {
  const { w, h } = useWidgetSize()
  return w >= minW && h >= minH
}

/** A stable scatter. Seeded rather than `Math.random` so a card does not
    rearrange itself on every re-render, which reads as a fault. */
function scatter(n: number, seed: number): { x: number; y: number }[] {
  let s = seed >>> 0 || 1
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    const x = (s >>> 8) % 10000
    s = (s * 1664525 + 1013904223) >>> 0
    const y = (s >>> 8) % 10000
    out.push({ x: 6 + (x / 10000) * 88, y: 6 + (y / 10000) * 48 })
  }
  return out
}

/** ATTENDANCE, AS A CALENDAR. Because attendance *is* a calendar of days: the
    school either marked a day or it did not, and how densely the last month is
    marked is the fact behind the percentage.

    `slots` is the last 30 dates ending on the last day the school has, each
    carrying that day's percentage or null where there are no marks — weekends,
    holidays, and the days somebody has not got to yet. A marked day is filled,
    and shaded by its own percentage within the observed range so the month has
    texture; an unmarked day is an empty outline. Nothing is invented to square
    the grid off: a school with six days of marks gets six filled cells and
    twenty-four empty ones, which is the truth about that school.

    SEVEN COLUMNS, FOUR ROWS, TWENTY-EIGHT DAYS. Seven because a week is seven
    days and a calendar the reader recognises is the whole point — a ten-wide
    grid drew the same data and read as a bar code. Four weeks rather than
    five because the series is thirty days long: a fifth row would be days the
    response says nothing about, and an empty cell here means "the school did
    not mark that day", not "we did not ask".

    Needs 2x2. Twenty-eight cells across a 2x1 are 18px wide and 20px tall,
    and the rows read as stripes rather than as days. */
export function CalendarDensityArt({ slots }: { slots: (number | null)[] }) {
  const room = useArtRoom(2, 2)
  if (!room || slots.length === 0) return null

  const cols = 7
  const rows = Math.ceil(slots.length / cols)
  const marked = slots.filter((v): v is number => v !== null)
  const lo = marked.length ? Math.min(...marked) : 0
  const hi = marked.length ? Math.max(...marked) : 1
  const range = hi - lo || 1
  const cw = 100 / cols
  const ch = 60 / rows

  return (
    <ArtSvg>
      {slots.map((pct, i) => {
        const x = (i % cols) * cw + cw * 0.14
        const y = Math.floor(i / cols) * ch + ch * 0.14
        const w = cw * 0.72
        const h = ch * 0.72
        if (pct === null) {
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={w}
              height={h}
              fill="none"
              stroke={ART_LINE}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )
        }
        // 0.45 floor so the weakest marked day is still visibly a marked day,
        // not something the reader mistakes for an empty one.
        const weight = 0.45 + ((pct - lo) / range) * 0.55
        return <rect key={i} x={x} y={y} width={w} height={h} fill={ART_MARK} opacity={weight} />
      })}
    </ArtSvg>
  )
}

/** COLLECTION, AS A RESERVOIR. Because collection genuinely fills toward a
    total: money arrives, the level rises, and the total does not move.

    `fill` is collected over what was billed, and nothing else. The waterline
    is drawn at that height, the vessel is the whole of what was billed, and
    the space above the line is exactly what has not come in.

    Needs 2x1. At 1x1 the vessel and the line are eleven pixels apart. */
export function ReservoirArt({ fill }: { fill: number }) {
  const room = useArtRoom(2)
  if (!room) return null
  const f = Math.min(1, Math.max(0, fill))
  /* Inset well clear of the card's own edges. Drawn at 8..92 the vessel sat a
     few pixels inside the border and read as a second border rather than as a
     thing with contents. */
  const left = 20
  const right = 80
  const top = 8
  const bottom = 54
  const level = bottom - (bottom - top) * f

  return (
    <ArtSvg>
      {/* The vessel: everything that was billed. Open at the top, because more
          can still come in. */}
      <path
        d={`M${left},${top} L${left},${bottom} L${right},${bottom} L${right},${top}`}
        fill="none"
        stroke={ART_LINE}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      {/* The water: what has been collected. */}
      <rect x={left} y={level} width={right - left} height={bottom - level} fill={ART_FILL} />
      {/* The waterline, which is the figure. */}
      <line
        x1={left}
        y1={level}
        x2={right}
        y2={level}
        stroke={ART_MARK}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </ArtSvg>
  )
}

/** OUTSTANDING, AS A BLOCKED FLOW. Because that is money that did not move.

    `moved` is the share of everything billed that was actually collected, so
    the barrier stands exactly where the flow stopped and the arrested length
    to its right is exactly the outstanding share. Both fractions come off the
    same response; neither is chosen to make the picture look better.

    Needs 2x1. A pipe needs length — at 1x1 it is a short grey dash. */
export function BlockedFlowArt({ moved }: { moved: number }) {
  const room = useArtRoom(2)
  if (!room) return null
  const m = Math.min(1, Math.max(0, moved))
  const x0 = 6
  const x1 = 94
  const stop = x0 + (x1 - x0) * m
  const top = 18
  const bot = 42
  // The arrested length, hatched rather than filled: it is stationary, and a
  // solid block reads as more of the same flow.
  const hatch: number[] = []
  for (let x = stop + 4; x < x1; x += 6) hatch.push(x)

  return (
    <ArtSvg>
      <line x1={x0} y1={top} x2={x1} y2={top} stroke={ART_LINE} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <line x1={x0} y1={bot} x2={x1} y2={bot} stroke={ART_LINE} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {/* What moved. */}
      <rect x={x0} y={top} width={Math.max(0, stop - x0)} height={bot - top} fill={ART_FILL} />
      {/* Where it stopped. */}
      <line x1={stop} y1={top - 6} x2={stop} y2={bot + 6} stroke={ART_MARK} strokeWidth={3} vectorEffect="non-scaling-stroke" />
      {/* What did not. */}
      {hatch.map((x) => (
        <line key={x} x1={x} y1={top} x2={x} y2={bot} stroke={ART_LINE} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
    </ArtSvg>
  )
}

/** THE ROLL, AS A POPULATION. Because a roll is a population: `count` people,
    each one a mark, and the card's figure is how many marks there are.

    Deliberately an even scatter and NOT grouped by section, even though the
    reference calls this a cluster. Per-section counts are not in the response
    — only how many sections exist — so eight equal clumps would be a claim
    that the sections are equally full, which nobody has told us. The count is
    real; the arrangement claims nothing.

    Needs 2x1. Below that the marks collide into a smear. */
export function PopulationArt({ count }: { count: number }) {
  const room = useArtRoom(2)
  if (!room || count <= 0) return null
  // Past a few hundred the marks stop being countable and start being fog; the
  // figure is printed on top of this and is the thing that carries the number.
  const n = Math.min(count, 240)
  const pts = scatter(n, 0x5eed)
  return (
    <ArtSvg>
      {pts.map((p, i) => (
        <rect key={i} x={p.x} y={p.y} width={1.6} height={1.6} fill={ART_MARK} />
      ))}
    </ArtSvg>
  )
}

/** TEACHING LOAD, AS A NETWORK. Because it genuinely is one: a few people
    each connected to many.

    Drawn from both figures, exactly. `nodes` is the staff count, and each node
    fans out to `students / staff` edges — so the fan-out degree *is* the ratio
    the card is about, and the leaves add up to the roll.

    Needs 2x1, and reads far better at 2x2 where the fan has vertical room.
    At 1x1 the edges overlap into a grey wedge. */
export function NetworkArt({ nodes, degree }: { nodes: number; degree: number }) {
  const room = useArtRoom(2)
  if (!room || nodes <= 0 || degree <= 0) return null
  const n = Math.min(nodes, 14)
  const d = Math.min(degree, 26)
  const band = 60 / n

  return (
    <ArtSvg>
      {Array.from({ length: n }, (_, i) => {
        const ny = band * (i + 0.5)
        return (
          <g key={i}>
            {Array.from({ length: d }, (_, j) => {
              const ly = band * i + (band * (j + 0.5)) / d
              return (
                <line
                  key={j}
                  x1={14}
                  y1={ny}
                  x2={92}
                  y2={ly}
                  stroke={ART_WEB}
                  strokeWidth={0.75}
                  vectorEffect="non-scaling-stroke"
                />
              )
            })}
            <rect x={9} y={ny - 2.5} width={5} height={5} fill={ART_MARK} />
          </g>
        )
      })}
    </ArtSvg>
  )
}

/** ADMISSIONS, AS A FUNNEL. Because admissions genuinely narrows: more people
    apply than enrol, and every stage loses some.

    What is drawn from data and what is not, stated plainly. The WALLS are the
    process — they say the pipe narrows, which is true of admissions everywhere
    and is not a quantity. The MARKS at the mouth are `count`, the open
    applications, and that is the only number drawn. No stage counts are shown,
    because the response does not carry any and inventing three would be
    exactly the decoration this is against.

    Needs 2x1; wants 2x2, where the walls have the height to actually converge
    rather than reading as a shallow chevron. */
export function FunnelArt({ count }: { count: number }) {
  const room = useArtRoom(2)
  if (!room) return null
  const n = Math.min(Math.max(count, 0), 60)
  const pts = scatter(n, 0xfeed).map((p) => ({ x: 12 + (p.x - 6) * 0.86, y: 4 + (p.y - 6) * 0.28 }))

  return (
    <ArtSvg>
      <path d="M6,4 L94,4 L60,40 L60,58 L40,58 L40,40 Z" fill={ART_FILL} />
      <path
        d="M6,4 L40,40 L40,58 M94,4 L60,40 L60,58"
        fill="none"
        stroke={ART_LINE}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      {pts.map((p, i) => (
        <rect key={i} x={p.x} y={p.y} width={2} height={2} fill={ART_MARK} />
      ))}
    </ArtSvg>
  )
}

/** DEFAULTERS, AS A RISK GRID. Because it is a subset of a known whole: 44 of
    96, both figures on the same response, so the grid can be drawn cell for
    cell with no rounding and no invented total.

    The flagged cells are spread evenly through the grid rather than clumped in
    a corner. Which particular cells are flagged is not information we have —
    only how many — so an even spread is the arrangement that claims least. A
    clump would read as "one section is in trouble", which nobody has said. */
export function RiskGridArt({ total, flagged }: { total: number; flagged: number }) {
  const room = useArtRoom(2)
  if (!room || total <= 0) return null
  const n = Math.min(total, 400)
  const f = Math.min(Math.max(flagged, 0), n)
  // Roughly 100:60, so about 1.67 cells across for every one down.
  const cols = Math.max(4, Math.round(Math.sqrt(n * 1.67)))
  const rows = Math.ceil(n / cols)
  const cw = 100 / cols
  const ch = 60 / rows
  // Evenly spread, deterministic: cell i is flagged when the running count of
  // flags due by i ticks over. Exactly `f` cells end up flagged.
  let acc = 0

  return (
    <ArtSvg>
      {Array.from({ length: n }, (_, i) => {
        const before = acc
        acc = Math.floor(((i + 1) * f) / n)
        const isFlagged = acc > before
        return (
          <rect
            key={i}
            x={(i % cols) * cw + cw * 0.18}
            y={Math.floor(i / cols) * ch + ch * 0.18}
            width={cw * 0.64}
            height={ch * 0.64}
            fill={isFlagged ? ART_MARK : ART_FILL}
          />
        )
      })}
    </ArtSvg>
  )
}

/** The last `days` calendar days ending on the last day the series has, each
    carrying that day's attendance percentage or null where the school has no
    marks for it.

    Anchored on the series' own last date rather than on the reader's clock, so
    a browser outside India cannot shift the grid by a day — the same reason
    the bar labels are sliced off the ISO string instead of parsed. */
export function calendarSlots(
  series: { date: string; pct: number }[],
  days = 28,
): (number | null)[] {
  if (series.length === 0) return []
  const byDate = new Map(series.map((p) => [p.date, p.pct]))
  const last = series[series.length - 1].date
  const end = Date.parse(`${last}T00:00:00Z`)
  if (Number.isNaN(end)) return []
  const out: (number | null)[] = []
  for (let i = days - 1; i >= 0; i--) {
    const iso = new Date(end - i * 86_400_000).toISOString().slice(0, 10)
    const v = byDate.get(iso)
    out.push(v === undefined ? null : v)
  }
  return out
}

// --- states -------------------------------------------------------------

/** A failed query is an error, never an empty state. A zero on a finance
    dashboard that is really a failed fetch is worse than a blank one, because
    somebody will act on it. */
export function BentoError({ message }: { message: string }) {
  return (
    <div className="bento-surface min-h-full bg-[var(--bento-bg)] p-6 sm:p-7">
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
      className="bento-surface min-h-full bg-[var(--bento-bg)] p-6 text-[13.5px] text-[var(--bento-muted)] sm:p-7"
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

  /* The board is told, in pixels, how much room it has.

     Rows can then be a fraction of a DEFINITE height, which is the only way a
     board cannot overflow: divide what exists rather than adding up what is
     wanted. A fraction of an indefinite height silently becomes max-content,
     which is how rows ended up sized to their contents and the board ran off
     the bottom of the screen.

     Measured rather than computed from constants: the board's top edge moves
     with the header, the text-size axis and the density, so any fixed offset
     here would be wrong on most screens. */
  const boardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const board = boardRef.current
    if (!board) return
    const measure = () => {
      const top = board.getBoundingClientRect().top
      const room = Math.max(240, window.innerHeight - top - 16)
      board.style.setProperty('--board-h', `${Math.round(room)}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    /* The dock, the density and the text size all move the top edge, and none
       of them fire a resize. An observer on the board itself catches every
       cause without this file having to know what they are. */
    const ro = new ResizeObserver(measure)
    ro.observe(document.body)
    return () => {
      window.removeEventListener('resize', measure)
      ro.disconnect()
    }
  }, [])

  return (
    <div
      className={cn(
        /* bento-surface is what makes the board measurable.

           The class had been put on BentoError and BentoLoading — the two
           screens that have no board — and never on the page that does. So the
           row height's 100cqw had no container to resolve against and fell back
           to the viewport, which is why rows came out the wrong height and
           differed from each other. The background pattern, keyed to the same
           class, was only ever painting on loading screens for the same
           reason. */
        'bento-surface h-full w-full text-[var(--bento-ink)] flex flex-col pb-[calc(var(--bento-dock)+2rem)]',
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
      {/* Rows take the height their contents need.

          They used to be forced equal — auto-rows-fr — so the page would fit
          the viewport exactly. It fit, and it cost twice over: a card holding
          "Staff 9" was stretched to the height of the hero beside it and spent
          most of itself empty, while the hero, which genuinely needed more,
          was cut off at its own bottom edge with the billed figure below the
          fold and no way to reach it.

          auto rather than min, because the hero spans two rows and min-content
          tracks size to the cells that do not span; the tall one would be
          squeezed into whatever the short ones happened to need, which is the
          clipping again by another route.

          grid-flow-dense so the short cards back-fill the gaps the tall one
          leaves, instead of a column of holes down one side.

          The page may now scroll on a short window. That is the trade the last
          version got backwards: a dashboard that fits by hiding a number is
          not a dashboard that fits.

          What remains bounded on both sides, because both failures are real:

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
        ref={boardRef}
        className="bento-board grid grid-cols-1 gap-[var(--bento-gap)] sm:grid-cols-2
                   lg:min-h-[600px] lg:flex-1 lg:auto-rows-auto lg:grid-flow-dense
                   lg:grid-cols-5"
      >
        {children}
      </div>
    </div>
  )
}
