package api

import (
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Accounts and role assignment.

   Most schools that buy this are not large. A single person is very often the
   principal, the fee clerk, the HR department and the person who resets
   passwords — so one account has to hold several roles at once without those
   roles bleeding into one another.

   The model already supports it: permissions are a union across a user's
   roles, the catalog returns every role a user holds grants in, and the shell's
   left rail switches between them. What was missing was any way to *assign*
   more than one. */

type userRole struct {
	Key    string `json:"key"`
	Name   string `json:"name"`
	Source string `json:"source"` // catalog | capability
}

type userDetail struct {
	ID          string     `json:"id"`
	FullName    string     `json:"full_name"`
	Email       *string    `json:"email,omitempty"`
	Phone       *string    `json:"phone,omitempty"`
	Status      string     `json:"status"`
	Roles       []userRole `json:"roles"`
	Permissions int        `json:"permissions"`
	LastLoginAt *string    `json:"last_login_at,omitempty"`
	Sessions    int        `json:"active_sessions"`
}

// getUser returns one account with every role it holds.
func (s *Server) getUser(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	target, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid user id")
		return
	}

	var out userDetail
	out.Roles = []userRole{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT u.id::text, u.full_name, u.email::text, u.phone, u.status,
			       to_char(u.last_login_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       (SELECT count(DISTINCT rp.permission_key)
			          FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
			         WHERE ur.user_id = u.id)::int,
			       (SELECT count(*) FROM sessions se
			         WHERE se.user_id = u.id AND se.revoked_at IS NULL AND se.expires_at > now())::int
			  FROM users u WHERE u.id = $1`, target).
			Scan(&out.ID, &out.FullName, &out.Email, &out.Phone, &out.Status,
				&out.LastLoginAt, &out.Permissions, &out.Sessions); err != nil {
			return err
		}
		return scanInto(r.Context(), tx, `
			SELECT r.key, r.name FROM user_roles ur
			  JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id = '`+target.String()+`'::uuid
			 ORDER BY r.name`,
			func(rows pgx.Rows) error {
				var v userRole
				if err := rows.Scan(&v.Key, &v.Name); err != nil {
					return err
				}
				v.Source = "capability"
				if _, ok := catalog.RoleByKey(v.Key); ok {
					v.Source = "catalog"
				}
				out.Roles = append(out.Roles, v)
				return nil
			})
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

type createUserRequest struct {
	FullName string   `json:"full_name"`
	Email    string   `json:"email,omitempty"`
	Phone    string   `json:"phone,omitempty"`
	RoleKeys []string `json:"role_keys"`
	// SetPassword issues a temporary password immediately, for the common case
	// of an administrator creating an account and handing it over in person.
	SetPassword bool `json:"set_password"`
}

type createUserResponse struct {
	ID                string   `json:"id"`
	FullName          string   `json:"full_name"`
	Roles             []string `json:"roles"`
	Status            string   `json:"status"`
	TemporaryPassword string   `json:"temporary_password,omitempty"`
	Note              string   `json:"note,omitempty"`
}

// createUser makes an account and gives it any number of roles at once.
//
// A one-person school assigns all ten. That works because permissions are a
// union and the role rail switches workspaces — the roles stay distinct rather
// than merging into one undifferentiated super-user.
func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req createUserRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.FullName = strings.TrimSpace(req.FullName)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if req.FullName == "" {
		httpx.BadRequest(w, r, "full_name is required")
		return
	}
	// users_check requires one of the two, and an account with neither cannot
	// sign in at all.
	if req.Email == "" && req.Phone == "" {
		httpx.BadRequest(w, r, "an email or a phone number is required to sign in")
		return
	}
	if err := checkGrantable(req.RoleKeys, httpx.IdentityFrom(r.Context()).PlatformAdmin); err != nil {
		httpx.Denied(w, r, err.Error())
		return
	}
	if len(req.RoleKeys) == 0 {
		httpx.BadRequest(w, r, "assign at least one role, or the account can see nothing")
		return
	}

	var (
		out  createUserResponse
		temp string
	)
	if req.SetPassword {
		var err error
		if temp, err = temporaryPassword(); err != nil {
			httpx.Internal(w, r, err)
			return
		}
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		status := "invited"
		var hash any
		if temp != "" {
			h, err := s.Hasher.Hash(temp)
			if err != nil {
				return err
			}
			hash, status = h, "active"
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO users (institution_id, email, phone, full_name, password_hash, status)
			VALUES ($1,$2::citext,$3,$4,$5,$6)
			ON CONFLICT (institution_id, email) WHERE email IS NOT NULL
			DO UPDATE SET full_name = EXCLUDED.full_name,
			              phone     = COALESCE(EXCLUDED.phone, users.phone),
			              password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
			              status    = EXCLUDED.status,
			              updated_at = now()
			RETURNING id::text, status`,
			id.InstitutionID, nullString(req.Email), nullString(req.Phone),
			req.FullName, hash, status).Scan(&out.ID, &out.Status); err != nil {
			return err
		}

		assigned, err := setUserRoles(r, tx, id.InstitutionID, out.ID, req.RoleKeys, false)
		if err != nil {
			return err
		}
		out.Roles = assigned
		return nil
	})
	if err != nil {
		if strings.Contains(err.Error(), "users_institution_email") {
			httpx.Error(w, r, http.StatusConflict, "email_in_use",
				"another account in this school already uses that email")
			return
		}
		httpx.Internal(w, r, err)
		return
	}

	out.FullName = req.FullName
	if temp != "" {
		out.TemporaryPassword = temp
		out.Note = "Shown once. Hand it over in person; ask them to change it from their profile."
	} else {
		out.Note = "The account is invited but has no password yet. Use Reset password to issue one."
	}
	httpx.JSON(w, http.StatusCreated, out)
}

