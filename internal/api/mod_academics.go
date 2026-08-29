package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/queue"
	"github.com/school-erp/erp/internal/rbac"
)

/* Modules 3-5 — attendance corrections and alerts, examinations and report
   cards, and the student lifecycle through to transfer certificate. */

// --------------------------------------------------------------- attendance

type correctionRequest struct {
	AttendanceID string `json:"attendance_id"`
	ToStatus     string `json:"to_status"`
	Reason       string `json:"reason"`
}

// requestCorrection asks for an attendance mark to be amended.
//
// Teachers cannot silently rewrite a register: the original status is captured
// as from_status and an approver decides. Attendance drives exam eligibility,
// so an unaudited edit is a way to make a short student eligible.
func (s *Server) requestCorrection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req correctionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	attID, err := uuid.Parse(req.AttendanceID)
	if err != nil {
		httpx.BadRequest(w, r, "attendance_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "reason is required")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var fromStatus string
		var sectionID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT status, section_id FROM student_attendance WHERE id = $1`, attID).
			Scan(&fromStatus, &sectionID); err != nil {
			return err
		}
		// The requester must teach the section, same rule as marking it.
		if !res.CanMarkSection(sectionID) {
			return errForbiddenSection
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO attendance_corrections (institution_id, attendance_id, requested_by,
			                                    from_status, to_status, reason, status)
			VALUES ($1,$2,$3,$4,$5,$6,'pending')
			RETURNING id::text`,
			id.InstitutionID, attID, id.UserID, fromStatus, req.ToStatus, req.Reason).Scan(&newID)
	})
	if errors.Is(err, errForbiddenSection) {
		httpx.Forbidden(w, r, "attendance correction for this section")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "status": "pending"})
}

var errForbiddenSection = errors.New("section outside caller's scope")

type decideCorrectionRequest struct {
	Decision string `json:"decision"` // approved | rejected
	Note     string `json:"note,omitempty"`
}

// decideCorrection approves or rejects an amendment, applying it on approval.
func (s *Server) decideCorrection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	cid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid correction id")
		return
	}
	var req decideCorrectionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Decision != "approved" && req.Decision != "rejected" {
		httpx.BadRequest(w, r, "decision must be approved or rejected")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var attID uuid.UUID
		var toStatus string
		if err := tx.QueryRow(r.Context(), `
			UPDATE attendance_corrections
			   SET status = $2, decided_by = $3, decided_at = now()
			 WHERE id = $1 AND status = 'pending'
			 RETURNING attendance_id, to_status`, cid, req.Decision, id.UserID).
			Scan(&attID, &toStatus); err != nil {
			return err
		}
		if req.Decision == "approved" {
			// The register keeps the previous value in corrected_from, so the
			// audit trail survives on the row itself as well as in the
			// correction record.
			if _, err := tx.Exec(r.Context(), `
				UPDATE student_attendance
				   SET corrected_from = status, status = $2,
				       corrected_by = $3, corrected_at = now()
				 WHERE id = $1`, attID, toStatus, id.UserID); err != nil {
				return err
			}
		}

		/* And tell whoever asked.

		   She raised it because a mark was wrong and then heard nothing either
		   way, so an approval looked exactly like a request nobody had read —
		   she checks the screen again, or asks in the corridor, or marks it a
		   second time, which is what the approval exists to prevent.

		   A rejection matters more than an approval here: the register still
		   says the thing she believes is wrong, and she is the only person who
		   can raise it again with a better reason. */
		var asked *uuid.UUID
		var child string
		var onDate string
		if err := tx.QueryRow(r.Context(), `
			SELECT ac.requested_by,
			       trim(st.first_name || ' ' || COALESCE(st.last_name,'')),
			       to_char(sa.on_date, 'YYYY-MM-DD')
			  FROM attendance_corrections ac
			  JOIN student_attendance sa ON sa.id = ac.attendance_id
			  JOIN students st ON st.id = sa.student_id
			 WHERE ac.id = $1`, cid).Scan(&asked, &child, &onDate); err != nil {
			return err
		}
		// Not to somebody deciding their own request: a head of department who
		// raises one and approves it does not need telling twice.
		if asked == nil || *asked == id.UserID {
			return nil
		}
		verb := "approved"
		body := "The register for " + onDate + " has been amended."
		if req.Decision != "approved" {
			verb = "not approved"
			body = "The mark for " + onDate + " stands as it was. " +
				"Raise it again if it is still wrong."
		}
		return notify(r, tx, id.InstitutionID, *asked, nil, "correction_decided",
			"Your correction for "+child+" was "+verb, body,
			"/go/attendance_correction", "attendance_correction", &cid)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "not_found", "no pending correction with that id")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": cid.String(), "status": req.Decision})
}

type correctionRow struct {
	ID          string  `json:"id"`
	StudentName string  `json:"student_name"`
	OnDate      string  `json:"on_date"`
	FromStatus  string  `json:"from_status"`
	ToStatus    string  `json:"to_status"`
	Reason      string  `json:"reason"`
	RequestedBy *string `json:"requested_by,omitempty"`
	Status      string  `json:"status"`
}

