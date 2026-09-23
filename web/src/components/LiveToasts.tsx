import { MessageSquare, X } from 'lucide-react'
import { dismissToast, goTo, useLiveToasts } from '@/lib/live-stream'

/* THE CARD IN THE CORNER WHEN A MESSAGE LANDS SOMEWHERE ELSE.

   Drawn only for a conversation that is not on screen (lib/live-stream.ts
   decides); tapping it opens that conversation and the card goes. It is the
   in-app half of the notification; the phone's own notification is the other
   half, for when the app is not in front. Bottom-right on a desk, above the
   dock on a phone, never over the composer. */
export function LiveToasts() {
  const toasts = useLiveToasts()
  if (toasts.length === 0) return null
  return (
    <div
      className="pointer-events-none fixed inset-x-3 bottom-[calc(var(--dock-reserve,0px)+12px)] z-[200] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex w-full max-w-[360px] items-start gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-[0_10px_25px_-5px_rgba(0,0,0,0.25)]"
        >
          <button
            type="button"
            onClick={() => { dismissToast(t.id); goTo(t.href) }}
            className="flex min-w-0 flex-1 items-start gap-3 text-left"
          >
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <MessageSquare className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-semibold">{t.title}</span>
              <span className="block truncate text-[12.5px] text-muted-foreground">{t.body}</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}

export default LiveToasts
