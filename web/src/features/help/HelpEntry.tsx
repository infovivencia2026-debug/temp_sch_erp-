import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useOpenHelp } from './help-lib'
import { HelpSpotlight } from './Spotlight'
import { AssistBanner } from './Assist'

/* The ways into Help that every screen carries: the "?" key on a computer
   (not while typing), and the Show me ring. Mounted once in the shell. */
export function HelpEverywhere() {
  const openHelp = useOpenHelp()
  const loc = useLocation()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (loc.pathname === '/help') return
      e.preventDefault()
      openHelp()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openHelp, loc.pathname])
  return <><HelpSpotlight /><AssistBanner /></>
}

/** The Help button in the top bar and at the foot of the rail. */
export function HelpButton({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  const t = useT()
  const openHelp = useOpenHelp()
  return (
    <button type="button" onClick={() => openHelp()} aria-label={t('help.eyebrow')} title={`${t('help.eyebrow')} (?)`}
      data-help-anchor="help-button" className={cn(className)}>
      <CircleHelp className={iconClassName} aria-hidden="true" />
    </button>
  )
}