func (s *Server) listCorrections(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT ac.id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       to_char(sa.on_date,'YYYY-MM-DD'),
		       ac.from_status, ac.to_status, ac.reason, u.full_name, ac.status
		  FROM attendance_corrections ac
		  JOIN student_attendance sa ON sa.id = ac.attendance_id
		  JOIN students st ON st.id = sa.student_id
		  LEFT JOIN users u ON u.id = ac.requested_by
		 WHERE ($1::text IS NULL OR ac.status = $1)
		 ORDER BY ac.created_at DESC LIMIT 200`,
		[]any{nullString(r.URL.Query().Get("status"))},
		func(rows pgx.Rows) (correctionRow, error) {
			var v correctionRow
			return v, rows.Scan(&v.ID, &v.StudentName, &v.OnDate, &v.FromStatus,
				&v.ToStatus, &v.Reason, &v.RequestedBy, &v.Status)
		})
	respond(w, r, items, err)
}

// sendAbsenceAlerts queues one message per absent student's guardian.
//
// Fan-out through the queue rather than inline: a whole-school absence run is
// a few hundred messages, and one task per message means a gateway failure
// retries that message alone instead of losing the batch.
func (s *Server) sendAbsenceAlerts(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	onDate := r.URL.Query().Get("on_date")

	type target struct {
		guardianUser uuid.UUID
		student      string
	}
	var targets []target

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT g.user_id, concat_ws(' ', st.first_name, st.last_name)
			  FROM student_attendance sa
			  JOIN students st ON st.id = sa.student_id
			  JOIN student_guardians sg ON sg.student_id = st.id AND sg.is_primary
			  JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sa.on_date = COALESCE($1::date, CURRENT_DATE)
			   AND sa.status = 'absent'
			   AND g.user_id IS NOT NULL`, nullString(onDate))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var t target
			if err := rows.Scan(&t.guardianUser, &t.student); err != nil {
				return err
			}
			targets = append(targets, t)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	queued := 0
	for _, t := range targets {
		if _, err := s.Queue.Enqueue(r.Context(), queue.TypeMessageSend,
			queue.MessageSendPayload{
				Envelope: queue.Envelope{
					InstitutionID: id.InstitutionID, ActorUserID: id.UserID,
					RequestID: httpx.RequestIDFrom(r.Context()), JobID: uuid.New(),
				},
				Channel: "sms", TemplateKey: "attendance.absent",
				ToUserID: t.guardianUser,
				Vars:     map[string]any{"student": t.student, "date": onDate},
			}, queue.CriticalOptions()...); err != nil {
			httpx.Internal(w, r, err)
			return
		}
		queued++
	}
	httpx.JSON(w, http.StatusAccepted, map[string]any{
		"absent_students": len(targets), "messages_queued": queued,
	})
}

// --------------------------------------------------------------- examinations

type marksEntryRequest struct {
	ExamSubjectID string `json:"exam_subject_id"`
	Entries       []struct {
		StudentID string   `json:"student_id"`
		Marks     *float64 `json:"marks_obtained"`
		IsAbsent  bool     `json:"is_absent"`
		Remarks   string   `json:"remarks,omitempty"`
	} `json:"entries"`
}

// enterMarks records marks for a whole class in one transaction, computing the
// grade from the exam's grading scale.
//
// studentIDsOf collects the ids being marked, so the authorisation check can ask
// about the sections those particular children sit in rather than about the
// paper's class as a whole.
func studentIDsOf(req marksEntryRequest) []string {
	out := make([]string, 0, len(req.Entries))
	for _, e := range req.Entries {
		out = append(out, e.StudentID)
	}
	return out
}

// Marks above the paper's maximum are rejected outright rather than clamped: a
// typo of 950 for 95 must not silently become a pass.
func (s *Server) enterMarks(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req marksEntryRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	esID, err := uuid.Parse(req.ExamSubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "exam_subject_id must be a uuid")
		return
	}
	if len(req.Entries) == 0 {
		httpx.BadRequest(w, r, "entries must not be empty")
		return
	}

	/* Who may write on this paper.

	   There was no check at all. The route asked for academics.marks.write and
	   nothing else, so any teacher holding it could enter marks for any paper
	   in the school — a Grade 6 Telugu teacher could have written the Grade 8
	   Mathematics sheet, and nothing in the product would have noticed or
	   recorded it.

	   Two people legitimately write here, and they are different people:

	     the subject teacher, for the paper they teach, in the sections they
	     are allocated to;
	     the class teacher, for any subject of their own section, because they
	     are the one who answers for the whole child and has to be able to fix
	     a gap the subject teacher left.

	   Anybody else is refused. Checked against the section each student is
	   actually enrolled in rather than against the paper's class, because a
	   paper belongs to a class and a class has several sections — a teacher
	   allocated to 6-A must not be able to write 6-B's marks. */
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !res.AnySection && !res.PlatformAdmin {
		var mayWrite bool
		if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT EXISTS (
				  -- the subject teacher of this paper, in a section holding
				  -- one of the students being marked
				  SELECT 1
				    FROM exam_subjects es
				    JOIN section_subject_teachers t
				      ON t.class_subject_id = es.class_subject_id
				     AND t.teacher_user_id  = $2
				    JOIN enrollments en
				      ON en.section_id = t.section_id
				     AND en.status = 'active'
				     AND en.student_id = ANY($3::uuid[])
				   WHERE es.id = $1
				) OR EXISTS (
				  -- or the class teacher of a section holding one of them
				  SELECT 1
				    FROM enrollments en
				    JOIN sections sec ON sec.id = en.section_id
				   WHERE en.status = 'active'
				     AND en.student_id = ANY($3::uuid[])
				     AND sec.class_teacher_id = $2
				)`, esID, id.UserID, studentIDsOf(req)).Scan(&mayWrite)
		}); err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if !mayWrite {
			httpx.Forbidden(w, r,
				"academics.marks.write for this paper. You are neither its subject teacher nor the class teacher of these students")
			return
		}
	}

	written := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var maxMarks float64
		var subject string
		var scaleID *uuid.UUID
		// The subject name comes back with the ceiling so a rejection can name
		// the paper: "50 is above the maximum for Mathematics" is actionable,
		// "marks out of range" is not.
		if err := tx.QueryRow(r.Context(), `
			SELECT es.max_marks, COALESCE(sub.name, ''), e.grading_scale_id
			  FROM exam_subjects es
			  JOIN exams e            ON e.id = es.exam_id
			  LEFT JOIN class_subjects cs ON cs.id = es.class_subject_id
			  LEFT JOIN subjects sub  ON sub.id = cs.subject_id
			 WHERE es.id = $1`, esID).Scan(&maxMarks, &subject, &scaleID); err != nil {
			return err
		}

		for _, e := range req.Entries {
			if verr := validateMark(subject, maxMarks, e.Marks); verr != nil {
				return verr
			}
			sid, err := uuid.Parse(e.StudentID)
			if err != nil {
				return err
			}

			// Grade is derived here, not stored by the client: the band table is
			// the authority and a client-supplied grade could contradict it.
			var grade *string
			if e.Marks != nil && !e.IsAbsent && scaleID != nil && maxMarks > 0 {
				pct := *e.Marks / maxMarks * 100
				var g string
				err := tx.QueryRow(r.Context(), `
					SELECT grade FROM grade_bands
					 WHERE grading_scale_id = $1 AND $2 BETWEEN min_percent AND max_percent
					 LIMIT 1`, *scaleID, pct).Scan(&g)
				if err == nil {
					grade = &g
				} else if !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO marks (institution_id, exam_subject_id, student_id,
				                   marks_obtained, grade, is_absent, remarks, entered_by, entered_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
				ON CONFLICT (exam_subject_id, student_id) DO UPDATE
				   SET marks_obtained = EXCLUDED.marks_obtained,
				       grade          = EXCLUDED.grade,
				       is_absent      = EXCLUDED.is_absent,
				       remarks        = EXCLUDED.remarks,
				       entered_by     = EXCLUDED.entered_by,
				       entered_at     = now()`,
				id.InstitutionID, esID, sid, e.Marks, grade, e.IsAbsent,
				nullString(e.Remarks), id.UserID); err != nil {
				return err
			}
			written++
		}
		return nil
	})
	var ceiling *markCeilingError
	if errors.As(err, &ceiling) {
		httpx.BadRequest(w, r, ceiling.Error())
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"written": written})
}

