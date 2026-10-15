import type { Ctx } from '../../router'
import { isUUID } from '../../http'
import { schoolFacts } from '../../services/document'
import { escapeHtml, minuteOf, nameOf, num, str, todayIST, trimFloat } from './common'
import { defaultReportCardHTML, reportCardCSS, schoolFormatCSS, schoolFormatHTML } from './template'

/* The report card engine: the design, what it is filled with, and the filling.
   One copy, used by the staff screen (routes/exams.ts) and the family portal
   (routes/portal/family.ts), so a parent and the school see the same card. */

const NAME = nameOf('st')

/* WHICH PAPERS COUNT ON THE CARD (owner, Yajur, 2026-10-15: "why show all
   subjects -- only show the exams they have, by scheduled date and time;
   those are the exams they have written, and the total of those only").

   A paper is on the card when the timetable gives it a date: that is how a
   school marks a subject as examined in this exam. A paper with no date was
   set up but never sat, and printing it put "-" against a subject the child
   never wrote and its maximum into the grand total.

   Fallback: an exam whose papers (for this class) have no dates at all was
   never put on a timetable. Rather than print an empty card, the papers that
   have marks entered for the child count instead, so nothing that worked
   before breaks. es/cs/m are the aliases of exam_subjects, class_subjects and
   the child's marks row in the query this is dropped into. Used by Generate
   (stored totals, percentage, grade, rank) and by the card itself, so the
   rows printed always add up to the grand total printed. */
export function examinedPaper(es = 'es', cs = 'cs', m = 'm'): string {
  return `(${es}.exam_date IS NOT NULL OR (${m}.exam_subject_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM exam_subjects es_d JOIN class_subjects cs_d ON cs_d.id = es_d.class_subject_id
             WHERE es_d.exam_id = ${es}.exam_id AND cs_d.class_id = ${cs}.class_id AND es_d.exam_date IS NOT NULL)))`
}

export const reportCardPlaceholders = [
  { token: '{{school_name}}', means: "the school's name" },
  { token: '{{school_logo}}', means: "the school's crest, where one is configured" },
  { token: '{{school_motto}}', means: "the school's tagline, where one is configured" },
  { token: '{{academic_year}}', means: 'the academic year, e.g. 2024 - 2025' },
  { token: '{{exam_name}}', means: 'which examination this card is for' },
  { token: '{{photo}}', means: "the child's photograph, where one is on file" },
  { token: '{{student_name}}', means: "the child's full name" },
  { token: '{{father_name}}', means: "father's name, where recorded" },
  { token: '{{mother_name}}', means: "mother's name, where recorded" },
  { token: '{{guardian_name}}', means: 'the guardian on record' },
  { token: '{{class}}', means: 'class' },
  { token: '{{section}}', means: 'section' },
  { token: '{{admission_no}}', means: 'admission number' },
  { token: '{{roll_no}}', means: 'roll number' },
  { token: '{{date_of_birth}}', means: 'date of birth' },
  { token: '{{admission_date}}', means: 'date of admission' },
  { token: '{{subject_rows}}', means: 'one table row per subject, marks, percentage and grade' },
  { token: '{{performance_chart}}', means: 'a bar chart of the marks, one bar per subject' },
  { token: '{{total_marks}}', means: 'marks the exam was out of' },
  { token: '{{marks_obtained}}', means: 'marks the child scored' },
  { token: '{{percentage}}', means: 'overall percentage' },
  { token: '{{grade}}', means: 'overall grade' },
  { token: '{{result}}', means: "PASS or FAIL, on the school's own pass mark" },
  { token: '{{rank}}', means: 'rank in the section' },
  { token: '{{attendance}}', means: 'attendance percentage' },
  { token: '{{attendance_rows}}', means: 'one table row per month: days, present, absent and the percentage, with a total' },
  { token: '{{class_teacher_remarks}}', means: "the class teacher's remark on this card" },
  { token: '{{principal_remarks}}', means: "the head's remark on this card" },
  { token: '{{class_teacher}}', means: 'the class teacher who sent it for approval' },
  { token: '{{class_teacher_sign}}', means: 'their signature, once they have sent it up' },
  { token: '{{principal}}', means: 'the head who approved it' },
  { token: '{{principal_sign}}', means: 'their signature, once they have approved it' },
  { token: '{{issued_on}}', means: "today's date" },
  { token: '{{school_address}}', means: "the school's address, from its letterhead" },
  { token: '{{school_seal}}', means: "the crest in a round seal, or the school's name where there is no crest" },
  { token: '{{mobile_number}}', means: "the father's mobile, else the primary guardian's" },
  { token: '{{subject_rows_numbered}}', means: 'one row per subject: S.No, subject, total, obtained, grade, percentage' },
  { token: '{{grade_band_table}}', means: "the school's grading scale as a two-row table (percentage, grade)" },
  { token: '{{attendance_table}}', means: "the term's attendance with months across: working days, days present, total and %" },
  { token: '{{grade_chart}}', means: "bar chart of each subject's percentage with its grade, grey so it prints" },
]

