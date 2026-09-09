import { useSyncExternalStore } from 'react'

/* ---------------------------------------------------------------------------
   Subscribe to a media query.

   Used where a phone needs a different structure rather than a different
   arrangement of the same one — a CSS breakpoint can restyle a layout but it
   cannot replace a 1680px pan-and-zoom canvas with a list.
   --------------------------------------------------------------------------- */

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Below Tailwind's sm breakpoint. */
export const useIsPhone = () => useMediaQuery('(max-width: 639.98px)')
