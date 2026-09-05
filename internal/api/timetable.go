package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
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
	/* How much this colleague is carrying, omitted from teachers.

	   The list itself is needed by everybody: a teacher picking cover, a class
	   teacher naming a subject teacher, the office building a timetable. This
	   one number is not. Together with the rest of the list it is a league
	   table of who is carrying the most, which is a question a head of
	   department answers before moving a class and nobody else has business
	   asking — least of all about the colleague sitting next to them.

	   A pointer so it disappears from the JSON rather than reading zero, which
	   would say something false about everybody. */
	Periods *int `json:"weekly_periods,omitempty"`
	// EmployeeID is what the login endpoint is addressed by.
	EmployeeID string `json:"employee_id"`
	// SignInAs is the username, email or phone they sign in with, and CanSignIn
	// says whether that account has a password yet.
	SignInAs  string `json:"sign_in_as"`
	CanSignIn bool   `json:"can_sign_in"`
	// Roles is what the system lets them do, as distinct from Subjects, which
	// is what they teach, and the designation, which is what the school calls
	// the post.
	Roles string `json:"roles"`
	// Subjects is the comma-joined list of what they teach, for a label that
	// does not require the reader to already know the staff.
	Subjects string `json:"subjects"`
	// ClassTeacherOf names the section they already hold, so a picker can say
	// so rather than silently offering a person who is not free.
	ClassTeacherOf string `json:"class_teacher_of,omitempty"`
}

/*
listPeriods returns the day a particular class actually runs to.

	Every school got one set of periods and every class ran to it. A school
	with a primary section does not work that way: the little ones start later,
	finish earlier and take a longer lunch, and a timetable insisting Grade 1
	changes lesson at 11:30 with Grade 10 is a timetable the primary staff
	ignore -- after which attendance is being marked against periods nobody
	sat.

	Asked for a section or a class, this answers with that one's bell:
	the section's own where it has one, otherwise its class's, otherwise the
	school's default. Asked for neither, it answers with the default, which is
	what every existing caller was getting and still gets.
*/
/*
listBellSchedules names every school day this school runs, and who runs to it.

	A school with a primary section has two: "Standard day" and something like
	"Primary". Which classes belong to which is the fact somebody needs to see
	before they change anything, and it lived nowhere -- a second schedule
	could exist with no class pointing at it, which looks like it is in use and
	is not.
*/
func (s *Server) listBellSchedules(w http.ResponseWriter, r *http.Request) {
	type sched struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		IsDefault bool   `json:"is_default"`
		Periods   int    `json:"periods"`
		StartsAt  string `json:"starts_at,omitempty"`
		EndsAt    string `json:"ends_at,omitempty"`
		// The classes that run to it, named, because an id tells nobody
		// whether the right children were moved.
		Classes string `json:"classes"`
	}
	items, err := collect(s, r, `
		SELECT b.id::text, b.name, b.is_default,
		       (SELECT count(*)::int FROM periods p WHERE p.bell_schedule_id = b.id),
		       COALESCE(to_char((SELECT min(p.starts_at) FROM periods p
		                          WHERE p.bell_schedule_id = b.id),'HH24:MI'),''),
		       COALESCE(to_char((SELECT max(p.ends_at) FROM periods p
		                          WHERE p.bell_schedule_id = b.id),'HH24:MI'),''),
		       COALESCE((SELECT string_agg(c.name, ', ' ORDER BY c.level)
		                   FROM classes c WHERE c.bell_schedule_id = b.id), '')
		  FROM bell_schedules b
		 ORDER BY b.is_default DESC, b.name`, nil,
		func(rows pgx.Rows) (sched, error) {
			var v sched
			return v, rows.Scan(&v.ID, &v.Name, &v.IsDefault, &v.Periods,
				&v.StartsAt, &v.EndsAt, &v.Classes)
		})
	respond(w, r, items, err)
}

