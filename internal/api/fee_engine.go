package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The fee engine: three features that share one spine.

	Fee structure versioning, the late fine rules engine and GST receipt
	numbering are one file because they are one argument. A fee structure is
	revised mid-year; the invoices already raised must keep meaning what they
	meant; a fine computed on those invoices must read the version they were
	raised under; and the receipt that settles them must carry a number an
	auditor will accept. Split across three files, the middle of that chain —
	that a fine's basis comes from a frozen version, not from today's structure
	— is the thing that gets lost.

	Mounting: the integrator splices `s.mountFeeEngine(r)` into the /finance
	group in api.go, beside `s.mountLedgers(r)`. That group already carries
	RequirePermission(rbac.InvoicesRead), which is the right read gate — these
	screens show what students owe. Writes name their own permission below.
*/

// mountFeeEngine registers the fee engine endpoints.
//
// Routes are flat under /fee-engine rather than nested in another r.Route,
// matching mountLedgers, so the integrator can drop the call in without
// rearranging the group.
func (s *Server) mountFeeEngine(r chi.Router) {
	// Fee masters: structures, their versions, fine rules, the receipt series.
	// The same permission that already guards fee heads and structures.
	masters := httpx.RequirePermission(rbac.FeesWrite)
	// Raising a fine changes what a parent owes, so it is money, not master
	// data. Deliberately a different permission from configuring the rule: the
	// clerk who runs the monthly fine sweep is not the person who decides the
	// policy.
	levy := httpx.RequirePermission(rbac.InvoicesWrite)

	// --- fee structure versioning -----------------------------------------
	r.Get("/fee-engine/structures", s.listVersionedStructures)
	r.Get("/fee-engine/structures/{id}/versions", s.listStructureVersions)
	r.With(masters).Post("/fee-engine/versions", s.saveStructureVersion)
	r.With(masters).Put("/fee-engine/versions/{id}/items", s.setStructureVersionItems)
	r.With(masters).Post("/fee-engine/versions/{id}/activate", s.activateStructureVersion)
	r.With(masters).Delete("/fee-engine/versions/{id}", s.discardStructureVersion)

	// --- late fine rules engine -------------------------------------------
	r.Get("/fee-engine/fine-rules", s.listFineRules)
	r.With(masters).Post("/fee-engine/fine-rules", s.saveFineRule)
	r.With(masters).Delete("/fee-engine/fine-rules/{id}", s.deleteFineRule)

	// Preview is a read: it computes, shows the working, and writes nothing.
	// There is deliberately no scheduled counterpart — see applyFines.
	r.Get("/fee-engine/fines/preview", s.previewFines)
	r.With(levy).Post("/fee-engine/fines/apply", s.applyFines)
	r.Get("/fee-engine/fines/charges", s.listFineCharges)
	r.With(levy).Post("/fee-engine/fines/charges/{id}/waive", s.waiveFineCharge)

	// --- GST compliant receipt numbering ----------------------------------
	r.Get("/fee-engine/receipt-series", s.getReceiptSeries)
	r.With(masters).Put("/fee-engine/receipt-series/{kind}", s.saveReceiptSeries)
	r.With(masters).Put("/fee-engine/gst-heads/{id}", s.saveHeadGSTTreatment)
}

// The zero uuid the migration's COALESCEd unique indexes collapse NULL to.
const zeroUUIDText = "00000000-0000-0000-0000-000000000000"

// ===================================================================
// Fee structure versioning
// ===================================================================

type feStructureRow struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	ClassName     *string `json:"class_name,omitempty"`
	AcademicYear  *string `json:"academic_year,omitempty"`
	AppliesTo     *string `json:"applies_to,omitempty"`
	IsActive      bool    `json:"is_active"`
	Versions      int     `json:"versions"`
	ActiveVersion *int    `json:"active_version,omitempty"`
	// What the live version charges, so the list answers "how much is Class 5"
	// without a second request.
	ActiveTotalPaise int64   `json:"active_total_paise"`
	EffectiveFrom    *string `json:"effective_from,omitempty"`
	DraftVersion     *int    `json:"draft_version,omitempty"`
	// Invoices raised under any version of this structure. The number that
	// makes the "do not edit, revise" rule concrete on screen.
	InvoicesRaised int `json:"invoices_raised"`
}

