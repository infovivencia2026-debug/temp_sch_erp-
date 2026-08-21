import { useEffect, useRef, useState } from 'react'
import {
  Sun, Moon, Monitor, Check, LogOut, Square, Frame, Settings, PanelLeft,
  Maximize2, Type, Minimize2, LayoutGrid, Sliders,
  Contrast as RotateCcw, } from 'lucide-react'
import { useTheme, THEMES, type Theme } from '@/lib/theme'
import { useSkin, SKINS, type Skin } from '@/lib/skin'
import { resetAppearance } from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import { AppearanceDialog } from './AppearanceDialog'
import { useLayout, LAYOUTS, type Layout } from '@/lib/layout'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'

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

const ICON: Record<Theme, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

/* Where the menu hangs from.

   The same list of preferences is wanted from two places that are nowhere near
   each other: the dock, which floats at the top right of a chrome-less canvas,
   and the foot of the classic sidebar. Rather than two components that drift,
   one takes a placement — which decides the trigger's shape and which corner
   the panel opens from, and nothing else. */
export type SettingsPlacement = 'dock' | 'sidebar' | 'rail' | 'menubar'

export function BentoSettings({ placement = 'dock' }: { placement?: SettingsPlacement }) {
  const { theme, resolved, setTheme } = useTheme()
  const { layout, setLayout } = useLayout()
  const { skin, setSkin } = useSkin()

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
  const box = useRef<HTMLDivElement>(null)

  /* Escape and click-outside both close it. A popover dismissable only by the
     button that opened it is one people leave open. */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
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


  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('bento.settings.label')}
        title={t('bento.settings.label')}
        className={cn(
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          placement === 'dock'
            ? `grid size-10 place-items-center rounded-full border bg-popover/80
               text-muted-foreground shadow-sm backdrop-blur-md hover:bg-accent
               hover:text-foreground`
            : (placement === 'rail' || placement === 'menubar')
              ? `grid size-10 place-items-center rounded-[10px] text-muted-foreground
                 hover:bg-surface-hover hover:text-foreground`
              : `flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left
                 text-[12.5px] text-muted-foreground hover:bg-surface-hover
                 hover:text-foreground`,
        )}
      >
        <Settings
          className={placement === 'sidebar' ? 'size-4 shrink-0' : 'size-[18px]'}
          aria-hidden="true"
        />
        {placement === 'sidebar' && <span>{t('bento.settings.label')}</span>}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            `absolute z-50 max-h-[70vh] w-64 overflow-y-auto overscroll-contain rounded-xl
             border bg-popover p-1 shadow-lg`,
            (placement === 'menubar') ? 'pop-down' : 'pop-up',
            (placement === 'menubar')
              ? 'right-0 top-[calc(100%+8px)]'
              : placement === 'dock'
                ? 'right-0 bottom-[calc(100%+16px)]'
              : placement === 'rail'
                ? 'bottom-0 left-[calc(100%+8px)]'
                : 'bottom-[calc(100%+8px)] left-0',
          )}
        >
          <p className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider
                        text-muted-foreground">
            {t('bento.settings.appearance')}
          </p>
          {THEMES.map((option) => {
            const Icon = ICON[option]
            const active = theme === option
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setTheme(option)
                  setOpen(false)
                }}
                className={cn(
                  `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                   transition-colors hover:bg-accent focus-visible:outline-none
                   focus-visible:ring-2 focus-visible:ring-ring`,
                  active && 'font-medium',
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1">{t(`bento.settings.theme.${option}`)}</span>
                {active && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
              </button>
            )
          })}

          <div className="my-1 h-px bg-border" role="separator" />


          {/* Appearance, Dock, Dashboard — three distinct settings destinations */}
          <button
            type="button"
            role="menuitem"
            onClick={() => { setAppearanceTab('appearance'); setShowAppearance(true); setOpen(false) }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                       transition-colors hover:bg-accent focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Type className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">{t('bento.appearance.title')}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => { setAppearanceTab('dock'); setShowAppearance(true); setOpen(false) }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                       transition-colors hover:bg-accent focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LayoutGrid className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">Dock Settings</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => { setAppearanceTab('dashboard'); setShowAppearance(true); setOpen(false) }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                       transition-colors hover:bg-accent focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Sliders className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">Dashboard Widgets</span>
          </button>

          <div className="my-1 h-px bg-border" role="separator" />

          {/* The frame, beside the palette rather than under a heading of its
              own. They are the same kind of decision — what this surface looks
              like — and a person changing one is usually looking at the other. */}
          <p className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider
                        text-muted-foreground">
            {t('bento.settings.frame')}
          </p>
          {SKINS.map((option) => {
            const Icon = option === 'neominimalist' ? Square : Frame
            const active = skin === option
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => setSkin(option as Skin)}
                className={cn(
                  `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                   transition-colors hover:bg-accent focus-visible:outline-none
                   focus-visible:ring-2 focus-visible:ring-ring`,
                  active && 'font-medium',
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1">{t(`bento.settings.skin.${option}`)}</span>
                {active && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
              </button>
            )
          })}

          <div className="my-1 h-px bg-border" role="separator" />

          {/* Layout as a preference, not an exit.

              This was a "Leave Bento" button, which asked a user to know that
              they were inside something called Bento — our word for it, never
              theirs. It reads as two choices about how the screen is arranged
              now, which is what it always was.

              It could not simply be deleted. The switch lives nowhere else: the
              appearance screen that carries theme and density is catalogued for
              students only, so a principal has no other route to it, and the
              classic header is hidden by the very layout they would be trying
              to leave. Removing the row would have stranded them — the bug this
              codebase already fixed once under "give the chrome-less layout its
              doors back". */}
          <p className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider
                        text-muted-foreground">
            {t('bento.settings.layout')}
          </p>
          {LAYOUTS.map((option) => {
            const Icon = option === 'classic' ? PanelLeft : Maximize2
            const active = layout === option
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setLayout(option as Layout)
                  setOpen(false)
                }}
                className={cn(
                  `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                   transition-colors hover:bg-accent focus-visible:outline-none
                   focus-visible:ring-2 focus-visible:ring-ring`,
                  active && 'font-medium',
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1">{t(`bento.settings.layout.${option}`)}</span>
                {active && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
              </button>
            )
          })}

          <div className="my-1 h-px bg-border" role="separator" />

          <button
            type="button"
            role="menuitem"
            onClick={toggleFull}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                       transition-colors hover:bg-accent focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-ring"
          >
            {full
              ? <Minimize2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              : <Maximize2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <span className="flex-1">
              {t(full ? 'bento.settings.fullscreen.exit' : 'bento.settings.fullscreen')}
            </span>
          </button>

          {/* A way back. Nine axes is enough that somebody ends up somewhere
              they cannot retrace, and a settings panel with no exit from itself
              is a trap. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => resetAppearance()}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                       transition-colors hover:bg-accent focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCcw className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">{t('bento.settings.reset')}</span>
          </button>

          <a
            href="/logout"
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                       transition-colors hover:bg-accent focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LogOut className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">{t('bento.settings.signout')}</span>
          </a>
        </div>
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
