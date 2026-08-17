package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type period struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Sequence int32  `json:"sequence"`
	StartsAt string `json:"starts_at"`
	EndsAt   string `json:"ends_at"`
	IsBreak  bool   `json:"is_break"`
}

type timetableEntry struct {
	ID          string  `json:"id"`
	SectionID   string  `json:"section_id"`
	SectionName string  `json:"section_name"`
	ClassName   string  `json:"class_name"`
	PeriodID    string  `json:"period_id"`
	PeriodName  string  `json:"period_name"`
	Weekday     int32   `json:"weekday"`
	SubjectName string  `json:"subject_name"`
	SubjectCode string  `json:"subject_code"`
	TeacherID   *string `json:"teacher_id,omitempty"`
	TeacherName *string `json:"teacher_name,omitempty"`
	Room        *string `json:"room,omitempty"`
}

type teacher struct {
	UserID   string `json:"user_id"`
	FullName string `json:"full_name"`
	Code     string `json:"employee_code"`
	Periods  int    `json:"weekly_periods"`
}

func (s *Server) listPeriods(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, name, sequence, to_char(starts_at,'HH24:MI'),
		       to_char(ends_at,'HH24:MI'), is_break
		  FROM periods ORDER BY sequence`, nil,
		func(rows pgx.Rows) (period, error) {
			var v period
			return v, rows.Scan(&v.ID, &v.Name, &v.Sequence, &v.StartsAt, &v.EndsAt, &v.IsBreak)
		})
	respond(w, r, items, err)
}

// listTimetableEntries returns the grid for one section, or the whole school
// when no filter is given. Weekday is ISO-8601 (1=Monday), matching the check
// constraint on the column.
func (s *Server) listTimetableEntries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// TRUE and FALSE take no argument, so $4 must only be supplied when the
	// predicate actually references it — pgx rejects an unused parameter.
	mine, mineArg := res.TimetablePredicate("te.section_id", 4)
	args := []any{
		nullString(q.Get("section_id")),
		nullString(q.Get("academic_year_id")),
		nullString(q.Get("teacher_id")),
	}
	if mineArg != nil {
		args = append(args, mineArg)
	}

	items, err := collect(s, r, `
		SELECT te.id::text, te.section_id::text, sec.name, c.name,
		       te.period_id::text, p.name, te.weekday,
		       sub.name, sub.code,
		       te.teacher_user_id::text, u.full_name, te.room
		  FROM timetable_entries te
		  JOIN sections sec      ON sec.id = te.section_id
		  JOIN classes  c        ON c.id = sec.class_id
		  JOIN periods  p        ON p.id = te.period_id
		  JOIN class_subjects cs ON cs.id = te.class_subject_id
		  JOIN subjects sub      ON sub.id = cs.subject_id
		  LEFT JOIN users u      ON u.id = te.teacher_user_id
		 WHERE ($1::uuid IS NULL OR te.section_id = $1)
		   AND ($2::uuid IS NULL OR te.academic_year_id = $2)
		   AND ($3::uuid IS NULL OR te.teacher_user_id = $3)
		   AND `+mine+`
		 ORDER BY te.weekday, p.sequence`, args,
		func(rows pgx.Rows) (timetableEntry, error) {
			var v timetableEntry
			return v, rows.Scan(&v.ID, &v.SectionID, &v.SectionName, &v.ClassName,
				&v.PeriodID, &v.PeriodName, &v.Weekday, &v.SubjectName, &v.SubjectCode,
				&v.TeacherID, &v.TeacherName, &v.Room)
		})
	respond(w, r, items, err)
}

// listTeachers carries each teacher's weekly period count so the workload view
// can flag over-allocation without a second round trip per teacher.
func (s *Server) listTeachers(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT u.id::text, u.full_name, e.employee_code,
		       (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = u.id)
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		 WHERE e.status = 'active'
		 ORDER BY u.full_name`, nil,
		func(rows pgx.Rows) (teacher, error) {
			var v teacher
			return v, rows.Scan(&v.UserID, &v.FullName, &v.Code, &v.Periods)
		})
	respond(w, r, items, err)
}
