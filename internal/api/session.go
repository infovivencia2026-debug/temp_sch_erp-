package api

import (
	"net/http"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type sessionResponse struct {
	Authenticated bool          `json:"authenticated"`
	User          *sessionUser  `json:"user,omitempty"`
	Institution   *institution  `json:"institution,omitempty"`
	Permissions   []string      `json:"permissions"`
	Modules       []moduleState `json:"modules,omitempty"`
}

type sessionUser struct {
	ID            string   `json:"id"`
	FullName      string   `json:"full_name"`
	Roles         []string `json:"roles"`
	PlatformAdmin bool     `json:"platform_admin"`
}

type institution struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ShortName    string `json:"short_name"`
	Slug         string `json:"slug"`
	PrimaryColor string `json:"primary_color"`
	Timezone     string `json:"timezone"`
	Locale       string `json:"locale"`
}

type moduleState struct {
	Module  string `json:"module"`
	Enabled bool   `json:"enabled"`
}

// getSession is the SPA's boot call. It answers 200 either way so the client
// can branch on `authenticated` instead of treating a 401 as an error state.
func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id == nil {
		httpx.JSON(w, http.StatusOK, sessionResponse{Authenticated: false, Permissions: []string{}})
		return
	}

	perms := make([]string, 0, len(id.Permissions))
	for p := range id.Permissions {
		perms = append(perms, p)
	}
	sort.Strings(perms)

	resp := sessionResponse{
		Authenticated: true,
		Permissions:   perms,
		User: &sessionUser{
			ID:            id.UserID.String(),
			FullName:      id.FullName,
			PlatformAdmin: id.PlatformAdmin,
			Roles:         []string{},
		},
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if !id.PlatformAdmin {
			var inst institution
			err := tx.QueryRow(r.Context(), `
				SELECT id::text, name, short_name, slug::text, primary_color, timezone, locale
				  FROM institutions WHERE id = $1`, id.InstitutionID).
				Scan(&inst.ID, &inst.Name, &inst.ShortName, &inst.Slug,
					&inst.PrimaryColor, &inst.Timezone, &inst.Locale)
			if err != nil && err != pgx.ErrNoRows {
				return err
			}
			if err == nil {
				resp.Institution = &inst
			}
		}

		rows, err := tx.Query(r.Context(), `
			SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id = $1 ORDER BY r.key`, id.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			resp.User.Roles = append(resp.User.Roles, k)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// module_settings drives which of the ~50 SPA modules are switched on
		// for this tenant, so the client can hide what the school has not
		// bought rather than 403-ing the user after they click.
		mrows, err := tx.Query(r.Context(),
			`SELECT module, enabled FROM module_settings ORDER BY module`)
		if err != nil {
			return err
		}
		defer mrows.Close()
		for mrows.Next() {
			var m moduleState
			if err := mrows.Scan(&m.Module, &m.Enabled); err != nil {
				return err
			}
			resp.Modules = append(resp.Modules, m)
		}
		return mrows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, resp)
}
