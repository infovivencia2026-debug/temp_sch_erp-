'use strict'

/* THE SCHOOL'S OWN SITE, IN A WINDOW.

   The same argument as the two phone shells, made for the desk in the office.
   No login of its own, no copy of any screen, no state to fall out of step
   with the server: everything here is the page the browser would have shown,
   so a fix shipped this afternoon reaches every installed copy without
   anybody updating anything, and there is no second implementation of the
   fee screen to keep in step with the first.

   The argument against building it at all is the honest one and is worth
   leaving written down: the portal is already a web application, and Chrome
   and Edge will both install it to the desktop from their own menus. What
   that misses is how a school actually distributes software. A clerk is
   handed a machine by whoever set it up; "open this link, find the three
   dots, choose Install" is a step most offices will not complete, and an
   installer on a pen drive is one they will. It also gets the school off the
   browser's chrome: an address bar in front of a fee ledger is one more place
   for somebody to paste the wrong URL into.

   WHAT A SHELL STILL HAS TO DO ITSELF, because the page cannot:
   say that it is loading before the page has painted anything; tell the
   three failures apart -- no network, the school unreachable, the school
   answering with an error -- and retry by itself when the network returns;
   keep a page that is still readable rather than replacing it with an
   apology; send anything that is not the school to a real browser; remember
   the window and the zoom; and print. Each is here because leaving it out is
   a complaint somebody makes. */

const { app, BrowserWindow, Menu, shell, session, dialog, ipcMain, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

/* The address is compiled in, and only an environment variable may override
   it -- the same decision the tracker made the hard way. A field asking a
   clerk for a server address is a field they can only get wrong, and app data
   outlives the build that asked for it. PORTAL_URL exists so a developer can
   point a build at a laptop without editing the source. */
const PORTAL = process.env.PORTAL_URL || require('../package.json').portal

/* EVERY ADDRESS THE SCHOOL ANSWERS ON, NOT JUST THE ONE WE ASK FOR.

   This was a single host compared against the compiled-in address, and it
   sent the app to a browser the day the site moved. The old name still
   resolves and answers 301 to the new one; a redirect is a navigation, so
   the shell asked "is this the school?", got no because the host had
   changed, and did what it does with a foreign page -- handed it to the
   system browser and left its own window empty. The app looked like a
   shortcut to Chrome.

   So it is a set. The address the build points at, plus every other name
   the school is reachable on: the old one is kept because handsets and
   desktops already in the field have it compiled in, and because it will go
   on redirecting for as long as the box behind it is up. A name that is
   genuinely somebody else's -- a payment gateway, the map's attribution --
   still opens in a real browser, which is the whole point of the check. */
const PORTAL_HOSTS = new Set(
  [new URL(PORTAL).host, ...(require('../package.json').portalHosts || [])].filter(Boolean),
)

/* The page's own ground, from web/src/index.css, so the window does not flash
   white before the first paint and does not flash light behind a dark page.
   The two phone shells carry the same pair of values for the same reason. */
const GROUND = { light: '#F7F8FA', dark: '#0A0A0A' }
const ground = () => (nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light)

const stateFile = () => path.join(app.getPath('userData'), 'window.json')

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  } catch {
    // No file on a first run, and an unreadable one is not worth a dialog.
    return {}
  }
}

function writeState(win) {
  if (!win || win.isDestroyed()) return
  const state = {
    ...(win.isMaximized() || win.isMinimized() ? readState() : win.getNormalBounds()),
    maximised: win.isMaximized(),
    zoom: win.webContents.getZoomLevel(),
  }
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state))
  } catch {
    /* The window's size is not worth failing over. */
  }
}

let win = null

/** True for the school's own pages, and only those. */
const isPortal = (url) => {
  try {
    return PORTAL_HOSTS.has(new URL(url).host)
  } catch {
    return false
  }
}

/* Loading, error and retry all live in one local page rather than three.
   It is shown before the first paint and again whenever a load fails, so the
   window is never an empty rectangle with nothing to say for itself. */
const shellPage = (params) =>
  `file://${path.join(__dirname, 'shell.html')}?${new URLSearchParams(params)}`

function show(state, detail) {
  if (!win || win.isDestroyed()) return
  win.webContents.loadURL(shellPage({ state, detail: detail || '', ground: ground() }))
}

function load() {
  if (!win || win.isDestroyed()) return
  win.webContents.loadURL(PORTAL).catch((error) => {
    /* loadURL rejects on the same failures did-fail-load reports, and an
       unhandled rejection here would be the only trace of a window that
       never filled. */
    if (error && error.code !== 'ERR_ABORTED') console.error('load failed', error.code || error)
  })
}

