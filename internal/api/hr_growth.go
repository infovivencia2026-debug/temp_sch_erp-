package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Hiring, growing and rostering the staff a school already has.

   Four features that share one subject and one boundary problem. Recruitment
   fills a post; the appraisal decides what the person in it is paid next year;
   the training log evidences the hours a board asks for; the duty roster puts
   them on the gate at seven. All four are read by people with very different
   entitlements, and three of the four hold something an employee must be able
   to see about themselves and not about the person at the next desk.

   That boundary is the reason this file exists rather than a fifth section of
   hr_lifecycle.go. That module gates on hr.employees.read at the group and
   never calls resolveScope, so a head of department who legitimately holds it
   reads every colleague's KYC and bank account. Every list below resolves the
   caller's real reach first (growthReach) and filters on it, and self-service
   is a separate group on self.profile.read so a teacher can open their own
   appraisal without being given the whole staff room.

   Nothing here invents a permission. hr.employees.read opens the screens,
   hr.employees.write is the back-office capability that widens a read to the
   whole institution and authorises every write, and self.profile.read carries
   the four "mine" endpoints.
*/

// mountHRGrowth registers hiring, appraisal, training and rostering.
//
// Called from the authenticated router — the same level as mountTimetableOps,
// NOT inside the existing r.Route("/hr", ...) group. That group carries
// RequirePermission(EmployeesRead) for everything nested in it, and four of
// these endpoints are a teacher's own record: mounting inside it would 403 a
// teacher opening their own appraisal, exactly as it once did for their own
// leave. The prefix is /hr-growth rather than /hr because chi panics when a
// second Route claims a pattern that already has one.
func (s *Server) mountHRGrowth(r chi.Router) {
	r.Route("/hr-growth", func(r chi.Router) {
		// --- the employee's own record ---------------------------------
		//
		// In its own Group so it does not inherit the HR gate below. A
		// teacher holds self.profile.read and nothing else in this file;
		// every handler here narrows to the caller's own employee row on
		// the server, so the permission opens the screen and the query
		// decides the rows.
		r.Group(func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.SelfProfileRead))
			r.Get("/me/appraisals", s.listMyAppraisals)
			r.Get("/me/appraisals/{id}", s.getMyAppraisal)
			r.Post("/me/appraisals/{id}/self-assessment", s.submitSelfAssessment)
			r.Post("/me/appraisals/{id}/acknowledge", s.acknowledgeAppraisal)
			r.Get("/me/training", s.getMyTrainingRecord)
			r.Get("/me/duties", s.listMyDuties)
		})

		// --- the HR desk ------------------------------------------------
		r.Group(func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.EmployeesRead))
			write := httpx.RequirePermission(rbac.EmployeesWrite)

			// The role vocabulary these four features all key off: a vacancy
			// names a designation, a KPI set is per designation, and the
			// training requirement is per designation category. Served here
			// because nothing else exposes it — designations had no endpoint
			// at all, so every selector that needed one was empty.
			r.Get("/designations", s.listGrowthDesignations)

			// hr.hiring_growth.recruitment
			r.Get("/vacancies", s.listVacancies)
			r.With(write).Post("/vacancies", s.saveVacancy)
			r.With(write).Post("/vacancies/{id}/decide", s.decideVacancy)
			r.Get("/candidates", s.listCandidates)
			r.With(write).Post("/candidates", s.saveCandidate)
			r.With(write).Post("/candidates/{id}/stage", s.moveCandidateStage)
			r.With(write).Post("/candidates/{id}/hire", s.hireCandidate)
			r.Get("/interviews", s.listInterviews)
			r.With(write).Post("/interviews", s.scheduleInterview)
			r.With(write).Post("/interviews/{id}/result", s.recordInterviewResult)
			r.Get("/offers", s.listOffers)
			r.With(write).Post("/offers", s.makeOffer)
			r.With(write).Post("/offers/{id}/respond", s.recordOfferResponse)
			r.Get("/recruitment/funnel", s.getRecruitmentFunnel)

			// hr.hiring_growth.annual_performance_appraisal_kpi
			r.Get("/appraisal/cycles", s.listAppraisalCycles)
			r.With(write).Post("/appraisal/cycles", s.saveAppraisalCycle)
			r.Get("/appraisal/kpis", s.listAppraisalKPIs)
			r.With(write).Put("/appraisal/kpis", s.saveAppraisalKPIs)
			r.Get("/appraisal/records", s.listAppraisals)
			r.Get("/appraisal/records/{id}", s.getAppraisal)
			r.With(write).Post("/appraisal/records", s.raiseAppraisals)
			// Not gated on write: the reviewer is a head of department who
			// holds employees.read only. The handler checks they are the
			// named reviewer, which is a narrower rule than any permission.
			r.Post("/appraisal/records/{id}/review", s.reviewAppraisal)
			r.With(write).Post("/appraisal/records/{id}/moderate", s.moderateAppraisal)
			r.With(write).Post("/appraisal/records/{id}/publish", s.publishAppraisal)
			r.With(write).Post("/appraisal/records/{id}/discussion", s.recordAppraisalDiscussion)

			// hr.hiring_growth.staff_training_workshop_logs
			r.Get("/training/programmes", s.listTrainingProgrammes)
			r.With(write).Post("/training/programmes", s.saveTrainingProgramme)
			r.Get("/training/records", s.listTrainingRecords)
			r.With(write).Post("/training/records", s.saveTrainingRecord)
			r.Get("/training/requirements", s.listTrainingRequirements)
			r.With(write).Put("/training/requirements", s.saveTrainingRequirement)
			r.Get("/training/compliance", s.getTrainingCompliance)

			// hr.attendance.staff_shift_rostering
			r.Get("/roster/shifts", s.listDutyShifts)
			r.With(write).Put("/roster/shifts", s.saveDutyShift)
			r.Get("/roster", s.listDutyRoster)
			r.With(write).Post("/roster", s.assignDuty)
			r.With(write).Post("/roster/{id}/cancel", s.cancelDuty)
			r.Get("/roster/conflicts", s.listRosterConflicts)
			r.Get("/roster/fairness", s.getRosterFairness)
		})
	})
}

// ===========================================================================
// Who may see whom
// ===========================================================================

/*
growthReach is the caller's real boundary over staff records.

	RLS answers "which school?" and stops there. Everything in this file is a
	row from the caller's own tenant, so a policy will happily hand a head of
	department the principal's appraisal score. The narrowing has to be an
	explicit predicate, and this is it.

	hr.employees.write is the marker for the back office. HR and the principal
	hold it and read the whole institution; a head of department, a vice
	principal and an examinations controller hold hr.employees.read without it
	and are narrowed — to their department if they head one, and to their own
	record if they do not. That is deliberately conservative: for salary,
	appraisal scores and KYC the cost of being too narrow is a support ticket,
	and the cost of being too wide is the staff room reading each other's
	increments.
*/
type growthReach struct {
	UserID   uuid.UUID
	All      bool
	DeptIDs  []uuid.UUID
	OwnEmpID *uuid.UUID
}

func (s *Server) growthReach(r *http.Request) (*growthReach, error) {
	id := httpx.IdentityFrom(r.Context())
	sc, err := s.resolveScope(r)
	if err != nil {
		return nil, err
	}
	re := &growthReach{UserID: id.UserID, DeptIDs: sc.DepartmentIDs}
	re.All = sc.PlatformAdmin || id.Can(rbac.EmployeesWrite)

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var emp uuid.UUID
		switch err := tx.QueryRow(r.Context(),
			`SELECT id FROM employees WHERE user_id = $1 LIMIT 1`, id.UserID).Scan(&emp); {
		case errors.Is(err, pgx.ErrNoRows):
			return nil // a platform operator has no employee row; that is fine
		case err != nil:
			return err
		}
		re.OwnEmpID = &emp
		return nil
	})
	return re, err
}

/*
employeeFilter is the predicate restricting an employees alias to what the
caller may read, plus the arguments to bind.

	An empty reach yields FALSE rather than an omitted clause, for the same
	reason internal/scope does it: "this person heads nothing" must mean no
	rows, not every row, because that is the direction that turns a scope bug
	into a breach.
*/
func (re *growthReach) employeeFilter(alias string, next int) (string, []any) {
	if re.All {
		return "TRUE", nil
	}
	var parts []string
	var args []any
	if len(re.DeptIDs) > 0 {
		parts = append(parts, fmt.Sprintf("%s.department_id = ANY($%d)", alias, next))
		args = append(args, re.DeptIDs)
		next++
	}
	if re.OwnEmpID != nil {
		parts = append(parts, fmt.Sprintf("%s.id = $%d", alias, next))
		args = append(args, *re.OwnEmpID)
	}
	if len(parts) == 0 {
		return "FALSE", nil
	}
	return "(" + strings.Join(parts, " OR ") + ")", args
}

// appraisalFilter is employeeFilter plus the appraisals a person owns because
// they were named to conduct them. A reviewer who heads no department still
// has to open the six appraisals they were given.
func (re *growthReach) appraisalFilter(empAlias, apprAlias string, next int) (string, []any) {
	base, args := re.employeeFilter(empAlias, next)
	if re.All {
		return base, args
	}
	next += len(args)
	mine := fmt.Sprintf("(%s.reviewer_user_id = $%d OR %s.moderator_user_id = $%d)",
		apprAlias, next, apprAlias, next)
	args = append(args, re.UserID)
	if base == "FALSE" {
		return mine, args
	}
	return "(" + base + " OR " + mine + ")", args
}

// ownEmployee resolves the caller's own employee row for the self-service
// endpoints, answering 404 rather than an empty list when they have none: a
// parent or a platform operator asking for "my appraisal" has not been denied
// anything, they simply are not staff.
func (s *Server) ownEmployee(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id := httpx.IdentityFrom(r.Context())
	var emp uuid.UUID
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT id FROM employees WHERE user_id = $1 LIMIT 1`, id.UserID).Scan(&emp)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, r, http.StatusNotFound, "not_staff",
			"you have no staff record in this school")
		return uuid.Nil, false
	case err != nil:
		httpx.Internal(w, r, err)
		return uuid.Nil, false
	}
	return emp, true
}

// growthPathID reads the {id} path parameter as a uuid.
func growthPathID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return uuid.Nil, false
	}
	return id, true
}

// growthTxn runs one write transaction and maps the failures this file cares
// about onto honest statuses. The rostering triggers and the appraisal weight
// gate both RAISE with check_violation, and reporting those as 500 would tell
// a user their roster crashed when in fact it was refused for a reason they
// can act on.
func (s *Server) growthTxn(w http.ResponseWriter, r *http.Request, fn func(pgx.Tx) error) bool {
	id := httpx.IdentityFrom(r.Context())
	err := s.DB.InTenant(r.Context(), tenantScope(id), fn)
	if err == nil {
		return true
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23514", "P0001": // check_violation, raise_exception
			httpx.Error(w, r, http.StatusConflict, "refused", pg.Message)
			return false
		case "23505": // unique_violation
			httpx.Error(w, r, http.StatusConflict, "duplicate",
				"that record already exists")
			return false
		case "23503": // foreign_key_violation
			httpx.BadRequest(w, r, "one of the ids in this request does not exist")
			return false
		}
	}
	httpx.Internal(w, r, err)
	return false
}

// growthRange reads ?from=&to=, defaulting to the month around today in India.
func growthRange(r *http.Request) (string, string) {
	q := r.URL.Query()
	from, to := q.Get("from"), q.Get("to")
	if from == "" || to == "" {
		now := nowInIndia()
		first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		from = first.Format(time.DateOnly)
		to = first.AddDate(0, 1, -1).Format(time.DateOnly)
	}
	return from, to
}

// ===========================================================================
// The role vocabulary
// ===========================================================================

type growthDesignationRow struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Category *string `json:"category,omitempty"`
	// How many active staff hold it. A KPI set for a designation nobody holds
	// is effort spent on nothing, and the number is what tells the user which
	// roles are worth weighting first.
	Staff int `json:"staff"`
}

func (s *Server) listGrowthDesignations(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT g.id::text, g.name, g.category,
		       count(e.id) FILTER (WHERE e.status = 'active')::int
		  FROM designations g
		  LEFT JOIN employees e ON e.designation_id = g.id
		 GROUP BY g.id
		 ORDER BY g.category NULLS LAST, g.name`, nil,
		func(rows pgx.Rows) (growthDesignationRow, error) {
			var v growthDesignationRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Category, &v.Staff)
		})
	respond(w, r, items, err)
}

// ===========================================================================
// hr.hiring_growth.recruitment
// ===========================================================================

type vacancyRow struct {
	ID               string   `json:"id"`
	Code             string   `json:"code"`
	Title            string   `json:"title"`
	Department       *string  `json:"department,omitempty"`
	Designation      *string  `json:"designation,omitempty"`
	Subject          *string  `json:"subject,omitempty"`
	EmploymentType   *string  `json:"employment_type,omitempty"`
	Positions        int      `json:"positions"`
	SalaryMinPaise   *int64   `json:"salary_min_paise,omitempty"`
	SalaryMaxPaise   *int64   `json:"salary_max_paise,omitempty"`
	MinQualification *string  `json:"min_qualification,omitempty"`
	MinExperience    *float64 `json:"min_experience_years,omitempty"`
	Justification    *string  `json:"justification,omitempty"`
	Status           string   `json:"status"`
	RaisedBy         *string  `json:"raised_by,omitempty"`
	RaisedOn         string   `json:"raised_on"`
	ApprovedBy       *string  `json:"approved_by,omitempty"`
	ApprovedOn       *string  `json:"approved_on,omitempty"`
	DecisionNote     *string  `json:"decision_note,omitempty"`
	ClosesOn         *string  `json:"closes_on,omitempty"`
	// The funnel for this one post, so a list answers "and how is it going?"
	Applicants int `json:"applicants"`
	InProcess  int `json:"in_process"`
	Joined     int `json:"joined"`
	// Positions still to fill. The number that decides whether the post is
	// advertised again, and the reason positions is a column rather than 1.
	Remaining int `json:"remaining"`
}

