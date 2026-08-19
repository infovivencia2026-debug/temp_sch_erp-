package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* institution_admin.library.digital_e_book_journal_integration

   The catalogue entry for this feature promises single sign-on to EBSCO and
   JSTOR. Neither subscription exists on this deployment, and neither can be
   exercised without one, so neither is claimed here. What a school without a
   subscription still needs — and had nowhere to keep — is the rest of it:

     - a catalogue of what it does hold digitally, beside the physical one
     - who may see each item, so a Class 2 pupil is not shown a research
       database and a research database is not hidden from the staff room
     - lending for the e-books licensed one concurrent reader at a time

   The provider seam IS built: digital_library_providers holds a row per
   subscription with a status, and resolveDigitalProvider is the link-resolution
   step. It answers 503 provider_unavailable today and a test pins that, the way
   tally_authz_test.go pins the Tally gateway. A seam that silently pretended to
   work would be worse than no seam.

   On lending, the important thing is what is NOT here. There is no second
   loan table, no second due-date arithmetic and no second hold queue. A
   single-copy e-book gets a shadow row in library_titles with one
   library_copies row behind it, and from that point the existing desk owns it:
   library_reservations queues readers, POST /ops/library/issue lends it and
   POST /ops/library/loans/{id}/return takes it back, all unchanged. This file
   only decides whether the reader may open the link, which is the one thing a
   physical book does not need. Restating the lending rules for e-books would
   give a school two desks that disagree about who has what.

   RBAC is the library's own: operations.library.read to browse,
   operations.library.write to catalogue. Nothing is invented.
*/

// --- shapes ------------------------------------------------------------------

type digitalHoldingRow struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	Title       string  `json:"title"`
	Author      *string `json:"author,omitempty"`
	Publisher   *string `json:"publisher,omitempty"`
	Identifier  *string `json:"identifier,omitempty"`
	Language    *string `json:"language,omitempty"`
	Description *string `json:"description,omitempty"`
	AccessModel string  `json:"access_model"`
	// The link is withheld from the browse list on purpose: a subscription URL
	// in a JSON payload is the subscription. GET .../access hands it over once
	// entitlement has been checked.
	HasFile      bool     `json:"has_file"`
	FileName     *string  `json:"file_name,omitempty"`
	SubjectTags  []string `json:"subject_tags"`
	ProviderID   *string  `json:"provider_id,omitempty"`
	ProviderName *string  `json:"provider_name,omitempty"`
	// unavailable | configured | live, copied from the provider so the browse
	// screen can grey out what it cannot open.
	ProviderStatus *string `json:"provider_status,omitempty"`
	CampusID       *string `json:"campus_id,omitempty"`
	LoanDays       int     `json:"loan_days"`
	IsActive       bool    `json:"is_active"`
	// Lending state, read from the physical library's own tables.
	LibraryTitleID *string `json:"library_title_id,omitempty"`
	OnLoan         bool    `json:"on_loan"`
	DueOn          *string `json:"due_on,omitempty"`
	Waiting        int     `json:"readers_waiting"`
	// Whether THIS caller may open it now. For an open or subscription holding
	// that is "yes, if you can see it"; for a single-copy loan it is "only
	// while it is lent to you".
	MineNow bool `json:"available_to_me"`
	// The visibility rules, for the librarian's screen. Empty means everyone.
	VisibleToClasses []string `json:"visible_to_classes"`
	VisibleToRoles   []string `json:"visible_to_roles"`
	UpdatedAt        string   `json:"updated_at"`
}

type digitalProviderRow struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Name           string  `json:"name"`
	BaseURL        *string `json:"base_url,omitempty"`
	HasCredentials bool    `json:"has_credentials"`
	Status         string  `json:"status"`
	Notes          *string `json:"notes,omitempty"`
	Holdings       int     `json:"holdings"`
}

// --- mount -------------------------------------------------------------------

