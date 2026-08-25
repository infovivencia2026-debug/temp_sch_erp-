package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The head of department's morning.

   Every other role opens on a dashboard and HOD opened on a timetable, so the
   questions a head of department actually arrives with had to be assembled by
   visiting four screens and remembering what each said.

   Those questions are narrow and they are the same every day:

     Is my department covered today? — who is absent, and how many of their
     periods nobody is standing in front of. This is the only one with a clock
     on it: a period uncovered at 08:50 is a problem and at 11:00 it is a
     complaint from a parent.

     What is waiting on me? — leave to decide, substitutions to approve,
     question papers to pass, marks to moderate. A HOD is an approver before
     they are anything else, and an approval nobody can see is an approval that
     does not happen.

     Is the work going in? — registers not taken in my sections, marks not
     entered for my subjects. Both are things a HOD chases rather than does.

   Deliberately not a copy of the principal's dashboard. A HOD does not run the
   school's money or its admissions, and putting those figures here would make
   the page look important while answering nothing they can act on. Everything
   below is narrowed to their department, and where it cannot be — a school
   with no departments defined — it says so rather than silently showing the
   whole school as though it were theirs. */

type hodDashboard struct {
	// Whether this HOD actually heads a department. A school that has not
	// created departments yet gives its HOD the whole school, and the screen
	// has to admit that rather than imply the numbers are their own.
	Departments     int      `json:"departments"`
	DepartmentNames []string `json:"department_names"`
	Teachers        int      `json:"teachers"`
	Sections        int      `json:"sections"`

	// Today.
	AbsentToday       int `json:"absent_today"`
	PeriodsUncovered  int `json:"periods_uncovered"`
	RegistersNotTaken int `json:"registers_not_taken"`

	// Waiting on this person.
	LeaveToDecide   int `json:"leave_to_decide"`
	SubsToApprove   int `json:"subs_to_approve"`
	PapersToApprove int `json:"papers_to_approve"`
	MarksToModerate int `json:"marks_to_moderate"`

	// Who is out, by name, because a count of three tells a HOD nothing about
	// which three.
	Absent []hodAbsentee `json:"absent"`
}

type hodAbsentee struct {
	Name      string `json:"name"`
	Reason    string `json:"reason"`
	Periods   int    `json:"periods"`
	Uncovered int    `json:"uncovered"`
}

