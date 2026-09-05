import { createContext, useContext, useEffect, useMemo, useRef, useState,
         type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useSwipeUpForAll } from './swipe-up-launcher'
import { buzz } from '@/lib/haptics'
import { openLauncher } from './launcher-open'
import { Check, LayoutGrid, Pencil, Plus, RotateCcw, Sparkles, Undo2, X } from 'lucide-react'
import {
  useLayout, dimsOf, tintOf, isRemoved, orderOf, useBoard, publishBoard, clearBoard,
  DIMS, TINT_STARTS, softTintBg, inkFor, cssHsl, hexToHsl, hslToHex,
  rowsNeeded, BOARD_ROWS, PRESETS,
  paginate, pageCount, PHONE_COLS, PHONE_ROWS,
  type WidgetSize, type BoardWidget, type Spot, type Preset,
} from '@/lib/widgets'
import { usePhone, useTextZoom } from '@/lib/viewport'
import { COL, ROW, spanFor, clampSpan, clampRows, type CellSpan } from './bento-kit'
import { WidgetSizeContext } from '@/lib/widget-size'
import { WheelCanvas, INK_HERE_FROM_PAGE } from './ColourDialog'
import { ArrangeSheet } from './ArrangeSheet'
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

   TWO EDITORS, ONE STORE. The phone and the desktop are different compositions
   and get different editors — a sheet over the pager on a phone (ArrangeSheet),
   outlines and a slim bar on the desktop (below) — but both write the same
   `layout.placed` through `useLayout`, so a board arranged on one loads on
   the other unchanged.

   WHERE THE DOORS ARE. Phone: hold a card, the pencil beside the page dots, or
   "Edit home" in Settings > Dashboard. Desktop: the Edit pill at the foot of
   the board, the tab's context menu, or the same settings row. Editing
   state lives in the widgets module so every door reaches the same switch. */

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
     board is not paged — every width above the phone. */
  phone: boolean
  spots: Map<string, Spot> | null
  /** The drag in progress on a desktop board, so the card under the pointer
      can say it is the target. */
  dropTarget: string | null
  setDropTarget: (id: string | null) => void
}

/* Every domain token a cell might read. Repointing all of them is what lets
   the wrapper recolour a card without knowing which domain the cell asked for. */
const DOMAINS = [
  'academics', 'admissions', 'attendance', 'communication', 'critical',
  'finance', 'operations', 'reports', 'staff', 'students', 'success', 'warning',
] as const

const Ctx = createContext<LayerValue | null>(null)

/* THE SHAPES THE BOARD CAN DRAW, WHICH IS ANY THAT FIT.

   The picker used to stop at 2x2 because the renderer did; a person with two
   empty columns beside a card was told it would not fit, which was untrue.
   The board is five by three, so the list runs to a full-width band, and
   each button is enabled or not by `fitsAt`, which packs the WHOLE board at
   that size and asks whether it still fits the page. The list is what is
   worth offering, not every one of the fifteen legal rectangles: a 4x1 and a
   5x2 are shapes nobody asked for that would double the row of buttons. */
type ShapeKey = '1x1' | '1x2' | '2x1' | '2x2' | '3x1' | '3x2' | '4x2' | '5x1'
const SHAPES: readonly { w: number; h: number; key: ShapeKey }[] = [
  { w: 1, h: 1, key: '1x1' },
  { w: 1, h: 2, key: '1x2' },
  { w: 2, h: 1, key: '2x1' },
  { w: 2, h: 2, key: '2x2' },
  { w: 3, h: 1, key: '3x1' },
  { w: 3, h: 2, key: '3x2' },
  { w: 4, h: 2, key: '4x2' },
  { w: 5, h: 1, key: '5x1' },
]

/* A five-by-three thumbnail of what a preset does, so the menu shows the
   shape rather than asking somebody to imagine "Spotlight". Drawn from the
   same rule the preset applies, on a board of six cards. */
