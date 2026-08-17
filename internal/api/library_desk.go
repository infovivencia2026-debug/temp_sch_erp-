package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The rest of a librarian's year.

   The library could catalogue a book, issue it and fine you for keeping it.
   The three things a librarian does around that — telling the next reader the
   book is back, proving to an inspection that the register matches the
   shelves, and getting next year's textbooks in before June — had nowhere to
   live. */

// --- holds ----------------------------------------------------------------

type reservationRow struct {
	ID         string  `json:"id"`
	TitleID    string  `json:"title_id"`
	Title      string  `json:"title"`
	Author     *string `json:"author,omitempty"`
	Reader     string  `json:"reader"`
	ReaderKind string  `json:"reader_kind"`
	PlacedAt   string  `json:"placed_at"`
	Status     string  `json:"status"`
	// Position in the queue, counted at read time. A stored position is wrong
	// the moment someone ahead of you cancels, and nobody remembers to
	// renumber the rest.
	Position  int     `json:"position"`
	Accession *string `json:"ready_accession_no,omitempty"`
	CollectBy *string `json:"collect_by,omitempty"`
	Expired   bool    `json:"past_collection_date"`
	OnShelf   int     `json:"copies_on_shelf"`
}

/*
listReservations shows the queue for every title that has one.

	Ordered so the counter's own work comes first: books waiting to be
	collected, then the people still waiting for one.
*/
func (s *Server) listReservations(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	items, err := collect(s, r, `
		SELECT res.id::text, res.title_id::text, t.title, t.author,
		       COALESCE(
		           NULLIF(concat_ws(' ', st.first_name, st.last_name), ''),
		           NULLIF(concat_ws(' ', e.first_name, e.last_name), ''),
		           'Unknown reader'),
		       CASE WHEN res.student_id IS NOT NULL THEN 'student' ELSE 'staff' END,
		       to_char(res.placed_at,'YYYY-MM-DD"T"HH24:MI'),
		       res.status,
		       -- How many waiting holds on this title were placed before this
		       -- one, plus one. A reader who is 'ready' is no longer queuing.
		       CASE WHEN res.status = 'waiting' THEN (
		           SELECT count(*)::int + 1 FROM library_reservations q
		            WHERE q.title_id = res.title_id AND q.status = 'waiting'
		              AND q.placed_at < res.placed_at)
		       ELSE 0 END,
		       c.accession_no,
		       to_char(res.collect_by,'YYYY-MM-DD'),
		       res.status = 'ready' AND res.collect_by < current_date,
		       (SELECT count(*)::int FROM library_copies lc
		         WHERE lc.title_id = res.title_id AND lc.status = 'available')
		  FROM library_reservations res
		  JOIN library_titles t ON t.id = res.title_id
		  LEFT JOIN students st ON st.id = res.student_id
		  LEFT JOIN employees e ON e.id = res.employee_id
		  LEFT JOIN library_copies c ON c.id = res.ready_copy_id
		 WHERE ($1::text IS NULL OR res.status = $1)
		 ORDER BY (res.status = 'ready') DESC, res.placed_at
		 LIMIT 300`, []any{nullString(status)},
		func(rows pgx.Rows) (reservationRow, error) {
			var v reservationRow
			return v, rows.Scan(&v.ID, &v.TitleID, &v.Title, &v.Author, &v.Reader,
				&v.ReaderKind, &v.PlacedAt, &v.Status, &v.Position, &v.Accession,
				&v.CollectBy, &v.Expired, &v.OnShelf)
		})
	respond(w, r, items, err)
}

type reservationRequest struct {
	TitleID    string `json:"title_id"`
	StudentID  string `json:"student_id,omitempty"`
	EmployeeID string `json:"employee_id,omitempty"`
}

