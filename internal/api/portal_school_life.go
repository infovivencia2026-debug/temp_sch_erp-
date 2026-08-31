package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* The rest of a family's school life: the calendar, the meeting, the album,
   the seat, the plan, the card, the alert and the canteen bill.

   Nine catalogued screens, mounted inside the same /portal group as
   portal_requests.go and under the same single rule. That group requires
   self.profile.read, which every role in the product holds — internal/rbac has
   a test asserting exactly that — so the permission admits the librarian and
   the driver just as readily as the parent. It is a floor, not a gate.

   What actually separates one family from another is the ownership check at the
   top of every handler here: resolveScope, then OwnsStudent on whatever id the
   caller sent. There is no AllStudents escape hatch on these paths. A back
   office role that legitimately reads a child's file has its own endpoints;
   letting it in through the family's door would mean the door has no lock.

   Refusals are 404 and never 403. "This child exists but is not yours" is
   already a disclosure — it is the one an attacker uses to confirm a roll
   number — so an unrelated id is answered exactly as a nonexistent one.

   Two things are worth saying about what is NOT here.

   A PTM booking is an appointments row. The front office has kept a diary since
   00025 and it is the diary the school actually works from; a parallel
   parent-side booking table would be the one that disagrees on the morning of
   the meeting. bookPTM therefore writes an appointment, and slot availability
   is derived by counting them.

   A notification is a notifications row. That table has existed since the
   baseline with nobody writing to it, because there was no safe way to deliver
   the same fact twice. 00035 adds the source columns that make delivery
   idempotent, so the feed below is a materialiser rather than a second store. */

// mountParentSchoolLife registers the family's school-life, support-plan,
// identity, alert and canteen routes.
//
// Called from inside the existing /portal group, so the paths here are
// relative and inherit its self.profile.read floor. The three staff-only
// endpoints — the two gate scanners and the admission mark — re-gate on
// office.front_desk.write, for the same reason the pickup release does: a
// parent must never be able to record their own arrival.
func (s *Server) mountParentSchoolLife(r chi.Router) {
	// Calendar and parent-teacher meetings.
	r.Get("/school-life/calendar", s.getFamilyCalendar)
	r.Get("/school-life/ptm/slots", s.listPTMSlots)
	r.Get("/school-life/ptm/bookings", s.listPTMBookings)
	r.Post("/school-life/ptm/book", s.bookPTMSlot)
	r.Post("/school-life/ptm/{id}/cancel", s.cancelPTMBooking)

	// Photographs and video from school events.
	r.Get("/school-life/gallery", s.listGalleryAlbums)
	r.Get("/school-life/gallery/{id}", s.getGalleryAlbum)

	// Seats at an event held in a hall.
	r.Get("/school-life/event-passes", s.listEventPasses)
	r.Post("/school-life/event-passes", s.claimEventPass)
	// The door, not the family.
	r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).
		Get("/school-life/event-passes/verify", s.verifyEventPass)
	r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).
		Post("/school-life/event-passes/{id}/admit", s.admitEventPass)

	// The support plan, and progress against its goals.
	r.Get("/academics/iep", s.getFamilyIEP)

	// Identity at the gate.
	r.Get("/profile/student-id-card", s.getStudentIDCard)
	r.Get("/profile/parent-id-card", s.getParentIDCard)
	r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).
		Get("/profile/id-card/verify", s.verifyCampusPass)

	// Alerts.
	/* "Has anything I can see changed?" — one string, on a timer.

	   Mounted beside the bell because it is the same idea a size larger: the
	   bell keeps itself fresh, this keeps every other screen fresh. Open to
	   anybody signed in; the answer is already narrowed to what the caller can
	   see. */
	r.Get("/live", s.getLiveRevision)
	r.Get("/notifications", s.listFamilyNotifications)
	r.Post("/notifications/{id}/read", s.markNotificationRead)
	r.Post("/notifications/read-all", s.markAllNotificationsRead)

	// The canteen till.
	r.Get("/cafeteria/purchases", s.listCafeteriaPurchases)
}

// --- scoping -----------------------------------------------------------------

/*
familyChildren resolves which children a read covers.

	portalChild in portal_requests.go answers "which one child is this about",
	and refuses a parent of three who names none — correct for a write, because
	guessing would file a leave application against the wrong sibling.

	A read is different. A calendar or an alert feed probed with no student_id
	should show the whole family rather than 400, so the bare GET is useful and
	a screen can render before its picker has been touched. Naming a child still
	narrows, and naming somebody else's is still refused as though the id did
	not exist.
*/
func (s *Server) familyChildren(r *http.Request, raw string) (*scope.Resolved, []uuid.UUID, error) {
	res, err := s.resolveScope(r)
	if err != nil {
		return nil, nil, err
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return res, res.StudentIDs, nil
	}
	sid, err := uuid.Parse(raw)
	if err != nil || !res.OwnsStudent(sid) {
		// Deliberately the same answer for a malformed id, an id belonging to
		// another family and an id that was never issued.
		return res, nil, errNotYourChild
	}
	return res, []uuid.UUID{sid}, nil
}

// familyDates reads the from/to window a screen asked for, defaulting to the
// span a school calendar is actually looked at over: the recent past and the
// term ahead. An unparseable date falls back rather than 400 — a stale
// bookmark should show the calendar, not an error.
func familyDates(r *http.Request, backDays, forwardDays int) (time.Time, time.Time) {
	now := nowInIndia()
	from := now.AddDate(0, 0, -backDays)
	to := now.AddDate(0, 0, forwardDays)
	if v, err := time.Parse(time.DateOnly, r.URL.Query().Get("from")); err == nil {
		from = v
	}
	if v, err := time.Parse(time.DateOnly, r.URL.Query().Get("to")); err == nil {
		to = v
	}
	if to.Before(from) {
		from, to = to, from
	}
	return from, to
}

// --- calendar ----------------------------------------------------------------

type calendarEntry struct {
	Date     string  `json:"date"`
	EndDate  *string `json:"end_date,omitempty"`
	Kind     string  `json:"kind"`
	Title    string  `json:"title"`
	Detail   *string `json:"detail,omitempty"`
	StartsAt *string `json:"starts_at,omitempty"`
	Venue    *string `json:"venue,omitempty"`
	// The row this entry came from, so a screen can link a PTM entry to the
	// booking it may cancel and an event to its album.
	RefID   *string `json:"ref_id,omitempty"`
	Student *string `json:"student_name,omitempty"`
}

