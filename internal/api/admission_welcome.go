package api

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* THE FAMILY IS LET IN THE MOMENT THE CHILD IS ADMITTED.

   Enrolling a child wrote a student, a guardian and an invoice and told
   nobody. The parent workspace is forty features and the family could reach
   none of them, because a login existed only if somebody later opened the
   student's profile and pressed a button most offices never found. So the
   commonest end state for a real admission was a family with an account
   nobody had issued, being texted about absences and linked to a portal they
   could not enter.

   The admission is the right moment and the only reliable one. It is the last
   step in the funnel, it is done by a person, and it is when the parent is
   still standing at the desk -- which matters, because that is when a
   credential can be handed over by hand if the message does not arrive.

   ---------------------------------------------------------------------------
   SHOWN AND SENT, BOTH

   Shown, because the office asked for it and because a password is not
   readable from the database afterwards: if the message fails, the screen is
   the only copy that ever existed. Sent, because a parent who walks out with
   a slip of paper loses it, and because the sibling case -- where the account
   already exists -- has nothing to show.

   ---------------------------------------------------------------------------
   WHAT IS DELIBERATELY NOT DONE

   No password is re-issued for a guardian who already has an account. A
   family admitting a second child must not have the login they are already
   using silently changed underneath them, which would sign them out of a
   portal they were using this morning. They get a message naming the account
   they already hold instead.

   Nothing here can fail the admission. A child is admitted or is not; whether
   a courtesy message queued is not part of that question, and an admission
   rolled back because a template was missing would be a far worse fault than
   the one this fixes.
*/

// admissionWelcome is what the enrol response carries back to the desk.
type admissionWelcome struct {
	SignInAs string `json:"sign_in_as,omitempty"`
	// Empty when the guardian already had an account. There is no way to read
	// a password back out, so empty means "they already have one", never "it
	// is blank".
	Password string `json:"password,omitempty"`
	FullName string `json:"full_name,omitempty"`
	Existing bool   `json:"existing,omitempty"`
	// Where the credentials were sent, so the desk can say "check your
	// WhatsApp" rather than guessing.
	SentTo []string `json:"sent_to,omitempty"`
	Note   string   `json:"note,omitempty"`
}

var welcomeChannels = []string{"whatsapp", "sms", "email"}

