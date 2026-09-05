package api

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type profile struct {
	ID          string  `json:"id"`
	FullName    string  `json:"full_name"`
	Email       *string `json:"email,omitempty"`
	Phone       *string `json:"phone,omitempty"`
	AvatarKey   *string `json:"avatar_key,omitempty"`
	Status      string  `json:"status"`
	LastLoginAt *string `json:"last_login_at,omitempty"`
	MFAEnabled  bool    `json:"mfa_enabled"`
	// Enrolment is set when this account is a student. "Which class am I in"
	// is the first thing a child or a parent checks on their own record, and
	// the profile answered every question except that one.
	Enrolment *enrolment `json:"enrolment,omitempty"`
}

type enrolment struct {
	AdmissionNo string `json:"admission_no"`
	ClassName   string `json:"class_name,omitempty"`
	SectionName string `json:"section_name,omitempty"`
	RollNo      *int32 `json:"roll_no,omitempty"`
	Status      string `json:"status,omitempty"`
}

func (s *Server) getProfile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var p profile
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT id::text, full_name, email::text, phone, avatar_key, status,
			       to_char(last_login_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       mfa_secret IS NOT NULL
			  FROM users WHERE id = $1`, id.UserID).
			Scan(&p.ID, &p.FullName, &p.Email, &p.Phone, &p.AvatarKey,
				&p.Status, &p.LastLoginAt, &p.MFAEnabled)
	})
	if err == nil {
		// A miss is the normal case for staff, so it is not an error.
		var e enrolment
		if lookupErr := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT st.admission_no, c.name, sec.name, en.roll_no, en.status
				  FROM students st
				  LEFT JOIN LATERAL (
				      SELECT e.class_id, e.section_id, e.roll_no, e.status
				        FROM enrollments e
				       WHERE e.student_id = st.id
				       ORDER BY e.enrolled_on DESC LIMIT 1
				  ) en ON true
				  LEFT JOIN classes  c   ON c.id = en.class_id
				  LEFT JOIN sections sec ON sec.id = en.section_id
				 WHERE st.user_id = $1`, id.UserID).
				Scan(&e.AdmissionNo, &e.ClassName, &e.SectionName, &e.RollNo, &e.Status)
		}); lookupErr == nil {
			p.Enrolment = &e
		}
	}
	/* An account with no users row this scope can read is a 404, not a 500.

	   Every signed-in screen calls this, so the one case where it cannot find
	   the caller answered "internal server error" on the first page they saw —
	   and put a stack trace in the log for a condition the product has already
	   decided about. */
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

type updateProfileRequest struct {
	FullName string  `json:"full_name"`
	Phone    *string `json:"phone"`
	/* THE PICTURE, WHICH THE COLUMN HAS ALWAYS HAD ROOM FOR.

	   users.avatar_key has been in the baseline since the beginning and the
	   profile read has always returned it. Nothing ever wrote it, so every
	   person in every school was drawn as their initials and there was no way
	   to be anything else.

	   A key, not a URL: the value is the id the file endpoint returns, and the
	   client asks that endpoint for the bytes. Storing a URL would put the
	   host in the database and break every avatar the day the deployment moves.

	   Absent leaves the picture alone; an empty string takes it off. A JSON
	   null cannot be told from a missing field once it is decoded into a
	   pointer, so "remove my photo" is spelled with "" rather than with null,
	   which is the one spelling that survives the round trip. */
	AvatarKey *string `json:"avatar_key"`
	/* THE ADDRESS SOMEBODY SIGNS IN WITH.

	   Left out of this until now, on the grounds that changing a login
	   identifier deserves a verification round trip rather than a PUT. That
	   reasoning is sound and the outcome was not: a teacher whose school
	   address changed, or who was set up under a typo, could correct their
	   name and their number and not the one field they actually sign in with
	   -- and had to ask the office to do it in the staff record.

	   So it is editable, and the password is the check. Not a formality: a
	   session left open on a staffroom computer could otherwise be used to
	   move somebody's login to another address and lock them out of their own
	   school, silently, with no email ever sent. Asking for the password makes
	   that require the password. */
	Email           *string `json:"email"`
	CurrentPassword string  `json:"current_password,omitempty"`
}

