package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* When somebody leaves, the record stays and the login goes.

   Nothing did this. A teacher who resigned in August could still sign in in
   December — read the register, open a child's record, message a parent — and
   so could a family whose child had been given a transfer certificate. The
   product carefully kept every fact about a leaver, which is right, and just
   as carefully left them the key to the building, which is not.

   THE TWO HALVES ARE SEPARATE ON PURPOSE.

   The RECORD is never deleted. Marks, attendance, payroll, the classes they
   taught, the fees they paid: a school is asked about a former pupil or a
   former teacher years later, and a product that answered by deleting them
   would be answering "we no longer know".

   The ACCESS ends at once. Two things, because either alone is a hole: the
   account is archived so no new sign-in succeeds, and every live session is
   revoked so the one already open on somebody's phone stops working. Archiving
   without revoking leaves a leaver signed in until their cookie expires, which
   on this product is a fortnight.

   COMING BACK DOES NOT RESTORE THE LOGIN, deliberately. Re-admitting a child
   or re-employing a teacher puts the record back on the roll; the account is
   issued again as a decision somebody makes, with a new password. Silently
   reviving an old login would mean a password shared with a family two years
   ago works again on the day their sibling is admitted.
*/
func endAccess(r *http.Request, tx pgx.Tx, userID uuid.UUID) error {
	if userID == uuid.Nil {
		return nil
	}
	if _, err := tx.Exec(r.Context(), `
		UPDATE users SET status = 'archived', updated_at = now()
		 WHERE id = $1 AND status <> 'archived'`, userID); err != nil {
		return err
	}
	// The session already open matters as much as the next sign-in.
	_, err := tx.Exec(r.Context(), `
		UPDATE sessions SET revoked_at = now()
		 WHERE user_id = $1 AND revoked_at IS NULL`, userID)
	return err
}

/* Ending a whole family's access when a child leaves.

   The child's own account goes. The guardians' accounts go ONLY IF this was
   their last child at the school — a parent with a second child in Grade 4
   must keep the login they use to read that child's homework, and taking it
   away because their elder left would be a support call the same afternoon.

   This is why it is a query and not a loop over the guardians: "has this
   person any other active child here" is the whole rule, and it has to be
   asked of the database rather than assumed.
*/
func endFamilyAccess(r *http.Request, tx pgx.Tx, studentID uuid.UUID) (int, error) {
	ended := 0

	var childUser *uuid.UUID
	if err := tx.QueryRow(r.Context(),
		`SELECT user_id FROM students WHERE id = $1`, studentID).Scan(&childUser); err != nil {
		return ended, err
	}
	if childUser != nil {
		if err := endAccess(r, tx, *childUser); err != nil {
			return ended, err
		}
		ended++
	}

	rows, err := tx.Query(r.Context(), `
		SELECT DISTINCT g.user_id
		  FROM student_guardians sg
		  JOIN guardians g ON g.id = sg.guardian_id
		 WHERE sg.student_id = $1
		   AND g.user_id IS NOT NULL
		   -- No OTHER child of theirs still on the roll. Suspended counts as on
		   -- the roll: a suspended child is expected back and their parent still
		   -- needs to read the fees and the circulars while they are away.
		   AND NOT EXISTS (
		       SELECT 1 FROM student_guardians sg2
		         JOIN students st2 ON st2.id = sg2.student_id
		        WHERE sg2.guardian_id = g.id
		          AND sg2.student_id <> $1
		          AND st2.status IN ('active','suspended'))`, studentID)
	if err != nil {
		return ended, err
	}
	var users []uuid.UUID
	for rows.Next() {
		var u uuid.UUID
		if err := rows.Scan(&u); err != nil {
			rows.Close()
			return ended, err
		}
		users = append(users, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ended, err
	}
	for _, u := range users {
		if err := endAccess(r, tx, u); err != nil {
			return ended, err
		}
		ended++
	}
	return ended, nil
}
