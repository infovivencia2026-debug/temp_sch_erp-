/* A way to ask for the launcher from outside the dock that owns it.

   `all` lives in BentoDock, because the dock is what renders BentoLauncher and
   the button that opens it. The swipe lives on the board, which is neither a
   parent nor a child of the dock -- they are siblings under the shell -- so
   there is no prop to pass and lifting the state would mean threading it
   through the whole layout to serve one gesture.

   A one-line emitter instead. Deliberately not a context: a context re-renders
   every consumer under it when this changes, and what is being expressed is an
   event that happened once, not a value anybody needs to read. */

/* THE DRAWER COMES WITH THE FINGER.

   The first version of this fired once, at 64px of travel, and the launcher
   appeared. That is a switch, and a phone's app drawer is not a switch: it
   is a sheet that is already moving under the thumb before anybody has
   decided to open it, and settles one way or the other on release. So the
   gesture now reports where it is, and the drawer draws itself there. */
export type LauncherSignal =
  | { kind: 'drag'; progress: number }
  | { kind: 'open' }
  | { kind: 'cancel' }

type Listener = (s: LauncherSignal) => void
const listeners = new Set<Listener>()

function emit(s: LauncherSignal) {
  listeners.forEach((fn) => fn(s))
}

export function openLauncher() {
  emit({ kind: 'open' })
}

/** 0 is closed, 1 is fully up. Sent on every move of a live upward drag. */
export function dragLauncher(progress: number) {
  emit({ kind: 'drag', progress: Math.max(0, Math.min(1, progress)) })
}

/** The finger let go short of the mark, or the drag stopped being a swipe up. */
export function cancelLauncher() {
  emit({ kind: 'cancel' })
}

export function onOpenLauncher(fn: Listener) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
