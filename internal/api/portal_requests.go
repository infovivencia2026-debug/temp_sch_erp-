package api

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* What a family asks the school for, and what the school owes them back.

   Nine catalogued screens, one rule. The group this mounts under requires
   self.profile.read, and every role in the product holds it — there is a test
   in internal/rbac asserting exactly that, because a user who cannot read their
   own profile cannot use the product at all. So the permission is not an
   authorisation here. It admits the accountant, the librarian and the driver
   just as readily as the parent.

   The only thing standing between a guardian and another family's child is the
   ownership check in each handler: resolveScope, then OwnsStudent on the id the
   caller sent. Every read narrows to res.StudentIDs and every write refuses an
   id outside it. There is deliberately no AllStudents escape hatch on these
   paths, unlike the staff-facing screens — a back-office role reading a child's
   file has its own endpoints, and letting it in through the family's door would
   mean the door has no lock, only a convention.

   Two tables are new; the rest is reuse. leave_requests already models a
   student absence, support_tickets already models a grievance,
   issued_certificates already models a bonafide request, student_documents
   already holds the file and payments already holds the receipt. Copying any of
   them into a parent-shaped table would produce a second version of the truth
   for the office to disagree with. */

// mountParentPortal registers the family-facing request, consent and message
// routes.
//
// Called from inside the existing /portal group, which already applies
// self.profile.read, so the paths here are relative. The group's permission is
// a floor and not a gate: see the file comment.
func (s *Server) mountParentPortal(r chi.Router) {
	// Leave and absence.
	//
	// There is no POST /leave here on purpose. POST /api/v1/workflow/leave
	// already records a guardian's application against their own child, with
	// the same ownership check, and it is what the Apply Student Leave screen
	// calls. A second writer into leave_requests would be the one the office's
	// approval queue disagrees with. What was missing is everything else: a
	// family could file an application and then never see it again.
	r.Get("/leave", s.listPortalLeave)
	r.Post("/leave/{id}/cancel", s.cancelPortalLeave)
	r.Post("/absence", s.reportChildAbsence)

	// Delegated pickup.
	r.Get("/pickup", s.listPickupAuthorisations)
	r.Post("/pickup", s.authorisePickup)
	r.Post("/pickup/{id}/revoke", s.revokePickup)
	// The gate, not the family. A parent must never be able to mark their own
	// authorisation as used: that is the record of a child having left, and it
	// is written by whoever handed the child over.
	r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).
		Get("/pickup/verify", s.verifyPickup)
	r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).
		Post("/pickup/{id}/release", s.releasePickup)

	// Concerns and messages.
	r.Get("/concerns", s.listPortalConcerns)
	r.Post("/concerns", s.raisePortalConcern)
	r.Get("/messages/teachers", s.listReachableTeachers)
	r.Get("/messages", s.listPortalMessages)
	r.Post("/messages", s.sendPortalMessage)

	// Fee receipts.
	r.Get("/receipts", s.listPortalReceipts)
	r.Get("/receipts/{id}", s.getPortalReceipt)

	// Certificates and documents.
	r.Get("/requests", s.listPortalRequests)
	r.Post("/requests", s.raisePortalRequest)
	r.Get("/requests/types", s.listPortalRequestTypes)
	r.Get("/documents", s.listPortalDocuments)
}

// --- ownership ---------------------------------------------------------------

// errNotYourChild is declared in mod_workflow.go and reused deliberately: the
// guardian leave path there and every handler here are answering one question,
// and two sentinels for it would eventually be caught in two different places.

/*
portalChild resolves the child a request names and refuses anyone else's.

	Callers pass the id in the query string or the body, so it is attacker
	controlled on every single endpoint in this file. Returning the resolved
	scope alongside saves each handler a second round trip.

	The refusal is a 404 rather than a 403. A parent guessing student ids should
	not be able to tell "this child exists but is not yours" from "no such
	child" — the first is already a disclosure, and it is the one an attacker
	uses to confirm a roll number.
*/
func (s *Server) portalChild(r *http.Request, raw string) (*scope.Resolved, uuid.UUID, error) {
	res, err := s.resolveScope(r)
	if err != nil {
		return nil, uuid.Nil, err
	}
	if strings.TrimSpace(raw) == "" {
		// One child is the common case and naming them is friction; more than
		// one and the screen has to choose, because guessing would file a leave
		// application against the wrong sibling.
		if len(res.StudentIDs) == 1 {
			return res, res.StudentIDs[0], nil
		}
		return res, uuid.Nil, errNotYourChild
	}
	sid, err := uuid.Parse(raw)
	if err != nil {
		return res, uuid.Nil, errNotYourChild
	}
	if !res.OwnsStudent(sid) {
		return res, uuid.Nil, errNotYourChild
	}
	return res, sid, nil
}

// denyChild writes the single refusal every ownership failure gets.
func denyChild(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, errNotYourChild) {
		httpx.NotFound(w, r)
		return true
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return true
	}
	return false
}

// --- leave and absence -------------------------------------------------------

type portalLeaveRow struct {
	ID        string  `json:"id"`
	StudentID string  `json:"student_id"`
	Student   string  `json:"student_name"`
	FromDate  string  `json:"from_date"`
	ToDate    string  `json:"to_date"`
	Days      float64 `json:"days"`
	HalfDay   bool    `json:"is_half_day"`
	Reason    string  `json:"reason"`
	Status    string  `json:"status"`
	Note      *string `json:"decision_note,omitempty"`
	DecidedBy *string `json:"decided_by,omitempty"`
	DecidedAt *string `json:"decided_at,omitempty"`
	AppliedOn string  `json:"applied_on"`
	// Whether the family may still withdraw it. A decided application cannot be
	// taken back, and the screen should not offer a button that will 409.
	Cancellable bool `json:"cancellable"`
}

