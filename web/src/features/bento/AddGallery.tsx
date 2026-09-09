import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { useReduceMotion } from './bento-kit'
import './add-gallery.css'

/* THE "ADD A CARD" GALLERY, THE WAY ICLOUD.COM ADDS A TILE.

   The old Add control was a list of names in a disclosure: pick a name, get
   the card at whatever size it was declared, then resize it in a second
   gesture. This shows every card that is NOT on the board as a tile — a
   schematic preview, the name, a hint — with a row of four sizes under it, so
   choosing the card and choosing its footprint is one press.

   TWO COMPOSITIONS, ONE COMPONENT. On the desk it is a popover hung under the
   Add button, three tiles across, scrolling inside itself. On a phone it is a
   sheet from the bottom edge, like ArrangeSheet, because a popover under a
   44px button on a 390px screen is the whole screen anyway. The parent says
   which with `phone`, the same flag WidgetLayer already decides.

   WHAT THE PARENT OWNS. The list of items and which tiers fit right now —
   this component never reads the layout store. `onAdd(id, tier)` is the
   whole contract; the parent places the card and, on its next render, the
   item is gone from `items`. The tile shows a brief "Added" before that
   happens and copes if it never does, or if the item vanishes at once.

   NO COLOUR IS NAMED. Every mark in the preview is a currentColor mix, so a
   tile drawn on the dark card and one drawn on the light card are the same
   drawing; the stylesheet only ever reads the --bento-* tokens. The test
   file scans both sources for a literal. */

export type SizeTier = 'small' | 'medium' | 'large' | 'wide'

export type GalleryItem = {
  id: string
  label: string
  hint?: string
  /** The tiers that fit on the board right now; the rest render disabled. */
  tiers: SizeTier[]
  /** The tier Enter adds at, and the one the preview is drawn as. */
  defaultTier: SizeTier
}

/** The three tiers in the order the size row draws them; the digit keys 1-3
    follow the same order. The same order as lib/size-tiers.ts TIERS, which
    dropped Wide from the offer while keeping it as a shape a stored board may
    already hold. */
const TIERS: readonly SizeTier[] = ['small', 'medium', 'large']

/** The footprint each tier stands for, as drawn in the size glyphs. The
    board's own columns-and-rows for a tier live in lib/widgets; this is the
    picture, not the placement. */
export const TIER_FOOTPRINT: Record<SizeTier, { w: number; h: number }> = {
  small: { w: 1, h: 1 },
  medium: { w: 2, h: 1 },
  large: { w: 2, h: 2 },
  wide: { w: 3, h: 1 },
}

/** Enter and exit, in milliseconds: the --bento-dur token the stylesheet
    transitions on. */
const MOTION_MS = 200
/** How long a tile says "Added" if the parent leaves it in the list. */
const ADDED_MS = 900
/** The popover's width on the desk: three tiles, two gutters, the padding. */
const PANEL_W = 640
/** The tallest the popover gets: the stylesheet's own cap. */
const PANEL_H = 640
const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Where the desk popover goes. `top` when it hangs below the anchor,
    `bottom` (a distance from the viewport's bottom edge) when it opens
    above — so the panel's lower edge hugs the anchor whatever its content
    height comes to. */
export type Pos = {
  top?: number
  bottom?: number
  left: number
  width: number
  maxHeight: number
  /** Opening above the anchor: the stylesheet flips the transform origin. */
  up: boolean
}

/** The gap between the anchor and the panel, and the margin the panel keeps
    from the viewport's edges. */
const GAP = 6
const MARGIN = 8
/** The panel never gets shorter than this while there is a viewport to hold
    it — the header, one row of tiles, the key hint. */
const MIN_H = 200

/* WHERE A POPOVER GOES, as a pure function of three rectangles, so a test
   that cannot lay anything out can still hold it to the rule.

   Below the anchor when the panel fits there; ABOVE it when it does not and
   there is more room above — the Add button lives on a bar fixed at the
   foot of the screen, so on a desk that is every time. The chosen side gets
   the panel's height or the room on that side, whichever is less, never
   under MIN_H unless the viewport itself is smaller. Left is clamped so the
   panel stays inside the viewport, and the panel scrolls inside itself when
   the cap is less than its content. */
export function placePanel(
  anchor: { top: number; bottom: number; left: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): Pos {
  const width = Math.max(240, Math.min(panel.width, viewport.width - 2 * MARGIN))
  const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - width - MARGIN))
  const roomBelow = viewport.height - anchor.bottom - GAP - MARGIN
  const roomAbove = anchor.top - GAP - MARGIN
  const up = panel.height > roomBelow && roomAbove > roomBelow
  const room = up ? roomAbove : roomBelow
  const cap = Math.max(MIN_H, Math.min(panel.height, room))
  const maxHeight = Math.min(cap, viewport.height - 2 * MARGIN)
  if (up) {
    /* Measured from the bottom, clamped so the top edge stays on screen. */
    const bottom = Math.min(
      Math.max(MARGIN, viewport.height - anchor.top + GAP),
      viewport.height - MARGIN - maxHeight,
    )
    return { bottom: Math.max(MARGIN, bottom), left, width, maxHeight, up }
  }
  const top = Math.min(Math.max(MARGIN, anchor.bottom + GAP), viewport.height - MARGIN - maxHeight)
  return { top: Math.max(MARGIN, top), left, width, maxHeight, up }
}

