import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Eye, MoreHorizontal, PanelRight, Redo2, Send, Undo2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { usePhone } from '@/lib/viewport'
import { buzz } from '@/lib/haptics'
import {
  Badge, Button, Checkbox, Dialog, EmptyState, ErrorState, Field, FormNotice, Input, Loading, Select, Textarea, TAB_BAR, tabClass,
} from '@/components/ui'
import { PickerMenu } from '@/components/PickerMenu'
import { useToast } from '@/components/Toast'
import { Menu } from '@/features/bento/Menu'
import { cloneBox, computeNumbers, findBox, insertBox, mapBox, marksOf, moveBox, walkBoxes, type Box } from './lib/box'
import { readDoc, type PaperDoc, type SchoolHead } from './lib/doc'
import { effectiveStyle, fontStack } from './lib/fonts'
import { paperLabels, PAPER_LANGS, type PaperLang } from './lib/labels'
import { paperFile } from './lib/bundle'
import { PAPER_CSS, printPaper } from './lib/renderHtml'
import { uploadImage, type ImageAsset } from './lib/images'
import { download, safeFileName, uid } from './lib/util'
import { Maker, type MakerContext } from './editor/context'
import BoxCanvas, { type CanvasOps } from './editor/BoxCanvas'
import BoxPanel from './editor/BoxPanel'
import BoxInserter from './editor/BoxInserter'
import FillFromBank from './editor/FillFromBank'
import PaperPreview from './editor/PaperPreview'
import SaveToBank from './editor/SaveToBank'
import StyleEditor from './editor/StyleEditor'
import Toolbar from './editor/Toolbar'
import './lib/fonts-css'
import './qmaker.css'

interface Draft {
  id: string
  title: string
  exam_subject_id: string | null
  /** The class and subject of that exam, for the bank. */
  class_subject_id: string | null
  exam_name: string | null
  class: string | null
  subject: string | null
  max_marks: string | null
  updated_at: string
  sent_status: string | null
  review_note: string | null
  doc: unknown
}

export interface Slot { exam_subject_id: string; exam_name: string; exam_date: string | null; class: string; subject: string; max_marks: string; status: string | null }

/** The letterhead, from the school's own settings. */
export function useSchoolHead(): SchoolHead {
  const s = useSession()
  const i = s.institution
  return { name: i?.display_name || i?.name || '', address: i?.address ?? '', logo: i?.logo_key ?? '' }
}

type SaveState = 'saved' | 'saving' | 'unsaved' | 'error' | 'conflict'

/* Marks per chapter or difficulty: each fixed-marks box counts under the
   nearest chapter or difficulty set on it or above it. */
function distribution(root: Box) {
  const chapter = new Map<string, number>()
  const difficulty = new Map<string, number>()
  const walk = (b: Box, ch?: string, df?: string) => {
    const c = b.meta?.chapter || ch
    const d = b.meta?.difficulty || df
    if (b.marks?.mode === 'fixed') {
      chapter.set(c || 'Not set', (chapter.get(c || 'Not set') ?? 0) + (b.marks.value ?? 0))
      difficulty.set(d || 'Not set', (difficulty.get(d || 'Not set') ?? 0) + (b.marks.value ?? 0))
      return // parts inside a fixed-marks box belong to it
    }
    b.children?.forEach((k) => walk(k, c, d))
  }
  walk(root)
  const rows = (m: Map<string, number>) => [...m].map(([label, marks]) => ({ label, marks })).sort((a, b) => b.marks - a.marks)
  return { chapter: rows(chapter), difficulty: rows(difficulty) }
}

