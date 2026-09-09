import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Expand, Moon, Palette, Settings, Shrink, Sun } from 'lucide-react'
import { useApp } from '@/hooks/useAppState'
import { AppearanceDialog } from '@/components/layout/appearance'
import { BackgroundPicker } from '@/components/layout/BackgroundPicker'

/* ===========================================================================
   RIGHT-CLICK ANYWHERE

   The same view options the top bar carries, offered where the pointer already
   is. The bar keeps them — this is an addition, not a replacement — because
   discovering a right-click menu requires trying it, and a control you can see
   is worth more than one you have to guess at.

   The browser's own menu is only suppressed over the application's chrome and
   canvas. Right-clicking a link, an image or selected text is left alone,
   since "copy link" and "search for this" are the reasons people right-click
   in the first place.
   =========================================================================== */

export function ContextMenu() {
  const app = useApp()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      // Leave the browser's menu where it earns its place.
      if (t.closest('a[href], img, input, textarea, [contenteditable="true"]')) return
      if (String(window.getSelection() ?? '').length > 0) return

      e.preventDefault()
      // Roughly the menu's size, so it never opens off the edge.
      const W = 232, H = 188
      setAt({
        x: Math.min(e.clientX, window.innerWidth - W - 8),
        y: Math.min(e.clientY, window.innerHeight - H - 8),
      })
    }
    const dismiss = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-context-menu]')) setAt(null)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null) }

    document.addEventListener('contextmenu', onMenu)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', esc)
    window.addEventListener('blur', () => setAt(null))
    return () => {
      document.removeEventListener('contextmenu', onMenu)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', esc)
    }
  }, [])

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
    setFullscreen((f) => !f)
  }

  const items = [
    {
      label: app.theme === 'dark' ? 'Light appearance' : 'Dark appearance',
      icon: app.theme === 'dark' ? Sun : Moon,
      run: () => app.setTheme(app.theme === 'dark' ? 'light' : 'dark'),
    },
    { label: 'Typeface & density', icon: Settings, run: () => setAppearanceOpen(true) },
    { label: 'Colour settings', icon: Palette, run: () => setBgOpen(true) },
    { label: fullscreen ? 'Exit full screen' : 'Full screen', icon: fullscreen ? Shrink : Expand, run: toggleFullscreen },
  ]

  return (
    <>
      {at && createPortal(
        <div
          data-context-menu
          role="menu"
          aria-label="View options"
          style={{ left: at.x, top: at.y }}
          className="fixed z-[88] min-w-[216px] overflow-hidden rounded-xl border bg-[hsl(var(--popover))] p-1 shadow-[0_18px_44px_-18px_hsl(var(--foreground)/0.45)] animate-in"
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              onClick={() => { setAt(null); it.run() }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-accent hover:text-accent-foreground"
            >
              <it.icon className="h-4 w-4 shrink-0 muted" />
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}

      <AppearanceDialog open={appearanceOpen} onClose={() => setAppearanceOpen(false)} />
      <BackgroundPicker open={bgOpen} onClose={() => setBgOpen(false)} />
    </>
  )
}
