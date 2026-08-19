package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Finance, Admissions & Front Office, HR & Payroll, Operations Staff.
   All institution-scoped: these roles work across the whole tenant, so RLS is
   the only boundary that applies. Money is bigint paise everywhere — never a
   float, and never rupees. */

// --- Accounts & Finance -------------------------------------------------------

type financeKPIs struct {
	// TodayPaise stays "today" whatever the range: a cashier balancing the
	// till at 4pm needs the drawer figure, not the period's.
	TodayPaise int64 `json:"today_paise"`
	// MonthPaise is the range total, whatever range was asked for. The field
	// keeps its name so existing clients do not break.
	MonthPaise       int64 `json:"month_paise"`
	OutstandingPaise int64 `json:"outstanding_paise"`
	OverduePaise     int64 `json:"overdue_paise"`
	Defaulters       int   `json:"defaulters"`
	Invoices         int   `json:"invoices"`
	Unreconciled     int   `json:"unreconciled"`
	RefundsPending   int   `json:"refunds_pending"`

	Range dateRange `json:"range"`
	// Balances and counts of open items are levels: true now, not for a
	// period. Named so the client can label them "as of today".
	AsOf []string `json:"as_of_now"`
}

// getFinanceDashboard powers finance.dashboard.finance_kpis.
func (s *Server) getFinanceDashboard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var k financeKPIs
	rng := resolveRange(r)
	k.Range = rng
	k.AsOf = []string{"today_paise", "outstanding_paise", "overdue_paise",
		"defaulters", "invoices", "unreconciled", "refunds_pending"}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT
			  COALESCE((SELECT sum(amount_paise) FROM payments
			             WHERE status='success' AND paid_on = CURRENT_DATE), 0),
			  COALESCE((SELECT sum(amount_paise) FROM payments
			             WHERE status='success'
			               AND paid_on::date BETWEEN $1::date AND $2::date), 0),
			  COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
			             WHERE status IN ('unpaid','partial','overdue')), 0),
			  COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
			             WHERE status IN ('unpaid','partial','overdue')
			               AND due_on IS NOT NULL AND due_on < CURRENT_DATE), 0),
			  (SELECT count(DISTINCT student_id) FROM invoices
			    WHERE status IN ('unpaid','partial','overdue')
			      AND due_on IS NOT NULL AND due_on < CURRENT_DATE),
			  (SELECT count(*) FROM invoices),
			  -- Gateway money we have taken but not tied to a bank settlement.
			  (SELECT count(*) FROM payments
			    WHERE gateway IS NOT NULL AND reconciled_at IS NULL AND status='success'),
			  (SELECT count(*) FROM refunds WHERE status = 'pending')
		`, rng.FromS, rng.ToS).Scan(&k.TodayPaise, &k.MonthPaise, &k.OutstandingPaise, &k.OverduePaise,
			&k.Defaulters, &k.Invoices, &k.Unreconciled, &k.RefundsPending)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, k)
}

type invoiceRow struct {
	ID          string  `json:"id"`
	InvoiceNo   string  `json:"invoice_no"`
	StudentID   string  `json:"student_id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	IssuedOn    string  `json:"issued_on"`
	DueOn       *string `json:"due_on,omitempty"`
	NetPaise    int64   `json:"net_paise"`
	PaidPaise   int64   `json:"paid_paise"`
	DuePaise    int64   `json:"due_paise"`
	Status      string  `json:"status"`
}