// listVersionedStructures is the versioning screen's index: every fee
// structure with the state of its version history.
func (s *Server) listVersionedStructures(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT fs.id::text, fs.name, c.name, ay.name, fs.applies_to, fs.is_active,
		       COALESCE(v.n, 0)::int,
		       v.active_no, COALESCE(v.active_total, 0),
		       to_char(v.effective_from, 'YYYY-MM-DD'), v.draft_no,
		       COALESCE(inv.n, 0)::int
		  FROM fee_structures fs
		  LEFT JOIN classes c        ON c.id  = fs.class_id
		  LEFT JOIN academic_years ay ON ay.id = fs.academic_year_id
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS n,
		             max(CASE WHEN sv.status = 'active' THEN sv.version_no END) AS active_no,
		             max(CASE WHEN sv.status = 'draft'  THEN sv.version_no END) AS draft_no,
		             max(CASE WHEN sv.status = 'active' THEN sv.effective_from END) AS effective_from,
		             COALESCE((SELECT sum(i.amount_paise)
		                         FROM fee_structure_version_items i
		                         JOIN fee_structure_versions av ON av.id = i.version_id
		                        WHERE av.fee_structure_id = fs.id AND av.status = 'active'), 0) AS active_total
		        FROM fee_structure_versions sv
		       WHERE sv.fee_structure_id = fs.id
		  ) v ON true
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS n FROM invoices i
		       JOIN fee_structure_versions sv ON sv.id = i.fee_structure_version_id
		       WHERE sv.fee_structure_id = fs.id
		  ) inv ON true
		 ORDER BY fs.is_active DESC, fs.name`, nil,
		func(rows pgx.Rows) (feStructureRow, error) {
			var v feStructureRow
			return v, rows.Scan(&v.ID, &v.Name, &v.ClassName, &v.AcademicYear,
				&v.AppliesTo, &v.IsActive, &v.Versions, &v.ActiveVersion,
				&v.ActiveTotalPaise, &v.EffectiveFrom, &v.DraftVersion, &v.InvoicesRaised)
		})
	respond(w, r, items, err)
}

type feVersionItemRow struct {
	ID           string  `json:"id"`
	FeeHeadID    string  `json:"fee_head_id"`
	FeeHead      string  `json:"fee_head"`
	InstalmentNo int     `json:"instalment_no"`
	AmountPaise  int64   `json:"amount_paise"`
	DueOn        *string `json:"due_on,omitempty"`
	// What the same head cost under the previous version, so the screen can
	// show a revision as a change rather than as a fresh list of numbers.
	PreviousPaise *int64 `json:"previous_paise,omitempty"`
}

type feVersionRow struct {
	ID            string             `json:"id"`
	VersionNo     int                `json:"version_no"`
	Status        string             `json:"status"`
	EffectiveFrom string             `json:"effective_from"`
	EffectiveTo   *string            `json:"effective_to,omitempty"`
	RevisionNote  *string            `json:"revision_note,omitempty"`
	ActivatedAt   *string            `json:"activated_at,omitempty"`
	ActivatedBy   *string            `json:"activated_by,omitempty"`
	TotalPaise    int64              `json:"total_paise"`
	InvoiceCount  int                `json:"invoice_count"`
	Items         []feVersionItemRow `json:"items"`
}

// listStructureVersions is the history of one structure, newest first, each
// version with the lines it froze.
func (s *Server) listStructureVersions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	structureID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "structure id must be a uuid")
		return
	}

	versions := []feVersionRow{}
	var structureName string
	heads := []feHeadOption{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`SELECT name FROM fee_structures WHERE id = $1`, structureID).
			Scan(&structureName); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT v.id::text, v.version_no, v.status,
			       to_char(v.effective_from, 'YYYY-MM-DD'),
			       to_char(v.effective_to, 'YYYY-MM-DD'),
			       v.revision_note,
			       to_char(v.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       u.full_name,
			       COALESCE((SELECT sum(amount_paise) FROM fee_structure_version_items
			                  WHERE version_id = v.id), 0),
			       COALESCE((SELECT count(*) FROM invoices
			                  WHERE fee_structure_version_id = v.id), 0)::int
			  FROM fee_structure_versions v
			  LEFT JOIN users u ON u.id = v.activated_by
			 WHERE v.fee_structure_id = $1
			 ORDER BY v.version_no DESC`, structureID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v feVersionRow
			if err := rows.Scan(&v.ID, &v.VersionNo, &v.Status, &v.EffectiveFrom,
				&v.EffectiveTo, &v.RevisionNote, &v.ActivatedAt, &v.ActivatedBy,
				&v.TotalPaise, &v.InvoiceCount); err != nil {
				return err
			}
			v.Items = []feVersionItemRow{}
			versions = append(versions, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// The lines for every version in one pass, with the preceding
		// version's amount for the same head alongside.
		lines, err := tx.Query(r.Context(), `
			SELECT i.version_id::text, i.id::text, i.fee_head_id::text, h.name,
			       i.instalment_no, i.amount_paise, to_char(i.due_on,'YYYY-MM-DD'),
			       prev.amount_paise
			  FROM fee_structure_version_items i
			  JOIN fee_structure_versions v ON v.id = i.version_id
			  JOIN fee_heads h ON h.id = i.fee_head_id
			  LEFT JOIN LATERAL (
			      SELECT pi.amount_paise
			        FROM fee_structure_version_items pi
			        JOIN fee_structure_versions pv ON pv.id = pi.version_id
			       WHERE pv.fee_structure_id = v.fee_structure_id
			         AND pv.version_no < v.version_no
			         AND pi.fee_head_id = i.fee_head_id
			         AND pi.instalment_no = i.instalment_no
			       ORDER BY pv.version_no DESC LIMIT 1
			  ) prev ON true
			 WHERE v.fee_structure_id = $1
			 ORDER BY i.instalment_no, h.name`, structureID)
		if err != nil {
			return err
		}
		defer lines.Close()
		byVersion := map[string][]feVersionItemRow{}
		for lines.Next() {
			var vid string
			var it feVersionItemRow
			if err := lines.Scan(&vid, &it.ID, &it.FeeHeadID, &it.FeeHead,
				&it.InstalmentNo, &it.AmountPaise, &it.DueOn, &it.PreviousPaise); err != nil {
				return err
			}
			byVersion[vid] = append(byVersion[vid], it)
		}
		if err := lines.Err(); err != nil {
			return err
		}
		for i := range versions {
			if got, ok := byVersion[versions[i].ID]; ok {
				versions[i].Items = got
			}
		}

		heads, err = loadFeeHeadOptions(r, tx)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"structure": map[string]any{"id": structureID.String(), "name": structureName},
		"items":     versions,
		"heads":     heads,
	})
}

type feHeadOption struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Code      string `json:"code"`
	IsTaxable bool   `json:"is_taxable"`
	GSTRateBP int    `json:"gst_rate_bp"`
	HSNSAC    string `json:"hsn_sac"`
}

func loadFeeHeadOptions(r *http.Request, tx pgx.Tx) ([]feHeadOption, error) {
	out := []feHeadOption{}
	rows, err := tx.Query(r.Context(), `
		SELECT id::text, name, code, is_taxable, gst_rate_bp, COALESCE(hsn_sac,'')
		  FROM fee_heads ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var h feHeadOption
		if err := rows.Scan(&h.ID, &h.Name, &h.Code, &h.IsTaxable, &h.GSTRateBP, &h.HSNSAC); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

type feSaveVersionRequest struct {
	StructureID string `json:"structure_id"`
	// Optional: copy the lines from this version. Omitted, a new version copies
	// the current active one, and failing that the structure's live items —
	// because a revision is nearly always a change to what exists, and starting
	// from a blank sheet invites a version that silently drops a head.
	CopyFromID    string `json:"copy_from_id,omitempty"`
	EffectiveFrom string `json:"effective_from"`
	RevisionNote  string `json:"revision_note,omitempty"`
}

// saveStructureVersion opens a new draft revision.
//
// Always a draft. Activation is a separate, deliberate act because it is what
// changes the amount the next invoice run will bill, and a screen that created
// live versions would make a typo immediately expensive.
func (s *Server) saveStructureVersion(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req feSaveVersionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	structureID, err := uuid.Parse(strings.TrimSpace(req.StructureID))
	if err != nil {
		httpx.BadRequest(w, r, "structure_id must be a uuid")
		return
	}
	effectiveFrom, err := time.Parse(time.DateOnly, strings.TrimSpace(req.EffectiveFrom))
	if err != nil {
		httpx.BadRequest(w, r, "effective_from must be a date, as YYYY-MM-DD")
		return
	}

	var newID uuid.UUID
	var versionNo int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Serialise version numbering for this structure. Two people opening a
		// revision at once would otherwise both compute v2.
		if _, err := tx.Exec(r.Context(),
			`SELECT pg_advisory_xact_lock(hashtext($1))`,
			structureID.String()+"fee_version"); err != nil {
			return err
		}

		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM fee_structures WHERE id = $1`, structureID).Scan(&exists); err != nil {
			return err
		}

		var draftExists bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM fee_structure_versions
			                WHERE fee_structure_id = $1 AND status = 'draft')`,
			structureID).Scan(&draftExists); err != nil {
			return err
		}
		if draftExists {
			// Two open drafts on one structure is two people revising the same
			// fee without knowing about each other.
			return refusal("this structure already has a draft revision open. Finish or discard it first")
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(max(version_no), 0) + 1
			  FROM fee_structure_versions WHERE fee_structure_id = $1`,
			structureID).Scan(&versionNo); err != nil {
			return err
		}

		var supersedes *uuid.UUID
		var active uuid.UUID
		switch err := tx.QueryRow(r.Context(), `
			SELECT id FROM fee_structure_versions
			 WHERE fee_structure_id = $1 AND status = 'active'`, structureID).Scan(&active); {
		case err == nil:
			supersedes = &active
		case errors.Is(err, pgx.ErrNoRows):
		default:
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO fee_structure_versions
			    (institution_id, fee_structure_id, version_no, status, effective_from,
			     revision_note, supersedes_id, created_by)
			VALUES ($1,$2,$3,'draft',$4,NULLIF($5,''),$6,$7)
			RETURNING id`,
			id.InstitutionID, structureID, versionNo, effectiveFrom,
			strings.TrimSpace(req.RevisionNote), supersedes, id.UserID).Scan(&newID); err != nil {
			return err
		}

		// Seed the draft's lines. Explicit source, else the active version,
		// else the structure's live items.
		var copyFrom *uuid.UUID
		if strings.TrimSpace(req.CopyFromID) != "" {
			parsed, err := uuid.Parse(strings.TrimSpace(req.CopyFromID))
			if err != nil {
				return refusal("copy_from_id must be a uuid")
			}
			copyFrom = &parsed
		} else if supersedes != nil {
			copyFrom = supersedes
		}

		if copyFrom != nil {
			_, err := tx.Exec(r.Context(), `
				INSERT INTO fee_structure_version_items
				    (institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on)
				SELECT $1, $2, fee_head_id, instalment_no, amount_paise, due_on
				  FROM fee_structure_version_items WHERE version_id = $3`,
				id.InstitutionID, newID, *copyFrom)
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO fee_structure_version_items
			    (institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on)
			SELECT $1, $2, fee_head_id, instalment_no, amount_paise, due_on
			  FROM fee_structure_items WHERE fee_structure_id = $3`,
			id.InstitutionID, newID, structureID)
		return err
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": newID.String(), "version_no": versionNo, "status": "draft",
	})
}

