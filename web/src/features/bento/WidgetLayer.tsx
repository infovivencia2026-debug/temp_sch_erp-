import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, GripVertical, Plus, RotateCcw, Settings2, X } from 'lucide-react'
import { useLayout, sizeOf, isRemoved, orderOf, SIZES, type WidgetSize } from '@/lib/widgets'
import { SPAN, type CellSpan } from './bento-kit'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/* Arranging the dashboard, the way a phone home screen is arranged.

   The hard part was not the controls, it was avoiding a rewrite. Every cell on
   these dashboards is hand-written JSX with its own queries and its own
   layout; turning them into records in a registry would have meant rebuilding
   each one and reviewing all of it at once.

   So a widget declares itself where it already is. <Widget id size> wraps the
   cell that was already written, tells the layer it exists, and decides
   whether to render it and at what span. Order comes from CSS `order` rather
   than from moving JSX, which is what lets somebody rearrange a board whose
   source order never changes.

   The cost of that choice, stated: a removed widget's queries do not run,
   because it renders nothing — which is the behaviour you want — but the
   component must be mounted for the layer to know it exists at all. Widgets
   are therefore declared by rendering them, and the "add" list is built from
   what declared itself this render rather than from a manifest. */

const SPAN_OF: Record<WidgetSize, CellSpan> = {
  small: 'one',
  medium: 'wide',
  large: 'anchor',
  full: 'full',
}

interface Declared {
  id: string
  label: string
  index: number
  /* Its own default size, carried because two things need it and neither can
     work it out: putting a widget back on the board, and reordering without
     resizing everything that was never touched. */
  size: WidgetSize
}

interface LayerValue {
  dashboard: string
  editing: boolean
  declare: (w: Declared) => void
  visible: Declared[]
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
  const [editing, setEditing] = useState(false)
  const [declared, setDeclared] = useState<Declared[]>([])
  const { layout, place, reset } = useLayout(dashboard)
  const t = useT()

  const declare = useMemo(
    () => (w: Declared) =>
      setDeclared((prev) => (prev.some((d) => d.id === w.id) ? prev : [...prev, w])),
    [],
  )

  const visible = declared.filter((d) => !isRemoved(layout, d.id))
  const off = declared.filter((d) => isRemoved(layout, d.id))
  const arranged = layout.placed.length > 0 || layout.removed.length > 0

  const value = useMemo<LayerValue>(
    () => ({ dashboard, editing, declare, visible }),
    [dashboard, editing, declare, visible.map((d) => d.id).join(',')],
  )

  return (
    <Ctx.Provider value={value}>
      {/* The control sits above the board rather than in the dock: it belongs
          to this dashboard, and a global chrome button would be offering to
          edit whatever happened to be on screen. */}
      {/* A grid child, because BentoPage drops its children straight into the
          four-column grid — so this has to span the full width and sort first,
          or the toolbar gets crammed into one column and the Add chips wrap
          into an unreadable stack. order:-1 keeps it above the cards without
          depending on being written before them. */}
      <div
        className="col-span-full flex flex-wrap items-center gap-2"
        style={{ order: -1 }}
      >
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={cn(
            `flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px]
             transition-colors focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-ring`,
            editing ? 'border-primary bg-primary-soft text-primary' : 'hover:bg-accent',
          )}
        >
          {editing
            ? <Check className="size-3.5" aria-hidden="true" />
            : <Settings2 className="size-3.5" aria-hidden="true" />}
          {t(editing ? 'bento.widgets.done' : 'bento.widgets.edit')}
        </button>

        {editing && arranged && (
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

        {editing && off.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-muted-foreground">{t('bento.widgets.add')}</span>
            {off.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => place(d.id, d.size)}
                className="flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1
                           text-[12px] transition-colors hover:bg-accent"
              >
                <Plus className="size-3" aria-hidden="true" />
                {d.label}
              </button>
            ))}
          </span>
        )}

        {editing && (
          <span className="text-[12px] text-muted-foreground">{t('bento.widgets.hint')}</span>
        )}
      </div>
      {children}
    </Ctx.Provider>
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
  size: WidgetSize
  index: number
  /** Given the span to render at, because the cell owns its own <Cell>. */
  children: (span: CellSpan) => ReactNode
}) {
  const layer = useWidgetLayer()
  const { layout, remove, resize, move } = useLayout(layer?.dashboard ?? 'default')
  const t = useT()

  /* Declared in an effect, not in the render body.

     Calling the parent's setState while rendering a child is illegal in React
     — it logs "cannot update a component while rendering a different one" and
     can drop the render it was in the middle of. The add-list being one paint
     behind is not worth that; a removed widget still runs its effects, so it
     still reports itself and can still be put back. */
  useEffect(() => {
    layer?.declare({ id, label, index, size: declaredSize })
  }, [layer, id, label, index, declaredSize])

  if (isRemoved(layout, id)) return null

  const size = sizeOf(layout, id, declaredSize)
  const order = orderOf(layout, id, index)
  const editing = layer?.editing ?? false

  return (
    <div
      /* The span classes belong HERE, on the wrapper.

         This div is the grid child; the Cell inside it is not. Cell applies
         SPAN[span] to its own root, which does nothing once it is a level down
         — so with the classes only on the Cell, every size in the arranger was
         accepted, stored, and had no visible effect whatsoever.

         Cell is still handed the span, because it also uses it for its own
         typography — the anchor draws a bigger figure. Only the grid geometry
         moved out, which is also why the Cell's own copy of the span classes
         is left in place and inert rather than stripped: one owner for the
         geometry, and the cell keeps working if it is ever used un-wrapped.

         [&>*]:h-full is not decoration. The cell used to BE the grid child and
         was stretched by the row track; now the wrapper is stretched and the
         cell inside sizes to its content, so the 2x2 hero would sit at half
         height with a gap under it. */
      className={cn('relative min-w-0 [&>*]:h-full', SPAN[SPAN_OF[size]])}
      style={{ order }}
      /* Reordering by drop rather than by arrow buttons: this is a home
         screen, and dragging is the gesture people already have for it. The
         native API is enough here — the items are grid children, so nothing
         needs to be measured or animated by hand. */
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
      {children(SPAN_OF[size])}

      {editing && (
        <div
          className="absolute inset-0 z-10 flex flex-col justify-between rounded-[var(--bento-radius)]
                     bg-background/70 p-2 backdrop-blur-[2px]"
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
              className="grid size-7 place-items-center rounded-full bg-popover/90 text-muted-foreground
                         shadow-sm transition-colors hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => resize(id, s, declaredSize)}
                aria-pressed={size === s}
                className={cn(
                  'rounded-full px-2 py-1 text-[11px] shadow-sm transition-colors',
                  size === s
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'bg-popover/90 hover:bg-accent',
                )}
              >
                {t(`bento.widgets.size.${s}`)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