/*
placeReservation joins the queue for a title.

	If a copy is already on the shelf the hold is created ready rather than
	waiting, because the honest answer to "reserve this" when it is sitting
	right there is "come and get it", not "you are first in a queue of one".
*/
func (s *Server) placeReservation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req reservationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	title, err := uuid.Parse(req.TitleID)
	if err != nil {
		httpx.BadRequest(w, r, "title_id must be a uuid")
		return
	}
	student, employee, err := readerOf(req.StudentID, req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	var newID, status string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* FOR UPDATE SKIP LOCKED, and only genuinely free copies.

		   Two readers were handed the same physical book: placing a hold named
		   an available copy but nothing marked it as spoken for, so the next
		   hold picked the same one. The copy status moves to 'reserved' below,
		   which is what makes the second hold look elsewhere — and what stops
		   the counter issuing a held book to a walk-in. */
		return tx.QueryRow(r.Context(), `
			WITH free AS (
			    SELECT id FROM library_copies
			     WHERE title_id = $2 AND status = 'available'
			     ORDER BY accession_no
			     LIMIT 1
			     FOR UPDATE SKIP LOCKED
			), claimed AS (
			    UPDATE library_copies SET status = 'reserved'
			     WHERE id IN (SELECT id FROM free)
			)
			INSERT INTO library_reservations
			    (institution_id, title_id, student_id, employee_id, created_by,
			     status, ready_copy_id, ready_at, collect_by)
			SELECT $1, $2, $3, $4, $5,
			       CASE WHEN free.id IS NOT NULL THEN 'ready' ELSE 'waiting' END,
			       free.id,
			       CASE WHEN free.id IS NOT NULL THEN now() END,
			       -- Three days to come and get it. A book held forever for
			       -- someone who never comes is a book nobody can borrow.
			       CASE WHEN free.id IS NOT NULL THEN current_date + 3 END
			  FROM (SELECT 1) one
			  LEFT JOIN free ON TRUE
			RETURNING id::text, status`,
			id.InstitutionID, title, student, employee, id.UserID).Scan(&newID, &status)
	})
	if err != nil {
		if isUniqueViolation(err) {
			httpx.Error(w, r, http.StatusConflict, "already_queued",
				"this reader is already in the queue for that title")
			return
		}
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "status": status})
}

type reservationDecision struct {
	// collect | cancel | expire
	Action string `json:"action"`
	Reason string `json:"reason,omitempty"`
}

func (s *Server) decideReservation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	resID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid reservation id")
		return
	}
	var req reservationDecision
	if !httpx.Decode(w, r, &req) {
		return
	}

	var sql string
	switch req.Action {
	case "collect":
		// The counter issues the book separately; this closes the hold so the
		// next reader can be promoted when it comes back.
		sql = `UPDATE library_reservations SET status='collected'
		        WHERE id=$1 AND status='ready' AND $2::uuid IS NOT NULL`
	case "cancel":
		sql = `UPDATE library_reservations
		          SET status='cancelled', cancelled_reason=NULLIF($3,''),
		              ready_copy_id=NULL
		        WHERE id=$1 AND status IN ('waiting','ready') AND $2::uuid IS NOT NULL`
	case "expire":
		sql = `UPDATE library_reservations
		          SET status='expired',
		              cancelled_reason=COALESCE(NULLIF($3,''), 'Not collected in time'),
		              ready_copy_id=NULL
		        WHERE id=$1 AND status='ready' AND $2::uuid IS NOT NULL`
	default:
		httpx.BadRequest(w, r, "action must be collect, cancel or expire")
		return
	}

	var freed *uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`SELECT ready_copy_id FROM library_reservations WHERE id=$1`, resID).Scan(&freed); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(), sql, resID, id.UserID, req.Reason)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		// Cancelling or expiring a ready hold puts that copy back in play, so
		// whoever is next in line gets it rather than the shelf.
		if req.Action != "collect" && freed != nil {
			if _, err := tx.Exec(r.Context(),
				`UPDATE library_copies SET status='available' WHERE id=$1 AND status='reserved'`,
				*freed); err != nil {
				return err
			}
			return promoteNextHold(r, tx, *freed)
		}
		return nil
	})
	if err == pgx.ErrNoRows {
		httpx.Error(w, r, http.StatusConflict, "wrong_state",
			"that hold is not in a state where this action makes sense")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": resID.String(), "action": req.Action})
}

/*
promoteNextHold hands a freed copy to whoever has waited longest.

	Called from the return counter and from cancelling a ready hold, because
	both mean the same thing: this physical book is available again. Doing it
	inside the caller's transaction is the point — a copy that came back and a
	queue that did not move is exactly the failure this prevents.
*/
func promoteNextHold(r *http.Request, tx pgx.Tx, copyID uuid.UUID) error {
	tag, err := tx.Exec(r.Context(), `
		UPDATE library_reservations
		   SET status='ready', ready_copy_id=$1, ready_at=now(),
		       collect_by=current_date + 3
		 WHERE id = (
		     SELECT res.id
		       FROM library_reservations res
		       JOIN library_copies c ON c.id = $1
		      WHERE res.title_id = c.title_id AND res.status = 'waiting'
		      ORDER BY res.placed_at
		      LIMIT 1)`, copyID)
	if err != nil {
		return err
	}
	// Held behind the counter if somebody was waiting, back on the shelf if
	// not. Leaving it 'available' while a reader is told it is theirs is how
	// two people end up promised one book.
	next := "available"
	if tag.RowsAffected() > 0 {
		next = "reserved"
	}
	_, err = tx.Exec(r.Context(),
		`UPDATE library_copies SET status=$2 WHERE id=$1 AND status <> 'issued'`, copyID, next)
	return err
}

