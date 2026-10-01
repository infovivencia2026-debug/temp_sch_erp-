import { useEffect, useRef } from 'react'

/* Back closes what is on top, rather than leaving the page underneath it.
 *
 * A full-screen panel — a staff record, a report card — looks like a page and
 * is not one: it is state on the screen that opened it, so the URL never
 * changed and the browser has no idea it exists. Pressing Back therefore did
 * what Back always does, which is leave the screen entirely. Somebody opening
 * a teacher from the directory, editing them and pressing Back landed on the
 * dashboard, with the directory, the search they had typed and their place in
 * the list all gone.
 *
 * That is not a small annoyance: Back is how most people close a thing that
 * fills the screen, and the one control they reach for was the one that
 * threw their work away.
 *
 * So opening pushes an entry nobody sees. Back pops it, this closes the panel,
 * and the screen underneath is exactly as it was — still scrolled, still
 * filtered. Closing by the panel's own button goes back through the same
 * entry rather than calling onClose directly, so the history does not fill up
 * with entries for panels that are no longer open.
 *
 * Returns the function a close button should call.
 */
/* ONE BACK CLOSES ONE THING: THE ONE ON TOP.
 *
 * Every open overlay listens for the same popstate, so a dialog opened over a
 * drawer took the drawer with it: closing the dialog spent its entry, the
 * drawer heard that Back as its own and shut too, and its real entry was left
 * on the stack for the next Back to trip over. The overlays are a stack, in
 * the order they opened, and only the last one answers. */
const stack: symbol[] = []

export function useOverlayHistory(open: boolean, onClose: () => void) {
  /* THE CALLBACK IS HELD IN A REF, AND THAT IS NOT A STYLE CHOICE.
   *
   * Every caller passes an inline arrow — `onClose={() => setAll(false)}` —
   * so the function is a new identity on every render. With `onClose` in the
   * dependency list this effect therefore tore down and re-ran on every
   * render that happened while the panel was open, and its teardown calls
   * `history.back()`. A re-render of the parent, from a route change, a query
   * settling, anything, silently spent a history entry and pushed a fresh
   * one. Sometimes that nets out. Sometimes the push lands before the
   * asynchronous back resolves, and then the back consumes the new entry
   * instead of the old one — at which point the next real Back has nothing of
   * ours left to eat and leaves the app.
   *
   * The effect must run exactly once per opening, so `open` is the only thing
   * it may depend on. */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  /* Set while a popstate is being handled, so the teardown can tell the two
     ways of closing apart. They need opposite treatment and the marker alone
     cannot distinguish them: Back has already removed our entry, so calling
     `history.back()` again in the teardown takes a step that belongs to the
     page underneath — which is precisely "Back exited the app" as reported
     from the launcher. */
  const byPop = useRef(false)
  /* The teardown's `history.back()`, held for a tick.

     React's development StrictMode mounts, tears down and mounts again,
     synchronously, and a component that MOUNTS already open -- the shared
     Dialog, drawn only while it is wanted -- saw its entry pushed, taken
     back, pushed again; the popstate from that back then landed on the
     second mount's listener, which closed the dialog as it opened (traced
     as push, back, push, pop). Deferring the back lets an immediate
     re-mount cancel it and keep the entry it already has. */
  const pendingBack = useRef(0)

  useEffect(() => {
    if (!open) return
    byPop.current = false
    const me = Symbol('overlay')
    stack.push(me)

    if (pendingBack.current) {
      window.clearTimeout(pendingBack.current)
      pendingBack.current = 0
    } else {
      window.history.pushState({ erpOverlay: true }, '')
    }

    const pop = () => {
      if (stack[stack.length - 1] !== me) return
      byPop.current = true
      closeRef.current()
    }
    window.addEventListener('popstate', pop)

    return () => {
      window.removeEventListener('popstate', pop)
      const at = stack.indexOf(me)
      if (at >= 0) stack.splice(at, 1)
      /* If the panel was closed by anything other than Back — a button, an
         Escape, a route change — the entry we pushed is still on the stack and
         would otherwise need two Backs to get past. Consuming it here means
         one Back always moves one step, whichever way the panel was shut.

         Not after a Back, which has already taken it. Guarded on our own
         marker as well, so this never eats an entry belonging to somebody
         else. */
      if (!byPop.current && window.history.state?.erpOverlay) {
        pendingBack.current = window.setTimeout(() => {
          pendingBack.current = 0
          if (window.history.state?.erpOverlay) window.history.back()
        }, 0)
      }
    }
  }, [open])

  return () => {
    if (window.history.state?.erpOverlay) window.history.back()
    else closeRef.current()
  }
}
