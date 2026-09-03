package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* WHAT THE LIBRARY IS OWED.

   A fine is worked out once, at the counter, when a book comes back late
   (returnBook), and library_loans.fine_paid has said ever since whether it was
   settled. Nothing read that column and nothing wrote it, so "how much did
   the library collect this year" had no answer and every fine stayed
   outstanding forever on paper.

   Two figures and a list. Collected is every fine marked paid; outstanding is
   every fine recorded and not paid, oldest first, because that is the list
   somebody works through. Open loans past their due date are counted but not
   priced: the amount is fixed on the day the book is returned, and a total
   that drifts by the day is not a figure anyone can report. */

type fineRow struct {
	LoanID     string  `json:"loan_id"`
	Borrower   string  `json:"borrower"`
	Title      string  `json:"title"`
	Accession  string  `json:"accession_no"`
	DueOn      string  `json:"due_on"`
	ReturnedOn *string `json:"returned_on,omitempty"`
	FinePaise  int64   `json:"fine_paise"`
}

type fineSummary struct {
	CollectedPaise   int64     `json:"collected_paise"`
	CollectedCount   int       `json:"collected_count"`
	OutstandingPaise int64     `json:"outstanding_paise"`
	OutstandingCount int       `json:"outstanding_count"`
	OverdueOpen      int       `json:"overdue_open_loans"`
	Outstanding      []fineRow `json:"outstanding"`
	Collected        []fineRow `json:"collected"`
}

func (s *Server) mountLibraryFines(r chi.Router) {
	read := httpx.RequirePermission(rbac.LibraryRead)
	write := httpx.RequirePermission(rbac.LibraryWrite)
	r.With(read).Get("/library/fines/summary", s.getFineSummary)
	r.With(write).Post("/library/loans/{id}/fine/collect", s.collectFine)
}

const fineRowSelect = `
	SELECT l.id::text,
	       COALESCE(nullif(trim(concat_ws(' ', st.first_name, st.middle_name, st.last_name)), ''),
	                nullif(trim(concat_ws(' ', e.first_name, e.last_name)), ''), 'Unknown'),
	       t.title, c.accession_no,
	       to_char(l.due_on, 'YYYY-MM-DD'), to_char(l.returned_on, 'YYYY-MM-DD'),
	       l.fine_paise
	  FROM library_loans l
	  JOIN library_copies c ON c.id = l.copy_id
	  JOIN library_titles t ON t.id = c.title_id
	  LEFT JOIN students st ON st.id = l.student_id
	  LEFT JOIN employees e ON e.id = l.employee_id
	 WHERE l.fine_paise > 0 AND l.fine_paid = $1
	 ORDER BY l.returned_on, l.due_on
	 LIMIT 500`

func scanFineRows(rows pgx.Rows) ([]fineRow, error) {
	defer rows.Close()
	out := []fineRow{}
	for rows.Next() {
		var f fineRow
		if err := rows.Scan(&f.LoanID, &f.Borrower, &f.Title, &f.Accession,
			&f.DueOn, &f.ReturnedOn, &f.FinePaise); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Server) getFineSummary(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := fineSummary{Outstanding: []fineRow{}, Collected: []fineRow{}}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(sum(fine_paise) FILTER (WHERE fine_paid), 0),
			       count(*) FILTER (WHERE fine_paid AND fine_paise > 0),
			       COALESCE(sum(fine_paise) FILTER (WHERE NOT fine_paid), 0),
			       count(*) FILTER (WHERE NOT fine_paid AND fine_paise > 0),
			       count(*) FILTER (WHERE returned_on IS NULL AND due_on < CURRENT_DATE)
			  FROM library_loans`).Scan(&out.CollectedPaise, &out.CollectedCount,
			&out.OutstandingPaise, &out.OutstandingCount, &out.OverdueOpen); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), fineRowSelect, false)
		if err != nil {
			return err
		}
		if out.Outstanding, err = scanFineRows(rows); err != nil {
			return err
		}
		rows, err = tx.Query(r.Context(), fineRowSelect, true)
		if err != nil {
			return err
		}
		out.Collected, err = scanFineRows(rows)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// collectFine marks one loan's fine as settled. The amount is not editable
// here: a fine that needs changing is a return that was recorded wrong, and
// this is not the place to quietly rewrite it.
func (s *Server) collectFine(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	loanID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var fine int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE library_loans
			   SET fine_paid = true
			 WHERE id = $1 AND fine_paise > 0 AND NOT fine_paid
			 RETURNING fine_paise`, loanID).Scan(&fine)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "nothing_to_collect",
			"no unpaid fine on that loan")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"collected_paise": fine})
}
