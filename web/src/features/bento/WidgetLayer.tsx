import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, GripVertical, Plus, RotateCcw, X } from 'lucide-react'
import {
  useLayout, dimsOf, isRemoved, orderOf, useBoard, publishBoard, clearBoard,
  WIDTHS, HEIGHTS, DIMS, type WidgetSize, type BoardWidget,
} from '@/lib/widgets'
import { COL, ROW, spanFor, type CellSpan } from './bento-kit'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/* Arranging the dashboard, the way a phone home screen is arranged.

   The hard part was not the controls, it was avoiding a rewrite. Every cell on
   these dashboards is hand-written JSX with its own queries and its own
   layout; turning them into records in a registry would have meant rebuilding
   each one and reviewing all of it at once.

   So a widget declares itself where it already is. <Widget id size> wraps the
   cell that was already written, tells the layer it exists, and decides
   whether to render it and at what size. Order comes from CSS `order` rather
   than from moving JSX, which is what lets somebody rearrange a board whose
   source order never changes.

   WHERE THE DOOR IS. Arrange mode is entered from Settings > Dashboard
   Widgets, not from a button on the board. The board is the thing being
   edited; a permanent control sitting on it is chrome that every user pays for
   so that the few who rearrange can find it. The state therefore lives in the
   widgets module, which the settings dialog can reach from the dock — this
   layer only reads it.

   Once arranging, the controls ARE on the board, because that is the thing
   being manipulated: you size a card by looking at it, not by reading its name
   in a list. */

interface LayerValue {
  dashboard: string
  editing: boolean
  declare: (w: BoardWidget) => void
  visible: BoardWidget[]
}

const Ctx = createContext<LayerValue | null>(null)

export function useWidgetLayer() {
  return useContext(Ctx)
}

export function WidgetLayer({
  dashboard,
  children,
}: {
  dashboard: string
  children: ReactNode
}) {
  const [declared, setDeclared] = useState<BoardWidget[]>([])
  const { arranging, setArranging } = useBoard()
  const { layout, place, reset } = useLayout(dashboard)
  const t = useT()

  const declare = useMemo(
    () => (w: BoardWidget) =>
      setDeclared((prev) => {
        const at = prev.findIndex((d) => d.id === w.id)
        if (at < 0) return [...prev, w]
        const old = prev[at]
        if (old.label === w.label && old.w === w.w && old.h === w.h) return prev
        const next = [...prev]
        next[at] = w
        return next
      }),
    [],
  )

  const visible = declared.filter((d) => !isRemoved(layout, d.id))
  const off = declared.filter((d) => isRemoved(layout, d.id))
  const arranged = layout.placed.length > 0 || layout.removed.length > 0

  /* Published so Settings can list this board without being inside it, and
     withdrawn on the way out so a screen with no board cannot be arranged. */
  useEffect(() => {
    publishBoard(dashboard, declared)
  }, [dashboard, declared])

  useEffect(() => () => clearBoard(dashboard), [dashboard])

  const value = useMemo<LayerValue>(
    () => ({ dashboard, editing: arranging, declare, visible }),
    [dashboard, arranging, declare, visible.map((d) => d.id).join(',')],
  )

  return (
    <Ctx.Provider value={value}>
      {/* Only while arranging, and a grid child either way.

          BentoPage drops its children straight into the board's grid, so this
          has to span the full width and sort first, or it gets crammed into
          one column and the Add chips wrap into an unreadable stack. */}
      {arranging && (
        <div
          className="col-span-full flex flex-wrap items-center gap-2"
          style={{ order: -1 }}
        >
          <button
            type="button"
            onClick={() => setArranging(false)}
            className="flex items-center gap-1.5 rounded-full border border-primary bg-primary-soft
                       px-3 py-1.5 text-[12.5px] text-primary focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Check className="size-3.5" aria-hidden="true" />
            {t('bento.widgets.done')}
          </button>

          {arranged && (
            <button
              type="button"
              onClick={reset}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px]
                         text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t('bento.widgets.reset')}
            </button>
          )}

          {off.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-muted-foreground">{t('bento.widgets.add')}</span>
              {off.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => place(d.id, DIMS[d.size].w, DIMS[d.size].h)}
                  className="flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1
                             text-[12px] transition-colors hover:bg-accent"
                >
                  <Plus className="size-3" aria-hidden="true" />
                  {d.label}
                </button>
              ))}
            </span>
          )}

          <span className="text-[12px] text-muted-foreground">{t('bento.widgets.hint')}</span>
        </div>
      )}
      {children}
    </Ctx.Provider>
  )
}