/*
mountDigitalLibrary registers the digital holdings desk.

	Splice into internal/api/api.go INSIDE the existing operations group, beside
	the other library routes:

	    r.Route("/ops", func(r chi.Router) {
	        s.mountInfirmary(r)
	        s.mountDigitalLibrary(r)     // <- here

	so the paths are /api/v1/ops/digital-library/*, next to /ops/library/*. It
	must not go inside a Route("/library", ...) of its own — the physical desk
	registers its routes flat under /ops and chi panics when a second Route
	claims a pattern that already has one.

	Every route carries its own permission because the /ops group carries none;
	reads are operations.library.read and writes are operations.library.write,
	both existing. Borrowing is a read-side act: a pupil who may browse the
	catalogue may join the queue for an e-book, exactly as they may for a
	physical one, and the librarian is not made to click for them.
*/
func (s *Server) mountDigitalLibrary(r chi.Router) {
	r.Route("/digital-library", func(r chi.Router) {
		read := httpx.RequirePermission(rbac.LibraryRead)
		write := httpx.RequirePermission(rbac.LibraryWrite)

		r.With(read).Get("/catalogue", s.listDigitalCatalogue)
		r.With(read).Get("/holdings/{id}/access", s.openDigitalHolding)
		r.With(read).Post("/holdings/{id}/borrow", s.borrowDigitalHolding)

		// The vocabulary the visibility editor needs. Served here, gated on the
		// librarian's own permission, rather than sending the screen to
		// /admin/roles and /academics/classes — a librarian holds neither
		// roles.read nor necessarily academics.read, so borrowing those
		// endpoints would leave the editor permanently empty for exactly the
		// person who uses it. Only a key and a name leave the building.
		r.With(write).Get("/audiences", s.listDigitalAudiences)

		r.With(write).Post("/holdings", s.saveDigitalHolding)
		r.With(write).Delete("/holdings/{id}", s.deleteDigitalHolding)
		r.With(write).Put("/holdings/{id}/visibility", s.setDigitalVisibility)

		r.With(read).Get("/providers", s.listDigitalProviders)
		r.With(write).Post("/providers", s.saveDigitalProvider)
		r.With(write).Delete("/providers/{id}", s.deleteDigitalProvider)
	})
}

// --- browsing ----------------------------------------------------------------

/*
digitalVisibility is the predicate that decides who sees a holding.

	No visibility rows at all means everyone: a school that has not thought
	about it gets a working catalogue rather than an empty one, which is the
	failure mode that makes librarians stop using a feature. One rule narrows
	it, and the rules OR together.

	$1 is the caller's user id (for role rules) and $2 the student records they
	are — their own, or their children's — for class rules. A member of staff
	has an empty $2 and matches on roles; a pupil has an empty role set that
	matters and matches on their class.

	Note this is visibility, applied on top of, not instead of, the campus
	boundary below. Both are server-side. The librarian's own screen passes
	$3 = true to see everything they may catalogue, which is a wider view of
	the same tenant, not a wider tenant.
*/
const digitalVisibility = `(
	    $3::boolean
	 OR NOT EXISTS (SELECT 1 FROM digital_holding_visibility v WHERE v.holding_id = h.id)
	 OR EXISTS (
	        SELECT 1 FROM digital_holding_visibility v
	         WHERE v.holding_id = h.id
	           AND ((v.role_key IS NOT NULL
	                 AND EXISTS (SELECT 1 FROM user_roles ur
	                               JOIN roles ro ON ro.id = ur.role_id
	                              WHERE ur.user_id = $1 AND ro.key = v.role_key))
	             OR (v.class_id IS NOT NULL
	                 AND EXISTS (SELECT 1 FROM enrollments en
	                              WHERE en.class_id = v.class_id
	                                AND en.status = 'active'
	                                AND en.student_id = ANY($2))))))`

// digitalCampusScope is the caller's campus boundary, in the unconditional
// form: NULL means every campus. A holding with no campus of its own belongs
// to all of them and is always in.
const digitalCampusScope = `($4::uuid[] IS NULL OR h.campus_id IS NULL OR h.campus_id = ANY($4))`

/*
digitalArgs assembles the four scope parameters every browse query takes.

	Built once so the catalogue, the access check and the borrow path cannot
	drift apart on who can see what — which is the bug this shape exists to
	prevent, and the reason none of them accepts a boundary from the request.
*/
func (s *Server) digitalArgs(r *http.Request, librarian bool) ([]any, error) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		return nil, err
	}
	students := res.StudentIDs
	if students == nil {
		students = []uuid.UUID{}
	}
	// A caller posted to every campus, or platform staff, carries no campus
	// restriction. Anyone else carries their posting — and an empty posting is
	// an empty boundary, not a free one.
	var campuses any
	if !(res.AllCampuses || res.PlatformAdmin) {
		if res.CampusIDs == nil {
			campuses = []uuid.UUID{}
		} else {
			campuses = res.CampusIDs
		}
	}
	// Only a librarian sees past the visibility rules, and only because they
	// are the person who writes them.
	return []any{id.UserID, students, librarian && id.Can(rbac.LibraryWrite), campuses}, nil
}

