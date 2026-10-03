import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReduceMotion } from '@/features/bento/bento-kit'

/* "SHOW ME": go to a screen and ring the control a help article is about.

   A control that help can point at carries data-help-anchor="<name>" (and,
   optionally, data-help-label for what to call it). showMe() puts a request
   on the window; this component, mounted once in the shell, waits up to four
   seconds for the control to appear on the new screen, scrolls it into view
   and draws a ring round it with one line under it. Any press, Escape or six
   seconds ends it. Nothing is clicked for the person. */

const EVENT = 'erp:help-spotlight'

export function showMe(anchor: string, caption: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { anchor, caption } }))
}

interface Ring { top: number; left: number; width: number; height: number; caption: string }

export function HelpSpotlight() {
  const [ring, setRing] = useState<Ring | null>(null)
  const still = useReduceMotion()
  useEffect(() => {
    let timer = 0, poll = 0
    const end = () => { setRing(null); window.clearTimeout(timer); window.clearInterval(poll) }
    const onAsk = (e: Event) => {
      const { anchor, caption } = (e as CustomEvent<{ anchor: string; caption: string }>).detail
      end()
      const started = Date.now()
      poll = window.setInterval(() => {
        const all = [...document.querySelectorAll<HTMLElement>(`[data-help-anchor="${CSS.escape(anchor)}"]`)]
        const el = all.find((x) => x.getClientRects().length > 0)
        if (!el) { if (Date.now() - started > 4000) window.clearInterval(poll); return }
        window.clearInterval(poll)
        el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
        window.setTimeout(() => {
          const r = el.getBoundingClientRect()
          setRing({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12, caption: el.dataset.helpLabel || caption })
          timer = window.setTimeout(end, 6000)
        }, still ? 0 : 350)
      }, 120)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') end() }
    window.addEventListener(EVENT, onAsk)
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', end, true)
    return () => { end(); window.removeEventListener(EVENT, onAsk); window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', end, true) }
  }, [still])
  if (!ring) return null
  const below = ring.top + ring.height + 60 < window.innerHeight
  return createPortal(
    <div aria-live="polite" className="pointer-events-none fixed inset-0 z-[130]">
      <div
        className="help-ring absolute rounded-[12px]"
        style={{ top: ring.top, left: ring.left, width: ring.width, height: ring.height,
          boxShadow: '0 0 0 3px hsl(var(--primary)), 0 0 0 9999px rgb(0 0 0 / 0.35)' }}
      />
      <p
        className="absolute max-w-[min(320px,calc(100vw-32px))] rounded-md bg-popover px-3 py-2 text-[14px] font-medium text-popover-foreground shadow-lg"
        style={{ left: Math.max(16, Math.min(ring.left, window.innerWidth - 336)), top: below ? ring.top + ring.height + 10 : Math.max(16, ring.top - 50) }}
      >
        {ring.caption}
      </p>
    </div>,
    document.body,
  )
}
