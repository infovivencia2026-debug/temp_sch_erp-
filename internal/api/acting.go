package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
)

/* Letting a platform operator stand inside a school.

   super_admin has no institution_id — that absence is what marks them as
   platform staff, and RLS gives them nothing without it. But the catalogue
   lists "Institutions & campuses" and "Academic year defaults" under Super
   Admin, because setting a new school up is exactly their job. Those screens
   asked for a school the account did not have and answered 500.

   Rather than special-casing every setup handler, a platform operator names
   the school they are working on and the request runs as if they were in it.
   The choice is per-request and never inferred: an operator who forgets to
   pick one is told to, which is safer than silently landing on whichever
   school happens to sort first.

   PlatformAdmin stays true alongside the chosen institution. It is what it
   has always been — a statement about who the person is, not about which
   tenant this request touches. */

const actingHeader = "X-Acting-Institution"

// ActingInstitution lets a platform operator — or a board member who oversees
// more than one school — scope a request to one of them.
//
// For an ordinary tenant user who oversees nothing, this is a no-op: their
// institution comes from their session and nothing in a request may widen it.
// That is the whole security property, so the middleware never amends an
// identity it has not first proven the caller is entitled to stand in.
//
// SECURITY INVARIANT: a non-platform actor NEVER gets app_is_platform_admin.
// The platform path below keeps id.PlatformAdmin true (a statement about who
// the person is, not which tenant this request touches). The board-member path
// leaves id.PlatformAdmin FALSE, so the acted school's data is read under
// normal RLS with the caller's own board_member grants in that school and
// nothing more — one school's rows can never leak into another's. The only
// cross-tenant read here is the read-only membership+status probe, done with
// AsPlatform exactly like the platform path's status read; the actual data
// requests downstream are never run as platform.
func ActingInstitution(db *database.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := httpx.IdentityFrom(r.Context())
			if id == nil {
				next.ServeHTTP(w, r)
				return
			}

			raw := r.Header.Get(actingHeader)
			if raw == "" {
				raw = r.URL.Query().Get("institution_id")
			}
			if raw == "" {
				next.ServeHTTP(w, r)
				return
			}

			want, err := uuid.Parse(raw)
			if err != nil {
				httpx.BadRequest(w, r, "institution_id must be a uuid")
				return
			}

			if id.PlatformAdmin {
				actAsPlatform(db, next, w, r, id, want)
				return
			}

			/* An API key is never a person and never a board member: its
			   institution comes from its own row and no header may move it. The
			   board-member switch is for real users who hold a role in another
			   school; a machine integration holds none and must stay in the one
			   school it was issued for. Ignored silently, exactly as the header
			   was ignored for every non-platform caller before this change. */
			if id.APIKey {
				next.ServeHTTP(w, r)
				return
			}
			actAsBoardMember(db, next, w, r, id, want)
		})
	}
}

