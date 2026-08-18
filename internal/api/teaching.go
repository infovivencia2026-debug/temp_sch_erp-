package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* The teaching workspace: setting work, sharing material, running a live class,
   banking questions, and both halves of CCE.

   Two rules shape every handler below, and both come from where this file is
   mounted. The /teaching group is gated on academics.timetable.read, which a
   student also holds — so the gate proves nothing about who is calling. Every
   write therefore names a second permission that only a teacher has, and every
   read narrows to the sections the caller actually teaches rather than trusting
   the group.

   The second rule is that nothing here re-implements a table that exists.
   Assignments are homework and homework_submissions; the study material library
   and the LMS upload are both study_materials; the summative half of CCE is
   exams -> exam_subjects -> marks. Only the question bank, the online test, the
   live-class record and the formative half of CCE needed schema, and they are
   the only things migration 00041 adds.

   Reach is decided by reachesTaughtStudent from faculty_comms.go, not by
   reachesStudent from my_classes.go. The two disagree: reachesStudent goes
   through scope.StudentPredicate, which matches an enrolment in any state, so a
   child who left in July still resolves for last year's teacher. The one used
   here requires enrollments.status = 'active'. That is the stricter of the two
   and the only defensible reading — a teacher's authority over a child ends
   when the child leaves the section, and marks and formative observations are
   exactly the records that must not keep accruing afterwards. */

func (s *Server) mountTeaching(r chi.Router) {
	// Reads. Each handler narrows to the caller's own sections; the group's
	// timetable.read permission is not evidence of anything on its own.
	r.Get("/subjects", s.listTeachingSubjects)
	r.Get("/assignments", s.listTeachingAssignments)
	r.Get("/assignments/{id}/submissions", s.listAssignmentSubmissions)
	r.Get("/materials", s.listTeachingMaterials)
	r.Get("/virtual-classes", s.listVirtualClasses)
	r.Get("/virtual-classes/providers", s.listVirtualClassProviders)
	r.Get("/question-bank", s.listBankQuestions)
	r.Get("/question-bank/summary", s.getBankSummary)
	r.Get("/question-bank/{id}", s.getBankQuestion)
	r.Get("/online-tests", s.listOnlineTests)
	r.Get("/online-tests/{id}", s.getOnlineTest)
	r.Get("/cce/formative", s.listFormativeEntries)
	r.Get("/cce/summative", s.listSummativePapers)
	r.Get("/cce/summative/roster", s.listSummativeRoster)

	/* Setting work, sharing material and scheduling a class are all the same
	   authority — academics.homework.write, which faculty and class teachers
	   hold and students do not.

	   The question bank and the online test are gated on it too, and not on
	   academics.exams.write, which would read better. Faculty does not hold
	   exams.write: it belongs to the examination controller, who sets the
	   board timetable. Gating a screen the catalogue scopes to
	   assigned_classes on a permission the assigned teacher lacks would leave
	   the two screens reachable only by the one role that has no use for them.
	   A teacher banking questions for their own class is setting work, and
	   that is the permission for it. */
	r.Group(func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.HomeworkWrite))
		r.Post("/assignments/{id}/grade", s.gradeAssignmentSubmissions)
		r.Post("/materials", s.createTeachingMaterial)
		r.Put("/materials/{id}", s.updateTeachingMaterial)
		r.Post("/virtual-classes", s.scheduleVirtualClass)
		r.Put("/virtual-classes/{id}", s.updateVirtualClass)
		r.Post("/virtual-classes/{id}/launch", s.launchVirtualClass)
		r.Post("/question-bank", s.createBankQuestion)
		r.Put("/question-bank/{id}", s.updateBankQuestion)
		r.Delete("/question-bank/{id}", s.retireBankQuestion)
		r.Post("/online-tests", s.createOnlineTest)
		r.Put("/online-tests/{id}", s.updateOnlineTest)
		r.Put("/online-tests/{id}/questions", s.setOnlineTestQuestions)
	})

	// Marks are a different authority from homework: a teacher may set work
	// without being trusted to enter the term's marks, and academics.marks.write
	// is the permission a school revokes when it wants exactly that.
	r.Group(func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.MarksWrite))
		r.Put("/cce/formative", s.saveFormativeEntries)
		r.Put("/cce/summative", s.saveSummativeMarks)
	})

	// Connecting the school's Zoom or Workspace account is an institution
	// integration, not a teaching act. A teacher launches meetings; they do not
	// choose which account the school hosts them on.
	r.With(httpx.RequirePermission(rbac.IntegrationsWrite)).
		Post("/virtual-classes/providers", s.saveVirtualClassProvider)
}

// --- shared narrowing ---------------------------------------------------------

/*
taughtSubjectsPredicate narrows to class-subjects the caller actually teaches.

	A class_subject is reachable when the caller is timetabled for it in one of
	their sections, or is class teacher of a section studying it. Written as a
	predicate over the class_subjects alias so every list can drop it in.

	Returns FALSE for a caller with no sections. That is the safe direction: a
	scope that failed to resolve shows an empty page rather than the school.
*/
func taughtSubjectsPredicate(res *scope.Resolved, alias string, argN int) (string, []any) {
	if res.AllStudents {
		return "TRUE", nil
	}
	if len(res.SectionIDs) == 0 {
		return "FALSE", nil
	}
	return `EXISTS (SELECT 1 FROM sections tsec
	                 WHERE tsec.id = ANY($` + itoa(argN) + `)
	                   AND tsec.class_id = ` + alias + `.class_id)`,
		[]any{res.SectionIDs}
}

var errNotTaught = errors.New("not a class the caller teaches")

// requireTaughtSection rejects a write aimed at somebody else's section.
//
// Answers 404 rather than 403 on purpose where the caller could otherwise walk
// the endpoint to learn which sections exist; the callers below choose which,
// depending on whether the id was already visible to them.
func requireTaughtSection(res *scope.Resolved, sectionID uuid.UUID) error {
	if !reachesSection(res, sectionID) {
		return errNotTaught
	}
	return nil
}

