import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { listenForClientErrors } from './lib/diagnostics'
listenForClientErrors()
import App from './App'
import { ensureCatalogue, readStoredLocale } from '@/lib/i18n'
import './index.css'
import './features/bento/bento-theme.css'
// The reserve at the foot of every page, and the phone's floating tab pill.
import './styles/page-foot.css'
// The system colours and the motion kit sit on top of the theme: loaded after
// it so their defaults win at equal specificity, and still under the brand
// colour (inline), the palettes and the contrast settings. See docs/motion-kit.md.
import './styles/color-system.css'
import './styles/motion.css'
// Stamps html[data-personality] and writes the personalities stylesheet.
import '@/lib/personality'
import { startOutbox, subscribe as subscribeOutbox, stateOf } from './lib/outbox'
import { startShell } from './lib/shell'
import { reportScrollToShell } from './lib/shell-scroll'
import { installMotionGuard } from './lib/motion'
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
/* The native shells' events (lib/shell.ts): deep links, shares, the network,
   and a copy of the outbox for their background sender. */
startShell((path) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
})
subscribeOutbox((q) => {
  const waiting = q.filter((r) => stateOf(r) === 'pending')
  try { window.ErpShell?.outboxChanged?.(JSON.stringify(waiting)) } catch { /* older app */ }
})

/* Tells the Android shell where the page's scroller is, so its pull-to-refresh
   only fires at the top. A no-op in every browser: the bridge does not exist
   there. */
reportScrollToShell()

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
      '<span>A new version is ready.</span>' +
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

/* SIGNING OUT ASKS ONCE.

   The door out sits in the header beside the account and theme buttons, and
   in Settings, and a slip of the pointer ended the session -- with a half-typed
   register or a fee half-collected on screen. Every link or form that goes to
   /logout, wherever it is in the product and whichever is added later, is
   caught here, in the capture phase before the browser follows it, and asked
   about once. Drawn in plain DOM so it works before React, and in the app's
   own tokens so it themes with everything else. */
