import type { PointerEvent as RPointerEvent, ReactNode } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { AlignCenter, AlignLeft, AlignRight, Minus, Plus, Trash2, WrapText } from 'lucide-react'
import { Button } from '@/components/ui'
import { imgSrc } from '../lib/images'
import { useMaker } from './context'

/** Screen pixels per printed millimetre: the sheet is 210 mm wide. */
function pxPerMm(el: Element) {
  const sheet = el.closest('.qm-sheet')
  return sheet ? sheet.getBoundingClientRect().width / 210 : 96 / 25.4
}

/* Drag helper: calls onMove with the pointer's travel (px) from where the
   drag started. Listens on the window, because the handle is redrawn while
   its node changes size. */
function startDrag(e: RPointerEvent, onMove: (dx: number, dy: number, perMm: number) => void) {
  e.preventDefault()
  e.stopPropagation()
  const perMm = pxPerMm(e.currentTarget as Element)
  const x0 = e.clientX, y0 = e.clientY
  const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev.clientY - y0, perMm)
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** A control on the bars that float over a picture or block; the chosen one is shaded. */
function BarButton({ title, on, onClick, children }: { title: string; on?: boolean; onClick: () => void; children: ReactNode }) {
  return <Button size="sm" variant="ghost" title={title} onClick={onClick} className={on ? 'bg-accent text-foreground' : undefined}>{children}</Button>
}

const ALIGNS: [string, ReactNode, string][] = [
  ['inline', <WrapText key="i" className="size-4" />, 'In line with the text'],
  ['left', <AlignLeft key="l" className="size-4" />, 'Left, on its own line'],
  ['center', <AlignCenter key="c" className="size-4" />, 'Centre, on its own line'],
  ['right', <AlignRight key="r" className="size-4" />, 'Right, text wraps beside it'],
]

/** A picture in the text, with a bar for position and size and a corner to drag. */
export function ImageView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { images } = useMaker()
  const asset = images[node.attrs.id]
  const width = Number(node.attrs.width) || 40
  return (
    <NodeViewWrapper as="span" className={`ed-img al-${node.attrs.align} ${selected ? 'sel' : ''}`} style={{ width: `${width}mm` }}>
      {asset ? <img src={imgSrc(asset)} alt={asset.name ?? ''} draggable={false} /> : <span className="missing">Picture not found</span>}
      <span className="qm-bar" contentEditable={false} onMouseDown={(e) => e.preventDefault()}>
        {ALIGNS.map(([a, icon, title]) => (
          <BarButton key={a} title={title} on={node.attrs.align === a} onClick={() => updateAttributes({ align: a })}>{icon}</BarButton>
        ))}
        <BarButton title="Smaller" onClick={() => updateAttributes({ width: Math.max(5, width - 5) })}><Minus className="size-4" /></BarButton>
        <span className="qm-bar-n">{width} mm</span>
        <BarButton title="Bigger" onClick={() => updateAttributes({ width: Math.min(180, width + 5) })}><Plus className="size-4" /></BarButton>
        <BarButton title="Remove the picture" onClick={deleteNode}><Trash2 className="size-4" /></BarButton>
      </span>
      <span
        className="ed-handle corner"
        contentEditable={false}
        title="Drag to resize"
        onPointerDown={(e) => startDrag(e, (dx, _dy, perMm) => updateAttributes({ width: Math.round(Math.min(180, Math.max(5, width + dx / perMm))) }))}
      />
    </NodeViewWrapper>
  )
}

/** Ruled lines for the answer; drag the bottom edge for more or fewer. */
export function LinesView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const n = Math.min(Number(node.attrs.lines) || 1, 60)
  return (
    <NodeViewWrapper className={`ed-block ${selected ? 'sel' : ''}`}>
      <div className="lines" contentEditable={false}>{Array.from({ length: n }, (_, i) => <div key={i} />)}</div>
      <span
        className="ed-handle bottom"
        contentEditable={false}
        title="Drag to add or remove lines"
        onPointerDown={(e) => {
          const line = (e.currentTarget.parentElement?.querySelector('.lines > div') as HTMLElement | null)?.getBoundingClientRect().height || 25
          startDrag(e, (_dx, dy) => updateAttributes({ lines: Math.min(60, Math.max(1, n + Math.round(dy / line))) }))
        }}
      />
      <span className="qm-bar" contentEditable={false} onMouseDown={(e) => e.preventDefault()}>
        <span className="qm-bar-n">Answer lines</span>
        <BarButton title="One line fewer" onClick={() => updateAttributes({ lines: Math.max(1, n - 1) })}><Minus className="size-4" /></BarButton>
        <span className="qm-bar-n">{n}</span>
        <BarButton title="One line more" onClick={() => updateAttributes({ lines: Math.min(60, n + 1) })}><Plus className="size-4" /></BarButton>
        <BarButton title="Remove the lines" onClick={deleteNode}><Trash2 className="size-4" /></BarButton>
      </span>
    </NodeViewWrapper>
  )
}

/** An empty bordered box to draw in; drag the bottom edge for its height. */
export function BoxView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const h = Math.min(Number(node.attrs.height) || 40, 250)
  return (
    <NodeViewWrapper className={`ed-block ${selected ? 'sel' : ''}`}>
      <div className="drawbox" style={{ height: `${h}mm` }} contentEditable={false} />
      <span
        className="ed-handle bottom"
        contentEditable={false}
        title="Drag to change the height"
        onPointerDown={(e) => startDrag(e, (_dx, dy, perMm) => updateAttributes({ height: Math.round(Math.min(250, Math.max(10, h + dy / perMm))) }))}
      />
      <span className="qm-bar" contentEditable={false} onMouseDown={(e) => e.preventDefault()}>
        <span className="qm-bar-n">Drawing box</span>
        <BarButton title="Shorter" onClick={() => updateAttributes({ height: Math.max(10, h - 10) })}><Minus className="size-4" /></BarButton>
        <span className="qm-bar-n">{h} mm</span>
        <BarButton title="Taller" onClick={() => updateAttributes({ height: Math.min(250, h + 10) })}><Plus className="size-4" /></BarButton>
        <BarButton title="Remove the box" onClick={deleteNode}><Trash2 className="size-4" /></BarButton>
      </span>
    </NodeViewWrapper>
  )
}
