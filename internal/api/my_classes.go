package api

import (
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* What a class teacher knows about each child.

   The product could show a roster and, separately, an attendance register, a
   gradebook and a fee ledger. Nobody teaching thirty children opens four
   screens per child, so the thing a class teacher is actually asked for at a
   parent meeting — how is this one doing — did not exist anywhere.

   One roll-up per student across the four signals a school already collects,
   and one honest reason attached to each. "At risk" with no reason is an
   accusation; "missed 9 of the last 40 days and has turned in 2 of 6
   homeworks" is something a teacher can act on before the term ends. */

// --- the roster roll-up ---------------------------------------------------

type progressRow struct {
	StudentID   string `json:"student_id"`
	AdmissionNo string `json:"admission_no"`
	Name        string `json:"full_name"`
	Section     string `json:"section"`
	ClassName   string `json:"class_name"`

	AttendancePresent int      `json:"attendance_present"`
	AttendanceMarked  int      `json:"attendance_marked"`
	AttendancePct     *float64 `json:"attendance_percent,omitempty"`

	HomeworkSet       int `json:"homework_set"`
	HomeworkSubmitted int `json:"homework_submitted"`
	// What the rest of the section managed on the same pieces, 0–1. Null when
	// the section has no roll or nothing was set.
	SectionRate *float64 `json:"section_submission_rate,omitempty"`

	// Average across every paper this child has a mark for, as a percentage of
	// the maximum. Nullable because "no exams yet" and "scored zero" are
	// different facts and a screen that shows 0% for the first is lying.
	MarksPercent *float64 `json:"marks_percent,omitempty"`
	PapersMarked int      `json:"papers_marked"`

	DuePaise int64 `json:"fees_due_paise"`

	IsCWSN   bool    `json:"is_cwsn"`
	CWSNType *string `json:"cwsn_type,omitempty"`
	HasPlan  bool    `json:"has_support_plan"`
	Concerns int     `json:"notes_of_concern"`
	Commends int     `json:"commendations"`

	// Why, in the school's own terms. Empty means nothing is wrong.
	Risks []string `json:"risks"`
	Band  string   `json:"risk_band"` // none | watch | at_risk
}

/*
listStudentProgress rolls up one row per child in the caller's reach.

	Written as a single query with lateral sub-selects rather than five queries
	joined in Go, because the roster is the unit a teacher scrolls and paging
	it in application memory would put the slowest child's fee ledger in front
	of the fastest child's attendance.
*/
func (s *Server) listStudentProgress(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	rng := resolveRange(r)

	where, args := res.StudentPredicate("st", 3)
	args = append([]any{rng.From, rng.To}, args...)

	rows, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.last_name),
		       COALESCE(sec.name, '—'), COALESCE(cl.name, '—'),
		       att.present, att.marked,
		       -- COALESCE because the GROUP BY below makes the lateral return
		       -- no rows at all for a section with no homework set.
		       COALESCE(hw.set_count, 0), COALESCE(hw.submitted, 0), hw.section_rate,
		       mk.pct, mk.papers,
		       COALESCE(fee.due, 0),
		       st.is_cwsn, st.cwsn_type,
		       EXISTS (SELECT 1 FROM student_support_plans sp
		                WHERE sp.student_id = st.id AND sp.status <> 'closed'),
		       dis.concerns, dis.commends
		  FROM students st
		  LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
		  LEFT JOIN sections sec ON sec.id = en.section_id
		  LEFT JOIN classes cl ON cl.id = sec.class_id

		  -- Attendance over the chosen window. A day nobody marked is not an
		  -- absence, so the denominator counts marked days only.
		  LEFT JOIN LATERAL (
		      SELECT count(*) FILTER (WHERE sa.status IN ('present','late'))::int AS present,
		             count(*)::int AS marked
		        FROM student_attendance sa
		       WHERE sa.student_id = st.id
		         AND sa.on_date BETWEEN $1::date AND $2::date
		  ) att ON TRUE

		  /* Homework set to this child's section against what they turned in,
		     and — the part that makes it fair — what the rest of the section
		     managed on the same pieces. A child measured against a perfect
		     score is being marked down for their school's habits; measured
		     against the classmates who got the same worksheet, they are not. */
		  LEFT JOIN LATERAL (
		      SELECT count(*)::int AS set_count,
		             count(sub.id)::int AS submitted,
		             CASE WHEN count(*) > 0 AND peers.roll > 0
		                  THEN peers.handed_in::numeric / (count(*) * peers.roll)
		             END AS section_rate
		        FROM homework h
		        LEFT JOIN homework_submissions sub
		               ON sub.homework_id = h.id AND sub.student_id = st.id
		        CROSS JOIN LATERAL (
		            SELECT (SELECT count(*) FROM enrollments e2
		                     WHERE e2.section_id = en.section_id AND e2.status = 'active')::int AS roll,
		                   (SELECT count(*) FROM homework_submissions s2
		                      JOIN homework h2 ON h2.id = s2.homework_id
		                     WHERE h2.section_id = en.section_id
		                       AND h2.is_published
		                       AND h2.assigned_on BETWEEN $1::date AND $2::date)::int AS handed_in
		        ) peers
		       WHERE h.section_id = en.section_id
		         AND h.is_published
		         AND h.assigned_on BETWEEN $1::date AND $2::date
		       GROUP BY peers.roll, peers.handed_in
		  ) hw ON TRUE

		  -- Marks as a percentage of the maximum available, across every paper
		  -- with a mark. Absences are excluded rather than scored zero.
		  LEFT JOIN LATERAL (
		      SELECT CASE WHEN sum(es.max_marks) > 0
		                  THEN round(100.0 * sum(m.marks_obtained) / sum(es.max_marks), 1)
		             END AS pct,
		             count(*)::int AS papers
		        FROM marks m
		        JOIN exam_subjects es ON es.id = m.exam_subject_id
		       WHERE m.student_id = st.id AND NOT m.is_absent
		         AND m.marks_obtained IS NOT NULL
		  ) mk ON TRUE

		  LEFT JOIN LATERAL (
		      SELECT COALESCE(sum(i.net_paise - i.paid_paise), 0)::bigint AS due
		        FROM invoices i
		       WHERE i.student_id = st.id
		         AND i.status NOT IN ('cancelled', 'paid')
		  ) fee ON TRUE

		  LEFT JOIN LATERAL (
		      SELECT count(*) FILTER (WHERE NOT dr.is_positive)::int AS concerns,
		             count(*) FILTER (WHERE dr.is_positive)::int AS commends
		        FROM discipline_records dr
		       WHERE dr.student_id = st.id
		  ) dis ON TRUE

		 WHERE st.status = 'active' AND `+where+`
		 ORDER BY cl.name, sec.name, st.first_name
		 LIMIT 600`, args,
		func(rows pgx.Rows) (progressRow, error) {
			var v progressRow
			err := rows.Scan(&v.StudentID, &v.AdmissionNo, &v.Name, &v.Section, &v.ClassName,
				&v.AttendancePresent, &v.AttendanceMarked,
				&v.HomeworkSet, &v.HomeworkSubmitted, &v.SectionRate,
				&v.MarksPercent, &v.PapersMarked, &v.DuePaise,
				&v.IsCWSN, &v.CWSNType, &v.HasPlan, &v.Concerns, &v.Commends)
			if err != nil {
				return v, err
			}
			score(&v)
			return v, nil
		})
	respond(w, r, rows, err)
}

/*
score attaches the reasons, and only then the band.

	The order matters. A band computed first and explained afterwards drifts
	from its explanation the moment a threshold changes; here the band is
	literally how many reasons there are, so it cannot disagree with them.

	Thresholds are the ones Indian schools already use: 75% attendance is the
	board's own exam-eligibility line, and 35% is the usual pass mark. Picking
	numbers a school already argues about beats inventing new ones.
*/
func score(v *progressRow) {
	// Empty rather than nil: a nil slice marshals to null, and every caller
	// would then have to guard a list that is meant to be simply empty.
	v.Risks = []string{}
	if v.AttendanceMarked >= 10 {
		pct := 100 * float64(v.AttendancePresent) / float64(v.AttendanceMarked)
		v.AttendancePct = &pct
		if pct < 75 {
			v.Risks = append(v.Risks, "Attendance "+pct1(pct)+
				", below the 75% needed to sit the board exam")
		}
	}
	if v.MarksPercent != nil && *v.MarksPercent < 35 && v.PapersMarked >= 2 {
		v.Risks = append(v.Risks, "Averaging "+pct1(*v.MarksPercent)+" across "+
			plural(v.PapersMarked, "paper", "papers"))
	}
	/* Homework, judged against the section rather than against perfection.

	   Two guards, and both earn their place. Four pieces at least, because two
	   missed in a fortnight is a bad week and not a pattern. And the section
	   itself has to be handing work in — where a school publishes homework but
	   never collects it, every child would otherwise be flagged for the
	   school's habit, which is both useless and unfair to the child. */
	if v.HomeworkSet >= 4 && v.SectionRate != nil && *v.SectionRate >= 0.3 {
		mine := float64(v.HomeworkSubmitted) / float64(v.HomeworkSet)
		if mine < *v.SectionRate/2 {
			v.Risks = append(v.Risks, "Turned in "+itoa(v.HomeworkSubmitted)+" of "+
				plural(v.HomeworkSet, "homework", "homeworks")+
				", against "+pct1(*v.SectionRate*100)+" for the section")
		}
	}
	if v.Concerns >= 3 {
		v.Risks = append(v.Risks, plural(v.Concerns, "conduct note", "conduct notes")+" this year")
	}
	// Fees are deliberately last and never on their own enough to mark a child
	// at risk. A family's arrears are the office's problem, not a reason for a
	// teacher to treat the child differently.
	if v.DuePaise > 0 {
		v.Risks = append(v.Risks, "₹"+indianRupees(v.DuePaise/100)+" outstanding")
	}

	academic := len(v.Risks)
	if v.DuePaise > 0 {
		academic--
	}
	switch {
	case academic >= 2:
		v.Band = "at_risk"
	case academic == 1:
		v.Band = "watch"
	default:
		v.Band = "none"
	}
}

// --- conduct notes --------------------------------------------------------

type noteRow struct {
	ID               string  `json:"id"`
	StudentID        string  `json:"student_id"`
	StudentName      string  `json:"student_name"`
	OccurredOn       string  `json:"occurred_on"`
	Category         string  `json:"category"`
	IsPositive       bool    `json:"is_positive"`
	Description      string  `json:"description"`
	ActionTaken      *string `json:"action_taken,omitempty"`
	VisibleToStudent bool    `json:"visible_to_student"`
	ParentNotified   bool    `json:"parent_notified"`
	RecordedBy       *string `json:"recorded_by,omitempty"`
}

/*
listDisciplineNotes returns conduct notes, positive and otherwise.

	One table for both because a school that records only what a child did
	wrong ends up with a file that reads like a charge sheet, and the teacher
	writing the good ones is doing the same job at the same moment.

	A child reading their own notes sees only the ones marked visible. That
	flag exists so a teacher can write "spoke to the counsellor about trouble
	at home" without it appearing in the student's portal.
*/
func (s *Server) listDisciplineNotes(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	id := httpx.IdentityFrom(r.Context())

	where, args := res.StudentPredicate("st", 2)
	args = append([]any{nullString(r.URL.Query().Get("student_id"))}, args...)

	// Without the standing to write in a child's conduct file, the caller is a
	// family reading their own, and sees only what the school chose to share.
	// The private half exists so a teacher can write "spoke to the counsellor
	// about trouble at home" without it surfacing in the child's portal.
	visible := "TRUE"
	if !id.Can(rbac.DisciplineWrite) {
		visible = "dr.visible_to_student"
	}

	items, err := collect(s, r, `
		SELECT dr.id::text, dr.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       to_char(dr.occurred_on,'YYYY-MM-DD'), dr.category, dr.is_positive,
		       dr.description, dr.action_taken,
		       dr.visible_to_student, dr.parent_notified, u.full_name
		  FROM discipline_records dr
		  JOIN students st ON st.id = dr.student_id
		  LEFT JOIN users u ON u.id = dr.recorded_by
		 WHERE ($1::uuid IS NULL OR dr.student_id = $1::uuid)
		   AND `+visible+`
		   AND `+where+`
		 ORDER BY dr.occurred_on DESC, dr.created_at DESC
		 LIMIT 300`, args,
		func(rows pgx.Rows) (noteRow, error) {
			var v noteRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.OccurredOn,
				&v.Category, &v.IsPositive, &v.Description, &v.ActionTaken,
				&v.VisibleToStudent, &v.ParentNotified, &v.RecordedBy)
		})
	respond(w, r, items, err)
}

type noteRequest struct {
	StudentID        string `json:"student_id"`
	OccurredOn       string `json:"occurred_on,omitempty"`
	Category         string `json:"category"`
	IsPositive       bool   `json:"is_positive"`
	Description      string `json:"description"`
	ActionTaken      string `json:"action_taken,omitempty"`
	VisibleToStudent bool   `json:"visible_to_student"`
	ParentNotified   bool   `json:"parent_notified"`
}

func (s *Server) recordDisciplineNote(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req noteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Description) == "" {
		httpx.BadRequest(w, r, "say what happened. A note with a category and no words is unusable at a parent meeting")
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}

	// A teacher may only write about a child they teach. Checked here rather
	// than left to RLS, which is per tenant and would happily let one section's
	// teacher write in another's file.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if ok, err := s.reachesStudent(r, res, student); err != nil {
		httpx.Internal(w, r, err)
		return
	} else if !ok {
		httpx.NotFound(w, r)
		return
	}

	if req.Category == "" {
		req.Category = "conduct"
	}
	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO discipline_records
			    (institution_id, student_id, occurred_on, category, is_positive,
			     description, action_taken, visible_to_student, parent_notified, recorded_by)
			VALUES ($1,$2,COALESCE(NULLIF($3,'')::date, current_date),$4,$5,$6,
			        NULLIF($7,''),$8,$9,$10)
			RETURNING id::text`,
			id.InstitutionID, student, req.OccurredOn, req.Category, req.IsPositive,
			req.Description, req.ActionTaken, req.VisibleToStudent,
			req.ParentNotified, id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- support plans --------------------------------------------------------

type supportPlanRow struct {
	ID              string  `json:"id"`
	StudentID       string  `json:"student_id"`
	StudentName     string  `json:"student_name"`
	ClassName       string  `json:"class_name"`
	CWSNType        *string `json:"cwsn_type,omitempty"`
	Concern         string  `json:"concern"`
	Accommodations  string  `json:"accommodations"`
	ExamConcession  *string `json:"exam_concession,omitempty"`
	ExternalSupport *string `json:"external_support,omitempty"`
	ReviewOn        *string `json:"review_on,omitempty"`
	Status          string  `json:"status"`
	// True once the review date has passed. Computed rather than stored: a
	// status column would need a nightly job to stay honest, and a plan that
	// silently stays "active" past its review is the failure this is for.
	ReviewDue bool `json:"review_due"`
}

func (s *Server) listSupportPlans(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	where, args := res.StudentPredicate("st", 1)

	items, err := collect(s, r, `
		SELECT sp.id::text, sp.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       COALESCE(cl.name, '—'), st.cwsn_type,
		       sp.concern, sp.accommodations, sp.exam_concession, sp.external_support,
		       to_char(sp.review_on,'YYYY-MM-DD'), sp.status,
		       sp.review_on IS NOT NULL AND sp.review_on < current_date
		         AND sp.status <> 'closed'
		  FROM student_support_plans sp
		  JOIN students st ON st.id = sp.student_id
		  LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
		  LEFT JOIN sections sec ON sec.id = en.section_id
		  LEFT JOIN classes cl ON cl.id = sec.class_id
		 WHERE `+where+`
		 ORDER BY (sp.review_on IS NOT NULL AND sp.review_on < current_date) DESC,
		          sp.status, st.first_name
		 LIMIT 300`, args,
		func(rows pgx.Rows) (supportPlanRow, error) {
			var v supportPlanRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.ClassName,
				&v.CWSNType, &v.Concern, &v.Accommodations, &v.ExamConcession,
				&v.ExternalSupport, &v.ReviewOn, &v.Status, &v.ReviewDue)
		})
	respond(w, r, items, err)
}