type feVersionItemInput struct {
	FeeHeadID    string `json:"fee_head_id"`
	InstalmentNo int    `json:"instalment_no"`
	AmountPaise  int64  `json:"amount_paise"`
	DueOn        string `json:"due_on,omitempty"`
}

type feSetItemsRequest struct {
	Items []feVersionItemInput `json:"items"`
}

// setStructureVersionItems replaces a draft's lines.
//
// Drafts only, and that refusal is the point of the whole feature: an active or
// superseded version is what an invoice cites, and editing it would restate a
// claim already made to a parent.
func (s *Server) setStructureVersionItems(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	versionID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "version id must be a uuid")
		return
	}
	var req feSetItemsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	for i, it := range req.Items {
		if it.AmountPaise < 0 {
			httpx.BadRequest(w, r, fmt.Sprintf("line %d: an amount cannot be negative", i+1))
			return
		}
		if _, err := uuid.Parse(strings.TrimSpace(it.FeeHeadID)); err != nil {
			httpx.BadRequest(w, r, fmt.Sprintf("line %d: fee_head_id must be a uuid", i+1))
			return
		}
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM fee_structure_versions WHERE id = $1 FOR UPDATE`,
			versionID).Scan(&status); err != nil {
			return err
		}
		if status != "draft" {
			return refusef("this version is %s. An invoice may already have been raised under it. Open a new revision instead.", status)
		}

		if _, err := tx.Exec(r.Context(),
			`DELETE FROM fee_structure_version_items WHERE version_id = $1`, versionID); err != nil {
			return err
		}
		for _, it := range req.Items {
			instalment := it.InstalmentNo
			if instalment <= 0 {
				instalment = 1
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO fee_structure_version_items
				    (institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on)
				VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::date)`,
				id.InstitutionID, versionID, it.FeeHeadID, instalment,
				it.AmountPaise, strings.TrimSpace(it.DueOn)); err != nil {
				return err
			}
		}
		_, err := tx.Exec(r.Context(),
			`UPDATE fee_structure_versions SET updated_at = now() WHERE id = $1`, versionID)
		return err
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": versionID.String(), "lines": len(req.Items)})
}

// activateStructureVersion makes a draft the version new invoices cite.
//
// The outgoing active version becomes superseded and keeps its effective_to,
// rather than being deleted: every invoice raised under it still points at it,
// and the ON DELETE RESTRICT on invoices.fee_structure_version_id would refuse
// the deletion anyway. Both changes happen in one transaction so the
// one-active index is never transiently violated.
func (s *Server) activateStructureVersion(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	versionID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "version id must be a uuid")
		return
	}

	var structureID uuid.UUID
	var versionNo int
	var superseded int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var effectiveFrom time.Time
		if err := tx.QueryRow(r.Context(), `
			SELECT fee_structure_id, version_no, status, effective_from
			  FROM fee_structure_versions WHERE id = $1 FOR UPDATE`, versionID).
			Scan(&structureID, &versionNo, &status, &effectiveFrom); err != nil {
			return err
		}
		if status == "active" {
			return refusal("this version is already the active one")
		}
		if status != "draft" {
			return refusal("only a draft revision can be activated")
		}

		var lines int
		if err := tx.QueryRow(r.Context(),
			`SELECT count(*)::int FROM fee_structure_version_items WHERE version_id = $1`,
			versionID).Scan(&lines); err != nil {
			return err
		}
		if lines == 0 {
			// An empty active version bills nothing and looks like a
			// configuration that worked.
			return refusal("this revision has no fee lines. It would bill nothing")
		}

		// Close the outgoing version the day before this one starts, so the two
		// windows meet without overlapping.
		tag, err := tx.Exec(r.Context(), `
			UPDATE fee_structure_versions
			   SET status = 'superseded',
			       effective_to = LEAST(COALESCE(effective_to, $3::date - 1), $3::date - 1),
			       updated_at = now()
			 WHERE fee_structure_id = $1 AND status = 'active' AND id <> $2`,
			structureID, versionID, effectiveFrom)
		if err != nil {
			return err
		}
		superseded = int(tag.RowsAffected())

		_, err = tx.Exec(r.Context(), `
			UPDATE fee_structure_versions
			   SET status = 'active', activated_at = now(), activated_by = $2,
			       effective_to = NULL, updated_at = now()
			 WHERE id = $1`, versionID, id.UserID)
		return err
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": versionID.String(), "version_no": versionNo, "superseded": superseded,
	})
}

