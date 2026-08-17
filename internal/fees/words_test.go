package fees

import (
	"testing"
	"time"
)

func TestRupeesInWords(t *testing.T) {
	cases := []struct {
		paise int64
		want  string
	}{
		{0, "Zero Rupees Only"},
		{100, "One Rupees Only"},
		{4500000, "Forty Five Thousand Rupees Only"},
		{150, "One Rupees and Fifty Paise Only"},
		// 11-19 are irregular; "Fifteen", never "Ten Five".
		{1500, "Fifteen Rupees Only"},
		{123456700, "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees Only"},
		// Indian grouping: ₹10,00,00,000 is ten crore, not "one hundred million".
		{100_000_000 * 100, "Ten Crore Rupees Only"},
		{1_00_00_000 * 100, "One Crore Rupees Only"},
		{1_23_45_678 * 100, "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees Only"},
		{25000000, "Two Lakh Fifty Thousand Rupees Only"},
		{999999, "Nine Thousand Nine Hundred Ninety Nine Rupees and Ninety Nine Paise Only"},
	}
	for _, c := range cases {
		if got := RupeesInWords(c.paise); got != c.want {
			t.Errorf("RupeesInWords(%d)\n got: %q\nwant: %q", c.paise, got, c.want)
		}
	}
}

func TestFinancialYearRunsAprilToMarch(t *testing.T) {
	cases := map[string]string{
		"2026-04-01": "2026-27",
		"2026-12-31": "2026-27",
		"2027-03-31": "2026-27",
		// January belongs to the year that began the previous April.
		"2027-01-15": "2026-27",
		"2027-04-01": "2027-28",
	}
	for in, want := range cases {
		d := mustDate(t, in)
		if got := FinancialYear(d); got != want {
			t.Errorf("FinancialYear(%s) = %s, want %s", in, got, want)
		}
	}
}

func mustDate(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse(time.DateOnly, s)
	if err != nil {
		t.Fatalf("bad date %q: %v", s, err)
	}
	return d
}
