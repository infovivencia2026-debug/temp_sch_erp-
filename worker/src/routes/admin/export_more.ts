/* The reports a school moving from MyClassBoard asks for by name
   (docs/MCB_vs_XULO_comparison.pdf, appendix), as export specs: each one
   query over the tables the product already keeps, listed under Reports >
   Data exports for whoever holds the permission, downloaded as CSV, TSV or
   Excel. Nothing here writes. */

interface Spec { perm: string; title: string; about: string; header: string[]; query: string; params?: string[] }

const name2 = (a: string) => `trim(COALESCE(${a}.first_name,'') || COALESCE(' ' || ${a}.last_name,''))`
const dmy = (x: string) => `strftime('%d/%m/%Y', ${x})`
const rs = (x: string) => `printf('%.2f', (${x}) / 100.0)`
const latestEnrol = `LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
  LEFT JOIN classes c ON c.id = en.class_id
  LEFT JOIN sections sec ON sec.id = en.section_id`
const primaryGuardian = `LEFT JOIN guardians g ON g.id = (SELECT sg.guardian_id FROM student_guardians sg WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1)`
const cls = `COALESCE(c.name,'') || CASE WHEN sec.name IS NULL THEN '' ELSE ' ' || sec.name END`
/** A staff member's child: a guardian with the employee's phone or email, or the employee's own login. */
const staffKid = `EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians gg ON gg.id = sg.guardian_id JOIN employees e2 ON e2.status IN ('active','on_leave')
    AND ((gg.phone IS NOT NULL AND gg.phone <> '' AND gg.phone = e2.phone) OR (gg.email IS NOT NULL AND gg.email <> '' AND gg.email = e2.email) OR (gg.user_id IS NOT NULL AND gg.user_id = e2.user_id))
    WHERE sg.student_id = st.id)`
const staffOfKid = `(SELECT ${name2('e2')} || ' (' || e2.employee_code || ')' FROM student_guardians sg JOIN guardians gg ON gg.id = sg.guardian_id JOIN employees e2 ON e2.status IN ('active','on_leave')
    AND ((gg.phone IS NOT NULL AND gg.phone <> '' AND gg.phone = e2.phone) OR (gg.email IS NOT NULL AND gg.email <> '' AND gg.email = e2.email) OR (gg.user_id IS NOT NULL AND gg.user_id = e2.user_id))
    WHERE sg.student_id = st.id LIMIT 1)`
const hasSibling = `EXISTS (SELECT 1 FROM student_guardians a JOIN student_guardians b ON b.guardian_id = a.guardian_id AND b.student_id <> a.student_id
    JOIN students s2 ON s2.id = b.student_id AND s2.status = 'active' WHERE a.student_id = st.id)`
const siblings = `(SELECT group_concat(${name2('s2')} || ' (' || s2.admission_no || ')', '; ') FROM (SELECT DISTINCT s2.* FROM student_guardians a JOIN student_guardians b ON b.guardian_id = a.guardian_id AND b.student_id <> a.student_id
    JOIN students s2 ON s2.id = b.student_id AND s2.status = 'active' WHERE a.student_id = st.id) s2)`

