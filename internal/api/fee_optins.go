package api

/* WHO CHOSE THE OPTIONAL FEE.

   A fee structure prices a class, and the demand run bills everybody in it.
   That is right for tuition and wrong for the things a family signs up to —
   after-school ECA, music, a coaching batch. Marking the head optional
   (fee_heads.optional) tells the run to bill only the children listed here;
   see the gate in fees.go and migration 00304.

   The roster is written whole rather than one child at a time: the screen is a
   list of ticks, and what it knows is the complete answer, not a diff. Sending
   the whole list also makes the write idempotent — pressing Save twice cannot
   double anybody up, and a lost response can simply be retried.

   Leaving is recorded, not deleted. A child who drops ECA in October has
   already been billed for it in June, and that invoice must stay explicable. */

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type feeOptinRow struct {
	StudentID string `json:"student_id"`
	Name      string `json:"name"`
	AdmnNo    string `json:"admission_no"`
	ClassName string `json:"class_name"`
	Chosen    bool   `json:"chosen"`
	ChosenOn  string `json:"chosen_on,omitempty"`
}

// listFeeOptins returns every enrolled child for the year with a tick against
// the ones who take this head — the whole class list, not only the joiners,
// because the screen's job is picking from it.
func (s *Server) listFeeOptins(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	headID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid fee head id")
		return
	}
	yearID := r.URL.Query().Get("academic_year_id")

	items, err := collect(s, r, `
		WITH yr AS (
			SELECT COALESCE($2::uuid,
			                (SELECT id FROM academic_years WHERE is_current LIMIT 1)) AS id
		)
		SELECT s.id::text,
		       s.full_name,
		       COALESCE(s.admission_no,''),
		       COALESCE(c.name,''),
		       (o.id IS NOT NULL),
		       COALESCE(to_char(o.chosen_on,'YYYY-MM-DD'),'')
		  FROM enrollments e
		  JOIN students s ON s.id = e.student_id
		  LEFT JOIN classes c ON c.id = e.class_id
		  LEFT JOIN student_fee_optins o
		         ON o.student_id = s.id
		        AND o.fee_head_id = $1
		        AND o.academic_year_id = e.academic_year_id
		        AND o.ended_on IS NULL
		 WHERE e.academic_year_id = (SELECT id FROM yr)
		   AND e.status = 'active'
		 ORDER BY c.name NULLS LAST, s.full_name`,
		[]any{headID, nullString(yearID)},
		func(rows pgx.Rows) (feeOptinRow, error) {
			var v feeOptinRow
			return v, rows.Scan(&v.StudentID, &v.Name, &v.AdmnNo, &v.ClassName,
				&v.Chosen, &v.ChosenOn)
		})
	respond(w, r, items, err)
}

type feeOptinRequest struct {
	AcademicYearID string   `json:"academic_year_id,omitempty"`
	StudentIDs     []string `json:"student_ids"`
	Note           string   `json:"note,omitempty"`
}

// setFeeOptins makes the list of takers exactly what was sent.
func (s *Server) setFeeOptins(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	headID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid fee head id")
		return
	}
	var req feeOptinRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	students := make([]uuid.UUID, 0, len(req.StudentIDs))
	for _, raw := range req.StudentIDs {
		sid, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "one of the students is not a valid id")
			return
		}
		students = append(students, sid)
	}

	var added, ended int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var yearID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE($1::uuid,
			                (SELECT id FROM academic_years WHERE is_current LIMIT 1))`,
			nullString(req.AcademicYearID)).Scan(&yearID); err != nil {
			return err
		}

		// Off the list: ended today, not removed. What they were already
		// billed stays where it is; the next run simply passes them by.
		tag, err := tx.Exec(r.Context(), `
			UPDATE student_fee_optins
			   SET ended_on = CURRENT_DATE
			 WHERE fee_head_id = $1
			   AND academic_year_id = $2
			   AND ended_on IS NULL
			   AND NOT (student_id = ANY($3::uuid[]))`,
			headID, yearID, students)
		if err != nil {
			return err
		}
		ended = int(tag.RowsAffected())

		// On it: inserted unless already live. The partial unique index
		// student_fee_optins_one_live is what makes DO NOTHING mean "they
		// were already in", so a re-save neither duplicates nor resets the
		// date somebody joined.
		tag, err = tx.Exec(r.Context(), `
			INSERT INTO student_fee_optins (institution_id, student_id,
			                                academic_year_id, fee_head_id, note)
			SELECT $1, sid, $2, $3, $5
			  FROM unnest($4::uuid[]) AS sid
			ON CONFLICT DO NOTHING`,
			id.InstitutionID, yearID, headID, students, nullString(req.Note))
		if err != nil {
			return err
		}
		added = int(tag.RowsAffected())
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"taking": len(students),
		"added":  added,
		"ended":  ended,
		"as_of":  time.Now().Format("2006-01-02"),
	})
}
