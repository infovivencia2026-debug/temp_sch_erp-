package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The staff lifecycle: joining, serving, leaving.

   The product held an employee row and a document shelf. Everything either
   side of that lived in a register on somebody's desk — the KYC an
   appointment is conditional on, the service book a DEO inspection asks for
   by name, the clearances a final settlement must not outrun, and the leave
   rules payroll had been quietly assuming.

   Two shapes recur. Anything that expires carries a date rather than a tick,
   because "police verified" with no date proves nothing. And anything that
   blocks is blocked in the database: 00031 refuses to mark a settlement paid
   while a department is still owed, so the rule holds for an import and a
   psql session as well as for the handler below. */

// mountHRLifecycle registers the lifecycle endpoints inside the existing /hr
// group, which already carries RequirePermission(EmployeesRead). Reads
// inherit that; writes name EmployeesWrite for themselves.
func (s *Server) mountHRLifecycle(r chi.Router) {
	write := httpx.RequirePermission(rbac.EmployeesWrite)

	r.Get("/onboarding", s.listOnboarding)
	r.With(write).Post("/onboarding", s.saveOnboarding)

	r.Get("/exits", s.listExits)
	r.With(write).Post("/exits", s.saveExit)
	r.With(write).Post("/exits/{id}/interview", s.recordExitInterview)
	r.Get("/exits/{id}/clearances", s.listExitClearances)
	r.With(write).Post("/exits/{id}/clearances", s.signExitClearance)
	r.With(write).Post("/exits/{id}/relieve", s.relieveStaff)
	r.With(write).Post("/exits/{id}/settle", s.settleExit)
	r.Get("/clearance-departments", s.listClearanceDepartments)
	r.Get("/service-certificates", s.listServiceCertificates)

	r.Get("/transfers", s.listTransfers)
	r.With(write).Post("/transfers", s.saveTransfer)
	r.Get("/seniority", s.listSeniority)

	r.Get("/service-book", s.listServiceBook)
	r.With(write).Post("/service-book", s.addServiceBookEntry)
	r.With(write).Post("/service-book/{id}/attest", s.attestServiceBookEntry)

	r.Get("/qualifications", s.listQualifications)
	r.With(write).Post("/qualifications", s.saveQualification)

	r.Get("/medical-fitness", s.listMedicalFitness)
	r.With(write).Post("/medical-fitness", s.recordMedicalFitness)

	r.Get("/background-checks", s.listBackgroundChecks)
	r.With(write).Post("/background-checks", s.saveBackgroundCheck)

	r.Get("/celebrations", s.listCelebrations)
	r.With(write).Post("/celebrations/greet", s.recordGreeting)

	r.Get("/grievances", s.listGrievances)
	r.With(write).Post("/grievances", s.raiseGrievance)
	r.With(write).Post("/grievances/{id}/decide", s.decideGrievance)

	r.Get("/recognitions", s.listRecognitions)
	r.With(write).Post("/recognitions", s.recordRecognition)

	/* The kinds of leave a school gives. leave_types has existed since the
	   first migration and nothing could ever create one, so the Type column
	   was empty in every school and "how many sick days do I have" had
	   nothing to answer from. */
	// The GET moved to api.go, registered before the hr.employees.read guard:
	// a teacher applying for leave has to be able to read the list of types,
	// and that gate is for the staff file, not for a dropdown. Writing one is
	// still hr.employees.write.
	r.With(write).Post("/leave-types", s.saveLeaveType)

	r.Get("/leave-policy", s.getLeavePolicy)
	r.With(write).Post("/leave-policy", s.saveLeavePolicy)
	// The morning grace window on its own, with the punches it would mark late.
	s.mountPunchGrace(r)
	r.Get("/lop", s.getLOPRegister)
}

// ===========================================================================
// Who may see whom
// ===========================================================================

/*
The registers below divide in two, and only one half is a staff-room
noticeboard.

	Seniority, the celebration diary, the recognitions board, the clearance
	department master and the leave policy are institution-wide by their
	nature. A seniority list ordered within one department is not a seniority
	list — the whole point of it is the single order transfer counselling is
	run from — and a birthday only one department may see is not much of a
	birthday. Those five are unchanged.

	Everything else here is personal to one employee: the KYC an appointment
	was conditional on, police verification and what it found, medical fitness
	and what somebody is not fit for, the exit file and its settlement, the
	service book, qualifications, and the month's loss of pay. All of it was
	readable in full by any holder of hr.employees.read — which the seeded hod,
	vice principal and examinations controller roles all carry, none of them
	holding hr.employees.write. One GET returned the school's police
	verifications. No id guessing, a real seeded role, one request.

	The narrowing is growthReach, the boundary hr_growth.go already defines and
	tests: the back office (hr.employees.write, or a platform admin) reads the
	institution, a head of department reads their department and their own row,
	anybody else reads their own row alone. Reusing it rather than writing a
	second predicate is deliberate — two boundaries over one subject drift
	apart, and the first sign of the drift is a record visible through one
	screen and withheld by the other.

	The writes need no narrowing. Every one of them carries
	RequirePermission(EmployeesWrite), and holding that is precisely what
	growthReach calls the back office, so a caller who may write already reads
	everything. TestHRLifecycleWritesNeedEmployeesWrite walks the router rather
	than trusting that sentence, so a route added later without the gate fails
	here instead of in a school.
*/

// lifecycleReach resolves the caller's boundary and answers the request itself
// if it cannot be resolved, so each handler below spends one line on it.
func (s *Server) lifecycleReach(w http.ResponseWriter, r *http.Request) (*growthReach, bool) {
	re, err := s.growthReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return nil, false
	}
	return re, true
}

// narrow appends the employee predicate's arguments to a handler's own and
// returns the SQL fragment to splice in.
//
// The fragment is always a complete boolean expression — TRUE for the back
// office, FALSE for somebody who heads nothing and has no employee row — so it
// can be concatenated unconditionally. FALSE rather than an omitted clause is
// the same choice internal/scope makes, and for the same reason: "this person
// heads nothing" has to mean no rows, because the other direction turns a
// scope bug into a breach.
func narrow(re *growthReach, alias string, args []any) (string, []any) {
	frag, extra := re.employeeFilter(alias, len(args)+1)
	return frag, append(args, extra...)
}

