package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Finishing an appointment.
 *
 * Adding a member of staff with an email creates their account as "invited"
 * with no password — deliberately, so a half-finished appointment cannot be
 * signed into. Nothing then completed it. The account sat invited for ever,
 * and the school's answer to "how does my new teacher sign in?" was that there
 * was no answer: issuing a password needs access.users.write, which HR does
 * not hold and which has no screen a school can reach anyway.
 *
 * So the act of appointing somebody now carries the act of letting them in.
 * Gated on hr.employees.write rather than access.users.write on purpose: HR
 * appointed this person, and completing that appointment is their job.
 * Granting HR the broader right instead would have let them reset the
 * principal's password, which is a different and much larger permission.
 *
 * The password is shown once and never stored, the same way a school's own
 * credentials are handed over at provisioning. A password a system can show
 * you twice is a password it is keeping in a form somebody else can read.
 */

type staffLoginResponse struct {
	EmployeeCode string `json:"employee_code"`
	FullName     string `json:"full_name"`
	SignInAs     string `json:"sign_in_as"`
	// Empty when the account already had a working password and no reset was
	// requested. Nothing can read a password back out of the database.
	Password string `json:"password"`
	Existing bool   `json:"existing"`
	Note     string `json:"note"`
}

var errNoContact = errors.New(
	"this person has no staff number, email or phone on their record, add one first, " +
		"or they will have nothing to sign in with")

