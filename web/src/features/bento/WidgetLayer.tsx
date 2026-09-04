import { createContext, useContext, useEffect, useMemo, useRef, useState,
         type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useSwipeUpForAll } from './swipe-up-launcher'
import { buzz } from '@/lib/haptics'
import { openLauncher } from './launcher-open'
import {
  ArrowLeft, ArrowRight, Check, GripVertical, Minus, Plus, RotateCcw, Undo2, Wand2, X,
} from 'lucide-react'
import {
  useLayout, dimsOf, tintOf, isRemoved, orderOf, useBoard, publishBoard, clearBoard,
  WIDTHS, DIMS, TINT_STARTS, softTintBg, inkFor, cssHsl, hexToHsl, hslToHex,
  rowsNeeded, PRESETS, BOARD_ROWS,
  paginate, pageCount, PHONE_COLS, PHONE_ROWS,
  type WidgetSize, type BoardWidget, type Spot,
} from '@/lib/widgets'
import { usePhone } from '@/lib/viewport'
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
  /* THE PHONE'S TWO DIFFERENCES, PUBLISHED SO THE CELLS AGREE WITH THE PACK.

     `phone` is not "is the screen narrow" — it is "does overflow open a page
     instead of dropping a card". Every question of the form "will this still
     fit?" has to read it, because on a phone the honest answer is always yes:
     a size that does not fit the page it is on fits the page after it, and
     refusing it would be refusing something the layout can express.

     `spots` is where the pack actually put each widget. Null whenever the
     board is not paged — every width above the phone, and the phone itself
     while somebody is arranging, where the board goes back to the stacked
     scrolling list so that the editing controls are reachable. */
  phone: boolean
  spots: Map<string, Spot> | null
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
  /* ON A PHONE THE CEILING IS A PAGE BREAK, NOT A CEILING.

     The paragraph above is the desktop board's rule and it is still right
     there. It is wrong on a phone, and quietly so: the pack it describes is
     against a FIVE-column board, which no phone ever draws, so what rendered
     at 390px was the desktop-fitted subset stacked in one column. A widget
     somebody had put on what they think of as their second screen did not
     exist on their phone at all, and nothing said so.

     So the phone keeps every candidate and lets `paginate` decide which page
     each one lands on. Nothing is dropped, which means `off` — and with it the
     add tray — holds only what this person removed by hand, which is the
     honest content of a tray on a board with no ceiling. */
  const phone = usePhone()
  const maxRows = BOARD_ROWS
  const fitted = new Set<string>()
  if (phone) {
    for (const d of candidates) fitted.add(d.id)
  } else {
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
    /* Nothing to say on a phone. `--board-rows` is read by the fixed-height
       board rules, which live behind `min-width: 1024px`; a phone's pages take
       their three rows from the stylesheet's own repeat(). Writing a number
       here that describes a five-column pack no phone draws would be a value
       that is inert today and misleading the first time somebody reads it. */
    if (phone) return
    document.documentElement.style.setProperty('--board-rows', String(rowsUsed))
    return () => {
      document.documentElement.style.removeProperty('--board-rows')
    }
  }, [rowsUsed, phone])

  /* THE HOME SCREEN: WHERE EACH CARD SITS, AND HOW MANY PAGES THAT MAKES.

     Only while the board is being read, not while it is being edited. Arrange
     mode puts a toolbar and a per-card overlay on the board, and both want
     room the pages do not have — a 2x3 page has no spare row for a toolbar,
     and the size steppers sit on top of a tile a third of a phone tall. So on
     a phone, arranging drops back to the stacked scrolling board that shipped
     before any of this, which is a list rather than a home screen but is a
     list you can actually work in. Paging is read-only, on purpose: moving a
     card BETWEEN pages needs a stored page index, and `layout.placed` has no
     such field to put one in. */
  /* THE PAGER NEEDS A BOARD, AND TWO DASHBOARDS DO NOT HAVE ONE.

     Every pager rule in bento-theme.css is written against
     `.bento-board[data-pager]`, and the attribute is set on the layer's own
     ancestor board below. The parent and faculty homes render this layer
     OUTSIDE the board, straight into the scrolling `.bento-surface`, so that
     lookup comes back null and nothing is ever marked.

     Paging regardless is the failure this guard exists for. `spots` still
     packed the cards onto pages and each wrapper still got
     `grid-column: page * 2 + col + 1`, so on those two boards the cards packed
     onto page two were placed in a column the page container has no track for.
     Measured on the live parent home at 390px they came out 28px wide - card
     padding and nothing else - clipped against the right edge of the screen,
     with no dots and no way to scroll to them. Two of the parent's five cards
     were simply not readable.

     Read after mount rather than from a prop because only the DOM knows: it is
     the shape of the tree this layer was dropped into, and the layer is handed
     no say in it. Until it is known the answer is "no pager", which is the
     stacked scrolling board every one of these screens shipped with. */
  const [inBoard, setInBoard] = useState(false)
  useEffect(() => {
    setInBoard(!!markRef.current?.closest('.bento-board'))
  })

  const paged = phone && !arranging && inBoard
  /* Exactly the condition that makes this a home screen: a phone, a real
     board, and not in the middle of rearranging it. The same three facts that
     turn on paging turn on the swipe. */
  useSwipeUpForAll(paged, openLauncher)
  const spots = useMemo(() => {
    if (!paged) return null
    return paginate(
      visible.map((v) => ({ id: v.id, ...drawnDims(layout, v.id, v.size) })),
      PHONE_COLS,
      PHONE_ROWS,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paged, visible.map((v) => `${v.id}:${v.w}x${v.h}`).join(','), layout])
  const pages = spots ? pageCount(spots) : 0
  const spotMap = useMemo(
    () => (spots ? new Map(spots.map((s) => [s.id, s])) : null),
    [spots],
  )

  /* The pager is switched on from here, on the element BentoPage owns.

     BentoPage draws `.bento-board`; this layer is rendered inside it and its
     children ARE the board's grid children. So the layer knows the page count
     and the board element does not, and the board element is the thing that
     has to become a horizontal scroller. Reaching it through the marker span —
     which exists for exactly this, and until now was reached by nothing — is
     less machinery than threading a second context through a component that
     has no other reason to know about widgets.

     It is also the honest gate. A BentoPage with no WidgetLayer inside it (two
     dashboards declare their cells without one) never sets the attribute, so
     it keeps the stacked board it has always had rather than becoming a pager
     with no pages in it. */
  useEffect(() => {
    const board = markRef.current?.closest('.bento-board') as HTMLElement | null
    if (!board || !paged) return
    board.setAttribute('data-pager', '')
    return () => board.removeAttribute('data-pager')
  }, [paged])

  /* HOLD A CARD TO ARRANGE THE BOARD.

     Arrange mode is entered from Settings, for the reason set out at the top
     of this file: a permanent Edit button is chrome that every reader pays for
     so that the few who rearrange can find it. That argument is about chrome,
     and a gesture is not chrome. It costs nothing to anybody who does not make
     it, and it is the gesture every phone home screen has trained people to
     try on a grid of tiles. The settings door stays exactly where it was.

     Touch only. A mouse has no long press worth the name, and holding the
     button down on a desktop is how somebody selects text.

     It has to refuse more often than it fires, because the board it sits on is
     a horizontal pager and the page under it scrolls vertically. So: one
     finger, cancelled by any movement past the slop, by a second finger, by
     the pointer leaving, and by any scroll. Half a second, which is the
     platform's own long-press timeout.

     The click that follows a long press is suppressed once, in the capture
     phase, because every cell is wrapped in a link and opening a screen is the
     opposite of what the reader just asked for. */
  useEffect(() => {
    const board = markRef.current?.closest('.bento-board') as HTMLElement | null
    if (!board || arranging) return

    let timer: number | undefined
    let from: { x: number; y: number } | null = null
    const SLOP = 10
    const HOLD = 500

    const cancel = () => {
      window.clearTimeout(timer)
      timer = undefined
      from = null
    }
    const swallowNextClick = () => {
      const once = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
      }
      window.addEventListener('click', once, { capture: true, once: true })
      // If no click follows -- a hold that ends outside any link -- the
      // listener would sit there and eat the reader's NEXT tap instead.
      window.setTimeout(
        () => window.removeEventListener('click', once, { capture: true }),
        400,
      )
    }

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || !e.isPrimary) return cancel()
      from = { x: e.clientX, y: e.clientY }
      timer = window.setTimeout(() => {
        from = null
        // A short buzz, where the platform offers one. Entering a mode with no
        // physical acknowledgement is how a long press feels like a bug.
        // Through buzz(), so the app's own haptic click is used when there is
        // one; a bare vibrate() is silent on the first press after a load.
        buzz('open')
        swallowNextClick()
        setArranging(true)
      }, HOLD)
    }
    const move = (e: PointerEvent) => {
      if (!from) return
      if (Math.abs(e.clientX - from.x) > SLOP || Math.abs(e.clientY - from.y) > SLOP) cancel()
    }

    board.addEventListener('pointerdown', down)
    board.addEventListener('pointermove', move)
    board.addEventListener('pointerup', cancel)
    board.addEventListener('pointercancel', cancel)
    board.addEventListener('pointerleave', cancel)
    // Capture, because the scroller that moves is the page or the pager, not
    // the board, and a scroll that starts on a card must not become a hold.
    window.addEventListener('scroll', cancel, true)

    return () => {
      cancel()
      board.removeEventListener('pointerdown', down)
      board.removeEventListener('pointermove', move)
      board.removeEventListener('pointerup', cancel)
      board.removeEventListener('pointercancel', cancel)
      board.removeEventListener('pointerleave', cancel)
      window.removeEventListener('scroll', cancel, true)
    }
  }, [arranging, setArranging, paged])

  const value = useMemo<LayerValue>(
    () => ({ dashboard, editing: arranging, declare, visible, fitted, maxRows, phone, spots: spotMap }),
    [
      dashboard, arranging, declare, maxRows, phone, spotMap,
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
                  /* A phone board is never full, so nothing here is ever
                     refused. The fifteen slots are the DESKTOP board's, and on
                     a phone a sixteenth card is not a card that does not fit,
                     it is the first card on page three. Asking the desktop
                     question here would grey out an Add button for a board
                     with room in it. */
                  const room =
                    phone ||
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

      {/* ONE EMPTY ELEMENT PER PAGE, AND IT IS WHAT MAKES THE PAGER SNAP.

          CSS scroll snapping has no notion of "every 390 pixels": a snap
          position exists only where an ELEMENT declares one. The cards cannot
          declare them — half of them start mid-page, so mandatory snapping
          would stop the scroll on the second column of page one, which is the
          behaviour of a carousel with the wrong stride and not of a home
          screen.

          So each page gets a child of its own, placed across that page's two
          columns and all three rows, carrying the only `scroll-snap-align` in
          the board. It paints nothing, takes no pointer events and is hidden
          from assistive technology — the dots below are the accessible way to
          move between pages. The cards sit on top of it because they come
          later in the DOM at the same z-index, which is all the stacking this
          needs.

          Rendered after `children` so that a card and its page never argue
          about paint order in the one direction that would matter. */}
      {paged &&
        Array.from({ length: pages }, (_, i) => (
          <span
            key={`bento-page-${i}`}
            className="bento-page"
            data-page={i}
            aria-hidden="true"
            style={{
              gridColumn: `${i * PHONE_COLS + 1} / span ${PHONE_COLS}`,
              gridRow: `1 / span ${PHONE_ROWS}`,
            }}
          />
        ))}

      {/* Portalled to the body, like the dock, because the board is the
          scroller and anything drawn inside it scrolls away with page one. */}
      {paged && pages > 1 && createPortal(<PageDots pages={pages} mark={markRef} />, document.body)}
    </Ctx.Provider>
  )
}

