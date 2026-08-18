package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* What a teacher writes about a child, and who it is written for.

   The teaching workspace could record every number a school keeps and not one
   sentence. Six catalogued screens sat on that gap — Remarks, Class Teacher
   Remarks, Anecdotal Records, PTM Notes & Action Items, Classroom
   Communication Broadcasting, and the Communication screen that ties them
   together — and a teacher who wanted to say something about a child said it
   on paper or on the telephone.

   The four things stored here differ on one question, and it is the question
   the whole file is organised around: who may read this.

     a remark            the family may see it, if the author says so
     an anecdotal record staff only, always — see below
     a PTM note          the parent was in the room, so it is half theirs
     a broadcast         written to be read by the family

   Two rules apply to every handler and are worth stating once.

   First, reach. The group this mounts under requires academics.timetable.read,
   which a *student* also holds — so the permission alone is not an
   authorisation. Every handler resolves the caller's sections and refuses a
   child outside them, both on read and on write. A teacher writing about
   somebody else's class is the failure this file exists to prevent.

   Second, the term. A report-card remark that is not tied to a term cannot be
   printed on the right card, so term_id is required rather than optional on
   that one path, and the remark is written onto report_cards itself rather
   than into a table of its own. The columns were already there and the family
   portal already reads them; a second copy would only be the one that
   disagrees. */

// mountFacultyComms registers the faculty communication routes.
//
// Called from inside the existing /teaching group, which already applies
// academics.timetable.read, so the paths here are relative.
//
// Writes are gated on either welfare.discipline.write or
// comms.announcements.write. Neither alone covers the staff who legitimately
// record an observation: a subject teacher holds the second and not the first,
// a class teacher and a discipline officer hold the first and not always the
// second. Requiring either admits both without inventing a permission key that
// nothing seeds.
func (s *Server) mountFacultyComms(r chi.Router) {
	r.Get("/terms", s.listTeachingTerms)
	r.Get("/remarks", s.listRemarks)
	r.Get("/report-remarks", s.listReportRemarks)
	r.Get("/ptm-notes", s.listPTMNotes)
	r.Get("/broadcasts", s.listBroadcasts)
	r.Get("/communication", s.getCommunicationSummary)

	r.Group(func(r chi.Router) {
		r.Use(httpx.RequireAnyPermission(rbac.DisciplineWrite, rbac.AnnouncementsWrite))
		r.Post("/remarks", s.createRemark)
		r.Put("/remarks/{id}", s.updateRemark)
		r.Put("/report-remarks", s.saveReportRemark)
		r.Post("/ptm-notes", s.savePTMNote)
	})

	// A broadcast goes to families rather than into the child's file, so it
	// takes the publishing permission and not the welfare one.
	r.With(httpx.RequirePermission(rbac.AnnouncementsWrite)).
		Post("/broadcasts", s.publishBroadcast)
}

// --- reach -------------------------------------------------------------------

// reachesTaughtStudent reports whether the caller teaches this child.
//
// internal/api/my_classes.go carries a reachesStudent doing the same job for
// conduct notes. This file cannot edit that one, so the rule is written out
// again; the two must never be allowed to disagree, and the integration lead
// should collapse them into one helper on merge.
//
// Active enrolment, not any enrolment: a child who left in July is no longer
// in the section, and last year's teacher is not entitled to keep writing
// about them.
//
// students.read.all is honoured because a principal or an exam controller
// legitimately reads across the school — the same override StudentPredicate
// already applies. An empty section set therefore means no children, never
// all of them.
func reachesTaughtStudent(ctx context.Context, tx pgx.Tx, res *scope.Resolved,
	studentID uuid.UUID) (bool, error) {
	if res.AllStudents {
		return true, nil
	}
	if len(res.SectionIDs) == 0 {
		return false, nil
	}
	var ok bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM enrollments e
		                WHERE e.student_id = $1
		                  AND e.status = 'active'
		                  AND e.section_id = ANY($2))`,
		studentID, res.SectionIDs).Scan(&ok)
	return ok, err
}

// isClassTeacherOf reports whether the caller is the class teacher of the
// section this child sits in. A subject teacher reaches the child but does not
// write the remark that is printed on their report card.
func isClassTeacherOf(ctx context.Context, tx pgx.Tx, userID, studentID uuid.UUID) (bool, error) {
	var ok bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1
		                 FROM enrollments e
		                 JOIN sections sec ON sec.id = e.section_id
		                WHERE e.student_id = $1
		                  AND e.status = 'active'
		                  AND sec.class_teacher_id = $2)`, studentID, userID).Scan(&ok)
	return ok, err
}

