/* THE KEYBOARD IS PART OF THE VIEWPORT, AND ONLY ONE ENGINE AGREES.

   A screen that pins something to the bottom edge -- the chat composer, a
   sheet's Save bar -- is written against the viewport, and every engine has a
   different idea of what the viewport is once the keyboard is up:

     Android, in the shell. The activity is `adjustResize`, so the WebView
     itself shrinks and `100dvh` is already right. Nothing to do.

     Android, in a browser or the installed PWA. The keyboard overlays by
     default: the layout viewport keeps its full height and the composer sits
     behind the keys. `interactive-widget=resizes-content` in index.html's
     viewport meta turns that into the Android-shell behaviour.

     iOS, in Safari and in WKWebView, which is the parent app. There is no
     opt-in. The layout viewport NEVER shrinks for the keyboard, so
     `position: fixed; inset: 0` stays the height of the whole screen and the
     bottom of it is underneath the keys. This is the "I cannot reach the box
     I am typing into" report, and it is only fixable from JavaScript.

   So: one listener on visualViewport, which is the only thing that knows, and
   one custom property on the root with how many pixels the keyboard is eating.
   Screens that sit on the bottom edge subtract it:

     bottom: var(--kb, 0px)            the whole surface lifts
     padding-bottom: var(--kb, 0px)    only its last row lifts

   Everything else ignores it and is unchanged, which is why this is a
   variable rather than a class on the body.

   WHY THE ARITHMETIC IS WHAT IT IS. visualViewport.height is what is visible;
   offsetTop is how far the page has been scrolled up out of the way by the
   engine's own attempt to reveal the focused field. What is hidden at the
   bottom is the window's height minus both. On iOS the engine's shift and our
   inset would otherwise double-count and leave a gap the size of the keyboard
   above it.

   WHY THE THRESHOLD. The URL bar collapsing on scroll moves these numbers by
   a few dozen pixels and is not a keyboard; reacting to it would make every
   scroll nudge the composer. Under a quarter of the window is not a keyboard
   on any phone. */

const MIN_KEYBOARD_RATIO = 0.25

let started = false

/* WHO IS TYPING.

   The phone's bottom pill (the student tab bar, the Focus dock) leaves while
   a text field has focus and returns when it is left: styles/page-foot.css
   reads html[data-typing]. Only for a field a finger chose -- a screen that
   focuses its search box on arrival opens no keyboard on a phone, and hiding
   the navigation for it would strand the person on that screen. Moving on
   with the keyboard's Next key keeps the flag; the check on focusout waits a
   tick so the next field has taken focus before it is asked about. */
const TEXT_INPUT = /^(?:text|search|email|tel|url|password|number|date|time|datetime-local|month|week)$/

function typesText(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) return !el.readOnly && !el.disabled && TEXT_INPUT.test(el.type)
  return false
}

function trackTyping() {
  const root = document.documentElement
  let touched = 0
  document.addEventListener('pointerdown', () => { touched = Date.now() }, { capture: true, passive: true })
  document.addEventListener('focusin', (e) => {
    if (!typesText(e.target as Element | null)) return
    if ('typing' in root.dataset || Date.now() - touched < 1000) root.dataset.typing = ''
  })
  document.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (!typesText(document.activeElement)) delete root.dataset.typing
    }, 60)
  })
}

