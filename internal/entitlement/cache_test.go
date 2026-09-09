package entitlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* The paywall is asked on every tenant request and answered from a table that
   changes a few times a year. What has to hold is that a school which has
   just paid is not told to pay again, and that a school whose subscription
   was pulled stops being served -- so: cached inside the TTL, reloaded when
   invalidated, reloaded when the minute is up. */

func TestStandingIsCachedUntilItExpiresOrIsInvalidated(t *testing.T) {
	calls := 0
	orig := resolveFn
	resolveFn = func(context.Context, pgx.Tx, uuid.UUID) (State, error) {
		calls++
		return State{Active: true, Code: "ok", Status: "active"}, nil
	}
	now := time.Date(2026, 9, 9, 9, 0, 0, 0, time.UTC)
	states.SetClock(func() time.Time { return now })
	states.Clear()
	t.Cleanup(func() { resolveFn = orig; states.Clear(); states.SetClock(time.Now) })

	inst := uuid.New()
	get := func() State {
		t.Helper()
		st, err := ResolveCached(context.Background(), nil, inst)
		if err != nil {
			t.Fatal(err)
		}
		return st
	}

	if st := get(); !st.Active {
		t.Fatal("first resolve did not come back active")
	}
	if calls != 1 {
		t.Fatalf("first resolve made %d lookups, want 1", calls)
	}

	now = now.Add(30 * time.Second)
	get()
	if calls != 1 {
		t.Fatalf("a cached standing went to the database (%d lookups)", calls)
	}

	Invalidate(inst)
	get()
	if calls != 2 {
		t.Fatalf("Invalidate did not force a reload (%d lookups)", calls)
	}

	InvalidateAll()
	get()
	if calls != 3 {
		t.Fatalf("InvalidateAll did not force a reload (%d lookups)", calls)
	}

	now = now.Add(stateTTL + time.Second)
	get()
	if calls != 4 {
		t.Fatalf("an expired standing was served (%d lookups)", calls)
	}
}

// A failed lookup must not be cached. A database blip that cached "no
// subscription" would lock a paying school out for the whole TTL.
func TestAFailedLookupIsNotCached(t *testing.T) {
	orig := resolveFn
	calls := 0
	resolveFn = func(context.Context, pgx.Tx, uuid.UUID) (State, error) {
		calls++
		return State{}, context.DeadlineExceeded
	}
	states.Clear()
	states.SetClock(time.Now)
	t.Cleanup(func() { resolveFn = orig; states.Clear() })

	inst := uuid.New()
	for range 2 {
		if _, err := ResolveCached(context.Background(), nil, inst); err == nil {
			t.Fatal("a failing lookup was reported as success")
		}
	}
	if calls != 2 {
		t.Fatalf("a failure was cached (%d lookups for 2 calls)", calls)
	}
}