type supportPlanRequest struct {
	StudentID       string `json:"student_id"`
	Concern         string `json:"concern"`
	Accommodations  string `json:"accommodations"`
	ExamConcession  string `json:"exam_concession,omitempty"`
	ExternalSupport string `json:"external_support,omitempty"`
	ReviewOn        string `json:"review_on,omitempty"`
	Status          string `json:"status,omitempty"`
	CWSNType        string `json:"cwsn_type,omitempty"`
}

/*
saveSupportPlan writes the one live plan for a child.

	Upserted on the partial unique index rather than keyed by plan id, because
	the screen's question is "what are we doing for this child", not "edit plan
	number 4". Recording a plan also sets students.is_cwsn: a school that has
	agreed accommodations has, by that act, identified the child, and leaving
	the flag off would keep them out of the UDISE+ return.
*/
func (s *Server) saveSupportPlan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req supportPlanRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Concern) == "" || strings.TrimSpace(req.Accommodations) == "" {
		httpx.BadRequest(w, r,
			"a plan needs both the concern and what the school will do about it")
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.Status == "" {
		req.Status = "active"
	}
	if !slices.Contains([]string{"active", "review_due", "closed"}, req.Status) {
		httpx.BadRequest(w, r, "unknown status "+req.Status)
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if ok, err := s.reachesStudent(r, res, student); err != nil {
		httpx.Internal(w, r, err)
		return
	} else if !ok {
		httpx.NotFound(w, r)
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO student_support_plans
			    (institution_id, student_id, concern, accommodations, exam_concession,
			     external_support, review_on, status, created_by)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,'')::date,$8,$9)
			ON CONFLICT (student_id) WHERE status <> 'closed'
			DO UPDATE SET concern = EXCLUDED.concern,
			              accommodations = EXCLUDED.accommodations,
			              exam_concession = EXCLUDED.exam_concession,
			              external_support = EXCLUDED.external_support,
			              review_on = EXCLUDED.review_on,
			              status = EXCLUDED.status,
			              updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, student, req.Concern, req.Accommodations,
			req.ExamConcession, req.ExternalSupport, req.ReviewOn, req.Status,
			id.UserID).Scan(&newID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE students
			   SET is_cwsn = true,
			       cwsn_type = COALESCE(NULLIF($2,''), cwsn_type),
			       updated_at = now()
			 WHERE id = $1`, student, req.CWSNType)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID, "status": req.Status})
}

/*
reachesStudent answers "may this caller write about this child".

	Asked with the same predicate the roster is built from, so a teacher can
	never write a note about a child who does not appear on their own screen.
	Deliberately not left to row-level security, which is per tenant: RLS would
	happily let 6-A's teacher write in 6-B's file.
*/
func (s *Server) reachesStudent(r *http.Request, res *scope.Resolved, student uuid.UUID) (bool, error) {
	if res.AllStudents {
		return true, nil
	}
	if res.OwnsStudent(student) {
		return true, nil
	}
	where, args := res.StudentPredicate("st", 2)
	if where == "FALSE" {
		return false, nil
	}
	id := httpx.IdentityFrom(r.Context())
	var ok bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM students st WHERE st.id = $1 AND `+where+`)`,
			append([]any{student}, args...)...).Scan(&ok)
	})
	return ok, err
}

// pct1 renders a percentage the way a teacher would say it: "68%", not
// "68.0%", unless the fraction is the point.
func pct1(v float64) string {
	if v == float64(int(v)) {
		return strconv.Itoa(int(v)) + "%"
	}
	return strconv.FormatFloat(v, 'f', 1, 64) + "%"
}
