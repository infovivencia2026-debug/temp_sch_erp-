package ratelimit

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

/*
Both stores, one set of questions.

	The point of two stores is that a handler cannot tell them apart, so every
	behavioural test here runs against both and asserts the same answers on the
	same timeline. The memory store always runs; the Postgres store runs when
	TEST_DATABASE_URL names a database that has migration 00251 applied, the
	same convention as internal/queue/e2e_test.go, and skips otherwise.

	Time is a variable, not the clock. Every store takes now as an argument and
	the Postgres store carries it into SQL, so a ten-minute window is walked in
	a microsecond and the boundary is tested at the boundary, not a second past
	it.
*/

type storeCase struct {
	name  string
	store Store
	// fresh returns a scope no other test has hit, so a shared database does
	// not leak counts between cases or between runs.
	fresh func() string
}

func stores(t *testing.T) []storeCase {
	t.Helper()
	fresh := func() string { return "test_" + uuid.NewString()[:8] }
	cases := []storeCase{{name: "memory", store: NewMemory(), fresh: fresh}}
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		pool, err := pgxpool.New(context.Background(), url)
		if err != nil {
			t.Fatalf("connect: %v", err)
		}
		t.Cleanup(pool.Close)
		var ok bool
		if err := pool.QueryRow(context.Background(),
			`SELECT to_regclass('rate_limit_hits') IS NOT NULL`).Scan(&ok); err != nil || !ok {
			t.Fatalf("rate_limit_hits is missing (err=%v); apply migrations to TEST_DATABASE_URL first", err)
		}
		run := func(ctx context.Context, fn func(pgx.Tx) error) error {
			return pgx.BeginFunc(ctx, pool, fn)
		}
		scopes := []string{}
		t.Cleanup(func() {
			for _, sc := range scopes {
				pool.Exec(context.Background(), `DELETE FROM rate_limit_hits WHERE scope = $1`, sc) //nolint:errcheck
			}
		})
		cases = append(cases, storeCase{name: "postgres", store: NewPostgres(run), fresh: func() string {
			sc := fresh()
			scopes = append(scopes, sc)
			return sc
		}})
	}
	return cases
}

// walk is a limiter with a hand-turned clock.
type walk struct {
	t   *testing.T
	l   Scoped
	now time.Time
}

func newWalk(t *testing.T, sc storeCase, p Policy) *walk {
	w := &walk{t: t, now: time.Date(2026, 9, 5, 9, 0, 0, 0, time.UTC)}
	w.l = New(sc.store, sc.fresh(), p, func() time.Time { return w.now })
	return w
}

func (w *walk) at(d time.Duration) *walk {
	w.now = w.now.Add(d)
	return w
}

func (w *walk) allow(key string) (bool, time.Duration) {
	w.t.Helper()
	ok, retry, err := w.l.Allow(context.Background(), key)
	if err != nil {
		w.t.Fatalf("Allow(%q): %v", key, err)
	}
	return ok, retry
}

func (w *walk) mustAllow(key string, why string) {
	w.t.Helper()
	if ok, retry := w.allow(key); !ok {
		w.t.Fatalf("%s: refused, retry in %v", why, retry)
	}
}

func (w *walk) mustRefuse(key string, retry time.Duration, why string) {
	w.t.Helper()
	ok, got := w.allow(key)
	if ok {
		w.t.Fatalf("%s: allowed", why)
	}
	if got != retry {
		w.t.Errorf("%s: retry-after %v, want %v", why, got, retry)
	}
}

/*
The sliding log: what the public endpoints have always had.

	Six in ten minutes means six in ANY ten minutes. The seventh is refused
	until the oldest of the six is a full window old -- not a second past it,
	exactly at it, because the store keeps a hit while it is strictly inside
	the window -- and retry-after says precisely when that is.
*/
func TestSlidingLog(t *testing.T) {
	for _, sc := range stores(t) {
		t.Run(sc.name, func(t *testing.T) {
			p := Policy{Window: 10 * time.Minute, Burst: 3}
			w := newWalk(t, sc, p)

			w.mustAllow("a", "first")
			w.at(time.Minute).mustAllow("a", "second, a minute later")
			w.at(time.Minute).mustAllow("a", "third, two minutes in")
			w.at(time.Minute).mustRefuse("a", 7*time.Minute, "fourth inside the window")
			w.mustAllow("b", "another key while a is refused")
			// Refusals record nothing, so hammering the door does not extend
			// the lockout.
			w.at(7*time.Minute-time.Second).mustRefuse("a", time.Second, "a second before the oldest leaves")
			w.at(time.Second).mustAllow("a", "exactly a window after the oldest hit")
			// Now hits at 1m, 2m and 10m are inside; the next is refused until
			// the 1m hit leaves at 11m.
			w.mustRefuse("a", time.Minute, "three still inside")
			w.at(time.Minute).mustAllow("a", "at 11m the 1m hit has left")
		})
	}
}