/* THE PAGE DOTS, WHICH ARE ALSO THE PAGE CONTROL.

   iOS draws them as decoration and moves between pages by swiping, which is
   fine on a phone and leaves a keyboard and a screen reader with no way at all
   to reach page two. So they are a real tablist of real buttons: tap one and
   the page scrolls to it, tab to them and the arrow keys are the browser's own
   roving focus.

   The active page comes from an IntersectionObserver over the page elements
   rather than from arithmetic on scrollLeft. Scroll arithmetic has to know the
   gap, the column width and the direction of the writing system to turn an
   offset into an index, and it is wrong for a frame after every resize.
   "Which page element is mostly on screen" is the same question asked in a
   form the browser already answers. */
/* The ref is typed structurally rather than as React.RefObject, because that
   type changed shape between React 18 and 19 (`current` gained the null) and
   this is the one property either version guarantees. */
function PageDots({ pages, mark }: { pages: number; mark: { current: HTMLSpanElement | null } }) {
  const t = useT()
  const [at, setAt] = useState(0)

  useEffect(() => {
    const board = mark.current?.closest('.bento-board') as HTMLElement | null
    if (!board) return
    const seen = Array.from(board.querySelectorAll<HTMLElement>('.bento-page'))
    if (seen.length === 0) return
    /* Against the board, not the viewport: the pages scroll inside it, and a
       root of null would measure them against the glass and count the dock. */
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const n = Number(e.target.getAttribute('data-page'))
          if (!Number.isNaN(n)) {
            setAt((was) => {
              // A page landing, not the first observation on mount.
              if (was !== n) buzz('select')
              return n
            })
          }
        }
      },
      { root: board, threshold: 0.6 },
    )
    for (const el of seen) io.observe(el)
    return () => io.disconnect()
  }, [mark, pages])

  const go = (n: number) => {
    const board = mark.current?.closest('.bento-board') as HTMLElement | null
    const page = board?.querySelector<HTMLElement>(`.bento-page[data-page="${n}"]`)
    page?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }

  return (
    <div
      className="bento-dots"
      role="tablist"
      aria-label={t('bento.page.pages')}
      /* The dots sit on the PAGE, so they take the page's ink — the same
         declaration the arrange toolbar makes for the same reason. Read the
         card's `--bento-ink` here and the dots vanish on every palette whose
         cards are lighter than its ground, which is half of them. */
      style={{ color: INK_HERE_FROM_PAGE } as CSSProperties}
    >
      {/* Said once, in words, for the reader who cannot see six circles. The
          dots themselves carry the labels a tablist needs; this is the running
          commentary that tells somebody a swipe landed. */}
      <span className="sr-only" aria-live="polite">
        {t('bento.page.indicator', { n: at + 1, total: pages })}
      </span>
      {Array.from({ length: pages }, (_, i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={i === at}
          aria-label={t('bento.page.goto', { n: i + 1 })}
          onClick={() => go(i)}
          className="bento-dot"
          data-on={i === at ? '' : undefined}
        />
      ))}
    </div>
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
        /* Previews the CARD, not the raw hue: the dot shows the soft panel the
           card will actually wear, so the picker never promises a fill it no
           longer paints. */
        style={{ background: value ? softTintBg(value) : 'var(--bento-card)' }}
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
  const spot = layer?.spots?.get(id)
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
    /* On a phone every legal size fits, because the board can always turn a
       page. `clampSpan` caps both axes at two and a page is two by three, so
       the largest cell this product can express fits an EMPTY page with a row
       to spare — there is no size to refuse. Refusing one here would be the
       arranger telling somebody they cannot have a shape their own layout is
       perfectly able to hold. */
    if (layer.phone) return true
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
    /* THE TINT IS A PANEL NOW, NOT A FILL.

       This used to paint the chosen hue at full chroma as the card's own
       background and then invert every figure to white or black to survive it.
       That is the loud card the whole board was made of: brand colour used as a
       cell fill, with the number fighting the ground it sits on.

       `softTintBg` keeps the person's hue — its identity is intact, a blue card
       is still visibly blue — and drops only its VOLUME, mixing it down over the
       card so it reads as a tinted panel in both themes. Because the panel is
       mostly the card, the card's normal ink keeps the contrast it was measured
       at: no `inkFor`, no forced white-on-colour, no rainbow of figures. A tint
       someone saved months ago at full strength softens here on its own. */
    /* THE COLOUR THEY PICKED, AT THE STRENGTH THEY PICKED IT.

       This mixed the hue down over the card at --tint-mix so it read as a
       tinted panel, and the reasoning was sound: a soft panel keeps the
       card's own ink at the contrast it was measured for, with no forced
       white-on-colour and no rainbow of figures.

       It also meant that choosing #d81008 -- a saturated red -- produced a
       pale pink card, and somebody who has just typed a colour into a box and
       watched almost nothing happen reads that as broken, not as restrained.
       Asked for repeatedly and plainly.

       So the card takes the colour, and the ink is computed against it rather
       than assumed: inkFor returns black or white by relative luminance, at
       the point white and black draw level. That is the one thing full chroma
       cannot be allowed to cost. */
    const soft = cssHsl(tint)
    const ink = inkFor(tint)
    for (const d of DOMAINS) {
      /* `Cell` draws its background from `--dom-x-soft`, so that is the token
         that must carry the softened panel. `--dom-x` is the INK a few marks
         still read (a meter, a gauge) — it keeps the hue at strength so those
         small strokes stay visible against the quiet panel. `-text` is the
         card's own ink, which is legible on a panel that is mostly the card. */
      paint[`--dom-${d}-soft`] = soft
      paint[`--dom-${d}`] = cssHsl(tint)
      paint[`--dom-${d}-text`] = 'var(--bento-ink)'
    }
    // Label and supporting sentence stay on the card's own ink/muted — a soft
    // panel does not move them off the contrast the theme already guarantees.

    /* THE BAND. The one place the colour is painted exactly as chosen: a 4px
       rule along the card's top edge, drawn by bento-theme.css from this
       token. It sits on no text, so it costs nothing in contrast, and it is
       what lets a person recognise "my blue card" at a glance even though the
       panel under the words is mixed down to --tint-mix. */
    paint['--tint-solid'] = cssHsl(tint)

    /* AND THE CARD THAT HAS NO DOMAIN.

       Cell only reads --dom-x-soft when the card carries a domain. A card
       without one -- and plenty do not -- paints from --bento-card and never
       looked at any of the tokens above, so choosing a colour for it moved the
       4px band along its top edge and left the card underneath white. The band
       is drawn from --tint-solid by the stylesheet, which is why the one part
       that did change was the one part that is not the card.

       Set here rather than in Cell because this is where the tint is known,
       and it is the same softened panel the domain cards get, so a board of
       mixed cards tints to one strength rather than two. */
    paint['--bento-card'] = soft

    /* AND THE TWO TONES THAT NEVER READ THE CARD COLOUR AT ALL.

       A cell is drawn in one of three tones. Only `plain` paints
       var(--bento-card); `anchor` paints a fixed mint gradient and `dark`
       paints the ink. So on any board those cards sat there refusing every
       colour anybody picked, while their neighbours changed -- which is what
       "some cards cannot change the colours" is.

       The anchor's gradient is repointed to the tint at both stops, which
       flattens it to the same panel every other card gets: a gradient that
       ignores the choice is worse than no gradient. Both tones take the
       card's ordinary ink, because the tint is mixed down over the card and
       the ink was measured against exactly that. */
    paint['--bento-anchor-from'] = soft
    paint['--bento-anchor-to'] = soft
    paint['--bento-anchor-ink'] = 'var(--bento-ink)'
    paint['--bento-mint'] = 'var(--bento-line)'
    paint['--bento-dark-bg'] = soft
    paint['--bento-dark-ink'] = 'var(--bento-ink)'
    /* And the fourth way a card gets a ground: one of the four house tints,
       painted straight onto the shell. That card was the last one on the
       board still refusing a colour. */
    paint['--bento-card-accent'] = soft

    /* Everything on the card reads --bento-ink, directly or through the
       -text tokens above, so setting it here carries the whole card to a
       legible colour in one move. --bento-muted is the quieter voice on the
       same ground and is mixed from the same pair, so it stays quieter
       without going under. */
    paint['--bento-ink'] = ink
    paint['--bento-muted'] = `color-mix(in srgb, ${ink} 72%, ${soft})`
    paint['--bento-line'] = `color-mix(in srgb, ${ink} 22%, ${soft})`
  }

  /* ONE CARD LEADS — WHEN IT HAS SOMETHING TO SAY.

     `data-lead` marks the first card of the arrangement. The stylesheet only
     honours it when that card is not `[data-quiet]`: on a board where the
     first card has nothing to draw there is no lead, and every card sits at
     the quiet register — no large frame around an em dash. When it does have
     data, the lead keeps the full figure scale (96px on a desktop 2x2, the
     phone's own clamp) at weight 650, and every other card's figure is capped
     at 44px (34 on a phone) at 600. Size and weight do the leading; the lead
     wears the same --tint-mix panel and the same ink as every other card. */
  const lead = pos === 0

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
      /* PLACED EXPLICITLY ON A PHONE, FLOWED EVERYWHERE ELSE.

         The board's ordinary geometry is `order` plus a span class and a dense
         auto-flow: say how big and how far along, and let the grid find a
         slot. That cannot express a page. The pages are laid out side by side
         in one grid — page two is columns three and four — so a card has to
         say which columns it occupies, and the only component that knows is
         the layer that packed it.

         An inline grid-column beats the `sm:col-span-2` class outright, which
         is what we want: between 640 and 767 a phone is still a phone and that
         class is still live, and one of the two answers has to be the pack's.
         Off the pager `spot` is undefined and nothing is written, so every
         other width keeps exactly the geometry it had. */
      style={
        spot
          ? {
              order,
              gridColumn: `${spot.page * PHONE_COLS + spot.col + 1} / span ${spot.w}`,
              gridRow: `${spot.row + 1} / span ${spot.h}`,
            }
          : { order }
      }
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
      /* The first card of the arrangement. Gated in CSS on the card not being
         quiet — see `lead` above and bento-theme.css. */
      data-lead={lead ? '' : undefined}
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