func (s *Server) listVacancies(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT v.id::text, v.code, v.title, d.name, g.name, sub.name,
		       v.employment_type, v.positions,
		       v.salary_min_paise, v.salary_max_paise,
		       v.min_qualification, v.min_experience_years::float8, v.justification,
		       v.status, ru.full_name, to_char(v.raised_on,'YYYY-MM-DD'),
		       au.full_name, to_char(v.approved_at,'YYYY-MM-DD'),
		       v.decision_note, to_char(v.closes_on,'YYYY-MM-DD'),
		       count(c.id)::int,
		       count(c.id) FILTER (WHERE c.stage IN
		           ('applied','screened','shortlisted','interviewed','demo_lesson','offered'))::int,
		       count(c.id) FILTER (WHERE c.stage = 'joined')::int,
		       greatest(v.positions - count(c.id) FILTER (WHERE c.stage = 'joined'), 0)::int
		  FROM job_vacancies v
		  LEFT JOIN departments  d   ON d.id   = v.department_id
		  LEFT JOIN designations g   ON g.id   = v.designation_id
		  LEFT JOIN subjects     sub ON sub.id = v.subject_id
		  LEFT JOIN users        ru  ON ru.id  = v.raised_by
		  LEFT JOIN users        au  ON au.id  = v.approved_by
		  LEFT JOIN job_candidates c ON c.vacancy_id = v.id
		 WHERE ($1::text IS NULL OR v.status = $1)
		 GROUP BY v.id, d.name, g.name, sub.name, ru.full_name, au.full_name
		 -- Posts still being filled first; a closed vacancy is history.
		 ORDER BY (v.status IN ('approved','pending_approval')) DESC, v.raised_on DESC
		 LIMIT 300`, []any{nullString(q.Get("status"))},
		func(rows pgx.Rows) (vacancyRow, error) {
			var v vacancyRow
			return v, rows.Scan(&v.ID, &v.Code, &v.Title, &v.Department, &v.Designation,
				&v.Subject, &v.EmploymentType, &v.Positions, &v.SalaryMinPaise,
				&v.SalaryMaxPaise, &v.MinQualification, &v.MinExperience,
				&v.Justification, &v.Status, &v.RaisedBy, &v.RaisedOn, &v.ApprovedBy,
				&v.ApprovedOn, &v.DecisionNote, &v.ClosesOn,
				&v.Applicants, &v.InProcess, &v.Joined, &v.Remaining)
		})
	respond(w, r, items, err)
}

type vacancyRequest struct {
	ID               string   `json:"id,omitempty"`
	Code             string   `json:"code"`
	Title            string   `json:"title"`
	DepartmentID     string   `json:"department_id,omitempty"`
	DesignationID    string   `json:"designation_id,omitempty"`
	SubjectID        string   `json:"subject_id,omitempty"`
	AcademicYearID   string   `json:"academic_year_id,omitempty"`
	EmploymentType   string   `json:"employment_type,omitempty"`
	Positions        int      `json:"positions,omitempty"`
	SalaryMinPaise   *int64   `json:"salary_min_paise,omitempty"`
	SalaryMaxPaise   *int64   `json:"salary_max_paise,omitempty"`
	MinQualification string   `json:"min_qualification,omitempty"`
	MinExperience    *float64 `json:"min_experience_years,omitempty"`
	Justification    string   `json:"justification,omitempty"`
	ClosesOn         string   `json:"closes_on,omitempty"`
	// Raised for approval straight away, rather than saved as a draft.
	Submit bool `json:"submit,omitempty"`
}

// saveVacancy raises a post, or edits one that has not been approved yet.
//
// An approved vacancy is deliberately not editable through this path: changing
// the designation or the band on a post somebody has already signed off is how
// an approval becomes decorative. Withdraw it and raise another.
func (s *Server) saveVacancy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req vacancyRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Code) == "" || strings.TrimSpace(req.Title) == "" {
		httpx.BadRequest(w, r, "code and title are required")
		return
	}
	if req.Positions <= 0 {
		req.Positions = 1
	}
	if req.SalaryMinPaise != nil && req.SalaryMaxPaise != nil &&
		*req.SalaryMaxPaise < *req.SalaryMinPaise {
		httpx.BadRequest(w, r, "the top of the band cannot be below the bottom of it")
		return
	}
	status := "draft"
	if req.Submit {
		status = "pending_approval"
	}

	var out string
	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		if req.ID != "" {
			tag, err := tx.Exec(r.Context(), `
				UPDATE job_vacancies
				   SET title = $2, department_id = $3::uuid, designation_id = $4::uuid,
				       subject_id = $5::uuid, academic_year_id = $6::uuid,
				       employment_type = $7, positions = $8,
				       salary_min_paise = $9, salary_max_paise = $10,
				       min_qualification = $11, min_experience_years = $12,
				       justification = $13, closes_on = $14::date, status = $15
				 WHERE id = $1::uuid AND status IN ('draft','pending_approval')`,
				req.ID, req.Title, nullString(req.DepartmentID), nullString(req.DesignationID),
				nullString(req.SubjectID), nullString(req.AcademicYearID),
				nullString(req.EmploymentType), req.Positions,
				req.SalaryMinPaise, req.SalaryMaxPaise, nullString(req.MinQualification),
				req.MinExperience, nullString(req.Justification), nullString(req.ClosesOn),
				status)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errVacancyLocked
			}
			out = req.ID
			return nil
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO job_vacancies (institution_id, code, title, department_id,
			        designation_id, subject_id, academic_year_id, employment_type,
			        positions, salary_min_paise, salary_max_paise, min_qualification,
			        min_experience_years, justification, closes_on, status, raised_by)
			VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,$11,$12,$13,
			        $14,$15::date,$16,$17)
			RETURNING id::text`,
			id.InstitutionID, strings.TrimSpace(req.Code), strings.TrimSpace(req.Title),
			nullString(req.DepartmentID), nullString(req.DesignationID),
			nullString(req.SubjectID), nullString(req.AcademicYearID),
			nullString(req.EmploymentType), req.Positions,
			req.SalaryMinPaise, req.SalaryMaxPaise, nullString(req.MinQualification),
			req.MinExperience, nullString(req.Justification), nullString(req.ClosesOn),
			status, id.UserID).Scan(&out)
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "status": status})
}

var errVacancyLocked = errors.New(
	"an approved vacancy cannot be edited; withdraw it and raise another")

type vacancyDecision struct {
	Action string `json:"action"` // approve | reject | hold | close | withdraw
	Note   string `json:"note,omitempty"`
}

// decideVacancy is the approval. A post exists to be filled only once somebody
// with the budget has said so, and approved_by/approved_at are written together
// because a CHECK refuses one without the other.
func (s *Server) decideVacancy(w http.ResponseWriter, r *http.Request) {
	vac, ok := growthPathID(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req vacancyDecision
	if !httpx.Decode(w, r, &req) {
		return
	}
	next, approving := "", false
	switch req.Action {
	case "approve":
		next, approving = "approved", true
	case "reject":
		next = "rejected"
	case "hold":
		next = "on_hold"
	case "close":
		next = "closed"
	case "withdraw":
		next = "draft"
	default:
		httpx.BadRequest(w, r, "action must be approve, reject, hold, close or withdraw")
		return
	}

	var affected int64
	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE job_vacancies
			   SET status = $2,
			       decision_note = COALESCE($3, decision_note),
			       approved_by = CASE WHEN $4 THEN $5::uuid ELSE approved_by END,
			       approved_at = CASE WHEN $4 THEN now()    ELSE approved_at END,
			       closed_at   = CASE WHEN $2 IN ('closed','rejected') THEN now()
			                          ELSE closed_at END
			 WHERE id = $1::uuid`,
			vac, next, nullString(req.Note), approving, id.UserID)
		affected = tag.RowsAffected()
		return err
	})
	if !ok {
		return
	}
	if affected == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": vac.String(), "status": next})
}

type candidateRow struct {
	ID              string   `json:"id"`
	VacancyID       string   `json:"vacancy_id"`
	VacancyCode     string   `json:"vacancy_code"`
	VacancyTitle    string   `json:"vacancy_title"`
	FullName        string   `json:"full_name"`
	Email           *string  `json:"email,omitempty"`
	Phone           *string  `json:"phone,omitempty"`
	Qualification   *string  `json:"qualification,omitempty"`
	Experience      *float64 `json:"experience_years,omitempty"`
	CurrentEmployer *string  `json:"current_employer,omitempty"`
	ExpectedPaise   *int64   `json:"expected_salary_paise,omitempty"`
	NoticeDays      *int     `json:"notice_period_days,omitempty"`
	Source          string   `json:"source"`
	ResumeFileID    *string  `json:"resume_file_id,omitempty"`
	Stage           string   `json:"stage"`
	AppliedOn       string   `json:"applied_on"`
	Rating          *float64 `json:"rating,omitempty"`
	Notes           *string  `json:"notes,omitempty"`
	OutcomeReason   *string  `json:"outcome_reason,omitempty"`
	EmployeeID      *string  `json:"employee_id,omitempty"`
	EmployeeCode    *string  `json:"employee_code,omitempty"`
	// Days since anything happened to them. The number a recruiter manages by,
	// borrowed from the admissions funnel because it is the same failure: a
	// shortlisted teacher nobody has rung in three weeks has taken another job.
	DaysSinceMove int  `json:"days_since_move"`
	Interviews    int  `json:"interviews"`
	HasLiveOffer  bool `json:"has_live_offer"`
}

func (s *Server) listCandidates(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT c.id::text, c.vacancy_id::text, v.code, v.title,
		       c.full_name, c.email, c.phone, c.qualification,
		       c.experience_years::float8, c.current_employer,
		       c.expected_salary_paise, c.notice_period_days, c.source,
		       c.resume_file_id::text, c.stage, to_char(c.applied_on,'YYYY-MM-DD'),
		       c.rating::float8, c.notes, c.outcome_reason,
		       c.employee_id::text, e.employee_code,
		       EXTRACT(day FROM now() - c.stage_changed_at)::int,
		       (SELECT count(*) FROM job_interviews i WHERE i.candidate_id = c.id)::int,
		       EXISTS (SELECT 1 FROM job_offers o
		                WHERE o.candidate_id = c.id
		                  AND o.status IN ('draft','sent','accepted'))
		  FROM job_candidates c
		  JOIN job_vacancies v ON v.id = c.vacancy_id
		  LEFT JOIN employees e ON e.id = c.employee_id
		 WHERE ($1::uuid IS NULL OR c.vacancy_id = $1::uuid)
		   AND ($2::text IS NULL OR c.stage = $2)
		   AND ($3::bool IS NOT TRUE OR c.stage NOT IN ('joined','rejected','withdrawn'))
		 -- Whoever has been waiting longest, first.
		 ORDER BY (c.stage NOT IN ('joined','rejected','withdrawn')) DESC, c.stage_changed_at
		 LIMIT 500`,
		[]any{nullString(q.Get("vacancy_id")), nullString(q.Get("stage")),
			q.Get("open") == "true"},
		func(rows pgx.Rows) (candidateRow, error) {
			var v candidateRow
			return v, rows.Scan(&v.ID, &v.VacancyID, &v.VacancyCode, &v.VacancyTitle,
				&v.FullName, &v.Email, &v.Phone, &v.Qualification, &v.Experience,
				&v.CurrentEmployer, &v.ExpectedPaise, &v.NoticeDays, &v.Source,
				&v.ResumeFileID, &v.Stage, &v.AppliedOn, &v.Rating, &v.Notes,
				&v.OutcomeReason, &v.EmployeeID, &v.EmployeeCode,
				&v.DaysSinceMove, &v.Interviews, &v.HasLiveOffer)
		})
	respond(w, r, items, err)
}

type candidateRequest struct {
	ID              string   `json:"id,omitempty"`
	VacancyID       string   `json:"vacancy_id"`
	FullName        string   `json:"full_name"`
	Email           string   `json:"email,omitempty"`
	Phone           string   `json:"phone,omitempty"`
	Gender          string   `json:"gender,omitempty"`
	DateOfBirth     string   `json:"date_of_birth,omitempty"`
	Qualification   string   `json:"qualification,omitempty"`
	Experience      *float64 `json:"experience_years,omitempty"`
	CurrentEmployer string   `json:"current_employer,omitempty"`
	ExpectedPaise   *int64   `json:"expected_salary_paise,omitempty"`
	NoticeDays      *int     `json:"notice_period_days,omitempty"`
	Source          string   `json:"source,omitempty"`
	ResumeFileID    string   `json:"resume_file_id,omitempty"`
	Rating          *float64 `json:"rating,omitempty"`
	Notes           string   `json:"notes,omitempty"`
}

func (s *Server) saveCandidate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req candidateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.VacancyID == "" || strings.TrimSpace(req.FullName) == "" {
		httpx.BadRequest(w, r, "vacancy_id and full_name are required")
		return
	}
	if strings.TrimSpace(req.Email) == "" && strings.TrimSpace(req.Phone) == "" {
		httpx.BadRequest(w, r, "an email or a phone number is required")
		return
	}
	if req.Source == "" {
		req.Source = "direct"
	}

	var out string
	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		if req.ID != "" {
			out = req.ID
			tag, err := tx.Exec(r.Context(), `
				UPDATE job_candidates
				   SET full_name = $2, email = $3, phone = $4, gender = $5,
				       date_of_birth = $6::date, qualification = $7,
				       experience_years = $8, current_employer = $9,
				       expected_salary_paise = $10, notice_period_days = $11,
				       source = $12, resume_file_id = $13::uuid, rating = $14, notes = $15
				 WHERE id = $1::uuid`,
				req.ID, strings.TrimSpace(req.FullName), nullString(req.Email),
				nullString(req.Phone), nullString(req.Gender), nullString(req.DateOfBirth),
				nullString(req.Qualification), req.Experience,
				nullString(req.CurrentEmployer), req.ExpectedPaise, req.NoticeDays,
				req.Source, nullString(req.ResumeFileID), req.Rating, nullString(req.Notes))
			if err == nil && tag.RowsAffected() == 0 {
				return pgx.ErrNoRows
			}
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO job_candidates (institution_id, vacancy_id, full_name, email,
			        phone, gender, date_of_birth, qualification, experience_years,
			        current_employer, expected_salary_paise, notice_period_days,
			        source, resume_file_id, rating, notes)
			VALUES ($1,$2::uuid,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14::uuid,$15,$16)
			RETURNING id::text`,
			id.InstitutionID, req.VacancyID, strings.TrimSpace(req.FullName),
			nullString(req.Email), nullString(req.Phone), nullString(req.Gender),
			nullString(req.DateOfBirth), nullString(req.Qualification), req.Experience,
			nullString(req.CurrentEmployer), req.ExpectedPaise, req.NoticeDays,
			req.Source, nullString(req.ResumeFileID), req.Rating,
			nullString(req.Notes)).Scan(&out); err != nil {
			return err
		}
		return logCandidateEvent(r.Context(), tx, id.InstitutionID, out, "", "applied",
			"", id.UserID)
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

// logCandidateEvent writes one line of the candidate's history. Every stage
// change goes through here so "who rejected her, and when" is answerable
// months later, which a status column alone never is.
func logCandidateEvent(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	candidate, from, to, note string, actor uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO job_candidate_events (institution_id, candidate_id, from_stage,
		        to_stage, note, actor_user_id)
		VALUES ($1,$2::uuid,$3,$4,$5,$6)`,
		inst, candidate, nullString(from), to, nullString(note), actor)
	return err
}

type stageMoveRequest struct {
	Stage  string `json:"stage"`
	Note   string `json:"note,omitempty"`
	Reason string `json:"outcome_reason,omitempty"`
}

