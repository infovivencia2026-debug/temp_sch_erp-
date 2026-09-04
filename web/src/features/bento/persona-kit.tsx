import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { openTab } from '@/lib/tabs'
import { cn } from '@/lib/utils'
import { useWidgetSize } from '@/lib/widget-size'
import { Cell, useBoardHeight, type CellSpan } from './bento-kit'
import { CardShell, CornerMark, Nil } from './bento-cards'
import { WidgetLayer } from './WidgetLayer'

/* THE PERSONA KIT — what the student, parent and faculty boards need that
   `bento-kit.tsx` and `bento-cards.tsx` do not already give them.

   docs/BENTO_CARD_PATTERNS.md is the contract every cell on those three boards
   now keeps: a header, a figure, and a drawing that takes ALL the height left
   over. `CardShell` lays those three rows; the twelve drawings are imported
   from `bento-cards.tsx` by the boards themselves. This file adds only the
   four things that are genuinely not there:

     1. A cell that NAMES WHOSE FIGURE IT HOLDS. The parent board's whole
        correctness argument rests on it; see ParentWeek.tsx. `who` is the
        shell's own `sub` slot, so it is part of the header rather than a
        sentence somebody can forget to write, and it is never dropped by size:
        a cell too small for the name is a cell that must not be drawn.
     2. `Facts` — the drawing for a number that has no denominator. See below.
     3. The layout helpers a drawing row needs when it holds two drawings.
     4. A page header with a description and an action slot, because the parent
        board's child switcher has to sit above every cell it governs.

   WHY `Facts` AND NOT A FIELD OF MARKS. A grid of dots — or of blocks, or a
   segmented rail — was tried three times on these boards and removed three
   times, because nearly every caller had one mark per unit and every mark
   identical. A drawing with no variation in it can only restate the number
   printed above it, and no restyling fixes that. What a bare count actually
   wants beside it is the other real figures around it, which is what this
   draws: label, rule, figure, bottom-aligned like every other drawing here.
   It is not a chart and does not pretend to be one.

   NOTHING HERE NAMES A COLOUR. Every mark and every rule is `currentColor` at
   some strength; the cell resolved its own ink — black on paper, white on the
   inverted ground — before any of this mounted.

   No `backdrop-filter` anywhere: the contract confines blur to transient
   floating panels and a dashboard is not one. */

/** Ink at a given strength. The only colour expression in this file, and it
    names no colour: it is whatever the cell already resolved. */
const ink = (pct: number) => `color-mix(in srgb, currentColor ${pct}%, transparent)`

// --- the room a cell has ----------------------------------------------------

/** The two decisions a drawing actually makes, off the real dimensions.

    NOT `detailFor`, which folds width and height into an area and therefore
    gives 2x1 and 1x2 the same answer — and they are opposite shapes. A wide
    cell buys marks along a row; a tall one buys rows. A cell that branches on
    area draws the same thing in both and one of the two is always wrong. */
export function useShape() {
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  return { w, h, wide, tall, anchor: wide && tall }
}

// --- the page frame ---------------------------------------------------------

/** Eyebrow, title, description, an action slot, and the board grid.

    No entrance animation at all — not a reduced one, none. `.reveal` in
    index.css was deliberately made a no-op for exactly this reason, and these
    are screens three people open forty times a day. */
