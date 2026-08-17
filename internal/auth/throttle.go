package auth

import (
	"sync"
	"time"
)

// --- login throttling --------------------------------------------------------

// Throttle rate-limits failed sign-ins per identifier.
//
// In memory rather than in Redis on purpose: this is one web process behind
// nginx, and the failure mode of a shared store — an outage locking everyone
// out — is worse than the failure mode of a local one, which is that a
// restart clears the counters. Successful logins reset immediately, so a
// legitimate user who mistypes twice is never delayed.
type Throttle struct {
	mu       sync.Mutex
	attempts map[string]*attemptRecord
}

type attemptRecord struct {
	count     int
	lockedTil time.Time
	lastSeen  time.Time
}

const (
	maxFailedAttempts = 8
	lockoutDuration   = 5 * time.Minute
)

func NewThrottle() *Throttle {
	t := &Throttle{attempts: map[string]*attemptRecord{}}
	go t.reap()
	return t
}

// Allowed reports whether an identifier may attempt a sign-in, and how long
// they must wait if not.
func (t *Throttle) Allowed(identifier string) (bool, time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.attempts[identifier]
	if !ok {
		return true, 0
	}
	if time.Now().Before(rec.lockedTil) {
		return false, time.Until(rec.lockedTil)
	}
	return true, 0
}

func (t *Throttle) Failed(identifier string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.attempts[identifier]
	if !ok {
		rec = &attemptRecord{}
		t.attempts[identifier] = rec
	}
	rec.count++
	rec.lastSeen = time.Now()
	if rec.count >= maxFailedAttempts {
		rec.lockedTil = time.Now().Add(lockoutDuration)
		rec.count = 0
	}
}

func (t *Throttle) Succeeded(identifier string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.attempts, identifier)
}

// reap discards records nobody has touched, so a stuffing run against thousands
// of usernames cannot grow the map without bound.
func (t *Throttle) reap() {
	for range time.Tick(10 * time.Minute) {
		cutoff := time.Now().Add(-30 * time.Minute)
		t.mu.Lock()
		for k, rec := range t.attempts {
			if rec.lastSeen.Before(cutoff) && time.Now().After(rec.lockedTil) {
				delete(t.attempts, k)
			}
		}
		t.mu.Unlock()
	}
}