// listInvoices powers finance.fee_workspace.* invoice views.
func (s *Server) listInvoices(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT i.id::text, i.invoice_no, i.student_id::text,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name), st.admission_no,
		       to_char(i.issued_on,'YYYY-MM-DD'), to_char(i.due_on,'YYYY-MM-DD'),
		       i.net_paise, i.paid_paise, i.net_paise - i.paid_paise, i.status
		  FROM invoices i
		  JOIN students st ON st.id = i.student_id
		 WHERE ($1::text IS NULL OR i.status = $1)
		   AND (NOT $2::bool OR (i.status IN ('unpaid','partial','overdue')
		                         AND i.due_on IS NOT NULL AND i.due_on < CURRENT_DATE))
		 ORDER BY i.issued_on DESC, i.invoice_no
		 LIMIT 300`,
		[]any{nullString(q.Get("status")), q.Get("overdue") == "true"},
		func(rows pgx.Rows) (invoiceRow, error) {
			var v invoiceRow
			return v, rows.Scan(&v.ID, &v.InvoiceNo, &v.StudentID, &v.StudentName,
				&v.AdmissionNo, &v.IssuedOn, &v.DueOn, &v.NetPaise, &v.PaidPaise,
				&v.DuePaise, &v.Status)
		})
	respond(w, r, items, err)
}

type paymentRow struct {
	ID          string  `json:"id"`
	ReceiptNo   *string `json:"receipt_no,omitempty"`
	StudentName string  `json:"student_name"`
	AmountPaise int64   `json:"amount_paise"`
	Mode        string  `json:"mode"`
	PaidOn      string  `json:"paid_on"`
	Status      string  `json:"status"`
	Gateway     *string `json:"gateway,omitempty"`
	Reconciled  bool    `json:"reconciled"`
}

// listPayments powers finance.fee_workspace.counter_fee_collection history and
// the reconciliation view.
func (s *Server) listPayments(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT p.id::text, p.receipt_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       p.amount_paise, p.mode, to_char(p.paid_on,'YYYY-MM-DD'),
		       p.status, p.gateway, p.reconciled_at IS NOT NULL
		  FROM payments p
		  JOIN students st ON st.id = p.student_id
		 ORDER BY p.paid_on DESC, p.created_at DESC
		 LIMIT 300`, nil,
		func(rows pgx.Rows) (paymentRow, error) {
			var v paymentRow
			return v, rows.Scan(&v.ID, &v.ReceiptNo, &v.StudentName, &v.AmountPaise,
				&v.Mode, &v.PaidOn, &v.Status, &v.Gateway, &v.Reconciled)
		})
	respond(w, r, items, err)
}

// --- Admissions & Front Office -------------------------------------------------

type admissionsKPIs struct {
	Enquiries    int `json:"enquiries"`
	NewEnquiries int `json:"new_enquiries"`
	Applications int `json:"applications"`
	Incomplete   int `json:"incomplete"`
	Admitted     int `json:"admitted"`
	Enrolled     int `json:"enrolled"`
	FollowUps    int `json:"follow_ups_due"`
}

// getAdmissionsDashboard powers admissions.dashboard.admissions_kpis.
func (s *Server) getAdmissionsDashboard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var k admissionsKPIs
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT
			  (SELECT count(*) FROM enquiries),
			  (SELECT count(*) FROM enquiries WHERE status = 'new'),
			  (SELECT count(*) FROM applications),
			  (SELECT count(*) FROM applications WHERE status = 'draft'),
			  (SELECT count(*) FROM applications WHERE status = 'offered'),
			  (SELECT count(*) FROM applications WHERE student_id IS NOT NULL),
			  (SELECT count(*) FROM enquiries
			    WHERE next_follow_up IS NOT NULL AND next_follow_up <= CURRENT_DATE
			      AND status NOT IN ('applied','lost'))
		`).Scan(&k.Enquiries, &k.NewEnquiries, &k.Applications, &k.Incomplete,
			&k.Admitted, &k.Enrolled, &k.FollowUps)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, k)
}

type enquiryRow struct {
	ID           string  `json:"id"`
	StudentName  string  `json:"student_name"`
	ParentName   *string `json:"parent_name,omitempty"`
	Phone        string  `json:"phone"`
	Source       string  `json:"source"`
	Status       string  `json:"status"`
	NextFollowUp *string `json:"next_follow_up,omitempty"`
	AssignedTo   *string `json:"assigned_to,omitempty"`
	CreatedAt    string  `json:"created_at"`
}

// listEnquiries powers admissions.admissions_workspace.enquiries_leads.
func (s *Server) listEnquiries(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT e.id::text, e.student_name, e.parent_name, e.phone, e.source, e.status,
		       to_char(e.next_follow_up,'YYYY-MM-DD'), u.full_name,
		       to_char(e.created_at,'YYYY-MM-DD')
		  FROM enquiries e
		  LEFT JOIN users u ON u.id = e.assigned_to
		 WHERE ($1::text IS NULL OR e.status = $1)
		 ORDER BY e.created_at DESC
		 LIMIT 300`, []any{nullString(r.URL.Query().Get("status"))},
		func(rows pgx.Rows) (enquiryRow, error) {
			var v enquiryRow
			return v, rows.Scan(&v.ID, &v.StudentName, &v.ParentName, &v.Phone,
				&v.Source, &v.Status, &v.NextFollowUp, &v.AssignedTo, &v.CreatedAt)
		})
	respond(w, r, items, err)
}

