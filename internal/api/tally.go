package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/tally"
)

/*
The Tally bridge: one feature, two doors.

	A school's statutory books live in Tally, not here. The auditor reads Tally,
	the trust board reads Tally, and the chartered accountant will not be moved.
	So the job is not to replace it but to stop the accountant retyping a
	thousand vouchers every quarter.

	Two screens, and they are two halves of one thing rather than two features
	that happen to share a word:

	  - the connector (platform scope) is the mapping. This ERP's chart of
	    accounts against the ledger names that already exist in the school's
	    Tally company, the voucher types, the company name, the year. It is
	    configuration a school sets up once, with help, which is why it sits
	    under Super Admin.

	  - the export (institution scope) is the accountant's screen. A date
	    range, a voucher type filter, a validation, a file.

	Both go through internal/tally for the rendering, the balance check and the
	paise-to-rupee conversion. Nothing about the XML is written twice, because
	the second copy is the one that drifts and produces a file Tally rejects for
	reasons nobody can reproduce.

	Two rules govern the handlers below.

	Unmapped accounts block, and they block with a list. Tally rejects the file
	rather than the voucher, so one unmapped fee head wastes the whole trip —
	download, open Tally, find the import screen, wait, fail. The validation
	runs before a byte is rendered and answers with the accounts to fix.

	What went out is recorded. There is no undo for a Tally import; the vouchers
	land and removing them is a manual delete of each one. "Have I already
	pushed March" is the question the accountant actually has, and the product
	answers it from tally_export_run_vouchers rather than asking them to
	remember.
*/

// --- mounting ----------------------------------------------------------------

/*
mountTally registers the accountant's export inside the existing /finance
group, which already carries RequirePermission(InvoicesRead).

	Reads inherit that gate. Everything that produces a file or records a run
	names finance.export, which is the permission the Accounts & Finance role
	already holds for exactly this — see rbac.FinanceExport. No new permission
	was invented: an export is an export.

	The platform half is mountTallyConnector, below. They are separate functions
	because they mount under different prefixes with different gates, and chi
	will not let one call register routes under two Route trees.
*/
func (s *Server) mountTally(r chi.Router) {
	// Producing a file, and recording that it was produced.
	export := httpx.RequirePermission(rbac.FinanceExport)

	// What the screen needs to draw itself: the company, the year, whether the
	// mapping is complete. A read, inheriting the group's InvoicesRead.
	r.Get("/tally/settings", s.getTallyExportSettings)

	/* The validation, and the reason this endpoint exists separately from the
	   export. It is a read: it produces no run and no file, so the screen can
	   call it on every change of the date range without littering the history
	   with runs the accountant never took. */
	r.With(export).Get("/tally/validate", s.validateTallyExport)

	// POST because it records a run. A download that mutates must never be a
	// GET: a link prefetch would file a phantom export.
	r.With(export).Post("/tally/export", s.createTallyExport)

	/* The file itself, by run, as an idempotent GET.
	   Split from the POST above so the browser can fetch it by plain
	   navigation — which is what streams a large file to disk rather than
	   buffering it in the tab — and so a lost file can be downloaded again
	   without recording a second export of the same vouchers. */
	r.With(export).Get("/tally/runs/{id}/file", s.downloadTallyExport)

	r.Get("/tally/runs", s.listTallyExportRuns)
	r.With(export).Post("/tally/runs/{id}/confirm", s.confirmTallyExport)
}

/*
mountTallyConnector registers the platform-scoped connector under /admin.

	/admin carries no group-level permission, so every route names its own —
	the same arrangement mountPlatformConfig documents. The gate is
	platform.tenants.write throughout: institution_admin holds every other key
	in this product and deliberately not this one (rbac.keysExcept), which is
	what keeps a school out of the gateway address and the cross-tenant view.
*/
func (s *Server) mountTallyConnector(r chi.Router) {
	vendor := httpx.RequirePermission(rbac.PlatformTenantsRW)

	r.With(vendor).Get("/tally/connector", s.getTallyConnector)
	r.With(vendor).Put("/tally/connector", s.saveTallyConnector)

	// The mapping workbench: every postable account with its Tally name and
	// how much traffic it carries.
	r.With(vendor).Get("/tally/connector/accounts", s.listTallyMappableAccounts)
	r.With(vendor).Put("/tally/connector/mappings", s.saveTallyMappings)

	r.With(vendor).Put("/tally/connector/voucher-types", s.saveTallyVoucherTypes)
	r.With(vendor).Post("/tally/connector/voucher-types/defaults", s.seedTallyVoucherTypes)

	/* The gateway address and its secret. Platform admin only, and doubly so:
	   the RLS policy on tally_gateway_credentials is app_is_platform_admin()
	   with no tenant escape, so even a handler that forgot this middleware
	   would read nothing for an institution admin. */
	r.With(vendor).Get("/tally/connector/gateway", s.getTallyGateway)
	r.With(vendor).Put("/tally/connector/gateway", s.saveTallyGateway)
}

// --- shared shapes -----------------------------------------------------------

// tallySettingsRow is the connector configuration, as both screens read it.
type tallySettingsRow struct {
	CompanyName string  `json:"company_name"`
	FY          *int    `json:"default_fy_start_year,omitempty"`
	FYLabel     string  `json:"fy_label,omitempty"`
	Delivery    string  `json:"delivery"`
	Enabled     bool    `json:"is_enabled"`
	UpdatedAt   *string `json:"updated_at,omitempty"`
}

// tallyDeliveryRow describes one route to Tally for the screen to render. The
// screen must not hardcode these: whether a live push exists is a fact about
// the server, not a label.
type tallyDeliveryRow struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	LivePush bool   `json:"live_push"`
}

