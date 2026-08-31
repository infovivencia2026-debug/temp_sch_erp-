package api

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* THE PARENT WATCHES THEIR OWN ADMISSION.

   A login arrived at enrolment. Everything before it -- the application, the
   documents, the test, the offer -- happened to the family without the family
   being able to see any of it, so the only way to learn whether a form had been
   accepted was to ring the office. During an admissions season that is most of
   what the office does, and the answer it gives is read off the same screen the
   parent could have read for themselves.

   The enquiry is the earliest moment the school has a real name and a real
   number, and it is the moment the parent is still standing at the desk. So the
   account is issued there, against the enquiry, and the credentials go out on
   the same three channels as everything else.

   ---------------------------------------------------------------------------
   NO STUDENT, ON PURPOSE

   There is no student row and there must not be one. Most enquiries never
   become a child at this school, and a students table carrying every family
   that once asked about fees is a table that can no longer answer "how many
   children do we teach" -- which is the question it exists for. The account
   hangs off the enquiry and the guardian, both of which are records of an
   interest rather than of a pupil.

   ---------------------------------------------------------------------------
   ONE CREDENTIAL, NOT TWO

   The guardian created here is the one enrolment reuses (see the enrol handler,
   which prefers enquiries.guardian_id over its own upsert). That is the whole
   point of storing it: without it the admission would mint a second guardian, a
   second user and a second password, and the parent who had been signing in
   since the enquiry would find the credential they were using had quietly
   stopped being the current one. issueAdmissionLogin then sees a guardian that
   already has a user and says so, rather than issuing anything.

   ---------------------------------------------------------------------------
   NEVER FAILS THE ENQUIRY

   Same rule as the application link that goes out beside it. A clerk has a
   parent on the phone; losing the enquiry because a username collided or a
   gateway is unconfigured would be absurd. Every path returns a note.

   That promise needs a savepoint to be true, and the first version of this did
   not have one. Returning a note after a failed INSERT leaves the transaction
   in Postgres's aborted state: every later statement errors, COMMIT comes back
   as ROLLBACK, and the handler 500s having destroyed the very enquiry the note
   claims was saved. The commonest trigger is the ordinary one -- a second child
   of a family whose phone already carries a user -- so the note was a lie in
   exactly the case it was written for. Everything fallible below runs inside
   SAVEPOINT applicant_login, and every bail-out rolls back to it.
*/

// applicantWelcome is what the front desk is told after an enquiry is recorded.
// Shaped like admissionWelcome and for the same reason: the password exists
// nowhere else, so if no message arrives this response is the only copy that
// was ever made.
type applicantWelcome struct {
	SignInAs string `json:"sign_in_as,omitempty"`
	// Empty when the family already had an account. Never read back from
	// storage -- nothing can read a password out of this product.
	Password string   `json:"password,omitempty"`
	Existing bool     `json:"existing,omitempty"`
	SentTo   []string `json:"sent_to,omitempty"`
	Note     string   `json:"note,omitempty"`
}

// Same order and the same reasoning as the enrolment welcome: WhatsApp first
// because it is what a parent actually reads, SMS because it needs no data,
// email only when one was given.
var applicantChannels = []string{"whatsapp", "sms", "email"}