export function AddGallery({
  open, items, phone, onAdd, onClose, anchor,
}: {
  open: boolean
  items: GalleryItem[]
  phone: boolean
  onAdd: (id: string, tier: SizeTier) => void
  onClose: () => void
  /** The Add button, on the desk: the popover hangs under it and focus goes
      back to it on close. */
  anchor?: HTMLElement | null
}): ReactElement | null {
  const t = useT()
  const still = useReduceMotion()
  const uid = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const tileRefs = useRef(new Map<string, HTMLDivElement>())
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  /* Mounted for the exit transition, shown for the enter one. Two frames
     between mount and shown, as the launcher does: one to paint the start
     state, one for the transition to have somewhere to start from. */
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (open) {
      setMounted(true)
      if (still) { setShown(true); return }
      let inner = 0
      const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setShown(true)) })
      return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), still ? 0 : MOTION_MS)
    return () => window.clearTimeout(timer)
  }, [open, still])

  /* THE ROVING TAB STOP. One tile is in the tab order; the arrows move it. */
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null)
  const lastIndex = useRef(0)
  const at = items.findIndex((i) => i.id === activeId)
  if (at >= 0) lastIndex.current = at

  /* The tile that had focus was just added and is gone from the list: focus
     would otherwise fall to the body, which on the desk means the outside
     click listener's world and on a phone means nowhere. Move to the tile
     that took its place, or the panel when the list ran out. */
  useEffect(() => {
    if (!mounted) return
    if (items.some((i) => i.id === activeId)) return
    const next = items[Math.min(lastIndex.current, items.length - 1)] ?? null
    setActiveId(next?.id ?? null)
    const panel = panelRef.current
    const focused = document.activeElement
    if (panel && (!focused || focused === document.body || !panel.contains(focused))) {
      ;((next && tileRefs.current.get(next.id)) ?? panel).focus()
    }
  }, [items, activeId, mounted])

  /* Focus goes in on open and comes back out on close: to the anchor, or to
     whatever had it before. The cleanup is what returns it, so a parent that
     unmounts the gallery outright behaves the same as one that closes it. */
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    return () => {
      const back = anchorRef.current ?? prev
      if (back && back.isConnected && typeof back.focus === 'function') back.focus()
    }
  }, [open])
  useEffect(() => {
    if (!mounted || !open) return
    const first = items[0] ? tileRefs.current.get(items[0].id) : null
    ;(first ?? panelRef.current)?.focus()
    // Only on mount, so `items` is read and not depended on: a list that
    // changes while open keeps its own focus (see the effect above).
  }, [mounted, open]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Escape, caught on the way down so nothing further out — the arrange
     layer's own Escape, which leaves editing — sees it while this is up. */
  useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  /* A press outside the popover closes it. The anchor is excluded because
     its own click is what toggles the gallery; closing here and reopening
     there would flicker. The phone sheet has a backdrop instead. */
  useEffect(() => {
    if (!open || phone) return
    const onDown = (ev: Event) => {
      const target = ev.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onCloseRef.current()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, phone])

  /* The popover hangs under the anchor, or above it when the anchor sits
     in the lower half — the bar's Add button always does — and never leaves
     the viewport (placePanel); it is re-measured on resize and on any
     scroll, since the bar it hangs from is inside the board's scroller.
     Without an anchor it sits near the top, centred. */
  const [pos, setPos] = useState<Pos | null>(null)
  useLayoutEffect(() => {
    if (!mounted || phone) return
    const place = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const a = anchorRef.current
      if (!a) {
        const width = Math.max(240, Math.min(PANEL_W, vw - 16))
        setPos({ top: 72, left: Math.max(8, (vw - width) / 2), width, maxHeight: Math.max(MIN_H, vh - 88), up: false })
        return
      }
      const r = a.getBoundingClientRect()
      setPos(placePanel(r, { width: PANEL_W, height: PANEL_H }, { width: vw, height: vh }))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [mounted, phone, anchor])

  /* THE ADDED FLASH. The parent removes the item on its next render, so this
     is usually seen for one frame on the tile and then on nothing; when the
     parent keeps the item (it could not place it, say) the flash clears
     itself. Cleared on close so a reopened gallery does not say "Added". */
  const [added, setAdded] = useState<string | null>(null)
  const addedTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(addedTimer.current), [])
  useEffect(() => { if (!open) setAdded(null) }, [open])
  const add = (item: GalleryItem, tier: SizeTier) => {
    if (!item.tiers.includes(tier)) return
    setAdded(item.id)
    window.clearTimeout(addedTimer.current)
    addedTimer.current = window.setTimeout(() => setAdded(null), ADDED_MS)
    onAdd(item.id, tier)
  }

  const tiles = () =>
    items.map((i) => tileRefs.current.get(i.id)).filter((n): n is HTMLDivElement => !!n)

  const focusTile = (index: number) => {
    const list = tiles()
    if (!list.length) return
    const node = list[Math.max(0, Math.min(list.length - 1, index))]
    node.focus()
    setActiveId(node.dataset.galleryTile ?? null)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current
    if (!panel) return
    if (e.key === 'Escape') {
      // The window listener has already closed it; keep it from anyone else.
      e.stopPropagation()
      return
    }
    if (e.key === 'Tab') {
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (!nodes.length) { e.preventDefault(); return }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const here = document.activeElement
      if (e.shiftKey && (here === first || here === panel)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && here === last) { e.preventDefault(); first.focus() }
      return
    }
    const target = e.target as HTMLElement
    const tile = target.closest<HTMLElement>('[data-gallery-tile]')
    if (!tile) return
    const id = tile.dataset.galleryTile
    const index = items.findIndex((i) => i.id === id)
    if (index < 0) return
    const item = items[index]

    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); focusTile(index + 1); return
      case 'ArrowLeft': e.preventDefault(); focusTile(index - 1); return
      case 'ArrowDown': e.preventDefault(); focusTile(index + columnsOf(tiles(), phone ? 2 : 3)); return
      case 'ArrowUp': e.preventDefault(); focusTile(index - columnsOf(tiles(), phone ? 2 : 3)); return
      case 'Home': e.preventDefault(); focusTile(0); return
      case 'End': e.preventDefault(); focusTile(items.length - 1); return
      case 'Enter':
        // On the tile itself. On a size button the click does the adding.
        if (target === tile) { e.preventDefault(); add(item, item.defaultTier) }
        return
      case '1': case '2': case '3': case '4': {
        e.preventDefault()
        add(item, TIERS[Number(e.key) - 1])
        return
      }
    }
  }

  if (!mounted || typeof document === 'undefined') return null

  // The same key the size picker reads (lib/size-tiers.ts tierLabelKey), so
  // a tier is never spelled two ways.
  const sizeName = (tier: SizeTier) => t(`bento.size.${tier}`)
  const style: CSSProperties | undefined = phone || !pos
    ? undefined
    : { top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }

  return createPortal(
    <>
      {phone && (
        <div
          className="bento-gallery__backdrop"
          data-shown={shown ? '' : undefined}
          data-still={still ? '' : undefined}
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <div
        ref={panelRef}
        role="dialog"
        /* Modal only where it is: the phone sheet has a backdrop and takes
           the screen; the desk popover leaves the rest of the page live and
           closes on a click outside, which is a popover, not a modal. */
        aria-modal={phone ? 'true' : undefined}
        aria-label={t('bento.add_gallery.title')}
        className="bento-gallery"
        data-add-gallery=""
        data-phone={phone ? '' : undefined}
        data-up={!phone && pos?.up ? '' : undefined}
        data-shown={shown ? '' : undefined}
        data-still={still ? '' : undefined}
        style={style}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {phone && <div className="bento-gallery__grip" aria-hidden="true" />}
        <div className="bento-gallery__head">
          <div className="min-w-0">
            <p className="bento-gallery__title">{t('bento.add_gallery.title')}</p>
            <p className="bento-gallery__hint">{t('bento.add_gallery.hint')}</p>
          </div>
          <button
            type="button"
            className="bento-gallery__close"
            onClick={onClose}
            aria-label={t('bento.add_gallery.close')}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="bento-gallery__scroll">
          {items.length === 0 ? (
            <p className="bento-gallery__empty">{t('bento.add_gallery.empty')}</p>
          ) : (
            <div className="bento-gallery__grid" role="group" aria-label={t('bento.add_gallery.cards')}>
              {items.map((item) => (
                <Tile
                  key={item.id}
                  item={item}
                  uid={uid}
                  active={item.id === activeId}
                  added={item.id === added}
                  addedLabel={t('bento.add_gallery.added')}
                  noRoom={t('bento.add_gallery.no_room')}
                  sizeName={sizeName}
                  addAs={(size) => t('bento.add_gallery.add_as', { label: item.label, size })}
                  onFocus={() => setActiveId(item.id)}
                  onAdd={(tier) => add(item, tier)}
                  setRef={(node) => {
                    if (node) tileRefs.current.set(item.id, node)
                    else tileRefs.current.delete(item.id)
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {!phone && items.length > 0 && (
          <p className="bento-gallery__keys">{t('bento.add_gallery.keys')}</p>
        )}
      </div>
    </>,
    document.body,
  )
}

/** How many tiles share the first row. jsdom has no layout — every rect is
    zero, so every tile "shares" the row — and there the fallback is used. */
function columnsOf(tiles: HTMLElement[], fallback: number): number {
  if (tiles.length < 2) return 1
  const first = tiles[0].getBoundingClientRect()
  if (first.width === 0) return fallback
  let n = 0
  for (const tile of tiles) {
    if (Math.abs(tile.getBoundingClientRect().top - first.top) < 1) n++
    else break
  }
  return Math.max(1, n)
}

/* ONE TILE. Declared at module level, not inside the gallery's render: a
   component type made fresh on every render is unmounted and remounted on
   every render, and the launcher's recents band shipped exactly that bug —
   the button under a finger was detached before the click arrived. */
function Tile({
  item, uid, active, added, addedLabel, noRoom, sizeName, addAs, onFocus, onAdd, setRef,
}: {
  item: GalleryItem
  uid: string
  active: boolean
  added: boolean
  addedLabel: string
  noRoom: string
  sizeName: (tier: SizeTier) => string
  addAs: (size: string) => string
  onFocus: () => void
  onAdd: (tier: SizeTier) => void
  setRef: (node: HTMLDivElement | null) => void
}) {
  const labelId = `${uid}-${item.id}-label`
  const hintId = `${uid}-${item.id}-hint`
  return (
    <div
      ref={setRef}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={item.hint ? hintId : undefined}
      className="bento-gallery__tile"
      data-gallery-tile={item.id}
      data-added={added ? '' : undefined}
      tabIndex={active ? 0 : -1}
      onFocus={onFocus}
    >
      <Preview tier={item.defaultTier} />
      {added && (
        <span className="bento-gallery__added" role="status">
          <Check className="size-3" aria-hidden="true" />
          {addedLabel}
        </span>
      )}
      <span id={labelId} className="bento-gallery__label">{item.label}</span>
      {item.hint && <span id={hintId} className="bento-gallery__sub">{item.hint}</span>}
      <div className="bento-gallery__sizes">
        {TIERS.map((tier) => {
          const fits = item.tiers.includes(tier)
          return (
            <button
              key={tier}
              type="button"
              className="bento-gallery__size"
              data-tier={tier}
              data-default={tier === item.defaultTier ? '' : undefined}
              disabled={!fits}
              title={fits ? undefined : noRoom}
              aria-label={addAs(sizeName(tier))}
              tabIndex={-1}
              onClick={() => onAdd(tier)}
            >
              <Footprint tier={tier} />
              <span className="bento-gallery__size-name">{sizeName(tier)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* THE PREVIEW. A card in silhouette: a title line, a figure block, a wavy
   line where the drawing would be. Nothing in it is the card's real content;
   it says "a card" and, by its proportions, which footprint the default tier
   gives it. Everything is currentColor at a strength, so it reads on any
   ground. */
function Preview({ tier }: { tier: SizeTier }) {
  return (
    <div className="bento-gallery__preview" data-tier={tier} aria-hidden="true">
      <div className="bento-gallery__pv-card">
        <span className="bento-gallery__pv-title" />
        <span className="bento-gallery__pv-figure" />
        <svg className="bento-gallery__pv-wave" viewBox="0 0 100 24" preserveAspectRatio="none">
          <path
            d="M0 18 C 14 4, 24 4, 38 14 S 62 22, 78 10 S 92 4, 100 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </div>
  )
}

/* THE FOOTPRINT GLYPH. A 3x2 grid of cells with the tier's cells filled from
   the top left: 1x1, 2x1, 2x2, 3x1. Cells are 8 wide on a 1 gutter. */
function Footprint({ tier }: { tier: SizeTier }) {
  const { w, h } = TIER_FOOTPRINT[tier]
  const cells: ReactElement[] = []
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 3; x++) {
      const on = x < w && y < h
      cells.push(
        <rect
          key={`${x}${y}`}
          x={x * 9}
          y={y * 9}
          width={8}
          height={8}
          rx={1.5}
          fill="currentColor"
          opacity={on ? 1 : 0.22}
        />,
      )
    }
  }
  return (
    <svg className="bento-gallery__glyph" viewBox="0 0 26 17" width="22" height="15" aria-hidden="true">
      {cells}
    </svg>
  )
}
