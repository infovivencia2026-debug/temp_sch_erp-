import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { INK, EDGE, WASH, RING, TRACK, SLIDER } from './ColourDialog'

/* ONE ROW, EVERYWHERE IN SETTINGS.

   Measured on the live /settings at 1440x900: 149 words, 48 controls, six type
   sizes, five sliders each flanked by a minus, a plus, a percentage and a
   "100%" pill (the pill at 2.03:1 because it was disabled), fifteen typeface
   cards each carrying a specimen and a sentence, and a paragraph over every
   section explaining what the controls under it were about to do. That is a
   settings page that explains itself instead of being obvious.

   The standard is an everyday product's Settings: a list of rows, and every
   row is the same object -- a label on the left, its current VALUE on the
   right, at least 44px tall, one hairline between rows, one padding. A row
   either changes in place (a slider, a switch, a select) or opens something
   (a chevron). Explanation is a single 12.5px line under the control, and
   only where the choice is not obvious from its name.

   Four type sizes on the whole page: the title (20px, in SettingsPage), the
   row label and its value (15px -- a value is not smaller than its label,
   Apple sets both at the body size and lets weight and position tell them
   apart), and the helper (12.5px). Nothing else.

   44px is written in pixels, not rem: the root here is 14px, and `min-h-11`
   is 38.5px on it. Every length that has to clear a finger is in px.

   TWO COMPOSITIONS, ONE ROW. On a phone Settings is a navigation: a list of
   sections, each opening a screen of its own, every row a 44px finger
   target. On a desktop it is a page: a nav on the left, the section's rows
   on the right, everything in view, and a mouse that does not need 44px --
   so the rows are 38px there. The row reads its height, its vertical
   padding and the slider band's height from three custom properties the
   page sets once (--srow-h, --srow-py, --sband-h); the phone leaves them at
   the 44px defaults. Same component, two densities, no scaled layout. */
export const LABEL = cn('text-[15px] font-medium', INK)
export const VALUE = cn('text-[15px] font-normal tabular-nums', INK)
export const HELPER = cn('mt-[2px] block text-[12.5px] font-normal', INK)

/** The list: hairlines between rows, none around the list. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'divide-y divide-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** The skeleton every row shares. `data-row` is what the measurement script
    asserts on: same height floor, same padding, same rule. */
export function Row({
  label, value, helper, children, className, as: Tag = 'div', ...rest
}: {
  label: ReactNode
  value?: ReactNode
  helper?: ReactNode
  children?: ReactNode
  className?: string
  as?: 'div' | 'label'
} & Omit<React.HTMLAttributes<HTMLElement>, 'children'>) {
  return (
    <Tag
      data-row=""
      className={cn('flex min-h-[var(--srow-h,44px)] flex-col justify-center px-[16px] py-[var(--srow-py,10px)]', className)}
      {...(rest as object)}
    >
      <span className="flex min-h-[24px] items-center justify-between gap-4">
        <span className={cn(LABEL, 'min-w-0 truncate')}>{label}</span>
        {value !== undefined && <span className={cn(VALUE, 'shrink-0 text-right')}>{value}</span>}
      </span>
      {children}
      {helper && <span className={HELPER}>{helper}</span>}
    </Tag>
  )
}

/** A row that opens something. The chevron is the only mark; the row is the
    target, all 44px of it. */
export function NavRow({
  label, helper, href, onClick, icon, value, className, current,
}: {
  label: ReactNode
  helper?: ReactNode
  href?: string
  onClick?: () => void
  icon?: ReactNode
  value?: ReactNode
  className?: string
  /** The section on screen, in a desktop nav: marked with a wash and no
      chevron, because it opens nothing -- it is where you are. */
  current?: boolean
}) {
  const inner = (
    <>
      {icon && <span className="mr-[12px] flex shrink-0 items-center" aria-hidden="true">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn(LABEL, 'block truncate')}>{label}</span>
        {helper && <span className={HELPER}>{helper}</span>}
      </span>
      {value !== undefined && <span className={cn(VALUE, 'ml-3 shrink-0')}>{value}</span>}
      {!current && <ChevronRight className="ml-2 size-4 shrink-0 opacity-60" aria-hidden="true" />}
    </>
  )
  const cls = cn(
    'flex min-h-[var(--srow-h,44px)] w-full items-center px-[16px] py-[var(--srow-py,10px)] text-left transition-colors',
    WASH, RING, INK,
    current && 'bg-[color-mix(in_srgb,var(--bento-ink)_8%,transparent)] font-semibold',
    className,
  )
  return href
    ? <a data-row="" href={href} className={cls} aria-current={current || undefined}>{inner}</a>
    : <button data-row="" type="button" onClick={onClick} className={cls} aria-current={current || undefined}>{inner}</button>
}

