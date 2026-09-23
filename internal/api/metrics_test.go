package api

import (
	"context"
	"testing"
	"time"
)

/*
The windows a cell can be set to, pinned in the school's own calendar.

	Weeks start on Monday and a half-open [from, to) with `to` never past
	tomorrow, so a Sunday "this week" runs Monday to today and its
	comparison is the seven days before Monday -- not a rolling seven days,
	which is a different question. Calendar-free periods need no database.
*/
func TestWindowForCalendarFreePeriods(t *testing.T) {
	ist := time.FixedZone("IST", 5*3600+1800)
	// Wednesday 23 September 2026, 14:00 IST.
	now := time.Date(2026, 9, 23, 14, 0, 0, 0, ist)
	d := func(y int, m time.Month, day int) time.Time { return time.Date(y, m, day, 0, 0, 0, 0, ist) }

	cases := map[string]struct{ from, to, pfrom, pto time.Time }{
		"today":     {d(2026, 9, 23), d(2026, 9, 24), d(2026, 9, 22), d(2026, 9, 23)},
		"yesterday": {d(2026, 9, 22), d(2026, 9, 23), d(2026, 9, 21), d(2026, 9, 22)},
		"week":      {d(2026, 9, 21), d(2026, 9, 24), d(2026, 9, 14), d(2026, 9, 21)},
		"month":     {d(2026, 9, 1), d(2026, 9, 24), d(2026, 8, 1), d(2026, 9, 1)},
	}
	for period, want := range cases {
		got, err := windowFor(context.Background(), nil, period, now)
		if err != nil {
			t.Fatalf("%s: %v", period, err)
		}
		if !got.From.Equal(want.from) || !got.To.Equal(want.to) {
			t.Errorf("%s: window %s..%s, want %s..%s", period, got.From, got.To, want.from, want.to)
		}
		if got.Prev == nil || !got.Prev.From.Equal(want.pfrom) || !got.Prev.To.Equal(want.pto) {
			t.Errorf("%s: previous window wrong: %+v", period, got.Prev)
		}
	}
	if _, err := windowFor(context.Background(), nil, "fortnight", now); err == nil {
		t.Error("an unknown period must be refused, not defaulted")
	}
	// "all" has no comparison: nothing came before everything.
	all, _ := windowFor(context.Background(), nil, "all", now)
	if all.Prev != nil || !all.To.Equal(d(2026, 9, 24)) {
		t.Errorf("all: %+v", all)
	}
}

// Every metric names a permission the gate knows and a query over both
// bounds (or, for a standing figure, the end bound), so a typo here cannot
// ship a cell nobody may read or one that ignores its period.
func TestMetricsAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, m := range metrics {
		if seen[m.Key] {
			t.Errorf("duplicate metric key %q", m.Key)
		}
		seen[m.Key] = true
		if m.Needs == "" || m.Label == "" || m.Hint == "" {
			t.Errorf("%s: needs a permission, a label and a hint", m.Key)
		}
		if !containsSQL(m.SQL, "$2") {
			t.Errorf("%s: query ignores the period's end", m.Key)
		}
		if !m.AsOf && !containsSQL(m.SQL, "$1") {
			t.Errorf("%s: a flow metric must read the period's start", m.Key)
		}
	}
}

func containsSQL(sql, needle string) bool {
	for i := 0; i+len(needle) <= len(sql); i++ {
		if sql[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
