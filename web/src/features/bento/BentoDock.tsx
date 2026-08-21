import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLayout } from '@/lib/layout'
import { useT } from '@/lib/i18n'
import { useActiveRole, featurePath, usable } from '@/lib/catalog'
import { CommandSearch } from '@/components/CommandSearch'
import { BentoLauncher } from './BentoLauncher'
import { BentoSettings } from './BentoSettings'

/* Navigation and the way out, for a layout with no chrome.

   Hiding the sidebar and the header took the rail, the search and sign-out
   with them, and the command palette was mounted inside the header — so ⌘K
   died with it and Bento became a room with no doors. Everything the product
   can reach is reachable from the palette, so the fix is to mount it here
   rather than to rebuild a menu: one component, one source of truth for what
   a person may open, already scoped to their role.

   A dock, not a bar: it floats over the canvas rather than reserving a strip,
   so the grid still runs edge to edge underneath it. Centred at the top, which
   is where a person looks for a command bar.

   WHAT IS IN IT, AND WHAT IS NOT. The centre holds what somebody does several
   times an hour: find something, open their queue, open the library. It used
   to also hold Settings and "Leave Bento", which are neither — one is a
   preference you set once and the other is a statement about the product's
   internals that a user should never have to understand. Both moved to the
   account mark at the right of the screen, where the classic layout keeps the
   same things.

   The exit moved; it did not go. This layout hides the header, and the header
   is where sign-out and the role switch live, so a Bento with no door is the
   bug that was already fixed once. */
export function BentoDock() {
  const { layout } = useLayout()
  const t = useT()
  const navigate = useNavigate()
  const role = useActiveRole()
  const [all, setAll] = useState(false)

  /* Where "Work" goes, per role.

     There is no single queue key across the catalogue: faculty has
     home.my_work, an institution admin has approvals.approvals, and several
     roles have neither. So it is resolved against what this account can
     actually open, and the button is simply not drawn when there is nothing
     for it to open. A dock item that navigates nowhere is worse than one
     fewer dock item. */
  const workHref = useMemo(() => {
    if (!role) return undefined
    const wanted = ['my_work', 'approvals', 'needs_attention', 'follow_ups', 'today']
    for (const want of wanted) {
      for (const s of role.sections) {
        const f = s.features.find((x) => usable(x) && x.slug === want)
        if (f) return featurePath(role.key, s.slug, f.slug)
      }
    }
    return undefined
  }, [role])

  if (layout !== 'bento') return null

  const item =
    `rounded-full px-3 py-1.5 text-[12.5px] transition-colors hover:bg-accent ` +
    `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`

  return (
    <>
      <div
        className="fixed left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full
                   border bg-popover/80 p-1.5 pl-2.5 shadow-lg backdrop-blur-md"
      >
        {/* Brings its own ⌘K listener, so the shortcut works again as soon as
            this mounts — mouse and keyboard reach the same thing. */}
        <CommandSearch />

        {workHref && (
          <button type="button" onClick={() => navigate(workHref)} className={item}>
            {t('bento.dock.work')}
          </button>
        )}

        {/* Pointing, for the person who does not know what to type. */}
        <button type="button" onClick={() => setAll(true)} className={item}>
          {t('bento.dock.apps')}
        </button>
      </div>

      {/* The account, at the edge of the screen rather than in the middle of
          the bar. Its own fixed element, not a third region of the dock: the
          dock is a place you point at deliberately and this is a place you go
          when you already know what you want. */}
      <div className="fixed right-4 top-4 z-50">
        <BentoSettings />
      </div>

      {/* Outside the pill on purpose. backdrop-filter establishes a containing
          block, so a fixed-position child anchors to the blurred element instead
          of the viewport and the overlay opens inside the dock. */}
      <BentoLauncher open={all} onClose={() => setAll(false)} />
    </>
  )
}
