import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
         type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useSwipeUpForAll } from './swipe-up-launcher'
import { buzz } from '@/lib/haptics'
import { openLauncher } from './launcher-open'
import { Check, ChevronDown, LayoutGrid, ListOrdered, Minus, Pencil, Plus, RotateCcw, Sparkles, Undo2 } from 'lucide-react'
import {
  useLayout, dimsOf, tintOf, isRemoved, orderOf, useBoard, publishBoard, clearBoard,
  DIMS, TINT_STARTS, softTintBg, inkFor, cssHsl, hexToHsl, hslToHex,
  rowsNeeded, BOARD_ROWS, PRESETS,
  paginate, pageCount, PHONE_COLS, PHONE_ROWS,
  type WidgetSize, type BoardWidget, type Spot, type Preset,
} from '@/lib/widgets'
import { TIERS, PHONE_TIERS, tierOf, dimsForTier, tierLabelKey, type SizeTier } from '@/lib/size-tiers'
import { AddGallery, type GalleryItem } from './AddGallery'
import { usePhone, useTextZoom } from '@/lib/viewport'
import { COL, ROW, spanFor, clampSpan, clampRows, type CellSpan } from './bento-kit'
import { WidgetSizeContext } from '@/lib/widget-size'
import { WheelCanvas, INK_HERE_FROM_PAGE } from './ColourDialog'
import { ArrangeSheet } from './ArrangeSheet'
import type { Hsl } from '@/lib/paint'
import { useT, type MessageKey } from '@/lib/i18n'
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

   ONE CUSTOMIZE MODE, ONE STORE. The desk and the phone used to get different
   editors — outlines and a slim bar on the desk, a sheet listing the cards on
   the phone — and the two taught two sets of habits for one job. What they
   share now is what iCloud's "Customize Home Page" does: while the mode is
   on, EVERY card wears a remove button at its top-left and a size pill at its
   bottom-right, is dragged directly, and a single bar at the foot of the
   screen holds Done, Undo, Add, Layouts, and Tidy (desk) or a reorder list
   (phone). The phone's sheet survives as that reorder list, because a list is
   still the fastest way to move page four's card to page one.

   Both write the same `layout.placed` through `useLayout`, so a board
   arranged on one loads on the other unchanged.

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
  /** The drag in progress, so the card under the pointer can say it is the
      target. */
  dropTarget: string | null
  setDropTarget: (id: string | null) => void
  /** The id of the card being carried, if any. The layer reads it to stop
      the page scrolling under a finger that is holding a card. */
  dragging: string | null
  setDragging: (id: string | null) => void
}

/* Every domain token a cell might read. Repointing all of them is what lets
   the wrapper recolour a card without knowing which domain the cell asked for. */
const DOMAINS = [
  'academics', 'admissions', 'attendance', 'communication', 'critical',
  'finance', 'operations', 'reports', 'staff', 'students', 'success', 'warning',
] as const

const Ctx = createContext<LayerValue | null>(null)

/* The three layouts that mean something on a phone page: as drawn, every
   card Small (two a page), every card Large (one a page). The rest are
   shapes of a five-wide board. */
const PHONE_PRESETS: readonly Preset[] = ['default', 'compact', 'panels'] as const

/* The attribute that makes a subtree neither focusable nor hit-testable.
   Spread rather than written as a prop because React 18's types do not know
   it; the DOM does, in every engine this product ships to. */
const INERT = { inert: '' } as Record<string, string>

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

/* THE FOOTPRINT OF A TIER, drawn on a miniature of the board it is for: three
   by two on the desk (Wide is the third column), two by two on the phone.
   The lit cells are the tier; the dim ones are the board around it. */
function TierGlyph({ tier, phone }: { tier: SizeTier; phone: boolean }) {
  const { w, h } = dimsForTier(tier, phone)
  const cols = phone ? 2 : 3
  return (
    <svg viewBox={`0 0 ${cols * 10} 20`} width={cols * 7} height={14} aria-hidden="true" className="shrink-0">
      {Array.from({ length: cols * 2 }, (_, i) => {
        const c = i % cols
        const r = Math.floor(i / cols)
        const on = c < w && r < h
        return (
          <rect key={i} x={c * 10 + 1} y={r * 10 + 1} width={8} height={8} rx="1.5"
            fill="currentColor" opacity={on ? 0.9 : 0.18} />
        )
      })}
    </svg>
  )
}

