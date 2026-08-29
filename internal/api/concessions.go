package api

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Concessions, part three: money the state owes, money the child is owed, and
   paperwork for money neither of them has yet.

   Three catalogue features share this file because they share one noun — a
   government scheme — and because separating them would give a school three
   registries of the same list of schemes to keep in step by hand.

   ---- Government reimbursement claims ------------------------------------

   A private school admitting children in the RTE 25% quota claims a per-child
   reimbursement from the state at a notified rate, usually quarterly. Every
   part of that sentence is a column somewhere, but the feature is none of
   them. The feature is the gap.

     claimed    what the school asked for, per child, at the rate in force
     sanctioned what the department's order actually approved, per child
     received   what the treasury actually released, per claim

   Schools routinely carry two years of the difference and do not know it,
   because the claim is a photocopied form in a file and the receipt is a line
   on a bank statement nobody tied back to it. So the three figures never
   collapse into one, the ageing is computed from submitted_on, and the oldest
   bucket is the first thing on the screen.

   Money moves here by record, not by integration. There is no live treasury
   API and nothing in this file claims one: the claim leaves as a CSV somebody
   uploads or prints, and the release comes back as a receipt somebody types.

   ---- NSP scholarship reconciliation --------------------------------------

   NSP pays the student, not the school. The school's duties are verification
   on the portal and — the part nobody owns — noticing when a sanctioned
   scholarship never arrives. So the school keeps its own record of what it
   expects, the portal's disbursement list is imported as a file, and the
   reconciliation is the four ways the two disagree:

     sanctioned, never credited     the case that matters, and the reason for
                                    the whole screen
     credited to somebody unknown   a row for a child this school has no record
                                    of applying
     credited, student has left     money reaching a child who is no longer on
                                    the roll
     amount differs                 the portal paid something other than the
                                    sanction

   Where a scheme is meant to discharge the school's own fee rather than reach
   the family as cash, the credit is posted through fees.Collect as an
   adjustment payment. That puts it on the fee ledger the parent and the
   accountant already read, instead of in a private universe that has to be
   remembered at year end.

   ---- Student loan assistance --------------------------------------------

   A document and status tracker, and deliberately nothing else. No interest,
   no tenure, no repayment schedule, no eligibility score, no approval by the
   school. The school is not a lender, is not licensed to be one, and a screen
   that computed an EMI would make it look like one. What it does is stop a
   parent driving to the office four times for a bonafide certificate the
   school issued in March.

   ---- Category ------------------------------------------------------------

   SC/ST/OBC/EWS is the eligibility basis for most of this and is exactly the
   field that must not turn up where it has no business. The rule applied
   throughout, and it is a rule rather than a habit:

     students.category is selected on ONE endpoint, listScholarshipAwards,
     because an NSP pre-matric application cannot be verified without it, and
     in ONE export, the state's claim file, whose format demands it and which
     already requires finance.export.

     It appears in no claim list, no claim detail, no loan response, and no
     dashboard. Nothing else in this file selects the column at all. */

// --- money and dates ---------------------------------------------------------

/*
prorataPaise apportions an annual notified rate across part of a year.

	Integer paise throughout, rounded half up rather than truncated: truncating
	a quarter of ₹5,000 loses a paisa per child per quarter, and a claim whose
	total is four paise under the sum a clerk computed on a calculator is a
	claim the department queries.

	rupees(), formatPaise() and float64 are all absent on purpose. This is the
	number a government order is compared against.
*/
func prorataPaise(annualPaise int64, months int) int64 {
	if months >= 12 {
		return annualPaise
	}
	if months <= 0 {
		return 0
	}
	return (annualPaise*int64(months) + 6) / 12
}

// claimAgeDays is how long a claim has been outstanding, counted from the day
// it was submitted. A draft has no age: it is not owed until it is asked for.
func claimAgeDays(submitted *time.Time) int {
	if submitted == nil {
		return 0
	}
	d := int(nowInIndia().Sub(*submitted).Hours() / 24)
	if d < 0 {
		return 0
	}
	return d
}

// ageBucket names the age of an outstanding claim the way a school talks about
// it. The last bucket is open-ended because the honest answer to "how old is
// this one" past a year is "old enough that somebody has to go to the office".
func ageBucket(days int) string {
	switch {
	case days <= 90:
		return "0-90"
	case days <= 180:
		return "91-180"
	case days <= 365:
		return "181-365"
	default:
		return "365+"
	}
}

// --- mount -------------------------------------------------------------------

/*
mountConcessions wires the three screens.

	Mounted inside the /finance group in api.go, which already carries
	RequirePermission(rbac.InvoicesRead); every route below adds its own rung on
	top, so nothing here is reachable on the group gate alone.

	The rungs, and why each is where it is:

	  read     finance.fees.read     — the concession side of the fee module,
	                                   which is what all three of these are.
	  write    finance.fees.write    — a clerk assembling a claim, recording an
	                                   award, tracking a loan application.
	  approve  finance.refunds.write — the Approve rung of the finance group in
	                                   internal/rbac/model.go. Submitting a
	                                   claim to the state and recording what the
	                                   state sanctioned are both assertions the
	                                   school will be audited on, and neither is
	                                   a clerk's to make.
	  export   finance.export        — the claim file. It carries every child's
	                                   name and social category in one CSV,
	                                   which is the most disclosive thing this
	                                   feature produces.

	No new permission is invented. Every constant here already existed.
*/
func (s *Server) mountConcessions(r chi.Router) {
	read := httpx.RequirePermission(rbac.FeesRead)
	write := httpx.RequirePermission(rbac.FeesWrite)
	approve := httpx.RequirePermission(rbac.RefundsWrite)
	export := httpx.RequirePermission(rbac.FinanceExport)

	// --- the scheme registry, shared by the first two screens ---------------
	r.With(read).Get("/concessions/schemes", s.listAidSchemes)
	r.With(write).Post("/concessions/schemes", s.saveAidScheme)
	r.With(read).Get("/concessions/rates", s.listReimbursementRates)
	r.With(write).Post("/concessions/rates", s.saveReimbursementRate)

	// --- government reimbursement claims -----------------------------------
	r.With(read).Get("/concessions/claims", s.listClaims)
	// The ageing report. Registered before /{id} so "ageing" is not parsed as
	// a claim id.
	r.With(read).Get("/concessions/claims/ageing", s.getClaimAgeing)
	r.With(write).Post("/concessions/claims", s.saveClaim)
	r.With(read).Get("/concessions/claims/{id}", s.getClaim)
	r.With(write).Post("/concessions/claims/{id}/build", s.buildClaimLines)
	r.With(write).Delete("/concessions/claims/{id}/lines/{lineID}", s.removeClaimLine)
	r.With(write).Post("/concessions/claims/{id}/receipts", s.recordClaimReceipt)
	// The two assertions the school is audited on.
	r.With(approve).Post("/concessions/claims/{id}/submit", s.submitClaim)
	r.With(approve).Post("/concessions/claims/{id}/sanction", s.recordClaimSanction)
	// Every child's name, class and social category in one file.
	r.With(export).Get("/concessions/claims/{id}/file", s.exportClaimFile)

	// --- NSP scholarship reconciliation ------------------------------------
	r.With(read).Get("/concessions/scholarships", s.listScholarshipAwards)
	r.With(write).Post("/concessions/scholarships", s.saveScholarshipAward)
	r.With(write).Post("/concessions/scholarships/{id}/verify", s.verifyScholarshipAward)
	r.With(write).Post("/concessions/scholarships/{id}/fee-credit", s.creditScholarshipToFees)
	r.With(read).Get("/concessions/scholarships/imports", s.listScholarshipImports)
	r.With(write).Post("/concessions/scholarships/imports", s.importScholarshipDisbursements)
	r.With(read).Get("/concessions/scholarships/imports/{id}", s.getScholarshipImport)
	r.With(write).Post("/concessions/scholarships/lines/{id}/match", s.matchDisbursementLine)

	// --- education loan assistance -----------------------------------------
	r.With(read).Get("/concessions/loans/lenders", s.listLoanLenders)
	r.With(write).Post("/concessions/loans/lenders", s.saveLoanLender)
	r.With(read).Get("/concessions/loans/applications", s.listLoanApplications)
	r.With(write).Post("/concessions/loans/applications", s.saveLoanApplication)
	r.With(read).Get("/concessions/loans/applications/{id}", s.getLoanApplication)
	r.With(write).Post("/concessions/loans/applications/{id}/status", s.setLoanStatus)
	r.With(write).Post("/concessions/loans/applications/{id}/documents", s.saveLoanDocument)
}

// =============================================================== scheme registry

type aidSchemeView struct {
	ID             string  `json:"id"`
	Code           string  `json:"code"`
	Name           string  `json:"name"`
	Kind           string  `json:"kind"`
	PaidTo         string  `json:"paid_to"`
	Authority      *string `json:"authority,omitempty"`
	PortalURL      *string `json:"portal_url,omitempty"`
	ClaimFrequency *string `json:"claim_frequency,omitempty"`
	IsActive       bool    `json:"is_active"`
	Notes          *string `json:"notes,omitempty"`
	// How much of this scheme is already in flight, so the picker can say
	// which schemes are actually in use rather than listing eight the school
	// set up once.
	ClaimCount int `json:"claim_count"`
	AwardCount int `json:"award_count"`
}

func (s *Server) listAidSchemes(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT sc.id::text, sc.code, sc.name, sc.kind, sc.paid_to, sc.authority,
		       sc.portal_url, sc.claim_frequency, sc.is_active, sc.notes,
		       COALESCE(cl.n, 0)::int, COALESCE(aw.n, 0)::int
		  FROM government_aid_schemes sc
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS n FROM reimbursement_claims c WHERE c.scheme_id = sc.id
		  ) cl ON true
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS n FROM scholarship_awards a WHERE a.scheme_id = sc.id
		  ) aw ON true
		 WHERE ($1::text IS NULL OR sc.paid_to = $1)
		   AND ($2::bool IS NULL OR sc.is_active = $2)
		 ORDER BY sc.is_active DESC, sc.name`,
		[]any{nullString(q.Get("paid_to")), nullBool(q.Get("active"))},
		func(rows pgx.Rows) (aidSchemeView, error) {
			var v aidSchemeView
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Kind, &v.PaidTo, &v.Authority,
				&v.PortalURL, &v.ClaimFrequency, &v.IsActive, &v.Notes,
				&v.ClaimCount, &v.AwardCount)
		})
	respond(w, r, items, err)
}

type aidSchemeRequest struct {
	ID             string `json:"id"`
	Code           string `json:"code"`
	Name           string `json:"name"`
	Kind           string `json:"kind"`
	Authority      string `json:"authority"`
	PortalURL      string `json:"portal_url"`
	ClaimFrequency string `json:"claim_frequency"`
	IsActive       *bool  `json:"is_active"`
	Notes          string `json:"notes"`
}

// paidToForKind derives who the money reaches from what kind of scheme it is.
//
// Not taken from the request: a clerk who ticks the wrong box here would put an
// NSP scheme on the claims screen, where the school would raise a claim against
// a department that has never owed it anything. The two student-paid kinds are
// student-paid by definition.
func paidToForKind(kind string) (string, bool) {
	switch kind {
	case "rte_reimbursement", "fee_reimbursement":
		return "school", true
	case "nsp_scholarship", "state_scholarship":
		return "student", true
	}
	return "", false
}

func (s *Server) saveAidScheme(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req aidSchemeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	req.Name = strings.TrimSpace(req.Name)
	req.Kind = strings.TrimSpace(req.Kind)
	req.ClaimFrequency = strings.TrimSpace(req.ClaimFrequency)

	paidTo, ok := paidToForKind(req.Kind)
	switch {
	case req.Code == "":
		httpx.BadRequest(w, r, "give the scheme a short code, so a claim can name it")
		return
	case req.Name == "":
		httpx.BadRequest(w, r, "what is the scheme called?")
		return
	case !ok:
		httpx.BadRequest(w, r,
			"kind must be rte_reimbursement, fee_reimbursement, nsp_scholarship or state_scholarship")
		return
	}
	if paidTo == "school" && req.ClaimFrequency == "" {
		// Without it the claim screen cannot propose a period, and every claim
		// gets its dates typed from memory.
		req.ClaimFrequency = "quarterly"
	}
	if paidTo == "student" {
		req.ClaimFrequency = ""
	}
	if req.ClaimFrequency != "" {
		switch req.ClaimFrequency {
		case "monthly", "quarterly", "half_yearly", "annual":
		default:
			httpx.BadRequest(w, r,
				"claim frequency must be monthly, quarterly, half_yearly or annual")
			return
		}
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) != "" {
			sid, err := uuid.Parse(strings.TrimSpace(req.ID))
			if err != nil {
				return refusal("malformed scheme id")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE government_aid_schemes
				   SET code=$3, name=$4, kind=$5, paid_to=$6, authority=$7, portal_url=$8,
				       claim_frequency=$9, is_active=$10, notes=$11, updated_at=now()
				 WHERE id=$1 AND institution_id=$2
				 RETURNING id::text`,
				sid, id.InstitutionID, req.Code, req.Name, req.Kind, paidTo,
				nullString(req.Authority), nullString(req.PortalURL),
				nullString(req.ClaimFrequency), active, nullString(req.Notes)).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO government_aid_schemes
			    (institution_id, code, name, kind, paid_to, authority, portal_url,
			     claim_frequency, is_active, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			RETURNING id::text`,
			id.InstitutionID, req.Code, req.Name, req.Kind, paidTo,
			nullString(req.Authority), nullString(req.PortalURL),
			nullString(req.ClaimFrequency), active, nullString(req.Notes),
			id.UserID).Scan(&out)
	})
	s.concessionWriteResult(w, r, err, map[string]any{"id": out})
}

type reimbursementRateView struct {
	ID              string  `json:"id"`
	SchemeID        string  `json:"scheme_id"`
	SchemeName      string  `json:"scheme_name"`
	AcademicYearID  string  `json:"academic_year_id"`
	AcademicYear    string  `json:"academic_year"`
	FromLevel       int     `json:"from_level"`
	ToLevel         int     `json:"to_level"`
	AnnualRatePaise int64   `json:"annual_rate_paise"`
	NotificationRef *string `json:"notification_ref,omitempty"`
	NotifiedOn      *string `json:"notified_on,omitempty"`
	Notes           *string `json:"notes,omitempty"`
}

func (s *Server) listReimbursementRates(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT rr.id::text, rr.scheme_id::text, sc.name, rr.academic_year_id::text, ay.name,
		       rr.from_level, rr.to_level, rr.annual_rate_paise,
		       rr.notification_ref, to_char(rr.notified_on,'YYYY-MM-DD'), rr.notes
		  FROM reimbursement_rates rr
		  JOIN government_aid_schemes sc ON sc.id = rr.scheme_id
		  JOIN academic_years ay ON ay.id = rr.academic_year_id
		 WHERE ($1::uuid IS NULL OR rr.scheme_id = $1)
		   AND ($2::uuid IS NULL OR rr.academic_year_id = $2)
		 ORDER BY ay.starts_on DESC, sc.name, rr.from_level`,
		[]any{nullUUIDText(q.Get("scheme_id")), nullUUIDText(q.Get("academic_year_id"))},
		func(rows pgx.Rows) (reimbursementRateView, error) {
			var v reimbursementRateView
			return v, rows.Scan(&v.ID, &v.SchemeID, &v.SchemeName, &v.AcademicYearID,
				&v.AcademicYear, &v.FromLevel, &v.ToLevel, &v.AnnualRatePaise,
				&v.NotificationRef, &v.NotifiedOn, &v.Notes)
		})
	respond(w, r, items, err)
}