export function trackKeyboardInset() {
  if (started) return
  started = true
  trackTyping()

  const vv = window.visualViewport
  const root = document.documentElement

  /* No visualViewport is an engine old enough that it also does not overlay
     the keyboard -- it resizes the window instead, the way Android does, and
     the layout is already right. Leaving --kb unset means every `var(--kb,
     0px)` reads 0px and nothing on any screen moves. */
  if (!vv) return

  let applied = -1
  let appliedH = -1
  let appliedT = -1

  const measure = () => {
    const hidden = window.innerHeight - vv.height - vv.offsetTop
    const kb = hidden > window.innerHeight * MIN_KEYBOARD_RATIO ? Math.round(hidden) : 0
    /* Only on change. These events fire per frame while the keyboard animates
       in, and writing an identical value still invalidates style for the
       whole document. */
    if (kb !== applied) {
      applied = kb
      root.style.setProperty('--kb', kb + 'px')
    }
    /* --vvh / --vv-top: the visible rectangle itself, for the phone's
       full-screen layers (.vv-screen-phone in index.css). On iOS the keyboard
       shrinks only the visual viewport and may scroll it by offsetTop; a
       layer sized by inset-0 or 100dvh keeps the whole screen's height and
       whatever is underneath shows between its composer and the keys. Under a
       pinch zoom the numbers describe the zoomed window, so the layer keeps
       the full screen then. */
    const zoomed = vv.scale > 1.01
    const h = zoomed ? window.innerHeight : Math.round(vv.height)
    const t = zoomed ? 0 : Math.max(0, Math.round(vv.offsetTop))
    if (h !== appliedH) { appliedH = h; root.style.setProperty('--vvh', h + 'px') }
    if (t !== appliedT) { appliedT = t; root.style.setProperty('--vv-top', t + 'px') }
  }

  /* A readout of the numbers iOS gives, for diagnosing the keyboard on a
     real phone (owner, 2026-10-26). Shown only after opening any page with
     ?vvdebug=1 (kept for the tab); ?vvdebug=0 hides it. */
  try {
    const q = new URLSearchParams(location.search).get('vvdebug')
    if (q === '1') sessionStorage.setItem('vvdebug', '1')
    if (q === '0') sessionStorage.removeItem('vvdebug')
  } catch { /* private mode */ }
  let dbg: HTMLDivElement | null = null
  const debugOn = () => { try { return sessionStorage.getItem('vvdebug') === '1' } catch { return false } }
  const show = () => {
    if (!debugOn()) return
    if (!dbg) {
      dbg = document.createElement('div')
      dbg.style.cssText = 'position:fixed;left:4px;top:4px;z-index:2147483647;background:rgba(0,0,0,.8);color:#fff;font:11px/1.3 monospace;padding:4px 6px;border-radius:6px;pointer-events:none;white-space:pre'
      document.body.appendChild(dbg)
    }
    const layer = document.querySelector('.vv-screen-phone')?.getBoundingClientRect()
    const field = document.activeElement?.getBoundingClientRect()
    dbg.textContent = [
      'innerH ' + window.innerHeight + '  screenH ' + screen.height,
      'vv.h ' + Math.round(vv.height) + '  vv.top ' + Math.round(vv.offsetTop) + '  scale ' + vv.scale.toFixed(2),
      'scrollY ' + Math.round(window.scrollY) + '  docH ' + document.documentElement.clientHeight,
      '--vvh ' + root.style.getPropertyValue('--vvh') + '  --vv-top ' + root.style.getPropertyValue('--vv-top') + '  --kb ' + root.style.getPropertyValue('--kb'),
      'layer ' + (layer ? Math.round(layer.top) + '..' + Math.round(layer.bottom) : 'none'),
      'focused ' + (field && document.activeElement !== document.body ? Math.round(field.top) + '..' + Math.round(field.bottom) : 'none'),
    ].join(String.fromCharCode(10))
  }
  const measureAndShow = () => { measure(); show() }
  vv.addEventListener('resize', show)
  vv.addEventListener('scroll', show)
  window.setInterval(() => { if (debugOn()) measureAndShow() }, 250)
  vv.addEventListener('resize', measure)
  /* iOS Safari (26, floating address bar) settles the visible area after the
     keyboard finishes moving and does not always fire a last resize, so a
     layer kept the shorter height with a grey band above the keys (owner,
     2026-10-26). Measure again every frame for a second after a field gains
     or loses focus, and on a window resize; measure() writes only changes. */
  let settleUntil = 0
  const settle = () => {
    const wasIdle = settleUntil < performance.now()
    settleUntil = performance.now() + 1200
    if (!wasIdle) return
    const tick = () => { measure(); if (performance.now() < settleUntil) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }
  document.addEventListener('focusin', settle)
  document.addEventListener('focusout', settle)
  window.addEventListener('resize', settle)
  /* `scroll` because iOS reports the keyboard by scrolling the visual viewport
     rather than resizing it when the focused field is already near the top. */
  vv.addEventListener('scroll', measure)
  measure()
}

/* ONE LOCK FOR THE PAGE UNDER A FULL-SCREEN LAYER.

   Counted, so a sheet closed over a conversation does not unlock the page
   while the conversation is still up. html as well as body: iOS scrolls the
   root, and with only body locked it could still slide the page (and the
   list on it) into view under a layer. */
let locks = 0
export function lockPageScroll(): () => void {
  const html = document.documentElement
  if (locks++ === 0) html.dataset.pageLocked = ''
  let released = false
  return () => {
    if (released) return
    released = true
    if (--locks === 0) delete html.dataset.pageLocked
  }
}