/*
moveCandidateStage advances or ends one candidacy.

	'joined' is deliberately not reachable here. A candidate becomes an
	employee through /hire, which creates the staff record in the same
	transaction; letting a status dropdown say "joined" would produce a hire
	that exists in recruitment and nowhere payroll can see, which is exactly
	the failure the joined-has-employee CHECK refuses at the table.
*/
func (s *Server) moveCandidateStage(w http.ResponseWriter, r *http.Request) {
	cand, ok := growthPathID(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req stageMoveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	switch req.Stage {
	case "applied", "screened", "shortlisted", "interviewed", "demo_lesson",
		"offered", "rejected", "withdrawn":
	case "joined":
		httpx.Error(w, r, http.StatusConflict, "use_hire",
			"a candidate joins by being hired, which creates their employee record; POST .../hire")
		return
	default:
		httpx.BadRequest(w, r, "unknown stage")
		return
	}

	var from string
	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		// The stage before the move, read in the same statement. A sub-SELECT
		// inside RETURNING would happen to give the old value under the
		// command's snapshot, which is exactly the kind of thing that is true
		// until it is not; a CTE says what it means.
		if err := tx.QueryRow(r.Context(), `
			WITH was AS (
			    SELECT stage FROM job_candidates WHERE id = $1 AND stage <> 'joined'
			), moved AS (
			    UPDATE job_candidates
			       SET stage = $2, stage_changed_at = now(),
			           outcome_reason = COALESCE($3, outcome_reason)
			     WHERE id = $1 AND stage <> 'joined'
			    RETURNING id
			)
			SELECT was.stage FROM was, moved`,
			cand, req.Stage, nullString(req.Reason)).Scan(&from); err != nil {
			return err
		}
		return logCandidateEvent(r.Context(), tx, id.InstitutionID, cand.String(),
			from, req.Stage, req.Note, id.UserID)
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": cand.String(), "stage": req.Stage})
}

type hireRequest struct {
	EmployeeCode string `json:"employee_code"`
	// Splitting the candidate's one name into two is the caller's job: a form
	// that guesses gets "Sai Kumar Reddy" wrong more often than not.
	FirstName      string `json:"first_name,omitempty"`
	LastName       string `json:"last_name,omitempty"`
	DepartmentID   string `json:"department_id,omitempty"`
	DesignationID  string `json:"designation_id,omitempty"`
	EmploymentType string `json:"employment_type,omitempty"`
	JoinedOn       string `json:"joined_on,omitempty"`
	CreateLogin    bool   `json:"create_login,omitempty"`
	RoleKey        string `json:"role_key,omitempty"`
	Note           string `json:"note,omitempty"`
}

/*
hireCandidate turns an accepted candidate into a member of staff.

	This is where the value and the risk are, so it does exactly three things
	in one transaction and refuses to do any of them twice:

	  the employee is created by appointEmployee, the same function the staff
	  screen calls. Not a second INSERT — two ways to create an employee is two
	  sets of defaults and, sooner or later, a hire payroll cannot see.

	  the candidate is marked joined and pointed at the employee. The row is
	  updated, never deleted or moved: it is the evidence for the appointment
	  and the only record of who else was considered, which matters when the
	  appointment is questioned.

	  the vacancy is closed if this hire filled the last position, and left
	  open if it did not.

	Already hired is a 409, not a second employee. The candidate's hired_at is
	checked inside the transaction, so two clicks a second apart cannot both
	pass it.
*/
func (s *Server) hireCandidate(w http.ResponseWriter, r *http.Request) {
	cand, ok := growthPathID(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req hireRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.EmployeeCode) == "" {
		httpx.BadRequest(w, r, "employee_code is required")
		return
	}

	var empID, userID, vacancy string
	var closed bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var name, email, phone string
		var already *string
		var designation, department *string
		if err := tx.QueryRow(r.Context(), `
			SELECT c.full_name, COALESCE(c.email,''), COALESCE(c.phone,''),
			       c.employee_id::text, c.vacancy_id::text,
			       COALESCE(o.designation_id, v.designation_id)::text,
			       COALESCE(o.department_id,  v.department_id)::text
			  FROM job_candidates c
			  JOIN job_vacancies v ON v.id = c.vacancy_id
			  LEFT JOIN job_offers o ON o.candidate_id = c.id AND o.status = 'accepted'
			 WHERE c.id = $1
			 FOR UPDATE OF c`, cand).
			Scan(&name, &email, &phone, &already, &vacancy, &designation, &department); err != nil {
			return err
		}
		if already != nil {
			return errAlreadyHired
		}

		first, last := req.FirstName, req.LastName
		if first == "" {
			first, last = splitPersonName(name)
		}
		appointment := employeeRequest{
			EmployeeCode:   strings.TrimSpace(req.EmployeeCode),
			FirstName:      first,
			LastName:       last,
			Email:          email,
			Phone:          phone,
			Department:     firstNonEmpty(req.DepartmentID, deref(department)),
			Designation:    firstNonEmpty(req.DesignationID, deref(designation)),
			JoinedOn:       req.JoinedOn,
			EmploymentType: req.EmploymentType,
			CreateLogin:    req.CreateLogin,
			RoleKey:        req.RoleKey,
		}
		if err := appointment.validate(); err != nil {
			return err
		}
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if empID, userID, err = appointEmployee(r.Context(), tx,
			id.InstitutionID, campus, appointment); err != nil {
			return err
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE job_candidates
			   SET stage = 'joined', stage_changed_at = now(),
			       employee_id = $2::uuid, hired_at = now()
			 WHERE id = $1`, cand, empID); err != nil {
			return err
		}
		if err := logCandidateEvent(r.Context(), tx, id.InstitutionID, cand.String(),
			"offered", "joined", req.Note, id.UserID); err != nil {
			return err
		}

		// Filled means every position taken, not "somebody joined". A school
		// hiring three PRTs against one requisition still has two to find.
		return tx.QueryRow(r.Context(), `
			UPDATE job_vacancies v
			   SET status = CASE
			         WHEN (SELECT count(*) FROM job_candidates c
			                WHERE c.vacancy_id = v.id AND c.stage = 'joined') >= v.positions
			         THEN 'filled' ELSE v.status END
			 WHERE v.id = $1
			RETURNING v.status = 'filled'`, vacancy).Scan(&closed)
	})
	switch {
	case errors.Is(err, errAlreadyHired):
		httpx.Error(w, r, http.StatusConflict, "already_hired",
			"this candidate has already been appointed")
		return
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			httpx.Error(w, r, http.StatusConflict, "duplicate",
				"that employee code is already in use")
			return
		}
		if strings.Contains(err.Error(), "required") {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"employee_id": empID, "user_id": nullOrString(userID),
		"candidate_id": cand.String(), "vacancy_filled": closed,
	})
}

var errAlreadyHired = errors.New("candidate already hired")

// splitPersonName takes the last whitespace-separated word as the surname,
// which is right for most of India and wrong for enough of it that the hire
// form lets the caller override it.
func splitPersonName(full string) (string, string) {
	parts := strings.Fields(full)
	switch len(parts) {
	case 0:
		return full, ""
	case 1:
		return parts[0], ""
	default:
		return strings.Join(parts[:len(parts)-1], " "), parts[len(parts)-1]
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

type interviewRow struct {
	ID          string   `json:"id"`
	CandidateID string   `json:"candidate_id"`
	Candidate   string   `json:"candidate"`
	VacancyCode string   `json:"vacancy_code"`
	Round       string   `json:"round"`
	ScheduledAt *string  `json:"scheduled_at,omitempty"`
	Mode        string   `json:"mode"`
	Section     *string  `json:"section,omitempty"`
	Subject     *string  `json:"subject,omitempty"`
	Venue       *string  `json:"venue,omitempty"`
	Panel       []string `json:"panel"`
	Result      string   `json:"result"`
	Score       *float64 `json:"score,omitempty"`
	Remarks     *string  `json:"remarks,omitempty"`
}

func (s *Server) listInterviews(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT i.id::text, i.candidate_id::text, c.full_name, v.code, i.round,
		       to_char(i.scheduled_at,'YYYY-MM-DD"T"HH24:MI'), i.mode,
		       concat_ws(' ', cl.name, sec.name), sub.name, i.venue,
		       COALESCE((SELECT array_agg(u.full_name ORDER BY u.full_name)
		                   FROM users u WHERE u.id = ANY(i.panel_user_ids)), '{}'),
		       i.result, i.score::float8, i.remarks
		  FROM job_interviews i
		  JOIN job_candidates c ON c.id = i.candidate_id
		  JOIN job_vacancies  v ON v.id = c.vacancy_id
		  LEFT JOIN sections sec ON sec.id = i.section_id
		  LEFT JOIN classes  cl  ON cl.id  = sec.class_id
		  LEFT JOIN subjects sub ON sub.id = i.subject_id
		 WHERE ($1::uuid IS NULL OR i.candidate_id = $1::uuid)
		   AND ($2::bool IS NOT TRUE OR i.result = 'scheduled')
		 ORDER BY i.scheduled_at NULLS LAST
		 LIMIT 300`,
		[]any{nullString(q.Get("candidate_id")), q.Get("upcoming") == "true"},
		func(rows pgx.Rows) (interviewRow, error) {
			var v interviewRow
			return v, rows.Scan(&v.ID, &v.CandidateID, &v.Candidate, &v.VacancyCode,
				&v.Round, &v.ScheduledAt, &v.Mode, &v.Section, &v.Subject, &v.Venue,
				&v.Panel, &v.Result, &v.Score, &v.Remarks)
		})
	respond(w, r, items, err)
}

type interviewRequest struct {
	CandidateID string   `json:"candidate_id"`
	Round       string   `json:"round"`
	ScheduledAt string   `json:"scheduled_at,omitempty"`
	Mode        string   `json:"mode,omitempty"`
	SectionID   string   `json:"section_id,omitempty"`
	SubjectID   string   `json:"subject_id,omitempty"`
	Venue       string   `json:"venue,omitempty"`
	PanelUsers  []string `json:"panel_user_ids,omitempty"`
}

func (s *Server) scheduleInterview(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req interviewRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.CandidateID == "" || req.Round == "" {
		httpx.BadRequest(w, r, "candidate_id and round are required")
		return
	}
	if req.Mode == "" {
		req.Mode = "in_person"
	}
	panel := make([]uuid.UUID, 0, len(req.PanelUsers))
	for _, p := range req.PanelUsers {
		u, err := uuid.Parse(p)
		if err != nil {
			httpx.BadRequest(w, r, "panel_user_ids must be uuids")
			return
		}
		panel = append(panel, u)
	}

	var out string
	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO job_interviews (institution_id, candidate_id, round,
			        scheduled_at, mode, section_id, subject_id, venue, panel_user_ids)
			VALUES ($1,$2::uuid,$3,$4::timestamptz,$5,$6::uuid,$7::uuid,$8,$9)
			RETURNING id::text`,
			id.InstitutionID, req.CandidateID, req.Round, nullString(req.ScheduledAt),
			req.Mode, nullString(req.SectionID), nullString(req.SubjectID),
			nullString(req.Venue), panel).Scan(&out)
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

type interviewResultRequest struct {
	Result  string   `json:"result"`
	Score   *float64 `json:"score,omitempty"`
	Remarks string   `json:"remarks,omitempty"`
	// Move the candidate on in the same breath. Recording a demo lesson and
	// then forgetting to advance the candidate is how a shortlist goes stale.
	AdvanceTo string `json:"advance_to,omitempty"`
}

func (s *Server) recordInterviewResult(w http.ResponseWriter, r *http.Request) {
	iv, ok := growthPathID(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req interviewResultRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	switch req.Result {
	case "pass", "fail", "hold", "no_show", "cancelled":
	default:
		httpx.BadRequest(w, r, "result must be pass, fail, hold, no_show or cancelled")
		return
	}
	if req.AdvanceTo == "joined" {
		httpx.Error(w, r, http.StatusConflict, "use_hire",
			"a candidate joins by being hired; POST .../hire")
		return
	}

	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		var cand, from string
		if err := tx.QueryRow(r.Context(), `
			UPDATE job_interviews
			   SET result = $2, score = $3, remarks = $4,
			       recorded_by = $5, recorded_at = now()
			 WHERE id = $1
			RETURNING candidate_id::text,
			          (SELECT c.stage FROM job_candidates c WHERE c.id = job_interviews.candidate_id)`,
			iv, req.Result, req.Score, nullString(req.Remarks), id.UserID).
			Scan(&cand, &from); err != nil {
			return err
		}
		if req.AdvanceTo == "" {
			return nil
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE job_candidates SET stage = $2, stage_changed_at = now()
			 WHERE id = $1::uuid AND stage <> 'joined'`, cand, req.AdvanceTo); err != nil {
			return err
		}
		return logCandidateEvent(r.Context(), tx, id.InstitutionID, cand, from,
			req.AdvanceTo, req.Remarks, id.UserID)
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": iv.String(), "result": req.Result})
}

type offerRow struct {
	ID           string  `json:"id"`
	CandidateID  string  `json:"candidate_id"`
	Candidate    string  `json:"candidate"`
	VacancyCode  string  `json:"vacancy_code"`
	OfferedOn    string  `json:"offered_on"`
	Designation  *string `json:"designation,omitempty"`
	Department   *string `json:"department,omitempty"`
	GrossPaise   int64   `json:"gross_monthly_paise"`
	JoiningOn    *string `json:"joining_on,omitempty"`
	ValidUntil   *string `json:"valid_until,omitempty"`
	Status       string  `json:"status"`
	RespondedOn  *string `json:"responded_on,omitempty"`
	ResponseNote *string `json:"response_note,omitempty"`
	OfferFileID  *string `json:"offer_file_id,omitempty"`
	// A letter nobody answered and whose date has gone. The recruiter's queue.
	Lapsed bool `json:"lapsed"`
}