type reimbursementRateRequest struct {
	ID              string `json:"id"`
	SchemeID        string `json:"scheme_id"`
	AcademicYearID  string `json:"academic_year_id"`
	FromLevel       int    `json:"from_level"`
	ToLevel         int    `json:"to_level"`
	AnnualRatePaise int64  `json:"annual_rate_paise"`
	NotificationRef string `json:"notification_ref"`
	NotifiedOn      string `json:"notified_on"`
	Notes           string `json:"notes"`
}

func (s *Server) saveReimbursementRate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req reimbursementRateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	scheme, err := uuid.Parse(strings.TrimSpace(req.SchemeID))
	if err != nil {
		httpx.BadRequest(w, r, "which scheme is this rate for?")
		return
	}
	year, err := uuid.Parse(strings.TrimSpace(req.AcademicYearID))
	if err != nil {
		httpx.BadRequest(w, r, "which academic year does this rate apply to?")
		return
	}
	switch {
	case req.ToLevel < req.FromLevel:
		httpx.BadRequest(w, r, "the band ends before it starts")
		return
	case req.AnnualRatePaise < 0:
		httpx.BadRequest(w, r, "a notified rate cannot be negative")
		return
	}
	notified, ok := optionalISODay(req.NotifiedOn)
	if !ok {
		httpx.BadRequest(w, r, "notified_on must be YYYY-MM-DD")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Overlapping bands would make "the rate for class 5" ambiguous, and
		// the claim builder would pick whichever the planner happened to
		// return first. A gist EXCLUDE constraint would say this in the
		// schema, but btree_gist is not installed on this deployment, so the
		// check lives here and the migration says why.
		var clash int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FROM reimbursement_rates
			 WHERE institution_id=$1 AND scheme_id=$2 AND academic_year_id=$3
			   AND ($4::uuid IS NULL OR id <> $4)
			   AND int4range(from_level, to_level, '[]') && int4range($5, $6, '[]')`,
			id.InstitutionID, scheme, year, nullUUIDText(req.ID),
			req.FromLevel, req.ToLevel).Scan(&clash); err != nil {
			return err
		}
		if clash > 0 {
			return refusef(
				"classes %d to %d overlap a rate already notified for this scheme and year; "+
					"correct that band instead of adding a second one",
				req.FromLevel, req.ToLevel)
		}

		if strings.TrimSpace(req.ID) != "" {
			rid, err := uuid.Parse(strings.TrimSpace(req.ID))
			if err != nil {
				return refusal("malformed rate id")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE reimbursement_rates
				   SET scheme_id=$3, academic_year_id=$4, from_level=$5, to_level=$6,
				       annual_rate_paise=$7, notification_ref=$8, notified_on=$9,
				       notes=$10, updated_at=now()
				 WHERE id=$1 AND institution_id=$2 RETURNING id::text`,
				rid, id.InstitutionID, scheme, year, req.FromLevel, req.ToLevel,
				req.AnnualRatePaise, nullString(req.NotificationRef), notified,
				nullString(req.Notes)).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO reimbursement_rates
			    (institution_id, scheme_id, academic_year_id, from_level, to_level,
			     annual_rate_paise, notification_ref, notified_on, notes)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`,
			id.InstitutionID, scheme, year, req.FromLevel, req.ToLevel,
			req.AnnualRatePaise, nullString(req.NotificationRef), notified,
			nullString(req.Notes)).Scan(&out)
	})
	s.concessionWriteResult(w, r, err, map[string]any{"id": out})
}

// ========================================================= reimbursement claims

type claimView struct {
	ID              string `json:"id"`
	SchemeID        string `json:"scheme_id"`
	SchemeName      string `json:"scheme_name"`
	SchemeCode      string `json:"scheme_code"`
	AcademicYearID  string `json:"academic_year_id"`
	AcademicYear    string `json:"academic_year"`
	ClaimNo         string `json:"claim_no"`
	PeriodStart     string `json:"period_start"`
	PeriodEnd       string `json:"period_end"`
	Status          string `json:"status"`
	ChildCount      int    `json:"child_count"`
	ClaimedPaise    int64  `json:"claimed_paise"`
	SanctionedPaise int64  `json:"sanctioned_paise"`
	ReceivedPaise   int64  `json:"received_paise"`
	// Outstanding is claimed minus received, not sanctioned minus received: a
	// department that sanctioned less than was claimed still leaves the school
	// short, and hiding the disallowed part behind the sanction is how a
	// shortfall stops being anybody's problem.
	OutstandingPaise int64   `json:"outstanding_paise"`
	AgeDays          int     `json:"age_days"`
	AgeBucket        string  `json:"age_bucket"`
	SubmittedOn      *string `json:"submitted_on,omitempty"`
	SubmittedRef     *string `json:"submitted_ref,omitempty"`
	SanctionOrderNo  *string `json:"sanction_order_no,omitempty"`
	SanctionOn       *string `json:"sanction_on,omitempty"`
	RejectedReason   *string `json:"rejected_reason,omitempty"`
	Notes            *string `json:"notes,omitempty"`
	PreparedBy       *string `json:"prepared_by,omitempty"`
}

const claimSelectSQL = `
	SELECT c.id::text, c.scheme_id::text, sc.name, sc.code,
	       c.academic_year_id::text, ay.name,
	       c.claim_no, to_char(c.period_start,'YYYY-MM-DD'), to_char(c.period_end,'YYYY-MM-DD'),
	       c.status, c.child_count, c.claimed_paise, c.sanctioned_paise, c.received_paise,
	       c.submitted_on, c.submitted_ref, c.sanction_order_no,
	       to_char(c.sanction_on,'YYYY-MM-DD'), c.rejected_reason, c.notes, u.full_name
	  FROM reimbursement_claims c
	  JOIN government_aid_schemes sc ON sc.id = c.scheme_id
	  JOIN academic_years ay ON ay.id = c.academic_year_id
	  LEFT JOIN users u ON u.id = c.prepared_by`

func scanClaim(rows pgx.Rows) (claimView, error) {
	var v claimView
	var submitted *time.Time
	err := rows.Scan(&v.ID, &v.SchemeID, &v.SchemeName, &v.SchemeCode,
		&v.AcademicYearID, &v.AcademicYear, &v.ClaimNo, &v.PeriodStart, &v.PeriodEnd,
		&v.Status, &v.ChildCount, &v.ClaimedPaise, &v.SanctionedPaise, &v.ReceivedPaise,
		&submitted, &v.SubmittedRef, &v.SanctionOrderNo, &v.SanctionOn,
		&v.RejectedReason, &v.Notes, &v.PreparedBy)
	v.OutstandingPaise = v.ClaimedPaise - v.ReceivedPaise
	if v.OutstandingPaise < 0 {
		v.OutstandingPaise = 0
	}
	if submitted != nil {
		iso := submitted.Format(time.DateOnly)
		v.SubmittedOn = &iso
		v.AgeDays = claimAgeDays(submitted)
		v.AgeBucket = ageBucket(v.AgeDays)
	}
	return v, err
}

func (s *Server) listClaims(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, claimSelectSQL+`
		 WHERE ($1::uuid IS NULL OR c.scheme_id = $1)
		   AND ($2::uuid IS NULL OR c.academic_year_id = $2)
		   AND ($3::text IS NULL OR c.status = $3)
		 ORDER BY c.period_start DESC, sc.name
		 LIMIT $4`,
		[]any{nullUUIDText(q.Get("scheme_id")), nullUUIDText(q.Get("academic_year_id")),
			nullString(q.Get("status")), clampInt(q.Get("limit"), 200, 1, 1000)},
		scanClaim)
	respond(w, r, items, err)
}

type claimRequest struct {
	ID             string `json:"id"`
	SchemeID       string `json:"scheme_id"`
	AcademicYearID string `json:"academic_year_id"`
	ClaimNo        string `json:"claim_no"`
	PeriodStart    string `json:"period_start"`
	PeriodEnd      string `json:"period_end"`
	Notes          string `json:"notes"`
}

func (s *Server) saveClaim(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req claimRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	scheme, err := uuid.Parse(strings.TrimSpace(req.SchemeID))
	if err != nil {
		httpx.BadRequest(w, r, "which scheme is this claim under?")
		return
	}
	year, err := uuid.Parse(strings.TrimSpace(req.AcademicYearID))
	if err != nil {
		httpx.BadRequest(w, r, "which academic year does this claim cover?")
		return
	}
	start, ok := parseISODate(req.PeriodStart)
	if !ok {
		httpx.BadRequest(w, r, "period_start must be YYYY-MM-DD")
		return
	}
	end, ok := parseISODate(req.PeriodEnd)
	if !ok {
		httpx.BadRequest(w, r, "period_end must be YYYY-MM-DD")
		return
	}
	if end.Before(start) {
		httpx.BadRequest(w, r, "the period ends before it starts")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var paidTo, code string
		if err := tx.QueryRow(r.Context(),
			`SELECT paid_to, code FROM government_aid_schemes
			  WHERE id=$1 AND institution_id=$2`, scheme, id.InstitutionID).
			Scan(&paidTo, &code); err != nil {
			return err
		}
		if paidTo != "school" {
			// The school never raises a claim under a scheme the portal pays
			// the child under. Doing so would be a claim against a department
			// that has never owed this school anything.
			return refusal(
				"this scheme pays the student directly; it is reconciled on the " +
					"scholarship screen, not claimed for here")
		}

		claimNo := strings.TrimSpace(req.ClaimNo)
		if claimNo == "" {
			claimNo = fmt.Sprintf("%s/%s/%s", strings.ToUpper(code),
				fyLabelForDate(start.Format(time.DateOnly)), start.Format("Jan2006"))
		}

		if strings.TrimSpace(req.ID) != "" {
			cid, err := uuid.Parse(strings.TrimSpace(req.ID))
			if err != nil {
				return refusal("malformed claim id")
			}
			// A submitted claim's period and scheme are what the department
			// acknowledged. Editing them afterwards would silently change what
			// the school is on record as having asked for.
			var status string
			if err := tx.QueryRow(r.Context(),
				`SELECT status FROM reimbursement_claims WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
				cid, id.InstitutionID).Scan(&status); err != nil {
				return err
			}
			if status != "draft" {
				return refusef(
					"this claim has already been %s; only its notes can change now", status)
			}
			return tx.QueryRow(r.Context(), `
				UPDATE reimbursement_claims
				   SET scheme_id=$3, academic_year_id=$4, claim_no=$5,
				       period_start=$6, period_end=$7, notes=$8, updated_at=now()
				 WHERE id=$1 AND institution_id=$2 RETURNING id::text`,
				cid, id.InstitutionID, scheme, year, claimNo, start, end,
				nullString(req.Notes)).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO reimbursement_claims
			    (institution_id, scheme_id, academic_year_id, claim_no,
			     period_start, period_end, notes, prepared_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
			id.InstitutionID, scheme, year, claimNo, start, end,
			nullString(req.Notes), id.UserID).Scan(&out)
	})
	s.concessionWriteResult(w, r, err, map[string]any{"id": out})
}

type claimLineView struct {
	ID               string  `json:"id"`
	StudentID        string  `json:"student_id"`
	StudentName      string  `json:"student_name"`
	AdmissionNo      string  `json:"admission_no"`
	ClassName        *string `json:"class_name,omitempty"`
	ClassLevel       *int    `json:"class_level,omitempty"`
	RatePaise        int64   `json:"rate_paise"`
	Months           int     `json:"months"`
	ClaimedPaise     int64   `json:"claimed_paise"`
	SanctionedPaise  *int64  `json:"sanctioned_paise,omitempty"`
	ShortfallPaise   int64   `json:"shortfall_paise"`
	DisallowedReason *string `json:"disallowed_reason,omitempty"`
	HasConcession    bool    `json:"has_concession"`
	Notes            *string `json:"notes,omitempty"`
	// Deliberately no category here. The claim list does not need it; the file
	// that does carries finance.export.
}

type claimReceiptView struct {
	ID              string  `json:"id"`
	ReceivedOn      string  `json:"received_on"`
	AmountPaise     int64   `json:"amount_paise"`
	Mode            string  `json:"mode"`
	ReferenceNo     *string `json:"reference_no,omitempty"`
	TreasuryVoucher *string `json:"treasury_voucher,omitempty"`
	BankAccount     *string `json:"bank_account,omitempty"`
	Notes           *string `json:"notes,omitempty"`
	RecordedBy      *string `json:"recorded_by,omitempty"`
}