export function PersonaPage({
  eyebrow,
  title,
  description,
  actions,
  dashboard,
  children,
}: {
  eyebrow: string
  title: string
  description?: string
  actions?: ReactNode
  /** Storage key for the arranger, when this page's cells are <Widget>s.

      It is taken here rather than written around <PersonaPage> at the call
      site because WidgetLayer renders its toolbar as a sibling of its
      children: wrapped around the cells it would land inside the grid and be
      laid out as a card, and wrapped around the whole page it would sit above
      the title. Only this component can put it between the two. */
  dashboard?: string
  children: ReactNode
}) {
  /* Measured like every other board. Without it the height stays indefinite,
     and the stylesheet's three row FRACTIONS collapse to max-content — three
     rows all sized to the tallest one, empty rows included. These boards use
     eight of fifteen slots, so the unused third row was showing up as a blank
     band the height of a card under the faculty, student and parent screens.

     DO NOT REMOVE. */
  const boardRef = useBoardHeight()
  /* The layer goes INSIDE the board, not around it.

     WidgetLayer turns the board it sits in into the phone's sideways pager,
     and it finds that board by looking up from its own marker. Wrapped around
     the grid it found nothing, so the parent, student and faculty homes were
     the only boards on a phone that still stacked and scrolled while every
     other home paged. Its toolbar renders as a sibling of its children, so
     inside the grid it is laid out as a grid child; the stylesheet already
     accounts for that on the boards that were built this way. */
  const grid = (
    <div
      ref={boardRef}
      className="bento-board mt-5 min-h-0 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5"
    >
      {dashboard ? <WidgetLayer dashboard={dashboard}>{children}</WidgetLayer> : children}
    </div>
  )
  /* A FLEX COLUMN THE FULL HEIGHT OF THE GROUND, LIKE BentoPage, AND THAT IS
     WHAT THE PHONE PAGER STANDS ON.

     Moving the layer inside the board made these three homes page on a phone,
     and the pager sizes itself as `flex: 1 1 auto` with three row FRACTIONS.
     This frame was a plain block, so the board's height was indefinite, a
     fraction of it fell back to the content, and every card kept only its
     padding: measured on the parent home at 1080x2340, three tiles 65px tall
     with nothing in them, under a title and above a row of page dots. The
     ground is already `height: 100%` whenever it holds a pager, so the column
     has a definite height to hand down; the header takes its own and the
     board takes the rest.

     Harmless above the phone. At lg the board's height is measured into
     `--board-h`, and between the two the ground is `min-h-full` and scrolls,
     which a surface taller than it does not prevent. */
  return (
    <div className="bento-surface flex h-full w-full flex-col p-3 sm:p-4 text-[var(--bento-ink)]">
      {/* On a phone the header is one small line, because every pixel it
          takes is a pixel off three cards that already share the screen with
          the dock. The name is the reader's own child or self — they know
          it — so it does not need to be the biggest thing on the page.
          Desktop keeps the eyebrow, the title and the sentence under it. */}
      <div className="flex flex-wrap items-end justify-between gap-2 sm:gap-4">
        <div className="min-w-0">
          <p className="hidden text-[11px] font-medium uppercase tracking-[0.06em] opacity-70 sm:block">
            {eyebrow}
          </p>
          <h1 className="truncate text-[15px] font-semibold text-[var(--bento-ink)] sm:mt-1 sm:text-[22px]">
            {title}
          </h1>
          {description && (
            <p className="truncate text-[12px] opacity-70 sm:mt-1 sm:whitespace-normal sm:text-[13px]">
              {description}
            </p>
          )}
        </div>
        {actions}
      </div>
      {grid}
    </div>
  )
}

// --- the cell ---------------------------------------------------------------

/** One cell: the board's ground on the outside, the three-row shell inside.

    `who` is the name of the person the figure is about. On the parent board it
    is mandatory and never omitted — a guardian of two must never read one
    child's figures as the family's, and this repository has shipped that bug
    more than once. On the student and faculty boards the subject is the reader
    themselves and `who` is left off; there is one record and no ambiguity.

    THE WHOLE CARD IS THE LINK, rather than a pill along the bottom edge. The
    contract's cell is three rows and nothing else, and a fourth row for an
    action is exactly the thirty pixels the drawing was short of at 1x1 — so
    the affordance becomes the card itself, which is bigger, costs no height,
    and reaches the same screen. A cell whose feature this account cannot open
    is simply not a link; nothing renders a locked door.

    THE HEIGHT BUDGET. A one-row cell is about 172px. A 38px figure leaves the
    drawing row barely thirty, so on one row the figure is set to 24px through
    `--bento-fig`, the token the shell's figure reads, and the drawing row gets
    the difference. The `who` line is NOT part of that trade.

    `--bento-card` is repointed to a coloured cell's own ground, because
    `Gauge` punches its centre with that token. */
