package fees

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// A due that is `overdue` days past its due date on the as-of date.
func dueBy(overdue int, balancePaise int64) (FineSubject, time.Time) {
	asOf := time.Date(2026, time.September, 30, 0, 0, 0, 0, time.UTC)
	due := asOf.AddDate(0, 0, -overdue)
	return FineSubject{
		InvoiceID:    uuid.New(),
		InvoiceNo:    "INV-1",
		DueOn:        &due,
		BalancePaise: balancePaise,
	}, asOf
}

/*
The grace boundary, which is the whole disagreement.

	"After N days past due" means nothing is owed while N days have merely
	elapsed. At exactly N the parent is still inside the window they were
	promised; at N+1 the first day's charge lands. Getting this wrong by one is
	not a rounding matter — it is the school charging for a day it said was
	free, on the one date a parent is most likely to check.
*/
func TestGraceBoundaryIsExclusiveAtExactlyNDays(t *testing.T) {
	rule := FineRule{Kind: "per_day", GraceDays: 10, AmountPaise: 5000, Compound: "none"}

	for _, tc := range []struct {
		overdue int
		want    int64
		why     string
	}{
		{9, 0, "a day inside the grace period"},
		{10, 0, "exactly the grace period: still nothing"},
		{11, 5000, "one day past grace: exactly one day charged"},
		{12, 10000, "two days past grace"},
	} {
		s, asOf := dueBy(tc.overdue, 5000000)
		got := AssessFine(s, rule, asOf)
		if got.AmountPaise != tc.want {
			t.Errorf("%d days overdue (%s): got %d paise, want %d — %s",
				tc.overdue, tc.why, got.AmountPaise, tc.want, got.Reason)
		}
	}
}

// The same boundary for a flat charge, which has no per-day scaling to hide an
// off-by-one behind.
func TestGraceBoundaryForFixedCharge(t *testing.T) {
	rule := FineRule{Kind: "fixed", GraceDays: 7, AmountPaise: 25000, Compound: "none"}

	s, asOf := dueBy(7, 5000000)
	if got := AssessFine(s, rule, asOf); got.AmountPaise != 0 {
		t.Errorf("at exactly 7 days: got %d, want 0 (%s)", got.AmountPaise, got.Reason)
	}
	s, asOf = dueBy(8, 5000000)
	if got := AssessFine(s, rule, asOf); got.AmountPaise != 25000 {
		t.Errorf("at 8 days: got %d, want 25000 (%s)", got.AmountPaise, got.Reason)
	}
}

// A fine nobody chases must stop growing, or the balance stops meaning
// anything and the school ends up writing off a number it invented.
func TestCapHoldsAndIsReported(t *testing.T) {
	capPaise := int64(20000)
	rule := FineRule{
		Kind: "per_day", GraceDays: 5, AmountPaise: 1000,
		CapPaise: &capPaise, Compound: "none",
	}

	// 40 days overdue, 5 grace, 35 chargeable days at Rs 10 = Rs 350 uncapped.
	s, asOf := dueBy(40, 5000000)
	got := AssessFine(s, rule, asOf)
	if got.AmountPaise != capPaise {
		t.Errorf("capped per_day: got %d, want the %d cap", got.AmountPaise, capPaise)
	}
	if !got.WasCapped {
		t.Error("was_capped must be set, or the screen cannot explain the number")
	}

	// Just under the cap it must not claim to have capped.
	s, asOf = dueBy(15, 5000000) // 10 chargeable days = 10000
	got = AssessFine(s, rule, asOf)
	if got.AmountPaise != 10000 || got.WasCapped {
		t.Errorf("under the cap: got %d capped=%v, want 10000 capped=false",
			got.AmountPaise, got.WasCapped)
	}
}

// Percent must be exact integer arithmetic. A float64 round-trip gives 2% of
// Rs 50,000 as 99,999 paise often enough to matter on a printed demand.
func TestPercentIsExactIntegerArithmetic(t *testing.T) {
	rule := FineRule{Kind: "percent", GraceDays: 5, Percent: 2, Compound: "none"}
	s, asOf := dueBy(40, 5000000)
	if got := AssessFine(s, rule, asOf); got.AmountPaise != 100000 {
		t.Errorf("2%% of 5000000 should be 100000, got %d", got.AmountPaise)
	}

	// Two decimal places, as numeric(5,2) permits.
	rule = FineRule{Kind: "percent", GraceDays: 0, Percent: 1.75, Compound: "none"}
	s, asOf = dueBy(30, 123456)
	// 123456 * 175 / 10000 = 2160.48 -> 2160
	if got := AssessFine(s, rule, asOf); got.AmountPaise != 2160 {
		t.Errorf("1.75%% of 123456 should be 2160, got %d", got.AmountPaise)
	}
}

