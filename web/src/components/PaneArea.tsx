import { useEffect, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { useCatalog, screenTitle } from '@/lib/catalog'
import { usePanes, setFocusedPath } from '@/lib/panes'
import { BentoOutlet } from '@/features/bento/BentoOutlet'
import { cn } from '@/lib/utils'

/* The work area, divided or not.

   Undivided it renders `children` — the application's own routed content,
   untouched, with no wrapper worth mentioning. That is the property this file
   is built around: a school that never right-clicks a tab must not be able to
   tell that panes exist. */
export default function PaneArea({
  children,
  renderAt,
}: {
  children: ReactNode
  /** Render the router at an arbitrary path. Supplied by App, which owns the
      route table; asking for it as a prop is what keeps the shell from having
      to import the routes and close the cycle. */
  renderAt: (path: string) => ReactNode
}) {
  const { pathname, search } = useLocation()
  const here = pathname + search
  const navigate = useNavigate()
  const catalog = useCatalog()
  const { paths, focus, dir, close, focusPane } = usePanes()

  /* Navigation moved the address bar, so it moved the pane the address bar
     speaks for. Everything that navigates — the sidebar, the palette, a link
     three levels inside a screen — arrives here, and none of it had to know
     that panes exist. */
  useEffect(() => {
    if (paths.length > 1 && paths[focus] !== here) {
      setFocusedPath(here)
    }
  }, [here, paths, focus])

  if (paths.length < 2) return <>{children}</>

  return (
    <div
      className={cn(
        'grid h-full min-h-0 gap-px bg-border',
        paths.length === 2 && dir === 'row' && 'grid-cols-2',
        paths.length === 2 && dir === 'col' && 'grid-rows-2',
        // Three panes in a row are each too narrow for a register, so three
        // and four are the same 2×2 board; three simply leaves a cell empty.
        paths.length > 2 && 'grid-cols-2 grid-rows-2',
      )}
    >
      {paths.map((path, i) => (
        <section
          key={`${path}-${i}`}
          data-pane=""
          onMouseDownCapture={() => {
            /* Focus on the way DOWN, before the click lands. A click inside a
               pane is usually a click on something — a row, a button — and
               that something is about to navigate. If focus moved afterwards
               the navigation would still be attributed to the pane that was
               focused before, and the wrong half of the screen would change. */
            if (i !== focus) {
              focusPane(i)
              navigate(path)
            }
          }}
          className={cn(
            'relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background',
            'transition-[box-shadow]',
            // The focused pane is named by the address bar, and which one that
            // is has to be visible: a keystroke that navigates has to land
            // somewhere predictable. An inset line rather than a border, so
            // nothing reflows when focus moves.
            i === focus ? 'shadow-[inset_0_2px_0_0_hsl(var(--primary))]' : 'opacity-[0.97]',
          )}
        >
          <header className="flex shrink-0 items-center gap-2 border-b bg-card px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted-foreground">
              {screenTitle(catalog, path)}
            </span>
            <button
              type="button"
              aria-label={`Close this pane`}
              onClick={(e) => {
                e.stopPropagation()
                const wasFocused = i === focus
                close(i)
                // Closing what the address bar was describing leaves it
                // describing a pane that is gone. Hand it the neighbour that
                // took its place.
                if (wasFocused) navigate(paths[i + 1] ?? paths[i - 1] ?? here)
              }}
              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground
                         transition-colors
                         hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </header>
          {/* Each pane scrolls itself. The shell's single scroller is what
              made a split impossible before: one bar for two registers moved
              both and reached the bottom of neither. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <BentoOutlet path={path}>{renderAt(path)}</BentoOutlet>
          </div>
        </section>
      ))}
    </div>
  )
}