// exitInReach answers whether the caller may see this exit at all.
//
// Asked before the clearance list rather than folded into it so an exit
// belonging to another department reads as "no such exit" instead of "no
// clearances raised". The second sentence is untrue, and it tells the asker
// the id was worth trying.
func (s *Server) exitInReach(r *http.Request, re *growthReach, exitID uuid.UUID) (bool, error) {
	if re.All {
		return true, nil
	}
	id := httpx.IdentityFrom(r.Context())
	frag, args := re.employeeFilter("e", 2)
	var ok bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			    SELECT 1 FROM staff_exits x
			      JOIN employees e ON e.id = x.employee_id
			     WHERE x.id = $1 AND `+frag+`)`,
			append([]any{exitID}, args...)...).Scan(&ok)
	})
	return ok, err
}

/*
grievanceFilter is narrower than employeeFilter, and deliberately so.

	A grievance is the one register in this file whose subject is frequently
	the reader. Handing a head of department every complaint raised inside
	their department includes the complaints raised about them, and a
	grievance mechanism whose complaints reach the person complained of is
	not a mechanism — the staff work that out in one round and stop using it.

	So there is no departmental widening here. Outside the back office a
	caller sees the grievances they raised about themselves, and the ones they
	were assigned to handle, which is the same "you were named on it" rule
	appraisalFilter uses. An anonymous grievance carries no employee_id at all
	and so reaches neither.

	It lives here rather than beside growthReach because the rule is this
	register's, not the staff record's.
*/
func grievanceFilter(re *growthReach, alias string, next int) (string, []any) {
	if re.All {
		return "TRUE", nil
	}
	parts := []string{fmt.Sprintf("%s.assigned_to = $%d", alias, next)}
	args := []any{re.UserID}
	if re.OwnEmpID != nil {
		parts = append(parts, fmt.Sprintf("%s.employee_id = $%d", alias, next+1))
		args = append(args, *re.OwnEmpID)
	}
	return "(" + strings.Join(parts, " OR ") + ")", args
}

// --- onboarding -----------------------------------------------------------

type onboardingRow struct {
	ID           string  `json:"id,omitempty"`
	EmployeeID   string  `json:"employee_id"`
	EmployeeCode string  `json:"employee_code"`
	Name         string  `json:"full_name"`
	Designation  *string `json:"designation,omitempty"`
	JoinedOn     string  `json:"joined_on"`
	Status       string  `json:"status"`
	OfferOn      *string `json:"offer_on,omitempty"`
	ExpectedOn   *string `json:"expected_on,omitempty"`
	FormOn       *string `json:"form_submitted_on,omitempty"`
	AadhaarOn    *string `json:"aadhaar_verified_on,omitempty"`
	AadhaarRef   *string `json:"aadhaar_ref,omitempty"`
	PANOn        *string `json:"pan_verified_on,omitempty"`
	PANRef       *string `json:"pan_ref,omitempty"`
	BankOn       *string `json:"bank_verified_on,omitempty"`
	OriginalsOn  *string `json:"originals_seen_on,omitempty"`
	ContractOn   *string `json:"contract_signed_on,omitempty"`
	JoiningOn    *string `json:"joining_report_on,omitempty"`
	Notes        *string `json:"notes,omitempty"`
	// What is still missing, named. A percentage tells a clerk they are not
	// finished; a list tells them what to do next.
	Pending []string `json:"pending"`
}

/*
listOnboarding is the joining file for everyone who has one, and everyone who
should.

	Employees with no file at all are returned too, with a null id. A school
	that started using this in June has two hundred staff and no rows, and a
	screen that showed an empty table would read as "nothing to do" when the
	truth is "nobody has been verified".
*/
func (s *Server) listOnboarding(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{q.Get("pending") == "true"})
	items, err := collect(s, r, `
		SELECT o.id::text, e.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name),
		       d.name,
		       to_char(e.joined_on,'YYYY-MM-DD'),
		       COALESCE(o.status, 'invited'),
		       to_char(o.offer_on,'YYYY-MM-DD'),
		       to_char(o.expected_on,'YYYY-MM-DD'),
		       to_char(o.form_submitted_on,'YYYY-MM-DD'),
		       to_char(o.aadhaar_verified_on,'YYYY-MM-DD'), o.aadhaar_ref,
		       to_char(o.pan_verified_on,'YYYY-MM-DD'), o.pan_ref,
		       to_char(o.bank_verified_on,'YYYY-MM-DD'),
		       to_char(o.originals_seen_on,'YYYY-MM-DD'),
		       to_char(o.contract_signed_on,'YYYY-MM-DD'),
		       to_char(o.joining_report_on,'YYYY-MM-DD'),
		       o.notes,
		       array_remove(ARRAY[
		           CASE WHEN o.aadhaar_verified_on IS NULL THEN 'Aadhaar'   END,
		           CASE WHEN o.pan_verified_on     IS NULL THEN 'PAN'       END,
		           CASE WHEN o.bank_verified_on    IS NULL THEN 'bank'      END,
		           CASE WHEN o.originals_seen_on   IS NULL THEN 'originals' END,
		           CASE WHEN o.contract_signed_on  IS NULL THEN 'contract'  END
		       ], NULL)
		  FROM employees e
		  LEFT JOIN staff_onboarding o ON o.employee_id = e.id
		  LEFT JOIN designations d ON d.id = e.designation_id
		 WHERE ($1::bool IS NOT TRUE OR o.id IS NULL OR o.status <> 'completed')
		   AND `+mine+`
		 ORDER BY e.joined_on DESC, e.employee_code
		 LIMIT 500`,
		args,
		func(rows pgx.Rows) (onboardingRow, error) {
			var v onboardingRow
			var id *string
			err := rows.Scan(&id, &v.EmployeeID, &v.EmployeeCode, &v.Name, &v.Designation,
				&v.JoinedOn, &v.Status, &v.OfferOn, &v.ExpectedOn, &v.FormOn,
				&v.AadhaarOn, &v.AadhaarRef, &v.PANOn, &v.PANRef, &v.BankOn,
				&v.OriginalsOn, &v.ContractOn, &v.JoiningOn, &v.Notes, &v.Pending)
			if id != nil {
				v.ID = *id
			}
			return v, err
		})
	respond(w, r, items, err)
}

type onboardingRequest struct {
	EmployeeID  string `json:"employee_id"`
	Status      string `json:"status,omitempty"`
	OfferOn     string `json:"offer_on,omitempty"`
	ExpectedOn  string `json:"expected_on,omitempty"`
	FormOn      string `json:"form_submitted_on,omitempty"`
	AadhaarOn   string `json:"aadhaar_verified_on,omitempty"`
	AadhaarRef  string `json:"aadhaar_ref,omitempty"`
	PANOn       string `json:"pan_verified_on,omitempty"`
	PANRef      string `json:"pan_ref,omitempty"`
	BankOn      string `json:"bank_verified_on,omitempty"`
	OriginalsOn string `json:"originals_seen_on,omitempty"`
	ContractOn  string `json:"contract_signed_on,omitempty"`
	JoiningOn   string `json:"joining_report_on,omitempty"`
	Notes       string `json:"notes,omitempty"`
}

/*
saveOnboarding writes the joining file and, when it completes, opens the
service book.

	The appointment page is written here rather than left to a clerk because
	it is the one entry the whole book depends on and the one nobody
	remembers to make. It is attested by the person who completed the KYC,
	which is what makes it evidence rather than a note.
*/
func (s *Server) saveOnboarding(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req onboardingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	emp, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if req.Status == "" {
		req.Status = "submitted"
	}
	// The schema refuses this too. Saying it here first is the difference
	// between a sentence a clerk can act on and a constraint name.
	if req.Status == "verified" || req.Status == "completed" {
		if req.AadhaarOn == "" || req.PANOn == "" {
			httpx.BadRequest(w, r,
				"Aadhaar and PAN have to be verified, with the date each was checked, before onboarding is marked verified")
			return
		}
		if req.Status == "completed" && req.ContractOn == "" {
			httpx.BadRequest(w, r, "onboarding is not complete until the contract is signed; record the date")
			return
		}
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			INSERT INTO staff_onboarding (institution_id, employee_id, status, offer_on,
			    expected_on, form_submitted_on, aadhaar_verified_on, aadhaar_ref,
			    pan_verified_on, pan_ref, bank_verified_on, originals_seen_on,
			    contract_signed_on, joining_report_on, notes, verified_by)
			VALUES ($1,$2,$3,$4::date,$5::date,$6::date,$7::date,$8,$9::date,$10,
			        $11::date,$12::date,$13::date,$14::date,$15,$16)
			ON CONFLICT (employee_id) DO UPDATE SET
			    status = EXCLUDED.status,
			    offer_on = EXCLUDED.offer_on,
			    expected_on = EXCLUDED.expected_on,
			    form_submitted_on = EXCLUDED.form_submitted_on,
			    aadhaar_verified_on = EXCLUDED.aadhaar_verified_on,
			    aadhaar_ref = EXCLUDED.aadhaar_ref,
			    pan_verified_on = EXCLUDED.pan_verified_on,
			    pan_ref = EXCLUDED.pan_ref,
			    bank_verified_on = EXCLUDED.bank_verified_on,
			    originals_seen_on = EXCLUDED.originals_seen_on,
			    contract_signed_on = EXCLUDED.contract_signed_on,
			    joining_report_on = EXCLUDED.joining_report_on,
			    notes = EXCLUDED.notes,
			    verified_by = EXCLUDED.verified_by
			RETURNING id::text`,
			id.InstitutionID, emp, req.Status, nullDate(req.OfferOn),
			nullDate(req.ExpectedOn), nullDate(req.FormOn), nullDate(req.AadhaarOn),
			nullString(req.AadhaarRef), nullDate(req.PANOn), nullString(req.PANRef),
			nullDate(req.BankOn), nullDate(req.OriginalsOn), nullDate(req.ContractOn),
			nullDate(req.JoiningOn), nullString(req.Notes), id.UserID).Scan(&newID)
		if err != nil {
			return err
		}
		if req.Status != "completed" {
			return nil
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO service_book_entries (institution_id, employee_id, entry_kind,
			    event_date, title, particulars, designation_id, department_id,
			    attested_by, attested_on, source, created_by)
			SELECT $1, e.id, 'appointment', e.joined_on,
			       concat('Appointed as ', COALESCE(d.name, 'staff')),
			       'Onboarding completed and KYC verified',
			       e.designation_id, e.department_id, $2, CURRENT_DATE, 'onboarding', $2
			  FROM employees e
			  LEFT JOIN designations d ON d.id = e.designation_id
			 WHERE e.id = $3
			   AND NOT EXISTS (SELECT 1 FROM service_book_entries sb
			                    WHERE sb.employee_id = e.id AND sb.entry_kind = 'appointment')`,
			id.InstitutionID, id.UserID, emp)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID, "status": req.Status})
}

// --- exit, clearance and the letters that follow --------------------------

type exitRow struct {
	ID           string  `json:"id"`
	EmployeeID   string  `json:"employee_id"`
	EmployeeCode string  `json:"employee_code"`
	Name         string  `json:"full_name"`
	Designation  *string `json:"designation,omitempty"`
	JoinedOn     string  `json:"joined_on"`
	Kind         string  `json:"kind"`
	NoticeOn     string  `json:"notice_on"`
	RequestedOn  *string `json:"requested_last_day,omitempty"`
	LastWorking  *string `json:"last_working_day,omitempty"`
	Reason       *string `json:"reason,omitempty"`
	Status       string  `json:"status"`
	InterviewOn  *string `json:"interview_on,omitempty"`
	PrimaryCause *string `json:"primary_reason,omitempty"`
	WouldRejoin  *bool   `json:"would_rejoin,omitempty"`
	Feedback     *string `json:"feedback,omitempty"`
	SettleStatus string  `json:"settlement_status"`
	SettlePaise  int64   `json:"settlement_paise"`
	RelievedOn   *string `json:"relieved_on,omitempty"`
	SettledOn    *string `json:"settled_on,omitempty"`
	// The clearance position, which is what decides whether anything else may
	// happen. Outstanding is the count the settlement is blocked on.
	Departments  int   `json:"departments"`
	Outstanding  int   `json:"outstanding"`
	DuesPaise    int64 `json:"dues_paise"`
	CanBeSettled bool  `json:"can_be_settled"`
}

const exitClearanceProgress = `
	LEFT JOIN LATERAL (
	    SELECT count(*)::int AS raised,
	           count(*) FILTER (WHERE c.status <> 'cleared')::int AS outstanding,
	           COALESCE(sum(c.dues_paise), 0) AS dues
	      FROM exit_clearances c WHERE c.exit_id = x.id
	) cl ON true`

func (s *Server) listExits(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{q.Get("open") == "true"})
	items, err := collect(s, r, `
		SELECT x.id::text, e.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name), d.name,
		       to_char(e.joined_on,'YYYY-MM-DD'),
		       x.kind, to_char(x.notice_on,'YYYY-MM-DD'),
		       to_char(x.requested_last_day,'YYYY-MM-DD'),
		       to_char(x.last_working_day,'YYYY-MM-DD'),
		       x.reason, x.status,
		       to_char(x.interview_on,'YYYY-MM-DD'), x.primary_reason,
		       x.would_rejoin, x.feedback,
		       x.settlement_status, x.settlement_paise,
		       to_char(x.relieved_on,'YYYY-MM-DD'), to_char(x.settled_on,'YYYY-MM-DD'),
		       cl.raised, cl.outstanding, cl.dues,
		       cl.raised > 0 AND cl.outstanding = 0
		  FROM staff_exits x
		  JOIN employees e ON e.id = x.employee_id
		  LEFT JOIN designations d ON d.id = e.designation_id`+exitClearanceProgress+`
		 WHERE ($1::bool IS NOT TRUE OR x.status NOT IN ('settled','withdrawn'))
		   AND `+mine+`
		 ORDER BY x.notice_on DESC
		 LIMIT 300`,
		args,
		func(rows pgx.Rows) (exitRow, error) {
			var v exitRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.EmployeeCode, &v.Name,
				&v.Designation, &v.JoinedOn, &v.Kind, &v.NoticeOn, &v.RequestedOn,
				&v.LastWorking, &v.Reason, &v.Status, &v.InterviewOn, &v.PrimaryCause,
				&v.WouldRejoin, &v.Feedback, &v.SettleStatus, &v.SettlePaise,
				&v.RelievedOn, &v.SettledOn, &v.Departments, &v.Outstanding,
				&v.DuesPaise, &v.CanBeSettled)
		})
	respond(w, r, items, err)
}

type exitRequest struct {
	EmployeeID  string `json:"employee_id"`
	Kind        string `json:"kind,omitempty"`
	NoticeOn    string `json:"notice_on,omitempty"`
	RequestedOn string `json:"requested_last_day,omitempty"`
	LastWorking string `json:"last_working_day,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

/*
saveExit opens a resignation file and raises the clearance checklist with it.

	The checklist is raised here rather than when somebody remembers to ask
	for it. A clearance list that is created on demand is a list that is
	created after the settlement has already been paid, which is the failure
	the whole feature exists to prevent — and the database refuses to pay
	against an exit with no list at all, so raising it late would simply
	block the office instead.
*/
func (s *Server) saveExit(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req exitRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	emp, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if req.Kind == "" {
		req.Kind = "resignation"
	}

	var newID uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			INSERT INTO staff_exits (institution_id, employee_id, kind, notice_on,
			    requested_last_day, last_working_day, reason, created_by)
			VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5::date,$6::date,$7,$8)
			RETURNING id`,
			id.InstitutionID, emp, req.Kind, nullDate(req.NoticeOn),
			nullDate(req.RequestedOn), nullDate(req.LastWorking),
			nullString(req.Reason), id.UserID).Scan(&newID)
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO exit_clearances (institution_id, exit_id, department_id)
			SELECT $1, $2, cd.id FROM clearance_departments cd
			 WHERE cd.institution_id = $1 AND cd.is_active
			ON CONFLICT DO NOTHING`, id.InstitutionID, newID)
		return err
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "exit_already_open",
			"this employee already has an exit in progress; withdraw it before opening another")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID.String()})
}