/** One row of the size control: five steps on a single axis. */
function Axis({
  label,
  steps,
  value,
  onPick,
}: {
  label: string
  steps: readonly number[]
  value: number
  onPick: (n: number) => void
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-3 shrink-0 text-[10px] font-semibold text-muted-foreground">{label}</span>
      {steps.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onPick(n)}
          aria-label={`${label} ${n}`}
          aria-pressed={value === n}
          className={cn(
            'grid size-6 place-items-center rounded-md text-[11px] shadow-sm transition-colors',
            value === n ? 'bg-primary font-semibold text-primary-foreground' : 'bg-popover/90 hover:bg-accent',
          )}
        >
          {n}
        </button>
      ))}
    </div>
  )
}

/* One widget: the cell that was already written, plus what the layer needs to
   place it. */
export function Widget({
  id,
  label,
  size: declaredSize,
  index,
  children,
}: {
  id: string
  label: string
  /** The shape this cell was designed at. The person's choice overrides it. */
  size: WidgetSize
  index: number
  /** Given the span to render at, because the cell owns its own <Cell>. */
  children: (span: CellSpan) => ReactNode
}) {
  const layer = useWidgetLayer()
  const { layout, remove, resize, move } = useLayout(layer?.dashboard ?? 'default')
  const t = useT()

  const { w, h } = dimsOf(layout, id, declaredSize)

  /* Declared in an effect, not in the render body.

     Calling the parent's setState while rendering a child is illegal in React
     — it logs "cannot update a component while rendering a different one" and
     can drop the render it was in the middle of. The add-list being one paint
     behind is not worth that; a removed widget still runs its effects, so it
     still reports itself and can still be put back. */
  const declare = layer?.declare
  useEffect(() => {
    declare?.({ id, label, index, size: declaredSize, w, h })
  }, [declare, id, label, index, declaredSize, w, h])

  if (isRemoved(layout, id)) return null

  const order = orderOf(layout, id, index)
  const editing = layer?.editing ?? false
  const span = spanFor(w, h)

  return (
    <div
      /* The span classes belong HERE, on the wrapper.

         This div is the grid child; the Cell inside it is not. Cell applies
         its own span classes to its own root, which does nothing once it is a
         level down — so with the classes only on the Cell, every size in the
         arranger was accepted, stored, and had no visible effect whatsoever.

         [&>*]:h-full is not decoration either. The cell used to BE the grid
         child and was stretched by the row track; now the wrapper is stretched
         and the cell inside sizes to its content, so a two-row card would sit
         at half height with a gap under it. */
      className={cn('bento-widget relative min-w-0 [&>*]:h-full', COL[w], ROW[h])}
      style={{ order }}
      /* The two data attributes are what lets a cell's CONTENTS answer to its
         size — see the [data-w]/[data-h] rules in index.css. Doing it in CSS
         from one wrapper means thirty hand-written cells did not each have to
         learn how to be small. */
      data-w={w}
      data-h={h}
      /* Reordering by drop rather than by arrow buttons: this is a home
         screen, and dragging is the gesture people already have for it. */
      draggable={editing}
      onDragStart={(e) => {
        if (!editing) return
        e.dataTransfer.setData('text/plain', id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (editing) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!editing || !layer) return
        e.preventDefault()
        const from = e.dataTransfer.getData('text/plain')
        if (!from || from === id) return
        move(from, layer.visible.findIndex((v) => v.id === id), layer.visible)
      }}
    >
      {children(span)}

      {editing && (
        <div
          className="absolute inset-0 z-10 flex flex-col justify-between gap-2 overflow-auto
                     rounded-[var(--bento-radius)] bg-background/70 p-2 backdrop-blur-[2px]"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="flex items-center gap-1 rounded-full bg-popover/90 px-2 py-1
                             text-[11px] font-medium shadow-sm">
              <GripVertical className="size-3 cursor-grab text-muted-foreground" aria-hidden="true" />
              {label}
            </span>
            <button
              type="button"
              onClick={() => remove(id)}
              aria-label={`${t('bento.widgets.remove')} ${label}`}
              className="grid size-7 shrink-0 place-items-center rounded-full bg-popover/90
                         text-muted-foreground shadow-sm transition-colors
                         hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {/* Two axes rather than a menu of named shapes: five widths and five
              heights is twenty-five sizes from ten controls, and "three wide,
              one tall" is a thing somebody can now ask for. */}
          <div className="flex flex-col gap-1">
            <Axis label={t('bento.widgets.width')} steps={WIDTHS} value={w}
                  onPick={(n) => resize(id, n, h)} />
            <Axis label={t('bento.widgets.height')} steps={HEIGHTS} value={h}
                  onPick={(n) => resize(id, w, n)} />
          </div>
        </div>
      )}
    </div>
  )
}
