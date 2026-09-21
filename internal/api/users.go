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
	// CampusIDs are the specific campuses this account is posted to. Empty means
	// every campus, which the schema stores as a NULL campus_id on the role row;
	// AllCampuses says which of the two "empty" means so the edit form can tell
	// "posted everywhere" apart from "no roles at all".
	CampusIDs   []string `json:"campus_ids"`
	AllCampuses bool     `json:"all_campuses"`
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
	out.CampusIDs = []string{}
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
		if err := scanInto(r.Context(), tx, `
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
			}); err != nil {
			return err
		}
		/* The campuses this account is posted to.

		   A NULL campus_id on any row means institution-wide, which wins over any
		   specific grant — the same rule the scope resolver applies when it unions
		   these rows on the read side. So a single NULL row makes AllCampuses true
		   and the specific list irrelevant. */
		return scanInto(r.Context(), tx, `
			SELECT DISTINCT campus_id::text FROM user_roles
			 WHERE user_id = '`+target.String()+`'::uuid`,
			func(rows pgx.Rows) error {
				var c *string
				if err := rows.Scan(&c); err != nil {
					return err
				}
				if c == nil {
					out.AllCampuses = true
				} else {
					out.CampusIDs = append(out.CampusIDs, *c)
				}
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
	// Institution-wide wins, so a stray specific grant alongside a NULL row is
	// not reported as a campus restriction that is not really in force.
	if out.AllCampuses {
		out.CampusIDs = []string{}
	}
	httpx.JSON(w, http.StatusOK, out)
}

type createUserRequest struct {
	FullName string   `json:"full_name"`
	Email    string   `json:"email,omitempty"`
	Phone    string   `json:"phone,omitempty"`
	RoleKeys []string `json:"role_keys"`
	// CampusIDs posts the account to specific campuses. Empty or absent means
	// every campus, today's behaviour. See resolveCampusIDs.
	CampusIDs []string `json:"campus_ids,omitempty"`
	// SetPassword issues a temporary password immediately, for the common case
	// of an administrator creating an account and handing it over in person.
	SetPassword bool `json:"set_password"`
}

var (
	errBadCampus     = errors.New("each campus_id must be a valid uuid")
	errUnknownCampus = errors.New("one of the campuses is not part of this school")
)

/*
resolveCampusIDs turns the campus_ids payload into the ids to write.

	Empty (or a platform user, who has no campuses) means every campus, which the
	schema stores as a NULL campus_id on the role row — today's behaviour, and
	what the scope resolver reads as "institution-wide". A non-empty list is
	parsed, de-duplicated and checked against the caller's own campuses: RLS
	already scopes the campuses table to the institution, so a count that comes up
	short means an id the caller has no business naming, answered as a 400 rather
	than a foreign-key 500 at insert time.
*/
func (s *Server) resolveCampusIDs(r *http.Request, id *httpx.Identity, raw []string) ([]uuid.UUID, error) {
	if id.InstitutionID == uuid.Nil || len(raw) == 0 {
		return nil, nil
	}
	seen := make(map[uuid.UUID]bool, len(raw))
	ids := make([]uuid.UUID, 0, len(raw))
	for _, s := range raw {
		u, err := uuid.Parse(strings.TrimSpace(s))
		if err != nil {
			return nil, errBadCampus
		}
		if !seen[u] {
			seen[u] = true
			ids = append(ids, u)
		}
	}
	var found int
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT count(*) FROM campuses WHERE id = ANY($1)`, ids).Scan(&found)
	}); err != nil {
		return nil, err
	}
	if found != len(ids) {
		return nil, errUnknownCampus
	}
	return ids, nil
}