// listPortalLeave powers parent.leave_absence.requests.
func (s *Server) listPortalLeave(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []portalLeaveRow{}})
		return
	}
	items, err := collect(s, r, `
		SELECT lr.id::text, lr.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       to_char(lr.from_date,'YYYY-MM-DD'), to_char(lr.to_date,'YYYY-MM-DD'),
		       lr.days, lr.is_half_day, lr.reason, lr.status,
		       lr.decision_note, u.full_name,
		       to_char(lr.decided_at,'YYYY-MM-DD"T"HH24:MI'),
		       to_char(lr.created_at,'YYYY-MM-DD'),
		       lr.status = 'pending'
		  FROM leave_requests lr
		  JOIN students st ON st.id = lr.student_id
		  LEFT JOIN users u ON u.id = lr.decided_by
		 WHERE lr.subject_kind = 'student' AND lr.student_id = ANY($1)
		 ORDER BY lr.from_date DESC, lr.created_at DESC
		 LIMIT 200`, []any{res.StudentIDs},
		func(rows pgx.Rows) (portalLeaveRow, error) {
			var v portalLeaveRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.FromDate, &v.ToDate,
				&v.Days, &v.HalfDay, &v.Reason, &v.Status, &v.Note, &v.DecidedBy,
				&v.DecidedAt, &v.AppliedOn, &v.Cancellable)
		})
	respond(w, r, items, err)
}

var errLeaveOverlaps = errors.New("leave already applied for those days")

