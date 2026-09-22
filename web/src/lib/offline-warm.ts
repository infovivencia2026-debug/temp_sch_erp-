import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import type { CatalogResponse } from '@/lib/catalog'
import { componentFor } from '@/features/registry'
import { preloadScreen } from '@/lib/screen'

/* WARM WHAT THIS PERSON WILL NEED, WHILE THE SIGNAL IS STILL THERE.

   Offline used to mean "whatever you happened to open earlier". A parent who
   had never tapped Fees got a white screen on the bus; a teacher's register
   from this morning was cached but the timetable beside it was not. Both
   caches — the worker's chunk cache and the query cache on disk — only ever
   filled as a side effect of a visit.

   So, once the menu is known and the phone is idle and online, two things are
   fetched ahead of any tap:

     the CHUNKS of every screen on this person's own menu — not the 5MB build,
     just the entries they can actually open — so the worker's cache-first
     branch has them before the first offline navigation;

     for a family, the DATA of the four screens they open most: the children,
     each child's attendance, fees and wallet. These are the same query keys
     the screens use, so the screen finds them already warm.

   Idle and online only, once per sign-in, and bounded: this is a courtesy to
   the next dead spot, not a download manager. On a slow line it simply stops
   where it got to and tries again next time. */

const idle = (fn: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 8000 })
  else setTimeout(fn, 2500)
}

const CHUNK_BUDGET = 60
let warmedFor: string | null = null

interface Child { student_id: string }

export function useOfflineWarm(catalog: CatalogResponse | undefined, userId: string | undefined) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!catalog || !userId) return
    if (warmedFor === userId) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    warmedFor = userId

    // Every live, in-scope screen on the menu, de-duplicated by component.
    const seen = new Set<object>()
    const toLoad: object[] = []
    let isParent = false
    for (const role of catalog.roles) {
      if (role.key === 'parent') isParent = true
      for (const section of role.sections) {
        for (const f of section.features) {
          if (!f.live || !f.in_scope) continue
          const comp = componentFor(f.key) as object | undefined
          if (!comp || seen.has(comp)) continue
          seen.add(comp)
          toLoad.push(comp)
        }
      }
    }

    idle(async () => {
      // Chunks: a few at a time, so the warm never competes with a real tap.
      const queue = toLoad.slice(0, CHUNK_BUDGET)
      while (queue.length && navigator.onLine !== false) {
        await Promise.all(queue.splice(0, 3).map((c) => preloadScreen(c)))
      }
      if (!isParent || navigator.onLine === false) return
      // Data: the family's four everyday screens, per child.
      try {
        const kids = await qc.fetchQuery({
          queryKey: ['portal-children'],
          queryFn: () => api.get<List<Child>>('/api/v1/portal/students'),
          staleTime: 5 * 60_000,
        })
        for (const k of (kids.items ?? []).slice(0, 4)) {
          const id = k.student_id
          await Promise.all([
            qc.prefetchQuery({
              queryKey: ['portal-attendance', id],
              queryFn: () => api.get(`/api/v1/portal/attendance?student_id=${id}`),
            }),
            qc.prefetchQuery({
              queryKey: ['portal-fees', id],
              queryFn: () => api.get(`/api/v1/portal/fees?student_id=${id}`),
            }),
            qc.prefetchQuery({
              queryKey: ['portal-wallet', id],
              queryFn: () => api.get(`/api/v1/fees/students/${id}/wallet`),
            }),
          ])
        }
      } catch {
        /* Offline mid-warm, or a screen this family cannot open: nothing to
           do, the next sign-in tries again. */
      }
    })
  }, [catalog, userId, qc])
}
