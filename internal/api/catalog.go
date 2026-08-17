package api

import (
	"net/http"
	"sort"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/scope"
)

type catalogResponse struct {
	ActiveRole  string        `json:"active_role"`
	Roles       []catalogRole `json:"roles"`
	Scope       resolvedScope `json:"scope"`
	Implemented []string      `json:"implemented"`
}

type catalogRole struct {
	Key      string           `json:"key"`
	Name     string           `json:"name"`
	Sections []catalogSection `json:"sections"`
}

type catalogSection struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	// Workspace is the level the sidebar shows: a role has 6-9 of them, and
	// each gathers several sections. Sent as a label rather than as nesting so
	// the response shape — and every feature key in it — is unchanged.
	Workspace string           `json:"workspace"`
	Features  []catalogFeature `json:"features"`
}

type catalogFeature struct {
	Key     string `json:"key"`
	Slug    string `json:"slug"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
	Scope   string `json:"scope"`
	// Tier is core, advanced or optional. It decides how prominent a feature is
	// in navigation, never whether the caller may use it — authorisation is the
	// grant above, and a tiered-down feature is still routable and still gated.
	Tier string `json:"tier"`
	// InScope is false when the user holds the grant but has no data behind it
	// — a department head with no department, a teacher with no sections. The
	// SPA greys these out rather than routing to an empty screen.
	InScope bool `json:"in_scope"`
	// Live marks features with a real implementation behind them. Everything
	// else is catalogued and navigable but renders a stub, which is honest
	// rather than a screen of invented data.
	Live bool `json:"live"`
}

type resolvedScope struct {
	PlatformAdmin bool `json:"platform_admin"`
	AllCampuses   bool `json:"all_campuses"`
	Campuses      int  `json:"campuses"`
	Departments   int  `json:"departments"`
	Sections      int  `json:"sections"`
	Students      int  `json:"students"`
}

// getCatalog returns the signed-in user's workspace: the roles they hold, the
// sections and features within each, and whether each is reachable.
//
// The SPA builds its entire navigation from this rather than from a hardcoded
// menu, so revoking a grant removes the nav entry on next load with no client
// release.
func (s *Server) getCatalog(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	sc, err := scope.Resolve(r.Context(), s.DB, id)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	resp := catalogResponse{
		Roles: []catalogRole{},
		Scope: resolvedScope{
			PlatformAdmin: sc.PlatformAdmin,
			AllCampuses:   sc.AllCampuses,
			Campuses:      len(sc.CampusIDs),
			Departments:   len(sc.DepartmentIDs),
			Sections:      len(sc.SectionIDs),
			Students:      len(sc.StudentIDs),
		},
		Implemented: []string{},
	}
	for k := range implementedFeatures {
		resp.Implemented = append(resp.Implemented, k)
	}
	sort.Strings(resp.Implemented)

	// A user may legitimately hold several catalog roles (a principal who also
	// teaches). Emit every role they have at least one grant in, and let the
	// client switch between them.
	for _, role := range catalog.Roles {
		out := catalogRole{Key: role.Key, Name: role.Name, Sections: []catalogSection{}}

		for _, sec := range role.Sections {
			cs := catalogSection{
				Slug: sec.Slug, Name: sec.Name, Workspace: sec.Workspace,
				Features: []catalogFeature{},
			}
			for _, f := range sec.Features {
				if !id.Can(f.Key) {
					continue
				}
				cs.Features = append(cs.Features, catalogFeature{
					Key:     f.Key,
					Slug:    f.Slug,
					Name:    f.Name,
					Summary: f.Summary,
					Scope:   string(f.Scope),
					Tier:    string(f.Tier),
					InScope: sc.HasScope(f.Scope),
					Live:    implementedFeatures[f.Key],
				})
			}
			if len(cs.Features) > 0 {
				out.Sections = append(out.Sections, cs)
			}
		}

		if len(out.Sections) > 0 {
			resp.Roles = append(resp.Roles, out)
		}
	}

	if len(resp.Roles) > 0 {
		resp.ActiveRole = resp.Roles[0].Key
	}
	httpx.JSON(w, http.StatusOK, resp)
}
