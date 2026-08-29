import { useMemo, useState , type CSSProperties } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { LayoutGrid, Inbox, House } from 'lucide-react'
import { useLayout } from '@/lib/layout'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useActiveRole, featurePath, usable } from '@/lib/catalog'
import { CommandSearch } from '@/components/CommandSearch'
import Notifications from '@/components/Notifications'
import { BentoLauncher, markFor, hueFor } from './BentoLauncher'
import { BentoSettings } from './BentoSettings'
import { useAppearance } from '@/lib/appearance'
import { useBoard } from '@/lib/widgets'
import { usePhone } from '@/lib/viewport'

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
  /* A phone dock is a different dock, not a narrower one.

     This bar's own comment budgets about 430px for nine workspace marks and
     the fixed items — the arithmetic was explicitly about "any screen wide
     enough to be running the desktop layout at all", which a 390px phone is
     not. It has no wrap and, deliberately, no horizontal scroller, so on a
     phone the items simply ran past the end of the pill.

     Nothing is removed from the product by this: every workspace mark is a
     shortcut into the launcher's own list, and the launcher is one press away
     on the same bar. What is left is what a home screen dock holds — the four
     or five places you go several times an hour. */
  const phone = usePhone()
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
    /* HOME MEANS THE HOME SCREEN, not simply the first door that opens.

       This walked the sections in catalogue order and returned the first
       usable feature it met, which is the dashboard only when the dashboard
       happens to sort first. Where it does not, pressing Home landed on some
       other screen and the board could not be reached from the dock at all.

       The home section is asked for by name first. The old sweep stays as the
       fallback, so a role with no such section still gets a door rather than a
       dead button. */
    const home = role.sections.find((s) => s.slug === 'home')
    const preferred = home?.features.find(usable)
    if (home && preferred) return featurePath(role.key, home.slug, preferred.slug)
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
  /* THE DOCK'S OWN INK, NOT THE CARD'S.

     The bar reads `--bento-dock-ink` with the card's ink as its fallback, and
     that is right — a palette may give the dock a face of its own and it
     measured the ink against that face. What did not follow were the three
     things the utility classes were painting: the hover wash came from
     `--bento-ink`, the focus ring from `--bento-mint`, and the dividers from
     `--bento-line`. All three are the CARD's values, so on a dock that is not
     the card they were the wrong colour, and the mint ring measured 1.2:1
     against the default palette's paper dock — a focus ring a keyboard user
     cannot see is the same as no focus ring.

     `--ink-here` is the dock's ink under the name every surface in this layout
     uses for "the colour that reads on me", and the three are mixed from it. */
  const item =
    `grid shrink-0 place-items-center rounded-full transition-colors ` +
    `hover:bg-[color-mix(in_srgb,var(--ink-here)_12%,transparent)] focus-visible:outline-none ` +
    `focus-visible:ring-2 focus-visible:ring-[var(--ink-here)]`
  const btnStyle = { width: 'var(--dock-btn, 40px)', height: 'var(--dock-btn, 40px)' }

  /* ON A PHONE THE ICONS CARRY THEIR NAMES.

     The bar was five unlabelled glyphs, and the only thing telling a person
     what the four-square meant was a `data-tip` — a hover tooltip, on a device
     with no hover. Tapping it opened a tooltip AND the thing at once, which is
     how a screenshot of this bar ended up with a black "Work" flag floating
     over the board.

     Every phone bar a person already knows names its tabs: the label is not
     decoration, it is the only affordance a touch device has. Two lines, icon
     over word, at the smallest size that still reads.

     Not on tablet or desktop. There the bar is a floating pill of twelve
     workspaces and there IS a pointer, so the tooltip works and twelve labels
     would not fit. */
  const tab = phone
    ? 'flex h-auto w-auto min-w-[54px] flex-col items-center gap-1 rounded-[6px] px-1 py-1.5'
    : ''
  const tabLabel = (text: string) =>
    phone ? (
      <span className="max-w-[62px] truncate text-[9.5px] font-medium leading-none opacity-80">
        {text}
      </span>
    ) : null

  /* THE ONE CONTROL IN HERE THAT IS NOT OURS.

     `CommandSearch` is the classic layout's component, mounted here so ⌘K
     survives the missing header. It is painted in semantic classes —
     `text-muted-foreground`, the preflight `border`, `hover:bg-accent` — and
     the stylesheet repoints all three to the CARD's tokens, which is correct
     everywhere on this surface except the one place it is actually mounted.
     On the dock's own face that made it black-on-near-black: the word
     "Search" measured 1.16:1, and it is the most-used control in the bar.

     Re-coloured from here rather than there, because the component is shared
     with the layout that reads those tokens correctly, and a colour written
     into it would be wrong on one of the two screens whichever way it went.
     Matched on `:has(kbd)` — the shortcut hint is the trigger's own shape, and
     nothing else in the dock carries one — so this reaches that button and no
     other. Every value is the dock's ink or a mix of it.

     Marked important, and measured before it was. The re-pointing rules are
     `[data-layout='bento'] .text-muted-foreground` and
     `[data-layout='bento'] .hover\:bg-accent:hover` — (0,2,0) and (0,3,0),
     against (0,1,2) for a descendant selector like this one. Written plainly
     the declarations compiled, applied to the right element and lost, and the
     word "Search" stayed at 1.16:1. Weight is the thing being overridden here,
     so it is the thing that has to be stated. */
  const adoptSearch =
    `[&_button:has(kbd)]:!text-[var(--ink-here)] ` +
    `[&_button:has(kbd)]:!border-[color-mix(in_srgb,var(--ink-here)_38%,transparent)] ` +
    `[&_button:has(kbd)_kbd]:!border-[color-mix(in_srgb,var(--ink-here)_38%,transparent)] ` +
    `[&_button:has(kbd):hover]:!bg-[color-mix(in_srgb,var(--ink-here)_12%,transparent)]`

  /* THE BELL, ADOPTED ONTO THE DOCK'S FACE.

     Notifications lived only in the classic top bar, and Focus has no top bar
     — so switching to Focus silently cost you every notification the product
     raises: a fee reminder, a leave decision, a child marked absent. The
     feature was built, mounted and answering; it just had nowhere to be drawn.

     Same treatment as CommandSearch beside it, and for the same reason. The
     component is painted in the classic layout's semantic tokens —
     `text-muted-foreground`, `hover:bg-surface-hover` — which resolve against
     a white card. On the near-black dock that is grey on near-black: the bell
     was invisible before the tokens were overridden, not merely dim.

     The unread badge is deliberately NOT overridden. It is
     `bg-destructive` with white text, which is the one thing on the dock that
     should keep its own colour whatever the dock is painted, because a count
     nobody notices is a count that does not work. */
  const adoptBell =
    `[&_button[aria-label*='Notification']]:!text-[var(--ink-here)] ` +
    `[&_button[aria-label*='Notification']:hover]:!bg-[color-mix(in_srgb,var(--ink-here)_12%,transparent)] ` +
    `[&_button[aria-label*='Notification']:hover]:!text-[var(--ink-here)]`

  /* The hairline between groups, on the dock's face rather than on the card's.

     `bg-border` is `--bento-line`, which the default palette writes as black
     at fourteen per cent: correct on white paper and completely invisible on
     the near-black dock, where the three dividers simply were not there. */
  const rule =
    'mx-0.5 h-5 w-px shrink-0 bg-[color-mix(in_srgb,var(--ink-here)_35%,transparent)]'

  return (
    <>
      <div
        className={`bento-dock fixed left-1/2 bottom-6 z-50 flex max-w-[calc(100vw-6rem)]
                   -translate-x-1/2 items-center gap-2 rounded-[14px] border-none
                   bg-[var(--bento-dock-bg,var(--bento-card))]
                   text-[var(--ink-here)] shadow-2xl ${adoptSearch} ${adoptBell}`}
        style={
          {
            padding: 'var(--dock-pad, 8px)',
            paddingLeft: 'calc(var(--dock-pad, 8px) + 4px)',
            /* The device's own reserved strip, added HERE rather than in the
               stylesheet because the padding above is an inline style and a
               rule cannot out-weigh one without !important. On a phone the bar
               sits on the bottom edge, so the home indicator runs straight
               through it unless the bar gives that strip back. */
            ...(phone
              ? { paddingBottom: 'calc(var(--dock-pad, 8px) + env(safe-area-inset-bottom, 0px))' }
              : null),
            '--ink-here': 'var(--bento-dock-ink, var(--bento-ink))',
          } as CSSProperties
        }
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
            className={cn(item, tab)}
            style={phone ? undefined : btnStyle}
            data-tip={phone ? undefined : t('bento.dock.home')}
            aria-label={t('bento.dock.home')}
          >
            <House className="size-[17px]" aria-hidden="true" />
            {tabLabel(t('bento.dock.home'))}
          </button>
        )}

        {/* Brings its own ⌘K listener, so the shortcut works again as soon as
            this mounts — mouse and keyboard reach the same thing. */}
        <CommandSearch />

        {workHref && (
          <button
            type="button"
            onClick={() => navigate(workHref)}
            className={cn(item, tab)}
            style={phone ? undefined : btnStyle}
            data-tip={phone ? undefined : t('bento.dock.work')}
            aria-label={t('bento.dock.work')}
          >
            <Inbox className="size-[17px]" aria-hidden="true" />
            {tabLabel(t('bento.dock.work'))}
          </button>
        )}

        {!phone && categories.length > 0 && (
          <span className={rule} aria-hidden="true" />
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
        {/* THE MARKS ARE THE PART THAT GIVES WAY.

            The bar is `max-w-[calc(100vw-6rem)]` with no wrap, and every item
            in it could shrink. Adding the bell pushed the row past the width
            available at 1440px, so flex compressed the last items instead of
            the middle: measured, the bell rendered 14px wide against its 36px
            box and the settings gear was off the end of the bar entirely.

            `min-w-0` here and `shrink-0` on the group after it inverts that.
            The workspace marks are the only thing in the bar that has another
            way in — every one of them is in the launcher behind All features —
            so they are the right thing to lose first, and losing them is
            invisible rather than broken. */}
        <span className="flex min-w-0 items-center gap-0.5 overflow-hidden">
          {(phone ? [] : categories.filter(c => !hidden.has(c.name))).map((c) => {
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
                {/* The hue, moved far enough toward the dock's ink to be a
                    shape rather than a stain.

                    The domain colours under the default palette ARE its card
                    colours, and two of the twelve — Reports and Staff — are
                    the same near-black the dock's own face is made of. Drawn
                    neat, those two glyphs measured 1.00:1: not dim, absent.
                    Mixed with the ink the dock guarantees it contrasts with,
                    they keep the hue that ties them to the launcher's panels
                    and gain an outline. The same 45% the launcher's chips and
                    headings already use, so the three agree. */}
                <Mark
                  style={{
                    width: 'var(--dock-icon, 17px)',
                    height: 'var(--dock-icon, 17px)',
                    color: `color-mix(in srgb, var(--dom-${hueFor(c.name)}) 45%, var(--ink-here))`,
                  }}
                  aria-hidden="true"
                />
              </button>
            )
          })}
        </span>

        {!phone && <span className={rule} aria-hidden="true" />}

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
          /* Same wash and same ring as every other item in the bar.

             `hover:bg-accent` and `ring-ring` are the card's tokens: on the
             dock's face the wash was black on near-black and the ring was the
             mint accent at 1.2:1 — a focus ring a keyboard user cannot find,
             on the one control that opens everything else. */
          /* On a phone it drops its word and joins the rank.

             The label earns its width on a wide bar, where this is the one
             door people look for by name. On a bottom bar of five items the
             same words make one item twice the size of its neighbours, which
             reads as a mistake rather than as emphasis — and the launcher it
             opens announces its own name the moment it does. */
          className={
            phone
              ? cn(item, tab)
              : `flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px]
                 transition-colors hover:bg-[color-mix(in_srgb,var(--ink-here)_12%,transparent)]
                 focus-visible:outline-none focus-visible:ring-2
                 focus-visible:ring-[var(--ink-here)]`
          }
          aria-label={t('bento.launcher.title')}
        >
          <LayoutGrid className="size-[15px] shrink-0" aria-hidden="true" />
          {phone ? tabLabel(t('bento.dock.browse')) : t('bento.launcher.title')}
        </button>

        {/* Everything from here on keeps its size. These are the controls a
            person reaches for by position rather than by name, and a bell
            crushed to 14px is not a control. */}
        {!phone && <span className={rule} aria-hidden="true" />}
        {/* Beside the settings gear, at the end of the bar. The dock's left
            half is places you go; its right half is the state of your own
            account, and an unread count belongs with the second.

            ON A PHONE IT GETS A WORD, like every other tab. The component
            renders its own 36px button, which among 54px labelled tabs is both
            the odd one out and under the 44px touch target — so the phone
            branch stacks the label beneath it and stretches the button to
            match. The badge is positioned inside that button, so it stays
            anchored to the bell rather than to this wrapper. */}
        {phone ? (
          <span
            className="flex min-w-[54px] flex-col items-center gap-1
                       [&_button]:!h-11 [&_button]:!w-11 [&_button]:!rounded-[6px]"
          >
            <Notifications />
            {tabLabel(t('bento.dock.alerts'))}
          </span>
        ) : (
          /* shrink-0: the component's own button carries no guard, and it is
             the item the bar was crushing. */
          <span className="shrink-0">
            <Notifications />
          </span>
        )}
        <span className="shrink-0">
          <BentoSettings placement="dock" />
        </span>
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
