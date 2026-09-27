/* The sign-in page, exactly as the Go server renders it
   (internal/templates/login.gohtml with its partials), captured from the live
   site and turned into slots. The stylesheet it names, /static/app.css, is
   served by Pages from web/public/static. Per-school branding by custom
   domain or /<country>/<slug> fills the slots below from the school's row
   (Brand); with no school it is the WISEN page. */
const PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Sign in \u00b7 @@NAME@@</title>@@STYLE@@\n<link rel=\"stylesheet\" href=\"/static/app.css?v=b697c7b332\">\n<script>\n  try {\n    var t = localStorage.getItem('theme');\n    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);\n  } catch (e) {}\n</script>\n</head>\n<body class=\"auth\">\n  <div class=\"auth-top\"><button type=\"button\" id=\"theme-toggle\" class=\"theme-toggle\"\n        aria-label=\"Switch between light and dark\" title=\"Switch appearance\">\n  <svg class=\"icon-moon\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"\n       stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n    <path d=\"M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z\"/>\n  </svg>\n  <svg class=\"icon-sun\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"\n       stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n    <circle cx=\"12\" cy=\"12\" r=\"4\"/>\n    <path d=\"M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41\"/>\n  </svg>\n</button></div>\n  <div class=\"auth-split\">\n    \n    <aside class=\"auth-brand\">\n      <div class=\"mesh\" aria-hidden=\"true\">\n        <span class=\"blob blob-1\"></span>\n        <span class=\"blob blob-2\"></span>\n        <span class=\"blob blob-3\"></span>\n        <span class=\"blob blob-4\"></span>\n        <span class=\"blob blob-5\"></span>\n      </div>\n      <div class=\"auth-brand-content\">\n        @@MARK@@\n        <div class=\"auth-brand-text\">\n          \n          @@COPY@@\n        </div>\n      </div>\n    </aside>\n    <main class=\"card\">\n      \n      <h1>Sign in</h1>\n      <p class=\"lede\">@@NAME@@</p>@@ERROR@@\n      \n      \n      \n      <form method=\"post\" action=\"@@ACTION@@\" autocomplete=\"on\" id=\"login-form\">\n        <input type=\"hidden\" name=\"csrf_token\" value=\"@@CSRF@@\">\n        <input type=\"hidden\" name=\"next\" value=\"@@NEXT@@\">\n        <label for=\"identifier\">Username, email or phone</label>\n        \n        <input id=\"identifier\" type=\"text\" name=\"identifier\" required autocomplete=\"username\"\n               autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\" enterkeyhint=\"next\"\n               value=\"@@IDENT@@\"@@IDATTR@@>\n        <label for=\"password\">Password</label>\n        <input id=\"password\" type=\"password\" name=\"password\" required autocomplete=\"current-password\"\n               enterkeyhint=\"go\"@@PWATTR@@>\n        <p class=\"field-hint\" id=\"caps-hint\" hidden aria-live=\"polite\">Caps Lock is on</p>\n        <button type=\"submit\" id=\"login-submit\" data-pending-label=\"Signing in\u2026\">Sign in</button>\n      </form>\n      <p class=\"fineprint\"><a href=\"/forgot\">Forgotten your password?</a> \u00b7 <a href=\"/privacy\">Privacy</a></p>@@SUPPORT@@\n      \n    </main>\n  </div>\n<script>\n(function () {\n  var btn = document.getElementById('theme-toggle');\n  if (!btn) return;\n  var root = document.documentElement;\n  btn.addEventListener('click', function () {\n    var now = root.getAttribute('data-theme') ||\n      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');\n    var next = now === 'dark' ? 'light' : 'dark';\n    root.setAttribute('data-theme', next);\n    try { localStorage.setItem('theme', next); } catch (e) {}\n  });\n})();\n</script>\n<script>\n\n\n(function () {\n  var fields = document.querySelectorAll('input[type=\"password\"]')\n  Array.prototype.forEach.call(fields, function (input) {\n    var wrap = document.createElement('span')\n    wrap.className = 'pw'\n    input.parentNode.insertBefore(wrap, input)\n    wrap.appendChild(input)\n\n    var btn = document.createElement('button')\n    btn.type = 'button'\n    btn.className = 'pw-eye'\n    btn.setAttribute('aria-label', 'Show password')\n    btn.setAttribute('aria-pressed', 'false')\n    btn.title = 'Show password'\n    btn.innerHTML =\n      '<svg class=\"icon-on\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"' +\n      ' stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">' +\n      '<path d=\"M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></svg>' +\n      '<svg class=\"icon-off\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"' +\n      ' stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">' +\n      '<path d=\"M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94\"/>' +\n      '<path d=\"M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19\"/>' +\n      '<path d=\"M14.12 14.12a3 3 0 1 1-4.24-4.24\"/><path d=\"M1 1l22 22\"/></svg>'\n    wrap.appendChild(btn)\n\n    btn.addEventListener('click', function () {\n      var shown = input.type === 'text'\n      input.type = shown ? 'password' : 'text'\n      wrap.setAttribute('data-shown', shown ? 'no' : 'yes')\n      btn.setAttribute('aria-pressed', shown ? 'false' : 'true')\n      var label = shown ? 'Show password' : 'Hide password'\n      btn.setAttribute('aria-label', label)\n      btn.title = label\n      \n      input.focus()\n      var n = input.value.length\n      try { input.setSelectionRange(n, n) } catch (e) {   }\n    })\n\n    \n    \n    if (input.form) {\n      input.form.addEventListener('submit', function () {\n        input.type = 'password'\n        wrap.setAttribute('data-shown', 'no')\n      })\n    }\n  })\n})()\n</script>\n<script>\n(function () {\n  var pw = document.getElementById('password')\n  var hint = document.getElementById('caps-hint')\n  if (pw && hint) {\n    var show = function (e) {\n      var on = e.getModifierState && e.getModifierState('CapsLock')\n      hint.hidden = !on\n    }\n    pw.addEventListener('keydown', show)\n    pw.addEventListener('keyup', show)\n    pw.addEventListener('blur', function () { hint.hidden = true })\n  }\n  var form = document.getElementById('login-form')\n  var btn = document.getElementById('login-submit')\n  if (form && btn) {\n    form.addEventListener('submit', function () {\n      if (btn.disabled) return\n      btn.disabled = true\n      btn.setAttribute('aria-busy', 'true')\n      btn.textContent = btn.getAttribute('data-pending-label') || btn.textContent\n    })\n    \n    window.addEventListener('pageshow', function () {\n      btn.disabled = false\n      btn.removeAttribute('aria-busy')\n      btn.textContent = 'Sign in'\n    })\n  }\n})()\n</script>\n</body>\n</html>"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' }[c]!))

