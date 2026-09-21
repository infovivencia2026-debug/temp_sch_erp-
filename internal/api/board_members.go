package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

var errUnknownInstitution = errors.New("one of the named institutions does not exist")

/* Cross-institution board members, minted from the vendor console.

   A board member oversees several schools at once — a trust's finance
   committee, say — and needs to read each of them in turn. The design is
   deliberately not a platform role: a board member is an ordinary school user
   with a home institution, plus a board_member user_roles row in EACH school
   they oversee. "Membership" is exactly that row. Switching between schools is
   the existing ActingInstitution mechanism, extended (see acting.go) to a
   non-platform user but only to a school where they hold such a row — and the
   data still reads under that school's RLS with their board_member grants, so
   this never becomes a platform bypass.

   Granting those memberships is cross-tenant, which makes it a platform action.
   These endpoints mirror support_accounts.go: gated by requirePlatformOperator
   (id.PlatformAdmin && platform.tenants.write), and every write runs AsPlatform
   so RLS lands rows across institutions. The role key granted is hardcoded to
   board_member and never taken from the request, so this door cannot mint any
   other role. */

type boardMemberRequest struct {
	FullName       string   `json:"full_name"`
	Email          string   `json:"email,omitempty"`
	Phone          string   `json:"phone,omitempty"`
	InstitutionIDs []string `json:"institution_ids"`
}

type boardSchoolRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type boardMemberRow struct {
	ID       string           `json:"id"`
	FullName string           `json:"full_name"`
	Email    *string          `json:"email,omitempty"`
	Phone    *string          `json:"phone,omitempty"`
	Status   string           `json:"status"`
	Schools  []boardSchoolRef `json:"schools"`
}

