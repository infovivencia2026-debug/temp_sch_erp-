import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui'
import { useAnchoredPosition } from '@/components/anchored'
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
  const panel = useRef<HTMLDivElement>(null)
  /* Portalled and placed against the viewport (anchored.ts): drawn absolute
     inside a table row it was clipped by the table's scroller, and
     right-aligned to a button near the left of a phone it opened off the
     screen. */
  const place = useAnchoredPosition(open, box, panel, { align: 'end', width: 384 })
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      // The AI panel opens from inside this one (as a sheet of its own on a
      // phone), so a press in any anchored panel keeps both open.
      if (box.current?.contains(t) || panel.current?.contains(t) || t.closest?.('[data-anchored-panel]')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div className="relative inline-block" ref={box}>
      <Button size="sm" variant="ghost" title="Decide with a note" onClick={() => setOpen((o) => !o)} ariaHasPopup="dialog" ariaExpanded={open}>
        <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {open && createPortal(
        <div ref={panel} data-anchored-panel="" role="dialog" aria-label="Decide with a note" style={place}
          className="z-[200] rounded-lg border bg-card p-3 text-left shadow-lg">
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
        </div>,
        document.body,
      )}
    </div>
  )
}