/*
getFamilyCalendar merges everything a family's year is made of.

	Five sources, one list, deliberately not five endpoints: a parent asking
	"what is on in March" does not know that a holiday, an examination and a
	concert are three tables, and a screen that made them fetch three times
	would render them in three boxes that scroll independently.

	Terms are included as their own entries because the boundary is what makes
	the rest legible — "second term begins" is the line that explains why the
	fee instalment and the examination cluster where they do.
*/
func (s *Server) getFamilyCalendar(w http.ResponseWriter, r *http.Request) {
	res, kids, err := s.familyChildren(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}
	from, to := familyDates(r, 30, 120)

	id := httpx.IdentityFrom(r.Context())
	entries := []calendarEntry{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		add := func(sql string, args ...any) error {
			rows, err := tx.Query(r.Context(), sql, args...)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var v calendarEntry
				if err := rows.Scan(&v.Date, &v.EndDate, &v.Kind, &v.Title,
					&v.Detail, &v.StartsAt, &v.Venue, &v.RefID, &v.Student); err != nil {
					return err
				}
				entries = append(entries, v)
			}
			return rows.Err()
		}

		// Holidays already carry kind='ptm' and kind='event', so the school's
		// own calendar entries arrive with their meaning intact rather than
		// being flattened to "holiday".
		if err := add(`
			SELECT to_char(on_date,'YYYY-MM-DD'), to_char(to_date,'YYYY-MM-DD'),
			       kind, name, description, NULL::text, NULL::text,
			       id::text, NULL::text
			  FROM holidays
			 WHERE on_date <= $2 AND COALESCE(to_date, on_date) >= $1
			   AND applies_to IN ('all','students')
			 ORDER BY on_date`, from, to); err != nil {
			return err
		}

		if err := add(`
			SELECT to_char(starts_on,'YYYY-MM-DD'), to_char(ends_on,'YYYY-MM-DD'),
			       'exam', name, NULL::text, NULL::text, NULL::text,
			       id::text, NULL::text
			  FROM exams
			 WHERE starts_on IS NOT NULL
			   AND starts_on <= $2 AND COALESCE(ends_on, starts_on) >= $1
			 ORDER BY starts_on`, from, to); err != nil {
			return err
		}

		if err := add(`
			SELECT to_char(starts_on,'YYYY-MM-DD'), to_char(ends_on,'YYYY-MM-DD'),
			       'term', name, NULL::text, NULL::text, NULL::text,
			       id::text, NULL::text
			  FROM terms
			 WHERE starts_on <= $2 AND ends_on >= $1
			 ORDER BY starts_on`, from, to); err != nil {
			return err
		}

		// A published event, and only one this family's children are in scope
		// for: section_id null is the whole school, otherwise the child has to
		// be enrolled in that section.
		if err := add(`
			SELECT to_char(e.on_date,'YYYY-MM-DD'), to_char(e.ends_on,'YYYY-MM-DD'),
			       e.kind, e.name, e.description, to_char(e.starts_at,'HH24:MI'),
			       e.venue, e.id::text, NULL::text
			  FROM school_events e
			 WHERE e.is_published
			   AND e.on_date <= $2 AND COALESCE(e.ends_on, e.on_date) >= $1
			   AND (e.section_id IS NULL OR EXISTS (
			         SELECT 1 FROM enrollments en
			          WHERE en.student_id = ANY($3) AND en.section_id = e.section_id))
			 ORDER BY e.on_date`, from, to, kids); err != nil {
			return err
		}

		/* HOMEWORK DUE.

		   The reason a parent opens a calendar at all. Scoped by enrolment,
		   so a family with two children in different sections sees each
		   child's work against that child's name rather than one merged pile
		   they cannot act on.

		   Published work only: a draft a teacher is still writing is not
		   something to hold a child to. */
		if err := add(`
			SELECT to_char(h.due_on,'YYYY-MM-DD'), NULL::text,
			       'homework',
			       COALESCE(NULLIF(h.title,''), 'Homework'),
			       COALESCE(sub.name, ''), NULL::text, NULL::text,
			       h.id::text, concat_ws(' ', st.first_name, st.last_name)
			  FROM homework h
			  JOIN enrollments en ON en.section_id = h.section_id
			  JOIN students st ON st.id = en.student_id
			  LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id
			  LEFT JOIN subjects sub ON sub.id = cs.subject_id
			 WHERE en.student_id = ANY($3)
			   AND h.due_on IS NOT NULL
			   AND h.due_on BETWEEN $1 AND $2
			   AND h.is_published
			   AND en.status = 'active'
			 ORDER BY h.due_on`, from, to, kids); err != nil {
			return err
		}

		/* FEES DUE.

		   The other reason. An invoice that is already settled is not a date
		   anybody needs warning about, so only what is still owed appears --
		   which also means the entry disappears from the calendar the moment
		   the money is taken, with no second write to keep in step. */
		if err := add(`
			SELECT to_char(i.due_on,'YYYY-MM-DD'), NULL::text,
			       'fee_due',
			       'Fees due: ' || to_char((i.net_paise - i.paid_paise)/100.0, 'FM99,99,999.00'),
			       i.invoice_no, NULL::text, NULL::text,
			       i.id::text, concat_ws(' ', st.first_name, st.last_name)
			  FROM invoices i
			  JOIN students st ON st.id = i.student_id
			 WHERE i.student_id = ANY($3)
			   AND i.due_on IS NOT NULL
			   AND i.due_on BETWEEN $1 AND $2
			   AND i.status IN ('unpaid','partial','overdue')
			 ORDER BY i.due_on`, from, to, kids); err != nil {
			return err
		}

		// The family's own booked meetings. Not every appointment in the
		// diary — only the ones about a child of theirs.
		return add(`
			SELECT to_char(a.on_date,'YYYY-MM-DD'), NULL::text,
			       'ptm_booking',
			       -- nullif, because concat_ws over a missing employee returns
			       -- an empty string rather than null, and COALESCE would then
			       -- happily render the title as a bare "Meeting: ".
			       COALESCE('Meeting: ' || nullif(concat_ws(' ', emp.first_name, emp.last_name), ''),
			                'Parent-teacher meeting'),
			       a.purpose, to_char(a.starts_at,'HH24:MI'), NULL::text,
			       a.id::text, concat_ws(' ', st.first_name, st.last_name)
			  FROM appointments a
			  JOIN students st ON st.id = a.student_id
			  LEFT JOIN employees emp ON emp.id = a.with_employee_id
			 WHERE a.student_id = ANY($3) AND a.status = 'booked'
			   AND a.on_date BETWEEN $1 AND $2
			 ORDER BY a.on_date, a.starts_at`, from, to, kids)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":    entries,
		"from":     from.Format(time.DateOnly),
		"to":       to.Format(time.DateOnly),
		"children": len(res.StudentIDs),
	})
}

// --- parent-teacher meetings -------------------------------------------------

type ptmSlotRow struct {
	ID       string  `json:"id"`
	Teacher  string  `json:"teacher"`
	Section  *string `json:"section,omitempty"`
	Date     string  `json:"on_date"`
	StartsAt string  `json:"starts_at"`
	Minutes  int     `json:"minutes"`
	Mode     string  `json:"mode"`
	Location *string `json:"location,omitempty"`
	Notes    *string `json:"notes,omitempty"`
	// Taken by somebody — possibly by this family, possibly not. A screen shows
	// a taken slot greyed rather than hiding it, because a parent who booked at
	// nine o'clock and cannot find it again rings the office.
	Taken bool `json:"taken"`
	// Taken by this family, and by which child.
	MineFor *string `json:"booked_for,omitempty"`
}

/*
listPTMSlots offers the times a family may still take.

	Availability is counted from appointments rather than stored on the slot.
	A flag would be a second copy of the diary's own fact, and it is the copy
	left stale when the front desk cancels a meeting from its own screen —
	whereupon the slot stays grey forever and the teacher sits alone.
*/
func (s *Server) listPTMSlots(w http.ResponseWriter, r *http.Request) {
	_, kids, err := s.familyChildren(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}
	from, to := familyDates(r, 0, 90)

	// A slot is offered to a family when it is unscoped, or scoped to a section
	// one of their children is enrolled in. Without the second clause every
	// parent in the school sees every class teacher's diary.
	items, err := collect(s, r, `
		SELECT sl.id::text, concat_ws(' ', emp.first_name, emp.last_name), sec.name,
		       to_char(sl.on_date,'YYYY-MM-DD'), to_char(sl.starts_at,'HH24:MI'),
		       sl.minutes, sl.mode, sl.location, sl.notes,
		       bk.id IS NOT NULL,
		       CASE WHEN bk.student_id = ANY($3)
		            THEN concat_ws(' ', bs.first_name, bs.last_name) END
		  FROM ptm_slots sl
		  JOIN employees emp ON emp.id = sl.employee_id
		  LEFT JOIN sections sec ON sec.id = sl.section_id
		  LEFT JOIN LATERAL (
		      SELECT a.id, a.student_id FROM appointments a
		       WHERE a.with_employee_id = sl.employee_id
		         AND a.on_date = sl.on_date AND a.starts_at = sl.starts_at
		         AND a.status = 'booked'
		       LIMIT 1
		  ) bk ON true
		  LEFT JOIN students bs ON bs.id = bk.student_id
		 WHERE sl.is_open
		   AND sl.on_date BETWEEN $1 AND $2
		   AND (sl.section_id IS NULL OR EXISTS (
		         SELECT 1 FROM enrollments en
		          WHERE en.student_id = ANY($3) AND en.section_id = sl.section_id))
		 ORDER BY sl.on_date, sl.starts_at
		 LIMIT 300`, []any{from, to, kids},
		func(rows pgx.Rows) (ptmSlotRow, error) {
			var v ptmSlotRow
			return v, rows.Scan(&v.ID, &v.Teacher, &v.Section, &v.Date, &v.StartsAt,
				&v.Minutes, &v.Mode, &v.Location, &v.Notes, &v.Taken, &v.MineFor)
		})
	respond(w, r, items, err)
}

type ptmBookingRow struct {
	ID        string  `json:"id"`
	StudentID string  `json:"student_id"`
	Student   string  `json:"student_name"`
	Teacher   *string `json:"teacher,omitempty"`
	Date      string  `json:"on_date"`
	StartsAt  string  `json:"starts_at"`
	Minutes   int     `json:"minutes"`
	Purpose   string  `json:"purpose"`
	Status    string  `json:"status"`
	Outcome   *string `json:"outcome,omitempty"`
	// Whether the family may still withdraw. A meeting already held or already
	// cancelled cannot be, and offering the button would only produce a 409.
	Cancellable bool `json:"cancellable"`
	// What the teacher wrote up afterwards, when the school chose to share it.
	Concerns      *string `json:"concerns,omitempty"`
	AgreedActions *string `json:"agreed_actions,omitempty"`
}

/*
listPTMBookings is the family's own meetings, before and after.

	It joins ptm_notes on purpose. A parent who attended in October and is asked
	in January whether the extra reading was ever agreed has, today, only their
	memory; the school wrote it down and marked it visible_to_family, and
	nothing was ever showing it to them. A note the school withheld stays
	withheld — visible_to_family is checked, not assumed.
*/
func (s *Server) listPTMBookings(w http.ResponseWriter, r *http.Request) {
	_, kids, err := s.familyChildren(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}
	today := nowInIndia().Format(time.DateOnly)
	items, err := collect(s, r, `
		SELECT a.id::text, a.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       nullif(concat_ws(' ', emp.first_name, emp.last_name), ''),
		       to_char(a.on_date,'YYYY-MM-DD'), to_char(a.starts_at,'HH24:MI'),
		       a.minutes, a.purpose, a.status, a.outcome,
		       a.status = 'booked' AND a.on_date >= $2::date,
		       n.concerns, n.agreed_actions
		  FROM appointments a
		  JOIN students st ON st.id = a.student_id
		  LEFT JOIN employees emp ON emp.id = a.with_employee_id
		  LEFT JOIN LATERAL (
		      SELECT p.concerns, p.agreed_actions FROM ptm_notes p
		       WHERE p.student_id = a.student_id AND p.met_on = a.on_date
		         AND p.visible_to_family
		       LIMIT 1
		  ) n ON true
		 WHERE a.student_id = ANY($1)
		 ORDER BY a.on_date DESC, a.starts_at DESC
		 LIMIT 100`, []any{kids, today},
		func(rows pgx.Rows) (ptmBookingRow, error) {
			var v ptmBookingRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.Teacher,
				&v.Date, &v.StartsAt, &v.Minutes, &v.Purpose, &v.Status,
				&v.Outcome, &v.Cancellable, &v.Concerns, &v.AgreedActions)
		})
	respond(w, r, items, err)
}