type exitInterviewRequest struct {
	InterviewOn   string  `json:"interview_on,omitempty"`
	PrimaryReason string  `json:"primary_reason"`
	WouldRejoin   *bool   `json:"would_rejoin,omitempty"`
	Management    *int    `json:"rating_management,omitempty"`
	Workload      *int    `json:"rating_workload,omitempty"`
	Facilities    *int    `json:"rating_facilities,omitempty"`
	Feedback      string  `json:"feedback,omitempty"`
	LastWorking   *string `json:"last_working_day,omitempty"`
}

// recordExitInterview stores what the leaver said on the way out. The ratings
// are optional and the reason is not: a school that collects five stars and
// no sentence learns nothing it can act on.
func (s *Server) recordExitInterview(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	exitID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req exitInterviewRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.PrimaryReason) == "" {
		httpx.BadRequest(w, r, "an exit interview needs the main reason for leaving")
		return
	}

	var last string
	if req.LastWorking != nil {
		last = *req.LastWorking
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE staff_exits
			   SET interview_on = COALESCE($2::date, CURRENT_DATE),
			       interviewed_by = $3, primary_reason = $4, would_rejoin = $5,
			       rating_management = $6, rating_workload = $7, rating_facilities = $8,
			       feedback = $9,
			       last_working_day = COALESCE($10::date, last_working_day),
			       status = CASE WHEN status = 'notice' THEN 'interviewed' ELSE status END
			 WHERE id = $1`,
			exitID, nullDate(req.InterviewOn), id.UserID, req.PrimaryReason,
			req.WouldRejoin, req.Management, req.Workload, req.Facilities,
			nullString(req.Feedback), nullDate(last))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

type clearanceRow struct {
	ID         string  `json:"id"`
	Department string  `json:"department"`
	Code       string  `json:"code"`
	Status     string  `json:"status"`
	DuesPaise  int64   `json:"dues_paise"`
	Remarks    *string `json:"remarks,omitempty"`
	ClearedBy  *string `json:"cleared_by,omitempty"`
	ClearedOn  *string `json:"cleared_on,omitempty"`
}

func (s *Server) listExitClearances(w http.ResponseWriter, r *http.Request) {
	exitID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	switch reachable, err := s.exitInReach(r, re, exitID); {
	case err != nil:
		httpx.Internal(w, r, err)
		return
	case !reachable:
		httpx.NotFound(w, r)
		return
	}
	items, err := collect(s, r, `
		SELECT c.id::text, cd.name, cd.code, c.status, c.dues_paise, c.remarks,
		       u.full_name, to_char(c.cleared_on,'YYYY-MM-DD')
		  FROM exit_clearances c
		  JOIN clearance_departments cd ON cd.id = c.department_id
		  LEFT JOIN users u ON u.id = c.cleared_by
		 WHERE c.exit_id = $1
		 ORDER BY cd.sequence, cd.name`,
		[]any{exitID},
		func(rows pgx.Rows) (clearanceRow, error) {
			var v clearanceRow
			return v, rows.Scan(&v.ID, &v.Department, &v.Code, &v.Status,
				&v.DuesPaise, &v.Remarks, &v.ClearedBy, &v.ClearedOn)
		})
	respond(w, r, items, err)
}

type clearanceRequest struct {
	DepartmentCode string `json:"department_code"`
	Status         string `json:"status"`
	DuesPaise      int64  `json:"dues_paise,omitempty"`
	Remarks        string `json:"remarks,omitempty"`
}

// signExitClearance records one department's answer. Dues are stated here and
// deducted at settlement; a department that clears somebody and mentions the
// three missing library books afterwards has cleared them.
func (s *Server) signExitClearance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	exitID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req clearanceRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Status != "pending" && req.Status != "dues" && req.Status != "cleared" {
		httpx.BadRequest(w, r, "status must be pending, dues or cleared")
		return
	}

	var outstanding int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE exit_clearances c
			   SET status = $3, dues_paise = $4, remarks = $5,
			       cleared_by = CASE WHEN $3 = 'cleared' THEN $6::uuid ELSE NULL END,
			       cleared_on = CASE WHEN $3 = 'cleared' THEN CURRENT_DATE ELSE NULL END
			  FROM clearance_departments cd
			 WHERE cd.id = c.department_id AND c.exit_id = $1 AND cd.code = $2`,
			exitID, req.DepartmentCode, req.Status, req.DuesPaise,
			nullString(req.Remarks), id.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		if err := tx.QueryRow(r.Context(),
			`SELECT count(*)::int FROM exit_clearances
			  WHERE exit_id = $1 AND status <> 'cleared'`, exitID).Scan(&outstanding); err != nil {
			return err
		}
		// The exit reaches "cleared" on its own the moment the last department
		// signs. Waiting for somebody to press a button is how an exit sits
		// blocked with every box already ticked.
		_, err = tx.Exec(r.Context(), `
			UPDATE staff_exits
			   SET status = CASE WHEN $2 = 0 AND status IN ('notice','interviewed') THEN 'cleared'
			                     WHEN $2 > 0 AND status = 'cleared' THEN 'interviewed'
			                     ELSE status END
			 WHERE id = $1`, exitID, outstanding)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"outstanding": outstanding})
}

func (s *Server) listClearanceDepartments(w http.ResponseWriter, r *http.Request) {
	type dept struct {
		ID     string `json:"id"`
		Code   string `json:"code"`
		Name   string `json:"name"`
		Active bool   `json:"is_active"`
	}
	items, err := collect(s, r, `
		SELECT id::text, code, name, is_active FROM clearance_departments
		 ORDER BY sequence, name`, nil,
		func(rows pgx.Rows) (dept, error) {
			var v dept
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Active)
		})
	respond(w, r, items, err)
}

type relieveRequest struct {
	RelievedOn string `json:"relieved_on,omitempty"`
	Remarks    string `json:"remarks,omitempty"`
}

var errClearanceOutstanding = errors.New("clearance outstanding")

/*
relieveStaff issues the letters a teacher needs for their next job.

	The relieving letter and the experience certificate are generated together
	and from one snapshot, because they are read together by the next school
	and a pair that disagree on a date is worse than neither. The snapshot is
	taken now for the same reason a transfer certificate is: rendering it live
	would let a letter issued in 2026 change its own contents in 2031.

	Clearance is checked before any of that. Relieving somebody the library has
	not signed for is how the books leave with them.
*/
func (s *Server) relieveStaff(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	exitID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req relieveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	issued := map[string]string{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var emp uuid.UUID
		var kind string
		var raised, outstanding int
		err := tx.QueryRow(r.Context(), `
			SELECT x.employee_id, x.kind,
			       (SELECT count(*)::int FROM exit_clearances c WHERE c.exit_id = x.id),
			       (SELECT count(*)::int FROM exit_clearances c
			         WHERE c.exit_id = x.id AND c.status <> 'cleared')
			  FROM staff_exits x WHERE x.id = $1`, exitID).
			Scan(&emp, &kind, &raised, &outstanding)
		if err != nil {
			return err
		}
		if raised == 0 || outstanding > 0 {
			return errClearanceOutstanding
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE staff_exits
			   SET relieved_on = COALESCE($2::date, CURRENT_DATE), status = 'relieved',
			       last_working_day = COALESCE(last_working_day, $2::date, CURRENT_DATE)
			 WHERE id = $1`, exitID, nullDate(req.RelievedOn)); err != nil {
			return err
		}

		// The employment status follows the kind of exit. Leaving it 'active'
		// keeps the leaver in every headcount, every payroll run and every
		// timetable the school publishes afterwards.
		if _, err := tx.Exec(r.Context(), `
			UPDATE employees
			   SET status = CASE $2
			                  WHEN 'retirement'   THEN 'retired'
			                  WHEN 'termination'  THEN 'terminated'
			                  ELSE 'resigned' END,
			       relieved_on = COALESCE($3::date, CURRENT_DATE)
			 WHERE id = $1`, emp, kind, nullDate(req.RelievedOn)); err != nil {
			return err
		}

		for _, code := range []string{"RELIEVING", "EXPERIENCE"} {
			serial, err := s.issueStaffCertificate(r, tx, id.InstitutionID, id.UserID, emp, code,
				nullString(req.Remarks))
			if err != nil {
				return err
			}
			issued[strings.ToLower(code)] = serial
		}

		_, err = tx.Exec(r.Context(), `
			INSERT INTO service_book_entries (institution_id, employee_id, entry_kind,
			    event_date, title, particulars, attested_by, attested_on, source, created_by)
			SELECT $1, $2, 'relieving', COALESCE($3::date, CURRENT_DATE),
			       'Relieved on completion of clearance',
			       concat('All departmental clearances signed. ', COALESCE($4, '')),
			       $5, CURRENT_DATE, 'exit', $5`,
			id.InstitutionID, emp, nullDate(req.RelievedOn), nullString(req.Remarks), id.UserID)
		return err
	})
	if errors.Is(err, errClearanceOutstanding) {
		httpx.Error(w, r, http.StatusConflict, "clearance_outstanding",
			"a department has not signed yet; the relieving letter cannot be issued until every one has")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"relieved": true, "certificates": issued})
}

type settleRequest struct {
	SettlementPaise int64 `json:"settlement_paise"`
}

/*
settleExit pays the final settlement, net of what the clearances found.

	Nothing here decides whether the payment is allowed: 00031's trigger does,
	and it refuses an exit with an outstanding department or with no clearance
	list at all. The check lives in the database because a settlement is money
	leaving the school and a rule enforced only in this handler would be
	silent for every other way a row can be updated.
*/
func (s *Server) settleExit(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	exitID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req settleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.SettlementPaise < 0 {
		httpx.BadRequest(w, r, "a settlement cannot be negative")
		return
	}

	var recovery, net int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`SELECT COALESCE(sum(dues_paise), 0) FROM exit_clearances WHERE exit_id = $1`,
			exitID).Scan(&recovery); err != nil {
			return err
		}
		net = req.SettlementPaise - recovery
		if net < 0 {
			net = 0
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE staff_exits
			   SET settlement_paise = $2, recovery_paise = $3,
			       settlement_status = 'paid', settled_on = CURRENT_DATE,
			       relieved_on = COALESCE(relieved_on, CURRENT_DATE),
			       status = 'settled'
			 WHERE id = $1`, exitID, req.SettlementPaise, recovery)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		// The trigger's message names how many departments are still waiting,
		// which is the only thing the clerk needs to know.
		if strings.Contains(err.Error(), "settlement blocked") {
			httpx.Error(w, r, http.StatusConflict, "clearance_outstanding", err.Error())
			return
		}
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"settlement_paise": req.SettlementPaise,
		"recovery_paise":   recovery,
		"net_paise":        net,
	})
}

