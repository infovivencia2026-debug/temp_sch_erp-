package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Exam day.

   The module could schedule papers and record marks and had nothing in
   between: no halls, no seating, no hall ticket. A school running a summative
   still allocated desks on a whiteboard and typed tickets in Word, which is
   the one document a candidate cannot sit the paper without.

   Three things here. Halls, described as a grid rather than a capacity so an
   invigilator can call "row 3, seat 4". Allocation, which interleaves sections
   so neighbours are not classmates. And the ticket, which carries a
   verification code an invigilator can check at the door. */

// --- halls ---------------------------------------------------------------------

type hallRow struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Rows     int    `json:"rows"`
	Cols     int    `json:"cols"`
	Capacity int    `json:"capacity"`
	InUse    int    `json:"seats_allocated"`
}

func (s *Server) listExamHalls(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT h.id::text, h.name, h.rows_count, h.cols_count,
		       h.rows_count * h.cols_count,
		       (SELECT count(*) FROM exam_seats se WHERE se.hall_id = h.id)::int
		  FROM exam_halls h WHERE h.is_active ORDER BY h.name`, nil,
		func(rows pgx.Rows) (hallRow, error) {
			var v hallRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Rows, &v.Cols, &v.Capacity, &v.InUse)
		})
	respond(w, r, items, err)
}

type hallRequest struct {
	Name string `json:"name"`
	Rows int    `json:"rows"`
	Cols int    `json:"cols"`
}

func (s *Server) createExamHall(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req hallRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "the hall needs a name")
		return
	}
	if req.Rows <= 0 {
		req.Rows = 5
	}
	if req.Cols <= 0 {
		req.Cols = 6
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO exam_halls (institution_id, campus_id, name, rows_count, cols_count)
			VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
			id.InstitutionID, campus, req.Name, req.Rows, req.Cols).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.BadRequest(w, r, "a hall with that name already exists")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": newID, "name": req.Name, "capacity": req.Rows * req.Cols,
	})
}

// --- allocation ------------------------------------------------------------------

type allocateRequest struct {
	ExamID string `json:"exam_id"`
	// HallIDs in the order they should be filled. Empty means every active hall.
	HallIDs []string `json:"hall_ids,omitempty"`
	// Prefix for the ticket number: "SA2" gives SA2-0001. Defaults to the
	// exam's own initials.
	Prefix string `json:"ticket_prefix,omitempty"`
}

var errNoRoom = errors.New("not enough seats")

/*
allocateSeats places every candidate for an exam.

	Two rules, both learned from how invigilation actually fails.

	Candidates are interleaved by section rather than seated together, so the
	person to your left is not the person you sat next to all year. Ordering by
	admission number — the obvious implementation — seats a whole class in a
	block, which is the arrangement copying relies on.

	Re-running replaces the whole allocation rather than adding to it. A partial
	re-seat is worse than none: two children arrive at the same desk holding
	tickets that both look valid.
*/
func (s *Server) allocateSeats(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req allocateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	examID, err := uuid.Parse(req.ExamID)
	if err != nil {
		httpx.BadRequest(w, r, "exam_id must be a uuid")
		return
	}

	var placed, capacity, candidates int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var examName string
		if err := tx.QueryRow(r.Context(),
			`SELECT name FROM exams WHERE id = $1`, examID).Scan(&examName); err != nil {
			return err
		}
		prefix := strings.TrimSpace(req.Prefix)
		if prefix == "" {
			prefix = initials(examName)
		}

		// Halls, in fill order.
		var hallIDs []string
		if len(req.HallIDs) > 0 {
			hallIDs = req.HallIDs
		}
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, rows_count, cols_count
			  FROM exam_halls
			 WHERE is_active
			   AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
			 ORDER BY array_position($1::uuid[], id) NULLS LAST, name`,
			nullUUIDSlice(hallIDs))
		if err != nil {
			return err
		}
		type hall struct {
			id         string
			rows, cols int
		}
		var halls []hall
		for rows.Next() {
			var h hall
			if err := rows.Scan(&h.id, &h.rows, &h.cols); err != nil {
				rows.Close()
				return err
			}
			capacity += h.rows * h.cols
			halls = append(halls, h)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(halls) == 0 {
			return errors.New("no exam halls have been set up")
		}

		// Candidates: everyone enrolled in a class sitting this exam,
		// interleaved by section so neighbours are not classmates.
		crows, err := tx.Query(r.Context(), `
			SELECT st.id::text
			  FROM exam_subjects es
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN sections      sec ON sec.class_id = cs.class_id
			  JOIN enrollments     e ON e.section_id = sec.id AND e.status = 'active'
			  JOIN students       st ON st.id = e.student_id
			 WHERE es.exam_id = $1 AND st.status = 'active'
			 GROUP BY st.id, sec.id, st.admission_no
			 ORDER BY row_number() OVER (PARTITION BY sec.id ORDER BY st.admission_no),
			          sec.id`, examID)
		if err != nil {
			return err
		}
		var ids []string
		for crows.Next() {
			var sid string
			if err := crows.Scan(&sid); err != nil {
				crows.Close()
				return err
			}
			ids = append(ids, sid)
		}
		crows.Close()
		if err := crows.Err(); err != nil {
			return err
		}
		candidates = len(ids)
		if candidates == 0 {
			return errors.New("this exam has no candidates. Check its classes and papers")
		}
		if candidates > capacity {
			return errNoRoom
		}

		// Replace wholesale. See the note above.
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM exam_seats WHERE exam_id = $1`, examID); err != nil {
			return err
		}

		i := 0
		for _, h := range halls {
			for row := 1; row <= h.rows && i < len(ids); row++ {
				for col := 1; col <= h.cols && i < len(ids); col++ {
					ticket := prefix + "-" + pad4(i+1)
					if _, err := tx.Exec(r.Context(), `
						INSERT INTO exam_seats (institution_id, exam_id, student_id,
						                        hall_id, row_no, col_no, ticket_no)
						VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,$7)`,
						id.InstitutionID, examID, ids[i], h.id, row, col, ticket); err != nil {
						return err
					}
					i++
					placed++
				}
			}
		}
		return nil
	})
	if errors.Is(err, errNoRoom) {
		httpx.Error(w, r, http.StatusConflict, "no_room",
			"there are "+itoa(candidates)+" candidates and only "+itoa(capacity)+
				" seats. Add a hall, or allocate across more of them.")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"seated": placed, "capacity": capacity, "candidates": candidates,
	})
}

func nullUUIDSlice(v []string) any {
	if len(v) == 0 {
		return nil
	}
	return v
}

// initials builds a ticket prefix from an exam's name: "Summative
// Assessment 2" becomes SA2.
func initials(name string) string {
	var b strings.Builder
	for _, word := range strings.Fields(name) {
		r := []rune(word)[0]
		if (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			b.WriteRune([]rune(strings.ToUpper(word))[0])
		}
	}
	if b.Len() == 0 {
		return "EX"
	}
	return b.String()
}

func pad4(n int) string {
	s := itoa(n)
	for len(s) < 4 {
		s = "0" + s
	}
	return s
}

// --- the ticket --------------------------------------------------------------------

type hallTicket struct {
	TicketNo    string        `json:"ticket_no"`
	StudentName string        `json:"student_name"`
	AdmissionNo string        `json:"admission_no"`
	ClassName   string        `json:"class_name"`
	SectionName string        `json:"section_name"`
	ExamName    string        `json:"exam_name"`
	Board       *string       `json:"board,omitempty"`
	Hall        string        `json:"hall"`
	Seat        string        `json:"seat"`
	School      string        `json:"school"`
	Papers      []ticketPaper `json:"papers"`
	// Verify is what an invigilator scans. Derived, never stored: a code in a
	// column is a code somebody can edit.
	Verify string `json:"verification_code"`
	// Instructions are the ones a candidate is actually turned away for.
	Instructions []string `json:"instructions"`
}

type ticketPaper struct {
	Subject  string  `json:"subject"`
	Date     *string `json:"date,omitempty"`
	StartsAt *string `json:"starts_at,omitempty"`
	Minutes  *int    `json:"duration_minutes,omitempty"`
	MaxMarks *int    `json:"max_marks,omitempty"`
}

// verificationCode is what an invigilator checks at the door. Domain-separated
// through auth.Sign so a ticket code shares no key material with a password.
func (s *Server) verificationCode(examID, studentID uuid.UUID, ticket string) string {
	return s.Hasher.Sign("exam-hall-ticket",
		examID.String()+"|"+studentID.String()+"|"+ticket)
}

// getHallTicket returns one candidate's ticket. Scope-checked like the
// holistic card: a family gets their own child, a teacher a child they teach,
// the office anyone.
func (s *Server) getHallTicket(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	studentID, ok := s.hpcStudent(w, r)
	if !ok {
		return
	}
	examID, err := uuid.Parse(r.URL.Query().Get("exam_id"))
	if err != nil {
		httpx.BadRequest(w, r, "exam_id must be a uuid")
		return
	}

	var t hallTicket
	t.Papers = []ticketPaper{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var row, col int
		if err := tx.QueryRow(r.Context(), `
			SELECT se.ticket_no, h.name, se.row_no, se.col_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.admission_no, COALESCE(c.name,''), COALESCE(sec.name,''),
			       ex.name, ex.board, i.name
			  FROM exam_seats se
			  JOIN exam_halls h  ON h.id = se.hall_id
			  JOIN students   st ON st.id = se.student_id
			  JOIN exams      ex ON ex.id = se.exam_id
			  JOIN institutions i ON i.id = se.institution_id
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id FROM enrollments e
			       WHERE e.student_id = st.id AND e.status='active'
			       ORDER BY e.enrolled_on DESC LIMIT 1) en ON true
			  LEFT JOIN classes  c   ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE se.exam_id = $1 AND se.student_id = $2`, examID, studentID).
			Scan(&t.TicketNo, &t.Hall, &row, &col, &t.StudentName, &t.AdmissionNo,
				&t.ClassName, &t.SectionName, &t.ExamName, &t.Board, &t.School); err != nil {
			return err
		}
		t.Seat = "Row " + itoa(row) + ", Seat " + itoa(col)

		rows, err := tx.Query(r.Context(), `
			SELECT sub.name, to_char(es.exam_date,'YYYY-MM-DD'),
			       to_char(es.starts_at,'HH24:MI'), es.duration_minutes, es.max_marks
			  FROM exam_subjects es
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN subjects      sub ON sub.id = cs.subject_id
			  JOIN enrollments     e ON e.class_id = cs.class_id
			                        AND e.student_id = $2 AND e.status='active'
			 WHERE es.exam_id = $1
			 ORDER BY es.exam_date NULLS LAST, es.starts_at NULLS LAST, sub.name`,
			examID, studentID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var p ticketPaper
			if err := rows.Scan(&p.Subject, &p.Date, &p.StartsAt, &p.Minutes,
				&p.MaxMarks); err != nil {
				return err
			}
			t.Papers = append(t.Papers, p)
		}
		return rows.Err()
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "not_seated",
			"no seat has been allocated for this exam yet. The school issues "+
				"tickets once seating is done.")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	t.Verify = s.verificationCode(examID, studentID, t.TicketNo)
	t.Instructions = []string{
		"Bring this ticket to every paper. You will not be admitted without it.",
		"Be seated fifteen minutes before the paper starts.",
		"No mobile phone, smart watch or written material in the hall.",
		"Carry your own pens, pencils and instruments; nothing may be shared.",
	}
	httpx.JSON(w, http.StatusOK, t)
}

// getHallPlan is the invigilator's sheet: who is in this hall, where.
func (s *Server) getHallPlan(w http.ResponseWriter, r *http.Request) {
	type seat struct {
		Ticket      string `json:"ticket_no"`
		StudentName string `json:"student_name"`
		AdmissionNo string `json:"admission_no"`
		ClassName   string `json:"class_name"`
		Hall        string `json:"hall"`
		Row         int    `json:"row"`
		Col         int    `json:"col"`
	}
	items, err := collect(s, r, `
		SELECT se.ticket_no,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       COALESCE(c.name,''), h.name, se.row_no, se.col_no
		  FROM exam_seats se
		  JOIN exam_halls h ON h.id = se.hall_id
		  JOIN students  st ON st.id = se.student_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.status='active' LIMIT 1) en ON true
		  LEFT JOIN classes c ON c.id = en.class_id
		 WHERE se.exam_id = $1::uuid
		   AND ($2::uuid IS NULL OR se.hall_id = $2::uuid)
		 ORDER BY h.name, se.row_no, se.col_no`,
		[]any{nullString(r.URL.Query().Get("exam_id")),
			nullString(r.URL.Query().Get("hall_id"))},
		func(rows pgx.Rows) (seat, error) {
			var v seat
			return v, rows.Scan(&v.Ticket, &v.StudentName, &v.AdmissionNo,
				&v.ClassName, &v.Hall, &v.Row, &v.Col)
		})
	respond(w, r, items, err)
}