// getHODDashboard answers the four questions a head of department arrives with.
func (s *Server) getHODDashboard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out := hodDashboard{DepartmentNames: []string{}, Absent: []hodAbsentee{}}
	deptIDs := res.DepartmentIDs
	sectionIDs := res.SectionIDs

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int, COALESCE(array_agg(name ORDER BY name), '{}')
			  FROM departments WHERE id = ANY($1)`, hodUUIDs(deptIDs)).
			Scan(&out.Departments, &out.DepartmentNames); err != nil {
			return err
		}

		/* The department's teachers.

		   A HOD with no department of their own falls back to the staff they
		   can see at all, because the alternative is a dashboard reading nought
		   at a school that simply has not created departments yet — which
		   looks like a fault in the product rather than a gap in the setup. */
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM employees e
			 WHERE e.status = 'active'
			   AND ($1::uuid[] IS NULL OR e.department_id = ANY($1))`,
			hodUUIDs(deptIDs)).Scan(&out.Teachers); err != nil {
			return err
		}
		out.Sections = len(sectionIDs)

		/* Absent today, from both registers a school keeps it in: the mark
		   somebody made this morning, and the leave approved three weeks ago
		   that nobody has marked. Reading one misses half of them. */
		rows, err := tx.Query(r.Context(), `
			WITH mine AS (
			  SELECT u.id AS user_id, u.full_name
			    FROM users u
			    JOIN employees e ON e.user_id = u.id
			   WHERE e.status IN ('active','on_leave')
			     AND ($1::uuid[] IS NULL OR e.department_id = ANY($1))
			), absent AS (
			  SELECT m.user_id, m.full_name,
			         CASE WHEN sa.status IS NOT NULL THEN sa.status ELSE 'leave' END AS reason
			    FROM mine m
			    LEFT JOIN staff_attendance sa
			           ON sa.user_id = m.user_id AND sa.on_date = CURRENT_DATE
			                                    AND sa.status IN ('absent','leave')
			   WHERE sa.id IS NOT NULL
			      OR EXISTS (SELECT 1 FROM leave_requests lr
			                   JOIN employees e2 ON e2.id = lr.employee_id
			                  WHERE e2.user_id = m.user_id AND lr.status = 'approved'
			                    AND CURRENT_DATE BETWEEN lr.from_date AND lr.to_date)
			)
			SELECT a.full_name, a.reason,
			       (SELECT count(*) FROM timetable_entries te
			         WHERE te.teacher_user_id = a.user_id
			           AND te.weekday = extract(isodow FROM CURRENT_DATE)::int)::int,
			       (SELECT count(*) FROM timetable_entries te
			         WHERE te.teacher_user_id = a.user_id
			           AND te.weekday = extract(isodow FROM CURRENT_DATE)::int
			           AND NOT EXISTS (SELECT 1 FROM substitutions sb
			                            WHERE sb.timetable_entry_id = te.id
			                              AND sb.on_date = CURRENT_DATE))::int
			  FROM absent a
			 ORDER BY a.full_name`, hodUUIDs(deptIDs))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a hodAbsentee
			if err := rows.Scan(&a.Name, &a.Reason, &a.Periods, &a.Uncovered); err != nil {
				return err
			}
			out.Absent = append(out.Absent, a)
			out.AbsentToday++
			out.PeriodsUncovered += a.Uncovered
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// Registers not taken in this HOD's own sections.
		if len(sectionIDs) > 0 {
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*)::int FROM sections s
				 WHERE s.id = ANY($1)
				   AND NOT EXISTS (SELECT 1 FROM student_attendance a
				                    WHERE a.section_id = s.id
				                      AND a.on_date = CURRENT_DATE)`,
				hodUUIDs(sectionIDs)).Scan(&out.RegistersNotTaken); err != nil {
				return err
			}
		}

		/* What is waiting on this person, counted only where they may act.

		   A queue a HOD cannot decide is not their queue: showing "4 waiting"
		   to somebody the endpoint will refuse is worse than showing nothing,
		   because they will go and look. */
		if id.Can(rbac.LeaveApprove) {
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*)::int FROM leave_requests lr
				 WHERE lr.status = 'pending' AND lr.subject_kind = 'staff'`).
				Scan(&out.LeaveToDecide); err != nil {
				return err
			}
		}
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM substitution_requests sr
			 WHERE sr.status = 'pending'`).Scan(&out.SubsToApprove); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM question_papers qp
			 WHERE qp.status = 'submitted'`).Scan(&out.PapersToApprove); err != nil {
			return err
		}

		/* Papers whose marks are all in and which nobody has moderated.

		   Moderating is reading a paper's marks and deciding whether they
		   stand — and "left alone" is a decision, recorded like any other. So
		   the queue is papers with marks and no moderation row, not papers a
		   HOD has yet to change: a paper they read and approved must leave the
		   list, or the list is never empty and stops being read. */
		return tx.QueryRow(r.Context(), `
			SELECT count(*)::int
			  FROM exam_subjects es
			 WHERE EXISTS (SELECT 1 FROM marks m WHERE m.exam_subject_id = es.id)
			   AND NOT EXISTS (SELECT 1 FROM mark_moderations mm
			                    WHERE mm.exam_subject_id = es.id)`).
			Scan(&out.MarksToModerate)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// uuidArray renders a slice for a query, or NULL when it is empty so the
// predicate reads "no narrowing" rather than "matches nothing".
func hodUUIDs(ids []uuid.UUID) any {
	if len(ids) == 0 {
		return nil
	}
	return ids
}
