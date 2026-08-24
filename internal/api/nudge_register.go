package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Reminding the people who can actually mark the register.

   The principal's dashboard warned "6 sections without attendance today" and
   offered a button labelled Mark attendance, which landed on a read-only
   report. There is no student-attendance marking screen for a principal and
   there should not be: teachers mark their own registers. So the prompt was a
   dead end — it named a real problem and then offered an action nobody in that
   chair can take.

   What a principal actually does at that moment is chase somebody. So that is
   the button: it finds the sections nobody has marked, works out who is
   responsible for each, and tells them. Not a broadcast to the staff room —
   the class teacher of 6-B has no use for a reminder about 8-A, and a
   notification that is usually not about you is one people stop opening.

   Deliberately a notification rather than an SMS. It is free, it is instant,
   it lands where the teacher already has the register open, and a school that
   nudges twice a week must not be paying per message to do it. The mail and
   SMS providers stay for the things a parent needs to receive outside the app.
*/

type nudgeResult struct {
	// Sections still unmarked at the moment the button was pressed.
	Sections int `json:"sections"`
	// Teachers told. Fewer than sections when one person is class teacher of
	// two, and fewer still when a section has no class teacher at all — which
	// is the case worth knowing about.
	Notified int `json:"notified"`
	// Sections with nobody to tell. A register nobody owns is a gap in the
	// staffing, not in the reminder, and it will not fix itself by being sent
	// again tomorrow.
	Unowned []string `json:"sections_without_a_class_teacher"`
}

// nudgeRegister tells each class teacher whose register is still unmarked.
func (s *Server) nudgeRegister(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	out := nudgeResult{Unowned: []string{}}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* One query for the whole picture: which sections are unmarked, and
		   who owns each. A section with a holiday row counts as marked,
		   because that is what a holiday is. */
		rows, err := tx.Query(r.Context(), `
			SELECT c.name || '-' || s.name, s.class_teacher_id
			  FROM sections s
			  JOIN classes c ON c.id = s.class_id
			 WHERE NOT EXISTS (
			         SELECT 1 FROM student_attendance sa
			          WHERE sa.section_id = s.id AND sa.on_date = CURRENT_DATE)
			   AND EXISTS (
			         SELECT 1 FROM enrollments e
			          WHERE e.section_id = s.id AND e.status = 'active')
			 ORDER BY c.level, s.name`)
		if err != nil {
			return err
		}
		type row struct {
			label   string
			teacher *string
		}
		var unmarked []row
		for rows.Next() {
			var v row
			if err := rows.Scan(&v.label, &v.teacher); err != nil {
				rows.Close()
				return err
			}
			unmarked = append(unmarked, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		out.Sections = len(unmarked)

		// One reminder per teacher, naming their own sections. A teacher with
		// two unmarked registers gets one message listing both, not two
		// messages they have to read separately.
		byTeacher := map[string][]string{}
		for _, u := range unmarked {
			if u.teacher == nil {
				out.Unowned = append(out.Unowned, u.label)
				continue
			}
			byTeacher[*u.teacher] = append(byTeacher[*u.teacher], u.label)
		}

		for teacher, sections := range byTeacher {
			body := "Today's register is not marked for " + joinAnd(sections) +
				". Please mark it before the day closes."
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO notifications (institution_id, user_id, kind, title, body, link)
				VALUES ($1, $2::uuid, 'attendance_reminder', $3, $4,
				        '/go/attendance/take_attendance')`,
				id.InstitutionID, teacher, "Register not marked", body); err != nil {
				return err
			}
			out.Notified++
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// joinAnd writes a list the way a person would say it: "6-A", "6-A and 6-B",
// "6-A, 6-B and 7-A". A comma-separated dump reads as machine output in a
// message a teacher is meant to act on.
func joinAnd(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	out := ""
	for i, it := range items {
		switch {
		case i == 0:
			out = it
		case i == len(items)-1:
			out += " and " + it
		default:
			out += ", " + it
		}
	}
	return out
}
