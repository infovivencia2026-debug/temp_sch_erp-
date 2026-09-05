package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Adding and correcting a child's parents.

   A guardian could be created exactly once — in the admission form, one of
   them, at the moment the child was admitted. After that the record was
   frozen: a mother who was not entered on the first day could never be added,
   a father who changed his number had to be corrected by somebody with
   database access, and a grandmother who took over raising the child could
   not be put on the record at all.

   That is not a small gap. Every absence alert, fee reminder and message this
   product sends goes to guardians, so a parent who is not on the record is a
   parent the school cannot reach — and the screen that shows the family is the
   screen where somebody notices.

   MATCHED ON PHONE AND NAME, not created blindly. guardians has a unique index
   on (institution_id, phone, full_name) because one parent has several
   children at the school, and a second row would mean the mother of three gets
   told about one of them. Adding an existing parent to another child links the
   guardian that is already there.

   REMOVING UNLINKS, IT DOES NOT DELETE. The row belongs to the institution and
   may be another child's parent; taking a guardian off this child removes the
   link and leaves the person. A separated parent removed from one child's
   record must not vanish from their sibling's.
*/

type guardianWriteRequest struct {
	// Present when correcting an existing guardian rather than adding one.
	ID         string `json:"id,omitempty"`
	FullName   string `json:"full_name"`
	Relation   string `json:"relation"`
	Phone      string `json:"phone,omitempty"`
	Email      string `json:"email,omitempty"`
	Occupation string `json:"occupation,omitempty"`
	// Rupees a year, as declared for concessions and RTE; nil leaves it as it was.
	AnnualIncome *int64 `json:"annual_income,omitempty"`
	// Who the school rings first, and whose consent the office records. One
	// per child: setting it clears the flag on the others.
	IsPrimary bool `json:"is_primary"`
}

// A parent's number and address are sign-in identifiers, unique per school.
// Moving one onto a value another account already answers to has to be refused
// in words the office can act on, not as a 500.
var errGuardianPhoneTaken = errors.New("guardian contact belongs to another login")

// guardians is unique on (institution_id, phone, full_name): editing one into
// the exact name and number of another is the school saying they are the same
// person, and the two records have to be merged rather than duplicated.
var errGuardianDuplicate = errors.New("guardian already exists")

var guardianRelations = map[string]bool{
	"father": true, "mother": true, "guardian": true, "other": true,
}

