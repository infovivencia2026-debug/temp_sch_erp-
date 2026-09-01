package api

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/timetable"
)

/* Three features that are one subject: the timetable, from three desks.

   The optimizer proposes a week. The head of department reads their slice of
   it and sees who is over their load and which requirements are unmet. The
   teacher who will be away asks for their periods to be covered, and the
   approver is shown who is actually free. One model underneath all three, and
   the model was already here — 00001 carries periods, timetable_entries with
   the two clash indexes on it, section_subject_teachers and substitutions, and
   internal/api/admin_academics.go already runs the morning substitution board
   off them.

   What this file adds is the four things that were missing: how many periods a
   week a subject needs, how much a teacher may be given, a draft that is not
   the live grid, and the record of the ask that precedes a substitution.

   Deliberately absent:

     A solver. internal/timetable is a constraint-satisfying generator with a
     bounded repair pass, and it is honest about being one. It produces a
     candidate and a written list of what it could not do; a human publishes.

     A notification system. Approving a substitution emits a message event
     through the existing messaging foundation (EmitMessageEvent). No provider,
     template or recipient is named here, because who hears about a
     substitution is the school's configuration.

     A second substitutions table. Approval writes into the existing one, so
     the morning board, "today's classes" and the payroll proxy allowance all
     see an approved request without knowing this file exists.
*/

// mountTimetableOps hangs the three timetable-operations trees off the caller's
// router. Paths are absolute within the group, and each subtree carries its own
// permission middleware rather than inheriting one, because the three belong to
// three different desks and one shared gate would be wrong for two of them.
//
// The prefixes are new on purpose. /timetable, /timetable-admin, /department
// and /teaching are already routed in api.go, and chi panics when a pattern is
// mounted twice.
func (s *Server) mountTimetableOps(r chi.Router) {
	// Reading a timetable. Every member of teaching staff holds this.
	ttRead := httpx.RequirePermission(rbac.TimetableRead)
	// Changing one. The permission POST /timetable-admin/substitutions already
	// requires, so nothing here offers a button its holder cannot press.
	ttWrite := httpx.RequirePermission(rbac.TimetableWrite)

	/* super_admin.ai_automation.automated_timetable_optimizer

	   Reads are on timetable.read so a head of department can look at a draft
	   somebody else generated; every write is timetable.write. Publishing is
	   the write that matters and is deliberately a separate call from
	   generating — a generator that publishes is a generator that has
	   overwritten a live timetable mid-term. */
	r.Route("/timetable-optimizer", func(r chi.Router) {
		r.Use(ttRead)
		r.Get("/inputs", s.getOptimizerInputs)
		r.Get("/drafts", s.listTimetableDrafts)
		r.Get("/drafts/{id}", s.getTimetableDraft)

		r.With(ttWrite).Post("/drafts", s.generateTimetableDraft)
		r.With(ttWrite).Post("/drafts/{id}/publish", s.publishTimetableDraft)
		r.With(ttWrite).Post("/drafts/{id}/discard", s.discardTimetableDraft)
		r.With(ttWrite).Put("/requirements", s.saveSubjectRequirement)
		r.With(ttWrite).Put("/load-rules", s.saveTeacherLoadRule)
		r.With(ttWrite).Post("/unavailability", s.saveTeacherUnavailability)
		r.With(ttWrite).Delete("/unavailability/{id}", s.deleteTeacherUnavailability)
	})

	/* institution_admin.department.department_timetable

	   Read-only, and scoped on the server: resolveRollupScope gives a head of
	   department their own departments and a principal every one. The screen
	   does not choose — it asks, and the handler answers with what the caller
	   is entitled to. */
	r.Route("/department-timetable", func(r chi.Router) {
		r.Use(ttRead)
		r.Get("/", s.getDepartmentTimetable)
	})

	/* faculty.timetable.substitution_request_submission

	   Submitting is timetable.read plus an ownership check in the handler: a
	   teacher asking for their own periods to be covered is not editing the
	   timetable, and requiring timetable.write would mean only the office
	   could ask. Deciding is timetable.write, because approving writes the
	   cover into the day's grid. */
	r.Route("/timetable-cover", func(r chi.Router) {
		r.Use(ttRead)
		r.Get("/my-periods", s.listCoverablePeriods)
		r.Get("/requests", s.listCoverRequests)
		r.Get("/requests/{id}", s.getCoverRequest)
		r.Post("/requests", s.createCoverRequest)
		r.Post("/requests/{id}/cancel", s.cancelCoverRequest)
		r.With(ttWrite).Post("/requests/{id}/decide", s.decideCoverRequest)
	})
}

// ============================================================ shared reading

// gridPeriod is one teaching period of the day. Named apart from the existing
// `period` in timetable.go, which is the same row with a different shape and
// belongs to the read-only grid endpoint.
type gridPeriod struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Sequence int    `json:"sequence"`
	StartsAt string `json:"starts_at"`
	EndsAt   string `json:"ends_at"`
	IsBreak  bool   `json:"is_break"`
}

// teachingWeekdays is Monday to Saturday. Most Indian schools teach six days;
// the ones that do not simply have no periods on Saturday, and an empty column
// is a truer thing to show than a week that silently lost a day.
var teachingWeekdays = []int{1, 2, 3, 4, 5, 6}

// loadPeriods reads the day's shape. Breaks are returned too — the grid draws
// them — and the generator is given only the teaching ones.
func loadPeriods(ctx context.Context, tx pgx.Tx) ([]gridPeriod, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, sequence, to_char(starts_at,'HH24:MI'),
		       to_char(ends_at,'HH24:MI'), is_break
		  FROM periods ORDER BY sequence`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []gridPeriod{}
	for rows.Next() {
		var p gridPeriod
		if err := rows.Scan(&p.ID, &p.Name, &p.Sequence, &p.StartsAt, &p.EndsAt, &p.IsBreak); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// resolveYear returns the requested academic year, or the current one. A
// timetable belongs to a year and a handler that guesses wrong writes into the
// wrong one, so this returns an error rather than a zero uuid.
func resolveYear(ctx context.Context, tx pgx.Tx, want string) (uuid.UUID, error) {
	if want = strings.TrimSpace(want); want != "" {
		return uuid.Parse(want)
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx,
		`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&id)
	return id, err
}

// ==================================================== 1. the optimizer inputs

type optimizerRequirement struct {
	ClassSubjectID string  `json:"class_subject_id"`
	SubjectName    string  `json:"subject_name"`
	SubjectCode    string  `json:"subject_code"`
	PeriodsPerWeek int     `json:"periods_per_week"`
	PrefersMorning bool    `json:"prefers_morning"`
	TeacherID      *string `json:"teacher_id,omitempty"`
	TeacherName    *string `json:"teacher_name,omitempty"`
}

type optimizerSection struct {
	ID           string                 `json:"id"`
	Name         string                 `json:"name"`
	ClassName    string                 `json:"class_name"`
	Level        int                    `json:"level"`
	Requirements []optimizerRequirement `json:"requirements"`
	Required     int                    `json:"required_periods"`
}

type optimizerTeacher struct {
	UserID     string `json:"user_id"`
	FullName   string `json:"full_name"`
	Code       string `json:"employee_code"`
	Department string `json:"department,omitempty"`
	MaxPerDay  int    `json:"max_periods_per_day"`
	MaxPerWeek int    `json:"max_periods_per_week"`
	// Demand is what the requirements ask of them; Scheduled is what the live
	// timetable already gives them. The two differ whenever the requirements
	// have been edited since the grid was last built, which is exactly when
	// somebody opens this screen.
	Demand      int       `json:"demand_periods"`
	Scheduled   int       `json:"scheduled_periods"`
	Unavailable []slotRef `json:"unavailable"`
}

type slotRef struct {
	ID       string  `json:"id,omitempty"`
	Weekday  int     `json:"weekday"`
	PeriodID *string `json:"period_id,omitempty"`
	Reason   *string `json:"reason,omitempty"`
}

/*
getOptimizerInputs is everything the generator will be given, before it runs.

	Shown first and on its own screen because the commonest outcome of a
	timetable generator is a run that fails for a reason visible in its input:
	nobody ever said how many periods a week Class 8 Maths wants, or three
	subjects name a teacher who left in June. Discovering that from a failure
	report after a run is slower than reading it here, and a school that sees
	"11 subjects have no weekly requirement" fixes it in five minutes.
*/
func (s *Server) getOptimizerInputs(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()

	var (
		yearID   uuid.UUID
		periods  []gridPeriod
		sections []optimizerSection
		teachers []optimizerTeacher
	)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		if yearID, err = resolveYear(r.Context(), tx, q.Get("academic_year_id")); err != nil {
			return err
		}
		if periods, err = loadPeriods(r.Context(), tx); err != nil {
			return err
		}

		// One row per (section, class subject). The teacher comes from
		// section_subject_teachers, which is where faculty allocation already
		// stores it; a second idea of "who teaches this" is how two screens
		// end up disagreeing.
		rows, err := tx.Query(r.Context(), `
			SELECT sec.id::text, sec.name, c.name, c.level,
			       cs.id::text, sub.name, sub.code,
			       cs.periods_per_week, cs.prefers_morning,
			       sst.teacher_user_id::text, u.full_name
			  FROM sections sec
			  JOIN classes c         ON c.id = sec.class_id
			  JOIN class_subjects cs ON cs.class_id = sec.class_id
			  JOIN subjects sub      ON sub.id = cs.subject_id
			  LEFT JOIN section_subject_teachers sst
			         ON sst.section_id = sec.id AND sst.class_subject_id = cs.id
			  LEFT JOIN users u ON u.id = sst.teacher_user_id
			 WHERE sec.academic_year_id = $1
			   AND ($2::uuid IS NULL OR sec.campus_id = $2)
			 ORDER BY c.level, sec.name, sub.name`,
			yearID, nullString(q.Get("campus_id")))
		if err != nil {
			return err
		}
		defer rows.Close()

		bySection := map[string]int{}
		for rows.Next() {
			var secID, secName, className string
			var level int
			var req optimizerRequirement
			if err := rows.Scan(&secID, &secName, &className, &level,
				&req.ClassSubjectID, &req.SubjectName, &req.SubjectCode,
				&req.PeriodsPerWeek, &req.PrefersMorning,
				&req.TeacherID, &req.TeacherName); err != nil {
				return err
			}
			idx, seen := bySection[secID]
			if !seen {
				idx = len(sections)
				bySection[secID] = idx
				sections = append(sections, optimizerSection{
					ID: secID, Name: secName, ClassName: className, Level: level,
					Requirements: []optimizerRequirement{},
				})
			}
			sections[idx].Requirements = append(sections[idx].Requirements, req)
			sections[idx].Required += req.PeriodsPerWeek
		}
		if err := rows.Err(); err != nil {
			return err
		}

		teachers, err = s.loadOptimizerTeachers(r.Context(), tx, yearID, nullString(q.Get("campus_id")))
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	teaching := 0
	for _, p := range periods {
		if !p.IsBreak {
			teaching++
		}
	}
	cells := teaching * len(teachingWeekdays)

	required, noPeriods, noTeacher := 0, 0, 0
	for _, sec := range sections {
		required += sec.Required
		for _, rq := range sec.Requirements {
			if rq.PeriodsPerWeek == 0 {
				noPeriods++
			}
			if rq.TeacherID == nil && rq.PeriodsPerWeek > 0 {
				noTeacher++
			}
		}
	}
	overCap := 0
	for _, t := range teachers {
		if t.Demand > t.MaxPerWeek {
			overCap++
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"academic_year_id": yearID.String(),
		"weekdays":         teachingWeekdays,
		"periods":          periods,
		"sections":         sections,
		"teachers":         teachers,
		"summary": map[string]any{
			"sections":              len(sections),
			"teaching_slots_a_week": cells,
			"required_periods":      required,
			// The three numbers that decide whether a run is worth starting.
			"subjects_without_requirement": noPeriods,
			"subjects_without_teacher":     noTeacher,
			"teachers_over_cap":            overCap,
		},
	})
}

