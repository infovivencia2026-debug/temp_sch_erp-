import { describe, expect, it } from 'vitest'
import { chooserHTML, loginHTML, onWhite } from '../../src/auth/login-page'

const brand = { name: 'Test School', action: '/login' }

describe('sign-in page', () => {
  it('shows Parent, Student and Staff tabs on a school page, hidden until the script runs', () => {
    const h = loginHTML({ csrf: 'c', next: '/', brand })
    expect(h).toContain('role="tablist"')
    expect(h).toMatch(/<div class="who" role="tablist"[^>]* hidden>/)
    for (const t of ['Parent', 'Student', 'Staff']) expect(h).toContain(`<span>${t}</span></button>`)
    expect(h.match(/<button type="button" role="tab"[^>]*><svg [^>]*stroke-width="1.75"/g)?.length).toBe(3)
    expect(h).toContain('name="identifier"')
    expect(h).toContain('>Username, email or phone</label>')
    expect(h).not.toContain('@@')
  })

  it('tabs are a sliding toggle: icon above label, thumb moves by transform, instant on reduced motion', () => {
    const h = loginHTML({ csrf: 'c', next: '/', brand })
    expect(h).toContain('hidden><span class="who-thumb" aria-hidden="true"></span><button')
    expect(h).toMatch(/.who button{[^}]*height:64px[^}]*flex-direction:column/)
    expect(h).toContain('transform:translateX(calc(var(--i, 0) * 100%)) scaleX(var(--s, 1))')
    expect(h).toContain('.who.pressing{--s:1.12}')
    expect(h).toContain(".who.ready .who-thumb{transition:transform 400ms cubic-bezier(0.68, -0.55, 0.265, 1.55)}")
    expect(h).toContain("@media (prefers-reduced-motion:reduce){.who.ready .who-thumb,.who button{transition:none}}")
    expect(h).toContain("list.style.setProperty('--i', String(i))")
    expect(h).toContain('background:var(--who-thumb, #1d4ed8)')
    expect(h).toContain('.who button[aria-selected="true"]{background:transparent;color:#fff}')
  })

  it('selected-tab fill keeps white text at 4.5:1 or more', () => {
    const L = (x: string) => { const c = [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
    for (const p of ['#ffff00', '#3b82f6', '#f59e0b', '#1d4ed8', '#ffffff']) expect(1.05 / (L(onWhite(p)) + 0.05)).toBeGreaterThanOrEqual(4.5)
    expect(1.05 / (L('#1d4ed8') + 0.05)).toBeGreaterThanOrEqual(4.5)
    expect(loginHTML({ csrf: 'c', next: '/', brand: { ...brand, primary: '#ffff00' } })).toContain('--who-thumb:#')
  })

  it('has Telugu tab names', () => {
    const h = loginHTML({ csrf: 'c', next: '/', brand, lang: 'te' })
    for (const t of ['తల్లిదండ్రులు', 'విద్యార్థి', 'సిబ్బంది']) expect(h).toContain(t)
  })

  it('vendor audience has no tabs and its own heading', () => {
    const h = loginHTML({ csrf: 'c', next: '/', audience: 'vendor' })
    expect(h).not.toContain('role="tablist"')
    expect(h).toContain('<h1>Vendor sign-in</h1>')
    expect(h).toContain('For XULO staff. Schools sign in at their own address.')
  })

  it('fills the brand panel with cross-fading pictures when slides are set, escaping URLs', () => {
    const h = loginHTML({ csrf: 'c', next: '/', brand: { ...brand, slides: ['/a.png', '/b.png?x="><script>'] } })
    expect(h).toContain('auth-split has-slides')
    expect(h).toContain('<aside class="auth-brand has-slides">')
    expect(h).not.toContain('class="mesh"')
    expect(h).toContain('<img src="/a.png" alt="" class="on" fetchpriority="high" decoding="async">')
    expect(h.match(/loading="lazy"/g)).toHaveLength(1)
    expect(h).toContain('class="auth-brand-title"')
    expect(h).not.toContain('"><script>')
    expect(h.match(/aria-label="Picture \d \/ 2"/g)).toHaveLength(2)
    expect(h).toContain('prefers-reduced-motion')
    expect(h).not.toContain('@@')
  })

  it('phone pages: a Sign in button and a back control; a failed sign-in opens on the form', () => {
    const slides = ['/a.png', '/b.png']
    const h = loginHTML({ csrf: 'c', next: '/', brand: { ...brand, slides } })
    expect(h).toContain('<button type="button" class="auth-go">Sign in</button>')
    expect(h).toContain('class="auth-back" aria-label="Back"')
    expect(h).toContain("history.pushState({ signin: 1 }, '', '#signin')")
    expect(h).toContain('<div class="auth-split has-slides">')
    const failed = loginHTML({ csrf: 'c', next: '/', identifier: 'x', error: 'Wrong password', brand: { ...brand, slides } })
    expect(failed).toContain('<div class="auth-split has-slides p2">')
    expect(loginHTML({ csrf: 'c', next: '/', brand })).not.toContain('class="auth-go"')
  })

  it('one picture: no bars and no slide script', () => {
    const h = loginHTML({ csrf: 'c', next: '/', brand: { ...brand, slides: ['/a.png'] } })
    expect(h).toContain('auth-slides')
    expect(h).not.toContain('class="auth-bars"')
    expect(h).not.toContain("querySelector('.auth-brand.has-slides')")
  })

  it('keeps the brand panel without slides', () => {
    const h = loginHTML({ csrf: 'c', next: '/', brand })
    expect(h).toContain('class="mesh"')
    expect(h).toContain('<aside class="auth-brand">')
    expect(h).toContain('<div class="auth-split">')
    expect(h).not.toContain('class="auth-slides"')
  })
})

describe('school chooser', () => {
  it('asks for the school code and escapes its inputs', () => {
    const h = chooserHTML({ csrf: '<c>', next: '/"x', code: '"><b>', error: '<i>bad</i>' })
    expect(h).toContain('<h1>Find your school</h1>')
    expect(h).toContain('name="code"')
    expect(h).toContain('action="/login"')
    expect(h).toContain('value="&lt;c&gt;"')
    expect(h).toContain('value="/&#34;x"')
    expect(h).toContain('value="&#34;&gt;&lt;b&gt;"')
    expect(h).toContain('&lt;i&gt;bad&lt;/i&gt;')
    expect(h).not.toContain('<i>bad')
    expect(h).not.toContain('name="password"')
    expect(chooserHTML({ csrf: 'c', next: '/', lang: 'te' })).toContain('స్కూల్ కోడ్')
  })
})