func (s *Server) listOffers(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT o.id::text, o.candidate_id::text, c.full_name, v.code,
		       to_char(o.offered_on,'YYYY-MM-DD'), g.name, d.name,
		       o.gross_monthly_paise, to_char(o.joining_on,'YYYY-MM-DD'),
		       to_char(o.valid_until,'YYYY-MM-DD'), o.status,
		       to_char(o.responded_on,'YYYY-MM-DD'), o.response_note,
		       o.offer_file_id::text,
		       o.status = 'sent' AND o.valid_until IS NOT NULL AND o.valid_until < current_date
		  FROM job_offers o
		  JOIN job_candidates c ON c.id = o.candidate_id
		  JOIN job_vacancies  v ON v.id = c.vacancy_id
		  LEFT JOIN designations g ON g.id = o.designation_id
		  LEFT JOIN departments  d ON d.id = o.department_id
		 WHERE ($1::uuid IS NULL OR o.candidate_id = $1::uuid)
		 ORDER BY o.offered_on DESC
		 LIMIT 300`, []any{nullString(r.URL.Query().Get("candidate_id"))},
		func(rows pgx.Rows) (offerRow, error) {
			var v offerRow
			return v, rows.Scan(&v.ID, &v.CandidateID, &v.Candidate, &v.VacancyCode,
				&v.OfferedOn, &v.Designation, &v.Department, &v.GrossPaise,
				&v.JoiningOn, &v.ValidUntil, &v.Status, &v.RespondedOn,
				&v.ResponseNote, &v.OfferFileID, &v.Lapsed)
		})
	respond(w, r, items, err)
}

type offerRequest struct {
	CandidateID    string `json:"candidate_id"`
	DesignationID  string `json:"designation_id,omitempty"`
	DepartmentID   string `json:"department_id,omitempty"`
	EmploymentType string `json:"employment_type,omitempty"`
	// Paise per month. Never rupees, and never a float: an offer letter that
	// disagrees with payroll by a paisa is an argument nobody wins.
	GrossPaise  int64  `json:"gross_monthly_paise"`
	JoiningOn   string `json:"joining_on,omitempty"`
	ValidUntil  string `json:"valid_until,omitempty"`
	OfferFileID string `json:"offer_file_id,omitempty"`
	Send        bool   `json:"send,omitempty"`
}

func (s *Server) makeOffer(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req offerRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.CandidateID == "" {
		httpx.BadRequest(w, r, "candidate_id is required")
		return
	}
	if req.GrossPaise <= 0 {
		httpx.BadRequest(w, r, "gross_monthly_paise must be a positive number of paise")
		return
	}
	status := "draft"
	if req.Send {
		status = "sent"
	}

	var out string
	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO job_offers (institution_id, candidate_id, designation_id,
			        department_id, employment_type, gross_monthly_paise, joining_on,
			        valid_until, offer_file_id, status, issued_by)
			VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::date,$8::date,$9::uuid,$10,$11)
			RETURNING id::text`,
			id.InstitutionID, req.CandidateID, nullString(req.DesignationID),
			nullString(req.DepartmentID), nullString(req.EmploymentType), req.GrossPaise,
			nullString(req.JoiningOn), nullString(req.ValidUntil),
			nullString(req.OfferFileID), status, id.UserID).Scan(&out); err != nil {
			return err
		}
		if !req.Send {
			return nil
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE job_candidates SET stage = 'offered', stage_changed_at = now()
			 WHERE id = $1::uuid AND stage <> 'joined'`, req.CandidateID); err != nil {
			return err
		}
		return logCandidateEvent(r.Context(), tx, id.InstitutionID, req.CandidateID,
			"", "offered", "offer issued", id.UserID)
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "status": status})
}

type offerResponseRequest struct {
	Status string `json:"status"` // accepted | declined | withdrawn | expired
	Note   string `json:"note,omitempty"`
}

func (s *Server) recordOfferResponse(w http.ResponseWriter, r *http.Request) {
	off, ok := growthPathID(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req offerResponseRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	switch req.Status {
	case "accepted", "declined", "withdrawn", "expired":
	default:
		httpx.BadRequest(w, r, "status must be accepted, declined, withdrawn or expired")
		return
	}

	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		var cand string
		if err := tx.QueryRow(r.Context(), `
			UPDATE job_offers
			   SET status = $2, responded_on = current_date, response_note = $3
			 WHERE id = $1
			RETURNING candidate_id::text`,
			off, req.Status, nullString(req.Note)).Scan(&cand); err != nil {
			return err
		}
		// A declined offer sends the candidate back to the pool rather than
		// out of it: schools re-approach a good teacher the following term.
		if req.Status == "declined" || req.Status == "expired" {
			if _, err := tx.Exec(r.Context(), `
				UPDATE job_candidates
				   SET stage = 'withdrawn', stage_changed_at = now(),
				       outcome_reason = COALESCE(outcome_reason, 'offer ' || $2)
				 WHERE id = $1::uuid AND stage = 'offered'`, cand, req.Status); err != nil {
				return err
			}
		}
		return logCandidateEvent(r.Context(), tx, id.InstitutionID, cand, "offered",
			"offer_"+req.Status, req.Note, id.UserID)
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": off.String(), "status": req.Status})
}

type funnelStageRow struct {
	Stage string `json:"stage"`
	Count int    `json:"count"`
	// Median days a candidate has been sitting at this stage. A funnel that
	// only counts heads cannot tell a full shortlist from a stalled one.
	MedianDaysWaiting *float64 `json:"median_days_waiting,omitempty"`
}

// getRecruitmentFunnel counts the pipeline. Deliberately not a second copy of
// admissions_funnel's getAdmissionsFunnel: the shape is the same and the
// subject is not, and joining candidates to applications would be nonsense.
func (s *Server) getRecruitmentFunnel(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT c.stage, count(*)::int,
		       percentile_cont(0.5) WITHIN GROUP (
		           ORDER BY EXTRACT(day FROM now() - c.stage_changed_at))::float8
		  FROM job_candidates c
		  JOIN job_vacancies v ON v.id = c.vacancy_id
		 WHERE ($1::uuid IS NULL OR c.vacancy_id = $1::uuid)
		 GROUP BY c.stage
		 ORDER BY array_position(
		     ARRAY['applied','screened','shortlisted','interviewed','demo_lesson',
		           'offered','joined','rejected','withdrawn'], c.stage)`,
		[]any{nullString(r.URL.Query().Get("vacancy_id"))},
		func(rows pgx.Rows) (funnelStageRow, error) {
			var v funnelStageRow
			return v, rows.Scan(&v.Stage, &v.Count, &v.MedianDaysWaiting)
		})
	respond(w, r, items, err)
}

// ===========================================================================
// hr.hiring_growth.annual_performance_appraisal_kpi
// ===========================================================================

type appraisalCycleRow struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	AcademicYear *string `json:"academic_year,omitempty"`
	Status       string  `json:"status"`
	OpensOn      *string `json:"opens_on,omitempty"`
	SelfDueOn    *string `json:"self_due_on,omitempty"`
	ReviewDueOn  *string `json:"review_due_on,omitempty"`
	ClosesOn     *string `json:"closes_on,omitempty"`
	ScaleMax     float64 `json:"score_scale_max"`
	Allow360     bool    `json:"allow_360_input"`
	Appraisals   int     `json:"appraisals"`
	Published    int     `json:"published"`
	// Roles whose KPI weights do not total 100. Surfaced on the cycle because
	// the database refuses to raise an appraisal against such a set, and a
	// cycle that cannot be started should say so before anybody tries.
	UnbalancedRoles int `json:"unbalanced_roles"`
}

func (s *Server) listAppraisalCycles(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT c.id::text, c.name, y.name, c.status,
		       to_char(c.opens_on,'YYYY-MM-DD'), to_char(c.self_due_on,'YYYY-MM-DD'),
		       to_char(c.review_due_on,'YYYY-MM-DD'), to_char(c.closes_on,'YYYY-MM-DD'),
		       c.score_scale_max::float8, c.allow_360_input,
		       (SELECT count(*) FROM appraisals a WHERE a.cycle_id = c.id)::int,
		       (SELECT count(*) FROM appraisals a WHERE a.cycle_id = c.id
		         AND a.status IN ('published','acknowledged'))::int,
		       (SELECT count(*) FROM (
		            SELECT DISTINCT k.designation_id FROM appraisal_kpis k
		             WHERE k.cycle_id = c.id) roles
		         WHERE appraisal_weights_total(c.id, roles.designation_id) <> 100)::int
		  FROM appraisal_cycles c
		  LEFT JOIN academic_years y ON y.id = c.academic_year_id
		 ORDER BY COALESCE(c.opens_on, c.created_at::date) DESC
		 LIMIT 100`, nil,
		func(rows pgx.Rows) (appraisalCycleRow, error) {
			var v appraisalCycleRow
			return v, rows.Scan(&v.ID, &v.Name, &v.AcademicYear, &v.Status, &v.OpensOn,
				&v.SelfDueOn, &v.ReviewDueOn, &v.ClosesOn, &v.ScaleMax, &v.Allow360,
				&v.Appraisals, &v.Published, &v.UnbalancedRoles)
		})
	respond(w, r, items, err)
}

type appraisalCycleRequest struct {
	ID             string   `json:"id,omitempty"`
	Name           string   `json:"name"`
	AcademicYearID string   `json:"academic_year_id,omitempty"`
	Status         string   `json:"status,omitempty"`
	OpensOn        string   `json:"opens_on,omitempty"`
	SelfDueOn      string   `json:"self_due_on,omitempty"`
	ReviewDueOn    string   `json:"review_due_on,omitempty"`
	ClosesOn       string   `json:"closes_on,omitempty"`
	ScaleMax       *float64 `json:"score_scale_max,omitempty"`
	Allow360       bool     `json:"allow_360_input,omitempty"`
}

func (s *Server) saveAppraisalCycle(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req appraisalCycleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "name is required")
		return
	}
	if req.Status == "" {
		req.Status = "draft"
	}
	scale := 5.0
	if req.ScaleMax != nil && *req.ScaleMax > 0 {
		scale = *req.ScaleMax
	}

	var out string
	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		if req.ID != "" {
			out = req.ID
			_, err := tx.Exec(r.Context(), `
				UPDATE appraisal_cycles
				   SET name = $2, academic_year_id = $3::uuid, status = $4,
				       opens_on = $5::date, self_due_on = $6::date,
				       review_due_on = $7::date, closes_on = $8::date,
				       score_scale_max = $9, allow_360_input = $10
				 WHERE id = $1::uuid`,
				req.ID, req.Name, nullString(req.AcademicYearID), req.Status,
				nullString(req.OpensOn), nullString(req.SelfDueOn),
				nullString(req.ReviewDueOn), nullString(req.ClosesOn), scale, req.Allow360)
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO appraisal_cycles (institution_id, academic_year_id, name, status,
			        opens_on, self_due_on, review_due_on, closes_on, score_scale_max,
			        allow_360_input, created_by)
			VALUES ($1,$2::uuid,$3,$4,$5::date,$6::date,$7::date,$8::date,$9,$10,$11)
			RETURNING id::text`,
			id.InstitutionID, nullString(req.AcademicYearID), req.Name, req.Status,
			nullString(req.OpensOn), nullString(req.SelfDueOn), nullString(req.ReviewDueOn),
			nullString(req.ClosesOn), scale, req.Allow360, id.UserID).Scan(&out)
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

type appraisalKPIRow struct {
	ID            string  `json:"id"`
	CycleID       string  `json:"cycle_id"`
	DesignationID *string `json:"designation_id,omitempty"`
	Designation   *string `json:"designation,omitempty"`
	Code          string  `json:"code"`
	Title         string  `json:"title"`
	Description   *string `json:"description,omitempty"`
	Weight        float64 `json:"weight"`
	Sequence      int     `json:"sequence"`
	Source        string  `json:"source"`
}

func (s *Server) listAppraisalKPIs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("cycle_id") == "" {
		httpx.BadRequest(w, r, "cycle_id is required")
		return
	}
	items, err := collect(s, r, `
		SELECT k.id::text, k.cycle_id::text, k.designation_id::text, g.name,
		       k.code, k.title, k.description, k.weight::float8, k.sequence, k.source
		  FROM appraisal_kpis k
		  LEFT JOIN designations g ON g.id = k.designation_id
		 WHERE k.cycle_id = $1::uuid
		   AND ($2::text IS NULL OR
		        k.designation_id IS NOT DISTINCT FROM NULLIF($2,'')::uuid)
		 ORDER BY g.name NULLS FIRST, k.sequence, k.code`,
		[]any{q.Get("cycle_id"), nullString(q.Get("designation_id"))},
		func(rows pgx.Rows) (appraisalKPIRow, error) {
			var v appraisalKPIRow
			return v, rows.Scan(&v.ID, &v.CycleID, &v.DesignationID, &v.Designation,
				&v.Code, &v.Title, &v.Description, &v.Weight, &v.Sequence, &v.Source)
		})
	respond(w, r, items, err)
}

type appraisalKPIItem struct {
	Code        string  `json:"code"`
	Title       string  `json:"title"`
	Description string  `json:"description,omitempty"`
	Weight      float64 `json:"weight"`
	Source      string  `json:"source,omitempty"`
}

type appraisalKPISetRequest struct {
	CycleID string `json:"cycle_id"`
	// Empty means the default set — what a role with no set of its own is
	// appraised against.
	DesignationID string             `json:"designation_id,omitempty"`
	KPIs          []appraisalKPIItem `json:"kpis"`
}