func tallyDeliveries() []tallyDeliveryRow {
	out := []tallyDeliveryRow{}
	for _, p := range tally.Providers() {
		out = append(out, tallyDeliveryRow{Key: p.Key(), Label: p.Label(), LivePush: p.LivePush()})
	}
	return out
}

// tallyAccountRow is one postable account and the Tally ledger it maps to.
type tallyAccountRow struct {
	ID          string  `json:"id"`
	Code        string  `json:"code"`
	Name        string  `json:"name"`
	Type        string  `json:"type"`
	LedgerName  *string `json:"tally_ledger_name,omitempty"`
	ParentGroup *string `json:"tally_parent_group,omitempty"`
	CostCentre  *string `json:"cost_centre,omitempty"`
	// Vouchers this account appears in, over the connector's chosen year.
	// Answers "which of these unmapped accounts actually matters".
	Vouchers int `json:"vouchers"`
}

// tallyVoucherTypeRow maps this ERP's voucher type to Tally's.
type tallyVoucherTypeRow struct {
	VoucherType string `json:"voucher_type"`
	TallyType   string `json:"tally_voucher_type"`
}

// tallyRunRow is one export that happened.
type tallyRunRow struct {
	ID           string   `json:"id"`
	FromDate     string   `json:"from_date"`
	ToDate       string   `json:"to_date"`
	VoucherTypes []string `json:"voucher_types"`
	CompanyName  string   `json:"company_name"`
	Delivery     string   `json:"delivery"`
	VoucherCount int      `json:"voucher_count"`
	TotalPaise   int64    `json:"total_paise"`
	ExportedAt   string   `json:"exported_at"`
	ExportedBy   *string  `json:"exported_by,omitempty"`
	ConfirmedAt  *string  `json:"confirmed_at,omitempty"`
}

/*
tallyValidation is the answer to "may I export this range, and what happens if
I do".

	Deliberately one object rather than an error. "Blocked" with no list is the
	message that sends somebody to support; the same call that refuses also
	says which nine accounts to name and which of the vouchers have gone out
	before.
*/
type tallyValidation struct {
	OK       bool     `json:"ok"`
	Blocking []string `json:"blocking"`
	Warnings []string `json:"warnings"`

	CompanyName string `json:"company_name"`
	FromDate    string `json:"from_date"`
	ToDate      string `json:"to_date"`

	VoucherCount int   `json:"voucher_count"`
	TotalPaise   int64 `json:"total_paise"`

	// The whole point of the connector, surfaced before any file exists.
	UnmappedAccounts     []tally.Unmapped            `json:"unmapped_accounts"`
	UnmappedVoucherTypes []tally.UnmappedVoucherType `json:"unmapped_voucher_types"`

	// Already sent, and when. A duplicate import into Tally is painful to
	// undo, so this is shown before the button rather than after.
	AlreadyExported int           `json:"already_exported"`
	NewVouchers     int           `json:"new_vouchers"`
	OverlappingRuns []tallyRunRow `json:"overlapping_runs"`
}

// --- helpers -----------------------------------------------------------------

/*
tallyFail maps a write failure to the most honest status available.

	Reuses the ledger refusal vocabulary rather than growing a second one: a
	check constraint on a tally_ table reads the same way to a user as one on a
	journal, and ledgerFail already tells a constraint violation apart from a
	genuine fault.
*/
func tallyFail(w http.ResponseWriter, r *http.Request, err error) { ledgerFail(w, r, err) }

// tallyPeriod reads ?from= and ?to=, defaulting to the financial year the
// connector is set to. Never re-derives the April-March arithmetic; fyRange
// owns it.
func tallyPeriod(r *http.Request, fy int) (time.Time, time.Time) {
	from, to := fyRange(fy)
	if v, err := parseDate(r.URL.Query().Get("from"), from); err == nil {
		from = v
	}
	if v, err := parseDate(r.URL.Query().Get("to"), to); err == nil {
		to = v
	}
	return from, to
}

