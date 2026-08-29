import {
  Children, cloneElement, Fragment, isValidElement, useEffect, useRef, useState,
  type ReactElement, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  CalendarRange, Check, ChevronDown, ChevronRight, ChevronUp, Clock, Download, Eye, EyeOff,
  Maximize2, Printer, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'

/* Primitives in the "pulse" language: hairline borders, no shadows, mint used
   as an accent and near-black ink for solid actions. */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('card', className)}>{children}</div>
}

export function CardHeader({
  title,
  description: _cardDescription,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4">
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h3>
        {/* Card descriptions are no longer drawn either.

            Same reasoning as the page description above: a sentence explaining
            what a card is — "How long the money has been owed. Every unpaid
            invoice, including arrears carried in from earlier years…" — is read
            once and skipped forever, and it sits between the card's title and
            the numbers somebody opened the card to see.

            The prop is kept so no screen breaks and so the sentence can be
            moved somewhere it is wanted. Where a caveat genuinely changes how a
            figure should be read, it belongs next to that figure, not in a
            paragraph above the whole card. */}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  )
}

/**
 * The page header: where you are, what this is, what you can do.
 *
 * It used to open with a 34px display title and a large eyebrow, which is a
 * magazine masthead — fine for a landing page, wrong for the seventh screen
 * someone opens before lunch. 24px semibold with a breadcrumb above it says
 * the same thing in a third of the vertical space, and the space goes to the
 * data instead.
 */