export function moreSpecs(today: string): Record<string, Spec> {
  const t = `'${today}'`
  return {
    // ---------------------------------------------------------------- students
    students_shuffled: { title: 'Shuffled students', about: 'Children moved between sections during the current year: the section they left and the one they are in now.', perm: 'students.read',
      header: ['Admission No', 'Name', 'Class', 'From section', 'To section', 'Moved on'],
      query: `SELECT st.admission_no, ${name2('st')}, COALESCE(c.name,''), COALESCE(s1.name,''), COALESCE(s2.name,''), COALESCE(${dmy('e2.enrolled_on')},'')
        FROM enrollments e2 JOIN academic_years ay ON ay.id = e2.academic_year_id AND ay.is_current = 1
        JOIN enrollments e1 ON e1.student_id = e2.student_id AND e1.academic_year_id = e2.academic_year_id AND e1.id <> e2.id AND e1.enrolled_on <= e2.enrolled_on AND e1.section_id <> e2.section_id
        JOIN students st ON st.id = e2.student_id
        LEFT JOIN classes c ON c.id = e2.class_id LEFT JOIN sections s1 ON s1.id = e1.section_id LEFT JOIN sections s2 ON s2.id = e2.section_id
        WHERE e2.status = 'active' ORDER BY e2.enrolled_on DESC, st.admission_no` },
    students_siblings: { title: 'Siblings', about: 'Every child on the roll who has a brother or sister here, with who they are. From the shared guardian.', perm: 'students.read',
      header: ['Admission No', 'Name', 'Class', 'Guardian', 'Phone', 'Siblings'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls}, COALESCE(g.full_name,''), COALESCE(g.phone,''), COALESCE(${siblings},'')
        FROM students st ${latestEnrol} ${primaryGuardian} WHERE st.status = 'active' AND ${hasSibling}
        ORDER BY g.phone, c.level, st.admission_no` },
    students_segments: { title: 'Student segments', about: 'How many children in each class by gender, category, religion, medium, RTE and CWSN. The counts the returns ask for.', perm: 'students.read',
      header: ['Class', 'Segment', 'Value', 'Children'],
      query: `SELECT cl, seg, val, count(*) FROM (
          SELECT COALESCE(c.name,'No class') AS cl, k.value AS seg,
            CASE k.value
              WHEN 'Gender' THEN COALESCE(NULLIF(st.gender,''),'Not recorded')
              WHEN 'Category' THEN COALESCE(NULLIF(st.category,''),'Not recorded')
              WHEN 'Religion' THEN COALESCE(NULLIF(st.religion,''),'Not recorded')
              WHEN 'Medium' THEN COALESCE(NULLIF(st.medium,''),'Not recorded')
              WHEN 'RTE' THEN CASE WHEN st.is_rte = 1 THEN 'RTE' ELSE 'General' END
              ELSE CASE WHEN st.is_cwsn = 1 THEN COALESCE(NULLIF(st.cwsn_type,''),'CWSN') ELSE 'No' END END AS val
          FROM students st ${latestEnrol} CROSS JOIN json_each('["Gender","Category","Religion","Medium","RTE","CWSN"]') k
          WHERE st.status = 'active'
        ) GROUP BY cl, seg, val ORDER BY cl, seg, val` },
    students_houses: { title: 'House groups', about: 'Which children are in which house, class by class.', perm: 'students.read',
      header: ['House', 'Admission No', 'Name', 'Class', 'Gender'],
      query: `SELECT COALESCE(h.name,'No house'), st.admission_no, ${name2('st')}, ${cls}, COALESCE(st.gender,'')
        FROM students st LEFT JOIN houses h ON h.id = st.house_id ${latestEnrol} WHERE st.status = 'active' ORDER BY h.name, c.level, st.admission_no` },
    students_strength_audit: { title: 'Strength audit, month by month', about: 'For each month of the current year: children on the roll at the start, admitted, left, and on the roll at the end.', perm: 'students.read',
      header: ['Month', 'At start', 'Admitted', 'Left', 'At end'],
      query: `WITH RECURSIVE m(d) AS (SELECT date(ay.starts_on, 'start of month') FROM academic_years ay WHERE ay.is_current = 1
            UNION ALL SELECT date(d, '+1 month') FROM m WHERE d < (SELECT min(ay.ends_on, ${t}) FROM academic_years ay WHERE ay.is_current = 1))
        SELECT strftime('%m/%Y', d),
          (SELECT count(*) FROM students s WHERE s.admission_date < d AND (s.exit_date IS NULL OR s.exit_date >= d)),
          (SELECT count(*) FROM students s WHERE s.admission_date >= d AND s.admission_date < date(d, '+1 month')),
          (SELECT count(*) FROM students s WHERE s.exit_date >= d AND s.exit_date < date(d, '+1 month')),
          (SELECT count(*) FROM students s WHERE s.admission_date < date(d, '+1 month') AND (s.exit_date IS NULL OR s.exit_date >= date(d, '+1 month')))
        FROM m` },
    students_withdrawal_refunds: { title: 'Withdrawals and fee refunds', about: 'Children who left, what they still owed when they went, and any refund made to the family.', perm: 'finance.invoices.read',
      header: ['Admission No', 'Name', 'Last class', 'Left on', 'Reason', 'Owed (Rs)', 'Refunded (Rs)', 'Refund status'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls}, COALESCE(${dmy('st.exit_date')},''), COALESCE(st.exit_reason,''),
          ${rs(`COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i WHERE i.student_id = st.id AND i.status IN ('unpaid','partial','overdue')),0)`)},
          ${rs(`COALESCE((SELECT sum(r.amount_paise) FROM refunds r WHERE r.student_id = st.id AND r.status IN ('approved','processed')),0)`)},
          COALESCE((SELECT r.status FROM refunds r WHERE r.student_id = st.id ORDER BY r.created_at DESC LIMIT 1),'none')
        FROM students st ${latestEnrol} WHERE st.status IN ('withdrawn','transferred','inactive','graduated','alumni')
        ORDER BY st.exit_date DESC NULLS LAST` },
    students_suspensions: { title: 'Suspension log', about: 'Every suspension recorded in the discipline register, with the dates and what followed.', perm: 'students.read.all',
      header: ['Admission No', 'Name', 'Class', 'Occurred on', 'Category', 'Severity', 'Suspended from', 'To', 'Action taken', 'Parent met on', 'Status'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls}, COALESCE(${dmy('d.occurred_on')},''), COALESCE(d.category,''), COALESCE(d.severity,''),
          COALESCE(${dmy('d.suspension_from')},''), COALESCE(${dmy('d.suspension_to')},''), COALESCE(d.action_taken,''), COALESCE(${dmy('d.parent_meeting_on')},''), COALESCE(d.status,'')
        FROM discipline_records d JOIN students st ON st.id = d.student_id ${latestEnrol}
        WHERE d.suspension_from IS NOT NULL ORDER BY d.suspension_from DESC` },
    students_activities: { title: 'Hobbies, clubs and talents', about: 'Which clubs and activities each child is in this year, and since when.', perm: 'students.read',
      header: ['Admission No', 'Name', 'Class', 'Activity', 'Category', 'Since', 'Status'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls}, a.name, COALESCE(a.category,''), COALESCE(${dmy('sa.enrolled_on')},''), COALESCE(sa.status,'')
        FROM student_activities sa JOIN activities a ON a.id = sa.activity_id JOIN students st ON st.id = sa.student_id ${latestEnrol}
        WHERE sa.left_on IS NULL ORDER BY a.name, c.level, st.admission_no` },
    exam_attendance: { title: 'Examination attendance', about: 'For each exam and paper, who sat and who was marked absent.', perm: 'academics.exams.read',
      header: ['Exam', 'Class', 'Subject', 'Admission No', 'Name', 'Present'],
      query: `SELECT ex.name, COALESCE(c.name,''), COALESCE(su.name,''), st.admission_no, ${name2('st')}, CASE WHEN m.is_absent = 1 THEN 'Absent' ELSE 'Present' END
        FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN exams ex ON ex.id = es.exam_id
        LEFT JOIN class_subjects cs ON cs.id = es.class_subject_id LEFT JOIN classes c ON c.id = cs.class_id LEFT JOIN subjects su ON su.id = cs.subject_id
        JOIN students st ON st.id = m.student_id
        ORDER BY ex.starts_on DESC, c.level, su.name, st.admission_no` },
    students_promoted_with_dues: { title: 'Promoted with fees owing', about: 'Children promoted into this year who still owe fees from an earlier year. The financial promotion check.', perm: 'finance.invoices.read',
      header: ['Admission No', 'Name', 'Class now', 'Owed from earlier years (Rs)', 'Oldest due', 'Guardian', 'Phone'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls},
          ${rs('sum(i.net_paise - i.paid_paise)')}, COALESCE(${dmy('min(i.due_on)')},''), COALESCE(g.full_name,''), COALESCE(g.phone,'')
        FROM invoices i JOIN academic_years iy ON iy.id = i.academic_year_id JOIN academic_years cur ON cur.is_current = 1 AND iy.starts_on < cur.starts_on
        JOIN students st ON st.id = i.student_id ${latestEnrol} ${primaryGuardian}
        WHERE i.status IN ('unpaid','partial','overdue') AND st.status = 'active' AND en.academic_year_id = cur.id
        GROUP BY st.id HAVING sum(i.net_paise - i.paid_paise) > 0 ORDER BY sum(i.net_paise - i.paid_paise) DESC` },

    // ---------------------------------------------------------------- staff
    staff_kids: { title: 'Staff children on the roll', about: 'Children whose parent is on the staff, matched by the phone, email or login the school holds for both.', perm: 'hr.employees.read',
      header: ['Admission No', 'Child', 'Class', 'Staff parent', 'Fees owed (Rs)'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls}, COALESCE(${staffOfKid},''),
          ${rs(`COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i WHERE i.student_id = st.id AND i.status IN ('unpaid','partial','overdue')),0)`)}
        FROM students st ${latestEnrol} WHERE st.status = 'active' AND ${staffKid} ORDER BY c.level, st.admission_no` },
    staff_outsourced: { title: 'Contract and outsourced staff', about: 'Everyone on the roll who is not a regular employee: contract, outsourced, part-time, visiting.', perm: 'hr.employees.read',
      header: ['Code', 'Name', 'Department', 'Designation', 'Employment type', 'Joined', 'Phone'],
      query: `SELECT e.employee_code, ${name2('e')}, COALESCE(d.name,''), COALESCE(des.name,''), COALESCE(e.employment_type,''), COALESCE(${dmy('e.joined_on')},''), COALESCE(e.phone,'')
        FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations des ON des.id = e.designation_id
        WHERE e.status IN ('active','on_leave') AND COALESCE(lower(e.employment_type),'') NOT IN ('', 'regular', 'permanent', 'full_time', 'full-time')
        ORDER BY e.employment_type, d.name, e.employee_code` },
    staff_recognitions: { title: 'Praise and recognitions', about: 'Every award and recognition recorded for staff, with the citation and who nominated.', perm: 'hr.employees.read',
      header: ['Code', 'Name', 'Award', 'Title', 'Citation', 'Awarded on', 'Nominated by', 'Published'],
      query: `SELECT e.employee_code, ${name2('e')}, COALESCE(r.award_code,''), COALESCE(r.title,''), COALESCE(r.citation,''), COALESCE(${dmy('r.awarded_on')},''),
          COALESCE(u.full_name,''), CASE WHEN r.published = 1 THEN 'Yes' ELSE 'No' END
        FROM staff_recognitions r JOIN employees e ON e.id = r.employee_id LEFT JOIN users u ON u.id = r.nominated_by ORDER BY r.awarded_on DESC` },
    staff_training_sessions: { title: 'Training sessions attended', about: 'Each training a member of staff attended, the hours, the score and the certificate.', perm: 'hr.employees.read',
      header: ['Code', 'Name', 'Programme', 'Attended on', 'Hours', 'Score', 'Status', 'Certificate No'],
      query: `SELECT e.employee_code, ${name2('e')}, COALESCE((SELECT p.title FROM training_programmes p WHERE p.id = tr.programme_id),''), COALESCE(${dmy('tr.attended_on')},''),
          COALESCE(CAST(tr.hours_completed AS TEXT),''), COALESCE(CAST(tr.score AS TEXT),''), COALESCE(tr.status,''), COALESCE(tr.certificate_no,'')
        FROM staff_training_records tr JOIN employees e ON e.id = tr.employee_id ORDER BY tr.attended_on DESC` },
    staff_assets_issued: { title: 'Assets issued to staff', about: 'Fixed assets whose location is a member of staff: laptops, phones, keys.', perm: 'hr.employees.read',
      header: ['Tag', 'Asset', 'Category', 'Issued to', 'Purchased', 'Cost (Rs)', 'Status'],
      query: `SELECT fa.tag_no, fa.name, COALESCE(fa.category,''), COALESCE(fa.location,''), COALESCE(${dmy('fa.purchased_on')},''), ${rs('fa.cost_paise')}, fa.status
        FROM fixed_assets fa WHERE fa.status <> 'disposed' AND fa.location IS NOT NULL AND fa.location <> ''
          AND EXISTS (SELECT 1 FROM employees e WHERE e.status IN ('active','on_leave') AND (fa.location = e.employee_code OR fa.location LIKE '%' || e.first_name || '%'))
        ORDER BY fa.location, fa.tag_no` },

    // ---------------------------------------------------------------- finance
    fee_deposits_register: { title: 'Fee deposits register', about: 'Each day’s takings by mode and by who collected them: the register the cash is counted against.', perm: 'finance.payments.read',
      header: ['Date', 'Mode', 'Collected by', 'Receipts', 'Amount (Rs)'],
      query: `SELECT ${dmy('p.paid_on')}, p.mode, COALESCE(u.full_name,''), count(*), ${rs('sum(p.amount_paise)')}
        FROM payments p LEFT JOIN users u ON u.id = p.collected_by WHERE p.status NOT IN ('bounced','cancelled')
        GROUP BY p.paid_on, p.mode, u.full_name ORDER BY p.paid_on DESC, p.mode` },
    fee_sibling_concessions: { title: 'Sibling concessions', about: 'Concessions granted to children who have a sibling here, so the sibling discount can be checked.', perm: 'finance.fees.read',
      header: ['Admission No', 'Name', 'Class', 'Siblings', 'Fee head', 'Kind', 'Percent', 'Amount (Rs)', 'Status'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls}, COALESCE(${siblings},''), COALESCE(fh.name,'All heads'), fc.kind, COALESCE(fc.percent,''), ${rs('COALESCE(fc.amount_paise,0)')}, fc.status
        FROM fee_concessions fc JOIN students st ON st.id = fc.student_id ${latestEnrol} LEFT JOIN fee_heads fh ON fh.id = fc.fee_head_id
        WHERE ${hasSibling} ORDER BY c.level, st.admission_no` },
    fee_staff_kids_concessions: { title: 'Staff children concessions', about: 'Concessions granted to the children of staff.', perm: 'finance.fees.read',
      header: ['Admission No', 'Name', 'Class', 'Staff parent', 'Fee head', 'Kind', 'Percent', 'Amount (Rs)', 'Status'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls}, COALESCE(${staffOfKid},''), COALESCE(fh.name,'All heads'), fc.kind, COALESCE(fc.percent,''), ${rs('COALESCE(fc.amount_paise,0)')}, fc.status
        FROM fee_concessions fc JOIN students st ON st.id = fc.student_id ${latestEnrol} LEFT JOIN fee_heads fh ON fh.id = fc.fee_head_id
        WHERE ${staffKid} ORDER BY c.level, st.admission_no` },
    fee_exam_fees: { title: 'Examination fees', about: 'What was billed and paid under every fee head that is an exam fee.', perm: 'finance.invoices.read',
      header: ['Fee head', 'Class', 'Admission No', 'Name', 'Invoice', 'Billed (Rs)', 'Invoice status'],
      query: `SELECT fh.name, ${cls}, st.admission_no, ${name2('st')}, i.invoice_no, ${rs('il.amount_paise - il.discount_paise')}, i.status
        FROM invoice_lines il JOIN fee_heads fh ON fh.id = il.fee_head_id JOIN invoices i ON i.id = il.invoice_id JOIN students st ON st.id = i.student_id ${latestEnrol}
        WHERE lower(fh.name) LIKE '%exam%' AND i.status <> 'cancelled' ORDER BY fh.name, c.level, st.admission_no` },
    fee_misc_consolidated: { title: 'Optional and miscellaneous fees', about: 'Every optional fee head: how many children were billed, how much, and how much is paid.', perm: 'finance.invoices.read',
      header: ['Fee head', 'Children billed', 'Billed (Rs)', 'Concession (Rs)', 'Collected (Rs)'],
      query: `SELECT fh.name, count(DISTINCT i.student_id), ${rs('sum(il.amount_paise)')}, ${rs('sum(il.discount_paise)')},
          ${rs(`sum(CASE WHEN i.net_paise > 0 THEN (il.amount_paise - il.discount_paise) * min(i.paid_paise, i.net_paise) / i.net_paise ELSE 0 END)`)}
        FROM invoice_lines il JOIN fee_heads fh ON fh.id = il.fee_head_id JOIN invoices i ON i.id = il.invoice_id
        WHERE fh.optional = 1 AND i.status <> 'cancelled' GROUP BY fh.id ORDER BY fh.name` },
    fee_canteen_bookings: { title: 'Canteen and lunch sales', about: 'Every canteen sale, who it was for and how it was paid.', perm: 'finance.payments.read',
      header: ['Date', 'Receipt', 'Child', 'Admission No', 'Buyer', 'Mode', 'Amount (Rs)'],
      query: `SELECT ${dmy('ps.sold_on')}, COALESCE(ps.receipt_no,''), COALESCE(${name2('st')},''), COALESCE(st.admission_no,''), COALESCE(ps.buyer_name,''), COALESCE(ps.payment_mode,''), ${rs('ps.total_paise')}
        FROM pos_sales ps LEFT JOIN students st ON st.id = ps.student_id WHERE ps.kind = 'canteen' ORDER BY ps.sold_on DESC` },
    fee_scholarships: { title: 'Scholarships', about: 'Every scholarship award: the child, the scheme, the stage, what was expected, sanctioned and credited.', perm: 'finance.fees.read',
      header: ['Admission No', 'Name', 'Class', 'Scheme', 'Stage', 'Expected (Rs)', 'Sanctioned (Rs)', 'Credited (Rs)', 'Credited on'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls}, COALESCE((SELECT s.name FROM government_aid_schemes s WHERE s.id = sa.scheme_id), COALESCE(sa.scheme_id,'')), sa.stage,
          ${rs('COALESCE(sa.expected_paise,0)')}, ${rs('COALESCE(sa.sanctioned_paise,0)')}, ${rs('COALESCE(sa.credited_paise,0)')}, COALESCE(${dmy('sa.credited_on')},'')
        FROM scholarship_awards sa JOIN students st ON st.id = sa.student_id ${latestEnrol} ORDER BY sa.created_at DESC` },
    fee_due_with_scholarship: { title: 'Dues against scholarships', about: 'Children who owe fees and have a scholarship in progress: what is owed and what is still expected to come.', perm: 'finance.invoices.read',
      header: ['Admission No', 'Name', 'Class', 'Owed (Rs)', 'Scholarship stage', 'Expected (Rs)', 'Credited (Rs)'],
      query: `SELECT st.admission_no, ${name2('st')}, ${cls},
          ${rs(`(SELECT sum(i.net_paise - i.paid_paise) FROM invoices i WHERE i.student_id = st.id AND i.status IN ('unpaid','partial','overdue'))`)},
          sa.stage, ${rs('COALESCE(sa.expected_paise,0)')}, ${rs('COALESCE(sa.credited_paise,0)')}
        FROM scholarship_awards sa JOIN students st ON st.id = sa.student_id ${latestEnrol}
        WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.student_id = st.id AND i.status IN ('unpaid','partial','overdue'))
        ORDER BY c.level, st.admission_no` },
    fee_projection: { title: 'Fee projection, next year', about: 'What next year’s fees would come to if every child on the roll today is promoted one class, at this year’s billing for the class above.', perm: 'finance.invoices.read',
      header: ['Class next year', 'Children', 'This year’s billing per child (Rs)', 'Projected (Rs)'],
      query: `SELECT COALESCE(nx.name, 'Leaving (' || c.name || ')'), count(DISTINCT st.id),
          ${rs(`COALESCE((SELECT avg(i.net_paise) FROM invoices i JOIN enrollments e3 ON e3.student_id = i.student_id AND e3.class_id = nx.id JOIN academic_years ay ON ay.id = i.academic_year_id AND ay.is_current = 1 WHERE i.status <> 'cancelled'),0)`)},
          ${rs(`count(DISTINCT st.id) * COALESCE((SELECT avg(i.net_paise) FROM invoices i JOIN enrollments e3 ON e3.student_id = i.student_id AND e3.class_id = nx.id JOIN academic_years ay ON ay.id = i.academic_year_id AND ay.is_current = 1 WHERE i.status <> 'cancelled'),0)`)}
        FROM students st ${latestEnrol} LEFT JOIN classes nx ON nx.campus_id = c.campus_id AND nx.level = c.level + 1
        WHERE st.status = 'active' AND c.id IS NOT NULL GROUP BY nx.id, c.id ORDER BY c.level` },
    fee_mismatches: { title: 'Fee mismatches', about: 'Invoices whose total does not equal their lines, or whose paid figure does not equal the allocations: what to fix before the audit.', perm: 'finance.invoices.read',
      header: ['Invoice', 'Admission No', 'Name', 'Issued', 'Net on invoice (Rs)', 'Sum of lines (Rs)', 'Paid on invoice (Rs)', 'Sum of allocations (Rs)', 'Status'],
      query: `SELECT i.invoice_no, st.admission_no, ${name2('st')}, ${dmy('i.issued_on')}, ${rs('i.net_paise')}, ${rs('ln.s')}, ${rs('i.paid_paise')}, ${rs('al.s')}, i.status
        FROM invoices i JOIN students st ON st.id = i.student_id
        JOIN (SELECT invoice_id, sum(amount_paise - discount_paise) AS s FROM invoice_lines GROUP BY invoice_id) ln ON ln.invoice_id = i.id
        LEFT JOIN (SELECT invoice_id, sum(amount_paise) AS s FROM payment_allocations GROUP BY invoice_id) al ON al.invoice_id = i.id
        WHERE i.status <> 'cancelled' AND (i.gross_paise - i.discount_paise <> ln.s OR i.paid_paise <> COALESCE(al.s,0) OR i.paid_paise > i.net_paise)
        ORDER BY i.issued_on DESC` },

    // ---------------------------------------------------------------- admissions
    enquiries_duplicates: { title: 'Duplicate enquiries', about: 'Enquiries that share a phone number: the same family entered twice.', perm: 'admissions.read',
      header: ['Phone', 'Entries', 'Names', 'Classes sought', 'Statuses'],
      query: `SELECT q.phone, count(*), group_concat(q.student_name, '; '), group_concat(DISTINCT q.class_sought), group_concat(DISTINCT q.status)
        FROM enquiries q WHERE q.phone IS NOT NULL AND q.phone <> '' GROUP BY q.phone HAVING count(*) > 1 ORDER BY count(*) DESC` },
    enquiries_by_source: { title: 'Enquiries by source', about: 'Where enquiries came from, how many were admitted, and how many were lost, by source and campaign.', perm: 'admissions.read',
      header: ['Source', 'Campaign', 'Enquiries', 'Admitted', 'Lost', 'Open'],
      query: `SELECT COALESCE(NULLIF(q.source,''),'Not recorded'), COALESCE(NULLIF(q.campaign,''),''), count(*),
          sum(CASE WHEN q.status IN ('admitted','converted','enrolled') THEN 1 ELSE 0 END), sum(CASE WHEN q.status IN ('lost','closed','dropped') THEN 1 ELSE 0 END),
          sum(CASE WHEN q.status NOT IN ('admitted','converted','enrolled','lost','closed','dropped') THEN 1 ELSE 0 END)
        FROM enquiries q GROUP BY q.source, q.campaign ORDER BY count(*) DESC` },
    enquiries_siblings: { title: 'Sibling enquiries and applications', about: 'Applications that name a brother or sister already on the roll.', perm: 'admissions.read',
      header: ['Application', 'Applicant', 'Class sought', 'Sibling on roll', 'Sibling class', 'Status'],
      query: `SELECT a.application_no, ${name2('a')}, COALESCE(a.class_sought,''), ${name2('st')} || ' (' || st.admission_no || ')', ${cls}, a.status
        FROM applications a JOIN students st ON st.id = a.sibling_student_id ${latestEnrol} ORDER BY a.created_at DESC` },
    enquiries_referrals: { title: 'Referrals', about: 'Enquiries that came through a referral, who referred them, and what became of each.', perm: 'admissions.read',
      header: ['Referred by', 'Enquiry', 'Parent', 'Phone', 'Class sought', 'Status', 'Received'],
      query: `SELECT q.referred_by, q.student_name, COALESCE(q.parent_name,''), COALESCE(q.phone,''), COALESCE(q.class_sought,''), q.status, ${dmy('q.created_at')}
        FROM enquiries q WHERE q.referred_by IS NOT NULL AND q.referred_by <> '' ORDER BY q.referred_by, q.created_at DESC` },
    admissions_target_strength: { title: 'Target strength', about: 'Each section’s stated strength and capacity against the children in it, and the seats still open.', perm: 'admissions.read',
      header: ['Class', 'Section', 'Stated strength', 'Capacity', 'Enrolled', 'Open seats'],
      query: `SELECT c.name, sec.name, COALESCE(CAST(sec.stated_strength AS TEXT),''), COALESCE(CAST(sec.capacity AS TEXT),''),
          (SELECT count(*) FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active'),
          COALESCE(CAST(COALESCE(sec.stated_strength, sec.capacity) - (SELECT count(*) FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS TEXT), '')
        FROM sections sec JOIN classes c ON c.id = sec.class_id JOIN academic_years ay ON ay.id = sec.academic_year_id AND ay.is_current = 1
        ORDER BY c.level, sec.name` },
    admissions_form_fees: { title: 'Application form fees', about: 'Form and registration fees collected per application, and the applications still unpaid.', perm: 'admissions.read',
      header: ['Application', 'Applicant', 'Class sought', 'Form fee (Rs)', 'Paid on', 'Receipt', 'Status'],
      query: `SELECT a.application_no, ${name2('a')}, COALESCE(a.class_sought,''), ${rs('COALESCE(a.form_fee_paise,0)')}, COALESCE(${dmy('a.form_fee_paid_at')},'not paid'), COALESCE(a.form_fee_receipt,''), a.status
        FROM applications a WHERE COALESCE(a.form_fee_paise,0) > 0 ORDER BY a.created_at DESC` },
    admissions_counsellor_daily: { title: 'Counsellor daily sheet', about: 'Per counsellor: enquiries held, contacted today, follow-ups due today and overdue, admitted this month.', perm: 'admissions.read',
      header: ['Counsellor', 'Enquiries held', 'Contacted today', 'Follow-ups due today', 'Overdue follow-ups', 'Admitted this month'],
      query: `SELECT COALESCE(u.full_name,'Unassigned'), count(*),
          sum(CASE WHEN substr(q.last_contacted_at,1,10) = ${t} THEN 1 ELSE 0 END),
          sum(CASE WHEN q.next_follow_up = ${t} THEN 1 ELSE 0 END),
          sum(CASE WHEN q.next_follow_up < ${t} AND q.status NOT IN ('admitted','converted','enrolled','lost','closed','dropped') THEN 1 ELSE 0 END),
          sum(CASE WHEN q.status IN ('admitted','converted','enrolled') AND substr(q.updated_at,1,7) = substr(${t},1,7) THEN 1 ELSE 0 END)
        FROM enquiries q LEFT JOIN users u ON u.id = q.assigned_to GROUP BY u.full_name ORDER BY count(*) DESC` },

    // ---------------------------------------------------------------- transport
    transport_zone_students: { title: 'Students by transport zone', about: 'Every child on a bus, grouped by the zone of their pickup stop, with the route and the stop.', perm: 'operations.transport.read',
      header: ['Zone', 'Route', 'Stop', 'Admission No', 'Name', 'Class', 'Guardian', 'Phone', 'Pickup'],
      query: `SELECT COALESCE(NULLIF(ps.zone,''),'No zone'), r.name, ps.name, st.admission_no, ${name2('st')}, ${cls}, COALESCE(g.full_name,''), COALESCE(g.phone,''), COALESCE(substr(ps.pickup_time,1,5),'')
        FROM transport_allocations ta JOIN students st ON st.id = ta.student_id ${latestEnrol} ${primaryGuardian}
        JOIN routes r ON r.id = ta.route_id LEFT JOIN route_stops ps ON ps.id = ta.pickup_stop_id
        WHERE ta.valid_to IS NULL AND st.status = 'active' ORDER BY 1, r.name, ps.sequence, st.admission_no` },
    transport_daily_sheet: { title: 'Daily transport sheet', about: 'Today, route by route: the bus, the driver, how many children are allocated, how many boarded this morning and were dropped, and who was marked absent on the bus.', perm: 'operations.transport.read',
      header: ['Route', 'Bus', 'Driver', 'Allocated', 'Boarded (morning)', 'Dropped (afternoon)', 'Absent on bus', 'Stops'],
      query: `SELECT r.name, COALESCE(v.registration_no,''), COALESCE(${name2('d')},''),
          (SELECT count(*) FROM transport_allocations ta WHERE ta.route_id = r.id AND ta.valid_to IS NULL),
          (SELECT count(*) FROM transport_attendance x WHERE x.route_id = r.id AND x.on_date = ${t} AND x.leg = 'morning' AND x.status = 'boarded'),
          (SELECT count(*) FROM transport_attendance x WHERE x.route_id = r.id AND x.on_date = ${t} AND x.leg = 'afternoon' AND x.status IN ('boarded','alighted')),
          (SELECT count(*) FROM transport_attendance x WHERE x.route_id = r.id AND x.on_date = ${t} AND x.status = 'absent'),
          (SELECT count(*) FROM route_stops rs WHERE rs.route_id = r.id AND rs.is_school = 0)
        FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN employees d ON d.id = v.driver_employee_id
        WHERE r.is_active = 1 ORDER BY r.name` },
    vehicle_papers: { title: 'Vehicles and their papers', about: 'Every bus with its capacity, driver, attendant, and when the insurance, fitness, permit and pollution certificates run out.', perm: 'operations.transport.read',
      header: ['Bus', 'Registration', 'Model', 'Capacity', 'Driver', 'Attendant', 'Insurance to', 'Fitness to', 'Permit to', 'PUC to', 'GPS device', 'Status'],
      query: `SELECT COALESCE(v.bus_code,''), v.registration_no, COALESCE(v.model,''), COALESCE(CAST(v.capacity AS TEXT),''), COALESCE(${name2('d')},''), COALESCE(${name2('a')},''),
          COALESCE(${dmy('v.insurance_expiry')},''), COALESCE(${dmy('v.fitness_expiry')},''), COALESCE(${dmy('v.permit_expiry')},''), COALESCE(${dmy('v.puc_expiry')},''), COALESCE(v.gps_device_id,''), v.status
        FROM vehicles v LEFT JOIN employees d ON d.id = v.driver_employee_id LEFT JOIN employees a ON a.id = v.attendant_employee_id ORDER BY v.bus_code, v.registration_no` },

    // ---------------------------------------------------------------- organisation
    roles_menus: { title: 'Menus by role', about: 'For every role in this school, the screens it can open. What MCB calls user-type-wise menus.', perm: 'access.roles.read',
      header: ['Role', 'Screens', 'People holding it', 'Customised'],
      query: `SELECT r.name, (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key LIKE '%.%.%' AND rp.permission_key NOT LIKE 'self.%'),
          (SELECT count(DISTINCT ur.user_id) FROM user_roles ur WHERE ur.role_id = r.id), CASE WHEN r.customised_at IS NULL THEN 'No' ELSE 'Yes' END
        FROM roles r ORDER BY r.name` },
  }
}