/*
tallyTypes reads ?types=receipt,payment into the filter the queries take.

	An empty slice means every type, expressed in SQL as
	cardinality($n) = 0 OR voucher_type = ANY($n) rather than by assembling a
	different statement — one query with one plan, and no branch where the
	filter is silently dropped.
*/
func tallyTypes(r *http.Request) []string {
	raw := strings.TrimSpace(r.URL.Query().Get("types"))
	if raw == "" {
		return []string{}
	}
	out := []string{}
	for _, p := range strings.Split(raw, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// tallyLoadSettings reads the connector row inside an open transaction,
// returning zero values when the school has not configured it yet.
func tallyLoadSettings(r *http.Request, tx pgx.Tx, inst uuid.UUID) (tallySettingsRow, error) {
	var out tallySettingsRow
	var company *string
	var updated *time.Time
	err := tx.QueryRow(r.Context(), `
		SELECT company_name, default_fy_start_year, delivery, is_enabled, updated_at
		  FROM tally_connector_settings WHERE institution_id = $1`, inst).
		Scan(&company, &out.FY, &out.Delivery, &out.Enabled, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return tallySettingsRow{Delivery: "file"}, nil
	}
	if err != nil {
		return out, err
	}
	if company != nil {
		out.CompanyName = *company
	}
	if out.FY != nil {
		out.FYLabel = fyLabel(*out.FY)
	}
	if updated != nil {
		s := updated.Format(time.RFC3339)
		out.UpdatedAt = &s
	}
	return out, nil
}

// tallyFY is the year the connector works in: whatever it was configured with,
// else the current Indian financial year.
func tallyFY(set tallySettingsRow) int {
	if set.FY != nil {
		return *set.FY
	}
	return currentFY()
}

// --- the connector (platform scope) ------------------------------------------

/*
getTallyConnector is the connector screen in one call.

	Assembled server-side rather than left to four round trips, because every
	part of it is needed to answer the screen's only real question — is this
	school ready to export — and a screen that renders "ready" from three of
	four responses is a screen that lies for a moment on every load.
*/
func (s *Server) getTallyConnector(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r,
			"choose the school to configure: the Tally mapping follows a school's own chart of accounts")
		return
	}

	var set tallySettingsRow
	types := []tallyVoucherTypeRow{}
	var mapped, postable int

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		if set, err = tallyLoadSettings(r, tx, id.InstitutionID); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT voucher_type, tally_voucher_type
			  FROM tally_voucher_type_mappings
			 WHERE institution_id = $1
			 ORDER BY voucher_type`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v tallyVoucherTypeRow
			if err := rows.Scan(&v.VoucherType, &v.TallyType); err != nil {
				return err
			}
			types = append(types, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		/* How far the mapping has got. Groups are excluded because they cannot
		   be posted to (the journal_lines trigger refuses), so counting them
		   would report a school as permanently incomplete. */
		return tx.QueryRow(r.Context(), `
			SELECT count(*) FILTER (WHERE m.id IS NOT NULL), count(*)
			  FROM ledger_accounts a
			  LEFT JOIN tally_ledger_mappings m
			         ON m.ledger_account_id = a.id AND m.institution_id = a.institution_id
			 WHERE a.institution_id = $1 AND NOT a.is_group AND a.is_active`,
			id.InstitutionID).Scan(&mapped, &postable)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"settings":          set,
		"voucher_types":     types,
		"mapped_accounts":   mapped,
		"postable_accounts": postable,
		"unmapped_accounts": postable - mapped,
		"deliveries":        tallyDeliveries(),
		"erp_voucher_types": tallyERPVoucherTypes,
		/* Stated by the server so the screen cannot promise more than the
		   product does. There is no Tally API: the gateway is a listener a
		   running copy of Tally opens on the school's own LAN. */
		"live_push_available": false,
		"live_push_note": "Tally Prime has no cloud API. Its gateway runs on the " +
			"accountant's own machine, on the school network, only while Tally is " +
			"open — a hosted server cannot reach it. Export the XML and import it " +
			"in Tally: Gateway of Tally, then Import, then Vouchers.",
	})
}

// tallyERPVoucherTypes is journal_entries.voucher_type's own list, published so
// the connector screen offers exactly what can be posted rather than a copy
// that drifts from the check constraint.
var tallyERPVoucherTypes = []string{
	"journal", "receipt", "payment", "contra", "purchase", "sales",
	"depreciation", "opening", "closing",
}

type saveTallyConnectorRequest struct {
	CompanyName string `json:"company_name"`
	FY          *int   `json:"default_fy_start_year"`
	Delivery    string `json:"delivery"`
	Enabled     bool   `json:"is_enabled"`
}

func (s *Server) saveTallyConnector(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r, "choose the school to configure")
		return
	}
	var req saveTallyConnectorRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.CompanyName = strings.TrimSpace(req.CompanyName)
	req.Delivery = strings.TrimSpace(req.Delivery)
	if req.Delivery == "" {
		req.Delivery = "file"
	}
	if req.Delivery != "file" && req.Delivery != "gateway" {
		httpx.BadRequest(w, r, "delivery must be file or gateway")
		return
	}
	/* Enabling without a company name would leave the export screen offering a
	   download that renders an empty SVCURRENTCOMPANY, which Tally reads as
	   "whichever company is open" — the failure that puts one school's fees in
	   another school's books. */
	if req.Enabled && req.CompanyName == "" {
		httpx.BadRequest(w, r,
			"name the Tally company before enabling the connector: an import with no company named lands in whichever company happens to be open")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO tally_connector_settings
			    (institution_id, company_name, default_fy_start_year, delivery, is_enabled, updated_by)
			VALUES ($1, nullif(btrim($2), ''), $3, $4, $5, $6)
			ON CONFLICT (institution_id) DO UPDATE
			   SET company_name          = EXCLUDED.company_name,
			       default_fy_start_year = EXCLUDED.default_fy_start_year,
			       delivery              = EXCLUDED.delivery,
			       is_enabled            = EXCLUDED.is_enabled,
			       updated_at            = now(),
			       updated_by            = EXCLUDED.updated_by`,
			id.InstitutionID, req.CompanyName, req.FY, req.Delivery, req.Enabled, id.UserID)
		return err
	})
	if err != nil {
		tallyFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

/*
listTallyMappableAccounts is the mapping workbench.

	Groups are left out: journal_line_account_is_postable refuses a posting
	against one, so a group can never appear in an export and asking somebody to
	map "Assets" would be asking for busywork that then reads as an incomplete
	mapping forever.

	The voucher count is over the connector's financial year, and it is the
	column that makes the screen usable. A chart of accounts has a hundred
	leaves; six of them carry the term's fee receipts. Sorting the unmapped by
	traffic puts the one blocking two hundred vouchers above the one blocking
	none.
*/
func (s *Server) listTallyMappableAccounts(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r, "choose the school to configure")
		return
	}

	items := []tallyAccountRow{}
	var fy int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := tallyLoadSettings(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		fy = tallyFY(set)
		if v, e := strconv.Atoi(r.URL.Query().Get("fy")); e == nil && v > 2000 {
			fy = v
		}
		from, to := fyRange(fy)

		rows, err := tx.Query(r.Context(), `
			SELECT a.id::text, a.code, a.name, a.type,
			       m.tally_ledger_name, m.tally_parent_group, m.cost_centre,
			       count(DISTINCT e.id)::int
			  FROM ledger_accounts a
			  LEFT JOIN tally_ledger_mappings m
			         ON m.ledger_account_id = a.id AND m.institution_id = a.institution_id
			  LEFT JOIN journal_lines l
			         ON l.account_id = a.id AND l.institution_id = a.institution_id
			  LEFT JOIN journal_entries e
			         ON e.id = l.entry_id AND e.entry_date BETWEEN $2 AND $3
			 WHERE a.institution_id = $1 AND NOT a.is_group AND a.is_active
			 GROUP BY a.id, a.code, a.name, a.type,
			          m.tally_ledger_name, m.tally_parent_group, m.cost_centre
			 ORDER BY count(DISTINCT e.id) DESC, a.code`,
			id.InstitutionID, from, to)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v tallyAccountRow
			if err := rows.Scan(&v.ID, &v.Code, &v.Name, &v.Type,
				&v.LedgerName, &v.ParentGroup, &v.CostCentre, &v.Vouchers); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "fy": fy, "fy_label": fyLabel(fy),
	})
}

