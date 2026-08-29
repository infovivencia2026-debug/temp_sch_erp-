package api

import (
	"net/http"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/scope"
)

type catalogResponse struct {
	/* True while the school still owes a required setup step, and the reason
	   most of its sections are missing from this response. The SPA says so on
	   screen rather than leaving somebody to wonder where the product went. */
	SetupRequired bool          `json:"setup_required"`
	ActiveRole    string        `json:"active_role"`
	Roles         []catalogRole `json:"roles"`
	Scope         resolvedScope `json:"scope"`
	Implemented   []string      `json:"implemented"`
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

/*
What a school must finish before the rest of the product appears.

	A school that has just bought this sees eighty screens, and every one of
	them is empty. Attendance with nobody to mark, report cards with no exam,
	a fee counter with no fee heads: each of them correct, and together they
	read as a product that does not work. The checklist was there from the
	start and sat on the dashboard beside the eighty doors, which is a signpost
	in a field of open gates.

	So until the required steps are done, the menu is the setup and nothing
	else. Not disabled — absent. A greyed-out control that never becomes
	enabled is an advert wearing the clothes of a feature, and the school's own
	staff cannot tell it from something broken.

	Three things stay reachable throughout, because locking them would strand
	somebody rather than guide them:

	  the setup itself, obviously;
	  Home, so there is a page to land on that says what is left;
	  My Profile, because a person must always be able to change their own
	  password and take leave, whatever state the school is in.

	Only the required steps count. A school can run without a grading scale
	until the first exam, and holding the product shut over a fee head nobody
	has typed yet would be the gate doing harm.

	Platform staff are exempt: a super admin looking into a half-built school is
	the person who has to see everything, and gating them would hide the tools
	they are there to use.
*/
func (s *Server) setupIncomplete(r *http.Request) bool {
	id := httpx.IdentityFrom(r.Context())
	if id.PlatformAdmin || id.InstitutionID == uuid.Nil {
		return false
	}

	// The same three counts the checklist marks as blocking, asked as one
	// question. Cheaper than the checklist's fourteen, and this runs on every
	// catalogue read.
	var classes, sections, subjects, classSubjects, staff, students int
	var profileDone bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*) FROM classes)::int,
			       (SELECT count(*) FROM sections)::int,
			       (SELECT count(*) FROM subjects)::int,
			       (SELECT count(*) FROM class_subjects)::int,
			       (SELECT count(*) FROM employees WHERE status = 'active')::int,
			       (SELECT count(*) FROM students WHERE status = 'active')::int,
			       COALESCE((SELECT district IS NOT NULL AND state IS NOT NULL
			                        AND affiliation_board IS NOT NULL
			                   FROM institutions WHERE id = $1), false)`,
			id.InstitutionID).
			Scan(&classes, &sections, &subjects, &classSubjects, &staff, &students,
				&profileDone)
	})
	if err != nil {
		// A failed count is not a reason to lock a school out of its own
		// product. Fail open: the checklist on the dashboard still says what
		// is missing.
		httpx.LogError(r, err)
		return false
	}

	return !profileDone || classes == 0 || sections == 0 || subjects == 0 ||
		classSubjects == 0 || staff == 0 || students == 0
}

// setupSections are the only sections a school sees before it has finished.
var setupSections = map[string]bool{
	"getting_started": true,
	"home":            true,
	"my_profile":      true,
}

/*
catalogRoleKeys is the set of workspaces the caller was actually granted.

	Empty when none of their roles has a catalogue of its own, which is the
	signal to fall back rather than to show nothing: class_teacher and
	operations are capability bundles, and somebody holding only those still
	has to land somewhere.

	Platform staff are exempt for the same reason they are exempt from the
	setup gate — a super admin looking into a school is the person who has to
	see everything.
*/
/* heldRoleKeys is every role key on this user, unfiltered.

   catalogRoleKeys below answers "which workspaces may this person be shown",
   and returns nothing at all for platform staff so the caller shows them all.
   That is the right answer to that question and the wrong one for "which of
   these is theirs" — which is what deciding where to land needs. Two
   questions, two functions, rather than one that means different things to
   different callers. */
func (s *Server) heldRoleKeys(r *http.Request) (map[string]bool, error) {
	id := httpx.IdentityFrom(r.Context())
	held := map[string]bool{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT r.key
			  FROM user_roles ur
			  JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id = $1`, id.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			held[k] = true
		}
		return rows.Err()
	})
	return held, err
}