/*
digitalHoldingSelect is the one projection every digital holding read uses.

	Lending state comes out of library_loans and library_reservations rather
	than out of anything in this migration, because those are where lending
	actually lives. If a librarian returns an e-book at the physical desk, this
	list says so without being told.
*/
const digitalHoldingSelect = `
	SELECT h.id::text, h.kind, h.title, h.author, h.publisher, h.identifier,
	       h.language, h.description, h.access_model,
	       h.file_id IS NOT NULL, f.original_name,
	       h.subject_tags, h.provider_id::text, p.name, p.status,
	       h.campus_id::text, h.loan_days, h.is_active, h.library_title_id::text,
	       EXISTS (SELECT 1 FROM library_loans l
	                 JOIN library_copies c ON c.id = l.copy_id
	                WHERE c.title_id = h.library_title_id AND l.returned_on IS NULL),
	       (SELECT to_char(l.due_on,'YYYY-MM-DD') FROM library_loans l
	          JOIN library_copies c ON c.id = l.copy_id
	         WHERE c.title_id = h.library_title_id AND l.returned_on IS NULL
	         LIMIT 1),
	       (SELECT count(*)::int FROM library_reservations res
	         WHERE res.title_id = h.library_title_id AND res.status = 'waiting'),
	       -- Open to me now. An open or subscription holding needs only that I
	       -- can see it; a single-copy loan needs the live loan to be mine.
	       (h.access_model <> 'single_copy_loan'
	        OR EXISTS (SELECT 1 FROM library_loans l
	                     JOIN library_copies c ON c.id = l.copy_id
	                    WHERE c.title_id = h.library_title_id AND l.returned_on IS NULL
	                      AND (l.student_id = ANY($2)
	                           OR l.employee_id = (SELECT e.id FROM employees e
	                                                WHERE e.user_id = $1 LIMIT 1)))),
	       COALESCE((SELECT array_agg(cl.name ORDER BY cl.name)
	                   FROM digital_holding_visibility v
	                   JOIN classes cl ON cl.id = v.class_id
	                  WHERE v.holding_id = h.id), '{}'),
	       COALESCE((SELECT array_agg(v.role_key ORDER BY v.role_key)
	                   FROM digital_holding_visibility v
	                  WHERE v.holding_id = h.id AND v.role_key IS NOT NULL), '{}'),
	       to_char(h.updated_at,'YYYY-MM-DD"T"HH24:MI')
	  FROM digital_holdings h
	  LEFT JOIN digital_library_providers p ON p.id = h.provider_id
	  LEFT JOIN files f ON f.id = h.file_id AND f.deleted_at IS NULL`

func scanDigitalHolding(rows pgx.Rows) (digitalHoldingRow, error) {
	var v digitalHoldingRow
	return v, rows.Scan(&v.ID, &v.Kind, &v.Title, &v.Author, &v.Publisher, &v.Identifier,
		&v.Language, &v.Description, &v.AccessModel, &v.HasFile, &v.FileName,
		&v.SubjectTags, &v.ProviderID, &v.ProviderName, &v.ProviderStatus,
		&v.CampusID, &v.LoanDays, &v.IsActive, &v.LibraryTitleID,
		&v.OnLoan, &v.DueOn, &v.Waiting, &v.MineNow,
		&v.VisibleToClasses, &v.VisibleToRoles, &v.UpdatedAt)
}

/*
listDigitalCatalogue is both screens.

	?manage=1 is the librarian's view: every holding they may catalogue,
	inactive ones included, visibility rules shown. Without it, it is the
	reader's view — active holdings they are allowed to see. One query rather
	than two because the difference between them is two booleans, and two
	queries would be two places for the visibility rule to be got wrong.
*/
func (s *Server) listDigitalCatalogue(w http.ResponseWriter, r *http.Request) {
	manage := r.URL.Query().Get("manage") == "1"
	args, err := s.digitalArgs(r, manage)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	where := digitalVisibility + " AND " + digitalCampusScope
	if !manage {
		where += " AND h.is_active"
	}
	sql := digitalHoldingSelect + " WHERE " + where

	// Optional narrowing the reader asked for. Both are bound, never spliced.
	if kind := strings.TrimSpace(r.URL.Query().Get("kind")); kind != "" {
		if !oneOfStr(kind, "ebook", "journal", "database") {
			httpx.BadRequest(w, r, "kind must be ebook, journal or database")
			return
		}
		args = append(args, kind)
		sql += fmt.Sprintf(" AND h.kind = $%d", len(args))
	}
	if tag := strings.TrimSpace(r.URL.Query().Get("subject")); tag != "" {
		args = append(args, tag)
		sql += fmt.Sprintf(" AND $%d = ANY(h.subject_tags)", len(args))
	}
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		args = append(args, q)
		sql += fmt.Sprintf(
			" AND (h.title ILIKE '%%' || $%d || '%%' OR h.author ILIKE '%%' || $%d || '%%')",
			len(args), len(args))
	}
	sql += " ORDER BY h.kind, h.title LIMIT 300"

	items, err := collect(s, r, sql, args, scanDigitalHolding)
	respond(w, r, items, err)
}

/*
loadDigitalHolding fetches one holding the caller may see.

	The same visibility and campus predicates as the list, so a holding that
	does not appear in the catalogue cannot be opened by guessing its id. Not
	found rather than forbidden, following hr_growth.go: "there is a research
	database here you may not open" is itself a disclosure.
*/
func (s *Server) loadDigitalHolding(r *http.Request, holdingID uuid.UUID,
	librarian bool) (digitalHoldingRow, error) {

	args, err := s.digitalArgs(r, librarian)
	if err != nil {
		return digitalHoldingRow{}, err
	}
	args = append(args, holdingID)
	items, err := collect(s, r, digitalHoldingSelect+
		" WHERE h.id = $5 AND "+digitalVisibility+" AND "+digitalCampusScope,
		args, scanDigitalHolding)
	if err != nil {
		return digitalHoldingRow{}, err
	}
	if len(items) == 0 {
		return digitalHoldingRow{}, pgx.ErrNoRows
	}
	return items[0], nil
}

