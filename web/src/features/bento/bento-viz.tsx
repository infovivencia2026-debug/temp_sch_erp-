import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useWidgetSize } from '@/lib/widget-size'
import { cn } from '@/lib/utils'

/* SIX DRAWINGS FOR THE BENTO CELLS.

   A companion to `bento-kit.tsx`, written to the same rules and deliberately
   kept in its own file: the kit is the vocabulary four dashboards already
   import, and adding to it is how a shared component acquires a second owner.
   Nothing here is imported by the kit; nothing here edits it.

   THE RULES THESE KEEP, WHICH ARE THE KIT'S RULES.

   1. Not one hex. Every colour is a Bento token or a `color-mix` on one, so
      the mode branch stays CSS's job and a domain-tinted cell — where `Cell`
      has repointed `--bento-muted` at that card's own ink — gets art in its
      own tint rather than a grey dropped onto a saturated ground.

   2. Colour is never the only channel. A heat cell also carries its value in
      `title` and in the label the screen reader is given; a segment also
      carries its share as a printed number; a quadrant point also carries its
      position, which is the actual claim. `srLabel` is required everywhere and
      is *stated*, not summarised away.

   3. They hide rather than shrink. `useWidgetSize` is read directly rather
      than `useDetail`, because `detailFor` collapses 2x1 and 1x2 into one
      answer and the difference between them is the whole question here —
      almost all of these need WIDTH. Below the room they need they return
      null, and the cell is simply a cell. The one exception is Quadrant,
      which at one row degrades to a labelled list rather than to nothing,
      because the rows it holds are still a finding.

   4. No data draws nothing. An empty array renders null, never a confident
      zero: a ring at 0%, a bar of one flat segment and an empty heat strip all
      look like measurements, and "we have no rows for this" is not a
      measurement. A denominator of zero is the same refusal `Meter` makes.

   5. No animation, at any motion preference. There is nothing to reduce.

   THE MARKS, AND WHY THEY ARE THIN.

   The first cut of these six drew 11-15px ring strokes, 14px pill segments,
   28px heat blocks and three different hues on one ordinal measure, and the
   verdict from the person paying for it was "stupid and blunt… like ancient
   pieces". Every one of those is a known anti-pattern — the thick saturated
   block is the loud, childish one — and this rewrite keeps to the measured
   rules instead:

     bars and cells   6-10px inside a card; 3-4px radius at the DATA end,
                      square at the baseline; 2px of surface between fills
     lines            2px, round caps; a hairline (1px, one step off the
                      surface) for an axis or a grid
     markers          8px
     fills            a wash at ~10%, never a block
     sequence         ONE hue, light step to dark step; the unfilled track is
                      a lighter step of the same hue
     ordinal          the same one-hue ramp, by position
     categorical      a fixed hue order, at most four in a card
     text             never wears the data colour — ink tokens, identity from a
                      dot beside the word
     size             every drawing reads its cell and never overflows it */

// --- the colour rule ----------------------------------------------------

/* ONE RULE, STATED ONCE, AND NOTHING HERE DEVIATES FROM IT.

   1. EVERY MARK IS AN ACCENT MIXED INTO `currentColor`, NEVER AN ACCENT ON ITS
      OWN. `currentColor` is the ink the cell has already resolved for its own
      ground — `--bento-ink` on a plain card, `--bento-anchor-ink` on the
      gradient, `--bento-bg` on an inverted card, `--dom-*-text` on a
      domain-tinted one — so a mark built on it cannot lose its ground the way
      a fixed colour can. The accent is a HUE CAST over an ink that already
      read, not a replacement for it.

      Measured at 55%: the worst pairing across the default light and dark
      themes, the Focus skin in both polarities and all four shipped palettes
      is 3.61:1 (mint on the default light card); every other pairing lands
      between 5:1 and 14:1. 3:1 is the floor for a graphical mark, so 55% is
      where the mix stops.

   2. FOUR ACCENTS, FOUR MEANINGS — the kit's existing rule, kept:

        purple  the measurement itself; the reading you came for
        mint    arrived, collected, present, done
        orange  pending, in caution
        pink    outstanding, overdue, at risk, money out

      A primitive that draws one quantity draws it in purple. A primitive
      whose quantity has a valence draws it in the hue of that valence. A
      primitive that draws PARTS of a whole gives each part the next hue in
      the fixed order below, so the same category is the same hue on every
      board.

   3. A SEQUENCE IS ONE HUE AT FIVE STEPS. "More of the same measure" moves
      the mark's alpha over the surface from a light step to the full mark,
      and never changes hue — a value ramp that changes hue reads as a
      category ramp, which is how the old AgeBands came to say "green, brown,
      red" about four buckets of the same debt. On the dark card the light
      steps sit closer to that card, which is the deliberate dark choice: a
      low value is nearer the surface in both themes rather than a flipped
      palette.

   4. COLOUR IS DECORATION ON TOP OF A READING THAT ALREADY WORKED. Every
      `title`, every printed value, every legend and every `srLabel` below is
      untouched. Remove all colour and these still read, which is the test. */

