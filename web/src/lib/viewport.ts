import { useSyncExternalStore } from 'react'

/* Which shape of device is looking at this, as one word.

   ─────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS AT ALL, GIVEN THAT NOTHING ELSE IN web/src DOES THIS.

   Responsiveness in this codebase is CSS. There is no useMediaQuery, no
   width-keyed matchMedia, and no component that forks its tree on a
   breakpoint: `window.innerWidth` is read in exactly two places and both are
   clamping a popup to the glass, not choosing a layout. That is a good rule
   and this module is the one sanctioned exception to it.

   The exception is the phone home screen. A paged board has to know HOW MANY
   pages there are, and the page count is not a property of the viewport — it
   falls out of packing this person's widgets, at their sizes, into a fixed
   two-by-three page. CSS can lay out a grid it is handed; it cannot count the
   pages, and it cannot emit one snap target per page it did not count. So the
   count is computed in JS, and the moment any of it is computed in JS the
   device question has to be answerable in JS too.

   One module, therefore, and one answer. Nothing else may call matchMedia for
   a width: a second opinion about what a phone is would drift from this one
   and from the stylesheets, and the whole point of naming the three stops
   once is that the pack, the DOM and the CSS agree about them.
   ─────────────────────────────────────────────────────────────────────────

   THE THREE STOPS, AND WHY THESE TWO NUMBERS.

   768 and 1024 are Tailwind's stock `md` and `lg`, which is to say they are
   already the numbers this project's classes and both its stylesheets are
   keyed to. Choosing anything else here would mean a JS answer and a CSS
   answer that disagree by a handful of pixels — which is the one failure mode
   that is genuinely hard to see and genuinely hard to explain.

   768 rather than 640 for the phone/tablet line specifically: 640 is the
   width at which a card grid stops being one column, not the width at which a
   device stops being a phone. A large phone in landscape is 700-ish points
   wide and is emphatically still a phone; handing it a tablet's icon rail
   because it crossed `sm` would be wrong on the most common phone posture
   after portrait. 768 is iPad portrait, which is what the word tablet means.

   THE DEFAULT IS DESKTOP, DELIBERATELY.

   `getServerSnapshot` — and any browser too old or too stripped to have
   matchMedia — answers 'desktop'. The desktop branch is the untouched one:
   every path this module added is a departure from what already shipped, so a
   missing answer takes the code that was already there rather than a phone
   layout on a workstation. A wrong 'desktop' is a board; a wrong 'phone' is a
   pager nobody can use with a mouse. */

export type Viewport = 'phone' | 'tablet' | 'desktop'

/** The two lines, in the units the stylesheets use. Exported so a test — or a
    future stylesheet — can assert against the same numbers rather than
    restating them. */
export const TABLET_MIN = 768
export const DESKTOP_MIN = 1024

const TABLET_Q = `(min-width: ${TABLET_MIN}px)`
const DESKTOP_Q = `(min-width: ${DESKTOP_MIN}px)`

/* A browser without matchMedia is not a browser this product supports, but it
   is a jsdom test, and a test that renders the shell should not have to stub a
   platform API to do it. */
function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

/* Subscribed to BOTH lists, because either line can be the one that moves.

   Dragging a window from 1100 to 900 changes only the desktop query; from 900
   to 700 changes only the tablet one. Listening to one and inferring the other
   would leave the app one resize behind on half of all resizes. */
function subscribe(fn: () => void): () => void {
  if (!supported()) return () => {}
  const lists = [window.matchMedia(TABLET_Q), window.matchMedia(DESKTOP_Q)]
  for (const l of lists) l.addEventListener('change', fn)
  return () => {
    for (const l of lists) l.removeEventListener('change', fn)
  }
}

/* Returns a string, and that is load-bearing.

   useSyncExternalStore compares snapshots with Object.is and re-renders until
   two agree. An object would be a fresh reference on every call and the render
   loop would never settle — the documented way to hang a component with this
   hook. Three words, compared by value. */
function snapshot(): Viewport {
  if (!supported()) return 'desktop'
  if (window.matchMedia(DESKTOP_Q).matches) return 'desktop'
  if (window.matchMedia(TABLET_Q).matches) return 'tablet'
  return 'phone'
}

function serverSnapshot(): Viewport {
  return 'desktop'
}

/** The device shape, re-rendering the caller when it changes. */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

/** The common question, spelled once so callers do not each write the
    comparison and one of them eventually writes `!== 'desktop'` by mistake and
    hands a tablet the phone treatment. */
export function usePhone(): boolean {
  return useViewport() === 'phone'
}

/* ─────────────────────────────────────────────────────────────────────────
   HOW MUCH BIGGER THE PLATFORM HAS MADE THE TEXT.

   Android's font size setting reaches a WebView as `textZoom`: every computed
   font-size is multiplied — px-specified ones included — and nothing else is.
   Padding, gaps and container-relative clamps stay where they were, so a card
   that was measured to hold a header, a figure and a sentence at 1.0 holds
   them at 1.3 only by pushing its drawing out through the bottom, cut mid
   glyph. No stylesheet can see the multiplier: `cqh` is multiplied too.

   The DOM can. A probe set to 10px reports its ZOOMED size from
   getComputedStyle, so the ratio is the platform's factor, and the pager can
   answer it the way a home screen does — fewer, taller tiles per page.

   Measured once per mount and again on resize (the setting cannot change
   without the activity being recreated, but a window can). 1 wherever the
   measurement is impossible, which is every environment with no zoom.
   ───────────────────────────────────────────────────────────────────────── */
let zoomCache: number | null = null
const zoomListeners = new Set<() => void>()

function measureZoom(): number {
  if (typeof document === 'undefined' || !document.body) return 1
  const probe = document.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;font-size:10px;line-height:1;visibility:hidden;pointer-events:none'
  probe.textContent = 'x'
  document.body.appendChild(probe)
  const px = parseFloat(getComputedStyle(probe).fontSize)
  probe.remove()
  const z = px > 0 ? px / 10 : 1
  // Two decimals: 12.999 is 1.3, not a third distinct value that re-renders.
  return Math.round(z * 100) / 100
}

function zoomSnapshot(): number {
  if (zoomCache === null) zoomCache = measureZoom()
  return zoomCache
}

function subscribeZoom(fn: () => void): () => void {
  zoomListeners.add(fn)
  const again = () => {
    const next = measureZoom()
    if (next !== zoomCache) {
      zoomCache = next
      for (const l of zoomListeners) l()
    }
  }
  window.addEventListener('resize', again)
  // A late re-read, for a platform that applies its zoom after first paint.
  const t = window.setTimeout(again, 600)
  return () => {
    zoomListeners.delete(fn)
    window.removeEventListener('resize', again)
    window.clearTimeout(t)
  }
}

/** The platform's text multiplier: 1 on a desktop, 1.15 or 1.3 on a phone
    whose owner set the system font to Large or Largest. */
export function useTextZoom(): number {
  return useSyncExternalStore(subscribeZoom, zoomSnapshot, () => 1)
}
