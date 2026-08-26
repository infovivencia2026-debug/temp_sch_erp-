package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What the family owes to take the seat.

   Enrolment created the student, the enrolment row and the guardian link, and
   no fee account at all — so a child admitted this morning owed nothing, and
   the first invoice had to be raised separately with nothing tying it back to
   the admission. The enrol request has carried a fee_structure_id since it was
   written and never used it.

   This is the read half: what the class costs, itemised, before anybody
   presses the button. The money itself is not taken here — the fee counter
   does that, and a second place to record a payment is a second place for the
   day's cash to disagree with the ledger.
*/

type admissionFeeLine struct {
	Head        string `json:"head"`
	Description string `json:"description,omitempty"`
	AmountPaise int64  `json:"amount_paise"`
	Refundable  bool   `json:"is_refundable"`
	// 'transport' or 'hostel' where the fee is owed for taking a service
	// rather than for being enrolled. Empty for the ordinary heads.
	Service *string `json:"service,omitempty"`
}

type admissionFees struct {
	StructureID   string             `json:"fee_structure_id,omitempty"`
	StructureName string             `json:"fee_structure_name,omitempty"`
	ClassName     string             `json:"class_name,omitempty"`
	InstalmentNo  int                `json:"instalment_no"`
	Lines         []admissionFeeLine `json:"lines"`
	TotalPaise    int64              `json:"total_paise"`
	// Absent where the class has no priced structure. The screen says so
	// rather than showing a total of zero, which reads as "nothing to pay".
	Priced bool `json:"priced"`
}

// getAdmissionFees itemises the first instalment for the class applied for.
func (s *Server) getAdmissionFees(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	appID := chi.URLParam(r, "id")

	out := admissionFees{InstalmentNo: 1, Lines: []admissionFeeLine{}}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* The structure for the class the child applied for.

		   A NULL class_id means the structure applies to every class, which is
		   how most schools price: one list for the whole school, and a
		   separate one only where a class differs. Requiring an exact match
		   found nothing at all and told the office no fee was priced, which
		   was worse than wrong — it invited them to admit a child for free.

		   Class-specific wins over school-wide, then newest, so a structure
		   written for Grade 7 beats the general one and a superseded list
		   loses to the one that replaced it. */
		err := tx.QueryRow(r.Context(), `
			SELECT fs.id::text, fs.name, c.name
			  FROM applications a
			  JOIN classes c ON c.id = a.class_sought
			  JOIN fee_structures fs ON fs.is_active
			                        AND (fs.class_id = a.class_sought
			                             OR fs.class_id IS NULL)
			 WHERE a.id = $1::uuid
			 ORDER BY (fs.class_id IS NOT NULL) DESC, fs.created_at DESC
			 LIMIT 1`, appID).Scan(&out.StructureID, &out.StructureName, &out.ClassName)
		if err == pgx.ErrNoRows {
			/* No structure priced for this class. Still name the class, so the
			   screen can say which one has nothing against it. */
			_ = tx.QueryRow(r.Context(), `
				SELECT c.name FROM applications a
				  JOIN classes c ON c.id = a.class_sought
				 WHERE a.id = $1::uuid`, appID).Scan(&out.ClassName)
			return nil
		}
		if err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT fh.name, COALESCE(fh.code, ''), fsi.amount_paise, fh.is_refundable,
			       fh.service
			  FROM fee_structure_items fsi
			  JOIN fee_heads fh ON fh.id = fsi.fee_head_id
			 WHERE fsi.fee_structure_id = $1::uuid
			   AND fsi.instalment_no = 1
			 ORDER BY fh.is_refundable, fh.name`, out.StructureID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var l admissionFeeLine
			if err := rows.Scan(&l.Head, &l.Description, &l.AmountPaise, &l.Refundable,
				&l.Service); err != nil {
				return err
			}
			out.Lines = append(out.Lines, l)
			/* The total is what an ordinary child owes. A service the family
			   has not asked for is quoted on its own line and added only when
			   they take it — quoting a bus fee to somebody who walks is how a
			   parent is asked for money the school never meant to charge. */
			if l.Service == nil {
				out.TotalPaise += l.AmountPaise
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
		out.Priced = len(out.Lines) > 0
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
