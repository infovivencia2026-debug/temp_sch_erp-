import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  LogOut, Settings, UserCircle,
  Maximize2, Type, Minimize2,
  Contrast as RotateCcw, } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { resetAppearance } from '@/lib/appearance'
import { useAppearanceRequest } from '@/lib/appearance-request'
import { useT } from '@/lib/i18n'
import { AppearanceDialog } from './AppearanceDialog'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { INK, EDGE, WASH, RING, SURFACE } from './ColourDialog'

/* Settings, from inside a layout that has no header to put them in.

   Bento hides the chrome, and the theme toggle went with it — the same way
   ⌘K did, and for the same reason the dock exists at all. So this sits in the
   dock beside the launcher rather than being a route: changing the palette is
   something you do *while looking at* the thing whose palette you are
   changing, and sending someone to a settings page to do it means they judge
   the result on the wrong screen.

   A menu rather than a bare toggle, because a toggle can only say two things
   and the product supports three. It is built to take more rows — density and
   contrast are the obvious next two, and both already live on the same
   preferences row this writes to. */


/* Where the menu hangs from.

   The same list of preferences is wanted from two places that are nowhere near
   each other: the dock, which floats at the top right of a chrome-less canvas,
   and the foot of the classic sidebar. Rather than two components that drift,
   one takes a placement — which decides the trigger's shape and which corner
   the panel opens from, and nothing else. */
export type SettingsPlacement = 'dock' | 'sidebar' | 'rail' | 'menubar'

/* One shared class string for every row in the menu. */
const ROW = `flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px]
             transition-colors ${WASH} ${RING}`