type applicationRow struct {
	ID            string  `json:"id"`
	ApplicationNo string  `json:"application_no"`
	Name          string  `json:"name"`
	ClassSought   *string `json:"class_sought,omitempty"`
	ParentName    string  `json:"parent_name"`
	ParentPhone   string  `json:"parent_phone"`
	IsRTE         bool    `json:"is_rte"`
	Status        string  `json:"status"`
	CreatedAt     string  `json:"created_at"`
}

// listApplications powers admissions.admissions_workspace.applications.
func (s *Server) listApplications(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT a.id::text, a.application_no,
		       concat_ws(' ', a.first_name, a.middle_name, a.last_name),
		       c.name, a.parent_name, a.parent_phone, a.is_rte, a.status,
		       to_char(a.created_at,'YYYY-MM-DD')
		  FROM applications a
		  LEFT JOIN classes c ON c.id = a.class_sought
		 WHERE ($1::text IS NULL OR a.status = $1)
		 ORDER BY a.created_at DESC
		 LIMIT 300`, []any{nullString(r.URL.Query().Get("status"))},
		func(rows pgx.Rows) (applicationRow, error) {
			var v applicationRow
			return v, rows.Scan(&v.ID, &v.ApplicationNo, &v.Name, &v.ClassSought,
				&v.ParentName, &v.ParentPhone, &v.IsRTE, &v.Status, &v.CreatedAt)
		})
	respond(w, r, items, err)
}

// --- HR & Payroll ---------------------------------------------------------------

type hrKPIs struct {
	Headcount    int `json:"headcount"`
	PresentToday int `json:"present_today"`
	AbsentToday  int `json:"absent_today"`
	LeavePending int `json:"leave_pending"`
	NewJoiners   int `json:"new_joiners_30d"`
	Departments  int `json:"departments"`
}

// getHRDashboard powers hr.dashboard.hr_kpis.
func (s *Server) getHRDashboard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var k hrKPIs
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT
			  (SELECT count(*) FROM employees WHERE status='active'),
			  (SELECT count(*) FROM staff_attendance
			    WHERE on_date = CURRENT_DATE AND status IN ('present','late')),
			  (SELECT count(*) FROM staff_attendance
			    WHERE on_date = CURRENT_DATE AND status = 'absent'),
			  (SELECT count(*) FROM leave_requests
			    WHERE status='pending' AND subject_kind = 'employee'),
			  (SELECT count(*) FROM employees
			    WHERE joined_on >= CURRENT_DATE - INTERVAL '30 days'),
			  (SELECT count(*) FROM departments)
		`).Scan(&k.Headcount, &k.PresentToday, &k.AbsentToday, &k.LeavePending,
			&k.NewJoiners, &k.Departments)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, k)
}