func (s *Server) getClaim(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	claimID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed claim id")
		return
	}

	var head claimView
	lines := []claimLineView{}
	receipts := []claimReceiptView{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), claimSelectSQL+
			` WHERE c.id=$1 AND c.institution_id=$2`, claimID, id.InstitutionID)
		if err != nil {
			return err
		}
		found := false
		for rows.Next() {
			head, err = scanClaim(rows)
			found = true
			if err != nil {
				rows.Close()
				return err
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if !found {
			return pgx.ErrNoRows
		}

		lrows, err := tx.Query(r.Context(), `
			SELECT l.id::text, l.student_id::text,
			       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
			       cl.name, l.class_level, l.rate_paise, l.months, l.claimed_paise,
			       l.sanctioned_paise, l.disallowed_reason,
			       (l.concession_id IS NOT NULL), l.notes
			  FROM reimbursement_claim_lines l
			  JOIN students st ON st.id = l.student_id
			  LEFT JOIN classes cl ON cl.id = l.class_id
			 WHERE l.claim_id=$1 AND l.institution_id=$2
			 ORDER BY cl.name NULLS LAST, st.first_name, st.admission_no`,
			claimID, id.InstitutionID)
		if err != nil {
			return err
		}
		defer lrows.Close()
		for lrows.Next() {
			var v claimLineView
			if err := lrows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.ClassName, &v.ClassLevel, &v.RatePaise, &v.Months, &v.ClaimedPaise,
				&v.SanctionedPaise, &v.DisallowedReason, &v.HasConcession,
				&v.Notes); err != nil {
				return err
			}
			if v.SanctionedPaise != nil {
				v.ShortfallPaise = v.ClaimedPaise - *v.SanctionedPaise
			}
			lines = append(lines, v)
		}
		if err := lrows.Err(); err != nil {
			return err
		}

		rrows, err := tx.Query(r.Context(), `
			SELECT rr.id::text, to_char(rr.received_on,'YYYY-MM-DD'), rr.amount_paise,
			       rr.mode, rr.reference_no, rr.treasury_voucher, ba.label,
			       rr.notes, u.full_name
			  FROM reimbursement_receipts rr
			  LEFT JOIN bank_accounts ba ON ba.id = rr.bank_account_id
			  LEFT JOIN users u ON u.id = rr.recorded_by
			 WHERE rr.claim_id=$1 AND rr.institution_id=$2
			 ORDER BY rr.received_on DESC`, claimID, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rrows.Close()
		for rrows.Next() {
			var v claimReceiptView
			if err := rrows.Scan(&v.ID, &v.ReceivedOn, &v.AmountPaise, &v.Mode,
				&v.ReferenceNo, &v.TreasuryVoucher, &v.BankAccount, &v.Notes,
				&v.RecordedBy); err != nil {
				return err
			}
			receipts = append(receipts, v)
		}
		return rrows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"claim": head, "lines": lines, "receipts": receipts,
		})
	}
}

/*
buildClaimLines assembles the claim from the roll.

	"Every RTE child on the roll during this period, at the rate in force for
	their class." students.is_rte is the flag the admissions funnel sets when an
	application with quota='rte' is converted, and it is the only marker this
	reads — a second one maintained here would disagree with admissions within a
	term.

	Three properties worth stating:

	  Idempotent. ON CONFLICT DO NOTHING on (claim_id, student_id), so running
	  it again in March picks up the child admitted in February without
	  discarding a month count somebody corrected by hand in January.

	  Pro-rated by months on roll. A child admitted mid-quarter is claimed for
	  the part of it they were there. Claiming the full quarter for a child who
	  joined in the last fortnight is the kind of thing a department finds and
	  then audits the previous three years over.

	  Children with no notified rate are reported, not skipped silently. A band
	  the school forgot to enter would otherwise drop twenty children out of a
	  claim, and nobody would notice until the sanction came back short.
*/
func (s *Server) buildClaimLines(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	claimID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed claim id")
		return
	}

	type missing struct {
		StudentName string `json:"student_name"`
		AdmissionNo string `json:"admission_no"`
		ClassName   string `json:"class_name"`
		Why         string `json:"why"`
	}
	added, already := 0, 0
	skipped := []missing{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var scheme, year uuid.UUID
		var start, end time.Time
		if err := tx.QueryRow(r.Context(), `
			SELECT status, scheme_id, academic_year_id, period_start, period_end
			  FROM reimbursement_claims WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			claimID, id.InstitutionID).Scan(&status, &scheme, &year, &start, &end); err != nil {
			return err
		}
		if status != "draft" {
			return refusef(
				"this claim was %s; assembling it again would change what the "+
					"department was told", status)
		}

		// Months of the period the child was actually on roll, computed in SQL
		// so a child admitted or withdrawn mid-quarter is claimed for what they
		// were there for and no more.
		rows, err := tx.Query(r.Context(), `
			SELECT st.id, concat_ws(' ', st.first_name, st.last_name), st.admission_no,
			       e.class_id, cl.name, cl.level,
			       GREATEST(1, (
			           EXTRACT(YEAR FROM age(
			               LEAST($4::date, COALESCE(st.exit_date, $4::date)),
			               GREATEST($3::date, st.admission_date)))::int * 12
			         + EXTRACT(MONTH FROM age(
			               LEAST($4::date, COALESCE(st.exit_date, $4::date)),
			               GREATEST($3::date, st.admission_date)))::int + 1))::int,
			       rr.annual_rate_paise,
			       (SELECT fc.id FROM fee_concessions fc
			         WHERE fc.student_id = st.id AND fc.academic_year_id = $2
			           AND fc.kind = 'rte'
			         ORDER BY fc.created_at DESC LIMIT 1)
			  FROM students st
			  JOIN enrollments e ON e.student_id = st.id AND e.academic_year_id = $2
			  JOIN classes cl ON cl.id = e.class_id
			  LEFT JOIN reimbursement_rates rr
			         ON rr.scheme_id = $5 AND rr.academic_year_id = $2
			        AND cl.level BETWEEN rr.from_level AND rr.to_level
			 WHERE st.institution_id = $1
			   AND st.is_rte
			   AND st.admission_date <= $4::date
			   AND (st.exit_date IS NULL OR st.exit_date >= $3::date)
			 ORDER BY cl.level, st.first_name`,
			id.InstitutionID, year, start, end, scheme)
		if err != nil {
			return err
		}
		defer rows.Close()

		type candidate struct {
			student   uuid.UUID
			name      string
			admission string
			classID   *uuid.UUID
			className *string
			level     int
			months    int
			rate      *int64
			concess   *uuid.UUID
		}
		var found []candidate
		for rows.Next() {
			var c candidate
			if err := rows.Scan(&c.student, &c.name, &c.admission, &c.classID,
				&c.className, &c.level, &c.months, &c.rate, &c.concess); err != nil {
				return err
			}
			found = append(found, c)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		rows.Close()

		for _, c := range found {
			if c.rate == nil {
				skipped = append(skipped, missing{
					StudentName: c.name, AdmissionNo: c.admission,
					ClassName: deref(c.className),
					Why: fmt.Sprintf(
						"no rate notified for class level %d in this year", c.level),
				})
				continue
			}
			months := c.months
			if months > 12 {
				months = 12
			}
			claimed := prorataPaise(*c.rate, months)

			var inserted string
			err := tx.QueryRow(r.Context(), `
				INSERT INTO reimbursement_claim_lines
				    (institution_id, claim_id, student_id, class_id, class_level,
				     rate_paise, months, claimed_paise, concession_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
				ON CONFLICT (claim_id, student_id) DO NOTHING
				RETURNING id::text`,
				id.InstitutionID, claimID, c.student, c.classID, c.level,
				*c.rate, months, claimed, c.concess).Scan(&inserted)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				already++
			case err != nil:
				return err
			default:
				added++
			}
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		s.concessionWriteResult(w, r, err, nil)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"added": added, "already_on_claim": already, "skipped": skipped,
	})
}

func (s *Server) removeClaimLine(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	claimID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed claim id")
		return
	}
	lineID, err := uuid.Parse(chi.URLParam(r, "lineID"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed line id")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM reimbursement_claims WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			claimID, id.InstitutionID).Scan(&status); err != nil {
			return err
		}
		if status != "draft" {
			return refusef(
				"this claim was %s; a child cannot be removed from what the "+
					"department has already been sent", status)
		}
		ct, err := tx.Exec(r.Context(),
			`DELETE FROM reimbursement_claim_lines
			  WHERE id=$1 AND claim_id=$2 AND institution_id=$3`,
			lineID, claimID, id.InstitutionID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	s.concessionWriteResult(w, r, err, map[string]any{"removed": true})
}

type claimSubmitRequest struct {
	SubmittedOn  string `json:"submitted_on"`
	SubmittedRef string `json:"submitted_ref"`
}

// submitClaim records that the claim left the building.
//
// The date is what the ageing counts from, which is why an empty claim is
// refused: a claim for nobody starts a clock against a debt that does not
// exist, and it is the sort of row that survives to become a phantom
// receivable three years later.
func (s *Server) submitClaim(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	claimID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed claim id")
		return
	}
	var req claimSubmitRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	on := nowInIndia()
	if strings.TrimSpace(req.SubmittedOn) != "" {
		d, ok := parseISODate(req.SubmittedOn)
		if !ok {
			httpx.BadRequest(w, r, "submitted_on must be YYYY-MM-DD")
			return
		}
		on = d
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var children int
		var claimed int64
		if err := tx.QueryRow(r.Context(), `
			SELECT status, child_count, claimed_paise FROM reimbursement_claims
			 WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			claimID, id.InstitutionID).Scan(&status, &children, &claimed); err != nil {
			return err
		}
		if status != "draft" {
			return refusef("this claim has already been %s", status)
		}
		if children == 0 || claimed == 0 {
			return refusal(
				"there are no children on this claim; assemble it before submitting, " +
					"or it will age as a debt nobody is owed")
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE reimbursement_claims
			   SET status='submitted', submitted_on=$3, submitted_ref=$4, updated_at=now()
			 WHERE id=$1 AND institution_id=$2`,
			claimID, id.InstitutionID, on, nullString(req.SubmittedRef))
		return err
	})
	s.concessionWriteResult(w, r, err, map[string]any{"status": "submitted"})
}

type claimSanctionLine struct {
	LineID           string `json:"line_id"`
	SanctionedPaise  int64  `json:"sanctioned_paise"`
	DisallowedReason string `json:"disallowed_reason"`
}

type claimSanctionRequest struct {
	SanctionOrderNo string              `json:"sanction_order_no"`
	SanctionOn      string              `json:"sanction_on"`
	RejectedReason  string              `json:"rejected_reason"`
	Lines           []claimSanctionLine `json:"lines"`
	Notes           string              `json:"notes"`
}

/*
recordClaimSanction records what the order actually approved.

	Per child, because that is how the order is written: a department disallows
	named children with a reason beside each, and a school that stored only the
	reduced total cannot appeal, cannot tell a parent why, and cannot tell
	whether the same child is being struck off every quarter.

	Lines the order does not mention are sanctioned in full — that is what
	silence on a sanction order means. The resulting status is derived from the
	arithmetic rather than chosen by the caller: nothing approved is a
	rejection, less than claimed is a part sanction, and a screen that let a
	clerk mark a 40% sanction as 'sanctioned' would bury the shortfall.
*/
func (s *Server) recordClaimSanction(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	claimID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed claim id")
		return
	}
	var req claimSanctionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.SanctionOrderNo) == "" {
		httpx.BadRequest(w, r, "what is the sanction order number?")
		return
	}
	on := nowInIndia()
	if strings.TrimSpace(req.SanctionOn) != "" {
		d, ok := parseISODate(req.SanctionOn)
		if !ok {
			httpx.BadRequest(w, r, "sanction_on must be YYYY-MM-DD")
			return
		}
		on = d
	}

	var outStatus string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM reimbursement_claims WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			claimID, id.InstitutionID).Scan(&status); err != nil {
			return err
		}
		switch status {
		case "draft":
			return refusal("this claim has not been submitted yet")
		case "closed":
			return refusal("this claim is closed; reopen it before recording another order")
		}

		// Silence on the order means allowed in full.
		if _, err := tx.Exec(r.Context(), `
			UPDATE reimbursement_claim_lines
			   SET sanctioned_paise = claimed_paise, disallowed_reason = NULL
			 WHERE claim_id=$1 AND institution_id=$2`,
			claimID, id.InstitutionID); err != nil {
			return err
		}

		for _, ln := range req.Lines {
			lid, err := uuid.Parse(strings.TrimSpace(ln.LineID))
			if err != nil {
				return refusal("malformed line id in the sanction")
			}
			if ln.SanctionedPaise < 0 {
				return refusal("a sanctioned amount cannot be negative")
			}
			var claimed int64
			if err := tx.QueryRow(r.Context(), `
				SELECT claimed_paise FROM reimbursement_claim_lines
				 WHERE id=$1 AND claim_id=$2 AND institution_id=$3`,
				lid, claimID, id.InstitutionID).Scan(&claimed); err != nil {
				return err
			}
			if ln.SanctionedPaise > claimed {
				return refusal(
					"a department cannot sanction more for a child than was claimed; " +
						"if the claim was understated, revise the claim")
			}
			reason := strings.TrimSpace(ln.DisallowedReason)
			if ln.SanctionedPaise < claimed && reason == "" {
				return refusal(
					"the order gave this child less than was claimed, record the " +
						"reason it names, or there is nothing to appeal with")
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE reimbursement_claim_lines
				   SET sanctioned_paise=$4, disallowed_reason=$5
				 WHERE id=$1 AND claim_id=$2 AND institution_id=$3`,
				lid, claimID, id.InstitutionID, ln.SanctionedPaise,
				nullString(reason)); err != nil {
				return err
			}
		}

		// The trigger has rolled the lines up by now; read the totals back
		// rather than recomputing them here and having two answers.
		var claimed, sanctioned int64
		if err := tx.QueryRow(r.Context(), `
			SELECT claimed_paise, sanctioned_paise FROM reimbursement_claims
			 WHERE id=$1 AND institution_id=$2`,
			claimID, id.InstitutionID).Scan(&claimed, &sanctioned); err != nil {
			return err
		}
		switch {
		case sanctioned == 0:
			outStatus = "rejected"
		case sanctioned < claimed:
			outStatus = "part_sanctioned"
		default:
			outStatus = "sanctioned"
		}
		rejected := strings.TrimSpace(req.RejectedReason)
		if outStatus == "rejected" && rejected == "" {
			rejected = "the sanction order allowed nothing against this claim"
		}
		if outStatus != "rejected" {
			rejected = ""
		}

		_, err := tx.Exec(r.Context(), `
			UPDATE reimbursement_claims
			   SET status=$3, sanction_order_no=$4, sanction_on=$5,
			       rejected_reason=$6, notes=COALESCE($7, notes), updated_at=now()
			 WHERE id=$1 AND institution_id=$2`,
			claimID, id.InstitutionID, outStatus,
			strings.TrimSpace(req.SanctionOrderNo), on,
			nullString(rejected), nullString(req.Notes))
		return err
	})
	s.concessionWriteResult(w, r, err, map[string]any{"status": outStatus})
}

