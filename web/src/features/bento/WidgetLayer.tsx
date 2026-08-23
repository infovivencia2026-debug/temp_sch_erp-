import { createContext, useContext, useEffect, useMemo, useRef, useState,
         type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft, ArrowRight, Check, GripVertical, Minus, Plus, RotateCcw, Undo2, Wand2, X,
} from 'lucide-react'
import {
  useLayout, dimsOf, tintOf, isRemoved, orderOf, useBoard, publishBoard, clearBoard,
  WIDTHS, DIMS, TINT_STARTS, inkFor, cssHsl, hexToHsl, hslToHex,
  rowsNeeded, PRESETS, BOARD_ROWS,
  type WidgetSize, type BoardWidget,
} from '@/lib/widgets'
import { COL, ROW, spanFor, clampSpan, MAX_SPAN, type CellSpan } from './bento-kit'
import { WidgetSizeContext } from '@/lib/widget-size'
import { WheelCanvas, INK_HERE_FROM_PAGE } from './ColourDialog'
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
  /** The ids that actually fit inside the five-by-three board. A widget not in
      here does not render, however it was declared. */
  fitted: Set<string>
  /** The tallest layout that still fits on this screen, in rows. */
  maxRows: number
}

/* Every domain token a cell might read. Repointing all of them is what lets
   the wrapper recolour a card without knowing which domain the cell asked for. */
const DOMAINS = [
  'academics', 'admissions', 'attendance', 'communication', 'critical',
  'finance', 'operations', 'reports', 'staff', 'students', 'success', 'warning',
] as const

const Ctx = createContext<LayerValue | null>(null)

/* THE SIZES THE BOARD CAN ACTUALLY DRAW.

   `WIDTHS`/`HEIGHTS` in widgets.ts run 1..5 — they are what the STORE accepts,
   because a layout saved before the 2x2 ceiling existed must still load. They
   are not what the board can paint: `clampSpan` folds everything above
   MAX_SPAN back to 2 on the way to `COL`/`ROW`, which only have entries for 1
   and 2.

   So the steppers walk this list instead. A control that offers a 3 is
   offering a width the renderer throws away — the card stays two columns wide,
   the person is told it is three, and every later question about whether the
   board is full is answered about a board nobody is looking at. */
const STEPS: readonly number[] = WIDTHS.filter((n) => n <= MAX_SPAN)

/** The size a placement is DRAWN at, which is the only size any of the
    fit arithmetic below may use.

    `dimsOf` returns what is stored, and what is stored may be a 3 or a 5 —
    from an older layout, from the `spotlight` preset, or from a stepper that
    used to let somebody walk there. Packing those raw numbers counts columns
    the grid never fills: the simulation calls the board full while the screen
    shows an empty column, and every "make this taller" is refused into
    visible space. Same clamp as the wrapper's own `COL`/`ROW`, so the answer
    and the picture are about one board. */
