package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Module 2 — Admissions.

   enquiry → application → documents → test/interview → merit → seat → offer →
   enrolment. The handoff at the end is the part that matters: it must create
   the student, the enrolment and the first invoice in one transaction, because
   a half-admitted child is worse than a rejected one. */

type upsertEnquiryRequest struct {
	StudentName  string `json:"student_name"`
	ParentName   string `json:"parent_name"`
	Phone        string `json:"phone"`
	Email        string `json:"email"`
	ClassSought  string `json:"class_sought"`
	Source       string `json:"source"`
	Campaign     string `json:"campaign"`
	NextFollowUp string `json:"next_follow_up"`
	Notes        string `json:"notes"`
	AssignedTo   string `json:"assigned_to"`
}

// createEnquiry captures a walk-in, phone or web enquiry.
// enquirySources mirrors the enquiries_source_check constraint. Without this
// a mistyped source is a 500 from Postgres rather than a correctable answer.
var enquirySources = []option{
	{"walk_in", "Walked in"},
	{"phone", "Telephone"},
	{"website", "Website"},
	{"referral", "Referral"},
	{"campaign", "Campaign"},
	{"other", "Other"},
}

func (s *Server) createEnquiry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req upsertEnquiryRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.StudentName) == "" || strings.TrimSpace(req.Phone) == "" {
		httpx.BadRequest(w, r, "student_name and phone are required")
		return
	}
	if req.Source == "" {
		req.Source = "walk_in"
	}
	if err := oneOf("source", req.Source, enquirySources); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	var newID string
	var applicant applicantWelcome
	// Which channels could not carry the application link, and why. Returned
	// rather than logged: the person who can do something about an SMTP server
	// nobody has filled in is the one standing at this screen.
	var linkFailed []string
	var errUnknownClass = errors.New("unknown class")
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// class_sought is a uuid column behind a plainly-named string field, so
		// anything that is not already an id — "Class 6" from a clerk, an
		// importer, an integration — used to reach Postgres and come back as a
		// 500. Resolving the name is both the fix and the more useful
		// behaviour: the front desk knows the class by its name.
		classSought := nullString(req.ClassSought)
		if v := strings.TrimSpace(req.ClassSought); v != "" {
			if _, err := uuid.Parse(v); err != nil {
				var resolved string
				err := tx.QueryRow(r.Context(),
					`SELECT id::text FROM classes WHERE lower(name) = lower($1)`, v).Scan(&resolved)
				if errors.Is(err, pgx.ErrNoRows) {
					return errUnknownClass
				}
				if err != nil {
					return err
				}
				classSought = &resolved
			}
		}

		var campusID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT id FROM campuses ORDER BY created_at LIMIT 1`).Scan(&campusID); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO enquiries (institution_id, campus_id, student_name, parent_name,
			                       phone, email, class_sought, source, campaign,
			                       next_follow_up, notes, assigned_to, status)
			VALUES ($1,$2,$3,$4,$5,$6::citext,$7::uuid,$8,$9,$10::date,$11,$12::uuid,'new')
			RETURNING id::text`,
			nullUUIDArg(id.InstitutionID), campusID, req.StudentName,
			nullString(req.ParentName), req.Phone, nullString(req.Email),
			classSought, req.Source, nullString(req.Campaign),
			nullString(req.NextFollowUp), nullString(req.Notes),
			nullString(req.AssignedTo)).Scan(&newID); err != nil {
			return err
		}

		/* AND SEND THEM THE FORM.

		   The clerk has just written down a mobile number. Until now that was
		   the end of it: the family went away with nothing and whether they
		   ever applied depended on somebody ringing back. The link goes out on
		   WhatsApp, SMS and email in the same transaction as the enquiry, so a
		   rolled-back enquiry cannot leave a parent holding a link to a record
		   the school does not have.

		   Never fails the enquiry. See sendEnquiryApplicationLink. */
		enquiryUUID, perr := uuid.Parse(newID)
		if perr != nil {
			return perr
		}
		linkFailed = s.sendEnquiryApplicationLink(r.Context(), tx, id.InstitutionID,
			enquiryUUID, req.StudentName, req.ParentName, req.Phone, req.Email)

		/* AND A WAY TO WATCH WHAT HAPPENS TO IT.

		   The link above asks the family to fill a form. This gives them the
		   account that shows what became of it -- the application, the
		   documents, the test, the decision -- which is the question they
		   would otherwise ring the office to ask, every week, until the season
		   ends. Same transaction and the same rule: it cannot fail the
		   enquiry. See issueEnquiryLogin. */
		applicant = s.issueEnquiryLogin(r.Context(), tx, id.InstitutionID, enquiryUUID,
			req.StudentName, req.ParentName, req.Phone, req.Email)
		return nil
	})
	if errors.Is(err, errUnknownClass) {
		httpx.BadRequest(w, r,
			"class_sought must be a class id or the name of a class this school runs")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": newID, "status": "new",
		// Named separately from the login's own note because the two are fixed
		// in different places: a form nobody has opened is an admissions job, a
		// mail server nobody has configured is an integrations one.
		"link_not_sent": linkFailed,
		// The password is here because it is nowhere else: nothing can read it
		// back out afterwards, so if no message arrives this response is the
		// only copy that ever existed -- and the parent is usually still at
		// the desk, which is the one moment it can be handed over by hand.
		"parent_login": applicant,
	})
}