export function BentoSettings({ placement = 'dock' }: { placement?: SettingsPlacement }) {
  /* `resolved` is still read: the panel picks its own ink from the theme in
     force, whether or not anybody can choose it here. */
  const { resolved } = useTheme()

  /* Full screen, tracked rather than assumed.

     The button has to say which way it goes, and the state can change without
     it — Escape and F11 both leave full screen without touching this menu — so
     it listens rather than remembering what it last asked for. */
  const [full, setFull] = useState(() =>
    typeof document !== 'undefined' && !!document.fullscreenElement,
  )
  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleFull = () => {
    /* Both calls reject rather than throw — a browser may refuse full screen
       when the gesture is not trusted — so the rejection is swallowed and the
       listener above keeps the label truthful either way. */
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void document.documentElement.requestFullscreen().catch(() => {})
  }
  const session = useSession()
  const t = useT()
  const [open, setOpen] = useState(false)
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
    setAppearanceTab(wanted.page)
    setShowAppearance(true)
    setOpen(false)
  }, [wanted.seq, wanted.page, placement])
  /* No pane state any more.

     This was a macOS-style drill-down: a root list of categories, each opening
     into its own screen with a back arrow. Exactly one category ever existed
     (Layout), and its screen held one choice. A drill-down with a single branch
     is a corridor. Layout moved into the appearance dialog beside the other
     axes, and the menu became what it always was in practice -- a flat list. */
  const box = useRef<HTMLDivElement>(null)
  /* The menu is portaled to document.body, so it is NOT a DOM descendant of
     `box` — the trigger's wrapper — even though it is a React child of it. It
     needs its own ref, or the dismiss handler below cannot recognise it. */
  const menu = useRef<HTMLDivElement>(null)

  /* Escape and click-outside both close it. A popover dismissable only by the
     button that opened it is one people leave open. */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      /* Both boxes, and that is the whole bug this line used to have.

         Dismissal listens on mousedown, which fires BEFORE click. With only
         `box` tested, every press inside the portaled menu counted as outside:
         the menu unmounted on mousedown, and the button never lived long
         enough to receive its click. The menu opened, and nothing in it
         worked. */
      const t = e.target as Node
      if (!box.current?.contains(t) && !menu.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  /* A cog, at the far right of the screen.

     It was the institution's initial for a while, on the argument that
     everything behind it is about this account and this school. Overruled, and
     the cog is the more recognisable target — people look for a cog when they
     want to change something, and the menu's first job is the palette. */
  void resolved
  void session


  /* Anchored to the button, but drawn outside everything.

     The menu was absolutely positioned inside its own container, so whichever
     ancestor happened to scroll — the sidebar, the rail — clipped it. In the
     sidebar it lost its first item at the top and Sign out at the bottom, which
     is a menu that hides the one thing somebody opened it to do.

     So it renders into the body and takes its coordinates from the button's
     own rectangle: no ancestor's overflow can reach it. It opens upward when
     there is room above and downward when there is not, and is nudged back
     inside the viewport rather than being allowed to run off the edge. */
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return setAt(null)
    const place = () => {
      const b = box.current?.querySelector('button')?.getBoundingClientRect()
      if (!b) return
      /* Sized for a hand and a glance, not for the shortest label.

         This was 256, then 312 from the dock, and both were set by what the
         text needed rather than by what the menu is: a small number of
         destinations somebody picks from once and closes. At those widths the
         rows were 28px tall and the labels 13px — a dense list, which is the
         right shape for a menu of forty things and the wrong one for a menu of
         nine, where every row is a place to go and none of them is a repeat
         visit. */
      const W = placement === 'dock' ? 360 : 320
      const GAP = 8
      const room = b.top - GAP
      const height = Math.min(window.innerHeight * 0.8, 560)
      const above = room > height
      const left =
        placement === 'rail'
          ? b.right + GAP
          : placement === 'dock'
            /* Centred on the trigger. It hung off the dock's right-hand end, so
               a menu belonging to the whole bar looked like it belonged to the
               last button in it. */
            ? b.left + b.width / 2 - W / 2
            : placement === 'menubar'
              ? b.right - W
              : b.left
      return setAt({
        left: Math.max(GAP, Math.min(left, window.innerWidth - W - GAP)),
        top: above ? Math.max(GAP, b.top - GAP - height) : Math.min(b.bottom + GAP, window.innerHeight - GAP - height),
      })
    }
    place()
    // A menu that stays put while the page moves under it is worse than one
    // that closes, so it follows.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, placement])

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
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

      {/* A frosted scrim, the same glass All features uses.

          The menu opened straight onto a live dashboard, so a list of settings
          sat on moving figures and coloured cards and competed with them.
          Clicking it closes, which is what everybody tries first. */}
      {open && createPortal(
        <div
          className="fade-in bento-frost fixed inset-0 z-40"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />,
        document.body,
      )}

      {open && at && createPortal(
        <div
          role="menu"
          ref={menu}
          style={{ position: 'fixed', left: at.left, top: at.top, width: 256,
                   maxHeight: 'min(70vh, 420px)' }}
          /* A panel that states both halves of its pair.

             It said `bg-popover` and nothing about ink, so the surface came
             from the palette and the words came from whatever <body> was
             inheriting — a coincidence that happens to hold today and has
             nothing keeping it. Its edge was `--bento-line`, the hairline
             BETWEEN cards at 1.38:1, which is not enough to separate a
             floating panel from the near-black page behind it. */
          className={cn(
            `z-50 overflow-y-auto overscroll-contain rounded-xl border p-1 shadow-lg`,
            SURFACE, EDGE,
            (placement === 'menubar') ? 'pop-down' : 'pop-up',
          )}
        >
          {/* ONE door, not four.

              This list had Layout, Appearance, Dock Settings and Dashboard
              Widgets on it. Layout opened a pane here; the other three each
              opened a different tab of the same dialog. So four rows, four
              words, one destination -- and no way to tell from the labels
              that Dock Settings and Appearance were the same window. People
              opened three of them looking for the fourth.

              They are one row now. The dialog behind it already names its
              own pages along the top, which is where a choice between
              Appearance, Colour, Dock and Dashboard belongs: inside the
              thing, after you have opened it, not guessed at from out here.
              Layout moved in with them as another axis on the first page. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => { setAppearanceTab('appearance'); setShowAppearance(true); setOpen(false) }}
            className={ROW}
          >
            <Type className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{t('bento.appearance.title')}</span>
          </button>

          <div
            className="my-1 h-px bg-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]"
            role="separator"
          />

          {/* Single-toggle and terminal actions stay flat at the root —
              Mac's own Settings does the same with Lock Screen / Log Out:
              a dialog exists for a set of related choices, not for one
              switch or a one-way door. */}
          <button type="button" role="menuitem" onClick={toggleFull} className={ROW}>
            {full
              ? <Minimize2 className="size-4 shrink-0" aria-hidden="true" />
              : <Maximize2 className="size-4 shrink-0" aria-hidden="true" />}
            <span className="flex-1">
              {t(full ? 'bento.settings.fullscreen.exit' : 'bento.settings.fullscreen')}
            </span>
          </button>

          {/* A way back. Enough axes lived here at once that somebody
              ended up somewhere they could not retrace, and a settings
              panel with no exit from itself is a trap. */}
          <button type="button" role="menuitem" onClick={() => resetAppearance()} className={ROW}>
            <RotateCcw className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{t('bento.settings.reset')}</span>
          </button>

          {/* The account screen existed and nothing pointed at it.

              /account sits outside the catalogue on purpose — everybody has a name,
              a password and contact details whatever their role — but the only way in
              was to type the URL. Ten roles could sign in with no route to their own
              profile, which is why it read as a feature that did not exist.

              Directly above sign out, where every product keeps the account it
              belongs to. */}
          <a href="/account" role="menuitem" className={ROW}>
            <UserCircle className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{t('bento.settings.account')}</span>
          </a>

          <a href="/logout" role="menuitem" className={ROW}>
            <LogOut className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{t('bento.settings.signout')}</span>
          </a>
        </div>,
        document.body,
      )}

      {/* Mounted outside the popover, which closes when either opens: a dialog
          rendered inside it would unmount with it. */}
      <AppearanceDialog
        open={showAppearance}
        onClose={() => setShowAppearance(false)}
        initialTab={appearanceTab}
      />
    </div>
  )
}
