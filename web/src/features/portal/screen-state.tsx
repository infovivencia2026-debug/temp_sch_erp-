import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { servedFromCache } from '@/lib/api'
import { useDelayed } from '@/components/Skeleton'
import { useT } from '@/lib/i18n'

/* WHAT A PARENT SCREEN SAYS WHILE IT IS NOT SURE.

   Two pieces, both small, both used by nearly every screen in this folder.

   `Freshness` is the line under the title that replaces the spinner. With
   lib/query-persist.ts putting the last answer back before the screen
   mounts, a screen is nearly never without data; what it is without, for a
   second or two, is CERTAINTY that the data is today's. A spinner answers
   that with a blank page, which is the wrong trade for a fee balance that has
   not changed since Tuesday. A line saying "Updating…" and then "Updated just
   now" keeps the page and says the same thing.

   It is quiet on purpose. Thirteen pixels, muted, one line, no icon unless
   something is actually wrong. A parent should be able to not read it, and
   should be able to find it when the bus has not moved for a minute and they
   want to know whether that is the bus or the phone.

   Three states beyond the ordinary one. "Updating" while a fetch is in
   flight. "No connection" when the answer on screen is the worker's cached
   copy (see servedFromCache in lib/api.ts) -- the network was unreachable
   when the screen asked. "Could not refresh" when the fetch failed outright
   while an older answer was already on screen; the screens keep the older
   answer rather than replacing it with a red card, because the answer is
   still the best thing they have, and the line says why it may be behind.
   The last two carry a retry, because a phone that just came out of a lift
   should not need the app reopened.

   `ScreenSkeleton` is the shape of a parent screen for a true first visit,
   when there is nothing stored to paint: the title bar where the title will
   be and a grouped list where the list will be. It waits the same 220ms every
   skeleton in components/Skeleton.tsx waits, so a fast first answer simply
   arrives. */

interface Freshable {
  data: unknown
  dataUpdatedAt: number
  isFetching: boolean
  isError: boolean
  refetch: () => unknown
}

/** Re-renders every ten seconds so "2 min ago" keeps up; cheap, one timer. */
function useTick() {
  const [, setNow] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 10_000)
    return () => clearInterval(t)
  }, [])
}

function useAgo(at: number): string {
  const t = useT()
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 45) return t('portal.fresh.just_now')
  if (s < 90) return t('portal.fresh.seconds', { n: s })
  const m = Math.round(s / 60)
  if (m < 60) return t('portal.fresh.minutes', { n: m })
  const h = Math.round(m / 60)
  if (h < 36) return t('portal.fresh.hours', { n: h })
  return t('portal.fresh.days', { n: Math.round(h / 24) })
}

export function Freshness({ query }: { query: Freshable }) {
  const t = useT()
  useTick()
  const ago = useAgo(query.dataUpdatedAt)
  if (!query.data) return null

  const offline = servedFromCache(query.data)
  const failed = query.isError && !query.isFetching
  /* "Updated just now" is the ordinary state, and it should not need reading
     more than once; the sentence only changes when the age passes 45s, which
     is `ago` no longer being the just-now string. */
  const agoOnly = ago === t('portal.fresh.just_now') ? ago : t('portal.fresh.ago', { ago })

  let text: string
  if (query.isFetching) text = t('portal.fresh.updating')
  else if (offline) text = t('portal.fresh.offline', { ago: ago.toLowerCase() })
  else if (failed) text = t('portal.fresh.failed', { ago: ago.toLowerCase() })
  else text = agoOnly

  const trouble = !query.isFetching && (offline || failed)
  return (
    <p
      className="parent-fresh"
      data-state={query.isFetching ? 'updating' : trouble ? 'trouble' : 'fresh'}
      role="status"
      aria-live="polite"
    >
      <span className="parent-fresh__text">{text}</span>
      {trouble && (
        <button type="button" className="parent-fresh__retry" onClick={() => void query.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t('portal.fresh.retry')}
        </button>
      )}
    </p>
  )
}

/**
 * A parent screen that has not arrived yet, in the geometry of one that has:
 * the title line at the top, then a card of list rows.
 *
 * Not the SkeletonPage from components/Skeleton.tsx, whose header is the
 * breadcrumb-plus-title line of a staff screen. The parent stylesheet takes
 * the breadcrumb away and sets the title at 22px, so the stand-in has to be
 * that shape or the title lands 12px away from where the bar was.
 */
export function ScreenSkeleton({ rows = 5, delay, label }: { rows?: number; delay?: number; label?: string }) {
  const show = useDelayed(true, delay)
  if (!show) return null
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {label ?? 'Loading…'}
      </p>
      <div className="parent-skeleton" aria-hidden>
        <div className="parent-skeleton__head">
          <div className="parent-skeleton__bar parent-skeleton__title" />
        </div>
        <div className="parent-skeleton__card">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="parent-skeleton__row" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="parent-skeleton__bar" style={{ width: `${62 - (i % 3) * 12}%` }} />
              <div className="parent-skeleton__bar parent-skeleton__sub" style={{ width: `${38 - (i % 2) * 8}%` }} />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