/* The built-in designs a school can print on when it has not imported its
   own. "school" is the bordered format Yajur Public School sent on
   2026-10-15; "standard" is the one a0938848 made built-in. */
export const reportCardDesigns = [
  { value: 'standard', label: 'Standard' },
  { value: 'school', label: 'School format (bordered, with grade chart)' },
]

export const reportCardFonts: Record<string, string> = {
  arial: 'Arial, Helvetica, sans-serif',
  calibri: 'Calibri, Candara, Arial, sans-serif',
  times: "'Times New Roman', Times, serif",
}
const defaultReportCardFont = 'times'

export interface ReportCardTemplate {
  design: string; name: string; template_html: string; is_built_in: boolean; css?: string; font: string; updated_at?: string; updated_by?: string
}

export async function loadReportCardTemplate(c: Ctx): Promise<ReportCardTemplate> {
  const fontRow = await c.db.prepare(`SELECT json_extract(config, '$.report_card_font') AS f, json_extract(config, '$.report_card_design') AS d
      FROM module_settings WHERE module = 'examinations'`)
    .first<{ f: string | null; d: string | null }>()
  const design = fontRow?.d === 'school' ? 'school' : 'standard'
  let font = defaultReportCardFont
  if (fontRow?.f && (fontRow.f.toLowerCase() in reportCardFonts)) font = fontRow.f.toLowerCase()
  const css = reportCardCSS(reportCardFonts[font], (await schoolFacts(c.db, c.id.institution!)).accent)
  const t = await c.db.prepare(`SELECT t.name, t.template_html, ${minuteOf('t.updated_at')} AS at, u.full_name AS by
      FROM report_card_templates t LEFT JOIN users u ON u.id = t.updated_by WHERE t.institution_id = ?`)
    .bind(c.id.institution!.id).first<{ name: string; template_html: string; at: string; by: string | null }>()
  /* A school's own imported design always wins; the built-in choice only
     decides what prints when there is none, so choosing it never overwrites
     anything a school saved. */
  if (!t && design === 'school') return { design, name: 'School format', template_html: schoolFormatHTML, is_built_in: true, css: schoolFormatCSS, font }
  if (!t) return { design, name: 'Standard report card', template_html: defaultReportCardHTML, is_built_in: true, css, font }
  return { design: 'custom', name: t.name, template_html: t.template_html, is_built_in: false, font, updated_at: t.at, updated_by: t.by ?? undefined }
}

export interface RenderedCard {
  values: Record<string, string>; subjects: Record<string, string>[]; attendanceRows?: string
  attendanceTable?: string; bandTable?: string
}

interface GradeBand { grade: string; min: number; max: number }
/* The scale printed on the Yajur card, used when the exam has no grading
   scale of its own so the bands table and the grades are never blank. */
