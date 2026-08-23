package api

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* CSV export.

   Indian schools live in Excel: every report eventually gets pasted into a
   spreadsheet, mailed to a trustee, or filed. A screen you cannot get data out
   of is a screen people work around by retyping. */

// exportable maps a URL slug to a query. Kept as an allowlist rather than
// accepting SQL or table names from the client, which would be an injection
// surface wearing a convenience costume.
var exportable = map[string]struct {
	perm string
	// What the file is called on screen. The URL slug is a slug —
	// "staff-attendance", "library-loans" — and ten of thirteen datasets were
	// offering it to a principal as though it were a name. A person choosing
	// what to send their trustee should not have to translate.
	title  string
	about  string
	header []string
	query  string
}{
	"students": {
		title:  "Student roll",
		about:  "Every student with their class, guardian and contact details.",
		perm:   "students.read",
		header: []string{"Admission No", "Name", "Class", "Section", "Roll", "Gender", "Date of Birth", "Medium", "Guardian", "Phone", "Status"},
		query: `SELECT st.admission_no,
		               concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		               COALESCE(c.name,''), COALESCE(sec.name,''),
		               COALESCE(en.roll_no::text,''), COALESCE(st.gender,''),
		               COALESCE(to_char(st.date_of_birth,'DD/MM/YYYY'),''),
		               COALESCE(st.medium,''), COALESCE(g.full_name,''),
		               COALESCE(g.phone,''), st.status
		          FROM students st
		          LEFT JOIN LATERAL (
		              SELECT e.class_id, e.section_id, e.roll_no FROM enrollments e
		               WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
		          ) en ON true
		          LEFT JOIN classes  c   ON c.id = en.class_id
		          LEFT JOIN sections sec ON sec.id = en.section_id
		          LEFT JOIN LATERAL (
		              SELECT gg.full_name, gg.phone FROM student_guardians sg
		                JOIN guardians gg ON gg.id = sg.guardian_id
		               WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1
		          ) g ON true
		         ORDER BY c.level NULLS LAST, sec.name, st.admission_no`,
	},
	"defaulters": {
		title:  "Fee defaulters",
		about:  "Who owes what, how late they are, and which ageing bucket it falls in.",
		perm:   "finance.invoices.read",
		header: []string{"Admission No", "Student", "Class", "Guardian", "Phone", "Oldest Due", "Days Overdue", "Balance (Rs)", "Bucket"},
		query: `SELECT st.admission_no,
		               concat_ws(' ', st.first_name, st.last_name),
		               COALESCE(c.name || '-' || sec.name,''),
		               COALESCE(g.full_name,''), COALESCE(g.phone,''),
		               COALESCE(to_char(min(i.due_on),'DD/MM/YYYY'),''),
		               COALESCE(GREATEST(0,(CURRENT_DATE - min(i.due_on)))::text,'0'),
		               to_char(sum(i.net_paise - i.paid_paise)/100.0,'FM999999990.00'),
		               CASE WHEN CURRENT_DATE - min(i.due_on) > 90 THEN '90+'
		                    WHEN CURRENT_DATE - min(i.due_on) > 60 THEN '61-90'
		                    WHEN CURRENT_DATE - min(i.due_on) > 30 THEN '31-60'
		                    ELSE '0-30' END
		          FROM invoices i
		          JOIN students st ON st.id = i.student_id
		          LEFT JOIN LATERAL (
		              SELECT e.class_id, e.section_id FROM enrollments e
		               WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
		          ) en ON true
		          LEFT JOIN classes  c   ON c.id = en.class_id
		          LEFT JOIN sections sec ON sec.id = en.section_id
		          LEFT JOIN LATERAL (
		              SELECT gg.full_name, gg.phone FROM student_guardians sg
		                JOIN guardians gg ON gg.id = sg.guardian_id
		               WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1
		          ) g ON true
		         WHERE i.status IN ('unpaid','partial','overdue')
		           AND i.due_on IS NOT NULL AND i.due_on < CURRENT_DATE
		         GROUP BY st.id, c.name, sec.name, g.full_name, g.phone
		        HAVING sum(i.net_paise - i.paid_paise) > 0
		         ORDER BY 7 DESC`,
	},
	"collections": {
		title:  "Fee collections",
		about:  "Money taken, by day and by mode.",
		perm:   "finance.payments.read",
		header: []string{"Receipt No", "Date", "Student", "Admission No", "Mode", "Amount (Rs)", "Status", "Collected By"},
		query: `SELECT COALESCE(p.receipt_no,''), to_char(p.paid_on,'DD/MM/YYYY'),
		               concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		               p.mode, to_char(p.amount_paise/100.0,'FM999999990.00'),
		               p.status, COALESCE(u.full_name,'')
		          FROM payments p
		          JOIN students st ON st.id = p.student_id
		          LEFT JOIN users u ON u.id = p.collected_by
		         ORDER BY p.paid_on DESC, p.receipt_no DESC`,
	},
	"attendance": {
		title:  "Student attendance",
		about:  "The register, day by day.",
		perm:   "academics.attendance.read.all",
		header: []string{"Date", "Admission No", "Student", "Class", "Section", "Status"},
		query: `SELECT to_char(sa.on_date,'DD/MM/YYYY'), st.admission_no,
		               concat_ws(' ', st.first_name, st.last_name),
		               COALESCE(c.name,''), COALESCE(sec.name,''), sa.status
		          FROM student_attendance sa
		          JOIN students st  ON st.id = sa.student_id
		          LEFT JOIN sections sec ON sec.id = sa.section_id
		          LEFT JOIN classes  c   ON c.id = sec.class_id
		         WHERE sa.on_date >= CURRENT_DATE - INTERVAL '90 days'
		         ORDER BY sa.on_date DESC, st.admission_no`,
	},
	"staff": {
		title:  "Staff list",
		about:  "Everyone on the roll with department, designation and joining date.",
		perm:   "hr.employees.read",
		header: []string{"Code", "Name", "Department", "Designation", "Email", "Phone", "Joined", "Status"},
		query: `SELECT e.employee_code, concat_ws(' ', e.first_name, e.last_name),
		               COALESCE(d.name,''), COALESCE(dg.name,''),
		               COALESCE(e.email::text,''), COALESCE(e.phone,''),
		               to_char(e.joined_on,'DD/MM/YYYY'), e.status
		          FROM employees e
		          LEFT JOIN departments  d  ON d.id = e.department_id
		          LEFT JOIN designations dg ON dg.id = e.designation_id
		         ORDER BY e.employee_code`,
	},
	/* The registers a school actually files.

	   Six datasets could be exported and the rest of the product could not,
	   which meant the salary register, the mark sheet, the leave register and
	   the staff attendance register — the four things most often asked for by
	   an auditor, a board or a trustee — were read off a screen and retyped
	   into Excel. A screen you cannot get data out of is a screen people work
	   around.

	   Each is the whole current picture rather than a filtered slice: a filter
	   that silently drops rows produces a file somebody files as complete. */
	"payroll": {
		title:  "Salary register",
		about:  "Each month's payslips: days paid, gross, deductions and take-home.",
		perm:   "hr.payroll.read",
		header: []string{"Month", "Year", "Code", "Employee", "Paid Days", "LOP Days", "Gross (Rs)", "Deductions (Rs)", "Net (Rs)", "Status"},
		query: `SELECT to_char(to_date(pr.period_month::text,'MM'),'Month'), pr.period_year::text,
		               e.employee_code, concat_ws(' ', e.first_name, e.last_name),
		               ps.paid_days::text, ps.lop_days::text,
		               to_char(ps.gross_paise/100.0,'FM999999990.00'),
		               to_char(ps.deduction_paise/100.0,'FM999999990.00'),
		               to_char(ps.net_paise/100.0,'FM999999990.00'),
		               pr.status
		          FROM payslips ps
		          JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
		          JOIN employees e ON e.id = ps.employee_id
		         ORDER BY pr.period_year DESC, pr.period_month DESC, e.employee_code`,
	},
	"marks": {
		title:  "Mark sheet",
		about:  "Every mark entered, by exam, class and subject.",
		perm:   "academics.exams.read",
		header: []string{"Exam", "Class", "Subject", "Admission No", "Student", "Marks", "Grace", "Total", "Out Of", "Grade", "Absent"},
		query: `SELECT ex.name, c.name, sub.name, st.admission_no,
		               concat_ws(' ', st.first_name, st.last_name),
		               COALESCE(m.marks_obtained::text,''), m.grace_marks::text,
		               COALESCE((m.marks_obtained + m.grace_marks)::text,''),
		               es.max_marks::text, COALESCE(m.grade,''),
		               CASE WHEN m.is_absent THEN 'yes' ELSE 'no' END
		          FROM marks m
		          JOIN exam_subjects es  ON es.id = m.exam_subject_id
		          JOIN exams ex          ON ex.id = es.exam_id
		          JOIN class_subjects cs ON cs.id = es.class_subject_id
		          JOIN classes c         ON c.id = cs.class_id
		          JOIN subjects sub      ON sub.id = cs.subject_id
		          JOIN students st       ON st.id = m.student_id
		         ORDER BY ex.name, c.name, sub.name, st.admission_no`,
	},
	"staff-attendance": {
		title:  "Staff register",
		about:  "Who was present, absent or late, day by day.",
		perm:   "hr.attendance.write",
		header: []string{"Date", "Code", "Employee", "Status", "In", "Out", "Remarks"},
		query: `SELECT to_char(sa.on_date,'DD/MM/YYYY'), e.employee_code,
		               concat_ws(' ', e.first_name, e.last_name), sa.status,
		               COALESCE(to_char(sa.check_in,'HH24:MI'),''),
		               COALESCE(to_char(sa.check_out,'HH24:MI'),''),
		               COALESCE(sa.remarks,'')
		          FROM staff_attendance sa
		          JOIN employees e ON e.user_id = sa.user_id
		         ORDER BY sa.on_date DESC, e.employee_code`,
	},
	"leave": {
		title:  "Leave register",
		about:  "Every leave request, who applied, and how it was decided.",
		perm:   "hr.employees.read",
		header: []string{"Applied By", "Kind", "Type", "From", "To", "Days", "Reason", "Status"},
		query: `SELECT COALESCE(concat_ws(' ', e.first_name, e.last_name),
		                        concat_ws(' ', st.first_name, st.last_name), ''),
		               lr.subject_kind, COALESCE(lt.name,''),
		               to_char(lr.from_date,'DD/MM/YYYY'), to_char(lr.to_date,'DD/MM/YYYY'),
		               lr.days::text, lr.reason, lr.status
		          FROM leave_requests lr
		          LEFT JOIN employees   e  ON e.id  = lr.employee_id
		          LEFT JOIN students    st ON st.id = lr.student_id
		          LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
		         ORDER BY lr.created_at DESC`,
	},
	"staff-documents": {
		title:  "Staff document expiry",
		about:  "Which papers have lapsed and which lapse soon.",
		perm:   "hr.employees.read",
		header: []string{"Code", "Employee", "Document", "Expires", "Days Left", "State"},
		query: `SELECT e.employee_code, concat_ws(' ', e.first_name, e.last_name),
		               d.doc_type,
		               COALESCE(to_char(d.expires_on,'DD/MM/YYYY'),''),
		               COALESCE((d.expires_on - CURRENT_DATE)::text,''),
		               CASE WHEN d.expires_on IS NULL THEN 'does not expire'
		                    WHEN d.expires_on < CURRENT_DATE THEN 'lapsed'
		                    WHEN d.expires_on < CURRENT_DATE + 60 THEN 'expiring'
		                    ELSE 'valid' END
		          FROM employee_documents d
		          JOIN employees e ON e.id = d.employee_id
		         ORDER BY d.expires_on NULLS LAST`,
	},
	"admissions": {
		title:  "Admission applications",
		about:  "Applicants, the class sought, and where each has got to.",
		perm:   "admissions.read",
		header: []string{"Application No", "Applicant", "Class Sought", "Guardian", "Phone", "RTE", "Status", "Applied"},
		query: `SELECT a.application_no,
		               concat_ws(' ', a.first_name, a.last_name),
		               COALESCE(c.name,''), COALESCE(a.parent_name,''),
		               COALESCE(a.parent_phone,''),
		               CASE WHEN a.is_rte THEN 'yes' ELSE 'no' END,
		               a.status, to_char(a.created_at,'DD/MM/YYYY')
		          FROM applications a
		          LEFT JOIN classes c ON c.id = a.class_sought
		         ORDER BY a.created_at DESC`,
	},
	"library-loans": {
		title:  "Library issue register",
		about:  "Books out, due, returned, and the fines owing.",
		perm:   "operations.library.read",
		header: []string{"Title", "Borrower", "Issued", "Due", "Returned", "Fine (Rs)"},
		query: `SELECT COALESCE(t.title,''),
		               COALESCE(concat_ws(' ', st.first_name, st.last_name),
		                        concat_ws(' ', e.first_name, e.last_name), ''),
		               to_char(l.issued_on,'DD/MM/YYYY'),
		               COALESCE(to_char(l.due_on,'DD/MM/YYYY'),''),
		               COALESCE(to_char(l.returned_on,'DD/MM/YYYY'),''),
		               to_char(COALESCE(l.fine_paise,0)/100.0,'FM999999990.00')
		          FROM library_loans l
		          LEFT JOIN library_copies  cp ON cp.id = l.copy_id
		          LEFT JOIN library_titles  t  ON t.id = cp.title_id
		          LEFT JOIN students st ON st.id = l.student_id
		          LEFT JOIN employees e ON e.id = l.employee_id
		         ORDER BY l.issued_on DESC`,
	},
	"udise": {
		title:  "UDISE+ student data",
		about:  "The fields the government return asks for, with the gaps flagged.",
		perm:   "admin.reports.read",
		header: []string{"Admission No", "Name", "APAAR ID", "Child Info ID", "Date of Birth", "Gender", "Class", "Medium", "RTE", "CWSN", "Problems"},
		query: `SELECT st.admission_no,
		               concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		               COALESCE(st.apaar_id,''), COALESCE(st.child_info_id,''),
		               COALESCE(to_char(st.date_of_birth,'DD/MM/YYYY'),''),
		               COALESCE(st.gender,''), COALESCE(c.name,''), COALESCE(st.medium,''),
		               CASE WHEN st.is_rte THEN 'Y' ELSE 'N' END,
		               CASE WHEN st.is_cwsn THEN 'Y' ELSE 'N' END,
		               trim(both ', ' FROM concat_ws(', ',
		                 CASE WHEN st.date_of_birth IS NULL THEN 'date of birth missing' END,
		                 CASE WHEN st.gender IS NULL THEN 'gender missing' END,
		                 CASE WHEN st.apaar_id IS NULL THEN 'APAAR not issued' END,
		                 CASE WHEN NOT st.aadhaar_consent THEN 'Aadhaar consent missing' END))
		          FROM students st
		          LEFT JOIN LATERAL (
		              SELECT e.class_id FROM enrollments e
		               WHERE e.student_id = st.id AND e.status='active' LIMIT 1
		          ) en ON true
		          LEFT JOIN classes c ON c.id = en.class_id
		         WHERE st.status = 'active'
		         ORDER BY st.admission_no`,
	},
}

