package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
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

/* Collections: the counter, the store, and the government's money.

   Three catalogue features live here.

     finance.collections.pos_canteen_terminal_integration
     finance.collections.school_store_merchandise_sales
     finance.concessions_refunds.grant_in_aid_accounting

   The first two are one mechanism seen from two counters, which is why they
   are one file rather than two. The third shares nothing with them except the
   word "finance", and is here because it was commissioned alongside them; its
   section is fenced off below and shares no type with the till.

   ---- The till ------------------------------------------------------------

   A canteen counter sells for twenty minutes at break. Speed is the
   requirement, so a sale is one POST carrying its lines and nothing about it
   is a wizard. But the feature is not the selling. The feature is the cash-up:

     somebody named opens a drawer with a float
     things are rung up, taken in cash or charged to a child's fee account
     the drawer is counted at the end and the count is compared with the till

   A till that cannot be reconciled at close is an honesty box. So
   expected_cash_paise is computed once, at close, from the session's own
   sales, and frozen on the row; the variance is generated from the pair and
   can never drift; and a variance outside the school's tolerance has to carry
   a sentence before the session will close.

   ---- What is deliberately not built --------------------------------------

   No wallet. finance.collections.cashless_campus_wallet is blocked -- there is
   no payment gateway behind this deployment -- and a stored balance a school
   can neither top up nor refund electronically is a liability it cannot
   discharge. The cashless mode here is charge-to-student-account: the sale
   raises an ordinary invoice through the fee machinery, on the ledger the
   parent and the accountant already read, and it settles at the fee counter
   like everything else.

   No second stock ledger. A store line names a store_product_variants row,
   that row names an inventory_items row, and inserting the line fires
   pos_line_to_stock() which writes an inventory_movements row of kind 'issue'
   -- the same door 00053's goods receipt writes 'receipt' through, and the
   same trigger from 00005 recomputes on_hand. Nothing in this file touches a
   stock balance directly, and a stock figure has exactly one source.

   No second receipt series. 00045 built a gapless per-financial-year series
   allocated under a row lock, because under GST a missing receipt number reads
   as a suppressed sale. A till receipt is drawn from the same machinery with
   kind='pos': same lock, same 1 April reset, same audit.

   ---- Grant-in-aid --------------------------------------------------------

   Ordinary government-accounting work, and it is worth saying plainly because
   a classifier once flagged this feature as machine learning on the strength
   of the word "Aid".

   An aided school does not receive "a grant". It receives a sanction against a
   named head -- teaching salaries, non-salary, maintenance, contingency -- and
   is accountable for three separate figures per head per year that are
   routinely conflated and never collapse:

     sanctioned  what the government order approved
     received    what the treasury actually released, in tranches
     utilised    what was spent, booked against that head

   Spending outside the sanctioned head is a diversion, so booking an expense
   past what the head has available is refused rather than warned about. What
   is left at year end is received minus utilised, and it has to be carried or
   returned -- an unspent balance nobody dispositioned is a recovery order
   three years later. The utilisation certificate is what the school files, and
   every figure on it is snapshotted at issue: a signed statement must not be
   silently rewritten by an expense entered afterwards.

   The whole of it posts to the chart of accounts from 00033 through
   postVoucher, so grant money is in the books rather than beside them. */

// --- shared vocabulary -------------------------------------------------------

/*
colMoney reads a money field that must have been supplied.

	The pointer is the point. A JSON body that omits amount_paise, or sends an
	empty string from a form the clerk tabbed past, decodes into a plain int64
	as 0 -- and a zero-rupee sale, receipt, sanction or refund is indis-
	tinguishable from a deliberate one once it is written. Requiring the field
	to be present, and separately requiring it to be positive, is the
	difference between "you left the amount blank" and a row nobody can explain.
*/
func colMoney(field string, v *int64, allowZero bool) (int64, error) {
	if v == nil {
		return 0, refusef("%s is blank -- type the amount", field)
	}
	if *v < 0 {
		return 0, refusef("%s cannot be negative", field)
	}
	if *v == 0 && !allowZero {
		return 0, refusef("%s must be more than nothing", field)
	}
	return *v, nil
}

// colFY is the Indian financial year containing d, named by its starting year:
// 2026 means April 2026 to March 2027. Restated from fyLabel's arithmetic
// rather than from a handler's memory, for the reason journal_entries
// generates its own column.
func colFY(d time.Time) int {
	y := d.Year()
	if d.Month() < time.April {
		y--
	}
	return y
}

// colDate parses a YYYY-MM-DD field, defaulting to today in India.
func colDate(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		n := nowInIndia()
		return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC), nil
	}
	d, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return time.Time{}, refusal("that date is not a date -- use YYYY-MM-DD")
	}
	return d, nil
}

// colTx runs one tenant-scoped transaction and maps the outcome. Every write
// in this file goes through it so that a refusal is a 400 with a sentence, a
// database rule is a 400 with the database's own sentence, and only a genuine
// fault is a 500.
func (s *Server) colTx(w http.ResponseWriter, r *http.Request,
	fn func(tx pgx.Tx, id *httpx.Identity) error, ok map[string]any) {
	id := httpx.IdentityFrom(r.Context())
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return fn(tx, id)
	})
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

// colTitle capitalises a channel name for a narration. strings.Title is
// deprecated and locale-aware in ways that do not matter for two ASCII words.
func colTitle(v string) string {
	if v == "" {
		return v
	}
	return strings.ToUpper(v[:1]) + v[1:]
}

// --- settings ----------------------------------------------------------------

type collectionsSettingsView struct {
	CanteenFeeHeadID       *string `json:"canteen_fee_head_id,omitempty"`
	CanteenFeeHeadName     *string `json:"canteen_fee_head_name,omitempty"`
	StoreFeeHeadID         *string `json:"store_fee_head_id,omitempty"`
	StoreFeeHeadName       *string `json:"store_fee_head_name,omitempty"`
	VarianceTolerancePaise int64   `json:"variance_tolerance_paise"`
	GrantLiabilityID       *string `json:"grant_liability_account_id,omitempty"`
	GrantLiabilityName     *string `json:"grant_liability_account_name,omitempty"`
	GrantBankID            *string `json:"grant_bank_account_id,omitempty"`
	GrantBankName          *string `json:"grant_bank_account_name,omitempty"`
}

type collectionsSettingsRequest struct {
	CanteenFeeHeadID       string `json:"canteen_fee_head_id"`
	StoreFeeHeadID         string `json:"store_fee_head_id"`
	VarianceTolerancePaise *int64 `json:"variance_tolerance_paise"`
	GrantLiabilityID       string `json:"grant_liability_account_id"`
	GrantBankID            string `json:"grant_bank_account_id"`
}

func (s *Server) getCollectionsSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	// The default row is what a school sees before it has configured anything.
	// Five thousand paise is fifty rupees: a coin nobody can find, not a
	// shortfall worth a meeting.
	out := collectionsSettingsView{VarianceTolerancePaise: 5000}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT c.canteen_fee_head_id::text, ch.name,
			       c.store_fee_head_id::text,   sh.name,
			       c.variance_tolerance_paise,
			       c.grant_liability_account_id::text, gl.name,
			       c.grant_bank_account_id::text,      gb.name
			  FROM collections_settings c
			  LEFT JOIN fee_heads       ch ON ch.id = c.canteen_fee_head_id
			  LEFT JOIN fee_heads       sh ON sh.id = c.store_fee_head_id
			  LEFT JOIN ledger_accounts gl ON gl.id = c.grant_liability_account_id
			  LEFT JOIN ledger_accounts gb ON gb.id = c.grant_bank_account_id
			 WHERE c.institution_id = $1`, id.InstitutionID).
			Scan(&out.CanteenFeeHeadID, &out.CanteenFeeHeadName,
				&out.StoreFeeHeadID, &out.StoreFeeHeadName,
				&out.VarianceTolerancePaise,
				&out.GrantLiabilityID, &out.GrantLiabilityName,
				&out.GrantBankID, &out.GrantBankName)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) saveCollectionsSettings(w http.ResponseWriter, r *http.Request) {
	var req collectionsSettingsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		tol, err := colMoney("the variance tolerance", req.VarianceTolerancePaise, true)
		if err != nil {
			return err
		}
		canteen, err := optionalUUID(req.CanteenFeeHeadID)
		if err != nil {
			return refusal("that canteen fee head is not a valid id")
		}
		store, err := optionalUUID(req.StoreFeeHeadID)
		if err != nil {
			return refusal("that store fee head is not a valid id")
		}
		liab, err := optionalUUID(req.GrantLiabilityID)
		if err != nil {
			return refusal("that grant account is not a valid id")
		}
		bank, err := optionalUUID(req.GrantBankID)
		if err != nil {
			return refusal("that bank account is not a valid id")
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO collections_settings
			    (institution_id, canteen_fee_head_id, store_fee_head_id,
			     variance_tolerance_paise, grant_liability_account_id,
			     grant_bank_account_id, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,now())
			ON CONFLICT (institution_id) DO UPDATE
			   SET canteen_fee_head_id = EXCLUDED.canteen_fee_head_id,
			       store_fee_head_id   = EXCLUDED.store_fee_head_id,
			       variance_tolerance_paise = EXCLUDED.variance_tolerance_paise,
			       grant_liability_account_id = EXCLUDED.grant_liability_account_id,
			       grant_bank_account_id      = EXCLUDED.grant_bank_account_id,
			       updated_at = now()`,
			id.InstitutionID, canteen, store, tol, liab, bank)
		return err
	}, map[string]any{"status": "saved"})
}

// colTolerance reads the school's cash-up tolerance, defaulting where no
// settings row exists yet.
func colTolerance(ctx context.Context, tx pgx.Tx, instID uuid.UUID) (int64, error) {
	var tol int64 = 5000
	err := tx.QueryRow(ctx,
		`SELECT variance_tolerance_paise FROM collections_settings WHERE institution_id = $1`,
		instID).Scan(&tol)
	if errors.Is(err, pgx.ErrNoRows) {
		return 5000, nil
	}
	return tol, err
}

// --- terminals ---------------------------------------------------------------

type posTerminalView struct {
	ID        string  `json:"id"`
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Location  *string `json:"location,omitempty"`
	IsActive  bool    `json:"is_active"`
	OpenSince *string `json:"open_since,omitempty"`
	OpenBy    *string `json:"open_by,omitempty"`
}

type posTerminalRequest struct {
	ID       string `json:"id"`
	Code     string `json:"code"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Location string `json:"location"`
	IsActive *bool  `json:"is_active"`
}

func (s *Server) listPosTerminals(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT t.id::text, t.code, t.name, t.kind, t.location, t.is_active,
		       to_char(o.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', u.full_name
		  FROM pos_terminals t
		  LEFT JOIN LATERAL (
		      SELECT ts.opened_at, ts.opened_by
		        FROM pos_till_sessions ts
		       WHERE ts.terminal_id = t.id AND ts.status = 'open'
		       LIMIT 1
		  ) o ON true
		  LEFT JOIN users u ON u.id = o.opened_by
		 WHERE ($1::text IS NULL OR t.kind = $1)
		   AND ($2::bool IS NULL OR t.is_active = $2)
		 ORDER BY t.is_active DESC, t.name`,
		[]any{nullString(r.URL.Query().Get("kind")), nullBool(r.URL.Query().Get("active"))},
		func(rows pgx.Rows) (posTerminalView, error) {
			var v posTerminalView
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Kind, &v.Location,
				&v.IsActive, &v.OpenSince, &v.OpenBy)
		})
	respond(w, r, items, err)
}

func (s *Server) savePosTerminal(w http.ResponseWriter, r *http.Request) {
	var req posTerminalRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var out string
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		req.Code = strings.TrimSpace(req.Code)
		req.Name = strings.TrimSpace(req.Name)
		req.Kind = strings.TrimSpace(req.Kind)
		if req.Kind == "" {
			req.Kind = "canteen"
		}
		switch {
		case req.Code == "":
			return refusal("give the counter a short code, so a receipt can name it")
		case req.Name == "":
			return refusal("what is this counter called?")
		case req.Kind != "canteen" && req.Kind != "store":
			return refusal("a counter is either a canteen or a store")
		}
		active := true
		if req.IsActive != nil {
			active = *req.IsActive
		}
		if tid := strings.TrimSpace(req.ID); tid != "" {
			u, err := uuid.Parse(tid)
			if err != nil {
				return refusal("malformed counter id")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE pos_terminals
				   SET code=$3, name=$4, kind=$5, location=$6, is_active=$7,
				       updated_at=now()
				 WHERE id=$1 AND institution_id=$2
				 RETURNING id::text`,
				u, id.InstitutionID, req.Code, req.Name, req.Kind,
				nullString(req.Location), active).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO pos_terminals
			    (institution_id, code, name, kind, location, is_active)
			VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING id::text`,
			id.InstitutionID, req.Code, req.Name, req.Kind,
			nullString(req.Location), active).Scan(&out)
	}, map[string]any{"id": &out})
}

// --- till sessions -----------------------------------------------------------

type tillSessionView struct {
	ID           string  `json:"id"`
	TerminalID   string  `json:"terminal_id"`
	TerminalName string  `json:"terminal_name"`
	TerminalKind string  `json:"terminal_kind"`
	OpenedBy     string  `json:"opened_by"`
	OpenedAt     string  `json:"opened_at"`
	FloatPaise   int64   `json:"opening_float_paise"`
	Status       string  `json:"status"`
	ClosedBy     *string `json:"closed_by,omitempty"`
	ClosedAt     *string `json:"closed_at,omitempty"`
	CountedPaise *int64  `json:"counted_cash_paise,omitempty"`
	ExpectedPais *int64  `json:"expected_cash_paise,omitempty"`
	PaidOutPaise int64   `json:"paid_out_paise"`
	VariancePais int64   `json:"variance_paise"`
	Reason       *string `json:"variance_reason,omitempty"`

	// Live, for an open session; the frozen figures above are what a closed
	// one is judged on.
	CashSalesPaise   int64 `json:"cash_sales_paise"`
	CashReturnsPaise int64 `json:"cash_returns_paise"`
	AccountPaise     int64 `json:"account_sales_paise"`
	SaleCount        int   `json:"sale_count"`
	ReturnCount      int   `json:"return_count"`
	// The tolerance in force, so the screen flags without a second round trip.
	TolerancePaise int64 `json:"variance_tolerance_paise"`
}

