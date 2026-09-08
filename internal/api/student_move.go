package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Moving one child to another section.

   The whole-class move exists (promotion, at year end) and the student edit
   accepts a section, but the edit rewrites every field of the child and the
   form never showed the section, so the one common mid-year act — a child
   moved from 5-A to 5-B — had no door. This is that door and nothing else:
   it touches the enrolment for the current year and leaves the child's
   record alone. The capacity rule and the override are the same ones the
   admission path applies, so the two doors into a section agree. */

type moveStudentRequest struct {
	SectionID     string `json:"section_id"`
	RollNo        int    `json:"roll_no,omitempty"`
	AllowOverflow bool   `json:"allow_overflow,omitempty"`
}

type moveStudentResponse struct {
	StudentID string `json:"student_id"`
	Class     string `json:"class"`
	Section   string `json:"section"`
}

func (s *Server) moveStudentSection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req moveStudentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	section, err := uuid.Parse(strings.TrimSpace(req.SectionID))
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)
	var out moveStudentResponse
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM students st WHERE st.id = $1 AND `+pred+`)`,
			append([]any{sid}, args...)...).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return pgx.ErrNoRows
		}
		year, err := s.workingYear(r.Context(), tx, r)
		if err != nil {
			return errNoAcademicYear
		}
		yearID := year.String()
		var className, sectionName string
		var capacity, taken int
		if err := tx.QueryRow(r.Context(), `
			SELECT c.name, s.name, s.capacity,
			       (SELECT count(*) FROM enrollments e
			         WHERE e.section_id = s.id AND e.status = 'active'
			           AND e.student_id <> $2)::int
			  FROM sections s JOIN classes c ON c.id = s.class_id
			 WHERE s.id = $1`, section, sid).Scan(&className, &sectionName, &capacity, &taken); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errNoSuchSection
			}
			return err
		}
		if !req.AllowOverflow && capacity > 0 && taken >= capacity {
			return fmt.Errorf("%w: %s-%s is full at %d of %d",
				errSectionFull, className, sectionName, taken, capacity)
		}
		var rollNo any
		if req.RollNo > 0 {
			rollNo = req.RollNo
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO enrollments (institution_id, student_id, academic_year_id,
			                         class_id, section_id, roll_no, status)
			SELECT $1, $2::uuid, $3::uuid, s.class_id, s.id, $5, 'active'
			  FROM sections s WHERE s.id = $4::uuid
			ON CONFLICT (student_id, academic_year_id) WHERE status = 'active'
			DO UPDATE SET section_id = EXCLUDED.section_id,
			              class_id   = EXCLUDED.class_id,
			              roll_no    = COALESCE(EXCLUDED.roll_no, enrollments.roll_no),
			              status     = 'active'`,
			id.InstitutionID, sid, yearID, section, rollNo); err != nil {
			return err
		}
		out = moveStudentResponse{StudentID: sid.String(), Class: className, Section: sectionName}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errNoSuchSection):
		httpx.BadRequest(w, r, "that section does not exist")
	case errors.Is(err, errNoAcademicYear):
		httpx.BadRequest(w, r, err.Error())
	case errors.Is(err, errSectionFull):
		httpx.Error(w, r, http.StatusConflict, "no_seats",
			err.Error()+". Choose another section, or move anyway.")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

var errNoSuchSection = errors.New("no such section")

/* The same move, with a date and a record.

   moveStudentSection above rewrites the year's row in place: after it, the
   child has always been in 5-B, and the attendance register and the marks
   taken in 5-A hang off a row that now says 5-B. That is the correction of a
   clerical slip -- a child put in the wrong section on admission day. This
   is the October move: the old enrolment is closed on the date the child
   actually changed, the new one opens the same day, in one transaction, so
   there is never a moment with no active enrolment (which is what
   promoteStudents did to a same-year move, and what took the child off every
   roster). The old roll number is released with the old row; the new one is
   whatever the office gives, or none. */

type sectionChangeRequest struct {
	SectionID     string `json:"section_id"`
	EffectiveOn   string `json:"effective_on"`
	RollNo        int    `json:"roll_no,omitempty"`
	Reason        string `json:"reason,omitempty"`
	AllowOverflow bool   `json:"allow_overflow,omitempty"`
}

type sectionChangeResponse struct {
	StudentID   string `json:"student_id"`
	Class       string `json:"class"`
	Section     string `json:"section"`
	EffectiveOn string `json:"effective_on"`
	From        string `json:"from"`
}

var (
	errNoActiveEnrolment = errors.New("no active enrolment")
	errSameSection       = errors.New("already in that section")
	errRollNoTaken       = errors.New("roll number taken")
)

