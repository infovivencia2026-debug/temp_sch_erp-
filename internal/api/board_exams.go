package api

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The board examination: entering candidates, and reading back what the board
   decided about them.

   The module could already run the school's own exams — papers, marks, report
   cards, halls, tickets. It could not do the thing a Class 10 year is actually
   organised around: putting the children's names on the state board's roll,
   and reconciling the result file when it comes back.

   Three ideas carry this file.

   A nominal roll is a statutory submission, not a record the school keeps for
   itself. It is checked, it goes once, and after that a correction is an
   amendment with a before and an after — so the particulars are snapshotted
   onto the registration at draft time, submission stamps who sent it and when,
   and an edit after submission is refused in favour of raising an amendment
   that the board has to accept before the school's own copy moves.

   A result import reconciles, it does not overwrite. The board's file will
   carry candidates the school does not have — a private candidate sitting at
   this centre, a name typed differently — and will omit ones it does. Both
   sets are reported, every line of the file is kept whether it matched or not,
   and the import will not publish while either set is outstanding unless
   somebody says in writing that they have seen it. An import that quietly
   discards four children is the worst thing this feature could do, and it is
   the failure the whole reconciliation path exists to prevent.

   Nothing here stores a percentage. Pass rates, averages and growth are all
   computed on read, because a stored percentage is wrong the moment a mark is
   amended and nobody recomputes it.

   Permissions are the ones that already exist; this adds none. The group this
   mounts into requires academics.exams.read, which every subject teacher
   holds, so each endpoint below names a second permission a subject teacher
   does not have: students.read.all for a roll that names every child in the
   year with their statutory identifiers, academics.exams.write to change or
   send it, and reports.read for whole-school analysis. */

// mountBoardExams hangs the board screens off the existing /exams group.
// Paths are relative: the caller owns the prefix and the exams.read middleware
// already on the group.
func (s *Server) mountBoardExams(r chi.Router) {
	// A nominal roll is every child in the year with their date of birth,
	// parents' names and APAAR id on one page. That is not a subject
	// teacher's document, whatever their timetable says.
	allStudents := httpx.RequirePermission(rbac.StudentsReadAll)
	// Entering, correcting or sending a candidate to the board. Deliberately
	// not marks.write, which every teacher holds so they can enter their own
	// paper — the roll is the examination controller's signature.
	exams := httpx.RequirePermission(rbac.ExamsWrite)
	// Looking at the whole school rather than one's own classes.
	reports := httpx.RequirePermission(rbac.ReportsRead)

	// --- the nominal roll ---------------------------------------------------
	r.With(allStudents).Get("/board/registrations", s.listBoardRegistrations)
	r.With(allStudents).Get("/board/eligible", s.listBoardEligible)
	r.With(exams).Post("/board/registrations", s.addBoardCandidates)
	r.With(exams).Put("/board/registrations/{id}", s.editBoardRegistration)
	r.With(exams).Post("/board/registrations/{id}/verify", s.verifyBoardRegistration)
	r.With(exams).Post("/board/submit", s.submitBoardRoll)
	r.With(exams).Post("/board/registrations/{id}/board-response", s.recordBoardResponse)

	// --- corrections after submission ---------------------------------------
	r.With(allStudents).Get("/board/amendments", s.listBoardAmendments)
	r.With(exams).Post("/board/registrations/{id}/amendments", s.raiseBoardAmendment)
	r.With(exams).Post("/board/amendments/{id}/decide", s.decideBoardAmendment)

	// --- the result file ------------------------------------------------------
	r.With(allStudents).Get("/board/results/imports", s.listBoardResultImports)
	r.With(allStudents).Get("/board/results/reconciliation", s.getBoardReconciliation)
	r.With(exams).Post("/board/results/import", s.importBoardResults)
	r.With(exams).Post("/board/results/rows/{id}/match", s.matchBoardResultRow)
	r.With(exams).Post("/board/results/imports/{id}/publish", s.publishBoardResults)

	// --- analysis --------------------------------------------------------------
	r.With(reports).Get("/board/analysis/baseline", s.getBaselineAnalysis)
	r.With(reports).Get("/board/performance", s.getBoardPerformance)
}

// boardStages are the examinations this file knows how to keep a roll for. The
// SSC is one sitting at the end of Class 10; the Telangana Intermediate is two
// a year apart, which the board treats as separate examinations with separate
// fees, so they are separate stages rather than one "intermediate".
var boardStages = map[string]int{
	"ssc":               10,
	"inter_first_year":  11,
	"inter_second_year": 12,
}

// --- the nominal roll ----------------------------------------------------------

type boardCandidate struct {
	ID             string          `json:"id"`
	StudentID      string          `json:"student_id"`
	AdmissionNo    string          `json:"admission_no"`
	CandidateName  string          `json:"candidate_name"`
	SchoolName     string          `json:"school_record_name"`
	ClassName      string          `json:"class_name"`
	Board          string          `json:"board"`
	ExamName       string          `json:"exam_name"`
	Stage          string          `json:"stage"`
	CandidateType  string          `json:"candidate_type"`
	GroupCode      *string         `json:"group_code,omitempty"`
	Medium         *string         `json:"medium,omitempty"`
	SecondLanguage *string         `json:"second_language,omitempty"`
	FatherName     *string         `json:"father_name,omitempty"`
	MotherName     *string         `json:"mother_name,omitempty"`
	DateOfBirth    *string         `json:"date_of_birth,omitempty"`
	ApaarID        *string         `json:"apaar_id,omitempty"`
	RegistrationNo *string         `json:"registration_no,omitempty"`
	HallTicketNo   *string         `json:"hall_ticket_no,omitempty"`
	Subjects       json.RawMessage `json:"subjects"`
	FeePaidPaise   int64           `json:"fee_paid_paise"`
	Status         string          `json:"status"`
	Verified       bool            `json:"verified"`
	SubmittedOn    *string         `json:"submitted_on,omitempty"`
	BoardAckNo     *string         `json:"board_ack_no,omitempty"`
	Remarks        *string         `json:"remarks,omitempty"`
	OpenAmendments int             `json:"open_amendments"`
	// Problems is what stops this row being sent. Computed on read so the
	// office sees it while there is still time to fix it, rather than being
	// told at submission that forty rows are wrong.
	Problems []string `json:"problems"`
	// Locked says the row can no longer be edited in place. The screen uses it
	// to swap the edit control for "raise an amendment".
	Locked bool `json:"locked"`
}