function drawnDims(
  layout: Parameters<typeof dimsOf>[0],
  id: string,
  fallback: WidgetSize,
): { w: number; h: number } {
  const d = dimsOf(layout, id, fallback)
  return { w: clampSpan(d.w), h: clampSpan(d.h) }
}

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
  const barRef = useRef<HTMLDivElement>(null)
  /* Always rendered, unlike the toolbar, so the board element can be reached
     whether or not anybody is arranging. */
  const markRef = useRef<HTMLSpanElement>(null)
  const { arranging, setArranging } = useBoard()
  const { layout, place, reset, undo, canUndo, tidy, applyPreset } = useLayout(dashboard)
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

  /* On the board, or waiting in the tray.

     An explicit placement always wins: it is a decision this person made, and
     it outranks both the removed list and the widget's own default. Failing
     that, a removed widget is off, and an `optional` one has simply never been
     placed — the board ships full without it. */
  const isOn = (d: BoardWidget) => {
    if (layout.placed.some((p) => p.id === d.id)) return true
    if (isRemoved(layout, d.id)) return false
    return !d.optional
  }
  /* Sorted the way the grid lays them out, not the way they mount.

     The cells render in source order and are positioned by CSS `order`, so
     simulating the pack against the mount order answered a question about a
     board nobody sees — and diverged the moment somebody reordered a card.
     Same order in, same rows out. */
  const candidates = declared
    .filter(isOn)
    .slice()
    .sort((a, b) => orderOf(layout, a.id, a.index) - orderOf(layout, b.id, b.index))
  /* THE CEILING, ENFORCED. Five columns, three rows, fifteen slots — and a
     widget that does not fit does not render.

     Everything before this was advisory: the add button was disabled when the
     board was full and a resize was refused past three rows, but `Widget`
     itself only ever checked the removed list, so anything declared painted
     regardless. A dashboard that declared twenty-four cells drew twenty-four
     cells, six rows deep, and the ceiling was a suggestion.

     Packed in declared order against the real `rowsNeeded`. `continue` rather
     than `break`, because the pack is dense: a 1x1 further down the list can
     still drop into a gap a 2x1 could not use. Anything that does not fit is
     offered in the add tray instead of vanishing — the board is capped, not
     the dashboard. */
  const maxRows = BOARD_ROWS
  const fitted = new Set<string>()
  {
    const packed: { w: number; h: number }[] = []
    for (const d of candidates) {
      const dim = drawnDims(layout, d.id, d.size)
      if (rowsNeeded([...packed, dim]) > maxRows) continue
      packed.push(dim)
      fitted.add(d.id)
    }
  }
  /* Published as `visible`: the widgets that actually PAINT, not the ones that
     merely qualified.

     These two had drifted apart the moment the ceiling started dropping cards.
     `Widget` rendered from `fitted` while `fitsAt` simulated the pack against
     everything that qualified — so a card that lost the pack, and therefore
     was not on screen, still took up room in the answer to "can this one
     grow?". The board looked half empty and refused every resize into the gap.
     One list, so the question and the picture are about the same board. */
  const visible = candidates.filter((d) => fitted.has(d.id))
  const off = declared.filter((d) => !fitted.has(d.id))
  const arranged = layout.placed.length > 0 || layout.removed.length > 0

  /* Published so Settings can list this board without being inside it, and
     withdrawn on the way out so a screen with no board cannot be arranged. */
  useEffect(() => {
    publishBoard(dashboard, declared)
  }, [dashboard, declared])

  useEffect(() => () => clearBoard(dashboard), [dashboard])

  /* Escape leaves arrange mode.

     It matters more now that the dock hides while editing: with the chrome
     gone, somebody who does not spot Done at the top of the board has no
     obvious way out, and Escape is the key they will try. */
  useEffect(() => {
    if (!arranging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArranging(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [arranging, setArranging])

  /* Three rows, because the board is three rows.

     No measuring: the grid is a fixed 5x3, so a layout needing a fourth row
     does not get a shorter row, it gets pushed off the bottom of the screen.
     The arranger refuses those sizes rather than letting somebody arrive at
     one and wonder where their card went. */

  /* The board uses the rows it NEEDS, not always three.

     Three equal fractions of a definite height is right when the layout fills
     them. When it does not — nine cards that pack into two rows, which is what
     a board looks like as soon as anyone removes a card — the third row still
     claimed its 196px and the board ended a third of the way up the page with
     black underneath it.

     `rowsNeeded` is already computed for the ceiling, so this costs nothing:
     the same pack that decides what fits decides how tall the board is. Still
     capped at BOARD_ROWS, so the ceiling is unchanged; a two-row layout simply
     gets two taller rows instead of two short ones and a hole. */
  const rowsUsed = Math.max(
    1,
    Math.min(maxRows, rowsNeeded(visible.map((v) => drawnDims(layout, v.id, v.size)))),
  )
  useEffect(() => {
    document.documentElement.style.setProperty('--board-rows', String(rowsUsed))
    return () => {
      document.documentElement.style.removeProperty('--board-rows')
    }
  }, [rowsUsed])

  const value = useMemo<LayerValue>(
    () => ({ dashboard, editing: arranging, declare, visible, fitted, maxRows }),
    [
      dashboard, arranging, declare, maxRows,
      /* Sizes as well as ids, because `visible` is handed to `move` and
         `tidy` as the seed for every widget nobody has explicitly placed. A
         key of ids alone holds the previous render's array — and with it the
         previous render's w/h — so the first reorder after a resize would
         quietly seed that card back at its old size. */
      visible.map((d) => `${d.id}:${d.w}x${d.h}`).join(','),
      [...fitted].join(','),
    ],
  )

  return (
    <Ctx.Provider value={value}>
      <span ref={markRef} className="hidden" aria-hidden="true" />
      {/* Only while arranging, and a grid child either way.

          BentoPage drops its children straight into the board's grid, so this
          has to span the full width and sort first, or it gets crammed into
          one column and the Add chips wrap into an unreadable stack. */}
      {arranging && (
        <div
          ref={barRef}
          className="bento-arrange-bar col-span-full flex flex-wrap items-center gap-2"
          /* THE BAR'S GROUND IS THE PAGE, SO IT DECLARES THE PAGE'S INK.

             Every control in here is drawn from `currentColor` — the borders,
             the hover washes, the divider, the glyphs — which is exactly right
             and was inheriting the wrong colour. Nothing set one, so it fell
             through to <body>, which the layout paints with `--bento-ink`: the
             CARD's ink, measured against `--bento-card` and against nothing
             else. On the default palette that is black, and this bar sits on a
             near-black page. The entire toolbar — Done, the four presets, Undo,
             Tidy up, Reset, Add a card and the hint — measured 1.04-1.06:1.
             Not dim. Gone.

             `--ink-here` is the name the launcher and the dock already give to
             "the colour that reads on me", derived from the ground itself, so
             the whole bar follows one declaration and no colour is named. */
          style={{
            order: -1,
            '--ink-here': INK_HERE_FROM_PAGE,
            color: 'var(--ink-here)',
          } as CSSProperties}
        >
          <button
            type="button"
            onClick={() => setArranging(false)}
            className="flex items-center gap-1.5 rounded-full border !border-current bg-[color-mix(in_srgb,currentColor_12%,transparent)]
                       px-3 py-1.5 text-[12.5px] text-current focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-[var(--ink-here)]"
          >
            <Check className="size-3.5" aria-hidden="true" />
            {t('bento.widgets.done')}
          </button>

          {/* Pick a layout, rather than build one.

              This sits first because it is the path most people should take:
              arrows, sizes and colours are a capable editor, and a capable
              editor is still an editor. Somebody opening their dashboard wants
              a good one, not a canvas. */}
          <span className="flex flex-wrap items-center gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => applyPreset(p, visible)}
                className="rounded-full border !border-[color-mix(in_srgb,currentColor_45%,transparent)] px-2.5 py-1 text-[12px] transition-colors hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]"
              >
                {t(`bento.widgets.preset.${p}`)}
              </button>
            ))}
          </span>

          <span className="h-4 w-px bg-[color-mix(in_srgb,currentColor_22%,transparent)]" aria-hidden="true" />

          {/* Undo first among the editing controls, because it is the one
              somebody reaches for in a hurry — right after the click they did
              not mean. */}
          {canUndo && (
            <button
              type="button"
              onClick={undo}
              className="flex items-center gap-1.5 rounded-full border !border-[color-mix(in_srgb,currentColor_45%,transparent)] px-3 py-1.5 text-[12.5px]
                         transition-colors hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]"
            >
              <Undo2 className="size-3.5" aria-hidden="true" />
              {t('bento.widgets.undo')}
            </button>
          )}

          {/* One click out of a mess, without losing the sizes and colours
              somebody chose deliberately. */}
          <button
            type="button"
            onClick={() => tidy(visible)}
            className="flex items-center gap-1.5 rounded-full border !border-[color-mix(in_srgb,currentColor_45%,transparent)] px-3 py-1.5 text-[12.5px]
                       transition-colors hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]"
          >
            <Wand2 className="size-3.5" aria-hidden="true" />
            {t('bento.widgets.tidy')}
          </button>

          {arranged && (
            <button
              type="button"
              onClick={reset}
              className="flex items-center gap-1.5 rounded-full border !border-[color-mix(in_srgb,currentColor_45%,transparent)] px-3 py-1.5 text-[12.5px]
                         opacity-70 transition-colors hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]
                         hover:opacity-100"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t('bento.widgets.reset')}
            </button>
          )}

          {off.length > 0 && (
            /* A DISCLOSURE, not a wall.

               This printed every widget in the tray inline — thirty-six of
               them on the principal board — which wrapped to four lines, buried
               the rest of the toolbar and pushed the cards down the page. The
               list is now behind a summary that says how many are waiting, and
               it opens only when asked.

               `<details>` rather than a custom menu: it is closed by default,
               it toggles with the keyboard, and it needs no state, no outside
               click handler and no focus trap to be correct. */
            <details className="relative">
              <summary
                className="flex cursor-pointer list-none items-center gap-1.5 rounded-full border
                           px-3 py-1 text-[12px] transition-colors
                           hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)]"
                /* 30% measured 2.59:1 against the page — the same weight the
                   other controls in this bar carry, which is 45%. */
                style={{ borderColor: 'color-mix(in srgb, currentColor 45%, transparent)' }}
              >
                <Plus className="size-3" aria-hidden="true" />
                {t('bento.widgets.add_count', { count: off.length })}
              </summary>
              <div
                className="absolute left-0 top-full z-30 mt-1.5 flex max-h-[280px] w-[320px] flex-col
                           gap-1 overflow-y-auto rounded-[10px] border p-2 shadow-lg"
                /* The tray is a CARD hanging off a bar that is drawn in the
                   PAGE's ink, so it has to say so or its rows inherit the
                   wrong one of the two — white on white the moment the bar
                   above it starts reading correctly. Its edge is mixed from
                   the card's ink for the same reason: `currentColor` here is
                   now the page's. */
                style={{
                  background: 'var(--bento-card)',
                  color: 'var(--bento-ink)',
                  borderColor: 'color-mix(in srgb, var(--bento-ink) 22%, transparent)',
                }}
              >
                {off.map((d) => {
                  /* Would the board still be three rows with this card on it?
                     Simulated against the whole layout, the same way a resize
                     is, because the board is a fixed fifteen slots and a card
                     that does not fit does not get a smaller row — it pushes
                     the bottom row off the screen. */
                  const room =
                    rowsNeeded([
                      ...visible.map((v) => drawnDims(layout, v.id, v.size)),
                      { w: clampSpan(DIMS[d.size].w), h: clampSpan(DIMS[d.size].h) },
                    ]) <= maxRows
                  return (
                    <button
                      key={d.id}
                      type="button"
                      disabled={!room}
                      title={room ? undefined : t('bento.widgets.full')}
                      onClick={() =>
                        place(d.id, clampSpan(DIMS[d.size].w), clampSpan(DIMS[d.size].h))
                      }
                      className="flex w-full items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-left
                                 text-[12px] transition-colors
                                 hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]
                                 disabled:cursor-not-allowed disabled:opacity-40
                                 disabled:hover:bg-transparent"
                    >
                      <Plus className="size-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{d.label}</span>
                    </button>
                  )
                })}
              </div>
            </details>
          )}

          <span className="text-[12px] opacity-60">{t('bento.widgets.hint')}</span>
        </div>
      )}
      {children}
    </Ctx.Provider>
  )
}