/** A choice among named options: one control, the value on the right, a
    native select underneath it so the keyboard, the screen reader and the
    phone's own picker all work for free. The select is the whole row. */
export function SelectRow<T extends string>({
  label, value, options, name, onPick, helper, valueStyle,
}: {
  label: string
  value: T
  options: readonly T[]
  name: (v: T) => string
  onPick: (v: T) => void
  helper?: ReactNode
  /** Lets a typeface row show its value set in the face itself. */
  valueStyle?: React.CSSProperties
}) {
  return (
    <Row as="label" label={label} helper={helper} className="relative cursor-pointer">
      <span className="pointer-events-none absolute right-[16px] top-[10px] flex min-h-[24px] items-center gap-1">
        <span className={VALUE} style={valueStyle}>{name(value)}</span>
        <ChevronRight className="size-4 rotate-90 opacity-60" aria-hidden="true" />
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onPick(e.target.value as T)}
        className={cn('absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0', RING)}
      >
        {options.map((o) => <option key={o} value={o}>{name(o)}</option>)}
      </select>
    </Row>
  )
}

/** A continuous axis. Label and value on the first line -- "Default" at the
    shipped value, else the percentage -- and the track on its own line under
    them, full width, inside a 44px-tall box so the target is the whole band
    and not a 6px track. background-clip keeps the painted track at 6px. */
export function SliderRow({
  label, value, min, max, step, onChange, format, helper,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  helper?: ReactNode
}) {
  const shown = format ? format(value) : (value === 1 ? 'Default' : `${Math.round(value * 100)}%`)
  return (
    <Row label={label} value={shown} helper={helper}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={shown}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          'mt-[2px] h-[var(--sband-h,44px)] w-full cursor-pointer appearance-none rounded-full py-[calc((var(--sband-h,44px)-6px)/2)]',
          '[background-clip:content-box]',
          TRACK, SLIDER, RING,
        )}
      />
    </Row>
  )
}

/** On or off. A real switch, 44px tall as a row, drawn in ink so it reads in
    every palette. */
export function SwitchRow({
  label, on, onToggle, helper,
}: {
  label: string
  on: boolean
  onToggle: () => void
  helper?: ReactNode
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      data-row=""
      className={cn(
        'flex min-h-[var(--srow-h,44px)] w-full items-center justify-between gap-4 px-[16px] py-[var(--srow-py,10px)] text-left transition-colors',
        WASH, RING, INK,
      )}
    >
      <span className="min-w-0">
        <span className={cn(LABEL, 'block truncate')}>{label}</span>
        {helper && <span className={HELPER}>{helper}</span>}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'relative h-[24px] w-[40px] shrink-0 rounded-full border transition-colors',
          on ? 'bg-[var(--bento-ink)] !border-[var(--bento-ink)]' : cn('bg-transparent', EDGE),
        )}
      >
        <span
          className={cn(
            'absolute top-[3px] size-[16px] rounded-full transition-[left]',
            on ? 'left-[19px] bg-[var(--bento-card)]' : 'left-[3px] bg-[var(--bento-ink)]',
          )}
        />
      </span>
    </button>
  )
}

/* TWO STATES, BOTH SHOWN.

   Sidebar and Focus are not a scale and not a list: they are two shapes of
   screen, and the answer is always one of exactly two. A dropdown for that
   hides one of the two answers behind a tap and asks the reader to remember
   what the other one was called, which is why the row above this one has spent
   its life carrying a comment arguing for a toggle while rendering a select.

   Both names are on screen and the current one is filled. That costs one extra
   word of width and removes the question entirely. Above two options this is
   the wrong control and SelectRow is still the right one, so it refuses rather
   than laying out five segments nobody can read. */
export function SegmentRow<T extends string>({
  label, value, options, name, onPick, helper,
}: {
  label: string
  value: T
  options: readonly T[]
  name: (v: T) => string
  onPick: (v: T) => void
  helper?: ReactNode
}) {
  if (options.length !== 2) {
    return <SelectRow label={label} value={value} options={options} name={name}
                      onPick={onPick} helper={helper} />
  }
  return (
    <Row label={label} helper={helper}>
      <span
        role="group"
        aria-label={label}
        className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full border p-0.5"
      >
        {options.map((o) => {
          const on = o === value
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(o)}
              className={cn(
                'rounded-full px-3 py-1 text-[13px] transition-colors',
                on ? 'bg-foreground text-background font-medium'
                   : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {name(o)}
            </button>
          )
        })}
      </span>
    </Row>
  )
}