// discardStructureVersion removes a draft that was never activated.
//
// Drafts only. A version that has been live is history whether or not anything
// was billed under it, and the foreign key would refuse it if anything was.
func (s *Server) discardStructureVersion(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	versionID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "version id must be a uuid")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM fee_structure_versions WHERE id = $1 AND status = 'draft'`, versionID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return refusal("only a draft revision can be discarded. An activated version is part of the record")
		}
		return nil
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ===================================================================
// Late fine rules engine
// ===================================================================

type feRuleRow struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	CampusID    *string `json:"campus_id,omitempty"`
	Campus      *string `json:"campus,omitempty"`
	StructureID *string `json:"fee_structure_id,omitempty"`
	Structure   *string `json:"fee_structure,omitempty"`
	FeeHeadID   *string `json:"fee_head_id,omitempty"`
	FeeHead     *string `json:"fee_head,omitempty"`

	Kind        string   `json:"kind"`
	GraceDays   int      `json:"grace_days"`
	AmountPaise int64    `json:"amount_paise"`
	Percent     *string  `json:"percent,omitempty"`
	CapPaise    *int64   `json:"cap_paise,omitempty"`
	Compound    string   `json:"compound_period"`
	ExemptKinds []string `json:"exempt_concession_kinds"`
	Priority    int      `json:"priority"`
	IsActive    bool     `json:"is_active"`
	// Which invoice the charge lands on. See migration 00170.
	ApplyMode string `json:"apply_mode"`
}

// listFineRules returns the rules and everything the editor needs to build one.
func (s *Server) listFineRules(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items := []feRuleRow{}
	heads := []feHeadOption{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT fr.id::text, fr.name,
			       fr.campus_id::text, c.name,
			       fr.fee_structure_id::text, fs.name,
			       fr.fee_head_id::text, h.name,
			       fr.kind, fr.grace_days, fr.amount_paise, fr.percent::text,
			       fr.cap_paise, fr.compound_period, fr.exempt_concession_kinds,
			       fr.apply_mode,
			       fr.priority, fr.is_active
			  FROM fee_fine_rules fr
			  LEFT JOIN campuses c        ON c.id  = fr.campus_id
			  LEFT JOIN fee_structures fs ON fs.id = fr.fee_structure_id
			  LEFT JOIN fee_heads h       ON h.id  = fr.fee_head_id
			 ORDER BY fr.is_active DESC, fr.priority, fr.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v feRuleRow
			if err := rows.Scan(&v.ID, &v.Name, &v.CampusID, &v.Campus,
				&v.StructureID, &v.Structure, &v.FeeHeadID, &v.FeeHead,
				&v.Kind, &v.GraceDays, &v.AmountPaise, &v.Percent, &v.CapPaise,
				&v.Compound, &v.ExemptKinds, &v.ApplyMode, &v.Priority,
				&v.IsActive); err != nil {
				return err
			}
			if v.ExemptKinds == nil {
				v.ExemptKinds = []string{}
			}
			items = append(items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		heads, err = loadFeeHeadOptions(r, tx)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":            items,
		"heads":            heads,
		"kinds":            []string{"fixed", "per_day", "percent"},
		"compound_periods": []string{"none", "weekly", "monthly"},
		"concession_kinds": []string{"scholarship", "sibling", "staff_ward", "rte", "merit", "other"},
	})
}

type feSaveRuleRequest struct {
	ID          string   `json:"id,omitempty"`
	Name        string   `json:"name"`
	CampusID    string   `json:"campus_id,omitempty"`
	StructureID string   `json:"fee_structure_id,omitempty"`
	FeeHeadID   string   `json:"fee_head_id,omitempty"`
	Kind        string   `json:"kind"`
	GraceDays   int      `json:"grace_days"`
	AmountPaise int64    `json:"amount_paise"`
	Percent     float64  `json:"percent,omitempty"`
	CapPaise    *int64   `json:"cap_paise,omitempty"`
	Compound    string   `json:"compound_period,omitempty"`
	ExemptKinds []string `json:"exempt_concession_kinds,omitempty"`
	Priority    int      `json:"priority,omitempty"`
	IsActive    *bool    `json:"is_active,omitempty"`
	/* per_invoice | final_term — when the charge is raised, not how much.

	   Blank means per_invoice, so a rule saved by an older screen keeps
	   charging each term as it falls due, which is what it did before. */
	ApplyMode string `json:"apply_mode,omitempty"`
}

func (s *Server) saveFineRule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req feSaveRuleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Compound == "" {
		req.Compound = "none"
	}
	if req.Priority == 0 {
		req.Priority = 100
	}
	if req.ExemptKinds == nil {
		req.ExemptKinds = []string{}
	}

	switch {
	case req.Name == "":
		httpx.BadRequest(w, r, "a rule needs a name. It is how the school finds it again")
		return
	case req.Kind != "fixed" && req.Kind != "per_day" && req.Kind != "percent":
		httpx.BadRequest(w, r, "kind must be fixed, per_day or percent")
		return
	case req.GraceDays < 0:
		httpx.BadRequest(w, r, "a grace period cannot be negative")
		return
	case req.Kind == "percent" && (req.Percent <= 0 || req.Percent > 100):
		httpx.BadRequest(w, r, "a percentage rule needs a percent between 0 and 100")
		return
	case req.Kind != "percent" && req.AmountPaise <= 0:
		httpx.BadRequest(w, r, "a fixed or per-day rule needs an amount above zero")
		return
	case req.Compound != "none" && req.Compound != "weekly" && req.Compound != "monthly":
		httpx.BadRequest(w, r, "compounding must be none, weekly or monthly")
		return
	case req.Kind == "per_day" && req.Compound != "none":
		// The DB refuses this too; saying so here gives the form a sentence
		// rather than a constraint name.
		httpx.BadRequest(w, r, "a per-day rule already grows with time. Compounding it as well would charge the same days twice")
		return
	case req.CapPaise != nil && *req.CapPaise < 0:
		httpx.BadRequest(w, r, "a cap cannot be negative")
		return
	}

	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	var percent *float64
	if req.Kind == "percent" {
		percent = &req.Percent
	}

	var ruleID uuid.UUID
	if req.ID != "" {
		parsed, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "malformed rule id")
			return
		}
		ruleID = parsed
	}

	/* Blank means the old behaviour, so a rule saved by any screen that does
	   not know about this keeps charging each term as it falls due. */
	applyMode := strings.TrimSpace(req.ApplyMode)
	if applyMode == "" {
		applyMode = "per_invoice"
	}
	if applyMode != "per_invoice" && applyMode != "final_term" {
		httpx.BadRequest(w, r,
			"apply_mode must be per_invoice or final_term")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if ruleID != uuid.Nil {
			tag, err := tx.Exec(r.Context(), `
				UPDATE fee_fine_rules
				   SET name = $3, campus_id = NULLIF($4,'')::uuid,
				       fee_structure_id = NULLIF($5,'')::uuid,
				       fee_head_id = NULLIF($6,'')::uuid,
				       kind = $7, grace_days = $8, amount_paise = $9, percent = $10,
				       cap_paise = $11, compound_period = $12,
				       exempt_concession_kinds = $13, priority = $14, is_active = $15,
				       apply_mode = $16, updated_at = now()
				 WHERE id = $1 AND institution_id = $2`,
				ruleID, id.InstitutionID, req.Name, strings.TrimSpace(req.CampusID),
				strings.TrimSpace(req.StructureID), strings.TrimSpace(req.FeeHeadID),
				req.Kind, req.GraceDays, req.AmountPaise, percent, req.CapPaise,
				req.Compound, req.ExemptKinds, req.Priority, active, applyMode)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return pgx.ErrNoRows
			}
			return nil
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO fee_fine_rules
			    (institution_id, name, campus_id, fee_structure_id, fee_head_id,
			     kind, grace_days, amount_paise, percent, cap_paise,
			     compound_period, exempt_concession_kinds, priority, is_active,
			     apply_mode)
			VALUES ($1,$2,NULLIF($3,'')::uuid,NULLIF($4,'')::uuid,NULLIF($5,'')::uuid,
			        $6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
			RETURNING id`,
			id.InstitutionID, req.Name, strings.TrimSpace(req.CampusID),
			strings.TrimSpace(req.StructureID), strings.TrimSpace(req.FeeHeadID),
			req.Kind, req.GraceDays, req.AmountPaise, percent, req.CapPaise,
			req.Compound, req.ExemptKinds, req.Priority, active).Scan(&ruleID)
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": ruleID.String()})
}

