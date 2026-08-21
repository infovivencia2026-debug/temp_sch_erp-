import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, Inbox, House } from 'lucide-react'
import { useLayout } from '@/lib/layout'
import { useT } from '@/lib/i18n'
import { useActiveRole, featurePath, usable } from '@/lib/catalog'
import { CommandSearch } from '@/components/CommandSearch'
import { BentoLauncher, markFor, hueFor } from './BentoLauncher'
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

  /* Home, always, and first.

     Every other item in the dock is conditional on something — Work on the
     role having a queue, the account on being signed in — and the one thing a
     person needs from any screen is the way back to the start. It resolves to
     whatever this role's first opening feature is rather than a fixed path,
     because "home" is a different screen for a principal, a parent and a
     student, and there is no route the three share. */
  const homeHref = useMemo(() => {
    if (!role) return undefined
    for (const s of role.sections) {
      const f = s.features.find(usable)
      if (f) return featurePath(role.key, s.slug, f.slug)
    }
    return undefined
  }, [role])

  /* Every workspace this role holds, in the order the catalogue files them.

     Each takes its domain's colour, so the bar is the same colour system as
     the launcher and the cards rather than a third vocabulary. The glyph is
     coloured and the word is not: nine coloured labels in a row is a bar you
     squint at, and the mark is what the eye is learning anyway.

     Resolved to the first feature of the workspace that actually opens, so a
     category with nothing reachable in it is simply absent rather than a
     button that lands on "not in your workspace". */
  const categories = useMemo(() => {
    if (!role) return []
    const out: { name: string; href: string }[] = []
    for (const s of role.sections) {
      const name = s.workspace || s.name
      if (out.some((x) => x.name === name)) continue
      const f = s.features.find(usable)
      if (f) out.push({ name, href: featurePath(role.key, s.slug, f.slug) })
    }
    return out
  }, [role])

  if (layout !== 'bento') return null

  /* Icon and word together, not one or the other.

     The glyph is what the eye finds after a week and the word is what makes it
     findable in the first one; a bar of bare icons is a bar you learn by
     hovering. "All features" rather than "Apps" because that is what the panel
     is called when it opens, and a control whose label changes on the way to
     the thing it opens is a control people stop trusting. */
  const item =
    `flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors ` +
    `hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`

  return (
    <>
      <div
        className="bento-dock fixed left-1/2 top-4 z-50 flex max-w-[calc(100vw-6rem)]
                   -translate-x-1/2 items-center gap-1.5 rounded-full border bg-popover/90
                   p-1.5 pl-2.5 backdrop-blur-md"
      >
        {homeHref && (
          <button type="button" onClick={() => navigate(homeHref)} className={item}>
            <House className="size-3.5 shrink-0" aria-hidden="true" />
            {t('bento.dock.home')}
          </button>
        )}

        {/* Brings its own ⌘K listener, so the shortcut works again as soon as
            this mounts — mouse and keyboard reach the same thing. */}
        <CommandSearch />

        {workHref && (
          <button type="button" onClick={() => navigate(workHref)} className={item}>
            <Inbox className="size-3.5 shrink-0" aria-hidden="true" />
            {t('bento.dock.work')}
          </button>
        )}

        {categories.length > 0 && (
          <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
        )}

        {/* The categories scroll rather than wrap. The dock is one line by
            definition — it floats over the canvas — so a second row would sit
            on the content it is supposed to hover above. On a wide screen they
            all fit; on a narrow one they slide. */}
        <span className="flex min-w-0 items-center gap-0.5 overflow-x-auto
                         [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {categories.map((c) => {
            const Mark = markFor(c.name)
            return (
              <button
                key={c.name}
                type="button"
                onClick={() => navigate(c.href)}
                title={c.name}
                className={item + ' shrink-0'}
              >
                <Mark
                  className="size-3.5 shrink-0"
                  style={{ color: `var(--dom-${hueFor(c.name)})` }}
                  aria-hidden="true"
                />
                {c.name}
              </button>
            )
          })}
        </span>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* Pointing, for the person who does not know what to type. */}
        <button type="button" onClick={() => setAll(true)} className={item + ' shrink-0'}>
          <LayoutGrid className="size-3.5 shrink-0" aria-hidden="true" />
          {t('bento.launcher.title')}
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
