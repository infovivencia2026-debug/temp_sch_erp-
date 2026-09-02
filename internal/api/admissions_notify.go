package api

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* THE FAMILY IS TOLD, AND THE RECORD SAYS SO BECAUSE IT HAPPENED.

   The admissions office could record what it had told an applicant. It could
   not tell them: /admissions/message wrote a line into the application's
   remarks and stopped, so the audit trail said "we told you on the ninth"
   about a message nobody had sent. That is worse than silence -- a school
   defends itself with that record.

   Everything here goes through QueueMessage, the one send contract, so an
   admissions message is logged, retried, deduplicated and attributed exactly
   like a fee reminder. Nothing in this file writes a message_log row itself.

   ---------------------------------------------------------------------------
   NO ADDRESS, NO SEND, AND SAY SO

   applications.parent_email is nullable and often empty for a form taken over
   the counter. Every function here reports the applicants it could not reach
   rather than counting them as told, and the office sees that count on the
   screen. A silent skip is how a record starts lying again.

   ---------------------------------------------------------------------------
   ONE PER OCCURRENCE

   Stage messages carry source_kind 'application', the application's id, and an
   occurrence key naming the stage. A status set twice, or an office that
   presses the button again, does not send a family the same offer twice. The
   office's own typed message is deliberately NOT deduplicated: two different
   sentences on the same day are two different messages, and suppressing the
   second would lose the one the parent needed.
*/

// applicationStageTemplate names the message for each status a family should
// hear about. Statuses missing from this map are the ones a parent has no use
// for: 'draft' is a form not yet handed in, 'submitted' is acknowledged by
// admissions.application_received at the moment it is created, and 'withdrawn'
// is the family's own decision -- telling them they have withdrawn is noise.
var applicationStageTemplate = map[string]string{
	"under_review":      "admissions.under_review",
	"documents_pending": "admissions.documents_pending",
	"test_scheduled":    "admissions.test_scheduled",
	"interviewed":       "admissions.interviewed",
	"offered":           "admissions.offered",
	"accepted":          "admissions.accepted",
	"rejected":          "admissions.rejected",
	"waitlisted":        "admissions.waitlisted",
}

// applicantFacts is what a message about an application is allowed to say.
// Read once and rendered into the template; nothing here is an internal note,
// a counsellor's name or a waitlist position.
type applicantFacts struct {
	StudentName   string
	ParentName    string
	Email         string
	Phone         string
	ApplicationNo string
	ClassSought   string
	SchoolName    string
	Status        string
	GuardianID    *uuid.UUID
}

// errNoApplicantEmail is the ordinary case, not a fault: a form taken across
// the counter with a phone number and no email address.
var errNoApplicantEmail = errors.New("no email address on this application")

// loadApplicantFacts reads the one row every message here is built from.
//
// COALESCE everywhere on purpose. Rendering a template with a value that might
// be NULL is how a parent receives "Dear <nil>", and renderTemplate leaves an
// unknown placeholder standing rather than blanking it -- so the check has to
// happen here, where the fact is either present or replaced by something a
// person can read.
func loadApplicantFacts(ctx context.Context, tx pgx.Tx, appID uuid.UUID) (applicantFacts, error) {
	var f applicantFacts
	err := tx.QueryRow(ctx, `
		SELECT trim(concat_ws(' ', a.first_name, a.last_name)),
		       COALESCE(a.parent_name, ''),
		       COALESCE(a.parent_email::text, ''),
		       COALESCE(a.parent_phone, ''),
		       COALESCE(a.application_no, ''),
		       COALESCE(c.name, ''),
		       COALESCE(i.name, ''),
		       a.status,
		       a.guardian_id
		  FROM applications a
		  LEFT JOIN classes c      ON c.id = a.class_sought
		  LEFT JOIN institutions i ON i.id = a.institution_id
		 WHERE a.id = $1`, appID).
		Scan(&f.StudentName, &f.ParentName, &f.Email, &f.Phone, &f.ApplicationNo,
			&f.ClassSought, &f.SchoolName, &f.Status, &f.GuardianID)
	return f, err
}

