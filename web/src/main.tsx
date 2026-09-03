import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './features/bento/bento-theme.css'
// Stamps html[data-personality] and writes the personalities stylesheet.
import '@/lib/personality'
import { startOutbox } from './lib/outbox'
import { reportScrollToShell } from './lib/shell-scroll'
import { startHaptics } from './lib/haptics'

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

/* The application shell, kept on the device.

   Registered after load rather than during it: the worker's install downloads
   about a megabyte, and racing that against the first paint makes the very
   first visit slower to help every later one. The first visit is the one where
   somebody decides whether this is a fast product.

   Guarded on `serviceWorker` existing because it does not on an insecure
   origin, and dev runs on http. Failure is not reported anywhere: the app
   works without it, just not offline, and there is nothing a person reading a
   console message could do. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
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
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (sessionStorage.getItem('erp.sw.reloaded')) return
        try {
          sessionStorage.setItem('erp.sw.reloaded', '1')
        } catch {
          /* Private mode. One reload without the guard is still better than
             running a build whose assets the controller has dropped. */
        }
        window.location.reload()
      })
    }).catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
