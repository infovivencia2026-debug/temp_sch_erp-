/* WHERE A DROPDOWN GOES, IN ONE PLACE.

   Every panel opened from a field -- Select, PickerMenu, Menu, the calendar,
   anything on useAnchoredPosition -- used to do this sum itself, each with an
   8px margin, each against a slightly different idea of the screen. On a
   phone that showed (owner, 2026-10-23: "dropdowns are not in the correct
   position to open on phone"): a list wider than its trigger ran off the
   right edge, a calendar sat flush against the glass, and with the keyboard
   up a list opened under it.

   The rules, once:
   - the screen is the VISUAL viewport, so the keyboard is the bottom edge;
   - phones (< 640px) keep the 16px page gutter, larger screens 8px;
   - the panel is never wider than the screen minus the gutters;
   - it lines up with the trigger, then is shifted back on screen sideways;
   - it opens below, or above when below is short and above has more room
     (unless `flip` is false), and its height is capped to the room it has,
     so it scrolls inside itself rather than running off the screen. */

export interface Viewport { left: number; top: number; width: number; height: number }
export interface Rect { top: number; bottom: number; left: number; right: number; width: number }

export interface PlaceOptions {
  /** The panel's wanted width (px). Clamped to the screen. */
  width: number
  /** The panel's natural height, when known (0 = unknown). */
  height?: number
  align?: 'start' | 'end'
  gap?: number
  maxHeight?: number
  /** Below is short and above has more room: open upwards. Default true. */
  flip?: boolean
  /** Below-only panels (the calendar) are lifted to fit instead of flipping. */
  lift?: boolean
  /** Overrides the gutter; otherwise 16 on phones, 8 elsewhere. */
  margin?: number
}

export interface Placement {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
  up: boolean
}

export const PHONE_MAX = 640

export function gutterFor(viewportWidth: number): number {
  return viewportWidth < PHONE_MAX ? 16 : 8
}

export function currentViewport(): Viewport {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (vv) return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

/** Pure: the placement for a panel against `r`, inside `view`. `layoutHeight`
    is window.innerHeight, which a `bottom:` offset is measured from. */
export function placePanel(r: Rect, view: Viewport, o: PlaceOptions, layoutHeight = view.top + view.height): Placement {
  const m = o.margin ?? gutterFor(view.width)
  const gap = o.gap ?? 6
  const cap = o.maxHeight ?? 360
  const vRight = view.left + view.width
  const vBottom = view.top + view.height

  const width = Math.max(0, Math.min(o.width, view.width - 2 * m))
  let left = o.align === 'end' ? r.right - width : r.left
  left = Math.max(view.left + m, Math.min(left, vRight - width - m))

  const roomBelow = vBottom - r.bottom - gap - m
  const roomAbove = r.top - view.top - gap - m
  const full = Math.max(0, view.height - 2 * m)
  const tall = o.height && o.height > 0 ? o.height : cap

  if (o.lift) {
    // Below the field, lifted only as far as it takes to fit on screen.
    const h = Math.min(tall, cap, full)
    const top = Math.max(view.top + m, Math.min(r.bottom + gap, vBottom - m - h))
    return { left, width, top, maxHeight: Math.min(cap, full), up: false }
  }

  const up = (o.flip ?? true) && Math.min(tall, cap) > roomBelow && roomAbove > roomBelow
  const room = Math.max(Math.min(96, full), up ? roomAbove : roomBelow)
  const maxHeight = Math.min(cap, room, full)
  if (up) return { left, width, bottom: layoutHeight - (r.top - gap), maxHeight, up }
  // A field scrolled past the foot of the screen: keep the panel on it.
  const top = Math.min(r.bottom + gap, vBottom - m - Math.min(tall, maxHeight))
  return { left, width, top: Math.max(view.top + m, top), maxHeight, up }
}