function PresetGlyph({ preset }: { preset: Preset }) {
  const cells: { c: number; r: number; w: number; h: number }[] = []
  const put = (w: number, h: number, n: number) => {
    // Dense first-fit, the way the board packs.
    const used = Array.from({ length: 3 }, () => Array(5).fill(false))
    let placed = 0
    for (let r = 0; r < 3 && placed < n; r++) {
      for (let c = 0; c < 5 && placed < n; c++) {
        const cw = Math.min(w, 5 - c)
        if (c + cw > 5 || r + h > 3) continue
        let free = true
        for (let y = r; y < r + h; y++) for (let x = c; x < c + cw; x++) if (used[y][x]) free = false
        if (!free) continue
        for (let y = r; y < r + h; y++) for (let x = c; x < c + cw; x++) used[y][x] = true
        cells.push({ c, r, w: cw, h })
        placed++
      }
    }
  }
  switch (preset) {
    case 'compact': put(1, 1, 8); break
    case 'spotlight': cells.push({ c: 0, r: 0, w: 3, h: 2 }); cells.push({ c: 3, r: 0, w: 1, h: 1 }, { c: 4, r: 0, w: 1, h: 1 }, { c: 3, r: 1, w: 1, h: 1 }, { c: 4, r: 1, w: 1, h: 1 }); break
    case 'banner': cells.push({ c: 0, r: 0, w: 5, h: 1 }); for (let c = 0; c < 5; c++) cells.push({ c, r: 1, w: 1, h: 1 }); break
    case 'even': put(2, 1, 6); break
    case 'columns': put(1, 2, 5); break
    default: cells.push({ c: 0, r: 0, w: 2, h: 2 }, { c: 2, r: 0, w: 1, h: 1 }, { c: 3, r: 0, w: 2, h: 1 }, { c: 2, r: 1, w: 1, h: 2 }, { c: 3, r: 1, w: 1, h: 1 }, { c: 4, r: 1, w: 1, h: 1 })
  }
  return (
    <svg viewBox="0 0 50 30" width="40" height="24" aria-hidden="true" className="shrink-0">
      {cells.map((x, i) => (
        <rect key={i} x={x.c * 10 + 1} y={x.r * 10 + 1} width={x.w * 10 - 2} height={x.h * 10 - 2}
          rx="1.5" fill="currentColor" opacity={i === 0 ? 0.9 : 0.45} />
      ))}
    </svg>
  )
}

/** The size a placement is DRAWN at, which is the only size any of the
    fit arithmetic below may use. `dimsOf` returns what is stored, and what is
    stored may be a 3 or a 5 from an older layout. */
function drawnDims(
  layout: Parameters<typeof dimsOf>[0],
  id: string,
  fallback: WidgetSize,
): { w: number; h: number } {
  const d = dimsOf(layout, id, fallback)
  return { w: clampSpan(d.w), h: clampRows(d.h) }
}

/* Not exported, and that is load-bearing rather than tidiness.

   A module that exports both components and a non-component breaks Vite's Fast
   Refresh ("export is incompatible"), which falls back to invalidating the
   module. Re-evaluating this file builds a NEW context object, so <Widget>
   starts reading a different context than <WidgetLayer> is filling. */
function useWidgetLayer() {
  return useContext(Ctx)
}

/* THE PAGER ANSWERS THE FONT SETTING.

   At the platform's Largest text a card's header, figure and sentence are a
   third taller and its slot is not, so a three-row page pushes every drawing
   out through the bottom. Two rows a page at that setting gives each card the
   half-again height its text just took, which is what a phone home screen
   does when the text grows: fewer, taller tiles. 1.25 is between Android's
   Large (1.15) and Largest (1.3). */
