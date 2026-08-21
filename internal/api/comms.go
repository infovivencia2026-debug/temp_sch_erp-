package api

/*
Four communication features, and one rule they all turn on: who is allowed to
read this.

	 institution_admin.communication.parent_feedback_grievance_hub
	 institution_admin.communication.school_achievements_showcase
	 parent.school_life.ptm_appointment_reminder_alert
	 parent.messages.private_counselor_chat_channel

	Three of the four are about restricting a readership rather than producing
	one, and each restricts it differently:

	  a grievance about a member of staff is hidden from that member of staff,
	  by a predicate on every staff-facing query;

	  a child's name and photograph reach the portal only once somebody has
	  recorded that the family agreed, enforced by a CHECK as well as here;

	  a counselling thread is readable by an explicit list of people and by
	  nobody else -- not the class teacher, not the head of department, not the
	  principal, and not a future holder of welfare.counseling.read.

	The fourth, the PTM reminder, adds no storage at all: message_trigger_rules
	(00044) already is the rule and appointments (00035) already is the
	booking, so the feature is one emit at the moment a slot is taken. See
	emitPTMReminder at the foot of this file, and the dispatch gap noted there.

	No permission is invented. The grievance queue runs on the front desk's
	rungs, the showcase on students.write to record and comms.announcements.write
	to publish, and the counselling channel on no permission at all beyond
	being signed in -- because a permission is exactly the thing that must not
	be able to open it.
*/

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
mountComms wires all four features onto the authenticated /api/v1 router.

	Mounted by the integrator with a bare s.mountComms(r) inside the signed-in
	group in api.go, which this worker does not edit. Every route below names
	its full path and carries its own permission, so it does not matter which
	group it lands in as long as that group requires authentication.

	The two portal routes are deliberately under /portal/comms rather than
	inside mountParentSchoolLife: that function belongs to another file, and a
	parent-facing route that needs the same self.profile.read gate can carry it
	itself.
*/
func (s *Server) mountComms(r chi.Router) {
	// --- the grievance hub, school side ---------------------------------
	r.Route("/comms/grievances", func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.FrontDeskRead))
		r.Get("/", s.listParentFeedback)
		r.Get("/summary", s.getFeedbackSummary)
		r.Get("/{id}", s.getParentFeedback)
		r.Get("/{id}/updates", s.listFeedbackUpdates)

		r.Group(func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.FrontDeskWrite))
			r.Put("/{id}/triage", s.triageParentFeedback)
			r.Post("/{id}/updates", s.addFeedbackUpdate)
			r.Post("/{id}/acknowledge", s.acknowledgeParentFeedback)
			r.Post("/{id}/escalate", s.escalateParentFeedback)
			r.Post("/{id}/resolve", s.resolveParentFeedback)
		})
	})

	// The SLA policy is a sibling of the queue, not a child of a case. Kept
	// off /comms/grievances/{id}'s path so that a category named "sla" could
	// never be mistaken for a ticket id.
	r.Route("/comms/grievance-sla", func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.FrontDeskRead))
		r.Get("/", s.listFeedbackSLA)
		r.With(httpx.RequirePermission(rbac.FrontDeskWrite)).Put("/", s.saveFeedbackSLA)
	})

	// --- the achievements showcase --------------------------------------
	r.Route("/comms/achievements", func(r chi.Router) {
		// Reading the register is reading a child's record.
		r.Use(httpx.RequirePermission(rbac.StudentsRead))
		r.Get("/", s.listShowcase)
		r.Get("/{id}", s.getShowcaseEntry)

		r.Group(func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.StudentsWrite))
			r.Post("/", s.createShowcaseEntry)
			r.Put("/{id}", s.updateShowcaseEntry)
			r.Delete("/{id}", s.deleteShowcaseEntry)
			r.Post("/{id}/media", s.addShowcaseMedia)
			r.Delete("/{id}/media/{mediaID}", s.removeShowcaseMedia)
			// Recording that the family agreed is part of keeping the child's
			// record. Acting on it is the next rung down.
			r.Post("/{id}/consent", s.recordShowcaseConsent)
		})

		// Putting a named child in front of every family in the school is
		// publishing, so it takes the publishing rung -- the same one a
		// circular takes -- and not the one that edits a record.
		r.Group(func(r chi.Router) {
			r.Use(httpx.RequirePermission(rbac.AnnouncementsWrite))
			r.Post("/{id}/publish", s.publishShowcaseEntry)
			r.Post("/{id}/unpublish", s.unpublishShowcaseEntry)
		})
	})

	// --- the counselling channel ----------------------------------------
	//
	// self.profile.read is the gate, which every signed-in account holds. That
	// is deliberate and is not the access control: the access control is a
	// live row in counselor_thread_participants, checked inside every handler
	// below. A route gated on welfare.counseling.read would mean a future
	// grant of that permission -- made so somebody could read case notes --
	// silently opened every family's thread as well.
	r.Route("/comms/counselor", func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.SelfProfileRead))
		r.Get("/contacts", s.listCounselorContacts)
		r.Get("/threads", s.listCounselorThreads)
		r.Post("/threads", s.openCounselorThread)
		r.Get("/threads/{id}", s.getCounselorThread)
		r.Get("/threads/{id}/messages", s.listCounselorMessages)
		r.Post("/threads/{id}/messages", s.postCounselorMessage)
		r.Get("/threads/{id}/participants", s.listCounselorParticipants)
		r.Post("/threads/{id}/participants", s.addCounselorParticipant)
		r.Post("/threads/{id}/participants/{userID}/remove", s.removeCounselorParticipant)
		r.Post("/threads/{id}/close", s.closeCounselorThread)
	})

	// --- what a family sees ---------------------------------------------
	r.Route("/go/communication", func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.SelfProfileRead))
		r.Get("/grievances/{id}", s.getPortalFeedback)
		r.Post("/grievances/{id}/satisfaction", s.rateFeedbackResolution)
		r.Get("/achievements", s.listPortalShowcase)
	})
}

// =====================================================================
// Grievance hub
// =====================================================================

/*
callerEmployeeID is the employee record behind the signed-in user, or nil.

	Every staff-facing grievance query needs it, because the one hard rule of
	this feature is that a complaint about a person is not shown to that
	person. A user with no employees row -- a parent, a platform operator --
	gets nil, which the queries treat as "excludes nothing", and that is
	correct: they cannot be the subject of a grievance.
*/
func callerEmployeeID(ctx context.Context, tx pgx.Tx, user uuid.UUID) (*uuid.UUID, error) {
	var out uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM employees WHERE user_id = $1`, user).Scan(&out)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

type feedbackRow struct {
	ID       string  `json:"id"`
	Student  *string `json:"student,omitempty"`
	RaisedBy string  `json:"raised_by"`
	Category string  `json:"category"`
	Subject  string  `json:"subject"`
	Priority string  `json:"priority"`
	Status   string  `json:"status"`
	// The department that owns it, and the person it is assigned to.
	Department *string `json:"department,omitempty"`
	AssignedTo *string `json:"assigned_to,omitempty"`
	// Whether this grievance names a member of staff. The name itself is not
	// in the list payload: the queue screen needs to know a case is sensitive
	// so it can mark it, and does not need to name the accused to do that.
	NamesStaff bool `json:"names_staff"`

	CreatedAt      string  `json:"created_at"`
	RespondDueAt   *string `json:"respond_due_at,omitempty"`
	ResolveDueAt   *string `json:"resolve_due_at,omitempty"`
	AcknowledgedAt *string `json:"acknowledged_at,omitempty"`
	ResolvedAt     *string `json:"resolved_at,omitempty"`
	Escalated      bool    `json:"escalated"`
	// Hours past the resolution deadline, negative while still in time. Null
	// when no SLA has been stamped, which is not the same as "on time".
	OverdueHours *int `json:"overdue_hours,omitempty"`
	OpenDays     int  `json:"open_days"`
	Satisfaction *int `json:"satisfaction,omitempty"`
}

/*
listParentFeedback is the office's queue.

	Two filters are not optional and are not driven by query parameters.

	audience = 'school' -- copied from the vendor side's own predicate in
	seller.go, which filters the other way. support_tickets carries both the
	family's complaint and the school's fault report to us, and a queue that
	forgot the distinction would show a parent's grievance about the canteen
	next to a bug report about invoicing.

	The subject_employee_id exclusion -- a member of staff must not read the
	complaint filed against them. It is a predicate rather than a check after
	the fact because a list endpoint that fetches and then filters is one
	refactor away from paginating before it filters.
*/
func (s *Server) listParentFeedback(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	// "Only the ones that have blown their deadline", which is the view a
	// principal opens on a Monday.
	overdueOnly := r.URL.Query().Get("overdue") == "true"

	out := []feedbackRow{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		me, err := callerEmployeeID(r.Context(), tx, id.UserID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT t.id::text,
			       NULLIF(concat_ws(' ', st.first_name, st.last_name), ''),
			       COALESCE(ru.full_name, 'Unknown'),
			       t.category, t.subject, t.priority, t.status,
			       t.owner_department, au.full_name,
			       t.subject_employee_id IS NOT NULL,
			       to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.respond_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.resolve_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.acknowledged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       t.escalated_at IS NOT NULL,
			       CASE WHEN t.resolve_due_at IS NULL THEN NULL
			            ELSE (EXTRACT(epoch FROM
			                 COALESCE(t.resolved_at, now()) - t.resolve_due_at) / 3600)::int
			       END,
			       EXTRACT(day FROM COALESCE(t.resolved_at, now()) - t.created_at)::int,
			       t.satisfaction
			  FROM support_tickets t
			  LEFT JOIN students st ON st.id = t.student_id
			  LEFT JOIN users ru ON ru.id = t.raised_by
			  LEFT JOIN users au ON au.id = t.assigned_to
			 WHERE t.audience = 'school'
			   -- The rule this feature exists to keep.
			   AND ($1::uuid IS NULL OR t.subject_employee_id IS NULL
			        OR t.subject_employee_id <> $1)
			   AND ($2::text = '' OR t.status = $2)
			   AND ($3::text = '' OR t.category = $3)
			   AND (NOT $4::boolean OR (t.resolve_due_at IS NOT NULL
			        AND t.resolved_at IS NULL AND t.resolve_due_at < now()))
			 ORDER BY t.resolve_due_at NULLS LAST, t.created_at
			 LIMIT 300`, me, status, category, overdueOnly)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v feedbackRow
			if err := rows.Scan(&v.ID, &v.Student, &v.RaisedBy, &v.Category, &v.Subject,
				&v.Priority, &v.Status, &v.Department, &v.AssignedTo, &v.NamesStaff,
				&v.CreatedAt, &v.RespondDueAt, &v.ResolveDueAt, &v.AcknowledgedAt,
				&v.ResolvedAt, &v.Escalated, &v.OverdueHours, &v.OpenDays,
				&v.Satisfaction); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type feedbackDetail struct {
	feedbackRow
	Body       string  `json:"body"`
	Resolution *string `json:"resolution,omitempty"`
	// Named only on the detail screen, and only to somebody who is not them.
	SubjectStaff   *string `json:"subject_staff,omitempty"`
	SatisfactionOn *string `json:"satisfaction_note,omitempty"`
}

