package api

import (
	"context"
	"encoding/json"
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
Four administrative controls, behind /admin-ops.

	Purchasing      requisition -> approval -> order -> receipt -> match
	Mid-day meal    the daily register -> the monthly PM POSHAN return
	360 evaluation  invitations -> anonymous responses -> a released result
	Fee filing      a fee structure version -> a filing -> a committee decision

	Not to be confused with mod_ops.go, which is the operational modules
	themselves — the library desk, the hostel, the stock movement screen. This
	file is the layer of control above three of them, plus the fee regulator.

	Three things are decided here rather than in the browser, and each is the
	reason its feature exists at all:

	  Who may approve a purchase is resolved from the value ladder and checked
	  against the caller's own permissions. A screen that hides the approve
	  button is not a spending control.

	  What a 360 respondent said is never returned attributed, and an
	  aggregate below the cycle's responder floor is not returned at all —
	  to anybody, oversight included. Two responses and a named invitation
	  list is a sentence about two identifiable people.

	  What a school is charging is compared against what the committee
	  approved, from invoice_lines rather than from the fee structure,
	  because the structure is what the school meant to charge and the
	  invoice is what it did.
*/

// --- shared ------------------------------------------------------------------

// adminOpsFail maps a write failure to the most honest status available. Same
// shape as ledgerFail and feeEngineFail, naming the constraint the user
// actually tripped instead of reporting 500 for a data-entry mistake.
func adminOpsFail(w http.ResponseWriter, r *http.Request, err error) {
	var ref refusal
	if errors.As(err, &ref) {
		httpx.BadRequest(w, r, string(ref))
		return
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "purchase_order_lines_not_below_received"):
		httpx.BadRequest(w, r,
			"goods have already been received against this line, so the order cannot be cut below what arrived")
	case strings.Contains(msg, "purchase_orders_no_unique"):
		httpx.BadRequest(w, r, "that purchase order number is already in use")
	case strings.Contains(msg, "purchase_requisitions_no_unique"):
		httpx.BadRequest(w, r, "that requisition number is already in use")
	case strings.Contains(msg, "goods_receipts_no_unique"):
		httpx.BadRequest(w, r, "that GRN number is already in use")
	case strings.Contains(msg, "goods_receipt_lines_one_per_line"):
		httpx.BadRequest(w, r, "that order line is already on this delivery note")
	case strings.Contains(msg, "purchase_invoice_matches_one_per_bill"):
		httpx.BadRequest(w, r, "that vendor bill is already matched to an order")
	case strings.Contains(msg, "mdm_monthly_returns_one_per_month"):
		httpx.BadRequest(w, r, "a return already exists for that month")
	case strings.Contains(msg, "mdm_norms_one_per_stage_date"):
		httpx.BadRequest(w, r, "a norm is already recorded for that stage from that date")
	case strings.Contains(msg, "mdm_foodgrain_receipts_challan"):
		httpx.BadRequest(w, r, "that challan number has already been recorded")
	case strings.Contains(msg, "evaluation_cycles_one_per_name"):
		httpx.BadRequest(w, r, "a cycle of that name already exists for this year")
	case strings.Contains(msg, "evaluation_invitations_one_per_respondent"):
		httpx.BadRequest(w, r, "that person has already been asked about this member of staff")
	case strings.Contains(msg, "evaluation_reviewees_one_per_cycle"):
		httpx.BadRequest(w, r, "that member of staff is already in this cycle")
	case strings.Contains(msg, "fee_regulatory_filings_one_live"):
		httpx.BadRequest(w, r, "a live filing already exists for that year — withdraw it before opening another")
	case strings.Contains(msg, "fee_regulatory_filing_lines_one_per_head"):
		httpx.BadRequest(w, r, "that fee head appears twice for the same class and instalment")
	case strings.Contains(msg, "fee_regulatory_filings_no_unique"):
		httpx.BadRequest(w, r, "that filing number is already in use")
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	default:
		if m, ok := ledgerRefusal(err); ok {
			httpx.BadRequest(w, r, m)
			return
		}
		httpx.Internal(w, r, err)
	}
}

// aoUUID parses a required uuid from a URL segment.
func aoUUID(r *http.Request, key string) (uuid.UUID, error) {
	v, err := uuid.Parse(strings.TrimSpace(chiURLParam(r, key)))
	if err != nil {
		return uuid.Nil, refusef("%s must be a uuid", key)
	}
	return v, nil
}

// aoOptUUID turns an optional uuid string into a SQL argument, refusing
// malformed input rather than silently dropping it. Unlike nullUUIDText this
// is for body fields, where a typo must be reported: a filter nobody set may
// be ignored, but a vendor nobody can parse must not become NULL.
func aoOptUUID(s string) (any, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	u, err := uuid.Parse(s)
	if err != nil {
		return nil, refusal("malformed id: " + s)
	}
	return u, nil
}

// --- mount -------------------------------------------------------------------

/*
mountAdminOps registers the four features under /admin-ops.

	Named for what it is rather than for a module, because the four have no
	module in common — they are the administrative controls over stores, the
	kitchen, the staff room and the fee book. mountAdminRollups (admin_rollups.go)
	is the reporting layer and owns /rollups; nothing here collides with it.

	Permissions are the existing ones from internal/rbac. Nothing new was
	invented: purchasing is stores, so it is operations.inventory.*; the MDM
	return is a statutory return, so it is admin.reports.read to see and
	institution.write to file; a 360 is about staff, so it is hr.employees.*;
	a fee filing is the fee book, so it is finance.fees.*.
*/
func (s *Server) mountAdminOps(r chi.Router) {
	storesRead := httpx.RequirePermission(rbac.InventoryRead)
	storesWrite := httpx.RequirePermission(rbac.InventoryWrite)
	// Configuring who may approve spending is a settings act, not a stores
	// one: the store keeper must not be able to raise their own ceiling.
	spendConfig := httpx.RequirePermission(rbac.SettingsWrite)
	// Accepting an invoice variance authorises a payment.
	payAuth := httpx.RequirePermission(rbac.InvoicesWrite)

	returnsRead := httpx.RequirePermission(rbac.ReportsRead)
	returnsWrite := httpx.RequirePermission(rbac.InstitutionWrite)

	staffRead := httpx.RequirePermission(rbac.EmployeesRead)
	staffWrite := httpx.RequirePermission(rbac.EmployeesWrite)

	feesRead := httpx.RequirePermission(rbac.FeesRead)
	feesWrite := httpx.RequirePermission(rbac.FeesWrite)

	r.Route("/admin-ops", func(r chi.Router) {

		// --- purchasing ---------------------------------------------------
		r.With(storesRead).Get("/purchasing/thresholds", s.listApprovalThresholds)
		r.With(spendConfig).Put("/purchasing/thresholds", s.setApprovalThresholds)

		r.With(storesRead).Get("/purchasing/requisitions", s.listRequisitions)
		r.With(storesRead).Get("/purchasing/requisitions/{id}", s.getRequisition)
		r.With(storesWrite).Post("/purchasing/requisitions", s.saveRequisition)
		r.With(storesWrite).Post("/purchasing/requisitions/{id}/submit", s.submitRequisition)
		// No middleware permission: which permission is needed depends on the
		// value, and the handler resolves the band and checks it. Gating this
		// on a fixed key would either block the correspondent or let the
		// store keeper approve a lakh.
		r.Post("/purchasing/requisitions/{id}/decide", s.decideRequisition)

		r.With(storesRead).Get("/purchasing/orders", s.listPurchaseOrders)
		r.With(storesRead).Get("/purchasing/orders/{id}", s.getPurchaseOrder)
		r.With(storesWrite).Post("/purchasing/orders", s.savePurchaseOrder)
		r.With(storesWrite).Post("/purchasing/orders/{id}/issue", s.issuePurchaseOrder)
		r.With(storesWrite).Post("/purchasing/orders/{id}/close", s.closePurchaseOrder)
		r.With(storesWrite).Post("/purchasing/orders/{id}/receipts", s.recordGoodsReceipt)
		r.With(storesRead).Get("/purchasing/orders/{id}/match", s.previewInvoiceMatch)
		r.With(payAuth).Post("/purchasing/orders/{id}/match", s.recordInvoiceMatch)
		r.With(storesRead).Get("/purchasing/matches", s.listInvoiceMatches)

		// --- mid-day meal -------------------------------------------------
		r.With(returnsRead).Get("/mdm/utilisation", s.getMDMUtilisation)
		r.With(returnsRead).Get("/mdm/returns", s.listMDMReturns)
		r.With(returnsWrite).Post("/mdm/returns", s.saveMDMReturn)
		r.With(returnsWrite).Post("/mdm/returns/{id}/finalise", s.finaliseMDMReturn)
		r.With(returnsWrite).Post("/mdm/returns/{id}/reopen", s.reopenMDMReturn)
		r.With(returnsRead).Get("/mdm/norms", s.listMDMNorms)
		r.With(returnsWrite).Post("/mdm/norms", s.saveMDMNorm)
		r.With(returnsRead).Get("/mdm/foodgrain", s.listFoodgrainReceipts)
		r.With(returnsWrite).Post("/mdm/foodgrain", s.saveFoodgrainReceipt)

		// --- 360 evaluation -----------------------------------------------
		r.With(staffRead).Get("/evaluation/cycles", s.listEvaluationCycles)
		r.With(staffRead).Get("/evaluation/cycles/{id}", s.getEvaluationCycle)
		r.With(staffWrite).Post("/evaluation/cycles", s.saveEvaluationCycle)
		r.With(staffWrite).Put("/evaluation/cycles/{id}/questions", s.setEvaluationQuestions)
		r.With(staffWrite).Post("/evaluation/cycles/{id}/reviewees", s.addEvaluationReviewees)
		r.With(staffWrite).Post("/evaluation/cycles/{id}/invitations", s.inviteEvaluationRespondents)
		r.With(staffWrite).Post("/evaluation/cycles/{id}/status", s.setEvaluationCycleStatus)
		r.With(staffWrite).Post("/evaluation/reviewees/{id}/release", s.releaseEvaluationReviewee)
		// Deliberately ungated: the reviewee reads their own released result,
		// and they do not hold hr.employees.read. The handler decides.
		r.Get("/evaluation/reviewees/{id}/results", s.getEvaluationResults)
		// Also ungated: anybody invited may answer, staff or not.
		r.Get("/evaluation/my-invitations", s.listMyEvaluationInvitations)
		r.Post("/evaluation/invitations/{id}/respond", s.submitEvaluationResponse)

		// --- fee regulatory filing ----------------------------------------
		r.With(feesRead).Get("/fee-filings", s.listFeeFilings)
		r.With(feesRead).Get("/fee-filings/{id}", s.getFeeFiling)
		r.With(feesWrite).Post("/fee-filings", s.saveFeeFiling)
		r.With(feesWrite).Post("/fee-filings/{id}/submit", s.submitFeeFiling)
		r.With(feesWrite).Post("/fee-filings/{id}/decide", s.decideFeeFiling)
		r.With(feesWrite).Post("/fee-filings/{id}/documents", s.attachFeeFilingDocument)
		r.With(feesRead).Get("/fee-filings/{id}/variance", s.getFilingVariance)
	})
}

// errAdminOpsDenied travels out of a transaction closure to say "the caller
// may not do this", which a plain error cannot distinguish from a fault.
var errAdminOpsDenied = errors.New("admin ops: caller lacks the required permission")

// ============================================================================
// PURCHASING
// ============================================================================

type prcThresholdRow struct {
	ID         string `json:"id,omitempty"`
	Label      string `json:"label"`
	UpToPaise  *int64 `json:"up_to_paise,omitempty"`
	Permission string `json:"approver_permission"`
	SortOrder  int    `json:"sort_order"`
}

func ptrInt64(v int64) *int64 { return &v }

/*
prcFallbackLadder is what applies when a school has configured nothing.

	A purchasing module that refuses every approval until somebody fills in a
	settings screen is one nobody adopts; one that lets anyone approve
	anything until configured is worse. So: a two-rung default, shown on the
	screen as a default, which a school overrides by saving its own.

	Fifty thousand rupees is the line most Indian schools already draw for a
	head of department's own signature.
*/
var prcFallbackLadder = []prcThresholdRow{
	{Label: "Stores (up to ₹50,000)", UpToPaise: ptrInt64(5000000), Permission: rbac.InventoryWrite, SortOrder: 1},
	{Label: "Finance (above ₹50,000)", UpToPaise: nil, Permission: rbac.InvoicesWrite, SortOrder: 2},
}

func (s *Server) listApprovalThresholds(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, label, up_to_paise, approver_permission, sort_order
		  FROM purchase_approval_thresholds
		 ORDER BY sort_order, up_to_paise NULLS LAST`, nil,
		func(rows pgx.Rows) (prcThresholdRow, error) {
			var v prcThresholdRow
			return v, rows.Scan(&v.ID, &v.Label, &v.UpToPaise, &v.Permission, &v.SortOrder)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":         items,
		"using_default": len(items) == 0,
		"default":       prcFallbackLadder,
	})
}

type prcThresholdsRequest struct {
	Bands []struct {
		Label      string `json:"label"`
		UpToPaise  *int64 `json:"up_to_paise"`
		Permission string `json:"approver_permission"`
	} `json:"bands"`
}

// setApprovalThresholds replaces the whole ladder. A ladder is only meaningful
// as a set: editing one rung in isolation is how a school ends up with a gap
// no band covers and a requisition nobody is entitled to approve.
func (s *Server) setApprovalThresholds(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req prcThresholdsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Bands) == 0 {
		httpx.BadRequest(w, r, "a ladder needs at least one band")
		return
	}
	known := map[string]bool{}
	for _, p := range rbac.All {
		known[p.Key] = true
	}
	unbounded := 0
	for _, b := range req.Bands {
		if strings.TrimSpace(b.Label) == "" {
			httpx.BadRequest(w, r, "every band needs a label")
			return
		}
		// A band naming a permission nothing grants would refuse every caller
		// for ever, silently. Checked against the seeded vocabulary rather
		// than trusted from the browser.
		if !known[b.Permission] {
			httpx.BadRequest(w, r, "unknown permission: "+b.Permission)
			return
		}
		if b.UpToPaise == nil {
			unbounded++
		} else if *b.UpToPaise <= 0 {
			httpx.BadRequest(w, r, "a ceiling must be more than zero")
			return
		}
	}
	if unbounded != 1 {
		httpx.BadRequest(w, r, "exactly one band must be the top one, with no ceiling")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM purchase_approval_thresholds WHERE institution_id = $1`,
			id.InstitutionID); err != nil {
			return err
		}
		for i, b := range req.Bands {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO purchase_approval_thresholds
				    (institution_id, label, up_to_paise, approver_permission, sort_order)
				VALUES ($1,$2,$3,$4,$5)`,
				id.InstitutionID, strings.TrimSpace(b.Label), b.UpToPaise,
				b.Permission, i+1); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"bands": len(req.Bands)})
}

/*
resolveApprovalBand answers "who has to sign for this much".

	The lowest band whose ceiling reaches the value, unbounded last. With no
	rows configured it falls back to prcFallbackLadder rather than failing
	open: an unresolvable band must never mean "anybody may approve".
*/
func resolveApprovalBand(ctx context.Context, tx pgx.Tx, total int64) (prcThresholdRow, error) {
	var v prcThresholdRow
	err := tx.QueryRow(ctx, `
		SELECT label, up_to_paise, approver_permission
		  FROM purchase_approval_thresholds
		 WHERE up_to_paise IS NULL OR up_to_paise >= $1
		 ORDER BY up_to_paise NULLS LAST
		 LIMIT 1`, total).Scan(&v.Label, &v.UpToPaise, &v.Permission)
	if err == nil {
		return v, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return v, err
	}
	for _, b := range prcFallbackLadder {
		if b.UpToPaise == nil || *b.UpToPaise >= total {
			return b, nil
		}
	}
	return prcFallbackLadder[len(prcFallbackLadder)-1], nil
}

type prcRequisitionRow struct {
	ID            string  `json:"id"`
	No            string  `json:"requisition_no"`
	Department    *string `json:"department,omitempty"`
	RequestedBy   *string `json:"requested_by,omitempty"`
	RaisedOn      string  `json:"raised_on"`
	NeededBy      *string `json:"needed_by,omitempty"`
	Status        string  `json:"status"`
	EstimatePaise int64   `json:"estimated_total_paise"`
	Band          *string `json:"approval_band,omitempty"`
	BandPerm      *string `json:"approval_permission,omitempty"`
	DecidedBy     *string `json:"decided_by,omitempty"`
	DecisionNote  *string `json:"decision_note,omitempty"`
	LineCount     int     `json:"line_count"`
	OrderNo       *string `json:"order_no,omitempty"`
}

func (s *Server) listRequisitions(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT rq.id::text, rq.requisition_no, d.name, u.full_name,
		       to_char(rq.raised_on,'YYYY-MM-DD'), to_char(rq.needed_by,'YYYY-MM-DD'),
		       rq.status, rq.estimated_total_paise, rq.approval_band,
		       rq.approval_permission, du.full_name, rq.decision_note,
		       (SELECT count(*) FROM purchase_requisition_lines l
		         WHERE l.requisition_id = rq.id)::int,
		       (SELECT po.po_no FROM purchase_orders po
		         WHERE po.requisition_id = rq.id ORDER BY po.order_date LIMIT 1)
		  FROM purchase_requisitions rq
		  LEFT JOIN departments d ON d.id = rq.department_id
		  LEFT JOIN users u  ON u.id  = rq.requested_by
		  LEFT JOIN users du ON du.id = rq.decided_by
		 WHERE ($1::text IS NULL OR rq.status = $1)
		 ORDER BY rq.raised_on DESC, rq.requisition_no DESC
		 LIMIT 300`,
		[]any{nullString(r.URL.Query().Get("status"))},
		func(rows pgx.Rows) (prcRequisitionRow, error) {
			var v prcRequisitionRow
			return v, rows.Scan(&v.ID, &v.No, &v.Department, &v.RequestedBy, &v.RaisedOn,
				&v.NeededBy, &v.Status, &v.EstimatePaise, &v.Band, &v.BandPerm,
				&v.DecidedBy, &v.DecisionNote, &v.LineCount, &v.OrderNo)
		})
	respond(w, r, items, err)
}

type prcLineRow struct {
	ID          string  `json:"id"`
	LineNo      int     `json:"line_no"`
	ItemID      *string `json:"item_id,omitempty"`
	ItemCode    *string `json:"item_code,omitempty"`
	Description string  `json:"description"`
	Quantity    int     `json:"quantity"`
	Unit        string  `json:"unit"`
	RatePaise   int64   `json:"rate_paise"`
}