/*
issueStaffCertificate writes one relieving, experience or service certificate.

	It reuses issued_certificates rather than adding a staff-only table: the
	serial series, the approval status and the snapshot are already modelled
	there for students, and a second numbering series would be a second place
	for a serial to be reissued.
*/
func (s *Server) issueStaffCertificate(r *http.Request, tx pgx.Tx, inst, actor, emp uuid.UUID,
	code string, remarks *string) (string, error) {
	var typeID uuid.UUID
	err := tx.QueryRow(r.Context(),
		`SELECT id FROM certificate_types WHERE code = $1`, code).Scan(&typeID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Created on first use so a school is not blocked by a setup screen it
		// has never been shown.
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO certificate_types (institution_id, code, name, requires_approval)
			VALUES ($1,$2,$3,false) RETURNING id`,
			inst, code, staffCertificateName(code)).Scan(&typeID); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}

	serial, err := fees.NextNumber(r.Context(), tx, inst, "certificate")
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(r.Context(), `
		INSERT INTO issued_certificates (institution_id, certificate_type_id, employee_id,
		                                 serial_no, issued_on, snapshot, status, requested_by)
		SELECT $1, $2, e.id, $3, CURRENT_DATE,
		       jsonb_build_object(
		         'name', concat_ws(' ', e.first_name, e.last_name),
		         'employee_code', e.employee_code,
		         'designation', d.name,
		         'department', dep.name,
		         'joined_on', e.joined_on,
		         'relieved_on', COALESCE(e.relieved_on, CURRENT_DATE),
		         -- Whole years served, which is the figure the next school
		         -- reads. A fraction of a year invites an argument nobody wins.
		         'years_of_service',
		             EXTRACT(year FROM age(COALESCE(e.relieved_on, CURRENT_DATE), e.joined_on))::int,
		         'qualifications', COALESCE((
		             SELECT jsonb_agg(q.qualification ORDER BY q.year_of_passing)
		               FROM staff_qualifications q WHERE q.employee_id = e.id), '[]'::jsonb),
		         'conduct', 'satisfactory',
		         'remarks', $4::text,
		         'issued_at', now()
		       ),
		       'issued', $5
		  FROM employees e
		  LEFT JOIN designations d ON d.id = e.designation_id
		  LEFT JOIN departments dep ON dep.id = e.department_id
		 WHERE e.id = $6`,
		inst, typeID, serial, remarks, actor, emp)
	return serial, err
}

func staffCertificateName(code string) string {
	switch code {
	case "RELIEVING":
		return "Relieving Letter"
	case "EXPERIENCE":
		return "Experience Certificate"
	default:
		// The letters a school issues over a career rather than at the end of
		// one — appointment, salary revision, warning, service — are named in
		// staff_letters.go, so the two lists cannot drift apart.
		if name, ok := staffLetterKinds[code]; ok {
			return name
		}
		return code
	}
}

type staffCertificateRow struct {
	Serial   string  `json:"serial_no"`
	Type     string  `json:"type"`
	Code     string  `json:"code"`
	Name     string  `json:"full_name"`
	IssuedOn string  `json:"issued_on"`
	Status   string  `json:"status"`
	Snapshot any     `json:"snapshot"`
	Remarks  *string `json:"remarks,omitempty"`
}

func (s *Server) listServiceCertificates(w http.ResponseWriter, r *http.Request) {
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{nullID(r.URL.Query().Get("employee_id"))})
	items, err := collect(s, r, `
		SELECT ic.serial_no, ct.name, ct.code,
		       concat_ws(' ', e.first_name, e.last_name),
		       to_char(ic.issued_on,'YYYY-MM-DD'), ic.status, ic.snapshot,
		       ic.snapshot->>'remarks'
		  FROM issued_certificates ic
		  JOIN certificate_types ct ON ct.id = ic.certificate_type_id
		  JOIN employees e ON e.id = ic.employee_id
		 WHERE ($1::uuid IS NULL OR ic.employee_id = $1::uuid)
		   AND `+mine+`
		 ORDER BY ic.issued_on DESC, ic.serial_no DESC
		 LIMIT 300`,
		args,
		func(rows pgx.Rows) (staffCertificateRow, error) {
			var v staffCertificateRow
			return v, rows.Scan(&v.Serial, &v.Type, &v.Code, &v.Name, &v.IssuedOn,
				&v.Status, &v.Snapshot, &v.Remarks)
		})
	respond(w, r, items, err)
}

// --- transfer, deputation and seniority -----------------------------------

type transferRow struct {
	ID           string  `json:"id"`
	EmployeeID   string  `json:"employee_id"`
	EmployeeCode string  `json:"employee_code"`
	Name         string  `json:"full_name"`
	Kind         string  `json:"kind"`
	FromCampus   *string `json:"from_campus,omitempty"`
	ToCampus     *string `json:"to_campus,omitempty"`
	ToSchool     *string `json:"to_institution,omitempty"`
	OrderNo      *string `json:"order_no,omitempty"`
	OrderDate    *string `json:"order_date,omitempty"`
	EffectiveFr  string  `json:"effective_from"`
	EffectiveTo  *string `json:"effective_to,omitempty"`
	RelievedOn   *string `json:"relieved_on,omitempty"`
	ReportedOn   *string `json:"reported_on,omitempty"`
	Reason       *string `json:"reason,omitempty"`
	Status       string  `json:"status"`
	// A deputation whose end date has passed and who has not been repatriated.
	// The one row a district office is asked about.
	Overdue bool `json:"overdue"`
}

func (s *Server) listTransfers(w http.ResponseWriter, r *http.Request) {
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{nowInIndia().Format("2006-01-02"),
		nullID(r.URL.Query().Get("employee_id"))})
	items, err := collect(s, r, `
		SELECT t.id::text, e.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name), t.kind,
		       fc.name, tc.name, t.to_institution, t.order_no,
		       to_char(t.order_date,'YYYY-MM-DD'),
		       to_char(t.effective_from,'YYYY-MM-DD'),
		       to_char(t.effective_to,'YYYY-MM-DD'),
		       to_char(t.relieved_on,'YYYY-MM-DD'),
		       to_char(t.reported_on,'YYYY-MM-DD'),
		       t.reason, t.status,
		       t.kind = 'deputation' AND t.effective_to < $1::date
		           AND t.status NOT IN ('returned','cancelled')
		  FROM staff_transfers t
		  JOIN employees e ON e.id = t.employee_id
		  LEFT JOIN campuses fc ON fc.id = t.from_campus_id
		  LEFT JOIN campuses tc ON tc.id = t.to_campus_id
		 WHERE ($2::uuid IS NULL OR t.employee_id = $2::uuid)
		   AND `+mine+`
		 ORDER BY t.effective_from DESC
		 LIMIT 300`,
		args,
		func(rows pgx.Rows) (transferRow, error) {
			var v transferRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.EmployeeCode, &v.Name, &v.Kind,
				&v.FromCampus, &v.ToCampus, &v.ToSchool, &v.OrderNo, &v.OrderDate,
				&v.EffectiveFr, &v.EffectiveTo, &v.RelievedOn, &v.ReportedOn,
				&v.Reason, &v.Status, &v.Overdue)
		})
	respond(w, r, items, err)
}

type transferRequest struct {
	EmployeeID    string `json:"employee_id"`
	Kind          string `json:"kind,omitempty"`
	ToCampusID    string `json:"to_campus_id,omitempty"`
	ToInstitution string `json:"to_institution,omitempty"`
	OrderNo       string `json:"order_no,omitempty"`
	OrderDate     string `json:"order_date,omitempty"`
	EffectiveFrom string `json:"effective_from"`
	EffectiveTo   string `json:"effective_to,omitempty"`
	RelievedOn    string `json:"relieved_on,omitempty"`
	ReportedOn    string `json:"reported_on,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Status        string `json:"status,omitempty"`
}

