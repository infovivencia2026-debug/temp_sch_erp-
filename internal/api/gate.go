package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/entitlement"
	"github.com/school-erp/erp/internal/httpx"
)

/* The paywall.

   An account that belongs to a school with no subscription can still sign in.
   That is deliberate and it is not generosity: the alternative is a head
   teacher who cannot reach a term's attendance because an invoice is late,
   which turns a billing problem into a safeguarding one. They get in, they see
   their school's name, and they see exactly one thing — what is owed and how
   to fix it.

   Enforcement lives here rather than in the catalog, because a catalog is a
   menu and a menu is not a lock. Hiding a module from the navigation stops an
   honest user clicking it; it does nothing about the request that arrives
   anyway, and every one of these endpoints is reachable with curl and a
   session cookie.

   Two things are deliberately still reachable while locked:

     * the session and the catalog, or the client cannot render the notice
       explaining why everything else is refused
     * a user's own profile and password, because being unable to change your
       password while your school's invoice is unpaid is absurd

   402 rather than 403: the request was understood and the caller is who they
   say they are. Nothing about their permissions is wrong — somebody has to
   pay. A 403 would send an administrator hunting through role assignments for
   a problem that is not there. */

// entitlementFor resolves the caller's school standing. Platform staff have
// nothing to buy and are never gated.
func (s *Server) entitlementFor(r *http.Request) (entitlement.State, error) {
	id := httpx.IdentityFrom(r.Context())
	if id == nil || id.InstitutionID == uuid.Nil {
		return entitlement.Platform(), nil
	}
	var st entitlement.State
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		st, err = entitlement.Resolve(r.Context(), tx, id.InstitutionID)
		return err
	})
	return st, err
}

// openWhileLocked are the paths a locked school may still reach. Matched as
// prefixes against the path below /api/v1.
//
// Kept as a short explicit list rather than a pattern: every addition here is
// a decision to give something away free, and that should read like one.
var openWhileLocked = []string{
	"/session",  // so the client knows why it is locked
	"/catalog",  // so it can render the shell and the notice
	"/me",       // the user's own account
	"/profile",  // and their own profile
	"/ref-data", // static lookups the shell needs to render at all
}

// RequireSubscription refuses tenant work for a school that is not paying.
func (s *Server) RequireSubscription(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := httpx.IdentityFrom(r.Context())
		// Unauthenticated requests are somebody else's problem: the auth
		// middleware has already refused them, and answering 402 here would
		// tell a stranger whether a school is behind on its bill.
		if id == nil || id.InstitutionID == uuid.Nil {
			next.ServeHTTP(w, r)
			return
		}
		path := apiPath(r)
		for _, p := range openWhileLocked {
			if pathHasPrefix(path, p) {
				next.ServeHTTP(w, r)
				return
			}
		}

		st, err := s.entitlementFor(r)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if !st.Active {
			httpx.Error(w, r, http.StatusPaymentRequired, "subscription_"+st.Code, st.Reason)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// apiPath is the request path relative to the API root.
//
// r.URL.Path still carries the /api/v1 prefix inside a mounted sub-router —
// chi rewrites its own RouteContext, not the URL — so matching the allow-list
// against r.URL.Path would never hit, and a locked school would have been
// refused even the session call that explains why.
func apiPath(r *http.Request) string {
	if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePath != "" {
		return rc.RoutePath
	}
	if i := strings.Index(r.URL.Path, "/api/v1"); i >= 0 {
		return r.URL.Path[i+len("/api/v1"):]
	}
	return r.URL.Path
}

// pathHasPrefix matches a path segment-wise, so /profiles does not match
// /profile. Prefix matching on raw strings is how "location /admin" ends up
// swallowing /admin-portal.
func pathHasPrefix(path, prefix string) bool {
	if len(path) < len(prefix) || path[:len(prefix)] != prefix {
		return false
	}
	return len(path) == len(prefix) || path[len(prefix)] == '/'
}
