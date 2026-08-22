package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The two checks a head of department makes, written down.

   Before the exam somebody senior reads the paper; after it, somebody senior
   reads the marks. Both were already happening in every school — on WhatsApp,
   over a desk — and neither left a record here. The cost is not the missing
   step, it is the missing name against it: when a paper goes out carrying a
   question from a chapter not yet taught, or one section's marks come out
   fifteen points under the other three, the school has to be able to say who
   read it and when.

   Who may approve is a permission, academics.exams.approve, held by the
   principal, the vice principal and the head of department. What they may
   approve is a scope: their own department's classes. The queue narrows to the
   sections the caller reaches — with one deliberate exception, explained at
   approverSees below.
*/

type questionPaperRow struct {
	ID          string  `json:"id"`
	ExamName    string  `json:"exam_name"`
	ExamDate    *string `json:"exam_date"`
	Class       string  `json:"class"`
	Subject     string  `json:"subject"`
	MaxMarks    string  `json:"max_marks"`
	Duration    *int32  `json:"duration_minutes"`
	FileID      *string `json:"file_id"`
	Notes       *string `json:"notes"`
	Status      string  `json:"status"`
	SetBy       string  `json:"set_by"`
	SubmittedAt string  `json:"submitted_at"`
	ReviewedBy  *string `json:"reviewed_by"`
	ReviewNote  *string `json:"review_note"`
	// Mine says the caller set this paper, so the screen can offer to edit it
	// rather than to decide it. The same person can be both — a head of
	// department teaches — and a screen that offers Approve on your own paper
	// is inviting exactly the thing this feature exists to prevent.
	Mine bool `json:"mine"`
}

/*
Whether this caller decides, and over which classes.

	A head of department at a school that has not created departments has no
	sections, and narrowing strictly would hand them an empty approval queue —
	which is the bug that was just fixed on the menu, reappearing one screen
	further in. Exam papers are not confidential from the school's own exam
	authority: everyone reaching this holds academics.exams.approve, which is
	the principal, the vice principal and the heads of department, and none of
	them is a person a paper must be hidden from.

	So the queue narrows to the caller's own classes when they have some, and
	shows the school's when they have none. The screen says which it is doing,
	because a head of department seeing the whole school's papers should know
	that is what they are looking at.
*/
// errStopped ends the transaction after the handler has already answered. The
// alternative is committing whatever the transaction did so far and then
// writing a 400 over the top of it.
var errStopped = errors.New("handled")

func approverSees(sectionIDs []uuid.UUID) (narrowed bool) { return len(sectionIDs) > 0 }

// listQuestionPapers returns the approval queue, or a teacher's own papers.
func (s *Server) listQuestionPapers(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	sc, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	decides := id.Can(rbac.ExamsApprove)
	narrowed := decides && approverSees(sc.SectionIDs)

	status := strings.TrimSpace(r.URL.Query().Get("status"))

	out := []questionPaperRow{}
	var wholeSchool bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Two audiences, one query.

		   A teacher sees the papers they submitted. Somebody who decides sees
		   the papers for their classes, whoever set them. A head of department
		   is both, so the two sets are ORed rather than switched between —
		   picking one branch would hide their own drafts from them the moment
		   they were given the permission. */
		where := []string{}
		args := []any{id.UserID}
		if decides {
			if narrowed {
				args = append(args, sc.SectionIDs)
				where = append(where, `(qp.submitted_by = $1 OR cs.class_id IN (
				                          SELECT class_id FROM sections WHERE id = ANY($2)))`)
			} else {
				wholeSchool = true
				where = append(where, `TRUE`)
			}
		} else {
			where = append(where, `qp.submitted_by = $1`)
		}
		if status != "" {
			args = append(args, status)
			where = append(where, `qp.status = $`+itoa(len(args)))
		}

		rows, err := tx.Query(r.Context(), `
			SELECT qp.id::text, ex.name, es.exam_date::text, c.name, sub.name,
			       es.max_marks::text, es.duration_minutes,
			       qp.file_id::text, qp.notes, qp.status,
			       COALESCE(u.full_name, 'a teacher'),
			       qp.submitted_at, rv.full_name, qp.review_note,
			       qp.submitted_by = $1
			  FROM question_papers qp
			  JOIN exam_subjects es  ON es.id = qp.exam_subject_id
			  JOIN exams ex          ON ex.id = es.exam_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN classes c         ON c.id  = cs.class_id
			  JOIN subjects sub      ON sub.id = cs.subject_id
			  LEFT JOIN users u      ON u.id  = qp.submitted_by
			  LEFT JOIN users rv     ON rv.id = qp.reviewed_by
			 WHERE `+strings.Join(where, " AND ")+`
			 ORDER BY (qp.status = 'submitted') DESC, es.exam_date NULLS LAST,
			          qp.submitted_at DESC`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v questionPaperRow
			if err := rows.Scan(&v.ID, &v.ExamName, &v.ExamDate, &v.Class, &v.Subject,
				&v.MaxMarks, &v.Duration, &v.FileID, &v.Notes, &v.Status,
				&v.SetBy, &v.SubmittedAt, &v.ReviewedBy, &v.ReviewNote, &v.Mine); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":   out,
		"decides": decides,
		// So the screen can say "every class in the school", rather than
		// letting somebody assume a queue is theirs when it is everybody's.
		"whole_school": wholeSchool,
	})
}

