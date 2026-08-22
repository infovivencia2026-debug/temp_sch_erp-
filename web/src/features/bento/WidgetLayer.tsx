import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, GripVertical, Minus, Plus, RotateCcw, X } from 'lucide-react'
import {
  useLayout, dimsOf, tintOf, isRemoved, orderOf, useBoard, publishBoard, clearBoard,
  WIDTHS, HEIGHTS, DIMS, TINT_STARTS, inkFor, cssHsl, hexToHsl, hslToHex,
  type WidgetSize, type BoardWidget,
} from '@/lib/widgets'
import { COL, ROW, spanFor, type CellSpan } from './bento-kit'
import { WheelCanvas } from './ColourDialog'
import type { Hsl } from '@/lib/paint'
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

/* Every domain token a cell might read. Repointing all of them is what lets
   the wrapper recolour a card without knowing which domain the cell asked for. */
const DOMAINS = [
  'academics', 'admissions', 'attendance', 'communication', 'critical',
  'finance', 'operations', 'reports', 'staff', 'students', 'success', 'warning',
] as const

const Ctx = createContext<LayerValue | null>(null)

/* Not exported, and that is load-bearing rather than tidiness.

   A module that exports both components and a non-component breaks Vite's Fast
   Refresh ("export is incompatible"), which falls back to invalidating the
   module. Re-evaluating this file builds a NEW context object, so <Widget>
   starts reading a different context than <WidgetLayer> is filling: the layer
   reads as absent, and every control on the board goes dead until a full
   reload. A dev-only failure, but one that looks exactly like the feature
   being broken. */
