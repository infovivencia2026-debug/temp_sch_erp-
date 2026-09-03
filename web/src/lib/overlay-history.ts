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

  useEffect(() => {
    if (!open) return
    byPop.current = false

    window.history.pushState({ erpOverlay: true }, '')

    const pop = () => {
      byPop.current = true
      closeRef.current()
    }
    window.addEventListener('popstate', pop)

    return () => {
      window.removeEventListener('popstate', pop)
      /* If the panel was closed by anything other than Back — a button, an
         Escape, a route change — the entry we pushed is still on the stack and
         would otherwise need two Backs to get past. Consuming it here means
         one Back always moves one step, whichever way the panel was shut.

         Not after a Back, which has already taken it. Guarded on our own
         marker as well, so this never eats an entry belonging to somebody
         else. */
      if (!byPop.current && window.history.state?.erpOverlay) window.history.back()
    }
  }, [open])

  return () => {
    if (window.history.state?.erpOverlay) window.history.back()
    else closeRef.current()
  }
}