// listPaperSlots lists the exam papers a teacher could submit against — the
// subjects they teach in exams that have not happened yet, with whatever they
// have already submitted attached.
//
// Without this the teacher has to know which exam_subject row their paper
// belongs to, which is a uuid nobody has.
func (s *Server) listPaperSlots(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	sc, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	type slot struct {
		ExamSubjectID string  `json:"exam_subject_id"`
		ExamName      string  `json:"exam_name"`
		ExamDate      *string `json:"exam_date"`
		Class         string  `json:"class"`
		Subject       string  `json:"subject"`
		MaxMarks      string  `json:"max_marks"`
		Status        *string `json:"status"`
	}
	out := []slot{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The classes the caller teaches. A head of department with no classes
		// of their own gets an empty list here and that is correct: this is
		// "papers I set", not "papers I approve".
		rows, err := tx.Query(r.Context(), `
			SELECT es.id::text, ex.name, es.exam_date::text, c.name, sub.name,
			       es.max_marks::text, qp.status
			  FROM exam_subjects es
			  JOIN exams ex          ON ex.id = es.exam_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN classes c         ON c.id  = cs.class_id
			  JOIN subjects sub      ON sub.id = cs.subject_id
			  LEFT JOIN question_papers qp ON qp.exam_subject_id = es.id
			 WHERE cs.class_id IN (SELECT class_id FROM sections WHERE id = ANY($1))
			 ORDER BY es.exam_date NULLS LAST, c.name, sub.name`, sc.SectionIDs)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v slot
			if err := rows.Scan(&v.ExamSubjectID, &v.ExamName, &v.ExamDate, &v.Class,
				&v.Subject, &v.MaxMarks, &v.Status); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

// submitQuestionPaper creates or replaces the caller's paper for one exam
// subject, either as a draft or into the approval queue.
func (s *Server) submitQuestionPaper(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in struct {
		ExamSubjectID string  `json:"exam_subject_id"`
		FileID        *string `json:"file_id"`
		Notes         string  `json:"notes"`
		Submit        bool    `json:"submit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send a paper to submit.")
		return
	}
	esID, err := uuid.Parse(strings.TrimSpace(in.ExamSubjectID))
	if err != nil {
		httpx.BadRequest(w, r, "Choose which exam paper this is for.")
		return
	}
	var fileID *uuid.UUID
	if in.FileID != nil && strings.TrimSpace(*in.FileID) != "" {
		f, err := uuid.Parse(strings.TrimSpace(*in.FileID))
		if err != nil {
			httpx.BadRequest(w, r, "That attachment could not be read. Upload it again.")
			return
		}
		fileID = &f
	}
	if in.Submit && fileID == nil {
		httpx.BadRequest(w, r, "Attach the paper before sending it for approval.")
		return
	}
	status := "draft"
	if in.Submit {
		status = "submitted"
	}

	sc, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// You may only set a paper for a class you teach. RLS bounds this to
		// the school; nothing else stops one teacher submitting over another
		// department's paper, and the unique index means that would replace it.
		var ok bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (
				SELECT 1 FROM exam_subjects es
				  JOIN class_subjects cs ON cs.id = es.class_subject_id
				 WHERE es.id = $1
				   AND cs.class_id IN (SELECT class_id FROM sections WHERE id = ANY($2)))`,
			esID, sc.SectionIDs).Scan(&ok); err != nil {
			return err
		}
		if !ok && !id.PlatformAdmin {
			httpx.Forbidden(w, r, rbac.ExamsRead)
			return errStopped
		}

		/* Resubmission clears the earlier decision.
		   A paper that comes back approved because it was approved in its
		   previous shape is the failure this feature is meant to prevent. */
		_, err := tx.Exec(r.Context(), `
			INSERT INTO question_papers
			       (institution_id, exam_subject_id, file_id, notes, submitted_by, status)
			VALUES ($1, $2, $3, nullif(btrim($4), ''), $5, $6)
			ON CONFLICT (exam_subject_id) DO UPDATE
			   SET file_id      = EXCLUDED.file_id,
			       notes        = EXCLUDED.notes,
			       submitted_by = EXCLUDED.submitted_by,
			       submitted_at = now(),
			       status       = EXCLUDED.status,
			       reviewed_by  = NULL,
			       reviewed_at  = NULL,
			       review_note  = NULL`,
			id.InstitutionID, esID, fileID, in.Notes, id.UserID, status)
		return err
	})
	if err == errStopped {
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": status})
}

// decideQuestionPaper approves a paper or sends it back with a reason.
func (s *Server) decideQuestionPaper(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	paperID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "Unknown paper.")
		return
	}
	var in struct {
		Decision string `json:"decision"`
		Note     string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send a decision.")
		return
	}
	note := strings.TrimSpace(in.Note)
	switch in.Decision {
	case "approved":
	case "changes_needed":
		if note == "" {
			// The whole value of sending it back is the sentence. Without one
			// the teacher resubmits the same paper and both people lose a day.
			httpx.BadRequest(w, r, "Say what needs changing, so the teacher knows what to fix.")
			return
		}
	default:
		httpx.BadRequest(w, r, "A paper is either approved or sent back for changes.")
		return
	}

	var setter uuid.UUID
	var subject, class string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			UPDATE question_papers qp
			   SET status      = $2,
			       reviewed_by = $3,
			       reviewed_at = now(),
			       review_note = nullif(btrim($4), '')
			  FROM exam_subjects es
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN classes c         ON c.id  = cs.class_id
			  JOIN subjects sub      ON sub.id = cs.subject_id
			 WHERE qp.id = $1 AND es.id = qp.exam_subject_id
			   -- Only a paper that is waiting. Approving a draft nobody has
			   -- finished, or re-deciding one already decided, are both ways of
			   -- putting a name against something that was never read.
			   AND qp.status = 'submitted'
			 RETURNING qp.submitted_by, sub.name, c.name`,
			paperID, in.Decision, id.UserID, note).Scan(&setter, &subject, &class)
		if err == pgx.ErrNoRows {
			httpx.BadRequest(w, r, "That paper is not waiting for a decision. Someone may have decided it already.")
			return errStopped
		}
		if err != nil {
			return err
		}

		// The teacher is told. Without this they find out by opening a screen
		// they have no reason to open again, which for a paper sent back means
		// finding out after the exam has been printed.
		body := "Your " + subject + " paper for " + class + " was approved."
		if in.Decision == "changes_needed" {
			body = "Your " + subject + " paper for " + class + " needs changes: " + note
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO notifications (institution_id, user_id, kind, title, body, link)
			VALUES ($1, $2, 'question_paper', $3, $4, '/go/exams/question_papers')`,
			id.InstitutionID, setter, "Question paper", body)
		return err
	})
	if err == errStopped {
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"status": in.Decision})
}

