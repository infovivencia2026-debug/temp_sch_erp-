import { SchoolPDF, type SchoolFacts } from './document'

/* The report digest as a PDF, in the school's document design
   (services/document.ts). This file used to carry a tiny fpdf port with the
   PDF standard fonts, which cannot draw a rupee sign; every PDF now goes
   through SchoolPDF. */

export const DIGEST_REPORT_LABELS: Record<string, string> = {
  attendance_summary: 'Student attendance',
  fees_collected_dues: 'Fees: collected & dues',
  admissions_enrolment: 'Admissions & enrolment',
  staff_attendance_leave: 'Staff attendance & leave',
}

/** The digest: one section per report, the school's letterhead on top. */
export async function renderDigestPDF(school: SchoolFacts, logo: Uint8Array | null, periodWord: string, rangeLabel: string,
  reports: string[], blocks: Record<string, string>): Promise<Uint8Array> {
  const pdf = await SchoolPDF.create(school, { title: `${periodWord} report digest`, subtitle: rangeLabel, logo })
  for (const k of reports) {
    pdf.heading(DIGEST_REPORT_LABELS[k] || k)
    let body = blocks[k] ?? ''
    if (body.trim() === '') body = 'Nothing to report for this period.'
    /* The blocks are sentences run together ("Collected: X. Overdue: Y.");
       one fact to a line reads as a summary rather than a paragraph. */
    for (const line of body.split(/(?<=\.)\s+(?=[A-Z])/)) pdf.paragraph(line)
    pdf.space(6)
  }
  return pdf.save()
}
