/* THE CACHED READS BELONG TO WHOEVER WAS SIGNED IN.

   The service worker keeps API responses so a screen somebody has already
   opened still paints with no connection. Those responses are one person's
   register, one family's fee balance, one child's address.

   The staffroom laptop signs in and out all day. Leaving the previous
   teacher's cached answers available to the next person is a data leak that
   would look exactly like a feature — the screen would simply appear to load
   quickly. So the moment the session reports a different person, the data
   cache is thrown away.

   Deliberately on CHANGE, including to nobody, rather than on an explicit
   sign-out call: a session can end without anybody pressing sign out — it
   expires, it is revoked, the tab is restored days later — and a leak that
   only the polite path prevents is not prevented. */

let seen: string | undefined | null = null

export function forgetCachedDataOnUserChange(userID?: string) {
  if (seen === null) {
    seen = userID
    return
  }
  if (seen === userID) return
  seen = userID
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'erp-forget-data' })
  } catch {
    /* No worker, or none controlling this page yet. Nothing is cached in that
       case either, so there is nothing to leak. */
  }
}