type claimReceiptRequest struct {
	ReceivedOn      string `json:"received_on"`
	AmountPaise     int64  `json:"amount_paise"`
	Mode            string `json:"mode"`
	ReferenceNo     string `json:"reference_no"`
	TreasuryVoucher string `json:"treasury_voucher"`
	BankAccountID   string `json:"bank_account_id"`
	Notes           string `json:"notes"`
}

// recordClaimReceipt records a treasury release.
//
// Typed, or read off a bank statement, because there is no live treasury API
// and this endpoint does not pretend there is. The receipt total is rolled onto
// the claim by trigger; nothing here writes received_paise.
func (s *Server) recordClaimReceipt(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	claimID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed claim id")
		return
	}
	var req claimReceiptRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.AmountPaise <= 0 {
		httpx.BadRequest(w, r, "how much was released?")
		return
	}
	on, ok := parseISODate(req.ReceivedOn)
	if !ok {
		httpx.BadRequest(w, r, "received_on must be YYYY-MM-DD")
		return
	}
	mode := strings.TrimSpace(req.Mode)
	if mode == "" {
		mode = "neft"
	}
	switch mode {
	case "neft", "rtgs", "cheque", "dd", "adjustment":
	default:
		httpx.BadRequest(w, r, "mode must be neft, rtgs, cheque, dd or adjustment")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM reimbursement_claims WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			claimID, id.InstitutionID).Scan(&status); err != nil {
			return err
		}
		if status == "draft" {
			return refusal(
				"this claim has not been submitted; money against it would be " +
					"money for something nobody has asked for")
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO reimbursement_receipts
			    (institution_id, claim_id, received_on, amount_paise, mode,
			     reference_no, treasury_voucher, bank_account_id, notes, recorded_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text`,
			id.InstitutionID, claimID, on, req.AmountPaise, mode,
			nullString(req.ReferenceNo), nullString(req.TreasuryVoucher),
			nullUUIDText(req.BankAccountID), nullString(req.Notes),
			id.UserID).Scan(&out)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "duplicate_receipt",
			"a release of that amount, on that date, with that reference is already "+
				"recorded against this claim")
		return
	}
	s.concessionWriteResult(w, r, err, map[string]any{"id": out})
}

type claimAgeingBucket struct {
	Bucket           string `json:"bucket"`
	ClaimCount       int    `json:"claim_count"`
	ChildCount       int    `json:"child_count"`
	ClaimedPaise     int64  `json:"claimed_paise"`
	SanctionedPaise  int64  `json:"sanctioned_paise"`
	ReceivedPaise    int64  `json:"received_paise"`
	OutstandingPaise int64  `json:"outstanding_paise"`
}

/*
getClaimAgeing is the answer to "what is the state sitting on?".

	Bucketed from the day each claim was submitted, because that is the day the
	school stopped being able to do anything about it. The oldest bucket first
	is deliberate: a claim from two years ago is worth more attention than one
	from last month, and every ageing report that sorts newest-first buries
	exactly the rows it exists to surface.

	Claims that were never submitted are excluded. A draft is not owed.
*/
func (s *Server) getClaimAgeing(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	claims, err := collect(s, r, claimSelectSQL+`
		 WHERE c.status IN ('submitted','part_sanctioned','sanctioned')
		   AND c.claimed_paise > c.received_paise
		   AND ($1::uuid IS NULL OR c.scheme_id = $1)
		 ORDER BY c.submitted_on`,
		[]any{nullUUIDText(q.Get("scheme_id"))}, scanClaim)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	order := []string{"365+", "181-365", "91-180", "0-90"}
	byBucket := map[string]*claimAgeingBucket{}
	for _, b := range order {
		byBucket[b] = &claimAgeingBucket{Bucket: b}
	}
	var totalOutstanding int64
	for _, c := range claims {
		b := byBucket[c.AgeBucket]
		if b == nil {
			continue
		}
		b.ClaimCount++
		b.ChildCount += c.ChildCount
		b.ClaimedPaise += c.ClaimedPaise
		b.SanctionedPaise += c.SanctionedPaise
		b.ReceivedPaise += c.ReceivedPaise
		b.OutstandingPaise += c.OutstandingPaise
		totalOutstanding += c.OutstandingPaise
	}
	buckets := make([]claimAgeingBucket, 0, len(order))
	for _, b := range order {
		buckets = append(buckets, *byBucket[b])
	}

	// The oldest claims by name, because "₹4,20,000 in the 365+ bucket" is a
	// number and "Q2 2023-24, 46 children, submitted 22 months ago" is a job.
	sort.SliceStable(claims, func(i, j int) bool { return claims[i].AgeDays > claims[j].AgeDays })
	if len(claims) > 25 {
		claims = claims[:25]
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"buckets":                 buckets,
		"oldest":                  claims,
		"total_outstanding_paise": totalOutstanding,
	})
}

/*
exportClaimFile produces the per-child list the department wants.

	CSV, because that is what a state portal accepts and what a clerk pastes
	into the department's own workbook. There is no submission API and this
	route does not claim one — the header below says so to anybody reading the
	response rather than the screen.

	This is the one place in the feature that carries students.category, because
	the state's format asks for it. That is why the route requires
	finance.export rather than the read rung: a single file with every quota
	child's name, class and social category is the most disclosive thing this
	feature produces, and it should take a deliberate act by somebody trusted
	with exports.
*/
func (s *Server) exportClaimFile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	claimID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed claim id")
		return
	}

	type fileRow struct {
		admission, name, class, category, dob string
		months                                int
		rate, claimed                         int64
	}
	var claimNo, schemeName, periodStart, periodEnd string
	rows := []fileRow{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT c.claim_no, sc.name, to_char(c.period_start,'YYYY-MM-DD'),
			       to_char(c.period_end,'YYYY-MM-DD')
			  FROM reimbursement_claims c
			  JOIN government_aid_schemes sc ON sc.id = c.scheme_id
			 WHERE c.id=$1 AND c.institution_id=$2`,
			claimID, id.InstitutionID).Scan(&claimNo, &schemeName,
			&periodStart, &periodEnd); err != nil {
			return err
		}
		lrows, err := tx.Query(r.Context(), `
			SELECT st.admission_no, concat_ws(' ', st.first_name, st.last_name),
			       COALESCE(cl.name,''), COALESCE(st.category,''),
			       COALESCE(to_char(st.date_of_birth,'YYYY-MM-DD'),''),
			       l.months, l.rate_paise, l.claimed_paise
			  FROM reimbursement_claim_lines l
			  JOIN students st ON st.id = l.student_id
			  LEFT JOIN classes cl ON cl.id = l.class_id
			 WHERE l.claim_id=$1 AND l.institution_id=$2
			 ORDER BY cl.level NULLS LAST, st.first_name`, claimID, id.InstitutionID)
		if err != nil {
			return err
		}
		defer lrows.Close()
		for lrows.Next() {
			var v fileRow
			if err := lrows.Scan(&v.admission, &v.name, &v.class, &v.category,
				&v.dob, &v.months, &v.rate, &v.claimed); err != nil {
				return err
			}
			rows = append(rows, v)
		}
		return lrows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}

	var buf strings.Builder
	cw := csv.NewWriter(&buf)
	_ = cw.Write([]string{"S.No", "Admission No", "Student Name", "Class",
		"Category", "Date of Birth", "Months Claimed", "Annual Rate (INR)",
		"Amount Claimed (INR)"})
	var total int64
	for i, v := range rows {
		total += v.claimed
		_ = cw.Write([]string{
			strconv.Itoa(i + 1), v.admission, v.name, v.class,
			strings.ToUpper(v.category), v.dob, strconv.Itoa(v.months),
			rupeeString(v.rate), rupeeString(v.claimed),
		})
	}
	_ = cw.Write([]string{"", "", "", "", "", "", "", "Total", rupeeString(total)})
	cw.Flush()

	filename := fmt.Sprintf("claim-%s-%s.csv",
		strings.NewReplacer("/", "-", " ", "-", "\\", "-", `"`, "-").Replace(claimNo),
		periodStart)
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, filename))
	// Plain about what this file is, for anybody reading the response rather
	// than the screen.
	w.Header().Set("X-Claim-Submission",
		"not-attempted: no state submission API is configured; upload or print this file")
	_, _ = io.WriteString(w, buf.String())
}

// ========================================================= NSP reconciliation

type scholarshipAwardView struct {
	ID              string  `json:"id"`
	SchemeID        string  `json:"scheme_id"`
	SchemeName      string  `json:"scheme_name"`
	StudentID       string  `json:"student_id"`
	StudentName     string  `json:"student_name"`
	AdmissionNo     string  `json:"admission_no"`
	ClassName       *string `json:"class_name,omitempty"`
	StudentStatus   string  `json:"student_status"`
	AcademicYearID  string  `json:"academic_year_id"`
	AcademicYear    string  `json:"academic_year"`
	ApplicationRef  *string `json:"application_ref,omitempty"`
	Stage           string  `json:"stage"`
	VerifiedAt      *string `json:"verified_at,omitempty"`
	VerifiedBy      *string `json:"verified_by,omitempty"`
	RejectedReason  *string `json:"rejected_reason,omitempty"`
	ExpectedPaise   *int64  `json:"expected_paise,omitempty"`
	SanctionedPaise *int64  `json:"sanctioned_paise,omitempty"`
	CreditedPaise   int64   `json:"credited_paise"`
	CreditedOn      *string `json:"credited_on,omitempty"`
	// The account the credit was expected in, masked to four digits by the
	// register that owns it. This screen never sees more.
	AccountMasked *string `json:"account_masked,omitempty"`
	HasAccount    bool    `json:"has_account"`
	AadhaarSeeded bool    `json:"is_aadhaar_seeded"`
	OffsetsFees   bool    `json:"offsets_fees"`
	FeeCredited   bool    `json:"fee_credited"`
	Notes         *string `json:"notes,omitempty"`

	/* Category — the one place in this feature it is read.

	   An NSP pre-matric scholarship for SC students is granted on exactly this
	   field, and a clerk verifying an application on the portal has to see it.
	   It appears here and in the state claim file, and nowhere else: no claim
	   list, no loan screen, no dashboard. */
	Category *string `json:"category,omitempty"`

	// Why this row needs a person, derived rather than stored: the same four
	// facts the import checks, computed for awards that no file has touched.
	Exception string `json:"exception,omitempty"`
}