// getParentFeedback is one case, with the same two predicates as the list.
//
// A member of staff asking for the id of a grievance about themselves gets 404
// and not 403: a refusal that distinguishes "not yours" from "does not exist"
// tells them a complaint has been filed, which is the fact being withheld.
func (s *Server) getParentFeedback(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ticket, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var v feedbackDetail
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		me, err := callerEmployeeID(r.Context(), tx, id.UserID)
		if err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			SELECT t.id::text,
			       NULLIF(concat_ws(' ', st.first_name, st.last_name), ''),
			       COALESCE(ru.full_name, 'Unknown'),
			       t.category, t.subject, t.priority, t.status,
			       t.owner_department, au.full_name,
			       t.subject_employee_id IS NOT NULL,
			       to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.respond_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.resolve_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.acknowledged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       t.escalated_at IS NOT NULL,
			       CASE WHEN t.resolve_due_at IS NULL THEN NULL
			            ELSE (EXTRACT(epoch FROM
			                 COALESCE(t.resolved_at, now()) - t.resolve_due_at) / 3600)::int
			       END,
			       EXTRACT(day FROM COALESCE(t.resolved_at, now()) - t.created_at)::int,
			       t.satisfaction,
			       t.body, t.resolution,
			       NULLIF(concat_ws(' ', se.first_name, se.last_name), ''),
			       t.satisfaction_note
			  FROM support_tickets t
			  LEFT JOIN students st ON st.id = t.student_id
			  LEFT JOIN users ru ON ru.id = t.raised_by
			  LEFT JOIN users au ON au.id = t.assigned_to
			  LEFT JOIN employees se ON se.id = t.subject_employee_id
			 WHERE t.id = $1 AND t.audience = 'school'
			   AND ($2::uuid IS NULL OR t.subject_employee_id IS NULL
			        OR t.subject_employee_id <> $2)`, ticket, me).
			Scan(&v.ID, &v.Student, &v.RaisedBy, &v.Category, &v.Subject,
				&v.Priority, &v.Status, &v.Department, &v.AssignedTo, &v.NamesStaff,
				&v.CreatedAt, &v.RespondDueAt, &v.ResolveDueAt, &v.AcknowledgedAt,
				&v.ResolvedAt, &v.Escalated, &v.OverdueHours, &v.OpenDays,
				&v.Satisfaction, &v.Body, &v.Resolution, &v.SubjectStaff,
				&v.SatisfactionOn)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, v)
	}
}

type feedbackUpdateRow struct {
	ID              string  `json:"id"`
	Kind            string  `json:"kind"`
	Body            string  `json:"body"`
	NewStatus       *string `json:"new_status,omitempty"`
	VisibleToParent bool    `json:"visible_to_parent"`
	Author          *string `json:"author,omitempty"`
	CreatedAt       string  `json:"created_at"`
}

// listFeedbackUpdates is the internal timeline: every entry, flagged.
func (s *Server) listFeedbackUpdates(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ticket, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	out := []feedbackUpdateRow{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		me, err := callerEmployeeID(r.Context(), tx, id.UserID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT g.id::text, g.kind, g.body, g.new_status, g.visible_to_parent,
			       u.full_name, to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM grievance_updates g
			  JOIN support_tickets t ON t.id = g.ticket_id
			  LEFT JOIN users u ON u.id = g.author_id
			 WHERE g.ticket_id = $1 AND t.audience = 'school'
			   -- The timeline is part of the case, so it carries the case's
			   -- exclusion. Without it the accused reads the complaint in the
			   -- notes about it.
			   AND ($2::uuid IS NULL OR t.subject_employee_id IS NULL
			        OR t.subject_employee_id <> $2)
			 ORDER BY g.created_at`, ticket, me)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v feedbackUpdateRow
			if err := rows.Scan(&v.ID, &v.Kind, &v.Body, &v.NewStatus,
				&v.VisibleToParent, &v.Author, &v.CreatedAt); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type feedbackTriageRequest struct {
	Category   string `json:"category,omitempty"`
	Priority   string `json:"priority,omitempty"`
	Department string `json:"department,omitempty"`
	AssignedTo string `json:"assigned_to,omitempty"`
	// The employee this grievance is about, if it is about somebody. Empty
	// leaves whatever is on the row; "none" clears it.
	SubjectEmployeeID string `json:"subject_employee_id,omitempty"`
	// Restamp the SLA from the (possibly new) category. Off by default: a
	// second triage pass should not silently give the office another week.
	RestampSLA bool `json:"restamp_sla,omitempty"`
}

var errFeedbackSelfRoute = errors.New(
	"this grievance is about that member of staff — it cannot be assigned to them")

/*
triageParentFeedback categorises a case and gives it an owner and a deadline.

	The refusal in the middle is the feature. A grievance naming a member of
	staff may not be assigned to that member of staff, however the assignment
	arrives -- through the default owner on the category's SLA policy, or
	typed by an administrator who has not read the case. Checked here, in the
	same transaction as the write, because a check on the screen is a check
	that a second caller of this endpoint does not perform.

	The SLA is stamped onto the ticket rather than derived on read. A school
	that shortens its promise in March must not retrospectively make every
	case it closed in February look late.
*/
func (s *Server) triageParentFeedback(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ticket, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req feedbackTriageRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Category = strings.TrimSpace(req.Category)
	if req.Category != "" && !concernCategories[req.Category] {
		httpx.BadRequest(w, r, "choose one of the listed categories")
		return
	}
	if req.Priority != "" && !feedbackPriorities[req.Priority] {
		httpx.BadRequest(w, r, "priority must be low, normal, high or urgent")
		return
	}
	var assignee, subjectEmp any
	if v := strings.TrimSpace(req.AssignedTo); v != "" {
		u, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "assigned_to must be a uuid")
			return
		}
		assignee = u
	}
	clearSubject := strings.TrimSpace(req.SubjectEmployeeID) == "none"
	if v := strings.TrimSpace(req.SubjectEmployeeID); v != "" && !clearSubject {
		e, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, `subject_employee_id must be a uuid, or "none" to clear it`)
			return
		}
		subjectEmp = e
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		me, err := callerEmployeeID(r.Context(), tx, id.UserID)
		if err != nil {
			return err
		}
		// Read the current row under the same exclusion as the reads, so an
		// accused member of staff cannot triage their own case out of the way.
		var category string
		var currentSubject *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT category, subject_employee_id
			  FROM support_tickets
			 WHERE id = $1 AND audience = 'school'
			   AND ($2::uuid IS NULL OR subject_employee_id IS NULL
			        OR subject_employee_id <> $2)
			 FOR UPDATE`, ticket, me).Scan(&category, &currentSubject); err != nil {
			return err
		}
		if req.Category != "" {
			category = req.Category
		}

		// Work out the subject after this call: cleared, replaced, or left.
		effective := currentSubject
		if clearSubject {
			effective = nil
		} else if subjectEmp != nil {
			e := subjectEmp.(uuid.UUID)
			effective = &e
		}

		// The policy for the category, if the school has written one.
		var respondHours, resolveHours *int
		var policyDept *string
		var policyOwner *uuid.UUID
		err = tx.QueryRow(r.Context(), `
			SELECT respond_hours, resolve_hours, owner_department, default_owner_id
			  FROM grievance_sla_policies
			 WHERE lower(category) = lower($1) AND is_active`, category).
			Scan(&respondHours, &resolveHours, &policyDept, &policyOwner)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		department := strings.TrimSpace(req.Department)
		if department == "" && policyDept != nil {
			department = *policyDept
		}
		if assignee == nil && policyOwner != nil {
			assignee = *policyOwner
		}

		// The refusal. Applies to the default owner the policy supplied just
		// as much as to one an administrator typed -- a category whose owner
		// is the head of department is exactly how a complaint about that
		// head of department would otherwise land on their own desk.
		if effective != nil && assignee != nil {
			var same bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM employees
				                WHERE id = $1 AND user_id = $2)`,
				*effective, assignee).Scan(&same); err != nil {
				return err
			}
			if same {
				return errFeedbackSelfRoute
			}
		}

		_, err = tx.Exec(r.Context(), `
			UPDATE support_tickets
			   SET category   = $2,
			       priority   = COALESCE(NULLIF($3,''), priority),
			       owner_department = NULLIF($4,''),
			       assigned_to = COALESCE($5, assigned_to),
			       subject_employee_id = CASE WHEN $6 THEN NULL ELSE COALESCE($7, subject_employee_id) END,
			       -- Stamped once, at first triage, unless explicitly restamped.
			       respond_due_at = CASE
			           WHEN $8::int IS NULL THEN respond_due_at
			           WHEN respond_due_at IS NULL OR $10 THEN created_at + make_interval(hours => $8)
			           ELSE respond_due_at END,
			       resolve_due_at = CASE
			           WHEN $9::int IS NULL THEN resolve_due_at
			           WHEN resolve_due_at IS NULL OR $10 THEN created_at + make_interval(hours => $9)
			           ELSE resolve_due_at END
			 WHERE id = $1 AND audience = 'school'`,
			ticket, category, req.Priority, department, assignee,
			clearSubject, subjectEmp, respondHours, resolveHours, req.RestampSLA)
		if err != nil {
			return err
		}
		return insertFeedbackUpdate(r.Context(), tx, id.InstitutionID, ticket,
			"assignment", fmt.Sprintf("Triaged as %s, owner %s", category,
				strOrDash(department)), nil, false, id.UserID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errFeedbackSelfRoute):
		httpx.Denied(w, r, err.Error())
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"triaged": true})
	}
}

// The priorities the office may set. Wider than concernRequest's, which
// deliberately refuses 'urgent' from a family: urgent is the office's to
// assign, and a queue where every complaint arrives urgent has no priority.
var feedbackPriorities = map[string]bool{
	"low": true, "normal": true, "high": true, "urgent": true,
}

