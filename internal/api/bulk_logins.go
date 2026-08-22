package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Logins for everybody who has just been imported.

   Sixty children go in from one sheet and then need sixty accounts, and the
   only way to make them was to open sixty records and press a button on each.
   Nobody does that; they give up, and the parent portal goes unused in a
   school that paid for it.

   Three rules, and all three exist because more than one person does this job:

     Anybody who already has a login keeps it. The response names them and
     their username and no password, so the office can see that Aarav's family
     were dealt with last week without that fact quietly becoming a new
     password that stops the one they are holding.

     Nothing is reset here at all. Resetting one account is a deliberate act on
     that person's record; resetting three hundred by pressing a button labelled
     "generate" is not something anybody means to do.

     The permission is the same one the single-record button needs, checked per
     kind. Staff need hr.employees.write and families need students.write, so
     this cannot become a way of doing something the equivalent form refuses.
*/

type bulkLoginRequest struct {
	// students | guardians | staff
	Kind string `json:"kind"`
	// SectionID narrows to one class, which is how a class teacher uses this.
	// Empty means the whole school, which only the office would want.
	SectionID string `json:"section_id,omitempty"`
	/* Reset replaces the password of everybody who already has one.

	   Never a default and never implied. The ordinary run leaves working
	   logins alone, because the alternative is that pressing "generate" a
	   second time stops every password the school has already handed out.

	   It exists because the opposite trap is real: a list of one-time
	   passwords can be lost — a closed tab, a failed download — and without
	   this the only way back is to open every record one at a time. */
	Reset bool `json:"reset,omitempty"`
}

type bulkLoginRow struct {
	Name     string `json:"name"`
	SignInAs string `json:"sign_in_as"`
	// Empty for somebody who already had an account. The distinction is the
	// point of the screen, not an omission.
	Password string `json:"password,omitempty"`
	Existing bool   `json:"existing"`
	// Detail carries the reason a row produced nothing — no phone number on a
	// guardian, say — so a count that does not add up explains itself.
	Detail string `json:"detail,omitempty"`
}

type bulkLoginResult struct {
	Created  int            `json:"created"`
	Existing int            `json:"existing"`
	Skipped  int            `json:"skipped"`
	Rows     []bulkLoginRow `json:"rows"`
	Note     string         `json:"note"`
}

