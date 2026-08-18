package api

import (
	"net/http"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/entitlement"
	"github.com/school-erp/erp/internal/httpx"
)

type sessionResponse struct {
	Authenticated bool          `json:"authenticated"`
	User          *sessionUser  `json:"user,omitempty"`
	Institution   *institution  `json:"institution,omitempty"`
	Permissions   []string      `json:"permissions"`
	Modules       []moduleState `json:"modules,omitempty"`
	// Subscription is what the school has bought and whether it is paid up.
	// The client needs it before it renders anything: a locked school gets a
	// notice, not an empty dashboard that looks like the data was lost.
	Subscription *subscriptionState `json:"subscription,omitempty"`
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

// subscriptionState is the commercial half of "who am I", alongside the
// permissions half.
type subscriptionState struct {
	Active      bool     `json:"active"`
	Code        string   `json:"code,omitempty"`
	Reason      string   `json:"reason,omitempty"`
	PlanCode    string   `json:"plan_code,omitempty"`
	PlanName    string   `json:"plan_name,omitempty"`
	Status      string   `json:"status,omitempty"`
	TrialEndsOn string   `json:"trial_ends_on,omitempty"`
	Modules     []string `json:"modules"`
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
		if err := mrows.Err(); err != nil {
			return err
		}

		// The commercial standing, from the same transaction so it cannot
		// disagree with the modules read a few lines above.
		st, err := entitlement.Resolve(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		ss := &subscriptionState{
			Active: st.Active, Code: st.Code, Reason: st.Reason,
			PlanCode: st.PlanCode, PlanName: st.PlanName,
			Status: st.Status, Modules: st.Modules(),
		}
		if st.TrialEndsOn != nil {
			ss.TrialEndsOn = st.TrialEndsOn.Format("2006-01-02")
		}
		resp.Subscription = ss
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, resp)
}
