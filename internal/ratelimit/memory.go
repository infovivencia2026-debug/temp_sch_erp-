package ratelimit

import (
	"context"
	"sync"
	"time"
)

/*
Memory is the store that was in internal/api, moved here whole.

	Per process, and declared as such: behind two instances it hands out two
	budgets, and a restart forgets every count. That is the store the VPS has
	always run and it is the default, so nothing there changes. It is also
	what a test gets when it constructs a Server and sets nothing, which means
	a test's limiter state lives and dies with that test's Server rather than
	in a package variable the next test inherits.

	One map per scope, exactly as there was one map per limiter before, so the
	bookkeeping each limiter did to itself -- the sliding log's one-entry
	sweep, the fixed window's wholesale clear past ten thousand keys -- still
	touches only its own keys.
*/
type Memory struct {
	mu     sync.Mutex
	scopes map[string]*memoryScope
	// MaxFixedEntries is where a scope's fixed-window map is cleared wholesale
	// rather than reaped: one small struct per key seen this minute, and a
	// process serving thousands would rather drop the counters than run a
	// sweeper. Zero means the default of ten thousand.
	MaxFixedEntries int
}

type memoryScope struct {
	hits    map[string][]time.Time
	windows map[string]*fixedWindow
}

type fixedWindow struct {
	started time.Time
	count   int
}

const defaultMaxFixedEntries = 10000

// NewMemory returns an empty in-process store.
func NewMemory() *Memory {
	return &Memory{scopes: map[string]*memoryScope{}}
}

// Hit implements Store. It never returns an error.
func (m *Memory) Hit(_ context.Context, scope, key string, p Policy, now time.Time) (bool, time.Duration, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sc := m.scopes[scope]
	if sc == nil {
		sc = &memoryScope{hits: map[string][]time.Time{}, windows: map[string]*fixedWindow{}}
		m.scopes[scope] = sc
	}
	if p.Fixed {
		ok, retry := m.fixed(sc, key, p, now)
		return ok, retry, nil
	}
	ok, retry := sliding(sc, key, p, now)
	return ok, retry, nil
}

// sliding is formLimiter.allow as it stood, with a retry-after added: the
// oldest hit still inside the window is the one whose leaving reopens it.
func sliding(sc *memoryScope, key string, p Policy, now time.Time) (bool, time.Duration) {
	cutoff := now.Add(-p.Window)
	kept := sc.hits[key][:0]
	for _, t := range sc.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= p.burst() {
		sc.hits[key] = kept
		return false, kept[0].Sub(cutoff)
	}
	sc.hits[key] = append(kept, now)
	// Opportunistic sweep: one expired key per call is enough to keep a map
	// of transient addresses bounded without ever walking it under load.
	for k, v := range sc.hits {
		if len(v) == 0 || v[len(v)-1].Before(cutoff) {
			delete(sc.hits, k)
			break
		}
	}
	return true, 0
}

// fixed is apiKeyLimiter.allow as it stood.
func (m *Memory) fixed(sc *memoryScope, key string, p Policy, now time.Time) (bool, time.Duration) {
	max := m.MaxFixedEntries
	if max <= 0 {
		max = defaultMaxFixedEntries
	}
	if len(sc.windows) > max {
		sc.windows = map[string]*fixedWindow{}
	}
	w := sc.windows[key]
	if w == nil || now.Sub(w.started) >= p.Window {
		sc.windows[key] = &fixedWindow{started: now, count: 1}
		return true, 0
	}
	if w.count >= p.burst() {
		return false, p.Window - now.Sub(w.started)
	}
	w.count++
	return true, 0
}