func (s *Server) getRequisition(w http.ResponseWriter, r *http.Request) {
	reqID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var head prcRequisitionRow
	var justification *string
	lines := []prcLineRow{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT rq.id::text, rq.requisition_no, d.name, u.full_name,
			       to_char(rq.raised_on,'YYYY-MM-DD'), to_char(rq.needed_by,'YYYY-MM-DD'),
			       rq.status, rq.estimated_total_paise, rq.approval_band,
			       rq.approval_permission, du.full_name, rq.decision_note,
			       rq.justification
			  FROM purchase_requisitions rq
			  LEFT JOIN departments d ON d.id = rq.department_id
			  LEFT JOIN users u  ON u.id  = rq.requested_by
			  LEFT JOIN users du ON du.id = rq.decided_by
			 WHERE rq.id = $1`, reqID).
			Scan(&head.ID, &head.No, &head.Department, &head.RequestedBy, &head.RaisedOn,
				&head.NeededBy, &head.Status, &head.EstimatePaise, &head.Band,
				&head.BandPerm, &head.DecidedBy, &head.DecisionNote, &justification); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT l.id::text, l.line_no, l.item_id::text, i.code, l.description,
			       l.quantity, l.unit, l.estimated_unit_paise
			  FROM purchase_requisition_lines l
			  LEFT JOIN inventory_items i ON i.id = l.item_id
			 WHERE l.requisition_id = $1 ORDER BY l.line_no`, reqID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v prcLineRow
			if err := rows.Scan(&v.ID, &v.LineNo, &v.ItemID, &v.ItemCode, &v.Description,
				&v.Quantity, &v.Unit, &v.RatePaise); err != nil {
				return err
			}
			lines = append(lines, v)
		}
		return rows.Err()
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	head.LineCount = len(lines)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"requisition": head, "justification": justification, "lines": lines,
	})
}

type prcSaveRequisitionRequest struct {
	ID            string `json:"id,omitempty"`
	RequisitionNo string `json:"requisition_no,omitempty"`
	DepartmentID  string `json:"department_id,omitempty"`
	NeededBy      string `json:"needed_by,omitempty"`
	Justification string `json:"justification,omitempty"`
	Lines         []struct {
		ItemID      string `json:"item_id,omitempty"`
		Description string `json:"description"`
		Quantity    int    `json:"quantity"`
		Unit        string `json:"unit,omitempty"`
		RatePaise   int64  `json:"rate_paise"`
	} `json:"lines"`
}

/*
saveRequisition creates or amends a draft.

	Only a draft. Once submitted, the requisition is what somebody is being
	asked to approve, and a form that could edit it underneath them turns the
	approval into a signature on a blank sheet.
*/
func (s *Server) saveRequisition(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req prcSaveRequisitionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Lines) == 0 {
		httpx.BadRequest(w, r, "a requisition needs at least one line")
		return
	}
	var total int64
	for _, l := range req.Lines {
		if strings.TrimSpace(l.Description) == "" {
			httpx.BadRequest(w, r, "every line needs a description")
			return
		}
		if l.Quantity <= 0 {
			httpx.BadRequest(w, r, "every line needs a quantity above zero")
			return
		}
		if l.RatePaise < 0 {
			httpx.BadRequest(w, r, "a rate cannot be negative")
			return
		}
		total += int64(l.Quantity) * l.RatePaise
	}
	dept, derr := aoOptUUID(req.DepartmentID)
	if derr != nil {
		httpx.BadRequest(w, r, derr.Error())
		return
	}
	var needed any
	if v := strings.TrimSpace(req.NeededBy); v != "" {
		d, perr := time.Parse(time.DateOnly, v)
		if perr != nil {
			httpx.BadRequest(w, r, "needed_by must be a date, as YYYY-MM-DD")
			return
		}
		needed = d
	}

	var reqID uuid.UUID
	var no string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) != "" {
			parsed, perr := uuid.Parse(strings.TrimSpace(req.ID))
			if perr != nil {
				return refusal("malformed requisition id")
			}
			reqID = parsed
			var status string
			if err := tx.QueryRow(r.Context(),
				`SELECT status, requisition_no FROM purchase_requisitions WHERE id = $1 FOR UPDATE`,
				reqID).Scan(&status, &no); err != nil {
				return err
			}
			if status != "draft" {
				return refusal("this requisition has been submitted and can no longer be edited")
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE purchase_requisitions
				   SET department_id = $2, needed_by = $3, justification = NULLIF($4,''),
				       estimated_total_paise = $5, updated_at = now()
				 WHERE id = $1`,
				reqID, dept, needed, strings.TrimSpace(req.Justification), total); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(),
				`DELETE FROM purchase_requisition_lines WHERE requisition_id = $1`, reqID); err != nil {
				return err
			}
		} else {
			no = strings.TrimSpace(req.RequisitionNo)
			if no == "" {
				// Allocate under an advisory lock, as ledgers.go allocates a
				// vendor code: two clerks opening a requisition at the same
				// moment must not both compute PR00007.
				if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`,
					id.InstitutionID.String()+"purchase_requisition"); err != nil {
					return err
				}
				if err := tx.QueryRow(r.Context(), `
					SELECT 'PR' || lpad((COALESCE(max(
					         nullif(substring(requisition_no from '[0-9]+$'), '')::int), 0) + 1)::text, 5, '0')
					  FROM purchase_requisitions WHERE institution_id = $1`,
					id.InstitutionID).Scan(&no); err != nil {
					return err
				}
			}
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO purchase_requisitions
				    (institution_id, requisition_no, department_id, requested_by,
				     needed_by, justification, estimated_total_paise)
				VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7)
				RETURNING id`,
				id.InstitutionID, no, dept, id.UserID, needed,
				strings.TrimSpace(req.Justification), total).Scan(&reqID); err != nil {
				return err
			}
		}

		for i, l := range req.Lines {
			item, ierr := aoOptUUID(l.ItemID)
			if ierr != nil {
				return ierr
			}
			unit := strings.TrimSpace(l.Unit)
			if unit == "" {
				unit = "nos"
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO purchase_requisition_lines
				    (institution_id, requisition_id, item_id, description, quantity,
				     unit, estimated_unit_paise, line_no)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				id.InstitutionID, reqID, item, strings.TrimSpace(l.Description),
				l.Quantity, unit, l.RatePaise, i+1); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": reqID.String(), "requisition_no": no, "estimated_total_paise": total,
	})
}

// submitRequisition freezes the requisition and records which rung its value
// put it on. Stored on the row, so re-configuring the ladder afterwards cannot
// retrospectively change who should have signed.
func (s *Server) submitRequisition(w http.ResponseWriter, r *http.Request) {
	reqID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var band prcThresholdRow
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var total int64
		var lines int
		var justification *string
		if err := tx.QueryRow(r.Context(), `
			SELECT rq.status, rq.estimated_total_paise, rq.justification,
			       (SELECT count(*) FROM purchase_requisition_lines l
			         WHERE l.requisition_id = rq.id)::int
			  FROM purchase_requisitions rq WHERE rq.id = $1 FOR UPDATE`,
			reqID).Scan(&status, &total, &justification, &lines); err != nil {
			return err
		}
		if status != "draft" {
			return refusal("only a draft requisition can be submitted")
		}
		if lines == 0 {
			return refusal("a requisition needs at least one line")
		}
		if justification == nil || strings.TrimSpace(*justification) == "" {
			return refusal("say why this is needed before submitting it")
		}
		b, berr := resolveApprovalBand(r.Context(), tx, total)
		if berr != nil {
			return berr
		}
		band = b
		_, err := tx.Exec(r.Context(), `
			UPDATE purchase_requisitions
			   SET status = 'submitted', submitted_at = now(),
			       approval_band = $2, approval_permission = $3, updated_at = now()
			 WHERE id = $1`, reqID, band.Label, band.Permission)
		return err
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status": "submitted", "approval_band": band.Label,
		"approval_permission": band.Permission,
	})
}

type prcDecisionRequest struct {
	Decision string `json:"decision"` // approve | reject
	Note     string `json:"note,omitempty"`
}

/*
decideRequisition is where the spending control actually lives.

	The permission required is whichever the value band named at submission,
	checked against the caller's own grants here, on the server. A 403 naming
	the band is more useful than a hidden button: the person who cannot
	approve learns who can.

	The requester may not approve their own requisition. Self-approval defeats
	the whole ladder and is the first thing an auditor tests.
*/
func (s *Server) decideRequisition(w http.ResponseWriter, r *http.Request) {
	reqID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req prcDecisionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Decision != "approve" && req.Decision != "reject" {
		httpx.BadRequest(w, r, "decision must be approve or reject")
		return
	}
	if req.Decision == "reject" && strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r, "say why it is being rejected")
		return
	}

	var needPerm, bandLabel string
	var selfApproval bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var perm, label *string
		var requester *uuid.UUID
		var total int64
		if err := tx.QueryRow(r.Context(), `
			SELECT status, approval_permission, approval_band, requested_by,
			       estimated_total_paise
			  FROM purchase_requisitions WHERE id = $1 FOR UPDATE`,
			reqID).Scan(&status, &perm, &label, &requester, &total); err != nil {
			return err
		}
		if status != "submitted" {
			return refusal("only a submitted requisition can be decided")
		}
		// A requisition whose band was never stored is resolved now rather
		// than waved through.
		if perm == nil || strings.TrimSpace(*perm) == "" {
			b, berr := resolveApprovalBand(r.Context(), tx, total)
			if berr != nil {
				return berr
			}
			needPerm, bandLabel = b.Permission, b.Label
		} else {
			needPerm = *perm
			if label != nil {
				bandLabel = *label
			}
		}
		if requester != nil && *requester == id.UserID {
			selfApproval = true
			return nil
		}
		if !id.Can(needPerm) {
			return errAdminOpsDenied
		}
		next := "approved"
		if req.Decision == "reject" {
			next = "rejected"
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE purchase_requisitions
			   SET status = $2, decided_by = $3, decided_at = now(),
			       decision_note = NULLIF($4,''), updated_at = now()
			 WHERE id = $1`, reqID, next, id.UserID, strings.TrimSpace(req.Note))
		return err
	})
	switch {
	case err == nil && selfApproval:
		httpx.Denied(w, r, "you raised this requisition, so you cannot approve it")
	case errors.Is(err, errAdminOpsDenied):
		httpx.Denied(w, r, fmt.Sprintf(
			"a requisition of this value sits in the %q band, which needs %s", bandLabel, needPerm))
	case err != nil:
		adminOpsFail(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"decision": req.Decision})
	}
}

// --- purchase orders ---------------------------------------------------------

type prcOrderRow struct {
	ID            string  `json:"id"`
	No            string  `json:"po_no"`
	Vendor        string  `json:"vendor"`
	VendorID      string  `json:"vendor_id"`
	RequisitionNo *string `json:"requisition_no,omitempty"`
	OrderDate     string  `json:"order_date"`
	ExpectedOn    *string `json:"expected_on,omitempty"`
	Status        string  `json:"status"`
	TotalPaise    int64   `json:"total_paise"`
	ReceivedPaise int64   `json:"received_paise"`
	LineCount     int     `json:"line_count"`
	Outstanding   int     `json:"outstanding_lines"`
	Matched       bool    `json:"invoice_matched"`
}

// prcOrderValueSQL is the money on an order, and on the part of it that has
// arrived. Written once and shared by the list, the detail and the match
// preview, because three places computing "what did we order" three ways is
// how a three-way match stops tying out.
const prcOrderValueSQL = `
	COALESCE((SELECT sum(l.taxable_paise + l.taxable_paise * l.tax_rate_bp / 10000)
	            FROM purchase_order_lines l WHERE l.purchase_order_id = o.id), 0)
	  + o.other_charges_paise,
	COALESCE((SELECT sum(l.received_qty::bigint * l.unit_price_paise
	                     * (10000 + l.tax_rate_bp) / 10000)
	            FROM purchase_order_lines l WHERE l.purchase_order_id = o.id), 0)`