type employeeRow struct {
	ID          string  `json:"id"`
	Code        string  `json:"employee_code"`
	FullName    string  `json:"full_name"`
	Department  *string `json:"department,omitempty"`
	Designation *string `json:"designation,omitempty"`
	Phone       *string `json:"phone,omitempty"`
	Email       *string `json:"email,omitempty"`
	JoinedOn    string  `json:"joined_on"`
	Status      string  `json:"status"`
}

// listEmployees powers hr.hr_workspace.employee_master_directory.
func (s *Server) listEmployees(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT e.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name),
		       d.name, dg.name, e.phone, e.email::text,
		       to_char(e.joined_on,'YYYY-MM-DD'), e.status
		  FROM employees e
		  LEFT JOIN departments  d  ON d.id = e.department_id
		  LEFT JOIN designations dg ON dg.id = e.designation_id
		 WHERE ($1::text IS NULL OR e.status = $1)
		 ORDER BY e.employee_code
		 LIMIT 300`, []any{nullString(r.URL.Query().Get("status"))},
		func(rows pgx.Rows) (employeeRow, error) {
			var v employeeRow
			return v, rows.Scan(&v.ID, &v.Code, &v.FullName, &v.Department,
				&v.Designation, &v.Phone, &v.Email, &v.JoinedOn, &v.Status)
		})
	respond(w, r, items, err)
}

type leaveRow struct {
	ID        string  `json:"id"`
	Who       string  `json:"who"`
	Kind      string  `json:"subject_kind"`
	LeaveType *string `json:"leave_type,omitempty"`
	FromDate  string  `json:"from_date"`
	ToDate    string  `json:"to_date"`
	Days      string  `json:"days"`
	Reason    string  `json:"reason"`
	Status    string  `json:"status"`
}

// listLeaveRequests powers hr.hr_workspace.staff_leave_application_management.
/* Leave, seen by whoever is asking.

   The faculty "Leave & self service" screen pointed here, and the route
   required hr.employees.read — so a teacher could apply for leave and then not
   see whether it had been granted. Self-service does not mean holding an HR
   permission; it means seeing your own rows.

   Everyone may call this. Anyone without the HR grant gets their own leave and
   nothing else, which is the whole difference between the two screens. */
// leaveArgs supplies the user id only when the predicate references it; pgx
// rejects a parameter the query never mentions.
func leaveArgs(r *http.Request, id *httpx.Identity, mine string) []any {
	args := []any{nullString(r.URL.Query().Get("status"))}
	if mine != "TRUE" {
		args = append(args, id.UserID)
	}
	return args
}

func (s *Server) listLeaveRequests(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	mine := "TRUE"
	if !id.Can(rbac.EmployeesRead) {
		mine = `e.user_id = $2`
	}

	items, err := collect(s, r, `
		SELECT lr.id::text,
		       COALESCE(concat_ws(' ', e.first_name, e.last_name),
		                concat_ws(' ', st.first_name, st.last_name), '—'),
		       lr.subject_kind, lt.name,
		       to_char(lr.from_date,'YYYY-MM-DD'), to_char(lr.to_date,'YYYY-MM-DD'),
		       lr.days::text, lr.reason, lr.status
		  FROM leave_requests lr
		  LEFT JOIN employees  e  ON e.id = lr.employee_id
		  LEFT JOIN students   st ON st.id = lr.student_id
		  LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
		 WHERE ($1::text IS NULL OR lr.status = $1)
		   AND `+mine+`
		 ORDER BY lr.created_at DESC
		 LIMIT 300`, leaveArgs(r, id, mine),
		func(rows pgx.Rows) (leaveRow, error) {
			var v leaveRow
			return v, rows.Scan(&v.ID, &v.Who, &v.Kind, &v.LeaveType,
				&v.FromDate, &v.ToDate, &v.Days, &v.Reason, &v.Status)
		})
	respond(w, r, items, err)
}

// --- Operations Staff -----------------------------------------------------------

type operationsKPIs struct {
	LibraryTitles  int `json:"library_titles"`
	LoansOut       int `json:"loans_out"`
	LoansOverdue   int `json:"loans_overdue"`
	Vehicles       int `json:"vehicles"`
	Routes         int `json:"routes"`
	DocsExpiring   int `json:"vehicle_docs_expiring"`
	HostelStudents int `json:"hostel_students"`
}

// getOperationsDashboard powers operations.specialist_workspace.role_specific_home.
//
// One payload covering every operations sub-role: which numbers the user
// actually sees is decided by their grants, not by a different endpoint per
// specialism.
func (s *Server) getOperationsDashboard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var k operationsKPIs
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT
			  (SELECT count(*) FROM library_titles),
			  (SELECT count(*) FROM library_loans WHERE returned_on IS NULL),
			  (SELECT count(*) FROM library_loans
			    WHERE returned_on IS NULL AND due_on < CURRENT_DATE),
			  (SELECT count(*) FROM vehicles WHERE status = 'active'),
			  (SELECT count(*) FROM routes   WHERE is_active),
			  -- Any statutory document lapsing inside 30 days grounds the bus.
			  (SELECT count(*) FROM vehicles
			    WHERE status='active' AND least(
			        COALESCE(insurance_expiry,'infinity'::date),
			        COALESCE(fitness_expiry,  'infinity'::date),
			        COALESCE(permit_expiry,   'infinity'::date),
			        COALESCE(puc_expiry,      'infinity'::date))
			        <= CURRENT_DATE + INTERVAL '30 days'),
			  (SELECT count(*) FROM transport_allocations)
		`).Scan(&k.LibraryTitles, &k.LoansOut, &k.LoansOverdue, &k.Vehicles,
			&k.Routes, &k.DocsExpiring, &k.HostelStudents)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, k)
}