type enquiryStatusRequest struct {
	Status       string `json:"status"`
	NextFollowUp string `json:"next_follow_up,omitempty"`
	Notes        string `json:"notes,omitempty"`
	LostReason   string `json:"lost_reason,omitempty"`
}

// updateEnquiry logs a follow-up outcome.
//
// A lost enquiry must carry a reason: "fee too high" and "moved city" lead to
// completely different actions, and the funnel report is worthless without it.
func (s *Server) updateEnquiry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid enquiry id")
		return
	}
	var req enquiryStatusRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	// Exactly the set enquiries_status_check allows.
	valid := map[string]bool{"new": true, "contacted": true,
		"visit_scheduled": true, "applied": true, "lost": true}
	if !valid[req.Status] {
		httpx.BadRequest(w, r, "invalid status: "+req.Status)
		return
	}
	if req.Status == "lost" && strings.TrimSpace(req.LostReason) == "" {
		httpx.BadRequest(w, r, "lost_reason is required when marking an enquiry lost")
		return
	}

	notes := req.Notes
	if req.LostReason != "" {
		notes = strings.TrimSpace(notes + "\nLost: " + req.LostReason)
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE enquiries
			   SET status = $2,
			       next_follow_up = COALESCE($3::date, next_follow_up),
			       notes = CASE WHEN $4::text IS NULL THEN notes
			                    ELSE COALESCE(notes || E'\n', '') || $4 END,
			       updated_at = now()
			 WHERE id = $1`, eid, req.Status, nullString(req.NextFollowUp), nullString(notes))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
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
	httpx.JSON(w, http.StatusOK, map[string]any{"id": eid.String(), "status": req.Status})
}

type createApplicationRequest struct {
	EnquiryID   string `json:"enquiry_id,omitempty"`
	FirstName   string `json:"first_name"`
	MiddleName  string `json:"middle_name,omitempty"`
	LastName    string `json:"last_name,omitempty"`
	DateOfBirth string `json:"date_of_birth,omitempty"`
	Gender      string `json:"gender,omitempty"`
	Category    string `json:"category,omitempty"`
	ClassSought string `json:"class_sought"`
	ParentName  string `json:"parent_name"`
	ParentPhone string `json:"parent_phone"`
	ParentEmail string `json:"parent_email,omitempty"`
	Address     string `json:"address,omitempty"`
	PrevSchool  string `json:"previous_school,omitempty"`
	IsRTE       bool   `json:"is_rte"`

	// The form fee in paise, omitted where the school charges none. Paise
	// rather than rupees because every other money field here is, and a
	// receipt that disagrees with the ledger by a rounding is worse than no
	// receipt. Zero is a real answer meaning "waived", distinct from absent.
	FormFeePaise *int64 `json:"form_fee_paise,omitempty"`
	// Whether it was taken across the counter as the form was handed in,
	// which is the ordinary case — the clerk should not have to file the
	// application and then go and mark it paid.
	FormFeePaid    bool   `json:"form_fee_paid,omitempty"`
	FormFeeReceipt string `json:"form_fee_receipt,omitempty"`
}

// createApplication converts an enquiry into a formal application.
func (s *Server) createApplication(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req createApplicationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.FirstName == "" || req.ParentName == "" || req.ParentPhone == "" || req.ClassSought == "" {
		httpx.BadRequest(w, r, "first_name, parent_name, parent_phone and class_sought are required")
		return
	}
	classID, err := uuid.Parse(req.ClassSought)
	if err != nil {
		httpx.BadRequest(w, r, "class_sought must be a class uuid")
		return
	}

	var (
		appID, appNo string
		welcome      applicantWelcome
		acknowledged bool
		ackNote      string
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var instID, campusID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id, id FROM campuses ORDER BY created_at LIMIT 1`).
			Scan(&instID, &campusID); err != nil {
			return err
		}
		// Application numbers share the gapless allocator with receipts, so the
		// series is auditable in the same way.
		no, err := fees.NextNumber(r.Context(), tx, instID, "application")
		if err != nil {
			return err
		}
		appNo = no

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO applications (institution_id, campus_id, enquiry_id, application_no,
			                          first_name, middle_name, last_name, date_of_birth,
			                          gender, category, class_sought, parent_name,
			                          parent_phone, parent_email, address, previous_school,
			                          is_rte, status,
			                          form_fee_paise, form_fee_paid_at, form_fee_receipt)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14::citext,$15,$16,$17,'submitted',
			        $18, CASE WHEN $19::boolean AND $18::bigint IS NOT NULL THEN now() END, $20)
			RETURNING id::text`,
			instID, campusID, nullString(req.EnquiryID), appNo,
			req.FirstName, nullString(req.MiddleName), nullString(req.LastName),
			nullString(req.DateOfBirth), nullString(req.Gender), nullString(req.Category),
			classID, req.ParentName, req.ParentPhone, nullString(req.ParentEmail),
			nullString(req.Address), nullString(req.PrevSchool), req.IsRTE,
			req.FormFeePaise, req.FormFeePaid, nullString(req.FormFeeReceipt)).Scan(&appID); err != nil {
			return err
		}

		/* The paperwork checklist, raised with the application.

		   Seeded here as well as lazily on first open, so the verification
		   queue can say "2 of 4 verified" for an application nobody has opened
		   yet — which is the whole point of a queue. */
		for _, d := range defaultChecklist {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO application_documents
				       (institution_id, application_id, doc_type, is_required, status)
				VALUES ($1, $2::uuid, $3, $4, 'pending')
				ON CONFLICT DO NOTHING`,
				instID, appID, d.Type, d.Required); err != nil {
				return err
			}
		}

		if req.EnquiryID != "" {
			if _, err = tx.Exec(r.Context(),
				`UPDATE enquiries SET status = 'applied', updated_at = now() WHERE id = $1`,
				req.EnquiryID); err != nil {
				return err
			}
		}

		/* Submitted is the moment the parent should be able to watch.

		   Not the enquiry -- an application taken at the counter often has no
		   enquiry behind it, and that family had no way in at all. The account
		   is the guardian's, found by phone or email before anything is
		   created, so a parent who already signs in about an older child keeps
		   the one login and simply gains this application on it.

		   Neither of these may fail the application: a form that was handed in
		   was handed in. Both run inside their own savepoint and report. */
		created := uuid.MustParse(appID)
		welcome = s.ensureApplicantLogin(r.Context(), tx, instID, created)
		facts, ferr := loadApplicantFacts(r.Context(), tx, created)
		if ferr != nil {
			return ferr
		}
		switch err := s.notifyApplicant(r.Context(), tx, instID, created,
			"admissions.application_received", facts, nil,
			"stage:submitted"); {
		case errors.Is(err, errNoApplicantEmail):
			ackNote = "No email address on the application, so no acknowledgement " +
				"was sent."
		case err != nil:
			ackNote = "The acknowledgement could not be queued: " + err.Error()
		default:
			acknowledged = true
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out := map[string]any{
		"id": appID, "application_no": appNo, "status": "submitted",
		"acknowledged": acknowledged,
	}
	if ackNote != "" {
		out["note"] = ackNote
	}
	// The password exists nowhere else, so it is handed back to the clerk who
	// is standing in front of the parent. Empty when the family already had a
	// login, which is not a failure.
	if welcome.SignInAs != "" || welcome.Note != "" {
		out["parent_login"] = welcome
	}
	httpx.JSON(w, http.StatusCreated, out)
}

