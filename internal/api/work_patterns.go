package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
The hours a school expects, and what it costs when they are not kept.

	staff_attendance has recorded check_in and check_out since the beginning and
	compared them to nothing. The times were collected every day by a
	fingerprint reader and used for no purpose: nobody could be late, a half day
	had no meaning, and payroll had no basis on which to deduct anything.

	One set of hours would not have been enough even so. A school's teaching
	staff, its office and its drivers do not start together -- the bus leaves
	before the gate opens and the office closes after the last child has gone --
	so a pattern is named by the school, defined by the school, and assigned.

	Resolved most specific first: the person's own, then their department's,
	then the school's default. A driver on his own hours needs no new category
	invented to hold him.
*/

type workPattern struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	StartsAt       string  `json:"starts_at"`
	EndsAt         string  `json:"ends_at"`
	GraceMinutes   int     `json:"grace_minutes"`
	FullDayMinutes int     `json:"full_day_minutes"`
	HalfDayMinutes int     `json:"half_day_minutes"`
	WorkingDays    []int32 `json:"working_days"`
	/* How the school cuts pay, in the school's own terms.

	   none   absence is recorded and never costs anything
	   fixed  the same rupee figure per day for everyone on this pattern
	   salary the person's own monthly pay divided by salary_divisor, so one
	          rule covers a school where everybody earns differently */
	LOPBasis        string `json:"lop_basis"`
	LOPPerDayPaise  *int64 `json:"lop_per_day_paise,omitempty"`
	SalaryDivisor   int    `json:"salary_divisor"`
	LatesForHalfDay int    `json:"lates_for_half_day"`
	IsDefault       bool   `json:"is_default"`
	// Who runs to it, named rather than counted: a pattern with nobody on it
	// looks in use and is not, and that is the state a school ends up in after
	// creating one and forgetting to assign it.
	Departments string `json:"departments"`
	People      int    `json:"people"`
}