// classSubjectSection resolves the section a class-subject is taught in for this
// caller, so a write naming only a class_subject_id can still be scope-checked.
func classSubjectTaught(ctx context.Context, tx pgx.Tx, res *scope.Resolved,
	csID uuid.UUID) (bool, error) {
	if res.AllStudents {
		return true, nil
	}
	if len(res.SectionIDs) == 0 {
		return false, nil
	}
	var ok bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1
		                 FROM class_subjects cs
		                 JOIN sections sec ON sec.class_id = cs.class_id
		                WHERE cs.id = $1 AND sec.id = ANY($2))`,
		csID, res.SectionIDs).Scan(&ok)
	return ok, err
}

type teachingSubject struct {
	ClassSubjectID string `json:"class_subject_id"`
	ClassID        string `json:"class_id"`
	ClassName      string `json:"class_name"`
	Subject        string `json:"subject"`
	SubjectCode    string `json:"subject_code"`
	IsScholastic   bool   `json:"is_scholastic"`
	MaxMarks       int32  `json:"max_marks"`
}

// listTeachingSubjects is the picker every screen in this file needs: the
// class-subjects this teacher may act on, and nothing else. Without it each
// screen would fall back to the setup endpoint, which lists the whole school.
func (s *Server) listTeachingSubjects(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	where, args := taughtSubjectsPredicate(res, "cs", 1)
	items, err := collect(s, r, `
		SELECT cs.id::text, cs.class_id::text, c.name, sub.name, sub.code,
		       sub.is_scholastic, cs.max_marks
		  FROM class_subjects cs
		  JOIN classes  c   ON c.id = cs.class_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		 WHERE `+where+`
		 ORDER BY c.level, sub.name`, args,
		func(rows pgx.Rows) (teachingSubject, error) {
			var v teachingSubject
			return v, rows.Scan(&v.ClassSubjectID, &v.ClassID, &v.ClassName, &v.Subject,
				&v.SubjectCode, &v.IsScholastic, &v.MaxMarks)
		})
	respond(w, r, items, err)
}

// --- assignments and submissions ----------------------------------------------

/* Deliberately no create endpoint here.

   POST /api/v1/homework already sets work, already gated on the same
   academics.homework.write, and the parent and student portals already read
   what it writes. The screen posts there. What the product was missing is
   everything after the child hands the work in: who has submitted, who has not,
   and the mark and the feedback. That is what this section adds. */

type teachingAssignment struct {
	ID           string   `json:"id"`
	SectionID    string   `json:"section_id"`
	SectionName  string   `json:"section"`
	ClassName    string   `json:"class_name"`
	Subject      *string  `json:"subject,omitempty"`
	Kind         string   `json:"kind"`
	Title        string   `json:"title"`
	Instructions *string  `json:"instructions,omitempty"`
	AssignedOn   string   `json:"assigned_on"`
	DueOn        *string  `json:"due_on,omitempty"`
	MaxMarks     *float64 `json:"max_marks,omitempty"`
	IsPublished  bool     `json:"is_published"`
	AllowSubmit  bool     `json:"allow_submission"`

	Roll      int32 `json:"roll"`
	Submitted int32 `json:"submitted"`
	Graded    int32 `json:"graded"`
	// Outstanding is the number a teacher is actually looking for: handed in
	// and still waiting on them. Computed rather than stored because a mark
	// entered on one screen must not leave a counter stale on another.
	AwaitingMarking int32 `json:"awaiting_marking"`
	Overdue         bool  `json:"overdue"`
}

func (s *Server) listTeachingAssignments(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// A bare GET is the whole of the caller's teaching, most recent first —
	// useful without a single query parameter.
	sectionFilter := "TRUE"
	args := []any{res.SectionIDs}
	if res.AllStudents {
		sectionFilter = "TRUE"
		args = []any{[]uuid.UUID{}}
	} else {
		sectionFilter = "h.section_id = ANY($1)"
	}
	if q := strings.TrimSpace(r.URL.Query().Get("section_id")); q != "" {
		sec, perr := uuid.Parse(q)
		if perr != nil {
			httpx.BadRequest(w, r, "section_id must be a uuid")
			return
		}
		if err := requireTaughtSection(res, sec); err != nil {
			httpx.Forbidden(w, r, "assignments for this section")
			return
		}
		args = append(args, sec)
		sectionFilter += " AND h.section_id = $" + itoa(len(args))
	}

	items, err := collect(s, r, `
		SELECT h.id::text, h.section_id::text, sec.name, c.name, sub.name,
		       h.kind, h.title, h.instructions,
		       to_char(h.assigned_on,'YYYY-MM-DD'), to_char(h.due_on,'YYYY-MM-DD'),
		       h.max_marks, h.is_published, h.allow_submission,
		       (SELECT count(*) FROM enrollments e
		         WHERE e.section_id = h.section_id AND e.status = 'active')::int,
		       (SELECT count(*) FROM homework_submissions hs
		         WHERE hs.homework_id = h.id
		           AND hs.status IN ('submitted','late','graded'))::int,
		       (SELECT count(*) FROM homework_submissions hs
		         WHERE hs.homework_id = h.id AND hs.status = 'graded')::int,
		       (SELECT count(*) FROM homework_submissions hs
		         WHERE hs.homework_id = h.id
		           AND hs.status IN ('submitted','late'))::int,
		       (h.due_on IS NOT NULL AND h.due_on < CURRENT_DATE)
		  FROM homework h
		  JOIN sections sec ON sec.id = h.section_id
		  JOIN classes    c ON c.id = sec.class_id
		  LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id
		  LEFT JOIN subjects      sub ON sub.id = cs.subject_id
		 WHERE `+sectionFilter+`
		 ORDER BY h.assigned_on DESC, h.created_at DESC
		 LIMIT 200`, args,
		func(rows pgx.Rows) (teachingAssignment, error) {
			var v teachingAssignment
			return v, rows.Scan(&v.ID, &v.SectionID, &v.SectionName, &v.ClassName,
				&v.Subject, &v.Kind, &v.Title, &v.Instructions, &v.AssignedOn,
				&v.DueOn, &v.MaxMarks, &v.IsPublished, &v.AllowSubmit,
				&v.Roll, &v.Submitted, &v.Graded, &v.AwaitingMarking, &v.Overdue)
		})
	respond(w, r, items, err)
}

type submissionRow struct {
	StudentID   string `json:"student_id"`
	AdmissionNo string `json:"admission_no"`
	Name        string `json:"full_name"`
	RollNo      *int32 `json:"roll_no,omitempty"`
	// SubmissionID is null until the child hands something in; the row still
	// appears, because "who has not submitted" is the question being asked.
	SubmissionID *string  `json:"submission_id,omitempty"`
	Status       string   `json:"status"`
	SubmittedAt  *string  `json:"submitted_at,omitempty"`
	TextAnswer   *string  `json:"text_answer,omitempty"`
	FileID       *string  `json:"file_id,omitempty"`
	Marks        *float64 `json:"marks,omitempty"`
	Feedback     *string  `json:"feedback,omitempty"`
	GradedBy     *string  `json:"graded_by,omitempty"`
	GradedAt     *string  `json:"graded_at,omitempty"`
	Late         bool     `json:"late"`
}

// listAssignmentSubmissions returns the whole section, not only those who
// submitted: a marking screen that lists submissions only can never show the
// teacher who is missing.
func (s *Server) listAssignmentSubmissions(w http.ResponseWriter, r *http.Request) {
	hwID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid assignment id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var section uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT section_id FROM homework WHERE id = $1`, hwID).Scan(&section)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if rerr := requireTaughtSection(res, section); rerr != nil {
		// Same answer as an assignment that does not exist: a teacher must not
		// be able to confirm another section's work by its id.
		httpx.NotFound(w, r)
		return
	}

	items, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.last_name), e.roll_no,
		       hs.id::text, COALESCE(hs.status,'pending'),
		       to_char(hs.submitted_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       hs.text_answer, hs.file_id::text, hs.marks, hs.feedback,
		       u.full_name,
		       to_char(hs.graded_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       COALESCE(hs.status = 'late', false)
		  FROM enrollments e
		  JOIN students st ON st.id = e.student_id
		  LEFT JOIN homework_submissions hs
		         ON hs.homework_id = $1 AND hs.student_id = st.id
		  LEFT JOIN users u ON u.id = hs.graded_by
		 WHERE e.section_id = $2 AND e.status = 'active'
		 ORDER BY e.roll_no NULLS LAST, st.first_name`,
		[]any{hwID, section},
		func(rows pgx.Rows) (submissionRow, error) {
			var v submissionRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.Name, &v.RollNo,
				&v.SubmissionID, &v.Status, &v.SubmittedAt, &v.TextAnswer,
				&v.FileID, &v.Marks, &v.Feedback, &v.GradedBy, &v.GradedAt, &v.Late)
		})
	respond(w, r, items, err)
}

type gradeRequest struct {
	Entries []struct {
		StudentID string   `json:"student_id"`
		Marks     *float64 `json:"marks"`
		Feedback  string   `json:"feedback,omitempty"`
		// Status lets a teacher send work back without marking it. Empty means
		// "graded", which is what filling in a mark implies.
		Status string `json:"status,omitempty"`
	} `json:"entries"`
}

var errGradeAboveMax = errors.New("a mark above the assignment maximum")

/*
gradeAssignmentSubmissions marks a batch of hand-ins in one transaction.

	Upserts rather than updates, because a teacher marking on paper wants to
	record a mark for a child whose submission row does not exist yet — work
	handed in physically still gets a mark, and refusing it would push the
	school back to a spreadsheet.

	Every child in the batch is checked against the caller's reach individually.
	Checking only the assignment's section would be enough today, but a batch is
	a list of student ids from a client and the day one of them is not in that
	section is the day the check has to be per child.
*/
func (s *Server) gradeAssignmentSubmissions(w http.ResponseWriter, r *http.Request) {
	hwID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid assignment id")
		return
	}
	var req gradeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Entries) == 0 {
		httpx.BadRequest(w, r, "entries must not be empty")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	written := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		var maxMarks *float64
		if err := tx.QueryRow(r.Context(),
			`SELECT section_id, max_marks FROM homework WHERE id = $1`,
			hwID).Scan(&section, &maxMarks); err != nil {
			return err
		}
		if !reachesSection(res, section) {
			return errNotTaught
		}

		for _, e := range req.Entries {
			sid, perr := uuid.Parse(e.StudentID)
			if perr != nil {
				return perr
			}
			ok, rerr := reachesTaughtStudent(r.Context(), tx, res, sid)
			if rerr != nil {
				return rerr
			}
			if !ok {
				return errNotTaught
			}
			// A mark above the paper's maximum is a typo, not a bonus: 95 keyed
			// as 950 must not quietly become the best result in the class.
			if e.Marks != nil && maxMarks != nil && (*e.Marks < 0 || *e.Marks > *maxMarks) {
				return errGradeAboveMax
			}

			status := strings.TrimSpace(e.Status)
			if status == "" {
				status = "graded"
			}
			switch status {
			case "graded", "resubmit", "submitted", "late", "pending":
			default:
				return errBadSubmissionStatus
			}

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO homework_submissions (institution_id, homework_id, student_id,
				                                  status, marks, feedback, graded_by, graded_at)
				VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7, now())
				ON CONFLICT (homework_id, student_id) DO UPDATE
				   SET status    = EXCLUDED.status,
				       marks     = EXCLUDED.marks,
				       feedback  = EXCLUDED.feedback,
				       graded_by = EXCLUDED.graded_by,
				       graded_at = now()`,
				id.InstitutionID, hwID, sid, status, e.Marks, e.Feedback,
				id.UserID); err != nil {
				return err
			}
			written++
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errNotTaught):
		httpx.Forbidden(w, r, "marking work for this child")
		return
	case errors.Is(err, errGradeAboveMax):
		httpx.BadRequest(w, r, "a mark may not exceed the assignment maximum")
		return
	case errors.Is(err, errBadSubmissionStatus):
		httpx.BadRequest(w, r, "status must be graded, resubmit, submitted, late or pending")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"graded": written})
}

var errBadSubmissionStatus = errors.New("unrecognised submission status")

// --- study materials and the LMS upload ---------------------------------------

/* One table behind two screens.

   "Study materials" is the library a class already has; "LMS Study Material
   Upload" is the form that adds to it. They are the same rows and the same
   endpoints, because a second materials table would mean the upload screen and
   the library screen could disagree about what a class has been given.

   file_id and external_url are both optional and at least one is required. That
   is not a nicety: object storage is unconfigured on this deployment, so
   /api/v1/files/presign answers 503 and no file_id can be minted at all. A
   materials screen that accepted only uploads would be unusable today, while a
   video or a Drive link works now and works the same way afterwards. */

type materialRow struct {
	ID             string  `json:"id"`
	ClassSubjectID *string `json:"class_subject_id,omitempty"`
	SectionID      *string `json:"section_id,omitempty"`
	ClassName      *string `json:"class_name,omitempty"`
	Subject        *string `json:"subject,omitempty"`
	SectionName    *string `json:"section,omitempty"`
	Title          string  `json:"title"`
	Description    *string `json:"description,omitempty"`
	Kind           string  `json:"kind"`
	FileID         *string `json:"file_id,omitempty"`
	FileName       *string `json:"file_name,omitempty"`
	SizeBytes      *int64  `json:"size_bytes,omitempty"`
	ExternalURL    *string `json:"external_url,omitempty"`
	IsPublished    bool    `json:"is_published"`
	UploadedBy     *string `json:"uploaded_by,omitempty"`
	CreatedAt      string  `json:"created_at"`
}

func (s *Server) listTeachingMaterials(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	where, args := taughtSubjectsPredicate(res, "cs", 1)
	// A material with no class_subject is a whole-section handout; it is in
	// reach when its section is. Without this arm those rows vanish from the
	// library that owns them.
	sectionArm := "FALSE"
	if res.AllStudents {
		sectionArm = "TRUE"
	} else if len(res.SectionIDs) > 0 {
		args = append(args, res.SectionIDs)
		sectionArm = "sm.section_id = ANY($" + itoa(len(args)) + ")"
	}

	items, err := collect(s, r, `
		SELECT sm.id::text, sm.class_subject_id::text, sm.section_id::text,
		       c.name, sub.name, sec.name,
		       sm.title, sm.description, sm.kind,
		       sm.file_id::text, f.original_name, f.size_bytes,
		       sm.external_url, sm.is_published, u.full_name,
		       to_char(sm.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF')
		  FROM study_materials sm
		  LEFT JOIN class_subjects cs ON cs.id = sm.class_subject_id
		  LEFT JOIN classes         c ON c.id = cs.class_id
		  LEFT JOIN subjects      sub ON sub.id = cs.subject_id
		  LEFT JOIN sections      sec ON sec.id = sm.section_id
		  LEFT JOIN files           f ON f.id = sm.file_id
		  LEFT JOIN users           u ON u.id = sm.uploaded_by
		 WHERE (sm.class_subject_id IS NOT NULL AND `+where+`)
		    OR (sm.class_subject_id IS NULL AND `+sectionArm+`)
		 ORDER BY sm.created_at DESC
		 LIMIT 300`, args,
		func(rows pgx.Rows) (materialRow, error) {
			var v materialRow
			return v, rows.Scan(&v.ID, &v.ClassSubjectID, &v.SectionID, &v.ClassName,
				&v.Subject, &v.SectionName, &v.Title, &v.Description, &v.Kind,
				&v.FileID, &v.FileName, &v.SizeBytes, &v.ExternalURL,
				&v.IsPublished, &v.UploadedBy, &v.CreatedAt)
		})
	respond(w, r, items, err)
}

type materialRequest struct {
	ClassSubjectID string `json:"class_subject_id,omitempty"`
	SectionID      string `json:"section_id,omitempty"`
	Title          string `json:"title"`
	Description    string `json:"description,omitempty"`
	Kind           string `json:"kind,omitempty"`
	FileID         string `json:"file_id,omitempty"`
	ExternalURL    string `json:"external_url,omitempty"`
	IsPublished    *bool  `json:"is_published,omitempty"`
}

var materialKinds = map[string]bool{
	"note": true, "worksheet": true, "reference": true,
	"video": true, "link": true, "syllabus": true,
}

