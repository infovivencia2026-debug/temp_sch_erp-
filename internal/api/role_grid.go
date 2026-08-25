package api

import (
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Roles as a school reads them.

   The permission table is the right storage and the wrong interface. Seventy
   keys shaped "academics.attendance.write.any" are precise, and a head teacher
   configuring a new accountant cannot act on them: the screen that lists them
   is a list of things to get wrong.

   These endpoints serve the same role as a grid of feature groups — Fees,
   Attendance, Staff — each with a level and a data scope, and write the grid
   back as keys. internal/rbac/model.go owns the mapping in both directions. */

type gridScopeOption struct {
	Scope string `json:"scope"`
	Label string `json:"label"`
}

type gridGroup struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Blurb string `json:"blurb"`
	Band  string `json:"band"`

	// Levels the group offers. Homework has no read key, so it goes straight
	// from None to Manage and the screen must not draw a View control.
	Levels []string `json:"levels"`

	CanApprove  bool   `json:"can_approve"`
	ApproveNote string `json:"approve_note,omitempty"`
	CanExport   bool   `json:"can_export"`

	ScopeOptions []gridScopeOption `json:"scope_options"`
	ScopeNote    string            `json:"scope_note,omitempty"`

	rbac.GroupState
}

type roleGrid struct {
	ID        string      `json:"id"`
	Key       string      `json:"key"`
	Name      string      `json:"name"`
	IsSystem  bool        `json:"is_system"`
	IsDefault bool        `json:"is_default"`
	Editable  bool        `json:"editable"`
	LockNote  string      `json:"lock_note,omitempty"`
	Users     int         `json:"users"`
	Groups    []gridGroup `json:"groups"`

	// FeatureGrants counts the catalog navigation keys this role carries. They
	// are not editable here and are reported so the total on screen reconciles
	// with the grant count on the roles list.
	FeatureGrants int `json:"feature_grants"`
}

// scopeLabels name the seven boundaries in the words a school uses. The keys
// match internal/scope, plus "own" and "linked_children" for the portals.
var scopeLabels = map[string]string{
	"platform":         "Every school",
	"institution":      "Whole school",
	"campus":           "Their campus",
	"department":       "Their department",
	"assigned_classes": "Their classes",
	"own":              "Only their own",
	"linked_children":  "Their children",
}

func scopeLabel(s string) string {
	if l, ok := scopeLabels[s]; ok {
		return l
	}
	return s
}

// approveNotes say what approval means for a group, because "Approve" on its
// own does not tell an administrator what they are handing over.
var approveNotes = map[string]string{
	"students": "Archive and withdraw a student record.",
	"marks":    "Issue report cards.",
	"fees":     "Issue refunds against a paid invoice.",
	"staff":    "Approve or reject leave requests.",
}

// loadRoleKeys reads one role's grants, split into capability keys (the grid)
// and everything else (catalog navigation, which the grid must not disturb).
func loadRoleKeys(r *http.Request, tx pgx.Tx, roleID uuid.UUID) (caps []string, features int, err error) {
	known := make(map[string]bool, len(rbac.All))
	for _, p := range rbac.All {
		known[p.Key] = true
	}
	rows, err := tx.Query(r.Context(),
		`SELECT permission_key FROM role_permissions WHERE role_id = $1`, roleID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, 0, err
		}
		if known[k] {
			caps = append(caps, k)
		} else {
			features++
		}
	}
	return caps, features, rows.Err()
}

