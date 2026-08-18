package fees

import (
	"sort"
	"time"

	"github.com/google/uuid"
)

/*
The late fine engine.

	A fine is the school telling a parent they now owe more than the invoice
	said. That claim has to be previewable, explainable and repeatable, which
	drives every decision in this file:

	  - Evaluation is a pure function of (dues, rules, as-of date). Nothing
	    here reads a database or a clock. The screen previews by calling it
	    with today; an operator checks next month by calling it with next
	    month; a test checks the boundary by calling it with the boundary.
	  - Nothing here writes. Fines are applied by an explicit action in
	    internal/api/fee_engine.go, never by a timer. A fine that appeared
	    overnight is one nobody can be asked to justify.
	  - The working is returned alongside the number. "₹1,750" is not an
	    answer to a parent; "35 days past the 5-day grace at ₹50/day" is.

	The percent basis is the reason fee structure versioning had to come first.
	A percentage fine on a fee head is a percentage of what that head cost
	under the version the invoice was raised under — not under whatever the
	structure says today. A school that raises the transport fee in September
	must not thereby increase the fine on an August invoice.
*/

// Zero-uuid sentinel matching the COALESCE in the migration's unique indexes.
var zeroUUID uuid.UUID

// FineRule is one row of fee_fine_rules, as the engine sees it.
//
// The three targeting fields are pointers because all three are nullable and
// NULL means "any". That distinction is load-bearing: a rule with FeeHeadID nil
// applies to the whole invoice balance, while a rule naming a head applies to
// that head's versioned amount, and the two produce very different numbers.
type FineRule struct {
	ID          uuid.UUID
	Name        string
	CampusID    *uuid.UUID
	StructureID *uuid.UUID
	FeeHeadID   *uuid.UUID

	// fixed | per_day | percent
	Kind string
	// Days past the due date before anything is charged. The charge begins the
	// day *after* this many days have elapsed; see AssessFine.
	GraceDays   int
	AmountPaise int64
	// Whole percent with two decimals, as stored in numeric(5,2).
	Percent  float64
	CapPaise *int64
	// none | weekly | monthly
	Compound string
	// fee_concessions.kind values this rule does not apply to.
	ExemptKinds []string
	// Lower wins when two rules are equally specific.
	Priority int
}

// FineSubject is one due the engine is asked about: an invoice, what it is
// worth, and the facts about the student that decide whether a fine applies.
type FineSubject struct {
	InvoiceID   uuid.UUID
	InvoiceNo   string
	StudentID   uuid.UUID
	StudentName string
	CampusID    uuid.UUID

	// The fee structure and version the invoice was raised under. Nil for an
	// invoice raised before versioning existed, which makes it unmatchable by
	// any structure-specific rule — deliberately, because there is no honest
	// way to say which structure it belonged to.
	StructureID  *uuid.UUID
	VersionID    *uuid.UUID
	VersionLabel string

	DueOn        *time.Time
	BalancePaise int64

	// The amount each fee head cost under VersionID. The basis for a
	// head-specific percentage rule, and the reason versioning blocks this
	// feature.
	HeadAmounts map[uuid.UUID]int64

	// The concession kinds this student holds, e.g. staff_ward, rte.
	ConcessionKinds []string

	// Fines already applied to this invoice under this rule, so a preview run
	// a month after the last one proposes the increment rather than the total
	// over again.
	AlreadyFinedPaise int64
}

// FineStep is one compounding period's contribution, kept so the screen can
// show the arithmetic rather than assert a total.
type FineStep struct {
	Period      int    `json:"period"`
	BasisPaise  int64  `json:"basis_paise"`
	AmountPaise int64  `json:"amount_paise"`
	Note        string `json:"note"`
}