// ---------------------------------------------------------------------------
// Mark moderation
// ---------------------------------------------------------------------------

type moderationRow struct {
	ExamSubjectID string  `json:"exam_subject_id"`
	ExamName      string  `json:"exam_name"`
	Class         string  `json:"class"`
	Subject       string  `json:"subject"`
	MaxMarks      string  `json:"max_marks"`
	PassMarks     string  `json:"pass_marks"`
	Entered       int32   `json:"entered"`
	Absent        int32   `json:"absent"`
	Failing       int32   `json:"failing"`
	AveragePct    *string `json:"average_pct"`
	HighestPct    *string `json:"highest_pct"`
	LowestPct     *string `json:"lowest_pct"`

	Adjustment  *string `json:"adjustment"`
	Reason      *string `json:"reason"`
	ModeratedBy *string `json:"moderated_by"`
	ModeratedAt *string `json:"moderated_at"`
}

/*
Marks, read a paper at a time.

	The gradebook shows one paper's marks student by student, which is the right
	shape for entering them and the wrong shape for the question a head of
	department asks, which is "is this paper out of line with the others". That
	question is about the paper: its average, its spread, how many failed. So
	this counts rather than lists, and the counting is done in the database
	because five hundred rows crossing the wire to be averaged in a browser is
	the same answer arriving slower.
*/
func (s *Server) listMarkModeration(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	sc, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	narrowed := approverSees(sc.SectionIDs)

	out := []moderationRow{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		where := "TRUE"
		var args []any
		if narrowed {
			args = append(args, sc.SectionIDs)
			where = `cs.class_id IN (SELECT class_id FROM sections WHERE id = ANY($1))`
		}
		rows, err := tx.Query(r.Context(), `
			SELECT es.id::text, ex.name, c.name, sub.name,
			       es.max_marks::text, es.pass_marks::text,
			       count(m.id) FILTER (WHERE NOT m.is_absent)::int,
			       count(m.id) FILTER (WHERE m.is_absent)::int,
			       count(m.id) FILTER (WHERE NOT m.is_absent
			                             AND m.marks_obtained < es.pass_marks)::int,
			       round(avg(m.marks_obtained) FILTER (WHERE NOT m.is_absent)
			             / nullif(es.max_marks, 0) * 100, 1)::text,
			       round(max(m.marks_obtained) FILTER (WHERE NOT m.is_absent)
			             / nullif(es.max_marks, 0) * 100, 1)::text,
			       round(min(m.marks_obtained) FILTER (WHERE NOT m.is_absent)
			             / nullif(es.max_marks, 0) * 100, 1)::text,
			       mm.adjustment::text, mm.reason, mu.full_name, mm.moderated_at::text
			  FROM exam_subjects es
			  JOIN exams ex          ON ex.id = es.exam_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN classes c         ON c.id  = cs.class_id
			  JOIN subjects sub      ON sub.id = cs.subject_id
			  JOIN marks m           ON m.exam_subject_id = es.id
			  LEFT JOIN mark_moderations mm ON mm.exam_subject_id = es.id
			  LEFT JOIN users mu     ON mu.id = mm.moderated_by
			 WHERE `+where+`
			 GROUP BY es.id, ex.name, c.name, sub.name, es.max_marks, es.pass_marks,
			          mm.adjustment, mm.reason, mu.full_name, mm.moderated_at
			 -- Papers nobody has read yet come first: this screen is a queue
			 -- before it is a record.
			 ORDER BY (mm.moderated_at IS NULL) DESC, ex.name, c.name, sub.name`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v moderationRow
			if err := rows.Scan(&v.ExamSubjectID, &v.ExamName, &v.Class, &v.Subject,
				&v.MaxMarks, &v.PassMarks, &v.Entered, &v.Absent, &v.Failing,
				&v.AveragePct, &v.HighestPct, &v.LowestPct,
				&v.Adjustment, &v.Reason, &v.ModeratedBy, &v.ModeratedAt); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": out, "whole_school": !narrowed,
	})
}