func (s *Server) listPurchaseOrders(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT o.id::text, o.po_no, v.name, o.vendor_id::text, rq.requisition_no,
		       to_char(o.order_date,'YYYY-MM-DD'), to_char(o.expected_on,'YYYY-MM-DD'),
		       o.status, `+prcOrderValueSQL+`,
		       (SELECT count(*) FROM purchase_order_lines l
		         WHERE l.purchase_order_id = o.id)::int,
		       (SELECT count(*) FROM purchase_order_lines l
		         WHERE l.purchase_order_id = o.id AND l.received_qty < l.quantity)::int,
		       EXISTS (SELECT 1 FROM purchase_invoice_matches m
		                WHERE m.purchase_order_id = o.id)
		  FROM purchase_orders o
		  JOIN vendors v ON v.id = o.vendor_id
		  LEFT JOIN purchase_requisitions rq ON rq.id = o.requisition_id
		 WHERE ($1::text IS NULL OR o.status = $1)
		   AND ($2::uuid IS NULL OR o.vendor_id = $2)
		 ORDER BY o.order_date DESC, o.po_no DESC
		 LIMIT 300`,
		[]any{nullString(q.Get("status")), nullUUIDText(q.Get("vendor_id"))},
		func(rows pgx.Rows) (prcOrderRow, error) {
			var v prcOrderRow
			return v, rows.Scan(&v.ID, &v.No, &v.Vendor, &v.VendorID, &v.RequisitionNo,
				&v.OrderDate, &v.ExpectedOn, &v.Status, &v.TotalPaise, &v.ReceivedPaise,
				&v.LineCount, &v.Outstanding, &v.Matched)
		})
	respond(w, r, items, err)
}

type prcOrderLineRow struct {
	ID          string  `json:"id"`
	LineNo      int     `json:"line_no"`
	ItemID      *string `json:"item_id,omitempty"`
	ItemCode    *string `json:"item_code,omitempty"`
	Description string  `json:"description"`
	Quantity    int     `json:"quantity"`
	Unit        string  `json:"unit"`
	PricePaise  int64   `json:"unit_price_paise"`
	TaxRateBP   int     `json:"tax_rate_bp"`
	Received    int     `json:"received_qty"`
	Rejected    int     `json:"rejected_qty"`
	Outstanding int     `json:"outstanding_qty"`
}

type prcReceiptRow struct {
	ID         string  `json:"id"`
	No         string  `json:"grn_no"`
	ReceivedOn string  `json:"received_on"`
	ChallanNo  *string `json:"challan_no,omitempty"`
	ReceivedBy *string `json:"received_by,omitempty"`
	Remarks    *string `json:"remarks,omitempty"`
	Lines      int     `json:"line_count"`
	Units      int     `json:"units_received"`
	Rejected   int     `json:"units_rejected"`
	Stocked    int     `json:"stock_movements"`
}

func (s *Server) getPurchaseOrder(w http.ResponseWriter, r *http.Request) {
	poID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var head prcOrderRow
	var terms, notes, closedReason *string
	lines := []prcOrderLineRow{}
	receipts := []prcReceiptRow{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT o.id::text, o.po_no, v.name, o.vendor_id::text, rq.requisition_no,
			       to_char(o.order_date,'YYYY-MM-DD'), to_char(o.expected_on,'YYYY-MM-DD'),
			       o.status, `+prcOrderValueSQL+`,
			       o.terms, o.notes, o.closed_reason,
			       EXISTS (SELECT 1 FROM purchase_invoice_matches m
			                WHERE m.purchase_order_id = o.id)
			  FROM purchase_orders o
			  JOIN vendors v ON v.id = o.vendor_id
			  LEFT JOIN purchase_requisitions rq ON rq.id = o.requisition_id
			 WHERE o.id = $1`, poID).
			Scan(&head.ID, &head.No, &head.Vendor, &head.VendorID, &head.RequisitionNo,
				&head.OrderDate, &head.ExpectedOn, &head.Status, &head.TotalPaise,
				&head.ReceivedPaise, &terms, &notes, &closedReason, &head.Matched); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT l.id::text, l.line_no, l.item_id::text, i.code, l.description,
			       l.quantity, l.unit, l.unit_price_paise, l.tax_rate_bp,
			       l.received_qty, l.rejected_qty
			  FROM purchase_order_lines l
			  LEFT JOIN inventory_items i ON i.id = l.item_id
			 WHERE l.purchase_order_id = $1 ORDER BY l.line_no`, poID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v prcOrderLineRow
			if err := rows.Scan(&v.ID, &v.LineNo, &v.ItemID, &v.ItemCode, &v.Description,
				&v.Quantity, &v.Unit, &v.PricePaise, &v.TaxRateBP,
				&v.Received, &v.Rejected); err != nil {
				return err
			}
			v.Outstanding = v.Quantity - v.Received
			lines = append(lines, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		grns, err := tx.Query(r.Context(), `
			SELECT g.id::text, g.grn_no, to_char(g.received_on,'YYYY-MM-DD'),
			       g.challan_no, u.full_name, g.remarks,
			       count(l.id)::int,
			       COALESCE(sum(l.quantity_received),0)::int,
			       COALESCE(sum(l.quantity_rejected),0)::int,
			       count(l.inventory_movement_id)::int
			  FROM goods_receipts g
			  LEFT JOIN users u ON u.id = g.received_by
			  LEFT JOIN goods_receipt_lines l ON l.goods_receipt_id = g.id
			 WHERE g.purchase_order_id = $1
			 GROUP BY g.id, u.full_name
			 ORDER BY g.received_on DESC, g.grn_no DESC`, poID)
		if err != nil {
			return err
		}
		defer grns.Close()
		for grns.Next() {
			var v prcReceiptRow
			if err := grns.Scan(&v.ID, &v.No, &v.ReceivedOn, &v.ChallanNo, &v.ReceivedBy,
				&v.Remarks, &v.Lines, &v.Units, &v.Rejected, &v.Stocked); err != nil {
				return err
			}
			receipts = append(receipts, v)
		}
		return grns.Err()
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	head.LineCount = len(lines)
	for _, l := range lines {
		if l.Outstanding > 0 {
			head.Outstanding++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"order": head, "terms": terms, "notes": notes, "closed_reason": closedReason,
		"lines": lines, "receipts": receipts,
	})
}

type prcSaveOrderRequest struct {
	ID            string `json:"id,omitempty"`
	PONo          string `json:"po_no,omitempty"`
	VendorID      string `json:"vendor_id"`
	RequisitionID string `json:"requisition_id,omitempty"`
	ExpectedOn    string `json:"expected_on,omitempty"`
	OtherCharges  int64  `json:"other_charges_paise"`
	Terms         string `json:"terms,omitempty"`
	Notes         string `json:"notes,omitempty"`
	Lines         []struct {
		ItemID      string `json:"item_id,omitempty"`
		Description string `json:"description"`
		Quantity    int    `json:"quantity"`
		Unit        string `json:"unit,omitempty"`
		PricePaise  int64  `json:"unit_price_paise"`
		TaxRateBP   int    `json:"tax_rate_bp"`
	} `json:"lines"`
}

/*
savePurchaseOrder creates a draft order, or amends one.

	Amending is allowed after issue, deliberately: a vendor who cannot supply
	the last twenty chairs is an ordinary Tuesday, and forcing a cancellation
	and a re-issue would break the receipt history that is already attached.
	What is not allowed is cutting a line below what has already arrived, and
	that is refused by purchase_order_lines_not_below_received in the database
	rather than here — so it holds for every future caller too. The handler's
	job is to turn that constraint into a sentence.

	Lines are replaced wholesale on amendment, so the delete has to survive
	the same constraint: a line with receipts against it is updated in place
	rather than deleted and re-inserted, because deleting it would cascade the
	goods receipt lines and silently unwind the stock.
*/
func (s *Server) savePurchaseOrder(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req prcSaveOrderRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Lines) == 0 {
		httpx.BadRequest(w, r, "a purchase order needs at least one line")
		return
	}
	for _, l := range req.Lines {
		if strings.TrimSpace(l.Description) == "" {
			httpx.BadRequest(w, r, "every line needs a description")
			return
		}
		if l.Quantity <= 0 {
			httpx.BadRequest(w, r, "every line needs a quantity above zero")
			return
		}
		if l.PricePaise < 0 {
			httpx.BadRequest(w, r, "a price cannot be negative")
			return
		}
		if l.TaxRateBP < 0 || l.TaxRateBP > 10000 {
			httpx.BadRequest(w, r, "a GST rate is between 0 and 10000 basis points")
			return
		}
	}
	if req.OtherCharges < 0 {
		httpx.BadRequest(w, r, "other charges cannot be negative")
		return
	}
	vendor, verr := uuid.Parse(strings.TrimSpace(req.VendorID))
	if verr != nil {
		httpx.BadRequest(w, r, "choose the vendor this order goes to")
		return
	}
	reqRef, rerr := aoOptUUID(req.RequisitionID)
	if rerr != nil {
		httpx.BadRequest(w, r, rerr.Error())
		return
	}
	var expected any
	if v := strings.TrimSpace(req.ExpectedOn); v != "" {
		d, perr := time.Parse(time.DateOnly, v)
		if perr != nil {
			httpx.BadRequest(w, r, "expected_on must be a date, as YYYY-MM-DD")
			return
		}
		expected = d
	}

	var poID uuid.UUID
	var no string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) != "" {
			parsed, perr := uuid.Parse(strings.TrimSpace(req.ID))
			if perr != nil {
				return refusal("malformed order id")
			}
			poID = parsed
			var status string
			if err := tx.QueryRow(r.Context(),
				`SELECT status, po_no FROM purchase_orders WHERE id = $1 FOR UPDATE`,
				poID).Scan(&status, &no); err != nil {
				return err
			}
			if status == "cancelled" || status == "closed" {
				return refusal("this order is " + status + " and cannot be edited")
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE purchase_orders
				   SET vendor_id = $2, requisition_id = $3, expected_on = $4,
				       other_charges_paise = $5, terms = NULLIF($6,''),
				       notes = NULLIF($7,''), updated_at = now()
				 WHERE id = $1`,
				poID, vendor, reqRef, expected, req.OtherCharges,
				strings.TrimSpace(req.Terms), strings.TrimSpace(req.Notes)); err != nil {
				return err
			}
			// Only lines nothing has been received against may be removed.
			// Deleting a received line would cascade its goods receipt lines
			// and unwind stock that is physically on the shelf.
			if _, err := tx.Exec(r.Context(), `
				DELETE FROM purchase_order_lines
				 WHERE purchase_order_id = $1 AND received_qty = 0 AND rejected_qty = 0`,
				poID); err != nil {
				return err
			}
		} else {
			no = strings.TrimSpace(req.PONo)
			if no == "" {
				if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`,
					id.InstitutionID.String()+"purchase_order"); err != nil {
					return err
				}
				if err := tx.QueryRow(r.Context(), `
					SELECT 'PO' || lpad((COALESCE(max(
					         nullif(substring(po_no from '[0-9]+$'), '')::int), 0) + 1)::text, 5, '0')
					  FROM purchase_orders WHERE institution_id = $1`,
					id.InstitutionID).Scan(&no); err != nil {
					return err
				}
			}
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO purchase_orders
				    (institution_id, po_no, vendor_id, requisition_id, expected_on,
				     other_charges_paise, terms, notes, created_by)
				VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),NULLIF($8,''),$9)
				RETURNING id`,
				id.InstitutionID, no, vendor, reqRef, expected, req.OtherCharges,
				strings.TrimSpace(req.Terms), strings.TrimSpace(req.Notes),
				id.UserID).Scan(&poID); err != nil {
				return err
			}
			if reqRef != nil {
				if _, err := tx.Exec(r.Context(), `
					UPDATE purchase_requisitions SET status = 'ordered', updated_at = now()
					 WHERE id = $1 AND status = 'approved'`, reqRef); err != nil {
					return err
				}
			}
		}

		for i, l := range req.Lines {
			item, ierr := aoOptUUID(l.ItemID)
			if ierr != nil {
				return ierr
			}
			unit := strings.TrimSpace(l.Unit)
			if unit == "" {
				unit = "nos"
			}
			// ON CONFLICT on the line number: an amendment re-sends the whole
			// set, and the received lines survived the delete above.
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO purchase_order_lines
				    (institution_id, purchase_order_id, item_id, description, quantity,
				     unit, unit_price_paise, tax_rate_bp, line_no)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
				ON CONFLICT (purchase_order_id, line_no) DO UPDATE
				   SET item_id = EXCLUDED.item_id,
				       description = EXCLUDED.description,
				       quantity = EXCLUDED.quantity,
				       unit = EXCLUDED.unit,
				       unit_price_paise = EXCLUDED.unit_price_paise,
				       tax_rate_bp = EXCLUDED.tax_rate_bp`,
				id.InstitutionID, poID, item, strings.TrimSpace(l.Description),
				l.Quantity, unit, l.PricePaise, l.TaxRateBP, i+1); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": poID.String(), "po_no": no})
}

func (s *Server) issuePurchaseOrder(w http.ResponseWriter, r *http.Request) {
	poID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var lines int
		if err := tx.QueryRow(r.Context(), `
			SELECT o.status, (SELECT count(*) FROM purchase_order_lines l
			                   WHERE l.purchase_order_id = o.id)::int
			  FROM purchase_orders o WHERE o.id = $1 FOR UPDATE`,
			poID).Scan(&status, &lines); err != nil {
			return err
		}
		if status != "draft" {
			return refusal("only a draft order can be issued")
		}
		if lines == 0 {
			return refusal("an order needs at least one line before it goes to a vendor")
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE purchase_orders
			   SET status = 'issued', issued_by = $2, issued_at = now(), updated_at = now()
			 WHERE id = $1`, poID, id.UserID)
		return err
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "issued"})
}

type prcCloseRequest struct {
	Reason string `json:"reason"`
}

// closePurchaseOrder short-closes an order nobody expects any more of. A
// reason is required by the database; asked for here so the message is a
// sentence rather than a constraint name.
func (s *Server) closePurchaseOrder(w http.ResponseWriter, r *http.Request) {
	poID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req prcCloseRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "say why the balance is being written off")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE purchase_orders
			   SET status = 'closed', closed_reason = $2, updated_at = now()
			 WHERE id = $1 AND status IN ('issued','partly_received','received')`,
			poID, strings.TrimSpace(req.Reason))
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return refusal("only an issued order can be short-closed")
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "closed"})
}

// --- goods receipt -----------------------------------------------------------

type prcReceiptRequest struct {
	GRNNo      string `json:"grn_no,omitempty"`
	ReceivedOn string `json:"received_on,omitempty"`
	ChallanNo  string `json:"challan_no,omitempty"`
	Remarks    string `json:"remarks,omitempty"`
	Lines      []struct {
		LineID   string `json:"purchase_order_line_id"`
		Received int    `json:"quantity_received"`
		Rejected int    `json:"quantity_rejected"`
		Reason   string `json:"rejection_reason,omitempty"`
	} `json:"lines"`
}

/*
recordGoodsReceipt books a delivery against the order.

	Partial is the normal case, so nothing here requires a line to be
	completed and lines the delivery did not contain are simply absent.

	The stock movement is NOT written here. A BEFORE INSERT trigger on
	goods_receipt_lines writes it, and hands back the movement id. That is
	deliberate: a receipt handler that also had to remember to move stock is a
	receipt handler that one day forgets, and then the shelf and the system
	disagree with no way to tell which is right. The trigger also means a
	direct INSERT — a fixture, a data repair, a second handler written next
	year — moves stock too.

	Over-receipt is refused by purchase_order_lines_not_below_received once
	the AFTER trigger rolls the quantity up. Checked here as well, only so the
	message names the line and the number rather than a constraint.
*/
func (s *Server) recordGoodsReceipt(w http.ResponseWriter, r *http.Request) {
	poID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req prcReceiptRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Lines) == 0 {
		httpx.BadRequest(w, r, "record at least one line that arrived")
		return
	}
	received := time.Now()
	if v := strings.TrimSpace(req.ReceivedOn); v != "" {
		d, err := time.Parse(time.DateOnly, v)
		if err != nil {
			httpx.BadRequest(w, r, "received_on must be a date, as YYYY-MM-DD")
			return
		}
		received = d
	}

	var grnID uuid.UUID
	var no string
	var stocked int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE`,
			poID).Scan(&status); err != nil {
			return err
		}
		switch status {
		case "draft":
			return refusal("this order has not been issued to the vendor yet")
		case "cancelled", "closed":
			return refusal("this order is " + status + "; goods cannot be received against it")
		}

		no = strings.TrimSpace(req.GRNNo)
		if no == "" {
			if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`,
				id.InstitutionID.String()+"goods_receipt"); err != nil {
				return err
			}
			if err := tx.QueryRow(r.Context(), `
				SELECT 'GRN' || lpad((COALESCE(max(
				         nullif(substring(grn_no from '[0-9]+$'), '')::int), 0) + 1)::text, 5, '0')
				  FROM goods_receipts WHERE institution_id = $1`,
				id.InstitutionID).Scan(&no); err != nil {
				return err
			}
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO goods_receipts (institution_id, purchase_order_id, grn_no,
			                            received_on, challan_no, received_by, remarks)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,NULLIF($7,''))
			RETURNING id`,
			id.InstitutionID, poID, no, received, strings.TrimSpace(req.ChallanNo),
			id.UserID, strings.TrimSpace(req.Remarks)).Scan(&grnID); err != nil {
			return err
		}

		for _, l := range req.Lines {
			lineID, lerr := uuid.Parse(strings.TrimSpace(l.LineID))
			if lerr != nil {
				return refusal("purchase_order_line_id must be a uuid")
			}
			if l.Received < 0 || l.Rejected < 0 {
				return refusal("a quantity cannot be negative")
			}
			if l.Received == 0 && l.Rejected == 0 {
				continue
			}
			if l.Rejected > 0 && strings.TrimSpace(l.Reason) == "" {
				return refusal("say why the rejected units were rejected")
			}

			var ordered, alreadyIn, lineNo int
			var belongs uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				SELECT quantity, received_qty, line_no, purchase_order_id
				  FROM purchase_order_lines WHERE id = $1 FOR UPDATE`,
				lineID).Scan(&ordered, &alreadyIn, &lineNo, &belongs); err != nil {
				return err
			}
			if belongs != poID {
				return refusal("that line belongs to a different purchase order")
			}
			if alreadyIn+l.Received > ordered {
				return refusef(
					"line %d: %d ordered, %d already received — you cannot receive %d more",
					lineNo, ordered, alreadyIn, l.Received)
			}

			var moved *uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO goods_receipt_lines
				    (institution_id, goods_receipt_id, purchase_order_line_id,
				     quantity_received, quantity_rejected, rejection_reason)
				VALUES ($1,$2,$3,$4,$5,NULLIF($6,''))
				RETURNING inventory_movement_id`,
				id.InstitutionID, grnID, lineID, l.Received, l.Rejected,
				strings.TrimSpace(l.Reason)).Scan(&moved); err != nil {
				return err
			}
			if moved != nil {
				stocked++
			}
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": grnID.String(), "grn_no": no, "stock_movements": stocked,
	})
}

// --- three-way match ---------------------------------------------------------

type prcMatchRow struct {
	ID            string  `json:"id"`
	PONo          string  `json:"po_no"`
	Vendor        string  `json:"vendor"`
	BillNo        string  `json:"bill_no"`
	BillDate      string  `json:"bill_date"`
	OrderedPaise  int64   `json:"ordered_paise"`
	ReceivedPaise int64   `json:"received_paise"`
	InvoicedPaise int64   `json:"invoiced_paise"`
	VariancePaise int64   `json:"variance_paise"`
	Status        string  `json:"status"`
	MatchedOn     string  `json:"matched_on"`
	DecidedBy     *string `json:"decided_by,omitempty"`
	Note          *string `json:"note,omitempty"`
}

/*
previewInvoiceMatch computes the three legs without deciding anything.

	Ordered is the whole order. Received is the part that physically arrived,
	priced at the order rate — rejected units are excluded, because a school
	does not pay for what it sent back. Invoiced is the vendor's bill.

	The exposure is invoiced against received, not invoiced against ordered.
	An invoice for the full order when half of it is still on a lorry is
	exactly the payment this control exists to stop.
*/
func (s *Server) previewInvoiceMatch(w http.ResponseWriter, r *http.Request) {
	poID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	billFilter := nullUUIDText(r.URL.Query().Get("vendor_bill_id"))

	var ordered, receivedVal int64
	var poNo, vendor string
	var vendorID uuid.UUID
	type prcBillOption struct {
		ID     string `json:"id"`
		BillNo string `json:"bill_no"`
		Date   string `json:"bill_date"`
		Total  int64  `json:"total_paise"`
		Status string `json:"status"`
		Taken  bool   `json:"already_matched"`
	}
	bills := []prcBillOption{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT o.po_no, v.name, o.vendor_id, `+prcOrderValueSQL+`
			  FROM purchase_orders o
			  JOIN vendors v ON v.id = o.vendor_id
			 WHERE o.id = $1`, poID).
			Scan(&poNo, &vendor, &vendorID, &ordered, &receivedVal); err != nil {
			return err
		}
		// The vendor's open bills, so the screen can offer the match rather
		// than making somebody paste a uuid.
		rows, err := tx.Query(r.Context(), `
			SELECT b.id::text, b.bill_no, to_char(b.bill_date,'YYYY-MM-DD'),
			       b.total_paise, b.status,
			       EXISTS (SELECT 1 FROM purchase_invoice_matches m
			                WHERE m.vendor_bill_id = b.id)
			  FROM vendor_bills b
			 WHERE b.vendor_id = $1 AND b.status <> 'cancelled'
			   AND ($2::uuid IS NULL OR b.id = $2)
			 ORDER BY b.bill_date DESC LIMIT 100`, vendorID, billFilter)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v prcBillOption
			if err := rows.Scan(&v.ID, &v.BillNo, &v.Date, &v.Total, &v.Status, &v.Taken); err != nil {
				return err
			}
			bills = append(bills, v)
		}
		return rows.Err()
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"po_no": poNo, "vendor": vendor,
		"ordered_paise": ordered, "received_paise": receivedVal,
		"bills": bills,
		"note": "Variance is measured against what was received, not what was ordered. " +
			"An invoice covering goods still in transit is the case this stops.",
	})
}

type prcMatchRequest struct {
	VendorBillID string `json:"vendor_bill_id"`
	Decision     string `json:"decision"` // match | accept_variance | block
	Note         string `json:"note,omitempty"`
}

/*
recordInvoiceMatch freezes the three figures and records the decision.

	Frozen rather than recomputed on read: a match is a decision somebody made
	against the numbers in front of them, and if a later amendment silently
	moved the stored answer, the screen could never show that the match no
	longer holds.

	'match' is refused when the figures do not actually agree. Accepting a
	variance is a separate, named decision that requires a reason — the
	database insists on the reason too, and this is the sentence that explains
	why.
*/
func (s *Server) recordInvoiceMatch(w http.ResponseWriter, r *http.Request) {
	poID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req prcMatchRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	billID, berr := uuid.Parse(strings.TrimSpace(req.VendorBillID))
	if berr != nil {
		httpx.BadRequest(w, r, "choose the vendor bill to match against")
		return
	}
	status := ""
	switch req.Decision {
	case "match":
		status = "matched"
	case "accept_variance":
		status = "variance_accepted"
	case "block":
		status = "blocked"
	default:
		httpx.BadRequest(w, r, "decision must be match, accept_variance or block")
		return
	}
	if status == "variance_accepted" && strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r, "say why the difference is being accepted")
		return
	}

	var ordered, receivedVal, invoiced int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var poVendor, billVendor uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT o.vendor_id, `+prcOrderValueSQL+`
			  FROM purchase_orders o WHERE o.id = $1`, poID).
			Scan(&poVendor, &ordered, &receivedVal); err != nil {
			return err
		}
		var billStatus string
		if err := tx.QueryRow(r.Context(),
			`SELECT vendor_id, total_paise, status FROM vendor_bills WHERE id = $1`,
			billID).Scan(&billVendor, &invoiced, &billStatus); err != nil {
			return err
		}
		if billVendor != poVendor {
			return refusal("that bill is from a different vendor than the order")
		}
		if billStatus == "cancelled" {
			return refusal("that bill has been cancelled")
		}
		if status == "matched" && invoiced != receivedVal {
			return refusef(
				"the bill is %s and the goods received come to %s — accept the variance, with a reason, or block it",
				formatPaise(invoiced), formatPaise(receivedVal))
		}

		var decidedAt any
		if status != "blocked" {
			decidedAt = time.Now()
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO purchase_invoice_matches
			    (institution_id, purchase_order_id, vendor_bill_id, ordered_paise,
			     received_paise, invoiced_paise, status, decided_by, decided_at, note)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULLIF($10,''))
			ON CONFLICT (institution_id, vendor_bill_id) DO UPDATE
			   SET purchase_order_id = EXCLUDED.purchase_order_id,
			       ordered_paise  = EXCLUDED.ordered_paise,
			       received_paise = EXCLUDED.received_paise,
			       invoiced_paise = EXCLUDED.invoiced_paise,
			       status     = EXCLUDED.status,
			       decided_by = EXCLUDED.decided_by,
			       decided_at = EXCLUDED.decided_at,
			       note       = EXCLUDED.note,
			       updated_at = now()`,
			id.InstitutionID, poID, billID, ordered, receivedVal, invoiced,
			status, id.UserID, decidedAt, strings.TrimSpace(req.Note))
		return err
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status": status, "ordered_paise": ordered,
		"received_paise": receivedVal, "invoiced_paise": invoiced,
		"variance_paise": invoiced - receivedVal,
	})
}

func (s *Server) listInvoiceMatches(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT m.id::text, o.po_no, v.name, b.bill_no,
		       to_char(b.bill_date,'YYYY-MM-DD'),
		       m.ordered_paise, m.received_paise, m.invoiced_paise, m.variance_paise,
		       m.status, to_char(m.matched_on,'YYYY-MM-DD'), u.full_name, m.note
		  FROM purchase_invoice_matches m
		  JOIN purchase_orders o ON o.id = m.purchase_order_id
		  JOIN vendor_bills b ON b.id = m.vendor_bill_id
		  JOIN vendors v ON v.id = o.vendor_id
		  LEFT JOIN users u ON u.id = m.decided_by
		 WHERE ($1::text IS NULL OR m.status = $1)
		 ORDER BY abs(m.variance_paise) DESC, m.matched_on DESC
		 LIMIT 300`,
		[]any{nullString(r.URL.Query().Get("status"))},
		func(rows pgx.Rows) (prcMatchRow, error) {
			var v prcMatchRow
			return v, rows.Scan(&v.ID, &v.PONo, &v.Vendor, &v.BillNo, &v.BillDate,
				&v.OrderedPaise, &v.ReceivedPaise, &v.InvoicedPaise, &v.VariancePaise,
				&v.Status, &v.MatchedOn, &v.DecidedBy, &v.Note)
		})
	respond(w, r, items, err)
}