// --- opening -----------------------------------------------------------------

var (
	errProviderUnavailable = errors.New("provider_unavailable")
	errHoldingWithdrawn    = errors.New("holding_withdrawn")
	errNotBorrowed         = errors.New("not_borrowed")
)

/*
digitalEntitlement decides whether this caller may be handed the link.

	Pulled out of the handler so it can be tested without a database, because
	it is the rule that matters: a single-copy e-book is licensed one reader at
	a time, and the catalogue's available_to_me flag is a JSON field a client
	can ignore. This is the check that is not optional.

	Order matters. A withdrawn title does not exist as far as a reader is
	concerned; a title lent to somebody else is a conflict, not a mystery, and
	saying so is what stops a reader refreshing forever; and the provider seam
	is last because it is about the school's subscription rather than about
	this reader.
*/
func digitalEntitlement(h digitalHoldingRow) error {
	if !h.IsActive {
		return errHoldingWithdrawn
	}
	if h.AccessModel == "single_copy_loan" && !h.MineNow {
		return errNotBorrowed
	}
	return resolveDigitalProvider(h)
}

type digitalAccessResponse struct {
	HoldingID string `json:"holding_id"`
	Title     string `json:"title"`
	// Exactly one of these. url is a link out; file_id is a document this
	// school uploaded, which the client fetches through the files endpoint.
	URL    *string `json:"url,omitempty"`
	FileID *string `json:"file_id,omitempty"`
	DueOn  *string `json:"due_on,omitempty"`
	Note   string  `json:"note,omitempty"`
}

/*
openDigitalHolding hands over the link, once.

	Three refusals, in the order they matter:

	  1. Not visible to you  -> 404, as though it did not exist.
	  2. A single-copy loan not currently lent to you -> 409. The catalogue
	     already told you it was out; this is the second line of defence, and
	     it is the one that counts, because the first is a JSON field a client
	     can ignore.
	  3. Behind a provider that is not live -> 503 provider_unavailable. This
	     is the seam, answering honestly.
*/
func (s *Server) openDigitalHolding(w http.ResponseWriter, r *http.Request) {
	holdingID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	h, err := s.loadDigitalHolding(r, holdingID, false)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	switch err := digitalEntitlement(h); {
	case errors.Is(err, errHoldingWithdrawn):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errNotBorrowed):
		httpx.Error(w, r, http.StatusConflict, "not_borrowed",
			"this e-book is licensed one reader at a time and is not currently lent to you")
		return
	case errors.Is(err, errProviderUnavailable):
		httpx.Error(w, r, http.StatusServiceUnavailable, "provider_unavailable",
			"this title sits behind a subscription that is not connected on this deployment — "+
				"ask the librarian for the institutional login")
		return
	}

	// The URL is read separately from the browse projection, which deliberately
	// omits it. One extra round trip on the one request that has earned it.
	var (
		url    *string
		fileID *string
	)
	id := httpx.IdentityFrom(r.Context())
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The file join is the standard one: a soft-deleted file is not a file,
		// and joining without the predicate is how a deleted document keeps
		// being served.
		return tx.QueryRow(r.Context(), `
			SELECT h.external_url, f.id::text
			  FROM digital_holdings h
			  LEFT JOIN files f ON f.id = h.file_id AND f.deleted_at IS NULL
			 WHERE h.id = $1`, holdingID).Scan(&url, &fileID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out := digitalAccessResponse{HoldingID: h.ID, Title: h.Title, URL: url, FileID: fileID, DueOn: h.DueOn}
	if url == nil && fileID == nil {
		// The file was deleted out from under the catalogue entry. Better to
		// say so than to hand back a response with nothing in it.
		httpx.Error(w, r, http.StatusConflict, "no_copy",
			"the uploaded copy of this title is no longer on file — tell the librarian")
		return
	}
	if h.AccessModel == "single_copy_loan" {
		out.Note = "On loan to you until " + strDeref(h.DueOn)
	}
	httpx.JSON(w, http.StatusOK, out)
}

/*
resolveDigitalProvider is the link-resolution step for a real subscription.

	Built and deliberately inert. When a school does hold an EBSCO or JSTOR
	subscription, this is where the provider's base URL, the school's
	credential and the item identifier are combined into a signed link — and
	the provider row's status is what says whether that is possible. Until then
	it refuses, and digital_library_provider_test.go pins the refusal, so the
	day somebody wires a provider up they have to change this function and that
	test together rather than discover in production that the seam was
	decorative.

	A holding with no provider is not behind one and is never refused here.
*/
func resolveDigitalProvider(h digitalHoldingRow) error {
	if h.ProviderID == nil {
		return nil
	}
	if h.ProviderStatus != nil && *h.ProviderStatus == "live" {
		// No provider is ever 'live' on this deployment. When one is, the link
		// is built here.
		return nil
	}
	return errProviderUnavailable
}