/* WHY A CODE IS TURNED INTO A SENTENCE HERE.

   Chromium's error codes are the difference between three problems a person
   would act on differently: the wifi is off, the school's server is not
   answering, and the certificate is wrong. Printing "ERR_NAME_NOT_RESOLVED"
   invites a support call; naming the thing to check does not. */
function failure(code, description) {
  switch (code) {
    case -106: // ERR_INTERNET_DISCONNECTED
    case -105: // ERR_NAME_NOT_RESOLVED
      return ['offline', '']
    case -102: // ERR_CONNECTION_REFUSED
    case -118: // ERR_CONNECTION_TIMED_OUT
    case -109: // ERR_ADDRESS_UNREACHABLE
    case -7: //   ERR_TIMED_OUT
      return ['unreachable', '']
    case -200: // ERR_CERT_COMMON_NAME_INVALID
    case -201: // ERR_CERT_DATE_INVALID
    case -202: // ERR_CERT_AUTHORITY_INVALID
      return ['insecure', '']
    default:
      return ['unreachable', description || '']
  }
}

function createWindow() {
  const saved = readState()

  win = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 860,
    x: saved.x,
    y: saved.y,
    minWidth: 480,
    minHeight: 480,
    show: false,
    backgroundColor: ground(),
    title: app.getName(),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      /* The page is a whole web application from the school's own server, and
         it gets none of Node. contextIsolation and sandbox are what keep the
         bridge below a bridge rather than a hole. */
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      /* The site is served over https and asks for nothing over http; a page
         that quietly pulled something insecure is one that can be tampered
         with on a school's shared wifi. */
      allowRunningInsecureContent: false,
    },
  })

  if (saved.maximised) win.maximize()
  if (typeof saved.zoom === 'number') {
    win.webContents.once('did-finish-load', () => win.webContents.setZoomLevel(saved.zoom))
  }

  /* Shown on the first paint rather than on creation, so what a person sees
     first is the loading page rather than a white rectangle the size of the
     screen. */
  win.once('ready-to-show', () => win.show())
  /* SHELL_TRACE=1 prints the window's lifecycle and the page's own console.
     A wrapper is the one place where "it just sits there" has no visible
     cause: the page cannot report a navigation that never started, and the
     window cannot report a page that never painted. This is how the load
     sequencing below was found. */
  if (process.env.SHELL_TRACE) {
    for (const e of ['ready-to-show', 'show', 'close', 'closed', 'unresponsive']) {
      win.on(e, () => console.log('[trace] window', e))
    }
    win.webContents.on('did-finish-load', () => console.log('[trace] loaded', win.webContents.getURL()))
    win.webContents.on('did-fail-load', (ev, c, d, u, m) => console.log('[trace] fail', c, d, u, m))
    win.webContents.on('console-message', (e) => console.log('[console]', e.level, String(e.message).slice(0, 220)))
    app.on('before-quit', () => console.log('[trace] before-quit'))
    app.on('window-all-closed', () => console.log('[trace] window-all-closed'))
  }

  /* THE LOADING PAGE FIRST, AND THEN THE SITE.

     These were two loadURL calls in the same tick, and the second cancels the
     first: the window opened, the menu was there, and the content was a white
     rectangle with neither page in it. A navigation has to be allowed to
     finish before the next one starts, so the portal is asked for once the
     loading page has actually painted -- which is also what makes
     ready-to-show fire against something worth showing. */
  win.webContents.once('did-finish-load', () => load())
  show('loading')

  /* ANYTHING THAT IS NOT THE SCHOOL OPENS IN A REAL BROWSER.

     A payment gateway, the map's attribution, a mailto link: none of them
     belong in a chrome-less window with no address bar, and keeping a foreign
     page inside this frame is also how a wrapper becomes a phishing surface,
     because there is nothing on screen to say which site is which. */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPortal(url)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isPortal(url) || url.startsWith('file://')) return
    event.preventDefault()
    shell.openExternal(url)
  })

  win.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    // Only the page itself. A tile that failed to load is not a reason to
    // replace a working screen, and -3 is the code a navigation we cancelled
    // above reports.
    if (!isMainFrame || code === -3) return
    const [state, detail] = failure(code, description)
    show(state, detail)
  })

  /* The school answering with its own failure page is a deploy in progress or
     a fault, and a raw 502 inside an application reads as the application
     being broken. Say what it is, and offer the retry that will work in a
     minute. */
  win.webContents.on('did-navigate', (event, url, httpResponseCode) => {
    if (isPortal(url) && httpResponseCode >= 500) show('server', String(httpResponseCode))
  })

  /* The renderer is a separate process and the system kills it under memory
     pressure. Left unhandled the window becomes a grey rectangle for a page
     somebody was only reading. */
  win.webContents.on('render-process-gone', (event, details) => {
    if (details.reason === 'clean-exit') return
    load()
  })

  win.webContents.on('page-title-updated', (event) => {
    // The window keeps the product's name. A title bar that changes on every
    // navigation is a browser telling you it is a browser.
    event.preventDefault()
  })

  const remember = () => writeState(win)
  win.on('resize', remember)
  win.on('move', remember)
  win.on('close', remember)
  win.on('closed', () => {
    win = null
  })

  nativeTheme.on('updated', () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(ground())
  })
}

