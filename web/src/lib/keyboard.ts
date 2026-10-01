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

  const measure = () => {
    const hidden = window.innerHeight - vv.height - vv.offsetTop
    const kb = hidden > window.innerHeight * MIN_KEYBOARD_RATIO ? Math.round(hidden) : 0
    /* Only on change. These events fire per frame while the keyboard animates
       in, and writing an identical value still invalidates style for the
       whole document. */
    if (kb === applied) return
    applied = kb
    root.style.setProperty('--kb', kb + 'px')
  }

  vv.addEventListener('resize', measure)
  /* `scroll` because iOS reports the keyboard by scrolling the visual viewport
     rather than resizing it when the focused field is already near the top. */
  vv.addEventListener('scroll', measure)
  measure()
}