const FALLBACK_BANDS: GradeBand[] = [
  { grade: 'A1', min: 91, max: 100 }, { grade: 'A2', min: 81, max: 90 }, { grade: 'B1', min: 71, max: 80 },
  { grade: 'B2', min: 61, max: 70 }, { grade: 'C1', min: 51, max: 60 }, { grade: 'C2', min: 41, max: 50 },
  { grade: 'D', min: 33, max: 40 }, { grade: 'E', min: 0, max: 32 },
]
const bandFor = (bands: GradeBand[], pct: number) =>
  bands.find((b) => pct >= b.min && pct <= b.max)?.grade ?? bands.find((b) => pct >= b.min)?.grade ?? ''

function imgTag(id: string): string {
  const v = id.trim()
  if (!isUUID(v)) return ''
  return `<img src="/api/v1/files/${escapeHtml(v)}" alt="" style="width:100%;height:100%;max-width:100%;object-fit:cover;display:block">`
}

/* The crest keeps its own proportions at the card's crest height: the photo
   and signature tag fills its box, and a logo given that treatment filled
   the page. */
function logoTag(id: string): string {
  const v = id.trim()
  if (!isUUID(v)) return ''
  return `<img src="/api/v1/files/${escapeHtml(v)}" alt="" style="height:18mm;width:auto;max-width:60mm;object-fit:contain;display:inline-block">`
}

function stripUnknownPlaceholders(s: string): string {
  for (;;) {
    const i = s.indexOf('{{')
    if (i < 0) return s
    const j = s.indexOf('}}', i)
    if (j < 0) return s
    s = s.slice(0, i) + s.slice(j + 2)
  }
}

