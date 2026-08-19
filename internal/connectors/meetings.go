package connectors

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

/* The virtual classroom seam.

   The live-class model is not built here and is not rebuilt here. A session is
   virtual_class_sessions, scheduled by a teacher through the launcher, with a
   nullable join_url and a 'provider_pending' status that says plainly it has
   nowhere to join yet. What this file adds is the one thing that was missing:
   the place a real "create meeting" call would go, and an honest answer until
   one exists.

   The answer today is the manual provider. A teacher pastes the Zoom link they
   made themselves, the session becomes joinable, and thirty children get to a
   lesson. That is the working path, it stays the working path, and nothing
   here breaks it — the API providers below refuse rather than overwrite a URL
   somebody typed with one they invented. A launcher that invents a plausible
   meeting URL sends a class to a room that does not exist, and the failure
   surfaces at 9am on the day. */

// MeetingRequest is one live class that wants somewhere to happen.
type MeetingRequest struct {
	SessionID string
	Topic     string
	Agenda    string
	StartsAt  time.Time
	Minutes   int
	// HostRef is the provider's own id for the host account — a Zoom user id, a
	// Workspace address. The first thing a support engineer asks for.
	HostRef string
	// ManualJoinURL is the link a human pasted. The manual provider returns it;
	// every other provider ignores it, because a provider that "creates" a
	// meeting by echoing back what it was given is the fake success this whole
	// package exists to avoid.
	ManualJoinURL string
}

// Meeting is somewhere a class can actually be held.
type Meeting struct {
	// JoinURL is what the launcher puts in front of the children. Never
	// invented, never guessed.
	JoinURL string
	// MeetingRef is the provider's identifier, kept apart from the URL so a
	// session can be reconciled after a URL is rotated — the same reasoning
	// virtual_class_sessions.meeting_ref already carries.
	MeetingRef string
	// Status is what virtual_meeting_requests.status records: 'created' when a
	// meeting exists, 'manual' when a human supplied the link.
	Status string
	Detail string
}

// MeetingProvider is a route from a scheduled session to a real meeting.
type MeetingProvider interface {
	// Key matches virtual_meeting_platform_providers.provider, or "manual".
	Key() string
	Label() string
	// LiveCreate reports whether this provider actually creates a meeting
	// through an API. The screen reads it; it does not decide it.
	LiveCreate() bool
	Create(MeetingRequest) (Meeting, error)
}

// ErrManualJoinURLRequired is the manual route's one refusal, and it is a
// refusal rather than a silent 'provider_pending' because the person is looking
// at the form when it happens.
var ErrManualJoinURLRequired = errors.New(
	"paste the meeting link from Zoom, Meet or Teams: no provider on this " +
		"installation can create one for you yet")

// ManualMeetingProvider is the one that works. It takes the link a teacher made
// in the provider's own app and records it against the session.
type ManualMeetingProvider struct{}

func (ManualMeetingProvider) Key() string      { return "manual" }
func (ManualMeetingProvider) Label() string    { return "Paste a meeting link" }
func (ManualMeetingProvider) LiveCreate() bool { return false }

func (ManualMeetingProvider) Create(req MeetingRequest) (Meeting, error) {
	url := strings.TrimSpace(req.ManualJoinURL)
	if url == "" {
		return Meeting{}, ErrManualJoinURLRequired
	}
	// Refused rather than stored. A join_url that is not a URL is a button that
	// goes nowhere, discovered by a class of children at the start of a lesson.
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return Meeting{}, fmt.Errorf("%q is not a meeting link: it should begin with https://", url)
	}
	return Meeting{
		JoinURL: url,
		Status:  "manual",
		Detail:  "Link supplied by hand. No meeting was created through a provider API.",
	}, nil
}

/*
ErrMeetingAPIUnavailable is what every real provider returns, always.

	The three differ in what they would need — Zoom a server-to-server OAuth
	app, Meet a Workspace service account with domain-wide delegation, Teams an
	app registration with OnlineMeetings.ReadWrite.All — and they are identical
	in having none of it here. One error rather than three, so there is one
	place to change on the day a credential arrives and no chance of two of them
	drifting into a fabricated success.
*/
var ErrMeetingAPIUnavailable = errors.New(
	"creating a meeting automatically needs this installation's own Zoom, Google " +
		"Workspace or Microsoft 365 account with an API credential configured, and " +
		"none is. Paste the meeting link into the session instead")

// apiMeetingProvider is the shape all three share: a name, a label, and a
// refusal that names what is missing.
type apiMeetingProvider struct {
	key   string
	label string
	needs string
}

func (p apiMeetingProvider) Key() string      { return p.key }
func (p apiMeetingProvider) Label() string    { return p.label }
func (apiMeetingProvider) LiveCreate() bool   { return false }
func (p apiMeetingProvider) Create(MeetingRequest) (Meeting, error) {
	return Meeting{}, fmt.Errorf("%w (this provider needs %s)", ErrMeetingAPIUnavailable, p.needs)
}

// MeetingSystems is the three the launcher and virtual_class_providers already
// know, spelled identically. A fourth spelling is a session whose provider
// nothing can look up.
var MeetingSystems = map[string]string{
	"zoom":        "Zoom",
	"google_meet": "Google Meet",
	"ms_teams":    "Microsoft Teams",
}

// IsMeetingSystem guards the provider column before a save reaches the CHECK.
func IsMeetingSystem(k string) bool { _, ok := MeetingSystems[k]; return ok }

// AuthStyles is how each provider would authenticate, matching the CHECK on
// virtual_meeting_platform_providers.auth_style.
var AuthStyles = map[string]string{
	"oauth_s2s":        "Server-to-server OAuth (Zoom)",
	"service_account":  "Service account with domain-wide delegation (Google)",
	"app_registration": "App registration (Microsoft Entra)",
}

// IsAuthStyle guards auth_style the same way.
func IsAuthStyle(k string) bool { _, ok := AuthStyles[k]; return ok }

// MeetingProviders is every route the screen may offer, the working one first.
func MeetingProviders() []MeetingProvider {
	return []MeetingProvider{
		ManualMeetingProvider{},
		apiMeetingProvider{"zoom", "Zoom (not available)", "a server-to-server OAuth app"},
		apiMeetingProvider{"google_meet", "Google Meet (not available)",
			"a Workspace service account with domain-wide delegation"},
		apiMeetingProvider{"ms_teams", "Microsoft Teams (not available)",
			"an Entra app registration with OnlineMeetings.ReadWrite.All"},
	}
}

// MeetingProviderFor returns the route for a stored provider key.
//
// An unknown key falls back to the manual route, never to one that claims to
// create meetings. That direction is deliberate: the worst outcome of the
// fallback is a teacher being asked for a link, and the worst outcome of the
// other direction is a class sent to a meeting that does not exist.
func MeetingProviderFor(key string) MeetingProvider {
	for _, p := range MeetingProviders() {
		if p.Key() == key {
			return p
		}
	}
	return ManualMeetingProvider{}
}