/* ONE POPOVER FOR EVERY MENU IN CUSTOMIZE MODE: the size menu on a card, the
   layouts menu on the bar.

   Portalled and fixed, because a card may be one grid cell across and the
   bar is a fixed strip; anchored under its button, or above it when the
   button is nearer the bottom of the screen, which the bar's always is. On
   a narrow screen it is a sheet above the bar instead, the same answer the
   colour wheel gives.

   Escape is caught ON THE WAY DOWN and stopped there: the layer's own Escape
   leaves customize mode, and a person closing a menu has not asked for that.
   Arrow keys walk the items; focus goes in on open and back to the button on
   close. A press outside closes it — except inside the colour wheel, which
   the size menu opens from its last row and which portals itself elsewhere. */
function Menu({
  open,
  anchor,
  label,
  onClose,
  width = 208,
  children,
}: {
  open: boolean
  anchor: HTMLElement | null
  label: string
  onClose: () => void
  width?: number
  children: ReactNode
}) {
  const pop = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640

  useLayoutEffect(() => {
    if (!open) {
      setAt(null)
      return
    }
    const r = anchor?.getBoundingClientRect()
    const h = pop.current?.offsetHeight ?? 220
    if (!r) {
      setAt({ left: 16, top: 16 })
      return
    }
    const below = r.bottom + 6 + h <= window.innerHeight - 8
    setAt({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - h),
    })
  }, [open, anchor, width])

  useEffect(() => {
    if (!open) return
    const first = pop.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')
    first?.focus()
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node
      if (pop.current?.contains(n) || anchor?.contains(n)) return
      if ((n as HTMLElement).closest?.('[data-colour-pop]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
      anchor?.focus()
    }
  }, [open, anchor, onClose])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const items = Array.from(
      pop.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    )
    if (items.length === 0) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
      : e.key === 'ArrowDown' ? (i + 1) % items.length
      : (i - 1 + items.length) % items.length
    items[next].focus()
  }

  if (!open) return null
  return createPortal(
    <div
      ref={pop}
      role="menu"
      aria-label={label}
      data-bento-menu=""
      className="bento-menu"
      onKeyDown={onKeyDown}
      style={
        narrow
          ? { left: 12, right: 12, bottom: 'calc(84px + env(safe-area-inset-bottom, 0px))', width: 'auto' }
          : { left: at?.left ?? 0, top: at?.top ?? 0, width, visibility: at ? 'visible' : 'hidden' }
      }
    >
      {children}
    </div>,
    document.body,
  )
}

/* THE SIZE PILL AND ITS MENU: what a card is, and what it could be.

   Four tiers on the desk, two on the phone (Medium and Wide are Small there
   — see size-tiers.ts). Each is enabled only if the whole board still fits
   with this card at that size; the current tier is always enabled so a
   too-tall layout can be shrunk out of. The last row opens the colour wheel,
   which used to be a separate swatch nobody found. */
