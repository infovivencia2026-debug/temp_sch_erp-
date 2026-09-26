import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

/* PDF drawing for the Worker, the pdf-lib counterpart of go-pdf/fpdf as the Go
   API used it (report_digest_pdf.go): A4 portrait, millimetre layout, the
   core Helvetica ("Arial" in fpdf) fonts only, MultiCell text flow with auto
   page break. */

const MM = 72 / 25.4
const A4: [number, number] = [210 * MM, 297 * MM]

/** pdfSafe from report_digest_pdf.go: ₹ becomes "Rs ", anything above Latin-1 is dropped. */
export function pdfSafe(s: string): string {
  s = s.replace(/₹/g, 'Rs ')
  let out = ''
  // C0/C1 controls (other than newline) are also dropped: pdf-lib's WinAnsi encoder throws on them.
  for (const ch of s) { const c = ch.codePointAt(0)!; if (c <= 0xFF && (c === 10 || (c >= 0x20 && c !== 0x7F && (c < 0x80 || c > 0x9F)))) out += ch }
  return out
}

/** A tiny fpdf: margins, a cursor, MultiCell with word wrap and auto page break. */
export class FlowPDF {
  private page!: PDFPage
  private y = 0 // mm from top
  private font!: PDFFont
  private size = 11
  private color = rgb(0, 0, 0)
  private constructor(private doc: PDFDocument, private regular: PDFFont, private bold: PDFFont, private margin: number) {}

  static async create(marginMM = 18): Promise<FlowPDF> {
    const doc = await PDFDocument.create()
    const f = new FlowPDF(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold), marginMM)
    f.font = f.regular
    f.addPage()
    return f
  }
  addPage(): void { this.page = this.doc.addPage(A4); this.y = this.margin }
  setFont(style: '' | 'B', sizePt: number): void { this.font = style === 'B' ? this.bold : this.regular; this.size = sizePt }
  setTextColor(r: number, g: number, b: number): void { this.color = rgb(r / 255, g / 255, b / 255) }
  ln(hMM: number): void { this.y += hMM }

  private wrap(text: string, widthPt: number): string[] {
    const lines: string[] = []
    for (const para of text.replace(/\r/g, '').split('\n')) {
      let line = ''
      for (const word of para.split(' ')) {
        const cand = line === '' ? word : line + ' ' + word
        if (this.font.widthOfTextAtSize(cand, this.size) <= widthPt || line === '') {
          // A single word wider than the line is broken by characters, as fpdf does.
          if (line === '' && this.font.widthOfTextAtSize(cand, this.size) > widthPt) {
            let part = ''
            for (const ch of cand) {
              if (part !== '' && this.font.widthOfTextAtSize(part + ch, this.size) > widthPt) { lines.push(part); part = '' }
              part += ch
            }
            line = part
          } else line = cand
        } else { lines.push(line); line = word }
      }
      lines.push(line)
    }
    return lines
  }

  /** MultiCell(0, h, text, "", "L", false): full-width left-aligned block, h mm per line. */
  multiCell(hMM: number, text: string): void {
    const width = (210 - 2 * this.margin) * MM
    for (const line of this.wrap(pdfSafe(text), width)) {
      if (this.y + hMM > 297 - this.margin) this.addPage()
      // Baseline placed the way fpdf centres text in the cell: mid-line plus ~0.3 of the font size.
      const base = this.y + hMM / 2 + 0.3 * this.size / MM
      this.page.drawText(line, { x: this.margin * MM, y: (297 - base) * MM, size: this.size, font: this.font, color: this.color })
      this.y += hMM
    }
  }
  save(): Promise<Uint8Array> { return this.doc.save() }
}

export const DIGEST_REPORT_LABELS: Record<string, string> = {
  attendance_summary: 'Student attendance',
  fees_collected_dues: 'Fees: collected & dues',
  admissions_enrolment: 'Admissions & enrolment',
  staff_attendance_leave: 'Staff attendance & leave',
}

/** renderDigestPDF from report_digest_pdf.go, line for line. rangeLabel is digestRange.Label. */
export async function renderDigestPDF(school: string, periodWord: string, rangeLabel: string,
  reports: string[], blocks: Record<string, string>): Promise<Uint8Array> {
  const pdf = await FlowPDF.create(18)
  pdf.setFont('B', 18)
  pdf.multiCell(9, school + ' · Report digest')
  pdf.setFont('', 11)
  pdf.setTextColor(90, 90, 90)
  pdf.multiCell(6, `${periodWord} digest for ${rangeLabel}`)
  pdf.setTextColor(0, 0, 0)
  pdf.ln(4)
  for (const k of reports) {
    pdf.setFont('B', 13)
    pdf.multiCell(7, DIGEST_REPORT_LABELS[k] || k)
    pdf.setFont('', 11)
    let body = blocks[k] ?? ''
    if (body.trim() === '') body = 'Nothing to report for this period.'
    pdf.multiCell(6, body)
    pdf.ln(4)
  }
  return pdf.save()
}
