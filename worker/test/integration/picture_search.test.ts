/* Picture suggestions: only key words go to the library, Openverse first and
   Commons when it fails, clip art before photos, and the picture route fetches
   only from the libraries' own hosts. The libraries are stubbed; nothing
   leaves the test. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { seed, api } from './fixture'

const realFetch = globalThis.fetch
let seen: string[] = []
let openverseDown = false
let noClipart = false
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
const OV = (id: string) => ({ id, title: `Apple ${id.slice(0, 4)}`, creator: 'Ann', license: 'by', license_version: '2.0', foreign_landing_url: 'https://example.org/p', url: 'https://example.org/a.jpg', filetype: 'jpg' })
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

beforeAll(async () => {
  await seed()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!/openverse\.org|wikimedia\.org|example\.org/.test(url)) return realFetch(input as RequestInfo, init)
    seen.push(url)
    const u = new URL(url)
    if (u.pathname === '/v1/images/') {
      if (openverseDown) return new Response('down', { status: 503 })
      const cat = u.searchParams.get('category')
      if (noClipart && cat === 'illustration') return Response.json({ results: [] })
      return Response.json({ results: [OV(UUID(1)), { ...OV(UUID(2)), mature: true }, { ...OV(UUID(3)), url: 'https://upload.wikimedia.org/wikipedia/commons/0/06/Red_apple.svg', filetype: 'svg' }] })
    }
    if (u.hostname === 'commons.wikimedia.org') {
      return Response.json({ query: { pages: {
        1: { title: 'File:Apple.svg', index: 1, imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Apple.svg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Apple.svg', extmetadata: { LicenseShortName: { value: 'CC0' }, Artist: { value: '<a>Bob</a>' } } }] },
        2: { title: 'File:NC.svg', index: 2, imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/NC.svg', descriptionurl: 'x', extmetadata: { LicenseShortName: { value: 'CC BY-NC 4.0' } } }] },
      } } })
    }
    if (u.pathname.endsWith('/huge.png')) return new Response(new Uint8Array(6 * 1024 * 1024), { headers: { 'Content-Type': 'image/png' } })
    if (u.pathname.endsWith('/page.png')) return new Response('<html>', { headers: { 'Content-Type': 'text/html' } })
    return new Response(PNG, { headers: { 'Content-Type': 'image/png' } })
  }) as typeof fetch
  // The first request warms the Worker up; it can take longer than one test may.
  await api('teacher', 'GET', '/exams/paper-images')
})
afterAll(() => { globalThis.fetch = realFetch })
beforeEach(() => { seen = []; openverseDown = false; noClipart = false })

describe('picture search', () => {
  it('sends only the key words and returns clip art with credits', async () => {
    const r = await api('teacher', 'GET', `/exams/picture-search?q=${encodeURIComponent('Which fruit is red? Write its name: apple. Student Ravi 9876543210')}`)
    expect(r.status).toBe(200)
    expect(r.body.q).toBe('apple student ravi')
    expect(r.body.kind).toBe('clipart')
    const sent = new URL(seen[0])
    expect(sent.searchParams.get('q')).toBe('apple student ravi clipart')
    expect(sent.searchParams.get('category')).toBe('illustration')
    expect(sent.searchParams.get('mature')).toBe('false')
    expect(seen[0]).not.toContain('9876543210')
    expect(r.body.items).toHaveLength(2) // the mature one is dropped
    expect(r.body.items[0]).toMatchObject({ thumb: `https://api.openverse.org/v1/images/${UUID(1)}/thumb/`, licence: 'CC BY 2.0', creator: 'Ann' })
    // An SVG is rendered by Commons as PNG.
    expect(r.body.items[1].full).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/0/06/Red_apple.svg/500px-Red_apple.svg.png')
  })

  it('falls back to photos when no drawing matches', async () => {
    noClipart = true
    const r = await api('teacher', 'GET', '/exams/picture-search?q=apple+tree')
    expect(r.body.kind).toBe('photo')
    expect(r.body.items.length).toBeGreaterThan(0)
  })

  it('uses Wikimedia Commons when Openverse is down, keeping only free licences', async () => {
    openverseDown = true
    const r = await api('teacher', 'GET', '/exams/picture-search?q=green+apple')
    expect(r.status).toBe(200)
    expect(r.body.items).toHaveLength(1)
    expect(r.body.items[0]).toMatchObject({ title: 'Apple', creator: 'Bob', licence: 'CC0' })
  })

  it('refuses short text and people without the exams permission', async () => {
    expect((await api('teacher', 'GET', '/exams/picture-search?q=is')).status).toBe(400)
    expect((await api('parent', 'GET', '/exams/picture-search?q=apple')).status).toBe(403)
    expect((await api(null, 'GET', '/exams/picture-search?q=apple')).status).toBe(401)
  })
})

describe('picture fetch', () => {
  const get = (u: string, who: 'teacher' | 'parent' = 'teacher') => api(who, 'GET', `/exams/picture-search/image?u=${encodeURIComponent(u)}`)

  it('returns a library picture', async () => {
    const r = await get(`https://api.openverse.org/v1/images/${UUID(1)}/thumb/`)
    expect(r.status).toBe(200)
    expect((await get('https://upload.wikimedia.org/wikipedia/commons/thumb/0/06/Red_apple.svg/330px-Red_apple.svg.png')).status).toBe(200)
  })

  it('is not an open proxy', async () => {
    for (const u of ['https://example.org/a.png', 'http://upload.wikimedia.org/wikipedia/commons/a.png', 'https://api.openverse.org/v1/images/', 'https://upload.wikimedia.org/other/a.png', 'https://upload.wikimedia.org.evil.com/wikipedia/commons/a.png']) {
      expect((await get(u)).status).toBe(400)
    }
    expect(seen).toHaveLength(0)
    expect((await get(`https://api.openverse.org/v1/images/${UUID(1)}/thumb/`, 'parent')).status).toBe(403)
  })

  it('refuses what is not a picture, or too large', async () => {
    expect((await get('https://upload.wikimedia.org/wikipedia/commons/page.png')).status).toBe(502)
    expect((await get('https://upload.wikimedia.org/wikipedia/commons/huge.png')).status).toBe(400)
  })
})
