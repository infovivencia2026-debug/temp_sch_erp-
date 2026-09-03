import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Settings } from 'lucide-react'
import { useAppearanceRequest } from '@/lib/appearance-request'
import { usePhone } from '@/lib/viewport'
import { useT } from '@/lib/i18n'
import { AppearanceDialog } from './AppearanceDialog'
import { cn } from '@/lib/utils'
import { INK, EDGE, WASH } from './ColourDialog'

/* Settings, from inside a layout that has no header to put them in.

   Bento hides the chrome, and the theme toggle went with it — the same way
   ⌘K did, and for the same reason the dock exists at all. So this sits in the
   dock beside the launcher rather than being a route: changing the palette is
   something you do *while looking at* the thing whose palette you are
   changing, and sending someone to a settings page to do it means they judge
   the result on the wrong screen.

   THIS IS A BUTTON NOW, AND NOT A MENU.

   It was a popover listing a handful of rows, one of which opened the
   appearance dialog. That made pressing the settings cog a question -- which
   settings? -- answered by a list whose every substantive entry led to the
   same window. Two surfaces, one of them a waiting room for the other.

   The cog opens that window directly. The four rows the popover still had
   after the appearance rows merged into it -- full screen, reset appearance,
   my profile, sign out -- went into the dialog's footer, where they are
   visible from every tab rather than one press further away than the thing
   they sat in front of.

   What is left here is the trigger and the mount. The placement prop survives
   because the cog itself still looks different in a dock, a rail, a menu bar
   and a sidebar; it no longer has to position a floating panel, which is where
   most of this file used to go.

   AND ON A PHONE IT IS A LINK, NOT A TRIGGER.

   The paragraph above is the argument for a window rather than a route, and it
   is still right where it is true: on a desktop the dialog floats over the
   live page, and the palette you are choosing repaints the thing behind it
   while you choose. On a 390px phone none of that holds. The dialog's own
   panel is `h-full ... rounded-none` there -- a full sheet covering every
   pixel of the page it was supposed to float over -- so there is nothing
   behind it to judge a palette against, and it was a full-screen settings
   surface that merely had no URL.

   What the missing URL cost: a history entry pushed by hand so the back
   gesture would not close the tab, a dock item that could not be drawn as the
   current tab because nothing in the location said it was current, and a
   fourth tab in a four-tab bar that left the screen by a mechanism the other
   three do not use. So below 768px this navigates to /settings and the dialog
   is not mounted at all; at and above it, everything is exactly as it was. */

export type SettingsPlacement = 'dock' | 'sidebar' | 'rail' | 'menubar'

export function BentoSettings({ placement = 'dock' }: { placement?: SettingsPlacement }) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const phone = usePhone()
  const [showAppearance, setShowAppearance] = useState(false)
  const [appearanceTab, setAppearanceTab] = useState<'appearance' | 'dock' | 'dashboard'>('appearance')

  /* Somebody else asked for this dialog — the tab menu, offering to add a
     widget to the board they right-clicked. The dialog is mounted here and
     nowhere else, so the request arrives as a value rather than as a prop
     threaded through the shell. */
  const wanted = useAppearanceRequest()
  useEffect(() => {
    // One answerer. This component is mounted four times — dock, rail,
    // sidebar, menu bar — and three of them are hidden by whichever layout is
    // in force, so an unguarded request would open four dialogs, three of them
    // stacked behind chrome nobody can see. The dock is the instance the Focus
    // layout always has.
    if (placement !== 'dock' || wanted.seq === 0) return
    /* A request names a page, and on a phone a page is an address. Pushed
       rather than replaced: this one IS a step -- somebody asked to go
       somewhere from the board they were looking at, and back should return
       them to that board. */
    if (phone) {
      navigate(`/settings/${wanted.page}`)
      return
    }
    setAppearanceTab(wanted.page)
    setShowAppearance(true)
  }, [wanted.seq, wanted.page, placement, phone, navigate])

  /* The dock draws this as the current tab the same way it draws Home and
     Work: by asking the location, which is the thing a route made possible.
     Both section pages count, so drilling into Colour does not un-highlight
     the tab you are standing in. */
  const here = location.pathname === '/settings' ||
    location.pathname.startsWith('/settings/')

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          if (phone) { navigate('/settings'); return }
          setAppearanceTab('appearance')
          setShowAppearance(true)
        }}
        aria-haspopup={phone ? undefined : 'dialog'}
        aria-expanded={phone ? undefined : showAppearance}
        aria-current={phone && here ? 'page' : undefined}
        data-tip={placement === 'dock' ? t('bento.settings.label') : undefined}
        aria-label={t('bento.settings.label')}
        title={t('bento.settings.label')}
        /* THE RING IS DRAWN ON WHATEVER THIS IS SITTING ON.

           In the dock that is the dock's face, and `ring-ring` — the mint
           accent — measured 1.2:1 against it. `--ink-here` is the name every
           surface in this layout gives to "the colour that reads on me"; the
           dock declares it, and the fallback covers the sidebar and the rail,
           where the ground is the card. The disc itself keeps its shape: it
           is the card at 80%, which is a light disc on a dark dock and a dark
           one on a light dock, and the ink follows it either way. */
        className={cn(
          'transition-colors focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-[var(--ink-here,var(--bento-ink))]',
          /* THE CURRENT TAB IS FILLED, like the other destinations in the
             bar. Mixed from `--ink-here` -- the dock's own ink -- rather than
             from the card's, because the dock may have a face of its own and
             a wash mixed from the wrong ground is the invisible-fill bug this
             bar has already been fixed for twice. A 16% tint of an ink that
             measures 21:1 on its ground leaves the glyph well above 4.5:1. */
          /* `--ink-here` alone, with no `var(..., fallback)` inside it. The
             nested form -- var(--ink-here,var(--bento-ink)) -- parses as a
             Tailwind arbitrary value and compiles, but the inner comma ends
             the color-mix argument early and the declaration is dropped: the
             fill measured rgba(0, 0, 0, 0) on the live bar, which is to say
             the current tab was not marked at all. Guarded on the dock, which
             is the one placement that declares the token. */
          placement === 'dock'
            ? `grid size-10 place-items-center rounded-full border
               bg-[color-mix(in_srgb,var(--bento-card)_80%,transparent)]
               shadow-sm backdrop-blur-md ${EDGE} ${INK} ${WASH}`
            : (placement === 'rail' || placement === 'menubar')
              ? `grid size-10 place-items-center rounded-[10px] ${INK} ${WASH}`
              : `flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left
                 text-[12.5px] ${INK} ${WASH}`,
        )}
      >
        <Settings
          className={placement === 'sidebar' ? 'size-4 shrink-0' : 'size-[18px]'}
          aria-hidden="true"
        />
        {placement === 'sidebar' && <span>{t('bento.settings.label')}</span>}
      </button>

      {/* Not mounted on a phone at all. The route renders the same sections
          from the same components, and a dialog that can never open is a
          dialog whose history machinery could still fire. */}
      {!phone && (
      <AppearanceDialog
        open={showAppearance}
        onClose={() => setShowAppearance(false)}
        initialTab={appearanceTab}
      />
      )}
    </div>
  )
}