// actAsPlatform is the original platform-operator path, unchanged: a vendor
// operator names the school they are working on and the request runs as if
// they were inside it, with PlatformAdmin still true.
func actAsPlatform(db *database.DB, next http.Handler, w http.ResponseWriter, r *http.Request,
	id *httpx.Identity, want uuid.UUID) {
	/* Verified against the table rather than trusted: an unchecked id
	   would set the tenant GUC to a value no row matches, and every
	   query would quietly return nothing instead of saying why.

	   Any school that exists, not only an active one. Suspending is a
	   thing the vendor DOES to a school, and they have to be able to
	   work inside it afterwards — to read what it owes, to look at
	   what it holds, and above all to switch it back on. Requiring
	   'active' here meant suspending a school you were acting on
	   locked you out of the whole product: this middleware runs in
	   front of /api/v1/catalog too, so the menu itself came back 404
	   and there was no screen left to clear the selection from.

	   The suspension still bites where it is meant to. The school's
	   own people are refused at sign-in; this is the vendor, who is
	   the one who suspended them. */
	var status string
	if err := db.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT status FROM institutions WHERE id = $1`, want).Scan(&status)
	}); err != nil {
		if err == pgx.ErrNoRows {
			/* Say which id, and that clearing it is the way out.

			   "resource not found" was the whole message, on every
			   request including the catalogue, so the screen showed an
			   error with no menu and no hint that a stale selection in
			   this tab was the cause. */
			httpx.Error(w, r, http.StatusNotFound, "no_such_school",
				"there is no school with id "+want.String()+
					". Pick a school again. This tab is holding one that no longer exists.")
			return
		}
		httpx.Internal(w, r, err)
		return
	}

	/* Amended in place, not copied.

	   AuditMiddleware wraps the whole router and reads the identity
	   from its own request, which still points at the original
	   Identity. A copy therefore told every handler downstream which
	   school the operator had entered while the audit trail recorded
	   none — every vendor mutation was written with a null
	   institution_id, and listAudit is tenant-scoped, so the school
	   could never see what was done inside its own data. That
	   falsified the promise at the top of this file.

	   Safe because the session store allocates a fresh Identity per
	   request; nothing else holds this pointer. */
	id.InstitutionID = want
	next.ServeHTTP(w, r)
}

// actAsBoardMember lets a non-platform user stand inside another school, but
// ONLY one where they hold a user_roles row (their board_member grant). This
// is the cross-tenant switch a board member uses; it never grants platform
// powers.
func actAsBoardMember(db *database.DB, next http.Handler, w http.ResponseWriter, r *http.Request,
	id *httpx.Identity, want uuid.UUID) {
	// Switching to your own home is a no-op: no cross-tenant reach, nothing to
	// prove, nothing to amend. Handled first so a client that always sends the
	// header costs nothing when it names home.
	if want == id.InstitutionID {
		next.ServeHTTP(w, r)
		return
	}

	/* Membership is checked with AsPlatform because it is the ONE thing that
	   legitimately reads across tenants here: user_roles is under per-institution
	   RLS and the caller's current tenant is their home, so a normal read could
	   never see a row in the school they are asking to enter. This mirrors the
	   platform path's status read exactly — read-only, one row — and is the only
	   AsPlatform use on this path. The amend below keeps PlatformAdmin false, so
	   the request's data still runs under the target school's RLS.

	   Non-member and non-existent are deliberately answered with the SAME 403:
	   a board member must not be able to probe which institution ids exist by
	   watching the error change. Existence is only ever revealed (via the
	   suspended message) to someone who already oversees the school. */
	var member bool
	var status string
	err := db.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT EXISTS(SELECT 1 FROM user_roles
			               WHERE user_id = $1 AND institution_id = $2),
			       COALESCE((SELECT status FROM institutions WHERE id = $2), '')`,
			id.UserID, want).Scan(&member, &status)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !member {
		httpx.Denied(w, r, "you do not oversee that school")
		return
	}
	/* A board member is a school user, not the vendor. Unlike the vendor — who
	   suspended the school and must still be able to work inside it to switch it
	   back on — a board member is refused a suspended school just as its own
	   people are refused at sign-in. */
	if status == "suspended" {
		httpx.Denied(w, r, "that school is suspended")
		return
	}

	// Amended in place, for the same reason the platform path is: the audit
	// middleware holds this pointer and must record the school actually entered.
	// PlatformAdmin stays false — RLS is NOT bypassed for the data reads.
	id.InstitutionID = want
	next.ServeHTTP(w, r)
}

// membershipRow is one school the signed-in user may switch between.
type membershipRow struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	IsHome bool   `json:"is_home"`
}

// listMyInstitutions returns the schools the signed-in user oversees — every
// institution where they hold a user_roles row, plus their home — so the client
// can offer a switcher. A user with a single membership gets one entry and the
// switcher hides itself.
//
// Gated on nothing beyond being signed in: it returns only THIS user's own
// memberships and reveals no school they are not already in. The cross-tenant
// gather is read-only AsPlatform, the same narrow use the acting middleware
// makes — it never widens what any later data request may read.
func (s *Server) listMyInstitutions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id == nil {
		httpx.Denied(w, r, "sign in first")
		return
	}

	// Home is passed as a nullable uuid: a platform operator has none, and then
	// the UNION below contributes nothing and is_home is never true.
	var home *uuid.UUID
	if id.InstitutionID != uuid.Nil {
		h := id.InstitutionID
		home = &h
	}

	items := []membershipRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name, (i.id = $2) AS is_home
			  FROM institutions i
			 WHERE i.id IN (
			         SELECT ur.institution_id
			           FROM user_roles ur
			          WHERE ur.user_id = $1 AND ur.institution_id IS NOT NULL
			         UNION
			         SELECT $2::uuid WHERE $2::uuid IS NOT NULL)
			 ORDER BY (i.id = $2) DESC, i.name`,
			id.UserID, home)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v membershipRow
			if err := rows.Scan(&v.ID, &v.Name, &v.IsHome); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type institutionRow struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Short    string  `json:"short_name"`
	Slug     string  `json:"slug"`
	District *string `json:"district,omitempty"`
	UDISE    *string `json:"udise_code,omitempty"`
	Students int     `json:"students"`
	Status   string  `json:"status"`
}

// listInstitutions is the platform operator's school picker, and the only
// place in the API that deliberately reads across tenants.
func (s *Server) listInstitutions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id == nil || !id.PlatformAdmin {
		httpx.Denied(w, r, "only a platform operator can list every school")
		return
	}

	items := []institutionRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name, i.short_name, i.slug, i.district, i.udise_code,
			       (SELECT count(*) FROM students st
			         WHERE st.institution_id = i.id AND st.status = 'active')::int,
			       i.status
			  FROM institutions i
			 ORDER BY i.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v institutionRow
			if err := rows.Scan(&v.ID, &v.Name, &v.Short, &v.Slug, &v.District,
				&v.UDISE, &v.Students, &v.Status); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
