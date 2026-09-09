'use strict'

/* THE BRIDGE THE SITE ALREADY SPEAKS, ANSWERED HONESTLY.

   web/src/lib/shell-scroll.ts declares window.ErpShell and both phone shells
   implement it. Every method is optional there, so a desktop could simply not
   provide the object -- but then `haptic` being absent sends the site down
   the navigator.vibrate path, and the app-lock row has to infer a desktop
   from two missing functions rather than being told.

   So the bridge is here and it answers what is true of a desk: there is no
   pull-to-refresh to be at the top of, nothing to vibrate, no fingerprint
   reader, and no push token. `platform` is the one addition, so a future
   screen can say "on this machine" without guessing from what is missing. */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ErpShell', {
  platform: 'desktop',
  // The page reports its scroller for the phone's pull-to-refresh. A window
  // has a scrollbar and a mouse wheel, so this is nothing here.
  setAtTop: () => {},
  setGestureLock: () => {},
  // No motor, and no fingerprint reader worth trusting a fee ledger to.
  haptic: () => {},
  appLockEnabled: () => false,
  biometricsAvailable: () => false,
  setAppLock: () => {},
  pushToken: () => null,
})

/* The local loading/error page's own small API. Kept on a separate name so
   nothing served by the school can reach it. */
contextBridge.exposeInMainWorld('ShellHost', {
  retry: () => ipcRenderer.send('shell:retry'),
})