export function PageHead({
  eyebrow,
  title,
  description: _unusedDescription,
  actions,
  width = 'operational',
}: {
  /** The section this screen sits under — rendered as a breadcrumb. */
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
  /** Must match the PageBody beneath it, or the two edges disagree. */
  width?: Width
}) {
  return (
    /* No bottom border. The rule under a page title is the most-repeated line
       in the product and it separates a heading from its own content -- the
       28px of space below does the same job without drawing anything. */
    <div className={cn('px-5 pb-6 pt-5 sm:px-7', WIDTH[width])}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 max-w-3xl">
          {/* The breadcrumb must not break mid-word.

              Squeezed by the actions beside it, "Examinations / Marks entry"
              rendered as "Examination" / "s" on two lines — a word cut in half
              is not a word, and this is the line that tells somebody where
              they are. It wraps between its parts or not at all. */}
          {eyebrow && (
            <nav className="mb-1 flex flex-wrap items-center gap-1 text-[12.5px] text-muted-foreground">
              <span className="whitespace-nowrap">{eyebrow}</span>
              <span aria-hidden className="text-muted-foreground/50">/</span>
              {/* Now the only visible name for the screen, so it carries the
                  weight the h1 used to. Still on the breadcrumb's line — the
                  point is one label, not a smaller version of two. */}
              <span className="text-[15px] font-semibold text-foreground">{title}</span>
            </nav>
          )}
          {/* The breadcrumb already ends in the screen's name, so the 26px
              heading underneath it said the same words twice — "Academics /
              Lesson plans" followed by "Lesson plans". Two sizes of the same
              label is not emphasis, it is repetition, and it pushed the actual
              content further down every screen in the product.

              The heading is kept for assistive technology and for document
              structure: a page with no h1 is worse than a page with a
              duplicated one. It is the VISIBLE duplicate that goes.

              Where there is no eyebrow nothing else names the screen, so the
              heading stays as it was. */}
          {eyebrow ? (
            <h1 className="sr-only">{title}</h1>
          ) : (
            <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
          )}
          {/* The description is no longer drawn.

              It was a paragraph of explanation under every page title — "The
              whole school's week. Making one only suggests it…" — read once by
              somebody learning the product and skipped forever after by the
              people who use it daily. It cost two lines at the top of every
              screen, which is the space the actual work needed.

              The prop is kept in the signature so no screen breaks, and so the
              text is still there to move somewhere it earns its place: a hint
              on an empty state, or beside the control it is about. */}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

/* Page width is contextual, not one number.

   Everything used to stretch to 1600px, which left a settings form with two
   fields floating in a metre of nothing. A ledger wants the room; a form
   wants a readable measure. */
export type Width = 'form' | 'operational' | 'wide' | 'full'

const WIDTH: Record<Width, string> = {
  form: 'mx-auto w-full max-w-[1120px]',
  operational: 'mx-auto w-full max-w-[1360px]',
  wide: 'mx-auto w-full max-w-[1520px]',
  full: 'w-full',
}

/** Standard body padding beneath a PageHead. */
export function PageBody({
  children,
  width = 'operational',
}: {
  children: ReactNode
  width?: Width
}) {
  return <div className={cn('space-y-7 px-5 pb-10 sm:px-7', WIDTH[width])}>{children}</div>
}

/* A panel: white where content needs containing, and nothing where it does
   not. Distinct from Card only in intent -- Card is the legacy name and stays
   for the screens already using it. */
export function Panel({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('rounded-[10px] border bg-card', className)}>{children}</div>
  )
}

/* Not available yet.

   Was a full-width bordered card containing four lines and two developer
   fields, so the emptiest screens in the product looked the most elaborate.
   Neutral, not amber: "not implemented" is product metadata, not a warning
   about anything the person in front of it did. */
export function UnavailableState({
  title,
  body,
  technical,
}: {
  title: string
  body?: string
  technical?: { label: string; value: string }[]
}) {
  return (
    <div className="max-w-[720px]">
      <div className="flex items-start gap-3">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-[15px] font-medium">{title}</p>
          {body && (
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">{body}</p>
          )}
        </div>
      </div>

      {technical && technical.length > 0 && (
        /* Permission keys and scopes are implementation language. A finance
           clerk should never meet them; the person debugging a grant needs
           them in one click. */
        <details className="group mt-5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            Technical information
          </summary>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[12.5px]">
            {technical.map((t) => (
              <Fragment key={t.label}>
                <dt className="text-muted-foreground">{t.label}</dt>
                <dd className="font-mono text-[11.5px]">{t.value}</dd>
              </Fragment>
            ))}
          </dl>
        </details>
      )}
    </div>
  )
}

/**
 * The signature pulse grid: cells separated by the background showing through
 * a 1px gap, rather than each cell drawing its own border.
 */
/* A row of stat cells, as wide as it has cells to fill.

   `cols` is a ceiling, not a promise. The grid draws its own hairlines by
   giving the container a background and letting the gaps show through, which
   is elegant while every track is occupied and leaves a grey rectangle at the
   end of the row the moment one is not — three stats in a four-column grid
   showed a fourth, empty, lit cell that looked like a card that had failed to
   load.

   Counting the children fixed that for a short row and not for a long one:
   five stats in a four-track grid still left three unlit boxes on the second
   row, and four stats at tablet width — three tracks — left one. Every page
   in the product with four or five figures on it was shipping that hole.

   So the track count is now chosen per breakpoint as a divisor of the number
   of cells, and where the count is prime the last cell is widened to close
   the row instead. Either way the grid ends on a full row and there is never
   a lit track with nothing in it.

   Children are counted with Children.toArray rather than by asking the
   caller, because callers pass conditionals — {money && <Stat/>} — and the
   honest number is the one after those have resolved. toArray drops the nulls
   and booleans those produce, which count() alone would include. */

type Bp = 'sm' | 'md' | 'xl'

/* Written out rather than composed, because Tailwind reads this file as text:
   a class name assembled at runtime is a class name that never gets built. */
const TRACKS: Record<Bp, Record<number, string>> = {
  sm: { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4', 5: 'sm:grid-cols-5', 6: 'sm:grid-cols-6' },
  md: { 1: 'md:grid-cols-1', 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4', 5: 'md:grid-cols-5', 6: 'md:grid-cols-6' },
  xl: { 1: 'xl:grid-cols-1', 2: 'xl:grid-cols-2', 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4', 5: 'xl:grid-cols-5', 6: 'xl:grid-cols-6' },
}
/* Every breakpoint states its span, including a span of one.

   Breakpoints are min-widths, so a `sm:col-span-2` written for the tablet row
   is still in force on a desktop unless a wider rule says otherwise. Leaving
   the wide breakpoints silent left the last cell double-width in a row that
   no longer needed closing — which is how a five-track row came out with four
   tiles in it and a lit gap on the end, the exact defect this is here to
   remove. Each breakpoint overrides the one below it. */
const SPAN: Record<Bp, Record<number, string>> = {
  sm: { 1: 'sm:col-span-1', 2: 'sm:col-span-2', 3: 'sm:col-span-3', 4: 'sm:col-span-4', 5: 'sm:col-span-5', 6: 'sm:col-span-6' },
  md: { 1: 'md:col-span-1', 2: 'md:col-span-2', 3: 'md:col-span-3', 4: 'md:col-span-4', 5: 'md:col-span-5', 6: 'md:col-span-6' },
  xl: { 1: 'xl:col-span-1', 2: 'xl:col-span-2', 3: 'xl:col-span-3', 4: 'xl:col-span-4', 5: 'xl:col-span-5', 6: 'xl:col-span-6' },
}

/* How many tracks to open at one breakpoint.

   A divisor of the cell count first, widest one that fits, because a row that
   divides is a grid with no seam in it. Failing that — five cells, four
   tracks — one row of everything, but only where the tracks stay wide enough
   to hold a 28px number, which is the widest breakpoint and nowhere else.
   Otherwise the ceiling stands and the last cell is widened to close the row. */
function tracksFor(filled: number, ceiling: number, oneRowOk: boolean) {
  const top = Math.min(ceiling, filled)
  for (let n = top; n >= 2; n--) if (filled % n === 0) return n
  if (oneRowOk && filled <= ceiling + 1) return filled
  return Math.max(1, top)
}

export function CellGrid({ cols = 4, children }: { cols?: 2 | 3 | 4; children: ReactNode }) {
  const kids = Children.toArray(children)
  const filled = kids.length
  if (filled === 0) return null

  const grid: string[] = []
  const span: string[] = []
  let widest = 1
  const plan: [Bp, number, boolean][] = [
    ['sm', 2, false],
    ['md', 3, false],
    ['xl', cols, true],
  ]
  for (const [bp, ceiling, oneRowOk] of plan) {
    const n = tracksFor(filled, ceiling, oneRowOk)
    grid.push(TRACKS[bp][n])
    // The remainder is what the last row is short by; widening the final cell
    // by that much lands it exactly on the right-hand edge.
    const rest = filled % n
    const wide = rest === 0 ? 1 : n - rest + 1
    widest = Math.max(widest, wide)
    span.push(SPAN[bp][wide])
  }

  const last = kids[filled - 1]
  const closes = widest > 1

  return (
    <div className={cn('cell-grid reveal grid-cols-1', ...grid)}>
      {closes ? kids.slice(0, -1) : kids}
      {closes && (
        /* A grid wrapper, not a plain one: the cell inside has to stretch to
           the row's height or the widened tile comes out short. */
        <div className={cn('grid', ...span)}>{last}</div>
      )}
    </div>
  )
}

export function Stat({
  label,
  value,
  delta,
  icon: Icon,
  hint,
  period,
  onClick,
  active,
}: {
  label: string
  value: ReactNode
  delta?: { value: string; positive?: boolean }
  icon?: React.ComponentType<{ className?: string }>
  hint?: string
  /* What span this number covers.

     Stated on every card once metrics became range-aware, because otherwise a
     dashboard set to "last term" shows a balance and a collection total side
     by side and nothing says that only one of them moved. A balance is true
     now; a total belongs to a period. Silence there is how somebody reports
     the wrong figure to a trustee. */
  period?: string
  /* What pressing it does, where that means anything.

     "Examinations 1" says there is one and not which one, and the card already
     knows exactly which rows it counted. Without onClick a Stat stays an
     ordinary card rather than becoming a button that does nothing, which is
     the worse half of making things clickable. */
  onClick?: () => void
  /** Whether this card's filter is the one currently applied. */
  active?: boolean
}) {
  const Box = onClick ? 'button' : 'div'
  return (
    <Box
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      className={cn(
        'cell',
        onClick && 'w-full cursor-pointer text-left transition-colors hover:bg-accent',
        onClick && active && 'bg-accent',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">{label}</p>
        {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </div>
      <p className="stat">{value}</p>
      {delta && (
        <p
          className={cn(
            'mt-1.5 text-[13px]',
            delta.positive === false ? 'text-destructive' : 'text-success',
          )}
        >
          {delta.value}
        </p>
      )}
      {hint && !delta && <p className="mt-1.5 text-[13px] text-muted-foreground">{hint}</p>}
      {period && (
        <p className="mt-1.5 text-[12px] text-muted-foreground/80">{period}</p>
      )}
    </Box>
  )
}

/* Sorting.

   Not a single table sorted. A clerk looking for the oldest unpaid invoice in
   a list of forty read all forty, every time — and the data was already in the
   browser, so the cost was pure omission.

   Done as a hook over the caller's own array rather than inside Table,
   because a table cell is an arbitrary React node: sorting the rendered rows
   would mean comparing JSX. The caller knows the shape of its data and hands
   over a key; everything else is shared.

   Undefined always sinks, whichever direction is chosen. A blank due date is
   not "earliest" and floating it to the top of an ascending sort is how a
   defaulter list starts with rows that owe nothing. */

export type SortDir = 'asc' | 'desc'

export function useSort<T>(
  rows: T[],
  pick: (row: T, key: string) => string | number | null | undefined,
  initial?: { key: string; dir?: SortDir },
) {
  const [key, setKey] = useState(initial?.key ?? '')
  const [dir, setDir] = useState<SortDir>(initial?.dir ?? 'asc')

  const toggle = (k: string) => {
    if (k === key) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      return
    }
    setKey(k)
    setDir('asc')
  }

  const sorted = key
    ? [...rows].sort((a, b) => {
        const av = pick(a, key)
        const bv = pick(b, key)
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : // localeCompare with numeric so "Class 10" sorts after "Class 9"
              String(av).localeCompare(String(bv), undefined, { numeric: true })
        return dir === 'asc' ? cmp : -cmp
      })
    : rows

  return { sorted, sortKey: key, dir, toggle }
}

/** A column heading. A plain string is not sortable; give it a key to make it so. */
export type Column = string | { label: string; key?: string; align?: 'right' }

/**
 * A table that stops being a table on a phone.
 *
 * Below `sm` each row becomes a stacked card and every cell grows a label from
 * the column header, because a nine-column fee ledger scrolled sideways on a
 * 360px screen is unreadable — and a parent checking a due date is the single
 * most common phone session this system will ever serve.
 *
 * The labels are injected here rather than passed at each of the twenty-odd
 * call sites: a header and its cells are already required to line up, so
 * asking every caller to repeat the header on each cell would only create a
 * second place for them to disagree.
 */
/* Ten. Enough that a page is worth turning, few enough that the tenth row is
   still on screen with the header above it on a laptop. */
const PAGE_SIZE = 10

export function Table({
  head,
  children,
  empty,
  emptyLabel = 'Nothing to show.',
  sort,
  wide,
}: {
  head: Column[]
  children: ReactNode
  empty?: boolean
  emptyLabel?: string
  /** Supply what useSort returned to make keyed columns clickable. */
  sort?: { sortKey: string; dir: SortDir; toggle: (k: string) => void }
  /* A table with more columns than the screen has room for.

     `w-full` divides the width between however many columns there are, which
     is right for six and wrong for fifteen. The entitlement matrix has one
     column per module: at thirteen, every cell was squeezed until school names
     broke character by character — "Demo Scho ol" — and the buttons at the
     right were clipped by the card edge. The remedy is not smaller text; it is
     to let columns take the width they need and scroll the container, which it
     has always been able to do. */
  wide?: boolean
}) {
  const labels = head.map((h) => (typeof h === 'string' ? h : h.label))

  /* TEN ROWS AT A TIME, everywhere, without touching a call site.

     A register that scrolls for six hundred rows has no shape: you cannot tell
     where you are in it, you cannot get back to what you just read, and the
     header leaves the screen before the tenth row arrives. A page is a place; a
     scroll position is not.

     Done here rather than per screen because there are roughly a hundred tables
     in this product and none of them should have to opt in. Children.toArray
     flattens whatever the caller mapped and yields one entry per row, so no
     screen changes shape to gain this.

     Below the page size nothing is drawn at all: a five-row table with a pager
     under it is furniture, not navigation. */
  const rows = Children.toArray(children)
  const [page, setPage] = useState(0)
  const [full, setFull] = useState(false)
  const size = full ? PAGE_SIZE * 4 : PAGE_SIZE
  const pages = Math.max(1, Math.ceil(rows.length / size))

  /* Snap back when the rows change underneath.

     Filter a 400-row list down to 12 while sitting on page 9 and the table is
     empty with a Previous button as the only clue about why. The row COUNT is
     the signal: a re-sort keeps its length and should keep your place, a filter
     does not. */
  const [seen, setSeen] = useState(rows.length)
  if (seen !== rows.length) {
    setSeen(rows.length)
    if (page > 0) setPage(0)
  }

  const at = Math.min(page, pages - 1)

  /* FULL SCREEN, AND MORE ROWS WHILE IT IS.

     A table lives inside a card inside a page, so it gets whatever width is
     left after the sidebar and whatever height is left after the header — and
     ten rows at a time, which is the right page size for a card and a poor one
     for somebody actually working a register. A wide table then scrolls
     sideways inside a box narrower than the table, which is the worst way to
     read anything.

     Full screen fixes both at once. The same table, the same rows, the same
     sorting — 40 to a page instead of 10, because the room is there and the
     page size only ever existed to fit the card. */
  const start = at * size
  const shown = rows.length > size ? rows.slice(start, start + size) : rows

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [full])

  const body = (
    /* `.scroll-x`, not a bare overflow-x-auto: it draws the bar and the edge
       shadow that say the table continues past the card. See index.css.

       The width rule below is the other half of the same problem — a `wide`
       table is one whose columns cannot be squeezed, so it is sized to its
       content and allowed to run past the card, which is precisely the case
       the scroll affordance exists to announce. */
    <div className="scroll-x">
      <table
        className={cn(
          'responsive-table text-[14px]',
          // is-wide also freezes the first column — see index.css. A table
          // scrolled sideways must not carry away the column naming the row.
          wide ? 'is-wide w-max min-w-full' : 'w-full',
        )}
      >
        <thead>
          <tr>
            {head.map((h) => {
              const label = typeof h === 'string' ? h : h.label
              const key = typeof h === 'string' ? undefined : h.key
              const active = !!key && sort?.sortKey === key
              // A money column is read as a column of digits lined up on the
              // right; its header has to sit over them or the eye has to find
              // the pairing twice.
              const right = typeof h !== 'string' && h.align === 'right'
              // 12px medium, sentence case. Uppercase letter-spaced headers
              // shout across a table that is trying to be read quietly.
              return (
                <th
                  key={label}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn(
                    'whitespace-nowrap px-5 py-2.5 text-[12px] font-medium text-muted-foreground',
                    right ? 'text-right' : 'text-left',
                  )}
                >
                  {key && sort ? (
                    <button
                      type="button"
                      onClick={() => sort.toggle(key)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-sm transition-colors',
                        'hover:text-foreground',
                        active && 'text-foreground',
                      )}
                    >
                      {label}
                      {/* The arrow only appears on the sorted column. A chevron
                          on every header is a row of noise pointing nowhere. */}
                      {active &&
                        (sort.dir === 'asc' ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        ))}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {empty ? (
            <tr>
              <td colSpan={head.length} className="px-5 py-12 text-center text-[14px] text-muted-foreground">
                {emptyLabel}
              </td>
            </tr>
          ) : (
            labelCells(shown, labels)
          )}
        </tbody>
      </table>

        {rows.length > size && (
          <div className="flex items-center justify-between gap-4 border-t px-5 py-2.5">
            {/* Where you are, in the rows' own terms. "Page 3 of 9" needs
                arithmetic before it answers "have I passed the Ks yet"; the row
                numbers answer it directly. */}
            <p className="text-[12.5px] tabular-nums text-muted-foreground">
              {start + 1}–{Math.min(start + size, rows.length)} of {rows.length}
            </p>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="secondary" disabled={at === 0}
                      onClick={() => setPage(at - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="secondary" disabled={at >= pages - 1}
                      onClick={() => setPage(at + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
    </div>
  )

  if (!full) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setFull(true)}
          aria-label="View full screen"
          title="View full screen"
          className="absolute right-2 top-2 z-10 grid size-8 place-items-center rounded-[3px]
                     border border-border bg-card text-muted-foreground opacity-0
                     transition-opacity hover:text-foreground focus-visible:opacity-100
                     group-hover/table:opacity-100 max-md:opacity-60"
        >
          <Maximize2 className="h-4 w-4" aria-hidden="true" />
        </button>
        {body}
      </div>
    )
  }

  /* Into the body, or the Close button cannot be clicked.

     `:where(.card, .cell, …):active` scales by 0.99 on press — a deliberate
     touch, and a transform on an ancestor makes `position: fixed` resolve
     against that ancestor instead of the viewport. The dialog renders inside
     the card holding the table, so pressing Close put the card into :active,
     the dialog re-anchored to the card's box mid-press, and it jumped out from
     under the cursor before mouseup. The click never completed and the screen
     appeared stuck.

     No ancestor can be a containing block for something parented to the body,
     which also settles the z-index and the clipping in one move. */
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Table, full screen"
      className="fixed inset-0 z-[80] flex flex-col bg-background p-3 sm:p-5"
    >
      <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
        <p className="text-[13px] tabular-nums text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </p>
        <Button size="sm" variant="secondary" onClick={() => {
          setFull(false)
          if (typeof document !== 'undefined' && document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {})
          }
        }}>
          <X className="h-3.5 w-3.5" />
          Close
        </Button>
      </div>
      {/* The one part that is genuinely different full screen: the table gets
          the height, so the scroll happens inside it and the header stays. */}
      <div className="min-h-0 flex-1 overflow-auto rounded-[3px] border">{body}</div>
    </div>,
    document.body,
  )
}

/**
 * Walks the rows and hands each cell the header above it.
 *
 * A cell that spans columns gets no label — it is a full-width note, not a
 * field, and labelling it with whichever header it happens to start under
 * would be worse than leaving it bare.
 *
 * ---
 * The rows passed to <Table> must be `<tr>` elements, not components that
 * render one. This walk sees the element it is given: for `<tr>` it finds the
 * cells and labels them, but for `<MyRow />` it finds `props.children` of the
 * component element — which is undefined — so it labels nothing, the cells
 * arrive without data-label, and every row of that table collapses below 640px
 * into unlabelled values. The table still looks right on a desktop, which is
 * why this has been shipped four times.
 *
 * A row that needs its own state or a second expanded `<tr>` should be a plain
 * function returning an ARRAY of `<tr>`s, called in the map rather than mounted
 * as an element:
 *
 *     {rows.map((r) => lineRows(r, { open: open.has(r.id), onToggle }))}
 *
 * Children.map flattens the array and each `<tr>` is walked normally. A
 * fragment does not work — it is one element whose children are the rows, so
 * each `<tr>` inside it would be labelled as though it were a cell.
 */
function labelCells(rows: ReactNode, head: string[]): ReactNode {
  return Children.map(rows, (row) => {
    if (!isValidElement(row)) return row
    const props = row.props as { children?: ReactNode }
    let column = 0
    const cells = Children.map(props.children, (cell) => {
      if (!isValidElement(cell)) return cell
      const cellProps = cell.props as { colSpan?: number }
      const label = cellProps.colSpan && cellProps.colSpan > 1 ? undefined : head[column]
      column += cellProps.colSpan ?? 1
      return cloneElement(cell as ReactElement<{ label?: string }>, { label })
    })
    return cloneElement(row as ReactElement<{ children?: ReactNode }>, {}, cells)
  })
}

export function Td({
  children,
  className,
  colSpan,
  label,
}: {
  children?: ReactNode
  className?: string
  colSpan?: number
  /** Injected by Table; surfaced as the field name in the stacked layout. */
  label?: string
}) {
  return (
    <td
      colSpan={colSpan}
      data-label={label}
      className={cn('px-5 [padding-block:var(--row-py)]', className)}
    >
      {children}
    </td>
  )
}

const TONES = {
  neutral: 'bg-muted-foreground',
  success: 'bg-success',
  danger: 'bg-destructive',
  primary: 'bg-primary',
  warning: 'bg-warning',
  info: 'bg-info',
} as const

/**
 * A status: a coloured dot and a word.
 *
 * This used to be a filled lozenge, and a table of them read as a colour chart
 * — the eye went to the brightest cell rather than to the row that mattered.
 * The dot carries the state, the label carries the meaning, and the row stays
 * scannable. `solid` is available for the rare case that has to survive being
 * glanced at across a counter.
 */
export function Badge({
  children,
  tone = 'neutral',
  solid,
}: {
  children: ReactNode
  tone?: keyof typeof TONES
  solid?: boolean
}) {
  if (solid) {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-sm px-1.5 py-0.5 text-[12px] font-medium',
          tone === 'success' && 'bg-success/12 text-success',
          tone === 'danger' && 'bg-destructive/12 text-destructive',
          tone === 'warning' && 'bg-warning/15 text-warning',
          tone === 'primary' && 'bg-primary/12 text-primary',
          tone === 'info' && 'bg-info/12 text-info',
          tone === 'neutral' && 'bg-muted text-secondary-foreground',
        )}
      >
        {children}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]">
      <span className={cn('status-dot', TONES[tone])} />
      {children}
    </span>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  type = 'button',
  title,
  size = 'md',
  tone,
  className,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary' | 'ghost' | 'ink' | 'outline'
  type?: 'button' | 'submit'
  /* The tooltip, and the accessible name that has to go with it.

     A button whose only child is an icon has no name at all: the mouse gets
     nothing on hover and a screen reader announces "button". `title` gives
     the first, and is invisible to the second — so when a caller supplies one
     it becomes the aria-label too, rather than leaving an icon-only control
     unnamed in the one place it matters most. */
  title?: string
  size?: 'sm' | 'md'
  /** Destructive actions borrow the semantic red rather than the accent. */
  tone?: 'danger'
  className?: string
}) {
  // `ink` and `outline` are the previous names; kept resolving so a missed
  // call site degrades to the right level instead of to an unstyled button.
  const level =
    variant === 'ink' ? 'primary' : variant === 'outline' ? 'secondary' : variant

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        /* nowrap because the height is fixed. A label that wraps does not make
           the button taller, it spills out of it — which is what a narrow last
           column in a wide table does to a two-syllable word. */
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium',
        'transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-[14px]',
        level === 'primary' &&
          (tone === 'danger'
            ? 'bg-destructive text-white hover:bg-destructive/90'
            : 'bg-primary text-primary-foreground hover:bg-primary/90'),
        level === 'secondary' &&
          cn(
            'border bg-card hover:bg-accent',
            tone === 'danger' && 'border-destructive/30 text-destructive hover:bg-destructive/5',
          ),
        level === 'ghost' &&
          cn(
            'text-secondary-foreground hover:bg-accent hover:text-foreground',
            tone === 'danger' && 'text-destructive hover:bg-destructive/5',
          ),
        className,
      )}
    >
      {children}
    </button>
  )
}

/**
 * A button that asks once before doing something you cannot undo.
 *
 * Two-step inline rather than window.confirm: the browser dialog cannot be
 * styled, blocks the whole tab, and — the part that matters — says nothing
 * about *what* is about to happen, so people learn to dismiss it. Here the
 * question replaces the button in place and names the consequence.
 *
 * The confirm state resets on blur and on Escape, so an accidental click is
 * one keystroke away from harmless.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  question,
  onConfirm,
  disabled,
  variant = 'secondary',
  size = 'sm',
  tone,
  label,
}: {
  children: ReactNode
  /** What the confirming button says — a verb, not "OK". */
  confirmLabel: string
  /** The consequence, in one short line. */
  question: string
  onConfirm: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md'
  tone?: 'danger'
  /* What the control is, for a caller whose children are an icon.

     The question below only appears after the click, so an icon-only trigger
     said nothing at all until somebody had already pressed it — which is the
     wrong order for a control that resets a password. */
  label?: string
}) {
  const [asking, setAsking] = useState(false)

  if (!asking) {
    return (
      <Button
        variant={variant}
        size={size}
        disabled={disabled}
        title={label}
        onClick={() => setAsking(true)}
      >
        {children}
      </Button>
    )
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-1.5 py-1"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setAsking(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setAsking(false)
      }}
    >
      <span className="px-1 text-[13px] text-muted-foreground">{question}</span>
      <button
        type="button"
        autoFocus
        disabled={disabled}
        onClick={() => {
          setAsking(false)
          onConfirm()
        }}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[13px] font-medium',
          'disabled:pointer-events-none disabled:opacity-40',
          tone === 'danger'
            ? 'bg-destructive text-white hover:bg-destructive/90'
            : 'bg-ink text-ink-foreground hover:bg-ink/90',
        )}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        aria-label="Cancel"
        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}