type tallyMappingInput struct {
	AccountID   string `json:"account_id"`
	LedgerName  string `json:"tally_ledger_name"`
	ParentGroup string `json:"tally_parent_group"`
	CostCentre  string `json:"cost_centre"`
}

type saveTallyMappingsRequest struct {
	Mappings []tallyMappingInput `json:"mappings"`
}

/*
saveTallyMappings writes the workbench back in one transaction.

	A blank ledger name deletes the mapping rather than storing an empty string:
	the check constraint refuses blank anyway, and "I cleared this field" means
	unmapped, which is a state the validation must be able to see.
*/
func (s *Server) saveTallyMappings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r, "choose the school to configure")
		return
	}
	var req saveTallyMappingsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Mappings) == 0 {
		httpx.BadRequest(w, r, "no mappings supplied")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, m := range req.Mappings {
			acc, err := uuid.Parse(strings.TrimSpace(m.AccountID))
			if err != nil {
				return refusef("account_id %q is not a uuid", m.AccountID)
			}
			name := strings.TrimSpace(m.LedgerName)
			if name == "" {
				if _, err := tx.Exec(r.Context(), `
					DELETE FROM tally_ledger_mappings
					 WHERE institution_id = $1 AND ledger_account_id = $2`,
					id.InstitutionID, acc); err != nil {
					return err
				}
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO tally_ledger_mappings
				    (institution_id, ledger_account_id, tally_ledger_name,
				     tally_parent_group, cost_centre, updated_by)
				VALUES ($1, $2, $3, nullif(btrim($4), ''), nullif(btrim($5), ''), $6)
				ON CONFLICT (institution_id, ledger_account_id) DO UPDATE
				   SET tally_ledger_name  = EXCLUDED.tally_ledger_name,
				       tally_parent_group = EXCLUDED.tally_parent_group,
				       cost_centre        = EXCLUDED.cost_centre,
				       updated_at         = now(),
				       updated_by         = EXCLUDED.updated_by`,
				id.InstitutionID, acc, name, m.ParentGroup, m.CostCentre, id.UserID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		tallyFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "saved": len(req.Mappings)})
}

type saveTallyVoucherTypesRequest struct {
	Types []tallyVoucherTypeRow `json:"voucher_types"`
}

func (s *Server) saveTallyVoucherTypes(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r, "choose the school to configure")
		return
	}
	var req saveTallyVoucherTypesRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, t := range req.Types {
			src := strings.TrimSpace(t.VoucherType)
			dst := strings.TrimSpace(t.TallyType)
			if dst == "" {
				if _, err := tx.Exec(r.Context(), `
					DELETE FROM tally_voucher_type_mappings
					 WHERE institution_id = $1 AND voucher_type = $2`,
					id.InstitutionID, src); err != nil {
					return err
				}
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO tally_voucher_type_mappings
				    (institution_id, voucher_type, tally_voucher_type)
				VALUES ($1, $2, $3)
				ON CONFLICT (institution_id, voucher_type) DO UPDATE
				   SET tally_voucher_type = EXCLUDED.tally_voucher_type,
				       updated_at         = now()`,
				id.InstitutionID, src, dst); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		tallyFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

/*
seedTallyVoucherTypes applies the standard map.

	The same list migration 00049 seeded for the schools that existed then.
	A school created afterwards needs it too, and an operator who cleared a row
	by mistake needs it back, so the list lives here as well as in the migration
	— and ON CONFLICT DO NOTHING means it never overwrites a name the school
	deliberately changed.
*/
func (s *Server) seedTallyVoucherTypes(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r, "choose the school to configure")
		return
	}

	// Tally has no depreciation, opening or closing voucher type. They are
	// Journals there.
	defaults := [][2]string{
		{"journal", "Journal"}, {"receipt", "Receipt"}, {"payment", "Payment"},
		{"contra", "Contra"}, {"purchase", "Purchase"}, {"sales", "Sales"},
		{"depreciation", "Journal"}, {"opening", "Journal"}, {"closing", "Journal"},
	}

	var added int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, d := range defaults {
			tag, err := tx.Exec(r.Context(), `
				INSERT INTO tally_voucher_type_mappings
				    (institution_id, voucher_type, tally_voucher_type)
				VALUES ($1, $2, $3)
				ON CONFLICT (institution_id, voucher_type) DO NOTHING`,
				id.InstitutionID, d[0], d[1])
			if err != nil {
				return err
			}
			added += int(tag.RowsAffected())
		}
		return nil
	})
	if err != nil {
		tallyFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "added": added})
}

/*
getTallyGateway reads the LAN address, for platform staff only.

	Through AsPlatform rather than InTenant, and gated on platform.tenants.write
	above. Both, deliberately: the policy on the table is the guarantee, the
	middleware is the readable statement of intent, and neither is trusted to be
	the only one.

	The stored secret is never returned. A screen needs to know whether one is
	set, which is a boolean; returning the value itself would put it in a
	response body, a browser cache and whatever proxy sits between — for a
	credential the school's own administrator is not allowed to see.
*/
func (s *Server) getTallyGateway(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var url, notes *string
	var hasSecret bool
	var updated *time.Time
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT gateway_url, notes, credentials IS NOT NULL AND length(credentials) > 0, updated_at
			  FROM tally_gateway_credentials
			 WHERE COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid)
			     = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
			nullUUIDArg(id.InstitutionID)).Scan(&url, &notes, &hasSecret, &updated)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out := map[string]any{
		"gateway_url":         strFromPtr(url),
		"notes":               strFromPtr(notes),
		"has_credentials":     hasSecret,
		"live_push_available": false,
		"note": "Recorded for an on-site relay only. Tally's gateway listens on the " +
			"school's own network while Tally is open; this server cannot reach it, " +
			"and no request is made to this address today.",
	}
	if updated != nil {
		out["updated_at"] = updated.Format(time.RFC3339)
	}
	httpx.JSON(w, http.StatusOK, out)
}