// loadOptimizerTeachers reads every teacher the generator may use, with their
// caps, their unavailable slots, what the requirements demand of them and what
// the live grid already gives them.
func (s *Server) loadOptimizerTeachers(ctx context.Context, tx pgx.Tx, yearID uuid.UUID, campus *string) ([]optimizerTeacher, error) {

	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.full_name, e.employee_code,
		       COALESCE(d.name, ''),
		       COALESCE(lr.max_periods_per_day, 6),
		       COALESCE(lr.max_periods_per_week, 35),
		       COALESCE((SELECT sum(cs.periods_per_week)::int
		                   FROM section_subject_teachers sst
		                   JOIN class_subjects cs ON cs.id = sst.class_subject_id
		                   JOIN sections sec ON sec.id = sst.section_id
		                  WHERE sst.teacher_user_id = u.id
		                    AND sec.academic_year_id = $1), 0),
		       COALESCE((SELECT count(*)::int FROM timetable_entries te
		                  WHERE te.teacher_user_id = u.id
		                    AND te.academic_year_id = $1), 0)
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		  LEFT JOIN departments d ON d.id = e.department_id
		  LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id
		 WHERE e.status IN ('active','on_leave')
		   AND ($2::uuid IS NULL OR e.campus_id = $2)
		 ORDER BY u.full_name`, yearID, campus)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []optimizerTeacher{}
	byID := map[string]int{}
	for rows.Next() {
		var t optimizerTeacher
		if err := rows.Scan(&t.UserID, &t.FullName, &t.Code, &t.Department,
			&t.MaxPerDay, &t.MaxPerWeek, &t.Demand, &t.Scheduled); err != nil {
			return nil, err
		}
		t.Unavailable = []slotRef{}
		byID[t.UserID] = len(out)
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	urows, err := tx.Query(ctx, `
		SELECT id::text, teacher_user_id::text, weekday, period_id::text, reason
		  FROM teacher_unavailability ORDER BY weekday`)
	if err != nil {
		return nil, err
	}
	defer urows.Close()
	for urows.Next() {
		var sr slotRef
		var owner string
		if err := urows.Scan(&sr.ID, &owner, &sr.Weekday, &sr.PeriodID, &sr.Reason); err != nil {
			return nil, err
		}
		if i, ok := byID[owner]; ok {
			out[i].Unavailable = append(out[i].Unavailable, sr)
		}
	}
	return out, urows.Err()
}

// ===================================================== 1. generating a draft

type draftRequest struct {
	AcademicYearID string   `json:"academic_year_id"`
	CampusID       string   `json:"campus_id,omitempty"`
	SectionIDs     []string `json:"section_ids,omitempty"`
	Name           string   `json:"name,omitempty"`
	Seed           int64    `json:"seed,omitempty"`
	RetryBudget    int      `json:"retry_budget,omitempty"`
}

type draftRow struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Status      string  `json:"status"`
	Seed        int64   `json:"seed"`
	YearID      string  `json:"academic_year_id"`
	YearName    string  `json:"academic_year"`
	Required    int     `json:"periods_required"`
	Placed      int     `json:"periods_placed"`
	Blocking    int     `json:"blocking_issues"`
	Warnings    int     `json:"warning_issues"`
	GeneratedBy *string `json:"generated_by,omitempty"`
	GeneratedAt string  `json:"generated_at"`
	PublishedBy *string `json:"published_by,omitempty"`
	PublishedAt *string `json:"published_at,omitempty"`
	Sections    int     `json:"sections"`
}

type draftEntryRow struct {
	ID          string  `json:"id"`
	SectionID   string  `json:"section_id"`
	SectionName string  `json:"section_name"`
	ClassName   string  `json:"class_name"`
	PeriodID    string  `json:"period_id"`
	PeriodName  string  `json:"period_name"`
	Weekday     int     `json:"weekday"`
	SubjectName string  `json:"subject_name"`
	SubjectCode string  `json:"subject_code"`
	TeacherID   *string `json:"teacher_id,omitempty"`
	TeacherName *string `json:"teacher_name,omitempty"`
	Room        *string `json:"room,omitempty"`
}

type draftIssueRow struct {
	Kind        string  `json:"kind"`
	Severity    string  `json:"severity"`
	SectionName *string `json:"section_name,omitempty"`
	SubjectName *string `json:"subject_name,omitempty"`
	TeacherName *string `json:"teacher_name,omitempty"`
	Required    int     `json:"periods_required"`
	Placed      int     `json:"periods_placed"`
	Detail      string  `json:"detail"`
}

/*
generateTimetableDraft runs the generator and stores the candidate.

	Nothing here touches timetable_entries. The run produces a draft plus the
	report of what it could not do, and publishing is a separate, explicit
	call. A generator that writes the live grid has replaced the arrangement a
	school is mid-term through, and the previous one existed only in those rows.

	Sections outside the run are not ignored: every period their teachers
	already hold is passed to the solver as committed load, so a draft for
	Class 6 cannot double-book the teacher who also takes Class 9.
*/
func (s *Server) generateTimetableDraft(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req draftRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var sectionFilter []uuid.UUID
	for _, raw := range req.SectionIDs {
		sid, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			httpx.BadRequest(w, r, "section_ids must be uuids")
			return
		}
		sectionFilter = append(sectionFilter, sid)
	}

	var out draftRow
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		yearID, err := resolveYear(r.Context(), tx, req.AcademicYearID)
		if err != nil {
			return errNoAcademicYear
		}
		periods, err := loadPeriods(r.Context(), tx)
		if err != nil {
			return err
		}

		grid := timetable.Grid{Weekdays: teachingWeekdays}
		for _, p := range periods {
			if !p.IsBreak {
				grid.Periods = append(grid.Periods, timetable.Period{
					ID: p.ID, Name: p.Name, Sequence: p.Sequence,
				})
			}
		}
		if len(grid.Periods) == 0 {
			return errNoPeriods
		}

		reqs, inScope, err := loadSolverRequirements(r.Context(), tx, yearID,
			nullString(req.CampusID), sectionFilter)
		if err != nil {
			return err
		}
		if len(reqs) == 0 {
			return errNothingToPlace
		}
		teachers, err := loadSolverTeachers(r.Context(), tx, yearID, inScope)
		if err != nil {
			return err
		}

		res := timetable.Generate(timetable.Input{
			Grid: grid, Requirements: reqs, Teachers: teachers,
			Seed: req.Seed, RetryBudget: req.RetryBudget,
		})

		blocking, warnings := 0, 0
		for _, is := range res.Issues {
			if is.Severity == timetable.SeverityBlocking {
				blocking++
			} else {
				warnings++
			}
		}
		name := strings.TrimSpace(req.Name)
		if name == "" {
			// "Draft" is a word from the office, not the staff room. What this
			// row is, to the person reading it, is a timetable somebody made
			// on a day and has not put in use.
			name = "Made " + nowInIndia().Format("2 Jan 2006, 15:04")
		}

		var draftID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO timetable_drafts (institution_id, campus_id, academic_year_id,
			        name, seed, periods_required, periods_placed,
			        blocking_issues, warning_issues, generated_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			RETURNING id`,
			id.InstitutionID, nullString(req.CampusID), yearID, name, req.Seed,
			res.Required, res.Placed, blocking, warnings, id.UserID).Scan(&draftID); err != nil {
			return err
		}

		for _, p := range res.Placements {
			var teacher any
			if p.TeacherID != "" {
				teacher = p.TeacherID
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO timetable_draft_entries (institution_id, draft_id, section_id,
				        period_id, weekday, class_subject_id, teacher_user_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				id.InstitutionID, draftID, p.SectionID, p.PeriodID, p.Weekday,
				p.ClassSubjectID, teacher); err != nil {
				return err
			}
		}
		for _, is := range res.Issues {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO timetable_draft_issues (institution_id, draft_id, kind, severity,
				        section_id, class_subject_id, teacher_user_id,
				        periods_required, periods_placed, detail)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
				id.InstitutionID, draftID, is.Kind, is.Severity,
				nullString(is.SectionID), nullString(is.ClassSubjectID),
				nullString(is.TeacherID), is.Required, is.Placed, is.Detail); err != nil {
				return err
			}
		}

		out = draftRow{
			ID: draftID.String(), Name: name, Status: "draft", Seed: req.Seed,
			YearID: yearID.String(), Required: res.Required, Placed: res.Placed,
			Blocking: blocking, Warnings: warnings, Sections: len(inScope),
			GeneratedAt: nowInIndia().Format(time.RFC3339),
		}
		return nil
	})
	switch {
	case errors.Is(err, errNoAcademicYear):
		httpx.BadRequest(w, r, "no academic year. Create one before generating a timetable")
		return
	case errors.Is(err, errNoPeriods):
		httpx.BadRequest(w, r, "no teaching periods are configured; set the day's periods first")
		return
	case errors.Is(err, errNothingToPlace):
		httpx.BadRequest(w, r,
			"no subject has a weekly period requirement yet. Set periods per week before generating")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, out)
}