/*
saveAppraisalKPIs replaces the whole KPI set for one role in one cycle.

	A whole-set write rather than a per-row one, because the invariant is about
	the set: the weights must total exactly 100. Editing one row at a time
	means every intermediate state is invalid, and validating each write in
	isolation is how a set ends up at 97 with nobody able to say which row is
	wrong.

	The total is checked here and again in the database, which refuses to raise
	an appraisal against a set that does not reach 100. Two checks rather than
	one because this handler is not the only way rows arrive — an import is
	not going to call it — and because a 400 naming the actual total is a far
	better answer than a constraint violation three screens later.
*/
func (s *Server) saveAppraisalKPIs(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req appraisalKPISetRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.CycleID == "" || len(req.KPIs) == 0 {
		httpx.BadRequest(w, r, "cycle_id and at least one KPI are required")
		return
	}
	total, seen := 0.0, map[string]bool{}
	for _, k := range req.KPIs {
		if strings.TrimSpace(k.Code) == "" || strings.TrimSpace(k.Title) == "" {
			httpx.BadRequest(w, r, "every KPI needs a code and a title")
			return
		}
		lc := strings.ToLower(strings.TrimSpace(k.Code))
		if seen[lc] {
			httpx.BadRequest(w, r, "duplicate KPI code: "+k.Code)
			return
		}
		seen[lc] = true
		if k.Weight <= 0 || k.Weight > 100 {
			httpx.BadRequest(w, r, "every weight must be between 0 and 100")
			return
		}
		total += k.Weight
	}
	// A hundredth of a percent of slack, because 33.33 three times is 99.99
	// and refusing that would make thirds unusable.
	if total < 99.99 || total > 100.01 {
		httpx.BadRequest(w, r, fmt.Sprintf(
			"the weights total %.2f; an appraisal set must total 100", total))
		return
	}

	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		// Replace, not merge. A KPI dropped from the set has to disappear or
		// the total is right on the screen and wrong in the table.
		if _, err := tx.Exec(r.Context(), `
			DELETE FROM appraisal_kpis
			 WHERE cycle_id = $1::uuid
			   AND designation_id IS NOT DISTINCT FROM NULLIF($2,'')::uuid`,
			req.CycleID, req.DesignationID); err != nil {
			return err
		}
		for i, k := range req.KPIs {
			source := k.Source
			if source == "" {
				source = "reviewer"
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO appraisal_kpis (institution_id, cycle_id, designation_id,
				        code, title, description, weight, sequence, source)
				VALUES ($1,$2::uuid,NULLIF($3,'')::uuid,$4,$5,$6,$7,$8,$9)`,
				id.InstitutionID, req.CycleID, req.DesignationID,
				strings.TrimSpace(k.Code), strings.TrimSpace(k.Title),
				nullString(k.Description), k.Weight, (i+1)*10, source); err != nil {
				return err
			}
		}
		return nil
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"kpis": len(req.KPIs), "weight_total": total})
}

type appraisalRow struct {
	ID           string   `json:"id"`
	CycleID      string   `json:"cycle_id"`
	Cycle        string   `json:"cycle"`
	EmployeeID   string   `json:"employee_id"`
	EmployeeCode string   `json:"employee_code"`
	FullName     string   `json:"full_name"`
	Designation  *string  `json:"designation,omitempty"`
	Department   *string  `json:"department,omitempty"`
	Reviewer     *string  `json:"reviewer,omitempty"`
	Moderator    *string  `json:"moderator,omitempty"`
	Status       string   `json:"status"`
	SelfScore    *float64 `json:"self_score,omitempty"`
	ReviewScore  *float64 `json:"reviewer_score,omitempty"`
	ModScore     *float64 `json:"moderated_score,omitempty"`
	FinalScore   *float64 `json:"final_score,omitempty"`
	FinalBand    *string  `json:"final_band,omitempty"`
	ScaleMax     float64  `json:"score_scale_max"`
	DiscussionOn *string  `json:"discussion_on,omitempty"`
	IncrementPct *float64 `json:"increment_percent,omitempty"`
	PublishedAt  *string  `json:"published_at,omitempty"`
	Acknowledged bool     `json:"acknowledged"`
}

const appraisalSelect = `
	SELECT a.id::text, a.cycle_id::text, cy.name, a.employee_id::text,
	       e.employee_code, concat_ws(' ', e.first_name, e.last_name),
	       g.name, d.name, ru.full_name, mu.full_name, a.status,
	       a.self_score::float8, a.reviewer_score::float8, a.moderated_score::float8,
	       a.final_score::float8, a.final_band, cy.score_scale_max::float8,
	       to_char(a.discussion_on,'YYYY-MM-DD'), a.increment_percent::float8,
	       to_char(a.published_at,'YYYY-MM-DD'), a.acknowledged_at IS NOT NULL
	  FROM appraisals a
	  JOIN appraisal_cycles cy ON cy.id = a.cycle_id
	  JOIN employees e ON e.id = a.employee_id
	  LEFT JOIN designations g ON g.id = a.designation_id
	  LEFT JOIN departments  d ON d.id = e.department_id
	  LEFT JOIN users ru ON ru.id = a.reviewer_user_id
	  LEFT JOIN users mu ON mu.id = a.moderator_user_id`

func scanAppraisal(rows pgx.Rows) (appraisalRow, error) {
	var v appraisalRow
	return v, rows.Scan(&v.ID, &v.CycleID, &v.Cycle, &v.EmployeeID, &v.EmployeeCode,
		&v.FullName, &v.Designation, &v.Department, &v.Reviewer, &v.Moderator,
		&v.Status, &v.SelfScore, &v.ReviewScore, &v.ModScore, &v.FinalScore,
		&v.FinalBand, &v.ScaleMax, &v.DiscussionOn, &v.IncrementPct,
		&v.PublishedAt, &v.Acknowledged)
}

/*
listAppraisals is scoped on the server, not by the screen.

	An appraisal score is the most sensitive number HR holds after pay, and
	hr.employees.read alone is held by a head of department, a vice principal
	and an examinations controller. So the rows are cut by growthReach: the
	back office sees the institution, a head of department their department, a
	named reviewer their reviewees, and everybody else themselves. Hiding the
	menu item would not have been access control.
*/
func (s *Server) listAppraisals(w http.ResponseWriter, r *http.Request) {
	re, err := s.growthReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	q := r.URL.Query()
	args := []any{nullString(q.Get("cycle_id")), nullString(q.Get("status"))}
	pred, extra := re.appraisalFilter("e", "a", len(args)+1)
	args = append(args, extra...)

	items, err := collect(s, r, appraisalSelect+`
		 WHERE ($1::uuid IS NULL OR a.cycle_id = $1::uuid)
		   AND ($2::text IS NULL OR a.status = $2)
		   AND `+pred+`
		 ORDER BY e.employee_code
		 LIMIT 500`, args, scanAppraisal)
	respond(w, r, items, err)
}

type appraisalRatingRow struct {
	ID          string   `json:"id"`
	KPIID       string   `json:"kpi_id"`
	Code        string   `json:"code"`
	Title       string   `json:"title"`
	Description *string  `json:"description,omitempty"`
	Source      string   `json:"source"`
	Weight      float64  `json:"weight"`
	SelfScore   *float64 `json:"self_score,omitempty"`
	SelfNote    *string  `json:"self_note,omitempty"`
	RevScore    *float64 `json:"reviewer_score,omitempty"`
	RevNote     *string  `json:"reviewer_note,omitempty"`
	ModScore    *float64 `json:"moderated_score,omitempty"`
}

type appraisalDetail struct {
	appraisalRow
	SelfComments     *string              `json:"self_comments,omitempty"`
	ReviewerComments *string              `json:"reviewer_comments,omitempty"`
	ModerationNote   *string              `json:"moderation_note,omitempty"`
	DiscussionNote   *string              `json:"discussion_note,omitempty"`
	EmployeeComments *string              `json:"employee_comments,omitempty"`
	IncrementPaise   *int64               `json:"increment_paise,omitempty"`
	External360      *string              `json:"external_360_source,omitempty"`
	External360Score *float64             `json:"external_360_score,omitempty"`
	Ratings          []appraisalRatingRow `json:"ratings"`
}

func (s *Server) getAppraisal(w http.ResponseWriter, r *http.Request) {
	app, ok := growthPathID(w, r)
	if !ok {
		return
	}
	re, err := s.growthReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	args := []any{app}
	pred, extra := re.appraisalFilter("e", "a", 2)
	args = append(args, extra...)
	s.renderAppraisal(w, r, appraisalSelect+" WHERE a.id = $1 AND "+pred, args)
}

// renderAppraisal answers one appraisal with its per-KPI ratings, or 404 when
// the caller's scope excludes it. 404 rather than 403 on purpose: telling a
// teacher "that appraisal exists but is not yours" leaks that it exists.
func (s *Server) renderAppraisal(w http.ResponseWriter, r *http.Request, sql string, args []any) {
	id := httpx.IdentityFrom(r.Context())
	var out appraisalDetail
	out.Ratings = []appraisalRatingRow{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), sql, args...)
		if err != nil {
			return err
		}
		found := false
		for rows.Next() {
			v, err := scanAppraisal(rows)
			if err != nil {
				rows.Close()
				return err
			}
			out.appraisalRow, found = v, true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if !found {
			return pgx.ErrNoRows
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT a.self_comments, a.reviewer_comments, a.moderation_note,
			       a.discussion_note, a.employee_comments, a.increment_paise,
			       a.external_360_source, a.external_360_score::float8
			  FROM appraisals a WHERE a.id = $1`, out.ID).
			Scan(&out.SelfComments, &out.ReviewerComments, &out.ModerationNote,
				&out.DiscussionNote, &out.EmployeeComments, &out.IncrementPaise,
				&out.External360, &out.External360Score); err != nil {
			return err
		}

		rrows, err := tx.Query(r.Context(), `
			SELECT rt.id::text, k.id::text, k.code, k.title, k.description, k.source,
			       rt.weight::float8, rt.self_score::float8, rt.self_note,
			       rt.reviewer_score::float8, rt.reviewer_note, rt.moderated_score::float8
			  FROM appraisal_ratings rt
			  JOIN appraisal_kpis k ON k.id = rt.kpi_id
			 WHERE rt.appraisal_id = $1
			 ORDER BY k.sequence, k.code`, out.ID)
		if err != nil {
			return err
		}
		defer rrows.Close()
		for rrows.Next() {
			var v appraisalRatingRow
			if err := rrows.Scan(&v.ID, &v.KPIID, &v.Code, &v.Title, &v.Description,
				&v.Source, &v.Weight, &v.SelfScore, &v.SelfNote, &v.RevScore,
				&v.RevNote, &v.ModScore); err != nil {
				return err
			}
			out.Ratings = append(out.Ratings, v)
		}
		return rrows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

type raiseAppraisalsRequest struct {
	CycleID string `json:"cycle_id"`
	// Empty means every active employee. A cycle is normally raised for the
	// whole school at once, and naming two hundred ids in a form is not a
	// workflow anybody completes.
	EmployeeIDs     []string `json:"employee_ids,omitempty"`
	DepartmentID    string   `json:"department_id,omitempty"`
	ReviewerUserID  string   `json:"reviewer_user_id,omitempty"`
	ModeratorUserID string   `json:"moderator_user_id,omitempty"`
}

/*
raiseAppraisals opens the cycle for a set of staff.

	Each appraisal is created with its own reviewer, its designation
	snapshotted, and a rating row per KPI carrying the weight as it stands
	today. The weight is copied rather than joined so that editing the cycle
	next month cannot silently restate a score somebody has already signed.

	The database refuses any appraisal whose role's weights do not total 100.
	That refusal is reported per employee rather than failing the whole batch,
	because "43 raised, 6 skipped because the accountant's KPIs total 90" is
	an answer somebody can act on and "500" is not.
*/
func (s *Server) raiseAppraisals(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req raiseAppraisalsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.CycleID == "" {
		httpx.BadRequest(w, r, "cycle_id is required")
		return
	}

	type skip struct {
		Employee string `json:"employee"`
		Reason   string `json:"reason"`
	}
	raised, skipped := 0, []skip{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT e.id::text, e.employee_code,
			       concat_ws(' ', e.first_name, e.last_name), e.designation_id::text
			  FROM employees e
			 WHERE e.status = 'active'
			   AND ($1::uuid[] IS NULL OR e.id = ANY($1::uuid[]))
			   AND ($2::uuid IS NULL OR e.department_id = $2::uuid)
			 ORDER BY e.employee_code`,
			nullUUIDTextSlice(req.EmployeeIDs), nullString(req.DepartmentID))
		if err != nil {
			return err
		}
		type staff struct {
			id, code, name string
			desig          *string
		}
		var list []staff
		for rows.Next() {
			var v staff
			if err := rows.Scan(&v.id, &v.code, &v.name, &v.desig); err != nil {
				rows.Close()
				return err
			}
			list = append(list, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, p := range list {
			// A savepoint per employee: the weight trigger aborts the
			// transaction, and without one the first unbalanced role would
			// take the whole batch down with it.
			if _, err := tx.Exec(r.Context(), "SAVEPOINT raise_one"); err != nil {
				return err
			}
			var appID string
			err := tx.QueryRow(r.Context(), `
				INSERT INTO appraisals (institution_id, cycle_id, employee_id,
				        designation_id, reviewer_user_id, moderator_user_id)
				VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid)
				ON CONFLICT (cycle_id, employee_id) DO NOTHING
				RETURNING id::text`,
				id.InstitutionID, req.CycleID, p.id, p.desig,
				nullString(req.ReviewerUserID), nullString(req.ModeratorUserID)).Scan(&appID)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				// Already raised in an earlier run. Not an error.
				if _, err := tx.Exec(r.Context(), "RELEASE SAVEPOINT raise_one"); err != nil {
					return err
				}
				continue
			case err != nil:
				var pg *pgconn.PgError
				if errors.As(err, &pg) && (pg.Code == "23514" || pg.Code == "P0001") {
					skipped = append(skipped, skip{p.code + " " + p.name, pg.Message})
					if _, e := tx.Exec(r.Context(), "ROLLBACK TO SAVEPOINT raise_one"); e != nil {
						return e
					}
					continue
				}
				return err
			}

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO appraisal_ratings (institution_id, appraisal_id, kpi_id, weight)
				SELECT $1, $2::uuid, k.id, k.weight
				  FROM appraisal_kpi_set($3::uuid, $4::uuid) k
				ON CONFLICT (appraisal_id, kpi_id) DO NOTHING`,
				id.InstitutionID, appID, req.CycleID, p.desig); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), "RELEASE SAVEPOINT raise_one"); err != nil {
				return err
			}
			raised++
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"raised": raised, "skipped": skipped,
	})
}

// nullUUIDTextSlice passes an id list as a Postgres array, or NULL when it is
// empty so the query's "no filter" branch fires. An empty array would match
// nothing, which is the opposite of what an omitted filter means.
func nullUUIDTextSlice(v []string) any {
	if len(v) == 0 {
		return nil
	}
	return v
}

type ratingInput struct {
	KPIID string   `json:"kpi_id"`
	Score *float64 `json:"score,omitempty"`
	Note  string   `json:"note,omitempty"`
}

type appraisalScoreRequest struct {
	Ratings  []ratingInput `json:"ratings"`
	Comments string        `json:"comments,omitempty"`
}

// weightedScore recomputes the total from the ratings actually stored, in the
// database, so the number on the screen is never one the client worked out.
const weightedScoreSQL = `
	SELECT sum(%s * rt.weight) / NULLIF(sum(rt.weight), 0)
	  FROM appraisal_ratings rt
	 WHERE rt.appraisal_id = $1 AND %s IS NOT NULL`

func (s *Server) submitSelfAssessment(w http.ResponseWriter, r *http.Request) {
	app, ok := growthPathID(w, r)
	if !ok {
		return
	}
	emp, ok := s.ownEmployee(w, r)
	if !ok {
		return
	}
	var req appraisalScoreRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		// The ownership check is the WHERE clause, not a prior read: a
		// separate check and update is a window in which neither is true.
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM appraisals WHERE id = $1 AND employee_id = $2`,
			app, emp).Scan(&status); err != nil {
			return err
		}
		if status != "not_started" && status != "self_submitted" {
			return errAppraisalClosed
		}
		for _, rt := range req.Ratings {
			if _, err := tx.Exec(r.Context(), `
				UPDATE appraisal_ratings SET self_score = $3, self_note = $4
				 WHERE appraisal_id = $1 AND kpi_id = $2::uuid`,
				app, rt.KPIID, rt.Score, nullString(rt.Note)); err != nil {
				return err
			}
		}
		_, err := tx.Exec(r.Context(), fmt.Sprintf(`
			UPDATE appraisals
			   SET status = 'self_submitted', self_submitted_at = now(),
			       self_comments = COALESCE($2, self_comments),
			       self_score = (`+weightedScoreSQL+`)
			 WHERE id = $1`, "rt.self_score", "rt.self_score"),
			app, nullString(req.Comments))
		return err
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": app.String(), "status": "self_submitted"})
}

var errAppraisalClosed = errors.New("this appraisal is past the stage that can be edited")

type appraisalReviewRequest struct {
	appraisalScoreRequest
	// Optional. One input among several, and only a reference: this module
	// never writes the 360 side and does not own that instrument.
	External360Source string   `json:"external_360_source,omitempty"`
	External360Ref    string   `json:"external_360_ref,omitempty"`
	External360Score  *float64 `json:"external_360_score,omitempty"`
}

/*
reviewAppraisal records the reviewer's ratings.

	Reachable with hr.employees.read because the reviewer is usually a head of
	department, who has no write grant over employee records and should not be
	given one to fill in a form about their own team. The narrowing is the rule
	rather than the permission: you may review the appraisals you were named
	on, and the back office may review any of them.
*/
func (s *Server) reviewAppraisal(w http.ResponseWriter, r *http.Request) {
	app, ok := growthPathID(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req appraisalReviewRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	backOffice := id.Can(rbac.EmployeesWrite)

	var denied bool
	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		var reviewer *uuid.UUID
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT reviewer_user_id, status FROM appraisals WHERE id = $1`, app).
			Scan(&reviewer, &status); err != nil {
			return err
		}
		if !backOffice && (reviewer == nil || *reviewer != id.UserID) {
			denied = true
			return nil
		}
		if status == "published" || status == "acknowledged" {
			return errAppraisalClosed
		}
		for _, rt := range req.Ratings {
			if _, err := tx.Exec(r.Context(), `
				UPDATE appraisal_ratings SET reviewer_score = $3, reviewer_note = $4
				 WHERE appraisal_id = $1 AND kpi_id = $2::uuid`,
				app, rt.KPIID, rt.Score, nullString(rt.Note)); err != nil {
				return err
			}
		}
		_, err := tx.Exec(r.Context(), fmt.Sprintf(`
			UPDATE appraisals
			   SET status = 'reviewed', reviewed_at = now(),
			       reviewer_comments = COALESCE($2, reviewer_comments),
			       reviewer_score = (`+weightedScoreSQL+`),
			       external_360_source = COALESCE($3, external_360_source),
			       external_360_ref = COALESCE($4::uuid, external_360_ref),
			       external_360_score = COALESCE($5, external_360_score)
			 WHERE id = $1`, "rt.reviewer_score", "rt.reviewer_score"),
			app, nullString(req.Comments), nullString(req.External360Source),
			nullString(req.External360Ref), req.External360Score)
		return err
	})
	if !ok {
		return
	}
	if denied {
		httpx.Denied(w, r, "you are not the reviewer named on this appraisal")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": app.String(), "status": "reviewed"})
}

type moderateRequest struct {
	Ratings []ratingInput `json:"ratings,omitempty"`
	Note    string        `json:"note,omitempty"`
}

