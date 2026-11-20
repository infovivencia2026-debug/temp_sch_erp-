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
    const bad = new FormData(); bad.append('full_name', 'Ravi'); bad.append('_source', 'embed')
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

  it('a question with show only when is asked only when that answer is chosen', async () => {
    const f = await api('admin', 'POST', '/comms/website-forms', { title: 'Conditional' })
    const u = await api('admin', 'PUT', `/comms/website-forms/${f.body.id}`, { fields: [
      { label: 'Role', type: 'dropdown', required: true, options: ['Teacher', 'Other'] },
      { label: 'Please specify', type: 'text', required: true, show_if: { key: 'Role', value: 'Other' } },
    ] })
    expect(u.body.fields[1].show_if).toEqual({ key: 'role', value: 'Other' })
    const post = (b: unknown) => call(`/api/v1/public/forms/test/${f.body.slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(b as object), _source: 'embed' }) })
    expect((await post({ role: 'Teacher' })).status).toBe(201)
    expect((await post({ role: 'Other' })).status).toBe(400)
    expect((await post({ role: 'Other', please_specify: 'Librarian' })).status).toBe(201)
  })

  it('a choose-one question needs exactly one of its choices when required', async () => {
    const f = await api('admin', 'POST', '/comms/website-forms', { title: 'Saturdays' })
    const u = await api('admin', 'PUT', `/comms/website-forms/${f.body.id}`, { fields: [
      { label: 'Willing to work on Saturdays?', type: 'choice', required: true, options: ['Yes', 'No'] },
    ] })
    expect(u.status).toBe(200)
    expect(u.body.fields[0]).toMatchObject({ type: 'choice', options: ['Yes', 'No'] })
    expect((await api('admin', 'PUT', `/comms/website-forms/${f.body.id}`, { fields: [{ label: 'Q', type: 'choice', options: [] }] })).status).toBe(400)
    const post = (b: unknown) => call(`/api/v1/public/forms/test/${f.body.slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(b as object), _source: 'embed' }) })
    expect((await post({})).status).toBe(400)
    expect((await post({ willing_to_work_on_saturdays: 'Maybe' })).status).toBe(400)
    expect((await post({ willing_to_work_on_saturdays: 'No' })).status).toBe(201)
  })

  it('a full response replaces only its own short first step', async () => {
    const f = await api('admin', 'POST', '/comms/website-forms', { title: 'Two step' })
    await api('admin', 'PUT', `/comms/website-forms/${f.body.id}`, { fields: [
      { label: 'Name', type: 'text', required: true }, { label: 'Mobile', type: 'phone', required: true },
      { label: 'Saturdays', type: 'choice', required: true, options: ['Yes', 'No'] },
    ] })
    const send = (b: Record<string, string>) => call(`/api/v1/public/forms/test/${f.body.slug}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.9.9.9' }, body: JSON.stringify(b) })
    const s1 = await (await send({ name: 'Ravi', mobile: '9876543210', application_stage: 'Step 1' })).json() as { id: string }
    const other = await (await send({ name: 'Sita', mobile: '9876500000' })).json() as { id: string }
    expect((await send({ name: 'Ravi', mobile: '9876543210', saturdays: 'Yes', application_stage: 'Completed', _source: 'embed', _replaces: s1.id })).status).toBe(201)
    expect((await send({ name: 'Ravi', mobile: '9876543210', saturdays: 'No', _source: 'embed', _replaces: other.id })).status).toBe(201)
    const list = await api('admin', 'GET', `/comms/website-forms/${f.body.id}/responses`)
    const ids = (list.body.items as { id: string }[]).map((x) => x.id)
    expect(ids).not.toContain(s1.id)
    expect(ids).toContain(other.id)
    expect(ids.length).toBe(3)
  })

  it('a scored test updates its own row in place by test code', async () => {
    const f = await api('admin', 'POST', '/comms/website-forms', { title: 'Quest scored' })
    await api('admin', 'PUT', `/comms/website-forms/${f.body.id}`, { fields: [{ label: 'Student name', type: 'text', required: true }] })
    const send = (b: Record<string, string>) => call(`/api/v1/public/forms/test/${f.body.slug}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.9.9.8' }, body: JSON.stringify(b) })
    const a = await (await send({ student_name: 'Ravi', test_code: 'QST-1111', status: 'registered' })).json() as { id: string }
    const b = await (await send({ student_name: 'Sita', test_code: 'QST-2222', status: 'registered' })).json() as { id: string }
    const u = await send({ student_name: 'Ravi', test_code: 'QST-1111', status: 'submitted', score: '40', _replaces: a.id })
    expect(u.status).toBe(200)
    expect(((await u.json()) as { id: string }).id).toBe(a.id)
    expect((await send({ student_name: 'X', test_code: 'QST-9999', score: '60', _replaces: b.id })).status).toBe(201)
    const list = await api('admin', 'GET', `/comms/website-forms/${f.body.id}/responses`)
    const rows = list.body.items as { id: string; data: Record<string, string> }[]
    expect(rows.find((x) => x.id === a.id)?.data.score).toBe('40')
    expect(rows.find((x) => x.id === b.id)?.data.test_code).toBe('QST-2222')
    expect(rows.length).toBe(3)
  })
})