var (
	errNoPeriods      = errors.New("no teaching periods")
	errNothingToPlace = errors.New("no requirement to place")
	errDraftNotOpen   = errors.New("draft is not open")
	errDraftBlocked   = errors.New("draft has unmet requirements")
	errGridMoved      = errors.New("the live timetable changed under the draft")
	errNotYourPeriod  = errors.New("that period is not yours")
	errRequestClosed  = errors.New("request already decided")
	errCoverBusy      = errors.New("substitute is not free")
)

// loadSolverRequirements reads one row per (section, subject) that wants
// periods, and returns the sections the run covers.
func loadSolverRequirements(ctx context.Context, tx pgx.Tx, yearID uuid.UUID, campus *string, sections []uuid.UUID) (
	[]timetable.Requirement, []uuid.UUID, error) {

	rows, err := tx.Query(ctx, `
		SELECT sec.id::text, c.name || '-' || sec.name,
		       cs.id::text, sub.name, cs.periods_per_week, cs.prefers_morning,
		       COALESCE(sst.teacher_user_id::text, '')
		  FROM sections sec
		  JOIN classes c         ON c.id = sec.class_id
		  JOIN class_subjects cs ON cs.class_id = sec.class_id
		  JOIN subjects sub      ON sub.id = cs.subject_id
		  LEFT JOIN section_subject_teachers sst
		         ON sst.section_id = sec.id AND sst.class_subject_id = cs.id
		 WHERE sec.academic_year_id = $1
		   AND cs.periods_per_week > 0
		   AND ($2::uuid IS NULL OR sec.campus_id = $2)
		   AND ($3::uuid[] IS NULL OR sec.id = ANY($3))
		 ORDER BY c.level, sec.name, sub.name`,
		yearID, campus, nullUUIDs(sections))
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	out := []timetable.Requirement{}
	seen := map[string]bool{}
	inScope := []uuid.UUID{}
	for rows.Next() {
		var req timetable.Requirement
		if err := rows.Scan(&req.SectionID, &req.SectionName, &req.ClassSubjectID,
			&req.SubjectName, &req.PeriodsPerWeek, &req.Difficult, &req.TeacherID); err != nil {
			return nil, nil, err
		}
		out = append(out, req)
		if !seen[req.SectionID] {
			seen[req.SectionID] = true
			if sid, err := uuid.Parse(req.SectionID); err == nil {
				inScope = append(inScope, sid)
			}
		}
	}
	return out, inScope, rows.Err()
}

/*
loadSolverTeachers reads caps, unavailability and committed load.

	Committed is the load this run does not control: every period the teacher
	already holds in a section the draft is *not* replacing. Without it a draft
	for Class 6 happily books the Physics teacher into a slot where Class 11 is
	already sitting in front of her, and the clash only surfaces at publish,
	when the unique index refuses the insert and the whole run is wasted.
*/
func loadSolverTeachers(ctx context.Context, tx pgx.Tx, yearID uuid.UUID, inScope []uuid.UUID) ([]timetable.Teacher, error) {

	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.full_name,
		       COALESCE(lr.max_periods_per_day, 6),
		       COALESCE(lr.max_periods_per_week, 35)
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		  LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id
		 WHERE e.status IN ('active','on_leave')
		 ORDER BY u.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []timetable.Teacher{}
	at := map[string]int{}
	for rows.Next() {
		var t timetable.Teacher
		if err := rows.Scan(&t.UserID, &t.Name, &t.MaxPerDay, &t.MaxPerWeek); err != nil {
			return nil, err
		}
		at[t.UserID] = len(out)
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Recurring unavailability. A NULL period means the whole day, expanded
	// here so the solver never has to know about the shorthand.
	urows, err := tx.Query(ctx, `
		SELECT tu.teacher_user_id::text, tu.weekday, p.id::text
		  FROM teacher_unavailability tu
		  JOIN periods p ON (tu.period_id IS NULL OR p.id = tu.period_id)
		 WHERE NOT p.is_break`)
	if err != nil {
		return nil, err
	}
	defer urows.Close()
	for urows.Next() {
		var owner, periodID string
		var weekday int
		if err := urows.Scan(&owner, &weekday, &periodID); err != nil {
			return nil, err
		}
		if i, ok := at[owner]; ok {
			out[i].Unavailable = append(out[i].Unavailable,
				timetable.Slot{Weekday: weekday, PeriodID: periodID})
		}
	}
	if err := urows.Err(); err != nil {
		return nil, err
	}

	crows, err := tx.Query(ctx, `
		SELECT te.teacher_user_id::text, te.weekday, te.period_id::text
		  FROM timetable_entries te
		 WHERE te.teacher_user_id IS NOT NULL
		   AND te.academic_year_id = $1
		   AND NOT (te.section_id = ANY($2))`, yearID, inScope)
	if err != nil {
		return nil, err
	}
	defer crows.Close()
	for crows.Next() {
		var owner, periodID string
		var weekday int
		if err := crows.Scan(&owner, &weekday, &periodID); err != nil {
			return nil, err
		}
		if i, ok := at[owner]; ok {
			out[i].Committed = append(out[i].Committed,
				timetable.Slot{Weekday: weekday, PeriodID: periodID})
		}
	}
	return out, crows.Err()
}

// ======================================================== 1. reading a draft

func (s *Server) listTimetableDrafts(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT d.id::text, d.name, d.status, d.seed,
		       d.academic_year_id::text, ay.name,
		       d.periods_required, d.periods_placed, d.blocking_issues, d.warning_issues,
		       gu.full_name, to_char(d.generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       pu.full_name, to_char(d.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       (SELECT count(DISTINCT de.section_id)::int FROM timetable_draft_entries de
		         WHERE de.draft_id = d.id)
		  FROM timetable_drafts d
		  JOIN academic_years ay ON ay.id = d.academic_year_id
		  LEFT JOIN users gu ON gu.id = d.generated_by
		  LEFT JOIN users pu ON pu.id = d.published_by
		 WHERE ($1::uuid IS NULL OR d.academic_year_id = $1)
		 ORDER BY d.generated_at DESC
		 LIMIT 100`,
		[]any{nullString(r.URL.Query().Get("academic_year_id"))},
		func(rows pgx.Rows) (draftRow, error) {
			var v draftRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Status, &v.Seed, &v.YearID, &v.YearName,
				&v.Required, &v.Placed, &v.Blocking, &v.Warnings,
				&v.GeneratedBy, &v.GeneratedAt, &v.PublishedBy, &v.PublishedAt, &v.Sections)
		})
	respond(w, r, items, err)
}

// getTimetableDraft returns the candidate grid and, first, the report on it.
func (s *Server) getTimetableDraft(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	draftID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}

	var (
		head    draftRow
		entries []draftEntryRow
		issues  []draftIssueRow
		periods []gridPeriod
		found   bool
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT d.id::text, d.name, d.status, d.seed,
			       d.academic_year_id::text, ay.name,
			       d.periods_required, d.periods_placed, d.blocking_issues, d.warning_issues,
			       gu.full_name, to_char(d.generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       pu.full_name, to_char(d.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       (SELECT count(DISTINCT de.section_id)::int FROM timetable_draft_entries de
			         WHERE de.draft_id = d.id)
			  FROM timetable_drafts d
			  JOIN academic_years ay ON ay.id = d.academic_year_id
			  LEFT JOIN users gu ON gu.id = d.generated_by
			  LEFT JOIN users pu ON pu.id = d.published_by
			 WHERE d.id = $1`, draftID).Scan(
			&head.ID, &head.Name, &head.Status, &head.Seed, &head.YearID, &head.YearName,
			&head.Required, &head.Placed, &head.Blocking, &head.Warnings,
			&head.GeneratedBy, &head.GeneratedAt, &head.PublishedBy, &head.PublishedAt,
			&head.Sections)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true

		if periods, err = loadPeriods(r.Context(), tx); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT de.id::text, de.section_id::text, sec.name, c.name,
			       de.period_id::text, p.name, de.weekday, sub.name, sub.code,
			       de.teacher_user_id::text, u.full_name, de.room
			  FROM timetable_draft_entries de
			  JOIN sections sec ON sec.id = de.section_id
			  JOIN classes c ON c.id = sec.class_id
			  JOIN periods p ON p.id = de.period_id
			  JOIN class_subjects cs ON cs.id = de.class_subject_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			  LEFT JOIN users u ON u.id = de.teacher_user_id
			 WHERE de.draft_id = $1
			 ORDER BY c.level, sec.name, de.weekday, p.sequence`, draftID)
		if err != nil {
			return err
		}
		defer rows.Close()
		entries = []draftEntryRow{}
		for rows.Next() {
			var v draftEntryRow
			if err := rows.Scan(&v.ID, &v.SectionID, &v.SectionName, &v.ClassName,
				&v.PeriodID, &v.PeriodName, &v.Weekday, &v.SubjectName, &v.SubjectCode,
				&v.TeacherID, &v.TeacherName, &v.Room); err != nil {
				return err
			}
			entries = append(entries, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		irows, err := tx.Query(r.Context(), `
			SELECT i.kind, i.severity, sec.name, sub.name, u.full_name,
			       i.periods_required, i.periods_placed, i.detail
			  FROM timetable_draft_issues i
			  LEFT JOIN sections sec ON sec.id = i.section_id
			  LEFT JOIN class_subjects cs ON cs.id = i.class_subject_id
			  LEFT JOIN subjects sub ON sub.id = cs.subject_id
			  LEFT JOIN users u ON u.id = i.teacher_user_id
			 WHERE i.draft_id = $1
			 ORDER BY (i.severity = 'blocking') DESC, sec.name NULLS FIRST, sub.name`, draftID)
		if err != nil {
			return err
		}
		defer irows.Close()
		issues = []draftIssueRow{}
		for irows.Next() {
			var v draftIssueRow
			if err := irows.Scan(&v.Kind, &v.Severity, &v.SectionName, &v.SubjectName,
				&v.TeacherName, &v.Required, &v.Placed, &v.Detail); err != nil {
				return err
			}
			issues = append(issues, v)
		}
		return irows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"draft": head, "entries": entries, "issues": issues,
		"periods": periods, "weekdays": teachingWeekdays,
	})
}

// ===================================================== 1. publish and discard

type draftPublishRequest struct {
	// Acknowledged is the reviewer saying they have read the blocking issues
	// and want the draft anyway. Without it a draft with unmet requirements is
	// refused, which is the whole point of generating a draft rather than
	// writing the grid.
	Acknowledged bool `json:"acknowledge_unmet,omitempty"`
}

/*
publishTimetableDraft copies the candidate over the live grid.

	The one destructive act in this file, and the only one a human performs
	deliberately. It replaces the timetable for exactly the sections the draft
	covers, in exactly the draft's academic year — a draft for Class 6 does not
	touch Class 9, and a draft for last year does not touch this one.

	It refuses a draft with unmet requirements unless the caller says in the
	body that they have read them. A timetable published with two of Class 8B's
	Maths periods missing is a decision somebody should have made on purpose.
*/
func (s *Server) publishTimetableDraft(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	draftID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req draftPublishRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}

	var replaced, inserted, notified int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var yearID uuid.UUID
		var blocking int
		if err := tx.QueryRow(r.Context(), `
			SELECT status, academic_year_id, blocking_issues
			  FROM timetable_drafts WHERE id = $1 FOR UPDATE`, draftID).
			Scan(&status, &yearID, &blocking); err != nil {
			return err
		}
		if status != "draft" {
			return errDraftNotOpen
		}
		if blocking > 0 && !req.Acknowledged {
			return errDraftBlocked
		}

		// Exactly the sections this draft speaks for.
		var sections []uuid.UUID
		rows, err := tx.Query(r.Context(),
			`SELECT DISTINCT section_id FROM timetable_draft_entries WHERE draft_id = $1`, draftID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var sid uuid.UUID
			if err := rows.Scan(&sid); err != nil {
				rows.Close()
				return err
			}
			sections = append(sections, sid)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		tag, err := tx.Exec(r.Context(), `
			DELETE FROM timetable_entries
			 WHERE academic_year_id = $1 AND section_id = ANY($2)`, yearID, sections)
		if err != nil {
			return err
		}
		replaced = int(tag.RowsAffected())

		tag, err = tx.Exec(r.Context(), `
			INSERT INTO timetable_entries (institution_id, academic_year_id, section_id,
			        period_id, weekday, class_subject_id, teacher_user_id, room)
			SELECT de.institution_id, $2, de.section_id, de.period_id, de.weekday,
			       de.class_subject_id, de.teacher_user_id, de.room
			  FROM timetable_draft_entries de
			 WHERE de.draft_id = $1`, draftID, yearID)
		if err != nil {
			// timetable_teacher_slot is a unique index across the whole year.
			// A draft generated an hour ago can collide with a section
			// somebody has edited since, and the honest answer is to say so
			// rather than to drop the offending periods.
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "23505" {
				return errGridMoved
			}
			return err
		}
		inserted = int(tag.RowsAffected())

		_, err = tx.Exec(r.Context(), `
			UPDATE timetable_drafts
			   SET status = 'published', published_by = $2, published_at = now()
			 WHERE id = $1`, draftID, id.UserID)
		if err != nil {
			return err
		}
		/* TELL EVERYONE IT HAS CHANGED.

		   Publishing replaces the live grid, and until now nobody was told. A
		   teacher found out on Monday morning by walking to the wrong room; a
		   parent found out when their child came home and said so. Both had
		   the new timetable available to them in the app the whole time and no
		   reason to go and look at it.

		   Inside the transaction that publishes. A notification about a
		   timetable that then failed to publish is worse than silence — the
		   school would be told to check a grid that had not changed.

		   Only the sections this draft actually touched, and only the people
		   attached to them: a whole-school announcement about a change to two
		   sections is how a school learns to ignore this product's alerts. */
		told, nerr := announceTimetable(r, tx, id.InstitutionID, draftID)
		notified = told
		return nerr
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errDraftNotOpen):
		httpx.Error(w, r, http.StatusConflict, "draft_closed",
			"this draft has already been published or discarded")
		return
	case errors.Is(err, errDraftBlocked):
		httpx.Error(w, r, http.StatusConflict, "unmet_requirements",
			"this draft leaves requirements unmet; re-send with acknowledge_unmet to publish it anyway")
		return
	case errors.Is(err, errGridMoved):
		httpx.Error(w, r, http.StatusConflict, "grid_moved",
			"the live timetable has changed since this draft was generated; generate a fresh one")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"published": true, "periods_replaced": replaced, "periods_written": inserted,
		// So the screen can say who was told rather than only that it saved.
		"people_notified": notified,
	})
}

func (s *Server) discardTimetableDraft(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	draftID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE timetable_drafts SET status = 'discarded'
			 WHERE id = $1 AND status = 'draft'`, draftID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.Error(w, r, http.StatusConflict, "draft_closed",
			"this draft has already been published or discarded")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"discarded": true})
}