// cancelPortalLeave withdraws a pending application.
//
// Scoped by student rather than by applicant: either parent may withdraw an
// application the other made, because from the school's side there is one
// family, and a mother cannot be told to wait for the father to log in.
func (s *Server) cancelPortalLeave(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	leaveID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid leave id")
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.NotFound(w, r)
		return
	}

	var status string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE leave_requests
			   SET status = 'cancelled'
			 WHERE id = $1 AND subject_kind = 'student'
			   AND student_id = ANY($2) AND status = 'pending'
			 RETURNING status`, leaveID, res.StudentIDs).Scan(&status)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Either it is not theirs or it has already been decided. Both are the
		// same answer to the family: there is nothing here to withdraw.
		httpx.Error(w, r, http.StatusConflict, "not_pending",
			"that application has already been decided or withdrawn")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": status})
}

type absenceRequest struct {
	StudentID string `json:"student_id,omitempty"`
	OnDate    string `json:"on_date,omitempty"`
	Reason    string `json:"reason"`
}

/*
reportChildAbsence powers parent.attendance.child_absence_reporting_button.

	One tap on the morning a child wakes up ill. It writes the same
	leave_requests row the application form writes, because the class teacher
	must see one list and not two, and because a school that later asks "was
	that absence explained" is asking about this record.

	What the button will not do is book the future. A parent telling the school
	their child is away next Tuesday is applying for leave, and routing it
	through here would skip the form the school built to ask why. Backdating is
	allowed for a week: parents ring on the day and file afterwards, and a
	report the system refuses is a report that stays on paper.
*/
func (s *Server) reportChildAbsence(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req absenceRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, sid, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "say why — an absence with no reason is still an unexplained absence")
		return
	}

	now := nowInIndia()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	on := today
	if strings.TrimSpace(req.OnDate) != "" {
		if on, err = time.ParseInLocation(time.DateOnly, req.OnDate, now.Location()); err != nil {
			httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
			return
		}
	}
	if on.After(today) {
		httpx.BadRequest(w, r,
			"this button is for today — to book a day off ahead, apply for leave")
		return
	}
	if on.Before(today.AddDate(0, 0, -7)) {
		httpx.BadRequest(w, r,
			"that is more than a week ago — the office has to amend the register by hand now")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var clash bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			    SELECT 1 FROM leave_requests
			     WHERE subject_kind = 'student' AND student_id = $1
			       AND status IN ('pending','approved')
			       AND $2::date BETWEEN from_date AND to_date)`, sid, on).Scan(&clash); err != nil {
			return err
		}
		if clash {
			return errLeaveOverlaps
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO leave_requests
			    (institution_id, subject_kind, student_id, from_date, to_date,
			     is_half_day, days, reason, status, applied_by)
			VALUES ($1,'student',$2,$3::date,$3::date,false,1,$4,'pending',$5)
			RETURNING id::text`,
			id.InstitutionID, sid, on, strings.TrimSpace(req.Reason), id.UserID).Scan(&newID)
	})
	if errors.Is(err, errLeaveOverlaps) {
		httpx.Error(w, r, http.StatusConflict, "already_reported",
			"that day is already covered by an application")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": newID, "on_date": on.Format(time.DateOnly),
	})
}

// --- delegated pickup --------------------------------------------------------

type pickupRow struct {
	ID        string  `json:"id"`
	StudentID string  `json:"student_id"`
	Student   string  `json:"student_name"`
	Name      string  `json:"full_name"`
	Phone     string  `json:"phone"`
	Relation  string  `json:"relation"`
	IDType    *string `json:"id_type,omitempty"`
	IDLast4   *string `json:"id_last4,omitempty"`
	ValidOn   string  `json:"valid_on"`
	Reason    string  `json:"reason"`
	// The code is returned to the family that created the pass and to the gate
	// verifying one. It is never listed to anybody else — see listPickup.
	Code       string  `json:"code"`
	UsedAt     *string `json:"used_at,omitempty"`
	ReleasedBy *string `json:"released_by,omitempty"`
	RevokedAt  *string `json:"revoked_at,omitempty"`
	Status     string  `json:"status"`
	CreatedAt  string  `json:"created_at"`
}

const pickupSelect = `
	SELECT p.id::text, p.student_id::text,
	       concat_ws(' ', st.first_name, st.last_name),
	       p.full_name, p.phone, p.relation, p.id_type, p.id_last4,
	       to_char(p.valid_on,'YYYY-MM-DD'), p.reason, p.code,
	       to_char(p.used_at,'YYYY-MM-DD"T"HH24:MI'), u.full_name,
	       to_char(p.revoked_at,'YYYY-MM-DD"T"HH24:MI'),
	       CASE WHEN p.used_at    IS NOT NULL THEN 'used'
	            WHEN p.revoked_at IS NOT NULL THEN 'revoked'
	            WHEN p.valid_on < current_date THEN 'expired'
	            ELSE 'live' END,
	       to_char(p.created_at,'YYYY-MM-DD')
	  FROM emergency_pickup_authorisations p
	  JOIN students st ON st.id = p.student_id
	  LEFT JOIN users u ON u.id = p.released_by`

func scanPickup(rows pgx.Rows) (pickupRow, error) {
	var v pickupRow
	return v, rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.Name, &v.Phone,
		&v.Relation, &v.IDType, &v.IDLast4, &v.ValidOn, &v.Reason, &v.Code,
		&v.UsedAt, &v.ReleasedBy, &v.RevokedAt, &v.Status, &v.CreatedAt)
}

// listPickupAuthorisations powers parent.consent.parent_delegation_for_emergency_pickup.
func (s *Server) listPickupAuthorisations(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []pickupRow{}})
		return
	}
	items, err := collect(s, r, pickupSelect+`
		 WHERE p.student_id = ANY($1)
		 ORDER BY p.valid_on DESC, p.created_at DESC
		 LIMIT 100`, []any{res.StudentIDs}, scanPickup)
	respond(w, r, items, err)
}

type pickupRequest struct {
	StudentID string `json:"student_id,omitempty"`
	Name      string `json:"full_name"`
	Phone     string `json:"phone"`
	Relation  string `json:"relation"`
	IDType    string `json:"id_type,omitempty"`
	IDLast4   string `json:"id_last4,omitempty"`
	ValidOn   string `json:"valid_on,omitempty"`
	Reason    string `json:"reason"`
}

/*
authorisePickup lets a guardian name somebody else to collect their child once.

	The code is generated here rather than chosen by the parent, because a
	parent picking a memorable number picks the child's date of birth, which the
	person turning up to collect them very often knows.

	crypto/rand and not math/rand: a predictable sequence would let anyone who
	obtained one code work out the next family's. Six digits is small enough to
	read down a telephone and is not the only check — the gate also sees the
	name, the relation and the child, and the pass is good for one day.

	The retry exists because the unique index on (institution_id, code) is the
	thing that actually guarantees no two live passes share a number. A
	collision is rare and a refusal would be inexplicable to the parent, so it
	is retried a few times rather than surfaced.
*/
func (s *Server) authorisePickup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req pickupRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, sid, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Phone) == "" ||
		strings.TrimSpace(req.Relation) == "" {
		httpx.BadRequest(w, r,
			"the gate needs a name, a number and who they are to the child")
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "say why somebody else is collecting them")
		return
	}

	now := nowInIndia()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	on := today
	if strings.TrimSpace(req.ValidOn) != "" {
		if on, err = time.ParseInLocation(time.DateOnly, req.ValidOn, now.Location()); err != nil {
			httpx.BadRequest(w, r, "valid_on must be YYYY-MM-DD")
			return
		}
	}
	if on.Before(today) {
		httpx.BadRequest(w, r, "a pass for a day that has passed cannot collect anybody")
		return
	}
	// A pass written far ahead is a standing arrangement in disguise, and a
	// standing arrangement is what the guardian list is for.
	if on.After(today.AddDate(0, 0, 30)) {
		httpx.BadRequest(w, r,
			"a pickup pass is good for a month at most — add them as a guardian instead")
		return
	}

	var newID, code string
	for range 5 {
		if code, err = pickupCode(); err != nil {
			httpx.Internal(w, r, err)
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				INSERT INTO emergency_pickup_authorisations
				    (institution_id, student_id, authorised_by, full_name, phone,
				     relation, id_type, id_last4, code, valid_on, reason)
				VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),NULLIF($8,''),$9,$10::date,$11)
				RETURNING id::text`,
				id.InstitutionID, sid, id.UserID, strings.TrimSpace(req.Name),
				strings.TrimSpace(req.Phone), strings.TrimSpace(req.Relation),
				req.IDType, req.IDLast4, code, on,
				strings.TrimSpace(req.Reason)).Scan(&newID)
		})
		if err == nil || !isUniqueViolation(err) {
			break
		}
	}
	if isUniqueViolation(err) {
		// The other unique index: one live pass per person, per child, per day.
		httpx.Error(w, r, http.StatusConflict, "already_authorised",
			"that person already has a live pass for your child on that day")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": newID, "code": code, "valid_on": on.Format(time.DateOnly),
	})
}

