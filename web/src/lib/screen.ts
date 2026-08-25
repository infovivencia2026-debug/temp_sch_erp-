import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/* Every screen is a lazy import, and a lazy import is a network request.

   The failure that sent people to the error card was rarely a stale tab. It
   was one request that did not arrive: a phone changing cell on the way into
   school, a proxy dropping a connection, the wifi at the front desk. React
   caches the rejected promise, so that single blip is permanent for the life
   of the tab — the screen is dead until somebody reloads the whole page, and
   clicking the menu entry again just re-shows the same failure.

   That is the wrong shape of remedy for a transient fault. A person clicking
   "Homework" wants the screen, not a page reload that loses where they were;
   and the reload guard in ChunkBoundary only fires once, so a blip could
   spend the reload that a genuine deploy needed.

   So ask twice, with a short pause. The second attempt costs nothing when the
   first succeeded, catches the overwhelming majority of blips, and leaves the
   stale-deploy case to ChunkBoundary, where it belongs — a chunk that no
   longer exists on the server fails the same way twice, and falls through to
   the reload it actually needs. */

const RETRY_PAUSE_MS = 350

/** A lazily-loaded screen that survives one failed fetch of its chunk. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function screen<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    load().catch(
      (first: unknown) =>
        new Promise<{ default: T }>((resolve, reject) => {
          setTimeout(() => {
            // Rethrow the first error, not the second: the two are the same
            // fault, and the first is the one whose timing matches what the
            // person actually did.
            load().then(resolve, () => reject(first))
          }, RETRY_PAUSE_MS)
        }),
    ),
  )
}