func (s *Server) deleteFineRule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ruleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "rule id must be a uuid")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM fee_fine_rules WHERE id = $1 AND institution_id = $2`,
			ruleID, id.InstitutionID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

/*
loadFineSubjects gathers the facts the engine needs about every open due.

	Split out because preview and apply must see exactly the same inputs. If
	apply re-derived them from a slightly different query, the number a school
	approved on screen would not be the number that landed on the invoice, and
	nobody would be able to say which was right.

	Scope is applied here, not in the caller: a parent reaching a fee endpoint
	must see their own child's dues and nobody else's, and RLS will not do it —
	another student in the same school is a row from the caller's own tenant.
*/
func (s *Server) loadFineSubjects(r *http.Request, tx pgx.Tx, asOf time.Time,
	onlyInvoices []uuid.UUID) ([]fees.FineSubject, map[feChargeKey]int64, error) {

	res, err := s.resolveScope(r)
	if err != nil {
		return nil, nil, err
	}
	args := []any{asOf, onlyInvoices}
	scopePred, scopeArgs := res.StudentPredicate("st", len(args)+1)
	args = append(args, scopeArgs...)

	rows, err := tx.Query(r.Context(), `
		SELECT i.id, i.invoice_no, i.student_id,
		       btrim(st.first_name || ' ' || COALESCE(st.last_name, '')),
		       i.campus_id, v.fee_structure_id, i.fee_structure_version_id,
		       CASE WHEN v.id IS NULL THEN ''
		            ELSE COALESCE(fs.name,'') || ' v' || v.version_no END,
		       i.due_on, i.net_paise - i.paid_paise
		  FROM invoices i
		  JOIN students st ON st.id = i.student_id
		  LEFT JOIN fee_structure_versions v ON v.id = i.fee_structure_version_id
		  LEFT JOIN fee_structures fs        ON fs.id = v.fee_structure_id
		 WHERE i.status IN ('unpaid','partial','overdue')
		   AND i.net_paise > i.paid_paise
		   AND i.due_on IS NOT NULL
		   AND i.due_on < $1::date
		   AND ($2::uuid[] IS NULL OR i.id = ANY($2::uuid[]))
		   AND `+scopePred+`
		 ORDER BY i.due_on, i.invoice_no`, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var subjects []fees.FineSubject
	var versionIDs []uuid.UUID
	var studentIDs []uuid.UUID
	var invoiceIDs []uuid.UUID
	for rows.Next() {
		var s fees.FineSubject
		var due *time.Time
		if err := rows.Scan(&s.InvoiceID, &s.InvoiceNo, &s.StudentID, &s.StudentName,
			&s.CampusID, &s.StructureID, &s.VersionID, &s.VersionLabel,
			&due, &s.BalancePaise); err != nil {
			return nil, nil, err
		}
		s.DueOn = due
		s.HeadAmounts = map[uuid.UUID]int64{}
		subjects = append(subjects, s)
		if s.VersionID != nil {
			versionIDs = append(versionIDs, *s.VersionID)
		}
		studentIDs = append(studentIDs, s.StudentID)
		invoiceIDs = append(invoiceIDs, s.InvoiceID)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if len(subjects) == 0 {
		return subjects, map[feChargeKey]int64{}, nil
	}

	/* The head amounts, read from the version each invoice was raised under.

	   This is the join that makes versioning a prerequisite. Reading
	   fee_structure_items instead would price the fine off whatever the
	   structure says today, so a September fee revision would silently
	   increase the fine on an April invoice. */
	headAmounts := map[uuid.UUID]map[uuid.UUID]int64{}
	if len(versionIDs) > 0 {
		hrows, err := tx.Query(r.Context(), `
			SELECT version_id, fee_head_id, sum(amount_paise)
			  FROM fee_structure_version_items
			 WHERE version_id = ANY($1)
			 GROUP BY version_id, fee_head_id`, versionIDs)
		if err != nil {
			return nil, nil, err
		}
		defer hrows.Close()
		for hrows.Next() {
			var vid, hid uuid.UUID
			var amount int64
			if err := hrows.Scan(&vid, &hid, &amount); err != nil {
				return nil, nil, err
			}
			if headAmounts[vid] == nil {
				headAmounts[vid] = map[uuid.UUID]int64{}
			}
			headAmounts[vid][hid] = amount
		}
		if err := hrows.Err(); err != nil {
			return nil, nil, err
		}
	}

	// Approved concessions only. A concession awaiting sign-off has not yet
	// excused anybody from anything.
	concessions := map[uuid.UUID][]string{}
	crows, err := tx.Query(r.Context(), `
		SELECT DISTINCT student_id, kind FROM fee_concessions
		 WHERE student_id = ANY($1) AND approved_at IS NOT NULL`, studentIDs)
	if err != nil {
		return nil, nil, err
	}
	defer crows.Close()
	for crows.Next() {
		var sid uuid.UUID
		var kind string
		if err := crows.Scan(&sid, &kind); err != nil {
			return nil, nil, err
		}
		concessions[sid] = append(concessions[sid], kind)
	}
	if err := crows.Err(); err != nil {
		return nil, nil, err
	}

	// What has already been charged, per invoice per rule, so a second run
	// tops up rather than charging the whole accrual again.
	already := map[feChargeKey]int64{}
	arows, err := tx.Query(r.Context(), `
		SELECT invoice_id, COALESCE(fee_fine_rule_id::text, $2), sum(amount_paise)
		  FROM fee_fine_charges
		 WHERE invoice_id = ANY($1) AND status = 'applied'
		 GROUP BY invoice_id, fee_fine_rule_id`, invoiceIDs, zeroUUIDText)
	if err != nil {
		return nil, nil, err
	}
	defer arows.Close()
	for arows.Next() {
		var inv uuid.UUID
		var rule string
		var amount int64
		if err := arows.Scan(&inv, &rule, &amount); err != nil {
			return nil, nil, err
		}
		already[feChargeKey{inv, rule}] = amount
	}
	if err := arows.Err(); err != nil {
		return nil, nil, err
	}

	for i := range subjects {
		if subjects[i].VersionID != nil {
			if m, ok := headAmounts[*subjects[i].VersionID]; ok {
				subjects[i].HeadAmounts = m
			}
		}
		subjects[i].ConcessionKinds = concessions[subjects[i].StudentID]
	}
	// AlreadyFinedPaise depends on which rule wins, which the engine decides,
	// so it is attached by assessDues once the rules are known.
	return subjects, already, nil
}

// feChargeKey identifies what one rule has already charged one invoice.
//
// Returned from loadFineSubjects rather than held anywhere shared: two cashiers
// previewing at the same moment are two goroutines in this process, and a
// package-level map would let one request's totals leak into the other's fines.
type feChargeKey struct {
	invoice uuid.UUID
	rule    string
}

func (s *Server) loadFineRuleSet(r *http.Request, tx pgx.Tx, onlyRule *uuid.UUID) ([]fees.FineRule, error) {
	rows, err := tx.Query(r.Context(), `
		SELECT id, name, campus_id, fee_structure_id, fee_head_id, kind,
		       grace_days, amount_paise, COALESCE(percent, 0)::float8, cap_paise,
		       compound_period, exempt_concession_kinds, priority, apply_mode
		  FROM fee_fine_rules
		 WHERE is_active AND ($1::uuid IS NULL OR id = $1)`, onlyRule)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fees.FineRule
	for rows.Next() {
		var v fees.FineRule
		if err := rows.Scan(&v.ID, &v.Name, &v.CampusID, &v.StructureID, &v.FeeHeadID,
			&v.Kind, &v.GraceDays, &v.AmountPaise, &v.Percent, &v.CapPaise,
			&v.Compound, &v.ExemptKinds, &v.Priority, &v.ApplyMode); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// assessDues is the shared preview/apply path: gather, evaluate, and tell each
// assessment what has already been charged under the rule that won.
func (s *Server) assessDues(r *http.Request, tx pgx.Tx, asOf time.Time,
	onlyRule *uuid.UUID, onlyInvoices []uuid.UUID) ([]fees.FineAssessment, error) {

	subjects, already, err := s.loadFineSubjects(r, tx, asOf, onlyInvoices)
	if err != nil {
		return nil, err
	}
	rules, err := s.loadFineRuleSet(r, tx, onlyRule)
	if err != nil {
		return nil, err
	}

	// Two passes: the first works out which rule governs each due, the second
	// re-runs it knowing what that rule has already charged.
	for i := range subjects {
		if rule, ok := fees.BestRuleFor(subjects[i], rules); ok {
			subjects[i].AlreadyFinedPaise = already[feChargeKey{subjects[i].InvoiceID, rule.ID.String()}]
		}
	}
	return fees.EvaluateFines(subjects, rules, asOf), nil
}

/*
previewFines shows what a fine run would do, and changes nothing.

	Deliberately the only automatic half of this feature. There is no timer, no
	sweep and no scheduled job that charges a fine: a parent who finds an extra
	₹1,750 on their account overnight will ask who decided that, and "the
	system" is not an answer a school can give. A human previews, reads the
	working, and applies.
*/
func (s *Server) previewFines(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	asOf, err := parseDate(r.URL.Query().Get("as_of"), nowInIndia())
	if err != nil {
		httpx.BadRequest(w, r, "as_of must be a date, as YYYY-MM-DD")
		return
	}

	var onlyRule *uuid.UUID
	if v := strings.TrimSpace(r.URL.Query().Get("rule_id")); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "rule_id must be a uuid")
			return
		}
		onlyRule = &parsed
	}

	var out []fees.FineAssessment
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		out, err = s.assessDues(r, tx, asOf, onlyRule, nil)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var chargeable, totalPaise, exempt int64
	for _, a := range out {
		switch {
		case a.Exempt:
			exempt++
		case a.DeltaPaise > 0:
			chargeable++
			totalPaise += a.DeltaPaise
		}
	}
	if out == nil {
		out = []fees.FineAssessment{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":       out,
		"as_of":       asOf.Format(time.DateOnly),
		"assessed":    len(out),
		"chargeable":  chargeable,
		"exempt":      exempt,
		"total_paise": totalPaise,
	})
}

type feApplyFinesRequest struct {
	AsOf string `json:"as_of,omitempty"`
	// The invoices to charge. Required: applying to everything the preview
	// showed, without naming them, is how a mis-set rule fines a whole school.
	InvoiceIDs []string `json:"invoice_ids"`
	RuleID     string   `json:"rule_id,omitempty"`
}

/*
applyFines raises the fines a human has approved.

	The amounts are recomputed here rather than taken from the request. A client
	that posted its own figures would be deciding what a parent owes, and the
	preview the operator read is only evidence of intent, not of arithmetic.

	Idempotent by construction: fee_fine_charges_once_per_day means a second
	click on the same day inserts nothing, and DeltaPaise means a run a month
	later adds the month's growth rather than the whole accrual again.
*/
func (s *Server) applyFines(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req feApplyFinesRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.InvoiceIDs) == 0 {
		httpx.BadRequest(w, r, "name the invoices to fine. Applying to everything at once is not offered")
		return
	}
	asOf, err := parseDate(req.AsOf, nowInIndia())
	if err != nil {
		httpx.BadRequest(w, r, "as_of must be a date, as YYYY-MM-DD")
		return
	}

	invoiceIDs := make([]uuid.UUID, 0, len(req.InvoiceIDs))
	for _, v := range req.InvoiceIDs {
		parsed, err := uuid.Parse(strings.TrimSpace(v))
		if err != nil {
			httpx.BadRequest(w, r, "invoice_ids must all be uuids")
			return
		}
		invoiceIDs = append(invoiceIDs, parsed)
	}
	var onlyRule *uuid.UUID
	if strings.TrimSpace(req.RuleID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(req.RuleID))
		if err != nil {
			httpx.BadRequest(w, r, "rule_id must be a uuid")
			return
		}
		onlyRule = &parsed
	}

	var applied, skipped int
	var totalPaise int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		out, err := s.assessDues(r, tx, asOf, onlyRule, invoiceIDs)
		if err != nil {
			return err
		}
		/* Which invoice each rule's charges land on.

		   Read once rather than per assessment: a run over four hundred
		   invoices would otherwise ask the same question four hundred times,
		   and the answer cannot change inside one transaction. */
		finalTerm := map[string]bool{}
		{
			rules, err := s.loadFineRuleSet(r, tx, onlyRule)
			if err != nil {
				return err
			}
			for _, ru := range rules {
				if ru.ApplyMode == "final_term" {
					finalTerm[ru.ID.String()] = true
				}
			}
		}

		for _, a := range out {
			if a.DeltaPaise <= 0 || a.RuleID == nil {
				skipped++
				continue
			}
			working, err := fineWorking(a)
			if err != nil {
				return err
			}

			/* A rule that charges at the final term puts the money on the
			   student's last instalment of the year instead of the late one.

			   The charge row still records the invoice that WAS late — days
			   overdue, the basis, the working all belong to that term — so the
			   audit trail says what happened. Only the money moves. */
			chargeOn := a.InvoiceID
			if finalTerm[a.RuleID.String()] {
				var last uuid.UUID
				err := tx.QueryRow(r.Context(), `
					SELECT i2.id FROM invoices i2
					  JOIN invoices i1 ON i1.id = $1
					 WHERE i2.student_id = i1.student_id
					   AND i2.academic_year_id IS NOT DISTINCT FROM i1.academic_year_id
					   AND i2.status <> 'cancelled'
					 ORDER BY i2.due_on DESC NULLS LAST, i2.invoice_no DESC
					 LIMIT 1`, a.InvoiceID).Scan(&last)
				if err == nil && last != uuid.Nil {
					chargeOn = last
				}
				// A student with only the one invoice is their own final term,
				// which is what the fallback leaves in place.
			}
			tag, err := tx.Exec(r.Context(), `
				INSERT INTO fee_fine_charges
				    (institution_id, invoice_id, fee_fine_rule_id, rule_name, fee_head_id,
				     fee_structure_version_id, as_of, days_overdue, basis_paise,
				     amount_paise, was_capped, periods, working, applied_by)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
				ON CONFLICT DO NOTHING`,
				id.InstitutionID, a.InvoiceID, a.RuleID, a.RuleName, a.FeeHeadID,
				a.VersionID, asOf, a.DaysOverdue, a.BasisPaise,
				a.DeltaPaise, a.WasCapped, a.Periods, working, id.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				// Already charged today. The unique index is what makes a
				// double click harmless.
				skipped++
				continue
			}
			if _, err := tx.Exec(r.Context(),
				`UPDATE invoices SET fine_paise = fine_paise + $2, updated_at = now()
				  WHERE id = $1`, chargeOn, a.DeltaPaise); err != nil {
				return err
			}
			applied++
			totalPaise += a.DeltaPaise
		}
		return nil
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"applied": applied, "skipped": skipped, "total_paise": totalPaise,
		"as_of": asOf.Format(time.DateOnly),
	})
}

// fineWorking renders the assessment's arithmetic for the charge row, so a
// disputed fine is answered by reading rather than by recomputing against
// inputs that have since moved.
func fineWorking(a fees.FineAssessment) ([]byte, error) {
	return jsonBytes(map[string]any{
		"reason":       a.Reason,
		"days_overdue": a.DaysOverdue,
		"basis_paise":  a.BasisPaise,
		"total_paise":  a.AmountPaise,
		"delta_paise":  a.DeltaPaise,
		"periods":      a.Periods,
		"was_capped":   a.WasCapped,
		"steps":        a.Steps,
		"version":      a.VersionLabel,
	})
}

type feChargeRow struct {
	ID          string  `json:"id"`
	InvoiceNo   string  `json:"invoice_no"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	RuleName    string  `json:"rule_name"`
	FeeHead     *string `json:"fee_head,omitempty"`
	Version     *string `json:"version,omitempty"`
	AsOf        string  `json:"as_of"`
	DaysOverdue int     `json:"days_overdue"`
	BasisPaise  int64   `json:"basis_paise"`
	AmountPaise int64   `json:"amount_paise"`
	WasCapped   bool    `json:"was_capped"`
	Status      string  `json:"status"`
	WaivedFor   *string `json:"waived_reason,omitempty"`
	AppliedAt   string  `json:"applied_at"`
	AppliedBy   *string `json:"applied_by,omitempty"`
}

