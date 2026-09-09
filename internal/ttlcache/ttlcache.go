// Package ttlcache is a small, bounded, in-process cache with a time to live.
//
// It exists because of what the move to Cloud Run and Neon made visible: every
// request was opening four transactions and paying about twenty-three round
// trips before its handler ran, and the answers -- who is this cookie, has
// this school paid, which sections does this teacher reach -- change on the
// order of days while being asked on the order of milliseconds. A tiny cache
// in front of each of those lookups removes most of the round trips without
// touching a single query.
//
// What it deliberately is not:
//
//   - shared between processes. Two Cloud Run instances each hold their own,
//     so a write on one is stale on the other for at most one TTL. Every TTL
//     in this codebase is chosen with that window in mind, and every write
//     that can make an entry stale calls the matching invalidation so that at
//     least the process that did the write is right immediately.
//   - unbounded. A cap on entries is set at construction and enforced on
//     insert, first by dropping what has expired and then, if that was not
//     enough, by dropping arbitrary live entries. A cache that grows with the
//     number of distinct keys it has ever seen is a memory leak with a
//     friendlier name.
package ttlcache

import (
	"sync"
	"time"
)

// Cache maps K to V for a bounded time. Safe for concurrent use.
type Cache[K comparable, V any] struct {
	mu      sync.Mutex
	ttl     time.Duration
	cap     int
	entries map[K]*entry[V]
	// now is time.Now unless a test moves the clock.
	now func() time.Time
	// sweptAt is when expired entries were last purged in bulk. Purging on
	// every Set would make the cache O(n) per insert; purging when full or
	// once per TTL keeps it cheap and still keeps the map honest.
	sweptAt time.Time
}

type entry[V any] struct {
	val     V
	expires time.Time
}

// New returns an empty cache holding at most capacity entries, each for ttl.
func New[K comparable, V any](ttl time.Duration, capacity int) *Cache[K, V] {
	if capacity <= 0 {
		capacity = 1
	}
	return &Cache[K, V]{
		ttl:     ttl,
		cap:     capacity,
		entries: make(map[K]*entry[V]),
		now:     time.Now,
	}
}

// Get returns the live value for k, if there is one.
func (c *Cache[K, V]) Get(k K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[k]
	if !ok {
		var zero V
		return zero, false
	}
	if !c.now().Before(e.expires) {
		delete(c.entries, k)
		var zero V
		return zero, false
	}
	return e.val, true
}

// Set stores v under k for one TTL from now, replacing any previous value.
func (c *Cache[K, V]) Set(k K, v V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if _, exists := c.entries[k]; !exists && len(c.entries) >= c.cap {
		c.sweepLocked(now)
		// Still full: evict whatever the map yields first. Go's iteration
		// order is random, which is as fair as this needs to be -- the entry
		// costs one reload, and a cache this full is a sizing problem to be
		// fixed at the constructor, not here.
		for k2 := range c.entries {
			if len(c.entries) < c.cap {
				break
			}
			delete(c.entries, k2)
		}
	} else if now.Sub(c.sweptAt) > c.ttl {
		c.sweepLocked(now)
	}
	c.entries[k] = &entry[V]{val: v, expires: now.Add(c.ttl)}
}

// Delete forgets k. Deleting an absent key is not an error.
func (c *Cache[K, V]) Delete(k K) {
	c.mu.Lock()
	delete(c.entries, k)
	c.mu.Unlock()
}

// DeleteFunc forgets every entry for which match returns true.
//
// Linear in the size of the cache, which the cap keeps small. It is how a
// cache keyed by one thing (a token hash) is invalidated by another (the user
// the token belongs to) without keeping a second index that can drift.
func (c *Cache[K, V]) DeleteFunc(match func(K, V) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.entries {
		if match(k, e.val) {
			delete(c.entries, k)
		}
	}
}

// Clear forgets everything.
func (c *Cache[K, V]) Clear() {
	c.mu.Lock()
	c.entries = make(map[K]*entry[V])
	c.mu.Unlock()
}

// Len is the number of entries held, expired or not. For tests and metrics.
func (c *Cache[K, V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// SetClock replaces the time source. For tests, which must not sleep.
func (c *Cache[K, V]) SetClock(now func() time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

func (c *Cache[K, V]) sweepLocked(now time.Time) {
	for k, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, k)
		}
	}
	c.sweptAt = now
}