type saveTallyGatewayRequest struct {
	GatewayURL string `json:"gateway_url"`
	// Absent leaves the stored secret alone; an empty string clears it. The
	// distinction matters: a screen that reloads and saves must not wipe a
	// credential it was never shown.
	Secret *string `json:"secret"`
	Notes  string  `json:"notes"`
}

func (s *Server) saveTallyGateway(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req saveTallyGatewayRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var sealed []byte
	clear := false
	if req.Secret != nil {
		if strings.TrimSpace(*req.Secret) == "" {
			clear = true
		} else {
			var err error
			if sealed, err = sealSecret(*req.Secret); err != nil {
				httpx.BadRequest(w, r, err.Error())
				return
			}
		}
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO tally_gateway_credentials
			    (institution_id, gateway_url, credentials, notes, updated_by)
			VALUES ($1, nullif(btrim($2), ''), $3, nullif(btrim($4), ''), $5)
			ON CONFLICT (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET
			    gateway_url = EXCLUDED.gateway_url,
			    -- Absent secret keeps the stored one; an explicit clear wipes it.
			    credentials = CASE WHEN $6 THEN NULL
			                       ELSE COALESCE(EXCLUDED.credentials,
			                                     tally_gateway_credentials.credentials) END,
			    notes       = EXCLUDED.notes,
			    updated_at  = now(),
			    updated_by  = EXCLUDED.updated_by`,
			nullUUIDArg(id.InstitutionID), req.GatewayURL, sealed, req.Notes, id.UserID, clear)
		return err
	})
	if err != nil {
		tallyFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- the export (institution scope) ------------------------------------------

// getTallyExportSettings is what the accountant's screen needs to draw itself.
func (s *Server) getTallyExportSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var set tallySettingsRow
	var unmapped int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		if set, err = tallyLoadSettings(r, tx, id.InstitutionID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			SELECT count(*)
			  FROM ledger_accounts a
			  LEFT JOIN tally_ledger_mappings m
			         ON m.ledger_account_id = a.id AND m.institution_id = a.institution_id
			 WHERE a.institution_id = $1 AND NOT a.is_group AND a.is_active
			   AND m.id IS NULL`, id.InstitutionID).Scan(&unmapped)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	fy := tallyFY(set)
	from, to := fyRange(fy)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"settings":            set,
		"fy":                  fy,
		"fy_label":            fyLabel(fy),
		"suggested_from":      from.Format(time.DateOnly),
		"suggested_to":        to.Format(time.DateOnly),
		"unmapped_accounts":   unmapped,
		"configured":          set.CompanyName != "",
		"deliveries":          tallyDeliveries(),
		"live_push_available": false,
		"live_push_note": "This produces a file you import in Tally Prime — Gateway of " +
			"Tally, then Import, then Vouchers. There is no direct push: Tally's " +
			"gateway runs on the accountant's own machine on the school network, " +
			"only while Tally is open, and a hosted server cannot reach it.",
	})
}

/*
tallyGather reads the period's vouchers and everything the validation needs, in
one pass, inside a caller's transaction.

	One function for the validate endpoint and the export endpoint both. They
	must agree exactly — a validation that passes and an export that then
	refuses is worse than either failing alone — and the only way to guarantee
	that is for them to run the same code rather than two queries somebody keeps
	in step by hand.
*/
type tallyGathered struct {
	Vouchers  []tally.Voucher
	Unmapped  []tally.Unmapped
	UnmappedT []tally.UnmappedVoucherType
	Total     int64
	// Vouchers in the range that have gone out before, by journal_entries.id.
	AlreadyExported map[string]bool
}

