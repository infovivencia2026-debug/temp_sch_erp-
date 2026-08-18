package tally

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func on(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// after is everything following the first occurrence of marker, so an
// assertion can look at what comes next without pinning the indentation.
func after(s, marker string) string {
	i := strings.Index(s, marker)
	if i < 0 {
		return ""
	}
	return s[i+len(marker):]
}

// A receipt: cash debited, fee income credited, balancing at zero.
func receipt(paise int64) Voucher {
	return Voucher{
		SourceID:    "11111111-1111-1111-1111-111111111111",
		Date:        on(2026, time.April, 15),
		VoucherType: "Receipt",
		Number:      "RCP/2026-27/0001",
		Narration:   "Term 1 fee",
		Entries: []Entry{
			{LedgerName: "Cash in Hand", AmountPaise: -paise},
			{LedgerName: "Tuition Fee Income", AmountPaise: paise},
		},
	}
}

/*
The assertion the whole feature rests on.

	Tally does not reject the offending voucher. It rejects the file — every
	voucher in it — and reports a message the accountant reads as "the export is
	broken". So an unbalanced voucher must never leave this package, and that is
	a test rather than a hope because the sign convention here is inverted
	relative to journal_lines and inverted again relative to how a reader thinks
	about debits.
*/
func TestEveryRenderedVoucherSumsToZero(t *testing.T) {
	// Amounts chosen for the decimals that break float arithmetic: 20.15 and
	// 0.01 have no exact binary representation.
	for _, paise := range []int64{1, 2015, 100, 99, 123456789, 33333} {
		v := receipt(paise)
		if got := v.Balance(); got != 0 {
			t.Fatalf("%d paise: balance %d, want 0", paise, got)
		}
		if err := v.Validate(); err != nil {
			t.Fatalf("%d paise: %v", paise, err)
		}
	}
}

// A three-legged voucher — fee income plus a late fine against the same
// receipt — is the shape fee_fine_charges produces, and it must balance too.
func TestFineChargeVoucherBalances(t *testing.T) {
	v := Voucher{
		Date:        on(2026, time.July, 1),
		VoucherType: "Receipt",
		Number:      "RCP/2026-27/0042",
		Entries: []Entry{
			{LedgerName: "Bank Account", AmountPaise: -525000},
			{LedgerName: "Tuition Fee Income", AmountPaise: 500000},
			{LedgerName: "Late Fee Income", AmountPaise: 25000},
		},
	}
	if v.Balance() != 0 {
		t.Fatalf("balance %d, want 0", v.Balance())
	}
	if err := v.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

func TestUnbalancedVoucherIsRefusedAndNamed(t *testing.T) {
	v := receipt(5000)
	v.Entries[1].AmountPaise = 4999 // one paise short: the classic

	err := v.Validate()
	if err == nil {
		t.Fatal("an unbalanced voucher validated")
	}
	if !errors.Is(err, ErrUnbalanced) {
		t.Fatalf("got %v, want ErrUnbalanced", err)
	}
	if !strings.Contains(err.Error(), "RCP/2026-27/0001") {
		t.Errorf("error does not name the voucher: %v", err)
	}
	// And the file must not be produced at all.
	if _, err := Render(Batch{Company: "Sri Sai School", Vouchers: []Voucher{v}}); err == nil {
		t.Fatal("Render produced a file containing an unbalanced voucher")
	}
}

/*
Paise to rupees, exactly.

	The float route is the bug: float64(2015)/100 is 20.149999999999998863,
	which prints as 20.15 with %.2f and as 20.149999999999999 with %v — and a
	sum of a hundred of those is out by a paise, which is a rejected file.
*/
func TestAmountIsExactAtEveryBoundary(t *testing.T) {
	for _, tc := range []struct {
		paise int64
		want  string
	}{
		{0, "0.00"},
		{1, "0.01"},
		{9, "0.09"},
		{10, "0.10"},
		{99, "0.99"},
		{100, "1.00"},
		{2015, "20.15"},
		{-2015, "-20.15"},
		{-1, "-0.01"},
		{123456789, "1234567.89"},
		{-525000, "-5250.00"},
	} {
		if got := Amount(tc.paise); got != tc.want {
			t.Errorf("Amount(%d) = %q, want %q", tc.paise, got, tc.want)
		}
	}
}

// The most negative int64 must not negate back to itself and print positive.
func TestAmountHandlesMinInt64(t *testing.T) {
	if got := Amount(-9223372036854775808); !strings.HasPrefix(got, "-") {
		t.Errorf("Amount(MinInt64) = %q, want a negative", got)
	}
}

/*
Tally's sign convention, which is the reverse of this codebase's.

	journal_lines holds debit_paise and credit_paise as separate positive
	columns. Tally wants one signed amount, negative for debit, with
	ISDEEMEDPOSITIVE saying Yes on that same line. Both halves flipped together
	is a file that imports every receipt as a payment.
*/
func TestDebitIsNegativeAndDeemedPositive(t *testing.T) {
	out, err := Render(Batch{Company: "Sri Sai School", Vouchers: []Voucher{receipt(500000)}})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	xml := string(out)

	/* The two halves must agree on the same line. Asserting on the exact
	   indentation would make this a test of the marshaller's whitespace, so the
	   check is that the debit ledger is followed by Yes before any other ledger
	   name appears. */
	debit := after(xml, "<LEDGERNAME>Cash in Hand</LEDGERNAME>")
	if !strings.HasPrefix(strings.TrimSpace(debit), "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>") {
		t.Errorf("the debit line is not marked deemed-positive:\n%s", xml)
	}
	credit := after(xml, "<LEDGERNAME>Tuition Fee Income</LEDGERNAME>")
	if !strings.HasPrefix(strings.TrimSpace(credit), "<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>") {
		t.Errorf("the credit line is marked deemed-positive:\n%s", xml)
	}
	if !strings.Contains(xml, "<AMOUNT>-5000.00</AMOUNT>") {
		t.Errorf("the debit amount is not negative:\n%s", xml)
	}
	if !strings.Contains(xml, "<AMOUNT>5000.00</AMOUNT>") {
		t.Errorf("the credit amount is not positive:\n%s", xml)
	}
}

// The envelope Tally actually looks for. Any of these missing and the import
// dialogue reports a file it does not recognise.
func TestEnvelopeHasTheShapeTallyImports(t *testing.T) {
	out, err := Render(Batch{Company: "Sri Sai School", Vouchers: []Voucher{receipt(100)}})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	xml := string(out)

	for _, want := range []string{
		"<ENVELOPE>",
		"<TALLYREQUEST>Import Data</TALLYREQUEST>",
		"<IMPORTDATA>",
		"<REPORTNAME>Vouchers</REPORTNAME>",
		"<SVCURRENTCOMPANY>Sri Sai School</SVCURRENTCOMPANY>",
		`<TALLYMESSAGE xmlns:UDF="TallyUDF">`,
		`<VOUCHER VCHTYPE="Receipt" ACTION="Create"`,
		"<VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>",
		"<ALLLEDGERENTRIES.LIST>",
	} {
		if !strings.Contains(xml, want) {
			t.Errorf("missing %q from:\n%s", want, xml)
		}
	}
}

// YYYYMMDD, not YYYY-MM-DD. Tally parses the second one and files the voucher
// under a different day without complaining.
func TestDateIsTallyFormat(t *testing.T) {
	if got := TallyDate(on(2026, time.April, 5)); got != "20260405" {
		t.Errorf("TallyDate = %q, want 20260405", got)
	}
	out, _ := Render(Batch{Company: "X", Vouchers: []Voucher{receipt(100)}})
	if !strings.Contains(string(out), "<DATE>20260415</DATE>") {
		t.Errorf("date not rendered as YYYYMMDD:\n%s", out)
	}
}

/*
A school name with an ampersand in it.

	"Sri Sai & Co. Educational Trust" is an ordinary Indian trust name, and a
	bare & anywhere in an XML file makes the whole document unparseable. This is
	the test that stops anybody replacing the marshaller with a string template.
*/
func TestSpecialCharactersAreEscaped(t *testing.T) {
	v := receipt(100)
	v.Narration = `Fee for "Rahul" & sister <2026>`
	out, err := Render(Batch{Company: "Sri Sai & Co. Educational Trust", Vouchers: []Voucher{v}})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	xml := string(out)
	if strings.Contains(xml, "Sai & Co") {
		t.Errorf("the company ampersand is unescaped:\n%s", xml)
	}
	if !strings.Contains(xml, "Sai &amp; Co") {
		t.Errorf("the company ampersand is not escaped:\n%s", xml)
	}
	if strings.Contains(xml, "<2026>") {
		t.Errorf("narration angle brackets are unescaped:\n%s", xml)
	}
}

// A voucher type nobody mapped must be caught here rather than by Tally.
func TestUnmappedVoucherTypeIsRefused(t *testing.T) {
	v := receipt(100)
	v.VoucherType = ""
	if err := v.Validate(); err == nil {
		t.Fatal("a voucher with no Tally voucher type validated")
	} else if !strings.Contains(err.Error(), "connector") {
		t.Errorf("the error does not point at the connector: %v", err)
	}
}

// An unmapped account reaching Render means the validation that should have
// blocked it was skipped. Refuse rather than emitting an empty LEDGERNAME,
// which Tally imports as a ledger literally called nothing.
func TestEmptyLedgerNameIsRefused(t *testing.T) {
	v := receipt(100)
	v.Entries[0].LedgerName = "  "
	if _, err := Render(Batch{Company: "X", Vouchers: []Voucher{v}}); err == nil {
		t.Fatal("a voucher with an unnamed ledger rendered")
	}
}

func TestRenderRefusesWithoutACompany(t *testing.T) {
	if _, err := Render(Batch{Vouchers: []Voucher{receipt(100)}}); err == nil {
		t.Fatal("rendered without a company name")
	}
}

func TestRenderRefusesAnEmptyPeriod(t *testing.T) {
	if _, err := Render(Batch{Company: "X"}); err == nil {
		t.Fatal("rendered an empty batch")
	}
}

// The unmapped list is what the accountant fixes, so the account blocking the
// most vouchers has to be at the top and the order has to be stable.
func TestUnmappedSortsByBlastRadiusThenCode(t *testing.T) {
	u := []Unmapped{
		{Code: "4200", Name: "Transport Fee", Vouchers: 3},
		{Code: "4100", Name: "Tuition Fee", Vouchers: 210},
		{Code: "4050", Name: "Late Fee", Vouchers: 3},
	}
	SortUnmapped(u)
	if u[0].Code != "4100" {
		t.Errorf("head is %s, want the 210-voucher account 4100", u[0].Code)
	}
	if u[1].Code != "4050" || u[2].Code != "4200" {
		t.Errorf("ties not broken by code: %s then %s", u[1].Code, u[2].Code)
	}
}

/*
The gateway must refuse, and must say why.

	This test exists to stop a later change quietly making GatewayProvider
	return a success it did not achieve. The product does not have a live push;
	the moment this test is deleted, it claims one.
*/
func TestGatewayProviderRefusesAndExplains(t *testing.T) {
	_, err := GatewayProvider{URL: "http://192.168.1.7:9000"}.Deliver(
		Batch{Company: "X", Vouchers: []Voucher{receipt(100)}})
	if !errors.Is(err, ErrGatewayUnavailable) {
		t.Fatalf("got %v, want ErrGatewayUnavailable", err)
	}
	if !strings.Contains(err.Error(), "LAN") && !strings.Contains(err.Error(), "network") {
		t.Errorf("the refusal does not explain what Tally needs: %v", err)
	}
	if (GatewayProvider{}).LivePush() {
		t.Error("the gateway reports a live push it cannot perform")
	}
}

func TestFileProviderDeliversTheRenderedFile(t *testing.T) {
	got, err := FileProvider{}.Deliver(Batch{Company: "X", Vouchers: []Voucher{receipt(100)}})
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if !strings.HasSuffix(got.Filename, ".xml") {
		t.Errorf("filename %q is not an xml file", got.Filename)
	}
	if !strings.Contains(string(got.Body), "<ENVELOPE>") {
		t.Error("the delivered body is not a Tally envelope")
	}
}

// An unknown stored key must fall back to the file, never to something that
// claims to push.
func TestProviderForFallsBackToTheFile(t *testing.T) {
	for _, key := range []string{"", "file", "sftp", "nonsense"} {
		if got := ProviderFor(key).Key(); got != "file" {
			t.Errorf("ProviderFor(%q) = %q, want file", key, got)
		}
	}
	if ProviderFor("gateway").Key() != "gateway" {
		t.Error("the gateway key did not resolve to the gateway provider")
	}
}
