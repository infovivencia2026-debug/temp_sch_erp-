package api

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
THE MONTH A TEACHER IS ACTUALLY IN.

	Parents and students each had a calendar; staff had none. A teacher's dates
	were spread across four screens -- the exam timetable, the homework they
	set, the duty roster, and whatever leave they had been granted -- and the
	clash between two of them was only ever found by being in the wrong room.

	Deliberately not the weekly timetable. A teacher teaches five periods a day,
	every day, and putting three hundred of them on a month grid buries the four
	dates that actually matter under the one thing they already know by heart.
	What goes on here is what varies: exams, duties, deadlines they set, days
	they are away, and what the school has closed or scheduled.
*/
func (s *Server) getStaffCalendar(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	from := strings.TrimSpace(r.URL.Query().Get("from"))
	to := strings.TrimSpace(r.URL.Query().Get("to"))
	if from == "" || to == "" {
		httpx.BadRequest(w, r, "from and to are required, as YYYY-MM-DD")
		return
	}
	if to < from {
		httpx.BadRequest(w, r, "to is before from")
		return
	}

	entries := []calendarEntry{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		add := func(sql string, args ...any) error {
			rows, err := tx.Query(r.Context(), sql, args...)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var e calendarEntry
				if err := rows.Scan(&e.Date, &e.EndDate, &e.Kind, &e.Title,
					&e.Detail, &e.StartsAt, &e.Venue, &e.RefID); err != nil {
					return err
				}
				entries = append(entries, e)
			}
			return rows.Err()
		}

		// What the school has closed or scheduled. applies_to 'students' is
		// excluded: a day the children are off but staff are in is not a day
		// off, and showing it as one is how somebody fails to turn up.
		if err := add(`
			SELECT to_char(on_date,'YYYY-MM-DD'), to_char(to_date,'YYYY-MM-DD'),
			       kind, name, description, NULL::text, NULL::text, id::text
			  FROM holidays
			 WHERE on_date <= $2::date AND COALESCE(to_date, on_date) >= $1::date
			   AND applies_to IN ('all','staff')
			 ORDER BY on_date`, from, to); err != nil {
			return err
		}

		if err := add(`
			SELECT to_char(starts_on,'YYYY-MM-DD'), to_char(ends_on,'YYYY-MM-DD'),
			       'exam', name, NULL::text, NULL::text, NULL::text, id::text
			  FROM exams
			 WHERE starts_on <= $2::date AND COALESCE(ends_on, starts_on) >= $1::date
			 ORDER BY starts_on`, from, to); err != nil {
			return err
		}

		/* Duties this person is on. Keyed on user_id, which is how
		   duty_assignments is keyed -- the table's own comment says leave, the
		   timetable and staff attendance all hang off the user, and a duty
		   that cannot be checked against those three is a duty nothing can
		   check. */
		if err := add(`
			SELECT to_char(da.on_date,'YYYY-MM-DD'), NULL::text,
			       'duty', COALESCE(NULLIF(ds.name,''), ds.duty_kind),
			       ds.duty_kind, to_char(ds.starts_at,'HH24:MI'),
			       ds.location, da.id::text
			  FROM duty_assignments da
			  JOIN duty_shifts ds ON ds.id = da.shift_id
			 WHERE da.user_id = $3
			   AND da.on_date BETWEEN $1::date AND $2::date
			   AND da.status <> 'cancelled'
			 ORDER BY da.on_date`, from, to, id.UserID); err != nil {
			return err
		}

		/* Homework this teacher set, on the day it falls due -- which is the
		   day the marking arrives, and the thing a teacher plans around. */
		if err := add(`
			SELECT to_char(h.due_on,'YYYY-MM-DD'), NULL::text,
			       'homework', COALESCE(NULLIF(h.title,''), 'Homework'),
			       concat_ws(' · ', c.name, sec.name), NULL::text, NULL::text,
			       h.id::text
			  FROM homework h
			  JOIN sections sec ON sec.id = h.section_id
			  JOIN classes c ON c.id = sec.class_id
			 WHERE h.created_by = $3
			   AND h.due_on IS NOT NULL
			   AND h.due_on BETWEEN $1::date AND $2::date
			 ORDER BY h.due_on`, from, to, id.UserID); err != nil {
			return err
		}

		// Their own approved leave. Pending is shown too, and labelled, so a
		// teacher does not plan a trip around a day nobody has granted yet.
		return add(`
			SELECT to_char(lr.from_date,'YYYY-MM-DD'), to_char(lr.to_date,'YYYY-MM-DD'),
			       'leave',
			       CASE WHEN lr.status = 'approved' THEN 'Leave'
			            ELSE 'Leave (' || lr.status || ')' END,
			       lt.name, NULL::text, NULL::text, lr.id::text
			  FROM leave_requests lr
			  LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
			  JOIN employees e ON e.id = lr.employee_id
			 WHERE e.user_id = $3
			   AND lr.status IN ('approved','pending')
			   AND lr.from_date <= $2::date AND lr.to_date >= $1::date
			 ORDER BY lr.from_date`, from, to, id.UserID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": entries})
}
