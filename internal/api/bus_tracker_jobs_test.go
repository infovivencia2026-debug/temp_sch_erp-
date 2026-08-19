package api

import (
	"testing"
	"time"
)

// The arithmetic that decides whether a bus has gone quiet, tested without a
// database because that is where it can be wrong silently: every case below
// produces a valid trip row either way, and the only symptom of getting it
// wrong is a parent's map.
func TestTripHasTimedOut(t *testing.T) {
	base := time.Date(2026, 8, 19, 8, 0, 0, 0, indiaTZ())
	at := func(m int) time.Time { return base.Add(time.Duration(m) * time.Minute) }
	ptr := func(v time.Time) *time.Time { return &v }

	cases := []struct {
		name    string
		started time.Time
		lastFix *time.Time
		mins    int
		now     time.Time
		want    bool
	}{
		{"fresh fix a minute ago", base, ptr(at(19)), 20, at(20), false},
		{"quiet for exactly the timeout is not yet timed out", base, ptr(at(0)), 20, at(20), false},
		{"quiet for one second past the timeout", base, ptr(at(0)), 20, at(20).Add(time.Second), true},

		// The case the schema allows and a naive max() would leave open
		// forever: a trip opened, the phone never got a fix.
		{"no positions at all times out from started_at", base, nil, 20, at(21), true},
		{"no positions and still inside the window", base, nil, 20, at(5), false},

		// A buffered fix from a dead zone can carry a recorded_at before the
		// trip opened; measuring from it would close a trip that just started.
		{"a fix older than started_at does not shorten the window", base, ptr(base.Add(-time.Hour)), 20, at(5), false},

		// A missing policy row scans as zero. Taken literally it times out
		// every trip on the first sweep.
		{"zero timeout falls back to the default", base, ptr(at(0)), 0, at(19), false},
		{"zero timeout still times out past the default", base, ptr(at(0)), 0, at(21), true},

		// The schema's CHECK bounds, applied here too so the Go path and the
		// SQL path cannot disagree about an out-of-range value.
		{"below the floor is clamped to five minutes", base, ptr(at(0)), 1, at(4), false},
		{"above the ceiling is clamped to four hours", base, ptr(at(0)), 9000, at(241), true},

		{"a long timeout keeps a slow run open", base, ptr(at(30)), 240, at(200), false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := tripHasTimedOut(c.started, c.lastFix, c.mins, c.now); got != c.want {
				t.Fatalf("tripHasTimedOut = %v, want %v (deadline %s, now %s)",
					got, c.want,
					tripTimeoutDeadline(tripLastHeard(c.started, c.lastFix), c.mins).Format(time.RFC3339),
					c.now.Format(time.RFC3339))
			}
		})
	}
}

// The end instant written on a timed-out trip is the last moment the trip was
// known alive, never the moment the sweep happened to run: the difference is
// invented minutes on every timed-out run in the history.
func TestTripLastHeardIsTheEndInstant(t *testing.T) {
	started := time.Date(2026, 8, 19, 8, 0, 0, 0, indiaTZ())
	fix := started.Add(12 * time.Minute)

	if got := tripLastHeard(started, &fix); !got.Equal(fix) {
		t.Fatalf("with a fix, last heard = %s, want %s", got, fix)
	}
	if got := tripLastHeard(started, nil); !got.Equal(started) {
		t.Fatalf("with no fix, last heard = %s, want started_at %s", got, started)
	}
	// ended_at >= started_at is a CHECK constraint; a stale buffered fix must
	// not be able to violate it.
	stale := started.Add(-90 * time.Minute)
	if got := tripLastHeard(started, &stale); got.Before(started) {
		t.Fatalf("last heard %s precedes started_at %s", got, started)
	}
}

func TestClampTripTimeoutMins(t *testing.T) {
	for in, want := range map[int]int{
		-5: defaultTripTimeoutMins, 0: defaultTripTimeoutMins,
		1: 5, 5: 5, 20: 20, 240: 240, 241: 240, 100000: 240,
	} {
		if got := clampTripTimeoutMins(in); got != want {
			t.Errorf("clampTripTimeoutMins(%d) = %d, want %d", in, got, want)
		}
	}
}

// The schedule is asserted as data, because the failure mode this whole file
// exists to prevent is an entry that was never registered -- which is
// invisible until a trip has been open for a week.
func TestBusTrackerCronEntries(t *testing.T) {
	entries := busTrackerCronEntries()
	seen := map[string]string{}
	for _, e := range entries {
		if e.spec == "" || e.typ == "" {
			t.Fatalf("incomplete cron entry: %+v", e)
		}
		if prev, dup := seen[e.typ]; dup {
			t.Fatalf("%s registered twice (%s and %s)", e.typ, prev, e.spec)
		}
		seen[e.typ] = e.spec
	}
	for _, typ := range []string{TypeTransportTripTimeout, TypeTransportPositionRetention} {
		if _, ok := seen[typ]; !ok {
			t.Errorf("%s has no cron entry, so it would never run", typ)
		}
	}
}
