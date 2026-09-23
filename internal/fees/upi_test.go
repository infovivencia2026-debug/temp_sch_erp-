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

/*
The example pinned on both sides. web/src/lib/upi.test.ts builds the same

	intent from the same inputs and expects the same string; change one and the
	other must change with it, or a code drawn by the SPA and one drawn by the
	server would differ for the same payment.
*/
func TestUPIIntentEncodesAsAURINotAForm(t *testing.T) {
	got := UPIIntent(Payment{VPA: "kalyan.qb@axl", PayeeName: "Vivencia High School", AmountPaise: 1183300, Note: "Fee 2026/0142 INV-7"})
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
	got := UPIIntent(Payment{VPA: "school@sbi", PayeeName: "S", AmountPaise: 100, Note: "   "})
	if strings.Contains(got, "tn=") {
		t.Errorf("blank note was sent: %s", got)
	}
}

func TestUPIIntentClipsToTheSpecLimits(t *testing.T) {
	got := UPIIntent(Payment{VPA: "school@sbi", PayeeName: strings.Repeat("x", 120), AmountPaise: 100, Note: strings.Repeat("y", 80)})
	if !strings.Contains(got, "&pn="+strings.Repeat("x", 99)+"&am=") {
		t.Errorf("payee name was not clipped to 99 characters: %s", got)
	}
	if !strings.HasSuffix(got, "&tn="+strings.Repeat("y", 50)) {
		t.Errorf("note was not clipped to 50 characters: %s", got)
	}
	// Clipped on characters, not bytes: a three-byte Telugu letter must
	// survive whole or not at all.
	got = UPIIntent(Payment{VPA: "school@sbi", PayeeName: "S", AmountPaise: 100, Note: strings.Repeat("క", 60)})
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
	png, err := UPIQRPNG(UPIIntent(Payment{VPA: "school@sbi", PayeeName: "S", AmountPaise: 100, Note: "Fee"}), 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(png) < 8 || string(png[1:4]) != "PNG" {
		t.Fatalf("not a PNG: %d bytes", len(png))
	}
}

/*
The chooser exists because a bare upi:// link never asked.

	Pins the two things a parent's tap depends on: that every app is sent the
	SAME payment the QR carries, and that the Android form names a package --
	the moment it does not, the OS default takes the tap back and WhatsApp
	opens again, which is the bug this was written for.
*/
func TestUPIAppLinksCarryOnePaymentAndNameThePackage(t *testing.T) {
	pay := Payment{VPA: "school@okhdfcbank", PayeeName: "Vivencia School", AmountPaise: 125050, Note: "Fee 2031 INV-7"}
	apps := UPIAppLinks(pay)
	if len(apps) < 2 {
		t.Fatalf("no apps offered: %v", apps)
	}
	want := UPIIntent(pay)
	query := strings.TrimPrefix(want, "upi://pay?")

	var generic int
	for _, a := range apps {
		if a.Android == "" && a.IOS == "" {
			generic++
			continue
		}
		if !strings.Contains(a.Android, ";package=") {
			t.Errorf("%s: android link names no package, so the OS default wins: %s", a.Key, a.Android)
		}
		if !strings.Contains(a.Android, "scheme=upi") {
			t.Errorf("%s: android link does not declare the upi scheme: %s", a.Key, a.Android)
		}
		// The same amount and note in every form; a chooser that paid a
		// different sum depending on the button would be worse than none.
		if !strings.Contains(a.Android, query) || !strings.Contains(a.IOS, query) {
			t.Errorf("%s: does not carry the same payment as the QR\n android %s\n ios %s", a.Key, a.Android, a.IOS)
		}
	}
	if generic != 1 {
		t.Errorf("want exactly one generic entry for an app not listed, got %d", generic)
	}
}

/*
A merchant account's QR needs mc; a personal one must not carry it.

	This is the bug the column exists for: a school whose bank gave it a
	merchant collection account got a code with no merchant category, and UPI
	apps refused it as an invalid QR while every other field was correct.
*/
func TestUPIIntentMerchantFields(t *testing.T) {
	personal := UPIIntent(Payment{VPA: "school@sbi", PayeeName: "S", AmountPaise: 100, Note: "Fee"})
	if strings.Contains(personal, "mc=") || strings.Contains(personal, "tr=") {
		t.Errorf("a personal address must carry neither mc nor tr: %s", personal)
	}

	merchant := UPIIntent(Payment{
		VPA: "school@sbi", PayeeName: "S", AmountPaise: 100, Note: "Fee",
		MerchantCode: "8211", Ref: "INV-12/3 A_4",
	})
	if !strings.Contains(merchant, "&mc=8211") {
		t.Errorf("merchant category missing: %s", merchant)
	}
	// Slash, space and underscore become hyphens: tr is matched against bank
	// records and a re-encoded slash is what stops it matching.
	if !strings.Contains(merchant, "&tr=INV-12-3-A-4") {
		t.Errorf("reference not reduced to tr's alphabet: %s", merchant)
	}
	// A reference without a category would be a merchant field on a personal
	// QR, which is the same mistake in the other direction.
	noCode := UPIIntent(Payment{VPA: "school@sbi", PayeeName: "S", AmountPaise: 100, Ref: "INV-1"})
	if strings.Contains(noCode, "tr=") {
		t.Errorf("tr sent without mc: %s", noCode)
	}
}
