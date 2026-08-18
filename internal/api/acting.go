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

// ActingInstitution lets a platform operator scope a request to one school.
//
// Ignored entirely for ordinary users: their institution comes from their
// session and nothing in a request may widen it. That check is the whole
// security property here, so it is the first thing the middleware does.
func ActingInstitution(db *database.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := httpx.IdentityFrom(r.Context())
			if id == nil || !id.PlatformAdmin {
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

			// Verified against the table rather than trusted: an unchecked id
			// would set the tenant GUC to a value no row matches, and every
			// query would quietly return nothing instead of saying why.
			var exists bool
			if err := db.AsPlatform(r.Context(), func(tx pgx.Tx) error {
				return tx.QueryRow(r.Context(),
					`SELECT true FROM institutions WHERE id = $1 AND status = 'active'`,
					want).Scan(&exists)
			}); err != nil {
				if err == pgx.ErrNoRows {
					httpx.NotFound(w, r)
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
		})
	}
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
