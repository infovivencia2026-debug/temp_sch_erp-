import { useEffect, useState } from 'react'
import { CloudOff, RefreshCw, X } from 'lucide-react'
import { discard, flush, subscribe, type Queued } from '@/lib/outbox'

/* WHAT IS WAITING TO BE SENT, WHERE SOMEBODY CAN SEE IT.

   A queue nobody can see is worse than no queue. The person pressed save, the
   screen did not say it failed, and nothing they can find says it has not
   happened yet either — so they either assume it went through and it silently
   did not for a week, or they do it a second time on another device. Both are
   the outcome the queue was built to prevent.

   So it shows itself whenever anything is waiting, and stops as soon as
   nothing is. Not a badge on a screen they would have to go looking for: the
   whole premise is that they have moved on to something else.

   It is deliberately not a modal and not an error. Nothing has gone wrong —
   this is the product working as designed on a bad line — and dressing it in
   red would teach people to fear a state they will be in every week. */
export default function Outbox() {
  const [rows, setRows] = useState<Queued[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => subscribe(setRows), [])

  const waiting = rows.filter((r) => !r.sent_at)
  /* An answered-but-refused write still needs somebody. It is not waiting for
     the network; it is waiting for a decision. */
  const refused = rows.filter((r) => r.sent_at && r.status && r.status >= 400)

  if (!waiting.length && !refused.length) return null

  return (
    <div className="fixed bottom-[88px] left-1/2 z-40 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 sm:bottom-6 sm:left-6 sm:translate-x-0">
      <div className="overflow-hidden rounded-[14px] border bg-card shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-[44px] w-full items-center gap-3 px-4 text-left"
        >
          <CloudOff className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-[13px]">
            {waiting.length > 0 ? (
              <>
                <strong className="font-semibold">
                  {waiting.length} {waiting.length === 1 ? 'change' : 'changes'}
                </strong>{' '}
                saved on this device
              </>
            ) : (
              <>
                <strong className="font-semibold">{refused.length}</strong>{' '}
                {refused.length === 1 ? 'change was' : 'changes were'} not accepted
              </>
            )}
          </span>
          {waiting.length > 0 && (
            <RefreshCw
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation()
                void flush()
              }}
            />
          )}
        </button>

        {open && (
          <ul className="max-h-[40vh] overflow-y-auto border-t">
            {[...waiting, ...refused].map((r) => (
              <li key={r.id} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  {/* The person's own words for what they did, when the screen
                      that queued it bothered to say. The method and path are
                      the fallback, and they are a fallback: "POST
                      /api/v1/payments" is not what anybody pressed. */}
                  <p className="truncate text-[13px]">
                    {r.label ?? `${r.method} ${r.path}`}
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {r.sent_at
                      ? (r.last_error || 'Refused by the server.')
                      : `Waiting for a connection${r.attempts > 1 ? ` · tried ${r.attempts} times` : ''}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => discard(r.id)}
                  aria-label="Discard this change"
                  className="grid h-[36px] w-[36px] shrink-0 place-items-center rounded-[8px] text-muted-foreground hover:bg-muted"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
