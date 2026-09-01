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
	// Returned so the screen can raise this one child's bill from the same
	// structure it just quoted, rather than guessing which one that was.
	var structureIDOut string

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* THE SAME TABLE THE DEMAND RAISE BILLS FROM.

		   The first cut read fee_structure_version_items, which is the 00045
		   engine's table. generateInvoices reads fee_structure_items, the
		   baseline one — and on this school that is where all sixty-five rows
		   live. So the quote was empty for every class whose fees are actually
		   set up, and would have been right only for a structure nobody bills
		   from. Two tables for one idea, and the quote must read whichever the
		   invoice will.

		   AND AN "ALL CLASSES" STRUCTURE COUNTS. fs.class_id is NULL when a
		   school prices every class the same, which is what this school did:
		   the query matched class_id = $1 and therefore matched nothing at all,
		   on the structure carrying every fee the school charges.

		   A class of its own wins over the school-wide one — that is the point
		   of setting a class-specific structure — so the ordering puts the
		   specific first and takes one. */
		var structureID uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT fs.id, fs.name
			  FROM fee_structures fs
			 WHERE fs.is_active
			   AND (fs.class_id = $1 OR fs.class_id IS NULL)
			   AND EXISTS (SELECT 1 FROM fee_structure_items i
			                WHERE i.fee_structure_id = fs.id)
			 /* A STRUCTURE WORTH SOMETHING BEATS A MORE SPECIFIC ONE WORTH
			    NOTHING.
			
			    A class-specific structure whose heads are all zero is a stub
			    somebody began and abandoned — this school has three — and
			    preferring it on specificity alone quoted a family nought and
			    raised them a bill for nought, which the record then reported
			    as "nothing due". A zero total is not a price; it is an
			    unfinished structure, and the school-wide one is what actually
			    prices that class. */
			 ORDER BY (SELECT COALESCE(sum(i.amount_paise), 0)
			             FROM fee_structure_items i
			            WHERE i.fee_structure_id = fs.id) > 0 DESC,
			          (fs.class_id = $1) DESC,
			          fs.created_at DESC
			 LIMIT 1`, classID).Scan(&structureID, &structureName)
		structureIDOut = structureID.String()
		if err == pgx.ErrNoRows {
			/* Nothing with any priced heads in it. Before saying "there is no
			   fee structure" — the sentence that makes somebody build a second
			   one — look for a structure that exists and has nothing in it,
			   which is a different problem with a different fix. */
			_ = tx.QueryRow(r.Context(), `
				SELECT fs.name FROM fee_structures fs
				 WHERE fs.is_active AND (fs.class_id = $1 OR fs.class_id IS NULL)
				 ORDER BY (fs.class_id = $1) DESC, fs.created_at DESC
				 LIMIT 1`, classID).Scan(&draftName)
			return nil
		}
		if err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(),
			`SELECT count(DISTINCT instalment_no)::int
			   FROM fee_structure_items WHERE fee_structure_id = $1`,
			structureID).Scan(&instalments); err != nil {
			return err
		}
		return scanInto(r.Context(), tx, `
			SELECT COALESCE(fh.name, 'Other'), i.amount_paise, i.instalment_no
			  FROM fee_structure_items i
			  LEFT JOIN fee_heads fh ON fh.id = i.fee_head_id
			 WHERE i.fee_structure_id = $1
			 ORDER BY i.instalment_no, COALESCE(fh.name, 'Other')`,
			func(rows pgx.Rows) error {
				var h feeHeadQuote
				if err := rows.Scan(&h.Head, &h.Paise, &h.Instalment); err != nil {
					return err
				}
				heads = append(heads, h)
				total += h.Paise
				return nil
			}, structureID)
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
		"structure_id":  structureIDOut,
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
