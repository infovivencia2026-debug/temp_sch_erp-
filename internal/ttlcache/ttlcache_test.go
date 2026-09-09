package ttlcache

import (
	"testing"
	"time"
)

func TestEntriesExpireAndTheCapHolds(t *testing.T) {
	now := time.Date(2026, 9, 9, 10, 0, 0, 0, time.UTC)
	c := New[string, int](time.Minute, 3)
	c.SetClock(func() time.Time { return now })

	c.Set("a", 1)
	if v, ok := c.Get("a"); !ok || v != 1 {
		t.Fatalf("fresh entry missing: %v %v", v, ok)
	}

	// One second short of the TTL is still live; the TTL itself is not.
	now = now.Add(59 * time.Second)
	if _, ok := c.Get("a"); !ok {
		t.Fatal("entry expired early")
	}
	now = now.Add(time.Second)
	if _, ok := c.Get("a"); ok {
		t.Fatal("entry outlived its TTL")
	}

	// The cap: a fourth distinct key must not grow the map past three.
	c.Set("a", 1)
	c.Set("b", 2)
	c.Set("c", 3)
	c.Set("d", 4)
	if n := c.Len(); n > 3 {
		t.Fatalf("cache grew to %d entries with a cap of 3", n)
	}
	if v, ok := c.Get("d"); !ok || v != 4 {
		t.Fatal("the entry just written was the one evicted")
	}

	// Expired entries are what goes first when the cache is full.
	c.Clear()
	c.Set("old1", 1)
	c.Set("old2", 2)
	now = now.Add(2 * time.Minute)
	c.Set("new1", 3)
	c.Set("new2", 4)
	for _, k := range []string{"new1", "new2"} {
		if _, ok := c.Get(k); !ok {
			t.Fatalf("%s was evicted while expired entries remained", k)
		}
	}

	// DeleteFunc reaches entries by value, not only by key.
	c.DeleteFunc(func(_ string, v int) bool { return v == 3 })
	if _, ok := c.Get("new1"); ok {
		t.Fatal("DeleteFunc left the matching entry behind")
	}
	if _, ok := c.Get("new2"); !ok {
		t.Fatal("DeleteFunc removed an entry that did not match")
	}
}