// formatPaise renders paise as rupees for a message a clerk reads. Indian
// digit grouping belongs in the browser; this is only for error sentences,
// where a bare integer of paise is unreadable.
func formatPaise(p int64) string {
	neg := ""
	if p < 0 {
		neg, p = "-", -p
	}
	return fmt.Sprintf("%s₹%d.%02d", neg, p/100, p%100)
}

// ============================================================================
// MID-DAY MEAL UTILISATION
// ============================================================================

// aoMonth parses ?month=YYYY-MM into the first and last day of that month.
// Defaults to the month just gone, which is what a school filing a return is
// almost always looking at.
func aoMonth(v string) (time.Time, time.Time, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		n := nowInIndia()
		first := time.Date(n.Year(), n.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -1, 0)
		return first, first.AddDate(0, 1, -1), nil
	}
	t, err := time.Parse("2006-01", v)
	if err != nil {
		return time.Time{}, time.Time{}, refusal("month must be YYYY-MM")
	}
	first := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	return first, first.AddDate(0, 1, -1), nil
}

type mdmDayRow struct {
	Date        string   `json:"on_date"`
	Enrolled    int      `json:"enrolled"`
	Present     int      `json:"present"`
	MealsServed int      `json:"meals_served"`
	RiceKg      *float64 `json:"rice_kg,omitempty"`
	CostPaise   int64    `json:"cost_paise"`
	Menu        *string  `json:"menu,omitempty"`
	Issues      []string `json:"issues"`
}

type mdmCheck struct {
	Code     string `json:"code"`
	Severity string `json:"severity"` // ok | warn | fail
	Label    string `json:"label"`
	Detail   string `json:"detail"`
}

/*
getMDMUtilisation is the return itself: the month aggregated, reconciled and
checked.

	Nothing here is stored. Every countable figure is summed live from
	mdm_registers, mdm_foodgrain_receipts and the holiday calendar, which is
	the same choice admin_rollups.go made and for the same reason — a report
	that keeps its own copy of the truth eventually disagrees with the screen
	it summarises. What IS stored, on mdm_monthly_returns, is only what
	aggregation cannot know: opening balances, the sanctioned allotment, and
	the school's explanation.

	The checks are the point. A return that merely adds up is a return the
	block office sends back; the questions it will be asked are:

	  - did you serve on every working day, and if not, why
	  - does the grain you consumed match the children you fed, at the norm
	  - does the cooking cost match, at the norm
	  - does opening + lifted - consumed leave a closing balance that is not
	    negative, because a negative one means the register is wrong
	  - are there days where more meals were served than children present

	The last is the one that gets a school into trouble, and it is a pure
	arithmetic check nobody does by hand across thirty rows.
*/
func (s *Server) getMDMUtilisation(w http.ResponseWriter, r *http.Request) {
	first, last, merr := aoMonth(r.URL.Query().Get("month"))
	if merr != nil {
		httpx.BadRequest(w, r, merr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	campus := nullUUIDText(r.URL.Query().Get("campus_id"))

	var (
		days                                    []mdmDayRow
		meals, presentSum, enrolSum, servedDays int
		riceKg, liftedKg                        float64
		costPaise                               int64
		workingDays                             int
		primaryRoll, upperRoll                  int
		grainNorm, upperGrainNorm               int
		costNorm, upperCostNorm                 int64
		grainName                               string
		haveNorms                               bool
		openGrain, allotGrain                   float64
		openCost, allotCost, releasedCost       int64
		returnID, returnStatus                  string
		explanation                             *string
	)
	days = []mdmDayRow{}
	grainName = "rice"

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT to_char(on_date,'YYYY-MM-DD'), enrolled, present, meals_served,
			       rice_kg, cost_paise, menu
			  FROM mdm_registers
			 WHERE on_date BETWEEN $1 AND $2
			   AND ($3::uuid IS NULL OR campus_id = $3)
			 ORDER BY on_date`, first, last, campus)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var d mdmDayRow
			if err := rows.Scan(&d.Date, &d.Enrolled, &d.Present, &d.MealsServed,
				&d.RiceKg, &d.CostPaise, &d.Menu); err != nil {
				return err
			}
			d.Issues = []string{}
			if d.MealsServed > d.Present && d.Present > 0 {
				d.Issues = append(d.Issues, "more meals served than children present")
			}
			if d.MealsServed > d.Enrolled && d.Enrolled > 0 {
				d.Issues = append(d.Issues, "more meals served than children on roll")
			}
			if d.MealsServed > 0 && d.CostPaise == 0 {
				d.Issues = append(d.Issues, "meals served with no cooking cost recorded")
			}
			if d.MealsServed > 0 && (d.RiceKg == nil || *d.RiceKg == 0) {
				d.Issues = append(d.Issues, "meals served with no foodgrain recorded")
			}
			meals += d.MealsServed
			presentSum += d.Present
			enrolSum += d.Enrolled
			costPaise += d.CostPaise
			if d.RiceKg != nil {
				riceKg += *d.RiceKg
			}
			if d.MealsServed > 0 {
				servedDays++
			}
			days = append(days, d)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// Instructional days, using the same shape as getAcademicCalendar in
		// admin_academics.go so the two screens cannot disagree about what a
		// working day is.
		if err := tx.QueryRow(r.Context(), `
			WITH d AS (SELECT g::date AS on_date
			             FROM generate_series($1::date, $2::date, interval '1 day') g),
			marked AS (
			  SELECT d.on_date,
			         EXISTS (SELECT 1 FROM holidays h
			                  WHERE h.kind IN ('holiday','vacation')
			                    AND h.applies_to IN ('all','students')
			                    AND d.on_date BETWEEN h.on_date
			                        AND COALESCE(h.to_date, h.on_date)) AS shut,
			         EXISTS (SELECT 1 FROM holidays h
			                  WHERE h.kind = 'working_day'
			                    AND d.on_date BETWEEN h.on_date
			                        AND COALESCE(h.to_date, h.on_date)) AS working
			    FROM d)
			SELECT count(*) FILTER (
			         WHERE working OR (extract(isodow FROM on_date) <> 7 AND NOT shut))::int
			  FROM marked`, first, last).Scan(&workingDays); err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(sum(quantity_kg), 0)::float8
			  FROM mdm_foodgrain_receipts
			 WHERE lifted_on BETWEEN $1 AND $2
			   AND ($3::uuid IS NULL OR campus_id = $3)`,
			first, last, campus).Scan(&liftedKg); err != nil {
			return err
		}

		// Roll split by stage. classes.level is the class number, so 1-5 is
		// primary and 6-8 upper primary — the scheme's own boundary.
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(count(*) FILTER (WHERE c.level BETWEEN 1 AND 5), 0)::int,
			       COALESCE(count(*) FILTER (WHERE c.level BETWEEN 6 AND 8), 0)::int
			  FROM enrollments e
			  JOIN classes c ON c.id = e.class_id
			  JOIN academic_years y ON y.id = e.academic_year_id
			 WHERE e.status = 'active' AND y.is_current`).
			Scan(&primaryRoll, &upperRoll); err != nil {
			return err
		}

		// The norms in force at the start of the month.
		errN := tx.QueryRow(r.Context(), `
			SELECT
			  COALESCE((SELECT grain_grams_per_child FROM mdm_norms
			             WHERE stage='primary' AND effective_from <= $1
			             ORDER BY effective_from DESC LIMIT 1), 0),
			  COALESCE((SELECT cooking_cost_paise_per_child FROM mdm_norms
			             WHERE stage='primary' AND effective_from <= $1
			             ORDER BY effective_from DESC LIMIT 1), 0),
			  COALESCE((SELECT grain_grams_per_child FROM mdm_norms
			             WHERE stage='upper_primary' AND effective_from <= $1
			             ORDER BY effective_from DESC LIMIT 1), 0),
			  COALESCE((SELECT cooking_cost_paise_per_child FROM mdm_norms
			             WHERE stage='upper_primary' AND effective_from <= $1
			             ORDER BY effective_from DESC LIMIT 1), 0),
			  COALESCE((SELECT grain FROM mdm_norms
			             WHERE effective_from <= $1
			             ORDER BY effective_from DESC LIMIT 1), 'rice')`, first).
			Scan(&grainNorm, &costNorm, &upperGrainNorm, &upperCostNorm, &grainName)
		if errN != nil {
			return errN
		}
		haveNorms = grainNorm > 0 || upperGrainNorm > 0

		// The stored half of the return, if the school has opened one.
		errR := tx.QueryRow(r.Context(), `
			SELECT id::text, status, opening_grain_kg::float8, allotted_grain_kg::float8,
			       opening_cost_paise, allotted_cost_paise, released_cost_paise,
			       variance_explanation
			  FROM mdm_monthly_returns
			 WHERE period_month = $1
			   AND COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid)
			       = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
			first, campus).
			Scan(&returnID, &returnStatus, &openGrain, &allotGrain, &openCost,
				&allotCost, &releasedCost, &explanation)
		if errR != nil && !errors.Is(errR, pgx.ErrNoRows) {
			return errR
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}

	// --- the checks ---------------------------------------------------------
	checks := []mdmCheck{}
	add := func(code, sev, label, detail string) {
		checks = append(checks, mdmCheck{Code: code, Severity: sev, Label: label, Detail: detail})
	}

	switch {
	case workingDays == 0:
		add("serving_days", "warn", "Working days",
			"No working days found in the calendar for this month. Check the holiday list before filing.")
	case servedDays >= workingDays:
		add("serving_days", "ok", "Meals served on every working day",
			fmt.Sprintf("%d serving days against %d working days.", servedDays, workingDays))
	default:
		sev := "warn"
		if servedDays*4 < workingDays*3 {
			sev = "fail"
		}
		add("serving_days", sev, "Meals not served on every working day",
			fmt.Sprintf("%d serving days against %d working days — %d days unexplained. "+
				"The return needs a reason for the gap.",
				servedDays, workingDays, workingDays-servedDays))
	}

	roll := primaryRoll + upperRoll
	if haveNorms && meals > 0 && roll > 0 {
		// Weighted norm: the two stages eat different amounts and a school
		// running both cannot be checked against either figure alone.
		expGrain := (float64(meals) *
			(float64(primaryRoll*grainNorm) + float64(upperRoll*upperGrainNorm)) /
			float64(roll)) / 1000.0
		expCost := int64(float64(meals) *
			(float64(primaryRoll)*float64(costNorm) + float64(upperRoll)*float64(upperCostNorm)) /
			float64(roll))

		add("grain_norm", aoTolerance(riceKg, expGrain, 0.10),
			"Foodgrain against the per-child norm",
			fmt.Sprintf("%.2f kg consumed against %.2f kg expected for %d meals at the norm.",
				riceKg, expGrain, meals))
		add("cost_norm", aoTolerance(float64(costPaise), float64(expCost), 0.10),
			"Cooking cost against the per-child norm",
			fmt.Sprintf("%s spent against %s expected for %d meals at the norm.",
				formatPaise(costPaise), formatPaise(expCost), meals))
	} else if !haveNorms {
		add("norms", "warn", "No per-child norms recorded",
			"Record the PM POSHAN foodgrain and cooking-cost norms so consumption can be checked against entitlement.")
	}

	closingGrain := openGrain + liftedKg - riceKg
	if closingGrain < -0.001 {
		add("grain_balance", "fail", "Foodgrain balance is negative",
			fmt.Sprintf("Opening %.2f + lifted %.2f - consumed %.2f = %.2f kg. "+
				"More grain has been consumed than the school ever held.",
				openGrain, liftedKg, riceKg, closingGrain))
	} else {
		add("grain_balance", "ok", "Foodgrain balance carries forward",
			fmt.Sprintf("Closing balance %.2f kg of %s.", closingGrain, grainName))
	}

	closingCost := openCost + releasedCost - costPaise
	if closingCost < 0 {
		add("cost_balance", "fail", "Cooking cost overspent against funds released",
			fmt.Sprintf("Opening %s + released %s - spent %s = %s.",
				formatPaise(openCost), formatPaise(releasedCost),
				formatPaise(costPaise), formatPaise(closingCost)))
	} else {
		add("cost_balance", "ok", "Cooking cost within funds released",
			fmt.Sprintf("Closing balance %s.", formatPaise(closingCost)))
	}

	flagged := 0
	for _, d := range days {
		if len(d.Issues) > 0 {
			flagged++
		}
	}
	if flagged > 0 {
		add("daily_anomalies", "fail", "Days with an arithmetic problem",
			fmt.Sprintf("%d of %d recorded days need attention before this return is defensible.",
				flagged, len(days)))
	} else if len(days) > 0 {
		add("daily_anomalies", "ok", "Every recorded day ties out", "No day serves more meals than children.")
	}

	avgEnrol, avgPresent := 0, 0
	if len(days) > 0 {
		avgEnrol = enrolSum / len(days)
		avgPresent = presentSum / len(days)
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"month":  first.Format("2006-01"),
		"period": map[string]string{"from": first.Format(time.DateOnly), "to": last.Format(time.DateOnly)},
		"return": map[string]any{"id": returnID, "status": returnStatus, "explanation": explanation},
		"meals": map[string]any{
			"total": meals, "serving_days": servedDays, "working_days": workingDays,
			"avg_enrolment": avgEnrol, "avg_present": avgPresent,
		},
		"foodgrain": map[string]any{
			"grain": grainName, "opening_kg": openGrain, "lifted_kg": liftedKg,
			"allotted_kg": allotGrain, "consumed_kg": riceKg, "closing_kg": closingGrain,
		},
		"cooking_cost_paise": map[string]any{
			"opening": openCost, "allotted": allotCost, "released": releasedCost,
			"spent": costPaise, "closing": closingCost,
		},
		"roll":   map[string]any{"primary": primaryRoll, "upper_primary": upperRoll},
		"checks": checks,
		"days":   days,
	})
}

// aoTolerance grades an actual against an expected figure. Ten per cent either
// way is ordinary — children are absent, portions vary — and beyond that the
// return needs an explanation before it is filed rather than after it is
// returned.
func aoTolerance(actual, expected, tol float64) string {
	if expected == 0 {
		if actual == 0 {
			return "ok"
		}
		return "warn"
	}
	d := (actual - expected) / expected
	if d < 0 {
		d = -d
	}
	switch {
	case d <= tol:
		return "ok"
	case d <= tol*2:
		return "warn"
	default:
		return "fail"
	}
}

type mdmReturnRow struct {
	ID            string  `json:"id"`
	Month         string  `json:"period_month"`
	Status        string  `json:"status"`
	OpeningKg     float64 `json:"opening_grain_kg"`
	AllottedKg    float64 `json:"allotted_grain_kg"`
	OpeningPaise  int64   `json:"opening_cost_paise"`
	AllottedPaise int64   `json:"allotted_cost_paise"`
	ReleasedPaise int64   `json:"released_cost_paise"`
	WorkingDays   *int    `json:"declared_working_days,omitempty"`
	Explanation   *string `json:"variance_explanation,omitempty"`
	FinalisedBy   *string `json:"finalised_by,omitempty"`
	FiledOn       *string `json:"filed_on,omitempty"`
	AckNo         *string `json:"acknowledgement_no,omitempty"`
}