func strDeref(p *string) string {
	if p == nil {
		return "—"
	}
	return *p
}

// --- borrowing ---------------------------------------------------------------

type digitalBorrowRequest struct {
	// A librarian may borrow on somebody's behalf; everyone else is borrowing
	// for themselves and leaves both blank.
	StudentID  string `json:"student_id,omitempty"`
	EmployeeID string `json:"employee_id,omitempty"`
}

/*
borrowDigitalHolding puts the reader in the physical library's queue.

	This is the whole of e-book lending, and it deliberately adds no lending
	logic. A single-copy e-book carries a shadow row in library_titles with one
	copy behind it; borrowing places an ordinary library_reservations hold on
	that title, which the existing desk already knows how to make ready when
	the copy is free, hand over via POST /ops/library/issue, and close on
	return. Due dates, renewals, the one-live-hold-per-reader index and the
	queue order are all that code's, unchanged.

	The one thing this cannot do is issue the loan itself, and it should not:
	that is the librarian's act at /ops/library/issue and it is gated on
	library.write for a reason.
*/
func (s *Server) borrowDigitalHolding(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	holdingID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req digitalBorrowRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	h, err := s.loadDigitalHolding(r, holdingID, false)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if h.AccessModel != "single_copy_loan" || h.LibraryTitleID == nil {
		httpx.BadRequest(w, r,
			"this title is not lent one reader at a time — open it directly")
		return
	}
	titleID, err := uuid.Parse(*h.LibraryTitleID)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Naming somebody else is the librarian's privilege.

	   Without this check a pupil could post another child's id and take their
	   place in the queue, which is a small act with a very annoying
	   consequence. Everyone else borrows as themselves, resolved on the
	   server from the session — never from the request body. */
	var student, employee *uuid.UUID
	if req.StudentID != "" || req.EmployeeID != "" {
		if !id.Can(rbac.LibraryWrite) {
			httpx.Denied(w, r, "you can only borrow for yourself")
			return
		}
		student, employee, err = readerOf(req.StudentID, req.EmployeeID)
		if err != nil {
			httpx.BadRequest(w, r, err.Error())
			return
		}
	}

	var status string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if student == nil && employee == nil {
			// Who the signed-in user is as a borrower. A guardian is neither,
			// and is told so rather than silently queued as nobody.
			var st, emp *uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				SELECT (SELECT s.id FROM students s WHERE s.user_id = $1),
				       (SELECT e.id FROM employees e WHERE e.user_id = $1)`,
				id.UserID).Scan(&st, &emp); err != nil {
				return err
			}
			switch {
			case st != nil:
				student = st
			case emp != nil:
				employee = emp
			default:
				return errors.New(
					"your account is not a reader on the library's register — ask the librarian to borrow this for you")
			}
		}

		/* Ready if the copy is on the shelf, waiting otherwise. The same rule
		   placeReservation applies to a physical book: telling somebody they
		   are first in a queue of one, for a book sitting right there, is not
		   an answer. */
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO library_reservations
			    (institution_id, title_id, student_id, employee_id, status,
			     ready_copy_id, ready_at, collect_by, created_by)
			SELECT $1, $2, $3, $4,
			       CASE WHEN c.id IS NULL THEN 'waiting' ELSE 'ready' END,
			       c.id,
			       CASE WHEN c.id IS NULL THEN NULL ELSE now() END,
			       CASE WHEN c.id IS NULL THEN NULL ELSE current_date + 3 END,
			       $5
			  FROM (SELECT id FROM library_copies
			         WHERE title_id = $2 AND status = 'available'
			         ORDER BY accession_no LIMIT 1) c
			 RIGHT JOIN (SELECT 1) one ON true
			 RETURNING status`,
			id.InstitutionID, titleID, student, employee,
			nullUUIDArg(id.UserID)).Scan(&status); err != nil {
			return err
		}
		if status == "ready" {
			_, err := tx.Exec(r.Context(),
				`UPDATE library_copies SET status = 'reserved'
				  WHERE title_id = $1 AND status = 'available'`, titleID)
			return err
		}
		return nil
	})
	switch {
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "already_queued",
			"you are already in the queue for this title")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"status": status})
	}
}

// --- cataloguing -------------------------------------------------------------

type digitalHoldingRequest struct {
	ID          string   `json:"id,omitempty"`
	Kind        string   `json:"kind"`
	Title       string   `json:"title"`
	Author      string   `json:"author,omitempty"`
	Publisher   string   `json:"publisher,omitempty"`
	Identifier  string   `json:"identifier,omitempty"`
	Language    string   `json:"language,omitempty"`
	Description string   `json:"description,omitempty"`
	AccessModel string   `json:"access_model"`
	ProviderID  string   `json:"provider_id,omitempty"`
	CampusID    string   `json:"campus_id,omitempty"`
	ExternalURL string   `json:"external_url,omitempty"`
	FileID      string   `json:"file_id,omitempty"`
	SubjectTags []string `json:"subject_tags,omitempty"`
	LoanDays    int      `json:"loan_days,omitempty"`
	IsActive    *bool    `json:"is_active,omitempty"`
}

