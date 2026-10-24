import { describe, expect, it } from 'vitest'
import { chooserHTML, loginHTML } from '../../src/auth/login-page'

const brand = { name: 'Test School', action: '/login' }

describe('sign-in page', () => {
  it('shows Parent, Student and Staff tabs on a school page, hidden until the script runs', () => {
    const h = loginHTML({ csrf: 'c', next: '/', brand })
    expect(h).toContain('role="tablist"')
    expect(h).toMatch(/<div class="who" role="tablist"[^>]* hidden>/)
    for (const t of ['Parent', 'Student', 'Staff']) expect(h).toContain(`>${t}</button>`)
    expect(h).toContain('name="identifier"')
    expect(h).toContain('>Username, email or phone</label>')
    expect(h).not.toContain('@@')
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

  it('replaces the brand panel with a gallery when slides are set, escaping URLs', () => {
    const h = loginHTML({ csrf: 'c', next: '/', brand: { ...brand, slides: ['/a.png', '/b.png?x="><script>'] } })
    expect(h).toContain('auth-split has-gallery')
    expect(h).not.toContain('class="mesh"')
    expect(h).toContain('<img src="/a.png" alt="" decoding="async">')
    expect(h).toContain('loading="lazy"')
    expect(h).not.toContain('"><script>')
    expect(h.match(/aria-label="Picture \d \/ 2"/g)).toHaveLength(2)
  })

  it('keeps the brand panel without slides', () => {
    const h = loginHTML({ csrf: 'c', next: '/', brand })
    expect(h).toContain('class="mesh"')
    expect(h).not.toContain('auth-split has-gallery')
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