/*
tillSessionSQL is the one query every session view is built from.

	Written once because there are three callers -- the list, the single
	session, and the variance report -- and three copies of a cash-up sum is
	three chances for the screens to disagree about a shortfall. The lateral
	aggregate runs per session against pos_sales_by_session, which is the index
	it was created for.
*/
const tillSessionSQL = `
	SELECT ts.id::text, ts.terminal_id::text, t.name, t.kind,
	       COALESCE(uo.full_name, '—'),
	       to_char(ts.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
	       ts.opening_float_paise, ts.status,
	       uc.full_name,
	       to_char(ts.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
	       ts.counted_cash_paise, ts.expected_cash_paise, ts.paid_out_paise,
	       ts.variance_paise, ts.variance_reason,
	       COALESCE(a.cash_sales, 0), COALESCE(a.cash_returns, 0),
	       COALESCE(a.account_sales, 0),
	       COALESCE(a.sale_count, 0)::int, COALESCE(a.return_count, 0)::int
	  FROM pos_till_sessions ts
	  JOIN pos_terminals t ON t.id = ts.terminal_id
	  LEFT JOIN users uo ON uo.id = ts.opened_by
	  LEFT JOIN users uc ON uc.id = ts.closed_by
	  LEFT JOIN LATERAL (
	      SELECT
	        sum(CASE WHEN sl.kind = 'sale'   AND sl.payment_mode = 'cash'
	                 THEN sl.total_paise ELSE 0 END) AS cash_sales,
	        sum(CASE WHEN sl.kind = 'return' AND sl.payment_mode = 'cash'
	                 THEN sl.total_paise ELSE 0 END) AS cash_returns,
	        sum(CASE WHEN sl.kind = 'sale'   AND sl.payment_mode = 'account'
	                 THEN sl.total_paise ELSE 0 END) AS account_sales,
	        count(*) FILTER (WHERE sl.kind = 'sale')   AS sale_count,
	        count(*) FILTER (WHERE sl.kind = 'return') AS return_count
	        FROM pos_sales sl WHERE sl.session_id = ts.id
	  ) a ON true`

func scanTillSession(rows pgx.Rows) (tillSessionView, error) {
	var v tillSessionView
	return v, rows.Scan(&v.ID, &v.TerminalID, &v.TerminalName, &v.TerminalKind,
		&v.OpenedBy, &v.OpenedAt, &v.FloatPaise, &v.Status,
		&v.ClosedBy, &v.ClosedAt, &v.CountedPaise, &v.ExpectedPais,
		&v.PaidOutPaise, &v.VariancePais, &v.Reason,
		&v.CashSalesPaise, &v.CashReturnsPaise, &v.AccountPaise,
		&v.SaleCount, &v.ReturnCount)
}

func (s *Server) listTillSessions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := httpx.IdentityFrom(r.Context())
	var tol int64 = 5000
	items, err := collect(s, r, tillSessionSQL+`
		 WHERE ($1::text IS NULL OR ts.status = $1)
		   AND ($2::uuid IS NULL OR ts.terminal_id = $2)
		   AND ($3::text IS NULL OR t.kind = $3)
		 ORDER BY ts.opened_at DESC
		 LIMIT 200`,
		[]any{nullString(q.Get("status")), nullString(q.Get("terminal_id")),
			nullString(q.Get("kind"))}, scanTillSession)
	if err == nil {
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			var e error
			tol, e = colTolerance(r.Context(), tx, id.InstitutionID)
			return e
		})
	}
	for i := range items {
		items[i].TolerancePaise = tol
	}
	respond(w, r, items, err)
}

func (s *Server) getTillSession(w http.ResponseWriter, r *http.Request) {
	sid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var view tillSessionView
	var lines []posSaleView
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), tillSessionSQL+` WHERE ts.id = $1`, sid)
		if err != nil {
			return err
		}
		found := false
		for rows.Next() {
			view, err = scanTillSession(rows)
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
		if view.TolerancePaise, err = colTolerance(r.Context(), tx, id.InstitutionID); err != nil {
			return err
		}
		lines, err = colSalesOfSession(r.Context(), tx, sid)
		return err
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"session": view, "sales": lines})
}

type openTillRequest struct {
	TerminalID       string `json:"terminal_id"`
	OpeningFloatPais *int64 `json:"opening_float_paise"`
	Notes            string `json:"notes"`
}

/*
openTillSession starts a shift.

	The float is required rather than defaulted to zero. A drawer opened with
	"nothing" that in fact had five hundred rupees of change in it is short by
	five hundred at close, and the cashier discovers this at the point where
	nobody can reconstruct what happened. Typing 0 is a statement; leaving it
	blank is not, and colMoney is what tells the two apart.

	The session is opened as the caller. There is deliberately no "opened_by"
	field on the request: a cashier who can nominate somebody else as the
	holder of the drawer is the whole of the control gone.
*/
func (s *Server) openTillSession(w http.ResponseWriter, r *http.Request) {
	var req openTillRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var out string
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		term, err := uuid.Parse(strings.TrimSpace(req.TerminalID))
		if err != nil {
			return refusal("which counter is being opened?")
		}
		float, err := colMoney("the opening float", req.OpeningFloatPais, true)
		if err != nil {
			return err
		}

		var active bool
		var campus *uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT is_active, campus_id FROM pos_terminals WHERE id = $1`, term).
			Scan(&active, &campus); err != nil {
			return err
		}
		if !active {
			return refusal("that counter is retired -- reactivate it before opening a till")
		}

		// The partial unique index enforces this too. Checking first means the
		// cashier is told who has the drawer rather than shown a constraint.
		var holder string
		switch err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(u.full_name, 'somebody')
			  FROM pos_till_sessions ts
			  LEFT JOIN users u ON u.id = ts.opened_by
			 WHERE ts.terminal_id = $1 AND ts.status = 'open'`, term).Scan(&holder); {
		case err == nil:
			return refusef("%s already has that till open -- cash it up first", holder)
		case errors.Is(err, pgx.ErrNoRows):
		default:
			return err
		}

		return tx.QueryRow(r.Context(), `
			INSERT INTO pos_till_sessions
			    (institution_id, campus_id, terminal_id, opened_by,
			     opening_float_paise, notes)
			VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING id::text`,
			id.InstitutionID, campus, term, id.UserID, float,
			nullString(req.Notes)).Scan(&out)
	}, map[string]any{"id": &out})
}

type closeTillRequest struct {
	CountedCashPaise *int64 `json:"counted_cash_paise"`
	PaidOutPaise     *int64 `json:"paid_out_paise"`
	VarianceReason   string `json:"variance_reason"`
}

/*
closeTillSession cashes up, and is the reason this feature exists.

	expected is computed here, once, and written to the row:

	    opening float + cash taken - cash refunded - cash paid out

	Charged-to-account sales are deliberately absent from it. That money never
	entered the drawer; it went onto an invoice, and counting it as expected
	cash would make every till with an account customer look short by exactly
	the amount it did not take.

	The figure is frozen rather than recomputed on read because the sales
	behind it can be returned tomorrow, and a variance report that quietly
	restates last Tuesday's shortfall defeats the point of having asked anyone
	to sign for it.
*/
func (s *Server) closeTillSession(w http.ResponseWriter, r *http.Request) {
	sid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req closeTillRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	out := map[string]any{}
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		counted, err := colMoney("the counted cash", req.CountedCashPaise, true)
		if err != nil {
			return err
		}
		paidOut := int64(0)
		if req.PaidOutPaise != nil {
			if paidOut, err = colMoney("the paid-out total", req.PaidOutPaise, true); err != nil {
				return err
			}
		}

		// FOR UPDATE: a sale landing between the sum and the UPDATE would be
		// takings nobody is accountable for.
		var status string
		var float int64
		if err := tx.QueryRow(r.Context(), `
			SELECT status, opening_float_paise
			  FROM pos_till_sessions WHERE id = $1 FOR UPDATE`, sid).
			Scan(&status, &float); err != nil {
			return err
		}
		if status != "open" {
			return refusal("that till has already been cashed up")
		}

		var cashIn, cashOut int64
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(sum(CASE WHEN kind = 'sale'   THEN total_paise ELSE 0 END), 0),
			       COALESCE(sum(CASE WHEN kind = 'return' THEN total_paise ELSE 0 END), 0)
			  FROM pos_sales
			 WHERE session_id = $1 AND payment_mode = 'cash'`, sid).
			Scan(&cashIn, &cashOut); err != nil {
			return err
		}

		expected := float + cashIn - cashOut - paidOut
		if expected < 0 {
			return refusef(
				"that paid-out figure is more than the drawer ever held: float %s plus takings %s",
				indianRupees(float), indianRupees(cashIn))
		}
		variance := counted - expected

		tol, err := colTolerance(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		reason := strings.TrimSpace(req.VarianceReason)
		// Inside tolerance a shortfall is a coin; outside it, somebody has to
		// say what happened before the shift can be signed off. The database
		// insists on a reason for any difference at all; this insists earlier,
		// and with a sentence naming the figure.
		abs := variance
		if abs < 0 {
			abs = -abs
		}
		if variance != 0 && reason == "" {
			if abs > tol {
				return refusef("the drawer is %s %s -- say what happened before closing",
					map[bool]string{true: "over by", false: "short by"}[variance > 0],
					indianRupees(abs))
			}
			reason = "Within tolerance; not investigated."
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE pos_till_sessions
			   SET status = 'closed', closed_by = $2, closed_at = now(),
			       counted_cash_paise = $3, expected_cash_paise = $4,
			       paid_out_paise = $5, variance_reason = NULLIF($6,'')
			 WHERE id = $1`,
			sid, id.UserID, counted, expected, paidOut, reason); err != nil {
			return err
		}
		out["expected_cash_paise"] = expected
		out["counted_cash_paise"] = counted
		out["variance_paise"] = variance
		out["over_tolerance"] = abs > tol
		return nil
	}, out)
}

type tillVarianceRow struct {
	SessionID    string  `json:"session_id"`
	TerminalName string  `json:"terminal_name"`
	TerminalKind string  `json:"terminal_kind"`
	OpenedBy     string  `json:"opened_by"`
	ClosedAt     string  `json:"closed_at"`
	ExpectedPais int64   `json:"expected_cash_paise"`
	CountedPaise int64   `json:"counted_cash_paise"`
	VariancePais int64   `json:"variance_paise"`
	Reason       *string `json:"variance_reason,omitempty"`
	OverTol      bool    `json:"over_tolerance"`
}

