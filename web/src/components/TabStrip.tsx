import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Columns2, PanelBottom, PanelLeft, PanelRight, PanelTop, Pencil, Plus, SlidersHorizontal, X,
} from 'lucide-react'
import { useCatalog, screenTitle } from '@/lib/catalog'
import { useTabs, neighbourOf, MAX_TABS } from '@/lib/tabs'
import { usePanes, isHomeBoard, MAX_PANES, type Side } from '@/lib/panes'
import { Menu } from '@/features/bento/Menu'
import { useLayout } from '@/lib/layout'
import { useT } from '@/lib/i18n'
import { requestArrange } from '@/lib/widgets'
import { requestAppearance } from '@/lib/appearance-request'
import { cn } from '@/lib/utils'
import '@/features/bento/dock-menus.css'

/* The tab strip. Desktop only — see lib/tabs.ts for why that is a decision
   rather than a breakpoint.

   It names the screen from the CATALOGUE rather than from the page, because a
   tab has to have its label before the screen it points at has loaded. Reading
   an <h1> would leave every freshly-opened tab briefly blank and then jump. */

/* What a right-click on a tab opens. The anchor is the tab button itself:
   the popover hangs under it, and focus goes back to it on close. */
interface MenuTarget {
  path: string
  title: string
  anchor: HTMLElement
}

const SIDES: { side: Side; key: 'tabs.menu.right' | 'tabs.menu.left' | 'tabs.menu.up' | 'tabs.menu.down'; icon: typeof PanelRight }[] = [
  { side: 'right', key: 'tabs.menu.right', icon: PanelRight },
  { side: 'left', key: 'tabs.menu.left', icon: PanelLeft },
  { side: 'up', key: 'tabs.menu.up', icon: PanelTop },
  { side: 'down', key: 'tabs.menu.down', icon: PanelBottom },
]

