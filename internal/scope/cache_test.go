package scope

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
)

/* The cache in front of Resolve decides which rows a person reaches, so the
   tests here are less about speed than about the two ways a cache can be
   dangerous: serving an answer after the answer changed, and quietly turning
   "sees nothing" into "sees everything".

   The loader is stubbed rather than mocked at the database, because what is
   under test is the caching, not the SQL. */

func withStub(t *testing.T, calls *int, out *Resolved) {
	t.Helper()
	resolvedCache.Clear()
	resolvedCache.SetClock(time.Now)
	orig := resolveFn
	resolveFn = func(context.Context, *database.DB, *httpx.Identity) (*Resolved, error) {
		*calls++
		return out, nil
	}
	t.Cleanup(func() {
		resolveFn = orig
		resolvedCache.Clear()
		resolvedCache.SetClock(time.Now)
	})
}

func TestResolvedIsCachedUntilItExpiresOrIsInvalidated(t *testing.T) {
	user, inst := uuid.New(), uuid.New()
	want := &Resolved{UserID: user, InstitutionID: inst, SectionIDs: []uuid.UUID{uuid.New()}}
	calls := 0
	withStub(t, &calls, want)

	now := time.Date(2026, 9, 9, 9, 0, 0, 0, time.UTC)
	resolvedCache.SetClock(func() time.Time { return now })

	id := &httpx.Identity{UserID: user, InstitutionID: inst}
	get := func() {
		t.Helper()
		if _, err := Resolve(context.Background(), nil, id); err != nil {
			t.Fatal(err)
		}
	}

	get()
	if calls != 1 {
		t.Fatalf("first resolve made %d lookups, want 1", calls)
	}

	now = now.Add(time.Minute)
	get()
	if calls != 1 {
		t.Fatalf("a cached resolve went to the database (%d lookups)", calls)
	}

	Invalidate(user)
	get()
	if calls != 2 {
		t.Fatalf("Invalidate did not force a reload (%d lookups)", calls)
	}

	InvalidateInstitution(inst)
	get()
	if calls != 3 {
		t.Fatalf("InvalidateInstitution did not force a reload (%d lookups)", calls)
	}

	now = now.Add(resolvedTTL + time.Second)
	get()
	if calls != 4 {
		t.Fatalf("an expired entry was served (%d lookups)", calls)
	}
}

// Invalidating one user must not invalidate a colleague, and invalidating one
// school must not invalidate another. A cache that clears itself on every
// write is only correct by accident, and would give back everything this is
// for.
func TestInvalidationIsNarrow(t *testing.T) {
	resolvedCache.Clear()
	t.Cleanup(resolvedCache.Clear)
	resolvedCache.SetClock(time.Now)

	a, b := uuid.New(), uuid.New()
	instA, instB := uuid.New(), uuid.New()
	resolvedCache.Set(cacheKey{a, instA}, &Resolved{UserID: a})
	resolvedCache.Set(cacheKey{b, instA}, &Resolved{UserID: b})
	resolvedCache.Set(cacheKey{b, instB}, &Resolved{UserID: b})

	Invalidate(a)
	if _, ok := resolvedCache.Get(cacheKey{a, instA}); ok {
		t.Fatal("Invalidate left the named user cached")
	}
	if _, ok := resolvedCache.Get(cacheKey{b, instA}); !ok {
		t.Fatal("Invalidate reached a colleague")
	}

	InvalidateInstitution(instA)
	if _, ok := resolvedCache.Get(cacheKey{b, instA}); ok {
		t.Fatal("InvalidateInstitution left an entry in the named school")
	}
	if _, ok := resolvedCache.Get(cacheKey{b, instB}); !ok {
		t.Fatal("InvalidateInstitution reached another school")
	}
}

/*
An empty scope means SEE NOTHING, cached or not.

	The dangerous failure is not staleness, it is a cache miss that returns a
	zero value which some caller then reads as "unrestricted". Filter's
	contract is that an empty set yields FALSE, and it has to keep saying so
	on an answer that came out of the cache.
*/
func TestAnEmptyCachedScopeStillSeesNothing(t *testing.T) {
	resolvedCache.Clear()
	t.Cleanup(resolvedCache.Clear)
	resolvedCache.SetClock(time.Now)

	user, inst := uuid.New(), uuid.New()
	empty := &Resolved{UserID: user, InstitutionID: inst}
	resolvedCache.Set(cacheKey{user, inst}, empty)

	got, ok := resolvedCache.Get(cacheKey{user, inst})
	if !ok {
		t.Fatal("the entry just written was not there")
	}
	for _, s := range []catalog.Scope{
		catalog.ScopeCampus, catalog.ScopeDepartment,
		catalog.ScopeAssignedClasses, catalog.ScopeSelf, catalog.ScopeChildren,
	} {
		clause, _ := got.Filter(s, "x", 1)
		if clause != "FALSE" {
			t.Fatalf("scope %q on an empty cached boundary gave %q, want FALSE", s, clause)
		}
	}

	// And the miss path: a key that was never cached must not hand back a
	// usable zero value.
	if r, ok := resolvedCache.Get(cacheKey{uuid.New(), inst}); ok || r != nil {
		t.Fatal("a cache miss returned something")
	}
}

// The per-request memo answers once and no more, which is the point of it.
func TestTheRequestMemoResolvesOnce(t *testing.T) {
	calls := 0
	withStub(t, &calls, &Resolved{})
	ctx := WithCache(context.Background())
	id := &httpx.Identity{UserID: uuid.New(), InstitutionID: uuid.New()}

	if _, ok := ctx.Value(ctxKey{}).(*requestCache); !ok {
		t.Fatal("WithCache put nothing on the context")
	}
	for range 3 {
		if _, err := Resolve(ctx, nil, id); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("the memo resolved %d times in one request, want 1", calls)
	}

	// A context without the memo must still work -- Resolve is called from
	// background jobs that have no request.
	if _, ok := context.Background().Value(ctxKey{}).(*requestCache); ok {
		t.Fatal("a plain context carried a memo it was never given")
	}
}
