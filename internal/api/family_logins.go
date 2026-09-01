package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Letting the family in.

   The parent workspace is forty features and the student workspace is thirty,
   and in a real school not one of them was reachable, because nothing outside
   the demo seeder ever wrote students.user_id or guardians.user_id. Both
   production paths that create a guardian — the admissions handoff and student
   creation — insert the row without an account, and there was no invitation
   flow to follow up with.

   That is worse than a dark feature. The circular fan-out resolves its
   recipients with `g.user_id IS NOT NULL` and so silently reached nobody,
   while the newer messaging path falls back to the phone number — so the
   school would text a parent about an absence and link them to an application
   they could not enter.

   This is the same shape as issueStaffLogin and deliberately so: one call,
   gated on the right to write the person's record, returning a password shown
   exactly once. Re-running it issues a new password, because "I never got it"
   and "I have lost it" are the same request from the office's point of view.

   Gated on students.write rather than access.users.write. The office that
   admits a child is the office that hands their family the login; requiring
   the wider right would have meant only an IT administrator could finish an
   admission, which is how the staff equivalent ended up unusable.
*/

type familyLoginResponse struct {
	SignInAs string `json:"sign_in_as"`
	FullName string `json:"full_name"`
	// Password is empty when the account already existed and no reset was
	// asked for. There is no way to read a password back out of the database,
	// so an empty value here means "this person already has one" and not
	// "their password is blank".
	Password string `json:"password"`
	Relation string `json:"relation,omitempty"`
	// Existing marks an account somebody else already created, which is the
	// difference between "here is their login" and "here is their new login".
	Existing bool   `json:"existing"`
	Note     string `json:"note"`
}

var errNoFamilyContact = errors.New(
	"this person has no email or phone on their record. Add one first, or " +
		"they will have nothing to sign in with and nowhere to receive a reset")

