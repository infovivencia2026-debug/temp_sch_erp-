import { useEffect, useRef, useState } from 'react'
import {
  Sun, Moon, Monitor, Check, LogOut, Square, Frame, Settings, PanelLeft,
  Maximize2, Rows2, Rows3, Rows4, Squircle, Type, Droplets,
} from 'lucide-react'
import { useTheme, THEMES, type Theme } from '@/lib/theme'
import { useSkin, SKINS, type Skin } from '@/lib/skin'
import {
  useAppearance, DENSITIES, CORNERS, TEXT_SIZES,
  type Density, type Corners, type TextSize,
} from '@/lib/appearance'
import { useT } from '@/lib/i18n'
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
export type SettingsPlacement = 'dock' | 'sidebar'

export function BentoSettings({ placement = 'dock' }: { placement?: SettingsPlacement }) {
  const { theme, resolved, setTheme } = useTheme()
  const { layout, setLayout } = useLayout()
  const { skin, setSkin } = useSkin()
  const { appearance, set: setAppearance } = useAppearance()
  const session = useSession()
  const t = useT()
  const [open, setOpen] = useState(false)
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

  /* One row renderer for every axis. Four near-identical map() blocks was how
     the theme and skin lists started, and a fifth would have made the drift
     between them a certainty. */
  const Choice = <T extends string>({
    value, options, onPick, label, icon: Icon,
  }: {
    value: T
    options: readonly T[]
    onPick: (v: T) => void
    label: (v: T) => string
    icon: (v: T) => typeof Sun
  }) => (
    <>
      {options.map((option) => {
        const Glyph = Icon(option)
        const active = value === option
        return (
          <button
            key={option}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            onClick={() => onPick(option)}
            className={cn(
              `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
               transition-colors hover:bg-accent focus-visible:outline-none
               focus-visible:ring-2 focus-visible:ring-ring`,
              active && 'font-medium',
            )}
          >
            <Glyph className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">{label(option)}</span>
            {active && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
          </button>
        )
      })}
    </>
  )

  const Group = ({ children }: { children: string }) => (
    <p className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider
                  text-muted-foreground">
      {children}
    </p>
  )

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
            : `flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left
               text-[12.5px] text-muted-foreground hover:bg-surface-hover
               hover:text-foreground`,
        )}
      >
        <Settings
          className={placement === 'dock' ? 'size-[18px]' : 'size-4 shrink-0'}
          aria-hidden="true"
        />
        {placement === 'sidebar' && <span>{t('bento.settings.label')}</span>}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            `absolute z-50 max-h-[70vh] w-52 overflow-y-auto overscroll-contain rounded-xl
             border bg-popover p-1 shadow-lg`,
            placement === 'dock' ? 'pop-down' : 'pop-up',
            /* From the sidebar's foot it opens upward: there is nothing below
               it but the window edge, and a menu that would need the page to
               scroll to be read is a menu that cannot be used from there. */
            placement === 'dock'
              ? 'right-0 top-[calc(100%+8px)]'
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

          <Group>{t('bento.settings.density')}</Group>
          <Choice<Density>
            value={appearance.density}
            options={DENSITIES}
            onPick={(v) => setAppearance('density', v)}
            label={(v) => t(`bento.settings.density.${v}`)}
            icon={(v) => (v === 'compact' ? Rows4 : v === 'relaxed' ? Rows2 : Rows3)}
          />

          <Group>{t('bento.settings.corners')}</Group>
          <Choice<Corners>
            value={appearance.corners}
            options={CORNERS}
            onPick={(v) => setAppearance('corners', v)}
            label={(v) => t(`bento.settings.corners.${v}`)}
            icon={(v) => (v === 'sharp' ? Square : v === 'round' ? Squircle : Frame)}
          />

          <Group>{t('bento.settings.text')}</Group>
          <Choice<TextSize>
            value={appearance.text}
            options={TEXT_SIZES}
            onPick={(v) => setAppearance('text', v)}
            label={(v) => t(`bento.settings.text.${v}`)}
            icon={() => Type}
          />

          <div className="my-1 h-px bg-border" role="separator" />

          {/* The frame, beside the palette rather than under a heading of its
              own. They are the same kind of decision — what this surface looks
              like — and a person changing one is usually looking at the other. */}
          <p className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider
                        text-muted-foreground">
            {t('bento.settings.frame')}
          </p>
          {SKINS.map((option) => {
            const Icon = option === 'brutalist' ? Square : option === 'glass' ? Droplets : Frame
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
    </div>
  )
}