const ACCENT = {
  mint: 'var(--bento-mint)',
  purple: 'var(--bento-purple)',
  pink: 'var(--bento-pink)',
  orange: 'var(--bento-orange)',
} as const
type Hue = keyof typeof ACCENT

/** A mark. The strongest an accent is ever drawn, and the level every
    measured contrast above refers to. */
const mark = (h: Hue) => `color-mix(in srgb, ${ACCENT[h]} 55%, currentColor)`
/** One hue at a fraction of its alpha over whatever surface it sits on. Every
    lighter step of a hue — the track, the wash, the low end of a ramp — is
    this and nothing else, so a sequence can only ever be one hue. */
const tone = (h: Hue, pct: number) => `color-mix(in srgb, ${mark(h)} ${pct}%, transparent)`
/** The five steps of a sequential ramp, light to dark. Quantised, because a
    continuous ramp across thirty cells reads as thirty different colours and
    five reads as five weights, which is what a heat strip is for. */
const STEPS = [30, 48, 66, 83, 100] as const
const seq = (h: Hue, f: number) =>
  tone(h, STEPS[Math.round(Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0)) * 4)])
/** The unfilled part of a meter: a lighter step of the same hue. */
const track = (h: Hue) => tone(h, 14)
/** An area under a mark. A wash, never a block. */
const wash = (h: Hue) => tone(h, 10)
/** The fixed order for parts of a whole. Purple first because the largest
    part is the reading; the valence hues follow so a second category is never
    a second purple. Mint LAST, measured: two of the shipped palettes define
    `--bento-mint` and `--bento-purple` as the same teal, so purple-then-mint
    would give the two largest parts one colour on those boards. Orange and
    pink are distinct from purple in every palette. */
const CATEGORY: readonly Hue[] = ['purple', 'orange', 'pink', 'mint']
const category = (i: number) => (i < CATEGORY.length ? mark(CATEGORY[i]) : tone(CATEGORY[i % CATEGORY.length], 60))

/* The neutrals. `currentColor` rather than `--bento-muted`, for the same
   reason: an axis and a hairline have to sit on whatever ground the cell
   turned out to have. 14% is one step off the surface — visible, recessive,
   and never a competitor to a mark at 55%. */
const VIZ_LINE = 'color-mix(in srgb, currentColor 14%, transparent)'
/** Today, and nothing else: a firm line, still in the cell's own ink. */
const VIZ_NOW = 'color-mix(in srgb, currentColor 60%, transparent)'

/** QUIET TEXT: the endpoint keys, the band labels, the dates under an axis.

    `--bento-muted` alone is not safe here. It is a grey measured against a
    LIGHT card, and on the inverted cell two dashboards ship it measures
    3.55:1 — under the 4.5:1 a label has to clear. Pulled 30% toward
    `currentColor` it clears 4.45:1 at worst across the default light and dark
    themes, the Focus skin in both polarities, all four shipped palettes, the
    anchor gradient and the inverted cell, while staying visibly quieter than
    the figure beside it. On the default themes it resolves to the ink. */
const VIZ_QUIET = 'color-mix(in srgb, var(--bento-muted) 70%, currentColor)'

/** Does this cell have room for a drawing that needs `minW` columns and
    `minH` rows? Below it the caller returns null. */
function useRoom(minW: number, minH = 1): boolean {
  const { w, h } = useWidgetSize()
  return w >= minW && h >= minH
}

/* THE CELL, IN PIXELS, WITHOUT A LAYOUT PASS.

   A column is 264px and a row 172px on the board these are drawn for, less the
   card's own padding. The drawings use these to decide what FITS — how many
   legend entries sit on one line, which timeline labels would collide — before
   the browser lays anything out, so a label is never painted and then cut. The
   estimate is deliberately pessimistic (0.58em per character at the label
   size), which errs toward stacking a legend that would just have fitted
   rather than clipping one that would not. */
const COL_PX = 264
const ROW_PX = 172
const cellW = (w: number) => w * COL_PX - 40
const cellH = (h: number) => h * ROW_PX - 88
const textPx = (s: string, size = 11) => s.length * size * 0.58

/** The box a drawing actually got, once it has one.

    The estimate above is what the first render works from; this replaces it
    with the measured width and height as soon as the element is laid out, and
    keeps it current as the cell resizes. Under a static render (the tests, a
    server) there is no layout and the estimate stands — so the fit logic is
    the same code either way, only its input improves. */
function useMeasuredBox<T extends HTMLElement>(): [RefObject<T>, { w: number; h: number } | null] {
  const ref = useRef<T>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0) setBox({ w: r.width, h: r.height })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, box]
}

/** One place that decides how a share is written, so six drawings do not
    develop six opinions about rounding. */
function pctText(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const p = (part / whole) * 100
  return `${p >= 9.95 || p === 0 ? Math.round(p) : p.toFixed(1)}%`
}