/** A labelled checkbox. A bare box with text beside it is not clickable text. */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  srLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  /* What a screen reader should call this box when the column supplies the
     meaning and the cell cannot repeat it.

     A checkbox in a table of people is the case: the header says "Charge" and
     the row says whose fine it is, so a visible label on every box would be
     thirty repetitions of the same word down the column. Passing label="" was
     how that was written, and it left the control with no accessible name at
     all — "checkbox, unchecked", thirty times, on the box that decides who
     gets charged money. Name it here instead: invisible, and the only name the
     control has. */
  srLabel?: string
}) {
  return (
    <label className="inline-flex cursor-pointer items-start gap-2 text-[13px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={srLabel || undefined}
        className="mt-0.5 h-[15px] w-[15px] shrink-0 accent-primary"
      />
      <span>
        {label}
        {hint && <span className="block text-[12px] text-muted-foreground">{hint}</span>}
      </span>
    </label>
  )
}

/**
 * A dropdown, optionally one the school may extend.
 *
 * Pass `kind` and the list stops being the vendor's opinion of what exists.
 * The literal `options` stay as the built-in suggestions; the school's own
 * additions for that kind are appended, and a final "+ Add your own" entry
 * turns the control into a text box for as long as it takes to type one.
 *
 * Without `kind` this is exactly the plain select it always was, which is the
 * right answer for anything the code branches on — a status, a yes/no, a
 * scope. Those are not vocabulary, they are logic, and a school inventing a
 * sixth invoice status would break every report that groups by it.
 */
