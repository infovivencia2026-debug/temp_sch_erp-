import { useEffect, useState } from 'react'
import { BentoSettings } from './BentoSettings'
import { useActiveRole } from '@/lib/catalog'

export function BentoMenuBar() {
  const role = useActiveRole()
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const formattedTime = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const formattedDate = time.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <div className="bento-menubar fixed top-0 left-0 right-0 z-50 flex h-8 items-center justify-between px-4 text-[13px] font-medium text-[var(--bento-ink)] bg-[var(--bento-card)] border-b-0 shadow-sm">
      <div className="flex items-center gap-4">
        {/* Abstract "OS" Logo or Title */}
        <div className="flex items-center gap-2 font-bold tracking-wide">
          <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m8 3 4 8 5-5 5 15H2L8 3z" />
          </svg>
          <span>OS</span>
        </div>
        <span className="opacity-80">
          {role?.name || 'Workspace'}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 opacity-90">
          <span>{formattedDate}</span>
          <span>{formattedTime}</span>
        </div>
        <div className="-mr-2 flex items-center">
          <BentoSettings placement="menubar" />
        </div>
      </div>
    </div>
  )
}
