import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Settings } from 'lucide-react'
import { useAppearanceRequest } from '@/lib/appearance-request'
import { usePhone } from '@/lib/viewport'
import { useT } from '@/lib/i18n'
/* LOADED WHEN FIRST OPENED. The settings window is seventy kilobytes of
   source plus the colour wheel and the rows behind it, and it sat in the
   main bundle for every visitor of every role, most of whom never open it.
   The button is here; the window arrives on the first press. */
const AppearanceDialog = lazy(() =>
  import('./AppearanceDialog').then((m) => ({ default: m.AppearanceDialog })),
)
import { cn } from '@/lib/utils'
import { INK, EDGE, WASH } from './ColourDialog'
import './dock-menus.css'

/* Settings, from inside a layout that has no header to put them in.

   Bento hides the chrome, and the theme toggle went with it — the same way
   ⌘K did, and for the same reason the dock exists at all. So this sits in the
   dock beside the launcher rather than being a route: changing the palette is
   something you do *while looking at* the thing whose palette you are
   changing, and sending someone to a settings page to do it means they judge
   the result on the wrong screen.

   THIS IS A MENU AGAIN, AND HERE IS WHY THAT IS NOT THE OLD MENU.

   It was a popover once, and it was taken down for a good reason: every
   substantive row in it opened the same appearance window, so the cog asked
   "which settings?" and answered with a list that all led to one door. Two
   surfaces, one of them a waiting room for the other.

   That objection no longer holds, because the rows are not about one door.
   The board has a customize mode now — the one a long-press on a card
   enters — and nothing in the dock said so; on the phone in particular the
   mode was reachable only by knowing to hold a card down. So the cog is the
   dock's overflow: "Customize board" and "Add card…" go into the mode, and
   the appearance and board-settings rows go to the window (or, on a phone,
   to the /settings route). Three destinations is a menu; one was not.

   It is the same popover every menu on the board uses (Menu.tsx): opens
   upward from the bar, walks with the arrow keys, catches its own Escape,
   returns focus to the cog, and on a phone is a sheet above the tab bar.

   WHY THE COG AND NOT A LONG-PRESS ON HOME. A long-press on the dock's Home
   button was the other candidate for the phone, and it is exactly as hidden
   as the long-press on a card this row exists to make unnecessary: a gesture
   you have to be told about. A row in a menu is read, not guessed, and the
   cog is the one tab on the phone bar every person opens eventually.

   AND ON A PHONE THE ROUTE STAYS THE DESTINATION.

   Below 768px the appearance dialog is not mounted at all: its panel is a
   full sheet there, so there was nothing behind it to judge a palette
   against, and it was a settings surface that merely had no URL — with a
   history entry pushed by hand and a dock item that could not be drawn as
   current. The /settings route fixed that, and the menu's rows navigate to
   it; the cog is still marked `aria-current` while you stand in it. */

export type SettingsPlacement = 'dock' | 'sidebar' | 'rail' | 'menubar'

export function BentoSettings({
  placement = 'dock',
}: {
  placement?: SettingsPlacement
  /** Accepted for call-site compatibility; the cog no longer offers board rows,
      so it is not read. */
  home?: string
}) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const phone = usePhone()
  const btn = useRef<HTMLButtonElement>(null)
  const [showAppearance, setShowAppearance] = useState(false)
  const [everOpened, setEverOpened] = useState(false)
  useEffect(() => { if (showAppearance) setEverOpened(true) }, [showAppearance])
  const [appearanceTab, setAppearanceTab] = useState<'appearance' | 'dock' | 'dashboard'>('appearance')

  /* The cog opens Settings, and nothing before it.

     It used to open a small menu -- Customize board, Add card, Appearance,
     Board settings -- which was a waiting room in front of the one window that
     holds all of it (the window has a Dashboard tab, and Customize is on the
     board's own Edit pill and a long-press). So the cog now goes straight to the
     Settings window on a desktop, and to the /settings route on a phone where
     the window is a full sheet with no board behind it to judge against. */
  const openSettings = () => {
    if (phone) {
      navigate('/settings')
      return
    }
    setAppearanceTab('appearance')
    setShowAppearance(true)
  }

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
        ref={btn}
        type="button"
        onClick={openSettings}
        aria-haspopup="dialog"
        aria-expanded={showAppearance}
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
      {!phone && everOpened && (
      <Suspense fallback={null}>
      <AppearanceDialog
        open={showAppearance}
        onClose={() => setShowAppearance(false)}
        initialTab={appearanceTab}
      />
      </Suspense>
      )}
    </div>
  )
}