func (s *Server) listPeriods(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		WITH want AS (
		  SELECT COALESCE(
		    (SELECT sec.bell_schedule_id FROM sections sec WHERE sec.id = $1::uuid),
		    (SELECT cl.bell_schedule_id FROM classes cl
		      WHERE cl.id = COALESCE($2::uuid,
		            (SELECT class_id FROM sections WHERE id = $1::uuid))),
		    (SELECT b.id FROM bell_schedules b
		      WHERE b.is_default ORDER BY b.created_at LIMIT 1)
		  ) AS id
		)
		SELECT p.id::text, p.name, p.sequence, to_char(p.starts_at,'HH24:MI'),
		       to_char(p.ends_at,'HH24:MI'), p.is_break
		  FROM periods p, want
		 /* A schedule with no periods of its own would otherwise show an empty
		    day, which reads as a school that has not been set up. Falling back
		    to whatever the school has is the honest answer while somebody is
		    still filling it in. */
		 WHERE p.bell_schedule_id = want.id
		    OR (want.id IS NULL AND p.bell_schedule_id IS NULL)
		    OR NOT EXISTS (SELECT 1 FROM periods q2, want w2
		                    WHERE q2.bell_schedule_id = w2.id)
		 ORDER BY p.sequence`,
		[]any{nullUUIDText(q.Get("section_id")), nullUUIDText(q.Get("class_id"))},
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
	/* teacher_id=me, because the caller does not know their own user id.

	   "My timetable" showed a section picker and an empty grid until a
	   teacher chose one of the classes they teach — so the screen named
	   after their own week was the only one that could not show it. The
	   filter existed; there was no way to say "the person asking". */
	teacher := q.Get("teacher_id")
	if teacher == "me" {
		teacher = httpx.IdentityFrom(r.Context()).UserID.String()
	}

	args := []any{
		nullString(q.Get("section_id")),
		nullString(q.Get("academic_year_id")),
		nullString(teacher),
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
	mayPlan := httpx.IdentityFrom(r.Context()).Can(rbac.AcademicsWrite)
	items, err := collect(s, r, `
		/* AN INNER JOIN ON users HID EVERY MEMBER OF STAFF WITHOUT A LOGIN.

		   A class teacher is stored as a user id, so this listed employees
		   joined to their account -- and an employee imported from a
		   spreadsheet has no account until somebody issues one. A school that
		   had just imported its whole staff therefore opened the class-teacher
		   picker and was told "Nobody yet", with every one of them on the roll
		   and none of them offered.

		   Left join now, so they appear. u.id is null for them and the picker
		   cannot assign one -- that part is real, a class teacher marks a
		   register and needs somewhere to sign in -- but being told who exists
		   and why they cannot be chosen is a different thing from an empty
		   list, which reads as staff not having been added at all. */
		SELECT COALESCE(u.id::text, ''),
		       COALESCE(u.full_name, btrim(concat_ws(' ', e.first_name, e.last_name))),
		       e.employee_code, e.id::text,
		       /* What they sign in with, and whether they can.
		
		          The staff list showed names and nothing else, so the only way
		          to find out whether somebody had a working login was to ask
		          them to try. An account created with a staff record but never
		          given a password is 'invited': it exists, and nobody can sign
		          in as it, which is the state ten people were left in here. */
		       COALESCE(u.username::text, u.email::text, u.phone, ''),
		       (u.password_hash IS NOT NULL AND u.status <> 'invited'),
		       /* What they are, not what they teach.
		
		          A list of names with no role beside them made the office check
		          each person against the sheet they were imported from to find
		          out who the HR manager was. Joined rather than derived from
		          the designation, because the designation is what the school
		          calls the post and the role is what the system lets them do. */
		       COALESCE((SELECT string_agg(ro.key, ', ' ORDER BY ro.key)
		                   FROM user_roles ur
		                   JOIN roles ro ON ro.id = ur.role_id
		                  WHERE ur.user_id = u.id), ''),
		       (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = u.id),
		       /* What they teach, joined for the label.

		          A list of bare names asks the person filling it in to know
		          the staff. "Anand Kulkarni · Mathematics, Science" does not,
		          and it is the same query. */
		       COALESCE((SELECT string_agg(sub.name, ', ' ORDER BY sub.name)
		                   FROM teacher_subjects ts
		                   JOIN subjects sub ON sub.id = ts.subject_id
		                  WHERE ts.user_id = u.id), ''),
		       /* The section they are already class teacher of, if any.

		          One person cannot be class teacher of two sections at once,
		          and the dropdown offered them for every one — so the mistake
		          was one click away and nothing on screen warned of it. */
		       COALESCE((SELECT c.name || '-' || sec.name
		                   FROM sections sec
		                   JOIN classes c ON c.id = sec.class_id
		                  WHERE sec.class_teacher_id = u.id
		                  LIMIT 1), '')
		  FROM employees e
		  LEFT JOIN users u ON u.id = e.user_id
		 WHERE e.status = 'active'
		   /* Narrowed to the people who teach the subject, when one is named.

		      The subject-teacher dropdowns offered every member of staff for
		      every subject, so the Telugu row listed the accountant and the
		      person filling it in had to know the staff well enough to ignore
		      most of the list. Every teacher of that subject is offered, and
		      a teacher of three subjects appears under all three.

		      A school that has not recorded who teaches what gets everybody
		      rather than an empty dropdown: the fallback is the old behaviour,
		      which is unhelpful, and an empty list is worse than unhelpful. */
		   AND ($1::uuid IS NULL
		        OR NOT EXISTS (SELECT 1 FROM teacher_subjects ts
		                        WHERE ts.subject_id = $1)
		        OR EXISTS (SELECT 1 FROM teacher_subjects ts
		                    WHERE ts.subject_id = $1 AND ts.user_id = u.id))
		   /* free_class_teacher=true drops anybody who already has a section.

		      Only the class-teacher picker asks for it. The subject-teacher
		      pickers must not: a class teacher of 6-A teaches subjects in
		      other sections, and hiding them there would be the opposite
		      mistake. */
		   AND ($2::bool IS NOT TRUE
		        OR NOT EXISTS (SELECT 1 FROM sections sec
		                        WHERE sec.class_teacher_id = u.id
		                          AND ($3::uuid IS NULL OR sec.id <> $3)))
		 ORDER BY COALESCE(u.full_name,
		                   btrim(concat_ws(' ', e.first_name, e.last_name)))`,
		[]any{
			nullString(r.URL.Query().Get("subject_id")),
			r.URL.Query().Get("free_class_teacher") == "true",
			nullString(r.URL.Query().Get("except_section")),
		},
		func(rows pgx.Rows) (teacher, error) {
			var v teacher
			var periods int
			if err := rows.Scan(&v.UserID, &v.FullName, &v.Code, &v.EmployeeID,
				&v.SignInAs, &v.CanSignIn, &v.Roles, &periods, &v.Subjects,
				&v.ClassTeacherOf); err != nil {
				return v, err
			}
			// Only for whoever plans the timetable. Hiding the tab in the SPA
			// hides the screen, not the number.
			if mayPlan {
				v.Periods = &periods
			}
			return v, nil
		})
	respond(w, r, items, err)
}