// issueLoginsInBulk mints an account for everybody of one kind who has none.
func (s *Server) issueLoginsInBulk(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var req bulkLoginRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	// The same right the one-at-a-time button needs. Checked here rather than
	// on the route because one route serves three kinds and the loosest of
	// them would otherwise become the price of admission to all three.
	need := rbac.StudentsWrite
	if req.Kind == "staff" {
		need = rbac.EmployeesWrite
	}
	if !id.Can(need) {
		httpx.Forbidden(w, r, "issuing logins for "+req.Kind)
		return
	}

	var section any
	if strings.TrimSpace(req.SectionID) != "" {
		sid, err := uuid.Parse(req.SectionID)
		if err != nil {
			httpx.BadRequest(w, r, "section_id must be a uuid")
			return
		}
		section = sid
	}

	out := bulkLoginResult{Rows: []bulkLoginRow{}}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		type person struct {
			id       uuid.UUID
			name     string
			userID   *uuid.UUID
			username string // the natural key: admission no, phone, or email
			email    string
			phone    string
			// usable is false for an account that exists but has never been
			// given a password -- which is exactly what importing staff with
			// an email produces. Treating those as "already has a login" would
			// report ten people as done who cannot sign in.
			usable bool
		}
		var people []person

		var sql string
		switch req.Kind {
		case "students":
			sql = `
				SELECT st.id, trim(st.first_name || ' ' || COALESCE(st.last_name,'')),
				       st.user_id, st.admission_no, '', '',
				       COALESCE((SELECT u.password_hash IS NOT NULL AND u.status <> 'invited'
				                   FROM users u WHERE u.id = st.user_id), false)
				  FROM students st
				  LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
				 WHERE st.status = 'active'
				   AND ($1::uuid IS NULL OR e.section_id = $1)
				 ORDER BY e.roll_no NULLS LAST, st.admission_no`
		case "guardians":
			// DISTINCT because one guardian of three children is one account,
			// and the loop below would otherwise try to create it three times.
			sql = `
				SELECT DISTINCT ON (g.id) g.id, g.full_name, g.user_id,
				       COALESCE(g.phone,''), COALESCE(g.email::text,''), COALESCE(g.phone,''),
				       COALESCE((SELECT u.password_hash IS NOT NULL AND u.status <> 'invited'
				                   FROM users u WHERE u.id = g.user_id), false)
				  FROM guardians g
				  JOIN student_guardians sg ON sg.guardian_id = g.id
				  JOIN students st ON st.id = sg.student_id AND st.status = 'active'
				  LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
				 WHERE ($1::uuid IS NULL OR e.section_id = $1)
				 ORDER BY g.id, g.full_name`
		case "staff":
			sql = `
				SELECT emp.id, trim(emp.first_name || ' ' || COALESCE(emp.last_name,'')),
				       emp.user_id, COALESCE(emp.email::text,''),
				       COALESCE(emp.email::text,''), COALESCE(emp.phone,''),
				       COALESCE((SELECT u.password_hash IS NOT NULL AND u.status <> 'invited'
				                   FROM users u WHERE u.id = emp.user_id), false)
				  FROM employees emp
				 WHERE emp.status = 'active' AND $1::uuid IS NULL
				 ORDER BY emp.employee_code`
		default:
			return errUnknownLoginKind
		}

		rows, err := tx.Query(r.Context(), sql, section)
		if err != nil {
			return err
		}
		for rows.Next() {
			var p person
			if err := rows.Scan(&p.id, &p.name, &p.userID, &p.username, &p.email,
				&p.phone, &p.usable); err != nil {
				rows.Close()
				return err
			}
			people = append(people, p)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, p := range people {
			/* An account that exists and has a password is left alone.

			   An account that exists with no password is not the same thing
			   and must not be reported as one: importing staff with an email
			   creates exactly that -- an "invited" row nobody can sign in as.
			   Those get a password here, which is the whole point of running
			   this after an import. */
			if p.userID != nil && !p.usable {
				password, err := temporaryPassword()
				if err != nil {
					return err
				}
				hash, err := s.Hasher.Hash(password)
				if err != nil {
					return err
				}
				var signIn string
				if err := tx.QueryRow(r.Context(), `
					UPDATE users SET password_hash = $2, status = 'active'
					 WHERE id = $1
					RETURNING COALESCE(username::text, email::text, phone, '')`,
					*p.userID, hash).Scan(&signIn); err != nil {
					return err
				}
				out.Created++
				out.Rows = append(out.Rows, bulkLoginRow{
					Name: p.name, SignInAs: signIn, Password: password,
				})
				continue
			}

			// Already has one. Left alone, unless a reset was asked for by
			// name — in which case this is the deliberate act of replacing a
			// list somebody has lost.
			if p.userID != nil && req.Reset {
				password, err := temporaryPassword()
				if err != nil {
					return err
				}
				hash, err := s.Hasher.Hash(password)
				if err != nil {
					return err
				}
				var signIn string
				if err := tx.QueryRow(r.Context(), `
					UPDATE users SET password_hash = $2, status = 'active'
					 WHERE id = $1
					RETURNING COALESCE(username::text, email::text, phone, '')`,
					*p.userID, hash).Scan(&signIn); err != nil {
					return err
				}
				out.Created++
				out.Rows = append(out.Rows, bulkLoginRow{
					Name: p.name, SignInAs: signIn, Password: password,
				})
				continue
			}

			// Already has one. Named, with their username, and left alone.
			if p.userID != nil {
				var signIn string
				if err := tx.QueryRow(r.Context(),
					`SELECT COALESCE(username::text, email::text, phone, '') FROM users WHERE id = $1`,
					*p.userID).Scan(&signIn); err != nil {
					return err
				}
				out.Existing++
				out.Rows = append(out.Rows, bulkLoginRow{
					Name: p.name, SignInAs: signIn, Existing: true,
				})
				continue
			}

			// An adult with no way to be contacted cannot be given an account
			// they could ever recover. A child can: the admission number is
			// enough, and password recovery for a child is the office's job.
			if req.Kind != "students" && p.email == "" && p.phone == "" {
				out.Skipped++
				out.Rows = append(out.Rows, bulkLoginRow{
					Name: p.name, Detail: "no email or phone on the record",
				})
				continue
			}

			base := p.username
			if base == "" {
				base = p.name
			}
			username, err := uniqueUsername(r.Context(), tx, id.InstitutionID, base)
			if err != nil {
				return err
			}
			password, err := temporaryPassword()
			if err != nil {
				return err
			}
			hash, err := s.Hasher.Hash(password)
			if err != nil {
				return err
			}

			/* Inside a savepoint, so one unusable row loses only itself.

			   The intent was always to skip a duplicate and carry on, and the
			   code below reported exactly that — but a failed INSERT aborts
			   the Postgres transaction, and every statement after it dies with
			   "current transaction is aborted". So the first guardian sharing
			   a phone with somebody took the whole batch of sixty with it, and
			   the endpoint answered 500 while the code was busy composing a
			   polite note about one person.

			   A savepoint is what makes the promise true: roll back this row,
			   keep the rest. */
			var newID uuid.UUID
			sp, berr := tx.Begin(r.Context())
			if berr != nil {
				return berr
			}
			insert := func(tx pgx.Tx, email string) error {
				return tx.QueryRow(r.Context(), `
					INSERT INTO users (institution_id, username, email, phone, full_name,
					                   password_hash, status)
					VALUES ($1,$2::citext,NULLIF($3,'')::citext,NULLIF($4,''),$5,$6,'active')
					RETURNING id`,
					id.InstitutionID, username, email, p.phone, p.name, hash).Scan(&newID)
			}
			err = insert(sp, p.email)

			/* A shared email must not cost a family their account.

			   Two parents at one school genuinely share an address — a couple
			   with one inbox, a joint family, a village where the shop's email
			   is on every form. The users table keeps email unique per school
			   because it is a sign-in identifier, which is right, and the
			   consequence was that the second family to use an address was
			   refused an account altogether. At this school that was
			   forty-nine of sixty guardians: one demo address appears on six
			   different parents, and every one of them after the first was
			   turned away.

			   A parent signs in with their phone number, not their email. So
			   when the address is the thing that collides, the account is
			   created without it. They lose nothing they were using — the
			   email was never their way in — and the school gains a family it
			   can actually reach. If the phone collides too there is genuinely
			   no identifier left, and that is the row worth reporting. */
			if err != nil && p.email != "" && isUniqueViolation(err) {
				_ = sp.Rollback(r.Context())
				sp2, berr := tx.Begin(r.Context())
				if berr != nil {
					return berr
				}
				sp = sp2
				err = insert(sp, "")
			}

			if err != nil {
				_ = sp.Rollback(r.Context())
				out.Skipped++
				detail := "that phone number already belongs to another account"
				if p.phone == "" {
					detail = "no phone number on record, and the email is already in use"
				}
				out.Rows = append(out.Rows, bulkLoginRow{Name: p.name, Detail: detail})
				continue
			}
			if cerr := sp.Commit(r.Context()); cerr != nil {
				return cerr
			}

			var table, roleKey string
			switch req.Kind {
			case "students":
				table, roleKey = "students", "student"
			case "guardians":
				table, roleKey = "guardians", "parent"
			default:
				table, roleKey = "employees", ""
			}
			if _, err := tx.Exec(r.Context(),
				`UPDATE `+table+` SET user_id = $2 WHERE id = $1`, p.id, newID); err != nil {
				return err
			}
			if roleKey != "" {
				if err := grantRole(r.Context(), tx, id.InstitutionID, newID, roleKey); err != nil {
					return err
				}
			}

			out.Created++
			out.Rows = append(out.Rows, bulkLoginRow{
				Name: p.name, SignInAs: username, Password: password,
			})
		}
		return nil
	})
	switch {
	case err == errUnknownLoginKind:
		httpx.BadRequest(w, r, "kind must be students, guardians or staff")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}

	out.Note = "Passwords are shown once and are not stored. Download this list " +
		"before leaving the page."
	if req.Reset {
		out.Note += " Every password here is new: the ones handed out before this " +
			"have stopped working."
	} else {
		out.Note += " Anybody who already had a login kept it — their password is " +
			"not shown and has not been changed."
	}
	httpx.JSON(w, http.StatusOK, out)
}

var errUnknownLoginKind = errStr("unknown login kind")

// errStr is a tiny error type so the sentinel above needs no import.
type errStr string

func (e errStr) Error() string { return string(e) }