export default function TabStrip() {
  const { pathname, search } = useLocation()
  const here = pathname + search
  const navigate = useNavigate()
  const catalog = useCatalog()
  const t = useT()
  const { tabs, open, close } = useTabs()
  const { paths, split, closeSplit } = usePanes()
  const { layout } = useLayout()
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)
  /* Referentially stable: the popover's document listeners depend on it. */
  const dismiss = useCallback(() => setMenu(null), [])

  /* KEEP THE TAB YOU ARE ON IN SIGHT.
   *
   * The strip scrolls once the tabs stop fitting, and nothing was scrolling it.
   * Measured at 1024px with eight screens open: the strip is 1024 wide, its
   * content 1198, scrollLeft stays 0, and the tab for the screen actually on
   * display sits at 1001..1122, so opening a seventh or eighth screen left its
   * own tab past the right edge reading "Adm" instead of "Admissions Pipeline".
   * That is the "text overflowing" complaint: the title is not too wide for its
   * tab, the tab is outside the visible strip.
   *
   * `nearest` on both axes, because `center` would also scroll the page body
   * to drag the strip into the middle of the window. */
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [here, tabs.length])

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
    const key = here.split('?')[0]
    const segments = key.split('/').filter(Boolean)
    if (here.startsWith('/go/')) return
    if (segments.length !== 3 && key !== '/account') return
    /* The tab is the screen, not the screen plus whatever was in its query
       string. Keyed on the full URL, the parent's home opened a second
       "Dashboard" tab every time the child switcher changed ?child=, and a
       list opened one per filter. One screen, one tab.

       The home board gets no tab at all: it is one press away on the dock
       from everywhere, so a tab for it is a line of chrome that only ever
       restates where the dock already points. */
    if (isHomeBoard(key)) return
    open(key, titleFor(key), key)
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

  /* THE MENU BEHIND A RIGHT-CLICK, on the same popover every menu on the
     board uses (features/bento/Menu.tsx): it hangs under the tab, walks with
     the arrow keys, catches its own Escape and hands focus back to the tab.

     It offers the same four directions whether or not the work area is
     already split, because "split this off to the right" and "add another
     one to the right" are the same intention and a menu that renames itself
     between them makes somebody read it twice. What changes with a split is
     what else is there: a way back to one pane, and — once four are open —
     four directions that say plainly they are full rather than doing nothing
     when pressed.

     A Home board in the Focus layout is the one tab whose menu is not about
     panes at all. Showing it four disabled directions was the first attempt
     and it was wrong: a dashboard is not short of things somebody might want
     from it — it is the one screen in the product meant to be rearranged —
     so the space goes to that instead. In the classic layout Home is an
     ordinary page and splits like any other. */
  const board = menu !== null && layout === 'bento' && isHomeBoard(menu.path)
  const paneCount = Math.max(paths.length, 1)
  const full = paneCount >= MAX_PANES

  /* The board has to be the one on screen before anything can be done to it:
     the arranger reads whichever dashboard is currently published, not
     whichever tab was right-clicked. */
  const onBoard = (then: () => void) => {
    if (!menu) return
    if (menu.path !== here) navigate(menu.path)
    then()
    dismiss()
  }
  /* Parked rather than set: navigating unmounts the old board, and that
     unmount clears arrange mode. The next board to publish picks it up.

     "Add card…" goes to the same place. The mode's bar holds Add, and the
     gallery it opens is state private to WidgetLayer with no request hook,
     so the nearest this row can land is the bar with Add on it. */
  const customize = () => onBoard(requestArrange)

  return (
    <div
      role="tablist"
      aria-label="Open screens"
      /* A wheel over a horizontal-only scroller does nothing on a mouse: the
         browser sends deltaY, and there is no vertical axis here to spend it
         on. The overflow is also drawn with an overlay scrollbar (measured: 1px
         of gutter), so nothing on screen invites a drag either. Spending deltaY
         on the horizontal axis is what makes the far tabs reachable without a
         trackpad. */
      onWheel={(e) => {
        if (e.deltaY === 0) return
        const el = e.currentTarget
        if (el.scrollWidth <= el.clientWidth) return
        el.scrollLeft += e.deltaY
      }}
      className="hidden shrink-0 items-stretch gap-1 overflow-x-auto border-b bg-card px-2 lg:flex"
    >
      {tabs.map((t) => {
        const active = t.path === here
        // A tab showing in some other pane is open in front of somebody even
        // though the address bar is not on it, and a strip that greys it out
        // says the opposite of what the screen shows.
        const shown = active || paths.includes(t.path)
        /* A PLAIN DIV BELOW, not the tab itself.

           role="tab" was on that wrapper, which contains a navigate button AND
           a close button. Two problems from one line: the ARIA is wrong -- a
           tab is the control, not a box holding two of them -- and index.css
           gives everything with that role a button's press feedback, so the
           entire tab, close button and all, shrank under a click like one
           large button.

           The role moves to the button that actually is the tab. The wrapper
           goes back to being a box, and only the thing you pressed responds to
           being pressed. */
        return (
          <div
            key={t.path}
            ref={active ? activeRef : undefined}
            onContextMenu={(e) => {
              e.preventDefault()
              // Anchored on the tab button, not the box: the popover hangs
              // under the tab, and the tab is the focusable thing focus can
              // return to when the menu closes.
              const anchor = e.currentTarget.querySelector<HTMLElement>('[role="tab"]') ?? e.currentTarget
              setMenu({ path: t.path, title: t.title, anchor })
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
              role="tab"
              aria-selected={active}
              onClick={() => navigate(t.path)}
              /* No `outline-none` here. It used to sit on this line and put
                 nothing back, so the one global focus ring in index.css was
                 cancelled and keyboard focus on a tab was invisible (measured:
                 outline colour rgba(0,0,0,0)). The offset is pulled inside the
                 tab instead of outside it, because the ring on the first or
                 last tab would otherwise be drawn in the strip's overflow and
                 clipped away. */
              className="min-w-0 flex-1 truncate rounded-sm text-left
                         focus-visible:[outline-offset:-2px]"
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
              /* size-4 measured 14px square, well under any pointer target,
                 and it stayed invisible until the row was hovered, so closing
                 the tab you are looking at began with aiming at nothing. The
                 box measures 21px now, and the current tab's close control is
                 always drawn. */
              className={cn(
                `grid size-6 shrink-0 place-items-center rounded transition-opacity
                 hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100`,
                active ? 'opacity-70' : 'opacity-0',
              )}
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
      <Menu open={menu !== null} anchor={menu?.anchor ?? null} label={menu?.title ?? ''} onClose={dismiss} width={232}>
        {menu && (
          <>
            <div className="bento-menu__title">{menu.title}</div>
            {board ? (
              <>
                <Row icon={Plus} label={t('bento.menu.add_card')} onSelect={customize} />
                <Row icon={Pencil} label={t('bento.menu.customize')} onSelect={customize} />
                <Row
                  icon={SlidersHorizontal}
                  label={t('bento.menu.board_settings')}
                  onSelect={() => onBoard(() => requestAppearance('dashboard'))}
                />
              </>
            ) : (
              SIDES.map(({ side, key, icon }) => (
                <Row
                  key={side}
                  icon={icon}
                  label={t(key)}
                  hint={full ? t('tabs.menu.max', { n: MAX_PANES }) : undefined}
                  disabled={full}
                  onSelect={() => { doSplit(side, menu.path); dismiss() }}
                />
              ))
            )}
            <div className="bento-menu__rule" role="separator" />
            {paneCount > 1 && (
              <Row icon={Columns2} label={t('tabs.menu.unsplit')} onSelect={() => { closeSplit(); dismiss() }} />
            )}
            <Row
              icon={X}
              label={t('tabs.menu.close')}
              onSelect={() => {
                const to = menu.path === here ? neighbourOf(menu.path) : null
                close(menu.path)
                if (to) navigate(to)
                dismiss()
              }}
            />
          </>
        )}
      </Menu>
    </div>
  )
}

/* One row of the menu, in the popover's own vocabulary: `bento-menu__item`
   is what the arrow keys walk and what the stylesheet paints; a disabled
   row is skipped by the keys and does not light under a pointer. */
function Row({
  icon: Icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon: typeof PanelRight
  label: string
  hint?: string
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="bento-menu__item"
    >
      <Icon aria-hidden="true" />
      <span className="bento-menu__label">{label}</span>
      {hint && <span className="bento-menu__hint">{hint}</span>}
    </button>
  )
}