// ================================================ 1. the generator's own input

type requirementRequest struct {
	ClassSubjectID string `json:"class_subject_id"`
	PeriodsPerWeek int    `json:"periods_per_week"`
	PrefersMorning bool   `json:"prefers_morning"`
}

// saveSubjectRequirement sets how many periods a week a class subject wants.
func (s *Server) saveSubjectRequirement(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req requirementRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	csID, err := uuid.Parse(strings.TrimSpace(req.ClassSubjectID))
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	if req.PeriodsPerWeek < 0 || req.PeriodsPerWeek > 60 {
		httpx.BadRequest(w, r, "periods_per_week must be between 0 and 60")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE class_subjects
			   SET periods_per_week = $2, prefers_morning = $3
			 WHERE id = $1`, csID, req.PeriodsPerWeek, req.PrefersMorning)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

type loadRuleRequest struct {
	TeacherUserID string `json:"teacher_user_id"`
	MaxPerDay     int    `json:"max_periods_per_day"`
	MaxPerWeek    int    `json:"max_periods_per_week"`
	Notes         string `json:"notes,omitempty"`
}

// saveTeacherLoadRule sets one teacher's caps.
func (s *Server) saveTeacherLoadRule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req loadRuleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	userID, err := uuid.Parse(strings.TrimSpace(req.TeacherUserID))
	if err != nil {
		httpx.BadRequest(w, r, "teacher_user_id must be a uuid")
		return
	}
	if req.MaxPerDay < 1 || req.MaxPerDay > 20 {
		httpx.BadRequest(w, r, "max_periods_per_day must be between 1 and 20")
		return
	}
	if req.MaxPerWeek < req.MaxPerDay || req.MaxPerWeek > 80 {
		httpx.BadRequest(w, r,
			"max_periods_per_week must be at least the daily cap and no more than 80")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO teacher_load_rules (institution_id, teacher_user_id,
			        max_periods_per_day, max_periods_per_week, notes)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (institution_id, teacher_user_id) DO UPDATE
			   SET max_periods_per_day  = EXCLUDED.max_periods_per_day,
			       max_periods_per_week = EXCLUDED.max_periods_per_week,
			       notes                = EXCLUDED.notes,
			       updated_at           = now()`,
			id.InstitutionID, userID, req.MaxPerDay, req.MaxPerWeek, nullString(req.Notes))
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

type unavailabilityRequest struct {
	TeacherUserID string `json:"teacher_user_id"`
	Weekday       int    `json:"weekday"`
	PeriodID      string `json:"period_id,omitempty"`
	Reason        string `json:"reason,omitempty"`
}

// saveTeacherUnavailability marks a weekly-recurring slot as unusable. An empty
// period_id means the whole day.
func (s *Server) saveTeacherUnavailability(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req unavailabilityRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	userID, err := uuid.Parse(strings.TrimSpace(req.TeacherUserID))
	if err != nil {
		httpx.BadRequest(w, r, "teacher_user_id must be a uuid")
		return
	}
	if req.Weekday < 1 || req.Weekday > 7 {
		httpx.BadRequest(w, r, "weekday must be 1 (Monday) to 7")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO teacher_unavailability (institution_id, teacher_user_id,
			        weekday, period_id, reason)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (institution_id, teacher_user_id, weekday,
			             COALESCE(period_id,'00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET reason = EXCLUDED.reason`,
			id.InstitutionID, userID, req.Weekday,
			nullString(req.PeriodID), nullString(req.Reason))
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"saved": true})
}

func (s *Server) deleteTeacherUnavailability(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	rowID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `DELETE FROM teacher_unavailability WHERE id = $1`, rowID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// ================================================= 2. the department timetable

type deptGridEntry struct {
	TeacherID   string  `json:"teacher_id"`
	TeacherName string  `json:"teacher_name"`
	Weekday     int     `json:"weekday"`
	PeriodID    string  `json:"period_id"`
	SectionName string  `json:"section_name"`
	ClassName   string  `json:"class_name"`
	SubjectName string  `json:"subject_name"`
	Room        *string `json:"room,omitempty"`
}

type deptTeacherRow struct {
	UserID     string `json:"user_id"`
	FullName   string `json:"full_name"`
	Code       string `json:"employee_code"`
	Department string `json:"department"`
	Periods    int    `json:"periods"`
	MaxPerWeek int    `json:"max_periods_per_week"`
	MaxPerDay  int    `json:"max_periods_per_day"`
	FreeSlots  int    `json:"free_slots"`
	// over | under | ok. Computed here rather than in the browser because the
	// threshold is a school policy, not a display choice.
	Load string `json:"load"`
}

type deptRequirementRow struct {
	SectionName string  `json:"section_name"`
	ClassName   string  `json:"class_name"`
	SubjectName string  `json:"subject_name"`
	TeacherName *string `json:"teacher_name,omitempty"`
	Required    int     `json:"periods_required"`
	Scheduled   int     `json:"periods_scheduled"`
}

/*
getDepartmentTimetable is the head of department's slice of the week.

	Who is teaching what and when, where the free slots are, who is over or
	under their load, and which of the department's subject requirements the
	live grid does not meet. Four questions a HOD currently answers with a
	printed grid and a pen.

	Scope is decided here. resolveRollupScope gives a head of department their
	own departments and a principal every one — the discriminator being
	students.read.all, which institution_admin holds and hod deliberately does
	not. A department_id in the query is checked against that set rather than
	trusted, because a UI that only offers your own departments is not access
	control.
*/
func (s *Server) getDepartmentTimetable(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	q := r.URL.Query()

	var wanted *uuid.UUID
	if raw := strings.TrimSpace(q.Get("department_id")); raw != "" {
		did, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "department_id must be a uuid")
			return
		}
		if !b.All && !containsUUID(b.Depts, did) {
			httpx.Denied(w, r, "that department is not yours")
			return
		}
		wanted = &did
	}

	type deptRef struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	var (
		yearID   uuid.UUID
		periods  []gridPeriod
		depts    []deptRef
		teachers []deptTeacherRow
		entries  []deptGridEntry
		reqs     []deptRequirementRow
	)

	/* The department filter is written to reference $2 unconditionally.

	   rollupBoundary.deptPredicate returns a bare TRUE for a principal, and
	   three of the four queries below also carry $3 — so with TRUE spliced in,
	   $2 would be declared and never referenced, which pgx rejects outright
	   ("could not determine data type of parameter $2"). Every
	   department-scoped screen that took this shortcut has hit it eventually,
	   and it fails for exactly one class of user: the one with the widest
	   reach, who is the least likely to be the tester. */
	const deptScope = `($2::uuid[] IS NULL OR e.department_id = ANY($2))`
	// NULL means "every department"; an empty array means "none", which is the
	// right answer for a teacher who heads nothing and must not be widened to
	// the institution by an absent filter.
	var deptArg any
	if !b.All {
		depts := b.Depts
		if depts == nil {
			depts = []uuid.UUID{}
		}
		deptArg = depts
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		if yearID, err = resolveYear(r.Context(), tx, q.Get("academic_year_id")); err != nil {
			return err
		}
		if periods, err = loadPeriods(r.Context(), tx); err != nil {
			return err
		}

		dpred, darg := b.deptPredicate("d.id", 1)
		dargs := []any{}
		if darg != nil {
			dargs = append(dargs, darg)
		}
		drows, err := tx.Query(r.Context(),
			`SELECT d.id::text, d.name FROM departments d WHERE `+dpred+` ORDER BY d.name`, dargs...)
		if err != nil {
			return err
		}
		depts = []deptRef{}
		for drows.Next() {
			var d deptRef
			if err := drows.Scan(&d.ID, &d.Name); err != nil {
				drows.Close()
				return err
			}
			depts = append(depts, d)
		}
		drows.Close()
		if err := drows.Err(); err != nil {
			return err
		}

		// $1 the academic year, $2 the department scope, $3 the single
		// department the screen is looking at (NULL for all of them).
		args := []any{yearID, deptArg, wanted}

		trows, err := tx.Query(r.Context(), `
			SELECT u.id::text, u.full_name, e.employee_code, COALESCE(d.name,'—'),
			       COALESCE((SELECT count(*)::int FROM timetable_entries te
			                  WHERE te.teacher_user_id = u.id AND te.academic_year_id = $1), 0),
			       COALESCE(lr.max_periods_per_week, 35),
			       COALESCE(lr.max_periods_per_day, 6)
			  FROM employees e
			  JOIN users u ON u.id = e.user_id
			  LEFT JOIN departments d ON d.id = e.department_id
			  LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id
			 WHERE e.status IN ('active','on_leave')
			   AND `+deptScope+`
			   AND ($3::uuid IS NULL OR e.department_id = $3)
			 ORDER BY u.full_name`, args...)
		if err != nil {
			return err
		}
		teachers = []deptTeacherRow{}
		for trows.Next() {
			var v deptTeacherRow
			if err := trows.Scan(&v.UserID, &v.FullName, &v.Code, &v.Department,
				&v.Periods, &v.MaxPerWeek, &v.MaxPerDay); err != nil {
				trows.Close()
				return err
			}
			teachers = append(teachers, v)
		}
		trows.Close()
		if err := trows.Err(); err != nil {
			return err
		}

		erows, err := tx.Query(r.Context(), `
			SELECT te.teacher_user_id::text, u.full_name, te.weekday, te.period_id::text,
			       sec.name, c.name, sub.name, te.room
			  FROM timetable_entries te
			  JOIN users u ON u.id = te.teacher_user_id
			  JOIN employees e ON e.user_id = u.id
			  JOIN sections sec ON sec.id = te.section_id
			  JOIN classes c ON c.id = sec.class_id
			  JOIN class_subjects cs ON cs.id = te.class_subject_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			 WHERE te.academic_year_id = $1
			   AND `+deptScope+`
			   AND ($3::uuid IS NULL OR e.department_id = $3)
			 ORDER BY u.full_name, te.weekday`, args...)
		if err != nil {
			return err
		}
		entries = []deptGridEntry{}
		for erows.Next() {
			var v deptGridEntry
			if err := erows.Scan(&v.TeacherID, &v.TeacherName, &v.Weekday, &v.PeriodID,
				&v.SectionName, &v.ClassName, &v.SubjectName, &v.Room); err != nil {
				erows.Close()
				return err
			}
			entries = append(entries, v)
		}
		erows.Close()
		if err := erows.Err(); err != nil {
			return err
		}

		/* The requirements this department owns and the grid does not meet.

		   Keyed on the teacher's department rather than the subject's,
		   because a subject has no department in this schema — the person
		   teaching it does. A requirement with no teacher allocated therefore
		   belongs to nobody and is not listed here; the optimizer's input
		   screen is where an unallocated subject shows up. */
		rrows, err := tx.Query(r.Context(), `
			SELECT sec.name, c.name, sub.name, u.full_name,
			       cs.periods_per_week,
			       (SELECT count(*)::int FROM timetable_entries te
			         WHERE te.section_id = sec.id AND te.class_subject_id = cs.id
			           AND te.academic_year_id = $1)
			  FROM section_subject_teachers sst
			  JOIN sections sec ON sec.id = sst.section_id
			  JOIN classes c ON c.id = sec.class_id
			  JOIN class_subjects cs ON cs.id = sst.class_subject_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			  JOIN users u ON u.id = sst.teacher_user_id
			  JOIN employees e ON e.user_id = u.id
			 WHERE sec.academic_year_id = $1
			   AND cs.periods_per_week > 0
			   AND `+deptScope+`
			   AND ($3::uuid IS NULL OR e.department_id = $3)
			   AND cs.periods_per_week <> (SELECT count(*)::int FROM timetable_entries te
			                                WHERE te.section_id = sec.id
			                                  AND te.class_subject_id = cs.id
			                                  AND te.academic_year_id = $1)
			 ORDER BY c.level, sec.name, sub.name`, args...)
		if err != nil {
			return err
		}
		reqs = []deptRequirementRow{}
		for rrows.Next() {
			var v deptRequirementRow
			if err := rrows.Scan(&v.SectionName, &v.ClassName, &v.SubjectName,
				&v.TeacherName, &v.Required, &v.Scheduled); err != nil {
				rrows.Close()
				return err
			}
			reqs = append(reqs, v)
		}
		rrows.Close()
		return rrows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	teaching := 0
	for _, p := range periods {
		if !p.IsBreak {
			teaching++
		}
	}
	cells := teaching * len(teachingWeekdays)

	over, under, assigned, free := 0, 0, 0, 0
	for i := range teachers {
		t := &teachers[i]
		t.FreeSlots = cells - t.Periods
		if t.FreeSlots < 0 {
			t.FreeSlots = 0
		}
		assigned += t.Periods
		free += t.FreeSlots
		switch {
		case t.Periods > t.MaxPerWeek:
			t.Load = "over"
			over++
		// Two-thirds of the cap is the line at which a head of department
		// starts moving periods around. Below it somebody else is carrying
		// them.
		case t.Periods*3 < t.MaxPerWeek*2:
			t.Load = "under"
			under++
		default:
			t.Load = "ok"
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"academic_year_id": yearID.String(),
		"departments":      depts,
		"department_id":    wanted,
		"weekdays":         teachingWeekdays,
		"periods":          periods,
		"teachers":         teachers,
		"entries":          entries,
		"requirements":     reqs,
		"summary": map[string]any{
			"teachers":              len(teachers),
			"periods_assigned":      assigned,
			"free_slots":            free,
			"teaching_slots_a_week": cells,
			"over_loaded":           over,
			"under_loaded":          under,
			"unmet_requirements":    len(reqs),
		},
	})
}

func containsUUID(list []uuid.UUID, want uuid.UUID) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// ================================================ 3. asking for cover

type coverPeriodRow struct {
	TimetableEntryID string `json:"timetable_entry_id"`
	OnDate           string `json:"on_date"`
	Weekday          int    `json:"weekday"`
	PeriodID         string `json:"period_id"`
	PeriodName       string `json:"period_name"`
	StartsAt         string `json:"starts_at"`
	ClassName        string `json:"class_name"`
	SectionName      string `json:"section_name"`
	SubjectName      string `json:"subject_name"`
	// Already asked for, or already covered by somebody. Both mean the row is
	// not a candidate for a fresh request, and saying which is the difference
	// between "you did this yesterday" and "the office has dealt with it".
	AlreadyAsked bool    `json:"already_asked"`
	CoveredBy    *string `json:"covered_by,omitempty"`
}

/*
listCoverablePeriods expands the caller's week into the periods a request can
name, across a date range.

	The teacher picks dates; the school needs (period, date) pairs, because a
	colleague free on Tuesday's third period may be teaching in Wednesday's.
	Doing the expansion here rather than in the browser means the weekday
	arithmetic, the holiday calendar and the already-covered check all happen
	once, on the side that owns the timetable.

	Leave the teacher has already applied for is returned alongside. A school
	that runs leave properly should not make somebody type the same three days
	into a second form.
*/
func (s *Server) listCoverablePeriods(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()

	from, to, ok := coverRange(w, r, q.Get("from"), q.Get("to"))
	if !ok {
		return
	}

	// Looking at somebody else's periods is the office arranging cover on a
	// teacher's behalf, which is a timetable.write act.
	subject := id.UserID
	if raw := strings.TrimSpace(q.Get("teacher_id")); raw != "" {
		other, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "teacher_id must be a uuid")
			return
		}
		if other != id.UserID && !id.Can(rbac.TimetableWrite) {
			httpx.Forbidden(w, r, rbac.TimetableWrite)
			return
		}
		subject = other
	}

	type leaveRow struct {
		ID       string `json:"id"`
		FromDate string `json:"from_date"`
		ToDate   string `json:"to_date"`
		Reason   string `json:"reason"`
		Status   string `json:"status"`
	}
	var (
		items  []coverPeriodRow
		leaves []leaveRow
	)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* generate_series turns the range into dates and the join to weekday
		   turns the weekly grid into concrete periods. Holidays are excluded
		   through the holidays table the principal's calendar screen already
		   maintains — asking for cover on Republic Day is noise the approver
		   has to read past. */
		rows, err := tx.Query(r.Context(), `
			SELECT te.id::text, to_char(d.day,'YYYY-MM-DD'),
			       te.weekday, p.id::text, p.name, to_char(p.starts_at,'HH24:MI'),
			       c.name, sec.name, sub.name,
			       EXISTS (SELECT 1 FROM substitution_request_periods srp
			                WHERE srp.timetable_entry_id = te.id
			                  AND srp.on_date = d.day AND srp.status = 'pending'),
			       (SELECT su.full_name FROM substitutions sb
			          JOIN users su ON su.id = sb.substitute_user_id
			         WHERE sb.timetable_entry_id = te.id AND sb.on_date = d.day)
			  FROM generate_series($2::date, $3::date, interval '1 day') AS d(day)
			  JOIN timetable_entries te
			    ON te.weekday = extract(isodow FROM d.day)::int
			   AND te.teacher_user_id = $1
			  JOIN periods p ON p.id = te.period_id
			  JOIN sections sec ON sec.id = te.section_id
			  JOIN classes c ON c.id = sec.class_id
			  JOIN class_subjects cs ON cs.id = te.class_subject_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			 WHERE NOT EXISTS (SELECT 1 FROM holidays h
			                    WHERE h.kind IN ('holiday','vacation')
			                      AND h.applies_to IN ('all','staff')
			                      AND d.day BETWEEN h.on_date
			                                    AND COALESCE(h.to_date, h.on_date))
			 ORDER BY d.day, p.sequence`, subject, from, to)
		if err != nil {
			return err
		}
		defer rows.Close()
		items = []coverPeriodRow{}
		for rows.Next() {
			var v coverPeriodRow
			if err := rows.Scan(&v.TimetableEntryID, &v.OnDate, &v.Weekday, &v.PeriodID,
				&v.PeriodName, &v.StartsAt, &v.ClassName, &v.SectionName, &v.SubjectName,
				&v.AlreadyAsked, &v.CoveredBy); err != nil {
				return err
			}
			items = append(items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		lrows, err := tx.Query(r.Context(), `
			SELECT lr.id::text, to_char(lr.from_date,'YYYY-MM-DD'),
			       to_char(lr.to_date,'YYYY-MM-DD'), lr.reason, lr.status
			  FROM leave_requests lr
			  JOIN employees e ON e.id = lr.employee_id
			 WHERE lr.subject_kind = 'staff' AND e.user_id = $1
			   AND lr.status IN ('pending','approved')
			   AND lr.to_date >= $2::date AND lr.from_date <= $3::date
			 ORDER BY lr.from_date`, subject, from, to)
		if err != nil {
			return err
		}
		defer lrows.Close()
		leaves = []leaveRow{}
		for lrows.Next() {
			var v leaveRow
			if err := lrows.Scan(&v.ID, &v.FromDate, &v.ToDate, &v.Reason, &v.Status); err != nil {
				return err
			}
			leaves = append(leaves, v)
		}
		return lrows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "from": from, "to": to, "leave": leaves,
	})
}