/*
getTillVariance is the variance report.

	Not a list of sessions with a variance column: a list ordered by how badly
	the drawer disagreed, filtered to the ones outside the school's tolerance,
	because the question a bursar has is "which tills are wrong" and no other.
	A till that balanced is not an entry in this report.

	Ordered by the absolute variance rather than by date, so a five-thousand-
	rupee shortfall from Tuesday sits above a fifty-rupee one from this
	morning.
*/
func (s *Server) getTillVariance(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, err := colDate(q.Get("from"))
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if strings.TrimSpace(q.Get("from")) == "" {
		from = from.AddDate(0, 0, -30)
	}
	to, err := colDate(q.Get("to"))
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var tol int64 = 5000
	var rowsOut []tillVarianceRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var e error
		if tol, e = colTolerance(r.Context(), tx, id.InstitutionID); e != nil {
			return e
		}
		// $4 is compared against a bigint on both sides of the OR, so it is
		// deduced as bigint once. Writing abs(...) > $4 and -$4 > ... with a
		// bare literal on one side is how a $n ends up deduced as integer here
		// and bigint there, which Postgres reports as 42P08.
		rows, e := tx.Query(r.Context(), `
			SELECT ts.id::text, t.name, t.kind, COALESCE(u.full_name, '—'),
			       to_char(ts.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       ts.expected_cash_paise, ts.counted_cash_paise, ts.variance_paise,
			       ts.variance_reason
			  FROM pos_till_sessions ts
			  JOIN pos_terminals t ON t.id = ts.terminal_id
			  LEFT JOIN users u ON u.id = ts.opened_by
			 WHERE ts.status = 'closed'
			   AND ts.closed_at >= $1::date
			   AND ts.closed_at <  ($2::date + 1)
			   AND ($3::text IS NULL OR t.kind = $3)
			   AND abs(ts.variance_paise) > $4::bigint
			 ORDER BY abs(ts.variance_paise) DESC, ts.closed_at DESC
			 LIMIT 200`,
			from, to, nullString(q.Get("kind")), tol)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var v tillVarianceRow
			if e := rows.Scan(&v.SessionID, &v.TerminalName, &v.TerminalKind,
				&v.OpenedBy, &v.ClosedAt, &v.ExpectedPais, &v.CountedPaise,
				&v.VariancePais, &v.Reason); e != nil {
				return e
			}
			v.OverTol = true
			rowsOut = append(rowsOut, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if rowsOut == nil {
		rowsOut = []tillVarianceRow{}
	}
	var short, over int64
	for _, v := range rowsOut {
		if v.VariancePais < 0 {
			short -= v.VariancePais
		} else {
			over += v.VariancePais
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":                    rowsOut,
		"variance_tolerance_paise": tol,
		"total_short_paise":        short,
		"total_over_paise":         over,
		"from":                     from.Format("2006-01-02"),
		"to":                       to.Format("2006-01-02"),
	})
}

// --- the store catalogue -----------------------------------------------------

type storeProductView struct {
	ID           string  `json:"id"`
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	Category     string  `json:"category"`
	HSNCode      *string `json:"hsn_code,omitempty"`
	TaxRateBP    int     `json:"tax_rate_bp"`
	PricePaise   int64   `json:"sale_price_paise"`
	ReturnWindow *int    `json:"return_window_days,omitempty"`
	IsActive     bool    `json:"is_active"`
	VariantCount int     `json:"variant_count"`
	OnHand       int     `json:"on_hand"`
}

type storeProductRequest struct {
	ID           string `json:"id"`
	Code         string `json:"code"`
	Name         string `json:"name"`
	Category     string `json:"category"`
	HSNCode      string `json:"hsn_code"`
	TaxRateBP    *int   `json:"tax_rate_bp"`
	PricePaise   *int64 `json:"sale_price_paise"`
	ReturnWindow *int   `json:"return_window_days"`
	IsActive     *bool  `json:"is_active"`
}

func (s *Server) listStoreProducts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT p.id::text, p.code, p.name, p.category, p.hsn_code, p.tax_rate_bp,
		       p.sale_price_paise, p.return_window_days, p.is_active,
		       COALESCE(v.n, 0)::int, COALESCE(v.stock, 0)::int
		  FROM store_products p
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS n, sum(i.on_hand) AS stock
		        FROM store_product_variants sv
		        JOIN inventory_items i ON i.id = sv.item_id
		       WHERE sv.product_id = p.id AND sv.is_active
		  ) v ON true
		 WHERE ($1::text IS NULL OR p.category = $1)
		   AND ($2::bool IS NULL OR p.is_active = $2)
		 ORDER BY p.is_active DESC, p.name`,
		[]any{nullString(q.Get("category")), nullBool(q.Get("active"))},
		func(rows pgx.Rows) (storeProductView, error) {
			var v storeProductView
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Category, &v.HSNCode,
				&v.TaxRateBP, &v.PricePaise, &v.ReturnWindow, &v.IsActive,
				&v.VariantCount, &v.OnHand)
		})
	respond(w, r, items, err)
}

func (s *Server) saveStoreProduct(w http.ResponseWriter, r *http.Request) {
	var req storeProductRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var out string
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		req.Code = strings.TrimSpace(req.Code)
		req.Name = strings.TrimSpace(req.Name)
		req.Category = strings.TrimSpace(req.Category)
		if req.Category == "" {
			req.Category = "other"
		}
		switch {
		case req.Code == "":
			return refusal("give the item a short code")
		case req.Name == "":
			return refusal("what is the item called?")
		case !oneOfStr(req.Category, "uniform", "book", "stationery", "sports", "other"):
			return refusal("category must be uniform, book, stationery, sports or other")
		}
		price, err := colMoney("the price", req.PricePaise, true)
		if err != nil {
			return err
		}
		tax := 0
		if req.TaxRateBP != nil {
			tax = *req.TaxRateBP
		}
		if tax < 0 || tax > 10000 {
			return refusal("the GST rate is basis points: 500 is 5%, and it cannot exceed 10000")
		}
		if req.ReturnWindow != nil && (*req.ReturnWindow < 0 || *req.ReturnWindow > 365) {
			return refusal("a return window is between 0 and 365 days")
		}
		active := true
		if req.IsActive != nil {
			active = *req.IsActive
		}
		if pid := strings.TrimSpace(req.ID); pid != "" {
			u, err := uuid.Parse(pid)
			if err != nil {
				return refusal("malformed item id")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE store_products
				   SET code=$3, name=$4, category=$5, hsn_code=$6, tax_rate_bp=$7,
				       sale_price_paise=$8, return_window_days=$9, is_active=$10,
				       updated_at=now()
				 WHERE id=$1 AND institution_id=$2
				 RETURNING id::text`,
				u, id.InstitutionID, req.Code, req.Name, req.Category,
				nullString(req.HSNCode), tax, price, req.ReturnWindow, active).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO store_products
			    (institution_id, code, name, category, hsn_code, tax_rate_bp,
			     sale_price_paise, return_window_days, is_active, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			RETURNING id::text`,
			id.InstitutionID, req.Code, req.Name, req.Category,
			nullString(req.HSNCode), tax, price, req.ReturnWindow, active,
			id.UserID).Scan(&out)
	}, map[string]any{"id": &out})
}

type storeVariantView struct {
	ID          string  `json:"id"`
	ProductID   string  `json:"product_id"`
	ProductName string  `json:"product_name"`
	ItemID      string  `json:"item_id"`
	ItemCode    string  `json:"item_code"`
	Size        *string `json:"size,omitempty"`
	Colour      *string `json:"colour,omitempty"`
	VariantNote *string `json:"variant_note,omitempty"`
	PricePaise  int64   `json:"price_paise"`
	TaxRateBP   int     `json:"tax_rate_bp"`
	OnHand      int     `json:"on_hand"`
	IsActive    bool    `json:"is_active"`
	Label       string  `json:"label"`
}

type storeVariantRequest struct {
	ProductID   string `json:"product_id"`
	ItemID      string `json:"item_id"`
	Size        string `json:"size"`
	Colour      string `json:"colour"`
	VariantNote string `json:"variant_note"`
	PricePaise  *int64 `json:"sale_price_paise"`
	IsActive    *bool  `json:"is_active"`
}

/*
colVariantLabel is what goes on the receipt: "White shirt — 32 / White".

	Built in SQL as well as here would be two labels that drift apart, so the
	SQL returns the parts and this assembles them. An empty label for a book
	with neither size nor colour is correct and prints as nothing.
*/
func colVariantLabel(size, colour, note *string) string {
	parts := make([]string, 0, 3)
	for _, p := range []*string{size, colour, note} {
		if p != nil && strings.TrimSpace(*p) != "" {
			parts = append(parts, strings.TrimSpace(*p))
		}
	}
	return strings.Join(parts, " / ")
}

const storeVariantSQL = `
	SELECT v.id::text, v.product_id::text, p.name, v.item_id::text, i.code,
	       v.size, v.colour, v.variant_note,
	       COALESCE(v.sale_price_paise, p.sale_price_paise), p.tax_rate_bp,
	       i.on_hand, v.is_active
	  FROM store_product_variants v
	  JOIN store_products p  ON p.id = v.product_id
	  JOIN inventory_items i ON i.id = v.item_id`

func (s *Server) listStoreVariants(w http.ResponseWriter, r *http.Request) {
	product, err := queryUUID(r, "product_id")
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	items, err := collect(s, r, storeVariantSQL+`
		 WHERE ($1::uuid IS NULL OR v.product_id = $1)
		   AND ($2::bool IS NULL OR v.is_active = $2)
		 ORDER BY p.name, v.size NULLS FIRST, v.colour NULLS FIRST`,
		[]any{product, nullBool(r.URL.Query().Get("active"))},
		func(rows pgx.Rows) (storeVariantView, error) {
			var v storeVariantView
			if err := rows.Scan(&v.ID, &v.ProductID, &v.ProductName, &v.ItemID,
				&v.ItemCode, &v.Size, &v.Colour, &v.VariantNote, &v.PricePaise,
				&v.TaxRateBP, &v.OnHand, &v.IsActive); err != nil {
				return v, err
			}
			v.Label = colVariantLabel(v.Size, v.Colour, v.VariantNote)
			return v, nil
		})
	respond(w, r, items, err)
}

/*
saveStoreVariant ties a size to the shelf that holds it.

	item_id is an existing inventory_items row and is never created here. That
	is the whole of the "no second stock ledger" rule made operational: the
	stores module owns what exists and how many there are, and this feature
	owns what it is called on a price list and what it sells for. A handler
	that quietly created stock rows would be a second stores screen with no
	purchase order behind it.
*/
func (s *Server) saveStoreVariant(w http.ResponseWriter, r *http.Request) {
	var req storeVariantRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var out string
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		product, err := uuid.Parse(strings.TrimSpace(req.ProductID))
		if err != nil {
			return refusal("which item is this a variant of?")
		}
		item, err := uuid.Parse(strings.TrimSpace(req.ItemID))
		if err != nil {
			return refusal("pick the stores item that holds this size -- it is what the sale will draw down")
		}
		if req.PricePaise != nil && *req.PricePaise < 0 {
			return refusal("a price cannot be negative")
		}
		active := true
		if req.IsActive != nil {
			active = *req.IsActive
		}

		var takenBy *string
		switch err := tx.QueryRow(r.Context(), `
			SELECT p.name FROM store_product_variants v
			  JOIN store_products p ON p.id = v.product_id
			 WHERE v.item_id = $1`, item).Scan(&takenBy); {
		case err == nil:
			return refusef(
				"that stores item is already the shelf for %s -- one item, one variant, or the stock count has two answers",
				*takenBy)
		case errors.Is(err, pgx.ErrNoRows):
		default:
			return err
		}

		return tx.QueryRow(r.Context(), `
			INSERT INTO store_product_variants
			    (institution_id, product_id, item_id, size, colour, variant_note,
			     sale_price_paise, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			RETURNING id::text`,
			id.InstitutionID, product, item, nullString(req.Size),
			nullString(req.Colour), nullString(req.VariantNote),
			req.PricePaise, active).Scan(&out)
	}, map[string]any{"id": &out})
}

type colStockItemView struct {
	ID     string `json:"id"`
	Code   string `json:"code"`
	Name   string `json:"name"`
	OnHand int    `json:"on_hand"`
	Taken  bool   `json:"taken"`
}

/*
listStockItems lists the stores rows a variant can be attached to.

	The stores module already has this list behind InventoryRead, and this is
	deliberately a second read of it rather than a link to that screen: the
	person setting up the uniform price list is a finance clerk who has no
	business holding the stores permission, and sending them to a screen they
	are refused is the same as not shipping the feature.

	It reads inventory_items and creates nothing. `taken` marks the rows that
	are already some variant's shelf, so the form can grey them out rather than
	letting the clerk discover the collision on save.
*/
func (s *Server) listStockItems(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT i.id::text, i.code, i.name, i.on_hand, v.id IS NOT NULL
		  FROM inventory_items i
		  LEFT JOIN store_product_variants v ON v.item_id = i.id
		 ORDER BY i.name`, nil,
		func(rows pgx.Rows) (colStockItemView, error) {
			var v colStockItemView
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.OnHand, &v.Taken)
		})
	respond(w, r, items, err)
}

// --- sales -------------------------------------------------------------------

type posSaleLineView struct {
	ID           string  `json:"id"`
	LineNo       int     `json:"line_no"`
	VariantID    *string `json:"variant_id,omitempty"`
	ItemName     string  `json:"item_name"`
	Category     string  `json:"category"`
	VariantLabel *string `json:"variant_label,omitempty"`
	Quantity     int     `json:"quantity"`
	UnitPaise    int64   `json:"unit_paise"`
	DiscountPais int64   `json:"discount_paise"`
	TaxPaise     int64   `json:"tax_paise"`
	LinePaise    int64   `json:"line_paise"`
	ReturnedQty  int     `json:"returned_quantity"`
}

type posSaleView struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	Channel      string  `json:"channel"`
	SessionID    string  `json:"session_id"`
	TerminalName string  `json:"terminal_name"`
	OriginalID   *string `json:"original_sale_id,omitempty"`
	StudentID    *string `json:"student_id,omitempty"`
	StudentName  *string `json:"student_name,omitempty"`
	BuyerName    *string `json:"buyer_name,omitempty"`
	SoldAt       string  `json:"sold_at"`
	SoldOn       string  `json:"sold_on"`
	PaymentMode  string  `json:"payment_mode"`
	SubtotalPais int64   `json:"subtotal_paise"`
	DiscountPais int64   `json:"discount_paise"`
	TaxPaise     int64   `json:"tax_paise"`
	TotalPaise   int64   `json:"total_paise"`
	ReceiptNo    string  `json:"receipt_no"`
	InvoiceID    *string `json:"invoice_id,omitempty"`
	InvoiceNo    *string `json:"invoice_no,omitempty"`
	SoldBy       *string `json:"sold_by,omitempty"`
	Remarks      *string `json:"remarks,omitempty"`
	// Present only on the single-sale view.
	Lines []posSaleLineView `json:"lines,omitempty"`
}

const posSaleSQL = `
	SELECT s.id::text, s.kind, s.channel, s.session_id::text, t.name,
	       s.original_sale_id::text, s.student_id::text,
	       btrim(st.first_name || ' ' || COALESCE(st.last_name, '')),
	       s.buyer_name,
	       to_char(s.sold_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
	       to_char(s.sold_on, 'YYYY-MM-DD'),
	       s.payment_mode, s.subtotal_paise, s.discount_paise, s.tax_paise,
	       s.total_paise, s.receipt_no, s.invoice_id::text, iv.invoice_no,
	       u.full_name, s.remarks
	  FROM pos_sales s
	  JOIN pos_till_sessions ts ON ts.id = s.session_id
	  JOIN pos_terminals t      ON t.id  = ts.terminal_id
	  LEFT JOIN students st ON st.id = s.student_id
	  LEFT JOIN invoices iv ON iv.id = s.invoice_id
	  LEFT JOIN users u     ON u.id  = s.sold_by`

func scanPosSale(rows pgx.Rows) (posSaleView, error) {
	var v posSaleView
	return v, rows.Scan(&v.ID, &v.Kind, &v.Channel, &v.SessionID, &v.TerminalName,
		&v.OriginalID, &v.StudentID, &v.StudentName, &v.BuyerName,
		&v.SoldAt, &v.SoldOn, &v.PaymentMode, &v.SubtotalPais, &v.DiscountPais,
		&v.TaxPaise, &v.TotalPaise, &v.ReceiptNo, &v.InvoiceID, &v.InvoiceNo,
		&v.SoldBy, &v.Remarks)
}

func colSalesOfSession(ctx context.Context, tx pgx.Tx, session uuid.UUID) ([]posSaleView, error) {
	rows, err := tx.Query(ctx, posSaleSQL+` WHERE s.session_id = $1 ORDER BY s.sold_at DESC`, session)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []posSaleView{}
	for rows.Next() {
		v, err := scanPosSale(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Server) listPosSales(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, err := colDate(q.Get("from"))
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if strings.TrimSpace(q.Get("from")) == "" {
		from = from.AddDate(0, 0, -7)
	}
	to, err := colDate(q.Get("to"))
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	student, err := queryUUID(r, "student_id")
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	items, err := collect(s, r, posSaleSQL+`
		 WHERE s.sold_on BETWEEN $1::date AND $2::date
		   AND ($3::text IS NULL OR s.channel = $3)
		   AND ($4::uuid IS NULL OR s.student_id = $4)
		   AND ($5::uuid IS NULL OR s.session_id = $5)
		 ORDER BY s.sold_at DESC
		 LIMIT 300`,
		[]any{from, to, nullString(q.Get("channel")), student,
			nullString(q.Get("session_id"))}, scanPosSale)
	respond(w, r, items, err)
}

func (s *Server) getPosSale(w http.ResponseWriter, r *http.Request) {
	sid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var sale posSaleView
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), posSaleSQL+` WHERE s.id = $1`, sid)
		if err != nil {
			return err
		}
		found := false
		for rows.Next() {
			sale, err = scanPosSale(rows)
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
		sale.Lines, err = colSaleLines(r.Context(), tx, sid)
		return err
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, sale)
}

