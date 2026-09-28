/* Documents: every PDF the Worker produces is a real, non-empty PDF in the
   school's document design -- letterhead with the school's name, pages, a
   rupee sign that survives -- and the printable HTML documents carry the
   school's letterhead and never the product's name. */
import { describe, it, expect, beforeAll } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { seed, api, as, call, IDS, E } from './fixture'
import { SchoolPDF, inr, readableAccent, schoolFacts } from '../../src/services/document'
import { renderDigestPDF } from '../../src/services/pdf'
import { reportCardCSS } from '../../src/routes/exams/template'

beforeAll(seed)

const SCHOOL = 'Test Public School'

/** A valid PDF with at least one page, content on every page, and the
 *  school's name in its metadata (the text itself is subset-font glyphs). */
async function assertSchoolPDF(bytes: Uint8Array, name: string, minPages = 1): Promise<PDFDocument> {
  expect(bytes.byteLength).toBeGreaterThan(2000)
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  expect(new TextDecoder().decode(bytes.slice(-8))).toContain('%%EOF')
  const doc = await PDFDocument.load(bytes)
  expect(doc.getPageCount()).toBeGreaterThanOrEqual(minPages)
  expect(doc.getAuthor()).toBe(name)
  for (const page of doc.getPages()) {
    const contents = page.node.Contents()
    expect(contents, 'every page has drawing on it').toBeTruthy()
  }
  expect((doc.getAuthor() ?? '') + (doc.getTitle() ?? '')).not.toMatch(/wisen/i)
  return doc
}

describe('document design helpers', () => {
  it('groups rupees the Indian way', () => {
    expect(inr(1234567850)).toBe('₹1,23,45,678.50')
    expect(inr(100000)).toBe('₹1,000')
    expect(inr(0, true)).toBe('₹0.00')
    expect(inr(-450000)).toBe('-₹4,500')
  })

  it('keeps a readable brand colour and replaces a pale one', () => {
    expect(readableAccent('#0F766E')).toBe('#0f766e')
    expect(readableAccent('#fde68a')).toBe('#1f2937')
    expect(readableAccent(null)).toBe('#1f2937')
  })

  it('reads the letterhead from the school, falling back to its name alone', async () => {
    const f = await schoolFacts(E.TENANT_TEST, { id: IDS.school, name: SCHOOL, primary_color: '#1e40af' })
    expect(f.name).toBeTruthy()
    expect(f.accent).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('paints the built-in report card in the school colour', () => {
    const css = reportCardCSS('Arial', '#0f766e')
    expect(css).toContain('#0f766e')
    expect(css).not.toContain('__ACCENT__')
    expect(css).not.toContain('__FONT__')
  })
})

describe('PDFs', () => {
  it('draws a long table over several pages with the rupee sign, long names and no logo', async () => {
    const pdf = await SchoolPDF.create({ name: SCHOOL, accent: '#1e40af' }, { title: 'Fee register', docNo: 'REG-1' })
    const rows = Array.from({ length: 120 }, (_, i) => [String(i + 1),
      i % 5 ? 'Aarav' : 'Venkata Naga Sai Lakshmi Prasanna Kumari Bhimavarapu Chowdary Garu', inr(12345678 * (i + 1))])
    pdf.table([{ label: '#', width: 0.5 }, { label: 'Student', width: 4 }, { label: 'Amount', width: 2, align: 'right' }], rows)
    await assertSchoolPDF(await pdf.save(), SCHOOL, 3)
  })

  it('renders the report digest with the school letterhead', async () => {
    const f = { name: SCHOOL, accent: '#1e40af', address: '1 School Road, Hyderabad 500001', phone: '+91 90000 00000' }
    const bytes = await renderDigestPDF(f, null, 'Weekly', '1 to 7 Sept 2026', ['fees_collected_dues', 'attendance_summary'],
      { fees_collected_dues: `Collected: ${inr(1234500)} across 3 receipts.`, attendance_summary: '' })
    await assertSchoolPDF(bytes, SCHOOL)
  })

  it('serves the school its subscription invoice as a real PDF, never an empty one', async () => {
    const id = crypto.randomUUID()
    const t = new Date().toISOString()
    await E.CONTROL.prepare(`INSERT INTO billing_invoices (id, institution_id, number, fy, seq, issued_on, due_on, description,
        amount_paise, gst_rate_bp, gst_paise, total_paise, paid_paise, status, created_at, updated_at)
        VALUES (?, ?, 'WS/2026-27/0001', '2026-27', 1, '2026-09-01', '2026-09-15', 'Annual subscription', 10000000, 1800, 1800000, 11800000, 0, 'issued', ?, ?)`)
      .bind(id, IDS.school, t, t).run()
    const res = await call(`/api/v1/school-billing/invoices/${id}/pdf`, { cookie: await as('admin') })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    const bytes = new Uint8Array(await res.arrayBuffer())
    // The seller's invoice: its letterhead is the seller's, the school is the one billed.
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(bytes.byteLength).toBeGreaterThan(2000)
    expect(doc.getSubject() ?? '').toBe('')
    expect(doc.getTitle()).toContain('WS/2026-27/0001')
  })
})

describe('printable HTML documents', () => {
  it('prints a bonafide certificate on the school letterhead', async () => {
    const issue = await api('admin', 'POST', '/lifecycle/certificates', { student_id: IDS.child, type_code: 'BONAFIDE', reason: 'Passport' })
    expect(issue.status).toBe(201)
    const list = await api('admin', 'GET', '/lifecycle/certificates')
    const cert = (list.body.items as { id: string; serial_no: string }[]).find((c) => c.serial_no === issue.body.serial_no)!
    const { status, body } = await api('admin', 'GET', `/lifecycle/certificates/${cert.id}/render`)
    expect(status).toBe(200)
    expect(body.html).toContain(SCHOOL)
    expect(body.html).toContain('Bonafide Certificate')
    expect(body.html).toContain(issue.body.serial_no)
    expect(body.html).toContain('This is to certify that')
    expect(body.html).not.toMatch(/wisen/i)
    expect(body.css).toContain('@media print')
  })

  it('prints the staff overview on the school letterhead', async () => {
    const { status, body } = await api('admin', 'GET', '/hr/staff/overview/report')
    expect(status).toBe(200)
    expect(body.html).toContain(SCHOOL)
    expect(body.html).toContain('Staff overview')
    expect(body.html).not.toMatch(/wisen/i)
  })
})