/*
listScholarshipAwards is the register and the reconciliation in one list.

	Not two screens, because a school's actual question is "which of my children
	are owed money and is any of it stuck?", and answering it from two lists
	means holding one in your head while reading the other.

	Exception is computed here rather than stored, because it is a fact about
	*now*: a child sanctioned in June and still uncredited in September became a
	problem without anything being written to the row. A stored flag would have
	to be swept, and the sweep is the thing nobody runs.
*/
func (s *Server) listScholarshipAwards(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT a.id::text, a.scheme_id::text, sc.name, a.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       cl.name, st.status, a.academic_year_id::text, ay.name,
		       a.application_ref, a.stage,
		       to_char(a.verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', vu.full_name,
		       a.rejected_reason, a.expected_paise, a.sanctioned_paise,
		       a.credited_paise, to_char(a.credited_on,'YYYY-MM-DD'),
		       -- Masked in the database. The register in internal/api/banking.go
		       -- owns the full number and the audited reveal; this screen has no
		       -- business with either.
		       CASE WHEN sba.id IS NULL THEN NULL
		            ELSE repeat('•', greatest(length(sba.account_number) - 4, 0))
		                 || right(sba.account_number, 4) END,
		       (sba.id IS NOT NULL), COALESCE(sba.is_aadhaar_seeded, false),
		       a.offsets_fees, (a.fee_credit_payment_id IS NOT NULL), a.notes,
		       st.category
		  FROM scholarship_awards a
		  JOIN government_aid_schemes sc ON sc.id = a.scheme_id
		  JOIN students st ON st.id = a.student_id
		  JOIN academic_years ay ON ay.id = a.academic_year_id
		  LEFT JOIN users vu ON vu.id = a.verified_by
		  LEFT JOIN student_bank_accounts sba
		         ON sba.id = COALESCE(a.bank_account_id,
		              (SELECT p.id FROM student_bank_accounts p
		                WHERE p.student_id = a.student_id AND p.is_primary LIMIT 1))
		  LEFT JOIN LATERAL (
		      SELECT e.class_id FROM enrollments e
		       WHERE e.student_id = st.id AND e.academic_year_id = a.academic_year_id
		       LIMIT 1
		  ) en ON true
		  LEFT JOIN classes cl ON cl.id = en.class_id
		 WHERE ($1::uuid IS NULL OR a.scheme_id = $1)
		   AND ($2::uuid IS NULL OR a.academic_year_id = $2)
		   AND ($3::text IS NULL OR a.stage = $3)
		   AND ($4::text IS NULL
		        OR st.admission_no ILIKE '%' || $4 || '%'
		        OR concat_ws(' ', st.first_name, st.last_name) ILIKE '%' || $4 || '%'
		        OR a.application_ref ILIKE '%' || $4 || '%')
		 ORDER BY st.first_name
		 LIMIT $5`,
		[]any{nullUUIDText(q.Get("scheme_id")), nullUUIDText(q.Get("academic_year_id")),
			nullString(q.Get("stage")), nullString(q.Get("q")),
			clampInt(q.Get("limit"), 300, 1, 1000)},
		func(rows pgx.Rows) (scholarshipAwardView, error) {
			var v scholarshipAwardView
			err := rows.Scan(&v.ID, &v.SchemeID, &v.SchemeName, &v.StudentID,
				&v.StudentName, &v.AdmissionNo, &v.ClassName, &v.StudentStatus,
				&v.AcademicYearID, &v.AcademicYear, &v.ApplicationRef, &v.Stage,
				&v.VerifiedAt, &v.VerifiedBy, &v.RejectedReason, &v.ExpectedPaise,
				&v.SanctionedPaise, &v.CreditedPaise, &v.CreditedOn,
				&v.AccountMasked, &v.HasAccount, &v.AadhaarSeeded, &v.OffsetsFees,
				&v.FeeCredited, &v.Notes, &v.Category)
			v.Exception = awardException(v)
			return v, err
		})
	respond(w, r, items, err)
}

// awardException names why a row needs a person, in the order a school would
// act on them. Empty means it reconciled.
func awardException(v scholarshipAwardView) string {
	switch {
	case v.Stage == "sanctioned" && v.CreditedPaise == 0:
		return "sanctioned_not_credited"
	case v.Stage == "not_credited":
		return "sanctioned_not_credited"
	case v.CreditedPaise > 0 && v.StudentStatus != "active":
		return "student_left"
	case v.SanctionedPaise != nil && v.CreditedPaise > 0 &&
		*v.SanctionedPaise != v.CreditedPaise:
		return "amount_differs"
	case v.Stage == "school_verified" && !v.HasAccount:
		return "no_bank_account"
	case v.Stage == "school_verified" && !v.AadhaarSeeded:
		return "not_aadhaar_seeded"
	}
	return ""
}

type scholarshipAwardRequest struct {
	ID              string `json:"id"`
	SchemeID        string `json:"scheme_id"`
	StudentID       string `json:"student_id"`
	AcademicYearID  string `json:"academic_year_id"`
	ApplicationRef  string `json:"application_ref"`
	Stage           string `json:"stage"`
	ExpectedPaise   *int64 `json:"expected_paise"`
	SanctionedPaise *int64 `json:"sanctioned_paise"`
	BankAccountID   string `json:"bank_account_id"`
	OffsetsFees     bool   `json:"offsets_fees"`
	RejectedReason  string `json:"rejected_reason"`
	Notes           string `json:"notes"`
}

func (s *Server) saveScholarshipAward(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req scholarshipAwardRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	scheme, err := uuid.Parse(strings.TrimSpace(req.SchemeID))
	if err != nil {
		httpx.BadRequest(w, r, "which scheme is this application under?")
		return
	}
	student, err := uuid.Parse(strings.TrimSpace(req.StudentID))
	if err != nil {
		httpx.BadRequest(w, r, "which child is this for?")
		return
	}
	year, err := uuid.Parse(strings.TrimSpace(req.AcademicYearID))
	if err != nil {
		httpx.BadRequest(w, r, "which academic year?")
		return
	}
	stage := strings.TrimSpace(req.Stage)
	if stage == "" {
		stage = "applied"
	}
	switch stage {
	case "applied", "school_rejected", "sanctioned", "withdrawn", "not_credited":
	case "school_verified":
		// Verification is an act with a person's name on it, so it goes
		// through its own endpoint rather than being set by editing a form.
		httpx.BadRequest(w, r,
			"verify the application from the verify action, so who verified it is recorded")
		return
	case "credited":
		httpx.BadRequest(w, r,
			"a credit is recorded by importing the portal's disbursement list, not by hand")
		return
	default:
		httpx.BadRequest(w, r, "unknown stage: "+stage)
		return
	}
	if stage == "school_rejected" && strings.TrimSpace(req.RejectedReason) == "" {
		httpx.BadRequest(w, r, "why is the school refusing to verify this application?")
		return
	}
	if stage == "sanctioned" && req.SanctionedPaise == nil {
		httpx.BadRequest(w, r, "how much did the portal sanction?")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var paidTo string
		if err := tx.QueryRow(r.Context(),
			`SELECT paid_to FROM government_aid_schemes WHERE id=$1 AND institution_id=$2`,
			scheme, id.InstitutionID).Scan(&paidTo); err != nil {
			return err
		}
		if paidTo != "student" {
			return refusal(
				"this scheme reimburses the school, not the child; it belongs on " +
					"the reimbursement claims screen")
		}
		if strings.TrimSpace(req.ID) != "" {
			aid, err := uuid.Parse(strings.TrimSpace(req.ID))
			if err != nil {
				return refusal("malformed award id")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE scholarship_awards
				   SET scheme_id=$3, student_id=$4, academic_year_id=$5,
				       application_ref=$6, stage=$7, expected_paise=$8,
				       sanctioned_paise=$9, bank_account_id=$10, offsets_fees=$11,
				       rejected_reason=$12, notes=$13, updated_at=now()
				 WHERE id=$1 AND institution_id=$2
				   -- A credited award is evidence of a transfer. Editing it back
				   -- to 'applied' would erase the school's record of money that
				   -- reached a family.
				   AND stage <> 'credited'
				 RETURNING id::text`,
				aid, id.InstitutionID, scheme, student, year,
				nullString(req.ApplicationRef), stage, req.ExpectedPaise,
				req.SanctionedPaise, nullUUIDText(req.BankAccountID), req.OffsetsFees,
				nullString(req.RejectedReason), nullString(req.Notes)).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO scholarship_awards
			    (institution_id, scheme_id, student_id, academic_year_id,
			     application_ref, stage, expected_paise, sanctioned_paise,
			     bank_account_id, offsets_fees, rejected_reason, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id::text`,
			id.InstitutionID, scheme, student, year, nullString(req.ApplicationRef),
			stage, req.ExpectedPaise, req.SanctionedPaise,
			nullUUIDText(req.BankAccountID), req.OffsetsFees,
			nullString(req.RejectedReason), nullString(req.Notes), id.UserID).Scan(&out)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "duplicate_award",
			"this child already has an application recorded under that scheme for "+
				"that year, or that application reference is already in use")
		return
	}
	s.concessionWriteResult(w, r, err, map[string]any{"id": out})
}

// verifyScholarshipAward records the school's one real duty in the NSP process.
//
// Its own endpoint, and its own row in the response, because "the school
// verified this child" is an assertion the portal relies on and a school can be
// asked to stand behind. Setting it by editing a dropdown would leave nobody's
// name against it.
func (s *Server) verifyScholarshipAward(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	awardID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed award id")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE scholarship_awards
			   SET stage='school_verified', verified_by=$3, verified_at=now(),
			       rejected_reason=NULL, updated_at=now()
			 WHERE id=$1 AND institution_id=$2 AND stage IN ('applied','school_rejected')`,
			awardID, id.InstitutionID, id.UserID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return refusal(
				"only an application still waiting on the school can be verified")
		}
		return nil
	})
	s.concessionWriteResult(w, r, err, map[string]any{"stage": "school_verified"})
}

/*
creditScholarshipToFees puts the credit on the child's fee ledger.

	Some state schemes discharge the school's fee rather than reaching the
	family as cash. Where that is what the scheme does, the money has to be
	visible where a parent and an accountant already look — which is the fee
	ledger, not a scholarship screen neither of them opens.

	It goes through fees.Collect rather than a hand-written INSERT, so it gets
	the receipt series, the oldest-first allocation and the invoice status
	triggers that every other payment gets. mode='adjustment' already exists in
	the payments CHECK and in the fee counter's allow-list; a new mode would
	have meant a migration against a table three other features are writing to.

	Posted once. fee_credit_payment_id is the guard, checked under FOR UPDATE,
	because the failure this prevents is a clerk pressing the button twice and
	the child's dues being cleared with money that arrived once.
*/
func (s *Server) creditScholarshipToFees(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	awardID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed award id")
		return
	}

	var receipt *fees.Receipt
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var student uuid.UUID
		var stage, schemeName string
		var credited int64
		var offsets bool
		var existing *uuid.UUID
		var appRef *string
		if err := tx.QueryRow(r.Context(), `
			SELECT a.student_id, a.stage, a.credited_paise, a.offsets_fees,
			       a.fee_credit_payment_id, a.application_ref, sc.name
			  FROM scholarship_awards a
			  JOIN government_aid_schemes sc ON sc.id = a.scheme_id
			 WHERE a.id=$1 AND a.institution_id=$2 FOR UPDATE OF a`,
			awardID, id.InstitutionID).Scan(&student, &stage, &credited, &offsets,
			&existing, &appRef, &schemeName); err != nil {
			return err
		}
		switch {
		case !offsets:
			return refusal(
				"this scholarship reaches the parent as cash; posting it against " +
					"the school's fees would credit the child for money the school " +
					"never received")
		case stage != "credited" || credited <= 0:
			return refusal(
				"nothing has been credited under this award yet; import the portal's " +
					"disbursement list first")
		case existing != nil:
			return refusal("this credit has already been posted to the fee ledger")
		}

		var instID, campusID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id, campus_id FROM students WHERE id=$1`,
			student).Scan(&instID, &campusID); err != nil {
			return err
		}

		remark := "Scholarship credit: " + schemeName
		if appRef != nil && strings.TrimSpace(*appRef) != "" {
			remark += " (" + strings.TrimSpace(*appRef) + ")"
		}
		receipt, err = fees.Collect(r.Context(), tx, fees.CollectRequest{
			InstitutionID: instID, CampusID: campusID, StudentID: student,
			AmountPaise: credited, Mode: "adjustment", PaidOn: nowInIndia(),
			Remarks: remark, CollectedBy: id.UserID,
		})
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE scholarship_awards SET fee_credit_payment_id=$3, updated_at=now()
			 WHERE id=$1 AND institution_id=$2`,
			awardID, id.InstitutionID, receipt.PaymentID)
		return err
	})
	if err != nil {
		s.concessionWriteResult(w, r, err, nil)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"payment_id":       receipt.PaymentID.String(),
		"receipt_no":       receipt.ReceiptNo,
		"amount_paise":     receipt.AmountPaise,
		"unallocated":      receipt.Unallocated,
		"allocated_count":  len(receipt.Allocated),
		"cleared_all_dues": receipt.Cleared,
	})
}

type scholarshipImportView struct {
	ID             string  `json:"id"`
	SchemeID       string  `json:"scheme_id"`
	SchemeName     string  `json:"scheme_name"`
	AcademicYear   string  `json:"academic_year"`
	Filename       *string `json:"filename,omitempty"`
	Source         string  `json:"source"`
	RowCount       int     `json:"row_count"`
	MatchedCount   int     `json:"matched_count"`
	UnmatchedCount int     `json:"unmatched_count"`
	RejectedCount  int     `json:"rejected_count"`
	CreditedPaise  int64   `json:"credited_paise"`
	ImportedAt     string  `json:"imported_at"`
	ImportedBy     *string `json:"imported_by,omitempty"`
}

