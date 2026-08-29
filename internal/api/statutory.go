package api

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Statutory filings: what the school sends the state, and what it keeps.

   Five features share this file because they share one shape. A return is a
   snapshot with a name against it — not a query re-run later. The UDISE+ figure
   a district office disputes in 2029 is defended by what was filed in 2026, and
   re-deriving it from tables that have since been corrected answers a different
   question truthfully and uselessly. So every "file" verb here freezes rows and
   stamps who and when, and nothing unfreezes them.

   What is deliberately not here, because it already exists:

     The board roll. internal/api/board_exams.go owns board_registrations, its
     amendment workflow and its result import. The List of Candidates below is a
     *filing* of those rows — it reads them, validates them and copies them. It
     does not register anybody. A second candidate register would drift from the
     first within one exam session.

     The SQAA framework. internal/api/platform_config.go owns sqaa_frameworks
     and sqaa_standards, which the vendor publishes and every school reads. What
     is added here is only the school's side: its rating, its evidence and its
     action plan. A per-tenant copy of the framework would let a school edit the
     standard it is measured against, which is the one thing an assurance
     framework must not permit.

     The calendar and the timetable. holidays (with its 'working_day' escape
     hatch) and timetable_entries × periods already say which days the school
     opened and how long each one was. Working days are counted from those, not
     from a third calendar that would disagree with both by March.

     File storage. Evidence is a files(id) reference, minted by
     POST /api/v1/files/presign. external_url is accepted alongside it because
     R2 is unconfigured on this deployment and presign answers 503 — the same
     concession study_materials made in 00041.

   Route prefix is /statutory, mounted on the top-level v1 router. The platform
   tier sits under /statutory/portal rather than in the /admin group, because
   mounting into /admin would mean editing api.go, which this file does not own. */

// mountStatutory registers the statutory returns, the board LOC filing, SQAA
// compliance tracking and the platform-tier Child Info portal connector.
//
// Called with the top-level /api/v1 router. Every permission used is already in
// internal/rbac/rbac.go; nothing new is invented. The gating follows what the
// existing /compliance group established — admin.reports.read to read a return,
// the write key of whatever the return is *about* to change it.
func (s *Server) mountStatutory(r chi.Router) {
	// Reading a statutory return is reading a report about the school.
	read := httpx.RequirePermission(rbac.ReportsRead)
	// The LOC is a board examination artefact and reuses the board roll's keys,
	// so the clerk who built the roll can file it without a second grant.
	examWrite := httpx.RequirePermission(rbac.ExamsWrite)
	// Reconciliation writes student identifiers, which is the same capability
	// POST /compliance/apaar already needs.
	studentWrite := httpx.RequirePermission(rbac.StudentsWrite)
	// The calendar is academics; an adjustment to it is an academics write.
	academicsWrite := httpx.RequirePermission(rbac.AcademicsWrite)
	// Filing a return to the state, and the school's own assurance record.
	fileReturn := httpx.RequirePermission(rbac.InstitutionWrite)
	// The vendor. institution_admin holds neither platform key, which is what
	// keeps a school out of the portal connector and its credentials.
	vendor := httpx.RequirePermission(rbac.PlatformTenantsRW)

	r.Route("/statutory", func(r chi.Router) {
		// --- Board exam List of Candidates ------------------------------
		r.With(read).Get("/loc/submissions", s.listLOCSubmissions)
		r.With(read).Get("/loc/submissions/{id}", s.getLOCSubmission)
		r.With(read).Get("/loc/submissions/{id}/export", s.exportLOCSubmission)
		r.With(examWrite).Post("/loc/submissions", s.createLOCSubmission)
		r.With(examWrite).Post("/loc/submissions/{id}/validate", s.validateLOCSubmission)
		r.With(examWrite).Post("/loc/submissions/{id}/file", s.fileLOCSubmission)
		r.With(read).Get("/loc/subject-rules", s.listLOCSubjectRules)
		r.With(examWrite).Post("/loc/subject-rules", s.saveLOCSubjectRule)
		r.With(examWrite).Delete("/loc/subject-rules/{id}", s.deleteLOCSubjectRule)

		// --- SQAA compliance tracking -----------------------------------
		r.With(read).Get("/sqaa/frameworks", s.listSQAASchoolFrameworks)
		r.With(read).Get("/sqaa/assessments", s.listSQAAAssessments)
		r.With(read).Get("/sqaa/assessments/{id}", s.getSQAAAssessment)
		r.With(fileReturn).Post("/sqaa/assessments", s.createSQAAAssessment)
		r.With(fileReturn).Put("/sqaa/assessments/{id}/entries", s.saveSQAAEntry)
		r.With(fileReturn).Post("/sqaa/assessments/{id}/submit", s.submitSQAAAssessment)
		r.With(fileReturn).Post("/sqaa/entries/{id}/evidence", s.addSQAAEvidence)
		r.With(fileReturn).Delete("/sqaa/evidence/{id}", s.removeSQAAEvidence)
		r.With(read).Get("/sqaa/actions", s.listSQAAActions)
		r.With(fileReturn).Post("/sqaa/actions", s.saveSQAAAction)

		// --- Child Info reconciliation ----------------------------------
		r.With(read).Get("/child-info/imports", s.listChildInfoImports)
		r.With(read).Get("/child-info/differences", s.listChildInfoDifferences)
		r.With(read).Get("/child-info/resolutions", s.listChildInfoResolutions)
		r.With(studentWrite).Post("/child-info/import", s.importChildInfoExtract)
		r.With(studentWrite).Post("/child-info/differences/{id}/resolve", s.resolveChildInfoDifference)
		r.With(studentWrite).Delete("/child-info/resolutions/{id}", s.forgetChildInfoResolution)

		// --- Working days and instructional hours -----------------------
		r.With(read).Get("/working-days", s.getWorkingDays)
		r.With(read).Get("/working-days/norms", s.listInstructionalNorms)
		r.With(academicsWrite).Put("/working-days/norms", s.saveInstructionalNorm)
		r.With(read).Get("/working-days/adjustments", s.listWorkingDayAdjustments)
		r.With(academicsWrite).Post("/working-days/adjustments", s.saveWorkingDayAdjustment)
		r.With(academicsWrite).Delete("/working-days/adjustments/{id}", s.deleteWorkingDayAdjustment)
		r.With(read).Get("/working-days/returns", s.listWorkingDaysReturns)
		r.With(fileReturn).Post("/working-days/returns", s.fileWorkingDaysReturn)

		// --- Platform: the Child Info portal connector ------------------
		//
		// Gated twice on purpose. The permission says what the caller may do;
		// PlatformAdmin says how far they can see, and these rows belong to no
		// school. The RLS policy on the tables has no tenant limb either, so a
		// handler that forgot both would still read nothing.
		r.With(vendor).Get("/portal/connectors", s.listChildInfoConnectors)
		r.With(vendor).Post("/portal/connectors", s.saveChildInfoConnector)
		r.With(vendor).Delete("/portal/connectors/{id}", s.deleteChildInfoConnector)
		r.With(vendor).Get("/portal/runs", s.listChildInfoRuns)
		r.With(vendor).Post("/portal/connectors/{id}/runs", s.recordChildInfoRun)
		r.With(vendor).Get("/portal/export", s.exportChildInfoRoster)
	})
}

// --- small shared helpers ----------------------------------------------------

// resolveAcademicYear picks the year the caller asked for, or the current one.
func resolveAcademicYear(r *http.Request, tx pgx.Tx, want string) (uuid.UUID, string, time.Time, time.Time, error) {
	var (
		id               uuid.UUID
		name             string
		starts, ends     time.Time
		sql              string
		args             []any
		trimmed          = strings.TrimSpace(want)
		selectYearColumn = `SELECT id, name, starts_on, ends_on FROM academic_years `
	)
	if trimmed != "" {
		parsed, err := uuid.Parse(trimmed)
		if err != nil {
			return id, "", starts, ends, errors.New("academic_year_id must be a uuid")
		}
		sql = selectYearColumn + `WHERE id = $1`
		args = []any{parsed}
	} else {
		sql = selectYearColumn + `ORDER BY is_current DESC, starts_on DESC LIMIT 1`
	}
	err := tx.QueryRow(r.Context(), sql, args...).Scan(&id, &name, &starts, &ends)
	if errors.Is(err, pgx.ErrNoRows) {
		return id, "", starts, ends, errors.New("no academic year exists yet, create one first")
	}
	return id, name, starts, ends, err
}

// dateString renders a nullable date the way every other endpoint here does.
func dateString(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format("2006-01-02")
	return &s
}

// blank reports whether a nullable text column is absent or whitespace.
func blank(p *string) bool { return p == nil || strings.TrimSpace(*p) == "" }

// deref lives in banking.go — same helper, identical body, one definition.

// foldKey normalises a value for comparison: case, spacing and punctuation are
// not differences a state portal and a school register should argue about.
func foldKey(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune(' ')
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// statutoryScope is tenantScope with the institution asserted. Every
// institution-scoped handler below needs a school; a platform operator reaches
// them by naming one through X-Acting-Institution.
func statutoryScope(id *httpx.Identity) database.Scope { return tenantScope(id) }

// writeCSV streams a report the way export.go does, with the BOM Excel needs to
// read Telugu names as Telugu rather than as mojibake.
func writeCSV(w http.ResponseWriter, filename string, header []string, rows [][]string) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
	cw := csv.NewWriter(w)
	_ = cw.Write(header)
	for _, row := range rows {
		_ = cw.Write(row)
	}
	cw.Flush()
}

// ============================================================================
// 1. Board Exam LOC submission
// ============================================================================

/* The List of Candidates a school files with its board before the exams.

   The export is the easy half. The half that matters is the refusal list: a
   rejected LOC comes back with the board unhelpful about which of three hundred
   rows was wrong, and the school re-files under a deadline it has already half
   spent. So validation runs against every candidate and names each one, with the
   field and the reason, before anything is sent.

   Blockers hold the filing back; warnings go with it and are recorded. The
   distinction is whether the board will reject the file, or merely whether the
   school will later wish it had noticed. */

type locSubmissionRow struct {
	ID             string  `json:"id"`
	AcademicYearID string  `json:"academic_year_id"`
	Board          string  `json:"board"`
	ExamName       string  `json:"exam_name"`
	Stage          *string `json:"stage,omitempty"`
	Title          string  `json:"title"`
	FeePaise       int64   `json:"fee_per_candidate_paise"`
	Status         string  `json:"status"`
	Candidates     int     `json:"candidate_count"`
	Blockers       int     `json:"blocker_count"`
	Warnings       int     `json:"warning_count"`
	ValidatedAt    *string `json:"validated_at,omitempty"`
	FiledAt        *string `json:"filed_at,omitempty"`
	FiledBy        *string `json:"filed_by,omitempty"`
	BoardAckNo     *string `json:"board_ack_no,omitempty"`
	Notes          *string `json:"notes,omitempty"`
	CreatedAt      string  `json:"created_at"`
}

type locCandidateRow struct {
	ID             string   `json:"id"`
	RegistrationID *string  `json:"registration_id,omitempty"`
	StudentID      *string  `json:"student_id,omitempty"`
	SerialNo       int      `json:"serial_no"`
	CandidateName  *string  `json:"candidate_name,omitempty"`
	FatherName     *string  `json:"father_name,omitempty"`
	MotherName     *string  `json:"mother_name,omitempty"`
	DateOfBirth    *string  `json:"date_of_birth,omitempty"`
	Gender         *string  `json:"gender,omitempty"`
	ClassLabel     *string  `json:"class_label,omitempty"`
	AdmissionNo    *string  `json:"admission_no,omitempty"`
	Medium         *string  `json:"medium,omitempty"`
	SecondLanguage *string  `json:"second_language,omitempty"`
	GroupCode      *string  `json:"group_code,omitempty"`
	CandidateType  *string  `json:"candidate_type,omitempty"`
	APAARID        *string  `json:"apaar_id,omitempty"`
	RegistrationNo *string  `json:"registration_no,omitempty"`
	HallTicketNo   *string  `json:"hall_ticket_no,omitempty"`
	Subjects       []string `json:"subjects"`
	FeePaidPaise   int64    `json:"fee_paid_paise"`
	HasPhoto       bool     `json:"has_photo"`
	HasSignature   bool     `json:"has_signature"`
}

type locIssueRow struct {
	RegistrationID *string `json:"registration_id,omitempty"`
	StudentID      *string `json:"student_id,omitempty"`
	CandidateName  *string `json:"candidate_name,omitempty"`
	AdmissionNo    *string `json:"admission_no,omitempty"`
	Severity       string  `json:"severity"`
	Code           string  `json:"code"`
	Field          *string `json:"field,omitempty"`
	Message        string  `json:"message"`
}

type locSubmissionDetail struct {
	Submission locSubmissionRow  `json:"submission"`
	Candidates []locCandidateRow `json:"candidates"`
	Issues     []locIssueRow     `json:"issues"`
	// Frozen says the snapshot is what was filed and no longer tracks the board
	// roll. The screen must say so plainly, or a clerk will correct a name here
	// and believe the board has been told.
	Frozen bool `json:"frozen"`
}

// locSource is one board_registrations row as the validator sees it, joined to
// the facts the LOC needs that the registration does not itself carry.
type locSource struct {
	RegistrationID string
	StudentID      string
	AdmissionNo    string
	ClassLabel     *string
	Gender         *string
	CandidateName  *string
	FatherName     *string
	MotherName     *string
	DateOfBirth    *time.Time
	Medium         *string
	SecondLanguage *string
	GroupCode      *string
	CandidateType  *string
	APAARID        *string
	RegistrationNo *string
	HallTicketNo   *string
	SubjectsRaw    []byte
	FeePaidPaise   int64
	HasPhoto       bool
	HasSignature   bool
	Subjects       []string
}