func (s *Server) updateProfile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req updateProfileRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.FullName = strings.TrimSpace(req.FullName)
	if req.FullName == "" || utf8.RuneCountInString(req.FullName) > 120 {
		httpx.BadRequest(w, r, "full_name must be 1-120 characters")
		return
	}
	/* Changing the address you sign in with costs a password.

	   Only when it actually changes -- somebody correcting their phone number
	   should not be asked for a password because the email field was posted
	   back unchanged. */
	var newEmail *string
	if req.Email != nil {
		e := strings.ToLower(strings.TrimSpace(*req.Email))
		if e != "" && !strings.Contains(e, "@") {
			httpx.BadRequest(w, r, "that does not look like an email address")
			return
		}
		var currentEmail *string
		var hash *string
		if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`SELECT email::text, password_hash FROM users WHERE id = $1`,
				id.UserID).Scan(&currentEmail, &hash)
		}); err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if currentEmail == nil || !strings.EqualFold(strings.TrimSpace(*currentEmail), e) {
			if hash == nil || s.Hasher.Verify(*hash, req.CurrentPassword) != nil {
				httpx.BadRequest(w, r,
					"enter your current password to change the address you sign in with")
				return
			}
			newEmail = &e
		}
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE users
			   SET full_name = $2,
			       phone = $3,
			       -- Absent keeps what is there, "" clears it, anything else
			       -- replaces it.
			       avatar_key = CASE
			                      WHEN $5::text IS NULL THEN avatar_key
			                      WHEN $5 = '' THEN NULL
			                      ELSE $5
			                    END,
			       -- Left alone unless it changed, so a caller that does not
			       -- send the field cannot blank a login identifier.
			       email = COALESCE($4::citext, email),
			       updated_at = now()
			 WHERE id = $1`,
			id.UserID, req.FullName, req.Phone, newEmail, req.AvatarKey)
		return err
	})
	/* A number somebody else already has is the caller's problem to fix, not a
	   fault. A phone is unique within a school because it is a sign-in
	   identifier — two people sharing one would make "who is this" ambiguous
	   at the login screen — and "something went wrong" tells the person
	   holding the phone none of that. */
	if isUniqueViolation(err) {
		// Both the phone and the email are unique within a school, so the
		// message names whichever one this call was actually changing.
		if newEmail != nil {
			httpx.BadRequest(w, r,
				"that email address is already on another account at this school. "+
					"An address can only sign in as one person")
			return
		}
		httpx.BadRequest(w, r,
			"that phone number is already on another account at this school, and "+
				"a number can only belong to one person")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.getProfile(w, r)
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// changePassword rotates the caller's password and drops every other session.
//
// Revoking the rest is the point of changing a password after a suspected
// compromise; leaving them live would make the change cosmetic.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req changePasswordRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if n := utf8.RuneCountInString(req.NewPassword); n < 12 || n > 200 {
		httpx.BadRequest(w, r, "new_password must be 12-200 characters")
		return
	}
	if req.NewPassword == req.CurrentPassword {
		httpx.BadRequest(w, r, "new_password must differ from the current one")
		return
	}

	var current *string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT password_hash FROM users WHERE id = $1`, id.UserID).Scan(&current)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if current == nil || s.Hasher.Verify(*current, req.CurrentPassword) != nil {
		httpx.Error(w, r, http.StatusForbidden, "invalid_credentials", "current password is incorrect")
		return
	}

	hash, err := s.Hasher.Hash(req.NewPassword)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Clearing must_change_password here and nowhere else: this is the
		// only route that takes a password the account holder chose.
		if _, err := tx.Exec(r.Context(),
			`UPDATE users
			    SET password_hash = $2, must_change_password = false, updated_at = now()
			  WHERE id = $1`,
			id.UserID, hash); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE sessions SET revoked_at = now()
			 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
			id.UserID, id.SessionID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"changed": true, "other_sessions_revoked": true})
}

/*
skipPasswordChange lets a family keep the password the school gave them.

	The first password is the person's own mobile number, and the screen that
	asked them to replace it had no way past: no skip, no cancel, and the API
	refused every other call while the flag stood. That was a deliberate rule,
	and the school running this has now decided against it: a parent who is
	handed a login and then told they cannot see their child's fees until they
	have invented and remembered a twelve-character password is a parent who
	puts the phone down. The number on the class list is a weak password and
	the family may keep it; the screen says so once, and offers the change
	beside the skip so the choice is theirs.

	Clears the flag and nothing else. No session is revoked and no password is
	touched, so a skip cannot lock anybody out of anything. Reached only while
	the flag is set: for everybody else it is a no-op that answers the same.
*/
func (s *Server) skipPasswordChange(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(),
			`UPDATE users SET must_change_password = false, updated_at = now() WHERE id = $1`,
			id.UserID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"skipped": true})
}