func (s *Server) listMDMReturns(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT t.id::text, to_char(t.period_month,'YYYY-MM'), t.status,
		       t.opening_grain_kg::float8, t.allotted_grain_kg::float8,
		       t.opening_cost_paise, t.allotted_cost_paise, t.released_cost_paise,
		       t.declared_working_days, t.variance_explanation, u.full_name,
		       to_char(t.filed_on,'YYYY-MM-DD'), t.acknowledgement_no
		  FROM mdm_monthly_returns t
		  LEFT JOIN users u ON u.id = t.finalised_by
		 ORDER BY t.period_month DESC LIMIT 60`, nil,
		func(rows pgx.Rows) (mdmReturnRow, error) {
			var v mdmReturnRow
			return v, rows.Scan(&v.ID, &v.Month, &v.Status, &v.OpeningKg, &v.AllottedKg,
				&v.OpeningPaise, &v.AllottedPaise, &v.ReleasedPaise, &v.WorkingDays,
				&v.Explanation, &v.FinalisedBy, &v.FiledOn, &v.AckNo)
		})
	respond(w, r, items, err)
}

type mdmSaveReturnRequest struct {
	Month         string  `json:"month"` // YYYY-MM
	CampusID      string  `json:"campus_id,omitempty"`
	OpeningKg     float64 `json:"opening_grain_kg"`
	AllottedKg    float64 `json:"allotted_grain_kg"`
	OpeningPaise  int64   `json:"opening_cost_paise"`
	AllottedPaise int64   `json:"allotted_cost_paise"`
	ReleasedPaise int64   `json:"released_cost_paise"`
	WorkingDays   *int    `json:"declared_working_days,omitempty"`
	Explanation   string  `json:"variance_explanation,omitempty"`
	Remarks       string  `json:"remarks,omitempty"`
}

// saveMDMReturn opens or amends the draft half of a month's return — the
// balances and allotments that no aggregation can derive. The finalised half
// is refused by the mdm_monthly_returns_frozen trigger, and this handler turns
// that into a sentence.
func (s *Server) saveMDMReturn(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req mdmSaveReturnRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	first, _, merr := aoMonth(req.Month)
	if merr != nil {
		httpx.BadRequest(w, r, merr.Error())
		return
	}
	if req.OpeningKg < 0 || req.AllottedKg < 0 {
		httpx.BadRequest(w, r, "a foodgrain quantity cannot be negative")
		return
	}
	if req.OpeningPaise < 0 || req.AllottedPaise < 0 || req.ReleasedPaise < 0 {
		httpx.BadRequest(w, r, "an amount cannot be negative")
		return
	}
	campus, cerr := aoOptUUID(req.CampusID)
	if cerr != nil {
		httpx.BadRequest(w, r, cerr.Error())
		return
	}

	var retID uuid.UUID
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO mdm_monthly_returns
			    (institution_id, campus_id, period_month, opening_grain_kg,
			     allotted_grain_kg, opening_cost_paise, allotted_cost_paise,
			     released_cost_paise, declared_working_days, variance_explanation, remarks)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULLIF($10,''),NULLIF($11,''))
			ON CONFLICT (institution_id,
			             COALESCE(campus_id,'00000000-0000-0000-0000-000000000000'::uuid),
			             period_month)
			DO UPDATE SET
			     opening_grain_kg      = EXCLUDED.opening_grain_kg,
			     allotted_grain_kg     = EXCLUDED.allotted_grain_kg,
			     opening_cost_paise    = EXCLUDED.opening_cost_paise,
			     allotted_cost_paise   = EXCLUDED.allotted_cost_paise,
			     released_cost_paise   = EXCLUDED.released_cost_paise,
			     declared_working_days = EXCLUDED.declared_working_days,
			     variance_explanation  = EXCLUDED.variance_explanation,
			     remarks               = EXCLUDED.remarks,
			     updated_at            = now()
			RETURNING id`,
			id.InstitutionID, campus, first, req.OpeningKg, req.AllottedKg,
			req.OpeningPaise, req.AllottedPaise, req.ReleasedPaise, req.WorkingDays,
			strings.TrimSpace(req.Explanation), strings.TrimSpace(req.Remarks)).Scan(&retID)
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": retID.String(), "month": first.Format("2006-01")})
}

type mdmFinaliseRequest struct {
	// The computed return as the screen showed it. Stored verbatim as
	// filed_figures so a closed month reads later exactly as it was filed.
	Figures json.RawMessage `json:"figures"`
	FiledOn string          `json:"filed_on,omitempty"`
	AckNo   string          `json:"acknowledgement_no,omitempty"`
}

/*
finaliseMDMReturn freezes the month.

	The figures are taken from the request rather than recomputed here, and
	that is on purpose: what gets frozen must be exactly what the person
	filing looked at and signed off. Recomputing at the moment of finalisation
	would freeze a slightly different return if anything moved in between,
	which is the one thing a frozen copy exists to prevent.

	The trigger in the migration is what actually holds the freeze. This
	handler only puts the copy there.
*/
func (s *Server) finaliseMDMReturn(w http.ResponseWriter, r *http.Request) {
	retID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req mdmFinaliseRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Figures) == 0 || string(req.Figures) == "{}" || string(req.Figures) == "null" {
		httpx.BadRequest(w, r, "the computed return must be supplied so it can be frozen")
		return
	}
	var filed any
	status := "finalised"
	if v := strings.TrimSpace(req.FiledOn); v != "" {
		d, derr := time.Parse(time.DateOnly, v)
		if derr != nil {
			httpx.BadRequest(w, r, "filed_on must be a date, as YYYY-MM-DD")
			return
		}
		filed, status = d, "filed"
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var cur string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM mdm_monthly_returns WHERE id = $1 FOR UPDATE`,
			retID).Scan(&cur); err != nil {
			return err
		}
		if cur != "draft" {
			return refusal("this return is already " + cur + " — reopen it first")
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE mdm_monthly_returns
			   SET status = $2, filed_figures = $3::jsonb, finalised_at = now(),
			       finalised_by = $4, filed_on = $5,
			       acknowledgement_no = NULLIF($6,''), updated_at = now()
			 WHERE id = $1`,
			retID, status, string(req.Figures), id.UserID, filed,
			strings.TrimSpace(req.AckNo))
		return err
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": status})
}

type mdmReopenRequest struct {
	Reason string `json:"reason"`
}

// reopenMDMReturn puts a finalised month back into draft. Deliberate, audited
// and never silent: the frozen copy is cleared only here, and the reason goes
// on the row so the next reader knows a filed return was revisited.
func (s *Server) reopenMDMReturn(w http.ResponseWriter, r *http.Request) {
	retID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req mdmReopenRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "say why a filed return is being reopened")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE mdm_monthly_returns
			   SET status = 'draft', filed_figures = '{}'::jsonb,
			       finalised_at = NULL, finalised_by = NULL,
			       remarks = concat_ws(E'\n', remarks, 'Reopened: ' || $2),
			       updated_at = now()
			 WHERE id = $1 AND status <> 'draft'`,
			retID, strings.TrimSpace(req.Reason))
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return refusal("that return is already open")
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "draft"})
}

type mdmNormRow struct {
	ID            string  `json:"id"`
	Stage         string  `json:"stage"`
	EffectiveFrom string  `json:"effective_from"`
	GrainGrams    int     `json:"grain_grams_per_child"`
	CostPaise     int64   `json:"cooking_cost_paise_per_child"`
	Grain         string  `json:"grain"`
	Note          *string `json:"note,omitempty"`
}

func (s *Server) listMDMNorms(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, stage, to_char(effective_from,'YYYY-MM-DD'),
		       grain_grams_per_child, cooking_cost_paise_per_child, grain, note
		  FROM mdm_norms ORDER BY effective_from DESC, stage`, nil,
		func(rows pgx.Rows) (mdmNormRow, error) {
			var v mdmNormRow
			return v, rows.Scan(&v.ID, &v.Stage, &v.EffectiveFrom, &v.GrainGrams,
				&v.CostPaise, &v.Grain, &v.Note)
		})
	respond(w, r, items, err)
}

type mdmSaveNormRequest struct {
	Stage         string `json:"stage"`
	EffectiveFrom string `json:"effective_from"`
	GrainGrams    int    `json:"grain_grams_per_child"`
	CostPaise     int64  `json:"cooking_cost_paise_per_child"`
	Grain         string `json:"grain,omitempty"`
	Note          string `json:"note,omitempty"`
}

func (s *Server) saveMDMNorm(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req mdmSaveNormRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Stage != "primary" && req.Stage != "upper_primary" {
		httpx.BadRequest(w, r, "stage must be primary or upper_primary")
		return
	}
	from, derr := time.Parse(time.DateOnly, strings.TrimSpace(req.EffectiveFrom))
	if derr != nil {
		httpx.BadRequest(w, r, "effective_from must be a date, as YYYY-MM-DD")
		return
	}
	if req.GrainGrams <= 0 {
		httpx.BadRequest(w, r, "the foodgrain norm must be more than zero grams")
		return
	}
	if req.CostPaise <= 0 {
		httpx.BadRequest(w, r, "the cooking cost norm must be more than zero")
		return
	}
	grain := strings.TrimSpace(req.Grain)
	if grain == "" {
		grain = "rice"
	}

	var normID uuid.UUID
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO mdm_norms (institution_id, stage, effective_from,
			                       grain_grams_per_child, cooking_cost_paise_per_child,
			                       grain, note)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''))
			ON CONFLICT (institution_id, stage, effective_from) DO UPDATE
			   SET grain_grams_per_child = EXCLUDED.grain_grams_per_child,
			       cooking_cost_paise_per_child = EXCLUDED.cooking_cost_paise_per_child,
			       grain = EXCLUDED.grain,
			       note  = EXCLUDED.note
			RETURNING id`,
			id.InstitutionID, req.Stage, from, req.GrainGrams, req.CostPaise,
			grain, strings.TrimSpace(req.Note)).Scan(&normID)
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": normID.String()})
}

type mdmGrainRow struct {
	ID         string  `json:"id"`
	LiftedOn   string  `json:"lifted_on"`
	Grain      string  `json:"grain"`
	QuantityKg float64 `json:"quantity_kg"`
	Source     *string `json:"source,omitempty"`
	ChallanNo  *string `json:"challan_no,omitempty"`
	Remarks    *string `json:"remarks,omitempty"`
	RecordedBy *string `json:"recorded_by,omitempty"`
}

func (s *Server) listFoodgrainReceipts(w http.ResponseWriter, r *http.Request) {
	first, last, merr := aoMonth(r.URL.Query().Get("month"))
	if merr != nil {
		httpx.BadRequest(w, r, merr.Error())
		return
	}
	items, err := collect(s, r, `
		SELECT g.id::text, to_char(g.lifted_on,'YYYY-MM-DD'), g.grain,
		       g.quantity_kg::float8, g.source, g.challan_no, g.remarks, u.full_name
		  FROM mdm_foodgrain_receipts g
		  LEFT JOIN users u ON u.id = g.recorded_by
		 WHERE g.lifted_on BETWEEN $1 AND $2
		 ORDER BY g.lifted_on DESC LIMIT 200`,
		[]any{first, last},
		func(rows pgx.Rows) (mdmGrainRow, error) {
			var v mdmGrainRow
			return v, rows.Scan(&v.ID, &v.LiftedOn, &v.Grain, &v.QuantityKg,
				&v.Source, &v.ChallanNo, &v.Remarks, &v.RecordedBy)
		})
	respond(w, r, items, err)
}

type mdmSaveGrainRequest struct {
	LiftedOn   string  `json:"lifted_on"`
	Grain      string  `json:"grain,omitempty"`
	QuantityKg float64 `json:"quantity_kg"`
	Source     string  `json:"source,omitempty"`
	ChallanNo  string  `json:"challan_no,omitempty"`
	Remarks    string  `json:"remarks,omitempty"`
	CampusID   string  `json:"campus_id,omitempty"`
}

func (s *Server) saveFoodgrainReceipt(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req mdmSaveGrainRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	lifted, derr := time.Parse(time.DateOnly, strings.TrimSpace(req.LiftedOn))
	if derr != nil {
		httpx.BadRequest(w, r, "lifted_on must be a date, as YYYY-MM-DD")
		return
	}
	if req.QuantityKg <= 0 {
		httpx.BadRequest(w, r, "the quantity lifted must be more than zero")
		return
	}
	grain := strings.TrimSpace(req.Grain)
	if grain == "" {
		grain = "rice"
	}
	campus, cerr := aoOptUUID(req.CampusID)
	if cerr != nil {
		httpx.BadRequest(w, r, cerr.Error())
		return
	}

	var recID uuid.UUID
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO mdm_foodgrain_receipts
			    (institution_id, campus_id, lifted_on, grain, quantity_kg,
			     source, challan_no, remarks, recorded_by)
			VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),$9)
			RETURNING id`,
			id.InstitutionID, campus, lifted, grain, req.QuantityKg,
			strings.TrimSpace(req.Source), strings.TrimSpace(req.ChallanNo),
			strings.TrimSpace(req.Remarks), id.UserID).Scan(&recID)
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": recID.String()})
}

// ============================================================================
// 360 EVALUATION OVERSIGHT
// ============================================================================
//
// The hard requirement is anonymity, and it is met in three places at once:
//
//   In the schema. evaluation_responses has no respondent column and
//   evaluation_invitations has no response column. There is no join, in any
//   direction, that reconnects a person to what they said.
//
//   In evlAttributed. 'self' and 'head' are attributed by construction — a
//   reviewee has one head, so pretending the head's rating is anonymous
//   would be a lie the reviewee can see through. They are labelled
//   attributed, and the peer/student/parent directions are not.
//
//   In evlAggregate. A direction with fewer responses than the cycle's floor
//   returns no figures and no comments AT ALL — to the reviewee, and to the
//   principal running the cycle. Suppressing only for the subject would be
//   pointless: two peer responses and a visible invitation list identifies
//   both of them to whoever is looking at the oversight screen.

// evlAttributed reports whether a direction is inherently identifiable, and so
// is shown as attributed rather than pretending to anonymity it cannot have.
func evlAttributed(relation string) bool {
	return relation == "self" || relation == "head"
}

type evlCycleRow struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Purpose      *string  `json:"purpose,omitempty"`
	OpensOn      string   `json:"opens_on"`
	ClosesOn     string   `json:"closes_on"`
	Status       string   `json:"status"`
	MinResponses int      `json:"min_responses"`
	Relations    []string `json:"relations"`
	Reviewees    int      `json:"reviewee_count"`
	Invited      int      `json:"invited"`
	Responded    int      `json:"responded"`
	Questions    int      `json:"question_count"`
}