/*
bookPTMSlot takes a published time and writes it into the front desk's diary.

	The insert is into appointments and nowhere else. That is the whole point:
	the receptionist's screen, the teacher's day sheet and the parent's app are
	then reading one row, and a meeting cancelled at the desk disappears from
	the app without anybody having to remember a second table.

	Two callers racing for the last slot are separated by the partial unique
	index appointments_no_double_booking, not by a check-then-insert here.
	Checking first and inserting after leaves a window the width of a network
	round trip, and a school running its PTM evening on one wifi connection
	will find it.
*/
func (s *Server) bookPTMSlot(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SlotID    string `json:"slot_id"`
		StudentID string `json:"student_id"`
		Note      string `json:"note"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	slotID, err := uuid.Parse(strings.TrimSpace(req.SlotID))
	if err != nil {
		httpx.BadRequest(w, r, "invalid slot id")
		return
	}
	// A write names its child. familyChildren's "all of them" default is for
	// reads; booking against a guess would seat the wrong sibling.
	_, studentID, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var apptID uuid.UUID
	var taken, closed, past, wrongSection bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			employee uuid.UUID
			section  *uuid.UUID
			onDate   time.Time
			minutes  int
			isOpen   bool
			teacher  string
			// Read back as text and handed straight to the insert as a time
			// literal. pgx has no native mapping for Postgres's time-of-day,
			// and routing it through a Go duration loses the timezone-free
			// meaning that makes "10:30 in the school's day" correct.
			startText string
		)
		err := tx.QueryRow(r.Context(), `
			SELECT sl.employee_id, sl.section_id, sl.on_date,
			       to_char(sl.starts_at,'HH24:MI:SS'), sl.minutes, sl.is_open,
			       concat_ws(' ', emp.first_name, emp.last_name)
			  FROM ptm_slots sl
			  JOIN employees emp ON emp.id = sl.employee_id
			 WHERE sl.id = $1`, slotID).
			Scan(&employee, &section, &onDate, &startText, &minutes, &isOpen, &teacher)
		if err != nil {
			return err
		}
		if !isOpen {
			closed = true
			return nil
		}
		// Compared as calendar days in Indian time, not as instants. A box
		// running UTC rolls into tomorrow at half past five in the evening
		// local, which would refuse this evening's slots from lunchtime on.
		if onDate.Format(time.DateOnly) < nowInIndia().Format(time.DateOnly) {
			past = true
			return nil
		}
		// A slot published for one class is not on offer to the rest of the
		// school. The list endpoint already hides it; this refuses the id a
		// caller went round the list to find.
		if section != nil {
			var ok bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM enrollments
				                WHERE student_id = $1 AND section_id = $2)`,
				studentID, *section).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				wrongSection = true
				return nil
			}
		}

		// visitor_name is required by the table and is the name the desk will
		// call out. The signed-in guardian's own name is the honest answer;
		// the guardian record's may be a spouse's.
		var visitor string
		var phone *string
		if err := tx.QueryRow(r.Context(), `
			SELECT full_name, phone FROM users WHERE id = $1`, id.UserID).
			Scan(&visitor, &phone); err != nil {
			return err
		}
		purpose := "Parent-teacher meeting"
		if n := strings.TrimSpace(req.Note); n != "" {
			purpose = "Parent-teacher meeting: " + n
		}

		/* ON CONFLICT DO NOTHING rather than catching the unique violation
		   afterwards. Letting the insert raise aborts the whole transaction,
		   and the handler's tidy "that slot has just been taken" then dies at
		   commit with "commit unexpectedly resulted in rollback" — a 500 for
		   what is an ordinary race between two parents.

		   The inference clause repeats appointments_no_double_booking's
		   columns and predicate exactly; Postgres matches a partial index by
		   its predicate, so an omitted WHERE would fail to find the index and
		   raise instead of skipping. */
		err = tx.QueryRow(r.Context(), `
			INSERT INTO appointments (institution_id, with_employee_id, student_id,
			                          requested_by, visitor_name, phone, on_date,
			                          starts_at, minutes, purpose, status)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8::time,$9,$10,'booked')
			ON CONFLICT (with_employee_id, on_date, starts_at)
			  WHERE status = 'booked' AND with_employee_id IS NOT NULL
			DO NOTHING
			RETURNING id`,
			id.InstitutionID, employee, studentID, id.UserID, visitor, phone,
			onDate, startText, minutes, purpose).Scan(&apptID)
		if err == pgx.ErrNoRows {
			// Nothing inserted means the slot was taken between the list this
			// caller read and the button they pressed.
			taken = true
			return nil
		}
		if err != nil {
			return err
		}

		// The confirmation the parent will look for on the morning. Written
		// through the same idempotent path as every other alert so that a
		// double-tapped button does not produce two.
		if err := notify(r, tx, id.InstitutionID, id.UserID, &studentID, "ptm",
			"Parent-teacher meeting booked",
			fmt.Sprintf("%s with %s at %s", onDate.Format("Mon 2 Jan"), teacher, startText[:5]),
			"/portal/school-life/ptm", "appointment", &apptID); err != nil {
			return err
		}

		/* The reminder before the meeting, queued now and held until then.

		   parent.school_life.ptm_appointment_reminder_alert. The rule -- which
		   channel, how many minutes ahead, what it says -- is a
		   message_trigger_rules row on event 'ptm.upcoming' and not anything
		   decided here; see emitPTMReminder in comms.go.

		   The error is swallowed on purpose, and only this one. EmitMessageEvent
		   already refuses to fail on a school's configuration, so anything it
		   does return is a database fault -- but this transaction is a family
		   booking a meeting, and a school that has not finished buying an SMS
		   account must not find that its parents cannot book. Logged rather
		   than dropped silently. */
		if err := s.emitPTMReminder(r.Context(), tx, id.InstitutionID, apptID,
			studentID, employee, ptmMomentOf(onDate, startText), teacher,
			startText[:5]); err != nil {
			httpx.LogError(r, err)
		}
		return nil
	})
	switch {
	case err == pgx.ErrNoRows:
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	case closed:
		httpx.Denied(w, r, "that slot is no longer being offered")
	case past:
		httpx.Denied(w, r, "that slot is in the past")
	case wrongSection:
		// Same answer as a slot that does not exist: a parent probing slot ids
		// must not learn which other classes have meetings scheduled.
		httpx.NotFound(w, r)
	case taken:
		httpx.Denied(w, r, "that slot has just been taken")
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": apptID.String()})
	}
}