/*
issueAdmissionLogin gives the primary guardian an account and queues it to them.

	Runs inside the enrolment's own transaction so the account and the child
	arrive together: a guardian row with a user_id pointing at a user that was
	rolled back is worse than no account at all.
*/
func (s *Server) issueAdmissionLogin(
	ctx context.Context, tx pgx.Tx, inst uuid.UUID, studentID uuid.UUID,
) admissionWelcome {
	var out admissionWelcome

	/* A savepoint, because "it cannot fail the admission" was not true.

	   Every bail-out below returns a note and leaves the caller to commit. That
	   works for a lookup that finds nothing; it does not work after a statement
	   has errored, which puts Postgres in an aborted transaction where COMMIT
	   comes back as ROLLBACK. This runs as the last step of enrolment, so the
	   student, the enrolment, the guardian link and the first invoice all
	   disappear and the office gets a 500 -- from the courtesy message.

	   The failure that gets there is ordinary: a parent whose phone already
	   carries a user, which since logins are issued at enquiry is now most
	   families by the time they enrol. */
	if _, err := tx.Exec(ctx, "SAVEPOINT admission_login"); err != nil {
		return out
	}
	abandon := func(note string) admissionWelcome {
		if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT admission_login"); err != nil {
			return admissionWelcome{}
		}
		return admissionWelcome{Note: note}
	}

	// The school's own name, read here rather than passed in: the caller is a
	// long handler and one more argument threaded through it is one more thing
	// to get wrong.
	var schoolName string
	_ = tx.QueryRow(ctx, `SELECT name FROM institutions WHERE id = $1`, inst).Scan(&schoolName)

	var (
		guardianID uuid.UUID
		userID     *uuid.UUID
		fullName   string
		email      *string
		phone      *string
	)
	// The primary guardian only. A child can have several and the others are
	// often a grandparent or a driver; issuing four accounts from one
	// admission is not what anybody asked for.
	if err := tx.QueryRow(ctx, `
		SELECT g.id, g.user_id, g.full_name, g.email, g.phone
		  FROM student_guardians sg
		  JOIN guardians g ON g.id = sg.guardian_id
		 WHERE sg.student_id = $1
		 ORDER BY sg.is_primary DESC
		 LIMIT 1`, studentID).
		Scan(&guardianID, &userID, &fullName, &email, &phone); err != nil {
		return out
	}
	out.FullName = fullName

	addr := ""
	if email != nil {
		addr = strings.TrimSpace(*email)
	}
	tel := ""
	if phone != nil {
		tel = strings.TrimSpace(*phone)
	}
	if addr == "" && tel == "" {
		out.Note = "This parent has no phone or email on record, so no login could be issued. " +
			"Add one and issue it from the student's profile."
		return out
	}

	if userID != nil {
		// A sibling's admission. Name the account they already have rather
		// than replacing a password they are signing in with today.
		out.Existing = true
		_ = tx.QueryRow(ctx,
			`SELECT COALESCE(username::text, email::text, phone, '') FROM users WHERE id = $1`,
			*userID).Scan(&out.SignInAs)
		out.Note = "This parent already has a login and it is unchanged."
	} else {
		password, err := temporaryPassword()
		if err != nil {
			return abandon("The child is admitted. A parent login could not be issued.")
		}
		hash, err := s.Hasher.Hash(password)
		if err != nil {
			return abandon("The child is admitted. A parent login could not be issued.")
		}
		base := fullName
		if tel != "" {
			base = tel
		}
		username, err := uniqueUsername(ctx, tx, inst, base)
		if err != nil {
			return abandon("The child is admitted. A parent login could not be issued.")
		}
		var newID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO users (institution_id, username, email, phone, full_name,
			                   password_hash, status)
			VALUES ($1, $2::citext, $3::citext, $4, $5, $6, 'active')
			RETURNING id`,
			inst, username, email, phone, fullName, hash).Scan(&newID); err != nil {
			/* Almost always the same phone on a second family record. Not an
			   error the admission should carry: the child is admitted, and the
			   office is told to sort the login out separately. */
			return abandon("A login could not be issued automatically - that phone or " +
				"email is already on another account. Issue it from the student's profile.")
		}
		if _, err := tx.Exec(ctx,
			`UPDATE guardians SET user_id = $2 WHERE id = $1`, guardianID, newID); err != nil {
			return abandon("The child is admitted. A parent login could not be issued.")
		}
		if err := grantRole(ctx, tx, inst, newID, "parent"); err != nil {
			return abandon("The child is admitted. A parent login could not be issued.")
		}
		out.SignInAs = username
		out.Password = password
		out.Note = "Shown once. Give it to the parent now; it cannot be read back."
	}

	/* THE MESSAGE.

	   Two templates, because the two cases say different things: a new account
	   carries a password, and a sibling's does not. Sending the new-account
	   wording with an empty password would read as a blank credential.

	   A guardian with no account and no password reaches neither branch, so
	   there is nothing to send and nothing is sent. */
	code := "admissions.portal_login"
	if out.Existing {
		code = "admissions.portal_existing"
	}
	vars := map[string]any{
		"school_name": schoolName,
		"parent_name": firstNonEmpty(fullName, "Sir/Madam"),
		"sign_in_as":  out.SignInAs,
		"password":    out.Password,
		"portal_url":  strings.TrimSuffix(s.BaseURL, "/") + "/login",
	}
	sid := studentID
	for _, channel := range welcomeChannels {
		to := tel
		if channel == "email" {
			to = addr
		}
		if to == "" {
			continue
		}
		if _, err := s.QueueMessage(ctx, tx, inst, SendRequest{
			Channel:      channel,
			TemplateCode: code,
			Vars:         vars,
			Recipient:    to,
			SourceKind:   "admission",
			SourceID:     &sid,
			// Idempotent per child per channel: an office that presses enrol
			// twice because the page was slow must not send a family two
			// different passwords, of which only the second one works.
			OccurrenceKey: "portal_login:" + channel,
		}); err != nil {
			// Swallowed on purpose. See the file comment: a courtesy message
			// is not worth failing an admission for.
			_ = err
			continue
		}
		out.SentTo = append(out.SentTo, channel)
	}
	return out
}