// --- 1. Ring ------------------------------------------------------------

/** A PROPORTION, AS AN ARC. The one shape that says "of a whole" without
    needing a second mark to compare against: the gap is as legible as the
    fill, which is what a bar in a narrow cell stops being.

    Drawn from `value` over `total` and from nothing else. A ring with an
    invented denominator is the lie `Meter` already refuses to tell, so a
    `total` of zero draws nothing rather than an empty circle that reads as
    0% of something real.

    The percentage is printed in the middle. That is not decoration: an arc
    read off by eye is worth about a quarter turn of precision, and the two
    figures under it are what somebody actually quotes.

    THIN, AND INSIDE ITS CELL. The stroke is 6px — it was 11 with a 15px halo
    under it, which at a 1x1 cell was a third of the box and cut top and
    bottom by the card. The stroke is non-scaling, the radius sits inside the
    viewBox by more than the stroke's own width, and the box is capped at
    120px, so the ring is whole at every size. */
export function Ring({
  value,
  total,
  srLabel,
  className,
}: {
  value: number
  total: number
  srLabel: string
  className?: string
}) {
  // Before the early return: a hook cannot be called conditionally, and this
  // one only exists to keep two rings on one board from sharing a gradient id.
  const gid = useId()
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null

  const v = Math.min(Math.max(value, 0), total)
  const frac = v / total
  const r = 42
  const circumference = 2 * Math.PI * r
  const drawn = circumference * frac
  /* At 100% the dash pattern's two round caps meet at twelve o'clock and
     overlap into a visible notch. A full ring is drawn as a plain circle. */
  const complete = frac >= 1

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${v} of ${total}, ${pctText(v, total)}`}
      className={cn('flex h-full w-full items-center justify-center', className)}
    >
      <div className="relative aspect-square h-full max-h-[120px] min-h-[64px]">
        <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" className="h-full w-full">
          <defs>
            {/* ONE hue, light step to full mark, along the arc — the
                sequential rule. Never a second hue: an arc that changes hue
                along its length reads as two categories. `userSpaceOnUse` so
                the ramp is laid across the ring's box rather than the
                stroke's bounding box, which for a short arc would compress
                the whole ramp into the first few degrees. */}
            <linearGradient id={`${gid}-arc`} gradientUnits="userSpaceOnUse" x1={8} y1={0} x2={92} y2={100}>
              <stop offset="0%" stopColor={tone('purple', 70)} />
              <stop offset="100%" stopColor={mark('purple')} />
            </linearGradient>
          </defs>
          {/* The whole: a lighter step of the same hue. */}
          <circle cx={50} cy={50} r={r} fill="none" stroke={track('purple')} strokeWidth={6} vectorEffect="non-scaling-stroke" />
          {/* The part. Started at twelve o'clock and drawn clockwise, because
              that is the direction every dial a reader has ever met turns. */}
          <circle
            cx={50}
            cy={50}
            r={r}
            fill="none"
            stroke={`url(#${gid}-arc)`}
            strokeWidth={6}
            strokeLinecap={complete ? 'butt' : 'round'}
            strokeDasharray={complete ? undefined : `${drawn} ${circumference}`}
            transform="rotate(-90 50 50)"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* HTML rather than <text>, so the type keeps the card's own font
            stack and its own size instead of being scaled by the viewBox. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[15px] font-semibold leading-none tabular-nums" style={{ color: 'currentColor' }}>
            {pctText(v, total)}
          </span>
          <span className="mt-1 text-[length:var(--viz-label,10px)] leading-none tabular-nums" style={{ color: VIZ_QUIET }}>
            {v}/{total}
          </span>
        </div>
      </div>
    </div>
  )
}

// --- 2. SegmentBar ------------------------------------------------------

/** A COMPOSITION, AS ONE BAR. Because the claim is "these parts make up that
    whole", and a bar whose total width is the whole makes the claim
    structurally — the reader cannot misread the shares as independent
    quantities the way they can from four separate bars.

    The total is the sum of what was passed, never a figure supplied
    separately: a segmented bar with a gap at the end is a bar with an
    unlabelled fifth category, and no dashboard has ever meant that.

    Parts are CATEGORIES, so each takes the next hue in the fixed order — the
    same category is the same hue on every board — and the legend gives each
    word a dot in its hue while the word itself stays in ink. 8px tall, 2px of
    surface between segments, rounded only at the bar's two outer ends: the
    joins between parts are square, because a row of rounded pills reads as a
    row of separate objects rather than as one whole.

    THE LEGEND MUST FIT, AND IS NEVER CUT. Its width is estimated against the
    cell before it is laid out: on one line when everything fits, otherwise
    two columns, otherwise one per line — and past what the cell's rows can
    hold, the smallest parts are folded into one "+N" entry rather than
    truncated mid-word. "Hostel ₹36,0…" is a legend that says less than no
    legend at all.

    Zero-valued segments are dropped from the bar — a zero-width slice is a
    rendering fault with a tooltip — but stay in the legend at 0, because "none
    of this category" is a finding. Fits 1x1. */
