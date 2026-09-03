package api

import (
	"testing"
	"time"
)

/*
A month with no opens is still a month on the chart.

	The line is built from a fixed run of month keys and the database fills in
	the ones it has rows for. If the run skipped a quiet month, the chart would
	draw July next to September and the drop would look like a rise.
*/
func TestUsageMonthKeysRunToTheCurrentMonthWithoutGaps(t *testing.T) {
	now := time.Date(2026, time.February, 14, 10, 0, 0, 0, time.UTC)
	got := usageMonthKeys(now, 4)
	want := []string{"2025-11", "2025-12", "2026-01", "2026-02"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("month %d = %q, want %q", i, got[i], want[i])
		}
	}
	// Asking for nothing still yields this month, so the screen always has a
	// point to draw.
	if got := usageMonthKeys(now, 0); len(got) != 1 || got[0] != "2026-02" {
		t.Errorf("zero months gave %v", got)
	}
}

// The query string is bounded: a screen cannot ask for one month (no movement
// to show) or for a decade (nothing a chart can draw).
func TestUsageMonthsParamIsBounded(t *testing.T) {
	for raw, want := range map[string]int{"": 6, "x": 6, "1": 6, "3": 3, "24": 24, "99": 24} {
		if got := usageMonthsParam(raw); got != want {
			t.Errorf("months=%q -> %d, want %d", raw, got, want)
		}
	}
}
