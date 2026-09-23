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
type Doc = Document & { startViewTransition?: (cb: () => void) => unknown }

export function transitioned(commit: () => void) {
  const doc = document as Doc
  if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    commit()
    return
  }
  doc.startViewTransition(() => {
    try {
      flushSync(commit)
    } catch {
      commit()
    }
  })
}

export function useOpenState<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, set] = useState<T>(initial)
  const setOpen = useCallback<Dispatch<SetStateAction<T>>>((next) => transitioned(() => set(next)), [])
  return [value, setOpen]
}
