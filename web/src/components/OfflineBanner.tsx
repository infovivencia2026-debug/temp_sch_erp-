import { useEffect, useRef, useState } from 'react'
import { WifiOff, Wifi } from 'lucide-react'
import { stateOf, subscribe } from '@/lib/outbox'

/* ONE QUIET LINE ABOUT THE CONNECTION.

   Offline: the screens are the saved copy and changes wait on the device,
   with the count. Back online: the waiting changes are being sent, then
   "All sent", then the line goes. navigator.onLine can say online while the
   school's wifi routes nothing, so this is the floor of what the app knows;
   the outbox list shows each change's real state. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const [waiting, setWaiting] = useState(0)
  const [back, setBack] = useState(false)
  const hide = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => subscribe((q) => setWaiting(q.filter((r) => stateOf(r) === 'pending').length)), [])
  useEffect(() => {
    const off = () => { setOnline(false); setBack(false) }
    const on = () => { setOnline(true); setBack(true) }
    window.addEventListener('offline', off)
    window.addEventListener('online', on)
    return () => {
      window.removeEventListener('offline', off)
      window.removeEventListener('online', on)
    }
  }, [])
  // "All sent" stays a moment once the queue is empty, then the line goes.
  useEffect(() => {
    clearTimeout(hide.current)
    if (online && back && waiting === 0) hide.current = setTimeout(() => setBack(false), 3000)
    return () => clearTimeout(hide.current)
  }, [online, back, waiting])

  if (online && !back) return null
  const changes = `${waiting} ${waiting === 1 ? 'change' : 'changes'}`
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connectivity"
      className="flex min-h-[36px] items-center gap-2 border-b bg-muted/60 px-4 py-2 text-[13px] text-muted-foreground"
    >
      {online ? <Wifi className="size-4 shrink-0" aria-hidden="true" /> : <WifiOff className="size-4 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 truncate">
        {!online
          ? <>Offline. Showing saved data{waiting ? <>, <span className="font-medium">{changes} waiting</span></> : null}.</>
          : waiting
            ? <>Back online. Sending {changes}.</>
            : <>Back online. All sent.</>}
      </span>
    </div>
  )
}

export default OfflineBanner