// getRoleGrid renders one role as the configuration grid.
func (s *Server) getRoleGrid(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	roleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid role id")
		return
	}

	var out roleGrid
	var caps []string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT ro.id::text, ro.key, ro.name, ro.is_system, ro.is_default,
			       (SELECT count(*) FROM user_roles ur WHERE ur.role_id = ro.id)::int
			  FROM roles ro WHERE ro.id = $1`, roleID).
			Scan(&out.ID, &out.Key, &out.Name, &out.IsSystem, &out.IsDefault, &out.Users); err != nil {
			return err
		}
		caps, out.FeatureGrants, err = loadRoleKeys(r, tx, roleID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out.Editable = !out.IsSystem
	if out.IsSystem {
		// Editing a seeded role looks like it works and does not last: the next
		// migration re-runs the seeder, which replaces the role's grants with
		// the ones in code. Saying so here is the difference between a rule and
		// a silent reversion three weeks later.
		out.LockNote = "This is a built-in role. Its permissions are restored on every " +
			"upgrade, so changes here would not survive. Copy it to a custom role instead."
	}
	out.Groups = describeGroups(rbac.Read(caps))
	httpx.JSON(w, http.StatusOK, out)
}

// describeGroups joins a role's state onto the static description of each group.
func describeGroups(states []rbac.GroupState) []gridGroup {
	byKey := make(map[string]rbac.GroupState, len(states))
	for _, st := range states {
		byKey[st.Group] = st
	}
	out := make([]gridGroup, 0, len(rbac.Groups))
	for _, g := range rbac.Groups {
		row := gridGroup{
			Key: g.Key, Name: g.Name, Blurb: g.Blurb, Band: string(g.Band),
			CanApprove:  len(g.Approve) > 0,
			ApproveNote: approveNotes[g.Key],
			CanExport:   len(g.Export) > 0,
			ScopeNote:   g.ScopeNote,
			GroupState:  byKey[g.Key],
		}
		for _, l := range g.Levels() {
			row.Levels = append(row.Levels, l.String())
		}
		for _, sc := range g.Scopes {
			row.ScopeOptions = append(row.ScopeOptions,
				gridScopeOption{Scope: sc.Scope, Label: scopeLabel(sc.Scope)})
		}
		out = append(out, row)
	}
	return out
}

type setGridRequest struct {
	Groups []rbac.GroupState `json:"groups"`
}

// setRoleGrid writes the grid back as permission keys.
func (s *Server) setRoleGrid(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	roleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid role id")
		return
	}
	var req setGridRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	// Validate before opening a transaction so a typo cannot half-apply.
	for _, st := range req.Groups {
		g, ok := rbac.GroupByKey(st.Group)
		if !ok {
			httpx.BadRequest(w, r, "unknown permission group "+st.Group)
			return
		}
		level, ok := rbac.ParseLevel(st.Level)
		if !ok {
			httpx.BadRequest(w, r, "unknown level "+st.Level+" for "+st.Group)
			return
		}
		offered := false
		for _, l := range g.Levels() {
			if l == level {
				offered = true
			}
		}
		if !offered {
			httpx.BadRequest(w, r, g.Name+" does not offer the "+st.Level+" level")
			return
		}
		if st.Scope != "" {
			known := false
			for _, sc := range g.Scopes {
				if sc.Scope == st.Scope {
					known = true
				}
			}
			if !known {
				httpx.BadRequest(w, r, g.Name+" cannot be scoped to "+st.Scope)
				return
			}
		}
	}

	desired := rbac.Apply(req.Groups)

	/* Two grants are withheld from this screen whatever the grid says.

	   platform.* spans every school on the installation. A tenant
	   administrator editing a role in their own school must not be able to
	   award themselves the vendor's console, and RLS would not stop them —
	   the role row is legitimately theirs, only the grant is not. */
	if !id.PlatformAdmin {
		for _, k := range desired {
			if k == rbac.PlatformTenantsRW || k == rbac.PlatformPlansRW {
				httpx.Denied(w, r, "platform permissions can only be granted by the vendor")
				return
			}
		}
	}

	var applied int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var isSystem bool
		var name string
		if err := tx.QueryRow(r.Context(),
			`SELECT is_system, name FROM roles WHERE id = $1`, roleID).Scan(&isSystem, &name); err != nil {
			return err
		}
		if isSystem {
			return errSystemRole
		}

		known := make([]string, 0, len(rbac.All))
		for _, p := range rbac.All {
			known = append(known, p.Key)
		}
		// Scoped to the capability vocabulary, so the role's catalog navigation
		// grants — which share this table and are not on this screen — survive.
		if _, err := tx.Exec(r.Context(), `
			DELETE FROM role_permissions
			 WHERE role_id = $1 AND permission_key = ANY($2) AND permission_key <> ALL($3)`,
			roleID, known, desired); err != nil {
			return err
		}
		for _, k := range desired {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO role_permissions (role_id, permission_key)
				VALUES ($1,$2) ON CONFLICT DO NOTHING`, roleID, k); err != nil {
				return err
			}
		}
		applied = len(desired)
		return nil
	})
	switch {
	case errors.Is(err, errSystemRole):
		httpx.Denied(w, r, "built-in roles cannot be edited — copy this role first, "+
			"otherwise the next upgrade would restore it")
		return
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": roleID.String(), "permissions": applied})
}

var errSystemRole = errors.New("system role")

type createRoleRequest struct {
	Name string `json:"name"`
	// CopyFrom is a role key whose grants seed the new role. Starting from a
	// blank role means clicking through the whole grid; starting from "faculty
	// plus one thing" is what a school actually wants.
	CopyFrom string `json:"copy_from,omitempty"`
}