// pickupCode returns a six-digit code from the cryptographic source.
func pickupCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// revokePickup cancels a pass the family has thought better of.
//
// Only while it is unused: once the child has been collected there is nothing
// left to revoke, and rewriting the record to say otherwise would erase the
// only evidence of who took them.
func (s *Server) revokePickup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	passID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid pass id")
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.NotFound(w, r)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var got string
		return tx.QueryRow(r.Context(), `
			UPDATE emergency_pickup_authorisations
			   SET revoked_at = now()
			 WHERE id = $1 AND student_id = ANY($2)
			   AND used_at IS NULL AND revoked_at IS NULL
			 RETURNING id::text`, passID, res.StudentIDs).Scan(&got)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "not_live",
			"that pass has already been used or cancelled")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "revoked"})
}

/*
verifyPickup is the gate's lookup: somebody has recited a code.

	Front desk permission and not the family's, because this answers "which
	child does this number release", which is precisely the question a stranger
	must not be able to ask. It is a read and it is logged by the usual request
	log; releasing the child is the separate write below.

	Only live passes for today match. An expired, spent or revoked code returns
	nothing rather than returning the row with a status, so the receptionist
	cannot be talked into overriding a refusal they can see.
*/
func (s *Server) verifyPickup(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if len(code) != 6 {
		httpx.BadRequest(w, r, "a pickup code is six digits")
		return
	}
	items, err := collect(s, r, pickupSelect+`
		 WHERE p.code = $1 AND p.valid_on = current_date
		   AND p.used_at IS NULL AND p.revoked_at IS NULL`,
		[]any{code}, scanPickup)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(items) == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, items[0])
}

// releasePickup records that the child was handed over, spending the pass.
//
// The UPDATE carries the whole condition rather than trusting the verify call
// that preceded it: two receptionists on two counters can be looking at the
// same code, and the second must be refused.
func (s *Server) releasePickup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	passID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid pass id")
		return
	}
	var student string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE emergency_pickup_authorisations p
			   SET used_at = now(), released_by = $2
			  FROM students st
			 WHERE p.id = $1 AND st.id = p.student_id
			   AND p.valid_on = current_date
			   AND p.used_at IS NULL AND p.revoked_at IS NULL
			 RETURNING concat_ws(' ', st.first_name, st.last_name)`,
			passID, id.UserID).Scan(&student)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "not_live",
			"that pass is not good today — it has been used, cancelled or is for another date")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"student_name": student, "status": "used"})
}

// --- concerns ----------------------------------------------------------------

type concernRow struct {
	ID         string  `json:"id"`
	Student    *string `json:"student_name,omitempty"`
	Category   string  `json:"category"`
	Subject    string  `json:"subject"`
	Body       string  `json:"body"`
	Priority   string  `json:"priority"`
	Status     string  `json:"status"`
	Resolution *string `json:"resolution,omitempty"`
	AssignedTo *string `json:"assigned_to,omitempty"`
	CreatedAt  string  `json:"created_at"`
	ResolvedAt *string `json:"resolved_at,omitempty"`
	OpenDays   int     `json:"open_days"`
}

/*
listPortalConcerns powers parent.messages.concerns_grievance_ticketing.

	Narrowed to raised_by = the caller, not to the caller's children. A
	grievance is the complainant's, and two guardians of one child are two
	complainants: a mother raising a concern about a teacher has not agreed to
	the father reading it, and in the custody cases where this matters most she
	very much has not.
*/
func (s *Server) listPortalConcerns(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items, err := collect(s, r, `
		SELECT t.id::text,
		       NULLIF(concat_ws(' ', st.first_name, st.last_name), ''),
		       t.category, t.subject, t.body, t.priority, t.status, t.resolution,
		       u.full_name, to_char(t.created_at,'YYYY-MM-DD'),
		       to_char(t.resolved_at,'YYYY-MM-DD'),
		       EXTRACT(day FROM now() - t.created_at)::int
		  FROM support_tickets t
		  LEFT JOIN students st ON st.id = t.student_id
		  LEFT JOIN users u ON u.id = t.assigned_to
		 WHERE t.raised_by = $1
		 ORDER BY t.created_at DESC
		 LIMIT 100`, []any{id.UserID},
		func(rows pgx.Rows) (concernRow, error) {
			var v concernRow
			return v, rows.Scan(&v.ID, &v.Student, &v.Category, &v.Subject, &v.Body,
				&v.Priority, &v.Status, &v.Resolution, &v.AssignedTo, &v.CreatedAt,
				&v.ResolvedAt, &v.OpenDays)
		})
	respond(w, r, items, err)
}

type concernRequest struct {
	StudentID string `json:"student_id,omitempty"`
	Category  string `json:"category"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	Priority  string `json:"priority,omitempty"`
}

// The categories a family may file under. A free-text category would make the
// office's queue unsortable within a term, and the seller's support screen
// groups by this column too.
var concernCategories = map[string]bool{
	"academic": true, "fees": true, "transport": true, "hostel": true,
	"discipline": true, "safety": true, "staff": true, "facilities": true,
	"other": true,
}