type loanRow struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Borrower  string  `json:"borrower"`
	IssuedOn  string  `json:"issued_on"`
	DueOn     string  `json:"due_on"`
	Returned  *string `json:"returned_on,omitempty"`
	FinePaise int64   `json:"fine_paise"`
	Overdue   bool    `json:"overdue"`
}

// listLibraryLoans powers operations.library_management.book_issue_return_terminal.
func (s *Server) listLibraryLoans(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT l.id::text, t.title,
		       COALESCE(concat_ws(' ', st.first_name, st.last_name),
		                concat_ws(' ', e.first_name,  e.last_name), '—'),
		       to_char(l.issued_on,'YYYY-MM-DD'), to_char(l.due_on,'YYYY-MM-DD'),
		       to_char(l.returned_on,'YYYY-MM-DD'), l.fine_paise,
		       l.returned_on IS NULL AND l.due_on < CURRENT_DATE
		  FROM library_loans l
		  JOIN library_copies  cp ON cp.id = l.copy_id
		  JOIN library_titles  t  ON t.id = cp.title_id
		  LEFT JOIN students  st ON st.id = l.student_id
		  LEFT JOIN employees e  ON e.id = l.employee_id
		 WHERE NOT $1::bool OR l.returned_on IS NULL
		 ORDER BY l.issued_on DESC
		 LIMIT 300`, []any{r.URL.Query().Get("open") == "true"},
		func(rows pgx.Rows) (loanRow, error) {
			var v loanRow
			return v, rows.Scan(&v.ID, &v.Title, &v.Borrower, &v.IssuedOn,
				&v.DueOn, &v.Returned, &v.FinePaise, &v.Overdue)
		})
	respond(w, r, items, err)
}

type vehicleRow struct {
	ID           string  `json:"id"`
	Registration string  `json:"registration_no"`
	Model        *string `json:"model,omitempty"`
	Capacity     int     `json:"capacity"`
	Route        *string `json:"route,omitempty"`
	Driver       *string `json:"driver,omitempty"`
	NextExpiry   *string `json:"next_expiry,omitempty"`
	Status       string  `json:"status"`
}

// listVehicles powers operations.transport_management.vehicle_master_registry.
func (s *Server) listVehicles(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT v.id::text, v.registration_no, v.model, v.capacity,
		       (SELECT rt.name FROM routes rt WHERE rt.vehicle_id = v.id LIMIT 1),
		       concat_ws(' ', e.first_name, e.last_name),
		       to_char(NULLIF(least(
		           COALESCE(v.insurance_expiry,'infinity'::date),
		           COALESCE(v.fitness_expiry,  'infinity'::date),
		           COALESCE(v.permit_expiry,   'infinity'::date),
		           COALESCE(v.puc_expiry,      'infinity'::date)),
		         'infinity'::date), 'YYYY-MM-DD'),
		       v.status
		  FROM vehicles v
		  LEFT JOIN employees e ON e.id = v.driver_employee_id
		 ORDER BY v.registration_no`, nil,
		func(rows pgx.Rows) (vehicleRow, error) {
			var v vehicleRow
			var driver *string
			if err := rows.Scan(&v.ID, &v.Registration, &v.Model, &v.Capacity,
				&v.Route, &driver, &v.NextExpiry, &v.Status); err != nil {
				return v, err
			}
			// concat_ws returns '' rather than NULL when both names are NULL.
			if driver != nil && *driver != "" {
				v.Driver = driver
			}
			return v, nil
		})
	respond(w, r, items, err)
}