func (s *Server) listLOCSubmissions(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT l.id::text, l.academic_year_id::text, l.board, l.exam_name, l.stage,
		       l.title, l.fee_per_candidate_paise, l.status, l.candidate_count,
		       l.blocker_count, l.warning_count,
		       to_char(l.validated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       to_char(l.filed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       u.full_name, l.board_ack_no, l.notes,
		       to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
		  FROM loc_submissions l
		  LEFT JOIN users u ON u.id = l.filed_by
		 ORDER BY l.created_at DESC`, nil,
		func(rows pgx.Rows) (locSubmissionRow, error) {
			var v locSubmissionRow
			return v, rows.Scan(&v.ID, &v.AcademicYearID, &v.Board, &v.ExamName, &v.Stage,
				&v.Title, &v.FeePaise, &v.Status, &v.Candidates, &v.Blockers, &v.Warnings,
				&v.ValidatedAt, &v.FiledAt, &v.FiledBy, &v.BoardAckNo, &v.Notes, &v.CreatedAt)
		})
	respond(w, r, items, err)
}

type locSubmissionRequest struct {
	AcademicYearID string `json:"academic_year_id"`
	Board          string `json:"board"`
	ExamName       string `json:"exam_name"`
	Stage          string `json:"stage"`
	Title          string `json:"title"`
	FeePaise       int64  `json:"fee_per_candidate_paise"`
	Notes          string `json:"notes"`
}

var (
	errLOCDraftExists = errors.New(
		"a draft List of Candidates already exists for this board, exam and stage - " +
			"finish or cancel that one rather than starting a second, or half the roll gets filed twice")
	errLOCFrozen = errors.New(
		"this List of Candidates has been filed. What was sent to the board cannot be " +
			"rewritten; correct the roll and file a fresh list")
	errLOCBlocked = errors.New(
		"candidates in this list would be rejected by the board. Fix the blockers, " +
			"or remove those candidates from the roll, then file")
)

// createLOCSubmission opens a draft and populates it from the board roll.
//
// The candidates are copied immediately rather than at filing time, because the
// point of a draft is to be looked at: a school wants the refusal list in
// December so it can fix it in January, and a submission that stays empty until
// the moment it is filed cannot show anybody anything.
func (s *Server) createLOCSubmission(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req locSubmissionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Board = strings.TrimSpace(req.Board)
	req.ExamName = strings.TrimSpace(req.ExamName)
	req.Stage = strings.TrimSpace(req.Stage)
	req.Title = strings.TrimSpace(req.Title)
	if req.Board == "" || req.ExamName == "" {
		httpx.BadRequest(w, r, "board and exam_name are required")
		return
	}
	if req.FeePaise < 0 {
		httpx.BadRequest(w, r, "fee_per_candidate_paise cannot be negative")
		return
	}
	if _, ok := boardStages[req.Stage]; req.Stage != "" && !ok {
		httpx.BadRequest(w, r, "stage must be ssc, inter_first_year or inter_second_year")
		return
	}

	var out string
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		yearID, yearName, _, _, err := resolveAcademicYear(r, tx, req.AcademicYearID)
		if err != nil {
			return err
		}
		if req.Title == "" {
			req.Title = req.ExamName + " " + yearName
		}
		err = tx.QueryRow(r.Context(), `
			INSERT INTO loc_submissions
			    (institution_id, academic_year_id, board, exam_name, stage, title,
			     fee_per_candidate_paise, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			RETURNING id::text`,
			id.InstitutionID, yearID, req.Board, req.ExamName, nullString(req.Stage),
			req.Title, req.FeePaise, nullString(req.Notes), nullUUIDArg(id.UserID)).Scan(&out)
		if isUniqueViolation(err) {
			return errLOCDraftExists
		}
		if err != nil {
			return err
		}
		subID, err := uuid.Parse(out)
		if err != nil {
			return err
		}
		_, _, err = s.rebuildLOC(r, tx, id.InstitutionID, subID)
		return err
	})
	switch {
	case errors.Is(err, errLOCDraftExists):
		httpx.Error(w, r, http.StatusConflict, "draft_exists", err.Error())
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
	}
}

/*
rebuildLOC re-reads the board roll into a draft and revalidates it.

	Destructive by design: it deletes the draft's candidates and issues and
	writes them again. A draft is a view of the roll as it stands, so a candidate
	whose registration was withdrawn since the last run must disappear rather than
	linger as a row nobody can explain. The caller must have checked the
	submission is still a draft — a filed one is frozen and never comes here.

	Returns the blocker and warning counts.
*/
func (s *Server) rebuildLOC(r *http.Request, tx pgx.Tx, inst, subID uuid.UUID) (int, int, error) {
	ctx := r.Context()

	var (
		board, examName string
		stage           *string
		yearID          uuid.UUID
		feePaise        int64
	)
	err := tx.QueryRow(ctx, `
		SELECT board, exam_name, stage, academic_year_id, fee_per_candidate_paise
		  FROM loc_submissions WHERE id = $1`, subID).
		Scan(&board, &examName, &stage, &yearID, &feePaise)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, errors.New("no such List of Candidates")
	}
	if err != nil {
		return 0, 0, err
	}

	/* Who is on the list.

	   Every registration for this sitting except the ones the board has already
	   refused: a rejected candidate is not re-filed by accident, and a draft
	   candidate absolutely is on the list — being incomplete is the thing the
	   validation report exists to say out loud.

	   The photo falls back to students.photo_file_id so a school that has not
	   re-uploaded per-registration images is not blocked on day one. There is no
	   fallback for the signature: nothing else in the schema holds one. */
	rows, err := tx.Query(ctx, `
		SELECT br.id::text, br.student_id::text, st.admission_no,
		       c.name, st.gender,
		       br.candidate_name, br.father_name, br.mother_name, br.date_of_birth,
		       br.medium, br.second_language, br.group_code, br.candidate_type,
		       br.apaar_id, br.registration_no, br.hall_ticket_no,
		       br.subjects, br.fee_paid_paise,
		       (COALESCE(br.photo_file_id, st.photo_file_id) IS NOT NULL),
		       (br.signature_file_id IS NOT NULL)
		  FROM board_registrations br
		  JOIN students st ON st.id = br.student_id
		  LEFT JOIN classes c ON c.id = br.class_id
		 WHERE br.academic_year_id = $1
		   AND lower(br.board) = lower($2)
		   AND lower(br.exam_name) = lower($3)
		   AND ($4::text IS NULL OR br.stage = $4)
		   AND br.status <> 'rejected'
		 ORDER BY c.level NULLS LAST, st.last_name, st.first_name, st.admission_no`,
		yearID, board, examName, stage)
	if err != nil {
		return 0, 0, err
	}
	var sources []locSource
	for rows.Next() {
		var v locSource
		if err := rows.Scan(&v.RegistrationID, &v.StudentID, &v.AdmissionNo,
			&v.ClassLabel, &v.Gender, &v.CandidateName, &v.FatherName, &v.MotherName,
			&v.DateOfBirth, &v.Medium, &v.SecondLanguage, &v.GroupCode, &v.CandidateType,
			&v.APAARID, &v.RegistrationNo, &v.HallTicketNo, &v.SubjectsRaw,
			&v.FeePaidPaise, &v.HasPhoto, &v.HasSignature); err != nil {
			rows.Close()
			return 0, 0, err
		}
		// board_registrations.subjects is a flat array of names, written by
		// board_exams.go from a comma-separated field. Anything else is treated
		// as no subjects, which the validator then reports.
		_ = json.Unmarshal(v.SubjectsRaw, &v.Subjects)
		sources = append(sources, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}

	rules, err := loadLOCRules(r, tx, board, stage)
	if err != nil {
		return 0, 0, err
	}

	if _, err := tx.Exec(ctx, `DELETE FROM loc_validation_issues WHERE submission_id = $1`, subID); err != nil {
		return 0, 0, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM loc_candidates WHERE submission_id = $1`, subID); err != nil {
		return 0, 0, err
	}

	blockers, warnings := 0, 0
	for i, src := range sources {
		serial := i + 1
		subjectsJSON, err := json.Marshal(src.Subjects)
		if err != nil {
			return 0, 0, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO loc_candidates
			    (institution_id, submission_id, registration_id, student_id, serial_no,
			     candidate_name, father_name, mother_name, date_of_birth, gender,
			     class_label, admission_no, medium, second_language, group_code,
			     candidate_type, apaar_id, registration_no, hall_ticket_no,
			     subjects, fee_paid_paise, has_photo, has_signature)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
			        $20,$21,$22,$23)`,
			inst, subID, src.RegistrationID, src.StudentID, serial,
			src.CandidateName, src.FatherName, src.MotherName, src.DateOfBirth, src.Gender,
			src.ClassLabel, src.AdmissionNo, src.Medium, src.SecondLanguage, src.GroupCode,
			src.CandidateType, src.APAARID, src.RegistrationNo, src.HallTicketNo,
			subjectsJSON, src.FeePaidPaise, src.HasPhoto, src.HasSignature); err != nil {
			return 0, 0, err
		}

		for _, issue := range locProblems(src, rules, feePaise) {
			if issue.Severity == "blocker" {
				blockers++
			} else {
				warnings++
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO loc_validation_issues
				    (institution_id, submission_id, registration_id, student_id,
				     candidate_name, admission_no, severity, code, field, message)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
				inst, subID, src.RegistrationID, src.StudentID,
				src.CandidateName, src.AdmissionNo, issue.Severity, issue.Code,
				issue.Field, issue.Message); err != nil {
				return 0, 0, err
			}
		}
	}

	_, err = tx.Exec(ctx, `
		UPDATE loc_submissions
		   SET candidate_count = $2, blocker_count = $3, warning_count = $4,
		       validated_at = now()
		 WHERE id = $1`, subID, len(sources), blockers, warnings)
	return blockers, warnings, err
}

// locRule is one accepted subject combination, flattened for the validator.
type locRule struct {
	GroupCode string
	MinCount  int
	MaxCount  int
	// Keyed on the folded code and the folded name, because the roll was typed
	// with names and the board's file wants codes.
	Allowed   map[string]string
	Mandatory []string
}

// loadLOCRules reads the configured combinations for one board and stage,
// keyed on the folded group code. SSC has no group, so its rule lives under the
// empty key — which is why the unique index guards on COALESCE(group_code,”).
func loadLOCRules(r *http.Request, tx pgx.Tx, board string, stage *string) (map[string]*locRule, error) {
	ctx := r.Context()
	rows, err := tx.Query(ctx, `
		SELECT g.id::text, COALESCE(g.group_code,''), g.min_subjects, g.max_subjects
		  FROM loc_subject_groups g
		 WHERE lower(g.board) = lower($1)
		   AND ($2::text IS NULL OR g.stage = $2)
		   AND g.is_active`, board, stage)
	if err != nil {
		return nil, err
	}
	out := map[string]*locRule{}
	byID := map[string]*locRule{}
	for rows.Next() {
		var id, code string
		var minC, maxC int
		if err := rows.Scan(&id, &code, &minC, &maxC); err != nil {
			rows.Close()
			return nil, err
		}
		rule := &locRule{
			GroupCode: code, MinCount: minC, MaxCount: maxC,
			Allowed: map[string]string{},
		}
		if code == "" {
			rule.GroupCode = "this stage"
		}
		out[foldKey(code)] = rule
		byID[id] = rule
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(byID) == 0 {
		return out, nil
	}

	orows, err := tx.Query(ctx, `
		SELECT o.group_id::text, o.subject_code, o.subject_name, o.is_mandatory
		  FROM loc_subject_options o
		  JOIN loc_subject_groups g ON g.id = o.group_id
		 WHERE lower(g.board) = lower($1)
		   AND ($2::text IS NULL OR g.stage = $2)
		   AND g.is_active
		 ORDER BY o.sequence, o.subject_code`, board, stage)
	if err != nil {
		return nil, err
	}
	defer orows.Close()
	for orows.Next() {
		var gid, code, name string
		var mandatory bool
		if err := orows.Scan(&gid, &code, &name, &mandatory); err != nil {
			return nil, err
		}
		rule, ok := byID[gid]
		if !ok {
			continue
		}
		// Matched on either the board's code or the name the roll was typed
		// with; both fold to the same canonical code.
		rule.Allowed[foldKey(code)] = code
		rule.Allowed[foldKey(name)] = code
		if mandatory {
			rule.Mandatory = append(rule.Mandatory, code)
		}
	}
	return out, orows.Err()
}

// locIssue is one refusal reason against one candidate.
type locIssue struct {
	Severity string
	Code     string
	Field    *string
	Message  string
}

func locBlocker(code, field, msg string) locIssue {
	return locIssue{Severity: "blocker", Code: code, Field: nullString(field), Message: msg}
}

func locWarning(code, field, msg string) locIssue {
	return locIssue{Severity: "warning", Code: code, Field: nullString(field), Message: msg}
}

/*
locProblems is the whole point of the feature.

	Every check names the field and says what the board does about it, because
	"invalid record" on a rejection notice is what the school is trying to avoid
	receiving, not something to reproduce. Order is the order a clerk fixes them
	in: identity first, then the documents, then the combination, then money.
*/
func locProblems(src locSource, rules map[string]*locRule, feePerCandidate int64) []locIssue {
	var out []locIssue

	if blank(src.CandidateName) {
		out = append(out, locBlocker("name_missing", "candidate_name",
			"no name recorded. The board matches on the name exactly as it is on record"))
	}
	if src.DateOfBirth == nil {
		out = append(out, locBlocker("dob_missing", "date_of_birth",
			"no date of birth. Every board rejects a candidate without one"))
	}
	if blank(src.FatherName) {
		out = append(out, locBlocker("father_missing", "father_name",
			"father's name missing. It is printed on the hall ticket and the certificate"))
	}
	if blank(src.MotherName) {
		out = append(out, locBlocker("mother_missing", "mother_name",
			"mother's name missing. It is printed on the hall ticket and the certificate"))
	}
	if !src.HasPhoto {
		out = append(out, locBlocker("photo_missing", "photo_file_id",
			"no photograph attached, on the registration or on the student record"))
	}
	if !src.HasSignature {
		out = append(out, locBlocker("signature_missing", "signature_file_id",
			"no signature attached. The board holds the LOC signature against the answer script"))
	}

	if len(src.Subjects) == 0 {
		out = append(out, locBlocker("subjects_missing", "subjects",
			"no subjects chosen"))
	} else {
		out = append(out, locCombinationProblems(src, rules)...)
	}

	if feePerCandidate > 0 && src.FeePaidPaise < feePerCandidate {
		out = append(out, locBlocker("fee_unpaid", "fee_paid_paise",
			"examination fee not paid in full: "+formatPaiseText(src.FeePaidPaise)+
				" of "+formatPaiseText(feePerCandidate)))
	}

	// Warnings: filed as they are, but a school would rather know.
	if blank(src.APAARID) {
		out = append(out, locWarning("apaar_missing", "apaar_id",
			"no APAAR ID. Not refused today, but the boards are moving to it"))
	}
	if blank(src.Gender) {
		out = append(out, locWarning("gender_missing", "gender",
			"gender not recorded on the student"))
	}
	if blank(src.Medium) {
		out = append(out, locWarning("medium_missing", "medium",
			"medium of instruction not recorded"))
	}
	return out
}

// locCombinationProblems checks the candidate's subjects against the board's
// accepted combination for their group.
//
// A school with no rule configured gets one warning and no blockers rather than
// a blocked filing: the rules are seeded per school and an empty table means
// "not set up", which is not the same as "this candidate is wrong".
func locCombinationProblems(src locSource, rules map[string]*locRule) []locIssue {
	if len(rules) == 0 {
		return []locIssue{locWarning("no_combination_rule", "subjects",
			"no subject combination rule is configured for this board and stage, so the "+
				"combination could not be checked")}
	}
	group := strings.TrimSpace(deref(src.GroupCode))
	rule, ok := rules[foldKey(group)]
	if !ok {
		if group == "" {
			return []locIssue{locBlocker("group_missing", "group_code",
				"no subject group chosen, and this board's stage requires one")}
		}
		return []locIssue{locBlocker("group_unknown", "group_code",
			"subject group "+group+" is not one this board accepts at this stage")}
	}

	var out []locIssue
	seen := map[string]bool{}
	for _, subj := range src.Subjects {
		key := foldKey(subj)
		if key == "" {
			continue
		}
		if _, allowed := rule.Allowed[key]; !allowed {
			out = append(out, locBlocker("subject_not_in_group", "subjects",
				subj+" is not offered in "+rule.GroupCode+" for this board"))
			continue
		}
		seen[rule.Allowed[key]] = true
	}
	for _, code := range rule.Mandatory {
		if !seen[code] {
			out = append(out, locBlocker("subject_mandatory_missing", "subjects",
				code+" is compulsory in "+rule.GroupCode+" and is not on this candidate"))
		}
	}
	if n := len(seen); n < rule.MinCount || n > rule.MaxCount {
		out = append(out, locBlocker("subject_count", "subjects",
			rule.GroupCode+" takes between "+itoa(rule.MinCount)+" and "+
				itoa(rule.MaxCount)+" subjects; this candidate has "+itoa(n)))
	}
	return out
}

// formatPaiseText renders paise as rupees for a message. Integer arithmetic
// throughout: money is bigint paise everywhere in this schema and a float here
// would make "paid in full" a rounding question.
func formatPaiseText(paise int64) string {
	neg := paise < 0
	if neg {
		paise = -paise
	}
	whole := strconv.FormatInt(paise/100, 10)
	frac := paise % 100
	out := "Rs " + whole
	if frac != 0 {
		out += "." + strconv.FormatInt(frac/10, 10) + strconv.FormatInt(frac%10, 10)
	}
	if neg {
		return "-" + out
	}
	return out
}

// locLoad reads a submission header inside an open transaction.
func locLoad(r *http.Request, tx pgx.Tx, subID uuid.UUID) (locSubmissionRow, error) {
	var v locSubmissionRow
	err := tx.QueryRow(r.Context(), `
		SELECT l.id::text, l.academic_year_id::text, l.board, l.exam_name, l.stage,
		       l.title, l.fee_per_candidate_paise, l.status, l.candidate_count,
		       l.blocker_count, l.warning_count,
		       to_char(l.validated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       to_char(l.filed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       u.full_name, l.board_ack_no, l.notes,
		       to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
		  FROM loc_submissions l
		  LEFT JOIN users u ON u.id = l.filed_by
		 WHERE l.id = $1`, subID).
		Scan(&v.ID, &v.AcademicYearID, &v.Board, &v.ExamName, &v.Stage,
			&v.Title, &v.FeePaise, &v.Status, &v.Candidates, &v.Blockers, &v.Warnings,
			&v.ValidatedAt, &v.FiledAt, &v.FiledBy, &v.BoardAckNo, &v.Notes, &v.CreatedAt)
	return v, err
}

// locBody reads the candidates and issues of one submission.
func locBody(r *http.Request, tx pgx.Tx, subID uuid.UUID) ([]locCandidateRow, []locIssueRow, error) {
	ctx := r.Context()
	cands := []locCandidateRow{}
	rows, err := tx.Query(ctx, `
		SELECT id::text, registration_id::text, student_id::text, serial_no,
		       candidate_name, father_name, mother_name,
		       to_char(date_of_birth,'YYYY-MM-DD'), gender, class_label, admission_no,
		       medium, second_language, group_code, candidate_type, apaar_id,
		       registration_no, hall_ticket_no, subjects, fee_paid_paise,
		       has_photo, has_signature
		  FROM loc_candidates WHERE submission_id = $1 ORDER BY serial_no`, subID)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var v locCandidateRow
		var raw []byte
		if err := rows.Scan(&v.ID, &v.RegistrationID, &v.StudentID, &v.SerialNo,
			&v.CandidateName, &v.FatherName, &v.MotherName, &v.DateOfBirth, &v.Gender,
			&v.ClassLabel, &v.AdmissionNo, &v.Medium, &v.SecondLanguage, &v.GroupCode,
			&v.CandidateType, &v.APAARID, &v.RegistrationNo, &v.HallTicketNo, &raw,
			&v.FeePaidPaise, &v.HasPhoto, &v.HasSignature); err != nil {
			rows.Close()
			return nil, nil, err
		}
		v.Subjects = []string{}
		_ = json.Unmarshal(raw, &v.Subjects)
		cands = append(cands, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	issues := []locIssueRow{}
	irows, err := tx.Query(ctx, `
		SELECT registration_id::text, student_id::text, candidate_name, admission_no,
		       severity, code, field, message
		  FROM loc_validation_issues
		 WHERE submission_id = $1
		 ORDER BY severity, admission_no, code`, subID)
	if err != nil {
		return nil, nil, err
	}
	defer irows.Close()
	for irows.Next() {
		var v locIssueRow
		if err := irows.Scan(&v.RegistrationID, &v.StudentID, &v.CandidateName,
			&v.AdmissionNo, &v.Severity, &v.Code, &v.Field, &v.Message); err != nil {
			return nil, nil, err
		}
		issues = append(issues, v)
	}
	return cands, issues, irows.Err()
}

func (s *Server) getLOCSubmission(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	subID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var out locSubmissionDetail
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		head, err := locLoad(r, tx, subID)
		if err != nil {
			return err
		}
		cands, issues, err := locBody(r, tx, subID)
		if err != nil {
			return err
		}
		out = locSubmissionDetail{
			Submission: head, Candidates: cands, Issues: issues,
			Frozen: head.Status != "draft",
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

// validateLOCSubmission re-reads the board roll and recomputes the report.
//
// Only a draft may be revalidated. Running this against a filed submission
// would rewrite the record of what was sent, which is the one thing the feature
// exists to prevent.
func (s *Server) validateLOCSubmission(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	subID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var out locSubmissionDetail
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM loc_submissions WHERE id = $1 FOR UPDATE`, subID).
			Scan(&status); err != nil {
			return err
		}
		if status != "draft" {
			return errLOCFrozen
		}
		if _, _, err := s.rebuildLOC(r, tx, id.InstitutionID, subID); err != nil {
			return err
		}
		head, err := locLoad(r, tx, subID)
		if err != nil {
			return err
		}
		cands, issues, err := locBody(r, tx, subID)
		if err != nil {
			return err
		}
		out = locSubmissionDetail{Submission: head, Candidates: cands, Issues: issues}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errLOCFrozen):
		httpx.Error(w, r, http.StatusConflict, "already_filed", err.Error())
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

type locFileRequest struct {
	BoardAckNo string `json:"board_ack_no"`
	Notes      string `json:"notes"`
	// Force files with blockers still outstanding. Refused by default: a
	// rejected LOC is a crisis and the whole feature is the sentence "these
	// eleven candidates will bounce". A school that has spoken to the board and
	// been told to send it anyway can still say so, and the issues stay on the
	// record showing they were known.
	Force bool `json:"force"`
}

/*
fileLOCSubmission freezes the snapshot.

	Revalidates first, deliberately. Between opening the draft in December and
	filing it in January the roll has moved — a candidate withdrew, a name was
	amended through the 00043 workflow — and filing what the draft happened to
	hold last time somebody looked would send the board a list the school no
	longer has. After this the rows never change again.
*/
func (s *Server) fileLOCSubmission(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	subID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req locFileRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var out locSubmissionRow
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM loc_submissions WHERE id = $1 FOR UPDATE`, subID).
			Scan(&status); err != nil {
			return err
		}
		if status != "draft" {
			return errLOCFrozen
		}
		blockers, _, err := s.rebuildLOC(r, tx, id.InstitutionID, subID)
		if err != nil {
			return err
		}
		if blockers > 0 && !req.Force {
			return errLOCBlocked
		}
		var count int
		if err := tx.QueryRow(r.Context(),
			`SELECT count(*)::int FROM loc_candidates WHERE submission_id = $1`, subID).
			Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			return errors.New("no candidates on this list, nothing to file")
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE loc_submissions
			   SET status = 'filed', filed_at = now(), filed_by = $2,
			       board_ack_no = COALESCE(NULLIF($3,''), board_ack_no),
			       notes = COALESCE(NULLIF($4,''), notes)
			 WHERE id = $1`,
			subID, nullUUIDArg(id.UserID), strings.TrimSpace(req.BoardAckNo),
			strings.TrimSpace(req.Notes)); err != nil {
			return err
		}
		out, err = locLoad(r, tx, subID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errLOCFrozen):
		httpx.Error(w, r, http.StatusConflict, "already_filed", err.Error())
	case errors.Is(err, errLOCBlocked):
		httpx.Error(w, r, http.StatusConflict, "blockers_outstanding", err.Error())
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

// exportLOCSubmission writes the list in the board's column order.
//
// Reads loc_candidates, never board_registrations: a filed list must export
// identically in 2029 to how it exported on the day it was sent, whatever has
// since been corrected on the live roll.
func (s *Server) exportLOCSubmission(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	subID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var (
		head locSubmissionRow
		out  [][]string
	)
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		head, err = locLoad(r, tx, subID)
		if err != nil {
			return err
		}
		cands, _, err := locBody(r, tx, subID)
		if err != nil {
			return err
		}
		for _, c := range cands {
			out = append(out, []string{
				itoa(c.SerialNo), deref(c.AdmissionNo), deref(c.CandidateName),
				deref(c.FatherName), deref(c.MotherName), deref(c.DateOfBirth),
				deref(c.Gender), deref(c.ClassLabel), deref(c.GroupCode),
				deref(c.Medium), deref(c.SecondLanguage),
				strings.Join(c.Subjects, "|"), deref(c.CandidateType),
				deref(c.APAARID), deref(c.RegistrationNo), deref(c.HallTicketNo),
				formatPaiseText(c.FeePaidPaise),
				yesNo(c.HasPhoto), yesNo(c.HasSignature),
			})
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	writeCSV(w, "loc-"+head.Board+"-"+head.ExamName+".csv", []string{
		"S.No", "Admission No", "Candidate Name", "Father's Name", "Mother's Name",
		"Date of Birth", "Gender", "Class", "Group", "Medium", "Second Language",
		"Subjects", "Candidate Type", "APAAR ID", "Registration No", "Hall Ticket No",
		"Fee Paid", "Photo", "Signature",
	}, out)
}

func yesNo(b bool) string {
	if b {
		return "Yes"
	}
	return "No"
}

// --- the board's accepted subject combinations -------------------------------

type locRuleRow struct {
	ID          string          `json:"id"`
	Board       string          `json:"board"`
	Stage       string          `json:"stage"`
	GroupCode   *string         `json:"group_code,omitempty"`
	Name        string          `json:"name"`
	MinSubjects int             `json:"min_subjects"`
	MaxSubjects int             `json:"max_subjects"`
	IsActive    bool            `json:"is_active"`
	Options     []locRuleOption `json:"options"`
}

type locRuleOption struct {
	SubjectCode string `json:"subject_code"`
	SubjectName string `json:"subject_name"`
	IsMandatory bool   `json:"is_mandatory"`
	Sequence    int    `json:"sequence"`
}

func (s *Server) listLOCSubjectRules(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []locRuleRow{}
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, board, stage, group_code, name,
			       min_subjects, max_subjects, is_active
			  FROM loc_subject_groups
			 ORDER BY board, stage, COALESCE(group_code,'')`)
		if err != nil {
			return err
		}
		byID := map[string]int{}
		for rows.Next() {
			var v locRuleRow
			if err := rows.Scan(&v.ID, &v.Board, &v.Stage, &v.GroupCode, &v.Name,
				&v.MinSubjects, &v.MaxSubjects, &v.IsActive); err != nil {
				rows.Close()
				return err
			}
			v.Options = []locRuleOption{}
			byID[v.ID] = len(out)
			out = append(out, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		orows, err := tx.Query(r.Context(), `
			SELECT group_id::text, subject_code, subject_name, is_mandatory, sequence
			  FROM loc_subject_options ORDER BY sequence, subject_code`)
		if err != nil {
			return err
		}
		defer orows.Close()
		for orows.Next() {
			var gid string
			var o locRuleOption
			if err := orows.Scan(&gid, &o.SubjectCode, &o.SubjectName,
				&o.IsMandatory, &o.Sequence); err != nil {
				return err
			}
			if i, ok := byID[gid]; ok {
				out[i].Options = append(out[i].Options, o)
			}
		}
		return orows.Err()
	})
	respond(w, r, out, err)
}

type locRuleRequest struct {
	ID          string          `json:"id"`
	Board       string          `json:"board"`
	Stage       string          `json:"stage"`
	GroupCode   string          `json:"group_code"`
	Name        string          `json:"name"`
	MinSubjects int             `json:"min_subjects"`
	MaxSubjects int             `json:"max_subjects"`
	IsActive    *bool           `json:"is_active"`
	Options     []locRuleOption `json:"options"`
}

// saveLOCSubjectRule writes one combination and replaces its option list.
//
// Replace rather than merge: a board that drops a subject from a group expects
// it gone, and a merge would leave it accepted forever with nothing on the
// screen to say why.
func (s *Server) saveLOCSubjectRule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req locRuleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Board = strings.TrimSpace(req.Board)
	req.Stage = strings.TrimSpace(req.Stage)
	req.GroupCode = strings.TrimSpace(req.GroupCode)
	req.Name = strings.TrimSpace(req.Name)
	if req.Board == "" || req.Stage == "" {
		httpx.BadRequest(w, r, "board and stage are required")
		return
	}
	if _, ok := boardStages[req.Stage]; !ok {
		httpx.BadRequest(w, r, "stage must be ssc, inter_first_year or inter_second_year")
		return
	}
	if req.Name == "" {
		req.Name = req.GroupCode
		if req.Name == "" {
			req.Name = req.Stage
		}
	}
	if req.MinSubjects <= 0 {
		req.MinSubjects = 1
	}
	if req.MaxSubjects < req.MinSubjects {
		req.MaxSubjects = req.MinSubjects
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	var out string
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			INSERT INTO loc_subject_groups
			    (institution_id, board, stage, group_code, name,
			     min_subjects, max_subjects, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (institution_id, lower(board), stage, COALESCE(group_code,''))
			DO UPDATE SET name = EXCLUDED.name,
			              min_subjects = EXCLUDED.min_subjects,
			              max_subjects = EXCLUDED.max_subjects,
			              is_active = EXCLUDED.is_active
			RETURNING id::text`,
			id.InstitutionID, req.Board, req.Stage, nullString(req.GroupCode), req.Name,
			req.MinSubjects, req.MaxSubjects, active).Scan(&out)
		if err != nil {
			return err
		}
		gid, err := uuid.Parse(out)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM loc_subject_options WHERE group_id = $1`, gid); err != nil {
			return err
		}
		for i, o := range req.Options {
			code := strings.TrimSpace(o.SubjectCode)
			name := strings.TrimSpace(o.SubjectName)
			if code == "" && name == "" {
				continue
			}
			if code == "" {
				code = name
			}
			if name == "" {
				name = code
			}
			seq := o.Sequence
			if seq == 0 {
				seq = i + 1
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO loc_subject_options
				    (institution_id, group_id, subject_code, subject_name, is_mandatory, sequence)
				VALUES ($1,$2,$3,$4,$5,$6)
				ON CONFLICT (group_id, upper(subject_code)) DO UPDATE
				   SET subject_name = EXCLUDED.subject_name,
				       is_mandatory = EXCLUDED.is_mandatory,
				       sequence = EXCLUDED.sequence`,
				id.InstitutionID, gid, code, name, o.IsMandatory, seq); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

func (s *Server) deleteLOCSubjectRule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	gid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `DELETE FROM loc_subject_groups WHERE id = $1`, gid)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// ============================================================================
// 2. SQAA compliance tracking
// ============================================================================

/* The school's side of the assurance framework.

   sqaa_frameworks and sqaa_standards are platform data the vendor publishes —
   framework, domain, standard, indicator, as one self-referencing tree of
   arbitrary depth. This section never writes them. What it adds is what the
   school did about them: a rating per standard, evidence attached, a weighted
   score, and the gaps carried into an action plan with an owner and a date.

   An assessment names its framework by code and copies the standard's code and
   name onto each entry. There is no foreign key in either direction, and that is
   the point: a framework is revised and retired, and "we were assessed under the
   2023 rules" has to keep meaning something after the 2026 revision renumbers
   everything. */

type sqaaFrameworkChoice struct {
	Code          string  `json:"code"`
	Name          string  `json:"name"`
	Authority     string  `json:"authority"`
	Version       string  `json:"version"`
	Status        string  `json:"status"`
	EffectiveFrom *string `json:"effective_from,omitempty"`
	Standards     int     `json:"standards"`
	// WeightBP is the sum of the domain weights. A framework that does not add
	// to 10000 cannot be scored, and the screen has to say so before anybody
	// spends a fortnight assessing against it.
	WeightBP int `json:"weight_bp"`
}

// listSQAASchoolFrameworks lists the frameworks a school may assess against.
//
// Reads through AsPlatform because sqaa_frameworks carries no institution_id
// and no tenant policy — it is one answer for the whole installation, exactly
// as platform_config.go's own reader does. Only published frameworks are
// offered: a draft is the vendor still writing it.
func (s *Server) listSQAASchoolFrameworks(w http.ResponseWriter, r *http.Request) {
	out := []sqaaFrameworkChoice{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT f.code, f.name, f.authority, f.version, f.status,
			       to_char(f.effective_from,'YYYY-MM-DD'),
			       (SELECT count(*) FROM sqaa_standards t WHERE t.framework_code = f.code)::int,
			       COALESCE((SELECT sum(t.weight_bp) FROM sqaa_standards t
			                  WHERE t.framework_code = f.code AND t.parent_id IS NULL), 0)::int
			  FROM sqaa_frameworks f
			 WHERE f.status = 'published'
			 ORDER BY f.effective_from DESC NULLS LAST, f.code`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v sqaaFrameworkChoice
			if err := rows.Scan(&v.Code, &v.Name, &v.Authority, &v.Version, &v.Status,
				&v.EffectiveFrom, &v.Standards, &v.WeightBP); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type sqaaAssessmentRow struct {
	ID               string  `json:"id"`
	AcademicYearID   *string `json:"academic_year_id,omitempty"`
	FrameworkCode    string  `json:"framework_code"`
	FrameworkName    *string `json:"framework_name,omitempty"`
	FrameworkVersion *string `json:"framework_version,omitempty"`
	Title            string  `json:"title"`
	Status           string  `json:"status"`
	StartedOn        *string `json:"started_on,omitempty"`
	DueOn            *string `json:"due_on,omitempty"`
	ScoreBP          *int    `json:"score_bp,omitempty"`
	MaxScoreBP       *int    `json:"max_score_bp,omitempty"`
	SubmittedAt      *string `json:"submitted_at,omitempty"`
	SubmittedBy      *string `json:"submitted_by,omitempty"`
	Notes            *string `json:"notes,omitempty"`
	Rated            int     `json:"rated_count"`
	Total            int     `json:"standard_count"`
	Gaps             int     `json:"gap_count"`
	OpenActions      int     `json:"open_action_count"`
}

func (s *Server) listSQAAAssessments(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT a.id::text, a.academic_year_id::text, a.framework_code,
		       a.framework_name, a.framework_version, a.title, a.status,
		       to_char(a.started_on,'YYYY-MM-DD'), to_char(a.due_on,'YYYY-MM-DD'),
		       a.score_bp, a.max_score_bp,
		       to_char(a.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', u.full_name, a.notes,
		       (SELECT count(*) FROM sqaa_assessment_entries e
		         WHERE e.assessment_id = a.id AND e.rating <> 'not_assessed')::int,
		       (SELECT count(*) FROM sqaa_assessment_entries e
		         WHERE e.assessment_id = a.id)::int,
		       (SELECT count(*) FROM sqaa_assessment_entries e
		         WHERE e.assessment_id = a.id
		           AND e.rating IN ('not_met','partially_met'))::int,
		       (SELECT count(*) FROM sqaa_action_items i
		         WHERE i.assessment_id = a.id AND i.status IN ('open','in_progress'))::int
		  FROM sqaa_assessments a
		  LEFT JOIN users u ON u.id = a.submitted_by
		 ORDER BY a.created_at DESC`, nil,
		func(rows pgx.Rows) (sqaaAssessmentRow, error) {
			var v sqaaAssessmentRow
			return v, rows.Scan(&v.ID, &v.AcademicYearID, &v.FrameworkCode,
				&v.FrameworkName, &v.FrameworkVersion, &v.Title, &v.Status,
				&v.StartedOn, &v.DueOn, &v.ScoreBP, &v.MaxScoreBP,
				&v.SubmittedAt, &v.SubmittedBy, &v.Notes,
				&v.Rated, &v.Total, &v.Gaps, &v.OpenActions)
		})
	respond(w, r, items, err)
}

type sqaaAssessmentRequest struct {
	FrameworkCode  string `json:"framework_code"`
	AcademicYearID string `json:"academic_year_id"`
	Title          string `json:"title"`
	StartedOn      string `json:"started_on"`
	DueOn          string `json:"due_on"`
	Notes          string `json:"notes"`
}

var errSQAAClosed = errors.New(
	"this assessment has been submitted. Reopening it would rewrite a record " +
		"somebody signed; start a fresh cycle instead")

/*
createSQAAAssessment opens a cycle and lays out every standard as an unrated

	entry.

	Laid out up front rather than on first rating, so the screen can show
	"14 of 62 rated" from the moment it opens. An assessment whose progress is
	only knowable by counting what is absent is one nobody finishes.
*/
func (s *Server) createSQAAAssessment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req sqaaAssessmentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.FrameworkCode = strings.TrimSpace(req.FrameworkCode)
	req.Title = strings.TrimSpace(req.Title)
	if req.FrameworkCode == "" {
		httpx.BadRequest(w, r, "framework_code is required")
		return
	}

	// The framework and its tree live outside every tenant policy, so they are
	// read in their own platform transaction before the tenant one opens.
	type standard struct {
		ID, Code, Name       string
		DomainCode, DomainNm *string
		WeightBP             int
		Evidence             bool
	}
	var (
		fwName, fwVersion string
		standards         []standard
	)
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT name, version FROM sqaa_frameworks
			 WHERE code = $1 AND status = 'published'`, req.FrameworkCode).
			Scan(&fwName, &fwVersion); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT t.id::text, t.code, t.name, p.code, p.name,
			       t.weight_bp, t.evidence_required
			  FROM sqaa_standards t
			  LEFT JOIN sqaa_standards p ON p.id = t.parent_id
			 WHERE t.framework_code = $1
			 ORDER BY t.sequence, t.code`, req.FrameworkCode)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v standard
			if err := rows.Scan(&v.ID, &v.Code, &v.Name, &v.DomainCode, &v.DomainNm,
				&v.WeightBP, &v.Evidence); err != nil {
				return err
			}
			standards = append(standards, v)
		}
		return rows.Err()
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.BadRequest(w, r, "no published framework with that code")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(standards) == 0 {
		httpx.BadRequest(w, r,
			"that framework has no standards yet, so there is nothing to assess against")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		yearID, yearName, _, _, err := resolveAcademicYear(r, tx, req.AcademicYearID)
		if err != nil {
			return err
		}
		if req.Title == "" {
			req.Title = fwName + " " + yearName
		}
		// Max score is the sum of the domain weights, which is what a rating of
		// "met" everywhere would earn.
		maxBP := 0
		for _, st := range standards {
			if st.DomainCode == nil {
				maxBP += st.WeightBP
			}
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO sqaa_assessments
			    (institution_id, academic_year_id, framework_code, framework_name,
			     framework_version, title, started_on, due_on, max_score_bp, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')::date,NULLIF($8,'')::date,$9,$10,$11)
			RETURNING id::text`,
			id.InstitutionID, yearID, req.FrameworkCode, fwName, fwVersion, req.Title,
			strings.TrimSpace(req.StartedOn), strings.TrimSpace(req.DueOn), maxBP,
			nullString(req.Notes), nullUUIDArg(id.UserID)).Scan(&out); err != nil {
			if isUniqueViolation(err) {
				return errors.New("an assessment with that title already exists for this framework and year")
			}
			return err
		}
		aid, err := uuid.Parse(out)
		if err != nil {
			return err
		}
		for _, st := range standards {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO sqaa_assessment_entries
				    (institution_id, assessment_id, standard_id, standard_code, standard_name,
				     domain_code, domain_name, weight_bp, evidence_required)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
				ON CONFLICT (assessment_id, standard_id) DO NOTHING`,
				id.InstitutionID, aid, st.ID, st.Code, st.Name,
				st.DomainCode, st.DomainNm, st.WeightBP, st.Evidence); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

type sqaaEntryRow struct {
	ID           string            `json:"id"`
	StandardID   string            `json:"standard_id"`
	StandardCode *string           `json:"standard_code,omitempty"`
	StandardName *string           `json:"standard_name,omitempty"`
	DomainCode   *string           `json:"domain_code,omitempty"`
	DomainName   *string           `json:"domain_name,omitempty"`
	Rating       string            `json:"rating"`
	ScoreBP      *int              `json:"score_bp,omitempty"`
	WeightBP     int               `json:"weight_bp"`
	EvidenceReq  bool              `json:"evidence_required"`
	Remarks      *string           `json:"remarks,omitempty"`
	AssessedBy   *string           `json:"assessed_by,omitempty"`
	AssessedAt   *string           `json:"assessed_at,omitempty"`
	Evidence     []sqaaEvidenceRow `json:"evidence"`
}

type sqaaEvidenceRow struct {
	ID          string  `json:"id"`
	FileID      *string `json:"file_id,omitempty"`
	FileName    *string `json:"file_name,omitempty"`
	ExternalURL *string `json:"external_url,omitempty"`
	Caption     string  `json:"caption"`
	AddedBy     *string `json:"added_by,omitempty"`
	AddedAt     string  `json:"added_at"`
}

type sqaaAssessmentDetail struct {
	Assessment sqaaAssessmentRow `json:"assessment"`
	Entries    []sqaaEntryRow    `json:"entries"`
	Actions    []sqaaActionRow   `json:"actions"`
	Frozen     bool              `json:"frozen"`
}

func (s *Server) getSQAAAssessment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	aid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var out sqaaAssessmentDetail
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		var v sqaaAssessmentRow
		if err := tx.QueryRow(r.Context(), `
			SELECT a.id::text, a.academic_year_id::text, a.framework_code,
			       a.framework_name, a.framework_version, a.title, a.status,
			       to_char(a.started_on,'YYYY-MM-DD'), to_char(a.due_on,'YYYY-MM-DD'),
			       a.score_bp, a.max_score_bp,
			       to_char(a.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', u.full_name, a.notes,
			       (SELECT count(*) FROM sqaa_assessment_entries e
			         WHERE e.assessment_id = a.id AND e.rating <> 'not_assessed')::int,
			       (SELECT count(*) FROM sqaa_assessment_entries e
			         WHERE e.assessment_id = a.id)::int,
			       (SELECT count(*) FROM sqaa_assessment_entries e
			         WHERE e.assessment_id = a.id
			           AND e.rating IN ('not_met','partially_met'))::int,
			       (SELECT count(*) FROM sqaa_action_items i
			         WHERE i.assessment_id = a.id AND i.status IN ('open','in_progress'))::int
			  FROM sqaa_assessments a
			  LEFT JOIN users u ON u.id = a.submitted_by
			 WHERE a.id = $1`, aid).
			Scan(&v.ID, &v.AcademicYearID, &v.FrameworkCode, &v.FrameworkName,
				&v.FrameworkVersion, &v.Title, &v.Status, &v.StartedOn, &v.DueOn,
				&v.ScoreBP, &v.MaxScoreBP, &v.SubmittedAt, &v.SubmittedBy, &v.Notes,
				&v.Rated, &v.Total, &v.Gaps, &v.OpenActions); err != nil {
			return err
		}
		out.Assessment = v
		out.Frozen = v.Status == "submitted" || v.Status == "closed"

		out.Entries = []sqaaEntryRow{}
		rows, err := tx.Query(r.Context(), `
			SELECT e.id::text, e.standard_id::text, e.standard_code, e.standard_name,
			       e.domain_code, e.domain_name, e.rating, e.score_bp, e.weight_bp,
			       e.evidence_required, e.remarks, u.full_name,
			       to_char(e.assessed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM sqaa_assessment_entries e
			  LEFT JOIN users u ON u.id = e.assessed_by
			 WHERE e.assessment_id = $1
			 ORDER BY COALESCE(e.domain_code,''), e.standard_code`, aid)
		if err != nil {
			return err
		}
		byID := map[string]int{}
		for rows.Next() {
			var e sqaaEntryRow
			if err := rows.Scan(&e.ID, &e.StandardID, &e.StandardCode, &e.StandardName,
				&e.DomainCode, &e.DomainName, &e.Rating, &e.ScoreBP, &e.WeightBP,
				&e.EvidenceReq, &e.Remarks, &e.AssessedBy, &e.AssessedAt); err != nil {
				rows.Close()
				return err
			}
			e.Evidence = []sqaaEvidenceRow{}
			byID[e.ID] = len(out.Entries)
			out.Entries = append(out.Entries, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		erows, err := tx.Query(r.Context(), `
			SELECT ev.entry_id::text, ev.id::text, ev.file_id::text, f.original_name,
			       ev.external_url, ev.caption, u.full_name,
			       to_char(ev.added_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM sqaa_evidence ev
			  JOIN sqaa_assessment_entries e ON e.id = ev.entry_id
			  LEFT JOIN files f ON f.id = ev.file_id AND f.deleted_at IS NULL
			  LEFT JOIN users u ON u.id = ev.added_by
			 WHERE e.assessment_id = $1
			 ORDER BY ev.added_at`, aid)
		if err != nil {
			return err
		}
		defer erows.Close()
		for erows.Next() {
			var entryID string
			var ev sqaaEvidenceRow
			if err := erows.Scan(&entryID, &ev.ID, &ev.FileID, &ev.FileName,
				&ev.ExternalURL, &ev.Caption, &ev.AddedBy, &ev.AddedAt); err != nil {
				return err
			}
			if i, ok := byID[entryID]; ok {
				out.Entries[i].Evidence = append(out.Entries[i].Evidence, ev)
			}
		}
		if err := erows.Err(); err != nil {
			return err
		}

		out.Actions, err = sqaaActions(r, tx, &aid)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

// sqaaRatingScore maps a rating to the fraction of a standard's weight it earns,
// in basis points of that weight.
//
// A four-point scale with "not applicable" beside it, which is how every SQAA
// instrument this has been checked against is worded. not_applicable scores
// nothing and is excluded from the denominator, because scoring it as zero
// would punish a primary school for having no laboratory.
var sqaaRatingScore = map[string]int{
	"not_met":       0,
	"partially_met": 5000,
	"met":           8000,
	"exceeds":       10000,
}

type sqaaEntryRequest struct {
	StandardID string `json:"standard_id"`
	Rating     string `json:"rating"`
	Remarks    string `json:"remarks"`
}

// saveSQAAEntry records one rating and re-scores the assessment.
func (s *Server) saveSQAAEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	aid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req sqaaEntryRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Rating = strings.TrimSpace(req.Rating)
	stdID, err := uuid.Parse(strings.TrimSpace(req.StandardID))
	if err != nil {
		httpx.BadRequest(w, r, "standard_id must be a uuid")
		return
	}
	if _, ok := sqaaRatingScore[req.Rating]; !ok &&
		req.Rating != "not_applicable" && req.Rating != "not_assessed" {
		httpx.BadRequest(w, r,
			"rating must be not_met, partially_met, met, exceeds, not_applicable or not_assessed")
		return
	}

	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM sqaa_assessments WHERE id = $1 FOR UPDATE`, aid).
			Scan(&status); err != nil {
			return err
		}
		if status == "submitted" || status == "closed" {
			return errSQAAClosed
		}
		var scoreBP any
		if v, ok := sqaaRatingScore[req.Rating]; ok {
			scoreBP = v
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE sqaa_assessment_entries
			   SET rating = $3, score_bp = $4, remarks = $5,
			       assessed_by = $6, assessed_at = now()
			 WHERE assessment_id = $1 AND standard_id = $2`,
			aid, stdID, req.Rating, scoreBP, nullString(strings.TrimSpace(req.Remarks)),
			nullUUIDArg(id.UserID))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errors.New("that standard is not part of this assessment")
		}
		// An assessment in progress the moment somebody rates something.
		if _, err := tx.Exec(r.Context(), `
			UPDATE sqaa_assessments SET status = 'in_progress', updated_at = now()
			 WHERE id = $1 AND status = 'draft'`, aid); err != nil {
			return err
		}
		return sqaaRescore(r, tx, aid)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errSQAAClosed):
		httpx.Error(w, r, http.StatusConflict, "already_submitted", err.Error())
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
	}
}