// insertFeedbackUpdate writes one timeline entry. Shared by every write path
// so that no state change is possible without leaving a trace of itself.
func insertFeedbackUpdate(ctx context.Context, tx pgx.Tx, inst, ticket uuid.UUID,
	kind, body string, newStatus *string, visible bool, author uuid.UUID) error {

	_, err := tx.Exec(ctx, `
		INSERT INTO grievance_updates
		    (institution_id, ticket_id, kind, body, new_status, visible_to_parent, author_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		inst, ticket, kind, body, newStatus, visible, nullUUIDArg(author))
	return err
}

func strOrDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "unassigned"
	}
	return s
}

type feedbackUpdateRequest struct {
	Body string `json:"body"`
	// Whether the family sees this entry. Defaults to false, matching the
	// column: an internal note somebody forgot to flag must not be the one
	// quoted back at them.
	VisibleToParent bool   `json:"visible_to_parent,omitempty"`
	NewStatus       string `json:"new_status,omitempty"`
}

// addFeedbackUpdate appends to the timeline, and optionally moves the case.
func (s *Server) addFeedbackUpdate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ticket, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req feedbackUpdateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" {
		httpx.BadRequest(w, r, "an update needs something written in it")
		return
	}
	req.NewStatus = strings.TrimSpace(req.NewStatus)
	if req.NewStatus != "" && !feedbackOpenStatuses[req.NewStatus] {
		httpx.BadRequest(w, r,
			"status must be open, in_progress or waiting — use resolve to close a case")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		me, err := callerEmployeeID(r.Context(), tx, id.UserID)
		if err != nil {
			return err
		}
		var dummy uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT id FROM support_tickets
			 WHERE id = $1 AND audience = 'school'
			   AND ($2::uuid IS NULL OR subject_employee_id IS NULL
			        OR subject_employee_id <> $2)
			 FOR UPDATE`, ticket, me).Scan(&dummy); err != nil {
			return err
		}
		kind := "note"
		var newStatus *string
		if req.VisibleToParent {
			kind = "reply"
		}
		if req.NewStatus != "" {
			kind = "status"
			ns := req.NewStatus
			newStatus = &ns
			if _, err := tx.Exec(r.Context(), `
				UPDATE support_tickets SET status = $2 WHERE id = $1`,
				ticket, req.NewStatus); err != nil {
				return err
			}
		}
		// The first thing said to the family is the acknowledgement, whatever
		// it says. Stamped here rather than on a separate button because the
		// button nobody presses is the metric nobody can trust.
		if req.VisibleToParent {
			if _, err := tx.Exec(r.Context(), `
				UPDATE support_tickets SET acknowledged_at = COALESCE(acknowledged_at, now())
				 WHERE id = $1`, ticket); err != nil {
				return err
			}
		}
		return insertFeedbackUpdate(r.Context(), tx, id.InstitutionID, ticket,
			kind, req.Body, newStatus, req.VisibleToParent, id.UserID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"added": true})
	}
}

var feedbackOpenStatuses = map[string]bool{
	"open": true, "in_progress": true, "waiting": true,
}

// acknowledgeParentFeedback records that somebody has picked the case up.
//
// Separate from the first reply because a school that acknowledges by phone
// still needs the clock stopped, and COALESCE means pressing it twice does not
// move the first acknowledgement later.
func (s *Server) acknowledgeParentFeedback(w http.ResponseWriter, r *http.Request) {
	s.feedbackSimpleWrite(w, r, func(ctx context.Context, tx pgx.Tx,
		inst, ticket, user uuid.UUID) error {

		if _, err := tx.Exec(ctx, `
			UPDATE support_tickets
			   SET acknowledged_at = COALESCE(acknowledged_at, now()),
			       status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
			 WHERE id = $1`, ticket); err != nil {
			return err
		}
		return insertFeedbackUpdate(ctx, tx, inst, ticket, "status",
			"The school has picked this up and is looking into it.",
			ptrStr("in_progress"), true, user)
	})
}

type feedbackEscalateRequest struct {
	ToUserID string `json:"to_user_id"`
	Reason   string `json:"reason"`
}