/* ONE COPY, ONE WINDOW.

   A second launch -- from the Start menu, from a file manager, from a link --
   must raise the window that is already open rather than start a second
   application against the same session. */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const link = argv.find((a) => isPortal(a))
    if (link) win.webContents.loadURL(link)
  })

  app.whenReady().then(() => {
    /* Notifications are the one permission this application has a use for:
       the site raises them for a circular or a fee reminder. Everything else
       -- the camera, the microphone, the machine's location -- is refused,
       because a shell around a school's own web pages has no business asking
       for any of it, and a prompt a clerk does not understand is a prompt
       they will grant. A file upload needs no permission: the picker is the
       operating system's own. */
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(permission === 'notifications' || permission === 'fullscreen')
    })

    /* A certificate that does not verify is not a warning to click through:
       on a school's network it is the one signal that something is between
       this window and the server. */
    app.on('certificate-error', (event, contents, url, error, certificate, callback) => {
      callback(false)
    })

    /* Downloads keep the session cookie for free, which is the whole reason a
       receipt opens here at all. What the platform does not do is say where
       the file went, so a clerk who has downloaded a receipt is told, and can
       open the folder. */
    session.defaultSession.on('will-download', (event, item) => {
      item.once('done', (e, state) => {
        if (state !== 'completed' || !win || win.isDestroyed()) return
        const saved = item.getSavePath()
        dialog
          .showMessageBox(win, {
            type: 'none',
            message: path.basename(saved),
            detail: `Saved to ${path.dirname(saved)}`,
            buttons: ['Show in folder', 'Open', 'Close'],
            defaultId: 2,
            cancelId: 2,
            noLink: true,
          })
          .then(({ response }) => {
            if (response === 0) shell.showItemInFolder(saved)
            if (response === 1) shell.openPath(saved)
          })
      })
    })

    /* The retry button, and the automatic one the local page fires when the
       network comes back. */
    ipcMain.on('shell:retry', (event) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return
      win.webContents.once('did-finish-load', () => load())
      show('loading')
    })

    Menu.setApplicationMenu(buildMenu())
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

/* THE MENU IS THE ONLY CHROME.

   Print, zoom and reload are the three things a person loses when a web
   application stops being a browser tab, and each of them is something a
   school office does daily: a receipt, a timetable held at arm's length, a
   screen that has gone stale. Search is deliberately absent -- the site's own
   Ctrl+K searches screens, children and parents, which is the search anybody
   in a school actually wants. */
function buildMenu() {
  const portal = () => win && !win.isDestroyed() && win.webContents

  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Print…',
          accelerator: 'CmdOrCtrl+P',
          click: () => portal() && win.webContents.print({}),
        },
        { type: 'separator' },
        {
          label: 'Search screens and people',
          accelerator: 'CmdOrCtrl+K',
          click: () =>
            portal() &&
            win.webContents.sendInputEvent({
              type: 'keyDown',
              keyCode: 'k',
              modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
            }),
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => portal() && load() },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open in a browser',
          click: () => shell.openExternal(portal() ? win.webContents.getURL() : PORTAL),
        },
        {
          label: `About ${app.getName()}`,
          click: () =>
            win &&
            dialog.showMessageBox(win, {
              type: 'none',
              message: `${app.getName()} ${app.getVersion()}`,
              detail:
                `This window shows ${new URL(PORTAL).host}, the school's own site, so ` +
                `everything in it is as current as the site is.\n\n` +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
              buttons: ['Close'],
              noLink: true,
            }),
        },
      ],
    },
  ])
}