func (s *Server) createTeachingMaterial(w http.ResponseWriter, r *http.Request) {
	var req materialRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		httpx.BadRequest(w, r, "title is required")
		return
	}
	if req.Kind == "" {
		req.Kind = "note"
	}
	if !materialKinds[req.Kind] {
		httpx.BadRequest(w, r, "kind must be note, worksheet, reference, video, link or syllabus")
		return
	}
	// Material that points at nothing is a title in a list that disappoints
	// thirty children when they tap it.
	if strings.TrimSpace(req.FileID) == "" && strings.TrimSpace(req.ExternalURL) == "" {
		httpx.BadRequest(w, r,
			"give either an uploaded file_id or an external_url — file storage is "+
				"unconfigured on this deployment, so a link is the working option")
		return
	}
	if req.ClassSubjectID == "" && req.SectionID == "" {
		httpx.BadRequest(w, r, "name the class_subject_id or the section_id this is for")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	var csID, secID *uuid.UUID
	if req.ClassSubjectID != "" {
		v, perr := uuid.Parse(req.ClassSubjectID)
		if perr != nil {
			httpx.BadRequest(w, r, "class_subject_id must be a uuid")
			return
		}
		csID = &v
	}
	if req.SectionID != "" {
		v, perr := uuid.Parse(req.SectionID)
		if perr != nil {
			httpx.BadRequest(w, r, "section_id must be a uuid")
			return
		}
		if rerr := requireTaughtSection(res, v); rerr != nil {
			httpx.Forbidden(w, r, "sharing material with this section")
			return
		}
		secID = &v
	}

	id := httpx.IdentityFrom(r.Context())
	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if csID != nil {
			ok, cerr := classSubjectTaught(r.Context(), tx, res, *csID)
			if cerr != nil {
				return cerr
			}
			if !ok {
				return errNotTaught
			}
		}
		published := true
		if req.IsPublished != nil {
			published = *req.IsPublished
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO study_materials (institution_id, class_subject_id, section_id,
			                             title, description, kind, file_id,
			                             external_url, is_published, uploaded_by)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,NULLIF($8,''),$9,$10)
			RETURNING id::text`,
			id.InstitutionID, csID, secID, req.Title, req.Description, req.Kind,
			nullUUID(req.FileID), req.ExternalURL, published, id.UserID).Scan(&newID)
	})
	if errors.Is(err, errNotTaught) {
		httpx.Forbidden(w, r, "sharing material for this subject")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID})
}

// updateTeachingMaterial edits a material or withdraws it from the class.
//
// Withdrawal is is_published = false rather than a delete: a worksheet pulled
// back mid-term is often restored the following week, and children who already
// downloaded it are better served by a row that still explains what it was.
func (s *Server) updateTeachingMaterial(w http.ResponseWriter, r *http.Request) {
	mID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid material id")
		return
	}
	var req materialRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Kind != "" && !materialKinds[req.Kind] {
		httpx.BadRequest(w, r, "kind must be note, worksheet, reference, video, link or syllabus")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var csID, secID *uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT class_subject_id, section_id FROM study_materials WHERE id = $1`,
			mID).Scan(&csID, &secID); err != nil {
			return err
		}
		if err := materialInReach(r.Context(), tx, res, csID, secID); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE study_materials
			   SET title        = COALESCE(NULLIF($2,''), title),
			       description  = COALESCE(NULLIF($3,''), description),
			       kind         = COALESCE(NULLIF($4,''), kind),
			       external_url = COALESCE(NULLIF($5,''), external_url),
			       is_published = COALESCE($6, is_published)
			 WHERE id = $1`,
			mID, strings.TrimSpace(req.Title), req.Description, req.Kind,
			req.ExternalURL, req.IsPublished)
		found = err == nil && tag.RowsAffected() > 0
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": mID.String()})
}

// materialInReach applies the same two-armed test the list uses, so a material
// a teacher cannot see is also one they cannot edit.
func materialInReach(ctx context.Context, tx pgx.Tx, res *scope.Resolved,
	csID, secID *uuid.UUID) error {
	if res.AllStudents {
		return nil
	}
	if csID != nil {
		ok, err := classSubjectTaught(ctx, tx, res, *csID)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
	}
	if secID != nil && reachesSection(res, *secID) {
		return nil
	}
	return errNotTaught
}

// --- live virtual classes -----------------------------------------------------

/* BLOCKED: no meeting provider is integrated.

   Everything below is real except the one step that needs Zoom or Google to
   answer: scheduling, the roster the session belongs to, the launch record and
   the audit of who started what. What is missing is the API call that creates
   the meeting and returns a join URL.

   The handler does not invent one. A session with no provider meeting stays in
   'provider_pending' and launch answers 503 with provider_unconfigured, which
   is the same shape /api/v1/files/presign already uses for absent storage. A
   fabricated link would be worse than an error: the teacher would find out in
   front of the class.

   A school can still use the screen today by pasting the join URL from a
   meeting they made by hand — join_url on create or update. That is what
   schools actually do before an integration lands, and it is why the column is
   writable rather than provider-only. */

type virtualClassRow struct {
	ID           string  `json:"id"`
	SectionID    string  `json:"section_id"`
	SectionName  string  `json:"section"`
	ClassName    string  `json:"class_name"`
	Subject      *string `json:"subject,omitempty"`
	Provider     *string `json:"provider,omitempty"`
	ProviderName *string `json:"provider_name,omitempty"`
	Topic        string  `json:"topic"`
	Agenda       *string `json:"agenda,omitempty"`
	ScheduledAt  string  `json:"scheduled_at"`
	Duration     int32   `json:"duration_minutes"`
	JoinURL      *string `json:"join_url,omitempty"`
	Status       string  `json:"status"`
	StartedAt    *string `json:"started_at,omitempty"`
	CreatedBy    *string `json:"created_by,omitempty"`
	// Joinable is the only thing the button should look at: a session is
	// joinable when somebody actually has a URL for it.
	Joinable bool `json:"joinable"`
}

func (s *Server) listVirtualClasses(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	where := "FALSE"
	args := []any{}
	if res.AllStudents {
		where = "TRUE"
	} else if len(res.SectionIDs) > 0 {
		args = append(args, res.SectionIDs)
		where = "v.section_id = ANY($1)"
	}

	items, err := collect(s, r, `
		SELECT v.id::text, v.section_id::text, sec.name, c.name, sub.name,
		       p.provider, p.display_name, v.topic, v.agenda,
		       to_char(v.scheduled_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       v.duration_minutes, v.join_url, v.status,
		       to_char(v.started_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       u.full_name, (v.join_url IS NOT NULL)
		  FROM virtual_class_sessions v
		  JOIN sections sec ON sec.id = v.section_id
		  JOIN classes    c ON c.id = sec.class_id
		  LEFT JOIN class_subjects cs ON cs.id = v.class_subject_id
		  LEFT JOIN subjects      sub ON sub.id = cs.subject_id
		  LEFT JOIN virtual_class_providers p ON p.id = v.provider_id
		  LEFT JOIN users u ON u.id = v.created_by
		 WHERE `+where+`
		 ORDER BY v.scheduled_at DESC
		 LIMIT 200`, args,
		func(rows pgx.Rows) (virtualClassRow, error) {
			var v virtualClassRow
			return v, rows.Scan(&v.ID, &v.SectionID, &v.SectionName, &v.ClassName,
				&v.Subject, &v.Provider, &v.ProviderName, &v.Topic, &v.Agenda,
				&v.ScheduledAt, &v.Duration, &v.JoinURL, &v.Status, &v.StartedAt,
				&v.CreatedBy, &v.Joinable)
		})
	respond(w, r, items, err)
}

type providerRow struct {
	ID          string  `json:"id"`
	Provider    string  `json:"provider"`
	DisplayName string  `json:"display_name"`
	AccountRef  *string `json:"account_ref,omitempty"`
	IsActive    bool    `json:"is_active"`
	// Integrated stays false until the meeting API is wired. The screen reads
	// it to decide whether to offer "create meeting" or ask for a pasted link.
	Integrated bool `json:"integrated"`
}

func (s *Server) listVirtualClassProviders(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, provider, display_name, account_ref, is_active, false
		  FROM virtual_class_providers
		 ORDER BY provider`, nil,
		func(rows pgx.Rows) (providerRow, error) {
			var v providerRow
			return v, rows.Scan(&v.ID, &v.Provider, &v.DisplayName, &v.AccountRef,
				&v.IsActive, &v.Integrated)
		})
	respond(w, r, items, err)
}

type providerRequest struct {
	Provider    string `json:"provider"`
	DisplayName string `json:"display_name"`
	AccountRef  string `json:"account_ref,omitempty"`
	IsActive    *bool  `json:"is_active,omitempty"`
}

var meetingProviders = map[string]bool{"zoom": true, "google_meet": true, "ms_teams": true}

// saveVirtualClassProvider records which account a school means to host on.
//
// No credential is accepted here. The client secret belongs in the platform
// integration store with the encryption that goes with it, and an endpoint that
// took one would be storing it in the clear in a teaching table.
func (s *Server) saveVirtualClassProvider(w http.ResponseWriter, r *http.Request) {
	var req providerRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !meetingProviders[req.Provider] {
		httpx.BadRequest(w, r, "provider must be zoom, google_meet or ms_teams")
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.DisplayName == "" {
		httpx.BadRequest(w, r, "display_name is required")
		return
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	id := httpx.IdentityFrom(r.Context())
	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO virtual_class_providers (institution_id, provider, display_name,
			                                     account_ref, is_active, configured_by)
			VALUES ($1,$2,$3,NULLIF($4,''),$5,$6)
			ON CONFLICT (institution_id, provider) DO UPDATE
			   SET display_name  = EXCLUDED.display_name,
			       account_ref   = EXCLUDED.account_ref,
			       is_active     = EXCLUDED.is_active,
			       configured_by = EXCLUDED.configured_by
			RETURNING id::text`,
			id.InstitutionID, req.Provider, req.DisplayName, req.AccountRef,
			active, id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": newID, "provider": req.Provider,
		// Said on every write so nobody reads a saved provider as a working one.
		"integration_status": "blocked: no meeting API is wired to this provider yet",
	})
}

type virtualClassRequest struct {
	SectionID      string `json:"section_id"`
	ClassSubjectID string `json:"class_subject_id,omitempty"`
	ProviderID     string `json:"provider_id,omitempty"`
	Topic          string `json:"topic"`
	Agenda         string `json:"agenda,omitempty"`
	ScheduledAt    string `json:"scheduled_at"`
	Duration       int    `json:"duration_minutes,omitempty"`
	// JoinURL is how a teacher uses this today: they create the meeting in Zoom
	// themselves and paste the link. Optional, and absent means pending.
	JoinURL string `json:"join_url,omitempty"`
	Status  string `json:"status,omitempty"`
}

func (s *Server) scheduleVirtualClass(w http.ResponseWriter, r *http.Request) {
	var req virtualClassRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	section, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	req.Topic = strings.TrimSpace(req.Topic)
	if req.Topic == "" {
		httpx.BadRequest(w, r, "topic is required")
		return
	}
	if strings.TrimSpace(req.ScheduledAt) == "" {
		httpx.BadRequest(w, r, "scheduled_at is required")
		return
	}
	if req.Duration <= 0 {
		req.Duration = 40
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if rerr := requireTaughtSection(res, section); rerr != nil {
		httpx.Forbidden(w, r, "scheduling a live class for this section")
		return
	}

	// A pasted link makes the session joinable; without one it waits for an
	// integration that does not exist yet, and says so.
	status := "provider_pending"
	if strings.TrimSpace(req.JoinURL) != "" {
		status = "scheduled"
	}

	id := httpx.IdentityFrom(r.Context())
	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ClassSubjectID != "" {
			csID, perr := uuid.Parse(req.ClassSubjectID)
			if perr != nil {
				return perr
			}
			ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
			if cerr != nil {
				return cerr
			}
			if !ok {
				return errNotTaught
			}
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO virtual_class_sessions (institution_id, section_id, class_subject_id,
			                                    provider_id, topic, agenda, scheduled_at,
			                                    duration_minutes, join_url, status, created_by)
			VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7::timestamptz,$8,NULLIF($9,''),$10,$11)
			RETURNING id::text`,
			id.InstitutionID, section, nullUUID(req.ClassSubjectID),
			nullUUID(req.ProviderID), req.Topic, req.Agenda, req.ScheduledAt,
			req.Duration, req.JoinURL, status, id.UserID).Scan(&newID)
	})
	if errors.Is(err, errNotTaught) {
		httpx.Forbidden(w, r, "scheduling a live class for this subject")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out := map[string]any{"id": newID, "status": status}
	if status == "provider_pending" {
		out["note"] = "no meeting created: no provider integration is wired. " +
			"Paste a join_url to make this session joinable."
	}
	httpx.JSON(w, http.StatusOK, out)
}

