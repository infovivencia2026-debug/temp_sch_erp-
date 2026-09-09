import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Inbox, Loader2, X, AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { cx } from '@/lib/utils'

/* ------------------------------------------------------------------ Button */
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
export function Button({
  variant = 'secondary', size = 'md', icon: Icon, className, children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant; size?: 'sm' | 'md'; icon?: React.ComponentType<{ className?: string }>
}) {
  // Pill CTAs, visible but never dominating the composition. The solid action
  // is near-black; mint is an accent, not a fill.
  const styles: Record<BtnVariant, string> = {
    primary: 'bg-ink text-ink-foreground hover:opacity-90 border-transparent',
    secondary: 'bg-transparent hover:bg-accent hover:text-accent-foreground',
    outline: 'bg-transparent hover:bg-accent hover:text-accent-foreground',
    ghost: 'bg-transparent hover:bg-accent hover:text-accent-foreground border-transparent',
    danger: 'bg-destructive text-destructive-foreground hover:opacity-90 border-transparent',
  }
  return (
    <button
      {...rest}
      /* Declares intent, so a read-only region can withhold the calls to
         action that would change a record without knowing their labels. */
      data-variant={variant}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-full border border-border font-medium whitespace-nowrap',
        'transition-all duration-300 ease-premium focus-ring disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' ? 'h-9 px-4 text-[13px]' : 'h-11 px-5 text-[14px]',
        styles[variant], className,
      )}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" />}
      {children}
    </button>
  )
}

/* -------------------------------------------------------------------- Card */
export type Glow = 'indigo' | 'violet' | 'emerald' | 'amber' | 'sky' | 'rose'

export function Card({ className, children, glow, interactive, onClick }: {
  className?: string; children: React.ReactNode; glow?: Glow; interactive?: boolean; onClick?: React.MouseEventHandler<HTMLDivElement>
}) {
  return (
    <div data-glow={glow} onClick={onClick} className={cx('card', interactive && 'bento-interactive', className)}>
      {children}
    </div>
  )
}
export function CardHeader({ title, subtitle, action }: { title: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-6 py-5">
      <div className="min-w-0">
        <h3 className="truncate text-[19px] font-medium tracking-[-0.02em]">{title}</h3>
        {subtitle && <p className="mt-1.5 text-[14px] leading-relaxed muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

/* ------------------------------------------------------------------- Badge */
export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'violet'
export function Badge({ tone = 'slate', children, dot }: { tone?: Tone; children: React.ReactNode; dot?: boolean }) {
  const map: Record<Tone, string> = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25',
    amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25',
    red: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/25',
    blue: 'bg-brand-50 text-brand-700 border-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:border-brand-500/25',
    violet: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/25',
    slate: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-white/5 dark:text-slate-300 dark:border-white/10',
  }
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-5 whitespace-nowrap', map[tone])}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------ Inputs */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...p }, ref) => <input ref={ref} {...p} className={cx('field', className)} />,
)
Input.displayName = 'Input'

export function Textarea(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx('field h-auto py-2 min-h-[84px] resize-y', p.className)} />
}

export function Select({ options, className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: string[] }) {
  return (
    <div className="relative">
      <select {...p} className={cx('field appearance-none pr-8', className)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 muted" />
    </div>
  )
}

export function Field({ label, hint, error, required, children }: { label: string; hint?: string; error?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] font-medium">
        {label} {required && <span className="text-rose-500">*</span>}
      </span>
      {children}
      {error ? <span className="mt-1 block text-[11px] text-rose-600">{error}</span>
        : hint ? <span className="mt-1 block text-[11px] muted">{hint}</span> : null}
    </label>
  )
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <span
        role="checkbox"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked) } }}
        onClick={() => onChange(!checked)}
        className={cx('grid h-4 w-4 place-items-center rounded border transition-colors',
          checked ? 'bg-primary border-primary text-primary-foreground' : 'bg-background border-input')}
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      {label && <span className="text-sm">{label}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cx('relative h-5 w-9 rounded-full transition-colors focus-ring', checked ? 'bg-primary' : 'bg-input')}
      aria-pressed={checked}
    >
      <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
    </button>
  )
}

