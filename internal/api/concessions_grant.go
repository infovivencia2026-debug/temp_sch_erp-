package api

import (
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Granting a concession.

	fee_concessions was a table six files read and nothing could write. The
	discount book listed it, the approvals centre counted it, the fine engine
	exempted on it and the invoice generator discounted by it -- and there was
	no INSERT anywhere in the repository, so every one of those surfaces was
	reading a relation that could only ever be empty.

	Only the raise. Approval already exists and works -- decideConcession in
	mod_workflow.go stamps approved_by/approved_at, idempotently, and the
	approvals centre already routes to it. Adding a second approve endpoint
	here would have been a competing path for one decision, gated differently,
	which is how two screens start disagreeing about whether a waiver is
	signed off.

	A row lands unapproved, which is what the readers expect: listConcessions
	renders a blank approver, and fee_engine treats an unapproved row as not
	yet effective.
*/

type concessionGrantRequest struct {
	StudentID string `json:"student_id"`
	/* An APPLICANT, before there is a student to hang this on.

	   The fee is agreed as part of deciding whether to come at all — nobody
	   accepts a place and then finds out what it costs — so the waiver has to
	   exist before acceptance. Acceptance fills in student_id and leaves this
	   for the history. */
	ApplicationID  string `json:"application_id,omitempty"`
	AcademicYearID string `json:"academic_year_id"`
	FeeHeadID      string `json:"fee_head_id,omitempty"`
	Kind           string `json:"kind"`
	Percent        string `json:"percent,omitempty"`
	AmountPaise    *int64 `json:"amount_paise,omitempty"`
	Reason         string `json:"reason,omitempty"`
}

// The kinds the table's own CHECK allows. Listed here so a bad value is a 400
// naming the alternatives rather than a 500 from the constraint.
var concessionKinds = []string{
	"scholarship", "sibling", "staff_ward", "rte", "merit", "other",
	// Paying every term up front. Not who the family is, like the five above,
	// but how they pay -- and the one discount schools give that the list
	// could not name, so it was filed under "other" and could not be totalled
	// at the end of the year.
	"full_payment",
}

func concessionKindAllowed(k string) bool {
	return slices.Contains(concessionKinds, k)
}

func (s *Server) grantConcession(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req concessionGrantRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	/* One owner or the other, never both and never neither — the same rule
	   the CHECK constraint enforces, said here so the answer is a sentence
	   rather than a constraint name. */
	var student, application *uuid.UUID
	if v := strings.TrimSpace(req.StudentID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "student_id must be a uuid")
			return
		}
		student = &parsed
	}
	if v := strings.TrimSpace(req.ApplicationID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "application_id must be a uuid")
			return
		}
		application = &parsed
	}
	if student == nil && application == nil {
		httpx.BadRequest(w, r, "say which child or applicant this is for")
		return
	}
	/* THE CURRENT YEAR, WHEN NOBODY SAYS OTHERWISE.

	   It was required, and every caller had to fetch the academic years,
	   find the current one and send its id — for a fact the server already
	   knows and can only have one answer to. The admissions desk granting a
	   concession at the counter does not have that id to hand, and got
	   "academic_year_id must be a uuid" for a field its form never showed.

	   Still accepted explicitly, because backdating a concession to last year
	   is a real thing a school does when correcting a bill. */
	var year uuid.UUID
	if v := strings.TrimSpace(req.AcademicYearID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "academic_year_id must be a uuid")
			return
		}
		year = parsed
	} else {
		if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`SELECT id FROM academic_years WHERE is_current LIMIT 1`).Scan(&year)
		}); err != nil && student != nil {
			// An APPLICANT needs no year: they are not enrolled in one. It is
			// filled in at acceptance along with the student.
			/* A school with no current year cannot be billed at all, so this
			   is worth saying rather than failing on a uuid parse. */
			httpx.BadRequest(w, r,
				"no academic year is marked current — set one under Academics "+
					"before granting a concession")
			return
		}
	}
	var head *uuid.UUID
	if v := strings.TrimSpace(req.FeeHeadID); v != "" {
		h, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "fee_head_id must be a uuid")
			return
		}
		// Absent means the concession applies to the whole bill, which is what
		// a null fee_head_id means to the invoice generator.
		head = &h
	}
	kind := strings.TrimSpace(req.Kind)
	if !concessionKindAllowed(kind) {
		httpx.BadRequest(w, r,
			"kind must be one of "+strings.Join(concessionKinds, ", "))
		return
	}

	// The table requires one of the two, and refuses both being absent. Saying
	// so here is kinder than the constraint's own message.
	percent := strings.TrimSpace(req.Percent)
	if percent == "" && req.AmountPaise == nil {
		httpx.BadRequest(w, r, "give either a percent or an amount")
		return
	}
	if percent != "" && req.AmountPaise != nil {
		httpx.BadRequest(w, r,
			"give a percent or an amount, not both. Two discounts on one row cannot be applied unambiguously")
		return
	}
	if req.AmountPaise != nil && *req.AmountPaise < 0 {
		httpx.BadRequest(w, r, "amount cannot be negative")
		return
	}

	/* uuid.Nil is not NULL.

	   year is a value type, so an applicant with no year would insert
	   00000000-…-000000000000 into a nullable column — a foreign key to
	   nothing, which the constraint would refuse and which would read as a
	   real year if it did not. */
	var yearArg any
	if year != uuid.Nil {
		yearArg = year
	}

	var newID uuid.UUID
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO fee_concessions (institution_id, student_id, application_id,
			        academic_year_id, fee_head_id, kind, percent, amount_paise,
			        reason, requested_by)
			-- Who asked, as against who decides. The decider has been recorded
			-- from the beginning; the person who raised it was nowhere, so the
			-- decision could not be sent back to them.
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')::numeric,$8,NULLIF($9,''),$10)
			RETURNING id`,
			id.InstitutionID, student, application, yearArg, head, kind, percent,
			req.AmountPaise, strings.TrimSpace(req.Reason), id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

func (s *Server) mountConcessionGrant(r chi.Router) {
	/* RAISING IS NOT APPROVING, and admissions may raise.

	   The gate was fees.write, which admissions does not hold — so the desk
	   where a concession is actually agreed could not record one. A family
	   negotiates the staff-ward rate at admission, in front of the clerk
	   admitting the child; sending them to the accounts office to have it
	   typed in again is how it ends up on a sticky note instead.

	   Nothing about the approval changes. This endpoint writes a PENDING row
	   and can do nothing else: the decision is still fees.write, still the
	   principal's, and an admissions clerk cannot approve their own request.
	   The two permissions are the whole safeguard and they stay separate. */
	r.With(httpx.RequireAnyPermission(rbac.FeesWrite, rbac.AdmissionsWrite)).
		Post("/concessions", s.grantConcession)
}