/*
saveDigitalHolding catalogues a title, and mints its shadow copy if it lends.

	The external_url fallback beside file_id is not an afterthought. POST
	/api/v1/files/presign answers 503 storage_unconfigured on this deployment,
	so a file-only design would ship a catalogue nobody could put anything in —
	the same reason addSQAAEvidence takes both. Exactly one of the two, checked
	here and again by a CHECK constraint.
*/
func (s *Server) saveDigitalHolding(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req digitalHoldingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.ExternalURL = strings.TrimSpace(req.ExternalURL)
	req.FileID = strings.TrimSpace(req.FileID)

	if req.Title == "" {
		httpx.BadRequest(w, r, "give the title a name")
		return
	}
	if !oneOfStr(req.Kind, "ebook", "journal", "database") {
		httpx.BadRequest(w, r, "kind must be ebook, journal or database")
		return
	}
	if !oneOfStr(req.AccessModel, "open", "subscription", "single_copy_loan") {
		httpx.BadRequest(w, r, "access must be open, subscription or single_copy_loan")
		return
	}
	if req.Kind == "database" && req.AccessModel == "single_copy_loan" {
		httpx.BadRequest(w, r,
			"a database is a place you search, not a thing one reader can borrow")
		return
	}
	if (req.ExternalURL == "") == (req.FileID == "") {
		httpx.BadRequest(w, r,
			"give exactly one of external_url or file_id (upload the file first)")
		return
	}
	if req.ExternalURL != "" &&
		!strings.HasPrefix(req.ExternalURL, "http://") && !strings.HasPrefix(req.ExternalURL, "https://") {
		httpx.BadRequest(w, r, "the link must start with http:// or https://")
		return
	}
	fileArg, err := optionalUUID(req.FileID)
	if err != nil {
		httpx.BadRequest(w, r, "file_id must be a uuid")
		return
	}
	providerArg, err := optionalUUID(req.ProviderID)
	if err != nil {
		httpx.BadRequest(w, r, "provider_id must be a uuid")
		return
	}
	campusArg, err := optionalUUID(req.CampusID)
	if err != nil {
		httpx.BadRequest(w, r, "campus_id must be a uuid")
		return
	}
	if req.LoanDays == 0 {
		req.LoanDays = 14
	}
	if req.LoanDays < 1 || req.LoanDays > 90 {
		httpx.BadRequest(w, r, "a loan runs between 1 and 90 days")
		return
	}
	tags := []string{}
	for _, t := range req.SubjectTags {
		t = strings.TrimSpace(t)
		if t != "" && len(tags) < 20 {
			tags = append(tags, t)
		}
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) == "" {
			err := tx.QueryRow(r.Context(), `
				INSERT INTO digital_holdings
				    (institution_id, campus_id, kind, title, author, publisher, identifier,
				     language, description, access_model, provider_id, external_url, file_id,
				     subject_tags, loan_days, is_active, created_by)
				VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),
				        NULLIF($8,''),NULLIF($9,''),$10,$11,NULLIF($12,''),$13,
				        $14,$15,$16,$17)
				RETURNING id::text`,
				id.InstitutionID, campusArg, req.Kind, req.Title, req.Author, req.Publisher,
				req.Identifier, req.Language, req.Description, req.AccessModel, providerArg,
				req.ExternalURL, fileArg, tags, req.LoanDays, active,
				nullUUIDArg(id.UserID)).Scan(&out)
			if err != nil {
				return err
			}
		} else {
			existing, err := uuid.Parse(req.ID)
			if err != nil {
				return errors.New("id must be a uuid")
			}
			tag, err := tx.Exec(r.Context(), `
				UPDATE digital_holdings
				   SET campus_id = $2, kind = $3, title = $4, author = NULLIF($5,''),
				       publisher = NULLIF($6,''), identifier = NULLIF($7,''),
				       language = NULLIF($8,''), description = NULLIF($9,''),
				       access_model = $10, provider_id = $11,
				       external_url = NULLIF($12,''), file_id = $13,
				       subject_tags = $14, loan_days = $15, is_active = $16,
				       updated_at = now()
				 WHERE id = $1`,
				existing, campusArg, req.Kind, req.Title, req.Author, req.Publisher,
				req.Identifier, req.Language, req.Description, req.AccessModel, providerArg,
				req.ExternalURL, fileArg, tags, req.LoanDays, active)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return pgx.ErrNoRows
			}
			out = existing.String()
		}
		if req.AccessModel != "single_copy_loan" {
			return nil
		}
		return ensureShadowCopy(r, tx, id.InstitutionID, out, req)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "duplicate_title",
			"that title is already in the digital catalogue for this campus")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out})
	}
}

