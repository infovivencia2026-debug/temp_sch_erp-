package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What a class costs, at the desk where a family asks.

   Admitting a child raises no invoice, deliberately: a school that billed on
   admission would bill a child admitted in November for the whole year, and
   would bill before the year's structure exists. The demand is raised as its
   own act, per class, per instalment.

   That is right and it left the admissions clerk with nothing to say. A parent
   sitting at the desk asks what it will cost — the one question every
   admission conversation contains — and the office had to open the finance
   module, find the structure for the class, and read it out. So they quoted
   from memory or from a printed sheet, and the sheet went out of date in April.

   THIS IS A QUOTE, NOT A BILL. Nothing here writes anything. It reads the same
   structure the demand raise reads, so the number a family is told at the desk
   is the number the invoice will carry — which was the actual problem, since
   two sources for one figure is two figures.
*/

type feeHeadQuote struct {
	Head  string `json:"head"`
	Paise int64  `json:"paise"`
	// Which instalment it falls in, because "₹13,500 a year" and "₹4,500 in
	// July" are different answers to the question a family is asking.
	Instalment int `json:"instalment"`
}

func (s *Server) admissionFeePreview(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	classID, err := uuid.Parse(r.URL.Query().Get("class_id"))
	if err != nil {
		httpx.BadRequest(w, r, "choose a class to see what it costs")
		return
	}

	heads := []feeHeadQuote{}
	var total int64
	var structureName string
	var instalments int
	/* "No structure" and "a structure nobody activated" are different
	   problems with different answers, and telling somebody the first when it
	   is the second sends them to build a duplicate. */
	var draftName string

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* The CURRENT version, which is what the demand raise uses.

		   fee_structure_versions exists because a school revises its fees and
		   the invoices already issued must keep the figures they were issued
		   with. Quoting from the structure rather than the version would quote
		   a number no invoice will ever carry. */
		var versionID uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT v.id, COALESCE(fs.name, 'Fee structure')
			  FROM fee_structure_versions v
			  JOIN fee_structures fs ON fs.id = v.fee_structure_id
			 WHERE fs.class_id = $1
			   AND v.status = 'active'
			   AND fs.is_active
			 ORDER BY v.effective_from DESC NULLS LAST, v.version_no DESC
			 LIMIT 1`, classID).Scan(&versionID, &structureName)
		if err == pgx.ErrNoRows {
			/* Nothing live. Before saying "there is no fee structure" — which
			   is the sentence that makes somebody build a second one — look
			   for one that exists and has never been activated. A structure
			   with a draft version is the commonest state on a new school and
			   the fix is one click, not a rebuild. */
			_ = tx.QueryRow(r.Context(), `
				SELECT fs.name FROM fee_structures fs
				 WHERE fs.class_id = $1 AND fs.is_active
				 ORDER BY fs.created_at DESC LIMIT 1`, classID).Scan(&draftName)
			return nil
		}
		if err != nil {
			return err
		}

		/* One row per head per instalment, which is how the items are stored
		   and how the demand raise reads them. Summed for the year's total and
		   listed so the family can be told what falls when. */
		if err := tx.QueryRow(r.Context(),
			`SELECT count(DISTINCT instalment_no)::int
			   FROM fee_structure_version_items WHERE version_id = $1`,
			versionID).Scan(&instalments); err != nil {
			return err
		}
		return scanInto(r.Context(), tx, `
			SELECT COALESCE(fh.name, 'Other'), i.amount_paise, i.instalment_no
			  FROM fee_structure_version_items i
			  LEFT JOIN fee_heads fh ON fh.id = i.fee_head_id
			 WHERE i.version_id = $1
			 ORDER BY i.instalment_no, COALESCE(fh.name, 'Other')`,
			func(rows pgx.Rows) error {
				var h feeHeadQuote
				if err := rows.Scan(&h.Head, &h.Paise, &h.Instalment); err != nil {
					return err
				}
				heads = append(heads, h)
				total += h.Paise
				return nil
			}, versionID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"structure":     structureName,
		"heads":         heads,
		"total_paise":   total,
		"instalments":   instalments,
		"has_structure": len(heads) > 0,
		// The structure that exists but is not in force, so the screen can say
		// "activate it" rather than "create one".
		"draft_structure": draftName,
		/* Said on the response rather than assumed by the screen: this is what
		   the class costs, and nothing is owed until the demand is raised. */
		"note": "A quote from the current fee structure. Nothing is charged " +
			"until the demand is raised for this class.",
	})
}
