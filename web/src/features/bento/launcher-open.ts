/* A way to ask for the launcher from outside the dock that owns it.

   `all` lives in BentoDock, because the dock is what renders BentoLauncher and
   the button that opens it. The swipe lives on the board, which is neither a
   parent nor a child of the dock -- they are siblings under the shell -- so
   there is no prop to pass and lifting the state would mean threading it
   through the whole layout to serve one gesture.

   A one-line emitter instead. Deliberately not a context: a context re-renders
   every consumer under it when this changes, and what is being expressed is an
   event that happened once, not a value anybody needs to read. */

type Listener = () => void
const listeners = new Set<Listener>()

export function openLauncher() {
  listeners.forEach((fn) => fn())
}

export function onOpenLauncher(fn: Listener) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