func (s *Server) listScholarshipImports(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT i.id::text, i.scheme_id::text, sc.name, ay.name, i.filename, i.source,
		       i.row_count, i.matched_count, i.unmatched_count, i.rejected_count,
		       i.credited_paise, to_char(i.imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       u.full_name
		  FROM scholarship_disbursement_imports i
		  JOIN government_aid_schemes sc ON sc.id = i.scheme_id
		  JOIN academic_years ay ON ay.id = i.academic_year_id
		  LEFT JOIN users u ON u.id = i.imported_by
		 WHERE ($1::uuid IS NULL OR i.scheme_id = $1)
		 ORDER BY i.imported_at DESC LIMIT $2`,
		[]any{nullUUIDText(q.Get("scheme_id")), clampInt(q.Get("limit"), 50, 1, 200)},
		func(rows pgx.Rows) (scholarshipImportView, error) {
			var v scholarshipImportView
			return v, rows.Scan(&v.ID, &v.SchemeID, &v.SchemeName, &v.AcademicYear,
				&v.Filename, &v.Source, &v.RowCount, &v.MatchedCount, &v.UnmatchedCount,
				&v.RejectedCount, &v.CreditedPaise, &v.ImportedAt, &v.ImportedBy)
		})
	respond(w, r, items, err)
}

// disbursementHeaderAliases is what a portal export actually calls its columns.
//
// NSP, the state portals and the bank files the departments forward all differ,
// and every one of them has been through somebody's Excel. Matching on a set of
// aliases rather than a fixed position means a clerk does not have to rearrange
// columns before uploading, which is the step that goes wrong.
var disbursementHeaderAliases = map[string][]string{
	"application_ref": {"application id", "application no", "application number",
		"applicationid", "app id", "nsp application id", "reference id", "application ref"},
	"student_name": {"student name", "name of student", "beneficiary name",
		"name", "applicant name", "student"},
	"admission_no": {"admission no", "admission number", "adm no", "enrolment no",
		"enrollment no", "roll no", "student id"},
	"amount": {"amount", "amount disbursed", "disbursed amount", "scholarship amount",
		"credit amount", "amount (inr)", "amount in rs", "sanctioned amount"},
	"credited_on": {"disbursement date", "credit date", "date of credit",
		"transaction date", "payment date", "date"},
	"bank_reference": {"utr", "utr no", "utr number", "bank reference", "reference no",
		"transaction id", "txn id", "drt no"},
	"account_no": {"account no", "account number", "bank account", "beneficiary account",
		"a/c no", "account"},
	"portal_status": {"status", "payment status", "disbursement status", "remarks"},
}

// mapDisbursementHeader recognises a header row, returning the column index of
// each field it understands. Reports false until it finds a row carrying an
// amount and at least one way to identify a child — portals put the school's
// name and a title above the table, and those rows are preamble, not rejects.
func mapDisbursementHeader(rec []string) (map[string]int, bool) {
	cols := map[string]int{}
	for i, cell := range rec {
		key := strings.ToLower(strings.TrimSpace(cell))
		key = strings.Trim(key, "*:# ")
		for field, aliases := range disbursementHeaderAliases {
			if _, taken := cols[field]; taken {
				continue
			}
			for _, a := range aliases {
				if key == a {
					cols[field] = i
					break
				}
			}
		}
	}
	_, hasAmount := cols["amount"]
	_, hasRef := cols["application_ref"]
	_, hasAdm := cols["admission_no"]
	return cols, hasAmount && (hasRef || hasAdm)
}

func cellAt(rec []string, cols map[string]int, field string) string {
	i, ok := cols[field]
	if !ok || i >= len(rec) {
		return ""
	}
	return strings.TrimSpace(rec[i])
}

type disbursementReject struct {
	Line   int    `json:"line"`
	Reason string `json:"reason"`
	Raw    string `json:"raw"`
}

type nspImportResult struct {
	ImportID       string               `json:"import_id"`
	RowCount       int                  `json:"row_count"`
	MatchedCount   int                  `json:"matched_count"`
	UnmatchedCount int                  `json:"unmatched_count"`
	RejectedCount  int                  `json:"rejected_count"`
	CreditedPaise  int64                `json:"credited_paise"`
	Exceptions     map[string]int       `json:"exceptions"`
	Rejects        []disbursementReject `json:"rejects"`
}

/*
importScholarshipDisbursements reads the portal's disbursement list.

	A file, because that is what exists. NSP publishes a list the school
	downloads; there is no API, no credential and no callback, and this endpoint
	does not imply one.

	Matching is two passes, both exact, and there is no fuzzy pass on purpose.
	An application reference matches an application reference; failing that, an
	admission number matches a child. Guessing from a name would attach a
	transfer to the wrong child, and the wrong child's dues would then be
	cleared by the fee credit — which is not a mistake anyone would find.

	What the import writes to an award is only what the file is evidence of: the
	amount credited and the date. It never invents a sanction, and it never
	marks an award verified.
*/
func (s *Server) importScholarshipDisbursements(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	scheme, err := uuid.Parse(strings.TrimSpace(q.Get("scheme_id")))
	if err != nil {
		httpx.BadRequest(w, r, "which scheme is this disbursement list for?")
		return
	}
	year, err := uuid.Parse(strings.TrimSpace(q.Get("academic_year_id")))
	if err != nil {
		httpx.BadRequest(w, r, "which academic year does this list cover?")
		return
	}
	filename := strings.TrimSpace(q.Get("filename"))
	if filename == "" {
		filename = "disbursements.csv"
	}
	source := strings.TrimSpace(q.Get("source"))
	switch source {
	case "":
		source = "nsp_portal_csv"
	case "nsp_portal_csv", "state_portal_csv", "manual":
	default:
		httpx.BadRequest(w, r, "source must be nsp_portal_csv, state_portal_csv or manual")
		return
	}

	// 8 MB is tens of thousands of rows. Beyond that it is a data migration.
	body := http.MaxBytesReader(w, r.Body, 8<<20)
	defer body.Close()
	raw, err := io.ReadAll(body)
	if err != nil {
		httpx.BadRequest(w, r, "could not read the uploaded file")
		return
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		httpx.BadRequest(w, r, "the uploaded file is empty")
		return
	}

	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	physical := strings.Split(text, "\n")

	type parsedLine struct {
		lineNo                                        int
		appRef, name, admission, bankRef, last4, stat string
		amount                                        int64
		credited                                      *time.Time
		rawLine                                       string
	}
	var cols map[string]int
	var rejects []disbursementReject
	parsed := []parsedLine{}

	for i, line := range physical {
		if strings.TrimSpace(line) == "" {
			continue
		}
		rec, rerr := csv.NewReader(strings.NewReader(line)).Read()
		if rerr != nil {
			rejects = append(rejects, disbursementReject{Line: i + 1,
				Reason: "could not be read as a CSV row", Raw: clipRaw(line, 300)})
			continue
		}
		if cols == nil {
			if c, ok := mapDisbursementHeader(rec); ok {
				cols = c
			}
			// Preamble above the table is normal and is skipped in silence.
			continue
		}

		var p parsedLine
		p.lineNo = i + 1
		p.rawLine = clipRaw(line, 800)
		p.appRef = cellAt(rec, cols, "application_ref")
		p.name = cellAt(rec, cols, "student_name")
		p.admission = cellAt(rec, cols, "admission_no")
		p.bankRef = cellAt(rec, cols, "bank_reference")
		p.stat = cellAt(rec, cols, "portal_status")

		amountRaw := cellAt(rec, cols, "amount")
		if amountRaw == "" {
			// A totals row, or a blank line the portal left in. Not a reject.
			continue
		}
		amt, aerr := paiseFromDecimal(amountRaw)
		if aerr != nil {
			rejects = append(rejects, disbursementReject{Line: i + 1,
				Reason: "amount could not be read: " + amountRaw, Raw: p.rawLine})
			continue
		}
		if amt < 0 {
			rejects = append(rejects, disbursementReject{Line: i + 1,
				Reason: "a disbursement cannot be negative", Raw: p.rawLine})
			continue
		}
		p.amount = amt

		if d := cellAt(rec, cols, "credited_on"); d != "" {
			if t, ok := parseStatementDate(d); ok {
				p.credited = &t
			}
		}
		// Four digits and nothing else, ever. The register in banking.go owns
		// children's account numbers, with masking and an audited reveal; a
		// second copy accumulating here would have neither.
		if acct := cellAt(rec, cols, "account_no"); acct != "" {
			trimmed := strings.TrimFunc(acct, func(rn rune) bool {
				return !((rn >= '0' && rn <= '9') || (rn >= 'a' && rn <= 'z') ||
					(rn >= 'A' && rn <= 'Z'))
			})
			if len(trimmed) >= 4 {
				p.last4 = lastFour(trimmed)
			}
		}
		if p.appRef == "" && p.admission == "" {
			rejects = append(rejects, disbursementReject{Line: i + 1,
				Reason: "the row names neither an application reference nor an admission number",
				Raw:    p.rawLine})
			continue
		}
		parsed = append(parsed, p)
	}

	if cols == nil {
		httpx.BadRequest(w, r,
			"no header row was recognised. The file needs a row naming an amount "+
				"column and either an application id or an admission number")
		return
	}

	out := nspImportResult{Exceptions: map[string]int{}, Rejects: rejects}
	out.RejectedCount = len(rejects)

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var importID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO scholarship_disbursement_imports
			    (institution_id, scheme_id, academic_year_id, filename, source, imported_by)
			VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			id.InstitutionID, scheme, year, filename, source, id.UserID).
			Scan(&importID); err != nil {
			return err
		}
		out.ImportID = importID.String()

		seenRef := map[string]bool{}
		for _, p := range parsed {
			out.RowCount++
			out.CreditedPaise += p.amount

			var awardID *uuid.UUID
			matchKind := "unmatched"
			var exception *string
			set := func(e string) { exception = &e }

			refKey := strings.ToLower(strings.TrimSpace(p.appRef))
			if refKey != "" && seenRef[refKey] {
				set("duplicate")
			}
			if refKey != "" {
				seenRef[refKey] = true
			}

			// Pass one: the portal's own reference.
			if p.appRef != "" {
				var found uuid.UUID
				err := tx.QueryRow(r.Context(), `
					SELECT id FROM scholarship_awards
					 WHERE institution_id=$1 AND scheme_id=$2
					   AND lower(btrim(application_ref)) = lower(btrim($3))`,
					id.InstitutionID, scheme, p.appRef).Scan(&found)
				if err == nil {
					awardID, matchKind = &found, "application_ref"
				} else if !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}
			// Pass two: the admission number, within this scheme and year.
			if awardID == nil && p.admission != "" {
				var found uuid.UUID
				err := tx.QueryRow(r.Context(), `
					SELECT a.id FROM scholarship_awards a
					  JOIN students st ON st.id = a.student_id
					 WHERE a.institution_id=$1 AND a.scheme_id=$2 AND a.academic_year_id=$3
					   AND lower(btrim(st.admission_no)) = lower(btrim($4))`,
					id.InstitutionID, scheme, year, p.admission).Scan(&found)
				if err == nil {
					awardID, matchKind = &found, "admission_no"
				} else if !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}

			if awardID == nil {
				out.UnmatchedCount++
				if exception == nil {
					set("no_award")
				}
			} else {
				out.MatchedCount++
				var sanctioned *int64
				var studentStatus string
				if err := tx.QueryRow(r.Context(), `
					SELECT a.sanctioned_paise, st.status
					  FROM scholarship_awards a JOIN students st ON st.id = a.student_id
					 WHERE a.id=$1`, *awardID).Scan(&sanctioned, &studentStatus); err != nil {
					return err
				}
				if exception == nil {
					switch {
					case studentStatus != "active":
						set("student_left")
					case sanctioned != nil && *sanctioned != p.amount:
						set("amount_differs")
					}
				}
				// The award records what the file is evidence of, and nothing
				// more: money arrived, on this date. Where the portal credited
				// something other than the sanction, the sanction is left
				// alone — the difference is the finding.
				creditedOn := p.credited
				if creditedOn == nil {
					now := nowInIndia()
					creditedOn = &now
				}
				if _, err := tx.Exec(r.Context(), `
					UPDATE scholarship_awards
					   SET credited_paise=$3::bigint, credited_on=$4,
					       stage = CASE WHEN $3::bigint > 0 THEN 'credited' ELSE stage END,
					       sanctioned_paise = COALESCE(sanctioned_paise, $3::bigint),
					       updated_at=now()
					 WHERE id=$1 AND institution_id=$2`,
					*awardID, id.InstitutionID, p.amount, *creditedOn); err != nil {
					return err
				}
			}
			if exception != nil {
				out.Exceptions[*exception]++
			}

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO scholarship_disbursement_lines
				    (institution_id, import_id, line_no, application_ref,
				     student_name_given, admission_no_given, amount_paise, credited_on,
				     bank_reference, account_last4, portal_status, award_id, match_kind,
				     exception, raw_line)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
				id.InstitutionID, importID, p.lineNo, nullString(p.appRef),
				nullString(p.name), nullString(p.admission), p.amount, p.credited,
				nullString(p.bankRef), nullString(p.last4), nullString(p.stat),
				awardID, matchKind, exception, nullString(p.rawLine)); err != nil {
				return err
			}
		}

		rejectJSON, _ := json.Marshal(rejects)
		_, err := tx.Exec(r.Context(), `
			UPDATE scholarship_disbursement_imports
			   SET row_count=$3, matched_count=$4, unmatched_count=$5,
			       rejected_count=$6, credited_paise=$7, rejects=$8
			 WHERE id=$1 AND institution_id=$2`,
			importID, id.InstitutionID, out.RowCount, out.MatchedCount,
			out.UnmatchedCount, out.RejectedCount, out.CreditedPaise, rejectJSON)
		return err
	})
	if err != nil {
		s.concessionWriteResult(w, r, err, nil)
		return
	}
	httpx.JSON(w, http.StatusCreated, out)
}

type disbursementLineView struct {
	ID          string  `json:"id"`
	LineNo      int     `json:"line_no"`
	AppRef      *string `json:"application_ref,omitempty"`
	NameGiven   *string `json:"student_name_given,omitempty"`
	AdmGiven    *string `json:"admission_no_given,omitempty"`
	AmountPaise int64   `json:"amount_paise"`
	CreditedOn  *string `json:"credited_on,omitempty"`
	BankRef     *string `json:"bank_reference,omitempty"`
	// Four digits, as they came from the file. Never more.
	AccountLast4 *string `json:"account_last4,omitempty"`
	PortalStatus *string `json:"portal_status,omitempty"`
	MatchKind    string  `json:"match_kind"`
	Exception    *string `json:"exception,omitempty"`
	AwardID      *string `json:"award_id,omitempty"`
	StudentName  *string `json:"student_name,omitempty"`
	AdmissionNo  *string `json:"admission_no,omitempty"`
}

func (s *Server) getScholarshipImport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	importID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed import id")
		return
	}

	var head scholarshipImportView
	var rejects []disbursementReject
	lines := []disbursementLineView{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var rejectRaw []byte
		if err := tx.QueryRow(r.Context(), `
			SELECT i.id::text, i.scheme_id::text, sc.name, ay.name, i.filename, i.source,
			       i.row_count, i.matched_count, i.unmatched_count, i.rejected_count,
			       i.credited_paise, to_char(i.imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       u.full_name, i.rejects
			  FROM scholarship_disbursement_imports i
			  JOIN government_aid_schemes sc ON sc.id = i.scheme_id
			  JOIN academic_years ay ON ay.id = i.academic_year_id
			  LEFT JOIN users u ON u.id = i.imported_by
			 WHERE i.id=$1 AND i.institution_id=$2`,
			importID, id.InstitutionID).Scan(&head.ID, &head.SchemeID, &head.SchemeName,
			&head.AcademicYear, &head.Filename, &head.Source, &head.RowCount,
			&head.MatchedCount, &head.UnmatchedCount, &head.RejectedCount,
			&head.CreditedPaise, &head.ImportedAt, &head.ImportedBy, &rejectRaw); err != nil {
			return err
		}
		_ = json.Unmarshal(rejectRaw, &rejects)

		rows, err := tx.Query(r.Context(), `
			SELECT dl.id::text, dl.line_no, dl.application_ref, dl.student_name_given,
			       dl.admission_no_given, dl.amount_paise,
			       to_char(dl.credited_on,'YYYY-MM-DD'), dl.bank_reference,
			       dl.account_last4, dl.portal_status, dl.match_kind, dl.exception,
			       dl.award_id::text,
			       concat_ws(' ', st.first_name, st.last_name), st.admission_no
			  FROM scholarship_disbursement_lines dl
			  LEFT JOIN scholarship_awards a ON a.id = dl.award_id
			  LEFT JOIN students st ON st.id = a.student_id
			 WHERE dl.import_id=$1 AND dl.institution_id=$2
			 -- Exceptions first: this list is read to find the rows that need a
			 -- person, not to admire the ones that reconciled.
			 ORDER BY (dl.exception IS NULL), dl.line_no`,
			importID, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v disbursementLineView
			if err := rows.Scan(&v.ID, &v.LineNo, &v.AppRef, &v.NameGiven, &v.AdmGiven,
				&v.AmountPaise, &v.CreditedOn, &v.BankRef, &v.AccountLast4,
				&v.PortalStatus, &v.MatchKind, &v.Exception, &v.AwardID,
				&v.StudentName, &v.AdmissionNo); err != nil {
				return err
			}
			lines = append(lines, v)
		}
		return rows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		if rejects == nil {
			rejects = []disbursementReject{}
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"import": head, "lines": lines, "rejects": rejects,
		})
	}
}

type disbursementMatchRequest struct {
	AwardID string `json:"award_id"`
}

// matchDisbursementLine attaches an unmatched portal row to an award by hand.
//
// The only way a match is ever made on anything other than an exact reference.
// Somebody looked at the name, the amount and the four digits and decided; the
// match kind records that it was a person, so a later reader can tell it from
// one the importer was sure of.
func (s *Server) matchDisbursementLine(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	lineID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed line id")
		return
	}
	var req disbursementMatchRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	award, err := uuid.Parse(strings.TrimSpace(req.AwardID))
	if err != nil {
		httpx.BadRequest(w, r, "which application does this row belong to?")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var amount int64
		var creditedOn *time.Time
		var already *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT amount_paise, credited_on, award_id
			  FROM scholarship_disbursement_lines
			 WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			lineID, id.InstitutionID).Scan(&amount, &creditedOn, &already); err != nil {
			return err
		}
		if already != nil {
			return refusal("this row is already matched")
		}
		var studentStatus string
		var sanctioned *int64
		if err := tx.QueryRow(r.Context(), `
			SELECT st.status, a.sanctioned_paise
			  FROM scholarship_awards a JOIN students st ON st.id = a.student_id
			 WHERE a.id=$1 AND a.institution_id=$2`,
			award, id.InstitutionID).Scan(&studentStatus, &sanctioned); err != nil {
			return err
		}
		var exception *string
		switch {
		case studentStatus != "active":
			e := "student_left"
			exception = &e
		case sanctioned != nil && *sanctioned != amount:
			e := "amount_differs"
			exception = &e
		}
		if creditedOn == nil {
			now := nowInIndia()
			creditedOn = &now
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE scholarship_disbursement_lines
			   SET award_id=$3, match_kind='manual', exception=$4
			 WHERE id=$1 AND institution_id=$2`,
			lineID, id.InstitutionID, award, exception); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE scholarship_awards
			   SET credited_paise=$3::bigint, credited_on=$4,
			       stage = CASE WHEN $3::bigint > 0 THEN 'credited' ELSE stage END,
			       sanctioned_paise = COALESCE(sanctioned_paise, $3::bigint), updated_at=now()
			 WHERE id=$1 AND institution_id=$2`,
			award, id.InstitutionID, amount, *creditedOn)
		return err
	})
	s.concessionWriteResult(w, r, err, map[string]any{"matched": true})
}

// ====================================================== education loan tracker

type loanLenderView struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	LenderKind   string  `json:"lender_kind"`
	Branch       *string `json:"branch,omitempty"`
	ContactName  *string `json:"contact_name,omitempty"`
	ContactPhone *string `json:"contact_phone,omitempty"`
	ContactEmail *string `json:"contact_email,omitempty"`
	IsActive     bool    `json:"is_active"`
	Notes        *string `json:"notes,omitempty"`
	OpenCount    int     `json:"open_count"`
}

func (s *Server) listLoanLenders(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT l.id::text, l.name, l.lender_kind, l.branch, l.contact_name,
		       l.contact_phone, l.contact_email, l.is_active, l.notes,
		       COALESCE(o.n, 0)::int
		  FROM education_loan_lenders l
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS n FROM education_loan_applications ap
		       WHERE ap.lender_id = l.id
		         AND ap.status IN ('documents_pending','submitted_to_lender','under_review')
		  ) o ON true
		 WHERE ($1::bool IS NULL OR l.is_active = $1)
		 ORDER BY l.is_active DESC, l.name, l.branch NULLS FIRST`,
		[]any{nullBool(r.URL.Query().Get("active"))},
		func(rows pgx.Rows) (loanLenderView, error) {
			var v loanLenderView
			return v, rows.Scan(&v.ID, &v.Name, &v.LenderKind, &v.Branch, &v.ContactName,
				&v.ContactPhone, &v.ContactEmail, &v.IsActive, &v.Notes, &v.OpenCount)
		})
	respond(w, r, items, err)
}

