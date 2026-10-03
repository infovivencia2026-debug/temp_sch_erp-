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
  contract: 2,
  setAtTop: () => {},
  setGestureLock: () => {},
  haptic: () => {},
  appLockEnabled: () => false,
  biometricsAvailable: () => false,
  setAppLock: () => {},
  pushToken: () => null,
  print: () => window.print(),
  /* Version 2 (docs/native-shell.md). The main process checks every call
     came from the school's own page (src/bridge.js). */
  storeKey: () => ipcRenderer.sendSync('shell:storeKey'),
  wipe: () => ipcRenderer.send('shell:wipe'),
  setBadge: (n) => ipcRenderer.send('shell:setBadge', Number(n) || 0),
  notify: (title, body, href) => ipcRenderer.send('shell:notify', String(title), String(body), String(href || '')),
  pickFile: (id, kind, accept) => ipcRenderer.send('shell:pickFile', String(id), String(kind), String(accept || '')),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', String(url)),
  download: (id, url, name) => ipcRenderer.send('shell:download', String(id), String(url), String(name || '')),
  downloaded: (url) => ipcRenderer.sendSync('shell:downloaded', String(url)),
  removeDownload: (url) => ipcRenderer.send('shell:removeDownload', String(url)),
  outboxChanged: (json) => ipcRenderer.send('shell:outboxChanged', String(json)),
  school: () => ipcRenderer.sendSync('shell:school'),
  switchSchool: () => ipcRenderer.send('shell:switchSchool'),
  setSchool: (json) => ipcRenderer.send('shell:setSchool', String(json)),
})

/* The local loading/error page's own small API. Kept on a separate name so
   nothing served by the school can reach it. */
contextBridge.exposeInMainWorld('ShellHost', {
  retry: () => ipcRenderer.send('shell:retry'),
})