// issueStaffLogin gives one member of staff a password they can sign in with.
//
// Idempotent in the way that matters: run again and the previous password
// stops working and a new one is issued. That is the recovery path as well as
// the first-issue path, because "I never got it" and "I have lost it" are the
// same request from the office's point of view.
func (s *Server) issueStaffLogin(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	empID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	reset := r.URL.Query().Get("reset") == "true"

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

	var out staffLoginResponse
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			userID   *uuid.UUID
			fullName string
			email    *string
			phone    *string
			// The four-digit number. What a fingerprint reader holds and what
			// a teacher can actually be told to type.
			staffNo *int
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT e.user_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')),
			       e.employee_code, e.email, e.phone, e.staff_number
			  FROM employees e WHERE e.id = $1`, empID).
			Scan(&userID, &fullName, &out.EmployeeCode, &email, &phone, &staffNo); err != nil {
			return err
		}
		out.FullName = fullName

		// An employee added without an email has no account at all; one is
		// made here rather than sending the office back to the form.
		if userID == nil {
			/* A four-digit number is enough on its own.

			   This used to refuse an employee with no email and no phone, and
			   sixty-nine imported staff at one school were exactly that: a
			   name and a code, no way in. The number is a real identifier —
			   sign-in resolves it, and the fingerprint reader holds the same
			   one — so it is no longer a dead end. An email or a phone is
			   better and is still preferred; this is the floor. */
			if (email == nil || *email == "") && (phone == nil || *phone == "") && staffNo == nil {
				return errNoContact
			}
			var newID uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO users (institution_id, email, phone, username,
				                   full_name, password_hash, status)
				VALUES ($1, $2::citext, $3, $6::text::citext, $4, $5, 'active')
				RETURNING id`,
				id.InstitutionID, email, phone, fullName, hash, staffNo).Scan(&newID); err != nil {
				if isUniqueViolation(err) {
					/* NAME WHO HOLDS IT.

					   "that email or phone already belongs to another account"
					   is true and unactionable: the clerk cannot see which
					   account, cannot search for it from this screen, and has
					   no way to tell whether it is a real person or a row left
					   by a mistyped import. So the login cannot be given and
					   there is nothing to do about it.

					   The holder is in the same table the insert just bounced
					   off, so naming it costs one query and turns a dead end
					   into a five-second fix. */
					var holder, which string
					if lerr := tx.QueryRow(r.Context(), `
						SELECT full_name,
						       CASE WHEN email = $2::citext THEN 'email address'
						            ELSE 'phone number' END
						  FROM users
						 WHERE institution_id = $1
						   AND (email = $2::citext OR phone = $3)
						 LIMIT 1`, id.InstitutionID, email, phone).
						Scan(&holder, &which); lerr == nil {
						return fmt.Errorf(
							"that %s already belongs to %s. Give this person their own, "+
								"or clear it on their staff record and try again", which, holder)
					}
					return errors.New("that email or phone already belongs to another account")
				}
				return err
			}
			if _, err := tx.Exec(r.Context(),
				`UPDATE employees SET user_id = $2 WHERE id = $1`, empID, newID); err != nil {
				return err
			}
			userID = &newID
		} else {
			/* The account exists. Shown, not replaced, unless a reset is asked
			   for by name.

			   This used to mint a new password on every call, which is right
			   at one desk and wrong across several: HR hands a teacher their
			   login, the principal opens the same record to check it, and the
			   password the teacher is holding stops working with nothing on
			   screen to say so. An invited account -- created with the staff
			   record and never given a password -- is the one case where
			   issuing without asking is still correct, because there is no
			   working password to break. */
			/* Top up the identifiers the account is missing.

			   A staff record imported with only a name and a code makes a user
			   row whose only identifier is the code. HR fills in the phone
			   number later, on the staff record — and it stayed there: the
			   login was created before the number existed and nothing ever
			   copied it across, so the teacher could sign in with an employee
			   code they do not know and not with the number they do.

			   COALESCE, never overwrite. An account whose email was changed
			   deliberately must not be dragged back to whatever the staff
			   record still says. This only fills a hole. */
			if _, err := tx.Exec(r.Context(), `
				UPDATE users u
				   SET email    = COALESCE(u.email, NULLIF($2,'')::citext),
				       phone    = COALESCE(u.phone, NULLIF($3,'')),
				       username = COALESCE(u.username, $4::text::citext)
				 WHERE u.id = $1`, *userID, email, phone, staffNo); err != nil {
				// A number that already belongs to somebody else is not a
				// reason to refuse the login. The account keeps the identifier
				// it has and the clash is a separate thing to fix.
				if !isUniqueViolation(err) {
					return err
				}
			}

			var invited bool
			if err := tx.QueryRow(r.Context(),
				`SELECT password_hash IS NULL OR status = 'invited' FROM users WHERE id = $1`,
				*userID).Scan(&invited); err != nil {
				return err
			}
			out.Existing = !invited
			if invited || reset {
				if _, err := tx.Exec(r.Context(), `
					UPDATE users SET password_hash = $2, status = 'active'
					 WHERE id = $1`, *userID, hash); err != nil {
					return err
				}
				out.Existing = false
			}
		}

		return tx.QueryRow(r.Context(),
			/* Email, then phone, then the code.

			   The code was first, so a teacher with a perfectly good email
			   address was told to sign in as "T042". Every one of the three
			   works — the sign-in resolves an identifier against all of them —
			   so this is only about which one to read out, and it should be
			   the one the person already knows. */
			`SELECT COALESCE(email::text, phone, username::text, '') FROM users WHERE id = $1`,
			*userID).Scan(&out.SignInAs)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, r, http.StatusNotFound, "not_found", "no such employee")
		return
	case errors.Is(err, errNoContact):
		httpx.BadRequest(w, r, errNoContact.Error())
		return
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
		return
	}

	if strings.TrimSpace(out.SignInAs) == "" {
		httpx.BadRequest(w, r, errNoContact.Error())
		return
	}

	if out.Existing {
		out.Note = "This person already has a working login, the one whoever " +
			"created it handed over. The password cannot be read back; reset it only " +
			"if it has been lost, because that stops the one they are using."
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	out.Password = password
	out.Note = "Shown once and not stored. Hand it over in person or send it to them, " +
		"and they are asked to change it when they first sign in. " +
		"If it is lost, reset it rather than looking this one up."
	httpx.JSON(w, http.StatusOK, out)
}

// staffLoginPermission is the right the act needs. Named so the route and the
// comment above cannot drift apart.
var staffLoginPermission = rbac.EmployeesWrite
