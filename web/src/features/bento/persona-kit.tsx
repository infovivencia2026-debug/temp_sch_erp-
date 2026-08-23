import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Cell, Cue, useBoardHeight, type CellSpan } from './bento-kit'
import { WidgetLayer } from './WidgetLayer'

/* THE PERSONA CELLS — the small amount the student, parent and faculty
   dashboards need that `bento-kit.tsx` does not already give them.

   Deliberately small, and deliberately not a second kit. Everything that was
   already there — `Cell`, `Cue`, `Meter`, `BentoError`, `BentoLoading`,
   `useReduceMotion`, `useFeatureHref` — is imported from `bento-kit.tsx` and
   used as it stands. Three things are not there and are genuinely needed by
   these three screens and not by the money dashboards:

     1. A cell that NAMES WHOSE FIGURE IT HOLDS. The parent dashboard's whole
        correctness argument rests on this; see ParentWeek.tsx. It is a prop on
        a cell rather than a convention repeated in three files, so it cannot
        be forgotten in the fourth.
     2. A page header that carries a description and an action slot, because
        the parent dashboard's child switcher has to sit in the header — above
        every cell it governs — and `BentoPage` renders the grid itself.
     3. A run of squares and a clock, for the two anchors that are about time.

   When the two kits are reconciled at merge, 1 and 3 belong in
   `bento-kit.tsx` and this file should keep nothing.

   No `backdrop-filter` anywhere: the contract confines blur to transient
   floating panels and a dashboard is not one. */

// --- the page frame ---------------------------------------------------------

/** Eyebrow, title, description, an action slot, and the 4-column grid.

    20px gaps, generous padding, four columns above `lg`, two on a tablet, one
    on a phone. A 1x1 cell is one figure, so it survives the reflow without
    ever becoming something you scroll.

    No entrance animation at all — not a reduced one, none. `.reveal` in
    index.css was deliberately made a no-op for exactly this reason, and these
    are screens three people open forty times a day. There is therefore nothing
    here for `reduce_motion` to have to cancel. */
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
     band the height of a card under the faculty, student and parent screens. */
  const boardRef = useBoardHeight()
  const grid = (
    <div
      ref={boardRef}
      className="bento-board mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5"
    >
      {children}
    </div>
  )
  return (
    <div className="bento-surface p-6 sm:p-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {eyebrow}
          </p>
          <h1 className="mt-1 truncate text-[22px] font-semibold">{title}</h1>
          {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {dashboard ? <WidgetLayer dashboard={dashboard}>{grid}</WidgetLayer> : grid}
    </div>
  )
}

// --- a cell that says whose figure it is ------------------------------------

/** One cell, with a subject.

    `who` is the name of the person the figure is about, rendered under the
    label on every cell that has one. On the parent dashboard it is mandatory
    and never omitted: a guardian of two must never read one child's figures as
    the family's, and this repository has shipped that bug more than once.

    On the student and faculty dashboards the subject is the reader themselves
    and `who` is left off — there is one record and no ambiguity to resolve. */
export function WhoCell({
  label,
  who,
  span = 'one',
  dark = false,
  to,
  cue,
  children,
}: {
  label: string
  who?: string
  span?: CellSpan
  /** Dark ground for the one metric whose shape is the point. One per
      dashboard: if half of it is dark, nothing is emphasised. */
  dark?: boolean
  to?: string
  cue?: string
  children: ReactNode
}) {
  return (
    <Cell span={span} dark={dark}>
      <p className={cn('text-[12.5px]', dark ? 'text-background/85' : 'text-muted-foreground')}>
        {label}
      </p>
      {who && (
        <p
          className={cn(
            'mt-0.5 truncate text-[12.5px] font-medium',
            dark ? 'text-background' : 'text-secondary-foreground',
          )}
          title={who}
        >
          {who}
        </p>
      )}
      <div className="mt-3">{children}</div>
      {to && cue && <Cue to={to} label={cue} dark={dark} />}
    </Cell>
  )
}

/** The figure. One number, sized by whether this is the anchor. */
export function Figure({
  value,
  span = 'one',
  note,
  dark = false,
}: {
  value: string | number
  span?: CellSpan
  note?: string
  dark?: boolean
}) {
  return (
    <>
      <p
        className={cn(
          'font-semibold leading-none tabular-nums',
          span === 'anchor' ? 'text-[40px]' : 'text-[28px]',
        )}
      >
        {value}
      </p>
      {note && (
        <p
          className={cn('mt-2 text-[12.5px]', dark ? 'text-background/85' : 'text-muted-foreground')}
        >
          {note}
        </p>
      )}
    </>
  )
}

// --- the shape --------------------------------------------------------------

export interface Dot {
  key: string
  /** A token class — `bg-success`, `bg-muted`. Never a raw hex: the semantic
      tokens were each darkened this month to clear 4.5:1 and a literal undoes
      that. Only ever used on a light cell, which is the ground they were
      measured against. */
  className: string
  /** The whole meaning of the square, in words, because colour must not be the
      only thing carrying it. */
  title: string
}

/** A run of squares — a day of periods, a fortnight of attendance. A pattern is
    what a reader is looking for here and a pattern needs the calendar around
    it. Bounded by the caller to a couple of dozen, so it never needs to
    scroll: a cell that scrolls is the wrong cell. */
export function DotStrip({ dots, srLabel }: { dots: Dot[]; srLabel: string }) {
  return (
    <div role="img" aria-label={srLabel} className="mt-3 flex flex-wrap gap-1.5">
      {dots.map((d) => (
        <span key={d.key} title={d.title} className={cn('h-4 w-4 rounded-sm', d.className)} />
      ))}
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