/*
Compounding levies the charge once per elapsed period, and a percentage
compounds on the balance the earlier periods grew.

	Weekly over 21 chargeable days is three periods. At 1% on Rs 1,00,000:
	  period 1: 1% of 10000000 = 100000, running 10100000
	  period 2: 1% of 10100000 = 101000, running 10201000
	  period 3: 1% of 10201000 = 102010
	  total 303010
*/
func TestPercentCompoundsWeeklyOnTheGrowingBalance(t *testing.T) {
	rule := FineRule{Kind: "percent", GraceDays: 0, Percent: 1, Compound: "weekly"}
	s, asOf := dueBy(21, 10000000)
	got := AssessFine(s, rule, asOf)

	if got.Periods != 3 {
		t.Fatalf("21 days weekly should be 3 periods, got %d", got.Periods)
	}
	if got.AmountPaise != 303010 {
		t.Errorf("compounded total: got %d, want 303010", got.AmountPaise)
	}
	if len(got.Steps) != 3 {
		t.Fatalf("want a step per period for the working, got %d", len(got.Steps))
	}
	if got.Steps[0].AmountPaise != 100000 || got.Steps[2].AmountPaise != 102010 {
		t.Errorf("steps do not show the growth: %+v", got.Steps)
	}
}

// A partial period still counts: 8 days is into the second week, not one week.
func TestCompoundingPeriodsRoundUpAndNeverBelowOne(t *testing.T) {
	for _, tc := range []struct {
		compound string
		days     int
		want     int
	}{
		{"none", 90, 1},
		{"weekly", 1, 1},
		{"weekly", 7, 1},
		{"weekly", 8, 2},
		{"monthly", 30, 1},
		{"monthly", 31, 2},
		{"monthly", 90, 3},
	} {
		if got := periodsFor(tc.compound, tc.days); got != tc.want {
			t.Errorf("periodsFor(%s, %d) = %d, want %d",
				tc.compound, tc.days, got, tc.want)
		}
	}
}

// A flat charge with a monthly period is "Rs 200 a month late", which is how
// most schools actually express it.
func TestFixedChargeRepeatsPerCompoundingPeriod(t *testing.T) {
	rule := FineRule{Kind: "fixed", GraceDays: 0, AmountPaise: 20000, Compound: "monthly"}
	s, asOf := dueBy(75, 5000000) // 75 days -> 3 monthly periods
	got := AssessFine(s, rule, asOf)
	if got.Periods != 3 || got.AmountPaise != 60000 {
		t.Errorf("got %d over %d periods, want 60000 over 3", got.AmountPaise, got.Periods)
	}
}

/*
A staff ward or an RTE child is outside the rule entirely.

	Reported as exempt rather than as a zero, because the two mean different
	things to whoever is reading the preview: a zero invites someone to go
	looking for the arithmetic error that is not there.
*/
func TestExemptConcessionHoldersAreNotFined(t *testing.T) {
	rule := FineRule{
		Kind: "per_day", GraceDays: 0, AmountPaise: 5000, Compound: "none",
		ExemptKinds: []string{"staff_ward", "rte"},
	}

	s, asOf := dueBy(30, 5000000)
	s.ConcessionKinds = []string{"staff_ward"}
	got := AssessFine(s, rule, asOf)
	if got.AmountPaise != 0 || !got.Exempt {
		t.Errorf("staff ward: got %d exempt=%v, want 0 exempt=true", got.AmountPaise, got.Exempt)
	}
	if got.Reason == "" {
		t.Error("an exemption must say which concession caused it")
	}

	// A concession of another kind is not an exemption from this rule.
	s.ConcessionKinds = []string{"merit"}
	got = AssessFine(s, rule, asOf)
	if got.Exempt || got.AmountPaise != 150000 {
		t.Errorf("merit holder: got %d exempt=%v, want 150000 exempt=false",
			got.AmountPaise, got.Exempt)
	}
}

/*
A head rule charges a percentage of what that head cost under the version the
invoice was raised under — not of the invoice balance, and not of what the
structure says today.

	This is the reason fee structure versioning had to be built first. A school
	that raises the transport fee in September must not thereby increase the
	fine on an invoice raised in April.
*/
func TestHeadRuleUsesTheVersionedHeadAmountAsItsBasis(t *testing.T) {
	transport := uuid.New()
	tuition := uuid.New()

	rule := FineRule{
		Kind: "percent", GraceDays: 0, Percent: 10, Compound: "none",
		FeeHeadID: &transport,
	}

	s, asOf := dueBy(30, 5000000) // balance Rs 50,000
	s.HeadAmounts = map[uuid.UUID]int64{
		transport: 800000, // Rs 8,000 under the version it was raised under
		tuition:   4200000,
	}
	got := AssessFine(s, rule, asOf)

	if got.BasisPaise != 800000 {
		t.Errorf("basis: got %d, want the head's versioned 800000", got.BasisPaise)
	}
	if got.AmountPaise != 80000 {
		t.Errorf("10%% of the transport head: got %d, want 80000", got.AmountPaise)
	}
}

