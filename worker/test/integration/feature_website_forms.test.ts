/* Website forms (communication.website_forms): a form built in the ERP takes
   responses from the school's website, by the embedded page and by the
   website's own form posting straight to the public address. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call } from './fixture'

describe('communication.website_forms', () => {
  let formId = '', slug = ''
  beforeAll(async () => {
    await seed()
    const f = await api('admin', 'POST', '/comms/website-forms', { title: 'Careers' })
    expect(f.status).toBe(201)
    formId = f.body.id; slug = f.body.slug
    const u = await api('admin', 'PUT', `/comms/website-forms/${formId}`, {
      fields: [
        { label: 'Role', type: 'dropdown', required: true, options: ['Teacher', 'Driver'] },
        { label: 'Full name', type: 'text', required: true },
        { label: 'Mobile number', type: 'phone', required: true },
        { label: 'Resume', type: 'file', required: false },
      ],
    })
    expect(u.status).toBe(200)
  })

  it('a teacher cannot build forms', async () => {
    expect((await api('teacher', 'POST', '/comms/website-forms', { title: 'X' })).status).toBe(403)
  })

  it('the public page reads the form without signing in', async () => {
    const r = await call(`/api/v1/public/forms/test/${slug}`)
    expect(r.status).toBe(200)
    const b = await r.json() as { fields: { key: string }[] }
    expect(b.fields.map((f) => f.key)).toEqual(['role', 'full_name', 'mobile_number', 'resume'])
  })

  it('the embed posts multipart with a file; required answers are checked', async () => {
    const bad = new FormData(); bad.append('full_name', 'Ravi')
    expect((await call(`/api/v1/public/forms/test/${slug}`, { method: 'POST', body: bad })).status).toBe(400)
    const fd = new FormData()
    fd.append('role', 'Teacher'); fd.append('full_name', 'Ravi Kumar'); fd.append('mobile_number', '9876543210'); fd.append('_source', 'embed')
    fd.append('resume', new File(['%PDF-1.4 cv'], 'cv.pdf', { type: 'application/pdf' }))
    const r = await call(`/api/v1/public/forms/test/${slug}`, { method: 'POST', body: fd })
    expect(r.status).toBe(201)
  })

  it("the website's own form posts JSON with extra fields, all kept", async () => {
    const r = await call(`/api/v1/public/forms/test/${slug}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'Driver', full_name: 'Sita', mobile_number: '9123456789', city: 'Hyderabad' }),
    })
    expect(r.status).toBe(201)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('responses list with date, time, source and the file', async () => {
    const r = await api('admin', 'GET', `/comms/website-forms/${formId}/responses`)
    expect(r.status).toBe(200)
    const items = r.body.items as { data: Record<string, string>; files: { key: string }[]; source: string; created_at: string }[]
    expect(items).toHaveLength(2)
    const post = items.find((x) => x.source === 'post')!, embed = items.find((x) => x.source === 'embed')!
    expect(post.data.city).toBe('Hyderabad')
    expect(embed.files[0].key).toBe('resume')
    expect(embed.created_at).toMatch(/T\d{2}:\d{2}/)
  })

  it('a closed form takes no responses', async () => {
    await api('admin', 'PUT', `/comms/website-forms/${formId}`, { is_open: false })
    const r = await call(`/api/v1/public/forms/test/${slug}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: 'Late' }),
    })
    expect(r.status).toBe(409)
  })

  it('a response and then the form can be deleted', async () => {
    const list = await api('admin', 'GET', `/comms/website-forms/${formId}/responses`)
    const one = list.body.items[0].id
    expect((await api('teacher', 'DELETE', `/comms/website-forms/${formId}/responses/${one}`)).status).toBe(403)
    expect((await api('admin', 'DELETE', `/comms/website-forms/${formId}/responses/${one}`)).status).toBe(200)
    expect((await api('admin', 'GET', `/comms/website-forms/${formId}/responses`)).body.items).toHaveLength(1)
    expect((await api('admin', 'DELETE', `/comms/website-forms/${formId}`)).status).toBe(200)
    expect((await call(`/api/v1/public/forms/test/${slug}`)).status).toBe(404)
  })
})
