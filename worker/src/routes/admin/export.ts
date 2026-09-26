import { xlsxResponse } from '../../services/xlsx'
import type { Router, Ctx } from '../../router'
import { forbidden, notFound, ok } from '../../http'
import { can } from '../../identity'
import { institutionId } from './common'

/* Port of internal/api/export.go: GET /export and GET /export/{name}.
   The Postgres LATERAL joins became joins on a correlated "latest row" id,
   to_char became strftime/printf, string_agg(DISTINCT ..) a group_concat
   over a DISTINCT subquery. Timestamps are shown in Indian time. */

interface Spec { perm: string; title: string; about: string; header: string[]; query: string }

const name3 = (a: string) => `trim(COALESCE(${a}.first_name,'') || COALESCE(' ' || ${a}.middle_name,'') || COALESCE(' ' || ${a}.last_name,''))`
const name2 = (a: string) => `trim(COALESCE(${a}.first_name,'') || COALESCE(' ' || ${a}.last_name,''))`
const dmy = (x: string) => `strftime('%d/%m/%Y', ${x})`
const dmyTs = (x: string) => `strftime('%d/%m/%Y', ${x}, '+330 minutes')`
const rs = (x: string) => `printf('%.2f', (${x}) / 100.0)`
const latestEnrol = `LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
  LEFT JOIN classes c ON c.id = en.class_id
  LEFT JOIN sections sec ON sec.id = en.section_id`
const primaryGuardian = `LEFT JOIN guardians g ON g.id = (SELECT sg.guardian_id FROM student_guardians sg WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1)`
const heads = (inv: string) => `(SELECT group_concat(n, ', ') FROM (SELECT DISTINCT fh.name AS n FROM invoice_lines il JOIN fee_heads fh ON fh.id = il.fee_head_id WHERE il.invoice_id = ${inv}))`
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthName = (x: string) => `CASE ${x} ${MONTHS.map((m, i) => `WHEN ${i + 1} THEN '${m}'`).join(' ')} ELSE '' END`

const rollQuery = (where: string) => `SELECT st.admission_no, ${name3('st')}, COALESCE(c.name,''), COALESCE(sec.name,''),
    COALESCE(CAST(en.roll_no AS TEXT),''), COALESCE(st.gender,''), COALESCE(${dmy('st.date_of_birth')},''),
    COALESCE(st.medium,''), COALESCE(g.full_name,''), COALESCE(g.phone,''), st.status
  FROM students st ${latestEnrol} ${primaryGuardian}
  ${where} ORDER BY c.level NULLS LAST, sec.name, st.admission_no`

