import { useEffect, useRef, useState } from 'react'
import { Sun, Moon, Monitor, Check, LogOut, Rows3 } from 'lucide-react'
import { useTheme, THEMES, type Theme } from '@/lib/theme'
import { useT } from '@/lib/i18n'
import { useLayout } from '@/lib/layout'
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

export function BentoSettings() {
  const { theme, resolved, setTheme } = useTheme()
  const { setLayout } = useLayout()
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

  /* The trigger is the institution's mark, not a cog.

     Everything behind it is about this account and this school -- the palette,
     the layout, signing out -- and a cog says "product settings", which is the
     one thing it does not open. Placed at the far right of the screen rather
     than in the centre dock, because the dock should hold what a person does
     several times an hour and this is not that. */
  const initial = session.institution?.short_name?.[0] ?? 'E'
  void resolved

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('bento.settings.label')}
        title={t('bento.settings.label')}
        className="grid size-9 place-items-center rounded-full border bg-popover/80 text-[12.5px]
                   font-semibold shadow-sm backdrop-blur-md transition-colors hover:bg-accent
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {initial}
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

          <div className="my-1 h-px bg-border" role="separator" />

          {/* The way out of Bento lives here now, not in the dock.

              Nobody should have to know they are "inside Bento" to use the
              product, so the centre bar stops saying so. But the exit cannot
              simply go: this layout hides the header, and the header is where
              the classic product keeps sign-out, notifications and the role
              switch. A chrome-less layout with no door is the bug this
              codebase already fixed once. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setLayout('classic')
              setOpen(false)
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]
                       transition-colors hover:bg-accent focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Rows3 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">{t('bento.escape.back')}</span>
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
    </div>
  )
}
