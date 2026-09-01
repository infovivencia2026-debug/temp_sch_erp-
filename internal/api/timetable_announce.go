package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* Telling a school its timetable has changed.

   Publishing replaces the live grid, and nobody was told. A teacher found out
   on Monday morning by walking to the wrong room. A parent found out when
   their child came home and said so. Both had the new timetable in the app the
   whole time and no reason to go and look at it — which is the specific
   failure of a product that holds the truth and does not mention it.

   THREE AUDIENCES, ONE PASS, and each gets a different sentence, because
   "the timetable has changed" means three different things:

     a teacher wants to know their own week has moved;
     a student wants to know which room on Monday;
     a parent wants to know their child's day has changed, mostly so they
     know when to collect them.

   ONLY THE SECTIONS THE DRAFT TOUCHED. A draft usually covers part of the
   school, and a whole-school alert about a change to two sections is how a
   school learns to ignore this product's notifications. The people told are
   the ones attached to the sections that actually moved.

   NO SMS, NO WHATSAPP. This is in-app only and deliberately so. A timetable
   changes several times a term, it is not urgent on the day it changes, and a
   school that paid to text nine hundred families about it would turn the
   messaging budget off — and with it the absence alerts that matter.
*/
func announceTimetable(
	r *http.Request, tx pgx.Tx, inst uuid.UUID, draftID uuid.UUID,
) (int, error) {

	// The sections this draft wrote, named, so the message can say which.
	rows, err := tx.Query(r.Context(), `
		SELECT DISTINCT sec.id,
		       concat_ws('-', c.name, sec.name)
		  FROM timetable_draft_entries de
		  JOIN sections sec ON sec.id = de.section_id
		  JOIN classes c ON c.id = sec.class_id
		 WHERE de.draft_id = $1`, draftID)
	if err != nil {
		return 0, err
	}
	type sectionRow struct {
		id   uuid.UUID
		name string
	}
	var sections []sectionRow
	for rows.Next() {
		var v sectionRow
		if err := rows.Scan(&v.id, &v.name); err != nil {
			rows.Close()
			return 0, err
		}
		sections = append(sections, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(sections) == 0 {
		return 0, nil
	}

	ids := make([]uuid.UUID, 0, len(sections))
	names := ""
	for i, s := range sections {
		ids = append(ids, s.id)
		if i < 4 {
			if names != "" {
				names += ", "
			}
			names += s.name
		}
	}
	if len(sections) > 4 {
		names += " and others"
	}

	told := 0

	/* --- the staff who teach them -------------------------------------

	   Anybody with a period in the published draft, plus the class teachers
	   of the sections it touched. A class teacher whose section moved needs
	   to know even if they teach none of its periods themselves. */
	staff, err := tx.Query(r.Context(), `
		SELECT DISTINCT de.teacher_user_id
		  FROM timetable_draft_entries de
		 WHERE de.draft_id = $1 AND de.teacher_user_id IS NOT NULL
		UNION
		SELECT sec.class_teacher_id FROM sections sec
		 WHERE sec.id = ANY($2) AND sec.class_teacher_id IS NOT NULL`,
		draftID, ids)
	if err != nil {
		return told, err
	}
	var staffIDs []uuid.UUID
	for staff.Next() {
		var u uuid.UUID
		if err := staff.Scan(&u); err != nil {
			staff.Close()
			return told, err
		}
		staffIDs = append(staffIDs, u)
	}
	staff.Close()
	if err := staff.Err(); err != nil {
		return told, err
	}
	for _, u := range staffIDs {
		if err := notify(r, tx, inst, u, nil, "timetable",
			"The timetable has changed",
			"A new timetable is in use for "+names+". Check your week before Monday.",
			"/go/my_timetable", "timetable", &draftID); err != nil {
			return told, err
		}
		told++
	}

	/* --- the children in them, and their families ---------------------

	   One query for both, because a student and their guardians are told the
	   same fact and differ only in the words. The child's own account is
	   included where they have one; most schools give logins to the family
	   and not to the child, and both cases are ordinary. */
	fam, err := tx.Query(r.Context(), `
		SELECT st.id, concat_ws(' ', st.first_name, st.last_name),
		       u.id, true
		  FROM enrollments en
		  JOIN students st ON st.id = en.student_id
		  JOIN users u ON u.id = st.user_id
		 WHERE en.section_id = ANY($1) AND en.status = 'active'
		UNION ALL
		SELECT st.id, concat_ws(' ', st.first_name, st.last_name),
		       g.user_id, false
		  FROM enrollments en
		  JOIN students st ON st.id = en.student_id
		  JOIN student_guardians sg ON sg.student_id = st.id
		  JOIN guardians g ON g.id = sg.guardian_id
		 WHERE en.section_id = ANY($1) AND en.status = 'active'
		   AND g.user_id IS NOT NULL`, ids)
	if err != nil {
		return told, err
	}
	type person struct {
		student   uuid.UUID
		name      string
		user      uuid.UUID
		isStudent bool
	}
	var people []person
	for fam.Next() {
		var v person
		if err := fam.Scan(&v.student, &v.name, &v.user, &v.isStudent); err != nil {
			fam.Close()
			return told, err
		}
		people = append(people, v)
	}
	fam.Close()
	if err := fam.Err(); err != nil {
		return told, err
	}

	for _, pn := range people {
		sid := pn.student
		title := "The timetable has changed"
		body := ""
		link := "/portal/timetable"
		if pn.isStudent {
			body = "Your class has a new timetable. Check Monday before you come in."
		} else {
			body = pn.name + "'s class has a new timetable. " +
				"The school day may start or end at a different time."
		}
		if err := notify(r, tx, inst, pn.user, &sid, "timetable",
			title, body, link, "timetable", &draftID); err != nil {
			return told, err
		}
		told++
	}
	return told, nil
}