// templateVars is the fact sheet as the templates see it. Every value is a
// string that exists: firstNonEmpty stands in for the fields a school leaves
// blank, so no message can go out with a hole where a name should be.
func (f applicantFacts) templateVars(baseURL string) map[string]any {
	return map[string]any{
		"school_name":    firstNonEmpty(f.SchoolName, "your school"),
		"parent_name":    firstNonEmpty(strings.TrimSpace(f.ParentName), "Sir/Madam"),
		"student_name":   firstNonEmpty(strings.TrimSpace(f.StudentName), "your child"),
		"application_no": f.ApplicationNo,
		"class_sought":   firstNonEmpty(f.ClassSought, "the class applied for"),
		"portal_url":     strings.TrimSuffix(baseURL, "/") + "/login",
	}
}

/*
notifyApplicant sends one templated email to an applicant's parent.

	Runs inside the caller's transaction, like every other queue: a message
	about a decision that rolls back is a message about something that did not
	happen. Returns errNoApplicantEmail when there is nothing to send to, which
	callers report rather than swallow.
*/
func (s *Server) notifyApplicant(ctx context.Context, tx pgx.Tx, inst, appID uuid.UUID,
	code string, f applicantFacts, extra map[string]any, occurrence string) error {

	if strings.TrimSpace(f.Email) == "" {
		return errNoApplicantEmail
	}
	/* Its own savepoint, so a failed send cannot take the caller's work with
	   it. A queue that fails on a statement -- rather than on the provider
	   check before it -- leaves the transaction aborted, and the admission
	   decision the caller is committing would be lost by the code that was
	   only trying to mention it. */
	if _, err := tx.Exec(ctx, "SAVEPOINT notify_applicant"); err != nil {
		return err
	}
	vars := f.templateVars(s.BaseURL)
	for k, v := range extra {
		vars[k] = v
	}
	id := appID
	_, err := s.QueueMessage(ctx, tx, inst, SendRequest{
		Channel:      "email",
		TemplateCode: code,
		Vars:         vars,
		Recipient:    strings.TrimSpace(f.Email),
		// Empty occurrence means "send it even if it looks like one I sent
		// before", which is right for a person typing a message and wrong for
		// a stage that can be set twice.
		SourceKind:    "application",
		SourceID:      &id,
		OccurrenceKey: occurrence,
	})
	if err != nil {
		_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT notify_applicant")
		return err
	}
	_, _ = tx.Exec(ctx, "RELEASE SAVEPOINT notify_applicant")
	return nil
}

/*
notifyApplicationStage tells a family that their application has moved.

	Called from the handlers that change the status. Never fails the change:
	an offer that was made is made, and a mail server that is down must not
	roll it back. What it returns is a note for the response, so the office
	learns on the screen that the parent was not reached.

	The savepoint is what makes "never fails" true. A failed queue -- an
	unconfigured provider, a missing template -- leaves the transaction in
	Postgres's aborted state otherwise, and the offer would be lost by the very
	code that was only trying to mention it.
*/
func (s *Server) notifyApplicationStage(ctx context.Context, tx pgx.Tx,
	inst, appID uuid.UUID, status string) (sent bool, note string) {

	code, ok := applicationStageTemplate[status]
	if !ok {
		return false, ""
	}
	if _, err := tx.Exec(ctx, "SAVEPOINT application_stage"); err != nil {
		return false, ""
	}
	rollback := func() {
		_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT application_stage")
	}

	f, err := loadApplicantFacts(ctx, tx, appID)
	if err != nil {
		rollback()
		return false, "The change is saved. The family could not be emailed about it."
	}
	err = s.notifyApplicant(ctx, tx, inst, appID, code, f, nil, "stage:"+status)
	switch {
	case errors.Is(err, errNoApplicantEmail):
		rollback()
		return false, "The change is saved. There is no email address on this " +
			"application, so nothing was sent - tell them by telephone."
	case err != nil:
		rollback()
		return false, "The change is saved, but the email could not be queued: " + err.Error()
	}
	return true, ""
}