export function PersonaCard({
  span = 'one',
  ground,
  title,
  who,
  glyph,
  value,
  change,
  to,
  cueLabel,
  children,
}: {
  span?: CellSpan
  /** One of the six coloured grounds, for the one metric whose shape is the
      point. One per board: if half of it is coloured, nothing is emphasised.

      A DOMAIN NAME AND NOT THE INVERTED TONE. `Cell`'s `dark` paints
      `--bento-ink` and writes on it in `--bento-bg`, which is a measured pair
      only while the page ground and the ink are opposites. Under the supplied
      default palette they are not — the page is #10110f and the ink is
      #000000 — so an inverted persona cell measured 1.00:1 and was black text
      on a black card. A domain ground carries its own ink token, chosen
      against that ground in both modes, so it cannot come apart the same way. */
  ground?: string
  title: string
  who?: string
  glyph?: ReactNode
  value: ReactNode
  change?: ReactNode
  to?: string
  cueLabel: string
  children?: ReactNode
}) {
  const { tall } = useShape()
  const here = useLocation().pathname
  /* `Gauge` punches its centre with `--bento-card`: left at the plain card
     tone it would draw a pale disc in the middle of a coloured card. */
  const style = ground
    ? ({ ['--bento-card' as string]: `var(--dom-${ground}-soft, var(--dom-${ground}))` } as CSSProperties)
    : undefined
  const body = (
    <CardShell
      className="h-full"
      title={title}
      sub={who}
      glyph={glyph}
      value={value}
      change={change}
    >
      {children}
    </CardShell>
  )
  return (
    <Cell span={span} domain={ground} className={tall ? undefined : '[--bento-fig:24px]'}>
      <div className="flex min-h-0 flex-1 flex-col" style={style}>
        {to ? (
          /* THE MARK THE OTHER BOARDS HAVE.

             Four persona boards — the student's day, the teacher's classes, the
             parent's week and my work — wrapped the whole card in a link and
             drew nothing to say so. The principal's board drew a corner arrow,
             so somebody moving between them saw an affordance on one and none
             on the other for the same act of opening something. The card was
             always clickable; there was simply no way to know.

             A span, not a second Link: a link inside a link is invalid and the
             browser closes the outer one early, which breaks the card. It is
             aria-hidden because the enclosing Link already carries the name. */
          <Link
            to={to}
            aria-label={cueLabel}
            /* Same as Cue in bento-kit: opening a card opens a tab, so a
               person can have fees and attendance side by side instead of one
               replacing the other. Desktop only, because the strip is. */
            onClick={() => openTab(to, cueLabel, here)}
            className="relative block min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-current"
          >
            {body}
            <CornerMark />
          </Link>
        ) : (
          <div className="min-h-0 flex-1">{body}</div>
        )}
      </div>
    </Cell>
  )
}

// --- the drawing this kit adds ----------------------------------------------

export interface Fact {
  label: string
  value: string
}

/** The real figures around a headline that has no denominator.

    Bottom-aligned like `Rows` and `Bars`, so a short list sits on the same
    baseline the other drawings do instead of floating in the middle of the
    row. Each line is a rule, a label and a figure — no bar, because a bar
    across figures in different units is a comparison that does not hold.

    Every entry must be a MEASURED figure. A row whose value is derived from a
    total this response does not carry is the fabricated denominator wearing a
    different hat. */
