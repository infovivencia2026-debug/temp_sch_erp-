import { useSyncExternalStore } from 'react'

/* Whether the device says it has a network. A floor, not a promise: a
   captive portal says online and routes nothing. Used to label the actions
   that must never wait on the device (lib/offline-policy.ts). */
function sub(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

export function useOnline(): boolean {
  return useSyncExternalStore(sub, () => navigator.onLine !== false, () => true)
}