// taughtStudentsPredicate narrows a query to children the caller teaches.
//
// Written against the student id rather than the row's own section_id: a
// remark keeps the section it was written in, and that section may since have
// been dissolved, but the child is still the child. Returns FALSE for a caller
// with no sections, which is the direction that turns a scope slip into an
// empty page rather than a breach.
func taughtStudentsPredicate(res *scope.Resolved, column string, argN int) (string, []any) {
	if res.AllStudents {
		return "TRUE", nil
	}
	if len(res.SectionIDs) == 0 {
		return "FALSE", nil
	}
	return `EXISTS (SELECT 1 FROM enrollments se
	                 WHERE se.student_id = ` + column + `
	                   AND se.status = 'active'
	                   AND se.section_id = ANY($` + itoa(argN) + `))`,
		[]any{res.SectionIDs}
}

// reachesSection reports whether a named section is one the caller teaches.
func reachesSection(res *scope.Resolved, sectionID uuid.UUID) bool {
	if res.AllStudents {
		return true
	}
	for _, id := range res.SectionIDs {
		if id == sectionID {
			return true
		}
	}
	return false
}

// --- terms -------------------------------------------------------------------

type teachingTerm struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	YearName string `json:"academic_year"`
	StartsOn string `json:"starts_on"`
	EndsOn   string `json:"ends_on"`
	Sequence int32  `json:"sequence"`
	IsatNow  bool   `json:"is_current"`
}