export function Facts({ items, srLabel }: { items: Fact[]; srLabel: string }) {
  if (!items.length) return null
  return (
    <dl className="flex h-full flex-col justify-end gap-0.5" role="group" aria-label={srLabel}>
      {items.map((f) => (
        <div
          key={f.label}
          className="flex min-w-0 items-baseline justify-between gap-2 border-t pt-[3px]"
          style={{ borderColor: ink(12) }}
        >
          <dt className="truncate text-[length:var(--card-note,8px)] font-medium uppercase tracking-[0.06em] opacity-65">
            {f.label}
          </dt>
          <dd className="shrink-0 text-[length:var(--card-note,10px)] font-bold tabular-nums">{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** As many of these facts as the row can hold without the top one being cut.
    A fact line is about 17px; the caller passes the row's budget in lines. */
export function cut<T>(items: T[], lines: number): T[] {
  return items.slice(0, Math.max(0, lines))
}

// --- laying two drawings in one drawing row ---------------------------------

/** The drawing row, split. `min-h-0`/`min-w-0` on both halves is what keeps a
    child that wants to be `h-full` from pushing the card open. */
export function Split({ row = false, children }: { row?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex h-full min-h-0 min-w-0 gap-2.5', row ? 'flex-row' : 'flex-col')}>
      {children}
    </div>
  )
}

export function Part({ grow = 1, children }: { grow?: number; children: ReactNode }) {
  return (
    <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `${grow} 1 0%` }}>
      {children}
    </div>
  )
}

/** A titled drawing, with the title kept OUT of the drawing's own height. */
export function Titled({ head, children }: { head: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <p className="mb-1 truncate text-[length:var(--card-sub,8px)] font-normal uppercase leading-none tracking-[0.04em] opacity-55">
        {head}
      </p>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

/** A sentence in the drawing row — the state a drawing must not be drawn in.
    "No day has been marked yet" is a fact; an empty chart is not a way of
    saying it, and a chart of zeroes is a lie. */
export function Say({ children }: { children: ReactNode }) {
  /* The sentence AND an empty measure, not the sentence alone.

     Every drawing in bento-cards.tsx returns null when its data carries no
     signal — which is right, because an all-zero series is not a small series
     and drawing one invents activity that did not happen. The cost was that a
     cell at zero became a short line of text floating in a large empty
     rectangle, and "0 pending approvals" filling a 2x2 tile with nothing reads
     as a card that failed to load rather than as a queue that is clear.

     `Nil` says the cell is a
     measure, that the measure is genuinely at nought, and it shows the shape
     the card takes tomorrow when there IS something — which is what makes the
     same card legible then.

     Done here rather than at each call site because the four persona boards
     share this one component: it is roughly forty zero states in one edit. */
  return (
    <div role="note" className="h-full min-h-0">
      <Nil>{children}</Nil>
    </div>
  )
}

// --- the clock --------------------------------------------------------------

/** Minutes since midnight, re-read every half minute.

    Not an animation — nothing moves and nothing transitions — so
    `reduce_motion` does not silence it. A timetable that says a lesson is
    happening an hour after it ended is simply wrong, and the two anchors that
    say "now" are the reason those screens get opened at all. */
export function useNowMinutes(): number {
  const read = () => {
    const d = new Date()
    return d.getHours() * 60 + d.getMinutes()
  }
  const [now, setNow] = useState(read)
  useEffect(() => {
    const id = setInterval(() => setNow(read()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}

/** "08:45" → 525, or null when the office has not filled the bell schedule in.
    Null is not zero: a period with no time on it is neither now nor next,
    rather than being guessed into the present. */
export function hhmm(v?: string | null): number | null {
  if (!v) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(v)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** "08:45" and "09:30" → 45. Null unless BOTH ends are known: a lesson with
    one time on it has no length, and assuming the school's usual period would
    be a number this response never carried. */
export function lengthOf(starts?: string | null, ends?: string | null): number | null {
  const a = hhmm(starts)
  const b = hhmm(ends)
  if (a === null || b === null || b <= a) return null
  return b - a
}

/** Minutes as the school says them: "50m", "1h 40m". */
export function mins(n: number): string {
  if (n < 60) return `${n}m`
  const h = Math.floor(n / 60)
  const m = n % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// --- the register, as a series ----------------------------------------------

/** One marked day, exactly as `/api/v1/portal/attendance` returns it. */
export interface RegisterDay {
  date: string
  status: string
}

/** The statuses that count as the child having been in school. `late` is one
    of them — the register's own summary counts it as present, and a dashboard
    that disagreed with the register would be the wrong one. */
export const IN_SCHOOL = new Set(['present', 'late'])

/** A status as a person says it: `half_day` → "Half day". */
export function statusLabel(s: string): string {
  const flat = s.replace(/_/g, ' ')
  return flat.charAt(0).toUpperCase() + flat.slice(1)
}

/** Local midnight of a yyyy-mm-dd, or NaN. Parsed with an explicit time so it
    is the local calendar day and not the previous evening east of Greenwich —
    a day shifted backwards moves a Monday absence onto a Sunday. */
export function dayMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00`)
}

/** Marked days bucketed into calendar weeks, oldest last-`weeks` first, each
    week's value the share of ITS OWN marked days that the child was in school.

    The denominator is real and per week: the days that week's register
    actually carries. A week with nothing marked is not a nought — it is a week
    the school did not mark, so it is left out rather than drawn as a collapse
    to zero. */
export function weeklyRate(days: RegisterDay[], weeks: number): { pct: number; marked: number }[] {
  const buckets = new Map<number, { hit: number; all: number }>()
  for (const d of days) {
    const ms = dayMs(d.date)
    if (!Number.isFinite(ms)) continue
    const k = Math.floor(ms / 604_800_000)
    const b = buckets.get(k) ?? { hit: 0, all: 0 }
    b.all += 1
    if (IN_SCHOOL.has(d.status)) b.hit += 1
    buckets.set(k, b)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-weeks)
    .map(([, b]) => ({ pct: Math.round((100 * b.hit) / b.all), marked: b.all }))
}

/** Counts by status, biggest first. A real partition of the marked days: the
    parts sum back to the number of days in the register. */
export function byStatus(days: RegisterDay[]): { label: string; value: number }[] {
  const m = new Map<string, number>()
  for (const d of days) m.set(d.status, (m.get(d.status) ?? 0) + 1)
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: statusLabel(k), value: v }))
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Days matching a predicate, spread across the weekdays the register actually
    uses. Only weekdays that appear in the data are drawn — a school that never
    marks a Saturday should not be shown an empty Saturday column, and a school
    that does should not have it hidden. */
export function byWeekday(
  days: RegisterDay[],
  keep: (d: RegisterDay) => boolean,
): { label: string; value: number }[] {
  const seen = new Set<number>()
  const hit = new Map<number, number>()
  for (const d of days) {
    const ms = dayMs(d.date)
    if (!Number.isFinite(ms)) continue
    const wd = new Date(ms).getDay()
    seen.add(wd)
    if (keep(d)) hit.set(wd, (hit.get(wd) ?? 0) + 1)
  }
  return [...seen]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((wd) => ({ label: WEEKDAY[wd], value: hit.get(wd) ?? 0 }))
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Days matching a predicate, by calendar month, oldest first. Months with no
    marked day at all are absent from the axis rather than drawn as nought. */
export function byMonth(
  days: RegisterDay[],
  keep: (d: RegisterDay) => boolean,
  limit: number,
): { label: string; value: number }[] {
  const order: string[] = []
  const hit = new Map<string, number>()
  for (const d of days) {
    const key = d.date.slice(0, 7)
    if (!hit.has(key)) {
      order.push(key)
      hit.set(key, 0)
    }
    if (keep(d)) hit.set(key, (hit.get(key) ?? 0) + 1)
  }
  return order
    .sort()
    .slice(-limit)
    .map((key) => ({ label: MONTH[Number(key.slice(5, 7)) - 1] ?? key, value: hit.get(key) ?? 0 }))
}

/** The run of in-school days ending at the most recent marked day, and the
    longest such run anywhere in the register. Both counted over marked days
    only: a holiday the school never marked does not break a run, because it
    was never a day the child could have missed. */
export function runs(days: RegisterDay[]): { current: number; longest: number } {
  const asc = [...days].sort((a, b) => a.date.localeCompare(b.date))
  let longest = 0
  let run = 0
  for (const d of asc) {
    if (IN_SCHOOL.has(d.status)) {
      run += 1
      longest = Math.max(longest, run)
    } else run = 0
  }
  return { current: run, longest }
}