const TWO_ROWS_FROM = 1.25

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
  const [dropTarget, setDropTarget] = useState<string | null>(null)

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
  /* Sorted the way the grid lays them out, not the way they mount. */
  const candidates = declared
    .filter(isOn)
    .slice()
    .sort((a, b) => orderOf(layout, a.id, a.index) - orderOf(layout, b.id, b.index))
  /* THE CEILING, ENFORCED on a desktop: five columns, three rows, fifteen
     slots — and a widget that does not fit does not render. Packed in drawn
     order against the real `rowsNeeded`; `continue` rather than `break`,
     because the pack is dense.

     ON A PHONE THE CEILING IS A PAGE BREAK, NOT A CEILING: every candidate is
     kept and `paginate` decides which page each one lands on. */
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
     merely qualified. One list, so "can this one grow?" and the picture are
     about the same board. */
  const visible = candidates.filter((d) => fitted.has(d.id))
  const off = declared.filter((d) => !fitted.has(d.id))
  const arranged = layout.placed.length > 0 || layout.removed.length > 0

  /* Published so Settings can list this board without being inside it, and
     withdrawn on the way out so a screen with no board cannot be arranged. */
  useEffect(() => {
    publishBoard(dashboard, declared)
  }, [dashboard, declared])

  useEffect(() => () => clearBoard(dashboard), [dashboard])

  /* Escape leaves arrange mode. */
  useEffect(() => {
    if (!arranging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArranging(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [arranging, setArranging])

  /* The board uses the rows it NEEDS, not always three. `rowsNeeded` is
     already computed for the ceiling, so this costs nothing. */
  const rowsUsed = Math.max(
    1,
    Math.min(maxRows, rowsNeeded(visible.map((v) => drawnDims(layout, v.id, v.size)))),
  )
  useEffect(() => {
    /* Nothing to say on a phone: `--board-rows` is read by the fixed-height
       board rules behind `min-width: 1024px`. */
    if (phone) return
    document.documentElement.style.setProperty('--board-rows', String(rowsUsed))
    return () => {
      document.documentElement.style.removeProperty('--board-rows')
    }
  }, [rowsUsed, phone])

  /* THE PAGER NEEDS A BOARD. Every pager rule is written against
     `.bento-board[data-pager]`, and the attribute is set on the layer's own
     ancestor board below. Read after mount rather than from a prop because
     only the DOM knows the shape of the tree this layer was dropped into. */
  const [inBoard, setInBoard] = useState(false)
  useEffect(() => {
    setInBoard(!!markRef.current?.closest('.bento-board'))
  })

  /* PAGED WHILE EDITING TOO. The phone's editor is a sheet over the board
     rather than controls on it, so there is no reason to stop paging — and
     every reason not to: the person is watching the board follow their
     finger. The swipe-up for the launcher is the one thing that does stop,
     because a finger on the sheet is not asking for the launcher. */
  const paged = phone && inBoard
  useSwipeUpForAll(paged && !arranging, openLauncher)

  const zoom = useTextZoom()
  const rows = phone && zoom >= TWO_ROWS_FROM ? 2 : PHONE_ROWS
  /* Only a height somebody chose on this device may take two rows: a
     placed entry with h >= 2. A declared 'large' still reads as one row. */
  const tallOk = useMemo(
    () => new Set(layout.placed.filter((p) => p.h >= 2).map((p) => p.id)),
    [layout],
  )
  const spots = useMemo(() => {
    if (!paged) return null
    return paginate(
      visible.map((v) => ({ id: v.id, ...drawnDims(layout, v.id, v.size) })),
      PHONE_COLS,
      rows,
      tallOk,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paged, visible.map((v) => `${v.id}:${v.w}x${v.h}`).join(','), layout, rows, tallOk])
  const pages = spots ? pageCount(spots) : 0
  const spotMap = useMemo(
    () => (spots ? new Map(spots.map((s) => [s.id, s])) : null),
    [spots],
  )

  /* The pager is switched on from here, on the element BentoPage owns, and
     told how many rows a page has — the stylesheet's repeat() reads
     `--pager-rows` so the two cannot disagree. `data-arranging` lets the
     stylesheet quieten the cards while the sheet is up. */
  useEffect(() => {
    const board = markRef.current?.closest('.bento-board') as HTMLElement | null
    if (!board || !paged) return
    board.setAttribute('data-pager', '')
    board.style.setProperty('--pager-rows', String(rows))
    return () => {
      board.removeAttribute('data-pager')
      board.style.removeProperty('--pager-rows')
    }
  }, [paged, rows])
  useEffect(() => {
    const board = markRef.current?.closest('.bento-board') as HTMLElement | null
    if (!board || !arranging) return
    board.setAttribute('data-arranging', phone ? 'sheet' : 'desk')
    return () => board.removeAttribute('data-arranging')
  }, [arranging, phone])

  /* HOLD A CARD TO ARRANGE THE BOARD.

     Touch only — a mouse has no long press worth the name. One finger,
     cancelled by movement past the slop, a second finger, the pointer leaving,
     or any scroll. Half a second, the platform's own long-press timeout. The
     click that follows is swallowed once, in the capture phase, because every
     cell is a link and opening a screen is the opposite of what was asked. */
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
    () => ({ dashboard, editing: arranging, declare, visible, fitted, maxRows, phone, spots: spotMap, dropTarget, setDropTarget }),
    [
      dashboard, arranging, declare, maxRows, phone, spotMap, dropTarget,
      /* Sizes as well as ids: `visible` seeds `move` for every widget nobody
         has explicitly placed, and a key of ids alone would hand it the
         previous render's w/h. */
      visible.map((d) => `${d.id}:${d.w}x${d.h}`).join(','),
      [...fitted].join(','),
    ],
  )

  const desk = arranging && !phone
  const ink = { '--ink-here': INK_HERE_FROM_PAGE, color: 'var(--ink-here)' } as CSSProperties

  return (
    <Ctx.Provider value={value}>
      <span ref={markRef} className="hidden" aria-hidden="true" />
      {/* THE SLIM BAR. Desktop only, while editing, and a grid child either
          way: BentoPage drops its children straight into the board's grid,
          so this spans the full width and sorts first. Done, Undo, Reset and
          the way back for a hidden card. Its ground is the page, so it
          declares the page's ink — the card's ink measured 1.04:1 here. */}
      {desk && (
        <div
          ref={barRef}
          className="bento-arrange-bar col-span-full flex flex-wrap items-center gap-2"
          style={{ order: -1, ...ink }}
          role="toolbar"
          aria-label={t('bento.widgets.editing')}
        >
          <button type="button" onClick={() => setArranging(false)} className="bento-bar__btn is-primary">
            <Check className="size-3.5" aria-hidden="true" />
            {t('bento.widgets.done')}
          </button>
          {canUndo && (
            <button type="button" onClick={undo} className="bento-bar__btn">
              <Undo2 className="size-3.5" aria-hidden="true" />
              {t('bento.widgets.undo')}
            </button>
          )}
          {arranged && (
            <button type="button" onClick={reset} className="bento-bar__btn">
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t('bento.widgets.reset')}
            </button>
          )}
          {/* THE LAYOUTS, AND TIDY. The model has had these rules for a
              while (lib/widgets.ts applyPreset, tidy) and nothing on screen
              called them, so arranging a board meant dragging every card.
              Six rules over whatever the board declares, so the same buttons
              work on every dashboard and keep working when a card is added. */}
          <details className="relative">
            <summary className="bento-bar__btn list-none cursor-pointer">
              <LayoutGrid className="size-3.5" aria-hidden="true" />
              {t('bento.widgets.layouts')}
            </summary>
            <div
              className="absolute left-0 top-full z-30 mt-1.5 flex w-[260px] flex-col gap-1
                         rounded-[10px] border p-2 shadow-lg"
              style={{
                background: 'var(--bento-card)',
                color: 'var(--bento-ink)',
                borderColor: 'color-mix(in srgb, var(--bento-ink) 22%, transparent)',
              }}
            >
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyPreset(p, declared)}
                  className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left
                             text-[12px] transition-colors
                             hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]"
                >
                  <PresetGlyph preset={p} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{t(`bento.widgets.preset.${p}`)}</span>
                    <span className="block truncate text-[11px] opacity-60">
                      {t(`bento.widgets.preset.${p}.hint`)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </details>
          <button type="button" onClick={() => tidy(declared)} className="bento-bar__btn">
            <Sparkles className="size-3.5" aria-hidden="true" />
            {t('bento.widgets.tidy')}
          </button>
          {off.length > 0 && (
            /* A disclosure, not a wall: `<details>` is closed by default,
               toggles with the keyboard, and needs no state to be correct. */
            <details className="relative">
              <summary className="bento-bar__btn list-none cursor-pointer">
                <Plus className="size-3" aria-hidden="true" />
                {t('bento.widgets.add_count', { count: off.length })}
              </summary>
              <div
                className="absolute left-0 top-full z-30 mt-1.5 flex max-h-[280px] w-[320px] flex-col
                           gap-1 overflow-y-auto rounded-[10px] border p-2 shadow-lg"
                style={{
                  background: 'var(--bento-card)',
                  color: 'var(--bento-ink)',
                  borderColor: 'color-mix(in srgb, var(--bento-ink) 22%, transparent)',
                }}
              >
                {off.map((d) => {
                  const room =
                    rowsNeeded([
                      ...visible.map((v) => drawnDims(layout, v.id, v.size)),
                      { w: clampSpan(DIMS[d.size].w), h: clampRows(DIMS[d.size].h) },
                    ]) <= maxRows
                  return (
                    <button
                      key={d.id}
                      type="button"
                      disabled={!room}
                      title={room ? undefined : t('bento.widgets.full')}
                      onClick={() =>
                        place(d.id, clampSpan(DIMS[d.size].w), clampRows(DIMS[d.size].h))
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
          <span className="text-[12px] opacity-60">{t('bento.widgets.desk_hint')}</span>
        </div>
      )}
      {children}

      {/* ONE EMPTY ELEMENT PER PAGE, AND IT IS WHAT MAKES THE PAGER SNAP.
          A snap position exists only where an element declares one; the cards
          cannot, so each page gets a child spanning it, carrying the only
          `scroll-snap-align` in the board. Rendered after `children` so a card
          and its page never argue about paint order. */}
      {paged &&
        Array.from({ length: pages }, (_, i) => (
          <span
            key={`bento-page-${i}`}
            className="bento-page"
            data-page={i}
            aria-hidden="true"
            style={{
              gridColumn: `${i * PHONE_COLS + 1} / span ${PHONE_COLS}`,
              gridRow: `1 / span ${rows}`,
            }}
          />
        ))}

      {/* Portalled to the body, like the dock, because the board is the
          scroller and anything drawn inside it scrolls away with page one. */}
      {paged && !arranging && createPortal(
        <PageDots pages={pages} mark={markRef} onEdit={() => setArranging(true)} />,
        document.body,
      )}
      {paged && arranging && createPortal(
        <ArrangeSheet
          dashboard={dashboard}
          declared={declared}
          visible={visible}
          onDone={() => setArranging(false)}
        />,
        document.body,
      )}
      {/* THE DESKTOP'S DOOR: a quiet pill at the foot of the board, beside
          the assistant, where the phone keeps its pencil. Not on the board
          itself, which is tiled edge to edge with the cards being edited. */}
      {!phone && inBoard && !arranging && createPortal(
        <button
          type="button"
          className="bento-edit-pill"
          style={ink}
          onClick={() => setArranging(true)}
          aria-label={t('bento.widgets.edit_home')}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
          {t('bento.widgets.edit_board')}
        </button>,
        document.body,
      )}
    </Ctx.Provider>
  )
}

/* THE PAGE DOTS, WHICH ARE ALSO THE PAGE CONTROL — a real tablist of real
   buttons, so a keyboard and a screen reader can reach page two. The active
   page comes from an IntersectionObserver over the page elements rather than
   from arithmetic on scrollLeft. The pencil at the strip's left end is the
   phone's visible door into editing; the right end is where the assistant
   sits. */
function PageDots({ pages, mark, onEdit }: { pages: number; mark: { current: HTMLSpanElement | null }; onEdit: () => void }) {
  const t = useT()
  const [at, setAt] = useState(0)

  useEffect(() => {
    const board = mark.current?.closest('.bento-board') as HTMLElement | null
    if (!board) return
    const seen = Array.from(board.querySelectorAll<HTMLElement>('.bento-page'))
    if (seen.length === 0) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const n = Number(e.target.getAttribute('data-page'))
          if (!Number.isNaN(n)) {
            setAt((was) => {
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
      style={{ color: INK_HERE_FROM_PAGE } as CSSProperties}
    >
      <button
        type="button"
        className="bento-dots__edit"
        onClick={onEdit}
        aria-label={t('bento.widgets.edit_home')}
        title={t('bento.widgets.edit_home')}
      >
        <Pencil className="size-4" aria-hidden="true" />
      </button>
      {pages > 1 && (
        <span className="sr-only" aria-live="polite">
          {t('bento.page.indicator', { n: at + 1, total: pages })}
        </span>
      )}
      {pages > 1 && Array.from({ length: pages }, (_, i) => (
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

/** The colour control: a swatch that opens the product's own wheel.
    Portaled and fixed-positioned because the card it belongs to may be one
    grid cell across. Exported for the phone's ArrangeSheet, which had every
    other per-card decision and not this one. */
export function ColourPick({
  value,
  onPick,
}: {
  value: Hsl | null
  onPick: (c: Hsl | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const t = useT()
  const current = value ?? TINT_STARTS[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node
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
    <>
      <button
        ref={btn}
        type="button"
        aria-label={t('bento.widgets.colour_default')}
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
        className="bento-sizepick__swatch"
        style={{ background: value ? softTintBg(value) : 'var(--bento-card)' }}
      />

      {open && at && createPortal(
        <div
          ref={pop}
          style={{ position: 'fixed', left: at.left, top: at.top, width: 228 }}
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
                if (parsed) onPick(parsed)
              }}
              onBlur={() => setTyped(null)}
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
                className="size-5 rounded-full border shadow-sm"
                style={{ background: cssHsl(c) }}
              />
            ))}
            <button
              type="button"
              onClick={() => onPick(null)}
              className="rounded-md border px-2 py-0.5 text-[10.5px] hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]"
            >
              {t('bento.widgets.colour_clear')}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
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

  /* Declared in an effect, not in the render body: calling the parent's
     setState while rendering a child is illegal in React. */
  const declare = layer?.declare
  useEffect(() => {
    declare?.({ id, label, index, size: declaredSize, w, h, optional })
  }, [declare, id, label, index, declaredSize, w, h, optional])

  /* THE DRAG, on a desktop. Pointer events rather than HTML5 drag, so the
     ghost is the card itself moved by a transform, the drop target is
     whatever card is under the pointer, and reduced motion has nothing to
     switch off because nothing animates. Committed on release: reordering
     live would reflow the grid under the ghost and carry it off. */
  const [ghost, setGhost] = useState<{ dx: number; dy: number } | null>(null)
  const dragFrom = useRef<{ x: number; y: number; id: string | null } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  /* One gate, and it is the board's own answer. `layer.fitted` already folds
     in the removed list, the `optional` default and the three-row ceiling. */
  if (layer && !layer.fitted.has(id)) return null
  if (isRemoved(layout, id)) return null

  const order = orderOf(layout, id, index)
  const editing = layer?.editing ?? false
  const desk = editing && !(layer?.phone ?? false)
  const cw = clampSpan(w)
  const ch = clampRows(h)
  const span = spanFor(cw, ch)
  const spot = layer?.spots?.get(id)
  const pos = layer ? layer.visible.findIndex((v) => v.id === id) : 0
  const tint = tintOf(layout, id)

  /* Would the board still fit if this card were that size? Simulated against
     the WHOLE layout, because a card growing pushes everything after it. The
     current size is always allowed, or a too-tall layout could never be
     shrunk out of. */
  const fitsAt = (nw: number, nh: number) => {
    if (!layer) return true
    if (layer.phone) return true
    const pw = clampSpan(nw)
    const ph = clampRows(nh)
    if (pw === cw && ph === ch) return true
    const items = layer.visible.map((v) =>
      v.id === id ? { w: pw, h: ph } : drawnDims(layout, v.id, v.size),
    )
    return rowsNeeded(items) <= layer.maxRows
  }

  const paint: Record<string, string> = {}
  if (tint) {
    /* THE COLOUR THEY PICKED, AT THE STRENGTH THEY PICKED IT, and the ink
       computed against it by relative luminance. Every domain is repointed
       because the wrapper does not know which domain the cell asked for;
       the two tones that never read the card colour (anchor, dark) are
       repointed too, or they would sit there refusing every colour. */
    const soft = cssHsl(tint)
    const inkOn = inkFor(tint)
    for (const d of DOMAINS) {
      paint[`--dom-${d}-soft`] = soft
      paint[`--dom-${d}`] = cssHsl(tint)
      paint[`--dom-${d}-text`] = 'var(--bento-ink)'
    }
    paint['--tint-solid'] = cssHsl(tint)
    paint['--bento-card'] = soft
    paint['--bento-anchor-from'] = soft
    paint['--bento-anchor-to'] = soft
    paint['--bento-anchor-ink'] = 'var(--bento-ink)'
    paint['--bento-mint'] = 'var(--bento-line)'
    paint['--bento-dark-bg'] = soft
    paint['--bento-dark-ink'] = 'var(--bento-ink)'
    paint['--bento-card-accent'] = soft
    paint['--bento-ink'] = inkOn
    paint['--bento-muted'] = `color-mix(in srgb, ${inkOn} 72%, ${soft})`
    paint['--bento-line'] = `color-mix(in srgb, ${inkOn} 22%, ${soft})`
  }

  /* ONE CARD LEADS — WHEN IT HAS SOMETHING TO SAY. `data-lead` marks the
     first card of the arrangement; the stylesheet honours it only when that
     card is not `[data-quiet]`. */
  const lead = pos === 0

  const targetOver = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)
    const w2 = el?.closest<HTMLElement>('.bento-widget[data-widget-id]')
    const tid = w2?.getAttribute('data-widget-id') ?? null
    return tid && tid !== id ? tid : null
  }
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!desk || !e.isPrimary) return
    if ((e.target as HTMLElement).closest('button,input,summary,[role=radio]')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragFrom.current = { x: e.clientX, y: e.clientY, id: null }
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = dragFrom.current
    if (!f || !layer) return
    const dx = e.clientX - f.x
    const dy = e.clientY - f.y
    if (!ghost && Math.hypot(dx, dy) < 6) return
    setGhost({ dx, dy })
    /* The ghost is what the pointer is over, so it steps aside for a frame. */
    const self = wrapRef.current
    const was = self?.style.pointerEvents ?? ''
    if (self) self.style.pointerEvents = 'none'
    const over = targetOver(e.clientX, e.clientY)
    if (self) self.style.pointerEvents = was
    if (over !== f.id) {
      f.id = over
      layer.setDropTarget(over)
    }
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = dragFrom.current
    dragFrom.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    if (!f || !layer) return
    setGhost(null)
    layer.setDropTarget(null)
    if (f.id) {
      const to = layer.visible.findIndex((v) => v.id === f.id)
      if (to >= 0) move(id, to, layer.visible)
    }
  }

  return (
    <div
      ref={wrapRef}
      /* The span classes belong HERE, on the wrapper: this div is the grid
         child; the Cell inside it is not. `[&>*]:h-full` because the wrapper
         is what the row track stretches. */
      className={cn('bento-widget relative min-w-0 [&>*]:h-full', COL[cw], ROW[ch])}
      /* PLACED EXPLICITLY ON A PHONE, FLOWED EVERYWHERE ELSE. The pages are
         laid out side by side in one grid, so a card has to say which columns
         it occupies, and the only component that knows is the layer that
         packed it. Off the pager nothing is written. */
      style={{
        ...(spot
          ? {
              order,
              gridColumn: `${spot.page * PHONE_COLS + spot.col + 1} / span ${spot.w}`,
              gridRow: `${spot.row + 1} / span ${spot.h}`,
            }
          : { order }),
        ...(ghost ? { transform: `translate(${ghost.dx}px, ${ghost.dy}px)`, zIndex: 40 } : {}),
      }}
      data-widget-id={id}
      /* The stored size, as before: the [data-w]/[data-h] rules in index.css
         were measured against it, and a phone card reading data-w="1" would
         lose the note those rules hide on a one-column desktop card. */
      data-w={cw}
      data-h={ch}
      data-tinted={tint ? 'true' : undefined}
      data-lead={lead ? '' : undefined}
      data-editing={desk ? '' : undefined}
      data-dragging={ghost ? '' : undefined}
      data-drop-target={layer?.dropTarget === id ? '' : undefined}
    >
      {/* The repointed palette is scoped to the CELL, not to the wrapper, so
          the editing controls keep the page's ink. On the phone the cell is
          told the size the PACK gave it, which is one row unless Tall was
          chosen; elsewhere the stored size. */}
      <div className="h-full [&>*]:h-full" style={paint}>
        <WidgetSizeContext.Provider value={{ w: spot ? spot.w : cw, h: spot ? spot.h : ch }}>
          {children(span)}
        </WidgetSizeContext.Provider>
      </div>

      {desk && (
        /* THE EDIT SURFACE: transparent, over the whole card, so a press
           anywhere starts a drag and never opens the link underneath. The ×
           and the shape picker sit on it; the picker shows on hover or
           focus, the × always. Ink is the page's, stated once here. */
        <div
          className="bento-edit group/edit absolute inset-0 z-10 rounded-[var(--bento-radius)]"
          style={{ '--ink-here': INK_HERE_FROM_PAGE, color: 'var(--ink-here)' } as CSSProperties}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <button
            type="button"
            onClick={() => remove(id)}
            aria-label={`${t('bento.widgets.hide')} ${label}`}
            title={t('bento.widgets.hide')}
            className="bento-edit__hide"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
          <div className="bento-edit__tools">
            <span role="radiogroup" aria-label={t('bento.widgets.size_of', { label })} className="bento-sizepick">
              {SHAPES.map((s) => {
                const on = s.w === cw && s.h === ch
                const ok = fitsAt(s.w, s.h)
                return (
                  <button
                    key={s.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!ok}
                    title={ok ? undefined : t('bento.widgets.wont_fit')}
                    onClick={() => resize(id, s.w, s.h)}
                    className={cn('bento-sizepick__btn', on && 'is-on')}
                  >
                    {t(`bento.widgets.shape.${s.key}`)}
                  </button>
                )
              })}
            </span>
            <ColourPick value={tint} onPick={(c) => recolour(id, c, cw, ch)} />
          </div>
        </div>
      )}
    </div>
  )
}