type assessmentRequest struct {
	Kind        string   `json:"kind"` // entrance_test | interview
	ScheduledAt string   `json:"scheduled_at,omitempty"`
	Score       *float64 `json:"score,omitempty"`
	MaxScore    *float64 `json:"max_score,omitempty"`
	Remarks     string   `json:"remarks,omitempty"`
}

// recordAssessment schedules or scores an entrance test or interview.
func (s *Server) recordAssessment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	appID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid application id")
		return
	}
	var req assessmentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Kind != "entrance_test" && req.Kind != "interview" {
		httpx.BadRequest(w, r, "kind must be entrance_test or interview")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO admission_assessments (institution_id, application_id, kind,
			                                   scheduled_at, score, max_score, remarks, conducted_by)
			VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8)`,
			id.InstitutionID, appID, req.Kind, nullString(req.ScheduledAt),
			req.Score, req.MaxScore, nullString(req.Remarks), id.UserID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"application_id": appID.String(), "kind": req.Kind})
}

type meritRow struct {
	ApplicationID string   `json:"application_id"`
	ApplicationNo string   `json:"application_no"`
	Name          string   `json:"name"`
	ClassSought   *string  `json:"class_sought,omitempty"`
	Category      *string  `json:"category,omitempty"`
	IsRTE         bool     `json:"is_rte"`
	TestPercent   *float64 `json:"test_percent,omitempty"`
	InterviewPct  *float64 `json:"interview_percent,omitempty"`
	MeritScore    float64  `json:"merit_score"`
	Rank          int      `json:"rank"`
	Status        string   `json:"status"`
}

// getMeritList ranks applicants by a weighted score.
//
// Weights are query parameters rather than hardcoded because every school
// divides the marks differently; the default 70/30 entrance-to-interview split
// is the most common. Applicants with no assessment score 0 and sort last
// rather than being dropped, so the list stays a complete picture of the intake.
func (s *Server) getMeritList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	testWeight := clampInt(q.Get("test_weight"), 70, 0, 100)
	interviewWeight := 100 - testWeight

	items, err := collect(s, r, `
		WITH scored AS (
		  SELECT a.id, a.application_no,
		         concat_ws(' ', a.first_name, a.middle_name, a.last_name) AS name,
		         c.name AS class_name, a.category, a.is_rte, a.status,
		         (SELECT round(100.0 * max(aa.score) / NULLIF(max(aa.max_score),0), 2)
		            FROM admission_assessments aa
		           WHERE aa.application_id = a.id AND aa.kind = 'entrance_test') AS test_pct,
		         (SELECT round(100.0 * max(aa.score) / NULLIF(max(aa.max_score),0), 2)
		            FROM admission_assessments aa
		           WHERE aa.application_id = a.id AND aa.kind = 'interview') AS int_pct
		    FROM applications a
		    LEFT JOIN classes c ON c.id = a.class_sought
		   WHERE ($1::uuid IS NULL OR a.class_sought = $1)
		     AND a.status NOT IN ('rejected','withdrawn')
		)
		SELECT id::text, application_no, name, class_name, category, is_rte,
		       test_pct, int_pct,
		       round(COALESCE(test_pct,0) * $2 / 100.0 + COALESCE(int_pct,0) * $3 / 100.0, 2),
		       rank() OVER (ORDER BY
		           COALESCE(test_pct,0) * $2 / 100.0 + COALESCE(int_pct,0) * $3 / 100.0 DESC)::int,
		       status
		  FROM scored
		 ORDER BY 9 DESC, application_no`,
		[]any{nullString(q.Get("class_id")), testWeight, interviewWeight},
		func(rows pgx.Rows) (meritRow, error) {
			var v meritRow
			return v, rows.Scan(&v.ApplicationID, &v.ApplicationNo, &v.Name, &v.ClassSought,
				&v.Category, &v.IsRTE, &v.TestPercent, &v.InterviewPct, &v.MeritScore,
				&v.Rank, &v.Status)
		})
	respond(w, r, items, err)
}

type seatRow struct {
	ClassID   string `json:"class_id"`
	ClassName string `json:"class_name"`
	Capacity  int    `json:"capacity"`
	Enrolled  int    `json:"enrolled"`
	Offered   int    `json:"offered"`
	Available int    `json:"available"`
	RTEQuota  int    `json:"rte_quota"`
	RTEFilled int    `json:"rte_filled"`
}

// getSeatMatrix shows availability per class against capacity.
//
// The RTE quota is 25% of intake by statute, tracked separately because those
// seats cannot be filled from the general merit list.
func (s *Server) getSeatMatrix(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT c.id::text, c.name,
		       COALESCE(sum(sec.capacity), 0)::int,
		       (SELECT count(*) FROM enrollments e
		         WHERE e.class_id = c.id AND e.status = 'active')::int,
		       (SELECT count(*) FROM applications a
		         WHERE a.class_sought = c.id AND a.status IN ('offered','accepted'))::int,
		       GREATEST(0, COALESCE(sum(sec.capacity),0)
		                   - (SELECT count(*) FROM enrollments e
		                       WHERE e.class_id = c.id AND e.status='active')
		                   - (SELECT count(*) FROM applications a
		                       WHERE a.class_sought = c.id AND a.status IN ('offered','accepted')))::int,
		       -- RTE reservation is 25% of sanctioned intake.
		       (COALESCE(sum(sec.capacity),0) / 4)::int,
		       (SELECT count(*) FROM students st
		          JOIN enrollments e2 ON e2.student_id = st.id AND e2.class_id = c.id
		         WHERE st.is_rte)::int
		  FROM classes c
		  LEFT JOIN sections sec ON sec.class_id = c.id
		 GROUP BY c.id
		 ORDER BY c.level`, nil,
		func(rows pgx.Rows) (seatRow, error) {
			var v seatRow
			return v, rows.Scan(&v.ClassID, &v.ClassName, &v.Capacity, &v.Enrolled,
				&v.Offered, &v.Available, &v.RTEQuota, &v.RTEFilled)
		})
	respond(w, r, items, err)
}