func (s *Server) raisePortalConcern(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req concernRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Subject) == "" || strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "a concern needs a heading and what happened")
		return
	}
	if req.Category == "" {
		req.Category = "other"
	}
	if !concernCategories[req.Category] {
		httpx.BadRequest(w, r, "choose one of the listed categories")
		return
	}
	// urgent is the office's to assign. A queue where every family's concern
	// arrives urgent is a queue with no priority at all.
	if req.Priority == "" || req.Priority == "urgent" {
		req.Priority = "normal"
	}
	if req.Priority != "low" && req.Priority != "normal" && req.Priority != "high" {
		httpx.BadRequest(w, r, "priority must be low, normal or high")
		return
	}

	// A concern may name a child, and if it does the child must be the
	// caller's: student_id is what the office uses to pull the file.
	var child any
	if strings.TrimSpace(req.StudentID) != "" {
		_, sid, err := s.portalChild(r, req.StudentID)
		if denyChild(w, r, err) {
			return
		}
		child = sid
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO support_tickets
			    (institution_id, raised_by, student_id, category, subject, body, priority)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id::text`,
			id.InstitutionID, id.UserID, child, req.Category,
			strings.TrimSpace(req.Subject), strings.TrimSpace(req.Body),
			req.Priority).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- direct teacher messaging ------------------------------------------------

type teacherRow struct {
	UserID  string  `json:"user_id"`
	Name    string  `json:"full_name"`
	Subject *string `json:"subject,omitempty"`
	// Whether they are the child's class teacher. The family's default
	// correspondent, and the one the screen puts first.
	ClassTeacher bool `json:"class_teacher"`
	Unread       int  `json:"unread"`
}

/*
listReachableTeachers is the address book, and it is also the allow list.

	A parent may write to the people who teach their child: the class teacher
	and whoever is timetabled or assigned to their section. Not the principal,
	not the accountant, and above all not another parent — teacher_user_id
	arrives from the client, so without a set to check it against the endpoint
	would be an open messaging system between any two users in the school.

	The same query backs the check on send, which is why it is a function
	returning the set rather than only a handler.
*/
func (s *Server) reachableTeachers(r *http.Request, sid uuid.UUID) ([]teacherRow, error) {
	id := httpx.IdentityFrom(r.Context())
	return collect(s, r, `
		WITH child_section AS (
		    SELECT e.section_id
		      FROM enrollments e
		     WHERE e.student_id = $1 AND e.status = 'active'
		     ORDER BY e.enrolled_on DESC LIMIT 1
		)
		SELECT t.user_id::text, u.full_name, t.subject, bool_or(t.class_teacher),
		       (SELECT count(*)::int FROM parent_teacher_messages m
		         WHERE m.student_id = $1 AND m.parent_user_id = $2
		           AND m.teacher_user_id = t.user_id
		           AND m.sender_user_id <> $2 AND m.read_at IS NULL)
		  FROM (
		      SELECT sec.class_teacher_id AS user_id, NULL::text AS subject, true AS class_teacher
		        FROM sections sec
		       WHERE sec.id = (SELECT section_id FROM child_section)
		         AND sec.class_teacher_id IS NOT NULL
		      UNION ALL
		      -- Both routes to a subject go through class_subjects: the subject
		      -- a teacher is assigned is the one that class studies, not the
		      -- catalogue entry, so neither table carries subject_id directly.
		      SELECT sst.teacher_user_id, sub.name, false
		        FROM section_subject_teachers sst
		        JOIN class_subjects cs ON cs.id = sst.class_subject_id
		        LEFT JOIN subjects sub ON sub.id = cs.subject_id
		       WHERE sst.section_id = (SELECT section_id FROM child_section)
		      UNION ALL
		      SELECT te.teacher_user_id, sub.name, false
		        FROM timetable_entries te
		        JOIN class_subjects cs ON cs.id = te.class_subject_id
		        LEFT JOIN subjects sub ON sub.id = cs.subject_id
		       WHERE te.section_id = (SELECT section_id FROM child_section)
		         AND te.teacher_user_id IS NOT NULL
		  ) t
		  JOIN users u ON u.id = t.user_id
		 WHERE u.status = 'active'
		 GROUP BY t.user_id, u.full_name, t.subject
		 ORDER BY bool_or(t.class_teacher) DESC, u.full_name`,
		[]any{sid, id.UserID},
		func(rows pgx.Rows) (teacherRow, error) {
			var v teacherRow
			return v, rows.Scan(&v.UserID, &v.Name, &v.Subject, &v.ClassTeacher, &v.Unread)
		})
}

func (s *Server) listReachableTeachers(w http.ResponseWriter, r *http.Request) {
	_, sid, err := s.portalChild(r, r.URL.Query().Get("student_id"))
	if denyChild(w, r, err) {
		return
	}
	items, err := s.reachableTeachers(r, sid)
	respond(w, r, items, err)
}

type portalMessageRow struct {
	ID     string `json:"id"`
	Body   string `json:"body"`
	SentAt string `json:"sent_at"`
	Sender string `json:"sender_name"`
	// Whether the signed-in caller wrote it. The screen aligns on this rather
	// than comparing ids in the client.
	Mine   bool    `json:"mine"`
	ReadAt *string `json:"read_at,omitempty"`
}

/*
listPortalMessages returns one thread and marks the other end's messages read.

	Serves both ends. The caller is either the parent on the thread or the
	teacher on it, and anybody who is neither gets nothing — a thread is
	addressed to two people and the id of a third in the query string does not
	make them a party to it.

	Marking read happens on the read, not on a separate call the client might
	forget: a message the recipient has plainly seen but which still shows as
	unread makes the teacher's queue lie.
*/
func (s *Server) listPortalMessages(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	sid, err := uuid.Parse(strings.TrimSpace(q.Get("student_id")))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	parentID, err := uuid.Parse(strings.TrimSpace(q.Get("parent_user_id")))
	if err != nil {
		// The parent reading their own thread need not name themselves.
		parentID = id.UserID
	}
	teacherID, err := uuid.Parse(strings.TrimSpace(q.Get("teacher_user_id")))
	if err != nil {
		httpx.BadRequest(w, r, "teacher_user_id must be a uuid")
		return
	}
	// One of the two ends, or nothing. The parent end additionally has to own
	// the child — a guardian unlinked from the student since the thread began
	// stops being a party to it.
	switch {
	case parentID == id.UserID:
		res, _, err := s.portalChild(r, sid.String())
		if err != nil || !res.OwnsStudent(sid) {
			httpx.NotFound(w, r)
			return
		}
	case teacherID == id.UserID:
	default:
		httpx.NotFound(w, r)
		return
	}

	items, err := collect(s, r, `
		SELECT m.id::text, m.body,
		       to_char(m.sent_at,'YYYY-MM-DD"T"HH24:MI'), u.full_name,
		       m.sender_user_id = $4,
		       to_char(m.read_at,'YYYY-MM-DD"T"HH24:MI')
		  FROM parent_teacher_messages m
		  JOIN users u ON u.id = m.sender_user_id
		 WHERE m.student_id = $1 AND m.parent_user_id = $2 AND m.teacher_user_id = $3
		 ORDER BY m.sent_at
		 LIMIT 500`, []any{sid, parentID, teacherID, id.UserID},
		func(rows pgx.Rows) (portalMessageRow, error) {
			var v portalMessageRow
			return v, rows.Scan(&v.ID, &v.Body, &v.SentAt, &v.Sender, &v.Mine, &v.ReadAt)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE parent_teacher_messages
			   SET read_at = now()
			 WHERE student_id = $1 AND parent_user_id = $2 AND teacher_user_id = $3
			   AND sender_user_id <> $4 AND read_at IS NULL`,
			sid, parentID, teacherID, id.UserID)
		return err
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type sendMessageRequest struct {
	StudentID string `json:"student_id"`
	TeacherID string `json:"teacher_user_id,omitempty"`
	ParentID  string `json:"parent_user_id,omitempty"`
	Body      string `json:"body"`
}