// listFineCharges is the register of fines actually raised — the answer to
// "why is there ₹1,750 on this account".
func (s *Server) listFineCharges(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT fc.id::text, i.invoice_no,
		       btrim(st.first_name || ' ' || COALESCE(st.last_name,'')), st.admission_no,
		       fc.rule_name, h.name,
		       CASE WHEN v.id IS NULL THEN NULL
		            ELSE COALESCE(fs.name,'') || ' v' || v.version_no END,
		       to_char(fc.as_of,'YYYY-MM-DD'), fc.days_overdue, fc.basis_paise,
		       fc.amount_paise, fc.was_capped, fc.status, fc.waived_reason,
		       to_char(fc.applied_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', u.full_name
		  FROM fee_fine_charges fc
		  JOIN invoices i  ON i.id  = fc.invoice_id
		  JOIN students st ON st.id = i.student_id
		  LEFT JOIN fee_heads h ON h.id = fc.fee_head_id
		  LEFT JOIN fee_structure_versions v ON v.id = fc.fee_structure_version_id
		  LEFT JOIN fee_structures fs ON fs.id = v.fee_structure_id
		  LEFT JOIN users u ON u.id = fc.applied_by
		 ORDER BY fc.applied_at DESC
		 LIMIT 500`, nil,
		func(rows pgx.Rows) (feChargeRow, error) {
			var v feChargeRow
			return v, rows.Scan(&v.ID, &v.InvoiceNo, &v.StudentName, &v.AdmissionNo,
				&v.RuleName, &v.FeeHead, &v.Version, &v.AsOf, &v.DaysOverdue,
				&v.BasisPaise, &v.AmountPaise, &v.WasCapped, &v.Status,
				&v.WaivedFor, &v.AppliedAt, &v.AppliedBy)
		})
	respond(w, r, items, err)
}

type feWaiveRequest struct {
	Reason string `json:"reason"`
}

// waiveFineCharge reverses a fine and takes the money back off the invoice.
//
// A reason is required, and the constraint enforces it: an unexplained reversal
// of a charge a parent was told about is exactly what an audit asks about.
func (s *Server) waiveFineCharge(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	chargeID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "charge id must be a uuid")
		return
	}
	var req feWaiveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if req.Reason == "" {
		httpx.BadRequest(w, r, "a waiver needs a reason. It reverses money a parent was told they owed")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var invoiceID uuid.UUID
		var amount int64
		if err := tx.QueryRow(r.Context(), `
			UPDATE fee_fine_charges
			   SET status = 'waived', waived_reason = $2
			 WHERE id = $1 AND status = 'applied'
			RETURNING invoice_id, amount_paise`, chargeID, req.Reason).
			Scan(&invoiceID, &amount); err != nil {
			return err
		}
		// GREATEST guards the CHECK (fine_paise >= 0): a fine reduced by hand
		// elsewhere would otherwise make this subtraction negative.
		_, err := tx.Exec(r.Context(), `
			UPDATE invoices SET fine_paise = GREATEST(fine_paise - $2, 0), updated_at = now()
			 WHERE id = $1`, invoiceID, amount)
		return err
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": chargeID.String(), "status": "waived"})
}

// ===================================================================
// GST compliant receipt numbering
// ===================================================================

type feSeriesRow struct {
	Kind        string  `json:"kind"`
	Prefix      string  `json:"prefix"`
	Suffix      string  `json:"suffix"`
	Padding     int     `json:"padding"`
	NextValue   int64   `json:"next_value"`
	ResetYearly bool    `json:"reset_yearly"`
	CurrentFY   *string `json:"current_fy,omitempty"`
	Format      string  `json:"format"`
	LastNumber  *string `json:"last_number,omitempty"`
	LastIssued  *string `json:"last_issued_at,omitempty"`
	// What the next number will look like, rendered from the live settings so
	// the school can see the shape before committing to it.
	NextPreview string `json:"next_preview"`
}

type feSeriesYearRow struct {
	FY       string `json:"fy"`
	Issued   int    `json:"issued"`
	FirstSeq int64  `json:"first_seq"`
	LastSeq  int64  `json:"last_seq"`
	// last - first + 1 - issued. Anything above zero is a hole an auditor will
	// ask about.
	Gaps int64 `json:"gaps"`
}

// getReceiptSeries is the compliance screen: the counters, what each year has
// issued, and whether the series has holes.
func (s *Server) getReceiptSeries(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	series := []feSeriesRow{}
	years := []feSeriesYearRow{}
	heads := []feHeadOption{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT kind, prefix, suffix, padding, next_value, reset_yearly,
			       current_fy, format, last_number,
			       to_char(last_issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM numbering_schemes
			 WHERE campus_id IS NULL
			 ORDER BY kind`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v feSeriesRow
			if err := rows.Scan(&v.Kind, &v.Prefix, &v.Suffix, &v.Padding, &v.NextValue,
				&v.ResetYearly, &v.CurrentFY, &v.Format, &v.LastNumber, &v.LastIssued); err != nil {
				return err
			}
			series = append(series, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		yrows, err := tx.Query(r.Context(), `
			SELECT COALESCE(receipt_fy, '—'), count(*)::int,
			       min(receipt_seq), max(receipt_seq),
			       max(receipt_seq) - min(receipt_seq) + 1 - count(*)
			  FROM payments
			 WHERE receipt_seq IS NOT NULL
			 GROUP BY receipt_fy
			 ORDER BY 1 DESC`)
		if err != nil {
			return err
		}
		defer yrows.Close()
		for yrows.Next() {
			var v feSeriesYearRow
			if err := yrows.Scan(&v.FY, &v.Issued, &v.FirstSeq, &v.LastSeq, &v.Gaps); err != nil {
				return err
			}
			years = append(years, v)
		}
		if err := yrows.Err(); err != nil {
			return err
		}

		heads, err = loadFeeHeadOptions(r, tx)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	fy := fyLabel(currentFY())
	for i := range series {
		useFY := ""
		if series[i].ResetYearly {
			useFY = fy
			// A counter about to roll into a new year restarts at 1, and the
			// preview must say so rather than showing a number that will never
			// be issued.
			if series[i].CurrentFY != nil && *series[i].CurrentFY != "" && *series[i].CurrentFY != fy {
				series[i].NextValue = 1
			}
		}
		series[i].NextPreview = feRenderPreview(series[i], useFY)
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":      series,
		"years":      years,
		"heads":      heads,
		"current_fy": fy,
	})
}

// feRenderPreview mirrors fees.renderNumber for display. Kept here rather than
// exported from internal/fees because it renders a hypothetical: the real one
// draws a number and must only ever run under the row lock.
func feRenderPreview(v feSeriesRow, fy string) string {
	format := v.Format
	if format == "" {
		format = "{prefix}{fy}/{seq}{suffix}"
	}
	if fy == "" {
		for _, dangling := range []string{"{fy}/", "{fy}-", "/{fy}", "-{fy}"} {
			format = strings.ReplaceAll(format, dangling, "")
		}
	}
	return strings.NewReplacer(
		"{prefix}", v.Prefix,
		"{fy}", fy,
		"{seq}", fmt.Sprintf("%0*d", v.Padding, v.NextValue),
		"{suffix}", v.Suffix,
	).Replace(format)
}

type feSaveSeriesRequest struct {
	Prefix      string `json:"prefix"`
	Suffix      string `json:"suffix,omitempty"`
	Padding     int    `json:"padding"`
	Format      string `json:"format,omitempty"`
	ResetYearly *bool  `json:"reset_yearly,omitempty"`
}

/*
saveReceiptSeries configures the shape of a series, and never its position.

	next_value is deliberately not settable. Moving the counter backwards
	reissues numbers already printed and handed over; moving it forwards leaves
	a hole an auditor reads as a suppressed receipt. Either way the school has
	broken the one property the series exists to have, so the endpoint does not
	offer it — the platform back office can still repair a counter, which is
	where that decision belongs.
*/
func (s *Server) saveReceiptSeries(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	kind := strings.TrimSpace(chiURLParam(r, "kind"))
	if kind == "" {
		httpx.BadRequest(w, r, "which series?")
		return
	}
	var req feSaveSeriesRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Padding <= 0 {
		req.Padding = 5
	}
	if req.Padding > 12 {
		httpx.BadRequest(w, r, "padding above 12 digits is not a receipt number anybody reads")
		return
	}
	format := strings.TrimSpace(req.Format)
	if format == "" {
		format = "{prefix}{fy}/{seq}{suffix}"
	}
	if !strings.Contains(format, "{seq}") {
		httpx.BadRequest(w, r, "the format must contain {seq}, or every receipt in the year renders identically")
		return
	}
	reset := true
	if req.ResetYearly != nil {
		reset = *req.ResetYearly
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Upsert: an institution that has never issued this kind has no row
		// yet, and the allocator would create one with defaults on first use.
		_, err := tx.Exec(r.Context(), `
			INSERT INTO numbering_schemes
			    (institution_id, kind, prefix, suffix, padding, format, reset_yearly,
			     next_value, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,1,now())
			ON CONFLICT (institution_id, kind) WHERE campus_id IS NULL
			DO UPDATE SET prefix = EXCLUDED.prefix, suffix = EXCLUDED.suffix,
			              padding = EXCLUDED.padding, format = EXCLUDED.format,
			              reset_yearly = EXCLUDED.reset_yearly, updated_at = now()`,
			id.InstitutionID, kind, req.Prefix, req.Suffix, req.Padding, format, reset)
		return err
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"kind": kind})
}

