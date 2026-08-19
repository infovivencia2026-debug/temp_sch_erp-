package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Authorization for the transport office's tracker screens.

	Walked out of the router rather than listed by hand. A hand-written list is
	a list that goes stale the first time somebody adds a route and forgets to
	add a line here, and the route it forgets is the one nobody notices is
	open. chi.Walk asks the router what it actually serves.

	The property being asserted is one sentence: somebody who may look at the
	transport module may change nothing in it. That covers the retune, the
	revoke, and — the one that matters most — the policy write, because
	parents_may_watch publishes a live vehicle position to several hundred
	families and is off until a school deliberately turns it on.

	No database: RequirePermission runs before the handler, so a refusal never
	reaches one. A caller that gets past the guard hits a nil *database.DB and
	panics, which statusOf reports as 500 — not 403, which is the whole
	assertion.
*/
func mountedBusTrackerManage(id *httpx.Identity) *chi.Mux {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	s.mountBusTrackerManage(r)
	return r
}

type mountedRoute struct{ method, pattern, path string }

// busTrackerManageRoutes asks the router what it serves, with {id} filled in so
// the request actually matches.
func busTrackerManageRoutes(t *testing.T) []mountedRoute {
	t.Helper()
	var out []mountedRoute
	err := chi.Walk(mountedBusTrackerManage(identityWith()),
		func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
			out = append(out, mountedRoute{
				method:  method,
				pattern: route,
				path:    strings.ReplaceAll(route, "{id}", uuid.NewString()),
			})
			return nil
		})
	if err != nil {
		t.Fatalf("walking the router: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("the router served no routes; the walk found nothing to assert on")
	}
	return out
}

// A signed-in user holding nothing reaches none of it, read or write.
func TestBusTrackerManageRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedBusTrackerManage(identityWith())
	for _, rt := range busTrackerManageRoutes(t) {
		if got := statusOf(t, h, rt.method, rt.path); got != http.StatusForbidden {
			t.Errorf("%s %s without any permission: got %d, want 403",
				rt.method, rt.pattern, got)
		}
	}
}

/*
The read rung reads. It does not retune a fleet, unpair a phone, or publish
every bus to every parent.

	Written as "every non-GET route", so a write route added later is covered by
	this test on the day it is added rather than on the day somebody remembers
	to extend a list.
*/
func TestBusTrackerManageWritesRefuseTransportReadAlone(t *testing.T) {
	h := mountedBusTrackerManage(identityWith(rbac.TransportRead))
	writes := 0
	for _, rt := range busTrackerManageRoutes(t) {
		got := statusOf(t, h, rt.method, rt.path)
		if rt.method == http.MethodGet {
			if got == http.StatusForbidden {
				t.Errorf("GET %s with transport.read: got 403, want the handler reached",
					rt.pattern)
			}
			continue
		}
		writes++
		if got != http.StatusForbidden {
			t.Errorf("%s %s with only transport.read: got %d, want 403",
				rt.method, rt.pattern, got)
		}
	}
	if writes == 0 {
		t.Fatal("no write routes were walked; the assertion asserted nothing")
	}
}

// And the write rung reaches them, so the test above is proving a gate rather
// than a router that refuses everybody.
func TestBusTrackerManageWritesReachableWithTransportWrite(t *testing.T) {
	h := mountedBusTrackerManage(identityWith(rbac.TransportRead, rbac.TransportWrite))
	for _, rt := range busTrackerManageRoutes(t) {
		if rt.method == http.MethodGet {
			continue
		}
		if got := statusOf(t, h, rt.method, rt.path); got == http.StatusForbidden {
			t.Errorf("%s %s with transport.write: got 403, want reachable",
				rt.method, rt.pattern)
		}
	}
}

// --- pure logic --------------------------------------------------------------

// Every bound restated from migration 00122's CHECK constraints, because a
// mismatch here means Postgres answers the office with a constraint name.
func TestTrackingPolicyBoundsMatchTheSchema(t *testing.T) {
	ok := trackingPolicyBody{
		DefaultGeofenceM: 120, SpeedLimitKmph: 50, SpeedingHoldSecs: 20,
		TripTimeoutMins: 20, PingSeconds: 15, WatchWindowMins: 45, RetainDays: 90,
	}
	if msg := validateTrackingPolicy(ok); msg != "" {
		t.Fatalf("the schema's own defaults were refused: %s", msg)
	}

	for _, tc := range []struct {
		name   string
		mutate func(*trackingPolicyBody)
		field  string
	}{
		{"geofence too tight", func(p *trackingPolicyBody) { p.DefaultGeofenceM = 29 }, "default_geofence_m"},
		{"geofence too wide", func(p *trackingPolicyBody) { p.DefaultGeofenceM = 2001 }, "default_geofence_m"},
		{"speed below floor", func(p *trackingPolicyBody) { p.SpeedLimitKmph = 9 }, "speed_limit_kmph"},
		{"speed above ceiling", func(p *trackingPolicyBody) { p.SpeedLimitKmph = 121 }, "speed_limit_kmph"},
		{"hold too short", func(p *trackingPolicyBody) { p.SpeedingHoldSecs = 4 }, "speeding_hold_secs"},
		{"hold too long", func(p *trackingPolicyBody) { p.SpeedingHoldSecs = 301 }, "speeding_hold_secs"},
		{"timeout too short", func(p *trackingPolicyBody) { p.TripTimeoutMins = 4 }, "trip_timeout_mins"},
		{"timeout too long", func(p *trackingPolicyBody) { p.TripTimeoutMins = 241 }, "trip_timeout_mins"},
		{"ping too fast", func(p *trackingPolicyBody) { p.PingSeconds = 4 }, "ping_seconds"},
		{"ping too slow", func(p *trackingPolicyBody) { p.PingSeconds = 301 }, "ping_seconds"},
		{"window too short", func(p *trackingPolicyBody) { p.WatchWindowMins = 4 }, "watch_window_mins"},
		{"window too long", func(p *trackingPolicyBody) { p.WatchWindowMins = 241 }, "watch_window_mins"},
		{"retention too short", func(p *trackingPolicyBody) { p.RetainDays = 6 }, "retain_days"},
		{"retention too long", func(p *trackingPolicyBody) { p.RetainDays = 3651 }, "retain_days"},
		// A zero-valued body is the shape a half-filled form posts, and it must
		// be refused rather than written as "geofence 0 metres".
		{"empty body", func(p *trackingPolicyBody) { *p = trackingPolicyBody{} }, "default_geofence_m"},
	} {
		p := ok
		tc.mutate(&p)
		msg := validateTrackingPolicy(p)
		if msg == "" {
			t.Errorf("%s was accepted; Postgres would have refused it", tc.name)
			continue
		}
		if !strings.Contains(msg, tc.field) {
			t.Errorf("%s: message %q does not name %s", tc.name, msg, tc.field)
		}
		// The message is for a head of transport, not a DBA.
		if strings.Contains(msg, "constraint") || strings.Contains(msg, "CHECK") {
			t.Errorf("%s: message %q reads like a database error", tc.name, msg)
		}
	}
}

// The sentence a school is shown when it turns the parent map on has to say
// what it publishes and what it does not. If this ever becomes vague, families
// were told something that is not true.
func TestParentsMayWatchNoticeSaysWhatItPublishes(t *testing.T) {
	for _, want := range []string{"guardian", "run"} {
		if !strings.Contains(parentsMayWatchNotice, want) {
			t.Errorf("the parents_may_watch notice never mentions %q: %q",
				want, parentsMayWatchNotice)
		}
	}
}