func (s *Server) listEvaluationCycles(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT c.id::text, c.name, c.purpose,
		       to_char(c.opens_on,'YYYY-MM-DD'), to_char(c.closes_on,'YYYY-MM-DD'),
		       c.status, c.min_responses, c.relations,
		       (SELECT count(*) FROM evaluation_reviewees v WHERE v.cycle_id = c.id)::int,
		       (SELECT count(*) FROM evaluation_invitations i WHERE i.cycle_id = c.id)::int,
		       (SELECT count(*) FROM evaluation_invitations i
		         WHERE i.cycle_id = c.id AND i.status = 'responded')::int,
		       (SELECT count(*) FROM evaluation_questions q WHERE q.cycle_id = c.id)::int
		  FROM evaluation_cycles c
		 ORDER BY c.closes_on DESC LIMIT 100`, nil,
		func(rows pgx.Rows) (evlCycleRow, error) {
			var v evlCycleRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Purpose, &v.OpensOn, &v.ClosesOn,
				&v.Status, &v.MinResponses, &v.Relations, &v.Reviewees, &v.Invited,
				&v.Responded, &v.Questions)
		})
	respond(w, r, items, err)
}

type evlRevieweeRow struct {
	ID         string           `json:"id"`
	EmployeeID string           `json:"employee_id"`
	Name       string           `json:"name"`
	Code       string           `json:"employee_code"`
	Department *string          `json:"department,omitempty"`
	Released   bool             `json:"released"`
	Invited    int              `json:"invited"`
	Responded  int              `json:"responded"`
	Complete   bool             `json:"complete"`
	ByRelation []evlRelationGap `json:"by_relation"`
}

type evlRelationGap struct {
	Relation   string `json:"relation"`
	Invited    int    `json:"invited"`
	Responded  int    `json:"responded"`
	Declined   int    `json:"declined"`
	Attributed bool   `json:"attributed"`
	// True when this direction has enough responses to be shown at all.
	MeetsFloor bool `json:"meets_floor"`
}

/*
getEvaluationCycle is the oversight screen: who has been asked, who has
answered, and where the gaps are.

	Counts only. This endpoint returns no ratings and no comments — the
	results endpoint does that, with the floor applied. Oversight is about
	chasing people, and chasing needs names; reading answers is a different
	act with a different rule.
*/
func (s *Server) getEvaluationCycle(w http.ResponseWriter, r *http.Request) {
	cycleID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var head evlCycleRow
	reviewees := []evlRevieweeRow{}
	type evlQuestionRow struct {
		ID        string   `json:"id"`
		Seq       int      `json:"seq"`
		Prompt    string   `json:"prompt"`
		Kind      string   `json:"kind"`
		MaxRating int      `json:"max_rating"`
		AskedOf   []string `json:"asked_of"`
	}
	questions := []evlQuestionRow{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT c.id::text, c.name, c.purpose,
			       to_char(c.opens_on,'YYYY-MM-DD'), to_char(c.closes_on,'YYYY-MM-DD'),
			       c.status, c.min_responses, c.relations
			  FROM evaluation_cycles c WHERE c.id = $1`, cycleID).
			Scan(&head.ID, &head.Name, &head.Purpose, &head.OpensOn, &head.ClosesOn,
				&head.Status, &head.MinResponses, &head.Relations); err != nil {
			return err
		}

		qs, err := tx.Query(r.Context(), `
			SELECT id::text, seq, prompt, kind, max_rating, asked_of
			  FROM evaluation_questions WHERE cycle_id = $1 ORDER BY seq`, cycleID)
		if err != nil {
			return err
		}
		defer qs.Close()
		for qs.Next() {
			var v evlQuestionRow
			if err := qs.Scan(&v.ID, &v.Seq, &v.Prompt, &v.Kind, &v.MaxRating, &v.AskedOf); err != nil {
				return err
			}
			questions = append(questions, v)
		}
		if err := qs.Err(); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT v.id::text, v.employee_id::text,
			       concat_ws(' ', e.first_name, e.last_name), e.employee_code, d.name,
			       v.released_at IS NOT NULL,
			       COALESCE(i.relation, ''), COALESCE(i.invited,0)::int,
			       COALESCE(i.responded,0)::int, COALESCE(i.declined,0)::int,
			       COALESCE(rc.responses,0)::int
			  FROM evaluation_reviewees v
			  JOIN employees e ON e.id = v.employee_id
			  LEFT JOIN departments d ON d.id = e.department_id
			  LEFT JOIN LATERAL (
			      SELECT n.relation,
			             count(*) AS invited,
			             count(*) FILTER (WHERE n.status='responded') AS responded,
			             count(*) FILTER (WHERE n.status='declined')  AS declined
			        FROM evaluation_invitations n
			       WHERE n.reviewee_id = v.id
			       GROUP BY n.relation
			  ) i ON true
			  LEFT JOIN LATERAL (
			      SELECT count(*) AS responses FROM evaluation_responses s
			       WHERE s.reviewee_id = v.id AND s.relation = i.relation
			  ) rc ON true
			 WHERE v.cycle_id = $1
			 ORDER BY e.first_name, e.last_name, i.relation`, cycleID)
		if err != nil {
			return err
		}
		defer rows.Close()
		byID := map[string]int{}
		for rows.Next() {
			var rid, eid, name, code, relation string
			var dept *string
			var released bool
			var invited, responded, declined, actual int
			if err := rows.Scan(&rid, &eid, &name, &code, &dept, &released,
				&relation, &invited, &responded, &declined, &actual); err != nil {
				return err
			}
			idx, seen := byID[rid]
			if !seen {
				reviewees = append(reviewees, evlRevieweeRow{
					ID: rid, EmployeeID: eid, Name: name, Code: code,
					Department: dept, Released: released, ByRelation: []evlRelationGap{},
				})
				idx = len(reviewees) - 1
				byID[rid] = idx
			}
			if relation == "" {
				continue
			}
			reviewees[idx].Invited += invited
			reviewees[idx].Responded += responded
			reviewees[idx].ByRelation = append(reviewees[idx].ByRelation, evlRelationGap{
				Relation: relation, Invited: invited, Responded: responded,
				Declined: declined, Attributed: evlAttributed(relation),
				MeetsFloor: evlAttributed(relation) || actual >= head.MinResponses,
			})
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for i := range reviewees {
			complete := len(reviewees[i].ByRelation) > 0
			for _, g := range reviewees[i].ByRelation {
				if !g.MeetsFloor {
					complete = false
				}
			}
			reviewees[i].Complete = complete
			head.Invited += reviewees[i].Invited
			head.Responded += reviewees[i].Responded
		}
		head.Reviewees = len(reviewees)
		head.Questions = len(questions)
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"cycle": head, "questions": questions, "reviewees": reviewees,
		"note": fmt.Sprintf(
			"Results are withheld until a direction has at least %d responses. "+
				"Counts are shown so gaps can be chased; answers are not.", head.MinResponses),
	})
}

type evlSaveCycleRequest struct {
	ID             string   `json:"id,omitempty"`
	Name           string   `json:"name"`
	Purpose        string   `json:"purpose,omitempty"`
	AcademicYearID string   `json:"academic_year_id,omitempty"`
	OpensOn        string   `json:"opens_on"`
	ClosesOn       string   `json:"closes_on"`
	MinResponses   int      `json:"min_responses"`
	Relations      []string `json:"relations"`
}

var evlKnownRelations = map[string]bool{
	"head": true, "peer": true, "self": true, "student": true, "parent": true,
}

func (s *Server) saveEvaluationCycle(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req evlSaveCycleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "a cycle needs a name")
		return
	}
	opens, oerr := time.Parse(time.DateOnly, strings.TrimSpace(req.OpensOn))
	if oerr != nil {
		httpx.BadRequest(w, r, "opens_on must be a date, as YYYY-MM-DD")
		return
	}
	closes, cerr := time.Parse(time.DateOnly, strings.TrimSpace(req.ClosesOn))
	if cerr != nil {
		httpx.BadRequest(w, r, "closes_on must be a date, as YYYY-MM-DD")
		return
	}
	if closes.Before(opens) {
		httpx.BadRequest(w, r, "the cycle closes before it opens")
		return
	}
	if len(req.Relations) == 0 {
		httpx.BadRequest(w, r, "choose at least one direction to gather feedback from")
		return
	}
	for _, rel := range req.Relations {
		if !evlKnownRelations[rel] {
			httpx.BadRequest(w, r, "unknown direction: "+rel)
			return
		}
	}
	min := req.MinResponses
	if min == 0 {
		min = 3
	}
	if min < 2 {
		// The database refuses this too. Said here in a sentence, because
		// "check constraint violated" does not explain why it matters.
		httpx.BadRequest(w, r,
			"the anonymity floor cannot be below 2 — with one response, the average names the person who gave it")
		return
	}
	year, yerr := aoOptUUID(req.AcademicYearID)
	if yerr != nil {
		httpx.BadRequest(w, r, yerr.Error())
		return
	}

	var cycleID uuid.UUID
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) != "" {
			parsed, perr := uuid.Parse(strings.TrimSpace(req.ID))
			if perr != nil {
				return refusal("malformed cycle id")
			}
			cycleID = parsed
			var status string
			if err := tx.QueryRow(r.Context(),
				`SELECT status FROM evaluation_cycles WHERE id = $1 FOR UPDATE`,
				cycleID).Scan(&status); err != nil {
				return err
			}
			if status != "draft" {
				// Raising the floor mid-cycle would be fine; lowering it would
				// retrospectively expose responses given under a promise. The
				// simple rule is the defensible one.
				return refusal("this cycle is open — its terms cannot be changed once people have been asked")
			}
			_, err := tx.Exec(r.Context(), `
				UPDATE evaluation_cycles
				   SET name = $2, purpose = NULLIF($3,''), academic_year_id = $4,
				       opens_on = $5, closes_on = $6, min_responses = $7,
				       relations = $8, updated_at = now()
				 WHERE id = $1`,
				cycleID, strings.TrimSpace(req.Name), strings.TrimSpace(req.Purpose),
				year, opens, closes, min, req.Relations)
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO evaluation_cycles
			    (institution_id, name, purpose, academic_year_id, opens_on, closes_on,
			     min_responses, relations, created_by)
			VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9)
			RETURNING id`,
			id.InstitutionID, strings.TrimSpace(req.Name), strings.TrimSpace(req.Purpose),
			year, opens, closes, min, req.Relations, id.UserID).Scan(&cycleID)
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": cycleID.String(), "min_responses": min})
}

type evlQuestionsRequest struct {
	Questions []struct {
		Prompt    string   `json:"prompt"`
		Kind      string   `json:"kind"`
		MaxRating int      `json:"max_rating"`
		AskedOf   []string `json:"asked_of"`
	} `json:"questions"`
}

func (s *Server) setEvaluationQuestions(w http.ResponseWriter, r *http.Request) {
	cycleID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req evlQuestionsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Questions) == 0 {
		httpx.BadRequest(w, r, "a cycle needs at least one question")
		return
	}
	for _, q := range req.Questions {
		if strings.TrimSpace(q.Prompt) == "" {
			httpx.BadRequest(w, r, "every question needs a prompt")
			return
		}
		if q.Kind != "rating" && q.Kind != "text" {
			httpx.BadRequest(w, r, "a question is either a rating or a comment")
			return
		}
		if q.Kind == "rating" && (q.MaxRating < 2 || q.MaxRating > 10) {
			httpx.BadRequest(w, r, "a rating scale runs from 2 to 10 points")
			return
		}
		for _, rel := range q.AskedOf {
			if !evlKnownRelations[rel] {
				httpx.BadRequest(w, r, "unknown direction: "+rel)
				return
			}
		}
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM evaluation_cycles WHERE id = $1 FOR UPDATE`,
			cycleID).Scan(&status); err != nil {
			return err
		}
		if status != "draft" {
			// Changing the questions after answers exist means the stored
			// answers no longer say what they were given in reply to.
			return refusal("this cycle has opened — the questions can no longer be changed")
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM evaluation_questions WHERE cycle_id = $1`, cycleID); err != nil {
			return err
		}
		for i, q := range req.Questions {
			maxR := q.MaxRating
			if q.Kind == "text" {
				maxR = 5 // unused for a comment, but the column is NOT NULL
			}
			asked := q.AskedOf
			if len(asked) == 0 {
				asked = []string{"head", "peer", "self"}
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO evaluation_questions
				    (institution_id, cycle_id, seq, prompt, kind, max_rating, asked_of)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				id.InstitutionID, cycleID, i+1, strings.TrimSpace(q.Prompt),
				q.Kind, maxR, asked); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"questions": len(req.Questions)})
}

type evlRevieweesRequest struct {
	EmployeeIDs []string `json:"employee_ids"`
}

func (s *Server) addEvaluationReviewees(w http.ResponseWriter, r *http.Request) {
	cycleID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req evlRevieweesRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.EmployeeIDs) == 0 {
		httpx.BadRequest(w, r, "choose at least one member of staff")
		return
	}
	added := 0
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM evaluation_cycles WHERE id = $1`, cycleID).Scan(&status); err != nil {
			return err
		}
		if status == "closed" || status == "released" {
			return refusal("this cycle has closed")
		}
		for _, e := range req.EmployeeIDs {
			emp, eerr := uuid.Parse(strings.TrimSpace(e))
			if eerr != nil {
				return refusal("malformed employee id: " + e)
			}
			ct, err := tx.Exec(r.Context(), `
				INSERT INTO evaluation_reviewees (institution_id, cycle_id, employee_id)
				VALUES ($1,$2,$3)
				ON CONFLICT (cycle_id, employee_id) DO NOTHING`,
				id.InstitutionID, cycleID, emp)
			if err != nil {
				return err
			}
			added += int(ct.RowsAffected())
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"added": added})
}

type evlInviteRequest struct {
	RevieweeID  string `json:"reviewee_id"`
	Invitations []struct {
		Relation string `json:"relation"`
		UserID   string `json:"respondent_user_id,omitempty"`
		Label    string `json:"respondent_label,omitempty"`
	} `json:"invitations"`
}

/*
inviteEvaluationRespondents asks people.

	A self-invitation is the reviewee themselves, so the handler fills the
	user in from the employee record rather than making the principal look it
	up — and refuses a self-invitation addressed to anybody else, which would
	be a straightforward mislabelling of whose view a rating is.
*/
func (s *Server) inviteEvaluationRespondents(w http.ResponseWriter, r *http.Request) {
	cycleID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req evlInviteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	revieweeID, rerr := uuid.Parse(strings.TrimSpace(req.RevieweeID))
	if rerr != nil {
		httpx.BadRequest(w, r, "reviewee_id must be a uuid")
		return
	}
	if len(req.Invitations) == 0 {
		httpx.BadRequest(w, r, "add at least one person to ask")
		return
	}

	invited := 0
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var relations []string
		if err := tx.QueryRow(r.Context(),
			`SELECT status, relations FROM evaluation_cycles WHERE id = $1`,
			cycleID).Scan(&status, &relations); err != nil {
			return err
		}
		if status == "closed" || status == "released" {
			return refusal("this cycle has closed")
		}
		allowed := map[string]bool{}
		for _, rel := range relations {
			allowed[rel] = true
		}

		var subjectUser *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT e.user_id FROM evaluation_reviewees v
			  JOIN employees e ON e.id = v.employee_id
			 WHERE v.id = $1 AND v.cycle_id = $2`, revieweeID, cycleID).
			Scan(&subjectUser); err != nil {
			return err
		}

		for _, inv := range req.Invitations {
			if !allowed[inv.Relation] {
				return refusal("this cycle does not gather feedback from: " + inv.Relation)
			}
			var user any
			label := strings.TrimSpace(inv.Label)
			if inv.Relation == "self" {
				if subjectUser == nil {
					return refusal("that member of staff has no login, so they cannot rate themselves")
				}
				user = *subjectUser
				label = ""
			} else {
				u, uerr := aoOptUUID(inv.UserID)
				if uerr != nil {
					return uerr
				}
				user = u
				if u == nil && label == "" {
					return refusal("an invitation needs either a user or a name to address it to")
				}
			}
			ct, err := tx.Exec(r.Context(), `
				INSERT INTO evaluation_invitations
				    (institution_id, cycle_id, reviewee_id, relation,
				     respondent_user_id, respondent_label)
				VALUES ($1,$2,$3,$4,$5,NULLIF($6,''))
				ON CONFLICT (reviewee_id, relation,
				             COALESCE(respondent_user_id,'00000000-0000-0000-0000-000000000000'::uuid),
				             lower(btrim(COALESCE(respondent_label,''))))
				DO NOTHING`,
				id.InstitutionID, cycleID, revieweeID, inv.Relation, user, label)
			if err != nil {
				return err
			}
			invited += int(ct.RowsAffected())
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"invited": invited})
}

type evlStatusRequest struct {
	Status string `json:"status"` // open | closed | released
}

