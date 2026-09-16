package auth

import (
	"testing"
	"time"
)

func TestDayCodeTurnsOverAtSchoolMidnight(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	// 23:30 IST on the 15th is 18:00 UTC on the 15th; 00:30 IST on the 16th is
	// 19:00 UTC on the 15th. Same UTC date, different school date.
	late := time.Date(2026, 9, 15, 18, 0, 0, 0, time.UTC)
	early := time.Date(2026, 9, 15, 19, 0, 0, 0, time.UTC)
	d1, _ := LocalDay("Asia/Kolkata", late)
	d2, _ := LocalDay("Asia/Kolkata", early)
	if d1.Day() != 15 || d2.Day() != 16 {
		t.Fatalf("local days: %v %v", d1, d2)
	}
	if DayCode(secret, d1) == DayCode(secret, d2) {
		t.Fatal("the code did not change at the school's midnight")
	}
	if !DayCodeMatches(secret, "Asia/Kolkata", DayCode(secret, d1), late) {
		t.Fatal("today's code was refused")
	}
	if DayCodeMatches(secret, "Asia/Kolkata", DayCode(secret, d1), early) {
		t.Fatal("yesterday's code was accepted")
	}
	if DayCodeMatches(nil, "Asia/Kolkata", DayCode(secret, d1), late) {
		t.Fatal("a school with the feature off accepted a code")
	}
	if c := DayCode(secret, d1); len(c) != 6 {
		t.Fatalf("code %q is not six digits", c)
	}
}
