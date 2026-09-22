import { useState, type ComponentType, type LazyExoticComponent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

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

  const pick = (key: string) => {
    setFallback(key)
    const q = new URLSearchParams(location.search)
    q.set('tab', key)
    navigate({ search: `?${q}` }, { replace: false })
  }

  return (
    <>
      <div className="flex justify-center px-2 pt-4 sm:px-7">
        <div
          role="tablist"
          aria-label={label}
          className="inline-flex max-w-full gap-1 overflow-x-auto rounded-md border bg-muted p-1"
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active === t.key}
              onClick={() => pick(t.key)}
              className={
                active === t.key
                  ? 'whitespace-nowrap rounded-sm bg-card px-3 py-1 text-[13px] font-medium text-foreground shadow-sm [@media(pointer:coarse)]:py-2.5'
                  : 'whitespace-nowrap rounded-sm px-3 py-1 text-[13px] text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:py-2.5'
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <Active key={active} />
    </>
  )
}