/*
sqaaRescore recomputes the weighted score.

	Only domains carry weight in this schema — sqaa_standards.weight_bp is
	populated at the top level and the tree below it is descriptive — so a
	domain's score is the mean of its rated children and the total is the
	weighted sum of the domains. Entries rated not_applicable or not_assessed sit
	outside both, which is why a half-finished assessment reports a score for
	what has been done rather than a score dragged to zero by what has not.
*/
func sqaaRescore(r *http.Request, tx pgx.Tx, aid uuid.UUID) error {
	rows, err := tx.Query(r.Context(), `
		SELECT COALESCE(e.domain_code, e.standard_code, ''), e.weight_bp, e.score_bp,
		       (e.domain_code IS NULL)
		  FROM sqaa_assessment_entries e
		 WHERE e.assessment_id = $1`, aid)
	if err != nil {
		return err
	}
	type acc struct {
		weight     int
		sum, count int
	}
	domains := map[string]*acc{}
	for rows.Next() {
		var key string
		var weight int
		var score *int
		var isDomain bool
		if err := rows.Scan(&key, &weight, &score, &isDomain); err != nil {
			rows.Close()
			return err
		}
		a, ok := domains[key]
		if !ok {
			a = &acc{}
			domains[key] = a
		}
		if isDomain && weight > 0 {
			a.weight = weight
		}
		if score != nil {
			a.sum += *score
			a.count++
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	totalWeight, weighted := 0, 0
	for _, a := range domains {
		if a.count == 0 || a.weight == 0 {
			continue
		}
		totalWeight += a.weight
		weighted += (a.sum / a.count) * a.weight
	}
	var score any
	if totalWeight > 0 {
		score = weighted / totalWeight
	}
	_, err = tx.Exec(r.Context(),
		`UPDATE sqaa_assessments SET score_bp = $2, updated_at = now() WHERE id = $1`,
		aid, score)
	return err
}

type sqaaSubmitRequest struct {
	Notes string `json:"notes"`
	// Force submits with standards still unrated. Refused by default, because a
	// framework returned half-rated reads to a board as a school that scored
	// badly rather than one that had not finished.
	Force bool `json:"force"`
}

func (s *Server) submitSQAAAssessment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	aid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req sqaaSubmitRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM sqaa_assessments WHERE id = $1 FOR UPDATE`, aid).
			Scan(&status); err != nil {
			return err
		}
		if status == "submitted" || status == "closed" {
			return errSQAAClosed
		}
		var unrated, missingEvidence int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FILTER (WHERE rating = 'not_assessed')::int,
			       count(*) FILTER (WHERE evidence_required
			                          AND rating NOT IN ('not_assessed','not_applicable')
			                          AND NOT EXISTS (SELECT 1 FROM sqaa_evidence v
			                                           WHERE v.entry_id = e.id))::int
			  FROM sqaa_assessment_entries e WHERE e.assessment_id = $1`, aid).
			Scan(&unrated, &missingEvidence); err != nil {
			return err
		}
		if !req.Force && unrated > 0 {
			return errors.New(itoa(unrated) +
				" standard(s) are still unrated. Rate them, or mark them not applicable")
		}
		if !req.Force && missingEvidence > 0 {
			return errors.New(itoa(missingEvidence) +
				" standard(s) require evidence and have none attached")
		}
		if err := sqaaRescore(r, tx, aid); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE sqaa_assessments
			   SET status = 'submitted', submitted_at = now(), submitted_by = $2,
			       notes = COALESCE(NULLIF($3,''), notes), updated_at = now()
			 WHERE id = $1`, aid, nullUUIDArg(id.UserID), strings.TrimSpace(req.Notes))
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errSQAAClosed):
		httpx.Error(w, r, http.StatusConflict, "already_submitted", err.Error())
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"submitted": true})
	}
}

type sqaaEvidenceRequest struct {
	FileID      string `json:"file_id"`
	ExternalURL string `json:"external_url"`
	Caption     string `json:"caption"`
}

// addSQAAEvidence attaches a document to one rating.
//
// Takes a file_id minted by POST /api/v1/files/presign, or an external_url.
// The second exists because object storage is unconfigured on this deployment
// and presign answers 503 — without it the evidence half of the feature would
// be unusable in production while looking finished.
func (s *Server) addSQAAEvidence(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	entryID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req sqaaEvidenceRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Caption = strings.TrimSpace(req.Caption)
	req.ExternalURL = strings.TrimSpace(req.ExternalURL)
	fileRef := strings.TrimSpace(req.FileID)
	if (fileRef == "") == (req.ExternalURL == "") {
		httpx.BadRequest(w, r,
			"attach exactly one of file_id (upload it first) or external_url")
		return
	}
	if req.Caption == "" {
		httpx.BadRequest(w, r, "caption is required. An unlabelled document proves nothing")
		return
	}
	var fileArg any
	if fileRef != "" {
		f, err := uuid.Parse(fileRef)
		if err != nil {
			httpx.BadRequest(w, r, "file_id must be a uuid")
			return
		}
		fileArg = f
	}

	var out string
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(), `
			SELECT a.status FROM sqaa_assessments a
			  JOIN sqaa_assessment_entries e ON e.assessment_id = a.id
			 WHERE e.id = $1`, entryID).Scan(&status); err != nil {
			return err
		}
		if status == "submitted" || status == "closed" {
			return errSQAAClosed
		}
		err := tx.QueryRow(r.Context(), `
			INSERT INTO sqaa_evidence
			    (institution_id, entry_id, file_id, external_url, caption, added_by)
			VALUES ($1,$2,$3,NULLIF($4,''),$5,$6)
			RETURNING id::text`,
			id.InstitutionID, entryID, fileArg, req.ExternalURL, req.Caption,
			nullUUIDArg(id.UserID)).Scan(&out)
		if isUniqueViolation(err) {
			return errors.New("that document is already attached to this standard")
		}
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errSQAAClosed):
		httpx.Error(w, r, http.StatusConflict, "already_submitted", err.Error())
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
	}
}

func (s *Server) removeSQAAEvidence(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	evID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		// Evidence behind a submitted assessment is part of the record.
		tag, err := tx.Exec(r.Context(), `
			DELETE FROM sqaa_evidence ev
			 USING sqaa_assessment_entries e, sqaa_assessments a
			 WHERE ev.id = $1 AND e.id = ev.entry_id AND a.id = e.assessment_id
			   AND a.status NOT IN ('submitted','closed')`, evID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.Error(w, r, http.StatusConflict, "not_removable",
			"no such evidence, or the assessment it belongs to has already been submitted")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// --- the action plan ---------------------------------------------------------

type sqaaActionRow struct {
	ID            string  `json:"id"`
	AssessmentID  string  `json:"assessment_id"`
	EntryID       *string `json:"entry_id,omitempty"`
	StandardCode  *string `json:"standard_code,omitempty"`
	Title         string  `json:"title"`
	Detail        *string `json:"detail,omitempty"`
	OwnerID       *string `json:"owner_employee_id,omitempty"`
	OwnerName     *string `json:"owner_name,omitempty"`
	DueOn         *string `json:"due_on,omitempty"`
	Priority      string  `json:"priority"`
	Status        string  `json:"status"`
	ProgressNote  *string `json:"progress_note,omitempty"`
	ClosedAt      *string `json:"closed_at,omitempty"`
	Overdue       bool    `json:"overdue"`
	AssessmentTtl string  `json:"assessment_title"`
}

func sqaaActions(r *http.Request, tx pgx.Tx, aid *uuid.UUID) ([]sqaaActionRow, error) {
	out := []sqaaActionRow{}
	rows, err := tx.Query(r.Context(), `
		SELECT i.id::text, i.assessment_id::text, i.entry_id::text, i.standard_code,
		       i.title, i.detail, i.owner_employee_id::text,
		       COALESCE(i.owner_name, e.first_name || ' ' || COALESCE(e.last_name,'')),
		       to_char(i.due_on,'YYYY-MM-DD'), i.priority, i.status, i.progress_note,
		       to_char(i.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       (i.due_on IS NOT NULL AND i.due_on < CURRENT_DATE
		        AND i.status IN ('open','in_progress')),
		       a.title
		  FROM sqaa_action_items i
		  JOIN sqaa_assessments a ON a.id = i.assessment_id
		  LEFT JOIN employees e ON e.id = i.owner_employee_id
		 WHERE ($1::uuid IS NULL OR i.assessment_id = $1)
		 ORDER BY i.status, i.due_on NULLS LAST, i.created_at DESC`, aid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v sqaaActionRow
		if err := rows.Scan(&v.ID, &v.AssessmentID, &v.EntryID, &v.StandardCode,
			&v.Title, &v.Detail, &v.OwnerID, &v.OwnerName, &v.DueOn, &v.Priority,
			&v.Status, &v.ProgressNote, &v.ClosedAt, &v.Overdue, &v.AssessmentTtl); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Server) listSQAAActions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var filter *uuid.UUID
	if v := strings.TrimSpace(r.URL.Query().Get("assessment_id")); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "assessment_id must be a uuid")
			return
		}
		filter = &parsed
	}
	var out []sqaaActionRow
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		var err error
		out, err = sqaaActions(r, tx, filter)
		return err
	})
	respond(w, r, out, err)
}

type sqaaActionRequest struct {
	ID           string `json:"id"`
	AssessmentID string `json:"assessment_id"`
	EntryID      string `json:"entry_id"`
	Title        string `json:"title"`
	Detail       string `json:"detail"`
	OwnerID      string `json:"owner_employee_id"`
	DueOn        string `json:"due_on"`
	Priority     string `json:"priority"`
	Status       string `json:"status"`
	ProgressNote string `json:"progress_note"`
}

// saveSQAAAction creates or updates one item on the action plan.
//
// An action item outlives its assessment's submission on purpose: the gap is
// still a gap after the return has gone in, and closing it is the work the
// assessment was for.
func (s *Server) saveSQAAAction(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req sqaaActionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Priority = strings.TrimSpace(req.Priority)
	req.Status = strings.TrimSpace(req.Status)
	if req.Priority == "" {
		req.Priority = "normal"
	}
	if req.Status == "" {
		req.Status = "open"
	}
	if req.Title == "" {
		httpx.BadRequest(w, r, "title is required")
		return
	}
	var ownerArg, entryArg any
	if v := strings.TrimSpace(req.OwnerID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "owner_employee_id must be a uuid")
			return
		}
		ownerArg = parsed
	}
	if v := strings.TrimSpace(req.EntryID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "entry_id must be a uuid")
			return
		}
		entryArg = parsed
	}
	// A done item is stamped here rather than trusted from the client, which is
	// what the closed_is_stamped check in the migration is guarding.
	closed := req.Status == "done" || req.Status == "dropped"

	var out string
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		if v := strings.TrimSpace(req.ID); v != "" {
			itemID, err := uuid.Parse(v)
			if err != nil {
				return errors.New("id must be a uuid")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE sqaa_action_items
				   SET title = $2, detail = $3, owner_employee_id = $4,
				       due_on = NULLIF($5,'')::date, priority = $6, status = $7,
				       progress_note = $8,
				       closed_at = CASE WHEN $9 THEN COALESCE(closed_at, now()) ELSE NULL END,
				       closed_by = CASE WHEN $9 THEN COALESCE(closed_by, $10) ELSE NULL END
				 WHERE id = $1
				 RETURNING id::text`,
				itemID, req.Title, nullString(strings.TrimSpace(req.Detail)), ownerArg,
				strings.TrimSpace(req.DueOn), req.Priority, req.Status,
				nullString(strings.TrimSpace(req.ProgressNote)), closed,
				nullUUIDArg(id.UserID)).Scan(&out)
		}
		aid, err := uuid.Parse(strings.TrimSpace(req.AssessmentID))
		if err != nil {
			return errors.New("assessment_id must be a uuid")
		}
		// The standard code is copied off the entry so the item still reads
		// after the framework it came from has been revised.
		return tx.QueryRow(r.Context(), `
			INSERT INTO sqaa_action_items
			    (institution_id, assessment_id, entry_id, standard_code, title, detail,
			     owner_employee_id, owner_name, due_on, priority, status, progress_note,
			     closed_at, closed_by, created_by)
			SELECT $1, $2, $3,
			       (SELECT standard_code FROM sqaa_assessment_entries WHERE id = $3),
			       $4, $5, $6,
			       (SELECT first_name || ' ' || COALESCE(last_name,'')
			          FROM employees WHERE id = $6),
			       NULLIF($7,'')::date, $8, $9, $10,
			       CASE WHEN $11 THEN now() END,
			       CASE WHEN $11 THEN $12::uuid END,
			       $12
			RETURNING id::text`,
			id.InstitutionID, aid, entryArg, req.Title,
			nullString(strings.TrimSpace(req.Detail)), ownerArg,
			strings.TrimSpace(req.DueOn), req.Priority, req.Status,
			nullString(strings.TrimSpace(req.ProgressNote)), closed,
			nullUUIDArg(id.UserID)).Scan(&out)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
	}
}

