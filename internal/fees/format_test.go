package fees

import "testing"

func TestRupeesGrouped(t *testing.T) {
	cases := map[int64]string{
		0:            "0.00",
		5:            "0.05",
		100:          "1.00",
		99999:        "999.99",
		100000:       "1,000.00",
		1250050:      "12,500.50",
		12345650:     "1,23,456.50",
		1234567800:   "1,23,45,678.00",
		123456789012: "1,23,45,67,890.12",
		-1250000:     "-12,500.00",
	}
	for in, want := range cases {
		if got := RupeesGrouped(in); got != want {
			t.Errorf("RupeesGrouped(%d) = %q, want %q", in, got, want)
		}
	}
}