/** A school's own look on its sign-in page. Colours are checked hex, set by the seller. */
export interface Brand {
  name: string
  action: string
  logoUrl?: string | null
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
.auth-brand{background:color-mix(in srgb, ${p} 55%, #000)}
.auth-brand .blob-1,.auth-brand .blob-5{background:${p}}
.auth-brand .blob-2,.auth-brand .blob-4{background:${a}}
.auth-brand .blob-3{background:color-mix(in srgb, ${p} 50%, #fff)}
button[type="submit"]{background:${p};border-color:${p}}
.auth-logo{max-width:96px;max-height:96px;border-radius:14px;background:#fff;padding:8px;object-fit:contain}
</style>`
}

export function loginHTML(o: { csrf: string; next: string; identifier?: string; error?: string; brand?: Brand }): string {
  const id = o.identifier ?? ''
  const b = o.brand
  const mark = b?.logoUrl
    ? `<img class="auth-logo" src="${esc(b.logoUrl)}" alt="">`
    : '<div class="auth-brand-mark" aria-hidden="true">\u2733</div>'
  const copy = `<p class="auth-brand-eyebrow">${esc(b?.eyebrow || (b ? b.name : 'One login'))}</p>
          <h2 class="auth-brand-title">${esc(b?.headline || 'One stop for the whole school.')}</h2>
          <p class="auth-brand-sub">${esc(b?.message || 'Admissions, fees, attendance, exams: office, staff room and parents.')}</p>`
  const contact = [b?.supportPhone, b?.supportEmail].filter(Boolean) as string[]
  const support = contact.length ? `\n      <p class="fineprint">Help signing in: ${contact.map(esc).join(' \u00b7 ')}</p>` : ''
  const described = o.error ? ' aria-describedby="login-error"' : ''
  return PAGE
    .split('@@NAME@@').join(esc(b?.name ?? 'WISEN'))
    .replace('@@STYLE@@', b ? brandStyle(b) : '')
    .replace('@@MARK@@', mark)
    .replace('@@COPY@@', copy)
    .replace('@@ACTION@@', esc(b?.action ?? '/login'))
    .replace('@@SUPPORT@@', support)
    .replace('@@CSRF@@', esc(o.csrf))
    .replace('@@NEXT@@', esc(o.next))
    .replace('@@IDENT@@', esc(id))
    .replace('@@IDATTR@@', described + (id ? '' : ' autofocus'))
    .replace('@@PWATTR@@', described + (id ? ' autofocus' : ''))
    .replace('@@ERROR@@', o.error ? `<p class="error" role="alert" id="login-error">${esc(o.error)}</p>` : '')
}