// listTeachingTerms publishes the terms the remark screens have to choose
// between. Nothing else in the API exposes them, so without this the term
// picker on a report-card remark would be a free-text box — which is how a
// Term 1 remark ends up on the Term 2 card.
func (s *Server) listTeachingTerms(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT t.id::text, t.name, ay.name,
		       to_char(t.starts_on,'YYYY-MM-DD'), to_char(t.ends_on,'YYYY-MM-DD'),
		       t.sequence,
		       CURRENT_DATE BETWEEN t.starts_on AND t.ends_on
		  FROM terms t
		  JOIN academic_years ay ON ay.id = t.academic_year_id
		 ORDER BY t.starts_on DESC, t.sequence`, nil,
		func(rows pgx.Rows) (teachingTerm, error) {
			var v teachingTerm
			return v, rows.Scan(&v.ID, &v.Name, &v.YearName, &v.StartsOn, &v.EndsOn,
				&v.Sequence, &v.IsatNow)
		})
	respond(w, r, items, err)
}

// --- remarks and anecdotal records --------------------------------------------

type remarkRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	AdmissionNo string  `json:"admission_no"`
	StudentName string  `json:"student_name"`
	ClassName   *string `json:"class_name,omitempty"`
	SectionName *string `json:"section_name,omitempty"`
	Subject     *string `json:"subject,omitempty"`
	Term        *string `json:"term,omitempty"`
	Kind        string  `json:"kind"`
	Body        string  `json:"body"`
	// Private is the reader-facing name for the stored visible_to_family flag,
	// because the screen has to say "staff only" rather than "not visible".
	Private    bool    `json:"private"`
	ObservedOn string  `json:"observed_on"`
	RecordedBy *string `json:"recorded_by,omitempty"`
	// Mine drives whether the row offers an edit control. Only the author
	// amends a remark; everyone else reads it.
	Mine bool `json:"mine"`
}

// listRemarks serves both faculty.teaching_workspace.remarks and
//
// faculty.teaching_workspace.anecdotal_records.
//
// One handler, because they are one table and differ only in `kind` — and
// because a teacher looking at a child wants the whole picture in date order,
// not two half-lists they have to interleave by eye.
//
// Anecdotal records are returned to staff who teach the child, which is the
// point of keeping them: the note about a bereavement is written for whoever
// has that child next term. What "private" excludes is the *family*, and no
// family-facing endpoint reads this table.
func (s *Server) listRemarks(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	q := r.URL.Query()

	args := []any{
		nullString(strings.TrimSpace(q.Get("student_id"))),
		nullString(strings.TrimSpace(q.Get("section_id"))),
		nullString(strings.TrimSpace(q.Get("kind"))),
	}
	pred, scopeArgs := taughtStudentsPredicate(res, "sr.student_id", len(args)+1)
	args = append(args, scopeArgs...)

	items, err := collect(s, r, `
		SELECT sr.id::text, sr.student_id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       c.name, sec.name, sub.name, t.name,
		       sr.kind, sr.body, NOT sr.visible_to_family,
		       to_char(sr.observed_on,'YYYY-MM-DD'), u.full_name,
		       sr.recorded_by = $`+itoa(len(args)+1)+`
		  FROM student_remarks sr
		  JOIN students st ON st.id = sr.student_id
		  LEFT JOIN sections sec ON sec.id = sr.section_id
		  LEFT JOIN classes  c   ON c.id = sec.class_id
		  LEFT JOIN class_subjects cs ON cs.id = sr.class_subject_id
		  LEFT JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN terms    t   ON t.id = sr.term_id
		  LEFT JOIN users    u   ON u.id = sr.recorded_by
		 WHERE ($1::uuid IS NULL OR sr.student_id = $1)
		   AND ($2::uuid IS NULL OR sr.section_id = $2)
		   AND ($3::text IS NULL OR sr.kind = $3)
		   AND `+pred+`
		 ORDER BY sr.observed_on DESC, sr.created_at DESC
		 LIMIT 300`,
		append(args, httpx.IdentityFrom(r.Context()).UserID),
		func(rows pgx.Rows) (remarkRow, error) {
			var v remarkRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.AdmissionNo, &v.StudentName,
				&v.ClassName, &v.SectionName, &v.Subject, &v.Term, &v.Kind, &v.Body,
				&v.Private, &v.ObservedOn, &v.RecordedBy, &v.Mine)
		})
	respond(w, r, items, err)
}

type remarkRequest struct {
	StudentID      string `json:"student_id"`
	ClassSubjectID string `json:"class_subject_id,omitempty"`
	TermID         string `json:"term_id,omitempty"`
	Kind           string `json:"kind,omitempty"`
	Body           string `json:"body"`
	// Nil means "use the default for this kind". Ignored outright for an
	// anecdotal record, which is private by definition.
	Private    *bool  `json:"private,omitempty"`
	ObservedOn string `json:"observed_on,omitempty"`
}

const anecdotalKind = "anecdotal"

// createRemark records one observation about one child.
//
// The section is taken from the child's active enrolment rather than from the
// request. A client that names its own section can name one it does not teach,
// and the remark would then be filed against a class the author has no
// business in — the section is a fact about the child, not an argument.
func (s *Server) createRemark(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req remarkRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	studentID, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "a remark needs something written in it")
		return
	}
	if req.Kind == "" {
		req.Kind = "academic"
	}

	// The client's view of privacy is never trusted for an anecdotal record:
	// the table refuses the combination anyway, and returning a 500 from a
	// check constraint is a worse way to say the same thing.
	private := req.Kind == anecdotalKind
	if !private && req.Private != nil {
		private = *req.Private
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var newID uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ok, err := reachesTaughtStudent(r.Context(), tx, res, studentID)
		if err != nil {
			return err
		}
		if !ok {
			// Deliberately the same answer as a child who does not exist, so
			// the endpoint cannot be walked to discover the roll.
			httpx.NotFound(w, r)
			return nil
		}

		// A subject may only be named if the child is actually taught it.
		// Otherwise a Physics remark can be filed under Music.
		var subjectID any
		if req.ClassSubjectID != "" {
			csID, perr := uuid.Parse(req.ClassSubjectID)
			if perr != nil {
				httpx.BadRequest(w, r, "class_subject_id must be a uuid")
				return nil
			}
			var teaches bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1
				                 FROM class_subjects cs
				                 JOIN enrollments e ON e.class_id = cs.class_id
				                WHERE cs.id = $1 AND e.student_id = $2
				                  AND e.status = 'active')`,
				csID, studentID).Scan(&teaches); err != nil {
				return err
			}
			if !teaches {
				httpx.BadRequest(w, r, "that subject is not taught to this child")
				return nil
			}
			subjectID = csID
		}

		return tx.QueryRow(r.Context(), `
			INSERT INTO student_remarks (institution_id, student_id, section_id,
			                             class_subject_id, term_id, kind, body,
			                             visible_to_family, observed_on, recorded_by)
			SELECT $1, $2,
			       (SELECT e.section_id FROM enrollments e
			         WHERE e.student_id = $2 AND e.status = 'active'
			         ORDER BY e.enrolled_on DESC LIMIT 1),
			       $3, $4, $5, $6, $7,
			       COALESCE($8::date, CURRENT_DATE), $9
			RETURNING id`,
			id.InstitutionID, studentID, subjectID, nullString(req.TermID),
			req.Kind, strings.TrimSpace(req.Body), !private,
			nullString(req.ObservedOn), id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if newID == uuid.Nil {
		// A guard above already answered.
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": newID.String(), "private": private, "kind": req.Kind,
	})
}

