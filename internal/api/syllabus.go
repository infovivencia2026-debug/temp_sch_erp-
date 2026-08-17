package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The syllabus, the plans that deliver it, and how far through a class is.

   "Are we behind?" is asked every fortnight by a head of department and once a
   year by an inspection, and the product could not answer it: it knew a class
   studies Mathematics and nothing about what Mathematics contains.

   The chain is units -> lesson plan -> approval -> delivered -> coverage.
   Coverage is computed on read, never stored, because a stored percentage is
   wrong the moment a chapter is added and nobody remembers to recompute it. */

// --- units ---------------------------------------------------------------------

type unitRow struct {
	ID          string  `json:"id"`
	Sequence    int     `json:"sequence"`
	Title       string  `json:"title"`
	Description *string `json:"description,omitempty"`
	Outcomes    *string `json:"outcomes,omitempty"`
	Periods     int     `json:"planned_periods"`
	ClassName   string  `json:"class_name"`
	Subject     string  `json:"subject"`
	// Delivered is true once an approved plan covering this unit has been
	// marked taught. It is the whole point of the table.
	Delivered   bool    `json:"delivered"`
	DeliveredOn *string `json:"delivered_on,omitempty"`
}

func (s *Server) listSyllabusUnits(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT u.id::text, u.sequence, u.title, u.description, u.outcomes,
		       u.planned_periods, c.name, sub.name,
		       EXISTS (SELECT 1 FROM lesson_plan_units lpu
		                 JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
		                WHERE lpu.syllabus_unit_id = u.id
		                  AND lp.delivered_on IS NOT NULL),
		       to_char((SELECT max(lp.delivered_on) FROM lesson_plan_units lpu
		                  JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
		                 WHERE lpu.syllabus_unit_id = u.id), 'YYYY-MM-DD')
		  FROM syllabus_units u
		  JOIN class_subjects cs ON cs.id = u.class_subject_id
		  JOIN classes         c ON c.id = cs.class_id
		  JOIN subjects      sub ON sub.id = cs.subject_id
		 WHERE u.is_active
		   AND ($1::uuid IS NULL OR u.class_subject_id = $1)
		   AND ($2::uuid IS NULL OR cs.class_id = $2)
		 ORDER BY c.level, sub.name, u.sequence`,
		[]any{nullString(r.URL.Query().Get("class_subject_id")),
			nullString(r.URL.Query().Get("class_id"))},
		func(rows pgx.Rows) (unitRow, error) {
			var v unitRow
			return v, rows.Scan(&v.ID, &v.Sequence, &v.Title, &v.Description,
				&v.Outcomes, &v.Periods, &v.ClassName, &v.Subject,
				&v.Delivered, &v.DeliveredOn)
		})
	respond(w, r, items, err)
}

type unitsRequest struct {
	ClassSubjectID string `json:"class_subject_id"`
	Units          []struct {
		Title    string `json:"title"`
		Periods  int    `json:"planned_periods,omitempty"`
		Outcomes string `json:"outcomes,omitempty"`
	} `json:"units"`
}

// setSyllabusUnits replaces a subject's chapter list.
//
// Replace rather than append, because a syllabus is edited as a whole — a
// school revising Class 8 Science does not want last year's chapters
// interleaved with this year's. Units already covered by a delivered plan are
// kept: deleting one would silently reduce the coverage a class has already
// earned.
func (s *Server) setSyllabusUnits(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req unitsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	csID, err := uuid.Parse(req.ClassSubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	if len(req.Units) == 0 {
		httpx.BadRequest(w, r, "give at least one chapter")
		return
	}

	var written, kept int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			WITH doomed AS (
			  DELETE FROM syllabus_units u
			   WHERE u.class_subject_id = $1
			     AND NOT EXISTS (SELECT 1 FROM lesson_plan_units lpu
			                       JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
			                      WHERE lpu.syllabus_unit_id = u.id
			                        AND lp.delivered_on IS NOT NULL)
			  RETURNING 1)
			SELECT (SELECT count(*) FROM syllabus_units WHERE class_subject_id = $1
			         AND EXISTS (SELECT 1 FROM lesson_plan_units lpu
			                       JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
			                      WHERE lpu.syllabus_unit_id = syllabus_units.id
			                        AND lp.delivered_on IS NOT NULL))::int
			  FROM (SELECT count(*) FROM doomed) x`, csID).Scan(&kept); err != nil {
			return err
		}

		for i, u := range req.Units {
			title := strings.TrimSpace(u.Title)
			if title == "" {
				continue
			}
			periods := u.Periods
			if periods <= 0 {
				periods = 1
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO syllabus_units (institution_id, class_subject_id, sequence,
				                            title, planned_periods, outcomes)
				VALUES ($1,$2,$3,$4,$5,NULLIF($6,''))`,
				id.InstitutionID, csID, kept+i+1, title, periods, u.Outcomes); err != nil {
				return err
			}
			written++
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"chapters": written, "kept_already_taught": kept,
	})
}

// --- lesson plans -----------------------------------------------------------------

type planRow2 struct {
	ID          string   `json:"id"`
	SectionName string   `json:"section"`
	ClassName   string   `json:"class_name"`
	Subject     string   `json:"subject"`
	Teacher     *string  `json:"teacher,omitempty"`
	WeekOf      string   `json:"week_of"`
	Status      string   `json:"status"`
	Objectives  *string  `json:"objectives,omitempty"`
	Remarks     *string  `json:"remarks,omitempty"`
	DeliveredOn *string  `json:"delivered_on,omitempty"`
	Units       []string `json:"units"`
	// WaitingDays is what a review queue is actually sorted by.
	WaitingDays int `json:"waiting_days"`
}

// listLessonPlans serves both the teacher's own list and the reviewer's queue.
//
// Same endpoint, narrowed by who is asking: a teacher without the approval
// permission sees only their own plans, which is what makes it safe to leave
// open to them.
func (s *Server) listLessonPlans(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	mine := "TRUE"
	args := []any{nullString(r.URL.Query().Get("status"))}
	if !id.Can(rbac.AcademicsWrite) && !id.Can(rbac.LeaveApprove) {
		mine = "lp.teacher_user_id = $2"
		args = append(args, id.UserID)
	}

	items, err := collect(s, r, `
		SELECT lp.id::text, sec.name, c.name, sub.name, u.full_name,
		       to_char(lp.week_of,'YYYY-MM-DD'), lp.status, lp.objectives, lp.remarks,
		       to_char(lp.delivered_on,'YYYY-MM-DD'),
		       COALESCE(array_agg(su.title ORDER BY su.sequence)
		                FILTER (WHERE su.id IS NOT NULL), '{}'),
		       COALESCE(EXTRACT(day FROM now() - lp.submitted_at)::int, 0)
		  FROM lesson_plans lp
		  JOIN sections       sec ON sec.id = lp.section_id
		  JOIN classes          c ON c.id = sec.class_id
		  JOIN class_subjects  cs ON cs.id = lp.class_subject_id
		  JOIN subjects       sub ON sub.id = cs.subject_id
		  LEFT JOIN users       u ON u.id = lp.teacher_user_id
		  LEFT JOIN lesson_plan_units lpu ON lpu.lesson_plan_id = lp.id
		  LEFT JOIN syllabus_units    su ON su.id = lpu.syllabus_unit_id
		 WHERE ($1::text IS NULL OR lp.status = $1)
		   AND `+mine+`
		 GROUP BY lp.id, sec.name, c.name, sub.name, u.full_name
		 ORDER BY lp.week_of DESC, c.name
		 LIMIT 200`, args,
		func(rows pgx.Rows) (planRow2, error) {
			var v planRow2
			return v, rows.Scan(&v.ID, &v.SectionName, &v.ClassName, &v.Subject,
				&v.Teacher, &v.WeekOf, &v.Status, &v.Objectives, &v.Remarks,
				&v.DeliveredOn, &v.Units, &v.WaitingDays)
		})
	respond(w, r, items, err)
}

type lessonPlanRequest struct {
	SectionID      string   `json:"section_id"`
	ClassSubjectID string   `json:"class_subject_id"`
	WeekOf         string   `json:"week_of"`
	Objectives     string   `json:"objectives,omitempty"`
	Activities     string   `json:"activities,omitempty"`
	Resources      string   `json:"resources,omitempty"`
	Homework       string   `json:"homework,omitempty"`
	UnitIDs        []string `json:"unit_ids,omitempty"`
	// Submit sends it for approval in the same call; a teacher writing a plan
	// and then hunting for a submit button is a plan that stays in draft.
	Submit bool `json:"submit,omitempty"`
}

func (s *Server) saveLessonPlan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req lessonPlanRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	section, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	csID, err := uuid.Parse(req.ClassSubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	if req.WeekOf == "" {
		httpx.BadRequest(w, r, "week_of is required")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// A teacher plans for a section they teach. The office may plan for any.
	if !res.AllAttendance && !res.CanMarkSection(section) {
		httpx.Forbidden(w, r, "a lesson plan for this section")
		return
	}

	status := "draft"
	if req.Submit {
		status = "submitted"
	}

	var planID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO lesson_plans (institution_id, section_id, class_subject_id,
			                          teacher_user_id, week_of, objectives, activities,
			                          resources, homework, status, submitted_at)
			VALUES ($1,$2,$3,$4,$5::date,NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),
			        NULLIF($9,''),$10, CASE WHEN $10 = 'submitted' THEN now() END)
			ON CONFLICT (section_id, class_subject_id, week_of)
			DO UPDATE SET objectives = EXCLUDED.objectives,
			              activities = EXCLUDED.activities,
			              resources  = EXCLUDED.resources,
			              homework   = EXCLUDED.homework,
			              -- An approved plan that is edited goes back for
			              -- review; silently keeping the approval would let a
			              -- teacher rewrite what a head of department signed.
			              status     = EXCLUDED.status,
			              submitted_at = EXCLUDED.submitted_at,
			              reviewed_by = NULL, reviewed_at = NULL, remarks = NULL,
			              updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, section, csID, id.UserID, req.WeekOf,
			req.Objectives, req.Activities, req.Resources, req.Homework,
			status).Scan(&planID); err != nil {
			return err
		}

		if _, err := tx.Exec(r.Context(),
			`DELETE FROM lesson_plan_units WHERE lesson_plan_id = $1::uuid`, planID); err != nil {
			return err
		}
		for _, u := range req.UnitIDs {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO lesson_plan_units (lesson_plan_id, syllabus_unit_id)
				VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, planID, u); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": planID, "status": status})
}

type planDecisionRequest struct {
	Decision string `json:"decision"` // approved | returned
	Remarks  string `json:"remarks,omitempty"`
	// Delivered marks the lesson as actually taught, which is what advances
	// coverage. Separate from approval: a plan can be approved and then not
	// taught because the school closed.
	DeliveredOn string `json:"delivered_on,omitempty"`
}

var errReturnNeedsRemarks = errors.New("say why it is being returned — a plan sent back without remarks tells the teacher nothing")

func (s *Server) decideLessonPlan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	planID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid lesson plan id")
		return
	}
	var req planDecisionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	switch req.Decision {
	case "approved", "returned", "":
	default:
		httpx.BadRequest(w, r, "decision must be approved or returned")
		return
	}
	if req.Decision == "returned" && strings.TrimSpace(req.Remarks) == "" {
		httpx.BadRequest(w, r, errReturnNeedsRemarks.Error())
		return
	}

	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE lesson_plans
			   SET status       = COALESCE(NULLIF($2,''), status),
			       remarks      = COALESCE(NULLIF($3,''), remarks),
			       delivered_on = COALESCE(NULLIF($4,'')::date, delivered_on),
			       reviewed_by  = CASE WHEN $2 <> '' THEN $5 ELSE reviewed_by END,
			       reviewed_at  = CASE WHEN $2 <> '' THEN now() ELSE reviewed_at END,
			       updated_at   = now()
			 WHERE id = $1`,
			planID, req.Decision, req.Remarks, req.DeliveredOn, id.UserID)
		found = err == nil && tag.RowsAffected() > 0
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": planID.String()})
}