// moderateMarks records the decision about one paper and applies it.
func (s *Server) moderateMarks(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in struct {
		ExamSubjectID string  `json:"exam_subject_id"`
		Adjustment    float64 `json:"adjustment"`
		Reason        string  `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send a moderation.")
		return
	}
	esID, err := uuid.Parse(strings.TrimSpace(in.ExamSubjectID))
	if err != nil {
		httpx.BadRequest(w, r, "Choose which paper this is about.")
		return
	}
	reason := strings.TrimSpace(in.Reason)
	if reason == "" {
		httpx.BadRequest(w, r, "Say why. A change to a child's marks has to be explainable to their parent.")
		return
	}
	if in.Adjustment < -20 || in.Adjustment > 20 {
		httpx.BadRequest(w, r, "Moderation is limited to 20 marks either way. A larger change means the paper should be re-marked.")
		return
	}

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO mark_moderations
			       (institution_id, exam_subject_id, adjustment, reason, moderated_by)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (exam_subject_id) DO UPDATE
			   SET adjustment   = EXCLUDED.adjustment,
			       reason       = EXCLUDED.reason,
			       moderated_by = EXCLUDED.moderated_by,
			       moderated_at = now()`,
			id.InstitutionID, esID, in.Adjustment, reason, id.UserID); err != nil {
			return err
		}

		/* The adjustment is written to grace_marks, not added to
		   marks_obtained.

		   What the teacher marked and what the department added are two
		   different facts, and folding them together loses the second one
		   permanently — re-moderating would then compound on top of the first
		   change rather than replace it. grace_marks already exists for
		   exactly this and nothing was writing it.

		   Absent students are left alone: adding marks to somebody who did not
		   sit the paper turns an absence into a fail. And a moderated total is
		   capped at the paper's maximum, because 103 out of 100 on a report
		   card is how a parent learns not to trust the report card. */
		tag, err := tx.Exec(r.Context(), `
			UPDATE marks m
			   SET grace_marks = LEAST(es.max_marks - COALESCE(m.marks_obtained, 0),
			                           GREATEST(-COALESCE(m.marks_obtained, 0), $2::numeric)),
			       approved_by = $3,
			       approved_at = now()
			  FROM exam_subjects es
			 WHERE es.id = m.exam_subject_id
			   AND m.exam_subject_id = $1
			   AND NOT m.is_absent`,
			esID, in.Adjustment, id.UserID)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"students": touched})
}