// errBadReader covers all three ways the borrower can be wrong, because from
// the caller's side they are the same mistake.
var errBadReader = errors.New("name exactly one reader: student_id or employee_id")

// readerOf resolves the one-of-two borrower columns, refusing both and neither.
func readerOf(studentID, employeeID string) (*uuid.UUID, *uuid.UUID, error) {
	var student, employee *uuid.UUID
	if studentID != "" {
		v, err := uuid.Parse(studentID)
		if err != nil {
			return nil, nil, errBadReader
		}
		student = &v
	}
	if employeeID != "" {
		v, err := uuid.Parse(employeeID)
		if err != nil {
			return nil, nil, errBadReader
		}
		employee = &v
	}
	if (student == nil) == (employee == nil) {
		return nil, nil, errBadReader
	}
	return student, employee, nil
}

// --- stock audit ----------------------------------------------------------

type stockAuditRow struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	OpenedOn string  `json:"opened_on"`
	ClosedOn *string `json:"closed_on,omitempty"`
	Remarks  *string `json:"remarks,omitempty"`
	Expected int     `json:"copies_expected"`
	Scanned  int     `json:"copies_scanned"`
	Missing  int     `json:"copies_missing"`
	OnLoan   int     `json:"copies_on_loan"`
	// Books found on the shelf that the register says are out with someone.
	// A finding in its own right, and the reason missing cannot be computed by
	// subtracting one total from another: scanning one of these would
	// otherwise cancel out a genuinely missing book.
	FoundOnLoan int `json:"copies_found_on_loan"`
}

