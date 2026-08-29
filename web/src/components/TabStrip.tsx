import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { useCatalog, screenTitle } from '@/lib/catalog'
import { useTabs, neighbourOf, MAX_TABS } from '@/lib/tabs'
import { usePanes, isHomeBoard, type Side } from '@/lib/panes'
import TabMenu, { type MenuTarget } from '@/components/TabMenu'
import { useLayout } from '@/lib/layout'
import { requestArrange } from '@/lib/widgets'
import { requestAppearance } from '@/lib/appearance-request'
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
  const { paths, split, closeSplit } = usePanes()
  const { layout } = useLayout()
  const [menu, setMenu] = useState<MenuTarget | null>(null)

  const titleFor = (path: string) => screenTitle(catalog, path)

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

  /* Splitting is offered from the strip, so it follows the strip's own rule
     about when there is enough going on to show one. Somebody with a single
     screen open has nothing to put beside it yet. */
  // One tab is not a tab strip; it is a line of chrome restating the title.
  if (tabs.length < 2) return null

  const doSplit = (side: Side, path: string) => {
    /* `here` seeds the other half of a first split: until this click there
       were no panes, so what is on screen has to be told to the store before
       anything can be put next to it. */
    if (split(side, path, here)) navigate(path)
  }

  return (
    <div
      role="tablist"
      aria-label="Open screens"
      className="hidden shrink-0 items-stretch gap-1 overflow-x-auto border-b bg-card px-2 lg:flex"
    >
      {tabs.map((t) => {
        const active = t.path === here
        // A tab showing in some other pane is open in front of somebody even
        // though the address bar is not on it, and a strip that greys it out
        // says the opposite of what the screen shows.
        const shown = active || paths.includes(t.path)
        return (
          <div
            key={t.path}
            role="tab"
            aria-selected={active}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ path: t.path, title: t.title, x: e.clientX, y: e.clientY })
            }}
            className={cn(
              /* THE STRIP SCROLLS; THE TABS DO NOT SHRINK.

                 The container is `overflow-x-auto`, which says the intent was
                 for a long row of tabs to scroll. It never did: a flex item
                 shrinks below its content by default, so with no floor here
                 the tabs divided the width between them instead — and because
                 each one truncates, eight open screens gave eight titles cut
                 to a few characters and a strip that never scrolled at all.
                 "Fee overview" and "Fee structure" both become "Fee…".

                 `shrink-0` with a floor is what makes the overflow real. 132px
                 is about eighteen characters at this size, which is enough to
                 tell two screens apart; past that the title truncates as it
                 always did, and past the strip's width the row scrolls, which
                 is what the container was always asking for. */
              `group flex min-w-[132px] max-w-[220px] shrink-0 items-center gap-1.5
               border-b-2 px-3 py-2 text-[12.5px] transition-colors`,
              shown
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-accent',
              active && 'font-medium',
              shown && !active && 'border-primary/40',
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
        /* shrink-0, or the strip squeezes it.

            It is the last flex item in a row of tabs that refuse to shrink, so
            it took the whole shortfall itself: two characters wide, with "8
            max" wrapped down the right-hand edge one letter per line. */
        <span className="shrink-0 self-center whitespace-nowrap pl-1 text-[11px] text-muted-foreground">
          {MAX_TABS} max
        </span>
      )}
      {menu && (
        <TabMenu
          target={menu}
          paneCount={Math.max(paths.length, 1)}
          /* A Home board in the Focus layout is the one tab whose menu is not
             about panes at all. In the classic layout Home is an ordinary page
             and splits like any other. */
          board={
            layout === 'bento' && isHomeBoard(menu.path)
              ? {
                  onAddWidget: () => {
                    // The board has to be the one on screen before anything can
                    // be added to it: the arranger reads whichever dashboard is
                    // currently published, not whichever tab was right-clicked.
                    if (menu.path !== here) navigate(menu.path)
                    requestAppearance('dashboard')
                    setMenu(null)
                  },
                  onEdit: () => {
                    if (menu.path !== here) navigate(menu.path)
                    // Parked rather than set: navigating unmounts the old
                    // board, and that unmount clears arrange mode. The next
                    // board to publish picks the intent up.
                    requestArrange()
                    setMenu(null)
                  },
                }
              : undefined
          }
          onSplit={(side) => { doSplit(side, menu.path); setMenu(null) }}
          onUnsplit={() => { closeSplit(); setMenu(null) }}
          onClose={() => {
            const to = menu.path === here ? neighbourOf(menu.path) : null
            close(menu.path)
            if (to) navigate(to)
            setMenu(null)
          }}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  )
}
