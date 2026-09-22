import { useEffect } from 'react'

/* Telling the server which screen this session is on.

   One small POST per navigation, carrying the feature key and nothing else.
   It feeds session_screens, which is what lets a principal see that a login
   opened Payroll at 9pm -- see internal/api/session_activity.go.

   Sent with fetch directly rather than through api.post: that wrapper mints
   an idempotency key and queues writes for replay when offline, and a
   "you were on this screen" note is not worth replaying tomorrow. keepalive
   lets it complete when the tab is closing. Every failure is ignored. */
export function useScreenBeacon(screen: string | undefined) {
  useEffect(() => {
    if (!screen) return
    try {
      void fetch('/api/v1/session/activity', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screen }),
      }).catch(() => undefined)
    } catch {
      /* an old browser without fetch, or one that refuses keepalive: nothing to do */
    }
  }, [screen])
}