func (s *Server) changeStudentSection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req sectionChangeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	section, err := uuid.Parse(strings.TrimSpace(req.SectionID))
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	effective := strings.TrimSpace(req.EffectiveOn)
	if effective == "" {
		effective = nowInIndia().Format("2006-01-02")
	}
	if _, err := time.Parse("2006-01-02", effective); err != nil {
		httpx.BadRequest(w, r, "effective_on must be a date, YYYY-MM-DD")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)

	var out sectionChangeResponse
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM students st WHERE st.id = $1 AND `+pred+`)`,
			append([]any{sid}, args...)...).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return pgx.ErrNoRows
		}

		// The row being closed. Locked, so two clerks moving the same child
		// in the same minute do not both close it and both open one.
		var cur struct {
			id, year, section uuid.UUID
			where             string
			rollNo            *int
			enrolledOn        string
		}
		err := tx.QueryRow(r.Context(), `
			SELECT e.id, e.academic_year_id, e.section_id, c.name || '-' || sec.name,
			       e.roll_no, to_char(e.enrolled_on,'YYYY-MM-DD')
			  FROM enrollments e
			  JOIN sections sec ON sec.id = e.section_id
			  JOIN classes c ON c.id = sec.class_id
			 WHERE e.student_id = $1 AND e.status = 'active'
			 ORDER BY e.enrolled_on DESC LIMIT 1
			 FOR UPDATE OF e`, sid).
			Scan(&cur.id, &cur.year, &cur.section, &cur.where, &cur.rollNo, &cur.enrolledOn)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNoActiveEnrolment
		}
		if err != nil {
			return err
		}
		if cur.section == section {
			return errSameSection
		}
		if effective < cur.enrolledOn {
			return fmt.Errorf("%w: the current enrolment began on %s",
				errBadEffectiveDate, cur.enrolledOn)
		}

		var className, sectionName string
		var capacity, taken int
		if err := tx.QueryRow(r.Context(), `
			SELECT c.name, s.name, s.capacity,
			       (SELECT count(*) FROM enrollments e
			         WHERE e.section_id = s.id AND e.status = 'active')::int
			  FROM sections s JOIN classes c ON c.id = s.class_id
			 WHERE s.id = $1`, section).Scan(&className, &sectionName, &capacity, &taken); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errNoSuchSection
			}
			return err
		}
		if !req.AllowOverflow && capacity > 0 && taken >= capacity {
			return fmt.Errorf("%w: %s-%s is full at %d of %d",
				errSectionFull, className, sectionName, taken, capacity)
		}
		// Roll numbers are unique within a section (enrollments_roll_no_unique).
		// Said before the insert rather than left to the constraint, because
		// "duplicate key" is not a sentence a clerk can act on.
		var rollNo any
		if req.RollNo > 0 {
			var used bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM enrollments
				                WHERE section_id = $1 AND roll_no = $2)`,
				section, req.RollNo).Scan(&used); err != nil {
				return err
			}
			if used {
				return fmt.Errorf("%w: roll number %d is already used in %s-%s",
					errRollNoTaken, req.RollNo, className, sectionName)
			}
			rollNo = req.RollNo
		}

		// Close, then open, in this order: the partial unique index allows
		// one active row per year, and the new one cannot exist while the
		// old is still active.
		if _, err := tx.Exec(r.Context(), `
			UPDATE enrollments
			   SET status = 'moved', ended_on = $2::date,
			       remarks = concat_ws(' ', 'Moved to', $3, 'on', $2::text,
			                           NULLIF(btrim($4), ''))
			 WHERE id = $1`, cur.id, effective, className+"-"+sectionName, req.Reason); err != nil {
			return err
		}
		var newID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO enrollments (institution_id, student_id, academic_year_id,
			                         class_id, section_id, roll_no, enrolled_on, status,
			                         promoted_from_id, remarks)
			SELECT $1, $2::uuid, $3::uuid, s.class_id, s.id, $5, $6::date, 'active', $7,
			       concat_ws(' ', 'Moved from', $8, 'on', $6::text)
			  FROM sections s WHERE s.id = $4::uuid
			RETURNING id`,
			id.InstitutionID, sid, cur.year, section, rollNo, effective, cur.id, cur.where).
			Scan(&newID); err != nil {
			return err
		}

		// Who moved the child, from where, to where, and when it took effect.
		// The generic audit middleware keeps the request body; it does not
		// know which section the child left.
		before, _ := json.Marshal(map[string]any{
			"enrollment_id": cur.id, "section_id": cur.section, "where": cur.where,
			"roll_no": cur.rollNo,
		})
		after, _ := json.Marshal(map[string]any{
			"enrollment_id": newID, "section_id": section,
			"where": className + "-" + sectionName, "roll_no": rollNo,
			"effective_on": effective, "reason": strings.TrimSpace(req.Reason),
		})
		var ip *string
		if host, _, err := splitHostPortSafe(r.RemoteAddr); err == nil {
			ip = &host
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO audit_log (institution_id, actor_user_id, action, entity_type,
			                       entity_id, before, after, ip)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8::inet)`,
			id.InstitutionID, id.UserID, "SECTION_CHANGE student", "students",
			sid, before, after, ip); err != nil {
			return err
		}
		out = sectionChangeResponse{
			StudentID: sid.String(), Class: className, Section: sectionName,
			EffectiveOn: effective, From: cur.where,
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errNoActiveEnrolment):
		httpx.Error(w, r, http.StatusConflict, "no_active_enrolment",
			"this child has no active enrolment to move. Enrol them in a section first.")
	case errors.Is(err, errSameSection):
		httpx.BadRequest(w, r, "the child is already in that section")
	case errors.Is(err, errBadEffectiveDate):
		httpx.BadRequest(w, r, err.Error())
	case errors.Is(err, errNoSuchSection):
		httpx.BadRequest(w, r, "that section does not exist")
	case errors.Is(err, errRollNoTaken):
		httpx.Error(w, r, http.StatusConflict, "roll_no_taken", err.Error())
	case errors.Is(err, errSectionFull):
		httpx.Error(w, r, http.StatusConflict, "no_seats",
			err.Error()+". Choose another section, or move anyway.")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

var errBadEffectiveDate = errors.New("effective date before the enrolment")