func (s *Server) listWorkPatterns(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT p.id::text, p.name,
		       to_char(p.starts_at,'HH24:MI'), to_char(p.ends_at,'HH24:MI'),
		       p.grace_minutes, p.full_day_minutes, p.half_day_minutes,
		       p.working_days, p.lop_basis, p.lop_per_day_paise,
		       p.salary_divisor, p.lates_for_half_day, p.is_default,
		       COALESCE((SELECT string_agg(d.name, ', ' ORDER BY d.name)
		                   FROM departments d WHERE d.work_pattern_id = p.id), ''),
		       (SELECT count(*)::int FROM employees e WHERE e.work_pattern_id = p.id)
		  FROM work_patterns p
		 ORDER BY p.is_default DESC, p.name`, nil,
		func(rows pgx.Rows) (workPattern, error) {
			var v workPattern
			return v, rows.Scan(&v.ID, &v.Name, &v.StartsAt, &v.EndsAt,
				&v.GraceMinutes, &v.FullDayMinutes, &v.HalfDayMinutes,
				&v.WorkingDays, &v.LOPBasis, &v.LOPPerDayPaise,
				&v.SalaryDivisor, &v.LatesForHalfDay, &v.IsDefault,
				&v.Departments, &v.People)
		})
	respond(w, r, items, err)
}

type workPatternRequest struct {
	Name            string  `json:"name"`
	StartsAt        string  `json:"starts_at"`
	EndsAt          string  `json:"ends_at"`
	GraceMinutes    *int    `json:"grace_minutes,omitempty"`
	FullDayMinutes  *int    `json:"full_day_minutes,omitempty"`
	HalfDayMinutes  *int    `json:"half_day_minutes,omitempty"`
	WorkingDays     []int32 `json:"working_days,omitempty"`
	LOPBasis        string  `json:"lop_basis,omitempty"`
	LOPPerDayPaise  *int64  `json:"lop_per_day_paise,omitempty"`
	SalaryDivisor   *int    `json:"salary_divisor,omitempty"`
	LatesForHalfDay *int    `json:"lates_for_half_day,omitempty"`
	IsDefault       bool    `json:"is_default,omitempty"`
	// Which departments run to it. Assigned here rather than on a screen of
	// its own, because somebody defining the office's hours is thinking about
	// the office at that moment, and asking again later is how a pattern gets
	// created and never used.
	DepartmentIDs []string `json:"department_ids,omitempty"`
}

func (s *Server) saveWorkPattern(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req workPatternRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "give these hours a name — Teaching, Office, Transport")
		return
	}
	if req.StartsAt == "" || req.EndsAt == "" || req.StartsAt >= req.EndsAt {
		httpx.BadRequest(w, r, "the day has to end after it starts")
		return
	}
	grace, full, half := 10, 420, 210
	if req.GraceMinutes != nil {
		grace = *req.GraceMinutes
	}
	if req.FullDayMinutes != nil {
		full = *req.FullDayMinutes
	}
	if req.HalfDayMinutes != nil {
		half = *req.HalfDayMinutes
	}
	if grace < 0 || full <= 0 || half <= 0 || half > full {
		httpx.BadRequest(w, r,
			"a half day cannot be longer than a full one, and none of these can be negative")
		return
	}
	days := req.WorkingDays
	if len(days) == 0 {
		days = []int32{1, 2, 3, 4, 5, 6}
	}

	/* The deduction rule, refused rather than guessed at when it is
	   incomplete. A school that picks "a fixed amount" and gives no amount has
	   not finished saying its policy, and defaulting that to zero would record
	   a policy of deducting nothing under the name of deducting something. */
	basis := strings.TrimSpace(req.LOPBasis)
	if basis == "" {
		basis = "none"
	}
	switch basis {
	case "none", "fixed", "salary":
	default:
		httpx.BadRequest(w, r,
			"how pay is cut must be none, fixed or salary")
		return
	}
	if basis == "fixed" && (req.LOPPerDayPaise == nil || *req.LOPPerDayPaise <= 0) {
		httpx.BadRequest(w, r, "say how much a day's absence costs")
		return
	}
	divisor := 30
	if req.SalaryDivisor != nil {
		divisor = *req.SalaryDivisor
	}
	if divisor < 0 {
		httpx.BadRequest(w, r,
			"divide the month by a positive number of days, or by 0 to use the "+
				"days actually expected")
		return
	}
	lates := 0
	if req.LatesForHalfDay != nil {
		lates = *req.LatesForHalfDay
	}
	if lates < 0 {
		httpx.BadRequest(w, r, "lates before a half day cannot be negative")
		return
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO work_patterns (institution_id, name, starts_at, ends_at,
			        grace_minutes, full_day_minutes, half_day_minutes,
			        working_days, lop_basis, lop_per_day_paise,
			        salary_divisor, lates_for_half_day, is_default)
			VALUES ($1,$2,$3::time,$4::time,$5,$6,$7,$8,$9,$10,$11,$12,$13)
			ON CONFLICT (institution_id, name) DO UPDATE SET
			    starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
			    grace_minutes = EXCLUDED.grace_minutes,
			    full_day_minutes = EXCLUDED.full_day_minutes,
			    half_day_minutes = EXCLUDED.half_day_minutes,
			    working_days = EXCLUDED.working_days,
			    lop_basis = EXCLUDED.lop_basis,
			    lop_per_day_paise = EXCLUDED.lop_per_day_paise,
			    salary_divisor = EXCLUDED.salary_divisor,
			    lates_for_half_day = EXCLUDED.lates_for_half_day,
			    updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, req.Name, req.StartsAt, req.EndsAt,
			grace, full, half, days, basis, req.LOPPerDayPaise,
			divisor, lates, req.IsDefault).Scan(&newID); err != nil {
			return err
		}
		// One default, so "the school's hours" is never ambiguous.
		if req.IsDefault {
			if _, err := tx.Exec(r.Context(), `
				UPDATE work_patterns SET is_default = (id = $2::uuid)
				 WHERE institution_id = $1`, id.InstitutionID, newID); err != nil {
				return err
			}
		}
		if len(req.DepartmentIDs) > 0 {
			if _, err := tx.Exec(r.Context(), `
				UPDATE departments SET work_pattern_id = $2::uuid
				 WHERE institution_id = $1 AND id = ANY($3::uuid[])`,
				id.InstitutionID, newID, req.DepartmentIDs); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

/*
deleteWorkPattern removes a set of hours nobody is on.

	Refused while anybody runs to it rather than quietly unassigning them: a
	member of staff whose hours vanish falls back to the school's default and
	is then late or absent by a rule nobody chose for them, which is a payroll
	deduction arriving out of nowhere.
*/
func (s *Server) deleteWorkPattern(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	patternID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid work pattern id")
		return
	}
	var people, depts int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*)::int FROM employees   e WHERE e.work_pattern_id = p.id),
			       (SELECT count(*)::int FROM departments d WHERE d.work_pattern_id = p.id)
			  FROM work_patterns p WHERE p.id = $1`, patternID).Scan(&people, &depts); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errRefGone
			}
			return err
		}
		if people > 0 || depts > 0 {
			return errRefInUse
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM work_patterns WHERE id = $1`, patternID)
		return err
	})
	if errors.Is(err, errRefInUse) {
		httpx.BadRequest(w, r,
			plural(people, "member of staff", "members of staff")+" and "+
				plural(depts, "department", "departments")+
				" keep these hours. Move them to another set first — without one "+
				"they fall back to the school's default and are judged by a rule "+
				"nobody chose for them")
		return
	}
	writeRefResult(w, r, err, "work pattern", patternID)
}

/*
assignWorkPattern puts named people on a set of hours.

	The hierarchy could always hold an individual override -- employees.work_pattern_id
	has existed since the table did -- and nothing could write it. So a school
	could say what its office keeps and what its drivers keep, and could not say
	that one part-time teacher comes in on Monday, Wednesday and Friday, which is
	the case the hierarchy exists for.

	Named people rather than a filter. A rule like "everybody in Primary" reads
	well until somebody joins Primary next term and is silently put on hours
	nobody chose for them; the department level is where that belongs, and it is
	already there.
*/
type assignRequest struct {
	// Null clears the override and returns them to their department's hours,
	// or the school's. Sent as an explicit null rather than an empty string so
	// that "put them back" is a thing the caller can actually say.
	PatternID   *string  `json:"pattern_id"`
	EmployeeIDs []string `json:"employee_ids"`
}

func (s *Server) assignWorkPattern(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req assignRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.EmployeeIDs) == 0 {
		httpx.BadRequest(w, r, "choose at least one member of staff")
		return
	}
	var pattern *uuid.UUID
	if req.PatternID != nil && strings.TrimSpace(*req.PatternID) != "" {
		p, err := uuid.Parse(strings.TrimSpace(*req.PatternID))
		if err != nil {
			httpx.BadRequest(w, r, "invalid work pattern id")
			return
		}
		pattern = &p
	}

	var changed int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The pattern is checked inside the tenant transaction, so a school
		// cannot put its staff on another school's hours by guessing an id.
		if pattern != nil {
			var ok bool
			if err := tx.QueryRow(r.Context(),
				`SELECT true FROM work_patterns WHERE id = $1`, *pattern).Scan(&ok); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return errRefGone
				}
				return err
			}
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE employees SET work_pattern_id = $1
			 WHERE institution_id = $2 AND id = ANY($3::uuid[])`,
			pattern, id.InstitutionID, req.EmployeeIDs)
		if err != nil {
			return err
		}
		changed = tag.RowsAffected()
		return nil
	})
	if errors.Is(err, errRefGone) {
		httpx.BadRequest(w, r, "those hours no longer exist")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"changed": changed})
}

