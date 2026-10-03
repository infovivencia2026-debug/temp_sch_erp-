'use strict'

/* THE MAIN-PROCESS HALF OF window.ErpShell (contract: docs/native-shell.md).

   preload.js exposes the calls; each one lands here over IPC. Everything that
   touches the disk, the keychain or the network for the page is in this file,
   and every handler checks that the call came from the school's own page.

   What lives in userData:
     school.json     generic app: the school chosen on /start (its app.json)
     store.key       the offline store's key, sealed by safeStorage
     outbox.json     the page's waiting writes, for sending while it is closed
     offline/        lesson files and videos saved for offline */

const { app, ipcMain, safeStorage, dialog, shell, Notification, session, protocol, net } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const file = (name) => path.join(app.getPath('userData'), name)
const offlineDir = () => path.join(app.getPath('userData'), 'offline')

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) } catch { return fallback }
}
function writeJSON(name, v) {
  try { fs.writeFileSync(file(name), JSON.stringify(v)) } catch { /* disk full: kept in memory only */ }
}

/* ---- the school (generic app) ------------------------------------------ */

function savedSchool() {
  const s = readJSON('school.json', null)
  return s && typeof s.portal_url === 'string' && /^https:\/\//.test(s.portal_url) ? s : null
}

/* ---- the offline store's key -------------------------------------------- */

function storeKey() {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(fs.readFileSync(file('store.key')))
  } catch {
    const key = crypto.randomBytes(32).toString('base64')
    try { fs.writeFileSync(file('store.key'), safeStorage.encryptString(key)) } catch { return null }
    return key
  }
}

/* ---- saved files ---------------------------------------------------------- */

const nameFor = (url) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 32)
function savedPath(url) {
  const p = path.join(offlineDir(), nameFor(url))
  return fs.existsSync(p) ? p : null
}

/* Saved files are served to the page as xulo-file://<hash>, never as file://,
   so the page can show a saved video without being able to read the disk. */
function registerFileProtocol() {
  protocol.handle('xulo-file', (req) => {
    const id = new URL(req.url).host
    if (!/^[0-9a-f]{32}$/.test(id)) return new Response('', { status: 404 })
    return net.fetch(pathToFileURL(path.join(offlineDir(), id)).toString())
  })
}

/* ---- the outbox, sent while the page is closed or hidden ---------------- */

let flushing = false
async function flushOutbox(origin) {
  if (flushing || !origin) return
  flushing = true
  try {
    let rows = readJSON('outbox.json', [])
    while (rows.length) {
      const r = rows[0]
      let res
      try {
        res = await session.defaultSession.fetch(origin + r.path, {
          method: r.method,
          headers: { Accept: 'application/json', 'Idempotency-Key': r.key, ...(r.body ? { 'Content-Type': 'application/json' } : {}) },
          body: r.body,
          credentials: 'include',
        })
      } catch { break }
      if (res.status >= 500) break
      /* Answered. The page will replay the same key and be given this same
         answer, which is how it learns the outcome. */
      rows = rows.slice(1)
      writeJSON('outbox.json', rows)
    }
  } finally {
    flushing = false
  }
}

/* ---- wiring --------------------------------------------------------------- */