/*
saveTransfer records a posting order and writes the matching service book page.

	The order and the page are one transaction because a transfer that appears
	in the transfer list and not in the service book is the discrepancy a
	pension office finds thirty years later, when the people who could explain
	it have all retired.
*/
func (s *Server) saveTransfer(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req transferRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	emp, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if req.EffectiveFrom == "" {
		httpx.BadRequest(w, r, "a posting order needs the date it takes effect")
		return
	}
	if req.Kind == "" {
		req.Kind = "transfer"
	}
	if req.Kind == "deputation" && req.EffectiveTo == "" {
		httpx.BadRequest(w, r, "a deputation needs an end date; without one it is a transfer")
		return
	}
	if req.Status == "" {
		req.Status = "ordered"
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			INSERT INTO staff_transfers (institution_id, employee_id, kind,
			    from_campus_id, to_campus_id, to_institution, order_no, order_date,
			    effective_from, effective_to, relieved_on, reported_on, reason,
			    status, created_by)
			SELECT $1, e.id, $2, e.campus_id, $3::uuid, $4, $5, $6::date,
			       $7::date, $8::date, $9::date, $10::date, $11, $12, $13
			  FROM employees e WHERE e.id = $14
			RETURNING id::text`,
			id.InstitutionID, req.Kind, nullID(req.ToCampusID),
			nullString(req.ToInstitution), nullString(req.OrderNo),
			nullDate(req.OrderDate), req.EffectiveFrom, nullDate(req.EffectiveTo),
			nullDate(req.RelievedOn), nullDate(req.ReportedOn), nullString(req.Reason),
			req.Status, id.UserID, emp).Scan(&newID)
		if err != nil {
			return err
		}
		// A promotion moves the designation as well as the person, and the
		// service book is where the state reads it from.
		entryKind := req.Kind
		if entryKind != "deputation" && entryKind != "promotion" {
			entryKind = "transfer"
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO service_book_entries (institution_id, employee_id, entry_kind,
			    event_date, title, particulars, order_no, order_date, source, created_by)
			VALUES ($1, $2, $3, $4::date,
			        concat(initcap($3), ' order'),
			        concat_ws(' ', 'To', COALESCE($5, (SELECT name FROM campuses WHERE id = $6::uuid), 'unspecified'),
			                  CASE WHEN $7::date IS NOT NULL THEN concat('until ', $7::date) END),
			        $8, $9::date, 'transfer', $10)`,
			id.InstitutionID, emp, entryKind, req.EffectiveFrom,
			nullString(req.ToInstitution), nullID(req.ToCampusID),
			nullDate(req.EffectiveTo), nullString(req.OrderNo),
			nullDate(req.OrderDate), id.UserID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

type seniorityRow struct {
	Rank         int     `json:"rank"`
	EmployeeID   string  `json:"employee_id"`
	EmployeeCode string  `json:"employee_code"`
	Name         string  `json:"full_name"`
	Designation  *string `json:"designation,omitempty"`
	Department   *string `json:"department,omitempty"`
	JoinedOn     string  `json:"joined_on"`
	ConfirmedOn  *string `json:"confirmed_on,omitempty"`
	Years        float64 `json:"years_of_service"`
	// Days spent on deputation elsewhere. Some states count them towards
	// seniority and some do not, so the number is shown rather than applied.
	DeputedDays int `json:"deputed_days"`
}

/*
listSeniority is the list state transfer counselling is run from.

	Ordered by the date of confirmation where there is one and the date of
	joining otherwise, which is the rule every state service manual states and
	no product implements — most sort by joining alone, which quietly promotes
	anybody whose probation was extended.
*/
func (s *Server) listSeniority(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT row_number() OVER (
		           ORDER BY COALESCE(e.confirmed_on, e.joined_on), e.joined_on, e.employee_code
		       )::int,
		       e.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name), d.name, dep.name,
		       to_char(e.joined_on,'YYYY-MM-DD'),
		       to_char(e.confirmed_on,'YYYY-MM-DD'),
		       round(EXTRACT(epoch FROM age($1::date, e.joined_on)) / 31557600.0, 1)::float8,
		       COALESCE((
		           SELECT sum(LEAST(COALESCE(t.effective_to, $1::date), $1::date)
		                      - t.effective_from)::int
		             FROM staff_transfers t
		            WHERE t.employee_id = e.id AND t.kind = 'deputation'
		              AND t.status <> 'cancelled'), 0)
		  FROM employees e
		  LEFT JOIN designations d ON d.id = e.designation_id
		  LEFT JOIN departments dep ON dep.id = e.department_id
		 WHERE e.status IN ('active','on_leave')
		   AND ($2::uuid IS NULL OR e.department_id = $2::uuid)
		 ORDER BY COALESCE(e.confirmed_on, e.joined_on), e.joined_on, e.employee_code
		 LIMIT 500`,
		[]any{nowInIndia().Format("2006-01-02"), nullID(r.URL.Query().Get("department_id"))},
		func(rows pgx.Rows) (seniorityRow, error) {
			var v seniorityRow
			return v, rows.Scan(&v.Rank, &v.EmployeeID, &v.EmployeeCode, &v.Name,
				&v.Designation, &v.Department, &v.JoinedOn, &v.ConfirmedOn,
				&v.Years, &v.DeputedDays)
		})
	respond(w, r, items, err)
}

// --- the service book -----------------------------------------------------

type serviceBookRow struct {
	ID          string  `json:"id"`
	EmployeeID  string  `json:"employee_id"`
	Name        string  `json:"full_name"`
	Kind        string  `json:"entry_kind"`
	EventDate   string  `json:"event_date"`
	Title       string  `json:"title"`
	Particulars *string `json:"particulars,omitempty"`
	OrderNo     *string `json:"order_no,omitempty"`
	OrderDate   *string `json:"order_date,omitempty"`
	Designation *string `json:"designation,omitempty"`
	PayPaise    *int64  `json:"pay_paise,omitempty"`
	AttestedBy  *string `json:"attested_by,omitempty"`
	AttestedOn  *string `json:"attested_on,omitempty"`
	Source      string  `json:"source"`
}

func (s *Server) listServiceBook(w http.ResponseWriter, r *http.Request) {
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{nullID(r.URL.Query().Get("employee_id"))})
	items, err := collect(s, r, `
		SELECT sb.id::text, e.id::text, concat_ws(' ', e.first_name, e.last_name),
		       sb.entry_kind, to_char(sb.event_date,'YYYY-MM-DD'), sb.title,
		       sb.particulars, sb.order_no, to_char(sb.order_date,'YYYY-MM-DD'),
		       d.name, sb.pay_paise, u.full_name,
		       to_char(sb.attested_on,'YYYY-MM-DD'), sb.source
		  FROM service_book_entries sb
		  JOIN employees e ON e.id = sb.employee_id
		  LEFT JOIN designations d ON d.id = sb.designation_id
		  LEFT JOIN users u ON u.id = sb.attested_by
		 WHERE ($1::uuid IS NULL OR sb.employee_id = $1::uuid)
		   AND `+mine+`
		 -- The book reads forwards: a service record is a chronology, not a feed.
		 ORDER BY sb.event_date, sb.created_at
		 LIMIT 500`,
		args,
		func(rows pgx.Rows) (serviceBookRow, error) {
			var v serviceBookRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.Name, &v.Kind, &v.EventDate,
				&v.Title, &v.Particulars, &v.OrderNo, &v.OrderDate, &v.Designation,
				&v.PayPaise, &v.AttestedBy, &v.AttestedOn, &v.Source)
		})
	respond(w, r, items, err)
}

type serviceBookRequest struct {
	EmployeeID    string `json:"employee_id"`
	Kind          string `json:"entry_kind"`
	EventDate     string `json:"event_date"`
	Title         string `json:"title"`
	Particulars   string `json:"particulars,omitempty"`
	OrderNo       string `json:"order_no,omitempty"`
	OrderDate     string `json:"order_date,omitempty"`
	DesignationID string `json:"designation_id,omitempty"`
	DepartmentID  string `json:"department_id,omitempty"`
	PayPaise      *int64 `json:"pay_paise,omitempty"`
	Attest        bool   `json:"attest,omitempty"`
}

func (s *Server) addServiceBookEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req serviceBookRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	emp, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Title) == "" || req.EventDate == "" {
		httpx.BadRequest(w, r, "a service book entry needs a date and a title")
		return
	}
	if req.Kind == "" {
		req.Kind = "other"
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO service_book_entries (institution_id, employee_id, entry_kind,
			    event_date, title, particulars, order_no, order_date, designation_id,
			    department_id, pay_paise, attested_by, attested_on, source, created_by)
			VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8::date,$9::uuid,$10::uuid,$11,
			        CASE WHEN $12 THEN $13::uuid END,
			        CASE WHEN $12 THEN CURRENT_DATE END,
			        'manual', $13)
			RETURNING id::text`,
			id.InstitutionID, emp, req.Kind, req.EventDate, req.Title,
			nullString(req.Particulars), nullString(req.OrderNo), nullDate(req.OrderDate),
			nullID(req.DesignationID), nullID(req.DepartmentID), req.PayPaise,
			req.Attest, id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// attestServiceBookEntry signs a page off. After this the row cannot be
// changed at all — 00031 refuses the update — so the confirmation is the point
// of no return and is a separate call for that reason.
func (s *Server) attestServiceBookEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE service_book_entries
			   SET attested_by = $2, attested_on = CURRENT_DATE
			 WHERE id = $1 AND attested_on IS NULL`, entry, id.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "already_attested",
			"that entry is either missing or already attested; an attested page cannot be signed twice")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"attested": true})
}

// --- qualifications, fitness and background checks ------------------------

type qualificationRow struct {
	ID            string   `json:"id"`
	EmployeeID    string   `json:"employee_id"`
	EmployeeCode  string   `json:"employee_code"`
	Name          string   `json:"full_name"`
	Qualification string   `json:"qualification"`
	Level         string   `json:"level"`
	Discipline    *string  `json:"discipline,omitempty"`
	Board         *string  `json:"board_university,omitempty"`
	Year          *int     `json:"year_of_passing,omitempty"`
	Percentage    *float64 `json:"percentage,omitempty"`
	Registration  *string  `json:"registration_no,omitempty"`
	IsTeaching    bool     `json:"is_teaching_qualification"`
	ValidUntil    *string  `json:"valid_until,omitempty"`
	VerifiedOn    *string  `json:"verified_on,omitempty"`
	VerifiedBy    *string  `json:"verified_by,omitempty"`
	// Lapsed is computed rather than stored: a stored flag is a flag somebody
	// has to remember to flip on the morning it becomes true.
	Lapsed bool `json:"lapsed"`
}

func (s *Server) listQualifications(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{nowInIndia().Format("2006-01-02"),
		nullID(q.Get("employee_id")), q.Get("teaching") == "true"})
	items, err := collect(s, r, `
		SELECT q.id::text, e.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name),
		       q.qualification, q.level, q.discipline, q.board_university,
		       q.year_of_passing, q.percentage::float8, q.registration_no,
		       q.is_teaching_qualification, to_char(q.valid_until,'YYYY-MM-DD'),
		       to_char(q.verified_on,'YYYY-MM-DD'), u.full_name,
		       q.valid_until IS NOT NULL AND q.valid_until < $1::date
		  FROM staff_qualifications q
		  JOIN employees e ON e.id = q.employee_id
		  LEFT JOIN users u ON u.id = q.verified_by
		 WHERE ($2::uuid IS NULL OR q.employee_id = $2::uuid)
		   AND ($3::bool IS NOT TRUE OR q.is_teaching_qualification)
		   AND `+mine+`
		 ORDER BY e.employee_code, q.year_of_passing DESC NULLS LAST
		 LIMIT 500`,
		args,
		func(rows pgx.Rows) (qualificationRow, error) {
			var v qualificationRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.EmployeeCode, &v.Name,
				&v.Qualification, &v.Level, &v.Discipline, &v.Board, &v.Year,
				&v.Percentage, &v.Registration, &v.IsTeaching, &v.ValidUntil,
				&v.VerifiedOn, &v.VerifiedBy, &v.Lapsed)
		})
	respond(w, r, items, err)
}

type qualificationRequest struct {
	EmployeeID      string   `json:"employee_id"`
	Qualification   string   `json:"qualification"`
	Level           string   `json:"level,omitempty"`
	Discipline      string   `json:"discipline,omitempty"`
	Board           string   `json:"board_university,omitempty"`
	Year            *int     `json:"year_of_passing,omitempty"`
	Percentage      *float64 `json:"percentage,omitempty"`
	Registration    string   `json:"registration_no,omitempty"`
	IsTeaching      bool     `json:"is_teaching_qualification,omitempty"`
	ValidUntil      string   `json:"valid_until,omitempty"`
	Verified        bool     `json:"verified,omitempty"`
	VerificationRef string   `json:"verification_ref,omitempty"`
}

func (s *Server) saveQualification(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req qualificationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	emp, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Qualification) == "" {
		httpx.BadRequest(w, r, "name the qualification")
		return
	}
	if req.Level == "" {
		req.Level = "graduate"
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO staff_qualifications (institution_id, employee_id, qualification,
			    level, discipline, board_university, year_of_passing, percentage,
			    registration_no, is_teaching_qualification, valid_until,
			    verified_on, verified_by, verification_ref)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,
			        CASE WHEN $12 THEN CURRENT_DATE END,
			        CASE WHEN $12 THEN $13::uuid END, $14)
			ON CONFLICT (employee_id, lower(qualification),
			             lower(COALESCE(discipline, '')), COALESCE(year_of_passing, 0))
			DO UPDATE SET level = EXCLUDED.level,
			              board_university = EXCLUDED.board_university,
			              percentage = EXCLUDED.percentage,
			              registration_no = EXCLUDED.registration_no,
			              is_teaching_qualification = EXCLUDED.is_teaching_qualification,
			              valid_until = EXCLUDED.valid_until,
			              verified_on = COALESCE(EXCLUDED.verified_on, staff_qualifications.verified_on),
			              verified_by = COALESCE(EXCLUDED.verified_by, staff_qualifications.verified_by),
			              verification_ref = COALESCE(EXCLUDED.verification_ref, staff_qualifications.verification_ref)
			RETURNING id::text`,
			id.InstitutionID, emp, req.Qualification, req.Level,
			nullString(req.Discipline), nullString(req.Board), req.Year,
			req.Percentage, nullString(req.Registration), req.IsTeaching,
			nullDate(req.ValidUntil), req.Verified, id.UserID,
			nullString(req.VerificationRef)).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID})
}

