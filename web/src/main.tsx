import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './features/bento/bento-theme.css'
import { startOutbox } from './lib/outbox'

/* Started before the app renders, not inside it.

   What is in the queue was put there by a previous visit: somebody who typed
   a thing, lost the network and closed the tab. The moment worth sending it
   is the moment the app comes back with a connection, which is here — not
   after a component that happens to care has mounted, since the screen the
   person lands on is usually not the screen they were on when it failed. */
startOutbox()

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
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
