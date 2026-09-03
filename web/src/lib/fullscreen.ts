import { useCallback, useEffect, useState } from 'react'

/* FULL SCREEN, AND WHY THE BUTTON THAT ASKED FOR IT DID NOTHING ON A PHONE.

   ─────────────────────────────────────────────────────────────────────────
   WHAT WAS MEASURED, ON THE HANDSET, RATHER THAN REASONED ABOUT.

   Three surfaces were driven over the DevTools protocol on a real Samsung
   SM-S911B running Android 16, not emulated and not guessed at, because every
   one of the four things that can break a fullscreen request breaks it
   silently and none of them are visible in the source.

   1. CHROME 151 ON ANDROID, the browser the product is judged in.

        document.fullscreenEnabled            true
        documentElement.requestFullscreen     function
        the promise, from a trusted click     RESOLVED
        document.fullscreenElement after      <html>

      So the API is not the problem here. Full screen genuinely works in mobile
      Chrome, and it is worth having: with the browser's own chrome showing,
      innerHeight measured 725 against a screen height of 832. That is 107px,
      thirteen per cent of the glass, spent on a URL bar the reader did not ask
      for, on a dashboard that is a fixed non-scrolling board where the loss
      comes straight out of the cards.

   2. THE PARENT ANDROID APP, which is a WebView on this same origin and
      therefore runs this same code.

        userAgent      ...SM-S911B Build/BP4A.251205.006; wv) ... Version/4.0
        fullscreenEnabled                     FALSE
        documentElement.requestFullscreen     function
        innerHeight / screen.height           782 / 832

      This is the trap, and it is the reason a control can look correct and be
      a lie. `requestFullscreen` is still a function in a WebView -- a feature
      test for the method passes -- but the document is not ALLOWED to go
      fullscreen, so the promise rejects and rejects rather than throws, which
      is a failure with no stack, no console line and no visible effect. A
      button wired straight to it is a no-op that reports success by saying
      nothing. The app is also already full bleed: 782 of 832, the missing 50
      being the status bar. There is nothing to win there and nothing to offer.

   3. iOS SAFARI is the case that cannot be fixed by fixing the call. Safari
      has never implemented Element.requestFullscreen for arbitrary elements;
      only a <video> can go fullscreen. `document.documentElement`'s method is
      simply absent, so the old code -- which called `.catch()` on the result
      of calling it -- threw a TypeError inside the click handler before it
      ever reached a catch, and the handler died there. On an iPhone the
      control was not merely ineffective: it was broken, and it took the line
      after it with it.

   ─────────────────────────────────────────────────────────────────────────
   THE ONE GATE, AND WHY IT IS `fullscreenEnabled` AND NOT A FEATURE TEST.

   All three cases above are separated by one boolean that the browser
   maintains for exactly this purpose. `document.fullscreenEnabled` is true in
   mobile Chrome, false in the WebView, and absent in Safari. It answers "would
   a request be honoured", which is the question actually being asked, where
   `typeof requestFullscreen === 'function'` answers "does the name exist" and
   gets the WebView wrong. Nothing here tests for the method alone.

   The user agent is still consulted, but only to recognise the app shell, and
   only as a second opinion. The shell sets no custom user agent and installs
   no JavaScript interface, so the only thing that distinguishes it from the
   browser is the `wv` token Android's WebView puts in the product comment --
   confirmed above on the real handset. Chrome's own reduced user agent on
   Android contains no such token and cannot grow one, so this cannot
   false-positive on the browser. `(display-mode: browser)` is NOT usable for
   this: it measured true inside the app as well, because a WebView is not an
   installed web app and does not claim to be. */

/** Does the `wv` token Android's WebView writes into its product comment
    appear in this user agent. True inside the parent app, false in Chrome. */
export function isAndroidWebView(): boolean {
  if (typeof navigator === 'undefined') return false
  return /;\s*wv[;)]/.test(navigator.userAgent)
}

/** Is this document actually permitted to go full screen. See the note above
    for why this and not a test for the method. */
export function fullScreenAllowed(): boolean {
  if (typeof document === 'undefined') return false
  return document.fullscreenEnabled === true && !isAndroidWebView()
}

/** Is the page already running without browser chrome, because somebody
    installed it to their home screen. There is nothing to offer such a
    reader: an installed web app has no URL bar to hide. */
function isInstalledApp(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches
}

/** A finger rather than a mouse. Both halves matter: a touchscreen laptop
    answers maxTouchPoints without being a phone, and a coarse pointer alone
    is claimed by some desktop remote-desktop clients. */
function isTouch(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0
}