// FineAssessment is the engine's answer about one due.
//
// It is returned for every subject, including those that attract nothing, so
// the preview screen can show a school why a student it expected to see fined
// was not — which is the question that actually gets asked.
type FineAssessment struct {
	InvoiceID   uuid.UUID `json:"invoice_id"`
	InvoiceNo   string    `json:"invoice_no"`
	StudentID   uuid.UUID `json:"student_id"`
	StudentName string    `json:"student_name"`

	RuleID   *uuid.UUID `json:"rule_id,omitempty"`
	RuleName string     `json:"rule_name,omitempty"`

	FeeHeadID    *uuid.UUID `json:"fee_head_id,omitempty"`
	VersionID    *uuid.UUID `json:"version_id,omitempty"`
	VersionLabel string     `json:"version_label,omitempty"`

	DaysOverdue int   `json:"days_overdue"`
	BasisPaise  int64 `json:"basis_paise"`

	// The total fine owed under this rule as at the as-of date.
	AmountPaise int64 `json:"amount_paise"`
	// What applying now would add, given what has already been charged. This
	// is the number that reaches invoices.fine_paise.
	DeltaPaise int64 `json:"delta_paise"`

	Periods   int  `json:"periods"`
	WasCapped bool `json:"was_capped"`
	Exempt    bool `json:"exempt"`

	// Why this is the answer, in a sentence a school can repeat to a parent.
	Reason string     `json:"reason"`
	Steps  []FineStep `json:"steps,omitempty"`
}

// EvaluateFines assesses every due against the rules, as at asOf.
//
// Pure: no clock, no database, no ordering dependence. Call it with today to
// preview, with a future date to forecast, with a past date to reconstruct what
// a run would have produced.
//
// One rule per due, never a sum of several. Two rules both matching an invoice
// and both being charged is how a parent gets fined twice for one late payment;
// the most specific rule wins and the rest are ignored. The
// fee_fine_rules_one_active_per_target index means equally specific active
// rules cannot both exist in the first place.
func EvaluateFines(subjects []FineSubject, rules []FineRule, asOf time.Time) []FineAssessment {
	out := make([]FineAssessment, 0, len(subjects))
	for _, s := range subjects {
		rule, ok := BestRuleFor(s, rules)
		if !ok {
			out = append(out, FineAssessment{
				InvoiceID:   s.InvoiceID,
				InvoiceNo:   s.InvoiceNo,
				StudentID:   s.StudentID,
				StudentName: s.StudentName,
				VersionID:   s.VersionID, VersionLabel: s.VersionLabel,
				Reason: "no fine rule covers this invoice",
			})
			continue
		}
		out = append(out, AssessFine(s, rule, asOf))
	}
	return out
}

// BestRuleFor picks the single rule that governs a due.
//
// Specificity beats configuration order: a rule naming a fee head is more
// deliberate than one naming a structure, which is more deliberate than one
// naming a campus, which is more deliberate than the catch-all. Ties — which
// the unique index makes impossible among active rules, but which a caller
// passing inactive rules could still produce — fall to Priority, then to name,
// so the answer never depends on the order rows came back in.
func BestRuleFor(s FineSubject, rules []FineRule) (FineRule, bool) {
	type scored struct {
		rule  FineRule
		score int
	}
	var matches []scored

	for _, r := range rules {
		if r.CampusID != nil && *r.CampusID != s.CampusID {
			continue
		}
		if r.StructureID != nil {
			if s.StructureID == nil || *r.StructureID != *s.StructureID {
				continue
			}
		}
		if r.FeeHeadID != nil {
			// A head rule is meaningless against an invoice that does not
			// charge that head, and applying it would fine a percentage of
			// nothing or a flat amount for a service not billed.
			if _, ok := s.HeadAmounts[*r.FeeHeadID]; !ok {
				continue
			}
		}
		score := 0
		if r.FeeHeadID != nil {
			score += 4
		}
		if r.StructureID != nil {
			score += 2
		}
		if r.CampusID != nil {
			score++
		}
		matches = append(matches, scored{r, score})
	}
	if len(matches) == 0 {
		return FineRule{}, false
	}

	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].score != matches[j].score {
			return matches[i].score > matches[j].score
		}
		if matches[i].rule.Priority != matches[j].rule.Priority {
			return matches[i].rule.Priority < matches[j].rule.Priority
		}
		return matches[i].rule.Name < matches[j].rule.Name
	})
	return matches[0].rule, true
}