/*
colSaleLines reads a sale's lines with how much of each has come back.

	The returned quantity is summed from the return sales pointing at this one
	rather than kept as a counter on the line. A counter that drifts is worse
	than no counter -- the same argument sync_inventory_on_hand() makes -- and
	here a drifted counter would let a uniform be returned twice.

	Returns are matched to the original line by variant where there is one and
	by item name where there is not, because a canteen line has no variant and
	a snack is identified by nothing else.
*/
func colSaleLines(ctx context.Context, tx pgx.Tx, sale uuid.UUID) ([]posSaleLineView, error) {
	rows, err := tx.Query(ctx, `
		SELECT l.id::text, l.line_no, l.variant_id::text, l.item_name, l.category,
		       l.variant_label, l.quantity, l.unit_paise, l.discount_paise,
		       l.tax_paise, l.line_paise,
		       COALESCE(rt.qty, 0)::int
		  FROM pos_sale_lines l
		  LEFT JOIN LATERAL (
		      SELECT sum(rl.quantity) AS qty
		        FROM pos_sales rs
		        JOIN pos_sale_lines rl ON rl.sale_id = rs.id
		       WHERE rs.original_sale_id = l.sale_id
		         AND rs.kind = 'return'
		         AND COALESCE(rl.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
		           = COALESCE(l.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
		         AND lower(btrim(rl.item_name)) = lower(btrim(l.item_name))
		  ) rt ON true
		 WHERE l.sale_id = $1
		 ORDER BY l.line_no`, sale)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []posSaleLineView{}
	for rows.Next() {
		var v posSaleLineView
		if err := rows.Scan(&v.ID, &v.LineNo, &v.VariantID, &v.ItemName, &v.Category,
			&v.VariantLabel, &v.Quantity, &v.UnitPaise, &v.DiscountPais,
			&v.TaxPaise, &v.LinePaise, &v.ReturnedQty); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

type posSaleLineRequest struct {
	// A store line names a variant and takes its price and name from it. A
	// canteen line names neither and carries its own.
	VariantID      string `json:"variant_id"`
	ItemName       string `json:"item_name"`
	Category       string `json:"category"`
	Quantity       *int   `json:"quantity"`
	UnitPaise      *int64 `json:"unit_paise"`
	DiscountPaise  *int64 `json:"discount_paise"`
	OriginalLineID string `json:"original_line_id"`
}

type posSaleRequest struct {
	SessionID   string               `json:"session_id"`
	StudentID   string               `json:"student_id"`
	BuyerName   string               `json:"buyer_name"`
	PaymentMode string               `json:"payment_mode"`
	SoldOn      string               `json:"sold_on"`
	Remarks     string               `json:"remarks"`
	Lines       []posSaleLineRequest `json:"lines"`
}

// colPricedLine is one resolved line, after the catalogue has had its say.
type colPricedLine struct {
	VariantID *uuid.UUID
	Name      string
	Category  string
	Label     *string
	Quantity  int
	UnitPaise int64
	Discount  int64
	Tax       int64
	Total     int64
	OnHand    int
}

/*
colResolveLines turns what the counter typed into what will be written.

	A store line is priced from the catalogue, never from the request. A till
	that accepts a price from its own client is a till whose takings are
	whatever the person at the keyboard says they are, and the variance report
	then reconciles a number the same person chose. The clerk may discount, and
	the discount is recorded as a discount, which is exactly the difference.

	Tax is computed on the discounted line at the product's rate, in integer
	paise, rounded half up. Rounding down loses a paisa per line, which is a
	GSTR-1 that does not tie to the receipts.

	A canteen line is priced free-hand because there is no catalogue behind it
	-- a contractor's menu changes weekly and 00035 already refused to make the
	parent's receipt depend on a maintained item master.
*/
func colResolveLines(ctx context.Context, tx pgx.Tx, channel string,
	in []posSaleLineRequest) ([]colPricedLine, error) {

	if len(in) == 0 {
		return nil, refusal("a sale needs at least one line")
	}
	if len(in) > 100 {
		return nil, refusal("that is more than a hundred lines -- ring it up as two sales")
	}

	out := make([]colPricedLine, 0, len(in))
	for i, l := range in {
		qty := 1
		if l.Quantity != nil {
			qty = *l.Quantity
		}
		if qty <= 0 {
			return nil, refusef("line %d has no quantity", i+1)
		}

		var p colPricedLine
		p.Quantity = qty
		p.Category = strings.TrimSpace(l.Category)

		if raw := strings.TrimSpace(l.VariantID); raw != "" {
			if channel != "store" {
				return nil, refusal("a canteen line does not come off the stock shelf")
			}
			vid, err := uuid.Parse(raw)
			if err != nil {
				return nil, refusef("line %d names a variant that is not an id", i+1)
			}
			var size, colour, note *string
			var name string
			var price int64
			var taxBP, onHand int
			var active bool
			if err := tx.QueryRow(ctx, `
				SELECT p.name, COALESCE(v.sale_price_paise, p.sale_price_paise),
				       p.tax_rate_bp, p.category, i.on_hand,
				       v.size, v.colour, v.variant_note, v.is_active AND p.is_active
				  FROM store_product_variants v
				  JOIN store_products p  ON p.id = v.product_id
				  JOIN inventory_items i ON i.id = v.item_id
				 WHERE v.id = $1`, vid).
				Scan(&name, &price, &taxBP, &p.Category, &onHand,
					&size, &colour, &note, &active); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, refusef("line %d names an item the store does not stock", i+1)
				}
				return nil, err
			}
			if !active {
				return nil, refusef("%s is no longer on sale", name)
			}
			p.VariantID = &vid
			p.Name = name
			p.UnitPaise = price
			p.OnHand = onHand
			if lbl := colVariantLabel(size, colour, note); lbl != "" {
				p.Label = &lbl
			}
			if l.UnitPaise != nil && *l.UnitPaise != price {
				// Said out loud rather than silently overridden: a counter that
				// quietly ignores the price it was sent is one nobody can debug.
				return nil, refusef(
					"%s is priced at %s -- record a difference as a discount, not as another price",
					name, indianRupees(price))
			}
			gross := price * int64(qty)
			if l.DiscountPaise != nil {
				p.Discount = *l.DiscountPaise
			}
			if p.Discount < 0 || p.Discount > gross {
				return nil, refusef("the discount on %s is more than the line", name)
			}
			net := gross - p.Discount
			// Half up on integer paise. (net*bp + 5000) / 10000.
			p.Tax = (net*int64(taxBP) + 5000) / 10000
			p.Total = net + p.Tax
		} else {
			if channel == "store" {
				return nil, refusef("line %d has to name a stock item -- the store sells what it counts", i+1)
			}
			p.Name = strings.TrimSpace(l.ItemName)
			if p.Name == "" {
				return nil, refusef("line %d has no item on it", i+1)
			}
			unit, err := colMoney(fmt.Sprintf("the price on line %d", i+1), l.UnitPaise, true)
			if err != nil {
				return nil, err
			}
			p.UnitPaise = unit
			gross := unit * int64(qty)
			if l.DiscountPaise != nil {
				p.Discount = *l.DiscountPaise
			}
			if p.Discount < 0 || p.Discount > gross {
				return nil, refusef("the discount on %s is more than the line", p.Name)
			}
			p.Total = gross - p.Discount
			if p.Category == "" {
				p.Category = "snack"
			}
		}

		if !oneOfStr(p.Category, "meal", "snack", "beverage", "dessert", "fruit",
			"uniform", "book", "stationery", "other") {
			p.Category = "other"
		}
		out = append(out, p)
	}
	return out, nil
}

/*
colEnsurePosSeries makes sure the till has a numbering scheme before one is
drawn from it.

	fees.NextNumberOn creates a missing scheme itself, but only knows prefixes
	for 'receipt' and 'invoice'; a till series created by that path would come
	out as "/2026-27/00001" with a leading slash and no prefix, printed on
	every receipt until somebody noticed. The upsert here is ON CONFLICT DO
	NOTHING and therefore never overrides a school that has set its own prefix,
	which is the same reason NextNumberOn does it that way.
*/
func colEnsurePosSeries(ctx context.Context, tx pgx.Tx, instID uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO numbering_schemes
		    (institution_id, kind, prefix, padding, next_value, reset_yearly)
		VALUES ($1,'pos','POS/',5,1,true)
		ON CONFLICT (institution_id, kind) WHERE campus_id IS NULL DO NOTHING`,
		instID)
	return err
}

/*
colChargeToAccount raises the fee-ledger document for a charge-to-account sale.

	One invoice per sale, rather than a running canteen account. A running
	account would be a second ledger with its own ageing, its own reminders and
	its own idea of what a family owes, sitting beside the one the fee module
	already maintains -- and the parent would then be chased twice. As an
	invoice it appears on the statement, ages with everything else, is settled
	at the fee counter by fees.Collect, and a return reduces it.

	The invoice number comes from the same numbering_schemes machinery as every
	other invoice, under the same row lock, so the two cannot fork.
*/
func colChargeToAccount(ctx context.Context, tx pgx.Tx, instID, userID, student uuid.UUID,
	channel string, on time.Time, total int64, narration string) (uuid.UUID, string, error) {

	var headCol string
	if channel == "canteen" {
		headCol = "canteen_fee_head_id"
	} else {
		headCol = "store_fee_head_id"
	}
	var head *uuid.UUID
	err := tx.QueryRow(ctx,
		`SELECT `+headCol+` FROM collections_settings WHERE institution_id = $1`, instID).
		Scan(&head)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, "", err
	}
	if head == nil {
		return uuid.Nil, "", refusef(
			"no fee head is set for %s charges -- set one in collections settings before charging an account",
			channel)
	}

	var campus, year uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT campus_id FROM students WHERE id = $1`, student).Scan(&campus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, "", refusal("that child is not on the roll")
		}
		return uuid.Nil, "", err
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM academic_years WHERE is_current ORDER BY starts_on DESC LIMIT 1`).
		Scan(&year); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, "", refusal("no academic year is marked current -- an invoice cannot be filed against nothing")
		}
		return uuid.Nil, "", err
	}

	number, err := fees.NextNumberOn(ctx, tx, instID, "invoice", on)
	if err != nil {
		return uuid.Nil, "", err
	}

	var invoice uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO invoices
		    (institution_id, campus_id, student_id, academic_year_id, invoice_no,
		     issued_on, due_on, gross_paise, status)
		VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'unpaid')
		RETURNING id`,
		instID, campus, student, year, number.Text, on, total).Scan(&invoice); err != nil {
		return uuid.Nil, "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO invoice_lines
		    (institution_id, invoice_id, fee_head_id, description, amount_paise)
		VALUES ($1,$2,$3,$4,$5)`,
		instID, invoice, *head, narration, total); err != nil {
		return uuid.Nil, "", err
	}
	_ = userID
	return invoice, number.Text, nil
}

/*
recordPosSale rings up one transaction.

	One request, one round trip, one transaction. A canteen counter has a queue
	of nine-year-olds and twenty minutes; a flow that posted a header and then
	each line would leave half-sales behind the first time the tablet lost its
	signal, and half a sale is stock issued for money nobody took.

	Order matters inside the transaction and is not arbitrary:

	  1. the session is locked and checked open -- a sale into a cashed-up till
	     is takings nobody is accountable for
	  2. lines are priced from the catalogue
	  3. stock is checked, so a shirt that is not there is refused with a
	     sentence rather than driving on_hand negative
	  4. the receipt number is drawn, under the fee engine's row lock
	  5. the account charge, if any, raises its invoice
	  6. the sale and its lines are written, and inserting the lines is what
	     moves the stock, through the trigger

	Everything or nothing. A receipt handed over for a sale that failed to
	write is the failure this ordering exists to prevent.
*/
func (s *Server) recordPosSale(w http.ResponseWriter, r *http.Request) {
	var req posSaleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	out := map[string]any{}
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		session, err := uuid.Parse(strings.TrimSpace(req.SessionID))
		if err != nil {
			return refusal("which till is this sale on? open one first")
		}
		soldOn, err := colDate(req.SoldOn)
		if err != nil {
			return err
		}
		mode := strings.TrimSpace(req.PaymentMode)
		if mode == "" {
			mode = "cash"
		}
		if mode != "cash" && mode != "account" {
			// Named explicitly because somebody will ask.
			return refusal("this counter takes cash or charges the child's fee account. There is no wallet and no card: the campus wallet feature is blocked for want of a payment gateway")
		}

		var status, channel string
		var campus *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT ts.status, t.kind, ts.campus_id
			  FROM pos_till_sessions ts
			  JOIN pos_terminals t ON t.id = ts.terminal_id
			 WHERE ts.id = $1 FOR UPDATE OF ts`, session).
			Scan(&status, &channel, &campus); err != nil {
			return err
		}
		if status != "open" {
			return refusal("that till is cashed up -- open a new session before selling")
		}

		student, err := optionalUUID(req.StudentID)
		if err != nil {
			return refusal("that is not a valid student")
		}
		buyer := strings.TrimSpace(req.BuyerName)
		if student == nil && buyer == "" {
			return refusal("who is buying? name the child, or type the buyer's name")
		}
		if mode == "account" && student == nil {
			return refusal("a charge needs an account to charge -- pick the child")
		}

		lines, err := colResolveLines(r.Context(), tx, channel, req.Lines)
		if err != nil {
			return err
		}

		var subtotal, discount, tax, total int64
		for _, l := range lines {
			subtotal += l.UnitPaise * int64(l.Quantity)
			discount += l.Discount
			tax += l.Tax
			total += l.Total
			if l.VariantID != nil && l.Quantity > l.OnHand {
				return refusef("only %d of %s left on the shelf", l.OnHand, l.Name)
			}
		}
		if total <= 0 {
			return refusal("a sale of nothing is not a sale")
		}

		if err := colEnsurePosSeries(r.Context(), tx, id.InstitutionID); err != nil {
			return err
		}
		number, err := fees.NextNumberOn(r.Context(), tx, id.InstitutionID, "pos", soldOn)
		if err != nil {
			return err
		}

		var invoice *uuid.UUID
		var invoiceNo string
		if mode == "account" {
			iv, no, err := colChargeToAccount(r.Context(), tx, id.InstitutionID,
				id.UserID, *student, channel, soldOn, total,
				fmt.Sprintf("%s counter, receipt %s", colTitle(channel), number.Text))
			if err != nil {
				return err
			}
			invoice, invoiceNo = &iv, no
		}

		var saleID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO pos_sales
			    (institution_id, campus_id, session_id, kind, channel, student_id,
			     buyer_name, sold_on, payment_mode, subtotal_paise, discount_paise,
			     tax_paise, total_paise, receipt_no, receipt_seq, receipt_fy,
			     invoice_id, remarks, sold_by)
			VALUES ($1,$2,$3,'sale',$4,$5,NULLIF($6,''),$7,$8,$9,$10,$11,$12,
			        $13,$14,NULLIF($15,''),$16,$17,$18)
			RETURNING id`,
			id.InstitutionID, campus, session, channel, student, buyer, soldOn,
			mode, subtotal, discount, tax, total, number.Text, number.Seq,
			number.FY, invoice, nullString(req.Remarks), id.UserID).Scan(&saleID); err != nil {
			return err
		}

		if err := colWriteLines(r.Context(), tx, id.InstitutionID, saleID, lines); err != nil {
			return err
		}
		if channel == "canteen" && student != nil {
			if err := colMirrorToCafeteria(r.Context(), tx, id, saleID, *student,
				campus, total, number.Text, lines); err != nil {
				return err
			}
		}

		out["id"] = saleID.String()
		out["receipt_no"] = number.Text
		out["total_paise"] = total
		out["payment_mode"] = mode
		if invoiceNo != "" {
			out["invoice_no"] = invoiceNo
		}
		return nil
	}, out)
}

func colWriteLines(ctx context.Context, tx pgx.Tx, instID, sale uuid.UUID,
	lines []colPricedLine) error {
	for i, l := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO pos_sale_lines
			    (institution_id, sale_id, line_no, variant_id, item_name, category,
			     variant_label, quantity, unit_paise, discount_paise, tax_paise,
			     line_paise)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			instID, sale, i+1, l.VariantID, l.Name, l.Category, l.Label,
			l.Quantity, l.UnitPaise, l.Discount, l.Tax, l.Total); err != nil {
			return err
		}
	}
	return nil
}

/*
colMirrorToCafeteria copies a canteen sale onto the parent-facing record.

	cafeteria_purchases and cafeteria_purchase_items exist since 00035 and are
	what the parent portal reads to answer the question a family actually asks
	-- what did my nine-year-old eat at eleven o'clock. A till that wrote only
	its own tables would leave that screen blank for every sale the new counter
	made, which is a regression dressed as a feature.

	This is a copy and is admitted as one. The alternative -- pointing the
	portal at pos_sales -- would put the parent's screen behind a table whose
	rows include staff purchases and store sales, and would have to filter them
	out on every read. The mirror is one insert on a path that already holds a
	transaction, and the two cannot disagree because nothing updates either.

	Only sales, and only for a child. cafeteria_purchases requires a student
	and a positive total by construction, which is the same statement.
*/
func colMirrorToCafeteria(ctx context.Context, tx pgx.Tx, id *httpx.Identity,
	sale, student uuid.UUID, campus *uuid.UUID, total int64, receipt string,
	lines []colPricedLine) error {

	var purchase uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO cafeteria_purchases
		    (institution_id, campus_id, student_id, counter, total_paise, mode,
		     reference_no, recorded_by)
		VALUES ($1,$2,$3,'Canteen counter',$4,'cash',$5,$6)
		RETURNING id`,
		id.InstitutionID, campus, student, total, receipt, id.UserID).
		Scan(&purchase); err != nil {
		return err
	}
	for _, l := range lines {
		cat := l.Category
		// cafeteria_purchase_items knows a narrower vocabulary than the till.
		if !oneOfStr(cat, "meal", "snack", "beverage", "dessert", "fruit", "stationery") {
			cat = "other"
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO cafeteria_purchase_items
			    (institution_id, purchase_id, item_name, category, quantity,
			     unit_paise, line_paise)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			id.InstitutionID, purchase, l.Name, cat, l.Quantity,
			l.UnitPaise, l.Total); err != nil {
			return err
		}
	}
	return nil
}