type medicalRow struct {
	ID           string  `json:"id"`
	EmployeeID   string  `json:"employee_id"`
	EmployeeCode string  `json:"employee_code"`
	Name         string  `json:"full_name"`
	Purpose      string  `json:"purpose"`
	IssuedOn     string  `json:"issued_on"`
	ValidUntil   string  `json:"valid_until"`
	Fit          bool    `json:"fit"`
	ExaminedBy   *string `json:"examined_by,omitempty"`
	Clinic       *string `json:"clinic,omitempty"`
	Restrictions *string `json:"restrictions,omitempty"`
	DaysLeft     int     `json:"days_left"`
	Expired      bool    `json:"expired"`
}

/*
listMedicalFitness is the registry, newest certificate per person first.

	Expired rows are returned rather than filtered out. A registry that shows
	only the valid certificates answers "who is covered" and hides "who is
	not", which is the question an inspection actually asks.
*/
func (s *Server) listMedicalFitness(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{nowInIndia().Format("2006-01-02"),
		nullID(q.Get("employee_id")), nullInt(q.Get("within_days"))})
	items, err := collect(s, r, `
		SELECT m.id::text, e.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name),
		       m.purpose, to_char(m.issued_on,'YYYY-MM-DD'),
		       to_char(m.valid_until,'YYYY-MM-DD'), m.fit,
		       m.examined_by, m.clinic, m.restrictions,
		       (m.valid_until - $1::date)::int,
		       m.valid_until < $1::date
		  FROM medical_fitness_certificates m
		  JOIN employees e ON e.id = m.employee_id
		 WHERE ($2::uuid IS NULL OR m.employee_id = $2::uuid)
		   AND ($3::int IS NULL OR m.valid_until <= $1::date + $3::int)
		   AND `+mine+`
		 ORDER BY m.valid_until, e.employee_code
		 LIMIT 500`,
		args,
		func(rows pgx.Rows) (medicalRow, error) {
			var v medicalRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.EmployeeCode, &v.Name,
				&v.Purpose, &v.IssuedOn, &v.ValidUntil, &v.Fit, &v.ExaminedBy,
				&v.Clinic, &v.Restrictions, &v.DaysLeft, &v.Expired)
		})
	respond(w, r, items, err)
}

type medicalRequest struct {
	EmployeeID   string `json:"employee_id"`
	Purpose      string `json:"purpose,omitempty"`
	IssuedOn     string `json:"issued_on"`
	ValidUntil   string `json:"valid_until"`
	Fit          *bool  `json:"fit,omitempty"`
	ExaminedBy   string `json:"examined_by,omitempty"`
	Clinic       string `json:"clinic,omitempty"`
	Restrictions string `json:"restrictions,omitempty"`
}

func (s *Server) recordMedicalFitness(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req medicalRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	emp, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if req.IssuedOn == "" || req.ValidUntil == "" {
		// Refused here as well as in the schema so the clerk gets a sentence
		// rather than a constraint name.
		httpx.BadRequest(w, r, "a fitness certificate needs the date it was issued and the date it runs out")
		return
	}
	if req.Purpose == "" {
		req.Purpose = "general"
	}
	fit := true
	if req.Fit != nil {
		fit = *req.Fit
	}
	if !fit && strings.TrimSpace(req.Restrictions) == "" {
		httpx.BadRequest(w, r,
			"say what the person is not fit for; an unfit certificate with nothing written on it cannot be acted on")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO medical_fitness_certificates (institution_id, employee_id,
			    purpose, issued_on, valid_until, fit, examined_by, clinic,
			    restrictions, recorded_by)
			VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10)
			ON CONFLICT (employee_id, purpose, issued_on) DO UPDATE SET
			    valid_until = EXCLUDED.valid_until, fit = EXCLUDED.fit,
			    examined_by = EXCLUDED.examined_by, clinic = EXCLUDED.clinic,
			    restrictions = EXCLUDED.restrictions
			RETURNING id::text`,
			id.InstitutionID, emp, req.Purpose, req.IssuedOn, req.ValidUntil, fit,
			nullString(req.ExaminedBy), nullString(req.Clinic),
			nullString(req.Restrictions), id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

type backgroundRow struct {
	ID           string  `json:"id"`
	EmployeeID   string  `json:"employee_id"`
	EmployeeCode string  `json:"employee_code"`
	Name         string  `json:"full_name"`
	Kind         string  `json:"kind"`
	Agency       *string `json:"agency,omitempty"`
	RequestedOn  string  `json:"requested_on"`
	ReferenceNo  *string `json:"reference_no,omitempty"`
	Status       string  `json:"status"`
	CompletedOn  *string `json:"completed_on,omitempty"`
	ValidUntil   *string `json:"valid_until,omitempty"`
	Findings     *string `json:"findings,omitempty"`
	DaysLeft     *int    `json:"days_left,omitempty"`
	Expired      bool    `json:"expired"`
}

func (s *Server) listBackgroundChecks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{nowInIndia().Format("2006-01-02"),
		nullID(q.Get("employee_id"))})
	items, err := collect(s, r, `
		SELECT b.id::text, e.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name),
		       b.kind, b.agency, to_char(b.requested_on,'YYYY-MM-DD'),
		       b.reference_no, b.status, to_char(b.completed_on,'YYYY-MM-DD'),
		       to_char(b.valid_until,'YYYY-MM-DD'), b.findings,
		       (b.valid_until - $1::date)::int,
		       b.status = 'clear' AND b.valid_until < $1::date
		  FROM background_verifications b
		  JOIN employees e ON e.id = b.employee_id
		 WHERE ($2::uuid IS NULL OR b.employee_id = $2::uuid)
		   AND `+mine+`
		 ORDER BY b.valid_until NULLS FIRST, b.requested_on DESC
		 LIMIT 500`,
		args,
		func(rows pgx.Rows) (backgroundRow, error) {
			var v backgroundRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.EmployeeCode, &v.Name,
				&v.Kind, &v.Agency, &v.RequestedOn, &v.ReferenceNo, &v.Status,
				&v.CompletedOn, &v.ValidUntil, &v.Findings, &v.DaysLeft, &v.Expired)
		})
	respond(w, r, items, err)
}

type backgroundRequest struct {
	ID          string `json:"id,omitempty"`
	EmployeeID  string `json:"employee_id,omitempty"`
	Kind        string `json:"kind,omitempty"`
	Agency      string `json:"agency,omitempty"`
	RequestedOn string `json:"requested_on,omitempty"`
	ReferenceNo string `json:"reference_no,omitempty"`
	Status      string `json:"status,omitempty"`
	CompletedOn string `json:"completed_on,omitempty"`
	ValidUntil  string `json:"valid_until,omitempty"`
	Findings    string `json:"findings,omitempty"`
}

/*
saveBackgroundCheck raises a verification or records its outcome.

	A clear result must carry the date it stops being trusted. The schema
	insists on it and so does this, because "police verification: clear" with
	no re-check date is the row that still reads as compliant nine years after
	the constable who signed it retired.
*/
func (s *Server) saveBackgroundCheck(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req backgroundRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Status == "clear" && req.ValidUntil == "" {
		httpx.BadRequest(w, r,
			"a clear verification needs the date it must be repeated by; without one nobody is ever told to renew it")
		return
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			checkID, err := uuid.Parse(req.ID)
			if err != nil {
				return err
			}
			tag, err := tx.Exec(r.Context(), `
				UPDATE background_verifications
				   SET agency = COALESCE($2, agency),
				       reference_no = COALESCE($3, reference_no),
				       status = COALESCE($4, status),
				       completed_on = COALESCE($5::date, completed_on),
				       valid_until = COALESCE($6::date, valid_until),
				       findings = COALESCE($7, findings)
				 WHERE id = $1`, checkID, nullString(req.Agency),
				nullString(req.ReferenceNo), nullString(req.Status),
				nullDate(req.CompletedOn), nullDate(req.ValidUntil),
				nullString(req.Findings))
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return pgx.ErrNoRows
			}
			newID = req.ID
			return nil
		}
		emp, err := uuid.Parse(req.EmployeeID)
		if err != nil {
			return err
		}
		if req.Kind == "" {
			req.Kind = "police"
		}
		if req.Status == "" {
			req.Status = "requested"
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO background_verifications (institution_id, employee_id, kind,
			    agency, requested_on, reference_no, status, completed_on,
			    valid_until, findings, recorded_by)
			VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7,$8::date,$9::date,$10,$11)
			RETURNING id::text`,
			id.InstitutionID, emp, req.Kind, nullString(req.Agency),
			nullDate(req.RequestedOn), nullString(req.ReferenceNo), req.Status,
			nullDate(req.CompletedOn), nullDate(req.ValidUntil),
			nullString(req.Findings), id.UserID).Scan(&newID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "already_requested",
			"a verification of that kind is already in flight for this employee")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID})
}

// --- welfare --------------------------------------------------------------

type celebrationRow struct {
	EmployeeID  string  `json:"employee_id"`
	Name        string  `json:"full_name"`
	Designation *string `json:"designation,omitempty"`
	Kind        string  `json:"kind"`
	OnDate      string  `json:"on_date"`
	Years       int     `json:"years"`
	DaysAway    int     `json:"days_away"`
	Greeted     bool    `json:"greeted"`
}

/*
listCelebrations is the diary, derived rather than stored.

	Birthdays and anniversaries come out of employees.date_of_birth and
	employees.joined_on. Copying them into a table of their own would give the
	school two answers to one question and one of them would go stale the first
	time a date of birth was corrected.

	Today is passed in from Go rather than read as current_date: a box running
	UTC rolls over at half past five in the evening local, and a birthday list
	that empties every evening is the same bug daterange.go already names.
*/
func (s *Server) listCelebrations(w http.ResponseWriter, r *http.Request) {
	days := 30
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v > 0 && v <= 365 {
		days = v
	}
	items, err := collect(s, r, `
		WITH events AS (
		    SELECT e.id, concat_ws(' ', e.first_name, e.last_name) AS full_name,
		           d.name AS designation, c.kind, c.base_date,
		           (EXTRACT(year FROM $1::date) - EXTRACT(year FROM c.base_date))::int AS years_now
		      FROM employees e
		      LEFT JOIN designations d ON d.id = e.designation_id
		      CROSS JOIN LATERAL (VALUES ('birthday'::text, e.date_of_birth),
		                                 ('work_anniversary'::text, e.joined_on)) AS c(kind, base_date)
		     WHERE e.status IN ('active','on_leave') AND c.base_date IS NOT NULL
		), dated AS (
		    -- Adding whole years rather than rebuilding the date keeps 29
		    -- February working: Postgres clamps it to the 28th in a common year
		    -- instead of raising, which make_date would.
		    SELECT ev.*,
		           CASE WHEN (ev.base_date + make_interval(years => ev.years_now))::date >= $1::date
		                THEN (ev.base_date + make_interval(years => ev.years_now))::date
		                ELSE (ev.base_date + make_interval(years => ev.years_now + 1))::date END AS on_date,
		           CASE WHEN (ev.base_date + make_interval(years => ev.years_now))::date >= $1::date
		                THEN ev.years_now ELSE ev.years_now + 1 END AS years
		      FROM events ev
		)
		SELECT d.id::text, d.full_name, d.designation, d.kind,
		       to_char(d.on_date,'YYYY-MM-DD'), d.years,
		       (d.on_date - $1::date)::int,
		       g.id IS NOT NULL
		  FROM dated d
		  LEFT JOIN staff_celebration_greetings g
		         ON g.employee_id = d.id AND g.kind = d.kind AND g.on_date = d.on_date
		 WHERE d.on_date <= $1::date + $2::int
		   -- Somebody who joined this year has no anniversary yet; wishing them
		   -- "zero years of service" is worse than not wishing them.
		   AND (d.kind <> 'work_anniversary' OR d.years > 0)
		 ORDER BY d.on_date, d.full_name`,
		[]any{nowInIndia().Format("2006-01-02"), days},
		func(rows pgx.Rows) (celebrationRow, error) {
			var v celebrationRow
			return v, rows.Scan(&v.EmployeeID, &v.Name, &v.Designation, &v.Kind,
				&v.OnDate, &v.Years, &v.DaysAway, &v.Greeted)
		})
	respond(w, r, items, err)
}