// A head rule against an invoice that never charged that head must not fire.
func TestHeadRuleDoesNotMatchAnInvoiceWithoutThatHead(t *testing.T) {
	transport := uuid.New()
	rule := FineRule{
		ID: uuid.New(), Name: "Transport late fee", Kind: "fixed",
		AmountPaise: 10000, FeeHeadID: &transport, Compound: "none",
	}

	s, _ := dueBy(30, 5000000)
	s.HeadAmounts = map[uuid.UUID]int64{uuid.New(): 4200000}

	if _, ok := BestRuleFor(s, []FineRule{rule}); ok {
		t.Error("a transport rule must not match an invoice with no transport line")
	}
}

/*
One rule per due, chosen by specificity.

	Two rules both firing on one invoice is how a parent is fined twice for a
	single late payment. The most deliberate rule wins: naming a head beats
	naming a structure, which beats naming a campus, which beats the catch-all.
*/
func TestMostSpecificRuleWinsAndOnlyOneApplies(t *testing.T) {
	campus := uuid.New()
	structure := uuid.New()
	head := uuid.New()

	catchAll := FineRule{ID: uuid.New(), Name: "Everything", Kind: "fixed", AmountPaise: 100}
	byCampus := FineRule{ID: uuid.New(), Name: "Campus", Kind: "fixed", AmountPaise: 200, CampusID: &campus}
	byStruct := FineRule{ID: uuid.New(), Name: "Structure", Kind: "fixed", AmountPaise: 300, StructureID: &structure}
	byHead := FineRule{ID: uuid.New(), Name: "Head", Kind: "fixed", AmountPaise: 400, FeeHeadID: &head}

	s, _ := dueBy(30, 5000000)
	s.CampusID = campus
	s.StructureID = &structure
	s.HeadAmounts = map[uuid.UUID]int64{head: 500000}

	// Deliberately shuffled: the answer must not depend on row order.
	got, ok := BestRuleFor(s, []FineRule{catchAll, byCampus, byHead, byStruct})
	if !ok || got.Name != "Head" {
		t.Fatalf("got %q, want the head-specific rule", got.Name)
	}

	// Remove the head rule and the structure rule should take over.
	got, _ = BestRuleFor(s, []FineRule{catchAll, byCampus, byStruct})
	if got.Name != "Structure" {
		t.Errorf("got %q, want the structure rule", got.Name)
	}

	// A campus rule for another campus must not match at all.
	other := uuid.New()
	elsewhere := FineRule{ID: uuid.New(), Name: "Other campus", Kind: "fixed", AmountPaise: 900, CampusID: &other}
	got, _ = BestRuleFor(s, []FineRule{catchAll, elsewhere})
	if got.Name != "Everything" {
		t.Errorf("got %q, want the catch-all — the other campus must not match", got.Name)
	}
}

/*
Re-running the engine tops the fine up rather than charging it again.

	A school that previews monthly must add the month's growth, not restate the
	whole accrued fine as a fresh charge. DeltaPaise is what reaches
	invoices.fine_paise; AmountPaise stays the total owed so the screen can show
	both.
*/
func TestReapplyingChargesOnlyTheIncrement(t *testing.T) {
	rule := FineRule{Kind: "per_day", GraceDays: 0, AmountPaise: 1000, Compound: "none"}

	s, asOf := dueBy(30, 5000000)
	first := AssessFine(s, rule, asOf)
	if first.AmountPaise != 30000 || first.DeltaPaise != 30000 {
		t.Fatalf("first run: got %d/%d, want 30000/30000", first.AmountPaise, first.DeltaPaise)
	}

	// Ten days later, with the first month already charged.
	s2, asOf2 := dueBy(40, 5000000)
	s2.AlreadyFinedPaise = 30000
	second := AssessFine(s2, rule, asOf2)
	if second.AmountPaise != 40000 {
		t.Errorf("total owed: got %d, want 40000", second.AmountPaise)
	}
	if second.DeltaPaise != 10000 {
		t.Errorf("increment: got %d, want 10000 — the rest is already charged", second.DeltaPaise)
	}

	// Running it twice on the same day must propose nothing further.
	s3, asOf3 := dueBy(40, 5000000)
	s3.AlreadyFinedPaise = 40000
	if third := AssessFine(s3, rule, asOf3); third.DeltaPaise != 0 {
		t.Errorf("same-day rerun: got %d, want 0", third.DeltaPaise)
	}
}