/* Entering and leaving, with the two rules a fullscreen call has that no other
   DOM call has.

   THE GESTURE. `requestFullscreen` is only honoured inside a trusted user
   gesture, and the activation is spent by the first `await` or `.then` in the
   handler. So this is called straight out of onClick and nothing is awaited
   before it. Anything that has to happen afterwards -- closing a dialog,
   leaving a page -- happens in the promise's callbacks, after the request has
   been made, never before it.

   THE REJECTION. It rejects, it does not throw, so an unhandled failure is
   indistinguishable from nothing happening. Both branches are handled and the
   state is read back from the document rather than assumed, because the two
   can disagree: Escape, F11, the Android back gesture and the browser's own
   swipe-down all leave full screen without telling the control that asked. */

export interface FullScreen {
  /** Whether a request would be honoured at all. False in the app shell, on
      iOS, and anywhere else the document is not permitted. */
  supported: boolean
  /** Whether the document is full screen right now, read from the document. */
  active: boolean
  /** Call from a click handler, and only from a click handler. Resolves true
      if the browser honoured it. */
  enter: () => Promise<boolean>
  exit: () => void
}

export function useFullScreen(): FullScreen {
  const [supported] = useState(fullScreenAllowed)
  const [active, setActive] = useState(
    () => typeof document !== 'undefined' && !!document.fullscreenElement,
  )

  useEffect(() => {
    const onChange = () => setActive(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const enter = useCallback(() => {
    if (!fullScreenAllowed()) return Promise.resolve(false)
    /* documentElement and not a nested node. A request on an element inside a
       transformed or fixed ancestor is laid out against that ancestor's
       containing block rather than the viewport, which is how a "full screen"
       panel ends up occupying the same rectangle it already had. The root has
       no ancestor and no transform, so it cannot suffer that. */
    try {
      return document.documentElement.requestFullscreen()
        .then(() => true, () => false)
    } catch {
      // Safari, where the method is absent and calling it throws before any
      // promise exists to reject.
      return Promise.resolve(false)
    }
  }, [])

  const exit = useCallback(() => {
    if (typeof document === 'undefined' || !document.fullscreenElement) return
    try {
      void document.exitFullscreen().catch(() => {})
    } catch { /* same absent-method case as above */ }
  }, [])

  return { supported, active, enter, exit }
}

/* THE INVITATION, AND THE RULE THAT IT IS ASKED ONCE.

   A prompt that reappears is a prompt that gets dismissed reflexively, and the
   thirteen per cent it is offering is not worth being nagged for. So the
   dismissal is remembered on the device, under `erp.fullscreen.invite`,
   alongside the other device-scoped keys this product already writes there --
   `erp.layout`, `erp.theme`, `erp.density`. It is device scope and not account
   scope on purpose: whether a URL bar is in the way is a fact about the
   handset in somebody's hand, not about who is signed in on it.

   Entering counts as an answer too. Somebody who took the offer has been shown
   what full screen looks like and knows where the control is; asking again
   after they leave it would be arguing with them.

   localStorage can throw rather than return null -- a private window, a
   browser set to block site data -- so every read and write is guarded and a
   failure reads as "not yet dismissed". The cost of getting that wrong is one
   extra card the reader can dismiss, which is the cheaper of the two errors. */

const DISMISSED_KEY = 'erp.fullscreen.invite'

function alreadyAnswered(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === 'dismissed'
  } catch {
    return false
  }
}

function remember() {
  try {
    localStorage.setItem(DISMISSED_KEY, 'dismissed')
  } catch { /* nothing to do: the invite simply reappears next time */ }
}

export interface FullScreenInvite {
  /** Show the card. False on a desktop, in the app shell, on iOS, inside an
      installed web app, while already full screen, and after any answer. */
  show: boolean
  accept: () => void
  dismiss: () => void
}

export function useFullScreenInvite(): FullScreenInvite {
  const { supported, active, enter } = useFullScreen()
  const [answered, setAnswered] = useState(true)

  /* Read after mount rather than in the initial state. The initial state is
     also the server snapshot, and a card that renders on the first paint and
     vanishes on the second is worse than one that arrives a frame late. */
  useEffect(() => { setAnswered(alreadyAnswered()) }, [])

  const dismiss = useCallback(() => {
    remember()
    setAnswered(true)
  }, [])

  const accept = useCallback(() => {
    // The request first, with nothing awaited in front of it, or the gesture
    // is gone by the time it is made. The bookkeeping follows in the callback.
    void enter().then(() => { remember(); setAnswered(true) })
  }, [enter])

  return {
    show: supported && !active && !answered && isTouch() && !isInstalledApp(),
    accept,
    dismiss,
  }
}