var virtualClassStatuses = map[string]bool{
	"provider_pending": true, "scheduled": true, "live": true,
	"ended": true, "cancelled": true,
}

func (s *Server) updateVirtualClass(w http.ResponseWriter, r *http.Request) {
	vID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid session id")
		return
	}
	var req virtualClassRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Status != "" && !virtualClassStatuses[req.Status] {
		httpx.BadRequest(w, r, "status must be provider_pending, scheduled, live, ended or cancelled")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT section_id FROM virtual_class_sessions WHERE id = $1`,
			vID).Scan(&section); err != nil {
			return err
		}
		if !reachesSection(res, section) {
			return errNotTaught
		}
		/* The database refuses 'scheduled' or 'live' without a join_url, and
		   that check is left to it deliberately: it is the one invariant that
		   must hold no matter which handler writes the row. */
		tag, err := tx.Exec(r.Context(), `
			UPDATE virtual_class_sessions
			   SET topic      = COALESCE(NULLIF($2,''), topic),
			       agenda     = COALESCE(NULLIF($3,''), agenda),
			       join_url   = COALESCE(NULLIF($4,''), join_url),
			       status     = COALESCE(NULLIF($5,''), status),
			       ended_at   = CASE WHEN $5 = 'ended' THEN now() ELSE ended_at END,
			       updated_at = now()
			 WHERE id = $1`,
			vID, req.Topic, req.Agenda, req.JoinURL, req.Status)
		found = err == nil && tag.RowsAffected() > 0
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case err != nil:
		// The joinable constraint is the likely failure and deserves its own
		// sentence rather than a generic 500.
		if strings.Contains(err.Error(), "virtual_class_sessions_joinable") {
			httpx.BadRequest(w, r,
				"a session cannot be scheduled or live without a join_url")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": vID.String()})
}

/*
launchVirtualClass starts the session the teacher is about to teach.

	With a join URL already on the row — pasted by the teacher — this marks the
	session live and hands the URL back, which is a complete and honest flow.

	Without one it answers 503 provider_unconfigured. That is the BLOCKED path:
	creating the meeting needs a Zoom or Google credential and an API call that
	this deployment has neither of. Returning a made-up link here would be the
	single worst thing this file could do.
*/
func (s *Server) launchVirtualClass(w http.ResponseWriter, r *http.Request) {
	vID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid session id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var joinURL *string
	var status string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT section_id, join_url, status FROM virtual_class_sessions WHERE id = $1`,
			vID).Scan(&section, &joinURL, &status); err != nil {
			return err
		}
		if !reachesSection(res, section) {
			return errNotTaught
		}
		if joinURL == nil {
			return errNoProvider
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE virtual_class_sessions
			   SET status     = 'live',
			       started_at = COALESCE(started_at, now()),
			       updated_at = now()
			 WHERE id = $1`, vID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errNoProvider):
		httpx.Error(w, r, http.StatusServiceUnavailable, "provider_unconfigured",
			"no meeting provider is integrated, so no join link can be created. "+
				"Create the meeting in Zoom or Meet and save its join_url on this session.")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": vID.String(), "status": "live", "join_url": joinURL,
	})
}

var errNoProvider = errors.New("no meeting provider integration")

// --- question bank ------------------------------------------------------------

type bankQuestion struct {
	ID             string   `json:"id"`
	ClassSubjectID string   `json:"class_subject_id"`
	ClassName      string   `json:"class_name"`
	Subject        string   `json:"subject"`
	UnitID         *string  `json:"syllabus_unit_id,omitempty"`
	Chapter        *string  `json:"chapter,omitempty"`
	Kind           string   `json:"kind"`
	Difficulty     string   `json:"difficulty"`
	BloomLevel     string   `json:"bloom_level"`
	Stem           string   `json:"stem"`
	DefaultMarks   float64  `json:"default_marks"`
	Explanation    *string  `json:"explanation,omitempty"`
	IsActive       bool     `json:"is_active"`
	Options        []string `json:"options"`
	// Objective is what the test builder filters on: only these may be
	// auto-graded, and a screen that offers a long-answer question for an
	// objective test is offering something that can never be marked.
	Objective bool    `json:"objective"`
	UsedOn    int32   `json:"used_on_tests"`
	CreatedBy *string `json:"created_by,omitempty"`
}

var objectiveKinds = map[string]bool{"mcq": true, "true_false": true, "fill_blank": true}
var questionKinds = map[string]bool{
	"mcq": true, "true_false": true, "fill_blank": true, "short": true, "long": true,
}
var difficulties = map[string]bool{"easy": true, "medium": true, "hard": true}
var bloomLevels = map[string]bool{
	"remember": true, "understand": true, "apply": true,
	"analyse": true, "evaluate": true, "create": true,
}

func (s *Server) listBankQuestions(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	where, args := taughtSubjectsPredicate(res, "cs", 1)
	q := r.URL.Query()
	for _, f := range []struct {
		param, column string
		valid         map[string]bool
	}{
		{"kind", "q.kind", questionKinds},
		{"difficulty", "q.difficulty", difficulties},
		{"bloom_level", "q.bloom_level", bloomLevels},
	} {
		if v := q.Get(f.param); v != "" {
			if !f.valid[v] {
				httpx.BadRequest(w, r, f.param+" is not a recognised value")
				return
			}
			args = append(args, v)
			where += " AND " + f.column + " = $" + itoa(len(args))
		}
	}
	if v := q.Get("class_subject_id"); v != "" {
		csID, perr := uuid.Parse(v)
		if perr != nil {
			httpx.BadRequest(w, r, "class_subject_id must be a uuid")
			return
		}
		args = append(args, csID)
		where += " AND q.class_subject_id = $" + itoa(len(args))
	}
	if v := strings.TrimSpace(q.Get("search")); v != "" {
		args = append(args, "%"+v+"%")
		where += " AND q.stem ILIKE $" + itoa(len(args))
	}
	// Retired questions stay out of the bank unless asked for: a teacher
	// building a paper wants what they may use now.
	if q.Get("include_retired") != "1" {
		where += " AND q.is_active"
	}

	items, err := collect(s, r, `
		SELECT q.id::text, q.class_subject_id::text, c.name, sub.name,
		       q.syllabus_unit_id::text, su.title, q.kind, q.difficulty,
		       q.bloom_level, q.stem, q.default_marks, q.explanation, q.is_active,
		       COALESCE(array_agg(o.body ORDER BY o.sequence)
		                FILTER (WHERE o.id IS NOT NULL), '{}'),
		       (q.kind IN ('mcq','true_false','fill_blank')),
		       (SELECT count(*) FROM online_test_questions tq
		         WHERE tq.question_id = q.id)::int,
		       u.full_name
		  FROM question_bank_questions q
		  JOIN class_subjects cs ON cs.id = q.class_subject_id
		  JOIN classes         c ON c.id = cs.class_id
		  JOIN subjects      sub ON sub.id = cs.subject_id
		  LEFT JOIN syllabus_units su ON su.id = q.syllabus_unit_id
		  LEFT JOIN question_bank_options o ON o.question_id = q.id
		  LEFT JOIN users u ON u.id = q.created_by
		 WHERE `+where+`
		 GROUP BY q.id, c.name, c.level, sub.name, su.title, u.full_name
		 ORDER BY c.level, sub.name, q.created_at DESC
		 LIMIT 300`, args,
		func(rows pgx.Rows) (bankQuestion, error) {
			var v bankQuestion
			return v, rows.Scan(&v.ID, &v.ClassSubjectID, &v.ClassName, &v.Subject,
				&v.UnitID, &v.Chapter, &v.Kind, &v.Difficulty, &v.BloomLevel,
				&v.Stem, &v.DefaultMarks, &v.Explanation, &v.IsActive,
				&v.Options, &v.Objective, &v.UsedOn, &v.CreatedBy)
		})
	respond(w, r, items, err)
}

type bankSummaryRow struct {
	ClassSubjectID string `json:"class_subject_id"`
	ClassName      string `json:"class_name"`
	Subject        string `json:"subject"`
	Total          int32  `json:"total"`
	Objective      int32  `json:"objective"`
	Easy           int32  `json:"easy"`
	Medium         int32  `json:"medium"`
	Hard           int32  `json:"hard"`
	// HigherOrder is the count above "understand". A bank that is all recall
	// is the thing a head of department is looking for, and counting it here
	// means every screen agrees on where the line is.
	HigherOrder int32 `json:"higher_order"`
	Chapters    int32 `json:"chapters_covered"`
}

// getBankSummary answers "have I got enough, and of the right kind" per subject.
func (s *Server) getBankSummary(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	where, args := taughtSubjectsPredicate(res, "cs", 1)
	items, err := collect(s, r, `
		SELECT cs.id::text, c.name, sub.name,
		       count(q.id)::int,
		       count(q.id) FILTER (WHERE q.kind IN ('mcq','true_false','fill_blank'))::int,
		       count(q.id) FILTER (WHERE q.difficulty = 'easy')::int,
		       count(q.id) FILTER (WHERE q.difficulty = 'medium')::int,
		       count(q.id) FILTER (WHERE q.difficulty = 'hard')::int,
		       count(q.id) FILTER (WHERE q.bloom_level IN ('apply','analyse','evaluate','create'))::int,
		       count(DISTINCT q.syllabus_unit_id)::int
		  FROM class_subjects cs
		  JOIN classes  c   ON c.id = cs.class_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN question_bank_questions q
		         ON q.class_subject_id = cs.id AND q.is_active
		 WHERE `+where+`
		 GROUP BY cs.id, c.name, c.level, sub.name
		 ORDER BY c.level, sub.name`, args,
		func(rows pgx.Rows) (bankSummaryRow, error) {
			var v bankSummaryRow
			return v, rows.Scan(&v.ClassSubjectID, &v.ClassName, &v.Subject,
				&v.Total, &v.Objective, &v.Easy, &v.Medium, &v.Hard,
				&v.HigherOrder, &v.Chapters)
		})
	respond(w, r, items, err)
}

type bankOption struct {
	Sequence  int32  `json:"sequence"`
	Body      string `json:"body"`
	IsCorrect bool   `json:"is_correct"`
}

type bankQuestionDetail struct {
	bankQuestion
	AnswerKey []bankOption `json:"answer_key"`
}

func (s *Server) getBankQuestion(w http.ResponseWriter, r *http.Request) {
	qID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid question id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var out bankQuestionDetail
	out.Options = []string{}
	out.AnswerKey = []bankOption{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var csID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT q.id::text, q.class_subject_id, c.name, sub.name,
			       q.syllabus_unit_id::text, su.title, q.kind, q.difficulty,
			       q.bloom_level, q.stem, q.default_marks, q.explanation, q.is_active
			  FROM question_bank_questions q
			  JOIN class_subjects cs ON cs.id = q.class_subject_id
			  JOIN classes         c ON c.id = cs.class_id
			  JOIN subjects      sub ON sub.id = cs.subject_id
			  LEFT JOIN syllabus_units su ON su.id = q.syllabus_unit_id
			 WHERE q.id = $1`, qID).Scan(&out.ID, &csID, &out.ClassName, &out.Subject,
			&out.UnitID, &out.Chapter, &out.Kind, &out.Difficulty, &out.BloomLevel,
			&out.Stem, &out.DefaultMarks, &out.Explanation, &out.IsActive); err != nil {
			return err
		}
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			return errNotTaught
		}
		out.ClassSubjectID = csID.String()
		out.Objective = objectiveKinds[out.Kind]

		rows, err := tx.Query(r.Context(), `
			SELECT sequence, body, is_correct FROM question_bank_options
			 WHERE question_id = $1 ORDER BY sequence`, qID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var o bankOption
			if err := rows.Scan(&o.Sequence, &o.Body, &o.IsCorrect); err != nil {
				return err
			}
			out.AnswerKey = append(out.AnswerKey, o)
			out.Options = append(out.Options, o.Body)
		}
		return rows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type bankQuestionRequest struct {
	ClassSubjectID string  `json:"class_subject_id"`
	SyllabusUnitID string  `json:"syllabus_unit_id,omitempty"`
	Kind           string  `json:"kind,omitempty"`
	Difficulty     string  `json:"difficulty,omitempty"`
	BloomLevel     string  `json:"bloom_level,omitempty"`
	Stem           string  `json:"stem"`
	DefaultMarks   float64 `json:"default_marks,omitempty"`
	Explanation    string  `json:"explanation,omitempty"`
	IsActive       *bool   `json:"is_active,omitempty"`
	Options        []struct {
		Body      string `json:"body"`
		IsCorrect bool   `json:"is_correct"`
	} `json:"options,omitempty"`
}

