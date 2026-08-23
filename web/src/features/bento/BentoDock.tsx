import { useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { LayoutGrid, Inbox, House } from 'lucide-react'
import { useLayout } from '@/lib/layout'
import { useT } from '@/lib/i18n'
import { useActiveRole, featurePath, usable } from '@/lib/catalog'
import { CommandSearch } from '@/components/CommandSearch'
import { BentoLauncher, markFor, hueFor } from './BentoLauncher'
import { BentoSettings } from './BentoSettings'
import { useAppearance } from '@/lib/appearance'
import { useBoard } from '@/lib/widgets'

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
  const location = useLocation()
  const role = useActiveRole()
  const { appearance } = useAppearance()
  const { arranging } = useBoard()
  const hidden = useMemo(
    () => new Set((appearance.hiddenDockItems ?? '').split(',').map(s => s.trim()).filter(Boolean)),
    [appearance.hiddenDockItems],
  )
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
    /* Seen is tracked apart from the output, and that is the fix rather than a
       tidy-up.

       A workspace spans several sections — an institution admin's Home holds
       Home, Getting Started and Approvals — so the loop meets the same
       workspace three times. When the first of those was skipped for being the
       home destination, it was skipped *before* being recorded, so the second
       section found nothing in the output, decided Home had not been added
       yet, and added it again pointing at School setup. Two house icons, the
       second going somewhere else.

       Deciding "have I dealt with this workspace" from the list of things kept
       only works if nothing is ever dropped. */
    const seen = new Set<string>()
    for (const s of role.sections) {
      const name = s.workspace || s.name
      if (seen.has(name)) continue
      const f = s.features.find(usable)
      if (!f) continue
      seen.add(name)
      /* The home workspace itself is dropped: the button before this list is
         already it. Matched on the destination rather than on the name "Home",
         because several roles call that workspace something else and one that
         called it Dashboard would keep the duplicate. */
      const href = featurePath(role.key, s.slug, f.slug)
      if (href === homeHref) continue
      out.push({ name, href })
    }
    return out
  }, [role, homeHref])

  if (layout !== 'bento') return null

  /* Out of the way while the board is being arranged.

     The dock floats over the canvas rather than reserving a strip, which is
     right when you are reading a dashboard and wrong when you are editing one:
     it covers the bottom row of cards, and those cards have controls on them
     now. Hiding it also removes a whole class of confusion — nothing in the
     dock does anything useful mid-arrange, and a visible control that quietly
     does nothing is worse than an absent one.

     Nothing is stranded by this. Done sits at the top of the board, and Escape
     is not the only way out. */
  if (arranging) return null

  /* Icon and word together, not one or the other.

     The glyph is what the eye finds after a week and the word is what makes it
     findable in the first one; a bar of bare icons is a bar you learn by
     hovering. "All features" rather than "Apps" because that is what the panel
     is called when it opens, and a control whose label changes on the way to
     the thing it opens is a control people stop trusting. */
  /* Icons only, named on hover and to assistive technology.

     Thirteen labelled items — Home, Work, nine categories, All features and
     the search — is a paragraph across the top of the screen, and a dock that
     wide stops floating over the canvas and starts dividing it. The marks are
     what the hand learns anyway; the words were only ever teaching them.

     Every one keeps a title for the pointer and an aria-label for a screen
     reader, so nothing is lost that was not visual. A bar of unlabelled glyphs
     with no way to find out what they are would be a puzzle, not a dock. */
  const item =
    `grid shrink-0 place-items-center rounded-full transition-colors ` +
    `hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`
  const btnStyle = { width: 'var(--dock-btn, 40px)', height: 'var(--dock-btn, 40px)' }

  return (
    <>
      <div
        className="bento-dock fixed left-1/2 bottom-6 z-50 flex max-w-[calc(100vw-6rem)]
                   -translate-x-1/2 items-center gap-2 rounded-[14px] border-none
                   bg-[var(--bento-dock-bg,var(--bento-card))]
                   text-[var(--bento-dock-ink,var(--bento-ink))] shadow-2xl"
        style={{ padding: 'var(--dock-pad, 8px)', paddingLeft: 'calc(var(--dock-pad, 8px) + 4px)' }}
      >
        {homeHref && (
          <button
            type="button"
            onClick={() => {
              if (location.pathname === homeHref) {
                window.location.reload()
              } else {
                navigate(homeHref)
              }
            }}
            className={item}
            data-tip={t('bento.dock.home')}
            aria-label={t('bento.dock.home')}
          >
            <House className="size-[17px]" aria-hidden="true" />
          </button>
        )}

        {/* Brings its own ⌘K listener, so the shortcut works again as soon as
            this mounts — mouse and keyboard reach the same thing. */}
        <CommandSearch />

        {workHref && (
          <button
            type="button"
            onClick={() => navigate(workHref)}
            className={item}
            data-tip={t('bento.dock.work')}
            aria-label={t('bento.dock.work')}
          >
            <Inbox className="size-[17px]" aria-hidden="true" />
          </button>
        )}

        {categories.length > 0 && (
          <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
        )}

        {/* The categories scroll rather than wrap. The dock is one line by
            definition — it floats over the canvas — so a second row would sit
            on the content it is supposed to hover above. On a wide screen they
            all fit; on a narrow one they slide. */}
        {/* No scroller here, and that is the point.

            overflow-x-auto clips in both axes — the y overflow computes to
            auto the moment x does — so every category's tooltip was drawn
            below its button, outside this box, and thrown away. Home and Work
            sat outside the wrapper and showed theirs, which is why it looked
            like the tooltips half worked.

            Nothing is lost by removing it. With labels gone each item is 36px,
            so nine categories and the three fixed items come to about 430px:
            the bar fits on any screen wide enough to be running the desktop
            layout at all. */}
        <span className="flex items-center gap-0.5">
          {categories.filter(c => !hidden.has(c.name)).map((c) => {
            const Mark = markFor(c.name)
            return (
              <button
                key={c.name}
                type="button"
                onClick={() => navigate(c.href)}
                data-tip={c.name}
                aria-label={c.name}
                className={item}
                style={btnStyle}
              >
                <Mark
                  style={{
                    width: 'var(--dock-icon, 17px)',
                    height: 'var(--dock-icon, 17px)',
                    opacity: 0.6,
                    color: `var(--dom-${hueFor(c.name)})`,
                  }}
                  aria-hidden="true"
                />
              </button>
            )
          })}
        </span>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* Pointing, for the person who does not know what to type. */}
        {/* The one that keeps its words.

            Everything else in the bar is a place — a category, a queue, home —
            and a place is learnable as a mark. This is the door onto all of
            them, so it is the one item somebody looks for by name when the
            marks have not been learnt yet. It also sits at the end, where a
            wider target costs nothing. */}
        <button
          type="button"
          onClick={() => setAll(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px]
                     transition-colors hover:bg-accent focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LayoutGrid className="size-[15px] shrink-0" aria-hidden="true" />
          {t('bento.launcher.title')}
        </button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
        <BentoSettings placement="dock" />
      </div>

      {/* The account, at the edge of the screen rather than in the middle of
          the bar. Its own fixed element, not a third region of the dock: the
          dock is a place you point at deliberately and this is a place you go
          when you already know what you want. */}

      {/* Outside the pill on purpose. backdrop-filter establishes a containing
          block, so a fixed-position child anchors to the blurred element instead
          of the viewport and the overlay opens inside the dock. */}
      <BentoLauncher open={all} onClose={() => setAll(false)} />
    </>
  )
}