// --- coverage -----------------------------------------------------------------------

type coverageRow struct {
	ClassSubjectID string  `json:"class_subject_id"`
	ClassName      string  `json:"class_name"`
	Subject        string  `json:"subject"`
	Teacher        *string `json:"teacher,omitempty"`
	Units          int     `json:"units"`
	Delivered      int     `json:"delivered"`
	Percent        int     `json:"percent"`
	// Behind is the judgement a head of department would make, made once here
	// so every screen agrees on it: less than three quarters through with more
	// than three quarters of the year gone.
	Behind       bool    `json:"behind"`
	LastTaught   *string `json:"last_taught,omitempty"`
	PlansWaiting int     `json:"plans_waiting"`
}

// getSyllabusCoverage answers "are we behind?" for every class-subject.
func (s *Server) getSyllabusCoverage(w http.ResponseWriter, r *http.Request) {
	elapsed := yearElapsedPercent(time.Now())
	items, err := collect(s, r, `
		SELECT cs.id::text, c.name, sub.name,
		       (SELECT u2.full_name FROM section_subject_teachers t
		          JOIN users u2 ON u2.id = t.teacher_user_id
		         WHERE t.class_subject_id = cs.id LIMIT 1),
		       count(u.id)::int,
		       count(u.id) FILTER (
		         WHERE EXISTS (SELECT 1 FROM lesson_plan_units lpu
		                         JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
		                        WHERE lpu.syllabus_unit_id = u.id
		                          AND lp.delivered_on IS NOT NULL))::int,
		       to_char((SELECT max(lp.delivered_on)
		                  FROM lesson_plans lp
		                 WHERE lp.class_subject_id = cs.id), 'YYYY-MM-DD'),
		       (SELECT count(*) FROM lesson_plans lp2
		         WHERE lp2.class_subject_id = cs.id AND lp2.status = 'submitted')::int
		  FROM class_subjects cs
		  JOIN classes         c ON c.id = cs.class_id
		  JOIN subjects      sub ON sub.id = cs.subject_id
		  LEFT JOIN syllabus_units u ON u.class_subject_id = cs.id AND u.is_active
		 WHERE ($1::uuid IS NULL OR cs.class_id = $1)
		 GROUP BY cs.id, c.name, c.level, sub.name
		 HAVING count(u.id) > 0
		 ORDER BY c.level, sub.name`,
		[]any{nullString(r.URL.Query().Get("class_id"))},
		func(rows pgx.Rows) (coverageRow, error) {
			var v coverageRow
			if err := rows.Scan(&v.ClassSubjectID, &v.ClassName, &v.Subject, &v.Teacher,
				&v.Units, &v.Delivered, &v.LastTaught, &v.PlansWaiting); err != nil {
				return v, err
			}
			if v.Units > 0 {
				v.Percent = v.Delivered * 100 / v.Units
			}
			v.Behind = v.Percent < 75 && elapsed > 75
			return v, nil
		})
	respond(w, r, items, err)
}

/*
How far through the academic year today is.

	Used only to decide whether "60% covered" is comfortable or alarming: in
	August it is fine and in February it is a problem, and the same percentage
	means both. Computed from the June start directly rather than by faking a
	request through the range resolver — borrowing that machinery for a number
	with no request behind it is how a helper ends up depending on HTTP.
*/
func yearElapsedPercent(now time.Time) int {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		loc = time.UTC
	}
	now = now.In(loc)
	start := academicYearStart(now)
	// June to April inclusive; the rest of May is holiday and counts as done.
	const yearDays = 334
	elapsed := now.Sub(start).Hours() / 24
	switch {
	case elapsed <= 0:
		return 0
	case elapsed >= yearDays:
		return 100
	default:
		return int(elapsed / yearDays * 100)
	}
}
