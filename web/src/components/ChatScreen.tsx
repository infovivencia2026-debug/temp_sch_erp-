import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft } from 'lucide-react'
import { useOverlayHistory } from '@/lib/overlay-history'

/* A conversation that takes the whole screen.

   The way a phone does it: the list of conversations is one screen, and
   opening one replaces everything -- header, sidebar, dock, the list -- with
   the chat alone and a back arrow. Nothing else competes for the thumb,
   and the composer sits at the bottom edge where the keyboard meets it.

   Drawn over the app in a portal rather than by hiding the chrome piece by
   piece, so no layout has to know about it. Back (the arrow, the browser's
   own Back, Escape) closes it and the list underneath is exactly as it was:
   useOverlayHistory pushes a history entry on open for that. */
export function ChatScreen({
  open,
  title,
  subtitle,
  onBack,
  actions,
  children,
}: {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  onBack: () => void
  /** Buttons for the right of the top bar. */
  actions?: ReactNode
  children: ReactNode
}) {
  const back = useOverlayHistory(open, onBack)

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') back()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, back])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex flex-col bg-background"
      role="dialog"
      aria-modal="true"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-background px-1.5 py-1.5 sm:px-3">
        <button
          type="button"
          onClick={back}
          aria-label="Back"
          title="Back"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold leading-tight">{title}</div>
          {subtitle && <div className="truncate text-[12.5px] text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>,
    document.body,
  )
}