// createRole makes a custom, editable role for this school.
func (s *Server) createRole(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req createRoleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		httpx.BadRequest(w, r, "a role needs a name")
		return
	}
	key := slugKey(name)
	if key == "" {
		httpx.BadRequest(w, r, "the name needs at least one letter or number")
		return
	}
	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var roleID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO roles (institution_id, key, name, is_system, is_default)
			VALUES ($1,$2,$3,false,false)
			RETURNING id`, id.InstitutionID, key, name).Scan(&roleID); err != nil {
			return err
		}
		newID = roleID.String()
		if req.CopyFrom == "" {
			return nil
		}
		// Capability keys only. Copying the source's catalog grants would give
		// the new role a navigation tree keyed to somebody else's role name,
		// and every one of those keys starts with the source role's own key.
		known := make([]string, 0, len(rbac.All))
		for _, p := range rbac.All {
			known = append(known, p.Key)
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO role_permissions (role_id, permission_key)
			SELECT $1, rp.permission_key
			  FROM role_permissions rp
			  JOIN roles src ON src.id = rp.role_id
			 WHERE src.key = $2 AND rp.permission_key = ANY($3)
			ON CONFLICT DO NOTHING`, roleID, req.CopyFrom, known)
		return err
	})
	if err != nil {
		if strings.Contains(err.Error(), "roles_institution_key") {
			httpx.BadRequest(w, r, "a role called "+name+" already exists")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "key": key, "name": name})
}

// slugKey turns a display name into a stable role key.
func slugKey(name string) string {
	var b strings.Builder
	prevDash := true // leading dashes are dropped
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		case !prevDash:
			b.WriteByte('_')
			prevDash = true
		}
	}
	return strings.Trim(b.String(), "_")
}

type installableRole struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Installed   bool   `json:"installed"`
	Permissions int    `json:"permissions"`
}

// optionalRoleNotes explain, in one line, the school that needs each role.
var optionalRoleNotes = map[string]string{
	"vice_principal":     "Runs teaching and learning. Timetable, exams and monitoring, but no fees or salaries.",
	"hod":                "Only if departments are real in your school.",
	"it_admin":           "Accounts, roles and integrations, with no access to fees, marks or health records.",
	"exam_controller":    "A dedicated person for the board exam cycle.",
	"front_office":       "A reception desk separate from admissions. Most schools use one person for both.",
	"operations":         "One account covering library, transport, hostel and stores.",
	"librarian":          "Requires the Library module.",
	"transport_manager":  "Requires the Transport module.",
	"hostel_warden":      "Residential schools only.",
	"driver":             "A bus driver's route list. Nothing else.",
	"counsellor":         "Counselling notes, kept apart from the infirmary record.",
	"nurse":              "The only role that writes health records.",
	"discipline_officer": "A dedicated person for conduct records.",
	"activity_coord":     "Sports and activities, with the ability to publish notices.",
	"support_admin":      "Vendor support desk. Platform-wide; not for schools.",
}

// listInstallableRoles shows the optional roles and whether this school has
// them, so the screen offers "add the librarian role" rather than an empty
// list and no explanation of what is missing.
func (s *Server) listInstallableRoles(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	present := map[string]bool{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(),
			`SELECT key FROM roles WHERE institution_id = $1`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			present[k] = true
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	items := []installableRole{}
	for _, role := range rbac.SystemRoles {
		if rbac.IsDefault(role.Key) || rbac.PlatformRoles[role.Key] {
			continue
		}
		items = append(items, installableRole{
			Key: role.Key, Name: role.Name,
			Description: optionalRoleNotes[role.Key],
			Installed:   present[role.Key],
			Permissions: len(role.Permissions),
		})
	}
	sort.SliceStable(items, func(a, b int) bool {
		if items[a].Installed != items[b].Installed {
			return !items[a].Installed
		}
		return items[a].Name < items[b].Name
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type installRoleRequest struct {
	Key string `json:"key"`
}

// installRole adds one optional built-in role to this school.
func (s *Server) installRole(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req installRoleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if rbac.IsDefault(req.Key) {
		httpx.BadRequest(w, r, req.Key+" is not an optional role")
		return
	}
	if id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r, "choose a school before installing a role")
		return
	}

	var roleID uuid.UUID
	var created bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Half the optional roles are catalog personas as well as capability
		   roles — hod and operations own a whole workspace. Installing the
		   capabilities without the navigation gives the school a role that can
		   reach everything and shows nothing, so the menu grants go with them;
		   installOptionalRole is that pair, shared with the preset path, which
		   used to skip an uninstalled role in silence. */
		var err error
		roleID, created, err = installOptionalRole(r.Context(), tx, id.InstitutionID, req.Key)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": roleID.String(), "key": req.Key, "installed": created,
	})
}
