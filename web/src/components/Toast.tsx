import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Undo2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/* Did that save?

   Every mutation in the app reported failure and none confirmed success. A
   cashier took a fee, the form cleared, and nothing said whether the money had
   landed — so people re-submitted, and a school ended up with two receipts for
   one payment. Silence after a write is not a neutral choice.

   Deliberately small. One line, bottom of the screen, gone in four seconds and
   never covering an action: an admin panel that celebrates every save with a
   card and an icon becomes noise by Tuesday. Errors stay until dismissed,
   because an error nobody read is an error that will be repeated.

   Confirmations name the thing that happened — "Receipt RCPT/2026-27/0051
   issued", not "Saved" — so it doubles as the record somebody reads back over
   a counter. */

type Kind = 'ok' | 'error'

interface Toast {
  id: number
  kind: Kind
  message: string
  /** Offered only where the action can genuinely be taken back. */
  undo?: () => void
  /** On an error: try the same thing again. */
  retry?: () => void
}

interface ToastApi {
  /** Confirm something happened. Name it; "Saved" tells nobody anything. */
  ok: (message: string, undo?: () => void) => void
  error: (message: string, retry?: () => void) => void
}

const Ctx = createContext<ToastApi>({ ok: () => {}, error: () => {} })

export const useToast = () => useContext(Ctx)

/* THE SAME BAR, REACHABLE FROM OUTSIDE REACT.

   The API client confirms a save that no screen confirmed (lib/save-feedback
   .ts), and it is not a component. The host registers itself here; the
   timestamp of the last confirmation lets that fallback stay silent when the
   screen has already said something better than "Saved". */