func tallyGather(r *http.Request, tx pgx.Tx, inst uuid.UUID,
	from, to time.Time, types []string, onlyNew bool) (tallyGathered, error) {

	var g tallyGathered
	g.AlreadyExported = map[string]bool{}

	// What has gone out before, first: it decides which vouchers are even
	// collected when the accountant asked for new ones only.
	rows, err := tx.Query(r.Context(), `
		SELECT DISTINCT rv.journal_entry_id::text
		  FROM tally_export_run_vouchers rv
		  JOIN journal_entries e ON e.id = rv.journal_entry_id
		 WHERE rv.institution_id = $1
		   AND e.entry_date BETWEEN $2 AND $3
		   AND (cardinality($4::text[]) = 0 OR e.voucher_type = ANY($4))`,
		inst, from, to, types)
	if err != nil {
		return g, err
	}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			rows.Close()
			return g, err
		}
		g.AlreadyExported[s] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return g, err
	}

	/* The vouchers, line by line, with the mapping attached.

	   LEFT JOIN rather than INNER on the mapping: an inner join would silently
	   drop the unmapped lines and produce a voucher that no longer balances,
	   which Tally would then reject for a reason that has nothing to do with
	   the real fault. The unmapped ones must come back so they can be named. */
	rows, err = tx.Query(r.Context(), `
		SELECT e.id::text, e.voucher_no, e.voucher_type, e.entry_date, e.narration,
		       vt.tally_voucher_type,
		       a.id::text, a.code, a.name, m.tally_ledger_name,
		       l.debit_paise, l.credit_paise
		  FROM journal_entries e
		  JOIN journal_lines  l ON l.entry_id  = e.id AND l.institution_id = e.institution_id
		  JOIN ledger_accounts a ON a.id       = l.account_id AND a.institution_id = e.institution_id
		  LEFT JOIN tally_ledger_mappings m
		         ON m.ledger_account_id = a.id AND m.institution_id = e.institution_id
		  LEFT JOIN tally_voucher_type_mappings vt
		         ON vt.voucher_type = e.voucher_type AND vt.institution_id = e.institution_id
		 WHERE e.institution_id = $1
		   AND e.entry_date BETWEEN $2 AND $3
		   AND (cardinality($4::text[]) = 0 OR e.voucher_type = ANY($4))
		 ORDER BY e.entry_date, e.voucher_no, l.line_no`,
		inst, from, to, types)
	if err != nil {
		return g, err
	}
	defer rows.Close()

	// Accumulated per account and per type so each is reported once with a
	// count, rather than once per line.
	unmappedAcc := map[string]*tally.Unmapped{}
	unmappedAccSeen := map[string]map[string]bool{}
	unmappedTypes := map[string]int{}
	seenType := map[string]map[string]bool{}

	var cur *tally.Voucher
	for rows.Next() {
		var entryID, voucherNo, voucherType, narration string
		var entryDate time.Time
		var tallyType, ledgerName *string
		var accID, accCode, accName string
		var debit, credit int64

		if err := rows.Scan(&entryID, &voucherNo, &voucherType, &entryDate, &narration,
			&tallyType, &accID, &accCode, &accName, &ledgerName,
			&debit, &credit); err != nil {
			return g, err
		}

		if onlyNew && g.AlreadyExported[entryID] {
			continue
		}

		if tallyType == nil {
			if seenType[voucherType] == nil {
				seenType[voucherType] = map[string]bool{}
			}
			if !seenType[voucherType][entryID] {
				seenType[voucherType][entryID] = true
				unmappedTypes[voucherType]++
			}
		}
		if ledgerName == nil {
			u, ok := unmappedAcc[accID]
			if !ok {
				u = &tally.Unmapped{AccountID: accID, Code: accCode, Name: accName}
				unmappedAcc[accID] = u
				unmappedAccSeen[accID] = map[string]bool{}
			}
			if !unmappedAccSeen[accID][entryID] {
				unmappedAccSeen[accID][entryID] = true
				u.Vouchers++
			}
		}

		if cur == nil || cur.SourceID != entryID {
			if cur != nil {
				g.Vouchers = append(g.Vouchers, *cur)
			}
			v := tally.Voucher{
				SourceID:  entryID,
				Date:      entryDate,
				Number:    voucherNo,
				Narration: narration,
			}
			if tallyType != nil {
				v.VoucherType = *tallyType
			}
			cur = &v
		}

		/* Tally's sign convention, applied at the only place it is applied.

		   journal_lines holds two positive columns, one of which is zero.
		   Tally wants one signed amount: negative for a debit, positive for a
		   credit. credit - debit gives exactly that, and because every voucher
		   balances in the ledger (the deferred constraint trigger in 00033
		   guarantees it), the entries here sum to zero — which is what Tally
		   checks before accepting the file. */
		name := ""
		if ledgerName != nil {
			name = *ledgerName
		}
		cur.Entries = append(cur.Entries, tally.Entry{
			LedgerName:  name,
			AmountPaise: credit - debit,
		})
		g.Total += debit
	}
	if cur != nil {
		g.Vouchers = append(g.Vouchers, *cur)
	}
	if err := rows.Err(); err != nil {
		return g, err
	}

	for _, u := range unmappedAcc {
		g.Unmapped = append(g.Unmapped, *u)
	}
	tally.SortUnmapped(g.Unmapped)
	for t, n := range unmappedTypes {
		g.UnmappedT = append(g.UnmappedT, tally.UnmappedVoucherType{VoucherType: t, Vouchers: n})
	}

	return g, nil
}

/*
validateTallyExport answers "may I export this range" before any file exists.

	A read. It records nothing, so the screen may call it on every change to the
	date range without filling the run history with exports nobody took.
*/
func (s *Server) validateTallyExport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	onlyNew := r.URL.Query().Get("include_exported") != "true"
	types := tallyTypes(r)

	var out tallyValidation
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := tallyLoadSettings(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		from, to := tallyPeriod(r, tallyFY(set))
		if to.Before(from) {
			return refusef("the end of the period is before its start")
		}

		g, err := tallyGather(r, tx, id.InstitutionID, from, to, types, onlyNew)
		if err != nil {
			return err
		}

		out = tallyValidation{
			CompanyName:          set.CompanyName,
			FromDate:             from.Format(time.DateOnly),
			ToDate:               to.Format(time.DateOnly),
			VoucherCount:         len(g.Vouchers),
			TotalPaise:           g.Total,
			UnmappedAccounts:     g.Unmapped,
			UnmappedVoucherTypes: g.UnmappedT,
			AlreadyExported:      len(g.AlreadyExported),
			Blocking:             []string{},
			Warnings:             []string{},
			OverlappingRuns:      []tallyRunRow{},
		}
		out.NewVouchers = len(g.Vouchers)

		out.OverlappingRuns, err = tallyRunsOverlapping(r, tx, id.InstitutionID, from, to)
		return err
	})
	if err != nil {
		tallyFail(w, r, err)
		return
	}

	// The blocking list, in the order somebody fixes them.
	if strings.TrimSpace(out.CompanyName) == "" {
		out.Blocking = append(out.Blocking,
			"No Tally company is configured. Set it on the Tally connector before exporting.")
	}
	if n := len(out.UnmappedAccounts); n > 0 {
		out.Blocking = append(out.Blocking, fmt.Sprintf(
			"%d account(s) in this period have no Tally ledger name. Tally rejects the whole file, not the voucher, so all of them must be mapped first.", n))
	}
	if n := len(out.UnmappedVoucherTypes); n > 0 {
		out.Blocking = append(out.Blocking, fmt.Sprintf(
			"%d voucher type(s) in this period have no Tally equivalent mapped.", n))
	}
	if out.VoucherCount == 0 {
		out.Blocking = append(out.Blocking,
			"There is nothing to export in this period.")
	}
	if out.AlreadyExported > 0 {
		out.Warnings = append(out.Warnings, fmt.Sprintf(
			"%d voucher(s) in this range have been exported before. A duplicate import into Tally has to be undone voucher by voucher.", out.AlreadyExported))
	}
	out.OK = len(out.Blocking) == 0

	httpx.JSON(w, http.StatusOK, out)
}