/*
The fixed window: what API keys have always had.

	The window opens at the first hit and shuts a minute later regardless of
	what happens inside it. Retry-after is the rest of that minute, which is
	the promise the header has always made: wait this long and the whole
	budget is back.
*/
func TestFixedWindow(t *testing.T) {
	for _, sc := range stores(t) {
		t.Run(sc.name, func(t *testing.T) {
			p := Policy{Window: time.Minute, Burst: 3, Fixed: true}
			w := newWalk(t, sc, p)

			w.mustAllow("k", "first")
			w.at(10*time.Second).mustAllow("k", "second")
			w.at(10*time.Second).mustAllow("k", "third")
			w.mustRefuse("k", 40*time.Second, "fourth at 20s")
			w.at(30*time.Second).mustRefuse("k", 10*time.Second, "fifth at 50s")
			w.mustAllow("other", "a second key has its own window")
			// At exactly a minute the window has closed and the next hit opens
			// a new one -- and it is the first of the new window's budget, not
			// a free one.
			w.at(10*time.Second).mustAllow("k", "at 60s a new window opens")
			w.mustAllow("k", "second of the new window")
			w.mustAllow("k", "third of the new window")
			w.mustRefuse("k", time.Minute, "fourth of the new window, at its very start")
		})
	}
}

// A burst of zero or less means one: a key whose limit was never set still
// gets to make a call and read the answer, rather than being silently dead.
func TestZeroBurstMeansOne(t *testing.T) {
	for _, sc := range stores(t) {
		t.Run(sc.name, func(t *testing.T) {
			for _, fixed := range []bool{false, true} {
				w := newWalk(t, sc, Policy{Window: time.Minute, Burst: 0, Fixed: fixed})
				w.mustAllow("k", "the one call")
				w.mustRefuse("k", time.Minute, "the second")
			}
		})
	}
}

// AllowBurst decides the burst per call, which is how a per-key limit rides
// one scope: two keys on one scope with different numbers get different
// numbers.
func TestAllowBurstIsPerCall(t *testing.T) {
	for _, sc := range stores(t) {
		t.Run(sc.name, func(t *testing.T) {
			now := time.Date(2026, 9, 5, 9, 0, 0, 0, time.UTC)
			l := New(sc.store, sc.fresh(), Policy{Window: time.Minute, Fixed: true}, func() time.Time { return now })
			ctx := context.Background()
			for i := 0; i < 2; i++ {
				if ok, _, err := l.AllowBurst(ctx, "two", 2); err != nil || !ok {
					t.Fatalf("call %d on a burst of two: ok=%v err=%v", i+1, ok, err)
				}
			}
			if ok, _, _ := l.AllowBurst(ctx, "two", 2); ok {
				t.Error("third call on a burst of two was allowed")
			}
			for i := 0; i < 5; i++ {
				if ok, _, err := l.AllowBurst(ctx, "five", 5); err != nil || !ok {
					t.Fatalf("call %d on a burst of five: ok=%v err=%v", i+1, ok, err)
				}
			}
		})
	}
}

/*
Concurrency: the reason the Postgres store takes a lock.

	Forty goroutines, one key, a budget of five. Exactly five may win. Without
	the advisory lock two transactions could each count four and each insert
	a fifth, and the memory store's mutex is the same promise made locally.
*/
func TestConcurrentHitsRespectTheBudget(t *testing.T) {
	for _, sc := range stores(t) {
		t.Run(sc.name, func(t *testing.T) {
			for _, fixed := range []bool{false, true} {
				now := time.Date(2026, 9, 5, 9, 0, 0, 0, time.UTC)
				l := New(sc.store, sc.fresh(), Policy{Window: time.Minute, Burst: 5, Fixed: fixed}, func() time.Time { return now })
				var mu sync.Mutex
				var wg sync.WaitGroup
				allowed := 0
				for i := 0; i < 40; i++ {
					wg.Add(1)
					go func() {
						defer wg.Done()
						ok, _, err := l.Allow(context.Background(), "k")
						if err != nil {
							t.Error(err)
							return
						}
						if ok {
							mu.Lock()
							allowed++
							mu.Unlock()
						}
					}()
				}
				wg.Wait()
				if allowed != 5 {
					t.Errorf("fixed=%v: %d of 40 concurrent attempts allowed against a budget of 5", fixed, allowed)
				}
			}
		})
	}
}