export function SegmentBar({
  segments,
  srLabel,
  formatValue,
  className,
}: {
  segments: { label: string; value: number }[]
  srLabel: string
  /** How a segment's value is written, in the legend, the title and the label
      the screen reader gets. Defaults to the bare number: a count and an
      amount of money are not the same thing, and a bare paise integer read as
      rupees is wrong by a factor of a hundred. */
  formatValue?: (v: number) => string
  className?: string
}) {
  const { w, h } = useWidgetSize()
  const [ref, box] = useMeasuredBox<HTMLDivElement>()
  const usable = segments.filter((s) => Number.isFinite(s.value) && s.value >= 0)
  const total = usable.reduce((a, s) => a + s.value, 0)
  if (usable.length === 0 || total <= 0) return null

  const drawn = usable.filter((s) => s.value > 0)
  const fmt = formatValue ?? ((v: number) => String(v))

  /* The legend layout, decided from the box the bar actually has (the estimate
     until it is laid out). An entry is an 8px dot, a gap, the label, a gap and
     the value. */
  const entryPx = (s: { label: string; value: number }) => 8 + 6 + textPx(s.label) + 8 + textPx(fmt(s.value))
  const width = box?.w ?? cellW(w)
  const rows = Math.max(1, h * 3) // legend lines a cell can hold under its bar
  const inline = usable.reduce((a, s) => a + entryPx(s), 0) + (usable.length - 1) * 14 <= width
  const twoCol = !inline && usable.every((s) => entryPx(s) <= width / 2 - 8)
  const perLine = inline ? usable.length : twoCol ? 2 : 1
  const capacity = perLine * rows
  /* Fold, never cut. The smallest parts fold into one entry; the bar itself
     still draws every part, and the screen reader still hears every one. */
  const shown = usable.length > capacity
    ? [...usable].sort((a, b) => b.value - a.value).slice(0, Math.max(1, capacity - 1))
    : usable
  const folded = usable.filter((s) => !shown.includes(s))

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${usable
        .map((s) => `${s.label} ${fmt(s.value)}, ${pctText(s.value, total)}`)
        .join('; ')}. Total ${fmt(total)}.`}
      className={cn('flex w-full flex-col gap-2', className)}
      ref={ref}
    >
      <div className="flex h-[8px] w-full items-stretch" style={{ gap: '2px' }}>
        {drawn.map((s, i) => (
          <div
            key={`${s.label}-${i}`}
            title={`${s.label}: ${fmt(s.value)} (${pctText(s.value, total)})`}
            className={cn(i === 0 && 'rounded-l-[4px]', i === drawn.length - 1 && 'rounded-r-[4px]')}
            style={{
              width: `${(s.value / total) * 100}%`,
              minWidth: '4px',
              background: category(usable.indexOf(s)),
            }}
          />
        ))}
      </div>
      <ul
        className={cn(
          'm-0 list-none p-0 text-[length:var(--viz-label,11px)] leading-tight tabular-nums',
          inline ? 'flex flex-nowrap gap-x-3.5' : twoCol ? 'grid grid-cols-2 gap-x-3 gap-y-1' : 'flex flex-col gap-1',
        )}
        aria-hidden="true"
      >
        {shown.map((s) => {
          const i = usable.indexOf(s)
          return (
            <li key={`${s.label}-${i}`} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: category(i) }} />
              <span style={{ color: VIZ_QUIET }}>{s.label}</span>
              <span className="ml-auto pl-1 font-semibold">{fmt(s.value)}</span>
            </li>
          )
        })}
        {folded.length > 0 && (
          <li className="flex min-w-0 items-center gap-1.5 whitespace-nowrap" style={{ color: VIZ_QUIET }}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: VIZ_LINE }} />
            <span>+{folded.length} more</span>
            <span className="ml-auto pl-1 font-semibold" style={{ color: 'currentColor' }}>
              {fmt(folded.reduce((a, s) => a + s.value, 0))}
            </span>
          </li>
        )}
      </ul>
    </div>
  )
}

// --- 3. AgeBands --------------------------------------------------------

/** AGEING, AS ORDERED BANDS. Deliberately NOT a segmented bar, even though the
    data would fit one: ageing buckets have an order and a direction — money
    gets worse as it moves right — and stacking them into one bar throws that
    away. Separate bands, in the order given, top to bottom, each one's length
    its own count against the largest bucket.

    Scaled to the largest band rather than to the total, because the question
    a reader brings is "which bucket is the problem", and against a total the
    small buckets are all hairlines.

    ONE HUE. The buckets are an ORDINAL measure — the same debt, older — so
    they take the ordinal ramp of one hue by position: the oldest is the full
    mark, the newest the lightest step. The hue is pink, the one that means
    "outstanding", because that is what every bucket here is. The old drawing
    ran mint through orange to pink, which said "good, warning, bad" about
    four amounts of the same thing — status colours on a series.

    6px bars, rounded at the data end only, square at the label edge, over a
    track that is the lightest step of the same hue.

    An all-zero set draws nothing: four empty rails labelled 0 look like a
    chart that failed to load, and "nothing is overdue" belongs in a sentence.
    Fits 1x1 at up to four bands. */
export function AgeBands({
  bands,
  srLabel,
  formatValue,
  className,
}: {
  bands: { label: string; value: number }[]
  srLabel: string
  /** How a band's count is written. Defaults to the bare number. */
  formatValue?: (v: number) => string
  className?: string
}) {
  const { w } = useWidgetSize()
  const usable = bands.filter((b) => Number.isFinite(b.value) && b.value >= 0)
  const max = usable.reduce((a, b) => Math.max(a, b.value), 0)
  if (usable.length === 0 || max <= 0) return null

  const wide = w >= 2
  const fmt = formatValue ?? ((v: number) => String(v))
  const at = (i: number) => (usable.length <= 1 ? 1 : i / (usable.length - 1))

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${usable.map((b) => `${b.label}, ${fmt(b.value)}`).join('; ')}.`}
      className={cn('flex w-full flex-col gap-[7px]', className)}
    >
      {usable.map((b, i) => (
        <div key={`${b.label}-${i}`} className="flex items-center gap-2">
          <span
            className={cn('shrink-0 truncate text-[length:var(--viz-label,10.5px)] leading-none tabular-nums', wide ? 'w-14' : 'w-11')}
            style={{ color: VIZ_QUIET }}
          >
            {b.label}
          </span>
          <div className="h-[9px] min-w-0 flex-1 overflow-hidden rounded-r-[3px]" style={{ background: track('pink') }}>
            <div
              className="h-full rounded-r-[3px]"
              style={{
                // A floor, so a band with one item in it is a visible mark and
                // not an empty rail indistinguishable from a zero.
                width: b.value === 0 ? '0%' : `${Math.max(4, (b.value / max) * 100)}%`,
                background: seq('pink', at(i)),
              }}
            />
          </div>
          <span
            className={cn('shrink-0 text-right text-[length:var(--viz-label,11px)] font-semibold leading-none tabular-nums', wide ? 'w-12' : 'w-8')}
          >
            {fmt(b.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

// --- 4. HeatStrip -------------------------------------------------------

/** A SERIES, AS INTENSITY. One row of cells, one cell per period, shaded by
    its own value within the observed range. The kit already has `Sparkline`
    for the shape of a series; this is for the series where the shape is not
    the point and the question is "which of these were the heavy ones".

    ONE HUE, FIVE STEPS, 10px TALL. The first cut was 28px blocks of a
    purple-to-pink ramp with the alpha rising as well — a barcode of thick
    saturated blocks, the loudest thing a card can draw. Now the cells are a
    thin row, every one the measurement hue, and the value moves only which of
    five steps it takes; a strip of weights, not a strip of colours.

    Shade is a weak channel and is not asked to work alone: every cell carries
    its value in `title`, the whole series is stated in the label the screen
    reader gets, and the observed low and high are printed as endpoints under
    the strip so a shade can be converted back into a number.

    A null cell is a NEUTRAL step, not a light one of the hue: "no data for
    this period" and "a low value this period" are different facts, and here
    one has no hue and the other has the hue at its lightest. No outline — a
    stroke around a mark is the one thing a mark never wears.

    A flat series — every observed value identical — is drawn at the middle
    step rather than at the ramp's floor, because within-range shading of a
    range of zero is meaningless and a strip that reads as "all lowest" would
    be false. Needs 2x1. */
export function HeatStrip({
  cells,
  srLabel,
  formatValue,
  className,
}: {
  cells: (number | null)[]
  srLabel: string
  formatValue?: (v: number) => string
  className?: string
}) {
  const room = useRoom(2)
  const anySignal = cells.some((c) => c !== null && c !== 0)
  const present = cells.filter((c): c is number => c !== null && Number.isFinite(c))
  if (!room || cells.length === 0 || present.length === 0 || !anySignal) return null

  const fmt = formatValue ?? ((v: number) => String(v))
  const lo = Math.min(...present)
  const hi = Math.max(...present)
  const range = hi - lo
  const flat = range === 0

  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      <div
        role="img"
        aria-label={`${srLabel}: ${cells.map((c) => (c === null ? 'no data' : fmt(c))).join(', ')}.`}
        className="flex h-[10px] w-full items-stretch"
        style={{ gap: '2px' }}
      >
        {cells.map((c, i) =>
          c === null || !Number.isFinite(c) ? (
            <div key={i} title="No data" className="min-w-0 flex-1 rounded-[2px]" style={{ background: VIZ_LINE }} />
          ) : (
            <div
              key={i}
              title={fmt(c)}
              className="min-w-0 flex-1 rounded-[2px]"
              style={{ background: flat ? seq('purple', 0.5) : seq('purple', (c - lo) / range) }}
            />
          ),
        )}
      </div>
      {/* The key back to numbers. Without it the strip is colour-only. */}
      <div
        className="flex items-baseline justify-between text-[length:var(--viz-label,10px)] leading-none tabular-nums"
        style={{ color: VIZ_QUIET }}
        aria-hidden="true"
      >
        <span>{fmt(lo)}</span>
        <span>{fmt(hi)}</span>
      </div>
    </div>
  )
}

// --- 5. Timeline --------------------------------------------------------

/** EVENTS, ALONG TIME. Positioned by their date within a stated window, so the
    gaps between marks are real gaps — which is the entire reason not to draw
    this as a list.

    THE WINDOW IS PASSED IN, NOT INFERRED. Deriving it from the first and last
    event makes the drawing lie in the most damaging direction: three exams in
    one week and nothing else would fill the axis edge to edge and read as a
    term evenly covered. The caller knows the term; the caller says so.

    EVENTS SHARING A DATE STACK. Two exams on the same morning are two events,
    and a drawing that overplots them into one mark has quietly lost one. Marks
    at the same x are dodged upward in the order given, and the axis is given
    the height to hold the deepest stack. Past what fits, the overflow is
    counted in the key rather than dropped silently.

    LABELLED, SELECTIVELY. Five dots on a line with no names is a drawing of
    "five things" — the old one. Each mark is now named where its name fits:
    labels are placed left to right and one that would collide with the label
    before it is skipped, so the drawing is never a row of overprinted words.
    Every mark keeps its `title` and the screen reader hears every one.

    TODAY IS MARKED, with a 2px line; what is past is drawn muted and what is
    to come at full weight, so the axis reads as a term in progress rather than
    a list of dates. The axis itself is a hairline. Needs 2x1. */
export function Timeline({
  events,
  from,
  to,
  srLabel,
  className,
  now = Date.now(),
}: {
  events: { label: string; date: string | number | Date }[]
  /** The start of the window drawn. Inclusive. */
  from: string | number | Date
  /** The end of the window drawn. Inclusive. */
  to: string | number | Date
  srLabel: string
  className?: string
  /** "Today", for the marker and for which events count as past. A prop so a
      test or a snapshot can pin it; every caller leaves it alone. */
  now?: number
}) {
  const { w, h } = useWidgetSize()
  const [ref, box] = useMeasuredBox<HTMLDivElement>()
  const room = w >= 2

  const t0 = new Date(from).getTime()
  const t1 = new Date(to).getTime()
  const span = t1 - t0

  // A window of zero or negative length cannot position anything; a reversed
  // pair is a caller bug and a drawing is the wrong place to guess at the fix.
  if (!room || events.length === 0 || !Number.isFinite(t0) || !Number.isFinite(t1) || span <= 0) {
    return null
  }

  const placed = events
    .map((e) => ({ label: e.label, t: new Date(e.date).getTime() }))
    .filter((e) => Number.isFinite(e.t) && e.t >= t0 && e.t <= t1)
    .sort((a, b) => a.t - b.t)

  if (placed.length === 0) return null

  /* The stack. Events are dodged by their position on the axis rather than by
     exact date equality: two events a day apart in a term-long window land on
     the same pixel and overplot just as completely as two on the same day. */
  const tiers = h >= 2 ? 4 : 2
  const lanes: number[] = []
  const marks = placed.map((e) => {
    const x = ((e.t - t0) / span) * 100
    let lane = 0
    while (lane < tiers && lanes[lane] !== undefined && x - lanes[lane] < 4) lane++
    const seated = lane < tiers
    if (seated) lanes[lane] = x
    return { ...e, x, lane: seated ? lane : -1 }
  })

  const hidden = marks.filter((m) => m.lane < 0).length
  const seatedMarks = marks.filter((m) => m.lane >= 0)

  /* Which marks get their name. Greedy, left to right, against the estimated
     width of each label in this cell; a label whose left edge would fall
     inside the previous label's right edge is skipped. Labels sit above the
     mark's lane, so only same-lane neighbours can collide. */
  const width = box?.w ?? cellW(w)
  const lastRight: number[] = []
  const labelled = seatedMarks.map((m) => {
    const px = (m.x / 100) * width
    const half = textPx(m.label, 10) / 2
    const left = Math.max(0, px - half)
    const right = Math.min(width, px + half)
    const ok = (lastRight[m.lane] === undefined || left > lastRight[m.lane] + 8) && right - left <= width
    if (ok) lastRight[m.lane] = right
    return ok
  })

  const laneStep = 12
  const stackHeight = laneStep * tiers
  const todayX = now >= t0 && now <= t1 ? ((now - t0) / span) * 100 : null

  const dateText = (t: number) => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

  return (
    <div
      role="img"
      aria-label={`${srLabel}, ${dateText(t0)} to ${dateText(t1)}: ${placed
        .map((e) => `${e.label} on ${dateText(e.t)}${e.t < now ? ' (past)' : ''}`)
        .join('; ')}.`}
      className={cn('flex w-full flex-col gap-1', className)}
      ref={ref}
    >
      <div className="relative w-full" style={{ height: `${stackHeight + 14}px` }}>
        {/* The axis: a hairline, one step off the surface. */}
        <div aria-hidden="true" className="absolute inset-x-0 bottom-[3px] h-px w-full" style={{ background: VIZ_LINE }} />
        {/* Today. */}
        {todayX !== null && (
          <div
            aria-hidden="true"
            title={`Today — ${dateText(now)}`}
            className="absolute bottom-0 w-[2px] -translate-x-1/2 rounded-full"
            style={{ left: `${todayX}%`, height: `${stackHeight + 6}px`, background: VIZ_NOW }}
          />
        )}
        {seatedMarks.map((m, i) => {
          const past = m.t < now
          return (
            <div
              key={`${m.label}-${i}`}
              title={`${m.label} — ${dateText(m.t)}`}
              className="absolute"
              style={{ left: `${m.x}%`, bottom: `${m.lane * laneStep}px`, transform: 'translateX(-50%)' }}
            >
              {/* A stem down to the axis, so a dodged mark still reads as
                  belonging to its own point in time rather than floating. */}
              {m.lane > 0 && (
                <span
                  className="absolute left-1/2 w-px -translate-x-1/2"
                  style={{ bottom: `-${m.lane * laneStep}px`, height: `${m.lane * laneStep}px`, background: VIZ_LINE }}
                  aria-hidden="true"
                />
              )}
              {/* 8px, the measurement hue; muted once it has passed. */}
              <span
                className="relative block h-[8px] w-[8px] rounded-full"
                style={{ background: past ? tone('purple', 40) : mark('purple') }}
                aria-hidden="true"
              />
              {labelled[i] && (
                <span
                  className="absolute left-1/2 whitespace-nowrap text-[length:var(--viz-label,10px)] leading-none"
                  style={{
                    bottom: '11px',
                    transform: 'translateX(-50%)',
                    color: VIZ_QUIET,
                    opacity: past ? 0.75 : 1,
                  }}
                  aria-hidden="true"
                >
                  {m.label}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <div
        className="flex items-baseline justify-between text-[length:var(--viz-label,10px)] leading-none tabular-nums"
        style={{ color: VIZ_QUIET }}
        aria-hidden="true"
      >
        <span>{dateText(t0)}</span>
        {hidden > 0 && <span>+{hidden} more</span>}
        <span>{dateText(t1)}</span>
      </div>
    </div>
  )
}

// --- 6. Quadrant --------------------------------------------------------

/** TWO MEASURES AT ONCE, AS A FIELD. Because the finding is a *combination* —
    high absence and low marks is a different student from high absence alone —
    and no arrangement of bars puts a reader in front of that.

    The dividing lines sit at the midpoint of each observed range, so "top
    right" means "high on both, relative to these points", which is what the
    reader will read into it anyway. That is stated in the screen-reader label
    rather than left implied. Only the two corners that carry a plain finding
    are named — "both high", "both low" — in two short words that fit at any
    width; the old four-corner captions truncated to "high Fees paid % · l".

    Points are 8px marks at one weight and one hue, labelled where the label
    fits. Density is the finding, and a ramp over a scatter reads as a third
    variable nobody supplied.

    A single point draws nothing: one mark cannot establish the ranges the
    dividing lines are drawn from.

    AT ONE ROW IT IS A LIST, NOT NOTHING. A field needs 120px of height to
    place a point anywhere meaningful, and a 2x1 cell cannot give it that
    under a title and a figure. The same rows are still a finding, so the
    drawing degrades to a labelled list — each point named with its two
    values and its quadrant — rather than to a blank card. Needs 2 columns. */
export function Quadrant({
  points,
  xLabel,
  yLabel,
  srLabel,
  className,
}: {
  points: { x: number; y: number; label: string }[]
  /** What the horizontal axis measures, low end to high end. */
  xLabel: string
  /** What the vertical axis measures, low end to high end. */
  yLabel: string
  srLabel: string
  className?: string
}) {
  const { w, h } = useWidgetSize()
  const [ref, box] = useMeasuredBox<HTMLDivElement>()
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  if (w < 2 || usable.length < 2) return null

  const xs = usable.map((p) => p.x)
  const ys = usable.map((p) => p.y)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const xr = x1 - x0
  const yr = y1 - y0
  const px = (v: number) => (xr === 0 ? 50 : 6 + ((v - x0) / xr) * 88)
  const py = (v: number) => (yr === 0 ? 50 : 94 - ((v - y0) / yr) * 88)

  const inQuad = (p: { x: number; y: number }) =>
    `${p.y >= (y0 + y1) / 2 ? 'high' : 'low'} ${yLabel}, ${p.x >= (x0 + x1) / 2 ? 'high' : 'low'} ${xLabel}`

  const ariaLabel = `${srLabel}. Horizontal axis ${xLabel}, vertical axis ${yLabel}, each divided at the midpoint of the observed range. ${usable
    .map((p) => `${p.label}: ${inQuad(p)}`)
    .join('; ')}.`

  /* One row: the list. */
  if (h < 2) {
    const shown = usable.slice(0, 3)
    return (
      <div role="img" aria-label={ariaLabel} className={cn('w-full', className)}>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[length:var(--viz-label,11px)] leading-tight tabular-nums" aria-hidden="true">
          {shown.map((p, i) => (
            <li key={`${p.label}-${i}`} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: mark('purple') }} />
              <span className="font-semibold">{p.label}</span>
              <span style={{ color: VIZ_QUIET }}>{xLabel} {p.x} · {yLabel} {p.y}</span>
            </li>
          ))}
          {usable.length > shown.length && (
            <li className="whitespace-nowrap" style={{ color: VIZ_QUIET }}>+{usable.length - shown.length} more</li>
          )}
        </ul>
      </div>
    )
  }

  /* Which points get their name: greedy in the order given, against the
     estimated label box in this cell's pixels. */
  const width = box?.w ?? cellW(w)
  const height = box?.h ?? cellH(h)
  const boxes: { l: number; r: number; t: number; b: number }[] = []
  /* 'right' beside the point, 'left' when the right side would run off the
     field, none when either would overprint a label already placed. */
  const labelled = usable.map((p): 'right' | 'left' | null => {
    const cx = (px(p.x) / 100) * width
    const cy = (py(p.y) / 100) * height
    const len = textPx(p.label, 10)
    for (const side of ['right', 'left'] as const) {
      const b = side === 'right'
        ? { l: cx + 7, r: cx + 7 + len, t: cy - 6, b: cy + 6 }
        : { l: cx - 7 - len, r: cx - 7, t: cy - 6, b: cy + 6 }
      const fits = b.l >= 0 && b.r <= width && b.t >= 0 && b.b <= height
      if (fits && !boxes.some((o) => b.l < o.r && b.r > o.l && b.t < o.b && b.b > o.t)) {
        boxes.push(b)
        return side
      }
    }
    return null
  })

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn('flex h-full w-full min-h-[120px] flex-col gap-1', className)}
    >
      <div className="relative min-h-0 w-full flex-1" ref={ref}>
        {/* The field: a wash of the measurement hue, deepening toward the
            corner that is high on both, under a hairline cross. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-[3px]"
          style={{ background: `linear-gradient(215deg, ${wash('purple')}, transparent 60%)` }}
        />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false" className="absolute inset-0 h-full w-full">
          <line x1={50} y1={0} x2={50} y2={100} stroke={VIZ_LINE} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={50} x2={100} y2={50} stroke={VIZ_LINE} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={100} x2={100} y2={100} stroke={VIZ_LINE} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={0} x2={0} y2={100} stroke={VIZ_LINE} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        {/* No corner captions. They sat exactly where the extreme points land
            (a point at 94%/6% IS the top-right corner) and overprinted them;
            the axes named under the field say which way is up and which way
            is right, and the quadrant each point is in is in its title and
            in the screen reader's label. */}
        {usable.map((p, i) => (
          <span
            key={`${p.label}-${i}`}
            title={`${p.label} — ${inQuad(p)}`}
            className="absolute h-[8px] w-[8px] rounded-full"
            style={{ left: `${px(p.x)}%`, top: `${py(p.y)}%`, transform: 'translate(-50%, -50%)', background: mark('purple') }}
            aria-hidden="true"
          />
        ))}
        {/* Names beside the points, as siblings rather than children of the
            mark: a label nested inside the dot inherits the dot as its
            background in every tool that reads the DOM, and the ink is
            measured against the card it is actually drawn on. */}
        {usable.map((p, i) =>
          labelled[i] ? (
            <span
              key={`label-${p.label}-${i}`}
              className="pointer-events-none absolute -translate-y-1/2 whitespace-nowrap text-[length:var(--viz-label,10px)] leading-none"
              style={
                labelled[i] === 'right'
                  ? { left: `calc(${px(p.x)}% + 7px)`, top: `${py(p.y)}%`, color: VIZ_QUIET }
                  : { right: `calc(${100 - px(p.x)}% + 7px)`, top: `${py(p.y)}%`, color: VIZ_QUIET }
              }
              aria-hidden="true"
            >
              {p.label}
            </span>
          ) : null,
        )}
      </div>
      {/* The axes named once, under the field, rather than twice inside it. */}
      <div
        className="flex shrink-0 items-baseline justify-between gap-2 text-[length:var(--viz-label,10px)] leading-[13px]"
        style={{ color: VIZ_QUIET }}
        aria-hidden="true"
      >
        <span className="truncate">↑ {yLabel}</span>
        <span className="truncate">{xLabel} →</span>
      </div>
    </div>
  )
}