func (s *Server) setEvaluationCycleStatus(w http.ResponseWriter, r *http.Request) {
	cycleID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req evlStatusRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	switch req.Status {
	case "open", "closed", "released":
	default:
		httpx.BadRequest(w, r, "status must be open, closed or released")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var cur string
		var questions, reviewees int
		if err := tx.QueryRow(r.Context(), `
			SELECT c.status,
			       (SELECT count(*) FROM evaluation_questions q WHERE q.cycle_id = c.id)::int,
			       (SELECT count(*) FROM evaluation_reviewees v WHERE v.cycle_id = c.id)::int
			  FROM evaluation_cycles c WHERE c.id = $1 FOR UPDATE`,
			cycleID).Scan(&cur, &questions, &reviewees); err != nil {
			return err
		}
		switch req.Status {
		case "open":
			if cur != "draft" {
				return refusal("only a draft cycle can be opened")
			}
			if questions == 0 {
				return refusal("write the questions before opening the cycle")
			}
			if reviewees == 0 {
				return refusal("add the staff being evaluated before opening the cycle")
			}
		case "closed":
			if cur != "open" {
				return refusal("only an open cycle can be closed")
			}
		case "released":
			if cur != "closed" {
				// Releasing while responses are still arriving means a
				// reviewee reads a partial result and, worse, can watch it
				// move as each remaining peer answers.
				return refusal("close the cycle before releasing results")
			}
		}
		var releasedAt any
		if req.Status == "released" {
			releasedAt = time.Now()
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE evaluation_cycles
			   SET status = $2,
			       released_at = CASE WHEN $2 = 'released' THEN $3::timestamptz ELSE NULL END,
			       released_by = CASE WHEN $2 = 'released' THEN $4::uuid ELSE NULL END,
			       updated_at = now()
			 WHERE id = $1`, cycleID, req.Status, releasedAt, id.UserID)
		return err
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": req.Status})
}

// releaseEvaluationReviewee opens one person's result to them. Per-person
// rather than per-cycle so twenty complete reviews are not held hostage to
// three stragglers.
func (s *Server) releaseEvaluationReviewee(w http.ResponseWriter, r *http.Request) {
	revID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(), `
			SELECT c.status FROM evaluation_reviewees v
			  JOIN evaluation_cycles c ON c.id = v.cycle_id
			 WHERE v.id = $1`, revID).Scan(&status); err != nil {
			return err
		}
		if status != "closed" && status != "released" {
			return refusal("close the cycle before releasing anybody's result")
		}
		_, err := tx.Exec(r.Context(),
			`UPDATE evaluation_reviewees SET released_at = now() WHERE id = $1`, revID)
		return err
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"released": true})
}

type evlScoreRow struct {
	QuestionID string   `json:"question_id"`
	Seq        int      `json:"seq"`
	Prompt     string   `json:"prompt"`
	Kind       string   `json:"kind"`
	MaxRating  int      `json:"max_rating"`
	Responses  int      `json:"responses"`
	Average    *float64 `json:"average,omitempty"`
	Low        *int     `json:"low,omitempty"`
	High       *int     `json:"high,omitempty"`
	Comments   []string `json:"comments"`
}

type evlRelationResult struct {
	Relation   string        `json:"relation"`
	Responses  int           `json:"responses"`
	Attributed bool          `json:"attributed"`
	Suppressed bool          `json:"suppressed"`
	Reason     string        `json:"suppressed_reason,omitempty"`
	Questions  []evlScoreRow `json:"questions"`
}

/*
getEvaluationResults is the endpoint the whole anonymity requirement rests on.

	Two callers, two rules:

	  Oversight (hr.employees.read) sees results once the cycle is closed.
	  Earlier than that, a principal watching averages move as each peer
	  answers can deduce who said what by subtraction, which is the same leak
	  by a slower route.

	  The reviewee sees their own result once it has been released to them,
	  and nothing before.

	Anybody else gets 403, including a member of staff asking about a
	colleague. Enforced here — there is no query-string that changes it and
	no client flag that relaxes it.

	Then, for both callers alike, every anonymous direction with fewer
	responses than the cycle's floor is returned with no figures and no
	comments. Suppressing only for the reviewee would be theatre: the
	oversight screen already lists who was invited, so a visible two-response
	average names both of them.

	Per-respondent rows are not withheld — they do not exist. The schema has
	no column joining a response to an invitation, so there is nothing here to
	filter out and nothing a future handler could accidentally select.
*/
func (s *Server) getEvaluationResults(w http.ResponseWriter, r *http.Request) {
	revID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	oversight := id.Can(rbac.EmployeesRead)

	var (
		cycleStatus, cycleName, subjectName string
		minResponses                        int
		released                            bool
		subjectUser                         *uuid.UUID
		denied                              bool
		deniedWhy                           string
	)
	results := []evlRelationResult{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT c.status, c.name, c.min_responses,
			       v.released_at IS NOT NULL,
			       concat_ws(' ', e.first_name, e.last_name), e.user_id
			  FROM evaluation_reviewees v
			  JOIN evaluation_cycles c ON c.id = v.cycle_id
			  JOIN employees e ON e.id = v.employee_id
			 WHERE v.id = $1`, revID).
			Scan(&cycleStatus, &cycleName, &minResponses, &released,
				&subjectName, &subjectUser); err != nil {
			return err
		}

		isSubject := subjectUser != nil && *subjectUser == id.UserID
		switch {
		case oversight && (cycleStatus == "closed" || cycleStatus == "released"):
		case oversight:
			denied = true
			deniedWhy = "results are not readable until the cycle is closed — " +
				"watching an average move as each response arrives identifies the respondent"
			return nil
		case isSubject && released:
		case isSubject:
			denied = true
			deniedWhy = "your results have not been released to you yet"
			return nil
		default:
			denied = true
			deniedWhy = "a 360 result is readable by the person it is about and by whoever runs the cycle"
			return nil
		}

		/* One pass over the answers, grouped by direction and question.

		   The counts come from evaluation_responses rather than from the
		   answer rows: a respondent who skipped a question still counts as a
		   respondent for the floor, and counting per-question would let a
		   direction slip below the floor question by question and expose the
		   one person who answered that one. */
		rows, err := tx.Query(r.Context(), `
			SELECT s.relation, q.id::text, q.seq, q.prompt, q.kind, q.max_rating,
			       count(*) FILTER (WHERE a.rating IS NOT NULL)::int,
			       avg(a.rating)::float8, min(a.rating)::int, max(a.rating)::int,
			       COALESCE(array_agg(a.comment) FILTER (
			           WHERE nullif(btrim(a.comment),'') IS NOT NULL), '{}')
			  FROM evaluation_responses s
			  JOIN evaluation_answers a ON a.response_id = s.id
			  JOIN evaluation_questions q ON q.id = a.question_id
			 WHERE s.reviewee_id = $1
			 GROUP BY s.relation, q.id, q.seq, q.prompt, q.kind, q.max_rating
			 ORDER BY s.relation, q.seq`, revID)
		if err != nil {
			return err
		}
		defer rows.Close()
		byRel := map[string]int{}
		for rows.Next() {
			var rel string
			var sc evlScoreRow
			var avg *float64
			var low, high *int
			if err := rows.Scan(&rel, &sc.QuestionID, &sc.Seq, &sc.Prompt, &sc.Kind,
				&sc.MaxRating, &sc.Responses, &avg, &low, &high, &sc.Comments); err != nil {
				return err
			}
			sc.Average, sc.Low, sc.High = avg, low, high
			if sc.Comments == nil {
				sc.Comments = []string{}
			}
			idx, seen := byRel[rel]
			if !seen {
				results = append(results, evlRelationResult{
					Relation: rel, Attributed: evlAttributed(rel), Questions: []evlScoreRow{},
				})
				idx = len(results) - 1
				byRel[rel] = idx
			}
			results[idx].Questions = append(results[idx].Questions, sc)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// Responder counts per direction, which is what the floor is measured
		// against.
		counts, err := tx.Query(r.Context(), `
			SELECT relation, count(*)::int FROM evaluation_responses
			 WHERE reviewee_id = $1 GROUP BY relation`, revID)
		if err != nil {
			return err
		}
		defer counts.Close()
		for counts.Next() {
			var rel string
			var n int
			if err := counts.Scan(&rel, &n); err != nil {
				return err
			}
			if idx, ok := byRel[rel]; ok {
				results[idx].Responses = n
			} else {
				results = append(results, evlRelationResult{
					Relation: rel, Responses: n, Attributed: evlAttributed(rel),
					Questions: []evlScoreRow{},
				})
				byRel[rel] = len(results) - 1
			}
		}
		return counts.Err()
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	if denied {
		httpx.Denied(w, r, deniedWhy)
		return
	}

	// THE SUPPRESSION. Applied after the query, to the response, for every
	// caller — the figures are dropped from the payload rather than merely
	// hidden by the screen.
	suppressed := 0
	for i := range results {
		if results[i].Attributed || results[i].Responses >= minResponses {
			continue
		}
		results[i].Suppressed = true
		results[i].Questions = []evlScoreRow{}
		results[i].Reason = fmt.Sprintf(
			"%d of the %d responses needed. Showing an average of so few would identify who gave it.",
			results[i].Responses, minResponses)
		suppressed++
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"cycle":      map[string]any{"name": cycleName, "status": cycleStatus, "min_responses": minResponses},
		"subject":    subjectName,
		"viewer":     map[string]any{"oversight": oversight, "released": released},
		"results":    results,
		"suppressed": suppressed,
		"anonymity_note": "Peer, student and parent feedback is aggregated only. " +
			"Head and self ratings are shown as attributed, because a reviewee has one head " +
			"and pretending otherwise would be a fiction the reviewee can see through.",
	})
}

type evlMyInvitationRow struct {
	ID       string `json:"id"`
	Cycle    string `json:"cycle"`
	CycleID  string `json:"cycle_id"`
	Relation string `json:"relation"`
	About    string `json:"about"`
	ClosesOn string `json:"closes_on"`
	Status   string `json:"status"`
}

// listMyEvaluationInvitations is the respondent's own queue. Scoped to the
// caller in SQL, not by a query parameter: an invitation list filtered by an
// id the client supplies is an invitation list anybody can read.
func (s *Server) listMyEvaluationInvitations(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items, err := collect(s, r, `
		SELECT i.id::text, c.name, c.id::text, i.relation,
		       concat_ws(' ', e.first_name, e.last_name),
		       to_char(c.closes_on,'YYYY-MM-DD'), i.status
		  FROM evaluation_invitations i
		  JOIN evaluation_cycles c ON c.id = i.cycle_id
		  JOIN evaluation_reviewees v ON v.id = i.reviewee_id
		  JOIN employees e ON e.id = v.employee_id
		 WHERE i.respondent_user_id = $1 AND c.status = 'open'
		 ORDER BY c.closes_on, e.first_name`,
		[]any{id.UserID},
		func(rows pgx.Rows) (evlMyInvitationRow, error) {
			var v evlMyInvitationRow
			return v, rows.Scan(&v.ID, &v.Cycle, &v.CycleID, &v.Relation, &v.About,
				&v.ClosesOn, &v.Status)
		})
	respond(w, r, items, err)
}

type evlRespondRequest struct {
	Decline bool   `json:"decline,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Answers []struct {
		QuestionID string `json:"question_id"`
		Rating     *int   `json:"rating,omitempty"`
		Comment    string `json:"comment,omitempty"`
	} `json:"answers"`
}

/*
submitEvaluationResponse writes the answers and severs them from the person.

	Two inserts, deliberately unlinked. The invitation is marked responded, so
	the oversight screen can stop chasing; the response is written with only
	the cycle, the reviewee and the direction. Nothing carries the invitation
	id across, and there is no column that could.

	The invitation is verified to belong to the caller first. Without that,
	the id in the URL would be an authorization decision made by whoever typed
	it, and one person could answer in another's name — which would corrupt
	the floor as well as the content.
*/
func (s *Server) submitEvaluationResponse(w http.ResponseWriter, r *http.Request) {
	invID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req evlRespondRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !req.Decline && len(req.Answers) == 0 {
		httpx.BadRequest(w, r, "answer at least one question, or decline")
		return
	}

	var notMine bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var owner *uuid.UUID
		var status, relation, cycleStatus string
		var cycleID, revieweeID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT i.respondent_user_id, i.status, i.relation, i.cycle_id,
			       i.reviewee_id, c.status
			  FROM evaluation_invitations i
			  JOIN evaluation_cycles c ON c.id = i.cycle_id
			 WHERE i.id = $1 FOR UPDATE OF i`, invID).
			Scan(&owner, &status, &relation, &cycleID, &revieweeID, &cycleStatus); err != nil {
			return err
		}
		if owner == nil || *owner != id.UserID {
			notMine = true
			return nil
		}
		if cycleStatus != "open" {
			return refusal("this evaluation cycle is not open")
		}
		if status == "responded" {
			return refusal("you have already answered this one")
		}

		if req.Decline {
			_, err := tx.Exec(r.Context(), `
				UPDATE evaluation_invitations
				   SET status = 'declined', declined_reason = NULLIF($2,'')
				 WHERE id = $1`, invID, strings.TrimSpace(req.Reason))
			return err
		}

		// The response row. No respondent, by construction.
		var respID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO evaluation_responses
			    (institution_id, cycle_id, reviewee_id, relation)
			VALUES ($1,$2,$3,$4) RETURNING id`,
			id.InstitutionID, cycleID, revieweeID, relation).Scan(&respID); err != nil {
			return err
		}
		for _, a := range req.Answers {
			qid, qerr := uuid.Parse(strings.TrimSpace(a.QuestionID))
			if qerr != nil {
				return refusal("question_id must be a uuid")
			}
			if a.Rating == nil && strings.TrimSpace(a.Comment) == "" {
				continue
			}
			if a.Rating != nil && *a.Rating < 1 {
				return refusal("a rating starts at 1")
			}
			// The upper bound against the question's own scale is enforced by
			// the evaluation_answers_scale trigger, which is the only place
			// that can see max_rating.
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO evaluation_answers
				    (institution_id, response_id, question_id, rating, comment)
				VALUES ($1,$2,$3,$4,NULLIF($5,''))`,
				id.InstitutionID, respID, qid, a.Rating, strings.TrimSpace(a.Comment)); err != nil {
				return err
			}
		}

		// The fact of it, never the content.
		_, err := tx.Exec(r.Context(), `
			UPDATE evaluation_invitations
			   SET status = 'responded', responded_at = now()
			 WHERE id = $1`, invID)
		return err
	})
	switch {
	case err == nil && notMine:
		httpx.Denied(w, r, "that invitation was not addressed to you")
	case err != nil:
		adminOpsFail(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"recorded": true,
			"note":     "Your answers are stored without any link to you.",
		})
	}
}

// ============================================================================
// FEE REGULATORY COMMITTEE FILING
// ============================================================================

type frcFilingRow struct {
	ID            string  `json:"id"`
	No            string  `json:"filing_no"`
	Committee     string  `json:"committee_name"`
	Level         string  `json:"committee_level"`
	State         *string `json:"state,omitempty"`
	Year          *string `json:"academic_year,omitempty"`
	Status        string  `json:"status"`
	SubmittedOn   *string `json:"submitted_on,omitempty"`
	AckNo         *string `json:"acknowledgement_no,omitempty"`
	DecidedOn     *string `json:"decided_on,omitempty"`
	Structure     *string `json:"fee_structure,omitempty"`
	VersionNo     *int    `json:"version_no,omitempty"`
	Lines         int     `json:"line_count"`
	Documents     int     `json:"document_count"`
	ProposedPaise int64   `json:"proposed_total_paise"`
	ApprovedPaise *int64  `json:"approved_total_paise,omitempty"`
}

const frcFilingSelect = `
	SELECT f.id::text, f.filing_no, f.committee_name, f.committee_level, f.state,
	       y.name, f.status, to_char(f.submitted_on,'YYYY-MM-DD'),
	       f.acknowledgement_no, to_char(f.decided_on,'YYYY-MM-DD'),
	       st.name, v.version_no,
	       (SELECT count(*) FROM fee_regulatory_filing_lines l WHERE l.filing_id = f.id)::int,
	       (SELECT count(*) FROM fee_regulatory_filing_documents d
	         JOIN files fi ON fi.id = d.file_id
	        WHERE d.filing_id = f.id AND fi.deleted_at IS NULL)::int,
	       COALESCE((SELECT sum(l.proposed_paise) FROM fee_regulatory_filing_lines l
	                  WHERE l.filing_id = f.id), 0),
	       (SELECT sum(l.approved_paise) FROM fee_regulatory_filing_lines l
	         WHERE l.filing_id = f.id)
	  FROM fee_regulatory_filings f
	  LEFT JOIN academic_years y ON y.id = f.academic_year_id
	  LEFT JOIN fee_structure_versions v ON v.id = f.fee_structure_version_id
	  LEFT JOIN fee_structures st ON st.id = v.fee_structure_id`

func scanFilingRow(rows pgx.Rows) (frcFilingRow, error) {
	var v frcFilingRow
	return v, rows.Scan(&v.ID, &v.No, &v.Committee, &v.Level, &v.State, &v.Year,
		&v.Status, &v.SubmittedOn, &v.AckNo, &v.DecidedOn, &v.Structure,
		&v.VersionNo, &v.Lines, &v.Documents, &v.ProposedPaise, &v.ApprovedPaise)
}

func (s *Server) listFeeFilings(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, frcFilingSelect+`
		 WHERE ($1::text IS NULL OR f.status = $1)
		 ORDER BY f.created_at DESC LIMIT 200`,
		[]any{nullString(r.URL.Query().Get("status"))}, scanFilingRow)
	respond(w, r, items, err)
}

type frcLineRow struct {
	ID            string  `json:"id"`
	FeeHeadID     string  `json:"fee_head_id"`
	FeeHead       string  `json:"fee_head"`
	ClassID       *string `json:"class_id,omitempty"`
	Class         *string `json:"class,omitempty"`
	Instalment    int     `json:"instalment_no"`
	ProposedPaise int64   `json:"proposed_paise"`
	ApprovedPaise *int64  `json:"approved_paise,omitempty"`
	Note          *string `json:"modification_note,omitempty"`
}

type frcDocumentRow struct {
	ID         string  `json:"id"`
	FileID     string  `json:"file_id"`
	DocType    string  `json:"doc_type"`
	Name       string  `json:"original_name"`
	SizeBytes  int64   `json:"size_bytes"`
	Covers     *string `json:"covers_period,omitempty"`
	AttachedBy *string `json:"attached_by,omitempty"`
	AttachedOn string  `json:"attached_on"`
}

func (s *Server) getFeeFiling(w http.ResponseWriter, r *http.Request) {
	filingID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var head frcFilingRow
	var snapshot []byte
	var decisionNote, notes *string
	lines := []frcLineRow{}
	docs := []frcDocumentRow{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), frcFilingSelect+` WHERE f.id = $1`, filingID)
		if err != nil {
			return err
		}
		found := false
		if rows.Next() {
			head, err = scanFilingRow(rows)
			if err != nil {
				rows.Close()
				return err
			}
			found = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if !found {
			return pgx.ErrNoRows
		}

		if err := tx.QueryRow(r.Context(),
			`SELECT filed_snapshot, decision_note, notes FROM fee_regulatory_filings WHERE id = $1`,
			filingID).Scan(&snapshot, &decisionNote, &notes); err != nil {
			return err
		}

		ls, err := tx.Query(r.Context(), `
			SELECT l.id::text, l.fee_head_id::text, h.name, l.class_id::text, c.name,
			       l.instalment_no, l.proposed_paise, l.approved_paise, l.modification_note
			  FROM fee_regulatory_filing_lines l
			  JOIN fee_heads h ON h.id = l.fee_head_id
			  LEFT JOIN classes c ON c.id = l.class_id
			 WHERE l.filing_id = $1
			 ORDER BY c.level NULLS FIRST, h.name, l.instalment_no`, filingID)
		if err != nil {
			return err
		}
		defer ls.Close()
		for ls.Next() {
			var v frcLineRow
			if err := ls.Scan(&v.ID, &v.FeeHeadID, &v.FeeHead, &v.ClassID, &v.Class,
				&v.Instalment, &v.ProposedPaise, &v.ApprovedPaise, &v.Note); err != nil {
				return err
			}
			lines = append(lines, v)
		}
		if err := ls.Err(); err != nil {
			return err
		}

		ds, err := tx.Query(r.Context(), `
			SELECT d.id::text, d.file_id::text, d.doc_type, fi.original_name,
			       fi.size_bytes, d.covers_period, u.full_name,
			       to_char(d.created_at,'YYYY-MM-DD')
			  FROM fee_regulatory_filing_documents d
			  JOIN files fi ON fi.id = d.file_id
			  LEFT JOIN users u ON u.id = d.attached_by
			 WHERE d.filing_id = $1 AND fi.deleted_at IS NULL
			 ORDER BY d.doc_type, d.created_at`, filingID)
		if err != nil {
			return err
		}
		defer ds.Close()
		for ds.Next() {
			var v frcDocumentRow
			if err := ds.Scan(&v.ID, &v.FileID, &v.DocType, &v.Name, &v.SizeBytes,
				&v.Covers, &v.AttachedBy, &v.AttachedOn); err != nil {
				return err
			}
			docs = append(docs, v)
		}
		return ds.Err()
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"filing": head, "lines": lines, "documents": docs,
		"decision_note": decisionNote, "notes": notes,
		"filed_snapshot": json.RawMessage(snapshot),
	})
}

type frcSaveFilingRequest struct {
	ID             string `json:"id,omitempty"`
	FilingNo       string `json:"filing_no,omitempty"`
	CommitteeName  string `json:"committee_name"`
	CommitteeLevel string `json:"committee_level,omitempty"`
	State          string `json:"state,omitempty"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
	CampusID       string `json:"campus_id,omitempty"`
	VersionID      string `json:"fee_structure_version_id,omitempty"`
	Notes          string `json:"notes,omitempty"`
	// Omitted, the lines are compiled from the cited version. Supplied, they
	// override — a school proposing a fee it has not yet built into a
	// structure needs to be able to file it.
	Lines []struct {
		FeeHeadID  string `json:"fee_head_id"`
		ClassID    string `json:"class_id,omitempty"`
		Instalment int    `json:"instalment_no"`
		Paise      int64  `json:"proposed_paise"`
	} `json:"lines,omitempty"`
}

/*
saveFeeFiling compiles a draft filing, normally straight from a fee structure
version.

	Citing fee_structure_versions rather than fee_structures is the point of
	the exercise. The live structure keeps moving — that is what a fee book
	does — and "what did we file in March" has to keep its answer. 00045 built
	versioning precisely so that a historical claim stays explainable, and a
	regulatory filing is the strongest such claim a school makes.

	Only a draft is editable. After submission the trigger in the migration
	refuses to move the snapshot, the version, the filing number or the
	proposed amounts; this handler stops short of trying.
*/
func (s *Server) saveFeeFiling(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req frcSaveFilingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.CommitteeName) == "" {
		httpx.BadRequest(w, r, "name the committee this is being filed with")
		return
	}
	level := strings.TrimSpace(req.CommitteeLevel)
	if level == "" {
		level = "district"
	}
	switch level {
	case "district", "division", "state":
	default:
		httpx.BadRequest(w, r, "committee_level must be district, division or state")
		return
	}
	version, verr := aoOptUUID(req.VersionID)
	if verr != nil {
		httpx.BadRequest(w, r, verr.Error())
		return
	}
	if version == nil && len(req.Lines) == 0 {
		httpx.BadRequest(w, r,
			"choose the fee structure version being filed, or supply the proposed amounts")
		return
	}
	year, yerr := aoOptUUID(req.AcademicYearID)
	if yerr != nil {
		httpx.BadRequest(w, r, yerr.Error())
		return
	}
	campus, cerr := aoOptUUID(req.CampusID)
	if cerr != nil {
		httpx.BadRequest(w, r, cerr.Error())
		return
	}

	var filingID uuid.UUID
	var no string
	var compiled int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) != "" {
			parsed, perr := uuid.Parse(strings.TrimSpace(req.ID))
			if perr != nil {
				return refusal("malformed filing id")
			}
			filingID = parsed
			var status string
			if err := tx.QueryRow(r.Context(),
				`SELECT status, filing_no FROM fee_regulatory_filings WHERE id = $1 FOR UPDATE`,
				filingID).Scan(&status, &no); err != nil {
				return err
			}
			if status != "draft" {
				return refusal("this filing has been submitted — what was filed cannot be changed")
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE fee_regulatory_filings
				   SET committee_name = $2, committee_level = $3, state = NULLIF($4,''),
				       academic_year_id = $5, campus_id = $6,
				       fee_structure_version_id = $7, notes = NULLIF($8,''),
				       updated_at = now()
				 WHERE id = $1`,
				filingID, strings.TrimSpace(req.CommitteeName), level,
				strings.TrimSpace(req.State), year, campus, version,
				strings.TrimSpace(req.Notes)); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(),
				`DELETE FROM fee_regulatory_filing_lines WHERE filing_id = $1`, filingID); err != nil {
				return err
			}
		} else {
			no = strings.TrimSpace(req.FilingNo)
			if no == "" {
				if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`,
					id.InstitutionID.String()+"fee_filing"); err != nil {
					return err
				}
				if err := tx.QueryRow(r.Context(), `
					SELECT 'FRC' || lpad((COALESCE(max(
					         nullif(substring(filing_no from '[0-9]+$'), '')::int), 0) + 1)::text, 4, '0')
					  FROM fee_regulatory_filings WHERE institution_id = $1`,
					id.InstitutionID).Scan(&no); err != nil {
					return err
				}
			}
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO fee_regulatory_filings
				    (institution_id, campus_id, filing_no, academic_year_id,
				     committee_name, committee_level, state,
				     fee_structure_version_id, prepared_by, notes)
				VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,$9,NULLIF($10,''))
				RETURNING id`,
				id.InstitutionID, campus, no, year, strings.TrimSpace(req.CommitteeName),
				level, strings.TrimSpace(req.State), version, id.UserID,
				strings.TrimSpace(req.Notes)).Scan(&filingID); err != nil {
				return err
			}
		}

		if len(req.Lines) > 0 {
			for _, l := range req.Lines {
				head, herr := uuid.Parse(strings.TrimSpace(l.FeeHeadID))
				if herr != nil {
					return refusal("fee_head_id must be a uuid")
				}
				class, cerr2 := aoOptUUID(l.ClassID)
				if cerr2 != nil {
					return cerr2
				}
				inst := l.Instalment
				if inst == 0 {
					inst = 1
				}
				if l.Paise < 0 {
					return refusal("a proposed amount cannot be negative")
				}
				if _, err := tx.Exec(r.Context(), `
					INSERT INTO fee_regulatory_filing_lines
					    (institution_id, filing_id, fee_head_id, class_id,
					     instalment_no, proposed_paise)
					VALUES ($1,$2,$3,$4,$5,$6)`,
					id.InstitutionID, filingID, head, class, inst, l.Paise); err != nil {
					return err
				}
				compiled++
			}
			return nil
		}

		// Compile from the cited version. class_id comes off the structure the
		// version belongs to, so a per-class structure files per class and a
		// school-wide one files school-wide.
		ct, err := tx.Exec(r.Context(), `
			INSERT INTO fee_regulatory_filing_lines
			    (institution_id, filing_id, fee_head_id, class_id, instalment_no, proposed_paise)
			SELECT $1, $2, i.fee_head_id, st.class_id, i.instalment_no, i.amount_paise
			  FROM fee_structure_version_items i
			  JOIN fee_structure_versions v ON v.id = i.version_id
			  JOIN fee_structures st ON st.id = v.fee_structure_id
			 WHERE i.version_id = $3`, id.InstitutionID, filingID, version)
		if err != nil {
			return err
		}
		compiled = int(ct.RowsAffected())
		if compiled == 0 {
			return refusal("that fee structure version has no amounts on it yet")
		}
		return nil
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": filingID.String(), "filing_no": no, "lines": compiled,
	})
}

