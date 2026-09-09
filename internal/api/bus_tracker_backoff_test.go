package api

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

/*
The two answers busTrackerHeartbeatSeconds can give without asking the
database, which are the two that decide the overnight traffic.

	An open trip and the night hours are settled before the route-window query
	is reached, so both are exercised with a nil transaction: if either ever
	starts touching the database, this test panics rather than passing
	quietly. The window branch itself needs route_stops rows and is covered by
	the database-backed tracker tests.

	Instants are built in IST and handed over in UTC, because the server runs
	UTC and the point of the function is that it judges the hour in India.
*/
func TestBusTrackerHeartbeatBacksOffWhenIdle(t *testing.T) {
	ist := time.FixedZone("IST", 5*3600+1800)
	at := func(h, m int) time.Time {
		return time.Date(2026, time.September, 5, h, m, 0, 0, ist).UTC()
	}
	cases := []struct {
		name     string
		now      time.Time
		tripOpen bool
		want     int
	}{
		{"a running bus is never slowed", at(23, 30), true, 0},
		{"a running bus at noon is never slowed", at(12, 0), true, 0},
		{"nine at night is night", at(21, 0), false, busTrackerNightHeartbeat},
		{"three in the morning is night", at(3, 0), false, busTrackerNightHeartbeat},
		{"a minute before half past five is night", at(5, 29), false, busTrackerNightHeartbeat},
	}
	for _, c := range cases {
		got, err := busTrackerHeartbeatSeconds(context.Background(), nil,
			uuid.Nil, c.now, c.tripOpen)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: at %s got %d, want %d",
				c.name, c.now.In(ist).Format("15:04"), got, c.want)
		}
	}
}