// moderateAppraisal is the calibration pass. One head of department marks
// generously and another does not, and moderation is the only thing standing
// between that and an increment list that rewards the lenient reviewer.
func (s *Server) moderateAppraisal(w http.ResponseWriter, r *http.Request) {
	app, ok := growthPathID(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req moderateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		for _, rt := range req.Ratings {
			if _, err := tx.Exec(r.Context(), `
				UPDATE appraisal_ratings SET moderated_score = $3
				 WHERE appraisal_id = $1 AND kpi_id = $2::uuid`,
				app, rt.KPIID, rt.Score); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(r.Context(), fmt.Sprintf(`
			UPDATE appraisals
			   SET status = 'moderated', moderated_at = now(),
			       moderator_user_id = COALESCE(moderator_user_id, $3),
			       moderation_note = COALESCE($2, moderation_note),
			       -- Nothing moderated leaves the reviewer's number standing,
			       -- which is what "no change" has to mean.
			       moderated_score = COALESCE((`+weightedScoreSQL+`), reviewer_score)
			 WHERE id = $1 AND status NOT IN ('published','acknowledged')`,
			"rt.moderated_score", "rt.moderated_score"),
			app, nullString(req.Note), id.UserID)
		if err == nil && tag.RowsAffected() == 0 {
			return errAppraisalClosed
		}
		return err
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": app.String(), "status": "moderated"})
}

type publishAppraisalRequest struct {
	FinalBand      string   `json:"final_band,omitempty"`
	IncrementPct   *float64 `json:"increment_percent,omitempty"`
	IncrementPaise *int64   `json:"increment_paise,omitempty"`
}

// publishAppraisal fixes the final score and makes it visible to the employee.
//
// The score is the moderated one where there is a moderation, the reviewer's
// otherwise — never the self-assessment, which is an input and not a verdict.
// The CHECK on the table refuses publication with no final score at all.
func (s *Server) publishAppraisal(w http.ResponseWriter, r *http.Request) {
	app, ok := growthPathID(w, r)
	if !ok {
		return
	}
	var req publishAppraisalRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var final *float64
	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			UPDATE appraisals
			   SET final_score = COALESCE(moderated_score, reviewer_score),
			       final_band = COALESCE($2, final_band),
			       increment_percent = COALESCE($3, increment_percent),
			       increment_paise = COALESCE($4, increment_paise),
			       status = 'published', published_at = now()
			 WHERE id = $1
			   AND status IN ('reviewed','moderated')
			   AND COALESCE(moderated_score, reviewer_score) IS NOT NULL
			RETURNING final_score::float8`,
			app, nullString(req.FinalBand), req.IncrementPct, req.IncrementPaise).Scan(&final)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotReviewed
		}
		return err
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": app.String(), "status": "published", "final_score": final})
}

var errNotReviewed = errors.New(
	"an appraisal can only be published once it has been reviewed and has a score")

type discussionRequest struct {
	DiscussionOn string `json:"discussion_on,omitempty"`
	Note         string `json:"note"`
}

// recordAppraisalDiscussion writes the conversation. A score with no record of
// the conversation is the appraisal every teacher complains about.
func (s *Server) recordAppraisalDiscussion(w http.ResponseWriter, r *http.Request) {
	app, ok := growthPathID(w, r)
	if !ok {
		return
	}
	var req discussionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r, "a note of what was discussed is required")
		return
	}
	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE appraisals
			   SET discussion_on = COALESCE($2::date, current_date), discussion_note = $3
			 WHERE id = $1`, app, nullString(req.DiscussionOn), req.Note)
		return err
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": app.String()})
}

// --- the employee's own appraisal ------------------------------------------

// listMyAppraisals answers with the caller's own, and only their own.
//
// The filter is employee_id = the caller's row, resolved from the session
// rather than taken from a query parameter. A parameter would make this
// endpoint the whole staff room's appraisals with an id to iterate.
func (s *Server) listMyAppraisals(w http.ResponseWriter, r *http.Request) {
	emp, ok := s.ownEmployee(w, r)
	if !ok {
		return
	}
	items, err := collect(s, r, appraisalSelect+`
		 WHERE a.employee_id = $1
		   -- A published appraisal is the employee's to read; one still being
		   -- moderated is not, and showing a draft score would turn every
		   -- calibration into an argument.
		   AND (a.status IN ('not_started','self_submitted','published','acknowledged'))
		 ORDER BY cy.opens_on DESC NULLS LAST`, []any{emp}, scanAppraisal)
	respond(w, r, items, err)
}

func (s *Server) getMyAppraisal(w http.ResponseWriter, r *http.Request) {
	app, ok := growthPathID(w, r)
	if !ok {
		return
	}
	emp, ok := s.ownEmployee(w, r)
	if !ok {
		return
	}
	s.renderAppraisal(w, r, appraisalSelect+`
		 WHERE a.id = $1 AND a.employee_id = $2
		   AND a.status IN ('not_started','self_submitted','published','acknowledged')`,
		[]any{app, emp})
}

type acknowledgeRequest struct {
	Comments string `json:"comments,omitempty"`
}

// acknowledgeAppraisal is the employee's signature, and their right of reply.
func (s *Server) acknowledgeAppraisal(w http.ResponseWriter, r *http.Request) {
	app, ok := growthPathID(w, r)
	if !ok {
		return
	}
	emp, ok := s.ownEmployee(w, r)
	if !ok {
		return
	}
	var req acknowledgeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE appraisals
			   SET status = 'acknowledged', acknowledged_at = now(),
			       employee_comments = COALESCE($3, employee_comments)
			 WHERE id = $1 AND employee_id = $2 AND status = 'published'`,
			app, emp, nullString(req.Comments))
		if err == nil && tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return err
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": app.String(), "status": "acknowledged"})
}

// ===========================================================================
// hr.hiring_growth.staff_training_workshop_logs
// ===========================================================================

type trainingProgrammeRow struct {
	ID           string   `json:"id"`
	Code         string   `json:"code"`
	Title        string   `json:"title"`
	Category     *string  `json:"category,omitempty"`
	Provider     *string  `json:"provider,omitempty"`
	ProviderKind string   `json:"provider_kind"`
	Mode         string   `json:"mode"`
	Venue        *string  `json:"venue,omitempty"`
	StartsOn     string   `json:"starts_on"`
	EndsOn       string   `json:"ends_on"`
	Hours        float64  `json:"hours"`
	IsMandatory  bool     `json:"is_mandatory"`
	Counts       bool     `json:"counts_towards_requirement"`
	CostPaise    *int64   `json:"cost_paise,omitempty"`
	Nominated    int      `json:"nominated"`
	Completed    int      `json:"completed"`
	HoursLogged  *float64 `json:"hours_logged,omitempty"`
}

func (s *Server) listTrainingProgrammes(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT p.id::text, p.code, p.title, p.category, p.provider, p.provider_kind,
		       p.mode, p.venue, to_char(p.starts_on,'YYYY-MM-DD'),
		       to_char(p.ends_on,'YYYY-MM-DD'), p.hours::float8, p.is_mandatory,
		       p.counts_towards_requirement, p.cost_paise,
		       count(t.id)::int,
		       count(t.id) FILTER (WHERE t.status = 'completed')::int,
		       sum(t.hours_completed)::float8
		  FROM training_programmes p
		  LEFT JOIN staff_training_records t ON t.programme_id = p.id
		 WHERE ($1::uuid IS NULL OR p.academic_year_id = $1::uuid)
		   AND ($2::date IS NULL OR p.ends_on   >= $2::date)
		   AND ($3::date IS NULL OR p.starts_on <= $3::date)
		 GROUP BY p.id
		 ORDER BY p.starts_on DESC
		 LIMIT 300`,
		[]any{nullString(q.Get("academic_year_id")), nullString(q.Get("from")),
			nullString(q.Get("to"))},
		func(rows pgx.Rows) (trainingProgrammeRow, error) {
			var v trainingProgrammeRow
			return v, rows.Scan(&v.ID, &v.Code, &v.Title, &v.Category, &v.Provider,
				&v.ProviderKind, &v.Mode, &v.Venue, &v.StartsOn, &v.EndsOn, &v.Hours,
				&v.IsMandatory, &v.Counts, &v.CostPaise, &v.Nominated, &v.Completed,
				&v.HoursLogged)
		})
	respond(w, r, items, err)
}

type trainingProgrammeRequest struct {
	ID             string  `json:"id,omitempty"`
	Code           string  `json:"code"`
	Title          string  `json:"title"`
	Category       string  `json:"category,omitempty"`
	Provider       string  `json:"provider,omitempty"`
	ProviderKind   string  `json:"provider_kind,omitempty"`
	Mode           string  `json:"mode,omitempty"`
	Venue          string  `json:"venue,omitempty"`
	AcademicYearID string  `json:"academic_year_id,omitempty"`
	StartsOn       string  `json:"starts_on"`
	EndsOn         string  `json:"ends_on,omitempty"`
	Hours          float64 `json:"hours"`
	IsMandatory    bool    `json:"is_mandatory,omitempty"`
	Counts         *bool   `json:"counts_towards_requirement,omitempty"`
	CostPaise      *int64  `json:"cost_paise,omitempty"`
	// Nominate these employees in the same call. A workshop logged with
	// nobody attending it is a row nobody ever comes back to fill in.
	EmployeeIDs []string `json:"employee_ids,omitempty"`
}

func (s *Server) saveTrainingProgramme(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req trainingProgrammeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Code) == "" || strings.TrimSpace(req.Title) == "" {
		httpx.BadRequest(w, r, "code and title are required")
		return
	}
	if req.StartsOn == "" {
		httpx.BadRequest(w, r, "starts_on is required")
		return
	}
	if req.EndsOn == "" {
		req.EndsOn = req.StartsOn
	}
	if req.Hours <= 0 {
		httpx.BadRequest(w, r, "hours must be greater than zero")
		return
	}
	if req.ProviderKind == "" {
		req.ProviderKind = "internal"
	}
	if req.Mode == "" {
		req.Mode = "in_person"
	}
	counts := true
	if req.Counts != nil {
		counts = *req.Counts
	}

	var out string
	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		if req.ID != "" {
			out = req.ID
			if _, err := tx.Exec(r.Context(), `
				UPDATE training_programmes
				   SET title = $2, category = $3, provider = $4, provider_kind = $5,
				       mode = $6, venue = $7, academic_year_id = $8::uuid,
				       starts_on = $9::date, ends_on = $10::date, hours = $11,
				       is_mandatory = $12, counts_towards_requirement = $13, cost_paise = $14
				 WHERE id = $1::uuid`,
				req.ID, req.Title, nullString(req.Category), nullString(req.Provider),
				req.ProviderKind, req.Mode, nullString(req.Venue),
				nullString(req.AcademicYearID), req.StartsOn, req.EndsOn, req.Hours,
				req.IsMandatory, counts, req.CostPaise); err != nil {
				return err
			}
		} else if err := tx.QueryRow(r.Context(), `
			INSERT INTO training_programmes (institution_id, code, title, category,
			        provider, provider_kind, mode, venue, academic_year_id,
			        starts_on, ends_on, hours, is_mandatory,
			        counts_towards_requirement, cost_paise, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10::date,$11::date,$12,$13,$14,$15,$16)
			RETURNING id::text`,
			id.InstitutionID, strings.TrimSpace(req.Code), strings.TrimSpace(req.Title),
			nullString(req.Category), nullString(req.Provider), req.ProviderKind, req.Mode,
			nullString(req.Venue), nullString(req.AcademicYearID), req.StartsOn, req.EndsOn,
			req.Hours, req.IsMandatory, counts, req.CostPaise, id.UserID).Scan(&out); err != nil {
			return err
		}
		if len(req.EmployeeIDs) == 0 {
			return nil
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO staff_training_records (institution_id, programme_id,
			        employee_id, status, nominated_by)
			SELECT $1, $2::uuid, e.id, 'nominated', $4
			  FROM employees e WHERE e.id = ANY($3::uuid[])
			ON CONFLICT (programme_id, employee_id) DO NOTHING`,
			id.InstitutionID, out, req.EmployeeIDs, id.UserID)
		return err
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

type trainingRecordRow struct {
	ID            string   `json:"id"`
	ProgrammeID   string   `json:"programme_id"`
	Programme     string   `json:"programme"`
	Provider      *string  `json:"provider,omitempty"`
	StartsOn      string   `json:"starts_on"`
	EmployeeID    string   `json:"employee_id"`
	EmployeeCode  string   `json:"employee_code"`
	FullName      string   `json:"full_name"`
	Department    *string  `json:"department,omitempty"`
	Status        string   `json:"status"`
	AttendedOn    *string  `json:"attended_on,omitempty"`
	Hours         *float64 `json:"hours_completed,omitempty"`
	Score         *float64 `json:"score,omitempty"`
	CertFileID    *string  `json:"certificate_file_id,omitempty"`
	CertNo        *string  `json:"certificate_no,omitempty"`
	CertIssuedOn  *string  `json:"certificate_issued_on,omitempty"`
	CountsToTotal bool     `json:"counts_towards_requirement"`
}

func (s *Server) listTrainingRecords(w http.ResponseWriter, r *http.Request) {
	re, err := s.growthReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	q := r.URL.Query()
	args := []any{nullString(q.Get("programme_id")), nullString(q.Get("employee_id"))}
	pred, extra := re.employeeFilter("e", len(args)+1)
	args = append(args, extra...)

	items, err := collect(s, r, `
		SELECT t.id::text, t.programme_id::text, p.title, p.provider,
		       to_char(p.starts_on,'YYYY-MM-DD'), t.employee_id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name), d.name, t.status,
		       to_char(t.attended_on,'YYYY-MM-DD'), t.hours_completed::float8,
		       t.score::float8, t.certificate_file_id::text, t.certificate_no,
		       to_char(t.certificate_issued_on,'YYYY-MM-DD'), p.counts_towards_requirement
		  FROM staff_training_records t
		  JOIN training_programmes p ON p.id = t.programme_id
		  JOIN employees e ON e.id = t.employee_id
		  LEFT JOIN departments d ON d.id = e.department_id
		 WHERE ($1::uuid IS NULL OR t.programme_id = $1::uuid)
		   AND ($2::uuid IS NULL OR t.employee_id  = $2::uuid)
		   AND `+pred+`
		 ORDER BY p.starts_on DESC, e.employee_code
		 LIMIT 500`, args,
		func(rows pgx.Rows) (trainingRecordRow, error) {
			var v trainingRecordRow
			return v, rows.Scan(&v.ID, &v.ProgrammeID, &v.Programme, &v.Provider,
				&v.StartsOn, &v.EmployeeID, &v.EmployeeCode, &v.FullName, &v.Department,
				&v.Status, &v.AttendedOn, &v.Hours, &v.Score, &v.CertFileID,
				&v.CertNo, &v.CertIssuedOn, &v.CountsToTotal)
		})
	respond(w, r, items, err)
}

type trainingRecordRequest struct {
	ProgrammeID string   `json:"programme_id"`
	EmployeeIDs []string `json:"employee_ids"`
	Status      string   `json:"status,omitempty"`
	AttendedOn  string   `json:"attended_on,omitempty"`
	// Null on completion means "all of the programme's hours", which is the
	// usual case; a half-attended workshop passes the real figure.
	Hours *float64 `json:"hours_completed,omitempty"`
	Score *float64 `json:"score,omitempty"`
	// The certificate lives on files, the same shelf employee_documents uses;
	// nothing here re-implements storage.
	CertificateFileID string `json:"certificate_file_id,omitempty"`
	CertificateNo     string `json:"certificate_no,omitempty"`
	CertificateOn     string `json:"certificate_issued_on,omitempty"`
	Feedback          string `json:"feedback,omitempty"`
}

// saveTrainingRecord nominates staff onto a programme, or logs what they did.
//
// Hours default from the programme on completion rather than being defaulted
// by the column, because the row has to be able to say a teacher who left
// after the first morning completed three hours and not thirty.
func (s *Server) saveTrainingRecord(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req trainingRecordRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.ProgrammeID == "" || len(req.EmployeeIDs) == 0 {
		httpx.BadRequest(w, r, "programme_id and at least one employee_id are required")
		return
	}
	if req.Status == "" {
		req.Status = "nominated"
	}
	switch req.Status {
	case "nominated", "attended", "completed", "absent", "withdrawn":
	default:
		httpx.BadRequest(w, r, "unknown status")
		return
	}

	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO staff_training_records (institution_id, programme_id, employee_id,
			        status, attended_on, hours_completed, score, certificate_file_id,
			        certificate_no, certificate_issued_on, feedback, nominated_by)
			SELECT $1, p.id, e.id, $4,
			       CASE WHEN $4 IN ('attended','completed')
			            THEN COALESCE($5::date, p.starts_on) END,
			       CASE WHEN $4 = 'completed' THEN COALESCE($6, p.hours) ELSE $6 END,
			       $7, $8::uuid, $9, $10::date, $11, $12
			  FROM training_programmes p, employees e
			 WHERE p.id = $2::uuid AND e.id = ANY($3::uuid[])
			ON CONFLICT (programme_id, employee_id) DO UPDATE SET
			       status = EXCLUDED.status,
			       attended_on = COALESCE(EXCLUDED.attended_on, staff_training_records.attended_on),
			       hours_completed = COALESCE(EXCLUDED.hours_completed, staff_training_records.hours_completed),
			       score = COALESCE(EXCLUDED.score, staff_training_records.score),
			       certificate_file_id = COALESCE(EXCLUDED.certificate_file_id, staff_training_records.certificate_file_id),
			       certificate_no = COALESCE(EXCLUDED.certificate_no, staff_training_records.certificate_no),
			       certificate_issued_on = COALESCE(EXCLUDED.certificate_issued_on, staff_training_records.certificate_issued_on),
			       feedback = COALESCE(EXCLUDED.feedback, staff_training_records.feedback)`,
			id.InstitutionID, req.ProgrammeID, req.EmployeeIDs, req.Status,
			nullString(req.AttendedOn), req.Hours, req.Score,
			nullString(req.CertificateFileID), nullString(req.CertificateNo),
			nullString(req.CertificateOn), nullString(req.Feedback), id.UserID)
		return err
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": len(req.EmployeeIDs)})
}