type greetingRequest struct {
	EmployeeID string `json:"employee_id"`
	Kind       string `json:"kind"`
	OnDate     string `json:"on_date"`
	Years      *int   `json:"years,omitempty"`
}

// recordGreeting notes that the wish went out. The unique index is what makes
// it idempotent: a scheduler that runs twice on the same morning must not wish
// the same person twice, which is how staff stop reading the notices.
func (s *Server) recordGreeting(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req greetingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	emp, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if req.Kind != "birthday" && req.Kind != "work_anniversary" {
		httpx.BadRequest(w, r, "kind must be birthday or work_anniversary")
		return
	}
	if req.OnDate == "" {
		req.OnDate = nowInIndia().Format("2006-01-02")
	}

	var already bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			INSERT INTO staff_celebration_greetings (institution_id, employee_id,
			    kind, on_date, years, greeted_by)
			VALUES ($1,$2,$3,$4::date,$5,$6)
			ON CONFLICT (employee_id, kind, on_date) DO NOTHING`,
			id.InstitutionID, emp, req.Kind, req.OnDate, req.Years, id.UserID)
		if err != nil {
			return err
		}
		already = tag.RowsAffected() == 0
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"greeted": true, "already_sent": already})
}

type grievanceRow struct {
	ID          string  `json:"id"`
	Reference   string  `json:"reference_no"`
	Anonymous   bool    `json:"is_anonymous"`
	Name        *string `json:"full_name,omitempty"`
	Category    string  `json:"category"`
	Severity    string  `json:"severity"`
	Subject     string  `json:"subject"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	AssignedTo  *string `json:"assigned_to,omitempty"`
	Resolution  *string `json:"resolution,omitempty"`
	RaisedAt    string  `json:"raised_at"`
	ResolvedAt  *string `json:"resolved_at,omitempty"`
	// How long it has been open, in days. A grievance cell is judged on this
	// number and on nothing else.
	OpenDays int `json:"open_days"`
}

func (s *Server) listGrievances(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	args := []any{q.Get("open") == "true"}
	mine, extra := grievanceFilter(re, "g", len(args)+1)
	args = append(args, extra...)
	items, err := collect(s, r, `
		SELECT g.id::text, g.reference_no, g.is_anonymous,
		       CASE WHEN g.is_anonymous THEN NULL
		            ELSE concat_ws(' ', e.first_name, e.last_name) END,
		       g.category, g.severity, g.subject, g.description, g.status,
		       u.full_name, g.resolution,
		       to_char(g.created_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(g.resolved_at,'YYYY-MM-DD"T"HH24:MI'),
		       (EXTRACT(epoch FROM COALESCE(g.resolved_at, now()) - g.created_at) / 86400)::int
		  FROM staff_grievances g
		  LEFT JOIN employees e ON e.id = g.employee_id
		  LEFT JOIN users u ON u.id = g.assigned_to
		 WHERE ($1::bool IS NOT TRUE OR g.status NOT IN ('resolved','closed','withdrawn'))
		   AND `+mine+`
		 ORDER BY g.status IN ('resolved','closed','withdrawn'),
		          array_position(ARRAY['high','medium','low'], g.severity),
		          g.created_at
		 LIMIT 300`,
		args,
		func(rows pgx.Rows) (grievanceRow, error) {
			var v grievanceRow
			return v, rows.Scan(&v.ID, &v.Reference, &v.Anonymous, &v.Name,
				&v.Category, &v.Severity, &v.Subject, &v.Description, &v.Status,
				&v.AssignedTo, &v.Resolution, &v.RaisedAt, &v.ResolvedAt, &v.OpenDays)
		})
	respond(w, r, items, err)
}

type grievanceRequest struct {
	EmployeeID  string `json:"employee_id,omitempty"`
	Anonymous   bool   `json:"is_anonymous,omitempty"`
	Category    string `json:"category,omitempty"`
	Severity    string `json:"severity,omitempty"`
	Subject     string `json:"subject"`
	Description string `json:"description"`
}

/*
raiseGrievance opens a complaint.

	When it is marked anonymous, neither the employee nor the user raising it
	is stored — the schema refuses the row otherwise. Storing the name and
	promising not to show it is the version that leaks the first time somebody
	runs a query, and a grievance cell that has leaked once is finished.
*/
func (s *Server) raiseGrievance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req grievanceRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Subject) == "" || strings.TrimSpace(req.Description) == "" {
		httpx.BadRequest(w, r, "a grievance needs a subject and what happened")
		return
	}
	if req.Category == "" {
		req.Category = "other"
	}
	if req.Severity == "" {
		req.Severity = "medium"
	}
	if !req.Anonymous && req.EmployeeID == "" {
		httpx.BadRequest(w, r, "name the employee, or raise it anonymously")
		return
	}

	var newID, ref string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Seed the series before asking for a number. NextNumber creates a
		   scheme for a kind it has no default prefix for, and a complaint the
		   staff have to quote as "2026-27/0001" is one they will get wrong. */
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO numbering_schemes (institution_id, kind, prefix, padding,
			                               next_value, reset_yearly)
			VALUES ($1,'grievance','GRV/',4,1,true)
			ON CONFLICT (institution_id, kind) WHERE campus_id IS NULL DO NOTHING`,
			id.InstitutionID); err != nil {
			return err
		}
		var err error
		ref, err = fees.NextNumber(r.Context(), tx, id.InstitutionID, "grievance")
		if err != nil {
			return err
		}
		var raisedBy any
		if !req.Anonymous {
			raisedBy = id.UserID
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO staff_grievances (institution_id, reference_no, employee_id,
			    raised_by, is_anonymous, category, severity, subject, description)
			VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9)
			RETURNING id::text`,
			id.InstitutionID, ref,
			nullID(map[bool]string{true: "", false: req.EmployeeID}[req.Anonymous]),
			raisedBy, req.Anonymous, req.Category, req.Severity,
			req.Subject, req.Description).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "reference_no": ref})
}

type grievanceDecision struct {
	Status     string `json:"status"`
	AssignedTo string `json:"assigned_to,omitempty"`
	Resolution string `json:"resolution,omitempty"`
}

func (s *Server) decideGrievance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	gid, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req grievanceDecision
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Status == "" {
		httpx.BadRequest(w, r, "say what the grievance has moved to")
		return
	}
	if (req.Status == "resolved" || req.Status == "closed") &&
		strings.TrimSpace(req.Resolution) == "" {
		httpx.BadRequest(w, r, "closing a grievance needs a note saying what was done")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE staff_grievances
			   SET status = $2,
			       assigned_to = COALESCE($3::uuid, assigned_to),
			       resolution = COALESCE($4, resolution),
			       acknowledged_at = COALESCE(acknowledged_at,
			           CASE WHEN $2 <> 'open' THEN now() END),
			       resolved_at = CASE WHEN $2 IN ('resolved','closed')
			                          THEN COALESCE(resolved_at, now()) END
			 WHERE id = $1`, gid, req.Status, nullID(req.AssignedTo),
			nullString(req.Resolution))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": req.Status})
}

type recognitionRow struct {
	ID          string  `json:"id"`
	EmployeeID  string  `json:"employee_id"`
	Name        string  `json:"full_name"`
	Designation *string `json:"designation,omitempty"`
	Campus      *string `json:"campus,omitempty"`
	AwardCode   string  `json:"award_code"`
	Title       string  `json:"title"`
	Citation    *string `json:"citation,omitempty"`
	Period      *string `json:"period,omitempty"`
	AwardedOn   string  `json:"awarded_on"`
	NominatedBy *string `json:"nominated_by,omitempty"`
	Published   bool    `json:"published"`
}

func (s *Server) listRecognitions(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT rc.id::text, e.id::text, concat_ws(' ', e.first_name, e.last_name),
		       d.name, c.name, rc.award_code, rc.title, rc.citation,
		       CASE WHEN rc.period_year IS NULL THEN NULL
		            ELSE to_char(make_date(rc.period_year, COALESCE(rc.period_month,1), 1),
		                         'Mon YYYY') END,
		       to_char(rc.awarded_on,'YYYY-MM-DD'), u.full_name, rc.published
		  FROM staff_recognitions rc
		  JOIN employees e ON e.id = rc.employee_id
		  LEFT JOIN designations d ON d.id = e.designation_id
		  LEFT JOIN campuses c ON c.id = rc.campus_id
		  LEFT JOIN users u ON u.id = rc.nominated_by
		 WHERE ($1::bool IS NOT TRUE OR rc.published)
		 ORDER BY rc.awarded_on DESC, rc.created_at DESC
		 LIMIT 200`,
		[]any{r.URL.Query().Get("published") == "true"},
		func(rows pgx.Rows) (recognitionRow, error) {
			var v recognitionRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.Name, &v.Designation,
				&v.Campus, &v.AwardCode, &v.Title, &v.Citation, &v.Period,
				&v.AwardedOn, &v.NominatedBy, &v.Published)
		})
	respond(w, r, items, err)
}

type recognitionRequest struct {
	EmployeeID string `json:"employee_id"`
	CampusID   string `json:"campus_id,omitempty"`
	AwardCode  string `json:"award_code,omitempty"`
	Title      string `json:"title"`
	Citation   string `json:"citation,omitempty"`
	Year       *int   `json:"period_year,omitempty"`
	Month      *int   `json:"period_month,omitempty"`
	Published  *bool  `json:"published,omitempty"`
}

