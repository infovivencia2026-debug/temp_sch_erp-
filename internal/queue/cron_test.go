package queue

import (
	"testing"
	"time"

	"github.com/riverqueue/river/rivertype"
)

/*
The one decision the cron tick makes, tested without a database.

	Everything else in Tick is bookkeeping around due: read the last run,
	ask, record, enqueue. If due is wrong in either direction the symptom is
	silent -- reminders that never go out, or go out twice -- so the cases
	below are the ones a scheduler that is not always running has to get
	right: a late tick, a long outage, a first sight, and a timezone.
*/
func TestDue(t *testing.T) {
	ist, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Skip("no tzdata")
	}
	at := func(s string) time.Time {
		v, err := time.ParseInLocation("2006-01-02 15:04:05", s, ist)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}

	cases := []struct {
		name string
		spec string
		last string
		seen bool
		now  string
		want bool
	}{
		// A tick forty seconds after the hour still fires the 09:00 entry.
		{"late tick fires", "0 9 * * *", "2026-09-05 08:59:10", true, "2026-09-05 09:00:40", true},
		// A tick a minute before does not.
		{"early tick waits", "0 9 * * *", "2026-09-05 08:58:00", true, "2026-09-05 08:59:00", false},
		// Down from 08:55 to 09:10: fires once on return.
		{"outage fires once", "0 9 * * *", "2026-09-05 08:55:00", true, "2026-09-05 09:10:00", true},
		// Already ran at 09:00:40; a second caller at 09:01 finds nothing.
		{"second caller idle", "0 9 * * *", "2026-09-05 09:00:40", true, "2026-09-05 09:01:00", false},
		// Every minute: due exactly one minute on, not before.
		{"minute entry", "* * * * *", "2026-09-05 10:00:05", true, "2026-09-05 10:01:00", true},
		{"minute entry early", "* * * * *", "2026-09-05 10:00:05", true, "2026-09-05 10:00:59", false},
		// Sunday 03:00 on a Saturday: no.
		{"weekly waits", "0 3 * * 0", "2026-09-05 02:00:00", true, "2026-09-05 03:30:00", false},
		// Never seen: baseline only, even when the spec matches right now.
		{"first sight", "* * * * *", "", false, "2026-09-05 10:01:00", false},
	}
	for _, c := range cases {
		var last time.Time
		if c.seen {
			last = at(c.last)
		}
		got, err := due(c.spec, last, c.seen, at(c.now), ist)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: due = %v, want %v", c.name, got, c.want)
		}
	}
}

// 00:30 in Kolkata is 19:00 UTC the previous evening. Read in UTC the entry
// would fire in the middle of the Indian school day, which is the mistake the
// timezone plumbing exists to prevent.
func TestDueRespectsTimezone(t *testing.T) {
	ist, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Skip("no tzdata")
	}
	last := time.Date(2026, 9, 4, 18, 0, 0, 0, time.UTC) // 23:30 IST on the 4th
	now := time.Date(2026, 9, 4, 19, 1, 0, 0, time.UTC)  // 00:31 IST on the 5th
	got, err := due("30 0 * * *", last, true, now, ist)
	if err != nil {
		t.Fatal(err)
	}
	if !got {
		t.Error("00:30 IST has passed; the rollup should be due")
	}
	got, err = due("30 0 * * *", last, true, now, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if got {
		t.Error("in UTC 00:30 is five and a half hours away; nothing should be due")
	}
}

// A spec that does not parse must fail loudly at the first tick rather than
// be skipped forever.
func TestDueRejectsBadSpec(t *testing.T) {
	if _, err := due("every day at nine", time.Time{}, true, time.Now(), time.UTC); err == nil {
		t.Fatal("bad spec accepted")
	}
}

// The retry curve asynq had, as River sees it: doubling from a second and
// capped so a recovering database is not hammered.
func TestBackoffCaps(t *testing.T) {
	for _, attempt := range []int{1, 5, 10, 25} {
		next := backoff{}.NextRetry(&rivertype.JobRow{Attempt: attempt})
		d := time.Until(next)
		if d > maxBackoff+time.Second {
			t.Errorf("attempt %d: backoff %v exceeds cap %v", attempt, d, maxBackoff)
		}
		if attempt == 1 && (d < time.Second || d > 3*time.Second) {
			t.Errorf("attempt 1: backoff %v, want about 2s", d)
		}
	}
}