type loanLenderRequest struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	LenderKind   string `json:"lender_kind"`
	Branch       string `json:"branch"`
	ContactName  string `json:"contact_name"`
	ContactPhone string `json:"contact_phone"`
	ContactEmail string `json:"contact_email"`
	IsActive     *bool  `json:"is_active"`
	Notes        string `json:"notes"`
}

func (s *Server) saveLoanLender(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req loanLenderRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "what is the lender called?")
		return
	}
	kind := strings.TrimSpace(req.LenderKind)
	if kind == "" {
		kind = "public_sector_bank"
	}
	switch kind {
	case "public_sector_bank", "private_bank", "nbfc", "cooperative", "other":
	default:
		httpx.BadRequest(w, r,
			"lender kind must be public_sector_bank, private_bank, nbfc, cooperative or other")
		return
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) != "" {
			lid, err := uuid.Parse(strings.TrimSpace(req.ID))
			if err != nil {
				return refusal("malformed lender id")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE education_loan_lenders
				   SET name=$3, lender_kind=$4, branch=$5, contact_name=$6,
				       contact_phone=$7, contact_email=$8, is_active=$9, notes=$10,
				       updated_at=now()
				 WHERE id=$1 AND institution_id=$2 RETURNING id::text`,
				lid, id.InstitutionID, req.Name, kind, nullString(req.Branch),
				nullString(req.ContactName), nullString(req.ContactPhone),
				nullString(req.ContactEmail), active, nullString(req.Notes)).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO education_loan_lenders
			    (institution_id, name, lender_kind, branch, contact_name,
			     contact_phone, contact_email, is_active, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text`,
			id.InstitutionID, req.Name, kind, nullString(req.Branch),
			nullString(req.ContactName), nullString(req.ContactPhone),
			nullString(req.ContactEmail), active, nullString(req.Notes),
			id.UserID).Scan(&out)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "duplicate_lender",
			"that lender and branch is already on the list")
		return
	}
	s.concessionWriteResult(w, r, err, map[string]any{"id": out})
}

type loanApplicationView struct {
	ID              string  `json:"id"`
	StudentID       string  `json:"student_id"`
	StudentName     string  `json:"student_name"`
	AdmissionNo     string  `json:"admission_no"`
	ClassName       *string `json:"class_name,omitempty"`
	LenderID        *string `json:"lender_id,omitempty"`
	LenderName      *string `json:"lender_name,omitempty"`
	AcademicYear    *string `json:"academic_year,omitempty"`
	ReferenceNo     *string `json:"reference_no,omitempty"`
	OpenedOn        string  `json:"opened_on"`
	AmountSought    *int64  `json:"amount_sought_paise,omitempty"`
	Status          string  `json:"status"`
	StatusChangedOn string  `json:"status_changed_on"`
	// Reported to the school by the family. The lender tells the school
	// nothing, and the field name in the UI has to say so.
	SanctionedReported *int64  `json:"sanctioned_amount_paise,omitempty"`
	DisbursedReported  *int64  `json:"disbursed_amount_paise,omitempty"`
	OutcomeReportedOn  *string `json:"outcome_reported_on,omitempty"`
	DeclinedReason     *string `json:"declined_reason,omitempty"`
	AssistedBy         *string `json:"assisted_by,omitempty"`
	Notes              *string `json:"notes,omitempty"`
	DocsTotal          int     `json:"docs_total"`
	DocsOutstanding    int     `json:"docs_outstanding"`
	// How long it has sat where it is. The number a family is actually asking
	// about when they telephone.
	DaysInStatus int `json:"days_in_status"`
}

const loanApplicationSelectSQL = `
	SELECT ap.id::text, ap.student_id::text,
	       concat_ws(' ', st.first_name, st.last_name), st.admission_no, cl.name,
	       ap.lender_id::text,
	       CASE WHEN le.id IS NULL THEN NULL
	            ELSE le.name || COALESCE(' — ' || le.branch, '') END,
	       ay.name, ap.reference_no, to_char(ap.opened_on,'YYYY-MM-DD'),
	       ap.amount_sought_paise, ap.status, to_char(ap.status_changed_on,'YYYY-MM-DD'),
	       ap.sanctioned_amount_paise, ap.disbursed_amount_paise,
	       to_char(ap.outcome_reported_on,'YYYY-MM-DD'), ap.declined_reason,
	       u.full_name, ap.notes,
	       COALESCE(d.total, 0)::int, COALESCE(d.outstanding, 0)::int,
	       GREATEST(0, (CURRENT_DATE - ap.status_changed_on))::int
	  FROM education_loan_applications ap
	  JOIN students st ON st.id = ap.student_id
	  LEFT JOIN education_loan_lenders le ON le.id = ap.lender_id
	  LEFT JOIN academic_years ay ON ay.id = ap.academic_year_id
	  LEFT JOIN users u ON u.id = ap.assisted_by
	  LEFT JOIN LATERAL (
	      SELECT count(*) AS total,
	             count(*) FILTER (WHERE status = 'required') AS outstanding
	        FROM education_loan_documents dd WHERE dd.application_id = ap.id
	  ) d ON true
	  LEFT JOIN LATERAL (
	      SELECT e.class_id FROM enrollments e
	       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
	  ) en ON true
	  LEFT JOIN classes cl ON cl.id = en.class_id`

func scanLoanApplication(rows pgx.Rows) (loanApplicationView, error) {
	var v loanApplicationView
	return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
		&v.ClassName, &v.LenderID, &v.LenderName, &v.AcademicYear, &v.ReferenceNo,
		&v.OpenedOn, &v.AmountSought, &v.Status, &v.StatusChangedOn,
		&v.SanctionedReported, &v.DisbursedReported, &v.OutcomeReportedOn,
		&v.DeclinedReason, &v.AssistedBy, &v.Notes, &v.DocsTotal, &v.DocsOutstanding,
		&v.DaysInStatus)
}

func (s *Server) listLoanApplications(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, loanApplicationSelectSQL+`
		 WHERE ($1::text IS NULL OR ap.status = $1)
		   AND ($2::uuid IS NULL OR ap.lender_id = $2)
		   AND ($3::text IS NULL
		        OR st.admission_no ILIKE '%' || $3 || '%'
		        OR concat_ws(' ', st.first_name, st.last_name) ILIKE '%' || $3 || '%')
		 ORDER BY ap.status_changed_on, st.first_name
		 LIMIT $4`,
		[]any{nullString(q.Get("status")), nullUUIDText(q.Get("lender_id")),
			nullString(q.Get("q")), clampInt(q.Get("limit"), 200, 1, 1000)},
		scanLoanApplication)
	respond(w, r, items, err)
}

// loanChecklist is what a lender asks a school for, in the order they ask.
//
// Seeded on every new application so the office has a list to work from rather
// than remembering. Three of these the school already holds — the fee
// structure, the bonafide certificate and the admission letter — which is the
// whole reason a parent should not have to chase them.
var loanChecklist = []string{
	"fee_structure", "bonafide_certificate", "admission_letter",
	"fee_receipts", "marksheet", "id_proof", "address_proof", "income_proof",
}

type loanApplicationRequest struct {
	ID             string `json:"id"`
	StudentID      string `json:"student_id"`
	LenderID       string `json:"lender_id"`
	AcademicYearID string `json:"academic_year_id"`
	ReferenceNo    string `json:"reference_no"`
	OpenedOn       string `json:"opened_on"`
	AmountSought   *int64 `json:"amount_sought_paise"`
	Notes          string `json:"notes"`
}

func (s *Server) saveLoanApplication(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req loanApplicationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(strings.TrimSpace(req.StudentID))
	if err != nil {
		httpx.BadRequest(w, r, "which child is this application for?")
		return
	}
	if req.AmountSought != nil && *req.AmountSought <= 0 {
		httpx.BadRequest(w, r, "an amount sought has to be more than nothing")
		return
	}
	opened := nowInIndia()
	if strings.TrimSpace(req.OpenedOn) != "" {
		d, ok := parseISODate(req.OpenedOn)
		if !ok {
			httpx.BadRequest(w, r, "opened_on must be YYYY-MM-DD")
			return
		}
		opened = d
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) != "" {
			aid, err := uuid.Parse(strings.TrimSpace(req.ID))
			if err != nil {
				return refusal("malformed application id")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE education_loan_applications
				   SET student_id=$3, lender_id=$4, academic_year_id=$5, reference_no=$6,
				       opened_on=$7, amount_sought_paise=$8, notes=$9, updated_at=now()
				 WHERE id=$1 AND institution_id=$2 RETURNING id::text`,
				aid, id.InstitutionID, student, nullUUIDText(req.LenderID),
				nullUUIDText(req.AcademicYearID), nullString(req.ReferenceNo), opened,
				req.AmountSought, nullString(req.Notes)).Scan(&out)
		}

		var newID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO education_loan_applications
			    (institution_id, student_id, lender_id, academic_year_id, reference_no,
			     opened_on, amount_sought_paise, status, status_changed_on,
			     assisted_by, notes)
			VALUES ($1,$2,$3,$4,$5,$6,$7,'documents_pending',$6,$8,$9) RETURNING id`,
			id.InstitutionID, student, nullUUIDText(req.LenderID),
			nullUUIDText(req.AcademicYearID), nullString(req.ReferenceNo), opened,
			req.AmountSought, id.UserID, nullString(req.Notes)).Scan(&newID); err != nil {
			return err
		}
		out = newID.String()

		for _, kind := range loanChecklist {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO education_loan_documents
				    (institution_id, application_id, doc_kind, status, updated_by)
				VALUES ($1,$2,$3,'required',$4)
				ON CONFLICT DO NOTHING`,
				id.InstitutionID, newID, kind, id.UserID); err != nil {
				return err
			}
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO education_loan_events
			    (institution_id, application_id, from_status, to_status, note, actor_user_id)
			VALUES ($1,$2,NULL,'documents_pending',$3,$4)`,
			id.InstitutionID, newID, "Application opened; document checklist issued.",
			id.UserID)
		return err
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "duplicate_application",
			"this child already has a live application with that lender; continue "+
				"that one rather than opening a second")
		return
	}
	s.concessionWriteResult(w, r, err, map[string]any{"id": out})
}

