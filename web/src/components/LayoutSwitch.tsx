import { useEffect } from 'react'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { useLayout, reconcileLayout, LAYOUTS, type Layout } from '@/lib/layout'
import { cn } from '@/lib/utils'

/* Two buttons, side by side, in the shell header.

   Deliberately not a dropdown. This is a switch people are being asked to test
   and compare, so both states are one click apart and the active one is
   visible without opening anything. `aria-pressed` carries the same fact to a
   screen reader that the filled background carries to the eye — a toggle
   button that only looks pressed is not a toggle button.

   Additive by construction: it is a new file, rendered beside the existing
   theme control, and nothing already in the header moves or restyles. */

const LABEL: Record<Layout, 'shell.layout.classic' | 'shell.layout.bento'> = {
  classic: 'shell.layout.classic',
  bento: 'shell.layout.bento',
}

export function LayoutSwitch() {
  const { layout, setLayout } = useLayout()
  const t = useT()

  /* localStorage gave a correct first paint on this device; the account row is
     the truth across devices. Reconciled once on mount, exactly as the theme
     is, and never written back — this read must not turn into a save. */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{ preference?: { layout?: string } }>(
          '/api/v1/portal/preferences/display',
        )
        if (!cancelled) reconcileLayout(res.preference?.layout)
      } catch {
        /* signed out, or offline: the device's own choice stands */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      role="group"
      aria-label={t('shell.layout.group')}
      className="flex items-center gap-0.5 rounded-[7px] bg-surface-hover/60 p-0.5"
    >
      {LAYOUTS.map((value) => {
        const active = layout === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => setLayout(value)}
            aria-pressed={active}
            title={t(LABEL[value])}
            className={cn(
              'h-8 rounded-[6px] px-2.5 text-[12.5px] transition-colors duration-100',
              active
                ? 'bg-primary font-[550] text-primary-foreground'
                : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
            )}
          >
            {t(LABEL[value])}
          </button>
        )
      })}
    </div>
  )
}

export default LayoutSwitch
