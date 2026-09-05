/*
Package ratelimit is the one rate limiter, with two places to keep its count.

# Why one package

Four in-process limiters grew up in internal/api, each an honest map behind a
mutex, each declaring that behind more than one process it limits per process.
That was the right call for one web process behind nginx. On Cloud Run with
min-instances 0 the same code means something else: a cold start forgets every
count, and two instances each hand out a full budget, so a six-attempt limit
on a pair-code endpoint is twelve attempts, or eighteen, or however many
instances the autoscaler was in the mood for. docs/arch_lowcost.txt pins
maxScale at 1 until the limiters are shared. This package is how they are
shared.

# Shape

A Store keeps the hits. A Limiter is a Store plus a scope (which limiter this
is -- "sms_gateway_pair", "api_key") plus a Policy (how many in how long), and
answers the only question a handler asks:

	ok, retryAfter, err := limiter.Allow(ctx, key)

Two stores. Memory is exactly the code that was in internal/api, moved: a
sliding log of timestamps per key for the public endpoints, a fixed window
that starts at the first hit for API keys, the same opportunistic sweeps, the
same wholesale clear at ten thousand entries. It never returns an error. It is
the default, so a deployment that sets nothing behaves as it did yesterday.
Postgres keeps the same hits as rows in one table and takes an advisory lock
per key, so every instance sees every other instance's attempts and a cold
start finds the counts where it left them. It is selected with
RATE_LIMIT_STORE=postgres.

# Two algorithms, deliberately

Sliding log: an attempt is allowed while fewer than Burst hits fall inside the
last Window. This is what the public endpoints had, and a boundary cannot be
gamed: six attempts is six attempts in any ten minutes you choose.

Fixed window: the window opens at the first hit and closes Window later; an
attempt is allowed while fewer than Burst hits fall inside the open window,
and the next hit after it closes opens a new one. This is what API keys had,
kept because it is what the retry-after header has always promised
integrations -- "wait this long and the whole budget is back" -- and because
the failure mode of a fixed window (twice the rate across a boundary) does
not matter for a limit whose purpose is stopping a runaway loop.

Both stores implement both, and the tests hold them to the same answers.

# Clocks

Every decision takes its now from the Limiter's clock, and the Postgres store
carries that time into SQL rather than using the database's now(), so a test
can walk a limiter through a ten-minute window in a microsecond and both
stores can be tested against identical timelines. A handler passes nothing;
the default clock is time.Now.
*/
package ratelimit

import (
	"context"
	"time"
)

// Policy is how much of something is allowed in how long.
type Policy struct {
	// Window is the period the budget is measured over.
	Window time.Duration
	// Burst is how many hits the window may hold. Zero or less is read as
	// one, so a misconfigured key still gets to make one call and learn the
	// limit from the response rather than being silently unusable.
	Burst int
	// Fixed selects the fixed window that opens at the first hit; the default
	// is the sliding log. See the package comment for why both exist.
	Fixed bool
}

func (p Policy) burst() int {
	if p.Burst <= 0 {
		return 1
	}
	return p.Burst
}

// Store keeps the hits. Hit records one attempt against key inside scope --
// unless the attempt is over budget, in which case it records nothing and
// reports how long until the next attempt could succeed -- and does both as
// one atomic step, so two attempts racing on one key cannot both be the last
// one allowed.
//
// A Store is safe for concurrent use. Memory never errors; Postgres errors
// when the database does, and the caller decides what an unanswerable
// question means for its endpoint.
type Store interface {
	Hit(ctx context.Context, scope, key string, p Policy, now time.Time) (ok bool, retryAfter time.Duration, err error)
}

// Limiter is what a handler holds: a Store with a scope and a policy fixed.
type Limiter interface {
	// Allow reports whether key may proceed, and if not, how long it should
	// wait. An error means the store could not answer; ok is false then and
	// retryAfter is zero, and the caller chooses whether that closes the door
	// or opens it.
	Allow(ctx context.Context, key string) (ok bool, retryAfter time.Duration, err error)
}

// Clock is where a limiter reads the time. Tests supply their own.
type Clock func() time.Time

// Scoped is the Limiter New returns. It is a value type over a shared Store,
// so making one per request costs nothing and holds no state of its own --
// all the state is in the store, which is the point.
type Scoped struct {
	store Store
	scope string
	pol   Policy
	now   Clock
}

// New binds a store to a scope and a policy. A nil clock means time.Now.
func New(store Store, scope string, p Policy, clock Clock) Scoped {
	if clock == nil {
		clock = time.Now
	}
	return Scoped{store: store, scope: scope, pol: p, now: clock}
}

// Allow implements Limiter.
func (l Scoped) Allow(ctx context.Context, key string) (bool, time.Duration, error) {
	return l.store.Hit(ctx, l.scope, key, l.pol, l.now())
}

// AllowBurst is Allow with the burst decided per call, which is what API keys
// need: the window is a minute for every key and the number is on the key.
func (l Scoped) AllowBurst(ctx context.Context, key string, burst int) (bool, time.Duration, error) {
	p := l.pol
	p.Burst = burst
	return l.store.Hit(ctx, l.scope, key, p, l.now())
}