var errNoCorrectOption = errors.New("an objective question with no correct answer")

// validateBankQuestion applies the rules both create and update need, so the
// two cannot drift into accepting different questions.
func validateBankQuestion(req *bankQuestionRequest, requireOptions bool) error {
	if req.Kind == "" {
		req.Kind = "mcq"
	}
	if !questionKinds[req.Kind] {
		return errors.New("kind must be mcq, true_false, fill_blank, short or long")
	}
	if req.Difficulty == "" {
		req.Difficulty = "medium"
	}
	if !difficulties[req.Difficulty] {
		return errors.New("difficulty must be easy, medium or hard")
	}
	if req.BloomLevel == "" {
		req.BloomLevel = "understand"
	}
	if !bloomLevels[req.BloomLevel] {
		return errors.New("bloom_level must be remember, understand, apply, analyse, evaluate or create")
	}
	if req.DefaultMarks <= 0 {
		req.DefaultMarks = 1
	}
	/* An objective question with no right answer can never be marked, and the
	   failure would not appear until thirty children had sat the test. Checked
	   here rather than in the schema because a multi-answer MCQ and a
	   fill-in-the-blank with three acceptable spellings are both legitimate,
	   so "exactly one" would be wrong. */
	if objectiveKinds[req.Kind] && (requireOptions || len(req.Options) > 0) {
		if len(req.Options) < 2 && req.Kind != "fill_blank" {
			return errors.New("an objective question needs at least two options")
		}
		correct := 0
		for _, o := range req.Options {
			if strings.TrimSpace(o.Body) == "" {
				return errors.New("an option may not be blank")
			}
			if o.IsCorrect {
				correct++
			}
		}
		if correct == 0 {
			return errNoCorrectOption
		}
	}
	return nil
}

func (s *Server) createBankQuestion(w http.ResponseWriter, r *http.Request) {
	var req bankQuestionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	csID, err := uuid.Parse(req.ClassSubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	req.Stem = strings.TrimSpace(req.Stem)
	if req.Stem == "" {
		httpx.BadRequest(w, r, "stem is required — a question needs asking")
		return
	}
	if verr := validateBankQuestion(&req, true); verr != nil {
		httpx.BadRequest(w, r, verr.Error())
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			return errNotTaught
		}
		active := true
		if req.IsActive != nil {
			active = *req.IsActive
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO question_bank_questions (institution_id, class_subject_id,
			                                     syllabus_unit_id, kind, difficulty,
			                                     bloom_level, stem, default_marks,
			                                     explanation, is_active, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),$10,$11)
			RETURNING id::text`,
			id.InstitutionID, csID, nullUUID(req.SyllabusUnitID), req.Kind,
			req.Difficulty, req.BloomLevel, req.Stem, req.DefaultMarks,
			req.Explanation, active, id.UserID).Scan(&newID); err != nil {
			return err
		}
		return insertBankOptions(r, tx, id.InstitutionID, newID, req)
	})
	if errors.Is(err, errNotTaught) {
		httpx.Forbidden(w, r, "banking a question for this subject")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID})
}

func insertBankOptions(r *http.Request, tx pgx.Tx, inst uuid.UUID, questionID string,
	req bankQuestionRequest) error {
	for i, o := range req.Options {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO question_bank_options (institution_id, question_id, sequence,
			                                   body, is_correct)
			VALUES ($1,$2::uuid,$3,$4,$5)`,
			inst, questionID, i+1, strings.TrimSpace(o.Body), o.IsCorrect); err != nil {
			return err
		}
	}
	return nil
}

// updateBankQuestion rewrites a question and, when options are supplied,
// replaces the answer key wholesale.
//
// Replace rather than merge: an answer key edited in place is how a question
// ends up with two correct options, one of which the teacher thought they had
// removed.
func (s *Server) updateBankQuestion(w http.ResponseWriter, r *http.Request) {
	qID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid question id")
		return
	}
	var req bankQuestionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var csID uuid.UUID
		var currentKind string
		if err := tx.QueryRow(r.Context(),
			`SELECT class_subject_id, kind FROM question_bank_questions WHERE id = $1`,
			qID).Scan(&csID, &currentKind); err != nil {
			return err
		}
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			return errNotTaught
		}
		if req.Kind == "" {
			req.Kind = currentKind
		}
		if verr := validateBankQuestion(&req, false); verr != nil {
			return verr
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE question_bank_questions
			   SET syllabus_unit_id = COALESCE($2::uuid, syllabus_unit_id),
			       kind          = $3,
			       difficulty    = $4,
			       bloom_level   = $5,
			       stem          = COALESCE(NULLIF($6,''), stem),
			       default_marks = $7,
			       explanation   = COALESCE(NULLIF($8,''), explanation),
			       is_active     = COALESCE($9, is_active),
			       updated_at    = now()
			 WHERE id = $1`,
			qID, nullUUID(req.SyllabusUnitID), req.Kind, req.Difficulty,
			req.BloomLevel, strings.TrimSpace(req.Stem), req.DefaultMarks,
			req.Explanation, req.IsActive); err != nil {
			return err
		}
		if len(req.Options) == 0 {
			return nil
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM question_bank_options WHERE question_id = $1`, qID); err != nil {
			return err
		}
		return insertBankOptions(r, tx, id.InstitutionID, qID.String(), req)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errNoCorrectOption):
		httpx.BadRequest(w, r, "an objective question needs at least one correct option")
		return
	case err != nil:
		// validateBankQuestion returns plain errors describing the field at
		// fault; those are the caller's problem, not the server's.
		if !isDBError(err) {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": qID.String()})
}