// exportCSV streams an allowlisted report.
//
// Rows are written as they are read rather than buffered: a whole-school
// attendance export is tens of thousands of rows, and holding that in memory on
// a 1 vCPU box to build one string would be the slowest thing the server does.
func (s *Server) exportCSV(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	name := chiURLParam(r, "name")

	spec, ok := exportable[name]
	if !ok {
		httpx.NotFound(w, r)
		return
	}
	if !id.Can(spec.perm) {
		httpx.Forbidden(w, r, spec.perm)
		return
	}

	filename := fmt.Sprintf("%s-%s.csv", name, time.Now().Format("2006-01-02"))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)

	cw := csv.NewWriter(w)
	// Excel opens a UTF-8 CSV as ANSI unless it sees a BOM, which turns Telugu
	// names into mojibake for exactly the schools that need them most.
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
	_ = cw.Write(spec.header)

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), spec.query)
		if err != nil {
			return err
		}
		defer rows.Close()

		n := len(spec.header)
		for rows.Next() {
			vals, err := rows.Values()
			if err != nil {
				return err
			}
			rec := make([]string, n)
			for i := 0; i < n && i < len(vals); i++ {
				if vals[i] == nil {
					continue
				}
				rec[i] = strings.TrimSpace(fmt.Sprint(vals[i]))
			}
			if err := cw.Write(rec); err != nil {
				return err
			}
		}
		return rows.Err()
	})
	cw.Flush()
	if err != nil {
		// Headers are already sent, so the only honest signal left is a marker
		// row — better than a silently truncated file the school then files.
		_, _ = w.Write([]byte("\n# EXPORT FAILED - this file is incomplete\n"))
	}
}

// listExports tells the client which reports it may download.
func (s *Server) listExports(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []map[string]any{}
	for name, spec := range exportable {
		if !id.Can(spec.perm) {
			continue
		}
		title := spec.title
		if title == "" {
			title = name
		}
		out = append(out, map[string]any{
			"name": name, "title": title, "about": spec.about,
			"url": "/api/v1/export/" + name, "columns": spec.header,
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}