/**
 * A dropdown you can type into.
 *
 * Every list in this product is a school's own data — forty teachers, thirty
 * sections, twenty roles — and a native select makes you scroll all of them to
 * reach the one you already know the name of. So this filters as you type.
 * Same props as before, so every dropdown in the application inherits it
 * without being touched.
 *
 * `kind` adds the other half: where the list is vocabulary rather than
 * records, typing something that is not on it offers to add it, and the value
 * joins the list for the whole school.
 *
 * Every other list of *words* now takes a typed value too, without needing a
 * kind: the text becomes the value, used here and not added to any shared
 * vocabulary. A school whose relation is "Grandmother", whose medium is
 * "Urdu", whose designation is "Correspondent" should not be stopped by a list
 * somebody else wrote.
 *
 * Lists of *records* are exempt, and the difference is not a matter of taste:
 * you cannot allocate a subject to a teacher who does not exist. Those lists
 * are recognised by their values being ids rather than words, so nothing has
 * to remember to opt out — a dropdown of people keeps filtering and never
 * invents, exactly as before.
 *
 * Deliberately not a native <select>. That gets typeahead free but only on the
 * first letter, only while the menu is open, and never on the middle of a
 * name, which is how people actually search for "Priya Rao" by typing "rao".
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  kind,
  addLabel = 'Add your own',
  allowCustom,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  /** Enables school-defined additions. Must be a kind the server publishes. */
  kind?: string
  addLabel?: string
  /** Overrides the id-detection when a caller knows better either way. */
  allowCustom?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [custom, setCustom] = useState<{ value: string; label: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!kind) return
    let live = true
    api
      .get<{ items: { value: string; label: string; custom?: boolean }[] }>(
        `/api/v1/setup/options?kind=${encodeURIComponent(kind)}`,
      )
      .then((r) => { if (live) setCustom((r.items ?? []).filter((o) => o.custom)) })
      .catch(() => { /* the built-in list still works */ })
    return () => { live = false }
  }, [kind])

  // Closing on an outside click rather than on blur: blur fires before the
  // click that chose an option, so a blur-closed menu is a menu you cannot
  // click anything in.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setQuery('') }
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  /* Where the menu goes, in viewport coordinates.

     The trigger may be inside a table that scrolls sideways, so its position
     is only knowable at the moment the menu opens — and has to be re-read if
     anything scrolls underneath it while it is open. */
  const [box_, setBox_] = useState<{ left: number; top: number; width: number } | null>(null)

  useEffect(() => {
    if (!open) {
      setBox_(null)
      return
    }
    const place = () => {
      const el = box.current
      if (!el) return
      const r = el.getBoundingClientRect()
      /* Above the trigger when there is no room below it. A menu opening off
         the bottom of the window is the same fault as one clipped by a table:
         the options exist and cannot be reached. */
      const below = window.innerHeight - r.bottom
      const wantsAbove = below < 220 && r.top > below
      setBox_({
        left: r.left,
        top: wantsAbove ? Math.max(8, r.top - 4 - Math.min(256, r.top - 16)) : r.bottom + 4,
        width: r.width,
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  const all = kind ? [...options, ...custom] : options
  const selected = all.find((o) => o.value === value)
  const q = query.trim().toLowerCase()
  const shown = q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all
  const canAdd = !!kind && !!q && !all.some((o) => o.label.toLowerCase() === q)

  /* Words or records?
   *
   * A value that is a uuid names a row somebody else owns — a class, a
   * teacher, a fee head — and typing a new one would send the server an id
   * that does not exist. A value that is a word is the answer itself, and
   * there is no reason a school cannot give one the list did not think of.
   * One list of ids anywhere is enough to settle it for the whole dropdown. */
  const isID = (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  const freeText = allowCustom ?? (!kind && all.length > 0 && !all.some((o) => isID(o.value)))
  const canUseTyped =
    freeText && !!q && !all.some((o) => o.label.toLowerCase() === q)

  /* A chosen value that is not on the list is still the chosen value.
   *
   * The box shows the label of the matching option, so a typed-in answer —
   * which by definition has no option — rendered as an empty field the moment
   * the menu closed. It looked as though nothing had been saved, and the next
   * person to open the form would have set it again. */
  const shownLabel = selected?.label ?? (freeText && value ? value : '')

  const choose = (v: string) => { onChange(v); setOpen(false); setQuery('') }

  const add = () => {
    const label = query.trim()
    if (!label) return
    setBusy(true); setErr('')
    api
      .post<{ value: string; label: string }>('/api/v1/setup/options', { kind, label })
      .then((made) => { setCustom((c) => [...c, made]); choose(made.value) })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false))
  }

  const rows = shown.length + (canAdd || canUseTyped ? 1 : 0)

  return (
    <div ref={box} className="relative">
      <input
        className="field cursor-text pr-8"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={open ? query : shownLabel}
        placeholder={shownLabel || placeholder || 'Type to search'}
        onFocus={() => { setOpen(true); setActive(0) }}
        /* Clicking it again reopens it.
         *
         * Choosing an option closes the menu and leaves the input focused, so
         * the next click fired no focus event and nothing happened — somebody
         * wanting to change their answer clicked the box, saw it do nothing,
         * and clicked away to try again. onFocus alone only ever opens the
         * FIRST time.
         *
         * The query is cleared on choose, so reopening shows the whole list
         * rather than the list narrowed by what was picked last time. */
        onClick={() => { setOpen(true); setActive(0) }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, rows - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') {
            e.preventDefault()
            if (canAdd && active === shown.length) add()
            else if (canUseTyped && active === shown.length) choose(query.trim())
            else if (shown[active]) choose(shown[active].value)
          } else if (e.key === 'Escape') { setOpen(false); setQuery('') }
        }}
      />
      <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        <ChevronDown className="h-4 w-4" />
      </span>

      {open && box_ && createPortal(
        <div
          /* In the body, so no scrolling ancestor can clip it. Placed against
             the trigger's own box rather than flowing under it, because the
             two no longer share a coordinate space. */
          style={{ left: box_.left, top: box_.top, width: box_.width }}
          className="fixed z-50 max-h-64 overflow-auto rounded-md border bg-popover p-1 shadow-md"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {placeholder && !q && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose('')}
              className="block w-full rounded px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent">
              {placeholder}
            </button>
          )}
          {shown.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o.value)}
              className={cn(
                'block w-full rounded px-2 py-1.5 text-left text-[13px]',
                i === active ? 'bg-accent' : 'hover:bg-accent',
                o.value === value && 'font-medium',
              )}
            >
              {o.label}
            </button>
          ))}
          {canAdd && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(shown.length)}
              onClick={add}
              disabled={busy}
              className={cn(
                'block w-full rounded px-2 py-1.5 text-left text-[13px]',
                active === shown.length ? 'bg-accent' : 'hover:bg-accent',
              )}
            >
              {busy ? 'Adding…' : `+ ${addLabel}: “${query.trim()}”`}
            </button>
          )}
          {canUseTyped && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(shown.length)}
              onClick={() => choose(query.trim())}
              className={cn(
                'block w-full rounded px-2 py-1.5 text-left text-[13px]',
                active === shown.length ? 'bg-accent' : 'hover:bg-accent',
              )}
            >
              Use “{query.trim()}”
            </button>
          )}
          {!shown.length && !canAdd && !canUseTyped && (
            <p className="px-2 py-2 text-[12.5px] text-muted-foreground">
              {kind
                ? 'Nothing matches. Keep typing to add it.'
                : 'Nothing matches that. This list only takes one of its own.'}
            </p>
          )}
          {err && <p className="px-2 py-1.5 text-[12px] text-destructive">{err}</p>}
        </div>,
        document.body,
      )}
    </div>
  )
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
  list,
  srLabel,
  onFocus,
  onBlur,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  className?: string
  /** id of a <datalist> to suggest from, without constraining the input. */
  list?: string
  /* What a screen reader should call this box when it stands outside a Field.

     A box in a table cell is the case: the column header names it and a
     repeated visible label would be noise down the column. A placeholder is
     not a substitute — it is not an accessible name, and it disappears the
     moment anything is typed. Same contract as Checkbox's srLabel. */
  srLabel?: string
  /* For a box that opens a suggestion list: it has to know when the person
     arrived and when they left. */
  onFocus?: () => void
  onBlur?: () => void
}) {
  /* A password can be looked at.
   *
   * Hiding what is typed is worth having — it is also why a mistyped password
   * is invisible, and every one of these boxes is somewhere a person is
   * typing a string of hyphenated capitals off a printed list. The reveal is
   * per box, starts hidden, and is remembered nowhere. */
  const [shown, setShown] = useState(false)
  const isPassword = type === 'password'

  const field = (
    <input
      type={isPassword && shown ? 'text' : type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      list={list}
      onFocus={onFocus}
      onBlur={onBlur}
      aria-label={srLabel || undefined}
      className={cn('field', isPassword && 'pr-10', className)}
    />
  )
  if (!isPassword) return field

  return (
    <span className="relative block">
      {field}
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        title={shown ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
      >
        {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </span>
  )
}

/**
 * The multi-line form of Input.
 *
 * Three screens hand-rolled this before it existed, and each picked its own
 * row count and border, so a mess menu and a lesson plan looked like controls
 * from different products.
 */
export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  className?: string
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={cn('field h-auto resize-y py-2 leading-relaxed', className)}
    />
  )
}

/**
 * A labelled control.
 *
 * `hint` carries the thing a school admin cannot be expected to know — that a
 * UDISE code is eleven digits, that the Telangana year runs June to April.
 * Putting it under the field rather than in documentation is the difference
 * between a form that teaches and one that rejects.
 */
export function Field({
  label,
  hint,
  required,
  children,
  wide,
}: {
  label: string
  hint?: string
  required?: boolean
  children: ReactNode
  wide?: boolean
}) {
  return (
    <label className={cn('block', wide && 'sm:col-span-2')}>
      <span className="mb-1.5 block text-[13px] font-medium text-secondary-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[13px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

/** Two-column form grid that collapses to one on a phone. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2">{children}</div>
}

/** Inline result of a save: the server's own words, not a generic toast. */
export function FormNotice({ error, ok }: { error?: unknown; ok?: string }) {
  if (error) {
    const msg = error instanceof Error ? error.message : 'Could not save'
    return (
      <p className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
        {msg}
      </p>
    )
  }
  if (ok)
    return (
      <p className="rounded-md border border-success/25 bg-success/5 px-3 py-2 text-[13px] text-success">
        {ok}
      </p>
    )
  return null
}

export function ErrorState({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : 'Unexpected error'
  return (
    <Card className="p-8 text-center">
      <p className="text-[14px] text-destructive">{msg}</p>
    </Card>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="px-5 py-12 text-center text-[14px] text-muted-foreground">{label}</p>
}

/**
 * A placeholder the shape of the thing being loaded.
 *
 * "Loading…" centred in an empty card means the page jumps when the data
 * lands and every element moves — which is how somebody clicks the wrong row.
 * Holding the space costs nothing and keeps the layout still.
 */
export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-5" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-9 animate-pulse rounded-sm bg-muted"
          // Staggered widths so it reads as content rather than as a bar chart.
          style={{ width: `${92 - (i % 3) * 9}%`, animationDelay: `${i * 60}ms` }}
        />
      ))}
    </div>
  )
}