type setRolesRequest struct {
	RoleKeys []string `json:"role_keys"`
}

// setUserRoles replaces a user's role assignments.
//
// Replace rather than add, so removing a role in the interface actually
// revokes it. Returns the keys that were applied, which will differ from the
// request if a key does not exist.
func setUserRoles(r *http.Request, tx pgx.Tx, instID uuid.UUID,
	userID string, keys []string, replace bool) ([]string, error) {

	if replace {
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM user_roles WHERE user_id = $1::uuid`, userID); err != nil {
			return nil, err
		}
	}

	applied := make([]string, 0, len(keys))
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		var roleID uuid.UUID
		var roleInst *uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT id, institution_id FROM roles
			 WHERE key = $1 AND (institution_id = $2 OR institution_id IS NULL)
			 ORDER BY institution_id NULLS LAST LIMIT 1`, key, instID).Scan(&roleID, &roleInst)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			/* Not installed yet, rather than not a role.

			   The optional roles are not created for a school until it asks
			   for one — and asking for one is exactly what this is. But the
			   answer to a missing row was to skip it in silence, so a
			   principal choosing the "Office staff" preset, which promises
			   admissions, the front desk and the fee counter, got two of the
			   three and was told nothing. The preset named a role the school
			   did not have, and the product quietly handed over less than it
			   had offered.

			   A key that is genuinely unknown still falls through by
			   omission, which is what the caller reports back. */
			if rbac.IsDefault(key) {
				continue
			}
			newID, _, instErr := installOptionalRole(r.Context(), tx, instID, key)
			if instErr != nil {
				continue
			}
			roleID, roleInst = newID, &instID
		case err != nil:
			return nil, err
		}
		// A platform role (institution_id NULL) must be assigned with a NULL
		// institution too, or the assignment row claims a tenant the role does
		// not belong to.
		var owner any = instID
		if roleInst == nil {
			owner = nil
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO user_roles (institution_id, user_id, role_id)
			VALUES ($1,$2::uuid,$3)
			ON CONFLICT (user_id, role_id) WHERE campus_id IS NULL DO NOTHING`,
			owner, userID, roleID); err != nil {
			return nil, err
		}
		applied = append(applied, key)
	}
	sort.Strings(applied)
	return applied, nil
}

// setRoles replaces the roles on an existing account.
func (s *Server) setRoles(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	target, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid user id")
		return
	}
	var req setRolesRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if err := checkGrantable(req.RoleKeys, id.PlatformAdmin); err != nil {
		httpx.Denied(w, r, err.Error())
		return
	}
	if len(req.RoleKeys) == 0 {
		httpx.BadRequest(w, r, "a user needs at least one role; suspend the account instead")
		return
	}
	// Removing your own last administrative role locks you out of the screen
	// you are standing on, and recovering needs shell access.
	if target == id.UserID {
		hasAdmin := false
		for _, k := range req.RoleKeys {
			if k == "institution_admin" || k == "super_admin" || k == "it_admin" {
				hasAdmin = true
			}
		}
		if !hasAdmin {
			httpx.BadRequest(w, r,
				"you cannot remove your own administrator role — ask another administrator")
			return
		}
	}

	var applied []string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM users WHERE id = $1`, target).Scan(&exists); err != nil {
			return err
		}
		var err error
		applied, err = setUserRoles(r, tx, id.InstitutionID, target.String(), req.RoleKeys, true)
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

	missing := []string{}
	for _, want := range req.RoleKeys {
		found := false
		for _, got := range applied {
			if got == want {
				found = true
			}
		}
		if !found {
			missing = append(missing, want)
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"user_id": target.String(), "roles": applied, "unknown_roles": missing,
		// A user must sign in again for a role change to take effect, because
		// permissions are resolved into the session at login.
		"note": "The user will see the new roles the next time they sign in.",
	})
}