type decisionRequest struct {
	Decision string `json:"decision"` // offered | rejected | waitlisted
	Remarks  string `json:"remarks,omitempty"`
}

// decideApplication issues an offer, rejection or waitlist place.
func (s *Server) decideApplication(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	appID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid application id")
		return
	}
	var req decisionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	valid := map[string]bool{"offered": true, "rejected": true, "waitlisted": true}
	if !valid[req.Decision] {
		httpx.BadRequest(w, r, "decision must be offered, rejected or waitlisted")
		return
	}

	var note string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Refuse to offer a seat that does not exist. Overselling a class is
		// discovered on the first day of term, when it cannot be undone.
		if req.Decision == "offered" {
			var available int
			if err := tx.QueryRow(r.Context(), `
				SELECT GREATEST(0, COALESCE((SELECT sum(sec.capacity) FROM sections sec
				                              WHERE sec.class_id = a.class_sought), 0)
				                   - (SELECT count(*) FROM enrollments e
				                       WHERE e.class_id = a.class_sought AND e.status='active')
				                   - (SELECT count(*) FROM applications a2
				                       WHERE a2.class_sought = a.class_sought
				                         AND a2.status IN ('offered','accepted')))::int
				  FROM applications a WHERE a.id = $1`, appID).Scan(&available); err != nil {
				return err
			}
			if available <= 0 {
				return errNoSeats
			}
		}

		tag, err := tx.Exec(r.Context(), `
			UPDATE applications
			   SET status = $2, decided_by = $3, decided_at = now(),
			       remarks = COALESCE($4, remarks), updated_at = now()
			 WHERE id = $1`, appID, req.Decision, id.UserID, nullString(req.Remarks))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		// An offer, a rejection or a waiting-list place is the message a family
		// has been waiting weeks for. Inside the same transaction as the
		// decision, so a rolled-back decision cannot leave a parent already
		// told; never able to fail it, so a mail server cannot unmake an offer.
		_, note = s.notifyApplicationStage(r.Context(), tx, id.InstitutionID, appID, req.Decision)
		return nil
	})
	if errors.Is(err, errNoSeats) {
		httpx.Error(w, r, http.StatusConflict, "no_seats",
			"no seats remain in that class; waitlist the applicant instead")
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
	out := map[string]any{"id": appID.String(), "status": req.Decision}
	if note != "" {
		// The office learns on the screen that the family was not reached,
		// rather than assuming a decision emailed itself.
		out["note"] = note
	}
	httpx.JSON(w, http.StatusOK, out)
}