/*
cancelPTMBooking withdraws a meeting the family booked.

	Only while it is still 'booked'. A meeting recorded as met has an outcome
	written against it, and rewriting that row to 'cancelled' would delete the
	school's record of what was said — which is the half of the file that gets
	quoted back in a dispute.
*/
func (s *Server) cancelPTMBooking(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	apptID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid booking id")
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.NotFound(w, r)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var found, cancelled bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The ownership predicate is in the UPDATE itself rather than in a
		// SELECT before it, so there is no window in which the row could change
		// hands between the check and the write.
		tag, err := tx.Exec(r.Context(), `
			UPDATE appointments SET status = 'cancelled'
			 WHERE id = $1 AND student_id = ANY($2) AND status = 'booked'`,
			apptID, res.StudentIDs)
		if err != nil {
			return err
		}
		cancelled = tag.RowsAffected() == 1
		if cancelled {
			// The meeting is off, so the reminder about it must not go. Only
			// a queued one is dropped: a reminder already sent is something
			// the parent has read.
			return dropPTMReminder(r.Context(), tx, id.InstitutionID, apptID)
		}
		// Nothing changed. Distinguish "not yours" from "already decided", but
		// only far enough to give the second one a useful message.
		return tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM appointments
			                WHERE id = $1 AND student_id = ANY($2))`,
			apptID, res.StudentIDs).Scan(&found)
	})
	switch {
	case err != nil:
		httpx.Internal(w, r, err)
	case cancelled:
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "cancelled"})
	case found:
		httpx.Denied(w, r, "that meeting can no longer be cancelled")
	default:
		httpx.NotFound(w, r)
	}
}

// --- gallery -----------------------------------------------------------------

type galleryAlbum struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Kind     string  `json:"kind"`
	Date     string  `json:"on_date"`
	Venue    *string `json:"venue,omitempty"`
	Detail   *string `json:"description,omitempty"`
	Photos   int     `json:"photo_count"`
	Videos   int     `json:"video_count"`
	CoverID  *string `json:"cover_file_id,omitempty"`
	ForClass *string `json:"section,omitempty"`
}

/*
listGalleryAlbums lists the events a family may look at pictures of.

	Counts come from event_media rows that are both published and whose file has
	not been deleted, so an album never advertises four photographs and then
	opens on three. A school withdrawing one picture — because somebody else's
	child is in frame — must not have to withdraw the album to do it.
*/
func (s *Server) listGalleryAlbums(w http.ResponseWriter, r *http.Request) {
	_, kids, err := s.familyChildren(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}
	items, err := collect(s, r, `
		SELECT e.id::text, e.name, e.kind, to_char(e.on_date,'YYYY-MM-DD'),
		       e.venue, e.description,
		       COALESCE(m.photos, 0), COALESCE(m.videos, 0), m.cover::text, sec.name
		  FROM school_events e
		  LEFT JOIN sections sec ON sec.id = e.section_id
		  LEFT JOIN LATERAL (
		      SELECT count(*) FILTER (WHERE em.media_kind = 'photo') AS photos,
		             count(*) FILTER (WHERE em.media_kind = 'video') AS videos,
		             (array_agg(em.file_id ORDER BY em.sort_order, em.created_at))[1] AS cover
		        FROM event_media em
		        JOIN files f ON f.id = em.file_id
		       WHERE em.event_id = e.id
		         AND em.published_at IS NOT NULL AND f.deleted_at IS NULL
		  ) m ON true
		 WHERE e.is_published
		   AND (e.section_id IS NULL OR EXISTS (
		         SELECT 1 FROM enrollments en
		          WHERE en.student_id = ANY($1) AND en.section_id = e.section_id))
		 ORDER BY e.on_date DESC
		 LIMIT 100`, []any{kids},
		func(rows pgx.Rows) (galleryAlbum, error) {
			var v galleryAlbum
			return v, rows.Scan(&v.ID, &v.Name, &v.Kind, &v.Date, &v.Venue,
				&v.Detail, &v.Photos, &v.Videos, &v.CoverID, &v.ForClass)
		})
	respond(w, r, items, err)
}

type galleryItem struct {
	ID       string  `json:"id"`
	FileID   string  `json:"file_id"`
	Kind     string  `json:"media_kind"`
	Caption  *string `json:"caption,omitempty"`
	Name     string  `json:"original_name"`
	Type     string  `json:"content_type"`
	Size     int64   `json:"size_bytes"`
	Uploaded string  `json:"published_on"`
}

/*
getGalleryAlbum opens one album.

	The scoping repeats the list's predicate rather than trusting that the
	caller reached here from the list. An album id is guessable and a section
	scoped event is somebody's class photograph; a handler that only filtered
	on the way in would hand it to the whole school.

	File ids are returned, not URLs. Presigning an object key from a family
	endpoint is a decision that deserves its own review — the same line
	listPortalDocuments draws — and the download route already exists to make
	it once, in one place.
*/
func (s *Server) getGalleryAlbum(w http.ResponseWriter, r *http.Request) {
	_, kids, err := s.familyChildren(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}
	eventID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid album id")
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var album galleryAlbum
	items := []galleryItem{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT e.id::text, e.name, e.kind, to_char(e.on_date,'YYYY-MM-DD'),
			       e.venue, e.description, sec.name
			  FROM school_events e
			  LEFT JOIN sections sec ON sec.id = e.section_id
			 WHERE e.id = $1 AND e.is_published
			   AND (e.section_id IS NULL OR EXISTS (
			         SELECT 1 FROM enrollments en
			          WHERE en.student_id = ANY($2) AND en.section_id = e.section_id))`,
			eventID, kids).
			Scan(&album.ID, &album.Name, &album.Kind, &album.Date, &album.Venue,
				&album.Detail, &album.ForClass)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT em.id::text, em.file_id::text, em.media_kind, em.caption,
			       f.original_name, f.content_type, f.size_bytes,
			       to_char(em.published_at,'YYYY-MM-DD')
			  FROM event_media em
			  JOIN files f ON f.id = em.file_id
			 WHERE em.event_id = $1
			   AND em.published_at IS NOT NULL AND f.deleted_at IS NULL
			 ORDER BY em.sort_order, em.created_at
			 LIMIT 500`, eventID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v galleryItem
			if err := rows.Scan(&v.ID, &v.FileID, &v.Kind, &v.Caption, &v.Name,
				&v.Type, &v.Size, &v.Uploaded); err != nil {
				return err
			}
			if v.Kind == "photo" {
				album.Photos++
			} else {
				album.Videos++
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	switch {
	case err == pgx.ErrNoRows:
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"album": album, "items": items})
	}
}

// --- event seating passes ----------------------------------------------------

type eventPassRow struct {
	ID        string  `json:"id"`
	EventID   string  `json:"event_id"`
	Event     string  `json:"event_name"`
	Date      string  `json:"on_date"`
	StartsAt  *string `json:"starts_at,omitempty"`
	Venue     *string `json:"venue,omitempty"`
	StudentID string  `json:"student_id"`
	Student   string  `json:"student_name"`
	Row       *string `json:"row_label,omitempty"`
	SeatFrom  *int    `json:"seat_from,omitempty"`
	Seats     int     `json:"seats"`
	Code      string  `json:"code"`
	Note      *string `json:"note,omitempty"`
	IssuedAt  string  `json:"issued_at"`
	Admitted  *string `json:"admitted_at,omitempty"`
	Revoked   *string `json:"revoked_at,omitempty"`
}

// listEventPasses is what the family may show at the door tonight.
func (s *Server) listEventPasses(w http.ResponseWriter, r *http.Request) {
	_, kids, err := s.familyChildren(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}
	items, err := collect(s, r, `
		SELECT p.id::text, p.event_id::text, e.name, to_char(e.on_date,'YYYY-MM-DD'),
		       to_char(e.starts_at,'HH24:MI'), e.venue,
		       p.student_id::text, concat_ws(' ', st.first_name, st.last_name),
		       p.row_label, p.seat_from, p.seats, p.code, p.note,
		       to_char(p.issued_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(p.admitted_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(p.revoked_at,'YYYY-MM-DD"T"HH24:MI')
		  FROM event_seat_passes p
		  JOIN school_events e ON e.id = p.event_id
		  JOIN students st ON st.id = p.student_id
		 WHERE p.student_id = ANY($1)
		 ORDER BY e.on_date DESC, p.issued_at DESC
		 LIMIT 100`, []any{kids},
		func(rows pgx.Rows) (eventPassRow, error) {
			var v eventPassRow
			return v, rows.Scan(&v.ID, &v.EventID, &v.Event, &v.Date, &v.StartsAt,
				&v.Venue, &v.StudentID, &v.Student, &v.Row, &v.SeatFrom, &v.Seats,
				&v.Code, &v.Note, &v.IssuedAt, &v.Admitted, &v.Revoked)
		})
	respond(w, r, items, err)
}

/*
claimEventPass allocates the family their seats.

	Seats are handed out in the order families claim them, which is the only
	allocation rule a school can operate without a seating plan, and it is
	honest: the parent who books on the morning the event is announced sits at
	the front. A school that wants a plan overrides row_label and seat_from from
	its own screen afterwards.

	The event row is locked for the allocation. Two parents claiming at once
	would otherwise both read the same highest seat number and be sent to the
	same two chairs — the exact failure the paper list at the door prevents by
	being one piece of paper.
*/
func (s *Server) claimEventPass(w http.ResponseWriter, r *http.Request) {
	var req struct {
		EventID   string `json:"event_id"`
		StudentID string `json:"student_id"`
		Seats     int    `json:"seats"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	eventID, err := uuid.Parse(strings.TrimSpace(req.EventID))
	if err != nil {
		httpx.BadRequest(w, r, "invalid event id")
		return
	}
	_, studentID, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	seats := req.Seats
	if seats <= 0 {
		seats = 2 // Two parents. The commonest answer, and the one the table defaults to.
	}
	if seats > 20 {
		httpx.BadRequest(w, r, "at most 20 seats")
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var (
		passID   uuid.UUID
		code     string
		rowLabel string
		seatFrom int
		already  bool
		past     bool
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			name    string
			onDate  time.Time
			section *uuid.UUID
		)
		// FOR UPDATE serialises the seat allocation below. The lock is on the
		// event, so two families claiming for different events do not queue.
		err := tx.QueryRow(r.Context(), `
			SELECT name, on_date, section_id FROM school_events
			 WHERE id = $1 AND is_published
			 FOR UPDATE`, eventID).Scan(&name, &onDate, &section)
		if err != nil {
			return err
		}
		if onDate.Format(time.DateOnly) < nowInIndia().Format(time.DateOnly) {
			past = true
			return nil
		}
		if section != nil {
			var ok bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM enrollments
				                WHERE student_id = $1 AND section_id = $2)`,
				studentID, *section).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return pgx.ErrNoRows
			}
		}

		// The next free seat, counting only live passes: a revoked pass frees
		// its chairs, and leaving a gap for it would empty the front row.
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(MAX(seat_from + seats), 1)
			  FROM event_seat_passes
			 WHERE event_id = $1 AND revoked_at IS NULL AND seat_from IS NOT NULL`,
			eventID).Scan(&seatFrom); err != nil {
			return err
		}
		// Twenty to a row, lettered from A. Arbitrary, but a number the screen
		// can state, which is better than a seat with no row at all.
		rowLabel = string(rune('A' + ((seatFrom - 1) / 20)))

		code, err = eventPassCode()
		if err != nil {
			return err
		}
		// DO NOTHING rather than a caught violation, for the same reason as the
		// PTM booking above: a raised constraint aborts the transaction and
		// turns "you already have a pass" into a 500 at commit. The predicate
		// matches event_seat_passes_one_live.
		err = tx.QueryRow(r.Context(), `
			INSERT INTO event_seat_passes (institution_id, event_id, student_id,
			                               row_label, seat_from, seats, code, issued_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (event_id, student_id) WHERE revoked_at IS NULL
			DO NOTHING
			RETURNING id`,
			id.InstitutionID, eventID, studentID, rowLabel, seatFrom, seats,
			code, id.UserID).Scan(&passID)
		if err == pgx.ErrNoRows {
			already = true
			return nil
		}
		if err != nil {
			return err
		}
		return notify(r, tx, id.InstitutionID, id.UserID, &studentID, "event",
			"Seats confirmed for "+name,
			fmt.Sprintf("Row %s, seats %d–%d on %s", rowLabel, seatFrom,
				seatFrom+seats-1, onDate.Format("Mon 2 Jan")),
			"/portal/school-life/events", "event_pass", &passID)
	})
	switch {
	case err == pgx.ErrNoRows:
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	case past:
		httpx.Denied(w, r, "that event has already happened")
	case already:
		httpx.Denied(w, r, "this child already has a pass for that event")
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{
			"id": passID.String(), "code": code,
			"row_label": rowLabel, "seat_from": seatFrom, "seats": seats,
		})
	}
}

// eventPassCode returns an eight-digit code from the cryptographic source.
// Longer than the six-digit pickup code because an event issues hundreds at
// once and they are all live on the same evening.
func eventPassCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(100000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%08d", n.Int64()), nil
}

