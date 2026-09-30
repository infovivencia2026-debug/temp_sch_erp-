import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'

/* EVERYTHING ARRIVES AND LEAVES THE SAME WAY.

   A React surface -- a menu, a sheet, a dialog, a record opened in place --
   is unmounted in the frame its state flips, so it vanished with no leaving
   at all while the next thing faded in. The owner asked that every
   transition, on every element, go naturally, the way it does on a phone.

   The View Transitions API is the one mechanism that can animate something
   that no longer exists: it snapshots the document, commits the change, and
   crosses the two snapshots on the compositor. index.css shapes the crossing
   (see the ::view-transition rules beside route-enter). App.tsx hands it
   every navigation; this hands it every open/close state in the product.

   `useOpenState` is `useState` with the setter routed through a view
   transition. Sixty-odd surfaces hold their visibility in a state called
   `open`; swapping their hook is what makes the rule global rather than a
   thing each screen remembers to do. flushSync inside the callback is what
   the API needs: the DOM must be in its new state when the callback returns.
   A setter called during render or an effect cannot flushSync; it falls back
   to a plain update, as do browsers without the API and people who asked for
   reduced motion. */
type VT = { ready?: Promise<unknown>; finished?: Promise<unknown>; updateCallbackDone?: Promise<unknown> }
type Doc = Document & { startViewTransition?: (cb: () => void) => VT | undefined }

export function transitioned(commit: () => void) {
  const doc = document as Doc
  if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    commit()
    return
  }
  const vt = doc.startViewTransition(() => {
    try {
      flushSync(commit)
    } catch {
      commit()
    }
  })
  // Overtaken by the next transition (a menu closing as a route changes),
  // these reject "Transition was skipped" as unhandled page errors; the
  // commit already ran, so the rejection is not an error.
  for (const pr of [vt?.ready, vt?.finished, vt?.updateCallbackDone]) pr?.catch(() => {})
}

export function useOpenState<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, set] = useState<T>(initial)
  /* Directly, not through a view transition. A pop-up has its own slide and
     fade; wrapping it in a whole-screen crossfade made the workspace blink on
     every open and close, and kept the sidebar bright above the dim layer
     until the crossfade finished. */
  const setOpen = useCallback<Dispatch<SetStateAction<T>>>((next) => set(next), [])
  return [value, setOpen]
}