/* -------------------------------------------------------------- Dropdown */
export function Dropdown({ trigger, items, align = 'right', className }: {
  trigger: React.ReactNode
  items: Array<{ label: string; icon?: React.ComponentType<{ className?: string }>; onClick?: () => void; danger?: boolean } | 'sep'>
  align?: 'left' | 'right'
  /** Applied to the wrapper — a top bar needs it to be able to shrink. */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', esc) }
  }, [])

  /* Place the menu from the trigger's rect, flipping above it when there is
     more room there. Without this a row-action menu on the last row of a table
     opened past the bottom of the screen with nothing able to scroll to it. */
  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos(null); return }
    const place = () => {
      const t = ref.current!.getBoundingClientRect()
      const w = menuRef.current?.offsetWidth ?? 200
      const h = menuRef.current?.offsetHeight ?? 260
      const below = window.innerHeight - t.bottom - 8
      const above = t.top - 8
      const flip = below < Math.min(h, 240) && above > below
      setPos({
        top: flip ? Math.max(8, t.top - Math.min(h, above) - 6) : t.bottom + 6,
        left: Math.min(Math.max(8, align === 'right' ? t.right - w : t.left), window.innerWidth - w - 8),
        maxH: Math.max(140, (flip ? above : below) - 6),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, align])
  return (
    <div className={cx('relative', className)} ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          /* Above the mobile navigation drawer (z-70), not just above a Modal
             (z-60). At z-65 a menu opened from inside the drawer rendered
             behind it, so every tap landed on the drawer instead — which is
             why the interface switcher did nothing on a phone. */
          style={pos
            ? { top: pos.top, left: pos.left, maxHeight: Math.min(pos.maxH, 520) }
            : { visibility: 'hidden', top: 0, left: 0 }}
          className="fixed z-[75] min-w-[200px] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl float p-1 animate-in"
        >
          {items.map((it, i) =>
            it === 'sep' ? <div key={i} className="my-1 h-px bg-border" /> : (
              <button
                key={i}
                onClick={() => { setOpen(false); it.onClick?.() }}
                className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                  /* Tokens, not slate-100: the surface is not always light.
                     With a custom background the menu can be dark while the
                     theme says light, and a near-white hover then put white
                     text on white. --accent tracks whatever the surface is. */
                  it.danger && 'text-rose-600')}
              >
                {it.icon && <it.icon className="h-4 w-4" />}
                {it.label}
              </button>
            ),
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

/** Traps Tab inside an overlay and restores focus to whatever opened it.
 *  Without this, tabbing out of a modal lands you on the page behind it —
 *  invisible to a sighted user, disorienting to a keyboard or screen-reader one. */
function useFocusTrap(open: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    const node = ref.current
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    const first = node?.querySelector<HTMLElement>(sel)
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !node) return
      const items = Array.from(node.querySelectorAll<HTMLElement>(sel)).filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const firstEl = items[0], lastEl = items[items.length - 1]
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus() }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.() }
  }, [open])
  return ref
}

/* ----------------------------------------------------------------- Modal */
export function Modal({ open, onClose, title, subtitle, footer, size = 'md', children }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string
  footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; children?: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open, onClose])
  const trapRef = useFocusTrap(open)
  if (!open) return null
  const w = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size]
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-foreground/30 backdrop-blur-[2px]" onClick={onClose} />
      <div ref={trapRef} className={cx('relative mt-auto w-full float animate-in flex flex-col max-h-[88dvh] sm:mt-0 sm:max-h-[92dvh] rounded-t-2xl sm:rounded-2xl', w)}>
        <div className="flex items-start justify-between gap-3 border-b px-7 py-5">
          <div>
            <h2 className="text-[22px] font-medium tracking-[-0.025em]">{title}</h2>
            {subtitle && <p className="mt-1.5 text-[14px] muted">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 hover:bg-accent focus-ring"><X className="h-4 w-4" /></button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 py-6 sm:px-7">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2.5 border-t px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-7">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/* ---------------------------------------------------------------- Drawer */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-2xl' }: {
  open: boolean; onClose: () => void; title: React.ReactNode; subtitle?: React.ReactNode
  children?: React.ReactNode; footer?: React.ReactNode; width?: string
}) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open, onClose])
  const trapRef = useFocusTrap(open)

  /* On a phone the keyboard covers the lower half of the drawer, taking the
     field being typed into and the Save button with it. Bringing the focused
     field to the middle is what the browser does for a normal page and does
     not do inside a fixed overlay. */
  useEffect(() => {
    if (!open) return
    const node = trapRef.current
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement
      if (!el?.matches?.('input, textarea, select')) return
      setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120)
    }
    node?.addEventListener('focusin', onFocus)
    return () => node?.removeEventListener('focusin', onFocus)
  }, [open])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true"
      aria-label={typeof title === 'string' ? title : 'Details'}>
      <div className="absolute inset-0 bg-foreground/30" onClick={onClose} />
      <div ref={trapRef} className={cx('absolute right-0 top-0 h-[100dvh] w-full float flex flex-col animate-slideL', width)}>
        <div className="flex items-start justify-between gap-3 border-b px-7 py-5">
          <div className="min-w-0">
            <div className="truncate text-[22px] font-medium tracking-[-0.025em]">{title}</div>
            {subtitle && <div className="mt-1.5 text-[14px] muted">{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 hover:bg-accent focus-ring"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && (
          <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2.5 border-t bg-[hsl(var(--card))] px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-7">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ Tabs */
export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string; count?: number }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="scroll-x border-b">
      <div className="flex min-w-max gap-0.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={cx('relative whitespace-nowrap px-4 py-4 text-[14px] transition-colors duration-300 ease-premium',
              value === t.id ? 'font-medium text-foreground' : 'muted hover:text-foreground')}
          >
            {t.label}
            {typeof t.count === 'number' && (
              <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px]">{t.count}</span>
            )}
            {value === t.id && <span className="absolute inset-x-3 -bottom-px h-px bg-foreground" />}
          </button>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- Progress */