type posReturnRequest struct {
	SessionID string               `json:"session_id"`
	Reason    string               `json:"reason"`
	Lines     []posSaleLineRequest `json:"lines"`
}

/*
returnPosSale takes something back, and undoes the accounting cleanly.

	A return is a sale of kind 'return' against the same tables. It draws its
	own receipt number -- a refund handed over without a document is the one an
	auditor asks about -- moves the stock back with kind='return', and comes
	out of the drawer it went into, so the cash-up sees it.

	Two things it refuses:

	  more than was sold. Quantities are checked against the original line
	  minus everything already returned, computed from the rows rather than
	  from a counter, so returning the same shirt twice is impossible.

	  a refund on an invoice that has been paid. Where the original was charged
	  to the fee account, the reversal reduces that invoice; if the family has
	  already settled it, reducing it would leave a credit balance on an
	  invoice, which the fee module has no concept of. The clerk is told to
	  refund in cash, which is what actually happens at a counter.

	An exchange is a return followed by a sale on the same session. There is
	deliberately no exchange endpoint: it would be these two operations with a
	shared id, and a partial exchange -- the return written, the replacement
	not -- is the failure mode a school notices weeks later as missing stock.
*/
func (s *Server) returnPosSale(w http.ResponseWriter, r *http.Request) {
	orig, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req posReturnRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	out := map[string]any{}
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		session, err := uuid.Parse(strings.TrimSpace(req.SessionID))
		if err != nil {
			return refusal("a refund comes out of an open till -- which one?")
		}
		var sessStatus string
		var campus *uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT status, campus_id FROM pos_till_sessions WHERE id = $1 FOR UPDATE`,
			session).Scan(&sessStatus, &campus); err != nil {
			return err
		}
		if sessStatus != "open" {
			return refusal("that till is cashed up -- open a session before refunding")
		}

		var kind, channel, mode string
		var student *uuid.UUID
		var buyer *string
		var invoice *uuid.UUID
		var soldOn time.Time
		var window *int
		if err := tx.QueryRow(r.Context(), `
			SELECT s.kind, s.channel, s.payment_mode, s.student_id, s.buyer_name,
			       s.invoice_id, s.sold_on
			  FROM pos_sales s WHERE s.id = $1 FOR UPDATE`, orig).
			Scan(&kind, &channel, &mode, &student, &buyer, &invoice, &soldOn); err != nil {
			return err
		}
		if kind != "sale" {
			return refusal("that is already a refund -- it cannot be refunded again")
		}
		_ = window

		originals, err := colSaleLines(r.Context(), tx, orig)
		if err != nil {
			return err
		}
		byID := make(map[string]posSaleLineView, len(originals))
		for _, l := range originals {
			byID[l.ID] = l
		}

		if len(req.Lines) == 0 {
			return refusal("what is coming back?")
		}
		lines := make([]colPricedLine, 0, len(req.Lines))
		var subtotal, discount, tax, total int64
		for i, l := range req.Lines {
			ol, found := byID[strings.TrimSpace(l.OriginalLineID)]
			if !found {
				return refusef("line %d is not on that receipt", i+1)
			}
			qty := ol.Quantity - ol.ReturnedQty
			if l.Quantity != nil {
				qty = *l.Quantity
			}
			if qty <= 0 {
				return refusef("%s has nothing left to return", ol.ItemName)
			}
			if qty > ol.Quantity-ol.ReturnedQty {
				return refusef("only %d of %s can still come back -- %d were sold and %d already returned",
					ol.Quantity-ol.ReturnedQty, ol.ItemName, ol.Quantity, ol.ReturnedQty)
			}
			// Refunded at the price it went out at, apportioned by quantity so
			// a partial return of a discounted line refunds its share of the
			// discount rather than the shelf price.
			share := (ol.LinePaise*int64(qty) + int64(ol.Quantity)/2) / int64(ol.Quantity)
			taxShare := (ol.TaxPaise*int64(qty) + int64(ol.Quantity)/2) / int64(ol.Quantity)
			var vid *uuid.UUID
			if ol.VariantID != nil {
				u, err := uuid.Parse(*ol.VariantID)
				if err != nil {
					return err
				}
				vid = &u
			}
			lines = append(lines, colPricedLine{
				VariantID: vid, Name: ol.ItemName, Category: ol.Category,
				Label: ol.VariantLabel, Quantity: qty,
				UnitPaise: ol.UnitPaise, Tax: taxShare, Total: share,
			})
			subtotal += ol.UnitPaise * int64(qty)
			tax += taxShare
			total += share
		}
		discount = subtotal + tax - total
		if discount < 0 {
			// Can only happen if a line's stored total exceeded its own gross,
			// which the sale-side constraints forbid. Refuse rather than write
			// a row the CHECK would reject with a less useful message.
			return refusal("that receipt's lines do not add up -- it cannot be reversed automatically")
		}
		if total <= 0 {
			return refusal("a refund of nothing is not a refund")
		}

		if mode == "account" && invoice != nil {
			var gross, disc, fine, paid int64
			var invStatus string
			if err := tx.QueryRow(r.Context(), `
				SELECT gross_paise, discount_paise, fine_paise, paid_paise, status
				  FROM invoices WHERE id = $1 FOR UPDATE`, *invoice).
				Scan(&gross, &disc, &fine, &paid, &invStatus); err != nil {
				return err
			}
			if gross-total-disc+fine < paid {
				return refusef(
					"that charge has already been paid -- refund the %s in cash rather than reversing the invoice",
					indianRupees(total))
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE invoices SET gross_paise = gross_paise - $2, updated_at = now()
				 WHERE id = $1`, *invoice, total); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE invoice_lines SET amount_paise = amount_paise - $2
				 WHERE invoice_id = $1`, *invoice, total); err != nil {
				return err
			}
		}

		if err := colEnsurePosSeries(r.Context(), tx, id.InstitutionID); err != nil {
			return err
		}
		on := nowInIndia()
		number, err := fees.NextNumberOn(r.Context(), tx, id.InstitutionID, "pos", on)
		if err != nil {
			return err
		}

		reason := strings.TrimSpace(req.Reason)
		if reason == "" {
			return refusal("why is it coming back? a refund without a reason is one nobody can defend")
		}

		var retID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO pos_sales
			    (institution_id, campus_id, session_id, kind, channel,
			     original_sale_id, student_id, buyer_name, sold_on, payment_mode,
			     subtotal_paise, discount_paise, tax_paise, total_paise,
			     receipt_no, receipt_seq, receipt_fy, invoice_id, remarks, sold_by)
			VALUES ($1,$2,$3,'return',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
			        $14,$15,NULLIF($16,''),$17,$18,$19)
			RETURNING id`,
			id.InstitutionID, campus, session, channel, orig, student, buyer,
			on, mode, subtotal, discount, tax, total, number.Text, number.Seq,
			number.FY, invoice, reason, id.UserID).Scan(&retID); err != nil {
			return err
		}
		if err := colWriteLines(r.Context(), tx, id.InstitutionID, retID, lines); err != nil {
			return err
		}
		out["id"] = retID.String()
		out["receipt_no"] = number.Text
		out["refund_paise"] = total
		out["refund_mode"] = mode
		return nil
	}, out)
}

// ===========================================================================
// Grant-in-aid
// ===========================================================================

type grantHeadView struct {
	ID          string  `json:"id"`
	Code        string  `json:"code"`
	Name        string  `json:"name"`
	Category    string  `json:"category"`
	AccountID   *string `json:"expense_account_id,omitempty"`
	AccountName *string `json:"expense_account_name,omitempty"`
	IsPostBased bool    `json:"is_post_based"`
	IsActive    bool    `json:"is_active"`
	Notes       *string `json:"notes,omitempty"`
}

type grantHeadRequest struct {
	ID          string `json:"id"`
	Code        string `json:"code"`
	Name        string `json:"name"`
	Category    string `json:"category"`
	AccountID   string `json:"expense_account_id"`
	IsPostBased *bool  `json:"is_post_based"`
	IsActive    *bool  `json:"is_active"`
	Notes       string `json:"notes"`
}