// retireBankQuestion withdraws a question without deleting it.
//
// A question already sitting on a test cannot be deleted without changing a
// paper children have taken, so retirement is the only safe removal: it drops
// out of the bank's search and stays on the papers that used it.
func (s *Server) retireBankQuestion(w http.ResponseWriter, r *http.Request) {
	qID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid question id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var csID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT class_subject_id FROM question_bank_questions WHERE id = $1`,
			qID).Scan(&csID); err != nil {
			return err
		}
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			return errNotTaught
		}
		_, err := tx.Exec(r.Context(),
			`UPDATE question_bank_questions SET is_active = false, updated_at = now()
			  WHERE id = $1`, qID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": qID.String(), "is_active": false})
}

// --- objective online tests ---------------------------------------------------

type onlineTestRow struct {
	ID             string   `json:"id"`
	SectionID      string   `json:"section_id"`
	SectionName    string   `json:"section"`
	ClassName      string   `json:"class_name"`
	ClassSubjectID string   `json:"class_subject_id"`
	Subject        string   `json:"subject"`
	Title          string   `json:"title"`
	Instructions   *string  `json:"instructions,omitempty"`
	OpensAt        *string  `json:"opens_at,omitempty"`
	ClosesAt       *string  `json:"closes_at,omitempty"`
	Duration       *int32   `json:"duration_minutes,omitempty"`
	MaxAttempts    int32    `json:"max_attempts"`
	Shuffle        bool     `json:"shuffle_questions"`
	Status         string   `json:"status"`
	Questions      int32    `json:"questions"`
	TotalMarks     *float64 `json:"total_marks,omitempty"`
	CreatedBy      *string  `json:"created_by,omitempty"`
}

func (s *Server) listOnlineTests(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	where := "FALSE"
	args := []any{}
	if res.AllStudents {
		where = "TRUE"
	} else if len(res.SectionIDs) > 0 {
		args = append(args, res.SectionIDs)
		where = "t.section_id = ANY($1)"
	}
	if v := r.URL.Query().Get("status"); v != "" {
		args = append(args, v)
		where += " AND t.status = $" + itoa(len(args))
	}

	items, err := collect(s, r, `
		SELECT t.id::text, t.section_id::text, sec.name, c.name,
		       t.class_subject_id::text, sub.name, t.title, t.instructions,
		       to_char(t.opens_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(t.closes_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       t.duration_minutes, t.max_attempts, t.shuffle_questions, t.status,
		       (SELECT count(*) FROM online_test_questions tq WHERE tq.test_id = t.id)::int,
		       -- Summed on read: a stored total is wrong the moment a question
		       -- is added and nobody remembers to recompute it.
		       (SELECT sum(tq.marks) FROM online_test_questions tq WHERE tq.test_id = t.id),
		       u.full_name
		  FROM online_tests t
		  JOIN sections sec ON sec.id = t.section_id
		  JOIN classes    c ON c.id = sec.class_id
		  JOIN class_subjects cs ON cs.id = t.class_subject_id
		  JOIN subjects      sub ON sub.id = cs.subject_id
		  LEFT JOIN users u ON u.id = t.created_by
		 WHERE `+where+`
		 ORDER BY COALESCE(t.opens_at, t.created_at) DESC
		 LIMIT 200`, args,
		func(rows pgx.Rows) (onlineTestRow, error) {
			var v onlineTestRow
			return v, rows.Scan(&v.ID, &v.SectionID, &v.SectionName, &v.ClassName,
				&v.ClassSubjectID, &v.Subject, &v.Title, &v.Instructions,
				&v.OpensAt, &v.ClosesAt, &v.Duration, &v.MaxAttempts, &v.Shuffle,
				&v.Status, &v.Questions, &v.TotalMarks, &v.CreatedBy)
		})
	respond(w, r, items, err)
}

type testQuestionRow struct {
	QuestionID string       `json:"question_id"`
	Sequence   int32        `json:"sequence"`
	Marks      float64      `json:"marks"`
	Kind       string       `json:"kind"`
	Difficulty string       `json:"difficulty"`
	BloomLevel string       `json:"bloom_level"`
	Stem       string       `json:"stem"`
	Chapter    *string      `json:"chapter,omitempty"`
	AnswerKey  []bankOption `json:"answer_key"`
}

type onlineTestDetail struct {
	onlineTestRow
	Paper []testQuestionRow `json:"paper"`
}

func (s *Server) getOnlineTest(w http.ResponseWriter, r *http.Request) {
	tID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid test id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var out onlineTestDetail
	out.Paper = []testQuestionRow{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT t.id::text, t.section_id, sec.name, c.name, t.class_subject_id::text,
			       sub.name, t.title, t.instructions,
			       to_char(t.opens_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       to_char(t.closes_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       t.duration_minutes, t.max_attempts, t.shuffle_questions, t.status
			  FROM online_tests t
			  JOIN sections sec ON sec.id = t.section_id
			  JOIN classes    c ON c.id = sec.class_id
			  JOIN class_subjects cs ON cs.id = t.class_subject_id
			  JOIN subjects      sub ON sub.id = cs.subject_id
			 WHERE t.id = $1`, tID).Scan(&out.ID, &section, &out.SectionName,
			&out.ClassName, &out.ClassSubjectID, &out.Subject, &out.Title,
			&out.Instructions, &out.OpensAt, &out.ClosesAt, &out.Duration,
			&out.MaxAttempts, &out.Shuffle, &out.Status); err != nil {
			return err
		}
		if !reachesSection(res, section) {
			return errNotTaught
		}
		out.SectionID = section.String()

		rows, err := tx.Query(r.Context(), `
			SELECT tq.question_id::text, tq.sequence, tq.marks, q.kind, q.difficulty,
			       q.bloom_level, q.stem, su.title
			  FROM online_test_questions tq
			  JOIN question_bank_questions q ON q.id = tq.question_id
			  LEFT JOIN syllabus_units su ON su.id = q.syllabus_unit_id
			 WHERE tq.test_id = $1
			 ORDER BY tq.sequence`, tID)
		if err != nil {
			return err
		}
		defer rows.Close()
		var total float64
		for rows.Next() {
			var q testQuestionRow
			q.AnswerKey = []bankOption{}
			if err := rows.Scan(&q.QuestionID, &q.Sequence, &q.Marks, &q.Kind,
				&q.Difficulty, &q.BloomLevel, &q.Stem, &q.Chapter); err != nil {
				return err
			}
			total += q.Marks
			out.Paper = append(out.Paper, q)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		out.Questions = int32(len(out.Paper))
		out.TotalMarks = &total

		// The answer key travels with the paper because this endpoint is the
		// teacher's preview. Nothing student-facing reads it.
		for i := range out.Paper {
			orows, err := tx.Query(r.Context(), `
				SELECT sequence, body, is_correct FROM question_bank_options
				 WHERE question_id = $1 ORDER BY sequence`, out.Paper[i].QuestionID)
			if err != nil {
				return err
			}
			for orows.Next() {
				var o bankOption
				if err := orows.Scan(&o.Sequence, &o.Body, &o.IsCorrect); err != nil {
					orows.Close()
					return err
				}
				out.Paper[i].AnswerKey = append(out.Paper[i].AnswerKey, o)
			}
			orows.Close()
			if err := orows.Err(); err != nil {
				return err
			}
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type onlineTestRequest struct {
	SectionID      string `json:"section_id"`
	ClassSubjectID string `json:"class_subject_id"`
	Title          string `json:"title"`
	Instructions   string `json:"instructions,omitempty"`
	OpensAt        string `json:"opens_at,omitempty"`
	ClosesAt       string `json:"closes_at,omitempty"`
	Duration       int    `json:"duration_minutes,omitempty"`
	MaxAttempts    int    `json:"max_attempts,omitempty"`
	Shuffle        *bool  `json:"shuffle_questions,omitempty"`
	Status         string `json:"status,omitempty"`
}

var testStatuses = map[string]bool{"draft": true, "published": true, "closed": true}

func (s *Server) createOnlineTest(w http.ResponseWriter, r *http.Request) {
	var req onlineTestRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	section, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	csID, err := uuid.Parse(req.ClassSubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		httpx.BadRequest(w, r, "title is required")
		return
	}
	if req.MaxAttempts <= 0 {
		req.MaxAttempts = 1
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if rerr := requireTaughtSection(res, section); rerr != nil {
		httpx.Forbidden(w, r, "setting a test for this section")
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			return errNotTaught
		}
		shuffle := false
		if req.Shuffle != nil {
			shuffle = *req.Shuffle
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO online_tests (institution_id, section_id, class_subject_id,
			                          title, instructions, opens_at, closes_at,
			                          duration_minutes, max_attempts,
			                          shuffle_questions, status, created_by)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,'')::timestamptz,
			        NULLIF($7,'')::timestamptz,$8,$9,$10,'draft',$11)
			RETURNING id::text`,
			id.InstitutionID, section, csID, req.Title, req.Instructions,
			req.OpensAt, req.ClosesAt, nullPositiveInt(req.Duration), req.MaxAttempts,
			shuffle, id.UserID).Scan(&newID)
	})
	if errors.Is(err, errNotTaught) {
		httpx.Forbidden(w, r, "setting a test for this subject")
		return
	}
	if err != nil {
		if strings.Contains(err.Error(), "online_tests_window") {
			httpx.BadRequest(w, r, "closes_at must be after opens_at")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	// Created as a draft on purpose: a test is published once its questions are
	// on it, and the publish path checks that.
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID, "status": "draft"})
}

var errEmptyPaper = errors.New("a test with no questions")

// updateOnlineTest edits a test and is the only way to publish one.
//
// Publishing an empty paper is refused: children would open a test with nothing
// in it and the teacher would hear about it from thirty families at once.
func (s *Server) updateOnlineTest(w http.ResponseWriter, r *http.Request) {
	tID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid test id")
		return
	}
	var req onlineTestRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Status != "" && !testStatuses[req.Status] {
		httpx.BadRequest(w, r, "status must be draft, published or closed")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT section_id FROM online_tests WHERE id = $1`, tID).Scan(&section); err != nil {
			return err
		}
		if !reachesSection(res, section) {
			return errNotTaught
		}
		if req.Status == "published" {
			var n int
			if err := tx.QueryRow(r.Context(),
				`SELECT count(*)::int FROM online_test_questions WHERE test_id = $1`,
				tID).Scan(&n); err != nil {
				return err
			}
			if n == 0 {
				return errEmptyPaper
			}
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE online_tests
			   SET title             = COALESCE(NULLIF($2,''), title),
			       instructions      = COALESCE(NULLIF($3,''), instructions),
			       opens_at          = COALESCE(NULLIF($4,'')::timestamptz, opens_at),
			       closes_at         = COALESCE(NULLIF($5,'')::timestamptz, closes_at),
			       duration_minutes  = COALESCE($6, duration_minutes),
			       max_attempts      = COALESCE($7, max_attempts),
			       shuffle_questions = COALESCE($8, shuffle_questions),
			       status            = COALESCE(NULLIF($9,''), status),
			       published_at      = CASE WHEN $9 = 'published'
			                                THEN COALESCE(published_at, now())
			                                ELSE published_at END,
			       updated_at        = now()
			 WHERE id = $1`,
			tID, strings.TrimSpace(req.Title), req.Instructions, req.OpensAt,
			req.ClosesAt, nullPositiveInt(req.Duration), nullPositiveInt(req.MaxAttempts),
			req.Shuffle, req.Status)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errEmptyPaper):
		httpx.BadRequest(w, r, "add at least one question before publishing this test")
		return
	case err != nil:
		if strings.Contains(err.Error(), "online_tests_window") {
			httpx.BadRequest(w, r, "closes_at must be after opens_at")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": tID.String()})
}

type testPaperRequest struct {
	Questions []struct {
		QuestionID string   `json:"question_id"`
		Marks      *float64 `json:"marks,omitempty"`
	} `json:"questions"`
}

var errSubjectiveOnObjectiveTest = errors.New("a subjective question on an auto-graded test")

/*
setOnlineTestQuestions replaces the paper in one transaction.

	Replace rather than append, because a paper is edited as a whole and
	appending leaves last week's draft interleaved with this week's.

	Two things are refused. A question from a subject the teacher does not
	teach, which would leak another department's bank into a paper. And a short
	or long answer question, because this is the objective test builder: nothing
	in the product can auto-mark prose, and accepting one would produce a test
	that silently never finishes marking.
*/
func (s *Server) setOnlineTestQuestions(w http.ResponseWriter, r *http.Request) {
	tID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid test id")
		return
	}
	var req testPaperRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	placed := 0
	var total float64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var section uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT section_id FROM online_tests WHERE id = $1`, tID).Scan(&section); err != nil {
			return err
		}
		if !reachesSection(res, section) {
			return errNotTaught
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM online_test_questions WHERE test_id = $1`, tID); err != nil {
			return err
		}

		for i, q := range req.Questions {
			qID, perr := uuid.Parse(q.QuestionID)
			if perr != nil {
				return perr
			}
			var csID uuid.UUID
			var kind string
			var defaultMarks float64
			if err := tx.QueryRow(r.Context(), `
				SELECT class_subject_id, kind, default_marks
				  FROM question_bank_questions WHERE id = $1 AND is_active`,
				qID).Scan(&csID, &kind, &defaultMarks); err != nil {
				return err
			}
			ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
			if cerr != nil {
				return cerr
			}
			if !ok {
				return errNotTaught
			}
			if !objectiveKinds[kind] {
				return errSubjectiveOnObjectiveTest
			}
			marks := defaultMarks
			if q.Marks != nil && *q.Marks > 0 {
				marks = *q.Marks
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO online_test_questions (institution_id, test_id, question_id,
				                                   sequence, marks)
				VALUES ($1,$2,$3,$4,$5)`,
				id.InstitutionID, tID, qID, i+1, marks); err != nil {
				return err
			}
			placed++
			total += marks
		}
		_, err := tx.Exec(r.Context(),
			`UPDATE online_tests SET updated_at = now() WHERE id = $1`, tID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errSubjectiveOnObjectiveTest):
		httpx.BadRequest(w, r,
			"only mcq, true_false and fill_blank questions can be auto-graded — "+
				"a short or long answer cannot go on an objective test")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"questions": placed, "total_marks": total,
	})
}