type frcSubmitRequest struct {
	SubmittedOn string `json:"submitted_on,omitempty"`
	AckNo       string `json:"acknowledgement_no,omitempty"`
}

/*
submitFeeFiling freezes the filing.

	The snapshot is built here, in SQL, from the rows as they stand at this
	instant — not taken from the request, unlike the MDM return. The
	difference is what the two documents are: a monthly return is a set of
	figures a person read off a screen and signed, and an fee filing is a set
	of rows this system holds and can reproduce exactly. Building it server
	side means the frozen copy cannot be a version of the filing the client
	invented.

	After this, fee_regulatory_filings_frozen and
	fee_regulatory_filing_lines_frozen refuse every change to what was filed.
	Only the committee's reply stays writable.
*/
func (s *Server) submitFeeFiling(w http.ResponseWriter, r *http.Request) {
	filingID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req frcSubmitRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	submitted := nowInIndia()
	if v := strings.TrimSpace(req.SubmittedOn); v != "" {
		d, derr := time.Parse(time.DateOnly, v)
		if derr != nil {
			httpx.BadRequest(w, r, "submitted_on must be a date, as YYYY-MM-DD")
			return
		}
		submitted = d
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var lines, docs int
		if err := tx.QueryRow(r.Context(), `
			SELECT f.status,
			       (SELECT count(*) FROM fee_regulatory_filing_lines l
			         WHERE l.filing_id = f.id)::int,
			       (SELECT count(*) FROM fee_regulatory_filing_documents d
			         WHERE d.filing_id = f.id)::int
			  FROM fee_regulatory_filings f WHERE f.id = $1 FOR UPDATE`,
			filingID).Scan(&status, &lines, &docs); err != nil {
			return err
		}
		if status != "draft" {
			return refusal("this filing has already been submitted")
		}
		if lines == 0 {
			return refusal("a filing needs the proposed fee amounts on it")
		}
		if docs == 0 {
			// Every state's committee asks for accounts. Filing without them
			// is a trip to the office that ends at the counter.
			return refusal("attach the supporting accounts before filing")
		}

		_, err := tx.Exec(r.Context(), `
			UPDATE fee_regulatory_filings f
			   SET status = 'submitted', submitted_on = $2,
			       acknowledgement_no = NULLIF($3,''),
			       filed_snapshot = jsonb_build_object(
			           'filed_at',       to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
			           'filing_no',      f.filing_no,
			           'committee',      f.committee_name,
			           'committee_level',f.committee_level,
			           'version_id',     f.fee_structure_version_id,
			           'lines', COALESCE((
			               SELECT jsonb_agg(jsonb_build_object(
			                   'fee_head',      h.name,
			                   'fee_head_id',   l.fee_head_id,
			                   'class',         c.name,
			                   'class_id',      l.class_id,
			                   'instalment_no', l.instalment_no,
			                   'proposed_paise',l.proposed_paise)
			                   ORDER BY h.name, l.instalment_no)
			                 FROM fee_regulatory_filing_lines l
			                 JOIN fee_heads h ON h.id = l.fee_head_id
			                 LEFT JOIN classes c ON c.id = l.class_id
			                WHERE l.filing_id = f.id), '[]'::jsonb),
			           'documents', COALESCE((
			               SELECT jsonb_agg(jsonb_build_object(
			                   'doc_type', d.doc_type,
			                   'file',     fi.original_name,
			                   'file_id',  d.file_id)
			                   ORDER BY d.doc_type)
			                 FROM fee_regulatory_filing_documents d
			                 JOIN files fi ON fi.id = d.file_id
			                WHERE d.filing_id = f.id), '[]'::jsonb)),
			       updated_at = now()
			 WHERE f.id = $1`,
			filingID, submitted, strings.TrimSpace(req.AckNo))
		return err
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status": "submitted", "submitted_on": submitted.Format(time.DateOnly),
	})
}

type frcDecisionRequest struct {
	Decision  string `json:"decision"` // approved | approved_with_modification | rejected | withdrawn
	DecidedOn string `json:"decided_on,omitempty"`
	Note      string `json:"note,omitempty"`
	AckNo     string `json:"acknowledgement_no,omitempty"`
	// The amounts the committee actually allowed, where they differ. Lines
	// left out keep what was proposed.
	Approved []struct {
		LineID string `json:"line_id"`
		Paise  int64  `json:"approved_paise"`
		Note   string `json:"note,omitempty"`
	} `json:"approved_lines,omitempty"`
}

/*
decideFeeFiling records the committee's reply.

	'approved' copies the proposed amounts into approved_paise wholesale,
	because that is what approval as filed means and leaving them null would
	make the variance check silently compare against nothing.

	'approved_with_modification' takes the amounts the committee allowed, line
	by line, and fills the rest from what was proposed for the same reason.
*/
func (s *Server) decideFeeFiling(w http.ResponseWriter, r *http.Request) {
	filingID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req frcDecisionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	switch req.Decision {
	case "approved", "approved_with_modification", "rejected", "withdrawn":
	default:
		httpx.BadRequest(w, r,
			"decision must be approved, approved_with_modification, rejected or withdrawn")
		return
	}
	if (req.Decision == "approved_with_modification" || req.Decision == "rejected") &&
		strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r, "record what the committee said")
		return
	}
	if req.Decision == "approved_with_modification" && len(req.Approved) == 0 {
		httpx.BadRequest(w, r, "record the amounts the committee allowed")
		return
	}
	decided := nowInIndia()
	if v := strings.TrimSpace(req.DecidedOn); v != "" {
		d, derr := time.Parse(time.DateOnly, v)
		if derr != nil {
			httpx.BadRequest(w, r, "decided_on must be a date, as YYYY-MM-DD")
			return
		}
		decided = d
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM fee_regulatory_filings WHERE id = $1 FOR UPDATE`,
			filingID).Scan(&status); err != nil {
			return err
		}
		if status == "draft" {
			return refusal("this filing has not been submitted yet")
		}

		for _, a := range req.Approved {
			lineID, lerr := uuid.Parse(strings.TrimSpace(a.LineID))
			if lerr != nil {
				return refusal("line_id must be a uuid")
			}
			if a.Paise < 0 {
				return refusal("an approved amount cannot be negative")
			}
			ct, err := tx.Exec(r.Context(), `
				UPDATE fee_regulatory_filing_lines
				   SET approved_paise = $2, modification_note = NULLIF($3,'')
				 WHERE id = $1 AND filing_id = $4`,
				lineID, a.Paise, strings.TrimSpace(a.Note), filingID)
			if err != nil {
				return err
			}
			if ct.RowsAffected() == 0 {
				return refusal("one of those lines is not on this filing")
			}
		}

		if req.Decision == "approved" || req.Decision == "approved_with_modification" {
			// Anything the committee did not touch was approved as filed.
			if _, err := tx.Exec(r.Context(), `
				UPDATE fee_regulatory_filing_lines
				   SET approved_paise = proposed_paise
				 WHERE filing_id = $1 AND approved_paise IS NULL`, filingID); err != nil {
				return err
			}
		}

		var decidedOn any = decided
		if req.Decision == "withdrawn" {
			decidedOn = nil
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE fee_regulatory_filings
			   SET status = $2, decided_on = $3, decision_note = NULLIF($4,''),
			       decided_recorded_by = $5,
			       acknowledgement_no = COALESCE(NULLIF($6,''), acknowledgement_no),
			       updated_at = now()
			 WHERE id = $1`,
			filingID, req.Decision, decidedOn, strings.TrimSpace(req.Note),
			id.UserID, strings.TrimSpace(req.AckNo))
		return err
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": req.Decision})
}

type frcAttachRequest struct {
	FileID  string `json:"file_id"`
	DocType string `json:"doc_type"`
	Covers  string `json:"covers_period,omitempty"`
	Notes   string `json:"notes,omitempty"`
}

// attachFeeFilingDocument links an already-uploaded file. The upload itself
// goes through POST /files/presign, as every other attachment in the product
// does; this only records what the document is and which filing it supports.
func (s *Server) attachFeeFilingDocument(w http.ResponseWriter, r *http.Request) {
	filingID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req frcAttachRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	fileID, ferr := uuid.Parse(strings.TrimSpace(req.FileID))
	if ferr != nil {
		httpx.BadRequest(w, r, "file_id must be a uuid — upload the document first")
		return
	}
	if strings.TrimSpace(req.DocType) == "" {
		httpx.BadRequest(w, r, "say what this document is")
		return
	}

	var docID uuid.UUID
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var deleted *time.Time
		if err := tx.QueryRow(r.Context(),
			`SELECT deleted_at FROM files WHERE id = $1`, fileID).Scan(&deleted); err != nil {
			return err
		}
		if deleted != nil {
			return refusal("that file has been deleted")
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO fee_regulatory_filing_documents
			    (institution_id, filing_id, file_id, doc_type, covers_period, notes, attached_by)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),$7)
			RETURNING id`,
			id.InstitutionID, filingID, fileID, strings.TrimSpace(req.DocType),
			strings.TrimSpace(req.Covers), strings.TrimSpace(req.Notes),
			id.UserID).Scan(&docID)
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": docID.String()})
}

type frcVarianceRow struct {
	Class         *string `json:"class,omitempty"`
	FeeHead       string  `json:"fee_head"`
	Instalment    int     `json:"instalment_no"`
	ApprovedPaise *int64  `json:"approved_paise,omitempty"`
	ChargedPaise  int64   `json:"charged_paise"`
	Students      int     `json:"students"`
	VariancePaise int64   `json:"variance_paise"`
	ExposurePaise int64   `json:"exposure_paise"`
	Verdict       string  `json:"verdict"`
}

/*
getFilingVariance is the valuable half: what the school is actually charging,
against what the committee approved.

	"Charged" comes from invoice_lines, not from the fee structure. The
	structure is what the school meant to bill; the invoice is what it did,
	and the two part company the first time somebody edits a structure without
	regenerating, or bills a head that was never filed at all. A variance
	report built on the structure would agree with itself and tell the school
	nothing.

	amount_paise, not amount minus discount. A concession is the school
	charging the approved fee and then remitting part of it, which is lawful
	and is not what the committee capped. Netting the discount off would
	silently hide an over-charge behind a scholarship.

	Exposure is the refund the school is on the hook for: the excess per
	student, times the students billed it. That number, not the row count, is
	what makes this worth opening.

	Rows where nothing was filed are reported as their own verdict. Charging a
	head that was never put to the committee is exposure at the full amount,
	and it is the easiest kind to acquire — a new head added mid-year by
	somebody who did not know a filing existed.
*/
func (s *Server) getFilingVariance(w http.ResponseWriter, r *http.Request) {
	filingID, perr := aoUUID(r, "id")
	if perr != nil {
		httpx.BadRequest(w, r, perr.Error())
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var (
		filingNo, status string
		yearName         *string
		yearID           *uuid.UUID
		rows             []frcVarianceRow
		totalExposure    int64
		over, unfiled    int
	)
	rows = []frcVarianceRow{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT f.filing_no, f.status, f.academic_year_id, y.name
			  FROM fee_regulatory_filings f
			  LEFT JOIN academic_years y ON y.id = f.academic_year_id
			 WHERE f.id = $1`, filingID).
			Scan(&filingNo, &status, &yearID, &yearName); err != nil {
			return err
		}
		if yearID == nil {
			// Without a year there is nothing to compare against: invoices are
			// raised per academic year and "everything ever billed" is not the
			// question the committee asks.
			return refusal("this filing names no academic year, so there is nothing to compare it against")
		}

		/* Charged, per class per head per instalment.

		   The class comes from the student's enrolment in the same year,
		   which is how invoices acquire a class at all — invoices carry a
		   student and a year, never a class. Cancelled invoices are excluded:
		   a cancelled bill was not charged. */
		q, err := tx.Query(r.Context(), `
			WITH charged AS (
			  SELECT en.class_id,
			         il.fee_head_id,
			         COALESCE(i.instalment_no, 1) AS instalment_no,
			         max(il.amount_paise)          AS charged_paise,
			         count(DISTINCT i.student_id)::int AS students
			    FROM invoice_lines il
			    JOIN invoices i ON i.id = il.invoice_id
			    LEFT JOIN LATERAL (
			        SELECT e.class_id FROM enrollments e
			         WHERE e.student_id = i.student_id
			           AND e.academic_year_id = i.academic_year_id
			         LIMIT 1
			    ) en ON true
			   WHERE i.academic_year_id = $1
			     AND i.status <> 'cancelled'
			   GROUP BY 1, 2, 3
			)
			SELECT c.name, h.name, ch.instalment_no, fl.approved_paise,
			       ch.charged_paise, ch.students
			  FROM charged ch
			  JOIN fee_heads h ON h.id = ch.fee_head_id
			  LEFT JOIN classes c ON c.id = ch.class_id
			  LEFT JOIN LATERAL (
			      SELECT l.approved_paise
			        FROM fee_regulatory_filing_lines l
			       WHERE l.filing_id = $2
			         AND l.fee_head_id = ch.fee_head_id
			         AND l.instalment_no = ch.instalment_no
			         AND (l.class_id = ch.class_id OR l.class_id IS NULL)
			       -- A line naming this class beats the school-wide one.
			       ORDER BY (l.class_id IS NULL)
			       LIMIT 1
			  ) fl ON true
			 ORDER BY c.level NULLS FIRST, h.name, ch.instalment_no`,
			*yearID, filingID)
		if err != nil {
			return err
		}
		defer q.Close()
		for q.Next() {
			var v frcVarianceRow
			if err := q.Scan(&v.Class, &v.FeeHead, &v.Instalment, &v.ApprovedPaise,
				&v.ChargedPaise, &v.Students); err != nil {
				return err
			}
			switch {
			case v.ApprovedPaise == nil:
				v.Verdict = "not_filed"
				v.ExposurePaise = v.ChargedPaise * int64(v.Students)
				unfiled++
			case v.ChargedPaise > *v.ApprovedPaise:
				v.Verdict = "over_approved"
				v.VariancePaise = v.ChargedPaise - *v.ApprovedPaise
				v.ExposurePaise = v.VariancePaise * int64(v.Students)
				over++
			case v.ChargedPaise < *v.ApprovedPaise:
				v.Verdict = "under_approved"
				v.VariancePaise = v.ChargedPaise - *v.ApprovedPaise
			default:
				v.Verdict = "as_approved"
			}
			totalExposure += v.ExposurePaise
			rows = append(rows, v)
		}
		return q.Err()
	})
	if err != nil {
		adminOpsFail(w, r, err)
		return
	}

	summary := "Everything billed matches what the committee approved."
	switch {
	case status == "draft" || status == "submitted":
		summary = "This filing has not been decided yet, so there is nothing approved to charge against."
	case over > 0 || unfiled > 0:
		summary = fmt.Sprintf(
			"%d fee lines are above the approved amount and %d were never filed. "+
				"Exposure if refunds are ordered: %s.",
			over, unfiled, formatPaise(totalExposure))
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"filing":         map[string]any{"filing_no": filingNo, "status": status, "academic_year": yearName},
		"rows":           rows,
		"over_approved":  over,
		"never_filed":    unfiled,
		"exposure_paise": totalExposure,
		"summary":        summary,
		"basis": "Charged figures are invoice_lines.amount_paise — what students were actually " +
			"billed — before concessions, because a concession is the school remitting an " +
			"approved fee and not a lower fee.",
	})
}