function useWidgetLayer() {
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

/** One row of the size control: a stepper, with the numbered steps beside it.

    The steppers are what a person reaches for — "one wider" is the thought,
    not "four". The numbers stay because a stepper alone hides how much room
    there is: with them you can see that five is the end of the axis and jump
    straight there. Each end disables at its limit rather than wrapping, so
    nothing silently jumps from widest to narrowest. */
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
  const lo = steps[0]
  const hi = steps[steps.length - 1]
  const step = (delta: number) => onPick(Math.min(hi, Math.max(lo, value + delta)))

  const arrow =
    'grid size-6 shrink-0 place-items-center rounded-md bg-popover/90 shadow-sm ' +
    'transition-colors hover:bg-accent disabled:opacity-35 disabled:hover:bg-popover/90'

  return (
    <div className="flex items-center gap-1">
      <span className="w-3 shrink-0 text-[10px] font-semibold text-muted-foreground">{label}</span>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={value <= lo}
        aria-label={`${label} smaller`}
        className={arrow}
      >
        <Minus className="size-3" aria-hidden="true" />
      </button>
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
      <button
        type="button"
        onClick={() => step(1)}
        disabled={value >= hi}
        aria-label={`${label} bigger`}
        className={arrow}
      >
        <Plus className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}

/** The colour control: a swatch that opens the product's own wheel.

    Portaled and fixed-positioned because the card it belongs to may be one
    grid cell across — a popover rendered inside it would be clipped to
    something smaller than the wheel. */
function ColourPick({
  value,
  onPick,
}: {
  value: Hsl | null
  onPick: (c: Hsl | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  /* The typed value is held apart from the committed colour. Somebody typing
     "#1a2b3c" passes through "#1", "#1a", "#1a2" — all unparseable — and a
     field driven straight from the colour would fight the cursor and blank
     itself mid-word. */
  const [typed, setTyped] = useState<string | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const t = useT()

  // Held locally so dragging the lightness slider does not write a layout on
  // every animation frame.
  const current = value ?? TINT_STARTS[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node
      // Both boxes: the popover is portaled, so it is not a DOM descendant of
      // the button that opens it.
      if (!btn.current?.contains(n) && !pop.current?.contains(n)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="flex items-center gap-1">
      <span className="w-3 shrink-0 text-[10px] font-semibold text-muted-foreground">
        {t('bento.widgets.colour')}
      </span>
      <button
        ref={btn}
        type="button"
        aria-label={t('bento.widgets.colour')}
        aria-expanded={open}
        onClick={() => {
          const r = btn.current?.getBoundingClientRect()
          if (r) {
            setAt({
              left: Math.min(r.left, window.innerWidth - 236),
              top: Math.min(r.bottom + 6, window.innerHeight - 300),
            })
          }
          setOpen((v) => !v)
        }}
        className="size-6 rounded-full border-2 border-white shadow-sm transition-transform hover:scale-110"
        style={{ background: value ? cssHsl(value) : 'var(--bento-card)' }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onPick(null)}
          title={t('bento.widgets.colour_default')}
          aria-label={t('bento.widgets.colour_default')}
          className="rounded-full bg-popover/90 px-2 py-1 text-[10.5px] shadow-sm hover:bg-accent"
        >
          {t('bento.widgets.colour_clear')}
        </button>
      )}

      {open && at && createPortal(
        <div
          ref={pop}
          style={{ position: 'fixed', left: at.left, top: at.top, width: 228 }}
          className="z-[80] rounded-xl border bg-popover p-3 shadow-lg"
        >
          <WheelCanvas value={current} onPick={(h, s2) => onPick({ ...current, h, s: s2 })} />
          <input
            type="range"
            min={5}
            max={95}
            value={Math.round(current.l)}
            aria-label={t('bento.widgets.colour_lightness')}
            onChange={(e) => onPick({ ...current, l: Number(e.target.value) })}
            className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-full"
            style={{
              background: `linear-gradient(to right, hsl(${current.h} ${current.s}% 5%), hsl(${current.h} ${current.s}% 50%), hsl(${current.h} ${current.s}% 95%))`,
            }}
          />
          {/* Typed in, for the colour that arrived from a brand book rather
              than from a wheel. */}
          <div className="mt-3 flex items-center gap-1.5">
            <input
              type="text"
              spellCheck={false}
              aria-label={t('bento.widgets.colour_hex')}
              placeholder="#4f7fff"
              value={typed ?? hslToHex(current)}
              onChange={(e) => {
                setTyped(e.target.value)
                const parsed = hexToHsl(e.target.value)
                // Only a COMPLETE colour is committed, so the card does not
                // flash through every shade on the way to the one being typed.
                if (parsed) onPick(parsed)
              }}
              onBlur={() => setTyped(null)}
              className="w-full rounded-md border bg-background px-2 py-1 font-mono text-[11.5px]
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span
              aria-hidden="true"
              className="size-6 shrink-0 rounded-md border"
              style={{ background: cssHsl(current) }}
            />
          </div>

          <div className="mt-2 flex items-center justify-between gap-1">
            {TINT_STARTS.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onPick(c)}
                aria-label={cssHsl(c)}
                className="size-5 rounded-full border shadow-sm transition-transform hover:scale-110"
                style={{ background: cssHsl(c) }}
              />
            ))}
            <button
              type="button"
              onClick={() => onPick(null)}
              className="rounded-full border px-2 py-0.5 text-[10.5px] hover:bg-accent"
            >
              {t('bento.widgets.colour_clear')}
            </button>
          </div>
        </div>,
        document.body,
      )}
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
  const { layout, remove, resize, recolour, move } = useLayout(layer?.dashboard ?? 'default')
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
  const tint = tintOf(layout, id)

  /* Recolouring by REPOINTING the palette, not by painting the card.

     Cell writes `background: var(--dom-finance)` as an inline style, and an
     inline style cannot be overridden from a stylesheet — but a custom property
     inherits, so redefining --dom-finance on this wrapper changes what that
     inline style resolves to for everything inside it.

     Every domain is repointed rather than only the card's own, because the
     wrapper does not know which domain the cell inside it asked for. The badges
     nested in the card follow the same variables, so they stay in step instead
     of keeping the old family's colour.

     The ink is DERIVED from the chosen colour, not chosen alongside it. An open
     wheel can produce a pale yellow and a near-black navy, and nobody picking a
     background should also have to work out whether their text now needs to be
     white. */
  const paint: Record<string, string> = {}
  if (tint) {
    const bg = cssHsl(tint)
    const ink = inkFor(tint)
    for (const d of DOMAINS) {
      paint[`--dom-${d}`] = bg
      paint[`--dom-${d}-text`] = ink
    }
    // The card's own ink, for the parts that read the bento tokens rather than
    // a domain one — the label and any supporting sentence.
    paint['--bento-ink'] = ink
    paint['--bento-muted'] = ink === '#ffffff'
      ? 'rgba(255,255,255,0.72)'
      : 'rgba(16,17,20,0.62)'
  }

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
      {/* The repointed palette is scoped to the CELL, not to the wrapper.

          Put it on the wrapper and the edit overlay inherits it too — and since
          a tint makes every --dom-* resolve to the same colour, the nine colour
          swatches inside the overlay would all render as nine identical
          circles. The control for choosing a colour cannot live inside the
          thing the colour is applied to. */}
      <div className="h-full [&>*]:h-full" style={paint}>{children(span)}</div>

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

            {/* The wheel, not a menu of colours.

                A fixed palette keeps a board looking like one product, which is
                why it was tried first — but it also means the one colour
                somebody wants is the one that is not there. The starting points
                below the wheel are exactly that: places to begin, not the
                choices on offer. */}
            <ColourPick value={tint} onPick={(c) => recolour(id, c, w, h)} />
          </div>
        </div>
      )}
    </div>
  )
}