// escalateParentFeedback raises a case above its owner.
//
// The same refusal as triage: a case cannot be escalated to the person it is
// about. Escalation is the most likely route for that to happen, because it is
// the one where somebody reaches for "the head of department" by reflex.
func (s *Server) escalateParentFeedback(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ticket, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req feedbackEscalateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	to, err := uuid.Parse(strings.TrimSpace(req.ToUserID))
	if err != nil {
		httpx.BadRequest(w, r, "to_user_id must be a uuid")
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if req.Reason == "" {
		httpx.BadRequest(w, r, "say why this is being escalated — it is the record of the decision")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		me, err := callerEmployeeID(r.Context(), tx, id.UserID)
		if err != nil {
			return err
		}
		var subject *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT subject_employee_id FROM support_tickets
			 WHERE id = $1 AND audience = 'school'
			   AND ($2::uuid IS NULL OR subject_employee_id IS NULL
			        OR subject_employee_id <> $2)
			 FOR UPDATE`, ticket, me).Scan(&subject); err != nil {
			return err
		}
		if subject != nil {
			var same bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM employees WHERE id = $1 AND user_id = $2)`,
				*subject, to).Scan(&same); err != nil {
				return err
			}
			if same {
				return errFeedbackSelfRoute
			}
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE support_tickets
			   SET escalated_at = now(), escalated_to = $2, priority = 'high'
			 WHERE id = $1`, ticket, to); err != nil {
			return err
		}
		return insertFeedbackUpdate(r.Context(), tx, id.InstitutionID, ticket,
			"escalation", req.Reason, nil, false, id.UserID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errFeedbackSelfRoute):
		httpx.Denied(w, r, err.Error())
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"escalated": true})
	}
}

type feedbackResolveRequest struct {
	Resolution string `json:"resolution"`
	// Whether the case is being shut outright or left resolved-but-open for
	// the family to accept. 'resolved' is the default; 'closed' is for cases
	// nobody is coming back to.
	Status string `json:"status,omitempty"`
}

// resolveParentFeedback writes the answer the family is owed.
//
// The resolution is always visible to the parent. A grievance resolved with
// an internal-only explanation is a case the family watches sit at "resolved"
// with nothing said to them, which is the complaint that follows the complaint.
func (s *Server) resolveParentFeedback(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ticket, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req feedbackResolveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Resolution = strings.TrimSpace(req.Resolution)
	if req.Resolution == "" {
		httpx.BadRequest(w, r, "a resolution needs to say what was done")
		return
	}
	status := "resolved"
	if req.Status == "closed" {
		status = "closed"
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		me, err := callerEmployeeID(r.Context(), tx, id.UserID)
		if err != nil {
			return err
		}
		var dummy uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT id FROM support_tickets
			 WHERE id = $1 AND audience = 'school'
			   AND ($2::uuid IS NULL OR subject_employee_id IS NULL
			        OR subject_employee_id <> $2)
			 FOR UPDATE`, ticket, me).Scan(&dummy); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE support_tickets
			   SET status = $2, resolution = $3, resolved_at = now(),
			       resolved_by = $4,
			       acknowledged_at = COALESCE(acknowledged_at, now())
			 WHERE id = $1`, ticket, status, req.Resolution, nullUUIDArg(id.UserID)); err != nil {
			return err
		}
		return insertFeedbackUpdate(r.Context(), tx, id.InstitutionID, ticket,
			"resolution", req.Resolution, &status, true, id.UserID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"status": status})
	}
}

// feedbackSimpleWrite factors the shape shared by the one-button state
// changes: parse the id, take the row under the exclusion, do the work.
func (s *Server) feedbackSimpleWrite(w http.ResponseWriter, r *http.Request,
	work func(ctx context.Context, tx pgx.Tx, inst, ticket, user uuid.UUID) error) {

	id := httpx.IdentityFrom(r.Context())
	ticket, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		me, err := callerEmployeeID(r.Context(), tx, id.UserID)
		if err != nil {
			return err
		}
		var dummy uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT id FROM support_tickets
			 WHERE id = $1 AND audience = 'school'
			   AND ($2::uuid IS NULL OR subject_employee_id IS NULL
			        OR subject_employee_id <> $2)
			 FOR UPDATE`, ticket, me).Scan(&dummy); err != nil {
			return err
		}
		return work(r.Context(), tx, id.InstitutionID, ticket, id.UserID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func ptrStr(s string) *string { return &s }

type feedbackPatternRow struct {
	Category string `json:"category"`
	// The three numbers a governing body asks for: how many, how long, how
	// many missed. Anything else is derivable from these on the screen.
	Total       int      `json:"total"`
	Open        int      `json:"open"`
	Breached    int      `json:"breached"`
	MedianDays  *float64 `json:"median_days,omitempty"`
	AvgFirstHrs *float64 `json:"avg_first_response_hours,omitempty"`
	Department  *string  `json:"department,omitempty"`
	// Mean satisfaction where the family gave one.
	AvgSatisfaction *float64 `json:"avg_satisfaction,omitempty"`
}

/*
getFeedbackSummary is the school-side value of the whole feature.

	Not a count of open tickets -- the queue already shows that. Which
	categories recur, which take longest, and which department is behind the
	ones that breach: the three questions that turn a complaints desk into
	something a school can act on before the next term.

	Carries the same subject exclusion as everything else. A head of department
	running the report must not be able to infer from a count of one in
	"staff / their department" that a complaint about them exists.
*/
func (s *Server) getFeedbackSummary(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	out := []feedbackPatternRow{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		me, err := callerEmployeeID(r.Context(), tx, id.UserID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT t.category,
			       count(*)::int,
			       count(*) FILTER (WHERE t.resolved_at IS NULL)::int,
			       count(*) FILTER (WHERE t.resolve_due_at IS NOT NULL
			                          AND COALESCE(t.resolved_at, now()) > t.resolve_due_at)::int,
			       percentile_cont(0.5) WITHIN GROUP (
			           ORDER BY EXTRACT(epoch FROM t.resolved_at - t.created_at) / 86400)
			           FILTER (WHERE t.resolved_at IS NOT NULL),
			       avg(EXTRACT(epoch FROM t.acknowledged_at - t.created_at) / 3600)
			           FILTER (WHERE t.acknowledged_at IS NOT NULL),
			       mode() WITHIN GROUP (ORDER BY t.owner_department),
			       avg(t.satisfaction::numeric) FILTER (WHERE t.satisfaction IS NOT NULL)
			  FROM support_tickets t
			 WHERE t.audience = 'school'
			   AND ($1::uuid IS NULL OR t.subject_employee_id IS NULL
			        OR t.subject_employee_id <> $1)
			   AND t.created_at >= now() - interval '365 days'
			 GROUP BY t.category
			 ORDER BY count(*) DESC`, me)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v feedbackPatternRow
			if err := rows.Scan(&v.Category, &v.Total, &v.Open, &v.Breached,
				&v.MedianDays, &v.AvgFirstHrs, &v.Department, &v.AvgSatisfaction); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type feedbackSLARow struct {
	Category     string  `json:"category"`
	Department   *string `json:"department,omitempty"`
	DefaultOwner *string `json:"default_owner,omitempty"`
	RespondHours int     `json:"respond_hours"`
	ResolveHours int     `json:"resolve_hours"`
	IsSensitive  bool    `json:"is_sensitive"`
	IsActive     bool    `json:"is_active"`
}

func (s *Server) listFeedbackSLA(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT p.category, p.owner_department, u.full_name,
		       p.respond_hours, p.resolve_hours, p.is_sensitive, p.is_active
		  FROM grievance_sla_policies p
		  LEFT JOIN users u ON u.id = p.default_owner_id
		 ORDER BY p.category`, nil,
		func(rows pgx.Rows) (feedbackSLARow, error) {
			var v feedbackSLARow
			return v, rows.Scan(&v.Category, &v.Department, &v.DefaultOwner,
				&v.RespondHours, &v.ResolveHours, &v.IsSensitive, &v.IsActive)
		})
	respond(w, r, items, err)
}

type feedbackSLARequest struct {
	Category     string `json:"category"`
	Department   string `json:"department,omitempty"`
	DefaultOwner string `json:"default_owner_id,omitempty"`
	RespondHours int    `json:"respond_hours"`
	ResolveHours int    `json:"resolve_hours"`
	IsSensitive  bool   `json:"is_sensitive,omitempty"`
	IsActive     *bool  `json:"is_active,omitempty"`
}

// saveFeedbackSLA writes one category's promise. Upsert on the unique index,
// so the screen has one button rather than a create and an edit that disagree.
func (s *Server) saveFeedbackSLA(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req feedbackSLARequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Category = strings.TrimSpace(req.Category)
	if !concernCategories[req.Category] {
		httpx.BadRequest(w, r, "choose one of the listed categories")
		return
	}
	if req.RespondHours <= 0 {
		req.RespondHours = 24
	}
	if req.ResolveHours <= 0 {
		req.ResolveHours = 168
	}
	if req.ResolveHours < req.RespondHours {
		httpx.BadRequest(w, r,
			"the resolution deadline cannot be sooner than the first-response one")
		return
	}
	var owner any
	if v := strings.TrimSpace(req.DefaultOwner); v != "" {
		u, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "default_owner_id must be a uuid")
			return
		}
		owner = u
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO grievance_sla_policies
			    (institution_id, category, owner_department, default_owner_id,
			     respond_hours, resolve_hours, is_sensitive, is_active)
			VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8)
			ON CONFLICT (institution_id, lower(category)) DO UPDATE
			   SET owner_department = EXCLUDED.owner_department,
			       default_owner_id = EXCLUDED.default_owner_id,
			       respond_hours    = EXCLUDED.respond_hours,
			       resolve_hours    = EXCLUDED.resolve_hours,
			       is_sensitive     = EXCLUDED.is_sensitive,
			       is_active        = EXCLUDED.is_active,
			       updated_at       = now()`,
			id.InstitutionID, req.Category, strings.TrimSpace(req.Department), owner,
			req.RespondHours, req.ResolveHours, req.IsSensitive, active)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

// --- what the family sees of their own grievance -----------------------------

/*
getPortalFeedback is one family's view of one case they filed.

	raised_by = the caller, and nothing else. Not "the caller's children":
	two guardians of one child are two complainants, and a mother raising a
	concern about a teacher has not agreed to the father reading it -- the
	reasoning listPortalConcerns already sets out and this endpoint keeps.

	The timeline is filtered on visible_to_parent, not on who is asking. A
	filter on the caller is one refactor away from being applied after the
	rows have been fetched; a filter on the flag is in the same predicate as
	the ownership check and cannot be separated from it.
*/
func (s *Server) getPortalFeedback(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ticket, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	type portalView struct {
		ID           string              `json:"id"`
		Category     string              `json:"category"`
		Subject      string              `json:"subject"`
		Body         string              `json:"body"`
		Status       string              `json:"status"`
		Department   *string             `json:"department,omitempty"`
		CreatedAt    string              `json:"created_at"`
		RespondDueAt *string             `json:"respond_due_at,omitempty"`
		ResolveDueAt *string             `json:"resolve_due_at,omitempty"`
		ResolvedAt   *string             `json:"resolved_at,omitempty"`
		Resolution   *string             `json:"resolution,omitempty"`
		Satisfaction *int                `json:"satisfaction,omitempty"`
		Timeline     []feedbackUpdateRow `json:"timeline"`
	}
	var v portalView
	v.Timeline = []feedbackUpdateRow{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT t.id::text, t.category, t.subject, t.body, t.status,
			       t.owner_department,
			       to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.respond_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.resolve_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       t.resolution, t.satisfaction
			  FROM support_tickets t
			 WHERE t.id = $1 AND t.raised_by = $2 AND t.audience = 'school'`,
			ticket, id.UserID).
			Scan(&v.ID, &v.Category, &v.Subject, &v.Body, &v.Status, &v.Department,
				&v.CreatedAt, &v.RespondDueAt, &v.ResolveDueAt, &v.ResolvedAt,
				&v.Resolution, &v.Satisfaction); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT g.id::text, g.kind, g.body, g.new_status, g.visible_to_parent,
			       u.full_name, to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM grievance_updates g
			  JOIN support_tickets t ON t.id = g.ticket_id
			  LEFT JOIN users u ON u.id = g.author_id
			 WHERE g.ticket_id = $1 AND g.visible_to_parent
			   AND t.raised_by = $2 AND t.audience = 'school'
			 ORDER BY g.created_at`, ticket, id.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var u feedbackUpdateRow
			if err := rows.Scan(&u.ID, &u.Kind, &u.Body, &u.NewStatus,
				&u.VisibleToParent, &u.Author, &u.CreatedAt); err != nil {
				return err
			}
			v.Timeline = append(v.Timeline, u)
		}
		return rows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, v)
	}
}

// rateFeedbackResolution records what the family thought of the answer.
//
// Only once, and only on a case that has one: rating an unresolved grievance
// is a complaint about the wait, which is what the timeline is for.
func (s *Server) rateFeedbackResolution(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ticket, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req struct {
		Rating int    `json:"rating"`
		Note   string `json:"note,omitempty"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Rating < 1 || req.Rating > 5 {
		httpx.BadRequest(w, r, "rating must be between 1 and 5")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE support_tickets
			   SET satisfaction = $3, satisfaction_note = NULLIF($4,''),
			       satisfaction_at = now()
			 WHERE id = $1 AND raised_by = $2 AND audience = 'school'
			   AND resolved_at IS NOT NULL AND satisfaction IS NULL`,
			ticket, id.UserID, req.Rating, strings.TrimSpace(req.Note))
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	case n == 0:
		// One answer for "not yours", "not resolved" and "already rated". The
		// first of those is the one that must not be distinguishable.
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"recorded": true})
	}
}

// =====================================================================
// Achievements showcase
// =====================================================================

type showcaseMediaRow struct {
	ID          string  `json:"id"`
	FileID      *string `json:"file_id,omitempty"`
	FileName    *string `json:"file_name,omitempty"`
	ExternalURL *string `json:"external_url,omitempty"`
	Caption     *string `json:"caption,omitempty"`
	SortOrder   int     `json:"sort_order"`
}

type showcaseRow struct {
	ID           string  `json:"id"`
	StudentID    string  `json:"student_id"`
	Student      string  `json:"student"`
	Class        *string `json:"class,omitempty"`
	Kind         string  `json:"kind"`
	Title        string  `json:"title"`
	Description  *string `json:"description,omitempty"`
	ShowcaseNote *string `json:"showcase_note,omitempty"`
	Level        *string `json:"level,omitempty"`
	Position     *string `json:"position,omitempty"`
	AwardedOn    *string `json:"awarded_on,omitempty"`

	IsPublished bool    `json:"is_published"`
	PublishedAt *string `json:"published_at,omitempty"`
	PublishedBy *string `json:"published_by,omitempty"`

	// The confirmation, surfaced so the screen can show why a publish button
	// is refused rather than simply refusing it.
	ConsentBasis *string `json:"consent_basis,omitempty"`
	ConsentBy    *string `json:"consent_confirmed_by,omitempty"`
	ConsentAt    *string `json:"consent_confirmed_at,omitempty"`

	MediaCount int                `json:"media_count"`
	Media      []showcaseMediaRow `json:"media,omitempty"`
}

// The columns every showcase read wants, written once. The quoted "position"
// is a reserved word in the baseline schema and must stay quoted.
const showcaseSelect = `
	SELECT a.id::text, a.student_id::text,
	       concat_ws(' ', st.first_name, st.last_name),
	       NULLIF(concat_ws('-', c.name, sec.name), ''),
	       a.kind, a.title, a.description, a.showcase_note, a.level, a."position",
	       to_char(a.awarded_on,'YYYY-MM-DD'),
	       a.is_published,
	       to_char(a.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
	       pu.full_name,
	       a.consent_basis, cu.full_name,
	       to_char(a.consent_confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
	       (SELECT count(*) FROM achievement_media m
	         WHERE m.achievement_id = a.id)::int
	  FROM student_achievements a
	  JOIN students st ON st.id = a.student_id
	  LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
	  LEFT JOIN sections sec ON sec.id = en.section_id
	  LEFT JOIN classes c ON c.id = sec.class_id
	  LEFT JOIN users pu ON pu.id = a.published_by
	  LEFT JOIN users cu ON cu.id = a.consent_confirmed_by`

func scanShowcase(rows pgx.Rows) (showcaseRow, error) {
	var v showcaseRow
	return v, rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.Class, &v.Kind, &v.Title,
		&v.Description, &v.ShowcaseNote, &v.Level, &v.Position, &v.AwardedOn,
		&v.IsPublished, &v.PublishedAt, &v.PublishedBy, &v.ConsentBasis,
		&v.ConsentBy, &v.ConsentAt, &v.MediaCount)
}

// listShowcase is the school's own register: everything, published or not.
func (s *Server) listShowcase(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, showcaseSelect+`
		 WHERE ($1::text = '' OR a.kind = $1)
		   AND ($2::text = '' OR a.level = $2)
		   AND ($3::uuid IS NULL OR a.student_id = $3)
		   AND ($4::text = '' OR a.title ILIKE '%' || $4 || '%')
		 ORDER BY a.awarded_on DESC NULLS LAST, a.created_at DESC
		 LIMIT 300`,
		[]any{strings.TrimSpace(q.Get("kind")), strings.TrimSpace(q.Get("level")),
			filterUUID(q.Get("student_id")), strings.TrimSpace(q.Get("q"))},
		scanShowcase)
	respond(w, r, items, err)
}

// filterUUID turns an empty or malformed query parameter into a NULL the
// query treats as "no filter". Deliberately NOT optionalUUID (infirmary.go),
// which is for request bodies and rejects a malformed value: a stray character
// in a URL should narrow nothing, not fail the page.
func filterUUID(raw string) any {
	v, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil
	}
	return v
}

func (s *Server) getShowcaseEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var v showcaseRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), showcaseSelect+` WHERE a.id = $1`, entry)
		if err != nil {
			return err
		}
		if !rows.Next() {
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
			return pgx.ErrNoRows
		}
		v, err = scanShowcase(rows)
		rows.Close()
		if err != nil {
			return err
		}
		v.Media, err = loadShowcaseMedia(r.Context(), tx, entry)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, v)
	}
}

/*
loadShowcaseMedia reads the pictures attached to one achievement.

	The join onto files carries "AND f.deleted_at IS NULL" rather than putting
	it in the WHERE, so a soft-deleted file drops its row's file name without
	dropping the row: an administrator looking at the entry sees that a picture
	was attached and has since gone, which a silent disappearance would hide.
	The parent-facing reader below drops the row entirely instead.
*/
func loadShowcaseMedia(ctx context.Context, tx pgx.Tx, entry uuid.UUID) ([]showcaseMediaRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT m.id::text, m.file_id::text, f.original_name, m.external_url,
		       m.caption, m.sort_order
		  FROM achievement_media m
		  LEFT JOIN files f ON f.id = m.file_id AND f.deleted_at IS NULL
		 WHERE m.achievement_id = $1
		 ORDER BY m.sort_order, m.created_at`, entry)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []showcaseMediaRow{}
	for rows.Next() {
		var v showcaseMediaRow
		if err := rows.Scan(&v.ID, &v.FileID, &v.FileName, &v.ExternalURL,
			&v.Caption, &v.SortOrder); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

type showcaseRequest struct {
	StudentID    string `json:"student_id"`
	Kind         string `json:"kind,omitempty"`
	Title        string `json:"title"`
	Description  string `json:"description,omitempty"`
	ShowcaseNote string `json:"showcase_note,omitempty"`
	Level        string `json:"level,omitempty"`
	Position     string `json:"position,omitempty"`
	AwardedOn    string `json:"awarded_on,omitempty"`
}

// The two vocabularies are the baseline's CHECK constraints, restated so the
// endpoint answers "choose one of these" rather than surfacing a constraint
// name. They must not drift from 00001_baseline.sql.
var (
	showcaseKinds = map[string]bool{
		"award": true, "sport": true, "club": true, "activity": true,
		"competition": true, "position": true,
	}
	showcaseLevels = map[string]bool{
		"class": true, "school": true, "district": true, "state": true,
		"national": true, "international": true,
	}
)

/*
createShowcaseEntry is the write path student_achievements has never had.

	The table has existed since the baseline and is read in exactly one place
	-- getPortfolio -- with nothing anywhere in Go that inserts, updates or
	deletes a row. So this is not a new record; it is the first way to make one.

	It is created unpublished, always. There is no create-and-publish shortcut,
	because the confirmation that a family agreed to their child being named
	is a separate act by a separate person, and a shortcut is how it becomes a
	checkbox nobody reads.
*/
func (s *Server) createShowcaseEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req showcaseRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(strings.TrimSpace(req.StudentID))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		httpx.BadRequest(w, r, "an achievement needs a title")
		return
	}
	if req.Kind == "" {
		req.Kind = "award"
	}
	if !showcaseKinds[req.Kind] {
		httpx.BadRequest(w, r, "kind must be award, sport, club, activity, competition or position")
		return
	}
	if req.Level != "" && !showcaseLevels[req.Level] {
		httpx.BadRequest(w, r,
			"level must be class, school, district, state, national or international")
		return
	}
	awarded, err := optionalDate(req.AwardedOn)
	if err != nil {
		httpx.BadRequest(w, r, "awarded_on must be YYYY-MM-DD")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The child must be this school's. RLS proves the tenant but not that
		// a uuid typed into the form is a student at all.
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM students WHERE id = $1)`, student).
			Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return pgx.ErrNoRows
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO student_achievements
			    (institution_id, student_id, kind, title, description, showcase_note,
			     level, "position", awarded_on, recorded_by)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),
			        NULLIF($8,''),$9,$10)
			RETURNING id::text`,
			id.InstitutionID, student, req.Kind, req.Title,
			strings.TrimSpace(req.Description), strings.TrimSpace(req.ShowcaseNote),
			req.Level, strings.TrimSpace(req.Position), awarded,
			nullUUIDArg(id.UserID)).Scan(&out)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
	}
}

