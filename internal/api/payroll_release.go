package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Between "the numbers are right" and "the money has gone".

   Running payroll wrote payslips and stopped. There was no moment at which HR
   said the month was finished, no point after which attendance could not
   quietly change a figure somebody had already approved, and no act that told
   the twelve people it was about that their pay was ready. The bank file could
   be downloaded from a draft — which is a school paying real money out of
   numbers it had not agreed.

   So a month now moves through four states, and each one is somebody's
   decision rather than a side effect:

     draft      the run exists and HR is still checking it
     locked     HR is satisfied; attendance can no longer move the figures,
                and finance may now draw the bank file
     paid       finance has sent the money
     published  the staff have been told and can read their own payslip

   Published is last on purpose. Telling a teacher their payslip is ready
   before the transfer has gone is how a school gets twelve people asking why
   the money has not arrived.
*/

type payrollStateReq struct {
	Month int    `json:"month"`
	Year  int    `json:"year"`
	To    string `json:"to"`
}

// setPayrollState moves a month forward: lock it, mark it paid, or publish it.
func (s *Server) setPayrollState(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in payrollStateReq
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send a month and what to do with it.")
		return
	}
	if in.Month < 1 || in.Month > 12 || in.Year < 2000 {
		httpx.BadRequest(w, r, "Choose a month.")
		return
	}

	// The order is the point: a month cannot be published before it is paid,
	// or paid before it is locked. Skipping a step is not a shortcut, it is
	// somebody being told about money that has not moved.
	var from []string
	switch in.To {
	case "locked":
		from = []string{"draft", "processed"}
	case "paid":
		from = []string{"locked"}
	case "published":
		from = []string{"paid", "locked"}
	case "draft":
		// Unlocking, for the month HR locked and then found a mistake in.
		// Allowed only before the money has gone: after that the payslip is a
		// record of a transfer, not a draft.
		from = []string{"locked"}
	default:
		httpx.BadRequest(w, r, "A month can be locked, marked paid, published, or unlocked.")
		return
	}

	var told int
	var runID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		status := in.To
		if in.To == "published" {
			// There is no 'published' status: publishing is what the payslip's
			// own visibility already means, and adding a fifth state would
			// leave 'paid' looking unfinished forever. The run stays paid; the
			// act of telling people is what happens here.
			status = "paid"
		}
		err := tx.QueryRow(r.Context(), `
			UPDATE payroll_runs
			   SET status    = $4,
			       locked_at = CASE WHEN $4 = 'draft' THEN NULL
			                        WHEN locked_at IS NULL THEN now()
			                        ELSE locked_at END,
			       -- Publishing is an event, not a state — see 00148. Unlocking
			       -- back to draft clears it, because a month being re-run is
			       -- a month whose staff will have to be told again.
			       published_at = CASE WHEN $5 THEN now()
			                           WHEN $4 = 'draft' THEN NULL
			                           ELSE published_at END
			 WHERE period_month = $1 AND period_year = $2
			   AND status = ANY($3)
			 RETURNING id::text`,
			in.Month, in.Year, from, status, in.To == "published").Scan(&runID)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.BadRequest(w, r,
				"That month is not at a stage where this can be done. Lock it before drawing the bank file, and pay it before publishing.")
			return errStopped
		}
		if err != nil {
			return err
		}
		if in.To != "published" {
			return nil
		}

		/* Telling people, in the two ways a school actually reaches them.

		   The notification is the one that always works: it needs no address
		   and no provider, and it is what a teacher sees when they next open
		   the product. Email is attempted on top, and is allowed to fail —
		   a school with no mail provider configured must still be able to
		   publish payslips, and the failure belongs in the message log rather
		   than in the way of the payroll office's afternoon. */
		rows, err := tx.Query(r.Context(), `
			SELECT e.user_id, concat_ws(' ', e.first_name, e.last_name),
			       ps.net_paise
			  FROM payslips ps
			  JOIN employees e ON e.id = ps.employee_id
			 WHERE ps.payroll_run_id = $1::uuid AND e.user_id IS NOT NULL`, runID)
		if err != nil {
			return err
		}
		type person struct {
			user any
			name string
			net  int64
		}
		var people []person
		for rows.Next() {
			var p person
			if err := rows.Scan(&p.user, &p.name, &p.net); err != nil {
				rows.Close()
				return err
			}
			people = append(people, p)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		month := time.Month(in.Month).String()
		for _, p := range people {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO notifications (institution_id, user_id, kind, title, body, link)
				VALUES ($1, $2, 'payslip', $3, $4, '/go/my_profile/my_pay')`,
				id.InstitutionID, p.user,
				fmt.Sprintf("Your payslip for %s is ready", month),
				fmt.Sprintf("%s %d — take-home %s. Open My pay to see what was taken off.",
					month, in.Year, rupeesFromPaise(p.net))); err != nil {
				return err
			}
			told++
		}
		return nil
	})
	if errors.Is(err, errStopped) {
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Email is sent outside the payroll transaction on purpose: a provider
	// that is down must not roll back the fact that the month was published.
	var emailed, emailFailed int
	if in.To == "published" && runID != "" {
		emailed, emailFailed = s.emailPayslips(r, runID, in.Month, in.Year)
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"state": in.To, "notified": told,
		"emailed": emailed, "email_failed": emailFailed,
	})
}

func rupeesFromPaise(p int64) string {
	return fmt.Sprintf("₹%d", p/100)
}

// emailPayslips tells each member of staff by email as well, and counts rather
// than fails: one bad address must not stop the other eleven.
func (s *Server) emailPayslips(r *http.Request, runID string, month, year int) (sent, failed int) {
	id := httpx.IdentityFrom(r.Context())
	type target struct {
		user  any
		name  string
		email string
		net   int64
	}
	var people []target
	var school string

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`SELECT name FROM institutions WHERE id = $1`, id.InstitutionID).Scan(&school); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT e.user_id, concat_ws(' ', e.first_name, e.last_name),
			       COALESCE(e.email::text, ''), ps.net_paise
			  FROM payslips ps
			  JOIN employees e ON e.id = ps.employee_id
			 WHERE ps.payroll_run_id = $1::uuid
			   AND e.user_id IS NOT NULL
			   AND COALESCE(e.email::text, '') <> ''`, runID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var t target
			if err := rows.Scan(&t.user, &t.name, &t.email, &t.net); err != nil {
				return err
			}
			people = append(people, t)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.LogError(r, err)
		return 0, 0
	}

	for _, p := range people {
		err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := s.QueueMessage(r.Context(), tx, id.InstitutionID, SendRequest{
				Channel:      "email",
				TemplateCode: "payroll.payslip",
				Recipient:    p.email,
				// One per person per month, so pressing publish twice does not
				// send everybody a second copy of their own payslip.
				SourceKind:    "payroll_run",
				OccurrenceKey: fmt.Sprintf("%s:%s", runID, p.email),
				Vars: map[string]any{
					"staff_name":  p.name,
					"month":       time.Month(month).String(),
					"year":        year,
					"net_pay":     rupeesFromPaise(p.net),
					"school_name": school,
				},
			})
			return err
		})
		if err != nil {
			// Expected on a school with no mail provider. Counted and logged,
			// never fatal — the notification has already reached them.
			httpx.LogError(r, err)
			failed++
			continue
		}
		sent++
	}
	return sent, failed
}