func (s *Server) listBoardRegistrations(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT br.id::text, br.student_id::text, st.admission_no,
		       COALESCE(br.candidate_name, concat_ws(' ', st.first_name, st.middle_name, st.last_name)),
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       COALESCE(c.name,''), br.board, br.exam_name, COALESCE(br.stage,''),
		       br.candidate_type, br.group_code, br.medium, br.second_language,
		       br.father_name, br.mother_name, to_char(br.date_of_birth,'YYYY-MM-DD'),
		       br.apaar_id, br.registration_no, br.hall_ticket_no, br.subjects,
		       br.fee_paid_paise, br.status, br.verified_at IS NOT NULL,
		       to_char(br.submitted_on,'YYYY-MM-DD'), br.board_ack_no, br.remarks,
		       (SELECT count(*) FROM board_registration_amendments a
		         WHERE a.registration_id = br.id AND a.status IN ('requested','sent'))::int
		  FROM board_registrations br
		  JOIN students st ON st.id = br.student_id
		  LEFT JOIN classes c ON c.id = br.class_id
		 WHERE ($1::text IS NULL OR br.stage = $1::text)
		   AND ($2::uuid IS NULL OR br.academic_year_id = $2::uuid)
		   AND ($3::text IS NULL OR br.status = $3::text)
		   AND ($4::uuid IS NULL OR br.class_id = $4::uuid)
		 ORDER BY COALESCE(c.name,''), lower(COALESCE(br.candidate_name, st.first_name))`,
		[]any{nullString(q.Get("stage")), nullString(q.Get("academic_year_id")),
			nullString(q.Get("status")), nullString(q.Get("class_id"))},
		func(rows pgx.Rows) (boardCandidate, error) {
			var v boardCandidate
			err := rows.Scan(&v.ID, &v.StudentID, &v.AdmissionNo, &v.CandidateName,
				&v.SchoolName, &v.ClassName, &v.Board, &v.ExamName, &v.Stage,
				&v.CandidateType, &v.GroupCode, &v.Medium, &v.SecondLanguage,
				&v.FatherName, &v.MotherName, &v.DateOfBirth, &v.ApaarID,
				&v.RegistrationNo, &v.HallTicketNo, &v.Subjects, &v.FeePaidPaise,
				&v.Status, &v.Verified, &v.SubmittedOn, &v.BoardAckNo, &v.Remarks,
				&v.OpenAmendments)
			v.Problems = candidateProblems(v)
			v.Locked = boardRollLocked(v.Status)
			return v, err
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	summary := map[string]int{
		"candidates": len(items), "draft": 0, "verified": 0, "submitted": 0,
		"rejected": 0, "incomplete": 0, "open_amendments": 0,
	}
	for _, it := range items {
		switch it.Status {
		case "draft":
			summary["draft"]++
		case "verified":
			summary["verified"]++
		case "rejected":
			summary["rejected"]++
		default:
			// accepted and hall_ticket_issued are past submission, and the
			// office counts them as sent rather than as three more states.
			summary["submitted"]++
		}
		if len(it.Problems) > 0 {
			summary["incomplete"]++
		}
		summary["open_amendments"] += it.OpenAmendments
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "summary": summary})
}

// boardRollLocked reports whether the row has left the school. Everything from
// submission onwards is the board's copy too, and changing it here would leave
// the two disagreeing with nothing to say why.
func boardRollLocked(status string) bool {
	return status != "draft" && status != "verified"
}

// candidateProblems lists what the board would reject the row for.
//
// Checked here rather than as a database constraint because a draft is
// deliberately allowed to be incomplete: the office enters forty children from
// the register on Monday and chases the missing dates of birth all week.
func candidateProblems(v boardCandidate) []string {
	var out []string
	if strings.TrimSpace(v.CandidateName) == "" {
		out = append(out, "no candidate name")
	}
	if v.FatherName == nil || strings.TrimSpace(*v.FatherName) == "" {
		out = append(out, "no father's name")
	}
	if v.DateOfBirth == nil || *v.DateOfBirth == "" {
		out = append(out, "no date of birth")
	}
	if v.Medium == nil || strings.TrimSpace(*v.Medium) == "" {
		out = append(out, "no medium of instruction")
	}
	if len(v.Subjects) == 0 || string(v.Subjects) == "[]" || string(v.Subjects) == "null" {
		out = append(out, "no subjects chosen")
	}
	// The Intermediate roll is priced and timetabled by group. An SSC
	// candidate has none, so this is asked of the two Intermediate stages only.
	if strings.HasPrefix(v.Stage, "inter") &&
		(v.GroupCode == nil || strings.TrimSpace(*v.GroupCode) == "") {
		out = append(out, "no group (MPC, BiPC, CEC, MEC or HEC)")
	}
	if out == nil {
		return []string{}
	}
	return out
}

type eligibleStudent struct {
	StudentID      string  `json:"student_id"`
	AdmissionNo    string  `json:"admission_no"`
	Name           string  `json:"name"`
	ClassID        string  `json:"class_id"`
	ClassName      string  `json:"class_name"`
	Level          int     `json:"level"`
	DateOfBirth    *string `json:"date_of_birth,omitempty"`
	Medium         *string `json:"medium,omitempty"`
	SecondLanguage *string `json:"second_language,omitempty"`
	ApaarID        *string `json:"apaar_id,omitempty"`
	FatherName     *string `json:"father_name,omitempty"`
	MotherName     *string `json:"mother_name,omitempty"`
}

/*
listBoardEligible is who could still be added to the roll.

	Class level rather than class name decides who sits which examination: a
	school calls Class 10 "Grade 10", "X" or "SSC" as it pleases, and the
	roll cannot depend on which. A named class_id overrides it for the school
	whose levels do not line up.
*/
func (s *Server) listBoardEligible(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	stage := strings.TrimSpace(q.Get("stage"))
	var levels []int
	if lvl, ok := boardStages[stage]; ok {
		levels = []int{lvl}
	}

	items, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       c.id::text, c.name, c.level,
		       to_char(st.date_of_birth,'YYYY-MM-DD'), st.medium, st.second_language,
		       st.apaar_id,
		       (SELECT g.full_name FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1),
		       (SELECT g.full_name FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1)
		  FROM enrollments e
		  JOIN students st ON st.id = e.student_id AND st.status = 'active'
		  JOIN classes  c  ON c.id = e.class_id
		 WHERE e.status = 'active'
		   AND ($1::uuid IS NULL OR e.academic_year_id = $1::uuid)
		   AND ($2::uuid IS NULL OR c.id = $2::uuid)
		   AND ($3::int[] IS NULL OR c.level = ANY($3::int[]))
		   AND NOT EXISTS (
		       SELECT 1 FROM board_registrations br
		        WHERE br.student_id = st.id
		          AND br.academic_year_id = e.academic_year_id
		          AND ($4::text IS NULL OR br.stage = $4::text))
		 ORDER BY c.level, c.name, st.admission_no`,
		[]any{nullString(q.Get("academic_year_id")), nullString(q.Get("class_id")),
			nullIntSlice(levels), nullString(stage)},
		func(rows pgx.Rows) (eligibleStudent, error) {
			var v eligibleStudent
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.Name, &v.ClassID,
				&v.ClassName, &v.Level, &v.DateOfBirth, &v.Medium, &v.SecondLanguage,
				&v.ApaarID, &v.FatherName, &v.MotherName)
		})
	respond(w, r, items, err)
}

func nullIntSlice(v []int) any {
	if len(v) == 0 {
		return nil
	}
	return v
}

type boardCandidateRequest struct {
	// One student or many. The office adds a whole class at a time and then
	// corrects the handful that differ, which is why the bulk form is the
	// primary one.
	StudentID      string   `json:"student_id"`
	StudentIDs     []string `json:"student_ids"`
	AcademicYearID string   `json:"academic_year_id"`
	Board          string   `json:"board"`
	ExamName       string   `json:"exam_name"`
	Stage          string   `json:"stage"`
	CandidateType  string   `json:"candidate_type"`
	GroupCode      string   `json:"group_code"`
	Medium         string   `json:"medium"`
	SecondLanguage string   `json:"second_language"`
	Subjects       []string `json:"subjects"`
}

/*
addBoardCandidates drafts a registration for each named student.

	The particulars are copied from the school's own record here, at draft
	time, rather than read through to students on every request. The roll is a
	statement of fact as at the date it is sent: when the office later corrects
	a spelling in the child's record — which is exactly what the board's
	correction window is for — the submitted roll must still show what was
	sent, or an amendment has no "before" to quote.

	A student who is already on this roll is left exactly as they are. The
	obvious alternative, upsert, would wipe a row somebody had spent an
	afternoon checking the moment a colleague pressed "add the whole class"
	again.
*/
func (s *Server) addBoardCandidates(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req boardCandidateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.StudentID != "" {
		req.StudentIDs = append(req.StudentIDs, req.StudentID)
	}
	if len(req.StudentIDs) == 0 {
		httpx.BadRequest(w, r, "name at least one student to add to the roll")
		return
	}
	req.Board = strings.TrimSpace(req.Board)
	req.ExamName = strings.TrimSpace(req.ExamName)
	req.Stage = strings.TrimSpace(req.Stage)
	if req.Board == "" || req.ExamName == "" {
		httpx.BadRequest(w, r, "the roll needs a board and an examination name")
		return
	}
	if _, ok := boardStages[req.Stage]; !ok {
		httpx.BadRequest(w, r,
			"stage must be ssc, inter_first_year or inter_second_year")
		return
	}
	if req.CandidateType == "" {
		req.CandidateType = "regular"
	}
	subjects, err := json.Marshal(req.Subjects)
	if err != nil {
		httpx.BadRequest(w, r, "subjects must be a list of subject names")
		return
	}

	var added, skipped int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		year, err := boardAcademicYear(r, tx, req.AcademicYearID)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(), `
			INSERT INTO board_registrations (
			    institution_id, student_id, academic_year_id, class_id, board, exam_name,
			    stage, candidate_type, group_code, medium, second_language, subjects,
			    candidate_name, father_name, mother_name, date_of_birth, apaar_id, status)
			SELECT $1, st.id, $2, en.class_id, $3, $4, $5, $6, NULLIF($7,''),
			       COALESCE(NULLIF($8,''), st.medium),
			       COALESCE(NULLIF($9,''), st.second_language),
			       $10::jsonb,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       (SELECT g.full_name FROM student_guardians sg
			          JOIN guardians g ON g.id = sg.guardian_id
			         WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1),
			       (SELECT g.full_name FROM student_guardians sg
			          JOIN guardians g ON g.id = sg.guardian_id
			         WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1),
			       st.date_of_birth, st.apaar_id, 'draft'
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT e.class_id FROM enrollments e
			       WHERE e.student_id = st.id AND e.academic_year_id = $2
			         AND e.status = 'active' LIMIT 1) en ON true
			 WHERE st.id = ANY($11::uuid[]) AND st.status = 'active'
			ON CONFLICT (institution_id, student_id, academic_year_id, exam_name)
			DO NOTHING`,
			id.InstitutionID, year, req.Board, req.ExamName, req.Stage,
			req.CandidateType, req.GroupCode, req.Medium, req.SecondLanguage,
			subjects, req.StudentIDs)
		if err != nil {
			return err
		}
		added = int(tag.RowsAffected())
		skipped = len(req.StudentIDs) - added
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"added": added, "already_on_roll": skipped,
	})
}

// boardAcademicYear resolves the year a roll belongs to, defaulting to the
// current one so the screens need not ask for something the school has already
// told the product once.
func boardAcademicYear(r *http.Request, tx pgx.Tx, given string) (uuid.UUID, error) {
	if given != "" {
		return uuid.Parse(given)
	}
	var year uuid.UUID
	err := tx.QueryRow(r.Context(),
		`SELECT id FROM academic_years WHERE is_current ORDER BY starts_on DESC LIMIT 1`).
		Scan(&year)
	if errors.Is(err, pgx.ErrNoRows) {
		return year, errors.New("no academic year is marked current; name one explicitly")
	}
	return year, err
}

type boardEditRequest struct {
	CandidateName  string   `json:"candidate_name"`
	FatherName     string   `json:"father_name"`
	MotherName     string   `json:"mother_name"`
	DateOfBirth    string   `json:"date_of_birth"`
	Medium         string   `json:"medium"`
	SecondLanguage string   `json:"second_language"`
	GroupCode      string   `json:"group_code"`
	CandidateType  string   `json:"candidate_type"`
	ApaarID        string   `json:"apaar_id"`
	RegistrationNo string   `json:"registration_no"`
	HallTicketNo   string   `json:"hall_ticket_no"`
	Subjects       []string `json:"subjects"`
	FeePaidPaise   int64    `json:"fee_paid_paise"`
	Remarks        string   `json:"remarks"`
}

var errBoardRollLocked = errors.New("this candidate has already been submitted")