// AssessFine works out what one rule charges one due, as at asOf.
//
// Exported separately from EvaluateFines because this is the arithmetic worth
// testing directly: the grace boundary, the cap, and the compounding are the
// three things a school will dispute.
func AssessFine(s FineSubject, rule FineRule, asOf time.Time) FineAssessment {
	a := FineAssessment{
		InvoiceID:    s.InvoiceID,
		InvoiceNo:    s.InvoiceNo,
		StudentID:    s.StudentID,
		StudentName:  s.StudentName,
		RuleID:       ruleIDPtr(rule),
		RuleName:     rule.Name,
		FeeHeadID:    rule.FeeHeadID,
		VersionID:    s.VersionID,
		VersionLabel: s.VersionLabel,
		Periods:      1,
	}

	// Exemption first: a staff ward or an RTE child is outside the rule
	// entirely, and saying so is more useful than reporting a zero that looks
	// like an arithmetic result.
	if kind, ok := exemptBy(s.ConcessionKinds, rule.ExemptKinds); ok {
		a.Exempt = true
		a.Reason = "exempt: holds a " + humanKind(kind) + " concession"
		return a
	}

	if s.DueOn == nil {
		a.Reason = "no due date on the invoice, so nothing is overdue"
		return a
	}
	if s.BalancePaise <= 0 {
		a.Reason = "nothing outstanding"
		return a
	}

	a.DaysOverdue = daysBetween(*s.DueOn, asOf)
	if a.DaysOverdue <= 0 {
		a.Reason = "not yet due"
		return a
	}

	/* The grace boundary.

	   "after N days past due" means the fine starts once more than N days have
	   passed, so at exactly N days there is nothing to pay. Written as < rather
	   than <= this would charge a day early, which is the off-by-one a parent
	   notices and the school cannot defend. */
	if a.DaysOverdue <= rule.GraceDays {
		a.Reason = "within the " + plural(rule.GraceDays, "day") + " grace period"
		return a
	}
	chargeable := a.DaysOverdue - rule.GraceDays

	// The basis: a head rule bites on that head's versioned amount, everything
	// else on what is actually still owed.
	if rule.FeeHeadID != nil {
		a.BasisPaise = s.HeadAmounts[*rule.FeeHeadID]
	} else {
		a.BasisPaise = s.BalancePaise
	}
	if a.BasisPaise <= 0 {
		a.Reason = "the head this rule covers is not charged on this invoice"
		return a
	}

	a.Periods = periodsFor(rule.Compound, chargeable)

	switch rule.Kind {
	case "fixed":
		for i := 1; i <= a.Periods; i++ {
			a.Steps = append(a.Steps, FineStep{
				Period: i, BasisPaise: a.BasisPaise, AmountPaise: rule.AmountPaise,
				Note: "flat charge",
			})
			a.AmountPaise += rule.AmountPaise
		}
		a.Reason = plural(chargeable, "day") + " past grace, flat charge"
		if a.Periods > 1 {
			a.Reason += " levied " + plural(a.Periods, "time") + " (" + rule.Compound + ")"
		}

	case "per_day":
		// Already scales with elapsed time; the DB forbids compounding it too.
		a.AmountPaise = rule.AmountPaise * int64(chargeable)
		a.Periods = 1
		a.Steps = append(a.Steps, FineStep{
			Period: 1, BasisPaise: a.BasisPaise, AmountPaise: a.AmountPaise,
			Note: plural(chargeable, "day") + " past grace",
		})
		a.Reason = plural(chargeable, "day") + " past grace at a daily rate"

	case "percent":
		/* Compounding percent charges each period on the balance the previous
		   periods have already grown, which is what "compounding" means and
		   what a school that ticks the box is agreeing to. With one period it
		   collapses to a plain percentage of the basis. */
		running := a.BasisPaise
		for i := 1; i <= a.Periods; i++ {
			step := percentOf(running, rule.Percent)
			a.Steps = append(a.Steps, FineStep{
				Period: i, BasisPaise: running, AmountPaise: step,
				Note: "percentage of the outstanding basis",
			})
			a.AmountPaise += step
			running += step
		}
		a.Reason = plural(chargeable, "day") + " past grace, charged as a percentage"
		if a.Periods > 1 {
			a.Reason += ", compounded " + rule.Compound + " over " + plural(a.Periods, "period")
		}

	default:
		a.Reason = "rule kind " + rule.Kind + " is not one this engine knows"
		return a
	}

	if rule.CapPaise != nil && a.AmountPaise > *rule.CapPaise {
		a.AmountPaise = *rule.CapPaise
		a.WasCapped = true
		a.Reason += ", capped"
	}
	if a.AmountPaise < 0 {
		a.AmountPaise = 0
	}

	// Top up rather than charge again. A rule evaluated monthly should add the
	// month's growth, not restate the whole accrued fine as a fresh charge.
	a.DeltaPaise = a.AmountPaise - s.AlreadyFinedPaise
	if a.DeltaPaise < 0 {
		a.DeltaPaise = 0
	}
	return a
}