type assignableRole struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Source      string `json:"source"`
	Permissions int    `json:"permissions"`
	Users       int    `json:"users"`
	Description string `json:"description"`
}

// listAssignableRoles powers the role picker.
//
// Catalog roles are listed first and described in terms of what the person
// does, because whoever assigns roles in a small school is not thinking in
// permission keys.
/* Which roles a school administrator may hand out.

   Two are withheld, for different reasons.

   super_admin is a platform role that spans every school on the installation.
   Postgres already refuses the insert — the row has no institution and the
   RLS policy rejects it — but relying on that means the attempt surfaces as
   an opaque 500 rather than as a rule. A privilege boundary that is only
   enforced by accident is one refactor away from not being enforced.

   student and parent are not granted, they are derived: the role arrives with
   the student record or the guardian link, and a "parent" who is not attached
   to a child gets a portal with nothing in it. */

// platformOnlyRoles may be granted only by an existing platform operator.
var platformOnlyRoles = map[string]bool{"super_admin": true}

/* derivedRoles are facts about a person, not workspaces to hand out.

   student and parent come from a record link. class_teacher comes from naming
   somebody on a section — the same fact that decides whose report cards they
   may generate — and granting it here would put that in two places, so the day
   the two disagree the menu is wrong and nobody knows which half to believe.

   Each says where the fact actually lives, because "you cannot do that" without
   "here is where you can" is how somebody ends up editing the database. */
var derivedRoles = map[string]bool{
	"student": true, "parent": true, "class_teacher": true,
}

var derivedFrom = map[string]string{
	"student":       "linking the person to a student record",
	"parent":        "linking the person to a child as their guardian",
	"class_teacher": "naming them class teacher on the section itself",
}

/* Roles that draw the same screens.

   A HOD who teaches gets marks entry, homework, lesson plans, the register and
   report cards from their own role, the moment somebody allocates them a
   subject — the same switch every other teacher is turned on by. Adding faculty
   on top gives a second workspace holding the same five entries, and the person
   has to learn which copy to use.

   Stated as a pair rather than a list of forbidden roles, because the objection
   is to the combination and not to either half: both are perfectly good roles
   on their own. */
var overlappingRoles = [][2]string{
	// 11 of the HOD's 22 entries are the faculty role's own: marks entry,
	// homework, lesson plans, the register, report cards.
	{"hod", "faculty"},
	// All five of the receptionist's entries are inside admissions — the same
	// four desk registers plus My pay. Granting both is the front desk twice.
	{"admissions", "front_office"},
}

/* Why those two and not the rest.

   Measured against the catalogue rather than chosen: every other pair of staff
   roles shares at most a fifth of the smaller one, and what they share is My
   pay and the profile — the entries every role has because every role is held
   by a person. hod+institution_admin is the closest real pair at 31%, and a
   vice-principal who also heads a department is a genuine two-job person.

   A test recomputes this from the catalogue, so a role that grows into
   duplicating another is caught when it grows rather than when a school
   complains. */

/* What to do instead, per pair.

   A refusal that only says no leaves somebody to guess, and the guess is
   usually to grant it anyway from another screen. */
var overlapRemedy = map[[2]string]string{
	{"hod", "faculty"}: "A head of department who teaches gets marks entry, homework and " +
		"the register from the hod role as soon as somebody allocates them a subject in " +
		"Faculty allocation.",
	{"admissions", "front_office"}: "Admissions already contains the four front-desk " +
		"registers. Give front_office alone to somebody who only works the desk, or " +
		"admissions alone to somebody who does both.",
}

// checkGrantable rejects a role list a caller is not entitled to hand out.
func checkGrantable(keys []string, platformAdmin bool) error {
	held := make(map[string]bool, len(keys))
	for _, k := range keys {
		held[k] = true
	}
	for _, pair := range overlappingRoles {
		if held[pair[0]] && held[pair[1]] {
			return errors.New("a person cannot hold both " + pair[0] + " and " +
				pair[1] + " — they draw the same screens. " + overlapRemedy[pair])
		}
	}
	for _, k := range keys {
		if platformOnlyRoles[k] && !platformAdmin {
			return errors.New("only a platform operator can grant the " + k + " role")
		}
		if derivedRoles[k] {
			where := derivedFrom[k]
			if where == "" {
				where = "the record it belongs to"
			}
			return errors.New("the " + k + " role is granted by " + where +
				", not from this screen")
		}
	}
	return nil
}