// The memory store's fixed-window map is cleared wholesale past its cap
// rather than reaped, exactly as apiKeyLimiter did; a key seen after the
// clear starts a fresh window.
func TestMemoryFixedWindowClearsPastCap(t *testing.T) {
	m := NewMemory()
	m.MaxFixedEntries = 3
	now := time.Now()
	p := Policy{Window: time.Minute, Burst: 1, Fixed: true}
	ctx := context.Background()
	for _, k := range []string{"a", "b", "c"} {
		if ok, _, _ := m.Hit(ctx, "s", k, p, now); !ok {
			t.Fatalf("%s: first hit refused", k)
		}
	}
	if ok, _, _ := m.Hit(ctx, "s", "a", p, now); ok {
		t.Fatal("a was allowed twice with the map at the cap: three entries is not past three, so nothing cleared")
	}
	// A fourth key pushes the map past the cap; the next call clears it
	// before looking, and a is new again.
	m.Hit(ctx, "s", "d", p, now) //nolint:errcheck
	if ok, _, _ := m.Hit(ctx, "s", "a", p, now); !ok {
		t.Fatal("the map was not cleared once it grew past the cap")
	}
}

/*
The Postgres store sweeps as it goes: rows leave the table when they leave
the window, so the table holds at most Burst rows per live subject and none
for anybody who has gone quiet.
*/
func TestPostgresSweepsExpiredRows(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	ctx := context.Background()
	run := func(ctx context.Context, fn func(pgx.Tx) error) error { return pgx.BeginFunc(ctx, pool, fn) }
	count := func(scope string) int {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM rate_limit_hits WHERE scope = $1`, scope).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for _, fixed := range []bool{false, true} {
		scope := "sweep_" + uuid.NewString()[:8]
		t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM rate_limit_hits WHERE scope = $1`, scope) }) //nolint:errcheck
		now := time.Date(2026, 9, 5, 9, 0, 0, 0, time.UTC)
		s := NewPostgres(run)
		p := Policy{Window: time.Minute, Burst: 3, Fixed: fixed}
		for _, k := range []string{"a", "b", "c"} {
			if _, _, err := s.Hit(ctx, scope, k, p, now); err != nil {
				t.Fatal(err)
			}
		}
		if got := count(scope); got != 3 {
			t.Fatalf("fixed=%v: %d rows after three hits", fixed, got)
		}
		// A minute later one hit on any key sweeps the other keys' dead rows.
		if _, _, err := s.Hit(ctx, scope, "z", p, now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		if got := count(scope); got != 1 {
			t.Errorf("fixed=%v: %d rows a window later; want just the new one", fixed, got)
		}
	}
}

// The fixed window's sweep deletes a subject whole or not at all: a subject
// whose window is still open keeps every row, or the window it is in would
// move.
func TestPostgresFixedSweepKeepsOpenWindowsWhole(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	ctx := context.Background()
	scope := "whole_" + uuid.NewString()[:8]
	t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM rate_limit_hits WHERE scope = $1`, scope) }) //nolint:errcheck
	s := NewPostgres(func(ctx context.Context, fn func(pgx.Tx) error) error { return pgx.BeginFunc(ctx, pool, fn) })
	p := Policy{Window: time.Minute, Burst: 3, Fixed: true}
	t0 := time.Date(2026, 9, 5, 9, 0, 0, 0, time.UTC)
	// k opens at t0 and spends its budget by t0+55s.
	for _, d := range []time.Duration{0, 50 * time.Second, 55 * time.Second} {
		if ok, _, err := s.Hit(ctx, scope, "k", p, t0.Add(d)); err != nil || !ok {
			t.Fatalf("hit at %v: ok=%v err=%v", d, ok, err)
		}
	}
	// At t0+61s the window that opened at t0 has closed. A time-based sweep
	// would have dropped only the t0 row and left two, making the 61s hit the
	// third of a window "opened" at 50s and the 62s hit refused. The correct
	// answer is a fresh window: 61s, 62s and 63s all allowed, 64s refused.
	for _, d := range []time.Duration{61 * time.Second, 62 * time.Second, 63 * time.Second} {
		if ok, _, err := s.Hit(ctx, scope, "k", p, t0.Add(d)); err != nil || !ok {
			t.Fatalf("hit at %v after the window closed: ok=%v err=%v", d, ok, err)
		}
	}
	if ok, retry, _ := s.Hit(ctx, scope, "k", p, t0.Add(64*time.Second)); ok || retry != 57*time.Second {
		t.Errorf("fourth hit of the new window: ok=%v retry=%v, want refused with 57s", ok, retry)
	}
}
