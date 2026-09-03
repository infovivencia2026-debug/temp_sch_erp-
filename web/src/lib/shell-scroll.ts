/* TELLING THE ANDROID SHELL WHERE THE SCROLLER IS.

   The parent app wraps this site in a WebView and offers pull-to-refresh. That
   gesture must only fire when the content is already at the top, and the app
   cannot tell: it asks the WebView, the WebView reports on the DOCUMENT, and
   this application scrolls an element inside the document. The dock is fixed
   and the shell scrolls internally, so the document sits at zero on nearly
   every screen however far down the reader actually is.

   The result on a real handset: fifteen screens into the setup wizard, one
   downward flick reloaded the page and threw it back to the start. On a
   half-filled form that is the form gone. It also destroyed open overlays —
   dragging inside "All features" reloaded and landed on the dashboard.

   So the page says where it is, and the app believes the page rather than the
   WebView. The app defaults to refusing, so a bundle without this file (or a
   screen that has not reported yet) simply gets no gesture, which is the safe
   direction: a missing convenience costs nothing, and the other default costs
   somebody's typing.

   Nothing happens outside the app — the bridge is absent in every browser, so
   this is a no-op on the web and there is no branch to keep in step. */

interface ErpShell {
  setAtTop(v: boolean): void
}

declare global {
  interface Window {
    ErpShell?: ErpShell
  }
}

/* An overlay counts as "not at the top" whatever its own scroll position.

   A modal, the launcher, the notification sheet: a downward drag inside one of
   those is never a request to reload the page underneath it, and treating it as
   one closed the overlay and threw away whatever was in it. The scroll position
   of the thing behind is irrelevant while something is on top of it. */
function overlayOpen(): boolean {
  return !!document.querySelector('[data-overlay-open], [role="dialog"], [aria-modal="true"]')
}

function scrollerAtTop(): boolean {
  if (overlayOpen()) return false
  /* The application's scroller, then the document as the fallback. Whichever
     is actually doing the scrolling is the one whose position decides. */
  const el = document.querySelector<HTMLElement>('[data-app-scroll]')
  if (el) return el.scrollTop <= 0
  const doc = document.scrollingElement ?? document.documentElement
  return (doc?.scrollTop ?? 0) <= 0
}

export function reportScrollToShell() {
  const bridge = window.ErpShell
  if (!bridge?.setAtTop) return

  let last: boolean | undefined
  const send = () => {
    const now = scrollerAtTop()
    // Only on change: this runs on every scroll frame, and crossing the bridge
    // is the expensive part of it.
    if (now === last) return
    last = now
    try {
      bridge.setAtTop(now)
    } catch {
      /* The bridge can go away mid-session when the WebView is torn down. */
    }
  }

  /* Capture, because the scroll happens on an inner element and scroll events
     do not bubble. Passive, because this never prevents a default and saying
     so keeps it off the gesture's critical path. */
  document.addEventListener('scroll', send, { capture: true, passive: true })
  /* A route change replaces the scroller and usually starts at the top, and
     an overlay opening or closing changes the answer without any scrolling at
     all. Neither fires a scroll event. */
  const obs = new MutationObserver(send)
  obs.observe(document.body, { childList: true, subtree: true })
  send()
}
