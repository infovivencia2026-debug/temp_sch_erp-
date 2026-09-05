package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

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
		var yearID string
		if err := tx.QueryRow(r.Context(), `
			SELECT id::text FROM academic_years
			 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&yearID); err != nil {
			return errNoAcademicYear
		}
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
			ON CONFLICT (student_id, academic_year_id)
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