func (s *Server) listGrantHeads(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT h.id::text, h.code, h.name, h.category,
		       h.expense_account_id::text, a.name, h.is_post_based, h.is_active,
		       h.notes
		  FROM grant_in_aid_heads h
		  LEFT JOIN ledger_accounts a ON a.id = h.expense_account_id
		 WHERE ($1::bool IS NULL OR h.is_active = $1)
		 ORDER BY h.is_active DESC, h.category, h.name`,
		[]any{nullBool(r.URL.Query().Get("active"))},
		func(rows pgx.Rows) (grantHeadView, error) {
			var v grantHeadView
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Category, &v.AccountID,
				&v.AccountName, &v.IsPostBased, &v.IsActive, &v.Notes)
		})
	respond(w, r, items, err)
}

func (s *Server) saveGrantHead(w http.ResponseWriter, r *http.Request) {
	var req grantHeadRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var out string
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		req.Code = strings.TrimSpace(req.Code)
		req.Name = strings.TrimSpace(req.Name)
		req.Category = strings.TrimSpace(req.Category)
		if req.Category == "" {
			req.Category = "non_salary"
		}
		switch {
		case req.Code == "":
			return refusal("give the head the code the sanction order uses")
		case req.Name == "":
			return refusal("what is the head called?")
		case !oneOfStr(req.Category, "salary", "non_salary", "maintenance",
			"contingency", "infrastructure", "other"):
			return refusal("category must be salary, non_salary, maintenance, contingency, infrastructure or other")
		}
		account, err := optionalUUID(req.AccountID)
		if err != nil {
			return refusal("that expenditure account is not a valid id")
		}
		postBased := req.Category == "salary"
		if req.IsPostBased != nil {
			postBased = *req.IsPostBased
		}
		active := true
		if req.IsActive != nil {
			active = *req.IsActive
		}
		if hid := strings.TrimSpace(req.ID); hid != "" {
			u, err := uuid.Parse(hid)
			if err != nil {
				return refusal("malformed head id")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE grant_in_aid_heads
				   SET code=$3, name=$4, category=$5, expense_account_id=$6,
				       is_post_based=$7, is_active=$8, notes=$9, updated_at=now()
				 WHERE id=$1 AND institution_id=$2
				 RETURNING id::text`,
				u, id.InstitutionID, req.Code, req.Name, req.Category, account,
				postBased, active, nullString(req.Notes)).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO grant_in_aid_heads
			    (institution_id, code, name, category, expense_account_id,
			     is_post_based, is_active, notes)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			RETURNING id::text`,
			id.InstitutionID, req.Code, req.Name, req.Category, account,
			postBased, active, nullString(req.Notes)).Scan(&out)
	}, map[string]any{"id": &out})
}

type grantSanctionView struct {
	ID          string  `json:"id"`
	HeadID      string  `json:"head_id"`
	HeadName    string  `json:"head_name"`
	HeadCode    string  `json:"head_code"`
	Category    string  `json:"category"`
	FYStartYear int     `json:"fy_start_year"`
	FYLabel     string  `json:"fy_label"`
	SanctionNo  string  `json:"sanction_no"`
	SanctionDay string  `json:"sanction_date"`
	Authority   *string `json:"authority,omitempty"`
	SchemeName  *string `json:"scheme_name,omitempty"`

	SanctionedPaise int64 `json:"sanctioned_paise"`
	SanctionedPosts *int  `json:"sanctioned_posts,omitempty"`
	OpeningUnspent  int64 `json:"opening_unspent_paise"`
	ReceivedPaise   int64 `json:"received_paise"`
	UtilisedPaise   int64 `json:"utilised_paise"`

	// Derived, and named for the questions they answer.
	AvailablePaise  int64   `json:"available_paise"`
	UnspentPaise    int64   `json:"unspent_paise"`
	AwaitedPaise    int64   `json:"awaited_paise"`
	UtilisationPct  int     `json:"utilisation_pct"`
	Status          string  `json:"status"`
	ReceiptCount    int     `json:"receipt_count"`
	ExpenditureRows int     `json:"expenditure_count"`
	Notes           *string `json:"notes,omitempty"`
}

/*
grantSanctionSQL is the utilisation arithmetic, written once.

	received and utilised are summed from their own tables rather than kept as
	columns on the sanction. A denormalised total on a row that three screens
	write to is a total that eventually disagrees with the rows it came from,
	and this is the figure a government auditor recomputes by hand.
*/
const grantSanctionSQL = `
	SELECT s.id::text, s.head_id::text, h.name, h.code, h.category,
	       s.fy_start_year, s.sanction_no, to_char(s.sanction_date,'YYYY-MM-DD'),
	       s.authority, s.scheme_name,
	       s.sanctioned_paise, s.sanctioned_posts, s.opening_unspent_paise,
	       COALESCE(rc.total, 0), COALESCE(ex.total, 0),
	       s.status, COALESCE(rc.n, 0)::int, COALESCE(ex.n, 0)::int, s.notes
	  FROM grant_sanctions s
	  JOIN grant_in_aid_heads h ON h.id = s.head_id
	  LEFT JOIN LATERAL (
	      SELECT sum(amount_paise) AS total, count(*) AS n
	        FROM grant_receipts g WHERE g.sanction_id = s.id
	  ) rc ON true
	  LEFT JOIN LATERAL (
	      SELECT sum(amount_paise) AS total, count(*) AS n
	        FROM grant_expenditures g WHERE g.sanction_id = s.id
	  ) ex ON true`

func scanGrantSanction(rows pgx.Rows) (grantSanctionView, error) {
	var v grantSanctionView
	if err := rows.Scan(&v.ID, &v.HeadID, &v.HeadName, &v.HeadCode, &v.Category,
		&v.FYStartYear, &v.SanctionNo, &v.SanctionDay, &v.Authority, &v.SchemeName,
		&v.SanctionedPaise, &v.SanctionedPosts, &v.OpeningUnspent,
		&v.ReceivedPaise, &v.UtilisedPaise, &v.Status, &v.ReceiptCount,
		&v.ExpenditureRows, &v.Notes); err != nil {
		return v, err
	}
	v.FYLabel = fyLabel(v.FYStartYear)
	// Available is what may still be spent under this head: the sanction plus
	// anything carried in, less what has gone. Deliberately not "received less
	// utilised" -- a school routinely spends against a sanction before the
	// tranche lands, and blocking that would stop it paying salaries in April.
	v.AvailablePaise = v.SanctionedPaise + v.OpeningUnspent - v.UtilisedPaise
	// Unspent is the cash question and uses received, because money not
	// received cannot be unspent.
	v.UnspentPaise = v.ReceivedPaise + v.OpeningUnspent - v.UtilisedPaise
	v.AwaitedPaise = v.SanctionedPaise - v.ReceivedPaise
	if v.AwaitedPaise < 0 {
		v.AwaitedPaise = 0
	}
	if base := v.SanctionedPaise + v.OpeningUnspent; base > 0 {
		v.UtilisationPct = int((v.UtilisedPaise*100 + base/2) / base)
	}
	return v, nil
}

func (s *Server) listGrantSanctions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var year *int
	if raw := strings.TrimSpace(q.Get("fy")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1990 || n > 2200 {
			httpx.BadRequest(w, r, "the financial year is its starting year, like 2026")
			return
		}
		year = &n
	}
	head, err := queryUUID(r, "head_id")
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	items, err := collect(s, r, grantSanctionSQL+`
		 WHERE ($1::int IS NULL OR s.fy_start_year = $1)
		   AND ($2::uuid IS NULL OR s.head_id = $2)
		 ORDER BY s.fy_start_year DESC, h.category, h.name`,
		[]any{year, head}, scanGrantSanction)
	respond(w, r, items, err)
}

type grantSanctionRequest struct {
	ID              string `json:"id"`
	HeadID          string `json:"head_id"`
	FYStartYear     *int   `json:"fy_start_year"`
	SanctionNo      string `json:"sanction_no"`
	SanctionDate    string `json:"sanction_date"`
	Authority       string `json:"authority"`
	SchemeName      string `json:"scheme_name"`
	SanctionedPaise *int64 `json:"sanctioned_paise"`
	SanctionedPosts *int   `json:"sanctioned_posts"`
	OpeningUnspent  *int64 `json:"opening_unspent_paise"`
	Status          string `json:"status"`
	Notes           string `json:"notes"`
}

func (s *Server) saveGrantSanction(w http.ResponseWriter, r *http.Request) {
	var req grantSanctionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var out string
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		head, err := uuid.Parse(strings.TrimSpace(req.HeadID))
		if err != nil {
			return refusal("which head was this sanctioned against?")
		}
		req.SanctionNo = strings.TrimSpace(req.SanctionNo)
		if req.SanctionNo == "" {
			return refusal("the sanction order's number is what an inspecting officer asks for -- type it")
		}
		on, err := colDate(req.SanctionDate)
		if err != nil {
			return err
		}
		fy := colFY(on)
		if req.FYStartYear != nil {
			fy = *req.FYStartYear
		}
		if fy < 1990 || fy > 2200 {
			return refusal("the financial year is its starting year, like 2026")
		}
		amount, err := colMoney("the sanctioned amount", req.SanctionedPaise, true)
		if err != nil {
			return err
		}
		opening := int64(0)
		if req.OpeningUnspent != nil {
			if opening, err = colMoney("the opening unspent balance", req.OpeningUnspent, true); err != nil {
				return err
			}
		}
		status := strings.TrimSpace(req.Status)
		if status == "" {
			status = "sanctioned"
		}
		if !oneOfStr(status, "draft", "sanctioned", "closed") {
			return refusal("a sanction is draft, sanctioned or closed")
		}
		if req.SanctionedPosts != nil && *req.SanctionedPosts < 0 {
			return refusal("a sanction cannot be for a negative number of posts")
		}

		if sid := strings.TrimSpace(req.ID); sid != "" {
			u, err := uuid.Parse(sid)
			if err != nil {
				return refusal("malformed sanction id")
			}
			// Reducing a sanction below what has already been booked against
			// it would leave the head over-utilised retrospectively, which is
			// the state the expenditure check exists to prevent.
			var utilised int64
			if err := tx.QueryRow(r.Context(),
				`SELECT COALESCE(sum(amount_paise), 0) FROM grant_expenditures WHERE sanction_id = $1`,
				u).Scan(&utilised); err != nil {
				return err
			}
			if amount+opening < utilised {
				return refusef(
					"%s is already booked against this sanction -- it cannot be reduced to %s",
					indianRupees(utilised), indianRupees(amount+opening))
			}
			return tx.QueryRow(r.Context(), `
				UPDATE grant_sanctions
				   SET head_id=$3, fy_start_year=$4, sanction_no=$5, sanction_date=$6,
				       authority=$7, scheme_name=$8, sanctioned_paise=$9,
				       sanctioned_posts=$10, opening_unspent_paise=$11, status=$12,
				       notes=$13, updated_at=now()
				 WHERE id=$1 AND institution_id=$2
				 RETURNING id::text`,
				u, id.InstitutionID, head, fy, req.SanctionNo, on,
				nullString(req.Authority), nullString(req.SchemeName), amount,
				req.SanctionedPosts, opening, status, nullString(req.Notes)).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO grant_sanctions
			    (institution_id, head_id, fy_start_year, sanction_no, sanction_date,
			     authority, scheme_name, sanctioned_paise, sanctioned_posts,
			     opening_unspent_paise, status, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
			RETURNING id::text`,
			id.InstitutionID, head, fy, req.SanctionNo, on,
			nullString(req.Authority), nullString(req.SchemeName), amount,
			req.SanctionedPosts, opening, status, nullString(req.Notes),
			id.UserID).Scan(&out)
	}, map[string]any{"id": &out})
}

type grantReceiptView struct {
	ID         string  `json:"id"`
	ReceivedOn string  `json:"received_on"`
	Amount     int64   `json:"amount_paise"`
	Mode       string  `json:"mode"`
	Reference  *string `json:"reference_no,omitempty"`
	BankLabel  *string `json:"bank_label,omitempty"`
	VoucherNo  *string `json:"voucher_no,omitempty"`
	Remarks    *string `json:"remarks,omitempty"`
}

type grantExpenditureView struct {
	ID          string  `json:"id"`
	SpentOn     string  `json:"spent_on"`
	Amount      int64   `json:"amount_paise"`
	Particulars string  `json:"particulars"`
	VoucherRef  *string `json:"voucher_ref,omitempty"`
	SourceKind  *string `json:"source_kind,omitempty"`
	VoucherNo   *string `json:"voucher_no,omitempty"`
}

func (s *Server) getGrantSanction(w http.ResponseWriter, r *http.Request) {
	sid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var view grantSanctionView
	receipts := []grantReceiptView{}
	spends := []grantExpenditureView{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), grantSanctionSQL+` WHERE s.id = $1`, sid)
		if err != nil {
			return err
		}
		found := false
		for rows.Next() {
			view, err = scanGrantSanction(rows)
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

		rrows, err := tx.Query(r.Context(), `
			SELECT g.id::text, to_char(g.received_on,'YYYY-MM-DD'), g.amount_paise,
			       g.mode, g.reference_no, b.label, e.voucher_no, g.remarks
			  FROM grant_receipts g
			  LEFT JOIN bank_accounts   b ON b.id = g.bank_account_id
			  LEFT JOIN journal_entries e ON e.id = g.journal_entry_id
			 WHERE g.sanction_id = $1
			 ORDER BY g.received_on, g.created_at`, sid)
		if err != nil {
			return err
		}
		for rrows.Next() {
			var v grantReceiptView
			if err := rrows.Scan(&v.ID, &v.ReceivedOn, &v.Amount, &v.Mode,
				&v.Reference, &v.BankLabel, &v.VoucherNo, &v.Remarks); err != nil {
				rrows.Close()
				return err
			}
			receipts = append(receipts, v)
		}
		rrows.Close()
		if err := rrows.Err(); err != nil {
			return err
		}

		erows, err := tx.Query(r.Context(), `
			SELECT g.id::text, to_char(g.spent_on,'YYYY-MM-DD'), g.amount_paise,
			       g.particulars, g.voucher_ref, g.source_kind, e.voucher_no
			  FROM grant_expenditures g
			  LEFT JOIN journal_entries e ON e.id = g.journal_entry_id
			 WHERE g.sanction_id = $1
			 ORDER BY g.spent_on, g.created_at`, sid)
		if err != nil {
			return err
		}
		defer erows.Close()
		for erows.Next() {
			var v grantExpenditureView
			if err := erows.Scan(&v.ID, &v.SpentOn, &v.Amount, &v.Particulars,
				&v.VoucherRef, &v.SourceKind, &v.VoucherNo); err != nil {
				return err
			}
			spends = append(spends, v)
		}
		return erows.Err()
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"sanction": view, "receipts": receipts, "expenditures": spends,
	})
}

type grantReceiptRequest struct {
	ReceivedOn    string `json:"received_on"`
	AmountPaise   *int64 `json:"amount_paise"`
	Mode          string `json:"mode"`
	ReferenceNo   string `json:"reference_no"`
	BankAccountID string `json:"bank_account_id"`
	Remarks       string `json:"remarks"`
	// Off by default. A school that has not finished its chart of accounts can
	// still record that the money arrived; posting it is the accountant's act.
	PostToLedger bool `json:"post_to_ledger"`
}