type loanDocumentView struct {
	ID           string  `json:"id"`
	DocKind      string  `json:"doc_kind"`
	Label        *string `json:"label,omitempty"`
	Status       string  `json:"status"`
	ProvidedOn   *string `json:"provided_on,omitempty"`
	WaivedReason *string `json:"waived_reason,omitempty"`
	Notes        *string `json:"notes,omitempty"`
	// Where the document already lives, if the school holds it.
	StudentDocumentID   *string `json:"student_document_id,omitempty"`
	IssuedCertificateID *string `json:"issued_certificate_id,omitempty"`
	CertificateSerial   *string `json:"certificate_serial,omitempty"`
	UpdatedBy           *string `json:"updated_by,omitempty"`
}

type loanEventView struct {
	At         string  `json:"happened_at"`
	FromStatus *string `json:"from_status,omitempty"`
	ToStatus   string  `json:"to_status"`
	Note       *string `json:"note,omitempty"`
	Actor      *string `json:"actor,omitempty"`
}

func (s *Server) getLoanApplication(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	appID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed application id")
		return
	}

	var head loanApplicationView
	docs := []loanDocumentView{}
	events := []loanEventView{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), loanApplicationSelectSQL+
			` WHERE ap.id=$1 AND ap.institution_id=$2`, appID, id.InstitutionID)
		if err != nil {
			return err
		}
		found := false
		for rows.Next() {
			head, err = scanLoanApplication(rows)
			found = true
			if err != nil {
				rows.Close()
				return err
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if !found {
			return pgx.ErrNoRows
		}

		drows, err := tx.Query(r.Context(), `
			SELECT d.id::text, d.doc_kind, d.label, d.status,
			       to_char(d.provided_on,'YYYY-MM-DD'), d.waived_reason, d.notes,
			       d.student_document_id::text, d.issued_certificate_id::text,
			       ic.serial_no, u.full_name
			  FROM education_loan_documents d
			  LEFT JOIN issued_certificates ic ON ic.id = d.issued_certificate_id
			  LEFT JOIN users u ON u.id = d.updated_by
			 WHERE d.application_id=$1 AND d.institution_id=$2
			 -- Outstanding first: the list exists to show what is missing.
			 ORDER BY (d.status <> 'required'), d.doc_kind`,
			appID, id.InstitutionID)
		if err != nil {
			return err
		}
		defer drows.Close()
		for drows.Next() {
			var v loanDocumentView
			if err := drows.Scan(&v.ID, &v.DocKind, &v.Label, &v.Status, &v.ProvidedOn,
				&v.WaivedReason, &v.Notes, &v.StudentDocumentID,
				&v.IssuedCertificateID, &v.CertificateSerial, &v.UpdatedBy); err != nil {
				return err
			}
			docs = append(docs, v)
		}
		if err := drows.Err(); err != nil {
			return err
		}

		erows, err := tx.Query(r.Context(), `
			SELECT to_char(ev.happened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', ev.from_status,
			       ev.to_status, ev.note, u.full_name
			  FROM education_loan_events ev
			  LEFT JOIN users u ON u.id = ev.actor_user_id
			 WHERE ev.application_id=$1 AND ev.institution_id=$2
			 ORDER BY ev.happened_at DESC`, appID, id.InstitutionID)
		if err != nil {
			return err
		}
		defer erows.Close()
		for erows.Next() {
			var v loanEventView
			if err := erows.Scan(&v.At, &v.FromStatus, &v.ToStatus, &v.Note,
				&v.Actor); err != nil {
				return err
			}
			events = append(events, v)
		}
		return erows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"application": head, "documents": docs, "events": events,
			/* Said in the payload, not only in the UI, so it survives being
			   read through the API by whatever renders this next. */
			"disclosure": "The school records the status of this application as " +
				"reported to it. It is not the lender, does not assess or approve " +
				"the loan, and holds no interest rate or repayment schedule.",
		})
	}
}

type loanStatusRequest struct {
	Status             string `json:"status"`
	Note               string `json:"note"`
	LenderID           string `json:"lender_id"`
	ReferenceNo        string `json:"reference_no"`
	SanctionedReported *int64 `json:"sanctioned_amount_paise"`
	DisbursedReported  *int64 `json:"disbursed_amount_paise"`
	DeclinedReason     string `json:"declined_reason"`
	OutcomeReportedOn  string `json:"outcome_reported_on"`
}

// loanTransitions is the ladder, and it only goes forward.
//
// A tracker whose status can be set to anything is a text field with a dropdown
// on it, and a family told "under review" after being told "declined" has been
// told nothing. The one deliberate exception is that a declined or withdrawn
// application can be reopened to documents_pending, because families do
// genuinely try again with more paperwork.
var loanTransitions = map[string][]string{
	"enquiry":             {"documents_pending", "withdrawn"},
	"documents_pending":   {"submitted_to_lender", "withdrawn"},
	"submitted_to_lender": {"under_review", "sanctioned", "declined", "withdrawn"},
	"under_review":        {"sanctioned", "declined", "withdrawn"},
	"sanctioned":          {"disbursed", "withdrawn"},
	"declined":            {"documents_pending"},
	"withdrawn":           {"documents_pending"},
	"disbursed":           {},
}

func (s *Server) setLoanStatus(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	appID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed application id")
		return
	}
	var req loanStatusRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	next := strings.TrimSpace(req.Status)
	if _, known := loanTransitions[next]; !known {
		httpx.BadRequest(w, r, "unknown status: "+next)
		return
	}
	reportedOn, ok := optionalISODay(req.OutcomeReportedOn)
	if !ok {
		httpx.BadRequest(w, r, "outcome_reported_on must be YYYY-MM-DD")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var current string
		var lender *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT status, lender_id FROM education_loan_applications
			 WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			appID, id.InstitutionID).Scan(&current, &lender); err != nil {
			return err
		}
		allowed := false
		for _, a := range loanTransitions[current] {
			if a == next {
				allowed = true
				break
			}
		}
		if !allowed {
			return refusef("an application that is %q cannot become %q", current, next)
		}

		newLender := nullUUIDText(req.LenderID)
		if newLender == nil && lender != nil {
			newLender = *lender
		}
		if newLender == nil {
			switch next {
			case "submitted_to_lender", "under_review", "sanctioned", "declined", "disbursed":
				return refusal("which lender is this with?")
			}
		}
		switch next {
		case "sanctioned":
			if req.SanctionedReported == nil || *req.SanctionedReported <= 0 {
				return refusal("how much did the parent say was sanctioned?")
			}
		case "disbursed":
			if req.DisbursedReported == nil || *req.DisbursedReported <= 0 {
				return refusal("how much did the parent say was disbursed?")
			}
		case "declined":
			if strings.TrimSpace(req.DeclinedReason) == "" {
				return refusal("what reason was the parent given?")
			}
		}
		// Reopening after a decline clears the outcome: the previous refusal is
		// in the event history where it belongs, and leaving the figures on the
		// row would have the screen showing an amount against a live
		// application nobody has decided on.
		clearOutcome := next == "documents_pending"

		if _, err := tx.Exec(r.Context(), `
			UPDATE education_loan_applications
			   SET status=$3, status_changed_on=CURRENT_DATE, lender_id=$4,
			       reference_no=COALESCE($5, reference_no),
			       sanctioned_amount_paise = CASE WHEN $9 THEN NULL
			           ELSE COALESCE($6, sanctioned_amount_paise) END,
			       disbursed_amount_paise  = CASE WHEN $9 THEN NULL
			           ELSE COALESCE($7, disbursed_amount_paise) END,
			       declined_reason = CASE WHEN $3 = 'declined' THEN $8 ELSE NULL END,
			       outcome_reported_on = CASE WHEN $9 THEN NULL
			           ELSE COALESCE($10, outcome_reported_on) END,
			       closed_on = CASE WHEN $3 IN ('disbursed','withdrawn')
			           THEN CURRENT_DATE ELSE NULL END,
			       updated_at=now()
			 WHERE id=$1 AND institution_id=$2`,
			appID, id.InstitutionID, next, newLender, nullString(req.ReferenceNo),
			req.SanctionedReported, req.DisbursedReported,
			nullString(req.DeclinedReason), clearOutcome, reportedOn); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO education_loan_events
			    (institution_id, application_id, from_status, to_status, note, actor_user_id)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			id.InstitutionID, appID, current, next, nullString(req.Note), id.UserID)
		return err
	})
	s.concessionWriteResult(w, r, err, map[string]any{"status": next})
}

type loanDocumentRequest struct {
	ID                  string `json:"id"`
	DocKind             string `json:"doc_kind"`
	Label               string `json:"label"`
	Status              string `json:"status"`
	StudentDocumentID   string `json:"student_document_id"`
	IssuedCertificateID string `json:"issued_certificate_id"`
	ProvidedOn          string `json:"provided_on"`
	WaivedReason        string `json:"waived_reason"`
	Notes               string `json:"notes"`
}

// saveLoanDocument ticks one item off the checklist, or adds one the lender
// asked for that nobody expected.
//
// student_document_id and issued_certificate_id are what make this worth having
// rather than being a list of checkboxes: a bonafide certificate the school
// issued in March is pointed at, not re-uploaded, so the family is not sent
// back to the counter for something the office already has.
func (s *Server) saveLoanDocument(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	appID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed application id")
		return
	}
	var req loanDocumentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	kind := strings.TrimSpace(req.DocKind)
	switch kind {
	case "fee_structure", "bonafide_certificate", "admission_letter", "fee_receipts",
		"marksheet", "id_proof", "address_proof", "income_proof", "photograph", "other":
	default:
		httpx.BadRequest(w, r, "unknown document kind: "+kind)
		return
	}
	if kind == "other" && strings.TrimSpace(req.Label) == "" {
		httpx.BadRequest(w, r, "what is this document called?")
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "required"
	}
	switch status {
	case "required", "provided", "submitted", "verified", "waived":
	default:
		httpx.BadRequest(w, r, "unknown document status: "+status)
		return
	}
	if status == "waived" && strings.TrimSpace(req.WaivedReason) == "" {
		httpx.BadRequest(w, r, "why is this document not needed?")
		return
	}
	provided, ok := optionalISODay(req.ProvidedOn)
	if !ok {
		httpx.BadRequest(w, r, "provided_on must be YYYY-MM-DD")
		return
	}
	if provided == nil && status != "required" && status != "waived" {
		// The database says the same thing; said here so the message names the
		// day rather than the constraint.
		today := nowInIndia()
		provided = &today
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) != "" {
			did, err := uuid.Parse(strings.TrimSpace(req.ID))
			if err != nil {
				return refusal("malformed document id")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE education_loan_documents
				   SET doc_kind=$4, label=$5, status=$6, student_document_id=$7,
				       issued_certificate_id=$8, provided_on=$9, waived_reason=$10,
				       notes=$11, updated_by=$12, updated_at=now()
				 WHERE id=$1 AND application_id=$2 AND institution_id=$3
				 RETURNING id::text`,
				did, appID, id.InstitutionID, kind, nullString(req.Label), status,
				nullUUIDText(req.StudentDocumentID),
				nullUUIDText(req.IssuedCertificateID), provided,
				nullString(req.WaivedReason), nullString(req.Notes),
				id.UserID).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO education_loan_documents
			    (institution_id, application_id, doc_kind, label, status,
			     student_document_id, issued_certificate_id, provided_on,
			     waived_reason, notes, updated_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id::text`,
			id.InstitutionID, appID, kind, nullString(req.Label), status,
			nullUUIDText(req.StudentDocumentID), nullUUIDText(req.IssuedCertificateID),
			provided, nullString(req.WaivedReason), nullString(req.Notes),
			id.UserID).Scan(&out)
	})
	if isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "duplicate_document",
			"that document is already on this application's checklist")
		return
	}
	s.concessionWriteResult(w, r, err, map[string]any{"id": out})
}

// --- shared plumbing ---------------------------------------------------------

// parseISODate reads a required YYYY-MM-DD.
func parseISODate(raw string) (time.Time, bool) {
	t, err := time.Parse(time.DateOnly, strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// optionalISODay reads a YYYY-MM-DD that may be absent. The second return
// distinguishes "not supplied" from "supplied and unreadable" — collapsing
// those two is how a typo becomes a silent NULL.
func optionalISODay(raw string) (*time.Time, bool) {
	if strings.TrimSpace(raw) == "" {
		return nil, true
	}
	t, ok := parseISODate(raw)
	if !ok {
		return nil, false
	}
	return &t, true
}

/*
concessionWriteResult maps a write outcome to the most honest status available.

	refusal carries a sentence a clerk can act on and comes back as 400. A
	missing row is 404 rather than 500, because "that claim is not yours" and
	"that claim does not exist" are the same fact to a caller in another tenant,
	and RLS makes them the same query result.
*/
func (s *Server) concessionWriteResult(w http.ResponseWriter, r *http.Request,
	err error, ok map[string]any) {
	var ref refusal
	switch {
	case err == nil:
		httpx.JSON(w, http.StatusOK, ok)
	case errors.As(err, &ref):
		httpx.BadRequest(w, r, string(ref))
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	default:
		if msg, handled := ledgerRefusal(err); handled {
			httpx.BadRequest(w, r, msg)
			return
		}
		httpx.Internal(w, r, err)
	}
}