type gradebookRow struct {
	StudentID   string   `json:"student_id"`
	AdmissionNo string   `json:"admission_no"`
	FullName    string   `json:"full_name"`
	Marks       *float64 `json:"marks_obtained,omitempty"`
	MaxMarks    float64  `json:"max_marks"`
	Grade       *string  `json:"grade,omitempty"`
	IsAbsent    bool     `json:"is_absent"`
	// Which section the child sits in. Shown on the row so a mixed-class sheet
	// still says whose child each line is.
	Section string `json:"section"`
}

// getGradebook returns the roster for a paper with any marks already entered,
// so the teacher edits a list rather than typing names.
func (s *Server) getGradebook(w http.ResponseWriter, r *http.Request) {
	esID := r.URL.Query().Get("exam_subject_id")
	if esID == "" {
		httpx.BadRequest(w, r, "exam_subject_id is required")
		return
	}
	/* A paper belongs to a class; a teacher stands in front of a section.

	   A paper is set per class-subject, so the roster for one is every child in
	   Grade 6 — 6-A, 6-B and 6-C in one list, ordered by admission number, which
	   interleaves the three. The teacher who taught 6-B then types their marks
	   down a sheet two thirds of which is somebody else's, and a mark landing on
	   the wrong row is the error nobody catches until a report card prints.

	   Optional, and empty means the whole class: the exam cell checking whether a
	   paper is fully entered wants all of Grade 6 in one view, and a school with
	   one section per class never has to touch the filter. */
	sectionID := strings.TrimSpace(r.URL.Query().Get("section_id"))
	if sectionID != "" {
		if _, err := uuid.Parse(sectionID); err != nil {
			httpx.BadRequest(w, r, "section_id must be a uuid")
			return
		}
	}
	items, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       m.marks_obtained, es.max_marks, m.grade, COALESCE(m.is_absent, false),
		       COALESCE(sec.name, '')
		  FROM exam_subjects es
		  JOIN class_subjects cs ON cs.id = es.class_subject_id
		  JOIN enrollments e     ON e.class_id = cs.class_id AND e.status = 'active'
		  JOIN students st       ON st.id = e.student_id
		  LEFT JOIN sections sec ON sec.id = e.section_id
		  LEFT JOIN marks m      ON m.exam_subject_id = es.id AND m.student_id = st.id
		 WHERE es.id = $1::uuid
		   AND ($2 = '' OR e.section_id = $2::uuid)
		 ORDER BY sec.name, st.admission_no`, []any{esID, sectionID},
		func(rows pgx.Rows) (gradebookRow, error) {
			var v gradebookRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.FullName,
				&v.Marks, &v.MaxMarks, &v.Grade, &v.IsAbsent, &v.Section)
		})
	respond(w, r, items, err)
}

type generateReportCardsRequest struct {
	ExamID    string `json:"exam_id"`
	SectionID string `json:"section_id"`
	Publish   bool   `json:"publish"`
}

var (
	// Generate wrote nothing, and the three reasons a person can act on.
	errExamHasNoPapers = errors.New("exam has no papers")
	errSectionEmpty    = errors.New("section has no students")
	errNothingToCard   = errors.New("nothing to card")
)

// generateReportCards computes totals, percentage, grade and rank for a
// section and writes a report card per student.
//
// Rank is computed across the section in one pass rather than per student:
// ranking each child independently is O(n²) and, worse, produces inconsistent
// ties when two rows are computed at different moments.
func (s *Server) generateReportCards(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req generateReportCardsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	examID, err := uuid.Parse(req.ExamID)
	if err != nil {
		httpx.BadRequest(w, r, "exam_id must be a uuid")
		return
	}
	sectionID, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}

	/* Building the cards and releasing them are different jobs.

	   Generate-and-publish in one press is the head's shortcut, not the class
	   teacher's: a teacher who may generate sends the set up for approval and
	   somebody else decides it may leave the building. Without this the whole
	   approval workflow is one checkbox away from being skipped. */
	if req.Publish && !id.Can(rbac.ReportCardsPublish) {
		httpx.Forbidden(w, r,
			"you can build these cards but not release them — generate, then send "+
				"them for approval")
		return
	}

	/* The report card belongs to the class teacher.

	   This had no scope check either: anybody holding
	   academics.reportcards.generate could build and publish cards for any
	   section in the school, including sections they have never taught. A
	   report card is the document a family keeps, and the person who stands
	   behind it is the one who answers for the whole child. */
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !res.IsClassTeacherOf(sectionID) {
		httpx.Forbidden(w, r,
			"academics.reportcards.generate for this section. Report cards are built by its class teacher")
		return
	}

	created := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			WITH totals AS (
			  SELECT e.student_id, e.id AS enrollment_id, e.academic_year_id,
			         SUM(COALESCE(m.marks_obtained,0))            AS total,
			         SUM(es.max_marks)                            AS max_total,
			         -- Attendance is printed on the card and is what parents
			         -- check first, so it is computed here rather than left blank.
			         COALESCE((SELECT round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late'))
			                                / NULLIF(count(*),0))
			                     FROM student_attendance sa
			                    WHERE sa.student_id = e.student_id), 0) AS attendance
			    FROM enrollments e
			    -- Only the papers this child's class actually sat.
			    --
			    -- This join used to be es.exam_id = $1 alone, with nothing
			    -- correlating the paper to the enrolment: every enrolled child
			    -- was crossed with every paper in the exam, school-wide. So
			    -- max_total was the sum of every class's maxima and total was
			    -- whatever of them this child happened to have marks for —
			    -- which for a section whose class is not in the exam is
			    -- nothing. That is the 0/400, 0%, D2-for-everyone report card:
			    -- the denominator came from other classes' papers and the
			    -- numerator from none. The class filter is the same one the
			    -- report-card listing already applies to the subject breakdown.
			    JOIN class_subjects cs ON cs.class_id = e.class_id
			    JOIN exam_subjects es  ON es.exam_id = $1
			                          AND es.class_subject_id = cs.id
			    LEFT JOIN marks m ON m.exam_subject_id = es.id AND m.student_id = e.student_id
			   WHERE e.section_id = $2 AND e.status = 'active'
			   GROUP BY e.student_id, e.id, e.academic_year_id
			),
			ranked AS (
			  SELECT *, round(100.0 * total / NULLIF(max_total,0), 2) AS pct,
			         rank() OVER (ORDER BY total DESC)::int AS rnk
			    FROM totals
			)
			INSERT INTO report_cards (institution_id, student_id, academic_year_id, enrollment_id,
			                          total_marks, max_marks, percentage, grade,
			                          rank_in_section, attendance_percent, is_published, published_at,
			                          status)
			SELECT $3, r.student_id, r.academic_year_id, r.enrollment_id,
			       r.total, r.max_total, r.pct,
			       (SELECT gb.grade FROM grade_bands gb
			         WHERE gb.grading_scale_id = (SELECT grading_scale_id FROM exams WHERE id = $1)
			           AND r.pct BETWEEN gb.min_percent AND gb.max_percent LIMIT 1),
			       r.rnk, r.attendance, $4,
			       CASE WHEN $4 THEN now() ELSE NULL END,
			       -- status and is_published are one fact with two spellings and a
			       -- constraint that says so; writing one without the other fails.
			       CASE WHEN $4 THEN 'published' ELSE 'draft' END
			  FROM ranked r
			-- term_id is NULL for an annual card, and NULLs do not conflict, so
			-- the target must be the partial index that excludes it.
			ON CONFLICT (student_id, academic_year_id) WHERE term_id IS NULL DO UPDATE
			   SET total_marks = EXCLUDED.total_marks,
			       max_marks   = EXCLUDED.max_marks,
			       percentage  = EXCLUDED.percentage,
			       grade       = EXCLUDED.grade,
			       rank_in_section = EXCLUDED.rank_in_section,
			       attendance_percent = EXCLUDED.attendance_percent,
			       /* Regenerating refreshes the marks; it does not withdraw a card
			          a family has already read. Plain assignment sent a published
			          card back to draft the moment a subject teacher fixed one mark
			          and the class teacher pressed Generate — the parent's copy
			          vanished with nobody told. */
			       is_published = report_cards.is_published OR EXCLUDED.is_published,
			       status = CASE WHEN EXCLUDED.is_published THEN 'published'
			                     ELSE report_cards.status END,
			       published_at = COALESCE(report_cards.published_at, EXCLUDED.published_at)`,
			examID, sectionID, id.InstitutionID, req.Publish)
		if err != nil {
			return err
		}
		created = int(tag.RowsAffected())

		/* Nothing written is a failure, and it used to answer 200.

		   Pressing Generate and being told nothing at all is the worst
		   possible outcome: no card appears, no error appears, and the person
		   cannot tell whether the button is broken, the marks are missing or
		   they chose the wrong section. The two real causes are knowable here,
		   so they are said. */
		if created == 0 {
			var papers, students int
			if err := tx.QueryRow(r.Context(), `
				SELECT (SELECT count(*)::int FROM exam_subjects WHERE exam_id = $1),
				       (SELECT count(*)::int FROM enrollments
				         WHERE section_id = $2 AND status = 'active')`,
				examID, sectionID).Scan(&papers, &students); err != nil {
				return err
			}
			switch {
			case papers == 0:
				return errExamHasNoPapers
			case students == 0:
				return errSectionEmpty
			default:
				return errNothingToCard
			}
		}

		if !req.Publish {
			return nil
		}

		/* Publishing is the moment the school stands behind the card, so it
		   is the moment the family is told.

		   Generating without publishing is silent on purpose: a class teacher
		   regenerates a section several times while marks are still arriving,
		   and an alert on each pass would train the family to ignore the one
		   that matters.

		   Each child's own card and nobody else's. The alert carries a
		   student_id and the endpoint behind the link narrows on the
		   caller's children, so a family of three gets three alerts and each
		   opens one card. */
		return s.notifyReportCardPublished(r, tx, id.InstitutionID, sectionID)
	})
	switch {
	case errors.Is(err, errExamHasNoPapers):
		httpx.BadRequest(w, r,
			"that exam has no papers, so there is nothing to build a card from. Add its subjects on the exam, then generate.")
		return
	case errors.Is(err, errSectionEmpty):
		httpx.BadRequest(w, r, "no active students are enrolled in that section.")
		return
	case errors.Is(err, errNothingToCard):
		httpx.BadRequest(w, r,
			"no cards were written. Check that this exam covers the class this section belongs to.")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"report_cards": created, "published": req.Publish,
	})
}