/*
updateShowcaseEntry amends an entry, and unpublishes it if the facts change.

	Editing the title or the child of something already on the parent portal
	means what was published is not what is now recorded. Rather than let the
	two diverge, a material edit withdraws it and it has to be published
	again -- which puts the confirmation back in front of somebody.
*/
func (s *Server) updateShowcaseEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req showcaseRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		httpx.BadRequest(w, r, "an achievement needs a title")
		return
	}
	if req.Kind != "" && !showcaseKinds[req.Kind] {
		httpx.BadRequest(w, r, "kind must be award, sport, club, activity, competition or position")
		return
	}
	if req.Level != "" && !showcaseLevels[req.Level] {
		httpx.BadRequest(w, r,
			"level must be class, school, district, state, national or international")
		return
	}
	awarded, err := optionalDate(req.AwardedOn)
	if err != nil {
		httpx.BadRequest(w, r, "awarded_on must be YYYY-MM-DD")
		return
	}

	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE student_achievements
			   SET kind          = COALESCE(NULLIF($2,''), kind),
			       title         = $3,
			       description   = NULLIF($4,''),
			       showcase_note = NULLIF($5,''),
			       level         = NULLIF($6,''),
			       "position"    = NULLIF($7,''),
			       awarded_on    = $8,
			       -- A change to what was published withdraws it. The pair
			       -- constraint requires both columns to move together.
			       is_published  = CASE WHEN title <> $3 THEN false ELSE is_published END,
			       published_at  = CASE WHEN title <> $3 THEN NULL ELSE published_at END,
			       published_by  = CASE WHEN title <> $3 THEN NULL ELSE published_by END
			 WHERE id = $1`,
			entry, req.Kind, req.Title, strings.TrimSpace(req.Description),
			strings.TrimSpace(req.ShowcaseNote), req.Level,
			strings.TrimSpace(req.Position), awarded)
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	case n == 0:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"updated": true})
	}
}

func (s *Server) deleteShowcaseEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// achievement_media cascades. The files themselves are not touched:
		// deleting the bytes because a caption was removed would take out an
		// image the school may have attached elsewhere.
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM student_achievements WHERE id = $1`, entry)
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	case n == 0:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
	}
}

type showcaseMediaRequest struct {
	FileID      string `json:"file_id,omitempty"`
	ExternalURL string `json:"external_url,omitempty"`
	Caption     string `json:"caption,omitempty"`
	SortOrder   int    `json:"sort_order,omitempty"`
}

/*
addShowcaseMedia attaches a photograph.

	Either a file_id minted by POST /api/v1/files/presign, or an external_url.
	The second is not a convenience: presign answers 503 storage_unconfigured
	on this deployment because object storage is not set up, and without the
	fallback the picture half of this feature would be unusable in production
	while looking finished. addSQAAEvidence takes the same pair for the same
	reason and this follows it deliberately.

	files.owner_type / owner_id are not written. Nothing in this codebase
	writes them, and a single caller populating dead columns would make them
	look load-bearing to whoever reads the schema next.
*/
func (s *Server) addShowcaseMedia(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req showcaseMediaRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.ExternalURL = strings.TrimSpace(req.ExternalURL)
	fileRef := strings.TrimSpace(req.FileID)
	if (fileRef == "") == (req.ExternalURL == "") {
		httpx.BadRequest(w, r,
			"attach exactly one of file_id (upload it first) or external_url")
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
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM student_achievements WHERE id = $1)`, entry).
			Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return pgx.ErrNoRows
		}
		// A soft-deleted file is not attachable. Checked rather than joined
		// away, so the caller is told why instead of getting a foreign key
		// error about a row that plainly exists.
		if fileArg != nil {
			var live bool
			if err := tx.QueryRow(r.Context(),
				`SELECT EXISTS (SELECT 1 FROM files WHERE id = $1 AND deleted_at IS NULL)`,
				fileArg).Scan(&live); err != nil {
				return err
			}
			if !live {
				return errors.New("that file has been deleted")
			}
		}
		err := tx.QueryRow(r.Context(), `
			INSERT INTO achievement_media
			    (institution_id, achievement_id, file_id, external_url, caption,
			     sort_order, added_by)
			VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7)
			RETURNING id::text`,
			id.InstitutionID, entry, fileArg, req.ExternalURL,
			strings.TrimSpace(req.Caption), req.SortOrder,
			nullUUIDArg(id.UserID)).Scan(&out)
		if isUniqueViolation(err) {
			return errors.New("that picture is already attached to this achievement")
		}
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
	}
}

func (s *Server) removeShowcaseMedia(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	media, err := uuid.Parse(chi.URLParam(r, "mediaID"))
	if err != nil {
		httpx.BadRequest(w, r, "mediaID must be a uuid")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Both ids in the predicate: a media id alone would let a caller
		// detach a picture from an achievement they were not looking at.
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM achievement_media WHERE id = $1 AND achievement_id = $2`,
			media, entry)
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	case n == 0:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"removed": true})
	}
}

type showcaseConsentRequest struct {
	// How permission was obtained. Not a boolean: "yes" with no account of
	// where the yes came from cannot be produced when a parent objects.
	Basis string `json:"basis"`
	Note  string `json:"note,omitempty"`
}

// The bases the school may record. staff_child is here because a member of
// staff's own child is the one case where the confirming user is the parent.
var showcaseConsentBases = map[string]bool{
	"admission_form": true, "signed_consent_form": true,
	"portal_confirmation": true, "recorded_verbal": true, "staff_child": true,
}