/*
verifyEventPass is the door's lookup, and is staff-only.

	It answers what the person at the door needs and nothing else: whose pass,
	for which event, how many chairs, and whether it has already been used. A
	pass presented twice is the one worth catching, so an already-admitted pass
	is reported as valid=false with the time it was first used, rather than
	simply not found — "not found" would send the second holder to argue at the
	desk instead of being turned away with a reason.
*/
func (s *Server) verifyEventPass(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		// A bare probe describes itself rather than failing. The scanner screen
		// renders before anything has been scanned.
		httpx.JSON(w, http.StatusOK, map[string]any{
			"valid": false, "reason": "no code presented",
		})
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var (
		pass  eventPassRow
		found bool
	)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT p.id::text, p.event_id::text, e.name, to_char(e.on_date,'YYYY-MM-DD'),
			       to_char(e.starts_at,'HH24:MI'), e.venue,
			       p.student_id::text, concat_ws(' ', st.first_name, st.last_name),
			       p.row_label, p.seat_from, p.seats, p.code, p.note,
			       to_char(p.issued_at,'YYYY-MM-DD"T"HH24:MI'),
			       to_char(p.admitted_at,'YYYY-MM-DD"T"HH24:MI'),
			       to_char(p.revoked_at,'YYYY-MM-DD"T"HH24:MI')
			  FROM event_seat_passes p
			  JOIN school_events e ON e.id = p.event_id
			  JOIN students st ON st.id = p.student_id
			 WHERE p.code = $1`, code).
			Scan(&pass.ID, &pass.EventID, &pass.Event, &pass.Date, &pass.StartsAt,
				&pass.Venue, &pass.StudentID, &pass.Student, &pass.Row,
				&pass.SeatFrom, &pass.Seats, &pass.Code, &pass.Note,
				&pass.IssuedAt, &pass.Admitted, &pass.Revoked)
		if err == pgx.ErrNoRows {
			return nil
		}
		found = err == nil
		return err
	})
	if err != nil && err != pgx.ErrNoRows {
		httpx.Internal(w, r, err)
		return
	}

	switch {
	case !found:
		httpx.JSON(w, http.StatusOK, map[string]any{"valid": false, "reason": "no such pass"})
	case pass.Revoked != nil:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"valid": false, "reason": "pass withdrawn", "pass": pass})
	case pass.Admitted != nil:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"valid": false, "reason": "already admitted at " + *pass.Admitted, "pass": pass})
	case pass.Date != nowInIndia().Format(time.DateOnly):
		httpx.JSON(w, http.StatusOK, map[string]any{
			"valid": false, "reason": "pass is for " + pass.Date, "pass": pass})
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"valid": true, "pass": pass})
	}
}

// admitEventPass records the family walking in. Staff only, and once.
func (s *Server) admitEventPass(w http.ResponseWriter, r *http.Request) {
	passID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid pass id")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var admitted bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The admitted_at IS NULL predicate is the single-use guarantee. A
		// check followed by an update would let two doors admit the same pass.
		tag, err := tx.Exec(r.Context(), `
			UPDATE event_seat_passes
			   SET admitted_at = now(), admitted_by = $2
			 WHERE id = $1 AND admitted_at IS NULL AND revoked_at IS NULL`,
			passID, id.UserID)
		if err != nil {
			return err
		}
		admitted = tag.RowsAffected() == 1
		return nil
	})
	switch {
	case err != nil:
		httpx.Internal(w, r, err)
	case admitted:
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "admitted"})
	default:
		httpx.Denied(w, r, "that pass has already been used or withdrawn")
	}
}

// --- support plan and goals --------------------------------------------------

type iepGoalUpdate struct {
	Date  string   `json:"on_date"`
	Value *float64 `json:"value,omitempty"`
	Note  *string  `json:"note,omitempty"`
}

type iepGoal struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Domain   string   `json:"domain"`
	Baseline *float64 `json:"baseline_value,omitempty"`
	Target   *float64 `json:"target_value,omitempty"`
	Latest   *float64 `json:"latest_value,omitempty"`
	LatestOn *string  `json:"latest_on,omitempty"`
	Unit     *string  `json:"unit,omitempty"`
	Higher   bool     `json:"higher_is_better"`
	StartsOn string   `json:"starts_on"`
	TargetOn *string  `json:"target_on,omitempty"`
	Status   string   `json:"status"`
	// Null rather than zero when the goal is qualitative or has never been
	// observed. A progress bar drawn at 0% for a goal nobody has measured reads
	// as a child who has made no progress, which is a different and much worse
	// statement than "not measured yet".
	Percent *int            `json:"progress_percent,omitempty"`
	Updates []iepGoalUpdate `json:"updates"`
}

/*
getFamilyIEP is the child's support plan and how the goals in it are going.

	student_support_plans has held the concern and the accommodations since
	00019 and no family-facing screen ever showed them, so a parent who agreed a
	plan in a meeting had no copy of it. The goals and their observations are
	new in 00035.

	Two filters matter. Only a plan for a child of the caller's, and only goals
	the school marked visible_to_family — a goal recorded from a clinical
	referral is not always the school's to disclose, and defaulting that flag to
	true means withholding is a decision somebody took rather than an accident.

	Progress is computed here rather than stored, from the newest observation
	against the goal's fixed endpoints. It is direction-agnostic on purpose:
	dividing by (target - baseline) makes a goal to reduce prompting from 8 to 2
	read as 100% when the child reaches 2, without a special case.
*/
func (s *Server) getFamilyIEP(w http.ResponseWriter, r *http.Request) {
	// whichChild rather than portalChild: this is a read, and a parent of two
	// opening the screen before touching the picker should see a child's plan
	// rather than a 404. Reused from portal_family.go, which drew the same line
	// for fees and results — a third resolver with the same job would only be
	// the one that disagrees about what "no student_id" means.
	studentID, ok := s.whichChild(w, r)
	if !ok {
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var (
		plan struct {
			ID              *string `json:"id,omitempty"`
			Concern         *string `json:"concern,omitempty"`
			Accommodations  *string `json:"accommodations,omitempty"`
			ExamConcession  *string `json:"exam_concession,omitempty"`
			ExternalSupport *string `json:"external_support,omitempty"`
			ReviewOn        *string `json:"review_on,omitempty"`
			Status          *string `json:"status,omitempty"`
		}
		student string
		goals   = []iepGoal{}
	)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT concat_ws(' ', first_name, middle_name, last_name)
			  FROM students WHERE id = $1`, studentID).Scan(&student); err != nil {
			return err
		}
		// The live plan. A closed one is history the office keeps; showing it
		// alongside the current accommodations would have a parent working from
		// instructions the school has withdrawn.
		err := tx.QueryRow(r.Context(), `
			SELECT id::text, concern, accommodations, exam_concession,
			       external_support, to_char(review_on,'YYYY-MM-DD'), status
			  FROM student_support_plans
			 WHERE student_id = $1 AND status <> 'closed'
			 ORDER BY created_at DESC LIMIT 1`, studentID).
			Scan(&plan.ID, &plan.Concern, &plan.Accommodations, &plan.ExamConcession,
				&plan.ExternalSupport, &plan.ReviewOn, &plan.Status)
		if err == pgx.ErrNoRows {
			return nil // No plan is a normal answer, not a failure.
		}
		if err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT g.id::text, g.title, g.domain, g.baseline_value, g.target_value,
			       g.unit, g.higher_is_better, to_char(g.starts_on,'YYYY-MM-DD'),
			       to_char(g.target_on,'YYYY-MM-DD'), g.status,
			       u.value, to_char(u.on_date,'YYYY-MM-DD')
			  FROM student_support_goals g
			  LEFT JOIN LATERAL (
			      SELECT gu.value, gu.on_date FROM student_support_goal_updates gu
			       WHERE gu.goal_id = g.id AND gu.value IS NOT NULL
			       ORDER BY gu.on_date DESC LIMIT 1
			  ) u ON true
			 WHERE g.plan_id = $1 AND g.visible_to_family
			 ORDER BY g.status, g.target_on NULLS LAST, g.created_at`, *plan.ID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var g iepGoal
			if err := rows.Scan(&g.ID, &g.Title, &g.Domain, &g.Baseline, &g.Target,
				&g.Unit, &g.Higher, &g.StartsOn, &g.TargetOn, &g.Status,
				&g.Latest, &g.LatestOn); err != nil {
				rows.Close()
				return err
			}
			g.Updates = []iepGoalUpdate{}
			g.Percent = goalPercent(g.Baseline, g.Target, g.Latest)
			goals = append(goals, g)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// The observations behind each bar, so a review meeting can see the
		// trend rather than a single number somebody may dispute.
		for i := range goals {
			hist, err := tx.Query(r.Context(), `
				SELECT to_char(on_date,'YYYY-MM-DD'), value, note
				  FROM student_support_goal_updates
				 WHERE goal_id = $1
				 ORDER BY on_date DESC LIMIT 24`, goals[i].ID)
			if err != nil {
				return err
			}
			for hist.Next() {
				var u iepGoalUpdate
				if err := hist.Scan(&u.Date, &u.Value, &u.Note); err != nil {
					hist.Close()
					return err
				}
				goals[i].Updates = append(goals[i].Updates, u)
			}
			hist.Close()
			if err := hist.Err(); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": studentID.String(), "student_name": student,
		"plan": plan, "goals": goals,
		// Said plainly. "No plan" and "a plan with no goals yet" are different
		// messages, and a parent reading the wrong one telephones the office.
		"has_plan": plan.ID != nil,
	})
}

// goalPercent places the newest observation between baseline and target.
//
// Returns nil for a qualitative goal or one never observed: a bar drawn at zero
// for an unmeasured goal reads as a child who has not moved.
func goalPercent(baseline, target, latest *float64) *int {
	if baseline == nil || target == nil || latest == nil || *target == *baseline {
		return nil
	}
	pct := int(((*latest - *baseline) / (*target - *baseline)) * 100)
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return &pct
}

// --- identity at the gate ----------------------------------------------------

/*
The pass code is derived, never stored.

	A card whose code sits in a column is a card whose code leaks with the
	table, and a leaked set of working passes is precisely what the printed
	plastic card already is — the thing this replaces. So the row holds a random
	secret and the code is HMAC(secret, serial|window), recomputed on the
	holder's screen and again at the gate.

	The window is two and a half minutes. Long enough that a parent walking from
	the car park does not watch it change mid-queue, short enough that a
	screenshot forwarded to somebody else is dead before they arrive. Verify
	accepts the neighbouring windows too, because the gate's tablet and the
	parent's phone are never quite agreed on the time.
*/
const passWindow = 150 * time.Second

// passCodeAt is the code for one window. Base32 without padding, so it reads
// aloud unambiguously over a noisy gate — no 0/O or 1/I confusion.
func passCodeAt(secret []byte, serial string, window int64) string {
	mac := hmac.New(sha256.New, secret)
	fmt.Fprintf(mac, "%s|%d", serial, window)
	return base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(mac.Sum(nil))[:8]
}

// passWindowNow is the current window number, shared by issuer and verifier.
func passWindowNow() int64 { return time.Now().Unix() / int64(passWindow.Seconds()) }

// newPassSerial returns the stable printed number: two letters naming the kind
// of holder, then eight base32 characters.
func newPassSerial(prefix string) (string, error) {
	buf := make([]byte, 5)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return prefix + "-" + base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(buf)[:8], nil
}

/*
ensurePass finds or issues the caller's live card.

	Issuing lazily on first view is deliberate. The alternative is a school
	running a batch job to mint cards for every parent, most of which are never
	looked at, and every one of which is a live credential sitting in a table.

	Exactly one of user or student is set; the table's check constraint enforces
	it and the unique index — which COALESCEs both nullable columns, because a
	null inside a unique index silently permits duplicates — keeps it to one
	live card per holder.
*/
func (s *Server) ensurePass(r *http.Request, tx pgx.Tx, inst uuid.UUID,
	user *uuid.UUID, student *uuid.UUID, prefix string) (serial string, secret []byte, err error) {

	err = tx.QueryRow(r.Context(), `
		SELECT serial, secret FROM campus_entry_passes
		 WHERE institution_id = $1 AND revoked_at IS NULL
		   AND COALESCE(user_id,    '00000000-0000-0000-0000-000000000000'::uuid)
		     = COALESCE($2::uuid,   '00000000-0000-0000-0000-000000000000'::uuid)
		   AND COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid)
		     = COALESCE($3::uuid,   '00000000-0000-0000-0000-000000000000'::uuid)`,
		inst, user, student).Scan(&serial, &secret)
	if err == nil {
		return serial, secret, nil
	}
	if err != pgx.ErrNoRows {
		return "", nil, err
	}

	serial, err = newPassSerial(prefix)
	if err != nil {
		return "", nil, err
	}
	secret = make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return "", nil, err
	}
	_, err = tx.Exec(r.Context(), `
		INSERT INTO campus_entry_passes (institution_id, user_id, student_id, serial, secret)
		VALUES ($1,$2,$3,$4,$5)`, inst, user, student, serial, secret)
	if err != nil {
		return "", nil, err
	}
	return serial, secret, nil
}

// passPayload is the card's live half, refreshed by the screen every window.
type passPayload struct {
	Serial    string `json:"serial"`
	Code      string `json:"code"`
	Scan      string `json:"scan"`
	ExpiresIn int    `json:"expires_in_seconds"`
}

func buildPassPayload(serial string, secret []byte) passPayload {
	win := passWindowNow()
	code := passCodeAt(secret, serial, win)
	elapsed := time.Now().Unix() - win*int64(passWindow.Seconds())
	return passPayload{
		Serial: serial, Code: code,
		// One string for the scanner to read, so the gate does not have to
		// parse two fields out of a camera frame.
		Scan:      serial + "." + code,
		ExpiresIn: int(int64(passWindow.Seconds()) - elapsed),
	}
}

/*
getStudentIDCard renders a child's card from records the school already keeps.

	Nothing about the card is copied into a table of its own. The name, the
	class, the photograph and the emergency telephone number are read live, so a
	child who changes section in July does not carry a card that says otherwise
	until somebody reissues it.

	Blood group and allergies are on the card because that is what an ID card is
	for at the moment it matters most. The rest of the health record is not:
	chronic conditions and medication are the school nurse's business and do not
	belong on a card a child leaves on a bus seat.
*/
func (s *Server) getStudentIDCard(w http.ResponseWriter, r *http.Request) {
	// A read, so it defaults to a child rather than refusing a parent of two
	// who has not yet chosen. See getFamilyIEP.
	studentID, ok := s.whichChild(w, r)
	if !ok {
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var card struct {
		StudentID   string  `json:"student_id"`
		Name        string  `json:"full_name"`
		AdmissionNo string  `json:"admission_no"`
		Class       *string `json:"class_name,omitempty"`
		Section     *string `json:"section_name,omitempty"`
		RollNo      *int    `json:"roll_no,omitempty"`
		DateOfBirth *string `json:"date_of_birth,omitempty"`
		BloodGroup  *string `json:"blood_group,omitempty"`
		Allergies   *string `json:"allergies,omitempty"`
		House       *string `json:"house,omitempty"`
		PhotoFileID *string `json:"photo_file_id,omitempty"`
		Guardian    *string `json:"guardian_name,omitempty"`
		GuardianTel *string `json:"guardian_phone,omitempty"`
		School      string  `json:"school_name"`
		Campus      *string `json:"campus_name,omitempty"`
		Status      string  `json:"status"`
	}
	var pass passPayload
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT st.id::text, concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.admission_no, c.name, sec.name, en.roll_no,
			       to_char(st.date_of_birth,'YYYY-MM-DD'), st.blood_group,
			       sh.allergies, h.name, st.photo_file_id::text,
			       g.full_name, g.phone, i.name, cam.name, st.status
			  FROM students st
			  JOIN institutions i ON i.id = st.institution_id
			  LEFT JOIN campuses cam ON cam.id = st.campus_id
			  LEFT JOIN houses h ON h.id = st.house_id
			  LEFT JOIN student_health sh ON sh.student_id = st.id
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id, e.roll_no FROM enrollments e
			       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
			  ) en ON true
			  LEFT JOIN classes c ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			  LEFT JOIN LATERAL (
			      SELECT gd.full_name, gd.phone FROM student_guardians sg
			        JOIN guardians gd ON gd.id = sg.guardian_id
			       WHERE sg.student_id = st.id
			       ORDER BY sg.is_primary DESC, sg.is_emergency DESC LIMIT 1
			  ) g ON true
			 WHERE st.id = $1`, studentID).
			Scan(&card.StudentID, &card.Name, &card.AdmissionNo, &card.Class,
				&card.Section, &card.RollNo, &card.DateOfBirth, &card.BloodGroup,
				&card.Allergies, &card.House, &card.PhotoFileID, &card.Guardian,
				&card.GuardianTel, &card.School, &card.Campus, &card.Status)
		if err != nil {
			return err
		}
		serial, secret, err := s.ensurePass(r, tx, id.InstitutionID, nil, &studentID, "ST")
		if err != nil {
			return err
		}
		pass = buildPassPayload(serial, secret)
		return nil
	})
	switch {
	case err == pgx.ErrNoRows:
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"card": card, "pass": pass})
	}
}

