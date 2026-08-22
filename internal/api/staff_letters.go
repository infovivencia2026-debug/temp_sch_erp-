package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The letters a school writes over somebody's career, not only at the end of it.

   Two existed, and both only at the exit: the relieving letter and the
   experience certificate, generated together when a departing teacher's
   clearances were signed. Everything else a school puts on its letterhead was
   typed in Word, printed, signed, and remembered by whoever typed it —
   the appointment letter that starts the employment, the letter confirming a
   raise, the written warning that has to exist before anybody is dismissed.

   The last of those is the one that matters most. A dismissal challenged at a
   labour court turns on whether warnings were issued and when, and "we spoke to
   him twice" is not a record. Neither is a Word file on a clerk's laptop.

   So the same machinery the exit letters already use — a permanent serial from
   the school's own series, and a snapshot of the facts as they stood — is
   opened to the three that were missing. The snapshot matters for the same
   reason it does on a transfer certificate: a letter issued in 2026 must not
   change its own contents in 2031 because somebody's designation was updated.

   And every one of them is logged when it is printed, with the name of the
   person who printed it. Not because anybody is suspected, but because a
   letter on school letterhead is an instrument, and a school asked "who issued
   this" has to be able to answer.
*/

// The letters this adds, and what each is for. Codes are stable — they are the
// key certificate_types is looked up by, and renaming one would orphan every
// letter already issued under it.
var staffLetterKinds = map[string]string{
	"APPOINTMENT":     "Appointment Letter",
	"SALARY_REVISION": "Salary Revision Letter",
	"WARNING":         "Warning Letter",
	"SERVICE":         "Service Certificate",
}

type issueLetterReq struct {
	EmployeeID string `json:"employee_id"`
	Kind       string `json:"kind"`
	// What this particular letter says beyond the facts already on record: the
	// conduct being warned about, the new salary, the terms of the
	// appointment. Required for a warning, because a warning with no stated
	// reason is not a warning — it is a piece of paper that helps nobody and
	// protects nobody.
	Body string `json:"body"`
}

// issueStaffLetter writes one letter onto the school's letterhead and keeps it.
func (s *Server) issueStaffLetter(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in issueLetterReq
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send a letter to issue.")
		return
	}
	empID, err := uuid.Parse(strings.TrimSpace(in.EmployeeID))
	if err != nil {
		httpx.BadRequest(w, r, "Choose whose letter this is.")
		return
	}
	kind := strings.ToUpper(strings.TrimSpace(in.Kind))
	name, ok := staffLetterKinds[kind]
	if !ok {
		httpx.BadRequest(w, r,
			"That is not a letter this school issues. Choose an appointment, salary revision, warning or service letter.")
		return
	}
	body := strings.TrimSpace(in.Body)
	if kind == "WARNING" && body == "" {
		httpx.BadRequest(w, r,
			"Say what the warning is about. A warning with no reason on it is worth nothing at a hearing.")
		return
	}

	var serial string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The letter is only issuable for somebody who works here. Without
		// this a mistyped id writes a serial from the school's own series
		// against nobody, and the series has a gap in it forever.
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM employees WHERE id = $1)`, empID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			httpx.BadRequest(w, r, "That member of staff is not on this school's roll.")
			return errStopped
		}

		var b *string
		if body != "" {
			b = &body
		}
		var err error
		serial, err = s.issueStaffCertificate(r, tx, id.InstitutionID, id.UserID, empID, kind, b)
		if err != nil {
			return err
		}

		/* The service book keeps the same event.

		   A letter that exists only in the certificate register is a letter
		   nobody reading the person's record will find. The service book is
		   where a career is read end to end, and a warning or a revision that
		   is missing from it makes the book a partial account of one. */
		entry := "letter"
		switch kind {
		case "APPOINTMENT":
			entry = "appointment"
		case "SALARY_REVISION":
			entry = "increment"
		case "WARNING":
			entry = "warning"
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO service_book_entries (institution_id, employee_id, entry_kind,
			    event_date, title, particulars, source, created_by)
			VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, 'letter', $6)`,
			id.InstitutionID, empID, entry, name+" issued ("+serial+")",
			nullString(body), id.UserID)
		return err
	})
	if errors.Is(err, errStopped) {
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"serial_no": serial, "kind": kind, "name": name})
}

/* Who printed it, and when.

   The audit trail asked for, and the reason for it: a letter on school
   letterhead carries the school's authority, so "who issued this" must have an
   answer that does not depend on somebody remembering. The client calls this
   when the letter is opened for printing.

   Recorded rather than enforced. Refusing to print until some condition is met
   would put the software between a clerk and a letter the principal has already
   agreed to; a record that says who did it is the honest tool for this, and the
   dishonest use of a letter is a thing people do, not a thing software prevents.
*/
func (s *Server) logLetterPrinted(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var in struct {
		Serial string `json:"serial_no"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Say which letter was printed.")
		return
	}
	serial := strings.TrimSpace(in.Serial)
	if serial == "" {
		httpx.BadRequest(w, r, "Say which letter was printed.")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var certID uuid.UUID
		var who string
		err := tx.QueryRow(r.Context(), `
			SELECT ic.id, concat_ws(' ', e.first_name, e.last_name)
			  FROM issued_certificates ic
			  JOIN employees e ON e.id = ic.employee_id
			 WHERE ic.serial_no = $1`, serial).Scan(&certID, &who)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return errStopped
		}
		if err != nil {
			return err
		}
		var ip *string
		if host, _, err := splitHostPortSafe(r.RemoteAddr); err == nil {
			ip = &host
		}
		after, err := json.Marshal(map[string]any{"serial_no": serial, "employee": who})
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO audit_log (institution_id, actor_user_id, action, entity_type,
			                       entity_id, after, ip)
			VALUES ($1,$2,$3,$4,$5,$6,$7::inet)`,
			id.InstitutionID, id.UserID, "PRINT staff_letter",
			"hr.staff-letters", certID, after, ip)
		return err
	})
	if errors.Is(err, errStopped) {
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"logged": true})
}

type letterPrintRow struct {
	Serial string `json:"serial_no"`
	Who    string `json:"employee"`
	By     string `json:"printed_by"`
	At     string `json:"printed_at"`
}

// listLetterPrints answers "who printed this, and when" for the whole school.
func (s *Server) listLetterPrints(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	out := []letterPrintRow{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT COALESCE(a.after->>'serial_no', ''),
			       COALESCE(a.after->>'employee', ''),
			       COALESCE(u.full_name, 'somebody since deleted'),
			       to_char(a.created_at, 'YYYY-MM-DD HH24:MI')
			  FROM audit_log a
			  LEFT JOIN users u ON u.id = a.actor_user_id
			 WHERE a.action = 'PRINT staff_letter'
			 ORDER BY a.created_at DESC
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v letterPrintRow
			if err := rows.Scan(&v.Serial, &v.Who, &v.By, &v.At); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}