// coverRange parses and bounds the date window. Defaults to the next
// fortnight, which is the horizon an advance leave request actually uses.
func coverRange(w http.ResponseWriter, r *http.Request, rawFrom, rawTo string) (string, string, bool) {
	today := nowInIndia()
	from, to := today, today.AddDate(0, 0, 13)
	if v := strings.TrimSpace(rawFrom); v != "" {
		p, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.BadRequest(w, r, "from must be YYYY-MM-DD")
			return "", "", false
		}
		from = p
	}
	if v := strings.TrimSpace(rawTo); v != "" {
		p, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.BadRequest(w, r, "to must be YYYY-MM-DD")
			return "", "", false
		}
		to = p
	}
	if to.Before(from) {
		httpx.BadRequest(w, r, "to must not be before from")
		return "", "", false
	}
	// A range longer than a term is either a mistake or a resignation, and
	// expanding it produces thousands of rows an approver will never read.
	if to.Sub(from) > 92*24*time.Hour {
		httpx.BadRequest(w, r, "a cover request may span at most 92 days")
		return "", "", false
	}
	return from.Format("2006-01-02"), to.Format("2006-01-02"), true
}

// ============================================ 3. submitting and reading a request

type coverRequestBody struct {
	FromDate       string `json:"from_date"`
	ToDate         string `json:"to_date"`
	Reason         string `json:"reason"`
	LeaveRequestID string `json:"leave_request_id,omitempty"`
	SuggestedUser  string `json:"suggested_user_id,omitempty"`
	// Empty means "every period I have in that range", which is what a teacher
	// on leave for three days actually wants and saves them ticking eighteen
	// boxes. Naming periods is for the half-day case.
	Periods []coverPeriodRef `json:"periods,omitempty"`
	// TeacherID lets the office raise a request on somebody's behalf. Requires
	// timetable.write; a teacher submitting their own leaves it empty.
	TeacherID string `json:"teacher_id,omitempty"`
}