/*
recordGrantReceipt books a tranche, and optionally the voucher for it.

	The voucher debits the bank account and credits the grant account: an aided
	grant is not the school's income when it arrives, it is money held for a
	sanctioned purpose, and treating it as income on receipt overstates the
	year's surplus by the whole grant. Which account that is remains the
	school's decision and its auditor's, so it is a setting, and a receipt
	posted with the setting unset is refused by name rather than defaulted.

	source_kind / source_id on the voucher make it idempotent through
	journal_entries_one_per_source: a retried request cannot post the money
	twice.
*/
func (s *Server) recordGrantReceipt(w http.ResponseWriter, r *http.Request) {
	sid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req grantReceiptRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	out := map[string]any{}
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		amount, err := colMoney("the amount received", req.AmountPaise, false)
		if err != nil {
			return err
		}
		on, err := colDate(req.ReceivedOn)
		if err != nil {
			return err
		}
		mode := strings.TrimSpace(req.Mode)
		if mode == "" {
			mode = "bank_transfer"
		}
		if !oneOfStr(mode, "bank_transfer", "cheque", "dd", "adjustment") {
			return refusal("mode must be bank_transfer, cheque, dd or adjustment")
		}
		bank, err := optionalUUID(req.BankAccountID)
		if err != nil {
			return refusal("that bank account is not a valid id")
		}

		var headName, sanctionNo string
		if err := tx.QueryRow(r.Context(), `
			SELECT h.name, s.sanction_no
			  FROM grant_sanctions s
			  JOIN grant_in_aid_heads h ON h.id = s.head_id
			 WHERE s.id = $1 FOR UPDATE OF s`, sid).Scan(&headName, &sanctionNo); err != nil {
			return err
		}

		var receiptID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO grant_receipts
			    (institution_id, sanction_id, received_on, amount_paise, mode,
			     reference_no, bank_account_id, remarks, recorded_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			RETURNING id`,
			id.InstitutionID, sid, on, amount, mode, nullString(req.ReferenceNo),
			bank, nullString(req.Remarks), id.UserID).Scan(&receiptID); err != nil {
			return err
		}

		if req.PostToLedger {
			var bankAcc, grantAcc *uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				SELECT grant_bank_account_id, grant_liability_account_id
				  FROM collections_settings WHERE institution_id = $1`,
				id.InstitutionID).Scan(&bankAcc, &grantAcc); err != nil &&
				!errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if bankAcc == nil {
				return refusal("no bank account is set for grant receipts -- set one in collections settings, or record the receipt without posting")
			}
			if grantAcc == nil {
				return refusal("no grant account is set -- set one in collections settings, or record the receipt without posting")
			}
			_, voucher, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
				"receipt", "GNT", on,
				fmt.Sprintf("Grant-in-aid received: %s, sanction %s", headName, sanctionNo),
				"grant_receipt", &receiptID,
				[]voucherLine{
					{AccountID: *bankAcc, Debit: amount, Memo: sanctionNo},
					{AccountID: *grantAcc, Credit: amount, Memo: headName},
				})
			if err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE grant_receipts SET journal_entry_id = (
				    SELECT id FROM journal_entries
				     WHERE institution_id = $2 AND source_kind = 'grant_receipt'
				       AND source_id = $1)
				 WHERE id = $1`, receiptID, id.InstitutionID); err != nil {
				return err
			}
			out["voucher_no"] = voucher
		}
		out["id"] = receiptID.String()
		out["amount_paise"] = amount
		return nil
	}, out)
}

type grantExpenditureRequest struct {
	SpentOn      string `json:"spent_on"`
	AmountPaise  *int64 `json:"amount_paise"`
	Particulars  string `json:"particulars"`
	VoucherRef   string `json:"voucher_ref"`
	SourceKind   string `json:"source_kind"`
	SourceID     string `json:"source_id"`
	PostToLedger bool   `json:"post_to_ledger"`
}

/*
recordGrantExpenditure books spending against a head, and refuses to overspend
it.

	This is the one rule that decides whether a year's grant accounts are
	accepted: money sanctioned under a head is spent under that head. Booking
	past what the head has available is a diversion, and there is deliberately
	no override flag -- an override would be used, and would be used at exactly
	the moment somebody wanted the number to come out right.

	The check is against sanctioned plus anything carried forward, less what is
	already booked, and it is done under a row lock on the sanction so two
	clerks cannot each be told there is room for the last fifty thousand.

	Available deliberately does not subtract un-received tranches. A school
	pays April salaries against a sanction whose first instalment lands in
	June; refusing that would stop it running.
*/
func (s *Server) recordGrantExpenditure(w http.ResponseWriter, r *http.Request) {
	sid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req grantExpenditureRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	out := map[string]any{}
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		amount, err := colMoney("the amount spent", req.AmountPaise, false)
		if err != nil {
			return err
		}
		on, err := colDate(req.SpentOn)
		if err != nil {
			return err
		}
		particulars := strings.TrimSpace(req.Particulars)
		if particulars == "" {
			return refusal("what was the money spent on? a blank entry is one nobody can certify")
		}
		sourceKind := strings.TrimSpace(req.SourceKind)
		sourceID, err := optionalUUID(req.SourceID)
		if err != nil {
			return refusal("that source reference is not a valid id")
		}
		if (sourceKind == "") != (sourceID == nil) {
			return refusal("a source reference needs both what it is and which one -- half of it looks like a link")
		}
		if sourceKind != "" && !oneOfStr(sourceKind, "vendor_bill", "payroll_run",
			"petty_cash_voucher", "manual") {
			return refusal("a source is a vendor_bill, payroll_run, petty_cash_voucher or manual")
		}

		var sanctioned, opening int64
		var status, headName, sanctionNo string
		var expenseAcc *uuid.UUID
		var fy int
		if err := tx.QueryRow(r.Context(), `
			SELECT s.sanctioned_paise, s.opening_unspent_paise, s.status,
			       h.name, s.sanction_no, h.expense_account_id, s.fy_start_year
			  FROM grant_sanctions s
			  JOIN grant_in_aid_heads h ON h.id = s.head_id
			 WHERE s.id = $1 FOR UPDATE OF s`, sid).
			Scan(&sanctioned, &opening, &status, &headName, &sanctionNo,
				&expenseAcc, &fy); err != nil {
			return err
		}
		if status == "draft" {
			return refusal("that sanction is still a draft -- nothing can be spent against it yet")
		}
		if status == "closed" {
			return refusef("the %s sanction for %s is closed", sanctionNo, headName)
		}
		if colFY(on) != fy {
			return refusef(
				"that sanction is for %s and the expenditure is dated %s -- book it against the right year's sanction",
				fyLabel(fy), on.Format("2 January 2006"))
		}

		var booked int64
		if err := tx.QueryRow(r.Context(),
			`SELECT COALESCE(sum(amount_paise), 0) FROM grant_expenditures WHERE sanction_id = $1`,
			sid).Scan(&booked); err != nil {
			return err
		}
		available := sanctioned + opening - booked
		if amount > available {
			return refusef(
				"%s has %s left under it -- spending outside the sanctioned head is what an audit disallows",
				headName, indianRupees(available))
		}

		var spendID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO grant_expenditures
			    (institution_id, sanction_id, spent_on, amount_paise, particulars,
			     voucher_ref, source_kind, source_id, recorded_by)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,$9)
			RETURNING id`,
			id.InstitutionID, sid, on, amount, particulars,
			nullString(req.VoucherRef), sourceKind, sourceID, id.UserID).
			Scan(&spendID); err != nil {
			return err
		}

		if req.PostToLedger {
			if expenseAcc == nil {
				return refusef("no expenditure account is set on %s -- set one on the head, or record the spend without posting", headName)
			}
			var grantAcc *uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				SELECT grant_liability_account_id FROM collections_settings
				 WHERE institution_id = $1`, id.InstitutionID).Scan(&grantAcc); err != nil &&
				!errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if grantAcc == nil {
				return refusal("no grant account is set -- set one in collections settings, or record the spend without posting")
			}
			// Debit the expenditure head, credit the grant held: utilisation is
			// what releases the money the school was holding.
			_, voucher, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
				"journal", "GNU", on,
				fmt.Sprintf("Grant utilisation: %s, %s", headName, particulars),
				"grant_expenditure", &spendID,
				[]voucherLine{
					{AccountID: *expenseAcc, Debit: amount, Memo: sanctionNo},
					{AccountID: *grantAcc, Credit: amount, Memo: headName},
				})
			if err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE grant_expenditures SET journal_entry_id = (
				    SELECT id FROM journal_entries
				     WHERE institution_id = $2 AND source_kind = 'grant_expenditure'
				       AND source_id = $1)
				 WHERE id = $1`, spendID, id.InstitutionID); err != nil {
				return err
			}
			out["voucher_no"] = voucher
		}
		out["id"] = spendID.String()
		out["remaining_paise"] = available - amount
		return nil
	}, out)
}

// --- utilisation certificates ------------------------------------------------

type grantCertificateView struct {
	ID             string  `json:"id"`
	CertificateNo  string  `json:"certificate_no"`
	FYStartYear    int     `json:"fy_start_year"`
	FYLabel        string  `json:"fy_label"`
	PeriodFrom     string  `json:"period_from"`
	PeriodTo       string  `json:"period_to"`
	Status         string  `json:"status"`
	IssuedOn       *string `json:"issued_on,omitempty"`
	FiledOn        *string `json:"filed_on,omitempty"`
	FiledReference *string `json:"filed_reference,omitempty"`
	OpeningUnspent int64   `json:"opening_unspent_paise"`
	Sanctioned     int64   `json:"sanctioned_paise"`
	Received       int64   `json:"received_paise"`
	Utilised       int64   `json:"utilised_paise"`
	Unspent        int64   `json:"unspent_paise"`
	Disposition    string  `json:"unspent_disposition"`
	RefundedOn     *string `json:"refunded_on,omitempty"`
	RefundRef      *string `json:"refund_reference,omitempty"`
	CertifiedBy    *string `json:"certified_by,omitempty"`
	Remarks        *string `json:"remarks,omitempty"`
	PreparedBy     *string `json:"prepared_by,omitempty"`
	LineCount      int     `json:"line_count"`
}

type grantCertificateLineView struct {
	SanctionID     string `json:"sanction_id"`
	HeadName       string `json:"head_name"`
	SanctionNo     string `json:"sanction_no"`
	OpeningUnspent int64  `json:"opening_unspent_paise"`
	Sanctioned     int64  `json:"sanctioned_paise"`
	Received       int64  `json:"received_paise"`
	Utilised       int64  `json:"utilised_paise"`
	Unspent        int64  `json:"unspent_paise"`
}

const grantCertificateSQL = `
	SELECT c.id::text, c.certificate_no, c.fy_start_year,
	       to_char(c.period_from,'YYYY-MM-DD'), to_char(c.period_to,'YYYY-MM-DD'),
	       c.status, to_char(c.issued_on,'YYYY-MM-DD'),
	       to_char(c.filed_on,'YYYY-MM-DD'), c.filed_reference,
	       c.opening_unspent_paise, c.sanctioned_paise, c.received_paise,
	       c.utilised_paise, c.unspent_paise, c.unspent_disposition,
	       to_char(c.refunded_on,'YYYY-MM-DD'), c.refund_reference,
	       c.certified_by, c.remarks, u.full_name,
	       COALESCE(l.n, 0)::int
	  FROM grant_utilisation_certificates c
	  LEFT JOIN users u ON u.id = c.prepared_by
	  LEFT JOIN LATERAL (
	      SELECT count(*) AS n FROM grant_utilisation_certificate_lines gl
	       WHERE gl.certificate_id = c.id
	  ) l ON true`

func scanGrantCertificate(rows pgx.Rows) (grantCertificateView, error) {
	var v grantCertificateView
	if err := rows.Scan(&v.ID, &v.CertificateNo, &v.FYStartYear, &v.PeriodFrom,
		&v.PeriodTo, &v.Status, &v.IssuedOn, &v.FiledOn, &v.FiledReference,
		&v.OpeningUnspent, &v.Sanctioned, &v.Received, &v.Utilised, &v.Unspent,
		&v.Disposition, &v.RefundedOn, &v.RefundRef, &v.CertifiedBy, &v.Remarks,
		&v.PreparedBy, &v.LineCount); err != nil {
		return v, err
	}
	v.FYLabel = fyLabel(v.FYStartYear)
	return v, nil
}

func (s *Server) listGrantCertificates(w http.ResponseWriter, r *http.Request) {
	var year *int
	if raw := strings.TrimSpace(r.URL.Query().Get("fy")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			httpx.BadRequest(w, r, "the financial year is its starting year, like 2026")
			return
		}
		year = &n
	}
	items, err := collect(s, r, grantCertificateSQL+`
		 WHERE ($1::int IS NULL OR c.fy_start_year = $1)
		 ORDER BY c.fy_start_year DESC, c.created_at DESC`,
		[]any{year}, scanGrantCertificate)
	respond(w, r, items, err)
}

type grantCertificateRequest struct {
	CertificateNo string `json:"certificate_no"`
	FYStartYear   *int   `json:"fy_start_year"`
	PeriodFrom    string `json:"period_from"`
	PeriodTo      string `json:"period_to"`
	Remarks       string `json:"remarks"`
}

