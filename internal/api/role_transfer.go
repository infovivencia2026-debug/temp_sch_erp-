package api

import (
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Handing a job over.

   People leave. The bursar retires, the exam controller moves schools, a
   teacher takes over as head of department in the middle of a term. Until now
   that took two edits: grant the roles to the joiner, then remember to go and
   revoke them from the leaver. Between the two the school had two bursars, and
   if the second edit was forgotten it had two bursars permanently — which is
   the failure that actually happens, because the interesting half of the job
   is done after the first edit and nobody is chasing the second.

   A transfer is therefore one action in one transaction. The joiner gains the
   role exactly when the leaver loses it, and either both happen or neither
   does.

   Two things it refuses. It will not strip the last institution_admin from a
   school, because a school with no administrator cannot appoint one and the
   only way back is somebody with database access. And it will not transfer a
   role the caller does not hold the right to assign, which is the same rule
   setRoles already applies — a transfer is not a way to grant sideways what
   you could not grant directly.
*/

type roleTransferRequest struct {
	FromUserID string `json:"from_user_id"`
	ToUserID   string `json:"to_user_id"`
	// The roles to move. Empty means every role the leaver holds, which is
	// the ordinary "they have left, give their job to this person" case.
	RoleKeys []string `json:"role_keys,omitempty"`
	// What becomes of the leaver's account. Empty leaves it alone: somebody
	// handing over one hat of three is still on the staff.
	LeaverStatus string `json:"leaver_status,omitempty"`
}

// The statuses a handed-over account may be left in. Deliberately not
// every users.status: "invited" is a state an account arrives in, not one it
// can be put back into by somebody else leaving.
var leaverStatuses = []string{"active", "suspended", "archived"}

/*
transferRoles moves roles from one account to another, atomically.

	Gated on roles.write, the same permission that setRoles requires: this is
	that operation done twice without a gap in the middle, not a new authority.
*/
func (s *Server) transferRoles(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req roleTransferRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	from, err := uuid.Parse(strings.TrimSpace(req.FromUserID))
	if err != nil {
		httpx.BadRequest(w, r, "from_user_id must be a uuid")
		return
	}
	to, err := uuid.Parse(strings.TrimSpace(req.ToUserID))
	if err != nil {
		httpx.BadRequest(w, r, "to_user_id must be a uuid")
		return
	}
	if from == to {
		httpx.BadRequest(w, r, "a role cannot be transferred to the person who already holds it")
		return
	}
	if v := strings.TrimSpace(req.LeaverStatus); v != "" {
		if !oneOfStr(v, leaverStatuses...) {
			httpx.BadRequest(w, r,
				"leaver_status must be one of "+strings.Join(leaverStatuses, ", "))
			return
		}
	}

	var (
		errNoSuchUser  = errors.New("no such user")
		errNothingHeld = errors.New("nothing held")
		errLastAdmin   = errors.New("last admin")
	)
	var moved []string
	var fromName, toName string

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Both accounts read inside the tenant scope, so a foreign id is a
		// missing row rather than somebody else's name.
		if err := tx.QueryRow(r.Context(),
			`SELECT full_name FROM users WHERE id = $1`, from).Scan(&fromName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errNoSuchUser
			}
			return err
		}
		if err := tx.QueryRow(r.Context(),
			`SELECT full_name FROM users WHERE id = $1`, to).Scan(&toName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errNoSuchUser
			}
			return err
		}

		// What the leaver actually holds. Naming a role they do not hold is
		// not an error worth failing on, but it is not a transfer either, so
		// the intersection is what moves and the caller is told what moved.
		rows, err := tx.Query(r.Context(), `
			SELECT r.key FROM user_roles ur
			  JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id = $1
			 ORDER BY r.key`, from)
		if err != nil {
			return err
		}
		var held []string
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				rows.Close()
				return err
			}
			held = append(held, k)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		wanted := map[string]bool{}
		for _, k := range req.RoleKeys {
			if k = strings.TrimSpace(k); k != "" {
				wanted[k] = true
			}
		}
		for _, k := range held {
			if len(wanted) == 0 || wanted[k] {
				moved = append(moved, k)
			}
		}
		if len(moved) == 0 {
			return errNothingHeld
		}

		/* The last administrator.

		   Counted before anything is written, and counted over people who can
		   still sign in — an archived account holding the role is not somebody
		   who can appoint a replacement. The joiner counts, because by the end
		   of this transaction they will hold it; that is the whole point, and
		   refusing a handover from the only admin to their successor would
		   make the rule useless exactly when it is needed. */
		for _, k := range moved {
			if k != "institution_admin" {
				continue
			}
			var others int
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*)::int FROM user_roles ur
				  JOIN roles r ON r.id = ur.role_id
				  JOIN users u ON u.id = ur.user_id
				 WHERE r.key = 'institution_admin'
				   AND u.status = 'active'
				   AND ur.user_id <> $1`, from).Scan(&others); err != nil {
				return err
			}
			// Zero others, and the joiner is not about to become one because
			// their account cannot sign in.
			if others == 0 {
				var active bool
				if err := tx.QueryRow(r.Context(),
					`SELECT status = 'active' FROM users WHERE id = $1`, to).Scan(&active); err != nil {
					return err
				}
				if !active {
					return errLastAdmin
				}
			}
		}

		// Grant, then revoke, in that order and in one transaction. The order
		// does not matter to a reader — nobody sees the middle — but it means
		// a failure on the grant leaves the leaver holding the job rather than
		// nobody holding it.
		if _, err := setUserRoles(r, tx, id.InstitutionID, to.String(), moved, false); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			DELETE FROM user_roles ur
			 USING roles r
			 WHERE r.id = ur.role_id
			   AND ur.user_id = $1
			   AND r.key = ANY($2::text[])`, from, moved); err != nil {
			return err
		}

		if v := strings.TrimSpace(req.LeaverStatus); v != "" {
			if _, err := tx.Exec(r.Context(),
				`UPDATE users SET status = $2 WHERE id = $1`, from, v); err != nil {
				return err
			}
		}
		return nil
	})

	switch {
	case errors.Is(err, errNoSuchUser):
		httpx.BadRequest(w, r, "both accounts must belong to this school")
		return
	case errors.Is(err, errNothingHeld):
		httpx.BadRequest(w, r,
			"that person holds none of those roles, so there is nothing to hand over")
		return
	case errors.Is(err, errLastAdmin):
		httpx.BadRequest(w, r,
			"this is the school's only administrator, and the account receiving the role cannot sign in — "+
				"activate it first, or give the role to somebody who can")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}

	sort.Strings(moved)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"from":        map[string]any{"id": from.String(), "name": fromName},
		"to":          map[string]any{"id": to.String(), "name": toName},
		"transferred": moved,
		"note": fromName + " no longer holds " +
			strings.Join(moved, ", ") + "; " + toName + " does.",
	})
}
