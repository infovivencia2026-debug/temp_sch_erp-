/* THE HALL TICKET, AS PRINTED (owner's design, 2026-10-07): a bordered half-A4
   card -- logo, school, affiliation line and the exam banner across the top
   with the candidate's photograph (or a box to affix one) on the right; the
   candidate's particulars two to a row; the papers with an invigilator's
   signature column; the instructions; the verification code and the
   candidate's and principal's signatures. Inter, like every print. */

export interface HallTicketPrint {
  school: string
  logoUrl?: string
  photoUrl?: string
  affiliation?: string
  place?: string
  examName: string
  academicYear?: string
  studentName: string
  guardianLabel: string
  guardianName?: string
  ticketNo: string
  admissionNo: string
  classSection: string
  hall: string
  seat: string
  papers: { subject: string; date?: string; starts_at?: string; duration_minutes?: number; max_marks?: number }[]
  instructions: string[]
  verificationCode: string
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const dmy = (iso?: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : '—' }
const clock = (hm: string, addMin = 0) => {
  const [h, m] = hm.split(':').map(Number)
  const t = h * 60 + m + addMin
  const hh = Math.floor(t / 60) % 24, mm = t % 60
  return `${String(((hh + 11) % 12) + 1).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`
}
const timing = (p: HallTicketPrint['papers'][number]) =>
  !p.starts_at ? '—' : p.duration_minutes ? `${clock(p.starts_at)} – ${clock(p.starts_at, p.duration_minutes)}` : clock(p.starts_at)

export function hallTicketHtml(o: HallTicketPrint): string {
  const rows = o.papers.map((p, i) => `<tr><td class="c">${String(i + 1).padStart(2, '0')}</td><td>${esc(p.subject)}</td><td>${dmy(p.date)}</td><td>${timing(p)}</td><td class="c">${p.max_marks ?? '—'}</td><td></td></tr>`).join('')
  const sub = [o.affiliation, o.place].filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Hall Ticket - ${esc(o.studentName)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&amp;display=swap"><style>
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
body { font-family: 'Inter', sans-serif; color: #111827; font-size: 13px; line-height: 1.4; background: #fff; }
.hall-ticket { max-width: 800px; margin: 0 auto; border: 2px solid #1f2937; border-radius: 4px; padding: 20px 24px; page-break-inside: avoid; }
.header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #1f2937; padding-bottom: 12px; margin-bottom: 14px; }
.school-logo { width: 70px; height: 70px; object-fit: contain; }
.logo-ph { width: 70px; height: 70px; border-radius: 50%; border: 2px solid #1f2937; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #6b7280; }
.school-meta { flex: 1; text-align: center; padding: 0 16px; }
.school-title { font-size: 22px; font-weight: 800; letter-spacing: .5px; text-transform: uppercase; margin-bottom: 2px; }
.school-sub { font-size: 11px; color: #4b5563; font-weight: 500; }
.exam-banner { display: inline-block; margin-top: 6px; padding: 3px 12px; background: #f3f4f6; border: 1px solid #d1d5db; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; }
.photo-frame { width: 85px; height: 105px; border: 1px dashed #6b7280; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 10px; color: #6b7280; background: #fafafa; text-transform: uppercase; line-height: 1.2; padding: 4px; overflow: hidden; }
.photo-frame img { width: 100%; height: 100%; object-fit: cover; }
.photo-frame.has { border: 1px solid #1f2937; padding: 0; }
.info-table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
.info-table td { padding: 4px 6px; vertical-align: top; font-size: 12.5px; }
.info-label { color: #4b5563; font-weight: 600; width: 18%; white-space: nowrap; }
.info-val { font-weight: 700; width: 32%; }
.timetable { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
.timetable th, .timetable td { border: 1px solid #9ca3af; padding: 6px 8px; font-size: 11.5px; text-align: left; }
.timetable th { background: #f3f4f6; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: #1f2937; }
.c { text-align: center !important; }
.none { border: 1px solid #9ca3af; padding: 10px; font-size: 11.5px; color: #6b7280; font-style: italic; margin-bottom: 14px; }
.instructions { border: 1px solid #e5e7eb; background: #f9fafb; padding: 8px 12px; margin-bottom: 18px; border-radius: 4px; }
.instructions-title { font-weight: 700; font-size: 10.5px; text-transform: uppercase; margin-bottom: 4px; color: #374151; }
.instructions ol { padding-left: 16px; font-size: 10px; color: #4b5563; }
.instructions li { margin-bottom: 2px; }
.footer-grid { display: flex; justify-content: space-between; align-items: flex-end; padding-top: 14px; gap: 16px; }
.verification-block { display: flex; align-items: center; gap: 8px; font-size: 11px; font-family: ui-monospace, monospace; font-weight: 600; }
.verification-block span { display: block; font-size: 9px; color: #6b7280; font-family: 'Inter', sans-serif; }
.sig-box { text-align: center; width: 180px; }
.sig-line { border-top: 1px solid #111827; margin-bottom: 4px; }
.sig-title { font-size: 10.5px; font-weight: 600; text-transform: uppercase; color: #374151; }
</style></head><body>
<div class="hall-ticket">
  <div class="header">
    ${o.logoUrl ? `<img class="school-logo" src="${esc(o.logoUrl)}" alt="">` : '<div class="logo-ph">LOGO</div>'}
    <div class="school-meta">
      <h1 class="school-title">${esc(o.school)}</h1>
      ${sub ? `<p class="school-sub">${sub}</p>` : ''}
      <div class="exam-banner">Hall Ticket &bull; ${esc(o.examName)}${o.academicYear ? ` (${esc(o.academicYear)})` : ''}</div>
    </div>
    ${o.photoUrl ? `<div class="photo-frame has"><img src="${esc(o.photoUrl)}" alt=""></div>` : '<div class="photo-frame">Affix Recent<br>Passport Size<br>Photograph</div>'}
  </div>
  <table class="info-table">
    <tr><td class="info-label">Candidate Name:</td><td class="info-val">${esc(o.studentName)}</td><td class="info-label">Roll / Ticket No:</td><td class="info-val">${esc(o.ticketNo)}</td></tr>
    <tr><td class="info-label">${esc(o.guardianLabel)}:</td><td class="info-val">${esc(o.guardianName || '—')}</td><td class="info-label">Admission No:</td><td class="info-val">${esc(o.admissionNo)}</td></tr>
    <tr><td class="info-label">Class &amp; Section:</td><td class="info-val">${esc(o.classSection)}</td><td class="info-label">Exam Hall &amp; Seat:</td><td class="info-val">${esc(o.hall)} &bull; ${esc(o.seat)}</td></tr>
  </table>
  ${o.papers.length ? `<table class="timetable"><thead><tr><th style="width:8%" class="c">S.No</th><th style="width:32%">Subject</th><th style="width:18%">Date</th><th style="width:20%">Timings</th><th style="width:9%" class="c">Marks</th><th style="width:13%" class="c">Invig. Sign</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="none">The paper timetable has not been announced yet.</p>'}
  <div class="instructions"><div class="instructions-title">Instructions to the Candidate:</div><ol>${o.instructions.map((i) => `<li>${esc(i)}</li>`).join('')}</ol></div>
  <div class="footer-grid">
    <div class="verification-block">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#111827" stroke-width="2"><rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><path d="M15 15h2v2h-2zM19 15h2v6h-6v-2h4v-4zM15 19h2v2h-2z"/></svg>
      <div><span>VERIFICATION CODE</span>${esc(o.verificationCode)}</div>
    </div>
    <div class="sig-box"><div class="sig-line"></div><div class="sig-title">Candidate's Signature</div></div>
    <div class="sig-box"><div class="sig-line"></div><div class="sig-title">Principal / In-Charge</div></div>
  </div>
</div>
</body></html>`
}