/*
getParentIDCard is the guardian's own card for the gate.

	It lists the children, because that is what the gate is actually checking:
	not that this person exists, but that they have business inside. A card with
	a name and no children on it tells the guard nothing they can act on.
*/
func (s *Server) getParentIDCard(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var card struct {
		UserID   string  `json:"user_id"`
		Name     string  `json:"full_name"`
		Phone    *string `json:"phone,omitempty"`
		Email    *string `json:"email,omitempty"`
		Relation *string `json:"relation,omitempty"`
		School   string  `json:"school_name"`
	}
	type childOnCard struct {
		StudentID string  `json:"student_id"`
		Name      string  `json:"full_name"`
		Class     *string `json:"class_name,omitempty"`
		Section   *string `json:"section_name,omitempty"`
	}
	children := []childOnCard{}
	var pass passPayload

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT u.id::text, u.full_name, u.phone, u.email::text,
			       (SELECT g.relation FROM guardians g WHERE g.user_id = u.id LIMIT 1),
			       i.name
			  FROM users u
			  JOIN institutions i ON i.id = u.institution_id
			 WHERE u.id = $1`, id.UserID).
			Scan(&card.UserID, &card.Name, &card.Phone, &card.Email,
				&card.Relation, &card.School)
		if err != nil {
			return err
		}
		if len(res.StudentIDs) > 0 {
			rows, err := tx.Query(r.Context(), `
				SELECT st.id::text, concat_ws(' ', st.first_name, st.last_name),
				       c.name, sec.name
				  FROM students st
				  LEFT JOIN LATERAL (
				      SELECT e.class_id, e.section_id FROM enrollments e
				       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
				  ) en ON true
				  LEFT JOIN classes c ON c.id = en.class_id
				  LEFT JOIN sections sec ON sec.id = en.section_id
				 WHERE st.id = ANY($1)
				 ORDER BY st.first_name`, res.StudentIDs)
			if err != nil {
				return err
			}
			for rows.Next() {
				var c childOnCard
				if err := rows.Scan(&c.StudentID, &c.Name, &c.Class, &c.Section); err != nil {
					rows.Close()
					return err
				}
				children = append(children, c)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}
		serial, secret, err := s.ensurePass(r, tx, id.InstitutionID, &id.UserID, nil, "PG")
		if err != nil {
			return err
		}
		pass = buildPassPayload(serial, secret)
		return nil
	})
	switch {
	case err == pgx.ErrNoRows:
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"card": card, "children": children, "pass": pass})
	}
}

/*
verifyCampusPass is the gate's scanner, and is staff only.

	The payload is "SERIAL.CODE" — the serial finds the row, the code proves the
	holder had the phone in the last few minutes. The comparison is
	constant-time: the codes are short and a gate is a place where an attacker
	can retry as often as they like, so leaking their prefix through timing is
	not a theoretical concern.

	Three windows are accepted. The gate tablet and the parent's phone are never
	quite agreed on the time, and refusing the parent who is thirty seconds off
	is how a school ends up propping the gate open.
*/
func (s *Server) verifyCampusPass(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(r.URL.Query().Get("code"))
	if raw == "" {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"valid": false, "reason": "no code presented"})
		return
	}
	serial, code, ok := strings.Cut(raw, ".")
	if !ok {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"valid": false, "reason": "unreadable pass"})
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var (
		secret []byte
		holder string
		kind   string
		detail *string
		found  bool
	)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT p.secret,
			       COALESCE(u.full_name,
			                concat_ws(' ', st.first_name, st.last_name)),
			       CASE WHEN p.user_id IS NOT NULL THEN 'guardian' ELSE 'student' END,
			       COALESCE(u.phone, st.admission_no)
			  FROM campus_entry_passes p
			  LEFT JOIN users u ON u.id = p.user_id
			  LEFT JOIN students st ON st.id = p.student_id
			 WHERE p.serial = $1 AND p.revoked_at IS NULL`, serial).
			Scan(&secret, &holder, &kind, &detail)
		if err == pgx.ErrNoRows {
			return nil
		}
		found = err == nil
		return err
	})
	if err != nil && err != pgx.ErrNoRows {
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.JSON(w, http.StatusOK, map[string]any{"valid": false, "reason": "no such pass"})
		return
	}

	now := passWindowNow()
	for _, win := range []int64{now, now - 1, now + 1} {
		want := passCodeAt(secret, serial, win)
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"valid": true, "holder": holder, "holder_kind": kind,
				"detail": detail, "serial": serial})
			return
		}
	}
	// The card is real; the code on it is stale or forged. Saying so is what
	// tells the guard to ask the parent to refresh their screen rather than
	// turning away somebody whose child is inside.
	httpx.JSON(w, http.StatusOK, map[string]any{
		"valid": false, "reason": "code has expired. Ask for a refreshed screen",
		"serial": serial})
}

