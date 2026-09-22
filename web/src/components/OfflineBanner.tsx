import { useEffect, useState } from 'react'
import { WifiOff, Wifi } from 'lucide-react'

/* ONE LINE THAT SAYS THE SCREEN IS YESTERDAY'S.

   The worker and the query cache keep the app working with no signal, and
   the parent screens say so with a "last seen" line. The staff screens said
   nothing: a teacher looking at a register served from the cache had no way
   to tell it from this morning's, and a clerk who saved a receipt with no
   connection had no sign it had gone to the outbox rather than to the server.

   So one banner, above every screen in both layouts, driven by the browser's
   own connectivity events: offline, it says what is being shown and what
   happens to anything typed; back online, it says so for a moment and goes.
   navigator.onLine is a lie in one direction only -- it can say online while
   the school's wifi has no route out -- so this is the floor of what the app
   knows, not the ceiling; a stale read still carries its own X-From-Cache
   mark for the screens that read it. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false)
  const [justBack, setJustBack] = useState(false)

  useEffect(() => {
    const off = () => { setOnline(false); setJustBack(false) }
    const on = () => {
      setOnline(true)
      setJustBack(true)
      const t = setTimeout(() => setJustBack(false), 3500)
      return () => clearTimeout(t)
    }
    window.addEventListener('offline', off)
    window.addEventListener('online', on)
    return () => {
      window.removeEventListener('offline', off)
      window.removeEventListener('online', on)
    }
  }, [])

  if (online && !justBack) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        online
          ? 'flex items-center gap-2 border-b border-success/30 bg-success/10 px-4 py-2 text-[13px] text-success'
          : 'flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[13px] text-warning'
      }
    >
      {online ? (
        <>
          <Wifi className="size-4 shrink-0" aria-hidden="true" />
          <span>Back online. Anything saved while offline is being sent now.</span>
        </>
      ) : (
        <>
          <WifiOff className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <span className="font-medium">No connection.</span>{' '}
            Showing what was saved on this device; anything you save will be sent when you are back online.
          </span>
        </>
      )}
    </div>
  )
}

export default OfflineBanner