/*
listStockAudits reports each audit against the shelf it was checking.

	"Expected" counts only the copies that should have been on the shelf. A
	book that is out on loan is not missing, and an audit that says otherwise
	sends a librarian hunting for four hundred books that are in children's
	bags.
*/
func (s *Server) listStockAudits(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT a.id::text, a.name, to_char(a.opened_on,'YYYY-MM-DD'),
		       to_char(a.closed_on,'YYYY-MM-DD'), a.remarks,
		       shelf.expected, sc.scanned, sc.missing, shelf.on_loan, sc.found_on_loan
		  FROM library_stock_audits a
		  LEFT JOIN LATERAL (
		      SELECT count(*) FILTER (WHERE c.status <> 'issued')::int AS expected,
		             count(*) FILTER (WHERE c.status = 'issued')::int AS on_loan
		        FROM library_copies c
		  ) shelf ON TRUE
		  /* Counted per copy rather than by subtracting totals. The headline
		     number and the list of missing books have to be the same answer,
		     and they were not: a book scanned off the shelf while the register
		     said it was on loan pushed the scan count above the expected count
		     and silently cancelled out a book that really was gone. */
		  LEFT JOIN LATERAL (
		      SELECT count(*) FILTER (WHERE seen)::int AS scanned,
		             count(*) FILTER (WHERE NOT seen AND c.status <> 'issued')::int AS missing,
		             count(*) FILTER (WHERE seen AND c.status = 'issued')::int AS found_on_loan
		        FROM library_copies c
		        CROSS JOIN LATERAL (
		            SELECT EXISTS (SELECT 1 FROM library_audit_scans s2
		                            WHERE s2.audit_id = a.id AND s2.copy_id = c.id) AS seen
		        ) x
		  ) sc ON TRUE
		 ORDER BY a.opened_on DESC
		 LIMIT 50`, nil,
		func(rows pgx.Rows) (stockAuditRow, error) {
			var v stockAuditRow
			return v, rows.Scan(&v.ID, &v.Name, &v.OpenedOn, &v.ClosedOn, &v.Remarks,
				&v.Expected, &v.Scanned, &v.Missing, &v.OnLoan, &v.FoundOnLoan)
		})
	respond(w, r, items, err)
}

type stockAuditRequest struct {
	Name    string `json:"name"`
	Remarks string `json:"remarks,omitempty"`
	Close   bool   `json:"close,omitempty"`
	ID      string `json:"id,omitempty"`
}

func (s *Server) saveStockAudit(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req stockAuditRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	if req.Close {
		if strings.TrimSpace(req.Remarks) == "" {
			httpx.BadRequest(w, r,
				"say what the audit found — an audit that ends with missing books and no note is not an audit")
			return
		}
		auditID, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "id must be a uuid to close an audit")
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			tag, err := tx.Exec(r.Context(), `
				UPDATE library_stock_audits
				   SET closed_on = current_date, remarks = $2
				 WHERE id = $1 AND closed_on IS NULL`, auditID, req.Remarks)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return pgx.ErrNoRows
			}
			return nil
		})
		if err == pgx.ErrNoRows {
			httpx.Error(w, r, http.StatusConflict, "already_closed", "that audit is already closed")
			return
		}
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"closed": true})
		return
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Naming it after the day it opened, in the database rather than in Go,
		// so the default matches the server's own date.
		return tx.QueryRow(r.Context(), `
			INSERT INTO library_stock_audits (institution_id, name, opened_by)
			VALUES ($1,
			        COALESCE(NULLIF($2,''), 'Stock audit ' || to_char(current_date,'DD Mon YYYY')),
			        $3)
			RETURNING id::text`,
			id.InstitutionID, strings.TrimSpace(req.Name), id.UserID).Scan(&newID)
	})
	if err != nil {
		if isUniqueViolation(err) {
			httpx.Error(w, r, http.StatusConflict, "audit_open",
				"an audit is already open; close it before starting another, or two people scanning will each conclude half the shelf is missing")
			return
		}
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

type scanRequest struct {
	// The barcode or accession number off the spine. Accepting either is not
	// laxity: a school part-way through barcoding has both on the shelf.
	Code      string `json:"code"`
	FoundRack string `json:"found_rack,omitempty"`
}

/*
recordAuditScan books one copy as seen.

	Returns what the copy is, because the person scanning is holding a book and
	looking at a screen, and "Wings of Fire, rack C3, register says B1" is the
	only feedback that catches a misshelved book at the moment it can be fixed.
*/
func (s *Server) recordAuditScan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	auditID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid audit id")
		return
	}
	var req scanRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" {
		httpx.BadRequest(w, r, "scan or type an accession number")
		return
	}

	var title, accession, status string
	var rack *string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var copyID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT c.id, t.title, c.accession_no, c.status, c.rack
			  FROM library_copies c
			  JOIN library_titles t ON t.id = c.title_id
			 WHERE c.accession_no = $1 OR c.barcode = $1
			 LIMIT 1`, code).Scan(&copyID, &title, &accession, &status, &rack); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO library_audit_scans (audit_id, copy_id, scanned_by, found_rack)
			VALUES ($1,$2,$3,NULLIF($4,''))
			-- Scanning the same book twice is a person double-checking, not an
			-- error worth stopping them for.
			ON CONFLICT (audit_id, copy_id)
			DO UPDATE SET scanned_at = now(), found_rack = EXCLUDED.found_rack`,
			auditID, copyID, id.UserID, req.FoundRack)
		return err
	})
	if err == pgx.ErrNoRows {
		httpx.Error(w, r, http.StatusNotFound, "unknown_copy",
			"no copy with accession number "+code)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"title": title, "accession_no": accession, "status": status,
		"register_rack": rack, "misshelved": rack != nil && req.FoundRack != "" && *rack != req.FoundRack,
	})
}

type missingRow struct {
	CopyID    string  `json:"copy_id"`
	Accession string  `json:"accession_no"`
	Title     string  `json:"title"`
	Author    *string `json:"author,omitempty"`
	Rack      *string `json:"rack,omitempty"`
	Status    string  `json:"status"`
}

// listAuditMissing names the books the shelf should have held and did not.
func (s *Server) listAuditMissing(w http.ResponseWriter, r *http.Request) {
	auditID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid audit id")
		return
	}
	items, err := collect(s, r, `
		SELECT c.id::text, c.accession_no, t.title, t.author, c.rack, c.status
		  FROM library_copies c
		  JOIN library_titles t ON t.id = c.title_id
		 WHERE c.status <> 'issued'
		   AND NOT EXISTS (SELECT 1 FROM library_audit_scans s2
		                    WHERE s2.audit_id = $1 AND s2.copy_id = c.id)
		 ORDER BY c.accession_no
		 LIMIT 500`, []any{auditID},
		func(rows pgx.Rows) (missingRow, error) {
			var v missingRow
			return v, rows.Scan(&v.CopyID, &v.Accession, &v.Title, &v.Author, &v.Rack, &v.Status)
		})
	respond(w, r, items, err)
}

// --- textbook indent ------------------------------------------------------

type indentRow struct {
	ID         string  `json:"id"`
	ClassID    string  `json:"class_id"`
	ClassName  string  `json:"class_name"`
	Subject    *string `json:"subject,omitempty"`
	Title      string  `json:"title"`
	Publisher  string  `json:"publisher"`
	Requested  int     `json:"qty_requested"`
	Received   int     `json:"qty_received"`
	Issued     int     `json:"qty_issued"`
	PricePaise *int64  `json:"unit_price_paise,omitempty"`
	IndentNo   *string `json:"indent_no,omitempty"`
	// The roll the indent should have covered, so a short order shows up as
	// "40 children without a book" rather than a number nobody can weigh.
	Roll      int `json:"class_roll"`
	Shortfall int `json:"shortfall"`
}

func (s *Server) listTextbookIndents(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT ti.id::text, ti.class_id::text, cl.name, sub.name,
		       ti.title, ti.publisher,
		       ti.qty_requested, ti.qty_received, ti.qty_issued,
		       ti.unit_price_paise, ti.indent_no,
		       roll.n,
		       GREATEST(0, roll.n - ti.qty_received)
		  FROM textbook_indents ti
		  JOIN classes cl ON cl.id = ti.class_id
		  LEFT JOIN subjects sub ON sub.id = ti.subject_id
		  LEFT JOIN LATERAL (
		      SELECT count(*)::int AS n
		        FROM enrollments en
		        JOIN sections sec ON sec.id = en.section_id
		       WHERE sec.class_id = ti.class_id AND en.status = 'active'
		  ) roll ON TRUE
		 ORDER BY cl.name, ti.title
		 LIMIT 400`, nil,
		func(rows pgx.Rows) (indentRow, error) {
			var v indentRow
			return v, rows.Scan(&v.ID, &v.ClassID, &v.ClassName, &v.Subject,
				&v.Title, &v.Publisher, &v.Requested, &v.Received, &v.Issued,
				&v.PricePaise, &v.IndentNo, &v.Roll, &v.Shortfall)
		})
	respond(w, r, items, err)
}