;(() => {
  if (typeof document === 'undefined') return
  let asking = false
  const ask = (go: () => void) => {
    if (asking) return
    asking = true
    /* The question, drawn to the product's own soft-grey sheet: an icon, the
       question, the consequence, and two answers of equal weight. Not the red
       of a destructive button -- signing out destroys nothing, and dressing it
       as deletion teaches people to ignore the colour that means deletion.

       Tokens, not the mock-up's fixed greys, so it follows the theme; the
       greys are the fallbacks, which is what a browser without the tokens
       gets. The one colour that is NOT a token is this button's grey: the
       --foreground token is near-black, and a black slab reads as a warning
       rather than as the way out. A mid-grey sits correctly on the card in
       either theme, which is the whole reason the mock-up chose one.
       Margin rather than flex `gap` between the buttons: the tablets in
       these schools are old enough to lay a gap out as nothing at all. */
    /* THE OWNER'S iOS SIGN-OUT ALERT (2026-10-09), phone and web alike:
       a frosted backdrop, a 275px squircle card, a red circle with the exit
       glyph, "Sign Out" / "Are you sure you want to sign out?", and the
       hairline Cancel | Sign Out footer. Same behaviour as before: Escape
       and a tap outside cancel, Cancel has focus first. */
    const style = document.createElement('style')
    style.textContent = "@keyframes erp-so-in{from{transform:scale(.94);opacity:0}to{transform:scale(1);opacity:1}}@keyframes erp-so-dim{from{opacity:0}to{opacity:1}}.erp-so-back{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.22);-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%);animation:erp-so-dim .2s ease both}.erp-signout-box{width:275px;max-width:100%;background:rgba(255,255,255,.94);-webkit-backdrop-filter:blur(30px);backdrop-filter:blur(30px);border-radius:28px;overflow:hidden;text-align:center;box-shadow:0 14px 40px rgba(0,0,0,.16),0 4px 12px rgba(0,0,0,.08),inset 0 0 0 1px rgba(255,255,255,.7);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text',system-ui,sans-serif;-webkit-font-smoothing:antialiased;animation:erp-so-in .2s cubic-bezier(.16,1,.3,1) both}.erp-so-body{padding:24px 20px 20px;display:flex;flex-direction:column;align-items:center}.erp-so-icon{width:60px;height:60px;border-radius:50%;background:#c95151;display:flex;align-items:center;justify-content:center;margin-bottom:14px;box-shadow:0 0 0 6px rgba(201,81,81,.08),0 4px 12px rgba(201,81,81,.22)}.erp-so-icon svg{width:26px;height:26px;stroke:#fff;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;fill:none}.erp-so-title{margin:0 0 6px;font-size:17px;font-weight:600;color:#111827;letter-spacing:-.2px}.erp-so-desc{margin:0;font-size:13px;line-height:1.35;color:#4b5563;padding:0 4px}.erp-so-actions{display:flex;border-top:.5px solid rgba(0,0,0,.1)}.erp-so-btn{flex:1;border:0;background:transparent;padding:13px 0;font-size:16px;font-family:inherit;cursor:pointer;outline:none;transition:background .15s ease}.erp-so-btn:active{background:rgba(0,0,0,.04)}.erp-so-btn+.erp-so-btn{border-left:.5px solid rgba(0,0,0,.1)}.erp-so-no{font-weight:400;color:#007aff}.erp-so-yes{font-weight:500;color:#e03838}html.dark .erp-signout-box{background:rgba(44,44,46,.94);box-shadow:0 14px 40px rgba(0,0,0,.5),inset 0 0 0 1px rgba(255,255,255,.08)}html.dark .erp-so-title{color:#f5f5f7}html.dark .erp-so-desc{color:#aeaeb2}html.dark .erp-so-actions,html.dark .erp-so-btn+.erp-so-btn{border-color:rgba(255,255,255,.12)}html.dark .erp-so-no{color:#0a84ff}html.dark .erp-so-yes{color:#ff453a}@media (prefers-reduced-motion:reduce){.erp-signout-box,.erp-so-back{animation:none!important}}"
    const back = document.createElement('div')
    back.setAttribute('role', 'presentation')
    back.className = 'erp-so-back'
    const box = document.createElement('div')
    box.className = 'erp-signout-box'
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-labelledby', 'signout-q')
    box.setAttribute('aria-describedby', 'signout-d')
    box.innerHTML =
      '<div class="erp-so-body">' +
      '<div class="erp-so-icon" aria-hidden="true"><svg viewBox="0 0 24 24">' +
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>' +
      '<polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>' +
      '</svg></div>' +
      '<h3 id="signout-q" class="erp-so-title">Sign Out</h3>' +
      '<p id="signout-d" class="erp-so-desc">Are you sure you want to sign out?</p>' +
      '</div>' +
      '<div class="erp-so-actions">' +
      '<button type="button" data-no class="erp-so-btn erp-so-no">Cancel</button>' +
      '<button type="button" data-yes class="erp-so-btn erp-so-yes">Sign Out</button>' +
      '</div>'
    back.appendChild(style)
    back.appendChild(box)
    const close = () => {
      asking = false
      back.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
    }
    back.addEventListener('click', (e) => { if (e.target === back) close() })
    box.querySelector<HTMLButtonElement>('[data-no]')?.addEventListener('click', close)
    /* Straight out (owner, 2026-10-10: "it is full blur when I click Sign Out,
       again I see the page, and then sign out"). The alert does not close
       back onto the page: the screen turns plain with "Signing out…" and
       stays that way until the sign-in page replaces it. */
    box.querySelector<HTMLButtonElement>('[data-yes]')?.addEventListener('click', () => {
      document.removeEventListener('keydown', onKey, true)
      back.style.cssText = 'position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;' +
        'background:hsl(var(--background,0 0% 100%));color:hsl(var(--muted-foreground,220 6% 46%));' +
        "font:15px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
      back.className = ''
      back.textContent = 'Signing out…'
      go()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(back)
    // Focus the safe answer, so Enter on a stray keypress keeps the session.
    box.querySelector<HTMLButtonElement>('[data-no]')?.focus()
  }
  const isLogout = (href: string | null) => {
    if (!href) return false
    try { return new URL(href, location.href).pathname === '/logout' } catch { return false }
  }
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || !isLogout(a.getAttribute('href'))) return
    e.preventDefault()
    e.stopPropagation()
    ask(() => { location.href = a.href })
  }, true)
  document.addEventListener('submit', (e) => {
    const f = e.target as HTMLFormElement | null
    if (!f || !isLogout(f.getAttribute('action'))) return
    if (f.dataset.confirmed === '1') return
    e.preventDefault()
    e.stopPropagation()
    ask(() => { f.dataset.confirmed = '1'; f.submit() })
  }, true)
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

      /* THE PAGE IS ALREADY BROKEN; RELOADING IT IS THE REPAIR.
       *
       * The worker says this when a stylesheet or a chunk from the build this
       * tab is running has gone from the server -- the host answers a missing
       * asset with the app shell, 200 and text/html, which a browser will not
       * apply as CSS and will not execute as script. What the person sees is
       * the product with no styling at all.
       *
       * Waiting does not fix it, and neither does the controllerchange above:
       * the worker may already have taken over. The same ten-second guard, so
       * a page that somehow keeps missing cannot spin. */
      navigator.serviceWorker.addEventListener('message', (ev) => {
        if (ev.data?.type !== 'erp-stale-build') return
        let last = 0
        try {
          last = Number(sessionStorage.getItem('erp.sw.reloaded') ?? 0)
        } catch { /* private mode: no guard */ }
        if (last && Date.now() - last < 10_000) return
        try {
          sessionStorage.setItem('erp.sw.reloaded', String(Date.now()))
        } catch { /* as above */ }
        window.location.reload()
      })
    }).catch(() => {})
  })
}

/* Nothing is cut off part-way: exits for surfaces React unmounts in one frame,
   and an animation interrupted by its opposite carries on from where it was.
   See installMotionGuard in lib/motion.ts. */
installMotionGuard()

/* The motion audit, in development only: window.__motionAudit() reports every
   animation that was cancelled, cut off by an unmount, jumped or replayed.
   The dynamic import keeps it out of the production bundle. */
if (import.meta.env.DEV) {
  void import('./lib/motion-audit').then((m) => m.installMotionAudit())
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