/*
recordShowcaseConsent is the explicit per-achievement confirmation.

	Worth stating plainly, because it is a decision and not an oversight: this
	codebase has NO media or photograph consent flag anywhere. The only consent
	columns in the whole schema are students.aadhaar_consent,
	admission_applications.aadhaar_consent, hostel_outpasses.guardian_consent_*
	and student_bank_accounts.dbt_consent_on. event_media.published_at is the
	nearest lever and it is per-photograph withdrawal, not per-child permission.

	Rather than add students.photo_consent -- a school-wide flag that every
	later feature would start trusting, defaulted by whoever imported the
	students, and never revisited -- the confirmation is recorded against the
	single act it authorises: publishing this achievement, with this child's
	name, with these pictures. Who confirmed it and when are stamped from the
	session, not accepted from the client.

	The integrator should note that a genuine consent register is still absent
	from this product. This is the narrow, honest version of it.
*/
func (s *Server) recordShowcaseConsent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req showcaseConsentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Basis = strings.TrimSpace(req.Basis)
	if !showcaseConsentBases[req.Basis] {
		httpx.BadRequest(w, r,
			"basis must be admission_form, signed_consent_form, portal_confirmation, "+
				"recorded_verbal or staff_child")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE student_achievements
			   SET consent_basis = $2, consent_confirmed_by = $3,
			       consent_confirmed_at = now()
			 WHERE id = $1`, entry, req.Basis, nullUUIDArg(id.UserID))
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	case n == 0:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"recorded": true})
	}
}

/*
publishShowcaseEntry puts a named child in front of every family in the school.

	The refusal is not decorative. student_achievements_publish_needs_consent
	would reject the UPDATE anyway; this checks first so the answer is a
	sentence a member of office staff can act on rather than a constraint name,
	and so the two can never disagree about which achievements are publishable.
*/
func (s *Server) publishShowcaseEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var missing bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var consentAt *time.Time
		if err := tx.QueryRow(r.Context(), `
			SELECT consent_confirmed_at FROM student_achievements
			 WHERE id = $1 FOR UPDATE`, entry).Scan(&consentAt); err != nil {
			return err
		}
		if consentAt == nil {
			missing = true
			return nil
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE student_achievements
			   SET is_published = true, published_at = now(), published_by = $2
			 WHERE id = $1`, entry, nullUUIDArg(id.UserID))
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	case missing:
		httpx.Denied(w, r,
			"record the family's confirmation before publishing this child's name and photograph")
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"published": true})
	}
}

// unpublishShowcaseEntry withdraws it. Always available and never refused: a
// family objecting must not have to wait for anybody's agreement.
func (s *Server) unpublishShowcaseEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE student_achievements
			   SET is_published = false, published_at = NULL, published_by = NULL
			 WHERE id = $1`, entry)
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	case n == 0:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"published": false})
	}
}

/*
listPortalShowcase is the parent-facing wall.

	Published entries only, which is the whole of the access decision: a
	school achievements showcase is by design something every family sees, so
	there is no per-family narrowing here beyond the publication flag and the
	tenant. What there IS, is the guarantee that nothing reaches this list
	without a recorded confirmation -- enforced by the CHECK on the table, not
	by this query remembering to ask.

	Soft-deleted files are excluded here rather than surfaced, the opposite of
	the administrator's view: a family has no use for a picture that is gone.
*/
func (s *Server) listPortalShowcase(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	type portalShowcaseRow struct {
		ID        string  `json:"id"`
		Student   string  `json:"student"`
		Class     *string `json:"class,omitempty"`
		Kind      string  `json:"kind"`
		Title     string  `json:"title"`
		Note      *string `json:"note,omitempty"`
		Level     *string `json:"level,omitempty"`
		Position  *string `json:"position,omitempty"`
		AwardedOn *string `json:"awarded_on,omitempty"`
		// True when the child is the caller's own, so the screen can lift the
		// family's own entries to the top. Not an access decision.
		IsMine bool               `json:"is_mine"`
		Media  []showcaseMediaRow `json:"media"`
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	mine := res.StudentIDs
	if mine == nil {
		mine = []uuid.UUID{}
	}

	out := []portalShowcaseRow{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT a.id::text,
			       concat_ws(' ', st.first_name, st.last_name),
			       NULLIF(concat_ws('-', c.name, sec.name), ''),
			       a.kind, a.title, COALESCE(a.showcase_note, a.description),
			       a.level, a."position", to_char(a.awarded_on,'YYYY-MM-DD'),
			       a.student_id = ANY($1::uuid[])
			  FROM student_achievements a
			  JOIN students st ON st.id = a.student_id
			  LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
			  LEFT JOIN sections sec ON sec.id = en.section_id
			  LEFT JOIN classes c ON c.id = sec.class_id
			 WHERE a.is_published
			 ORDER BY a.awarded_on DESC NULLS LAST, a.published_at DESC
			 LIMIT 200`, mine)
		if err != nil {
			return err
		}
		ids := []uuid.UUID{}
		byID := map[string]int{}
		for rows.Next() {
			var v portalShowcaseRow
			if err := rows.Scan(&v.ID, &v.Student, &v.Class, &v.Kind, &v.Title,
				&v.Note, &v.Level, &v.Position, &v.AwardedOn, &v.IsMine); err != nil {
				rows.Close()
				return err
			}
			v.Media = []showcaseMediaRow{}
			byID[v.ID] = len(out)
			out = append(out, v)
			if u, err := uuid.Parse(v.ID); err == nil {
				ids = append(ids, u)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		// One query for every album rather than one per entry: two hundred
		// achievements would otherwise be two hundred round trips on the
		// screen a school opens on prize day.
		mrows, err := tx.Query(r.Context(), `
			SELECT m.achievement_id::text, m.id::text, m.file_id::text,
			       f.original_name, m.external_url, m.caption, m.sort_order
			  FROM achievement_media m
			  LEFT JOIN files f ON f.id = m.file_id
			 WHERE m.achievement_id = ANY($1::uuid[])
			   -- A picture whose file has been soft-deleted is gone as far as
			   -- a family is concerned; an external_url row has no file at all
			   -- and stays.
			   AND (m.file_id IS NULL OR f.deleted_at IS NULL)
			 ORDER BY m.sort_order, m.created_at`, ids)
		if err != nil {
			return err
		}
		defer mrows.Close()
		for mrows.Next() {
			var owner string
			var v showcaseMediaRow
			if err := mrows.Scan(&owner, &v.ID, &v.FileID, &v.FileName,
				&v.ExternalURL, &v.Caption, &v.SortOrder); err != nil {
				return err
			}
			if i, ok := byID[owner]; ok {
				out[i].Media = append(out[i].Media, v)
			}
		}
		return mrows.Err()
	})
	respond(w, r, out, err)
}

// =====================================================================
// Private counsellor channel
// =====================================================================

var (
	errNotInThread  = errors.New("no such conversation")
	errObserverMute = errors.New(
		"an observer may read this conversation but not write in it")
)

/*
threadRole reports what the caller is in this thread, or errNotInThread.

	The single choke point of the whole feature. Every counsellor handler below
	begins here, and nothing else grants access -- not welfare.counseling.read,
	not being the child's class teacher, not holding institution.write, not
	being the principal. A platform administrator reaches these rows through
	RLS, which the tenancy policy grants and this cannot override; that is
	stated in the worker's report rather than hidden here.

	Returning the same error for "thread does not exist" and "you are not in
	it" is deliberate. A head of department who can distinguish the two learns
	that a family has opened a counselling thread, which is most of what they
	wanted to know.
*/
func threadRole(ctx context.Context, tx pgx.Tx, thread, user uuid.UUID) (string, error) {
	var role string
	err := tx.QueryRow(ctx, `
		SELECT p.role_in_thread
		  FROM counselor_thread_participants p
		  JOIN counselor_threads t ON t.id = p.thread_id
		 WHERE p.thread_id = $1 AND p.user_id = $2 AND p.removed_at IS NULL`,
		thread, user).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errNotInThread
	}
	return role, err
}

// logThreadAccess records an action against a thread, including refusals.
func logThreadAccess(ctx context.Context, tx pgx.Tx, inst, thread uuid.UUID,
	actor uuid.UUID, target *uuid.UUID, action, reason string) error {

	_, err := tx.Exec(ctx, `
		INSERT INTO counselor_access_events
		    (institution_id, thread_id, actor_id, target_id, action, reason)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6,''))`,
		inst, thread, nullUUIDArg(actor), target, action, reason)
	return err
}

type counselorThreadRow struct {
	ID        string `json:"id"`
	StudentID string `json:"student_id"`
	Student   string `json:"student"`
	Subject   string `json:"subject"`
	Status    string `json:"status"`
	Urgency   string `json:"urgency"`
	// What the caller is in this thread. Sent so the screen can hide the
	// composer from an observer; the server refuses them regardless.
	MyRole        string  `json:"my_role"`
	OpenedBy      string  `json:"opened_by"`
	CreatedAt     string  `json:"created_at"`
	LastMessageAt *string `json:"last_message_at,omitempty"`
	Unread        int     `json:"unread"`
	Participants  int     `json:"participants"`
}

/*
listCounselorThreads is every thread the caller is a live participant of.

	The join to counselor_thread_participants IS the filter -- there is no
	"and also show me the ones for my sections" limb, and adding one later
	would be the moment this feature stopped being what it says it is.
*/
func (s *Server) listCounselorThreads(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT t.id::text, t.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       t.subject, t.status, t.urgency, p.role_in_thread,
		       COALESCE(ou.full_name, 'Unknown'),
		       to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       to_char(t.last_message_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       (SELECT count(*) FROM counselor_messages m
		         WHERE m.thread_id = t.id
		           AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
		           AND m.sender_id <> p.user_id)::int,
		       (SELECT count(*) FROM counselor_thread_participants p2
		         WHERE p2.thread_id = t.id AND p2.removed_at IS NULL)::int
		  FROM counselor_thread_participants p
		  JOIN counselor_threads t ON t.id = p.thread_id
		  JOIN students st ON st.id = t.student_id
		  LEFT JOIN users ou ON ou.id = t.opened_by
		 WHERE p.user_id = $1 AND p.removed_at IS NULL
		 ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
		 LIMIT 200`,
		[]any{httpx.IdentityFrom(r.Context()).UserID},
		func(rows pgx.Rows) (counselorThreadRow, error) {
			var v counselorThreadRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.Student, &v.Subject,
				&v.Status, &v.Urgency, &v.MyRole, &v.OpenedBy, &v.CreatedAt,
				&v.LastMessageAt, &v.Unread, &v.Participants)
		})
	respond(w, r, items, err)
}

type counselorContactRow struct {
	UserID string  `json:"user_id"`
	Name   string  `json:"full_name"`
	Role   *string `json:"role,omitempty"`
}

/*
listCounselorContacts is the address book, and it is also the allow list.

	A family may open a thread with a member of staff who holds
	welfare.counseling.read -- the permission the counsellor role carries. The
	set is computed here and the same query backs the check on open, so a
	user_id typed by a client cannot enrol an arbitrary member of staff into a
	private conversation about a child.

	Note the direction carefully: holding welfare.counseling.read makes
	somebody ELIGIBLE TO BE ASKED. It does not give them sight of any existing
	thread. Those are different questions and this is the only place the
	permission is consulted at all.
*/
func (s *Server) listCounselorContacts(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT DISTINCT u.id::text, u.full_name, r.name
		  FROM users u
		  JOIN user_roles ur ON ur.user_id = u.id
		  JOIN roles r ON r.id = ur.role_id
		  JOIN role_permissions rp ON rp.role_id = r.id
		 WHERE u.institution_id = $1 AND u.status = 'active'
		   AND rp.permission_key = $2
		 ORDER BY u.full_name`,
		[]any{httpx.IdentityFrom(r.Context()).InstitutionID, rbac.CounselingRead},
		func(rows pgx.Rows) (counselorContactRow, error) {
			var v counselorContactRow
			return v, rows.Scan(&v.UserID, &v.Name, &v.Role)
		})
	respond(w, r, items, err)
}