// notifyReportCardPublished tells each family, and each student with a login,
// that their card is ready.
func (s *Server) notifyReportCardPublished(r *http.Request, tx pgx.Tx,
	inst, sectionID uuid.UUID) error {

	rows, err := tx.Query(r.Context(), `
		SELECT DISTINCT recipient, st.id,
		       trim(st.first_name || ' ' || COALESCE(st.last_name,''))
		  FROM enrollments e
		  JOIN students st ON st.id = e.student_id
		  CROSS JOIN LATERAL (
		        SELECT g.user_id AS recipient
		          FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id AND g.user_id IS NOT NULL
		        UNION
		        SELECT st.user_id WHERE st.user_id IS NOT NULL
		  ) AS who
		 WHERE e.section_id = $1 AND e.status = 'active'`, sectionID)
	if err != nil {
		return err
	}
	type target struct {
		user, student uuid.UUID
		name          string
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.user, &t.student, &t.name); err != nil {
			rows.Close()
			return err
		}
		targets = append(targets, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	id := httpx.IdentityFrom(r.Context())
	for _, t := range targets {
		student := t.student
		if err := notify(r, tx, inst, t.user, &student, "report_card",
			t.name+"’s report card is ready",
			"The school has published it. Open it to see the marks, the grade and the attendance.",
			"/go/report_cards", "report_card", &student); err != nil {
			return err
		}

		/* And out of the building.

		   The notification alone meant a family learned their child's results
		   on the day they next happened to open the app. A published report
		   card is the one thing in a term a parent is actually waiting for.

		   Email rather than SMS: results are read, not glanced at, and a
		   school that texts sixty families every time a card is published
		   pays for sixty texts to say "sign in".

		   Enqueued, not sent here: the queue owns retries, and a mail server
		   that is briefly down must not fail the publish. A failure to hand it
		   over is logged and swallowed for the same reason — the card is
		   published either way. */
		if s.Queue != nil {
			if _, err := s.Queue.Enqueue(r.Context(), queue.TypeMessageSend,
				queue.MessageSendPayload{
					Envelope: queue.Envelope{
						InstitutionID: inst, ActorUserID: id.UserID,
						RequestID: httpx.RequestIDFrom(r.Context()), JobID: uuid.New(),
					},
					Channel: "email", TemplateKey: "reportcard.published",
					ToUserID: t.user,
					Vars: map[string]any{
						"student_name": t.name,
						"exam_name":    "the latest",
					},
				}, queue.HeavyOptions()...); err != nil {
				httpx.LogError(r, err)
			}
		}
	}
	return nil
}

type reportReadinessRow struct {
	Subject  string  `json:"subject"`
	Teacher  *string `json:"teacher,omitempty"`
	Entered  int     `json:"marks_entered"`
	Expected int     `json:"students"`
}

/*
getReportCardReadiness answers "can I publish yet".

	A report card is only true once every subject teacher has entered their
	marks, and the class teacher had no way to find out except by opening each
	paper in turn. A card generated early is not blank — it totals the marks
	that exist and divides by the marks that were expected, so a missing paper
	reads as a child who failed it.

	One row per paper, with who owes it. Which is the other half: "three
	papers outstanding" is a fact, and "Physics, Mrs Rao" is an action.
*/
func (s *Server) getReportCardReadiness(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT sub.name,
		       (SELECT u.full_name
		          FROM section_subject_teachers sst
		          JOIN users u ON u.id = sst.teacher_user_id
		         WHERE sst.section_id = $1 AND sst.class_subject_id = cs.id
		         LIMIT 1),
		       (SELECT count(*) FROM marks m
		         WHERE m.exam_subject_id = es.id
		           AND m.student_id IN (SELECT e.student_id FROM enrollments e
		                                 WHERE e.section_id = $1 AND e.status='active'))::int,
		       (SELECT count(*) FROM enrollments e
		         WHERE e.section_id = $1 AND e.status = 'active')::int
		  FROM exam_subjects es
		  JOIN class_subjects cs ON cs.id = es.class_subject_id
		  JOIN subjects sub      ON sub.id = cs.subject_id
		  JOIN sections sec      ON sec.id = $1 AND sec.class_id = cs.class_id
		 WHERE es.exam_id = $2
		 ORDER BY sub.name`,
		[]any{nullString(q.Get("section_id")), nullString(q.Get("exam_id"))},
		func(rows pgx.Rows) (reportReadinessRow, error) {
			var v reportReadinessRow
			return v, rows.Scan(&v.Subject, &v.Teacher, &v.Entered, &v.Expected)
		})
	respond(w, r, items, err)
}

type reportCardRow struct {
	// The card itself. Everything else on this row describes a child; the
	// approval actions act on the card, and without its id the screen has
	// nothing to send.
	ID          string   `json:"id"`
	StudentID   string   `json:"student_id"`
	AdmissionNo string   `json:"admission_no"`
	RollNo      *int     `json:"roll_no,omitempty"`
	FullName    string   `json:"full_name"`
	ClassName   *string  `json:"class_name,omitempty"`
	SectionName *string  `json:"section_name,omitempty"`
	Total       *float64 `json:"total_marks,omitempty"`
	MaxMarks    *float64 `json:"max_marks,omitempty"`
	Percentage  *float64 `json:"percentage,omitempty"`
	Grade       *string  `json:"grade,omitempty"`
	Rank        *int     `json:"rank_in_section,omitempty"`
	Attendance  *float64 `json:"attendance_percent,omitempty"`
	Published   bool     `json:"is_published"`
	/* Where it has got to: draft, submitted, returned, published.

	   is_published is kept in step by a constraint, so this is the same fact
	   said more precisely — a card can be draft or waiting on the head or sent
	   back, and "not published" collapses all three. */
	Status     string  `json:"status"`
	ReturnNote *string `json:"return_note,omitempty"`
	// Subjects is the breakdown the card is actually made of. The row carried
	// a total and a grade and nothing to explain either, so "62%" arrived at a
	// parent with no indication of which subject produced it.
	Subjects []reportCardSubject `json:"subjects"`
}

type reportCardSubject struct {
	Subject  string   `json:"subject"`
	Marks    *float64 `json:"marks_obtained,omitempty"`
	MaxMarks float64  `json:"max_marks"`
	Percent  *float64 `json:"percent,omitempty"`
	Grade    *string  `json:"grade,omitempty"`
	Absent   bool     `json:"is_absent"`
}

/*
listReportCards serves the class teacher, the family and the child.

	One list with three narrowings, which is the whole of the request that
	there be exactly one report card in the product. A class teacher gets
	their section in roll order; a parent gets their children; a student gets
	themselves. Nobody gets a screen of their own to drift out of step with
	the other two.

	Two things it did not do and now does.

	It was not scoped at all. Anybody who could read exams could read every
	report card in the school — a subject teacher, and via the same route a
	guardian, could enumerate the marks of children they have nothing to do
	with. The narrowing is the resolver's, the same one attendance and
	remarks use.

	And it returned totals only. The subject breakdown is what a report card
	is; a percentage with nothing underneath it tells a parent their child
	got 62% and not which subject to help them with. Aggregated in SQL as
	json rather than fetched per student, because the alternative is one
	query per child and a class teacher opens thirty at a time.

	Unpublished cards are hidden from families and shown to staff. That is the
	point of the flag: the class teacher checks the card before the school
	stands behind it, and a family reading a draft removes the checking step.
*/
func (s *Server) listReportCards(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	args := []any{
		nullString(r.URL.Query().Get("section_id")),
		nullString(r.URL.Query().Get("exam_id")),
	}

	// Families see published cards only; staff see drafts, which is what makes
	// checking one before it goes out possible.
	var where string
	switch {
	case len(res.StudentIDs) > 0:
		args = append(args, res.StudentIDs)
		where = `rc.student_id = ANY($` + itoa(len(args)) + `) AND rc.is_published`
	case res.AllStudents:
		where = `TRUE`
	case len(res.SectionIDs) > 0:
		args = append(args, res.SectionIDs)
		where = `e.section_id = ANY($` + itoa(len(args)) + `)`
	default:
		where = `FALSE`
	}

	items, err := collect(s, r, `
		SELECT rc.id::text, st.id::text, st.admission_no, e.roll_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       c.name, sec.name,
		       rc.total_marks, rc.max_marks, rc.percentage, rc.grade,
		       rc.rank_in_section, rc.attendance_percent, rc.is_published,
		       rc.status, rc.return_note,
		       COALESCE((
		         SELECT json_agg(json_build_object(
		                  'subject',        sub.name,
		                  'marks_obtained', m.marks_obtained,
		                  'max_marks',      es.max_marks,
		                  'percent',        round(100.0 * m.marks_obtained
		                                            / NULLIF(es.max_marks,0), 2),
		                  'is_absent',      COALESCE(m.is_absent, false),
		                  'grade', (SELECT gb.grade FROM grade_bands gb
		                             WHERE gb.grading_scale_id = ex.grading_scale_id
		                               AND round(100.0 * m.marks_obtained
		                                          / NULLIF(es.max_marks,0), 2)
		                                   BETWEEN gb.min_percent AND gb.max_percent
		                             LIMIT 1))
		                ORDER BY sub.name)
		           FROM exam_subjects es
		           JOIN exams ex          ON ex.id = es.exam_id
		           JOIN class_subjects cs ON cs.id = es.class_subject_id
		           JOIN subjects sub      ON sub.id = cs.subject_id
		           LEFT JOIN marks m      ON m.exam_subject_id = es.id
		                                 AND m.student_id = st.id
		          WHERE cs.class_id = e.class_id
		            AND ($2::uuid IS NULL OR es.exam_id = $2)
		       ), '[]'::json)
		  FROM report_cards rc
		  JOIN students st ON st.id = rc.student_id
		  JOIN enrollments e ON e.id = rc.enrollment_id
		  LEFT JOIN sections sec ON sec.id = e.section_id
		  LEFT JOIN classes  c   ON c.id = sec.class_id
		 WHERE ($1::uuid IS NULL OR e.section_id = $1)
		   AND `+where+`
		 ORDER BY e.roll_no NULLS LAST, st.admission_no`, args,
		func(rows pgx.Rows) (reportCardRow, error) {
			var v reportCardRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.AdmissionNo, &v.RollNo, &v.FullName,
				&v.ClassName, &v.SectionName,
				&v.Total, &v.MaxMarks, &v.Percentage, &v.Grade, &v.Rank,
				&v.Attendance, &v.Published, &v.Status, &v.ReturnNote, &v.Subjects)
		})
	respond(w, r, items, err)
}

// ----------------------------------------------------------- student lifecycle

type promoteRequest struct {
	FromSectionID  string   `json:"from_section_id"`
	ToSectionID    string   `json:"to_section_id"`
	AcademicYearID string   `json:"academic_year_id"`
	StudentIDs     []string `json:"student_ids,omitempty"`
}

// promoteStudents rolls a section into the next year's section.
//
// The previous enrolment is closed rather than deleted and the new one records
// promoted_from_id, so a child's academic history stays intact — which is what
// a transfer certificate has to reconstruct years later.
func (s *Server) promoteStudents(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req promoteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	from, err := uuid.Parse(req.FromSectionID)
	if err != nil {
		httpx.BadRequest(w, r, "from_section_id must be a uuid")
		return
	}
	to, err := uuid.Parse(req.ToSectionID)
	if err != nil {
		httpx.BadRequest(w, r, "to_section_id must be a uuid")
		return
	}
	year, err := uuid.Parse(req.AcademicYearID)
	if err != nil {
		httpx.BadRequest(w, r, "academic_year_id must be a uuid")
		return
	}

	promoted := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var toClass uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT class_id FROM sections WHERE id = $1`, to).Scan(&toClass); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(), `
			WITH moving AS (
			  SELECT e.id, e.student_id
			    FROM enrollments e
			   WHERE e.section_id = $1 AND e.status = 'active'
			     AND ($5::uuid[] IS NULL OR e.student_id = ANY($5))
			),
			closed AS (
			  UPDATE enrollments SET status = 'promoted'
			   WHERE id IN (SELECT id FROM moving) RETURNING id, student_id
			)
			INSERT INTO enrollments (institution_id, student_id, academic_year_id,
			                         class_id, section_id, status, promoted_from_id)
			SELECT $2, c.student_id, $3, $4, $6, 'active', c.id
			  FROM closed c
			ON CONFLICT DO NOTHING`,
			from, id.InstitutionID, year, toClass, uuidArray(req.StudentIDs), to)
		if err != nil {
			return err
		}
		promoted = int(tag.RowsAffected())
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"promoted": promoted})
}