func (s *Server) saveStudentGuardian(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req guardianWriteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.FullName)
	if name == "" {
		httpx.BadRequest(w, r, "a parent needs a name")
		return
	}
	relation := strings.ToLower(strings.TrimSpace(req.Relation))
	if relation == "" {
		relation = "guardian"
	}
	if !guardianRelations[relation] {
		httpx.BadRequest(w, r, "relation must be father, mother, guardian or other")
		return
	}
	phone := strings.TrimSpace(req.Phone)
	email := strings.TrimSpace(req.Email)
	/* A guardian with neither a number nor an address is a name the school
	   cannot reach, on the record that exists to say who to reach. Refused
	   here rather than accepted and discovered on the morning a child is hurt. */
	if phone == "" && email == "" {
		httpx.BadRequest(w, r,
			"give a phone number or an email — a parent with neither is one the "+
				"school cannot contact")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)

	var guardianID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var allowed bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM students st WHERE st.id = $1 AND `+pred,
			append([]any{sid}, args...)...).Scan(&allowed); err != nil {
			return err
		}

		if req.ID != "" {
			gid, err := uuid.Parse(req.ID)
			if err != nil {
				return err
			}
			/* Only a guardian of THIS child. Without the link check, any
			   guardian id in the school could be edited by anybody who can
			   edit any one child. */
			var userID *uuid.UUID
			var oldPhone, oldEmail string
			if err := tx.QueryRow(r.Context(), `
				UPDATE guardians g
				   SET full_name = $2, relation = $3,
				       phone = NULLIF($4,''), email = NULLIF($5,'')::citext,
				       occupation = NULLIF($6,''),
				       annual_income = COALESCE($8, g.annual_income)
				  FROM (SELECT COALESCE(phone,'') AS old_phone,
				               COALESCE(email::text,'') AS old_email, user_id
				          FROM guardians WHERE id = $1) prev
				 WHERE g.id = $1
				   AND EXISTS (SELECT 1 FROM student_guardians sg
				                WHERE sg.guardian_id = g.id AND sg.student_id = $7)
				RETURNING g.id::text, prev.old_phone, prev.old_email, prev.user_id`,
				gid, name, relation, phone, email, req.Occupation, sid, req.AnnualIncome).
				Scan(&guardianID, &oldPhone, &oldEmail, &userID); err != nil {
				if isUniqueViolation(err) {
					return errGuardianDuplicate
				}
				return err
			}
			/* The number a parent is rung on is also the number they sign in
			   with, and correcting one without the other left a father who
			   changed his phone signing in as a number that no longer reaches
			   him — and nobody could tell him what it was, because the screen
			   showed the new one.

			   The address moves with it for the same reason: a parent whose
			   email is corrected on this screen and not on their account is
			   one whose password reset goes to the address they told the
			   school was wrong.

			   The username moves only when it still is the old phone (or, for
			   an account created from an address, the old email). A school
			   that gave a parent some other sign-in name chose that on
			   purpose, and a correction to a contact number must not silently
			   take it away. */
			if userID != nil {
				sync := func(tx pgx.Tx, phone, email string) error {
					_, err := tx.Exec(r.Context(), `
						UPDATE users
						   SET full_name = $2,
						       phone = NULLIF($3,''),
						       email = NULLIF($4,'')::citext,
						       username = CASE
						           WHEN $3 <> '' AND username = $5::citext THEN $3::citext
						           WHEN $4 <> '' AND $6 <> '' AND username = $6::citext THEN $4::citext
						           ELSE username END
						 WHERE id = $1`,
						*userID, name, phone, email, oldPhone, oldEmail)
					return err
				}
				/* A savepoint, because a failed statement aborts the whole
				   transaction in Postgres and everything after it — the
				   primary-guardian flag below included — would die with
				   "current transaction is aborted". */
				/* A SHARED CONTACT MUST NOT COST THE FAMILY A CORRECTION.

				   Two parents at one school genuinely share an inbox, and just
				   as often share a mobile — one household, one handset. users
				   keeps both unique per school because each is a sign-in
				   identifier, so the sync can collide on either.

				   The address already had this fallback and the number did not,
				   which is the whole of the bug: correcting a mother's spelling
				   failed outright, and the screen told the office to go and fix
				   somebody else's record first — for a number the school had
				   every right to store on both parents.

				   The contact always lands on the GUARDIAN record, which is
				   what the school reads and what appears on a class list. Only
				   the sign-in identity keeps what it had, because that is the
				   one thing that has to stay unique for a person to be able to
				   sign in at all. So the save succeeds and nothing is lost: at
				   worst one parent signs in with the identifier they already
				   had, which is the identifier they have been using.

				   Tried in order, narrowing to the state that cannot collide —
				   the identity already on the row. */
				attempts := [][2]string{
					{phone, email},
					{phone, oldEmail},
					{oldPhone, email},
					{oldPhone, oldEmail},
				}
				var err error
				var sp pgx.Tx
				for i, a := range attempts {
					var berr error
					sp, berr = tx.Begin(r.Context())
					if berr != nil {
						return berr
					}
					err = sync(sp, a[0], a[1])
					if err == nil {
						break
					}
					_ = sp.Rollback(r.Context())
					sp = nil
					// Only a uniqueness clash is worth retrying; anything else
					// is a real failure and must not be masked by a fallback.
					if !isUniqueViolation(err) || i == len(attempts)-1 {
						break
					}
				}
				if err != nil {
					if isUniqueViolation(err) {
						return errGuardianPhoneTaken
					}
					return err
				}
				if err := sp.Commit(r.Context()); err != nil {
					return err
				}
			}
		} else {
			// ON CONFLICT rather than a fresh row: one parent has several
			// children here, and a duplicate means the mother of three is told
			// about one of them.
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO guardians (institution_id, full_name, relation, phone,
				                       email, occupation, annual_income)
				VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,'')::citext,NULLIF($6,''),$7)
				ON CONFLICT (institution_id, phone, full_name)
				DO UPDATE SET relation = EXCLUDED.relation,
				              email = COALESCE(EXCLUDED.email, guardians.email),
				              occupation = COALESCE(EXCLUDED.occupation, guardians.occupation),
				              annual_income = COALESCE(EXCLUDED.annual_income, guardians.annual_income)
				RETURNING id::text`,
				id.InstitutionID, name, relation, phone, email, req.Occupation, req.AnnualIncome).
				Scan(&guardianID); err != nil {
				return err
			}
			/* Linked as NOT primary whatever was asked for, and promoted
			   below if it was. student_guardians_one_primary is a unique index
			   on (student_id) WHERE is_primary, so inserting a second primary
			   before clearing the first fails the whole save — and the person
			   adding a mother would be told the database was broken. */
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary)
				VALUES ($1,$2::uuid,$3,false)
				ON CONFLICT (student_id, guardian_id) DO NOTHING`,
				sid, guardianID, id.InstitutionID); err != nil {
				return err
			}
		}

		if req.IsPrimary {
			// One primary per child. Cleared first, so the flag cannot end up
			// on two people and leave "who do we ring" ambiguous.
			if _, err := tx.Exec(r.Context(),
				`UPDATE student_guardians SET is_primary = false WHERE student_id = $1`,
				sid); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE student_guardians SET is_primary = true
				 WHERE student_id = $1 AND guardian_id = $2::uuid`,
				sid, guardianID); err != nil {
				return err
			}
		}
		return nil
	})
	if err == pgx.ErrNoRows {
		httpx.Forbidden(w, r, "this family is not one you can edit")
		return
	}
	if err == errGuardianDuplicate {
		httpx.BadRequest(w, r,
			"another parent at this school already has that name and number — "+
				"add the existing one to this child instead of entering them twice")
		return
	}
	if err == errGuardianPhoneTaken {
		httpx.BadRequest(w, r,
			"that phone number or email is already the sign-in of another account "+
				"at this school — the parent it belongs to has to be corrected first")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": guardianID, "full_name": name})
}

/*
Taking a parent off a child's record UNLINKS them.

	The guardian row belongs to the institution and is very often another
	child's parent too. Deleting it because one link went away would remove a
	sibling's mother from their record as a side effect — and would take her
	login, her fee reminders and her absence alerts with it.
*/
func (s *Server) unlinkStudentGuardian(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	gid, err := uuid.Parse(chiURLParam(r, "gid"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid guardian id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 3)

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			DELETE FROM student_guardians sg
			 WHERE sg.student_id = $1 AND sg.guardian_id = $2
			   AND EXISTS (SELECT 1 FROM students st
			                WHERE st.id = sg.student_id AND `+pred+`)`,
			append([]any{sid, gid}, args...)...)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if touched == 0 {
		httpx.Forbidden(w, r, "that family is not one you can edit")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"unlinked": true})
}
