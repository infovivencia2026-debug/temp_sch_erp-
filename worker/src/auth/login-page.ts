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
  /** Sign-in pictures, public URLs in order: the square gallery that replaces the brand panel. */
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

function brandStyle(b: Brand): string {
  const p = hex(b.primary), a = hex(b.accent) ?? p
  if (!p) return ''
  /* The moving mesh keeps its shape and takes the school's two colours, so
     every school's page is recognisably its own without a second template. */
  return `\n<style>
:root{--brand:${p}}
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
  tablist: string; vendorH1: string; vendorLede: string; picture: string; gallery: string
  findH1: string; findLede: string; code: string; cont: string
}> = {
  en: {
    tabs: [
      { id: 'parent', name: 'Parent', label: 'Phone number', hint: 'The phone number you gave the school.', mode: 'tel', ac: 'tel' },
      { id: 'student', name: 'Student', label: 'Admission number', hint: 'Printed on your ID card and fee receipt.', mode: 'text', ac: 'username' },
      { id: 'staff', name: 'Staff', label: 'Username or email', hint: 'Given to you by the school office.', mode: 'email', ac: 'username' },
    ],
    tablist: 'Who is signing in', vendorH1: 'Vendor sign-in', vendorLede: 'For XULO staff. Schools sign in at their own address.',
    picture: 'Picture', gallery: 'School pictures',
    findH1: 'Find your school', findLede: 'Type the school code the office gave you.', code: 'School code', cont: 'Continue',
  },
  te: {
    tabs: [
      { id: 'parent', name: 'తల్లిదండ్రులు', label: 'ఫోన్ నంబర్', hint: 'మీరు స్కూల్‌కు ఇచ్చిన ఫోన్ నంబర్.', mode: 'tel', ac: 'tel' },
      { id: 'student', name: 'విద్యార్థి', label: 'అడ్మిషన్ నంబర్', hint: 'మీ ఐడీ కార్డు, ఫీజు రసీదుపై ఉంటుంది.', mode: 'text', ac: 'username' },
      { id: 'staff', name: 'సిబ్బంది', label: 'యూజర్‌నేమ్ లేదా ఈమెయిల్', hint: 'స్కూల్ ఆఫీసు మీకు ఇచ్చినది.', mode: 'email', ac: 'username' },
    ],
    tablist: 'ఎవరు సైన్ ఇన్ అవుతున్నారు', vendorH1: 'వెండర్ సైన్ ఇన్', vendorLede: 'XULO సిబ్బంది కోసం. స్కూల్స్ తమ సొంత చిరునామాలో సైన్ ఇన్ అవుతాయి.',
    picture: 'చిత్రం', gallery: 'స్కూల్ చిత్రాలు',
    findH1: 'మీ స్కూల్‌ను కనుగొనండి', findLede: 'ఆఫీసు ఇచ్చిన స్కూల్ కోడ్‌ను టైప్ చేయండి.', code: 'స్కూల్ కోడ్', cont: 'కొనసాగించు',
  },
}

/* Tabs: a segmented control above the form. Hidden until the script runs, so
   without JS the page is the plain form with the generic label. */
const TAB_CSS = `
<style>
.who{display:flex;margin:0 0 4px;padding:4px;border-radius:10px;background:color-mix(in srgb, var(--fg) 6%, transparent)}
.who[hidden]{display:none}
.who button{flex:1 1 0;min-width:0;height:40px;margin:0;padding:0 8px;border-radius:7px;background:transparent;color:var(--secondary);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who button:hover{background:color-mix(in srgb, var(--fg) 6%, transparent)}
.who button[aria-selected="true"]{background:var(--brand, var(--accent));color:#fff}
.id-hint{margin:6px 0 0;font-size:12.5px;color:var(--muted)}
@media (max-width:640px){.who button{height:48px}}
@media (max-width:560px){
  .auth-split:not(.has-gallery) .who{background:rgba(0,0,0,0.25)}
  .auth-split:not(.has-gallery) .who button{color:rgba(255,255,255,0.85)}
  .auth-split:not(.has-gallery) .who button[aria-selected="true"]{background:#fff;color:#111827}
  .auth-split:not(.has-gallery) .id-hint{color:rgba(255,255,255,0.8)}
}
</style>`

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
  list.hidden = false
  pick(start, false)
})()
</script>`
}

/* The gallery: square pictures on a scroll-snap track. Swipe is the browser's
   own scrolling; the script adds dots, a 5 second advance (none under reduced
   motion) and pauses while the pointer, a finger or focus is on it. */
const GALLERY_CSS = `
<style>
.auth-gallery{flex:0 0 52%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:44px;background:var(--ground);min-width:0}
.gallery{width:100%;max-width:min(640px, 80vh)}
.gallery-track{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;border-radius:16px;aspect-ratio:1/1;background:color-mix(in srgb, var(--fg) 6%, transparent)}
.gallery-track::-webkit-scrollbar{display:none}
.gallery-track figure{flex:0 0 100%;margin:0;scroll-snap-align:start;scroll-snap-stop:always}
.gallery-track img{display:block;width:100%;height:100%;object-fit:cover}
.gallery-dots{display:flex;justify-content:center;margin-top:4px}
.gallery-dots[hidden]{display:none}
.gallery-dots button{width:24px;height:40px;margin:0;padding:0;background:transparent;display:flex;align-items:center;justify-content:center}
.gallery-dots button:hover{background:transparent}
.gallery-dots button::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--fg);opacity:0.3;transition:opacity 0.2s ease, transform 0.2s ease}
.gallery-dots button[aria-current="true"]::before{opacity:1;transform:scale(1.25)}
@media (prefers-reduced-motion: reduce){.gallery-dots button::before{transition:none}}
@media (max-width:900px){
  .auth-gallery{flex:none;padding:0}
  .gallery{max-width:none}
  .gallery-track{border-radius:0}
}
@media (max-width:560px){
  .auth-split.has-gallery{background:var(--surface);padding:calc(env(safe-area-inset-top, 0px) + 64px) 0 calc(env(safe-area-inset-bottom, 0px) + 24px);justify-content:flex-start}
  .auth-split.has-gallery .auth-gallery{width:100%}
  .auth-split.has-gallery .card{margin:0;max-width:none;padding:16px 16px 0;border:0;border-radius:0;background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none;color:var(--fg)}
  .auth-split.has-gallery .card h1{color:var(--fg)}
  .auth-split.has-gallery .card label{color:var(--secondary)}
  .auth-split.has-gallery .card .lede,.auth-split.has-gallery .card .fineprint{color:var(--muted)}
  .auth-split.has-gallery .card .fineprint a{color:var(--accent)}
  .auth-split.has-gallery .card input{background:var(--surface);border-color:var(--border);color:inherit}
  .auth-split.has-gallery .card input:focus{border-color:var(--accent)}
  .auth-split.has-gallery .card .pw > button.pw-eye{color:var(--muted)}
  .auth-split.has-gallery .card button[type="submit"]{background:var(--brand, var(--accent));color:#fff}
  .auth-split.has-gallery .card .error{background:color-mix(in srgb, var(--danger) 6%, transparent);border-color:color-mix(in srgb, var(--danger) 30%, transparent);color:var(--danger)}
  .auth-split.has-gallery .card .field-hint{color:var(--warning, #b45309)}
  body.auth:has(.has-gallery) .auth-top .theme-toggle{background:var(--surface);border-color:var(--border);color:var(--fg)}
}
</style>`

function galleryHTML(slides: string[], lang: LoginLang): string {
  const m = MORE[lang]
  const figs = slides.map((u, i) =>
    `<figure><img src="${esc(u)}" alt=""${i ? ' loading="lazy"' : ''} decoding="async"></figure>`).join('')
  const dots = slides.length > 1
    ? `<div class="gallery-dots" hidden>${slides.map((_, i) =>
      `<button type="button" aria-label="${esc(`${m.picture} ${i + 1} / ${slides.length}`)}"${i ? '' : ' aria-current="true"'}></button>`).join('')}</div>`
    : ''
  return `<aside class="auth-gallery" aria-label="${esc(m.gallery)}">
      <div class="gallery"><div class="gallery-track">${figs}</div>${dots}</div>
    </aside>`
}

const GALLERY_JS = `
<script>
(function () {
  var g = document.querySelector('.gallery')
  var track = g && g.querySelector('.gallery-track')
  var bar = g && g.querySelector('.gallery-dots')
  if (!track || !bar) return
  var dots = Array.prototype.slice.call(bar.querySelectorAll('button'))
  var n = dots.length, now = 0, held = 0
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  function go(i) {
    track.scrollTo({ left: i * track.clientWidth, behavior: still ? 'auto' : 'smooth' })
  }
  function mark() {
    var i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth))
    if (i < 0) i = 0
    if (i > n - 1) i = n - 1
    now = i
    dots.forEach(function (d, j) {
      if (j === i) d.setAttribute('aria-current', 'true')
      else d.removeAttribute('aria-current')
    })
  }
  dots.forEach(function (d, i) { d.addEventListener('click', function () { go(i) }) })
  track.addEventListener('scroll', function () { window.requestAnimationFrame(mark) }, { passive: true })
  bar.hidden = false
  if (still) return
  function hold() { held++ }
  function release() { if (held > 0) held-- }
  g.addEventListener('mouseenter', hold)
  g.addEventListener('mouseleave', release)
  g.addEventListener('focusin', hold)
  g.addEventListener('focusout', release)
  g.addEventListener('touchstart', hold, { passive: true })
  g.addEventListener('touchend', function () { window.setTimeout(release, 5000) }, { passive: true })
  window.setInterval(function () {
    if (held || document.hidden) return
    go((now + 1) % n)
  }, 5000)
})()
</script>`

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
  const tabs = vendor ? '' : `<div class="who" role="tablist" aria-label="${esc(m.tablist)}" hidden>${m.tabs.map((t, i) =>
    `<button type="button" role="tab" id="tab-${t.id}" aria-controls="login-form" aria-selected="${i ? 'false' : 'true'}"${i ? ' tabindex="-1"' : ''}>${esc(t.name)}</button>`).join('')}</div>`
  /* A small English / తెలుగు switch; the other language's name, in itself. */
  const sw = o.switchHref ? ` · <a href="${esc(o.switchHref)}" lang="${lang === 'te' ? 'en' : 'te'}">${lang === 'te' ? 'English' : 'తెలుగు'}</a>` : ''
  let page = PAGE.split('@@LANG@@').join(lang).replace('@@SWITCH@@', () => sw)
  if (slides.length) page = page.replace(/<aside class="auth-brand">[\s\S]*?<\/aside>/, () => galleryHTML(slides, lang))
  for (const k of Object.keys(w)) page = page.split(`@@T_${k}@@`).join(w[k])
  const style = (b ? brandStyle(b) : '') + (vendor ? '' : TAB_CSS) + (slides.length ? GALLERY_CSS : '')
  const scripts = (vendor ? '' : tabsScript(lang)) + (slides.length > 1 ? GALLERY_JS : '')
  return page
    .replace('@@H1@@', vendor ? esc(m.vendorH1) : w.SIGNIN)
    .replace('@@LEDE@@', vendor ? esc(m.vendorLede) : '@@NAME@@')
    .split('@@NAME@@').join(esc(b?.name ?? 'XULO'))
    .replace('@@SPLITCLASS@@', slides.length ? ' has-gallery' : '')
    .replace('@@STYLE@@', () => style)
    .replace('@@MARK@@', () => mark)
    .replace('@@COPY@@', () => copy)
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