/*
listPatternStaff is the list the picker is chosen from.

	The staff list this screen borrowed answers with employee codes and a name
	built elsewhere, so the picker read "000", "T-001", "FB-369" -- a column of
	codes nobody in a staffroom knows anybody by. Choosing which people keep
	which hours is a decision made about persons, so the list says who they are:
	their name, their department, what they teach, and the hours they are on now.

	What they teach is the grades, not the subjects. The question being answered
	is "is this one of the primary teachers who finish at one", and a list of
	subjects does not answer it.
*/
type patternStaff struct {
	ID      string `json:"id"`
	Code    string `json:"employee_code"`
	Name    string `json:"full_name"`
	Dept    string `json:"department"`
	Teaches string `json:"teaches"`
	// The hours they keep today, and where that comes from. Somebody about to
	// move a person needs to see what they are moving them off.
	Pattern string `json:"pattern"`
	Own     bool   `json:"own_pattern"`
}

func (s *Server) listPatternStaff(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT e.id::text, e.employee_code,
		       btrim(concat_ws(' ', e.first_name, e.last_name)) AS name,
		       COALESCE(d.name, ''),
		       /* The grades they take, named once each and in order. A teacher
		          on four sections of Class 6 teaches Class 6, not Class 6 four
		          times. */
		       COALESCE((
		         SELECT string_agg(DISTINCT c.name, ', ' ORDER BY c.name)
		           FROM section_subject_teachers sst
		           JOIN class_subjects cs ON cs.id = sst.class_subject_id
		           JOIN classes c ON c.id = cs.class_id
		          WHERE sst.teacher_user_id = e.user_id), '') AS teaches,
		       COALESCE(p1.name, p2.name, p3.name, ''),
		       (e.work_pattern_id IS NOT NULL)
		  FROM employees e
		  LEFT JOIN departments   d  ON d.id  = e.department_id
		  LEFT JOIN work_patterns p1 ON p1.id = e.work_pattern_id
		  LEFT JOIN work_patterns p2 ON p2.id = d.work_pattern_id
		  LEFT JOIN work_patterns p3 ON p3.institution_id = e.institution_id
		                            AND p3.is_default
		 WHERE e.status = 'active'
		 ORDER BY name, e.employee_code`, nil,
		func(rows pgx.Rows) (patternStaff, error) {
			var v patternStaff
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Dept, &v.Teaches,
				&v.Pattern, &v.Own)
		})
	respond(w, r, items, err)
}
