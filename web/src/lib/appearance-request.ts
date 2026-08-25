import { useSyncExternalStore } from 'react'

/* "Open the appearance dialog, on this page of it" — asked from anywhere.

   The dialog is mounted once, by the settings menu, which is the only place
   that used to open it. The tab menu now needs it too: right-clicking a Home
   tab offers to add a widget, and adding a widget is a page of that dialog.
   Lifting the dialog to a provider would mean every screen paying for it, and
   passing a callback down would mean the tab strip knowing what a dock is.

   So the request is a value instead. `seq` rather than a boolean, because the
   same request can be made twice in a row — open Widgets, close it, open it
   again — and a boolean that is already true says nothing the second time. */

export type AppearancePage = 'appearance' | 'dock' | 'dashboard'

interface Request {
  page: AppearancePage
  /** Bumped on every request, so a repeat of the same page still registers. */
  seq: number
}

let request: Request = { page: 'appearance', seq: 0 }
const listeners = new Set<() => void>()

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function requestAppearance(page: AppearancePage) {
  request = { page, seq: request.seq + 1 }
  for (const l of listeners) l()
}

export function useAppearanceRequest(): Request {
  return useSyncExternalStore(subscribe, () => request, () => request)
}