/*
editBoardRegistration corrects a draft.

	It refuses once the roll has gone. That refusal is the feature: the board
	holds a copy of what was sent, and a silent rewrite here leaves the two
	documents disagreeing with nothing on either side to say what changed. The
	409 names the amendment path instead.

	A corrected row loses its verification. Somebody checked the old values
	against the child's certificate; that check says nothing about the new
	ones.
*/
func (s *Server) editBoardRegistration(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	regID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req boardEditRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var subjects any
	if req.Subjects != nil {
		b, err := json.Marshal(req.Subjects)
		if err != nil {
			httpx.BadRequest(w, r, "subjects must be a list of subject names")
			return
		}
		subjects = string(b)
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM board_registrations WHERE id = $1 FOR UPDATE`,
			regID).Scan(&status); err != nil {
			return err
		}
		if boardRollLocked(status) {
			return errBoardRollLocked
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE board_registrations SET
			    candidate_name  = COALESCE(NULLIF($2,''), candidate_name),
			    father_name     = COALESCE(NULLIF($3,''), father_name),
			    mother_name     = COALESCE(NULLIF($4,''), mother_name),
			    date_of_birth   = COALESCE(NULLIF($5,'')::date, date_of_birth),
			    medium          = COALESCE(NULLIF($6,''), medium),
			    second_language = COALESCE(NULLIF($7,''), second_language),
			    group_code      = COALESCE(NULLIF($8,''), group_code),
			    candidate_type  = COALESCE(NULLIF($9,''), candidate_type),
			    apaar_id        = COALESCE(NULLIF($10,''), apaar_id),
			    registration_no = COALESCE(NULLIF($11,''), registration_no),
			    hall_ticket_no  = COALESCE(NULLIF($12,''), hall_ticket_no),
			    subjects        = COALESCE($13::jsonb, subjects),
			    fee_paid_paise  = CASE WHEN $14::bigint > 0 THEN $14::bigint ELSE fee_paid_paise END,
			    remarks         = COALESCE(NULLIF($15,''), remarks),
			    status          = 'draft',
			    verified_at     = NULL,
			    verified_by     = NULL
			 WHERE id = $1`,
			regID, req.CandidateName, req.FatherName, req.MotherName, req.DateOfBirth,
			req.Medium, req.SecondLanguage, req.GroupCode, req.CandidateType,
			req.ApaarID, req.RegistrationNo, req.HallTicketNo, subjects,
			req.FeePaidPaise, req.Remarks)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errBoardRollLocked):
		httpx.Error(w, r, http.StatusConflict, "amendment_required",
			"this candidate has already been sent to the board. Corrections after "+
				"submission are amendments: raise one against this registration so "+
				"the change carries a before, an after and a reason.")
	case isUniqueViolation(err):
		httpx.BadRequest(w, r,
			"another candidate already holds that registration or hall ticket number")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": regID.String(), "status": "draft"})
	}
}

// verifyBoardRegistration is the checking pass: somebody has read this row
// against the child's own certificate. Refused while anything the board asks
// for is missing, because a roll of "verified" rows that will not load is
// worse than an obviously unfinished one.
func (s *Server) verifyBoardRegistration(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	regID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}

	var problems []string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var v boardCandidate
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(candidate_name,''), father_name, medium,
			       to_char(date_of_birth,'YYYY-MM-DD'), subjects, group_code,
			       COALESCE(stage,''), status
			  FROM board_registrations WHERE id = $1 FOR UPDATE`, regID).
			Scan(&v.CandidateName, &v.FatherName, &v.Medium, &v.DateOfBirth,
				&v.Subjects, &v.GroupCode, &v.Stage, &v.Status); err != nil {
			return err
		}
		if boardRollLocked(v.Status) {
			return errBoardRollLocked
		}
		if problems = candidateProblems(v); len(problems) > 0 {
			return nil
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE board_registrations
			   SET status = 'verified', verified_at = $2, verified_by = $3
			 WHERE id = $1`, regID, nowInIndia(), id.UserID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errBoardRollLocked):
		httpx.Error(w, r, http.StatusConflict, "already_submitted",
			"this candidate has already been sent to the board")
	case err != nil:
		httpx.Internal(w, r, err)
	case len(problems) > 0:
		httpx.Error(w, r, http.StatusBadRequest, "incomplete",
			"the board would reject this candidate: "+strings.Join(problems, "; "))
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": regID.String(), "status": "verified"})
	}
}

type boardSubmitRequest struct {
	Stage          string `json:"stage"`
	ExamName       string `json:"exam_name"`
	AcademicYearID string `json:"academic_year_id"`
	// What the board gave back when it took the file. Recorded against every
	// row so a candidate can be traced to the submission that carried them.
	AckNo string `json:"board_ack_no"`
}

type rejectedCandidate struct {
	RegistrationID string   `json:"registration_id"`
	Candidate      string   `json:"candidate_name"`
	AdmissionNo    string   `json:"admission_no"`
	Problems       []string `json:"problems"`
}

/*
submitBoardRoll sends a roll, once.

	Rows that would be rejected are left behind rather than blocking the
	others: a school with two missing dates of birth still has to file the
	other 118 candidates before the window shuts, and the two are named so
	somebody can chase them.

	Rows already submitted are counted and skipped. Pressing submit twice is
	not an error — it is what happens when a page is refreshed — but it must
	not restamp a submission with today's date, because that date is what the
	school will quote back to the board.
*/
func (s *Server) submitBoardRoll(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req boardSubmitRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var submitted, alreadySent int
	rejected := []rejectedCandidate{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		year, err := boardAcademicYear(r, tx, req.AcademicYearID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT br.id::text, st.admission_no, COALESCE(br.candidate_name,''),
			       br.father_name, br.medium, to_char(br.date_of_birth,'YYYY-MM-DD'),
			       br.subjects, br.group_code, COALESCE(br.stage,''), br.status
			  FROM board_registrations br
			  JOIN students st ON st.id = br.student_id
			 WHERE br.academic_year_id = $1
			   AND ($2::text IS NULL OR br.stage = $2::text)
			   AND ($3::text IS NULL OR br.exam_name = $3::text)
			 FOR UPDATE OF br`,
			year, nullString(req.Stage), nullString(req.ExamName))
		if err != nil {
			return err
		}
		type ready struct{ id string }
		var send []ready
		for rows.Next() {
			var v boardCandidate
			var admission string
			if err := rows.Scan(&v.ID, &admission, &v.CandidateName, &v.FatherName,
				&v.Medium, &v.DateOfBirth, &v.Subjects, &v.GroupCode, &v.Stage,
				&v.Status); err != nil {
				rows.Close()
				return err
			}
			if boardRollLocked(v.Status) {
				alreadySent++
				continue
			}
			if p := candidateProblems(v); len(p) > 0 {
				rejected = append(rejected, rejectedCandidate{
					RegistrationID: v.ID, Candidate: v.CandidateName,
					AdmissionNo: admission, Problems: p})
				continue
			}
			send = append(send, ready{v.ID})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(send) == 0 && alreadySent == 0 && len(rejected) == 0 {
			return errors.New("this roll has no candidates yet")
		}

		ids := make([]string, 0, len(send))
		for _, v := range send {
			ids = append(ids, v.id)
		}
		if len(ids) > 0 {
			now := nowInIndia()
			tag, err := tx.Exec(r.Context(), `
				UPDATE board_registrations
				   SET status = 'submitted', submitted_on = $2::date, submitted_at = $2,
				       submitted_by = $3, board_ack_no = COALESCE(NULLIF($4,''), board_ack_no)
				 WHERE id = ANY($1::uuid[])`, ids, now, id.UserID, req.AckNo)
			if err != nil {
				return err
			}
			submitted = int(tag.RowsAffected())
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"submitted": submitted, "already_submitted": alreadySent,
		"held_back": len(rejected), "rejected": rejected,
		"submitted_on": nowInIndia().Format("2006-01-02"),
	})
}

type boardResponseRequest struct {
	// What the board issued. Blank leaves whatever is there.
	RegistrationNo string `json:"registration_no"`
	HallTicketNo   string `json:"hall_ticket_no"`
	// accepted, hall_ticket_issued or rejected.
	Status  string `json:"status"`
	Remarks string `json:"remarks"`
}

/*
recordBoardResponse writes down what the board sent back.

	Deliberately not an amendment. An amendment is the school correcting
	something it asserted; a registration number is a fact only the board has,
	which the school never claimed and cannot be wrong about. Routing it
	through the correction window would fill that window with a hundred rows
	nobody needs to decide, and bury the four that matter.

	It is still refused before submission: a registration number that arrives
	before the roll was sent came from somewhere the school cannot account for.
*/
func (s *Server) recordBoardResponse(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	regID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req boardResponseRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	status := strings.TrimSpace(req.Status)
	switch status {
	case "", "accepted", "hall_ticket_issued", "rejected":
	default:
		httpx.BadRequest(w, r, "status must be accepted, hall_ticket_issued or rejected")
		return
	}

	var draft bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var current string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM board_registrations WHERE id = $1 FOR UPDATE`,
			regID).Scan(&current); err != nil {
			return err
		}
		if !boardRollLocked(current) {
			draft = true
			return nil
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE board_registrations
			   SET registration_no = COALESCE(NULLIF($2,''), registration_no),
			       hall_ticket_no  = COALESCE(NULLIF($3,''), hall_ticket_no),
			       status          = COALESCE(NULLIF($4,''), status),
			       remarks         = COALESCE(NULLIF($5,''), remarks)
			 WHERE id = $1`, regID, req.RegistrationNo, req.HallTicketNo, status, req.Remarks)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.BadRequest(w, r,
			"another candidate already holds that registration or hall ticket number")
	case err != nil:
		httpx.Internal(w, r, err)
	case draft:
		httpx.Error(w, r, http.StatusConflict, "not_submitted",
			"this candidate has not been sent to the board yet, so the board cannot have "+
				"answered about them")
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": regID.String(), "status": status})
	}
}

// --- corrections after submission -----------------------------------------------

// amendableFields maps what the API calls a fact to the column that holds it,
// with the cast the column needs. An allow-list rather than a free column
// name: an amendment names its field in a request body, and a request body
// must never be able to name a column.
var amendableFields = map[string]struct{ column, cast string }{
	"candidate_name":  {"candidate_name", "text"},
	"father_name":     {"father_name", "text"},
	"mother_name":     {"mother_name", "text"},
	"date_of_birth":   {"date_of_birth", "date"},
	"medium":          {"medium", "text"},
	"second_language": {"second_language", "text"},
	"group_code":      {"group_code", "text"},
	"candidate_type":  {"candidate_type", "text"},
	"apaar_id":        {"apaar_id", "text"},
	"registration_no": {"registration_no", "text"},
	"hall_ticket_no":  {"hall_ticket_no", "text"},
	"subjects":        {"subjects", "jsonb"},
}

type amendmentRow struct {
	ID             string  `json:"id"`
	RegistrationID string  `json:"registration_id"`
	Candidate      string  `json:"candidate_name"`
	AdmissionNo    string  `json:"admission_no"`
	Field          string  `json:"field"`
	OldValue       *string `json:"old_value,omitempty"`
	NewValue       *string `json:"new_value,omitempty"`
	Reason         string  `json:"reason"`
	Status         string  `json:"status"`
	BoardRef       *string `json:"board_ref,omitempty"`
	RequestedBy    *string `json:"requested_by,omitempty"`
	RequestedAt    string  `json:"requested_at"`
	DecidedAt      *string `json:"decided_at,omitempty"`
	AppliedAt      *string `json:"applied_at,omitempty"`
}

func (s *Server) listBoardAmendments(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT a.id::text, a.registration_id::text,
		       COALESCE(br.candidate_name, concat_ws(' ', st.first_name, st.last_name)),
		       st.admission_no, a.field, a.old_value, a.new_value, a.reason, a.status,
		       a.board_ref, u.full_name,
		       to_char(a.requested_at,'YYYY-MM-DD HH24:MI'),
		       to_char(a.decided_at,'YYYY-MM-DD HH24:MI'),
		       to_char(a.applied_at,'YYYY-MM-DD HH24:MI')
		  FROM board_registration_amendments a
		  JOIN board_registrations br ON br.id = a.registration_id
		  JOIN students st ON st.id = br.student_id
		  LEFT JOIN users u ON u.id = a.requested_by
		 WHERE ($1::uuid IS NULL OR a.registration_id = $1::uuid)
		   AND ($2::text IS NULL OR a.status = $2::text)
		   AND ($3::text IS NULL OR br.stage = $3::text)
		 ORDER BY a.requested_at DESC`,
		[]any{nullString(q.Get("registration_id")), nullString(q.Get("status")),
			nullString(q.Get("stage"))},
		func(rows pgx.Rows) (amendmentRow, error) {
			var v amendmentRow
			return v, rows.Scan(&v.ID, &v.RegistrationID, &v.Candidate, &v.AdmissionNo,
				&v.Field, &v.OldValue, &v.NewValue, &v.Reason, &v.Status, &v.BoardRef,
				&v.RequestedBy, &v.RequestedAt, &v.DecidedAt, &v.AppliedAt)
		})
	respond(w, r, items, err)
}

type amendmentRequest struct {
	Field    string `json:"field"`
	NewValue string `json:"new_value"`
	Reason   string `json:"reason"`
}

/*
raiseBoardAmendment records a correction to a submitted candidate.

	The old value is read from the row rather than taken from the request. A
	client that supplies both is a client that can be wrong about what was
	sent, and the whole value of an amendment is that its "before" is the
	school's own record of what the board received.
*/
func (s *Server) raiseBoardAmendment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	regID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req amendmentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	field, ok := amendableFields[strings.TrimSpace(req.Field)]
	if !ok {
		httpx.BadRequest(w, r, "that field cannot be amended: "+amendableFieldList())
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r,
			"the board asks why the correction is needed; a blank reason cannot be answered for later")
		return
	}

	var newID, old string
	var draft, duplicate bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var oldValue *string
		if err := tx.QueryRow(r.Context(),
			`SELECT status, `+field.column+`::text FROM board_registrations
			  WHERE id = $1 FOR UPDATE`, regID).Scan(&status, &oldValue); err != nil {
			return err
		}
		if !boardRollLocked(status) {
			draft = true
			return nil
		}
		if oldValue != nil {
			old = *oldValue
		}
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM board_registration_amendments
			                WHERE registration_id = $1 AND field = $2
			                  AND status IN ('requested','sent'))`,
			regID, req.Field).Scan(&duplicate); err != nil {
			return err
		}
		if duplicate {
			return nil
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO board_registration_amendments (
			    institution_id, registration_id, field, old_value, new_value, reason,
			    requested_by, requested_at)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8)
			RETURNING id::text`,
			id.InstitutionID, regID, req.Field, oldValue, req.NewValue,
			strings.TrimSpace(req.Reason), id.UserID, nowInIndia()).Scan(&newID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	case draft:
		httpx.Error(w, r, http.StatusConflict, "not_submitted",
			"this candidate has not been sent yet — correct the draft instead")
	case duplicate:
		httpx.Error(w, r, http.StatusConflict, "already_open",
			"a correction to that field is already with the board; settle it before raising another")
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{
			"id": newID, "field": req.Field, "old_value": old,
			"new_value": req.NewValue, "status": "requested",
		})
	}
}