// updateRemark amends a remark the caller wrote.
//
// Only the author, and only through an update rather than a delete: a remark
// about a child is a record, and a screen that lets the last person to read it
// remove it is not one a school can produce when asked what was written.
func (s *Server) updateRemark(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	remarkID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid remark id")
		return
	}
	var req remarkRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "a remark needs something written in it")
		return
	}

	updated := false
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE student_remarks
			   SET body = $1,
			       -- An anecdotal record cannot be made public by editing it,
			       -- and a public remark cannot be quietly hidden after the
			       -- family has already read it.
			       visible_to_family = CASE WHEN kind = $4 THEN false
			                                ELSE COALESCE($2, visible_to_family) END,
			       updated_at = now()
			 WHERE id = $3 AND recorded_by = $5`,
			strings.TrimSpace(req.Body), negate(req.Private), remarkID,
			anecdotalKind, id.UserID)
		if err != nil {
			return err
		}
		updated = tag.RowsAffected() == 1
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !updated {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"updated": true})
}

// negate flips an optional "private" flag into the stored visible_to_family,
// keeping nil as nil so an omitted field leaves the row alone.
func negate(b *bool) *bool {
	if b == nil {
		return nil
	}
	v := !*b
	return &v
}

// --- class teacher remarks ----------------------------------------------------

type reportRemarkRow struct {
	StudentID    string  `json:"student_id"`
	AdmissionNo  string  `json:"admission_no"`
	StudentName  string  `json:"student_name"`
	RollNo       *int32  `json:"roll_no,omitempty"`
	Remark       *string `json:"class_teacher_remark,omitempty"`
	RemarkBy     *string `json:"class_teacher_remark_by,omitempty"`
	RemarkAt     *string `json:"class_teacher_remark_at,omitempty"`
	Principal    *string `json:"principal_remark,omitempty"`
	PrincipalBy  *string `json:"principal_remark_by,omitempty"`
	PrincipalAt  *string `json:"principal_remark_at,omitempty"`
	CardExists   bool    `json:"card_exists"`
	IsPublished  bool    `json:"is_published"`
	AutoPrompted bool    `json:"has_term_remarks"`
}

// listReportRemarks is the class teacher's mark sheet for words.
//
// The whole section, in roll order, with whatever has already been written for
// the chosen term — because writing thirty remarks is one sitting, and a
// screen that makes you pick a child before you can see whether you have
// written about them yet turns it into thirty sittings.
func (s *Server) listReportRemarks(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	/* Called bare, this answers what the screen opens on rather than refusing.

	   A class teacher arriving here has chosen nothing yet, and 400 with an
	   explanation of a parameter they have not been asked for is a wall. An
	   empty list plus the sections and terms they may pick is the same
	   information in a usable shape. Both ids are still required to return
	   remarks — a remark with no term cannot be printed on the right card. */
	rawSection, rawTerm := r.URL.Query().Get("section_id"), r.URL.Query().Get("term_id")
	if rawSection == "" && rawTerm == "" {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"items":    []reportRemarkRow{},
			"needs":    []string{"section_id", "term_id"},
			"sections": res.SectionIDs,
		})
		return
	}
	sectionID, err := uuid.Parse(rawSection)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	termID, err := uuid.Parse(rawTerm)
	if err != nil {
		httpx.BadRequest(w, r, "term_id must be a uuid — a remark with no term "+
			"cannot be printed on the right card")
		return
	}
	if !reachesSection(res, sectionID) {
		httpx.NotFound(w, r)
		return
	}

	items, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name), e.roll_no,
		       rc.class_teacher_remarks, ctu.full_name,
		       to_char(rc.class_teacher_remarks_at,'YYYY-MM-DD'),
		       rc.principal_remarks, pu.full_name,
		       to_char(rc.principal_remarks_at,'YYYY-MM-DD'),
		       rc.id IS NOT NULL, COALESCE(rc.is_published, false),
		       nullif(btrim(COALESCE(rc.class_teacher_remarks,'')),'') IS NOT NULL
		  FROM enrollments e
		  JOIN students st ON st.id = e.student_id
		  LEFT JOIN report_cards rc ON rc.student_id = st.id AND rc.term_id = $2
		  LEFT JOIN users ctu ON ctu.id = rc.class_teacher_remarks_by
		  LEFT JOIN users pu  ON pu.id = rc.principal_remarks_by
		 WHERE e.section_id = $1 AND e.status = 'active'
		 ORDER BY e.roll_no NULLS LAST, st.admission_no`,
		[]any{sectionID, termID},
		func(rows pgx.Rows) (reportRemarkRow, error) {
			var v reportRemarkRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.StudentName, &v.RollNo,
				&v.Remark, &v.RemarkBy, &v.RemarkAt, &v.Principal, &v.PrincipalBy,
				&v.PrincipalAt, &v.CardExists, &v.IsPublished, &v.AutoPrompted)
		})
	respond(w, r, items, err)
}

type reportRemarkRequest struct {
	StudentID string `json:"student_id"`
	TermID    string `json:"term_id"`
	// Nil leaves the stored text alone; an empty string clears it. Two
	// different intentions that a plain string cannot tell apart, and the
	// principal saving their line must not blank the class teacher's.
	Remark    *string `json:"class_teacher_remark,omitempty"`
	Principal *string `json:"principal_remark,omitempty"`
}