// sendPortalMessage posts into a thread, from either end.
func (s *Server) sendPortalMessage(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req sendMessageRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "there is nothing to send")
		return
	}
	sid, err := uuid.Parse(strings.TrimSpace(req.StudentID))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}

	var parentID, teacherID uuid.UUID
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	if res.OwnsStudent(sid) {
		// The family writing to a teacher. The teacher has to be one of the
		// child's, checked against the same set the address book lists.
		parentID = id.UserID
		if teacherID, err = uuid.Parse(strings.TrimSpace(req.TeacherID)); err != nil {
			httpx.BadRequest(w, r, "teacher_user_id must be a uuid")
			return
		}
		reachable, err := s.reachableTeachers(r, sid)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		found := false
		for _, t := range reachable {
			if t.UserID == teacherID.String() {
				found = true
				break
			}
		}
		if !found {
			httpx.Denied(w, r, "you can only write to the staff who teach your child")
			return
		}
	} else {
		// The teacher replying. They must teach the child, and the parent named
		// must actually be that child's guardian — otherwise a teacher could
		// open a thread against any user in the school.
		teacherID = id.UserID
		if parentID, err = uuid.Parse(strings.TrimSpace(req.ParentID)); err != nil {
			httpx.BadRequest(w, r, "parent_user_id must be a uuid")
			return
		}
		ok, err := s.teacherMayWrite(r, sid, teacherID, parentID)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if !ok {
			httpx.NotFound(w, r)
			return
		}
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO parent_teacher_messages
			    (institution_id, student_id, parent_user_id, teacher_user_id,
			     sender_user_id, body)
			VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING id::text`,
			id.InstitutionID, sid, parentID, teacherID, id.UserID,
			strings.TrimSpace(req.Body)).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// teacherMayWrite checks the staff end of a thread in one query: the caller
// teaches the child, and the named parent is a guardian of that same child.
func (s *Server) teacherMayWrite(r *http.Request, sid, teacherID, parentID uuid.UUID) (bool, error) {
	id := httpx.IdentityFrom(r.Context())
	var ok bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			    SELECT 1 FROM enrollments e
			     WHERE e.student_id = $1 AND e.status = 'active'
			       AND (
			         EXISTS (SELECT 1 FROM sections sec
			                  WHERE sec.id = e.section_id AND sec.class_teacher_id = $2)
			      OR EXISTS (SELECT 1 FROM section_subject_teachers sst
			                  WHERE sst.section_id = e.section_id AND sst.teacher_user_id = $2)
			      OR EXISTS (SELECT 1 FROM timetable_entries te
			                  WHERE te.section_id = e.section_id AND te.teacher_user_id = $2)))
			AND EXISTS (
			    SELECT 1 FROM student_guardians sg
			      JOIN guardians g ON g.id = sg.guardian_id
			     WHERE sg.student_id = $1 AND g.user_id = $3)`,
			sid, teacherID, parentID).Scan(&ok)
	})
	return ok, err
}

// --- fee receipts ------------------------------------------------------------

type portalReceiptRow struct {
	PaymentID string  `json:"payment_id"`
	ReceiptNo string  `json:"receipt_no"`
	StudentID string  `json:"student_id"`
	Student   string  `json:"student_name"`
	Amount    int64   `json:"amount_paise"`
	Mode      string  `json:"mode"`
	Status    string  `json:"status"`
	PaidOn    string  `json:"paid_on"`
	Reference *string `json:"reference_no,omitempty"`
}