/** One axis of the size control: minus, the number, plus.

    The numbered steps that used to sit between the arrows are gone. On a card
    that may itself be one grid unit wide, five buttons plus two arrows was a
    control wider than the thing it was controlling — and the number between
    the arrows already says where on the scale you are. */
function Axis({
  label,
  steps,
  value,
  onPick,
  blocked,
  blockedHint,
}: {
  label: string
  steps: readonly number[]
  value: number
  onPick: (n: number) => void
  /** True for a step that would push the board off the screen. */
  blocked?: (n: number) => boolean
  blockedHint?: string
}) {
  const lo = steps[0]
  const hi = steps[steps.length - 1]
  const allow = (n: number) => (blocked ? !blocked(n) : true)
  const step = (d: number) => {
    const n = Math.min(hi, Math.max(lo, value + d))
    if (allow(n)) onPick(n)
  }
  const nextUp = Math.min(hi, value + 1)
  const upBlocked = value >= hi || !allow(nextUp)

  const arrow =
    'grid size-6 shrink-0 place-items-center rounded-md bg-[var(--bento-card)] text-[var(--bento-ink)] shadow-sm ' +
    'transition-colors hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)] disabled:opacity-30 disabled:hover:bg-[var(--bento-card)]'

  return (
    <div className="flex items-center gap-1">
      <span className="w-3 shrink-0 text-[10px] font-semibold opacity-70">{label}</span>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={value <= lo}
        aria-label={`${label} smaller`}
        className={arrow}
      >
        <Minus className="size-3" aria-hidden="true" />
      </button>
      <span
        role="status"
        aria-live="polite"
        className="w-5 text-center text-[11.5px] font-semibold tabular-nums"
      >
        {value}
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={upBlocked}
        aria-label={
          value < hi && !allow(nextUp) && blockedHint
            ? `${label} bigger — ${blockedHint}`
            : `${label} bigger`
        }
        title={value < hi && !allow(nextUp) ? blockedHint : undefined}
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
      <span className="w-3 shrink-0 text-[10px] font-semibold opacity-70">
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
          className="rounded-full bg-[var(--bento-card)] px-2 py-1 text-[10.5px] shadow-sm hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]"
        >
          {t('bento.widgets.colour_clear')}
        </button>
      )}

      {open && at && createPortal(
        <div
          ref={pop}
          style={{ position: 'fixed', left: at.left, top: at.top, width: 228 }}
          /* Portalled to <body>, so it inherits nothing from the card it
             belongs to: it states its own surface, its own ink and an edge
             heavy enough to separate it from the near-black page, rather than
             the `--bento-line` hairline at 1.38:1. */
          className="z-[80] rounded-xl border p-3 shadow-lg bg-[var(--bento-card)]
                     text-[var(--bento-ink)]
                     !border-[color-mix(in_srgb,var(--bento-ink)_45%,transparent)]"
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
              /* `bg-background` is the PAGE, and this field sits on the
                 popover's paper: on the default palette that is a near-black
                 box with black text in it. The field is a surface on the card,
                 so it takes the card — and the ring is the ink rather than the
                 mint accent, which measures 1.29:1 on that same paper. */
              className="w-full rounded-md border px-2 py-1 font-mono text-[11.5px]
                         bg-[var(--bento-card)] text-[var(--bento-ink)]
                         !border-[color-mix(in_srgb,var(--bento-ink)_45%,transparent)]
                         focus-visible:outline-none focus-visible:ring-2
                         focus-visible:ring-[var(--bento-ink)]"
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
              className="rounded-full border px-2 py-0.5 text-[10.5px] hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]"
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
  optional,
  children,
}: {
  id: string
  label: string
  /** The shape this cell was designed at. The person's choice overrides it. */
  size: WidgetSize
  index: number
  /** Offered in the add tray rather than placed on the board by default. */
  optional?: boolean
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
    declare?.({ id, label, index, size: declaredSize, w, h, optional })
  }, [declare, id, label, index, declaredSize, w, h, optional])

  /* One gate, and it is the board's own answer. `layer.fitted` already folds
     in the removed list, the `optional` default and the three-row ceiling, so
     there is no second opinion here to fall out of step with it — which is
     exactly what happened when this line was `isRemoved` alone. */
  if (layer && !layer.fitted.has(id)) return null
  if (isRemoved(layout, id)) return null

  const order = orderOf(layout, id, index)
  const editing = layer?.editing ?? false
  /* Clamped to the 2x2 ceiling here as well as inside spanFor, because these
     two feed the geometry directly: an unclamped 3 would miss the lookup, the
     class would be undefined, and the cell would silently shrink to one column
     instead of failing where somebody would see it. */
  const cw = clampSpan(w)
  const ch = clampSpan(h)
  const span = spanFor(cw, ch)
  const pos = layer ? layer.visible.findIndex((v) => v.id === id) : 0
  const moveBtn =
    'grid size-6 shrink-0 place-items-center rounded-md bg-[var(--bento-card)] text-[var(--bento-ink)] shadow-sm ' +
    'transition-colors hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)] disabled:opacity-30 disabled:hover:bg-[var(--bento-card)]'
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
  /* Would the board still fit if this card were that size?

     Simulated against the WHOLE layout, not just this card, because a card
     growing pushes everything after it — the row that overflows is usually not
     the one being edited. The current size is always allowed even when the
     board already overflows, or somebody who arrived at a too-tall layout
     could never shrink out of it. */
  const fitsAt = (nw: number, nh: number) => {
    if (!layer) return true
    const pw = clampSpan(nw)
    const ph = clampSpan(nh)
    if (pw === cw && ph === ch) return true
    /* `layer.visible` is the list that PAINTS — candidates that won the pack,
       not everything that qualified — and each of them is measured at the size
       it is drawn at. Both halves matter: simulate against the qualifiers and
       a card that is not on screen still eats the gap it left; simulate raw
       dims and a stored 3 eats a column the grid never gave it. */
    const items = layer.visible.map((v) =>
      v.id === id ? { w: pw, h: ph } : drawnDims(layout, v.id, v.size),
    )
    return rowsNeeded(items) <= layer.maxRows
  }

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
      className={cn('bento-widget relative min-w-0 [&>*]:h-full', COL[cw], ROW[ch])}
      style={{ order }}
      /* The two data attributes are what lets a cell's CONTENTS answer to its
         size — see the [data-w]/[data-h] rules in index.css. Doing it in CSS
         from one wrapper means thirty hand-written cells did not each have to
         learn how to be small. */
      data-w={cw}
      data-h={ch}
      /* So the few things that keep a FIXED colour — the error sentence's pink
         — can follow the card's derived ink instead once it has been tinted.
         A pink measured against a white card says nothing on a deep navy. */
      data-tinted={tint ? 'true' : undefined}
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
      <div className="h-full [&>*]:h-full" style={paint}>
        {/* The cell is told how much room it has, so the few that should draw
            themselves differently at different sizes can. Most ignore it and
            let the CSS shedding rules do the work. */}
        <WidgetSizeContext.Provider value={{ w: cw, h: ch }}>
          {children(span)}
        </WidgetSizeContext.Provider>
      </div>

      {editing && (
        <div
          className="absolute inset-0 z-10 flex flex-col justify-between gap-2 overflow-auto
                     rounded-[var(--bento-radius)] bg-[color-mix(in_srgb,var(--bento-bg)_28%,transparent)] p-2 backdrop-blur-[2px]"
          /* The scrim is the PAGE at seventy per cent, so its ink is the
             page's and not the card's.

             `bg-[color-mix(in_srgb,var(--bento-bg)_28%,transparent)]` resolves to `--bento-bg` — correct, and the
             reason the cards go dark under it — while the labels underneath
             kept inheriting `--bento-ink`, which is measured against the card.
             On the default palette that put black letters on a near-black
             wash: the O/W/H/C axis labels and every "3 / 7" counter measured
             1.04:1, on the one screen whose whole purpose is those controls.

             The chips inside are their own card-coloured surfaces and restate
             the card's ink, below. */
          style={{
            '--ink-here': INK_HERE_FROM_PAGE,
            color: 'var(--ink-here)',
          } as CSSProperties}
        >
          <div className="flex items-start justify-between gap-2">
            {/* A chip made of card takes the card's ink, whatever the scrim
                around it is made of. */}
            <span className="flex min-w-0 items-center gap-1 rounded-full bg-[var(--bento-card)]
                             px-2 py-1 text-[11px] font-medium text-[var(--bento-ink)] shadow-sm">
              <GripVertical className="size-3 shrink-0 cursor-grab opacity-70" aria-hidden="true" />
              <span className="truncate">{label}</span>
            </span>
            <button
              type="button"
              onClick={() => remove(id)}
              aria-label={`${t('bento.widgets.remove')} ${label}`}
              className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--bento-card)]
                         text-[var(--bento-ink)] opacity-70 shadow-sm transition-colors
                         hover:bg-destructive hover:text-destructive-foreground hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {/* Two axes rather than a menu of named shapes: five widths and five
              heights is twenty-five sizes from ten controls, and "three wide,
              one tall" is a thing somebody can now ask for. */}
          <div className="flex flex-col gap-1">
            {/* Move, by pressing rather than by dragging.

                Dragging was the only way to reorder, and it is the wrong
                gesture for this board: cards pack densely, so releasing one
                somewhere sends every card after it shuffling to fill holes
                that were never visible. The result rarely matches the gesture,
                which is why the order felt unpredictable.

                A press moves this card one place along the flow. It is
                undoable, it is repeatable, and it says which direction it
                means. Dragging still works for anybody who prefers it. */}
            <div className="flex items-center gap-1">
              <span className="w-3 shrink-0 text-[10px] font-semibold opacity-70">
                {t('bento.widgets.order')}
              </span>
              <button
                type="button"
                onClick={() => layer && move(id, Math.max(0, pos - 1), layer.visible)}
                disabled={pos <= 0}
                aria-label={t('bento.widgets.move_back')}
                className={moveBtn}
              >
                <ArrowLeft className="size-3" aria-hidden="true" />
              </button>
              <span className="w-8 text-center text-[11px] tabular-nums opacity-70">
                {pos + 1}/{layer?.visible.length ?? 1}
              </span>
              <button
                type="button"
                onClick={() => layer && move(id, Math.min(layer.visible.length - 1, pos + 1), layer.visible)}
                disabled={!layer || pos >= layer.visible.length - 1}
                aria-label={t('bento.widgets.move_on')}
                className={moveBtn}
              >
                <ArrowRight className="size-3" aria-hidden="true" />
              </button>
            </div>

            <Axis
              label={t('bento.widgets.width')}
              steps={STEPS}
              value={cw}
              onPick={(n) => resize(id, n, ch)}
              blocked={(n) => !fitsAt(n, ch)}
              blockedHint={t('bento.widgets.wont_fit')}
            />
            <Axis
              label={t('bento.widgets.height')}
              steps={STEPS}
              value={ch}
              onPick={(n) => resize(id, cw, n)}
              blocked={(n) => !fitsAt(cw, n)}
              blockedHint={t('bento.widgets.wont_fit')}
            />

            {/* The wheel, not a menu of colours.

                A fixed palette keeps a board looking like one product, which is
                why it was tried first — but it also means the one colour
                somebody wants is the one that is not there. The starting points
                below the wheel are exactly that: places to begin, not the
                choices on offer. */}
            <ColourPick value={tint} onPick={(c) => recolour(id, c, cw, ch)} />
          </div>
        </div>
      )}
    </div>
  )
}