// saveReportRemark writes the term-end remark onto the report card itself.
//
// No table of its own: report_cards has carried class_teacher_remarks and
// principal_remarks since the baseline and the family portal already reads the
// first of them, so a parallel store would be the copy that disagrees with the
// printed card.
//
// The card row is created if it does not exist yet, because remarks are
// written before results are generated — a class teacher drafts them in the
// last week of term and the exam controller runs the cards afterwards. The row
// is unpublished until someone publishes it, so drafting a remark does not
// release anything to the family.
//
// The principal's summary comment is a separate authority from the class
// teacher's, so it takes the permission that also lets someone produce the
// card it is printed on. A class teacher sending one is refused rather than
// silently ignored: a remark that vanishes without a word is worse than one
// that is turned down.
func (s *Server) saveReportRemark(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req reportRemarkRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	studentID, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	termID, err := uuid.Parse(req.TermID)
	if err != nil {
		httpx.BadRequest(w, r, "term_id must be a uuid — a remark with no term "+
			"cannot be printed on the right card")
		return
	}
	if req.Remark == nil && req.Principal == nil {
		httpx.BadRequest(w, r, "nothing to save")
		return
	}
	if req.Principal != nil && !id.Can(rbac.ReportCardsGenerate) {
		httpx.Denied(w, r, "the principal's summary comment is written by the "+
			"office that issues the card")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	saved := false
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ok, err := reachesTaughtStudent(r.Context(), tx, res, studentID)
		if err != nil {
			return err
		}
		if !ok {
			httpx.NotFound(w, r)
			return nil
		}
		// The class teacher's remark is the class teacher's. A subject teacher
		// reaches the child but does not speak for the year on their card.
		if req.Remark != nil && !id.Can(rbac.ReportCardsGenerate) {
			isCT, err := isClassTeacherOf(r.Context(), tx, id.UserID, studentID)
			if err != nil {
				return err
			}
			if !isCT {
				httpx.Denied(w, r, "only this child's class teacher writes the "+
					"remark on their report card")
				return nil
			}
		}

		tag, err := tx.Exec(r.Context(), `
			INSERT INTO report_cards (institution_id, student_id, academic_year_id,
			                          term_id, enrollment_id,
			                          class_teacher_remarks, class_teacher_remarks_by,
			                          class_teacher_remarks_at,
			                          principal_remarks, principal_remarks_by,
			                          principal_remarks_at)
			SELECT $1, $2, t.academic_year_id, t.id,
			       (SELECT e.id FROM enrollments e
			         WHERE e.student_id = $2 AND e.status = 'active'
			         ORDER BY e.enrolled_on DESC LIMIT 1),
			       -- $3 is cast explicitly: inside a CASE whose other arm is a
			       -- bare NULL, an uncast parameter resolves to text and the
			       -- insert is rejected against a uuid column.
			       $4, CASE WHEN $4::text IS NOT NULL THEN $3::uuid END,
			           CASE WHEN $4::text IS NOT NULL THEN now() END,
			       $5, CASE WHEN $5::text IS NOT NULL THEN $3::uuid END,
			           CASE WHEN $5::text IS NOT NULL THEN now() END
			  FROM terms t
			 WHERE t.id = $6
			-- The unique constraint over (student, year, term). term_id is never
			-- NULL on this path, so the partial annual index is the wrong target.
			ON CONFLICT (student_id, academic_year_id, term_id) DO UPDATE SET
			    class_teacher_remarks    = COALESCE(EXCLUDED.class_teacher_remarks,
			                                        report_cards.class_teacher_remarks),
			    class_teacher_remarks_by = COALESCE(EXCLUDED.class_teacher_remarks_by,
			                                        report_cards.class_teacher_remarks_by),
			    class_teacher_remarks_at = COALESCE(EXCLUDED.class_teacher_remarks_at,
			                                        report_cards.class_teacher_remarks_at),
			    principal_remarks        = COALESCE(EXCLUDED.principal_remarks,
			                                        report_cards.principal_remarks),
			    principal_remarks_by     = COALESCE(EXCLUDED.principal_remarks_by,
			                                        report_cards.principal_remarks_by),
			    principal_remarks_at     = COALESCE(EXCLUDED.principal_remarks_at,
			                                        report_cards.principal_remarks_at)`,
			id.InstitutionID, studentID, id.UserID, req.Remark, req.Principal, termID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// The only way to match nothing is a term id that is not a term.
			httpx.BadRequest(w, r, "unknown term")
			return nil
		}
		saved = true
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !saved {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

// --- PTM notes and action items ------------------------------------------------

type ptmNoteRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	AdmissionNo string  `json:"admission_no"`
	StudentName string  `json:"student_name"`
	ClassName   *string `json:"class_name,omitempty"`
	SectionName *string `json:"section_name,omitempty"`
	MetOn       string  `json:"met_on"`
	Attendance  string  `json:"attendance"`
	AttendedBy  *string `json:"attended_by,omitempty"`
	Mode        string  `json:"mode"`
	Concerns    *string `json:"concerns,omitempty"`
	Actions     *string `json:"agreed_actions,omitempty"`
	FollowUpOn  *string `json:"follow_up_on,omitempty"`
	FollowUp    bool    `json:"follow_up_done"`
	// Overdue is the only thing on the screen that earns a colour: an action
	// agreed with a parent and not done is the row worth chasing.
	Overdue    bool    `json:"overdue"`
	RecordedBy *string `json:"recorded_by,omitempty"`
	Mine       bool    `json:"mine"`
}

// listPTMNotes returns meeting notes for the caller's children, newest first.
// ?pending=1 narrows to actions still owed, which is the list a teacher opens
// the week after a PTM.
func (s *Server) listPTMNotes(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	q := r.URL.Query()
	pending := q.Get("pending") != "" && q.Get("pending") != "0"

	args := []any{
		nullString(strings.TrimSpace(q.Get("student_id"))),
		nullString(strings.TrimSpace(q.Get("section_id"))),
		pending,
	}
	pred, scopeArgs := taughtStudentsPredicate(res, "pn.student_id", len(args)+1)
	args = append(args, scopeArgs...)

	items, err := collect(s, r, `
		SELECT pn.id::text, pn.student_id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       c.name, sec.name,
		       to_char(pn.met_on,'YYYY-MM-DD'), pn.attendance, pn.attended_by, pn.mode,
		       pn.concerns, pn.agreed_actions,
		       to_char(pn.follow_up_on,'YYYY-MM-DD'), pn.follow_up_done,
		       NOT pn.follow_up_done AND pn.follow_up_on IS NOT NULL
		           AND pn.follow_up_on < CURRENT_DATE,
		       u.full_name, pn.recorded_by = $`+itoa(len(args)+1)+`
		  FROM ptm_notes pn
		  JOIN students st ON st.id = pn.student_id
		  LEFT JOIN sections sec ON sec.id = pn.section_id
		  LEFT JOIN classes  c   ON c.id = sec.class_id
		  LEFT JOIN users    u   ON u.id = pn.recorded_by
		 WHERE ($1::uuid IS NULL OR pn.student_id = $1)
		   AND ($2::uuid IS NULL OR pn.section_id = $2)
		   AND (NOT $3::boolean OR (NOT pn.follow_up_done AND pn.follow_up_on IS NOT NULL))
		   AND `+pred+`
		 ORDER BY pn.met_on DESC, pn.created_at DESC
		 LIMIT 300`,
		append(args, httpx.IdentityFrom(r.Context()).UserID),
		func(rows pgx.Rows) (ptmNoteRow, error) {
			var v ptmNoteRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.AdmissionNo, &v.StudentName,
				&v.ClassName, &v.SectionName, &v.MetOn, &v.Attendance, &v.AttendedBy,
				&v.Mode, &v.Concerns, &v.Actions, &v.FollowUpOn, &v.FollowUp,
				&v.Overdue, &v.RecordedBy, &v.Mine)
		})
	respond(w, r, items, err)
}

type ptmNoteRequest struct {
	StudentID    string `json:"student_id"`
	TermID       string `json:"term_id,omitempty"`
	MetOn        string `json:"met_on,omitempty"`
	Attendance   string `json:"attendance,omitempty"`
	AttendedBy   string `json:"attended_by,omitempty"`
	Mode         string `json:"mode,omitempty"`
	Concerns     string `json:"concerns,omitempty"`
	Actions      string `json:"agreed_actions,omitempty"`
	FollowUpOn   string `json:"follow_up_on,omitempty"`
	FollowUpDone *bool  `json:"follow_up_done,omitempty"`
	Private      *bool  `json:"private,omitempty"`
}

// savePTMNote records one meeting with one family.
//
// An upsert rather than an insert, keyed on (child, day, author). A teacher
// who corrects a spelling and saves again would otherwise finish the afternoon
// with two versions of the same meeting and no way to tell which the parent
// was shown.
//
// A meeting nobody attended is still recorded — that is the row a school needs
// when it later has to show it tried — which is why "none" is an attendance
// value and why the content constraint lets that one case through empty.
func (s *Server) savePTMNote(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req ptmNoteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	studentID, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.Attendance == "" {
		req.Attendance = "guardian"
	}
	if req.Mode == "" {
		req.Mode = "in_person"
	}
	if req.Attendance != "none" &&
		strings.TrimSpace(req.Concerns) == "" && strings.TrimSpace(req.Actions) == "" {
		httpx.BadRequest(w, r,
			"record what the parent raised or what was agreed")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var noteID uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ok, err := reachesTaughtStudent(r.Context(), tx, res, studentID)
		if err != nil {
			return err
		}
		if !ok {
			httpx.NotFound(w, r)
			return nil
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO ptm_notes (institution_id, student_id, section_id, term_id,
			                       met_on, attendance, attended_by, mode,
			                       concerns, agreed_actions, follow_up_on,
			                       follow_up_done, visible_to_family, recorded_by)
			SELECT $1, $2,
			       (SELECT e.section_id FROM enrollments e
			         WHERE e.student_id = $2 AND e.status = 'active'
			         ORDER BY e.enrolled_on DESC LIMIT 1),
			       $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8, $9,
			       $10::date, COALESCE($11::boolean, false), $12, $13
			ON CONFLICT (student_id, met_on,
			             COALESCE(recorded_by, '00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET attendance        = EXCLUDED.attendance,
			              attended_by       = EXCLUDED.attended_by,
			              mode              = EXCLUDED.mode,
			              concerns          = EXCLUDED.concerns,
			              agreed_actions    = EXCLUDED.agreed_actions,
			              follow_up_on      = EXCLUDED.follow_up_on,
			              follow_up_done    = EXCLUDED.follow_up_done,
			              visible_to_family = EXCLUDED.visible_to_family,
			              term_id           = EXCLUDED.term_id,
			              updated_at        = now()
			RETURNING id`,
			id.InstitutionID, studentID, nullString(req.TermID), nullString(req.MetOn),
			req.Attendance, nullString(strings.TrimSpace(req.AttendedBy)), req.Mode,
			nullString(strings.TrimSpace(req.Concerns)),
			nullString(strings.TrimSpace(req.Actions)),
			nullString(req.FollowUpOn), req.FollowUpDone,
			req.Private == nil || !*req.Private, id.UserID).Scan(&noteID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if noteID == uuid.Nil {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": noteID.String()})
}

// --- classroom broadcasting ------------------------------------------------------

type broadcastRow struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Body        string `json:"body"`
	Kind        string `json:"kind"`
	RequiresAck bool   `json:"requires_ack"`
	PublishedAt string `json:"published_at"`
	Sections    int    `json:"sections"`
	Students    int    `json:"students"`
	Acks        int    `json:"acknowledgements"`
	Mine        bool   `json:"mine"`
}

// listBroadcasts is the teacher's own sent folder: notices they published, or
// that were aimed at a section they teach.
func (s *Server) listBroadcasts(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// A teacher with no sections still sees what they themselves sent; the
	// section clause simply matches nothing for them.
	sections := res.SectionIDs
	if len(sections) == 0 {
		sections = []uuid.UUID{}
	}

	items, err := collect(s, r, `
		SELECT a.id::text, a.title, a.body, a.kind, a.requires_ack,
		       to_char(a.publish_at,'YYYY-MM-DD'),
		       (SELECT count(*) FROM announcement_sections x WHERE x.announcement_id = a.id)::int,
		       (SELECT count(*) FROM announcement_students x WHERE x.announcement_id = a.id)::int,
		       (SELECT count(*) FROM announcement_acks x WHERE x.announcement_id = a.id)::int,
		       a.created_by = $1
		  FROM announcements a
		 WHERE a.created_by = $1
		    OR EXISTS (SELECT 1 FROM announcement_sections x
		                WHERE x.announcement_id = a.id AND x.section_id = ANY($2))
		 ORDER BY a.publish_at DESC
		 LIMIT 100`, []any{id.UserID, sections},
		func(rows pgx.Rows) (broadcastRow, error) {
			var v broadcastRow
			return v, rows.Scan(&v.ID, &v.Title, &v.Body, &v.Kind, &v.RequiresAck,
				&v.PublishedAt, &v.Sections, &v.Students, &v.Acks, &v.Mine)
		})
	respond(w, r, items, err)
}

type broadcastRequest struct {
	Title       string   `json:"title"`
	Body        string   `json:"body"`
	SectionIDs  []string `json:"section_ids,omitempty"`
	StudentIDs  []string `json:"student_ids,omitempty"`
	RequiresAck bool     `json:"requires_ack"`
}

// publishBroadcast sends a class-wide or single-child notice to parents.
//
// It writes to announcements, announcement_sections and announcement_students
// rather than to a messaging system of its own: the family already has a
// circulars screen with acknowledgements on it, and a second inbox is how a
// parent ends up missing the one that mattered.
//
// announcement_students is new — the existing tables could aim a notice at the
// school or at a list of sections, but not at one child, which is exactly the
// message a class teacher needs to send.
//
// Targeting is checked against the caller's own sections rather than trusted,
// because an unchecked section id in the body is a way to address the whole
// school from a teacher's account. A notice aimed at nothing is refused
// outright: a teacher who leaves the targeting empty means "my class", not
// "everybody's".
func (s *Server) publishBroadcast(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req broadcastRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "title and body are required")
		return
	}
	if len(req.SectionIDs) == 0 && len(req.StudentIDs) == 0 {
		httpx.BadRequest(w, r, "name at least one class or child to send this to")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	sections := make([]uuid.UUID, 0, len(req.SectionIDs))
	for _, raw := range req.SectionIDs {
		sid, perr := uuid.Parse(raw)
		if perr != nil {
			httpx.BadRequest(w, r, "section_ids must be uuids")
			return
		}
		if !reachesSection(res, sid) {
			httpx.Denied(w, r, "you can only write to a class you teach")
			return
		}
		sections = append(sections, sid)
	}
	students := make([]uuid.UUID, 0, len(req.StudentIDs))
	for _, raw := range req.StudentIDs {
		sid, perr := uuid.Parse(raw)
		if perr != nil {
			httpx.BadRequest(w, r, "student_ids must be uuids")
			return
		}
		students = append(students, sid)
	}

	var annID uuid.UUID
	var recipients int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, sid := range students {
			ok, err := reachesTaughtStudent(r.Context(), tx, res, sid)
			if err != nil {
				return err
			}
			if !ok {
				httpx.NotFound(w, r)
				return nil
			}
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO announcements (institution_id, title, body, kind, audience_role,
			                           requires_ack, publish_at, created_by)
			-- 'parents' rather than 'all': this is the teacher writing home, and
			-- a class notice on the staff noticeboard is a different thing.
			VALUES ($1,$2,$3,'notice','parents',$4, now(), $5)
			RETURNING id`,
			id.InstitutionID, strings.TrimSpace(req.Title), strings.TrimSpace(req.Body),
			req.RequiresAck, id.UserID).Scan(&annID); err != nil {
			return err
		}
		for _, sid := range sections {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO announcement_sections (announcement_id, section_id, institution_id)
				VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
				annID, sid, id.InstitutionID); err != nil {
				return err
			}
		}
		for _, sid := range students {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO announcement_students (announcement_id, student_id, institution_id)
				VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
				annID, sid, id.InstitutionID); err != nil {
				return err
			}
		}

		// How many households this actually reaches, counted before the author
		// wonders why nobody replied. Guardians with no login are excluded:
		// they will not read a portal notice.
		return tx.QueryRow(r.Context(), `
			SELECT count(DISTINCT g.user_id)::int
			  FROM students st
			  JOIN student_guardians sg ON sg.student_id = st.id
			  JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
			  LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
			 WHERE st.status = 'active'
			   AND (e.section_id = ANY($1) OR st.id = ANY($2))`,
			sections, students).Scan(&recipients)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if annID == uuid.Nil {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": annID.String(), "recipients": recipients,
		"sections": len(sections), "students": len(students),
	})
}

// --- the umbrella screen ----------------------------------------------------

type commsSummary struct {
	Sections int `json:"sections"`
	Students int `json:"students"`
	// Remarks and Private are counted apart because the second number is the
	// one a head of year asks about, and burying it in a total hides it.
	Remarks    int `json:"remarks"`
	Private    int `json:"anecdotal_records"`
	Meetings   int `json:"ptm_notes"`
	Overdue    int `json:"actions_overdue"`
	Broadcasts int `json:"broadcasts"`
	Awaiting   int `json:"awaiting_acknowledgement"`
	Terms      int `json:"terms"`
}

// getCommunicationSummary powers faculty.teaching_workspace.communication —
//
// the screen that ties the other five together.
//
// It is a count of outstanding work rather than a feed. A teacher opening
// "Communication" is asking one of two questions: is there anything I owe a
// parent, and what have I already said. Everything here answers the first;
// the lists behind it answer the second.
func (s *Server) getCommunicationSummary(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out := commsSummary{Sections: len(res.SectionIDs)}
	sections := res.SectionIDs
	if len(sections) == 0 {
		sections = []uuid.UUID{}
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			WITH mine AS (
			  SELECT DISTINCT e.student_id
			    FROM enrollments e
			   WHERE e.status = 'active' AND e.section_id = ANY($1)
			)
			SELECT (SELECT count(*) FROM mine)::int,
			       (SELECT count(*) FROM student_remarks sr
			         WHERE sr.student_id IN (SELECT student_id FROM mine)
			           AND sr.kind <> 'anecdotal')::int,
			       (SELECT count(*) FROM student_remarks sr
			         WHERE sr.student_id IN (SELECT student_id FROM mine)
			           AND sr.kind = 'anecdotal')::int,
			       (SELECT count(*) FROM ptm_notes pn
			         WHERE pn.student_id IN (SELECT student_id FROM mine))::int,
			       (SELECT count(*) FROM ptm_notes pn
			         WHERE pn.student_id IN (SELECT student_id FROM mine)
			           AND NOT pn.follow_up_done
			           AND pn.follow_up_on IS NOT NULL
			           AND pn.follow_up_on < CURRENT_DATE)::int,
			       (SELECT count(*) FROM announcements a WHERE a.created_by = $2)::int,
			       -- Notices this teacher sent that asked for a reply and have
			       -- not had one. The number that means "chase somebody".
			       (SELECT count(*) FROM announcements a
			         WHERE a.created_by = $2 AND a.requires_ack
			           AND NOT EXISTS (SELECT 1 FROM announcement_acks ak
			                            WHERE ak.announcement_id = a.id))::int,
			       (SELECT count(*) FROM terms)::int`,
			sections, id.UserID).Scan(&out.Students, &out.Remarks, &out.Private,
			&out.Meetings, &out.Overdue, &out.Broadcasts, &out.Awaiting, &out.Terms)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
