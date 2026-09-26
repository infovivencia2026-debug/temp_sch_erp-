import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ensureCatalogue, readStoredLocale } from '@/lib/i18n'
import './index.css'
import './features/bento/bento-theme.css'
// Stamps html[data-personality] and writes the personalities stylesheet.
import '@/lib/personality'
import { startOutbox } from './lib/outbox'
import { reportScrollToShell } from './lib/shell-scroll'
import { startHaptics } from './lib/haptics'
import { trackKeyboardInset } from './lib/keyboard'
import { clearPersistedQueriesOnSignOut } from './lib/query-persist'

/* iOS Safari pinch-zoom. touch-action on the root covers Android and newer
   iOS; older iOS only listens to its own gesture events. Passive false so
   preventDefault is honoured. */
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false })
}


/* Started before the app renders, not inside it.

   What is in the queue was put there by a previous visit: somebody who typed
   a thing, lost the network and closed the tab. The moment worth sending it
   is the moment the app comes back with a connection, which is here — not
   after a component that happens to care has mounted, since the screen the
   person lands on is usually not the screen they were on when it failed. */
startOutbox()

/* Tells the Android shell where the page's scroller is, so its pull-to-refresh
   only fires at the top. A no-op in every browser: the bridge does not exist
   there. */
reportScrollToShell()

/* A short tap back when a control is pressed. One document-level listener
   rather than a prop on several hundred buttons. */
startHaptics()

/* Publishes --kb, how much of the viewport the on-screen keyboard is covering,
   so the screens that sit on the bottom edge can get out from under it. Here
   rather than in a component because the listener is one per document and the
   value is read from CSS, not from React. */
trackKeyboardInset()

/* The parent's stored answers go the instant a sign-out link is pressed --
   before the navigation, which is the last moment any of this code runs. See
   lib/query-persist.ts for the other two paths. */
clearPersistedQueriesOnSignOut()

/* The application shell, kept on the device.

   Registered after load rather than during it: the worker's install downloads
   about a megabyte, and racing that against the first paint makes the very
   first visit slower to help every later one. The first visit is the one where
   somebody decides whether this is a fast product.

   Guarded on `serviceWorker` existing because it does not on an insecure
   origin, and dev runs on http. Failure is not reported anywhere: the app
   works without it, just not offline, and there is nothing a person reading a
   console message could do. */
/* THE ESCAPE HATCH: /?fresh

   "I don't see the change" is the sentence every deploy ends with when a
   worker, a shell cache and a tab that has been open since Tuesday sit
   between the person and the build that is live on the server. Opening the
   app once with ?fresh on the address removes every service worker, empties
   every cache this origin holds, and reloads the page clean from the network.
   Nothing else is touched: the sign-in cookie stays, the offline outbox
   stays. It is the reset the support desk would otherwise talk somebody
   through one browser menu at a time. */
if (typeof location !== 'undefined' && /[?&]fresh(=|&|$)/.test(location.search)) {
  ;(async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))
      }
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      }
    } catch {
      /* whatever could not be cleared, the reload below still bypasses */
    }
    const clean = new URL(location.href)
    clean.searchParams.delete('fresh')
    location.replace(clean.pathname + (clean.search || '') + clean.hash)
  })()
}

/* Which build this tab is running, readable from the console or the
   element inspector (html[data-build]) when "is it the new one?" has to be
   answered without guessing. The entry chunk's own hashed name is the build. */
try {
  document.documentElement.dataset.build = new URL(import.meta.url).pathname.split('/').pop() ?? ''
} catch {
  /* not a module URL in some old embedder; no stamp, no harm */
}

/* "IS THIS THE NEW ONE?" -- ANSWERED ON THE SCREEN, NOT IN A CONSOLE.

   A tab can outlive several deploys: the worker holds the shell, the network
   fallback serves the old index on a slow connection, and the person is told
   a fix is live while looking at a build from yesterday. Every few minutes,
   and whenever the tab is looked at again, the page asks the server which
   entry it is serving now and compares it with its own. If they differ, a
   thin bar at the top says a new version is ready, and one tap reloads
   clean through /?fresh. Nothing is done without the tap: a reload under a
   half-filled form is worse than an old build for another minute. */
