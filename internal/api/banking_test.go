package api

import (
	"encoding/json"
	"testing"
	"time"
)

/* The four things in banking.go that are worth a test.

   Not the handlers — those need a database and the migration, and the
   integration suite is where that belongs. These are the pure functions where
   a subtle wrong answer is indistinguishable from a right one until a school's
   statement fails to tie: the money parser, the idempotency key, the masking,
   and the maker/checker rule. */

func TestPaiseFromDecimal(t *testing.T) {
	ok := []struct {
		in   string
		want int64
	}{
		{"100", 10000},
		{"100.00", 10000},
		{"1234.35", 123435},
		{"0.01", 1},
		{"0.1", 10},
		{"-45.50", -4550},
		// Indian grouping, which is where a naive parser that strips only
		// three-digit commas goes wrong.
		{"1,00,000.00", 10000000},
		{"12,34,567.89", 123456789},
		// What Excel and bank portals actually emit.
		{"(1,234.56)", -123456},
		{"1234.56 Dr", -123456},
		{"1234.56 Cr", 123456},
		{"₹1,234.56", 123456},
		{"Rs. 500", 50000},
		{"  250.5  ", 25050},
		// A trailing zero beyond two places is not a loss of information.
		{"10.500", 1050},
	}
	for _, c := range ok {
		got, err := paiseFromDecimal(c.in)
		if err != nil {
			t.Errorf("paiseFromDecimal(%q) returned error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("paiseFromDecimal(%q) = %d, want %d", c.in, got, c.want)
		}
	}

	bad := []string{"", "abc", "12.3.4", "1,2x3", "--5", "12.345", "."}
	for _, in := range bad {
		if v, err := paiseFromDecimal(in); err == nil {
			t.Errorf("paiseFromDecimal(%q) = %d, want an error", in, v)
		}
	}
}

// A third decimal place must be refused, not rounded. Silently rounding is how
// a mis-parsed column becomes a reconciliation that very nearly ties.
func TestPaiseFromDecimalRefusesSubPaise(t *testing.T) {
	if _, err := paiseFromDecimal("100.005"); err != errAmountTooPrecise {
		t.Fatalf("100.005 should be refused as too precise, got %v", err)
	}
}

/*
TestStatementLineHashOrdinal is the idempotency contract.

	Two genuinely distinct transactions with identical content must hash
	differently, or a school silently loses a receipt. The same content at the
	same ordinal must hash identically, or re-importing a statement duplicates
	the whole thing.
*/
func TestStatementLineHashOrdinal(t *testing.T) {
	d := time.Date(2026, 8, 17, 0, 0, 0, 0, time.UTC)

	a := statementLineHash(d, 250000, "NEFT FEE COLLECTION", "UTR123", 0)
	again := statementLineHash(d, 250000, "NEFT FEE COLLECTION", "UTR123", 0)
	if a != again {
		t.Fatal("the same line at the same ordinal must hash identically, or re-import duplicates")
	}

	second := statementLineHash(d, 250000, "NEFT FEE COLLECTION", "UTR123", 1)
	if a == second {
		t.Fatal("two identical transactions in one file must hash differently, or one is lost")
	}

	// Narration whitespace is normalised: a bank that pads its column must not
	// produce a different row on re-export.
	padded := statementLineHash(d, 250000, "NEFT   FEE  COLLECTION", "UTR123", 0)
	if a != padded {
		t.Fatal("narration whitespace must not change the hash")
	}

	// Amount is part of the identity.
	if a == statementLineHash(d, 250001, "NEFT FEE COLLECTION", "UTR123", 0) {
		t.Fatal("a different amount must hash differently")
	}
}

func TestMaskAccountNumber(t *testing.T) {
	cases := map[string]string{
		"":                 "",
		"1234":             "••••",
		"123456789":        "•••••6789",
		"50100234567890":   "••••••••••7890",
		"ABCD1234567890XY": "••••••••••••90XY",
	}
	for in, want := range cases {
		if got := maskAccountNumber(in); got != want {
			t.Errorf("maskAccountNumber(%q) = %q, want %q", in, got, want)
		}
	}
	// The invariant that matters more than any single case: nothing but the
	// last four characters ever survives.
	const acct = "50100234567890"
	got := maskAccountNumber(acct)
	if len([]rune(got)) != len([]rune(acct)) {
		t.Errorf("mask changed the length: %q", got)
	}
	if got[len(got)-4:] != acct[len(acct)-4:] {
		t.Errorf("mask lost the last four digits: %q", got)
	}
}

func TestValidIFSC(t *testing.T) {
	good := []string{"SBIN0001234", "HDFC0000123", "PUNB0AB1234", "ICIC0000001"}
	for _, s := range good {
		if !validIFSC(s) {
			t.Errorf("validIFSC(%q) = false, want true", s)
		}
	}
	bad := []string{
		"",
		"SBIN001234",   // ten characters
		"SBIN00012345", // twelve
		"SBI0N001234",  // fifth character is not the reserved zero
		"1BIN0001234",  // bank code must be letters
		"SBIN 0001234", // a space
	}
	for _, s := range bad {
		if validIFSC(s) {
			t.Errorf("validIFSC(%q) = true, want false", s)
		}
	}
	// Case is normalised, because a school will type it in lower case.
	if !validIFSC("sbin0001234") {
		t.Error("validIFSC must accept lower case and normalise it")
	}
}

/*
TestApprovalStanding is the maker/checker control.

	The one that matters is the third case: holding the approve permission does
	not make you a different person from the one who assembled the batch.
*/
func TestApprovalStanding(t *testing.T) {
	const maker = "11111111-1111-1111-1111-111111111111"
	const checker = "22222222-2222-2222-2222-222222222222"

	if ok, _ := approvalStanding("submitted", maker, checker, true); !ok {
		t.Error("a different person with the approve permission must be able to release")
	}
	if ok, why := approvalStanding("submitted", maker, maker, true); ok {
		t.Error("the maker must not be able to release their own batch even with the permission")
	} else if why == "" {
		t.Error("a refusal must carry a reason the screen can show")
	}
	if ok, _ := approvalStanding("submitted", maker, checker, false); ok {
		t.Error("releasing without the approve permission must be refused")
	}
	if ok, _ := approvalStanding("draft", maker, checker, true); ok {
		t.Error("a draft batch has not been submitted and must not be releasable")
	}
	if ok, _ := approvalStanding("approved", maker, checker, true); ok {
		t.Error("an already-approved batch must not be released twice")
	}
}

func TestNormaliseReference(t *testing.T) {
	// Two references that differ only in punctuation or a bank's own prefix
	// are the same reference; treating them as different leaves an exact match
	// sitting in the fuzzy list for a human to confirm by hand.
	if normaliseReference("UTR-1234/5678") != normaliseReference("utr 1234 5678") {
		t.Error("punctuation and case must not distinguish two references")
	}
	if normaliseReference("NEFT/ABC123") != normaliseReference("abc123") {
		t.Error("a bank's own scheme prefix must not distinguish two references")
	}
}

func TestParseStatementDate(t *testing.T) {
	want := time.Date(2026, 8, 17, 0, 0, 0, 0, time.UTC)
	for _, in := range []string{
		"2026-08-17", "17/08/2026", "17-08-2026", "17.08.2026",
		"17-Aug-2026", "17 Aug 2026", "2026/08/17", "20260817",
		"2026-08-17 14:32:00",
	} {
		got, ok := parseStatementDate(in)
		if !ok {
			t.Errorf("parseStatementDate(%q) failed", in)
			continue
		}
		if !got.Equal(want) {
			t.Errorf("parseStatementDate(%q) = %v, want %v", in, got, want)
		}
	}
	for _, in := range []string{"", "not a date", "32/13/2026"} {
		if _, ok := parseStatementDate(in); ok {
			t.Errorf("parseStatementDate(%q) should have failed", in)
		}
	}
}

// candidatesFor must never offer a book entry whose amount differs. A
// "candidate" that differs in amount is a different transaction, and offering
// it is how a clerk clicking through a hundred lines confirms one.
func TestCandidatesRequireExactAmount(t *testing.T) {
	ref := "UTR999"
	line := statementLine{
		ID: "l1", TxnDate: "2026-08-17", AmountPaise: 250000,
		Direction: "credit", Reference: &ref,
	}
	book := []bookEntry{
		{Kind: "payment", ID: "p1", EntryDate: "2026-08-17", AmountPaise: 250000, Reference: &ref},
		{Kind: "payment", ID: "p2", EntryDate: "2026-08-17", AmountPaise: 250001},
		{Kind: "payment", ID: "p3", EntryDate: "2026-07-01", AmountPaise: 250000},
	}
	got := candidatesFor(line, book, map[string]bool{})
	if len(got) != 1 {
		t.Fatalf("expected exactly one candidate, got %d", len(got))
	}
	if got[0].ID != "p1" || !got[0].Exact {
		t.Fatalf("expected p1 as an exact match, got %+v", got[0])
	}

	// A book entry already claimed by another line must not be offered again.
	claimed := map[string]bool{"payment:p1": true}
	if n := len(candidatesFor(line, book, claimed)); n != 0 {
		t.Fatalf("a claimed entry must not be offered, got %d candidates", n)
	}
}

// The file-export provider must never claim to have moved money.
func TestFileExportProviderCannotTransmit(t *testing.T) {
	p := fileExportProvider{}
	if p.CanTransmit() {
		t.Fatal("there is no bank API here; CanTransmit must be false")
	}
	if _, err := p.Transmit(t.Context(), PayoutBatchHeader{}, nil); err != ErrPayoutTransmissionUnavailable {
		t.Fatalf("Transmit must refuse with ErrPayoutTransmissionUnavailable, got %v", err)
	}
	if p.Why() == "" {
		t.Fatal("a provider that cannot transmit must say why")
	}
}

// The bank file's amount column is formed from integer paise, never a float.
func TestRupeeString(t *testing.T) {
	cases := map[int64]string{
		0: "0.00", 1: "0.01", 100: "1.00", 123435: "1234.35",
		10000000: "100000.00", -4550: "-45.50",
	}
	for in, want := range cases {
		if got := rupeeString(in); got != want {
			t.Errorf("rupeeString(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestPayoutFileShape(t *testing.T) {
	_, ct, body, err := fileExportProvider{}.Prepare(
		PayoutBatchHeader{BatchNo: "PO/2026-27/0001"},
		[]PayoutLine{{
			BeneficiaryName: "Ramesh, Kumar", AccountNumber: "50100234567890",
			IFSC: "sbin0001234", AmountPaise: 123435, Mode: "neft",
			Narration: "August salary",
		}})
	if err != nil {
		t.Fatal(err)
	}
	if ct != "text/csv; charset=utf-8" {
		t.Errorf("unexpected content type %q", ct)
	}
	got := string(body)
	want := "Beneficiary Name,Account Number,IFSC,Amount,Mode,Narration\n" +
		"Ramesh  Kumar,50100234567890,SBIN0001234,1234.35,NEFT,August salary\n"
	if got != want {
		t.Errorf("payout file mismatch:\ngot  %q\nwant %q", got, want)
	}
}

/*
TestStatementJSONShape guards a shadowing hazard.

	reconciliationStatement embeds reconciliationView, and both carry a field
	tagged difference_paise — a nullable one on the list view, a plain one on
	the statement. encoding/json resolves that to the shallower field, which is
	the one the statement sets. Asserted rather than assumed: if somebody later
	moves the field down into the embedded struct, the statement silently
	starts serialising null and the screen shows no difference on a period that
	does not tie.
*/
func TestStatementJSONShape(t *testing.T) {
	st := reconciliationStatement{
		reconciliationView: reconciliationView{ID: "r1", Status: "open"},
		DifferencePaise:    -12345,
		BankLines:          []statementLine{},
		UnmatchedBank:      []statementLine{},
		UnmatchedBook:      []bookEntry{},
		Imports:            []statementImport{},
	}
	raw, err := json.Marshal(st)
	if err != nil {
		t.Fatalf("the statement must marshal: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if got, ok := back["difference_paise"].(float64); !ok || int64(got) != -12345 {
		t.Fatalf("difference_paise = %v, want -12345", back["difference_paise"])
	}
	// The empty slices must serialise as [] and not null, or every screen has
	// to guard several map accesses before it can render a row.
	for _, k := range []string{"bank_lines", "unmatched_bank", "unmatched_book", "imports"} {
		if _, ok := back[k].([]any); !ok {
			t.Errorf("%s should be an array, got %#v", k, back[k])
		}
	}
}
