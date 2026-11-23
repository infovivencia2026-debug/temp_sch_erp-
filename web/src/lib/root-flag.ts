import { useEffect } from 'react'

/* A FLAG ON <html>, INSTEAD OF `body:has(...)` / `:root:has(...)`.

   A :has() whose subject is the root has to be re-checked against the whole
   document on every DOM change, and when its answer can change, every element
   under it has its style recalculated. Measured on a 4x-throttled phone
   (2026-11-23): one navigation spent 1.7s in a single style recalc that went
   to 56ms with the seven root-level :has() rules removed. The same effect, as
   an attribute the component that causes it sets while it is mounted, costs
   nothing. Counted, so two owners of the same flag do not clear each other. */
const counts = new Map<string, number>()

export function useRootFlag(name: string, on = true) {
  useEffect(() => {
    if (!on || typeof document === 'undefined') return
    const el = document.documentElement
    counts.set(name, (counts.get(name) ?? 0) + 1)
    el.setAttribute(name, '')
    return () => {
      const n = (counts.get(name) ?? 1) - 1
      counts.set(name, n)
      if (n <= 0) el.removeAttribute(name)
    }
  }, [name, on])
}
