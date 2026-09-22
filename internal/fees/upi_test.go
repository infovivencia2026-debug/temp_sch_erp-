package fees

import (
	"strings"
	"testing"
)

func TestValidVPA(t *testing.T) {
	good := []string{"kalyan.qb@axl", "school@sbi", "vhs-fees_2026@okhdfcbank", "9876543210@ybl"}
	for _, v := range good {
		if !ValidVPA(v) {
			t.Errorf("ValidVPA(%q) = false, want true", v)
		}
	}
	bad := []string{"", "school", "@sbi", "school@", "sc@sbi", "school @sbi", "school@s bi",
		"school@sbi@axl", "school@sbi.co", "school%40sbi"}
	for _, v := range bad {
		if ValidVPA(v) {
			t.Errorf("ValidVPA(%q) = true, want false", v)
		}
	}
}

/* The example pinned on both sides. web/src/lib/upi.test.ts builds the same
   intent from the same inputs and expects the same string; change one and the
   other must change with it, or a code drawn by the SPA and one drawn by the
   server would differ for the same payment. */
func TestUPIIntentEncodesAsAURINotAForm(t *testing.T) {
	got := UPIIntent("kalyan.qb@axl", "Vivencia High School", 1183300, "Fee 2026/0142 INV-7")
	want := "upi://pay?pa=kalyan.qb@axl&pn=Vivencia%20High%20School&am=11833.00&cu=INR&tn=Fee%202026%2F0142%20INV-7"
	if got != want {
		t.Errorf("UPIIntent\n got: %s\nwant: %s", got, want)
	}
	if strings.Contains(got, "+") {
		t.Error("a space became '+', which UPI apps show literally")
	}
	if strings.Contains(got, "%40") {
		t.Error("the payee address was escaped; some apps refuse %40 in pa")
	}
}

func TestUPIIntentOmitsAnEmptyNote(t *testing.T) {
	got := UPIIntent("school@sbi", "S", 100, "   ")
	if strings.Contains(got, "tn=") {
		t.Errorf("blank note was sent: %s", got)
	}
}

func TestUPIIntentClipsToTheSpecLimits(t *testing.T) {
	got := UPIIntent("school@sbi", strings.Repeat("x", 120), 100, strings.Repeat("y", 80))
	if !strings.Contains(got, "&pn="+strings.Repeat("x", 99)+"&am=") {
		t.Errorf("payee name was not clipped to 99 characters: %s", got)
	}
	if !strings.HasSuffix(got, "&tn="+strings.Repeat("y", 50)) {
		t.Errorf("note was not clipped to 50 characters: %s", got)
	}
	// Clipped on characters, not bytes: a three-byte Telugu letter must
	// survive whole or not at all.
	got = UPIIntent("school@sbi", "S", 100, strings.Repeat("క", 60))
	tn := got[strings.Index(got, "&tn=")+4:]
	if tn != strings.Repeat("%E0%B0%95", 50) {
		t.Errorf("note should be exactly 50 whole characters, got %s", tn)
	}
}

func TestRupees(t *testing.T) {
	cases := map[int64]string{
		0: "0.00", 1: "0.01", 100: "1.00", 150: "1.50", 1183300: "11833.00",
		10000000: "100000.00", 5: "0.05", -250: "-2.50",
	}
	for paise, want := range cases {
		if got := Rupees(paise); got != want {
			t.Errorf("Rupees(%d) = %q, want %q", paise, got, want)
		}
	}
}

func TestUPINote(t *testing.T) {
	if got := UPINote("  Fee   YPS/24-25  #12 (Term 1) "); got != "Fee YPS/24-25 12 Term 1" {
		t.Fatalf("UPINote = %q", got)
	}
}

func TestUPIQRPNG(t *testing.T) {
	png, err := UPIQRPNG(UPIIntent("school@sbi", "S", 100, "Fee"), 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(png) < 8 || string(png[1:4]) != "PNG" {
		t.Fatalf("not a PNG: %d bytes", len(png))
	}
}
