package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/httpx"
)

/* Features (menu tiles) as a school reads them.

   The capability grid (role_grid.go) answers "what can this role do". This
   editor answers a different question: "what does this role see". The SPA menu
   is built from GET /api/v1/catalog, and a section's feature appears there only
   when id.Can(f.Key) is true — that is, when the role holds a role_permissions
   row for the catalog feature key role.section.feature. So enabling a tile is an
   insert of its feature key, and disabling it is a delete.

   This endpoint touches ONLY catalog feature keys of the role's own workspace.
   It deliberately never writes a capability key (those in rbac.All): the grid
   owns those, and a feature toggle that could grant "students.write.any" would
   be a privilege-escalation path wearing a checkbox. Validation below rejects
   any key that is not a feature key of THIS role's workspace, which excludes
   capability keys and other roles' feature keys alike.

   Note on persistence: deploy runs `migrate up` only, not `migrate seed`, so
   these manual toggles persist across deploys. A future `migrate seed`
   (rbac.SeedCatalogRoles) would rewrite a role's feature keys from code — that
   is existing seeder behaviour, not this endpoint's concern. */

type roleFeature struct {
	Key     string `json:"key"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
	Held    bool   `json:"held"`
}

type roleFeatureSection struct {
	Slug     string        `json:"slug"`
	Name     string        `json:"name"`
	Features []roleFeature `json:"features"`
}

type roleFeatures struct {
	Workspace bool                 `json:"workspace"`
	Sections  []roleFeatureSection `json:"sections"`
}

// catalogRoleByKey finds the catalog workspace for a role key, if it has one.
func catalogRoleByKey(key string) (catalog.Role, bool) {
	for _, role := range catalog.Roles {
		if role.Key == key {
			return role, true
		}
	}
	return catalog.Role{}, false
}

// roleFeatureKeys is the set of every catalog feature key in a role's workspace.
// It is both what the editor renders and what it validates a write against.
func roleFeatureKeys(role catalog.Role) map[string]bool {
	keys := make(map[string]bool)
	for _, sec := range role.Sections {
		for _, f := range sec.Features {
			keys[f.Key] = true
		}
	}
	return keys
}

// buildRoleFeatures joins the role's catalog workspace onto the feature keys it
// currently holds, marking each tile held or not.
func buildRoleFeatures(role catalog.Role, held map[string]bool) roleFeatures {
	out := roleFeatures{Workspace: true, Sections: []roleFeatureSection{}}
	for _, sec := range role.Sections {
		cs := roleFeatureSection{Slug: sec.Slug, Name: sec.Name, Features: []roleFeature{}}
		for _, f := range sec.Features {
			cs.Features = append(cs.Features, roleFeature{
				Key: f.Key, Name: f.Name, Summary: f.Summary, Held: held[f.Key],
			})
		}
		out.Sections = append(out.Sections, cs)
	}
	return out
}

// heldFeatureKeys reads the feature keys a role currently holds. It returns
// every permission_key row; the caller keeps only the ones that are catalog
// feature keys of the role's workspace.
func heldFeatureKeys(r *http.Request, tx pgx.Tx, roleID uuid.UUID) (map[string]bool, error) {
	rows, err := tx.Query(r.Context(),
		`SELECT permission_key FROM role_permissions WHERE role_id = $1`, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	held := make(map[string]bool)
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		held[k] = true
	}
	return held, rows.Err()
}

// getRoleFeatures returns a role's menu tiles, grouped by section, each marked
// held or not. A role with no catalog workspace (a custom role, or a role key
// absent from catalog.Roles) reports workspace:false and an empty list.
func (s *Server) getRoleFeatures(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	roleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid role id")
		return
	}

	var out roleFeatures
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var roleKey string
		if err := tx.QueryRow(r.Context(),
			`SELECT key FROM roles WHERE id = $1`, roleID).Scan(&roleKey); err != nil {
			return err
		}
		role, ok := catalogRoleByKey(roleKey)
		if !ok {
			out = roleFeatures{Workspace: false, Sections: []roleFeatureSection{}}
			return nil
		}
		held, err := heldFeatureKeys(r, tx, roleID)
		if err != nil {
			return err
		}
		out = buildRoleFeatures(role, held)
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type setFeaturesRequest struct {
	Enable  []string `json:"enable"`
	Disable []string `json:"disable"`
}

// setRoleFeatures enables and disables menu tiles for a role. Every key in both
// lists must be a catalog feature key of THIS role's workspace; anything else is
// a 400, which is what keeps a capability key or another role's key out.
func (s *Server) setRoleFeatures(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	roleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid role id")
		return
	}
	var req setFeaturesRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var out roleFeatures
	/* One transaction, and the same scope role_grid.go uses.

	   role_permissions is under forced RLS: a write lands only when the row's
	   role belongs to app_current_institution(), or app.is_platform_admin is
	   set. tenantScope(id) carries the caller's institution and their platform
	   standing — the exact pattern setRoleGrid uses — so the tenant admin writes
	   their own role, the platform admin writes any, and neither can reach
	   another school's role by editing an id. */
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var roleKey string
		if err := tx.QueryRow(r.Context(),
			`SELECT key FROM roles WHERE id = $1`, roleID).Scan(&roleKey); err != nil {
			return err
		}
		role, ok := catalogRoleByKey(roleKey)
		if !ok {
			return errNoWorkspace
		}

		// Validate against this role's own workspace before any write, so a
		// stray key cannot half-apply and cannot smuggle in a capability grant.
		allowed := roleFeatureKeys(role)
		for _, k := range req.Enable {
			if !allowed[k] {
				return &featureKeyError{key: k}
			}
		}
		for _, k := range req.Disable {
			if !allowed[k] {
				return &featureKeyError{key: k}
			}
		}

		for _, k := range req.Enable {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO role_permissions (role_id, permission_key)
				VALUES ($1,$2) ON CONFLICT DO NOTHING`, roleID, k); err != nil {
				return err
			}
		}
		if len(req.Disable) > 0 {
			if _, err := tx.Exec(r.Context(), `
				DELETE FROM role_permissions
				 WHERE role_id = $1 AND permission_key = ANY($2)`, roleID, req.Disable); err != nil {
				return err
			}
		}

		held, err := heldFeatureKeys(r, tx, roleID)
		if err != nil {
			return err
		}
		out = buildRoleFeatures(role, held)
		return nil
	})
	var keyErr *featureKeyError
	switch {
	case errors.As(err, &keyErr):
		httpx.BadRequest(w, r, keyErr.key+" is not a feature of this role's workspace")
		return
	case errors.Is(err, errNoWorkspace):
		httpx.BadRequest(w, r, "this role has no workspace of its own")
		return
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

var errNoWorkspace = errors.New("role has no catalog workspace")

type featureKeyError struct{ key string }

func (e *featureKeyError) Error() string { return "unknown feature key " + e.key }