// ============================================================================
// 3. Child Info reconciliation
// ============================================================================

/* The state's roster against ours, and what was decided about the gap.

   Three kinds of difference, which is the honest shape of the problem:

     portal_only    the portal has a child this school does not. Usually a
                    transfer the previous school never closed off.
     school_only    we have a child the portal does not. Usually an admission
                    the school never pushed, and the one that costs money —
                    an unlisted child is an unfunded child.
     field_mismatch both have them and disagree on a field. Almost always a
                    name spelled two ways or a date of birth typed two ways.

   The diff is easy. The reason this feature is worth building is the third
   table: a difference the school has already decided about does not come back
   next month. A reconciliation you cannot dismiss is one nobody opens twice,
   and then the drift is invisible again.

   A resolution is keyed on the identity of the difference and stores the values
   it was settled at. If the portal later changes its answer the difference is
   genuinely new and is raised again — accepting one mismatch is not accepting
   every future mismatch on that field. */

type childInfoImportRow struct {
	ID          string  `json:"id"`
	SourceLabel *string `json:"source_label,omitempty"`
	FileName    *string `json:"file_name,omitempty"`
	RowCount    int     `json:"row_count"`
	PortalOnly  int     `json:"portal_only_count"`
	SchoolOnly  int     `json:"school_only_count"`
	Mismatch    int     `json:"mismatch_count"`
	Suppressed  int     `json:"suppressed_count"`
	Open        int     `json:"open_count"`
	ImportedBy  *string `json:"imported_by,omitempty"`
	ImportedAt  string  `json:"imported_at"`
	Note        *string `json:"note,omitempty"`
}