let bus: ToastApi | null = null
let lastOkAt = 0
export function toastBus(): ToastApi | null {
  return bus
}
export function lastConfirmationAt(): number {
  return lastOkAt
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])

  const push = useCallback((kind: Kind, message: string, undo?: () => void, retry?: () => void) => {
    const id = Date.now() + Math.random()
    if (kind === 'ok') lastOkAt = Date.now()
    /* One confirmation on screen at a time: a new one replaces the last
       rather than stacking, and the same words twice in a row are not shown
       again. Errors still queue, up to three. */
    setItems((prev) => {
      if (kind === 'ok') {
        const errs = prev.filter((t) => t.kind !== 'ok')
        const cur = prev.find((t) => t.kind === 'ok')
        if (cur && cur.message === message && !undo) return prev
        return [...errs, { id, kind, message, undo }]
      }
      return [...prev.slice(-2), { id, kind, message, undo, retry }]
    })
  }, [])

  const api: ToastApi = {
    ok: useCallback((m: string, u?: () => void) => push('ok', m, u), [push]),
    error: useCallback((m: string, r?: () => void) => push('error', m, undefined, r), [push]),
  }
  useEffect(() => {
    bus = api
    return () => { bus = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.ok, api.error])

  const dismiss = (id: number) => setItems((prev) => prev.filter((t) => t.id !== id))

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* aria-live so the confirmation reaches a screen reader too; a visual
          flash is not feedback for everyone. */}
      {/* A confirmation lands in the middle of the screen, on glass, and is
          gone in two seconds: the eye is on the button that was just pressed,
          not the bottom corner. Errors keep the corner and stay until read. */}
      <div aria-live="polite" className="pointer-events-none fixed inset-0 z-[70] grid place-items-center p-4">
        {items.filter((t) => t.kind === 'ok').map((t) => (
          <ToastRow key={t.id} t={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
      <div
        aria-live="assertive"
        /* Above the Bento dock and the phone's home indicator, not on them.
           Pinned to bottom-0 an error sat across Home and Search in the dock
           until it was dismissed. The dock reserve is what `main` already
           leaves for the dock (Shell), safe-area inset included. */
        className="pointer-events-none fixed inset-x-0 bottom-[var(--dock-reserve,0px)] z-[70] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {items.filter((t) => t.kind === 'error').map((t) => (
          <ToastRow key={t.id} t={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
      <style>{glassCSS}</style>
    </Ctx.Provider>
  )
}

function ToastRow({ t, onDismiss }: { t: Toast; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    // Errors stay. A confirmation has done its job in a couple of seconds; an
    // error that vanishes before it is read will simply happen again. Hovering
    // a confirmation holds it, so an Undo is never snatched away mid-reach.
    if (t.kind === 'error' || paused) return
    /* A plain confirmation: the tick draws (~450ms), holds half a second,
       then fades over 350ms (.toast-square) and is removed. */
    const id = setTimeout(onDismiss, t.undo ? 4000 : t.kind === 'ok' ? 1300 : 2400)
    return () => clearTimeout(id)
  }, [t.kind, t.undo, onDismiss, paused])

  if (t.kind === 'ok') return <Confirmation t={t} onDismiss={onDismiss} paused={paused} setPaused={setPaused} />

  return (
    <div
      role={t.kind === 'error' ? 'alert' : 'status'}
      className={cn(
        /* Comes up off the bottom edge the host is pinned to, rather than
           being there on the next paint. See .toast-in in index.css. */
        t.kind === 'error'
          ? 'toast-in pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-md border border-destructive/30 bg-card px-3 py-2.5 text-[14px] shadow-pop'
          : 'toast-glass pointer-events-auto flex max-w-sm items-center gap-2.5 rounded-xl border px-4 py-3 text-[14px] font-medium',
      )}
    >
      <span
        className={cn(
          'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full',
          t.kind === 'error' ? 'text-destructive' : 'text-success',
        )}
      >
        {t.kind === 'error' ? (
          <AlertTriangle className="h-4 w-4" />
        ) : (
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        )}
      </span>
      <p className="min-w-0 flex-1">{t.message}</p>
      {t.undo && (
        <button
          type="button"
          onClick={() => {
            t.undo?.()
            onDismiss()
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[13px] font-medium text-primary hover:bg-accent"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
      )}
      {t.retry && (
        <button
          type="button"
          onClick={() => {
            t.retry?.()
            onDismiss()
          }}
          className="shrink-0 rounded-sm px-1.5 py-0.5 text-[13px] font-medium text-primary hover:bg-accent"
        >
          Retry
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/* THE CONFIRMATION, IN THE SCHOOL'S OWN COLOUR.

   It used to be a grey slab with a small green tick: the one moment in the
   product that answers "did that work?", drawn in a colour that belongs to no
   palette. Now the tick sits in a disc of the school's accent and draws
   itself, a soft ring leaves the disc once, and a hairline along the foot
   counts down to when it goes (held while the pointer is on it). Under
   reduced motion all of that is still: the disc, the tick and the words. */
function Confirmation({ t, onDismiss, paused, setPaused }: {
  t: Toast; onDismiss: () => void; paused: boolean; setPaused: (p: boolean) => void
}) {
  const ms = t.undo ? 4000 : 2400
  if (!t.undo) {
    /* 1:1. A square of glass, the tick in the accent disc, the words under it. */
    return (
      <div role="status" className="toast-glass toast-confirm toast-square pointer-events-auto grid aspect-square w-[132px] place-content-center justify-items-center gap-2.5 rounded-[28px] border p-3 text-center text-[13.5px] font-medium">
        <span className="toast-mark relative grid h-11 w-11 place-items-center rounded-full" aria-hidden="true">
          <span className="toast-ripple absolute inset-0 rounded-full" />
          <svg viewBox="0 0 24 24" className="relative h-6 w-6" fill="none" stroke="currentColor"
               strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <path className="toast-tick" d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        <p className="line-clamp-2 leading-snug">{t.message}</p>
      </div>
    )
  }
  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="toast-glass toast-confirm pointer-events-auto relative flex max-w-sm items-center gap-3 overflow-hidden rounded-2xl border py-3 pl-3 pr-3.5 text-[14px] font-medium"
      style={{ ['--toast-ms' as string]: `${ms}ms` }}
    >
      <span className="toast-mark relative grid h-8 w-8 shrink-0 place-items-center rounded-full" aria-hidden="true">
        <span className="toast-ripple absolute inset-0 rounded-full" />
        <svg viewBox="0 0 24 24" className="relative h-[18px] w-[18px]" fill="none" stroke="currentColor"
             strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <path className="toast-tick" d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
      <p className="min-w-0 flex-1 leading-snug">{t.message}</p>
      {t.undo && (
        <button
          type="button"
          onClick={() => { t.undo?.(); onDismiss() }}
          className="toast-undo inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-surface-hover hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <span className="toast-timer absolute inset-x-0 bottom-0 h-[2px] origin-left" data-paused={paused ? '' : undefined} aria-hidden="true" />
    </div>
  )
}

/* The glass the confirmation sits on. backdrop-filter where the browser has
   it; a plain card where it does not (the old phones this runs on), so the
   words never sit on a see-through nothing. */
const glassCSS = `
.toast-glass { background: hsl(var(--popover) / 0.84); border-color: hsl(var(--border)); color: hsl(var(--foreground));
  box-shadow: var(--lift-float, 0 12px 32px rgba(0,0,0,0.18));
  -webkit-backdrop-filter: blur(14px) saturate(1.2); backdrop-filter: blur(14px) saturate(1.2);
  animation: toast-pop 160ms cubic-bezier(.2,.9,.3,1.15); }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .toast-glass { background: hsl(var(--popover)); }
}
@keyframes toast-pop { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .toast-glass { animation: none; } }

/* The accent the confirmation speaks in: --sel-strong where Settings defines
   it (a contrast-checked accent for text), otherwise the theme's primary. */
.toast-confirm { --tc: var(--sel-strong, hsl(var(--primary))); }
.toast-mark { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
.toast-ripple { border: 2px solid var(--tc); opacity: 0; animation: toast-ripple 700ms ease-out 120ms 1 both; }
.toast-tick { stroke-dasharray: 24; stroke-dashoffset: 24; animation: toast-draw 360ms cubic-bezier(.3,.8,.3,1) 90ms forwards; }
.toast-undo { color: var(--tc); background: color-mix(in srgb, var(--tc) 12%, transparent); }
.toast-undo:hover { background: color-mix(in srgb, var(--tc) 20%, transparent); }
.toast-timer { background: var(--tc); opacity: .55; animation: toast-timer var(--toast-ms) linear forwards; }
.toast-timer[data-paused] { animation-play-state: paused; }
@keyframes toast-draw { to { stroke-dashoffset: 0; } }
.toast-square { animation: toast-pop 160ms cubic-bezier(.2,.9,.3,1.15), toast-fade 350ms ease 950ms forwards; }
@keyframes toast-fade { to { opacity: 0; transform: scale(.96); } }
@keyframes toast-ripple { 0% { opacity: .55; transform: scale(1); } 100% { opacity: 0; transform: scale(1.9); } }
@keyframes toast-timer { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) {
  .toast-tick { animation: none; stroke-dashoffset: 0; }
  .toast-ripple { animation: none; }
  .toast-timer { animation: none; opacity: 0; }
  .toast-square { animation: toast-fade 350ms ease 950ms forwards; }
}
`
