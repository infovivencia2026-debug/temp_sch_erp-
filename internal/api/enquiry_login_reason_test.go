package api

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

/*
The reason a channel did not go has to name the fix.

	This is the whole point of the change it guards: "email not sent" was
	reported as a product bug when the cause was an SMTP server nobody had
	filled in. A reason that says "failed" would leave that report exactly
	where it was.
*/
func TestQueueFailureReasonNamesTheFix(t *testing.T) {
	// Exactly the shape queueWith builds for a provider that is not set up.
	notSetUp := fmt.Errorf("%s: %w: %s", "email", ErrProviderNotConfigured, "no SMTP host set")
	got := queueFailureReason(notSetUp)
	if !strings.Contains(got, "no SMTP host set") {
		t.Errorf("reason %q does not say what is missing", got)
	}
	if !strings.Contains(got, "Integrations") {
		t.Errorf("reason %q does not say where to fix it", got)
	}

	if got := queueFailureReason(ErrNoRecipient); !strings.Contains(got, "address") {
		t.Errorf("no-recipient reason = %q, want it to mention the address", got)
	}

	// Anything else is passed through rather than flattened: the remaining
	// causes are each fixed somewhere different.
	other := errors.New("no template \"admissions.applicant_login\" for email, and no built-in")
	if got := queueFailureReason(other); got != other.Error() {
		t.Errorf("reason = %q, want the error unchanged", got)
	}
}