export function fillReportCard(tpl: string, card: RenderedCard): string {
  let rows = ''
  for (const sub of card.subjects) {
    rows += '<tr>'
    for (const k of ['subject', 'max_marks', 'marks', 'percent', 'subject_grade']) {
      // A paper marked in parts shows how its total was made, under the total.
      const parts = k === 'marks' && sub.parts ? '<div class="rc-parts" style="font-size:0.78em;opacity:0.75;white-space:nowrap">' + escapeHtml(sub.parts) + '</div>' : ''
      rows += '<td>' + escapeHtml(sub[k] ?? '') + parts + '</td>'
    }
    rows += '</tr>'
  }
  let out = tpl.split('{{subject_rows}}').join(rows)
  if (out.includes('{{subject_rows_numbered}}')) {
    let nr = ''
    card.subjects.forEach((sub, i) => {
      nr += `<tr><td>${i + 1}</td><td>${escapeHtml(sub.subject ?? '')}</td><td>${escapeHtml(sub.max_marks ?? '')}</td>`
        + `<td>${escapeHtml(sub.marks ?? '')}</td><td>${escapeHtml(sub.subject_grade ?? '')}</td><td>${escapeHtml(sub.percent ?? '')}</td></tr>`
    })
    out = out.split('{{subject_rows_numbered}}').join(nr)
  }
  if (out.includes('{{grade_chart}}')) {
    /* Pure HTML bars, sized by percentage: no script, no SVG, grey with a
       dark outline so it survives a printer that drops backgrounds. */
    let cols = ''
    for (const sub of card.subjects) {
      let pct = parseFloat((sub.percent ?? '').trim()) || 0
      pct = Math.max(0, Math.min(100, pct))
      cols += `<div class="yrc-col"><div class="yrc-barbox"><div class="yrc-bar" style="height:${pct}%">`
        + `<span class="yrc-bg">${escapeHtml(sub.subject_grade ?? '')}</span></div></div>`
        + `<div class="yrc-sub">${escapeHtml(sub.subject ?? '')}</div></div>`
    }
    const ch = card.subjects.length === 0 ? '' : '<div class="yrc-chart"><div class="yrc-y"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>'
      + `<div class="yrc-plot">${cols}</div></div>`
    out = out.split('{{grade_chart}}').join(ch)
  }
  out = out.split('{{attendance_table}}').join(card.attendanceTable ?? '')
  out = out.split('{{grade_band_table}}').join(card.bandTable ?? '')
  if (out.includes('{{school_seal}}')) {
    const lid = (card.values.logo_file_id ?? '').trim()
    const seal = isUUID(lid)
      ? `<img src="/api/v1/files/${escapeHtml(lid)}" alt="" style="width:100%;height:100%;object-fit:contain;display:block">`
      : escapeHtml(card.values.school_name ?? '')
    out = out.split('{{school_seal}}').join(seal)
  }
  if (out.includes('{{performance_chart}}')) {
    let ch = ''
    const n = card.subjects.length
    if (n > 0) {
      const bw = 34, gap = 10, base = 132, top = 8
      const w = gap + n * (bw + gap)
      ch += `<svg viewBox="0 0 ${w} 152" width="100%" style="max-width:${w}px" font-family="sans-serif">`
      card.subjects.forEach((sub, i) => {
        let pct = parseFloat((sub.percent ?? '').trim()) || 0
        if (pct < 0) pct = 0
        if (pct > 100) pct = 100
        const bh = Math.trunc((pct / 100) * (base - top)) + 5
        const x = gap + i * (bw + gap), y = base - bh
        const grade = sub.subject_grade ?? ''
        let name = sub.subject ?? ''
        if (name.length > 4) name = name.slice(0, 4)
        const fill = grade.startsWith('A1') ? '#3f6bbf' : '#6b8fd4'
        ch += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${fill}"/>`
        ch += `<text x="${x + bw / 2}" y="${y - 3}" text-anchor="middle" font-size="9">${escapeHtml(grade)}</text>`
        ch += `<text x="${x + bw / 2}" y="147" text-anchor="middle" font-size="8">${escapeHtml(name)}</text>`
      })
      ch += '</svg>'
    }
    out = out.split('{{performance_chart}}').join(ch)
  }
  out = out.split('{{attendance_rows}}').join(card.attendanceRows ?? '')
  out = out.split('{{photo}}').join(imgTag(card.values.photo_file_id ?? ''))
  out = out.split('{{school_logo}}').join(logoTag(card.values.logo_file_id ?? ''))
  out = out.split('{{class_teacher_sign}}').join(imgTag(card.values.teacher_sign_file_id ?? ''))
  out = out.split('{{principal_sign}}').join(imgTag(card.values.principal_sign_file_id ?? ''))
  for (const [k, v] of Object.entries(card.values)) {
    if (['photo_file_id', 'logo_file_id', 'teacher_sign_file_id', 'principal_sign_file_id'].includes(k)) continue
    out = out.split('{{' + k + '}}').join(escapeHtml(v))
  }
  return stripUnknownPlaceholders(out)
}

export const ddmmyyyy = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')

