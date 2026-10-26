/* The sign-in page, exactly as the Go server renders it
   (internal/templates/login.gohtml with its partials), captured from the live
   site and turned into slots. The stylesheet it names, /static/app.css, is
   served by Pages from web/public/static. Per-school branding by custom
   domain or /<country>/<slug> fills the slots below from the school's row
   (Brand); with no school it is the XULO page. */
const PAGE = "<!doctype html>\n<html lang=\"@@LANG@@\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>@@T_SIGNIN@@ · @@NAME@@</title>\n<link rel=\"stylesheet\" href=\"/static/app.css?v=7a164c6107\">@@STYLE@@\n<script>\n  try {\n    var t = localStorage.getItem('theme');\n    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);\n  } catch (e) {}\n</script>\n</head>\n<body class=\"auth\">\n  <div class=\"auth-top\"><button type=\"button\" id=\"theme-toggle\" class=\"theme-toggle\"\n        aria-label=\"Switch between light and dark\" title=\"Switch appearance\">\n  <svg class=\"icon-moon\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"\n       stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n    <path d=\"M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z\"/>\n  </svg>\n  <svg class=\"icon-sun\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"\n       stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n    <circle cx=\"12\" cy=\"12\" r=\"4\"/>\n    <path d=\"M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41\"/>\n  </svg>\n</button></div>\n  <div class=\"auth-split@@SPLITCLASS@@\">\n    \n    <aside class=\"auth-brand\">\n      <div class=\"mesh\" aria-hidden=\"true\">\n        <span class=\"blob blob-1\"></span>\n        <span class=\"blob blob-2\"></span>\n        <span class=\"blob blob-3\"></span>\n        <span class=\"blob blob-4\"></span>\n        <span class=\"blob blob-5\"></span>\n      </div>\n      <div class=\"auth-brand-content\">\n        @@MARK@@\n        <div class=\"auth-brand-text\">\n          \n          @@COPY@@\n        </div>\n      </div>\n    </aside>\n    <main class=\"card\">\n      \n      <h1>@@H1@@</h1>\n      <p class=\"lede\">@@LEDE@@</p>@@ERROR@@\n      \n      \n      \n      @@TABS@@\n      <form method=\"post\" action=\"@@ACTION@@\" autocomplete=\"on\" id=\"login-form\">\n        <input type=\"hidden\" name=\"csrf_token\" value=\"@@CSRF@@\">\n        <input type=\"hidden\" name=\"next\" value=\"@@NEXT@@\">\n        <label for=\"identifier\" id=\"identifier-label\">@@T_IDENT@@</label>\n        \n        <input id=\"identifier\" type=\"text\" name=\"identifier\" required autocomplete=\"username\"\n               autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\" enterkeyhint=\"next\"\n               value=\"@@IDENT@@\"@@IDATTR@@>@@IDHINT@@\n        <label for=\"password\">@@T_PASSWORD@@</label>\n        <input id=\"password\" type=\"password\" name=\"password\" required autocomplete=\"current-password\"\n               enterkeyhint=\"go\"@@PWATTR@@>\n        <p class=\"field-hint\" id=\"caps-hint\" hidden aria-live=\"polite\">@@T_CAPS@@</p>\n        <button type=\"submit\" id=\"login-submit\" data-pending-label=\"@@T_PENDING@@\">@@T_SIGNIN@@</button>\n      </form>\n      <p class=\"fineprint\"><a href=\"/forgot\">@@T_FORGOT@@</a> · <a href=\"/privacy\">@@T_PRIVACY@@</a>@@SWITCH@@</p>@@SUPPORT@@\n      \n    </main>\n  </div>\n<script>\n(function () {\n  var btn = document.getElementById('theme-toggle');\n  if (!btn) return;\n  var root = document.documentElement;\n  btn.addEventListener('click', function () {\n    var now = root.getAttribute('data-theme') ||\n      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');\n    var next = now === 'dark' ? 'light' : 'dark';\n    root.setAttribute('data-theme', next);\n    try { localStorage.setItem('theme', next); } catch (e) {}\n  });\n})();\n</script>\n<script>\n\n\n(function () {\n  var fields = document.querySelectorAll('input[type=\"password\"]')\n  Array.prototype.forEach.call(fields, function (input) {\n    var wrap = document.createElement('span')\n    wrap.className = 'pw'\n    input.parentNode.insertBefore(wrap, input)\n    wrap.appendChild(input)\n\n    var btn = document.createElement('button')\n    btn.type = 'button'\n    btn.className = 'pw-eye'\n    btn.setAttribute('aria-label', '@@T_SHOW@@')\n    btn.setAttribute('aria-pressed', 'false')\n    btn.title = '@@T_SHOW@@'\n    btn.innerHTML =\n      '<svg class=\"icon-on\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"' +\n      ' stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">' +\n      '<path d=\"M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></svg>' +\n      '<svg class=\"icon-off\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"' +\n      ' stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">' +\n      '<path d=\"M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94\"/>' +\n      '<path d=\"M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19\"/>' +\n      '<path d=\"M14.12 14.12a3 3 0 1 1-4.24-4.24\"/><path d=\"M1 1l22 22\"/></svg>'\n    wrap.appendChild(btn)\n\n    btn.addEventListener('click', function () {\n      var shown = input.type === 'text'\n      input.type = shown ? 'password' : 'text'\n      wrap.setAttribute('data-shown', shown ? 'no' : 'yes')\n      btn.setAttribute('aria-pressed', shown ? 'false' : 'true')\n      var label = shown ? '@@T_SHOW@@' : '@@T_HIDE@@'\n      btn.setAttribute('aria-label', label)\n      btn.title = label\n      \n      input.focus()\n      var n = input.value.length\n      try { input.setSelectionRange(n, n) } catch (e) {   }\n    })\n\n    \n    \n    if (input.form) {\n      input.form.addEventListener('submit', function () {\n        input.type = 'password'\n        wrap.setAttribute('data-shown', 'no')\n      })\n    }\n  })\n})()\n</script>\n<script>\n(function () {\n  var pw = document.getElementById('password')\n  var hint = document.getElementById('caps-hint')\n  if (pw && hint) {\n    var show = function (e) {\n      var on = e.getModifierState && e.getModifierState('CapsLock')\n      hint.hidden = !on\n    }\n    pw.addEventListener('keydown', show)\n    pw.addEventListener('keyup', show)\n    pw.addEventListener('blur', function () { hint.hidden = true })\n  }\n  var form = document.getElementById('login-form')\n  var btn = document.getElementById('login-submit')\n  if (form && btn) {\n    form.addEventListener('submit', function () {\n      if (btn.disabled) return\n      btn.disabled = true\n      btn.setAttribute('aria-busy', 'true')\n      btn.textContent = btn.getAttribute('data-pending-label') || btn.textContent\n    })\n    \n    window.addEventListener('pageshow', function () {\n      btn.disabled = false\n      btn.removeAttribute('aria-busy')\n      btn.textContent = '@@T_SIGNIN@@'\n    })\n  }\n})()\n</script>@@SCRIPTS@@\n</body>\n</html>"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' }[c]!))