type trainingRequirementRow struct {
	ID           string  `json:"id"`
	AcademicYear *string `json:"academic_year,omitempty"`
	Designation  *string `json:"designation,omitempty"`
	Category     *string `json:"designation_category,omitempty"`
	Hours        float64 `json:"required_hours"`
	Authority    *string `json:"authority,omitempty"`
	Note         *string `json:"note,omitempty"`
}

// listTrainingRequirements seeds the statutory default on first read, the way
// getLeavePolicy does: a school that has never opened this screen still has to
// be told whether its teachers are short of their hours.
func (s *Server) listTrainingRequirements(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO training_requirements (institution_id, designation_category,
			        required_hours, authority, note)
			SELECT $1, 'teaching', 50, 'CBSE',
			       'Annual in-service training hours expected of teaching staff.'
			 WHERE NOT EXISTS (SELECT 1 FROM training_requirements
			                    WHERE institution_id = $1)`, id.InstitutionID)
		return err
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	items, err := collect(s, r, `
		SELECT q.id::text, y.name, g.name, q.designation_category,
		       q.required_hours::float8, q.authority, q.note
		  FROM training_requirements q
		  LEFT JOIN academic_years y ON y.id = q.academic_year_id
		  LEFT JOIN designations  g ON g.id = q.designation_id
		 ORDER BY y.starts_on DESC NULLS LAST, g.name NULLS LAST`, nil,
		func(rows pgx.Rows) (trainingRequirementRow, error) {
			var v trainingRequirementRow
			return v, rows.Scan(&v.ID, &v.AcademicYear, &v.Designation, &v.Category,
				&v.Hours, &v.Authority, &v.Note)
		})
	respond(w, r, items, err)
}

type trainingRequirementRequest struct {
	AcademicYearID string  `json:"academic_year_id,omitempty"`
	DesignationID  string  `json:"designation_id,omitempty"`
	Category       string  `json:"designation_category,omitempty"`
	Hours          float64 `json:"required_hours"`
	Authority      string  `json:"authority,omitempty"`
	Note           string  `json:"note,omitempty"`
}

func (s *Server) saveTrainingRequirement(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req trainingRequirementRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Hours < 0 {
		httpx.BadRequest(w, r, "required_hours cannot be negative")
		return
	}
	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO training_requirements (institution_id, academic_year_id,
			        designation_id, designation_category, required_hours, authority, note)
			VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,$7)
			ON CONFLICT (institution_id,
			             COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid),
			             COALESCE(designation_id,   '00000000-0000-0000-0000-000000000000'::uuid),
			             COALESCE(designation_category, ''))
			DO UPDATE SET required_hours = EXCLUDED.required_hours,
			              authority = EXCLUDED.authority, note = EXCLUDED.note`,
			id.InstitutionID, nullString(req.AcademicYearID), nullString(req.DesignationID),
			nullString(req.Category), req.Hours, nullString(req.Authority),
			nullString(req.Note))
		return err
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"required_hours": req.Hours})
}

type trainingComplianceRow struct {
	EmployeeID   string   `json:"employee_id"`
	EmployeeCode string   `json:"employee_code"`
	FullName     string   `json:"full_name"`
	Designation  *string  `json:"designation,omitempty"`
	Department   *string  `json:"department,omitempty"`
	Programmes   int      `json:"programmes_completed"`
	HoursDone    float64  `json:"hours_completed"`
	HoursNeeded  *float64 `json:"hours_required,omitempty"`
	Shortfall    *float64 `json:"shortfall,omitempty"`
	Compliant    *bool    `json:"compliant,omitempty"`
	Certificates int      `json:"certificates_on_file"`
}

/*
getTrainingCompliance is the report the whole feature exists for.

	Hours completed against hours required, per member of staff, for one
	academic year. An affiliation inspection asks a school to evidence its
	teachers' in-service hours, and a list of workshops does not answer that —
	the answer is a number per teacher and the names of the ones who are short.

	The requirement is matched most-specific-first: a rule naming the exact
	designation beats one naming its category, which beats the school-wide
	default, and a rule for the year in question beats one for every year.
	Staff with no rule at all are listed with a null requirement rather than
	dropped, because a person nobody has set an expectation for is a gap in the
	policy, not an absence of a person.
*/
func (s *Server) getTrainingCompliance(w http.ResponseWriter, r *http.Request) {
	re, err := s.growthReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	args := []any{nullString(r.URL.Query().Get("academic_year_id"))}
	pred, extra := re.employeeFilter("e", len(args)+1)
	args = append(args, extra...)

	items, err := collect(s, r, `
		WITH yr AS (
		    SELECT id, starts_on, ends_on FROM academic_years
		     WHERE id = $1::uuid
		    UNION ALL
		    SELECT id, starts_on, ends_on FROM academic_years
		     WHERE $1::uuid IS NULL AND is_current
		     LIMIT 1
		)
		SELECT e.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name), g.name, d.name,
		       count(t.id) FILTER (WHERE t.status = 'completed')::int,
		       COALESCE(sum(t.hours_completed) FILTER (
		           WHERE t.status = 'completed' AND p.counts_towards_requirement), 0)::float8,
		       req.required_hours::float8,
		       CASE WHEN req.required_hours IS NULL THEN NULL
		            ELSE greatest(req.required_hours - COALESCE(sum(t.hours_completed) FILTER (
		                 WHERE t.status = 'completed' AND p.counts_towards_requirement), 0), 0)
		       END::float8,
		       CASE WHEN req.required_hours IS NULL THEN NULL
		            ELSE COALESCE(sum(t.hours_completed) FILTER (
		                 WHERE t.status = 'completed' AND p.counts_towards_requirement), 0)
		                 >= req.required_hours
		       END,
		       count(t.certificate_file_id)::int
		  FROM employees e
		  LEFT JOIN designations g ON g.id = e.designation_id
		  LEFT JOIN departments  d ON d.id = e.department_id
		  LEFT JOIN staff_training_records t ON t.employee_id = e.id
		  LEFT JOIN training_programmes p
		         ON p.id = t.programme_id
		        AND (NOT EXISTS (SELECT 1 FROM yr)
		             OR p.starts_on BETWEEN (SELECT starts_on FROM yr)
		                                AND (SELECT ends_on   FROM yr))
		  LEFT JOIN LATERAL (
		      SELECT q.required_hours
		        FROM training_requirements q
		       WHERE q.institution_id = e.institution_id
		         AND (q.academic_year_id IS NULL
		              OR q.academic_year_id = (SELECT id FROM yr))
		         AND (q.designation_id IS NULL OR q.designation_id = e.designation_id)
		         AND (q.designation_category IS NULL OR q.designation_category = g.category)
		       ORDER BY (q.designation_id IS NOT NULL) DESC,
		                (q.designation_category IS NOT NULL) DESC,
		                (q.academic_year_id IS NOT NULL) DESC
		       LIMIT 1) req ON TRUE
		 WHERE e.status = 'active' AND `+pred+`
		 GROUP BY e.id, g.name, d.name, req.required_hours
		 -- Whoever is furthest short, first. A compliance report sorted by name
		 -- is a report nobody acts on.
		 ORDER BY (req.required_hours IS NOT NULL) DESC,
		          COALESCE(req.required_hours, 0) - COALESCE(sum(t.hours_completed) FILTER (
		              WHERE t.status = 'completed' AND p.counts_towards_requirement), 0) DESC,
		          e.employee_code
		 LIMIT 800`, args,
		func(rows pgx.Rows) (trainingComplianceRow, error) {
			var v trainingComplianceRow
			return v, rows.Scan(&v.EmployeeID, &v.EmployeeCode, &v.FullName,
				&v.Designation, &v.Department, &v.Programmes, &v.HoursDone,
				&v.HoursNeeded, &v.Shortfall, &v.Compliant, &v.Certificates)
		})
	respond(w, r, items, err)
}

// getMyTrainingRecord is the same arithmetic for one person, without needing
// hr.employees.read to see it.
func (s *Server) getMyTrainingRecord(w http.ResponseWriter, r *http.Request) {
	emp, ok := s.ownEmployee(w, r)
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT t.id::text, t.programme_id::text, p.title, p.provider,
		       to_char(p.starts_on,'YYYY-MM-DD'), t.employee_id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name), d.name, t.status,
		       to_char(t.attended_on,'YYYY-MM-DD'), t.hours_completed::float8,
		       t.score::float8, t.certificate_file_id::text, t.certificate_no,
		       to_char(t.certificate_issued_on,'YYYY-MM-DD'), p.counts_towards_requirement
		  FROM staff_training_records t
		  JOIN training_programmes p ON p.id = t.programme_id
		  JOIN employees e ON e.id = t.employee_id
		  LEFT JOIN departments d ON d.id = e.department_id
		 WHERE t.employee_id = $1
		 ORDER BY p.starts_on DESC`, []any{emp},
		func(rows pgx.Rows) (trainingRecordRow, error) {
			var v trainingRecordRow
			return v, rows.Scan(&v.ID, &v.ProgrammeID, &v.Programme, &v.Provider,
				&v.StartsOn, &v.EmployeeID, &v.EmployeeCode, &v.FullName, &v.Department,
				&v.Status, &v.AttendedOn, &v.Hours, &v.Score, &v.CertFileID,
				&v.CertNo, &v.CertIssuedOn, &v.CountsToTotal)
		})
	respond(w, r, items, err)
}

// ===========================================================================
// hr.attendance.staff_shift_rostering
// ===========================================================================

type dutyShiftRow struct {
	ID        string  `json:"id"`
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	DutyKind  string  `json:"duty_kind"`
	StartsAt  string  `json:"starts_at"`
	EndsAt    string  `json:"ends_at"`
	Weekdays  []int   `json:"weekdays"`
	Headcount int     `json:"headcount"`
	IsOnerous bool    `json:"is_onerous"`
	Location  *string `json:"location,omitempty"`
	IsActive  bool    `json:"is_active"`
	Notes     *string `json:"notes,omitempty"`
}

// The set a school starts with. Seeded into every institution that existed
// when 00053 ran, and created here for one that did not — the same shape
// getLeavePolicy uses, because a rostering screen with no shifts on it reads
// as broken rather than as unconfigured.
const seedDutyShiftsSQL = `
	INSERT INTO duty_shifts (institution_id, code, name, duty_kind, starts_at,
	        ends_at, is_onerous, headcount)
	SELECT $1, v.code, v.name, v.kind, v.from_at::time, v.to_at::time, v.onerous, v.heads
	  FROM (VALUES
	      ('GATE_AM',  'Morning gate duty', 'gate',             '07:15','08:15', true,  2),
	      ('ASSEMBLY', 'Assembly duty',     'assembly',         '08:15','08:45', false, 2),
	      ('GROUND_PM','Ground and games',  'ground',           '13:30','14:30', true,  2),
	      ('DISPERSAL','Dispersal duty',    'dispersal',        '15:00','15:45', true,  3),
	      ('BUS_ESC',  'Transport escort',  'transport_escort', '15:15','16:30', true,  1),
	      ('LIB_DESK', 'Library desk',      'library',          '10:00','11:00', false, 1),
	      ('LAB_DUTY', 'Laboratory duty',   'lab',              '11:00','12:00', false, 1),
	      ('INVIG',    'Exam invigilation', 'exam_invigilation','09:00','12:00', false, 1)
	  ) AS v(code, name, kind, from_at, to_at, onerous, heads)
	 WHERE NOT EXISTS (SELECT 1 FROM duty_shifts d WHERE d.institution_id = $1)`

func (s *Server) listDutyShifts(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), seedDutyShiftsSQL, id.InstitutionID)
		return err
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	items, err := collect(s, r, `
		SELECT id::text, code, name, duty_kind, to_char(starts_at,'HH24:MI'),
		       to_char(ends_at,'HH24:MI'), weekdays, headcount, is_onerous,
		       location, is_active, notes
		  FROM duty_shifts
		 ORDER BY is_active DESC, starts_at, code`, nil,
		func(rows pgx.Rows) (dutyShiftRow, error) {
			var v dutyShiftRow
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.DutyKind, &v.StartsAt,
				&v.EndsAt, &v.Weekdays, &v.Headcount, &v.IsOnerous, &v.Location,
				&v.IsActive, &v.Notes)
		})
	respond(w, r, items, err)
}

type dutyShiftRequest struct {
	ID        string `json:"id,omitempty"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	DutyKind  string `json:"duty_kind"`
	StartsAt  string `json:"starts_at"`
	EndsAt    string `json:"ends_at"`
	Weekdays  []int  `json:"weekdays,omitempty"`
	Headcount int    `json:"headcount,omitempty"`
	IsOnerous bool   `json:"is_onerous,omitempty"`
	Location  string `json:"location,omitempty"`
	IsActive  *bool  `json:"is_active,omitempty"`
	Notes     string `json:"notes,omitempty"`
	CampusID  string `json:"campus_id,omitempty"`
}

