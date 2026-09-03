package api

import (
	"strings"
	"testing"
)

/*
The grace window is refused in words, not in constraint names.

	Every bound below is also a CHECK on leave_policy; the point of testing the
	validator is that a person typing 300 into the grace box reads "between 0
	and 240 minutes" and not "leave_policy_grace_minutes_check".
*/
func TestPunchGraceRefusesWhatTheTableWould(t *testing.T) {
	five, twenty := 5, 20
	for _, tc := range []struct {
		name string
		in   punchGrace
		want string
	}{
		{"bad clock", punchGrace{ShiftStartsAt: "9am", GraceMinutes: 10, LateMarksPerDay: 3}, "09:00"},
		{"25 o'clock", punchGrace{ShiftStartsAt: "25:00", GraceMinutes: 10, LateMarksPerDay: 3}, "09:00"},
		{"too much grace", punchGrace{ShiftStartsAt: "09:00", GraceMinutes: 300, LateMarksPerDay: 3}, "240"},
		{"negative grace", punchGrace{ShiftStartsAt: "09:00", GraceMinutes: -1, LateMarksPerDay: 3}, "240"},
		{"half day inside grace", punchGrace{ShiftStartsAt: "09:00", GraceMinutes: 10, LateHalfDayMins: &five, LateMarksPerDay: 3}, "later than the grace"},
		{"zero marks per day", punchGrace{ShiftStartsAt: "09:00", GraceMinutes: 10, LateMarksPerDay: 0}, "late marks"},
	} {
		err := validatePunchGrace(tc.in)
		if err == nil {
			t.Errorf("%s: accepted", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: said %q, want it to mention %q", tc.name, err, tc.want)
		}
	}

	// The common setting, and a half day threshold past the grace, both pass.
	for _, ok := range []punchGrace{
		{ShiftStartsAt: "09:00", GraceMinutes: 10, LateMarksPerDay: 3},
		{ShiftStartsAt: "08:30", GraceMinutes: 0, LateHalfDayMins: &twenty, LateMarksPerDay: 1},
		{ShiftStartsAt: "23:59", GraceMinutes: 240, LateMarksPerDay: 3},
	} {
		if err := validatePunchGrace(ok); err != nil {
			t.Errorf("%+v refused: %v", ok, err)
		}
	}
}
