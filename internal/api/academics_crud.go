package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Editing the reference tables a school runs on.

   Classes, subjects and academic years could be created and never changed. So
   a school that typed "Class 1" and meant "Grade 1", or gave Physics the code
   PHY when its board wants PHYS, or opened the year on the wrong Monday, had
   no way back — and the reference tables are exactly where a first-pass typo
   lands, because they are filled in during setup before anyone knows what the
   school will actually call things.

   Renaming is safe for the same reason it is safe for a section: nothing joins
   on a name. The timetable, the register, the marks and the ledger all hold
   ids, so the label changes underneath them and the history follows.

   Deleting is different, and each of these refuses on a different thing:

     a class      with sections, because the sections would go with it
     a subject    taught anywhere, because the marks would go with it
     an academic year, ever, because every enrolment, exam and invoice in the
                  school is dated into one and the cascade reaches all of it

   In each case the refusal names what is in the way, and the count, so the
   answer to "why can't I delete this" is on screen rather than in a log.
*/

var (
	errRefGone   = errors.New("no such row")
	errRefInUse  = errors.New("in use")
	errRefTaken  = errors.New("name taken")
	errRefNoName = errors.New("no name")
)

// --- classes ----------------------------------------------------------------

type classPatch struct {
	Name   *string `json:"name,omitempty"`
	Level  *int    `json:"level,omitempty"`
	Stream *string `json:"stream,omitempty"`
}

func (s *Server) updateClass(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	classID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid class id")
		return
	}
	var req classPatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Name != nil {
		*req.Name = strings.TrimSpace(*req.Name)
		if *req.Name == "" {
			httpx.BadRequest(w, r, "a class needs a name")
			return
		}
	}
	// The level orders the school from nursery upwards. Everything that reads
	// classes in order — the roll, the promotion run, the fee structure — reads
	// this, so a zero or a negative would silently sort a grade off the top.
	if req.Level != nil && *req.Level < 0 {
		httpx.BadRequest(w, r, "level cannot be negative")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE classes
			   SET name   = COALESCE($2, name),
			       level  = COALESCE($3, level),
			       stream = CASE WHEN $4::text IS NULL THEN stream ELSE NULLIF($4,'') END
			 WHERE id = $1`, classID, req.Name, req.Level, req.Stream)
		if err != nil {
			if strings.Contains(err.Error(), "classes_institution_id_name") {
				return errRefTaken
			}
			return err
		}
		if tag.RowsAffected() == 0 {
			return errRefGone
		}
		return nil
	})
	writeRefResult(w, r, err, "class", classID)
}

func (s *Server) deleteClass(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	classID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid class id")
		return
	}
	var sections, subjects int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*)::int FROM sections WHERE class_id = c.id),
			       (SELECT count(*)::int FROM class_subjects WHERE class_id = c.id)
			  FROM classes c WHERE c.id = $1`, classID).Scan(&sections, &subjects); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errRefGone
			}
			return err
		}
		if sections > 0 || subjects > 0 {
			return errRefInUse
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM classes WHERE id = $1`, classID)
		return err
	})
	if errors.Is(err, errRefInUse) {
		httpx.BadRequest(w, r, plural(sections, "section", "sections")+" and "+plural(subjects, "mapped subject", "mapped subjects")+
			" hang off this class. Remove them first — deleting the class would take their registers and marks with it")
		return
	}
	writeRefResult(w, r, err, "class", classID)
}

// --- subjects ---------------------------------------------------------------

type subjectPatch struct {
	Name         *string `json:"name,omitempty"`
	Code         *string `json:"code,omitempty"`
	IsScholastic *bool   `json:"is_scholastic,omitempty"`
}

func (s *Server) updateSubject(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	subjectID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid subject id")
		return
	}
	var req subjectPatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	for _, f := range []**string{&req.Name, &req.Code} {
		if *f != nil {
			**f = strings.TrimSpace(**f)
			if **f == "" {
				httpx.BadRequest(w, r, "a subject needs both a name and a code")
				return
			}
		}
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE subjects
			   SET name          = COALESCE($2, name),
			       code          = COALESCE($3, code),
			       is_scholastic = COALESCE($4, is_scholastic)
			 WHERE id = $1`, subjectID, req.Name, req.Code, req.IsScholastic)
		if err != nil {
			if strings.Contains(err.Error(), "subjects_institution") {
				return errRefTaken
			}
			return err
		}
		if tag.RowsAffected() == 0 {
			return errRefGone
		}
		return nil
	})
	writeRefResult(w, r, err, "subject", subjectID)
}

func (s *Server) deleteSubject(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	subjectID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid subject id")
		return
	}
	var taught int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*)::int FROM class_subjects WHERE subject_id = s.id)
			  FROM subjects s WHERE s.id = $1`, subjectID).Scan(&taught); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errRefGone
			}
			return err
		}
		if taught > 0 {
			return errRefInUse
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM subjects WHERE id = $1`, subjectID)
		return err
	})
	if errors.Is(err, errRefInUse) {
		httpx.BadRequest(w, r, "this subject is taught in "+plural(taught, "class", "classes")+
			". Unmap it there first — deleting it would take the marks with it")
		return
	}
	writeRefResult(w, r, err, "subject", subjectID)
}

// --- shared -----------------------------------------------------------------