/**
 * Print this page.
 *
 * The print stylesheet drops the navigation and the colour; this is the button
 * that admits printing is a first-class action in a school rather than
 * something the browser menu handles. Hidden from the printout itself.
 */
export function PrintButton({ label = 'Print' }: { label?: string }) {
  return (
    <Button variant="secondary" size="sm" onClick={() => window.print()} className="no-print">
      <Printer className="h-3.5 w-3.5" />
      {label}
    </Button>
  )
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <Card className="empty-state p-10 text-center">
      <p className="text-[15px] font-semibold">{title}</p>
      {body && <p className="mx-auto mt-1.5 max-w-md text-[14px] text-muted-foreground">{body}</p>}
    </Card>
  )
}

/**
 * Download link for a server-streamed CSV.
 *
 * A plain anchor, not a fetch-and-blob: the browser's own download handling
 * streams the file straight to disk, which matters when a whole-school
 * attendance export is tens of thousands of rows.
 */
export function ExportButton({ report, label }: { report: string; label?: string }) {
  return (
    <a href={`/api/v1/export/${report}`} download>
      <Button variant="outline" size="sm">
        <Download className="h-3.5 w-3.5" />
        {label ?? 'Export CSV'}
      </Button>
    </a>
  )
}

/* Which period the numbers cover.

   Every dashboard had its period welded into the SQL — attendance always
   today, collection always this calendar month — so "how did we do last term"
   meant an export and a spreadsheet.

   The presets come from the server rather than a list kept here, because the
   resolver and the picker have to agree on what "this term" means; two copies
   would drift the first time a school's year was configured differently. The
   grouping (Recent / Calendar / School / Custom) exists because an Indian
   school asks in three different calendars: the academic year runs June to
   April, the financial year April to March, and neither is the calendar year.
*/

