package api

import (
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* An account whose job is decided afterwards.

   Every school has somebody the built-in roles do not describe: a
   correspondent who should see fees but not marks, a trustee who should see
   everything and change nothing, a coordinator who runs two classes and
   nothing else. Making one today takes three screens — create a role, tick a
   grid, create a user, remember to attach the one to the other — and the third
   step is the one that gets forgotten, which leaves a role nobody holds and an
   account that can see nothing.

   This is those three in one press: a role of its own, an account holding only
   that role, and a temporary password to hand over. What the account may see
   and change is then the grid, which already says the two things that matter
   per feature — the level (nothing, view, manage) and the scope (the whole
   school, their campus, their classes, only their own). That is what makes it
   generic: the account is created empty and dialled up, rather than created
   powerful and trimmed down.

   It starts at nothing on purpose. An account that begins able to see
   everything is one somebody forgets to restrict, and the forgetting is
   silent; an account that begins able to see nothing is one somebody is
   forced to grant, and the granting is deliberate. The first press therefore
   produces a login that can sign in and read no data at all, and says so.
*/

type genericAccountRequest struct {
	FullName string `json:"full_name"`
	Email    string `json:"email,omitempty"`
	Phone    string `json:"phone,omitempty"`
	// What the role is called on screen. Defaults to the person's name, which
	// is right for the one-off case this exists for; a school making a shared
	// desk account names it for the desk.
	RoleName string `json:"role_name,omitempty"`
	// Start from an existing role's capabilities rather than from nothing.
	// Named by key. The catalog navigation is deliberately not copied — those
	// keys are prefixed with the source role's own key and would point the new
	// role's menu at somebody else's screens.
	CopyFrom string `json:"copy_from,omitempty"`
}

/*
createGenericAccount makes a role and an account holding it, in one transaction.

	Gated on roles.write rather than users.write: the authority being exercised
	is the power to define what somebody may see, and that is strictly the
	larger of the two.
*/
func (s *Server) createGenericAccount(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req genericAccountRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.FullName)
	if name == "" {
		httpx.BadRequest(w, r, "the account needs a name")
		return
	}
	if strings.TrimSpace(req.Email) == "" && strings.TrimSpace(req.Phone) == "" {
		httpx.BadRequest(w, r, "an email or a phone number — the account needs something to sign in with")
		return
	}
	roleName := strings.TrimSpace(req.RoleName)
	if roleName == "" {
		roleName = name
	}
	roleKey := slugKey(roleName)
	if roleKey == "" {
		httpx.BadRequest(w, r, "the role name needs at least one letter or number")
		return
	}

	temp, err := temporaryPassword()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	hash, err := s.Hasher.Hash(temp)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var (
		roleID  uuid.UUID
		userID  string
		copied  int
		dupRole bool
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* The role first. A key collision is reported rather than reused: two
		   people sharing one custom role means dialling one dials the other,
		   which is exactly the surprise this endpoint exists to avoid. */
		err := tx.QueryRow(r.Context(), `
			INSERT INTO roles (institution_id, key, name, is_system, is_default)
			VALUES ($1,$2,$3,false,false)
			RETURNING id`, id.InstitutionID, roleKey, roleName).Scan(&roleID)
		if err != nil {
			if strings.Contains(err.Error(), "roles_institution_key") {
				dupRole = true
			}
			return err
		}

		if from := strings.TrimSpace(req.CopyFrom); from != "" {
			known := make([]string, 0, len(rbac.All))
			for _, p := range rbac.All {
				known = append(known, p.Key)
			}
			if err := tx.QueryRow(r.Context(), `
				WITH ins AS (
				  INSERT INTO role_permissions (role_id, permission_key)
				  SELECT $1, rp.permission_key
				    FROM role_permissions rp
				    JOIN roles src ON src.id = rp.role_id
				   WHERE src.key = $2
				     AND (src.institution_id = $4 OR src.institution_id IS NULL)
				     AND rp.permission_key = ANY($3)
				  ON CONFLICT DO NOTHING
				  RETURNING 1)
				SELECT count(*)::int FROM ins`,
				roleID, from, known, id.InstitutionID).Scan(&copied); err != nil {
				return err
			}
		}

		// The account, active with a temporary password: an invited account
		// with no password is one more thing to remember to finish.
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO users (institution_id, email, phone, full_name, password_hash, status)
			VALUES ($1,$2::citext,$3,$4,$5,'active')
			RETURNING id::text`,
			id.InstitutionID, nullString(req.Email), nullString(req.Phone),
			name, hash).Scan(&userID); err != nil {
			return err
		}

		_, err = tx.Exec(r.Context(), `
			INSERT INTO user_roles (institution_id, user_id, role_id)
			VALUES ($1,$2::uuid,$3)
			ON CONFLICT (user_id, role_id) WHERE campus_id IS NULL DO NOTHING`,
			id.InstitutionID, userID, roleID)
		return err
	})
	switch {
	case dupRole:
		httpx.BadRequest(w, r, "a role called "+roleName+" already exists — give this one a different name")
		return
	case err != nil && strings.Contains(err.Error(), "users_institution_email"):
		httpx.Error(w, r, http.StatusConflict, "email_in_use",
			"another account in this school already uses that email")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}

	note := "This account can sign in and see nothing. Open its role and grant what it should see and change."
	if copied > 0 {
		note = "Started from " + req.CopyFrom + ". Open its role to change what it can see and edit."
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"user_id":            userID,
		"role_id":            roleID.String(),
		"role_key":           roleKey,
		"role_name":          roleName,
		"copied_permissions": copied,
		"temporary_password": temp,
		"note":               note,
		"password_note":      "Shown once. Hand it over in person; ask them to change it from their profile.",
	})
}

/* Built-in roles as starting points rather than fixtures.

   The built-ins cannot be edited in place, and the reason is real: the seeder
   re-runs on every upgrade and restores their grants, so an edit would look
   like it worked and silently revert three weeks later. But "cannot be edited"
   read as "these are the roles you get", and a school whose accountant should
   also see admissions had no obvious move.

   The move is to copy. Every built-in is a preset — a named, sensible bundle
   of permissions to start from — and the copy is an ordinary custom role that
   can be dialled anywhere on the grid. This lists them so a school can see
   what each one would give before taking it, rather than picking a name and
   finding out afterwards.
*/

type roleTemplate struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Permissions int    `json:"permissions"`
	// True when this school already has a role of that key. It is still a
	// perfectly good thing to copy — a school may want two variants of the
	// accountant — so this labels rather than excludes.
	Installed bool `json:"installed"`
}

// listRoleTemplates shows every built-in as something to start from.
//
// Distinct from rolePresets in users.go, which bundles several whole roles for
// the common shapes of staffing. A template is one built-in's permissions,
// offered as the opening position of an editable copy.
func (s *Server) listRoleTemplates(w http.ResponseWriter, r *http.Request) {
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

	items := []roleTemplate{}
	for _, role := range rbac.SystemRoles {
		// Platform roles are the vendor's, not a school's, and copying one
		// would offer a school a starting point it cannot legitimately reach.
		if rbac.PlatformRoles[role.Key] {
			continue
		}
		items = append(items, roleTemplate{
			Key:         role.Key,
			Name:        role.Name,
			Description: optionalRoleNotes[role.Key],
			Permissions: len(role.Permissions),
			Installed:   present[role.Key],
		})
	}
	sort.SliceStable(items, func(a, b int) bool { return items[a].Name < items[b].Name })
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