// listBoardMembers lists every user holding board_member in any institution,
// with the schools each oversees. Cross-tenant, so AsPlatform and gated.
func (s *Server) listBoardMembers(w http.ResponseWriter, r *http.Request) {
	if !requirePlatformOperator(w, r) {
		return
	}
	// Flat rows grouped in Go, ordered so a member's schools stay together and
	// stable. One user with three memberships is three rows here.
	var out []boardMemberRow
	byID := map[string]int{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT u.id::text, u.full_name, u.email::text, u.phone, u.status,
			       i.id::text, i.name
			  FROM users u
			  JOIN user_roles ur ON ur.user_id = u.id
			  JOIN roles ro ON ro.id = ur.role_id AND ro.key = 'board_member'
			  JOIN institutions i ON i.id = ur.institution_id
			 ORDER BY u.full_name, u.id, i.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var uid, name, status, sid, sname string
			var email, phone *string
			if err := rows.Scan(&uid, &name, &email, &phone, &status, &sid, &sname); err != nil {
				return err
			}
			idx, ok := byID[uid]
			if !ok {
				idx = len(out)
				byID[uid] = idx
				out = append(out, boardMemberRow{
					ID: uid, FullName: name, Email: email, Phone: phone, Status: status,
				})
			}
			out[idx].Schools = append(out[idx].Schools, boardSchoolRef{ID: sid, Name: sname})
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if out == nil {
		out = []boardMemberRow{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

// createBoardMember creates-or-finds a user and grants them board_member in the
// named set of institutions. On create the user's home is the first
// institution_id and a one-time password is returned; an existing user keeps
// their home and just gains the memberships.
func (s *Server) createBoardMember(w http.ResponseWriter, r *http.Request) {
	if !requirePlatformOperator(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var req boardMemberRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.FullName = strings.TrimSpace(req.FullName)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Phone = strings.TrimSpace(req.Phone)
	if req.FullName == "" {
		httpx.BadRequest(w, r, "the board member needs a name")
		return
	}
	if req.Email == "" && req.Phone == "" {
		httpx.BadRequest(w, r, "an email or a phone number is required to sign in")
		return
	}
	if len(req.InstitutionIDs) == 0 {
		httpx.BadRequest(w, r, "name at least one school this board member oversees")
		return
	}
	insts := make([]uuid.UUID, 0, len(req.InstitutionIDs))
	seen := map[uuid.UUID]struct{}{}
	for _, raw := range req.InstitutionIDs {
		u, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			httpx.BadRequest(w, r, "each institution_id must be a uuid")
			return
		}
		if _, dup := seen[u]; dup {
			continue
		}
		seen[u] = struct{}{}
		insts = append(insts, u)
	}
	home := insts[0]

	// The same one-time value the seller-provisioning path issues, used only if
	// this call creates the user. Read aloud once, stored only as a hash, forced
	// to be changed on first sign-in.
	password, err := temporaryPassword()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	hash, err := s.Hasher.Hash(password)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var userID string
	var created bool
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		// Every named school must be real. Refusing early keeps a typo from
		// installing a role into nothing and half-granting the rest.
		var found int
		if err := tx.QueryRow(r.Context(),
			`SELECT count(*) FROM institutions WHERE id = ANY($1)`, insts).Scan(&found); err != nil {
			return err
		}
		if found != len(insts) {
			return errUnknownInstitution
		}

		// Create-or-find, scoped to the home institution because users are
		// unique per (institution_id, email) / (institution_id, phone). An
		// existing user keeps their home; only a fresh one takes home = insts[0].
		var lookupSQL string
		var lookupArg any
		switch {
		case req.Email != "":
			lookupSQL = `SELECT id::text FROM users WHERE institution_id = $1 AND email = $2::citext`
			lookupArg = req.Email
		default:
			lookupSQL = `SELECT id::text FROM users WHERE institution_id = $1 AND phone = $2`
			lookupArg = req.Phone
		}
		err := tx.QueryRow(r.Context(), lookupSQL, home, lookupArg).Scan(&userID)
		switch {
		case err == pgx.ErrNoRows:
			created = true
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO users (institution_id, email, phone, full_name, password_hash,
				                   status, must_change_password)
				VALUES ($1, $2::citext, $3, $4, $5, 'active', true)
				RETURNING id::text`,
				home, nullString(req.Email), nullString(req.Phone), req.FullName, hash).Scan(&userID); err != nil {
				return err
			}
		case err != nil:
			return err
		}

		// board_member is optional per institution, so it may not exist in a
		// given school yet. InstallRole seeds it on demand (idempotent) and
		// returns its id — the per-institution equivalent of EnsurePlatformRole.
		for _, inst := range insts {
			roleID, _, err := rbac.InstallRole(r.Context(), tx, inst, "board_member")
			if err != nil {
				return err
			}
			// The role key is never taken from the request: board_member is
			// hardcoded above, which is what structurally stops this endpoint
			// granting anything else.
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO user_roles (institution_id, user_id, role_id)
				VALUES ($1, $2::uuid, $3)
				ON CONFLICT (user_id, role_id) WHERE campus_id IS NULL DO NOTHING`,
				inst, userID, roleID); err != nil {
				return err
			}
		}
		return nil
	})

	subject := req.FullName
	if req.Email != "" {
		subject = req.FullName + " <" + req.Email + ">"
	}
	if err != nil {
		recordPlatformEvent(r.Context(), s.DB, "board_member", false, nil,
			subject, err.Error(), id.UserID)
		if err == errUnknownInstitution {
			httpx.BadRequest(w, r, "one of those schools does not exist")
			return
		}
		if isUniqueViolation(err) {
			httpx.Error(w, r, http.StatusConflict, "account_in_use",
				"an account at that school already uses that email or phone")
			return
		}
		httpx.Internal(w, r, err)
		return
	}

	// A membership changed what this user's session and scope may reach, so the
	// caches that answer "who is this" and "which rows" must forget them.
	if uid, perr := uuid.Parse(userID); perr == nil {
		forget(uid)
	}

	recordPlatformEvent(r.Context(), s.DB, "board_member", true, &home,
		subject, "board_member granted in "+plural(len(insts), "school", "schools"), id.UserID)

	resp := map[string]any{
		"user_id":     userID,
		"full_name":   req.FullName,
		"schools":     len(insts),
		"created":     created,
		"home_school": home.String(),
	}
	if created {
		login := req.Email
		if login == "" {
			login = req.Phone
		}
		resp["sign_in_as"] = login
		resp["temporary_password"] = password
		resp["note"] = "Shown once and not stored. Hand it over; they set their own " +
			"password the first time they sign in."
	} else {
		resp["note"] = "This person already had an account; their sign-in and password " +
			"are unchanged. They now oversee the named schools."
	}
	httpx.JSON(w, http.StatusCreated, resp)
}

// removeBoardMembership drops one board_member user_roles row — the membership
// in a single school. Their home and their other memberships are untouched.
func (s *Server) removeBoardMembership(w http.ResponseWriter, r *http.Request) {
	if !requirePlatformOperator(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	userID, err := uuid.Parse(chiURLParam(r, "userID"))
	if err != nil {
		httpx.BadRequest(w, r, "userID must be a uuid")
		return
	}
	instID, err := uuid.Parse(chiURLParam(r, "instID"))
	if err != nil {
		httpx.BadRequest(w, r, "institution id must be a uuid")
		return
	}

	var removed int64
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			DELETE FROM user_roles ur
			 USING roles ro
			 WHERE ur.role_id = ro.id
			   AND ro.key = 'board_member'
			   AND ur.user_id = $1
			   AND ur.institution_id = $2`,
			userID, instID)
		if err != nil {
			return err
		}
		removed = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if removed == 0 {
		httpx.Error(w, r, http.StatusNotFound, "no_such_membership",
			"that person does not oversee that school")
		return
	}

	// Their reach just narrowed; forget the cached identity and scope so the
	// next request cannot still act on the school taken away.
	forget(userID)
	s.forgetInstitution(instID)

	recordPlatformEvent(r.Context(), s.DB, "board_member", true, &instID,
		userID.String(), "board_member membership removed", id.UserID)
	httpx.JSON(w, http.StatusOK, map[string]any{"removed": true})
}