/*
listPortalReceipts powers parent.fees.digital_fee_receipt_pdf_download.

	Only settled money. A cheque that has been handed over but not cleared, or
	one that has bounced, is not a receipt the family can show anybody, and
	printing it as one is how a parent ends up at the counter insisting a
	bounced cheque was paid.
*/
func (s *Server) listPortalReceipts(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []portalReceiptRow{}})
		return
	}
	items, err := collect(s, r, `
		SELECT p.id::text, COALESCE(p.receipt_no,'—'), p.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       p.amount_paise, p.mode, p.status,
		       to_char(p.paid_on,'YYYY-MM-DD'), p.reference_no
		  FROM payments p
		  JOIN students st ON st.id = p.student_id
		 WHERE p.student_id = ANY($1) AND p.status = 'success'
		 ORDER BY p.paid_on DESC, p.created_at DESC
		 LIMIT 200`, []any{res.StudentIDs},
		func(rows pgx.Rows) (portalReceiptRow, error) {
			var v portalReceiptRow
			return v, rows.Scan(&v.PaymentID, &v.ReceiptNo, &v.StudentID, &v.Student,
				&v.Amount, &v.Mode, &v.Status, &v.PaidOn, &v.Reference)
		})
	respond(w, r, items, err)
}

/*
getPortalReceipt renders one receipt for the family that paid it.

	getReceipt in internal/api/fees.go answers the same question for the
	counter, and is gated on payments.read — which no parent holds and none
	should, because it is the permission to read every payment in the school.
	This is the family's path to the same document: same shape, so one printable
	component serves both, but reached by owning the child rather than by
	holding a back-office permission.

	The ownership test is a predicate in the query and not a check around it. A
	receipt belonging to another family returns no rows and therefore a 404,
	which is the same answer as a receipt that does not exist.
*/
func (s *Server) getPortalReceipt(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	paymentID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid payment id")
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.NotFound(w, r)
		return
	}

	out := map[string]any{}
	lines := []map[string]any{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			receiptNo, mode, status, studentName, admissionNo, instName string
			amount                                                      int64
			paidOn                                                      time.Time
			className, sectionName, reference                           *string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(p.receipt_no,'—'), p.amount_paise, p.mode, p.status, p.paid_on,
			       p.reference_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.admission_no, i.name, c.name, sec.name
			  FROM payments p
			  JOIN students st    ON st.id = p.student_id
			  JOIN institutions i ON i.id = p.institution_id
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id FROM enrollments e
			       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
			  ) en ON true
			  LEFT JOIN classes  c   ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE p.id = $1 AND p.student_id = ANY($2) AND p.status = 'success'`,
			paymentID, res.StudentIDs).
			Scan(&receiptNo, &amount, &mode, &status, &paidOn, &reference,
				&studentName, &admissionNo, &instName, &className, &sectionName); err != nil {
			return err
		}

		out["receipt_no"] = receiptNo
		out["amount_paise"] = amount
		out["amount_words"] = fees.RupeesInWords(amount)
		out["mode"] = mode
		out["status"] = status
		out["paid_on"] = paidOn.Format(time.DateOnly)
		out["reference_no"] = reference
		out["student_name"] = studentName
		out["admission_no"] = admissionNo
		out["institution"] = instName
		out["class_name"] = className
		out["section_name"] = sectionName
		out["financial_year"] = fees.FinancialYear(paidOn)

		// Who took the money is on the counter's copy and not on the family's.
		// It is a staff member's name, and the family needs the receipt number
		// to query a payment, not the clerk's.
		return scanInto(r.Context(), tx, `
			SELECT i.invoice_no, pa.amount_paise,
			       COALESCE(string_agg(DISTINCT fh.name, ', '), 'Fee')
			  FROM payment_allocations pa
			  JOIN invoices i ON i.id = pa.invoice_id
			  LEFT JOIN invoice_lines il ON il.invoice_id = i.id
			  LEFT JOIN fee_heads fh ON fh.id = il.fee_head_id
			 WHERE pa.payment_id = '`+paymentID.String()+`'::uuid
			 GROUP BY i.invoice_no, pa.amount_paise`,
			func(rows pgx.Rows) error {
				var invoiceNo, heads string
				var amt int64
				if err := rows.Scan(&invoiceNo, &amt, &heads); err != nil {
					return err
				}
				lines = append(lines, map[string]any{
					"invoice_no": invoiceNo, "amount_paise": amt, "particulars": heads,
				})
				return nil
			})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out["lines"] = lines
	httpx.JSON(w, http.StatusOK, out)
}

// --- certificate requests and documents --------------------------------------

type requestTypeRow struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
	// Whether the office has to approve before it is issued. The screen says so
	// rather than leaving the family to wonder why nothing has arrived.
	NeedsApproval bool `json:"requires_approval"`
}

// listPortalRequestTypes lists what the school is willing to issue.
//
// The office's own certificate endpoint creates a type on first use so setup
// cannot block it. This one deliberately does not: a family inventing a
// certificate type would be writing to a configuration table through the
// portal, and the office would find categories nobody defined.
func (s *Server) listPortalRequestTypes(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, code, name, requires_approval
		  FROM certificate_types ORDER BY name`, nil,
		func(rows pgx.Rows) (requestTypeRow, error) {
			var v requestTypeRow
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.NeedsApproval)
		})
	respond(w, r, items, err)
}

type portalRequestRow struct {
	ID        string  `json:"id"`
	StudentID string  `json:"student_id"`
	Student   string  `json:"student_name"`
	Serial    string  `json:"serial_no"`
	Type      string  `json:"type"`
	Code      string  `json:"code"`
	Status    string  `json:"status"`
	IssuedOn  string  `json:"issued_on"`
	Reason    *string `json:"reason,omitempty"`
	// Set once the office has attached the signed PDF; until then the family
	// has a request and not a certificate.
	HasFile bool `json:"has_file"`
}