/*
uniqueUsername finds a free username inside one institution.

	Usernames are unique per school, and the obvious candidates are not: two
	children can share a guardian's phone number, and a guardian with no phone
	has no natural key at all. Rather than failing the request on a collision,
	this appends a counter — the office is handed whatever it gets and does not
	care, and the alternative is an admission that cannot be completed because
	a sibling was admitted first.
*/
func uniqueUsername(ctx context.Context, tx pgx.Tx, inst uuid.UUID, base string) (string, error) {
	base = strings.ToLower(strings.TrimSpace(base))
	base = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r == '.', r == '-', r == '_':
			return r
		}
		return -1
	}, base)
	if base == "" {
		base = "user"
	}

	for n := 0; n < 50; n++ {
		candidate := base
		if n > 0 {
			candidate = fmt.Sprintf("%s%d", base, n+1)
		}
		var taken bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM users
			                WHERE institution_id = $1 AND username = $2::citext)`,
			inst, candidate).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return "", errors.New("could not find a free username. Try setting one by hand")
}

// issueStudentLogin gives one child their own account.
//
// The admission number is the username, because it is already unique within
// the school, already printed on everything the child owns, and already the
// thing the office would read out over the telephone.
func (s *Server) issueStudentLogin(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	studentID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	// Asked for by name, so nobody invalidates a working login by pressing a
	// button to find out what it is.
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

	var out familyLoginResponse
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* A student record carries no email and no phone.

		   Those columns are on guardians, which is the right modelling: the
		   school contacts the family, not the six-year-old. So a child's
		   account is username-only, which is also why the admission number
		   has to be the username rather than a fallback for one. */
		var (
			userID      *uuid.UUID
			admissionNo string
			fullName    string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT s.user_id, s.admission_no,
			       trim(s.first_name || ' ' || COALESCE(s.last_name,''))
			  FROM students s WHERE s.id = $1`, studentID).
			Scan(&userID, &admissionNo, &fullName); err != nil {
			return err
		}
		out.FullName = fullName

		/* An account that already exists is reported, not replaced.

		   Issuing used to mint a new password every time it was called, on the
		   reasoning that "I never got it" and "I have lost it" are the same
		   request. True at one desk and dangerous across several: the office
		   hands a family their login on Monday, a class teacher opens the same
		   child on Tuesday and presses the same button out of curiosity, and
		   the password the family is holding stops working with nothing on
		   screen to say so.

		   So the reset is now something you ask for by name. Without it this
		   returns the username that exists and no password, which is the
		   honest answer to "what is this child's login" -- nothing can read a
		   password back, and a second one would be a different login. */
		if userID != nil {
			out.Existing = true
			if !reset {
				return tx.QueryRow(r.Context(),
					`SELECT COALESCE(username::text, email::text, phone, '') FROM users WHERE id = $1`,
					*userID).Scan(&out.SignInAs)
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1`,
				*userID, hash); err != nil {
				return err
			}
			return tx.QueryRow(r.Context(),
				`SELECT COALESCE(username::text, email::text, phone, '') FROM users WHERE id = $1`,
				*userID).Scan(&out.SignInAs)
		}

		username, err := uniqueUsername(r.Context(), tx, id.InstitutionID, admissionNo)
		if err != nil {
			return err
		}

		// Username only, and no self-service reset as a result -- which is the
		// office's job for a child in any case.
		var newID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO users (institution_id, username, full_name,
			                   password_hash, status)
			VALUES ($1, $2::citext, $3, $4, 'active')
			RETURNING id`,
			id.InstitutionID, username, fullName, hash).Scan(&newID); err != nil {
			if isUniqueViolation(err) {
				return errors.New("that username already belongs to another account")
			}
			return err
		}
		if _, err := tx.Exec(r.Context(),
			`UPDATE students SET user_id = $2 WHERE id = $1`, studentID, newID); err != nil {
			return err
		}

		// The student role, so they land on the student workspace rather than
		// signing in successfully to nothing at all.
		if err := grantRole(r.Context(), tx, id.InstitutionID, newID, "student"); err != nil {
			return err
		}
		out.SignInAs = username
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, r, http.StatusNotFound, "not_found", "no such student")
		return
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
		return
	}

	if out.Existing && !reset {
		out.Note = "This child already has a login. The one whoever created it " +
			"handed over. The password cannot be read back; if it has been lost, " +
			"reset it, which replaces the old one."
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	out.Password = password
	out.Note = "Shown once and not stored. Hand it to the child or their parent; " +
		"if it is lost, reset it rather than looking this one up."
	httpx.JSON(w, http.StatusOK, out)
}