func amendableFieldList() string {
	keys := make([]string, 0, len(amendableFields))
	for k := range amendableFields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

type amendmentDecision struct {
	// sent, accepted or rejected. "sent" records that the school forwarded the
	// correction and is waiting, which is where most of them sit for weeks.
	Decision string `json:"decision"`
	BoardRef string `json:"board_ref"`
}

/*
decideBoardAmendment settles a correction.

	The school's own copy moves only when the board accepts. Applying on
	request would put the two copies out of step for the whole of the waiting
	period, which is the interval during which somebody prints a hall ticket.
*/
func (s *Server) decideBoardAmendment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	amendID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req amendmentDecision
	if !httpx.Decode(w, r, &req) {
		return
	}
	decision := strings.ToLower(strings.TrimSpace(req.Decision))
	if decision != "sent" && decision != "accepted" && decision != "rejected" {
		httpx.BadRequest(w, r, "decision must be sent, accepted or rejected")
		return
	}

	var applied bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var regID uuid.UUID
		var fieldName, status string
		var newValue *string
		if err := tx.QueryRow(r.Context(), `
			SELECT registration_id, field, status, new_value
			  FROM board_registration_amendments WHERE id = $1 FOR UPDATE`, amendID).
			Scan(&regID, &fieldName, &status, &newValue); err != nil {
			return err
		}
		if status == "accepted" || status == "rejected" {
			return errors.New("this correction has already been settled")
		}
		now := nowInIndia()
		if decision == "sent" {
			_, err := tx.Exec(r.Context(), `
				UPDATE board_registration_amendments
				   SET status = 'sent', board_ref = COALESCE(NULLIF($2,''), board_ref)
				 WHERE id = $1`, amendID, req.BoardRef)
			return err
		}
		if decision == "accepted" {
			field, ok := amendableFields[fieldName]
			if !ok {
				return errors.New("this correction names a field that can no longer be amended")
			}
			// The column is looked up from the allow-list above, never taken
			// from the request; the value stays a bound parameter.
			if _, err := tx.Exec(r.Context(),
				`UPDATE board_registrations SET `+field.column+
					` = NULLIF($2,'')::`+field.cast+` WHERE id = $1`,
				regID, newValue); err != nil {
				return err
			}
			applied = true
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE board_registration_amendments
			   SET status = $2, decided_by = $3, decided_at = $4,
			       board_ref = COALESCE(NULLIF($5,''), board_ref),
			       applied_at = CASE WHEN $2 = 'accepted' THEN $4 ELSE applied_at END
			 WHERE id = $1`, amendID, decision, id.UserID, now, req.BoardRef)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.BadRequest(w, r,
			"another candidate already holds that registration or hall ticket number")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"id": amendID.String(), "status": decision, "applied": applied,
		})
	}
}

// --- the result file ---------------------------------------------------------------

type boardImportRequest struct {
	Board          string `json:"board"`
	ExamName       string `json:"exam_name"`
	Stage          string `json:"stage"`
	AcademicYearID string `json:"academic_year_id"`
	FileName       string `json:"file_name"`
	Note           string `json:"note"`
	// CSV as published. Parsed here rather than in the browser so that what
	// was reconciled is what arrived, and so a second client cannot invent its
	// own idea of which column is the hall ticket number.
	CSV string `json:"csv"`
	// DryRun reports what would happen and writes nothing. The default, so an
	// operator meets the two unreconciled lists before anything is stored.
	Commit bool `json:"commit"`
}

type boardResultLine struct {
	ID            string          `json:"id,omitempty"`
	LineNo        int             `json:"line_no"`
	HallTicketNo  string          `json:"hall_ticket_no"`
	RegistrationN string          `json:"registration_no"`
	CandidateName string          `json:"candidate_name"`
	StudentID     string          `json:"student_id,omitempty"`
	SchoolName    string          `json:"school_record_name,omitempty"`
	AdmissionNo   string          `json:"admission_no,omitempty"`
	MatchMethod   string          `json:"match_method"`
	Result        string          `json:"result"`
	Total         *float64        `json:"total_marks,omitempty"`
	Max           *float64        `json:"max_marks,omitempty"`
	Percent       *float64        `json:"percent,omitempty"`
	Subjects      json.RawMessage `json:"subjects,omitempty"`
	registration  *uuid.UUID
	raw           map[string]string
}

type missingCandidate struct {
	RegistrationID string  `json:"registration_id"`
	StudentID      string  `json:"student_id"`
	AdmissionNo    string  `json:"admission_no"`
	CandidateName  string  `json:"candidate_name"`
	ClassName      string  `json:"class_name"`
	HallTicketNo   *string `json:"hall_ticket_no,omitempty"`
	RegistrationNo *string `json:"registration_no,omitempty"`
	Status         string  `json:"status"`
}

type boardReconciliation struct {
	ImportID string `json:"import_id,omitempty"`
	DryRun   bool   `json:"dry_run"`
	Rows     int    `json:"rows"`
	Matched  int    `json:"matched"`
	// Basis states what "the school's candidates" means here, because a
	// reconciliation with an unstated denominator is a number nobody can act
	// on.
	Basis string `json:"basis"`
	// InFileNotInSchool are the board's lines this school cannot place.
	InFileNotInSchool []boardResultLine `json:"in_file_not_in_school"`
	// InSchoolNotInFile are the school's own candidates the file omits. This
	// is the set a family finds out about the hard way if it is dropped.
	InSchoolNotInFile []missingCandidate `json:"in_school_not_in_file"`
	Matches           []boardResultLine  `json:"matches"`
	Published         bool               `json:"published"`
	PublishedOn       *string            `json:"published_on,omitempty"`
}

/*
importBoardResults reads the board's published file and reconciles it.

	Matching is tried in descending order of how much the identifier is worth:
	the hall ticket number, which the board itself printed; then the
	registration number; then the candidate's name, and only where exactly one
	candidate answers to it. How each line matched is stored, because a name
	match is a guess and somebody has to be able to look at the guesses.

	Candidates are looked up by academic year and stage rather than by the
	board's name as typed. "BSE Telangana" in the roll and "BSETS" on the
	result file are the same board, and a reconciliation that reports 120
	missing children because of a spelling is a reconciliation nobody will
	read.

	Nothing is discarded. A line that matches nothing is stored with its
	original text intact and reported; so is every candidate of the school's
	that the file does not mention.
*/
func (s *Server) importBoardResults(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req boardImportRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.CSV) == "" {
		httpx.BadRequest(w, r, "paste or upload the board's result file")
		return
	}
	req.Board = strings.TrimSpace(req.Board)
	req.ExamName = strings.TrimSpace(req.ExamName)
	if req.Board == "" || req.ExamName == "" {
		httpx.BadRequest(w, r, "name the board and the examination this file is for")
		return
	}

	lines, err := parseBoardResultCSV(req.CSV)
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if len(lines) == 0 {
		httpx.BadRequest(w, r, "the file has a header but no candidates")
		return
	}

	out := boardReconciliation{
		DryRun: !req.Commit, Rows: len(lines),
		InFileNotInSchool: []boardResultLine{}, InSchoolNotInFile: []missingCandidate{},
		Matches: []boardResultLine{},
		Basis: "the school's candidates are the registrations for this year and stage " +
			"that have been submitted to the board",
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		year, err := boardAcademicYear(r, tx, req.AcademicYearID)
		if err != nil {
			return err
		}

		candidates, err := loadBoardCandidates(r, tx, year, req.Stage)
		if err != nil {
			return err
		}
		matchBoardLines(lines, candidates)

		for i := range lines {
			if lines[i].StudentID == "" {
				out.InFileNotInSchool = append(out.InFileNotInSchool, lines[i])
				continue
			}
			out.Matched++
			out.Matches = append(out.Matches, lines[i])
		}
		for _, c := range candidates {
			if !c.used {
				out.InSchoolNotInFile = append(out.InSchoolNotInFile, c.missing())
			}
		}
		if !req.Commit {
			return nil
		}

		var importID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO board_result_imports (
			    institution_id, academic_year_id, board, exam_name, stage, file_name,
			    note, row_count, matched_count, imported_by, imported_at)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),$8,$9,$10,$11)
			RETURNING id`,
			id.InstitutionID, year, req.Board, req.ExamName, req.Stage, req.FileName,
			req.Note, len(lines), out.Matched, id.UserID, nowInIndia()).Scan(&importID); err != nil {
			return err
		}
		out.ImportID = importID.String()

		for i := range lines {
			l := &lines[i]
			raw, err := json.Marshal(l.raw)
			if err != nil {
				return err
			}
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO board_result_rows (
				    institution_id, import_id, line_no, hall_ticket_no, registration_no,
				    candidate_name, student_id, registration_id, match_method, result,
				    total_marks, max_marks, subjects, raw, matched_at, matched_by)
				VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),
				        NULLIF($7,'')::uuid,$8,$9,NULLIF($10,''),$11,$12,$13::jsonb,$14::jsonb,
				        CASE WHEN $7 = '' THEN NULL ELSE $15::timestamptz END,
				        CASE WHEN $7 = '' THEN NULL ELSE $16::uuid END)
				RETURNING id::text`,
				id.InstitutionID, importID, l.LineNo, l.HallTicketNo, l.RegistrationN,
				l.CandidateName, l.StudentID, l.registration, l.MatchMethod, l.Result,
				l.Total, l.Max, l.Subjects, raw, nowInIndia(), id.UserID).Scan(&l.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	status := http.StatusOK
	if req.Commit {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, out)
}

// boardCandidateKey is one of the school's own candidates, held in memory for
// the length of an import so every line can be matched without a query each.
type boardCandidateKey struct {
	registrationID uuid.UUID
	studentID      string
	admissionNo    string
	name           string
	className      string
	hallTicket     *string
	registrationNo *string
	status         string
	used           bool
}

func (c boardCandidateKey) missing() missingCandidate {
	return missingCandidate{
		RegistrationID: c.registrationID.String(), StudentID: c.studentID,
		AdmissionNo: c.admissionNo, CandidateName: c.name, ClassName: c.className,
		HallTicketNo: c.hallTicket, RegistrationNo: c.registrationNo, Status: c.status,
	}
}

// loadBoardCandidates reads the candidates a result file should account for:
// the ones actually entered. A draft the school never sent is not missing from
// the board's file — it was never on the board's list — and reporting it as
// missing would bury the children who really are.
func loadBoardCandidates(r *http.Request, tx pgx.Tx, year uuid.UUID, stage string) ([]*boardCandidateKey, error) {
	rows, err := tx.Query(r.Context(), `
		SELECT br.id, br.student_id::text, st.admission_no,
		       COALESCE(br.candidate_name, concat_ws(' ', st.first_name, st.middle_name, st.last_name)),
		       COALESCE(c.name,''), br.hall_ticket_no, br.registration_no, br.status
		  FROM board_registrations br
		  JOIN students st ON st.id = br.student_id
		  LEFT JOIN classes c ON c.id = br.class_id
		 WHERE br.academic_year_id = $1
		   AND ($2::text IS NULL OR br.stage = $2::text)
		   AND br.status IN ('submitted','accepted','hall_ticket_issued')
		 ORDER BY st.admission_no`, year, nullString(stage))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*boardCandidateKey
	for rows.Next() {
		c := &boardCandidateKey{}
		if err := rows.Scan(&c.registrationID, &c.studentID, &c.admissionNo, &c.name,
			&c.className, &c.hallTicket, &c.registrationNo, &c.status); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// matchBoardLines attaches each line of the file to at most one candidate.
//
// A candidate already claimed by an earlier line is not reused: two lines
// pointing at one child means one child's result is somebody else's, and the
// second line is far better left unmatched and reported.
func matchBoardLines(lines []boardResultLine, candidates []*boardCandidateKey) {
	byTicket := map[string]*boardCandidateKey{}
	byReg := map[string]*boardCandidateKey{}
	byName := map[string][]*boardCandidateKey{}
	for _, c := range candidates {
		if c.hallTicket != nil {
			byTicket[boardKeyOf(*c.hallTicket)] = c
		}
		if c.registrationNo != nil {
			byReg[boardKeyOf(*c.registrationNo)] = c
		}
		n := boardNameKey(c.name)
		byName[n] = append(byName[n], c)
	}

	claim := func(c *boardCandidateKey, l *boardResultLine, how string) bool {
		if c == nil || c.used {
			return false
		}
		c.used = true
		l.StudentID = c.studentID
		l.SchoolName = c.name
		l.AdmissionNo = c.admissionNo
		l.MatchMethod = how
		reg := c.registrationID
		l.registration = &reg
		return true
	}

	for i := range lines {
		l := &lines[i]
		if l.HallTicketNo != "" && claim(byTicket[boardKeyOf(l.HallTicketNo)], l, "hall_ticket") {
			continue
		}
		if l.RegistrationN != "" && claim(byReg[boardKeyOf(l.RegistrationN)], l, "registration_no") {
			continue
		}
		// Only an unambiguous name. Two children called Sai Kumar in one class
		// is not unusual, and guessing between them puts one child's result on
		// the other's certificate.
		if hits := byName[boardNameKey(l.CandidateName)]; len(hits) == 1 {
			if claim(hits[0], l, "name") {
				continue
			}
		}
		l.MatchMethod = "unmatched"
	}
}

// boardKeyOf normalises an identifier for comparison. Boards print hall ticket
// numbers with spaces and in whichever case the operator's spreadsheet felt
// like.
func boardKeyOf(v string) string {
	return strings.ToUpper(strings.Join(strings.Fields(v), ""))
}

// boardNameKey normalises a candidate's name: case, punctuation and the
// initials a board file writes as "K. Sai" and a register as "K Sai".
func boardNameKey(v string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(v) {
		switch {
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune(' ')
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

/*
parseBoardResultCSV reads a board's file without insisting on its column names.

	No two boards publish the same header, and a school will not re-key 120
	rows to satisfy this product. Known aliases are folded to the fields the
	reconciliation needs; every other column is kept verbatim in raw and, when
	it holds a number, read as a subject mark — which is how the per-subject
	columns of an SSC memo arrive.
*/
func parseBoardResultCSV(text string) ([]boardResultLine, error) {
	reader := csv.NewReader(strings.NewReader(text))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1 // ragged rows are reported per line, not fatal

	header, err := reader.Read()
	if err != nil {
		return nil, errors.New("could not read the file's header row")
	}
	canon := make([]string, len(header))
	known := 0
	for i, h := range header {
		canon[i] = boardResultColumn(h)
		if canon[i] != "" {
			known++
		}
	}
	if known == 0 {
		return nil, errors.New(
			"none of the columns could be recognised — the file needs at least a hall " +
				"ticket number, a registration number or a candidate name")
	}

	var out []boardResultLine
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
		l := boardResultLine{LineNo: line, raw: map[string]string{}}
		var subjects []map[string]any
		for i, cell := range rec {
			if i >= len(header) {
				break
			}
			cell = strings.TrimSpace(cell)
			name := strings.TrimSpace(header[i])
			l.raw[name] = cell
			switch canon[i] {
			case "hall_ticket_no":
				l.HallTicketNo = cell
			case "registration_no":
				l.RegistrationN = cell
			case "candidate_name":
				l.CandidateName = cell
			case "result":
				l.Result = boardResultWord(cell)
			case "total_marks":
				l.Total = parseNumber(cell)
			case "max_marks":
				l.Max = parseNumber(cell)
			default:
				if n := parseNumber(cell); n != nil {
					subjects = append(subjects, map[string]any{"subject": name, "marks": *n})
				}
			}
		}
		if l.HallTicketNo == "" && l.RegistrationN == "" && l.CandidateName == "" {
			// A blank line at the end of a spreadsheet is not a candidate.
			continue
		}
		if l.Total != nil && l.Max != nil && *l.Max > 0 {
			p := round1(100 * *l.Total / *l.Max)
			l.Percent = &p
		}
		if subjects != nil {
			if b, err := json.Marshal(subjects); err == nil {
				l.Subjects = b
			}
		} else {
			l.Subjects = json.RawMessage("[]")
		}
		out = append(out, l)
	}
	return out, nil
}

func boardResultColumn(h string) string {
	k := strings.ToLower(strings.TrimSpace(h))
	k = strings.NewReplacer(" ", "_", ".", "", "-", "_", "/", "_").Replace(k)
	switch k {
	case "hall_ticket_no", "hall_ticket", "hallticket", "htno", "ht_no", "roll_no", "rollno":
		return "hall_ticket_no"
	case "registration_no", "regd_no", "reg_no", "regno", "registration":
		return "registration_no"
	case "candidate_name", "name", "student_name", "candidate":
		return "candidate_name"
	case "result", "result_status", "status", "division":
		return "result"
	case "total", "total_marks", "grand_total", "marks_secured", "secured":
		return "total_marks"
	case "max_marks", "maximum_marks", "out_of", "total_max":
		return "max_marks"
	}
	return ""
}

// boardResultWord folds the board's vocabulary into the five outcomes the
// summary counts. Anything unrecognised is kept as written rather than
// discarded — a school that sees "MALPRACTICE" in its own file is better
// served than one that sees a blank.
func boardResultWord(v string) string {
	s := strings.ToLower(strings.TrimSpace(v))
	switch {
	case s == "":
		return ""
	case strings.HasPrefix(s, "pass"), s == "p", strings.HasPrefix(s, "promot"):
		return "pass"
	case strings.HasPrefix(s, "fail"), s == "f":
		return "fail"
	case strings.HasPrefix(s, "comp"), s == "c":
		return "compartment"
	case strings.HasPrefix(s, "abs"), s == "a":
		return "absent"
	case strings.HasPrefix(s, "with"), s == "w":
		return "withheld"
	}
	return s
}

func parseNumber(v string) *float64 {
	v = strings.TrimSpace(strings.ReplaceAll(v, ",", ""))
	if v == "" {
		return nil
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return nil
	}
	return &f
}

// round1 keeps a computed figure to one decimal place. math.Round rather than
// truncation: adding a half and cutting rounds a fall of exactly seven points
// to 6.9, and a growth table where every decline is understated by a tenth is
// a table nobody can reconcile against the marks register.
func round1(v float64) float64 {
	return math.Round(v*10) / 10
}

type boardImportSummary struct {
	ID          string  `json:"id"`
	Board       string  `json:"board"`
	ExamName    string  `json:"exam_name"`
	Stage       *string `json:"stage,omitempty"`
	FileName    *string `json:"file_name,omitempty"`
	Rows        int     `json:"rows"`
	Matched     int     `json:"matched"`
	Unmatched   int     `json:"unmatched"`
	Missing     int     `json:"missing_from_file"`
	ImportedAt  string  `json:"imported_at"`
	ImportedBy  *string `json:"imported_by,omitempty"`
	PublishedOn *string `json:"published_on,omitempty"`
	Acked       bool    `json:"unmatched_acknowledged"`
}

func (s *Server) listBoardResultImports(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT i.id::text, i.board, i.exam_name, i.stage, i.file_name, i.row_count,
		       i.matched_count, i.row_count - i.matched_count,
		       (SELECT count(*) FROM board_registrations br
		         WHERE br.academic_year_id = i.academic_year_id
		           AND (i.stage IS NULL OR br.stage = i.stage)
		           AND br.status IN ('submitted','accepted','hall_ticket_issued')
		           AND NOT EXISTS (SELECT 1 FROM board_result_rows rr
		                            WHERE rr.import_id = i.id AND rr.student_id = br.student_id))::int,
		       to_char(i.imported_at,'YYYY-MM-DD HH24:MI'), u.full_name,
		       to_char(i.published_at,'YYYY-MM-DD HH24:MI'), i.unmatched_acknowledged
		  FROM board_result_imports i
		  LEFT JOIN users u ON u.id = i.imported_by
		 WHERE ($1::uuid IS NULL OR i.academic_year_id = $1::uuid)
		 ORDER BY i.imported_at DESC`,
		[]any{nullString(r.URL.Query().Get("academic_year_id"))},
		func(rows pgx.Rows) (boardImportSummary, error) {
			var v boardImportSummary
			return v, rows.Scan(&v.ID, &v.Board, &v.ExamName, &v.Stage, &v.FileName,
				&v.Rows, &v.Matched, &v.Unmatched, &v.Missing, &v.ImportedAt,
				&v.ImportedBy, &v.PublishedOn, &v.Acked)
		})
	respond(w, r, items, err)
}