type feGSTHeadRequest struct {
	IsTaxable bool   `json:"is_taxable"`
	GSTRateBP int    `json:"gst_rate_bp"`
	HSNSAC    string `json:"hsn_sac,omitempty"`
}

/*
saveHeadGSTTreatment sets the GST treatment of one fee head.

	Not uniform across a school's income: tuition at a recognised school is
	exempt, while transport, uniforms and the canteen are usually taxable. The
	rate is basis points to stay integral — 1800 is 18.00% — because a rate held
	as a float is a rounding argument with a tax officer.
*/
func (s *Server) saveHeadGSTTreatment(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	headID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "fee head id must be a uuid")
		return
	}
	var req feGSTHeadRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.GSTRateBP < 0 || req.GSTRateBP > 10000 {
		httpx.BadRequest(w, r, "a GST rate is between 0 and 10000 basis points (0% to 100%)")
		return
	}
	if req.IsTaxable && req.GSTRateBP == 0 {
		httpx.BadRequest(w, r, "a taxable head needs a rate. Zero-rated and exempt are not the same thing on a return")
		return
	}
	if req.IsTaxable && strings.TrimSpace(req.HSNSAC) == "" {
		httpx.BadRequest(w, r, "a taxable head needs its HSN/SAC code. The invoice cannot be filed without one")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE fee_heads
			   SET is_taxable = $2, gst_rate_bp = $3, hsn_sac = NULLIF($4,'')
			 WHERE id = $1`,
			headID, req.IsTaxable, req.GSTRateBP, strings.ToUpper(strings.TrimSpace(req.HSNSAC)))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": headID.String()})
}

// ===================================================================
// Shared
// ===================================================================

// feeEngineFail maps a write failure to the most honest status available,
// naming the constraint the school actually tripped rather than reporting a
// generic 500 for a data-entry mistake.
func feeEngineFail(w http.ResponseWriter, r *http.Request, err error) {
	var ref refusal
	if errors.As(err, &ref) {
		httpx.BadRequest(w, r, string(ref))
		return
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "fee_structure_versions_one_active"):
		httpx.BadRequest(w, r, "this structure already has an active version for that year")
	case strings.Contains(msg, "fee_structure_versions_no"):
		httpx.BadRequest(w, r, "that version number is already taken on this structure")
	case strings.Contains(msg, "fee_structure_version_items_line"):
		httpx.BadRequest(w, r, "the same fee head appears twice for one instalment")
	case strings.Contains(msg, "fee_fine_rules_one_active_per_target"):
		httpx.BadRequest(w, r, "an active rule already covers that campus, structure and head. Edit it, or retire it first")
	case strings.Contains(msg, "fee_fine_rules_per_day_not_compounded"):
		httpx.BadRequest(w, r, "a per-day rule cannot also compound")
	case strings.Contains(msg, "fee_fine_rules_complete_check"):
		httpx.BadRequest(w, r, "a percentage rule needs a percent, and a fixed or per-day rule needs an amount")
	case strings.Contains(msg, "fee_fine_charges_once_per_day"):
		httpx.BadRequest(w, r, "that fine has already been raised today")
	case strings.Contains(msg, "invoices_fee_structure_version_id_fkey"):
		httpx.BadRequest(w, r, "invoices have been raised under this version, so it cannot be removed")
	case strings.Contains(msg, "numbering_schemes_format_has_seq"):
		httpx.BadRequest(w, r, "the format must contain {seq}")
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

// jsonBytes marshals the working for a charge row. Named rather than calling
// json.Marshal inline so the failure is attributable in a stack trace.
func jsonBytes(v any) ([]byte, error) { return json.Marshal(v) }