// --- employee documents -------------------------------------------------------

type employeeDocRow struct {
	ID        string  `json:"id"`
	Employee  string  `json:"employee"`
	Code      string  `json:"employee_code"`
	DocType   string  `json:"doc_type"`
	ExpiresOn *string `json:"expires_on,omitempty"`
	DaysLeft  *int    `json:"days_left,omitempty"`
	Uploaded  string  `json:"uploaded_on"`
}

/*
listEmployeeDocuments doubles as the expiry register.

	A school keeps staff papers because an inspector asks for them and because
	some of them lapse: a teaching licence, a medical fitness certificate, a
	driver's police verification. Sorting by what expires soonest — with
	already-expired first — is the only ordering that makes the list worth
	opening, since a document with years left needs nobody's attention.

	Documents with no expiry are real and sort last: a degree certificate does
	not lapse.
*/
func (s *Server) listEmployeeDocuments(w http.ResponseWriter, r *http.Request) {
	onlyExpiring := r.URL.Query().Get("expiring") == "true"
	/* Narrowed on the same boundary as the lifecycle registers this sits
	   beside in the /hr group. The shelf holds one row per personal document
	   per named employee, so leaving it open would have meant the register of
	   everybody's Aadhaar and degree certificates stayed readable by a head of
	   department after the registers themselves were closed — the same defect,
	   one route along.

	   listEmployees and the dashboard above are deliberately not narrowed: a
	   staff directory of name, department and extension is what a directory is
	   for, and the dashboard returns counts rather than anybody's record. */
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{onlyExpiring})
	items, err := collect(s, r, `
		SELECT ed.id::text,
		       concat_ws(' ', e.first_name, e.last_name), e.employee_code,
		       ed.doc_type, to_char(ed.expires_on,'YYYY-MM-DD'),
		       CASE WHEN ed.expires_on IS NULL THEN NULL
		            ELSE (ed.expires_on - CURRENT_DATE)::int END,
		       to_char(ed.created_at,'YYYY-MM-DD')
		  FROM employee_documents ed
		  JOIN employees e ON e.id = ed.employee_id
		 WHERE (NOT $1::bool
		    OR (ed.expires_on IS NOT NULL AND ed.expires_on <= CURRENT_DATE + 60))
		   AND `+mine+`
		 ORDER BY ed.expires_on IS NULL, ed.expires_on
		 LIMIT 300`, args,
		func(rows pgx.Rows) (employeeDocRow, error) {
			var v employeeDocRow
			return v, rows.Scan(&v.ID, &v.Employee, &v.Code, &v.DocType,
				&v.ExpiresOn, &v.DaysLeft, &v.Uploaded)
		})
	respond(w, r, items, err)
}