type createUserResponse struct {
	ID                string   `json:"id"`
	FullName          string   `json:"full_name"`
	Roles             []string `json:"roles"`
	Status            string   `json:"status"`
	TemporaryPassword string   `json:"temporary_password,omitempty"`
	SentBy            string   `json:"sent_by,omitempty"`
	SentTo            string   `json:"sent_to,omitempty"`
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
	campusIDs, err := s.resolveCampusIDs(r, id, req.CampusIDs)
	if err != nil {
		if errors.Is(err, errBadCampus) || errors.Is(err, errUnknownCampus) {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.Internal(w, r, err)
		return
	}

	/* The same first password every other account on this system gets: the
	   number or address the person signs in with. One rule for everybody, so
	   the office never has to remember which kind of account it is looking at
	   -- and nothing to print, carry or read down a telephone. Held on it by
	   must_change_password until they set their own. */
	var (
		out   createUserResponse
		temp  string
		known bool
	)
	if req.SetPassword {
		var err error
		if temp, known, err = issuedPassword(req.Phone, req.Email); err != nil {
			httpx.Internal(w, r, err)
			return
		}
	}

	var enabled map[string]bool
	if temp != "" && !known {
		enabled = s.platformChannels(r.Context())
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
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
			INSERT INTO users (institution_id, email, phone, full_name, password_hash,
			                   status, must_change_password)
			VALUES ($1,$2::citext,$3,$4,$5,$6,$7)
			ON CONFLICT (institution_id, email) WHERE email IS NOT NULL
			DO UPDATE SET full_name = EXCLUDED.full_name,
			              phone     = COALESCE(EXCLUDED.phone, users.phone),
			              password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
			              status    = EXCLUDED.status,
			              must_change_password = EXCLUDED.must_change_password,
			              updated_at = now()
			RETURNING id::text, status`,
			id.InstitutionID, nullString(req.Email), nullString(req.Phone),
			req.FullName, hash, status, known).Scan(&out.ID, &out.Status); err != nil {
			return err
		}

		assigned, err := setUserRoles(r, tx, id.InstitutionID, out.ID, req.RoleKeys, campusIDs, false)
		if err != nil {
			return err
		}
		out.Roles = assigned
		/* A generated password goes to the person as well as the screen. When
		   the password is their own number there is nothing to send. */
		if temp != "" && !known {
			uid, err := uuid.Parse(out.ID)
			if err != nil {
				return err
			}
			login := req.Email
			if login == "" {
				login = req.Phone
			}
			out.SentBy, out.SentTo, err = s.queueIssuedPassword(r.Context(), tx, id.InstitutionID, uid,
				nullString(req.Email), nullString(req.Phone), login, temp, enabled)
			return err
		}
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
		if known {
			out.Note = "Their own number is the password. They are asked to set their " +
				"own the first time they sign in, and can do nothing until they have."
		} else {
			out.Note = "Shown once. Hand it over in person; ask them to change it from their profile."
		}
	} else {
		out.Note = "The account is invited but has no password yet. Use Reset password to issue one."
	}
	httpx.JSON(w, http.StatusCreated, out)
}

type setRolesRequest struct {
	RoleKeys []string `json:"role_keys"`
	// CampusIDs posts the account to specific campuses. Empty or absent means
	// every campus. See resolveCampusIDs.
	CampusIDs []string `json:"campus_ids,omitempty"`
}

// setUserRoles replaces a user's role assignments.
//
// Replace rather than add, so removing a role in the interface actually
// revokes it. Returns the keys that were applied, which will differ from the
// request if a key does not exist.
func setUserRoles(r *http.Request, tx pgx.Tx, instID uuid.UUID,
	userID string, keys []string, campusIDs []uuid.UUID, replace bool) ([]string, error) {

	if replace {
		// Clear every prior row for this user across all campuses before
		// re-inserting, so switching from all-campuses to specific-campuses (or
		// back) never leaves a stale NULL-campus or per-campus row behind.
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
		/* Institution-wide, or one row per campus.

		   Empty campus set keeps today's behaviour: a single row with campus_id
		   NULL, deduplicated by the partial index (user_id, role_id) WHERE
		   campus_id IS NULL. A platform role (roleInst == nil) is always written
		   this way — it spans every tenant, so pinning it to a campus is
		   meaningless. Otherwise one row per (role, campus), deduplicated by the
		   unique index on (user_id, role_id, campus_id). The scope resolver
		   unions campus_id across a user's rows, so a school reading these back
		   sees exactly the campuses named here. */
		if len(campusIDs) == 0 || roleInst == nil {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO user_roles (institution_id, user_id, role_id)
				VALUES ($1,$2::uuid,$3)
				ON CONFLICT (user_id, role_id) WHERE campus_id IS NULL DO NOTHING`,
				owner, userID, roleID); err != nil {
				return nil, err
			}
		} else {
			for _, campusID := range campusIDs {
				if _, err := tx.Exec(r.Context(), `
					INSERT INTO user_roles (institution_id, user_id, role_id, campus_id)
					VALUES ($1,$2::uuid,$3,$4)
					ON CONFLICT (user_id, role_id, campus_id) DO NOTHING`,
					owner, userID, roleID, campusID); err != nil {
					return nil, err
				}
			}
		}
		applied = append(applied, key)
	}
	sort.Strings(applied)
	// Roles decide both what the permission map contains and which sections,
	// campuses and departments the scope resolver returns, so both caches
	// have to be told. See forget().
	if uid, err := uuid.Parse(userID); err == nil {
		forget(uid)
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
	campusIDs, err := s.resolveCampusIDs(r, id, req.CampusIDs)
	if err != nil {
		if errors.Is(err, errBadCampus) || errors.Is(err, errUnknownCampus) {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.Internal(w, r, err)
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
				"you cannot remove your own administrator role, ask another administrator")
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
		applied, err = setUserRoles(r, tx, id.InstitutionID, target.String(), req.RoleKeys, campusIDs, true)
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
	// PermissionKeys is the actual capability set the role grants, so the login
	// editor can pre-tick and lock those keys the moment a role is chosen -
	// before anything is saved - rather than only after the assignment has been
	// written and re-read. Empty is a valid answer (a role that grants nothing).
	PermissionKeys []string `json:"permission_keys"`
}

// listAssignableRoles powers the role picker.
//
// Catalog roles are listed first and described in terms of what the person
// does, because whoever assigns roles in a small school is not thinking in
// permission keys.
/* Which roles a school administrator may hand out.

   Two are withheld, for different reasons.

   super_admin and seller_admin are platform roles that span every school on
   the installation — one operates the software, the other sells it, sets the
   prices and can suspend a tenant. Postgres already refuses the insert for a
   row with no institution, but relying on that means the attempt surfaces as
   an opaque 500 rather than as a rule. A privilege boundary that is only
   enforced by accident is one refactor away from not being enforced — which is
   exactly what happened to seller_admin, withheld nowhere while super_admin
   beside it was withheld everywhere.

   student and parent are not granted, they are derived: the role arrives with
   the student record or the guardian link, and a "parent" who is not attached
   to a child gets a portal with nothing in it. */

// platformOnlyKeys is the same set as a slice, for the queries that filter on it.
//
// Derived rather than written out twice: the day a third platform role is added
// it must not be possible to add it to one list and forget the other.
func platformOnlyKeys() []string {
	out := make([]string, 0, len(platformOnlyRoles))
	for k := range platformOnlyRoles {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// platformOnlyRoles may be granted only by an existing platform operator.
var platformOnlyRoles = map[string]bool{"super_admin": true, "seller_admin": true}

/*
derivedRoles are facts about a person, not workspaces to hand out.

	student and parent come from a record link. class_teacher comes from naming
	somebody on a section — the same fact that decides whose report cards they
	may generate — and granting it here would put that in two places, so the day
	the two disagree the menu is wrong and nobody knows which half to believe.

	Each says where the fact actually lives, because "you cannot do that" without
	"here is where you can" is how somebody ends up editing the database.
*/
var derivedRoles = map[string]bool{
	"student": true, "parent": true, "class_teacher": true,
}

var derivedFrom = map[string]string{
	"student":       "linking the person to a student record",
	"parent":        "linking the person to a child as their guardian",
	"class_teacher": "naming them class teacher on the section itself",
}

/*
Roles that draw the same screens.

	A HOD who teaches gets marks entry, homework, lesson plans, the register and
	report cards from their own role, the moment somebody allocates them a
	subject — the same switch every other teacher is turned on by. Adding faculty
	on top gives a second workspace holding the same five entries, and the person
	has to learn which copy to use.

	Stated as a pair rather than a list of forbidden roles, because the objection
	is to the combination and not to either half: both are perfectly good roles
	on their own.
*/
var overlappingRoles = [][2]string{
	// 11 of the HOD's 22 entries are the faculty role's own: marks entry,
	// homework, lesson plans, the register, report cards.
	{"hod", "faculty"},
	// All five of the receptionist's entries are inside admissions — the same
	// four desk registers plus My pay. Granting both is the front desk twice.
	{"admissions", "front_office"},
	// The warden's six entries are the principal's hostel section drawn again
	// under its own name: rooms, outpasses and laundry are the same screens.
	{"institution_admin", "hostel_warden"},
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

/*
What to do instead, per pair.

	A refusal that only says no leaves somebody to guess, and the guess is
	usually to grant it anyway from another screen.
*/
var overlapRemedy = map[[2]string]string{
	{"hod", "faculty"}: "A head of department who teaches gets marks entry, homework and " +
		"the register from the hod role as soon as somebody allocates them a subject in " +
		"Faculty allocation.",
	{"admissions", "front_office"}: "Admissions already contains the four front-desk " +
		"registers. Give front_office alone to somebody who only works the desk, or " +
		"admissions alone to somebody who does both.",
	{"institution_admin", "hostel_warden"}: "The principal's workspace already holds the " +
		"whole hostel section. Give hostel_warden alone to the person who runs the hostel; " +
		"a principal who also does so already has every register from their own role.",
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
				pair[1] + ". They draw the same screens. " + overlapRemedy[pair])
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
	/* Installed roles, and the ones this school could install.

	   A school starts with the common half — teacher, HOD, finance, HR — and
	   the rest arrive when somebody is first given one. Listing only what is
	   installed meant a librarian could never be appointed, because appointing
	   one is what installs it. The chicken had to be offered before the egg. */
	installable := map[string]string{}
	for _, sr := range rbac.SystemRoles {
		if rbac.IsDefault(sr.Key) || rbac.PlatformRoles[sr.Key] ||
			sr.Key == "student" || sr.Key == "parent" {
			continue
		}
		installable[sr.Key] = sr.Name
	}

	items, err := collect(s, r, `
		SELECT r.key, r.name,
		       (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id)::int,
		       (SELECT count(*) FROM user_roles ur WHERE ur.role_id = r.id)::int
		  FROM roles r
		 WHERE r.key <> ALL($1::text[])
		   AND ($2 OR r.key <> ALL($3::text[]))
		 ORDER BY r.name`,
		[]any{[]string{"student", "parent"}, id.PlatformAdmin,
			platformOnlyKeys()},
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

	/* The keys each installed role grants, in one pass rather than a query per
	   role, so the editor can show a role's capabilities the instant it is
	   ticked. */
	type rolePermPair struct{ role, perm string }
	pairs, err := collect(s, r, `
		SELECT r.key, rp.permission_key
		  FROM roles r
		  JOIN role_permissions rp ON rp.role_id = r.id
		 ORDER BY r.key, rp.permission_key`, nil,
		func(rows pgx.Rows) (rolePermPair, error) {
			var p rolePermPair
			err := rows.Scan(&p.role, &p.perm)
			return p, err
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	byRole := map[string][]string{}
	for _, p := range pairs {
		byRole[p.role] = append(byRole[p.role], p.perm)
	}
	for i := range items {
		items[i].PermissionKeys = byRole[items[i].Key]
		if items[i].PermissionKeys == nil {
			items[i].PermissionKeys = []string{}
		}
	}

	/* The ones not installed yet, appended.

	   Marked so the screen can say "not set up yet" rather than implying the
	   school already runs a library. Choosing one installs it, which is the
	   same act as the user-roles screen's — the role arrives with its first
	   holder. Their keys come from the seeded definition, since no rows exist in
	   role_permissions until the role is first installed. */
	for _, it := range items {
		delete(installable, it.Key)
	}
	seededKeys := map[string][]string{}
	for _, sr := range rbac.SystemRoles {
		seededKeys[sr.Key] = sr.Permissions
	}
	for key, name := range installable {
		keys := seededKeys[key]
		if keys == nil {
			keys = []string{}
		}
		items = append(items, assignableRole{
			Key:            key,
			Name:           name,
			Description:    descriptions[key],
			Source:         "installable",
			Permissions:    len(keys),
			PermissionKeys: keys,
		})
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
	   admissions, which already contains them.

	   Nor hostel_warden beside institution_admin, for the same reason: the
	   principal's workspace carries the whole hostel section, so the person
	   running everything already has every register the warden has. */
	"institution_admin", "it_admin", "hod",
	"finance", "admissions", "hr", "operations",
	"exam_controller", "librarian", "transport_manager",
}

var rolePresets = []rolePreset{
	{
		Key:  "sole_maintainer",
		Name: "Everything. One person runs the school",
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
		Description: "Admissions, the front desk and the fee counter. The usual front-office bundle.",
		/* admissions, not admissions+front_office: the receptionist's five
		   entries are all inside admissions, so granting both would give this
		   person the front desk twice. */
		RoleKeys: []string{"admissions", "finance"},
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
		Key:  "academic_head",
		Name: "Head of department",
		Description: "A department's staff, classes and approvals. Allocate them a subject in " +
			"Faculty allocation and their own teaching screens appear too.",
		RoleKeys: []string{"hod"},
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
		Key:         "teacher_transport",
		Name:        "Teacher & transport in-charge",
		Description: "Teaches, and runs the routes, vehicles and driver roster.",
		RoleKeys:    []string{"faculty", "transport_manager"},
	},
	{
		Key:  "principal_hr",
		Name: "Principal & payroll",
		Description: "Runs the school and keeps the staff records and salaries, the small-school " +
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

/* Per-account permission overrides.

   A role bundles a workspace, and for almost everybody that is the right unit:
   the person is a teacher, a bursar, a warden. But now and then a single
   account needs one extra capability that no role it holds carries, and neither
   answer the product had was good — invent a whole role for one grant, or widen
   a shared role and hand the key to everyone in it. These endpoints are the
   narrow door: a direct grant to one account, unioned into the session
   alongside the role-based keys (internal/auth/session.go), never replacing
   them.

   Read is gated on access.users.read and write on access.users.write, the same
   rights that already govern who may edit an account on this screen. */

// permissionCatalogItem is one grantable capability, described the way rbac.All
// stores it.
type permissionCatalogItem struct {
	Key         string `json:"key"`
	Module      string `json:"module"`
	Description string `json:"description"`
}

// listPermissionCatalog serves the full capability vocabulary, so the override
// editor can offer every key grouped by module. Platform keys are withheld from
// a tenant administrator: they span every school and are the vendor's to grant.
func (s *Server) listPermissionCatalog(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items := make([]permissionCatalogItem, 0, len(rbac.All))
	for _, p := range rbac.All {
		if !id.PlatformAdmin && (p.Key == rbac.PlatformTenantsRW || p.Key == rbac.PlatformPlansRW) {
			continue
		}
		items = append(items, permissionCatalogItem{Key: p.Key, Module: p.Module, Description: p.Description})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type userPermissions struct {
	UserID string `json:"user_id"`
	// RoleKeys are the capability keys the account gets from its roles. Read-only
	// here: the screen shows them ticked and locked, because removing one means
	// editing a role, not this account.
	RoleKeys []string `json:"role_keys"`
	// DirectKeys are the per-account grants stored in user_permissions — the ones
	// this editor adds and removes.
	DirectKeys []string `json:"direct_keys"`
}

// getUserPermissions returns one account's role-granted keys and its direct
// per-account grants, so the editor can tell the two apart.
func (s *Server) getUserPermissions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	target, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid user id")
		return
	}
	out := userPermissions{UserID: target.String(), RoleKeys: []string{}, DirectKeys: []string{}}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM users WHERE id = $1`, target).Scan(&exists); err != nil {
			return err
		}
		if err := scanInto(r.Context(), tx, `
			SELECT DISTINCT rp.permission_key
			  FROM user_roles ur
			  JOIN role_permissions rp ON rp.role_id = ur.role_id
			 WHERE ur.user_id = '`+target.String()+`'::uuid
			 ORDER BY rp.permission_key`,
			func(rows pgx.Rows) error {
				var k string
				if err := rows.Scan(&k); err != nil {
					return err
				}
				out.RoleKeys = append(out.RoleKeys, k)
				return nil
			}); err != nil {
			return err
		}
		return scanInto(r.Context(), tx, `
			SELECT permission_key FROM user_permissions
			 WHERE user_id = '`+target.String()+`'::uuid
			 ORDER BY permission_key`,
			func(rows pgx.Rows) error {
				var k string
				if err := rows.Scan(&k); err != nil {
					return err
				}
				out.DirectKeys = append(out.DirectKeys, k)
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

/* Per-user FEATURE grants — the exception door for menu tiles.

   Role-based access is the rule: a role carries a workspace and every tile in
   it. But now and then one account needs a single screen its roles do not carry
   — a receptionist who must Take attendance, an office clerk who needs Student
   360 — and inventing a role or widening a shared one is the wrong size for a
   one-off. So an admin may grant an individual catalog FEATURE (a menu tile,
   keyed role.section.feature) to one account. The catalog then shows that tile
   for that person (see getCatalog), and the auto-capability map below hands them
   the capability keys the screen behind it actually gates on, so the tile is not
   a door onto a 403. */

// allCatalogFeatureKeys is the set of every feature key the catalog defines
// (role.section.feature). setUserPermissions accepts a grant if it is one of
// these, in addition to the rbac capability vocabulary.
func allCatalogFeatureKeys() map[string]bool {
	out := map[string]bool{}
	for _, role := range catalog.Roles {
		for _, sec := range role.Sections {
			for _, f := range sec.Features {
				out[f.Key] = true
			}
		}
	}
	return out
}

/*
featureUnlocks maps a feature SLUG (the part after the last dot in its key) to

	the capability keys the screen behind that tile gates on. When an admin
	ENABLES one of these features for an account, those capabilities are unioned
	into the persisted grant so the person can actually use the screen rather than
	land on a permission error.

	Deliberately small and explicit: only the tiles a school hands out as a
	one-off exception, keyed by slug so the same screen (Class 360 appears under
	several workspaces) is covered wherever it is catalogued.
*/
// A per-person grant is an EXCEPTION handed to someone who does not hold the
// role — so they have no assigned classes/sections to scope to. The screens
// scope to "own" data by default and would show "nothing in your scope", so the
// unlocks include the WHOLE-SCHOOL wideners (read.all / write.any): granting the
// tile means "let this person do this across the school", which is the only way
// an office account without a class can use it. The Individual-features editor
// shows each of these under "Also grants:" so the reach is never a surprise.
var featureUnlocks = map[string][]string{
	// Take attendance: mark the register for ANY section.
	"take_attendance": {rbac.AttendanceWrite, rbac.AttendanceWriteAny},
	// Absentee follow-up / Present & absent: read the register for the whole
	// school (read alone is only the grantee's own sections — none, for an
	// office account — which reads as "nothing in your scope").
	"absentee_followup": {rbac.AttendanceRead, rbac.AttendanceReadAll},
	"student_absentees": {rbac.AttendanceRead, rbac.AttendanceReadAll},
	// Class 360: read every class, its students and their attendance.
	"class_360": {rbac.Class360Read, rbac.StudentsRead, rbac.StudentsReadAll, rbac.AttendanceRead, rbac.AttendanceReadAll},
	// Student 360: any child's whole record.
	"student_360": {rbac.StudentsRead, rbac.StudentsReadAll},
	// Staff overview / Staff 360: read employee records (institution-wide).
	"staff_360":      {rbac.EmployeesRead},
	"staff_overview": {rbac.EmployeesRead},
	// Marks entry: enter and amend marks.
	"marks_entry": {rbac.MarksWrite},
	"enter_marks": {rbac.MarksWrite},
	// Homework: set homework and review submissions.
	"homework":             {rbac.HomeworkWrite},
	"homework_assignments": {rbac.HomeworkWrite},
}

// featureSlug returns the part of a feature key after the last dot, which is the
// key featureUnlocks is indexed by.
func featureSlug(key string) string {
	if i := strings.LastIndex(key, "."); i >= 0 {
		return key[i+1:]
	}
	return key
}

type setUserPermissionsRequest struct {
	PermissionKeys []string `json:"permission_keys"`
}

// setUserPermissions replaces the per-account grants on one account with the
// set given. Only keys in the capability vocabulary are accepted, and platform
// keys are withheld from a tenant administrator for the same reason the role
// grid withholds them: RLS would not stop a tenant admin awarding themselves
// the vendor's console, because the account is legitimately theirs.
func (s *Server) setUserPermissions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	target, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid user id")
		return
	}
	var req setUserPermissionsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	known := make(map[string]bool, len(rbac.All))
	for _, p := range rbac.All {
		known[p.Key] = true
	}
	// Catalog feature keys are also grantable here — the exception door for menu
	// tiles. Anything that is neither a capability nor a feature is still
	// rejected.
	features := allCatalogFeatureKeys()
	// De-duplicate and validate before opening a transaction, so a typo cannot
	// half-apply.
	seen := map[string]bool{}
	desired := make([]string, 0, len(req.PermissionKeys))
	add := func(k string) {
		if !seen[k] {
			seen[k] = true
			desired = append(desired, k)
		}
	}
	for _, k := range req.PermissionKeys {
		if !known[k] && !features[k] {
			/* A key that is neither a capability nor a current catalog feature is
			   dropped, not rejected. It is almost always a feature that was
			   renamed or retired (e.g. take_attendance folded into the Attendance
			   hub): the account still carries the old key, the editor seeds it
			   back, and a hard 400 then makes the whole panel unsavable. Silently
			   dropping it cleans the orphan up on the next save. The input is
			   checkboxes, not free text, so a typo cannot reach here. */
			continue
		}
		if !id.PlatformAdmin && (k == rbac.PlatformTenantsRW || k == rbac.PlatformPlansRW) {
			httpx.Denied(w, r, "platform permissions can only be granted by the vendor")
			return
		}
		add(k)
		// Granting a feature tile also unlocks the capabilities the screen behind
		// it gates on, so the person can act and not just see the tile.
		// Conservative: unlocks are only unioned in for features being ENABLED in
		// this save; capabilities the admin set directly are left exactly as sent.
		if features[k] {
			for _, cap := range featureUnlocks[featureSlug(k)] {
				add(cap)
			}
		}
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM users WHERE id = $1`, target).Scan(&exists); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM user_permissions WHERE user_id = $1 AND permission_key <> ALL($2)`,
			target, desired); err != nil {
			return err
		}
		for _, k := range desired {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO user_permissions (user_id, institution_id, permission_key, granted_by)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (user_id, permission_key) DO NOTHING`,
				target, id.InstitutionID, k, id.UserID); err != nil {
				return err
			}
		}
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
	// The permission map is cached per user; drop it so the grant takes effect
	// on the next request rather than when the cache next expires.
	forget(target)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"user_id": target.String(), "direct_keys": desired,
		"note": "The account gains these the next time it signs in.",
	})
}

// featureCatalogItem is one grantable feature, de-duplicated by NAME across the
// several workspaces it may be catalogued under. Key is a canonical variant key
// (deterministic, the first encountered in catalog.Roles order); Keys are ALL
// the variant keys that share the name, so granting adds the canonical one and
// revoking clears every variant. Unlocks are the human-readable capability
// descriptions granting the feature also confers, unioned across variants.
type featureCatalogItem struct {
	Name    string   `json:"name"`
	Summary string   `json:"summary"`
	Unlocks []string `json:"unlocks"`
	Key     string   `json:"key"`
	Keys    []string `json:"keys"`
}

// listFeatureCatalog serves a flat, de-duplicated (by name) list of grantable
// features for the "Individual features (exception)" editor on Logins & access.
// It is the tile vocabulary the per-account grant screen offers, the counterpart
// to listPermissionCatalog's capability vocabulary. The same feature name (e.g.
// "Attendance", "Class 360", "Student 360") exists under several workspaces with
// different keys; here each unique name appears once, carrying all its variant
// keys.
func (s *Server) listFeatureCatalog(w http.ResponseWriter, r *http.Request) {
	// Capability descriptions, so unlocks read as sentences rather than keys.
	desc := make(map[string]string, len(rbac.All))
	for _, p := range rbac.All {
		desc[p.Key] = p.Description
	}

	/* Tiles that come with a role automatically and are never a meaningful
	   one-off exception — every workspace's Dashboard, and the home landing
	   screens. Hiding them keeps this picker to the screens a school actually
	   hands out per person (Attendance, Class 360, Student 360, marks, …)
	   instead of burying them under a dozen Dashboards. */
	skipSlug := map[string]bool{
		"dashboard": true, "home": true, "my_day": true, "todays_classes": true,
		"my_work": true, "my_calendar": true, "my_run": true,
	}

	// One accumulator per unique feature name. Walk catalog.Roles in order so the
	// canonical key (first encountered) and the item order are deterministic.
	items := []*featureCatalogItem{}
	idx := map[string]int{}
	// De-dupe variant keys and unlock descriptions within each item.
	seenKey := map[string]map[string]bool{}
	seenUnlock := map[string]map[string]bool{}
	for _, role := range catalog.Roles {
		for _, sec := range role.Sections {
			for _, f := range sec.Features {
				if skipSlug[featureSlug(f.Key)] {
					continue
				}
				if f.Name == "" {
					continue
				}
				ii, ok := idx[f.Name]
				if !ok {
					ii = len(items)
					idx[f.Name] = ii
					items = append(items, &featureCatalogItem{
						Name: f.Name, Summary: f.Summary,
						Unlocks: []string{}, Key: f.Key, Keys: []string{},
					})
					seenKey[f.Name] = map[string]bool{}
					seenUnlock[f.Name] = map[string]bool{}
				}
				it := items[ii]
				// Summary: keep the first non-empty one seen.
				if it.Summary == "" && f.Summary != "" {
					it.Summary = f.Summary
				}
				// Collect this variant's key.
				if !seenKey[f.Name][f.Key] {
					seenKey[f.Name][f.Key] = true
					it.Keys = append(it.Keys, f.Key)
				}
				// Union this variant's unlocks (resolved to descriptions), de-duped.
				for _, cap := range featureUnlocks[featureSlug(f.Key)] {
					d := desc[cap]
					if d == "" {
						d = cap
					}
					if !seenUnlock[f.Name][d] {
						seenUnlock[f.Name][d] = true
						it.Unlocks = append(it.Unlocks, d)
					}
				}
			}
		}
	}

	// Sort by name, case-insensitive.
	sort.Slice(items, func(a, b int) bool {
		return strings.ToLower(items[a].Name) < strings.ToLower(items[b].Name)
	})

	out := make([]featureCatalogItem, 0, len(items))
	for _, it := range items {
		out = append(out, *it)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}