/*
ensureShadowCopy gives a lendable e-book a row in the physical catalogue.

	This is the join that makes reuse possible rather than aspirational: one
	library_titles row, one library_copies row, and from there the hold queue,
	the issue desk and the return desk work on an e-book without knowing it is
	one. The accession number is prefixed DIG- so a stock audit scanning
	shelves does not report it missing — there is no shelf to find it on.

	Idempotent: called on every save, does nothing once the shadow exists.
*/
func ensureShadowCopy(r *http.Request, tx pgx.Tx, institutionID uuid.UUID,
	holdingID string, req digitalHoldingRequest) error {

	var existing *uuid.UUID
	if err := tx.QueryRow(r.Context(),
		`SELECT library_title_id FROM digital_holdings WHERE id = $1`,
		holdingID).Scan(&existing); err != nil {
		return err
	}
	if existing != nil {
		// Keep the shadow's bibliography in step with the catalogue entry, or
		// the hold queue shows a title the reader does not recognise.
		_, err := tx.Exec(r.Context(), `
			UPDATE library_titles
			   SET title = $2, author = NULLIF($3,''), publisher = NULLIF($4,'')
			 WHERE id = $1`, *existing, req.Title, req.Author, req.Publisher)
		return err
	}

	// library_titles.campus_id is NOT NULL, and a holding may legitimately
	// belong to every campus. Fall back to the school's first campus rather
	// than refuse to catalogue: the shadow row is bookkeeping, and the campus
	// that matters for visibility is the one on the holding.
	var titleID uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO library_titles
		    (institution_id, campus_id, title, author, publisher, category, language)
		SELECT $1,
		       COALESCE((SELECT h.campus_id FROM digital_holdings h WHERE h.id = $2),
		                (SELECT c.id FROM campuses c ORDER BY c.name LIMIT 1)),
		       $3, NULLIF($4,''), NULLIF($5,''), 'digital', NULLIF($6,'')
		 RETURNING id`,
		institutionID, holdingID, req.Title, req.Author, req.Publisher,
		req.Language).Scan(&titleID); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO library_copies (institution_id, title_id, accession_no, rack, status)
		VALUES ($1, $2, 'DIG-' || upper(substr(replace($2::text,'-',''), 1, 10)),
		        'digital', 'available')`,
		institutionID, titleID); err != nil {
		return err
	}
	_, err := tx.Exec(r.Context(),
		`UPDATE digital_holdings SET library_title_id = $2 WHERE id = $1`,
		holdingID, titleID)
	return err
}

func (s *Server) deleteDigitalHolding(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	holdingID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// A title somebody is holding is not a title to delete out from under
		// them. Withdrawing it (is_active = false) is the right move and the
		// screen offers it.
		var lent bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM digital_holdings h
			                 JOIN library_copies c ON c.title_id = h.library_title_id
			                 JOIN library_loans l ON l.copy_id = c.id AND l.returned_on IS NULL
			                WHERE h.id = $1)`, holdingID).Scan(&lent); err != nil {
			return err
		}
		if lent {
			return errors.New("that e-book is on loan — take it back first, or withdraw it instead")
		}
		tag, err := tx.Exec(r.Context(), `DELETE FROM digital_holdings WHERE id = $1`, holdingID)
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	case n == 0:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
	}
}

type digitalVisibilityRequest struct {
	ClassIDs []string `json:"class_ids"`
	RoleKeys []string `json:"role_keys"`
}

/*
setDigitalVisibility replaces the rules on one holding.

	A replace rather than add/remove endpoints because the librarian's screen
	is a set of checkboxes and a set of checkboxes is a whole answer. Sending
	both lists empty means "everyone", which is the documented meaning of no
	rules and is stated on the screen rather than left to be discovered.
*/
func (s *Server) setDigitalVisibility(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	holdingID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var req digitalVisibilityRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	classes := make([]uuid.UUID, 0, len(req.ClassIDs))
	for _, c := range req.ClassIDs {
		v, err := uuid.Parse(strings.TrimSpace(c))
		if err != nil {
			httpx.BadRequest(w, r, "class_ids must be uuids")
			return
		}
		classes = append(classes, v)
	}
	roles := []string{}
	for _, k := range req.RoleKeys {
		k = strings.TrimSpace(k)
		if k != "" {
			roles = append(roles, k)
		}
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM digital_holdings WHERE id = $1)`,
			holdingID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return pgx.ErrNoRows
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM digital_holding_visibility WHERE holding_id = $1`, holdingID); err != nil {
			return err
		}
		// Both inserts are set-based over an array, so a librarian ticking
		// twelve classes is one statement rather than twelve round trips.
		if len(classes) > 0 {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO digital_holding_visibility (holding_id, class_id)
				SELECT $1, c.id FROM classes c WHERE c.id = ANY($2)`,
				holdingID, classes); err != nil {
				return err
			}
		}
		if len(roles) > 0 {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO digital_holding_visibility (holding_id, role_key)
				SELECT $1, ro.key FROM roles ro
				 WHERE ro.key = ANY($2)
				   AND (ro.institution_id = app_current_institution() OR ro.institution_id IS NULL)`,
				holdingID, roles); err != nil {
				return err
			}
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
	}
}

// --- audiences ---------------------------------------------------------------

type digitalAudienceResponse struct {
	Classes []digitalNamed `json:"classes"`
	Roles   []digitalNamed `json:"roles"`
}

type digitalNamed struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// listDigitalAudiences answers the two lists the visibility checkboxes need.
func (s *Server) listDigitalAudiences(w http.ResponseWriter, r *http.Request) {
	classes, err := collect(s, r, `
		SELECT id::text, name FROM classes ORDER BY level, name`, nil,
		func(rows pgx.Rows) (digitalNamed, error) {
			var v digitalNamed
			return v, rows.Scan(&v.ID, &v.Name)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	roles, err := collect(s, r, `
		SELECT key, name FROM roles
		 WHERE institution_id = app_current_institution() OR institution_id IS NULL
		 ORDER BY name`, nil,
		func(rows pgx.Rows) (digitalNamed, error) {
			var v digitalNamed
			return v, rows.Scan(&v.ID, &v.Name)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, digitalAudienceResponse{Classes: classes, Roles: roles})
}

// --- providers ---------------------------------------------------------------

func (s *Server) listDigitalProviders(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT p.id::text, p.kind, p.name, p.base_url, p.has_credentials, p.status, p.notes,
		       (SELECT count(*)::int FROM digital_holdings h WHERE h.provider_id = p.id)
		  FROM digital_library_providers p
		 ORDER BY p.name`, nil,
		func(rows pgx.Rows) (digitalProviderRow, error) {
			var v digitalProviderRow
			return v, rows.Scan(&v.ID, &v.Kind, &v.Name, &v.BaseURL,
				&v.HasCredentials, &v.Status, &v.Notes, &v.Holdings)
		})
	respond(w, r, items, err)
}