func (s *Server) catalogRoleKeys(r *http.Request) (map[string]bool, error) {
	id := httpx.IdentityFrom(r.Context())
	if id.PlatformAdmin {
		return nil, nil
	}

	held := map[string]bool{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT r.key
			  FROM user_roles ur
			  JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id = $1`, id.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			held[k] = true
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}

	/* The head asking to see the whole school.

	   A principal already holds every permission this product defines bar the
	   two platform ones — the role is literally keysExcept(platform) — so every
	   screen in the building already opens for them. What they did not have was
	   a way to REACH one: the catalogue lists thirty-six features under their
	   own workspace, and the fee counter, the library desk and the transport
	   office are all somebody else's workspace, so there was no route to them
	   short of borrowing a login.

	   Asked for explicitly rather than always on: thirteen workspaces in the
	   switcher is not a school's day-to-day view, it is an inspection. And
	   granted on the role rather than on a permission count, because "holds
	   nearly everything" is a coincidence that would quietly widen the day
	   somebody adds a permission the principal does not have. */
	if held["institution_admin"] && r.URL.Query().Get("all_roles") == "1" {
		every := map[string]bool{}
		for _, role := range catalog.Roles {
			// Not the platform's own workspaces: the principal holds neither
			// PlatformTenantsRW nor PlatformPlansRW, so those screens would be
			// a menu of 403s.
			if role.Key == "super_admin" || role.Key == "seller_admin" {
				continue
			}
			every[role.Key] = true
		}
		return every, nil
	}

	// Only the keys the catalogue actually has a workspace for.
	known := map[string]bool{}
	for _, role := range catalog.Roles {
		if held[role.Key] {
			known[role.Key] = true
		}
	}
	return known, nil
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

	// What the school bought. Resolved once rather than per section: the
	// answer cannot change during a single response, and 82 sections would
	// otherwise mean 82 identical queries.
	ent, err := s.entitlementFor(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Asked once for the whole response, not per section.
	locked := s.setupIncomplete(r)

	resp := catalogResponse{
		SetupRequired: locked,
		Roles:         []catalogRole{},
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

	/* Which workspaces this person actually holds.

	   A user may legitimately hold several (a principal who also teaches), and
	   the switcher exists for exactly that. It was deciding membership by
	   permission overlap — emit any role the caller has one grant in — which
	   is not what holding a role means. A head of department's grants are
	   mostly a subset of the principal's, so every HOD was offered the
	   principal's workspace and dropped into it by default: the switcher said
	   "Institution Admin / Principal" to somebody whose only role is hod.

	   Read from user_roles, which is the record of what somebody was actually
	   given. Falling back to the old behaviour when none of their roles has a
	   catalogue of its own, because some rbac roles are capability bundles
	   with no workspace — class_teacher, operations — and a strict filter
	   would hand those people an empty menu. */
	held, err := s.catalogRoleKeys(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Your own workspace first.

	   Platform staff are exempt from the filter above so a super admin can
	   reach every workspace to support a school — which is right, and had one
	   consequence nobody looked at: the list then came back in catalogue
	   order, the client lands on the first entry, and the first entry is
	   Seller Admin. So signing in as the platform operator opened the vendor's
	   billing workspace: tenants, plans, support tickets. Not their job, and
	   not what they asked for.

	   Ordering rather than filtering, because the exemption is deliberate. The
	   workspaces this person actually holds lead; everything else follows in
	   the order it always had, one switcher click away. */
	mine, err := s.heldRoleKeys(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	ordered := make([]catalog.Role, 0, len(catalog.Roles))
	for _, role := range catalog.Roles {
		if mine[role.Key] {
			ordered = append(ordered, role)
		}
	}
	for _, role := range catalog.Roles {
		if !mine[role.Key] {
			ordered = append(ordered, role)
		}
	}

	for _, role := range ordered {
		if len(held) > 0 && !held[role.Key] {
			continue
		}
		out := catalogRole{Key: role.Key, Name: role.Name, Sections: []catalogSection{}}

		for _, sec := range role.Sections {
			// A module the school did not buy is absent, not greyed out. A
			// disabled control that never becomes enabled is an advert
			// wearing the clothes of a feature, and the school's own staff
			// cannot tell it from something broken.
			if !ent.Allows(sec.Slug) {
				continue
			}
			// Until the required setup is done, only the setup.
			if locked && !setupSections[sec.Slug] {
				continue
			}
			cs := catalogSection{
				Slug: sec.Slug, Name: sec.Name, Workspace: sec.Workspace,
				Features: []catalogFeature{},
			}
			for _, f := range sec.Features {
				if !id.Can(f.Key) {
					continue
				}
				/* A few entries earn their place only when there is something
				   behind them — see catalog_evidence.go. Deliberately a short
				   explicit list, not a general "hide what is empty": that rule
				   is the one that empties a menu mid-setup. */
				if evidenceKeys[f.Key] && !s.evidenceFor(r, sc, f.Key) {
					continue
				}
				/* Two rungs of the admissions ladder are optional: a school
				   that neither tests nor interviews should not carry queues
				   that can never fill. Unlike evidence, this is the school's
				   own answer rather than a fact about its data. */
				if stageKeys[f.Key] && !s.stageAllowed(r, f.Key) {
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
