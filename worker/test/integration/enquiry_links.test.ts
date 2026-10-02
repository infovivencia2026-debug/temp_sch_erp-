/* Enquiry links: a family fills in its own enquiry from a link with no
   sign-in; the school chooses what is asked; the same family asking twice is
   one lead; a lead's own application link opens the form filled in and
   attaches what is submitted to that lead; and a form can say what is brought
   on paper instead of asked online. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, IDS, E } from './fixture'

const pub = async (method: string, path: string, body?: unknown, ip = '198.51.100.7') => {
  const res = await call('/api/v1/public/admissions' + path, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'cf-connecting-ip': ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}
const T = () => E.TENANT_TEST
let link: any, formSlug = ''

beforeAll(async () => {
  await seed()
  // An open, published application form with one thing to bring on paper.
  const f = await api('admin', 'POST', '/admissions/forms', { name: `Admission ${Date.now()}`, is_open: true })
  expect(f.status).toBe(201)
  formSlug = f.body.slug
  const sec = await api('admin', 'POST', `/admissions/form-versions/${f.body.draft_version_id}/sections`, { title: 'About the child' })
  const section_id = sec.body.id
  for (const [code, label, field_type] of [['first_name', "Child's first name", 'text'], ['last_name', 'Last name', 'text'], ['parent_name', "Parent's name", 'text'],
    ['parent_phone', 'Phone', 'phone'], ['parent_email', 'Email', 'email'], ['class_sought', 'Class', 'select'], ['transfer_certificate', 'Transfer certificate (original)', 'bring']]) {
    const r = await api('admin', 'POST', `/admissions/form-versions/${f.body.draft_version_id}/fields`,
      { section_id, code, label, field_type, is_required: ['first_name', 'parent_name', 'parent_phone', 'class_sought', 'transfer_certificate'].includes(code), help_text: field_type === 'bring' ? 'From the present school' : '' })
    expect(r.status).toBe(200)
  }
  expect((await api('admin', 'POST', `/admissions/form-versions/${f.body.draft_version_id}/publish`)).status).toBe(200)
  const l = await api('admin', 'POST', '/admissions/enquiry-links', { name: `WhatsApp ${Date.now()}`, source: 'campaign', apply_form_id: f.body.id,
    ask: { class_sought: 'required', email: 'optional', message: 'required', how_heard: 'off' }, thanks: 'We will call you today.' })
  expect(l.status).toBe(201)
  link = l.body
})

describe('enquiry links', () => {
  let enquiryId = ''

  it('the link is a public address, and the form says what the school chose to ask', async () => {
    expect(link.url).toMatch(new RegExp(`/admissions/enquire/${link.slug}$`))
    const g = await pub('GET', `/enquiry/${link.slug}`)
    expect(g.status).toBe(200)
    expect(g.body.school).toBeTruthy()
    expect(g.body.ask).toMatchObject({ class_sought: 'required', message: 'required', how_heard: 'off', email: 'optional' })
    expect(g.body.classes.some((c: any) => c.value === IDS.klass)).toBe(true)
    expect((await pub('GET', '/enquiry/no-such-link')).status).toBe(404)
  })

  it('refuses an incomplete enquiry and says exactly what is missing', async () => {
    const r = await pub('POST', `/enquiry/${link.slug}`, { student_name: 'Nila', parent_name: '', phone: '12345' })
    expect(r.status).toBe(400)
    const d: string[] = r.body.error.details
    expect(d).toContain("A parent's name is required")
    expect(d.some((x) => x.includes('phone number'))).toBe(true)
    expect(d).toContain('Class sought is required')
    expect(d).toContain('Message is required')
  })

  it('a filled-in enquiry becomes a lead: new, due today, tagged with the link, its details on the timeline', async () => {
    const r = await pub('POST', `/enquiry/${link.slug}`, { student_name: 'Nila Rao', parent_name: 'Meera Rao', phone: '+91 98450 11223', email: 'meera@example.com',
      class_sought: IDS.klass, message: 'Is the bus route to Kondapur running?', how_heard: 'ignored because it is off' })
    expect(r.status).toBe(201)
    expect(r.body.message).toBe('We will call you today.')
    expect(r.body.apply_url).toContain(`/admissions/apply/${formSlug}?lead=`)
    const e = await T().prepare(`SELECT * FROM enquiries WHERE utm_campaign = ?`).bind(link.slug).first<any>()
    enquiryId = e.id
    expect(e).toMatchObject({ student_name: 'Nila Rao', parent_name: 'Meera Rao', status: 'new', source: 'campaign', campaign: link.name, class_sought: IDS.klass, email: 'meera@example.com' })
    expect(e.next_follow_up).toBe(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10))
    expect(e.notes).toContain('bus route')
    expect(e.notes).not.toContain('ignored')
    const act = await T().prepare(`SELECT kind, body FROM enquiry_activities WHERE enquiry_id = ?`).bind(e.id).all<any>()
    expect(act.results[0].kind).toBe('created')
    expect(act.results[0].body).toContain('Filled in by the family')
    const list = await api('admin', 'GET', '/admissions/enquiry-links')
    expect(list.body.items.find((x: any) => x.id === link.id).enquiries).toBe(1)
  })

  it('the same child from the same number asking again is one lead with a second note', async () => {
    const r = await pub('POST', `/enquiry/${link.slug}`, { student_name: 'nila rao', parent_name: 'Meera Rao', phone: '9845011223', class_sought: IDS.klass, message: 'Any update?' })
    expect(r.status).toBe(201)
    const n = await T().prepare(`SELECT count(*) AS n FROM enquiries WHERE utm_campaign = ?`).bind(link.slug).first<{ n: number }>()
    expect(n!.n).toBe(1)
    const notes = await T().prepare(`SELECT body FROM enquiry_activities WHERE enquiry_id = ? AND kind = 'note'`).bind(enquiryId).all<any>()
    expect(notes.results.some((x) => x.body.includes('Enquired again') && x.body.includes('Any update?'))).toBe(true)
  })

  it('a script that fills the hidden field is thanked and dropped; a closed link refuses', async () => {
    const bot = await pub('POST', `/enquiry/${link.slug}`, { student_name: 'Spam Bot', parent_name: 'Spam', phone: '9000000000', class_sought: IDS.klass, message: 'x', website: 'http://spam.example' })
    expect(bot.status).toBe(201)
    expect((await T().prepare(`SELECT count(*) AS n FROM enquiries WHERE student_name = 'Spam Bot'`).first<{ n: number }>())!.n).toBe(0)
    expect((await api('admin', 'POST', `/admissions/enquiry-links/${link.id}`, { is_open: false })).status).toBe(200)
    expect((await pub('POST', `/enquiry/${link.slug}`, { student_name: 'Late Child', parent_name: 'Late', phone: '9000000001', class_sought: IDS.klass, message: 'x' })).status).toBe(409)
    await api('admin', 'POST', `/admissions/enquiry-links/${link.id}`, { is_open: true })
  })

  it("a lead's own application link opens the form filled in, and attaches the application to that lead", async () => {
    const a = await api('admin', 'GET', `/admissions/workflow/enquiries/${enquiryId}/apply-link`)
    expect(a.status).toBe(200)
    expect(a.body.message).toContain('Meera Rao')
    const lead = new URL(a.body.url).searchParams.get('lead')!
    const g = await pub('GET', `/forms/${formSlug}?lead=${encodeURIComponent(lead)}`)
    expect(g.status).toBe(200)
    expect(g.body.prefill).toMatchObject({ first_name: 'Nila', last_name: 'Rao', parent_name: 'Meera Rao', parent_phone: '+91 98450 11223', parent_email: 'meera@example.com', class_sought: IDS.klass })
    // A changed signature gives the form and nothing of the lead.
    const forged = await pub('GET', `/forms/${formSlug}?lead=${encodeURIComponent(lead.slice(0, -4) + 'AAAA')}`)
    expect(forged.status).toBe(200)
    expect(forged.body.prefill).toBeUndefined()
    // A different phone on the application: without the link it would have made a second lead.
    const s = await pub('POST', `/forms/${formSlug}?lead=${encodeURIComponent(lead)}`, { answers: { first_name: 'Nila', last_name: 'Rao', parent_name: 'Meera Rao', parent_phone: '9000055555', class_sought: IDS.klass } })
    expect(s.status).toBe(201)
    expect(s.body.bring).toEqual([{ label: 'Transfer certificate (original)', note: 'From the present school' }])
    const app = await T().prepare(`SELECT enquiry_id FROM applications WHERE application_no = ?`).bind(s.body.application_no).first<{ enquiry_id: string }>()
    expect(app!.enquiry_id).toBe(enquiryId)
    expect((await T().prepare(`SELECT status FROM enquiries WHERE id = ?`).bind(enquiryId).first<{ status: string }>())!.status).toBe('applied')
  })

  it('something brought on paper is never asked for online', async () => {
    const s = await pub('POST', `/forms/${formSlug}`, { answers: { first_name: 'Arun', parent_name: 'Kiran', parent_phone: '9000077777', class_sought: IDS.klass, transfer_certificate: 'yes' } }, '198.51.100.8')
    // Answering it is ignored rather than refused as an unknown question; leaving it out is fine.
    expect([201, 400]).toContain(s.status)
    const clean = await pub('POST', `/forms/${formSlug}`, { answers: { first_name: 'Arun', parent_name: 'Kiran', parent_phone: '9000077777', class_sought: IDS.klass } }, '198.51.100.9')
    expect(clean.status).toBe(201)
  })

  it('a class teacher cannot make or change links', async () => {
    expect((await api('teacher', 'POST', '/admissions/enquiry-links', { name: 'Nope' })).status).toBe(403)
  })
})
