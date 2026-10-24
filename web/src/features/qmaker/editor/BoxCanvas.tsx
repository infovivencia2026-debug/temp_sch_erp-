import { createContext, useContext, useState, type DragEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, BookmarkPlus, Copy, GripVertical, IndentDecrease, IndentIncrease, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { findBox, marksLabel, printOrder, type Box } from '../lib/box'
import { optionGrid } from '../lib/grid'
import RichInput from './RichInput'

/** Everything the sheet can do to the tree; the paper editor and the bank editor each implement it. */
export interface CanvasOps {
  root: Box
  selected: string | null
  select: (id: string | null) => void
  update: (id: string, patch: Partial<Box>) => void
  remove: (id: string) => void
  move: (id: string, parentId: string, index: number) => void
  duplicate: (id: string) => void
  saveToBank?: (id: string) => void
  openInserter: (parentId: string, index: number) => void
  labels: Map<string, string>
  marksWord: string
  orWord: string
  bilingual: boolean
}

const Ctx = createContext<CanvasOps | null>(null)
const useOps = () => useContext(Ctx)!

let dragId: string | null = null

/** The thin line between boxes: + inserts here, and a dragged box can be dropped on it. */
function Between({ parentId, index }: { parentId: string; index: number }) {
  const ops = useOps()
  const [over, setOver] = useState(false)
  return (
    <div
      className={`qm-between ${over ? 'over' : ''}`}
      onDragOver={(e: DragEvent) => { if (dragId) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (dragId) ops.move(dragId, parentId, index); dragId = null }}
    >
      <span onMouseDown={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" title="Insert here" onClick={() => ops.openInserter(parentId, index)}><Plus className="size-4" /></Button>
      </span>
    </div>
  )
}

/** The bar over the selected box: move, nest, copy, bank, delete. */
function BoxBar({ b }: { b: Box }) {
  const ops = useOps()
  const f = findBox(ops.root, b.id)
  if (!f?.parent) return null
  const { parent, index } = f
  const prev = parent.children?.[index - 1]
  const grand = findBox(ops.root, parent.id)?.parent
  return (
    <div className="qm-boxbar" onMouseDown={(e) => e.stopPropagation()}>
      <span
        className="qm-grip"
        draggable
        title="Drag to move"
        aria-hidden="true"
        onDragStart={(e) => { dragId = b.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.id) }}
        onDragEnd={() => (dragId = null)}
      ><GripVertical className="size-4" /></span>
      <span className="qm-boxbar-name">{b.name || (b.number ? 'Numbered box' : b.children?.length ? 'Box' : 'Text')}</span>
      <Button size="sm" variant="ghost" title="Move up" disabled={index === 0} onClick={() => ops.move(b.id, parent.id, index - 1)}><ArrowUp className="size-4" /></Button>
      <Button size="sm" variant="ghost" title="Move down" disabled={index >= (parent.children?.length ?? 1) - 1} onClick={() => ops.move(b.id, parent.id, index + 2)}><ArrowDown className="size-4" /></Button>
      <Button size="sm" variant="ghost" title="Move out of this box" disabled={!grand} onClick={() => grand && ops.move(b.id, grand.id, (grand.children ?? []).findIndex((c) => c.id === parent.id) + 1)}><IndentDecrease className="size-4" /></Button>
      <Button size="sm" variant="ghost" title="Move into the box above" disabled={!prev} onClick={() => prev && ops.move(b.id, prev.id, prev.children?.length ?? 0)}><IndentIncrease className="size-4" /></Button>
      <Button size="sm" variant="ghost" title="Duplicate" onClick={() => ops.duplicate(b.id)}><Copy className="size-4" /></Button>
      {ops.saveToBank && <Button size="sm" variant="ghost" title="Save to the question bank" onClick={() => ops.saveToBank!(b.id)}><BookmarkPlus className="size-4" /></Button>}
      <Button size="sm" variant="ghost" tone="danger" title="Delete" onClick={() => ops.remove(b.id)}><Trash2 className="size-4" /></Button>
    </div>
  )
}

function Children({ b }: { b: Box }) {
  const ops = useOps()
  const kids = printOrder(b, true) // edited in the real order; shuffling happens only on the printed paper
  const cells: ReactNode[] = kids.map((c, i) => (
    <div key={c.id} className="qm-cell">
      {b.layout?.mode !== 'grid' && <Between parentId={b.id} index={i} />}
      <EditBox b={c} />
      {b.choice && i < kids.length - 1 && <div className="qm-or"><span>{ops.orWord}</span></div>}
    </div>
  ))
  const tail = <div className="qm-between-end"><Between parentId={b.id} index={kids.length} /></div>
  if (b.layout?.mode === 'grid') {
    const g = optionGrid(kids.length, b.layout.cols || kids.length || 1, b.layout.order ?? 'across')
    const cols = b.layout.widths?.length === g.cols ? b.layout.widths.map((w) => `minmax(0, ${w}fr)`).join(' ') : `repeat(${g.cols}, minmax(0, 1fr))`
    return (
      <>
        <div className="bgrid" style={{ gridTemplateColumns: cols, ...(b.layout.gapMm != null ? { gap: `${b.layout.gapMm}mm` } : {}) }}>
          {g.cells.map((i, k) => (i === null ? <div key={`e${k}`} /> : cells[i]))}
        </div>
        {tail}
      </>
    )
  }
  return <>{cells}{tail}</>
}

/** One box on the page, edited in place, drawn as it prints. */
function EditBox({ b }: { b: Box }) {
  const ops = useOps()
  const sel = ops.selected === b.id
  const num = ops.labels.get(b.id) ?? ''
  const marks = marksLabel(b, ops.marksWord)
  const s = b.style ?? {}
  const textStyle: React.CSSProperties = {
    textAlign: s.align, fontWeight: s.bold ? 700 : undefined, fontStyle: s.italic ? 'italic' : undefined,
    fontSize: s.scale && s.scale !== 1 ? `calc(var(--fs) * ${s.scale})` : undefined,
  }
  const content = b.content !== undefined && (
    <div className="bc" style={textStyle}>
      <RichInput label={b.name || 'Text'} value={b.content ?? ''} placeholder={b.children?.length ? 'Text (optional)' : 'Type here'} onChange={(v) => ops.update(b.id, { content: v })} />
      {ops.bilingual && <RichInput label={`${b.name || 'Text'}, second language`} className="second" value={b.content2 ?? ''} placeholder="Second language" onChange={(v) => ops.update(b.id, { content2: v })} />}
    </div>
  )
  const tags = [
    b.visible === 'key' && <span key="k" className="qm-tag key">Answer key only</span>,
    b.visible === 'paper' && <span key="p" className="qm-tag">Paper only</span>,
    b.correct && <span key="c" className="qm-tag ok">Correct answer</span>,
    b.shuffle && <span key="s" className="qm-tag">Shuffled when printed</span>,
    s.pageBreak && <span key="pb" className="qm-tag">New page before</span>,
  ].filter(Boolean)
  const cls = ['qm-box', sel && 'sel', s.border && 'bordered', b.visible === 'key' && 'keyonly', b.correct && 'correct'].filter(Boolean).join(' ')
  const style: React.CSSProperties = { padding: s.paddingMm ? `${s.paddingMm}mm` : undefined, marginTop: s.spaceBefore ? `${s.spaceBefore}pt` : b.number?.scope === 'paper' ? 'var(--gap)' : undefined }
  const onDown = (e: React.MouseEvent) => { e.stopPropagation(); ops.select(b.id) }
  const kids = <Children b={b} />
  const body = <>{content}{tags.length > 0 && <div className="qm-tags">{tags}</div>}{kids}</>

  if (s.rule) {
    return (
      <div className={`${cls} heading`} style={style} onMouseDown={onDown}>
        {sel && <BoxBar b={b} />}
        <div className="bh" style={textStyle}><span className="bh-t">{num && <span className="bh-n">{num}</span>}{content}</span><span className="bh-m">{marks}</span></div>
        {tags.length > 0 && <div className="qm-tags">{tags}</div>}
        {kids}
      </div>
    )
  }
  if (num || marks) {
    return (
      <div className={`${cls} numbered`} style={style} onMouseDown={onDown}>
        {sel && <BoxBar b={b} />}
        <div className="qn">{num}</div>
        <div className="bb">{body}</div>
        <div className="qm">{marks}</div>
      </div>
    )
  }
  return (
    <div className={cls} style={style} onMouseDown={onDown}>
      {sel && <BoxBar b={b} />}
      {body}
    </div>
  )
}

/** The editable page body: every top-level box, with insert points between them. */
export default function BoxCanvas({ ops }: { ops: CanvasOps }) {
  return (
    <Ctx.Provider value={ops}>
      <div className="qm-canvas">
        <Children b={ops.root} />
      </div>
    </Ctx.Provider>
  )
}
