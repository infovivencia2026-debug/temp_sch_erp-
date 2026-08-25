import { useEffect, useRef, useState } from 'react'
import { PanelRight, PanelLeft, PanelTop, PanelBottom, X, Columns2 } from 'lucide-react'
import { MAX_PANES, type Side } from '@/lib/panes'
import { cn } from '@/lib/utils'

export interface MenuTarget {
  path: string
  title: string
  x: number
  y: number
}

const SIDES: { side: Side; label: string; icon: typeof PanelRight }[] = [
  { side: 'right', label: 'Open to the right', icon: PanelRight },
  { side: 'left', label: 'Open to the left', icon: PanelLeft },
  { side: 'up', label: 'Open above', icon: PanelTop },
  { side: 'down', label: 'Open below', icon: PanelBottom },
]

/* The menu behind a right-click on a tab.

   It offers the same four directions whether or not the work area is already
   split, because "split this off to the right" and "add another one to the
   right" are the same intention and a menu that renames itself between them
   makes somebody read it twice. What changes with a split is what else is
   there: a way back to one pane, and — once four are open — four directions
   that say plainly they are full rather than doing nothing when pressed. */
export default function TabMenu({
  target,
  paneCount,
  refuse,
  onSplit,
  onUnsplit,
  onClose,
  onDismiss,
}: {
  target: MenuTarget
  paneCount: number
  /** Why this particular tab cannot be split, if it cannot. Shown on the four
      directions rather than hiding them: a menu that silently loses half its
      items on one tab reads as a bug. */
  refuse?: string
  onSplit: (side: Side) => void
  onUnsplit: () => void
  onClose: () => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)

  /* Measured, then placed. A menu opened against the right edge of the window
     used to run off it — the last two items unreachable, which on a menu whose
     whole purpose is directions is a poor joke. */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPlaced({
      left: Math.min(target.x, window.innerWidth - width - 8),
      top: Math.min(target.y, window.innerHeight - height - 8),
    })
  }, [target.x, target.y])

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onDismiss])

  const full = paneCount >= MAX_PANES
  const blocked = refuse ?? (full ? `${MAX_PANES} max` : undefined)

  return (
    <>
      {/* Dismissal, and nothing else. A right-click elsewhere should open that
          thing's own menu rather than merely closing this one, so the backdrop
          listens for contextmenu too and gets out of the way first. */}
      <div
        className="fixed inset-0 z-50"
        onMouseDown={onDismiss}
        onContextMenu={(e) => { e.preventDefault(); onDismiss() }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={target.title}
        style={{
          left: placed?.left ?? target.x,
          top: placed?.top ?? target.y,
          // Hidden by VISIBILITY rather than by an opacity class: the entrance
          // animation in index.css sets opacity itself, and an animation beats
          // a class, so opacity-0 would not have hidden the unmeasured frame.
          visibility: placed ? undefined : 'hidden',
        }}
        className={cn(
          `fixed z-50 min-w-[13rem] overflow-hidden rounded-[var(--radius-card)] border
           bg-popover p-1 text-popover-foreground shadow-lg`,
          // It arrives rather than appears: see index.css. Until it has been
          // measured it is invisible, so the correction from the raw pointer
          // position to the placed one is never a visible jump.
          // The entrance itself is in index.css, on [role='menu'] — this class
          // is here only to say out loud that the arrival is deliberate.
          'motion-enter',
        )}
      >
        <p className="truncate px-2.5 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          {target.title}
        </p>
        {SIDES.map(({ side, label, icon: Icon }) => (
          <Item
            key={side}
            icon={Icon}
            label={label}
            hint={blocked}
            disabled={!!blocked}
            onSelect={() => onSplit(side)}
          />
        ))}
        <div className="my-1 h-px bg-border" />
        {paneCount > 1 && (
          <Item icon={Columns2} label="Back to one pane" onSelect={onUnsplit} />
        )}
        <Item icon={X} label="Close tab" onSelect={onClose} />
      </div>
    </>
  )
}

function Item({
  icon: Icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon: typeof PanelRight
  label: string
  hint?: string
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        `flex w-full items-center gap-2.5 rounded-[calc(var(--radius-card)-4px)] px-2.5 py-1.5
         text-left text-[13px] transition-colors`,
        disabled ? 'cursor-not-allowed text-muted-foreground/50' : 'hover:bg-accent',
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-muted-foreground">{hint}</span>}
    </button>
  )
}
