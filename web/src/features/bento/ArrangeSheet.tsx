import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, GripVertical, RotateCcw } from 'lucide-react'
import { useLayout, dimsOf, isRemoved, DIMS, type BoardWidget } from '@/lib/widgets'
import { buzz } from '@/lib/haptics'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { INK_HERE_FROM_PAGE } from './ColourDialog'

/* THE PHONE'S EDITOR: A SHEET, NOT AN OVERLAY PER CARD.

   The old arranger put a scrim and six controls on every tile — steppers for
   width and height a one-column pager cannot use, arrows for an order that
   dragging already expresses, a colour wheel — and to make room for them it
   turned the pager back into a scrolling list. Editing the home screen meant
   losing the home screen.

   This is what a phone does instead: the board stays exactly as it is read,
   and a sheet rises over its lower half listing the cards in order. Each row
   has the three decisions a phone card admits — where it sits, whether it is
   shown, and whether it is Small or Tall — and nothing else. Dragging a row
   reorders the board behind the sheet as the finger moves, which is the whole
   point of keeping the board visible.

   POINTER EVENTS, NOT HTML5 DRAG. Touch has no dragstart; pointer capture on
   the handle is what makes a finger drag work at all, and it gives the same
   code path to a mouse on a narrow window.

   EVERY CONTROL IS 44PX. The rows, the handle, the size segments, the switch,
   Done and Reset — a fingertip's target, on the one surface that exists only
   to be pressed. */

const ROW_H = 52

