package api

import (
	"testing"
	"time"
)

/* The line formats one reader actually sends.

   ZK firmware is not consistent between models or revisions: the specification
   says tab-separated and several models send spaces, and the timestamp
   contains a space of its own, so a naive Fields() split puts the date in one
   column and the time in another. These pin the shapes so a firmware update
   that changes the separator fails a test rather than silently recording every
   punch at the zero time. */

func TestSplitLooseKeepsTheTimestampWhole(t *testing.T) {
	got := splitLoose("1042 2026-09-01 09:14:02 0 1")
	want := []string{"1042", "2026-09-01 09:14:02", "0", "1"}
	if len(got) != len(want) {
		t.Fatalf("got %d columns %q, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("column %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestSplitLooseRefusesALineTooShortToBeAPunch(t *testing.T) {
	if got := splitLoose("1042 2026-09-01"); got != nil {
		t.Fatalf("got %q, want nil — a punch needs an id, a date and a time", got)
	}
}

func TestParsePunchTimeAcceptsTheShapesFirmwareSends(t *testing.T) {
	for _, in := range []string{
		"2026-09-01 09:14:02",
		"2026-09-01T09:14:02",
		"2026-09-01 09:14",
	} {
		got, err := parsePunchTime(in)
		if err != nil {
			t.Fatalf("parsePunchTime(%q): %v", in, err)
		}
		// India, not UTC. A reader in Hyderabad sends local wall-clock time
		// with no zone on it, and reading 09:14 as UTC would file every
		// morning arrival as the previous afternoon.
		if h := got.In(indiaTZ()).Hour(); h != 9 {
			t.Errorf("parsePunchTime(%q) resolved to hour %d in India, want 9", in, h)
		}
	}
}

func TestParsePunchTimeRefusesWhatItCannotRead(t *testing.T) {
	for _, in := range []string{"", "not a time", "01/09/2026 09:14:02"} {
		if _, err := parsePunchTime(in); err == nil {
			t.Errorf("parsePunchTime(%q) succeeded; a guessed timestamp is worse than a dropped punch", in)
		}
	}
}

// The reply the firmware parses by position. "OK: n" advances the device's own
// watermark by n, so the shape is a contract and not a courtesy.
func TestPunchTimeIsWallClockNotUTC(t *testing.T) {
	got, err := parsePunchTime("2026-09-01 09:14:02")
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 9, 1, 9, 14, 2, 0, indiaTZ())
	if !got.Equal(want) {
		t.Fatalf("got %s, want %s", got, want)
	}
}
