package api

import (
	"context"
	"errors"
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
	   the one this enquiry is attached to. findOrCreateGuardian is the same
	   lookup the application path uses, so the two cannot disagree about what
	   counts as the same person. */
	guardianID, err := findOrCreateGuardian(ctx, tx, inst, fullName, phone, email)
	if err != nil {
		return abandon(couldNot)
	}

	/* One temporary-password routine, in family_logins.go. An account that
	   already exists is named, never replaced: the parent signing in today
	   about another child must not be locked out by an enquiry taken now. */
	acct, err := s.ensureGuardianAccount(ctx, tx, inst, guardianID, fullName, phone, email)
	switch {
	case errors.Is(err, errGuardianContactTaken):
		/* Almost always the same number already on another account -- a parent
		   enquiring about a second school year, or a staff member's own child.
		   The enquiry stands; the login is sorted out by hand. */
		return abandon("The enquiry is saved. That phone or email is already on " +
			"another account, so no new login was issued.")
	case err != nil:
		return abandon(couldNot)
	}
	out.Existing = acct.Existing
	out.SignInAs = acct.SignInAs
	out.Password = acct.Password
	if acct.Existing {
		// They are already signing in today. Naming that account is useful;
		// replacing its password would lock them out of the child they already
		// have here.
		if acct.Reissued {
			out.Note = "This parent had a login that had never been used, so a new password has been issued. Shown once — give it to them now."
		} else {
			out.Note = "This parent already has a login and it is unchanged."
		}
	} else {
		out.Note = "Shown once. Give it to the parent now; it cannot be read back."
	}
	existingU := &acct.UserID

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
	/* WHY A CHANNEL DID NOT GO, SAID OUT LOUD.

	   These errors used to be dropped on the floor. The rule that they must
	   not fail the enquiry is right; discarding them was not. A desk that
	   types a parent's email address and gets back a panel listing WhatsApp
	   and SMS has been told the email was not sent, but not that the reason is
	   an SMTP server nobody has filled in -- so it is read as a bug in the
	   product, reported as "email not sent", and the one screen that would fix
	   it in a minute is never opened.

	   Collected per channel and returned in the note, which is the same place
	   every other outcome of this function already goes. */
	var failed []string
	for _, channel := range applicantChannels {
		to := phone
		if channel == "email" {
			to = email
		}
		if to == "" {
			if channel == "email" {
				failed = append(failed, "email: no address was given")
			}
			continue
		}
		res, err := s.QueueMessage(ctx, tx, inst, SendRequest{
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
		})
		if err != nil {
			// Never returned as an error -- see the file comment -- but no
			// longer thrown away either.
			failed = append(failed, channel+": "+queueFailureReason(err))
			continue
		}
		if res.Duplicate {
			// Already queued for this enquiry on this channel. Counting it as
			// a fresh send would tell the desk a password went out that this
			// call did not send, and the one that did carried a password this
			// response is not showing.
			continue
		}
		out.SentTo = append(out.SentTo, channel)
	}
	if len(failed) > 0 {
		out.Note = strings.TrimSpace(out.Note + " Not sent by " +
			strings.Join(failed, "; ") + ".")
	}
	return out
}

/*
queueFailureReason turns a QueueMessage error into something a clerk can act on.

	An unconfigured provider is by far the commonest cause and is not a fault:
	it is a school that has not filled in its mail server yet, and naming that
	is the difference between a five-minute fix and a bug report. Anything else
	is passed through as it stands rather than flattened into "failed", because
	the remaining causes -- no template, a rejected address -- are each fixed
	somewhere different.
*/
func queueFailureReason(err error) string {
	if errors.Is(err, ErrProviderNotConfigured) {
		// The wrapped text already reads "email: not configured: no SMTP host
		// set"; the channel is named by the caller, so only the tail is wanted.
		msg := err.Error()
		if i := strings.LastIndex(msg, ": "); i >= 0 {
			return strings.TrimSpace(msg[i+2:]) + " (set it up under Integrations)"
		}
	}
	if errors.Is(err, ErrNoRecipient) {
		return "no usable address or number"
	}
	return err.Error()
}
