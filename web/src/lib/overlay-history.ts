import { useEffect } from 'react'

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
  useEffect(() => {
    if (!open) return

    window.history.pushState({ erpOverlay: true }, '')

    const pop = () => onClose()
    window.addEventListener('popstate', pop)

    return () => {
      window.removeEventListener('popstate', pop)
      /* If the panel was closed by anything other than Back — a button, an
         Escape, a route change — the entry we pushed is still on the stack and
         would otherwise need two Backs to get past. Consuming it here means
         one Back always moves one step, whichever way the panel was shut.

         Guarded on our own marker so this never eats an entry belonging to
         somebody else. */
      if (window.history.state?.erpOverlay) window.history.back()
    }
  }, [open, onClose])

  return () => {
    if (window.history.state?.erpOverlay) window.history.back()
    else onClose()
  }
}