type counselorThreadRequest struct {
	StudentID string `json:"student_id,omitempty"`
	// The member of staff the family wants to speak to, from
	// GET /comms/counselor/contacts.
	CounselorID string `json:"counselor_id"`
	// The guardian this thread is with, when a counsellor is the one opening
	// it. Ignored when a family opens their own -- they are the guardian.
	GuardianUserID string `json:"guardian_user_id,omitempty"`
	Subject        string `json:"subject"`
	Urgency        string `json:"urgency,omitempty"`
	// The first thing said, optional. Opening a thread and then having to
	// send a separate message is how a family gives up halfway.
	Message string `json:"message,omitempty"`
}

/*
openCounselorThread starts a private conversation about one child.

	Opened by the family. A counsellor may also open one, and the branch below
	handles both: what differs is which side has to prove the child is theirs.
	A guardian proves it through portalChild; a member of staff proves it by
	holding welfare.counseling.read, which is what makes them a counsellor at
	all.

	The thread is seeded with exactly two participants and no more. Everybody
	else -- including the head of department who supervises the counsellor --
	is an explicit later addition with a written reason attached.
*/
func (s *Server) openCounselorThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req counselorThreadRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Subject = strings.TrimSpace(req.Subject)
	if req.Subject == "" {
		httpx.BadRequest(w, r, "give the conversation a subject")
		return
	}
	if req.Urgency == "" {
		req.Urgency = "normal"
	}
	if req.Urgency != "routine" && req.Urgency != "normal" && req.Urgency != "urgent" {
		httpx.BadRequest(w, r, "urgency must be routine, normal or urgent")
		return
	}
	counselor, err := uuid.Parse(strings.TrimSpace(req.CounselorID))
	if err != nil {
		httpx.BadRequest(w, r, "counselor_id must be a uuid")
		return
	}

	/* Which side is opening it.

	   A counsellor opening a thread names the child and the guardian, and
	   proves nothing about the child beyond holding welfare.counseling.read --
	   which is the permission that makes them a counsellor and already carries
	   students.read.all in the seeded role.

	   A guardian opening one proves the child is theirs through portalChild,
	   and is themselves the parent side. They cannot name a different guardian:
	   a father adding a mother to a thread about a custody dispute is exactly
	   the case this refuses. */
	counsellorLed := id.Can(rbac.CounselingRead) && counselor == id.UserID

	var studentID, parentUser uuid.UUID
	if counsellorLed {
		sid, err := uuid.Parse(strings.TrimSpace(req.StudentID))
		if err != nil {
			httpx.BadRequest(w, r, "student_id must be a uuid")
			return
		}
		guardian, err := uuid.Parse(strings.TrimSpace(req.GuardianUserID))
		if err != nil {
			httpx.BadRequest(w, r,
				"guardian_user_id must be a uuid — a counselling thread has a family in it")
			return
		}
		studentID, parentUser = sid, guardian
	} else {
		_, sid, err := s.portalChild(r, req.StudentID)
		if denyChild(w, r, err) {
			return
		}
		studentID, parentUser = sid, id.UserID
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The named counsellor must actually be one. Without this the endpoint
		// would enrol any user in the school into a private thread about a
		// child, on nothing more than their id being typed into the form.
		var eligible bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			    SELECT 1 FROM users u
			      JOIN user_roles ur ON ur.user_id = u.id
			      JOIN role_permissions rp ON rp.role_id = ur.role_id
			     WHERE u.id = $1 AND u.institution_id = $2 AND u.status = 'active'
			       AND rp.permission_key = $3)`,
			counselor, id.InstitutionID, rbac.CounselingRead).Scan(&eligible); err != nil {
			return err
		}
		if !eligible {
			return errors.New("that member of staff is not a counsellor")
		}
		// A counsellor-led thread must name a guardian who is actually this
		// child's. Checked in SQL rather than trusted from the form, because
		// the alternative is a counsellor typing a user id and putting an
		// unrelated parent inside a confidential conversation about somebody
		// else's child.
		if counsellorLed {
			var linked bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (
				    SELECT 1 FROM student_guardians sg
				      JOIN guardians g ON g.id = sg.guardian_id
				     WHERE sg.student_id = $1 AND g.user_id = $2)`,
				studentID, parentUser).Scan(&linked); err != nil {
				return err
			}
			if !linked {
				return errors.New("that user is not a guardian of this child")
			}
		}

		var thread uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO counselor_threads
			    (institution_id, student_id, opened_by, subject, urgency)
			VALUES ($1,$2,$3,$4,$5)
			RETURNING id`,
			id.InstitutionID, studentID, nullUUIDArg(id.UserID), req.Subject, req.Urgency).
			Scan(&thread); err != nil {
			return err
		}
		out = thread.String()

		// Exactly two participants, and no more. Everybody else -- including
		// the head of department who supervises the counsellor -- is an
		// explicit later addition with a written reason attached.
		for _, p := range []struct {
			user uuid.UUID
			role string
		}{{parentUser, "parent"}, {counselor, "counselor"}} {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO counselor_thread_participants
				    (institution_id, thread_id, user_id, role_in_thread, added_by)
				VALUES ($1,$2,$3,$4,$5)
				ON CONFLICT DO NOTHING`,
				id.InstitutionID, thread, p.user, p.role, nullUUIDArg(id.UserID)); err != nil {
				return err
			}
		}
		if err := logThreadAccess(r.Context(), tx, id.InstitutionID, thread,
			id.UserID, &counselor, "opened", req.Subject); err != nil {
			return err
		}
		if body := strings.TrimSpace(req.Message); body != "" {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO counselor_messages (institution_id, thread_id, sender_id, body)
				VALUES ($1,$2,$3,$4)`,
				id.InstitutionID, thread, id.UserID, body); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE counselor_threads SET last_message_at = now(), updated_at = now()
				 WHERE id = $1`, thread); err != nil {
				return err
			}
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
	}
}

func (s *Server) getCounselorThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	thread, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var v counselorThreadRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		role, err := threadRole(r.Context(), tx, thread, id.UserID)
		if err != nil {
			return err
		}
		v.MyRole = role
		return tx.QueryRow(r.Context(), `
			SELECT t.id::text, t.student_id::text,
			       concat_ws(' ', st.first_name, st.last_name),
			       t.subject, t.status, t.urgency,
			       COALESCE(ou.full_name, 'Unknown'),
			       to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(t.last_message_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       (SELECT count(*) FROM counselor_thread_participants p2
			         WHERE p2.thread_id = t.id AND p2.removed_at IS NULL)::int
			  FROM counselor_threads t
			  JOIN students st ON st.id = t.student_id
			  LEFT JOIN users ou ON ou.id = t.opened_by
			 WHERE t.id = $1`, thread).
			Scan(&v.ID, &v.StudentID, &v.Student, &v.Subject, &v.Status,
				&v.Urgency, &v.OpenedBy, &v.CreatedAt, &v.LastMessageAt,
				&v.Participants)
	})
	s.answerCounselor(w, r, err, func() { httpx.JSON(w, http.StatusOK, v) })
}

// answerCounselor maps the shared error set to responses in one place, so that
// errNotInThread can never accidentally become a 403 in one handler and a 404
// in another -- the difference between them is itself a disclosure.
func (s *Server) answerCounselor(w http.ResponseWriter, r *http.Request,
	err error, ok func()) {

	switch {
	case errors.Is(err, errNotInThread), errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errObserverMute):
		httpx.Denied(w, r, err.Error())
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		ok()
	}
}

type counselorMessageRow struct {
	ID        string `json:"id"`
	Sender    string `json:"sender"`
	SenderID  string `json:"sender_id"`
	Mine      bool   `json:"mine"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
}

// listCounselorMessages reads the conversation, and marks it read.
func (s *Server) listCounselorMessages(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	thread, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	out := []counselorMessageRow{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := threadRole(r.Context(), tx, thread, id.UserID); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT m.id::text, COALESCE(u.full_name,'Unknown'), m.sender_id::text,
			       m.sender_id = $2, m.body,
			       to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM counselor_messages m
			  LEFT JOIN users u ON u.id = m.sender_id
			 WHERE m.thread_id = $1
			 ORDER BY m.created_at`, thread, id.UserID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v counselorMessageRow
			if err := rows.Scan(&v.ID, &v.Sender, &v.SenderID, &v.Mine, &v.Body,
				&v.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			out = append(out, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE counselor_thread_participants SET last_read_at = now()
			 WHERE thread_id = $1 AND user_id = $2 AND removed_at IS NULL`,
			thread, id.UserID)
		return err
	})
	s.answerCounselor(w, r, err, func() {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
	})
}

// postCounselorMessage writes into the thread. Participants only, observers
// excluded, and never into a thread somebody has closed.
func (s *Server) postCounselorMessage(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	thread, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req struct {
		Body string `json:"body"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" {
		httpx.BadRequest(w, r, "write something")
		return
	}
	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		role, err := threadRole(r.Context(), tx, thread, id.UserID)
		if err != nil {
			return err
		}
		if role == "observer" {
			return errObserverMute
		}
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM counselor_threads WHERE id = $1 FOR UPDATE`, thread).
			Scan(&status); err != nil {
			return err
		}
		if status == "closed" {
			return errors.New("this conversation has been closed")
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO counselor_messages (institution_id, thread_id, sender_id, body)
			VALUES ($1,$2,$3,$4)
			RETURNING id::text`,
			id.InstitutionID, thread, id.UserID, req.Body).Scan(&out); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE counselor_threads SET last_message_at = now(), updated_at = now()
			 WHERE id = $1`, thread)
		return err
	})
	s.answerCounselor(w, r, err, func() {
		httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
	})
}

type counselorParticipantRow struct {
	UserID    string  `json:"user_id"`
	Name      string  `json:"full_name"`
	Role      string  `json:"role_in_thread"`
	AddedBy   *string `json:"added_by,omitempty"`
	Reason    *string `json:"added_reason,omitempty"`
	AddedAt   string  `json:"added_at"`
	RemovedAt *string `json:"removed_at,omitempty"`
}

/*
listCounselorParticipants shows the readership to the people in it.

	Including the ones who have left, and including the reason each was added.
	A parent must be able to see, without asking, that a safeguarding lead was
	brought into their conversation on the fourteenth and why -- because a
	readership that changes silently is not a private conversation, whatever
	the participant table says.
*/
func (s *Server) listCounselorParticipants(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	thread, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	out := []counselorParticipantRow{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := threadRole(r.Context(), tx, thread, id.UserID); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT p.user_id::text, COALESCE(u.full_name,'Unknown'), p.role_in_thread,
			       au.full_name, p.added_reason,
			       to_char(p.added_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(p.removed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM counselor_thread_participants p
			  LEFT JOIN users u ON u.id = p.user_id
			  LEFT JOIN users au ON au.id = p.added_by
			 WHERE p.thread_id = $1
			 ORDER BY p.added_at`, thread)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v counselorParticipantRow
			if err := rows.Scan(&v.UserID, &v.Name, &v.Role, &v.AddedBy,
				&v.Reason, &v.AddedAt, &v.RemovedAt); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	s.answerCounselor(w, r, err, func() {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
	})
}

