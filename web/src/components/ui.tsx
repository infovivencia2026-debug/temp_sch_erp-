import {
  Children, cloneElement, Fragment, isValidElement, useEffect, useRef, useState,
  type ReactElement, type ReactNode,
} from 'react'
import {
  CalendarRange, Check, ChevronDown, ChevronRight, ChevronUp, Clock, Download, Eye, EyeOff, Printer, X,
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
  description,
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
        {description && (
          <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
        )}
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
  description,
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
          {eyebrow && (
            <nav className="mb-1 flex items-center gap-1 text-[12.5px] text-muted-foreground">
              <span>{eyebrow}</span>
              <span aria-hidden className="text-muted-foreground/50">/</span>
              <span className="text-secondary-foreground">{title}</span>
            </nav>
          )}
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
          {description && (
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
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
export function CellGrid({ cols = 4, children }: { cols?: 2 | 3 | 4; children: ReactNode }) {
  return (
    <div
      className={cn(
        'cell-grid reveal grid-cols-1 sm:grid-cols-2',
        cols === 3 && 'md:grid-cols-3',
        cols === 4 && 'md:grid-cols-3 xl:grid-cols-4',
      )}
    >
      {children}
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
}) {
  return (
    <div className="cell">
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
    </div>
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
export function Table({
  head,
  children,
  empty,
  emptyLabel = 'Nothing to show.',
  sort,
}: {
  head: Column[]
  children: ReactNode
  empty?: boolean
  emptyLabel?: string
  /** Supply what useSort returned to make keyed columns clickable. */
  sort?: { sortKey: string; dir: SortDir; toggle: (k: string) => void }
}) {
  const labels = head.map((h) => (typeof h === 'string' ? h : h.label))
  return (
    <div className="overflow-x-auto">
      <table className="responsive-table w-full text-[14px]">
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
            labelCells(children, labels)
          )}
        </tbody>
      </table>
    </div>
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
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm font-medium',
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
}) {
  const [asking, setAsking] = useState(false)

  if (!asking) {
    return (
      <Button variant={variant} size={size} disabled={disabled} onClick={() => setAsking(true)}>
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
 * joins the list for the whole school. Records cannot work that way — you
 * cannot allocate a subject to a teacher who does not exist — so a dropdown
 * without `kind` filters but never invents.
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
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  /** Enables school-defined additions. Must be a kind the server publishes. */
  kind?: string
  addLabel?: string
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

  const all = kind ? [...options, ...custom] : options
  const selected = all.find((o) => o.value === value)
  const q = query.trim().toLowerCase()
  const shown = q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all
  const canAdd = !!kind && !!q && !all.some((o) => o.label.toLowerCase() === q)

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

  const rows = canAdd ? shown.length + 1 : shown.length

  return (
    <div ref={box} className="relative">
      <input
        className="field cursor-text pr-8"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={open ? query : selected?.label ?? ''}
        placeholder={selected ? selected.label : placeholder ?? 'Type to search'}
        onFocus={() => { setOpen(true); setActive(0) }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, rows - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') {
            e.preventDefault()
            if (canAdd && active === shown.length) add()
            else if (shown[active]) choose(shown[active].value)
          } else if (e.key === 'Escape') { setOpen(false); setQuery('') }
        }}
      />
      <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        <ChevronDown className="h-4 w-4" />
      </span>

      {open && (
        <div className="absolute z-40 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">
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
          {!shown.length && !canAdd && (
            <p className="px-2 py-2 text-[12.5px] text-muted-foreground">
              {kind ? 'Nothing matches. Keep typing to add it.' : 'Nothing matches that.'}
            </p>
          )}
          {err && <p className="px-2 py-1.5 text-[12px] text-destructive">{err}</p>}
        </div>
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
    <Card className="p-10 text-center">
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