func (s *Server) listAssignableRoles(w http.ResponseWriter, r *http.Request) {
	descriptions := map[string]string{
		"super_admin":       "Platform operator across every school.",
		"institution_admin": "Runs the school. Sees everything except platform settings.",
		"hod":               "Heads a department; sees only that department's staff and classes.",
		"faculty":           "Teaches; sees only their own classes and students.",
		"finance":           "Fee counter, invoices, collections and defaulters.",
		"admissions":        "Enquiries through to enrolment, and the front desk.",
		"hr":                "Staff records, leave, attendance and payroll.",
		"operations":        "Library, transport, hostel and stores.",
		"student":           "A student's own portal.",
		"parent":            "A guardian's view of their children.",
	}

	id := httpx.IdentityFrom(r.Context())
	// Either right is enough. Reading the roles is administration; choosing
	// one while appointing a member of staff is the ordinary work of an HR
	// office, and it cannot be done from a list nobody is allowed to see.
	if !id.Can(rbac.RolesRead) && !id.Can(rbac.EmployeesWrite) {
		httpx.Error(w, r, http.StatusForbidden, "forbidden", "you cannot read the role list")
		return
	}
	items, err := collect(s, r, `
		SELECT r.key, r.name,
		       (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id)::int,
		       (SELECT count(*) FROM user_roles ur WHERE ur.role_id = r.id)::int
		  FROM roles r
		 WHERE r.key <> ALL($1::text[])
		   AND ($2 OR r.key <> 'super_admin')
		 ORDER BY r.name`,
		[]any{[]string{"student", "parent"}, id.PlatformAdmin},
		func(rows pgx.Rows) (assignableRole, error) {
			var v assignableRole
			if err := rows.Scan(&v.Key, &v.Name, &v.Permissions, &v.Users); err != nil {
				return v, err
			}
			v.Source = "capability"
			if _, ok := catalog.RoleByKey(v.Key); ok {
				v.Source = "catalog"
			}
			v.Description = descriptions[v.Key]
			return v, nil
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// Catalog roles are the ones with a workspace behind them, so they lead.
	sort.SliceStable(items, func(a, b int) bool {
		return items[a].Source == "catalog" && items[b].Source != "catalog"
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// rolePreset is a ready-made bundle for the common shapes of school staffing.
//
// Picking eight checkboxes correctly requires knowing what each role grants.
// Most schools want one of a handful of combinations, and the smallest ones
// want all of them on one account — so that is the first option, not a power
// user's afterthought.
type rolePreset struct {
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	RoleKeys    []string `json:"role_keys"`
	Recommended bool     `json:"recommended"`
}

// AllOperationalRoles is every role that runs the school, excluding the
// self-service portals (which belong to students and guardians, not staff) and
// the platform operator (which spans tenants).
var AllOperationalRoles = []string{
	/* Neither faculty beside hod, nor front_office beside admissions.

	   Each pair draws the same screens, so holding both gives one workspace
	   listed twice. Somebody running the whole school single-handed still
	   teaches and still works the desk — they get the classroom screens from
	   hod once they are allocated a subject, and the four desk registers from
	   admissions, which already contains them. */
	"institution_admin", "it_admin", "hod",
	"finance", "admissions", "hr", "operations",
	"exam_controller", "librarian", "transport_manager", "hostel_warden",
}

var rolePresets = []rolePreset{
	{
		Key:  "sole_maintainer",
		Name: "Everything — one person runs the school",
		Description: "Every staff role on one account. The person switches " +
			"workspaces from the left rail; the roles stay separate.",
		RoleKeys:    AllOperationalRoles,
		Recommended: true,
	},
	{
		Key:         "principal",
		Name:        "Principal / Head",
		Description: "Runs the school and approves everything, but does not operate the fee counter.",
		RoleKeys:    []string{"institution_admin"},
	},
	{
		Key:         "office",
		Name:        "Office staff",
		Description: "Admissions, the front desk and the fee counter — the usual front-office bundle.",
		/* admissions, not admissions+front_office: the receptionist's five
		   entries are all inside admissions, so granting both would give this
		   person the front desk twice. */
		RoleKeys:    []string{"admissions", "finance"},
	},
	{
		Key:         "accounts",
		Name:        "Accountant",
		Description: "Fees, invoices, collections and reports only.",
		RoleKeys:    []string{"finance"},
	},
	{
		Key:         "teacher",
		Name:        "Teacher",
		Description: "Their own classes: attendance, marks, homework.",
		RoleKeys:    []string{"faculty"},
	},
	{
		/* hod alone, and not hod+faculty.

		   The two draw the same five classroom screens, so granting both gives
		   one workspace listed twice. A head of department who teaches gets
		   marks entry, homework, lesson plans, the register and report cards
		   from the hod role itself, the moment somebody allocates them a
		   subject — the same switch every other teacher is turned on by, and
		   the one that turns them off again next term. */
		Key:         "academic_head",
		Name:        "Head of department",
		Description: "A department's staff, classes and approvals. Allocate them a subject in " +
			"Faculty allocation and their own teaching screens appear too.",
		RoleKeys:    []string{"hod"},
	},
	{
		Key:         "hr_payroll",
		Name:        "HR & payroll",
		Description: "Staff records, leave, attendance and salaries.",
		RoleKeys:    []string{"hr"},
	},
	{
		Key:         "operations",
		Name:        "Operations",
		Description: "Library, transport, hostel and stores.",
		RoleKeys:    []string{"operations", "librarian", "transport_manager", "hostel_warden"},
	},
	{
		Key:         "it",
		Name:        "IT administrator",
		Description: "Accounts, roles, integrations and the audit trail.",
		RoleKeys:    []string{"it_admin"},
	},

	/* The two-hat presets.

	   Every Indian school below a certain size runs on people doing two jobs —
	   the Telugu teacher who is also the librarian, the games master who runs
	   the buses. Both roles were already grantable together and somebody had to
	   know that, tick two boxes, and know which two would not collide.

	   Only combinations that share nothing but My pay and the profile, which is
	   measured rather than assumed: TestNoTwoGrantableRolesAreTheSameWorkspace
	   fails if any pair here grows into duplicating itself. */
	{
		Key:  "teacher_librarian",
		Name: "Teacher & librarian",
		Description: "Teaches their own classes and runs the library. Two workspaces on the " +
			"left rail; nothing is shared between them.",
		RoleKeys: []string{"faculty", "librarian"},
	},
	{
		Key:  "teacher_transport",
		Name: "Teacher & transport in-charge",
		Description: "Teaches, and runs the routes, vehicles and driver roster.",
		RoleKeys: []string{"faculty", "transport_manager"},
	},
	{
		Key:  "principal_hr",
		Name: "Principal & payroll",
		Description: "Runs the school and keeps the staff records and salaries — the small-school " +
			"arrangement where the head does both.",
		RoleKeys: []string{"institution_admin", "hr"},
	},
	{
		Key:  "hod_librarian",
		Name: "Head of department & librarian",
		Description: "Heads a department and runs the library. Allocate them a subject and their " +
			"own teaching screens appear too.",
		RoleKeys: []string{"hod", "librarian"},
	},
}

// listRolePresets returns the bundles, filtered to roles that actually exist
// in this institution so a preset never silently grants nothing.
func (s *Server) listRolePresets(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	existing := map[string]bool{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return scanInto(r.Context(), tx, `SELECT key FROM roles`, func(rows pgx.Rows) error {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			existing[k] = true
			return nil
		})
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* A preset offers what it says, and says what is not installed yet.

	   This trimmed each preset to the roles the school already had, so
	   "Teacher & librarian" at a school that has never switched the librarian
	   role on was offered under that name and granted faculty alone. The name
	   promised two workspaces and delivered one, silently, which is the worst
	   way for a school to discover an optional role exists.

	   Trimming was right when assigning an uninstalled role did nothing. It is
	   not right now: setUserRoles installs an optional role on demand, so the
	   preset works in full — and the only thing worth saying is which of them
	   the school is switching on for the first time. */
	type presetOut struct {
		rolePreset
		// Roles this school does not have yet, which granting the preset will
		// switch on. Named so the screen can say so rather than surprise
		// somebody with a workspace nobody asked for.
		NewToSchool []string `json:"new_to_school,omitempty"`
	}

	out := make([]presetOut, 0, len(rolePresets))
	for _, p := range rolePresets {
		item := presetOut{rolePreset: p}
		for _, k := range p.RoleKeys {
			if !existing[k] {
				item.NewToSchool = append(item.NewToSchool, k)
			}
		}
		out = append(out, item)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}