// tallyRunsOverlapping lists prior runs whose period touches this one — the
// evidence behind "have I already pushed March".
func tallyRunsOverlapping(r *http.Request, tx pgx.Tx, inst uuid.UUID,
	from, to time.Time) ([]tallyRunRow, error) {

	out := []tallyRunRow{}
	rows, err := tx.Query(r.Context(), `
		SELECT id::text, from_date, to_date, voucher_types, company_name, delivery,
		       voucher_count, total_paise, exported_at, confirmed_at
		  FROM tally_export_runs
		 WHERE institution_id = $1 AND from_date <= $3 AND to_date >= $2
		 ORDER BY exported_at DESC
		 LIMIT 10`, inst, from, to)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var v tallyRunRow
		var fromD, toD time.Time
		var exported time.Time
		var confirmed *time.Time
		if err := rows.Scan(&v.ID, &fromD, &toD, &v.VoucherTypes, &v.CompanyName,
			&v.Delivery, &v.VoucherCount, &v.TotalPaise, &exported, &confirmed); err != nil {
			return out, err
		}
		v.FromDate = fromD.Format(time.DateOnly)
		v.ToDate = toD.Format(time.DateOnly)
		v.ExportedAt = exported.Format(time.RFC3339)
		if confirmed != nil {
			c := confirmed.Format(time.RFC3339)
			v.ConfirmedAt = &c
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

/*
createTallyExport validates, renders, and records what went out.

	All of it in one transaction. The render is inside deliberately: if
	internal/tally refuses a voucher — an unbalanced one, an unmapped ledger
	that slipped past the validation — the run is rolled back with it, so the
	history never shows an export that produced no file.

	The file is not returned here. The run is created and the client fetches
	the bytes from the GET below, which keeps the recording POST separate from
	the idempotent download and lets a lost file be fetched again without a
	second run appearing.
*/
type createTallyExportRequest struct {
	From            string   `json:"from"`
	To              string   `json:"to"`
	VoucherTypes    []string `json:"voucher_types"`
	IncludeExported bool     `json:"include_exported"`
}

func (s *Server) createTallyExport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req createTallyExportRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var runID string
	var count int
	var total int64
	var company string

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := tallyLoadSettings(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		company = strings.TrimSpace(set.CompanyName)
		if company == "" {
			return refusef("no Tally company is configured; set it on the Tally connector before exporting")
		}

		defFrom, defTo := fyRange(tallyFY(set))
		from, err := parseDate(strings.TrimSpace(req.From), defFrom)
		if err != nil {
			return refusef("from must be a date as YYYY-MM-DD")
		}
		to, err := parseDate(strings.TrimSpace(req.To), defTo)
		if err != nil {
			return refusef("to must be a date as YYYY-MM-DD")
		}
		if to.Before(from) {
			return refusef("the end of the period is before its start")
		}

		types := req.VoucherTypes
		if types == nil {
			types = []string{}
		}
		g, err := tallyGather(r, tx, id.InstitutionID, from, to, types, !req.IncludeExported)
		if err != nil {
			return err
		}

		/* The blocking check, restated here rather than trusted from the
		   validate call. The screen calls validate first, but a client is not
		   an authorisation boundary and the mapping can change between the two
		   requests. */
		if len(g.Unmapped) > 0 {
			names := make([]string, 0, 3)
			for i, u := range g.Unmapped {
				if i == 3 {
					break
				}
				names = append(names, u.Code+" "+u.Name)
			}
			return refusef(
				"%d account(s) have no Tally ledger name (%s). Tally rejects the whole file, so map them on the connector first",
				len(g.Unmapped), strings.Join(names, ", "))
		}
		if len(g.UnmappedT) > 0 {
			return refusef("%d voucher type(s) have no Tally equivalent mapped on the connector",
				len(g.UnmappedT))
		}
		if len(g.Vouchers) == 0 {
			return refusef("there is nothing to export in this period")
		}

		// Render before recording. A batch internal/tally refuses must not
		// leave a run behind claiming it went out.
		if _, err := tally.Render(tally.Batch{Company: company, Vouchers: g.Vouchers}); err != nil {
			return refusef("%s", err.Error())
		}

		count, total = len(g.Vouchers), g.Total
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO tally_export_runs
			    (institution_id, from_date, to_date, voucher_types, company_name,
			     delivery, voucher_count, total_paise, exported_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			RETURNING id::text`,
			id.InstitutionID, from, to, types, company, set.Delivery,
			count, total, id.UserID).Scan(&runID); err != nil {
			return err
		}

		// The mark. A row per voucher, so "which run was this in" stays
		// answerable — see the table comment for why not a flag.
		ids := make([]uuid.UUID, 0, len(g.Vouchers))
		for _, v := range g.Vouchers {
			u, err := uuid.Parse(v.SourceID)
			if err != nil {
				return err
			}
			ids = append(ids, u)
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO tally_export_run_vouchers (institution_id, run_id, journal_entry_id)
			SELECT $1, $2, unnest($3::uuid[])`, id.InstitutionID, runID, ids)
		return err
	})
	if err != nil {
		tallyFail(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"run_id":        runID,
		"voucher_count": count,
		"total_paise":   total,
		"company_name":  company,
		"download_url":  "/api/v1/finance/tally/runs/" + runID + "/file",
		"note":          "Import in Tally Prime: Gateway of Tally, then Import, then Vouchers.",
	})
}