export interface RangeOption {
  value: string
  label: string
  group: string
}

export interface ActiveRange {
  period: string
  from?: string
  to?: string
  label?: string
}

/** Turns a range into the query string every metric endpoint understands. */
export function rangeQuery(r: ActiveRange): string {
  if (r.period === 'custom' && r.from && r.to) {
    return `from=${r.from}&to=${r.to}`
  }
  return `period=${r.period}`
}

export function RangePicker({
  value,
  onChange,
  options,
  label,
}: {
  value: ActiveRange
  onChange: (r: ActiveRange) => void
  options: RangeOption[]
  /** The server's description of the resolved period — "August 2026", not "this month". */
  label?: string
}) {
  const [custom, setCustom] = useState(value.period === 'custom')
  const groups = [...new Set(options.map((o) => o.group))]

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
      {/* An empty select is a box that does nothing.
       *
       * The presets are fetched, so for the first moment of every page this
       * had no options at all — and a select with no options renders as a
       * small empty box with an arrow on it that opens nothing when clicked.
       * It reads as broken rather than as loading, and clicking it harder does
       * not help. Disabled and labelled while the list is empty: same size,
       * same place, and it says what it is waiting for. */}
      {options.length === 0 ? (
        <select disabled className="field w-auto cursor-default pr-8" aria-label="Date range">
          <option>Loading date ranges…</option>
        </select>
      ) : (
      <select
        value={value.period}
        onChange={(e) => {
          const period = e.target.value
          setCustom(period === 'custom')
          // A custom range is not applied until both ends are given, so the
          // numbers do not flicker through a nonsensical window on the way.
          if (period !== 'custom') onChange({ period })
        }}
        className="field w-auto cursor-pointer pr-8"
      >
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {options
              .filter((o) => o.group === g)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      )}

      {custom && (
        <>
          <input
            type="date"
            value={value.from ?? ''}
            onChange={(e) => onChange({ ...value, period: 'custom', from: e.target.value })}
            className="field w-auto"
            aria-label="From"
          />
          <span className="text-[13px] text-muted-foreground">to</span>
          <input
            type="date"
            value={value.to ?? ''}
            onChange={(e) => onChange({ ...value, period: 'custom', to: e.target.value })}
            className="field w-auto"
            aria-label="To"
          />
        </>
      )}

      {label && !custom && (
        <span className="text-[13px] text-muted-foreground">{label}</span>
      )}
    </div>
  )
}