function Split({ title, rows }: { title: string; rows: { label: string; marks: number }[] }) {
  const total = rows.reduce((s, r) => s + r.marks, 0)
  if (!rows.length || !total) return null
  return (
    <section className="qm-panel">
      <h3 className="qm-panel-h">{title}</h3>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="space-y-1">
            <div className="flex justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate capitalize">{r.label}</span>
              <span className="tabular-nums text-muted-foreground">{r.marks} ({Math.round((r.marks / total) * 100)}%)</span>
            </div>
            <div className="qm-meter" aria-hidden="true"><div style={{ transform: `scaleX(${r.marks / total})` }} /></div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* Sending: the frozen copy goes to the head of department for the chosen
   exam paper. Exams already approved are not offered; one sent and waiting
   is, and is replaced. */
function SendDialog({ draft, doc, slots, onClose, onSent }: { draft: Draft; doc: PaperDoc; slots: Slot[]; onClose: () => void; onSent: () => void }) {
  const open = slots.filter((s) => s.status !== 'approved')
  const [slot, setSlot] = useState(draft.exam_subject_id && open.some((s) => s.exam_subject_id === draft.exam_subject_id) ? draft.exam_subject_id : '')
  const [notes, setNotes] = useState('')
  const chosen = open.find((s) => s.exam_subject_id === slot)
  const total = marksOf(doc.body)
  const send = useMutation({
    mutationFn: () => api.post(`/api/v1/exams/paper-drafts/${draft.id}/send`, { exam_subject_id: slot, notes }),
    onSuccess: () => { buzz('tap'); onSent() },
  })
  return (
    <Dialog
      title="Send for approval"
      description="Your head of department reads it and approves it or sends it back. What they read is this paper as it is now; changing it later does not change what was sent."
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button needsNetwork disabled={!slot || send.isPending} pending={send.isPending} onClick={() => send.mutate()}>Send for approval</Button>
      </>}
    >
      <div className="space-y-4">
        {open.length === 0 ? (
          <EmptyState title="No exam paper to send this for." body="The office has not scheduled an exam for your classes, or every one already has an approved paper." />
        ) : (
          <Field label="For which exam paper" required>
            <Select value={slot} onChange={setSlot} placeholder="Choose"
              options={open.map((s) => ({ value: s.exam_subject_id, label: `${s.class} · ${s.subject} · ${s.exam_name}${s.status === 'submitted' ? ' (replaces the one waiting)' : ''}` }))} />
          </Field>
        )}
        {chosen && Number(chosen.max_marks) > 0 && Number(chosen.max_marks) !== total && (
          <FormNotice error={`This paper adds up to ${total} marks; the exam is out of ${chosen.max_marks}.`} />
        )}
        <Field label="Anything the reader should know" hint="Optional.">
          <Textarea rows={2} value={notes} onChange={setNotes} placeholder="Covers units 1 to 4." />
        </Field>
        <FormNotice error={send.error} />
      </div>
    </Dialog>
  )
}

export default function PaperEditor({ id, slots, onBack }: { id: string; slots: Slot[]; onBack: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const school = useSchoolHead()
  const q = useQuery({ queryKey: ['paper-draft', id], queryFn: () => api.get<Draft>(`/api/v1/exams/paper-drafts/${id}`), staleTime: Infinity, gcTime: 0 })

  const [doc, setDocState] = useState<PaperDoc | null>(null)
  const base = useRef('')
  const docRef = useRef<PaperDoc | null>(null)
  const [save, setSave] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<unknown>(null)
  const past = useRef<PaperDoc[]>([])
  const future = useRef<PaperDoc[]>([])
  const lastPush = useRef(0)
  const [, tick] = useState(0)

  useEffect(() => {
    if (q.data && !docRef.current) {
      const d = readDoc(q.data.doc)
      base.current = q.data.updated_at
      docRef.current = d
      setDocState(d)
    }
  }, [q.data])

  /* Every change goes through here: it joins the undo history (typing within
     a second is one step) and marks the paper for saving. */
  const update = useCallback((fn: (d: PaperDoc) => PaperDoc) => {
    const prev = docRef.current
    if (!prev) return
    const next = fn(prev)
    if (next === prev) return
    const now = Date.now()
    if (now - lastPush.current > 1000) {
      past.current.push(prev)
      if (past.current.length > 200) past.current.shift()
    }
    lastPush.current = now
    future.current = []
    docRef.current = next
    setDocState(next)
    setSave((s) => (s === 'conflict' ? s : 'unsaved'))
  }, [])
  const travel = (from: typeof past, to: typeof past) => {
    const target = from.current.pop()
    if (!target || !docRef.current) return
    to.current.push(docRef.current)
    lastPush.current = 0
    docRef.current = target
    setDocState(target)
    setSave((s) => (s === 'conflict' ? s : 'unsaved'))
    tick((n) => n + 1)
  }
  const undo = () => travel(past, future)
  const redo = () => travel(future, past)

  /* Saved on its own a moment after the last change. The server refuses a
     save from a window that is behind (another tab saved in between), and
     that is said plainly rather than overwriting the other window's work. */
  const saving = useRef(false)
  const flush = useCallback(async () => {
    const d = docRef.current
    if (!d || saving.current) return
    saving.current = true
    setSave('saving')
    try {
      const r = await api.put<{ updated_at: string }>(`/api/v1/exams/paper-drafts/${id}`, { doc: d, title: d.examName, base_updated_at: base.current })
      base.current = r.updated_at
      setSaveError(null)
      setSave(docRef.current === d ? 'saved' : 'unsaved')
      qc.invalidateQueries({ queryKey: ['paper-drafts'] })
    } catch (e) {
      setSaveError(e)
      setSave(e instanceof ApiError && e.status === 409 ? 'conflict' : 'error')
    } finally {
      saving.current = false
    }
  }, [id, qc])
  useEffect(() => {
    if (save !== 'unsaved') return
    const t = setTimeout(flush, 800)
    return () => clearTimeout(t)
  }, [save, doc, flush])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (save !== 'saved') e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [save])

  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'paper' | 'box'>('paper')
  const [side, setSide] = useState(false)
  const [inserter, setInserter] = useState<{ parentId: string; index: number } | null>(null)
  const [filling, setFilling] = useState(false)
  const [banking, setBanking] = useState<Box | null>(null)
  const [preview, setPreview] = useState(false)
  const [sending, setSending] = useState(false)
  const [more, setMore] = useState(false)
  const moreAt = useRef<HTMLSpanElement>(null)
  // On a phone the settings open as a sheet over the paper; on a desk, beside it.
  const phone = usePhone()

  const select = (bid: string | null) => { setSelected(bid); setTab(bid ? 'box' : 'paper') }
  const setBody = (fn: (b: Box) => Box) => update((d) => ({ ...d, body: fn(d.body) }))
  const remove = (bid: string) => { setBody((r) => mapBox(r, bid, () => null)); if (selected === bid) select(null) }
  const remember = useCallback((assets: ImageAsset[]) => update((d) => ({ ...d, images: { ...d.images, ...Object.fromEntries(assets.map((a) => [a.id, a])) } })), [update])

  // Ctrl+Z and Ctrl+Y for the whole paper; Delete removes the selected box when the cursor is not in text.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [role="dialog"]')
      if ((e.ctrlKey || e.metaKey) && !typing) {
        const k = e.key.toLowerCase()
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
        else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo() }
        return
      }
      if (e.key === 'Escape' && !typing) select(null)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !typing && !(e.target as HTMLElement | null)?.closest?.('.ProseMirror')) {
        e.preventDefault()
        remove(selected)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const maker: MakerContext = useMemo(() => ({
    images: doc?.images ?? {},
    remember,
    addImage: async (blob: Blob) => {
      try {
        const name = blob instanceof File && blob.name ? blob.name.replace(/\.[^.]+$/, '') : `Pasted picture ${new Date().toLocaleString('en-IN')}`
        const a = await uploadImage(blob, name)
        remember([a])
        return a
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'The picture could not be added.')
        return null
      }
    },
  }), [doc?.images, remember, toast])

  const labels = useMemo(() => (doc ? computeNumbers(doc.body) : new Map<string, string>()), [doc])

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  if (!doc || !q.data) return <Loading />

  const draft = q.data
  const L = paperLabels(doc.labelLang)
  const total = marksOf(doc.body)
  const target = doc.maxMarks ?? 0
  const style = effectiveStyle(undefined, doc.style)
  const sheetStyle = { fontFamily: fontStack(style), '--fs': `${style.fontSize}pt`, '--lh': style.lineHeight, '--gap': `${style.questionGap}pt` } as React.CSSProperties
  const setPaper = (patch: Partial<PaperDoc>) => update((d) => ({ ...d, ...patch }))
  const subjectHint = draft.class_subject_id ?? undefined

  const ops: CanvasOps = {
    root: doc.body,
    selected,
    select,
    update: (bid, patch) => setBody((r) => mapBox(r, bid, (b) => ({ ...b, ...patch }))),
    remove,
    move: (bid, parentId, index) => setBody((r) => moveBox(r, bid, parentId, index)),
    duplicate: (bid) => {
      const f = findBox(doc.body, bid)
      if (!f?.parent) return
      const copy = cloneBox(f.box, uid)
      setBody((r) => insertBox(r, f.parent!.id, copy, f.index + 1))
      select(copy.id)
    },
    saveToBank: (bid) => { const f = findBox(doc.body, bid); if (f) setBanking(f.box) },
    openInserter: (parentId, index) => setInserter({ parentId, index }),
    labels,
    marksWord: L('marks'),
    orWord: L('or'),
    bilingual: !!doc.bilingual,
  }

  const selBox = selected ? findBox(doc.body, selected)?.box : undefined
  const dist = distribution(doc.body)
  let count = 0
  walkBoxes(doc.body, (b) => { if (b.number?.scope === 'paper') count++ })
  const status = !target ? '' : total === target ? 'ok' : total > target ? 'over' : 'under'
  const baseName = safeFileName([doc.examName || 'Paper', doc.className, doc.subject].filter(Boolean).join(' - '))

  const saveWord = { saved: 'Saved', saving: 'Saving', unsaved: 'Saving', error: 'Not saved', conflict: 'Changed elsewhere' }[save]

  const panel = (
    <div className="space-y-4">
      <div className={TAB_BAR} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'paper'} className={tabClass(tab === 'paper')} onClick={() => setTab('paper')}>Paper</button>
        <button type="button" role="tab" aria-selected={tab === 'box'} className={tabClass(tab === 'box')} onClick={() => setTab('box')}>{selBox?.name || 'Selected box'}</button>
      </div>
      {tab === 'box' ? (
        selBox ? <BoxPanel key={selBox.id} b={selBox} update={(patch) => ops.update(selBox.id, patch)} /> : <p className="text-[13px] text-muted-foreground">Click any box on the paper to see its settings.</p>
      ) : (
        <div className="space-y-4">
          <section className="qm-panel">
            <h3 className="qm-panel-h">Marks</h3>
            <p className="text-[22px] font-semibold tabular-nums">{total}{target > 0 && <span className="text-muted-foreground"> / {target}</span>}</p>
            {status === 'under' && <Badge tone="warning">{target - total} marks still to add</Badge>}
            {status === 'over' && <Badge tone="danger">{total - target} marks over</Badge>}
            {status === 'ok' && <Badge tone="success">Adds up</Badge>}
            <Field label="Maximum marks" hint="What the paper should add up to.">
              <Input type="number" min={0} value={target ? String(target) : ''} placeholder="80" onChange={(v) => setPaper({ maxMarks: Math.max(0, Number(v) || 0) })} />
            </Field>
            <p className="text-[12px] text-muted-foreground">{count} numbered {count === 1 ? 'question' : 'questions'}.</p>
            <Button variant="secondary" onClick={() => setFilling(true)}>Fill from the bank</Button>
          </section>
          <Split title="Marks by chapter" rows={dist.chapter} />
          <Split title="Marks by difficulty" rows={dist.difficulty} />
          <section className="qm-panel">
            <h3 className="qm-panel-h">Font and spacing</h3>
            <StyleEditor value={style} onChange={(patch) => setPaper({ style: { ...doc.style, ...patch } })} />
          </section>
          <section className="qm-panel">
            <h3 className="qm-panel-h">Language and printing</h3>
            <Field label="Printed words" hint={'"Class", "Max. Marks", "OR" and the like.'}>
              <PickerMenu ariaLabel="Printed words" value={doc.labelLang ?? 'en'} onChange={(v: PaperLang) => setPaper({ labelLang: v })}
                options={PAPER_LANGS.map(([value, l]) => ({ value, label: l }))} className="w-full" />
            </Field>
            <Checkbox checked={!!doc.bilingual} onChange={(v) => setPaper({ bilingual: v })} label="Two languages" hint="A second-language line under each box." />
            <Checkbox checked={doc.pageCols === 2} onChange={(v) => setPaper({ pageCols: v ? 2 : undefined })} label="Two columns on the page" />
          </section>
        </div>
      )}
    </div>
  )

  return (
    <Maker.Provider value={maker}>
      <div className="qm-editor">
        <header className="qm-top">
          <Button size="sm" variant="ghost" title="Back to my papers" onClick={() => { if (save !== 'saved') flush(); onBack() }}><ArrowLeft className="size-4" /></Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold">{doc.examName || 'Untitled paper'}</p>
            <p className="truncate text-[12px] text-muted-foreground">{[doc.className, doc.subject].filter(Boolean).join(' · ') || 'Fill in the exam, class and subject on the paper'}</p>
          </div>
          <Button size="sm" variant="ghost" title="Undo (Ctrl+Z)" disabled={!past.current.length} onClick={undo}><Undo2 className="size-4" /></Button>
          <Button size="sm" variant="ghost" title="Redo (Ctrl+Y)" disabled={!future.current.length} onClick={redo}><Redo2 className="size-4" /></Button>
          <span className={`qm-save ${save}`} role="status">{saveWord}</span>
          <Button size="sm" variant="ghost" title="Paper settings" onClick={() => setSide((v) => !v)} className={side ? 'bg-accent text-foreground' : undefined}><PanelRight className="size-4" /></Button>
          <Button size="sm" variant="secondary" onClick={() => setPreview(true)}><Eye className="size-4" /> Preview</Button>
          <span ref={moreAt} className="inline-flex">
            <Button size="sm" variant="ghost" title="Print, Word and share file" ariaHasPopup="menu" ariaExpanded={more} onClick={() => setMore((v) => !v)}><MoreHorizontal className="size-4" /></Button>
          </span>
          <Menu open={more} anchor={moreAt.current} label="Print and files" onClose={() => setMore(false)} width={240}>
            {([
              ['Print the paper', () => printPaper(doc, school, false)],
              ['Print the answer key', () => printPaper(doc, school, true)],
              ['Word file of the paper', async () => { const { renderPaperDocx } = await import('./lib/renderDocx'); download((await renderPaperDocx(doc, school, false)).slice().buffer, `${baseName}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') }],
              ['Word file of the answer key', async () => { const { renderPaperDocx } = await import('./lib/renderDocx'); download((await renderPaperDocx(doc, school, true)).slice().buffer, `${baseName} - Answer key.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') }],
              ['Share file (.qpaper)', async () => download(await paperFile(doc), `${baseName}.qpaper`, 'application/json')],
            ] as const).map(([label, run]) => (
              <button key={label} type="button" role="menuitem" className="bento-menu__item" onClick={() => {
                setMore(false)
                Promise.resolve(run()).catch((e) => toast.error(e instanceof Error ? e.message : 'That file could not be made.'))
              }}>{label}</button>
            ))}
          </Menu>
          <Button size="sm" onClick={() => setSending(true)}><Send className="size-4" /> Send</Button>
        </header>

        {(save === 'error' || save === 'conflict') && (
          <div className="qm-alert" role="alert">
            <FormNotice error={saveError} />
            {save === 'error'
              ? <Button size="sm" variant="secondary" onClick={flush}>Try again</Button>
              : <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Reload the paper</Button>}
          </div>
        )}
        {draft.sent_status === 'changes_needed' && draft.review_note && (
          <div className="qm-alert"><FormNotice error={`Sent back: ${draft.review_note}`} /></div>
        )}

        <Toolbar />

        <div className={`qm-body ${side ? 'with-side' : ''}`}>
          <div className="qm-desk" onMouseDown={() => select(null)}>
            <style>{PAPER_CSS}</style>
            <div className="qm-sheet qp" style={sheetStyle}>
              <div className="hd">
                <div className="hd-top">
                  {school.logo && <img src={`/api/v1/files/${school.logo}?inline=1`} alt="" />}
                  <div>
                    <div className="inst">{school.name}</div>
                    {school.address && <div className="addr">{school.address}</div>}
                  </div>
                </div>
                <input className="qm-inline exam" aria-label="Exam name" value={doc.examName} placeholder="Exam name, for example Half yearly examination" onChange={(e) => setPaper({ examName: e.target.value })} />
              </div>
              <div className="meta">
                <span>{L('class')}: <input className="qm-inline" aria-label="Class" value={doc.className} placeholder="Class" onChange={(e) => setPaper({ className: e.target.value })} /></span>
                <span>{L('subject')}: <input className="qm-inline" aria-label="Subject" value={doc.subject} placeholder="Subject" onChange={(e) => setPaper({ subject: e.target.value })} /></span>
              </div>
              <div className="meta">
                <span>{L('time')}: <input className="qm-inline" aria-label="Time allowed" value={doc.duration} placeholder="3 hours" onChange={(e) => setPaper({ duration: e.target.value })} /></span>
                <span>{L('date')}: <input className="qm-inline" aria-label="Date" value={doc.date} placeholder="dd-mm-yyyy" onChange={(e) => setPaper({ date: e.target.value })} /></span>
                <span>{L('maxMarks')}: {total}</span>
              </div>
              {doc.body.children?.length === 0 && (
                <p className="qm-empty">Press + to add a question, or use Fill from the bank in the paper settings.</p>
              )}
              <div className={doc.pageCols === 2 ? 'cols2' : ''}>
                <BoxCanvas ops={ops} />
              </div>
              <div className="end">{L('end')}</div>
            </div>
          </div>
          {side && !phone && <aside className="qm-side" aria-label="Paper settings">{panel}</aside>}
        </div>
      </div>

      {side && phone && (
        <Dialog title="Paper settings" onClose={() => setSide(false)} size="md">{panel}</Dialog>
      )}
      {inserter && (
        <BoxInserter
          subjectHint={subjectHint}
          onClose={() => setInserter(null)}
          onPick={({ box, images }) => {
            remember(Object.values(images))
            setBody((r) => insertBox(r, inserter.parentId, box, inserter.index))
            setInserter(null)
            select(box.id)
          }}
        />
      )}
      {filling && (
        <FillFromBank
          subjectHint={subjectHint}
          onClose={() => setFilling(false)}
          onAdd={(boxes, images) => {
            remember(Object.values(images))
            setBody((r) => ({ ...r, children: [...(r.children ?? []), ...boxes] }))
            setFilling(false)
            toast.ok(`Added ${boxes.length} ${boxes.length === 1 ? 'section' : 'sections'} from the bank`)
          }}
        />
      )}
      {banking && <SaveToBank box={banking} subjectHint={subjectHint} onClose={() => setBanking(null)} />}
      {preview && <PaperPreview doc={doc} school={school} title={doc.examName || 'Preview'} onClose={() => setPreview(false)} />}
      {sending && (
        <SendDialog
          draft={draft}
          doc={doc}
          slots={slots}
          onClose={() => setSending(false)}
          onSent={() => {
            setSending(false)
            toast.ok('Sent for approval')
            qc.invalidateQueries({ queryKey: ['question-papers'] })
            qc.invalidateQueries({ queryKey: ['question-paper-slots'] })
            qc.invalidateQueries({ queryKey: ['paper-drafts'] })
            qc.invalidateQueries({ queryKey: ['my-paper-deadlines'] })
          }}
        />
      )}
    </Maker.Provider>
  )
}