// --- CCE: the formative half --------------------------------------------------

/* Formative and summative are different in kind, not in weight.

   A summative is a paper: one date, one maximum, one mark, and the school
   already models it as exams -> exam_subjects -> marks. The summative endpoints
   below write into that and add no table.

   A formative is four activities gathered across a term and a sentence about
   how the child is getting on. cce_formative_entries holds the four components
   and the sentence, because marks has one numeric column and one free-text
   `remarks` and can hold neither honestly.

   They are related by shared keys rather than a shared table: both are grained
   on (student, class_subject, term), which is what the report card aggregates.
   The total of a term is the FA rows here plus the SA rows in marks, and
   nothing is stored twice. */

type formativeRow struct {
	StudentID     string   `json:"student_id"`
	AdmissionNo   string   `json:"admission_no"`
	Name          string   `json:"full_name"`
	RollNo        *int32   `json:"roll_no,omitempty"`
	EntryID       *string  `json:"entry_id,omitempty"`
	Written       *float64 `json:"written_work,omitempty"`
	Project       *float64 `json:"project_work,omitempty"`
	SlipTest      *float64 `json:"slip_test,omitempty"`
	Participation *float64 `json:"participation,omitempty"`
	ComponentMax  float64  `json:"component_max"`
	// Total is summed here and never stored: a stored total is the number that
	// disagrees with the four columns it came from.
	Total       *float64 `json:"total,omitempty"`
	MaxTotal    float64  `json:"max_total"`
	Observation *string  `json:"observation,omitempty"`
	Indicator   *string  `json:"indicator,omitempty"`
	RecordedBy  *string  `json:"recorded_by,omitempty"`
	RecordedAt  *string  `json:"recorded_at,omitempty"`
}

var formativeCycles = map[string]bool{"FA1": true, "FA2": true, "FA3": true, "FA4": true}

/*
listFormativeEntries returns the whole roster for a cycle, entered or not.

	A bare GET with no cycle answers FA1, and with no class_subject_id it
	answers for the first subject the teacher teaches, so the screen has
	something to show before anything is chosen.
*/
func (s *Server) listFormativeEntries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cycle := q.Get("cycle")
	if cycle == "" {
		cycle = "FA1"
	}
	if !formativeCycles[cycle] {
		httpx.BadRequest(w, r, "cycle must be FA1, FA2, FA3 or FA4")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	csID, sectionID, err := s.resolveCCETarget(r, res, q.Get("class_subject_id"), q.Get("section_id"))
	if err != nil {
		if errors.Is(err, errNotTaught) {
			httpx.Forbidden(w, r, "assessment for this class")
			return
		}
		if errors.Is(err, errNoTeaching) {
			// Nothing to show is not an error; a teacher with no timetable yet
			// gets an empty list rather than a 400 on a bare GET.
			respond(w, r, []formativeRow{}, nil)
			return
		}
		httpx.Internal(w, r, err)
		return
	}

	var termID *uuid.UUID
	if v := q.Get("term_id"); v != "" {
		t, perr := uuid.Parse(v)
		if perr != nil {
			httpx.BadRequest(w, r, "term_id must be a uuid")
			return
		}
		termID = &t
	}

	items, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.last_name), e.roll_no,
		       f.id::text, f.written_work, f.project_work, f.slip_test,
		       f.participation, COALESCE(f.component_max, 5),
		       f.observation, f.indicator, u.full_name,
		       to_char(f.recorded_at,'YYYY-MM-DD"T"HH24:MI:SSOF')
		  FROM enrollments e
		  JOIN students st ON st.id = e.student_id
		  LEFT JOIN cce_formative_entries f
		         ON f.student_id = st.id
		        AND f.class_subject_id = $1
		        AND f.cycle = $2
		        AND COALESCE(f.term_id, '00000000-0000-0000-0000-000000000000'::uuid)
		          = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
		  LEFT JOIN users u ON u.id = f.recorded_by
		 WHERE e.section_id = $3 AND e.status = 'active'
		 ORDER BY e.roll_no NULLS LAST, st.first_name`,
		[]any{csID, cycle, sectionID, termID},
		func(rows pgx.Rows) (formativeRow, error) {
			var v formativeRow
			if err := rows.Scan(&v.StudentID, &v.AdmissionNo, &v.Name, &v.RollNo,
				&v.EntryID, &v.Written, &v.Project, &v.SlipTest, &v.Participation,
				&v.ComponentMax, &v.Observation, &v.Indicator, &v.RecordedBy,
				&v.RecordedAt); err != nil {
				return v, err
			}
			v.MaxTotal = v.ComponentMax * 4
			// Summed only where something was entered: a child with nothing
			// recorded has no total, which is not the same as a total of zero.
			var sum float64
			any := false
			for _, c := range []*float64{v.Written, v.Project, v.SlipTest, v.Participation} {
				if c != nil {
					sum += *c
					any = true
				}
			}
			if any {
				v.Total = &sum
			}
			return v, nil
		})
	respond(w, r, items, err)
}

var errNoTeaching = errors.New("the caller teaches nothing")

/*
resolveCCETarget picks the class-subject and section an assessment screen is
about, defaulting to the first the caller teaches.

	A bare GET must return something useful. Without this a screen opens on a
	400 until the user has chosen from two dropdowns, which is a worse first
	impression than an empty roster.
*/
func (s *Server) resolveCCETarget(r *http.Request, res *scope.Resolved,
	csParam, secParam string) (uuid.UUID, uuid.UUID, error) {
	var csID, secID uuid.UUID
	id := httpx.IdentityFrom(r.Context())

	if csParam != "" {
		v, err := uuid.Parse(csParam)
		if err != nil {
			return csID, secID, err
		}
		csID = v
	}
	if secParam != "" {
		v, err := uuid.Parse(secParam)
		if err != nil {
			return csID, secID, err
		}
		if !reachesSection(res, v) {
			return csID, secID, errNotTaught
		}
		secID = v
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if csID != uuid.Nil {
			ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
			if cerr != nil {
				return cerr
			}
			if !ok {
				return errNotTaught
			}
		}
		if csID != uuid.Nil && secID != uuid.Nil {
			return nil
		}

		// Fall back to the first class-subject the caller teaches, and the
		// section it is taught in.
		where, args := taughtSubjectsPredicate(res, "cs", 1)
		sql := `
			SELECT cs.id, sec.id
			  FROM class_subjects cs
			  JOIN classes  c   ON c.id = cs.class_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			  JOIN sections sec ON sec.class_id = cs.class_id
			 WHERE ` + where
		if csID != uuid.Nil {
			args = append(args, csID)
			sql += " AND cs.id = $" + itoa(len(args))
		}
		if secID != uuid.Nil {
			args = append(args, secID)
			sql += " AND sec.id = $" + itoa(len(args))
		} else if !res.AllStudents && len(res.SectionIDs) > 0 {
			args = append(args, res.SectionIDs)
			sql += " AND sec.id = ANY($" + itoa(len(args)) + ")"
		}
		sql += " ORDER BY c.level, sub.name, sec.name LIMIT 1"

		err := tx.QueryRow(r.Context(), sql, args...).Scan(&csID, &secID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNoTeaching
		}
		return err
	})
	return csID, secID, err
}

type formativeSaveRequest struct {
	ClassSubjectID string  `json:"class_subject_id"`
	SectionID      string  `json:"section_id,omitempty"`
	TermID         string  `json:"term_id,omitempty"`
	Cycle          string  `json:"cycle"`
	ComponentMax   float64 `json:"component_max,omitempty"`
	Entries        []struct {
		StudentID     string   `json:"student_id"`
		Written       *float64 `json:"written_work"`
		Project       *float64 `json:"project_work"`
		SlipTest      *float64 `json:"slip_test"`
		Participation *float64 `json:"participation"`
		Observation   string   `json:"observation,omitempty"`
		Indicator     string   `json:"indicator,omitempty"`
	} `json:"entries"`
}

var errComponentOutOfRange = errors.New("a component above its maximum")
var errBadIndicator = errors.New("unrecognised indicator")

var formativeIndicators = map[string]bool{
	"excellent": true, "good": true, "satisfactory": true, "needs_support": true,
}

// saveFormativeEntries upserts a cycle's observations for a class.
//
// The descriptive fields are written alongside the numbers and never derived
// from them: a child scoring 18 of 20 who has stopped asking questions is
// exactly the case continuous assessment exists to catch, and an indicator
// computed from the total would erase it.
//
// Each entry replaces the row rather than merging into it. The screen is a
// grid the teacher submits whole, and merge semantics would make a component
// impossible to clear: a 5 typed into the wrong column could be corrected to
// another number but never back to blank, and "not yet assessed" would decay
// into a mark nobody gave.
func (s *Server) saveFormativeEntries(w http.ResponseWriter, r *http.Request) {
	var req formativeSaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !formativeCycles[req.Cycle] {
		httpx.BadRequest(w, r, "cycle must be FA1, FA2, FA3 or FA4")
		return
	}
	csID, err := uuid.Parse(req.ClassSubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	if len(req.Entries) == 0 {
		httpx.BadRequest(w, r, "entries must not be empty")
		return
	}
	if req.ComponentMax <= 0 {
		req.ComponentMax = 5
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	written := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			return errNotTaught
		}

		for _, e := range req.Entries {
			sid, perr := uuid.Parse(e.StudentID)
			if perr != nil {
				return perr
			}
			// The strict reach test: active enrolment only. A child who left in
			// July must not collect a new formative observation.
			reach, rerr := reachesTaughtStudent(r.Context(), tx, res, sid)
			if rerr != nil {
				return rerr
			}
			if !reach {
				return errNotTaught
			}
			for _, c := range []*float64{e.Written, e.Project, e.SlipTest, e.Participation} {
				if c != nil && (*c < 0 || *c > req.ComponentMax) {
					return errComponentOutOfRange
				}
			}
			if e.Indicator != "" && !formativeIndicators[e.Indicator] {
				return errBadIndicator
			}

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO cce_formative_entries (institution_id, student_id,
				        class_subject_id, term_id, cycle, written_work, project_work,
				        slip_test, participation, component_max, observation,
				        indicator, recorded_by)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''),NULLIF($12,''),$13)
				ON CONFLICT (student_id, class_subject_id, cycle,
				             COALESCE(term_id,'00000000-0000-0000-0000-000000000000'::uuid))
				DO UPDATE SET written_work  = EXCLUDED.written_work,
				              project_work  = EXCLUDED.project_work,
				              slip_test     = EXCLUDED.slip_test,
				              participation = EXCLUDED.participation,
				              component_max = EXCLUDED.component_max,
				              observation   = EXCLUDED.observation,
				              indicator     = EXCLUDED.indicator,
				              recorded_by   = EXCLUDED.recorded_by,
				              updated_at    = now()`,
				id.InstitutionID, sid, csID, nullUUID(req.TermID), req.Cycle,
				e.Written, e.Project, e.SlipTest, e.Participation,
				req.ComponentMax, e.Observation, e.Indicator, id.UserID); err != nil {
				return err
			}
			written++
		}
		return nil
	})
	switch {
	case errors.Is(err, errNotTaught):
		httpx.Forbidden(w, r, "recording assessment for this child")
		return
	case errors.Is(err, errComponentOutOfRange):
		httpx.BadRequest(w, r, "each component must be between zero and component_max")
		return
	case errors.Is(err, errBadIndicator):
		httpx.BadRequest(w, r,
			"indicator must be excellent, good, satisfactory or needs_support")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": written, "cycle": req.Cycle})
}

