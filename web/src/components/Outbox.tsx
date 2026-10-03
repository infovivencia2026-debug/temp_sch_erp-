import { useEffect, useState } from 'react'
import { AlertCircle, Check, Clock, CloudOff } from 'lucide-react'
import { discard, flush, retry, stateOf, subscribe, type Queued, type OutboxState } from '@/lib/outbox'
import { useOpenState } from '@/lib/motion'
import { Button } from '@/components/ui'

/* WHAT IS WAITING TO BE SENT, WHERE SOMEBODY CAN SEE IT.

   A queue nobody can see is worse than no queue: the person either assumes it
   went through or does it again on another device. So it shows itself while
   anything is waiting or was refused, each row marked like a chat message:
   a clock while it waits, a tick when the server took it, red when the server
   refused it or its copy had changed first (the server's version stands; the
   row says what the server said), with Retry and Discard. Not a modal and not
   an error: this is the product working on a bad line. */

const ICON: Record<OutboxState, typeof Clock> = { pending: Clock, sent: Check, failed: AlertCircle, conflict: AlertCircle }

function detail(r: Queued, s: OutboxState): string {
  if (s === 'pending') return `Waiting for a connection${r.attempts > 1 ? ` · tried ${r.attempts} times` : ''}`
  if (s === 'sent') return 'Sent'
  if (s === 'conflict') return `Changed on the server first, so the server's version was kept. ${r.last_error ?? ''}`.trim()
  return r.last_error || 'Not accepted by the server'
}

export default function Outbox() {
  const [rows, setRows] = useState<Queued[]>([])
  const [open, setOpen] = useOpenState(false)
  useEffect(() => subscribe(setRows), [])

  const states = rows.map(stateOf)
  const waiting = states.filter((s) => s === 'pending').length
  const refused = states.filter((s) => s === 'failed' || s === 'conflict').length
  if (!waiting && !refused) return null

  return (
    <div className="fixed bottom-[calc(var(--page-foot,88px)+8px)] left-1/2 z-40 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 sm:left-6 sm:translate-x-0" data-testid="outbox">
      <div className="overflow-hidden rounded-[14px] bg-card shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-h-[44px] w-full items-center gap-3 px-4 text-left"
        >
          <CloudOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {waiting > 0
              ? <><strong className="font-semibold">{waiting} {waiting === 1 ? 'change' : 'changes'}</strong> waiting to send</>
              : <><strong className="font-semibold">{refused}</strong> {refused === 1 ? 'change was' : 'changes were'} not accepted</>}
          </span>
        </button>
        {open && (
          <ul className="max-h-[40vh] overflow-y-auto border-t">
            {rows.map((r, i) => {
              const s = states[i]
              const Icon = ICON[s]
              const bad = s === 'failed' || s === 'conflict'
              return (
                <li key={r.id} data-state={s} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
                  <Icon aria-label={s} className={`size-4 shrink-0 ${bad ? 'text-destructive' : s === 'sent' ? 'text-success' : 'text-muted-foreground'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">{r.label ?? describe(r)}</p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">{detail(r, s)}</p>
                  </div>
                  {s === 'pending' && <Button size="sm" variant="ghost" onClick={() => void flush({ force: true })}>Send now</Button>}
                  {bad && <Button size="sm" variant="secondary" onClick={() => retry(r.id)}>Retry</Button>}
                  {s !== 'sent' && <Button size="sm" variant="ghost" onClick={() => discard(r.id)}>Discard</Button>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/* The fallback when the screen gave no label: the area in plain words. */
function describe(r: Queued): string {
  const p = r.path.replace(/^\/api\/v1\//, '')
  if (/attendance/.test(p)) return 'Attendance'
  if (/chat|messages/.test(p)) return 'Message'
  if (/homework|assignments/.test(p)) return 'Homework'
  if (/status/.test(p)) return 'Class status post'
  if (/remarks|notes|diary/.test(p)) return 'Note'
  if (/leave/.test(p)) return 'Leave request'
  if (/lms/.test(p)) return 'Lesson progress'
  return 'Change'
}