func (s *Server) recordRecognition(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req recognitionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	emp, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		httpx.BadRequest(w, r, "the award needs a title")
		return
	}
	if req.AwardCode == "" {
		req.AwardCode = "peer_praise"
	}
	if req.AwardCode == "teacher_of_the_month" && (req.Year == nil || req.Month == nil) {
		now := nowInIndia()
		y, m := now.Year(), int(now.Month())
		req.Year, req.Month = &y, &m
	}
	published := true
	if req.Published != nil {
		published = *req.Published
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO staff_recognitions (institution_id, employee_id, campus_id,
			    award_code, title, citation, period_year, period_month,
			    nominated_by, published)
			VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10)
			RETURNING id::text`,
			id.InstitutionID, emp, nullID(req.CampusID), req.AwardCode, req.Title,
			nullString(req.Citation), req.Year, req.Month, id.UserID,
			published).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "award_already_made",
			"that award has already been made for this month; withdraw it before naming somebody else")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- leave policy and loss of pay -----------------------------------------

// leavePolicy mirrors the table. Every field is a rule somebody has to defend
// to a teacher whose salary came up short.
type leavePolicy struct {
	HalfDayFraction float64  `json:"half_day_fraction"`
	ShiftStartsAt   string   `json:"shift_starts_at"`
	GraceMinutes    int      `json:"grace_minutes"`
	LateMarksPerDay int      `json:"late_marks_per_lop_day"`
	LateHalfDayMins *int     `json:"late_half_day_after_minutes,omitempty"`
	LOPOnAbsent     bool     `json:"lop_on_absent"`
	LOPOnUnpaid     bool     `json:"lop_on_unpaid_leave"`
	Rounding        string   `json:"lop_rounding"`
	MaxLOPPerMonth  *float64 `json:"max_lop_days_per_month,omitempty"`
	// The per-type rules, joined to the leave type they govern so the screen
	// shows the quota and the rule together rather than in two tables.
	Types []leaveTypeRule `json:"types"`
}

type leaveTypeRule struct {
	LeaveTypeID  string   `json:"leave_type_id"`
	Code         string   `json:"code"`
	Name         string   `json:"name"`
	AnnualQuota  *float64 `json:"annual_quota,omitempty"`
	IsPaid       bool     `json:"is_paid"`
	CarryForward bool     `json:"carry_forward"`
	Accrual      string   `json:"accrual"`
	CarryMax     *float64 `json:"carry_forward_max,omitempty"`
	Encashable   bool     `json:"encashable"`
	AllowHalfDay bool     `json:"allow_half_day"`
	MaxDays      *float64 `json:"max_consecutive_days,omitempty"`
	NoticeDays   int      `json:"notice_days"`
	DocAfterDays *float64 `json:"document_required_after_days,omitempty"`
	OnProbation  bool     `json:"available_during_probation"`
	Gender       *string  `json:"applies_to_gender,omitempty"`
}

const leavePolicyColumns = `half_day_fraction::float8, to_char(shift_starts_at,'HH24:MI'),
	grace_minutes, late_marks_per_lop_day, late_half_day_after_minutes,
	lop_on_absent, lop_on_unpaid_leave, lop_rounding, max_lop_days_per_month::float8`

/*
getLeavePolicy reads the rules, creating the defaults if the school has none.

	Created on read rather than refused, for the same reason payroll settings
	are: a school that has never opened this screen still runs payroll, and the
	defaults are the ones the loss-of-pay function falls back to anyway.
*/
func (s *Server) getLeavePolicy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var v leavePolicy
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		scan := func() error {
			return tx.QueryRow(r.Context(),
				`SELECT `+leavePolicyColumns+` FROM leave_policy WHERE institution_id = $1`,
				id.InstitutionID).Scan(&v.HalfDayFraction, &v.ShiftStartsAt,
				&v.GraceMinutes, &v.LateMarksPerDay, &v.LateHalfDayMins,
				&v.LOPOnAbsent, &v.LOPOnUnpaid, &v.Rounding, &v.MaxLOPPerMonth)
		}
		if err := scan(); errors.Is(err, pgx.ErrNoRows) {
			if _, err := tx.Exec(r.Context(),
				`INSERT INTO leave_policy (institution_id) VALUES ($1)
				 ON CONFLICT DO NOTHING`, id.InstitutionID); err != nil {
				return err
			}
			if err := scan(); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}

		// A leave type with no rule row is listed with the defaults rather than
		// omitted: a type missing from the policy screen is a type nobody knows
		// is unconfigured.
		rows, err := tx.Query(r.Context(), `
			SELECT lt.id::text, lt.code, lt.name, lt.annual_quota::float8,
			       lt.is_paid, lt.carry_forward,
			       COALESCE(pr.accrual, 'annual'), pr.carry_forward_max::float8,
			       COALESCE(pr.encashable, false), COALESCE(pr.allow_half_day, true),
			       pr.max_consecutive_days::float8, COALESCE(pr.notice_days, 0),
			       pr.document_required_after_days::float8,
			       COALESCE(pr.available_during_probation, false), pr.applies_to_gender
			  FROM leave_types lt
			  LEFT JOIN leave_policy_rules pr ON pr.leave_type_id = lt.id
			 WHERE lt.applies_to = 'staff'
			 ORDER BY lt.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		v.Types = []leaveTypeRule{}
		for rows.Next() {
			var t leaveTypeRule
			if err := rows.Scan(&t.LeaveTypeID, &t.Code, &t.Name, &t.AnnualQuota,
				&t.IsPaid, &t.CarryForward, &t.Accrual, &t.CarryMax, &t.Encashable,
				&t.AllowHalfDay, &t.MaxDays, &t.NoticeDays, &t.DocAfterDays,
				&t.OnProbation, &t.Gender); err != nil {
				return err
			}
			v.Types = append(v.Types, t)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Server) saveLeavePolicy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req leavePolicy
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.ShiftStartsAt == "" {
		req.ShiftStartsAt = "09:00"
	}
	if req.Rounding == "" {
		req.Rounding = "half"
	}
	if req.LateMarksPerDay <= 0 {
		httpx.BadRequest(w, r, "say how many late marks make a day; zero would charge a day for every one")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO leave_policy (institution_id, half_day_fraction, shift_starts_at,
			    grace_minutes, late_marks_per_lop_day, late_half_day_after_minutes,
			    lop_on_absent, lop_on_unpaid_leave, lop_rounding, max_lop_days_per_month)
			VALUES ($1,$2,$3::time,$4,$5,$6,$7,$8,$9,$10)
			ON CONFLICT (institution_id) DO UPDATE SET
			    half_day_fraction = EXCLUDED.half_day_fraction,
			    shift_starts_at = EXCLUDED.shift_starts_at,
			    grace_minutes = EXCLUDED.grace_minutes,
			    late_marks_per_lop_day = EXCLUDED.late_marks_per_lop_day,
			    late_half_day_after_minutes = EXCLUDED.late_half_day_after_minutes,
			    lop_on_absent = EXCLUDED.lop_on_absent,
			    lop_on_unpaid_leave = EXCLUDED.lop_on_unpaid_leave,
			    lop_rounding = EXCLUDED.lop_rounding,
			    max_lop_days_per_month = EXCLUDED.max_lop_days_per_month`,
			id.InstitutionID, req.HalfDayFraction, req.ShiftStartsAt,
			req.GraceMinutes, req.LateMarksPerDay, req.LateHalfDayMins,
			req.LOPOnAbsent, req.LOPOnUnpaid, req.Rounding,
			req.MaxLOPPerMonth); err != nil {
			return err
		}
		for _, t := range req.Types {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO leave_policy_rules (leave_type_id, institution_id, accrual,
				    carry_forward_max, encashable, allow_half_day, max_consecutive_days,
				    notice_days, document_required_after_days,
				    available_during_probation, applies_to_gender)
				VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
				ON CONFLICT (leave_type_id) DO UPDATE SET
				    accrual = EXCLUDED.accrual,
				    carry_forward_max = EXCLUDED.carry_forward_max,
				    encashable = EXCLUDED.encashable,
				    allow_half_day = EXCLUDED.allow_half_day,
				    max_consecutive_days = EXCLUDED.max_consecutive_days,
				    notice_days = EXCLUDED.notice_days,
				    document_required_after_days = EXCLUDED.document_required_after_days,
				    available_during_probation = EXCLUDED.available_during_probation,
				    applies_to_gender = EXCLUDED.applies_to_gender`,
				t.LeaveTypeID, id.InstitutionID, defaulted(t.Accrual, "annual"),
				t.CarryMax, t.Encashable, t.AllowHalfDay, t.MaxDays,
				t.NoticeDays, t.DocAfterDays, t.OnProbation, t.Gender); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

type lopRow struct {
	EmployeeID   string  `json:"employee_id"`
	EmployeeCode string  `json:"employee_code"`
	Name         string  `json:"full_name"`
	Absent       float64 `json:"absent_days"`
	HalfDays     float64 `json:"half_days"`
	UnpaidLeave  float64 `json:"unpaid_leave_days"`
	LateMarks    int     `json:"late_marks"`
	LOPDays      float64 `json:"lop_days"`
	// Paid leave taken past its quota. Kept apart from unpaid leave because
	// they are different conversations to have with the person: one is a leave
	// they were never funded for, the other is a leave they had used up.
	QuotaLOP float64 `json:"quota_lop_days"`
}

/*
getLOPRegister is the month's loss of pay, worked out from the same function
payroll reads.

	Deliberately not recomputed here. A screen that shows one number and a
	payslip that shows another is an argument the office cannot win, and the
	only way to guarantee they agree is for both to call staff_lop_register.
*/
func (s *Server) getLOPRegister(w http.ResponseWriter, r *http.Request) {
	year, month := periodFrom(r)
	re, ok := s.lifecycleReach(w, r)
	if !ok {
		return
	}
	mine, args := narrow(re, "e", []any{year, month})
	items, err := collect(s, r, `
		SELECT e.id::text, e.employee_code, concat_ws(' ', e.first_name, e.last_name),
		       l.absent_days::float8, l.half_days::float8, l.unpaid_leave_days::float8,
		       l.late_marks, l.lop_days::float8, l.quota_lop_days::float8
		  FROM staff_lop_register($1::int, $2::int) l
		  JOIN employees e ON e.id = l.employee_id
		 WHERE `+mine+`
		 ORDER BY l.lop_days DESC, e.employee_code`,
		args,
		func(rows pgx.Rows) (lopRow, error) {
			var v lopRow
			return v, rows.Scan(&v.EmployeeID, &v.EmployeeCode, &v.Name, &v.Absent,
				&v.HalfDays, &v.UnpaidLeave, &v.LateMarks, &v.LOPDays, &v.QuotaLOP)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	var total float64
	for _, it := range items {
		total += it.LOPDays
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "year": year, "month": month, "total_lop_days": total,
	})
}

// --- small helpers --------------------------------------------------------

// uuidParam reads a uuid out of the path and answers the request itself when
// it is not one, so every handler does not repeat the same four lines.
func uuidParam(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	v, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		httpx.BadRequest(w, r, name+" must be a uuid")
		return uuid.Nil, false
	}
	return v, true
}

// nullDate turns an empty date field into SQL NULL. An unfilled date input
// posts as "", and inserting that is an error rather than the absent answer it
// actually is.
func nullDate(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// nullID is nullDate for an optional foreign key sent as text.
func nullID(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func defaulted(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