// --- CCE: the summative half --------------------------------------------------

type summativePaper struct {
	ExamSubjectID string   `json:"exam_subject_id"`
	ExamID        string   `json:"exam_id"`
	ExamName      string   `json:"exam_name"`
	Kind          string   `json:"kind"`
	ClassName     string   `json:"class_name"`
	Subject       string   `json:"subject"`
	ExamDate      *string  `json:"exam_date,omitempty"`
	MaxMarks      float64  `json:"max_marks"`
	PassMarks     float64  `json:"pass_marks"`
	Entered       int32    `json:"entered"`
	Roll          int32    `json:"roll"`
	IsPublished   bool     `json:"is_published"`
	Average       *float64 `json:"average,omitempty"`
}

/*
listSummativePapers lists the papers a teacher may enter marks against.

	Nothing new is stored for the summative half. exams(kind='summative') is
	already in the schema's own check constraint, exam_subjects already carries
	the date and the maximum, and marks already derives a grade from the
	grading scale. A parallel CCE marks table would have been a second place a
	child's SA1 lived.
*/
func (s *Server) listSummativePapers(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	where, args := taughtSubjectsPredicate(res, "cs", 1)
	// Summative by default because that is the screen, but a school running
	// CCE through term exams needs those too, so the filter is overridable.
	kind := r.URL.Query().Get("kind")
	if kind != "" {
		args = append(args, kind)
		where += " AND e.kind = $" + itoa(len(args))
	} else {
		where += " AND e.kind IN ('summative','term','unit_test','periodic')"
	}

	items, err := collect(s, r, `
		SELECT es.id::text, e.id::text, e.name, e.kind, c.name, sub.name,
		       to_char(es.exam_date,'YYYY-MM-DD'), es.max_marks, es.pass_marks,
		       (SELECT count(*) FROM marks m WHERE m.exam_subject_id = es.id)::int,
		       (SELECT count(*) FROM enrollments en
		         JOIN sections s2 ON s2.id = en.section_id
		        WHERE s2.class_id = cs.class_id AND en.status = 'active')::int,
		       e.is_published,
		       (SELECT avg(m.marks_obtained) FROM marks m
		         WHERE m.exam_subject_id = es.id AND NOT m.is_absent)
		  FROM exam_subjects es
		  JOIN exams          e ON e.id = es.exam_id
		  JOIN class_subjects cs ON cs.id = es.class_subject_id
		  JOIN classes         c ON c.id = cs.class_id
		  JOIN subjects      sub ON sub.id = cs.subject_id
		 WHERE `+where+`
		 ORDER BY es.exam_date DESC NULLS LAST, c.level, sub.name
		 LIMIT 200`, args,
		func(rows pgx.Rows) (summativePaper, error) {
			var v summativePaper
			return v, rows.Scan(&v.ExamSubjectID, &v.ExamID, &v.ExamName, &v.Kind,
				&v.ClassName, &v.Subject, &v.ExamDate, &v.MaxMarks, &v.PassMarks,
				&v.Entered, &v.Roll, &v.IsPublished, &v.Average)
		})
	respond(w, r, items, err)
}

type summativeRosterRow struct {
	StudentID   string   `json:"student_id"`
	AdmissionNo string   `json:"admission_no"`
	Name        string   `json:"full_name"`
	RollNo      *int32   `json:"roll_no,omitempty"`
	Marks       *float64 `json:"marks_obtained,omitempty"`
	Grade       *string  `json:"grade,omitempty"`
	IsAbsent    bool     `json:"is_absent"`
	Remarks     *string  `json:"remarks,omitempty"`
	EnteredBy   *string  `json:"entered_by,omitempty"`
}

/*
listSummativeRoster returns every child sitting a paper, marked or not.

	Marks are entered against the class roll, so the roll is what the screen
	needs: a list of the marks already entered can never show the teacher whose
	paper is still unmarked. The child is reached through the paper's own
	class, and the caller must teach that class.
*/
func (s *Server) listSummativeRoster(w http.ResponseWriter, r *http.Request) {
	var esID uuid.UUID
	if q := strings.TrimSpace(r.URL.Query().Get("exam_subject_id")); q != "" {
		v, err := uuid.Parse(q)
		if err != nil {
			httpx.BadRequest(w, r, "exam_subject_id must be a uuid")
			return
		}
		esID = v
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var csID uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Named nothing: answer for the first paper the caller could mark, so
		// the screen opens on a real class roll instead of on an error.
		if esID == uuid.Nil {
			where, args := taughtSubjectsPredicate(res, "cs", 1)
			err := tx.QueryRow(r.Context(), `
				SELECT es.id
				  FROM exam_subjects es
				  JOIN exams          e ON e.id = es.exam_id
				  JOIN class_subjects cs ON cs.id = es.class_subject_id
				 WHERE `+where+`
				   AND e.kind IN ('summative','term','unit_test','periodic')
				 ORDER BY es.exam_date DESC NULLS LAST
				 LIMIT 1`, args...).Scan(&esID)
			if errors.Is(err, pgx.ErrNoRows) {
				return errNoTeaching
			}
			if err != nil {
				return err
			}
		}
		if err := tx.QueryRow(r.Context(),
			`SELECT class_subject_id FROM exam_subjects WHERE id = $1`, esID).Scan(&csID); err != nil {
			return err
		}
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			return errNotTaught
		}
		return nil
	})
	switch {
	case errors.Is(err, errNoTeaching):
		// A teacher with no papers yet gets an empty roll, not an error.
		respond(w, r, []summativeRosterRow{}, nil)
		return
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errNotTaught):
		// Indistinguishable from a paper that does not exist, so the endpoint
		// cannot be walked to discover another department's exams.
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}

	// Narrowed to the caller's own sections as well as the paper's class: a
	// head of department teaching one section of Grade 9 marks that section.
	where, args := taughtStudentsPredicate(res, "st.id", 3)
	items, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.last_name), e.roll_no,
		       m.marks_obtained, m.grade, COALESCE(m.is_absent, false), m.remarks,
		       u.full_name
		  FROM enrollments e
		  JOIN students st ON st.id = e.student_id
		  JOIN sections sec ON sec.id = e.section_id
		  JOIN class_subjects cs ON cs.id = $2
		  LEFT JOIN marks m ON m.exam_subject_id = $1 AND m.student_id = st.id
		  LEFT JOIN users u ON u.id = m.entered_by
		 WHERE e.status = 'active'
		   AND sec.class_id = cs.class_id
		   AND `+where+`
		 ORDER BY e.roll_no NULLS LAST, st.first_name`,
		append([]any{esID, csID}, args...),
		func(rows pgx.Rows) (summativeRosterRow, error) {
			var v summativeRosterRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.Name, &v.RollNo,
				&v.Marks, &v.Grade, &v.IsAbsent, &v.Remarks, &v.EnteredBy)
		})
	respond(w, r, items, err)
}

type summativeSaveRequest struct {
	ExamSubjectID string `json:"exam_subject_id"`
	Entries       []struct {
		StudentID string   `json:"student_id"`
		Marks     *float64 `json:"marks_obtained"`
		IsAbsent  bool     `json:"is_absent"`
		Remarks   string   `json:"remarks,omitempty"`
	} `json:"entries"`
}

var errSummativeOutOfRange = errors.New("a mark outside the paper's range")

/*
saveSummativeMarks enters a summative paper's marks, scoped to the teacher.

	This writes the same rows as POST /api/v1/academics/marks and derives the
	grade the same way. It exists separately because that endpoint checks
	academics.marks.write and then trusts the exam_subject_id it is given: it
	never asks whether the caller teaches that class. From inside /teaching,
	where the group permission is one a student also holds, that would be a
	teacher entering marks for any paper in the school. Every entry here is
	checked against the caller's active-enrolment reach first.
*/
func (s *Server) saveSummativeMarks(w http.ResponseWriter, r *http.Request) {
	var req summativeSaveRequest
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
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	written := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var csID uuid.UUID
		var maxMarks float64
		var scaleID *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT es.class_subject_id, es.max_marks, e.grading_scale_id
			  FROM exam_subjects es JOIN exams e ON e.id = es.exam_id
			 WHERE es.id = $1`, esID).Scan(&csID, &maxMarks, &scaleID); err != nil {
			return err
		}
		ok, cerr := classSubjectTaught(r.Context(), tx, res, csID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			return errNotTaught
		}

		for _, e := range req.Entries {
			sid, perr := uuid.Parse(e.StudentID)
			if perr != nil {
				return perr
			}
			reach, rerr := reachesTaughtStudent(r.Context(), tx, res, sid)
			if rerr != nil {
				return rerr
			}
			if !reach {
				return errNotTaught
			}
			if e.Marks != nil && (*e.Marks < 0 || *e.Marks > maxMarks) {
				return errSummativeOutOfRange
			}

			// Grade is derived from the school's band table, never taken from
			// the client: a supplied grade could contradict the marks beside it.
			var grade *string
			if e.Marks != nil && !e.IsAbsent && scaleID != nil && maxMarks > 0 {
				pct := *e.Marks / maxMarks * 100
				var g string
				gerr := tx.QueryRow(r.Context(), `
					SELECT grade FROM grade_bands
					 WHERE grading_scale_id = $1 AND $2 BETWEEN min_percent AND max_percent
					 LIMIT 1`, *scaleID, pct).Scan(&g)
				if gerr == nil {
					grade = &g
				} else if !errors.Is(gerr, pgx.ErrNoRows) {
					return gerr
				}
			}

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO marks (institution_id, exam_subject_id, student_id,
				                   marks_obtained, grade, is_absent, remarks,
				                   entered_by, entered_at)
				VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8, now())
				ON CONFLICT (exam_subject_id, student_id) DO UPDATE
				   SET marks_obtained = EXCLUDED.marks_obtained,
				       grade          = EXCLUDED.grade,
				       is_absent      = EXCLUDED.is_absent,
				       remarks        = EXCLUDED.remarks,
				       entered_by     = EXCLUDED.entered_by,
				       entered_at     = now()`,
				id.InstitutionID, esID, sid, e.Marks, grade, e.IsAbsent,
				e.Remarks, id.UserID); err != nil {
				return err
			}
			written++
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errNotTaught):
		httpx.Forbidden(w, r, "entering marks for this class")
		return
	case errors.Is(err, errSummativeOutOfRange):
		httpx.BadRequest(w, r, "marks must be between zero and the paper maximum")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": written})
}

// --- small helpers ------------------------------------------------------------

// nullUUID turns an absent id into a SQL NULL rather than the zero uuid, which
// would fail a foreign key with a message nobody can read.
func nullUUID(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

// nullPositiveInt keeps COALESCE-style partial updates honest: zero means "not sent"
// for these columns, and writing it would blank a duration the user never named.
func nullPositiveInt(n int) *int {
	if n <= 0 {
		return nil
	}
	return &n
}

// isDBError distinguishes a driver failure from a validation message this file
// produced, so the latter can be reported as a 400 instead of a 500.
func isDBError(err error) bool {
	var pgErr interface{ SQLState() string }
	return errors.As(err, &pgErr)
}