// Evaluated per request: "today" in India, as CURRENT_DATE was.
export function specs(today: string): Record<string, Spec> {
  const t = `'${today}'`
  const feeCase = (col: string, cond: string) => `sum(${col}) FILTER (WHERE ${cond})`
  const other = `COALESCE(inv.instalment_no,0) NOT IN (1,2,3) AND COALESCE(hd,'') NOT LIKE '%book%' AND COALESCE(hd,'') NOT LIKE '%uniform%' AND COALESCE(hd,'') NOT LIKE '%transport%'`
  return {
    students_on_roll: { title: 'Students on the roll', about: 'The children here now, no leavers, no transfers. The file to work from.', perm: 'students.read',
      header: ['Admission No', 'Name', 'Class', 'Section', 'Roll', 'Gender', 'Date of Birth', 'Medium', 'Guardian', 'Phone', 'Status'],
      query: rollQuery(`WHERE st.status = 'active'`) },
    students_left: { title: 'Children who have left', about: 'Leavers and transfers, with the date they left, why, and the certificate number.', perm: 'students.read',
      header: ['Admission No', 'Name', 'Last class', 'Section', 'Status', 'Left on', 'Reason', 'Guardian', 'Phone'],
      query: `SELECT st.admission_no, ${name3('st')}, COALESCE(c.name,''), COALESCE(sec.name,''), st.status,
          COALESCE(${dmy('st.exit_date')},''), COALESCE(st.exit_reason,''), COALESCE(g.full_name,''), COALESCE(g.phone,'')
        FROM students st ${latestEnrol} ${primaryGuardian}
        WHERE st.status IN ('withdrawn','transferred','inactive','graduated','alumni')
        ORDER BY st.exit_date DESC NULLS LAST, st.admission_no` },
    students_new_admissions: { title: 'New admissions this year', about: 'Children admitted during the current academic year, with when they joined and who to ring.', perm: 'students.read',
      header: ['Admission No', 'Name', 'Class', 'Section', 'Admitted on', 'Gender', 'Date of Birth', 'Guardian', 'Phone', 'Status'],
      query: `SELECT st.admission_no, ${name3('st')}, COALESCE(c.name,''), COALESCE(sec.name,''),
          COALESCE(${dmy('st.admission_date')},''), COALESCE(st.gender,''), COALESCE(${dmy('st.date_of_birth')},''),
          COALESCE(g.full_name,''), COALESCE(g.phone,''), st.status
        FROM students st JOIN academic_years ay ON ay.is_current = 1 ${latestEnrol} ${primaryGuardian}
        WHERE st.admission_date BETWEEN ay.starts_on AND ay.ends_on
        ORDER BY st.admission_date DESC, st.admission_no` },
    students: { title: 'Student roll, including leavers', about: 'Every student the school has ever held, with their status. The archive, not the working roll.', perm: 'students.read',
      header: ['Admission No', 'Name', 'Class', 'Section', 'Roll', 'Gender', 'Date of Birth', 'Medium', 'Guardian', 'Phone', 'Status'],
      query: rollQuery('') },
    defaulters: { title: 'Fee defaulters', about: 'Who owes what, how late they are, and when they were last chased.', perm: 'finance.invoices.read',
      header: ['Admission No', 'Student', 'Class', 'Guardian', 'Phone', 'Oldest Due', 'Days Overdue', 'Balance (Rs)', 'Bucket', 'Last Reminded'],
      query: `SELECT st.admission_no, ${name2('st')}, COALESCE(c.name || '-' || sec.name,''),
          COALESCE(g.full_name,''), COALESCE(g.phone,''), COALESCE(${dmy('min(i.due_on)')},''),
          COALESCE(CAST(max(0, CAST(julianday(${t}) - julianday(min(i.due_on)) AS INTEGER)) AS TEXT),'0'),
          ${rs('sum(i.net_paise - i.paid_paise)')},
          CASE WHEN julianday(${t}) - julianday(min(i.due_on)) > 90 THEN '90+'
               WHEN julianday(${t}) - julianday(min(i.due_on)) > 60 THEN '61-90'
               WHEN julianday(${t}) - julianday(min(i.due_on)) > 30 THEN '31-60' ELSE '0-30' END,
          COALESCE(strftime('%d/%m/%Y %H:%M', max(st.last_fee_reminder_at), '+330 minutes'), 'never')
        FROM invoices i JOIN students st ON st.id = i.student_id ${latestEnrol} ${primaryGuardian}
        WHERE i.status IN ('unpaid','partial','overdue')
        GROUP BY st.id, c.name, sec.name, g.full_name, g.phone
        HAVING sum(i.net_paise - i.paid_paise) > 0
        ORDER BY sum(i.net_paise - i.paid_paise) DESC` },
    collections: { title: 'Fee collections', about: 'Every receipt, split by term and fee head, with the child, the mode and who took it.', perm: 'finance.payments.read',
      header: ['Receipt No', 'Date', 'Admission No', 'Student', 'Class', 'Section', 'Term', 'Fee Heads', 'Mode', 'Reference', 'Amount (Rs)', 'Status', 'Collected By'],
      query: `SELECT COALESCE(p.receipt_no,''), ${dmy('p.paid_on')}, st.admission_no, ${name2('st')},
          COALESCE(c.name,''), COALESCE(sec.name,''),
          CASE WHEN inv.instalment_no IS NOT NULL THEN 'Term ' || inv.instalment_no ELSE '' END,
          COALESCE(${heads('inv.id')},''), p.mode,
          COALESCE(NULLIF(p.reference_no,''), COALESCE(p.gateway_txn_id,'')),
          ${rs('COALESCE(pa.amount_paise, p.amount_paise)')}, p.status, COALESCE(u.full_name,'')
        FROM payments p JOIN students st ON st.id = p.student_id
        LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
        LEFT JOIN invoices inv ON inv.id = pa.invoice_id
        ${latestEnrol}
        LEFT JOIN users u ON u.id = p.collected_by
        ORDER BY p.paid_on DESC, st.admission_no, inv.instalment_no NULLS LAST` },
    fees_by_student: { title: 'Fees by student, everything',
      about: 'One row per child with the whole fee picture: total billed, concession, net, paid and due, then Term 1/2/3 billed·paid·due and Books, Uniform and Transport billed·paid.',
      perm: 'finance.fees.read',
      header: ['Admission No', 'Student', 'Class', 'Section', 'Total Billed (Rs)', 'Concession (Rs)', 'Net (Rs)', 'Total Paid (Rs)', 'Total Due (Rs)',
        'Term 1 Billed', 'Term 1 Paid', 'Term 1 Due', 'Term 2 Billed', 'Term 2 Paid', 'Term 2 Due', 'Term 3 Billed', 'Term 3 Paid', 'Term 3 Due',
        'Books Billed', 'Books Paid', 'Uniform Billed', 'Uniform Paid', 'Transport Billed', 'Transport Paid', 'Other Billed', 'Other Paid'],
      query: `WITH iv AS (
          SELECT inv.student_id AS sid, sum(inv.gross_paise) AS gross, sum(inv.discount_paise) AS disc,
                 sum(inv.net_paise) AS net, sum(inv.paid_paise) AS paid,
                 ${feeCase('inv.net_paise', 'inv.instalment_no = 1')} AS t1_bill, ${feeCase('inv.paid_paise', 'inv.instalment_no = 1')} AS t1_paid,
                 ${feeCase('inv.net_paise', 'inv.instalment_no = 2')} AS t2_bill, ${feeCase('inv.paid_paise', 'inv.instalment_no = 2')} AS t2_paid,
                 ${feeCase('inv.net_paise', 'inv.instalment_no = 3')} AS t3_bill, ${feeCase('inv.paid_paise', 'inv.instalment_no = 3')} AS t3_paid,
                 ${feeCase('inv.net_paise', `hd LIKE '%book%'`)} AS bk_bill, ${feeCase('inv.paid_paise', `hd LIKE '%book%'`)} AS bk_paid,
                 ${feeCase('inv.net_paise', `hd LIKE '%uniform%'`)} AS un_bill, ${feeCase('inv.paid_paise', `hd LIKE '%uniform%'`)} AS un_paid,
                 ${feeCase('inv.net_paise', `hd LIKE '%transport%'`)} AS tr_bill, ${feeCase('inv.paid_paise', `hd LIKE '%transport%'`)} AS tr_paid,
                 ${feeCase('inv.net_paise', other)} AS ot_bill, ${feeCase('inv.paid_paise', other)} AS ot_paid
            FROM (SELECT i2.*, ${heads('i2.id')} AS hd FROM invoices i2 WHERE i2.status <> 'cancelled') inv
           GROUP BY inv.student_id)
        SELECT st.admission_no, ${name2('st')}, COALESCE(c.name,''), COALESCE(sec.name,''),
          ${rs('COALESCE(iv.gross,0)')}, ${rs('COALESCE(iv.disc,0)')}, ${rs('COALESCE(iv.net,0)')}, ${rs('COALESCE(iv.paid,0)')},
          ${rs('COALESCE(iv.net,0)-COALESCE(iv.paid,0)')},
          ${rs('COALESCE(iv.t1_bill,0)')}, ${rs('COALESCE(iv.t1_paid,0)')}, ${rs('COALESCE(iv.t1_bill,0)-COALESCE(iv.t1_paid,0)')},
          ${rs('COALESCE(iv.t2_bill,0)')}, ${rs('COALESCE(iv.t2_paid,0)')}, ${rs('COALESCE(iv.t2_bill,0)-COALESCE(iv.t2_paid,0)')},
          ${rs('COALESCE(iv.t3_bill,0)')}, ${rs('COALESCE(iv.t3_paid,0)')}, ${rs('COALESCE(iv.t3_bill,0)-COALESCE(iv.t3_paid,0)')},
          ${rs('COALESCE(iv.bk_bill,0)')}, ${rs('COALESCE(iv.bk_paid,0)')}, ${rs('COALESCE(iv.un_bill,0)')}, ${rs('COALESCE(iv.un_paid,0)')},
          ${rs('COALESCE(iv.tr_bill,0)')}, ${rs('COALESCE(iv.tr_paid,0)')}, ${rs('COALESCE(iv.ot_bill,0)')}, ${rs('COALESCE(iv.ot_paid,0)')}
        FROM students st JOIN iv ON iv.sid = st.id ${latestEnrol}
        WHERE st.status = 'active' AND iv.gross IS NOT NULL
        ORDER BY c.level NULLS LAST, sec.name, st.admission_no` },
    absentee_followups: { title: 'Absentee follow-ups',
      about: 'Every absence follow-up by date: child, section, the numbers called, whether they were reached, the reason and who followed up.',
      perm: 'academics.attendance.read.all',
      header: ['Date', 'Admission No', 'Student', 'Class', 'Section', 'Guardian numbers', 'Call status', 'Parent response', 'Followed up by'],
      query: `SELECT ${dmy('f.on_date')}, st.admission_no, ${name2('st')}, COALESCE(c.name,''), COALESCE(sec.name,''),
          COALESCE((SELECT group_concat(x, ', ') FROM (SELECT DISTINCT g.relation || ': ' || g.phone AS x
              FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE sg.student_id = st.id AND COALESCE(g.phone,'') <> '')),''),
          f.call_status, COALESCE(f.parent_response,''), COALESCE(u.full_name,'')
        FROM student_absence_followup f JOIN students st ON st.id = f.student_id ${latestEnrol}
        LEFT JOIN users u ON u.id = f.updated_by
        WHERE f.on_date >= date(${t}, '-180 days')
        ORDER BY f.on_date DESC, c.level NULLS LAST, sec.name, st.admission_no` },
    attendance: { title: 'Student attendance', about: 'The register, day by day.', perm: 'academics.attendance.read.all',
      header: ['Date', 'Admission No', 'Student', 'Class', 'Section', 'Status'],
      query: `SELECT ${dmy('sa.on_date')}, st.admission_no, ${name2('st')}, COALESCE(c.name,''), COALESCE(sec.name,''), sa.status
        FROM student_attendance sa JOIN students st ON st.id = sa.student_id
        LEFT JOIN sections sec ON sec.id = sa.section_id LEFT JOIN classes c ON c.id = sec.class_id
        WHERE sa.on_date >= date(${t}, '-90 days')
        ORDER BY c.level NULLS LAST, sec.name, st.admission_no, sa.on_date DESC` },
    staff: { title: 'Staff list', about: 'Everyone on the roll with department, designation and joining date.', perm: 'hr.employees.read',
      header: ['Code', 'Name', 'Department', 'Designation', 'Email', 'Phone', 'Joined', 'Status'],
      query: `SELECT e.employee_code, ${name2('e')}, COALESCE(d.name,''), COALESCE(dg.name,''),
          COALESCE(e.email,''), COALESCE(e.phone,''), ${dmy('e.joined_on')}, e.status
        FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations dg ON dg.id = e.designation_id
        ORDER BY e.employee_code` },
    payroll: { title: 'Salary register', about: "Each month's payslips: days paid, gross, deductions and take-home.", perm: 'hr.payroll.read',
      header: ['Month', 'Year', 'Code', 'Employee', 'Paid Days', 'LOP Days', 'Gross (Rs)', 'Deductions (Rs)', 'Net (Rs)', 'Status'],
      query: `SELECT ${monthName('pr.period_month')}, CAST(pr.period_year AS TEXT), e.employee_code, ${name2('e')},
          CAST(ps.paid_days AS TEXT), CAST(ps.lop_days AS TEXT),
          ${rs('ps.gross_paise')}, ${rs('ps.deduction_paise')}, ${rs('ps.net_paise')}, pr.status
        FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id
        ORDER BY pr.period_year DESC, pr.period_month DESC, e.employee_code` },
    marks: { title: 'Mark sheet', about: 'Every mark entered, by exam, class and subject.', perm: 'academics.exams.read',
      header: ['Exam', 'Class', 'Subject', 'Admission No', 'Student', 'Marks', 'Grace', 'Total', 'Out Of', 'Grade', 'Absent'],
      query: `SELECT ex.name, c.name, sub.name, st.admission_no, ${name2('st')},
          COALESCE(CAST(m.marks_obtained AS TEXT),''), CAST(m.grace_marks AS TEXT),
          COALESCE(CAST(m.marks_obtained + m.grace_marks AS TEXT),''), CAST(es.max_marks AS TEXT), COALESCE(m.grade,''),
          CASE WHEN m.is_absent THEN 'yes' ELSE 'no' END
        FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN exams ex ON ex.id = es.exam_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id JOIN classes c ON c.id = cs.class_id
        JOIN subjects sub ON sub.id = cs.subject_id JOIN students st ON st.id = m.student_id
        ORDER BY ex.name, c.name, sub.name, st.admission_no` },
    'staff-attendance': { title: 'Staff register', about: 'Who was present, absent or late, day by day.', perm: 'hr.attendance.write',
      header: ['Date', 'Code', 'Employee', 'Status', 'In', 'Out', 'Remarks'],
      query: `SELECT ${dmy('sa.on_date')}, e.employee_code, ${name2('e')}, sa.status,
          COALESCE(strftime('%H:%M', sa.check_in, '+330 minutes'),''), COALESCE(strftime('%H:%M', sa.check_out, '+330 minutes'),''),
          COALESCE(sa.remarks,'')
        FROM staff_attendance sa JOIN employees e ON e.user_id = sa.user_id
        ORDER BY sa.on_date DESC, e.employee_code` },
    leave: { title: 'Leave register', about: 'Every leave request, who applied, and how it was decided.', perm: 'hr.employees.read',
      header: ['Applied By', 'Kind', 'Type', 'From', 'To', 'Days', 'Reason', 'Status'],
      query: `SELECT CASE WHEN e.id IS NOT NULL THEN ${name2('e')} WHEN st.id IS NOT NULL THEN ${name2('st')} ELSE '' END,
          lr.subject_kind, COALESCE(lt.name,''), ${dmy('lr.from_date')}, ${dmy('lr.to_date')},
          CAST(lr.days AS TEXT), lr.reason, lr.status
        FROM leave_requests lr LEFT JOIN employees e ON e.id = lr.employee_id
        LEFT JOIN students st ON st.id = lr.student_id LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
        ORDER BY lr.created_at DESC` },
    'staff-documents': { title: 'Staff document expiry', about: 'Which papers have lapsed and which lapse soon.', perm: 'hr.employees.read',
      header: ['Code', 'Employee', 'Document', 'Expires', 'Days Left', 'State'],
      query: `SELECT e.employee_code, ${name2('e')}, d.doc_type, COALESCE(${dmy('d.expires_on')},''),
          COALESCE(CAST(CAST(julianday(d.expires_on) - julianday(${t}) AS INTEGER) AS TEXT),''),
          CASE WHEN d.expires_on IS NULL THEN 'does not expire'
               WHEN d.expires_on < ${t} THEN 'lapsed'
               WHEN d.expires_on < date(${t}, '+60 days') THEN 'expiring' ELSE 'valid' END
        FROM employee_documents d JOIN employees e ON e.id = d.employee_id
        ORDER BY d.expires_on NULLS LAST` },
    admissions: { title: 'Admission applications', about: 'Applicants, the class sought, and where each has got to.', perm: 'admissions.read',
      header: ['Application No', 'Applicant', 'Class Sought', 'Guardian', 'Phone', 'RTE', 'Status', 'Applied'],
      query: `SELECT a.application_no, ${name2('a')}, COALESCE(c.name,''), COALESCE(a.parent_name,''), COALESCE(a.parent_phone,''),
          CASE WHEN a.is_rte THEN 'yes' ELSE 'no' END, a.status, ${dmyTs('a.created_at')}
        FROM applications a LEFT JOIN classes c ON c.id = a.class_sought
        ORDER BY a.created_at DESC` },
    'library-loans': { title: 'Library issue register', about: 'Books out, due, returned, and the fines owing.', perm: 'operations.library.read',
      header: ['Title', 'Borrower', 'Issued', 'Due', 'Returned', 'Fine (Rs)'],
      query: `SELECT COALESCE(t.title,''),
          CASE WHEN st.id IS NOT NULL THEN ${name2('st')} WHEN e.id IS NOT NULL THEN ${name2('e')} ELSE '' END,
          ${dmy('l.issued_on')}, COALESCE(${dmy('l.due_on')},''), COALESCE(${dmy('l.returned_on')},''),
          ${rs('COALESCE(l.fine_paise,0)')}
        FROM library_loans l LEFT JOIN library_copies cp ON cp.id = l.copy_id LEFT JOIN library_titles t ON t.id = cp.title_id
        LEFT JOIN students st ON st.id = l.student_id LEFT JOIN employees e ON e.id = l.employee_id
        ORDER BY l.issued_on DESC` },
    udise: { title: 'UDISE+ student data', about: 'The fields the government return asks for, with the gaps flagged.', perm: 'admin.reports.read',
      header: ['Admission No', 'Name', 'APAAR ID', 'Child Info ID', 'Date of Birth', 'Gender', 'Class', 'Medium', 'RTE', 'CWSN', 'Problems'],
      query: `SELECT st.admission_no, ${name3('st')}, COALESCE(st.apaar_id,''), COALESCE(st.child_info_id,''),
          COALESCE(${dmy('st.date_of_birth')},''), COALESCE(st.gender,''), COALESCE(c.name,''), COALESCE(st.medium,''),
          CASE WHEN st.is_rte THEN 'Y' ELSE 'N' END, CASE WHEN st.is_cwsn THEN 'Y' ELSE 'N' END,
          trim(COALESCE(CASE WHEN st.date_of_birth IS NULL THEN 'date of birth missing, ' END,'')
            || COALESCE(CASE WHEN st.gender IS NULL THEN 'gender missing, ' END,'')
            || COALESCE(CASE WHEN st.apaar_id IS NULL THEN 'APAAR not issued, ' END,'')
            || COALESCE(CASE WHEN NOT st.aadhaar_consent THEN 'Aadhaar consent missing, ' END,''), ', ')
        FROM students st
        LEFT JOIN classes c ON c.id = (SELECT e.class_id FROM enrollments e WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1)
        WHERE st.status = 'active'
        ORDER BY st.admission_no` },
  }
}