type issueCertificateRequest struct {
	StudentID string `json:"student_id"`
	TypeCode  string `json:"type_code"` // TC | BONAFIDE | CONDUCT
	Reason    string `json:"reason,omitempty"`
}

// issueCertificate generates a numbered certificate and freezes a snapshot of
// the student's record into it.
//
// The snapshot matters: a transfer certificate issued today must keep showing
// today's class and attendance even after the student is archived and the
// enrolment closed. Rendering it live from the current record would make an
// old TC change its own contents.
func (s *Server) issueCertificate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req issueCertificateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	sid, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.TypeCode == "" {
		req.TypeCode = "TC"
	}

	var serial string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var typeID uuid.UUID
		err := tx.QueryRow(r.Context(),
			`SELECT id FROM certificate_types WHERE code = $1`, req.TypeCode).Scan(&typeID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Create the type on first use so a school is not blocked by setup.
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO certificate_types (institution_id, code, name, requires_approval)
				VALUES ($1,$2,$3,false) RETURNING id`,
				id.InstitutionID, req.TypeCode, certificateName(req.TypeCode)).Scan(&typeID); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}

		serial, err = fees.NextNumber(r.Context(), tx, id.InstitutionID, "certificate")
		if err != nil {
			return err
		}

		_, err = tx.Exec(r.Context(), `
			INSERT INTO issued_certificates (institution_id, certificate_type_id, student_id,
			                                 serial_no, issued_on, snapshot, status, requested_by)
			SELECT $1, $2, st.id, $3, CURRENT_DATE,
			       jsonb_build_object(
			         'name', concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			         'admission_no', st.admission_no,
			         'date_of_birth', st.date_of_birth,
			         'class', c.name, 'section', sec.name,
			         'admission_date', st.admission_date,
			         'apaar_id', st.apaar_id,
			         'attendance_percent', COALESCE((
			             SELECT round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late'))
			                          / NULLIF(count(*),0))
			               FROM student_attendance sa WHERE sa.student_id = st.id), 0),
			         'dues_paise', COALESCE((
			             SELECT sum(i.net_paise - i.paid_paise) FROM invoices i
			              WHERE i.student_id = st.id AND i.status IN ('unpaid','partial','overdue')), 0),
			         'reason', $4::text,
			         'issued_at', now()
			       ),
			       'issued', $5
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id FROM enrollments e
			       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
			  ) en ON true
			  LEFT JOIN classes  c   ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE st.id = $6`,
			id.InstitutionID, typeID, serial, nullString(req.Reason), id.UserID, sid)
		if err != nil {
			return err
		}

		// A transfer certificate ends the child's time at the school.
		if req.TypeCode == "TC" {
			if _, err := tx.Exec(r.Context(), `
				UPDATE students SET status='transferred', exit_date=CURRENT_DATE,
				                    exit_reason=COALESCE($2, 'Transfer certificate issued')
				 WHERE id = $1`, sid, nullString(req.Reason)); err != nil {
				return err
			}
			_, err = tx.Exec(r.Context(),
				`UPDATE enrollments SET status='transferred' WHERE student_id=$1 AND status='active'`, sid)
		}
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"serial_no": serial, "type": req.TypeCode, "student_id": sid.String(),
	})
}

func certificateName(code string) string {
	switch code {
	case "TC":
		return "Transfer Certificate"
	case "BONAFIDE":
		return "Bonafide Certificate"
	case "CONDUCT":
		return "Character Certificate"
	default:
		return code
	}
}

type certificateRow struct {
	Serial   string `json:"serial_no"`
	Type     string `json:"type"`
	Student  string `json:"student_name"`
	IssuedOn string `json:"issued_on"`
	Status   string `json:"status"`
	Snapshot any    `json:"snapshot"`
}

func (s *Server) listCertificates(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT ic.serial_no, ct.name,
		       concat_ws(' ', st.first_name, st.last_name),
		       to_char(ic.issued_on,'YYYY-MM-DD'), ic.status, ic.snapshot
		  FROM issued_certificates ic
		  JOIN certificate_types ct ON ct.id = ic.certificate_type_id
		  LEFT JOIN students st ON st.id = ic.student_id
		 ORDER BY ic.created_at DESC LIMIT 200`, nil,
		func(rows pgx.Rows) (certificateRow, error) {
			var v certificateRow
			return v, rows.Scan(&v.Serial, &v.Type, &v.Student, &v.IssuedOn, &v.Status, &v.Snapshot)
		})
	respond(w, r, items, err)
}

