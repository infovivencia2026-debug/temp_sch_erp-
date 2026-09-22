package auth

import (
	"context"
	"net"
	"net/http"

	"github.com/google/uuid"
)

/* What happened at the door.

   Every sign-in attempt is handed to a Recorder as a LoginEvent: the
   successes, and the failures that used to go only to the process log. The
   api package supplies the recorder (it writes login_events and raises the
   principal's alerts); this package only describes the event, so auth does
   not import notifications and tests of the handler need no database. */

type LoginEvent struct {
	// Outcome is one of the login_events.outcome values: success,
	// wrong_password, no_account, locked, school_paused, ambiguous,
	// mfa_failed, mfa_required, reauth_ok, reauth_failed.
	Outcome    string
	Identifier string
	UserID     uuid.UUID
	InstID     uuid.UUID
	SessionID  uuid.UUID
	Via        string
	IP         string
	UserAgent  string
	// Locked is set on the wrong_password that tipped the identifier into a
	// lockout, so the recorder can tell somebody once rather than eight times.
	Locked bool
	// NewDevice is set on a success from a user agent this account has not
	// signed in from before.
	NewDevice bool
}

// Recorder receives login events. Implementations must not block the
// sign-in on their own failure.
type Recorder interface {
	RecordLogin(ctx context.Context, ev LoginEvent)
}

// SetRecorder attaches the recorder. Nil (the default) records nothing.
func (h *Handler) SetRecorder(rec Recorder) { h.recorder = rec }

func (h *Handler) record(ctx context.Context, r *http.Request, ev LoginEvent) {
	if h.recorder == nil {
		return
	}
	ev.IP = clientIP(r)
	ev.UserAgent = r.UserAgent()
	h.recorder.RecordLogin(ctx, ev)
}

func clientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
