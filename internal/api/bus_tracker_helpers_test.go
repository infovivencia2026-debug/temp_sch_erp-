package api

import "testing"

/*
The pieces of the bus tracker that need no database.

	These three decide what a parent is told and which register row a child is
	marked on, and every one of them is a pure function of its arguments, so
	they are tested the way the haversine in bus_tracker_test.go is: a table
	and no fixtures. The database-backed halves of the same files are covered
	by the groups that skip without TEST_DATABASE_URL, and a fake would only
	prove the fake works.
*/

func floatPtr(v float64) *float64 { return &v }

/*
etaMinutes is the number a parent acts on, so the cases that matter are the
ones where it must refuse to answer and the one where a stopped bus used to
produce nonsense.

	A fix with no speed on it gets no estimate: the chip is saying it does not
	know, and a made-up minute count is worse than a blank. A negative distance
	is not a distance. And a bus at a signal reports zero, which without the
	8 km/h floor divides into four hundred minutes and tells a parent their
	child is two districts away.

	Everything is rounded up: the crow-flies distance is shorter than the road,
	so a figure that errs early is the wrong way to err. A parent who comes
	down two minutes late has missed the bus. That is why zero metres is one
	minute and never nought.
*/
func TestEtaMinutesRoundsUpAndRefusesToGuess(t *testing.T) {
	for _, tc := range []struct {
		name   string
		metres int
		speed  *float64
		want   *int
	}{
		{"no speed on the fix means no estimate", 1000, nil, nil},
		{"a negative distance is not a distance", -1, floatPtr(40), nil},
		{"at the door is one minute, never nought", 0, floatPtr(30), intPtr(1)},
		{"a kilometre at 60 km/h", 1000, floatPtr(60), intPtr(2)},
		{"under a minute still rounds up to one", 900, floatPtr(60), intPtr(1)},
		// 8 km/h is 133.33 m per minute, so 1000 m is 7.5 minutes and reads 8.
		{"a stopped bus is a slow bus, not a division by zero", 1000, floatPtr(0), intPtr(8)},
		{"a crawl below the floor is treated as the floor", 1000, floatPtr(2), intPtr(8)},
		{"a nonsensical negative speed is floored too", 1000, floatPtr(-40), intPtr(8)},
		{"the floor does not slow a bus that is moving", 1000, floatPtr(20), intPtr(4)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := etaMinutes(tc.metres, tc.speed)
			switch {
			case tc.want == nil && got != nil:
				t.Errorf("got %d minutes, want no estimate at all", *got)
			case tc.want != nil && got == nil:
				t.Errorf("got no estimate, want %d minutes", *tc.want)
			case tc.want != nil && *got != *tc.want:
				t.Errorf("got %d minutes, want %d", *got, *tc.want)
			}
		})
	}
}

func intPtr(v int) *int { return &v }

/*
legForDirection translates a trip's direction into the register's half of the
day.

	transport_attendance is keyed on (student, date, leg), so getting this
	wrong does not fail loudly: it marks the child's morning row in the
	afternoon and the office sees a boarding that never happened. Only 'drop'
	is the afternoon; anything else, including a direction nobody set, is the
	morning run, because a bus that is not going home is going to school.
*/
func TestLegForDirectionNamesTheHalfOfTheDay(t *testing.T) {
	for _, tc := range []struct {
		direction string
		want      string
	}{
		{"drop", "afternoon"},
		{"pickup", "morning"},
		{"", "morning"},
		{"Drop", "morning"}, // the column is lower case; anything else is not a drop
		{"anything else", "morning"},
	} {
		if got := legForDirection(tc.direction); got != tc.want {
			t.Errorf("direction %q marked the %s leg, want %s", tc.direction, got, tc.want)
		}
	}
}

/*
normaliseBusCode has to make the sticker and the plate the same string.

	The bug it exists for: the SQL stripped non-alphanumerics from
	registration_no and this side only trimmed and upper-cased, so a driver who
	typed the registration the way it is painted on the back of the bus, with
	spaces, was told no bus in their school carries that code. Spaces, hyphens
	and case all have to fall away here as well.
*/
func TestNormaliseBusCodeMatchesThePlateAsItIsPainted(t *testing.T) {
	for _, tc := range []struct {
		code string
		want string
	}{
		{"TS36UB0001", "TS36UB0001"},
		{"TS 36 UB 0001", "TS36UB0001"},
		{"ts-36-ub-0001", "TS36UB0001"},
		{"  ts36ub0001  ", "TS36UB0001"},
		{"TS.36/UB 0001", "TS36UB0001"},
		{"12", "12"}, // bus_code itself is digits, and stripping costs it nothing
		{"", ""},
		{"---", ""},
	} {
		if got := normaliseBusCode(tc.code); got != tc.want {
			t.Errorf("normaliseBusCode(%q) = %q, want %q", tc.code, got, tc.want)
		}
	}
}