/**
 * Remembers the chosen period across screens and reloads.
 *
 * Per browser rather than per screen: somebody reviewing last term looks at
 * four dashboards in a row, and having each one snap back to "this month"
 * turns one question into four re-selections.
 */
/* What a saved range is called.
 *
 * The picker knows the label while it is open, and a range restored from
 * localStorage on the next visit has only the key it was stored under. Every
 * screen then wrote `range.label ?? range.period`, so a principal reloading a
 * report was shown "fin_year" — a storage key, printed to somebody running a
 * school. The names live here, beside the picker that offers them, so no
 * screen has to keep its own copy.
 *
 * An unknown key is turned into words rather than passed through: a preset
 * added later should read as "last quarter", not fail the same way again.
 */
const RANGE_LABELS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_7: 'Last 7 days',
  last_30: 'Last 30 days',
  this_week: 'This week',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  this_term: 'This term',
  this_year: 'This academic year',
  last_year: 'Last academic year',
  fin_year: 'This financial year',
  custom: 'Custom range',
}

export function rangeLabel(r: { label?: string; period?: string }): string {
  if (r.label) return r.label
  const p = r.period ?? ''
  return RANGE_LABELS[p] ?? p.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

export function useRange(): [ActiveRange, (r: ActiveRange) => void] {
  const [range, setRange] = useState<ActiveRange>(() => {
    try {
      return JSON.parse(localStorage.getItem('erp.range') ?? '') as ActiveRange
    } catch {
      return { period: 'this_month' }
    }
  })
  const set = (r: ActiveRange) => {
    setRange(r)
    try {
      localStorage.setItem('erp.range', JSON.stringify(r))
    } catch {
      /* private browsing; the default returns next time */
    }
  }
  return [range, set]
}
