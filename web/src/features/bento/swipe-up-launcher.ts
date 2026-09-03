import { useEffect } from 'react'

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

export function useSwipeUpForAll(enabled: boolean, open: () => void) {
  useEffect(() => {
    if (!enabled) return
    /* The ground rather than the board, so the strip beside the dots and the
       margins around the cards count as "anywhere" too. The board is the
       fallback for the screens that render without a ground. */
    const el =
      document.querySelector<HTMLElement>('.bento-ground') ??
      document.querySelector<HTMLElement>('.bento-board')
    if (!el) return

    let x = 0
    let y = 0
    let live = false

    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        live = false
        return
      }
      x = e.touches[0].clientX
      y = e.touches[0].clientY
      live = true
    }

    const move = (e: TouchEvent) => {
      if (!live) return
      if (e.touches.length !== 1) {
        live = false
        return
      }
      const dy = e.touches[0].clientY - y
      const dx = Math.abs(e.touches[0].clientX - x)

      // Sideways past the slop settles it for the rest of the gesture: that
      // was a page turn, and it stays one however it ends.
      if (dx > SLOP && dx > Math.abs(dy)) {
        live = false
        return
      }
      if (dy > SLOP) {
        // Downward. Not this gesture, and at the top of the app shell it may
        // be the pull to refresh.
        live = false
        return
      }
      if (-dy >= TRAVEL) {
        live = false
        if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
        open()
      }
    }

    const end = () => {
      live = false
    }

    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', end, { passive: true })
    el.addEventListener('touchcancel', end, { passive: true })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [enabled, open])
}