type counselorParticipantRequest struct {
	UserID string `json:"user_id"`
	Role   string `json:"role_in_thread"`
	Reason string `json:"reason"`
}

/*
addCounselorParticipant widens the readership, deliberately and on the record.

	Three constraints, and each closes a route somebody would otherwise take.

	Only the counsellor may add anybody. Not the parent -- a guardian adding
	their spouse to a thread about a custody dispute is the case this feature
	exists for -- and not an observer, who would otherwise be able to bring in
	whomever they liked once let in themselves.

	A reason is required, always, not only for observers. The column's CHECK
	insists on one for observers; this insists for everybody, because "the
	counsellor added a second counsellor" with no account of why is the entry
	an investigation finds useless.

	A refused attempt is logged as loudly as a successful one. Somebody who
	tried and could not leaves no participant row at all, and that attempt is
	exactly what a later investigation asks about.
*/
func (s *Server) addCounselorParticipant(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	thread, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req counselorParticipantRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	target, err := uuid.Parse(strings.TrimSpace(req.UserID))
	if err != nil {
		httpx.BadRequest(w, r, "user_id must be a uuid")
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if req.Reason == "" {
		httpx.BadRequest(w, r,
			"say why this person is being given sight of a confidential conversation")
		return
	}
	if req.Role != "counselor" && req.Role != "observer" {
		httpx.BadRequest(w, r, "role_in_thread must be counselor or observer")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		role, err := threadRole(r.Context(), tx, thread, id.UserID)
		if err != nil {
			return err
		}
		if role != "counselor" {
			// Logged before the refusal is returned, in the same transaction,
			// so the record survives whatever the caller does next.
			if err := logThreadAccess(r.Context(), tx, id.InstitutionID, thread,
				id.UserID, &target, "access_refused",
				"only the counsellor may widen this thread"); err != nil {
				return err
			}
			return errors.New("only the counsellor in this conversation may add somebody to it")
		}
		// The person being added must be staff of this school. A guardian
		// cannot be added as a counsellor or an observer; the parent side of
		// the thread is set when it is opened and does not grow.
		var isStaff bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM employees e
			                WHERE e.user_id = $1 AND e.institution_id = $2)`,
			target, id.InstitutionID).Scan(&isStaff); err != nil {
			return err
		}
		if !isStaff {
			return errors.New("only a member of staff may be added to a counselling thread")
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO counselor_thread_participants
			    (institution_id, thread_id, user_id, role_in_thread, added_by, added_reason)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			id.InstitutionID, thread, target, req.Role,
			nullUUIDArg(id.UserID), req.Reason); err != nil {
			if isUniqueViolation(err) {
				return errors.New("that person is already in this conversation")
			}
			return err
		}
		return logThreadAccess(r.Context(), tx, id.InstitutionID, thread,
			id.UserID, &target, "participant_added", req.Reason)
	})
	s.answerCounselor(w, r, err, func() {
		httpx.JSON(w, http.StatusCreated, map[string]any{"added": true})
	})
}

// removeCounselorParticipant narrows the readership again.
//
// Soft, by stamping removed_at. Somebody who read the thread in March read it,
// and a DELETE would make the record say they never had access.
func (s *Server) removeCounselorParticipant(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	thread, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	target, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		httpx.BadRequest(w, r, "userID must be a uuid")
		return
	}
	var req struct {
		Reason string `json:"reason,omitempty"`
	}
	_ = httpx.Decode(w, r, &req)

	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		role, err := threadRole(r.Context(), tx, thread, id.UserID)
		if err != nil {
			return err
		}
		// A participant may always remove themselves. Otherwise only the
		// counsellor, on the same reasoning as adding.
		if target != id.UserID && role != "counselor" {
			return errors.New("only the counsellor in this conversation may remove somebody from it")
		}
		// The parent is not removable. A thread the family cannot read is a
		// record about them they have been shut out of, which is worse than
		// no thread at all; closing it is the honest end.
		tag, err := tx.Exec(r.Context(), `
			UPDATE counselor_thread_participants
			   SET removed_at = now(), removed_by = $3
			 WHERE thread_id = $1 AND user_id = $2 AND removed_at IS NULL
			   AND role_in_thread <> 'parent'`,
			thread, target, nullUUIDArg(id.UserID))
		n = tag.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return errors.New("that person is not a removable participant of this conversation")
		}
		return logThreadAccess(r.Context(), tx, id.InstitutionID, thread,
			id.UserID, &target, "participant_removed", strings.TrimSpace(req.Reason))
	})
	s.answerCounselor(w, r, err, func() {
		httpx.JSON(w, http.StatusOK, map[string]any{"removed": true})
	})
}

// closeCounselorThread ends the conversation. Either side may: a family must
// be able to stop a channel about their child without asking permission.
func (s *Server) closeCounselorThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	thread, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		role, err := threadRole(r.Context(), tx, thread, id.UserID)
		if err != nil {
			return err
		}
		if role == "observer" {
			return errObserverMute
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE counselor_threads
			   SET status = 'closed', closed_at = now(), closed_by = $2, updated_at = now()
			 WHERE id = $1 AND status = 'open'`, thread, nullUUIDArg(id.UserID)); err != nil {
			return err
		}
		return logThreadAccess(r.Context(), tx, id.InstitutionID, thread,
			id.UserID, nil, "thread_closed", "")
	})
	s.answerCounselor(w, r, err, func() {
		httpx.JSON(w, http.StatusOK, map[string]any{"closed": true})
	})
}

// =====================================================================
// PTM reminder
// =====================================================================

/*
emitPTMReminder queues the reminder for a meeting that has just been booked.

	Called from bookPTMSlot, inside its transaction, exactly as W6's
	notifyCovering is called from the substitution path. No table, no cron of
	its own, and no channel or template named here: the school's
	message_trigger_rules row on event 'ptm.upcoming' decides all of that, and
	a rule with lead_minutes = 15 produces the fifteen-minute alert the
	catalogue asks for. A rule at 1440 gives the day-before reminder from the
	same emit, which is the point of the trigger table.

	The reminder is scheduled, not sent. sendAtFor computes
	send_after = meeting time - lead_minutes and the row waits in message_log
	until then. What actually delivers it is DispatchMessages -- see the gap
	noted below.

	OccurrenceKey is the appointment id and not the slot id. Two families
	cannot hold the same slot (appointments_no_double_booking sees to that),
	but a cancelled and rebooked slot is legitimately two reminders, and
	keying on the slot would silently suppress the second.

	Errors are returned but the caller must not fail the booking on them: a
	school with no SMS account must still be able to book a meeting. See how
	bookPTMSlot treats the return.
*/
func (s *Server) emitPTMReminder(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	appt, student uuid.UUID, employee uuid.UUID, at time.Time,
	teacher, startText string) error {

	_, err := s.EmitMessageEvent(ctx, tx, inst, "ptm.upcoming", MessageSubject{
		StudentID:     &student,
		EmployeeID:    &employee,
		OccurrenceKey: appt.String(),
		At:            at,
		Facts: map[string]any{
			// What a rule's condition may narrow on: a school running its PTM
			// evening may want the reminder only for video sittings, or only
			// for meetings more than an hour away.
			"minutes_ahead": int(time.Until(at).Minutes()),
			"days_ahead":    int(time.Until(at).Hours() / 24),
		},
		Vars: map[string]any{
			"teacher": teacher,
			"time":    startText,
			"date":    at.Format("Mon 2 Jan"),
		},
	})
	return err
}

/*
dropPTMReminder withdraws a reminder for a meeting that is no longer happening.

	A DELETE rather than a status change, because message_log's status CHECK
	has no 'cancelled' value and marking it 'failed' would put a fault on the
	messaging screen for a message that was correctly never sent. Only queued
	rows are touched: one already sent is a thing the parent has read, and
	deleting it would remove the school's record of having told them.

	Deleting also re-opens the one-per-occurrence index, which is right --
	rebooking the same slot should produce a new reminder.
*/
func dropPTMReminder(ctx context.Context, tx pgx.Tx, inst, appt uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		DELETE FROM message_log
		 WHERE institution_id = $1 AND status = 'queued'
		   AND source_kind = 'trigger_rule' AND occurrence_key = $2`,
		inst, appt.String())
	return err
}

// ptmMomentOf combines a meeting's date and its time-of-day into an instant in
// the school's own timezone.
//
// starts_at is a Postgres `time` with no zone, which is correct -- "10:30 in
// the school's day" does not move with the server's TZ setting. Turning it
// into an instant is therefore the caller's job, and doing it in UTC would put
// every Indian reminder five and a half hours out.
func ptmMomentOf(onDate time.Time, startText string) time.Time {
	now := nowInIndia()
	hh, mm := 0, 0
	if _, err := fmt.Sscanf(startText, "%d:%d", &hh, &mm); err != nil {
		return onDate
	}
	return time.Date(onDate.Year(), onDate.Month(), onDate.Day(), hh, mm, 0, 0,
		now.Location())
}
