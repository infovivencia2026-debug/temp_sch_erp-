import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PickerMenu } from '@/components/PickerMenu'
import { createPortal } from 'react-dom'
import { Sparkles, RefreshCw, X } from 'lucide-react'
import { Button, Dialog } from '@/components/ui'
import { usePhone } from '@/lib/viewport'
import { useAnchoredPosition } from '@/components/anchored'
import { aiApi, AiLabel, LANG_LABEL, type DraftContext, type DraftKind, type Lang } from './aiApi'

/* "Write with AI": a button that opens a small panel (tone, length,
   language, optional points to cover), asks the server for two drafts built
   from the records the caller may see, and hands the chosen one to the
   screen's own editor through onInsert. It never saves or sends: the person
   edits the text and saves or sends it the way the screen always did.

   <WriteWithAI kind="report_remark" context={{ student_id }} current={text} onInsert={setText} /> */

const TONES = ['warm', 'formal', 'neutral', 'encouraging', 'firm'] as const
const LENGTHS = ['short', 'medium', 'long'] as const
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Could not write a draft just now.')

export default function WriteWithAI({
  kind, context, current, onInsert, label = 'Write with AI', defaultTone = 'warm', defaultLength = 'medium', align = 'left',
}: {
  kind: DraftKind
  context?: DraftContext
  /** The text already in the editor; the model improves on it. */
  current?: string
  /** Called with the chosen draft. The screen puts it in its editor. */
  onInsert: (text: string) => void
  label?: string
  defaultTone?: typeof TONES[number]
  defaultLength?: typeof LENGTHS[number]
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [tone, setTone] = useState<string>(defaultTone)
  const [length, setLength] = useState<string>(defaultLength)
  const [language, setLanguage] = useState<Lang>('en')
  const [notes, setNotes] = useState('')
  const [drafts, setDrafts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const phone = usePhone()
  /* On a desk the panel is portalled too: a card pressed on the way here
     scales on :active, and a transformed ancestor would re-anchor a fixed
     panel to the card. On a phone it is the shared Dialog's bottom sheet
     (scrim, grab bar, Back closes it, focus trap). */
  const sheet = (node: ReactNode) => createPortal(node, document.body)
  /* On a desk the panel is anchored to its button in viewport coordinates
     (anchored.ts) rather than drawn absolute inside whatever card holds the
     button, which clipped it or let it run off the bottom of the screen. */
  const place = useAnchoredPosition(open && !phone, box, panel, { align: align === 'right' ? 'end' : 'start', width: 416, maxHeight: 560 })

  useEffect(() => {
    // On a phone the Dialog owns Escape and the outside tap.
    if (!open || phone) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (box.current && !box.current.contains(t) && !panel.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open, phone])

  const generate = async () => {
    setBusy(true); setError(null)
    try {
      const r = await aiApi.draft({ kind, ...(context ?? {}), tone, length, language, notes: notes || undefined, current: current || undefined, variants: 2 })
      if (!r.configured) { setDrafts([]); setError(r.message ?? 'AI writing is not switched on.'); return }
      setDrafts(r.drafts)
      if (r.drafts.length === 0) setError('The AI returned nothing usable. Try again or change the options.')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = 'mt-1 w-full justify-between'
  const controls = (
    <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs text-muted-foreground">Tone
              <PickerMenu ariaLabel="Tone" align="start" className={pick} menuClassName="z-[220]" value={tone} onChange={setTone}
                options={TONES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))} />
            </label>
            <label className="text-xs text-muted-foreground">Length
              <PickerMenu ariaLabel="Length" align="start" className={pick} menuClassName="z-[220]" value={length} onChange={setLength}
                options={LENGTHS.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))} />
            </label>
            <label className="text-xs text-muted-foreground">Language
              <PickerMenu ariaLabel="Language" align="start" className={pick} menuClassName="z-[220]" value={language} onChange={setLanguage}
                options={(Object.keys(LANG_LABEL) as Lang[]).map((l) => ({ value: l, label: LANG_LABEL[l] }))} />
            </label>
          </div>
          <label className="mt-2 block text-xs text-muted-foreground">Points to cover (optional)
            <textarea className="mt-1 w-full rounded-md border bg-background p-2 text-sm" rows={2} value={notes}
              onChange={(e) => setNotes(e.target.value)} placeholder="e.g. improved in reading, needs to practise tables" />
          </label>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={generate} pending={busy}>
              {drafts.length ? <><RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />Regenerate</> : 'Write drafts'}
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
          {drafts.length > 0 && (
            <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto">
              {drafts.map((d, i) => (
                <li key={i} className="rounded-md border p-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <AiLabel />
                    <Button size="sm" variant="secondary" onClick={() => { onInsert(d); setOpen(false) }}>Insert</Button>
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{d}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">An AI draft from the school's records. Check and edit it; nothing is saved or sent until you do.</p>
    </>
  )
  return (
    <div className="relative inline-block" ref={box}>
      <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)} ariaHasPopup="dialog" ariaExpanded={open}>
        <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />{label}
      </Button>
      {open && phone && (
        <Dialog onClose={() => setOpen(false)} title={label}>
          <div ref={panel}>
          {controls}
          </div>
        </Dialog>
      )}
      {open && !phone && sheet(
        <div role="dialog" aria-label={label} ref={panel} data-anchored-panel=""
          className="z-[210] rounded-lg border bg-card p-3 shadow-lg"
          style={place}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{label}</span>
            <button type="button" className="text-muted-foreground" onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" /></button>
          </div>
          {controls}
        </div>,
      )}
    </div>
  )
}
