import { useEffect, useRef } from 'react'
import { AlertCircle, PartyPopper } from 'lucide-react'
import { reducedMotion } from './student-kit'

/** A short confirmation above the tab bar; slides up, then fades after 3 s. */
export function Toast({ text, bad }: { text: string; bad?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current || reducedMotion()) return
    ref.current.animate([{ transform: 'translateY(12px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' })
  }, [])
  return (
    <div ref={ref} role="status" className={`fixed inset-x-4 bottom-[calc(var(--dock-reserve,0px)+16px)] z-50 mx-auto flex max-w-sm items-center gap-2 rounded-2xl px-4 py-3 text-[14px] font-medium shadow-lg ${bad ? 'bg-destructive text-white' : 'bg-foreground text-background'}`}>
      {bad ? <AlertCircle className="h-5 w-5 shrink-0" /> : <PartyPopper className="h-5 w-5 shrink-0" />}
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  )
}