function SizeMenu({
  label,
  cw,
  ch,
  phone,
  fits,
  tint,
  onTier,
  onTint,
}: {
  label: string
  cw: number
  ch: number
  phone: boolean
  fits: (w: number, h: number) => boolean
  tint: Hsl | null
  onTier: (tier: SizeTier) => void
  onTint: (c: Hsl | null) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const current = tierOf(cw, ch, phone)
  const tiers = phone ? PHONE_TIERS : TIERS
  const name = (tier: SizeTier) => t(tierLabelKey(tier) as MessageKey)
  const menuLabel = t('bento.widgets.size_of', { label })

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="bento-sizebtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={menuLabel}
        title={menuLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <TierGlyph tier={current} phone={phone} />
        <span>{name(current)}</span>
        <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
      </button>
      <Menu open={open} anchor={btn.current} label={menuLabel} onClose={close}>
        {tiers.map((tier) => {
          const d = dimsForTier(tier, phone)
          const ok = fits(d.w, d.h)
          const on = tier === current
          return (
            <button
              key={tier}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              disabled={!ok}
              title={ok ? undefined : t('bento.widgets.wont_fit')}
              className={cn('bento-menu__item', on && 'is-on')}
              onClick={() => {
                onTier(tier)
                setOpen(false)
              }}
            >
              <TierGlyph tier={tier} phone={phone} />
              <span className="min-w-0 flex-1 truncate">{name(tier)}</span>
              {on && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
            </button>
          )
        })}
        <div className="bento-menu__rule" role="separator" />
        <ColourPick value={tint} onPick={onTint} label={t('bento.widgets.colour_row')} />
      </Menu>
    </>
  )
}

/* THE CUSTOMIZE BAR: the one piece of chrome the mode has.

   A floating pill at the foot of a desk board; a strip docked above the
   home indicator on a phone, where the dock was. Done is the primary. Undo
   and Reset stay in place and grey out rather than appearing and vanishing,
   because a bar whose buttons move is a bar you cannot learn.

   The live region says "Customizing the board" once, a beat after the bar
   mounts so the announcement is not swallowed by the focus move. */
function CustomizeBar({
  phone,
  canUndo,
  arranged,
  addCount,
  onDone,
  onUndo,
  onAdd,
  onPreset,
  onTidy,
  onReorder,
  onReset,
  addRef,
  doneRef,
}: {
  phone: boolean
  canUndo: boolean
  arranged: boolean
  addCount: number
  onDone: () => void
  onUndo: () => void
  onAdd: () => void
  onPreset: (p: Preset) => void
  onTidy: () => void
  onReorder: () => void
  onReset: () => void
  addRef: RefObject<HTMLButtonElement>
  doneRef: RefObject<HTMLButtonElement>
}) {
  const t = useT()
  const [layouts, setLayouts] = useState(false)
  const layoutsBtn = useRef<HTMLButtonElement>(null)
  const closeLayouts = useCallback(() => setLayouts(false), [])
  const [said, setSaid] = useState('')
  useEffect(() => {
    const id = window.setTimeout(() => setSaid(t('bento.widgets.announce')), 80)
    return () => window.clearTimeout(id)
  }, [t])
  const presets = phone ? PHONE_PRESETS : PRESETS

  return (
    <div
      className={cn('bento-customize-bar', phone && 'is-phone')}
      role="toolbar"
      aria-label={t('bento.widgets.customize')}
    >
      <span className="sr-only" role="status" aria-live="polite">{said}</span>
      <button ref={doneRef} type="button" onClick={onDone} className="bento-bar__btn is-primary">
        <Check className="size-3.5" aria-hidden="true" />
        <span>{t('bento.widgets.done')}</span>
      </button>
      <button type="button" onClick={onUndo} disabled={!canUndo} className="bento-bar__btn">
        <Undo2 className="size-3.5" aria-hidden="true" />
        <span>{t('bento.widgets.undo')}</span>
      </button>
      <button
        ref={addRef}
        type="button"
        onClick={onAdd}
        disabled={addCount === 0}
        aria-haspopup="dialog"
        title={addCount === 0 ? t('bento.widgets.nothing_to_add') : undefined}
        className="bento-bar__btn"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        <span>{t('bento.widgets.add_card')}</span>
      </button>
      <button
        ref={layoutsBtn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={layouts}
        onClick={() => setLayouts((v) => !v)}
        className="bento-bar__btn"
      >
        <LayoutGrid className="size-3.5" aria-hidden="true" />
        <span>{t('bento.widgets.layouts')}</span>
      </button>
      <Menu open={layouts} anchor={layoutsBtn.current} label={t('bento.widgets.layouts')} onClose={closeLayouts} width={260}>
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            role="menuitem"
            className="bento-menu__item"
            onClick={() => {
              onPreset(p)
              setLayouts(false)
            }}
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
      </Menu>
      {phone ? (
        <button type="button" onClick={onReorder} aria-haspopup="dialog" className="bento-bar__btn">
          <ListOrdered className="size-3.5" aria-hidden="true" />
          <span>{t('bento.widgets.reorder')}</span>
        </button>
      ) : (
        <button type="button" onClick={onTidy} className="bento-bar__btn">
          <Sparkles className="size-3.5" aria-hidden="true" />
          <span>{t('bento.widgets.tidy')}</span>
        </button>
      )}
      <button type="button" onClick={onReset} disabled={!arranged} className="bento-bar__btn">
        <RotateCcw className="size-3.5" aria-hidden="true" />
        <span>{t('bento.widgets.reset')}</span>
      </button>
    </div>
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

/* Turn the pager one page, for a card held at its edge. Pages are found by
   position rather than by index arithmetic so the gap between them is never
   a second number to keep in step with the stylesheet. */
function flipPage(board: HTMLElement, dir: 1 | -1) {
  const pages = Array.from(board.querySelectorAll<HTMLElement>('.bento-page'))
  if (pages.length < 2) return
  const left = board.getBoundingClientRect().left
  let at = 0
  let best = Infinity
  pages.forEach((p, i) => {
    const d = Math.abs(p.getBoundingClientRect().left - left)
    if (d < best) {
      best = d
      at = i
    }
  })
  const next = pages[at + dir]
  if (!next) return
  next.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  buzz('snap')
}

export function WidgetLayer({
  dashboard,
  children,
}: {
  dashboard: string
  children: ReactNode
}) {
  const [declared, setDeclared] = useState<BoardWidget[]>([])
  /* Always rendered, unlike the toolbar, so the board element can be reached
     whether or not anybody is arranging. */
  const markRef = useRef<HTMLSpanElement>(null)
  const { arranging, setArranging } = useBoard()
  const { layout, place, reset, undo, canUndo, tidy, applyPreset } = useLayout(dashboard)
  const t = useT()
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /* Mirrored in a ref because the touchmove listener below has to answer
     synchronously, in the same event, and state is a render behind. */
  const [dragging, setDraggingState] = useState<string | null>(null)
  const draggingRef = useRef<string | null>(null)
  const setDragging = useCallback((id: string | null) => {
    draggingRef.current = id
    setDraggingState(id)
  }, [])
  const [gallery, setGallery] = useState(false)
  const [sheet, setSheet] = useState(false)
  const addRef = useRef<HTMLButtonElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)

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

  /* Escape leaves customize mode — unless something is open on top of it, in
     which case Escape is for that. The menus and the gallery catch their own
     Escape on the way down; the branches here are the fallback that keeps
     this correct on its own. */
  useEffect(() => {
    if (!arranging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (gallery) {
        setGallery(false)
        return
      }
      if (sheet) {
        setSheet(false)
        return
      }
      setArranging(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [arranging, gallery, sheet, setArranging])

  /* Nothing stays open past the mode it belongs to. */
  useEffect(() => {
    if (arranging) return
    setGallery(false)
    setSheet(false)
  }, [arranging])

  /* FOCUS FOLLOWS THE MODE. On the way in it lands on Done, so a keyboard is
     in the toolbar and a screen reader hears the bar's name. On the way out
     it returns to the door it came in by — the pencil on the phone, the pill
     on the desk — which is a fresh element by then, both being unmounted
     while the mode is on, so it is found by class rather than remembered. */
  const wasArranging = useRef(false)
  useEffect(() => {
    if (arranging === wasArranging.current) return
    wasArranging.current = arranging
    const id = requestAnimationFrame(() => {
      if (arranging) {
        doneRef.current?.focus()
      } else {
        document.querySelector<HTMLElement>('.bento-dots__edit, .bento-edit-pill')?.focus()
      }
    })
    return () => cancelAnimationFrame(id)
  }, [arranging])

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

  /* PAGED WHILE EDITING TOO: a swipe still turns the page, and a held card
     rides across pages. The swipe-up for the launcher is the one thing that
     does stop, because a finger on a card being arranged is not asking for
     the launcher. */
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
     stylesheet dress the cards for the mode. */
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
    board.setAttribute('data-arranging', phone ? 'phone' : 'desk')
    return () => board.removeAttribute('data-arranging')
  }, [arranging, phone])

  /* A HELD CARD DOES NOT SCROLL THE PAGE. The pager is a horizontal scroller
     and the card's surface allows a horizontal pan, so a swipe still turns
     the page while customizing; but once a card is being carried, the same
     movement must move the card and nothing else. touch-action cannot change
     mid-gesture, so the scroll is refused here, on the first touchmove after
     the hold — which is before the browser has committed to scrolling,
     because the finger held still for the hold. Non-passive on purpose. */
  useEffect(() => {
    const board = markRef.current?.closest('.bento-board') as HTMLElement | null
    if (!board || !arranging || !phone) return
    const onTouchMove = (e: TouchEvent) => {
      if (draggingRef.current) e.preventDefault()
    }
    board.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => board.removeEventListener('touchmove', onTouchMove)
  }, [arranging, phone])
  useEffect(() => {
    const board = markRef.current?.closest('.bento-board') as HTMLElement | null
    if (!board || !dragging) return
    board.setAttribute('data-dragging', '')
    return () => board.removeAttribute('data-dragging')
  }, [dragging])

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
    () => ({
      dashboard, editing: arranging, declare, visible, fitted, maxRows, phone, spots: spotMap,
      dropTarget, setDropTarget, dragging, setDragging,
    }),
    [
      dashboard, arranging, declare, maxRows, phone, spotMap, dropTarget, dragging, setDragging,
      /* Sizes as well as ids: `visible` seeds `move` for every widget nobody
         has explicitly placed, and a key of ids alone would hand it the
         previous render's w/h. */
      visible.map((d) => `${d.id}:${d.w}x${d.h}`).join(','),
      [...fitted].join(','),
    ],
  )

  const ink = { '--ink-here': INK_HERE_FROM_PAGE, color: 'var(--ink-here)' } as CSSProperties

  /* THE GALLERY'S LIST: every card that is off the board, with the tiers it
     could come back at. On the desk a tier fits if the whole board still
     fits with it added; on the phone everything fits, because a page is
     added rather than a card dropped. The default is the tier the card was
     designed at, or the first that fits if that one does not. */
  const visibleDims = visible.map((v) => drawnDims(layout, v.id, v.size))
  const items: GalleryItem[] = off.map((d) => {
    const tiers = (phone ? PHONE_TIERS : TIERS).filter((tier) => {
      if (phone) return true
      return rowsNeeded([...visibleDims, dimsForTier(tier, false)]) <= maxRows
    })
    const designed = tierOf(clampSpan(DIMS[d.size].w), clampRows(DIMS[d.size].h), phone)
    return {
      id: d.id,
      label: d.label,
      tiers,
      defaultTier: tiers.includes(designed) ? designed : tiers[0] ?? designed,
    }
  })
  const onAdd = (id: string, tier: SizeTier) => {
    const d = dimsForTier(tier, phone)
    place(id, d.w, d.h)
    buzz('tap')
    /* iCloud keeps the picker open so several can be added in a row; it
       closes itself only when there is nothing left to pick. */
    if (off.length <= 1) setGallery(false)
  }

  return (
    <Ctx.Provider value={value}>
      <span ref={markRef} className="hidden" aria-hidden="true" />
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

      {/* THE BAR, on both form factors: the only chrome the mode has. No
          backdrop — the board is the thing being edited and every tap on it
          means something. Its ground is the card colour it paints itself. */}
      {arranging && createPortal(
        <CustomizeBar
          phone={phone}
          canUndo={canUndo}
          arranged={arranged}
          addCount={off.length}
          onDone={() => setArranging(false)}
          onUndo={undo}
          onAdd={() => setGallery((v) => !v)}
          onPreset={(p) => applyPreset(p, declared)}
          onTidy={() => tidy(declared)}
          onReorder={() => setSheet(true)}
          onReset={reset}
          addRef={addRef}
          doneRef={doneRef}
        />,
        document.body,
      )}
      {arranging && (
        <AddGallery
          open={gallery}
          items={items}
          phone={phone}
          onAdd={onAdd}
          onClose={() => setGallery(false)}
          anchor={addRef.current}
        />
      )}
      {/* The phone's reorder list: the old sheet, now a secondary editor
          opened from the bar. Done on it closes the sheet, not the mode. */}
      {paged && arranging && sheet && createPortal(
        <ArrangeSheet
          dashboard={dashboard}
          declared={declared}
          visible={visible}
          onDone={() => setSheet(false)}
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
    grid cell across. Given a `label` it is drawn as a menu row instead of a
    bare swatch — the size menu's last line — and opens the same wheel. */
export function ColourPick({
  value,
  onPick,
  label,
}: {
  value: Hsl | null
  onPick: (c: Hsl | null) => void
  label?: string
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
    /* On the way down and stopped, for the same reason the menus do it: the
       layer's Escape ends the mode, and closing a wheel is not that. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const toggle = () => {
    const r = btn.current?.getBoundingClientRect()
    if (r) {
      setAt({
        left: Math.min(r.left, window.innerWidth - 236),
        top: Math.min(r.bottom + 6, window.innerHeight - 300),
      })
    }
    setOpen((v) => !v)
  }
  const fill = value ? softTintBg(value) : 'var(--bento-card)'

  return (
    <>
      {label ? (
        <button
          ref={btn}
          type="button"
          role="menuitem"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggle}
          className="bento-menu__item"
        >
          <span className="bento-swatch is-dot" aria-hidden="true" style={{ background: fill }} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      ) : (
        <button
          ref={btn}
          type="button"
          aria-label={t('bento.widgets.colour_default')}
          aria-expanded={open}
          onClick={toggle}
          className="bento-swatch"
          style={{ background: fill }}
        />
      )}

      {open && at && createPortal(
        <div
          ref={pop}
          data-colour-pop=""
          /* A 228px card beside the swatch on a desk; on a phone the swatch is
             in a sheet at the foot of the screen and the same card overflowed
             the right edge and the bottom. Narrow, it becomes a sheet of its
             own: full width less a margin, pinned above the home indicator. */
          style={
            window.innerWidth < 640
              ? {
                  position: 'fixed',
                  left: 12,
                  right: 12,
                  bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
                  width: 'auto',
                }
              : { position: 'fixed', left: at.left, top: at.top, width: 228 }
          }
          className="z-[85] rounded-xl border p-3 shadow-lg bg-[var(--bento-card)]
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

/* The drag, in one record so a single release can clear all of it. */
interface Drag {
  /** Where the pointer went down. */
  x: number
  y: number
  /** Where it was last seen, for the ghost to be recomputed when the pager
      scrolls under it. */
  lastX: number
  lastY: number
  /** The card under the pointer, or null. */
  id: string | null
  /** Carrying the card: true from the down on a desk, after the hold on a
      phone. Before it the finger may still be swiping the page. */
  live: boolean
  hold?: number
  /** The pager's scrollLeft when the card was picked up. */
  scroll: number
  board: HTMLElement | null
  onScroll?: () => void
  /** The edge the pointer is resting at, and the timer that turns the page. */
  edgeDir: -1 | 0 | 1
  edge?: number
}

/* How long a finger rests on a card before it lifts — shorter than the
   half-second that opens the mode, because inside it a hold is expected. */
const HOLD_TO_LIFT = 200
/* Movement that ends a hold before it lifts: a swipe, not a press. */
const HOLD_SLOP = 8
/* The band at each side of the pager where a held card asks for the next
   page, and how long it must wait there. */
const EDGE = 36
const EDGE_WAIT = 600

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
  const { layout, remove, recolour, move, setTier } = useLayout(layer?.dashboard ?? 'default')
  const t = useT()

  const { w, h } = dimsOf(layout, id, declaredSize)

  /* Declared in an effect, not in the render body: calling the parent's
     setState while rendering a child is illegal in React. */
  const declare = layer?.declare
  useEffect(() => {
    declare?.({ id, label, index, size: declaredSize, w, h, optional })
  }, [declare, id, label, index, declaredSize, w, h, optional])

  /* THE DRAG, on both boards. Pointer events rather than HTML5 drag, so the
     ghost is the card itself moved by a transform, the drop target is
     whatever card is under the pointer, and reduced motion has nothing to
     switch off because nothing animates. Committed on release: reordering
     live would reflow the grid under the ghost and carry it off.

     On a desk a press is a drag. On a phone a press is ambiguous — it may be
     the start of a swipe that turns the page — so the card lifts only after
     a short hold with the finger still, and a finger that moves first is
     left to the pager. */
  const [ghost, setGhost] = useState<{ dx: number; dy: number } | null>(null)
  const drag = useRef<Drag | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  /* One gate, and it is the board's own answer. `layer.fitted` already folds
     in the removed list, the `optional` default and the three-row ceiling. */
  if (layer && !layer.fitted.has(id)) return null
  if (isRemoved(layout, id)) return null

  const order = orderOf(layout, id, index)
  const editing = layer?.editing ?? false
  const phone = layer?.phone ?? false
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

  /* The card under a point, other than this one. The ghost is what the
     pointer is over, so it steps aside for the lookup. */
  const targetOver = (x: number, y: number): string | null => {
    const self = wrapRef.current
    const was = self?.style.pointerEvents ?? ''
    if (self) self.style.pointerEvents = 'none'
    const el = document.elementFromPoint(x, y)
    if (self) self.style.pointerEvents = was
    const w2 = el?.closest<HTMLElement>('.bento-widget[data-widget-id]')
    const tid = w2?.getAttribute('data-widget-id') ?? null
    if (tid && tid !== id) return tid
    /* Nothing under the finger on a phone: the empty half of a page. The
       drop goes after the last card on that page, which is the card that is
       highlighted. */
    if (!layer?.spots || !drag.current?.board) return null
    const pagesEls = Array.from(drag.current.board.querySelectorAll<HTMLElement>('.bento-page'))
    const n = pagesEls.findIndex((p) => {
      const r = p.getBoundingClientRect()
      return x >= r.left && x < r.right
    })
    if (n < 0) return null
    let last: string | null = null
    for (const v of layer.visible) {
      const s = layer.spots.get(v.id)
      if (s && s.page === n && v.id !== id) last = v.id
    }
    return last
  }

  const lift = (f: Drag, el: HTMLElement, pointerId: number) => {
    f.live = true
    try { el.setPointerCapture(pointerId) } catch { /* gone */ }
    f.scroll = f.board?.scrollLeft ?? 0
    if (f.board) {
      /* The pager may scroll under the finger — the edge timer asks it to —
         and the ghost is a grid child that scrolls with it, so the offset
         is recomputed from the last pointer position on every scroll. */
      f.onScroll = () => {
        const b = f.board
        if (!b) return
        setGhost({ dx: f.lastX - f.x + (b.scrollLeft - f.scroll), dy: f.lastY - f.y })
      }
      f.board.addEventListener('scroll', f.onScroll, { passive: true })
    }
    layer?.setDragging(id)
    setGhost({ dx: 0, dy: 0 })
    if (phone) buzz('select')
  }

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!editing || !e.isPrimary || !layer) return
    if ((e.target as HTMLElement).closest('button,input,[role="menu"]')) return
    const el = e.currentTarget
    const f: Drag = {
      x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY,
      id: null, live: false, scroll: 0,
      board: el.closest<HTMLElement>('.bento-board'),
      edgeDir: 0,
    }
    drag.current = f
    if (phone) {
      const pointerId = e.pointerId
      f.hold = window.setTimeout(() => {
        if (drag.current === f) lift(f, el, pointerId)
      }, HOLD_TO_LIFT)
    } else {
      e.preventDefault()
      lift(f, el, e.pointerId)
      /* No ghost until the pointer has actually moved: a click is not a
         drag, and a card that jumps on mousedown feels broken. */
      setGhost(null)
    }
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = drag.current
    if (!f || !layer) return
    const dx = e.clientX - f.x
    const dy = e.clientY - f.y
    f.lastX = e.clientX
    f.lastY = e.clientY
    if (!f.live) {
      /* Still deciding, on a phone: movement means a swipe, and the pager
         has it. */
      if (Math.hypot(dx, dy) > HOLD_SLOP) {
        window.clearTimeout(f.hold)
        drag.current = null
      }
      return
    }
    if (!ghost && Math.hypot(dx, dy) < 6) return
    const sx = f.board ? f.board.scrollLeft - f.scroll : 0
    setGhost({ dx: dx + sx, dy })
    const over = targetOver(e.clientX, e.clientY)
    if (over !== f.id) {
      f.id = over
      layer.setDropTarget(over)
      if (phone && over) buzz('tap')
    }
    /* At the pager's edge, wait, then turn the page; keep turning while the
       finger stays there. */
    if (phone && f.board) {
      const r = f.board.getBoundingClientRect()
      const dir: -1 | 0 | 1 = e.clientX < r.left + EDGE ? -1 : e.clientX > r.right - EDGE ? 1 : 0
      if (dir !== f.edgeDir) {
        window.clearTimeout(f.edge)
        f.edgeDir = dir
        if (dir !== 0) {
          const b = f.board
          const arm = () => {
            f.edge = window.setTimeout(() => {
              if (drag.current !== f) return
              flipPage(b, dir)
              arm()
            }, EDGE_WAIT)
          }
          arm()
        }
      }
    }
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const f = drag.current
    drag.current = null
    if (!f) return
    window.clearTimeout(f.hold)
    window.clearTimeout(f.edge)
    if (f.onScroll) f.board?.removeEventListener('scroll', f.onScroll)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    if (!layer) return
    if (!f.live) return
    layer.setDragging(null)
    setGhost(null)
    layer.setDropTarget(null)
    if (commit && f.id) {
      const to = layer.visible.findIndex((v) => v.id === f.id)
      if (to >= 0) {
        move(id, to, layer.visible)
        if (phone) buzz('snap')
      }
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
      data-editing={editing ? '' : undefined}
      data-dragging={ghost ? '' : undefined}
      data-drop-target={layer?.dropTarget === id ? '' : undefined}
    >
      {/* The repointed palette is scoped to the CELL, not to the wrapper, so
          the editing controls keep the page's ink. On the phone the cell is
          told the size the PACK gave it, which is one row unless Tall was
          chosen; elsewhere the stored size. While customizing the cell is
          inert: still drawn, but neither a link nor a tab stop, so the
          keyboard lands on the controls over it. */}
      <div className="h-full [&>*]:h-full" style={paint} {...(editing ? INERT : {})}>
        <WidgetSizeContext.Provider value={{ w: spot ? spot.w : cw, h: spot ? spot.h : ch }}>
          {children(span)}
        </WidgetSizeContext.Provider>
      </div>

      {editing && (
        /* THE EDIT SURFACE: transparent, over the whole card, so a press
           anywhere starts a drag and never opens the link underneath. The
           remove button sits at the top-left and the size pill at the
           bottom-right, both always shown — a control that appears on hover
           does not exist on a phone. Ink is the page's, stated once here. */
        <div
          className="bento-edit absolute inset-0 z-10 rounded-[var(--bento-radius)]"
          style={{ '--ink-here': INK_HERE_FROM_PAGE, color: 'var(--ink-here)' } as CSSProperties}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={(e) => endDrag(e, true)}
          onPointerCancel={(e) => endDrag(e, false)}
          /* Android answers the hold that lifts a card with a context menu;
             there is nothing here to put in one. */
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              remove(id)
              buzz('tap')
            }}
            aria-label={t('bento.widgets.remove_card', { label })}
            title={t('bento.widgets.remove')}
            className="bento-edit__remove"
          >
            <Minus className="size-3.5" aria-hidden="true" />
          </button>
          <SizeMenu
            label={label}
            cw={cw}
            ch={ch}
            phone={phone}
            fits={fitsAt}
            tint={tint}
            onTier={(tier) => setTier(id, tier, phone)}
            onTint={(c) => recolour(id, c, cw, ch)}
          />
        </div>
      )}
    </div>
  )
}