function install({ getWin, isPortal, origin, openSchool, startPage, updateBadge }) {
  const fromPortal = (e) => {
    const w = getWin()
    return w && !w.isDestroyed() && e.sender === w.webContents && isPortal(e.senderFrame?.url || w.webContents.getURL())
  }
  const fromStart = (e) => {
    const w = getWin()
    if (!w || e.sender !== w.webContents) return false
    try { return new URL(e.senderFrame?.url || '').pathname === '/start' && isPortal(e.senderFrame.url) } catch { return false }
  }
  const emit = (detail) => {
    const w = getWin()
    /* Run in the page's own world: an event built in the preload's isolated
       world would arrive with its detail stripped. */
    if (w && !w.isDestroyed()) {
      w.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('erp-shell', { detail: ${JSON.stringify(detail)} }))`).catch(() => {})
    }
  }

  registerFileProtocol()

  ipcMain.on('shell:storeKey', (e) => { e.returnValue = fromPortal(e) ? storeKey() : null })
  ipcMain.on('shell:school', (e) => {
    const s = savedSchool()
    e.returnValue = fromPortal(e) && s ? JSON.stringify({ code: s.code || '', name: s.name, host: new URL(s.portal_url).host }) : null
  })
  ipcMain.on('shell:downloaded', (e, url) => {
    e.returnValue = fromPortal(e) && savedPath(String(url)) ? `xulo-file://${nameFor(String(url))}` : null
  })

  ipcMain.on('shell:setSchool', (e, json) => {
    if (!fromStart(e)) return
    try {
      const s = JSON.parse(json)
      if (!/^https:\/\//.test(s.portal_url)) return
      writeJSON('school.json', s)
      openSchool(s)
    } catch { /* not a school */ }
  })
  ipcMain.on('shell:switchSchool', (e) => {
    if (!fromPortal(e)) return
    try { fs.rmSync(file('school.json'), { force: true }) } catch { /* already gone */ }
    startPage()
  })
  ipcMain.on('shell:wipe', (e) => {
    if (!fromPortal(e)) return
    for (const f of ['store.key', 'outbox.json']) fs.rmSync(file(f), { force: true })
    fs.rmSync(offlineDir(), { recursive: true, force: true })
  })
  ipcMain.on('shell:setBadge', (e, n) => {
    if (fromPortal(e)) updateBadge(Math.max(0, Number(n) || 0))
  })
  ipcMain.on('shell:notify', (e, title, body, href) => {
    if (!fromPortal(e) || !Notification.isSupported()) return
    const n = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 400) })
    n.on('click', () => {
      const w = getWin()
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
      if (typeof href === 'string' && href.startsWith('/')) emit({ type: 'deeplink', path: href })
    })
    n.show()
  })
  ipcMain.on('shell:openExternal', (e, url) => {
    if (fromPortal(e) && /^(https?|mailto|tel):/i.test(String(url))) shell.openExternal(String(url))
  })
  ipcMain.on('shell:pickFile', async (e, id, kind, accept) => {
    if (!fromPortal(e)) return
    const w = getWin()
    const ext = String(accept || '').split(',').map((a) => a.trim())
    const filters = ext.some((a) => a.startsWith('image/')) ? [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'webp'] }]
      : ext.includes('application/pdf') ? [{ name: 'PDF', extensions: ['pdf'] }] : []
    const r = await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'], filters })
    const files = r.canceled ? [] : r.filePaths.slice(0, 10).flatMap((p) => {
      const st = fs.statSync(p)
      if (st.size > 20 * 1024 * 1024) return []
      const ext = path.extname(p).slice(1).toLowerCase()
      const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf', mp4: 'video/mp4' }[ext] || 'application/octet-stream'
      return [{ name: path.basename(p), type, data: fs.readFileSync(p).toString('base64') }]
    })
    emit({ type: 'picked', id, files })
  })
  ipcMain.on('shell:download', (e, id, url) => {
    if (!fromPortal(e) || !isPortal(String(url))) return
    fs.mkdirSync(offlineDir(), { recursive: true })
    const target = path.join(offlineDir(), nameFor(String(url)))
    const ses = session.defaultSession
    const onWill = (_ev, item) => {
      if (item.getURL() !== url) return
      ses.off('will-download', onWill)
      item.setSavePath(target)
      item.once('done', (_e2, state) => emit({ type: 'downloaded', id, url, ok: state === 'completed', local: state === 'completed' ? `xulo-file://${nameFor(url)}` : undefined }))
    }
    ses.prependListener('will-download', onWill)
    ses.downloadURL(String(url))
  })
  ipcMain.on('shell:removeDownload', (e, url) => {
    if (!fromPortal(e)) return
    const p = savedPath(String(url))
    if (p) fs.rmSync(p, { force: true })
  })
  ipcMain.on('shell:outboxChanged', (e, json) => {
    if (!fromPortal(e)) return
    try {
      const rows = JSON.parse(json).map((r) => ({ key: r.key, method: r.method, path: r.path, body: r.body }))
        .filter((r) => typeof r.path === 'string' && r.path.startsWith('/api/'))
      writeJSON('outbox.json', rows)
    } catch { /* not ours */ }
  })

  /* Sent from here only while the window is hidden or minimised: when it is
     showing, the page sends its own. */
  setInterval(() => {
    const w = getWin()
    if (!w || w.isDestroyed() || (w.isVisible() && !w.isMinimized())) return
    void flushOutbox(origin())
  }, 60_000)
}

module.exports = { install, savedSchool, flushOutbox }