func (s *Server) saveDutyShift(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req dutyShiftRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Code) == "" || strings.TrimSpace(req.Name) == "" ||
		req.DutyKind == "" || req.StartsAt == "" || req.EndsAt == "" {
		httpx.BadRequest(w, r, "code, name, duty_kind, starts_at and ends_at are required")
		return
	}
	if req.Headcount <= 0 {
		req.Headcount = 1
	}
	if len(req.Weekdays) == 0 {
		req.Weekdays = []int{1, 2, 3, 4, 5, 6}
	}
	for _, d := range req.Weekdays {
		if d < 1 || d > 7 {
			httpx.BadRequest(w, r, "weekdays are 1 (Monday) to 7 (Sunday)")
			return
		}
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	var out string
	ok := s.growthTxn(w, r, func(tx pgx.Tx) error {
		if req.ID != "" {
			out = req.ID
			_, err := tx.Exec(r.Context(), `
				UPDATE duty_shifts
				   SET name = $2, duty_kind = $3, starts_at = $4::time, ends_at = $5::time,
				       weekdays = $6, headcount = $7, is_onerous = $8, location = $9,
				       is_active = $10, notes = $11
				 WHERE id = $1::uuid`,
				req.ID, req.Name, req.DutyKind, req.StartsAt, req.EndsAt, req.Weekdays,
				req.Headcount, req.IsOnerous, nullString(req.Location), active,
				nullString(req.Notes))
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO duty_shifts (institution_id, campus_id, code, name, duty_kind,
			        starts_at, ends_at, weekdays, headcount, is_onerous, location,
			        is_active, notes)
			VALUES ($1,$2::uuid,$3,$4,$5,$6::time,$7::time,$8,$9,$10,$11,$12,$13)
			RETURNING id::text`,
			id.InstitutionID, nullString(req.CampusID), strings.TrimSpace(req.Code),
			strings.TrimSpace(req.Name), req.DutyKind, req.StartsAt, req.EndsAt,
			req.Weekdays, req.Headcount, req.IsOnerous, nullString(req.Location),
			active, nullString(req.Notes)).Scan(&out)
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

type dutyAssignmentRow struct {
	ID           string  `json:"id"`
	ShiftID      string  `json:"shift_id"`
	ShiftCode    string  `json:"shift_code"`
	ShiftName    string  `json:"shift_name"`
	DutyKind     string  `json:"duty_kind"`
	IsOnerous    bool    `json:"is_onerous"`
	UserID       string  `json:"user_id"`
	FullName     string  `json:"full_name"`
	EmployeeCode *string `json:"employee_code,omitempty"`
	Department   *string `json:"department,omitempty"`
	OnDate       string  `json:"on_date"`
	StartsAt     string  `json:"starts_at"`
	EndsAt       string  `json:"ends_at"`
	Status       string  `json:"status"`
	Override     *string `json:"override_reason,omitempty"`
	Notes        *string `json:"notes,omitempty"`
}

const dutyRosterSelect = `
	SELECT a.id::text, a.shift_id::text, sh.code, sh.name, sh.duty_kind, sh.is_onerous,
	       a.user_id::text, u.full_name, e.employee_code, d.name,
	       to_char(a.on_date,'YYYY-MM-DD'), to_char(a.starts_at,'HH24:MI'),
	       to_char(a.ends_at,'HH24:MI'), a.status, a.override_reason, a.notes
	  FROM duty_assignments a
	  JOIN duty_shifts sh ON sh.id = a.shift_id
	  JOIN users u ON u.id = a.user_id
	  LEFT JOIN employees e ON e.id = a.employee_id
	  LEFT JOIN departments d ON d.id = e.department_id`

func scanDutyAssignment(rows pgx.Rows) (dutyAssignmentRow, error) {
	var v dutyAssignmentRow
	return v, rows.Scan(&v.ID, &v.ShiftID, &v.ShiftCode, &v.ShiftName, &v.DutyKind,
		&v.IsOnerous, &v.UserID, &v.FullName, &v.EmployeeCode, &v.Department,
		&v.OnDate, &v.StartsAt, &v.EndsAt, &v.Status, &v.Override, &v.Notes)
}

// listDutyRoster is the roster as it is pinned on the staff room wall. Not
// narrowed by department: who is on the gate on Tuesday is not a secret, and
// a teacher who cannot see the whole roster cannot arrange a swap.
func (s *Server) listDutyRoster(w http.ResponseWriter, r *http.Request) {
	from, to := growthRange(r)
	q := r.URL.Query()
	items, err := collect(s, r, dutyRosterSelect+`
		 WHERE a.on_date BETWEEN $1::date AND $2::date
		   AND ($3::uuid IS NULL OR a.shift_id = $3::uuid)
		   AND ($4::uuid IS NULL OR a.user_id  = $4::uuid)
		   AND a.status <> 'cancelled'
		 ORDER BY a.on_date, a.starts_at, sh.code`,
		[]any{from, to, nullString(q.Get("shift_id")), nullString(q.Get("user_id"))},
		scanDutyAssignment)
	respond(w, r, items, err)
}

func (s *Server) listMyDuties(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	from, to := growthRange(r)
	items, err := collect(s, r, dutyRosterSelect+`
		 WHERE a.user_id = $1 AND a.on_date BETWEEN $2::date AND $3::date
		   AND a.status <> 'cancelled'
		 ORDER BY a.on_date, a.starts_at`, []any{id.UserID, from, to},
		scanDutyAssignment)
	respond(w, r, items, err)
}

type dutyAssignRequest struct {
	ShiftID string `json:"shift_id"`
	// The person, as a user id: leave, the timetable and staff attendance are
	// all keyed on users, and a duty that cannot be compared with those three
	// is a duty nothing can check.
	UserIDs  []string `json:"user_ids"`
	FromDate string   `json:"from_date"`
	ToDate   string   `json:"to_date,omitempty"`
	// Which days of the range to use. Empty means the shift's own pattern,
	// which is what "roster the gate for a fortnight" ought to mean.
	Weekdays []int  `json:"weekdays,omitempty"`
	StartsAt string `json:"starts_at,omitempty"`
	EndsAt   string `json:"ends_at,omitempty"`
	Notes    string `json:"notes,omitempty"`
	// A teaching clash is refused unless this says why. Double-booking and
	// approved leave are refused outright by the database and no reason
	// overrides them.
	OverrideReason string `json:"override_reason,omitempty"`
}

type rosterClash struct {
	OnDate string `json:"on_date"`
	User   string `json:"user"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

/*
assignDuty rosters people onto a shift for a day or a range.

	The range is expanded into one row per date here rather than stored as a
	range, so every conflict check is an indexed lookup and "who is free at
	07:30 on Tuesday" is a question the database can answer.

	Two of the three checks are the database's and are not negotiable: the
	trigger refuses a second duty overlapping one already held, and refuses
	anybody on approved leave. The third — a period the person is timetabled
	to teach — is checked here and reported, because exam invigilation
	legitimately replaces the lesson it clashes with. Without a reason the
	whole request is refused and the clashes are listed; with one, the reason
	is written onto every row it applies to, so the roster carries its own
	explanation rather than somebody's memory of it.
*/
func (s *Server) assignDuty(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req dutyAssignRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.ShiftID == "" || len(req.UserIDs) == 0 || req.FromDate == "" {
		httpx.BadRequest(w, r, "shift_id, user_ids and from_date are required")
		return
	}
	if req.ToDate == "" {
		req.ToDate = req.FromDate
	}
	from, err1 := time.Parse(time.DateOnly, req.FromDate)
	to, err2 := time.Parse(time.DateOnly, req.ToDate)
	if err1 != nil || err2 != nil || to.Before(from) {
		httpx.BadRequest(w, r, "from_date and to_date must be YYYY-MM-DD, and to_date cannot precede from_date")
		return
	}
	if to.Sub(from) > 200*24*time.Hour {
		httpx.BadRequest(w, r, "a roster covers at most 200 days at a time")
		return
	}

	var created int
	clashes := []rosterClash{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var shiftStart, shiftEnd string
		var shiftDays []int
		var campus *string
		if err := tx.QueryRow(r.Context(), `
			SELECT to_char(starts_at,'HH24:MI'), to_char(ends_at,'HH24:MI'),
			       weekdays, campus_id::text
			  FROM duty_shifts WHERE id = $1::uuid AND is_active`, req.ShiftID).
			Scan(&shiftStart, &shiftEnd, &shiftDays, &campus); err != nil {
			return err
		}
		starts, ends := firstNonEmpty(req.StartsAt, shiftStart), firstNonEmpty(req.EndsAt, shiftEnd)
		days := req.Weekdays
		if len(days) == 0 {
			days = shiftDays
		}
		wanted := map[int]bool{}
		for _, d := range days {
			wanted[d] = true
		}

		for _, u := range req.UserIDs {
			for day := from; !day.After(to); day = day.AddDate(0, 0, 1) {
				iso := int(day.Weekday())
				if iso == 0 {
					iso = 7 // time.Sunday is 0; the schema and the timetable use 7
				}
				if !wanted[iso] {
					continue
				}
				// Re-rostering the same person on the same shift on the same
				// day is a no-op rather than an error: a roster is published
				// twice as often as it is written once, and the second run
				// must not fail on the rows the first one already made.
				tag, err := tx.Exec(r.Context(), `
					INSERT INTO duty_assignments (institution_id, campus_id, shift_id,
					        user_id, employee_id, on_date, starts_at, ends_at,
					        override_reason, notes, assigned_by)
					VALUES ($1,$2::uuid,$3::uuid,$4::uuid,
					        (SELECT e.id FROM employees e WHERE e.user_id = $4::uuid LIMIT 1),
					        $5::date,$6::time,$7::time,$8,$9,$10)
					ON CONFLICT (user_id, on_date, shift_id) WHERE status <> 'cancelled'
					DO NOTHING`,
					id.InstitutionID, campus, req.ShiftID, u,
					day.Format(time.DateOnly), starts, ends,
					nullString(req.OverrideReason), nullString(req.Notes), id.UserID)
				if err != nil {
					return err
				}
				created += int(tag.RowsAffected())
			}
		}

		// Now ask the database what this roster clashes with. Recomputed over
		// the whole range rather than trusted from the insert, because the
		// same query is what the roster screen uses afterwards and one answer
		// is better than two that can disagree.
		rows, err := tx.Query(r.Context(), `
			SELECT to_char(c.on_date,'YYYY-MM-DD'), u.full_name, c.kind, c.detail
			  FROM duty_roster_conflicts($1, $2::date, $3::date) c
			  JOIN users u ON u.id = c.user_id
			 WHERE c.kind <> 'leave' AND c.user_id = ANY($4::uuid[])
			 ORDER BY c.on_date, u.full_name`,
			id.InstitutionID, req.FromDate, req.ToDate, req.UserIDs)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c rosterClash
			if err := rows.Scan(&c.OnDate, &c.User, &c.Kind, &c.Detail); err != nil {
				return err
			}
			clashes = append(clashes, c)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(clashes) > 0 && strings.TrimSpace(req.OverrideReason) == "" {
			// Rolls the whole batch back, which is the point: a fortnight of
			// gate duty half written because Wednesday clashed is worse than
			// none of it, and the caller has to be able to retry the same
			// request with a reason and get the same rows.
			return errTeachingClash
		}
		return nil
	})

	switch {
	case errors.Is(err, errTeachingClash):
		// The list is part of the refusal, not a second request. A 409 that
		// says "something clashed" and makes the user go and find out which
		// is a 409 the user works around by overriding blindly.
		httpx.JSON(w, http.StatusConflict, map[string]any{
			"error": map[string]any{
				"code":       "roster_clash",
				"message":    errTeachingClash.Error(),
				"request_id": httpx.RequestIDFrom(r.Context()),
			},
			"clashes": clashes,
		})
		return
	case errors.Is(err, pgx.ErrNoRows):
		httpx.BadRequest(w, r, "no active shift with that id")
		return
	case err != nil:
		var pg *pgconn.PgError
		if errors.As(err, &pg) && (pg.Code == "23514" || pg.Code == "P0001") {
			// The two the database refuses outright: already on duty at that
			// time, or on approved leave. No reason overrides either.
			httpx.Error(w, r, http.StatusConflict, "refused", pg.Message)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"assigned": created, "clashes": clashes,
	})
}

var errTeachingClash = errors.New(
	"one or more of these duties falls in a period the person teaches or has declared unavailable; " +
		"send override_reason to roster them anyway, or call /hr-growth/roster/conflicts to see which")

func (s *Server) cancelDuty(w http.ResponseWriter, r *http.Request) {
	duty, ok := growthPathID(w, r)
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason,omitempty"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	ok = s.growthTxn(w, r, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE duty_assignments
			   SET status = 'cancelled', notes = COALESCE($2, notes)
			 WHERE id = $1 AND status <> 'cancelled'`, duty, nullString(req.Reason))
		if err == nil && tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return err
	})
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": duty.String(), "status": "cancelled"})
}

// listRosterConflicts recomputes every clash over a range.
//
// Recomputed, not stored. Leave is approved and timetables are republished
// after a roster is written, so a check that only ran at assignment time is
// stale by the following Monday — and a stale roster means an unmanned gate.
func (s *Server) listRosterConflicts(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	from, to := growthRange(r)
	items, err := collect(s, r, `
		SELECT to_char(c.on_date,'YYYY-MM-DD'), u.full_name, c.kind, c.detail
		  FROM duty_roster_conflicts($1, $2::date, $3::date) c
		  JOIN users u ON u.id = c.user_id
		 ORDER BY c.on_date, u.full_name`,
		[]any{id.InstitutionID, from, to},
		func(rows pgx.Rows) (rosterClash, error) {
			var v rosterClash
			return v, rows.Scan(&v.OnDate, &v.User, &v.Kind, &v.Detail)
		})
	respond(w, r, items, err)
}

type dutyFairnessRow struct {
	UserID        string  `json:"user_id"`
	FullName      string  `json:"full_name"`
	EmployeeCode  *string `json:"employee_code,omitempty"`
	Department    *string `json:"department,omitempty"`
	Duties        int     `json:"duties"`
	OnerousDuties int     `json:"onerous_duties"`
	Hours         float64 `json:"hours"`
	// How this person's share of the unpopular duties compares with the
	// average, as a multiple. 2.0 means twice everybody else's.
	OnerousIndex *float64 `json:"onerous_index,omitempty"`
}

/*
getRosterFairness answers the staff room's actual question.

	Not "who is on duty" but "why is it always me". Counts per person over a
	range, split out by whether the duty is one of the ones nobody wants, with
	each person's share expressed against the average so a number is
	comparable rather than merely large. is_onerous on duty_shifts is what
	makes this answerable at all; without it, three library slots and three
	seven o'clock gates look identical.
*/
func (s *Server) getRosterFairness(w http.ResponseWriter, r *http.Request) {
	from, to := growthRange(r)
	items, err := collect(s, r, `
		WITH counted AS (
		    SELECT a.user_id,
		           count(*)::int AS duties,
		           count(*) FILTER (WHERE sh.is_onerous)::int AS onerous,
		           sum(EXTRACT(epoch FROM (a.ends_at - a.starts_at)) / 3600.0) AS hours
		      FROM duty_assignments a
		      JOIN duty_shifts sh ON sh.id = a.shift_id
		     WHERE a.on_date BETWEEN $1::date AND $2::date
		       AND a.status <> 'cancelled'
		     GROUP BY a.user_id
		)
		SELECT c.user_id::text, u.full_name, e.employee_code, d.name,
		       c.duties, c.onerous, c.hours::float8,
		       CASE WHEN (SELECT avg(onerous) FROM counted) > 0
		            THEN (c.onerous / (SELECT avg(onerous) FROM counted))::float8
		       END
		  FROM counted c
		  JOIN users u ON u.id = c.user_id
		  LEFT JOIN employees e ON e.user_id = c.user_id
		  LEFT JOIN departments d ON d.id = e.department_id
		 -- Whoever is carrying the most of the unpopular work, first.
		 ORDER BY c.onerous DESC, c.duties DESC`, []any{from, to},
		func(rows pgx.Rows) (dutyFairnessRow, error) {
			var v dutyFairnessRow
			return v, rows.Scan(&v.UserID, &v.FullName, &v.EmployeeCode, &v.Department,
				&v.Duties, &v.OnerousDuties, &v.Hours, &v.OnerousIndex)
		})
	respond(w, r, items, err)
}