export async function gatherReportCard(c: Ctx, cardId: string): Promise<RenderedCard> {
  const row = await c.db.prepare(`
    SELECT COALESCE((SELECT NULLIF(TRIM(b.display_name), '') FROM branding_profiles b WHERE b.campus_id IS NULL LIMIT 1), i.name) AS school,
           COALESCE((SELECT NULLIF(b.logo_key, '') FROM branding_profiles b WHERE b.campus_id IS NULL LIMIT 1), i.logo_key) AS logo_key,
           (SELECT b.tagline FROM branding_profiles b WHERE b.campus_id IS NULL LIMIT 1) AS motto,
           ${NAME} AS student, COALESCE(c.name,'') AS class, COALESCE(sec.name,'') AS section, st.admission_no,
           e.roll_no, st.date_of_birth, st.admission_date, st.photo_file_id,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1) AS father,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1) AS mother,
           (SELECT g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1) AS guardian,
           (SELECT g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id AND COALESCE(g.phone,'') <> '' ORDER BY (g.relation = 'father') DESC, sg.is_primary DESC LIMIT 1) AS mobile,
           (SELECT ex.grading_scale_id FROM exams ex WHERE ex.id = rc.exam_id) AS scale_id,
           CAST(rc.max_marks AS REAL) AS total, CAST(rc.total_marks AS REAL) AS obtained, CAST(rc.percentage AS REAL) AS pct,
           CAST(rc.attendance_percent AS REAL) AS attendance, rc.grade,
           COALESCE((SELECT ex.name FROM exams ex WHERE ex.id = rc.exam_id), (SELECT t.name FROM terms t WHERE t.id = rc.term_id), '') AS exam_name,
           ay.name AS year,
           COALESCE((SELECT u.full_name FROM users u WHERE u.id = rc.submitted_by), (SELECT u.full_name FROM users u WHERE u.id = sec.class_teacher_id)) AS class_teacher,
           (SELECT u2.full_name FROM users u2 WHERE u2.id = rc.decided_by) AS principal,
           (SELECT u.signature_file_id FROM users u WHERE u.id = rc.submitted_by) AS teacher_sign,
           (SELECT u2.signature_file_id FROM users u2 WHERE u2.id = rc.decided_by) AS principal_sign,
           rc.rank_in_section AS rank, rc.class_teacher_remarks AS ct_remarks, rc.principal_remarks AS p_remarks
      FROM report_cards rc
      JOIN students st ON st.id = rc.student_id
      JOIN institutions i ON i.id = rc.institution_id
      JOIN enrollments e ON e.id = rc.enrollment_id
      LEFT JOIN sections sec ON sec.id = e.section_id
      LEFT JOIN classes c ON c.id = sec.class_id
      LEFT JOIN academic_years ay ON ay.id = rc.academic_year_id
     WHERE rc.id = ?`).bind(cardId).first<Record<string, unknown>>()
  if (!row) throw new Error('report card not found')
  const s = (k: string) => str(row[k])
  const n = (k: string) => { const v = num(row[k]); return v === null ? '' : trimFloat(v) }
  const values: Record<string, string> = {
    school_name: s('school'), student_name: s('student'), logo_file_id: s('logo_key'), school_motto: s('motto'),
    teacher_sign_file_id: s('teacher_sign'), principal_sign_file_id: s('principal_sign'),
    class: s('class'), section: s('section'), admission_no: s('admission_no'), roll_no: s('roll_no'),
    date_of_birth: ddmmyyyy(row.date_of_birth as string | null), admission_date: ddmmyyyy(row.admission_date as string | null),
    photo_file_id: s('photo_file_id'), father_name: s('father'), mother_name: s('mother'), guardian_name: s('guardian'),
    total_marks: n('total'), marks_obtained: n('obtained'), grade: s('grade'),
    /* The remarks are already written and approved on the card; they were
       gathered nowhere, so a design asking for them printed an empty box. */
    remarks: s('ct_remarks'), class_teacher_remarks: s('ct_remarks'), principal_remarks: s('p_remarks'),
    exam_name: s('exam_name'), academic_year: s('year'), class_teacher: s('class_teacher'), principal: s('principal'),
    rank: s('rank'), issued_on: ddmmyyyy(todayIST()), percentage: '', attendance: '', result: '',
    mobile_number: s('mobile'), school_address: '',
  }
  if (c.id.institution) values.school_address = (await schoolFacts(c.db, c.id.institution)).address ?? ''
  const scaleId = s('scale_id')
  let bands: GradeBand[] = []
  if (scaleId) {
    bands = (await c.db.prepare(`SELECT grade, CAST(min_percent AS REAL) AS min, CAST(max_percent AS REAL) AS max
        FROM grade_bands WHERE grading_scale_id = ? ORDER BY CAST(min_percent AS REAL) DESC`).bind(scaleId).all<GradeBand>()).results
  }
  if (bands.length === 0) bands = FALLBACK_BANDS
  const pct = num(row.pct)
  if (pct !== null) {
    values.percentage = pct.toFixed(2) + '%'; values.result = pct >= 33 ? 'PASS' : 'FAIL'
    if (!values.grade) values.grade = bandFor(bands, pct)
  }
  const att = num(row.attendance)
  if (att !== null) values.attendance = att.toFixed(1) + '%'

  const subs = await c.db.prepare(`
    SELECT es.id AS es_id, rc.student_id, sub.name, CAST(es.max_marks AS REAL) AS max,
           CASE WHEN m.marks_obtained IS NULL THEN NULL ELSE CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL), 0) END AS got,
           COALESCE((SELECT gb.grade FROM grade_bands gb WHERE gb.grading_scale_id = ex.grading_scale_id
                       AND ROUND(100.0 * (CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL),0)) / NULLIF(CAST(es.max_marks AS REAL),0), 2)
                           BETWEEN CAST(gb.min_percent AS REAL) AND CAST(gb.max_percent AS REAL) LIMIT 1), m.grade) AS g
      FROM report_cards rc
      JOIN enrollments e ON e.id = rc.enrollment_id
      JOIN class_subjects cs ON cs.class_id = e.class_id
      JOIN subjects sub ON sub.id = cs.subject_id
      JOIN exam_subjects es ON es.class_subject_id = cs.id
      JOIN exams ex ON ex.id = es.exam_id AND ex.academic_year_id = rc.academic_year_id
                   AND (rc.exam_id IS NULL OR es.exam_id = rc.exam_id)
                   AND (rc.exam_id IS NOT NULL OR rc.term_id IS NULL OR ex.term_id = rc.term_id)
      LEFT JOIN marks m ON m.exam_subject_id = es.id AND m.student_id = rc.student_id
     WHERE rc.id = ? AND ${examinedPaper()}
     ORDER BY sub.name`).bind(cardId).all<{ es_id: string; student_id: string; name: string; max: number; got: number | null; g: string | null }>()
  /* The report card shows each subject's total only (owner, 2026-10-13:
     "don't show the parts, add the parts into that exam"): the parts are how
     the total was made up, kept in Marks entry, not printed on the card. */
  const subjects = subs.results.map((x) => {
    const r: Record<string, string> = { subject: x.name, max_marks: trimFloat(Number(x.max)), marks: '-', percent: '-', subject_grade: x.g ?? '' }
    if (x.got !== null) {
      r.marks = trimFloat(Number(x.got))
      if (Number(x.max) > 0) {
        r.percent = `${Math.round((100 * Number(x.got)) / Number(x.max))}%`
        if (!r.subject_grade) r.subject_grade = bandFor(bands, (100 * Number(x.got)) / Number(x.max))
      }
    }
    return r
  })
  /* THE REGISTER, MONTH BY MONTH (owner, 2026-10-13, with a design whose
     attendance block is a table rather than one percentage).

     The card already carries the year's attendance as a single figure. A
     family reading "94.2%" cannot see that the two absences were both in
     August, which is the conversation a parents' evening actually has. Same
     filter as that figure -- the child's own register for this academic
     year, whole days only, holidays and approved leave left out -- so the
     total at the foot of this table is the percentage printed above it and
     the two can never disagree.

     Built here as HTML rather than handed over as data, like the subject
     rows, because a template is a page of HTML and has no way to loop. */
  const months = await c.db.prepare(`
    SELECT substr(sa.on_date, 1, 7) AS ym,
           COUNT(*) AS total,
           SUM(CASE WHEN sa.status IN ('present','late') THEN 1 ELSE 0 END) AS present
      FROM student_attendance sa
      JOIN report_cards rc ON rc.id = ?1
      JOIN academic_years ay ON ay.id = rc.academic_year_id
     WHERE sa.student_id = rc.student_id AND sa.period_id IS NULL
       AND sa.status NOT IN ('holiday','leave')
       AND sa.on_date BETWEEN ay.starts_on AND ay.ends_on
     GROUP BY ym ORDER BY ym`).bind(cardId).all<{ ym: string; total: number; present: number }>()
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  let attRows = '', tDays = 0, tPresent = 0
  for (const m of months.results) {
    const total = Number(m.total) || 0, present = Number(m.present) || 0
    tDays += total; tPresent += present
    const name = `${MONTH[Number(m.ym.slice(5, 7)) - 1] ?? m.ym} ${m.ym.slice(0, 4)}`
    const pc = total > 0 ? ((100 * present) / total).toFixed(1) + '%' : '-'
    attRows += `<tr><td class="rc-left">${escapeHtml(name)}</td><td>${total}</td><td>${present}</td><td>${total - present}</td><td>${pc}</td></tr>`
  }
  if (attRows) {
    const pc = tDays > 0 ? ((100 * tPresent) / tDays).toFixed(1) + '%' : '-'
    attRows += `<tr class="rc-total"><td class="rc-left">Total</td><td>${tDays}</td><td>${tPresent}</td><td>${tDays - tPresent}</td><td>${pc}</td></tr>`
  }

  /* The grading scale as the Yajur card prints it: percentages across, the
     grade under each, highest first. */
  let bandTable = '<table class="yrc-grading"><tr><td>Percentage</td>'
  for (const b of bands) bandTable += `<td>${trimFloat(b.min)} - ${trimFloat(b.max)}</td>`
  bandTable += '</tr><tr><td>Grade</td>'
  for (const b of bands) bandTable += `<td>${escapeHtml(b.grade)}</td>`
  bandTable += '</tr></table>'

  /* ATTENDANCE FOR THIS EXAM'S PERIOD, months across (the Yajur layout: Jun,
     Jul, Aug ... TOTAL, PER%). The period is the exam's term; with no term,
     the academic year up to the exam's last paper. Same register filter as
     the year figure: whole days, holidays and leave left out. */
  const per = await c.db.prepare(`
    SELECT rc.student_id AS sid,
           COALESCE(t.starts_on, ay.starts_on) AS f,
           COALESCE(t.ends_on, (SELECT MAX(substr(es.exam_date, 1, 10)) FROM exam_subjects es WHERE es.exam_id = rc.exam_id), ay.ends_on) AS u
      FROM report_cards rc
      JOIN academic_years ay ON ay.id = rc.academic_year_id
      LEFT JOIN terms t ON t.id = COALESCE(rc.term_id, (SELECT ex.term_id FROM exams ex WHERE ex.id = rc.exam_id))
     WHERE rc.id = ?`).bind(cardId).first<{ sid: string; f: string; u: string }>()
  let attendanceTable = ''
  if (per) {
    const pm = await c.db.prepare(`
      SELECT substr(on_date, 1, 7) AS ym, COUNT(*) AS total,
             SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present
        FROM student_attendance
       WHERE student_id = ?1 AND period_id IS NULL AND status NOT IN ('holiday','leave')
         AND substr(on_date, 1, 10) BETWEEN substr(?2, 1, 10) AND substr(?3, 1, 10)
       GROUP BY ym ORDER BY ym`).bind(per.sid, per.f, per.u).all<{ ym: string; total: number; present: number }>()
    const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    let head = '<th>Attendance</th>', days = '<td>Working Days</td>', pres = '<td>Days Present</td>', tD = 0, tP = 0
    for (const m of pm.results) {
      const d = Number(m.total) || 0, p = Number(m.present) || 0
      tD += d; tP += p
      head += `<th>${SHORT[Number(m.ym.slice(5, 7)) - 1] ?? escapeHtml(m.ym)}</th>`
      days += `<td>${d}</td>`; pres += `<td>${p}</td>`
    }
    if (pm.results.length === 0) {
      head += '<th></th>'; days += '<td>-</td>'; pres += '<td>-</td>'
    }
    head += '<th>TOTAL</th><th>PER(%)</th>'
    days += `<td>${tD}</td><td>${tD > 0 ? '100%' : '-'}</td>`
    pres += `<td>${tP}</td><td>${tD > 0 ? ((100 * tP) / tD).toFixed(1) + '%' : '-'}</td>`
    attendanceTable = `<table class="yrc-attend"><thead><tr>${head}</tr></thead><tbody><tr>${days}</tr><tr>${pres}</tr></tbody></table>`
  }
  return { values, subjects, attendanceRows: attRows, attendanceTable, bandTable }
}

