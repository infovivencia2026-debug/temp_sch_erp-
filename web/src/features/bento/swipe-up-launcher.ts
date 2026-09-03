import { useEffect } from 'react'
import { cancelLauncher, dragLauncher } from './launcher-open'

/* SWIPE UP ON THE HOME BOARD TO OPEN EVERYTHING.

   The board is a home screen: cards you arrange, paged sideways with dots
   underneath. Every phone in the world answers one gesture on a screen that
   looks like that — push the home up and the drawer of everything comes with
   it — and until now this one did not. The way to the full list was the orb,
   or the word at the end of the dock, both of which have to be found first.

   WHY THIS IS SAFE HERE AND WOULD NOT BE ELSEWHERE. The board is the one
   surface in the product that does not scroll vertically; its own stylesheet
   states the contract outright ("a page does not scroll vertically -- that is
   the whole contract") and divides the height it is given into three rows.
   So an upward drag on the board is not competing with anything: there is no
   content to move under the finger and nothing to overscroll past. On any
   other screen this gesture would be scrolling, which is why it is bound to
   the board and not to the app.

   The rules are the same shape as PullToRefresh's, and for the same reason:
   every one of them exists to refuse rather than to fire.

     - Mostly vertical, or a page flick with a bit of drift in it starts
       opening the launcher instead of turning the page. The board snaps
       horizontally between pages and that gesture has to stay untouched.
     - One finger. A second means a pinch, never a swipe.
     - Far enough to be deliberate. A short flick is somebody adjusting their
       grip on a card, and 64px is roughly the travel that reads as intent
       without asking for a whole-screen sweep.
     - Never while an overlay is open, since the drag then belongs to whatever
       is on top.
     - Never while arranging. A drag in that mode is moving a card, and
       opening a drawer over somebody rearranging their home is the worst
       possible reading of it.

   Listeners are passive and nothing is ever prevented. The gesture does not
   need to stop the browser doing anything -- there is nothing to stop -- and
   claiming it would risk breaking the horizontal snap it sits beside. */

const SLOP = 10
const TRAVEL = 64
/* How far the thumb travels for the sheet to be fully up. Under half the
   screen: a drawer that needs the whole height is one nobody finishes
   opening, and the flick below covers the rest of the distance anyway. */
const SPAN_FRACTION = 0.42
/* px per ms. An upward flick faster than this opens even from a short drag,
   the way a home screen's drawer does; slower than it, distance decides. */
const FLICK = 0.5

export function useSwipeUpForAll(enabled: boolean, open: () => void) {
  useEffect(() => {
    if (!enabled) return
    /* Bound to the ground rather than the board, so a swipe that starts in the
       margins around the cards count as "anywhere" too. The board is the
       fallback for the screens that render without a ground. */
    const el =
      document.querySelector<HTMLElement>('.bento-ground') ??
      document.querySelector<HTMLElement>('.bento-board')
    if (!el) return

    let x = 0
    let y = 0
    let live = false
    let dragging = false
    let lastY = 0
    let lastT = 0
    let velocity = 0

    const span = () => Math.max(160, window.innerHeight * SPAN_FRACTION)

    const drop = () => {
      live = false
      if (dragging) {
        dragging = false
        cancelLauncher()
      }
    }

    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        drop()
        return
      }
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) {
        live = false
        return
      }
      x = e.touches[0].clientX
      y = e.touches[0].clientY
      lastY = y
      lastT = e.timeStamp
      velocity = 0
      live = true
      dragging = false
    }

    const move = (e: TouchEvent) => {
      if (!live) return
      if (e.touches.length !== 1) {
        drop()
        return
      }
      const cy = e.touches[0].clientY
      const dy = cy - y
      const dx = Math.abs(e.touches[0].clientX - x)
      // A page flick, or a drag that turned downward before it became a
      // drawer: not ours. Once the sheet is moving, a downward wobble is just
      // the sheet coming back down under the thumb, so only the pre-drag
      // checks refuse.
      if (!dragging) {
        if (dx > SLOP && dx > Math.abs(dy)) {
          live = false
          return
        }
        if (dy > SLOP) {
          live = false
          return
        }
        if (-dy < SLOP) return
        dragging = true
      }
      const dt = e.timeStamp - lastT
      if (dt > 0) velocity = (lastY - cy) / dt
      lastY = cy
      lastT = e.timeStamp
      dragLauncher(-dy / span())
    }

    const end = (e: TouchEvent) => {
      if (!live) return
      live = false
      if (!dragging) return
      dragging = false
      const dy = lastY - y
      const travelled = -dy
      if (travelled >= TRAVEL || velocity >= FLICK) open()
      else cancelLauncher()
      void e
    }

    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', end, { passive: true })
    el.addEventListener('touchcancel', drop, { passive: true })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', drop)
    }
  }, [enabled, open])
}