func (s *Server) listChildInfoImports(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT i.id::text, i.source_label, i.file_name, i.row_count,
		       i.portal_only_count, i.school_only_count, i.mismatch_count,
		       i.suppressed_count,
		       (SELECT count(*) FROM child_info_differences d
		         WHERE d.import_id = i.id AND d.status = 'open')::int,
		       u.full_name, to_char(i.imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', i.note
		  FROM child_info_imports i
		  LEFT JOIN users u ON u.id = i.imported_by
		 ORDER BY i.imported_at DESC`, nil,
		func(rows pgx.Rows) (childInfoImportRow, error) {
			var v childInfoImportRow
			return v, rows.Scan(&v.ID, &v.SourceLabel, &v.FileName, &v.RowCount,
				&v.PortalOnly, &v.SchoolOnly, &v.Mismatch, &v.Suppressed, &v.Open,
				&v.ImportedBy, &v.ImportedAt, &v.Note)
		})
	respond(w, r, items, err)
}

// childInfoLine is one row of the portal extract, after parsing.
type childInfoLine struct {
	LineNo      int
	ChildInfoID string
	Name        string
	Father      string
	Mother      string
	DOB         string
	Gender      string
	Aadhaar     string
	APAAR       string
	Class       string
	Section     string
	AdmissionNo string
	Raw         map[string]string
}

// childInfoColumn maps a header cell to a field. Portals and the clerks who
// export from them are inconsistent about capitalisation and wording, so the
// match is on the folded header against a table of known spellings rather than
// on position — a column order that shifts must not silently reassign the data.
func childInfoColumn(header string) string {
	switch foldKey(header) {
	case "child info id", "childinfo id", "child id", "childinfoid", "student id",
		"child info number", "cid":
		return "child_info_id"
	case "student name", "name", "child name", "name of the student", "name of student":
		return "student_name"
	case "father name", "fathers name", "father s name", "name of father":
		return "father_name"
	case "mother name", "mothers name", "mother s name", "name of mother":
		return "mother_name"
	case "date of birth", "dob", "birth date", "birthdate":
		return "date_of_birth"
	case "gender", "sex":
		return "gender"
	case "aadhaar", "aadhaar no", "aadhar", "aadhaar last4", "aadhaar last 4":
		return "aadhaar_last4"
	case "apaar", "apaar id", "apaarid":
		return "apaar_id"
	case "class", "class name", "standard", "grade":
		return "class_label"
	case "section", "section name":
		return "section_label"
	case "admission no", "admission number", "adm no", "admissionno":
		return "admission_no"
	}
	return ""
}

// parseChildInfoCSV reads the portal extract.
//
// Parsed on the server rather than in the browser, for the same reason the
// board result import is: what was reconciled must be what arrived, and a
// second client must not get to invent its own idea of which column is the
// Child Info id.
func parseChildInfoCSV(text string) ([]childInfoLine, error) {
	// Excel writes a UTF-8 BOM in front of the header, which would otherwise
	// become part of the first column's name and stop it being recognised.
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(text, "\uFEFF")))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1

	header, err := reader.Read()
	if err != nil {
		return nil, errors.New("could not read the file's header row")
	}
	canon := make([]string, len(header))
	known := 0
	for i, h := range header {
		canon[i] = childInfoColumn(h)
		if canon[i] != "" {
			known++
		}
	}
	if known == 0 {
		return nil, errors.New(
			"none of the columns could be recognised. The extract needs at least a " +
				"Child Info ID or an admission number, and a student name")
	}

	var out []childInfoLine
	line := 1
	for {
		rec, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		line++
		if err != nil {
			return nil, errors.New("line " + itoa(line) + " could not be read: " + err.Error())
		}
		l := childInfoLine{LineNo: line, Raw: map[string]string{}}
		for i, cell := range rec {
			if i >= len(header) {
				break
			}
			cell = strings.TrimSpace(cell)
			l.Raw[strings.TrimSpace(header[i])] = cell
			switch canon[i] {
			case "child_info_id":
				l.ChildInfoID = cell
			case "student_name":
				l.Name = cell
			case "father_name":
				l.Father = cell
			case "mother_name":
				l.Mother = cell
			case "date_of_birth":
				l.DOB = childInfoDate(cell)
			case "gender":
				l.Gender = childInfoGender(cell)
			case "aadhaar_last4":
				l.Aadhaar = aadhaarLastFour(cell)
			case "apaar_id":
				l.APAAR = cell
			case "class_label":
				l.Class = cell
			case "section_label":
				l.Section = cell
			case "admission_no":
				l.AdmissionNo = cell
			}
		}
		// A wholly blank line is the trailing newline every spreadsheet leaves.
		if l.ChildInfoID == "" && l.Name == "" && l.AdmissionNo == "" {
			continue
		}
		out = append(out, l)
	}
	if len(out) == 0 {
		return nil, errors.New("the file has a header but no rows")
	}
	return out, nil
}

// childInfoDate accepts the three shapes a state portal export arrives in.
// An unparseable value is kept as-is so the mismatch is reported rather than
// silently discarded — a date the school cannot read is itself the finding.
func childInfoDate(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	for _, layout := range []string{"2006-01-02", "02/01/2006", "02-01-2006", "2006/01/02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Format("2006-01-02")
		}
	}
	return s
}

func childInfoGender(s string) string {
	switch foldKey(s) {
	case "m", "male", "boy":
		return "male"
	case "f", "female", "girl":
		return "female"
	case "":
		return ""
	}
	return "other"
}

// aadhaarLastFour keeps only the trailing four digits. The schema stores
// aadhaar_last4 and never the whole number, and an extract that carries all
// twelve must not be the reason twelve end up in this database.
func aadhaarLastFour(s string) string {
	digits := make([]rune, 0, len(s))
	for _, r := range s {
		if r >= '0' && r <= '9' {
			digits = append(digits, r)
		}
	}
	if len(digits) < 4 {
		return ""
	}
	return string(digits[len(digits)-4:])
}

// childInfoStudent is one of ours, as the reconciliation sees them.
type childInfoStudent struct {
	ID          string
	AdmissionNo string
	ChildInfoID *string
	Name        string
	Father      *string
	Mother      *string
	DOB         *string
	Gender      *string
	Aadhaar     *string
	APAAR       *string
	Class       *string
}

type childInfoImportRequest struct {
	AcademicYearID string `json:"academic_year_id"`
	SourceLabel    string `json:"source_label"`
	FileName       string `json:"file_name"`
	Note           string `json:"note"`
	CSV            string `json:"csv"`
	// DryRun reports what would be raised and writes nothing. The default, so a
	// clerk meets the three lists before an import exists to be explained.
	DryRun bool `json:"dry_run"`
}

type childInfoImportResult struct {
	ImportID   *string            `json:"import_id,omitempty"`
	DryRun     bool               `json:"dry_run"`
	Rows       int                `json:"rows"`
	PortalOnly int                `json:"portal_only_count"`
	SchoolOnly int                `json:"school_only_count"`
	Mismatch   int                `json:"mismatch_count"`
	Suppressed int                `json:"suppressed_count"`
	Open       int                `json:"open_count"`
	Sample     []childInfoDiffRow `json:"sample"`
}

type childInfoDiffRow struct {
	ID          string  `json:"id"`
	ImportID    string  `json:"import_id"`
	Kind        string  `json:"kind"`
	MatchKey    string  `json:"match_key"`
	Field       *string `json:"field,omitempty"`
	PortalValue *string `json:"portal_value,omitempty"`
	SchoolValue *string `json:"school_value,omitempty"`
	StudentID   *string `json:"student_id,omitempty"`
	ChildInfoID *string `json:"child_info_id,omitempty"`
	DisplayName *string `json:"display_name,omitempty"`
	AdmissionNo *string `json:"admission_no,omitempty"`
	Status      string  `json:"status"`
	// The decision that suppressed it, when one did — so a screen can show why
	// a row is not in the open list without a second request.
	Action *string `json:"resolution_action,omitempty"`
	Note   *string `json:"resolution_note,omitempty"`
}

// childInfoDiff is one difference before it is written.
type childInfoDiff struct {
	Kind        string
	MatchKey    string
	Field       string
	PortalValue string
	SchoolValue string
	RowID       any
	StudentID   any
	ChildInfoID string
	DisplayName string
	AdmissionNo string
}

/*
importChildInfoExtract loads the portal file and produces the three-way diff.

	Runs entirely inside one transaction, and rolls it back when dry_run is set,
	which is what makes the preview exactly the thing that would be stored rather
	than a second implementation of it that drifts.
*/
func (s *Server) importChildInfoExtract(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req childInfoImportRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.CSV) == "" {
		httpx.BadRequest(w, r, "paste or upload the portal's extract")
		return
	}
	lines, err := parseChildInfoCSV(req.CSV)
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	out := childInfoImportResult{DryRun: req.DryRun, Rows: len(lines), Sample: []childInfoDiffRow{}}
	errDry := errors.New("dry run")
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		yearID, _, _, _, err := resolveAcademicYear(r, tx, req.AcademicYearID)
		if err != nil {
			return err
		}

		students, err := loadChildInfoStudents(r, tx, yearID)
		if err != nil {
			return err
		}
		diffs := childInfoCompare(lines, students)

		var importID string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO child_info_imports
			    (institution_id, academic_year_id, source_label, file_name, row_count,
			     imported_by, note)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id::text`,
			id.InstitutionID, yearID, nullString(strings.TrimSpace(req.SourceLabel)),
			nullString(strings.TrimSpace(req.FileName)), len(lines),
			nullUUIDArg(id.UserID), nullString(strings.TrimSpace(req.Note))).
			Scan(&importID); err != nil {
			return err
		}
		impID, err := uuid.Parse(importID)
		if err != nil {
			return err
		}
		out.ImportID = &importID

		// The rows as given, so a disputed difference traces to its line.
		lineID := map[int]string{}
		for _, l := range lines {
			raw, err := json.Marshal(l.Raw)
			if err != nil {
				return err
			}
			var rowID string
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO child_info_rows
				    (institution_id, import_id, line_no, child_info_id, student_name,
				     father_name, mother_name, date_of_birth, gender, aadhaar_last4,
				     apaar_id, class_label, section_label, admission_no, raw)
				VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::date,NULLIF($9,''),
				        NULLIF($10,''),NULLIF($11,''),NULLIF($12,''),NULLIF($13,''),
				        NULLIF($14,''),$15)
				RETURNING id::text`,
				id.InstitutionID, impID, l.LineNo, nullString(l.ChildInfoID),
				nullString(l.Name), nullString(l.Father), nullString(l.Mother),
				l.DOB, l.Gender, l.Aadhaar, l.APAAR, l.Class, l.Section,
				l.AdmissionNo, raw).Scan(&rowID); err != nil {
				return err
			}
			lineID[l.LineNo] = rowID
		}

		for _, d := range diffs {
			if n, ok := d.RowID.(int); ok {
				if rid, found := lineID[n]; found {
					d.RowID = rid
				} else {
					d.RowID = nil
				}
			}

			/* Has this exact difference already been settled?

			   Matched on identity *and* on the values. A resolution recorded
			   against "portal says RAMESH, we say Ramesh" does not cover a
			   later "portal says RAJESH" — that is a new disagreement and the
			   school has to see it. */
			var (
				resID, action, note *string
			)
			if err := tx.QueryRow(r.Context(), `
				SELECT id::text, action, note
				  FROM child_info_resolutions
				 WHERE kind = $1 AND match_key = $2 AND COALESCE(field,'') = $3
				   AND COALESCE(portal_value,'') = $4
				   AND COALESCE(school_value,'') = $5`,
				d.Kind, d.MatchKey, d.Field, d.PortalValue, d.SchoolValue).
				Scan(&resID, &action, &note); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}

			status := "open"
			if resID != nil {
				status = "suppressed"
				out.Suppressed++
			} else {
				out.Open++
			}
			switch d.Kind {
			case "portal_only":
				out.PortalOnly++
			case "school_only":
				out.SchoolOnly++
			default:
				out.Mismatch++
			}

			var diffID string
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO child_info_differences
				    (institution_id, import_id, kind, match_key, field, portal_value,
				     school_value, row_id, student_id, child_info_id, display_name,
				     admission_no, status, resolution_id)
				VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),
				        $8,$9,NULLIF($10,''),NULLIF($11,''),NULLIF($12,''),$13,$14)
				ON CONFLICT (import_id, kind, match_key, COALESCE(field,''))
				DO UPDATE SET status = EXCLUDED.status
				RETURNING id::text`,
				id.InstitutionID, impID, d.Kind, d.MatchKey, d.Field, d.PortalValue,
				d.SchoolValue, d.RowID, d.StudentID, d.ChildInfoID, d.DisplayName,
				d.AdmissionNo, status, resID).Scan(&diffID); err != nil {
				return err
			}
			if status == "open" && len(out.Sample) < 25 {
				out.Sample = append(out.Sample, childInfoDiffRow{
					ID: diffID, ImportID: importID, Kind: d.Kind, MatchKey: d.MatchKey,
					Field: nullString(d.Field), PortalValue: nullString(d.PortalValue),
					SchoolValue: nullString(d.SchoolValue),
					ChildInfoID: nullString(d.ChildInfoID),
					DisplayName: nullString(d.DisplayName),
					AdmissionNo: nullString(d.AdmissionNo), Status: status,
					Action: action, Note: note,
				})
			}
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE child_info_imports
			   SET portal_only_count = $2, school_only_count = $3, mismatch_count = $4,
			       suppressed_count = $5
			 WHERE id = $1`,
			impID, out.PortalOnly, out.SchoolOnly, out.Mismatch, out.Suppressed); err != nil {
			return err
		}
		if req.DryRun {
			out.ImportID = nil
			return errDry
		}
		return nil
	})
	if err != nil && !errors.Is(err, errDry) {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// loadChildInfoStudents reads the school's roll for the year.
func loadChildInfoStudents(r *http.Request, tx pgx.Tx, yearID uuid.UUID) ([]childInfoStudent, error) {
	rows, err := tx.Query(r.Context(), `
		SELECT st.id::text, st.admission_no, st.child_info_id,
		       -- Collapsed, not just trimmed: a student with no middle name
		       -- would otherwise carry a double space into every name
		       -- comparison and be reported as a mismatch against a portal
		       -- that spells it with one.
		       regexp_replace(btrim(COALESCE(st.first_name,'') || ' ' ||
		             COALESCE(st.middle_name,'') || ' ' || COALESCE(st.last_name,'')),
		             '\s+', ' ', 'g'),
		       g_f.full_name, g_m.full_name,
		       to_char(st.date_of_birth,'YYYY-MM-DD'), st.gender,
		       st.aadhaar_last4, st.apaar_id, c.name
		  FROM students st
		  LEFT JOIN LATERAL (
		      SELECT e.class_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.academic_year_id = $1
		         AND e.status = 'active' LIMIT 1) en ON true
		  LEFT JOIN classes c ON c.id = en.class_id
		  LEFT JOIN LATERAL (
		      SELECT g.full_name FROM student_guardians sg
		        JOIN guardians g ON g.id = sg.guardian_id
		       WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1) g_f ON true
		  LEFT JOIN LATERAL (
		      SELECT g.full_name FROM student_guardians sg
		        JOIN guardians g ON g.id = sg.guardian_id
		       WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1) g_m ON true
		 WHERE st.status = 'active'`, yearID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []childInfoStudent
	for rows.Next() {
		var v childInfoStudent
		if err := rows.Scan(&v.ID, &v.AdmissionNo, &v.ChildInfoID, &v.Name,
			&v.Father, &v.Mother, &v.DOB, &v.Gender, &v.Aadhaar, &v.APAAR,
			&v.Class); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

/*
childInfoCompare produces the three-way difference.

	Matching is by Child Info id first, admission number second, and name plus
	date of birth third. Three passes rather than one because the portal is
	inconsistent about which of them it carries, and matching on name alone in a
	school with four children called Sai Kumar is how a reconciliation quietly
	merges two of them.

	match_key is the durable identity a resolution is stored against: the Child
	Info id where there is one, and 'student:<uuid>' for a child only we hold.
	It has to survive the extract that raised it, so it can never be a row id.
*/
func childInfoCompare(lines []childInfoLine, students []childInfoStudent) []childInfoDiff {
	byChildID := map[string]int{}
	byAdmission := map[string]int{}
	byNameDOB := map[string]int{}
	for i, st := range students {
		if !blank(st.ChildInfoID) {
			byChildID[foldKey(*st.ChildInfoID)] = i
		}
		byAdmission[foldKey(st.AdmissionNo)] = i
		byNameDOB[foldKey(st.Name)+"|"+deref(st.DOB)] = i
	}

	matched := make([]bool, len(students))
	var out []childInfoDiff

	for _, l := range lines {
		idx := -1
		if l.ChildInfoID != "" {
			if i, ok := byChildID[foldKey(l.ChildInfoID)]; ok {
				idx = i
			}
		}
		if idx < 0 && l.AdmissionNo != "" {
			if i, ok := byAdmission[foldKey(l.AdmissionNo)]; ok {
				idx = i
			}
		}
		if idx < 0 && l.Name != "" && l.DOB != "" {
			if i, ok := byNameDOB[foldKey(l.Name)+"|"+l.DOB]; ok {
				idx = i
			}
		}

		key := l.ChildInfoID
		if key == "" {
			key = "line:" + itoa(l.LineNo)
		}

		if idx < 0 {
			out = append(out, childInfoDiff{
				Kind: "portal_only", MatchKey: key, RowID: l.LineNo,
				ChildInfoID: l.ChildInfoID, DisplayName: l.Name,
				AdmissionNo: l.AdmissionNo, PortalValue: l.Name,
			})
			continue
		}
		matched[idx] = true
		st := students[idx]
		// Once matched, the identity is the child's, not the line's.
		mk := l.ChildInfoID
		if mk == "" {
			mk = "student:" + st.ID
		}
		for _, f := range []struct{ field, portal, school string }{
			{"student_name", l.Name, st.Name},
			{"date_of_birth", l.DOB, deref(st.DOB)},
			{"gender", l.Gender, deref(st.Gender)},
			{"aadhaar_last4", l.Aadhaar, deref(st.Aadhaar)},
			{"apaar_id", l.APAAR, deref(st.APAAR)},
			{"class_label", l.Class, deref(st.Class)},
			{"father_name", l.Father, deref(st.Father)},
			{"mother_name", l.Mother, deref(st.Mother)},
		} {
			// A field the portal did not send is not a disagreement. Reporting
			// every blank column as a mismatch buries the eleven that matter
			// under four hundred that do not.
			if strings.TrimSpace(f.portal) == "" || foldKey(f.portal) == foldKey(f.school) {
				continue
			}
			out = append(out, childInfoDiff{
				Kind: "field_mismatch", MatchKey: mk, Field: f.field,
				PortalValue: f.portal, SchoolValue: f.school,
				RowID: l.LineNo, StudentID: st.ID, ChildInfoID: l.ChildInfoID,
				DisplayName: st.Name, AdmissionNo: st.AdmissionNo,
			})
		}
	}

	for i, st := range students {
		if matched[i] {
			continue
		}
		out = append(out, childInfoDiff{
			Kind: "school_only", MatchKey: "student:" + st.ID,
			StudentID: st.ID, ChildInfoID: deref(st.ChildInfoID),
			DisplayName: st.Name, AdmissionNo: st.AdmissionNo,
			SchoolValue: st.Name,
		})
	}
	return out
}

func (s *Server) listChildInfoDifferences(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	var importArg any
	if v := strings.TrimSpace(q.Get("import_id")); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "import_id must be a uuid")
			return
		}
		importArg = parsed
	}
	kind := strings.TrimSpace(q.Get("kind"))
	status := strings.TrimSpace(q.Get("status"))
	if status == "" {
		status = "open"
	}

	out := []childInfoDiffRow{}
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		// Defaults to the newest import, so the screen has something on first
		// load without the caller having to fetch the list first.
		rows, err := tx.Query(r.Context(), `
			SELECT d.id::text, d.import_id::text, d.kind, d.match_key, d.field,
			       d.portal_value, d.school_value, d.student_id::text, d.child_info_id,
			       d.display_name, d.admission_no, d.status, res.action, res.note
			  FROM child_info_differences d
			  LEFT JOIN child_info_resolutions res ON res.id = d.resolution_id
			 WHERE d.import_id = COALESCE($1::uuid,
			        (SELECT id FROM child_info_imports ORDER BY imported_at DESC LIMIT 1))
			   AND ($2::text = '' OR d.kind = $2)
			   AND ($3::text = 'all' OR d.status = $3)
			 ORDER BY d.kind, d.display_name, d.field`, importArg, kind, status)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v childInfoDiffRow
			if err := rows.Scan(&v.ID, &v.ImportID, &v.Kind, &v.MatchKey, &v.Field,
				&v.PortalValue, &v.SchoolValue, &v.StudentID, &v.ChildInfoID,
				&v.DisplayName, &v.AdmissionNo, &v.Status, &v.Action, &v.Note); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type childInfoResolveRequest struct {
	Action string `json:"action"`
	Note   string `json:"note"`
	// ApplyLocally writes the portal's value onto the student. Only meaningful
	// with action fix_local, and only for the fields the school actually holds.
	ApplyLocally bool `json:"apply_locally"`
}

// childInfoWritable is the set of fields a resolution may write back onto a
// student. Deliberately short: a reconciliation screen is not a student editor,
// and class or guardian names change through the enrolment and family screens
// that know what else has to move with them.
var childInfoWritable = map[string]string{
	"student_name":  "",
	"date_of_birth": "date_of_birth",
	"gender":        "gender",
	"aadhaar_last4": "aadhaar_last4",
	"apaar_id":      "apaar_id",
}

/*
resolveChildInfoDifference records the decision, durably.

	The resolution row is what persists; the difference row is only this month's
	sighting of it. Written as an upsert on the difference's identity so a school
	that changes its mind replaces the earlier decision rather than accumulating
	two that disagree.
*/
func (s *Server) resolveChildInfoDifference(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	diffID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req childInfoResolveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Action = strings.TrimSpace(req.Action)
	switch req.Action {
	case "fix_local", "mark_for_portal", "accept":
	default:
		httpx.BadRequest(w, r, "action must be fix_local, mark_for_portal or accept")
		return
	}

	var applied bool
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		var (
			kind, matchKey              string
			field, portalVal, schoolVal *string
			studentID                   *string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT kind, match_key, field, portal_value, school_value, student_id::text
			  FROM child_info_differences WHERE id = $1 FOR UPDATE`, diffID).
			Scan(&kind, &matchKey, &field, &portalVal, &schoolVal, &studentID); err != nil {
			return err
		}

		var resID string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO child_info_resolutions
			    (institution_id, kind, match_key, field, portal_value, school_value,
			     action, note, resolved_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (institution_id, kind, match_key, COALESCE(field,''))
			DO UPDATE SET portal_value = EXCLUDED.portal_value,
			              school_value = EXCLUDED.school_value,
			              action = EXCLUDED.action,
			              note = EXCLUDED.note,
			              resolved_by = EXCLUDED.resolved_by,
			              resolved_at = now()
			RETURNING id::text`,
			id.InstitutionID, kind, matchKey, field, portalVal, schoolVal,
			req.Action, nullString(strings.TrimSpace(req.Note)),
			nullUUIDArg(id.UserID)).Scan(&resID); err != nil {
			return err
		}

		if req.ApplyLocally && req.Action == "fix_local" && studentID != nil &&
			field != nil && portalVal != nil {
			col, ok := childInfoWritable[*field]
			if !ok || col == "" {
				return errors.New(
					"this field cannot be corrected from here. Change it on the student " +
						"record, where the rest of what depends on it moves with it")
			}
			// The column name comes from the allow-list above, never from the
			// request: it is concatenated into SQL and a request-supplied value
			// here would be an injection sink.
			if _, err := tx.Exec(r.Context(),
				`UPDATE students SET `+col+` = $2, updated_at = now() WHERE id = $1`,
				*studentID, *portalVal); err != nil {
				return err
			}
			applied = true
		}

		_, err := tx.Exec(r.Context(),
			`UPDATE child_info_differences SET status = 'resolved', resolution_id = $2
			  WHERE id = $1`, diffID, resID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"resolved": true, "applied_locally": applied,
		})
	}
}

type childInfoResolutionRow struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	MatchKey    string  `json:"match_key"`
	Field       *string `json:"field,omitempty"`
	PortalValue *string `json:"portal_value,omitempty"`
	SchoolValue *string `json:"school_value,omitempty"`
	Action      string  `json:"action"`
	Note        *string `json:"note,omitempty"`
	ResolvedBy  *string `json:"resolved_by,omitempty"`
	ResolvedAt  string  `json:"resolved_at"`
}

func (s *Server) listChildInfoResolutions(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT res.id::text, res.kind, res.match_key, res.field, res.portal_value,
		       res.school_value, res.action, res.note, u.full_name,
		       to_char(res.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
		  FROM child_info_resolutions res
		  LEFT JOIN users u ON u.id = res.resolved_by
		 ORDER BY res.resolved_at DESC`, nil,
		func(rows pgx.Rows) (childInfoResolutionRow, error) {
			var v childInfoResolutionRow
			return v, rows.Scan(&v.ID, &v.Kind, &v.MatchKey, &v.Field, &v.PortalValue,
				&v.SchoolValue, &v.Action, &v.Note, &v.ResolvedBy, &v.ResolvedAt)
		})
	respond(w, r, items, err)
}