// --- alerts ------------------------------------------------------------------

/*
notify writes one alert, once.

	The ON CONFLICT names the partial unique index from 00035 rather than a
	constraint, and repeats its COALESCE expressions exactly — Postgres matches
	an inference clause against the index expression, so an omitted COALESCE
	here would not merely be untidy, it would fail to match and the insert
	would raise instead of skipping.

	Every writer of a notification goes through this. A handler that inserted
	directly would be the one that delivered a duplicate.
*/
func notify(r *http.Request, tx pgx.Tx, inst, user uuid.UUID, student *uuid.UUID,
	kind, title, body, link, sourceKind string, sourceID *uuid.UUID) error {

	_, err := tx.Exec(r.Context(), `
		INSERT INTO notifications (institution_id, user_id, student_id, kind,
		                           title, body, link, source_kind, source_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (user_id, kind,
		             COALESCE(source_id,  '00000000-0000-0000-0000-000000000000'::uuid),
		             COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid))
		  WHERE source_kind IS NOT NULL
		DO NOTHING`,
		inst, user, student, kind, title, body, link, sourceKind, sourceID)
	return err
}

/*
deliverFamilyAlerts turns facts the school already recorded into the caller's feed.

	This is the honest version of "push". There is no vendor here and no device
	token: the SPA polls, and each poll materialises anything new into
	notifications, where it acquires a read mark and stays until the parent
	dismisses it. Wiring a real FCM or APNs sender later means reading rows this
	already writes, not rewriting the feature.

	Four sources, chosen to match what the catalogue promises — homework,
	circulars, fee dues and attendance — and each keyed on the id of the fact so
	the same circular is delivered exactly once however often the screen
	refreshes. /api/v1/attention already answers "what is outstanding" as a live
	panel; this is deliberately the other thing, a dated log of what happened,
	which is why an alert survives the fact that produced it being resolved.
*/
func (s *Server) deliverFamilyAlerts(r *http.Request, tx pgx.Tx, inst, user uuid.UUID,
	kids []uuid.UUID) error {

	// Circulars addressed to parents. Not narrowed by child: a notice to the
	// whole school is one alert, and one per child would deliver it three times
	// to a family of three.
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO notifications (institution_id, user_id, kind, title, body,
		                           link, source_kind, source_id)
		SELECT $1::uuid, $2::uuid, 'circular', a.title, left(a.body, 240),
		       '/portal/circulars', 'announcement', a.id
		  FROM announcements a
		 WHERE a.audience_role IN ('all','parents')
		   AND a.publish_at <= now()
		   AND a.publish_at > now() - interval '30 days'
		   AND (a.expires_at IS NULL OR a.expires_at > now())
		   AND (NOT EXISTS (SELECT 1 FROM announcement_sections s WHERE s.announcement_id = a.id)
		        OR EXISTS (SELECT 1 FROM announcement_sections s
		                     JOIN enrollments en ON en.section_id = s.section_id
		                    WHERE s.announcement_id = a.id AND en.student_id = ANY($3)))
		ON CONFLICT (user_id, kind,
		             COALESCE(source_id,  '00000000-0000-0000-0000-000000000000'::uuid),
		             COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid))
		  WHERE source_kind IS NOT NULL
		DO NOTHING`, inst, user, kids); err != nil {
		return err
	}

	// A day the child was marked absent. Only the last fortnight: an alert
	// about a Tuesday in July is not news, it is clutter, and the attendance
	// screen is where a term's record is read.
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO notifications (institution_id, user_id, student_id, kind,
		                           title, body, link, source_kind, source_id)
		SELECT $1::uuid, $2::uuid, sa.student_id, 'attendance',
		       concat_ws(' ', st.first_name, st.last_name) || ' was marked absent',
		       to_char(sa.on_date,'Day DD Mon'), '/portal/attendance',
		       'attendance', sa.id
		  FROM student_attendance sa
		  JOIN students st ON st.id = sa.student_id
		 WHERE sa.student_id = ANY($3) AND sa.status = 'absent'
		   AND sa.on_date > CURRENT_DATE - 14
		ON CONFLICT (user_id, kind,
		             COALESCE(source_id,  '00000000-0000-0000-0000-000000000000'::uuid),
		             COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid))
		  WHERE source_kind IS NOT NULL
		DO NOTHING`, inst, user, kids); err != nil {
		return err
	}

	// An invoice past its due date. Cancelled bills are excluded — a school
	// that withdrew a charge must not keep chasing it.
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO notifications (institution_id, user_id, student_id, kind,
		                           title, body, link, source_kind, source_id)
		SELECT $1::uuid, $2::uuid, inv.student_id, 'fee_due',
		       'Fees overdue: ' || inv.invoice_no,
		       to_char((inv.net_paise - inv.paid_paise) / 100.0, 'FM999999990.00')
		         || ' due since ' || to_char(inv.due_on,'DD Mon'),
		       '/portal/fees', 'invoice', inv.id
		  FROM invoices inv
		 WHERE inv.student_id = ANY($3)
		   AND inv.status <> 'cancelled'
		   AND inv.due_on IS NOT NULL AND inv.due_on < CURRENT_DATE
		   AND inv.net_paise > inv.paid_paise
		ON CONFLICT (user_id, kind,
		             COALESCE(source_id,  '00000000-0000-0000-0000-000000000000'::uuid),
		             COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid))
		  WHERE source_kind IS NOT NULL
		DO NOTHING`, inst, user, kids); err != nil {
		return err
	}

	// Homework due in the next week, for the child's own section.
	_, err := tx.Exec(r.Context(), `
		INSERT INTO notifications (institution_id, user_id, student_id, kind,
		                           title, body, link, source_kind, source_id)
		SELECT DISTINCT $1::uuid, $2::uuid, en.student_id, 'homework',
		       hw.title, 'Due ' || to_char(hw.due_on,'DD Mon'),
		       '/portal/homework', 'homework', hw.id
		  FROM homework hw
		  JOIN enrollments en ON en.section_id = hw.section_id
		 WHERE en.student_id = ANY($3) AND hw.is_published
		   AND hw.due_on IS NOT NULL
		   AND hw.due_on BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
		ON CONFLICT (user_id, kind,
		             COALESCE(source_id,  '00000000-0000-0000-0000-000000000000'::uuid),
		             COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid))
		  WHERE source_kind IS NOT NULL
		DO NOTHING`, inst, user, kids)
	return err
}

type notificationRow struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	Body      *string `json:"body,omitempty"`
	Link      *string `json:"link,omitempty"`
	StudentID *string `json:"student_id,omitempty"`
	Student   *string `json:"student_name,omitempty"`
	CreatedAt string  `json:"created_at"`
	ReadAt    *string `json:"read_at,omitempty"`
}

/*
Alerts that outlived the job they were about.

	A notification is written once and read later, and in between the reader's
	job can change. HR used to decide staff leave and no longer does, so every
	"X has applied for leave" already in their bell became an alert about
	somebody else's work — and following it lands on Approvals, which their
	workspace no longer has. They are told about a decision they cannot make and
	then shown a door that does not open.

	Deleting those rows was the obvious fix and the wrong one: it is destructive,
	it cannot be undone when somebody's duties are handed back, and it fixes only
	the case somebody thought to clean up. Filtering at read time costs one array
	comparison, needs no migration, and reverses itself the day the permission is
	granted again.

	Only kinds that call the reader to act belong here. A notification that is
	merely news — your leave was decided, your paper was approved — is not
	gated: it is about the reader, and it stays true whatever their duties
	become.
*/
var notificationNeeds = map[string]string{
	"leave_request": rbac.LeaveApprove,
}

func hiddenNotificationKinds(id *httpx.Identity) []string {
	var hidden []string
	for kind, perm := range notificationNeeds {
		if !id.Can(perm) {
			hidden = append(hidden, kind)
		}
	}
	return hidden
}

// listFamilyNotifications is the alert feed, newest first, with the delivery
// pass run first so a screen opened after a fortnight away is not empty.
func (s *Server) listFamilyNotifications(w http.ResponseWriter, r *http.Request) {
	res, kids, err := s.familyChildren(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}

	id := httpx.IdentityFrom(r.Context())
	items := []notificationRow{}
	var unread int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Only for a caller who has children. A librarian holding
		// self.profile.read reaches this route and must simply see nothing,
		// rather than have alerts manufactured for a family that is not theirs.
		if len(res.StudentIDs) > 0 {
			if err := s.deliverFamilyAlerts(r, tx, id.InstitutionID, id.UserID, res.StudentIDs); err != nil {
				return err
			}
		}
		/* A notification addressed to you is yours, child or no child.

		   The feed required every alert to carry either no student or one of
		   the caller's own children. That is right for a guardian — it is how
		   switching child filters the list — and it silently emptied the bell
		   for everybody else, because a member of staff has no children on the
		   roll and almost every alert names a pupil.

		   So a parent wrote to a teacher, the notification was written and
		   addressed to that teacher correctly, and this line threw it away
		   before the teacher ever saw it. Same for a remark reaching the child
		   it is about, and for anything else the school tells a member of
		   staff about a particular pupil.

		   The child filter now applies only to somebody who has children to
		   filter by. Everyone else gets what was sent to them. */
		// The feed narrows to the requested child when one was named, and
		// always keeps the alerts that belong to no particular child.
		rows, err := tx.Query(r.Context(), `
			SELECT n.id::text, n.kind, n.title, n.body, n.link,
			       n.student_id::text, concat_ws(' ', st.first_name, st.last_name),
			       to_char(n.created_at,'YYYY-MM-DD"T"HH24:MI'),
			       to_char(n.read_at,'YYYY-MM-DD"T"HH24:MI')
			  FROM notifications n
			  LEFT JOIN students st ON st.id = n.student_id
			 WHERE n.user_id = $1
			   /* Expressed in SQL rather than by swapping the predicate, so
			      the parameter list stays the same shape either way: a $2 the
			      statement no longer mentions is a bind error, not a filter. */
			   AND (cardinality($2::uuid[]) = 0
			        OR n.student_id IS NULL
			        OR n.student_id = ANY($2))
			   AND n.kind <> ALL($3)
			 ORDER BY n.created_at DESC
			 LIMIT 200`, id.UserID, kids, hiddenNotificationKinds(id))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v notificationRow
			var name *string
			if err := rows.Scan(&v.ID, &v.Kind, &v.Title, &v.Body, &v.Link,
				&v.StudentID, &name, &v.CreatedAt, &v.ReadAt); err != nil {
				return err
			}
			if v.StudentID != nil {
				v.Student = name
			}
			if v.ReadAt == nil {
				unread++
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "unread": unread})
}

// markNotificationRead dismisses one alert. The user_id predicate is in the
// UPDATE, so an id belonging to somebody else simply matches nothing.
func (s *Server) markNotificationRead(w http.ResponseWriter, r *http.Request) {
	noteID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid notification id")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var done bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE notifications SET read_at = now()
			 WHERE id = $1 AND user_id = $2 AND read_at IS NULL`, noteID, id.UserID)
		if err != nil {
			return err
		}
		done = tag.RowsAffected() == 1
		return nil
	})
	switch {
	case err != nil:
		httpx.Internal(w, r, err)
	case done:
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "read"})
	default:
		// Already read, or never theirs. The two are the same answer on
		// purpose: an id probe must not reveal that a row exists.
		httpx.NotFound(w, r)
	}
}

