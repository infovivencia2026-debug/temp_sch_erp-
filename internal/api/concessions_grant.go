package api

import (
	"net/http"
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
	StudentID      string `json:"student_id"`
	AcademicYearID string `json:"academic_year_id"`
	FeeHeadID      string `json:"fee_head_id,omitempty"`
	Kind           string `json:"kind"`
	Percent        string `json:"percent,omitempty"`
	AmountPaise    *int64 `json:"amount_paise,omitempty"`
	Reason         string `json:"reason,omitempty"`
}

// The kinds the table's own CHECK allows. Listed here so a bad value is a 400
// naming the alternatives rather than a 500 from the constraint.
var concessionKinds = map[string]bool{
	"scholarship": true, "sibling": true, "staff_ward": true,
	"rte": true, "merit": true, "other": true,
}

func (s *Server) grantConcession(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req concessionGrantRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	student, err := uuid.Parse(strings.TrimSpace(req.StudentID))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	year, err := uuid.Parse(strings.TrimSpace(req.AcademicYearID))
	if err != nil {
		httpx.BadRequest(w, r, "academic_year_id must be a uuid")
		return
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
	if !concessionKinds[kind] {
		httpx.BadRequest(w, r,
			"kind must be one of scholarship, sibling, staff_ward, rte, merit, other")
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

	var newID uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO fee_concessions (institution_id, student_id, academic_year_id,
			        fee_head_id, kind, percent, amount_paise, reason, requested_by)
			-- Who asked, as against who decides. The decider has been recorded
			-- from the beginning; the person who raised it was nowhere, so the
			-- decision could not be sent back to them.
			VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::numeric,$7,NULLIF($8,''),$9)
			RETURNING id`,
			id.InstitutionID, student, year, head, kind, percent,
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