/*
ensureApplicantLogin gives the parent behind an application a way to watch it.

	Guardian-first, deliberately. guardians is institution-scoped and carries no
	student_id, so the adult is the account holder and their children -- and
	their applications, plural, across years -- hang off them. This resolves or
	creates that one guardian from the three contact fields the application
	carries, binds the application to them, and issues the login through the
	same routine the office's own button uses.

	It never resets a password. A parent already signing in about an older
	child gets their application attached to the account they hold, and is told
	so; issuing a second credential is how a family ends up with one that
	silently stopped working.

	Like everything else here it must not fail the application, so it runs
	inside its own savepoint and reports a note.
*/
func (s *Server) ensureApplicantLogin(ctx context.Context, tx pgx.Tx,
	inst, appID uuid.UUID) applicantWelcome {

	var out applicantWelcome
	f, err := loadApplicantFacts(ctx, tx, appID)
	if err != nil {
		return out
	}
	if strings.TrimSpace(f.Phone) == "" && strings.TrimSpace(f.Email) == "" {
		// Nothing to name the account after and nowhere to send it.
		return out
	}
	fullName := strings.TrimSpace(f.ParentName)
	if fullName == "" {
		fullName = "Parent of " + strings.TrimSpace(f.StudentName)
	}

	if _, err := tx.Exec(ctx, "SAVEPOINT applicant_account"); err != nil {
		return out
	}
	abandon := func(note string) applicantWelcome {
		if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT applicant_account"); err != nil {
			return applicantWelcome{}
		}
		return applicantWelcome{Note: note}
	}
	const couldNot = "The application is saved. A parent login could not be " +
		"issued automatically - issue it from the guardian's record."

	guardianID := uuid.Nil
	if f.GuardianID != nil {
		guardianID = *f.GuardianID
	} else {
		guardianID, err = findOrCreateGuardian(ctx, tx, inst, fullName, f.Phone, f.Email)
		if err != nil {
			return abandon(couldNot)
		}
	}

	acct, err := s.ensureGuardianAccount(ctx, tx, inst, guardianID, fullName, f.Phone, f.Email)
	switch {
	case errors.Is(err, errGuardianContactTaken):
		return abandon("The application is saved. That phone or email is already " +
			"on another account, so no new login was issued.")
	case err != nil:
		return abandon(couldNot)
	}
	out.Existing = acct.Existing
	out.SignInAs = acct.SignInAs
	out.Password = acct.Password
	if acct.Existing {
		if acct.Reissued {
			out.Note = "This parent had a login that had never been used, so a new password has been issued. Shown once — give it to them now."
		} else {
			out.Note = "This parent already has a login and it is unchanged. This " +
				"application is now on it."
		}
	} else {
		out.Note = "Shown once. Give it to the parent now; it cannot be read back."
	}

	/* Bind the application to the person, not the person to the application.

	   This column is what the portal reads to answer "which admissions are
	   mine", and what a second child's application finds so the family keeps
	   one login. It is set even when the account already existed -- especially
	   then, because that is the sibling case. */
	if _, err := tx.Exec(ctx, `
		UPDATE applications SET guardian_id = $2, updated_at = now()
		 WHERE id = $1`, appID, guardianID); err != nil {
		return abandon(couldNot)
	}

	// The credentials, by email only. The two SMS-and-WhatsApp channels the
	// enquiry uses are the enquiry's; an application carries an email field
	// precisely because this is the message that needs one, and a password
	// sent to a number the school has not verified is a password sent to
	// whoever holds that number now.
	if strings.TrimSpace(f.Email) == "" {
		out.Note += " No email address on the application, so the login was not sent."
		return out
	}
	code := "admissions.applicant_login"
	if out.Existing {
		code = "admissions.applicant_existing"
	}
	err = s.notifyApplicant(ctx, tx, inst, appID, code, f, map[string]any{
		"sign_in_as": out.SignInAs,
		"password":   out.Password,
	}, "applicant_login:email")
	if err != nil {
		// The account stands; only the message failed. Rolling back to the
		// savepoint here would throw away a login the office can still read
		// off this response.
		out.Note += " The message could not be queued: " + err.Error()
		return out
	}
	out.SentTo = append(out.SentTo, "email")
	return out
}
