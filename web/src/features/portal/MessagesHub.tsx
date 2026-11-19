import { Suspense, useState, type ComponentType, type LazyExoticComponent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { screen } from '@/lib/screen'
import { PickerMenu } from '@/components/PickerMenu'
import { ScreenSkeleton } from './screen-state'

/* Communication: the two things the family and the school actually use.
   Concerns is a raised issue followed to its reply; "Circulars from school"
   is what the school sent out. Parents here do not message teachers (Yajur,
   2026-11-19), so that line is gone.

   The two are offered as a dropdown under Communication, not a toggle (Yajur,
   2026-11-19): the choice names the screen, and the chosen one is drawn below.
   The choice rides in the query string (?tab=circulars) so a link from a
   notification or the home's "Messages from school" opens the right one. */
type TabKey = 'concerns' | 'circulars'
const TABS: { key: TabKey; label: string; screen: ComponentType | LazyExoticComponent<ComponentType> }[] = [
  { key: 'concerns', label: 'Concerns', screen: screen(() => import('./Concerns')) },
  { key: 'circulars', label: 'Circulars from school', screen: screen(() => import('../comms/Circulars')) },
]

export default function MessagesHub() {
  const location = useLocation()
  const navigate = useNavigate()
  const fromUrl = new URLSearchParams(location.search).get('tab')
  const [fallback, setFallback] = useState<TabKey>((TABS.find((t) => t.key === fromUrl)?.key) ?? 'concerns')
  const active = TABS.find((t) => t.key === fromUrl)?.key ?? fallback
  const Active = (TABS.find((t) => t.key === active) ?? TABS[0]).screen

  const pick = (key: TabKey) => {
    setFallback(key)
    const q = new URLSearchParams(location.search)
    q.set('tab', key)
    navigate({ search: `?${q}` }, { replace: false })
  }

  return (
    <>
      <div className="flex items-center gap-3 px-[var(--page-gutter)] pb-2 pt-4">
        <span className="text-[13px] font-medium text-muted-foreground">Communication</span>
        <PickerMenu
          value={active}
          ariaLabel="Communication"
          align="start"
          onChange={(k) => pick(k as TabKey)}
          options={TABS.map((t) => ({ value: t.key, label: t.label }))}
        />
      </div>
      <Suspense fallback={<ScreenSkeleton />}>
        <div key={active}>
          <Active />
        </div>
      </Suspense>
    </>
  )
}