type digitalProviderRequest struct {
	ID             string `json:"id,omitempty"`
	Kind           string `json:"kind"`
	Name           string `json:"name"`
	BaseURL        string `json:"base_url,omitempty"`
	HasCredentials bool   `json:"has_credentials,omitempty"`
	Notes          string `json:"notes,omitempty"`
}

/*
saveDigitalProvider records a subscription the school holds.

	Note what it does not accept: a password. A sealed credential column exists
	in this codebase for Tally, where there is a working integration to use it
	with; storing a school's EBSCO password to do nothing with would be
	collecting a secret for no purpose, which the DPDP Act makes expensive and
	which is bad practice in any case. has_credentials records only that the
	librarian has them, out of band.

	status is not settable from here either. It stays 'unavailable' until the
	link resolver can actually resolve, which is a code change.
*/
func (s *Server) saveDigitalProvider(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req digitalProviderRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.BaseURL = strings.TrimSpace(req.BaseURL)
	if req.Name == "" {
		httpx.BadRequest(w, r, "give the provider a name")
		return
	}
	if !oneOfStr(req.Kind, "ebsco", "jstor", "proquest", "other") {
		httpx.BadRequest(w, r, "provider must be ebsco, jstor, proquest or other")
		return
	}
	if req.BaseURL != "" &&
		!strings.HasPrefix(req.BaseURL, "http://") && !strings.HasPrefix(req.BaseURL, "https://") {
		httpx.BadRequest(w, r, "the base URL must start with http:// or https://")
		return
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if strings.TrimSpace(req.ID) == "" {
			return tx.QueryRow(r.Context(), `
				INSERT INTO digital_library_providers
				    (institution_id, kind, name, base_url, has_credentials, notes)
				VALUES ($1,$2,$3,NULLIF($4,''),$5,NULLIF($6,''))
				RETURNING id::text`,
				id.InstitutionID, req.Kind, req.Name, req.BaseURL,
				req.HasCredentials, req.Notes).Scan(&out)
		}
		existing, err := uuid.Parse(req.ID)
		if err != nil {
			return errors.New("id must be a uuid")
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE digital_library_providers
			   SET kind = $2, name = $3, base_url = NULLIF($4,''),
			       has_credentials = $5, notes = NULLIF($6,''), updated_at = now()
			 WHERE id = $1`,
			existing, req.Kind, req.Name, req.BaseURL, req.HasCredentials, req.Notes)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		out = existing.String()
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case isUniqueViolation(err):
		httpx.Error(w, r, http.StatusConflict, "duplicate_provider",
			"that provider is already recorded")
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "status": "unavailable"})
	}
}

func (s *Server) deleteDigitalProvider(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	providerID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The holdings survive; they just stop pointing at a subscription. The
		// FK is ON DELETE SET NULL and this is only saying so out loud.
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM digital_library_providers WHERE id = $1`, providerID)
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		httpx.Internal(w, r, err)
	case n == 0:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
	}
}