export function ArrangeSheet({
  dashboard,
  declared,
  visible,
  onDone,
}: {
  dashboard: string
  /** Every card the board knows, in mount order. */
  declared: BoardWidget[]
  /** The ones on the board, in the order they are drawn. */
  visible: BoardWidget[]
  onDone: () => void
}) {
  const t = useT()
  const { layout, place, remove, resize, move, reset } = useLayout(dashboard)
  const arranged = layout.placed.length > 0 || layout.removed.length > 0
  const hidden = declared.filter((d) => !visible.some((v) => v.id === d.id))

  /* The drag, held apart from the layout.

     While a row is being dragged the list is drawn from a SNAPSHOT of the
     order at pointerdown, and the rows shift with transforms; the layout
     underneath is written on every crossing so the board follows live. If
     the list re-rendered from the layout mid-drag, the row under the finger
     would jump to its new slot and the transform would carry it off again.
     On release the snapshot is dropped and the list is the layout, which by
     then already says the same thing. */
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; dy: number; list: BoardWidget[] } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const startY = useRef(0)
  const lastTo = useRef(-1)

  const onHandleDown = (e: React.PointerEvent<HTMLButtonElement>, id: string, from: number) => {
    if (!e.isPrimary) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    startY.current = e.clientY
    lastTo.current = from
    setDrag({ id, from, to: from, dy: 0, list: visible })
    buzz('select')
  }
  const onHandleMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag) return
    const dy = e.clientY - startY.current
    // Which slot the row's centre is over: whole rows moved, rounded.
    const to = Math.max(0, Math.min(drag.list.length - 1, drag.from + Math.round(dy / ROW_H)))
    if (to !== lastTo.current) {
      lastTo.current = to
      move(drag.id, to, drag.list)
      buzz('tap')
    }
    setDrag({ ...drag, dy, to })
  }
  const onHandleUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    setDrag(null)
  }

  /* Escape closes, like every sheet. The layer's own listener does the same;
     this one exists so the sheet is correct on its own. */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onDone() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDone])

  const rows = drag ? drag.list : visible
  const shift = (i: number): number => {
    if (!drag) return 0
    if (i === drag.from) return drag.dy
    if (drag.from < i && i <= drag.to) return -ROW_H
    if (drag.to <= i && i < drag.from) return ROW_H
    return 0
  }

  // Colour comes from the stylesheet's [aria-checked] rule, not a utility
  // class: the sheet's own rules sit outside Tailwind's layer and win.
  const seg = () => 'h-11 min-w-[56px] px-3 text-[13px] leading-none'

  return (
    <>
      {/* A tap on the board while the sheet is up is Done, not a navigation:
          every card is a link, and opening a screen is not what somebody
          reordering their home meant. Transparent, so the board is seen. */}
      <div className="bento-sheet-backdrop" onClick={onDone} aria-hidden="true" />
      <div
        className="bento-sheet"
        role="dialog"
        aria-modal="false"
        aria-label={t('bento.widgets.sheet_title')}
        data-arrange-sheet=""
        style={{ '--ink-here': INK_HERE_FROM_PAGE } as CSSProperties}
      >
        <div className="bento-sheet__grip" aria-hidden="true" />
        <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-1">
          <div className="min-w-0">
            <p className="text-[15px] font-medium">{t('bento.widgets.sheet_title')}</p>
            <p className="text-[12.5px] opacity-70">{t('bento.widgets.sheet_hint')}</p>
          </div>
          <button type="button" onClick={onDone} className="bento-sheet__btn">
            <Check className="size-4" aria-hidden="true" />
            {t('bento.widgets.done')}
          </button>
        </div>

        <ul ref={listRef} className="bento-sheet__list" style={{ '--row-h': `${ROW_H}px` } as CSSProperties}>
          {rows.map((w, i) => {
            const { w: cw, h: ch } = dimsOf(layout, w.id, w.size)
            const tall = ch >= 2
            const dragging = drag?.id === w.id
            return (
              <li
                key={w.id}
                className={cn('bento-sheet__row', dragging && 'is-dragging')}
                style={{ transform: shift(i) ? `translateY(${shift(i)}px)` : undefined }}
              >
                <button
                  type="button"
                  data-handle=""
                  aria-label={t('bento.widgets.drag', { label: w.label })}
                  className="bento-sheet__handle"
                  onPointerDown={(e) => onHandleDown(e, w.id, i)}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                  onPointerCancel={onHandleUp}
                >
                  <GripVertical className="size-5" aria-hidden="true" />
                </button>
                <span className="min-w-0 flex-1 truncate text-[14px]">{w.label}</span>
                <span
                  role="radiogroup"
                  aria-label={t('bento.widgets.size_of', { label: w.label })}
                  className="bento-sheet__seg"
                >
                  <button type="button" role="radio" aria-checked={!tall} className={seg()}
                          onClick={() => resize(w.id, cw, 1)}>
                    {t('bento.widgets.size_small')}
                  </button>
                  <button type="button" role="radio" aria-checked={tall} className={seg()}
                          onClick={() => resize(w.id, cw, 2)}>
                    {t('bento.widgets.size_tall')}
                  </button>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked="true"
                  aria-label={`${w.label}: ${t('bento.widgets.shown')}`}
                  className="bento-sheet__switch"
                  data-on=""
                  onClick={() => remove(w.id)}
                >
                  <span className="bento-sheet__knob" aria-hidden="true" />
                </button>
              </li>
            )
          })}
          {hidden.map((w) => (
            <li key={w.id} className="bento-sheet__row is-hidden">
              <span className="bento-sheet__handle opacity-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[14px] opacity-60">{w.label}</span>
              <button
                type="button"
                role="switch"
                aria-checked="false"
                aria-label={`${w.label}: ${t('bento.widgets.hidden')}`}
                className="bento-sheet__switch"
                onClick={() => {
                  const d = isRemoved(layout, w.id) || w.optional ? DIMS[w.size] : { w: w.w, h: w.h }
                  place(w.id, d.w, d.h)
                }}
              >
                <span className="bento-sheet__knob" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>

        {arranged && (
          <div className="px-4 pb-2 pt-1">
            <button type="button" onClick={reset} className="bento-sheet__btn is-quiet">
              <RotateCcw className="size-4" aria-hidden="true" />
              {t('bento.widgets.reset')}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