// uuidArray converts a slice of id strings into a pg uuid[] argument, or NULL
// when empty so the caller's query can treat "no filter" uniformly.
func uuidArray(ids []string) any {
	if len(ids) == 0 {
		return nil
	}
	out := make([]uuid.UUID, 0, len(ids))
	for _, s := range ids {
		if v, err := uuid.Parse(s); err == nil {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

type examRow struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	StartsOn  *string `json:"starts_on,omitempty"`
	Published bool    `json:"is_published"`
	Papers    int     `json:"papers"`
}

// listExams powers the exam picker. Without it the gradebook needed a paper id
// typed in by hand, which is not something a teacher can be asked to do.
func (s *Server) listExams(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT e.id::text, e.name, e.kind, to_char(e.starts_on,'YYYY-MM-DD'), e.is_published,
		       (SELECT count(*) FROM exam_subjects es WHERE es.exam_id = e.id)::int
		  FROM exams e
		 ORDER BY e.starts_on DESC NULLS LAST, e.name`, nil,
		func(rows pgx.Rows) (examRow, error) {
			var v examRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Kind, &v.StartsOn, &v.Published, &v.Papers)
		})
	respond(w, r, items, err)
}

type examSubjectRow struct {
	ID        string  `json:"id"`
	ExamID    string  `json:"exam_id"`
	ExamName  string  `json:"exam_name"`
	ExamKind  string  `json:"exam_kind"`
	Subject   string  `json:"subject"`
	ClassID   string  `json:"class_id"`
	ClassName string  `json:"class_name"`
	Label     string  `json:"label"`
	MaxMarks  float64 `json:"max_marks"`
	Entered   int     `json:"marks_entered"`
	Expected  int     `json:"students"`
}

// listExamSubjects lists the papers a teacher can enter marks against, with
// how many are already done so the pending ones are obvious.
func (s *Server) listExamSubjects(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Narrowed to what the caller teaches.

	   This listed every paper in the school to everybody who could reach the
	   endpoint. A subject teacher picking "the paper I have to mark" scrolled
	   past every paper of every class, and the one screen whose entire job is
	   to be a short list was the longest list in the product. The exam
	   controller and the office still see all of it — AllStudents is what
	   distinguishes them — and this is the same predicate the rest of the
	   teaching screens narrow by, not a second idea of what a teacher reaches.

	   The filters below are what the request asked for: pick the class and the
	   kind of exam before the paper, rather than reading three facts out of a
	   single concatenated label. */
	q := r.URL.Query()
	args := []any{
		nullString(q.Get("exam_id")),
		nullString(q.Get("class_id")),
		nullString(q.Get("exam_kind")),
	}
	/* The subject, not just the class.

	   This narrowed to the sections the caller teaches in, which is a
	   different question from the one the screen asks. A Telugu teacher who
	   takes 6-B was offered every paper of 6-B — Telugu, English, General
	   Science, Hindi, Mathematics — because she teaches somebody in that
	   class. Five papers she cannot mark, one she can, and no way to tell
	   which from the list.

	   Saving already refused her: enterMarks checks the allocation and returns
	   403. So the dropdown was inviting a teacher into four papers that would
	   turn her away at the end, which is worse than not offering them — she
	   finds out after typing twenty marks.

	   Two things belong here, and they are different rights. A subject teacher
	   reaches the papers of the class_subjects she is allocated to. A class
	   teacher reaches every subject of her own section, because collating the
	   whole section's marks into a report card is her job and the school has
	   nobody else to do it. The exam controller and the office still see all
	   of it — AllStudents is what marks them out. */
	mine := "TRUE"
	if !res.AllStudents {
		clauses := []string{}

		// Allocated to teach this class_subject.
		args = append(args, id.UserID)
		clauses = append(clauses, `EXISTS (SELECT 1 FROM section_subject_teachers t
		                                    WHERE t.teacher_user_id = $`+itoa(len(args))+`
		                                      AND t.class_subject_id = cs.id)`)

		// Class teacher of a section in this class: every subject of it.
		if len(res.ClassTeacherOf) > 0 {
			args = append(args, res.ClassTeacherOf)
			clauses = append(clauses, `EXISTS (SELECT 1 FROM sections cts
			                                    WHERE cts.id = ANY($`+itoa(len(args))+`)
			                                      AND cts.class_id = cs.class_id)`)
		}
		mine = "(" + strings.Join(clauses, " OR ") + ")"
	}

	items, err := collect(s, r, `
		SELECT es.id::text, e.id::text, e.name, COALESCE(e.kind,''), sub.name,
		       c.id::text, c.name,
		       e.name || ' · ' || c.name || ' · ' || sub.name,
		       es.max_marks,
		       (SELECT count(*) FROM marks m WHERE m.exam_subject_id = es.id)::int,
		       (SELECT count(*) FROM enrollments en
		         WHERE en.class_id = cs.class_id AND en.status = 'active')::int
		  FROM exam_subjects es
		  JOIN exams e           ON e.id = es.exam_id
		  JOIN class_subjects cs ON cs.id = es.class_subject_id
		  JOIN subjects sub      ON sub.id = cs.subject_id
		  JOIN classes c         ON c.id = cs.class_id
		 WHERE ($1::uuid IS NULL OR es.exam_id = $1)
		   AND ($2::uuid IS NULL OR c.id = $2)
		   AND ($3::text IS NULL OR e.kind = $3)
		   AND `+mine+`
		 ORDER BY c.level, sub.name`, args,
		func(rows pgx.Rows) (examSubjectRow, error) {
			var v examSubjectRow
			return v, rows.Scan(&v.ID, &v.ExamID, &v.ExamName, &v.ExamKind, &v.Subject,
				&v.ClassID, &v.ClassName, &v.Label, &v.MaxMarks, &v.Entered, &v.Expected)
		})
	respond(w, r, items, err)
}