// issueGuardianLogin gives one parent or guardian their own account.
//
// Their phone number is the username where they have one: it is what the
// school already has for them, what they already know, and what every SMS the
// school sends them already goes to.
func (s *Server) issueGuardianLogin(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	guardianID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid guardian id")
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

	var out familyLoginResponse
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			userID   *uuid.UUID
			fullName string
			relation string
			email    *string
			phone    *string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT g.user_id, g.full_name, g.relation, g.email, g.phone
			  FROM guardians g WHERE g.id = $1`, guardianID).
			Scan(&userID, &fullName, &relation, &email, &phone); err != nil {
			return err
		}
		out.FullName = fullName
		out.Relation = relation

		// Same rule as a child's: shown, not replaced, unless a reset was
		// asked for. One guardian is often opened by several people.
		if userID != nil {
			out.Existing = true
			if !reset {
				return tx.QueryRow(r.Context(),
					`SELECT COALESCE(username::text, email::text, phone, '') FROM users WHERE id = $1`,
					*userID).Scan(&out.SignInAs)
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1`,
				*userID, hash); err != nil {
				return err
			}
			return tx.QueryRow(r.Context(),
				`SELECT COALESCE(username::text, email::text, phone, '') FROM users WHERE id = $1`,
				*userID).Scan(&out.SignInAs)
		}

		// An adult with no way to be contacted cannot be given an account they
		// could ever recover, so this refuses rather than creating one.
		hasEmail := email != nil && strings.TrimSpace(*email) != ""
		hasPhone := phone != nil && strings.TrimSpace(*phone) != ""
		if !hasEmail && !hasPhone {
			return errNoFamilyContact
		}

		base := fullName
		if hasPhone {
			base = *phone
		}
		username, err := uniqueUsername(r.Context(), tx, id.InstitutionID, base)
		if err != nil {
			return err
		}

		var newID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO users (institution_id, username, email, phone, full_name,
			                   password_hash, status)
			VALUES ($1, $2::citext, $3::citext, $4, $5, $6, 'active')
			RETURNING id`,
			id.InstitutionID, username, email, phone, fullName, hash).Scan(&newID); err != nil {
			if isUniqueViolation(err) {
				return errors.New(
					"that email or phone already belongs to another account - " +
						"if this parent already has a login for a sibling, use that one")
			}
			return err
		}
		if _, err := tx.Exec(r.Context(),
			`UPDATE guardians SET user_id = $2 WHERE id = $1`, guardianID, newID); err != nil {
			return err
		}
		if err := grantRole(r.Context(), tx, id.InstitutionID, newID, "parent"); err != nil {
			return err
		}
		out.SignInAs = username
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, r, http.StatusNotFound, "not_found", "no such guardian")
		return
	case errors.Is(err, errNoFamilyContact):
		httpx.BadRequest(w, r, errNoFamilyContact.Error())
		return
	case err != nil:
		httpx.BadRequest(w, r, err.Error())
		return
	}

	if out.Existing && !reset {
		out.Note = "This guardian already has a login. It reaches every child they " +
			"are guardian of. The password cannot be read back; reset it only if it " +
			"has been lost, because that stops the one they are holding."
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	out.Password = password
	out.Note = "Shown once and not stored. One login reaches every child this " +
		"person is a guardian of, so a parent with three children needs one, not three."
	httpx.JSON(w, http.StatusOK, out)
}

// grantRole puts a new account in a role, creating nothing and failing loudly
// if the role is missing — a login with no role signs in to an empty workspace,
// which the family reads as a broken account.
func grantRole(ctx context.Context, tx pgx.Tx, inst, userID uuid.UUID, roleKey string) error {
	var roleID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM roles WHERE institution_id = $1 AND key = $2`,
		inst, roleKey).Scan(&roleID); err != nil {
		return fmt.Errorf("the %s role does not exist in this school: %w", roleKey, err)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO user_roles (institution_id, user_id, role_id)
		VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, inst, userID, roleID)
	return err
}

/* --- one temporary-password routine ---------------------------------------

   The guardian is the account holder. Not the child, not the enquiry, not the
   application -- guardians carries no student_id and student_guardians links
   the children on afterwards, so one adult holds one login however many
   children and however many admissions they have here.

   Three callers now want that account: the office pressing "issue login" on a
   guardian, an enquiry being taken at the desk, and an application arriving
   with no enquiry behind it. Each minting its own password would be three
   places to get the hashing, the username collision and the role grant wrong,
   and three chances to replace a password the family is already signing in
   with. So there is one routine, and it obeys the same rule everywhere: an
   account that exists is NAMED, never replaced.
*/

// errGuardianContactTaken is the ordinary collision: this phone or email is
// already on somebody's account. Named so callers can say something specific
// rather than reporting a constraint name at a clerk. (provision.go has its
// own errContactTaken for the very different case of a school's first admin.)
var errGuardianContactTaken = errors.New(
	"that phone or email already belongs to another account")

type guardianAccount struct {
	UserID   uuid.UUID
	SignInAs string
	// Empty when the account already existed. Nothing can read a password back
	// out of this product, so empty means "they already have one".
	Password string
	Existing bool
}

