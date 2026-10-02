import { useRef, useState, useTransition, type ComponentType, type LazyExoticComponent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { segClass, SEG_BAR } from '@/components/ui'
import { cn } from '@/lib/utils'
import { SlidingIndicator } from '@/components/SlidingIndicator'

/* Several catalogue screens behind one menu entry.
 *
 * The parent menu used to carry one row per screen — Fees and Fee receipts,
 * Communication and Direct teacher messaging and Concerns — so a family scrolled
 * a long menu to find things that are one job. A hub keeps a single row and
 * lays the screens out as tabs above it. The screens themselves are unchanged:
 * each still draws its own PageHead, so a tab reads exactly as the page did,
 * and the student role's copies of the same screens are untouched.
 *
 * The chosen tab rides in the query string (?tab=receipts) so a link from a
 * notification or the dashboard can open the right one, and Back returns to
 * the previous tab rather than the previous screen.
 *
 * Plain buttons styled as a segmented control — same markup the attendance
 * hub uses — so it renders on the oldest browser we support. */

export interface ScreenTab {
  key: string
  label: string
  screen: ComponentType | LazyExoticComponent<ComponentType>
}

export default function ScreenTabs({ tabs, label }: { tabs: ScreenTab[]; label: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const fromUrl = new URLSearchParams(location.search).get('tab')
  const [fallback, setFallback] = useState(tabs[0].key)
  const active = tabs.find((t) => t.key === fromUrl)?.key ?? fallback
  const Active = (tabs.find((t) => t.key === active) ?? tabs[0]).screen

  /* A transition, so the tab's screen (a lazy chunk the first time) loads
     behind the one on show. Outside one, the chunk suspended to the page's
     own fallback and the whole page, tabs and all, blanked to a skeleton and
     came back: every tab press looked like a reload. */
  const [, startTransition] = useTransition()
  const listRef = useRef<HTMLDivElement>(null)
  const pick = (key: string) => {
    startTransition(() => {
      setFallback(key)
      const q = new URLSearchParams(location.search)
      q.set('tab', key)
      navigate({ search: `?${q}` }, { replace: false })
    })
  }

  return (
    <>
      {/* pb-3: on the bento layout --page-top is 0, so without it the strip
          sat flush on the page title beneath. */}
      <div className="flex justify-center px-[var(--page-gutter)] pb-3 pt-4">
        <div
          role="tablist"
          aria-label={label}
          ref={listRef}
          className={cn(SEG_BAR, 'relative')}
        >
          <SlidingIndicator listRef={listRef} active={active} className="rounded-sm bg-card shadow-sm" />
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active === t.key}
              onClick={() => pick(t.key)}
              className={
                active === t.key
                  ? cn(segClass(true), 'whitespace-nowrap')
                  : cn(segClass(false), 'whitespace-nowrap')
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {/* Keyed so the tab's screen starts fresh, and wrapped so the arrival
          settles in (index.css .tab-swap) rather than cutting. */}
      <div className="tab-swap" key={active}>
        <Active />
      </div>
    </>
  )
}