// markAllNotificationsRead clears the badge.
func (s *Server) markAllNotificationsRead(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE notifications SET read_at = now()
			 WHERE user_id = $1 AND read_at IS NULL`, id.UserID)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"cleared": n})
}

// --- canteen -----------------------------------------------------------------

type cafeteriaItem struct {
	Name       string  `json:"item_name"`
	Category   string  `json:"category"`
	Quantity   int     `json:"quantity"`
	UnitPaise  int64   `json:"unit_paise"`
	LinePaise  int64   `json:"line_paise"`
	Kcal       *int    `json:"kcal,omitempty"`
	Vegetarian *bool   `json:"is_vegetarian,omitempty"`
	Allergens  *string `json:"allergens,omitempty"`
}

type cafeteriaPurchase struct {
	ID          string          `json:"id"`
	StudentID   string          `json:"student_id"`
	Student     string          `json:"student_name"`
	PurchasedAt string          `json:"purchased_at"`
	Date        string          `json:"on_date"`
	Time        string          `json:"at_time"`
	Counter     *string         `json:"counter,omitempty"`
	TotalPaise  int64           `json:"total_paise"`
	Mode        string          `json:"mode"`
	Kcal        int             `json:"kcal"`
	Items       []cafeteriaItem `json:"items"`
}

type cafeteriaDay struct {
	Date       string `json:"on_date"`
	TotalPaise int64  `json:"total_paise"`
	Kcal       int    `json:"kcal"`
	Purchases  int    `json:"purchases"`
}

/*
listCafeteriaPurchases is the timeline of what a child bought and when.

	The timestamp is the feature. A daily total tells a parent their child spent
	ninety rupees; the timeline tells them it went on two fizzy drinks before
	half past eleven, which is the thing that gets acted on.

	Items are fetched in one pass over the receipt lines and stitched to their
	purchases in memory rather than through a query per receipt. A fortnight of
	a hungry twelve-year-old is a hundred or so receipts, and a hundred round
	trips is a screen that visibly hangs.

	Days are summed from the rows already loaded rather than by a second
	aggregate query, so the total under a day can never disagree with the lines
	printed above it.
*/
func (s *Server) listCafeteriaPurchases(w http.ResponseWriter, r *http.Request) {
	_, kids, err := s.familyChildren(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}
	from, to := familyDates(r, 30, 1)

	id := httpx.IdentityFrom(r.Context())
	purchases := []cafeteriaPurchase{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT p.id::text, p.student_id::text,
			       concat_ws(' ', st.first_name, st.last_name),
			       to_char(p.purchased_at,'YYYY-MM-DD"T"HH24:MI'),
			       to_char(p.purchased_at,'YYYY-MM-DD'),
			       to_char(p.purchased_at,'HH24:MI'),
			       p.counter, p.total_paise, p.mode
			  FROM cafeteria_purchases p
			  JOIN students st ON st.id = p.student_id
			 WHERE p.student_id = ANY($1)
			   AND p.purchased_at >= $2::date
			   AND p.purchased_at < ($3::date + 1)
			 ORDER BY p.purchased_at DESC
			 LIMIT 400`, kids, from, to)
		if err != nil {
			return err
		}
		index := map[string]int{}
		for rows.Next() {
			var v cafeteriaPurchase
			if err := rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.PurchasedAt,
				&v.Date, &v.Time, &v.Counter, &v.TotalPaise, &v.Mode); err != nil {
				rows.Close()
				return err
			}
			v.Items = []cafeteriaItem{}
			index[v.ID] = len(purchases)
			purchases = append(purchases, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(purchases) == 0 {
			return nil
		}

		ids := make([]string, 0, len(purchases))
		for _, p := range purchases {
			ids = append(ids, p.ID)
		}
		lines, err := tx.Query(r.Context(), `
			SELECT purchase_id::text, item_name, category, quantity,
			       unit_paise, line_paise, kcal, is_vegetarian, allergens
			  FROM cafeteria_purchase_items
			 WHERE purchase_id = ANY($1::uuid[])
			 ORDER BY item_name`, ids)
		if err != nil {
			return err
		}
		defer lines.Close()
		for lines.Next() {
			var pid string
			var it cafeteriaItem
			if err := lines.Scan(&pid, &it.Name, &it.Category, &it.Quantity,
				&it.UnitPaise, &it.LinePaise, &it.Kcal, &it.Vegetarian,
				&it.Allergens); err != nil {
				return err
			}
			at, ok := index[pid]
			if !ok {
				continue
			}
			if it.Kcal != nil {
				purchases[at].Kcal += *it.Kcal * it.Quantity
			}
			purchases[at].Items = append(purchases[at].Items, it)
		}
		return lines.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	days := []cafeteriaDay{}
	byDay := map[string]int{}
	var total int64
	var kcal int
	for _, p := range purchases {
		total += p.TotalPaise
		kcal += p.Kcal
		at, ok := byDay[p.Date]
		if !ok {
			byDay[p.Date] = len(days)
			days = append(days, cafeteriaDay{Date: p.Date})
			at = len(days) - 1
		}
		days[at].TotalPaise += p.TotalPaise
		days[at].Kcal += p.Kcal
		days[at].Purchases++
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": purchases, "days": days,
		"total_paise": total, "total_kcal": kcal,
		"from": from.Format(time.DateOnly), "to": to.Format(time.DateOnly),
	})
}
