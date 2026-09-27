import { useEffect, useRef, useState } from 'react'
import { Sparkles, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui'
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

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open])

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

  const sel = 'h-8 rounded-md border bg-background px-2 text-sm'
  return (
    <div className="relative inline-block" ref={box}>
      <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)} ariaHasPopup="dialog" ariaExpanded={open}>
        <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />{label}
      </Button>
      {open && (
        <div role="dialog" aria-label={label}
          className={`absolute z-50 mt-2 w-[min(92vw,26rem)] rounded-lg border bg-card p-3 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{label}</span>
            <button type="button" className="text-muted-foreground" onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-muted-foreground">Tone
              <select className={sel + ' mt-1 w-full'} value={tone} onChange={(e) => setTone(e.target.value)}>
                {TONES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">Length
              <select className={sel + ' mt-1 w-full'} value={length} onChange={(e) => setLength(e.target.value)}>
                {LENGTHS.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">Language
              <select className={sel + ' mt-1 w-full'} value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
                {(Object.keys(LANG_LABEL) as Lang[]).map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
              </select>
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
        </div>
      )}
    </div>
  )
}
