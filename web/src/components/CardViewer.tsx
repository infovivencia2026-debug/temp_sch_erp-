import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui'

/* One child's report card, and nothing else on the screen.

   It was a panel in the middle of the page: the card is 190 millimetres wide
   because it is a sheet of A4, the panel was whatever was left beside the
   sidebar, and so the one document a family keeps was read by dragging it
   sideways. Nobody checks a report card that way.

   So it takes the whole window, and it is SCALED to fit rather than clipped.
   Scaling is what makes an imported design work: a school's own file sets its
   own widths, and a rule forcing them to 100% would reflow a layout that was
   drawn to fill a page. Shrinking the whole thing keeps the design the school
   approved and puts it on the screen whole.

   Portalled to the body, because :where(.card,.cell):active carries a
   transform and `position: fixed` resolves against any transformed ancestor —
   the same bug that pinned the select menu and the full-screen table to the
   middle of a panel.
*/
export default function CardViewer({
  card,
  onClose,
}: {
  card: { html: string; css?: string; name?: string }
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  /* Measured rather than assumed. 190mm is about 718 CSS pixels, but an
     imported design may be A5, or landscape, or 210mm edge to edge — so the
     sheet is asked how wide it actually is. */
  useEffect(() => {
    const fit = () => {
      const outer = box.current?.clientWidth ?? 0
      const inner = sheet.current?.firstElementChild?.scrollWidth ?? 0
      if (!outer || !inner) return
      // Never enlarged: a card blown up past its own size is a blurry card.
      setScale(Math.min(1, outer / inner))
    }
    fit()
    window.addEventListener('resize', fit)
    // A design that pulls a web font or an image settles a moment after it is
    // inserted, and its width changes when it does.
    const t = window.setTimeout(fit, 250)
    return () => {
      window.removeEventListener('resize', fit)
      window.clearTimeout(t)
    }
  }, [card.html])

  // Escape closes it, which is what anybody who has opened a full-screen
  // anything expects before they look for a button.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  return createPortal(
    <div
      id="rc-viewer"
      className="fixed inset-0 z-[100] flex flex-col bg-background"
      role="dialog"
      aria-label="Report card"
    >
      {/* Printing prints the card, not the screen around it. The rule lives
          here rather than in the global stylesheet because it is only true
          while this is open. */}
      <style>{`
        @media print {
          body > *:not(#rc-viewer) { display: none !important; }
          #rc-viewer { position: static !important; }
          #rc-viewer .rc-chrome { display: none !important; }
          #rc-viewer .rc-scale { transform: none !important; }
          #rc-viewer .rc-scroll { overflow: visible !important; }
        }
      `}</style>
      {card.css && <style>{card.css}</style>}

      <div className="rc-chrome flex items-center justify-between border-b px-4 py-2">
        <span className="text-[14px] font-medium">{card.name ?? 'Report card'}</span>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" aria-hidden />
            Print
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>

      {/* overflow-y only. Sideways scrolling is the thing this exists to
          remove, and a card that has been scaled to fit cannot need it. */}
      <div ref={box} className="rc-scroll flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div
          ref={sheet}
          className="rc-scale mx-auto origin-top"
          style={{ transform: `scale(${scale})`, width: 'fit-content' }}
          dangerouslySetInnerHTML={{ __html: card.html }}
        />
      </div>
    </div>,
    document.body,
  )
}