/*
getBoardReconciliation is the two-way report for a stored import.

	Same shape as the report the import itself returns, so the screen renders
	one component whether it is looking at what would happen or at what did.
	Without an import_id it answers for the most recent one, because a bare GET
	that 400s is a screen that cannot open.
*/
func (s *Server) getBoardReconciliation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := boardReconciliation{
		InFileNotInSchool: []boardResultLine{}, InSchoolNotInFile: []missingCandidate{},
		Matches: []boardResultLine{},
		Basis: "the school's candidates are the registrations for this year and stage " +
			"that have been submitted to the board",
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var importID, year uuid.UUID
		var stage *string
		var publishedAt *string
		if err := tx.QueryRow(r.Context(), `
			SELECT i.id, i.academic_year_id, i.stage, i.row_count, i.matched_count,
			       to_char(i.published_at,'YYYY-MM-DD HH24:MI')
			  FROM board_result_imports i
			 WHERE ($1::uuid IS NULL OR i.id = $1::uuid)
			 ORDER BY i.imported_at DESC LIMIT 1`,
			nullString(r.URL.Query().Get("import_id"))).
			Scan(&importID, &year, &stage, &out.Rows, &out.Matched, &publishedAt); err != nil {
			return err
		}
		out.ImportID = importID.String()
		out.PublishedOn = publishedAt
		out.Published = publishedAt != nil

		rows, err := tx.Query(r.Context(), `
			SELECT rr.id::text, rr.line_no, COALESCE(rr.hall_ticket_no,''),
			       COALESCE(rr.registration_no,''), COALESCE(rr.candidate_name,''),
			       COALESCE(rr.student_id::text,''),
			       COALESCE(concat_ws(' ', st.first_name, st.middle_name, st.last_name),''),
			       COALESCE(st.admission_no,''), rr.match_method, COALESCE(rr.result,''),
			       rr.total_marks::float8, rr.max_marks::float8, rr.subjects
			  FROM board_result_rows rr
			  LEFT JOIN students st ON st.id = rr.student_id
			 WHERE rr.import_id = $1
			 ORDER BY rr.line_no`, importID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var l boardResultLine
			if err := rows.Scan(&l.ID, &l.LineNo, &l.HallTicketNo, &l.RegistrationN,
				&l.CandidateName, &l.StudentID, &l.SchoolName, &l.AdmissionNo,
				&l.MatchMethod, &l.Result, &l.Total, &l.Max, &l.Subjects); err != nil {
				rows.Close()
				return err
			}
			if l.Total != nil && l.Max != nil && *l.Max > 0 {
				p := round1(100 * *l.Total / *l.Max)
				l.Percent = &p
			}
			if l.StudentID == "" {
				out.InFileNotInSchool = append(out.InFileNotInSchool, l)
			} else {
				out.Matches = append(out.Matches, l)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		missing, err := tx.Query(r.Context(), `
			SELECT br.id::text, br.student_id::text, st.admission_no,
			       COALESCE(br.candidate_name, concat_ws(' ', st.first_name, st.last_name)),
			       COALESCE(c.name,''), br.hall_ticket_no, br.registration_no, br.status
			  FROM board_registrations br
			  JOIN students st ON st.id = br.student_id
			  LEFT JOIN classes c ON c.id = br.class_id
			 WHERE br.academic_year_id = $1
			   AND ($2::text IS NULL OR br.stage = $2::text)
			   AND br.status IN ('submitted','accepted','hall_ticket_issued')
			   AND NOT EXISTS (SELECT 1 FROM board_result_rows rr
			                    WHERE rr.import_id = $3 AND rr.student_id = br.student_id)
			 ORDER BY st.admission_no`, year, stage, importID)
		if err != nil {
			return err
		}
		defer missing.Close()
		for missing.Next() {
			var m missingCandidate
			if err := missing.Scan(&m.RegistrationID, &m.StudentID, &m.AdmissionNo,
				&m.CandidateName, &m.ClassName, &m.HallTicketNo, &m.RegistrationNo,
				&m.Status); err != nil {
				return err
			}
			out.InSchoolNotInFile = append(out.InSchoolNotInFile, m)
		}
		return missing.Err()
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// No file has been imported yet. An empty report is the truthful
		// answer and lets the screen render its upload panel.
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type matchRequest struct {
	StudentID string `json:"student_id"`
}

// matchBoardResultRow attaches a line the import could not place to a child,
// by hand. The method is recorded as manual so that a name the software would
// never have matched is visibly somebody's decision.
func (s *Server) matchBoardResultRow(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	rowID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req matchRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	studentID, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE board_result_rows rr
			   SET student_id = $2, match_method = 'manual', matched_at = $3,
			       matched_by = $4,
			       registration_id = (
			           SELECT br.id FROM board_registrations br
			             JOIN board_result_imports i ON i.id = rr.import_id
			            WHERE br.student_id = $2
			              AND br.academic_year_id = i.academic_year_id
			            ORDER BY br.created_at DESC LIMIT 1)
			 WHERE rr.id = $1`, rowID, studentID, nowInIndia(), id.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		// The counts on the header are what the list screen reads, so they are
		// recomputed here rather than left to drift.
		_, err = tx.Exec(r.Context(), `
			UPDATE board_result_imports i
			   SET matched_count = (SELECT count(*) FROM board_result_rows rr
			                         WHERE rr.import_id = i.id AND rr.student_id IS NOT NULL)
			 WHERE i.id = (SELECT import_id FROM board_result_rows WHERE id = $1)`, rowID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "already_matched",
			"another line of this file is already matched to that child")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": rowID.String(), "match_method": "manual"})
	}
}

type publishRequest struct {
	// AcknowledgeUnmatched is the operator saying, on the record, that they
	// have seen both unreconciled lists and are publishing anyway.
	AcknowledgeUnmatched bool `json:"acknowledge_unmatched"`
}

/*
publishBoardResults releases a result to families.

	It refuses while anything is unreconciled unless the caller acknowledges
	it. The failure this prevents is specific: a candidate the board's file
	omits hears nothing on the afternoon every classmate hears, and the school
	finds out when the parent telephones. Acknowledging is a deliberate act and
	is stored, so afterwards there is an answer to "did anyone know".
*/
func (s *Server) publishBoardResults(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	importID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req publishRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var unmatched, missing int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var year uuid.UUID
		var stage *string
		if err := tx.QueryRow(r.Context(),
			`SELECT academic_year_id, stage FROM board_result_imports WHERE id = $1 FOR UPDATE`,
			importID).Scan(&year, &stage); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*) FROM board_result_rows
			         WHERE import_id = $1 AND student_id IS NULL)::int,
			       (SELECT count(*) FROM board_registrations br
			         WHERE br.academic_year_id = $2
			           AND ($3::text IS NULL OR br.stage = $3::text)
			           AND br.status IN ('submitted','accepted','hall_ticket_issued')
			           AND NOT EXISTS (SELECT 1 FROM board_result_rows rr
			                            WHERE rr.import_id = $1 AND rr.student_id = br.student_id))::int`,
			importID, year, stage).Scan(&unmatched, &missing); err != nil {
			return err
		}
		if (unmatched > 0 || missing > 0) && !req.AcknowledgeUnmatched {
			return errBoardUnreconciled
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE board_result_imports
			   SET published_at = $2, published_by = $3, unmatched_acknowledged = $4
			 WHERE id = $1`, importID, nowInIndia(), id.UserID, req.AcknowledgeUnmatched)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errBoardUnreconciled):
		httpx.Error(w, r, http.StatusConflict, "unreconciled",
			"this file has "+itoa(unmatched)+" line(s) that match no candidate here and omits "+
				itoa(missing)+" candidate(s) the school entered. Match or explain each one, "+
				"or publish again acknowledging them — a child missing from the file hears "+
				"nothing on the day everybody else does.")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"id": importID.String(), "published_on": nowInIndia().Format("2006-01-02"),
			"unmatched": unmatched, "missing_from_file": missing,
			"acknowledged": req.AcknowledgeUnmatched,
		})
	}
}

var errBoardUnreconciled = errors.New("the file is not reconciled")

// --- analysis ------------------------------------------------------------------------

type cohortPoint struct {
	ExamID   string   `json:"exam_id"`
	ExamName string   `json:"exam_name"`
	On       *string  `json:"on,omitempty"`
	Students int      `json:"students"`
	Percent  *float64 `json:"average_percent,omitempty"`
}

type cohortGrowth struct {
	ClassID   string        `json:"class_id"`
	ClassName string        `json:"class_name"`
	Level     int           `json:"level"`
	Baseline  *cohortPoint  `json:"baseline,omitempty"`
	Latest    *cohortPoint  `json:"latest,omitempty"`
	Delta     *float64      `json:"delta_points,omitempty"`
	Trend     []cohortPoint `json:"trend"`
	Note      string        `json:"note,omitempty"`
}

type movement struct {
	Name     string   `json:"name"`
	Baseline *float64 `json:"baseline_percent,omitempty"`
	Latest   *float64 `json:"latest_percent,omitempty"`
	Delta    *float64 `json:"delta_points,omitempty"`
	// Extra identifies a student row; empty on a subject row.
	AdmissionNo string `json:"admission_no,omitempty"`
	StudentID   string `json:"student_id,omitempty"`
}

/*
getBaselineAnalysis compares a cohort against its own earlier performance.

	The baseline is the cohort's first sat assessment of the academic year —
	the earliest exam for which this class has marks — and the comparison point
	is its most recent. Both are stated in the response with their names and
	dates, because a percentage with no stated basis is a number nobody can
	defend to a trustee.

	Two other baselines were considered and rejected. Last year's result does
	not exist for the part of a Class 10 cohort that joined at the intake, and
	using it would compare a whole-cohort figure against a smaller,
	self-selected one. A dedicated entry test would be cleaner still, and
	almost no school in this market runs one, so the analysis would be empty
	for most of them. The first exam the class actually sat is the only
	baseline every school already has, and it is reproducible from the marks
	register by hand — which is the test that matters when a governor asks
	where the number came from.

	The comparison is in percentage points, not a percentage change. "Up four
	points" is a statement about the class; "up nine per cent" invites the
	reader to think a child's mark rose by nine.
*/
func (s *Server) getBaselineAnalysis(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	classID := strings.TrimSpace(q.Get("class_id"))

	cohorts := []cohortGrowth{}
	subjects := []movement{}
	students := []movement{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT c.id::text, c.name, c.level, ex.id::text, ex.name,
			       to_char(COALESCE(ex.starts_on, ex.created_at::date),'YYYY-MM-DD'),
			       count(DISTINCT m.student_id)::int,
			       round(100 * sum(m.marks_obtained + m.grace_marks)
			             / NULLIF(sum(es.max_marks),0), 1)::float8
			  FROM marks m
			  JOIN exam_subjects es ON es.id = m.exam_subject_id
			  JOIN exams        ex ON ex.id = es.exam_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN classes       c ON c.id = cs.class_id
			 WHERE NOT m.is_absent AND m.marks_obtained IS NOT NULL
			   AND ($1::uuid IS NULL OR ex.academic_year_id = $1::uuid)
			   AND ($2::uuid IS NULL OR c.id = $2::uuid)
			 GROUP BY c.id, c.name, c.level, ex.id, ex.name, ex.starts_on, ex.created_at
			 ORDER BY c.level, c.name, COALESCE(ex.starts_on, ex.created_at::date), ex.name`,
			nullString(q.Get("academic_year_id")), nullString(classID))
		if err != nil {
			return err
		}
		byClass := map[string]int{}
		for rows.Next() {
			var cid, cname, examID, examName string
			var level, students int
			var on *string
			var pct *float64
			if err := rows.Scan(&cid, &cname, &level, &examID, &examName, &on,
				&students, &pct); err != nil {
				rows.Close()
				return err
			}
			i, seen := byClass[cid]
			if !seen {
				cohorts = append(cohorts, cohortGrowth{ClassID: cid, ClassName: cname,
					Level: level, Trend: []cohortPoint{}})
				i = len(cohorts) - 1
				byClass[cid] = i
			}
			cohorts[i].Trend = append(cohorts[i].Trend, cohortPoint{
				ExamID: examID, ExamName: examName, On: on, Students: students, Percent: pct})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for i := range cohorts {
			t := cohorts[i].Trend
			switch len(t) {
			case 0:
			case 1:
				first := t[0]
				cohorts[i].Baseline = &first
				cohorts[i].Note = "only one assessment so far this year — " +
					"growth needs a second to measure against"
			default:
				first, last := t[0], t[len(t)-1]
				cohorts[i].Baseline = &first
				cohorts[i].Latest = &last
				if first.Percent != nil && last.Percent != nil {
					d := round1(*last.Percent - *first.Percent)
					cohorts[i].Delta = &d
				}
			}
		}

		// The per-subject and per-child movement is only meaningful for one
		// cohort at a time, and unbounded across the school.
		if classID == "" || len(cohorts) != 1 || cohorts[0].Latest == nil {
			return nil
		}
		base, latest := cohorts[0].Baseline.ExamID, cohorts[0].Latest.ExamID

		srows, err := tx.Query(r.Context(), `
			SELECT sub.name,
			       round(100 * sum(m.marks_obtained + m.grace_marks) FILTER (WHERE es.exam_id = $1::uuid)
			             / NULLIF(sum(es.max_marks) FILTER (WHERE es.exam_id = $1::uuid),0), 1)::float8,
			       round(100 * sum(m.marks_obtained + m.grace_marks) FILTER (WHERE es.exam_id = $2::uuid)
			             / NULLIF(sum(es.max_marks) FILTER (WHERE es.exam_id = $2::uuid),0), 1)::float8
			  FROM marks m
			  JOIN exam_subjects es ON es.id = m.exam_subject_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN subjects     sub ON sub.id = cs.subject_id
			 WHERE NOT m.is_absent AND m.marks_obtained IS NOT NULL
			   AND es.exam_id IN ($1::uuid, $2::uuid) AND cs.class_id = $3::uuid
			 GROUP BY sub.name ORDER BY sub.name`, base, latest, classID)
		if err != nil {
			return err
		}
		for srows.Next() {
			var m movement
			if err := srows.Scan(&m.Name, &m.Baseline, &m.Latest); err != nil {
				srows.Close()
				return err
			}
			m.Delta = deltaPoints(m.Baseline, m.Latest)
			subjects = append(subjects, m)
		}
		srows.Close()
		if err := srows.Err(); err != nil {
			return err
		}

		prows, err := tx.Query(r.Context(), `
			SELECT st.id::text, st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       round(100 * sum(m.marks_obtained + m.grace_marks) FILTER (WHERE es.exam_id = $1::uuid)
			             / NULLIF(sum(es.max_marks) FILTER (WHERE es.exam_id = $1::uuid),0), 1)::float8,
			       round(100 * sum(m.marks_obtained + m.grace_marks) FILTER (WHERE es.exam_id = $2::uuid)
			             / NULLIF(sum(es.max_marks) FILTER (WHERE es.exam_id = $2::uuid),0), 1)::float8
			  FROM marks m
			  JOIN exam_subjects es ON es.id = m.exam_subject_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN students      st ON st.id = m.student_id
			 WHERE NOT m.is_absent AND m.marks_obtained IS NOT NULL
			   AND es.exam_id IN ($1::uuid, $2::uuid) AND cs.class_id = $3::uuid
			 GROUP BY st.id, st.admission_no, st.first_name, st.middle_name, st.last_name
			 ORDER BY 3`, base, latest, classID)
		if err != nil {
			return err
		}
		defer prows.Close()
		for prows.Next() {
			var m movement
			if err := prows.Scan(&m.StudentID, &m.AdmissionNo, &m.Name, &m.Baseline,
				&m.Latest); err != nil {
				return err
			}
			m.Delta = deltaPoints(m.Baseline, m.Latest)
			students = append(students, m)
		}
		return prows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"basis": "Baseline is the earliest exam this cohort has marks for in the year; " +
			"the comparison is its most recent. Movement is in percentage points.",
		"cohorts": cohorts, "subjects": subjects, "students": students,
	})
}

func deltaPoints(from, to *float64) *float64 {
	if from == nil || to == nil {
		return nil
	}
	d := round1(*to - *from)
	return &d
}

type subjectPerformance struct {
	Subject   string   `json:"subject"`
	ClassName string   `json:"class_name"`
	ExamName  string   `json:"exam_name"`
	Entered   int      `json:"entered"`
	Average   *float64 `json:"average_percent,omitempty"`
	BelowPass int      `json:"below_pass"`
	PassRate  *float64 `json:"pass_rate,omitempty"`
	// Marks entered above the paper's own maximum. Until validateMark there
	// was nothing stopping 50 being stored against a paper out of 20, and the
	// average above is then over 100% — arithmetically right, physically
	// impossible. Sent so the screen can decline to print the percentage and
	// name the fault rather than clamping a number a person actually typed.
	// Omitted when nought.
	OverMax int `json:"marks_above_max,omitempty"`
}

type atRiskStudent struct {
	StudentID   string   `json:"student_id"`
	Name        string   `json:"name"`
	AdmissionNo string   `json:"admission_no"`
	ClassName   string   `json:"class_name"`
	Percent     *float64 `json:"percent,omitempty"`
	Backlogs    int      `json:"backlogs"`
	Papers      int      `json:"papers"`
}

/*
getBoardPerformance is the examination controller's one page.

	Pass means at or above the pass mark in every paper sat, which is what a
	school means by "passed" and what a board means on a memo. Counting a pass
	per paper instead would let a child who failed two subjects appear in the
	pass rate twice, and the number a school quotes to parents would flatter it
	by ten points.

	A backlog is one subject below the pass mark. The two numbers answer
	different questions — how many children are in trouble, and how much
	trouble there is — and a screen that only carries one of them cannot
	staff a remedial timetable.
*/
func (s *Server) getBoardPerformance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()

	bySubject := []subjectPerformance{}
	atRisk := []atRiskStudent{}
	summary := map[string]any{}
	board := map[string]any{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		args := []any{nullString(q.Get("exam_id")), nullString(q.Get("class_id")),
			nullString(q.Get("academic_year_id"))}

		rows, err := tx.Query(r.Context(), `
			SELECT sub.name, c.name, ex.name, count(*)::int,
			       round(100 * sum(m.marks_obtained + m.grace_marks)
			             / NULLIF(sum(es.max_marks),0), 1)::float8,
			       count(*) FILTER (WHERE m.marks_obtained + m.grace_marks < es.pass_marks)::int,
			       count(*) FILTER (WHERE es.max_marks > 0
			                          AND m.marks_obtained + m.grace_marks > es.max_marks)::int
			  FROM marks m
			  JOIN exam_subjects es ON es.id = m.exam_subject_id
			  JOIN exams        ex ON ex.id = es.exam_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN subjects     sub ON sub.id = cs.subject_id
			  JOIN classes       c ON c.id = cs.class_id
			 WHERE NOT m.is_absent AND m.marks_obtained IS NOT NULL
			   AND ($1::uuid IS NULL OR ex.id = $1::uuid)
			   AND ($2::uuid IS NULL OR c.id = $2::uuid)
			   AND ($3::uuid IS NULL OR ex.academic_year_id = $3::uuid)
			 GROUP BY sub.name, c.name, ex.name
			 ORDER BY c.name, sub.name`, args...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v subjectPerformance
			if err := rows.Scan(&v.Subject, &v.ClassName, &v.ExamName, &v.Entered,
				&v.Average, &v.BelowPass, &v.OverMax); err != nil {
				rows.Close()
				return err
			}
			if v.Entered > 0 {
				p := round1(100 * float64(v.Entered-v.BelowPass) / float64(v.Entered))
				v.PassRate = &p
			}
			bySubject = append(bySubject, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		prows, err := tx.Query(r.Context(), `
			SELECT st.id::text, concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.admission_no, COALESCE(c.name,''), count(*)::int,
			       count(*) FILTER (WHERE m.marks_obtained + m.grace_marks < es.pass_marks)::int,
			       round(100 * sum(m.marks_obtained + m.grace_marks)
			             / NULLIF(sum(es.max_marks),0), 1)::float8
			  FROM marks m
			  JOIN exam_subjects es ON es.id = m.exam_subject_id
			  JOIN exams        ex ON ex.id = es.exam_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN classes       c ON c.id = cs.class_id
			  JOIN students     st ON st.id = m.student_id
			 WHERE NOT m.is_absent AND m.marks_obtained IS NOT NULL
			   AND ($1::uuid IS NULL OR ex.id = $1::uuid)
			   AND ($2::uuid IS NULL OR c.id = $2::uuid)
			   AND ($3::uuid IS NULL OR ex.academic_year_id = $3::uuid)
			 GROUP BY st.id, st.admission_no, st.first_name, st.middle_name, st.last_name, c.name
			 ORDER BY 6 DESC, 7`, args...)
		if err != nil {
			return err
		}
		var candidates, passed, distinctions, backlogs int
		var sum float64
		var counted int
		for prows.Next() {
			var v atRiskStudent
			if err := prows.Scan(&v.StudentID, &v.Name, &v.AdmissionNo, &v.ClassName,
				&v.Papers, &v.Backlogs, &v.Percent); err != nil {
				prows.Close()
				return err
			}
			candidates++
			backlogs += v.Backlogs
			if v.Backlogs == 0 {
				passed++
			}
			if v.Percent != nil {
				sum += *v.Percent
				counted++
				if *v.Percent >= 75 {
					distinctions++
				}
			}
			// Fifty is what fits a remedial list. The counts above are over
			// every child, so the summary does not depend on this cut.
			if v.Backlogs > 0 && len(atRisk) < 50 {
				atRisk = append(atRisk, v)
			}
		}
		prows.Close()
		if err := prows.Err(); err != nil {
			return err
		}

		/* How many marks in this whole cut are above their paper's maximum.
		   Summed from the by-subject rows, which are cut from the same marks,
		   so the screen's headline average and its table agree about whether
		   they can be trusted. Set only when there are some: a zero here would
		   have every screen render a warning about nothing. */
		overMax := 0
		for _, v := range bySubject {
			overMax += v.OverMax
		}
		if overMax > 0 {
			summary["marks_above_max"] = overMax
		}

		summary["candidates"] = candidates
		summary["passed"] = passed
		summary["backlogs"] = backlogs
		summary["distinctions"] = distinctions
		summary["at_risk"] = candidates - passed
		summary["papers"] = len(bySubject)
		if candidates > 0 {
			summary["pass_rate"] = round1(100 * float64(passed) / float64(candidates))
		} else {
			summary["pass_rate"] = nil
		}
		if counted > 0 {
			summary["average_percent"] = round1(sum / float64(counted))
		} else {
			summary["average_percent"] = nil
		}

		/* The board's own verdict, where the school has one.

		   Kept beside the internal figures rather than merged into them: the
		   school's pass rate is what its own papers say, the board's is what
		   the state says, and the gap between the two is the most useful
		   number on this page. */
		var examName string
		var total, boardPassed int
		var publishedOn *string
		err = tx.QueryRow(r.Context(), `
			SELECT i.exam_name,
			       (SELECT count(*) FROM board_result_rows rr WHERE rr.import_id = i.id)::int,
			       (SELECT count(*) FROM board_result_rows rr
			         WHERE rr.import_id = i.id AND rr.result = 'pass')::int,
			       to_char(i.published_at,'YYYY-MM-DD')
			  FROM board_result_imports i
			 WHERE ($1::uuid IS NULL OR i.academic_year_id = $1::uuid)
			 ORDER BY i.imported_at DESC LIMIT 1`,
			nullString(q.Get("academic_year_id"))).
			Scan(&examName, &total, &boardPassed, &publishedOn)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		board["exam_name"] = examName
		board["candidates"] = total
		board["passed"] = boardPassed
		board["published_on"] = publishedOn
		if total > 0 {
			board["pass_rate"] = round1(100 * float64(boardPassed) / float64(total))
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Sort the remedial list worst first: most backlogs, then lowest mark.
	sort.SliceStable(atRisk, func(i, j int) bool {
		if atRisk[i].Backlogs != atRisk[j].Backlogs {
			return atRisk[i].Backlogs > atRisk[j].Backlogs
		}
		return floatOr(atRisk[i].Percent, 101) < floatOr(atRisk[j].Percent, 101)
	})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"summary": summary, "by_subject": bySubject, "at_risk": atRisk,
		"board": board,
		"definitions": map[string]string{
			"pass":    "at or above the pass mark in every paper sat",
			"backlog": "one subject below the pass mark",
		},
	})
}

func floatOr(v *float64, fallback float64) float64 {
	if v == nil {
		return fallback
	}
	return *v
}
