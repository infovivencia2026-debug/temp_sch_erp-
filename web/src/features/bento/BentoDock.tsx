import { useLayout } from '@/lib/layout'
import { useT } from '@/lib/i18n'
import { useState } from 'react'
import { CommandSearch } from '@/components/CommandSearch'
import { BentoLauncher } from './BentoLauncher'

/* Navigation and the way out, for a layout with no chrome.

   Hiding the sidebar and the header took the rail, the search and sign-out
   with them, and the command palette was mounted inside the header — so ⌘K
   died with it and Bento became a room with no doors. Everything the product
   can reach is reachable from the palette, so the fix is to mount it here
   rather than to rebuild a menu: one component, one source of truth for what
   a person may open, already scoped to their role.

   A dock, not a bar. The instruction was no side or top bars, and the reading
   path of a grid starts top-left — so this sits bottom-right, where nothing is
   competing with it, and stays out of the way until wanted.

   This is the one place the contract permits blur: a transient floating
   element, over a canvas rather than over text, with a hairline border to
   carry the edge. */
export function BentoDock() {
  const { layout, setLayout } = useLayout()
  const t = useT()
  const [all, setAll] = useState(false)
  if (layout !== 'bento') return null
  return (
    <>
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5 rounded-full border
                    bg-popover/80 p-1.5 pl-2.5 shadow-lg backdrop-blur-md">
      {/* Brings its own ⌘K listener, so the shortcut works again as soon as
          this mounts — mouse and keyboard reach the same thing. */}
      <CommandSearch />
      {/* Pointing, for the person who does not know what to type. */}
      <button
        type="button"
        onClick={() => setAll(true)}
        className="rounded-full px-3 py-1.5 text-[12.5px] transition-colors hover:bg-accent
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('bento.dock.all')}
      </button>
      <button
        type="button"
        onClick={() => setLayout('classic')}
        className="rounded-full px-3 py-1.5 text-[12.5px] transition-colors hover:bg-accent
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('bento.escape.back')}
      </button>
    </div>
    {/* Outside the pill on purpose. backdrop-filter establishes a containing
        block, so a fixed-position child anchors to the blurred element instead
        of the viewport and the overlay opens inside the dock. */}
    <BentoLauncher open={all} onClose={() => setAll(false)} />
    </>
  )
}