// periodsFor is how many times a compounding rule levies its charge.
//
// Rounded up, and never below one: a rule that has bitten at all has bitten
// once. A monthly period is 30 days rather than a calendar month on purpose —
// the fine is expressed relative to a due date, not to a month boundary, and
// "a month late" measured in calendar months would charge a February invoice
// differently from a March one for the same lateness.
func periodsFor(compound string, chargeableDays int) int {
	var length int
	switch compound {
	case "weekly":
		length = 7
	case "monthly":
		length = 30
	default:
		return 1
	}
	periods := (chargeableDays + length - 1) / length
	if periods < 1 {
		return 1
	}
	return periods
}

// percentOf computes a percentage of a paise amount in integer arithmetic.
//
// Percent is numeric(5,2) in the schema, so it is exactly representable in
// basis points. Going through basis points rather than float64 multiplication
// keeps the result exact and rounds half up once, at the end — a float here
// gives 2% of ₹5,000 as 9999 paise often enough to matter.
func percentOf(basisPaise int64, percent float64) int64 {
	bp := int64(percent*100 + 0.5) // 2.50% -> 250 basis points
	if bp <= 0 || basisPaise <= 0 {
		return 0
	}
	return (basisPaise*bp + 5000) / 10000
}

// daysBetween counts whole calendar days from due to asOf.
//
// Both ends are flattened to their date first. Subtracting the raw instants
// makes the answer depend on the time of day the invoice happened to be
// raised, so the same invoice could be 29 or 30 days overdue depending on
// whether the run happened before or after lunch.
func daysBetween(due, asOf time.Time) int {
	d := time.Date(due.Year(), due.Month(), due.Day(), 0, 0, 0, 0, time.UTC)
	a := time.Date(asOf.Year(), asOf.Month(), asOf.Day(), 0, 0, 0, 0, time.UTC)
	return int(a.Sub(d).Hours() / 24)
}

func exemptBy(held, exempt []string) (string, bool) {
	for _, h := range held {
		for _, e := range exempt {
			if h == e {
				return h, true
			}
		}
	}
	return "", false
}

func ruleIDPtr(r FineRule) *uuid.UUID {
	if r.ID == zeroUUID {
		return nil
	}
	id := r.ID
	return &id
}

func humanKind(k string) string {
	switch k {
	case "staff_ward":
		return "staff ward"
	case "rte":
		return "RTE"
	default:
		return k
	}
}

func plural(n int, noun string) string {
	s := itoa(n) + " " + noun
	if n != 1 {
		s += "s"
	}
	return s
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
