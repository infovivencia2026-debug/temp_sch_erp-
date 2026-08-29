package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Putting a list of passwords back.

   Issuing logins in bulk hands over a file of one-time passwords and then
   forgets them: they are shown once, hashed, and never recoverable. That is
   the right way round for secrecy and the wrong way round for a school that
   downloaded the file, printed half of it, and then had somebody close the
   tab — because the only way back was resetting every account and handing out
   a second set of passwords that contradicted the first.

   This reads that same file back and makes it true again. Not "restore", which
   would imply the old hashes are still somewhere: the passwords in the file
   are simply set, so the file the office is working from becomes the file that
   works.

   Deliberately the same shape as the download. A round trip that needs the
   columns rearranged is a round trip nobody completes.
*/

type staffLoginImportRow struct {
	SignInAs string `json:"sign_in_as"`
	Password string `json:"password"`
}

type staffLoginImportRequest struct {
	Rows []staffLoginImportRow `json:"rows"`
}

type staffLoginImportSkip struct {
	SignInAs string `json:"sign_in_as"`
	Why      string `json:"why"`
}

// importStaffLogins sets passwords for staff named in an uploaded list.
//
// Only staff of the caller's own school, matched on whatever they sign in
// with. A row naming somebody who is not on the payroll is reported rather
// than silently dropped: a file half of which did nothing, with no indication
// which half, is worse than a refusal.
func (s *Server) importStaffLogins(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req staffLoginImportRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Rows) == 0 {
		httpx.BadRequest(w, r, "the file had no rows in it")
		return
	}
	if len(req.Rows) > 2000 {
		httpx.BadRequest(w, r, "that is more rows than a school has staff, check the file")
		return
	}

	set := 0
	skipped := []staffLoginImportSkip{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, row := range req.Rows {
			who := strings.TrimSpace(row.SignInAs)
			pw := strings.TrimSpace(row.Password)
			if who == "" {
				continue
			}
			// The same floor the reset page enforces. A file is not a reason
			// to accept a password that could not be typed into the product.
			if len(pw) < 10 {
				skipped = append(skipped, staffLoginImportSkip{who,
					"the password in the file is shorter than ten characters"})
				continue
			}

			/* Staff of this school, matched on either identifier, and exactly
			   one of them. An address is unique within a school and a bulk
			   file is written by hand often enough that two rows can name the
			   same person two ways; setting a password from an ambiguous match
			   is how the wrong person is locked out. */
			var target uuid.UUID
			err := tx.QueryRow(r.Context(), `
				SELECT u.id
				  FROM users u
				  JOIN employees e ON e.user_id = u.id AND e.status = 'active'
				 WHERE u.institution_id = $1
				   AND (u.username = $2::citext OR u.email = $2::citext)`,
				id.InstitutionID, who).Scan(&target)
			switch {
			case err == pgx.ErrNoRows:
				skipped = append(skipped, staffLoginImportSkip{who,
					"nobody on the staff signs in with that"})
				continue
			case err != nil && strings.Contains(err.Error(), "more than one row"):
				skipped = append(skipped, staffLoginImportSkip{who,
					"more than one member of staff matches that"})
				continue
			case err != nil:
				return err
			}

			hash, herr := s.Hasher.Hash(pw)
			if herr != nil {
				return herr
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE users SET password_hash = $2, status = 'active', updated_at = now()
				 WHERE id = $1`, target, hash); err != nil {
				return err
			}
			// Same reasoning as a reset: a password that changed while
			// somebody else's cookie is still alive has not really changed.
			if _, err := tx.Exec(r.Context(), `
				UPDATE sessions SET revoked_at = now()
				 WHERE user_id = $1 AND revoked_at IS NULL`, target); err != nil {
				return err
			}
			set++
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"set":     set,
		"skipped": skipped,
		"note": "Those passwords are now the ones that work. Anybody whose password " +
			"changed has been signed out of their other devices.",
	})
}