// listPortalRequests powers student.requests.requests.
func (s *Server) listPortalRequests(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []portalRequestRow{}})
		return
	}
	items, err := collect(s, r, `
		SELECT ic.id::text, ic.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       ic.serial_no, ct.name, ct.code, ic.status,
		       to_char(ic.issued_on,'YYYY-MM-DD'),
		       ic.snapshot->>'reason', ic.pdf_file_id IS NOT NULL
		  FROM issued_certificates ic
		  JOIN certificate_types ct ON ct.id = ic.certificate_type_id
		  JOIN students st ON st.id = ic.student_id
		 WHERE ic.student_id = ANY($1)
		 ORDER BY ic.created_at DESC
		 LIMIT 100`, []any{res.StudentIDs},
		func(rows pgx.Rows) (portalRequestRow, error) {
			var v portalRequestRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.Serial, &v.Type,
				&v.Code, &v.Status, &v.IssuedOn, &v.Reason, &v.HasFile)
		})
	respond(w, r, items, err)
}

type portalRequestBody struct {
	StudentID string `json:"student_id,omitempty"`
	TypeCode  string `json:"type_code"`
	Reason    string `json:"reason"`
}

var errRequestPending = errors.New("that certificate is already on order")

/*
raisePortalRequest asks the office for a certificate.

	status is 'requested' and never 'issued'. The office's own endpoint issues
	immediately because a clerk pressing the button has already decided; a
	family has not, and a portal that could issue its own transfer certificate
	would let a parent mark their child as having left the school — the office
	handler does exactly that as a side effect of a TC.

	The serial is allocated now rather than at issue, from the same counter the
	office uses, so a request and the certificate it becomes carry one number
	that the family can quote on the telephone.
*/
func (s *Server) raisePortalRequest(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req portalRequestBody
	if !httpx.Decode(w, r, &req) {
		return
	}
	_, sid, err := s.portalChild(r, req.StudentID)
	if denyChild(w, r, err) {
		return
	}
	if strings.TrimSpace(req.TypeCode) == "" {
		httpx.BadRequest(w, r, "say which certificate you need")
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "say what it is for — the office writes the purpose on it")
		return
	}

	var serial string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var typeID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT id FROM certificate_types WHERE code = $1`,
			strings.TrimSpace(req.TypeCode)).Scan(&typeID); err != nil {
			return err
		}

		// One open request per child per type. Without this a family refreshing
		// the page puts three identical requests in the office's queue and
		// burns three serial numbers doing it.
		var pending bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			    SELECT 1 FROM issued_certificates
			     WHERE student_id = $1 AND certificate_type_id = $2
			       AND status IN ('requested','approved'))`, sid, typeID).Scan(&pending); err != nil {
			return err
		}
		if pending {
			return errRequestPending
		}

		var err error
		if serial, err = fees.NextNumber(r.Context(), tx, id.InstitutionID, "certificate"); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO issued_certificates
			    (institution_id, certificate_type_id, student_id, serial_no,
			     issued_on, snapshot, status, requested_by)
			VALUES ($1,$2,$3,$4,CURRENT_DATE,
			        jsonb_build_object('reason', $5::text, 'requested_at', now()),
			        'requested',$6)`,
			id.InstitutionID, typeID, sid, serial, strings.TrimSpace(req.Reason), id.UserID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.BadRequest(w, r, "the school does not issue that certificate")
		return
	}
	if errors.Is(err, errRequestPending) {
		httpx.Error(w, r, http.StatusConflict, "already_requested",
			"you have already asked for that one and the office has not finished with it")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"serial_no": serial, "status": "requested",
	})
}

type portalDocumentRow struct {
	ID         string  `json:"id"`
	StudentID  string  `json:"student_id"`
	Student    string  `json:"student_name"`
	DocType    string  `json:"doc_type"`
	Name       string  `json:"file_name"`
	SizeBytes  int64   `json:"size_bytes"`
	UploadedOn string  `json:"uploaded_on"`
	Verified   bool    `json:"verified"`
	VerifiedBy *string `json:"verified_by,omitempty"`
	Notes      *string `json:"notes,omitempty"`
}

/*
listPortalDocuments powers student.requests.documents.

	What the school holds on file for the child — the birth certificate, the
	Aadhaar copy, the previous school's transfer certificate — and whether the
	office has checked it. A family that cannot see this rings to ask whether a
	document arrived, which is most of what the front desk's telephone is for.

	It lists what is held, not the bytes. Handing out a download link means
	presigning R2 object keys, and doing that from a family endpoint deserves
	its own review rather than being folded into a list handler; deleted files
	are excluded so the list never offers something that is already gone.
*/
func (s *Server) listPortalDocuments(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []portalDocumentRow{}})
		return
	}
	items, err := collect(s, r, `
		SELECT d.id::text, d.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       d.doc_type, f.original_name, f.size_bytes,
		       to_char(d.created_at,'YYYY-MM-DD'),
		       d.verified_at IS NOT NULL, u.full_name, d.notes
		  FROM student_documents d
		  JOIN students st ON st.id = d.student_id
		  JOIN files f ON f.id = d.file_id
		  LEFT JOIN users u ON u.id = d.verified_by
		 WHERE d.student_id = ANY($1) AND f.deleted_at IS NULL
		 ORDER BY d.created_at DESC
		 LIMIT 200`, []any{res.StudentIDs},
		func(rows pgx.Rows) (portalDocumentRow, error) {
			var v portalDocumentRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.DocType, &v.Name,
				&v.SizeBytes, &v.UploadedOn, &v.Verified, &v.VerifiedBy, &v.Notes)
		})
	respond(w, r, items, err)
}
