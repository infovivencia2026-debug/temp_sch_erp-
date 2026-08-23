import { useId } from 'react'
import { useWidgetSize } from '@/lib/widget-size'
import { cn } from '@/lib/utils'

/* SIX MORE DRAWINGS FOR THE BENTO CELLS.

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
      null, and the cell is simply a cell.

   4. No data draws nothing. An empty array renders null, never a confident
      zero: a ring at 0%, a bar of one flat segment and an empty heat strip all
      look like measurements, and "we have no rows for this" is not a
      measurement. A denominator of zero is the same refusal `Meter` makes.

   5. No animation, at any motion preference. There is nothing to reduce. */

// --- the colour rule ----------------------------------------------------

/* ONE RULE, STATED ONCE, AND NOTHING HERE DEVIATES FROM IT.

   1. EVERY MARK IS AN ACCENT MIXED INTO `currentColor`, NEVER AN ACCENT ON ITS
      OWN. `currentColor` is the ink the cell has already resolved for its own
      ground — `--bento-ink` on a plain card, `--bento-anchor-ink` on the
      gradient, `--bento-bg` on an inverted card, `--dom-*-text` on a
      domain-tinted one — so a mark built on it cannot lose its ground the way
      a fixed colour can. The accent is a HUE CAST over an ink that already
      read, not a replacement for it.

      This also fixes a real failure rather than only adding colour: these six
      used to draw in `var(--bento-ink)` literally, which on an inverted cell
      is the ink ON the ink — invisible — and two shipped dashboards have an
      inverted cell.

      Measured at 55%: the worst pairing across the default light and dark
      themes, the Focus skin in both polarities and all four shipped palettes
      is 3.61:1 (mint on the default light card); every other pairing lands
      between 5:1 and 14:1. 3:1 is the floor for a graphical mark, so 55% is
      where the mix stops.

   2. FOUR ACCENTS, FOUR MEANINGS — the kit's existing rule, kept and extended
      rather than re-invented:

        purple  the measurement itself; the reading you came for, and the
                one you are looking at
        mint    arrived, collected, present, done
        orange  pending, in caution
        pink    outstanding, overdue, at risk, money out

      A primitive that draws one quantity draws it in purple. A primitive
      whose quantity has a valence draws it in the hue of that valence.

   3. WHERE A DRAWING NEEDS A SEQUENCE, IT USES ONE OF TWO RAMPS, DEFINED ONCE.
      `intensity` — deep purple to pink — for "more of the same measure":
      SegmentBar's descending shares, HeatStrip's heavier periods. `risk` —
      mint through orange to pink — for "this is getting worse": AgeBands.
      Both are built from the same 55% mixes, so every stop on either ramp
      carries the same contrast guarantee its endpoints do.

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
/** The inky end of a same-hue gradient. Further toward the cell's ink, so it
    is strictly safer than `mark` and never the weak end of a pairing. */
const deep = (h: Hue) => `color-mix(in srgb, ${ACCENT[h]} 38%, currentColor)`
/** A fill under a line, or a halo around a dot. Decorative only: what it sits
    under or around is what carries the reading. */
const wash = (h: Hue, pct: number) => `color-mix(in srgb, ${mark(h)} ${pct}%, transparent)`

/** A point on a two-stop ramp, `f` in 0..1. */
const ramp2 = (a: string, b: string, f: number) =>
  `color-mix(in srgb, ${b} ${Math.round(Math.min(1, Math.max(0, f)) * 100)}%, ${a})`

/** "More of the same measure": deep purple through to pink. */
const intensity = (f: number) => ramp2(deep('purple'), mark('pink'), f)
/** "This is getting worse": mint, through orange, to pink. */
const risk = (f: number) =>
  f <= 0.5 ? ramp2(mark('mint'), mark('orange'), f * 2) : ramp2(mark('orange'), mark('pink'), (f - 0.5) * 2)

/* The neutrals. Also `currentColor` rather than `--bento-muted`, for the same
   reason: a track and a hairline have to sit on whatever ground the cell
   turned out to have. */
const VIZ_LINE = 'color-mix(in srgb, currentColor 24%, transparent)'
const VIZ_TRACK = 'color-mix(in srgb, currentColor 11%, transparent)'