/** A school's own look on its sign-in page. Colours are checked hex, set by the seller. */
export interface Brand {
  name: string
  action: string
  logoUrl?: string | null
  /** Sign-in pictures, public URLs in order: they fill the brand panel and cross-fade. */
  slides?: string[]
  primary?: string | null
  accent?: string | null
  eyebrow?: string | null
  headline?: string | null
  message?: string | null
  supportEmail?: string | null
  supportPhone?: string | null
}

const HEX = /^#[0-9a-fA-F]{6}$/
const hex = (v: string | null | undefined) => (v && HEX.test(v) ? v : null)

/* White text needs 4.5:1 on the selected-tab fill. Darken the school's colour
   toward black until it gets there, so a pale brand still reads. */
const lum = (h: string) => {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export function onWhite(h: string): string {
  let [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const out = () => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
  for (let k = 0; k < 60 && 1.05 / (lum(out()) + 0.05) < 4.5; k++) { r *= 0.92; g *= 0.92; b *= 0.92 }
  return out()
}

function brandStyle(b: Brand): string {
  const p = hex(b.primary), a = hex(b.accent) ?? p
  if (!p) return ''
  /* The moving mesh keeps its shape and takes the school's two colours, so
     every school's page is recognisably its own without a second template. */
  return `\n<style>
:root{--brand:${p};--who-thumb:${onWhite(p)}}
.auth-brand{background:color-mix(in srgb, ${p} 55%, #000)}
.auth-brand .blob-1,.auth-brand .blob-5{background:${p}}
.auth-brand .blob-2,.auth-brand .blob-4{background:${a}}
.auth-brand .blob-3{background:color-mix(in srgb, ${p} 50%, #fff)}
button[type="submit"]{background:${p};border-color:${p}}
.auth-logo{max-width:96px;max-height:96px;border-radius:14px;background:#fff;padding:8px;object-fit:contain}
</style>`
}

export type LoginLang = 'en' | 'te'

/* The page's words. Telugu for a Telugu school, ?lang=te or a browser that
   prefers it (routes/login.ts chooses); English otherwise. */
const WORDS: Record<LoginLang, Record<string, string>> = {
  en: {
    SIGNIN: 'Sign in', IDENT: 'Username, email or phone', PASSWORD: 'Password', CAPS: 'Caps Lock is on',
    PENDING: 'Signing in…', FORGOT: 'Forgotten your password?', PRIVACY: 'Privacy',
    SHOW: 'Show password', HIDE: 'Hide password', HELP: 'Help signing in',
    EYEBROW: 'One login', HEADLINE: 'One stop for the whole school.',
    MESSAGE: 'Admissions, fees, attendance, exams: office, staff room and parents.',
  },
  te: {
    SIGNIN: 'సైన్ ఇన్', IDENT: 'యూజర్‌నేమ్, ఈమెయిల్ లేదా ఫోన్', PASSWORD: 'పాస్‌వర్డ్', CAPS: 'Caps Lock ఆన్‌లో ఉంది',
    PENDING: 'సైన్ ఇన్ అవుతోంది…', FORGOT: 'పాస్‌వర్డ్ మర్చిపోయారా?', PRIVACY: 'గోప్యత',
    SHOW: 'పాస్‌వర్డ్ చూపించు', HIDE: 'పాస్‌వర్డ్ దాచు', HELP: 'సైన్ ఇన్‌కు సహాయం',
    EYEBROW: 'ఒకే లాగిన్', HEADLINE: 'మొత్తం స్కూల్ ఒకే చోట.',
    MESSAGE: 'అడ్మిషన్లు, ఫీజులు, హాజరు, పరీక్షలు: ఆఫీసు, టీచర్లు, తల్లిదండ్రులు అందరికీ.',
  },
}

/* Words for the tabs, the vendor page, the gallery and the school chooser. */
const MORE: Record<LoginLang, {
  tabs: { id: string; name: string; label: string; hint: string; mode: string; ac: string }[]
  tablist: string; vendorH1: string; vendorLede: string; picture: string; gallery: string; back: string
  findH1: string; findLede: string; code: string; cont: string
}> = {
  en: {
    tabs: [
      { id: 'parent', name: 'Parent', label: 'Phone number', hint: 'The phone number you gave the school.', mode: 'tel', ac: 'tel' },
      { id: 'student', name: 'Student', label: 'Admission number', hint: 'Printed on your ID card and fee receipt.', mode: 'text', ac: 'username' },
      { id: 'staff', name: 'Staff', label: 'Username or email', hint: 'Given to you by the school office.', mode: 'email', ac: 'username' },
    ],
    tablist: 'Who is signing in', vendorH1: 'Vendor sign-in', vendorLede: 'For XULO staff. Schools sign in at their own address.',
    picture: 'Picture', gallery: 'School pictures', back: 'Back',
    findH1: 'Find your school', findLede: 'Type the school code the office gave you.', code: 'School code', cont: 'Continue',
  },
  te: {
    tabs: [
      { id: 'parent', name: 'తల్లిదండ్రులు', label: 'ఫోన్ నంబర్', hint: 'మీరు స్కూల్‌కు ఇచ్చిన ఫోన్ నంబర్.', mode: 'tel', ac: 'tel' },
      { id: 'student', name: 'విద్యార్థి', label: 'అడ్మిషన్ నంబర్', hint: 'మీ ఐడీ కార్డు, ఫీజు రసీదుపై ఉంటుంది.', mode: 'text', ac: 'username' },
      { id: 'staff', name: 'సిబ్బంది', label: 'యూజర్‌నేమ్ లేదా ఈమెయిల్', hint: 'స్కూల్ ఆఫీసు మీకు ఇచ్చినది.', mode: 'email', ac: 'username' },
    ],
    tablist: 'ఎవరు సైన్ ఇన్ అవుతున్నారు', vendorH1: 'వెండర్ సైన్ ఇన్', vendorLede: 'XULO సిబ్బంది కోసం. స్కూల్స్ తమ సొంత చిరునామాలో సైన్ ఇన్ అవుతాయి.',
    picture: 'చిత్రం', gallery: 'స్కూల్ చిత్రాలు', back: 'వెనుకకు',
    findH1: 'మీ స్కూల్‌ను కనుగొనండి', findLede: 'ఆఫీసు ఇచ్చిన స్కూల్ కోడ్‌ను టైప్ చేయండి.', code: 'స్కూల్ కోడ్', cont: 'కొనసాగించు',
  },
}

/* Tabs: a segmented control above the form. Hidden until the script runs, so
   without JS the page is the plain form with the generic label. */
const TAB_CSS = `
<style>
.who{position:relative;display:flex;margin:0 0 4px;padding:4px;border-radius:999px;background:color-mix(in srgb, var(--fg) 8%, transparent);box-shadow:inset 0 1px 3px color-mix(in srgb, var(--fg) 18%, transparent);transition:background-color 400ms ease}
.who[hidden]{display:none}
.who button{position:relative;z-index:1;flex:1 1 0;min-width:0;height:64px;margin:0;padding:0 6px;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border-radius:999px;background:transparent;color:var(--secondary);font-size:13px;font-weight:500;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color 200ms ease-out}
.who button:hover:not([aria-selected="true"]){background:color-mix(in srgb, var(--fg) 6%, transparent)}
.who button[aria-selected="true"]{background:transparent;color:#fff}
.who-thumb{position:absolute;top:4px;bottom:4px;left:4px;width:calc((100% - 8px) / 3);border-radius:999px;background:var(--who-thumb, #1d4ed8);box-shadow:0 2px 6px color-mix(in srgb, var(--fg) 22%, transparent);transform:translateX(calc(var(--i, 0) * 100%)) scaleX(var(--s, 1));pointer-events:none}
.who.pressing{--s:1.12}
.who.ready .who-thumb{transition:transform 400ms cubic-bezier(0.68, -0.55, 0.265, 1.55)}
@media (prefers-reduced-motion:reduce){.who.ready .who-thumb,.who button{transition:none}}
html[data-reduce-motion] .who.ready .who-thumb,html[data-reduce-motion] .who button{transition:none}
.id-hint{margin:6px 0 0;font-size:12.5px;color:var(--muted)}
.who svg{flex:none;width:22px;height:22px}
.who button span{max-width:100%;overflow:hidden;text-overflow:ellipsis}
@media (max-width:560px){
  .auth-split:not(.has-slides) .who{background:rgba(0,0,0,0.25)}
  .auth-split:not(.has-slides) .who button{color:rgba(255,255,255,0.85)}
  .auth-split:not(.has-slides) .who button[aria-selected="true"]{background:transparent;color:#fff}
  .auth-split:not(.has-slides) .id-hint{color:rgba(255,255,255,0.8)}
}
</style>`

/* Minimal line icons for the tabs (lucide-style, currentColor). */
const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`
const TAB_ICONS: Record<string, string> = {
  parent: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  student: svg('<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/><path d="M22 10v6"/>'),
  staff: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16a3 3 0 0 1 6 0"/><path d="M15 10h3"/><path d="M15 14h3"/>'),
}

const tabsScript = (lang: LoginLang) => {
  const t = MORE[lang].tabs.map(({ id, label, hint, mode, ac }) => ({ id, label, hint, mode, ac }))
  return `
<script>
(function () {
  var T = ${JSON.stringify(t).replace(/</g, '\\u003c')}
  var list = document.querySelector('.who')
  var input = document.getElementById('identifier')
  var label = document.getElementById('identifier-label')
  var hint = document.getElementById('identifier-hint')
  if (!list || !input || !label || !hint) return
  var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'))
  function pick(i, focus) {
    var c = T[i]
    tabs.forEach(function (b, j) {
      b.setAttribute('aria-selected', j === i ? 'true' : 'false')
      b.tabIndex = j === i ? 0 : -1
    })
    list.style.setProperty('--i', String(i))
    label.textContent = c.label
    hint.textContent = c.hint
    hint.hidden = false
    input.setAttribute('inputmode', c.mode)
    input.setAttribute('autocomplete', c.ac)
    if (focus) tabs[i].focus()
    try { localStorage.setItem('login-tab', c.id) } catch (e) {}
  }
  var start = 0
  try {
    var saved = localStorage.getItem('login-tab')
    for (var k = 0; k < T.length; k++) if (T[k].id === saved) start = k
  } catch (e) {}
  tabs.forEach(function (b, i) {
    b.addEventListener('click', function () { pick(i, false); input.focus() })
    b.addEventListener('pointerdown', function () { list.classList.add('pressing') })
    b.addEventListener('keydown', function (e) {
      var n = tabs.length, j = -1
      if (e.key === 'ArrowRight') j = (i + 1) % n
      else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n
      else if (e.key === 'Home') j = 0
      else if (e.key === 'End') j = n - 1
      if (j < 0) return
      e.preventDefault()
      pick(j, true)
    })
  })
  var up = function () { list.classList.remove('pressing') }
  document.addEventListener('pointerup', up)
  document.addEventListener('pointercancel', up)
  list.hidden = false
  pick(start, false)
  requestAnimationFrame(function () { list.classList.add('ready') })
})()
</script>`
}

/* Sign-in pictures (owner, 2026-10-26): the pictures fill the brand panel,
   same size as without them, and cross-fade one into the next with a slow
   zoom. A gradient in the school's colour keeps the logo and words readable.
   Bars at the bottom show which picture is on and how long it stays; a click
   jumps to one; the pointer or focus on the panel holds it. Under reduced
   motion: no zoom, no fade, no advance. On a phone the panel is the page's
   background, so the pictures are too, behind the form. */
const SLIDE_MS = 5000
const SLIDES_CSS = `
<style>
.auth-brand.has-slides{background:color-mix(in srgb, var(--brand, #1c0e33) 40%, #05070d)}
.auth-slides{position:absolute;inset:0;z-index:0;overflow:hidden}
.auth-slides img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 32%;opacity:0;transition:opacity 1.2s ease-in-out}
.auth-slides img.on{opacity:1}
.auth-slides img.on,.auth-slides img.was{animation:authKenBurns ${SLIDE_MS + 1200}ms linear forwards}
.auth-brand.held .auth-slides img{animation-play-state:paused}
@keyframes authKenBurns{from{transform:scale(1)}to{transform:scale(1.06)}}
.auth-slides::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,
  color-mix(in srgb, var(--brand, #0b132b) 22%, rgba(5,8,18,0.92)) 0%,
  color-mix(in srgb, var(--brand, #0b132b) 18%, rgba(5,8,18,0.35)) 55%,
  rgba(0,0,0,0.12) 100%)}
.auth-brand.has-slides .auth-brand-eyebrow{font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;opacity:1;color:color-mix(in srgb, var(--brand, #93c5fd) 30%, #fff)}
.auth-brand.has-slides .auth-brand-title{text-shadow:0 2px 18px rgba(0,0,0,0.35)}
.auth-bars{display:flex;gap:6px;margin-top:22px}
.auth-bars[hidden]{display:none}
.auth-bars button{flex:0 0 auto;width:28px;height:24px;margin:0;padding:0;border:0;background:transparent;display:flex;align-items:center;cursor:pointer;box-shadow:none}
.auth-bars button:hover{background:transparent}
.auth-bars button::before{content:"";width:100%;height:3px;border-radius:2px;background-color:rgba(255,255,255,0.35);
  background-image:linear-gradient(#fff,#fff);background-repeat:no-repeat;background-size:0 100%;transition:background-color 0.2s ease}
.auth-bars button:hover::before{background-color:rgba(255,255,255,0.55)}
.auth-bars button[aria-current="true"]::before{background-color:rgba(255,255,255,0.6);animation:authBar ${SLIDE_MS}ms linear forwards}
.auth-brand.held .auth-bars button[aria-current="true"]::before{animation-play-state:paused}
.auth-bars button:focus-visible{outline:2px solid #fff;outline-offset:2px;border-radius:3px}
@keyframes authBar{from{background-size:0 100%}to{background-size:100% 100%}}
/* Phone (owner, 2026-10-26, two pages like images/33 in the request): page one
   is the slider over the whole screen with the logo, school name, headline and
   one Sign in button; that button opens page two, the top of the picture
   fading into the page with the form below on the plain background. Page two
   is .p2 on the split; #signin in the address keeps Back working. */
.auth-go,.auth-back{display:none}
@media (max-width:639px){
  body.auth:has(.has-slides){padding:0;overflow-y:auto;background:var(--surface)}
  .auth-split.has-slides{position:relative;flex-direction:column;justify-content:flex-start;align-items:stretch;width:100%;min-height:100vh;min-height:100dvh;
    padding:0 0 calc(env(safe-area-inset-bottom, 0px) + 24px);border:0;border-radius:0;box-shadow:none;background:var(--surface)}
  .auth-split.has-slides .auth-brand{flex:none;padding:0;border-radius:0;overflow:hidden;background:transparent}
  .auth-split.has-slides .auth-slides{-webkit-mask-image:linear-gradient(to bottom, #000 58%, transparent 100%);mask-image:linear-gradient(to bottom, #000 58%, transparent 100%);
    background:color-mix(in srgb, var(--brand, #1c0e33) 40%, #05070d)}
  .auth-split.has-slides .auth-slides::after{background:linear-gradient(to bottom, rgba(5,8,18,0.55) 0%, rgba(5,8,18,0.15) 45%, rgba(5,8,18,0) 70%)}

  /* Page one. */
  .auth-split.has-slides:not(.p2) .auth-brand{position:fixed;inset:0;z-index:1;animation:authPage .28s ease-out}
  .auth-split.has-slides:not(.p2) .card{display:none}
  .auth-split.has-slides .auth-brand-content{position:relative;display:flex;flex-direction:column;justify-content:flex-start;height:100%;
    padding:calc(env(safe-area-inset-top, 0px) + 38px) 20px calc(env(safe-area-inset-bottom, 0px) + 96px)}
  .auth-split.has-slides .auth-brand-mark{align-self:flex-start;margin:0 0 14px;font-size:32px}
  .auth-split.has-slides .auth-logo{align-self:flex-start;margin-bottom:14px}
  .auth-split.has-slides .auth-logo{max-width:48px;max-height:48px;padding:5px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.25)}
  .auth-split.has-slides .auth-brand-eyebrow{margin:0 0 10px}
  .auth-split.has-slides .auth-brand-title{font-size:40px;line-height:1.08;letter-spacing:-0.02em;margin:0;max-width:12ch}
  .auth-split.has-slides .auth-brand-sub{display:none}
  .auth-split.has-slides .auth-bars{position:absolute;top:calc(env(safe-area-inset-top, 0px) + 6px);left:20px;right:64px;margin:0;gap:4px}
  .auth-split.has-slides .auth-bars button{flex:1 1 0;width:auto;height:28px}
  .auth-split.has-slides:not(.p2) .auth-go{display:block;position:absolute;z-index:2;left:20px;right:20px;bottom:calc(env(safe-area-inset-bottom, 0px) + 20px);
    width:auto;height:52px;margin:0;border:0;border-radius:24px;background:var(--brand, var(--accent));color:#fff;font-size:16px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.25)}
  body.auth:has(.has-slides:not(.p2)) .auth-top .theme-toggle{z-index:3;background:rgba(255,255,255,0.18);border-color:rgba(255,255,255,0.3);color:#fff}

  /* Page two. */
  .auth-split.has-slides.p2 .auth-brand{position:relative;height:38vh;height:38dvh}
  .auth-split.has-slides.p2 .auth-slides{-webkit-mask-image:linear-gradient(to bottom, #000 35%, transparent 100%);mask-image:linear-gradient(to bottom, #000 35%, transparent 100%)}
  .auth-split.has-slides.p2 .auth-brand-content{display:none}
  .auth-split.has-slides.p2 .auth-back{display:flex;align-items:center;justify-content:center;position:absolute;z-index:2;top:calc(env(safe-area-inset-top, 0px) + 16px);left:16px;
    width:44px;height:44px;margin:0;padding:0;border:1px solid rgba(255,255,255,0.3);border-radius:50%;background:rgba(0,0,0,0.3);color:#fff}
  .auth-split.has-slides.p2 .auth-back svg{width:20px;height:20px}
  .auth-split.has-slides.p2 .card{position:relative;z-index:1;flex:none;width:100%;margin:-24px 0 0;max-width:none;padding:0 16px;border:0;border-radius:0;background:transparent;
    -webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none;color:var(--fg);animation:authPage .28s ease-out}
  .auth-split.has-slides .card > *{max-width:none}
  .auth-split.has-slides .card h1{color:var(--fg)}
  .auth-split.has-slides .card label{color:var(--secondary)}
  .auth-split.has-slides .card .lede,.auth-split.has-slides .card .fineprint{color:var(--muted)}
  .auth-split.has-slides .card .fineprint a{color:var(--accent)}
  .auth-split.has-slides .card input{background:var(--surface);border-color:var(--border);color:inherit}
  .auth-split.has-slides .card input:focus{border-color:var(--accent)}
  .auth-split.has-slides .card .pw > button.pw-eye{color:var(--muted)}
  .auth-split.has-slides .card button[type="submit"]{background:var(--brand, var(--accent));border-color:var(--brand, var(--accent));color:#fff}
  .auth-split.has-slides .card .error{background:color-mix(in srgb, var(--danger) 6%, transparent);border-color:color-mix(in srgb, var(--danger) 30%, transparent);color:var(--danger)}
  .auth-split.has-slides .card .field-hint{color:var(--warning, #b45309)}
  body.auth:has(.has-slides.p2) .auth-top .theme-toggle{background:rgba(0,0,0,0.3);border-color:rgba(255,255,255,0.3);color:#fff;-webkit-backdrop-filter:none;backdrop-filter:none}
}
@keyframes authPage{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){
  .auth-slides img{transition:none}
  .auth-slides img.on,.auth-slides img.was{animation:none}
  .auth-bars button[aria-current="true"]::before{animation:none;background-size:100% 100%}
  .auth-split.has-slides .auth-brand,.auth-split.has-slides .card{animation:none}
}
</style>`

function slidesHTML(slides: string[]): string {
  return `<div class="auth-slides" aria-hidden="true">${slides.map((u, i) =>
    `<img src="${esc(u)}" alt=""${i ? ' loading="lazy"' : ' class="on" fetchpriority="high"'} decoding="async">`).join('')}</div>`
}

function barsHTML(slides: string[], lang: LoginLang): string {
  const m = MORE[lang]
  return `<div class="auth-bars" role="group" aria-label="${esc(m.gallery)}" hidden>${slides.map((_, i) =>
    `<button type="button" aria-label="${esc(`${m.picture} ${i + 1} / ${slides.length}`)}"${i ? '' : ' aria-current="true"'}></button>`).join('')}</div>`
}

/* The phone's page-one Sign in button and page-two back control; hidden
   on wider screens by CSS. */
function phoneButtonsHTML(signIn: string, back: string): string {
  return `<button type="button" class="auth-go">${esc(signIn)}</button>
      <button type="button" class="auth-back" aria-label="${esc(back)}" title="${esc(back)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>`
}

/* Page one / page two on a phone. #signin opens page two, so a reload or a
   link lands there and the phone's Back returns to page one. */
const PHONE_JS = `
<script>
(function () {
  var split = document.querySelector('.auth-split.has-slides')
  var go = split && split.querySelector('.auth-go')
  var back = split && split.querySelector('.auth-back')
  if (!go || !back) return
  var pushed = false
  function show(two) {
    split.classList.toggle('p2', two)
    window.scrollTo(0, 0)
  }
  if (location.hash === '#signin') split.classList.add('p2')
  go.addEventListener('click', function () {
    try { history.pushState({ signin: 1 }, '', '#signin'); pushed = true } catch (e) {}
    show(true)
  })
  back.addEventListener('click', function () {
    if (pushed) { history.back(); return }
    try { history.replaceState(null, '', location.pathname + location.search) } catch (e) {}
    show(false)
  })
  window.addEventListener('popstate', function () {
    pushed = false
    show(location.hash === '#signin')
  })
})()
</script>`

const SLIDES_JS = `
<script>
(function () {
  var panel = document.querySelector('.auth-brand.has-slides')
  var bar = panel && panel.querySelector('.auth-bars')
  if (!bar) return
  var pics = Array.prototype.slice.call(panel.querySelectorAll('.auth-slides img'))
  var dots = Array.prototype.slice.call(bar.querySelectorAll('button'))
  var n = pics.length, now = 0, held = 0, spent = 0, last = Date.now(), fade = 0
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  /* The next picture loads while this one shows, so a fade never reaches a blank frame. */
  function warm(i) { var p = pics[i]; if (p && p.loading === 'lazy') p.loading = 'eager' }
  function go(i) {
    if (i === now) return
    var old = pics[now]
    old.classList.remove('on')
    old.classList.add('was')
    window.clearTimeout(fade)
    fade = window.setTimeout(function () {
      pics.forEach(function (p) { if (!p.classList.contains('on')) p.classList.remove('was') })
    }, 1300)
    warm(i)
    pics[i].classList.remove('was')
    pics[i].classList.add('on')
    dots.forEach(function (d, j) {
      if (j === i) d.setAttribute('aria-current', 'true')
      else d.removeAttribute('aria-current')
    })
    now = i
    spent = 0
    warm((i + 1) % n)
  }
  dots.forEach(function (d, i) { d.addEventListener('click', function () { go(i) }) })
  bar.hidden = false
  if (still) return
  warm(1)
  function hold() { held++; panel.classList.add('held') }
  function release() { if (held > 0) held--; if (!held) panel.classList.remove('held') }
  panel.addEventListener('mouseenter', hold)
  panel.addEventListener('mouseleave', release)
  panel.addEventListener('focusin', hold)
  panel.addEventListener('focusout', release)
  window.setInterval(function () {
    var t = Date.now(), dt = t - last
    last = t
    if (held || document.hidden) return
    spent += dt
    if (spent >= ${SLIDE_MS}) go((now + 1) % n)
  }, 100)
})()
</script>`

/* Phone sizes (owner, 2026-10-26: "for all screen types it should fit"):
   fields and buttons 48px with 16px text (16px also stops iOS zooming into a
   field), title 24px; below 380px the card and tabs give up some padding so
   Parent / Student / Staff fit whole at 320 wide. */
const PHONE_FIT_CSS = `
<style>
@media (max-width:639px){
  .auth-split .card input:not([type="hidden"]){height:48px;font-size:16px}
  .auth-split .card button[type="submit"]{height:48px;font-size:16px}
  .auth-split .card h1{font-size:24px}
}
@media (max-width:379px){
  .auth-split:not(.has-slides){padding-left:12px;padding-right:12px}
  .auth-split:not(.has-slides) .card{padding:24px 10px}
  .auth-split .who{padding:3px}
  .auth-split .who button{padding:0 3px;gap:3px}
}
</style>`

export function loginHTML(o: {
  csrf: string; next: string; identifier?: string; error?: string; brand?: Brand; lang?: LoginLang; switchHref?: string
  /** 'vendor' is the XULO maintenance sign-in: no tabs, its own heading. */
  audience?: 'school' | 'vendor'
}): string {
  const lang: LoginLang = o.lang === 'te' ? 'te' : 'en'
  const w = WORDS[lang]
  const m = MORE[lang]
  const vendor = o.audience === 'vendor'
  const id = o.identifier ?? ''
  const b = o.brand
  const slides = (b?.slides ?? []).filter((u) => typeof u === 'string' && u.length > 0)
  const mark = b?.logoUrl
    ? `<img class="auth-logo" src="${esc(b.logoUrl)}" alt="">`
    : '<div class="auth-brand-mark" aria-hidden="true">✳</div>'
  const copy = `<p class="auth-brand-eyebrow">${esc(b?.eyebrow || (b ? b.name : w.EYEBROW))}</p>
          <h2 class="auth-brand-title">${esc(b?.headline || w.HEADLINE)}</h2>
          <p class="auth-brand-sub">${esc(b?.message || w.MESSAGE)}</p>`
  const contact = [b?.supportPhone, b?.supportEmail].filter(Boolean) as string[]
  const support = contact.length ? `\n      <p class="fineprint">${w.HELP}: ${contact.map(esc).join(' · ')}</p>` : ''
  const described = o.error ? ' aria-describedby="login-error"' : ''
  const idDescribed = vendor ? described : ` aria-describedby="${o.error ? 'login-error ' : ''}identifier-hint"`
  const tabs = vendor ? '' : `<div class="who" role="tablist" aria-label="${esc(m.tablist)}" hidden><span class="who-thumb" aria-hidden="true"></span>${m.tabs.map((t, i) =>
    `<button type="button" role="tab" id="tab-${t.id}" aria-controls="login-form" aria-selected="${i ? 'false' : 'true'}"${i ? ' tabindex="-1"' : ''}>${TAB_ICONS[t.id] ?? ''}<span>${esc(t.name)}</span></button>`).join('')}</div>`
  /* A small English / తెలుగు switch; the other language's name, in itself. */
  const sw = o.switchHref ? ` · <a href="${esc(o.switchHref)}" lang="${lang === 'te' ? 'en' : 'te'}">${lang === 'te' ? 'English' : 'తెలుగు'}</a>` : ''
  let page = PAGE.split('@@LANG@@').join(lang).replace('@@SWITCH@@', () => sw)
  /* With pictures the panel keeps its place, size, logo and words; the
     pictures take the moving mesh's place behind them. */
  if (slides.length) {
    page = page.replace('<aside class="auth-brand">', '<aside class="auth-brand has-slides">')
      .replace(/<div class="mesh" aria-hidden="true">[\s\S]*?<\/div>/, () => slidesHTML(slides))
      .replace('</aside>', () => phoneButtonsHTML(w.SIGNIN, m.back) + '\n    </aside>')
  }
  for (const k of Object.keys(w)) page = page.split(`@@T_${k}@@`).join(w[k])
  const style = (b ? brandStyle(b) : '') + PHONE_FIT_CSS + (vendor ? '' : TAB_CSS) + (slides.length ? SLIDES_CSS : '')
  const scripts = (vendor ? '' : tabsScript(lang)) + (slides.length > 1 ? SLIDES_JS : '') + (slides.length ? PHONE_JS : '')
  return page
    .replace('@@H1@@', vendor ? esc(m.vendorH1) : w.SIGNIN)
    .replace('@@LEDE@@', vendor ? esc(m.vendorLede) : '@@NAME@@')
    .split('@@NAME@@').join(esc(b?.name ?? 'XULO'))
    .replace('@@SPLITCLASS@@', slides.length ? (o.error || id ? ' has-slides p2' : ' has-slides') : '')
    .replace('@@STYLE@@', () => style)
    .replace('@@MARK@@', () => mark)
    .replace('@@COPY@@', () => copy + (slides.length > 1 ? `\n          ${barsHTML(slides, lang)}` : ''))
    .replace('@@TABS@@', () => tabs)
    .replace('@@IDHINT@@', vendor ? '' : '\n        <p class="id-hint" id="identifier-hint" hidden></p>')
    .replace('@@SCRIPTS@@', () => scripts)
    .replace('@@ACTION@@', () => esc(b?.action ?? '/login'))
    .replace('@@SUPPORT@@', () => support)
    .replace('@@CSRF@@', () => esc(o.csrf))
    .replace('@@NEXT@@', () => esc(o.next))
    .replace('@@IDENT@@', () => esc(id))
    .replace('@@IDATTR@@', idDescribed + (id ? '' : ' autofocus'))
    .replace('@@PWATTR@@', described + (id ? ' autofocus' : ''))
    .replace('@@ERROR@@', () => o.error ? `<p class="error" role="alert" id="login-error">${esc(o.error)}</p>` : '')
}

/** school.xulo.in: the same shell, asking for the school code instead. */
export function chooserHTML(o: { csrf: string; next: string; code?: string; error?: string; lang?: LoginLang }): string {
  const lang: LoginLang = o.lang === 'te' ? 'te' : 'en'
  const w = WORDS[lang]
  const m = MORE[lang]
  const described = o.error ? ' aria-describedby="chooser-error"' : ''
  const main = `<main class="card">
      <h1>${esc(m.findH1)}</h1>
      <p class="lede">${esc(m.findLede)}</p>${o.error ? `<p class="error" role="alert" id="chooser-error">${esc(o.error)}</p>` : ''}
      <form method="post" action="/login" autocomplete="on" id="chooser-form">
        <input type="hidden" name="csrf_token" value="${esc(o.csrf)}">
        <input type="hidden" name="next" value="${esc(o.next)}">
        <label for="code">${esc(m.code)}</label>
        <input id="code" type="text" name="code" required autocomplete="off"
               autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go"
               value="${esc(o.code ?? '')}"${described} autofocus>
        <button type="submit">${esc(m.cont)}</button>
      </form>
      <p class="fineprint"><a href="/privacy">${esc(w.PRIVACY)}</a></p>
    </main>`
  const page = loginHTML({ csrf: '', next: '', lang, audience: 'vendor' })
  const at = page.indexOf('<main class="card">'), end = page.indexOf('</main>') + '</main>'.length
  return (page.slice(0, at) + main + page.slice(end))
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(m.findH1)} · XULO</title>`)
}
