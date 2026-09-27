import { useEffect, useRef, useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui'
import WriteWithAI from './WriteWithAI'
import type { DraftContext, DraftKind } from './aiApi'

/* "Decide with a note": a popover beside a one-click Approve / Reject, for
   when the decision wants a sentence with it. The note can be drafted with
   AI (leave replies, admission decision emails); it goes out only when the
   person presses Approve or Reject here, through the screen's own call. */
export default function DecisionNote({ kind, context, onDecide, pending, approveLabel = 'Approve', rejectLabel = 'Reject', decisions = ['approved', 'rejected'] }: {
  kind: DraftKind
  context: DraftContext
  onDecide: (decision: string, note: string) => void
  pending?: boolean
  approveLabel?: string
  rejectLabel?: string
  decisions?: [string, string]
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [decision, setDecision] = useState(decisions[0])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      // The AI panel is inside this box, so a click in it keeps both open.
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div className="relative inline-block" ref={box}>
      <Button size="sm" variant="ghost" title="Decide with a note" onClick={() => setOpen((o) => !o)} ariaHasPopup="dialog" ariaExpanded={open}>
        <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {open && (
        <div role="dialog" aria-label="Decide with a note" className="absolute right-0 z-40 mt-2 w-[min(92vw,24rem)] rounded-lg border bg-card p-3 text-left shadow-lg">
          <div className="mb-2 flex gap-3 text-sm">
            {decisions.map((d, i) => (
              <label key={d} className="inline-flex items-center gap-1">
                <input type="radio" checked={decision === d} onChange={() => setDecision(d)} />{i === 0 ? approveLabel : rejectLabel}
              </label>
            ))}
          </div>
          <textarea className="w-full rounded-md border bg-background p-2 text-sm" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="A note to go with the decision" />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <WriteWithAI kind={kind} context={{ ...context, decision }} current={note} onInsert={setNote} defaultLength="short" defaultTone="formal" />
            <Button size="sm" pending={pending} tone={decision === decisions[1] ? 'danger' : undefined}
              onClick={() => { onDecide(decision, note.trim()); setOpen(false) }}>
              {decision === decisions[0] ? approveLabel : rejectLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