const FORMATS = ['csv', 'tsv', 'xlsx']
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)

/** encoding/csv's quoting rule: quote when the field holds the separator, a quote, CR/LF, or starts with a space. */
function csvField(f: string, sep: string): string {
  if (f === '') return f
  if (f === '\\.' || f.includes(sep) || f.includes('"') || f.includes('\r') || f.includes('\n') || /^\s/.test(f)) {
    return '"' + f.replace(/"/g, '""') + '"'
  }
  return f
}

async function exportFile(c: Ctx): Promise<Response> {
  const name = c.params.name
  const spec = specs(istToday())[name]
  if (!spec) throw notFound()
  if (!can(c.id, spec.perm)) throw forbidden(spec.perm)
  institutionId(c)
  const date = new Date().toISOString().slice(0, 10)
  const format = (c.url.searchParams.get('format') ?? '').toLowerCase()
  if (format === 'xlsx') {
    // exportXLSX: buffered, so a query error is a clean 500 rather than a truncated file.
    const n = spec.header.length
    const rows = (await c.db.prepare(spec.query).raw<unknown[]>()).map((vals) => {
      const rec: (string | null)[] = new Array(n).fill(null)
      for (let i = 0; i < n && i < vals.length; i++) if (vals[i] != null) rec[i] = String(vals[i]).trim()
      return rec
    })
    return xlsxResponse(`${name}-${date}.xlsx`, spec.header, rows)
  }
  const tsv = format === 'tsv'
  const sep = tsv ? '\t' : ','
  const line = (rec: string[]) => rec.map((f) => csvField(f, sep)).join(sep) + '\n'
  let body = '﻿' + line(spec.header)
  try {
    const rows = await c.db.prepare(spec.query).raw<unknown[]>()
    const n = spec.header.length
    for (const vals of rows) {
      const rec: string[] = new Array(n).fill('')
      for (let i = 0; i < n && i < vals.length; i++) if (vals[i] != null) rec[i] = String(vals[i]).trim()
      body += line(rec)
    }
  } catch (err) {
    console.error('export', name, err)
    body += '\n# EXPORT FAILED - this file is incomplete\n'
  }
  return new Response(body, { status: 200, headers: {
    'Content-Type': tsv ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}-${date}.${tsv ? 'tsv' : 'csv'}"`,
  } })
}

export function registerExport(r: Router): void {
  r.get('/export', 'auth', (c) => {
    const items = Object.entries(specs(istToday())).filter(([, s]) => can(c.id, s.perm)).map(([name, s]) => ({
      name, title: s.title || name, about: s.about, url: '/api/v1/export/' + name, columns: s.header, formats: FORMATS,
    }))
    return ok({ items })
  })
  r.get('/export/{name}', 'auth', exportFile)
}
