import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, GripVertical } from 'lucide-react'
import { useLayout, isRemoved, DIMS, type BoardWidget } from '@/lib/widgets'
import { buzz } from '@/lib/haptics'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { INK_HERE_FROM_PAGE } from './ColourDialog'

/* THE PHONE'S REORDER LIST: A SHEET, OPENED FROM THE CUSTOMIZE BAR.

   This used to be the phone's whole editor — every decision a card admitted,
   in a row per card. Customize mode now puts those decisions on the card
   itself: the remove button, the size pill, the colour wheel behind it, and
   the drag. What a list still does better than a board is MOVE A CARD FAR:
   dragging page four's card to page one means holding it at the edge of the
   pager and waiting, four times; dragging a row up a list is one motion.

   So the sheet keeps exactly that: the cards in order, a handle to drag each
   one, and a switch to put a hidden card back. The board behind it follows
   the finger live, which is the point of keeping the board visible. Done on
   the sheet closes the sheet; the mode stays on, with its bar.

   POINTER EVENTS, NOT HTML5 DRAG. Touch has no dragstart; pointer capture on
   the handle is what makes a finger drag work at all, and it gives the same
   code path to a mouse on a narrow window.

   EVERY CONTROL IS 44PX. The rows, the handle, the switch and Done — a
   fingertip's target, on the one surface that exists only to be pressed. */

const ROW_H = 52

export function ArrangeSheet({
  dashboard,
  declared,
  visible,
  onDone,
  shown = true,
  still = false,
}: {
  dashboard: string
  /** Every card the board knows, in mount order. */
  declared: BoardWidget[]
  /** The ones on the board, in the order they are drawn. */
  visible: BoardWidget[]
  onDone: () => void
  /** False for the frame before the enter and the beat after the exit: the
      sheet is mounted and off the bottom edge. The layer drives it with
      useEnterExit, the same way it drives the menus. */
  shown?: boolean
  /** Reduce motion: the slide is instant. */
  still?: boolean
}) {
  const t = useT()
  const { layout, place, remove, move } = useLayout(dashboard)
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
      /* Every crossing writes, so the board follows the finger — and every
         crossing is the same gesture, so Undo takes the drag back whole. */
      move(drag.id, to, drag.list, true)
      buzz('tap')
    }
    setDrag({ ...drag, dy, to })
  }
  const onHandleUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    setDrag(null)
  }

  /* Escape closes the sheet, like every sheet — caught on the way down and
     stopped there, because the layer's own Escape ends customize mode and
     closing a list is not that. */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      onDone()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onDone])

  const rows = drag ? drag.list : visible
  const shift = (i: number): number => {
    if (!drag) return 0
    if (i === drag.from) return drag.dy
    if (drag.from < i && i <= drag.to) return -ROW_H
    if (drag.to <= i && i < drag.from) return ROW_H
    return 0
  }

  return (
    <>
      {/* A tap on the board while the sheet is up closes the sheet: the bar
          and the cards' own controls are underneath it, and the person is
          reaching for them. Transparent, so the board is seen. */}
      <div className="bento-sheet-backdrop" onClick={onDone} aria-hidden="true" />
      <div
        className="bento-sheet"
        role="dialog"
        aria-modal="false"
        aria-label={t('bento.widgets.sheet_title')}
        data-arrange-sheet=""
        data-shown={shown ? '' : undefined}
        data-still={still ? '' : undefined}
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
      </div>
    </>
  )
}
