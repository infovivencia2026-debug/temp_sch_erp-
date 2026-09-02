package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
Correcting a fee structure and a grading scale.

	Both could be created and deleted and never corrected. A school that named
	a structure "Grade 8 fee" and meant "Grade 9", or set a tuition line to
	3,500 that should have been 35,000, had one way out: delete the structure
	and build every line again. And deleting is refused the moment an invoice
	has been raised from it -- rightly -- so past that point there was no way
	out at all.

	It is not hypothetical. Three fee structures on the live system were priced
	at zero, one of them winning over the real one by being more specific, and
	they were removed by hand with SQL because the product had no way to touch
	them. That is the shape of a missing edit: it does not look like a gap
	until somebody needs it, and then it needs a database.
*/

type feeStructurePatch struct {
	Name      *string `json:"name,omitempty"`
	AppliesTo *string `json:"applies_to,omitempty"`
	IsActive  *bool   `json:"is_active,omitempty"`
	// Items, when sent, replace every line. A fee structure is read as a whole
	// -- the engine sums its lines -- so patching one line and leaving the
	// rest is a half-priced year nobody notices until the bills go out.
	Items *[]struct {
		FeeHeadID    string `json:"fee_head_id"`
		InstalmentNo int    `json:"instalment_no"`
		AmountPaise  int64  `json:"amount_paise"`
		DueOn        string `json:"due_on,omitempty"`
	} `json:"items,omitempty"`
}

func (s *Server) updateFeeStructure(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	structureID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid fee structure id")
		return
	}
	var req feeStructurePatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		httpx.BadRequest(w, r, "a fee structure needs a name")
		return
	}

	var billed int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE fee_structures SET
			    name       = COALESCE(NULLIF(btrim($2),''), name),
			    applies_to = COALESCE(NULLIF($3,''), applies_to),
			    is_active  = COALESCE($4, is_active)
			 WHERE id = $1`,
			structureID, req.Name, req.AppliesTo, req.IsActive)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errRefGone
		}
		if req.Items == nil {
			return nil
		}

		/* CHANGING THE PRICE AFTER BILLING IS A DIFFERENT ACT.

		   Once an invoice has been raised from a structure, rewriting its
		   lines makes the bills already sent disagree with the structure they
		   came from -- the family has a demand for one figure and the school's
		   own record says another, and nothing reconciles. Renaming is still
		   allowed, because a name is a label; the money is not. */
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM invoices i
			 WHERE i.fee_structure_version_id IN (
			   SELECT v.id FROM fee_structure_versions v
			    WHERE v.fee_structure_id = $1)
			    OR EXISTS (SELECT 1 FROM invoice_lines l
			                WHERE l.invoice_id = i.id
			                  AND l.fee_head_id IN (
			                    SELECT fee_head_id FROM fee_structure_items
			                     WHERE fee_structure_id = $1))`,
			structureID).Scan(&billed); err != nil {
			// The versions table is not present on every school; a failure to
			// count is treated as "cannot prove it is safe".
			billed = -1
		}
		if billed != 0 {
			return errRefInUse
		}

		if _, err := tx.Exec(r.Context(),
			`DELETE FROM fee_structure_items WHERE fee_structure_id = $1`,
			structureID); err != nil {
			return err
		}
		for _, it := range *req.Items {
			if strings.TrimSpace(it.FeeHeadID) == "" || it.AmountPaise < 0 {
				continue
			}
			inst := it.InstalmentNo
			if inst <= 0 {
				inst = 1
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO fee_structure_items (institution_id, fee_structure_id,
				        fee_head_id, instalment_no, amount_paise, due_on)
				VALUES ($1,$2,$3::uuid,$4,$5,NULLIF($6,'')::date)`,
				id.InstitutionID, structureID, it.FeeHeadID, inst,
				it.AmountPaise, it.DueOn); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, errRefInUse) {
		httpx.BadRequest(w, r,
			"bills have already been raised from this structure, so its amounts "+
				"cannot be rewritten — the demands already with families would "+
				"stop matching it. Rename it and build the corrected one beside it")
		return
	}
	writeRefResult(w, r, err, "fee structure", structureID)
}

type gradingScalePatch struct {
	Name      *string `json:"name,omitempty"`
	IsDefault *bool   `json:"is_default,omitempty"`
}

/*
updateGradingScale renames a scale, or makes it the school's default.

	The bands are deliberately not editable here. A band is what turned 87 into
	A1 on a card a family has already been given, and moving its boundary
	silently regrades every result the school has ever published -- the same
	child, the same marks, a different grade, with nothing recording that
	anything changed. A school that needs different boundaries makes a new
	scale and points next term's exams at it.
*/
func (s *Server) updateGradingScale(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	scaleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid grading scale id")
		return
	}
	var req gradingScalePatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		httpx.BadRequest(w, r, "a grading scale needs a name")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE grading_scales SET
			    name       = COALESCE(NULLIF(btrim($2),''), name),
			    is_default = COALESCE($3, is_default)
			 WHERE id = $1`, scaleID, req.Name, req.IsDefault)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errRefGone
		}
		// One default, so "the school's scale" is never ambiguous.
		if req.IsDefault != nil && *req.IsDefault {
			if _, err := tx.Exec(r.Context(),
				`UPDATE grading_scales SET is_default = false
				  WHERE institution_id = $1 AND id <> $2`,
				id.InstitutionID, scaleID); err != nil {
				return err
			}
		}
		return nil
	})
	writeRefResult(w, r, err, "grading scale", scaleID)
}
