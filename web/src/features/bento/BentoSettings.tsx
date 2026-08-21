import { useEffect, useRef, useState } from 'react'
import { Settings, Sun, Moon, Monitor, Check } from 'lucide-react'
import { useTheme, THEMES, type Theme } from '@/lib/theme'
import { useT } from '@/lib/i18n'
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

export function BentoSettings() {
  const { theme, resolved, setTheme } = useTheme()
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

  // The trigger shows what is on screen now, not what was chosen: on 'system'
  // a monitor icon says nothing about which palette you are looking at.
  const Trigger = resolved === 'dark' ? Moon : Sun

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('bento.settings.label')}
        title={t('bento.settings.label')}
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors
                   hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Settings className="size-3.5" aria-hidden="true" />
        <Trigger className="size-3.5" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-48 overflow-hidden rounded-xl
                     border bg-popover p-1 shadow-lg"
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
        </div>
      )}
    </div>
  )
}