func writeRefResult(w http.ResponseWriter, r *http.Request, err error, noun string, id uuid.UUID) {
	switch {
	case errors.Is(err, errRefGone):
		httpx.BadRequest(w, r, "no such "+noun+" in this school")
	case errors.Is(err, errRefTaken):
		httpx.BadRequest(w, r, "this school already has a "+noun+" with that name")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": id.String()})
	}
}

// --- academic years ---------------------------------------------------------

type yearPatch struct {
	Name        *string `json:"name,omitempty"`
	StartsOn    *string `json:"starts_on,omitempty"`
	EndsOn      *string `json:"ends_on,omitempty"`
	IsCurrent   *bool   `json:"is_current,omitempty"`
	Board       *string `json:"board,omitempty"`
	WorkingDays *int    `json:"working_days,omitempty"`
}

/*
updateAcademicYear changes the year's dates, its name or which one is current.

	The dates matter more here than anywhere else in this file: the year plan
	pours the syllabus into the teaching days between them, and the working-day
	count is measured across them. Moving them is a legitimate thing to do —
	a school that opened late in March enters the wrong Monday first — and the
	figures that depend on them are computed on read, so they follow.
*/
func (s *Server) updateAcademicYear(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	yearID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid academic year id")
		return
	}
	var req yearPatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Name != nil {
		*req.Name = strings.TrimSpace(*req.Name)
		if *req.Name == "" {
			httpx.BadRequest(w, r, "an academic year needs a name")
			return
		}
	}
	if req.WorkingDays != nil && (*req.WorkingDays < 0 || *req.WorkingDays > 366) {
		httpx.BadRequest(w, r, "working days must be between 0 and 366")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Exactly one current year.

		   is_current is read by every screen that does not name a year, so two
		   of them means half the product is looking at one and half at the
		   other — and nothing would say so. Clearing the others here is the
		   only place that invariant can be kept, because the column has no
		   constraint that can express it. */
		if req.IsCurrent != nil && *req.IsCurrent {
			if _, err := tx.Exec(r.Context(),
				`UPDATE academic_years SET is_current = false WHERE id <> $1`, yearID); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE academic_years
			   SET name         = COALESCE($2, name),
			       starts_on    = COALESCE($3::date, starts_on),
			       ends_on      = COALESCE($4::date, ends_on),
			       is_current   = COALESCE($5, is_current),
			       board        = CASE WHEN $6::text IS NULL THEN board ELSE NULLIF($6,'') END,
			       working_days = COALESCE($7, working_days)
			 WHERE id = $1`,
			yearID, req.Name, req.StartsOn, req.EndsOn, req.IsCurrent,
			req.Board, req.WorkingDays)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errRefGone
		}
		// Checked after the write so the comparison uses the stored values
		// whichever of the two dates was supplied.
		var ok bool
		if err := tx.QueryRow(r.Context(),
			`SELECT ends_on > starts_on FROM academic_years WHERE id = $1`, yearID).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return errRefInUse
		}
		return nil
	})
	if errors.Is(err, errRefInUse) {
		httpx.BadRequest(w, r, "the year has to end after it starts")
		return
	}
	writeRefResult(w, r, err, "academic year", yearID)
}

// --- fee heads --------------------------------------------------------------

type feeHeadPatch struct {
	Name         *string `json:"name,omitempty"`
	Code         *string `json:"code,omitempty"`
	IsRefundable *bool   `json:"is_refundable,omitempty"`
	IsRecurring  *bool   `json:"is_recurring,omitempty"`
}

func (s *Server) updateFeeHead(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	headID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid fee head id")
		return
	}
	var req feeHeadPatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	for _, f := range []**string{&req.Name, &req.Code} {
		if *f != nil {
			**f = strings.TrimSpace(**f)
			if **f == "" {
				httpx.BadRequest(w, r, "a fee head needs both a name and a code")
				return
			}
		}
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE fee_heads
			   SET name          = COALESCE($2, name),
			       code          = COALESCE($3, code),
			       is_refundable = COALESCE($4, is_refundable),
			       is_recurring  = COALESCE($5, is_recurring)
			 WHERE id = $1`,
			headID, req.Name, req.Code, req.IsRefundable, req.IsRecurring)
		if err != nil {
			if strings.Contains(err.Error(), "fee_heads_institution") {
				return errRefTaken
			}
			return err
		}
		if tag.RowsAffected() == 0 {
			return errRefGone
		}
		return nil
	})
	writeRefResult(w, r, err, "fee head", headID)
}

func (s *Server) deleteFeeHead(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	headID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid fee head id")
		return
	}
	var used int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*)::int FROM fee_structure_items WHERE fee_head_id = h.id)
			  FROM fee_heads h WHERE h.id = $1`, headID).Scan(&used); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errRefGone
			}
			return err
		}
		/* A fee head in a structure has been billed.

		   Invoice lines carry the head, and an invoice is a document a family
		   was handed. Deleting the head would leave money collected against a
		   category that no longer exists, which is the one kind of damage in
		   this product that cannot be repaired from inside it. */
		if used > 0 {
			return errRefInUse
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM fee_heads WHERE id = $1`, headID)
		return err
	})
	if errors.Is(err, errRefInUse) {
		httpx.BadRequest(w, r, "this head is in "+plural(used, "fee structure", "fee structures")+
			" and has been billed against. Rename it instead — deleting it would orphan money already collected")
		return
	}
	writeRefResult(w, r, err, "fee head", headID)
}