export function Progress({ value, tone = 'brand', className }: { value: number; tone?: 'brand' | 'green' | 'amber' | 'red'; className?: string }) {
  const bar = { brand: 'bg-primary', green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-rose-500' }[tone]
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className={cx('h-full rounded-full transition-all', bar)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

/* -------------------------------------------------- Skeleton / states */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-muted', className)} />
}

export function TableSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="p-3 space-y-2">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cx('h-6', c === 0 ? 'w-40' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function EmptyState({ title, hint, action, icon: Icon = Inbox }: {
  title: string; hint?: string; action?: React.ReactNode; icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-xl bg-muted"><Icon className="h-5 w-5 muted" /></div>
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-xs muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorState({ title = 'Could not load this section', onRetry }: { title?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-xl bg-rose-50 dark:bg-rose-500/10"><AlertTriangle className="h-5 w-5 text-rose-600" /></div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs muted">The mock service returned an unexpected response.</p>
      {onRetry && <Button size="sm" className="mt-2" onClick={onRetry}>Retry</Button>}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-4 w-4 animate-spin', className)} />
}

/* ----------------------------------------------------------------- Toast */
/* An `action` turns a toast from a notice into the only way back. That changes
   what it owes the reader: it has to stay long enough to be noticed and
   reached, and it must not disappear while the pointer is on it. */
type Toast = {
  id: number
  title: string
  desc?: string
  tone: 'success' | 'error' | 'info'
  action?: { label: string; onClick: () => void }
}
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<Toast[]>([])
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  const drop = (id: number) => {
    clearTimeout(timers.current[id])
    delete timers.current[id]
    setList((l) => l.filter((x) => x.id !== id))
  }

  const push = useMemo(() => (t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random()
    setList((l) => [...l, { ...t, id }])
    /* Eight seconds when something can be undone, against the usual three and
       a half. Three seconds is ample to read "deleted" and nowhere near enough
       to notice it, decide it was a mistake, and reach the button. */
    const life = t.action ? 8000 : 3600
    timers.current[id] = setTimeout(() => drop(id), life)
  }, [])

  /* Hovering means still reading, or on the way to the button. Either way the
     countdown should not run out underneath the pointer. */
  const hold = (id: number) => clearTimeout(timers.current[id])
  const resume = (id: number, hasAction: boolean) => {
    timers.current[id] = setTimeout(() => drop(id), hasAction ? 4000 : 2000)
  }
  const Icon = { success: CheckCircle2, error: AlertTriangle, info: Info }
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/* Announced, because an undo nobody hears about is not an undo. */}
      <div role="status" aria-live="polite"
        className="fixed left-1/2 top-4 z-[80] flex w-[min(92vw,360px)] -translate-x-1/2 flex-col gap-2 no-print sm:left-auto sm:right-4 sm:top-auto sm:bottom-4 sm:translate-x-0">
        {list.map((t) => {
          const I = Icon[t.tone]
          return (
            <div
              key={t.id}
              onPointerEnter={() => hold(t.id)}
              onPointerLeave={() => resume(t.id, !!t.action)}
              className="flex items-start gap-2.5 rounded-xl float px-3.5 py-3 animate-in"
            >
              <I className={cx('h-4 w-4 mt-0.5 shrink-0',
                t.tone === 'success' ? 'text-emerald-600' : t.tone === 'error' ? 'text-rose-600' : 'text-brand-600')} />
              <div className="min-w-0">
                <p className="text-sm font-medium">{t.title}</p>
                {t.desc && <p className="text-xs muted mt-0.5">{t.desc}</p>}
              </div>
              {t.action && (
                <button
                  onClick={() => { t.action!.onClick(); drop(t.id) }}
                  className="ml-auto shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-[hsl(var(--primary))] underline-offset-2 hover:bg-accent focus-ring"
                >
                  {t.action.label}
                </button>
              )}
              <button aria-label="Dismiss"
                className={cx('shrink-0 muted hover:opacity-70', !t.action && 'ml-auto')}
                onClick={() => drop(t.id)}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastCtx.Provider>
  )
}

/* ---------------------------------------------------------- Confirm dialog */
export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Delete' }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; message: string; confirmLabel?: string
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={() => { onConfirm(); onClose() }}>{confirmLabel}</Button>
      </>}>
      <p className="text-sm muted">{message}</p>
    </Modal>
  )
}

/* -------------------------------------------------------------- Avatar */
export function Avatar({ name, size = 32, tone }: { name: string; size?: number; tone?: string }) {
  const palette = ['bg-brand-100 text-brand-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-700', 'bg-violet-100 text-violet-700', 'bg-rose-100 text-rose-700']
  const idx = name.charCodeAt(0) % palette.length
  const ini = name.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase()
  return (
    <span
      className={cx('inline-grid shrink-0 place-items-center rounded-full font-semibold dark:bg-white/10 dark:text-white', tone || palette[idx])}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >{ini}</span>
  )
}
