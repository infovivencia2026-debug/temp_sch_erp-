import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { useCatalog, usable } from '@/lib/catalog'
import { useTabs, neighbourOf, MAX_TABS } from '@/lib/tabs'
import { cn } from '@/lib/utils'

/* The tab strip. Desktop only — see lib/tabs.ts for why that is a decision
   rather than a breakpoint.

   It names the screen from the CATALOGUE rather than from the page, because a
   tab has to have its label before the screen it points at has loaded. Reading
   an <h1> would leave every freshly-opened tab briefly blank and then jump. */
export default function TabStrip() {
  const { pathname, search } = useLocation()
  const here = pathname + search
  const navigate = useNavigate()
  const catalog = useCatalog()
  const { tabs, open, close } = useTabs()

  /* The name this path has in the catalogue. Falls back to the last path
     segment made readable, so a screen outside the catalogue — /account, say —
     still gets a tab worth reading rather than a URL. */
  const titleFor = (path: string): string => {
    const [, roleKey, sectionSlug, featureSlug] = path.split('?')[0].split('/')
    for (const role of catalog.roles) {
      if (roleKey && role.key !== roleKey) continue
      for (const section of role.sections) {
        if (sectionSlug && section.slug !== sectionSlug) continue
        const f = section.features.find((x) => usable(x) && x.slug === featureSlug)
        if (f) return f.name
      }
    }
    const last = path.split('?')[0].split('/').filter(Boolean).pop() ?? 'Screen'
    return last.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }

  /* Every navigation opens or refreshes a tab. Doing it here rather than at
     each link means nothing has to remember to participate — including links
     inside screens, which is where most navigation in this product happens. */
  useEffect(() => {
    if (!catalog.roles.length) return
    /* Only real screens get a tab.
     *
     * "/" and "/go/…" both redirect, and "/institution_admin" is the role index
     * — it bounces to that role's first feature. Each of them opened a tab that
     * existed for one paint and then pointed at a page nobody can return to,
     * which is how a strip fills up with entries that do nothing when pressed.
     * A screen is role/section/feature: three segments. */
    const segments = here.split('?')[0].split('/').filter(Boolean)
    if (here.startsWith('/go/')) return
    if (segments.length !== 3 && here !== '/account') return
    open(here, titleFor(here), here)
  }, [here, catalog.roles.length])

  // One tab is not a tab strip; it is a line of chrome restating the title.
  if (tabs.length < 2) return null

  return (
    <div
      role="tablist"
      aria-label="Open screens"
      className="hidden shrink-0 items-stretch gap-1 overflow-x-auto border-b bg-card px-2 lg:flex"
    >
      {tabs.map((t) => {
        const active = t.path === here
        return (
          <div
            key={t.path}
            role="tab"
            aria-selected={active}
            className={cn(
              `group flex min-w-0 max-w-[220px] items-center gap-1.5 border-b-2 px-3 py-2
               text-[12.5px] transition-colors`,
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-accent',
            )}
          >
            <button
              type="button"
              onClick={() => navigate(t.path)}
              className="min-w-0 flex-1 truncate text-left focus-visible:outline-none"
              title={t.title}
            >
              {t.title}
            </button>
            <button
              type="button"
              aria-label={`Close ${t.title}`}
              onClick={() => {
                /* Work out where to go BEFORE closing, or the neighbour lookup
                   runs against a list this tab has already left. */
                const to = active ? neighbourOf(t.path) : null
                close(t.path)
                if (to) navigate(to)
              }}
              className="grid size-4 shrink-0 place-items-center rounded opacity-0 transition-opacity
                         hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>
        )
      })}
      {tabs.length >= MAX_TABS && (
        <span className="self-center pl-1 text-[11px] text-muted-foreground">
          {MAX_TABS} max
        </span>
      )}
    </div>
  )
}
