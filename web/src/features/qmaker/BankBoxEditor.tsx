import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { buzz } from '@/lib/haptics'
import { Button, Dialog, ErrorState, FormNotice, Loading } from '@/components/ui'
import { useToast } from '@/components/Toast'
import type { BankOption, BankQuestion } from '@/features/faculty/teaching'
import { cloneBox, computeNumbers, findBox, insertBox, mapBox, moveBox, type Box } from './lib/box'
import { bankItemBox } from './lib/bankbox'
import { bankFields } from './lib/bundle'
import { effectiveStyle, fontStack } from './lib/fonts'
import { collectImageIds, lookupImages, uploadImage, type ImageAsset } from './lib/images'
import { paperLabels } from './lib/labels'
import { PAPER_CSS } from './lib/renderHtml'
import { uid } from './lib/util'
import { Maker, type MakerContext } from './editor/context'
import BoxCanvas, { type CanvasOps } from './editor/BoxCanvas'
import BoxInserter from './editor/BoxInserter'
import BoxPanel from './editor/BoxPanel'
import Toolbar from './editor/Toolbar'
import './lib/fonts-css'
import './qmaker.css'

const ROOT = 'bank-root'

/* One banked question on the page, edited with the same toolbar and settings
   as a paper. A question banked from the plain form is opened as the box it
   would print as, and saved back with that box, so from then on it prints
   with its formatting. The plain stem, kind and options the bank and online
   tests read are worked out again from the box on every save. */
export default function BankBoxEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({
    queryKey: ['question-bank-item', id],
    queryFn: async () => {
      const item = await api.get<BankQuestion & { body?: Box; answer_key?: BankOption[] }>(`/api/v1/teaching/question-bank/${id}`)
      const box = item.body ?? bankItemBox({ ...item, correct: item.answer_key?.map((o) => o.is_correct) })
      return { item, box, images: await lookupImages(collectImageIds(box)) }
    },
    staleTime: Infinity,
    gcTime: 0,
  })
  const [box, setBox] = useState<Box | null>(null)
  const [images, setImages] = useState<Record<string, ImageAsset>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [inserter, setInserter] = useState<{ parentId: string; index: number } | null>(null)
  const cur = box ?? q.data?.box ?? null

  const remember = useCallback((assets: ImageAsset[]) => setImages((m) => ({ ...m, ...Object.fromEntries(assets.map((a) => [a.id, a])) })), [])
  const maker: MakerContext = useMemo(() => ({
    images: { ...q.data?.images, ...images },
    remember,
    addImage: async (blob: Blob) => {
      try {
        const a = await uploadImage(blob, blob instanceof File && blob.name ? blob.name.replace(/\.[^.]+$/, '') : 'Pasted picture')
        remember([a])
        return a
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'The picture could not be added.')
        return null
      }
    },
  }), [q.data?.images, images, remember, toast])

  const save = useMutation({
    mutationFn: (b: Box) => {
      const f = bankFields(b)
      return api.put(`/api/v1/teaching/question-bank/${id}`, {
        kind: f.kind, difficulty: f.difficulty, stem: f.stem, default_marks: f.default_marks,
        options: f.options.length ? f.options : undefined, body: { ...b, updatedAt: Date.now() },
      })
    },
    onSuccess: () => {
      buzz('tap')
      toast.ok('Question saved')
      qc.invalidateQueries({ queryKey: ['question-bank'] })
      qc.invalidateQueries({ queryKey: ['question-bank-summary'] })
      onClose()
    },
  })

  const root: Box = useMemo(() => ({ id: ROOT, children: cur ? [cur] : [] }), [cur])
  const labels = useMemo(() => computeNumbers(root), [root])
  if (!cur) {
    return <Dialog title="Edit the question" size="xl" onClose={onClose}>{q.error ? <ErrorState error={q.error} /> : <Loading shape="form" />}</Dialog>
  }
  const setRoot = (fn: (r: Box) => Box) => setBox(fn(root).children?.[0] ?? cur)
  const L = paperLabels()
  const style = effectiveStyle(undefined)
  const ops: CanvasOps = {
    root, selected, select: setSelected, labels, marksWord: L('marks'), orWord: L('or'), bilingual: false,
    update: (bid, patch) => setRoot((r) => mapBox(r, bid, (b) => ({ ...b, ...patch }))),
    remove: (bid) => { if (bid !== cur.id) setRoot((r) => mapBox(r, bid, () => null)) },
    move: (bid, p, i) => setRoot((r) => moveBox(r, bid, p, i)),
    duplicate: (bid) => { const f = findBox(root, bid); if (f?.parent && bid !== cur.id) setRoot((r) => insertBox(r, f.parent!.id, cloneBox(f.box, uid), f.index + 1)) },
    // The question itself is the only box at the top: + there adds inside it.
    openInserter: (parentId, index) => setInserter(parentId === ROOT ? { parentId: cur.id, index: cur.children?.length ?? 0 } : { parentId, index }),
  }
  const sel = selected ? findBox(root, selected)?.box : undefined

  return (
    <Maker.Provider value={maker}>
      <Dialog
        title="Edit the question"
        description="As it prints on a paper. Changes reach papers it is inserted into from now on; papers it is already on keep their copy."
        size="full"
        onClose={onClose}
        footer={<>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending} pending={save.isPending} onClick={() => save.mutate(cur)}>Save the question</Button>
        </>}
      >
        <div className="qm-editor">
          <Toolbar />
          <FormNotice error={save.error} />
          <div className="qm-body with-side">
            <div className="qm-desk" onMouseDown={() => setSelected(null)}>
              <style>{PAPER_CSS}</style>
              <div className="qm-sheet qp" style={{ minHeight: 0, fontFamily: fontStack(style), '--fs': `${style.fontSize}pt`, '--lh': style.lineHeight, '--gap': `${style.questionGap}pt` } as React.CSSProperties}>
                <BoxCanvas ops={ops} />
              </div>
            </div>
            <aside className="qm-side" aria-label="Box settings">
              {sel ? <BoxPanel key={sel.id} b={sel} update={(p) => ops.update(sel.id, p)} /> : <p className="text-[13px] text-muted-foreground">Click any box on the page to see its settings.</p>}
            </aside>
          </div>
        </div>
      </Dialog>
      {inserter && (
        <BoxInserter
          onClose={() => setInserter(null)}
          onPick={({ box: b, images: im }) => {
            remember(Object.values(im))
            setRoot((r) => insertBox(r, inserter.parentId, b, inserter.index))
            setInserter(null)
            setSelected(b.id)
          }}
        />
      )}
    </Maker.Provider>
  )
}