/** QUIET TEXT: the endpoint keys, the band labels, the dates under an axis.

    `--bento-muted` alone is not safe here. It is a grey measured against a
    LIGHT card, and on the inverted cell two dashboards ship it measures
    3.55:1 — under the 4.5:1 a label has to clear. Pulled 30% toward
    `currentColor` it clears 4.45:1 at worst across the default light and dark
    themes, the Focus skin in both polarities, all four shipped palettes, the
    anchor gradient and the inverted cell, while staying visibly quieter than
    the figure beside it.

    On a domain-tinted card this resolves to the card's own ink exactly, since
    `Cell` has already repointed `--bento-muted` there — which is what that
    branch was written to achieve, and this does not undo it. */
const VIZ_QUIET = 'color-mix(in srgb, var(--bento-muted) 70%, currentColor)'

/** Does this cell have room for a drawing that needs `minW` columns and
    `minH` rows? Below it the caller returns null. Deliberately duplicated from
    the kit's `useArtRoom` rather than exported across files: it is four lines,
    and the kit is not this file's dependency. */
function useRoom(minW: number, minH = 1): boolean {
  const { w, h } = useWidgetSize()
  return w >= minW && h >= minH
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

    `preserveAspectRatio` is left at its default here, alone among these six —
    a circle stretched to a 264x172 cell is an ellipse, and an ellipse's arc
    length no longer tracks its angle, so the drawing would misreport the
    number it exists to report.

    Fits 1x1: it is the most compact of the six, and the small cell is the one
    it is for. */
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
  /* Before the early return: a hook cannot be called conditionally, and this
     one only exists to keep two rings on one board from sharing a gradient id
     — which would silently give the second one the first one's geometry. */
  const gid = useId()
  if (total <= 0) return null

  const v = Math.min(Math.max(value, 0), total)
  const frac = v / total
  /* 38 rather than 48: `vectorEffect="non-scaling-stroke"` keeps the stroke at
     9 screen pixels however the viewBox is scaled, so at a small cell those
     pixels are a large share of the box and a ring drawn out to the edge has
     its top and bottom cut off by the card. Measured at 264x172 before the
     inset was widened. */
  const r = 35
  const circumference = 2 * Math.PI * r
  const drawn = circumference * frac
  /* At 100% the dash pattern's two round caps meet at twelve o'clock and
     overlap into a visible notch — the one place a completed ring looks
     broken. A full ring is drawn as a plain circle with no dash at all. */
  const complete = frac >= 1

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${v} of ${total}, ${pctText(v, total)}`}
      className={cn('flex h-full w-full items-center justify-center', className)}
    >
      {/* Square, and capped.

          Given a 2x2 the ring would otherwise inflate to 316px across while
          the figure inside it stayed 15px — a hoop with a speck in the middle,
          where the drawing has grown but the thing it is drawn around has not.
          A dial is legible at about the size of a coin and gains nothing past
          it, so the box stops and centres. */}
      <div className="relative aspect-square h-full max-h-[132px] min-h-[64px]">
        <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" className="h-full w-full">
          <defs>
            {/* THE ARC'S GRADIENT, ALONG ITS LENGTH — the `intensity` ramp,
                the same one SegmentBar and HeatStrip run on, because an arc is
                the same claim they make: more of one measure.

                It was purple-to-mint for one pass, on the reasoning that the
                far end of a ring is the thing being finished. It came out
                muddy and was backed out: purple and mint sit on opposite sides
                of the wheel, so every intermediate stop is a desaturated
                grey-green and the middle of the arc looked like the old
                monochrome drawing with the ends painted on. Purple to pink are
                neighbours and the ramp between them stays saturated the whole
                way round.

                `userSpaceOnUse` so the ramp is laid across the ring's own box
                rather than the stroke's bounding box, which for a short arc
                would compress the whole ramp into the first few degrees. */}
            <linearGradient id={`${gid}-arc`} gradientUnits="userSpaceOnUse" x1={10} y1={2} x2={90} y2={98}>
              <stop offset="0%" stopColor={intensity(0)} />
              <stop offset="50%" stopColor={intensity(0.5)} />
              <stop offset="100%" stopColor={intensity(1)} />
            </linearGradient>
          </defs>
          {/* The whole. */}
          <circle
            cx={50}
            cy={50}
            r={r}
            fill="none"
            stroke={VIZ_TRACK}
            strokeWidth={11}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* The part. Started at twelve o'clock and drawn clockwise, because
              that is the direction every dial a reader has ever met turns.

              Drawn twice: a wide, faint pass that seats the arc against the
              track the way a shadow seats an object, and the arc itself over
              it. The halo is `wash`, which is the arc's own hue at a fraction
              of its alpha, so the depth cue cannot be a colour the palette
              does not know about. */}
          <circle
            cx={50}
            cy={50}
            r={r}
            fill="none"
            stroke={wash('purple', 20)}
            strokeWidth={15}
            strokeLinecap="round"
            strokeDasharray={complete ? undefined : `${drawn} ${circumference}`}
            transform="rotate(-90 50 50)"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={50}
            cy={50}
            r={r}
            fill="none"
            stroke={`url(#${gid}-arc)`}
            strokeWidth={11}
            strokeLinecap={complete ? 'butt' : 'round'}
            strokeLinejoin="round"
            strokeDasharray={complete ? undefined : `${drawn} ${circumference}`}
            transform="rotate(-90 50 50)"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* HTML rather than <text>, so the type keeps the card's own font
            stack and its own size instead of being scaled by the viewBox. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-[17px] font-bold leading-none tabular-nums"
            style={{ color: 'currentColor' }}
          >
            {pctText(v, total)}
          </span>
          <span
            className="mt-1 text-[10.5px] leading-none tabular-nums"
            style={{ color: VIZ_QUIET }}
          >
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

    Segments are separated by the card's own ground rather than by a border, so
    the divisions read at any width. Shade descends across the segments in
    order, which is a ranking cue and not the meaning: every segment also
    prints its own share in the legend, so a reader who cannot tell two greys
    apart still has both numbers.

    Zero-valued segments are dropped from the bar — a zero-width slice is a
    rendering fault with a tooltip — but stay in the legend at 0, because "none
    of this category" is a finding.

    Fits 1x1; the legend goes one-per-line below two columns and wraps inline
    above. */
export function SegmentBar({
  segments,
  srLabel,
  formatValue,
  className,
}: {
  segments: { label: string; value: number }[]
  srLabel: string
  /** How a segment's value is written, in the legend, the title and the label
      the screen reader gets. Defaults to the bare number, which is what every
      existing caller already gets — the prop exists because a count and an
      amount of money are not the same thing, and a bare paise integer read as
      rupees is wrong by a factor of a hundred. */
  formatValue?: (v: number) => string
  className?: string
}) {
  const { w } = useWidgetSize()
  const usable = segments.filter((s) => Number.isFinite(s.value) && s.value >= 0)
  const total = usable.reduce((a, s) => a + s.value, 0)
  if (usable.length === 0 || total <= 0) return null

  const drawn = usable.filter((s) => s.value > 0)
  const wide = w >= 2
  const fmt = formatValue ?? ((v: number) => String(v))
  /* Position on the intensity ramp. The bar is ONE ramp and each segment is a
     window onto it, so the hue a segment gets is decided by where it sits in
     the ranking and by nothing else — no per-category colour to assign, and
     no chance of two dashboards giving the same category two hues. The ramp is
     the ranking cue the descending shade used to be; the legend still prints
     every share, so a reader who cannot separate two stops has both numbers. */
  const at = (i: number) => (usable.length <= 1 ? 0 : Math.min(i, 5) / Math.min(usable.length - 1, 5))

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${usable
        .map((s) => `${s.label} ${fmt(s.value)}, ${pctText(s.value, total)}`)
        .join('; ')}. Total ${fmt(total)}.`}
      className={cn('flex w-full flex-col gap-2.5', className)}
    >
      {/* 14px rather than 10, and every segment fully rounded rather than the
          strip being rounded once and the divisions being butt joins. At a
          hairline's weight this read as a rule under the card; with a body and
          round ends each share reads as an object, which is what it is. */}
      <div className="flex h-[14px] w-full items-stretch" style={{ gap: '3px' }}>
        {drawn.map((s, i) => (
          <div
            key={`${s.label}-${i}`}
            title={`${s.label}: ${fmt(s.value)} (${pctText(s.value, total)})`}
            className="rounded-full"
            style={{
              width: `${(s.value / total) * 100}%`,
              minWidth: '6px',
              background: `linear-gradient(90deg, ${intensity(at(usable.indexOf(s)))}, ${intensity(
                Math.min(1, at(usable.indexOf(s)) + 0.14),
              )})`,
              /* Seated, not floating. An inset line of the segment's own hue
                 along the bottom edge is what makes a flat rectangle read as a
                 solid object; it is drawn from the same `wash` the rest of the
                 file uses, so there is no colour here a palette cannot move. */
              boxShadow: `inset 0 -1.5px 0 ${wash('purple', 26)}`,
            }}
          />
        ))}
      </div>
      <ul
        className={cn(
          'm-0 list-none p-0 text-[11px] leading-tight tabular-nums',
          wide ? 'flex flex-wrap gap-x-3 gap-y-1' : 'flex flex-col gap-1',
        )}
        aria-hidden="true"
      >
        {usable.map((s, i) => (
          <li key={`${s.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: intensity(at(i)) }}
            />
            <span className="truncate" style={{ color: VIZ_QUIET }}>
              {s.label}
            </span>
            <span className="ml-auto shrink-0 font-semibold">{fmt(s.value)}</span>
          </li>
        ))}
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

    Bands past the first are drawn progressively stronger, so the oldest debt
    is the darkest mark on the card. That is the one place shade carries
    meaning here, and it is redundant with both the order and the printed
    count.

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
  /** How a band's count is written, beside the rail and in the label the
      screen reader gets. Defaults to the bare number. Ageing buckets are as
      often money as they are counts, and money in paise printed raw is wrong
      by a factor of a hundred. */
  formatValue?: (v: number) => string
  className?: string
}) {
  const { w } = useWidgetSize()
  const usable = bands.filter((b) => Number.isFinite(b.value) && b.value >= 0)
  const max = usable.reduce((a, b) => Math.max(a, b.value), 0)
  if (usable.length === 0 || max <= 0) return null

  const wide = w >= 2
  const fmt = formatValue ?? ((v: number) => String(v))
  /* The risk ramp, by position rather than by value: the buckets are already
     in worsening order, so the hue restates the order the reader is reading
     down. It is the third channel on the same fact — after the position and
     the printed count — and not one of them on its own. */
  const at = (i: number) => (usable.length <= 1 ? 0 : Math.min(i, 4) / Math.min(usable.length - 1, 4))

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${usable.map((b) => `${b.label}, ${fmt(b.value)}`).join('; ')}.`}
      className={cn('flex w-full flex-col gap-2', className)}
    >
      {usable.map((b, i) => (
        <div key={`${b.label}-${i}`} className="flex items-center gap-2">
          <span
            className={cn(
              'shrink-0 text-[10.5px] leading-none tabular-nums',
              wide ? 'w-14' : 'w-11',
            )}
            style={{ color: VIZ_QUIET }}
          >
            {b.label}
          </span>
          <div
            className="h-[10px] min-w-0 flex-1 overflow-hidden rounded-full"
            style={{ background: VIZ_TRACK }}
          >
            <div
              className="h-full rounded-full"
              style={{
                // A floor, so a band with one item in it is a visible mark and
                // not an empty rail indistinguishable from a zero. 4% rather
                // than 3 because a fully rounded cap needs its own diameter of
                // length before it reads as a bar and not as a dot.
                width: b.value === 0 ? '0%' : `${Math.max(4, (b.value / max) * 100)}%`,
                background: `linear-gradient(90deg, ${ramp2(
                  risk(at(i)),
                  'transparent',
                  0.28,
                )}, ${risk(at(i))})`,
                boxShadow: `inset 0 -1.5px 0 ${wash('pink', 22)}`,
              }}
            />
          </div>
          <span
            className={cn(
              'shrink-0 text-right text-[11px] font-semibold leading-none tabular-nums',
              wide ? 'w-14' : 'w-9',
            )}
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

    Shade is a weak channel and is not asked to work alone: every cell carries
    its value in `title`, the whole series is stated in the label the screen
    reader gets, and the observed low and high are printed as endpoints under
    the strip so a shade can be converted back into a number.

    A null cell is an OUTLINE, not a pale fill. "No data for this period" and
    "a low value this period" are different facts, and a ramp that renders them
    both as light grey merges them — which is the same distinction
    `CalendarDensityArt` draws, drawn the same way.

    A flat series — every observed value identical — is drawn at one uniform
    weight rather than at the ramp's floor, because within-range shading of a
    range of zero is meaningless and a strip that reads as "all lowest" would
    be false.

    Needs 2x1. Thirty cells across a 1x1 are five pixels wide with a gap, which
    is a bar code. */
export function HeatStrip({
  cells,
  srLabel,
  formatValue,
  className,
}: {
  cells: (number | null)[]
  srLabel: string
  /** How a cell's value is spoken and titled. Defaults to the bare number. */
  formatValue?: (v: number) => string
  className?: string
}) {
  const room = useRoom(2)
  const present = cells.filter((c): c is number => c !== null && Number.isFinite(c))
  if (!room || cells.length === 0 || present.length === 0) return null

  const fmt = formatValue ?? ((v: number) => String(v))
  const lo = Math.min(...present)
  const hi = Math.max(...present)
  const range = hi - lo
  const flat = range === 0

  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      <div
        role="img"
        aria-label={`${srLabel}: ${cells
          .map((c) => (c === null ? 'no data' : fmt(c)))
          .join(', ')}.`}
        className="flex h-7 w-full items-stretch gap-[3px]"
      >
        {cells.map((c, i) =>
          c === null || !Number.isFinite(c) ? (
            <div
              key={i}
              title="No data"
              className="min-w-0 flex-1 rounded-[3px]"
              style={{ border: `1.5px solid ${VIZ_LINE}` }}
            />
          ) : (
            <div
              key={i}
              title={fmt(c)}
              className="min-w-0 flex-1 rounded-[3px]"
              style={{
                /* The intensity ramp, end to end. Every stop on it is a 55%
                   mix, so the COOLEST observed cell is as legible against the
                   card as the hottest — which the old alpha ramp was not: its
                   floor was 22% of the ink, and a cell nobody can see is
                   indistinguishable from the outlined cell that means "we have
                   no data for this period". Value now moves the hue, not the
                   opacity, and the two states stay different facts.

                   A flat series sits at the middle of the ramp rather than at
                   its floor, for the reason the doc comment above gives. */
                /* Two channels, not one. The hue ramp alone came out reading
                   as a row of different colours rather than as a row of
                   different WEIGHTS — the whole point of a heat strip — so the
                   alpha rises with the value as well, from 78% to solid. 78%
                   is the floor rather than the old 22%: at 78% the coolest
                   observed cell still measures 3.40:1 against the light card,
                   and below that it fades into the outlined cell that means
                   "no data", which is a different fact. */
                background: `color-mix(in srgb, ${
                  flat ? intensity(0.5) : intensity((c - lo) / range)
                } ${flat ? 100 : Math.round(78 + ((c - lo) / range) * 22)}%, transparent)`,
                boxShadow: `inset 0 -1.5px 0 ${wash('purple', 22)}`,
              }}
            />
          ),
        )}
      </div>
      {/* The key back to numbers. Without it the strip is colour-only. */}
      <div
        className="flex items-baseline justify-between text-[10px] leading-none tabular-nums"
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
    counted in the label rather than dropped silently.

    Labels are printed only when there is room for all of them without
    collision — a partly labelled timeline reads as though the unlabelled marks
    are a lesser kind of event. Otherwise every mark keeps its `title` and the
    whole series is stated for a screen reader.

    Needs 2x1. A month compressed into 264px puts consecutive days two pixels
    apart. */
export function Timeline({
  events,
  from,
  to,
  srLabel,
  className,
}: {
  events: { label: string; date: string | number | Date }[]
  /** The start of the window drawn. Inclusive. */
  from: string | number | Date
  /** The end of the window drawn. Inclusive. */
  to: string | number | Date
  srLabel: string
  className?: string
}) {
  const { w, h } = useWidgetSize()
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
    // Occupied lanes whose last mark is within a mark's width of this one.
    let lane = 0
    while (lane < tiers && lanes[lane] !== undefined && x - lanes[lane] < 4) lane++
    const seated = lane < tiers
    if (seated) lanes[lane] = x
    return { ...e, x, lane: seated ? lane : -1 }
  })

  const hidden = marks.filter((m) => m.lane < 0).length
  const seatedMarks = marks.filter((m) => m.lane >= 0)
  // Labels only when they all fit: roughly 68px of type per label against the
  // cell's own width, which is 264px per column less the card's padding.
  const labelled = w >= 3 && seatedMarks.length <= (w - 1) * 2 && hidden === 0
  const laneStep = h >= 2 ? 14 : 11
  const stackHeight = laneStep * tiers

  const dateText = (t: number) =>
    new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

  return (
    <div
      role="img"
      aria-label={`${srLabel}, ${dateText(t0)} to ${dateText(t1)}: ${placed
        .map((e) => `${e.label} on ${dateText(e.t)}`)
        .join('; ')}.`}
      className={cn('flex w-full flex-col gap-1', className)}
    >
      <div className="relative w-full" style={{ height: `${stackHeight + 10}px` }}>
        {/* The axis. The one piece of pure geometry here, so the one place
            `preserveAspectRatio="none"` belongs. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-[3px] w-full rounded-full"
          style={{
            /* The axis is time, and time runs left to right, so the rail runs
               with it: the ramp deepens toward the far end rather than sitting
               at one flat weight. It is geometry, not a series, so it takes
               the neutral pair rather than an accent. */
            background: `linear-gradient(90deg, ${VIZ_TRACK}, ${VIZ_LINE})`,
          }}
        />
        {seatedMarks.map((m, i) => (
          <div
            key={`${m.label}-${i}`}
            title={`${m.label} — ${dateText(m.t)}`}
            className="absolute"
            style={{
              left: `${m.x}%`,
              bottom: `${m.lane * laneStep}px`,
              transform: 'translateX(-50%)',
            }}
          >
            {/* A stem down to the axis, so a dodged mark still reads as
                belonging to its own point in time rather than floating. */}
            <span
              className="absolute left-1/2 w-[1.5px] -translate-x-1/2 rounded-full"
              style={{
                bottom: `-${m.lane * laneStep}px`,
                height: `${m.lane * laneStep + 5}px`,
                background: `linear-gradient(180deg, ${wash('purple', 55)}, ${VIZ_TRACK})`,
              }}
              aria-hidden="true"
            />
            {/* An event is a single reading on the axis, so it takes purple,
                the measurement hue — and a round mark rather than a wireframe
                diamond, with a halo of its own hue so two marks a lane apart
                still separate where they nearly touch. */}
            <span
              className="relative block h-[9px] w-[9px] rounded-full"
              style={{
                background: `linear-gradient(160deg, ${mark('purple')}, ${deep('purple')})`,
                boxShadow: `0 0 0 3px ${wash('purple', 16)}`,
              }}
              aria-hidden="true"
            />
          </div>
        ))}
        {labelled &&
          seatedMarks.map((m, i) => (
            <span
              key={`label-${m.label}-${i}`}
              className="absolute whitespace-nowrap text-[10px] leading-none"
              style={{
                left: `${m.x}%`,
                bottom: `${m.lane * laneStep + 10}px`,
                transform: 'translateX(-50%)',
                color: VIZ_QUIET,
              }}
              aria-hidden="true"
            >
              {m.label}
            </span>
          ))}
      </div>
      <div
        className="flex items-baseline justify-between text-[10px] leading-none tabular-nums"
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

/** The region names. Quiet, and TEXT — so the quiet-text mix above rather than
    a fraction of `currentColor`: it has to clear 4.5:1, not 3:1. */
const VIZ_LINE_TEXT = VIZ_QUIET

/** Where each region's name goes and what it says. A table rather than four
    copies of the same span, so a wording change happens once. */
const REGIONS = [
  { at: 'left-1.5 top-1.5', text: (x: string, y: string) => `high ${y} \u00b7 low ${x}` },
  { at: 'right-1.5 top-1.5 text-right', text: (_x: string, _y: string) => 'high both' },
  { at: 'bottom-1.5 left-1.5', text: (_x: string, _y: string) => 'low both' },
  { at: 'bottom-1.5 right-1.5 text-right', text: (x: string, y: string) => `high ${x} \u00b7 low ${y}` },
] as const

/** TWO MEASURES AT ONCE, AS A FIELD. Because the finding is a *combination* —
    high absence and low marks is a different student from high absence alone —
    and no arrangement of bars puts a reader in front of that.

    The four regions are labelled, faintly, in the corners. They are the axes
    restated, not a fifth data series: the dividing lines sit at the midpoint
    of each observed range, so "top right" means "high on both, relative to
    these points", which is what the reader will read into it anyway. That is
    stated in the screen-reader label rather than left implied.

    Points are square marks at one weight. Density is the finding, and a ramp
    over a scatter reads as a third variable nobody supplied.

    A single point draws nothing: one mark cannot establish the ranges the
    dividing lines are drawn from, so the quadrants it appears to sit in are an
    artefact of having one point.

    Needs 2x2. At 2x1 the vertical axis is 172px less two rows of labels, and
    every point lands in a 60px band. */
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
  const room = useRoom(2, 2)
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  if (!room || usable.length < 2) return null

  const xs = usable.map((p) => p.x)
  const ys = usable.map((p) => p.y)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  // A degenerate axis — every point on the same x — is drawn as a single
  // column down the middle rather than divided by zero into the corner.
  const xr = x1 - x0
  const yr = y1 - y0
  const px = (v: number) => (xr === 0 ? 50 : 6 + ((v - x0) / xr) * 88)
  const py = (v: number) => (yr === 0 ? 50 : 94 - ((v - y0) / yr) * 88)

  const inQuad = (p: { x: number; y: number }) =>
    `${p.y >= (y0 + y1) / 2 ? 'high' : 'low'} ${yLabel}, ${
      p.x >= (x0 + x1) / 2 ? 'high' : 'low'
    } ${xLabel}`

  return (
    <div
      role="img"
      aria-label={`${srLabel}. Horizontal axis ${xLabel}, vertical axis ${yLabel}, each divided at the midpoint of the observed range. ${usable
        .map((p) => `${p.label}: ${inQuad(p)}`)
        .join('; ')}.`}
      className={cn('flex h-full w-full min-h-[132px] flex-col gap-1', className)}
    >
      <div className="relative min-h-0 w-full flex-1">
        {/* The cross and the frame. Geometry only, so stretched to the cell
            with non-scaling strokes. */}
        {/* The frame is a rounded box drawn in CSS rather than a `<rect>`: the
            field is stretched to the cell, so an `rx` in a `preserveAspectRatio
            ="none"` viewBox would come out as a squashed ellipse at one size
            and a circle at another. A border-radius does not stretch.

            It also carries the faintest possible wash — the measurement hue at
            a twentieth of its alpha, deepening toward the top right — so the
            field reads as a surface the points sit ON rather than as four
            lines drawn on the card. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-[var(--bento-radius)]"
          style={{
            border: `1px solid ${VIZ_LINE}`,
            background: `linear-gradient(215deg, ${wash('purple', 7)}, transparent 62%)`,
          }}
        />
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          className="absolute inset-0 h-full w-full"
        >
          <line
            x1={50}
            y1={4}
            x2={50}
            y2={96}
            stroke={VIZ_LINE}
            strokeWidth={1}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={4}
            y1={50}
            x2={96}
            y2={50}
            stroke={VIZ_LINE}
            strokeWidth={1}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* The four regions, named in their own corners. Named as the
            COMBINATION rather than as "Q1..Q4", because the combination is the
            finding and a reader should not have to decode a key to reach it. */}
        {REGIONS.map((r) => (
          <span
            key={r.at}
            className={cn(
              'pointer-events-none absolute max-w-[46%] truncate text-[9.5px] leading-none',
              r.at,
            )}
            style={{ color: VIZ_LINE_TEXT }}
            aria-hidden="true"
          >
            {r.text(xLabel, yLabel)}
          </span>
        ))}
        {usable.map((p, i) => (
          <span
            key={`${p.label}-${i}`}
            title={`${p.label} — ${inQuad(p)}`}
            className="absolute h-[7px] w-[7px] rounded-full"
            style={{
              left: `${px(p.x)}%`,
              top: `${py(p.y)}%`,
              transform: 'translate(-50%, -50%)',
              /* One hue for every point, deliberately. Density is the finding;
                 colouring by quadrant would be a claim about which corner is
                 the bad one, and only the caller knows that. Purple, because a
                 point here is a reading and nothing more.

                 The halo is what makes a scatter readable at this size: it
                 gives each point a soft edge against its neighbours without
                 needing a ring in the card's own colour, which on a
                 domain-tinted or inverted cell there is no way to name. */
              background: `radial-gradient(circle at 32% 30%, ${mark('purple')}, ${deep('purple')})`,
              boxShadow: `0 0 0 3px ${wash('purple', 15)}`,
            }}
            aria-hidden="true"
          />
        ))}
      </div>
      {/* The axes named once, under the field, rather than twice inside it. */}
      <div
        className="flex shrink-0 items-baseline justify-between gap-2 text-[10px] leading-[13px]"
        style={{ color: VIZ_QUIET }}
        aria-hidden="true"
      >
        <span className="truncate">↑ {yLabel}</span>
        <span className="truncate">{xLabel} →</span>
      </div>
    </div>
  )
}