/*
issueEnquiryLogin gives a new enquiry's parent an account that tracks it.

	Runs inside the enquiry's own transaction, like the application link beside
	it: a user pointing at an enquiry that rolled back is an account for a
	record the school does not have.

	Returns a note rather than an error in every failure case. See the file
	comment.
*/
func (s *Server) issueEnquiryLogin(
	ctx context.Context, tx pgx.Tx, inst uuid.UUID, enquiryID uuid.UUID,
	studentName, parentName, phone, email string,
) applicantWelcome {
	var out applicantWelcome

	phone = strings.TrimSpace(phone)
	email = strings.TrimSpace(email)
	if phone == "" && email == "" {
		// Nothing to send to and nothing to name the account after.
		return out
	}

	// A guardian row is unique on (institution_id, phone, full_name), so the
	// name has to be stable rather than blank -- an enquiry taken over the
	// phone often has the child's name and not the parent's, and every such
	// enquiry sharing one empty-named guardian would put four families on one
	// login.
	fullName := strings.TrimSpace(parentName)
	if fullName == "" {
		fullName = "Parent of " + strings.TrimSpace(studentName)
	}

	var schoolName string
	_ = tx.QueryRow(ctx, `SELECT name FROM institutions WHERE id = $1`, inst).Scan(&schoolName)

	/* Everything from here can fail, and none of it may take the enquiry with
	   it. See the file comment: without this, a note saying "the enquiry is
	   saved" is returned into a transaction that can no longer commit. */
	if _, err := tx.Exec(ctx, "SAVEPOINT applicant_login"); err != nil {
		return out
	}
	// abandon gives back a transaction that can still commit the enquiry.
	abandon := func(note string) applicantWelcome {
		if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT applicant_login"); err != nil {
			// Nothing left to salvage; the caller's commit will fail and the
			// enquiry is lost either way. Saying so beats a note that lies.
			return applicantWelcome{}
		}
		return applicantWelcome{Note: note}
	}
	const couldNot = "The enquiry is saved. A parent login could not be issued " +
		"automatically - issue it from the office."

	/* The guardian, reused where the family is already known.

	   A second child's enquiry, or a parent who rang twice, must land on the
	   guardian that already exists -- that is what makes the account they hold
	   the one this enquiry is attached to. Same conflict target as enrolment,
	   so the two paths cannot disagree about what counts as the same person. */
	var (
		guardianID uuid.UUID
		existingU  *uuid.UUID
	)
	if err := tx.QueryRow(ctx, `
		INSERT INTO guardians (institution_id, full_name, relation, phone, email)
		VALUES ($1,$2,'father',$3,$4::citext)
		ON CONFLICT (institution_id, phone, full_name)
		DO UPDATE SET email = COALESCE(EXCLUDED.email, guardians.email)
		RETURNING id, user_id`,
		inst, fullName, phone, nullString(email)).Scan(&guardianID, &existingU); err != nil {
		return abandon(couldNot)
	}

	if existingU != nil {
		// They are already signing in today. Naming that account is useful;
		// replacing its password would lock them out of the child they already
		// have here.
		out.Existing = true
		_ = tx.QueryRow(ctx,
			`SELECT COALESCE(username::text, email::text, phone, '') FROM users WHERE id = $1`,
			*existingU).Scan(&out.SignInAs)
		out.Note = "This parent already has a login and it is unchanged."
	} else {
		password, err := temporaryPassword()
		if err != nil {
			return abandon(couldNot)
		}
		hash, err := s.Hasher.Hash(password)
		if err != nil {
			return abandon(couldNot)
		}
		base := fullName
		if phone != "" {
			base = phone
		}
		username, err := uniqueUsername(ctx, tx, inst, base)
		if err != nil {
			return abandon(couldNot)
		}
		var newID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO users (institution_id, username, email, phone, full_name,
			                   password_hash, status)
			VALUES ($1, $2::citext, $3::citext, $4, $5, $6, 'active')
			RETURNING id`,
			inst, username, nullString(email), nullString(phone), fullName, hash).
			Scan(&newID); err != nil {
			/* Almost always the same number already on another account -- a
			   parent enquiring about a second school year, or a staff member's
			   own child. The enquiry stands; the login is sorted out by hand. */
			return abandon("The enquiry is saved. That phone or email is already on " +
				"another account, so no new login was issued.")
		}
		if _, err := tx.Exec(ctx,
			`UPDATE guardians SET user_id = $2 WHERE id = $1`, guardianID, newID); err != nil {
			return abandon(couldNot)
		}
		// 'parent' rather than a role of its own. The permission this needs is
		// the portal's own self/children scope, and inventing an 'applicant'
		// role would mean every portal route growing a second role to check.
		if err := grantRole(ctx, tx, inst, newID, "parent"); err != nil {
			return abandon(couldNot)
		}
		existingU = &newID
		out.SignInAs = username
		out.Password = password
		out.Note = "Shown once. Give it to the parent now; it cannot be read back."
	}

	/* Bind the account to the enquiry.

	   This is what the portal reads to decide which admission a signed-in
	   parent is watching, and what enrolment reads to avoid issuing a second
	   credential. Without it the account exists and points at nothing. */
	if _, err := tx.Exec(ctx, `
		UPDATE enquiries SET user_id = $2, guardian_id = $3, updated_at = now()
		 WHERE id = $1`, enquiryID, existingU, guardianID); err != nil {
		return abandon(couldNot)
	}

	code := "admissions.applicant_login"
	if out.Existing {
		code = "admissions.applicant_existing"
	}
	vars := map[string]any{
		"school_name":  schoolName,
		"parent_name":  firstNonEmpty(strings.TrimSpace(parentName), "Sir/Madam"),
		"student_name": studentName,
		"sign_in_as":   out.SignInAs,
		"password":     out.Password,
		"portal_url":   strings.TrimSuffix(s.BaseURL, "/") + "/login",
	}
	eid := enquiryID
	for _, channel := range applicantChannels {
		to := phone
		if channel == "email" {
			to = email
		}
		if to == "" {
			continue
		}
		if _, err := s.QueueMessage(ctx, tx, inst, SendRequest{
			Channel:      channel,
			TemplateCode: code,
			Vars:         vars,
			Recipient:    to,
			SourceKind:   "enquiry",
			SourceID:     &eid,
			// Idempotent per enquiry per channel, for the reason the whole
			// funnel is: an enquiry saved twice because the page was slow must
			// not send one family two passwords, of which only one works.
			OccurrenceKey: "applicant_login:" + channel,
		}); err != nil {
			// Swallowed, never returned. See the file comment.
			_ = err
			continue
		}
		out.SentTo = append(out.SentTo, channel)
	}
	return out
}