var errNoSeats = errors.New("no seats available")

type enrolRequest struct {
	SectionID      string `json:"section_id"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
	// Which price list to bill against. Omitted, the newest active structure
	// for the class is used, which is what the desk sees on the screen.
	FeeStructureID string `json:"fee_structure_id,omitempty"`

	// A waiver agreed at the counter: RTE, a sibling, a scholarship the
	// principal has approved. Recorded against the invoice rather than
	// silently reducing the amount, so the concession is auditable and the
	// full fee is still on the record.
	ConcessionPaise  int64  `json:"concession_paise,omitempty"`
	ConcessionReason string `json:"concession_reason,omitempty"`

	// Skip billing entirely. For a school that raises its fees in one run at
	// the start of term rather than per admission.
	NoInvoice bool `json:"no_invoice,omitempty"`

	// Services this family has actually asked for: 'transport', 'hostel'.
	// A fee head marked for a service is billed only when it is named here,
	// so a child who walks to school is not quoted a bus.
	Services []string `json:"services,omitempty"`

	/* The bus itself, not just the bill for it.

	   Naming 'transport' above only ever billed for a bus. Putting the child
	   on one needed somebody in the transport office to open a second screen
	   later and find the student again, so the ordinary outcome was an invoice
	   for transport and no seat: the family has paid, the office believes it
	   is arranged, and the first anybody knows is a child at a stop the driver
	   has no reason to call at. Optional -- a walker sends none of it. */
	Transport admissionTransport `json:"transport,omitempty"`
}

// enrolApplicant is the handoff: an admitted applicant becomes a student.
//
// One transaction creates the student, the enrolment, the guardian link and
// optionally the first invoice. Doing this in steps is how schools end up with
// a student who has no enrolment, or an enrolment with no fee demand — both of
// which surface weeks later as "this child is not on any list".
func (s *Server) enrolApplicant(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	appID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid application id")
		return
	}
	var req enrolRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	/* Who sets a price and who collects it are different people.

	   Enrolling needs students.write, which the admissions desk holds. Deciding
	   what a family pays needs fees.write, which it does not — and this handler
	   accepted a concession in rupees from whoever called it. An officer could
	   have waived four thousand off a friend's admission with nobody's approval
	   and nothing to review, or collected the full fee against a reduced
	   invoice and kept the difference.

	   The discount book already has a two-person control: raised on fees.write,
	   approved on refunds.write. This route must not be a way around it. */
	if req.ConcessionPaise != 0 && !httpx.IdentityFrom(r.Context()).Can(rbac.FeesWrite) {
		httpx.Error(w, r, http.StatusForbidden, "not_your_price",
			"you can enrol this child, but not decide what they pay. Ask accounts "+
				"to record the concession. The admission does not have to wait for it.")
		return
	}
	sectionID, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}

	var studentID, admissionNo string
	var welcome admissionWelcome
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			instID, campusID, classID uuid.UUID
			first, parentName, phone  string
			middle, last, dob, gender *string
			category                  *string
			isRTE                     bool
			status                    string
			existing                  *uuid.UUID
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT institution_id, campus_id, class_sought, first_name, middle_name,
			       last_name, to_char(date_of_birth,'YYYY-MM-DD'), gender, category,
			       parent_name, parent_phone, is_rte, status, student_id
			  FROM applications WHERE id = $1 FOR UPDATE`, appID).
			Scan(&instID, &campusID, &classID, &first, &middle, &last, &dob, &gender,
				&category, &parentName, &phone, &isRTE, &status, &existing); err != nil {
			return err
		}
		if existing != nil {
			// Already enrolled. Idempotent rather than creating a duplicate
			// child record, which is near-impossible to unpick later.
			studentID = existing.String()
			return nil
		}
		if status != "offered" && status != "accepted" {
			return errNotOffered
		}

		admissionNo, err = fees.NextNumber(r.Context(), tx, instID, "admission")
		if err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO students (institution_id, campus_id, admission_no, first_name,
			                      middle_name, last_name, date_of_birth, gender, category,
			                      is_rte, admission_date, status)
			VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,CURRENT_DATE,'active')
			RETURNING id::text`,
			instID, campusID, admissionNo, first, middle, last, dob, gender,
			category, isRTE).Scan(&studentID); err != nil {
			return err
		}

		yearID := req.AcademicYearID
		if yearID == "" {
			if err := tx.QueryRow(r.Context(), `
				SELECT id::text FROM academic_years
				 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&yearID); err != nil {
				return err
			}
		}

		if _, err := tx.Exec(r.Context(), `
			INSERT INTO enrollments (institution_id, student_id, academic_year_id,
			                         class_id, section_id, status)
			VALUES ($1,$2::uuid,$3::uuid,$4,$5,'active')`,
			instID, studentID, yearID, classID, sectionID); err != nil {
			return err
		}

		// Carry the parent across as a guardian so the child is contactable
		// from day one rather than after a separate data-entry pass.
		/* The guardian the enquiry already made, where there is one.

		   An enquiry issues the family a login and hangs it off a guardian
		   (see issueEnquiryLogin). Falling through to the upsert below would
		   match that guardian only if the application spelled the parent's
		   name exactly as the enquiry did -- and it frequently does not, since
		   one was typed by a clerk taking a call and the other by the family.
		   A miss there mints a second guardian, a second user and a second
		   password, and the credential the parent has been signing in with
		   since the enquiry silently stops being the current one.

		   So the link is read rather than inferred. */
		var guardianID string
		if err := tx.QueryRow(r.Context(), `
			SELECT e.guardian_id::text
			  FROM applications a JOIN enquiries e ON e.id = a.enquiry_id
			 WHERE a.id = $1 AND e.guardian_id IS NOT NULL`, appID).
			Scan(&guardianID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		/* Failing that, the guardian already holding a login on this number.

		   The enquiry link above is the reliable route and this is the net
		   under it: an application typed at the counter without naming its
		   enquiry, or a family whose enquiry predates logins being issued at
		   all. Without it the upsert below matches on a name a parent typed at
		   home against one a clerk typed on the phone, misses, and mints a
		   second guardian -- whose new-user INSERT then violates the unique
		   index on (institution_id, phone) and takes the whole admission down
		   with it, invoice and all.

		   Only a guardian that already has an account, because that is the one
		   whose duplication actually breaks something. */
		if guardianID == "" && phone != "" {
			if err := tx.QueryRow(r.Context(), `
				SELECT id::text FROM guardians
				 WHERE phone = $1 AND user_id IS NOT NULL
				 ORDER BY created_at
				 LIMIT 1`, phone).Scan(&guardianID); err != nil &&
				!errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		if guardianID == "" {
			// No enquiry behind this application, or one taken before logins
			// were issued at enquiry. Reuse an existing guardian rather than
			// inserting blindly: siblings share a parent, and guardians is
			// unique on (institution_id, phone, full_name). Admitting a second
			// child of the same family failed outright until this became an
			// upsert -- which is the common case in a school, not an edge one.
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO guardians (institution_id, full_name, relation, phone)
				VALUES ($1,$2,'father',$3)
				ON CONFLICT (institution_id, phone, full_name)
				DO UPDATE SET relation = guardians.relation
				RETURNING id::text`,
				instID, parentName, phone).Scan(&guardianID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary)
			VALUES ($1::uuid,$2::uuid,$3,true)`, studentID, guardianID, instID); err != nil {
			return err
		}

		/* The fee account, opened with the child.

		   In this transaction rather than after it: a student who exists with
		   no invoice is the state that lets somebody sit in class for free,
		   and it is invisible — nothing looks wrong on either screen. If the
		   billing fails the admission rolls back with it, which is recoverable;
		   a half-admitted child is not.

		   A class with no priced structure is not an error. Plenty of schools
		   bill in one run at the start of term, and refusing the admission
		   because the price list is not ready would be the software telling a
		   school how to run its office. */
		if !req.NoInvoice {
			structureID := req.FeeStructureID
			if structureID == "" {
				// Same rule as the panel that showed the figure: a NULL
				// class_id prices the whole school, and the class-specific
				// list wins where there is one.
				err := tx.QueryRow(r.Context(), `
					SELECT id::text FROM fee_structures
					 WHERE is_active AND (class_id = $1 OR class_id IS NULL)
					 ORDER BY (class_id IS NOT NULL) DESC, created_at DESC
					 LIMIT 1`, classID).Scan(&structureID)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}
			if structureID != "" {
				invoiceNo, err := fees.NextNumber(r.Context(), tx, instID, "invoice")
				if err != nil {
					return err
				}
				var invoiceID string
				if err := tx.QueryRow(r.Context(), `
					INSERT INTO invoices (institution_id, campus_id, student_id,
					                      academic_year_id, invoice_no, instalment_no,
					                      issued_on, due_on, gross_paise, discount_paise,
					                      status)
					VALUES ($1,$2,$3::uuid,$4::uuid,$5,1,CURRENT_DATE,CURRENT_DATE,0,0,'unpaid')
					RETURNING id::text`,
					instID, campusID, studentID, yearID, invoiceNo).Scan(&invoiceID); err != nil {
					return err
				}

				if _, err := tx.Exec(r.Context(), `
					INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id,
					                           description, amount_paise, discount_paise)
					SELECT $1, $2::uuid, fsi.fee_head_id, fh.name, fsi.amount_paise, 0
					  FROM fee_structure_items fsi
					  JOIN fee_heads fh ON fh.id = fsi.fee_head_id
					 WHERE fsi.fee_structure_id = $3::uuid AND fsi.instalment_no = 1
					   AND (fh.service IS NULL OR fh.service = ANY($4::text[]))`,
					instID, invoiceID, structureID, req.Services); err != nil {
					return err
				}

				/* The waiver lands on the largest line rather than being spread.

				   Spreading it across heads would change what each head
				   collected, and the heads are what the accounts are cut by —
				   a concession on tuition must not quietly reduce the caution
				   deposit, which is refundable money held for the family. */
				if req.ConcessionPaise > 0 {
					if _, err := tx.Exec(r.Context(), `
						UPDATE invoice_lines l
						   SET discount_paise = LEAST(l.amount_paise, $2::bigint),
						       description = l.description ||
						           CASE WHEN btrim($3) = '' THEN ''
						                ELSE ' (' || btrim($3) || ')' END
						 WHERE l.id = (
						   SELECT id FROM invoice_lines
						    WHERE invoice_id = $1::uuid
						    ORDER BY amount_paise DESC LIMIT 1)`,
						invoiceID, req.ConcessionPaise, req.ConcessionReason); err != nil {
						return err
					}
				}

				// net_paise is generated from these, so only the inputs are written.
				if _, err := tx.Exec(r.Context(), `
					UPDATE invoices SET
					    gross_paise    = COALESCE((SELECT sum(amount_paise)   FROM invoice_lines WHERE invoice_id = $1::uuid), 0),
					    discount_paise = COALESCE((SELECT sum(discount_paise) FROM invoice_lines WHERE invoice_id = $1::uuid), 0)
					 WHERE id = $1::uuid`, invoiceID); err != nil {
					return err
				}
			}
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE applications SET status='accepted', student_id=$2::uuid, updated_at=now()
			 WHERE id = $1`, appID, studentID); err != nil {
			return err
		}
		// 'applied' is the furthest state the enquiry vocabulary defines; the
		// application row carries the outcome beyond that.
		if _, err := tx.Exec(r.Context(), `
			UPDATE enquiries SET status='applied', updated_at=now()
			 WHERE id = (SELECT enquiry_id FROM applications WHERE id = $1)`, appID); err != nil {
			return err
		}

		/* The family is let in here, in this transaction, and not later.

		   Until now an admission wrote a child, a guardian and an invoice and
		   told nobody. A parent login existed only if somebody afterwards
		   opened the student's profile and pressed a button most offices never
		   found, so the ordinary end state for a real admission was a family
		   being texted about absences and linked to a portal they could not
		   enter.

		   Inside the transaction so the account and the child arrive together:
		   a guardian row pointing at a user that was rolled back is worse than
		   no account. It cannot fail the admission -- every path inside it
		   returns a note rather than an error, for the same reason the message
		   is queued rather than sent. */
		if sid, perr := uuid.Parse(studentID); perr == nil {
			/* The bus, before the login, because this one can fail the
			   admission and the login cannot. A stop on the wrong route is a
			   mistake the desk should be told about while the parent is still
			   standing there, not a silent half-arrangement. */
			if req.Transport.wanted() {
				if terr := allocateAtAdmission(
					r.Context(), tx, instID, sid, req.Transport); terr != nil {
					return terr
				}
			}
			welcome = s.issueAdmissionLogin(r.Context(), tx, instID, sid)
		}
		return nil
	})
	if errors.Is(err, errStopNotOnRoute) {
		httpx.BadRequest(w, r, "that stop is not on that route. Two routes often pass the "+
			"same corner, so check which one the family was given")
		return
	}
	if errors.Is(err, errBadTransportRef) {
		httpx.BadRequest(w, r, "route_id and pickup_stop_id must be uuids")
		return
	}
	if errors.Is(err, errNotOffered) {
		httpx.BadRequest(w, r, "only an offered application can be enrolled")
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
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"student_id": studentID, "admission_no": admissionNo, "status": "enrolled",
		// The password is in the response because it is nowhere else: nothing
		// can read it back out afterwards, so if the message does not arrive
		// this screen is the only copy that ever existed. The parent is
		// usually still at the desk at this moment, which is the one time it
		// can be handed over by hand.
		"parent_login": welcome,
	})
}

var errNotOffered = errors.New("application has not been offered a seat")

type funnelStage struct {
	Stage string `json:"stage"`
	Count int    `json:"count"`
}

/*
getAdmissionsFunnel is the conversion report: enquiries → enrolled.

	EVERY STAGE HERE IS CUMULATIVE — every application ever raised, not the
	ones still waiting on somebody. The dashboard's open_applications is the
	live queue (status not accepted, rejected or withdrawn) and the attention
	panel's admissions probe is narrower still (waiting on a decision:
	submitted, under review, test scheduled, interviewed). Three different
	questions, three different numbers, and the second stage below was called
	"Applications" flat — the same word the dashboard used for a smaller set.
	It says "received" now, because that is the difference: this counts arrivals
	and the other two count work outstanding.
*/
func (s *Server) getAdmissionsFunnel(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT 'Enquiries', count(*)::int FROM enquiries
		UNION ALL SELECT 'Applications received', count(*)::int FROM applications
		UNION ALL SELECT 'Assessed', count(DISTINCT application_id)::int FROM admission_assessments
		UNION ALL SELECT 'Offered or accepted', count(*)::int FROM applications WHERE status IN ('offered','accepted')
		UNION ALL SELECT 'Enrolled', count(*)::int FROM applications WHERE student_id IS NOT NULL`, nil,
		func(rows pgx.Rows) (funnelStage, error) {
			var v funnelStage
			return v, rows.Scan(&v.Stage, &v.Count)
		})
	respond(w, r, items, err)
}

func nullUUIDArg(u uuid.UUID) any {
	if u == uuid.Nil {
		return nil
	}
	return u
}