/*
ensureGuardianAccount gives one guardian a login, or reports the one they have.

	Runs inside the caller's transaction and writes guardians.user_id. It never
	resets an existing password: a parent who signed in this morning to look at
	one child's fees must not be locked out because the office pressed a button
	about another child's application. Resetting is issueGuardianLogin's
	?reset=true, which is a thing a person asks for by name.
*/
func (s *Server) ensureGuardianAccount(ctx context.Context, tx pgx.Tx,
	inst, guardianID uuid.UUID, fullName, phone, email string) (guardianAccount, error) {

	var out guardianAccount
	var existing *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT user_id FROM guardians WHERE id = $1`,
		guardianID).Scan(&existing); err != nil {
		return out, err
	}
	if existing != nil {
		out.Existing = true
		out.UserID = *existing
		err := tx.QueryRow(ctx,
			`SELECT COALESCE(username::text, email::text, phone, '') FROM users WHERE id = $1`,
			*existing).Scan(&out.SignInAs)
		return out, err
	}

	phone, email = strings.TrimSpace(phone), strings.TrimSpace(email)
	if phone == "" && email == "" {
		return out, errNoFamilyContact
	}

	password, err := temporaryPassword()
	if err != nil {
		return out, err
	}
	hash, err := s.Hasher.Hash(password)
	if err != nil {
		return out, err
	}
	base := fullName
	if phone != "" {
		base = phone
	}
	username, err := uniqueUsername(ctx, tx, inst, base)
	if err != nil {
		return out, err
	}
	var newID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO users (institution_id, username, email, phone, full_name,
		                   password_hash, status)
		VALUES ($1, $2::citext, $3::citext, $4, $5, $6, 'active')
		RETURNING id`,
		inst, username, nullString(email), nullString(phone), fullName, hash).
		Scan(&newID); err != nil {
		if isUniqueViolation(err) {
			return out, errGuardianContactTaken
		}
		return out, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE guardians SET user_id = $2 WHERE id = $1`, guardianID, newID); err != nil {
		return out, err
	}
	// 'parent' rather than a role of its own, for the reason the enquiry login
	// gives: the portal routes check the parent role, and an 'applicant' role
	// would mean every one of them growing a second check. What keeps an
	// applicant's parent out of an enrolled family's screens is the scope --
	// every child screen resolves through student_guardians, which a parent
	// with no child on the roll has no row in, so those pages are empty for
	// them by construction rather than by a role.
	if err := grantRole(ctx, tx, inst, newID, "parent"); err != nil {
		return out, err
	}
	out.UserID = newID
	out.SignInAs = username
	out.Password = password
	return out, nil
}

/*
findOrCreateGuardian resolves the adult behind an application or enquiry.

	Matched on phone or email before anything is inserted. Two rows for one
	human is the bug that makes a family unreachable later -- messages go to
	one row, the portal reads the other -- and it cannot be undone once both
	have been written to. The unique index is (institution_id, phone,
	full_name), which does not catch a parent whose name was typed differently
	the second time, so the lookup is wider than the index.
*/
func findOrCreateGuardian(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	fullName, phone, email string) (uuid.UUID, error) {

	fullName = strings.TrimSpace(fullName)
	phone, email = strings.TrimSpace(phone), strings.TrimSpace(email)
	if phone == "" && email == "" {
		return uuid.Nil, errNoFamilyContact
	}

	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT id FROM guardians
		 WHERE (NULLIF($1,'') IS NOT NULL AND phone = $1)
		    OR (NULLIF($2,'') IS NOT NULL AND email = $2::citext)
		 ORDER BY (phone = $1) DESC, created_at
		 LIMIT 1`, phone, email).Scan(&id)
	switch {
	case err == nil:
		// Fill in a contact the school has now and did not have then, without
		// overwriting one it already holds.
		_, err = tx.Exec(ctx, `
			UPDATE guardians
			   SET email = COALESCE(email, NULLIF($2,'')::citext),
			       phone = COALESCE(NULLIF(phone,''), NULLIF($3,''))
			 WHERE id = $1`, id, email, phone)
		return id, err
	case !errors.Is(err, pgx.ErrNoRows):
		return uuid.Nil, err
	}

	if fullName == "" {
		fullName = "Parent"
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO guardians (institution_id, full_name, relation, phone, email)
		VALUES ($1,$2,'father',$3,$4::citext)
		ON CONFLICT (institution_id, phone, full_name)
		DO UPDATE SET email = COALESCE(EXCLUDED.email, guardians.email)
		RETURNING id`,
		inst, fullName, phone, nullString(email)).Scan(&id)
	return id, err
}