// Nothing is charged before the due date, on a settled invoice, or on one with
// no due date at all — and each says which of the three it was.
func TestNothingIsChargedWhenNothingIsOwed(t *testing.T) {
	rule := FineRule{Kind: "per_day", GraceDays: 0, AmountPaise: 1000, Compound: "none"}

	s, asOf := dueBy(-5, 5000000) // due in five days' time
	if got := AssessFine(s, rule, asOf); got.AmountPaise != 0 || got.Reason == "" {
		t.Errorf("not yet due: got %d (%s)", got.AmountPaise, got.Reason)
	}

	s, asOf = dueBy(30, 0) // fully paid
	if got := AssessFine(s, rule, asOf); got.AmountPaise != 0 || got.Reason == "" {
		t.Errorf("settled: got %d (%s)", got.AmountPaise, got.Reason)
	}

	s, asOf = dueBy(30, 5000000)
	s.DueOn = nil
	if got := AssessFine(s, rule, asOf); got.AmountPaise != 0 || got.Reason == "" {
		t.Errorf("no due date: got %d (%s)", got.AmountPaise, got.Reason)
	}
}

// The time of day an invoice was raised must not change how overdue it is.
func TestOverdueDaysIgnoreTheTimeOfDay(t *testing.T) {
	due := time.Date(2026, time.August, 1, 23, 55, 0, 0, time.UTC)
	asOf := time.Date(2026, time.August, 31, 0, 5, 0, 0, time.UTC)
	if got := daysBetween(due, asOf); got != 30 {
		t.Errorf("got %d days, want 30 — the clock time must not count", got)
	}
}

// Every due gets an answer, including those that attract nothing: a preview
// that silently omits a student is one the school cannot check.
func TestEvaluateReturnsAnAnswerForEveryDue(t *testing.T) {
	rule := FineRule{ID: uuid.New(), Name: "Standard", Kind: "per_day",
		GraceDays: 5, AmountPaise: 1000, Compound: "none"}

	late, asOf := dueBy(30, 5000000)
	early, _ := dueBy(2, 5000000)
	exempt, _ := dueBy(30, 5000000)
	exempt.ConcessionKinds = []string{"rte"}
	rule.ExemptKinds = []string{"rte"}

	out := EvaluateFines([]FineSubject{late, early, exempt}, []FineRule{rule}, asOf)
	if len(out) != 3 {
		t.Fatalf("got %d assessments for 3 dues", len(out))
	}
	for i, a := range out {
		if a.Reason == "" {
			t.Errorf("assessment %d has no reason; every answer must be explainable", i)
		}
	}
	if out[0].AmountPaise == 0 {
		t.Error("the overdue invoice should have been fined")
	}
	if out[1].AmountPaise != 0 || out[2].AmountPaise != 0 {
		t.Error("the in-grace and exempt dues should not have been fined")
	}
}

// A due no rule covers is reported as uncovered, not silently zeroed.
func TestDueWithNoMatchingRuleIsReportedAsUncovered(t *testing.T) {
	other := uuid.New()
	rule := FineRule{ID: uuid.New(), Name: "Elsewhere", Kind: "fixed",
		AmountPaise: 5000, CampusID: &other}

	s, asOf := dueBy(30, 5000000)
	s.CampusID = uuid.New()

	out := EvaluateFines([]FineSubject{s}, []FineRule{rule}, asOf)
	if len(out) != 1 || out[0].AmountPaise != 0 {
		t.Fatalf("got %+v", out)
	}
	if out[0].RuleID != nil || out[0].Reason != "no fine rule covers this invoice" {
		t.Errorf("want an explicit 'uncovered' answer, got %q", out[0].Reason)
	}
}

// The rendered shape is data, and an empty financial year must not leave a
// dangling separator on a printed document.
func TestRenderNumberFormats(t *testing.T) {
	for _, tc := range []struct {
		format, prefix, fy, suffix string
		seq                        int64
		padding                    int
		want                       string
	}{
		{"{prefix}{fy}/{seq}{suffix}", "RCPT/", "2026-27", "", 42, 5, "RCPT/2026-27/00042"},
		{"{prefix}{fy}/{seq}{suffix}", "INV/", "", "", 7, 5, "INV/00007"},
		{"{prefix}{seq}{suffix}", "SRV-", "", "/A", 1, 4, "SRV-0001/A"},
		{"{fy}-{seq}", "", "2027-28", "", 1, 6, "2027-28-000001"},
		{"", "RCPT/", "2026-27", "", 3, 5, "RCPT/2026-27/00003"},
	} {
		got := renderNumber(tc.format, tc.prefix, tc.fy, tc.seq, tc.padding, tc.suffix)
		if got != tc.want {
			t.Errorf("renderNumber(%q, %q, %q, %d) = %q, want %q",
				tc.format, tc.prefix, tc.fy, tc.seq, got, tc.want)
		}
	}
}