func (s *Server) saveGrantCertificate(w http.ResponseWriter, r *http.Request) {
	var req grantCertificateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var out string
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		no := strings.TrimSpace(req.CertificateNo)
		if no == "" {
			return refusal("give the certificate the number it will be filed under")
		}
		if req.FYStartYear == nil {
			return refusal("which financial year does this certify?")
		}
		fy := *req.FYStartYear
		if fy < 1990 || fy > 2200 {
			return refusal("the financial year is its starting year, like 2026")
		}
		// The year's own bounds unless the school is certifying part of it,
		// which happens where a scheme runs to a different calendar.
		from := time.Date(fy, time.April, 1, 0, 0, 0, 0, time.UTC)
		to := time.Date(fy+1, time.March, 31, 0, 0, 0, 0, time.UTC)
		var err error
		if strings.TrimSpace(req.PeriodFrom) != "" {
			if from, err = colDate(req.PeriodFrom); err != nil {
				return err
			}
		}
		if strings.TrimSpace(req.PeriodTo) != "" {
			if to, err = colDate(req.PeriodTo); err != nil {
				return err
			}
		}
		if to.Before(from) {
			return refusal("the certificate's period ends before it begins")
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO grant_utilisation_certificates
			    (institution_id, certificate_no, fy_start_year, period_from,
			     period_to, remarks, prepared_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id::text`,
			id.InstitutionID, no, fy, from, to, nullString(req.Remarks),
			id.UserID).Scan(&out)
	}, map[string]any{"id": &out})
}

/*
getGrantCertificate shows the certificate, live for a draft and frozen once
issued.

	A draft recomputes from the sanctions every time it is opened, because that
	is what a draft is for -- the accountant is watching the figures settle. An
	issued certificate reads its own snapshot lines and nothing else. The two
	must not be the same query, or an expense entered in May would silently
	rewrite a certificate filed in April.
*/
func (s *Server) getGrantCertificate(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var view grantCertificateView
	lines := []grantCertificateLineView{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), grantCertificateSQL+` WHERE c.id = $1`, cid)
		if err != nil {
			return err
		}
		found := false
		for rows.Next() {
			view, err = scanGrantCertificate(rows)
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

		if view.Status == "draft" {
			lines, err = colDraftCertificateLines(r.Context(), tx, view.FYStartYear)
			if err != nil {
				return err
			}
			view.OpeningUnspent, view.Sanctioned, view.Received, view.Utilised = 0, 0, 0, 0
			for _, l := range lines {
				view.OpeningUnspent += l.OpeningUnspent
				view.Sanctioned += l.Sanctioned
				view.Received += l.Received
				view.Utilised += l.Utilised
			}
			view.Unspent = view.Received + view.OpeningUnspent - view.Utilised
			return nil
		}

		lrows, err := tx.Query(r.Context(), `
			SELECT sanction_id::text, head_name, sanction_no,
			       opening_unspent_paise, sanctioned_paise, received_paise,
			       utilised_paise, unspent_paise
			  FROM grant_utilisation_certificate_lines
			 WHERE certificate_id = $1
			 ORDER BY head_name`, cid)
		if err != nil {
			return err
		}
		defer lrows.Close()
		for lrows.Next() {
			var l grantCertificateLineView
			if err := lrows.Scan(&l.SanctionID, &l.HeadName, &l.SanctionNo,
				&l.OpeningUnspent, &l.Sanctioned, &l.Received, &l.Utilised,
				&l.Unspent); err != nil {
				return err
			}
			lines = append(lines, l)
		}
		return lrows.Err()
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"certificate": view, "lines": lines})
}

// colDraftCertificateLines is the live utilisation for a year, one row per
// sanction. It is also the utilisation report; both callers want the same
// arithmetic and there is one of it.
func colDraftCertificateLines(ctx context.Context, tx pgx.Tx, fy int) ([]grantCertificateLineView, error) {
	rows, err := tx.Query(ctx, `
		SELECT s.id::text, h.name, s.sanction_no, s.opening_unspent_paise,
		       s.sanctioned_paise,
		       COALESCE((SELECT sum(amount_paise) FROM grant_receipts g
		                  WHERE g.sanction_id = s.id), 0),
		       COALESCE((SELECT sum(amount_paise) FROM grant_expenditures g
		                  WHERE g.sanction_id = s.id), 0)
		  FROM grant_sanctions s
		  JOIN grant_in_aid_heads h ON h.id = s.head_id
		 WHERE s.fy_start_year = $1 AND s.status <> 'draft'
		 ORDER BY h.category, h.name`, fy)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []grantCertificateLineView{}
	for rows.Next() {
		var l grantCertificateLineView
		if err := rows.Scan(&l.SanctionID, &l.HeadName, &l.SanctionNo,
			&l.OpeningUnspent, &l.Sanctioned, &l.Received, &l.Utilised); err != nil {
			return nil, err
		}
		l.Unspent = l.Received + l.OpeningUnspent - l.Utilised
		out = append(out, l)
	}
	return out, rows.Err()
}

// getGrantUtilisation is the year at a glance: every head, what it was given
// and what it has spent. The screen a principal opens in February when the
// department asks how much is still unspent.
func (s *Server) getGrantUtilisation(w http.ResponseWriter, r *http.Request) {
	fy := colFY(nowInIndia())
	if raw := strings.TrimSpace(r.URL.Query().Get("fy")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1990 || n > 2200 {
			httpx.BadRequest(w, r, "the financial year is its starting year, like 2026")
			return
		}
		fy = n
	}
	id := httpx.IdentityFrom(r.Context())
	var lines []grantCertificateLineView
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var e error
		lines, e = colDraftCertificateLines(r.Context(), tx, fy)
		return e
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	var opening, sanctioned, received, utilised int64
	for _, l := range lines {
		opening += l.OpeningUnspent
		sanctioned += l.Sanctioned
		received += l.Received
		utilised += l.Utilised
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":                 lines,
		"fy_start_year":         fy,
		"fy_label":              fyLabel(fy),
		"opening_unspent_paise": opening,
		"sanctioned_paise":      sanctioned,
		"received_paise":        received,
		"utilised_paise":        utilised,
		"unspent_paise":         received + opening - utilised,
		"awaited_paise":         maxInt64(sanctioned-received, 0),
	})
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

type grantIssueCertRequest struct {
	CertifiedBy string `json:"certified_by"`
	IssuedOn    string `json:"issued_on"`
}

/*
issueGrantCertificate freezes the figures and signs the document.

	Snapshotting is the whole operation. Every line is written as it stands at
	this moment, the totals are written on the header, and nothing afterwards
	recomputes them. A utilisation certificate is a statement a named person
	made on a date; a screen that quietly restated it as later vouchers were
	entered would be showing the department a document the school never signed.

	Irreversible on purpose, and behind the refunds permission rather than the
	ordinary write one for the same reason a claim's submission is in
	concessions.go: the two acts a school is audited on are the assertions, not
	the data entry.
*/
func (s *Server) issueGrantCertificate(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req grantIssueCertRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	out := map[string]any{}
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		by := strings.TrimSpace(req.CertifiedBy)
		if by == "" {
			return refusal("who is certifying this? the department will not accept an unsigned certificate")
		}
		on, err := colDate(req.IssuedOn)
		if err != nil {
			return err
		}

		var status string
		var fy int
		if err := tx.QueryRow(r.Context(),
			`SELECT status, fy_start_year FROM grant_utilisation_certificates
			  WHERE id = $1 FOR UPDATE`, cid).Scan(&status, &fy); err != nil {
			return err
		}
		if status != "draft" {
			return refusal("that certificate has already been issued -- raise a revised one rather than editing a signed document")
		}

		lines, err := colDraftCertificateLines(r.Context(), tx, fy)
		if err != nil {
			return err
		}
		if len(lines) == 0 {
			return refusef("no sanctions are recorded for %s -- there is nothing to certify", fyLabel(fy))
		}

		var opening, sanctioned, received, utilised int64
		for _, l := range lines {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO grant_utilisation_certificate_lines
				    (institution_id, certificate_id, sanction_id, head_name,
				     sanction_no, opening_unspent_paise, sanctioned_paise,
				     received_paise, utilised_paise, unspent_paise)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
				id.InstitutionID, cid, l.SanctionID, l.HeadName, l.SanctionNo,
				l.OpeningUnspent, l.Sanctioned, l.Received, l.Utilised,
				l.Unspent); err != nil {
				return err
			}
			opening += l.OpeningUnspent
			sanctioned += l.Sanctioned
			received += l.Received
			utilised += l.Utilised
		}
		unspent := received + opening - utilised
		disposition := "pending"
		if unspent <= 0 {
			// Nothing left is not a decision anyone has to take.
			disposition = "none"
		}
		if unspent < 0 {
			unspent = 0
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE grant_utilisation_certificates
			   SET status = 'issued', issued_on = $2, certified_by = $3,
			       opening_unspent_paise = $4, sanctioned_paise = $5,
			       received_paise = $6, utilised_paise = $7, unspent_paise = $8,
			       unspent_disposition = $9, updated_at = now()
			 WHERE id = $1`,
			cid, on, by, opening, sanctioned, received, utilised, unspent,
			disposition); err != nil {
			return err
		}
		out["status"] = "issued"
		out["unspent_paise"] = unspent
		out["utilised_paise"] = utilised
		out["line_count"] = len(lines)
		return nil
	}, out)
}

type disposeUnspentRequest struct {
	Disposition string `json:"disposition"`
	RefundedOn  string `json:"refunded_on"`
	Reference   string `json:"refund_reference"`
	// Where the balance is carried, the sanction it is carried into.
	CarryToSanctionID string `json:"carry_to_sanction_id"`
	FiledOn           string `json:"filed_on"`
	FiledReference    string `json:"filed_reference"`
}

/*
disposeGrantUnspent records what happened to the balance.

	Carrying forward is not a note; it is an amount landing on next year's
	sanction as its opening balance, which is why the sanction has that column
	and why this endpoint writes it. Doing it as a remark would mean next
	year's utilisation quietly understates what the head had available, and the
	discrepancy surfaces as an unexplained excess two years later.

	Refunding is a date and a reference. "We will send it back" is not a
	disposition, and the constraint on the table says so too.
*/
func (s *Server) disposeGrantUnspent(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req disposeUnspentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	out := map[string]any{}
	s.colTx(w, r, func(tx pgx.Tx, id *httpx.Identity) error {
		disposition := strings.TrimSpace(req.Disposition)
		if !oneOfStr(disposition, "carried_forward", "refunded", "none") {
			return refusal("the balance is carried_forward, refunded, or none")
		}

		var status string
		var unspent int64
		if err := tx.QueryRow(r.Context(),
			`SELECT status, unspent_paise FROM grant_utilisation_certificates
			  WHERE id = $1 FOR UPDATE`, cid).Scan(&status, &unspent); err != nil {
			return err
		}
		if status == "draft" {
			return refusal("issue the certificate before disposing of its balance -- the figure is not final until it is signed")
		}
		if unspent <= 0 && disposition != "none" {
			return refusal("there is no unspent balance to dispose of")
		}

		var refundedOn *time.Time
		var filedOn *time.Time
		switch disposition {
		case "refunded":
			d, err := colDate(req.RefundedOn)
			if err != nil {
				return err
			}
			if strings.TrimSpace(req.Reference) == "" {
				return refusal("a refund needs its challan or transaction reference")
			}
			refundedOn = &d
		case "carried_forward":
			target, err := uuid.Parse(strings.TrimSpace(req.CarryToSanctionID))
			if err != nil {
				return refusal("which sanction is the balance carried into? it has to land somewhere or next year's head is understated")
			}
			var already int64
			if err := tx.QueryRow(r.Context(),
				`SELECT opening_unspent_paise FROM grant_sanctions
				  WHERE id = $1 FOR UPDATE`, target).Scan(&already); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE grant_sanctions
				   SET opening_unspent_paise = $2, updated_at = now()
				 WHERE id = $1`, target, already+unspent); err != nil {
				return err
			}
			out["carried_to_opening_paise"] = already + unspent
		}

		newStatus := status
		if strings.TrimSpace(req.FiledOn) != "" || strings.TrimSpace(req.FiledReference) != "" {
			d, err := colDate(req.FiledOn)
			if err != nil {
				return err
			}
			filedOn = &d
			newStatus = "filed"
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE grant_utilisation_certificates
			   SET unspent_disposition = $2, refunded_on = $3,
			       refund_reference = NULLIF($4,''), status = $5,
			       filed_on = COALESCE($6, filed_on),
			       filed_reference = COALESCE(NULLIF($7,''), filed_reference),
			       updated_at = now()
			 WHERE id = $1`,
			cid, disposition, refundedOn, strings.TrimSpace(req.Reference),
			newStatus, filedOn, strings.TrimSpace(req.FiledReference)); err != nil {
			return err
		}
		out["unspent_disposition"] = disposition
		out["status"] = newStatus
		return nil
	}, out)
}

// --- routes ------------------------------------------------------------------

/*
mountCollections registers the three features' endpoints.

	Spliced into api.go's /finance route, which already carries
	RequirePermission(rbac.InvoicesRead), beside s.mountConcessions(r).

	Permissions reuse what exists and invent nothing:

	  FeesRead       everything readable. The catalogue, the till, the
	                 sanctions register.
	  FeesWrite      maintaining the things sales and grants refer to:
	                 counters, products, variants, heads, sanctions, settings.
	  PaymentsWrite  taking money. Opening a till, ringing up a sale, cashing
	                 up. The same rung the fee counter collects on, because it
	                 is the same act.
	  RefundsWrite   giving money back, and the two grant assertions the school
	                 is audited on: signing a utilisation certificate and
	                 dispositioning the unspent balance. Deliberately not
	                 FeesWrite -- the clerk who types the expenditure is not
	                 the person who should be able to certify it.

	The read routes are not merely a hidden button on the client: every one of
	them is behind RequirePermission on the server, and a caller without the
	permission gets 403 before any handler runs.
*/
func (s *Server) mountCollections(r chi.Router) {
	read := httpx.RequirePermission(rbac.FeesRead)
	write := httpx.RequirePermission(rbac.FeesWrite)
	till := httpx.RequirePermission(rbac.PaymentsWrite)
	refund := httpx.RequirePermission(rbac.RefundsWrite)

	// --- settings ----------------------------------------------------------
	r.With(read).Get("/collections/settings", s.getCollectionsSettings)
	r.With(write).Post("/collections/settings", s.saveCollectionsSettings)

	// --- counters and tills ------------------------------------------------
	r.With(read).Get("/collections/terminals", s.listPosTerminals)
	r.With(write).Post("/collections/terminals", s.savePosTerminal)

	r.With(read).Get("/collections/sessions", s.listTillSessions)
	// The variance report. Registered before /{id} so "variance" is not parsed
	// as a session id.
	r.With(read).Get("/collections/sessions/variance", s.getTillVariance)
	r.With(till).Post("/collections/sessions", s.openTillSession)
	r.With(read).Get("/collections/sessions/{id}", s.getTillSession)
	r.With(till).Post("/collections/sessions/{id}/close", s.closeTillSession)

	// --- sales -------------------------------------------------------------
	r.With(read).Get("/collections/sales", s.listPosSales)
	r.With(till).Post("/collections/sales", s.recordPosSale)
	r.With(read).Get("/collections/sales/{id}", s.getPosSale)
	r.With(refund).Post("/collections/sales/{id}/return", s.returnPosSale)

	// --- the store catalogue -----------------------------------------------
	r.With(read).Get("/collections/products", s.listStoreProducts)
	r.With(write).Post("/collections/products", s.saveStoreProduct)
	r.With(read).Get("/collections/variants", s.listStoreVariants)
	r.With(read).Get("/collections/stock-items", s.listStockItems)
	r.With(write).Post("/collections/variants", s.saveStoreVariant)

	// --- grant-in-aid ------------------------------------------------------
	r.With(read).Get("/collections/grants/heads", s.listGrantHeads)
	r.With(write).Post("/collections/grants/heads", s.saveGrantHead)

	r.With(read).Get("/collections/grants/utilisation", s.getGrantUtilisation)
	r.With(read).Get("/collections/grants/sanctions", s.listGrantSanctions)
	r.With(write).Post("/collections/grants/sanctions", s.saveGrantSanction)
	r.With(read).Get("/collections/grants/sanctions/{id}", s.getGrantSanction)
	r.With(write).Post("/collections/grants/sanctions/{id}/receipts", s.recordGrantReceipt)
	r.With(write).Post("/collections/grants/sanctions/{id}/expenditures", s.recordGrantExpenditure)

	r.With(read).Get("/collections/grants/certificates", s.listGrantCertificates)
	r.With(write).Post("/collections/grants/certificates", s.saveGrantCertificate)
	r.With(read).Get("/collections/grants/certificates/{id}", s.getGrantCertificate)
	// The two assertions the school is audited on.
	r.With(refund).Post("/collections/grants/certificates/{id}/issue", s.issueGrantCertificate)
	r.With(refund).Post("/collections/grants/certificates/{id}/dispose", s.disposeGrantUnspent)
}