;(() => {
  if (typeof document === 'undefined' || typeof fetch !== 'function') return
  const mine = (() => {
    try { return new URL(import.meta.url).pathname.split('/').pop() ?? '' } catch { return '' }
  })()
  if (!mine) return
  let shown = false
  const show = (theirs: string) => {
    if (shown) return
    shown = true
    const bar = document.createElement('div')
    bar.setAttribute('role', 'status')
    bar.style.cssText =
      'position:fixed;left:0;right:0;top:0;z-index:2147483000;display:flex;gap:12px;align-items:center;' +
      'justify-content:center;padding:10px 16px;background:#111b21;color:#fff;font:600 14px/1.3 system-ui,sans-serif;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.25)'
    bar.innerHTML =
      '<span>A new version of WISEN is ready.</span>' +
      '<button type="button" style="border:0;border-radius:999px;padding:6px 14px;background:#00a884;color:#fff;font:inherit;cursor:pointer">Update now</button>' +
      '<button type="button" aria-label="Later" style="border:0;background:transparent;color:#cfd8dc;font:inherit;cursor:pointer;padding:6px">Later</button>'
    const [update, later] = Array.from(bar.querySelectorAll('button'))
    update.addEventListener('click', () => { location.href = '/?fresh' })
    later.addEventListener('click', () => { bar.remove() })
    bar.dataset.newBuild = theirs
    document.body.appendChild(bar)
  }
  const check = async () => {
    try {
      const res = await fetch('/index.html?probe=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' })
      if (!res.ok) return
      const html = await res.text()
      const m = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
      if (m && m[1] !== mine) show(m[1])
    } catch {
      /* offline or the probe failed: nothing to say */
    }
  }
  window.setTimeout(check, 15_000)
  window.setInterval(check, 5 * 60_000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check() })
})()

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    /* THE FIRST VISIT USED TO BOOT THE APPLICATION TWICE.
     *
     * The worker's `activate` calls `clients.claim()`, so on a first install
     * it takes control of the page that just registered it — and that fires
     * `controllerchange`, and the handler below reloaded. Measured on a cold
     * sign-in: a second document navigation 2,266ms in, re-parsing 498kB of
     * JavaScript and asking /session, /catalog, /tour and /notifications all
     * over again, for nothing. There was no old build to get out of; the
     * worker had only just been installed.
     *
     * `navigator.serviceWorker.controller` is exactly that distinction, read
     * before the registration can change it: null means this page loaded
     * uncontrolled, so a controller arriving is the FIRST one and the page is
     * already running the build that installed it. A controller arriving when
     * there was one before is a different build taking over, which is the case
     * the reload exists for. Every user paid the first one on every install
     * and after every deploy that retired the worker. */
    const hadController = !!navigator.serviceWorker.controller
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      if (!reg) return

      /* A NEW BUILD IS READY, AND NOBODY WAS EVER GOING TO SEE IT.
       *
       * A worker that does not skipWaiting stays in `waiting` until every tab
       * of the old one has gone. In a browser that is a day; in the parent app
       * it is however long before somebody force-stops it, and the WebView
       * restores its page on the way back, so "closing" it often is not. The
       * effect is a deploy that reaches nobody, silently — which was measured
       * on the handset after this shipped: two shell caches, a waiting worker,
       * and the app still running the previous bundle.
       *
       * So it takes over at the one moment with nothing to lose: a page that
       * has just loaded and that nobody has typed into yet. That is precisely
       * the case the blanket skipWaiting gets wrong — it swaps under a tab
       * mid-task — and precisely why the decision belongs here rather than in
       * the worker, which cannot know.
       *
       * The reload is guarded by a flag for the tab, not for the browser: two
       * workers cannot both be waiting on one load, so a second controller
       * change in the same page means something unexpected, and reloading
       * again would be a loop rather than an update. */
      const takeOver = () => reg.waiting?.postMessage({ type: 'erp-take-over' })
      if (reg.waiting) takeOver()
      reg.addEventListener('updatefound', () => {
        reg.installing?.addEventListener('statechange', function () {
          if (this.state === 'installed' && navigator.serviceWorker.controller) takeOver()
        })
      })
      /* THE GUARD WAS FOR THE TAB, AND IT SHOULD HAVE BEEN FOR THE RELOAD.
       *
       * It stored a flag on the first controller change and never cleared it,
       * so a tab took the first new build it saw and then ignored every one
       * after that for as long as it stayed open. On a desk that is a day and
       * a dozen deploys: the update installs, the worker takes over, the
       * controller changes, and this returns. The person keeps working in a
       * build from the morning, and every fix shipped since is invisible to
       * them while being demonstrably live on the server.
       *
       * A timestamp instead. A reload loop is two reloads in the same breath,
       * which ten seconds catches; two deploys ten seconds apart is not a
       * thing that happens, and if it did, taking the second is right. */
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // The first install claiming this page is not a build being replaced.
        // See `hadController` above: this is the whole of that fix.
        if (!hadController) return
        let last = 0
        try {
          last = Number(sessionStorage.getItem('erp.sw.reloaded') ?? 0)
        } catch {
          /* Private mode: no guard, and one reload is still better than
             running a build whose assets the controller has dropped. */
        }
        if (last && Date.now() - last < 10_000) return
        try {
          sessionStorage.setItem('erp.sw.reloaded', String(Date.now()))
        } catch {
          /* As above. */
        }
        window.location.reload()
      })
    }).catch(() => {})
  })
}

/* The stored language's catalogue before the first paint, so a Telugu
   household never sees English flash first. English resolves at once. */
void ensureCatalogue(readStoredLocale()).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