/*
downloadTallyExport streams the file for a recorded run.

	Idempotent: it re-renders from the vouchers the run recorded, so the bytes
	are the same every time and fetching them twice does not record a second
	export. Re-rendering rather than storing the XML keeps a large file out of
	the database, and the voucher set is pinned by tally_export_run_vouchers so
	the result cannot drift with later postings.
*/
func (s *Server) downloadTallyExport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	runID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid run id")
		return
	}

	var body []byte
	var filename string

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var company string
		var from, to time.Time
		if err := tx.QueryRow(r.Context(), `
			SELECT company_name, from_date, to_date
			  FROM tally_export_runs WHERE id = $1 AND institution_id = $2`,
			runID, id.InstitutionID).Scan(&company, &from, &to); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT e.id::text, e.voucher_no, e.entry_date, e.narration,
			       vt.tally_voucher_type, m.tally_ledger_name,
			       l.debit_paise, l.credit_paise
			  FROM tally_export_run_vouchers rv
			  JOIN journal_entries  e ON e.id = rv.journal_entry_id
			  JOIN journal_lines    l ON l.entry_id = e.id AND l.institution_id = e.institution_id
			  JOIN ledger_accounts  a ON a.id = l.account_id AND a.institution_id = e.institution_id
			  LEFT JOIN tally_ledger_mappings m
			         ON m.ledger_account_id = a.id AND m.institution_id = e.institution_id
			  LEFT JOIN tally_voucher_type_mappings vt
			         ON vt.voucher_type = e.voucher_type AND vt.institution_id = e.institution_id
			 WHERE rv.run_id = $1 AND rv.institution_id = $2
			 ORDER BY e.entry_date, e.voucher_no, l.line_no`, runID, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()

		vouchers := []tally.Voucher{}
		var cur *tally.Voucher
		for rows.Next() {
			var entryID, voucherNo, narration string
			var entryDate time.Time
			var tallyType, ledgerName *string
			var debit, credit int64
			if err := rows.Scan(&entryID, &voucherNo, &entryDate, &narration,
				&tallyType, &ledgerName, &debit, &credit); err != nil {
				return err
			}
			if cur == nil || cur.SourceID != entryID {
				if cur != nil {
					vouchers = append(vouchers, *cur)
				}
				v := tally.Voucher{SourceID: entryID, Date: entryDate,
					Number: voucherNo, Narration: narration}
				if tallyType != nil {
					v.VoucherType = *tallyType
				}
				cur = &v
			}
			name := ""
			if ledgerName != nil {
				name = *ledgerName
			}
			cur.Entries = append(cur.Entries, tally.Entry{
				LedgerName: name, AmountPaise: credit - debit})
		}
		if cur != nil {
			vouchers = append(vouchers, *cur)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		/* Delivered through the provider rather than by calling Render here.
		   The interface is the seam a real on-site push would slot into, and a
		   handler that bypassed it would be the reason that never happened. */
		receipt, err := tally.ProviderFor("file").Deliver(
			tally.Batch{Company: company, Vouchers: vouchers})
		if err != nil {
			return refusef("%s", err.Error())
		}
		body = receipt.Body
		filename = fmt.Sprintf("tally-%s-to-%s.xml",
			from.Format(time.DateOnly), to.Format(time.DateOnly))
		return nil
	})
	if err != nil {
		// Bail before a single header is written: once the attachment headers
		// are out, the only thing left to send is a corrupt file.
		tallyFail(w, r, err)
		return
	}

	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	_, _ = w.Write(body)
}

func (s *Server) listTallyExportRuns(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items := []tallyRunRow{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT r.id::text, r.from_date, r.to_date, r.voucher_types, r.company_name,
			       r.delivery, r.voucher_count, r.total_paise, r.exported_at,
			       r.confirmed_at, u.full_name
			  FROM tally_export_runs r
			  LEFT JOIN users u ON u.id = r.exported_by
			 WHERE r.institution_id = $1
			 ORDER BY r.exported_at DESC
			 LIMIT 100`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v tallyRunRow
			var fromD, toD, exported time.Time
			var confirmed *time.Time
			if err := rows.Scan(&v.ID, &fromD, &toD, &v.VoucherTypes, &v.CompanyName,
				&v.Delivery, &v.VoucherCount, &v.TotalPaise, &exported,
				&confirmed, &v.ExportedBy); err != nil {
				return err
			}
			v.FromDate = fromD.Format(time.DateOnly)
			v.ToDate = toD.Format(time.DateOnly)
			v.ExportedAt = exported.Format(time.RFC3339)
			if confirmed != nil {
				c := confirmed.Format(time.RFC3339)
				v.ConfirmedAt = &c
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	respond(w, r, items, err)
}

/*
confirmTallyExport records that the file actually reached Tally.

	The product cannot observe the import — it happens in another application on
	another machine — so this is the accountant saying so. Worth recording
	anyway: "downloaded but never imported" and "imported" are different
	answers to "have I pushed March", and only one of them means somebody else
	can stop worrying.
*/
func (s *Server) confirmTallyExport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	runID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid run id")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE tally_export_runs
			   SET confirmed_at = now(), confirmed_by = $3
			 WHERE id = $1 AND institution_id = $2 AND confirmed_at IS NULL`,
			runID, id.InstitutionID, id.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err != nil {
		tallyFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- small shared bits -------------------------------------------------------

// strFromPtr flattens a nullable text column for a JSON body that would rather
// carry "" than null.
func strFromPtr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