type indentRequest struct {
	ID         string `json:"id,omitempty"`
	ClassID    string `json:"class_id"`
	SubjectID  string `json:"subject_id,omitempty"`
	Title      string `json:"title"`
	Publisher  string `json:"publisher,omitempty"`
	Requested  int    `json:"qty_requested"`
	Received   *int   `json:"qty_received,omitempty"`
	Issued     *int   `json:"qty_issued,omitempty"`
	PricePaise *int64 `json:"unit_price_paise,omitempty"`
	IndentNo   string `json:"indent_no,omitempty"`
}

func (s *Server) saveTextbookIndent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req indentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	// Updating the received or issued count on an existing line is the common
	// case — the indent is raised once in February and touched twice more.
	if req.ID != "" {
		lineID, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "id must be a uuid")
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				UPDATE textbook_indents
				   SET qty_received = COALESCE($2, qty_received),
				       qty_issued   = COALESCE($3, qty_issued),
				       indent_no    = COALESCE(NULLIF($4,''), indent_no),
				       updated_at   = now()
				 WHERE id = $1`, lineID, req.Received, req.Issued, req.IndentNo)
			return err
		})
		if err != nil {
			httpx.BadRequest(w, r, friendlyIndentError(err))
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"id": req.ID})
		return
	}

	class, err := uuid.Parse(req.ClassID)
	if err != nil {
		httpx.BadRequest(w, r, "class_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Title) == "" || req.Requested <= 0 {
		httpx.BadRequest(w, r, "a line needs a book and a quantity")
		return
	}
	if req.Publisher == "" {
		req.Publisher = "NCERT"
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO textbook_indents
			    (institution_id, academic_year_id, class_id, subject_id, title,
			     publisher, qty_requested, unit_price_paise, indent_no)
			VALUES ($1,
			        (SELECT id FROM academic_years WHERE is_current LIMIT 1),
			        $2, NULLIF($3,'')::uuid, $4, $5, $6, $7, NULLIF($8,''))
			RETURNING id::text`,
			id.InstitutionID, class, req.SubjectID, req.Title, req.Publisher,
			req.Requested, req.PricePaise, req.IndentNo).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, friendlyIndentError(err))
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// friendlyIndentError turns the one constraint a user can trip into a sentence.
func friendlyIndentError(err error) string {
	if err == nil {
		return ""
	}
	if strings.Contains(err.Error(), "textbook_indents_issued_within_received") {
		return "you cannot issue more books than you received"
	}
	return err.Error()
}
