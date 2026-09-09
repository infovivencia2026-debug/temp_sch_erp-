package auth

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
)

/* What these prove, and why each one is worth a test.

   The cache in front of Resolve is the difference between one database round
   trip per request and one per minute, and it sits on the code path that
   decides who somebody is. Three properties have to hold: it answers from
   memory inside the TTL, it stops answering when told to forget, and it stops
   answering when the minute is up. A regression in the first is a cost; a
   regression in either of the others is somebody keeping access they were
   told they had lost. */

// newTestStore builds a Store with no database behind it. load is replaced,
// which is the only thing Resolve reaches the database for.
func newTestStore(t *testing.T, rec *sessionRecord, calls *int) (*Store, func(time.Time)) {
	t.Helper()
	s := &Store{
		idleTTL: 2 * time.Hour,
		cache:   ttlCacheFor(),
		now:     time.Now,
	}
	s.load = func(context.Context, []byte) (*sessionRecord, error) {
		*calls++
		return rec, nil
	}
	s.revoke = func(context.Context, uuid.UUID) error { return nil }
	now := time.Date(2026, 9, 9, 9, 0, 0, 0, time.UTC)
	set := func(at time.Time) {
		now = at
		s.now = func() time.Time { return now }
		s.cache.SetClock(func() time.Time { return now })
	}
	set(now)
	// touch would need a database; it is only reached past touchEvery, and
	// the idle assertions below stay well inside it.
	return s, set
}

func req(token string) *http.Request {
	r, _ := http.NewRequest(http.MethodGet, "/api/v1/students", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: token})
	return r
}

func TestResolveAnswersFromMemoryUntilItIsToldNotTo(t *testing.T) {
	user := uuid.New()
	rec := &sessionRecord{
		sessionID: uuid.New(),
		userID:    user,
		instID:    ptr(uuid.New()),
		fullName:  "Asha Rao",
		perms:     []string{"students.read"},
	}
	calls := 0
	s, at := newTestStore(t, rec, &calls)
	start := time.Date(2026, 9, 9, 9, 0, 0, 0, time.UTC)
	rec.lastSeen = start

	if _, err := s.Resolve(context.Background(), req("tok")); err != nil {
		t.Fatalf("first resolve: %v", err)
	}
	if calls != 1 {
		t.Fatalf("first resolve made %d lookups, want 1", calls)
	}

	// Inside the TTL: no second lookup.
	at(start.Add(30 * time.Second))
	if _, err := s.Resolve(context.Background(), req("tok")); err != nil {
		t.Fatalf("cached resolve: %v", err)
	}
	if calls != 1 {
		t.Fatalf("a cached resolve went to the database (%d lookups)", calls)
	}

	// Told to forget the user: the next request pays again.
	s.ForgetUser(user)
	if _, err := s.Resolve(context.Background(), req("tok")); err != nil {
		t.Fatalf("resolve after ForgetUser: %v", err)
	}
	if calls != 2 {
		t.Fatalf("ForgetUser did not force a reload (%d lookups)", calls)
	}

	// Forget by session id does the same.
	s.Forget(rec.sessionID)
	if _, err := s.Resolve(context.Background(), req("tok")); err != nil {
		t.Fatalf("resolve after Forget: %v", err)
	}
	if calls != 3 {
		t.Fatalf("Forget did not force a reload (%d lookups)", calls)
	}

	// Past the TTL: reloaded even though nobody forgot anything.
	at(start.Add(30*time.Second + resolveTTL + time.Second))
	if _, err := s.Resolve(context.Background(), req("tok")); err != nil {
		t.Fatalf("resolve after TTL: %v", err)
	}
	if calls != 4 {
		t.Fatalf("an expired entry was served (%d lookups)", calls)
	}
}

// A cached identity must not outlive the idle timeout. This is the property
// the cache was most likely to break: the idle check used to read a column
// straight from the row, and now it reads a value the entry carries.
func TestACachedSessionStillTimesOutWhenIdle(t *testing.T) {
	rec := &sessionRecord{sessionID: uuid.New(), userID: uuid.New(), instID: ptr(uuid.New())}
	calls := 0
	s, at := newTestStore(t, rec, &calls)
	s.idleTTL = 30 * time.Minute
	start := time.Date(2026, 9, 9, 9, 0, 0, 0, time.UTC)
	rec.lastSeen = start

	if _, err := s.Resolve(context.Background(), req("tok")); err != nil {
		t.Fatalf("first resolve: %v", err)
	}

	// Still inside the cache TTL, but well past the idle limit. The entry is
	// live and must still be refused.
	at(start.Add(31 * time.Minute))
	s.cache.SetClock(func() time.Time { return start }) // keep the entry unexpired
	if _, err := s.Resolve(context.Background(), req("tok")); err == nil {
		t.Fatal("a session idle past its limit was served from cache")
	}
}

// The identity handed out is a copy, because ActingInstitution amends it in
// place and the next request must not inherit that.
func TestResolveHandsOutACopy(t *testing.T) {
	rec := &sessionRecord{sessionID: uuid.New(), userID: uuid.New(), instID: ptr(uuid.New())}
	calls := 0
	s, _ := newTestStore(t, rec, &calls)
	rec.lastSeen = time.Date(2026, 9, 9, 9, 0, 0, 0, time.UTC)

	first, err := s.Resolve(context.Background(), req("tok"))
	if err != nil {
		t.Fatalf("first resolve: %v", err)
	}
	other := uuid.New()
	first.InstitutionID = other

	second, err := s.Resolve(context.Background(), req("tok"))
	if err != nil {
		t.Fatalf("second resolve: %v", err)
	}
	if second.InstitutionID == other {
		t.Fatal("one request's acting institution leaked into the next")
	}
	var _ *httpx.Identity = second
}

func ptr[T any](v T) *T { return &v }
