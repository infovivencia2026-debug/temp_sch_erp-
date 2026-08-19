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
	Password     string `json:"password"`
	Note         string `json:"note"`
}

var errNoContact = errors.New(
	"this person has no email, phone or username on their record — add one first, " +
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
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT e.user_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')),
			       e.employee_code, e.email, e.phone
			  FROM employees e WHERE e.id = $1`, empID).
			Scan(&userID, &fullName, &out.EmployeeCode, &email, &phone); err != nil {
			return err
		}
		out.FullName = fullName

		// An employee added without an email has no account at all; one is
		// made here rather than sending the office back to the form.
		if userID == nil {
			if (email == nil || *email == "") && (phone == nil || *phone == "") {
				return errNoContact
			}
			var newID uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO users (institution_id, email, phone, full_name, password_hash, status)
				VALUES ($1, $2::citext, $3, $4, $5, 'active')
				RETURNING id`,
				id.InstitutionID, email, phone, fullName, hash).Scan(&newID); err != nil {
				if isUniqueViolation(err) {
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
			// The account exists and is invited, or active and locked out.
			// Both are settled by the same write.
			if _, err := tx.Exec(r.Context(), `
				UPDATE users SET password_hash = $2, status = 'active'
				 WHERE id = $1`, *userID, hash); err != nil {
				return err
			}
		}

		return tx.QueryRow(r.Context(),
			`SELECT COALESCE(username::text, email::text, phone, '') FROM users WHERE id = $1`,
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

	out.Password = password
	out.Note = "Shown once and not stored. Hand it over in person or send it to them, " +
		"and they are asked to change it when they first sign in. " +
		"If it is lost, issue another rather than looking this one up."
	httpx.JSON(w, http.StatusOK, out)
}

// staffLoginPermission is the right the act needs. Named so the route and the
// comment above cannot drift apart.
var staffLoginPermission = rbac.EmployeesWrite
