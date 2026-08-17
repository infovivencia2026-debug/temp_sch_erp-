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
}

interface ToastApi {
  /** Confirm something happened. Name it; "Saved" tells nobody anything. */
  ok: (message: string, undo?: () => void) => void
  error: (message: string) => void
}

const Ctx = createContext<ToastApi>({ ok: () => {}, error: () => {} })

export const useToast = () => useContext(Ctx)

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])

  const push = useCallback((kind: Kind, message: string, undo?: () => void) => {
    const id = Date.now() + Math.random()
    setItems((prev) => [...prev.slice(-2), { id, kind, message, undo }])
  }, [])

  const api: ToastApi = {
    ok: useCallback((m: string, u?: () => void) => push('ok', m, u), [push]),
    error: useCallback((m: string) => push('error', m), [push]),
  }

  const dismiss = (id: number) => setItems((prev) => prev.filter((t) => t.id !== id))

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* aria-live so the confirmation reaches a screen reader too; a visual
          flash is not feedback for everyone. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {items.map((t) => (
          <ToastRow key={t.id} t={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  )
}

function ToastRow({ t, onDismiss }: { t: Toast; onDismiss: () => void }) {
  useEffect(() => {
    // Errors stay. A confirmation has done its job in four seconds; an error
    // that vanishes before it is read will simply happen again.
    if (t.kind === 'error') return
    const id = setTimeout(onDismiss, 4000)
    return () => clearTimeout(id)
  }, [t.kind, onDismiss])

  return (
    <div
      role={t.kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-md border px-3 py-2.5',
        'bg-card text-[14px] shadow-pop',
        t.kind === 'error' ? 'border-destructive/30' : 'border-success/30',
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