// forgetChildInfoResolution un-settles a difference so the next run raises it.
//
// The counterpart to dismissing one. A school that accepted a mismatch in
// error must be able to put it back in front of itself, or the suppression
// becomes the new way to lose a child.
func (s *Server) forgetChildInfoResolution(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	resID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			UPDATE child_info_differences SET status = 'open', resolution_id = NULL
			 WHERE resolution_id = $1`, resID); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM child_info_resolutions WHERE id = $1`, resID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// ============================================================================
// 4. Working days and instructional hours
// ============================================================================

/* The RTE return, computed rather than typed.

   Two figures per class: how many days the school actually opened for them, and
   how many hours of instruction those days carried. Both come from data that
   already exists — holidays for the calendar, timetable_entries × periods for
   the hours — because a school asked to type them will type last year's.

   The shortfall is the output that matters, and it matters early. A school told
   in April that it was thirty hours short of the statutory minimum has learned
   something it can no longer act on; told in November, it moves a few Saturdays.
   So this computes against the year to date as well as the whole year.

   Manual adjustment exists because reality does. A half day for a funeral, a
   bandh, an inspection that took a morning: each is a signed row with a reason
   rather than an edit of the computed number, so the return can always explain
   the difference between what the calendar says and what it reports. */

type workingDaysClassRow struct {
	ClassID          *string `json:"class_id,omitempty"`
	ClassLabel       string  `json:"class_label"`
	ClassLevel       *int    `json:"class_level,omitempty"`
	StageCode        *string `json:"stage_code,omitempty"`
	StageLabel       *string `json:"stage_label,omitempty"`
	WorkingDays      float64 `json:"working_days"`
	InstructionalMin int     `json:"instructional_minutes"`
	RequiredDays     int     `json:"required_days"`
	RequiredMin      int     `json:"required_minutes"`
	ShortfallDays    float64 `json:"shortfall_days"`
	ShortfallMin     int     `json:"shortfall_minutes"`
	// Whether the class has a timetable at all. Without one the hours figure is
	// zero, and reporting that as a shortfall of the whole statutory minimum
	// would be alarming and wrong.
	HasTimetable bool `json:"has_timetable"`
}

type workingDaysResult struct {
	AcademicYearID string `json:"academic_year_id"`
	AcademicYear   string `json:"academic_year"`
	PeriodFrom     string `json:"period_from"`
	PeriodTo       string `json:"period_to"`
	// Whether the window has been cut short at today. The whole-year figure is
	// a projection; the year-to-date one is a fact, and a screen that does not
	// distinguish them invites a school to relax in September.
	ToDate          bool                  `json:"to_date"`
	CalendarDays    int                   `json:"calendar_days"`
	WorkingDays     float64               `json:"working_days"`
	DeclaredWorking *int                  `json:"declared_working_days,omitempty"`
	RequiredWorking int                   `json:"required_working_days"`
	AdjustmentDays  float64               `json:"adjustment_days"`
	AdjustmentMin   int                   `json:"adjustment_minutes"`
	ClassesShort    int                   `json:"classes_short"`
	Classes         []workingDaysClassRow `json:"classes"`
	Notes           []string              `json:"notes"`
}

// wdNorm is one stage band, with the classes.level range it covers.
type wdNorm struct {
	StageCode string
	Label     string
	MinLevel  int
	MaxLevel  int
	MinDays   int
	MinHours  float64
}

/*
rteDefaults is the RTE Act schedule, used when a school has no norms yet.

	The migration seeds these for every school that existed when it ran; this is
	the same list, in Go, so a school created afterwards is seeded on first read
	rather than showing an empty screen until somebody notices. Secondary and
	higher secondary are marked as state norms rather than statute, because the
	RTE schedule stops at class VIII.
*/
var rteDefaults = []wdNorm{
	{"primary", "Primary (I-V)", 1, 5, 200, 800},
	{"upper_primary", "Upper primary (VI-VIII)", 6, 8, 220, 1000},
	{"secondary", "Secondary (IX-X)", 9, 10, 220, 1100},
	{"higher_secondary", "Higher secondary (XI-XII)", 11, 12, 220, 1100},
}

// ensureInstructionalNorms seeds the RTE defaults for a school that has none.
func ensureInstructionalNorms(r *http.Request, tx pgx.Tx, inst uuid.UUID) error {
	var n int
	if err := tx.QueryRow(r.Context(),
		`SELECT count(*)::int FROM instructional_norms`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	for _, d := range rteDefaults {
		authority, note := "RTE Act 2009, Schedule", "Statutory minimum."
		if d.MinLevel > 8 {
			authority = "State norm"
			note = "Not set by the RTE Act, which stops at class VIII. " +
				"Check the figure your board inspects against."
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO instructional_norms
			    (institution_id, stage_code, label, min_level, max_level,
			     min_days, min_hours, authority, note)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (institution_id, lower(stage_code)) DO NOTHING`,
			inst, d.StageCode, d.Label, d.MinLevel, d.MaxLevel,
			d.MinDays, d.MinHours, authority, note); err != nil {
			return err
		}
	}
	return nil
}

func loadInstructionalNorms(r *http.Request, tx pgx.Tx) ([]wdNorm, error) {
	rows, err := tx.Query(r.Context(), `
		SELECT stage_code, label, min_level, max_level, min_days, min_hours::float8
		  FROM instructional_norms ORDER BY min_level`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []wdNorm
	for rows.Next() {
		var v wdNorm
		if err := rows.Scan(&v.StageCode, &v.Label, &v.MinLevel, &v.MaxLevel,
			&v.MinDays, &v.MinHours); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func normFor(norms []wdNorm, level *int) *wdNorm {
	if level == nil {
		return nil
	}
	for i := range norms {
		if *level >= norms[i].MinLevel && *level <= norms[i].MaxLevel {
			return &norms[i]
		}
	}
	return nil
}

/*
computeWorkingDays is the whole calculation, in one place.

	Deliberately not a single monster query. The day count is one question of the
	calendar, the minutes-per-weekday is another of the timetable, and the
	adjustments a third; joining all three in SQL produced a statement nobody
	could check and a Cartesian product that double-counted every adjustment
	against every weekday.
*/
func computeWorkingDays(r *http.Request, tx pgx.Tx, yearID uuid.UUID,
	from, to time.Time) (workingDaysResult, error) {

	ctx := r.Context()
	out := workingDaysResult{
		AcademicYearID: yearID.String(),
		PeriodFrom:     from.Format("2006-01-02"),
		PeriodTo:       to.Format("2006-01-02"),
		Classes:        []workingDaysClassRow{},
		Notes:          []string{},
	}

	/* Which days the school was open, by weekday.

	   Copied from the counter in admin_academics.go so the two screens cannot
	   disagree: Sunday is closed unless explicitly marked a working day, a
	   holiday or vacation that applies to students closes the day, and
	   kind='working_day' overrides both — that is the row a school adds after a
	   bandh to pull a Saturday back in. */
	dayRows, err := tx.Query(ctx, `
		WITH days AS (
		    SELECT d::date AS on_date
		      FROM generate_series($1::date, $2::date, interval '1 day') d)
		SELECT extract(isodow FROM d.on_date)::int, count(*)::int
		  FROM days d
		 WHERE EXISTS (SELECT 1 FROM holidays h
		                WHERE h.kind = 'working_day'
		                  AND d.on_date BETWEEN h.on_date AND COALESCE(h.to_date, h.on_date))
		    OR (extract(isodow FROM d.on_date) <> 7
		        AND NOT EXISTS (SELECT 1 FROM holidays h
		                         WHERE h.kind IN ('holiday','vacation')
		                           AND h.applies_to IN ('all','students')
		                           AND d.on_date BETWEEN h.on_date
		                                            AND COALESCE(h.to_date, h.on_date)))
		 GROUP BY 1`, from, to)
	if err != nil {
		return out, err
	}
	openDays := map[int]int{}
	baseDays := 0
	for dayRows.Next() {
		var dow, n int
		if err := dayRows.Scan(&dow, &n); err != nil {
			dayRows.Close()
			return out, err
		}
		openDays[dow] = n
		baseDays += n
	}
	dayRows.Close()
	if err := dayRows.Err(); err != nil {
		return out, err
	}
	out.CalendarDays = int(to.Sub(from).Hours()/24) + 1

	/* Minutes of instruction per class per weekday.

	   Averaged across the sections of a class, because sections of one class
	   run the same curriculum and a return is filed per class. Breaks are
	   excluded: periods.is_break is what separates a lesson from a lunch, and
	   counting lunch as instruction is the sort of thing an inspection notices. */
	minRows, err := tx.Query(ctx, `
		SELECT c.id::text, c.name, c.level, sm.weekday, AVG(sm.mins)::float8
		  FROM (
		      SELECT sec.class_id, te.section_id, te.weekday,
		             SUM(EXTRACT(epoch FROM (p.ends_at - p.starts_at)) / 60) AS mins
		        FROM timetable_entries te
		        JOIN sections sec ON sec.id = te.section_id
		        JOIN periods  p   ON p.id  = te.period_id
		       WHERE te.academic_year_id = $1 AND p.is_break = false
		       GROUP BY sec.class_id, te.section_id, te.weekday
		  ) sm
		  JOIN classes c ON c.id = sm.class_id
		 GROUP BY c.id, c.name, c.level, sm.weekday`, yearID)
	if err != nil {
		return out, err
	}
	type classAcc struct {
		Name     string
		Level    *int
		Weekday  map[int]float64
		HasTable bool
	}
	classes := map[string]*classAcc{}
	for minRows.Next() {
		var cid, name string
		var level *int
		var weekday int
		var mins float64
		if err := minRows.Scan(&cid, &name, &level, &weekday, &mins); err != nil {
			minRows.Close()
			return out, err
		}
		acc, ok := classes[cid]
		if !ok {
			acc = &classAcc{Name: name, Level: level, Weekday: map[int]float64{}}
			classes[cid] = acc
		}
		acc.Weekday[weekday] = mins
		acc.HasTable = true
	}
	minRows.Close()
	if err := minRows.Err(); err != nil {
		return out, err
	}

	// Every class, including those with no timetable — a class missing from the
	// return because nobody built its timetable is the failure this is for.
	allRows, err := tx.Query(ctx, `SELECT id::text, name, level FROM classes ORDER BY level, name`)
	if err != nil {
		return out, err
	}
	var order []string
	for allRows.Next() {
		var cid, name string
		var level *int
		if err := allRows.Scan(&cid, &name, &level); err != nil {
			allRows.Close()
			return out, err
		}
		if _, ok := classes[cid]; !ok {
			classes[cid] = &classAcc{Name: name, Level: level, Weekday: map[int]float64{}}
		}
		order = append(order, cid)
	}
	allRows.Close()
	if err := allRows.Err(); err != nil {
		return out, err
	}

	// Adjustments. A NULL class_id applies to every class, which is the usual
	// case: the school shut, not one section.
	adjRows, err := tx.Query(ctx, `
		SELECT class_id::text, SUM(days_delta)::float8, SUM(minutes_delta)::int
		  FROM working_days_adjustments
		 WHERE academic_year_id = $1 AND on_date BETWEEN $2 AND $3
		 GROUP BY class_id`, yearID, from, to)
	if err != nil {
		return out, err
	}
	classAdjDays := map[string]float64{}
	classAdjMin := map[string]int{}
	var allDays float64
	var allMin int
	for adjRows.Next() {
		var cid *string
		var days float64
		var mins int
		if err := adjRows.Scan(&cid, &days, &mins); err != nil {
			adjRows.Close()
			return out, err
		}
		if cid == nil {
			allDays += days
			allMin += mins
			continue
		}
		classAdjDays[*cid] = days
		classAdjMin[*cid] = mins
	}
	adjRows.Close()
	if err := adjRows.Err(); err != nil {
		return out, err
	}
	out.AdjustmentDays = allDays
	out.AdjustmentMin = allMin
	out.WorkingDays = float64(baseDays) + allDays

	norms, err := loadInstructionalNorms(r, tx)
	if err != nil {
		return out, err
	}

	// The whole-school minimum the vendor configured, as a fallback for a class
	// whose level falls outside every stage band.
	fallbackDays := 220
	if err := tx.QueryRow(ctx,
		`SELECT required_working_days FROM academic_calendar_models`).
		Scan(&fallbackDays); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if err := tx.QueryRow(ctx,
		`SELECT working_days FROM academic_years WHERE id = $1`, yearID).
		Scan(&out.DeclaredWorking); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	out.RequiredWorking = fallbackDays

	noTimetable := 0
	for _, cid := range order {
		acc := classes[cid]
		days := float64(baseDays) + allDays + classAdjDays[cid]

		minutes := 0.0
		for dow, count := range openDays {
			minutes += acc.Weekday[dow] * float64(count)
		}
		minutes += float64(allMin + classAdjMin[cid])
		if minutes < 0 {
			minutes = 0
		}

		row := workingDaysClassRow{
			ClassID: &cid, ClassLabel: acc.Name, ClassLevel: acc.Level,
			WorkingDays: round2(days), InstructionalMin: int(minutes + 0.5),
			RequiredDays: fallbackDays, HasTimetable: acc.HasTable,
		}
		if n := normFor(norms, acc.Level); n != nil {
			row.StageCode = &n.StageCode
			row.StageLabel = &n.Label
			row.RequiredDays = n.MinDays
			row.RequiredMin = int(n.MinHours * 60)
		}
		if d := float64(row.RequiredDays) - row.WorkingDays; d > 0 {
			row.ShortfallDays = round2(d)
		}
		if row.HasTimetable {
			if m := row.RequiredMin - row.InstructionalMin; m > 0 {
				row.ShortfallMin = m
			}
		} else {
			noTimetable++
		}
		if row.ShortfallDays > 0 || row.ShortfallMin > 0 {
			out.ClassesShort++
		}
		out.Classes = append(out.Classes, row)
	}

	if noTimetable > 0 {
		out.Notes = append(out.Notes, itoa(noTimetable)+
			" class(es) have no timetable for this year, so their instructional hours "+
			"could not be computed. Their day count is still correct.")
	}
	if out.DeclaredWorking != nil && *out.DeclaredWorking > 0 {
		if diff := *out.DeclaredWorking - int(out.WorkingDays); diff > 2 || diff < -2 {
			out.Notes = append(out.Notes,
				"The calendar gives "+itoa(int(out.WorkingDays))+" working days but the "+
					"academic year declares "+itoa(*out.DeclaredWorking)+
					". One of the two is wrong, and the return will be read against the calendar.")
		}
	}
	return out, nil
}

func round2(f float64) float64 { return float64(int(f*100+0.5)) / 100 }

// getWorkingDays computes the return without filing it.
//
// ?to_date=1 cuts the window at today, which is the reading a head of school
// acts on: a shortfall projected across a year that has not happened yet is not
// yet a problem, and one accumulated by November is.
func (s *Server) getWorkingDays(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	toDate := r.URL.Query().Get("to_date") == "1"
	var out workingDaysResult
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		if err := ensureInstructionalNorms(r, tx, id.InstitutionID); err != nil {
			return err
		}
		yearID, yearName, starts, ends, err := resolveAcademicYear(r, tx, r.URL.Query().Get("academic_year_id"))
		if err != nil {
			return err
		}
		if toDate {
			if today := nowInIndia(); today.Before(ends) {
				ends = today
			}
		}
		out, err = computeWorkingDays(r, tx, yearID, starts, ends)
		out.AcademicYear = yearName
		out.ToDate = toDate
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- the statutory minimum ---------------------------------------------------

type instructionalNormRow struct {
	ID        string  `json:"id"`
	StageCode string  `json:"stage_code"`
	Label     string  `json:"label"`
	MinLevel  int     `json:"min_level"`
	MaxLevel  int     `json:"max_level"`
	MinDays   int     `json:"min_days"`
	MinHours  float64 `json:"min_hours"`
	Authority *string `json:"authority,omitempty"`
	Note      *string `json:"note,omitempty"`
}

func (s *Server) listInstructionalNorms(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	out := []instructionalNormRow{}
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		if err := ensureInstructionalNorms(r, tx, id.InstitutionID); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, stage_code, label, min_level, max_level,
			       min_days, min_hours::float8, authority, note
			  FROM instructional_norms ORDER BY min_level`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v instructionalNormRow
			if err := rows.Scan(&v.ID, &v.StageCode, &v.Label, &v.MinLevel, &v.MaxLevel,
				&v.MinDays, &v.MinHours, &v.Authority, &v.Note); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type instructionalNormRequest struct {
	StageCode string  `json:"stage_code"`
	Label     string  `json:"label"`
	MinLevel  int     `json:"min_level"`
	MaxLevel  int     `json:"max_level"`
	MinDays   int     `json:"min_days"`
	MinHours  float64 `json:"min_hours"`
	Authority string  `json:"authority"`
	Note      string  `json:"note"`
}

// saveInstructionalNorm edits one stage band.
//
// Editable because states amend these and because a school under a stricter
// board norm has to be measured against the one it will be inspected on. The
// RTE figures are the default, not a ceiling.
func (s *Server) saveInstructionalNorm(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req instructionalNormRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.StageCode = strings.TrimSpace(req.StageCode)
	req.Label = strings.TrimSpace(req.Label)
	if req.StageCode == "" {
		httpx.BadRequest(w, r, "stage_code is required")
		return
	}
	if req.Label == "" {
		req.Label = req.StageCode
	}
	if req.MinLevel < 1 || req.MaxLevel < req.MinLevel || req.MaxLevel > 12 {
		httpx.BadRequest(w, r, "min_level and max_level must describe a band inside 1..12")
		return
	}
	if req.MinDays < 0 || req.MinDays > 366 || req.MinHours < 0 {
		httpx.BadRequest(w, r, "min_days must be 0..366 and min_hours cannot be negative")
		return
	}
	var out string
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO instructional_norms
			    (institution_id, stage_code, label, min_level, max_level,
			     min_days, min_hours, authority, note)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (institution_id, lower(stage_code)) DO UPDATE
			   SET label = EXCLUDED.label, min_level = EXCLUDED.min_level,
			       max_level = EXCLUDED.max_level, min_days = EXCLUDED.min_days,
			       min_hours = EXCLUDED.min_hours, authority = EXCLUDED.authority,
			       note = EXCLUDED.note, updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, req.StageCode, req.Label, req.MinLevel, req.MaxLevel,
			req.MinDays, req.MinHours, nullString(strings.TrimSpace(req.Authority)),
			nullString(strings.TrimSpace(req.Note))).Scan(&out)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

// --- adjustments -------------------------------------------------------------

type workingDayAdjustmentRow struct {
	ID         string  `json:"id"`
	ClassID    *string `json:"class_id,omitempty"`
	ClassLabel *string `json:"class_label,omitempty"`
	OnDate     string  `json:"on_date"`
	DaysDelta  float64 `json:"days_delta"`
	MinsDelta  int     `json:"minutes_delta"`
	Reason     string  `json:"reason"`
	CreatedBy  *string `json:"created_by,omitempty"`
	CreatedAt  string  `json:"created_at"`
}

func (s *Server) listWorkingDayAdjustments(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var out []workingDayAdjustmentRow
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		yearID, _, _, _, err := resolveAcademicYear(r, tx, r.URL.Query().Get("academic_year_id"))
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT a.id::text, a.class_id::text, c.name,
			       to_char(a.on_date,'YYYY-MM-DD'), a.days_delta::float8,
			       a.minutes_delta, a.reason, u.full_name,
			       to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM working_days_adjustments a
			  LEFT JOIN classes c ON c.id = a.class_id
			  LEFT JOIN users u ON u.id = a.created_by
			 WHERE a.academic_year_id = $1
			 ORDER BY a.on_date DESC`, yearID)
		if err != nil {
			return err
		}
		defer rows.Close()
		out = []workingDayAdjustmentRow{}
		for rows.Next() {
			var v workingDayAdjustmentRow
			if err := rows.Scan(&v.ID, &v.ClassID, &v.ClassLabel, &v.OnDate,
				&v.DaysDelta, &v.MinsDelta, &v.Reason, &v.CreatedBy, &v.CreatedAt); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type workingDayAdjustmentRequest struct {
	AcademicYearID string  `json:"academic_year_id"`
	ClassID        string  `json:"class_id"`
	OnDate         string  `json:"on_date"`
	DaysDelta      float64 `json:"days_delta"`
	MinsDelta      int     `json:"minutes_delta"`
	Reason         string  `json:"reason"`
}

func (s *Server) saveWorkingDayAdjustment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req workingDayAdjustmentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	req.OnDate = strings.TrimSpace(req.OnDate)
	if req.Reason == "" {
		httpx.BadRequest(w, r,
			"a reason is required. An adjustment nobody can explain is one an inspection will ask about")
		return
	}
	if req.OnDate == "" {
		httpx.BadRequest(w, r, "on_date is required")
		return
	}
	if req.DaysDelta == 0 && req.MinsDelta == 0 {
		httpx.BadRequest(w, r,
			"an adjustment of nothing changes nothing; give a day or a minute delta")
		return
	}
	var classArg any
	if v := strings.TrimSpace(req.ClassID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "class_id must be a uuid")
			return
		}
		classArg = parsed
	}

	var out string
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		yearID, _, _, _, err := resolveAcademicYear(r, tx, req.AcademicYearID)
		if err != nil {
			return err
		}
		err = tx.QueryRow(r.Context(), `
			INSERT INTO working_days_adjustments
			    (institution_id, academic_year_id, class_id, on_date,
			     days_delta, minutes_delta, reason, created_by)
			VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8)
			ON CONFLICT (institution_id, academic_year_id,
			             COALESCE(class_id,'00000000-0000-0000-0000-000000000000'::uuid),
			             on_date, lower(reason))
			DO UPDATE SET days_delta = EXCLUDED.days_delta,
			              minutes_delta = EXCLUDED.minutes_delta
			RETURNING id::text`,
			id.InstitutionID, yearID, classArg, req.OnDate,
			req.DaysDelta, req.MinsDelta, req.Reason, nullUUIDArg(id.UserID)).Scan(&out)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

func (s *Server) deleteWorkingDayAdjustment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	adjID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM working_days_adjustments WHERE id = $1`, adjID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// --- the filed return --------------------------------------------------------

type workingDaysReturnRow struct {
	ID             string                `json:"id"`
	AcademicYearID string                `json:"academic_year_id"`
	Title          string                `json:"title"`
	PeriodFrom     string                `json:"period_from"`
	PeriodTo       string                `json:"period_to"`
	Status         string                `json:"status"`
	WorkingDays    float64               `json:"working_days"`
	ClassesShort   int                   `json:"classes_short"`
	FiledAt        *string               `json:"filed_at,omitempty"`
	FiledBy        *string               `json:"filed_by,omitempty"`
	Notes          *string               `json:"notes,omitempty"`
	CreatedAt      string                `json:"created_at"`
	Lines          []workingDaysClassRow `json:"lines"`
}

func (s *Server) listWorkingDaysReturns(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []workingDaysReturnRow{}
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT t.id::text, t.academic_year_id::text, t.title,
			       to_char(t.period_from,'YYYY-MM-DD'), to_char(t.period_to,'YYYY-MM-DD'),
			       t.status, t.working_days::float8, t.classes_short,
			       to_char(t.filed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', u.full_name, t.notes,
			       to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM working_days_returns t
			  LEFT JOIN users u ON u.id = t.filed_by
			 ORDER BY t.created_at DESC`)
		if err != nil {
			return err
		}
		byID := map[string]int{}
		for rows.Next() {
			var v workingDaysReturnRow
			if err := rows.Scan(&v.ID, &v.AcademicYearID, &v.Title, &v.PeriodFrom,
				&v.PeriodTo, &v.Status, &v.WorkingDays, &v.ClassesShort,
				&v.FiledAt, &v.FiledBy, &v.Notes, &v.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			v.Lines = []workingDaysClassRow{}
			byID[v.ID] = len(out)
			out = append(out, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(out) == 0 {
			return nil
		}
		lrows, err := tx.Query(r.Context(), `
			SELECT return_id::text, class_id::text, class_label, class_level, stage_code,
			       working_days::float8, instructional_minutes, required_days,
			       required_minutes, shortfall_days::float8, shortfall_minutes
			  FROM working_days_return_lines ORDER BY class_level NULLS LAST, class_label`)
		if err != nil {
			return err
		}
		defer lrows.Close()
		for lrows.Next() {
			var rid string
			var v workingDaysClassRow
			var label *string
			if err := lrows.Scan(&rid, &v.ClassID, &label, &v.ClassLevel, &v.StageCode,
				&v.WorkingDays, &v.InstructionalMin, &v.RequiredDays, &v.RequiredMin,
				&v.ShortfallDays, &v.ShortfallMin); err != nil {
				return err
			}
			v.ClassLabel = deref(label)
			v.HasTimetable = v.InstructionalMin > 0
			if i, ok := byID[rid]; ok {
				out[i].Lines = append(out[i].Lines, v)
			}
		}
		return lrows.Err()
	})
	respond(w, r, out, err)
}

type workingDaysReturnRequest struct {
	AcademicYearID string `json:"academic_year_id"`
	Title          string `json:"title"`
	PeriodFrom     string `json:"period_from"`
	PeriodTo       string `json:"period_to"`
	Notes          string `json:"notes"`
}

/*
fileWorkingDaysReturn freezes the figures.

	Recomputed here and stored line by line rather than referenced. The shortfall
	as filed is a fact about the filing: recomputing it later against an amended
	norm, or against a calendar somebody has since corrected, would silently
	restate what the school told the state.
*/
func (s *Server) fileWorkingDaysReturn(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req workingDaysReturnRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)

	var out string
	err := s.DB.InTenant(r.Context(), statutoryScope(id), func(tx pgx.Tx) error {
		if err := ensureInstructionalNorms(r, tx, id.InstitutionID); err != nil {
			return err
		}
		yearID, yearName, starts, ends, err := resolveAcademicYear(r, tx, req.AcademicYearID)
		if err != nil {
			return err
		}
		from, to := starts, ends
		if v := strings.TrimSpace(req.PeriodFrom); v != "" {
			if from, err = time.Parse("2006-01-02", v); err != nil {
				return errors.New("period_from must be YYYY-MM-DD")
			}
		}
		if v := strings.TrimSpace(req.PeriodTo); v != "" {
			if to, err = time.Parse("2006-01-02", v); err != nil {
				return errors.New("period_to must be YYYY-MM-DD")
			}
		}
		if to.Before(from) {
			return errors.New("period_to cannot be before period_from")
		}
		if req.Title == "" {
			req.Title = "Working days and instructional hours " + yearName
		}

		computed, err := computeWorkingDays(r, tx, yearID, from, to)
		if err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO working_days_returns
			    (institution_id, academic_year_id, title, period_from, period_to,
			     status, working_days, classes_short, filed_at, filed_by, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,'filed',$6,$7,now(),$8,$9,$8)
			RETURNING id::text`,
			id.InstitutionID, yearID, req.Title, from, to,
			computed.WorkingDays, computed.ClassesShort, nullUUIDArg(id.UserID),
			nullString(strings.TrimSpace(req.Notes))).Scan(&out); err != nil {
			if isUniqueViolation(err) {
				return errors.New(
					"a return with that title already exists for this year. " +
						"Give this one its own name. A filed return is never replaced")
			}
			return err
		}
		retID, err := uuid.Parse(out)
		if err != nil {
			return err
		}
		for _, line := range computed.Classes {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO working_days_return_lines
				    (institution_id, return_id, class_id, class_label, class_level,
				     stage_code, working_days, instructional_minutes, required_days,
				     required_minutes, shortfall_days, shortfall_minutes)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
				id.InstitutionID, retID, line.ClassID, line.ClassLabel, line.ClassLevel,
				line.StageCode, line.WorkingDays, line.InstructionalMin,
				line.RequiredDays, line.RequiredMin, line.ShortfallDays,
				line.ShortfallMin); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
}

// ============================================================================
// 5. Child Info portal sync (platform tier)
// ============================================================================

/* Platform configuration for a state Child Info portal.

   Read this before assuming there is a live integration here, because there is
   not, and the code is careful never to imply one.

   No state Child Info portal exposes an API to this installation. What exists
   is a portal a clerk signs into, downloads an extract from, and uploads a
   correction file to. So the provider interface below has exactly one working
   implementation — file_exchange — which produces the roster file to upload and
   accepts the extract to reconcile against. The 'api' provider can be recorded
   so a connector exists the day credentials arrive, and until then the screen
   says plainly that it cannot run. Nothing here ever reports a sync it did not
   perform.

   Three things make this platform scope rather than a school's own setting:

     A state portal is one endpoint for the whole installation. Ten schools in
     Telangana do not each have their own Child Info.

     The credential is the vendor's arrangement with the state, not the
     school's. That is why this is not a row in `integrations`, which would
     otherwise be the right home: integrations.institution_id is NOT NULL and
     its tenant policy lets an institution admin select their own row, and with
     it the credentials column. Encrypted at rest is not the same as not handed
     out.

     So the tables carry no institution_id and their RLS policy has no tenant
     limb at all. Every read goes through AsPlatform, every route is gated on
     platform.tenants.write, and every handler additionally checks PlatformAdmin
     — the permission says what a caller may do, PlatformAdmin says how far they
     can see, and a cross-tenant screen needs both. */

type childInfoConnectorRow struct {
	ID          string  `json:"id"`
	StateCode   string  `json:"state_code"`
	Name        string  `json:"name"`
	Provider    string  `json:"provider"`
	EndpointURL *string `json:"endpoint_url,omitempty"`
	Username    *string `json:"username,omitempty"`
	// HasSecret, never the secret. A screen that can read back what it stored
	// is a screen that leaks the portal password to anybody who can open it.
	HasSecret  bool    `json:"has_secret"`
	Schedule   *string `json:"schedule,omitempty"`
	IsEnabled  bool    `json:"is_enabled"`
	LastSyncAt *string `json:"last_sync_at,omitempty"`
	LastStatus *string `json:"last_status,omitempty"`
	LastError  *string `json:"last_error,omitempty"`
	Runs       int     `json:"run_count"`
	// Ready says whether this connector could actually do anything today, and
	// Blocker says why not. The honest answer is usually "no live portal API",
	// and a screen that showed a green light instead would be a lie with a
	// statutory deadline behind it.
	Ready     bool   `json:"ready"`
	Blocker   string `json:"blocker,omitempty"`
	UpdatedAt string `json:"updated_at"`
}

// childInfoProvider is the connector contract. One implementation today.
//
// Kept as an interface rather than inlined because the shape of the second
// implementation is knowable — an API connector needs exactly these three
// answers — and because writing the file exchange as "the way it works" would
// bury the assumption that it is a choice.
type childInfoProvider interface {
	// Kind is the stored provider value.
	Kind() string
	// Ready reports whether this provider can run, and why not when it cannot.
	Ready(c childInfoConnectorRow) (bool, string)
}

type childInfoFileExchange struct{}

func (childInfoFileExchange) Kind() string { return "file_exchange" }

func (childInfoFileExchange) Ready(c childInfoConnectorRow) (bool, string) {
	if !c.IsEnabled {
		return false, "the connector is switched off"
	}
	return true, ""
}

// childInfoAPIProvider is the placeholder. It is never ready, and says why.
type childInfoAPIProvider struct{}

func (childInfoAPIProvider) Kind() string { return "api" }

func (childInfoAPIProvider) Ready(c childInfoConnectorRow) (bool, string) {
	if !c.HasSecret {
		return false, "no portal credentials have been entered"
	}
	if c.EndpointURL == nil || strings.TrimSpace(*c.EndpointURL) == "" {
		return false, "no portal endpoint has been recorded"
	}
	// Even fully configured, this cannot run: there is no published API for a
	// state Child Info portal that this installation can reach, and the honest
	// position is to say so rather than to fail at 3 a.m. inside a worker.
	return false, "live portal sync needs state portal API credentials and an " +
		"endpoint the state publishes; neither exists for this installation today. " +
		"Use the file exchange: export the roster, upload it on the portal, and " +
		"import the portal's extract into Child Info Reconciliation."
}

func childInfoProviderFor(kind string) childInfoProvider {
	if kind == "api" {
		return childInfoAPIProvider{}
	}
	return childInfoFileExchange{}
}

func (s *Server) listChildInfoConnectors(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	out := []childInfoConnectorRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT c.id::text, c.state_code, c.name, c.provider, c.endpoint_url,
			       c.username, (c.credentials IS NOT NULL AND length(c.credentials) > 0),
			       c.schedule, c.is_enabled,
			       to_char(c.last_sync_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       c.last_status, c.last_error,
			       (SELECT count(*) FROM child_info_sync_runs g
			         WHERE g.connector_id = c.id)::int,
			       to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM child_info_portal_connectors c
			 ORDER BY c.state_code, c.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v childInfoConnectorRow
			if err := rows.Scan(&v.ID, &v.StateCode, &v.Name, &v.Provider, &v.EndpointURL,
				&v.Username, &v.HasSecret, &v.Schedule, &v.IsEnabled, &v.LastSyncAt,
				&v.LastStatus, &v.LastError, &v.Runs, &v.UpdatedAt); err != nil {
				return err
			}
			v.Ready, v.Blocker = childInfoProviderFor(v.Provider).Ready(v)
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type childInfoConnectorRequest struct {
	ID          string `json:"id"`
	StateCode   string `json:"state_code"`
	Name        string `json:"name"`
	Provider    string `json:"provider"`
	EndpointURL string `json:"endpoint_url"`
	Username    string `json:"username"`
	// Secret is the portal password or API key. Absent means "leave what is
	// stored alone"; an explicit empty string clears it. Copied from the
	// messaging provider form, which had to answer the same question.
	Secret    *string `json:"secret,omitempty"`
	Schedule  string  `json:"schedule"`
	IsEnabled bool    `json:"is_enabled"`
}

func (s *Server) saveChildInfoConnector(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req childInfoConnectorRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.StateCode = strings.TrimSpace(req.StateCode)
	req.Name = strings.TrimSpace(req.Name)
	req.Provider = strings.TrimSpace(req.Provider)
	if req.Provider == "" {
		req.Provider = "file_exchange"
	}
	if req.StateCode == "" || req.Name == "" {
		httpx.BadRequest(w, r, "state_code and name are required")
		return
	}
	if req.Provider != "file_exchange" && req.Provider != "api" {
		httpx.BadRequest(w, r, "provider must be file_exchange or api")
		return
	}

	var sealed []byte
	if req.Secret != nil && *req.Secret != "" {
		b, err := sealSecret(*req.Secret)
		if err != nil {
			// A refusal, not a 500: the operator can act on "the server has no
			// credential key", and storing a state portal password in clear
			// instead would be the worse of the two ways to fail.
			httpx.Denied(w, r, err.Error())
			return
		}
		sealed = b
	}

	var out string
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if v := strings.TrimSpace(req.ID); v != "" {
			connID, err := uuid.Parse(v)
			if err != nil {
				return errors.New("id must be a uuid")
			}
			// COALESCE on credentials is what makes an omitted secret mean
			// "keep the stored one" rather than "erase it".
			return tx.QueryRow(r.Context(), `
				UPDATE child_info_portal_connectors
				   SET state_code = $2, name = $3, provider = $4,
				       endpoint_url = NULLIF($5,''), username = NULLIF($6,''),
				       credentials = COALESCE($7, credentials),
				       schedule = NULLIF($8,''), is_enabled = $9,
				       updated_at = now(), updated_by = $10
				 WHERE id = $1
				 RETURNING id::text`,
				connID, req.StateCode, req.Name, req.Provider,
				strings.TrimSpace(req.EndpointURL), strings.TrimSpace(req.Username),
				sealed, strings.TrimSpace(req.Schedule), req.IsEnabled,
				nullUUIDArg(id.UserID)).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO child_info_portal_connectors
			    (state_code, name, provider, endpoint_url, username, credentials,
			     schedule, is_enabled, updated_by)
			VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,NULLIF($7,''),$8,$9)
			ON CONFLICT (lower(state_code), lower(name)) DO UPDATE
			   SET provider = EXCLUDED.provider,
			       endpoint_url = EXCLUDED.endpoint_url,
			       username = EXCLUDED.username,
			       credentials = COALESCE(EXCLUDED.credentials,
			                              child_info_portal_connectors.credentials),
			       schedule = EXCLUDED.schedule,
			       is_enabled = EXCLUDED.is_enabled,
			       updated_at = now(), updated_by = EXCLUDED.updated_by
			RETURNING id::text`,
			req.StateCode, req.Name, req.Provider, strings.TrimSpace(req.EndpointURL),
			strings.TrimSpace(req.Username), sealed, strings.TrimSpace(req.Schedule),
			req.IsEnabled, nullUUIDArg(id.UserID)).Scan(&out)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
	}
}

func (s *Server) deleteChildInfoConnector(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	connID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var n int64
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM child_info_portal_connectors WHERE id = $1`, connID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

type childInfoRunRow struct {
	ID          string  `json:"id"`
	ConnectorID string  `json:"connector_id"`
	Connector   string  `json:"connector_name"`
	StateCode   string  `json:"state_code"`
	Institution *string `json:"institution_name,omitempty"`
	Direction   string  `json:"direction"`
	Status      string  `json:"status"`
	StartedAt   string  `json:"started_at"`
	FinishedAt  *string `json:"finished_at,omitempty"`
	RowCount    int     `json:"row_count"`
	Message     *string `json:"message,omitempty"`
	StartedBy   *string `json:"started_by,omitempty"`
}

func (s *Server) listChildInfoRuns(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	var connArg any
	if v := strings.TrimSpace(r.URL.Query().Get("connector_id")); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "connector_id must be a uuid")
			return
		}
		connArg = parsed
	}
	out := []childInfoRunRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT g.id::text, g.connector_id::text, c.name, c.state_code,
			       COALESCE(g.institution_name, i.name), g.direction, g.status,
			       to_char(g.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(g.finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       g.row_count, g.message, u.full_name
			  FROM child_info_sync_runs g
			  JOIN child_info_portal_connectors c ON c.id = g.connector_id
			  LEFT JOIN institutions i ON i.id = g.institution_id
			  LEFT JOIN users u ON u.id = g.started_by
			 WHERE ($1::uuid IS NULL OR g.connector_id = $1)
			 ORDER BY g.started_at DESC
			 LIMIT 200`, connArg)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v childInfoRunRow
			if err := rows.Scan(&v.ID, &v.ConnectorID, &v.Connector, &v.StateCode,
				&v.Institution, &v.Direction, &v.Status, &v.StartedAt, &v.FinishedAt,
				&v.RowCount, &v.Message, &v.StartedBy); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type childInfoRunRequest struct {
	InstitutionID string `json:"institution_id"`
	Direction     string `json:"direction"`
	Status        string `json:"status"`
	RowCount      int    `json:"row_count"`
	Message       string `json:"message"`
}

/*
recordChildInfoRun writes what an operator actually did.

	This is the honest version of a sync history for a connector that has no live
	API. An operator exports the roster, uploads it on the portal, downloads the
	extract and imports it — and records here that they did, with the count and
	the date, so the next person can see when this school was last squared with
	the state. It is a logbook, not a scheduler, and it does not pretend a
	machine did the work.
*/
func (s *Server) recordChildInfoRun(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	connID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req childInfoRunRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Direction = strings.TrimSpace(req.Direction)
	req.Status = strings.TrimSpace(req.Status)
	if req.Direction != "export" && req.Direction != "import" {
		httpx.BadRequest(w, r, "direction must be export or import")
		return
	}
	if req.Status == "" {
		req.Status = "ok"
	}
	if req.Status != "ok" && req.Status != "failed" {
		httpx.BadRequest(w, r, "status must be ok or failed")
		return
	}
	var instArg any
	if v := strings.TrimSpace(req.InstitutionID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "institution_id must be a uuid")
			return
		}
		instArg = parsed
	}

	var out string
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		// institution_name is copied rather than joined, so the log still reads
		// after a tenant is removed. A record of what was filed for a school
		// must outlive the school's row.
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO child_info_sync_runs
			    (connector_id, institution_id, institution_name, direction, status,
			     finished_at, row_count, message, started_by)
			SELECT $1, $2, (SELECT name FROM institutions WHERE id = $2),
			       $3, $4, now(), $5, NULLIF($6,''), $7
			RETURNING id::text`,
			connID, instArg, req.Direction, req.Status, req.RowCount,
			truncate(req.Message, 500), nullUUIDArg(id.UserID)).Scan(&out); err != nil {
			return err
		}
		// The connector's own health, written back to the same row rather than
		// to a second table — the pattern the messaging providers established.
		_, err := tx.Exec(r.Context(), `
			UPDATE child_info_portal_connectors
			   SET last_sync_at = now(), last_status = $2,
			       last_error = CASE WHEN $2 = 'failed' THEN NULLIF($3,'') END,
			       updated_at = now()
			 WHERE id = $1`, connID, req.Status, truncate(req.Message, 500))
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
	}
}

/*
exportChildInfoRoster writes the file an operator uploads to the portal.

	The export half of the file exchange. Columns match what parseChildInfoCSV
	reads back, so a roster exported here and an extract downloaded from the
	portal reconcile against each other without a mapping step in between.

	Scoped to one named school. ?institution_id= is required rather than
	defaulted, because a platform operator with several tenants and no acting
	school selected would otherwise export whichever one sorted first.
*/
func (s *Server) exportChildInfoRoster(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	instID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("institution_id")))
	if err != nil {
		httpx.BadRequest(w, r, "institution_id is required and must be a uuid")
		return
	}

	var (
		schoolName string
		rows       [][]string
	)
	err = s.DB.InTenant(r.Context(),
		database.Scope{InstitutionID: instID, PlatformAdmin: true}, func(tx pgx.Tx) error {
			if err := tx.QueryRow(r.Context(),
				`SELECT name FROM institutions WHERE id = $1`, instID).Scan(&schoolName); err != nil {
				return err
			}
			yearID, _, _, _, err := resolveAcademicYear(r, tx, r.URL.Query().Get("academic_year_id"))
			if err != nil {
				return err
			}
			students, err := loadChildInfoStudents(r, tx, yearID)
			if err != nil {
				return err
			}
			for _, st := range students {
				rows = append(rows, []string{
					deref(st.ChildInfoID), st.AdmissionNo, st.Name,
					deref(st.Father), deref(st.Mother), deref(st.DOB),
					deref(st.Gender), deref(st.Aadhaar), deref(st.APAAR),
					deref(st.Class),
				})
			}
			return nil
		})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	writeCSV(w, "child-info-roster.csv", []string{
		"Child Info ID", "Admission No", "Student Name", "Father Name", "Mother Name",
		"Date of Birth", "Gender", "Aadhaar Last4", "APAAR ID", "Class",
	}, rows)
}