type coverPeriodRef struct {
	TimetableEntryID string `json:"timetable_entry_id"`
	OnDate           string `json:"on_date"`
}

type coverRequestRow struct {
	ID            string  `json:"id"`
	RequestedBy   string  `json:"requested_by"`
	TeacherName   string  `json:"teacher_name"`
	FromDate      string  `json:"from_date"`
	ToDate        string  `json:"to_date"`
	Reason        string  `json:"reason"`
	Status        string  `json:"status"`
	SuggestedName *string `json:"suggested_teacher,omitempty"`
	SuggestedID   *string `json:"suggested_user_id,omitempty"`
	LeaveID       *string `json:"leave_request_id,omitempty"`
	DecidedBy     *string `json:"decided_by,omitempty"`
	DecisionNote  *string `json:"decision_note,omitempty"`
	CreatedAt     string  `json:"created_at"`
	Periods       int     `json:"periods"`
	Covered       int     `json:"covered"`
	Mine          bool    `json:"mine"`
}

/*
createCoverRequest records the ask.

	Ownership is checked on every line, not on the request as a whole: a
	teacher may ask for cover for their own periods and nobody else's, and the
	check is here because a screen that only lists your own periods is not
	access control. The office arranging cover for somebody else needs
	timetable.write, which is the same permission that decides the request.
*/
func (s *Server) createCoverRequest(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var body coverRequestBody
	if !httpx.Decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		httpx.BadRequest(w, r, "reason is required. The approver has to know why")
		return
	}
	from, to, ok := coverRange(w, r, body.FromDate, body.ToDate)
	if !ok {
		return
	}

	subject := id.UserID
	if raw := strings.TrimSpace(body.TeacherID); raw != "" {
		other, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "teacher_id must be a uuid")
			return
		}
		if other != id.UserID && !id.Can(rbac.TimetableWrite) {
			httpx.Forbidden(w, r, rbac.TimetableWrite)
			return
		}
		subject = other
	}

	var suggested *uuid.UUID
	if raw := strings.TrimSpace(body.SuggestedUser); raw != "" {
		sid, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "suggested_user_id must be a uuid")
			return
		}
		suggested = &sid
	}
	var leaveID *uuid.UUID
	if raw := strings.TrimSpace(body.LeaveRequestID); raw != "" {
		lid, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "leave_request_id must be a uuid")
			return
		}
		leaveID = &lid
	}

	var requestID uuid.UUID
	var lines int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var employeeID *uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT id FROM employees WHERE user_id = $1 LIMIT 1`, subject).
			Scan(&employeeID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO substitution_requests (institution_id, requested_by, employee_id,
			        from_date, to_date, reason, leave_request_id, suggested_user_id)
			VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8)
			RETURNING id`,
			id.InstitutionID, subject, employeeID, from, to,
			strings.TrimSpace(body.Reason), leaveID, suggested).Scan(&requestID); err != nil {
			return err
		}

		if len(body.Periods) == 0 {
			// Every period the teacher holds in the range, holidays excluded.
			tag, err := tx.Exec(r.Context(), `
				INSERT INTO substitution_request_periods (institution_id, request_id,
				        timetable_entry_id, on_date)
				SELECT $1, $2, te.id, d.day
				  FROM generate_series($4::date, $5::date, interval '1 day') AS d(day)
				  JOIN timetable_entries te
				    ON te.weekday = extract(isodow FROM d.day)::int
				   AND te.teacher_user_id = $3
				 WHERE NOT EXISTS (SELECT 1 FROM holidays h
				                    WHERE h.kind IN ('holiday','vacation')
				                      AND h.applies_to IN ('all','staff')
				                      AND d.day BETWEEN h.on_date
				                                    AND COALESCE(h.to_date, h.on_date))`,
				id.InstitutionID, requestID, subject, from, to)
			if err != nil {
				return err
			}
			lines = int(tag.RowsAffected())
			return nil
		}

		for _, ref := range body.Periods {
			entryID, err := uuid.Parse(strings.TrimSpace(ref.TimetableEntryID))
			if err != nil {
				return errBadPeriodRef
			}
			// The period must be the subject's own, and the date must fall on
			// the weekday that period is taught. Both are cheap and both are
			// how a hand-crafted body would otherwise book cover for a class
			// the caller has nothing to do with.
			var mine bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (
				  SELECT 1 FROM timetable_entries te
				   WHERE te.id = $1 AND te.teacher_user_id = $2
				     AND te.weekday = extract(isodow FROM $3::date)::int)`,
				entryID, subject, ref.OnDate).Scan(&mine); err != nil {
				return err
			}
			if !mine {
				return errNotYourPeriod
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO substitution_request_periods (institution_id, request_id,
				        timetable_entry_id, on_date)
				VALUES ($1,$2,$3,$4::date)`,
				id.InstitutionID, requestID, entryID, ref.OnDate); err != nil {
				return err
			}
			lines++
		}
		return nil
	})
	switch {
	case errors.Is(err, errBadPeriodRef):
		httpx.BadRequest(w, r, "timetable_entry_id must be a uuid")
		return
	case errors.Is(err, errNotYourPeriod):
		httpx.Denied(w, r, "one of those periods is not yours to hand over")
		return
	case err != nil:
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			httpx.Error(w, r, http.StatusConflict, "already_requested",
				"cover has already been requested for one of those periods")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	if lines == 0 {
		httpx.JSON(w, http.StatusCreated, map[string]any{
			"id": requestID.String(), "periods": 0,
			"note": "no timetabled periods fall in that range, so there is nothing to cover",
		})
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": requestID.String(), "periods": lines})
}

var errBadPeriodRef = errors.New("bad period reference")

// listCoverRequests returns the caller's own requests, plus everything pending
// if they are the one who approves them.
func (s *Server) listCoverRequests(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	// A teacher sees their own. An approver sees the queue — which is the same
	// query with the ownership clause relaxed, not a second endpoint.
	approver := id.Can(rbac.TimetableWrite)
	status := strings.TrimSpace(r.URL.Query().Get("status"))

	items, err := collect(s, r, `
		SELECT sr.id::text, sr.requested_by::text, u.full_name,
		       to_char(sr.from_date,'YYYY-MM-DD'), to_char(sr.to_date,'YYYY-MM-DD'),
		       sr.reason, sr.status, su.full_name, sr.suggested_user_id::text,
		       sr.leave_request_id::text, du.full_name, sr.decision_note,
		       to_char(sr.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       (SELECT count(*)::int FROM substitution_request_periods p
		         WHERE p.request_id = sr.id),
		       (SELECT count(*)::int FROM substitution_request_periods p
		         WHERE p.request_id = sr.id AND p.status = 'covered'),
		       (sr.requested_by = $1)
		  FROM substitution_requests sr
		  JOIN users u ON u.id = sr.requested_by
		  LEFT JOIN users su ON su.id = sr.suggested_user_id
		  LEFT JOIN users du ON du.id = sr.decided_by
		 WHERE ($2 OR sr.requested_by = $1)
		   AND ($3 = '' OR sr.status = $3)
		 ORDER BY (sr.status = 'pending') DESC, sr.from_date DESC
		 LIMIT 200`,
		[]any{id.UserID, approver, status},
		func(rows pgx.Rows) (coverRequestRow, error) {
			var v coverRequestRow
			return v, rows.Scan(&v.ID, &v.RequestedBy, &v.TeacherName, &v.FromDate, &v.ToDate,
				&v.Reason, &v.Status, &v.SuggestedName, &v.SuggestedID, &v.LeaveID,
				&v.DecidedBy, &v.DecisionNote, &v.CreatedAt, &v.Periods, &v.Covered, &v.Mine)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "can_decide": approver})
}

type coverCandidate struct {
	UserID   string `json:"user_id"`
	FullName string `json:"full_name"`
	// A free period held by somebody who teaches the subject elsewhere is a
	// lesson; anybody else is a supervised hour.
	TeachesSubject bool `json:"teaches_subject"`
	PeriodsToday   int  `json:"periods_today"`
	PeriodsWeek    int  `json:"periods_week"`
	MaxPerWeek     int  `json:"max_periods_per_week"`
	// Suggested marks the colleague the requester named, so the approver can
	// see whether the person asked is actually free.
	Suggested bool `json:"suggested"`
}

type coverLineRow struct {
	ID           string  `json:"id"`
	EntryID      string  `json:"timetable_entry_id"`
	OnDate       string  `json:"on_date"`
	PeriodName   string  `json:"period_name"`
	StartsAt     string  `json:"starts_at"`
	ClassName    string  `json:"class_name"`
	SectionName  string  `json:"section_name"`
	SubjectName  string  `json:"subject_name"`
	Status       string  `json:"status"`
	AssignedName *string `json:"assigned_teacher,omitempty"`
	AssignedID   *string `json:"assigned_user_id,omitempty"`

	Candidates []coverCandidate `json:"candidates"`
}

/*
getCoverRequest is the screen that earns this feature its place.

	The request itself is four fields. The valuable part is the list under each
	period: who is genuinely free in *that* slot on *that* date, whether they
	teach the subject, and how loaded they already are. That is the question an
	approver would otherwise answer by hand, with a printed grid, for each of
	eighteen periods, and it is why substitution arrangements in most schools
	land on whoever is standing in the corridor.

	Free means all four of: no class of their own in that slot, not already
	promised to another class by an earlier substitution, not themselves absent
	that day, and not the person asking. Missing any one of them produces a
	suggestion that moves the uncovered class rather than covering it.
*/
func (s *Server) getCoverRequest(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	reqID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	approver := id.Can(rbac.TimetableWrite)

	var (
		head  coverRequestRow
		lines []coverLineRow
		found bool
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT sr.id::text, sr.requested_by::text, u.full_name,
			       to_char(sr.from_date,'YYYY-MM-DD'), to_char(sr.to_date,'YYYY-MM-DD'),
			       sr.reason, sr.status, su.full_name, sr.suggested_user_id::text,
			       sr.leave_request_id::text, du.full_name, sr.decision_note,
			       to_char(sr.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       (sr.requested_by = $2)
			  FROM substitution_requests sr
			  JOIN users u ON u.id = sr.requested_by
			  LEFT JOIN users su ON su.id = sr.suggested_user_id
			  LEFT JOIN users du ON du.id = sr.decided_by
			 WHERE sr.id = $1`, reqID, id.UserID).Scan(
			&head.ID, &head.RequestedBy, &head.TeacherName, &head.FromDate, &head.ToDate,
			&head.Reason, &head.Status, &head.SuggestedName, &head.SuggestedID,
			&head.LeaveID, &head.DecidedBy, &head.DecisionNote, &head.CreatedAt, &head.Mine)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		// Somebody else's request is the approver's business and nobody
		// else's. RLS keeps it inside the tenant; this keeps it inside the two
		// people it concerns.
		if !head.Mine && !approver {
			return errNotYourRequest
		}

		rows, err := tx.Query(r.Context(), `
			SELECT srp.id::text, srp.timetable_entry_id::text,
			       to_char(srp.on_date,'YYYY-MM-DD'), p.name, to_char(p.starts_at,'HH24:MI'),
			       c.name, sec.name, sub.name, srp.status,
			       au.full_name, srp.assigned_user_id::text
			  FROM substitution_request_periods srp
			  JOIN timetable_entries te ON te.id = srp.timetable_entry_id
			  JOIN periods p ON p.id = te.period_id
			  JOIN sections sec ON sec.id = te.section_id
			  JOIN classes c ON c.id = sec.class_id
			  JOIN class_subjects cs ON cs.id = te.class_subject_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			  LEFT JOIN users au ON au.id = srp.assigned_user_id
			 WHERE srp.request_id = $1
			 ORDER BY srp.on_date, p.sequence`, reqID)
		if err != nil {
			return err
		}
		defer rows.Close()
		lines = []coverLineRow{}
		for rows.Next() {
			var v coverLineRow
			if err := rows.Scan(&v.ID, &v.EntryID, &v.OnDate, &v.PeriodName, &v.StartsAt,
				&v.ClassName, &v.SectionName, &v.SubjectName, &v.Status,
				&v.AssignedName, &v.AssignedID); err != nil {
				return err
			}
			v.Candidates = []coverCandidate{}
			lines = append(lines, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// Only the approver needs the candidate lists, and computing eighteen
		// of them for a teacher who cannot act on any is work nobody asked for.
		if !approver || head.Status != "pending" {
			return nil
		}
		for i := range lines {
			cands, err := s.coverCandidatesFor(r.Context(), tx,
				lines[i].EntryID, lines[i].OnDate, head.RequestedBy, head.SuggestedID)
			if err != nil {
				return err
			}
			lines[i].Candidates = cands
		}
		return nil
	})
	switch {
	case errors.Is(err, errNotYourRequest):
		httpx.Denied(w, r, "that request is not yours")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"request": head, "periods": lines, "can_decide": approver && head.Status == "pending",
	})
}

var errNotYourRequest = errors.New("not your request")

// coverCandidatesFor answers "who is actually free in this period, on this day".
func (s *Server) coverCandidatesFor(ctx context.Context, tx pgx.Tx, entryID, onDate, absentUser string, suggested *string) ([]coverCandidate, error) {

	rows, err := tx.Query(ctx, `
		WITH slot AS (
		  SELECT te.id, te.weekday, te.period_id, te.academic_year_id, cs.subject_id
		    FROM timetable_entries te
		    JOIN class_subjects cs ON cs.id = te.class_subject_id
		   WHERE te.id = $1
		)
		SELECT u.id::text, u.full_name,
		       EXISTS (SELECT 1 FROM section_subject_teachers sst
		                 JOIN class_subjects cs2 ON cs2.id = sst.class_subject_id
		                WHERE sst.teacher_user_id = u.id
		                  AND cs2.subject_id = (SELECT subject_id FROM slot)),
		       (SELECT count(*)::int FROM timetable_entries t2
		         WHERE t2.teacher_user_id = u.id
		           AND t2.weekday = (SELECT weekday FROM slot)),
		       (SELECT count(*)::int FROM timetable_entries t3
		         WHERE t3.teacher_user_id = u.id
		           AND t3.academic_year_id = (SELECT academic_year_id FROM slot)),
		       COALESCE(lr.max_periods_per_week, 35)
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		  LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id
		 WHERE e.status = 'active'
		   AND u.id <> $3
		   -- Free in this slot of the week.
		   AND NOT EXISTS (SELECT 1 FROM timetable_entries t4
		                    WHERE t4.teacher_user_id = u.id
		                      AND t4.weekday = (SELECT weekday FROM slot)
		                      AND t4.period_id = (SELECT period_id FROM slot))
		   -- Not already promised to another class in it on this date.
		   AND NOT EXISTS (SELECT 1 FROM substitutions sb
		                     JOIN timetable_entries t5 ON t5.id = sb.timetable_entry_id
		                    WHERE sb.substitute_user_id = u.id AND sb.on_date = $2::date
		                      AND t5.period_id = (SELECT period_id FROM slot))
		   -- Not themselves out that day, by either register the school keeps.
		   AND NOT EXISTS (SELECT 1 FROM staff_attendance sa
		                    WHERE sa.user_id = u.id AND sa.on_date = $2::date
		                      AND sa.status IN ('absent','leave'))
		   AND NOT EXISTS (SELECT 1 FROM leave_requests lv
		                    WHERE lv.employee_id = e.id AND lv.status = 'approved'
		                      AND $2::date BETWEEN lv.from_date AND lv.to_date)
		   -- Not marked unavailable in this slot every week.
		   AND NOT EXISTS (SELECT 1 FROM teacher_unavailability tu
		                    WHERE tu.teacher_user_id = u.id
		                      AND tu.weekday = (SELECT weekday FROM slot)
		                      AND (tu.period_id IS NULL
		                           OR tu.period_id = (SELECT period_id FROM slot)))
		 ORDER BY u.full_name
		 LIMIT 40`, entryID, onDate, absentUser)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []coverCandidate{}
	for rows.Next() {
		var c coverCandidate
		if err := rows.Scan(&c.UserID, &c.FullName, &c.TeachesSubject,
			&c.PeriodsToday, &c.PeriodsWeek, &c.MaxPerWeek); err != nil {
			return nil, err
		}
		if suggested != nil && *suggested == c.UserID {
			c.Suggested = true
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	/* The order is the recommendation, and it is made here so every reader
	   gets the same one. The colleague the teacher named comes first if they
	   are free at all — that is the whole value of asking. After that, someone
	   who teaches the subject, then whoever has the most room left against
	   their weekly cap, because spreading proxy duty is the only thing that
	   keeps it bearable. */
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Suggested != out[j].Suggested {
			return out[i].Suggested
		}
		if out[i].TeachesSubject != out[j].TeachesSubject {
			return out[i].TeachesSubject
		}
		li := float64(out[i].PeriodsWeek) / float64(maxInt(out[i].MaxPerWeek, 1))
		lj := float64(out[j].PeriodsWeek) / float64(maxInt(out[j].MaxPerWeek, 1))
		if li != lj {
			return li < lj
		}
		if out[i].PeriodsToday != out[j].PeriodsToday {
			return out[i].PeriodsToday < out[j].PeriodsToday
		}
		return out[i].FullName < out[j].FullName
	})
	if len(out) > 8 {
		out = out[:8]
	}
	return out, nil
}

// ================================================ 3. deciding and cancelling

type coverDecision struct {
	// approve | reject
	Decision string `json:"decision"`
	Note     string `json:"note,omitempty"`
	// One entry per period the approver is covering. Periods left out of an
	// approval stay pending, and the request becomes partially_approved —
	// which is the honest state when nobody was free for Thursday's third.
	Assignments []coverAssignment `json:"assignments,omitempty"`
}

type coverAssignment struct {
	PeriodLineID     string `json:"period_id"`
	SubstituteUserID string `json:"substitute_user_id"`
}

/*
decideCoverRequest approves or refuses, and an approval writes the day's cover.

	The write goes into the existing substitutions table, which is the entire
	reason this feature is worth building rather than emailing. The morning
	board, "who is teaching now", the class register and the payroll proxy
	allowance all already read that table; an approved request therefore shows
	up in every one of them without any of them being changed.

	A substitute who turns out not to be free is refused with a 409 rather than
	recorded. Two teachers promised to the same period at the same time is the
	failure this whole screen exists to prevent, and accepting it because the
	approver clicked quickly would be the same bug with a nicer interface.
*/
func (s *Server) decideCoverRequest(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	reqID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var body coverDecision
	if !httpx.Decode(w, r, &body) {
		return
	}
	if body.Decision != "approve" && body.Decision != "reject" {
		httpx.BadRequest(w, r, `decision must be "approve" or "reject"`)
		return
	}

	var covered, pending int
	var status string
	var busyName string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var current, reason string
		var requester uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT status, reason, requested_by FROM substitution_requests
			  WHERE id = $1 FOR UPDATE`, reqID).Scan(&current, &reason, &requester); err != nil {
			return err
		}
		if current != "pending" {
			return errRequestClosed
		}

		if body.Decision == "reject" {
			if _, err := tx.Exec(r.Context(), `
				UPDATE substitution_request_periods SET status = 'declined'
				 WHERE request_id = $1 AND status = 'pending'`, reqID); err != nil {
				return err
			}
			status = "rejected"
			_, err := tx.Exec(r.Context(), `
				UPDATE substitution_requests
				   SET status = 'rejected', decided_by = $2, decided_at = now(),
				       decision_note = $3, updated_at = now()
				 WHERE id = $1`, reqID, id.UserID, nullString(body.Note))
			return err
		}

		for _, a := range body.Assignments {
			lineID, err := uuid.Parse(strings.TrimSpace(a.PeriodLineID))
			if err != nil {
				return errBadPeriodRef
			}
			subID, err := uuid.Parse(strings.TrimSpace(a.SubstituteUserID))
			if err != nil {
				return errBadPeriodRef
			}

			var entryID uuid.UUID
			var onDate time.Time
			if err := tx.QueryRow(r.Context(), `
				SELECT timetable_entry_id, on_date FROM substitution_request_periods
				 WHERE id = $1 AND request_id = $2 AND status = 'pending'`,
				lineID, reqID).Scan(&entryID, &onDate); err != nil {
				return err
			}

			// The proxy must actually be free — their own class, and any
			// cover they have already been given for that period.
			var busy bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (
				  SELECT 1 FROM timetable_entries te
				   WHERE te.teacher_user_id = $1
				     AND te.weekday = extract(isodow FROM $2::date)::int
				     AND te.period_id = (SELECT period_id FROM timetable_entries WHERE id = $3))
				OR EXISTS (
				  SELECT 1 FROM substitutions sb
				    JOIN timetable_entries t2 ON t2.id = sb.timetable_entry_id
				   WHERE sb.substitute_user_id = $1 AND sb.on_date = $2::date
				     AND t2.period_id = (SELECT period_id FROM timetable_entries WHERE id = $3))`,
				subID, onDate, entryID).Scan(&busy); err != nil {
				return err
			}
			if busy {
				_ = tx.QueryRow(r.Context(),
					`SELECT full_name FROM users WHERE id = $1`, subID).Scan(&busyName)
				return errCoverBusy
			}

			var subRowID uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO substitutions (institution_id, timetable_entry_id, on_date,
				        substitute_user_id, reason, created_by, request_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT (timetable_entry_id, on_date) DO UPDATE
				   SET substitute_user_id = EXCLUDED.substitute_user_id,
				       reason = EXCLUDED.reason, request_id = EXCLUDED.request_id
				RETURNING id`,
				id.InstitutionID, entryID, onDate, subID, reason, id.UserID, reqID).
				Scan(&subRowID); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE substitution_request_periods
				   SET status = 'covered', assigned_user_id = $2, substitution_id = $3
				 WHERE id = $1`, lineID, subID, subRowID); err != nil {
				return err
			}
			covered++
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FILTER (WHERE status = 'pending')::int
			  FROM substitution_request_periods WHERE request_id = $1`, reqID).
			Scan(&pending); err != nil {
			return err
		}
		status = "approved"
		if pending > 0 {
			status = "partially_approved"
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE substitution_requests
			   SET status = $2, decided_by = $3, decided_at = now(),
			       decision_note = $4, updated_at = now()
			 WHERE id = $1`, reqID, status, id.UserID, nullString(body.Note)); err != nil {
			return err
		}

		/* Tell whoever the school has configured to be told.

		   Through the existing messaging foundation rather than anything new:
		   the caller names the event and the occurrence, and the school's own
		   trigger rules decide the channel, the template and the audience. A
		   substitution nobody is told about is a class with no teacher in it,
		   so this is worth emitting — but who hears about it is not this
		   file's business.

		   Audience 'staff' resolves against MessageSubject.EmployeeID, so one
		   event is emitted per covering teacher. Note for the integrator: the
		   *approver* cannot be notified of a new request through the same
		   mechanism, because the audience vocabulary has no term for "whoever
		   approves substitutions". See the report. */
		return s.notifyCovering(r.Context(), tx, id.InstitutionID, reqID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errRequestClosed):
		httpx.Error(w, r, http.StatusConflict, "request_closed",
			"this request has already been decided")
		return
	case errors.Is(err, errBadPeriodRef):
		httpx.BadRequest(w, r, "period_id and substitute_user_id must be uuids")
		return
	case errors.Is(err, errCoverBusy):
		msg := "that teacher already has a class in this period"
		if busyName != "" {
			msg = busyName + " already has a class in that period"
		}
		httpx.Error(w, r, http.StatusConflict, "proxy_busy", msg)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status": status, "covered": covered, "still_uncovered": pending,
	})
}

// notifyCovering emits one message event per teacher given cover to take.
func (s *Server) notifyCovering(ctx context.Context, tx pgx.Tx, inst uuid.UUID, reqID uuid.UUID) error {

	rows, err := tx.Query(ctx, `
		SELECT srp.id::text, e.id, srp.on_date, p.name, c.name || '-' || sec.name, sub.name
		  FROM substitution_request_periods srp
		  JOIN employees e ON e.user_id = srp.assigned_user_id
		  JOIN timetable_entries te ON te.id = srp.timetable_entry_id
		  JOIN periods p ON p.id = te.period_id
		  JOIN sections sec ON sec.id = te.section_id
		  JOIN classes c ON c.id = sec.class_id
		  JOIN class_subjects cs ON cs.id = te.class_subject_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		 WHERE srp.request_id = $1 AND srp.status = 'covered'`, reqID)
	if err != nil {
		return err
	}
	subjects := []MessageSubject{}
	for rows.Next() {
		var lineID, periodName, sectionName, subjectName string
		var empID uuid.UUID
		var on time.Time
		if err := rows.Scan(&lineID, &empID, &on, &periodName, &sectionName, &subjectName); err != nil {
			rows.Close()
			return err
		}
		eid := empID
		subjects = append(subjects, MessageSubject{
			EmployeeID:    &eid,
			OccurrenceKey: lineID,
			At:            on,
			Facts:         map[string]any{"days_ahead": int(time.Until(on).Hours() / 24)},
			Vars: map[string]any{
				"date": on.Format("2 Jan"), "period": periodName,
				"section": sectionName, "subject": subjectName,
			},
		})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(subjects) == 0 {
		return nil
	}
	_, err = s.EmitMessageEvent(ctx, tx, inst, "substitution.assigned", subjects...)
	return err
}

// cancelCoverRequest withdraws an undecided request.
//
// Only from pending: once periods have been covered the arrangement is in the
// day's timetable and other people are planning around it, so withdrawing is a
// conversation with the office rather than a button.
func (s *Server) cancelCoverRequest(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	reqID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The ownership test is in the UPDATE so there is no window between
		// checking and writing. An approver may cancel anybody's.
		tag, err := tx.Exec(r.Context(), `
			UPDATE substitution_requests
			   SET status = 'cancelled', updated_at = now()
			 WHERE id = $1 AND status = 'pending' AND ($2 OR requested_by = $3)`,
			reqID, id.Can(rbac.TimetableWrite), id.UserID)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		if n == 0 {
			return nil
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE substitution_request_periods SET status = 'declined'
			 WHERE request_id = $1 AND status = 'pending'`, reqID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.Error(w, r, http.StatusConflict, "not_cancellable",
			"only your own undecided request can be withdrawn")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"cancelled": true})
}

// nullUUIDs turns an empty slice into a SQL NULL so a query can say
// "$1 IS NULL OR col = ANY($1)" and mean "no filter".
func nullUUIDs(v []uuid.UUID) any {
	if len(v) == 0 {
		return nil
	}
	return v
}
